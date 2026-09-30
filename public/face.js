// "Relay", the steel mask: a genderless chrome mask with hollow, blinking eyes, whose mouth
// opens with the agent's voice; it sways while idle, leans in to listen and turns while
// thinking. Purely decorative — every state is also written in words on the page — so it is
// aria-hidden and optional: if WebGL, the CDN or the model fails, the page keeps a still
// placeholder and the call works the same.
//
// Built from "Infinite, 3D Head Scan" by Lee Perry-Smith, CC BY 3.0
// (public/models/LICENSE-*): cropped to a mask, with its features softened (see neutralise).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const MODEL_URL = '/models/lee-perry-smith.glb';

// Head motion per state. The face eases toward each state's targets every frame, so every
// change is continuous and can be interrupted mid-way. `lipPress` closes the scan's slightly
// parted lips: pressed shut while idle (no call), relaxed once a call starts.
const STATE_PARAMS = {
  idle: { sway: 0.14, swaySpeed: 0.35, nod: 0.03, tilt: 0, turn: 0, jawGain: 0, lipPress: 1 },
  connecting: { sway: 0.1, swaySpeed: 0.9, nod: 0.04, tilt: 0, turn: 0, jawGain: 0, lipPress: 0 },
  listening: { sway: 0.05, swaySpeed: 0.4, nod: 0.02, tilt: 0.08, turn: 0, jawGain: 0, lipPress: 0 },
  thinking: { sway: 0.06, swaySpeed: 0.5, nod: 0.02, tilt: -0.04, turn: 0.32, jawGain: 0, lipPress: 0 },
  speaking: { sway: 0.07, swaySpeed: 0.6, nod: 0.05, tilt: 0.02, turn: 0, jawGain: 1, lipPress: 0 },
};

const HEAD_HEIGHT = 2.3;

// Relay is a mask, not a portrait: only the front of the face inside an oval is kept (no ears,
// back of head or neck), and the features are softened so the face reads as no one in
// particular. The oval is cut with per-vertex alpha, so its edge follows a smooth curve.
const MASK = {
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

// Facial features on the normalised head (origin at its centre, height HEAD_HEIGHT). The eyes
// were measured from a front render with a coordinate grid; the lips from the vertices
// themselves: the lips meet in a crease at y = -0.311 on the centre line, dipping toward the
// corners, with a shallow pocket behind the upper lip.
const FEATURES = {
  lipSeamY: -0.3115, // where the lips meet, at the centre
  lipSeamCurve: -0.02, // the seam dips this much at the mouth's corners
  lipFrontZ: 0.822, // the front of the lips at the centre…
  lipFrontCurve: 2.2, // …curving back toward the corners (z = lipFrontZ - curve * x²)
  mouthHalfWidth: 0.2,
  chinY: -0.78,
  jawHalfWidth: 0.42,
  faceFrontZ: 0.45, // only the front of the face moves; cheeks and neck sides stay put
  eyes: [
    { x: -0.265, y: 0.185 },
    { x: 0.255, y: 0.185 },
  ],
  eyeHalfWidth: 0.14,
  eyeHalfHeight: 0.06,
  eyeFrontZ: 0.1, // cut through the whole depth of the eye: no lids or eyeballs left inside
};

// The scan's lips are one closed surface, so the mouth opens by splitting at the seam: the
// lower lip and jaw drop, the upper lip lifts a little, and an almond opening is cut between
// them that grows with the voice — hollow, like the eyes, as on a steel mask.
// `press` is a negative opening: the jaw rises and the upper lip drops until the lips meet.
const MOUTH = { jawDrop: 0.13, lipLift: 0.012, jawBack: 0.3, holeHalfHeight: 0.03, press: 0.35 };
// The scan's eyes are closed; the lids are cut open as almond-shaped holes (like the hollow
// eyes of a mask), which also lets them blink.
const BLINK = { everyMin: 3.5, everyMax: 6.5, duration: 0.16 };

// Vapi's voice level for ordinary speech sits around 0.2-0.6, so it is scaled up for the mouth
// to open clearly; loud peaks simply clamp at fully open.
const VOICE_TO_MOUTH = 1.8;

const STATE_EASING = 0.05;
const LEVEL_EASING = 0.35;
const MAX_PIXEL_RATIO = 2;

function cssColor(name) {
  return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// A sky-to-floor dome: light sky, a bright horizon band, blue-grey floor. Every chrome
// object reflects this split, and it is what makes the curvature read as polished metal.
function buildDome() {
  const geometry = new THREE.SphereGeometry(20, 48, 32);
  const sky = cssColor('--mascot-env-sky');
  const horizon = cssColor('--mascot-env-horizon');
  const floor = cssColor('--mascot-env-floor');
  const colors = [];
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const h = position.getY(i) / 20; // -1 (floor) … 1 (zenith)
    const color =
      h > -0.05
        ? horizon.clone().lerp(sky, Math.min(1, (h + 0.05) / 0.55))
        : h > -0.12
          ? horizon.clone()
          : floor.clone().lerp(horizon, Math.max(0, 1 + (h + 0.12) / 0.7));
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
}

function buildEnvironment(renderer) {
  const studio = new THREE.Scene();
  studio.add(buildDome());
  // Round light sources placed off-axis read as soft, flowing highlights on the metal.
  const light = (color, intensity, radius, position) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 24, 16),
      new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(intensity) }),
    );
    mesh.position.set(...position);
    studio.add(mesh);
  };
  light(cssColor('--mascot-env-key'), 3, 1.6, [-3, 7, 4]);
  light(cssColor('--mascot-env-accent'), 1.2, 1.8, [-8, -0.5, 3]);
  light(cssColor('--mascot-env-primary'), 1.3, 2.2, [8, 1, 0]);
  light(cssColor('--mascot-env-warm'), 1.4, 1.1, [5, 5, 6]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(studio, 0.04).texture;
  pmrem.dispose();
  return texture;
}

