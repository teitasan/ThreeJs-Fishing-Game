/* ===========================================================
   地形の素材の GLSL（ngExtendStandard の口へ入れる）
   -----------------------------------------------------------
   頂点：CDLOD のパッチ（33² / 17² の格子 1 枚をインスタンスで）。インスタンス = (x0, z0, 格子の間隔, 段)。
     ジオモーフは Strugar の «奇数の格子点を偶数へ寄せる»。高さは ngTerrainH（R32F の手動バイリニア = heightAt）
   断片：
     1. 8 層の重み（傾斜・汀線距離・底質 = lake.bedAt・樹冠・湿り気の斑・踏み跡・藻場）。coverRules と同じ関数
     2. 上位 2 層を選び、高さで噛み合わせる（high は 2 層とも hex-tiling、mid は 1 層、low は 2 スケール）。
        急斜面の岩は triplanar。法線は «勾配の足し算»（地形の高さ場 + 層の細部）
     3. 3 スケールのマクロの色むら（23m・97m・431m）。180m より先と反射は farAlbedo
     4. 汀の濡れ帯（ngShoreRunUp の遡上で動く水膜と、乾きかけの帯）・雨の濡れ・水たまり（雨の輪の法線）
     5. lights の口で空の鏡面（skyView を粗さで）、ao の口で樹冠の下の空の遮り
   ここの関数は影の変種の断片にも入るので、main の変数（diffuseColor 等）には触らない
   =========================================================== */
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { NG_SKYSPEC_GLSL } from '../core/glsl/surface.glsl.js';
import { NG_WAVE_GLSL } from '../core/glsl/wave.glsl.js';
import { NG_HASH_GLSL, NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { NG_HEXTILE_GLSL } from '../core/glsl/hextile.glsl.js';
import { TERRAIN_TILE_M, TERRAIN_POROSITY } from './layers.glsl.js';

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const arr = (a) => `float[8](${a.map(f).join(', ')})`;

/* ---------------- 頂点 ---------------- */
export const TERRAIN_VERT_PARS = NG_HEIGHTFIELD_GLSL + /* glsl */ `
attribute vec4 aNgInst;          // x0, z0, 格子の間隔 m, 段
uniform vec4 ngTerrMorph[8];     // 段ごと：ジオモーフの始め a、終わり b、1/(b−a)
uniform vec4 ngTerrEye;          // LOD の中心（描くカメラ）xyz、w = パッチのセル数
uniform float ngTerrClipR;       // 遠景の尾根へ渡す半径 m
varying vec3 ngTerrVInfo;        // x = 段 + ジオモーフ、yz = パッチの格子（線の表示）
vec2 ngTerrVertXZ(vec3 pos, out float lodK) {
  float cells = ngTerrEye.w;
  float cL = 16.0 * exp2(aNgInst.w) / cells;
  float g = max(1.0, floor(cL / aNgInst.z + 0.5));
  vec2 gi = floor(pos.xz / g + 1e-4) * g;
  vec2 w0 = aNgInst.xy + gi * aNgInst.z;
  vec4 m = ngTerrMorph[int(aNgInst.w + 0.5)];
  float k = clamp((distance(w0, ngTerrEye.xz) - m.x) * m.z, 0.0, 1.0);
  vec2 q = gi / g;
  q -= fract(q * 0.5) * 2.0 * k;
  vec2 xz = aNgInst.xy + q * cL;
  float rr = length(xz);
  if (rr > ngTerrClipR) xz *= ngTerrClipR / rr;
  lodK = aNgInst.w + k * 0.999;
  return xz;
}
`;
export const TERRAIN_VERT_NORMAL = /* glsl */ `
{ float ngK0; objectNormal = ngTerrainN( ngTerrVertXZ( position, ngK0 ) ); }
`;
export const TERRAIN_VERT_BEGIN = /* glsl */ `
{
  float ngK1;
  vec2 ngXZb = ngTerrVertXZ( position, ngK1 );
  transformed = vec3( ngXZb.x, ngTerrainH( ngXZb ), ngXZb.y );
  ngTerrVInfo = vec3( ngK1, position.xz );
}
`;

/* ---------------- 重み（coverRules と共有。ngFrame もテクスチャも読まない） ---------------- */
/**
 * 8 層の重みの GLSL。trail / weed は呼び手が渡す（素材は uniform、coverRules は定数から）
 * @returns {string}
 */
export function terrainWeightsGLSL() {
  return NG_NOISE_GLSL + /* glsl */ `
#ifndef NG_LIB_TERR_WEIGHTS
#define NG_LIB_TERR_WEIGHTS
/* 汀線距離と底質は near の地図（±260m）の外で折り返して読まれうるので、外は «遠い陸» と縁の底質へ寄せる */
float ngTerrShoreD(vec2 xz) { return mix(300.0, ngShoreD(xz), smoothstep(0.0, 10.0, ngNearInset(xz))); }
vec4 ngTerrBed(vec2 xz) { return ngBed(clamp(xz, ngHfNear.xy + 2.0, ngHfNear.xy + (ngHfNear.w - 1.0) / ngHfNear.z - 2.0)); }
/* 桟橋の付け根から内陸へ 30m の踏み跡（dock.xy = 付け根、dock.zw = 内陸の向き）と、付け根の踏み荒らし */
float ngTerrTrailAt(vec2 xz, vec4 dock) {
  vec2 d = xz - dock.xy;
  float t = dot(d, dock.zw), s = dot(d, vec2(-dock.w, dock.z));
  float mean = (1.6 * sin(t * 0.115 + 0.6) + 0.7 * sin(t * 0.29 + 2.1)) * smoothstep(0.0, 6.0, t);
  float wid = 0.72 + 0.22 * sin(t * 0.21) + 0.15 * (ngVNoise2(xz * 0.9) - 0.5);
  float along = smoothstep(-2.5, 0.5, t) * (1.0 - smoothstep(24.0, 34.0, t));
  float tr = (1.0 - smoothstep(wid * 0.5, wid * 1.3, abs(s - mean))) * along;
  return max(tr, (1.0 - smoothstep(1.8, 3.8, length(d) + 0.8 * (ngVNoise2(xz * 1.3) - 0.5))) * 0.9);
}
/* w：0 林床・1 苔・2 草地・3 玉石・4 砂・5 泥・6 岩・7 踏み跡。和は 1 */
void ngTerrWeights(vec3 P, vec3 Ng, float sd, vec4 bed, vec2 cn, float trail, out float w[8]) {
  vec2 xz = P.xz;
  float slope = sqrt(max(1.0 - Ng.y * Ng.y, 0.0)) / max(Ng.y, 0.05);
  float nM = ngVNoise2(xz * 0.031 + 11.0);
  float nP = ngVNoise2(xz * 0.093 + 3.0);
  float nF = ngVNoise2(xz * 0.41 + 7.0);
  float under = 1.0 - smoothstep(-0.5, 0.12, sd + (nF - 0.5) * 0.4);
  vec3 bw = bed.rgb / max(bed.r + bed.g + bed.b, 1e-3);           // mud, sand, rock（lake.bedAt）
  float beach = 1.0 - smoothstep(1.2 + 2.5 * nP, 3.0 + 5.0 * nP, sd + (nF - 0.5) * 1.4);
  float forest = max(smoothstep(0.08, 0.42, cn.x + (nP - 0.5) * 0.25), upland);
  float moist = smoothstep(0.42, 0.72, nM + 0.22 * (1.0 - smoothstep(4.0, 25.0, sd)));
  /* 日本の山は 40° 近くまで森に覆われる：露岩は急な崖（> 45°）と、樹冠の無い所の急斜面だけ */
  /* 湖畔の開けた帯（汀線から ~60m）より上の斜面は、木がまばらでも林床（日本の山は森に覆われる。草地は湖畔だけ） */
  float upland = smoothstep(35.0, 95.0, sd + 40.0 * (nM - 0.5));
  float forest0 = max(smoothstep(0.08, 0.42, cn.x), upland);
  float rock = smoothstep(0.95, 1.45, slope + (nP - 0.5) * 0.5 + (nF - 0.5) * 0.2) * (1.0 - 0.6 * forest0);
  rock = max(rock, smoothstep(0.7, 1.1, slope + (nP - 0.5) * 0.4) * (1.0 - forest0) * smoothstep(8.0, 20.0, sd) * 0.8);
  rock = max(rock, smoothstep(150.0, 190.0, P.y + 30.0 * (nM - 0.5)) * smoothstep(0.35, 0.6, slope + (nF - 0.5) * 0.2));
  float tr = trail * (1.0 - rock) * smoothstep(0.2, 1.0, sd);
  float rest = (1.0 - rock) * (1.0 - tr);
  float lb = beach * rest, lv = (1.0 - beach) * rest;
  float cob = smoothstep(0.55, 0.78, nP);
  float shallow = smoothstep(-3.5, -0.4, P.y);
  float u = under;
  w[0] = (1.0 - u) * lv * forest * (1.0 - 0.8 * moist);
  w[1] = (1.0 - u) * lv * forest * (0.8 * moist + 0.35 * smoothstep(0.3, 0.6, slope));
  w[2] = (1.0 - u) * lv * (1.0 - forest);
  w[3] = (1.0 - u) * lb * (bw.b + 0.5 * bw.g * cob) + u * bw.b * shallow;
  w[4] = (1.0 - u) * lb * bw.g * (1.0 - 0.5 * cob) + u * bw.g;
  w[5] = (1.0 - u) * lb * bw.r + u * bw.r;
  w[6] = (1.0 - u) * rock + u * bw.b * (1.0 - shallow);
  w[7] = (1.0 - u) * tr;
  float s = 0.0;
  for (int i = 0; i < 8; i++) s += w[i];
  for (int i = 0; i < 8; i++) w[i] /= max(s, 1e-4);
}
#endif
`;
}

/** 層の «地面の種類» のコード（coverRules の戻り値 = 一番重い層 + 1。0 = 不明） */
export const GROUND_KIND = Object.freeze({ none: 0, litter: 1, moss: 2, meadow: 3, cobble: 4, sand: 5, mud: 6, rock: 7, trail: 8 });

/* ---------------- 断片 ---------------- */
/* 断片は ngTerrainH を呼ばない（高さは vNgWorld.y）。core の監査は «本文に名前が出るサンプラー» を断片に数えるので、
   高さの 2 枚（ngHeightNear/Far）を読む ngTerrainH・ngDepth の本体だけを断片の文字列から外す（無ければそのまま） */
const HF_FRAG = NG_HEIGHTFIELD_GLSL
  .replace(/float ngTerrainH\(vec2 xz\) \{[\s\S]*?\n\}\n/, '')
  .replace(/float ngDepth\(vec2 xz\)[^\n]*\n/, '');
export const TERRAIN_FRAG_PARS = HF_FRAG + NG_SKYSPEC_GLSL + NG_WAVE_GLSL + NG_HASH_GLSL + NG_HEXTILE_GLSL + terrainWeightsGLSL() + /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray ngTerrA;      // √アルベド + 高さ
uniform sampler2DArray ngTerrB;      // 法線 xy・粗さ・AO
uniform sampler2D ngTerrMacro;       // マクロの色むら（タイル）
uniform sampler2D ngTerrFar;         // farAlbedo（±512m、上から）
uniform vec4 ngTerrParams;           // x = hex の段（0/1/2）、y = triplanar、z = 遠景へ渡す距離 m、w = debug
uniform vec4 ngTerrWave;             // x = water.time、y = water.wind
uniform vec4 ngTerrDock;             // 踏み跡（付け根 xz、内陸の向き xz）
uniform vec4 ngTerrFlats[4];         // 藻場（x, z, r, 強さ）
varying vec3 ngTerrVInfo;
const float ngTerrTile[8] = ${arr(TERRAIN_TILE_M)};
const float ngTerrPoro[8] = ${arr(TERRAIN_POROSITY)};
/* hex の回転の上限（rad）。向きのある模様（砂の波紋・泥・踏み跡）は回しすぎると継ぎ目が «く» の字に見える */
const float ngTerrHexRot[8] = float[8](3.1416, 3.1416, 3.1416, 3.1416, 0.22, 1.2, 3.1416, 0.8);

vec3 ngTerrNW = vec3(0.0, 1.0, 0.0);   // 世界の法線（normal の口で使う）
float ngTerrRo = 0.9;
float ngTerrAo = 1.0;
float ngTerrSkyOcc = 1.0;
float ngTerrF0 = 0.04;

/* 平面の細部の法線を地形の法線へ «勾配の足し算» で載せる（t は接空間：x = 世界 x、y = 世界 z） */
vec3 ngTerrAddDetail(vec3 Ng, vec2 t) {
  float tz = sqrt(max(1.0 - dot(t, t), 0.04));
  float ny = max(Ng.y, 0.25);
  return normalize(vec3(Ng.x / ny + t.x / tz, 1.0, Ng.z / ny + t.y / tz));
}
vec2 ngTerrUnpackN(vec4 B) { return B.xy * 2.0 - 1.0; }

/* hex-tiling（Mikkelsen 2022）を A・B の 2 枚へ同じ格子・同じ回転で。法線は回転を戻す */
void ngTerrHex(float L, float rs, vec2 uv, vec2 dx, vec2 dy, out vec4 A, out vec4 B) {
  vec3 w; vec2 v1, v2, v3;
  ngHexGrid(uv, w, v1, v2, v3);
  mat2 r1 = ngHexRot(v1, rs), r2 = ngHexRot(v2, rs), r3 = ngHexRot(v3, rs);
  vec2 c1 = v1 / 3.46410162, c2 = v2 / 3.46410162, c3 = v3 / 3.46410162;
  vec2 u1 = r1 * (uv - c1) + c1 + ngHash22(v1), u2 = r2 * (uv - c2) + c2 + ngHash22(v2), u3 = r3 * (uv - c3) + c3 + ngHash22(v3);
  vec4 a1 = textureGrad(ngTerrA, vec3(u1, L), r1 * dx, r1 * dy);
  vec4 a2 = textureGrad(ngTerrA, vec3(u2, L), r2 * dx, r2 * dy);
  vec4 a3 = textureGrad(ngTerrA, vec3(u3, L), r3 * dx, r3 * dy);
  vec4 b1 = textureGrad(ngTerrB, vec3(u1, L), r1 * dx, r1 * dy);
  vec4 b2 = textureGrad(ngTerrB, vec3(u2, L), r2 * dx, r2 * dy);
  vec4 b3 = textureGrad(ngTerrB, vec3(u3, L), r3 * dx, r3 * dy);
  vec3 p = w * w * w * (vec3(1.0) + 7.0 * vec3(a1.a, a2.a, a3.a) * vec3(a1.a, a2.a, a3.a));   // 高い方が勝つ
  p /= max(p.x + p.y + p.z, 1e-6);
  A = a1 * p.x + a2 * p.y + a3 * p.z;
  vec2 n = (transpose(r1) * ngTerrUnpackN(b1)) * p.x + (transpose(r2) * ngTerrUnpackN(b2)) * p.y + (transpose(r3) * ngTerrUnpackN(b3)) * p.z;
  B = vec4(n * 0.5 + 0.5, b1.z * p.x + b2.z * p.y + b3.z * p.z, b1.w * p.x + b2.w * p.y + b3.w * p.z);
}
/* 1 層を読む。mode 0 = 2 スケールの平面、1 = hex、2 = triplanar（崖の岩）。N は世界の法線 */
void ngTerrSample(int Li, vec3 P, vec3 Ng, int mode, vec3 dX3, vec3 dY3, out vec4 A, out vec3 N, out vec2 RA) {
  vec2 dPx = dX3.xz, dPy = dY3.xz;
  float L = float(Li);
  float s = 1.0 / ngTerrTile[Li];
  if (mode == 2) {
    vec3 bl = pow(abs(Ng), vec3(4.0));
    bl /= max(bl.x + bl.y + bl.z, 1e-5);
    vec3 dX = dX3 * s, dY = dY3 * s;
    vec4 ax = textureGrad(ngTerrA, vec3(P.zy * s, L), dX.zy, dY.zy), bx = textureGrad(ngTerrB, vec3(P.zy * s, L), dX.zy, dY.zy);
    vec4 ay = textureGrad(ngTerrA, vec3(P.xz * s, L), dX.xz, dY.xz), by = textureGrad(ngTerrB, vec3(P.xz * s, L), dX.xz, dY.xz);
    vec4 az = textureGrad(ngTerrA, vec3(P.xy * s, L), dX.xy, dY.xy), bz = textureGrad(ngTerrB, vec3(P.xy * s, L), dX.xy, dY.xy);
    A = ax * bl.x + ay * bl.y + az * bl.z;
    /* whiteout（Golus）：各面の接空間の法線を世界へ */
    vec2 tx = ngTerrUnpackN(bx), ty = ngTerrUnpackN(by), tz = ngTerrUnpackN(bz);
    vec3 nx = vec3(tx + Ng.zy, abs(Ng.x));
    vec3 ny = vec3(ty + Ng.xz, abs(Ng.y));
    vec3 nz = vec3(tz + Ng.xy, abs(Ng.z));
    N = normalize(nx.zyx * vec3(sign(Ng.x), 1.0, 1.0) * bl.x + ny.xzy * vec3(1.0, sign(Ng.y), 1.0) * bl.y + nz.xyz * vec3(1.0, 1.0, sign(Ng.z)) * bl.z);
    RA = vec2(bx.z * bl.x + by.z * bl.y + bz.z * bl.z, bx.w * bl.x + by.w * bl.y + bz.w * bl.z);
    return;
  }
  vec2 uv = P.xz * s;
  vec4 B;
  if (mode == 1) {
    ngTerrHex(L, ngTerrHexRot[Li], uv, dPx * s, dPy * s, A, B);
  } else {
    /* 2 スケール：0.31 倍に縮め 1.1rad 回した 2 枚目を重ねる（繰り返しの周期を 1 桁延ばす） */
    mat2 R = mat2(0.4536, 0.8912, -0.8912, 0.4536);
    vec2 uv2 = R * uv * 0.31 + 0.37;
    vec4 a1 = textureGrad(ngTerrA, vec3(uv, L), dPx * s, dPy * s), b1 = textureGrad(ngTerrB, vec3(uv, L), dPx * s, dPy * s);
    vec4 a2 = textureGrad(ngTerrA, vec3(uv2, L), R * dPx * s * 0.31, R * dPy * s * 0.31), b2 = textureGrad(ngTerrB, vec3(uv2, L), R * dPx * s * 0.31, R * dPy * s * 0.31);
    float k = clamp(0.5 + (a2.a - a1.a) * 1.5, 0.15, 0.85);
    A = mix(a1, a2, k);
    vec2 n = mix(ngTerrUnpackN(b1), transpose(R) * ngTerrUnpackN(b2), k);
    B = vec4(n * 0.5 + 0.5, mix(b1.zw, b2.zw, k));
  }
  N = ngTerrAddDetail(Ng, ngTerrUnpackN(B));
  RA = B.zw;
}
/* 3 スケールのマクロの色むら（farAlbedo の焼き込みと同じ式。m = 23m・97m・431m の 3 回の読み） */
vec3 ngTerrMacroTint(vec4 m1, vec4 m2, vec4 m3, float veg) {
  float br = 1.0 + 0.11 * (m1.r * 2.0 - 1.0) + 0.15 * (m2.g * 2.0 - 1.0) + 0.12 * (m3.b * 2.0 - 1.0);
  vec3 hue = mix(vec3(1.05, 1.0, 0.88), vec3(0.94, 1.0, 1.07), m2.a);
  vec3 vh = mix(vec3(1.10, 1.06, 0.78), vec3(0.86, 1.0, 1.02), m1.b);
  return br * mix(vec3(1.0), hue, 0.6) * mix(vec3(1.0), vh, veg * 0.8);
}
float ngTerrWeedAt(vec2 xz) {
  float k = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 fl = ngTerrFlats[i];
    if (fl.z <= 0.0) continue;
    float d = distance(xz, fl.xy);
    k = max(k, (1.0 - smoothstep(fl.z * 0.45, fl.z * 1.05, d + 6.0 * (ngVNoise2(xz * 0.12 + float(i)) - 0.5))) * fl.w);
  }
  return k;
}
vec3 ngTerrDebugCol(float i) {
  return i < 0.5 ? vec3(0.55, 0.40, 0.25) : i < 1.5 ? vec3(0.1, 0.6, 0.1) : i < 2.5 ? vec3(0.6, 0.8, 0.2) : i < 3.5 ? vec3(0.5, 0.5, 0.55)
       : i < 4.5 ? vec3(0.9, 0.8, 0.5) : i < 5.5 ? vec3(0.3, 0.2, 0.15) : i < 6.5 ? vec3(0.7, 0.7, 0.7) : vec3(0.9, 0.4, 0.1);
}

