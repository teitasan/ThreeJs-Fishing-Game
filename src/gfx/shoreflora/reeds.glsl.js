/* ===========================================================
   ヨシ・マコモ（placement.reeds、葦際）— ngExtendStandard の口
   -----------------------------------------------------------
   型板 = 1 株（茎 12 本 × 6 節のテーパーしたリボン + 葉 8 枚 × 4 節 + 穂の十字 2 枚）。
   position = (茎の番号, t, 横 ±1)、ngPart = 0 茎 / 1..8 葉 / 9, 10 穂 / 11 株のカード。
   インスタンスの属性：ngRi0 = (x, 湖底の y, z, 高さ)、ngRi1 = (密度, 回転, 種類 0 ヨシ・1 マコモ, ハッシュ)。
   茎は軸の周りでカメラへ向ける（影のパスでは光へ向く）。強い風の揺れ（ngWindAt）、根元の濡れ色（水面の高さ）。
   ngSfReed.x = 型：0 近い株・1 反射の LOD1（茎と葉を減らす）・2 遠くの株のカード
   去年の枯れた茎（約 3 割、麦わら色で穂が残る）と今年の青い茎を混ぜる（初夏の葦原）
   =========================================================== */
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { NG_WIND_GLSL } from '../core/glsl/wind.glsl.js';
import { NG_SURFACE_GLSL } from '../core/glsl/surface.glsl.js';
import { SF_TPL } from './quality.js';

export const SF_REED_VS_PARS = NG_WIND_GLSL + /* glsl */ `
in vec4 ngRi0;
in vec4 ngRi1;
in float ngPart;
uniform vec4 ngSfReed;   // x = 型, y = 近い株の距離, z = 消える帯, w = カードの距離
uniform vec3 ngSfCam;    // xyz = 主のカメラの位置（影・反射のパスでも距離の判定はこれ）
out vec4 vSfA;   // x = t, y = 横, z = 部位, w = 種類
out vec4 vSfB;   // x = 茎のハッシュ, y = 枯れ 0/1, z = 葉の番号, w = 高さの割合（水面から）
out vec2 vSfC;   // カード：(u, v)
vec3 ngSfP;
vec3 ngSfBez(vec3 a, vec3 b, vec3 c, float t) { float s = 1.0 - t; return s * s * a + 2.0 * s * t * b + t * t * c; }
vec3 ngSfBezD(vec3 a, vec3 b, vec3 c, float t) { return 2.0 * (1.0 - t) * (b - a) + 2.0 * t * (c - b); }
/* 茎の中心線（水面より上だけ風で曲がる）：y = mix(y0, top, u) */
vec3 ngSfStem(vec3 root, float y0, float top, vec2 bendV, float u) {
  float y = mix(y0, top, u);
  float a = clamp(y / max(top, 0.1), 0.0, 1.0);
  vec3 p = vec3(root.x, y, root.z);
  p.xz += bendV * (a * a) * top;
  p.y -= 0.5 * dot(bendV, bendV) * a * a * top;
  return p;
}
`;

