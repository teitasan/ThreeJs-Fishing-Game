/* ===========================================================
   groundcover の計算パス（株の «表»）
   -----------------------------------------------------------
   テクセル 1 つ = 株 1 つ。毎フレーム prepare で全画面 1 回（high 36k 株 × 3 帯 ≈ 0.05ms）。
   ここで株ごとの重い処理（地形の高さ・地面の種類・根元の色・風・踏み倒し・遠くの山の影・視錐台）を
   «株に 1 回» だけ済ませ、頂点シェーダは texelFetch 3 回で読む（頂点に属性なし・インスタンスの属性なし）。
   RT は RGBA32F の 1 枚で、横に 3 つの帯（x = 0..255 / 256..511 / 512..767）。MRT を使わない
   （ngShaderMaterial の gl_FragColor のまま。各画素は同じ株を計算して自分の帯の値だけを出す。頂点のサンプラーも 1 枚）：
     A = (x, y, z, 大きさ)              大きさ 0 = この株は無い（頂点で退化）
     B = (根元の色 rgb（線形）, 種類 + 0.9·縮み) 種類は GC_KIND。縮み 0..1（距離の帯で消える途中）
     C = (曲げ x, 曲げ z, 突風 0..1, floor(空の見え·255) + 0.99·山の影)
   リングの «窓»：視錐台の足跡の外接矩形（CPU、ngGcReg4 = (ox, oz, w, h)）だけを並べる（描く株の数 = w·h）
   =========================================================== */
import { NG_FRAME_GLSL } from '../core/frame.js';
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { NG_WIND_GLSL } from '../core/glsl/wind.glsl.js';
import { NG_SHADOW_GLSL } from '../core/glsl/shadow.glsl.js';
import { NG_CLOUD_GLSL } from '../core/glsl/medium.glsl.js';
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { GC_TEX_W } from './quality.js';

export const GC_MAX_REGIONS = 6;
export const GC_TRAMPLE_N = 8;

/**
 * terrain の coverRules から «層の重み» の関数 ngGcWeights を作る。
 * coverRules の ngGroundKind の本体（ngTerrWeights の呼び出し）を写して重みを返す関数にする。
 * 写せない（terrain がスタブ・形が変わった）ときは ngGroundKind の片側 1 と ngCover の既定へ戻す
 * @param {string} cover services.terrain.coverRules
 * @returns {{ glsl: string, mode: 'weights'|'kind'|'cover' }}
 */
export function gcWeightsGLSL(cover) {
  const src = typeof cover === 'string' ? cover : '';
  const m = src.match(/float ngGroundKind\(vec3 p\) \{([\s\S]*?wA, wB\);)/);
  if (m && src.includes('void ngTerrWeights(') && /vec4 wA, wB;/.test(m[1])) {
    const body = m[1].replace(/vec4 wA, wB;/, '');
    return {
      mode: 'weights',
      glsl: `${src}\nvoid ngGcWeights(vec3 p, out vec4 wA, out vec4 wB) {${body}\n}\n`,
    };
  }
  const hasKind = /float ngGroundKind\(vec3 p\)/.test(src) && !/return 0\.0; \}\s*$/.test(src.trim() + ' ');
  return {
    mode: hasKind ? 'kind' : 'cover',
    glsl: `${src || 'float ngGroundKind(vec3 p) { return 0.0; }\n'}
void ngGcWeights(vec3 p, out vec4 wA, out vec4 wB) {
  float k = ngGroundKind(p);
  wA = vec4(equal(vec4(k), vec4(1.0, 2.0, 3.0, 4.0)));
  wB = vec4(equal(vec4(k), vec4(5.0, 6.0, 7.0, 8.0)));
  if (k < 0.5) {
    /* 種類が分からない（terrain がスタブ）：heightfield の被覆の既定（草, 笹, シダ, 花） */
    vec4 c = ngCover(p.xz);
    wA = vec4(c.y + 0.5 * c.z, 0.5 * c.z, c.x, 0.0);
    wB = vec4(0.0);
    if (p.y < 0.05) wB.x = 1.0;
  }
}
`,
  };
}

