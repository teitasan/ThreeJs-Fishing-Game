#!/usr/bin/env node
/**
 * 新しい Terrain / Water ファサードが、旧グラフィック（c8490ed）の記録（scripts/fixtures）と
 * 1e−9 で一致することの検査。
 *
 * 地形の問い合わせ・底質・法線・桟橋・ストラクチャー・糸の判定（地形だけ）・水面の高さと法線は
 * 旧ロジックの逐語移植なので «同じ値» でなければならない。障害物の中身（木・岩・藪）は
 * 作り直しで意図的に変わるので、糸の判定の «障害物込み» は、旧版で障害物が効かなかった線分だけ
 * «同じか、新しい障害物に当たったか» を見る。灯籠・小舟・ストラクチャーの当たりは同じ規則で残る。
 */
import assert from 'node:assert/strict';
import { loadFacades, fixture } from './facade-harness/index.mjs';

const F = await loadFacades();
const { THREE, Terrain, Water } = F;
const { resolveLake } = await import('../src/lakefield.js');

const EPS = 1e-9;
let compared = 0;
const near = (a, b, what) => {
  compared++;
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= EPS) return;
  assert.fail(`${what}: 新 ${a} ≠ 旧 ${b}`);
};
const eqDeep = (a, b, what) => {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { near(a, b, what); return; }
  if (Array.isArray(b)) {
    assert.equal(a.length, b.length, `${what}: 長さ`);
    b.forEach((v, i) => eqDeep(a[i], v, `${what}[${i}]`));
    return;
  }
  for (const k of Object.keys(b)) eqDeep(a[k], b[k], `${what}.${k}`);
};
const v3 = (v) => [v.x, v.y, v.z];
/* 旧 fixture の JSON では -Infinity が null になっている */
const jsonish = (v) => JSON.parse(JSON.stringify(v));

