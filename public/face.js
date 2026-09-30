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

const HEAD_HEIGHT = 2.3;
// A clean, straight cut across the neck (in the head's normalised space), like a bust.
const NECK_CLIP_Y = -HEAD_HEIGHT / 2 + 0.12;

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
  eyeHalfWidth: 0.125,
  eyeHalfHeight: 0.05,
  eyeFrontZ: 0.4,
};

// The scan's lips are one closed surface, so the mouth opens by splitting at the seam: the
// lower lip and jaw drop, the upper lip lifts a little, and the band that stretches open
// between them is shaded dark so it reads as the inside of the mouth.
const MOUTH = { jawDrop: 0.13, lipLift: 0.012, jawBack: 0.3, seamShadeWidth: 0.006, pocketDepth: 0.07 };
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

export async function loadHeadGeometry() {
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

// How each vertex takes part in the face's movement, computed once from the resting shape.
function buildRig(base, count) {
  const F = FEATURES;
  const jaw = new Float32Array(count); // follows the jaw down (0..1)
  const lip = new Float32Array(count); // follows the upper lip up (0..1)
  const shade = new Float32Array(count); // darkens as the mouth opens (0..1)
  const shaded = [];
  const eyeVertices = []; // [index, u, v]: position relative to an eye, in eye half-sizes
  for (let i = 0; i < count; i++) {
    const x = base[i * 3];
    const y = base[i * 3 + 1];
    const z = base[i * 3 + 2];
    const front = smoothstep(F.faceFrontZ - 0.15, F.faceFrontZ + 0.1, z);
    const seam = F.lipSeamY + F.lipSeamCurve * (x / F.mouthHalfWidth) ** 2;
    const lipFront = F.lipFrontZ - F.lipFrontCurve * x * x;
    const dy = y - seam;
    const insideJaw = 1 - smoothstep(F.jawHalfWidth * 0.6, F.jawHalfWidth, Math.abs(x));
    const insideMouth = 1 - smoothstep(F.mouthHalfWidth * 0.8, F.mouthHalfWidth * 1.1, Math.abs(x));
    // Across the mouth the split is a hard step at the seam, so the lips actually part; beyond
    // the corners it softens, so the cheeks stretch instead of tearing.
    const split = insideMouth * (dy < 0 ? 1 : 0) + (1 - insideMouth) * smoothstep(0.01, -0.03, dy);
    jaw[i] = split * smoothstep(F.chinY - 0.1, F.chinY + 0.05, y) * insideJaw * front;
    // The front of the upper lip, just above the seam, lifts a little.
    const onLipFront = z > lipFront - 0.015 ? 1 : 0;
    lip[i] = smoothstep(0, 0.005, dy) * (1 - smoothstep(0.025, 0.045, dy)) * onLipFront * insideMouth;
    // Dark when open: the seam itself, and every surface set back behind the lip fronts (the
    // pocket above the seam and the lower lip's inner face) that the gap reveals.
    const seamShade = Math.exp(-((dy / MOUTH.seamShadeWidth) ** 2));
    const pocket = dy > -MOUTH.pocketDepth * 0.5 && dy < MOUTH.pocketDepth && z < lipFront - 0.015 ? 1 : 0;
    shade[i] = Math.max(seamShade, pocket) * insideMouth * front;
    if (shade[i] > 0.001) shaded.push(i);
    if (z > F.eyeFrontZ) {
      for (const eye of F.eyes) {
        const u = (x - eye.x) / F.eyeHalfWidth;
        const v = (y - eye.y) / F.eyeHalfHeight;
        if (u * u + v * v < 4) eyeVertices.push([i, u, v]);
      }
    }
  }
  return { jaw, lip, shade, shaded, eyeVertices };
}

// 0 inside the eye opening (cut away), 1 outside. `open` scales the opening's height, so a
// blink closes it from top and bottom; the corners are pinched into an almond shape.
function eyeAlpha(u, v, open) {
  if (open < 0.02) return 1;
  const almond = v * (1 + 0.8 * u * u);
  const r = u * u + (almond / open) ** 2;
  return smoothstep(0.75, 1, r);
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
  const rig = buildRig(base, positions.count);
  // Per-vertex colour: RGB darkens the open mouth; alpha cuts the eye openings (alphaTest).
  const colors = new THREE.BufferAttribute(new Float32Array(positions.count * 4).fill(1), 4);
  geometry.setAttribute('color', colors);
  const mouthColor = cssColor('--mascot-mouth');
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    alphaTest: 0.5,
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
  let appliedMouth = -1;
  let appliedEyes = -1;
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
    for (let i = 0; i < positions.count; i++) {
      const jaw = rig.jaw[i];
      positions.setY(i, base[i * 3 + 1] - drop * jaw + lift * rig.lip[i]);
      positions.setZ(i, base[i * 3 + 2] - drop * jaw * MOUTH.jawBack);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    for (const i of rig.shaded) {
      const t = rig.shade[i] * open;
      colors.setXYZ(i, 1 + (mouthColor.r - 1) * t, 1 + (mouthColor.g - 1) * t, 1 + (mouthColor.b - 1) * t);
    }
    colors.needsUpdate = true;
  }

  // Opens the eyes (1 open … 0 shut), only when it actually changed.
  function setEyes(open) {
    if (Math.abs(open - appliedEyes) < 0.01) return;
    appliedEyes = open;
    for (const [i, u, v] of rig.eyeVertices) colors.setW(i, eyeAlpha(u, v, open));
    colors.needsUpdate = true;
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
    setMouth(Math.min(1, level * VOICE_TO_MOUTH) * current.jawGain);
    setEyes(eyeOpenness(time));
    pose(time);
    renderer.render(scene, camera);
  }

  // Under reduced motion the face is drawn once per state: present, but still.
  function renderStill() {
    Object.assign(current, target);
    setMouth(0);
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