export const GC_CLUMP_VS = /* glsl */ `// ngmod:groundcover:gc-clump
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * 計算パスの断片シェーダ
 * @param {string} weightsGLSL gcWeightsGLSL(...).glsl
 */
export function gcClumpFS(weightsGLSL) {
  return /* glsl */ `// ngmod:groundcover:gc-clump
precision highp float;
precision highp int;
precision highp sampler2D;
${NG_FRAME_GLSL}
${NG_NOISE_GLSL}
${NG_HEIGHTFIELD_GLSL}
${weightsGLSL}
${NG_WIND_GLSL}
${NG_CLOUD_GLSL}
${NG_SHADOW_GLSL}
#define NG_GC_W ${GC_TEX_W}
#define NG_GC_MAXR ${GC_MAX_REGIONS}
#define NG_GC_NTR ${GC_TRAMPLE_N}
uniform sampler2D ngGcFarAlb;
uniform vec4 ngGcReg[NG_GC_MAXR];    // x = 最初の行, y = 行数, z = セル m, w = 半数 n
uniform vec4 ngGcReg2[NG_GC_MAXR];   // x = r0, y = r1, z = 外の帯, w = 内の帯
uniform vec4 ngGcReg3[NG_GC_MAXR];   // x = 系（0 草・1 笹シダ・2 小物）, y = 段の密度, z = 型板（0 近・1 遠）
uniform vec4 ngGcReg4[NG_GC_MAXR];   // 窓：x = ox, y = oz（セルの番号）, z = 幅 w, w = 高さ h
uniform float ngGcNReg;
uniform vec3 ngGcCam;
uniform vec4 ngGcPlanes[6];          // 視錐台の面（法線 xyz、距離 w。three の Frustum）
uniform vec4 ngGcTrample[NG_GC_NTR]; // xy = 踏んだ所、z = 半径、w = 強さ 0..1
uniform float ngGcLod;
vec4 ngOutA, ngOutB, ngOutC;

bool ngGcVisible(vec3 c, float r) {
  for (int i = 0; i < 6; i++) if (dot(ngGcPlanes[i].xyz, c) + ngGcPlanes[i].w < -r) return false;
  return true;
}

void ngGcCull() { ngOutA = vec4(0.0); ngOutB = vec4(0.0); ngOutC = vec4(0.0); }

void ngGcMain(ivec2 px);
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  int band = q.x / NG_GC_W;
  ngGcMain(ivec2(q.x - band * NG_GC_W, q.y));
  gl_FragColor = band == 0 ? ngOutA : (band == 1 ? ngOutB : ngOutC);
}

