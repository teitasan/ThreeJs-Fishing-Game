/* ===========================================================
   caustics の焼き込み：周期スペクトル（spectrum.js）のヘッセ行列を時刻のフレームごとに焼き、
   uCaustTex（常に同じ DataArrayTexture）へ差し込む
   -----------------------------------------------------------
   - forge.bakeArrayPixels を 1 層ずつ（間で forge.step() に譲る。1 回 ≤ 30ms）
   - 値は 0.5 中心の RGBA8（±hScale → 0..1）。rgb = (hxx, hyy, hxy)、a = 1
   - 焼いた後に «平均の補正» c（CAUSTICS_GLSL の m(x) = 1 + c·x²·e^(−0.35x²)）を CPU で当てはめる
   =========================================================== */
import { updateCausticsTexture } from '../../shaders.js';
import { CS_WAVES, causticSpectrum, spectrumHessian, causticIntensity, spectrumUniforms } from './spectrum.js';

const BAKE_FRAG = /* glsl */ `
uniform vec4 ngCsW[${CS_WAVES}];
uniform float ngCsJ[${CS_WAVES}];
uniform float ngCsL;
uniform float ngCsHs;
uniform float ngCsPh;      // 最初の層の位相
uniform float ngCsStack;   // 縦に積んだ層の数（1 回の描画と読み戻しで何層も焼く）
uniform float ngCsFrames;
void main() {
  float ly = floor(vUv.y * ngCsStack);
  vec2 x = vec2(vUv.x, fract(vUv.y * ngCsStack)) * ngCsL;
  float ph = ngCsPh + ly / ngCsFrames;
  vec3 H = vec3(0.0);
  for (int i = 0; i < ${CS_WAVES}; i++) {
    vec4 w = ngCsW[i];
    float c = cos(dot(w.xy, x) - 6.28318531 * ngCsJ[i] * ph + w.w);
    H -= (w.z * c) * vec3(w.x * w.x, w.y * w.y, w.x * w.y);
  }
  gl_FragColor = vec4(clamp(0.5 + 0.5 * H / ngCsHs, 0.0, 1.0), 1.0);
}
`;

/**
 * 平均の補正 c を当てはめる：D·|H|rms = x のときの 1/|det| の平均 ≈ 1 + c·x²·e^(−0.35x²)
 * @param {ReturnType<typeof causticSpectrum>} S
 * @param {number} eps
 */
export function fitMeanCorrection(S, eps) {
  const xs = [0.25, 0.5, 0.75, 1.0, 1.3];
  let num = 0, den = 0;
  const N = 48;
  for (const x of xs) {
    const D = x / S.hessRms;
    let s = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const H = spectrumHessian(S, ((i + 0.37) / N) * S.period, ((j + 0.61) / N) * S.period, 0.13);
      s += causticIntensity(H[0], H[1], H[2], D, eps);
    }
    const m = s / (N * N);
    const g = x * x * Math.exp(-0.35 * x * x);
    num += (m - 1) * g; den += g * g;
  }
  return den > 0 ? Math.max(0, num / den) : 0;
}

/**
 * 焼いて差し込む
 * @param {object} ctx モジュールの ctx（forge・caustics）
 * @param {{ tile:number, frames:number }} cfg 段の表（quality.js）
 * @param {object} [o] { seed, period, eps }
 * @returns {Promise<{ spectrum: ReturnType<typeof causticSpectrum>, meanC: number, ms: number, bytes: number }>}
 */
export async function bakeCaustics(ctx, cfg, o = {}) {
  const T = ctx.THREE, forge = ctx.forge, cu = ctx.caustics;
  const t0 = performance.now();
  const S = causticSpectrum({ seed: o.seed, period: o.period, jMax: Math.max(1, Math.floor(cfg.frames / 8)) });
  const { W, J } = spectrumUniforms(S, T);
  const n = cfg.tile, layers = cfg.frames;
  const data = new Uint8Array(n * n * 4 * layers);
  const u = {
    ngCsW: { value: W }, ngCsJ: { value: J }, ngCsL: { value: S.period }, ngCsHs: { value: S.hScale }, ngCsPh: { value: 0 },
    ngCsStack: { value: 1 }, ngCsFrames: { value: layers },
  };
  /* 層を縦に積んで 1 回で描いて読み戻す（読み戻しの同期の回数を減らす。行の順 = 層の順 = DataArrayTexture の並び） */
  const stack = Math.max(1, Math.min(layers, Math.floor(4096 / n)));
  let busy = 0;
  for (let l = 0; l < layers; l += stack) {
    const k = Math.min(stack, layers - l);
    u.ngCsPh.value = l / layers;
    u.ngCsStack.value = k;
    const b0 = performance.now();
    const img = forge.bakeArrayPixels({ w: n, h: n * k, layers: 1, frag: BAKE_FRAG, uniforms: u });
    data.set(img.data, l * n * n * 4);
    busy += performance.now() - b0;
    await forge.step();
  }
  const meanC = fitMeanCorrection(S, o.eps ?? 0.12);
  if (cu?.uCaustTex) updateCausticsTexture(cu, { data, width: n, height: n, depth: layers });
  return { spectrum: S, meanC, ms: busy, wallMs: performance.now() - t0, bytes: data.byteLength * 1.33 };
}
