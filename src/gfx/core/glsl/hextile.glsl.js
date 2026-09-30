/* ===========================================================
   ヘックスタイリング（Mikkelsen 2022, "Practical Real-Time Hex-Tiling"）
   -----------------------------------------------------------
   三角格子の 3 頂点ごとに uv をずらし・回して重ね、繰り返しの目を消す。
   微分は元の uv から取って回すので、mip の選択が継ぎ目で跳ばない。
   重みは輝度のコントラストで尖らせる（ぼやけた平均にしない）
   =========================================================== */
import { NG_HASH_GLSL } from './noise.glsl.js';

/**
 * vec4 ngHexTile(sampler2D tex, vec2 uv, float rotStrength)
 * vec4 ngHexTileArr(sampler2DArray tex, vec2 uv, float layer, float rotStrength)
 * rotStrength はラジアンの最大回転（0 で平行移動だけ）
 */
export const NG_HEXTILE_GLSL = NG_HASH_GLSL + /* glsl */ `
#ifndef NG_LIB_HEXTILE
#define NG_LIB_HEXTILE
void ngHexGrid(vec2 st, out vec3 w, out vec2 v1, out vec2 v2, out vec2 v3) {
  st *= 3.46410162;   // 2·√3：1 タイルに三角形が収まる大きさ
  vec2 sk = mat2(1.0, -0.57735027, 0.0, 1.15470054) * st;
  vec2 base = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(0.0, -t.z);
  float s2 = 2.0 * s - 1.0;
  w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  v1 = base + vec2(s, s);
  v2 = base + vec2(s, 1.0 - s);
  v3 = base + vec2(1.0 - s, s);
}
mat2 ngHexRot(vec2 v, float rotStrength) {
  float a = (ngHash12(v * 1.37 + 3.1) * 2.0 - 1.0) * rotStrength;
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}
vec3 ngHexWeights(vec3 w, vec3 lum) {
  vec3 p = w * w * w * (1.0 + 6.0 * lum * lum);   // 明るい方が勝つ＝模様が混ざらずに切り替わる
  return p / max(p.x + p.y + p.z, 1e-6);
}
vec4 ngHexTile(sampler2D tex, vec2 uv, float rotStrength) {
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 w; vec2 v1, v2, v3;
  ngHexGrid(uv, w, v1, v2, v3);
  mat2 r1 = ngHexRot(v1, rotStrength), r2 = ngHexRot(v2, rotStrength), r3 = ngHexRot(v3, rotStrength);
  vec2 c1 = v1 / 3.46410162, c2 = v2 / 3.46410162, c3 = v3 / 3.46410162;
  vec4 a = textureGrad(tex, r1 * (uv - c1) + c1 + ngHash22(v1), r1 * dx, r1 * dy);
  vec4 b = textureGrad(tex, r2 * (uv - c2) + c2 + ngHash22(v2), r2 * dx, r2 * dy);
  vec4 c = textureGrad(tex, r3 * (uv - c3) + c3 + ngHash22(v3), r3 * dx, r3 * dy);
  vec3 L = vec3(dot(a.rgb, vec3(0.2126, 0.7152, 0.0722)), dot(b.rgb, vec3(0.2126, 0.7152, 0.0722)), dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)));
  vec3 W = ngHexWeights(w, L);
  return a * W.x + b * W.y + c * W.z;
}
vec4 ngHexTileArr(sampler2DArray tex, vec2 uv, float layer, float rotStrength) {
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 w; vec2 v1, v2, v3;
  ngHexGrid(uv, w, v1, v2, v3);
  mat2 r1 = ngHexRot(v1, rotStrength), r2 = ngHexRot(v2, rotStrength), r3 = ngHexRot(v3, rotStrength);
  vec2 c1 = v1 / 3.46410162, c2 = v2 / 3.46410162, c3 = v3 / 3.46410162;
  vec4 a = textureGrad(tex, vec3(r1 * (uv - c1) + c1 + ngHash22(v1), layer), r1 * dx, r1 * dy);
  vec4 b = textureGrad(tex, vec3(r2 * (uv - c2) + c2 + ngHash22(v2), layer), r2 * dx, r2 * dy);
  vec4 c = textureGrad(tex, vec3(r3 * (uv - c3) + c3 + ngHash22(v3), layer), r3 * dx, r3 * dy);
  vec3 L = vec3(dot(a.rgb, vec3(0.2126, 0.7152, 0.0722)), dot(b.rgb, vec3(0.2126, 0.7152, 0.0722)), dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)));
  vec3 W = ngHexWeights(w, L);
  return a * W.x + b * W.y + c * W.z;
}
#endif
`;
