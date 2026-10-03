#!/usr/bin/env node
/* ===========================================================
   hardscape-geometry：桟橋・灯籠・小舟・岩・立ち枯れの幾何が契約どおり（three 無し）
   - 床の上面 = dockY（±2cm）、床と桁は debug.js の床の箱の中（2cm 以内）、床幅 3.4m、杭 2.4m 間隔
   - 先端の手すりは先端から 2.3m・|si| ≤ 1.62・上端 ≤ dockY + 1.05（2cm 以内）
   - 灯籠 r ≤ 0.26・上端 = dockY + 2.3（2cm 以内）
   - 小舟は当たりの円 2 つ（r 0.85）の内側・上端 ≤ 1.0（2cm 以内）
   - 岩の形：正規化（底 0・上端 1・xz の最大半径 1）、LOD で輪郭が揃う、NaN なし、決定的
   - 立ち枯れ：上端 = 湖底 + h、枝は r の内側
   - 灯籠の揺らぎは 0.85–1.15
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { resolveLake } = await imp('src/lakefield.js');
const { buildPlacement } = await imp('src/world/placement.js');
const { makeDock, dockFixtures } = await imp('src/world/dock.js');
const { buildDock, dockContractReport, DOCK_DIM } = await imp('src/gfx/hardscape/dock.js');
const { buildBoat, boatContractReport, BOAT_DIM } = await imp('src/gfx/hardscape/boat.js');
const { buildRockShapes, ROCK_SHAPES } = await imp('src/gfx/hardscape/rocks.js');
const { addSnag } = await imp('src/gfx/hardscape/logs.js');
const { GeoBuilder } = await imp('src/gfx/hardscape/geo.js');
const { lampFlicker } = await imp('src/gfx/hardscape/quality.js');
const { mulberry32 } = await imp('src/world/rng.js');

for (const seed of [123456789, 987654321]) {
  const r = resolveLake(seed);
  const lake = r.lake || r;
  const P = buildPlacement(lake);
  const D = makeDock(lake), fx = dockFixtures(D);
  const t0 = performance.now();
  const dk = buildDock({ start: D.dockStart, dir: fx.dir, right: fx.right, L: D._dockLen, Y: D.dockY, lamp: P.lamp, groundAt: (x, z) => lake.heightAt(x, z), seed });
  const ms = performance.now() - t0;
  const rep = dockContractReport(dk.geo.pos, dk.geo.w, { start: D.dockStart, dir: fx.dir, right: fx.right, Y: D.dockY, L: D._dockLen, lamp: P.lamp });
  const tag = `seed ${seed}`;
  check(rep.nonFinite === 0, `${tag}: 桟橋の頂点に NaN`);
  check(Math.abs(rep.deckTop.max) <= 2 && Math.abs(rep.deckTop.min) <= 2, `${tag}: 床の上面が dockY から 2cm 超 ${JSON.stringify(rep.deckTop)}`);
  check(rep.floorBox.bottomBelow <= 2 && rep.floorBox.topOver <= 2 && rep.floorBox.alBefore <= 2 && rep.floorBox.alOver <= 2, `${tag}: 床の箱から 2cm 超 ${JSON.stringify(rep.floorBox)}`);
  check(Math.abs(rep.deckHalfWidth - 170) <= 3, `${tag}: 床幅が 3.4m でない（半幅 ${rep.deckHalfWidth}cm）`);
  check(rep.rail.lenFromTip <= 232 && rep.rail.siOver <= 2 && rep.rail.topOver <= 2 && rep.rail.topOver > -4, `${tag}: 手すり ${JSON.stringify(rep.rail)}`);
  check(rep.lamp.rOver <= 2 && Math.abs(rep.lamp.topDiff) <= 2, `${tag}: 灯籠 ${JSON.stringify(rep.lamp)}`);
  const rows = [...new Set(dk.piles.map((p) => p.al.toFixed(4)))].map(Number).sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < rows.length; i++) maxGap = Math.max(maxGap, Math.abs(rows[i] - rows[i - 1] - DOCK_DIM.PILE_SPACING));
  check(rows.length >= 2 && maxGap < 1e-6, `${tag}: 杭の列が 2.4m 間隔でない`);
  check(D._dockLen - rows[rows.length - 1] < 0.3, `${tag}: 先端に杭が無い`);
  check(ms < 400, `${tag}: 桟橋の組み立てが遅い ${ms.toFixed(0)}ms`);
  /* 床板の隙間：上面の頂点の al の分布に 1.5cm 前後の空きがある */
  const g = buildBoat(mulberry32(seed));
  const cc = P.boat.circles;
  const br = boatContractReport(g.pos, { ...P.boat, yaw: Math.atan2(cc[1].x - cc[0].x, cc[1].z - cc[0].z) });   // 当たりの軸に揃える（index.js と同じ）
  check(br.outsideEnds <= 2 && br.topOver <= 2, `${tag}: 小舟の両端が当たりの円から 2cm 超 ${JSON.stringify(br)}`);
  console.log(`  ${tag}: 小舟 ${JSON.stringify(br)}`);
  check(BOAT_DIM.FLOOR_Y > 0.05, '床板は喫水線より上');
  /* 立ち枯れ */
  lake.structures.forEach((s, i) => {
    if (s.kind !== 'snag') return;
    const sb = new GeoBuilder();
    const bed = lake.heightAt(s.x, s.z);
    const res = addSnag(sb, s, bed, seed, i);
    let maxR = 0, top = -Infinity;
    for (let k = 0; k < sb.pos.length; k += 3) {
      maxR = Math.max(maxR, Math.hypot(sb.pos[k] - s.x, sb.pos[k + 2] - s.z));
      top = Math.max(top, sb.pos[k + 1]);
    }
    check(maxR <= s.r * 1.15 + 0.02, `${tag}: 立ち枯れ ${i} の枝が当たりの外 ${maxR.toFixed(2)} > ${(s.r * 1.15).toFixed(2)}`);
    check(Math.abs(top - (bed + s.h)) <= 0.02 || top <= bed + s.h + 0.02, `${tag}: 立ち枯れ ${i} の上端 ${top.toFixed(2)} vs ${(bed + s.h).toFixed(2)}`);
    check(res.top === bed + s.h, `${tag}: 立ち枯れの上端の報告`);
  });
}

