/* ===========================================================
   post モジュール（ARCHITECTURE §6.10・§2・§3.2 P7）
   -----------------------------------------------------------
   P7 の鎖（HDR → 画面）：
     [GTAO（high・半解像度）] [光芒（1/4 解像度・近景の影で遮蔽）]   ← sceneDepth（不透明の線形深度）から
     PRE（pmndrs の EffectPass）：水中の Effect（services.underwater、鎖の先頭）→ NaN/Inf の除去 → AO の合成（不透明の画素だけ）
                                  → 光芒の足し込み → 露出（時刻表 × 水中 × 順応）       → hdr（RGBA16F）
     測光（32×18 の log 平均 → 1×1、4Hz で非同期の読み戻し）→ 順応（±1EV、夜 +1.2EV、ポーズで止まる、撮影中は 1）
     Bloom（mip の縮小 / 拡大。最初の段は Karis 平均。エネルギー保存の mix）
     FINAL：CAS（DRS のとき）→ Bloom → ホワイトバランス → プルキニエ → 彩度 → ビネット → AgX → lift/gamma/gain → ブルーノイズのディザ
     → SMAA（mid）/ FXAA（low）→ 画面（DRS の内部解像度から描画バッファへ拡大）
   - トーンマップと sRGB は FINAL で 1 回だけ（renderer は NoToneMapping）
   - プログラム：UTIL 1 本（ngMode で測光・集約・Bloom・AO・光芒）+ FINAL 1 本 + PRE（pmndrs）1 本 + AA（pmndrs）
   - debug 表示は core の表へ登録だけ（registerDebugView は core が持つ）
   =========================================================== */
import { EffectPass, Effect, SMAAEffect, FXAAEffect } from 'postprocessing';
import { NgModule } from '../core/module.js';
import { NG } from '../core/frame.js';
import { DrsController } from '../core/quality.js';
import { ngScheduledExposure, NG_CHART_24 } from '../core/palette.js';
import { ngShaderMaterial } from '../core/extend.js';
import { FS_VERT, PRE_FS, UTIL_FS, FINAL_FS } from './shaders.js';
import { ngAdaptTarget, ngAdaptStep, ngGradeParams, ngShaftGate } from './grade.js';
import { postTier } from './quality.js';

const MODE = { METER: 0, REDUCE: 1, DOWN: 2, UP: 3, AOBLUR: 4, SHAFT: 5, GTAO: 6 };
const METER_W = 32, METER_H = 18;
/** 光芒の散乱係数（1/m）。湖畔の霞の Mie に «見える» 分を上乗せした値（lab の夕方の林で決めた） */
const SHAFT_SIGMA = 0.0016;
const SHAFT_RANGE = 48;

export class PostModule extends NgModule {
  static id = 'post';

