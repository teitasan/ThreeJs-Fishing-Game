/* ===========================================================
   sky モジュール（ARCHITECTURE §6.1・CORE_API §6.1）
   -----------------------------------------------------------
   大気（Hillaire 2020：透過 256×64・多重散乱 32²・晴れの空 256×128 を毎フレーム、オゾン・地球の影）、
   カメラに依らない雲パノラマ（Perlin-Worley 64³ + Worley 32³、Beer-Powder、二重 HG、多重散乱の近似、
   巻雲 8km、乱層雲。毎フレーム 1/16 の帯、時刻の純関数）、空のドーム（太陽・月・星・天の川・朝霧の地平）、
   光のリグ（rig.js：key の太陽 ↔ 月・SH L2・地平線の整合・朝霧・濡れ・ファサードの色）。
   プログラム（sky:*）：ドーム・LUT（透過 / 多重散乱）・晴れの空・雲パノラマ・写し（skyView / 帯）の 5 本。
   起動時の焼き込み（ノイズ・巻雲・月）は forge（読み込みの最後に捨てられる）
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG, NG_PASS, ngFrameData } from '../core/frame.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { ngShaderMaterial } from '../core/extend.js';
import { cloudShadow } from '../core/medium.js';
import { SkyRig, MOON_SKY_TINT, MOON_SKY } from './rig.js';
import { smooth as smooth01 } from './atmosphere.js';
import { skyTier } from './quality.js';
import { stripAt } from './strips.js';
import { TRANS_FRAG, MS_FRAG, SKYCLEAR_FRAG, SKYVIEW_FRAG } from './atmo.glsl.js';
import { SHAPE_FRAG, SHAPE2_FRAG, DETAIL_FRAG, CIRRUS_FRAG, MOON_FRAG, COVER_FRAG, COVER_Q, PANO_FRAG, STRIP_COPY_FRAG } from './clouds.glsl.js';
import { DOME_VS, DOME_FS } from './dome.glsl.js';

const PASS_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const VUV = 'varying vec2 vUv;\n';
/** CPU へ戻す空：行 0–15 = skyView の mip 3（32×16）、行 16 = 地平の仰角（rig の HZ_Y）の行を 8 テクセルずつ横に平均 */
export const PROBE_W = 32, PROBE_H = 17;
const PROBE_FRAG = `
void ngSkyProbeMain() {
  vec2 fc = gl_FragCoord.xy;
  if (fc.y < 16.0) { gl_FragColor = vec4(textureLod(uSkyViewIn, fc / vec2(32.0, 16.0), 3.0).rgb, 1.0); return; }
  float v = 0.5 + 0.5 * sqrt(atan(0.02) * 0.63661977);
  vec3 c = vec3(0.0);
  for (int k = 0; k < 8; k++) c += textureLod(uSkyViewIn, vec2((floor(fc.x) * 8.0 + float(k) + 0.5) / 256.0, v), 0.0).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}
`;
/* 2 つの LUT を 1 本のプログラムに（uLutMode 0 = 透過、1 = 多重散乱）。プログラムの数を抑える */
const LUT_FRAG = VUV + 'uniform float uLutMode;\n'
  + TRANS_FRAG.replace('void main() {', 'void ngSkyTransMain() {')
  + MS_FRAG.replace('uniform float uHaze;', '').replace('void main() {', 'void ngSkyMSMain() {')
  + '\nvoid main() { if (uLutMode < 0.5) ngSkyTransMain(); else ngSkyMSMain(); }\n';
/* skyView の合成・帯の写し・CPU へ戻す空の縮小を 1 本に（uCopyMode 0 = skyView、1 = 帯 → パノラマ、2 = 32×16 の縮小） */
const UTIL_FRAG = VUV + 'uniform float uCopyMode;\nuniform sampler2D uSkyViewIn;\n'
  + SKYVIEW_FRAG.replace('void main() {', 'void ngSkyViewMain() {')
  + STRIP_COPY_FRAG.replace('void main() {', 'void ngSkyCopyMain() {')
  + PROBE_FRAG
  + '\nvoid main() { if (uCopyMode < 0.5) ngSkyViewMain(); else if (uCopyMode < 1.5) ngSkyCopyMain(); else ngSkyProbeMain(); }\n';


const SKY_W = 256, SKY_H = 128;

export class SkyModule extends NgModule {
  static id = 'sky';

