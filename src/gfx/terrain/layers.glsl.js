/* ===========================================================
   地面の 8 層を起動時に GPU で焼く（forge.bakeArray の断片）
   -----------------------------------------------------------
   配列 A（RGBA8）：rgb = √(線形アルベド)（暗い色の段を防ぐ。素材が 2 乗で戻す）、a = 高さ 0..1
   配列 B（RGBA8・線形）：xy = 接空間の法線（u = 世界 x、v = 世界 z）、z = 粗さ、w = AO
   - A は «形の関数» を 1 回だけ評価する（点の散布・Voronoi・周期ノイズ）。B は A を texelFetch して
     勾配（Sobel）と空洞（2 つの輪の平均との差）から作る（重い関数を 13 回評価しない）
   - すべて周期（タイル）で作る：格子のハッシュは mod(セル, N)、ノイズは周期版。継ぎ目は無い
   - 層ごとの色は palette.js（NG_ALBEDO）の範囲の線形アルベド
   層：0 林床（杉の落葉・広葉の落ち葉・小枝）、1 苔、2 草地の土（芝の敷き藁）、3 玉石の浜、
       4 浅場の砂とシルト（波紋）、5 深場の泥、6 安山岩（地衣類）、7 踏み跡の土
   =========================================================== */
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';

/** 層ごとのタイルの一辺 m（素材のシェーダと同じ表） */
export const TERRAIN_TILE_M = Object.freeze([3.0, 2.5, 3.2, 2.4, 4.0, 4.0, 6.0, 3.0]);
/** 層ごとの起伏 m（A の高さ 0..1 が表す深さ。法線の強さ） */
export const TERRAIN_RELIEF_M = Object.freeze([0.018, 0.03, 0.016, 0.055, 0.010, 0.010, 0.06, 0.016]);
/** 濡れの多孔質さ（ngWetSurface） */
export const TERRAIN_POROSITY = Object.freeze([0.6, 0.35, 0.75, 0.35, 0.9, 0.5, 0.25, 0.85]);
export const TERRAIN_LAYER_NAMES = Object.freeze(['litter', 'moss', 'meadow', 'cobble', 'sand', 'mud', 'rock', 'trail']);

