/* ===========================================================
   雲の GLSL：起動時の焼き込み（Perlin-Worley 64³・Worley 32³・巻雲 512²・月 512²）と
   カメラに依らない雲パノラマ（上半球の緯度経度、仰角 √ 写像 = ngSkyViewUV の上半分）
   -----------------------------------------------------------
   パノラマの 1 テクセル = 原点 (0, 20m, 0) から見た方向 d の雲：
     rgb = T_air·L_cloud + F·(1 − T_c)·L_sky（空気遠近込みの足し算）、a = T_c（空に掛ける）
   → 見る側は L = L_sky·a + rgb（ドーム・skyView・水の反射の外れが同じ式）
   雲の被覆は core の ngCloudCoverAt（雲影と同じ関数）。形は時刻の純関数（24h 周期の円で流れる）
   =========================================================== */
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { NG_FRAME_GLSL } from '../core/frame.js';
import { NG_CLOUD_GLSL } from '../core/glsl/medium.glsl.js';
import { NG_SURFACE_GLSL } from '../core/glsl/surface.glsl.js';
import { NG_SKY_TRANS_GLSL } from './atmo.glsl.js';

/* ---------- 周期ノイズ（焼き込み専用） ---------- */
const PERIODIC_GLSL = NG_NOISE_GLSL + /* glsl */ `
float ngSkyWorleyP(vec3 p, float period) {
  vec3 id = floor(p), fr = fract(p);
  float d = 1e9;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 c = mod(id + o, period);
    vec3 q = o + ngHash33(c + 0.37) - fr;
    d = min(d, dot(q, q));
  }
  return clamp(sqrt(d), 0.0, 1.0);
}
vec3 ngSkyGrad(vec3 c, float period) { return normalize(ngHash33(mod(c, period) + 7.13) * 2.0 - 1.0 + 1e-4); }
float ngSkyPerlinP(vec3 p, float period) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(ngSkyGrad(i, period), f);
  float n100 = dot(ngSkyGrad(i + vec3(1, 0, 0), period), f - vec3(1, 0, 0));
  float n010 = dot(ngSkyGrad(i + vec3(0, 1, 0), period), f - vec3(0, 1, 0));
  float n110 = dot(ngSkyGrad(i + vec3(1, 1, 0), period), f - vec3(1, 1, 0));
  float n001 = dot(ngSkyGrad(i + vec3(0, 0, 1), period), f - vec3(0, 0, 1));
  float n101 = dot(ngSkyGrad(i + vec3(1, 0, 1), period), f - vec3(1, 0, 1));
  float n011 = dot(ngSkyGrad(i + vec3(0, 1, 1), period), f - vec3(0, 1, 1));
  float n111 = dot(ngSkyGrad(i + vec3(1, 1, 1), period), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float ngSkyWorleyFbm(vec3 p, float freq) {
  return (1.0 - ngSkyWorleyP(p * freq, freq)) * 0.625 + (1.0 - ngSkyWorleyP(p * freq * 2.0, freq * 2.0)) * 0.25
       + (1.0 - ngSkyWorleyP(p * freq * 4.0, freq * 4.0)) * 0.125;
}
float ngSkyRemap(float v, float a, float b, float c, float d) { return c + (v - a) / max(b - a, 1e-5) * (d - c); }
`;

/** 形のノイズ 64³：r = Perlin-Worley、gba = Worley fbm（4・8・16 セル） */
export const SHAPE_FRAG = PERIODIC_GLSL + /* glsl */ `
void main() {
  vec3 p = vec3(vUv, ngSlice);
  float pf = 0.0, amp = 0.5, fr = 4.0;
  for (int i = 0; i < 4; i++) { pf += amp * ngSkyPerlinP(p * fr, fr); amp *= 0.5; fr *= 2.0; }
  pf = clamp(pf * 0.9 + 0.5, 0.0, 1.0);
  float w4 = ngSkyWorleyFbm(p, 4.0);
  float pw = clamp(ngSkyRemap(pf, w4 - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  gl_FragColor = vec4(pw, w4, ngSkyWorleyFbm(p, 8.0), ngSkyWorleyFbm(p, 16.0));
}
`;

