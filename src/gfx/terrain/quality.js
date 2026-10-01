/* ===========================================================
   terrain の品質表（ARCHITECTURE §7 の terrain の行）
   -----------------------------------------------------------
   段で変えるのは «パッチの細かさ・LOD 範囲・素材の解像度・混ぜ方のループ» だけ（uniform とインスタンス）。
   define は段で変えない（プログラムが増える）。hexMode：0 = 2 スケール（low）、1 = 上位 1 層だけ hex、2 = 上位 2 層 hex
   =========================================================== */

export const TERRAIN_TIERS = Object.freeze({
  low: Object.freeze({ cells: 16, rangeK: 0.6, texSize: 512, hexMode: 0, triplanar: 0, farFrom: 110, reflBias: 2 }),
  mid: Object.freeze({ cells: 32, rangeK: 0.75, texSize: 512, hexMode: 1, triplanar: 1, farFrom: 150, reflBias: 2 }),
  high: Object.freeze({ cells: 32, rangeK: 1.0, texSize: 1024, hexMode: 2, triplanar: 1, farFrom: 180, reflBias: 2 }),
});

/** 段 0 の範囲（m）。段 l は 24·2^l（24/48/96/192/384/768） */
export const TERRAIN_R0 = 24;

/** @param {string} tier */
export function terrainTier(tier) { return TERRAIN_TIERS[tier] || TERRAIN_TIERS.mid; }