const COMMON = NG_NOISE_GLSL + /* glsl */ `
float ngTbSeed;
mat2 ngTbRot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec4 ngTbH4(vec2 c, float P, float s) {
  vec2 m = mod(c, P) + vec2(ngTbSeed * 3.17 + s * 11.3, ngTbSeed * 1.71 + s * 7.9);
  return vec4(ngHash22(m), ngHash22(m + 41.37));
}
float ngTbH1(vec2 c, float P, float s) { return ngHash12(mod(c, P) + vec2(s * 13.1 + ngTbSeed * 2.3, s * 5.7)); }
/* 周期の値ノイズ（種つき）。p は格子の単位、P は周期（整数） */
float ngTbVN(vec2 p, float P, float s) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = ngTbH1(i, P, s), b = ngTbH1(i + vec2(1.0, 0.0), P, s);
  float c = ngTbH1(i + vec2(0.0, 1.0), P, s), d = ngTbH1(i + vec2(1.0, 1.0), P, s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/* 周期の fbm（uv は 0..1 のタイル、P は最初のオクターブの周期） */
float ngTbFbm(vec2 uv, float P, float s, int oct) {
  float t = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 7; k++) {
    if (k >= oct) break;
    t += a * ngTbVN(uv * P, P, s + float(k) * 7.13);
    n += a; P *= 2.0; a *= 0.5;
  }
  return t / n;
}
/* 周期の Worley：x = F1、y = F2、z = 最近のセルの乱数、w = 2 番目のセルの乱数 */
vec4 ngTbWorley(vec2 p, float P, float s, float jit) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id1 = 0.0, id2 = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec4 r = ngTbH4(i + g, P, s);
    float d = length(g + 0.5 + (r.xy - 0.5) * jit - f);
    if (d < d1) { d2 = d1; id2 = id1; d1 = d; id1 = r.z; } else if (d < d2) { d2 = d; id2 = r.z; }
  }
  return vec4(d1, d2, id1, id2);
}
float ngTbSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
/* 落ち葉を重ねる（上に乗る物ほど高い）。palette：0 = 林床の落ち葉、1 = 泥の中の黒い葉片 */
void ngTbLeaves(vec2 uv, float N, float size, float lift, float s, float dens, float pal, inout vec3 col, inout float h) {
  vec2 p = uv * N, ic = floor(p);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = ic + vec2(float(x), float(y));
    vec4 r = ngTbH4(c, N, s);
    if (fract(r.w * 9.31 + r.x) > dens) continue;
    float sz = size * (0.65 + 0.7 * r.w);
    vec2 q = ngTbRot(r.z * 6.2832) * (p - c - r.xy) / sz;
    float x0 = q.x;
    if (abs(x0) > 1.3) continue;
    float wide = 0.34 + 0.24 * fract(r.w * 7.3);
    float wid = wide * pow(max(1.0 - x0 * x0, 0.0), 0.7) * (1.0 + 0.22 * x0);
    float ser = 1.0 + 0.07 * sin(x0 * 30.0 + r.y * 6.0) * step(0.5, fract(r.x * 3.3));
    float ay = abs(q.y);
    bool stem = x0 < -0.92 && x0 > -1.28 && ay < 0.03;
    if (ay > wid * ser && !stem) continue;
    float yy = stem ? 0.0 : ay / max(wid, 1e-3);
    float zr = fract(r.x * 13.7 + r.y * 5.1);
    float curl = (1.0 - yy * yy) * (0.4 + 0.6 * fract(r.z * 9.1));
    float hh = lift + zr * 0.22 + 0.16 * curl - 0.05 * exp(-ay * ay / 0.0006) + 0.04 * abs(x0);
    if (hh <= h) continue;
    h = hh;
    float k = fract(r.x * 31.1 + r.w * 3.7);
    vec3 lc;
    if (pal < 0.5) {
      lc = k < 0.30 ? vec3(0.235, 0.125, 0.048) : k < 0.58 ? vec3(0.165, 0.102, 0.058) : k < 0.82 ? vec3(0.080, 0.056, 0.036) : vec3(0.275, 0.205, 0.120);
    } else {
      lc = mix(vec3(0.055, 0.046, 0.034), vec3(0.090, 0.072, 0.048), k);
    }
    lc *= 0.82 + 0.34 * fract(r.y * 17.3);
    float vein = smoothstep(0.035, 0.0, ay) * 0.35 + 0.18 * smoothstep(0.86, 1.0, sin((x0 * 8.0 - ay * 5.5) * 3.1416));
    lc *= 1.0 - vein * 0.45;
    float spot = smoothstep(0.58, 0.8, ngTbVN(q * 3.5 + r.xy * 50.0, 4096.0, s + 3.0));
    lc = mix(lc, lc * 0.45, spot * 0.7);
    lc *= 0.78 + 0.22 * smoothstep(1.0, 0.55, yy);
    col = lc;
  }
}
/* 杉の落ちた小枝（縄のような針葉の束） */
void ngTbNeedles(vec2 uv, float N, float lift, float s, float dens, inout vec3 col, inout float h) {
  vec2 p = uv * N, ic = floor(p);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = ic + vec2(float(x), float(y));
    vec4 r = ngTbH4(c, N, s);
    if (r.w > dens) continue;
    vec2 ctr = c + r.xy;
    float ang = r.z * 6.2832;
    vec2 d = vec2(cos(ang), sin(ang));
    float L = 0.45 + 0.55 * fract(r.x * 7.7);
    vec2 pl = p - ctr;
    float t = dot(pl, d), o = dot(pl, vec2(-d.y, d.x));
    o -= 0.08 * sin(t * 3.0 + r.y * 6.0);                  // 少し曲げる
    float rope = 0.07 + 0.045 * abs(sin(t * 24.0 + o * 9.0));
    if (abs(o) > rope || abs(t) > L) continue;
    float e = abs(o) / rope;
    float hh = lift + 0.18 * fract(r.y * 5.3) + 0.14 * (1.0 - e * e);
    if (hh <= h) continue;
    h = hh;
    vec3 nc = mix(vec3(0.175, 0.078, 0.036), vec3(0.105, 0.072, 0.048), fract(r.w * 11.3 + r.x));
    col = nc * (0.62 + 0.45 * (1.0 - e)) * (0.85 + 0.3 * abs(sin(t * 24.0)));
  }
}
/* 小枝・根（長い線） */
void ngTbTwigs(vec2 uv, float N, float lift, float s, float dens, float w0, vec3 c0, vec3 c1, inout vec3 col, inout float h) {
  vec2 p = uv * N, ic = floor(p);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = ic + vec2(float(x), float(y));
    vec4 r = ngTbH4(c, N, s);
    if (r.w > dens) continue;
    vec2 ctr = c + r.xy;
    vec2 d = vec2(cos(r.z * 6.2832), sin(r.z * 6.2832));
    float L = 0.55 + 0.4 * fract(r.x * 5.1);
    vec2 a = ctr - d * L, b = ctr + d * L;
    vec2 bend = vec2(-d.y, d.x) * 0.12 * (fract(r.y * 3.7) - 0.5);
    float dist = min(ngTbSeg(p, a, ctr + bend), ngTbSeg(p, ctr + bend, b));
    float wid = w0 * (0.7 + 0.6 * fract(r.y * 9.7));
    if (dist > wid) continue;
    float e = dist / wid;
    float hh = lift + 0.35 * sqrt(max(1.0 - e * e, 0.0));
    if (hh <= h) continue;
    h = hh;
    float bark = 0.85 + 0.3 * ngTbVN(vec2(dot(p - ctr, d) * 60.0, e * 3.0), 4096.0, s);
    col = mix(c0, c1, fract(r.w * 13.1)) * bark * (0.7 + 0.3 * (1.0 - e));
  }
}
/* 短い草の葉（芝の敷き藁）。dry = 枯れ草の割合 */
void ngTbBlades(vec2 uv, float N, float lift, float s, float dry, inout vec3 col, inout float h) {
  vec2 p = uv * N, ic = floor(p);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = ic + vec2(float(x), float(y));
    vec4 r = ngTbH4(c, N, s);
    vec2 base = c + r.xy;
    vec2 d = vec2(cos(r.z * 6.2832), sin(r.z * 6.2832));
    float L = 0.55 + 0.6 * r.w;
    vec2 pl = p - base;
    float t = dot(pl, d), o = dot(pl, vec2(-d.y, d.x));
    o -= 0.15 * t * t * (fract(r.x * 7.1) - 0.5);           // 葉の反り
    if (t < 0.0 || t > L) continue;
    float wid = 0.085 * (1.0 - 0.75 * t / L);
    if (abs(o) > wid) continue;
    float hh = lift + 0.25 * (t / L) + 0.1 * fract(r.y * 3.3);
    if (hh <= h) continue;
    h = hh;
    float k = fract(r.x * 17.9 + r.w);
    vec3 g = k < 0.5 ? vec3(0.055, 0.105, 0.028) : vec3(0.088, 0.138, 0.036);
    vec3 dr = mix(vec3(0.175, 0.155, 0.082), vec3(0.120, 0.105, 0.060), fract(r.y * 5.7));
    vec3 bc = step(fract(r.z * 23.1), dry) > 0.5 ? dr : g;
    col = bc * (0.65 + 0.45 * (t / L)) * (0.85 + 0.3 * (1.0 - abs(o) / wid));
  }
}
/* 石の色（玉石・小石）。k はセルの乱数、q は石の中の位置 */
vec3 ngTbStoneColor(float k, vec2 q, float s) {
  vec3 c = k < 0.34 ? vec3(0.200, 0.196, 0.186)                  // 安山岩の灰
         : k < 0.52 ? vec3(0.092, 0.092, 0.088)                  // 黒い玄武岩
         : k < 0.72 ? vec3(0.255, 0.212, 0.160)                  // 褐色の砂岩
         : k < 0.88 ? vec3(0.330, 0.318, 0.292)                  // 白っぽい花崗岩
         : vec3(0.230, 0.160, 0.120);                            // 赤みのチャート
  float n = ngTbVN(q * 6.0 + k * 91.0, 4096.0, s);
  c *= 0.86 + 0.28 * n;
  if (k >= 0.72 && k < 0.88) {                                   // 花崗岩のごま塩
    float g = ngHash12(floor(q * 40.0) + k * 37.0);
    c = mix(c, vec3(0.05), step(0.86, g) * 0.8);
  }
  float vein = smoothstep(0.035, 0.0, abs(fract(dot(q, vec2(0.8, 0.6)) * 1.7 + k * 9.0) - 0.5) - 0.0) * step(0.8, fract(k * 17.0));
  return mix(c, vec3(0.36, 0.35, 0.33), vein * 0.8);             // 石英の筋
}
/* 玉石の層：Worley のセルを石に（縁 = F2 − F1 で丸く）。dens = 石のある割合 */
void ngTbStones(vec2 uv, float N, float lift, float s, float dens, float tall, inout vec3 col, inout float h) {
  vec2 p = uv * N;
  vec2 wp = vec2(ngTbFbm(uv, N * 0.5, s + 1.0, 2), ngTbFbm(uv, N * 0.5, s + 2.0, 2)) - 0.5;
  vec4 w = ngTbWorley(p + wp * 0.5, N, s, 0.85);
  if (fract(w.z * 7.77) > dens) return;
  float e = w.y - w.x;
  /* r4：0.03–0.30 の sqrt は天辺が平らで隙間が細く «石畳» に見えた → 広い帯の円の断面（丸い玉石）と太い隙間 */
  float edge = smoothstep(0.04, 0.55, e);
  float dome = sqrt(edge * (2.0 - edge)) * (0.55 + 0.45 * fract(w.z * 3.3)) * tall;
  float hh = lift + dome;
  if (hh <= h || edge <= 0.0) return;
  float k = fract(w.z * 13.37);
  vec3 sc = ngTbStoneColor(k, p, s);
  sc *= 0.58 + 0.42 * smoothstep(0.04, 0.5, e);                 // 縁は回り込んで暗い
  col = mix(col, sc, smoothstep(0.04, 0.12, e));
  h = mix(h, hh, smoothstep(0.04, 0.12, e));
}

/* ---------------- 層ごとの «形の関数»：vec4(アルベド, 高さ) ---------------- */
vec4 ngTbLitter(vec2 uv) {
  float n1 = ngTbFbm(uv, 10.0, 1.0, 4), n2 = ngTbFbm(uv, 64.0, 2.0, 3);
  vec3 col = mix(vec3(0.034, 0.026, 0.018), vec3(0.070, 0.052, 0.033), n1) * (0.8 + 0.4 * n2);
  float h = 0.12 * n1;
  ngTbNeedles(uv, 64.0, 0.10, 3.0, 0.9, col, h);
  ngTbLeaves(uv, 40.0, 0.50, 0.24, 4.0, 0.85, 0.0, col, h);
  ngTbNeedles(uv, 48.0, 0.34, 5.0, 0.55, col, h);
  ngTbLeaves(uv, 26.0, 0.56, 0.38, 6.0, 0.7, 0.0, col, h);
  ngTbTwigs(uv, 7.0, 0.52, 7.0, 0.55, 0.018, vec3(0.13, 0.105, 0.080), vec3(0.085, 0.068, 0.050), col, h);
  ngTbLeaves(uv, 15.0, 0.52, 0.56, 8.0, 0.35, 0.0, col, h);
  return vec4(col, clamp(h, 0.0, 1.0));
}
vec4 ngTbMoss(vec2 uv) {
  vec4 w1 = ngTbWorley(uv * 12.0, 12.0, 1.0, 0.9), w2 = ngTbWorley(uv * 34.0, 34.0, 2.0, 0.9);
  float cush = smoothstep(0.95, 0.05, w1.x) * 0.6 + smoothstep(0.85, 0.05, w2.x) * 0.4;
  float fine = ngTbFbm(uv, 150.0, 3.0, 3);
  float fuzz = ngTbVN(uv * 512.0, 512.0, 4.0);
  float h = cush * 0.65 + fine * 0.22 + fuzz * 0.13;
  vec3 deep = vec3(0.028, 0.055, 0.017), yel = vec3(0.100, 0.140, 0.032);
  float t = clamp(cush * 0.75 + (fine - 0.5) * 0.9 + (w1.z - 0.5) * 0.5, 0.0, 1.0);
  vec3 col = mix(deep, yel, t);
  float dead = smoothstep(0.6, 0.78, ngTbFbm(uv, 5.0, 5.0, 3));
  col = mix(col, vec3(0.085, 0.072, 0.034), dead * 0.6);
  col *= 0.72 + 0.5 * fuzz;
  /* 蒴（ほそい赤褐色の点） */
  vec4 sp = ngTbH4(floor(uv * 300.0), 300.0, 9.0);
  float spore = step(0.94, sp.x) * smoothstep(0.35, 0.1, length(fract(uv * 300.0) - sp.yz));
  col = mix(col, vec3(0.16, 0.07, 0.03), spore * 0.8);
  return vec4(col, clamp(h + spore * 0.1, 0.0, 1.0));
}
vec4 ngTbMeadow(vec2 uv) {
  float n1 = ngTbFbm(uv, 8.0, 1.0, 4), n2 = ngTbVN(uv * 300.0, 300.0, 2.0);
  vec3 col = mix(vec3(0.040, 0.036, 0.022), vec3(0.068, 0.060, 0.034), n1) * (0.8 + 0.4 * n2);
  float h = 0.08 * n1;
  ngTbStones(uv, 90.0, 0.0, 3.0, 0.05, 0.2, col, h);
  float dry = 0.10 + 0.40 * smoothstep(0.4, 0.8, ngTbFbm(uv, 4.0, 4.0, 3));
  ngTbBlades(uv, 96.0, 0.08, 5.0, dry, col, h);
  ngTbBlades(uv, 72.0, 0.24, 6.0, dry * 0.85, col, h);
  ngTbBlades(uv, 56.0, 0.40, 7.0, dry * 0.7, col, h);
  ngTbBlades(uv, 42.0, 0.56, 10.0, dry * 0.55, col, h);
  vec4 cl = ngTbWorley(uv * 20.0, 20.0, 8.0, 0.8);
  if (cl.z > 0.72) {
    vec2 q = fract(uv * 160.0) - 0.5;
    float a = atan(q.y, q.x);
    float leaf = smoothstep(0.42, 0.36, length(q) / (0.55 + 0.45 * abs(cos(a * 1.5))));
    float m = leaf * smoothstep(0.42, 0.2, cl.x) * step(0.3, ngTbH1(floor(uv * 160.0), 160.0, 9.0));
    col = mix(col, vec3(0.045, 0.092, 0.026) * (0.85 + 0.3 * n2), m);
    h = mix(h, 0.8, m);
  }
  return vec4(col, clamp(h, 0.0, 1.0));
}
vec4 ngTbCobble(vec2 uv) {
  float g1 = ngTbVN(uv * 320.0, 320.0, 1.0), g2 = ngTbVN(uv * 900.0, 900.0, 2.0);
  vec3 col = vec3(0.215, 0.188, 0.150) * (0.72 + 0.4 * g1) * (0.85 + 0.3 * g2);
  float h = 0.06 * g1;
  ngTbStones(uv, 70.0, 0.02, 3.0, 0.9, 0.35, col, h);
  ngTbStones(uv, 22.0, 0.05, 4.0, 0.76, 0.95, col, h);           // 隙間の砂が見える割合
  ngTbStones(uv, 11.0, 0.10, 5.0, 0.35, 0.9, col, h);
  return vec4(col, clamp(h, 0.0, 1.0));
}
vec4 ngTbSand(vec2 uv) {
  vec2 w = vec2(ngTbFbm(uv, 3.0, 1.0, 3), ngTbFbm(uv, 3.0, 2.0, 3)) - 0.5;
  float phi = 6.2832 * (34.0 * uv.x + 9.0 * uv.y) + 10.0 * w.x + 3.0 * sin(6.2832 * (2.0 * uv.x - uv.y) + 6.0 * w.y);
  float rip = 0.5 + 0.5 * sin(phi + 0.75 * sin(phi));
  float amp = 0.35 + 0.65 * smoothstep(0.25, 0.7, ngTbFbm(uv, 2.0, 3.0, 3));
  float grain = ngTbVN(uv * 800.0, 800.0, 4.0);
  float h = rip * amp * 0.65 + grain * 0.12 + 0.2 * ngTbFbm(uv, 8.0, 5.0, 3);
  vec3 sand = vec3(0.325, 0.282, 0.210), silt = vec3(0.215, 0.192, 0.152);
  /* 波紋は主に起伏（法線）で見せる。色の縞は谷の細かい粒の溜まりだけ（弱く）：乾いた浜で縞模様が目立ちすぎた */
  vec3 col = mix(mix(silt, sand, 0.78), sand, smoothstep(0.1, 0.8, rip * amp + 0.45 * (1.0 - amp)));
  col *= 0.9 + 0.2 * ngTbFbm(uv, 6.0, 6.0, 3);                    // 乾きと粒径の斑
  col *= 0.86 + 0.26 * grain;
  float dk = step(0.975, ngTbH1(floor(uv * 1000.0), 1000.0, 7.0));
  float lt = step(0.985, ngTbH1(floor(uv * 1000.0), 1000.0, 8.0));
  col = col * (1.0 - 0.55 * dk) + lt * 0.12;
  ngTbStones(uv, 48.0, 0.18, 9.0, 0.10, 0.35, col, h);
  return vec4(col, clamp(h, 0.0, 1.0));
}
vec4 ngTbMud(vec2 uv) {
  float n = ngTbFbm(uv, 4.0, 1.0, 5), m = ngTbFbm(uv, 28.0, 2.0, 3), gr = ngTbVN(uv * 600.0, 600.0, 5.0);
  vec3 col = mix(vec3(0.088, 0.080, 0.064), vec3(0.132, 0.118, 0.094), n) * (0.88 + 0.24 * m) * (0.94 + 0.12 * gr);
  float h = n * 0.55 + m * 0.2 + gr * 0.04;
  vec4 w = ngTbWorley(uv * 46.0, 46.0, 3.0, 0.9);
  float hole = step(0.8, w.z);
  float pit = smoothstep(0.11, 0.03, w.x) * hole;
  float rim = smoothstep(0.2, 0.12, w.x) * smoothstep(0.05, 0.12, w.x) * hole;
  h += rim * 0.05 - pit * 0.15;
  col *= 1.0 - pit * 0.3;
  ngTbLeaves(uv, 26.0, 0.32, h + 0.02, 6.0, 0.14, 1.0, col, h);
  /* 小枝は短く疎らに（4m の層で 1 セル 0.25m → 長さ 0.3–0.5m。長い直線は引っかき傷に見えた） */
  ngTbTwigs(uv, 16.0, h + 0.02, 7.0, 0.07, 0.03, vec3(0.07, 0.06, 0.045), vec3(0.05, 0.045, 0.035), col, h);
  return vec4(col, clamp(h, 0.0, 1.0));
}
vec4 ngTbRock(vec2 uv) {
  /* 安山岩：歪めた座標の節理（一部の境だけが割れる）・細かい割れ・鉄の錆の暖色・地衣類はまばら */
  vec2 wq = vec2(ngTbFbm(uv, 4.0, 11.0, 4), ngTbFbm(uv, 4.0, 12.0, 4)) - 0.5;
  vec2 u2 = uv + wq * 0.09;
  float b = ngTbFbm(u2, 3.0, 1.0, 6);
  vec4 wa = ngTbWorley(u2 * 4.0, 4.0, 2.0, 1.0);
  float sel = step(0.42, fract((wa.z + wa.w) * 7.31));
  float crackA = (1.0 - smoothstep(0.0, 0.03 + 0.03 * b, wa.y - wa.x)) * sel;
  vec4 wb = ngTbWorley(u2 * 13.0, 13.0, 3.0, 1.0);
  float crackB = (1.0 - smoothstep(0.0, 0.018, wb.y - wb.x)) * step(0.62, fract((wb.z + wb.w) * 5.13)) * 0.7;
  float fine = ngTbFbm(uv, 48.0, 4.0, 4);
  float grit = ngTbVN(uv * 700.0, 700.0, 6.0);
  float h = 0.42 * b + 0.14 * wa.z + 0.2 * fine + 0.06 * grit + 0.22 - 0.3 * crackA - 0.12 * crackB;
  vec3 base = vec3(0.172, 0.166, 0.156) * (0.76 + 0.42 * b) * (0.93 + 0.14 * wa.z) * (0.9 + 0.2 * fine) * (0.93 + 0.14 * grit);
  base *= mix(vec3(1.0), vec3(1.10, 1.0, 0.86), smoothstep(0.45, 0.8, ngTbFbm(uv, 2.0, 9.0, 3)) * 0.8);
  float sp = step(0.955, ngTbH1(floor(uv * 720.0), 720.0, 3.0));
  float sd = step(0.95, ngTbH1(floor(uv * 640.0), 640.0, 4.0));
  base = mix(base, vec3(0.30, 0.29, 0.27), sp * 0.5) * (1.0 - sd * 0.4);
  base = mix(base, vec3(0.040, 0.046, 0.032), crackA * 0.8);
  base *= 1.0 - crackB * 0.35;
  float lf = ngTbFbm(uv, 6.0, 6.0, 4);
  vec4 wl = ngTbWorley(uv * 28.0, 28.0, 7.0, 0.9);
  float lichen = smoothstep(0.62, 0.66, lf + 0.05 * fine) * (1.0 - crackA);
  float spots = smoothstep(0.26, 0.17, wl.x) * step(0.72, wl.z) * smoothstep(0.5, 0.6, lf);
  lichen = max(lichen, spots);
  vec3 lc = mix(vec3(0.225, 0.235, 0.19), vec3(0.27, 0.27, 0.245), wl.z);
  lc = mix(lc, vec3(0.30, 0.19, 0.06), step(0.95, wl.z) * smoothstep(0.22, 0.1, wl.x));
  base = mix(base, lc * (0.85 + 0.3 * fine), lichen * 0.8);
  /* 苔の縁取り（窪みと割れ目に暗い緑） */
  float hollow = smoothstep(0.42, 0.25, h);
  base = mix(base, vec3(0.045, 0.065, 0.028), hollow * 0.45 * smoothstep(0.45, 0.6, ngTbFbm(uv, 5.0, 13.0, 3)));
  return vec4(base, clamp(h + lichen * 0.03, 0.0, 1.0));
}
vec4 ngTbTrail(vec2 uv) {
  float n = ngTbFbm(uv, 5.0, 1.0, 5), m = ngTbFbm(uv, 32.0, 2.0, 3), g = ngTbVN(uv * 520.0, 520.0, 3.0);
  vec3 col = mix(vec3(0.100, 0.076, 0.052), vec3(0.158, 0.122, 0.082), n) * (0.88 + 0.24 * m) * (0.9 + 0.2 * g);
  float h = 0.32 * n + 0.15 * m + 0.05 * g;
  /* 踏み固めの窪み（楕円） */
  vec4 fp = ngTbWorley(uv * 9.0, 9.0, 4.0, 0.7);
  float foot = smoothstep(0.35, 0.18, fp.x) * step(0.55, fp.z);
  h -= foot * 0.12; col *= 1.0 - foot * 0.12;
  ngTbStones(uv, 52.0, 0.2, 5.0, 0.32, 0.45, col, h);
  ngTbTwigs(uv, 10.0, 0.3, 6.0, 0.22, 0.026, vec3(0.115, 0.080, 0.055), vec3(0.085, 0.060, 0.040), col, h);
  ngTbLeaves(uv, 16.0, 0.48, 0.5, 8.0, 0.22, 0.0, col, h);
  return vec4(col, clamp(h, 0.0, 1.0));
}
vec4 ngTbLayer(int L, vec2 uv) {
  ngTbSeed = float(L) + 1.0;
  if (L == 0) return ngTbLitter(uv);
  if (L == 1) return ngTbMoss(uv);
  if (L == 2) return ngTbMeadow(uv);
  if (L == 3) return ngTbCobble(uv);
  if (L == 4) return ngTbSand(uv);
  if (L == 5) return ngTbMud(uv);
  if (L == 6) return ngTbRock(uv);
  return ngTbTrail(uv);
}
`;