/** 細部のノイズ 32³：rgb = Worley fbm（2・4・8 セル） */
export const DETAIL_FRAG = PERIODIC_GLSL + /* glsl */ `
void main() {
  vec3 p = vec3(vUv, ngSlice);
  gl_FragColor = vec4(ngSkyWorleyFbm(p, 2.0), ngSkyWorleyFbm(p, 4.0), ngSkyWorleyFbm(p, 8.0), 1.0);
}
`;

/** 巻雲 512²（周期）：r = 鉤状の筋（Cirrus uncinus）、g = 薄い膜（Cirrostratus）、b = 細い繊維 */
export const CIRRUS_FRAG = NG_NOISE_GLSL + /* glsl */ `
void main() {
  vec2 p = vUv;
  vec2 w = vec2(ngFbmP(p * 3.0 + 1.7, vec2(3.0), 4), ngFbmP(p * 3.0 + 9.2, vec2(3.0), 4)) - 0.5;
  vec2 q = p + w * 0.22;
  /* 風下へ引き伸ばした筋（x 方向に 2 周・y に 12 周） */
  float s = ngFbmP(vec2(q.x * 2.0, q.y * 12.0), vec2(2.0, 12.0), 5);
  float hook = ngFbmP(vec2(q.x * 6.0 + w.y * 2.0, q.y * 24.0), vec2(6.0, 24.0), 3);
  float streak = smoothstep(0.48, 0.80, s) * (0.55 + 0.45 * hook);
  float veil = smoothstep(0.35, 0.75, ngFbmP(p * 4.0 + w, vec2(4.0), 4));
  float fib = ngFbmP(vec2(q.x * 4.0, q.y * 48.0), vec2(4.0, 48.0), 3);
  gl_FragColor = vec4(streak, veil, fib, 1.0);
}
`;

