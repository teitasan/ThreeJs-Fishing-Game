/* ===========================================================
   空のドーム（全画面三角形、不透明の最後・depth = 1・LEQUAL）
   -----------------------------------------------------------
   L = 晴れの空（skyClear）·雲の透過 + 雲の内散乱（パノラマ）+ 太陽（周縁減光）+ 月（焼いた海）
       + 星（≈6000、等級分布・色温度・大気の減光・瞬き・雲で消える・反射では 1.5 倍）+ 天の川
   地平の数度は core の朝霧の項を掛ける（遠景の霧と同じ式。朝霧の地形が空へ溶ける）
   ngShaderMaterial の断片（NG_FRAME_GLSL・NG_MEDIUM_GLSL が前に付く）
   =========================================================== */
import { NG_SURFACE_GLSL } from '../core/glsl/surface.glsl.js';
import { NG_SKY_TRANS_GLSL } from './atmo.glsl.js';

export const DOME_VS = /* glsl */ `
varying vec3 vNgSkyDir;
void main() {
  vec2 ndc = position.xy;
  vec3 dv = vec3((ndc.x + projectionMatrix[2][0]) / projectionMatrix[0][0], (ndc.y + projectionMatrix[2][1]) / projectionMatrix[1][1], -1.0);
  vNgSkyDir = transpose(mat3(viewMatrix)) * dv;
  gl_Position = vec4(ndc, 1.0, 1.0);
}
`;