for (const seed of [123456789, 20240711]) {
  const fx = fixture(`terrain-${seed}.json`);
  const r = resolveLake(seed);
  assert.equal(r.seed, fx.resolvedSeed, '解決後のシードが変わった');
  const t = new Terrain(new THREE.Scene(), { quality: 'low', lake: r.lake });

  /* --- 桟橋の値 --- */
  const D = fx.dock;
  eqDeep(v3(t.dockStart), D.dockStart, 'dockStart');
  eqDeep(v3(t.dockEnd), D.dockEnd, 'dockEnd');
  eqDeep(v3(t.dockDir), D.dockDir, 'dockDir');
  eqDeep(v3(t.spawnPos), D.spawnPos, 'spawnPos');
  near(t.dockY, D.dockY, 'dockY');
  near(t._dockLen, D._dockLen, '_dockLen');
  eqDeep([t._dockU.x, t._dockU.z], D._dockU, '_dockU');
  near(t.dockAngle, D.dockAngle, 'dockAngle');
  near(t.shoreR0, D.shoreR0, 'shoreR0');
  near(t.seed, D.seed, 'seed');
  /* 灯籠と小舟の当たりは旧版と同じ規則・同じ順（障害物の先頭 3 件） */
  const o = t.obstacles;
  eqDeep([o[0], o[1], o[2], o[3]], D.lamp, '灯籠の当たり');
  eqDeep([o[4], o[5], o[6], o[7]], D.boat[0], '小舟の当たり 1');
  eqDeep([o[8], o[9], o[10], o[11]], D.boat[1], '小舟の当たり 2');

  /* --- ストラクチャー --- */
  eqDeep(t.structures, fx.structures, 'structures');
  for (const s of fx.structures) {
    /* 旧版はブラウザ（Chrome の V8）、新版は Node で計算しているので、最後の 1 ulp は
       ずれることがある（Math.sin などの実装差）。比較は 1e−9 で行う */
    const same = (q, x, z, rr, top) => [q[0] - x, q[1] - z, q[2] - rr, q[3] - top].every((d) => Math.abs(d) <= EPS);
    const hit = fx.obstacles.find((q) => Math.abs(q[0] - s.x) <= EPS && Math.abs(q[1] - s.z) <= EPS);
    assert.ok(hit, '旧版の fixture にストラクチャーの当たりが無い');
    let found = false;
    for (let i = 0; i < o.length; i += 4) if (same(hit, o[i], o[i + 1], o[i + 2], o[i + 3])) found = true;
    assert.ok(found, `ストラクチャーの当たりが旧版と違う (${s.x.toFixed(2)}, ${s.z.toFixed(2)})`);
  }

  /* --- 点の問い合わせ --- */
  for (const p of fx.points) {
    const { x, z } = p;
    const w = `seed ${seed} (${x.toFixed(3)}, ${z.toFixed(3)})`;
    near(t.heightAt(x, z), p.h, `heightAt ${w}`);
    near(t.depthAt(x, z), p.d, `depthAt ${w}`);
    near(t.slopeAt(x, z), p.slope, `slopeAt ${w}`);
    near(t.slopeAt(x, z, 0.5), p.slope05, `slopeAt(e=0.5) ${w}`);
    const b = t.bedAt(x, z);
    near(b.v, p.bed[0], `bedAt.v ${w}`);
    near(b.kind, p.bed[1], `bedAt.kind ${w}`);
    eqDeep(v3(t.normalAt(x, z)), p.n, `normalAt ${w}`);
    eqDeep(v3(t.normalAt(x, z, 2)), p.n2, `normalAt(e=2) ${w}`);
    assert.ok(t.normalAt(x, z) instanceof THREE.Vector3, 'normalAt は Vector3');
    near(t.isWater(x, z), p.water, `isWater ${w}`);
    near(t.shoreRadius(x, z), p.shoreR, `shoreRadius ${w}`);
    near(t.onDock(x, z), p.onDock, `onDock ${w}`);
    near(t.distToDock(x, z), p.distToDock, `distToDock ${w}`);
    const l = t._dockLocal(x, z);
    eqDeep([l.al, l.si], p.local, `_dockLocal ${w}`);
    const sn = t.structureNear(x, z), sn2 = t.structureNear(x, z, 2), sn9 = t.structureNear(x, z, 9);
    eqDeep(sn ? [sn.x, sn.z] : null, p.sNear, `structureNear ${w}`);
    eqDeep(sn2 ? [sn2.x, sn2.z] : null, p.sNear2, `structureNear(2) ${w}`);
    eqDeep(sn9 ? [sn9.x, sn9.z] : null, p.sNear9, `structureNear(9) ${w}`);
  }
  for (const p of fx.sPoints) {
    const sn = t.structureNear(p.x, p.z);
    eqDeep(sn ? [sn.x, sn.z] : null, p.sNear, 'structureNear（近傍）');
    if (p.full) eqDeep(sn, p.full, 'structureNear の中身');
  }

  /* --- 線分：桟橋・地形の糸の判定（旧版と完全一致）、障害物込みは «同じか新しい障害物» --- */
  const lb = (s, opts) => t.lineBlocked(s[0], s[1], s[2], s[3], s[4], s[5], opts);
  const variants = (fn) => ({ def: fn(), s62: fn({ tol: 0.22, slack: 0.62 }), s50: fn({ tol: 0.22, slack: 0.5 }), s0: fn({ slack: 0 }) });
  let sameFull = 0, newRock = 0, cmpFull = 0;
  for (const g of fx.segments) {
    const s = g.s;
    near(t.dockBlocksSegment(...s), g.dock, `dockBlocksSegment ${s.map((v) => v.toFixed(2))}`);
    near(t.onDock(s[0], s[2]), g.onDock0, 'onDock（線分の始点）');
    near(t.onDock(s[3], s[5]), g.onDock1, 'onDock（線分の終点）');
    /* 地形だけ（障害物を外す） */
    const orig = t.obstacleTopAt;
    t.obstacleTopAt = () => -Infinity;
    const terr = variants((opts) => lb(s, opts));
    t.obstacleTopAt = orig;
    eqDeep(jsonish(terr), g.terr, `lineBlocked（地形） ${s.map((v) => v.toFixed(2))}`);
    if (!g.obstacleHit) {
      const full = variants((opts) => lb(s, opts));
      for (const k of Object.keys(full)) {
        cmpFull++;
        const a = jsonish(full[k]), b = g.full[k];
        const same = (a === null && b === null) || (a && b && a.kind === b.kind &&
          ['x', 'y', 'z', 'ground'].every((c) => Math.abs(a[c] - b[c]) <= EPS));
        if (same) { sameFull++; continue; }
        /* 違ってよいのは «新しい障害物に先に当たった» ときだけ */
        assert.ok(a && a.kind === 'rock', `lineBlocked（障害物込み）が障害物以外の理由で変わった ${s.map((v) => v.toFixed(2))} ${k}`);
        newRock++;
      }
    }
  }
  assert.ok(sameFull / cmpFull > 0.9, `障害物込みの糸の判定の一致が少なすぎる (${sameFull}/${cmpFull})`);

  /* --- 水面：時刻 × 風 × 点 --- */
  const water = new Water(new THREE.Scene(), t, { quality: 'low' });
  const tmp = new THREE.Vector3();
  for (const row of fx.surface.rows) {
    const [time, wind, x, z, y, nx, ny, nz, n2x, n2y, n2z] = row;
    water.time = time; water.wind = wind;
    near(water.surfaceY(x, z), y, `surfaceY t=${time} w=${wind} (${x.toFixed(2)}, ${z.toFixed(2)})`);
    const n = water.surfaceNormal(x, z, tmp);
    assert.equal(n, tmp, 'surfaceNormal は out に書いて返す');
    eqDeep(v3(n), [nx, ny, nz], 'surfaceNormal');
    const n2 = water.surfaceNormal(x, z);
    assert.ok(n2 instanceof THREE.Vector3, 'surfaceNormal(out 無し) は Vector3');
    eqDeep(v3(n2), [n2x, n2y, n2z], 'surfaceNormal（out 無し）');
  }
  const cam = new THREE.PerspectiveCamera();
  assert.deepEqual(Object.keys(water.getUnderwaterContext(cam)), fx.uwContextKeys, 'getUnderwaterContext のキー');

  console.log(`  seed ${seed}: 点 ${fx.points.length}・線分 ${fx.segments.length}・水面 ${fx.surface.rows.length}` +
    `・障害物込みの糸 ${sameFull}/${cmpFull} 一致（新しい障害物に当たった ${newRock}）`);
  await t.ready;
}

console.log(`terrain-api-parity-test: ok（${compared} 値を比較）`);
