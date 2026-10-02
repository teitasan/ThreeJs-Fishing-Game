/* ===========================================================
   trees の GLSL（ngExtendStandard の口に差し込む部品）
   -----------------------------------------------------------
   1. 木（LOD0 / LOD1、BatchedMesh）：幹・枝・葉を 1 つのマテリアルで（頂点の旗で分ける）
      - 頂点：20B の量子化（ngNrm oct・ngUv・ngWind・ngExtra）を展開、階層の風（幹 0.2Hz・枝・葉 4–7Hz）、
        LOD のディザの重み、反射は LOD1 だけ（LOD0 の木は反射用の代理が LOD1 で写る）
      - 断片：樹皮の配列（苔・濡れ・アカマツの上の赤）、葉のアトラス、樹冠へ曲げた法線（両面で裏返さない）、
        透過（key × 薄さ × 逆光、黄金時間に縁が光る）、空の鏡面、AO
   2. インポスター（半八面体 8×8、3 フレームの重心ブレンド、同じ BRDF で再ライティング）
   3. 樹冠シェル（遠景の山肌。far の高さ場 + 自前の樹冠の地図）
   影の変種（depth: true）に入るのは vertex の pars/normal/begin と fragment の pars/alpha だけ。
   =========================================================== */
import { NG_HASH_GLSL, NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { NG_WIND_GLSL } from '../core/glsl/wind.glsl.js';
import { NG_SKYSPEC_GLSL } from '../core/glsl/surface.glsl.js';
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { POS_RANGE, UV_U_RANGE, UV_V_RANGE } from './format.js';
import { LEAF_GRID, LEAF_PAD } from './textures.js';
import { IMP_GRID } from './quality.js';

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/* ---------------------------------------------------------------- 共有：透過と空の鏡面 */

const SHARED_FRAG = /* glsl */ `
#ifndef NG_TREES_SHARED
#define NG_TREES_SHARED
/* 葉の透過：見る向きと key が葉の反対側にあるほど強い（裏から見た葉は表の光を通す）。
   拡散の透過 + 前方散乱の縁の輝き（黄金時間の逆光）。albedo は葉の反射率、thin は 0..1 */
vec3 ngTreeTransmit(vec3 albedo, vec3 Nw, vec3 Vw, float thin, float vis, float depth) {
  vec3 L = ngKeyDir;
  float mu = clamp(dot(Vw, -L), -1.0, 1.0);
  float diffT = pow(clamp(mu * 0.5 + 0.5, 0.0, 1.0), 2.0) * 0.3183 * 0.9;
  float m = max(mu, 0.0);
  float fwd = pow(m, 6.0) * 0.55 + pow(m, 28.0) * 1.1;
  vec3 tcol = albedo * vec3(1.15, 1.45, 0.45);
  return tcol * ngKeyRad * vis * thin * (diffT + fwd) * (1.0 - 0.7 * depth);
}
/* 森の中の空の見え（隣の木の樹冠で空の光が減り、葉を通った緑の光になる）。
   canopy = 樹冠の地図の rgba、below = 樹冠の天井からの下がり具合 0..1 */
vec3 ngCanopyAmbient(vec4 canopy, float below) {
  float occ = clamp(canopy.r * below, 0.0, 1.0);
  return mix(vec3(1.0), vec3(0.20, 0.27, 0.13), occ * 0.85);
}
uniform sampler2D ngCanopyMap;
/* 調べ物の表示（ngTreeMisc.w）：1 直接の鏡面なし・2 空の鏡面なし・3 透過なし・4 間接の拡散だけ・5 直接の鏡面だけ・6 空の鏡面だけ・7 透過だけ・8 直接の拡散だけ */
void ngTreeDbg(inout ReflectedLight rl, vec3 tr, float mode) {
  int m = int(mode + 0.5);
  if (m == 1) rl.directSpecular = vec3(0.0);
  else if (m == 2) rl.indirectSpecular = vec3(0.0);
  else if (m == 3) rl.directDiffuse -= tr;
  else if (m == 4) { rl.directDiffuse = vec3(0.0); rl.directSpecular = vec3(0.0); rl.indirectSpecular = vec3(0.0); }
  else if (m == 5) { rl.directDiffuse = vec3(0.0); rl.indirectDiffuse = vec3(0.0); rl.indirectSpecular = vec3(0.0); }
  else if (m == 6) { rl.directDiffuse = vec3(0.0); rl.indirectDiffuse = vec3(0.0); rl.directSpecular = vec3(0.0); }
  else if (m == 7) { rl.directDiffuse = tr; rl.indirectDiffuse = vec3(0.0); rl.directSpecular = vec3(0.0); rl.indirectSpecular = vec3(0.0); }
  else if (m == 8) { rl.directDiffuse -= tr; rl.indirectDiffuse = vec3(0.0); rl.directSpecular = vec3(0.0); rl.indirectSpecular = vec3(0.0); }
}
vec4 ngCanopyAt2(vec2 xz) { return texture2D(ngCanopyMap, (xz + 512.0) / 1024.0); }
#endif
`;

/* 葉・樹皮の空の鏡面（NG_SKYSPEC_GLSL の後に置く）。夕方に森が «霜を被ったように» 白く光った原因（r2 で直した）：
   - 空の明るさを «平均の空の 4 倍» で頭打ち（skyView の太陽の近くを拾わない。太陽の鏡面は直接光が持つ）
   - 樹冠の中の鏡面の遮蔽：水平に近い反射は森では隣の木の葉に当たる（地平の明るい夕空を写さない）。dens = 周りの樹冠の密度
   - 粗さを考えた Fresnel（Fdez-Agüera 2019：grazing の 1 を max(1 − rough, F0) に）。葉の F0 = 0.03（クチクラ n ≈ 1.45） */
const TREE_SKYSPEC = /* glsl */ `
#ifndef NG_TREES_SKYSPEC
#define NG_TREES_SKYSPEC
vec3 ngTreeSkySpec(vec3 R, float nv, float rough, float f0, float dens) {
  vec3 s = ngSkySpecular(R, rough);
  float cap = 4.0 * max(ngLuminance(ngSkyIrr), 1e-4);
  s *= min(1.0, cap / max(ngLuminance(s), 1e-6));
  float F = f0 + (max(1.0 - rough, f0) - f0) * pow(1.0 - clamp(nv, 0.0, 1.0), 5.0);
  float horizon = mix(1.0, smoothstep(-0.05, 0.8, R.y), clamp(dens, 0.0, 1.0));
  return s * F * horizon;
}
#endif
`;

/* ---------------------------------------------------------------- 1. 木 */

const TREE_VS_PARS = NG_HASH_GLSL + NG_WIND_GLSL + /* glsl */ `
#define NG_POS_RANGE ${f(POS_RANGE)}
attribute vec2 ngNrm;
attribute vec2 ngUv;
attribute vec4 ngWind;
attribute vec4 ngExtra;
uniform vec4 ngTreeEye;     // xyz = 主カメラの位置（反射・影でも同じ）、w = LOD の倍率
uniform vec4 ngTreeLod;     // x = LOD0 の端、y = LOD1 の端、z = 0→1 のディザ幅、w = 1→インポスターのディザ幅
uniform vec4 ngTreePass;    // x = 反射の LOD1 の端、y = その幅、z = 影の LOD0 の端
uniform vec4 ngTreeWindK;   // x = 幹、y = 枝、z = 葉の震え（m / (m/s)）、w = 時間の倍率
varying vec2 vNgTUv;
varying vec4 vNgTInfo;      // x = 葉 1 / 樹皮 0、y = 層、z = AO、w = 樹冠の深さ
varying vec4 vNgTInst;      // x = 残す割合（LOD のディザ）、y = 個体の乱数、z = 樹高 m、w = 正規化の高さ
varying vec3 vNgTNW;        // 世界の法線（苔の向き）
vec3 ngTreeOct(vec2 e) {
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`;

const TREE_VS_NORMAL = /* glsl */ `
objectNormal = ngTreeOct(ngNrm);
`;

const TREE_VS_BEGIN = /* glsl */ `
{
#if defined( USE_BATCHING )
  mat4 ngTM = batchingMatrix;
  /* [3][3] は代理の印（2 = 反射だけに出す LOD1）。投影の前に 1 へ戻す */
  float ngFlag = ngTM[3][3];
  /* [0][3] は幹を太らせる倍率（fit.js：当たりに合わせる）。投影の前に 0 へ戻す */
  float ngWiden = max(ngTM[0][3], 1.0);
  batchingMatrix[3][3] = 1.0;
  batchingMatrix[0][3] = 0.0;
  ngTM[3][3] = 1.0;
  ngTM[0][3] = 0.0;
#elif defined( USE_INSTANCING )
  mat4 ngTM = instanceMatrix;
  float ngFlag = 1.0;
  float ngWiden = 1.0;
#else
  mat4 ngTM = mat4(1.0);
  float ngFlag = 1.0;
  float ngWiden = 1.0;
#endif
  vec3 ngRoot = (modelMatrix * vec4(ngTM[3].xyz, 1.0)).xyz;
  mat3 ngM3 = mat3(ngTM);
  float ngS = max(length(ngM3[1]), 1e-3);
  float ngH = ngS / NG_POS_RANGE;
  float ngYn = position.y * NG_POS_RANGE;
  float ngFl = floor(ngExtra.y * 255.0 + 0.5);
  float ngLeaf = step(127.5, ngFl);
  float ngLod1 = step(0.5, ngExtra.w);
  float ngRnd = ngHash12(ngRoot.xz * 0.731 + 0.17);

  /* LOD のディザの重み（主カメラからの水平距離） */
  float ngD = length(ngRoot.xz - ngTreeEye.xz) / max(ngTreeEye.w, 1e-3);
  float ngF01 = smoothstep(ngTreeLod.x - ngTreeLod.z, ngTreeLod.x, ngD);
  float ngFim = smoothstep(ngTreeLod.y - ngTreeLod.w, ngTreeLod.y, ngD);
  float ngKeep = ngLod1 > 0.5 ? ngF01 * (1.0 - ngFim) : 1.0 - ngF01;
  bool ngDrop = false;
  /* 印（[3][3]）：1 = 普通、2 = 代理（視野の中の LOD0 の木の LOD1：反射と遠めの影）、3 = 影だけ（視野の外の近い木） */
  if (ngPassId == NG_PASS_REFLECTION) {
    /* 反射：LOD1 は近い所（ngTreePass.x まで）だけ、その先はインポスター。LOD0 は落とす */
    float fr = smoothstep(ngTreePass.x - ngTreePass.y, ngTreePass.x, ngD);
    ngKeep = 1.0 - fr;
    if (ngLod1 < 0.5 || ngFlag > 2.5) ngDrop = true;
  } else if (ngPassId == NG_PASS_SHADOW) {
    /* 影：LOD0 は ngTreePass.z の内側だけ、外は LOD1（代理・影だけを含む） */
    if (ngLod1 < 0.5) ngKeep = step(ngD, ngTreePass.z);
    else ngKeep = ngFlag > 1.5 ? (ngFlag > 2.5 ? 1.0 : step(ngTreePass.z, ngD)) : step(0.5, ngKeep);
  } else if (ngFlag > 1.5) {
    ngDrop = true;
  }
  if (ngKeep < 0.003) ngDrop = true;

  /* 幹（管の level 0）の根元の帯を当たりの太さへ（fit.js の widenAt と同じ式） */
  if (ngLeaf < 0.5 && ngWind.w < 0.01 && ngWiden > 1.001) {
    float ngYm = ngYn * ngH;
    float ngWs = smoothstep(1.7, 1.7 + max(1.5, 0.2 * ngH), ngYm);
    transformed.xz *= mix(ngWiden, 1.0 + 0.3 * (ngWiden - 1.0), ngWs);
  }
  /* 風（世界の m で決めて、インスタンスの行列の逆でローカルへ）。影の変種も同じ式 */
  vec4 ngW = ngWindAt(ngRoot.xz);
  float ngSp = ngW.z;
  float ngT = ngEnvTime * ngTreeWindK.w;
  vec2 ngWd = ngW.xy;
  /* 幹：高さの 2 乗で曲がる。0.2Hz の揺れ + 突風 */
  float ngA = ngTreeWindK.x * ngH * ngSp * (0.55 + 0.22 * sin(ngT * 1.2566 + ngRnd * 6.2832) + 0.45 * ngW.w);
  vec3 ngDispW = vec3(ngWd.x, 0.0, ngWd.y) * (ngA * ngYn * ngYn);
  /* 枝：しなり² × 位相つきの振動（0.5–1.2Hz）。上下にも揺れる */
  float ngFx = ngWind.x;
  float ngB = ngTreeWindK.y * ngSp * ngFx * ngFx * min(ngH, 26.0) * (0.6 + 0.5 * ngW.w);
  float ngPh = ngT * (3.3 + 4.2 * ngWind.y) + ngWind.y * 6.2832 + ngRnd * 6.2832;
  ngDispW += vec3(ngWd.x, 0.0, ngWd.y) * ngB * (0.55 + 0.45 * sin(ngPh));
  ngDispW.y += ngB * 0.4 * sin(ngPh * 1.31 + 1.7);
  /* 葉：面の法線の向きに 4–7Hz で震える（カードの先ほど大きい） */
  vec3 ngNl = ngTreeOct(ngNrm);
  float ngFlut = ngLeaf * ngTreeWindK.z * (0.35 + ngSp) * ngWind.z * (0.6 + 0.4 * ngW.w)
               * sin(ngT * (25.0 + 19.0 * ngWind.w) + ngWind.w * 31.0 + ngRnd * 11.0);
  vec3 ngS2 = vec3(dot(ngM3[0], ngM3[0]), dot(ngM3[1], ngM3[1]), dot(ngM3[2], ngM3[2]));
  transformed += (transpose(ngM3) * ngDispW) / ngS2 + ngNl * (ngFlut / ngS);
  if (ngDrop) transformed = vec3(0.0);

  vNgTUv = ngUv;
  vNgTInfo = vec4(ngLeaf, ngFl - ngLeaf * 128.0, ngExtra.x, ngExtra.z);
  vNgTInst = vec4(ngKeep, ngRnd, ngH, ngYn);
  vNgTNW = normalize(ngM3 * ngNl);
}
`;

const TREE_FS_PARS = NG_HASH_GLSL + NG_SKYSPEC_GLSL + TREE_SKYSPEC + SHARED_FRAG + /* glsl */ `
#define NG_UV_U ${f(UV_U_RANGE)}
#define NG_UV_V ${f(UV_V_RANGE)}
uniform highp sampler2DArray ngBarkAlb;
uniform highp sampler2DArray ngBarkNrm;
uniform sampler2D ngLeafAlb;
uniform sampler2D ngLeafNrm;
uniform vec4 ngTreeMisc;     // x = A2C（1 = high）、y = 苔の量、z = 季節の黄葉、w = 0
varying vec2 vNgTUv;
varying vec4 vNgTInfo;
varying vec4 vNgTInst;
varying vec3 vNgTNW;
vec2 ngLeafUV(vec2 uv, float layer) {
  vec2 grid = vec2(${f(LEAF_GRID[0])}, ${f(LEAF_GRID[1])});
  vec2 cell = vec2(mod(layer, grid.x), floor(layer / grid.x));
  return (cell + ${f(LEAF_PAD)} + clamp(uv, 0.0, 1.0) * (1.0 - 2.0 * ${f(LEAF_PAD)})) / grid;
}
/* 葉の被覆：mip の段で持ち上げる（箱の mip の平均で alphaTest が痩せない。Golus の «mip の段 × 0.25»） */
uniform vec2 ngLeafSize;
float ngLeafAlpha(vec2 luv) {
  float a = texture2D(ngLeafAlb, luv).a;
  vec2 t = luv * ngLeafSize;
  float lod = 0.5 * log2(max(max(dot(dFdx(t), dFdx(t)), dot(dFdy(t), dFdy(t))), 1e-8));
  return clamp(a * (1.0 + max(lod, 0.0) * 0.28), 0.0, 1.0);
}
vec2 ngBarkUV() {
  /* 樹皮の 1 タイル = 周 0.5m × 縦 1.0m。v は «樹高 × 正規化の長さ» = m */
  return vec2(vNgTUv.x * NG_UV_U, vNgTUv.y * NG_UV_V * vNgTInst.z);
}
/* LOD のディザ：A2C の段は被覆へ、無い段・影は画面のハッシュで抜く */
float ngTreeDither(float a) {
  float keep = vNgTInst.x;
  if (keep >= 0.999) return a;
  if (ngTreeMisc.x > 0.5 && ngPassId != NG_PASS_SHADOW) return a * keep;
  float n = ngHash12(floor(gl_FragCoord.xy) + fract(vNgTInst.y * 37.0) * 61.0);
  return keep > n ? a : 0.0;
}
/* 微分から接空間（Mikkelsen の cotangent frame） */
mat3 ngCotangent(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * du1.x + dp1perp * du2.x;
  vec3 B = dp2perp * du1.y + dp1perp * du2.y;
  float inv = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  return mat3(T * inv, B * inv, N);
}
`;

const TREE_FS_SURFACE = /* glsl */ `
vec4 ngTA = vec4(0.0), ngTN = vec4(0.5, 0.5, 1.0, 0.6);
float ngTLeaf = vNgTInfo.x;
if (ngTLeaf > 0.5) {
  vec2 luv = ngLeafUV(vNgTUv, vNgTInfo.y);
  ngTA = texture2D(ngLeafAlb, luv);
  ngTN = texture2D(ngLeafNrm, luv);
  vec3 c = ngTA.rgb;
  /* 個体の色むら（色相と明るさ）・日焼けした外側・季節 */
  float r = vNgTInst.y;
  c *= mix(vec3(0.90, 0.95, 1.06), vec3(1.10, 1.05, 0.88), r);
  c *= 0.86 + 0.28 * fract(r * 7.31);
  c = mix(c, c * vec3(1.18, 1.1, 0.8), (1.0 - vNgTInfo.w) * 0.35);
  diffuseColor.rgb = c;
} else {
  vec2 buv = ngBarkUV();
  float lay = vNgTInfo.y;
  ngTA = texture(ngBarkAlb, vec3(buv, lay));
  ngTN = texture(ngBarkNrm, vec3(buv, lay));
  if (abs(lay - 5.0) < 0.5) {
    /* アカマツ：幹の上半分は赤い薄皮 */
    float up = smoothstep(0.32, 0.55, vNgTInst.w + 0.12 * (ngTA.a - 0.5));
    if (up > 0.001) {
      ngTA = mix(ngTA, texture(ngBarkAlb, vec3(buv, 6.0)), up);
      ngTN = mix(ngTN, texture(ngBarkNrm, vec3(buv, 6.0)), up);
    }
  }
  vec3 c = ngTA.rgb;
  /* 苔：北（−z）と上を向いた面、根元ほど。窪みに溜まる。樹種で量が違う */
  vec3 nW = normalize(vNgTNW);
  float mossSp = (lay > 1.5 && lay < 4.5) ? 1.0 : (lay > 6.5 ? 0.8 : 0.35);
  float hM = vNgTInst.w * vNgTInst.z;
  float m = smoothstep(0.05, 0.75, dot(nW, normalize(vec3(0.0, 0.55, -1.0)))) * (1.0 - smoothstep(0.6, 5.5, hM)) * 0.9
          + smoothstep(0.55, 0.95, nW.y) * 0.6;
  m *= mossSp * ngTreeMisc.y * smoothstep(0.25, 0.75, 1.0 - ngTA.a + 0.35 * ngHash12(floor(buv * vec2(24.0, 12.0))));
  c = mix(c, vec3(0.050, 0.082, 0.028), clamp(m, 0.0, 0.85));
  /* 雨：幹を伝う筋（縦に流れて暗く） */
  float streak = smoothstep(0.4, 1.0, sin(buv.x * 18.85 + 3.0 * sin(buv.y * 0.7)) * 0.5 + 0.5) * ngWet;
  c *= 1.0 - 0.25 * streak;
  diffuseColor.rgb = c;
}
`;

const TREE_FS_ALPHA = /* glsl */ `
{
  float ngAl = 1.0;
  if (vNgTInfo.x > 0.5) ngAl = ngLeafAlpha(ngLeafUV(vNgTUv, vNgTInfo.y));
  diffuseColor.a = ngTreeDither(ngAl);
}
`;

const TREE_FS_ROUGH = /* glsl */ `
roughnessFactor = clamp(ngTN.a, 0.3, 1.0);
if (ngTLeaf < 0.5) ngWetSurface(diffuseColor.rgb, roughnessFactor, 0.45, ngWet * 0.6);
else roughnessFactor = mix(roughnessFactor, 0.25, ngWet * 0.8);
`;

const TREE_FS_NORMAL = /* glsl */ `
{
  vec3 ngTn = vec3(ngTN.xy * 2.0 - 1.0, 0.0);
  ngTn.z = sqrt(max(1.0 - dot(ngTn.xy, ngTn.xy), 0.0));
  if (ngTLeaf > 0.5) {
    /* 葉：頂点の法線は樹冠の外向きへ曲げてある。両面で裏返さない（裏から見ても樹冠の陰影） */
    vec3 nb = normalize(vNormal);
    mat3 tbn = ngCotangent(nb, -vViewPosition, vNgTUv);
    ngTn.xy *= (gl_FrontFacing ? 1.0 : -1.0) * 0.6;
    normal = normalize(tbn * ngTn);
  } else {
    mat3 tbn = ngCotangent(normal, -vViewPosition, ngBarkUV());
    normal = normalize(tbn * ngTn);
  }
}
`;

const TREE_FS_LIGHTS = /* glsl */ `
vec3 ngCanAmb;
vec3 ngTr = vec3(0.0);
{
  vec3 Vw = normalize(cameraPosition - vNgWorld);
  vec3 Nw = inverseTransformDirection(normal, viewMatrix);
  float vis = ngKeyVis * ngNearVis;
  float dep = vNgTInfo.w;
  /* 樹冠の天井（この木の梢 ≈ 周りの樹冠）からの下がり：梢 0 → 樹冠の下端と幹 1 */
  float below = 1.0 - smoothstep(0.45, 1.0, vNgTInst.w);
  vec4 ngCan = ngCanopyAt2(vNgWorld.xz);
  ngCanAmb = ngCanopyAmbient(ngCan, below);
  if (ngTLeaf > 0.5) {
    /* 近景の影の外（LOD1）では樹冠の自己陰影を AO で代える */
    float self = mix(1.0, mix(0.35, 1.0, vNgTInfo.z), ngNearToFar(vNgWorld) * 0.85 + 0.15);
    reflectedLight.directDiffuse *= self;
    reflectedLight.directSpecular *= self * 0.35;
    ngTr = ngTreeTransmit(material.diffuseColor, Nw, Vw, ngTN.b, vis * self, dep);
    reflectedLight.directDiffuse += ngTr;
  }
  /* 空の鏡面（葉の蝋・濡れた樹皮）。three の間接の鏡面は envMap が無いと 0 */
  vec3 R = reflect(-Vw, Nw);
  float nv = abs(dot(Nw, Vw));
  float occ = vNgTInfo.z * (ngTLeaf > 0.5 ? (1.0 - 0.8 * dep) : ngTN.b);
  /* 葉は樹冠の外側でも周りの葉が鏡面を遮る（dens ≥ 0.5）。幹は樹冠の下（below）ほど */
  float sd = ngTLeaf > 0.5 ? max(ngCan.r, 0.5 + 0.5 * dep) : ngCan.r * below;
  reflectedLight.indirectSpecular += ngTreeSkySpec(R, nv, roughnessFactor, 0.03, sd) * occ * (ngTLeaf > 0.5 ? 0.35 + 0.65 * ngWet : 1.0) * ngCanAmb;
}
`;

const TREE_FS_AO = /* glsl */ `
{
  float occ = vNgTInfo.z * (ngTLeaf > 0.5 ? (1.0 - 0.55 * vNgTInfo.w) : ngTN.b);
  reflectedLight.indirectDiffuse *= occ * ngCanAmb;
  if (ngTreeMisc.w > 0.5) ngTreeDbg(reflectedLight, ngTr, ngTreeMisc.w);
}
`;

export const TREE_HOOKS = {
  vertex: { pars: TREE_VS_PARS, normal: TREE_VS_NORMAL, begin: TREE_VS_BEGIN },
  fragment: { pars: TREE_FS_PARS, surface: TREE_FS_SURFACE, alpha: TREE_FS_ALPHA, rough: TREE_FS_ROUGH, normal: TREE_FS_NORMAL, lights: TREE_FS_LIGHTS, ao: TREE_FS_AO },
};

/* ---------------------------------------------------------------- 2. インポスター */

const N = f(IMP_GRID);
const IMP_COMMON = /* glsl */ `
#ifndef NG_TREES_IMPOCT
#define NG_TREES_IMPOCT
/* 半八面体：上半球の向き ↔ [-1,1]²（45° 回した菱形を正方形へ） */
vec2 ngHemiEnc(vec3 d) {
  d.y = max(d.y, 0.0);
  vec3 a = d / max(abs(d.x) + abs(d.y) + abs(d.z), 1e-5);
  return vec2(a.x + a.z, a.x - a.z);
}
vec3 ngHemiDec(vec2 e) {
  float x = (e.x + e.y) * 0.5, z = (e.x - e.y) * 0.5;
  return normalize(vec3(x, max(1.0 - abs(x) - abs(z), 0.0), z));
}
/* フレームの向き d の撮影の基底（焼き込みと同じ） */
void ngImpBasis(vec3 d, out vec3 r, out vec3 u) {
  vec3 up = abs(d.y) > 0.999 ? vec3(0.0, 0.0, -1.0) : vec3(0.0, 1.0, 0.0);
  r = normalize(cross(up, d));
  u = cross(d, r);
}
#endif
`;
export const IMP_OCT_GLSL = IMP_COMMON;

const IMP_VS_PARS = NG_HASH_GLSL + IMP_COMMON + /* glsl */ `
#define NG_IMP_N ${N}
attribute vec4 ngIPos;     // x, y（根元）, z, 樹高 h
attribute vec4 ngIRot;     // x = rotation.y, y = 層, z = 乱数, w = 傾き
uniform vec4 ngImpMeta[16];   // x = 中心の高さ（正規化）、y = 半径（正規化）
uniform vec4 ngImpLod;        // x = 出始め, y = 出始めの幅, z = 消える端, w = 消える幅
uniform vec4 ngTreePass;
uniform vec4 ngTreeEye;
varying vec3 vNgI0; varying vec3 vNgI1; varying vec3 vNgI2;  // xy = フレームの中の uv、z = 重み
varying vec4 vNgIF;            // xy = フレーム 0 の格子、zw = 1
varying vec2 vNgIF2;           // フレーム 2 の格子
varying vec4 vNgIInfo;         // x = 層、y = 残す割合、z = 乱数、w = rotation.y
varying vec2 vNgIH;            // 根元の y、樹高
vec3 ngRotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec2 ngImpUV(vec2 cell, vec3 Pl, float R) {
  vec3 d = ngHemiDec(cell / (NG_IMP_N - 1.0) * 2.0 - 1.0);
  vec3 r, u;
  ngImpBasis(d, r, u);
  return vec2(dot(Pl, r), dot(Pl, u)) / (2.0 * R) + 0.5;
}
`;

const IMP_VS_BEGIN = /* glsl */ `
{
  float h = ngIPos.w;
  vec4 meta = ngImpMeta[int(ngIRot.y + 0.5)];
  vec3 C = ngIPos.xyz + vec3(0.0, meta.x * h, 0.0);
  float R = meta.y * h;
  float ngD = length(ngIPos.xz - ngTreeEye.xz) / max(ngTreeEye.w, 1e-3);
  float st = ngPassId == NG_PASS_REFLECTION ? ngTreePass.x : ngImpLod.x;
  float sw = ngPassId == NG_PASS_REFLECTION ? ngTreePass.y : ngImpLod.y;
  float keep = smoothstep(st - sw, st, ngD) * (1.0 - smoothstep(ngImpLod.z - ngImpLod.w, ngImpLod.z, ngD));
  /* 視線（描くカメラ。反射なら鏡映のカメラ）を木のローカルへ */
  vec3 toCam = cameraPosition - C;
  vec3 V = normalize(toCam);
  float rot = ngIRot.x;
  vec3 Vl = ngRotY(V, -rot);
  vec2 g = (ngHemiEnc(Vl) * 0.5 + 0.5) * (NG_IMP_N - 1.0);
  vec2 gi = clamp(floor(g), vec2(0.0), vec2(NG_IMP_N - 2.0));
  vec2 fr = clamp(g - gi, 0.0, 1.0);
  vec2 c0 = gi, c1, c2 = gi + 1.0;
  vec3 w;
  if (fr.x >= fr.y) { c1 = gi + vec2(1.0, 0.0); w = vec3(1.0 - fr.x, fr.x - fr.y, fr.y); }
  else { c1 = gi + vec2(0.0, 1.0); w = vec3(1.0 - fr.y, fr.y - fr.x, fr.x); }
  /* カメラへ向いた板（球の包み） */
  vec3 up = abs(V.y) > 0.98 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 rr = normalize(cross(up, V));
  vec3 uu = cross(V, rr);
  /* 横幅は水平の広がり（ngImpMeta.z）まで。真上から見るときは球の包み */
  float Rw = mix(max(meta.z * h, 0.2), R, abs(V.y));
  vec3 P = C + rr * (position.x * 2.0 * Rw) + uu * (position.y * 2.0 * R);
  vec3 Pl = ngRotY(P - C, -rot);
  vNgI0 = vec3(ngImpUV(c0, Pl, R), w.x);
  vNgI1 = vec3(ngImpUV(c1, Pl, R), w.y);
  vNgI2 = vec3(ngImpUV(c2, Pl, R), w.z);
  vNgIF = vec4(c0, c1);
  vNgIF2 = c2;
  vNgIInfo = vec4(ngIRot.y, keep, ngIRot.z, rot);
  vNgIH = vec2(ngIPos.y, h);
  transformed = keep < 0.003 ? vec3(0.0) : P;
}
`;

const IMP_FS_PARS = NG_HASH_GLSL + NG_SKYSPEC_GLSL + TREE_SKYSPEC + SHARED_FRAG + IMP_COMMON + /* glsl */ `
#define NG_IMP_N ${N}
uniform highp sampler2DArray ngImpAlb;
uniform highp sampler2DArray ngImpNrm;
uniform vec4 ngTreeMisc;
varying vec3 vNgI0; varying vec3 vNgI1; varying vec3 vNgI2;
varying vec4 vNgIF;
varying vec2 vNgIF2;
varying vec4 vNgIInfo;
varying vec2 vNgIH;
vec3 ngImpAt(vec2 cell, vec2 uv) { return vec3((cell + clamp(uv, 0.004, 0.996)) / NG_IMP_N, vNgIInfo.x); }
vec4 ngImpSample(highp sampler2DArray t) {
  return texture(t, ngImpAt(vNgIF.xy, vNgI0.xy)) * vNgI0.z + texture(t, ngImpAt(vNgIF.zw, vNgI1.xy)) * vNgI1.z
       + texture(t, ngImpAt(vNgIF2, vNgI2.xy)) * vNgI2.z;
}
`;

const IMP_FS_SURFACE = /* glsl */ `
vec4 ngIA = ngImpSample(ngImpAlb);
vec4 ngIN = ngImpSample(ngImpNrm);
{
  /* 焼き込みは √albedo（RGBA8 で暗い葉の段を残す）。被覆で割って縁を黒くしない */
  vec3 c = ngIA.rgb / max(ngIA.a, 0.02);
  c *= c;
  float r = vNgIInfo.z;
  c *= mix(vec3(0.90, 0.95, 1.06), vec3(1.10, 1.05, 0.88), r);
  c *= 0.86 + 0.28 * fract(r * 7.31);
  diffuseColor.rgb = c;
}
`;

const IMP_FS_ALPHA = /* glsl */ `
{
  /* mip で被覆が痩せないよう少し持ち上げる */
  float a = clamp(ngIA.a * 1.15, 0.0, 1.0);
  float keep = vNgIInfo.y;
  if (ngTreeMisc.x > 0.5) a *= keep;
  else a = keep > ngHash12(floor(gl_FragCoord.xy) + fract(vNgIInfo.z * 37.0) * 61.0) ? a : 0.0;
  diffuseColor.a = a;
}
`;

const IMP_FS_NORMAL = /* glsl */ `
vec3 ngINw;
{
  vec2 e = ngIN.xy / max(ngIA.a, 0.02);
  vec3 nl = vec3(e * 2.0 - 1.0, 0.0);
  /* 焼き込みの oct（[-1,1]²）を戻す */
  nl.z = 1.0 - abs(nl.x) - abs(nl.y);
  float t = max(-nl.z, 0.0);
  nl.x += nl.x >= 0.0 ? -t : t;
  nl.y += nl.y >= 0.0 ? -t : t;
  nl = normalize(nl.xzy);
  float c = cos(vNgIInfo.w), s = sin(vNgIInfo.w);
  ngINw = normalize(vec3(c * nl.x + s * nl.z, nl.y, -s * nl.x + c * nl.z));
  normal = normalize((viewMatrix * vec4(ngINw, 0.0)).xyz);
}
`;

const IMP_FS_ROUGH = /* glsl */ `
roughnessFactor = mix(0.62, 0.3, ngWet * 0.8);
`;

const IMP_FS_LIGHTS = /* glsl */ `
{
  vec3 Vw = normalize(cameraPosition - vNgWorld);
  float thin = ngIN.z / max(ngIA.a, 0.02);
  float ao = clamp(ngIN.w / max(ngIA.a, 0.02), 0.0, 1.0);
  float self = mix(0.35, 1.0, ao);
  float below = 1.0 - smoothstep(0.45, 1.0, (vNgWorld.y - vNgIH.x) / max(vNgIH.y, 1.0));
  vec4 ngCan = ngCanopyAt2(vNgWorld.xz);
  vec3 can = ngCanopyAmbient(ngCan, below);
  reflectedLight.directDiffuse *= self;
  reflectedLight.directSpecular *= self * 0.35;
  vec3 ngTr = ngTreeTransmit(material.diffuseColor, ngINw, Vw, thin, ngKeyVis * ngNearVis * self, 1.0 - ao);
  reflectedLight.directDiffuse += ngTr;
  vec3 R = reflect(-Vw, ngINw);
  float nv = clamp(dot(ngINw, Vw), 0.0, 1.0);
  reflectedLight.indirectSpecular += ngTreeSkySpec(R, nv, roughnessFactor, 0.03, max(ngCan.r, 0.6)) * ao * (0.35 + 0.65 * ngWet) * can;
  reflectedLight.indirectDiffuse *= mix(0.45, 1.0, ao) * can;
  if (ngTreeMisc.w > 0.5) ngTreeDbg(reflectedLight, ngTr, ngTreeMisc.w);
}
`;

export const IMP_HOOKS = {
  vertex: { pars: IMP_VS_PARS, begin: IMP_VS_BEGIN },
  fragment: { pars: IMP_FS_PARS, surface: IMP_FS_SURFACE, alpha: IMP_FS_ALPHA, normal: IMP_FS_NORMAL, rough: IMP_FS_ROUGH, lights: IMP_FS_LIGHTS },
};

/* ---------------------------------------------------------------- インポスターの撮影（ShaderMaterial、焼いたら捨てる） */

export const IMP_BAKE_VS = /* glsl */ `// ngmod:trees:trees-imp-bake
#define NG_POS_RANGE ${f(POS_RANGE)}
${IMP_COMMON}
#define NG_IMP_N ${N}
attribute vec2 ngNrm;
attribute vec2 ngUv;
attribute vec4 ngExtra;
uniform vec4 ngBakeC;      // xyz = 中心（正規化）、w = 半径
varying vec2 vNgTUv;
varying vec4 vNgTInfo;
varying vec3 vNgN;
varying vec2 vNgQ;
vec3 ngTreeOct(vec2 e) {
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
void main() {
  /* 64 個のインスタンス = 8×8 のフレーム。各フレームの正射影で画面の升へ */
  float id = float(gl_InstanceID);
  vec2 cell = vec2(mod(id, NG_IMP_N), floor(id / NG_IMP_N));
  vec3 d = ngHemiDec(cell / (NG_IMP_N - 1.0) * 2.0 - 1.0);
  vec3 r, u;
  ngImpBasis(d, r, u);
  vec3 P = position * NG_POS_RANGE - ngBakeC.xyz;
  vec2 q = vec2(dot(P, r), dot(P, u)) / ngBakeC.w;            // -1..1
  float z = -dot(P, d) / ngBakeC.w;                             // 手前ほど小さい
  vec2 ndc = ((cell + 0.5 + 0.5 * q) / NG_IMP_N) * 2.0 - 1.0;
  gl_Position = vec4(ndc, clamp(z, -1.0, 1.0) * 0.98, 1.0);
  vNgQ = q;
  float fl = floor(ngExtra.y * 255.0 + 0.5);
  float leaf = step(127.5, fl);
  vNgTUv = ngUv;
  vNgTInfo = vec4(leaf, fl - leaf * 128.0, ngExtra.x, ngExtra.z);
  vNgN = ngTreeOct(ngNrm);
}
`;

export const IMP_BAKE_FS = /* glsl */ `// ngmod:trees:trees-imp-bake
#define NG_UV_U ${f(UV_U_RANGE)}
#define NG_UV_V ${f(UV_V_RANGE)}
uniform highp sampler2DArray ngBarkAlb;
uniform sampler2D ngLeafAlb;
uniform sampler2D ngLeafNrm;
uniform float ngMode;
uniform float ngHref;
uniform vec2 ngLeafSize;
varying vec2 vNgTUv;
varying vec4 vNgTInfo;
varying vec3 vNgN;
varying vec2 vNgQ;
vec2 ngLeafUV(vec2 uv, float layer) {
  vec2 grid = vec2(${f(LEAF_GRID[0])}, ${f(LEAF_GRID[1])});
  vec2 cell = vec2(mod(layer, grid.x), floor(layer / grid.x));
  return (cell + ${f(LEAF_PAD)} + clamp(uv, 0.0, 1.0) * (1.0 - 2.0 * ${f(LEAF_PAD)})) / grid;
}
vec2 ngOctE(vec3 n) {
  vec2 p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) p = (1.0 - abs(p.yx)) * vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
  return p * 0.5 + 0.5;
}
void main() {
  /* 枠の外（隣のフレームへはみ出す外れの頂点）は描かない */
  if (max(abs(vNgQ.x), abs(vNgQ.y)) > 0.985) discard;
  vec4 A; float thin = 0.0;
  if (vNgTInfo.x > 0.5) {
    vec2 luv = ngLeafUV(vNgTUv, vNgTInfo.y);
    A = texture(ngLeafAlb, luv);
    thin = texture(ngLeafNrm, luv).b;
    vec2 t = luv * ngLeafSize;
    float lod = 0.5 * log2(max(max(dot(dFdx(t), dFdx(t)), dot(dFdy(t), dFdy(t))), 1e-8));
    if (A.a * (1.0 + max(lod, 0.0) * 0.28) < 0.5) discard;
  } else {
    vec2 buv = vec2(vNgTUv.x * NG_UV_U, vNgTUv.y * NG_UV_V * ngHref);
    A = vec4(texture(ngBarkAlb, vec3(buv, vNgTInfo.y)).rgb, 1.0);
  }
  vec3 n = normalize(vNgN);
  if (vNgTInfo.x < 0.5 && !gl_FrontFacing) n = -n;
  if (ngMode < 0.5) gl_FragColor = vec4(sqrt(max(A.rgb, 0.0)), 1.0);
  /* 法線は木のローカル（y 上）を xzy の順で oct に（z が上になる向きで詰める） */
  else gl_FragColor = vec4(ngOctE(n.xzy), thin, clamp(vNgTInfo.z * (1.0 - 0.5 * vNgTInfo.w), 0.0, 1.0));
}
`;

/* ---------------------------------------------------------------- 3. 樹冠シェル */

const SHELL_VS_PARS = NG_HEIGHTFIELD_GLSL + /* glsl */ `
uniform sampler2D ngCanopyMap;   // r = 密度、g = 平均樹高 / 40m、b = 針葉の割合、a = 色むら（±512m）
uniform vec4 ngTreeEye;
uniform vec4 ngShellLod;          // x = 出始め、y = 幅
varying vec4 vNgSh;               // x = 密度、y = 針葉、z = 残す割合、w = 色むら
`;

const SHELL_VS_BEGIN = /* glsl */ `
{
  vec2 xz = transformed.xz;
  vec4 cm = texture2D(ngCanopyMap, (xz + 512.0) / 1024.0);
  float hT = ngTerrainH(xz);
  float dens = cm.r;
  /* 樹冠の天井：平均の樹高 × 0.82（樹冠の上の面）。疎らな所は沈めて地面へ馴染ませる */
  transformed.y = hT + cm.g * 40.0 * 0.82 * smoothstep(0.05, 0.6, dens) - 1.5;
  float ngD = length(xz - ngTreeEye.xz) / max(ngTreeEye.w, 1e-3);
  float keep = smoothstep(ngShellLod.x, ngShellLod.x + ngShellLod.y, ngD);
  vNgSh = vec4(dens, cm.b, keep, cm.a);
}
`;

const SHELL_FS_PARS = NG_NOISE_GLSL + SHARED_FRAG + /* glsl */ `
uniform vec4 ngTreeMisc;
varying vec4 vNgSh;
float ngShellH(vec2 p) {
  /* 樹冠の凹凸：6m と 2.5m のドーム（値ノイズ） */
  return ngVNoise2(p / 6.0) * 0.7 + ngVNoise2(p / 2.5 + 3.1) * 0.3;
}
`;

const SHELL_FS_SURFACE = /* glsl */ `
float ngShB = ngShellH(vNgWorld.xz);
{
  vec3 con = vec3(0.026, 0.047, 0.028), brd = vec3(0.060, 0.094, 0.030);
  vec3 c = mix(brd, con, vNgSh.y);
  c *= 0.75 + 0.5 * vNgSh.w;
  c *= mix(0.55, 1.05, ngShB);
  diffuseColor.rgb = c;
}
`;

const SHELL_FS_ALPHA = /* glsl */ `
{
  float a = smoothstep(0.18, 0.42, vNgSh.x + (ngShB - 0.5) * 0.25);
  float keep = vNgSh.z;
  if (ngTreeMisc.x > 0.5 && ngPassId != NG_PASS_SHADOW) a *= keep;
  else a = keep > ngHash12(floor(gl_FragCoord.xy) + 7.0) ? a : 0.0;
  diffuseColor.a = a;
}
`;

const SHELL_FS_NORMAL = /* glsl */ `
{
  vec2 p = vNgWorld.xz;
  float e = 0.6;
  vec3 g = vec3(ngShellH(p + vec2(e, 0.0)) - ngShellH(p - vec2(e, 0.0)), 0.0, ngShellH(p + vec2(0.0, e)) - ngShellH(p - vec2(0.0, e)));
  vec3 nW = normalize(inverseTransformDirection(normal, viewMatrix) - g * 2.2);
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
`;

const SHELL_FS_LIGHTS = /* glsl */ `
{
  vec3 Vw = normalize(cameraPosition - vNgWorld);
  vec3 Nw = inverseTransformDirection(normal, viewMatrix);
  float self = mix(0.4, 1.0, ngShB);
  reflectedLight.directDiffuse *= self;
  vec3 ngTr = ngTreeTransmit(material.diffuseColor, Nw, Vw, 0.7, ngKeyVis * ngNearVis * self, 0.5);
  reflectedLight.directDiffuse += ngTr;
  reflectedLight.indirectDiffuse *= mix(0.5, 1.0, ngShB);
  if (ngTreeMisc.w > 0.5) ngTreeDbg(reflectedLight, ngTr, ngTreeMisc.w);
}
`;

export const SHELL_HOOKS = {
  vertex: { pars: SHELL_VS_PARS, begin: SHELL_VS_BEGIN },
  fragment: { pars: SHELL_FS_PARS, surface: SHELL_FS_SURFACE, alpha: SHELL_FS_ALPHA, normal: SHELL_FS_NORMAL, lights: SHELL_FS_LIGHTS },
};
