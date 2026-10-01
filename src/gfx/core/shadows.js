/* ===========================================================
   影（ARCHITECTURE §4.5）
   -----------------------------------------------------------
   近景：key（DirectionalLight、castShadow 固定）の three 影マップを注視点へ追従。
     テクセルにスナップして、歩いても影の縁がちらつかないようにする。
     影の更新は «prepare の中で 1 回だけ»（renderNear）。何も描かないカメラ（layer 31 だけ）で
     render すると three は影マップだけ更新する（ライトは layers.enableAll）。
     注意：three r180 の影の描画（WebGLShadowMap の renderObject）は物体の layers を «shadow.camera» ではなく
     «render() に渡したカメラ» で判定する。何も描かないカメラのままだと影マップに何も入らないので、
     renderNear の間だけ shadowMap.render へ渡すカメラを shadow.camera（layers = NG_MASK.SHADOW）に差し替える
   高さ場影：地形 + 樹冠の高さ（R16F に焼いた合成高さ）を key の方向へ raymarch して
     R8 に焼く。2 段（±256m @1024²、±1024m @1024²。low は ±1024m @512² のみ）。
     太陽は 1 実秒で 0.25° しか動かないので、段 × 4 象限を 16 フレーム（≒ 0.27s）で一巡するように
     間を空けて 1 枚ずつ焼き直す（2 段なら 2 フレームに 1 枚、1 段なら 4 フレームに 1 枚。一巡で 0.07°）。
     key が 2° 以上跳んだら（時刻の変更・太陽と月の切り替え）全部を焼き直す
   =========================================================== */
import { NG, NG_PASS } from './frame.js';
import { NG_MASK } from './layers.js';
import { NG_HEIGHTFIELD_GLSL } from './glsl/heightfield.glsl.js';

/** 段ごとの半径（m） */
export const NG_HF_SHADOW_R = Object.freeze([256, 1024]);
const BAKE_H_N = 1024;
const KEY_JUMP_COS = Math.cos((2 * Math.PI) / 180);
/** 高さ場影を一巡するフレーム数（§4.5 の «4 象限 × 4 フレーム»） */
export const NG_HF_CYCLE_FRAMES = 16;

/* 合成高さ：地形 + 樹冠（段の範囲を BAKE_H_N² に） */
const HEIGHT_FRAG = NG_HEIGHTFIELD_GLSL + /* glsl */ `
uniform float ngR;
void main() {
  vec2 xz = (vUv * 2.0 - 1.0) * ngR;
  vec2 cn = ngCanopyAt(xz);
  float h = ngTerrainH(xz);
  gl_FragColor = vec4(h + (h > 0.0 ? cn.y * 40.0 * smoothstep(0.1, 0.5, cn.x) : 0.0), h, 0.0, 1.0);
}
`;
/* key 方向への raymarch。半影は «光線と遮蔽物の高さの差 ÷ 距離» の最小値 */
const MARCH_FRAG = /* glsl */ `
uniform sampler2D ngHSrc;
uniform float ngR;
uniform vec3 ngKey;
uniform float ngMaxDist;
void main() {
  vec2 xz = (vUv * 2.0 - 1.0) * ngR;
  vec2 st = texture(ngHSrc, vUv).rg;
  float h0 = max(st.y, 0.0) + 0.3;                // 受け手は地面か水面（樹冠は遮蔽物としてだけ効く）
  float horiz = length(ngKey.xz);
  if (ngKey.y <= 0.0) { gl_FragColor = vec4(0.0); return; }
  vec2 dir = horiz > 1e-4 ? ngKey.xz / horiz : vec2(0.0);
  float rise = ngKey.y / max(horiz, 1e-4);
  float vis = 1.0;
  float d = ngR / 1024.0 * 1.5;
  for (int i = 0; i < 40; i++) {
    vec2 p = xz + dir * d;
    vec2 uv = p / (2.0 * ngR) + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 || d > ngMaxDist) break;
    float occ = texture(ngHSrc, uv).r;
    float ray = h0 + d * rise;
    vis = min(vis, clamp(0.5 + 24.0 * (ray - occ) / d, 0.0, 1.0));
    if (vis <= 0.0) break;
    d *= 1.19;                                    // 40 歩で 1.5R に届く
  }
  gl_FragColor = vec4(vis, vis, vis, 1.0);
}
`;

/**
 * 近景の影の追従と、高さ場影の焼き込み
 */
