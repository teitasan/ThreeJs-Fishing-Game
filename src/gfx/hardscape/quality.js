/* ===========================================================
   hardscape の品質表（ARCHITECTURE §7。配置と当たりは全品質で同一。three を import しない）
   -----------------------------------------------------------
   - lod0 / lod1：岩の LOD の距離 m（大きい岩ほど遠くまで：距離 ÷ √size）
   - cobbleCull：小石を描く最大距離 m（それより先は数 px 未満）
   - moths：夜の灯籠の蛾の数
   密度（当たりの無い岩・小石・流木）は placement の TIER_DENSITY（rank の入れ子）
   =========================================================== */
export const HS_TIERS = Object.freeze({
  low: Object.freeze({ lod0: 7, lod1: 32, cobbleCull: 38, moths: 6 }),
  mid: Object.freeze({ lod0: 11, lod1: 48, cobbleCull: 60, moths: 10 }),
  high: Object.freeze({ lod0: 16, lod1: 70, cobbleCull: 90, moths: 14 }),
});

/** @param {string} tier */
export function hsTier(tier) { return HS_TIERS[tier] || HS_TIERS.high; }

/** 灯籠の 1/f の揺らぎ（周波数 Hz と振幅。振幅 ∝ 1/√f = パワー 1/f）。t は止まる時計（ポーズで進まない） */
const FL = [0.13, 0.31, 0.73, 1.7, 3.9, 8.3].map((f, i) => ({ f, a: 0.03 / Math.sqrt(f / 0.13), p: i * 2.399 + 0.7 }));
export function lampFlicker(t) {
  let s = 1;
  for (const k of FL) s += k.a * Math.sin(6.2831853 * k.f * t + k.p);
  return s;
}