  constructor(ctx) {
    super(ctx);
    const T = ctx.THREE;
    this.rig = new SkyRig();
    this.colors = { sunColor: new T.Color(), zenithColor: new T.Color(), horizonColor: new T.Color(), fogColor: new T.Color() };
    this.key = { color: new T.Color(1, 1, 1), intensity: 0 };
    this.fog = { near: 100, far: 1000, color: this.colors.fogColor };
    this.sh = new T.SphericalHarmonics3();
    this.q = skyTier(ctx.tier);
    this.tier = ctx.tier;
    this.ready = false;
    this.frame = 0;
    this.strip = 0;
    this.full = true;
    this.lutHaze = -1;
    this.texBytes = 0;
    const V3 = () => ({ value: new T.Vector3() }), V4 = () => ({ value: new T.Vector4() });
    /* 共有の uniforms（{value} はパスをまたいで同じ物） */
    this.U = {
      ngFrame: { value: ngFrameData },
      ngSkyTrans: { value: null }, ngSkyMS: { value: null },
      uHaze: { value: 1 }, uLutMode: { value: 0 }, uCopyMode: { value: 0 },
      uSkyE: V4(), uSkySunCol: { value: new T.Vector3(1, 1, 1) }, uSkyMoonCol: { value: new T.Vector3().fromArray(MOON_SKY_TINT) }, uSkySunWarm: { value: new T.Vector3(1, 1, 1) }, uSkyDeck: V4(), uSkyDeckL: V3(), uSkySunDir: { value: new T.Vector3(0, 1, 0) },
      uSteps: { value: 32 },
      uSkyClear: { value: null }, uCloudPano: { value: null }, uStrip: { value: null }, uPrev: { value: null },
      uNgCoverN: { value: null }, uCoverXf: V4(),
      uNgShape: { value: null }, uNgShape2: { value: null }, uNgDetail: { value: null }, uNgCirrus: { value: null }, uMoonTex: { value: null },
      uPano: V4(), uCloud: V4(), uCloud2: V4(), uWind: V4(), uLight: V4(), uLightE: V3(), uAmbTop: V3(), uAmbBot: V3(),
      uMode: V4(), uCirrus: V4(), uCirrusW: V4(), uSkyViewIn: { value: null },
      uSunDisk: V3(), uMoonDisk: V3(), uCloudSharp: V4(), uNightSky: V4(), uSkyMisc: V4(),
    };
  }

