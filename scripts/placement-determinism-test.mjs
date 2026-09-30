#!/usr/bin/env node
/**
 * 配置（src/world/placement.js）の決定性と品質非依存。
 *
 * - 2 回作るとバイト一致（型付き配列もオブジェクトの列も）
 * - Terrain を low / mid / high で作っても、当たりの配列が同一（マルチで当たりがずれない）
 * - 見た目の部分集合は入れ子（low ⊂ mid ⊂ high）で、当たりを持つものは全品質で描く
 * - 候補は世界に固定した格子：あるセルの結果は他のセルの有無に依存しない
 * - src/world と src/gfx に Math.random が無い（コメントを除いて grep）
 * - 予算：250ms（Node で温まった後の中央値。遅い機械では警告だけ）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadFacades } from './facade-harness/index.mjs';

const F = await loadFacades();
const { THREE, Terrain, ROOT } = F;
const { resolveLake } = await import('../src/lakefield.js');
const {
  buildPlacement, obstacleList, collisionHash, isVisible, TIER_DENSITY, TREE_FIELDS, CELLS,
} = await import('../src/world/placement.js');
const { makeQueries } = await import('../src/world/queries.js');
const { cellRng, cellSeq, hashCell, stream } = await import('../src/world/rng.js');

const TIERS = ['low', 'mid', 'high'];
const lake = resolveLake(123456789).lake;
const q = makeQueries(lake);

/* --- 2 回作ってバイト一致 --- */
const A = buildPlacement(lake, q);
const B = buildPlacement(lake, makeQueries(resolveLake(123456789).lake));
assert.equal(A.hash, B.hash, '配置の指紋が 2 回で違う');
for (const f of TREE_FIELDS) {
  assert.ok(Buffer.from(A.trees[f].buffer).equals(Buffer.from(B.trees[f].buffer)), `trees.${f} がバイト一致しない`);
}
for (const k of ['boulders', 'cobbles', 'thicket', 'reeds', 'lilies', 'weeds', 'driftwood']) {
  assert.equal(JSON.stringify(A[k]), JSON.stringify(B[k]), `${k} が 2 回で違う`);
  assert.ok(A[k].length > 0, `${k} が空`);
}
assert.equal(JSON.stringify(A.lamp), JSON.stringify(B.lamp), 'lamp');
assert.equal(JSON.stringify(A.boat), JSON.stringify(B.boat), 'boat');
assert.equal(A.structures, lake.structures, 'structures は lake.structures そのもの');
assert.ok(Buffer.from(obstacleList(A, q).buffer).equals(Buffer.from(obstacleList(B, q).buffer)), '当たりの一覧が 2 回で違う');

/* 別のシードは別の森 */
const other = resolveLake(20240711).lake;
const C = buildPlacement(other, makeQueries(other));
assert.notEqual(C.hash, A.hash, '別のシードで同じ配置になった');
assert.notEqual(collisionHash(C, makeQueries(other)), collisionHash(A, q), '別のシードで同じ当たりになった');

/* --- 品質で当たりが変わらない（ファサード経由） --- */
{
  const hashes = [], counts = [];
  for (const quality of TIERS) {
    const t = new Terrain(new THREE.Scene(), { quality, lake: resolveLake(123456789).lake, grids: false });
    hashes.push(t.collisionHash);
    counts.push(t.obstacles.length);
    const o = obstacleList(A, q);
    assert.equal(t.obstacles.length, o.length, `${quality}: 障害物の数`);
    for (let i = 0; i < o.length; i++) assert.equal(t.obstacles[i], o[i], `${quality}: 障害物 ${i}`);
    t.setQuality(TIERS[(TIERS.indexOf(quality) + 1) % 3]);
    assert.equal(t.collisionHash, hashes[hashes.length - 1], 'setQuality で当たりが変わった');
    await t.ready;
  }
  assert.ok(hashes.every((h) => h === hashes[0]), `品質で当たりの指紋が違う: ${hashes}`);
  console.log(`  当たり ${counts[0] / 4} 件（全品質で同一 ${hashes[0]}）`);
}

