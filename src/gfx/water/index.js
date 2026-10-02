/* ===========================================================
   water モジュール（ARCHITECTURE §6.2：水面が主役）
   -----------------------------------------------------------
   - 幾何：カメラ中心の入れ子の正方リング（mesh.js）。縦の変位は NG_WAVE_GLSL だけ（CPU の surfaceY と同じ）
   - 細波：生きた周期 FFT 2 カスケード（fft.js、JONSWAP・吹送距離 300m）。LEAN の分散で遠くの粗さ
   - 波紋：解析リング 16（全段）+ 波動方程式のシミュ（high、ripples.js）+ 雨の輪（core の ngRainRings）
   - しぶき：GPU の解析弾道（splash.js）。着水で輪を予約
   - 汀・接触の泡、スネルの窓、平面反射・屈折・GGX の鏡面（surface.glsl.js）
   services.water：addRipple / addSplash / addImpulse / detailTile（addDamper / dampers は core が持つ）
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { ngShaderMaterial } from '../core/extend.js';
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { WATER_VS, WATER_FS, RIPPLES } from './surface.glsl.js';
import { buildRings } from './mesh.js';
import { WaterFFT } from './fft.js';
import { WaterRipples } from './ripples.js';
import { WaterSplashes } from './splash.js';
import { waterTier, WATER_CASCADES, WATER_FFT_LOOP } from './quality.js';

/* 泡のノイズ（周期 1 のタイル）：R = レース状の泡（Worley の縁）、G = 細かい泡粒、B = 低周波のむら */
const FOAM_FRAG = NG_NOISE_GLSL + /* glsl */ `
void main() {
  vec2 p = vUv;
  vec3 w = ngWorley2P(p * 9.0, vec2(9.0));
  vec3 w2 = ngWorley2P(p * 23.0 + 3.1, vec2(23.0));
  float lace = smoothstep(0.02, 0.22, w.y - w.x) * 0.55 + (1.0 - smoothstep(0.0, 0.35, w.x)) * 0.45;
  lace *= 0.6 + 0.4 * ngFbmP(p * 6.0, vec2(6.0), 3);
  float bub = 1.0 - smoothstep(0.05, 0.28, w2.x);
  float lo = ngFbmP(p * 3.0 + 7.7, vec2(3.0), 3);
  gl_FragColor = vec4(lace, bub * (0.5 + 0.5 * lo), lo, 1.0);
}
`;

export class WaterModule extends NgModule {
  static id = 'water';

