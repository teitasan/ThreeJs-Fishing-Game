/* ===========================================================
   underwater モジュール（ARCHITECTURE §6.3：caustics・水の光学・水中の見た目）
   -----------------------------------------------------------
   - caustics：周期的な細かい波の場のヘッセ行列を時刻のフレームで焼き（bake.js / spectrum.js）、
     uCaustTex（常に同じ DataArrayTexture）へ差し込む。読む側は CAUSTICS_GLSL（caustics.glsl.js。
     ホストのマテリアル・本物の魚・remoteFish が共有）。水上の予算は 0（caustics はホストのマテリアルに含む）
   - 光学：σa/σs/内散乱/濁り（optics.js）を ngFrame slot 9・10 と services.underwater.optics へ
   - getUnderwaterContext：旧 Water と同じ形（同じオブジェクトを書き換えて返す）
   - 水中の Effect（effect.js）：光柱（近景の影で切れる）・距離のぼけ・ウォーターラインのメニスカス
   - プランクトン / マリンスノー（plankton.js）
   失敗の扱い：init が投げたら core がスタブで立て直す。フレーム中は投げない（NaN は捨てる）。
   無効化・作り直しで dispose されたら caustics を旧式（スタブの網目）の読み方へ戻す
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG } from '../core/frame.js';
import { waveHeight, shoalGain } from '../../waveField.js?v=20260828-lakescale1';
import { bakeCaustics } from './bake.js';
import { waterOptics, UW_SIGMA_A } from './optics.js';
import { uwTier } from './quality.js';
import { UnderwaterFx } from './effect.js';
import { Plankton } from './plankton.js';

/** caustics の静的な uniform（本番の読み方。CAUSTICS_GLSL の頭書き） */
const CAUST_STATIC = Object.freeze({
  period: 7.0, eps: 0.12,
  range: [0.22, 0.30],      // (暗くする係数 A_d, 明線の係数 A_b)：公称のアルベドに相当
  depth: [0.05, 0.45],      // 浅瀬のフェード
  dist: [42, 95],           // 視距離のフェード（mip が遠くのエイリアスを抑える）
});

export class UnderwaterModule extends NgModule {
  static id = 'underwater';

  constructor(ctx) {
    super(ctx);
    const T = ctx.THREE;
    this.tier = ctx.tier || 'mid';
    this.q = uwTier(this.tier);
    this.optics = { sigmaA: new T.Vector3(...UW_SIGMA_A), sigmaS: 0.03, insc: new T.Vector3() };
    this._ctx = {
      strength: 0, time: 0, sunDir: new T.Vector3(0, 1, 0), night: 0, rain: 0, cloud: 0,
      absorb: new T.Vector3(...UW_SIGMA_A), camPos: new T.Vector3(), camNear: 0.1, camFar: 3000, waterY: 0,
    };
    this._st = {
      uw: 0, waterY: 0, time: 0, keyE: new T.Vector3(), lw: new T.Vector3(0, 1, 0), cs: new T.Vector4(),
      menD: new T.Vector4(1, 1, 1, 1), menOn: false, fog: new T.Vector3(), sigT: new T.Vector3(), kd: new T.Vector3(),
    };
    this.bakeInfo = null;
    this._baking = null;
    this._bakedKey = '';
    this.fx = null;
    this.plankton = null;
    this._v = new T.Vector3();
    this._corners = [new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3()];
  }

  async init(progress) {
    const ctx = this.ctx;
    await this._bake(this.q);
    progress?.(0.6);
    this._setStaticUniforms();
    this.plankton = new Plankton(ctx, this.root, ctx.lake?.seed ?? 1);
    this.plankton.setCount(this.q.plankton);
    this.fx = new UnderwaterFx(ctx, this);
    ctx.services.post.registerDebugView('underwater-rays', /* glsl */ `
      uniform sampler2D tNgUwRaysDbg;
      vec4 ngDebug(vec2 uv) { vec4 r = texture(tNgUwRaysDbg, uv); return vec4(clamp(0.5 + r.rgb * 2.0, 0.0, 1.0), 1.0); }`,
    { tNgUwRaysDbg: { value: this.fx.rt.texture } });
    ctx.scene.add(this.root);
    ctx.services.provide('underwater', {
      getUnderwaterContext: (camera) => this.getUnderwaterContext(camera),
      createEffect: () => this.fx?.effect || null,
      optics: this.optics,
    });
    progress?.(1);
  }

  /* 段の表のタイルを焼く（同じ大きさなら焼き直さない） */
  async _bake(q) {
    const key = `${q.tile}x${q.frames}`;
    if (key === this._bakedKey && this.bakeInfo) return;
    const info = await bakeCaustics(this.ctx, q, { seed: this.ctx.lake?.seed, period: CAUST_STATIC.period, eps: CAUST_STATIC.eps });
    this.bakeInfo = info;
    this._bakedKey = key;
    this._setStaticUniforms();
  }

