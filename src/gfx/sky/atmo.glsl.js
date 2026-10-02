/* ===========================================================
   大気の GLSL（Hillaire 2020）。CPU 双子は atmosphere.js（同じ式・同じ写像）
   -----------------------------------------------------------
   GPU は km 単位（float32 で地球の半径を扱うため）。定数は ATMO から生成する。
   - NG_SKY_ATMO_GLSL：媒質・球の交差・透過 LUT の写像・位相関数（ngSky 接頭辞）
   - TRANS_FRAG：透過 LUT 256×64（Bruneton の (r, μ) 写像。haze が 2% 変わったら焼き直す）
   - MS_FRAG：多重散乱 LUT 32²（Hillaire §5.5 の ψ_ms。64 方向 × 20 段）
   - SKYCLEAR_FRAG：晴れの空の放射輝度（ngSkyViewUV の写像、256×128、毎フレーム）。
     太陽と月の 2 灯・オゾン・地球の影（ビーナスベルト）・雲の甲板の下の陰り
   - SKYVIEW_FRAG：services の skyView（晴れの空 ⊕ 雲パノラマ、mip 付き）
   =========================================================== */
import { ATMO, TWS, SUN_CLAMP_SY } from './atmosphere.js';
import { NG_FRAME_GLSL } from '../core/frame.js';
import { NG_SURFACE_GLSL } from '../core/glsl/surface.glsl.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const v3 = (a, k = 1) => `vec3(${a.map((x) => f(x * k)).join(', ')})`;

/** 大気の共通部品（サンプラー無し） */
export const NG_SKY_ATMO_GLSL = /* glsl */ `
#ifndef NG_LIB_SKY_ATMO
#define NG_LIB_SKY_ATMO
#define NG_SKY_RG ${f(ATMO.Rg / 1e3)}
#define NG_SKY_RT ${f(ATMO.Rt / 1e3)}
#define NG_SKY_HTOP ${f(Math.sqrt(ATMO.Rt * ATMO.Rt - ATMO.Rg * ATMO.Rg) / 1e3)}
const vec3 NG_SKY_BR = ${v3(ATMO.betaR, 1e3)};
const vec3 NG_SKY_OZ = ${v3(ATMO.ozone, 1e3)};
const float NG_SKY_MS = ${f(ATMO.mieS * 1e3)};
const float NG_SKY_MA = ${f(ATMO.mieA * 1e3)};
const float NG_SKY_HR = ${f(ATMO.HR / 1e3)};
const float NG_SKY_HM = ${f(ATMO.HM / 1e3)};
const float NG_SKY_OZC = ${f(ATMO.ozoneC / 1e3)};
const float NG_SKY_OZW = ${f(ATMO.ozoneW / 1e3)};
const float NG_SKY_G = ${f(ATMO.mieG)};
const float NG_SKY_SUNCLAMP = ${f(SUN_CLAMP_SY)};
const float NG_SKY_SUNCLAMPC = ${f(Math.sqrt(1 - SUN_CLAMP_SY * SUN_CLAMP_SY))};
const float NG_SKY_ALBEDO = ${f(ATMO.albedo)};
const float NG_SKY_VIEWR = ${f((ATMO.Rg + ATMO.viewH) / 1e3)};

/* 高さ h（km）の散乱 Rayleigh rgb・散乱 Mie・消散 rgb（1/km） */
void ngSkyMedium(float h, float haze, out vec3 sR, out float sM, out vec3 ext) {
  h = max(h, 0.0);
  float rR = exp(-h / NG_SKY_HR), rM = exp(-h / NG_SKY_HM);
  float rO = max(0.0, 1.0 - abs(h - NG_SKY_OZC) / NG_SKY_OZW);
  sR = NG_SKY_BR * rR;
  sM = NG_SKY_MS * haze * rM;
  ext = sR + vec3(sM + NG_SKY_MA * haze * rM) + NG_SKY_OZ * rO;
}
float ngSkyDistTop(float r, float mu) {
  float d = r * r * (mu * mu - 1.0) + NG_SKY_RT * NG_SKY_RT;
  return max(-r * mu + sqrt(max(d, 0.0)), 0.0);
}
/* 地面に当たるなら距離、当たらなければ −1 */
float ngSkyDistGround(float r, float mu) {
  float d = r * r * (mu * mu - 1.0) + NG_SKY_RG * NG_SKY_RG;
  if (mu >= 0.0 || d < 0.0) return -1.0;
  return max(-r * mu - sqrt(d), 0.0);
}
/* 半径 R の球の外側の交点（中から外へ向かう光線。外から入るときは近い方） */
float ngSkyShell(float r, float mu, float R) {
  float d = r * r * (mu * mu - 1.0) + R * R;
  if (d < 0.0) return -1.0;
  float s = sqrt(d);
  float t0 = -r * mu - s, t1 = -r * mu + s;
  return t0 > 0.0 ? t0 : t1;
}
float ngSkyMuHorizon(float r) { float k = NG_SKY_RG / r; return -sqrt(max(1.0 - k * k, 0.0)); }
float ngSkyU2Uv(float x, float n) { return 0.5 / n + x * (1.0 - 1.0 / n); }
float ngSkyUv2U(float u, float n) { return (u - 0.5 / n) / (1.0 - 1.0 / n); }
vec2 ngSkyTransUV(float r, float mu) {
  float rho = sqrt(max(r * r - NG_SKY_RG * NG_SKY_RG, 0.0));
  float d = ngSkyDistTop(r, mu);
  float dMin = NG_SKY_RT - r, dMax = rho + NG_SKY_HTOP;
  float xm = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0.0;
  return vec2(ngSkyU2Uv(clamp(xm, 0.0, 1.0), 256.0), ngSkyU2Uv(clamp(rho / NG_SKY_HTOP, 0.0, 1.0), 64.0));
}
vec2 ngSkyTransRMu(vec2 uv) {
  float xm = clamp(ngSkyUv2U(uv.x, 256.0), 0.0, 1.0), xr = clamp(ngSkyUv2U(uv.y, 64.0), 0.0, 1.0);
  float rho = NG_SKY_HTOP * xr;
  float r = sqrt(rho * rho + NG_SKY_RG * NG_SKY_RG);
  float dMin = NG_SKY_RT - r, dMax = rho + NG_SKY_HTOP;
  float d = dMin + xm * (dMax - dMin);
  float mu = d <= 0.0 ? 1.0 : clamp((NG_SKY_HTOP * NG_SKY_HTOP - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  return vec2(r, mu);
}
float ngSkyPhaseR(float mu) { return 0.0596831 * (1.0 + mu * mu); }
float ngSkyPhaseHG(float mu, float g) { float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4); return 0.07957747 * (1.0 - g * g) / (d * sqrt(d)); }
float ngSkyPhaseCS(float mu, float g) {
  float k = 0.1193662 * (1.0 - g * g) / (2.0 + g * g);
  float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  return k * (1.0 + mu * mu) / (d * sqrt(d));
}
#endif
`;