export const DOME_FS = NG_SURFACE_GLSL + NG_SKY_TRANS_GLSL + /* glsl */ `
uniform sampler2D uSkyClear;
uniform sampler2D uCloudPano;
uniform sampler2D uMoonTex;
uniform highp sampler3D uNgDetail;
uniform vec4 uCloudSharp;   // 縁の細部の強さ, 雲の中ほどの高さ km, 細部の周波数 1/km, 予備
uniform vec4 uWind;         // 形の流れ km (xz), 細部の流れ km (xz)
uniform vec3 uSunDisk;      // 太陽円盤の平均放射輝度（大気の上端、ng）
uniform vec3 uMoonDisk;     // 月の円盤の平均放射輝度（大気の上端、ng。見た目の値）
uniform vec4 uNightSky;     // 星の明るさ（ng の照度 / 0 等星）, 天の川の明るさ, 星の回転角, 瞬きの時刻
uniform vec4 uSkyMisc;      // 星を描く 0/1, 反射の星の倍率, 月の暗さ, 予備
varying vec3 vNgSkyDir;

vec3 ngSkyCube(vec3 w, out float face, out vec2 st) {
  vec3 a = abs(w);
  if (a.x >= a.y && a.x >= a.z) { face = w.x > 0.0 ? 0.0 : 1.0; st = w.zy / a.x; }
  else if (a.y >= a.z) { face = w.y > 0.0 ? 2.0 : 3.0; st = w.xz / a.y; }
  else { face = w.z > 0.0 ? 4.0 : 5.0; st = w.xy / a.z; }
  return a;
}
vec3 ngSkyCubeDir(float face, vec2 st) {
  if (face < 0.5) return vec3(1.0, st.y, st.x);
  if (face < 1.5) return vec3(-1.0, st.y, st.x);
  if (face < 2.5) return vec3(st.x, 1.0, st.y);
  if (face < 3.5) return vec3(st.x, -1.0, st.y);
  if (face < 4.5) return vec3(st.x, st.y, 1.0);
  return vec3(st.x, st.y, -1.0);
}
/* 色温度（K）→ リニア Rec.709 の色（輝度 1 に正規化。3000–12000K の近似） */
vec3 ngSkyStarColor(float t) {
  vec3 c = mix(vec3(1.0, 0.62, 0.36), vec3(1.0, 0.93, 0.85), smoothstep(3000.0, 5800.0, t));
  c = mix(c, vec3(0.78, 0.86, 1.0), smoothstep(5800.0, 12000.0, t));
  return c / dot(c, vec3(0.2126, 0.7152, 0.0722));
}
/* 星：立方体の 6 面 × 256² のセル、1 セルに高々 1 つ。ガウスの点像（画素の角の大きさで正規化 → 動いてもちらつかない） */
vec3 ngSkyStars(vec3 w, float pixAng, float sizeK) {
  const float N = 256.0;
  float face; vec2 st;
  ngSkyCube(w, face, st);
  vec2 g = (st * 0.5 + 0.5) * N;
  vec2 cell = floor(g);
  vec2 key = cell + vec2(face * 397.0, face * 211.0);
  float h = ngHash12(key);
  if (h > 0.030) return vec3(0.0);
  vec2 o = ngHash22(key + 17.3) * 0.5 + 0.25;
  vec3 sd = normalize(ngSkyCubeDir(face, ((cell + o) / N) * 2.0 - 1.0));
  float d = length(w - sd);
  float sig = max(pixAng * 0.62 * sizeK, 1.2e-4);
  if (d > 4.0 * sig) return vec3(0.0);
  float u = max(ngHash12(key * 1.371 + 5.17), 1e-5);
  float mag = 6.5 + 2.0 * log(u) / log(10.0);
  float flux = exp2(-1.3287712 * mag);                  // 10^(−0.4 m)
  float tK = mix(3200.0, 11000.0, pow(ngHash12(key + 91.7), 1.6));
  float tw = ngVNoise2(vec2(h * 977.0, uNightSky.w * 7.0)) - 0.5;
  float scint = 1.0 + 1.1 * tw * (1.0 - smoothstep(0.0, 0.45, abs(w.y)));
  return ngSkyStarColor(tK) * (uNightSky.x * flux * scint / (6.2831853 * sig * sig)) * exp(-0.5 * d * d / (sig * sig));
}
/* 天の川：傾いた大円の帯、銀河中心で明るく、暗黒帯で裂ける */
vec3 ngSkyMilkyWay(vec3 w) {
  vec3 n = normalize(vec3(0.42, 0.18, 0.89));
  vec3 cg = normalize(vec3(-0.70, 0.62, 0.20));
  cg = normalize(cg - n * dot(cg, n));
  float b = dot(w, n);
  float core = 0.30 + 0.70 * pow(0.5 + 0.5 * dot(normalize(w - n * b), cg), 3.0);
  float width = 0.10 + 0.10 * core;
  float band = exp(-b * b / (2.0 * width * width));
  if (band < 0.01) return vec3(0.0);
  vec3 p = w * 9.0;
  float f = ngVNoise3(p) * 0.5 + ngVNoise3(p * 2.1 + 3.7) * 0.3 + ngVNoise3(p * 4.6 + 1.3) * 0.2;
  float lane = 1.0 - 0.75 * smoothstep(0.035, 0.0, abs(b + 0.02 * (ngVNoise3(w * 5.0) - 0.5) - 0.012)) * core;
  float clumps = smoothstep(0.35, 0.85, f);
  vec3 col = mix(vec3(0.80, 0.86, 1.0), vec3(1.0, 0.90, 0.74), core);
  return col * band * (0.35 + 0.95 * clumps) * lane * core;
}
void main() {
  vec3 v = normalize(vNgSkyDir);
  float pixAng = length(fwidth(v));
  vec2 uv = ngSkyViewUV(v);
  vec3 L = texture(uSkyClear, uv).rgb;
  float Tc = 1.0;
  if (v.y > 0.0) {
    vec4 c = texture(uCloudPano, vec2(uv.x, clamp(uv.y * 2.0 - 1.0, 0.0, 1.0)));
    /* 画面の解像度の縁：パノラマ（≈0.18°/テクセル）の半透明の縁だけを、雲の中ほどの面の細部ノイズで削る・足す */
    /* 縁だけ（透過の画面の勾配が大きい所）。薄い膜の内側に細胞の模様を付けない */
    float edge = c.a * (1.0 - c.a) * clamp(length(vec2(dFdx(c.a), dFdy(c.a))) * 12.0, 0.0, 1.0);
    if (edge > 0.003 && uCloudSharp.x > 0.0) {
      float r0 = NG_SKY_RG + 0.02;
      float tm = ngSkyShell(r0, v.y, NG_SKY_RG + uCloudSharp.y);
      vec3 P = vec3(0.0, r0, 0.0) + v * tm;
      float foot = max(length(fwidth(v)), 1e-5) * tm * uCloudSharp.z;      // 画素の大きさ / 細部の周期
      float fade = 1.0 - smoothstep(0.08, 0.35, foot);
      if (fade > 0.0) {
        vec3 q = vec3(P.x + uWind.z, uCloudSharp.y, P.z + uWind.w) * uCloudSharp.z;
        float n = textureLod(uNgDetail, q, 0.0).r * 0.6 + textureLod(uNgDetail, q * 2.7 + 0.31, 0.0).g * 0.4;
        float a2 = clamp(c.a + (n - 0.55) * uCloudSharp.x * edge * 4.0 * fade, 0.0, 1.0);
        c.rgb *= (1.0 - a2) / max(1.0 - c.a, 1e-3);
        c.a = a2;
      }
    }
    L = L * c.a + c.rgb;
    Tc = c.a;
  }
  float aa = max(pixAng, 1e-5);
  /* 太陽：角半径 0.2666°。周縁減光 μ^(0.40, 0.50, 0.65)（円盤の平均が uSunDisk になるよう正規化） */
  float cs = dot(v, ngSunDir);
  if (cs > 0.9999) {
    float ang = acos(clamp(cs, -1.0, 1.0));
    float rr = clamp(ang / 0.004654, 0.0, 1.0);
    float mu = sqrt(max(1.0 - rr * rr, 0.0));
    vec3 a = vec3(0.40, 0.50, 0.65);
    vec3 ld = (a + 2.0) * 0.5 * pow(vec3(max(mu, 1e-3)), a);
    float edge = 1.0 - smoothstep(0.004654 - aa, 0.004654 + aa, ang);
    vec3 T = ngSkySunT(NG_SKY_VIEWR, v.y);
    L += uSunDisk * ld * T * Tc * edge;
  }
  /* 月：角半径 0.26°、満月（Lommel–Seeliger でほぼ平ら）、海は起動時に焼いた 512² */
  vec3 m = -ngSunDir;
  float cm = dot(v, m);
  if (cm > 0.9999 && uMoonDisk.g > 0.0) {
    vec3 t1 = normalize(cross(m, abs(m.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(t1, m);
    vec2 q = vec2(dot(v, t1), dot(v, t2)) / 0.004538;
    float rr = length(q);
    float edge = 1.0 - smoothstep(1.0 - aa / 0.004538, 1.0 + aa / 0.004538, rr);
    if (edge > 0.0) {
      vec2 qq = q / max(rr, 1.0);
      vec3 n = vec3(qq.x, qq.y, sqrt(max(1.0 - dot(qq, qq), 0.0)));
      vec2 muv = vec2(atan(n.x, n.z) * 0.15915494 + 0.5, asin(clamp(n.y, -1.0, 1.0)) * 0.31830989 + 0.5);
      float alb = texture(uMoonTex, muv).r * 0.25 / 0.125;
      float limb = 0.82 + 0.18 * n.z;
      vec3 T = ngSkySunT(NG_SKY_VIEWR, v.y);
      L += uMoonDisk * alb * limb * T * Tc * edge;
    }
  }
  /* 星と天の川（夜・晴れ。地平で大気が減光、雲で消える） */
  if (uSkyMisc.x > 0.5 && v.y > -0.02 && ngNight > 0.01) {
    float ca = cos(uNightSky.z), sa = sin(uNightSky.z);
    vec3 w = vec3(ca * v.x + sa * v.y, -sa * v.x + ca * v.y, v.z);       // 天の回転（太陽と同じ z 軸）
    float sizeK = ngPassId > 0.5 ? uSkyMisc.y : 1.0;
    vec3 Tv = ngSkyT(NG_SKY_VIEWR, max(v.y, 0.0));
    vec3 S = ngSkyStars(w, pixAng, sizeK);
    if (uNightSky.y > 0.0) S += uNightSky.y * ngSkyMilkyWay(w);
    L += S * Tv * Tc * ngNight * smoothstep(-0.02, 0.06, v.y);
  }
  /* 朝霧：地平の数度だけ、core の媒質と同じ朝霧の項（遠景の霧と継ぎ目なく） */
  if (ngMistDensity > 0.0 && v.y < 0.12) {
    vec3 C = cameraPosition;
    vec3 P = C + v * 3000.0;
    vec3 a = vec3(C.x, max(C.y - ngMistBaseY, 0.0), C.z), b = vec3(P.x, max(P.y - ngMistBaseY, 0.0), P.z);
    float od = ngMistDensity * ngMistMask(0.5 * (C.xz + P.xz)) * ngAirOpticalDepth(a, b, 1.0, max(ngMistH, 0.1));
    float Tm = exp(-od);
    float pM = ngPhaseHG(dot(v, ngKeyDir), ngMieG);
    vec3 Sm = ngKeyRad * pM + ngInscatterAmb + vec3(ngMistAmb);
    L = L * Tm + Sm * (1.0 - Tm);
  }
  gl_FragColor = vec4(clamp(L, vec3(0.0), vec3(30000.0)), 1.0);
}
`;
