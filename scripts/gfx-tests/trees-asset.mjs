/* ===========================================================
   trees：焼き込みの資産と当たりの検査（Node、three 無し）
   1. 再焼き込みでバイト一致（trees.bin / trees.json）と hash・大きさ ≤ 3MB
   2. 三角形の予算：LOD0 ≤ 14k（ARCHITECTURE §6.5：9–14k。アカマツの疎らな傘は下限の例外）、LOD1 1.5–2.5k
   3. 幹の胸高の帯（BREAST_FLAT）の半径 = species.js の trunkR（当たりの式の前提）
   4. 当たりの重ね：placement の当たりのある全部の木で «描いた幹の胸高の半径 × 1.15» と当たりの半径の差 ≤ 5%
      （太らせる倍率の上限 WIDEN_MAX を超える木は数えて上限を固定する。trees.md の要望）
   5. 太らせる帯の JS 式（widenAt）がシェーダの式と同じ形であること（文字列で照合）
   =========================================================== */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { bakeAll, OUT_DIR } = await import('../bake/trees/bake.mjs');
const { BREAST_FLAT } = await import('../bake/trees/species.mjs');
const { readLod } = await import('../../src/gfx/trees/format.js');
const { trunkProfileOf, radiusAt, trunkWiden, visualTrunkR, widenAt, WIDEN_MAX } = await import('../../src/gfx/trees/fit.js');
const { SPECIES, SPECIES_IDS, TRUNK_R_PAD } = await import('../../src/world/species.js');
const { resolveLake } = await import('../../src/lakefield.js');
const { buildPlacement } = await import('../../src/world/placement.js');
const { makeQueries } = await import('../../src/world/queries.js');

/* 1. 決定的な焼き込み */
const { bin, json, text } = bakeAll();
const fileBin = fs.readFileSync(path.join(OUT_DIR, 'trees.bin'));
const fileJson = fs.readFileSync(path.join(OUT_DIR, 'trees.json'), 'utf8');
assert.equal(Buffer.compare(fileBin, Buffer.from(bin)), 0, 'trees.bin が再焼き込みと一致しない（node scripts/bake/trees/bake.mjs）');
assert.equal(fileJson, text, 'trees.json が再焼き込みと一致しない');
const assetBytes = fs.readdirSync(OUT_DIR).reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
assert.ok(assetBytes <= 3 * 1024 * 1024, `assets/gfx/trees が 3MB を超える：${assetBytes}`);
assert.equal(json.variants.length, SPECIES_IDS.length * 4);

/* 2. 三角形の予算 */
for (const V of json.variants) {
  const [l0, l1] = V.lods;
  assert.ok(l0.tris <= 14000 && l0.tris >= 6500, `${V.species}#${V.variant} LOD0 ${l0.tris}`);
  if (V.species !== 'akamatsu') assert.ok(l0.tris >= 9000, `${V.species}#${V.variant} LOD0 ${l0.tris} < 9k`);
  assert.ok(l1.tris >= 1500 && l1.tris <= 2500, `${V.species}#${V.variant} LOD1 ${l1.tris}`);
}

/* 3. 胸高の帯の半径 = trunkR */
const bytes = new Uint8Array(fileBin.buffer, fileBin.byteOffset, fileBin.byteLength);
const profiles = json.variants.map((V) => trunkProfileOf(readLod(bytes, V.lods[0])));
json.variants.forEach((V, i) => {
  const want = SPECIES[V.species].trunkR[V.variant];
  for (const yn of [BREAST_FLAT[0] + 0.004, (BREAST_FLAT[0] + BREAST_FLAT[1]) / 2, BREAST_FLAT[1] - 0.004]) {
    const r = radiusAt(profiles[i], yn);
    assert.ok(Math.abs(r - want) / want < 0.02, `${V.species}#${V.variant} y=${yn.toFixed(3)} r=${r.toFixed(5)} trunkR=${want}`);
  }
});

/* 4. 当たりの重ね（全部の当たりのある木） */
const { lake } = resolveLake(123456789);
const P = buildPlacement(lake, makeQueries(lake)).trees;
let n = 0, capped = 0, worst = 0, sumErr = 0;
const errs = [];
for (let k = 0; k < P.count; k++) {
  if (!P.collide[k]) continue;
  n++;
  const prof = profiles[P.species[k] * 4 + P.variant[k]];
  const w = trunkWiden(prof, P.h[k], P.r[k]);
  const err = Math.abs(visualTrunkR(prof, P.h[k], w) * TRUNK_R_PAD - P.r[k]) / P.r[k];
  if (w >= WIDEN_MAX - 1e-6) { capped++; continue; }
  worst = Math.max(worst, err); sumErr += err; errs.push(err);
}
assert.ok(n > 1000, `当たりのある木が少ない ${n}`);
assert.ok(worst <= 0.05, `幹の見た目 × 1.15 と当たりの差 ${(worst * 100).toFixed(2)}% > 5%`);
/* 上限で頭打ちの木（若木で当たりの最小 0.28m が見た目の 4 倍超）：今の placement で 4.5% 以下（増えたら気づく） */
assert.ok(capped / n <= 0.045, `太らせる上限に当たった木 ${capped}/${n}`);

/* 5. シェーダの式と JS の式 */
const sh = fs.readFileSync(path.join(ROOT, 'src/gfx/trees/shaders.js'), 'utf8');
assert.ok(sh.includes('smoothstep(1.7, 1.7 + max(1.5, 0.2 * ngH), ngYm)') && sh.includes('mix(ngWiden, 1.0 + 0.3 * (ngWiden - 1.0), ngWs)'), 'シェーダの幹の帯の式が fit.js と違う');
assert.ok(Math.abs(widenAt(0.5, 20, 3) - 3) < 1e-9 && Math.abs(widenAt(1.3, 20, 3) - 3) < 1e-9 && Math.abs(widenAt(30, 20, 3) - 1.6) < 1e-9);

console.log(`trees-asset: 合格（${(bin.length / 1048576).toFixed(2)}MB hash ${json.hash}・当たりのある木 ${n} 本：差の最大 ${(worst * 100).toFixed(2)}%・平均 ${(sumErr / Math.max(errs.length, 1) * 100).toFixed(2)}%・上限 ${capped} 本）`);
