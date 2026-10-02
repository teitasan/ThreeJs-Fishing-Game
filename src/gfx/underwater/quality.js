/* ===========================================================
   underwater の品質表（ARCHITECTURE §7 の caustics・水中の光柱の行、§6.3 のプランクトン）
   -----------------------------------------------------------
   段で変えるのは «焼くタイルの大きさ・フレーム数・光柱のステップ・ぼけ・粒の数» だけ（uniform とループの上限）。
   define は段で変えない。caustics の強さは core の profile.causticsStrength（0.32 / 0.72 / 1.0）
   - tile / frames：uCaustTex（層 = 時刻のフレーム）の一辺と層数。high 16 × 512²、mid / low 8 × 256²
   - shaftSteps：光柱のレイマーチ（解像度 = shaftScale × 画面）。0 = 解析の光暈だけ（low）。
     §6.3 の «半解像度 16 ステップ» は 1440p で 2.8ms（予算 1.2）だったので 0.3 × 12 ステップ（+ 1 層の取得）へ。
     光柱は低周波なので分離ぼかし + 合成の深さを見た 5 タップで足りる（撮影で確認）
   - blurPx：距離のぼけの最大半径（1080p の px。画面の高さで拡縮）。0 = ぼけ無し
   - menBand：メニスカスの帯の幅（1080p の px）
   - plankton：カメラ中心 12m の箱で wrap する粒の数
   =========================================================== */

export const UW_TIERS = Object.freeze({
  low: Object.freeze({ tile: 256, frames: 8, shaftSteps: 0, shaftScale: 0.25, blurPx: 0, menBand: 5, plankton: 150 }),
  mid: Object.freeze({ tile: 256, frames: 8, shaftSteps: 8, shaftScale: 0.25, blurPx: 4, menBand: 6, plankton: 400 }),
  high: Object.freeze({ tile: 512, frames: 16, shaftSteps: 12, shaftScale: 0.3, blurPx: 6, menBand: 7, plankton: 800 }),
});

/** @param {string} tier */
export function uwTier(tier) { return UW_TIERS[tier] || UW_TIERS.mid; }