/* 本体：アルベドを返し、法線・粗さ・AO を大域へ置く */
vec3 ngTerrShade(vec3 P) {
  vec2 xz = P.xz;
  vec3 dPx = dFdx(P), dPy = dFdy(P);
  vec3 Ng = ngTerrainN(xz);
  float sd = ngTerrShoreD(xz);
  vec4 bed = ngTerrBed(xz);
  vec2 cn = ngCanopyAt(xz);
  float slope = sqrt(max(1.0 - Ng.y * Ng.y, 0.0)) / max(Ng.y, 0.05);
  float dist = distance(cameraPosition, P);
  bool refl = ngPassId > 0.5 && ngPassId < 1.5;
  float farK = refl ? 1.0 : smoothstep(ngTerrParams.z * 0.72, ngTerrParams.z, dist);
  vec4 m1 = texture(ngTerrMacro, xz * (1.0 / 23.0));
  vec4 m2 = texture(ngTerrMacro, xz * (1.0 / 97.0) + 0.37);
  vec4 m3 = texture(ngTerrMacro, xz * (1.0 / 431.0) + 0.71);
  vec3 farC = texture(ngTerrFar, ngFarMapUV(xz)).rgb;
  float w[8];
  ngTerrWeights(P, Ng, sd, bed, cn, ngTerrTrailAt(xz, ngTerrDock), w);
  float weed = ngTerrWeedAt(xz) * (1.0 - smoothstep(-0.6, 0.0, P.y));
  /* 上位 2 層 */
  int i1 = 0, i2 = 1;
  float w1 = -1.0, w2 = -1.0;
  for (int i = 0; i < 8; i++) {
    float v = w[i];
    if (v > w1) { w2 = w1; i2 = i1; w1 = v; i1 = i; } else if (v > w2) { w2 = v; i2 = i; }
  }
  float poro = 0.0, puddleable = 0.0;
  for (int i = 0; i < 8; i++) poro += w[i] * ngTerrPoro[i];
  puddleable = w[7] + 0.55 * w[2] + 0.8 * w[5] + 0.25 * w[0];
  float veg = w[0] * 0.4 + w[1] + w[2];
  vec3 alb = farC;
  vec3 N = Ng;
  float ro = 0.9, ao = 1.0, hBlend = 0.5;
  if (farK < 0.999) {
    int hexM = int(ngTerrParams.x + 0.5);
    bool tri = ngTerrParams.y > 0.5 && slope > 0.55;
    int mode1 = (i1 == 6 && tri) ? 2 : (hexM >= 1 ? 1 : 0);
    int mode2 = (i2 == 6 && tri) ? 2 : (hexM >= 2 ? 1 : 0);
    vec4 A1, A2; vec3 N1, N2; vec2 R1, R2;
    ngTerrSample(i1, P, Ng, mode1, dPx, dPy, A1, N1, R1);
    float s2 = w2 / max(w1 + w2, 1e-4);
    float t = 0.0;
    if (s2 > 0.015) {
      ngTerrSample(i2, P, Ng, mode2, dPx, dPy, A2, N2, R2);
      float s1 = 1.0 - s2, dpt = 0.16;
      float ma = max(A1.a + s1, A2.a + s2) - dpt;
      float b1 = max(A1.a + s1 - ma, 0.0), b2 = max(A2.a + s2 - ma, 0.0);
      t = b2 / max(b1 + b2, 1e-4);
    } else { A2 = A1; N2 = N1; R2 = R1; }
    vec3 nearC = mix(A1.rgb * A1.rgb, A2.rgb * A2.rgb, t) * ngTerrMacroTint(m1, m2, m3, veg);
    hBlend = mix(A1.a, A2.a, t);
    alb = mix(nearC, farC, farK);
    N = normalize(mix(normalize(mix(N1, N2, t)), Ng, farK));
    ro = mix(mix(R1.x, R2.x, t), 0.9, farK);
    ao = mix(mix(R1.y, R2.y, t), 1.0, farK);
  }
  /* 乾いた浜の砂は波紋を弱く（風紋ほど）。水中・濡れた所は強いまま */
  N = normalize(mix(N, Ng, w[4] * smoothstep(-0.02, 0.15, P.y) * 0.85));
  /* 藻場：有機物の堆積で暗く緑褐色に */
  alb = mix(alb, alb * vec3(0.55, 0.62, 0.45), weed * 0.75);
  /* 水中の底は常に濡れている（砂ほど暗い） */
  float under = 1.0 - smoothstep(-0.12, 0.02, P.y);
  float wet = 0.0;
  /* 汀の濡れ帯：遡上の水膜（今かぶっている所）と乾きかけ（直前まで濡れていた帯） */
  float ru = ngShoreRunUp(xz, ngTerrWave.x) * ngTerrWave.y;
  float above = P.y - ru;
  float nearShore = 1.0 - smoothstep(5.0, 10.0, sd);
  float film = (1.0 - smoothstep(-0.005, 0.03, above)) * step(-0.12, P.y) * nearShore;
  float damp = (1.0 - smoothstep(0.02, 0.16 + 0.10 * ngVNoise2(xz * 0.7), P.y - max(ru, 0.0) * 0.8)) * nearShore;
  wet = max(wet, max(damp * 0.85, film));
  /* 雨：樹冠の下は濡れにくい */
  float rainWet = ngWet * (1.0 - 0.55 * cn.x) * (1.0 - under);
  wet = max(wet, rainWet);
  /* 水中は水と接しているので鏡面は弱い（屈折率の比が小さい）。アルベドだけ濡れの暗さ */
  alb *= 1.0 - max(wet, under * 0.8) * poro * 0.48;
  ro = mix(ro, 0.12, wet * (0.55 + 0.45 * poro));
  ngTerrF0 = mix(0.04, 0.004, under);
  if (film > 0.0) {
    alb *= 1.0 - 0.15 * film;
    ro = mix(ro, 0.05, film);
    N = normalize(mix(N, Ng, film * 0.7));
    ngTerrF0 = mix(0.04, 0.02, film);
  }
  /* 水たまり：低い所（層の高さの窪み）から先に溜まる。面は雨の輪 */
  float pud = ngPuddle(xz, slope) * clamp(puddleable, 0.0, 1.0) * (1.0 - under) * smoothstep(0.3, 1.0, sd);
  pud = smoothstep(0.0, 1.0, clamp(pud * 1.6 - hBlend * 0.6, 0.0, 1.0));
  if (pud > 0.0) {
    vec2 g = ngRainRings(xz, ngEnvTime, ngRain);
    vec3 Np = normalize(vec3(-g.x, 1.0, -g.y));
    alb = mix(alb, alb * 0.3, pud);
    ro = mix(ro, 0.02, pud);
    N = normalize(mix(N, Np, pud));
    ngTerrF0 = mix(ngTerrF0, 0.02, pud);
  }
  ngTerrNW = N;
  ngTerrRo = clamp(ro, 0.02, 1.0);
  ngTerrAo = ao;
  ngTerrSkyOcc = (1.0 - 0.75 * cn.x) * mix(1.0, ao, 0.7) * (1.0 - under);
  /* デバッグ：1 = LOD の色、2 = 一番重い層、3 = パッチの格子の線 */
  float dbg = ngTerrParams.w;
  if (dbg > 9.5) {
    /* 10 + i：層 i のアルベド、20 + i：層 i の法線、30 + i：層 i の高さ（平面の写像そのまま） */
    float li = mod(dbg, 10.0);
    vec4 a = texture(ngTerrA, vec3(xz / ngTerrTile[int(li)], li)), b = texture(ngTerrB, vec3(xz / ngTerrTile[int(li)], li));
    alb = dbg < 19.5 ? a.rgb * a.rgb : dbg < 29.5 ? b.rgb * 0.5 : vec3(a.a * 0.4);
    ngTerrNW = Ng;
  } else if (dbg > 0.5) {
    if (dbg < 1.5) {
      float l = floor(ngTerrVInfo.x), k = fract(ngTerrVInfo.x);
      vec3 c0 = 0.5 + 0.5 * cos(6.2832 * (l / 7.0 + vec3(0.0, 0.33, 0.67)));
      vec3 c1 = 0.5 + 0.5 * cos(6.2832 * ((l + 1.0) / 7.0 + vec3(0.0, 0.33, 0.67)));
      alb = mix(c0, c1, k) * 0.5;
    } else if (dbg < 2.5) {
      alb = ngTerrDebugCol(float(i1)) * 0.4;
    } else if (dbg > 4.5) {
      alb = farC;
    } else if (dbg > 3.5) {
      alb = vec3(clamp(sd / 20.0, 0.0, 1.0), cn.x, clamp(-sd / 20.0, 0.0, 1.0)) * 0.4;
    } else {
      vec2 gq = abs(fract(ngTerrVInfo.yz + 0.5) - 0.5) / max(fwidth(ngTerrVInfo.yz), 1e-4);
      alb = mix(vec3(0.02), alb, smoothstep(0.0, 1.2, min(gq.x, gq.y)));
    }
  }
  return alb;
}
/* 空の鏡面（Karis の EnvBRDF 近似）。lights の口で indirectSpecular に足す */
vec3 ngTerrSkySpec(vec3 P, vec3 N, float ro, float F0) {
  vec3 V = normalize(cameraPosition - P);
  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  vec3 R = reflect(-V, N);
  vec4 r = ro * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return ngSkySpecular(R, ro) * (F0 * AB.x + AB.y);
}
`;

export const TERRAIN_FRAG_SURFACE = 'diffuseColor.rgb = ngTerrShade( vNgWorld );';
export const TERRAIN_FRAG_NORMAL = 'normal = normalize( ( viewMatrix * vec4( ngTerrNW, 0.0 ) ).xyz );';
export const TERRAIN_FRAG_ROUGH = 'roughnessFactor = ngTerrRo;';
export const TERRAIN_FRAG_LIGHTS = /* glsl */ `
reflectedLight.indirectSpecular += ngTerrSkySpec( vNgWorld, ngTerrNW, ngTerrRo, ngTerrF0 ) * ngTerrSkyOcc;
`;
export const TERRAIN_FRAG_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= ngTerrAo * ( ngTerrSkyOcc * 0.6 + 0.4 );
reflectedLight.directDiffuse *= mix( 1.0, ngTerrAo, 0.45 );
`;

