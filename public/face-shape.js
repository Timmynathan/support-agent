// Relay's mask shape, shared by the browser (public/face.js) and the build step that prepares
// it (scripts/bake-face.mjs). No dependencies, so both can import it as it is.
//
// Built from "Infinite, 3D Head Scan" by Lee Perry-Smith, CC BY 3.0 (public/models/LICENSE-*).

export const HEAD_HEIGHT = 2.3;

// Relay is a mask, not a portrait: only the front of the face inside an oval is kept (no ears,
// back of head or neck), and the features are softened so the face reads as no one in
// particular. The oval is cut with per-vertex alpha, so its edge follows a smooth curve.
export const MASK = {
  halfWidth: 0.6,
  halfHeight: 1.0,
  centerY: -0.05,
  backZ: 0.1, // everything behind this plane (ears, back of head) is dropped
  chinCutY: -0.84,
  // Iteration counts are for the subdivided mesh (half-length edges need ~4x the passes).
  blankIterations: 200, // how far the "blank" face is smoothed (plain Laplacian: it flattens)
  featureStrength: 0.5, // how much of the scan's own features come back (1 = all)
  smoothIterations: 24,
  jawNarrowing: 0.07,
};

// Splits every triangle into four at its edge midpoints (shared edges share one new vertex),
// giving the smoothing a finer surface to work on and the eye and mouth cut-outs finer edges.
// Deterministic: the same input always gives the same vertices in the same order, which is
// what lets the browser rebuild the full mesh from the small base mesh in the baked file.
export function subdivide(positions, index) {
  const count = positions.length / 3;
  const out = Array.from(positions);
  const midpoints = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? a * count + b : b * count + a;
    let m = midpoints.get(key);
    if (m === undefined) {
      m = out.length / 3;
      for (let k = 0; k < 3; k++) out.push((out[a * 3 + k] + out[b * 3 + k]) / 2);
      midpoints.set(key, m);
    }
    return m;
  };
  const triangles = [];
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    triangles.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { positions: Float32Array.from(out), index: Uint32Array.from(triangles) };
}

// ── The baked file (public/models/relay-mask.bin) ─────────────────────────────────────
// Holds only what is expensive to compute: the base mesh (before subdivision) and how far the
// neutralising moved each vertex of the subdivided mesh. Everything else is rebuilt on load.
//
//   0  "RMSK"            4 bytes
//   4  version           uint32
//   8  base vertices     uint32
//  12  base indices      uint32
//  16  full vertices     uint32
//  20  offset scale      float32
//  24  base positions    float32 × 3 × base vertices
//      base indices      uint16  × base indices (+2 bytes padding if odd)
//      offsets           int16   × 3 × full vertices (neutral = scan + offset × scale)
const MAGIC = 0x4b534d52; // "RMSK" little-endian
const VERSION = 1;
const HEADER_BYTES = 24;

export function encodeMask({ basePositions, baseIndex, scan, neutral }) {
  if (baseIndex.some((i) => i > 0xffff)) throw new Error('base mesh too large for 16-bit indices');
  let maxOffset = 0;
  for (let i = 0; i < scan.length; i++) maxOffset = Math.max(maxOffset, Math.abs(neutral[i] - scan[i]));
  const scale = Math.fround(maxOffset / 32767);
  const offsets = Int16Array.from(scan, (s, i) => Math.round((neutral[i] - s) / scale));
  const indexBytes = baseIndex.length * 2 + ((baseIndex.length % 2) * 2);
  const buffer = new ArrayBuffer(HEADER_BYTES + basePositions.length * 4 + indexBytes + offsets.length * 2);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, basePositions.length / 3, true);
  view.setUint32(12, baseIndex.length, true);
  view.setUint32(16, scan.length / 3, true);
  view.setFloat32(20, scale, true);
  let at = HEADER_BYTES;
  new Float32Array(buffer, at, basePositions.length).set(basePositions);
  at += basePositions.length * 4;
  new Uint16Array(buffer, at, baseIndex.length).set(baseIndex);
  at += indexBytes;
  new Int16Array(buffer, at, offsets.length).set(offsets);
  return new Uint8Array(buffer);
}

// Returns the mesh exactly as the build produced it: the full index, the subdivided scan
// positions (where the face's features were measured) and the neutralised surface.
export function decodeMask(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION) throw new Error('not a relay-mask v1 file');
  const baseVertices = view.getUint32(8, true);
  const baseIndices = view.getUint32(12, true);
  const fullVertices = view.getUint32(16, true);
  const scale = view.getFloat32(20, true);
  let at = HEADER_BYTES;
  const basePositions = new Float32Array(buffer.slice(at, at + baseVertices * 12));
  at += baseVertices * 12;
  const baseIndex = new Uint16Array(buffer.slice(at, at + baseIndices * 2));
  at += baseIndices * 2 + ((baseIndices % 2) * 2);
  const offsets = new Int16Array(buffer.slice(at, at + fullVertices * 6));
  const { positions: scan, index } = subdivide(basePositions, baseIndex);
  if (scan.length !== fullVertices * 3) throw new Error('relay-mask file does not match its base mesh');
  const neutral = Float32Array.from(scan, (s, i) => s + offsets[i] * scale);
  return { index, scan, neutral };
}
