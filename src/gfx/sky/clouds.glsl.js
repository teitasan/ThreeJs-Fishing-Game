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

/** 形のノイズ 64³：r = Perlin-Worley（0..1 に広げた Perlin fbm を Worley fbm で膨らませる）、
    gba = Worley fbm（8・16・32 セル、0..1 に正規化）。どれもタイルの周期で繋がる */
export const SHAPE_FRAG = PERIODIC_GLSL + /* glsl */ `
float ngSkyWn(vec3 p, float f) { return clamp((ngSkyWorleyFbm(p, f) - 0.28) / 0.55, 0.0, 1.0); }
void main() {
  vec3 p = vec3(vUv, ngSlice);
  float pf = 0.0, amp = 0.5, fr = 4.0;
  for (int i = 0; i < 5; i++) { pf += amp * ngSkyPerlinP(p * fr, fr); amp *= 0.5; fr *= 2.0; }
  float pn = clamp(pf * 1.4 + 0.5, 0.0, 1.0);
  float wn = ngSkyWn(p, 4.0);
  float pw = clamp(ngSkyRemap(pn, wn - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  pw = clamp((pw - 0.45) / 0.50, 0.0, 1.0);                  // 0.42–0.99 に偏るのを 0..1 へ広げる
  gl_FragColor = vec4(pw, ngSkyWn(p, 8.0), ngSkyWn(p, 16.0), ngSkyWn(p, 32.0));
}
`;

/** 形の «柱の平均» 256²（遠い雲の LOD。形 64³ を 16 の高さで平均し、平均で薄まった濃淡を少し戻す） */
export const SHAPE2_FRAG = /* glsl */ `
uniform highp sampler3D uNgShape;
void main() {
  float a = 0.0, m = 0.0;
  for (int i = 0; i < 16; i++) {
    /* 主の読みは texture(uNgShape, (x, 高さ, z))。柱 = 2 番目の座標（高さ）に沿った平均で、2D の uv は (x, z) */
    vec4 s = texture(uNgShape, vec3(vUv.x, (float(i) + 0.5) / 16.0, vUv.y));
    float wf = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
    float sh = clamp((s.r - wf * 0.35) / max(1.0 - wf * 0.35, 1e-4), 0.0, 1.0);
    a += sh / 16.0; m = max(m, sh);
  }
  gl_FragColor = vec4(mix(a, m, 0.5), 0.0, 0.0, 1.0);
}
`;

/** 細部のノイズ 32³：rgb = Worley fbm（2・4・8 セル、0..1 に正規化） */
export const DETAIL_FRAG = PERIODIC_GLSL + /* glsl */ `
float ngSkyWn(vec3 p, float f) { return clamp((ngSkyWorleyFbm(p, f) - 0.28) / 0.55, 0.0, 1.0); }
void main() {
  vec3 p = vec3(vUv, ngSlice);
  gl_FragColor = vec4(ngSkyWn(p, 2.0), ngSkyWn(p, 4.0), ngSkyWn(p, 8.0), 1.0);
}
`;