export const SF_REED_VS_NORMAL = /* glsl */ `
{
  vec3 base = vec3(ngRi0.x, ngRi0.y, ngRi0.z);
  float Hc = max(ngRi0.w, 0.6);
  float dens = ngRi1.x, rot = ngRi1.y, kind = ngRi1.z, hc = ngRi1.w;
  float mode = ngSfReed.x;
  float part = ngPart;
  float si = position.x, t = position.y, sd = position.z;
  float dist = distance(base.xz, ngSfCam.xz);
  vec3 P = base, N = vec3(0.0, 1.0, 0.0);
  vec4 W = ngWindAt(base.xz);
  float sp = W.z;
  vec2 perp = vec2(-W.y, W.x);
  bool dead = false;
  float hs = 0.0, old = 0.0, frac = 0.0;
  vSfC = vec2(0.0);
  vSfB = vec4(0.0);
  if (part > 10.5) {
    hs = hc;
    /* ---- 遠くの株のカード：軸の周りでカメラへ向く 1 枚。近い株の帯で現れる ---- */
    /* 近い株の中でも密な株は奥に «茎の筋» のカードを 1 枚置いて、茎の本数（§7 の予算）以上の密度に見せる */
    /* 近すぎる所では出さない（画面の大きなカードの α の 9 回の繰り返しが重い：1440p で opaque の大半）。15–25m で現れる */
    float fill = smoothstep(15.0, 25.0, dist) * smoothstep(0.35, 0.6, dens) * 0.8;
    float grow = max(smoothstep(ngSfReed.y - ngSfReed.z, ngSfReed.y, dist), fill) * (1.0 - smoothstep(ngSfReed.w * 0.85, ngSfReed.w, dist));
    if (grow <= 0.001) dead = true;
    float wdt = (0.7 + 0.9 * dens) * mix(0.85, 1.15, hc);
    float top = Hc * mix(0.7, 1.05, hc) * grow;
    vec3 toC3 = ngSfCam - base;
    vec3 toC = toC3; toC.y = 0.0;
    vec3 ax = normalize(cross(vec3(0.0, 1.0, 0.0), normalize(toC + vec3(1e-4))));
    /* 見下ろすほど株の «上» をカメラへ倒す（真上から細い縞にならない） */
    float elev = clamp(toC3.y / max(length(toC3), 1e-3), 0.0, 1.0);
    vec3 upv = normalize(mix(vec3(0.0, 1.0, 0.0), -normalize(toC + vec3(1e-4)), smoothstep(0.35, 0.95, elev) * 0.85));
    float y0c = min(base.y, -0.05);
    float lean = (0.03 * sp + 0.01 * sp * sp) * t * t * top;
    P = vec3(base.x, y0c, base.z) + upv * (t * (top - y0c)) + ax * sd * wdt * 0.5 + vec3(W.x, 0.0, W.y) * lean;
    float y = P.y;
    N = normalize(vec3(toC.x, 0.4 * length(toC), toC.z) + vec3(1e-4));
    vSfC = vec2(sd * 0.5 + 0.5, t);
    frac = clamp(y / max(top, 0.1), 0.0, 1.0);
  } else {
    float ns = min(12.0, floor(1.5 + 8.0 * clamp(dens, 0.0, 1.0) + 0.5));
    if (mode > 0.5) ns = min(ns, 6.0);
    hs = ngHash12(base.xz * 7.13 + si * 3.71 + 0.3);
    float hs2 = ngHash12(base.xz * 3.31 + si * 9.17 + 4.1);
    /* 近い株の帯の外側で茎を 1 本ずつ抜く（カードへ渡す） */
    float keep = 1.0 - smoothstep(ngSfReed.y - ngSfReed.z, ngSfReed.y, dist);
    /* 遠い近景（25m → 近い株の端）は茎を 55% まで間引き、残りを太らせて面積を保つ（頂点の数を減らす） */
    float thinK = mix(1.0, 0.55, smoothstep(25.0, max(ngSfReed.y, 26.0), dist));
    if (si >= ns || hs2 > keep * thinK * 1.02 - 0.01) dead = true;
    old = step(hs, 0.3);
    float ang = si * 2.39996 + hc * 6.2831;
    float rr = (0.07 + 0.2 * dens) * sqrt((si + 0.5) / max(ns, 1.0)) * mix(0.7, 1.3, hs2);
    vec3 root = base + vec3(cos(ang) * rr, 0.0, sin(ang) * rr);
    float y0 = min(base.y, -0.02) - 0.05;
    float top = Hc * mix(0.72, 1.05, hs2) * (kind > 0.5 ? 0.85 : 1.0) * mix(1.0, 0.9, old);
    /* 風：静かな傾き + 突風の波（風下へ流れる）+ 茎ごとの揺れ。ヨシは強く揺れる */
    float ph = dot(base.xz, W.xy) * 0.35 - ngEnvTime * (1.15 + 0.15 * sp) + hs * 6.2831;
    float lean = (0.045 * sp + 0.014 * sp * sp) * (0.6 + 0.8 * W.w);
    float osc = sin(ph) * (0.3 + 0.7 * W.w) * (0.03 + 0.035 * sp);
    vec2 bendV = W.xy * (lean + osc) + perp * sin(ph * 1.9 + hs2 * 5.0) * (0.01 + 0.012 * sp);
    bendV *= mix(1.0, 0.75, old);
    vec3 C = ngSfCam - root;
    if (part < 0.5) {
      /* ---- 茎：テーパーしたリボン（6 節）。軸の周りでカメラへ ---- */
      vec3 Pc = ngSfStem(root, y0, top, bendV, t);
      vec3 Pn = ngSfStem(root, y0, top, bendV, min(t + 0.05, 1.0));
      vec3 Pp = ngSfStem(root, y0, top, bendV, max(t - 0.05, 0.0));
      vec3 T = normalize(Pn - Pp + vec3(0.0, 1e-4, 0.0));
      vec3 V = normalize(cameraPosition - Pc);
      vec3 S = normalize(cross(T, V) + vec3(1e-5));
      float w = mix(0.0075, 0.0022, t) * (kind > 0.5 ? 1.25 : 1.0) * (mode > 0.5 ? 1.6 : 1.0) * inversesqrt(thinK);
      P = Pc + S * w * sd;
      N = normalize(cross(S, T) * (dot(cross(S, T), V) < 0.0 ? -1.0 : 1.0) + S * sd * 0.7);
      frac = clamp(P.y / max(top, 0.1), 0.0, 1.0);
    } else if (part < 8.5) {
      /* ---- 葉：ヨシは茎の上 2/3 に互生、マコモは根元から長く弓なりに ---- */
      float k = part - 1.0;
      float hk = ngHash12(base.xz * 1.9 + si * 5.3 + k * 2.7);
      float u0, len, wmax;
      /* 葉の数は型板の通り（近い株 ${SF_TPL.reed.leaves} 枚・LOD1 ${SF_TPL.reedLod1.leaves} 枚）。茎の上に均等に散らす */
      float nLeaf = mode > 0.5 ? ${SF_TPL.reedLod1.leaves.toFixed(1)} : ${SF_TPL.reed.leaves.toFixed(1)};
      if (kind < 0.5) {
        u0 = mix(0.16, 0.9, (k + 0.3 * hk) / nLeaf);
        len = mix(0.3, 0.5, hk) * clamp(top / 2.2, 0.6, 1.3) * mix(1.0, 0.7, old);
        wmax = 0.032;
      } else {
        u0 = mix(0.04, 0.34, (k + 0.3 * hk) / nLeaf);
        len = top * mix(0.45, 0.8, hk);
        wmax = 0.024;
      }
      float yl = max(u0 * top, -0.02);
      float ul = (yl - y0) / max(top - y0, 0.1);
      vec3 p0 = ngSfStem(root, y0, top, bendV, ul);
      float az = hs * 6.2831 + k * 3.14159 + (hk - 0.5) * 0.8 + rot;
      vec2 od = vec2(cos(az), sin(az));
      float droop = kind < 0.5 ? mix(0.35, 0.8, hk) : mix(0.7, 1.15, hk);
      vec2 wb = (W.xy * (lean + osc) * 1.8 + perp * osc) * len;
      vec3 ctl = p0 + vec3(od.x * 0.42 * len, (kind < 0.5 ? 0.45 : 0.7) * len, od.y * 0.42 * len) + vec3(wb.x, 0.0, wb.y) * 0.4;
      vec3 tip = p0 + vec3(od.x * 0.82 * len, (0.55 - droop) * len, od.y * 0.82 * len) + vec3(wb.x, -0.3 * length(wb), wb.y);
      vec3 Pc = ngSfBez(p0, ctl, tip, t);
      vec3 T = normalize(ngSfBezD(p0, ctl, tip, max(t, 0.02)));
      float tw = (hk - 0.5) * 1.5 * t;
      vec3 S0 = normalize(cross(T, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));
      vec3 S = normalize(S0 * cos(tw) + cross(T, S0) * sin(tw));
      float w = wmax * sin(3.14159 * pow(clamp(t, 0.0, 1.0), 0.55)) * mix(1.0, 0.8, old);
      if (old > 0.5 && hk > 0.55) w = 0.0;   // 枯れ茎の葉は落ちている
      P = Pc + S * w * sd;
      N = normalize(cross(S, T));
      if (N.y < 0.0) N = -N;
      N = normalize(N + S * sd * 0.3);
      frac = clamp(P.y / max(top, 0.1), 0.0, 1.0);
      vSfB.z = k;
    } else {
      /* ---- 穂（ヨシだけ）：茎の先に 0.2–0.3m、風下へ垂れる十字の 2 枚。カードの模様は断片 ---- */
      if (kind > 0.5 || (old < 0.5 && hs2 > 0.35)) dead = true;
      vec3 tp = ngSfStem(root, y0, top, bendV, 1.0);
      vec3 tp2 = ngSfStem(root, y0, top, bendV, 0.97);
      vec3 ax = normalize(tp - tp2);
      vec3 dn = normalize(ax + vec3(bendV.x, -0.6, bendV.y) * 1.2);
      float pl = mix(0.18, 0.3, hs2) * clamp(top / 2.2, 0.7, 1.2);
      vec3 across = part < 9.5 ? normalize(cross(dn, vec3(perp.x, 0.0, perp.y)) + vec3(1e-5)) : normalize(vec3(perp.x, 0.0, perp.y));
      float pw = 0.055 * sin(3.14159 * pow(clamp(t, 0.0, 1.0), 0.7)) + 0.012;
      P = tp + dn * (t * pl - 0.02) + across * pw * sd;
      N = normalize(cross(across, dn));
      vec3 V = normalize(cameraPosition - P);
      if (dot(N, V) < 0.0) N = -N;
      frac = 1.0;
    }
  }
  if (dead) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vSfA = vec4(t, sd, part, kind);
  vSfB.xyw = vec3(hs, old, frac);
  ngSfP = P;
  objectNormal = N;
}
`;

