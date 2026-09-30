/* ===========================================================
   CAUSTICS_GLSL の本体（underwater モジュールが持つ。src/shaders.js が再 export）
   -----------------------------------------------------------
   グレーボックスの解析版：焼き込み（uCaustTex）が来るまでは、2 層の Worley の
   境界の明線を波の傾き（csWaveD）で歪めて網目にする。焼き込み後も同じ口のまま
   uCaustTex（sampler2DArray：時刻のフレームが層）の値を掛ける。
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

vec2 csHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
/* Worley の 2 番目 − 1 番目の距離：セルの境界で 0 になる（網目の明線） */
float csCell(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 h = csHash2(i + g);
    vec2 o = 0.5 + 0.35 * sin(t * (0.6 + 0.5 * h) + 6.2831 * h);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}

vec3 causticLight(vec3 worldPos, vec3 viewNormal) {
  if (uCaustStrength < 0.001 || worldPos.y > -0.02) return vec3(0.0);
  float depth = -worldPos.y;
  /* 湖底の点を照らす光は太陽と反対側の水面から入る。水中の傾きはスネルで浅い */
  vec3 sd = normalize(uCaustSunDir);
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
  float t = uCaustTime;
  float a = exp(-csCell(q * uCaustScale.x * 1.6 + vec2(0.011, 0.007) * t, t) * 9.0 / blur);
  float b = exp(-csCell(q * uCaustScale.y * 1.6 + vec2(-0.008, 0.012) * t + 3.7, t * 1.3) * 9.0 / blur);
  float tex = texture(uCaustTex, vec3(q * uCaustScale.x, 0.0)).r;
  float net = (a * uCaustMixW.x + b * uCaustMixW.y + a * b * uCaustMixW.z) * tex;
  net = min(pow(max(net * uCaustShape.x, 0.0), uCaustShape.y), uCaustRange.x) / blur;
  float viewDist = length(worldPos - cameraPosition);
  float fade = 1.0 - smoothstep(uCaustDist.x, uCaustDist.y, viewDist);
  fade *= smoothstep(uCaustDepth.x, uCaustDepth.y, depth) * (1.0 - smoothstep(uCaustFar.x, uCaustFar.y, depth));
  /* 上を向いた面ほど強い（水際の岩の側面を光らせない） */
  vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 nV = normalize(viewNormal);
  fade *= smoothstep(0.15, 0.72, dot(nV, upView));
  /* 夜（月）・雨・雲で弱め、低い太陽は水面で跳ね返されて届かない */
  fade *= mix(1.0, 0.30, uCaustNight) * (1.0 - uCaustRain * 0.72) * (1.0 - uCaustCloud * 0.62);
  fade *= smoothstep(-0.05, 0.22, sd.y) * mix(0.55, 1.0, smoothstep(0.10, 0.75, sd.y));
  vec3 sunView = normalize((viewMatrix * vec4(sd, 0.0)).xyz);
  fade *= smoothstep(0.02, 0.38, max(dot(nV, sunView), 0.0));
  fade *= uCaustStrength;
  return vec3(0.62, 0.88, 0.95) * net * fade * uCaustRange.y;
}
`;