  _setStaticUniforms() {
    const cu = this.ctx.caustics, info = this.bakeInfo;
    if (!cu || !info) return;
    cu.uCaustScale.value.set(1 / info.spectrum.period, info.spectrum.hScale);
    cu.uCaustShape.value.set(2, CAUST_STATIC.eps);
    cu.uCaustRange.value.set(CAUST_STATIC.range[0], CAUST_STATIC.range[1]);
    cu.uCaustDepth.value.set(CAUST_STATIC.depth[0], CAUST_STATIC.depth[1]);
    cu.uCaustDist.value.set(CAUST_STATIC.dist[0], CAUST_STATIC.dist[1]);
    cu.uCaustMag.value = info.meanC;
  }

  setQuality(tier) {
    this.tier = tier;
    this.q = uwTier(tier);
    this.plankton?.setCount(this.q.plankton);
    const key = `${this.q.tile}x${this.q.frames}`;
    if (key !== this._bakedKey && !this._baking) {
      /* フレームの外で焼き直す（失敗しても前のタイルのまま） */
      this._baking = this._bake(this.q).catch((e) => this.ctx.log('underwater-bake', 'caustics の焼き直しに失敗（前のタイルのまま）', e))
        .finally(() => { this._baking = null; if (`${this.q.tile}x${this.q.frames}` !== this._bakedKey) this.setQuality(this.tier); });
    }
  }

  restoreGPU() {
    this._bakedKey = '';
    this._baking = this._bake(this.q).catch((e) => this.ctx.log('underwater-bake', 'caustics の焼き直しに失敗', e)).finally(() => { this._baking = null; });
  }

  /**
   * Water.update の中から（core の gfx.waterUpdate、§2.1 の 5）。光学と caustics の動く値
   * @param {object} f
   */
  waterUpdate(f) {
    const frame = this.ctx.frame, F = frame.data;
    const rain = fin(f.weather?.rain), cloud = fin(f.weather?.cloud);
    const ky = F[NG.KEY * 4 + 1];
    const op = waterOptics({ rain, cloud, keyRad: [F[NG.KEYRAD * 4], F[NG.KEYRAD * 4 + 1], F[NG.KEYRAD * 4 + 2]], keyY: ky, skyIrr: [F[NG.AMB * 4], F[NG.AMB * 4 + 1], F[NG.AMB * 4 + 2]] });
    this._op = op;
    frame.set(NG.W_SIGMA, op.sigmaA[0], op.sigmaA[1], op.sigmaA[2], op.sigmaS);
    frame.set(NG.W_INSC, op.insc[0], op.insc[1], op.insc[2], op.turbidity);
    this.optics.sigmaA.set(op.sigmaA[0], op.sigmaA[1], op.sigmaA[2]);
    this.optics.sigmaS = op.sigmaS;
    this.optics.insc.set(op.insc[0], op.insc[1], op.insc[2]);
    const cu = this.ctx.caustics;
    if (cu) {
      const strength = this.ctx.gfx?.quality.profile.causticsStrength ?? 0.7;
      cu.uCaustTime.value = fin(f.waterTime);
      cu.uCaustSunDir.value.set(F[NG.KEY * 4], F[NG.KEY * 4 + 1], F[NG.KEY * 4 + 2]);
      cu.uCaustNight.value = F[NG.KEY * 4 + 3];
      cu.uCaustRain.value = rain;
      cu.uCaustCloud.value = cloud;
      cu.uCaustStrength.value = this.bakeInfo ? strength : 0;
      /* key の水平面の放射照度（Fresnel の透過込み）。caustics の E。ky で割って «光に垂直な面» の値へ */
      const inv = 1 / Math.max(ky, 0.08);
      cu.uCaustMixW.value.set(op.keyE[0] * inv, op.keyE[1] * inv, op.keyE[2] * inv);
    }
  }

  /** P1（水の値はここで）。水中の Effect と粒 */
  prepare(f) {
    const st = this._st, F = this.ctx.frame.data, cam = f.camera;
    if (!cam) return;
    const op = this._op;
    st.uw = this.ctx.frame.cam.uw;
    st.waterY = this.ctx.frame.cam.waterY;
    st.time = fin(f.waterTime);
    const ky = F[NG.KEY * 4 + 1];
    if (op) {
      st.keyE.set(op.keyE[0], op.keyE[1], op.keyE[2]).multiplyScalar(1 / Math.max(ky, 0.08));
      st.fog.set(op.insc[0], op.insc[1], op.insc[2]);
      st.sigT.set(op.sigmaA[0] + op.sigmaS, op.sigmaA[1] + op.sigmaS, op.sigmaA[2] + op.sigmaS);
      st.kd.set(op.sigmaA[0] + 0.3 * op.sigmaS, op.sigmaA[1] + 0.3 * op.sigmaS, op.sigmaA[2] + 0.3 * op.sigmaS);
    }
    /* 水中の key の向き（スネル）：水平成分を 1/n に */
    const kx = F[NG.KEY * 4], kz = F[NG.KEY * 4 + 2];
    const kyc = Math.max(ky, 0.08), sa = Math.sqrt(Math.max(0, 1 - kyc * kyc)), sw = sa / 1.333, cw = Math.sqrt(1 - sw * sw);
    const hl = Math.hypot(kx, kz) || 1;
    st.lw.set((kx / hl) * sw, cw, (kz / hl) * sw);
    const info = this.bakeInfo;
    st.cs.set(info ? 1 / info.spectrum.period : 1 / 7, info ? info.spectrum.hScale : 0, info ? info.meanC : 0, st.time);
    this._meniscus(f, cam);
    if (this.fx) {
      const hPx = this.ctx.pipeline.uniforms.ngScreen?.value?.y || 1080, k = hPx / 1080;
      const q = this.q;
      this._fq = this._fq || {};
      Object.assign(this._fq, { shaftSteps: q.shaftSteps, shaftScale: q.shaftScale, blurPx: q.blurPx * k, menBand: q.menBand * k });
      this.fx.setFrame(f, this._fq, st);
    }
    this.plankton?.update(f, st);
  }

