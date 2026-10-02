/* ===========================================================
   hardscape の forge の焼き込み（起動時に GPU で合成。外部アセットなし）
   -----------------------------------------------------------
   木（512 × 2048、4 列 = 4 枚の板。1 列 = 幅 0.2m、縦 = 長さ 4m で縦方向は周期）
     A（sRGB8）：rgb = 風化した杉の線形アルベド（灰銀 0.28 前後・晩材の筋・節・干割れ・汚れ）、a = 粗さ
     N（RGBA8）：rgb = 接空間の法線（早材が痩せて晩材が浮く凹凸 1.5mm・干割れ・節）、a = 窪みの AO
   岩（512²、1m の周期のタイル）
     A：r = 花崗岩の灰（長石・黒雲母・石英の粒）、g = 安山岩の灰（細粒 + 斑晶）、b = しみ（低周波）、a = 地衣の覆い
     N：rg = 花崗岩の法線 xy、ba = 安山岩の法線 xy（z は復元）
   =========================================================== */
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';

const WOOD_COMMON = NG_NOISE_GLSL + /* glsl */ `
/* 板 c（0..3）の点（s 横 m、t 長さ m）。t は 4m で周期 */
float ngHsH(float c, float s, float t) { return ngHash12(vec2(c * 7.13 + s, t)); }
struct NgHsWood { float h; float late; float knot; float crack; float dirt; float lichen; float fiber; float edge; };
NgHsWood ngHsWoodAt(float c, float s, float t) {
  NgHsWood o;
  float r0 = ngHash12(vec2(c, 1.7)), r1 = ngHash12(vec2(c, 3.1)), r2 = ngHash12(vec2(c, 5.9));
  const float TP = 6.2831853 / 4.0;
  /* 板目：髄の位置が板の幅の外を緩く彷徨う（筍杢のアーチ） */
  float s0 = -0.06 + 0.32 * r0 + 0.035 * sin(t * TP * (1.0 + floor(r1 * 2.0)) + r2 * 6.28) + 0.012 * sin(t * TP * 3.0 + r0 * 9.0);
  float d = 0.02 + 0.08 * r1 + 0.035 * sin(t * TP * 2.0 + r0 * 4.0) + 0.012 * sin(t * TP * 5.0 + r2 * 3.0);
  float rho = sqrt((s - s0) * (s - s0) + d * d);
  float ringW = 0.0048 + 0.0035 * r2;
  float ring = rho / ringW + 0.6 * ngFbmP(vec2(s * 23.0, t * 3.0), vec2(1e4, 12.0), 3) + 0.25 * ngVNoise2P(vec2(s * 140.0, t * 6.0), vec2(1e4, 24.0));
  /* 節：板ごとに 0–3 個。年輪が節の周りで歪む */
  o.knot = 0.0;
  float nk = floor(ngHash12(vec2(c, 8.3)) * 3.2);
  for (int k = 0; k < 3; k++) {
    if (float(k) >= nk) break;
    vec2 kh = ngHash22(vec2(c * 3.0 + float(k), 11.0));
    float tk = kh.x * 4.0, sk = 0.03 + 0.14 * kh.y, rk = 0.006 + 0.012 * ngHash12(vec2(c, float(k) + 20.0));
    float dt = t - tk; dt -= 4.0 * floor(dt / 4.0 + 0.5);
    float dk = length(vec2((s - sk) / rk, dt / (rk * 1.7)));
    ring += 2.2 * exp(-dk * dk * 0.18) * (0.5 + 0.5 * sin(atan(dt, s - sk) * 2.0));
    o.knot = max(o.knot, 1.0 - smoothstep(0.75, 1.05, dk));
  }
  float f = fract(ring);
  o.late = smoothstep(0.5, 0.74, f) * (1.0 - smoothstep(0.86, 0.99, f));
  /* 干割れ：木目に沿う細い線。長さはノイズで途切れる */
  o.crack = 0.0;
  for (int k = 0; k < 3; k++) {
    float sc = 0.02 + 0.16 * ngHash12(vec2(c * 5.0 + float(k), 31.0));
    float wob = 0.003 * ngGNoise2P(vec2(t * 2.5, c * 3.0 + float(k)), vec2(10.0, 1e4));
    float seg = ngVNoise2P(vec2(t * 1.25 + float(k) * 2.0, c), vec2(5.0, 1e4));
    float w = 0.00045 + 0.0007 * seg;
    float m = (1.0 - smoothstep(w * 0.4, w, abs(s - sc - wob))) * smoothstep(0.52, 0.68, seg);
    o.crack = max(o.crack, m);
  }
  /* 汚れ・しみ（低周波）、地衣の斑（まれ） */
  o.dirt = ngFbmP(vec2(s * 6.0 + c * 13.0, t * 1.5), vec2(1e4, 6.0), 4);
  o.lichen = smoothstep(0.72, 0.8, ngFbmP(vec2(s * 30.0 + c * 7.0, t * 7.5), vec2(1e4, 30.0), 3)) * step(0.45, r2);
  float fine = ngVNoise2P(vec2(s * 900.0, t * 40.0), vec2(1e5, 160.0));
  /* 繊維：横に細かく縦に長い筋（風化で毛羽立った早材） */
  o.fiber = ngVNoise2P(vec2(s * 1400.0, t * 22.0), vec2(1e5, 88.0)) * 0.6 + ngVNoise2P(vec2(s * 520.0, t * 9.0), vec2(1e5, 36.0)) * 0.4;
  o.edge = smoothstep(0.0, 0.014, min(s, 0.2 - s));
  o.h = 0.52 + 0.26 * o.late + 0.05 * fine + 0.06 * o.fiber - 0.65 * o.crack - 0.12 * o.knot * (1.0 - o.knot) - 0.2 * (1.0 - o.edge);
  return o;
}
void ngHsCoord(vec2 uv, out float c, out float s, out float t) {
  float x = uv.x * 4.0;
  c = floor(x);
  s = fract(x) * 0.2;
  t = uv.y * 4.0;
}
`;