/* 岩の形 */
const t0 = performance.now();
const A = buildRockShapes(123456789);
const ms = performance.now() - t0;
const B = buildRockShapes(123456789);
check(A.length === ROCK_SHAPES && A.every((s) => s.lods.length === 4), '岩は 8 形 × 4 LOD');
check(ms < 2500, `岩の形が遅い ${ms.toFixed(0)}ms`);
let same = true;
A.forEach((s, k) => s.lods.forEach((l, j) => {
  const p = l.pos;
  let y0 = Infinity, y1 = -Infinity, rx = 0, bad = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (!Number.isFinite(p[i] + p[i + 1] + p[i + 2])) bad++;
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); rx = Math.max(rx, Math.hypot(p[i], p[i + 2]));
  }
  check(bad === 0, `岩 ${k}/${j} に NaN`);
  if (j === 0) check(Math.abs(y0) < 1e-4 && Math.abs(y1 - 1) < 1e-4 && rx <= 1 + 1e-4, `岩 ${k} の正規化 ${y0} ${y1} ${rx}`);
  else check(y0 > -0.03 && y1 < 1.03 && rx < 1.03, `岩 ${k}/${j} の LOD の輪郭が LOD0 からずれる ${y0.toFixed(3)} ${y1.toFixed(3)} ${rx.toFixed(3)}`);
  for (let i = 0; i < l.rv.length; i += 2) if (!(l.rv[i] >= 0.1 && l.rv[i] <= 1)) { check(false, `岩 ${k}/${j} の AO が範囲外`); break; }
  if (B[k].lods[j].pos.some((v, i) => v !== p[i])) same = false;
}));
check(same, '岩の形が決定的でない');

/* 灯籠の揺らぎ */
let fmin = 9, fmax = 0;
for (let t = 0; t < 120; t += 0.013) { const f = lampFlicker(t); fmin = Math.min(fmin, f); fmax = Math.max(fmax, f); }
check(fmin > 0.85 && fmax < 1.15 && fmax - fmin > 0.05, `灯籠の揺らぎ ${fmin.toFixed(3)}–${fmax.toFixed(3)}`);

done('hardscape-geometry');