  constructor(ctx) {
    super(ctx);
    const T = ctx.THREE;
    this._ring = Array.from({ length: RIPPLES }, () => new T.Vector4(0, 0, -1e9, 0));
    this._ringDur = new Array(RIPPLES).fill(1);
    this._next = 0;
    const one = new T.DataTexture(new Uint16Array(4), 1, 1, T.RGBAFormat, T.HalfFloatType);
    one.needsUpdate = true;
    this._blank = one;
    this.uniforms = {
      uSnap: { value: new T.Vector2() }, uTime: { value: 0 }, uWind: { value: 1 },
      uRipple: { value: Array.from({ length: RIPPLES }, () => new T.Vector4()) }, uRippleDur: { value: new Array(RIPPLES).fill(1) },
      uRippleN: { value: 0 },
      uFft0: { value: one }, uFft1: { value: one }, uFftL: { value: new T.Vector2(WATER_CASCADES[0].L, WATER_CASCADES[1].L) },
      uSim: { value: one }, uSimXf: { value: new T.Vector4(0, 0, 1, 0) },
      uFoam: { value: one },
      uTierW: { value: new T.Vector4(0, 4, 800, 0.0012) },
      uLampPos: { value: new T.Vector3(0, -1000, 0) },
      uDbg: { value: new T.Vector4(0, 0, 0, 0) },
      uLakeBox: { value: new T.Vector4(-600, -600, 600, 600) },
      uViewProj: { value: new T.Matrix4() },
      ngSkyViewTex: { value: null }, ngSkyViewMips: { value: 6 },
    };
    this.mesh = null;
    this.material = null;
    this._gridKey = '';
    this.tier = ctx.tier || 'mid';
    this.fft = new WaterFFT(ctx);
    this.ripples = null;
    this.splashes = null;
    this.foamTex = null;
    this._lastT = 0;
    this._frameT = 0;
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE;
    const q = waterTier(this.tier);
    /* 湖を囲む箱：汀線の最大半径 + 12m（外の頂点は箱の縁へ寄せて三角形を潰す） */
    let R = 0;
    for (let i = 0; i < 360; i++) {
      const r = ctx.lake?.shoreAtAngle?.((i / 360) * Math.PI * 2);
      if (Number.isFinite(r)) R = Math.max(R, r);
    }
    R = R > 0 ? R + 12 : 600;
    this.uniforms.uLakeBox.value.set(-R, -R, R, R);
    await this.fft.build(q.fftN, q.aniso);
    this._bindFft();
    progress?.(0.4);
    this.foamTex = ctx.forge.bake2D({ w: 512, h: 512, frag: FOAM_FRAG, mips: true, wrap: 'repeat', type: T.UnsignedByteType });
    this.foamTex.anisotropy = 4;
    this.uniforms.uFoam.value = this.foamTex;
    await ctx.forge.step();
    progress?.(0.6);
    this.material = ngShaderMaterial({
      key: 'water-surface', module: 'water',
      uniforms: { ...this.uniforms, ...ctx.heightfield?.uniforms, ...ctx.shadows.uniforms, ...ctx.pipeline.uniforms },
      vertexShader: WATER_VS, fragmentShader: WATER_FS,
      side: T.DoubleSide, blending: T.NoBlending, depthWrite: true,
    });
    this.material.extensions = { ...(this.material.extensions || {}), derivatives: true };
    this._rebuild(this.tier);
    this.ripples = new WaterRipples(ctx, this);
    this.splashes = new WaterSplashes(ctx, this);
    await this.splashes.init();
    this.root.add(this.splashes.mesh);
    this._applyTier(this.tier, ctx.profile);
    ngOwn(this.root, NG_LAYER.WATER);
    if (this.splashes.mesh) ngOwn(this.splashes.mesh, NG_LAYER.LATE_FX);
    ctx.scene.add(this.root);
    ctx.services.provide('water', {
      addRipple: (x, z, size = 1, dur = 1.6) => this.addRipple(x, z, size, dur),
      addSplash: (x, y, z, count = 14, power = 1) => this.splashes?.add(x, y, z, count, power),
      addImpulse: (x, z, amp) => this.ripples?.impulse(x, z, amp),
      detailTile: null,
    });
    /* debug 表示：細波のカスケード（左 = 細かい、右 = 粗い。rgb = 勾配 x・z・分散）と波紋シミュ */
    ctx.services.post.registerDebugView('water-fft', /* glsl */ `
uniform sampler2D uDbgFft0;
uniform sampler2D uDbgFft1;
uniform sampler2D uDbgSim;
vec4 ngDebug(vec2 uv) {
  if (uv.y < 0.5) { float h = texture(uDbgSim, uv * vec2(1.0, 2.0)).r; return vec4(vec3(0.5 + h * 80.0), 1.0); }
  vec2 q = vec2(fract(uv.x * 2.0), uv.y * 2.0 - 1.0);
  vec4 f = uv.x < 0.5 ? texture(uDbgFft0, q) : texture(uDbgFft1, q);
  return vec4(0.5 + f.xy * 1.5, f.z * 8.0, 1.0);
}`, { uDbgFft0: this.uniforms.uFft0, uDbgFft1: this.uniforms.uFft1, uDbgSim: this.uniforms.uSim });
    progress?.(1);
  }

