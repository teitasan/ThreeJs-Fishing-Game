/* ===========================================================
   groundcover の品質表（ARCHITECTURE §6.6・§7）
   -----------------------------------------------------------
   «リング» = カメラ中心の正方格子（セル c m、半数 n → (2n)² セル）。セル 1 つ = 株 1 つ。
   株の位置はセルの «世界の» 番号のハッシュで決まるので、カメラが動いても株は滑らない（格子だけが付いてくる）。
   - grass[0] は近景（8 枚 × 5 節）、grass[1] は遠景（6 枚 × 3 節、太く・疎ら）。r0..r1 の間だけ出し、
     両端の fade の帯で «株を縮めて» 消す（点の出入りでなく縮み → 縁が見えない）
   - plants：クマザサ・シダ（§7 «笹・シダ» 30 / 60 / 100%）
   - debris：玉石の浜の小石・落ち枝・落葉・苔の塊（半径 15m。«当たりの無い岩・小石» 40 / 70 / 100%）
   本数の目安（§7）：草 high 25k 株 / 32m、mid 12k / 25m、low 4k / 18m
   =========================================================== */

/** @typedef {{ c:number, n:number, r0:number, r1:number, fade:number, tpl:'near'|'far', density?:number }} GcRing */

/** @type {Record<'low'|'mid'|'high', { grass: GcRing[], plants: GcRing, debris: GcRing, shrubLod: number }>} */
export const GC_QUALITY = Object.freeze({
  high: {
    grass: [
      { c: 0.25, n: 48, r0: 0, r1: 11.5, fade: 2.5, tpl: 'near' },
      { c: 0.5, n: 64, r0: 9, r1: 31.5, fade: 9, tpl: 'far' },
    ],
    plants: { c: 0.6, n: 47, r0: 0, r1: 28, fade: 7, tpl: 'near', density: 1.0 },
    debris: { c: 0.45, n: 34, r0: 0, r1: 15, fade: 4, tpl: 'near', density: 1.0 },
    shrubLod: 1.0,
  },
  mid: {
    grass: [
      { c: 0.3, n: 32, r0: 0, r1: 9.3, fade: 2.2, tpl: 'near' },
      { c: 0.6, n: 42, r0: 7.5, r1: 24.6, fade: 7, tpl: 'far' },
    ],
    plants: { c: 0.7, n: 32, r0: 0, r1: 22.4, fade: 6, tpl: 'near', density: 0.6 },
    debris: { c: 0.55, n: 24, r0: 0, r1: 12.5, fade: 3.5, tpl: 'near', density: 0.7 },
    shrubLod: 1.0,
  },
  low: {
    grass: [
      { c: 0.45, n: 20, r0: 0, r1: 8.5, fade: 2.0, tpl: 'near' },
      { c: 0.9, n: 20, r0: 7, r1: 17.5, fade: 5, tpl: 'far' },
    ],
    plants: { c: 0.85, n: 20, r0: 0, r1: 17, fade: 4.5, tpl: 'near', density: 0.3 },
    debris: { c: 0.7, n: 14, r0: 0, r1: 9.5, fade: 3, tpl: 'near', density: 0.4 },
    shrubLod: 0.7,
  },
});

/** 計算パスの RT の幅（テクセル 1 つ = 株 1 つ） */
export const GC_TEX_W = 256;

/** 型板の形（頂点の数の見積もりとテスト用） */
export const GC_TPL = Object.freeze({
  near: { blades: 8, nodes: 5 },
  far: { blades: 6, nodes: 3 },
  plant: { leaves: 16, nodes: 5 },
  debris: { detail: 1 },
});

/** 系の番号（計算パスの uniform と頂点シェーダの分岐で使う） */
export const GC_SYS = Object.freeze({ grass: 0, plants: 1, debris: 2 });
/** 株の種類のコード（計算パスの出力 B.a） */
export const GC_KIND = Object.freeze({ grass: 0, sasa: 1, fern: 2, pebble: 3, twig: 4, moss: 5, litter: 6 });