  async init(progress) {
    const { THREE: T, forge, renderer } = this.ctx;
    this.renderer = renderer;
    /* 自前の全画面パス（タグ付きの ngShaderMaterial。forge は起動時の焼き込みだけ） */
    const tri = new T.BufferGeometry();
    tri.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this._passScene = new T.Scene();
    this._passCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._passMesh = new T.Mesh(tri, null);
    this._passMesh.frustumCulled = false;
    this._passScene.add(this._passMesh);
    const pass = (key, frag) => ngShaderMaterial({
      key, module: 'sky', uniforms: this.U, vertexShader: PASS_VS, fragmentShader: frag,
      lights: false, fog: false, depthTest: false, depthWrite: false,
    });
    this.mLut = pass('sky-lut', LUT_FRAG);
    this.mClear = pass('sky-clear', VUV + SKYCLEAR_FRAG);
    this.mPano = pass('sky-pano', VUV + PANO_FRAG);
    this.mUtil = pass('sky-util', UTIL_FRAG);
    /* LUT・晴れの空・skyView */
    const rt = (w, h, o = {}) => {
      const r = new T.WebGLRenderTarget(w, h, { depthBuffer: false, type: o.type ?? T.HalfFloatType, format: T.RGBAFormat });
      r.texture.minFilter = o.mips ? T.LinearMipmapLinearFilter : T.LinearFilter;
      r.texture.magFilter = T.LinearFilter;
      r.texture.generateMipmaps = !!o.mips;
      r.texture.wrapS = o.wrapS ?? T.ClampToEdgeWrapping;
      r.texture.wrapT = T.ClampToEdgeWrapping;
      return r;
    };
    this._rt = rt;
    this.rtTrans = rt(256, 64);
    this.rtMS = rt(32, 32);
    this.rtClear = rt(SKY_W, SKY_H, { wrapS: T.RepeatWrapping });
    this.rtView = rt(SKY_W, SKY_H, { mips: true, wrapS: T.RepeatWrapping });
    this.U.ngSkyTrans.value = this.rtTrans.texture;
    this.U.ngSkyMS.value = this.rtMS.texture;
    this.U.uSkyClear.value = this.rtClear.texture;
    this.rtProbe = rt(PROBE_W, PROBE_H);
    this._probeBuf = new Uint16Array(PROBE_W * PROBE_H * 4);
    this._probeOn = typeof renderer.readRenderTargetPixelsAsync === 'function';
    this._probePending = false;
    this._probeT = -1e9;
    progress?.(0.1);
    const lp = this.loadParts = {};
    let tm = performance.now();
    const mark = (k) => { const t = performance.now(); lp[k] = +(t - tm).toFixed(1); tm = t; };
    await this._bake(progress, mark);
    /* 薄明の利得の表（CPU ≈40ms を 30ms ごとに譲って） */
    for (const _ of this.rig.buildTwilight()) await forge.step();
    mark('twilight');
    this.rig._last = null;
    this._allocPano();
    /* ドーム */
    this.dome = new T.Mesh(tri.clone(), ngShaderMaterial({
      key: 'sky-dome', module: 'sky', uniforms: this.U, vertexShader: DOME_VS, fragmentShader: DOME_FS,
      lights: false, fog: false, depthWrite: false, depthTest: true, depthFunc: T.LessEqualDepth,
    }));
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1e9;
    this.dome.name = 'ng-sky-dome';
    this.root.add(this.dome);
    ngOwn(this.root, NG_LAYER.WORLD);
    this.ctx.scene.add(this.root);
    this._canopyMap();
    this.ctx.services.provide('sky', {
      skyViewTex: this.rtView.texture,
      skyViewMips: Math.log2(SKY_W) | 0,
      transmittanceTex: this.rtTrans.texture,
      cloudPanoTex: this.rtPano.texture,
      sampleSky: (d) => this.rig.sampleSky(+d.x || 0, +d.y || 0, +d.z || 0),
      keyColor: this.key.color,
      cloudShadowAt: (x, z) => cloudShadow(this.ctx.frame.data, { x: +x || 0, y: 0, z: +z || 0 }),
    });
    /* 最初の 1 枚を全部描いてプログラムを作っておく */
    this.ready = true;
    this.full = true;
    mark('setup');
    /* 自前のパスのプログラムを並列でコンパイル（KHR_parallel_shader_compile。読み込み画面を止めない） */
    try {
      const tmp = new T.Scene();
      for (const m of [this.mLut, this.mClear, this.mPano, this.mUtil]) { const me = new T.Mesh(tri, m); me.frustumCulled = false; tmp.add(me); }
      if (typeof renderer.compileAsync === 'function') await renderer.compileAsync(tmp, this._passCam);
    } catch (e) { /* 同期のコンパイルに任せる */ }
    mark('compile');
    this._gpu(true);
    mark('firstGpu');
    progress?.(1);
  }

  /* 起動時の焼き込み：形 64³・細部 32³・巻雲 512²・月 512² */
  async _bake(progress, mark = () => {}) {
    const { THREE: T, forge } = this.ctx;
    const old = [this.U.uNgShape.value, this.U.uNgDetail.value, this.U.uNgCirrus.value, this.U.uMoonTex.value];
    this.U.uNgShape.value = forge.bake3D({ w: 64, h: 64, d: 64, frag: SHAPE_FRAG, type: T.UnsignedByteType, wrap: 'repeat' });
    mark('shape');
    await forge.step(); progress?.(0.4);
    this.U.uNgShape2.value = forge.bake2D({ w: 256, h: 256, frag: SHAPE2_FRAG, uniforms: { uNgShape: { value: this.U.uNgShape.value } }, type: T.UnsignedByteType, format: T.RedFormat, mips: true, wrap: 'repeat' });
    this.U.uNgDetail.value = forge.bake3D({ w: 32, h: 32, d: 32, frag: DETAIL_FRAG, type: T.UnsignedByteType, wrap: 'repeat' });
    mark('shape2+detail');
    await forge.step(); progress?.(0.6);
    this.U.uNgCirrus.value = forge.bake2D({ w: 512, h: 512, frag: CIRRUS_FRAG, type: T.UnsignedByteType, mips: true, wrap: 'repeat' });
    mark('cirrus');
    await forge.step(); progress?.(0.75);
    this.U.uMoonTex.value = forge.bake2D({ w: 512, h: 256, frag: MOON_FRAG, type: T.UnsignedByteType, mips: true, wrap: 'clamp' });
    await forge.step();
    mark('moon');
    this.U.uNgCoverN.value = forge.bake2D({ w: 2048, h: 2048, frag: COVER_FRAG, uniforms: { ngFrame: { value: ngFrameData } }, type: T.UnsignedByteType, format: T.RedFormat, wrap: 'clamp' });
    mark('cover');
    for (const t of old) if (t && t !== this.U.uNgShape.value) { /* forge の RT は forge が持つ */ }
    progress?.(0.85);
  }