/** 巻雲 512²（周期）：r = 細い繊維の筋（毛状雲・鉤状雲）、g = 薄い膜（巻層雲）、b = 塊のむら */
export const CIRRUS_FRAG = NG_NOISE_GLSL + /* glsl */ `
float ngCiRidge(vec2 p, vec2 per) { return 1.0 - abs(2.0 * ngFbmP(p, per, 4) - 1.0); }
void main() {
  vec2 p = vUv;
  /* 大きなうねり（周期 1）で筋を曲げる。縦横比は 3〜4（毛の束、鉤） */
  vec2 w = vec2(ngFbmP(p * 2.0 + 1.7, vec2(2.0), 3), ngFbmP(p * 2.0 + 9.2, vec2(2.0), 3)) - 0.5;
  vec2 q = p + w * 0.22;
  float f1 = pow(ngCiRidge(vec2(q.x * 4.0, q.y * 14.0), vec2(4.0, 14.0)), 3.0);
  float f2 = pow(ngCiRidge(vec2(q.x * 6.0 + 0.3, q.y * 20.0 + w.x * 3.0), vec2(6.0, 20.0)), 4.0);
  float pch = smoothstep(0.50, 0.78, ngFbmP(p * 3.0 + w * 0.8, vec2(3.0), 4));
  float fib = (0.75 * f1 + 0.30 * f2) * pch;
  float veil = smoothstep(0.55, 0.90, ngFbmP(p * 2.0 + w, vec2(2.0), 5));
  gl_FragColor = vec4(clamp(fib, 0.0, 1.0), veil, pch, 1.0);
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

/** 雲の被覆のノイズ n(q)（core の ngCloudCoverAt の smoothstep の前）を q ∈ [−Q, Q]² で焼く（2048²、R8）。
    雲パノラマの内側のループで値ノイズ 3 回（ハッシュ 12 回）を 1 回のテクスチャ読みにする */
export const COVER_Q = 36;
export const COVER_FRAG = NG_FRAME_GLSL + NG_CLOUD_GLSL + /* glsl */ `
void main() {
  vec2 q = (vUv - 0.5) * ${COVER_Q.toFixed(1)} * 2.0;
  float n = 0.5 * ngCloudNoise(q) + 0.3 * ngCloudNoise(q * 2.03 + 11.7) + 0.2 * ngCloudNoise(q * 4.11 + 3.9);
  gl_FragColor = vec4(n, 0.0, 0.0, 1.0);
}
`;

/* ---------- 雲パノラマ（1/16 の帯ずつ。帯の RT に描いて写す） ---------- */
export const PANO_FRAG = NG_FRAME_GLSL + NG_CLOUD_GLSL + NG_SURFACE_GLSL + NG_SKY_TRANS_GLSL + /* glsl */ `
uniform highp sampler3D uNgShape;
uniform highp sampler3D uNgDetail;
uniform sampler2D uNgShape2;  // 形の «柱の平均»（256²、mip。遠い雲の LOD）
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
uniform sampler2D uNgCoverN;
uniform vec4 uCoverXf;     // q / km, 流れの q (x, z), Q
const float NG_O_H = 0.02;
/* core の ngCloudCoverAt と同じ被覆（焼いたノイズ + 今の被覆の smoothstep）。xz は km。Q の外は平均の被覆 */
float ngSkyCover(vec2 xzKm) {
  vec2 q = xzKm * uCoverXf.x + uCoverXf.yz;
  vec2 uv = q / (2.0 * uCoverXf.w) + 0.5;
  float c = clamp(ngCloudCover, 0.0, 1.0);
  float n = texture(uNgCoverN, uv).r;
  float cov = smoothstep(1.0 - c - 0.12, 1.0 - c + 0.22, n);
  return mix(cov, c, smoothstep(0.80, 0.98, max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0));
}
float ngSkyRemapF(float v, float a, float b) { return (v - a) / max(b - a, 1e-5); }
float ngCloudHeightGrad(float h01, float strat) {
  float cu = smoothstep(0.0, 0.10, h01) * (1.0 - smoothstep(0.35, 1.0, h01));
  float st = smoothstep(0.0, 0.18, h01) * (1.0 - smoothstep(0.55, 1.0, h01));
  return mix(cu, st, strat);
}
/* 雲の密度（消散 1/km）。p は km（x, z = 湖の中心からの水平、y = 地表からの高さ）。full = 細部まで。
   距離の LOD（パノラマのテクセル ≈0.18°：10km で 30m、100km で 300m の足跡。遠くで 3D のノイズを点々に読むと
   キャッシュが外れて重い）：〜12km は形 + 細部、12〜20km で細部を消し、16〜24km で形を «柱の平均» の 2D（mip 付き）へ */
/* 乱層雲の «厚みの場»（0..1、低い周波数の 2D。7km と 3km の 2 オクターブの «柱の平均»）。
   下面の高さの揺らぎ（±350m）と腹の暗さ・透ける光の濃淡に使う（平らな灰の板にしない） */