  constructor(ctx) {
    super(ctx);
    this.uwFactor = 1;
    this.adapt = 1;
    this.adaptTarget = 1;
    this.exposure = 1;
    this.meterLog2 = NaN;
    this.drs = new DrsController(ctx.profile?.drs || [0.7, 1.0]);
    this.cfg = postTier(ctx.tier);
    /** 1 = 24 パッチの AgX のチャート（±4EV）を画面いっぱいに出す（lab の証拠用） */
    this.chart = 0;
    /** 撮影・lab 用の上書き（null で無効）：{ ao, shaft, bloom } の 0/1 */
    this.force = null;
    this._last = 0;
    this._key = '';
    this._readT = 0;
    this._reading = false;
    this._draws = 0;
    this._shaftAmt = 0;
    this._aoOn = false;
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE;
    const blue = await ctx.forge.blueNoise();
    this._blue = blue;
    const cam = ctx.camera || new T.PerspectiveCamera();
    this._cam = cam;

    /* 全画面の三角形（自分だけの場面。layers 0、カメラは使わない） */
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.fsScene = new T.Scene();
    this.fsCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsMesh = new T.Mesh(geo, null);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    const white = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.needsUpdate = true;
    const black = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    black.needsUpdate = true;
    this._white = white; this._black = black;

    const U = (v) => ({ value: v });
    this.uU = {
      ngMode: U(0), ngSrc: U(black), ngSrc2: U(black), ngBlueNoiseTex: U(blue),
      ngSrcTexel: U(new T.Vector4(1, 1, 1, 1)), ngDstSize: U(new T.Vector4(1, 1, 1, 1)),
      ngKaris: U(0), ngUpMix: U(0.62), ngProj: U(new T.Vector4(1, 1, 0.1, 1000)), ngCamWorld: U(new T.Matrix4()),
      ngDepthTexel: U(new T.Vector4(1, 1, 1, 1)), ngShaft: U(new T.Vector4(0, 0, 0, 1)), ngAo: U(new T.Vector4(1.2, 6, 1.25, 70)),
      ngFrameNo: U(0),
    };
    this.util = ngShaderMaterial({
      key: 'post-util', module: 'post', lights: false, fog: false,
      uniforms: { ...this.uU, ngSceneDepth: ctx.pipeline.uniforms.ngSceneDepth, ...ctx.shadows.nearUniforms },
      vertexShader: FS_VERT, fragmentShader: UTIL_FS, depthTest: false, depthWrite: false,
    });
    this.uF = {
      ngHdr: U(black), ngBloom: U(black), ngBlueNoiseTex: U(blue), ngHdrTexel: U(new T.Vector4(1, 1, 1, 1)),
      ngBloomAmt: U(0), ngCas: U(0), ngWb: U(new T.Vector3(1, 1, 1)), ngSat: U(1), ngPurk: U(0), ngVig: U(0.12),
      ngLift: U(new T.Vector3()), ngGamma: U(1), ngGain: U(new T.Vector3(1, 1, 1)), ngFrameNo: U(0), ngOutSrgb: U(1),
      ngChart: U(0), ngChartCols: U(NG_CHART_24.map((c) => new T.Vector3(c[0], c[1], c[2]))), ngDither: U(1),
    };
    this.final = ngShaderMaterial({
      key: 'post-final', module: 'post', lights: false, fog: false,
      uniforms: this.uF, vertexShader: FS_VERT, fragmentShader: FINAL_FS, depthTest: false, depthWrite: false,
    });

    /* PRE（pmndrs）：水中の Effect の後ろに連結される */
    this.pre = new Effect('NgPostPre', PRE_FS, {
      uniforms: new Map([
        ['ngPostExposure', new T.Uniform(1)], ['ngPostAoAmt', new T.Uniform(0)], ['ngPostShaftAmt', new T.Uniform(0)],
        ['ngPostAoTex', new T.Uniform(white)], ['ngPostShaftTex', new T.Uniform(black)], ['ngSceneColor', new T.Uniform(black)],
      ]),
    });
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

    const rt = (w, h, type = T.HalfFloatType, filter = T.LinearFilter) => new T.WebGLRenderTarget(w, h, {
      type, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: filter, magFilter: filter, generateMipmaps: false,
    });
    this._rt = rt;
    this.ldr = rt(1, 1, T.UnsignedByteType);
    this.ldr.texture.colorSpace = T.SRGBColorSpace;
    this.meterRT = rt(METER_W, METER_H, T.HalfFloatType, T.NearestFilter);
    this.meterOut = rt(1, 1, T.UnsignedByteType, T.NearestFilter);
    this._meterBuf = new Uint8Array(4);
    this.hdr = null; this.ao = null; this.aoB = null; this.shaft = null; this.down = []; this.up = [];
    this._size = new T.Vector2();
    this._v3 = new T.Vector3();
    this._v3b = new T.Vector3();

    /* debug 表示（core の表へ。lab の view(name)） */
    this.dbgU = { ngPostDbgTex: U(black) };
    const reg = ctx.services.post.registerDebugView;
    reg('post-ao', 'uniform sampler2D ngPostDbgAo;\nvec4 ngDebug(vec2 uv) { return vec4(vec3(texture(ngPostDbgAo, uv).r), 1.0); }', { ngPostDbgAo: this.dbgAo = U(white) });
    reg('post-shaft', 'uniform sampler2D ngPostDbgShaft;\nvec4 ngDebug(vec2 uv) { vec3 c = texture(ngPostDbgShaft, uv).rgb; return vec4(c / (c + 0.05), 1.0); }', { ngPostDbgShaft: this.dbgShaft = U(black) });
    reg('post-bloom', 'uniform sampler2D ngPostDbgBloom;\nvec4 ngDebug(vec2 uv) { vec3 c = texture(ngPostDbgBloom, uv).rgb; return vec4(c / (c + 1.0), 1.0); }', { ngPostDbgBloom: this.dbgBloom = U(black) });
    progress?.(1);
  }

