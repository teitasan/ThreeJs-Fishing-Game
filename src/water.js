/* ===========================================================
   Water ファサード：波の物理と、水の描画への受け口
   -----------------------------------------------------------
   水面の «見た目» は src/gfx の water / underwater モジュールが描く。ここは
   ゲームと約束した値（契約 §4.3）だけを持つ：
     - surfaceY / surfaceNormal：旧 water.js:1013-1022 と同じ式（waveField.js が唯一の定義）。
       GPU は waveGLSL({prefix:'ng'}) の同じ式で «縦の変位だけ» を出すので、ウキと絵が一致する
     - update：time += dt（ポーズで止まる）、wind = 1 + rain·0.92 + cloud·0.14
     - addRipple / addSplash：25 か所以上から呼ばれる。リングバッファで «絶対に投げない»
     - capture → pipeline.prepare、captureReflection → pipeline.renderReflection（冪等）
     - getUnderwaterContext：旧形のオブジェクト
     - uniforms.uLinearOut / uShallow / uDeep、causticsUniforms（同じ参照のまま）、rt / reflRT
   =========================================================== */
import * as THREE from 'three';
import {
  WAVES, MAX_WAVE_AMP, waveHeight, waveSlope, waveDisplace, shoreRunUp, shoalGain,
  wavePhaseOffset, wavePhaseOffsetGrad,
} from './waveField.js?v=20260828-lakescale1';
import { getGfx } from './gfx/core/index.js';

/* 波の定義そのものは waveField.js にある。従来の import 経路を壊さないよう再輸出する */
export {
  WAVES, MAX_WAVE_AMP, waveHeight, waveSlope, waveDisplace, shoreRunUp, shoalGain,
  wavePhaseOffset, wavePhaseOffsetGrad,
};

/** 波の法線（解析微分）。旧 water.js と同じ */
export function waveNormal(x, z, t, wind = 1, out = new THREE.Vector3()) {
  const s = waveSlope(x, z, t, wind);
  return out.set(-s.dx, 1, -s.dz).normalize();
}

/** game.js が作る causticsUniforms の 16 名（無いときの代わりもこの形にする） */
export const CAUSTICS_UNIFORM_NAMES = [
  'uCaustTex', 'uCaustScale', 'uCaustShape', 'uCaustRange', 'uCaustDepth', 'uCaustDist', 'uCaustFar',
  'uCaustWarp', 'uCaustMag', 'uCaustMixW', 'uCaustTime', 'uCaustSunDir', 'uCaustNight', 'uCaustRain',
  'uCaustCloud', 'uCaustStrength',
];

function fallbackCausticsUniforms() {
  return {
    uCaustTex: { value: null },
    uCaustScale: { value: new THREE.Vector2(0.105, 0.166) },
    uCaustShape: { value: new THREE.Vector2(1.0, 1.4) },
    uCaustRange: { value: new THREE.Vector2(1.3, 0.22) },
    uCaustDepth: { value: new THREE.Vector2(0.07, 0.60) },
    uCaustDist: { value: new THREE.Vector2(28.0, 60.0) },
    uCaustFar: { value: new THREE.Vector2(6.0, 20.0) },
    uCaustWarp: { value: new THREE.Vector2(1.15, 2.5) },
    uCaustMag: { value: 0.18 },
    uCaustMixW: { value: new THREE.Vector3(1.0, 0.5, 0.0) },
    uCaustTime: { value: 0 },
    uCaustSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uCaustNight: { value: 0 },
    uCaustRain: { value: 0 },
    uCaustCloud: { value: 0 },
    uCaustStrength: { value: 0 },
  };
}

const RIPPLE_N = 32;
const SPLASH_N = 64;
const fin = Number.isFinite;