export const SF_REED_VS_BEGIN = /* glsl */ `transformed = ngSfP;`;

export const SF_REED_FS_PARS = NG_NOISE_GLSL + NG_SURFACE_GLSL + /* glsl */ `
in vec4 vSfA;
in vec4 vSfB;
in vec2 vSfC;
`;

export const SF_REED_FS_SURFACE = /* glsl */ `
float ngSfPart = vSfA.z;
float ngSfOld = vSfB.y;
float ngSfPor = 0.2;
{
  float kind = vSfA.w, t = vSfA.x;
  float n1 = ngVNoise2(vNgWorld.xz * 0.6 + 2.0);
  vec3 c;
  if (ngSfPart > 10.5) {
    /* カード：茎の筋と穂の点（遠目の色は近い株の平均へ） */
    vec2 uv = vSfC;
    c = mix(vec3(0.058, 0.088, 0.032), vec3(0.15, 0.13, 0.07), 0.15 + 0.3 * n1 + 0.2 * step(vSfB.x, 0.3));
    c = mix(c, vec3(0.16, 0.12, 0.10), smoothstep(0.82, 0.95, uv.y) * (kind < 0.5 ? 0.7 : 0.0));
  } else if (ngSfPart < 0.5) {
    /* 茎：青い茎は黄緑〜灰緑、去年の茎は麦わら色。下は褐色 */
    vec3 fresh = mix(vec3(0.085, 0.105, 0.040), vec3(0.11, 0.12, 0.05), vSfB.x);
    vec3 straw = mix(vec3(0.26, 0.21, 0.12), vec3(0.32, 0.27, 0.16), vSfB.x);
    c = mix(fresh, straw, ngSfOld);
    c = mix(vec3(0.10, 0.075, 0.045), c, smoothstep(0.0, 0.25, vSfB.w));
    c *= 0.9 + 0.2 * (1.0 - abs(vSfA.y));
    ngSfPor = 0.15;
  } else if (ngSfPart < 8.5) {
    vec3 fresh = kind < 0.5 ? mix(vec3(0.060, 0.098, 0.032), vec3(0.080, 0.118, 0.040), n1) : mix(vec3(0.066, 0.115, 0.034), vec3(0.090, 0.135, 0.042), n1);
    vec3 straw = vec3(0.24, 0.19, 0.11);
    c = mix(fresh, straw, max(ngSfOld, smoothstep(0.78, 1.0, t) * 0.55));
    /* ヨシの葉は粉を吹いた灰緑：彩度を少し落とす */
    c = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))), 0.18);
    /* 葉の中肋と平行脈（縦の筋）、付け根は暗く先へ明るく */
    c *= 1.0 + 0.12 * (1.0 - smoothstep(0.0, 0.2, abs(vSfA.y)));
    c *= 0.95 + 0.07 * smoothstep(0.3, 0.5, abs(fract(vSfA.y * 3.5 + 0.5) - 0.5));
    c *= mix(0.82, 1.06, smoothstep(0.0, 0.55, t));
    ngSfPor = 0.1;
  } else {
    /* 穂：去年の穂は銀褐色、今年の若い穂は紫褐色 */
    c = mix(vec3(0.20, 0.14, 0.12), vec3(0.34, 0.30, 0.24), ngSfOld);
    ngSfPor = 0.4;
  }
  /* 水際の濡れ色：水面（y ≈ 0）から 8cm 上までは濡れて暗く、藻で緑がかる。水の中は褐色 */
  float wl = vNgWorld.y - 0.02 * (ngVNoise2(vNgWorld.xz * 9.0) - 0.5);
  float wet = 1.0 - smoothstep(0.0, 0.09, wl);
  c = mix(c, c * vec3(0.42, 0.48, 0.36) + vec3(0.004, 0.008, 0.002), wet * 0.85);
  c = mix(c, vec3(0.05, 0.05, 0.028), smoothstep(0.0, -0.15, wl) * 0.7);
  diffuseColor.rgb = c;
}
`;