// The scan is a bust; only the head is kept. Triangles below this line (as a fraction of the
// scan's height from the top of the head) are dropped, leaving a clean head like a mask.
const NECK_CUT = 0.7;

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

// Taubin smoothing (a shrink step then an inflate step per iteration), so the surface
// softens without collapsing. Run on the merged mesh so texture seams don't split open.
function smoothSurface(geometry, iterations, lambda, mu) {
  const position = geometry.attributes.position;
  const p = position.array;
  const index = geometry.index.array;
  const neighbours = Array.from({ length: position.count }, () => new Set());
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    neighbours[a].add(b).add(c);
    neighbours[b].add(a).add(c);
    neighbours[c].add(a).add(b);
  }
  const lists = neighbours.map((set) => [...set]);
  // Vertices on an open edge (an edge used by only one triangle) stay put: smoothing would
  // otherwise pull the mesh's border inward, past the clean oval the alpha cut draws.
  const edgeUse = new Map();
  for (let t = 0; t < index.length; t += 3) {
    for (const [a, b] of [
      [index[t], index[t + 1]],
      [index[t + 1], index[t + 2]],
      [index[t + 2], index[t]],
    ]) {
      const key = a < b ? a * position.count + b : b * position.count + a;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const pinned = new Uint8Array(position.count);
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    pinned[Math.floor(key / position.count)] = 1;
    pinned[key % position.count] = 1;
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
  position.needsUpdate = true;
}

export async function loadHeadGeometry() {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
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
  geometry = keepMaskRegion(geometry);
  geometry = subdivide(geometry);
  // The feature measurements (lips, eyes) were taken on the scan as-is, so the rig is built
  // from these positions; neutralising moves the vertices but keeps their order.
  geometry.userData.scanPositions = Float32Array.from(geometry.attributes.position.array);
  neutralise(geometry);
  geometry.computeVertexNormals();
  return geometry;
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
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setIndex(kept);
  return result;
}

// Splits every triangle into four at its edge midpoints (shared edges share one new vertex),
// giving the smoothing a finer surface to work on and the eye and mouth cut-outs finer edges.
function subdivide(geometry) {
  const position = geometry.attributes.position;
  const index = geometry.index.array;
  const positions = Array.from(position.array);
  const midpoints = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? a * position.count + b : b * position.count + a;
    let m = midpoints.get(key);
    if (m === undefined) {
      m = positions.length / 3;
      for (let k = 0; k < 3; k++) positions.push((positions[a * 3 + k] + positions[b * 3 + k]) / 2);
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
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setIndex(triangles);
  return result;
}

// Turns a specific (male) scan into an idealised, genderless face. Features are toned down
// rather than blurred: a heavily smoothed "blank" of the face is computed, and the real
// features are blended back at partial strength, so the nose, brow and jaw become less
// pronounced while the face keeps its structure — the way sculpted masks read as no one in
// particular. A light final smoothing and a slightly narrower jaw finish it.
function neutralise(geometry) {
  const position = geometry.attributes.position;
  const original = Float32Array.from(position.array);
  smoothSurface(geometry, MASK.blankIterations, 0.6, 0);
  const p = position.array;
  for (let i = 0; i < p.length; i++) p[i] += MASK.featureStrength * (original[i] - p[i]);
  smoothSurface(geometry, MASK.smoothIterations, 0.5, -0.53);
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    position.setX(i, position.getX(i) * (1 - MASK.jawNarrowing * smoothstep(-0.3, -0.85, y)));
  }
}

// How each vertex takes part in the face's movement, computed once from the resting shape.
// Features (lips, eyes) use the scan's own positions, where they were measured; the mask
// outline uses the neutralised surface, so its edge is a clean oval on the face you see.
function buildRig(scan, neutral, count) {
  const F = FEATURES;
  const jaw = new Float32Array(count); // follows the jaw down (0..1)
  const lip = new Float32Array(count); // follows the upper lip up (0..1)
  const movers = []; // vertices the mouth moves, so each frame touches only these
  const mouthVertices = []; // [index, u, v]: position relative to the mouth opening
  const outline = new Float32Array(count); // 1 inside the mask, 0 cut away
  for (let i = 0; i < count; i++) {
    const nx = neutral[i * 3];
    const ny = neutral[i * 3 + 1];
    const nz = neutral[i * 3 + 2];
    const oval = Math.hypot(nx / MASK.halfWidth, (ny - MASK.centerY) / MASK.halfHeight);
    outline[i] =
      (1 - smoothstep(0.94, 1, oval)) *
      smoothstep(MASK.backZ - 0.08, MASK.backZ + 0.08, nz) *
      smoothstep(MASK.chinCutY - 0.04, MASK.chinCutY + 0.04, ny);
    const x = scan[i * 3];
    const y = scan[i * 3 + 1];
    const z = scan[i * 3 + 2];
    const front = smoothstep(F.faceFrontZ - 0.15, F.faceFrontZ + 0.1, z);
    const seam = F.lipSeamY + F.lipSeamCurve * (x / F.mouthHalfWidth) ** 2;
    const lipFront = F.lipFrontZ - F.lipFrontCurve * x * x;
    const dy = y - seam;
    const insideJaw = 1 - smoothstep(F.jawHalfWidth * 0.6, F.jawHalfWidth, Math.abs(x));
    const insideMouth = 1 - smoothstep(F.mouthHalfWidth * 0.8, F.mouthHalfWidth * 1.1, Math.abs(x));
    // Across the mouth the split happens over a thin band at the seam, so the lips part
    // cleanly; beyond the corners it softens, so the cheeks stretch instead of tearing.
    const split = insideMouth * smoothstep(0.004, -0.008, dy) + (1 - insideMouth) * smoothstep(0.01, -0.03, dy);
    jaw[i] = split * smoothstep(F.chinY - 0.1, F.chinY + 0.05, y) * insideJaw * front;
    // The front of the upper lip, just above the seam, lifts a little.
    const onLipFront = z > lipFront - 0.015 ? 1 : 0;
    lip[i] = smoothstep(0, 0.005, dy) * (1 - smoothstep(0.025, 0.045, dy)) * onLipFront * insideMouth;
    const mu = x / F.mouthHalfWidth;
    const mv = dy / MOUTH.holeHalfHeight;
    if (front > 0.5 && mu * mu + (mv / 3) ** 2 < 1.7) mouthVertices.push([i, mu, mv]);
  }
  for (let i = 0; i < count; i++) if (jaw[i] > 0.001 || lip[i] > 0.001) movers.push(i);
  return { jaw, lip, movers, mouthVertices, outline };
}

// 0 inside the mouth's almond opening (cut away), 1 outside. `open` scales its height, so
// the opening grows from the lip line. (The eyes use the same shape, cut in the shader.)
function openingAlpha(u, v, open) {
  if (open < 0.02) return 1;
  const almond = v * (1 + 0.8 * u * u);
  const r = u * u + (almond / open) ** 2;
  return smoothstep(0.75, 1, r);
}

// Adds the eye openings to the material's shader. The mesh's own (rest-pose) position is
// passed to the fragment shader, and any fragment inside either almond eye outline is
// discarded. Returns the uniform that opens and closes them (for blinking).
function cutEyes(material) {
  const F = FEATURES;
  const eyeOpen = { value: 1 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEyeOpen = eyeOpen;
    shader.uniforms.uEyeLeft = { value: new THREE.Vector2(F.eyes[0].x, F.eyes[0].y) };
    shader.uniforms.uEyeRight = { value: new THREE.Vector2(F.eyes[1].x, F.eyes[1].y) };
    shader.uniforms.uEyeHalf = { value: new THREE.Vector2(F.eyeHalfWidth, F.eyeHalfHeight) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMaskPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMaskPosition = transformed;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'varying vec3 vMaskPosition;',
          'uniform float uEyeOpen;',
          'uniform vec2 uEyeLeft;',
          'uniform vec2 uEyeRight;',
          'uniform vec2 uEyeHalf;',
          'bool insideEye(vec2 centre) {',
          '  vec2 d = (vMaskPosition.xy - centre) / uEyeHalf;',
          '  float almond = d.y * (1.0 + 0.8 * d.x * d.x) / max(uEyeOpen, 0.001);',
          '  return d.x * d.x + almond * almond < 0.87;',
          '}',
        ].join('\n'),
      )
      .replace(
        'void main() {',
        [
          'void main() {',
          `  if (uEyeOpen > 0.02 && vMaskPosition.z > ${F.eyeFrontZ.toFixed(3)} && (insideEye(uEyeLeft) || insideEye(uEyeRight))) discard;`,
        ].join('\n'),
      );
  };
  return eyeOpen;
}

