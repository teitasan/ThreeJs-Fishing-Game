import * as THREE from 'three';

/** @typedef {{ castShadow?: boolean; receiveShadow?: boolean }} FishermanModelOptions */

const HEIGHT = 2.6;
const HEAD_H = 0.455;
const HIP_Y = 1.16;
const CHEST_Y = 1.59;
const SHOULDER_Y = 1.95;
const NECK_Y = 1.98;
const HEAD_CENTER_Y = 2.24;
const KNEE_Y = 0.58;
const ANKLE_Y = 0.14;
const ELBOW_Y = 1.52;
const WRIST_Y = 1.13;

const X = {
  hipL: 0.2,
  hipR: -0.2,
  kneeL: 0.22,
  kneeR: -0.22,
  ankleL: 0.24,
  ankleR: -0.24,
  shoulderL: 0.47,
  shoulderR: -0.47,
  elbowL: 0.54,
  elbowR: -0.54,
  wristL: 0.57,
  wristR: -0.57,
};

const PALETTE = {
  jacket: 0x2a6b7a,
  cap: 0x3a6870,
  pants: 0x2b3340,
  boots: 0x4a3828,
  skin: 0xe8b98f,
  hair: 0x171310,
  metal: 0x8a8075,
  eyeWhite: 0xf2eee4,
  eyeDark: 0x1a1510,
  lips: 0xc98070,
  hood: 0x245a66,
};

/**
 * @param {string} id
 * @param {string} parent
 * @param {string} role
 * @param {string} primitive
 * @param {string} material
 */
function sculptMeta(id, parent, role, primitive, material) {
  return { id, parent, role, primitive, material };
}

/**
 * @param {THREE.Object3D} parent
 * @param {string} name
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} material
 * @param {ReturnType<typeof sculptMeta>} meta
 * @param {FishermanModelOptions} options
 */
function addMesh(parent, name, geometry, material, meta, options) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.userData.sculptComponent = meta;
  parent.add(mesh);
  return mesh;
}

/**
 * @param {THREE.Object3D} parent
 * @param {string} pivotName
 * @param {THREE.Vector3 | [number, number, number]} position
 */
function addPivot(parent, pivotName, position) {
  const pivot = new THREE.Group();
  pivot.name = `${pivotName}__pivot`;
  if (Array.isArray(position)) pivot.position.set(position[0], position[1], position[2]);
  else pivot.position.copy(position);
  parent.add(pivot);
  return pivot;
}

/**
 * Vertical limb cylinder in pivot-local space (extends -Y from parent pivot).
 * @param {THREE.Group} parentPivot
 * @param {number} length
 * @param {number} radiusTop
 * @param {number} radiusBottom
 * @param {number} lateralDrift
 * @param {THREE.Material} material
 * @param {string} name
 * @param {ReturnType<typeof sculptMeta>} meta
 * @param {FishermanModelOptions} options
 */
function addLimbSegmentLocal(
  parentPivot,
  length,
  radiusTop,
  radiusBottom,
  lateralDrift,
  material,
  name,
  meta,
  options,
) {
  const mesh = addMesh(
    parentPivot,
    name,
    new THREE.CylinderGeometry(radiusBottom, radiusTop, length, 6),
    material,
    meta,
    options,
  );
  mesh.position.set(lateralDrift * 0.5, -length * 0.5, 0);
  if (lateralDrift !== 0) {
    mesh.rotation.z = -Math.sign(lateralDrift) * Math.atan2(Math.abs(lateralDrift), length) * 0.35;
  }
  return mesh;
}

/**
 * @param {Record<string, THREE.Material>} mats
 * @param {FishermanModelOptions} options
 */