/** 透過 LUT を読む部品（uniform ngSkyTrans が要る） */
export const NG_SKY_TRANS_GLSL = NG_SKY_ATMO_GLSL + /* glsl */ `
#ifndef NG_LIB_SKY_TRANS
#define NG_LIB_SKY_TRANS
uniform sampler2D ngSkyTrans;
vec3 ngSkyT(float r, float mu) { return texture(ngSkyTrans, ngSkyTransUV(r, mu)).rgb; }
/* 太陽への透過（地球の影込み。太陽の半径ぶん滑らかに） */
vec3 ngSkySunT(float r, float mu) {
  float mh = ngSkyMuHorizon(r);
  return ngSkyT(r, mu) * smoothstep(mh - 0.006, mh + 0.006, mu);
}
#endif
`;

export const TRANS_FRAG = NG_SKY_ATMO_GLSL + /* glsl */ `
uniform float uHaze;
void main() {
  vec2 rm = ngSkyTransRMu(vUv);
  float r = rm.x, mu = rm.y;
  float d = ngSkyDistTop(r, mu), dt = d / 40.0;
  vec3 od = vec3(0.0), sR, ext; float sM;
  for (int i = 0; i < 40; i++) {
    float t = (float(i) + 0.5) * dt;
    float h = sqrt(r * r + t * t + 2.0 * r * mu * t) - NG_SKY_RG;
    ngSkyMedium(h, uHaze, sR, sM, ext);
    od += ext * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}
`;