export class Shadows {
  /**
   * @param {typeof import('three')} THREE
   * @param {import('./frame.js').NgFrame} frame
   * @param {import('./forge.js').Forge|null} forge
   */
  constructor(THREE, frame, forge) {
    this.THREE = THREE;
    this.frame = frame;
    this.forge = forge;
    /** @type {import('three').DirectionalLight|null} */
    this.key = null;
    this.profile = null;
    this.focus = new THREE.Vector3();
    const T = THREE;
    const white = () => {
      const t = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, T.RGBAFormat);
      t.needsUpdate = true;
      return t;
    };
    /** GLSL の shadow ライブラリが読む共有 uniforms */
    this.uniforms = {
      ngHfShadow0: { value: white() },
      ngHfShadow1: { value: white() },
      ngHfShadowXf: { value: new T.Vector4(1 / (2 * NG_HF_SHADOW_R[0]), 1 / (2 * NG_HF_SHADOW_R[1]), 0, 0) },
    };
    this._tickCam = new T.PerspectiveCamera();
    this._tickCam.layers.mask = NG_MASK.SHADOW_TICK;
    this._tickRT = new T.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this._hf = null;
    this._slice = 0;
    this._hfTick = 0;
    this._bakedKey = new T.Vector3(0, -1, 0);
    this._march = { ngHSrc: { value: null }, ngR: { value: 0 }, ngKey: { value: new T.Vector3() }, ngMaxDist: { value: 0 } };
    this._v = [new T.Vector3(), new T.Vector3(), new T.Vector3()];
  }

  /**
   * key のライトを受け取る（起動時に 1 回）。castShadow とライト数はここ以降変えない
   * @param {import('three').DirectionalLight} key
   */
  setKey(key) {
    this.key = key;
    key.castShadow = true;
    key.layers.enableAll();
    key.shadow.camera.layers.mask = NG_MASK.SHADOW;
    if (key.target && !key.target.parent) key.parent?.add(key.target);
    if (this.profile) this.configure(this.profile);
  }

  /**
   * 品質の near/hf 設定を反映（mapSize が変われば影マップを作り直させる）
   * @param {object} profile quality.js のプロファイル
   */
  configure(profile) {
    this.profile = profile;
    const key = this.key;
    this.frame.setComp(NG.CORE, 2, profile.nearShadow.extent);
    if (!key) return;
    const s = key.shadow, ns = profile.nearShadow;
    if (s.mapSize.x !== ns.size) {
      s.mapSize.set(ns.size, ns.size);
      s.map?.dispose();
      s.map = null;
    }
    const c = s.camera;
    c.left = -ns.extent; c.right = ns.extent; c.top = ns.extent; c.bottom = -ns.extent;
    c.near = 0.5; c.far = 1500;
    c.updateProjectionMatrix();
    s.bias = -0.0004;
    s.normalBias = 0.04;
    s.radius = ns.radius;
    if (this._hf && this._hf.levels !== profile.hfShadow.levels) this._buildHf();
  }

  /**
   * 注視点へ追従（テクセルスナップ）。雲量で影を薄くする
   * @param {{x:number,y:number,z:number}} focus
   * @param {{x:number,y:number,z:number}} keyDir 光へ向かう単位ベクトル
   * @param {number} cloud 0..1
   */
  fit(focus, keyDir, cloud) {
    const key = this.key;
    if (!key || !this.profile) return;
    const T = this.THREE, [f, r, u] = this._v;
    const ns = this.profile.nearShadow;
    const texel = (2 * ns.extent) / ns.size;
    f.set(-keyDir.x, -keyDir.y, -keyDir.z).normalize();
    r.crossVectors(f, T.Object3D.DEFAULT_UP);
    if (r.lengthSq() < 1e-8) r.set(1, 0, 0);
    r.normalize();
    u.crossVectors(r, f);
    const a = focus.x * r.x + focus.y * r.y + focus.z * r.z;
    const b = focus.x * u.x + focus.y * u.y + focus.z * u.z;
    const da = Math.round(a / texel) * texel - a, db = Math.round(b / texel) * texel - b;
    this.focus.set(focus.x + r.x * da + u.x * db, focus.y + r.y * da + u.y * db, focus.z + r.z * da + u.z * db);
    key.target.position.copy(this.focus);
    key.position.set(this.focus.x + keyDir.x * 600, this.focus.y + keyDir.y * 600, this.focus.z + keyDir.z * 600);
    key.target.updateMatrixWorld();
    key.updateMatrixWorld();
    key.shadow.intensity = 1 - 0.65 * Math.min(1, Math.max(0, cloud));
  }

  /**
   * 近景の影マップを今フレーム 1 回だけ更新する（何も描かないカメラで render）
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Scene} scene
   */
  renderNear(renderer, scene) {
    if (!this.key || !renderer.shadowMap.enabled) return;
    const sm = renderer.shadowMap, render = sm.render, layerCam = this.key.shadow.camera;
    sm.needsUpdate = true;
    const prev = renderer.getRenderTarget();
    this.frame.beginPass(NG_PASS.SHADOW, this.key);
    /* 影に入れる物の layers の判定に shadow.camera（SHADOW のマスク）を使わせる（上の注意）。
       renderObject がカメラから読むのは layers と onBeforeShadow の引数だけ */
    sm.render = function (lights, sc) { return render.call(this, lights, sc, layerCam); };
    try {
      renderer.setRenderTarget(this._tickRT);
      renderer.render(scene, this._tickCam);
    } finally {
      sm.render = render;
      renderer.setRenderTarget(prev);
    }
  }

  /* 段ごとの合成高さと影の RT を作る（heightfield の後） */
  _buildHf() {
    const T = this.THREE, f = this.forge, p = this.profile;
    if (!f || !this._hfUniforms) return;
    this._hf?.targets.forEach((t) => t.dispose());
    this._hf?.heights.forEach((t) => t.dispose());
    const levels = p.hfShadow.levels, size = p.hfShadow.size;
    const lv = levels === 2 ? [0, 1] : [1];
    const heights = [], targets = [];
    for (const l of lv) {
      const h = f.target(BAKE_H_N, BAKE_H_N, { type: T.HalfFloatType, wrap: 'clamp' });
      f.run(h, HEIGHT_FRAG, { ...this._hfUniforms, ngR: { value: NG_HF_SHADOW_R[l] } });
      heights[l] = h;
      targets[l] = f.target(size, size, { type: T.UnsignedByteType, wrap: 'clamp' });
    }
    this._hf = { levels, lv, heights, targets };
    this.uniforms.ngHfShadow0.value = targets[0] ? targets[0].texture : this.uniforms.ngHfShadow1.value;
    this.uniforms.ngHfShadow1.value = targets[1].texture;
    this.uniforms.ngHfShadowXf.value.z = levels === 2 ? 1 : 0;
    this._slice = 0;
    this._hfTick = 0;
    this._bakedKey.set(0, -1, 0);
  }

  /**
   * 高さ場のテクスチャが揃ったら呼ぶ（合成高さを作って全部を焼く）
   * @param {object} hfUniforms HeightField.uniforms
   * @param {{x:number,y:number,z:number}} keyDir
   */
  attachHeightfield(hfUniforms, keyDir) {
    this._hfUniforms = hfUniforms;
    if (!this.profile) return;
    this._buildHf();
    this.updateHf(keyDir, true);
  }

  /**
   * 高さ場影の償却更新（prepare から毎フレーム）。key が跳んだら全部を焼き直す
   * @param {{x:number,y:number,z:number}} keyDir
   * @param {boolean} [all=false]
   */
  updateHf(keyDir, all = false) {
    const hf = this._hf;
    if (!hf) return;
    const k = this._bakedKey;
    if (!all && k.x * keyDir.x + k.y * keyDir.y + k.z * keyDir.z < KEY_JUMP_COS) all = true;
    const slices = hf.lv.length * 4;
    if (all) {
      for (let s = 0; s < slices; s++) this._bakeSlice(hf.lv[s >> 2], s & 3, keyDir);
      this._slice = 0;
      this._hfTick = 0;
      k.set(keyDir.x, keyDir.y, keyDir.z);
      return;
    }
    const every = Math.max(1, Math.floor(NG_HF_CYCLE_FRAMES / slices));
    if ((this._hfTick++ % every) !== 0) return;
    const idx = this._slice;
    this._bakeSlice(hf.lv[idx >> 2], idx & 3, keyDir);
    this._slice = (idx + 1) % slices;
    if (this._slice === 0) k.set(keyDir.x, keyDir.y, keyDir.z);
  }

  _bakeSlice(level, quad, keyDir) {
    const hf = this._hf, rt = hf.targets[level];
    const w = rt.width >> 1, h = rt.height >> 1;
    const x = (quad & 1) * w, y = (quad >> 1) * h;
    rt.scissor.set(x, y, w, h);
    rt.scissorTest = true;
    const R = NG_HF_SHADOW_R[level];
    this.frame.setComp(NG.CAM, 3, NG_PASS.HF_SHADOW);
    const m = this._march;
    m.ngHSrc.value = hf.heights[level].texture;
    m.ngR.value = R;
    m.ngKey.value.set(keyDir.x, keyDir.y, keyDir.z);
    m.ngMaxDist.value = R * 1.5;
    this.forge.run(rt, MARCH_FRAG, m);
    rt.scissorTest = false;
  }

  /** 文脈の喪失から戻ったとき：合成高さと影を焼き直す（喪失前の RT は dispose せずに手放す） */
  restoreGPU(keyDir) {
    if (!this._hfUniforms) return;
    this._hf = null;
    this._buildHf();
    this.updateHf(keyDir, true);
  }
}
