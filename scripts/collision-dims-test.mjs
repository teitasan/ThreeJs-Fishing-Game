#!/usr/bin/env node
/**
 * 当たりの寸法と、配置の対応（契約 §5・ARCHITECTURE §5.2）。
 *
 * - 幹：r = max(trunkR·h·1.15, 0.28)、上端 = y + 0.9h、y = 地面 − 0.15。帯 + 20m の中だけ当たり
 * - 大岩：size > 1.4 かつ h > −0.9 だけが当たり。r = 見た目の半径 × 1.05、上端 = 見た目の上端
 * - 灯籠 r0.26・上端 dockY + 2.3、小舟 r0.85 の円 2 つ
 * - 藪の輪：shoreRadius + 67〜76、r0.55
 * - 木は桟橋から 3.6m・スポーンから 6m、岩は桟橋から 3.4m・スポーンから 6m 空ける
 * - ストラクチャーは lake.structures の x, z に正確に（当たり r·1.15、上端 = 湖底 + h）
 * - ヨシは isEdge の上だけ・縁に 10m を超える空白を作らない、藻は lake.flats の中だけで 95% 以上を覆う
 * - 障害物の半径は 8m ハッシュが拾える 7.6m 未満
 */
import assert from 'node:assert/strict';
import { loadFacades } from './facade-harness/index.mjs';

const F = await loadFacades();
const { THREE, Terrain } = F;
const { resolveLake } = await import('../src/lakefield.js');
const { isEdge, FAR_GATE, MUST_DRAW_GATE, WALK_INLAND } = await import('../src/world/placement.js');
const { SPECIES, SPECIES_IDS, TRUNK_R_MIN } = await import('../src/world/species.js');
const { OBS_R_MAX } = await import('../src/world/collision.js');

/* --- 樹種表そのもの --- */
assert.equal(SPECIES_IDS.length, 8, '樹種は 8 つ');
for (const id of SPECIES_IDS) {
  const s = SPECIES[id];
  assert.equal(s.trunkR.length, 4, `${id}: variant ごとの幹の太さ`);
  assert.ok(s.heights[0] > 3 && s.heights[1] <= 40 && s.heights[0] < s.heights[1], `${id}: 樹高`);
  for (const r of s.trunkR) assert.ok(r > 0.005 && r < 0.04, `${id}: 幹の太さの比 ${r}`);
}
assert.ok(SPECIES.sugi.heights[1] > SPECIES.momiji.heights[1] * 2, 'スギはモミジよりずっと高い');
assert.ok(SPECIES.yanagi.riparian && SPECIES.hannoki.riparian, 'ヤナギ・ハンノキは水辺の木');

