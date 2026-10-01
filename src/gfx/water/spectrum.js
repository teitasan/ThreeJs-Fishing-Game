/* ===========================================================
   水の細波：周期 FFT のスペクトル（three・DOM 無し。Node でテストする）
   -----------------------------------------------------------
   - JONSWAP（短い吹送距離 300m の湖）× cos^2s の方向分布。毛管波の分散 ω² = g k + (σ/ρ) k³
   - ω は 2π / loopSec の整数倍に量子化 → 時間方向にちょうど周期（焼いたループの継ぎ目が無い）。
     生きた FFT（mid / high）も同じ量子化で、t を CPU の倍精度で loopSec の剰余にしてから GPU へ渡す
     （float32 の ω·t が何時間でもずれない）
   - h0(k) は決定的なガウス乱数（seed とセルのハッシュ。Math.random を使わない）
   - 1 枚のタイル（一辺 L、N² の格子）。実体の FFT は GPU（fft.js）。ここには CPU の参照実装も置き、
     テストと lab の «GPU と CPU の一致» の確かめに使う
   - 規約：h(x, t) = Σ_k ĥ(k, t) e^{i k·x}、ĥ = h0(k) e^{iωt} + conj(h0(−k)) e^{−iωt}（実数の場）。
     E[|h0|²] = S(k) Δk² / 2 → Var(h) = Σ S Δk²。逆変換に 1/N² は掛けない
   =========================================================== */
import { hash01 } from '../../world/rng.js';

export const G = 9.81;
/** 表面張力 / 密度（m³/s²） */
export const SIGMA_RHO = 7.28e-5;

/** 分散関係（深水） */
export function dispersion(k) {
  return Math.sqrt(G * k + SIGMA_RHO * k * k * k);
}

/**
 * JONSWAP の周波数スペクトル S(ω)（m²·s）
 * @param {number} w ω rad/s
 * @param {number} U 風速 m/s（10m）
 * @param {number} F 吹送距離 m
 */
export function jonswap(w, U, F) {
  if (!(w > 0)) return 0;
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
  const wp = 22 * Math.pow((G * G) / (U * F), 1 / 3);
  const sigma = w <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((w - wp) * (w - wp)) / (2 * sigma * sigma * wp * wp));
  return (alpha * G * G) / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(3.3, r);
}

/** JONSWAP のピーク ω */
export function jonswapPeak(U, F) { return 22 * Math.pow((G * G) / (U * F), 1 / 3); }

/** 方向分布 cos^{2s}(θ/2) を [−π, π] で正規化したもの（Longuet-Higgins） */
export function spreading(theta, s) {
  /* 正規化：∫ cos^{2s}(θ/2) dθ = 2√π Γ(s+½)/Γ(s+1) */
  const norm = 1 / (2 * Math.sqrt(Math.PI) * Math.exp(lgamma(s + 0.5) - lgamma(s + 1)));
  return norm * Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s);
}

function lgamma(x) {
  /* Lanczos（g = 7）。x > 0 */
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 既定のスペクトルのパラメータ（湖：吹送距離 300m、基準の風 3.5m/s。実行時の風は振幅で掛ける） */
export const SPECTRUM_DEFAULTS = Object.freeze({
  L: 5.12,          // タイルの一辺 m（256² で 2cm のテクセル）
  U: 3.5,           // 基準の風速 m/s
  F: 300,           // 吹送距離 m
  spread: 6,        // cos^{2s} の s（短い吹送距離の風波は広がる）
  minLambda: 0.017, // 毛管の切り捨て m
  maxLambdaFrac: 0.5, // タイルの 1/2 より長い波は持たない（タイルの繰り返しを目立たせない）
  loopSec: 256,     // 生きた FFT の量子化の周期 s（float32 の精度のため）
  seed: 0x5eed,
});

/** 周波数の番号 i（0..N−1）→ 符号付きの波数の番号 */
export const freqIndex = (i, N) => (i < N / 2 ? i : i - N);

/**
 * h0 のスペクトルを作る
 * @param {{N:number, L?:number, U?:number, F?:number, spread?:number, minLambda?:number, maxLambdaFrac?:number, seed?:number}} o
 * @returns {{N:number, L:number, h0:Float32Array, slopeVar:number, heightVar:number}}
 *   h0：RGBA の並び（texel = j·N + i）に (h0(k).re, h0(k).im, conj(h0(−k)).re, conj(h0(−k)).im)。
 *   slopeVar：E[sx² + sz²]（m²/m²）、heightVar：E[h²]（m²）。どちらもスペクトルからの解析値
 */
export function buildSpectrum(o) {
  const p = { ...SPECTRUM_DEFAULTS, ...o };
  const { N, L, U, F, spread, minLambda, maxLambdaFrac, seed } = p;
  const dk = (2 * Math.PI) / L;
  const kMax = (2 * Math.PI) / minLambda, kMin = (2 * Math.PI) / (L * maxLambdaFrac);
  /* 1 の側：振幅 a(k) = sqrt(S(k) Δk² / 2) とガウス乱数 */
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  let slopeVar = 0, heightVar = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const m = freqIndex(i, N), n = freqIndex(j, N);
      /* ナイキストの行・列は 0（実数の出力のエルミート対称を崩さない） */
      if (m === -N / 2 || n === -N / 2 || (m === 0 && n === 0)) continue;
      const kx = m * dk, kz = n * dk, k = Math.hypot(kx, kz);
      if (k < kMin || k > kMax) continue;
      const w = dispersion(k);
      const dwdk = (G + 3 * SIGMA_RHO * k * k) / (2 * w);
      const theta = Math.atan2(kz, kx);
      /* S(k) = S(ω) D(θ) (dω/dk) / k */
      const Sk = jonswap(w, U, F) * spreading(theta, spread) * dwdk / k;
      const a = Math.sqrt(Math.max(Sk, 0) * dk * dk / 2);
      const u1 = Math.max(hash01(seed, i, j * 2 + 1), 1e-12), u2 = hash01(seed, i, j * 2);
      const r = Math.sqrt(-2 * Math.log(u1));
      re[j * N + i] = a * r * Math.cos(2 * Math.PI * u2);
      im[j * N + i] = a * r * Math.sin(2 * Math.PI * u2);
      /* 期待値（2 項 × |h0|² の期待 a²·2）：E|ĥ|² = S Δk² */
      heightVar += Sk * dk * dk;
      slopeVar += Sk * dk * dk * k * k;
    }
  }
  const h0 = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const t = j * N + i;
      const mi = (N - i) % N, mj = (N - j) % N, mt = mj * N + mi;   // −k
      h0[t * 4] = re[t];
      h0[t * 4 + 1] = im[t];
      h0[t * 4 + 2] = re[mt];
      h0[t * 4 + 3] = -im[mt];
    }
  }
  return { N, L, h0, slopeVar, heightVar, params: p };
}

