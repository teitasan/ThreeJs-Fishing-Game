/* ===========================================================
   細波の «生きた» 周期 FFT（GPU）
   -----------------------------------------------------------
   - h0(k) は CPU（spectrum.js、決定的）。毎フレーム GPU で ĥ(k, t) を作り、2 段の DFT（N = P·Q、
     各段 16 点の直接和）を横 2 回・縦 2 回で逆変換する（4 パス + カスケードごとの書き出し）
   - 2 つのカスケード（帯を分けたタイル）を 1 枚の横並びの作業 RT（RGBA32F：RG = 勾配 sx + i·sz、BA = 高さ h）で同時に回す
   - 書き出しはカスケードごとの RGBA16F（mip 付き・繰り返し）：(sx, sz, sx² + sz², h)。
     mip はハードウェアの線形平均なので «1 次と 2 次のモーメント» が正しく縮む → LEAN / Toksvig の分散がそのまま読める
   - ω は 2π/LOOP の整数倍（LOOP = 256s）。CPU が τ = (t mod LOOP)/LOOP を倍精度で作って渡す
     → float32 の ω·t が何時間でもずれない。時間方向の折り返し（焼いたループのクロスフェード）が無い
   - プログラムは 1 本（段は uniform）。自前の全画面三角形のシーン（forge は読み込みの最後に作業用の
     マテリアルを捨てるので、毎フレームの処理には使わない）
   =========================================================== */
import { ngShaderMaterial } from '../core/extend.js';
import { buildSpectrum, G, SIGMA_RHO } from './spectrum.js';
import { WATER_CASCADES, WATER_FFT_LOOP, WATER_FFT_U } from './quality.js';

const VS = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/* 2 段の DFT（逆変換 W = e^{+2πi/M}）：
     段 0：Y[k1·Q + n2] = W_N^{n2·k1} Σ_{n1<P} x[Q·n1 + n2] W_P^{n1·k1}
     段 1：X[k1 + P·k2] = Σ_{n2<Q} Y[k1·Q + n2] W_Q^{n2·k2}
   uStage：0 = 横の段 0（入力は h0 から ĥ(k, t) を作る）、1 = 横の段 1、2 = 縦の段 0、3 = 縦の段 1（書き出し） */
const FS = /* glsl */ `
precision highp float;
uniform highp sampler2D uSrc;
uniform highp sampler2D uH0;
uniform float uStage;
uniform float uN;
uniform float uP;
uniform float uQ;
uniform vec2 uL;        // カスケード 0 / 1 のタイルの一辺 m
uniform float uTau;     // (t mod LOOP) / LOOP
uniform float uLoop;
uniform float uCas;     // 書き出すカスケード（段 3）
#define NG_TAU 6.28318530718

vec2 ngCmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 ngW(float num, float den) { float a = NG_TAU * num / den; return vec2(cos(a), sin(a)); }

/* ĥ(k, t) と勾配のスペクトル：A = (i kx − kz) ĥ（逆変換で sx + i·sz）、B = ĥ（逆変換で h） */
vec4 ngEvolve(float c, float i, float j) {
  vec4 h0 = texelFetch(uH0, ivec2(int(c * uN + i), int(j)), 0);
  float fi = i < uN * 0.5 ? i : i - uN;
  float fj = j < uN * 0.5 ? j : j - uN;
  float dk = NG_TAU / (c < 0.5 ? uL.x : uL.y);
  float kx = fi * dk, kz = fj * dk;
  float k = sqrt(kx * kx + kz * kz);
  if (k < 1e-6) return vec4(0.0);
  float w = sqrt(${G} * k + ${SIGMA_RHO} * k * k * k);
  float w0 = NG_TAU / uLoop;
  float n = max(1.0, floor(w / w0 + 0.5));
  float th = NG_TAU * fract(n * uTau);
  float cs = cos(th), sn = sin(th);
  float hr = h0.x * cs - h0.y * sn + h0.z * cs + h0.w * sn;
  float hi = h0.x * sn + h0.y * cs - h0.z * sn + h0.w * cs;
  return vec4(-kz * hr - kx * hi, -kz * hi + kx * hr, hr, hi);
}

void main() {
  vec2 fc = floor(gl_FragCoord.xy);
  bool horiz = uStage < 1.5;
  bool first = uStage < 0.5 || (uStage > 1.5 && uStage < 2.5);
  float c = uStage > 2.5 ? uCas : floor(fc.x / uN);
  float x = uStage > 2.5 ? fc.x : fc.x - c * uN;   // カスケードの中の位置
  float y = fc.y;
  float o = horiz ? x : y;                         // この軸の出力の番号
  vec4 acc = vec4(0.0);
  if (first) {
    float k1 = floor(o / uQ), n2 = o - k1 * uQ;
    for (int m = 0; m < 16; m++) {
      if (float(m) >= uP) break;
      float idx = uQ * float(m) + n2;
      vec4 v = uStage < 0.5 ? ngEvolve(c, idx, y)
             : texelFetch(uSrc, horiz ? ivec2(int(c * uN + idx), int(y)) : ivec2(int(c * uN + x), int(idx)), 0);
      vec2 w = ngW(mod(float(m) * k1, uP), uP);
      acc += vec4(ngCmul(v.xy, w), ngCmul(v.zw, w));
    }
    vec2 tw = ngW(mod(n2 * k1, uN), uN);
    acc = vec4(ngCmul(acc.xy, tw), ngCmul(acc.zw, tw));
  } else {
    float k1 = mod(o, uP), k2 = floor(o / uP);
    for (int m = 0; m < 16; m++) {
      if (float(m) >= uQ) break;
      float idx = k1 * uQ + float(m);
      vec4 v = texelFetch(uSrc, horiz ? ivec2(int(c * uN + idx), int(y)) : ivec2(int(c * uN + x), int(idx)), 0);
      vec2 w = ngW(mod(float(m) * k2, uQ), uQ);
      acc += vec4(ngCmul(v.xy, w), ngCmul(v.zw, w));
    }
  }
  if (uStage > 2.5) {
    /* 書き出し：(sx, sz, sx² + sz², h)。NaN は 0 へ */
    vec4 r = vec4(acc.x, acc.y, acc.x * acc.x + acc.y * acc.y, acc.z);
    gl_FragColor = all(equal(r, r)) ? r : vec4(0.0);
  } else {
    gl_FragColor = acc;
  }
}
`;