/* 穂の羽毛・カードの茎の筋（alpha）。茎・葉は不透明 */
export const SF_REED_FS_ALPHA = /* glsl */ `
if (vSfA.z > 10.5) {
  vec2 uv = vSfC;
  float a = 0.0;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float x0 = fract(sin(fi * 17.13 + vSfB.x * 31.0) * 4375.5) * 0.8 + 0.1;
    float ht = 0.65 + 0.35 * fract(sin(fi * 7.77) * 937.3);
    float x = x0 + (uv.y * uv.y) * 0.12 * (fract(fi * 0.618) - 0.5);
    float wl = max(mix(0.035, 0.014, uv.y), fwidth(uv.x) * 1.6);
    a = max(a, (1.0 - smoothstep(wl * 0.6, wl, abs(uv.x - x))) * step(uv.y, ht));
    /* 葉の斜めの筋 */
    float lf = abs(uv.x - x - (uv.y - 0.4 - 0.1 * fi / 7.0) * 0.8);
    float lw = max(0.022, fwidth(uv.x) * 1.4);
    a = max(a, (1.0 - smoothstep(lw * 0.45, lw, lf)) * step(0.15, uv.y) * step(uv.y, 0.4 + 0.07 * fi) * step(abs(uv.x - x), 0.18));
  }
  diffuseColor.a = a * smoothstep(0.0, 0.03, uv.x) * smoothstep(1.0, 0.97, uv.x);
} else if (vSfA.z > 8.5) {
  float v = abs(vSfA.y), t = vSfA.x;
  float strands = ngVNoise2(vec2(v * 9.0 + t * 3.0, t * 46.0 + vSfB.x * 20.0));
  float edge = 1.0 - smoothstep(0.55, 1.0, v);
  diffuseColor.a = smoothstep(0.35, 0.6, strands * edge + 0.35 * (1.0 - v));
}
`;

