/* ===========================================================
   CAUSTICS_GLSL の本体（underwater モジュールが持つ。src/shaders.js が再 export）
   -----------------------------------------------------------
   グレーボックス：網目は underwater のスタブが起動時に焼く周期タイル（uCaustTex、
   sampler2DArray の層 = 時刻のフレーム、R = 粗い網 A、G = 細かい網 B。どちらも鋭さ 1 の
   exp(−9·(F2−F1))）を 2 か所 × 前後のフレームで 4 回読む。深さのぼけは pow(v, 1/blur)。
   焼き込みの前（1 層のプレースホルダ）は 0（網目の代わりの一様な光を出さない）。
   網目の計算より先に «弱める係数» を全部掛け、0 なら何も読まずに帰る（遠景・深場・夜・
   下向きの面で断片の手数を使わない）。
   契約（ARCHITECTURE §5.3、CONTRACT §4.5）：
     - vec3 causticLight(vec3 worldPos, vec3 viewNormal)（加算の放射輝度）
     - worldPos.y > -0.02 は 0（水上の魚・釣り人には出さない）
     - 16 個の uCaust* を宣言する。サンプラーは sampler2DArray だけ（魚の GLSL3 で動く）
     - 魚は #include <common> の直後にこれを入れる（ngFrame はまだ宣言されていない位置）ので、
       ng のフレームやライブラリの関数には頼らない。cs 接頭辞はこの文字列の中だけ
   =========================================================== */
import { waveGLSL } from '../../waveField.js?v=20260828-lakescale1';

/** 焼き込みが来るまでの uCaustTex の層数（1×1×1 の白） */
export const CAUSTICS_PLACEHOLDER_LAYERS = 1;

/** 焼くタイルの形（underwater のスタブと GLSL が共有）：一辺の画素、時刻のフレーム数、網 A / B のタイル当たりのセル数、一巡の秒。
 *  タイル 1 枚の大きさは A = 1/uCaustScale.x m、B = 1/uCaustScale.y m */
export const CAUSTICS_TILE = Object.freeze({ size: 256, frames: 16, cellsA: 6, cellsB: 10, loopSec: 8 });

/** vec3 causticLight(vec3 worldPos, vec3 viewNormal) と 16 個の uCaust*（魚・湖底・水中の小物が共有） */
export const CAUSTICS_GLSL = /* glsl */ `
uniform float uCaustTime;
uniform vec3 uCaustSunDir;
uniform float uCaustNight;
uniform float uCaustRain;
uniform float uCaustCloud;
uniform float uCaustStrength;
uniform highp sampler2DArray uCaustTex;
uniform vec2 uCaustScale;    // 2 層の空間スケール（1/m）
uniform vec2 uCaustShape;    // x = ゲイン, y = 立ち上がりの指数
uniform vec2 uCaustRange;    // x = 明線の上限, y = 最終強度
uniform vec2 uCaustDepth;    // 水深フェード（開始, 終了）
uniform vec2 uCaustDist;     // 視距離フェード（開始, 終了）
uniform vec2 uCaustFar;      // 深すぎる所で消すフェード（開始, 終了）
uniform vec2 uCaustWarp;     // x = 波の傾きで歪める量, y = 有効深度の上限(m)
uniform float uCaustMag;     // 深さ 1m あたりに網目をぼかす量
uniform vec3 uCaustMixW;     // 2 層の合成比（A, B, A*B）

${waveGLSL({ prefix: 'cs', slim: true })}

/* 焼いたタイルの (A, B) を時刻 ph（一巡 = 1）で前後のフレームから補間 */
vec2 csTile(vec2 uv, float ph, float layers) {
  float f = fract(ph) * layers;
  float l0 = floor(f);
  float l1 = l0 + 1.0 >= layers ? 0.0 : l0 + 1.0;
  return mix(texture(uCaustTex, vec3(uv, l0)).rg, texture(uCaustTex, vec3(uv, l1)).rg, f - l0);
}

vec3 causticLight(vec3 worldPos, vec3 viewNormal) {
  if (uCaustStrength < 0.001 || worldPos.y > -0.02) return vec3(0.0);
  float layers = float(textureSize(uCaustTex, 0).z);
  if (layers < 1.5) return vec3(0.0);
  float depth = -worldPos.y;
  vec3 sd = normalize(uCaustSunDir);
  /* 弱める係数を先に：視距離・水深・面の向き・夜・雨・雲・太陽の高さ */
  float viewDist = length(worldPos - cameraPosition);
  float fade = 1.0 - smoothstep(uCaustDist.x, uCaustDist.y, viewDist);
  fade *= smoothstep(uCaustDepth.x, uCaustDepth.y, depth) * (1.0 - smoothstep(uCaustFar.x, uCaustFar.y, depth));
  /* 上を向いた面ほど強い（水際の岩の側面を光らせない） */
  vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 nV = normalize(viewNormal);
  fade *= smoothstep(0.15, 0.72, dot(nV, upView));
  fade *= mix(1.0, 0.30, uCaustNight) * (1.0 - uCaustRain * 0.72) * (1.0 - uCaustCloud * 0.62);
  /* 低い太陽は水面で跳ね返されて届かない */
  fade *= smoothstep(-0.05, 0.22, sd.y) * mix(0.55, 1.0, smoothstep(0.10, 0.75, sd.y));
  vec3 sunView = normalize((viewMatrix * vec4(sd, 0.0)).xyz);
  fade *= smoothstep(0.02, 0.38, max(dot(nV, sunView), 0.0));
  fade *= uCaustStrength;
  if (fade < 1e-3) return vec3(0.0);
  /* 湖底の点を照らす光は太陽と反対側の水面から入る。水中の傾きはスネルで浅い */
  float ca = max(sd.y, 0.08);
  float sa = sqrt(max(0.0, 1.0 - ca * ca));
  float sw = sa / 1.333;
  float tw = sw / max(sqrt(max(0.0, 1.0 - sw * sw)), 1e-3);
  float sl = length(sd.xz);
  vec2 sunN = sl > 1e-4 ? sd.xz / sl : vec2(0.0, 1.0);
  vec2 surf = worldPos.xz + sunN * depth * tw;
  vec2 q = surf + csWaveD(surf, uCaustTime) * (min(depth, uCaustWarp.y) * uCaustWarp.x + 0.6);
  /* 深いほど焦点がぼける：明線の幅を広げ、コントラストを落とす */
  float blur = 1.0 + depth * uCaustMag * 4.0;
  float t = uCaustTime / ${CAUSTICS_TILE.loopSec.toFixed(1)};
  /* タイル 1 枚 = 1/uCaustScale m（A 9.5m に 6 セル ≈1.6m、B 6m に 10 セル ≈0.6m） */
  float a = csTile(q * uCaustScale.x + vec2(0.0018, 0.0012) * uCaustTime, t, layers).r;
  float b = csTile(q * uCaustScale.y + vec2(-0.0013, 0.0020) * uCaustTime + 0.37, t * 1.3, layers).g;
  a = pow(max(a, 1e-4), 1.0 / blur);
  b = pow(max(b, 1e-4), 1.0 / blur);
  float net = a * uCaustMixW.x + b * uCaustMixW.y + a * b * uCaustMixW.z;
  net = min(pow(max(net * uCaustShape.x, 0.0), uCaustShape.y), uCaustRange.x) / blur;
  return vec3(0.62, 0.88, 0.95) * net * fade * uCaustRange.y;
}
`;