  _rebuild(tier) {
    const T = this.ctx.THREE;
    const q = waterTier(tier);
    const key = `${q.gridN}:${q.rings}`;
    if (key === this._gridKey && this.mesh) return;
    this._gridKey = key;
    this._cell = 32 / q.gridN;
    const g = buildRings(T, q.gridN, this._cell, q.rings);
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.geometry = g; return; }
    this.mesh = new T.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ng-water-surface';
    this.root.add(this.mesh);
  }

  _applyTier(tier, profile) {
    const q = waterTier(tier);
    const u = this.uniforms;
    const rp = profile?.reflection || { scale: 0.5, mips: 4 };
    u.uTierW.value.x = q.glints;
    u.uTierW.value.y = Math.max(0, (rp.mips ?? 4) - 1);
    /* 反射 RT の «1 ラジアンあたりの px»（縦の画角 ≈ 1 rad として、RT の高さ）。mip の段の選択に使う */
    const h = this.ctx.pipeline?.targets?.refl?.height || 720 * (rp.scale || 0.5);
    u.uTierW.value.z = h;
    this.ripples?.setTier(q);
    this.splashes?.setTier(q);
  }

  /** 波紋の予約（リングバッファ。NaN や範囲外は捨てる。投げない） */
  addRipple(x, z, size = 1, dur = 1.6) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(size > 0) || !(dur > 0)) return;
    const s = Math.min(size, 6), d = Math.min(dur, 8);
    const k = this._next;
    this._next = (k + 1) % RIPPLES;
    this._ring[k].set(x, z, this.uniforms.uTime.value, s);
    this._ringDur[k] = d;
    this.ripples?.impulse(x, z, 0.004 * s);
  }

  _packRipples(t) {
    const u = this.uniforms, dst = u.uRipple.value, dur = u.uRippleDur.value;
    let n = 0;
    for (let k = 0; k < RIPPLES; k++) {
      const R = this._ring[k], age = t - R.z;
      if (R.w <= 0 || age < 0 || age > this._ringDur[k]) continue;
      dst[n].copy(R);
      dur[n] = this._ringDur[k];
      n++;
    }
    u.uRippleN.value = n;
  }

  update(f) {
    const u = this.uniforms;
    u.ngSkyViewTex.value = this.ctx.services.sky.skyViewTex;
    u.ngSkyViewMips.value = this.ctx.services.sky.skyViewMips || 0;
    this.splashes?.update(f);
  }

  /* 水の時刻と風は gfx.waterUpdate（updateModules の後）が書く。描く直前の prepare で受ける（CPU の surfaceY と同じフレームの波） */
  prepare(f) {
    const u = this.uniforms;
    const t = Number.isFinite(f.waterTime) ? f.waterTime : 0;
    u.uTime.value = t;
    u.uWind.value = Number.isFinite(f.waterWind) ? f.waterWind : 1;
    this._packRipples(t);
    const c = f.camera?.position;
    if (c) {
      const s = this._cell || 0.25;
      u.uSnap.value.set(Math.round(c.x / s) * s, Math.round(c.z / s) * s);
    }
    this.fft.run(t);
    const lamp = this.ctx.gfx?.rig?.lamp;
    if (lamp) lamp.getWorldPosition(u.uLampPos.value);
    this.ripples?.step(f);
    this.splashes?.prepare(f);
  }

  beforePass(passId, camera) {
    if (passId === 0 && camera) {
      camera.updateMatrixWorld?.();
      this.uniforms.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const sh = this.ctx.pipeline?.uniforms?.ngScreen?.value?.y || 720;
      const p11 = camera.projectionMatrix.elements[5];
      this.uniforms.uTierW.value.w = Number.isFinite(p11) && p11 > 0 ? 2 / (p11 * sh) : 0.0012;
    }
  }

  setQuality(tier, profile) {
    this.tier = tier;
    const q = waterTier(tier);
    if (this.mesh) this._rebuild(tier);
    if (this.fft.N !== q.fftN) {
      this.fft.build(q.fftN, q.aniso).then(() => this._bindFft());
    }
    this._applyTier(tier, profile);
  }

  _bindFft() {
    this.uniforms.uFft0.value = this.fft.tex(0) || this._blank;
    this.uniforms.uFft1.value = this.fft.tex(1) || this._blank;
  }

  restoreGPU() {
    this.fft.lastTau = -1;
    this.ripples?.reset();
  }

  stats() {
    const g = this.mesh?.geometry;
    const sp = this.splashes?.stats() || { draws: 0, tris: 0, instances: 0 };
    return {
      draws: 1 + 5 + (this.ripples?.draws || 0) + sp.draws,
      tris: (g ? g.index.count / 3 : 0) + sp.tris,
      instances: sp.instances,
      texBytes: this.fft.texBytes() + 512 * 512 * 4 * 1.34 + (this.ripples?.texBytes() || 0),
      programs: 2 + (this.ripples?.programs || 0) + (sp.programs || 0),
    };
  }

  dispose() {
    this.fft.dispose();
    this.ripples?.dispose();
    this.splashes?.dispose();
    this.material?.dispose();
    this._blank.dispose();
    super.dispose();
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new WaterModule(ctx); }

export { WATER_FFT_LOOP };