  setQuality(tier, profile) {
    this.cfg = postTier(tier);
    if (profile?.drs) this.drs.setRange(profile.drs);
    this._key = '';
  }

  /* HDR の鎖（水中 → PRE）を作り直す。pmndrs は深度を使う Effect を前へ並べ替えるので、水中を先頭に置けば深度の有無に依らず先頭 */
  _buildMain() {
    const ctx = this.ctx, T = ctx.THREE, old = this.main;
    const list = this._uwFx ? [this._uwFx, this.pre] : [this.pre];
    this.main = new EffectPass(this._cam, ...list);
    this.main.initialize(ctx.renderer, false, T.HalfFloatType);
    this.main.renderToScreen = false;
    if (this.hdr) this.main.setSize(this.hdr.width, this.hdr.height);
    this._depthTex = null;
    if (old) { old.setEffects([]); old.dispose(); }
  }

  /* services.underwater が差し替わったら createEffect を引き直す（同じオブジェクトの間は 1 回だけ。CORE_API §6.3） */
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

  /* RT を main（内部解像度）と描画バッファの大きさに合わせる */
  _fit(targets) {
    const r = this.ctx.renderer, s = this._size, T = this.ctx.THREE;
    r.getDrawingBufferSize(s);
    const mw = targets.main.width, mh = targets.main.height;
    const key = `${mw}x${mh}:${s.x}x${s.y}:${this.cfg.bloom}:${this.cfg.gtao}:${this.cfg.shaft}`;
    if (key === this._key) return;
    this._key = key;
    const rt = this._rt;
    const re = (old, w, h) => { if (old && old.width === w && old.height === h) return old; old?.dispose(); return rt(w, h); };
    this.hdr = re(this.hdr, mw, mh);
    this.main.setSize(mw, mh);
    this.ldr.setSize(s.x, s.y);
    this.smaa.setSize(s.x, s.y);
    this.fxaa.setSize(s.x, s.y);
    const hw = Math.max(1, mw >> 1), hh = Math.max(1, mh >> 1);
    if (this.cfg.gtao) { this.ao = re(this.ao, hw, hh); this.aoB = re(this.aoB, hw, hh); }
    else { this.ao?.dispose(); this.aoB?.dispose(); this.ao = this.aoB = null; }
    if (this.cfg.shaft > 0) this.shaft = re(this.shaft, Math.max(1, mw >> 2), Math.max(1, mh >> 2));
    else { this.shaft?.dispose(); this.shaft = null; }
    const n = this.cfg.bloom;
    for (let i = n; i < this.down.length; i++) this.down[i]?.dispose();
    for (let i = Math.max(0, n - 1); i < this.up.length; i++) this.up[i]?.dispose();
    this.down.length = n; this.up.length = Math.max(0, n - 1);
    let w = hw, h = hh;
    for (let i = 0; i < n; i++) {
      this.down[i] = re(this.down[i], w, h);
      if (i < n - 1) this.up[i] = re(this.up[i], w, h);
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
    this.dbgAo.value = this.aoB?.texture || this._white;
    this.dbgShaft.value = this.shaft?.texture || this._black;
    this.dbgBloom.value = n ? (n > 1 ? this.up[0].texture : this.down[0].texture) : this._black;
    void T;
  }

  /* UTIL の 1 パス */
  _pass(mode, src, dst) {
    const u = this.uU, r = this.ctx.renderer;
    u.ngMode.value = mode;
    u.ngSrc.value = src.texture || src;
    if (mode !== MODE.UP) u.ngSrc2.value = this._black;   // 描く先と同じテクスチャを繋いだままにしない（フィードバックループ）
    const img = src.texture ? src : (src.image || { width: 1, height: 1 });
    u.ngSrcTexel.value.set(1 / img.width, 1 / img.height, img.width, img.height);
    u.ngDstSize.value.set(dst.width, dst.height, 1 / dst.width, 1 / dst.height);
    this.fsMesh.material = this.util;
    r.setRenderTarget(dst);
    r.render(this.fsScene, this.fsCam);
    this._draws++;
  }

  /**
   * P7（パイプラインから）。targets.main（解決済みの HDR）を画面へ
   * @param {{main: any, copy: any}} targets
   * @param {number} dt
   */
  renderPost(targets, dt) {
    const ctx = this.ctx, r = ctx.renderer, F = ctx.frame.data, T = ctx.THREE;
    this._syncUnderwater(targets);
    this._fit(targets);
    this._draws = 0;
    const capture = !!globalThis.__gfxCapture;
    const f = ctx.gfx?.f;
    const fdt = Math.max(0, Number.isFinite(f?.dt) ? f.dt : dt) || 0;   // ポーズで 0（順応・水中の damp が止まる）
    const cam = this._cam;
    const cfg = this.cfg;

    /* 露出（§2）：時刻表 × 水中（damp）× 順応 */
    const sinAlt = F[NG.KEYRAD * 4 + 3];
    const alt = Math.asin(Math.max(-1, Math.min(1, Number.isFinite(sinAlt) ? sinAlt : 0.7))) * 180 / Math.PI;
    const uwS = ctx.frame.cam.uw;
    const uw = uwS > 0.5;
    const depth = uw ? Math.max(0, ctx.frame.cam.waterY - (cam?.position.y ?? 0)) : 0;
    const uwTarget = uw ? Math.min(3, 1.3 + 0.08 * depth) : 1;
    this.uwFactor = capture ? uwTarget : this.uwFactor + (uwTarget - this.uwFactor) * (1 - Math.exp(-1.5 * fdt));
    const w = f?.weather || { cloud: 0.14, rain: 0 };
    const night = F[NG.KEY * 4 + 3] || 0;
    if (capture) { this.adapt = 1; this.adaptTarget = 1; }
    else this.adapt = ngAdaptStep(this.adapt, this.adaptTarget, fdt);
    const sched = ngScheduledExposure(alt, w.cloud, w.rain) * this.uwFactor;
    let e = sched * this.adapt;
    if (!(e > 0) || !Number.isFinite(e)) e = 1;
    this.exposure = e;
    ctx.frame.set(NG.EXPO, e, 1 / e, -Math.log2(e), 0);

    const prevAuto = r.autoClear;
    r.autoClear = false;
    try {
      /* カメラの値（GTAO と光芒） */
      const u = this.uU;
      const P = cam.projectionMatrix.elements;
      u.ngProj.value.set(P[0], P[5], cam.near ?? 0.1, cam.far ?? 1000);
      u.ngCamWorld.value.copy(cam.matrixWorld);
      const scr = ctx.pipeline.uniforms.ngScreen.value;
      u.ngDepthTexel.value.set(scr.z, scr.w, scr.x, scr.y);
      u.ngFrameNo.value = F[NG.TIME * 4 + 3];
      const force = this.force || {};

      /* GTAO（high・水上）→ 4×4 の深度つきのぼかし */
      const aoOn = !!(this.ao && !uw && force.ao !== 0);
      this._aoOn = aoOn;
      if (aoOn) {
        u.ngAo.value.set(cfg.aoRadius, cfg.aoSteps, 1.6, 70);   // 強さ 1.25 → 1.6（桟橋の下の根太の間が読めるように。環境光の割合だけに掛かる）
        this._pass(MODE.GTAO, targets.copy.textures[1], this.ao);
        this._pass(MODE.AOBLUR, this.ao, this.aoB);
      }

      /* 光芒（太陽が画面の 1.3 倍以内・高度 < 25°・水上） */
      let shaftAmt = 0;
      if (this.shaft && force.shaft !== 0) {
        const sd = this._v3.set(F[NG.SUN * 4], F[NG.SUN * 4 + 1], F[NG.SUN * 4 + 2]);
        const fwd = cam.getWorldDirection(this._v3b);
        const front = fwd.dot(sd) > 0.05;
        const p = sd.clone().multiplyScalar(1000).add(cam.position).project(cam);
        shaftAmt = ngShaftGate(alt, p.x, p.y, front, uwS) * (1 - 0.85 * night);
        if (force.shaft === 1) shaftAmt = Math.max(shaftAmt, 1);
        if (shaftAmt > 0.002) {
          u.ngShaft.value.set(SHAFT_SIGMA * (1 + 1.5 * (F[NG.MIST * 4] || 0) * 400), cfg.shaft, SHAFT_RANGE, 1);
          this._pass(MODE.SHAFT, targets.copy.textures[1], this.shaft);
        } else shaftAmt = 0;
      }
      this._shaftAmt = shaftAmt;

      /* PRE：水中 → NaN → AO → 光芒 → 露出 → hdr */
      const pu = this.pre.uniforms;
      pu.get('ngPostExposure').value = e;
      pu.get('ngPostAoAmt').value = aoOn ? 1 : 0;
      pu.get('ngPostAoTex').value = aoOn ? this.aoB.texture : this._white;
      pu.get('ngPostShaftAmt').value = shaftAmt;
      pu.get('ngPostShaftTex').value = shaftAmt > 0 ? this.shaft.texture : this._black;
      pu.get('ngSceneColor').value = ctx.pipeline.uniforms.ngSceneColor.value;
      this.main.render(r, targets.main, this.hdr, dt);
      this._draws++;

      /* 測光（毎フレーム 32×18、読み戻しは 4Hz・非同期）。撮影中は順応しないので読まない */
      const now = performance.now();
      if (!capture && !this._reading && now - this._readT > 250) {
        this._readT = now;
        this._pass(MODE.METER, this.hdr, this.meterRT);
        this._pass(MODE.REDUCE, this.meterRT, this.meterOut);
        this._readMeter(this.adapt, night);
      }

      /* Bloom（mip の縮小 → 拡大） */
      const n = cfg.bloom;
      let bloomTex = this._black;
      const g = ngGradeParams({ sunAltDeg: alt, night, cloud: w.cloud, rain: w.rain, uw: uwS });
      if (n > 0 && force.bloom !== 0) {
        u.ngKaris.value = 1;
        this._pass(MODE.DOWN, this.hdr, this.down[0]);
        u.ngKaris.value = 0;
        for (let i = 1; i < n; i++) this._pass(MODE.DOWN, this.down[i - 1], this.down[i]);
        for (let i = n - 2; i >= 0; i--) {
          u.ngSrc2.value = this.down[i].texture;
          this._pass(MODE.UP, i === n - 2 ? this.down[n - 1] : this.up[i + 1], this.up[i]);
        }
        bloomTex = n > 1 ? this.up[0].texture : this.down[0].texture;
      }

      /* FINAL：グレード → AgX → ディザ → 画面（または AA の LDR） */
      const fu = this.uF;
      fu.ngHdr.value = this.hdr.texture;
      fu.ngHdrTexel.value.set(1 / this.hdr.width, 1 / this.hdr.height, this.hdr.width, this.hdr.height);
      fu.ngBloom.value = bloomTex;
      fu.ngBloomAmt.value = bloomTex === this._black ? 0 : g.bloom;
      const scale = this.hdr.width / Math.max(1, this._size.x);
      fu.ngCas.value = scale < 0.98 ? cfg.cas : 0;
      fu.ngWb.value.set(g.wb[0], g.wb[1], g.wb[2]);
      fu.ngSat.value = g.sat;
      fu.ngPurk.value = g.purkinje;
      fu.ngVig.value = g.vignette;
      fu.ngLift.value.set(g.lift[0], g.lift[1], g.lift[2]);
      fu.ngGamma.value = g.gamma;
      fu.ngGain.value.set(g.gain[0], g.gain[1], g.gain[2]);
      fu.ngFrameNo.value = F[NG.TIME * 4 + 3];
      fu.ngChart.value = this.chart ? 1 : 0;
      this._grade = g;
      const aa = ctx.gfx?.quality.profile.postAA || 'none';
      const toScreen = aa !== 'smaa' && aa !== 'fxaa';
      fu.ngOutSrgb.value = toScreen ? 1 : 0;
      this.fsMesh.material = this.final;
      r.setRenderTarget(toScreen ? null : this.ldr);
      r.render(this.fsScene, this.fsCam);
      this._draws++;
      if (!toScreen) {
        (aa === 'smaa' ? this.smaa : this.fxaa).render(r, this.ldr, null, dt);
        this._draws += aa === 'smaa' ? 3 : 1;
      }
    } finally {
      r.autoClear = prevAuto;
      r.setRenderTarget(null);
    }

    /* 動的解像度：前回の呼び出しからの実時間で p90 を見る */
    const now = performance.now();
    if (this._last) ctx.pipeline.setRenderScale(this.drs.update(now - this._last, (now - this._last) / 1000, capture));
    this._last = now;
  }

  /* 1×1 の測光を非同期で読む。結果が来たら順応の目標を決める（その測光のフレームの順応で割り戻す） */
  _readMeter(usedAdapt, night) {
    const r = this.ctx.renderer;
    if (typeof r.readRenderTargetPixelsAsync !== 'function') {
      try {
        r.readRenderTargetPixels(this.meterOut, 0, 0, 1, 1, this._meterBuf);
        this._onMeter(usedAdapt, night);
      } catch (e) { /* 読めなければ順応しない */ }
      return;
    }
    this._reading = true;
    let p;
    try { p = r.readRenderTargetPixelsAsync(this.meterOut, 0, 0, 1, 1, this._meterBuf); } catch (e) { this._reading = false; return; }
    /* three r180 は待つ間 PIXEL_PACK_BUFFER を束ねたままにする（他の同期の readPixels が INVALID_OPERATION になり、
       深度の読み戻しなどが 0 を返す）。sky の読み戻しと同じく、要求の直後に外す */
    try { const gl = r.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch (e) { /* 無視 */ }
    Promise.resolve(p).then(() => { this._reading = false; this._onMeter(usedAdapt, night); }, () => { this._reading = false; });
  }

  _onMeter(usedAdapt, night) {
    const b = this._meterBuf;
    const v = (b[0] * 256 + b[1]) / 65535;
    const L = v * 32 - 20;
    if (!Number.isFinite(L) || (b[0] === 0 && b[1] === 0)) return;
    this.meterLog2 = L;
    this.adaptTarget = ngAdaptTarget(L, usedAdapt, night);
  }

  setSize() { this._key = ''; }

  restoreGPU() { this._key = ''; this._reading = false; }

  stats() {
    const px = (t) => (t ? t.width * t.height * 8 : 0);
    let bytes = px(this.hdr) + px(this.ao) + px(this.aoB) + px(this.shaft) + (this.ldr ? this.ldr.width * this.ldr.height * 4 : 0);
    for (const t of this.down) bytes += px(t);
    for (const t of this.up) bytes += px(t);
    return {
      draws: this._draws, tris: this._draws, instances: 0, texBytes: bytes, programs: 3,
      underwaterEffect: !!this._uwFx, exposure: this.exposure, adapt: this.adapt, adaptTarget: this.adaptTarget,
      meterLog2: this.meterLog2, ao: this._aoOn, shaft: this._shaftAmt, bloomLevels: this.cfg.bloom,
    };
  }

  dispose() {
    super.dispose();
    if (this.main && this._uwFx) this.main.setEffects([this.pre]);   // 水中の Effect は underwater の物
    for (const p of [this.main, this.smaa, this.fxaa]) p?.dispose();
    for (const t of [this.hdr, this.ao, this.aoB, this.shaft, this.ldr, this.meterRT, this.meterOut, ...this.down, ...this.up]) t?.dispose();
    this.util?.dispose(); this.final?.dispose();
    this.fsMesh?.geometry.dispose();
    this._white?.dispose(); this._black?.dispose();
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new PostModule(ctx); }