/** 木の色と粗さ（sRGB8 の RT へ：線形で書けば GPU が符号化する） */
export const WOOD_A_FRAG = WOOD_COMMON + /* glsl */ `
void main() {
  float c, s, t;
  ngHsCoord(vUv, c, s, t);
  NgHsWood w = ngHsWoodAt(c, s, t);
  float r0 = ngHash12(vec2(c, 41.0));
  /* 新しい杉（赤身）→ 風化した灰銀。板ごとの風化の進み + しみ */
  vec3 fresh = vec3(0.30, 0.17, 0.095);
  vec3 silver = vec3(0.315, 0.305, 0.29);
  float weather = clamp(0.62 + 0.3 * r0 + 0.3 * (w.dirt - 0.5), 0.0, 1.0);
  vec3 col = mix(fresh, silver, weather);
  col *= 0.86 + 0.28 * w.dirt;
  col *= 0.9 + 0.2 * w.fiber;                                      // 繊維の毛羽
  col *= mix(1.05, 0.7, w.late);                                  // 晩材：浮いた暗い灰褐の筋、早材は晒されて明るい
  col = mix(col, col * vec3(0.95, 0.86, 0.74), w.late * (0.35 + 0.65 * (1.0 - weather)));
  col *= mix(0.62, 1.0, w.edge);                                   // 板の縁に溜まる汚れ
  col = mix(col, vec3(0.085, 0.068, 0.052), w.knot * 0.9);         // 節
  col = mix(col, vec3(0.36, 0.37, 0.31), w.lichen * 0.7);          // 地衣
  col *= 1.0 - 0.72 * w.crack;                                     // 干割れの奥
  float rough = clamp(0.8 + 0.1 * w.dirt - 0.12 * w.knot + 0.1 * w.crack - 0.05 * w.late, 0.55, 0.97);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), rough);
}
`;

/** 木の法線（高さの差分）と AO */
export const WOOD_N_FRAG = WOOD_COMMON + /* glsl */ `
void main() {
  float c, s, t;
  ngHsCoord(vUv, c, s, t);
  float es = 0.2 / 128.0, et = 4.0 / 2048.0;
  float h0 = ngHsWoodAt(c, s, t).h;
  float hx = ngHsWoodAt(c, min(s + es, 0.1999), t).h - ngHsWoodAt(c, max(s - es, 0.0), t).h;
  float hy = ngHsWoodAt(c, s, t + et).h - ngHsWoodAt(c, s, t - et).h;
  const float relief = 0.0022;        // 凹凸の高さ m（早材が痩せる 1–2mm）
  vec3 n = normalize(vec3(-hx * relief / (2.0 * es), -hy * relief / (2.0 * et), 1.0));
  float ao = clamp(0.45 + 0.75 * h0, 0.25, 1.0);
  gl_FragColor = vec4(n * 0.5 + 0.5, ao);
}
`;