  _allocPano() {
    const T = this.ctx.THREE;
    const [w, h] = this.q.pano;
    if (this.rtPano && this.rtPano.width === w && this.rtPano.height === h) return;
    this.rtPano?.dispose(); this.rtStrip?.dispose();
    this.rtPano = this._rt(w, h, { wrapS: T.RepeatWrapping });
    this.rtStrip = this._rt(w, Math.ceil(h / this.q.strips));
    this.U.uCloudPano.value = this.rtPano.texture;
    this.U.uPrev.value = this.rtPano.texture;
    this.U.uStrip.value = this.rtStrip.texture;
    this.full = true;
    if (this.ctx.services.sky && this.ready) this.ctx.services.provide('sky', { cloudPanoTex: this.rtPano.texture });
    this.texBytes = (256 * 64 + 32 * 32 + SKY_W * SKY_H * 2.34 + w * h + w * Math.ceil(h / this.q.strips)) * 8
      + 64 ** 3 * 4 + 256 * 256 * 1.34 + 32 ** 3 * 4 + 2048 * 2048 + 512 * 512 * 4 * 1.34 + 512 * 256 * 4 * 1.34;
  }

  /* 注視点の樹冠の密度（heightfield の派生マップ。CPU の画素から読む） */
  _canopyMap() {
    const t = this.ctx.heightfield?.maps?.canopy;
    const img = t?.image;
    this._canopy = img && img.data && img.width ? { data: img.data, n: img.width, origin: -512, size: 1024 } : null;
  }