export const MS_FRAG = NG_SKY_TRANS_GLSL + /* glsl */ `
uniform float uHaze;
void main() {
  float muS = clamp(ngSkyUv2U(vUv.x, 32.0) * 2.0 - 1.0, -1.0, 1.0);
  float r = NG_SKY_RG + clamp(ngSkyUv2U(vUv.y, 32.0), 0.0, 1.0) * (NG_SKY_RT - NG_SKY_RG) + 0.001;
  vec3 sunD = vec3(sqrt(max(1.0 - muS * muS, 0.0)), muS, 0.0);
  vec3 L2 = vec3(0.0), Fms = vec3(0.0);
  const int ND = 64;
  const float GA = 2.39996323;
  vec3 sR, ext; float sM;
  for (int k = 0; k < ND; k++) {
    float y = 1.0 - 2.0 * (float(k) + 0.5) / float(ND);
    float rr = sqrt(max(1.0 - y * y, 0.0)), a = GA * float(k);
    vec3 d = vec3(cos(a) * rr, y, sin(a) * rr);
    float tG = ngSkyDistGround(r, y);
    float tMax = tG >= 0.0 ? tG : ngSkyDistTop(r, y);
    float dt = tMax / 20.0;
    vec3 thr = vec3(1.0), L = vec3(0.0), fm = vec3(0.0);
    for (int s = 0; s < 20; s++) {
      float t = (float(s) + 0.5) * dt;
      vec3 p = vec3(d.x * t, r + y * t, d.z * t);
      float rp = length(p);
      float muSp = dot(p, sunD) / rp;
      ngSkyMedium(rp - NG_SKY_RG, uHaze, sR, sM, ext);
      vec3 tS = ngSkySunT(rp, muSp);
      vec3 sig = sR + vec3(sM);
      vec3 e = max(ext, vec3(1e-9));
      vec3 Tk = exp(-ext * dt);
      vec3 S = sig * tS * 0.07957747;
      L += thr * (S - S * Tk) / e;
      fm += thr * (sig - sig * Tk) / e;
      thr *= Tk;
    }
    if (tG >= 0.0) {
      vec3 p = vec3(d.x * tMax, r + y * tMax, d.z * tMax);
      float rp = length(p);
      float muSp = dot(p, sunD) / rp;
      L += thr * ngSkySunT(rp, muSp) * max(muSp, 0.0) * NG_SKY_ALBEDO / 3.14159265;
    }
    L2 += L / float(ND); Fms += fm / float(ND);
  }
  gl_FragColor = vec4(L2 / max(1.0 - Fms, vec3(1e-3)), 1.0);
}
`;

/**
 * 晴れの空（ngSkyViewUV の写像）。uSkyE：x = 太陽の上端の照度（ng）、y = 月、z = 空の係数 G、w = haze
 * uSkyDeck：x = 雲の甲板の高さ（km）、y = 甲板の下の太陽の遮り 0..1、zw 予備。uSkyDeckL：甲板の底の放射輝度（ng、等方の光源）
 */
