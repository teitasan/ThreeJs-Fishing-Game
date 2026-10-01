/* ===========================================================
   高さ場の太陽影と ngSunVisibility（ARCHITECTURE §4.5）
   -----------------------------------------------------------
   近景（three の影マップ、注視点 ±R）の外は、地形 + 樹冠の高さ場を
   key 方向へ raymarch して焼いた R8（2 段：±256m / ±1024m）を使う。
   0.8R〜R で近景 → 高さ場へ移し、雲影を掛ける。
   uniforms は shadows.js の HfShadow.uniforms（共有の {value}）
   =========================================================== */

/**
 * ngHfShadow(P) / ngHfShadowFar(P) / ngSunVisibility(P, nearVis) / ngSunVisibilityC(P, nearVis, cloud)。
 * NG_MEDIUM_GLSL の後に置く。fog チャンクを含むシェーダは頂点の雲影 vNgCloud を渡す C 版を使う
 * （ngCloudShadow を断片で評価しない。docs/nextgen/spikes.md S-3）
 */
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
float ngSunVisibilityC(vec3 P, float nearVis, float cloud) {
  return mix(nearVis, ngHfShadow(P), ngNearToFar(P)) * cloud;
}
float ngSunVisibility(vec3 P, float nearVis) { return ngSunVisibilityC(P, nearVis, ngCloudShadow(P)); }
#endif
`;

/**
 * 全画面の効果（post の光芒・underwater の光の筋など）が «近景の影マップ» を読むための部品。
 * uniforms は ctx.shadows.nearUniforms（{value} は段を替えても同じ。中身は毎フレームの近景の影の後に core が入れ直す）。
 * float ngNearShadowAt(vec3 P)：世界の点 P が key の近景の影の中なら 0、日向なら 1（3×3 の二次 B スプラインの PCF =
 * ngShadowPCF と同じ重み、three の RGBA 詰めの深度、bias 込み、shadow.intensity（雲量で 1 → 0.35）を掛けた後）。
 * 影マップの外（注視点 ±extent の外・光の手前と奥）は 1。normalBias は掛けない（空中の点を読む前提）。
 * 範囲の外の遮蔽は ngHfShadowFar（NG_SHADOW_GLSL）と ngNearToFar で繋ぐ。サンプラー 1
 */
export const NG_NEAR_SHADOW_GLSL = /* glsl */ `
#ifndef NG_LIB_NEAR_SHADOW
#define NG_LIB_NEAR_SHADOW
uniform sampler2D ngNearShadowMap;     // three の key.shadow.map.texture（RGBA に詰めた深度）。無ければ 1×1 の白（= 日向）
uniform mat4 ngNearShadowMatrix;       // 世界 → 影マップの uv と深さ [0,1]（key.shadow.matrix）
uniform vec4 ngNearShadowParams;       // x = 大きさ px, y = 1/大きさ, z = bias（深さの単位）, w = 影の強さ（shadow.intensity）
float ngNearUnpack(vec4 v) { return dot(v, vec4(255.0 / 256.0, 255.0 / 65536.0, 255.0 / 16777216.0, 1.0 / 16777216.0)); }
float ngNearTap(vec2 uv, float z) { return step(z, ngNearUnpack(texture(ngNearShadowMap, uv))); }
float ngNearShadowAt(vec3 P) {
  vec4 c = ngNearShadowMatrix * vec4(P, 1.0);
  vec3 s = c.xyz / max(c.w, 1e-6);
  s.z += ngNearShadowParams.z;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0 || s.z < 0.0 || s.z > 1.0) return 1.0;
  float size = max(ngNearShadowParams.x, 1.0), inv = ngNearShadowParams.y;
  vec2 t = s.xy * size, cc = floor(t), d = t - cc - 0.5;
  vec2 w0 = 0.5 * (0.5 - d) * (0.5 - d), w1 = 0.75 - d * d, w2 = 0.5 * (0.5 + d) * (0.5 + d);
  vec2 p = (cc + 0.5) * inv;
  float sum = 0.0;
  for (int j = -1; j <= 1; j++) {
    float wy = j < 0 ? w0.y : (j == 0 ? w1.y : w2.y);
    for (int i = -1; i <= 1; i++) {
      float wx = i < 0 ? w0.x : (i == 0 ? w1.x : w2.x);
      sum += wx * wy * ngNearTap(p + vec2(float(i), float(j)) * inv, s.z);
    }
  }
  return mix(1.0, sum, ngNearShadowParams.w);
}
#endif
`;
