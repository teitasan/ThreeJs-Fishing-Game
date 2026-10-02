/* shoreflora の純関数の検査（src/gfx/shoreflora/quality.js・reeds.glsl.js の型板、three 無し：最小の偽の T）
   - sfStemCount：0..1 の密度で 2..10 本・単調・最大 12・NaN は中ほど
   - sfFlatCoverage：円の中が埋まっていれば 1、空なら 0、半分なら ≈ 0.5
   - sfWeedFillers：決定的（同じ入力 → 同じ出力）、水深の窓（0.15–16m）と草丈（< 水深）、既存の草の 1.5m 以内に置かない、
     埋めた後の被覆が各円 ≥ 0.9（placement が疎らでも藻場が欠けない）
   - 型板：茎・葉・穂のリボンの頂点・三角形の数（high の近い株 1 つの上限）と LOD1 が軽い */
import assert from 'node:assert/strict';
import { SF_QUALITY, SF_TPL, sfStemCount, sfFlatCoverage, sfWeedFillers } from '../../src/gfx/shoreflora/quality.js';
import { reedTemplate, reedCardTemplate } from '../../src/gfx/shoreflora/reeds.glsl.js';
import { hash01 } from '../../src/world/rng.js';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

/* 茎の数 */
let prev = 0;
for (let d = 0; d <= 1.0001; d += 0.05) {
  const k = sfStemCount(d);
  ok(k >= 2 && k <= SF_TPL.reed.stems, `密度 ${d.toFixed(2)} → ${k} 本`);
  ok(k >= prev, '茎の数は密度に単調');
  prev = k;
}
ok(sfStemCount(NaN) === sfStemCount(0.5), 'NaN は中ほど');
ok(sfStemCount(-3) === sfStemCount(0) && sfStemCount(9) === sfStemCount(1), '範囲の外は端へ');

/* 距離の段 */
for (const t of ['low', 'mid', 'high']) {
  const q = SF_QUALITY[t];
  ok(q.near > q.fadeBand && q.card > q.near, `${t}: 近い株 < カード`);
}
ok(SF_QUALITY.high.near >= 80, 'high の近い株は 80m まで（§6.7）');

/* 被覆 */
const flats = [{ x: 0, z: 0, r: 20 }, { x: 100, z: 40, r: 12 }];
const full = [];
for (let x = -24; x <= 24; x += 2) for (let z = -24; z <= 24; z += 2) full.push({ x, z });
for (let x = 86; x <= 114; x += 2) for (let z = 26; z <= 54; z += 2) full.push({ x, z });
const cf = sfFlatCoverage(flats, full);
ok(cf.every((c) => c === 1), `埋まった円の被覆 ${cf}`);
const ce = sfFlatCoverage(flats, []);
ok(ce.every((c) => c === 0), '空の円の被覆 0');
const half = full.filter((w) => w.x < 0 || (w.x > 50 && w.x < 100));
const ch = sfFlatCoverage(flats, half);
ok(ch.every((c) => c > 0.4 && c < 0.75), `半分の被覆 ${ch.map((c) => c.toFixed(2))}`);

/* 埋め草 */
const depthAt = (x, z) => {
  /* 円 0 は 0.5–3m の浅場、円 1 は 9–20m の深場（深い所は 16m で切れる） */
  if (x < 50) return 0.5 + 2.5 * Math.min(1, Math.hypot(x, z) / 20);
  return 9 + Math.hypot(x - 100, z - 40);
};
const sparse = full.filter((_, i) => i % 9 === 0);
const hash = (i, j, k) => hash01(4242 + k * 7919, i, j);
const A = sfWeedFillers(flats, sparse, depthAt, hash), B = sfWeedFillers(flats, sparse, depthAt, hash);
ok(A.length > 50 && JSON.stringify(A) === JSON.stringify(B), `決定的（${A.length} 株）`);
for (const w of A) {
  ok(w.depth > 0.15 && w.depth < 16, '水深の窓');
  ok(w.height > 0.12 && w.height < w.depth, '草丈は水深より低い');
  ok(Math.abs(w.y + w.depth) < 1e-9 && w.filler === true, 'y = −水深');
  ok(w.rank >= 0 && w.rank < 1 && Number.isFinite(w.rot), 'rank と向き');
}
for (const w of A) for (const s of sparse) assert.ok((w.x - s.x) ** 2 + (w.z - s.z) ** 2 >= 1.5 * 1.5 - 1e-9, '既存の草の 1.5m 以内に置かない');
n++;
const shallow = sfFlatCoverage([flats[0]], sparse.concat(A));
ok(shallow[0] >= 0.9, `浅い円の被覆（埋めた後）${shallow[0].toFixed(3)} ≥ 0.9`);
ok(sfFlatCoverage([flats[0]], sparse)[0] < shallow[0], '埋めると被覆が上がる');
/* 深い円の縁（> 16m）は置かない */
ok(A.filter((w) => w.flat === 1).every((w) => depthAt(w.x, w.z) < 16), '16m より深い所に置かない');

/* 型板 */
class Attr { constructor(a, s) { this.array = Float32Array.from(a); this.itemSize = s; this.count = a.length / s; } }
class Geo {
  setAttribute(k, a) { this[k] = a; return this; }
  getAttribute(k) { return this[k]; }
  setIndex(i) { this.index = { array: i, count: i.length }; }
}
const T = { InstancedBufferGeometry: Geo, Float32BufferAttribute: Attr };
const near = reedTemplate(T, SF_TPL.reed, true), lod1 = reedTemplate(T, SF_TPL.reedLod1, true), card = reedCardTemplate(T);
const tri = (g) => g.index.count / 3;
ok(near.position.count === near.ngPart.count, '頂点ごとに部位');
ok(tri(near) <= 1400, `近い株の三角形 ${tri(near)} ≤ 1400`);
ok(tri(lod1) * 3 < tri(near), `LOD1 ${tri(lod1)} は近い株の 1/3 未満`);
ok(tri(card) === 2, 'カードは 2 枚');
ok(Math.max(...near.index.array) < near.position.count, '添字が頂点の数の中');
const parts = new Set(near.ngPart.array);
ok(parts.has(0) && parts.has(9) && parts.has(10), '茎・穂の部位がある');

console.log(`shoreflora-logic: ${n} 件 OK`);
