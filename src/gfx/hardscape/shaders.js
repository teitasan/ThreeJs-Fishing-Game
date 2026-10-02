/* ===========================================================
   hardscape のマテリアルの差し込み（ngExtendStandard の口）
   -----------------------------------------------------------
   プログラムは 3 本：木（桟橋・杭・船・縄・和紙・鉄・流木・立ち枯れを ngWood.x の種類で 1 本に）、
   岩（instanced、triplanar の花崗岩 / 安山岩・苔・水線・シルト）、蛾
   =========================================================== */
import { NG_SURFACE_GLSL } from '../core/glsl/surface.glsl.js';

/* ---------------- 木 ---------------- */
export const WOOD_VERT_PARS = /* glsl */ `
attribute vec4 ngWood;
varying vec4 vNgWood;
varying vec3 vNgHsN;
`;
export const WOOD_VERT_BEGIN = /* glsl */ `
vNgWood = ngWood;
vNgHsN = normalize(mat3(modelMatrix) * objectNormal);
`;
export const WOOD_FRAG_PARS = NG_SURFACE_GLSL + /* glsl */ `
varying vec4 vNgWood;
varying vec3 vNgHsN;
uniform vec4 ngHsDock;    // 付け根の x, z, right.x, right.z
uniform vec4 ngHsDock2;   // dir.x, dir.z, dockY, 長さ L
uniform vec4 ngHsLamp;    // 和紙の発光の放射輝度 rgb（2200K × 揺らぎ × 点灯）
vec3 ngHsEmit = vec3(0.0);
float ngHsCav = 1.0;
`;
export const WOOD_FRAG_SURFACE = /* glsl */ `
diffuseColor.a = 1.0;   // 地図の a は粗さ（反射の RT の a = 1 を保つ）
`;
export const WOOD_FRAG_NORMAL = /* glsl */ `
{
  float k = floor(vNgWood.x + 0.5);
  float tone = vNgWood.y;
  vec3 P = vNgWorld;
  vec3 Gn = normalize(vNgHsN);
  vec3 Nw = inverseTransformDirection(normal, viewMatrix);
  vec3 alb = diffuseColor.rgb;
  float rough = sampledDiffuseColor.a;
  float por = 0.75;
  float wetX = 0.0;
  float cav = texture2D(normalMap, vNormalMapUv).a;
  vec2 dd = P.xz - ngHsDock.xy;
  float si = dot(dd, ngHsDock.zw), al = dot(dd, ngHsDock2.xy);
  float Y = ngHsDock2.z, L = ngHsDock2.w;
  float inFoot = step(-0.05, al) * step(al, L + 0.05) * step(abs(si), 1.76);
  if (k < 0.5) {
    /* 床板：板ごとの色むら（まれに新しい赤身の板・汚れた板）・釘と錆 */
    alb *= mix(0.93, 1.07, tone);
    float fresh = smoothstep(0.9, 0.97, tone);
    alb = mix(alb, alb * vec3(1.22, 0.96, 0.74), fresh * 0.75);
    alb *= 1.0 - 0.2 * smoothstep(0.1, 0.0, tone);
    float bw = vNgWood.w;
    float sw = clamp((fract(vMapUv.x * 4.0) - 0.04) / 0.92, 0.0, 1.0) * bw;
    float dsi = min(abs(si + 1.3), min(abs(si), abs(si - 1.3)));
    float ds = min(abs(sw - 0.032), abs(sw - (bw - 0.032)));
    float rn = length(vec2(dsi, ds));
    float up = step(0.5, Gn.y);
    float head = (1.0 - smoothstep(0.0042, 0.0058, rn)) * up;
    float rust = exp(-rn * rn / 1.1e-4) * (0.55 + 0.45 * ngVNoise2(P.xz * 140.0));
    float streak = exp(-ds * ds / 3.0e-5) * exp(-dsi / 0.035) * (0.4 + 0.6 * ngVNoise2(vec2(si * 60.0, ds * 200.0)));
    alb = mix(alb, vec3(0.15, 0.07, 0.03), clamp(rust * 0.7 + streak * 0.4, 0.0, 0.8) * up);
    alb = mix(alb, vec3(0.045, 0.04, 0.035), head);
    rough = mix(rough, 0.45, head);
    /* 隙間の側面：下ほど暗い（隣の板と桁に挟まれる） */
    float side = 1.0 - smoothstep(0.5, 0.85, abs(Gn.y));
    cav *= mix(1.0, mix(0.22, 1.0, smoothstep(Y - 0.032, Y - 0.004, P.y)), side);
  } else if (k < 1.5) {
    alb *= vec3(0.9, 0.87, 0.83) * (0.82 + 0.3 * tone);
  } else if (k < 2.5) {
    alb *= vec3(0.8, 0.77, 0.72) * (0.85 + 0.25 * tone);
  } else if (k < 3.5) {
    /* 船：外板の継ぎ目（周の 13.5cm ごと）・暗い褐色 */
    float gir = clamp((fract(vMapUv.x * 4.0) - 0.04) / 0.92, 0.0, 1.0) * 0.5;
    float seam = 1.0 - smoothstep(0.0015, 0.005, abs(fract(gir / 0.135 + 0.5) - 0.5) * 0.135);
    alb *= vec3(0.66, 0.58, 0.5) * (0.85 + 0.3 * tone);
    alb *= 1.0 - 0.55 * seam;
    cav *= 1.0 - 0.4 * seam;
  } else if (k < 4.5) {
    /* 白く晒された木（流木・立ち枯れ） */
    float l = dot(alb, vec3(0.2126, 0.7152, 0.0722));
    alb = mix(alb, vec3(l) * vec3(1.62, 1.6, 1.52), 0.8) * (0.92 + 0.16 * tone);
    por = 0.6;
  } else if (k < 5.5) {
    /* 縄：3 本撚り */
    float tw = 0.5 + 0.5 * sin(vMapUv.x * 4.0 * 6.2831853 * 3.0 * 4.17 + vMapUv.y * 4.0 * 260.0);
    alb = vec3(0.3, 0.235, 0.14) * (0.7 + 0.45 * tw);
    rough = 0.9;
    cav *= 0.75 + 0.25 * tw;
  } else if (k < 6.5) {
    /* 和紙と組子（灯籠）。発光は 2200K × 揺らぎ（ngHsLamp） */
    vec2 pu = vNgWood.zw;
    float bx = abs(fract(pu.x * 3.0 + 0.5) - 0.5) / 3.0, by = abs(fract(pu.y * 4.0 + 0.5) - 0.5) / 4.0;
    float edge = min(min(pu.x, 1.0 - pu.x), min(pu.y, 1.0 - pu.y));
    float bar = 1.0 - smoothstep(0.006, 0.011, min(min(bx, by), edge));
    alb = mix(vec3(0.72, 0.68, 0.57), vec3(0.09, 0.07, 0.05), bar);
    rough = 0.92;
    float fib = 0.9 + 0.1 * ngVNoise2(pu * vec2(90.0, 140.0));
    float hot = 1.0 - 0.35 * abs(pu.y - 0.45) * 2.0 - 0.15 * abs(pu.x - 0.5) * 2.0;
    ngHsEmit = ngHsLamp.rgb * hot * fib * (1.0 - 0.94 * bar);
  } else {
    /* 鉄（ボルト・金物）：錆 */
    float n = ngVNoise2(P.xz * 60.0 + P.y * 40.0);
    alb = mix(vec3(0.045, 0.04, 0.036), vec3(0.17, 0.08, 0.035), 0.4 + 0.5 * n);
    rough = 0.6 + 0.3 * n;
    por = 0.2;
  }
  /* 桟橋の下：床が空を塞ぐ（環境光だけ減らす。直射は影マップ） */
  float under = inFoot * (1.0 - step(Y - 0.03, P.y)) * (1.0 - step(2.5, k));
  cav *= mix(1.0, 0.4, under);
  /* 受け梁のボルトから垂れる錆の筋（梁の面と杭） */
  if (k > 0.5 && k < 2.5) {
    float am = mod(L - 0.25 - al + 1.2, 2.4) - 1.2;
    float boltY = Y - 0.035 - 0.16 - 0.075;
    float dS = abs(abs(si) - 1.45);
    float face = 1.0 - smoothstep(0.03, 0.12, abs(abs(am) - 0.068));
    float below = step(P.y, boltY + 0.02);
    float st = exp(-dS * dS / 2.0e-4) * below * exp((P.y - boltY) / 0.45) * face * (0.5 + 0.5 * ngVNoise2(vec2(dS * 300.0, P.y * 18.0)));
    alb = mix(alb, vec3(0.16, 0.075, 0.03), clamp(st, 0.0, 0.7) * inFoot);
  }
  /* 水線：上はしぶきの濡れ、下は藻の膜、深いほどシルト（船の内側は除く） */
  if (k > 0.5 && k < 5.5 && !(k > 2.5 && k < 3.5 && vNgWood.z > 0.5)) {
    float wl = 0.02 + 0.035 * sin(P.x * 1.3 + P.z * 0.7 + ngWaterTime * 1.1) + 0.02 * sin(P.x * 3.1 - P.z * 2.3 + ngWaterTime * 1.9);
    float sub = 1.0 - smoothstep(wl - 0.025, wl + 0.025, P.y);
    float splash = (1.0 - smoothstep(wl, wl + 0.3, P.y)) * (1.0 - sub);
    float n = ngFbm(vec2(P.x + P.z, P.y) * 3.0, 3);
    float algae = sub * clamp(0.65 + 0.5 * (n - 0.5), 0.0, 1.0) * (1.0 - 0.5 * smoothstep(-3.0, -9.0, P.y));
    vec3 aCol = mix(vec3(0.035, 0.05, 0.02), vec3(0.075, 0.085, 0.035), n);
    float silt = sub * smoothstep(-0.8, -2.5, P.y) * (0.35 + 0.5 * smoothstep(0.0, 0.7, Gn.y));
    alb = mix(alb, aCol, algae);
    alb = mix(alb, vec3(0.11, 0.095, 0.07), silt * 0.8);
    rough = mix(rough, 0.4, algae * (1.0 - silt));
    float rim = (1.0 - smoothstep(0.0, 0.08, abs(P.y - wl - 0.04))) * (1.0 - sub);
    alb = mix(alb, vec3(0.07, 0.06, 0.035), rim * 0.6);
    wetX = max(sub, splash * 0.85);
  }
  /* 雨の濡れ（粗さ ≈ 0.15）と水たまり（床板の上面のカップの中）・雨の輪 */
  float skyV = mix(0.45, 1.0, smoothstep(-0.2, 0.7, Gn.y)) * (1.0 - under);
  float wet = max(ngWet * skyV, wetX);
  float pud = 0.0;
  if (k < 0.5 && Gn.y > 0.85) {
    float sw2 = clamp((fract(vMapUv.x * 4.0) - 0.04) / 0.92, 0.0, 1.0);
    float cup = 1.0 - abs(sw2 * 2.0 - 1.0);
    pud = ngPuddle(P.xz * 2.6, 0.0) * smoothstep(0.25, 0.7, cup) * ngWet;
  }
  ngWetSurface(alb, rough, por, wet * 0.92);
  alb *= 1.0 - 0.25 * pud;
  rough = mix(rough, 0.03, pud);
  if (ngRain > 0.01 && Gn.y > 0.6) {
    vec2 rg = ngRainRings(P.xz, ngEnvTime, ngRain);
    vec3 nr = normalize(vec3(-rg.x, 1.0, -rg.y));
    Nw = normalize(mix(Nw, nr, pud) + vec3(-rg.x, 0.0, -rg.y) * wet * 0.3 * (1.0 - pud));
  }
  normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
  diffuseColor.rgb = alb;
  roughnessFactor = rough;
  ngHsCav = cav;
}
`;
export const WOOD_FRAG_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += ngHsEmit;
`;
export const CAV_FRAG_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= ngHsCav;
reflectedLight.indirectSpecular *= mix(1.0, ngHsCav, 0.7);
`;

