// "Relay", the steel face: a chrome head that sways while idle, leans in to listen, turns
// while thinking and moves its jaw with the agent's voice. Purely decorative — every state
// is also written in words on the page — so it is aria-hidden and optional: if WebGL, the
// CDN or the model fails, the page keeps a still placeholder and the call works the same.
//
// Model: "Infinite, 3D Head Scan" by Lee Perry-Smith, CC BY 3.0 (public/models/LICENSE-*).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_URL = '/models/lee-perry-smith.glb';

// Head motion per state. The face eases toward each state's targets every frame, so every
// change is continuous and can be interrupted mid-way.
const STATE_PARAMS = {
  idle: { sway: 0.14, swaySpeed: 0.35, nod: 0.03, tilt: 0, turn: 0, jawGain: 0 },
  connecting: { sway: 0.1, swaySpeed: 0.9, nod: 0.04, tilt: 0, turn: 0, jawGain: 0 },
  listening: { sway: 0.05, swaySpeed: 0.4, nod: 0.02, tilt: 0.08, turn: 0, jawGain: 0 },
  thinking: { sway: 0.06, swaySpeed: 0.5, nod: 0.02, tilt: -0.04, turn: 0.32, jawGain: 0 },
  speaking: { sway: 0.07, swaySpeed: 0.6, nod: 0.05, tilt: 0.02, turn: 0, jawGain: 1 },
};

// Where the jaw is, as fractions of the normalised head (found by inspecting the scan):
// vertices below the mouth line, on the front of the face and within the jaw's width move
// down with the voice; the weight fades out smoothly so the skin stretches rather than tears.
const HEAD_HEIGHT = 2.3;
const JAW = { mouthY: -0.36, chinY: -0.78, fadeY: 0.12, frontZ: 0.05, halfWidth: 0.42, drop: 0.12, lipLift: 0.3 };
// A clean, straight cut across the neck (in the head's normalised space), like a bust.
const NECK_CLIP_Y = -HEAD_HEIGHT / 2 + 0.12;

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
  light(cssColor('--mascot-env-accent'), 2.2, 1.8, [-8, -0.5, 3]);
  light(cssColor('--mascot-env-primary'), 2.4, 2.2, [8, 1, 0]);
  light(cssColor('--mascot-env-warm'), 2.2, 1.1, [5, 5, 6]);
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

async function loadHeadGeometry() {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  let source = null;
  gltf.scene.traverse((node) => {
    if (!source && node.isMesh) source = node;
  });
  if (!source) throw new Error('head model has no mesh');
  const geometry = source.geometry.clone();
  geometry.applyMatrix4(source.matrixWorld);
  const box = cropToHead(geometry);
  const center = box.getCenter(new THREE.Vector3());
  const height = box.max.y - box.min.y;
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.scale(HEAD_HEIGHT / height, HEAD_HEIGHT / height, HEAD_HEIGHT / height);
  geometry.deleteAttribute('uv');
  return geometry;
}

// How each vertex follows the voice, computed once from the head's resting shape: positive
// weights drop with the jaw (below the mouth line), small negative weights lift the upper
// lip, so the mouth reads as opening rather than the chin just stretching.
function jawWeights(base, count) {
  const half = HEAD_HEIGHT / 2;
  const mouthY = JAW.mouthY * half;
  const chinY = JAW.chinY * half;
  const lipBand = JAW.fadeY * half * 0.5;
  const weights = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = base[i * 3];
    const y = base[i * 3 + 1];
    const z = base[i * 3 + 2];
    const front = smoothstep(JAW.frontZ * half - 0.2, JAW.frontZ * half + 0.2, z);
    const inside = 1 - smoothstep(JAW.halfWidth * half * 0.7, JAW.halfWidth * half, Math.abs(x));
    const below = smoothstep(mouthY, mouthY - JAW.fadeY * half, y);
    const aboveNeck = 1 - smoothstep(chinY + JAW.fadeY * half, chinY - JAW.fadeY * half, y);
    const upperLip = smoothstep(mouthY - 0.01, mouthY + 0.02, y) * (1 - smoothstep(mouthY + lipBand * 0.4, mouthY + lipBand, y));
    weights[i] = (below * aboveNeck - upperLip * JAW.lipLift) * front * inside;
  }
  return weights;
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
  renderer.localClippingEnabled = true;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = buildEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30);
  camera.position.set(0, 0.05, 4.7);

  const positions = geometry.attributes.position;
  const base = Float32Array.from(positions.array);
  const weights = jawWeights(base, positions.count);
  const material = new THREE.MeshPhysicalMaterial({
    color: cssColor('--mascot-tint'),
    metalness: 1,
    roughness: 0.14,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.35,
    clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 1, 0), -NECK_CLIP_Y)],
  });
  const head = new THREE.Mesh(geometry, material);
  scene.add(head);

  const current = { ...STATE_PARAMS.idle };
  let target = STATE_PARAMS.idle;
  let level = 0;
  let levelTarget = 0;
  let appliedJaw = 0;
  let time = 0;
  let last = performance.now();
  let frame = 0;

  // Moves the jaw only when its opening actually changed, then refreshes the lighting normals.
  function setJaw(open) {
    if (Math.abs(open - appliedJaw) < 0.002) return;
    appliedJaw = open;
    const drop = open * JAW.drop * HEAD_HEIGHT;
    for (let i = 0; i < positions.count; i++) {
      const w = weights[i];
      positions.setY(i, base[i * 3 + 1] - drop * w);
      positions.setZ(i, base[i * 3 + 2] - drop * w * 0.35);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
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
    setJaw(level * current.jawGain);
    pose(time);
    renderer.render(scene, camera);
  }

  // Under reduced motion the face is drawn once per state: present, but still.
  function renderStill() {
    Object.assign(current, target);
    setJaw(0);
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
