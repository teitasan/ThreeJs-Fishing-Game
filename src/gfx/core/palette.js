/* ===========================================================
   色彩バイブル（ARCHITECTURE §2）の定数
   -----------------------------------------------------------
   - シーンはリニア Rec.709 の HDR。ここの値はすべてリニア
   - lab の false color と art-metrics がこの表で検査する
   - three を import しない（Node のテストからも読む）
   =========================================================== */

/**
 * ng 単位の照度。キャラクターの旧調整と整合させた基準
 * @type {Readonly<{KEY_NOON:number, SKY_NOON:number, MOON:number, NIGHT_SKY:number, LAMP_K:number}>}
 */
export const NG_UNITS = Object.freeze({
  KEY_NOON: 3.0,     // 快晴の南中の太陽照度（DirectionalLight.intensity）
  SKY_NOON: 0.9,     // 空の半球照度
  MOON: 0.012,       // 月の照度
  NIGHT_SKY: 0.004,  // 夜空の照度
  LAMP_K: 2200,      // 灯籠の色温度
});

/**
 * 素材の線形アルベドの範囲 [min, max]（スカラーは灰、配列 3 つは rgb）
 * @type {Readonly<Record<string, {min:number|number[], max:number|number[], wetMul?:number, note:string}>>}
 */
export const NG_ALBEDO = Object.freeze({
  grass: { min: 0.10, max: 0.16, note: '初夏の黄緑、根元は暗く' },
  cedarLeaf: { min: [0.028, 0.050, 0.030], max: [0.032, 0.058, 0.032], note: 'スギ・ヒノキの葉' },
  beechLeaf: { min: [0.06, 0.10, 0.03], max: [0.08, 0.12, 0.04], note: 'ブナ・ミズナラの葉（0.07,0.11,0.035 前後）' },
  moss: { min: 0.06, max: 0.10, note: '緑寄り' },
  forestFloor: { min: 0.08, max: 0.14, note: '落葉・針葉' },
  sand: { min: 0.25, max: 0.35, wetMul: 0.55, note: '乾いた砂・砂利。濡れは ×0.55' },
  mud: { min: 0.10, max: 0.14, note: '湖底の泥（深さの色は媒質が付ける）' },
  rock: { min: 0.18, max: 0.25, note: '花崗岩・安山岩' },
  dockWood: { min: 0.26, max: 0.30, wetMul: 0.5, note: '風化した杉材 0.28、濡れ ×0.5' },
});

/** 水の F0 */
export const NG_WATER_F0 = 0.02;

/** 露出の時刻表（太陽高度 deg → 倍率）。§2 の値そのもの。高度の昇順 */
export const NG_EXPOSURE_TABLE = Object.freeze([
  [-15, 22], [-12, 14], [-8, 7], [-4, 3.6], [0, 2.1], [3, 1.5], [10, 1.15], [25, 1.0],
]);

/**
 * §2 の scheduled 露出（純関数）。区間は対数で補間する（露出は乗算量なので）
 * @param {number} sunAltDeg 太陽高度（度）
 * @param {number} cloud 雲量 0..1
 * @param {number} rain 雨 0..1
 * @param {number} [uwDepth=-1] カメラの水深（m）。負なら水上
 * @returns {number}
 */
export function ngScheduledExposure(sunAltDeg, cloud, rain, uwDepth = -1) {
  const T = NG_EXPOSURE_TABLE;
  let e;
  if (!(sunAltDeg > T[0][0])) e = T[0][1];
  else if (sunAltDeg >= T[T.length - 1][0]) e = T[T.length - 1][1];
  else {
    let i = 0;
    while (sunAltDeg > T[i + 1][0]) i++;
    const [a0, e0] = T[i], [a1, e1] = T[i + 1];
    const t = (sunAltDeg - a0) / (a1 - a0);
    e = Math.exp(Math.log(e0) + (Math.log(e1) - Math.log(e0)) * t);
  }
  e *= (1 + 0.5 * clamp01(cloud)) * (1 + 0.3 * clamp01(rain));
  if (uwDepth >= 0) e *= Math.min(3, 1.3 + 0.08 * uwDepth);
  return e;
}

/** リニア rgb の輝度（Rec.709） */
export function ngLuminance(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/**
 * 24 パッチのカラーチャート（ColorChecker Classic の公称値、リニア sRGB）。lab の隅に置く
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
export const NG_CHART_24 = Object.freeze([
  [0.173, 0.087, 0.058], [0.544, 0.301, 0.221], [0.123, 0.195, 0.335], [0.101, 0.150, 0.056],
  [0.232, 0.217, 0.438], [0.132, 0.515, 0.405], [0.678, 0.203, 0.024], [0.089, 0.104, 0.387],
  [0.521, 0.087, 0.127], [0.099, 0.042, 0.141], [0.338, 0.502, 0.047], [0.739, 0.367, 0.024],
  [0.036, 0.047, 0.287], [0.059, 0.293, 0.063], [0.436, 0.031, 0.040], [0.794, 0.578, 0.011],
  [0.494, 0.083, 0.297], [0.000, 0.235, 0.378], [0.887, 0.887, 0.874], [0.584, 0.590, 0.588],
  [0.358, 0.362, 0.362], [0.190, 0.192, 0.192], [0.089, 0.089, 0.090], [0.031, 0.032, 0.033],
]);

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