void ngGcMain(ivec2 px) {
  float row = float(px.y);
  int k = -1;
  for (int j = 0; j < NG_GC_MAXR; j++) {
    if (float(j) >= ngGcNReg) break;
    if (row >= ngGcReg[j].x && row < ngGcReg[j].x + ngGcReg[j].y) k = j;
  }
  if (k < 0) { ngGcCull(); return; }
  vec4 R = ngGcReg[k], R2 = ngGcReg2[k], R3 = ngGcReg3[k], R4 = ngGcReg4[k];
  float c = R.z;
  int n = int(R.w + 0.5);
  int ww = max(int(R4.z + 0.5), 1);
  int i = (px.y - int(R.x + 0.5)) * NG_GC_W + px.x;
  if (i >= ww * int(R4.w + 0.5)) { ngGcCull(); return; }
  float sys = R3.x;
  vec2 cell = floor(ngGcCam.xz / c) + vec2(float(int(R4.x + 0.5) + i % ww - n), float(int(R4.y + 0.5) + i / ww - n));
  vec2 so = vec2(sys * 1013.0 + 17.0, sys * 577.0 + 3.0);
  vec2 hj = ngHash22(cell + so);
  vec2 xz = (cell + 0.12 + 0.76 * hj) * c;
  /* 距離の帯（LOD 倍率を掛ける）：株を縮めて消す。hz の小さい株ほど遠くまで残る */
  float d = distance(xz, ngGcCam.xz) / max(ngGcLod, 0.25);
  float pres = (1.0 - smoothstep(R2.y - R2.z, R2.y, d)) * (R2.w > 0.0 ? smoothstep(R2.x, R2.x + R2.w, d) : 1.0);
  if (pres <= 0.0) { ngGcCull(); return; }
  float hz = ngHash12(cell * 1.7 + so * 0.31 + 3.1);
  float sc = smoothstep(hz * 0.8, hz * 0.8 + 0.2, pres);
  if (sc <= 0.004) { ngGcCull(); return; }
  float y = ngTerrainH(xz);
  /* 視錐台（株の背の高さの球）。主のパスにしか描かない（反射・影に出さない）ので主のカメラで切ってよい */
  float rad = sys < 0.5 ? 0.7 : (sys < 1.5 ? 1.1 : 0.5);
  if (!ngGcVisible(vec3(xz.x, y + rad * 0.5, xz.y), rad + c)) { ngGcCull(); return; }

  vec4 wA, wB;
  ngGcWeights(vec3(xz.x, y, xz.y), wA, wB);
  vec2 cn = ngCanopyAt(xz);
  float sd = ngShoreD(xz);
  vec3 Ng = ngTerrainN(xz);
  float open01 = 1.0 - smoothstep(0.25, 0.75, cn.x);
  float slope = sqrt(max(1.0 - Ng.y * Ng.y, 0.0)) / max(Ng.y, 0.05);
  float nPatch = ngVNoise2(xz * 0.21 + 5.0);
  float nTall = ngVNoise2(xz * 0.083 + 1.7);
  float u = ngHash12(cell * 0.37 + so * 0.13 + 11.0);
  float tierCut = ngHash12(cell * 2.31 + so * 0.07 + 29.0);
  float kind = 0.0, H = 0.0;
  bool land = y > 0.05 && sd > 0.25;
  if (sys < 0.5) {
    /* 草（スゲ・イネ科）：草地が主。林床・苔・浜には疎らに。汀線の 0.25m までは無し */
    float g = wA.z + (wA.x * 0.20 + wA.y * 0.22) * open01 + (wA.x + wA.y) * 0.07 + wA.w * 0.22 + wB.x * 0.16 + wB.y * 0.35 + wB.w * 0.10;
    g *= mix(0.55, 1.18, nPatch) * (1.0 - smoothstep(0.7, 1.2, slope));
    if (!land || u >= g) { ngGcCull(); return; }
    kind = 0.0;
    float tall = wA.z * mix(0.65, 1.25, nTall) + (wA.x + wA.y) * 0.55 + wB.y * 0.85;
    H = mix(0.12, 0.50, clamp(tall, 0.0, 1.0)) * mix(1.0, 0.45, wB.w) * mix(0.8, 1.15, hj.x);
  } else if (sys < 1.5) {
    /* クマザサ（林床の群落・汀から 6m より奥）とシダ（沢筋・水辺・苔の上） */
    float colony = smoothstep(0.30, 0.50, ngVNoise2(xz * (1.0 / 11.0) + 1.3) + 0.15 * (nPatch - 0.5));
    float sasa = wA.x * colony * mix(0.55, 1.0, smoothstep(0.1, 0.5, cn.x)) * smoothstep(5.0, 12.0, sd) * (1.0 - smoothstep(0.75, 1.1, slope));
    float wet = 1.0 - smoothstep(3.0, 18.0, sd);
    float fernPatch = smoothstep(0.30, 0.58, ngVNoise2(xz * (1.0 / 6.5) + 9.1));
    float fern = (wA.y * 0.9 + wA.x * 0.45 * mix(0.35, 1.0, wet) + wA.z * 0.22 * wet) * fernPatch;
    if (!land || tierCut >= R3.y) { ngGcCull(); return; }
    if (u < sasa * 0.95) { kind = 1.0; H = mix(0.42, 0.85, colony) * mix(0.85, 1.15, hj.y); }
    else if (u < sasa * 0.95 + fern * 0.8) { kind = 2.0; H = mix(0.32, 0.72, max(wet, wA.y)) * mix(0.8, 1.2, hj.x); }
    else { ngGcCull(); return; }
  } else {
    /* 小物：玉石の浜の小石（岩の肌）・落ち枝・落葉・苔の塊 */
    float peb = wA.w * 0.95 + wB.z * 0.45 + wB.x * 0.22 + wB.y * 0.06;
    float twig = wA.x * 0.08;
    float lit = wA.x * mix(0.18, 0.42, cn.x);
    float moss = wA.y * 0.40 + wA.x * 0.012;
    if (y < -0.18 || tierCut >= R3.y) { ngGcCull(); return; }
    if (u < peb) { kind = 3.0; H = mix(0.035, 0.13, pow(hj.y, 1.8)) * mix(0.8, 1.25, wA.w); }
    else if (u < peb + twig && land) { kind = 4.0; H = mix(0.18, 0.62, hj.y); }
    else if (u < peb + twig + lit && land) { kind = 6.0; H = mix(0.035, 0.07, hj.y); }
    else if (u < peb + twig + lit + moss && land) { kind = 5.0; H = mix(0.12, 0.34, hj.x); }
    else { ngGcCull(); return; }
  }

  /* 根元の色 = 地形の遠景の色（farAlbedo：同じ重み × 層の平均色 × マクロの色むら）。
     樹冠の混ざった所（a 大）は林床の色へ寄せる（樹冠の色が地面の色に化けない） */
  vec4 fa = texture(ngGcFarAlb, ngFarMapUV(xz));
  vec3 root = mix(fa.rgb, vec3(0.105, 0.082, 0.052) * (0.85 + 0.3 * nPatch), smoothstep(0.3, 0.85, fa.a) * 0.8);

  /* 風：ngWindAt（38m と 13m の斑が風下へ流れる）。静かな傾き + 突風の波 + 小さな揺れ */
  vec4 W = ngWindAt(xz);
  float sp = W.z;
  float ph = dot(xz, W.xy) * 0.42 - ngEnvTime * (1.4 + 0.22 * sp) + hz * 6.2831;
  float stiff = sys < 0.5 ? 1.0 : (sys < 1.5 ? 0.45 : 0.0);
  float lean = (0.035 * sp + 0.010 * sp * sp) * (0.55 + 0.9 * W.w);
  float osc = (0.5 + 0.5 * sin(ph)) * (0.25 + 0.75 * W.w) * (0.02 + 0.03 * sp);
  vec2 perp = vec2(-W.y, W.x);
  vec2 bend = (W.xy * (lean + osc) + perp * sin(ph * 1.7 + 1.3) * 0.012 * sp) * stiff;
  /* 踏み倒し：踏んだ所から外へ寝かせる（数秒で起き上がる） */
  float tr = 0.0;
  for (int t = 0; t < NG_GC_NTR; t++) {
    vec4 T = ngGcTrample[t];
    if (T.w <= 0.0) continue;
    vec2 dv = xz - T.xy;
    float dl = length(dv);
    float kk = T.w * (1.0 - smoothstep(T.z * 0.35, T.z, dl));
    if (kk > tr) { tr = kk; bend = mix(bend, dv / max(dl, 1e-3) * 1.25, kk); }
  }
  float hf = ngHfShadowFar(vec3(xz.x, y + 0.3, xz.y));
  float sky = 1.0 - 0.62 * clamp(cn.x, 0.0, 1.0);
  ngOutA = vec4(xz.x, y, xz.y, H * sc);
  ngOutB = vec4(max(root, vec3(0.0)), kind + 0.9 * clamp(sc, 0.0, 1.0));
  ngOutC = vec4(bend, max(W.w, tr * 2.0), floor(clamp(sky, 0.0, 1.0) * 255.0) + 0.99 * clamp(hf, 0.0, 1.0));
}
`;
}
