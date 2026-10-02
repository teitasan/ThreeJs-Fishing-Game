/* ===========================================================
   trees のテクスチャ（forge で起動時に GPU で焼く。外部アセット無し）
   -----------------------------------------------------------
   - 樹皮の配列（BARK_LAYERS の 9 層、周期で継ぎ目なし）
       alb : rgb = 線形アルベド、a = 高さ
       nrm : rg = 接空間の法線 xy（0.5 中心）、b = 窪みの AO、a = 粗さ
     1 タイル = 周 0.5m × 縦 1.0m
   - 葉のアトラス（4×2 のセル、LEAF_LAYERS の順）。1 枚ずつ手続きで描く葉・針葉・小枝
       alb : rgb = 線形アルベド、a = 被覆（mip は被覆保存：forge の coverageAlpha）
       nrm : rg = 法線 xy、b = 透過の厚み（1 = 薄い葉）、a = 粗さ
     セルの座標：u = カードの幅方向、v = 付け根 0 → 先 1
   =========================================================== */
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { BARK_LAYERS, LEAF_LAYERS } from './format.js';

export const LEAF_GRID = [4, 2];
/** 葉のセルの余白（mip の滲み止め。uv はこの内側へ写す） */
export const LEAF_PAD = 0.012;
/** カードの幅 ÷ 長さ（焼き込みの cardAspect と同じ。セルの中を実寸の比で描く） */
export const LEAF_ASPECT = { sugi: 0.72, hinoki: 0.8, buna: 0.85, mizunara: 0.85, momiji: 0.85, akamatsu: 0.9, yanagi: 0.32, hannoki: 0.85 };

/* ---------------------------------------------------------------- 樹皮 */