export const SKY_COMMON_GLSL = NG_SKY_TRANS_GLSL + /* glsl */ `
#ifndef NG_LIB_SKY_COMMON
#define NG_LIB_SKY_COMMON
uniform sampler2D ngSkyMS;
uniform vec4 uSkyE;
uniform vec3 uSkySunCol;
uniform vec3 uSkyMoonCol;   // 月の項の色（rig.js の MOON_TINT）
uniform vec3 uSkySunWarm;   // 太陽の側の地平の数度上の利得 rgb（残照の橙）
/* rig.js の warmWeight と同じ式：太陽の方位の地平ほど 1 */
float ngSkyWarmW(vec3 v, vec3 s) {
  float mu = dot(v.xz, s.xz) / max(length(v.xz) * length(s.xz), 1e-4);
  float a = max(0.5 + 0.5 * mu, 0.0), a2 = a * a;
  return a2 * a2 * a2 * smoothstep(0.0, 0.06, v.y) * exp(-max(v.y, 0.0) * 7.0);
}
/* atmosphere.js の smooth（a > b も可） */
float ngSkySm(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
/* atmosphere.js の twShape と同じ式：薄明の空の色度（ブルーアワーの青・ビーナスベルト・地球の影・残照）と深い薄明の地平の暗さ */
vec3 ngSkyTwShape(vec3 v, vec3 s, vec3 L) {
  float sy = s.y;
  if (sy > 0.06) return L;
  float fade = 1.0 - ngSkySm(-0.24, -0.32, sy);
  float p0 = ngSkySm(0.06, -0.02, sy) * fade;
  if (p0 <= 0.0) return L;
  float dp = ngSkySm(-0.01, -0.12, sy);
  float p2 = ngSkySm(0.035, 0.0, sy) * (1.0 - ngSkySm(-0.035, -0.075, sy));
  float p3 = ngSkySm(-0.07, -0.18, sy) * fade;
  float sh = max(0.004, -sy * 0.85 + 0.006), bt = sh + 0.16;
  float e = clamp(v.y, 0.0, 1.0);
  float mu = dot(v.xz, s.xz) / max(length(v.xz) * length(s.xz), 1e-4);
  float a = max(0.5 + 0.5 * mu, 0.0), a2 = a * a;
  float w0 = a2 * a2 * exp(-5.0 * e);
  float deep = ngSkySm(-0.09, -0.17, sy), ww = w0 * (1.0 - deep), glow = w0 * deep * exp(-6.0 * e);
  float anti = ngSkySm(0.0, -0.85, mu);
  float t = ngSkySm(0.0, 0.45, e);
  float belt = p2 * anti * ngSkySm(sh * 0.6, sh + 0.03, e) * (1.0 - ngSkySm(bt - 0.06, bt + 0.04, e));
  float shadow = p2 * anti * (1.0 - ngSkySm(sh * 0.5, sh + 0.02, e));
  vec3 C = mix(mix(${v3(TWS.hor)}, ${v3(TWS.horD)}, dp), mix(${v3(TWS.zen)}, ${v3(TWS.zenD)}, dp), t);
  C = mix(C, ${v3(TWS.belt)}, belt * 0.95);
  C = mix(C, ${v3(TWS.shadow)}, shadow * 0.7);
  C = mix(C, ${v3(TWS.glow)}, glow);
  const vec3 ngTwY = vec3(0.2126, 0.7152, 0.0722);
  float cl = dot(C, ngTwY), lum = dot(L, ngTwY);
  float cw = p0 * (1.0 - ww) * 0.9;
  float dim = 1.0 + (0.38 + 0.62 * ngSkySm(0.0, 0.4, e) - 1.0) * p3 * (1.0 - ww);
  return mix(L, lum * C / cl, cw) * dim;
}
uniform vec4 uSkyDeck;
uniform vec3 uSkyDeckL;
uniform vec3 uSkySunDir;
/* uSkySunCol：薄明の利得（rgb。rig.js の twilightGain：太陽が地平の下のとき、空の «太陽の項だけ» を
   露出の時刻表に見合う明るさとブルーアワーの色度へ持ち上げる。方向ごとの比（ビーナスベルト・地球の影・
   太陽側の残照）は物理のまま。月の項には掛けない） */
vec3 ngSkyMSAt(float r, float muS) {
  vec2 uv = vec2(ngSkyU2Uv(clamp(muS * 0.5 + 0.5, 0.0, 1.0), 32.0), ngSkyU2Uv(clamp((r - NG_SKY_RG) / (NG_SKY_RT - NG_SKY_RG), 0.0, 1.0), 32.0));
  return texture(ngSkyMS, uv).rgb;
}
/* 視線 v の空の放射輝度（ng 単位、G 込み）。steps 段 */
vec3 ngSkyRadiance(vec3 v, int steps) {
  float r = NG_SKY_VIEWR;
  float tG = ngSkyDistGround(r, v.y);
  float tMax = min(tG >= 0.0 ? tG : ngSkyDistTop(r, v.y), 400.0);
  vec3 s = uSkySunDir;
  /* 太陽の項の太陽は −9° より下へ沈めない（atmosphere.js の SUN_CLAMP_SY と同じ。深い薄明は «−9° の空の形 × 利得»） */
  vec3 sS = s.y < NG_SKY_SUNCLAMP ? vec3(normalize(s.xz + vec2(1e-6, 0.0)).x * NG_SKY_SUNCLAMPC, NG_SKY_SUNCLAMP, normalize(s.xz + vec2(1e-6, 0.0)).y * NG_SKY_SUNCLAMPC) : s;
  float muSv = dot(v, s), muSvS = dot(v, sS);
  float pRs = ngSkyPhaseR(muSvS), pMs = ngSkyPhaseCS(muSvS, NG_SKY_G);
  float pRm = ngSkyPhaseR(-muSv), pMm = ngSkyPhaseCS(-muSv, NG_SKY_G);
  float haze = uSkyE.w;
  vec3 eS = mix(uSkySunCol, uSkySunWarm, ngSkyWarmW(v, s)) * uSkyE.x, eM = uSkyMoonCol * uSkyE.y;
  vec3 thr = vec3(1.0), L = vec3(0.0), sR, ext; float sM;
  float tPrev = 0.0, fs = float(steps);
  for (int i = 0; i < 48; i++) {
    if (i >= steps) break;
    float a = (float(i) + 1.0) / fs;
    float t1 = tMax * a * a;
    float tm = 0.5 * (tPrev + t1), dt = t1 - tPrev;
    tPrev = t1;
    vec3 p = vec3(v.x * tm, r + v.y * tm, v.z * tm);
    float rp = length(p);
    float muS = dot(p, s) / rp, muSs = dot(p, sS) / rp;
    float h = rp - NG_SKY_RG;
    ngSkyMedium(h, haze, sR, sM, ext);
    vec3 sig = sR + vec3(sM);
    float below = 1.0 - smoothstep(uSkyDeck.x - 0.2, uSkyDeck.x + 0.2, h);
    float occ = 1.0 - uSkyDeck.y * below;
    vec3 S = vec3(0.0);
    if (uSkyE.x > 0.0) S += eS * occ * (ngSkySunT(rp, muSs) * (sR * pRs + sM * pMs) + ngSkyMSAt(rp, muSs) * sig);
    if (uSkyE.y > 0.0) S += eM * occ * (ngSkySunT(rp, -muS) * (sR * pRm + sM * pMm) + ngSkyMSAt(rp, -muS) * sig);
    S += uSkyDeckL * sig * (0.5 * below) / max(uSkyE.z, 1e-6);
    vec3 e = max(ext, vec3(1e-9));
    vec3 Tk = exp(-ext * dt);
    L += thr * (S - S * Tk) / e;
    thr *= Tk;
  }
  if (tG >= 0.0 && tG < 400.0) {
    vec3 p = vec3(v.x * tMax, r + v.y * tMax, v.z * tMax);
    float rp = length(p);
    float muS = dot(p, s) / rp, muSs = dot(p, sS) / rp;
    vec3 E = vec3(0.0);
    if (uSkyE.x > 0.0) E += eS * ngSkySunT(rp, muSs) * max(muSs, 0.0);
    if (uSkyE.y > 0.0) E += eM * ngSkySunT(rp, -muS) * max(-muS, 0.0);
    L += thr * E * (1.0 - uSkyDeck.y) * NG_SKY_ALBEDO / 3.14159265;
  }
  return ngSkyTwShape(v, s, L * uSkyE.z);
}
#endif
`;

