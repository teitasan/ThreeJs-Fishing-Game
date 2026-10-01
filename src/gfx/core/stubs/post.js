/* ===========================================================
   post のグレーボックス（本番の代替も兼ねる）
   -----------------------------------------------------------
   最小の鎖（ARCHITECTURE §5.3）：NaN 除去 → 露出（§2 の時刻表）→ AgX → ブルーノイズのディザ
   → SMAA（mid）/ FXAA（low）。high は MSAA なので AA パスなし。
   - トーンマップと sRGB 変換は最後に 1 回だけ（renderer は NoToneMapping）
   - ディザは sRGB の空間で ±0.5 LSB（線形で足すと暗部で数 LSB に化ける）
   - 露出は純関数。水中の係数だけ λ = 1.5/s で damp（撮影 __gfxCapture では即時）。
     画面の輝度による順応（±1EV）は本番の post モジュールの仕事（ここでは 1）
   - 動的解像度：DrsController（__gfxCapture のときは 1.0 固定）
   - 水中の後処理：services.underwater.createEffect() の Effect を鎖の «先頭» に差し込む（露出前の HDR のリニア放射輝度、
     depthTexture = targets.main.depthTexture、mainCamera = gfx.camera）。services.underwater のオブジェクトが
     差し替わったら（provide・無効化・立て直し）引き直す。Effect は underwater の物（post は dispose しない）
   =========================================================== */
import { EffectPass, Effect, ToneMappingEffect, ToneMappingMode, SMAAEffect, FXAAEffect } from 'postprocessing';
import { NgModule } from '../module.js';
import { NG } from '../frame.js';
import { DrsController } from '../quality.js';
import { ngScheduledExposure } from '../palette.js';

const EXPOSURE_FS = /* glsl */ `
uniform float exposure;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  bvec3 bad = bvec3(c.r != c.r || c.r > 65000.0, c.g != c.g || c.g > 65000.0, c.b != c.b || c.b > 65000.0);
  c = any(bad) ? vec3(0.0) : max(c, vec3(0.0));
  outputColor = vec4(c * exposure, inputColor.a);
}
`;
const DITHER_FS = /* glsl */ `
uniform sampler2D blueNoise;
uniform float frameIndex;
float toSrgb(float x) { return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
float toLin(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float n = fract(texelFetch(blueNoise, ivec2(gl_FragCoord.xy) & ivec2(63), 0).r + frameIndex * 0.61803398875) - 0.5;
  vec3 c = clamp(inputColor.rgb, 0.0, 1.0);
  vec3 s = vec3(toSrgb(c.r), toSrgb(c.g), toSrgb(c.b)) + n / 255.0;
  s = clamp(s, 0.0, 1.0);
  outputColor = vec4(toLin(s.r), toLin(s.g), toLin(s.b), inputColor.a);
}
`;

/**
 * グレーボックスの post
 */
export class PostStub extends NgModule {
  static id = 'post';

  constructor(ctx) {
    super(ctx);
    this.uwFactor = 1;
    this.exposure = 1;
    this.drs = new DrsController(ctx.profile.drs);
    this._last = 0;
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE;
    const cam = ctx.camera || new T.PerspectiveCamera();
    this.expo = new Effect('NgExposure', EXPOSURE_FS, { uniforms: new Map([['exposure', new T.Uniform(1)]]) });
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    const blue = await ctx.forge.blueNoise();
    this.dither = new Effect('NgDither', DITHER_FS, {
      uniforms: new Map([['blueNoise', new T.Uniform(blue)], ['frameIndex', new T.Uniform(0)]]),
    });
    this._cam = cam;
    this._uwSvc = undefined;
    this._uwFx = null;
    this._depthTex = null;
    this.main = null;
    this._buildMain();
    this._syncUnderwater(null);
    this.smaa = new EffectPass(cam, new SMAAEffect());
    this.smaa.initialize(ctx.renderer, false, T.UnsignedByteType);
    this.fxaa = new EffectPass(cam, new FXAAEffect());
    this.fxaa.initialize(ctx.renderer, false, T.UnsignedByteType);
    for (const p of [this.smaa, this.fxaa]) p.renderToScreen = true;
    this.ldr = new T.WebGLRenderTarget(1, 1, { type: T.UnsignedByteType, depthBuffer: false });
    this.ldr.texture.colorSpace = T.SRGBColorSpace;
    this._size = new T.Vector2();
    progress?.(1);
  }

  setQuality(tier, profile) { this.drs.setRange(profile.drs); }