const BARK_FRAG = NG_NOISE_GLSL + /* glsl */ `
uniform float ngMode;   // 0 = アルベド + 高さ、1 = 法線 + AO + 粗さ
vec3 ngSRGB(float r, float g, float b) { return vec3(r, g, b); }

/* 層ごとの高さ（0..1）と色。p は 0..1 の周期タイル（x = 周、y = 縦） */
float ngBarkH(int L, vec2 p, out vec3 col, out float rough) {
  vec2 P = vec2(1.0);
  float h = 0.5;
  rough = 0.85;
  if (L == 0 || L == 1) {
    /* スギ・ヒノキ：縦に裂けた繊維の帯。帯の縁が剥がれて灰色に乾く */
    /* 9 × fine は整数（周の継ぎ目で帯が切れない）：ヒノキは 13 本 */
    float fine = L == 1 ? 13.0 / 9.0 : 1.0;
    vec2 q = vec2(p.x * 9.0 * fine, p.y * 1.5);
    q.x += 0.9 * ngFbmP(vec2(p.x * 3.0, p.y * 2.0), vec2(3.0, 2.0), 3) - 0.45;
    float strip = abs(fract(q.x) - 0.5) * 2.0;
    float fibN = L == 1 ? 87.0 : 60.0;
    float fib = ngFbmP(vec2(p.x * fibN, p.y * 3.0), vec2(fibN, 3.0), 3);
    float peel = smoothstep(0.55, 0.8, ngFbmP(vec2(p.x * 18.0, p.y * 6.0), vec2(18.0, 6.0), 3));
    h = (1.0 - pow(strip, 1.6)) * 0.7 + fib * 0.3;
    vec3 red = L == 1 ? vec3(0.19, 0.098, 0.062) : vec3(0.16, 0.082, 0.052);
    vec3 dark = red * 0.45;
    vec3 grey = vec3(0.21, 0.18, 0.155);
    col = mix(dark, red, smoothstep(0.15, 0.6, h));
    col = mix(col, grey, peel * smoothstep(0.4, 0.9, h) * 0.75);
    col *= 0.85 + 0.3 * fib;
    rough = 0.9;
  } else if (L == 2) {
    /* ブナ：灰白の平滑な樹皮、地衣の斑（白・淡緑・黒）と横の皮目 */
    /* 地衣はドメインワープした fbm の閾値で «縁の不規則な斑»（白っぽい灰・淡い緑灰・暗い痂状）。丸いぼかしにしない */
    float base = ngFbmP(p * vec2(4.0, 2.0), vec2(4.0, 2.0), 4);
    /* タイルは周 0.5m × 縦 1m なので、縦の周波数を 2 倍にして «メートルで等方» にする（前は 10cm × 40cm の縦長の格子が矩形の塊に見えた）。
       値ノイズの格子の向きが閾値の輪郭に出ないよう、ずらした 2 つの格子の和 + 強めのドメインワープ */
    vec2 wp = p + vec2(0.05, 0.1) * (vec2(ngFbmP(p * vec2(6.0, 12.0), vec2(6.0, 12.0), 3), ngFbmP(p * vec2(6.0, 12.0) + 5.2, vec2(6.0, 12.0), 3)) - 0.5) * 2.0;
    float fa = 0.5 * (ngFbmP(wp * vec2(4.0, 8.0), vec2(4.0, 8.0), 5) + ngFbmP(wp * vec2(5.0, 10.0) + 0.37, vec2(5.0, 10.0), 5));
    float fb = 0.5 * (ngFbmP(wp * vec2(7.0, 14.0) + 3.7, vec2(7.0, 14.0), 5) + ngFbmP(wp * vec2(9.0, 18.0) + 6.1, vec2(9.0, 18.0), 4));
    float fc = 0.5 * (ngFbmP(wp * vec2(12.0, 24.0) + 9.1, vec2(12.0, 24.0), 4) + ngFbmP(wp * vec2(15.0, 30.0) + 2.3, vec2(15.0, 30.0), 3));
    float lichW = smoothstep(0.55, 0.585, fa);
    float lichG = smoothstep(0.57, 0.605, fb) * (1.0 - lichW);
    float crust = smoothstep(0.60, 0.635, fc) * (1.0 - lichW) * (1.0 - lichG);
    float speck = smoothstep(0.1, 0.03, ngWorley2P(p * vec2(40.0, 20.0) + 1.3, vec2(40.0, 20.0)).x) * step(0.8, ngHash12(floor(p * vec2(40.0, 20.0)))) * lichW;
    float lent = smoothstep(0.92, 1.0, ngFbmP(vec2(p.x * 3.0, p.y * 40.0), vec2(3.0, 40.0), 2));
    /* ブナの樹皮の反射率は 0.2–0.3（地衣の白でも 0.32 まで。前の 0.40 は岩より明るく、昼の林縁で幹が白く浮いた） */
    col = vec3(0.215, 0.21, 0.195) * (0.86 + 0.24 * base);
    col = mix(col, vec3(0.31, 0.31, 0.29) * (0.92 + 0.16 * fc), lichW * 0.85);
    col = mix(col, vec3(0.20, 0.225, 0.17), lichG * 0.65);
    col = mix(col, vec3(0.16, 0.155, 0.145), crust * 0.5);
    col = mix(col, vec3(0.10, 0.09, 0.08), speck * 0.6);
    col *= 1.0 - lent * 0.3;
    h = 0.5 + 0.12 * base + 0.12 * lichW + 0.08 * lichG + 0.05 * crust - lent * 0.2;
    rough = 0.72 - 0.08 * lichW;
  } else if (L == 3) {
    /* ミズナラ：灰褐色の不規則な縦の剥片 */
    /* 縦に長い畝が不規則に割れて剥片になる。溝は細い黒線でなく «深く柔らかい» 勾配（鱗に見せない） */
    /* 周期は整数（2.2 だとタイルの縦の継ぎ目で畝が切れ、1m ごとに横の線が出た） */
    vec2 q = p * vec2(9.0, 2.0);
    q.x += 1.1 * ngFbmP(vec2(p.x * 2.0, p.y * 3.0), vec2(2.0, 3.0), 3);
    vec3 w = ngWorley2P(q, vec2(9.0, 2.0));
    float ridge = smoothstep(0.0, 0.38, w.y - w.x);
    float fib = ngFbmP(vec2(p.x * 70.0, p.y * 6.0), vec2(70.0, 6.0), 3);
    float fl = ngFbmP(p * vec2(20.0, 8.0), vec2(20.0, 8.0), 4);
    h = ridge * (0.65 + 0.2 * fl) + 0.15 * fib;
    vec3 top = mix(vec3(0.21, 0.19, 0.16), vec3(0.27, 0.26, 0.23), smoothstep(0.55, 0.85, fl)) * (0.88 + 0.24 * w.z);
    col = mix(vec3(0.075, 0.062, 0.05), top, smoothstep(0.05, 0.7, ridge));
    col *= 0.9 + 0.2 * fib;
    rough = 0.9;
  } else if (L == 4) {
    /* イロハモミジ：灰褐色の滑らかな樹皮、縦の淡い縞 */
    float s = ngFbmP(vec2(p.x * 20.0, p.y * 2.0), vec2(20.0, 2.0), 3);
    float b = ngFbmP(p * 4.0, vec2(4.0), 3);
    col = mix(vec3(0.16, 0.15, 0.12), vec3(0.24, 0.22, 0.18), s) * (0.9 + 0.2 * b);
    col = mix(col, vec3(0.17, 0.20, 0.13), smoothstep(0.6, 0.85, b) * 0.4);
    h = 0.45 + 0.25 * s + 0.1 * b;
    rough = 0.75;
  } else if (L == 5) {
    /* アカマツ（下）：暗い灰色の厚い亀甲の板、深い割れ目 */
    vec2 q = p * vec2(5.0, 4.0);
    vec3 w = ngWorley2P(q + 0.35 * ngFbmP(p * 6.0, vec2(6.0), 2), vec2(5.0, 4.0));
    float plate = smoothstep(0.02, 0.34, w.y - w.x);
    float fl = ngFbmP(p * vec2(24.0, 18.0), vec2(24.0, 18.0), 3);
    h = plate * (0.75 + 0.25 * fl);
    col = mix(vec3(0.075, 0.058, 0.048), mix(vec3(0.17, 0.13, 0.11), vec3(0.24, 0.14, 0.09), w.z) * (0.85 + 0.3 * fl), smoothstep(0.0, 0.8, plate));
    rough = 0.92;
  } else if (L == 6) {
    /* アカマツ（上）：赤橙の薄い鱗片が剥がれる */
    vec2 q = p * vec2(10.0, 7.0);
    vec3 w = ngWorley2P(q + 0.4 * ngFbmP(p * 8.0, vec2(8.0), 2), vec2(10.0, 7.0));
    float flake = smoothstep(0.0, 0.22, w.y - w.x);
    float n = ngFbmP(p * vec2(30.0, 12.0), vec2(30.0, 12.0), 3);
    h = flake * 0.6 + 0.4 * n;
    col = mix(vec3(0.16, 0.065, 0.035), vec3(0.32, 0.14, 0.07), flake * (0.7 + 0.3 * w.z));
    col = mix(col, vec3(0.36, 0.24, 0.16), smoothstep(0.65, 0.9, n) * 0.5);
    rough = 0.8;
  } else if (L == 7) {
    /* ヤナギ：深い網目の割れ（菱形）、灰褐色 */
    vec2 q = vec2(p.x * 8.0, p.y * 2.5);
    /* 縦の 1 周期で位相が整数回（q.y × 0.8 = 2 p.y）：タイルの縦の継ぎ目で網目が切れない */
    float a = abs(sin((q.x + q.y * 0.8 + 0.5 * ngFbmP(p * 4.0, vec2(4.0), 2)) * 3.14159));
    float b = abs(sin((q.x - q.y * 0.8 + 0.5 * ngFbmP(p * 4.0 + 3.0, vec2(4.0), 2)) * 3.14159));
    float ridge = smoothstep(0.15, 0.6, min(a, b) + 0.3 * ngFbmP(p * vec2(30.0, 6.0), vec2(30.0, 6.0), 2));
    h = ridge;
    col = mix(vec3(0.08, 0.07, 0.06), vec3(0.20, 0.18, 0.15), ridge) * (0.9 + 0.2 * ngFbmP(p * 10.0, vec2(10.0), 2));
    rough = 0.9;
  } else {
    /* ハンノキ：灰褐色の滑らかな樹皮、横長の皮目 */
    float b = ngFbmP(p * 5.0, vec2(5.0), 3);
    vec2 cell = floor(p * vec2(12.0, 24.0));
    vec2 f = fract(p * vec2(12.0, 24.0)) - 0.5;
    float r = ngHash12(cell);
    float len = step(0.55, r) * smoothstep(0.5, 0.2, length(f * vec2(1.0, 4.0)));
    col = vec3(0.21, 0.19, 0.17) * (0.85 + 0.3 * b);
    col = mix(col, vec3(0.32, 0.30, 0.26), len * 0.8);
    h = 0.5 + 0.2 * b + 0.15 * len;
    rough = 0.78;
  }
  return clamp(h, 0.0, 1.0);
}

void main() {
  int L = int(ngLayer + 0.5);
  vec2 p = vUv;
  vec3 col; float rough;
  float h = ngBarkH(L, p, col, rough);
  if (ngMode < 0.5) { gl_FragColor = vec4(col, h); return; }
  /* 法線：高さの差分（周期の中で）。タイルは周 0.5m × 縦 1.0m なので縦の傾きは半分 */
  vec2 e = ngTexel * 1.5;
  vec3 c2; float r2;
  float hx = ngBarkH(L, fract(p + vec2(e.x, 0.0)), c2, r2) - ngBarkH(L, fract(p - vec2(e.x, 0.0)), c2, r2);
  float hy = ngBarkH(L, fract(p + vec2(0.0, e.y)), c2, r2) - ngBarkH(L, fract(p - vec2(0.0, e.y)), c2, r2);
  float depthMm = (L == 2 || L == 4 || L == 8) ? 1.5 : (L == 3 || L == 5 || L == 7) ? 9.0 : 5.0;
  float sx = depthMm * 0.001 / (2.0 * e.x * 0.5), sy = depthMm * 0.001 / (2.0 * e.y * 1.0);
  vec3 n = normalize(vec3(-hx * sx, -hy * sy, 1.0));
  /* 窪みの AO：周りの平均より低いほど暗い */
  float ao = 0.0;
  for (int k = 0; k < 6; k++) {
    float a = float(k) * 1.0472;
    ao += ngBarkH(L, fract(p + vec2(cos(a), sin(a)) * 0.02), c2, r2);
  }
  /* 割れ目の暗さはアルベドにもう入っているので、AO は 0.45 で止める（二重に掛けて陰の幹が黒く潰れた） */
  ao = clamp(1.0 - max(ao / 6.0 - h, 0.0) * 2.5, 0.45, 1.0);
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, ao, rough);
}
`;