float ngSkyNimboField(vec2 xzKm) {
  vec2 q = (xzKm + uWind.xy * 0.8) * uCloud2.y;
  float a = textureLod(uNgShape2, q * 0.31 + vec2(0.37, 0.71), 1.5).r;
  float b = textureLod(uNgShape2, q * vec2(0.83, 0.61) + vec2(0.13, 0.29), 1.0).r;
  return smoothstep(0.36, 0.64, a * 0.6 + b * 0.4);
}
float ngSkyCloudBase(vec3 p, float distKm, out float h01, out float hh) {
  float base = uCloud.y, top = uCloud.z;
  hh = 0.0;
  float nsw = smoothstep(0.7, 1.0, uCloud.w) * smoothstep(0.3, 0.8, uLight.w);
  if (nsw > 0.0) base -= nsw * (ngSkyNimboField(p.xz) - 0.5) * 0.7;
  h01 = (p.y - base) / max(top - base, 0.05);
  if (h01 < 0.0 || h01 > 1.0) return 0.0;
  /* 乱層雲・厚い層積雲は穴を開けない（被覆の斑は雲影と同じだが、層状の度合いで底上げ） */
  float cov = max(ngSkyCover(p.xz), uCloud.x * smoothstep(0.6, 1.0, uCloud.w));
  if (cov <= 0.002) return 0.0;
  float hTop = mix(0.45 + 0.55 * cov, 1.0, uCloud.w);       // 積雲は被覆の高い所ほど頂が高い
  hh = h01 / max(hTop, 0.05);
  if (hh > 1.0) return 0.0;
  vec3 q = vec3(p.x + uWind.x, p.y, p.z + uWind.y) * uCloud2.y;
  float far = smoothstep(16.0, 24.0, distKm);
  float shape = 0.0;
  if (far < 1.0) {
    vec4 s = textureLod(uNgShape, q, 0.0);
    /* 形 = Perlin-Worley を高い周波数の Worley fbm で少し削る（房の中の房） */
    float wf = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
    shape = clamp(ngSkyRemapF(s.r, wf * 0.35, 1.0), 0.0, 1.0);
  }
  if (far > 0.0) {
    float lod = log2(max(distKm * 0.0031 * uCloud2.y * 256.0, 1.0));
    float s2 = textureLod(uNgShape2, q.xz, lod).r;
    shape = mix(shape, s2, far);
  }
  /* 乱層雲は形の谷でも切れない（層状の度合いで底上げ） */
  shape = mix(shape, 0.55 + 0.45 * shape, smoothstep(0.7, 1.0, uCloud.w));
  shape *= ngCloudHeightGrad(hh, uCloud.w);
  float c = clamp(cov, 0.0, 1.0);
  return clamp(ngSkyRemapF(shape, 1.0 - c, 1.0), 0.0, 1.0) * c;
}
/* 細部で縁を削る（base > 0 のときだけ呼ぶ）。戻りは消散 1/km */
float ngSkyCloudErode(float d, vec3 p, float distKm, float hh) {
  float wd = 1.0 - smoothstep(12.0, 20.0, distKm);
  if (wd > 0.0) {
    vec3 qd = vec3(p.x + uWind.z, p.y, p.z + uWind.w) * uCloud2.z;
    vec3 dn = textureLod(uNgDetail, qd, 0.0).rgb;
    float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    df = mix(df, 1.0 - df, clamp(hh * 4.0, 0.0, 1.0));      // 下は房、上は渦
    d = clamp(ngSkyRemapF(d, df * uCloud2.w * mix(1.0, 0.3, uCloud.w) * wd, 1.0), 0.0, 1.0);
  }
  /* 薄い膜を残さない（積雲の縁は締まる。層状では弱く） */
  float fl = 0.06 * (1.0 - uCloud.w);
  return max(d - fl, 0.0) / (1.0 - fl) * uCloud2.x;
}
float ngCloudDensity(vec3 p, float distKm, bool full, out float h01) {
  float hh;
  float d = ngSkyCloudBase(p, distKm, h01, hh);
  if (d <= 0.0) return 0.0;
  return full ? ngSkyCloudErode(d, p, distKm, hh) : d * uCloud2.x;
}
/* 多重散乱の近似（Wrenninge の 3 オクターブ）+ 二重 HG（0.6 / −0.2）+ 銀の縁（0.88）。
   位相は光線ごとに一定なので ngCloudPhases で 1 回だけ（ALU の大半だった） */
