/* ===========================================================
   weatherfx の品質表（ARCHITECTURE §7 の «雨の筋 / 着弾»・«霧の板 / 蛍 / 塵» の行）
   -----------------------------------------------------------
   段で変えるのは本数（インスタンスの描く数）だけ。define・プログラムは段で変えない
   - streaks / splashes：雨の筋（半径 25m・高さ 20m の円柱）/ 地面と桟橋の着弾の王冠
   - haze：遠景の雨の幕（カメラ中心の円筒の殻の数）。1440p の MSAA で殻 1 枚 ≈ 0.7ms と重いので high / mid 1 枚（55m）、low 0
   - impulses：水面の波紋シミュへの雨粒（1 秒あたり、雨 1.0 のとき。water の 1 フレームの上限 16 の内）
   - mist / fireflies / motes：朝霧の板・蛍・光芒の塵
   =========================================================== */

export const WFX_TIERS = Object.freeze({
  low: Object.freeze({ streaks: 2500, splashes: 150, haze: 0, impulses: 90, mist: 16, fireflies: 60, motes: 0 }),
  mid: Object.freeze({ streaks: 6000, splashes: 250, haze: 1, impulses: 150, mist: 32, fireflies: 120, motes: 150 }),
  high: Object.freeze({ streaks: 12000, splashes: 400, haze: 1, impulses: 240, mist: 60, fireflies: 200, motes: 300 }),
});

/** 本数の上限（インスタンスの確保。high の値） */
export const WFX_MAX = WFX_TIERS.high;

/** @param {string} tier */
export function wfxTier(tier) { return WFX_TIERS[tier] || WFX_TIERS.mid; }