export async function createFace(container, { reduceMotion }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  const geometry = await loadHeadGeometry();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = buildEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30);
  camera.position.set(0, 0.05, 4.7);

  const positions = geometry.attributes.position;
  const base = Float32Array.from(positions.array);
  const rig = buildRig(geometry.userData.scanPositions, base, positions.count);
  // Per-vertex alpha cuts the mask outline and the mouth (alphaTest); the eyes are cut per
  // pixel in the shader (cutEyes), so nothing at all shows inside them.
  const colors = new THREE.BufferAttribute(new Float32Array(positions.count * 4).fill(1), 4);
  for (let i = 0; i < positions.count; i++) colors.setW(i, rig.outline[i]);
  geometry.setAttribute('color', colors);
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    alphaTest: 0.5,
    color: cssColor('--mascot-tint'),
    metalness: 1,
    roughness: 0.2,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.35,
  });
  const eyeOpen = cutEyes(material);
  const head = new THREE.Mesh(geometry, material);
  scene.add(head);

  const current = { ...STATE_PARAMS.idle };
  let target = STATE_PARAMS.idle;
  let level = 0;
  let levelTarget = 0;
  let appliedMouth = -1;
  let time = 0;
  let last = performance.now();
  let frame = 0;
  let nextBlink = BLINK.everyMin;
  let blinkStart = -1;

  // Opens the mouth (0 closed … 1 wide), only when it actually changed.
  function setMouth(open) {
    if (Math.abs(open - appliedMouth) < 0.002) return;
    appliedMouth = open;
    const drop = open * MOUTH.jawDrop;
    const lift = open * MOUTH.lipLift;
    for (const i of rig.movers) {
      const jaw = rig.jaw[i];
      positions.setY(i, base[i * 3 + 1] - drop * jaw + lift * rig.lip[i]);
      positions.setZ(i, base[i * 3 + 2] - drop * jaw * MOUTH.jawBack);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    for (const [i, u, v] of rig.mouthVertices) colors.setW(i, rig.outline[i] * openingAlpha(u, v, open));
    colors.needsUpdate = true;
  }

  // Opens the eyes (1 open … 0 shut): one shader value, so a blink costs nothing.
  function setEyes(open) {
    eyeOpen.value = open;
  }

  // Blinks every few seconds, at a slightly irregular rhythm so it doesn't feel mechanical.
  function eyeOpenness(t) {
    if (blinkStart < 0 && t >= nextBlink) blinkStart = t;
    if (blinkStart < 0) return 1;
    const p = (t - blinkStart) / BLINK.duration;
    if (p >= 1) {
      blinkStart = -1;
      nextBlink = t + BLINK.everyMin + Math.random() * (BLINK.everyMax - BLINK.everyMin);
      return 1;
    }
    return 1 - Math.sin(Math.PI * p);
  }

  function pose(t) {
    head.rotation.y = Math.sin(t * current.swaySpeed) * current.sway + current.turn * Math.sin(t * 0.35);
    head.rotation.x = current.tilt + Math.sin(t * current.swaySpeed * 1.3) * current.nod + level * current.jawGain * 0.05;
    head.rotation.z = Math.sin(t * current.swaySpeed * 0.7) * current.sway * 0.15;
    head.position.y = Math.sin(t * 0.8) * 0.03;
  }

  function render(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const key of Object.keys(current)) current[key] += (target[key] - current[key]) * STATE_EASING;
    level += (levelTarget - level) * LEVEL_EASING;
    time += dt;
    setMouth(Math.min(1, level * VOICE_TO_MOUTH) * current.jawGain - current.lipPress * MOUTH.press);
    setEyes(eyeOpenness(time));
    pose(time);
    renderer.render(scene, camera);
  }

  // Under reduced motion the face is drawn once per state: present, but still.
  function renderStill() {
    Object.assign(current, target);
    setMouth(-current.lipPress * MOUTH.press);
    setEyes(1);
    head.rotation.set(target.tilt, target.turn * 0.5, 0);
    head.position.y = 0;
    renderer.render(scene, camera);
  }

  function loop(now) {
    frame = requestAnimationFrame(loop);
    if (document.hidden) return;
    render(now);
  }

  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (reduceMotion.matches) renderStill();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  function start() {
    cancelAnimationFrame(frame);
    if (reduceMotion.matches) {
      renderStill();
      return;
    }
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }
  reduceMotion.addEventListener('change', start);
  start();

  return {
    setState(name) {
      target = STATE_PARAMS[name] ?? STATE_PARAMS.idle;
      if (reduceMotion.matches) renderStill();
    },
    setLevel(value) {
      levelTarget = Math.max(0, Math.min(1, value));
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reduceMotion.removeEventListener('change', start);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
