/* ===========================================================
   shoreflora の品質表（ARCHITECTURE §6.7・§7）
   -----------------------------------------------------------
   本数の部分集合は placement の rank の入れ子（isVisible：reeds・lilies・weeds 0.2 / 0.5 / 1.0）。
   ここに持つのは距離と型板の細かさだけ（define を段で変えない：同じプログラムで uniform とインスタンスの数）。
   - reeds.near：株を幾何で描く距離 m（その先は株のカード、card まで）
   - 1 株の茎の数：round(1.5 + 8·density)（最大 12）。high の合計 ≈ 34k 本（§7 の 30k の目安）
   - §7：ヨシ low 6k / mid 15k / high 30k 本、睡蓮 600 / 1.5k / 3k、沈水植物 1.2k / 3k / 6k
   =========================================================== */

export const SF_QUALITY = Object.freeze({
  high: { near: 80, card: 420, fadeBand: 10 },
  mid: { near: 60, card: 320, fadeBand: 8 },
  low: { near: 40, card: 220, fadeBand: 6 },
});

/** 型板の形（頂点の数の見積もりとテスト用） */
export const SF_TPL = Object.freeze({
  reed: { stems: 12, nodes: 6, leaves: 8, leafNodes: 4 },
  reedLod1: { stems: 6, nodes: 3, leaves: 2, leafNodes: 2 },
  lily: { pads: 6, padSeg: 14, petals: 12, rosette: 12 },
  weed: { stems: 4, nodes: 9 },
});

/** 1 株の茎の数（density 0..1）。合計 = §7 の本数の目安 */
export function sfStemCount(density) {
  const d = Number.isFinite(density) ? Math.max(0, Math.min(1, density)) : 0.5;
  return Math.min(SF_TPL.reed.stems, Math.floor(1.5 + 8 * d + 0.5));
}

/**
 * 藻場の被覆（lake.flats の各円を weeds が覆っているか）。純関数（Node のテストと proof が使う）
 * 円の中の格子点（2m おき、半径 × inner まで）のうち、最寄りの weeds が reach m 以内の割合
 * @param {Array<{x:number,z:number,r:number}>} flats
 * @param {Array<{x:number,z:number,flat?:number}>} weeds
 * @param {{inner?:number, reach?:number, step?:number}} [o]
 * @returns {number[]} 円ごとの被覆 0..1
 */
export function sfFlatCoverage(flats, weeds, o = {}) {
  const inner = o.inner ?? 0.8, reach = o.reach ?? 2.5, step = o.step ?? 2;
  const cell = new Map();
  const key = (x, z) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
  for (const w of weeds) {
    const k = key(w.x, w.z);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(w);
  }
  return flats.map((f) => {
    let n = 0, hit = 0;
    const R = f.r * inner;
    for (let x = -R; x <= R; x += step) for (let z = -R; z <= R; z += step) {
      if (x * x + z * z > R * R) continue;
      n++;
      const px = f.x + x, pz = f.z + z;
      let ok = false;
      for (let i = -1; i <= 1 && !ok; i++) for (let j = -1; j <= 1 && !ok; j++) {
        const L = cell.get(`${Math.floor(px / 4) + i},${Math.floor(pz / 4) + j}`);
        if (L) for (const w of L) if ((w.x - px) ** 2 + (w.z - pz) ** 2 < reach * reach) { ok = true; break; }
      }
      if (ok) hit++;
    }
    return n ? hit / n : 1;
  });
}
