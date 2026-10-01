/* water の細波スペクトルと 2 段の DFT の検査（src/gfx/water/spectrum.js、three 無し）
   - h0 は決定的（同じ seed で同じ値）・実数の場（逆変換の虚部 ≈ 0）
   - 分散がスペクトルの解析値と合う（Var(sx)+Var(sz) ≈ slopeVar、±20%）
   - ω の量子化で時間方向にちょうど周期（t と t + LOOP で同じ）
   - GPU と同じ 2 段の DFT（N = P·Q、各段 16 点）が radix-2 の ifft1 と一致する（N = 256 と 128） */
import assert from 'node:assert/strict';
import { buildSpectrum, tileCPU, ifft1, dft2Stage1D, fftFactors, quantizeOmega, dispersion } from '../../src/gfx/water/spectrum.js';
import { WATER_CASCADES, WATER_FFT_LOOP, WATER_TIERS } from '../../src/gfx/water/quality.js';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

/* 2 段の DFT と ifft1 */
for (const N of [256, 128, 64]) {
  const [P, Q] = fftFactors(N);
  ok(P * Q === N && P <= 16 && Q <= 16, `fftFactors(${N}) = ${P}·${Q}`);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { re[i] = Math.sin(i * 0.37) + (i % 7) * 0.1; im[i] = Math.cos(i * 1.3) * 0.5; }
  const a = dft2Stage1D(re, im);
  const br = Float64Array.from(re), bi = Float64Array.from(im);
  ifft1(br, bi);
  let err = 0;
  for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(a.re[i] - br[i]), Math.abs(a.im[i] - bi[i]));
  ok(err < 1e-9, `2 段の DFT（N=${N}）と ifft1 の差 ${err}`);
}

/* 段の FFT の大きさは 2 段に分けられる */
for (const t of Object.values(WATER_TIERS)) { const [P, Q] = fftFactors(t.fftN); ok(P <= 16 && Q <= 16, `段の fftN ${t.fftN}`); }

/* カスケードの帯が重ならない */
for (let c = 1; c < WATER_CASCADES.length; c++) ok(WATER_CASCADES[c].minLambda >= WATER_CASCADES[c - 1].maxLambda - 1e-9, 'カスケードの帯が重なる');

for (const cas of WATER_CASCADES) {
  const o = { N: 128, L: cas.L, minLambda: cas.minLambda, maxLambda: cas.maxLambda, seed: cas.seed };
  const s1 = buildSpectrum(o), s2 = buildSpectrum(o);
  ok(s1.h0.every((v, i) => v === s2.h0[i]), '決定的でない');
  ok(s1.h0.every(Number.isFinite), 'h0 に NaN');
  const T1 = tileCPU(s1, 7.25, WATER_FFT_LOOP);
  ok(T1.imagMax < 1e-9, `虚部 ${T1.imagMax}`);
  let v = 0;
  for (let q = 0; q < T1.h.length; q++) v += T1.sx[q] ** 2 + T1.sz[q] ** 2;
  v /= T1.h.length;
  ok(Math.abs(v / s1.slopeVar - 1) < 0.2, `勾配の分散 ${v} vs ${s1.slopeVar}`);
  const T2 = tileCPU(s1, 7.25 + WATER_FFT_LOOP, WATER_FFT_LOOP);
  let d = 0;
  for (let q = 0; q < T1.h.length; q++) d = Math.max(d, Math.abs(T1.sx[q] - T2.sx[q]));
  ok(d < 1e-6, `周期でない ${d}`);
}

/* 量子化は 0 に丸めない・相対誤差は小さい（λ ≤ 4.5m） */
const w = dispersion((2 * Math.PI) / 4.5);
ok(Math.abs(quantizeOmega(w, WATER_FFT_LOOP) / w - 1) < 0.01, '量子化の誤差');
ok(quantizeOmega(1e-6, WATER_FFT_LOOP) > 0, '0 に丸めた');

console.log(`water-spectrum: ${n} 件合格`);
