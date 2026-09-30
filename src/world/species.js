/* ===========================================================
   樹種表（three・DOM 無し）
   -----------------------------------------------------------
   木のオフライン焼き込み（scripts/bake/trees）・配置（placement）・
   当たり（幹の半径）が «同じ表» を見る。ここがずれると、見た目の幹と
   当たりの円がずれて «何も無い所で止まる／幹を突き抜ける» になる。

   trunkR は «胸高（1.3m）の幹の半径 ÷ 樹高»。variant ごとに 4 つ。
   当たりの半径は max(trunkR · h · 1.15, 0.28)（placement.trunkCollider）。
   寸法は日本の山地の実測値の幅に寄せてある（林野庁の立木幹材積表の
   樹高と胸高直径の関係を丸めたもの）：
     スギ   樹高 18–32m、胸高直径 30–60cm  → r/h ≈ 0.009–0.011
     ヒノキ 14–26m、25–45cm
     ブナ   15–28m、40–70cm（太く灰白）
     ミズナラ 14–25m、40–80cm（いちばん太い）
     イロハモミジ 6–13m、20–35cm
     アカマツ 12–24m、30–50cm（曲がる）
     ヤナギ（タチヤナギ・シダレ）7–14m、30–60cm（根元が太く傾く）
     ハンノキ 9–18m、20–35cm
   =========================================================== */

/** 焼き込み・配置が回す樹種の順番（index が placement.trees.species に入る） */
export const SPECIES_IDS = ['sugi', 'hinoki', 'buna', 'mizunara', 'momiji', 'akamatsu', 'yanagi', 'hannoki'];

/** 樹種ごとの variant 数（焼き込みもこれに従う） */
export const VARIANTS = 4;

export const SPECIES = {
  sugi: {
    id: 'sugi', name: 'スギ', form: 'conifer', evergreen: true,
    heights: [18, 32],
    trunkR: [0.0102, 0.0110, 0.0096, 0.0116],
    /* 樹冠：単軸の細長い円錐。半径 ÷ 樹高、樹冠の下端 ÷ 樹高 */
    crownR: 0.14, crownBase: 0.34,
    leaf: [0.028, 0.050, 0.030], bark: [0.16, 0.085, 0.055],
    stiffness: 0.85, riparian: false,
  },
  hinoki: {
    id: 'hinoki', name: 'ヒノキ', form: 'conifer', evergreen: true,
    heights: [14, 26],
    trunkR: [0.0100, 0.0108, 0.0094, 0.0114],
    crownR: 0.17, crownBase: 0.30,
    leaf: [0.032, 0.058, 0.032], bark: [0.19, 0.10, 0.065],
    stiffness: 0.8, riparian: false,
  },
  buna: {
    id: 'buna', name: 'ブナ', form: 'broadleaf', evergreen: false,
    heights: [15, 28],
    trunkR: [0.0135, 0.0150, 0.0125, 0.0160],
    crownR: 0.32, crownBase: 0.38,
    leaf: [0.070, 0.110, 0.035], bark: [0.34, 0.33, 0.30],
    stiffness: 0.55, riparian: false,
  },
  mizunara: {
    id: 'mizunara', name: 'ミズナラ', form: 'broadleaf', evergreen: false,
    heights: [14, 25],
    trunkR: [0.0150, 0.0170, 0.0140, 0.0185],
    crownR: 0.34, crownBase: 0.36,
    leaf: [0.062, 0.098, 0.030], bark: [0.22, 0.19, 0.15],
    stiffness: 0.6, riparian: false,
  },
  momiji: {
    id: 'momiji', name: 'イロハモミジ', form: 'broadleaf', evergreen: false,
    heights: [6, 13],
    trunkR: [0.0140, 0.0155, 0.0130, 0.0170],
    crownR: 0.42, crownBase: 0.28,
    leaf: [0.080, 0.120, 0.038], bark: [0.20, 0.18, 0.15],
    stiffness: 0.45, riparian: false,
  },
  akamatsu: {
    id: 'akamatsu', name: 'アカマツ', form: 'pine', evergreen: true,
    heights: [12, 24],
    trunkR: [0.0120, 0.0132, 0.0112, 0.0142],
    crownR: 0.26, crownBase: 0.55,
    leaf: [0.036, 0.060, 0.030], bark: [0.30, 0.13, 0.08],
    stiffness: 0.7, riparian: false,
  },
  yanagi: {
    id: 'yanagi', name: 'ヤナギ', form: 'weeping', evergreen: false,
    heights: [7, 14],
    trunkR: [0.0210, 0.0240, 0.0190, 0.0265],
    crownR: 0.45, crownBase: 0.25,
    leaf: [0.085, 0.125, 0.045], bark: [0.18, 0.16, 0.13],
    stiffness: 0.3, riparian: true,
  },
  hannoki: {
    id: 'hannoki', name: 'ハンノキ', form: 'broadleaf', evergreen: false,
    heights: [9, 18],
    trunkR: [0.0115, 0.0128, 0.0108, 0.0138],
    crownR: 0.28, crownBase: 0.35,
    leaf: [0.055, 0.090, 0.032], bark: [0.21, 0.19, 0.17],
    stiffness: 0.55, riparian: true,
  },
};

/** 当たりの最小半径（細い若木でも «すり抜けない» 太さ）。契約 §5 */
export const TRUNK_R_MIN = 0.28;
/** 見た目の幹に対する当たりの余裕 */
export const TRUNK_R_PAD = 1.15;
/** 当たりの上端は樹高の 9 割（梢の先は糸が抜けてよい） */
export const TRUNK_TOP = 0.9;

/**
 * 幹の当たり。y は根元（地面から少し沈めた高さ）。
 * @returns {{r:number, top:number}}
 */
export function trunkCollider(speciesIndex, variant, h, y) {
  const s = SPECIES[SPECIES_IDS[speciesIndex]];
  return {
    r: Math.max(s.trunkR[variant] * h * TRUNK_R_PAD, TRUNK_R_MIN),
    top: y + TRUNK_TOP * h,
  };
}
