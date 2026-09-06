import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLakesideFishermanPlayerModel } from './model.js';
import { CAMERA_PRESETS, PRESET_ORDER, resolvePreset } from './camera-presets.js';
import { buildPartManifest, collectMeshNameIssues } from './part-manifest.js';

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 960;
const SKY_COLOR = 0xeceff4;
const GROUND_COLOR = 0xc8cdd6;

/** @type {THREE.PerspectiveCamera | null} */
let camera = null;
/** @type {THREE.WebGLRenderer | null} */
let renderer = null;
/** @type {THREE.Scene | null} */
let scene = null;
/** @type {THREE.Group | null} */
let model = null;
/** @type {OrbitControls | null} */
let controls = null;
/** @type {THREE.Object3D | null} */
let framingTarget = null;
/** @type {THREE.Vector3} */
const lookTarget = new THREE.Vector3();
/** @type {string} */
let activePresetId = 'front';

const params = new URLSearchParams(window.location.search);

function settleFrames(count = 2) {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * @param {THREE.Object3D} root
 * @param {'body' | 'head'} framing
 */
function pickFramingObject(root, framing) {
  if (framing !== 'head') return root;
  const runtime = root.userData?.sculptRuntime;
  const headMesh = runtime?.meshes?.head;
  if (headMesh) return headMesh;
  return root.getObjectByName('Head') ?? root;
}

/**
 * Auto-frame camera from bounding box (mirrors generated frameLakesideFishermanPlayerCamera).
 * @param {THREE.PerspectiveCamera} cam
 * @param {THREE.Object3D} object
 * @param {{ margin?: number, azimuthDeg?: number, elevationDeg?: number }} options
 */
function frameObjectCamera(cam, object, options = {}) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (cam.fov * Math.PI) / 180;
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  cam.position.copy(center).addScaledVector(dir, distance);
  cam.near = Math.max(0.01, distance - maxDim);
  cam.far = distance + maxDim * 2;
  lookTarget.copy(center);
  cam.lookAt(lookTarget);
  cam.updateProjectionMatrix();
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
}

/** Align model bbox min Y to ground plane y=0. */
function alignModelToFloor(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
}

function createNeutralLights() {
  const lights = new THREE.Group();
  lights.name = 'NeutralLookDevLights';

  const hemi = new THREE.HemisphereLight(0xf2f4ff, 0x363b42, 0.85);
  lights.add(hemi);

  const key = new THREE.DirectionalLight(0xfff4e8, 2.15);
  key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 20;
  key.shadow.camera.left = -2.2;
  key.shadow.camera.right = 2.2;
  key.shadow.camera.top = 2.8;
  key.shadow.camera.bottom = -0.2;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);

  const fill = new THREE.DirectionalLight(0xa8c4ff, 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);

  const rim = new THREE.DirectionalLight(0xfff1c4, 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);

  return lights;
}

function createGround(sceneRef) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardMaterial({ color: GROUND_COLOR, roughness: 0.95, metalness: 0 }),
  );
  ground.name = 'GroundPlane';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.receiveShadow = true;
  sceneRef.add(ground);

  const contact = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 48),
    new THREE.ShadowMaterial({ opacity: 0.38 }),
  );
  contact.name = 'ContactShadow';
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.002;
  contact.receiveShadow = true;
  sceneRef.add(contact);
}

/**
 * @param {Partial<typeof CAMERA_PRESETS['front']> & Record<string, unknown>} spec
 */
async function applyCameraSpec(spec) {
  if (!camera || !model) return;

  const preset = spec.presetId ? resolvePreset(String(spec.presetId)) : null;
  const framing = spec.framing ?? preset?.framing ?? 'body';
  framingTarget = pickFramingObject(model, framing);

  if (typeof spec.fovDegrees === 'number') camera.fov = spec.fovDegrees;
  if (typeof spec.near === 'number') camera.near = spec.near;
  if (typeof spec.far === 'number') camera.far = spec.far;

  if (typeof spec.distance === 'number' && spec.target) {
    const target = new THREE.Vector3(...(Array.isArray(spec.target) ? spec.target : [0, 1, 0]));
    const az = ((spec.azimuthDegrees ?? spec.azimuthDeg ?? 0) * Math.PI) / 180;
    const el = ((spec.elevationDegrees ?? spec.elevationDeg ?? 8) * Math.PI) / 180;
    const dir = new THREE.Vector3(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      Math.cos(az) * Math.cos(el),
    );
    camera.position.copy(target).addScaledVector(dir, spec.distance);
    lookTarget.copy(target);
    camera.lookAt(lookTarget);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  } else {
    frameObjectCamera(camera, framingTarget, {
      margin: spec.margin ?? preset?.margin ?? 1.15,
      azimuthDeg: spec.azimuthDegrees ?? spec.azimuthDeg ?? preset?.azimuthDeg ?? 0,
      elevationDeg: spec.elevationDegrees ?? spec.elevationDeg ?? preset?.elevationDeg ?? 8,
    });
  }

  activePresetId = preset?.id ?? String(spec.presetId ?? activePresetId);
  document.querySelectorAll('[data-camera-preset]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-camera-preset') === activePresetId);
  });

  await settleFrames(2);
}

