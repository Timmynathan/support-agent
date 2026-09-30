// "Relay", the voice orb: a chrome sphere that breathes, ripples with the caller's microphone,
// swirls while thinking and pulses with the agent's voice. Purely decorative — every state is
// also written in words on the page — so it is aria-hidden and optional: if WebGL or this
// module fails, the page falls back to a still orb and the call works exactly the same.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Motion per state. Values are shape parameters, not durations: the orb eases toward each
// state's targets every frame, so changes are continuous and interruptible.
// Low frequencies and a real amplitude make a liquid-metal blob rather than a perfect sphere,
// so reflections bend and drift across it as it moves.
const STATE_PARAMS = {
  idle: { amplitude: 0.11, frequency: 1.25, speed: 0.3, spin: 0.08, levelGain: 0 },
  connecting: { amplitude: 0.14, frequency: 1.6, speed: 1.0, spin: 0.35, levelGain: 0 },
  listening: { amplitude: 0.1, frequency: 1.4, speed: 0.55, spin: 0.1, levelGain: 0.3 },
  thinking: { amplitude: 0.16, frequency: 1.9, speed: 0.85, spin: 0.45, levelGain: 0 },
  speaking: { amplitude: 0.11, frequency: 1.5, speed: 0.75, spin: 0.16, levelGain: 0.42 },
};

const DETAIL = 32; // icosphere subdivision: smooth silhouette at ~11k vertices
const STATE_EASING = 0.05; // per-frame approach toward a new state's shape
const LEVEL_EASING = 0.3; // per-frame approach toward the live audio level
const BOB_HEIGHT = 0.035; // gentle float, dropped under reduced motion
const MAX_PIXEL_RATIO = 2;

function cssColor(name) {
  return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
}

// A small studio of soft light panels for the chrome to reflect: that reflection is what
// makes it read as 3D metal. Panel colours come from tokens.css.
// A sky-to-floor dome: light sky, a bright horizon band, dark floor. Every chrome object
// reflects this split, and it is what makes the curvature read as polished metal.
function buildDome() {
  const geometry = new THREE.SphereGeometry(20, 48, 32);
  const sky = cssColor('--orb-env-sky');
  const horizon = cssColor('--orb-env-horizon');
  const floor = cssColor('--orb-env-floor');
  const colors = [];
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const h = position.getY(i) / 20; // -1 (floor) … 1 (zenith)
    // Horizon sits just below the equator, so the reflected sky fills most of the orb.
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
  // Round light sources placed off-axis read as soft, flowing highlights; flat panels on the
  // axes would read as hard blocks.
  const light = (color, intensity, radius, position) => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 24, 16),
      new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(intensity) }),
    );
    mesh.position.set(...position);
    studio.add(mesh);
  };
  light(cssColor('--orb-env-key'), 3, 1.6, [-3, 7, 4]);
  light(cssColor('--orb-env-accent'), 2.2, 1.8, [-8, -0.5, 3]);
  light(cssColor('--orb-env-primary'), 2.4, 2.2, [8, 1, 0]);
  light(cssColor('--orb-env-warm'), 2.2, 1.1, [5, 5, 6]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(studio, 0.04).texture;
  pmrem.dispose();
  return texture;
}

export function createOrb(container, { reduceMotion }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = buildEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  // Far enough back that the blob's widest swell and its float never touch the edge.
  camera.position.set(0, 0, 5.4);

  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, DETAIL));
  const positions = geometry.attributes.position;
  const base = Float32Array.from(positions.array);
  const material = new THREE.MeshPhysicalMaterial({
    color: cssColor('--orb-tint'),
    metalness: 1,
    roughness: 0.1,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.35,
  });
  const orb = new THREE.Mesh(geometry, material);
  scene.add(orb);

  const current = { ...STATE_PARAMS.idle };
  let target = STATE_PARAMS.idle;
  let level = 0;
  let levelTarget = 0;
  let time = 0;
  let last = performance.now();
  let frame = 0;

  function shape(t) {
    const { amplitude, frequency, levelGain } = current;
    const lift = level * levelGain;
    for (let i = 0; i < positions.count; i++) {
      const x = base[i * 3];
      const y = base[i * 3 + 1];
      const z = base[i * 3 + 2];
      // Layered sines: an organic, slowly travelling surface without a noise library.
      const wave =
        Math.sin(x * frequency + t) * Math.sin(y * frequency * 1.3 + t * 1.2) * Math.sin(z * frequency * 0.9 + t * 0.8);
      // The voice swells the orb from its middle outward, like a breath.
      const voice = lift * (0.6 + 0.4 * Math.sin(y * 3 + t * 4));
      const scale = 1 + amplitude * wave + voice * 0.35;
      positions.setXYZ(i, x * scale, y * scale, z * scale);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  function render(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const key of Object.keys(current)) current[key] += (target[key] - current[key]) * STATE_EASING;
    level += (levelTarget - level) * LEVEL_EASING;
    time += dt * current.speed;
    shape(time);
    orb.rotation.y += dt * current.spin;
    orb.rotation.x = Math.sin(time * 0.3) * 0.12;
    orb.position.y = Math.sin(time * 0.8) * BOB_HEIGHT;
    renderer.render(scene, camera);
  }

  // Under reduced motion the orb is drawn once per state: present, but still.
  function renderStill() {
    Object.assign(current, target);
    level = 0;
    shape(0);
    orb.rotation.set(0.1, 0.6, 0);
    orb.position.y = 0;
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