export const SF_REED_FS_ROUGH = /* glsl */ `
roughnessFactor = ngSfPart < 0.5 ? mix(0.42, 0.7, ngSfOld) : (ngSfPart < 8.5 ? mix(0.5, 0.75, ngSfOld) : 0.85);
ngWetSurface(diffuseColor.rgb, roughnessFactor, ngSfPor, ngWet);
`;

export const SF_REED_FS_LIGHTS = /* glsl */ `
{
  vec3 Lw = ngKeyDir;
  vec3 Vw = normalize(cameraPosition - vNgWorld);
  vec3 Nw = inverseTransformDirection(normal, viewMatrix);
  vec3 E = ngKeyPreShadow * ngNearVis;
  float ndl = dot(Nw, Lw);
  float wrap = max((ndl + 0.5) / 1.5, 0.0) - max(ndl, 0.0);
  reflectedLight.directDiffuse += E * diffuseColor.rgb * wrap * (0.5 / 3.14159265);
  /* 透過：逆光の葉と穂。穂は細い毛が光を散らすので強く、金色に */
  float mu = dot(-Vw, Lw), g = ngSfPart > 8.5 && ngSfPart < 10.5 ? 0.62 : 0.5;
  float hg = (1.0 - g * g) / (4.0 * 3.14159265 * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
  float thin = ngSfPart < 0.5 ? 0.35 : (ngSfPart < 8.5 ? 1.0 : (ngSfPart < 10.5 ? 2.2 : 0.8));
  vec3 trc = ngSfPart > 8.5 && ngSfPart < 10.5 ? diffuseColor.rgb * vec3(1.6, 1.35, 0.9) : diffuseColor.rgb * vec3(1.25, 1.5, 0.75);
  /* 太陽が低いほど逆光が要る（夕方の穂が光る）。地平の下で消す */
  float sunUp = smoothstep(-0.03, 0.10, Lw.y);
  reflectedLight.directDiffuse += E * trc * (hg * 2.0 + 0.06) * thin * sunUp * step(0.0, vNgWorld.y);
}
`;

