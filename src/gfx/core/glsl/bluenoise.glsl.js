/* ===========================================================
   ブルーノイズ（起動時に forge.bakeBlueNoise が void-and-cluster で焼く 64²）
   フレームごとに黄金比で回して、時間方向にも偏らないディザにする
   =========================================================== */

/** uniform sampler2D ngBlueNoiseTex と float ngBlueNoise(vec2 fragCoord, float frameIndex) → [0,1) */
export const NG_BLUENOISE_GLSL = /* glsl */ `
#ifndef NG_LIB_BLUENOISE
#define NG_LIB_BLUENOISE
uniform sampler2D ngBlueNoiseTex;
float ngBlueNoise(vec2 fragCoord, float frameIndex) {
  float v = texelFetch(ngBlueNoiseTex, ivec2(fragCoord) & ivec2(63), 0).r;
  return fract(v + frameIndex * 0.61803398875);
}
#endif
`;
