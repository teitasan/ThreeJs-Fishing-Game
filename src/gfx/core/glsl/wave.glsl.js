/* ===========================================================
   波の GLSL（ngWaveH / ngWaveD / ngWaveDisp / ngShoreRunUp / ngShoalGain）を «長時間ずれない» 形で出す
   -----------------------------------------------------------
   waveField.js の waveGLSL({prefix:'ng'}) は定数を toFixed(5) で焼くので、ω の丸め × 時刻の分だけ
   位相がずれる（1 時間で最大 1.8mm、core-requests B-2）。waveField.js は 1 バイトも変えない約束なので、
   生成物の «t × ω_i» の 5 か所（各 3 回：高さ・勾配・水平変位）だけを
       (ngWavePh_i + (t − ngWaterTime) × ω_i)
   に置き換える。ngWavePh_i = mod(water.time · ω_i, 2π) は core が JS の倍精度で毎フレーム ngFrame の
   slot 19 / 20 に書く（完全な精度の ω は waveField の W[i].om）。
   - 呼び出し側が t に ngWaterTime と同じ値（water.time の uniform）を渡すと (t − ngWaterTime) は厳密に 0 で、
     位相は倍精度で求めた値そのもの（float32 の t · ω の丸めも消える）。別の時刻を渡しても式は正しい
   - 遡上（ngShoreRunUp）の «t × ω·3.4» と «t × 0.30» は渚の見た目だけなので置き換えない
   - 置き換えが 15 か所ちょうどでなければ（waveField の生成物の形が変わった）元の GLSL のまま使い、
     NG_WAVE_PHASE_OK = false（wave-phase テストが落ちる）
   three を import しない（Node のテストから読む）
   =========================================================== */
import { waveGLSL, W } from '../../../waveField.js?v=20260828-lakescale1';

const TAU = Math.PI * 2;

/** slot 19 / 20 の成分名（frame.js の NG_SLOTS と同じ）。i 番目の波の位相 */
export const NG_WAVE_PHASE_FIELDS = Object.freeze(['ngWavePhA.x', 'ngWavePhA.y', 'ngWavePhA.z', 'ngWavePhA.w', 'ngWavePhB']);

/**
 * ngFrame の位相で置き換えた波の GLSL を作る
 * @returns {{glsl: string, replaced: number}}
 */
export function ngWaveGLSL() {
  const src = waveGLSL({ prefix: 'ng' });
  let out = src, replaced = 0;
  W.forEach((w, i) => {
    const om = w.om.toFixed(5);
    const from = `- t * ${om} + phase`;
    const to = `- (${NG_WAVE_PHASE_FIELDS[i]} + (t - ngWaterTime) * ${om}) + phase`;
    const parts = out.split(from);
    replaced += parts.length - 1;
    out = parts.join(to);
  });
  const ok = replaced === W.length * 3 && W.length === NG_WAVE_PHASE_FIELDS.length;
  return { glsl: (ok ? out : src), replaced };
}

const built = ngWaveGLSL();

/** 置き換えが期待どおりに効いたか */
export const NG_WAVE_PHASE_OK = built.replaced === W.length * 3;

/**
 * 波の GLSL（waveGLSL({prefix:'ng'}) と同じ関数名・引数）。NG_FRAME_GLSL の後ろに置くこと
 * （ngWavePhA / ngWavePhB / ngWaterTime のマクロを使う）。ngShaderMaterial は先頭に NG_FRAME_GLSL を入れる
 */
export const NG_WAVE_GLSL = `#ifndef NG_LIB_WAVE\n#define NG_LIB_WAVE\n${built.glsl}\n#endif\n`;

/**
 * 時刻 t（water.time、秒）の各波の位相 mod(t·ω_i, 2π) を倍精度で求める
 * @param {number} t
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]} 5 本
 */
export function wavePhases(t, out = new Float64Array(W.length)) {
  const tt = Number.isFinite(t) ? t : 0;
  for (let i = 0; i < W.length; i++) {
    const p = (tt * W[i].om) % TAU;
    out[i] = p < 0 ? p + TAU : p;
  }
  return out;
}