  /* 近平面の 4 隅の «水面からの高さ»（waveField の水面）。カメラが水面から 0.35m 以内のときだけ線を引く */
  _meniscus(f, cam) {
    const st = this._st;
    const lake = this.ctx.lake;
    const wy = st.waterY;
    const near = cam.near ?? 0.1;
    const camH = cam.position.y - wy;
    st.menOn = cam.isPerspectiveCamera && Math.abs(camH) < 0.35 && (lake ? lake.depthAt(cam.position.x, cam.position.z) > 0 : true);
    if (!st.menOn) { st.menD.set(1, 1, 1, 1); return; }
    cam.updateMatrixWorld();
    const th = Math.tan((cam.fov * Math.PI) / 360) / (cam.zoom || 1), a = cam.aspect;
    const c = this._corners, d = [0, 0, 0, 0];
    const xy = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    const t = fin(f.waterTime), wind = Number.isFinite(f.waterWind) ? f.waterWind : 1;
    for (let i = 0; i < 4; i++) {
      c[i].set(xy[i][0] * th * a * near, xy[i][1] * th * near, -near).applyMatrix4(cam.matrixWorld);
      const dep = lake ? lake.depthAt(c[i].x, c[i].z) : 10;
      const s = dep <= 0 ? 0 : waveHeight(c[i].x, c[i].z, t, wind) * shoalGain(dep);
      d[i] = c[i].y - s;
      if (!Number.isFinite(d[i])) d[i] = 1;
    }
    st.menD.set(d[0], d[1], d[2], d[3]);
    /* 線が画面に無い（4 隅が同じ側）なら引かない */
    const pos = d.filter((v) => v > 0).length;
    if (pos === 0 || pos === 4) st.menOn = false;
  }

  /**
   * 旧 Water.getUnderwaterContext と同じ形（同じオブジェクトを書き換えて返す）
   * @param {import('three').Camera} camera
   */
  getUnderwaterContext(camera) {
    const F = this.ctx.frame.data, c = this._ctx, f = this.ctx.gfx?.f;
    c.strength = this.ctx.frame.cam.uw;
    c.time = f?.waterTime ?? 0;
    c.sunDir.set(F[NG.KEY * 4], F[NG.KEY * 4 + 1], F[NG.KEY * 4 + 2]);
    c.night = F[NG.KEY * 4 + 3];
    c.rain = f?.weather?.rain ?? 0;
    c.cloud = f?.weather?.cloud ?? 0;
    c.absorb.copy(this.optics.sigmaA);
    if (camera) { c.camPos.copy(camera.position); c.camNear = camera.near ?? 0.1; c.camFar = camera.far ?? 3000; }
    c.waterY = this.ctx.frame.cam.waterY;
    return c;
  }

  stats() {
    const n = this.plankton?.points.visible ? this.plankton.count : 0;
    const raysOn = !!this.fx?.raysOn;
    return {
      draws: (n ? 1 : 0) + (raysOn ? 1 : 0), tris: raysOn ? 1 : 0, instances: n,
      texBytes: (this.bakeInfo?.bytes || 0) + (this.fx ? this.fx.rt.width * this.fx.rt.height * 8 : 0),
      programs: 2, bakeMs: this.bakeInfo ? +this.bakeInfo.ms.toFixed(1) : null, uwActive: !!this.fx?.active,
    };
  }

  dispose() {
    /* スタブが立て直すときは旧式の網目を焼くので、読み方を旧式へ戻す（既定値。shaders.js の createCausticsUniforms） */
    const cu = this.ctx.caustics;
    if (cu) {
      cu.uCaustScale.value.set(0.105, 0.166); cu.uCaustShape.value.set(1.0, 1.4); cu.uCaustRange.value.set(1.3, 0.22);
      cu.uCaustDepth.value.set(0.07, 0.60); cu.uCaustDist.value.set(28, 60); cu.uCaustMag.value = 0.18; cu.uCaustMixW.value.set(1, 0.5, 0);
    }
    this.fx?.dispose();
    this.plankton?.dispose();
    super.dispose();
  }
}

function fin(v) { return Number.isFinite(v) ? v : 0; }

/** @param {object} ctx */
export function createModule(ctx) { return new UnderwaterModule(ctx); }