const ROCK_COMMON = NG_NOISE_GLSL + /* glsl */ `
/* 1m 周期のタイル。uv × 1 = m */
float ngHsGran(vec2 p, out float lum) {
  vec3 w = ngWorley2P(p * 70.0, vec2(70.0));
  float m = w.z;
  float grain = m < 0.16 ? 0.05 : m < 0.36 ? 0.42 : m < 0.62 ? 0.22 : m < 0.8 ? 0.29 : 0.19;
  float big = ngFbmP(p * 4.0, vec2(4.0), 4);
  /* 風化した花崗岩：粒の対比は半分に（表面が灰色に曇る）+ 大きなむら */
  lum = mix(0.235, grain, 0.45) * (0.8 + 0.4 * big);
  float edge = smoothstep(0.0, 0.18, w.y - w.x);
  return 0.35 * edge + 0.4 * big + 0.25 * ngFbmP(p * 24.0, vec2(24.0), 3);
}
float ngHsAnd(vec2 p, out float lum) {
  float n1 = ngFbmP(p * 6.0, vec2(6.0), 5), n2 = ngFbmP(p * 40.0, vec2(40.0), 3);
  vec3 w = ngWorley2P(p * 30.0, vec2(30.0));
  float pheno = (1.0 - smoothstep(0.08, 0.14, w.x)) * step(0.82, w.z);
  float pit = (1.0 - smoothstep(0.0, 0.06, w.x)) * step(w.z, 0.06);
  lum = (0.185 + 0.05 * (n1 - 0.5) + 0.02 * (n2 - 0.5)) * (1.0 + 1.3 * pheno);
  return 0.55 * n1 + 0.3 * n2 - 0.4 * pit;
}
`;

export const ROCK_A_FRAG = ROCK_COMMON + /* glsl */ `
void main() {
  vec2 p = vUv;
  float lg, la;
  ngHsGran(p, lg);
  ngHsAnd(p, la);
  float stain = ngFbmP(p * 2.0, vec2(2.0), 4);
  float lichen = smoothstep(0.6, 0.66, ngFbmP(p * 9.0 + 3.1, vec2(9.0), 4)) * smoothstep(0.3, 0.6, ngFbmP(p * 3.0, vec2(3.0), 3));
  gl_FragColor = vec4(lg, la, stain, lichen);
}
`;

export const ROCK_N_FRAG = ROCK_COMMON + /* glsl */ `
void main() {
  vec2 p = vUv;
  float e = 1.0 / 512.0, d;
  float gx = ngHsGran(p + vec2(e, 0.0), d) - ngHsGran(p - vec2(e, 0.0), d);
  float gy = ngHsGran(p + vec2(0.0, e), d) - ngHsGran(p - vec2(0.0, e), d);
  float ax = ngHsAnd(p + vec2(e, 0.0), d) - ngHsAnd(p - vec2(e, 0.0), d);
  float ay = ngHsAnd(p + vec2(0.0, e), d) - ngHsAnd(p - vec2(0.0, e), d);
  const float relG = 0.0022, relA = 0.0035;
  vec2 ng = -vec2(gx, gy) * relG / (2.0 * e);
  vec2 na = -vec2(ax, ay) * relA / (2.0 * e);
  gl_FragColor = vec4(clamp(ng * 0.5 + 0.5, 0.0, 1.0), clamp(na * 0.5 + 0.5, 0.0, 1.0));
}
`;

/**
 * 焼く（init の中で）
 * @param {object} forge ctx.forge
 * @param {object} T THREE
 */
export async function bakeHardscapeTextures(forge, T) {
  const woodA = forge.bake2D({ w: 512, h: 2048, frag: WOOD_A_FRAG, type: T.UnsignedByteType, mips: true, colorSpace: T.SRGBColorSpace, anisotropy: 8 });
  await forge.step();
  const woodN = forge.bake2D({ w: 512, h: 2048, frag: WOOD_N_FRAG, type: T.UnsignedByteType, mips: true, anisotropy: 8 });
  await forge.step();
  const rockA = forge.bake2D({ w: 512, h: 512, frag: ROCK_A_FRAG, type: T.UnsignedByteType, mips: true, anisotropy: 4 });
  await forge.step();
  const rockN = forge.bake2D({ w: 512, h: 512, frag: ROCK_N_FRAG, type: T.UnsignedByteType, mips: true, anisotropy: 4 });
  await forge.step();
  const bytes = (512 * 2048 * 2 + 512 * 512 * 2) * 4 * 4 / 3;
  return { woodA, woodN, rockA, rockN, bytes };
}