vec3 ngCloudPhases(float muL) {
  return vec3(mix(ngSkyPhaseHG(muL, -0.2), ngSkyPhaseHG(muL, 0.6), 0.72) + 0.10 * ngSkyPhaseHG(muL, 0.88),
              0.5 * ngSkyPhaseHG(muL, 0.3), 0.25 * ngSkyPhaseHG(muL, 0.15));
}
float ngCloudMS(vec3 ph, float tauL) {
  float ms = ph.x * exp(-tauL) + ph.y * exp(-0.4 * tauL) + ph.z * exp(-0.16 * tauL);
  /* 厚い雲の拡散（二流近似の透過 1/(1 + 0.75·τ·(1−g))、g = 0.85）：白く、方向に依らない。
     日の当たる面の近くで «白い雲»（反射率 ≈ 0.75）になる大きさ */
  return ms + 0.17 / (1.0 + 0.1125 * tauL);
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
  vec3 ph = ngCloudPhases(muL);
  vec3 Pm = vec3(0.0, r0, 0.0) + d * (t0 + 0.5 * len);
  float rpm = length(Pm);
  vec3 E = uLightE * ngSkySunT(rpm, dot(Pm, Ld) / rpm);
  float pw = 0.35 * (1.0 - muL);
  float T = 1.0, tW = 0.0, wS = 0.0;
  vec3 Lc = vec3(0.0);
  float nsw = smoothstep(0.7, 1.0, uCloud.w) * smoothstep(0.3, 0.8, uLight.w);
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
    Lc = (E * ngCloudMS(ph, tauL) * mix(1.0, 1.0 - exp(-2.5 * (tauL + 0.15)), pw) + amb) * (1.0 - T);
    if (nsw > 0.0) Lc *= mix(1.0, mix(1.45, 0.55, ngSkyNimboField(P.xz)), nsw);
    tW = tm; wS = 1.0;
  } else {
    /* 段数は «層の中の道のり / 目標の歩幅»（近い所 45m → 遠い所 0.5km）を 16..uMode.x に。
       空の所は 2 倍の歩幅で進み、雲に当たったら半歩戻って細かく（Schneider 2015）。
       光の向きは uMode.y − 1 回の形の密度 + 1 回の被覆だけの遠い見積もり（2.4km 先まで） */
    float NMAX = uMode.x;
    float nimbo = 0.5;
    if (nsw > 0.0) {
      vec3 Pb = vec3(0.0, r0, 0.0) + d * t0;
      nimbo = ngSkyNimboField(Pb.xz);
    }
    /* 層状の雲（曇天・乱層雲）は光が拡散で決まるので光の段を減らし、歩幅も広げる */
    int NL = int(uMode.y - 1.0 - 2.0 * uCloud.w + 0.5);
    float stepT = mix(mix(0.045, 0.5, smoothstep(4.0, 40.0, t0)), mix(0.11, 0.6, smoothstep(4.0, 40.0, t0)), uCloud.w);
    float N = clamp(ceil(len / stepT), 16.0, NMAX);
    float dt = len / N;
    float tEnd = t0 + len;
    float t = t0 + jit * dt;
    bool coarse = true;
    /* 回数の上限 NI の中で必ず層を抜ける：残りの道のり / 残りの回数を歩幅の下限に（上限で切ると仰角ごとに輪ができた） */
    int NI = int(NMAX) + 8;
    for (int i = 0; i < 104; i++) {
      if (t >= tEnd || i >= NI) break;
      float dtMin = (tEnd - t) / float(NI - i);
      vec3 P = vec3(0.0, r0, 0.0) + d * t;
      float rp = length(P);
      vec3 pc = vec3(P.x, rp - NG_SKY_RG, P.z);
      float h01, hh;
      float den = ngSkyCloudBase(pc, t, h01, hh);
      if (den <= 0.0) { t += max(coarse ? 2.0 * dt : dt, dtMin); coarse = true; continue; }
      coarse = false;
      float dtk = max(dt, dtMin);
      den = ngSkyCloudErode(den, pc, t, hh);
      if (den > 0.0) {
        float tauL = 0.0, sj = 0.0, ds = 0.08;
        for (int j = 0; j < 6; j++) {
          if (j >= NL) break;
          float h2;
          tauL += ngCloudDensity(pc + Ld * (sj + 0.5 * ds), t, false, h2) * ds;
          sj += ds; ds *= 2.6;
        }
        /* 遠い所（被覆だけ。層の中ほどの平均の形 0.3） */
        vec3 pf = pc + Ld * (sj + 0.6);
        float hf = (pf.y - uCloud.y) / max(uCloud.z - uCloud.y, 0.05);
        if (hf > 0.0 && hf < 1.0) tauL += ngSkyCover(pf.xz) * uCloud2.x * 0.3 * 1.2;
        float powder = mix(1.0, 1.0 - exp(-2.5 * (tauL + 0.15)), pw);
        /* 環境光：上は空、下は地面の照り返し。中ほどほど・下ほど暗い（腹） */
        float ha = clamp(h01, 0.0, 1.0);
        vec3 amb = mix(uAmbBot, uAmbTop, sqrt(ha)) * (0.35 + 0.65 * ha) * mix(1.0, 0.5, uLight.w * (1.0 - ha));
        vec3 S = E * (ngCloudMS(ph, tauL) * powder) + amb;
        if (nsw > 0.0) {
          /* 厚い所（下面が低い所）ほど暗い腹、薄い所は上の光が透けて明るい（±35%） */
          S *= mix(1.0, mix(1.45, 0.55, nimbo), nsw * (1.0 - 0.6 * ha));
        }
        float Tk = exp(-den * dtk);
        float w = T * (1.0 - Tk);
        Lc += S * w;
        tW += w * t; wS += w;
        T *= Tk;
        if (T < 0.015) break;
        dt *= 1.04;          // 雲の奥ほど歩幅を広げる（奥の寄与は小さい）
      }
      t += dtk;
    }
    if (T < 0.015) { Lc /= max(1.0 - T, 0.5); T = 0.0; }
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
  /* 繊維は被覆が少なくても残り、膜は被覆が多いときだけ */
  float dens = c.r * smoothstep(0.0, 0.5, uCirrus.x) + 0.35 * c.g * smoothstep(0.4, 1.0, uCirrus.x) * c.b;
  float tau = dens * uCirrus.w / pow(max(d.y, 0.06), 0.35);
  float T = exp(-tau);
  vec3 Ld = uLight.xyz;
  float muL = dot(d, Ld), rp = length(P);
  vec3 E = uLightE * ngSkySunT(rp, dot(P, Ld) / rp);
  vec3 Lci = (E * (0.55 * ngSkyPhaseHG(muL, 0.78) + 0.45 * 0.0795775) + uAmbTop * 0.25) * (1.0 - T);
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
  /* NaN / Inf を履歴に残さない（mix(NaN, cur, 1) は NaN のまま、一度入ると二度と抜けない） */
  bvec4 bc = bvec4(isnan(cur.r) || isinf(cur.r), isnan(cur.g) || isinf(cur.g), isnan(cur.b) || isinf(cur.b), isnan(cur.a) || isinf(cur.a));
  if (any(bc)) cur = vec4(0.0, 0.0, 0.0, 1.0);
  bvec4 bp = bvec4(isnan(prev.r) || isinf(prev.r), isnan(prev.g) || isinf(prev.g), isnan(prev.b) || isinf(prev.b), isnan(prev.a) || isinf(prev.a));
  if (any(bp)) prev = cur;
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