/* --- 見た目の部分集合は入れ子。当たりのあるものは全品質で描く --- */
{
  for (const sys of Object.keys(TIER_DENSITY)) {
    const d = TIER_DENSITY[sys];
    assert.ok(d.low <= d.mid && d.mid <= d.high && d.high === 1, `${sys}: 密度が単調でない`);
  }
  const check = (sys, rank, must, what) => {
    const v = TIERS.map((t) => isVisible(sys, rank, t, must));
    assert.ok(!v[0] || v[1], `${what}: low に居て mid に居ない`);
    assert.ok(!v[1] || v[2], `${what}: mid に居て high に居ない`);
    assert.ok(v[2], `${what}: high で描かれない`);
    if (must) assert.ok(v[0], `${what}: 当たりがあるのに low で描かれない`);
    return v;
  };
  const T = A.trees;
  const tally = { low: 0, mid: 0, high: 0 };
  for (let i = 0; i < T.count; i++) {
    const v = check('trees', T.rank[i], !!T.mustDraw[i], `tree ${i}`);
    TIERS.forEach((t, k) => { if (v[k]) tally[t]++; });
    if (T.mustDraw[i]) assert.equal(T.collide[i], 1, 'mustDraw なのに当たりが無い');
  }
  for (const b of A.boulders) check('boulders', b.rank, !!b.collide, 'boulder');
  for (const b of A.thicket) check('thicket', b.rank, true, 'thicket');
  for (const k of ['cobbles', 'reeds', 'lilies', 'weeds', 'driftwood']) for (const o of A[k]) check(k, o.rank, false, k);
  assert.ok(tally.low < tally.mid && tally.mid < tally.high, `木の本数が品質で増えない ${JSON.stringify(tally)}`);
  console.log(`  木（描く本数） low ${tally.low} / mid ${tally.mid} / high ${tally.high}`);
}

/* --- 世界に固定した格子：セルの乱数は (系統, i, j) だけで決まる --- */
{
  const s = stream(lake.seed, 'trees');
  const seq = cellSeq();
  for (const [i, j] of [[0, 0], [5, -3], [-40, 17], [113, 113]]) {
    const a = cellRng(s, i, j), b = seq.reset(s, i, j);
    for (let k = 0; k < 8; k++) assert.equal(a(), b(), 'cellSeq と cellRng の列が違う');
  }
  assert.notEqual(hashCell(s, 1, 2), hashCell(s, 2, 1), 'セルのハッシュが対称');
  /* 木の位置は所属セルの中にあり、そのセルの乱数の最初の 2 つで決まる */
  const T = A.trees, c = CELLS.tree;
  let checked = 0;
  for (let n = 0; n < T.count && checked < 400; n++) {
    if (T.zone[n] === 2) continue;   // 植林は区画の列植の格子
    const i = Math.floor(T.x[n] / c), j = Math.floor(T.z[n] / c);
    const r = cellRng(s, i, j);
    const x = (i + 0.15 + 0.7 * r()) * c, z = (j + 0.15 + 0.7 * r()) * c;
    assert.equal(Math.fround(x), T.x[n], '木の位置がセルの乱数から決まっていない');
    assert.equal(Math.fround(z), T.z[n], '木の位置がセルの乱数から決まっていない');
    checked++;
  }
}

/* --- Math.random の不使用（src/world と src/gfx。コメントは除く） --- */
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const hits = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name) && /Math\.random/.test(strip(fs.readFileSync(p, 'utf8')))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'src/world'));
  walk(path.join(ROOT, 'src/gfx'));
  assert.deepEqual(hits, [], `Math.random を使っている: ${hits.join(', ')}`);
}

/* --- 予算 ---
   壁時計は同じ機械で他の作業（ブラウザの撮影など）が走っていると大きく揺れるので、
   このプロセスの CPU 時間で測る。250ms を超えたら警告、1s を超えたら失敗 */
{
  const ts = [];
  for (let k = 0; k < 3; k++) {
    const c0 = process.cpuUsage();
    buildPlacement(lake, q);
    const c = process.cpuUsage(c0);
    ts.push((c.user + c.system) / 1000);
  }
  ts.sort((a, b) => a - b);
  const med = ts[1];
  assert.ok(med < 1000, `配置が遅すぎる（CPU ${med.toFixed(0)}ms）`);
  if (med > 250) console.warn(`  警告：配置 CPU ${med.toFixed(0)}ms（予算 250ms）`);
  console.log(`  配置 CPU ${med.toFixed(0)}ms（中央値） ${JSON.stringify(Object.fromEntries(Object.entries(A.stats.sections).map(([k, v]) => [k, Math.round(v)])))}`);
}

console.log('placement-determinism-test: ok');
