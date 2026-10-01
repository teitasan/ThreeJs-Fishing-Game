/* ===========================================================
   water の品質表（ARCHITECTURE §7 の water の行）
   -----------------------------------------------------------
   段で変えるのは «本数・RT の大きさ・ループの上限・uniform» だけ（define は増やさない。CORE_API §1.3）。
   シェーダは全段で同じ 1 本（水面）で、段の差は uniform（uTier の重み・波紋シミュの有無）で付ける
   =========================================================== */

/**
 * @typedef {object} WaterTier
 * @property {number} gridN       水面のリングの一辺のセル数（中心 gridN² @ 32/gridN m、2 倍ずつ）
 * @property {number} rings       粗いリングの数（中心の外側。±16·2^rings m まで）
 * @property {number} fftN        細波の周期 FFT の一辺（2 の冪。16·Q）
 * @property {number} cascades    FFT のカスケードの数（1..2）
 * @property {number} glints      微細なきらめき（3 つ目のスケール）の重み 0..1
 * @property {boolean} sim        波動方程式の波紋シミュ（high）
 * @property {number} simN        シミュの一辺のテクセル
 * @property {number} simTexel    シミュの 1 テクセル m
 * @property {number} splashes    しぶきの粒の数
 * @property {number} aniso       細波のテクスチャの異方性フィルタ
 */

/** @type {Record<'low'|'mid'|'high', WaterTier>} */
export const WATER_TIERS = Object.freeze({
  low: Object.freeze({ gridN: 64, rings: 4, fftN: 128, cascades: 2, glints: 0, sim: false, simN: 0, simTexel: 0, splashes: 256, aniso: 2 }),
  mid: Object.freeze({ gridN: 96, rings: 5, fftN: 256, cascades: 2, glints: 0, sim: false, simN: 0, simTexel: 0, splashes: 512, aniso: 4 }),
  high: Object.freeze({ gridN: 128, rings: 5, fftN: 256, cascades: 2, glints: 1, sim: true, simN: 512, simTexel: 0.05, splashes: 1024, aniso: 8 }),
});

/** 段のキーを丸める（未知の段は mid） */
export function waterTier(tier) { return WATER_TIERS[tier] || WATER_TIERS.mid; }

/**
 * 細波のカスケード（風下 +x の JONSWAP。吹送距離 300m の湖）。L はタイルの一辺 m、
 * 帯 [minLambda, maxLambda] m は重ならないように分ける（分散を二重に数えない）。
 * 2 つの L の比は整数から外して、繰り返しの周期を揃えない
 */
export const WATER_CASCADES = Object.freeze([
  Object.freeze({ L: 1.37, minLambda: 0.017, maxLambda: 0.36, seed: 0x5eed01 }),
  Object.freeze({ L: 9.10, minLambda: 0.36, maxLambda: 4.5, seed: 0x5eed02 }),
]);

/** 生きた FFT の ω の量子化の周期 s（ω = n·2π/LOOP。CPU が t mod LOOP を倍精度で渡す） */
export const WATER_FFT_LOOP = 256;
/** スペクトルの基準の風速 m/s（実行時の風は振幅で掛ける） */
export const WATER_FFT_U = 3.5;