export const SF_REED_FS_AO = /* glsl */ `
{
  /* 株の中は暗い（茎の密集）：下ほど空が見えない */
  float ao = mix(0.4, 1.0, smoothstep(0.0, 0.7, vSfB.w));
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.indirectSpecular *= ao;
}
`;

/**
 * 型板（茎・葉・穂）。lod1 は茎 5 本・葉 2 枚・節を少なく
 * @param {typeof import('three')} T
 * @param {{stems:number, nodes:number, leaves:number, leafNodes:number}} s
 * @param {boolean} plume
 */
export function reedTemplate(T, s, plume = true) {
  const pos = [], part = [], idx = [];
  const ribbon = (si, nodes, p) => {
    const o = pos.length / 3;
    for (let k = 0; k < nodes; k++) {
      const t = k / (nodes - 1);
      pos.push(si, t, -1, si, t, 1);
      part.push(p, p);
    }
    for (let k = 0; k < nodes - 1; k++) { const a = o + 2 * k; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  };
  for (let si = 0; si < s.stems; si++) {
    ribbon(si, s.nodes, 0);
    for (let k = 0; k < s.leaves; k++) ribbon(si, s.leafNodes, 1 + k);
    if (plume) { ribbon(si, 3, 9); ribbon(si, 3, 10); }
  }
  const g = new T.InstancedBufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('ngPart', new T.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  g.instanceCount = 0;
  return g;
}

/** 株のカード（1 枚、2 × 2 頂点） */
export function reedCardTemplate(T) {
  const g = new T.InstancedBufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute([0, 0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1], 3));
  g.setAttribute('ngPart', new T.Float32BufferAttribute([11, 11, 11, 11], 1));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  g.instanceCount = 0;
  return g;
}