/** N = P·Q（P, Q ≤ 16） */
export function fftSplit(N) {
  const lg = Math.round(Math.log2(N));
  const q = 1 << Math.floor(lg / 2);
  return [N / q, q];
}

/**
 * 細波の FFT（カスケード 2 枚）
 */
export class WaterFFT {
  /**
   * @param {object} ctx モジュールの ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.T = ctx.THREE;
    this.N = 0;
    this.C = WATER_CASCADES.length;
    this.outs = [];
    this.ping = null;
    this.pong = null;
    this.h0 = null;
    this.spectra = [];
    this.uniforms = {
      uSrc: { value: null }, uH0: { value: null }, uStage: { value: 0 }, uN: { value: 256 }, uP: { value: 16 }, uQ: { value: 16 },
      uL: { value: new this.T.Vector2(WATER_CASCADES[0].L, WATER_CASCADES[1].L) }, uTau: { value: 0 }, uLoop: { value: WATER_FFT_LOOP },
      uCas: { value: 0 },
    };
    this.material = null;
    this._scene = null;
    this._cam = null;
    this.frames = 0;
    this.lastTau = -1;
    /* 解析の勾配の分散（カスケードごと、U = WATER_FFT_U のとき） */
    this.slopeVar = [0, 0];
  }

  /**
   * 段の FFT の一辺で作り直す（CPU の h0 も N ごと。読み込みの中で呼ぶ。数十 ms）
   * @param {number} N 128 | 256
   * @param {number} aniso
   */
  async build(N, aniso = 4) {
    const T = this.T, ctx = this.ctx;
    if (N === this.N && this.outs.length) return;
    this.disposeTargets();
    this.N = N;
    const [P, Q] = fftSplit(N);
    const u = this.uniforms;
    u.uN.value = N; u.uP.value = P; u.uQ.value = Q;
    /* h0：カスケードを横に並べた RGBA32F */
    const data = new Float32Array(N * this.C * N * 4);
    for (let c = 0; c < this.C; c++) {
      const cas = WATER_CASCADES[c];
      const s = buildSpectrum({ N, L: cas.L, U: WATER_FFT_U, F: 300, minLambda: cas.minLambda, maxLambda: cas.maxLambda, seed: cas.seed });
      this.slopeVar[c] = s.slopeVar;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const src = (j * N + i) * 4, dst = (j * N * this.C + c * N + i) * 4;
          data[dst] = s.h0[src]; data[dst + 1] = s.h0[src + 1]; data[dst + 2] = s.h0[src + 2]; data[dst + 3] = s.h0[src + 3];
        }
      }
      await ctx.forge?.step?.();
    }
    const h0 = new T.DataTexture(data, N * this.C, N, T.RGBAFormat, T.FloatType);
    h0.magFilter = h0.minFilter = T.NearestFilter;
    h0.generateMipmaps = false;
    h0.needsUpdate = true;
    this.h0 = h0;
    u.uH0.value = h0;
    /* 作業 RT（32F が描けなければ 16F） */
    const r = ctx.renderer;
    const f32 = !!r.extensions?.has?.('EXT_color_buffer_float');
    const work = () => {
      const rt = new T.WebGLRenderTarget(N * this.C, N, { depthBuffer: false, type: f32 ? T.FloatType : T.HalfFloatType, format: T.RGBAFormat });
      rt.texture.magFilter = rt.texture.minFilter = T.NearestFilter;
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.ping = work();
    this.pong = work();
    for (let c = 0; c < this.C; c++) {
      const rt = new T.WebGLRenderTarget(N, N, { depthBuffer: false, type: T.HalfFloatType, format: T.RGBAFormat });
      const tx = rt.texture;
      tx.wrapS = tx.wrapT = T.RepeatWrapping;
      tx.magFilter = T.LinearFilter;
      tx.minFilter = T.LinearMipmapLinearFilter;
      tx.generateMipmaps = true;
      tx.anisotropy = Math.min(aniso, r.capabilities?.getMaxAnisotropy?.() || 1);
      tx.name = `ng-water-fft${c}`;
      this.outs.push(rt);
    }
    if (!this.material) {
      this.material = ngShaderMaterial({
        key: 'water-fft', module: 'water', lights: false, fog: false,
        uniforms: this.uniforms, vertexShader: VS, fragmentShader: FS,
        depthTest: false, depthWrite: false,
      });
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      const mesh = new T.Mesh(g, this.material);
      mesh.frustumCulled = false;
      this._scene = new T.Scene();
      this._scene.add(mesh);
      this._cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    this.lastTau = -1;
  }

  /**
   * 時刻 t（s、倍精度）のタイルを作る。同じ τ なら何もしない（ポーズ）
   * @param {number} t
   */
  run(t) {
    if (!this.outs.length || !this.material) return;
    const loop = WATER_FFT_LOOP;
    const tt = Number.isFinite(t) ? t : 0;
    let tau = (tt % loop) / loop;
    if (tau < 0) tau += 1;
    if (tau === this.lastTau) return;
    this.lastTau = tau;
    const r = this.ctx.renderer, u = this.uniforms;
    const prev = r.getRenderTarget(), auto = r.autoClear;
    r.autoClear = false;
    try {
      u.uTau.value = tau;
      let src = this.ping, dst = this.pong;
      for (let s = 0; s < 3; s++) {
        u.uStage.value = s;
        u.uSrc.value = s === 0 ? null : src.texture;
        r.setRenderTarget(dst);
        r.render(this._scene, this._cam);
        const tmp = src; src = dst; dst = tmp;
      }
      u.uStage.value = 3;
      u.uSrc.value = src.texture;
      for (let c = 0; c < this.C; c++) {
        u.uCas.value = c;
        r.setRenderTarget(this.outs[c]);
        r.render(this._scene, this._cam);
      }
      this.frames++;
    } finally {
      r.setRenderTarget(prev);
      r.autoClear = auto;
    }
  }

  /** 書き出しのテクスチャ（カスケード c） */
  tex(c) { return this.outs[c]?.texture || null; }

  texBytes() {
    const N = this.N;
    return N ? N * N * this.C * 16 * 3 + this.C * N * N * 8 * 1.34 : 0;
  }

  disposeTargets() {
    this.ping?.dispose(); this.pong?.dispose();
    for (const o of this.outs) o.dispose();
    this.outs = [];
    this.ping = this.pong = null;
    this.h0?.dispose();
    this.h0 = null;
  }

  dispose() {
    this.disposeTargets();
    this.material?.dispose();
    this._scene?.children[0]?.geometry.dispose();
    this.material = null;
  }
}