/**
 * coverRules（groundcover が自分のシェーダへ連結する）。ngGroundKind(p) = 一番重い層 + 1（GROUND_KIND）。
 * 桟橋の踏み跡は湖ごとの定数で埋める（素材の uniform と同じ値）
 * @param {{x:number,z:number}} start 桟橋の付け根
 * @param {{x:number,z:number}} inland 内陸の向き（単位）
 * @returns {string}
 */
export function terrainCoverRules(start, inland) {
  const v = (n) => (Number.isFinite(n) ? n : 0).toFixed(5);
  return NG_HEIGHTFIELD_GLSL + terrainWeightsGLSL() + /* glsl */ `
#ifndef NG_LIB_TERR_COVER
#define NG_LIB_TERR_COVER
/* terrain の層：1 林床・2 苔・3 草地・4 玉石・5 砂・6 泥・7 岩・8 踏み跡（p.y < 0 は湖底） */
float ngGroundKind(vec3 p) {
  vec2 xz = p.xz;
  float w[8];
  ngTerrWeights(p, ngTerrainN(xz), ngTerrShoreD(xz), ngTerrBed(xz), ngCanopyAt(xz),
    ngTerrTrailAt(xz, vec4(${v(start.x)}, ${v(start.z)}, ${v(inland.x)}, ${v(inland.z)})), w);
  int best = 0; float bw = -1.0;
  for (int i = 0; i < 8; i++) if (w[i] > bw) { bw = w[i]; best = i; }
  return float(best + 1);
}
#endif
`;
}