for (const seed of [123456789, 20240711]) {
  const lake = resolveLake(seed).lake;
  const t = new Terrain(new THREE.Scene(), { quality: 'mid', lake, grids: false });
  const P = t.placement;
  const sp = t.spawnPos;
  const obs = t.obstacles;
  const hasObstacle = (x, z, r, top, eps = 1e-6) => {
    for (let i = 0; i < obs.length; i += 4) {
      if (Math.abs(obs[i] - x) < eps && Math.abs(obs[i + 1] - z) < eps && Math.abs(obs[i + 2] - r) < eps && Math.abs(obs[i + 3] - top) < eps) return true;
    }
    return false;
  };
  for (let i = 2; i < obs.length; i += 4) assert.ok(obs[i] > 0 && obs[i] < OBS_R_MAX, `障害物の半径 ${obs[i]}`);

  /* --- 幹 --- */
  {
    const T = P.trees;
    let n = 0;
    for (let i = 0; i < T.count; i++) {
      const s = SPECIES[SPECIES_IDS[T.species[i]]];
      const want = Math.max(s.trunkR[T.variant[i]] * T.h[i] * 1.15, TRUNK_R_MIN);
      assert.ok(Math.abs(T.r[i] - want) < 1e-5, `幹の半径 ${T.r[i]} ≠ ${want}`);
      assert.ok(Math.abs(T.top[i] - (T.y[i] + 0.9 * T.h[i])) < 1e-4, '幹の上端 = y + 0.9h');
      assert.ok(Math.abs(T.y[i] - (t.heightAt(T.x[i], T.z[i]) - 0.15)) < 1e-4, '根元 = 地面 − 0.15');
      assert.ok(T.h[i] >= s.heights[0] * 0.3 * 0.6 - 1e-3 && T.h[i] <= s.heights[1] * 1.3 + 1e-3, `樹高 ${T.h[i]}`);
      assert.ok(t.heightAt(T.x[i], T.z[i]) >= 1.6, '木は h ≥ 1.6');
      assert.ok(t.slopeAt(T.x[i], T.z[i]) <= 0.78 + 1e-6, '木は傾斜 ≤ 0.78');
      assert.ok(t.distToDock(T.x[i], T.z[i]) >= 3.6 - 1e-4, '木が桟橋に近い');
      assert.ok(Math.hypot(T.x[i] - sp.x, T.z[i] - sp.z) >= 6 - 1e-4, '木がスポーンに近い');
      assert.equal(T.collide[i], T.bandD[i] <= FAR_GATE ? 1 : 0, '当たりは帯 + FAR_GATE の中だけ');
      assert.equal(T.mustDraw[i], T.collide[i] && T.bandD[i] <= MUST_DRAW_GATE ? 1 : 0, 'mustDraw');
      const radial = Math.hypot(T.x[i], T.z[i]) - t.shoreRadius(T.x[i], T.z[i]) - WALK_INLAND;
      if (radial <= 0) assert.equal(T.collide[i], 1, '帯の中の木は必ず当たりを持つ');
      assert.ok(T.bandD[i] <= Math.max(radial, 0) + 1e-3, '帯までの距離は半径方向の差以下');
      if (T.collide[i]) {
        assert.ok(hasObstacle(T.x[i], T.z[i], T.r[i], T.top[i], 1e-9), '幹の当たりが積まれていない');
        n++;
      }
    }
    assert.ok(n > 1000, `当たりのある木が少ない（${n}）`);
    const zones = new Set(T.zone);
    for (const z of [0, 1, 2, 3, 4]) assert.ok(zones.has(z), `生態区分 ${z} の木が無い`);
    const species = new Set(T.species);
    assert.equal(species.size, 8, `8 樹種すべてが立っていない（${[...species]}）`);
  }

  /* --- 大岩 --- */
  {
    let nc = 0;
    for (const b of P.boulders) {
      const h = t.heightAt(b.x, b.z);
      assert.equal(b.collide, b.size > 1.4 && h > -0.9 ? 1 : 0, '大岩の当たりの規則');
      assert.ok(Math.abs(b.r - 0.40 * b.size * Math.max(b.sx, b.sz) * 1.05) < 1e-9, '大岩の半径 = 見た目 × 1.05');
      assert.ok(Math.abs(b.top - (b.y + b.size * b.sy)) < 1e-9, '大岩の上端 = 見た目の上端');
      assert.ok(b.y < h, '大岩は少し埋める');
      assert.ok(t.distToDock(b.x, b.z) >= 3.4 - 1e-9, '岩が桟橋に近い');
      assert.ok(Math.hypot(b.x - sp.x, b.z - sp.z) >= 6 - 1e-9, '岩がスポーンに近い');
      if (b.collide) { assert.ok(hasObstacle(b.x, b.z, b.r, b.top), '大岩の当たりが積まれていない'); nc++; }
    }
    assert.ok(nc > 50, `当たりのある大岩が少ない（${nc}）`);
    for (const c of P.cobbles) {
      assert.ok(t.distToDock(c.x, c.z) >= 2.5 - 1e-9, '玉石が桟橋に近い');
    }
  }

  /* --- 灯籠・小舟 --- */
  assert.equal(P.lamp.r, 0.26);
  assert.ok(Math.abs(P.lamp.top - (t.dockY + 2.3)) < 1e-12, '灯籠の上端');
  assert.ok(hasObstacle(P.lamp.x, P.lamp.z, 0.26, t.dockY + 2.3), '灯籠の当たり');
  assert.equal(P.boat.circles.length, 2, '小舟の当たりは円 2 つ');
  for (const c of P.boat.circles) {
    assert.equal(c.r, 0.85);
    assert.ok(hasObstacle(c.x, c.z, 0.85, c.top), '小舟の当たり');
  }
  assert.ok(Math.abs(Math.hypot(P.boat.circles[0].x - P.boat.circles[1].x, P.boat.circles[0].z - P.boat.circles[1].z) - 1.8) < 1e-9, '小舟の円の間隔');

  /* --- 藪の輪 --- */
  for (const b of P.thicket) {
    const d = Math.hypot(b.x, b.z) - t.shoreRadius(b.x, b.z);
    assert.ok(d >= WALK_INLAND - 5 - 1e-6 && d <= WALK_INLAND + 4 + 1e-6, `藪の輪の半径 ${d}`);
    assert.equal(b.r, 0.55);
    assert.ok(hasObstacle(b.x, b.z, 0.55, b.top), '藪の当たり');
  }

  /* --- ストラクチャー --- */
  assert.equal(P.structures, lake.structures, 'placement.structures は lake.structures そのもの');
  for (const s of lake.structures) {
    assert.ok(hasObstacle(s.x, s.z, s.r * 1.15, t.heightAt(s.x, s.z) + s.h, 1e-12), 'ストラクチャーの当たり');
    assert.ok(t.heightAt(s.x, s.z) + s.h < -0.5 + 1e-9, 'ストラクチャーは水面より 0.5m 以上下');
  }

  /* --- ヨシ（葦際） --- */
  {
    for (const r of P.reeds) {
      assert.ok(isEdge(r.x, r.z, t), 'ヨシが葦際の外にある');
      assert.ok(t.distToDock(r.x, r.z) >= 6, 'ヨシが桟橋の回廊にある');
      assert.ok(r.depth <= 1.5 && r.depth > 0.05, 'ヨシの水深');
    }
    /* 汀線に沿った空白：10m を超えるのは、候補の無い所（桟橋の回廊・急な岸）だけ */
    const ang = P.reeds.map((r) => ({ a: Math.atan2(r.z, r.x), r: Math.hypot(r.x, r.z) })).sort((p, q) => p.a - q.a);
    let bigGaps = 0, maxGap = 0;
    for (let i = 0; i < ang.length; i++) {
      const p = ang[i], q = ang[(i + 1) % ang.length];
      const da = ((q.a - p.a) + Math.PI * 2) % (Math.PI * 2);
      const gap = da * p.r;
      if (gap <= 10) continue;
      /* 空白の中に葦際の点があるか（0.5m 刻みで弧に沿って、汀線の内外 −13〜+4m を探す） */
      let edgeInGap = 0;
      for (let s = 1; s < gap - 1; s += 0.5) {
        const a = p.a + s / p.r;
        const sr = lake.shoreAtAngle(a);
        for (let dr = -13; dr <= 4; dr += 0.5) {
          const x = Math.cos(a) * (sr + dr), z = Math.sin(a) * (sr + dr);
          if (isEdge(x, z, t) && t.distToDock(x, z) >= 6 && Math.hypot(x - sp.x, z - sp.z) >= 6) edgeInGap++;
        }
      }
      /* 格子の候補点に当たらない細い葦際は拾えないので、数点までは許す */
      if (edgeInGap > 12) { bigGaps++; maxGap = Math.max(maxGap, gap); }
    }
    assert.equal(bigGaps, 0, `葦際に 10m を超える空白が ${bigGaps} か所（最大 ${maxGap.toFixed(1)}m）`);
  }

  /* --- 藻（藻場 = lake.flats） --- */
  {
    const inFlat = (x, z) => lake.flats.some((f) => Math.hypot(x - f.x, z - f.z) <= f.r + 1e-9);
    for (const w of P.weeds) assert.ok(inFlat(w.x, w.z), '藻が藻場の外にある');
    const cell = new Map();
    for (const w of P.weeds) {
      const k = `${Math.floor(w.x / 2)},${Math.floor(w.z / 2)}`;
      if (!cell.has(k)) cell.set(k, []);
      cell.get(k).push(w);
    }
    const nearWeed = (x, z) => {
      const cx = Math.floor(x / 2), cz = Math.floor(z / 2);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        for (const w of cell.get(`${cx + dx},${cz + dz}`) || []) if (Math.hypot(w.x - x, w.z - z) < 2) return true;
      }
      return false;
    };
    for (const f of lake.flats) {
      let n = 0, hit = 0;
      for (let k = 0; k < 800; k++) {
        const a = k * 2.399963, rr = f.r * Math.sqrt((k + 0.5) / 800);
        const x = f.x + Math.cos(a) * rr, z = f.z + Math.sin(a) * rr;
        const d = t.depthAt(x, z);
        if (d < 0.5 || d > 6) continue;   // 浅すぎ・深すぎは藻の領分の外
        n++;
        if (nearWeed(x, z)) hit++;
      }
      assert.ok(n === 0 || hit / n >= 0.95, `藻場 (${f.x.toFixed(0)}, ${f.z.toFixed(0)}) の被覆 ${(100 * hit / n).toFixed(1)}%`);
    }
  }

  /* --- 睡蓮 --- */
  for (const l of P.lilies) {
    assert.ok(l.depth >= 0.4 && l.depth <= 2.2, '睡蓮の水深');
    assert.ok(t.distToDock(l.x, l.z) >= 8, '睡蓮が桟橋の回廊にある');
  }
  console.log(`  seed ${seed}: 木 ${P.trees.count}・大岩 ${P.boulders.length}・藪 ${P.thicket.length}・ヨシ ${P.reeds.length}・藻 ${P.weeds.length}・睡蓮 ${P.lilies.length}`);
}

console.log('collision-dims-test: ok');