export const SKYCLEAR_FRAG = NG_SURFACE_GLSL + SKY_COMMON_GLSL + /* glsl */ `
uniform float uSteps;
void main() {
  vec3 v = ngSkyViewDir(vUv);
  /* 地平のすぐ下は地平の値に寄せる（球の地平の折れ目でテクセルが割れない） */
  vec3 L = ngSkyRadiance(normalize(vec3(v.x, max(v.y, -0.9), v.z)), int(uSteps));
  gl_FragColor = vec4(min(L, vec3(60000.0)), 1.0);
}
`;

/** services の skyView：晴れの空 ⊕ 雲パノラマ（rgb = 足す、a = 空に掛ける） */
export const SKYVIEW_FRAG = NG_SURFACE_GLSL + /* glsl */ `
uniform sampler2D uSkyClear;
uniform sampler2D uCloudPano;
void main() {
  vec3 v = ngSkyViewDir(vUv);
  vec3 L = texture(uSkyClear, vUv).rgb;
  if (v.y > 0.0) {
    vec4 c = texture(uCloudPano, vec2(vUv.x, clamp(vUv.y * 2.0 - 1.0, 0.0, 1.0)));
    L = L * c.a + c.rgb;
  }
  gl_FragColor = vec4(min(L, vec3(60000.0)), 1.0);
}
`;

export { NG_FRAME_GLSL };
