// Prepares Relay's mask once, ahead of time, so the browser doesn't. Reshaping the head scan
// (crop, merge, subdivide and hundreds of smoothing passes) took seconds on every page load;
// the result is now written to public/models/relay-mask.bin and the browser only reads it.
//
//   npm run bake-face      re-run whenever MASK (public/face-shape.js) or the scan changes
//
// Source: "Infinite, 3D Head Scan" by Lee Perry-Smith, CC BY 3.0 (assets/models/LICENSE-*).
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { decodeMask, encodeMask, HEAD_HEIGHT, MASK, subdivide } from '../public/face-shape.js';

const SCAN = 'assets/models/lee-perry-smith.glb';
const OUT = 'public/models/relay-mask.bin';

// The scan is a bust; only the head is kept. Triangles below this line (as a fraction of the
// scan's height from the top of the head) are dropped, leaving a clean head like a mask.
const NECK_CUT = 0.7;

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function cropToHead(geometry) {
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const cutY = max.y - NECK_CUT * (max.y - min.y);
  const position = geometry.attributes.position;
  const index = geometry.index.array;
  const kept = [];
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i];
    const b = index[i + 1];
    const c = index[i + 2];
    if (Math.min(position.getY(a), position.getY(b), position.getY(c)) > cutY) kept.push(a, b, c);
  }
  geometry.setIndex(kept);
  // Bounds of what remains, not of the whole bust.
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const i of kept) box.expandByPoint(point.fromBufferAttribute(position, i));
  return box;
}

// Keeps only the triangles around the mask (the face's front, with a margin beyond the oval
// the alpha cut makes), so the back of the head isn't subdivided and smoothed for nothing.
function keepMaskRegion(geometry) {
  const position = geometry.attributes.position;
  const index = geometry.index.array;
  const inRegion = (i) =>
    position.getZ(i) > MASK.backZ - 0.2 &&
    position.getY(i) > MASK.chinCutY - 0.15 &&
    Math.hypot(position.getX(i) / MASK.halfWidth, (position.getY(i) - MASK.centerY) / MASK.halfHeight) < 1.15;
  const remap = new Map();
  const positions = [];
  const kept = [];
  const vertex = (i) => {
    if (!remap.has(i)) {
      remap.set(i, positions.length / 3);
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
    }
    return remap.get(i);
  };
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    if (inRegion(a) && inRegion(b) && inRegion(c)) kept.push(vertex(a), vertex(b), vertex(c));
  }
  return { positions: Float32Array.from(positions), index: Uint32Array.from(kept) };
}

// Taubin smoothing (a shrink step then an inflate step per iteration), so the surface
// softens without collapsing. Vertices on an open edge stay put: smoothing would otherwise
// pull the mesh's border inward, past the clean oval the alpha cut draws.
function smoothSurface(p, index, iterations, lambda, mu) {
  const count = p.length / 3;
  const neighbours = Array.from({ length: count }, () => new Set());
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    neighbours[a].add(b).add(c);
    neighbours[b].add(a).add(c);
    neighbours[c].add(a).add(b);
  }
  const lists = neighbours.map((set) => [...set]);
  const edgeUse = new Map();
  for (let t = 0; t < index.length; t += 3) {
    for (const [a, b] of [
      [index[t], index[t + 1]],
      [index[t + 1], index[t + 2]],
      [index[t + 2], index[t]],
    ]) {
      const key = a < b ? a * count + b : b * count + a;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const pinned = new Uint8Array(count);
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    pinned[Math.floor(key / count)] = 1;
    pinned[key % count] = 1;
  }
  const next = new Float32Array(p.length);
  const pass = (factor) => {
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i];
      for (let k = 0; k < 3; k++) {
        if (!list.length || pinned[i]) {
          next[i * 3 + k] = p[i * 3 + k];
          continue;
        }
        let sum = 0;
        for (const j of list) sum += p[j * 3 + k];
        next[i * 3 + k] = p[i * 3 + k] + factor * (sum / list.length - p[i * 3 + k]);
      }
    }
    p.set(next);
  };
  for (let i = 0; i < iterations; i++) {
    pass(lambda);
    pass(mu);
  }
}

// Turns a specific (male) scan into an idealised, genderless face. Features are toned down
// rather than blurred: a heavily smoothed "blank" of the face is computed, and the real
// features are blended back at partial strength, so the nose, brow and jaw become less
// pronounced while the face keeps its structure — the way sculpted masks read as no one in
// particular. A light final smoothing and a slightly narrower jaw finish it.
function neutralise(scan, index) {
  const p = Float32Array.from(scan);
  smoothSurface(p, index, MASK.blankIterations, 0.6, 0);
  for (let i = 0; i < p.length; i++) p[i] += MASK.featureStrength * (scan[i] - p[i]);
  smoothSurface(p, index, MASK.smoothIterations, 0.5, -0.53);
  for (let i = 0; i < p.length; i += 3) p[i] *= 1 - MASK.jawNarrowing * smoothstep(-0.3, -0.85, p[i + 1]);
  return p;
}

async function loadScan() {
  const data = readFileSync(SCAN);
  const gltf = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  let source = null;
  gltf.scene.traverse((node) => {
    if (!source && node.isMesh) source = node;
  });
  if (!source) throw new Error('head model has no mesh');
  let geometry = source.geometry.clone();
  geometry.applyMatrix4(source.matrixWorld);
  const box = cropToHead(geometry);
  const center = box.getCenter(new THREE.Vector3());
  const height = box.max.y - box.min.y;
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(HEAD_HEIGHT / height, HEAD_HEIGHT / height, HEAD_HEIGHT / height);
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('normal');
  geometry = mergeVertices(geometry, 1e-4);
  return keepMaskRegion(geometry);
}

const started = performance.now();
const base = await loadScan();
const { positions: scan, index } = subdivide(base.positions, base.index);
const neutral = neutralise(scan, index);
const file = encodeMask({ basePositions: base.positions, baseIndex: base.index, scan, neutral });
writeFileSync(OUT, file);

// Read it back the way the browser will, and check it is the mesh just built.
const decoded = decodeMask(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
let maxError = 0;
for (let i = 0; i < neutral.length; i++) maxError = Math.max(maxError, Math.abs(decoded.neutral[i] - neutral[i]));
if (!same(decoded.index, index) || !same(decoded.scan, scan)) throw new Error('decoded mesh differs from the one built');
console.log(
  `${OUT}: ${(file.length / 1024).toFixed(0)} KB, ${scan.length / 3} vertices, ${index.length / 3} triangles, ` +
    `largest rounding of the surface ${maxError.toExponential(1)} (of a 2.3-unit head), built in ${Math.round(performance.now() - started)} ms`,
);