/** 配列 A：アルベド + 高さ */
export const TERRAIN_BAKE_A = COMMON + /* glsl */ `
void main() {
  int L = int(ngLayer + 0.5);
  vec2 uv = (floor(vUv / ngTexel) + 0.5) * ngTexel;
  vec4 c = ngTbLayer(L, uv);
  /* RGBA8 の線形だと暗い林床（0.03〜0.1）で段がつくので √ で詰める（素材が 2 乗で戻す） */
  gl_FragColor = vec4(sqrt(max(c.rgb, vec3(0.0))), c.a);
}
`;

/** 配列 B：A の高さから法線（Sobel）・空洞の AO・粗さ */
export const TERRAIN_BAKE_B = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray ngSrcA;
uniform float ngTileM[8];
uniform float ngReliefM[8];
float ngTbHA(ivec2 p, ivec2 sz, int L) { return texelFetch(ngSrcA, ivec3((p + sz * 4) % sz, L), 0).a; }
void main() {
  int L = int(ngLayer + 0.5);
  ivec2 sz = textureSize(ngSrcA, 0).xy;
  ivec2 p = ivec2(gl_FragCoord.xy);
  float tl = ngTbHA(p + ivec2(-1, 1), sz, L), t = ngTbHA(p + ivec2(0, 1), sz, L), tr = ngTbHA(p + ivec2(1, 1), sz, L);
  float l = ngTbHA(p + ivec2(-1, 0), sz, L), c = ngTbHA(p, sz, L), r = ngTbHA(p + ivec2(1, 0), sz, L);
  float bl = ngTbHA(p + ivec2(-1, -1), sz, L), b = ngTbHA(p + ivec2(0, -1), sz, L), br = ngTbHA(p + ivec2(1, -1), sz, L);
  float dx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / 8.0;
  float dy = ((tl + 2.0 * t + tr) - (bl + 2.0 * b + br)) / 8.0;
  float texM = ngTileM[L] / float(sz.x);
  float k = ngReliefM[L] / texM;
  vec3 n = normalize(vec3(-dx * k, -dy * k, 1.0));
  /* 空洞：半径 3 と 9 テクセルの輪の平均より低いほど暗い */
  float s1 = 0.0, s2 = 0.0;
  float sc = float(sz.x) / 1024.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398 + 0.3;
    vec2 d = vec2(cos(a), sin(a));
    s1 += ngTbHA(p + ivec2(d * 3.0 * sc + 0.5 * sign(d)), sz, L);
    s2 += ngTbHA(p + ivec2(d * 10.0 * sc + 0.5 * sign(d)), sz, L);
  }
  s1 /= 8.0; s2 /= 8.0;
  float cav = max(s1 - c, 0.0) * 2.2 + max(s2 - c, 0.0) * 1.3;
  float ao = clamp(1.0 - cav, 0.25, 1.0);
  vec3 alb = texelFetch(ngSrcA, ivec3(p, L), 0).rgb;
  alb *= alb;
  float lum = dot(alb, vec3(0.2126, 0.7152, 0.0722));
  float rough = 0.85;
  if (L == 0) rough = 0.80 + 0.12 * (1.0 - c);
  else if (L == 1) rough = 0.95;
  else if (L == 2) rough = 0.86 + 0.08 * (1.0 - c);
  else if (L == 3) rough = mix(0.92, 0.50, smoothstep(0.3, 0.75, c));
  else if (L == 4) rough = 0.86;
  else if (L == 5) rough = 0.58 + 0.1 * c;
  else if (L == 6) rough = mix(0.82, 0.62, smoothstep(0.35, 0.7, c)) + 0.12 * smoothstep(0.22, 0.3, lum);
  else rough = 0.84;
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, clamp(rough, 0.04, 1.0), ao);
}
`;

/** マクロの色むら（タイルする 4 チャンネルのノイズ。512² HalfFloat） */
export const TERRAIN_BAKE_MACRO = NG_NOISE_GLSL + /* glsl */ `
float ngTmVN(vec2 p, float P, float s) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = ngHash12(mod(i, P) + s), b = ngHash12(mod(i + vec2(1.0, 0.0), P) + s);
  float c = ngHash12(mod(i + vec2(0.0, 1.0), P) + s), d = ngHash12(mod(i + 1.0, P) + s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float ngTmFbm(vec2 uv, float P, float s) {
  float t = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 6; k++) { t += a * ngTmVN(uv * P, P, s + float(k) * 9.1); n += a; P *= 2.0; a *= 0.5; }
  return t / n;
}
void main() {
  vec2 uv = vUv;
  float r = ngTmFbm(uv, 4.0, 1.0);
  float g = ngTmFbm(uv, 6.0, 2.0);
  vec2 wq = vec2(ngTmFbm(uv, 3.0, 3.0), ngTmFbm(uv, 3.0, 4.0));
  float b = ngTmFbm(fract(uv + (wq - 0.5) * 0.25), 5.0, 5.0);
  float a = ngTmFbm(uv, 12.0, 6.0);
  /* 0..1 へ伸ばす（fbm は中央に寄る） */
  gl_FragColor = clamp((vec4(r, g, b, a) - 0.5) * 2.2 + 0.5, 0.0, 1.0);
}
`;