/* ---------------------------------------------------------------- 葉 */

const LEAF_FRAG = NG_NOISE_GLSL + /* glsl */ `
uniform float ngMode;   // 0 = アルベド + 被覆、1 = 法線 + 厚み + 粗さ
uniform vec2 ngGrid;
uniform float ngPad;
uniform float ngAspect[8];

/* 線分 a-b への距離と、沿った位置 t */
float ngSeg(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 pa = p - a, ba = b - a;
  t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * t);
}
vec2 ngRot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }

/* 1 枚の葉（葉身の局所座標 q：x = 付け根 0 → 先 1、y = 横）。
   kind 0 = 卵形の鋸歯（ブナ）、1 = 倒卵形の波状（ミズナラ）、2 = 掌状 7 裂（モミジ）、3 = 披針形（ヤナギ）、4 = 円い楕円（ハンノキ）
   戻り値：覆い（>0 で中）。h = 高さ（葉脈・折れ）、vein = 葉脈の強さ */
float ngBlade(vec2 q, float L, float W, int kind, out float h, out float vein) {
  h = 0.0; vein = 0.0;
  float x = q.x / L, y = q.y;
  if (kind == 2) {
    /* 掌状：付け根を中心に 7 つの裂片（極座標） */
    float r = length(q), a = atan(q.y, q.x);
    float lobes = 7.0;
    float k = a / 3.14159 * (lobes * 0.5);
    float fk = fract(k + 0.5) - 0.5;
    float ik = floor(k + 0.5);
    if (abs(ik) > 3.0) return -1.0;
    float lobeL = L * (1.0 - 0.13 * abs(ik));
    float edge = lobeL * (1.0 - pow(abs(fk) * 2.0, 1.7)) * (0.95 + 0.05 * sin(r / L * 60.0));
    vein = smoothstep(0.08, 0.0, abs(fk)) * 0.8;
    h = -abs(fk) * 0.4 + vein * 0.2;
    return edge - r;
  }
  if (x < 0.0 || x > 1.0) return -1.0;
  float w;
  if (kind == 0) w = W * pow(sin(3.14159 * pow(x, 0.72)), 0.85) * (1.0 + 0.06 * sin(x * 44.0));
  else if (kind == 1) w = W * pow(sin(3.14159 * pow(x, 1.25)), 0.9) * (1.0 + 0.16 * sin(x * 30.0));
  else if (kind == 3) w = W * pow(sin(3.14159 * pow(x, 0.85)), 1.4);
  else w = W * pow(sin(3.14159 * pow(x, 0.9)), 0.7) * (1.0 + 0.03 * sin(x * 70.0));
  /* 中肋と側脈（平行の 8–10 対） */
  float mid = smoothstep(W * 0.06, 0.0, abs(y));
  float pairs = kind == 0 ? 9.0 : kind == 4 ? 7.0 : kind == 1 ? 8.0 : 14.0;
  float side = smoothstep(0.08, 0.0, abs(fract(x * pairs - abs(y) / max(W, 1e-4) * 0.9) - 0.5) - 0.42) * step(abs(y), w * 0.85);
  vein = max(mid, side * 0.5);
  /* V に折れた葉身と、脈の間のふくらみ */
  h = -abs(y) / max(W, 1e-4) * 0.35 - vein * 0.15 + 0.08 * sin(x * pairs * 6.283);
  return w - abs(y);
}

struct NgLeaf { float cov; vec3 col; float h; float thick; float rough; };

void ngAcc(inout NgLeaf o, float d, float aa, vec3 col, float h, float thick, float rough) {
  float c = smoothstep(-aa, aa, d);
  if (c <= 0.0) return;
  /* 手前（後で描いた物）を上に重ねる */
  o.col = mix(o.col, col, c);
  o.h = mix(o.h, h, c);
  o.thick = mix(o.thick, thick, c);
  o.rough = mix(o.rough, rough, c);
  o.cov = max(o.cov, c);
}

/* 針葉の小枝（スギ：錐形の針が螺旋に密生）。a→b の小枝、w = 針の長さ */
void ngNeedleTwig(inout NgLeaf o, vec2 p, vec2 a, vec2 b, float w, float seed, vec3 cA, vec3 cB, float aa) {
  float t;
  float d = ngSeg(p, a, b, t);
  float L = length(b - a);
  float ww = w * (1.0 - 0.55 * t);
  if (d > ww * 1.3) return;
  /* 針：沿った位置の周期で斜めの棘 */
  vec2 dir = (b - a) / max(L, 1e-5);
  vec2 rel = p - a;
  float s = dot(rel, dir), c = dot(rel, vec2(-dir.y, dir.x));
  float k = s / (w * 0.32) - abs(c) / (w * 0.32) * 0.75;
  float f = fract(k + ngHash12(vec2(floor(k), seed)) * 0.3);
  float needle = (1.0 - abs(f - 0.5) * 2.0);
  float dd = ww * (0.35 + 0.75 * needle) - d;
  float shade = clamp(d / max(ww, 1e-4), 0.0, 1.0);
  vec3 col = mix(cA, cB, shade * 0.8 + 0.2 * t) * (0.8 + 0.4 * ngHash12(vec2(floor(k), seed + 3.0)));
  ngAcc(o, dd, aa, col, (1.0 - shade) * 0.6 + needle * 0.2, 0.35, 0.6);
  /* 小枝の芯：針に埋もれた緑褐色の細い軸。透過も少し残す（下から見上げたとき黒い «魚の骨» の線にしない） */
  ngAcc(o, w * 0.04 - d, aa * 0.7, mix(cA, vec3(0.07, 0.055, 0.03), 0.45), 0.7, 0.2, 0.8);
}

NgLeaf ngLeafCell(int sp, vec2 uv) {
  NgLeaf o;
  o.cov = 0.0; o.col = vec3(0.05); o.h = 0.0; o.thick = 0.5; o.rough = 0.6;
  float asp = ngAspect[sp];
  /* 実寸の比の座標：x = 横（−asp/2..asp/2）、y = 付け根 0 → 先 1 */
  vec2 p = vec2((uv.x - 0.5) * asp, uv.y);
  float aa = 0.0035;
  float sd = float(sp) * 17.0;
  if (sp == 0) {
    /* スギ：主の小枝から互生の小枝、すべて錐形の針で覆う */
    vec3 cA = vec3(0.045, 0.078, 0.036), cB = vec3(0.020, 0.040, 0.024);
    vec2 a = vec2(0.0, 0.0), b = vec2(0.03, 0.97);
    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      float t = 0.12 + fi * 0.095;
      vec2 s0 = mix(a, b, t);
      float side = mod(fi, 2.0) * 2.0 - 1.0;
      float ang = side * (0.65 + 0.2 * ngHash12(vec2(fi, sd)));
      float L = (0.42 - 0.3 * t) * (0.8 + 0.4 * ngHash12(vec2(sd, fi)));
      vec2 s1 = s0 + ngRot(vec2(0.0, 1.0), -ang) * L;
      ngNeedleTwig(o, p, s0, s1, 0.045, fi + 1.0, cA, cB, aa);
      /* 小枝の先の分かれ */
      vec2 s2 = mix(s0, s1, 0.55);
      ngNeedleTwig(o, p, s2, s2 + ngRot(vec2(0.0, 1.0), -ang * 0.2) * L * 0.42, 0.04, fi + 20.0, cA, cB, aa);
    }
    ngNeedleTwig(o, p, a, b, 0.055, 0.0, cA, cB, aa);
    o.thick = 0.3;
  } else if (sp == 1) {
    /* ヒノキ：平たい鱗片葉の扇（2 段に分かれるシダ状）。縁は丸く、裏に白い Y 字の気孔帯 */
    vec3 cA = vec3(0.040, 0.072, 0.036), cB = vec3(0.026, 0.050, 0.030);
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float t = 0.08 + fi * 0.13;
      vec2 s0 = vec2(0.0, t * 0.95);
      float side = mod(fi, 2.0) * 2.0 - 1.0;
      float L = (0.48 - 0.4 * t) * (0.85 + 0.3 * ngHash12(vec2(fi, sd)));
      vec2 dir = ngRot(vec2(0.0, 1.0), -side * 1.0);
      for (int j = 0; j < 4; j++) {
        float fj = float(j);
        float tj;
        vec2 c0 = s0 + dir * L * (fj / 4.0);
        vec2 c1 = s0 + dir * L * ((fj + 1.0) / 4.0);
        float dd = ngSeg(p, c0, c1, tj);
        float w = 0.034 * (1.0 - 0.18 * fj);
        float scal = 0.004 * sin((dot(p - s0, dir)) * 260.0);
        ngAcc(o, w + scal - dd, aa, mix(cA, cB, dd / w), 0.5 - dd / w * 0.4, 0.4, 0.5);
        /* 小羽片 */
        vec2 sdir = ngRot(dir, side * 0.9);
        vec2 e0 = mix(c0, c1, 0.5);
        float de = ngSeg(p, e0, e0 + sdir * L * 0.22 * (1.0 - fj * 0.2), tj);
        ngAcc(o, w * 0.75 * (1.0 - tj * 0.5) + scal - de, aa, mix(cA, cB, de / w), 0.4, 0.4, 0.5);
        vec2 sdir2 = ngRot(dir, -side * 0.9);
        float de2 = ngSeg(p, e0, e0 + sdir2 * L * 0.16 * (1.0 - fj * 0.2), tj);
        ngAcc(o, w * 0.7 * (1.0 - tj * 0.5) + scal - de2, aa, mix(cA, cB, de2 / w), 0.4, 0.4, 0.5);
      }
    }
    float tt;
    ngAcc(o, 0.02 - ngSeg(p, vec2(0.0), vec2(0.0, 0.95), tt), aa, vec3(0.034, 0.06, 0.032), 0.6, 0.35, 0.5);
  } else if (sp == 6) {
    /* ヤナギ：垂れる小枝に互生の細い披針形の葉（下向きに斜め） */
    float tt;
    vec2 a = vec2(0.0, 0.0), b = vec2(0.0, 1.0);
    for (int i = 0; i < 22; i++) {
      float fi = float(i);
      float t = 0.03 + fi * 0.044;
      vec2 s0 = vec2(0.012 * sin(t * 9.0), t);
      float side = mod(fi, 2.0) * 2.0 - 1.0;
      float ang = side * (0.32 + 0.12 * ngHash12(vec2(fi, sd)));
      vec2 dir = ngRot(vec2(0.0, 1.0), -ang);
      vec2 q = vec2(dot(p - s0, dir), dot(p - s0, vec2(-dir.y, dir.x)));
      float h, vein;
      float L = 0.17 * (0.8 + 0.4 * ngHash12(vec2(sd, fi)));
      float d = ngBlade(q, L, 0.022, 3, h, vein);
      vec3 col = mix(vec3(0.085, 0.13, 0.048), vec3(0.11, 0.15, 0.06), ngHash12(vec2(fi, 4.0))) * (1.0 + 0.25 * vein);
      ngAcc(o, d, aa * 0.7, col, h, 0.9, 0.45);
    }
    ngAcc(o, 0.006 - ngSeg(p, a, b, tt), aa, vec3(0.13, 0.12, 0.05), 0.6, 0.2, 0.7);
  } else if (sp == 5) {
    /* アカマツ：2 本ずつの細長い針葉が小枝の先から扇状に（房） */
    float tt;
    vec2 base = vec2(0.0, 0.06);
    for (int i = 0; i < 46; i++) {
      float fi = float(i);
      float r1 = ngHash12(vec2(fi, sd)), r2 = ngHash12(vec2(sd, fi + 0.5));
      vec2 s0 = base + vec2(0.0, r1 * 0.32);
      float ang = (r2 - 0.5) * 2.2 * (1.0 - 0.4 * r1);
      vec2 dir = ngRot(vec2(0.0, 1.0), ang);
      float L = (0.55 + 0.35 * ngHash12(vec2(fi, 9.0))) * (1.0 - 0.45 * abs(ang) / 1.1);
      vec2 s1 = s0 + dir * L + vec2(0.0, -0.08 * L * abs(ang));
      float d = ngSeg(p, s0, s1, tt);
      float w = 0.0065 * (1.0 - 0.6 * tt);
      vec3 col = mix(vec3(0.030, 0.058, 0.030), vec3(0.050, 0.080, 0.036), tt) * (0.8 + 0.4 * r2);
      ngAcc(o, w - d, aa * 0.6, col, 0.5, 0.25, 0.45);
    }
    /* 小枝の先（針葉の房の付け根）：細い灰褐色の軸。太い楔にしない */
    ngAcc(o, 0.007 * (1.0 - smoothstep(0.0, 0.36, p.y)) + 0.0035 - ngSeg(p, vec2(0.0, 0.0), vec2(0.0, 0.36), tt), aa, vec3(0.10, 0.068, 0.045), 0.7, 0.05, 0.8);
  } else {
    /* 広葉：小枝の房に互生の葉。ブナ 0・ミズナラ 1・モミジ 2・ハンノキ 4 */
    int kind = sp == 2 ? 0 : sp == 3 ? 1 : sp == 4 ? 2 : 4;
    vec3 cA, cB;
    if (sp == 2) { cA = vec3(0.075, 0.118, 0.038); cB = vec3(0.058, 0.095, 0.030); }
    else if (sp == 3) { cA = vec3(0.066, 0.104, 0.032); cB = vec3(0.050, 0.084, 0.026); }
    else if (sp == 4) { cA = vec3(0.090, 0.130, 0.040); cB = vec3(0.066, 0.106, 0.032); }
    else { cA = vec3(0.060, 0.098, 0.034); cB = vec3(0.044, 0.078, 0.028); }
    float tt;
    int N = sp == 4 ? 11 : sp == 3 ? 8 : 9;
    float Ls = sp == 4 ? 0.27 : sp == 3 ? 0.32 : 0.26;
    vec2 a = vec2(0.0), b = vec2(0.02, 0.8);
    /* 小枝の軸は葉より先に描いて葉の下へ（後に描くと逆光の葉の上を黒い線が横切り、見上げで «魚の骨» になった）。少し透過する */
    ngAcc(o, 0.006 * (1.0 - 0.5 * p.y) - ngSeg(p, a, b, tt), aa * 0.6, vec3(0.075, 0.062, 0.040), 0.7, 0.2, 0.8);
    for (int i = 0; i < 12; i++) {
      if (i >= N) break;
      float fi = float(i);
      float r1 = ngHash12(vec2(fi, sd)), r2 = ngHash12(vec2(sd, fi + 0.5));
      float t = sp == 3 ? 0.55 + 0.4 * (fi / float(N)) : 0.1 + 0.8 * (fi / float(N));
      vec2 s0 = mix(a, b, t);
      float side = mod(fi, 2.0) * 2.0 - 1.0;
      float ang = side * (sp == 3 ? 0.5 + 0.9 * r1 : 0.7 + 0.35 * r1) * (sp == 3 ? (fi / float(N)) * 1.6 : 1.0);
      vec2 dir = ngRot(vec2(0.0, 1.0), -ang);
      float pet = sp == 4 ? 0.08 : 0.03;
      vec2 s1 = s0 + dir * pet;
      float L = Ls * (0.75 + 0.45 * r2) * (sp == 3 ? 1.0 : 1.0 - 0.25 * t);
      float W = L * (sp == 2 ? 0.30 : sp == 3 ? 0.30 : 0.36);
      vec2 dd = ngRot(dir, side * 0.15 * (r1 - 0.5));
      vec2 q = vec2(dot(p - s1, dd), dot(p - s1, vec2(-dd.y, dd.x)));
      float h, vein;
      float d = ngBlade(q, L, W, kind, h, vein);
      /* 鋸歯（ブナは波状の浅い鋸歯、ハンノキは細かい） */
      if (kind == 0 || kind == 4) d -= (kind == 0 ? 0.004 : 0.0025) * (1.0 - abs(fract(q.x / L * (kind == 0 ? 11.0 : 22.0)) - 0.5) * 2.0);
      float age = ngHash12(vec2(fi, 31.0));
      vec3 col = mix(cA, cB, age) * (1.0 + 0.35 * vein);
      if (sp == 4) col = mix(col, vec3(0.13, 0.11, 0.035), 0.12 * ngFbm(p * 30.0, 2));
      col *= 0.92 + 0.16 * ngFbm(q * 40.0 + fi, 2);
      /* 葉柄（葉身より先 = 下に） */
      ngAcc(o, 0.003 - ngSeg(p, s0, s1, tt), aa * 0.5, sp == 4 ? vec3(0.10, 0.06, 0.03) : vec3(0.06, 0.07, 0.03), 0.6, 0.4, 0.6);
      ngAcc(o, d, aa * 0.8, col, h, 0.85 - 0.3 * vein, 0.5 - 0.15 * vein);
    }
  }
  return o;
}

void main() {
  vec2 g = vUv * ngGrid;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  int sp = int(cell.x + cell.y * ngGrid.x + 0.5);
  /* セルの余白の外は空（mip で隣のセルが滲まない） */
  vec2 uv = (f - ngPad) / (1.0 - 2.0 * ngPad);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { gl_FragColor = vec4(0.03, 0.05, 0.03, 0.0); return; }
  NgLeaf o = ngLeafCell(sp, uv);
  if (ngMode < 0.5) {
    /* 被覆の外の色は近くの葉の色へ寄せる（mip で縁が黒くならない） */
    vec3 col = o.cov > 0.01 ? o.col : vec3(0.035, 0.06, 0.03);
    gl_FragColor = vec4(col, o.cov);
    return;
  }
  vec2 e = vec2(ngTexel.x * ngGrid.x / (1.0 - 2.0 * ngPad), ngTexel.y * ngGrid.y / (1.0 - 2.0 * ngPad)) * 1.2;
  NgLeaf ox = ngLeafCell(sp, uv + vec2(e.x, 0.0)), oy = ngLeafCell(sp, uv + vec2(0.0, e.y));
  float hx = (ox.h * ox.cov - o.h * o.cov), hy = (oy.h * oy.cov - o.h * o.cov);
  vec3 n = normalize(vec3(-hx * 0.006 / e.x, -hy * 0.006 / e.y, 1.0));
  gl_FragColor = vec4(n.xy * 0.5 + 0.5, o.thick, o.rough);
}
`;

