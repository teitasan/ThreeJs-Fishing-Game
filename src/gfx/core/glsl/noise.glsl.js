/* ===========================================================
   共有ノイズ（ARCHITECTURE §4.8）
   -----------------------------------------------------------
   - ハッシュは浮動小数（Dave Hoskins の hash without sine）。uint ハッシュは
     ドライバ差で結果が揺れるので使わない。JS 双子は noise.js の ngHash12
   - 周期版（…P）は period の整数倍でタイルする。forge の焼き込み用
   - すべて ng 接頭辞・インクルードガード付き（何度連結しても 1 回だけ宣言）
   =========================================================== */

/** ngHash12/22/33, ngHash13 */
export const NG_HASH_GLSL = /* glsl */ `
#ifndef NG_LIB_HASH
#define NG_LIB_HASH
float ngHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float ngHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 ngHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 ngHash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
#endif
`;

/** 値ノイズ・勾配ノイズ・Worley・fbm・ridged・warp と周期版 */
export const NG_NOISE_GLSL = NG_HASH_GLSL + /* glsl */ `
#ifndef NG_LIB_NOISE
#define NG_LIB_NOISE
/* 値ノイズ（0..1）。five-order の補間で 2 階微分まで連続 */
float ngVNoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = ngHash12(i), b = ngHash12(i + vec2(1.0, 0.0));
  float c = ngHash12(i + vec2(0.0, 1.0)), d = ngHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/* 値ノイズと解析的な勾配：vec3(値 0..1, ∂/∂x, ∂/∂y)。
   法線の細かい揺れを «差分で 3 回評価» せずに 1 回で出す（水面・濡れ面の詳細法線用） */
vec3 ngVNoise2D(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = ngHash12(i), b = ngHash12(i + vec2(1.0, 0.0));
  float c = ngHash12(i + vec2(0.0, 1.0)), d = ngHash12(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du * vec2(k1 + k3 * u.y, k2 + k3 * u.x));
}
/* 周期版：格子座標を period で折り返す */
float ngVNoise2P(vec2 p, vec2 period) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 i0 = mod(i, period), i1 = mod(i + 1.0, period);
  float a = ngHash12(i0), b = ngHash12(vec2(i1.x, i0.y));
  float c = ngHash12(vec2(i0.x, i1.y)), d = ngHash12(i1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float ngVNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = ngHash13(i), n100 = ngHash13(i + vec3(1, 0, 0));
  float n010 = ngHash13(i + vec3(0, 1, 0)), n110 = ngHash13(i + vec3(1, 1, 0));
  float n001 = ngHash13(i + vec3(0, 0, 1)), n101 = ngHash13(i + vec3(1, 0, 1));
  float n011 = ngHash13(i + vec3(0, 1, 1)), n111 = ngHash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
/* 勾配ノイズ（-1..1 付近） */
float ngGNoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = ngHash22(i) * 2.0 - 1.0, gb = ngHash22(i + vec2(1, 0)) * 2.0 - 1.0;
  vec2 gc = ngHash22(i + vec2(0, 1)) * 2.0 - 1.0, gd = ngHash22(i + vec2(1, 1)) * 2.0 - 1.0;
  float va = dot(ga, f), vb = dot(gb, f - vec2(1, 0));
  float vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 1.4142;
}
float ngGNoise2P(vec2 p, vec2 period) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 i0 = mod(i, period), i1 = mod(i + 1.0, period);
  vec2 ga = ngHash22(i0) * 2.0 - 1.0, gb = ngHash22(vec2(i1.x, i0.y)) * 2.0 - 1.0;
  vec2 gc = ngHash22(vec2(i0.x, i1.y)) * 2.0 - 1.0, gd = ngHash22(i1) * 2.0 - 1.0;
  float va = dot(ga, f), vb = dot(gb, f - vec2(1, 0));
  float vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 1.4142;
}
/* Worley：x = 最近点までの距離, y = 2 番目, z = セルの乱数 */
vec3 ngWorley2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = ngHash22(i + g);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = ngHash12(i + g + 17.3); } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, id);
}
vec3 ngWorley2P(vec2 p, vec2 period) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 c = mod(i + g, period);
    vec2 o = ngHash22(c);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = ngHash12(c + 17.3); } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, id);
}
float ngWorley3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    d1 = min(d1, length(g + ngHash33(i + g) - f));
  }
  return d1;
}
/* fbm（値ノイズ、0..1）。octaves は定数上限 8 のループで打ち切る */
float ngFbm(vec2 p, int octaves) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= octaves) break;
    s += a * ngVNoise2(p); n += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 19.1;
    a *= 0.5;
  }
  return s / n;
}
/* 周期版 fbm。オクターブごとに周期も 2 倍（回転しない） */
float ngFbmP(vec2 p, vec2 period, int octaves) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= octaves) break;
    s += a * ngVNoise2P(p, period); n += a;
    p *= 2.0; period *= 2.0;
    a *= 0.5;
  }
  return s / n;
}
/* 尾根ノイズ（0..1、尾根で 1） */
float ngRidged(vec2 p, int octaves) {
  float s = 0.0, a = 0.5, n = 0.0, w = 1.0;
  for (int k = 0; k < 8; k++) {
    if (k >= octaves) break;
    float r = 1.0 - abs(ngGNoise2(p));
    r *= r * w;
    w = clamp(r * 1.6, 0.0, 1.0);
    s += a * r; n += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.7;
    a *= 0.5;
  }
  return s / n;
}
/* ドメインワープ（Quilez）。amp は歪める距離（p と同じ単位） */
vec2 ngWarp(vec2 p, float amp) {
  return p + amp * (vec2(ngFbm(p + vec2(0.0, 0.0), 3), ngFbm(p + vec2(5.2, 1.3), 3)) - 0.5);
}
#endif
`;
