/* ===========================================================
   解析媒質 ngApplyMedium（ARCHITECTURE §3.4 / §4.3）
   -----------------------------------------------------------
   全マテリアルが同じ空気と水を通って見える、という前提の芯。
   組込みマテリアル（釣り人・魚）にも fog チャンクから入るので、
   サンプラーを使わない（組込みには共有テクスチャを渡せない）。
   - 空気：Rayleigh + Mie + 朝霧（基準 y から上へ指数）。高さ指数の閉形式
   - 水  ：Beer-Lambert + 内散乱、水中の点には下向き光の減衰
   - 区間は «カメラの位置 × 点の位置 × パス» で分け、各区間を 1 回だけ減衰させる
   JS 双子は ../medium.js（式を変えたら両方を直し、medium-twin テストを通す）
   =========================================================== */
import { NG_HASH_GLSL } from './noise.glsl.js';

/** 媒質・雲影・高さ場影の解析近似。NG_FRAME_GLSL の後に置く */
export const NG_MEDIUM_GLSL = NG_HASH_GLSL + /* glsl */ `
#ifndef NG_LIB_MEDIUM
#define NG_LIB_MEDIUM
#define NG_PI 3.14159265359

float ngLuminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/* (1 - e^-x) / x。x→0 の桁落ちを級数で避ける */
float ngExpDiv(float x) {
  return abs(x) < 1e-2 ? 1.0 - x * (0.5 - x * 0.16666667) : (1.0 - exp(-x)) / x;
}

/* 高さ指数の媒質の光学的厚さ（密度 beta·e^(-y/H) を a→b で積分した閉形式）。
   低い方の端を基準に e^(-u_lo)·(1 − e^(−Δu))/Δu と書くと、どちら向きでも exp があふれない。
   y/H の下限 −20 は水中の点（y < 0）の保険 */
float ngAirOpticalDepth(vec3 a, vec3 b, float beta, float H) {
  H = max(H, 1e-3);
  float ua = max(a.y / H, -20.0), ub = max(b.y / H, -20.0);
  return beta * length(b - a) * exp(-min(ua, ub)) * ngExpDiv(abs(ub - ua));
}

float ngPhaseR(float mu) { return 0.05968310 * (1.0 + mu * mu); }            // 3/(16π)(1+μ²)
float ngPhaseHG(float mu, float g) {
  float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  return 0.07957747 * (1.0 - g * g) / (d * sqrt(d));                          // (1-g²)/(4π(…)^1.5)
}

/* 朝霧は湖の上に溜まる。汀線の外 80m で消える（湖の平均半径で近似） */
float ngMistMask(vec2 xz) {
  return ngLakeRadius > 0.0 ? 1.0 - smoothstep(ngLakeRadius, ngLakeRadius + 80.0, length(xz)) : 1.0;
}

/* 空気の区間 a→b の透過 T と内散乱 Lin（Lin は E·P + A の重み付き平均 × (1-T)） */
void ngAirSegment(vec3 a, vec3 b, out vec3 T, out vec3 Lin) {
  vec3 d = b - a;
  float L = length(d);
  vec3 v = d / max(L, 1e-4);
  float odR = ngAirOpticalDepth(a, b, 1.0, max(ngHR, 1.0));
  float odM = ngAirOpticalDepth(a, b, 1.0, max(ngHM, 1.0));
  vec3 am = vec3(a.x, max(a.y - ngMistBaseY, 0.0), a.z);
  vec3 bm = vec3(b.x, max(b.y - ngMistBaseY, 0.0), b.z);
  float odMist = ngMistDensity * ngMistMask(0.5 * (a.xz + b.xz)) * ngAirOpticalDepth(am, bm, 1.0, max(ngMistH, 0.1));
  vec3 tR = max(ngBetaR, vec3(0.0)) * odR;
  vec3 tM = max(ngBetaM, vec3(0.0)) * odM;
  vec3 tau = tR + tM + vec3(max(odMist, 0.0));
  T = exp(-tau);
  float mu = dot(v, ngKeyDir);
  vec3 E = ngKeyRad, A = ngInscatterAmb;
  float pM = ngPhaseHG(mu, ngMieG);
  vec3 S = tR * (E * ngPhaseR(mu) + A) + tM * (E * pM + A) + odMist * (E * pM + A + ngMistAmb);
  Lin = S * (1.0 - T) / max(tau, vec3(1e-7));
}

/* 水の区間 a→b。Lin は平均深さぶん下向き光で暗くなる */
void ngWaterSegment(vec3 a, vec3 b, out vec3 T, out vec3 Lin) {
  float L = length(b - a);
  T = exp(-(ngSigmaA + ngSigmaS) * L);
  float dAvg = max(-0.5 * (a.y + b.y), 0.0);
  Lin = (1.0 - T) * ngWaterInsc * exp(-(ngSigmaA + 0.3 * ngSigmaS) * dAvg);
}

/* 水中の点に届く下向き光。key の屈折角（スネル、n = 1.333）で光路が伸びる */
vec3 ngDownwelling(float depth) {
  float ky = clamp(ngKeyDir.y, 0.0, 1.0);
  float cw = sqrt(max(1.0 - (1.0 - ky * ky) * 0.56279, 0.0));   // 1/1.333²
  return exp(-(ngSigmaA + 0.3 * ngSigmaS) * max(depth, 0.0) / max(cw, 0.2));
}

/* 点 P を見たときの合成：出力 = L·T + Lin（§3.4 の表をここで分岐する） */
void ngMediumTerms(vec3 P, out vec3 T, out vec3 Lin) {
  vec3 C = cameraPosition;
  if (ngPassId > 1.5) { T = vec3(1.0); Lin = vec3(0.0); return; }        // 影・焼き込み・プローブ
  if (ngPassId > 0.5) { ngAirSegment(C, P, T, Lin); return; }            // 反射：全区間を空気
  bool camUnder = ngUwStrength > 0.5;
  bool ptUnder = P.y < 0.0;
  vec3 Ta, La, Tw, Lw;
  if (!camUnder && !ptUnder) { ngAirSegment(C, P, T, Lin); return; }
  float dy = C.y - P.y;
  float t = clamp(C.y / (abs(dy) < 1e-4 ? 1e-4 : dy), 0.0, 1.0);
  vec3 X = C + (P - C) * t;                                               // 水面との交点
  if (!camUnder) {                                                        // 空気 → 水中の点
    ngAirSegment(C, X, Ta, La);
    ngWaterSegment(X, P, Tw, Lw);
    T = ngDownwelling(-P.y) * Tw * Ta;
    Lin = Lw * Ta + La;
  } else if (ptUnder) {                                                   // 水中 → 水中の点
    ngWaterSegment(C, P, Tw, Lw);
    T = ngDownwelling(-P.y) * Tw;
    Lin = Lw;
  } else {                                                                // 水中 → 水上の点：空気の区間だけ
    ngAirSegment(X, P, T, Lin);
  }
}

vec3 ngApplyMedium(vec3 L, vec3 P) {
  vec3 T, Lin;
  ngMediumTerms(P, T, Lin);
  return L * T + Lin;
}

/* 雲の被覆（0..1）。sky の雲・雲影・CPU 双子と同じ式（3 オクターブの値ノイズ） */
float ngCloudNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ngHash12(i), ngHash12(i + vec2(1.0, 0.0)), u.x),
             mix(ngHash12(i + vec2(0.0, 1.0)), ngHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float ngCloudCoverAt(vec2 xz) {
  vec2 q = (xz + ngCloudShOffset) * ngCloudShInvScale;
  float n = 0.5 * ngCloudNoise(q) + 0.3 * ngCloudNoise(q * 2.03 + 11.7) + 0.2 * ngCloudNoise(q * 4.11 + 3.9);
  float c = clamp(ngCloudCover, 0.0, 1.0);
  return smoothstep(1.0 - c - 0.12, 1.0 - c + 0.22, n);
}
/* 雲の影（1 = 日向）。key の向きに雲底まで投影する */
float ngCloudShadow(vec3 P) {
  vec3 k = ngKeyDir;
  float up = max(k.y, 0.05);
  vec2 xz = P.xz + k.xz / up * max(ngCloudBase - P.y, 0.0);
  return 1.0 - clamp(ngCloudShStrength, 0.0, 1.0) * ngCloudCoverAt(xz);
}

#ifdef NG_HF_SHADOW
float ngHfShadowFar(vec3 P);   // shadow.glsl.js（ngExtendStandard の hfShadow: true で入る）
#endif
/* 組込みマテリアル用の高さ場影の代わり。近景の影の外で key が低いとき、
   山に囲まれた湖の底は先に陰るので弱く暗くする（サンプラー無し）。
   hfShadow を持つマテリアルでは本物の高さ場影に差し替わる */
float ngHfShadowAnalytic(vec3 P) {
#ifdef NG_HF_SHADOW
  return ngHfShadowFar(P);
#else
  return mix(0.7, 1.0, smoothstep(0.02, 0.16, ngKeyDir.y));
#endif
}
#endif
`;