const warned = new Set();
function warnOnce(tag, e) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[water] ${tag}`, e);
}

export class Water {
  constructor(scene, terrain, opts = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.time = 0;
    this.wind = 1;
    this.quality = opts.quality || 'mid';
    this.skyUniforms = opts.skyUniforms || null;
    this._underwaterView = false;
    this._keyDir = new THREE.Vector3(0, 1, 0);
    this._cloud = 0;
    this._extraHidden = [];
    this._reflectionHidden = [];

    /* 旧版の uniform 名の互換。uLinearOut は構築直後から 1（シーンはリニア HDR） */
    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: 1 },
      uNight: { value: 0 },
      uRain: { value: 0 },
      uShallow: { value: new THREE.Color(0x40907e) },
      uDeep: { value: new THREE.Color(0x0a2740) },
      /* 水の吸収係数 σa（1/m）。getUnderwaterContext の absorb はこの参照 */
      uAbsorb: { value: new THREE.Vector3(0.20, 0.075, 0.045) },
      uExposure: { value: opts.exposure ?? 1.0 },
      uLinearOut: { value: 1 },
    };

    /* 湖底・魚・水中の物が共有する。FishSchool より前に作られ、以後は同じ参照のまま */
    this.causticsUniforms = opts.causticsUniforms || fallbackCausticsUniforms();

    /* 波紋・しぶきの予約（描くのは water モジュール。ここは «受け取って捨てない» だけ） */
    this.ripples = Array.from({ length: RIPPLE_N }, () => ({ x: 0, z: 0, size: 1, dur: 1, life: 1, alive: false }));
    this._rippleIdx = 0;
    this.splashes = Array.from({ length: SPLASH_N }, () => ({ x: 0, y: 0, z: 0, count: 0, power: 1, life: 0, alive: false }));
    this._splashIdx = 0;
  }

  /** core（無ければ null）。Environment の構築時に作られている */
  get gfx() {
    try { return getGfx() || null; } catch (e) { return null; }
  }

  /** 屈折用のシーンのコピー（sceneColor）。performance.js の RT 見積もりが読む */
  get rt() {
    const p = this.gfx?.pipeline;
    return p?.targets?.copy || p?.targets?.sceneColor || null;
  }

  /** 平面反射の RT（反射を描かない品質・水中では null のこともある） */
  get reflRT() {
    const p = this.gfx?.pipeline;
    return p?.targets?.refl || p?.targets?.reflection || null;
  }

  /* ---------------- CPU 側のサンプリング（ゲームの物理） ---------------- */
  surfaceY(x, z) {
    const depth = this.terrain.depthAt(x, z);
    if (depth <= 0) return 0;
    // GPU 側と同じ浅水変形込みの係数を使う（ウキが波とずれないように）
    return waveHeight(x, z, this.time, this.wind) * shoalGain(depth);
  }

  surfaceNormal(x, z, out) {
    const depth = this.terrain.depthAt(x, z);
    return waveNormal(x, z, this.time, this.wind * (depth <= 0 ? 0 : shoalGain(depth)), out);
  }

  /** 渚の遡上量（m）。旧版と同じ */
  shoreRunUpAt(x, z) {
    return shoreRunUp(x, z, this.time, this.wind);
  }

  /* ---------------- 波紋・しぶき（絶対に投げない） ---------------- */
  addRipple(x, z, size = 1, dur = 1.6) {
    try {
      if (!fin(x) || !fin(z)) return;
      const s = fin(size) ? Math.min(Math.max(size, 0.01), 50) : 1;
      const d = fin(dur) && dur > 0 ? Math.min(dur, 30) : 1.6;
      const r = this.ripples[this._rippleIdx++ % RIPPLE_N];
      if (this._rippleIdx > 1e9) this._rippleIdx = 0;
      r.x = x; r.z = z; r.size = s; r.dur = d; r.life = 0; r.alive = true;
      this.gfx?.services?.water?.addRipple?.(x, z, s, d);
    } catch (e) { warnOnce('addRipple', e); }
  }

  addSplash(x, y, z, count = 14, power = 1) {
    try {
      if (!fin(x) || !fin(y) || !fin(z)) return;
      const n = fin(count) ? Math.max(0, Math.min(Math.round(count), 256)) : 14;
      const p = fin(power) ? Math.min(Math.max(power, 0), 20) : 1;
      if (n === 0) return;
      const s = this.splashes[this._splashIdx++ % SPLASH_N];
      if (this._splashIdx > 1e9) this._splashIdx = 0;
      s.x = x; s.y = y; s.z = z; s.count = n; s.power = p; s.life = 0; s.alive = true;
      this.gfx?.services?.water?.addSplash?.(x, y, z, n, p);
    } catch (e) { warnOnce('addSplash', e); }
  }

  /* ---------------- 描画への受け口 ---------------- */
  /** 水越しの絵から外すもの。1 回描画のパイプラインでは不要だが、互換で持っておく */
  setCaptureHidden(list) {
    this._extraHidden = (list || []).filter(Boolean);
  }

  /** 平面反射だけから外すもの */
  setReflectionHidden(list) {
    this._reflectionHidden = (list || []).filter(Boolean);
    try { this.gfx?.setReflectionHidden?.(this._reflectionHidden); } catch (e) { warnOnce('setReflectionHidden', e); }
  }

  /** 影の更新と各モジュールの準備（P1/P2）。同じフレームで 2 回呼ばれても安全 */
  capture(renderer, scene, camera) {
    try { this.gfx?.pipeline?.prepare?.(renderer, scene, camera); } catch (e) { warnOnce('capture', e); }
  }

  /** 平面反射（P3） */
  captureReflection(renderer, scene, camera) {
    try { this.gfx?.pipeline?.renderReflection?.(renderer, scene, camera); } catch (e) { warnOnce('captureReflection', e); }
  }

  setUnderwaterView(on) {
    this._underwaterView = !!on;
    try { this.gfx?.setUnderwater?.(this._underwaterView); } catch (e) { warnOnce('setUnderwater', e); }
  }

  /** 旧形：{ strength, time, sunDir, night, rain, cloud, absorb, camPos, camNear, camFar, waterY } */
  getUnderwaterContext(camera) {
    const base = {
      strength: this._underwaterView ? 1 : 0,
      time: this.time,
      // 光の柱と散乱ゲートは «いま照らしている光» の向き（夜は月）
      sunDir: this._keyDir,
      night: this.uniforms.uNight.value,
      rain: this.uniforms.uRain.value,
      cloud: this._cloud,
      absorb: this.uniforms.uAbsorb.value,
      camPos: camera.position,
      camNear: camera.near,
      camFar: camera.far,
      waterY: this.surfaceY(camera.position.x, camera.position.z),
    };
    let ext = null;
    try { ext = this.gfx?.getUnderwaterContext?.(camera) || null; } catch (e) { warnOnce('getUnderwaterContext', e); }
    if (!ext) return base;
    /* core の値を優先するが、欠けたキーと数値でない値は旧形で埋める */
    for (const k of Object.keys(base)) {
      const v = ext[k];
      if (v !== undefined && v !== null && !(typeof v === 'number' && !fin(v))) base[k] = v;
    }
    return base;
  }

  setQuality(q) {
    this.quality = q;
    try { this.gfx?.setQuality?.(q); } catch (e) { warnOnce('setQuality', e); }
  }

  /* ---------------- 更新 ---------------- */
  update(dt, camera, env) {
    this.time += dt;
    const u = this.uniforms;
    u.uTime.value = this.time;
    this.wind = 1 + env.rainIntensity * 0.92 + env.cloudiness * 0.14;
    u.uWind.value = this.wind;
    this._keyDir = env.keyDir;
    this._cloud = env.cloudiness;
    u.uNight.value = env.nightAmount;
    u.uRain.value = env.rainIntensity;
    /* 旧版と同じ 6 つの動的な値をまず書く（underwater モジュールが居れば上書きする） */
    const cu = this.causticsUniforms;
    try {
      cu.uCaustTime.value = this.time;
      cu.uCaustSunDir.value.copy(env.keyDir);
      cu.uCaustNight.value = env.nightAmount;
      cu.uCaustRain.value = env.rainIntensity;
      cu.uCaustCloud.value = env.cloudiness;
      cu.uCaustStrength.value = this.quality === 'high' ? 1.0 : this.quality === 'low' ? 0.32 : 0.72;
    } catch (e) { warnOnce('causticsUniforms', e); }
    if (camera) camera.updateMatrixWorld();

    // 予約の寿命（描画はモジュール側。ここは «生きているか» だけ）
    for (const r of this.ripples) {
      if (!r.alive) continue;
      r.life += dt;
      if (r.life >= r.dur) r.alive = false;
    }
    for (const s of this.splashes) {
      if (!s.alive) continue;
      s.life += dt;
      if (s.life >= 1.2) s.alive = false;
    }

    try { this.gfx?.waterUpdate?.({ sdt: dt, time: this.time, wind: this.wind, camera }); } catch (e) { warnOnce('waterUpdate', e); }
  }
}
