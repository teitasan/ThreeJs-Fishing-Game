/* ===========================================================
   見た目の風（ARCHITECTURE §4.6）
   -----------------------------------------------------------
   ngWindAt(xz) → vec4(風向 xy, その点の風速 m/s, 突風の強さ 0..1)
   38m と 13m の 2 オクターブの値ノイズの突風を、風下へ流す。
   水面の猫足・草の波・雨の傾き・霧の流れがすべてこれを見る。
   JS 双子は ../wind.js の Wind.sample（同じ式）
   =========================================================== */
import { NG_NOISE_GLSL } from './noise.glsl.js';

/** vec4 ngWindAt(vec2 xz)。NG_FRAME_GLSL の後に置く */
export const NG_WIND_GLSL = NG_NOISE_GLSL + /* glsl */ `
#ifndef NG_LIB_WIND
#define NG_LIB_WIND
vec4 ngWindAt(vec2 xz) {
  vec2 d = ngWindDir;
  float sp = ngWindSpeed;
  /* 突風の斑は風下へ 3m/s × 速さ係数で流れる（凪の日はゆっくり） */
  vec2 p = xz - d * (ngEnvTime * 3.0 * (0.5 + sp / 6.0));
  float g = 0.65 * ngVNoise2(p * (1.0 / 38.0)) + 0.35 * ngVNoise2(p * (1.0 / 13.0) + 7.1);
  float s = sp * max(1.0 + (g - 0.5) * 2.0 * ngGustAmp, 0.0);
  return vec4(d, s, g);
}
#endif
`;
