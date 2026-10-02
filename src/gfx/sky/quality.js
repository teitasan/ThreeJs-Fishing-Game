/* ===========================================================
   sky の品質表（ARCHITECTURE §7 の «雲» の行と §6.1）
   -----------------------------------------------------------
   段で変えるのは RT の大きさ・ループの上限・uniform だけ（define を増やさない）。
   pano：雲パノラマの大きさ（上半球、毎フレーム 1/16 の帯を描く）
   steps / light：視線と光の段数（0 = low の 2D の層）
   sky：晴れの空の raymarch の段数（skyClear 256×128）
   =========================================================== */
export const SKY_TIERS = Object.freeze({
  low: Object.freeze({ pano: [512, 192], steps: 0, light: 0, sky: 20, starSize: 1.6, strips: 16, skyBands: 4 }),
  mid: Object.freeze({ pano: [1536, 576], steps: 36, light: 3, sky: 24, starSize: 1.5, strips: 24, skyBands: 4 }),
  high: Object.freeze({ pano: [2048, 768], steps: 48, light: 4, sky: 32, starSize: 1.5, strips: 32, skyBands: 4 }),
});

/** @param {string} tier */
export function skyTier(tier) { return SKY_TIERS[tier] || SKY_TIERS.high; }
