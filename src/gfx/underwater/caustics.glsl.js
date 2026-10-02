/* ===========================================================
   CAUSTICS_GLSL の本体（underwater モジュールが持つ。src/shaders.js が再 export）
   -----------------------------------------------------------
   本番（underwater モジュール、uCaustShape.x ≥ 1.5）：
     uCaustTex の層 = 時刻のフレーム、rgb = 周期的な細かい波の場のヘッセ行列 (hxx, hyy, hxy)
     （0.5 中心、±uCaustScale.y [1/m] を 0..1 へ。spectrum.js）。受け手の点 P の明るさは
       I = 1 / |det(I₂ + D·H)|、D = 光路長 × (1 − 1/n)
     （面積比 = Evan Wallace 式の «屈折した格子の面積比» の解析形）。n は RGB で変える（分散）。
     - P から屈折した太陽の向きへ水面まで遡った点でタイルを読む（Snell。湖底の網目は太陽と反対側の水面から来る）
     - 長い波（waveField の csWaveD）の傾きで読む位置を歪める（網目が大きくうねって流れる）
     - タイルは 2 回読む：もう 1 回は回転 115°・縮尺 0.79。ヘッセ行列は線形なので
       (H1 + H2)/√2 は «2 つの波の場の和» の正しいヘッセ行列 = 繰り返しの見えない 1 つの網目
     - 時刻のフレームの線形補間もヘッセ行列（波の場）で行う → 明線が二重写しにならない
     - 深さで mip を上げる（焦点のぼけ・遠くのエイリアス）。浅い所は D が小さいので自然に網目が弱い
     - 面積比の平均は 1 にならない（焦点の先で折り返しを数える）ので m(x) = 1 + c·x²·e^(−0.35x²)
       （x = D·|H|rms、c = uCaustMag）で割って平均をおよそ 1 に戻す
     出力 = E·cosθ/π · (A_b·max(I − 1, 0) − A_d·min(1 − I, 1))（E = uCaustMixW：水面を透過した key の放射照度 rgb）。
     暗い網の目を少し暗く、明線を明るく（平均はわずかに明るい側）。水の減衰は fog チャンクが掛ける
   グレーボックス（core のスタブ、uCaustShape.x < 1.5）：R = 網 A・G = 網 B の明線を旧式で読む（スタブの意味のまま）
   契約（ARCHITECTURE §5.3、CONTRACT §4.5、CORE_API §6.4）：
     - vec3 causticLight(vec3 worldPos, vec3 viewNormal)（加算の放射輝度）
     - worldPos.y > -0.02 は 0（水上の魚・釣り人には出さない）
     - 16 個の uCaust* を宣言する。サンプラーは sampler2DArray だけ（魚の GLSL3 で動く）
     - 魚は #include <common> の直後にこれを入れる（ngFrame はまだ宣言されていない位置）ので、
       ng のフレームやライブラリの関数には頼らない。cs 接頭辞はこの文字列の中だけ
   uniform の意味（本番）：
     uCaustScale (1/L タイル, ヘッセ行列の幅)   uCaustShape (モード 2, 焦点の頭打ち ε)
     uCaustRange (暗くする係数 A_d, 明線の係数 A_b)  uCaustDepth 浅瀬のフェード  uCaustDist 視距離のフェード
     uCaustFar 深場のフェード  uCaustWarp (長い波の歪み, 有効深度の上限)  uCaustMag 平均の補正 c
     uCaustMixW 水面を透過した key の放射照度 rgb（強さ・雲・雨を込み）
   =========================================================== */
import { waveGLSL } from '../../waveField.js?v=20260828-lakescale1';

/** 焼き込みが来るまでの uCaustTex の層数（1×1×1 の白） */
export const CAUSTICS_PLACEHOLDER_LAYERS = 1;

/** core のスタブが焼く網目のタイルの形（スタブと旧式の分岐が共有）：一辺の画素、時刻のフレーム数、網 A / B のタイル当たりのセル数、一巡の秒。
 *  タイル 1 枚の大きさは A = 1/uCaustScale.x m、B = 1/uCaustScale.y m */
export const CAUSTICS_TILE = Object.freeze({ size: 256, frames: 16, cellsA: 6, cellsB: 10, loopSec: 8 });

/** 本番のタイル（underwater モジュール）：一巡の秒（スペクトルの時間の周期 T） */
export const CAUSTICS_LOOP_SEC = 8.0;

