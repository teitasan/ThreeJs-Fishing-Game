/* ===========================================================
   post の品質表（ARCHITECTURE §7 の post の行）
   -----------------------------------------------------------
   three を import しない（Node のテストからも読む）
   - gtao：半解像度、2 スライス × 6 ステップ、半径 1.2m（high だけ）
   - shaft：1/4 解像度、サンプル数（low は無し）
   - bloom：mip の段数（low は無し）。最初の段は Karis 平均
   - cas：DRS で内部解像度が落ちたときの軽い鋭さ（0..1）
   =========================================================== */

/** @type {Readonly<Record<'low'|'mid'|'high', {gtao:boolean, aoSteps:number, aoRadius:number, shaft:number, bloom:number, cas:number}>>} */
export const POST_TIERS = Object.freeze({
  low: Object.freeze({ gtao: false, aoSteps: 0, aoRadius: 1.2, shaft: 0, bloom: 0, cas: 0.6 }),
  mid: Object.freeze({ gtao: false, aoSteps: 0, aoRadius: 1.2, shaft: 12, bloom: 4, cas: 0.5 }),   // r2：SMAA の分 0.05–0.15ms 超えたので Bloom 5→4 段・光芒 16→12
  high: Object.freeze({ gtao: true, aoSteps: 6, aoRadius: 1.2, shaft: 24, bloom: 8, cas: 0.45 }),
});

/** @param {string} tier */
export function postTier(tier) { return POST_TIERS[tier] || POST_TIERS.high; }