  _canopyAt(x, z) {
    const c = this._canopy;
    if (!c) return 0;
    const fx = ((x - c.origin) / c.size) * c.n - 0.5, fz = ((z - c.origin) / c.size) * c.n - 0.5;
    if (!(fx >= 0 && fz >= 0 && fx < c.n - 1 && fz < c.n - 1)) return 0;
    let s = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const ix = Math.min(c.n - 1, Math.max(0, Math.round(fx) + dx)), iz = Math.min(c.n - 1, Math.max(0, Math.round(fz) + dz));
      s += c.data[(iz * c.n + ix) * 4] / 255;
    }
    return s / 9;
  }

  /**
   * 光のリグの producer（gfx.beginFrame から毎フレーム）
   */
  produce(input) {
    const F = this.ctx.frame.data;
    const rig = this.rig;
    const foc = input.focus || input.camera?.position;
    if (foc) rig.canopy = this._canopyAt(foc.x, foc.z);
    rig.uw = F[NG.CAM * 4];
    const opt = this.ctx.services.underwater?.optics;
    rig.uwInsc = opt?.insc ? [opt.insc.x, opt.insc.y, opt.insc.z] : null;
    const o = rig.step(input, F);
    if (o.jumped) this.full = true;
    /* SH */
    const c = this.sh.coefficients, s = rig.sh;
    for (let i = 0; i < 9; i++) c[i].set(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]);
    this.key.color.setRGB(o.keyColor[0], o.keyColor[1], o.keyColor[2]);
    this.key.intensity = o.keyIntensity;
    const ex = o.exposure, col = this.colors;
    col.zenithColor.setRGB(o.zenith[0] * ex, o.zenith[1] * ex, o.zenith[2] * ex);
    col.horizonColor.setRGB(o.horizon[0] * ex, o.horizon[1] * ex, o.horizon[2] * ex);
    col.fogColor.copy(col.horizonColor);
    col.sunColor.copy(this.key.color);
    this._uniforms(input, o);
    return { colors: col, fog: this.fog, key: this.key, sh: this.sh, keyDir: o.keyDir };
  }

  _uniforms(input, o) {
    const U = this.U, p = this.rig.p, wp = o.wp, F = this.ctx.frame.data;
    const s = [F[NG.SUN * 4], F[NG.SUN * 4 + 1], F[NG.SUN * 4 + 2]];
    U.uSkySunDir.value.set(s[0], s[1], s[2]);
    U.uSkyE.value.set(p.eS0, this.rig.moonTop * MOON_SKY * smooth01(-0.40, -0.05, -s[1]), this.rig.G, this.rig.A.haze);
    U.uSkySunCol.value.fromArray(this.rig.gTw);
    U.uSkySunWarm.value.fromArray(this.rig.gW);
    U.uSkyDeck.value.set(wp.base / 1000, wp.deckOcc, 0, 0);
    U.uSkyDeckL.value.fromArray(p.deckL);
    U.uHaze.value = this.rig.A.haze;
    /* 雲 */
    const h = this.rig._last ? this.rig._last.h : 12;
    const a = (h / 24) * Math.PI * 2;
    const fz = (v) => (Number.isFinite(v) ? v : 0);
    const ox = fz(F[NG.CLOUDSH * 4]) / 1000, oz = fz(F[NG.CLOUDSH * 4 + 1]) / 1000;
    U.uCloud.value.set(wp.cover, wp.base / 1000, wp.top / 1000, wp.strat);
    const inv = fz(F[NG.CLOUDSH * 4 + 2]);
    U.uCoverXf.value.set(inv * 1000, ox * 1000 * inv, oz * 1000 * inv, COVER_Q);
    U.uCloud2.value.set(wp.sigma, 1 / 2.2, 1 / 0.32, wp.erosion);
    /* 細部は 24h 周期の小さな円でさらに流れる（湧き立ち） */
    U.uWind.value.set(ox, oz, ox * 1.35 + Math.cos(a * 3) * 1.1, oz * 1.35 + Math.sin(a * 3) * 1.1);
    U.uLight.value.set(p.light[0], p.light[1], p.light[2], wp.belly);
    U.uLightE.value.fromArray(p.lightE);
    U.uAmbTop.value.fromArray(p.ambTop);
    U.uAmbBot.value.fromArray(p.ambBot);
    U.uCirrus.value.set(wp.cirrus, 8.0, 18.0, 0.22);
    U.uCloudSharp.value.set(1.6, (wp.base + 0.35 * (wp.top - wp.base)) / 1000, 1 / 0.32, 0);
    U.uCirrusW.value.set(ox * 2.2 + 3.0, oz * 2.2 - 5.0, 0, this.frame % 64);
    /* 円盤・星 */
    U.uSunDisk.value.fromArray(o.sunDisk);
    U.uMoonDisk.value.fromArray(o.moonDisk);
    U.uNightSky.value.set(o.stars, o.milky, -((h - 6) / 24) * Math.PI * 2, fz(F[NG.TIME * 4 + 2]));
    U.uSkyMisc.value.set(1, this.q.starSize, 0, 0);
  }

  _pass(mat, rt) {
    const r = this.renderer;
    const prev = r.getRenderTarget(), auto = r.autoClear;
    this._passMesh.material = mat;
    r.autoClear = false;
    r.setRenderTarget(rt);
    r.render(this._passScene, this._passCam);
    r.setRenderTarget(prev);
    r.autoClear = auto;
  }

  /* P1：LUT（haze が 2% 変わったら）→ 晴れの空 → 雲パノラマの帯 → skyView */
  _gpu(force = false) {
    const U = this.U, q = this.q;
    const haze = this.rig.A.haze;
    if (force || this.lutHaze < 0 || Math.abs(haze - this.lutHaze) > 0.02 * this.lutHaze) {
      this.lutHaze = haze;
      /* 描く先を読むサンプラーに束ねない（WebGL のフィードバックの禁止） */
      U.ngSkyTrans.value = null;
      U.uLutMode.value = 0; this._pass(this.mLut, this.rtTrans);
      U.ngSkyTrans.value = this.rtTrans.texture;
      U.uLutMode.value = 1; this._pass(this.mLut, this.rtMS);
    }
    U.uSteps.value = q.sky;
    /* 晴れの空：普段は 1/skyBands の帯（太陽は 0.25°/s しか動かない）、跳び・起動では全部 */
    const nb = this.full ? 1 : q.skyBands, bh = Math.ceil(SKY_H / nb), bi = this.frame % nb;
    if (nb > 1) { this.rtClear.scissor.set(0, bi * bh, SKY_W, bh); this.rtClear.scissorTest = true; }
    this._pass(this.mClear, this.rtClear);
    this.rtClear.scissorTest = false;
    /* 雲パノラマ：普段は 1/16 の帯、跳び・段の変更・起動では全部 */
    const [W, H] = q.pano, n = q.strips, rows = Math.ceil(H / n);
    /* 天候の遷移中（被覆・層状・腹が 1 巡りで 1% 以上動く）は 1 フレームに 4 帯を置き換えで描く。1 帯ずつだと
       古い帯と新しい帯の境が仰角の弧として見えた（本編の雨の入り） */
    const cw = U.uCloud.value, wNow = [cw.x, cw.w, U.uLight.value.w];
    const wPrev = this._wPrev || wNow;
    const dW = Math.max(Math.abs(wNow[0] - wPrev[0]), Math.abs(wNow[1] - wPrev[1]), Math.abs(wNow[2] - wPrev[2]));
    this._wPrev = wNow;
    const moving = !this.full && dW * n > 0.01;
    U.uMode.value.set(Math.max(q.steps, 1), q.light, this.full || moving ? 1 : 0.5, q.steps > 0 ? 0 : 1);
    const count = this.full ? n : moving ? Math.min(4, n) : 1;
    for (let k = 0; k < count; k++) {
      const si = stripAt(this.full ? k : this.strip + k, n);
      const y0 = si * rows, hh = Math.min(rows, H - y0);
      if (hh <= 0) continue;
      U.uPano.value.set(W, H, y0, hh);
      this._pass(this.mPano, this.rtStrip);
      this.rtPano.scissor.set(0, y0, W, hh);
      this.rtPano.scissorTest = true;
      U.uCopyMode.value = 1;
      U.uCloudPano.value = null;
      this._pass(this.mUtil, this.rtPano);
      U.uCloudPano.value = this.rtPano.texture;
      this.rtPano.scissorTest = false;
    }
    if (!this.full) this.strip = (this.strip + count) % n;
    this.full = false;
    U.uCopyMode.value = 0;
    this._pass(this.mUtil, this.rtView);
  }

  prepare(f) {
    if (!this.ready) return;
    this.frame++;
    this._gpu(false);
    this._probe();
  }

  /* GPU の空（雲込み）を 32×16 に縮めて非同期で CPU へ戻す（0.25s ごと）。リグは地平の整合・SH・sampleSky に
     その値を使う（CPU の雲の模型は GPU の雲パノラマと 20% ずれた）。跳びの後に描いた分だけを受け取る */
  _probe() {
    if (!this._probeOn || this._probePending) return;
    const now = performance.now();
    if (now - this._probeT < 250) return;
    this._probeT = now;
    const U = this.U;
    U.uCopyMode.value = 2;
    U.uSkyViewIn.value = this.rtView.texture;
    this._pass(this.mUtil, this.rtProbe);
    U.uSkyViewIn.value = null;
    U.uCopyMode.value = 0;
    const gen = this.rig.jumpGen;
    this._probePending = true;
    let p;
    try { p = this.renderer.readRenderTargetPixelsAsync(this.rtProbe, 0, 0, PROBE_W, PROBE_H, this._probeBuf); } catch (e) { p = Promise.reject(e); }
    /* three r180 は待つ間 PIXEL_PACK_BUFFER を束ねたままにする（他の同期の readPixels が INVALID_OPERATION になる）。
       読み戻しの続きは自分で束ね直すので、ここで外す */
    try { const gl = this.renderer.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch (e) { /* 無視 */ }
    Promise.resolve(p).then(() => {
      this._probePending = false;
      if (gen === this.rig.jumpGen) this.rig.setGpuSky(this._probeBuf, PROBE_W, PROBE_H);
    }, () => { this._probePending = false; this._probeOn = false; });
  }

  setQuality(tier) {
    this.tier = tier;
    this.q = skyTier(tier);
    if (this.ready) this._allocPano();
    this.full = true;
  }

  restoreGPU() {
    this.lutHaze = -1;
    this.full = true;
    this._bake().then(() => { this.full = true; }).catch(() => {});
  }

  stats() {
    return { draws: 1, tris: 1, instances: 0, texBytes: this.texBytes, programs: 5 };
  }

  dispose() {
    for (const r of [this.rtTrans, this.rtMS, this.rtClear, this.rtView, this.rtPano, this.rtStrip, this.rtProbe]) r?.dispose();
    for (const m of [this.mLut, this.mClear, this.mPano, this.mUtil, this.dome?.material]) m?.dispose();
    this._passMesh?.geometry.dispose();
    super.dispose();
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new SkyModule(ctx); }