/* ---------------- 岩 ---------------- */
export const ROCK_VERT_PARS = /* glsl */ `
attribute vec2 ngRockV;
attribute vec4 ngRockI;
varying vec2 vNgRockV;
varying vec4 vNgRockI;
varying vec3 vNgHsN;
`;
export const ROCK_VERT_BEGIN = /* glsl */ `
vNgRockV = ngRockV;
vNgRockI = ngRockI;
#ifdef USE_INSTANCING
  mat3 ngIm = mat3(instanceMatrix);
  vec3 ngS2 = max(vec3(dot(ngIm[0], ngIm[0]), dot(ngIm[1], ngIm[1]), dot(ngIm[2], ngIm[2])), vec3(1e-8));
  vNgHsN = normalize(mat3(modelMatrix) * (ngIm * (objectNormal / ngS2)));
#else
  vNgHsN = normalize(mat3(modelMatrix) * objectNormal);
#endif
`;
export const ROCK_FRAG_PARS = NG_SURFACE_GLSL + /* glsl */ `
uniform sampler2D ngRockA;
uniform sampler2D ngRockN;
varying vec2 vNgRockV;
varying vec4 vNgRockI;
varying vec3 vNgHsN;
float ngHsCav = 1.0;
vec3 ngHsTN(vec4 n, float type) {
  vec2 t = mix(n.zw, n.xy, type) * 2.0 - 1.0;
  return vec3(t, sqrt(max(1.0 - dot(t, t), 0.0)));
}
`;
export const ROCK_FRAG_SURFACE = /* glsl */ `
diffuseColor.a = 1.0;
`;
export const ROCK_FRAG_NORMAL = /* glsl */ `
{
  vec3 P = vNgWorld;
  vec3 G = normalize(vNgHsN);
  float type = vNgRockI.x, moss = vNgRockI.y, sd = vNgRockI.z;
  vec3 bw = pow(abs(G), vec3(4.0));
  bw /= bw.x + bw.y + bw.z + 1e-5;
  vec2 o = vec2(sd * 17.0, sd * 31.0);
  const float sc = 0.85;
  vec2 uX = P.zy * sc + o, uY = P.xz * sc + o, uZ = P.xy * sc + o;
  vec4 A = texture2D(ngRockA, uX) * bw.x + texture2D(ngRockA, uY) * bw.y + texture2D(ngRockA, uZ) * bw.z;
  vec3 tX = ngHsTN(texture2D(ngRockN, uX), type), tY = ngHsTN(texture2D(ngRockN, uY), type), tZ = ngHsTN(texture2D(ngRockN, uZ), type);
  tX = vec3(tX.xy + G.zy, abs(tX.z) * G.x);
  tY = vec3(tY.xy + G.xz, abs(tY.z) * G.y);
  tZ = vec3(tZ.xy + G.xy, abs(tZ.z) * G.z);
  vec3 Nw = normalize(tX.zyx * bw.x + tY.xzy * bw.y + tZ.xyz * bw.z);
  float lum = mix(A.g, A.r, type);
  vec3 alb = lum * mix(vec3(0.96, 0.99, 1.05), vec3(1.06, 1.0, 0.92), type);
  alb *= 0.86 + 0.28 * A.b;
  alb *= 0.9 + 0.2 * ngVNoise2(P.xz * 0.35 + o);
  float rough = 0.8 + 0.12 * (1.0 - A.b);
  float cav = vNgRockV.x;
  /* 地衣（乾いた面の淡い斑） */
  float dry = smoothstep(0.32, 0.9, P.y);
  alb = mix(alb, vec3(0.33, 0.35, 0.29), A.a * 0.55 * dry * (1.0 - 0.3 * type));
  /* 苔：上向きの面（樹冠の陰と水辺で厚く = moss）。窪みの縁から乗る */
  float mn = ngFbm(P.xz * 1.7 + o, 4);
  float mU = smoothstep(0.38, 0.82, G.y + 0.45 * (mn - 0.5) + 0.25 * (1.0 - cav));
  float mossA = mU * moss * dry * smoothstep(0.25, 0.6, mn + 0.3 * moss);
  vec3 mCol = mix(vec3(0.045, 0.075, 0.022), vec3(0.085, 0.115, 0.035), ngVNoise2(P.xz * 9.0));
  alb = mix(alb, mCol, mossA);
  rough = mix(rough, 0.95, mossA);
  Nw = normalize(mix(Nw, G, mossA * 0.6));
  /* 水線 ±0.3m：上は濡れ、下は藻。水中の上向きの面はシルト */
  float wl = 0.02 + 0.035 * sin(P.x * 1.3 + P.z * 0.7 + ngWaterTime * 1.1);
  float sub = 1.0 - smoothstep(wl - 0.03, wl + 0.03, P.y);
  float band = (1.0 - smoothstep(0.0, 0.3, P.y - wl)) * (1.0 - sub);
  float an = ngFbm(P.xz * 2.3 + P.y * 1.7, 3);
  float algae = sub * (1.0 - 0.6 * smoothstep(-0.3, -2.5, P.y)) * clamp(0.55 + 0.6 * (an - 0.5), 0.0, 1.0);
  alb = mix(alb, mix(vec3(0.04, 0.055, 0.022), vec3(0.08, 0.085, 0.04), an), algae);
  float silt = sub * smoothstep(-0.3, -1.5, P.y) * smoothstep(0.1, 0.75, G.y + 0.2 * (an - 0.5));
  alb = mix(alb, vec3(0.13, 0.115, 0.085), silt * 0.85);
  Nw = normalize(mix(Nw, G, silt * 0.7));
  rough = mix(rough, 0.5, algae * (1.0 - silt));
  float wet = max(max(sub, band * 0.9), ngWet * mix(0.5, 1.0, smoothstep(-0.2, 0.7, G.y)));
  ngWetSurface(alb, rough, 0.35, wet);
  if (ngRain > 0.01 && G.y > 0.6) {
    vec2 rg = ngRainRings(P.xz, ngEnvTime, ngRain);
    Nw = normalize(Nw + vec3(-rg.x, 0.0, -rg.y) * 0.4 * ngWet);
  }
  normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
  diffuseColor.rgb = alb;
  roughnessFactor = rough;
  ngHsCav = cav;
}
`;