/** 月の面 512²（経緯度）：r = アルベド / 0.25（海・高地・クレーターの光条） */
export const MOON_FRAG = NG_NOISE_GLSL + /* glsl */ `
float ngSkyMoonFbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * ngVNoise3(p); p = p * 2.03 + 3.1; a *= 0.5; } return s; }
void main() {
  float lon = (vUv.x - 0.5) * 6.28318531, lat = (vUv.y - 0.5) * 3.14159265;
  vec3 n = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  /* 海（大きな暗い斑。表側の北西に寄せる） */
  float m = ngSkyMoonFbm(n * 2.2 + vec3(4.0, 1.0, 2.0));
  float bias = 0.12 * dot(n, normalize(vec3(-0.5, 0.45, 0.75)));
  float mare = smoothstep(0.50, 0.58, m + bias);
  float alb = mix(0.17, 0.075, mare);
  /* 高地の細かいむら・クレーター（縁が明るく底が暗い）・若いクレーターの光条 */
  alb *= 0.88 + 0.24 * ngSkyMoonFbm(n * 14.0);
  for (int k = 0; k < 3; k++) {
    float sc = 9.0 * pow(2.3, float(k));
    float w = ngWorley3(n * sc);
    float rim = smoothstep(0.30, 0.42, w) * (1.0 - smoothstep(0.42, 0.55, w));
    float floor_ = 1.0 - smoothstep(0.0, 0.30, w);
    alb *= 1.0 + 0.18 * rim - 0.10 * floor_ * (1.0 - mare);
  }
  float tycho = max(0.0, dot(n, normalize(vec3(-0.15, -0.68, 0.72))));
  alb += 0.05 * pow(tycho, 40.0) + 0.03 * pow(tycho, 6.0) * smoothstep(0.55, 0.75, ngVNoise3(n * 40.0));
  gl_FragColor = vec4(clamp(alb / 0.25, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

/* ---------- 雲パノラマ（1/16 の帯ずつ。帯の RT に描いて写す） ---------- */
export const PANO_FRAG = NG_FRAME_GLSL + NG_CLOUD_GLSL + NG_SURFACE_GLSL + NG_SKY_TRANS_GLSL + /* glsl */ `
uniform highp sampler3D uNgShape;
uniform highp sampler3D uNgDetail;
uniform sampler2D uNgCirrus;
uniform sampler2D uSkyClear;
uniform sampler2D uPrev;
uniform vec4 uPano;        // W, H, 帯の最初の行, 帯の行数
uniform vec4 uCloud;       // 被覆, 雲底 km, 雲頂 km, 層状の度合い 0 = 積雲 .. 1 = 乱層雲
uniform vec4 uCloud2;      // 消散 1/km, 形の周波数 1/km, 細部の周波数 1/km, 削りの強さ
uniform vec4 uWind;        // 形の流れ km (x, z), 細部の流れ km (x, z)
uniform vec4 uLight;       // 光の向き xyz、w = 暗い腹（乱層雲の下面の暗さ 0..1）
uniform vec3 uLightE;      // 光の上端の照度（ng）
uniform vec3 uAmbTop;      // 雲の上の空の放射輝度（ng）
uniform vec3 uAmbBot;      // 地面の照り返し（ng）
uniform vec4 uMode;        // 段数, 光の段数, 履歴の混ぜ（1 = 置き換え）, 2D の層（low）
uniform vec4 uCirrus;      // 被覆, 高さ km, タイル km, 濃さ
uniform vec4 uCirrusW;     // 巻雲の流れ km (x, z), 予備, ジッタの種
const float NG_O_H = 0.02;
float ngSkyRemapF(float v, float a, float b) { return (v - a) / max(b - a, 1e-5); }
float ngCloudHeightGrad(float h01, float strat) {
  float cu = smoothstep(0.0, 0.10, h01) * (1.0 - smoothstep(0.35, 1.0, h01));
  float st = smoothstep(0.0, 0.18, h01) * (1.0 - smoothstep(0.55, 1.0, h01));
  return mix(cu, st, strat);
}
/* 雲の密度（消散 1/km）。p は km（x, z = 湖の中心からの水平、y = 地表からの高さ）。full = 細部まで */
float ngCloudDensity(vec3 p, float distKm, bool full, out float h01) {
  float base = uCloud.y, top = uCloud.z;
  h01 = (p.y - base) / max(top - base, 0.05);
  if (h01 < 0.0 || h01 > 1.0) return 0.0;
  float cov = ngCloudCoverAt(p.xz * 1000.0);
  cov = mix(cov, clamp(uCloud.x, 0.0, 1.0), smoothstep(25.0, 90.0, distKm));
  float hTop = mix(0.45 + 0.55 * cov, 1.0, uCloud.w);       // 積雲は被覆の高い所ほど頂が高い
  float hh = h01 / max(hTop, 0.05);
  if (hh > 1.0) return 0.0;
  vec3 q = vec3(p.x + uWind.x, p.y, p.z + uWind.y) * uCloud2.y;
  vec4 s = textureLod(uNgShape, q, 0.0);
  float wf = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  float shape = clamp(ngSkyRemapF(s.r, wf - 1.0, 1.0), 0.0, 1.0);
  shape *= ngCloudHeightGrad(hh, uCloud.w);
  float c = clamp(cov, 0.0, 1.0);
  float d = clamp(ngSkyRemapF(shape, 1.0 - c, 1.0), 0.0, 1.0) * c;
  if (d <= 0.0) return 0.0;
  if (full) {
    vec3 qd = vec3(p.x + uWind.z, p.y, p.z + uWind.w) * uCloud2.z;
    vec3 dn = textureLod(uNgDetail, qd, 0.0).rgb;
    float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    df = mix(df, 1.0 - df, clamp(hh * 4.0, 0.0, 1.0));      // 下は房、上は渦
    d = clamp(ngSkyRemapF(d, df * uCloud2.w * mix(1.0, 0.55, uCloud.w), 1.0), 0.0, 1.0);
  }
  return d * uCloud2.x;
}
/* 多重散乱の近似（Wrenninge の 3 オクターブ）+ 二重 HG（0.6 / −0.2）+ 銀の縁（0.88） */
float ngCloudMS(float muL, float tauL) {
  float p0 = mix(ngSkyPhaseHG(muL, -0.2), ngSkyPhaseHG(muL, 0.6), 0.72) + 0.10 * ngSkyPhaseHG(muL, 0.88);
  return p0 * exp(-tauL) + 0.5 * ngSkyPhaseHG(muL, 0.3) * exp(-0.4 * tauL) + 0.25 * ngSkyPhaseHG(muL, 0.15) * exp(-0.16 * tauL);
}
/* 原点から d 方向、距離 t までの空気の透過と、内散乱のうちその手前の割合 F */
void ngCloudAerial(vec3 d, float t, out vec3 Tair, out float F) {
  float r0 = NG_SKY_RG + NG_O_H;
  vec3 P = vec3(d.x * t, r0 + d.y * t, d.z * t);
  float rp = length(P);
  vec3 T0 = ngSkyT(r0, d.y);
  Tair = clamp(T0 / max(ngSkyT(rp, dot(P, d) / rp), vec3(1e-4)), 0.0, 1.0);
  F = clamp((1.0 - Tair.g) / max(1.0 - T0.g, 1e-4), 0.0, 1.0);
}
void ngCloudLow(vec3 d, float jit, vec3 Lsky, out vec3 rgb, out float a) {
  rgb = vec3(0.0); a = 1.0;
  float r0 = NG_SKY_RG + NG_O_H;
  float t0 = ngSkyShell(r0, d.y, NG_SKY_RG + uCloud.y), t1 = ngSkyShell(r0, d.y, NG_SKY_RG + uCloud.z);
  if (t0 < 0.0 || t1 <= t0 || t0 > 170.0) return;
  float len = min(t1 - t0, 40.0);
  vec3 Ld = uLight.xyz;
  float muL = dot(d, Ld);
  vec3 Pm = vec3(0.0, r0, 0.0) + d * (t0 + 0.5 * len);
  float rpm = length(Pm);
  vec3 E = uLightE * ngSkySunT(rpm, dot(Pm, Ld) / rpm);
  float pw = 0.35 * (1.0 - muL);
  float T = 1.0, tW = 0.0, wS = 0.0;
  vec3 Lc = vec3(0.0);
  if (uMode.w > 0.5) {
    /* low：雲の層の中ほどで 1 回だけ読む 2D の層 */
    float tm = t0 + 0.5 * len;
    vec3 P = vec3(0.0, r0, 0.0) + d * tm;
    float h01;
    float den = ngCloudDensity(vec3(P.x, (uCloud.y + uCloud.z) * 0.5, P.z), tm, true, h01);
    float tau = den * min(len, 3.0) * 0.45;
    float tauL = den * (uCloud.z - uCloud.y) * 0.35 / max(Ld.y, 0.12);
    T = exp(-tau);
    vec3 amb = mix(uAmbBot, uAmbTop, 0.6) * mix(1.0, 0.45, uLight.w);
    Lc = (E * ngCloudMS(muL, tauL) * mix(1.0, 1.0 - exp(-2.5 * (tauL + 0.15)), pw) + amb) * (1.0 - T);
    tW = tm; wS = 1.0;
  } else {
    int N = int(uMode.x), NL = int(uMode.y);
    float dt = len / float(N);
    for (int i = 0; i < 96; i++) {
      if (i >= N) break;
      float t = t0 + (float(i) + jit) * dt;
      vec3 P = vec3(0.0, r0, 0.0) + d * t;
      float rp = length(P);
      vec3 pc = vec3(P.x, rp - NG_SKY_RG, P.z);
      float h01;
      float den = ngCloudDensity(pc, t, false, h01);
      if (den <= 0.0) continue;
      den = ngCloudDensity(pc, t, true, h01);
      if (den <= 0.0) continue;
      float tauL = 0.0, sj = 0.0, ds = 0.06;
      for (int j = 0; j < 8; j++) {
        if (j >= NL) break;
        float h2;
        tauL += ngCloudDensity(pc + Ld * (sj + 0.5 * ds), t, false, h2) * ds;
        sj += ds; ds *= 1.85;
      }
      float powder = mix(1.0, 1.0 - exp(-2.5 * (tauL + 0.15)), pw);
      vec3 amb = mix(uAmbBot, uAmbTop, sqrt(clamp(h01, 0.0, 1.0))) * (0.45 + 0.55 * h01) * mix(1.0, 0.5, uLight.w * (1.0 - h01));
      vec3 S = E * (ngCloudMS(muL, tauL) * powder) + amb;
      float Tk = exp(-den * dt);
      float w = T * (1.0 - Tk);
      Lc += S * w;
      tW += w * t; wS += w;
      T *= Tk;
      if (T < 0.004) break;
    }
  }
  if (wS <= 0.0) return;
  vec3 Tair; float F;
  ngCloudAerial(d, tW / wS, Tair, F);
  a = T;
  rgb = Tair * Lc + F * (1.0 - T) * Lsky;
}
void ngCirrusLayer(vec3 d, vec3 Lsky, out vec3 rgb, out float a) {
  rgb = vec3(0.0); a = 1.0;
  if (uCirrus.x <= 0.001) return;
  float r0 = NG_SKY_RG + NG_O_H;
  float tc = ngSkyShell(r0, d.y, NG_SKY_RG + uCirrus.y);
  if (tc < 0.0 || tc > 400.0) return;
  vec3 P = vec3(0.0, r0, 0.0) + d * tc;
  vec2 uv = (P.xz + uCirrusW.xy) / uCirrus.z;
  vec4 c = texture(uNgCirrus, uv);
  float m = c.r * 0.85 + c.g * 0.30 * uCirrus.x + 0.12 * c.b;
  float dens = smoothstep(1.0 - uCirrus.x * 0.9, 1.05, m) * (0.6 + 0.4 * c.b);
  float tau = dens * uCirrus.w / pow(max(d.y, 0.06), 0.35);
  float T = exp(-tau);
  vec3 Ld = uLight.xyz;
  float muL = dot(d, Ld), rp = length(P);
  vec3 E = uLightE * ngSkySunT(rp, dot(P, Ld) / rp);
  vec3 Lci = (E * (0.55 * ngSkyPhaseHG(muL, 0.78) + 0.45 * 0.0795775) + uAmbTop * 0.9) * (1.0 - T);
  vec3 Tair; float F;
  ngCloudAerial(d, tc, Tair, F);
  a = T;
  rgb = Tair * Lci + F * (1.0 - T) * Lsky;
}
void main() {
  float row = uPano.z + floor(gl_FragCoord.y);
  float col = floor(gl_FragCoord.x);
  vec2 uv = vec2((col + 0.5) / uPano.x, (row + 0.5) / uPano.y);
  float el = uv.y * uv.y * 1.57079633;
  float az = (uv.x - 0.5) * 6.28318531;
  vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 Lsky = texture(uSkyClear, ngSkyViewUV(d)).rgb;
  float jit = fract(ngHash12(vec2(col, row) * 0.7317) + uCirrusW.w * 0.6180340);
  vec3 cl; float al; vec3 ci; float ai;
  ngCloudLow(d, jit, Lsky, cl, al);
  ngCirrusLayer(d, Lsky, ci, ai);
  vec4 cur = vec4(cl + al * ci, al * ai);
  vec4 prev = texture(uPrev, uv);
  vec4 o = mix(prev, cur, uMode.z);
  gl_FragColor = vec4(clamp(o.rgb, vec3(0.0), vec3(60000.0)), clamp(o.a, 0.0, 1.0));
}
`;

/** 帯の RT → パノラマ（scissor で帯の行だけ） */
export const STRIP_COPY_FRAG = /* glsl */ `
uniform sampler2D uStrip;
uniform vec4 uPano;
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y) - int(uPano.z));
  gl_FragColor = texelFetch(uStrip, clamp(p, ivec2(0), ivec2(int(uPano.x) - 1, int(uPano.w) - 1)), 0);
}
`;