function createLakesideFishermanPlayerModel(options = {}) {
  const root = new THREE.Group();
  root.name = 'Lakeside Fisherman Player';

  const mats = {
    jacket: new THREE.MeshStandardMaterial({ color: PALETTE.jacket, roughness: 0.82, metalness: 0.04, flatShading: true }),
    cap: new THREE.MeshStandardMaterial({ color: PALETTE.cap, roughness: 0.8, metalness: 0.03, flatShading: true }),
    pants: new THREE.MeshStandardMaterial({ color: PALETTE.pants, roughness: 0.78, metalness: 0.02, flatShading: true }),
    boots: new THREE.MeshStandardMaterial({ color: PALETTE.boots, roughness: 0.62, metalness: 0.05, flatShading: true }),
    skin: new THREE.MeshStandardMaterial({ color: PALETTE.skin, roughness: 0.62, metalness: 0, flatShading: true }),
    hair: new THREE.MeshStandardMaterial({ color: PALETTE.hair, roughness: 0.55, metalness: 0, flatShading: true, side: THREE.DoubleSide }),
    metal: new THREE.MeshStandardMaterial({ color: PALETTE.metal, roughness: 0.42, metalness: 0.72, flatShading: true }),
    hood: new THREE.MeshStandardMaterial({ color: PALETTE.hood, roughness: 0.84, metalness: 0.03, flatShading: true, side: THREE.DoubleSide }),
    eye: new THREE.MeshStandardMaterial({ color: PALETTE.eyeDark, roughness: 0.35, metalness: 0.05, flatShading: true }),
  };

  const nodes = { root };
  const meshes = {};
  const sockets = {};
  const pivots = {};

  const hipsPivot = addPivot(root, 'Hips', [0, HIP_Y, 0]);
  nodes.hips = hipsPivot;
  pivots.hips = hipsPivot;

  const chestPivot = addPivot(hipsPivot, 'Chest', [0, CHEST_Y - HIP_Y, 0]);
  nodes.chest = chestPivot;
  pivots.chest = chestPivot;

  // Tapered jacket torso shell — modest taper, not extreme inverted triangle
  meshes.torso = addMesh(
    chestPivot,
    'JacketTorso',
    new THREE.CylinderGeometry(0.395, 0.30, 0.82, 6),
    mats.jacket,
    sculptMeta('torso', 'chest', 'shell', 'cylinder', 'jacket'),
    options,
  );
  meshes.torso.position.set(0, (1.59 - CHEST_Y), 0);

  // High collar — overlaps neck, no gap
  meshes.collar = addMesh(
    chestPivot,
    'HighCollar',
    new THREE.CylinderGeometry(0.19, 0.21, 0.11, 6, 1, true),
    mats.jacket,
    sculptMeta('collar', 'chest', 'detail', 'cylinder', 'jacket'),
    options,
  );
  meshes.collar.position.set(0, 0.36, 0.01);

  // Center zipper
  meshes.centerZipper = addMesh(
    chestPivot,
    'CenterZipper',
    new THREE.BoxGeometry(0.03, 0.72, 0.02),
    mats.metal,
    sculptMeta('center-zipper', 'chest', 'detail', 'box', 'metal'),
    options,
  );
  meshes.centerZipper.position.set(0, 0.02, 0.2);

  // Chest zippers (paired)
  for (const side of [-1, 1]) {
    const id = side < 0 ? 'chest-zipper-r' : 'chest-zipper-l';
    const mesh = addMesh(
      chestPivot,
      side < 0 ? 'ChestZipperR' : 'ChestZipperL',
      new THREE.BoxGeometry(0.04, 0.18, 0.025),
      mats.metal,
      sculptMeta(id, 'chest', 'detail', 'box', 'metal'),
      options,
    );
    mesh.position.set(0.12 * side, 0.18, 0.19);
    meshes[id] = mesh;
  }

  // Lower flap pockets (paired)
  for (const side of [-1, 1]) {
    const id = side < 0 ? 'flap-pocket-r' : 'flap-pocket-l';
    const mesh = addMesh(
      chestPivot,
      side < 0 ? 'FlapPocketR' : 'FlapPocketL',
      new THREE.BoxGeometry(0.14, 0.12, 0.05),
      mats.jacket,
      sculptMeta(id, 'chest', 'detail', 'box', 'jacket'),
      options,
    );
    mesh.position.set(0.14 * side, -0.28, 0.17);
    meshes[id] = mesh;
    const flap = addMesh(
      chestPivot,
      side < 0 ? 'FlapPocketFlapR' : 'FlapPocketFlapL',
      new THREE.BoxGeometry(0.15, 0.04, 0.055),
      mats.jacket,
      sculptMeta(`${id}-flap`, 'chest', 'detail', 'box', 'jacket'),
      options,
    );
    flap.position.set(0.14 * side, -0.22, 0.175);
    meshes[`${id}-flap`] = flap;
  }

  // Rear hood — visible volume from rear/rear-quarter views
  meshes.hood = addMesh(
    chestPivot,
    'RearHood',
    new THREE.CylinderGeometry(0.24, 0.32, 0.38, 5, 1, false, 0, Math.PI),
    mats.hood,
    sculptMeta('hood', 'chest', 'shell', 'cylinder', 'jacket'),
    options,
  );
  meshes.hood.position.set(0, 0.32, -0.17);
  meshes.hood.rotation.x = -0.22;

  // Rear belt with paired pouches — flush against hips, visible from rear
  meshes.belt = addMesh(
    hipsPivot,
    'RearBelt',
    new THREE.BoxGeometry(0.44, 0.06, 0.1),
    mats.pants,
    sculptMeta('belt', 'hips', 'detail', 'box', 'pants'),
    options,
  );
  meshes.belt.position.set(0, 0.02, -0.11);
  for (const side of [-1, 1]) {
    const id = side < 0 ? 'belt-pouch-r' : 'belt-pouch-l';
    const mesh = addMesh(
      hipsPivot,
      side < 0 ? 'BeltPouchR' : 'BeltPouchL',
      new THREE.BoxGeometry(0.09, 0.11, 0.08),
      mats.pants,
      sculptMeta(id, 'hips', 'detail', 'box', 'pants'),
      options,
    );
    mesh.position.set(0.13 * side, -0.01, -0.14);
    meshes[id] = mesh;
  }

  const neckPivot = addPivot(chestPivot, 'Neck', [0, NECK_Y - CHEST_Y, 0]);
  nodes.neck = neckPivot;
  pivots.neck = neckPivot;

  // Short visible skin neck within high collar
  meshes.neck = addMesh(
    neckPivot,
    'Neck',
    new THREE.CylinderGeometry(0.075, 0.085, 0.12, 6),
    mats.skin,
    sculptMeta('neck', 'neck', 'body', 'cylinder', 'skin'),
    options,
  );
  meshes.neck.position.set(0, 0.05, 0);

  const headPivot = addPivot(neckPivot, 'Head', [0, HEAD_CENTER_Y - NECK_Y, 0.02]);
  nodes.head = headPivot;
  pivots.head = headPivot;

  // Compact faceted rounded head (ellipsoid) with subtle jaw
  meshes.head = addMesh(
    headPivot,
    'Head',
    new THREE.SphereGeometry(0.175, 6, 5),
    mats.skin,
    sculptMeta('head', 'head', 'body', 'sphere', 'skin'),
    options,
  );
  meshes.head.scale.set(1, 1.29, 0.83);
  meshes.head.position.set(0, -0.01, 0);

  meshes.jaw = addMesh(
    headPivot,
    'Jaw',
    new THREE.BoxGeometry(0.2, 0.07, 0.11),
    mats.skin,
    sculptMeta('jaw', 'head', 'body', 'box', 'skin'),
    options,
  );
  meshes.jaw.position.set(0, -0.13, 0.05);

  // Angular fringe
  meshes.fringe = addMesh(
    headPivot,
    'HairFringe',
    new THREE.BoxGeometry(0.22, 0.07, 0.07),
    mats.hair,
    sculptMeta('fringe', 'head', 'hair', 'box', 'hair'),
    options,
  );
  meshes.fringe.position.set(0, 0.06, 0.11);
  meshes.fringe.rotation.x = 0.25;

  // Rectangular anime eyes
  for (const side of [-1, 1]) {
    const id = side < 0 ? 'eye-r' : 'eye-l';
    const mesh = addMesh(
      headPivot,
      side < 0 ? 'EyeR' : 'EyeL',
      new THREE.BoxGeometry(0.055, 0.035, 0.02),
      mats.eye,
      sculptMeta(id, 'head', 'face', 'box', 'eye'),
      options,
    );
    mesh.position.set(0.065 * side, 0.01, 0.13);
    meshes[id] = mesh;
  }

  // Nose and mouth
  meshes.nose = addMesh(
    headPivot,
    'Nose',
    new THREE.BoxGeometry(0.025, 0.03, 0.03),
    mats.skin,
    sculptMeta('nose', 'head', 'face', 'box', 'skin'),
    options,
  );
  meshes.nose.position.set(0, -0.05, 0.13);

  meshes.mouth = addMesh(
    headPivot,
    'Mouth',
    new THREE.BoxGeometry(0.05, 0.012, 0.015),
    new THREE.MeshStandardMaterial({ color: PALETTE.lips, roughness: 0.55, flatShading: true }),
    sculptMeta('mouth', 'head', 'face', 'box', 'skin'),
    options,
  );
  meshes.mouth.position.set(0, -0.1, 0.12);

  // Faceted baseball cap — compact crown, readable brim
  meshes.capCrown = addMesh(
    headPivot,
    'CapCrown',
    new THREE.CylinderGeometry(0.155, 0.185, 0.13, 6),
    mats.cap,
    sculptMeta('cap-crown', 'head', 'accessory', 'cylinder', 'cap'),
    options,
  );
  meshes.capCrown.position.set(0, 0.17, 0);

  meshes.capBrim = addMesh(
    headPivot,
    'CapBrim',
    new THREE.BoxGeometry(0.26, 0.02, 0.14),
    mats.cap,
    sculptMeta('cap-brim', 'head', 'accessory', 'box', 'cap'),
    options,
  );
  meshes.capBrim.position.set(0, 0.12, 0.11);

  meshes.capButton = addMesh(
    headPivot,
    'CapTopButton',
    new THREE.CylinderGeometry(0.015, 0.015, 0.02, 6),
    mats.metal,
    sculptMeta('cap-button', 'head', 'detail', 'cylinder', 'metal'),
    options,
  );
  meshes.capButton.position.set(0, 0.24, 0);

  /**
   * @param {'L' | 'R'} side
   * @param {number} shoulderX
   * @param {number} elbowX
   * @param {number} wristX
   * @param {number} abductionDeg
   */
  function buildArm(side, shoulderX, elbowX, wristX, abductionDeg) {
    const tag = side.toLowerCase();
    const shoulderPivot = addPivot(chestPivot, `Shoulder${side}`, [shoulderX - 0, SHOULDER_Y - CHEST_Y, 0]);
    nodes[`shoulder-${tag}`] = shoulderPivot;
    pivots[`shoulder${side}`] = shoulderPivot;
    shoulderPivot.rotation.z = THREE.MathUtils.degToRad(abductionDeg);

    const upperLen = SHOULDER_Y - ELBOW_Y;
    meshes[`upper-arm-${tag}`] = addMesh(
      shoulderPivot,
      `UpperArm${side}`,
      new THREE.CylinderGeometry(0.075, 0.065, upperLen, 6),
      mats.jacket,
      sculptMeta(`upper-arm-${tag}`, `shoulder-${tag}`, 'limb', 'cylinder', 'jacket'),
      options,
    );
    meshes[`upper-arm-${tag}`].position.set(0, -upperLen * 0.5, 0);

    const elbowPivot = addPivot(shoulderPivot, `Elbow${side}`, [0, -upperLen, 0]);
    nodes[`elbow-${tag}`] = elbowPivot;
    pivots[`elbow${side}`] = elbowPivot;
    elbowPivot.rotation.z = THREE.MathUtils.degToRad(abductionDeg * 0.35);

    const foreLen = ELBOW_Y - WRIST_Y;
    meshes[`forearm-${tag}`] = addMesh(
      elbowPivot,
      `Forearm${side}`,
      new THREE.CylinderGeometry(0.06, 0.055, foreLen, 6),
      mats.jacket,
      sculptMeta(`forearm-${tag}`, `elbow-${tag}`, 'limb', 'cylinder', 'jacket'),
      options,
    );
    meshes[`forearm-${tag}`].position.set(0, -foreLen * 0.5, 0);

    // Sleeve cuff band
    const cuff = addMesh(
      elbowPivot,
      `SleeveCuff${side}`,
      new THREE.CylinderGeometry(0.065, 0.068, 0.05, 6),
      mats.jacket,
      sculptMeta(`cuff-${tag}`, `elbow-${tag}`, 'detail', 'cylinder', 'jacket'),
      options,
    );
    cuff.position.set(0, -foreLen + 0.03, 0);
    meshes[`cuff-${tag}`] = cuff;

    const wristPivot = addPivot(elbowPivot, `Wrist${side}`, [0, -foreLen, 0]);
    nodes[`wrist-${tag}`] = wristPivot;
    pivots[`wrist${side}`] = wristPivot;

    meshes[`hand-${tag}`] = addMesh(
      wristPivot,
      `Hand${side}`,
      new THREE.BoxGeometry(0.085, 0.12, 0.055),
      mats.skin,
      sculptMeta(`hand-${tag}`, `wrist-${tag}`, 'hand', 'box', 'skin'),
      options,
    );
    meshes[`hand-${tag}`].position.set((wristX - elbowX) * 0.12, -0.055, 0.02);

    if (side === 'R') {
      const rodGrip = new THREE.Object3D();
      rodGrip.name = 'rod-grip';
      rodGrip.position.set(0, -0.04, 0.03);
      rodGrip.userData.socket = {
        id: 'rod-grip',
        purpose: 'fishing-rod attachment for existing game runtime',
        forwardAxis: [0, 0, 1],
      };
      wristPivot.add(rodGrip);
      sockets['hand-r:rod-grip'] = rodGrip;
    }
  }

  buildArm('L', X.shoulderL, X.elbowL, X.wristL, 10);
  buildArm('R', X.shoulderR, X.elbowR, X.wristR, -10);

  /**
   * @param {'L' | 'R'} side
   * @param {number} hipX
   * @param {number} kneeX
   * @param {number} ankleX
   * @param {number} hipSpreadDeg
   */
  function buildLeg(side, hipX, kneeX, ankleX, hipSpreadDeg) {
    const tag = side.toLowerCase();
    const hipPivot = addPivot(hipsPivot, `Hip${side}`, [hipX, 0, 0]);
    nodes[`hip-${tag}`] = hipPivot;
    pivots[`hip${side}`] = hipPivot;
    hipPivot.rotation.z = THREE.MathUtils.degToRad(hipSpreadDeg);

    const upperLen = HIP_Y - KNEE_Y;
    meshes[`thigh-${tag}`] = addLimbSegmentLocal(
      hipPivot,
      upperLen,
      0.135,
      0.125,
      kneeX - hipX,
      mats.pants,
      `Thigh${side}`,
      sculptMeta(`thigh-${tag}`, `hip-${tag}`, 'limb', 'cylinder', 'pants'),
      options,
    );

    const kneePivot = addPivot(hipPivot, `Knee${side}`, [kneeX - hipX, -upperLen, 0]);
    nodes[`knee-${tag}`] = kneePivot;
    pivots[`knee${side}`] = kneePivot;

    const lowerLen = KNEE_Y - ANKLE_Y;
    meshes[`shin-${tag}`] = addLimbSegmentLocal(
      kneePivot,
      lowerLen,
      0.105,
      0.095,
      ankleX - kneeX,
      mats.pants,
      `Shin${side}`,
      sculptMeta(`shin-${tag}`, `knee-${tag}`, 'limb', 'cylinder', 'pants'),
      options,
    );

    const anklePivot = addPivot(kneePivot, `Ankle${side}`, [ankleX - kneeX, -lowerLen, 0]);
    nodes[`ankle-${tag}`] = anklePivot;
    pivots[`ankle${side}`] = anklePivot;

    // Boot cuff
    meshes[`boot-cuff-${tag}`] = addMesh(
      anklePivot,
      `BootCuff${side}`,
      new THREE.CylinderGeometry(0.105, 0.11, 0.08, 6),
      mats.pants,
      sculptMeta(`boot-cuff-${tag}`, `ankle-${tag}`, 'detail', 'cylinder', 'pants'),
      options,
    );
    meshes[`boot-cuff-${tag}`].position.set(0, 0.04, 0);

    // Faceted boot — enlarged, soles on y=0
    meshes[`boot-${tag}`] = addMesh(
      anklePivot,
      `Boot${side}`,
      new THREE.BoxGeometry(0.17, 0.15, 0.28),
      mats.boots,
      sculptMeta(`boot-${tag}`, `ankle-${tag}`, 'footwear', 'box', 'boots'),
      options,
    );
    meshes[`boot-${tag}`].position.set(0, -0.065, 0.05);

    if (side === 'R') {
      const pouch = addMesh(
        hipPivot,
        'ThighPouchR',
        new THREE.BoxGeometry(0.09, 0.12, 0.06),
        mats.pants,
        sculptMeta('thigh-pouch-r', `hip-${tag}`, 'detail', 'box', 'pants'),
        options,
      );
      pouch.position.set(-0.1, -0.22, 0.1);
      meshes['thigh-pouch-r'] = pouch;

      const buckle = addMesh(
        hipPivot,
        'ThighPouchBuckleR',
        new THREE.BoxGeometry(0.02, 0.06, 0.015),
        mats.metal,
        sculptMeta('thigh-buckle-r', `hip-${tag}`, 'detail', 'box', 'metal'),
        options,
      );
      buckle.position.set(-0.14, -0.2, 0.13);
      meshes['thigh-buckle-r'] = buckle;
    }
  }

  buildLeg('L', X.hipL, X.kneeL, X.ankleL, 2);
  buildLeg('R', X.hipR, X.kneeR, X.ankleR, -2);

  root.userData.sculptRuntime = { meshes, nodes, sockets, pivots };
  root.userData.actionReadiness = {
    note: 'Articulated pivot groups; rotate pivots for pose animation. Rod grip on character-right wrist.',
  };

  return root;
}

export { createLakesideFishermanPlayerModel };