function buildCameraToolbar(onSelect) {
  const toolbar = document.getElementById('camera-toolbar');
  if (!toolbar) return;
  toolbar.replaceChildren();
  for (const id of PRESET_ORDER) {
    const preset = CAMERA_PRESETS[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = preset.label;
    btn.dataset.cameraPreset = id;
    btn.addEventListener('click', () => onSelect({ presetId: id, ...preset }));
    toolbar.appendChild(btn);
  }
}

async function capturePass({ passId = 'beauty', mode = 'beauty' } = {}) {
  if (!renderer || !scene || !camera) {
    return { ok: false, reason: 'renderer not ready' };
  }

  if (mode === 'alpha-silhouette') {
    const prevBg = scene.background;
    scene.background = new THREE.Color(0x000000);
    renderer.render(scene, camera);
    scene.background = prevBg;
  } else {
    renderer.render(scene, camera);
  }

  await settleFrames(1);
  return { ok: true, selector: '#scene', passId, mode };
}

async function init() {
  const mount = document.getElementById('scene');
  if (!mount) throw new Error('#scene mount missing');

  scene = new THREE.Scene();
  scene.name = 'ProceduralFishermanPreviewScene';
  scene.background = new THREE.Color(SKY_COLOR);

  camera = new THREE.PerspectiveCamera(40, CANVAS_WIDTH / CANVAS_HEIGHT, 0.05, 100);
  camera.name = 'PreviewCamera';

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(CANVAS_WIDTH, CANVAS_HEIGHT, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.4;
  controls.maxDistance = 12;

  scene.add(createNeutralLights());
  createGround(scene);

  model = createLakesideFishermanPlayerModel({
    castShadow: true,
    receiveShadow: true,
    qualityPriority: 'balanced',
  });
  model.name = 'Lakeside Fisherman Player';
  alignModelToFloor(model);
  scene.add(model);

  const meshIssues = collectMeshNameIssues(model);
  if (meshIssues.length) {
    console.warn('[procedural-fisherman] mesh naming issues:', meshIssues);
  }

  buildCameraToolbar((spec) => applyCameraSpec(spec));

  const initialPreset = resolvePreset(params.get('camera') ?? params.get('preset') ?? 'front');
  if (initialPreset) {
    applyCameraSpec({ presetId: initialPreset.id, ...initialPreset });
  } else if (params.has('azimuth') || params.has('elevation')) {
    applyCameraSpec({
      azimuthDeg: Number(params.get('azimuth') ?? 0),
      elevationDeg: Number(params.get('elevation') ?? 8),
      margin: Number(params.get('margin') ?? 1.15),
      framing: params.get('framing') === 'head' ? 'head' : 'body',
    });
  } else {
    applyCameraSpec({ presetId: 'front', ...CAMERA_PRESETS.front });
  }

  window.__FISHERMAN_MODEL__ = {
    model,
    scene,
    camera,
    renderer,
    controls,
    getPartManifest: () => buildPartManifest(model),
    applyPreset: (id) => applyCameraSpec({ presetId: id, ...CAMERA_PRESETS[id] }),
    frameCamera: (options) => applyCameraSpec(options),
  };

  window.__IMG2THREEJS_CAPTURE__ = {
    setCamera: (cameraSpec) => applyCameraSpec(cameraSpec ?? {}),
    capturePass,
    getActivePreset: () => activePresetId,
    presets: CAMERA_PRESETS,
  };

  function animate() {
    requestAnimationFrame(animate);
    controls?.update();
    renderer?.render(scene, camera);
  }
  animate();

  window.__IMG2THREEJS_READY__ = true;
  window.dispatchEvent(new CustomEvent('img2threejs-ready'));
}

init().catch((error) => {
  console.error('[procedural-fisherman] init failed', error);
  const banner = document.getElementById('error-banner');
  if (banner) {
    banner.hidden = false;
    banner.textContent = String(error?.message ?? error);
  }
});