/**
 * 樹皮の配列と葉のアトラスを焼く
 * @param {object} forge ctx.forge
 * @param {typeof import('three')} T
 * @param {{bark:number, leafW:number, leafH:number}} size
 */
export async function bakeTreeTextures(forge, T, size) {
  const layers = BARK_LAYERS.length;
  const common = { w: size.bark, h: size.bark, layers, mips: true, wrap: 'repeat' };
  const barkAlb = forge.bakeArray({ ...common, frag: BARK_FRAG, uniforms: { ngMode: { value: 0 } }, type: T.HalfFloatType });
  await forge.step();
  const barkNrm = forge.bakeArray({ ...common, frag: BARK_FRAG, uniforms: { ngMode: { value: 1 } }, type: T.UnsignedByteType });
  await forge.step();
  const aspect = LEAF_LAYERS.map((n) => LEAF_ASPECT[n]);
  const lu = (mode) => ({
    ngMode: { value: mode }, ngGrid: { value: new T.Vector2(LEAF_GRID[0], LEAF_GRID[1]) }, ngPad: { value: LEAF_PAD }, ngAspect: { value: aspect },
  });
  const leafAlb = forge.bake2D({ w: size.leafW, h: size.leafH, frag: LEAF_FRAG, uniforms: lu(0), mips: true, wrap: 'clamp', type: T.HalfFloatType, anisotropy: 4 });
  await forge.step();
  const leafNrm = forge.bake2D({ w: size.leafW, h: size.leafH, frag: LEAF_FRAG, uniforms: lu(1), mips: true, wrap: 'clamp', type: T.UnsignedByteType, anisotropy: 4 });
  await forge.step();
  for (const t of [barkAlb, barkNrm]) t.anisotropy = 4;
  const bytes = (w, h, n, b) => Math.round(w * h * n * b * 1.333);
  const texBytes = bytes(size.bark, size.bark, layers, 8) + bytes(size.bark, size.bark, layers, 4) + bytes(size.leafW, size.leafH, 1, 8) + bytes(size.leafW, size.leafH, 1, 4);
  return { barkAlb, barkNrm, leafAlb, leafNrm, texBytes };
}