  /* HDR の鎖（水中 → 露出 → AgX → ディザ）を作り直す。pmndrs は Effect を attributes の大きい順に並べ替える
     （深度を使う Effect が前へ）ので、水中を先頭に置けば深度の有無に依らず先頭で走る */
  _buildMain() {
    const ctx = this.ctx, T = ctx.THREE, old = this.main;
    const list = this._uwFx ? [this._uwFx, this.expo, this.tone, this.dither] : [this.expo, this.tone, this.dither];
    this.main = new EffectPass(this._cam, ...list);
    this.main.initialize(ctx.renderer, false, T.HalfFloatType);
    if (this._size && this._size.x > 0) this.main.setSize(this._size.x, this._size.y);
    this._depthTex = null;
    if (old) {
      old.setEffects([]);   // 露出・トーンマップ・ディザと水中の Effect は使い回すので、外してから捨てる
      old.dispose();
    }
  }

  /* services.underwater が差し替わったら createEffect を引き直す（同じオブジェクトの間は 1 回だけ） */
  _syncUnderwater(targets) {
    const svc = this.ctx.services.underwater;
    if (svc !== this._uwSvc) {
      this._uwSvc = svc;
      let fx = null;
      try { fx = svc?.createEffect?.() || null; } catch (e) { fx = null; }
      if (fx && !(fx instanceof Effect)) {
        this.ctx.log('post-uw', 'services.underwater.createEffect が pmndrs の Effect でない物を返した（無視する）');
        fx = null;
      }
      if (fx !== this._uwFx) { this._uwFx = fx; this._buildMain(); }
    }
    const cam = this.ctx.gfx?.camera;
    if (cam && cam !== this._cam) { this._cam = cam; this.main.mainCamera = cam; }
    const depth = targets?.main?.depthTexture || null;
    if (this._uwFx && depth && depth !== this._depthTex) { this.main.setDepthTexture(depth); this._depthTex = depth; }
  }

  /* 画面の大きさ（描画バッファ）に合わせる */
  _fit() {
    const r = this.ctx.renderer, s = this._size;
    const w0 = s.x, h0 = s.y;
    r.getDrawingBufferSize(s);
    if (s.x === w0 && s.y === h0) return;
    this.ldr.setSize(s.x, s.y);
    for (const p of [this.main, this.smaa, this.fxaa]) p.setSize(s.x, s.y);
  }

  /**
   * P7（パイプラインから）。targets.main（解決済み）を画面へ
   * @param {import('../targets.js').Targets} targets
   * @param {number} dt
   */
  renderPost(targets, dt) {
    const ctx = this.ctx, r = ctx.renderer, F = ctx.frame.data;
    this._syncUnderwater(targets);
    this._fit();
    const capture = !!globalThis.__gfxCapture;
    /* 露出（§2）：太陽高度・雲・雨の純関数 × 水中（damp） */
    const sinAlt = F[NG.KEYRAD * 4 + 3];
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180 / Math.PI;
    const uw = ctx.frame.cam.uw > 0.5;
    const depth = uw ? Math.max(0, ctx.frame.cam.waterY - (ctx.camera?.position.y ?? 0)) : 0;
    const uwTarget = uw ? Math.min(3, 1.3 + 0.08 * depth) : 1;
    this.uwFactor = capture ? uwTarget : this.uwFactor + (uwTarget - this.uwFactor) * (1 - Math.exp(-1.5 * Math.max(0, dt)));
    const w = ctx.gfx?.f.weather || { cloud: 0.14, rain: 0 };
    this.exposure = ngScheduledExposure(alt, w.cloud, w.rain) * this.uwFactor;
    ctx.frame.set(NG.EXPO, this.exposure, 1 / this.exposure, -Math.log2(this.exposure), 0);
    this.expo.uniforms.get('exposure').value = this.exposure;
    this.dither.uniforms.get('frameIndex').value = F[NG.TIME * 4 + 3];
    const aa = ctx.gfx?.quality.profile.postAA || 'none';
    this.main.renderToScreen = aa === 'none';
    this.main.render(r, targets.main, this.ldr, dt);
    if (aa === 'smaa') this.smaa.render(r, this.ldr, null, dt);
    else if (aa === 'fxaa') this.fxaa.render(r, this.ldr, null, dt);
    /* 動的解像度：前回の呼び出しからの実時間で p90 を見る */
    const now = performance.now();
    if (this._last) ctx.pipeline.setRenderScale(this.drs.update(now - this._last, (now - this._last) / 1000, capture));
    this._last = now;
  }

  setSize() { this._size?.set(0, 0); }

  stats() { return { draws: 2, tris: 2, instances: 0, texBytes: 0, programs: 3, underwaterEffect: !!this._uwFx }; }

  dispose() {
    super.dispose();
    if (this.main && this._uwFx) this.main.setEffects([this.expo, this.tone, this.dither]);   // 水中の Effect は underwater の物
    for (const p of [this.main, this.smaa, this.fxaa]) p?.dispose();
    this.ldr?.dispose();
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new PostStub(ctx); }
