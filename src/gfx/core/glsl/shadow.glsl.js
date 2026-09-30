/* ===========================================================
   高さ場の太陽影と ngSunVisibility（ARCHITECTURE §4.5）
   -----------------------------------------------------------
   近景（three の影マップ、注視点 ±R）の外は、地形 + 樹冠の高さ場を
   key 方向へ raymarch して焼いた R8（2 段：±256m / ±1024m）を使う。
   0.8R〜R で近景 → 高さ場へ移し、雲影を掛ける。
   uniforms は shadows.js の HfShadow.uniforms（共有の {value}）
   =========================================================== */

/** ngHfShadow(P) / ngHfShadowFar(P) / ngSunVisibility(P, nearVis)。NG_MEDIUM_GLSL の後に置く */
export const NG_SHADOW_GLSL = /* glsl */ `
#ifndef NG_LIB_SHADOW
#define NG_LIB_SHADOW
uniform sampler2D ngHfShadow0;   // 段 0：±256m（low では使わない）
uniform sampler2D ngHfShadow1;   // 段 1：±1024m
uniform vec4 ngHfShadowXf;       // x = 1/(2·R0), y = 1/(2·R1), z = 段 0 が有効なら 1
float ngHfShadow(vec3 P) {
  float s1 = texture(ngHfShadow1, P.xz * ngHfShadowXf.y + 0.5).r;
  if (ngHfShadowXf.z < 0.5) return s1;
  vec2 uv0 = P.xz * ngHfShadowXf.x + 0.5;
  float e = 2.0 * max(abs(uv0.x - 0.5), abs(uv0.y - 0.5));
  float s0 = texture(ngHfShadow0, clamp(uv0, 0.0, 1.0)).r;
  return mix(s0, s1, smoothstep(0.85, 1.0, e));
}
/* 近景の影と重ねないための重み（注視点から 0.8R〜R で 0→1） */
float ngNearToFar(vec3 P) {
  return smoothstep(0.8 * ngNearShadowR, ngNearShadowR, length(P.xz - ngFocus.xz));
}
float ngHfShadowFar(vec3 P) { return mix(1.0, ngHfShadow(P), ngNearToFar(P)); }
float ngSunVisibility(vec3 P, float nearVis) {
  return mix(nearVis, ngHfShadow(P), ngNearToFar(P)) * ngCloudShadow(P);
}
#endif
`;