/** ω を 2π/loopSec の整数倍に丸める（GLSL の uniform と同じ式。0 に丸めない：最小 1 段） */
export function quantizeOmega(w, loopSec) {
  const w0 = (2 * Math.PI) / loopSec;
  return Math.max(1, Math.round(w / w0)) * w0;
}

/**
 * ĥ(k, t) と勾配のスペクトルを CPU で作る（GPU の «evolve» と同じ式。テスト用）
 * @returns {{A:Float64Array, B:Float64Array}} 複素数（re, im 交互）。A = (i kx − kz) ĥ（sx + i sz に戻る）、B = ĥ
 */
export function evolveCPU(spec, t, loopSec) {
  const { N, L, h0 } = spec;
  const dk = (2 * Math.PI) / L;
  const A = new Float64Array(N * N * 2), B = new Float64Array(N * N * 2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const q = j * N + i;
      const kx = freqIndex(i, N) * dk, kz = freqIndex(j, N) * dk, k = Math.hypot(kx, kz);
      if (k === 0) continue;
      const w = quantizeOmega(dispersion(k), loopSec);
      const th = w * t, c = Math.cos(th), s = Math.sin(th);
      const ar = h0[q * 4], ai = h0[q * 4 + 1], br = h0[q * 4 + 2], bi = h0[q * 4 + 3];
      const hr = ar * c - ai * s + br * c + bi * s;
      const hi = ar * s + ai * c - br * s + bi * c;
      B[q * 2] = hr; B[q * 2 + 1] = hi;
      /* (−kz + i kx)(hr + i hi) */
      A[q * 2] = -kz * hr - kx * hi;
      A[q * 2 + 1] = -kz * hi + kx * hr;
    }
  }
  return { A, B };
}

/** 1 次元の逆 DFT（e^{+2πi nk/N}、正規化なし）を radix-2 の FFT で。in-place、N は 2 の冪 */
export function ifft1(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** 2 次元の逆 DFT（行 → 列）。z は re, im 交互の N² 複素数。結果を新しい配列で返す */
export function ifft2(z, N) {
  const out = Float64Array.from(z);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) { re[i] = out[(j * N + i) * 2]; im[i] = out[(j * N + i) * 2 + 1]; }
    ifft1(re, im);
    for (let i = 0; i < N; i++) { out[(j * N + i) * 2] = re[i]; out[(j * N + i) * 2 + 1] = im[i]; }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) { re[j] = out[(j * N + i) * 2]; im[j] = out[(j * N + i) * 2 + 1]; }
    ifft1(re, im);
    for (let j = 0; j < N; j++) { out[(j * N + i) * 2] = re[j]; out[(j * N + i) * 2 + 1] = im[j]; }
  }
  return out;
}

/**
 * CPU の参照：時刻 t のタイル（h, sx, sz）
 * @returns {{h:Float64Array, sx:Float64Array, sz:Float64Array, imagMax:number}} imagMax は «実数のはずの場» の虚部の最大
 */
export function tileCPU(spec, t, loopSec) {
  const { N } = spec;
  const { A, B } = evolveCPU(spec, t, loopSec);
  const a = ifft2(A, N), b = ifft2(B, N);
  const h = new Float64Array(N * N), sx = new Float64Array(N * N), sz = new Float64Array(N * N);
  let imagMax = 0;
  for (let q = 0; q < N * N; q++) {
    sx[q] = a[q * 2]; sz[q] = a[q * 2 + 1]; h[q] = b[q * 2];
    imagMax = Math.max(imagMax, Math.abs(b[q * 2 + 1]));
  }
  return { h, sx, sz, imagMax };
}

/**
 * 2 段の DFT（N = P·Q）の段の分け方。GPU の radix パス（fft.js）が使う
 * @param {number} N
 * @returns {[number, number]} [P, Q]
 */
export function fftFactors(N) {
  const lg = Math.round(Math.log2(N));
  const q = 1 << Math.floor(lg / 2), p = N / q;
  return [p, q];
}
