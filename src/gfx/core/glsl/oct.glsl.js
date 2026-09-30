/* ===========================================================
   八面体の法線符号化（RGBA8 の 2 成分に単位ベクトルを詰める）
   JS 双子は heightfield.js の octEncode（テストと CPU 焼き込み用）
   =========================================================== */

/** ngOctEncode(vec3) → vec2 [0,1]、ngOctDecode(vec2 [0,1]) → vec3 */
export const NG_OCT_GLSL = /* glsl */ `
#ifndef NG_LIB_OCT
#define NG_LIB_OCT
vec2 ngOctWrap(vec2 v) { return (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0); }
vec2 ngOctEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.z >= 0.0 ? n.xy : ngOctWrap(n.xy);
  return e * 0.5 + 0.5;
}
vec3 ngOctDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = clamp(-n.z, 0.0, 1.0);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}
#endif
`;