/**
 * 段のリングを計算パスの «領域» に並べる（行の範囲）。純関数（Node のテストが使う）
 * @param {'low'|'mid'|'high'} tier
 * @returns {{ regions: Array<GcRing & { sys:number, row0:number, rows:number, cells:number, name:string }>, rows:number, cells:number }}
 */
export function gcLayout(tier) {
  const q = GC_QUALITY[tier] || GC_QUALITY.high;
  const list = [
    ...q.grass.map((g, i) => ({ ...g, sys: GC_SYS.grass, name: `grass${i}` })),
    { ...q.plants, sys: GC_SYS.plants, name: 'plants' },
    { ...q.debris, sys: GC_SYS.debris, name: 'debris' },
  ];
  let row = 0, cells = 0;
  const regions = list.map((g) => {
    const n2 = (2 * g.n) * (2 * g.n);
    const rows = Math.ceil(n2 / GC_TEX_W);
    const r = { density: 1, ...g, row0: row, rows, cells: n2 };
    row += rows;
    cells += n2;
    return r;
  });
  return { regions, rows: row, cells };
}

/**
 * セルの番号 → 世界の格子（CPU の双子。計算パスの式と同じ）
 * @param {number} i 領域の中の番号
 * @param {number} n 半数
 * @param {number} c セル m
 * @param {number} camX
 * @param {number} camZ
 * @returns {{ gx:number, gz:number }} 世界のセルの番号（整数）
 */
export function gcCellOf(i, n, c, camX, camZ) {
  const side = 2 * n;
  const ix = i % side, iz = Math.floor(i / side);
  return { gx: Math.floor(camX / c) + ix - n, gz: Math.floor(camZ / c) + iz - n };
}

/**
 * 視錐台を view の深さ depth で切った 8 隅の xz の外接矩形（純関数。three に依らない）
 * @param {{isPerspectiveCamera?:boolean, fov:number, aspect:number, near:number, matrixWorld:{elements:ArrayLike<number>}, position:{x:number,z:number}}} cam
 * @param {number} depth m
 * @returns {{minX:number, maxX:number, minZ:number, maxZ:number}|null} 透視でなければ null
 */
export function gcFootprint(cam, depth) {
  if (!cam || !cam.isPerspectiveCamera || !Number.isFinite(cam.fov)) return null;
  const e = cam.matrixWorld.elements;
  const ty = Math.tan((cam.fov * Math.PI) / 360), tx = ty * (cam.aspect || 1);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const d of [Math.max(cam.near || 0.1, 0.01), Math.max(depth, 0.1)]) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x = sx * tx * d, y = sy * ty * d, z = -d;
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * リングの «窓»：リング（セル c、半数 n、カメラ中心）の中で足跡の外接矩形に入るセルの範囲
 * @returns {{ox:number, oz:number, w:number, h:number}} 番号はリングの中（0..2n−1）。w·h = 描く株の数
 */
export function gcWindow(cam, c, n, depth, margin = 1.5) {
  const side = 2 * n;
  const fp = gcFootprint(cam, depth);
  if (!fp || ![fp.minX, fp.maxX, fp.minZ, fp.maxZ].every(Number.isFinite)) return { ox: 0, oz: 0, w: side, h: side };
  const gx0 = Math.floor(cam.position.x / c) - n, gz0 = Math.floor(cam.position.z / c) - n;
  const cl = (v) => Math.max(0, Math.min(side - 1, v));
  const ix0 = cl(Math.floor((fp.minX - margin) / c) - gx0), ix1 = cl(Math.floor((fp.maxX + margin) / c) - gx0);
  const iz0 = cl(Math.floor((fp.minZ - margin) / c) - gz0), iz1 = cl(Math.floor((fp.maxZ + margin) / c) - gz0);
  return { ox: ix0, oz: iz0, w: Math.max(0, ix1 - ix0 + 1), h: Math.max(0, iz1 - iz0 + 1) };
}
