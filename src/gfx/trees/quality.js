/* ===========================================================
   trees の品質表（ARCHITECTURE §6.5・§7 の trees の行）
   -----------------------------------------------------------
   距離は m（setLodScale の倍率を掛ける）。本数は placement の rank の入れ子（TIER_DENSITY.trees）。
   - lod0 / lod1 / imp：LOD0・LOD1・インポスターの外の端。fade0 / fade1 は切り替えのディザの幅
   - shell：樹冠シェルが出始める距離（シェルは shell → shell + shellFade で濃くなり、インポスターは imp − fade1 → imp で消える）
   - impFrame：インポスターの 1 フレームの大きさ（8×8 フレーム）。impVariants：樹種ごとに焼く variant の数
   - leaf：葉のアトラス（4×2 セル）の大きさ。bark：樹皮の配列の一辺
   - cap0 / cap1：LOD0 / LOD1 に同時に置ける本数の上限（BatchedMesh の枠）
   =========================================================== */
export const TREES_QUALITY = {
  low: {
    lod0: 20, lod1: 70, imp: 250, shell: 230, fade0: 3, fade1: 12, shellFade: 25,
    impFrame: 64, impVariants: 1, leaf: [1024, 512], bark: 256, cap0: 260, cap1: 1400,
  },
  mid: {
    lod0: 30, lod1: 100, imp: 320, shell: 300, fade0: 4, fade1: 14, shellFade: 25,
    impFrame: 96, impVariants: 2, leaf: [1024, 512], bark: 512, cap0: 420, cap1: 2400,
  },
  high: {
    lod0: 45, lod1: 140, imp: 420, shell: 380, fade0: 5, fade1: 16, shellFade: 30,
    impFrame: 128, impVariants: 2, leaf: [2048, 1024], bark: 512, cap0: 640, cap1: 3600,
  },
};

/** インポスターの半八面体の格子（8×8 フレーム） */
export const IMP_GRID = 8;

/** 段の表を引く（知らない段は high） */
export function treesQuality(tier) { return TREES_QUALITY[tier] || TREES_QUALITY.high; }