/** vec3 causticLight(vec3 worldPos, vec3 viewNormal) と 16 個の uCaust*（魚・湖底・水中の小物が共有） */
export const CAUSTICS_GLSL = /* glsl */ `
uniform float uCaustTime;
uniform vec3 uCaustSunDir;
uniform float uCaustNight;
uniform float uCaustRain;
uniform float uCaustCloud;
uniform float uCaustStrength;
uniform highp sampler2DArray uCaustTex;
uniform vec2 uCaustScale;    // 本番：(1/タイル m, ヘッセ行列の幅 1/m)。旧式：2 層の空間スケール
uniform vec2 uCaustShape;    // 本番：(2 = モード, 焦点の頭打ち ε)。旧式：(ゲイン, 指数)
uniform vec2 uCaustRange;    // 本番：(暗くする係数, 明線の係数)。旧式：(明線の上限, 最終強度)
uniform vec2 uCaustDepth;    // 水深フェード（開始, 終了）
uniform vec2 uCaustDist;     // 視距離フェード（開始, 終了）
uniform vec2 uCaustFar;      // 深すぎる所で消すフェード（開始, 終了）
uniform vec2 uCaustWarp;     // x = 波の傾きで歪める量, y = 有効深度の上限(m)
uniform float uCaustMag;     // 本番：平均の補正 c。旧式：深さ 1m あたりのぼけ
uniform vec3 uCaustMixW;     // 本番：key の放射照度 rgb。旧式：2 層の合成比

${waveGLSL({ prefix: 'cs', slim: true })}

/* 時刻 ph（一巡 = 1）で前後のフレームを補間して読む（mip の偏り bias） */
vec4 csTile(vec2 uv, float ph, float layers, float bias) {
  float f = fract(ph) * layers;
  float l0 = floor(f);
  float l1 = l0 + 1.0 >= layers ? 0.0 : l0 + 1.0;
  return mix(texture(uCaustTex, vec3(uv, l0), bias), texture(uCaustTex, vec3(uv, l1), bias), f - l0);
}

/* ヘッセ行列 (hxx, hyy, hxy) を 1 つのタイルの読みから（0.5 中心） */
vec3 csHess(vec4 t) { return (t.rgb * 2.0 - 1.0) * uCaustScale.y; }

/* 面積比 1/|det(I + D H)|（ε で焦点を頭打ち） */
float csArea(vec3 H, float D) {
  float det = (1.0 + D * H.x) * (1.0 + D * H.y) - D * D * H.z * H.z;
  return inversesqrt(det * det + uCaustShape.y * uCaustShape.y);
}

vec3 causticLight(vec3 worldPos, vec3 viewNormal) {
  if (uCaustStrength < 0.001 || worldPos.y > -0.02) return vec3(0.0);
  float layers = float(textureSize(uCaustTex, 0).z);
  if (layers < 1.5) return vec3(0.0);
  float depth = -worldPos.y;
  vec3 sd = normalize(uCaustSunDir);
  bool prod = uCaustShape.x > 1.5;
  /* 弱める係数を先に：視距離・水深・面の向き・夜・雨・雲・太陽の高さ */
  float viewDist = length(worldPos - cameraPosition);
  float fade = 1.0 - smoothstep(uCaustDist.x, uCaustDist.y, viewDist);
  fade *= smoothstep(uCaustDepth.x, uCaustDepth.y, depth) * (1.0 - smoothstep(uCaustFar.x, uCaustFar.y, depth));
  /* 水中の光の向き（上へ向かう単位ベクトル）：スネルで屈折した key */
  float ca = max(sd.y, 0.08);
  float sa = sqrt(max(0.0, 1.0 - ca * ca));
  float sw = sa / 1.333;
  float cw = sqrt(max(0.0, 1.0 - sw * sw));
  float sl = length(sd.xz);
  vec2 sunN = sl > 1e-4 ? sd.xz / sl : vec2(0.0, 1.0);
  /* 面が水中の光の方を向くほど強い（world の法線 = viewNormal を view の回転の逆で戻す） */
  vec3 nW = normalize((vec4(normalize(viewNormal), 0.0) * viewMatrix).xyz);
  float cosI = dot(nW, vec3(sunN * sw, cw));
  if (prod) fade *= smoothstep(0.0, 0.25, cosI) * max(cosI, 0.0);
  else {
    vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec3 nV = normalize(viewNormal);
    fade *= smoothstep(0.15, 0.72, dot(nV, upView));
    vec3 sunView = normalize((viewMatrix * vec4(sd, 0.0)).xyz);
    fade *= smoothstep(0.02, 0.38, max(dot(nV, sunView), 0.0));
  }
  fade *= mix(1.0, 0.30, uCaustNight) * (1.0 - uCaustRain * 0.72) * (1.0 - uCaustCloud * (prod ? 0.45 : 0.62));
  /* 低い太陽は水面で跳ね返されて届かない（本番は透過率を uCaustMixW に込みで渡す） */
  fade *= smoothstep(-0.05, 0.22, sd.y) * (prod ? 1.0 : mix(0.55, 1.0, smoothstep(0.10, 0.75, sd.y)));
  fade *= uCaustStrength;
  if (fade < 1e-3) return vec3(0.0);
  /* 湖底の点を照らす光は太陽と反対側の水面から入る。水中の傾きはスネルで浅い */
  float tw = sw / max(cw, 1e-3);
  vec2 surf = worldPos.xz + sunN * depth * tw;
  vec2 q = surf + csWaveD(surf, uCaustTime) * (min(depth, uCaustWarp.y) * uCaustWarp.x + 0.6);
  if (!prod) {
    float blur = 1.0 + depth * uCaustMag * 4.0;
    float t = uCaustTime / ${CAUSTICS_TILE.loopSec.toFixed(1)};
    float a = csTile(q * uCaustScale.x + vec2(0.0018, 0.0012) * uCaustTime, t, layers, 0.0).r;
    float b = csTile(q * uCaustScale.y + vec2(-0.0013, 0.0020) * uCaustTime + 0.37, t * 1.3, layers, 0.0).g;
    a = pow(max(a, 1e-4), 1.0 / blur);
    b = pow(max(b, 1e-4), 1.0 / blur);
    float net = a * uCaustMixW.x + b * uCaustMixW.y + a * b * uCaustMixW.z;
    net = min(pow(max(net * uCaustShape.x, 0.0), uCaustShape.y), uCaustRange.x) / blur;
    return vec3(0.62, 0.88, 0.95) * net * fade * uCaustRange.y;
  }
  /* 本番：2 つの向きのタイルのヘッセ行列を足して 1 つの波の場に */
  float t = uCaustTime / ${CAUSTICS_LOOP_SEC.toFixed(1)};
  float texPerM = float(textureSize(uCaustTex, 0).x) * uCaustScale.x;
  float bias = max(0.0, log2(max(depth * texPerM * 0.006, 1e-3)));
  vec2 uv1 = q * uCaustScale.x + vec2(0.0061, 0.0023) * uCaustTime;
  const float S2 = 0.79;
  const vec2 R2 = vec2(-0.4226, 0.9063);   // cos 115°, sin 115°
  vec2 q2 = vec2(R2.x * q.x - R2.y * q.y, R2.y * q.x + R2.x * q.y);
  vec2 uv2 = q2 * (S2 * uCaustScale.x) + vec2(-0.0029, 0.0067) * uCaustTime + 0.37;
  vec3 A = csHess(csTile(uv1, t, layers, bias));
  vec3 B = csHess(csTile(uv2, t * 1.27 + 0.31, layers, bias));
  /* B は回転した座標で読んだので、世界の軸へ戻す（Rᵀ H R、縮尺の二乗） */
  float c = R2.x, s = R2.y;
  vec3 Bw = S2 * S2 * vec3(
    c * c * B.x + s * s * B.y + 2.0 * c * s * B.z,
    s * s * B.x + c * c * B.y - 2.0 * c * s * B.z,
    -c * s * B.x + c * s * B.y + (c * c - s * s) * B.z);
  vec3 H = (A + Bw) * 0.70710678;
  /* 光路長 = 深さ / cosθw。RGB で屈折率を変える（分散） */
  float Lp = depth / max(cw, 0.2);
  vec3 Dc = Lp * vec3(1.0 - 1.0 / 1.329, 1.0 - 1.0 / 1.334, 1.0 - 1.0 / 1.341);
  vec3 I = vec3(csArea(H, Dc.r), csArea(H, Dc.g), csArea(H, Dc.b));
  float x = Dc.g * uCaustScale.y * 0.385;   // D·|H|rms（hScale = 2.6 rms）
  x *= exp2(-bias);                          // mip でならした分だけ曲率は小さい
  I /= 1.0 + uCaustMag * x * x * exp(-0.35 * x * x);
  vec3 L = uCaustRange.y * max(I - 1.0, 0.0) - uCaustRange.x * clamp(1.0 - I, 0.0, 1.0);
  return uCaustMixW * (L * (fade * 0.31830989));
}
`;
