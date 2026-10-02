/* ===========================================================
   underwater の品質表（ARCHITECTURE §7 の caustics・水中の光柱の行、§6.3 のプランクトン）
   -----------------------------------------------------------
   段で変えるのは «焼くタイルの大きさ・フレーム数・光柱のステップ・ぼけの段・粒の数» だけ（uniform とループの上限）。
   define は段で変えない。caustics の強さは core の profile.causticsStrength（0.32 / 0.72 / 1.0）
   - tile / frames：uCaustTex（層 = 時刻のフレーム）の一辺と層数。high 16 × 512²、mid / low 8 × 256²
   - grid：屈折の格子のセル数（タイル 1 枚あたり。タイルの画素の約半分 = 2px のセル）
   - shaftSteps：光柱のレイマーチ（半解像度）。0 = 解析の光暈だけ（low）
   - blurLod：距離のぼけに使う mip の上限（0 = ぼけ無し）
   - plankton：カメラ中心 12m の箱で wrap する粒の数
   =========================================================== */

export const UW_TIERS = Object.freeze({
  low: Object.freeze({ tile: 256, frames: 8, grid: 128, shaftSteps: 0, shaftScale: 0.5, blurLod: 0, plankton: 150 }),
  mid: Object.freeze({ tile: 256, frames: 8, grid: 128, shaftSteps: 8, shaftScale: 0.5, blurLod: 3, plankton: 400 }),
  high: Object.freeze({ tile: 512, frames: 16, grid: 256, shaftSteps: 16, shaftScale: 0.5, blurLod: 4, plankton: 800 }),
});

/** @param {string} tier */
export function uwTier(tier) { return UW_TIERS[tier] || UW_TIERS.mid; }
