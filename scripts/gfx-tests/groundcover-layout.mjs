/* groundcover の純関数の検査（src/gfx/groundcover/quality.js・clump.glsl.js、three 無し）
   - gcLayout：段ごとの領域が重ならずに行へ並び、RT（GC_TEX_W × 全段の最大の行数）に収まる。§7 の本数・距離の目安
   - 遠い草の内の帯 = 近い草の外の帯（縮み合う）、外側の r1 が §7 の半径に届く、リングの一辺がそれを覆う
   - gcCellOf：セルの世界の番号はカメラがセルの中で動いても変わらない（株が滑らない）
   - gcWindow：窓はリングの中、視錐台の足跡（深さ r1）を覆う、透視でなければリング全体
   - gcWeightsGLSL：terrain の coverRules の形を写す／スタブなら既定へ戻る（GLSL の文字列の形だけ） */
import assert from 'node:assert/strict';
import { GC_QUALITY, GC_TEX_W, GC_TPL, gcLayout, gcCellOf, gcWindow, gcFootprint } from '../../src/gfx/groundcover/quality.js';
import { gcWeightsGLSL, GC_MAX_REGIONS } from '../../src/gfx/groundcover/clump.glsl.js';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

/* §7：草 low 4k 株 / 18m、mid 12k / 25m、high 25k / 32m（株の数はリングのセルの数 = 窓の上限） */
const TARGET = { low: { clumps: 4000, r: 18 }, mid: { clumps: 12000, r: 25 }, high: { clumps: 25000, r: 32 } };
const maxRows = Math.max(...Object.keys(GC_QUALITY).map((t) => gcLayout(t).rows));
for (const tier of ['low', 'mid', 'high']) {
  const L = gcLayout(tier);
  ok(L.regions.length <= GC_MAX_REGIONS, `${tier}: 領域 ${L.regions.length} ≤ ${GC_MAX_REGIONS}`);
  let row = 0;
  for (const r of L.regions) {
    ok(r.row0 === row, `${tier}/${r.name}: 行が詰めて並ぶ`);
    ok(r.rows * GC_TEX_W >= r.cells, `${tier}/${r.name}: 行が足りる`);
    ok(r.n * r.c >= r.r1 - 1e-9, `${tier}/${r.name}: リングの半辺 ${r.n * r.c} ≥ r1 ${r.r1}`);
    ok(r.fade > 0 && r.fade < r.r1, `${tier}/${r.name}: 外の帯`);
    row += r.rows;
  }
  ok(L.rows <= maxRows, `${tier}: RT の行に収まる`);
  const grass = L.regions.filter((r) => r.sys === 0);
  const cells = grass.reduce((a, r) => a + r.cells, 0);
  const t = TARGET[tier];
  ok(cells >= t.clumps * 0.9 && cells <= t.clumps * 1.6, `${tier}: 草の株 ${cells}（目安 ${t.clumps}）`);
  const outer = Math.max(...grass.map((r) => r.r1));
  ok(Math.abs(outer - t.r) <= 1.5, `${tier}: 草の外縁 ${outer}m（目安 ${t.r}m）`);
  /* 近い草の外の帯と遠い草の内の帯が重なる（縮み合う、穴を作らない） */
  const near = grass.find((r) => r.r0 === 0), far = grass.find((r) => r.r0 > 0);
  ok(near && far && far.r0 < near.r1 && far.r0 >= near.r1 - near.fade - 1e-9, `${tier}: 近い草と遠い草の渡りの帯`);
  /* 遠い草はセルが大きい（株を減らし刃を太く） */
  ok(far.c > near.c && far.tpl === 'far', `${tier}: 遠い草は疎らで太い型板`);
}
/* 笹・シダの段の密度（§7：30 / 60 / 100%） */
ok(GC_QUALITY.low.plants.density === 0.3 && GC_QUALITY.mid.plants.density === 0.6 && GC_QUALITY.high.plants.density === 1.0, '笹・シダの段の密度');
/* 小物は半径 15m（high） */
ok(GC_QUALITY.high.debris.r1 === 15, '小物の半径 15m');
ok(GC_TPL.near.blades === 8 && GC_TPL.near.nodes === 5, '1 株 8 枚 × 5 節');

/* gcCellOf：カメラがセルの中で動いても同じ番号のセルは同じ世界のセル */
for (const c of [0.25, 0.5, 0.9]) {
  const a = gcCellOf(1234, 48, c, 10.01, -3.02), b = gcCellOf(1234, 48, c, 10.01 + c * 0.3 - (10.01 % c > c * 0.6 ? c * 0.35 : 0), -3.02);
  void b;
  const base = gcCellOf(0, 48, c, Math.floor(10.01 / c) * c + 1e-6, 0);
  const moved = gcCellOf(0, 48, c, Math.floor(10.01 / c) * c + c * 0.99, 0);
  ok(base.gx === moved.gx && base.gz === moved.gz, `セル ${c}m：セルの中の移動で番号が変わらない`);
  ok(Number.isInteger(a.gx) && Number.isInteger(a.gz), `セル ${c}m：整数の番号`);
}

/* gcWindow：偽のカメラ（three 無し）。matrixWorld は列優先の 4×4 */
function fakeCam(px, py, pz, yaw, pitch, fov = 50, aspect = 16 / 9) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  /* 前 = (−sin yaw·cos p, sin p, −cos yaw·cos p)、three の −Z が前 */
  const fwd = [-sy * cp, sp, -cy * cp], right = [cy, 0, -sy];
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const e = [right[0], right[1], right[2], 0, up[0], up[1], up[2], 0, -fwd[0], -fwd[1], -fwd[2], 0, px, py, pz, 1];
  return { isPerspectiveCamera: true, fov, aspect, near: 0.1, matrixWorld: { elements: e }, position: { x: px, y: py, z: pz } };
}
for (const tier of ['low', 'mid', 'high']) {
  for (const r of gcLayout(tier).regions) {
    for (const [yaw, pitch] of [[0, -0.2], [1.3, -0.5], [-2.4, 0.1], [3.0, -1.4]]) {
      const cam = fakeCam(37.3, 3.1, -12.7, yaw, pitch);
      const w = gcWindow(cam, r.c, r.n, r.r1 + 1.5, 1.5);
      const side = 2 * r.n;
      ok(w.ox >= 0 && w.oz >= 0 && w.ox + w.w <= side && w.oz + w.h <= side, `${tier}/${r.name}: 窓はリングの中`);
      ok(w.w * w.h <= side * side && w.w * w.h > 0, `${tier}/${r.name}: 窓の大きさ`);
      /* 足跡の 8 隅のうちリングの中にある物は窓の中 */
      const fp = gcFootprint(cam, r.r1 + 1.5);
      const gx0 = Math.floor(cam.position.x / r.c) - r.n, gz0 = Math.floor(cam.position.z / r.c) - r.n;
      for (const x of [fp.minX, fp.maxX]) for (const z of [fp.minZ, fp.maxZ]) {
        const ix = Math.floor(x / r.c) - gx0, iz = Math.floor(z / r.c) - gz0;
        if (ix < 0 || iz < 0 || ix >= side || iz >= side) continue;
        ok(ix >= w.ox && ix < w.ox + w.w && iz >= w.oz && iz < w.oz + w.h, `${tier}/${r.name}: 足跡の隅が窓の中`);
      }
    }
  }
}
const ortho = gcWindow({ isPerspectiveCamera: false, position: { x: 0, z: 0 } }, 0.5, 10, 30);
ok(ortho.w === 20 && ortho.h === 20, '透視でなければリング全体');

/* gcWeightsGLSL */
const stub = gcWeightsGLSL('float ngGroundKind(vec3 p) { return 0.0; }\n');
ok(stub.mode === 'cover' && stub.glsl.includes('void ngGcWeights('), 'スタブの coverRules → 既定の被覆');
const kindOnly = gcWeightsGLSL('float ngGroundKind(vec3 p) { return p.y > 1.0 ? 3.0 : 4.0; }\n');
ok(kindOnly.mode === 'kind' && kindOnly.glsl.includes('void ngGcWeights('), '種類だけの coverRules → 片側 1');
const full = gcWeightsGLSL(`void ngTerrWeights(vec3 P, vec3 Ng, float sd, vec4 bed, vec2 cn, float trail, out vec4 wA, out vec4 wB) { wA = vec4(1.0); wB = vec4(0.0); }
float ngGroundKind(vec3 p) {
  vec4 wA, wB;
  ngTerrWeights(p, vec3(0.0, 1.0, 0.0), 1.0, vec4(0.0), vec2(0.0), 0.0, wA, wB);
  return 1.0;
}
`);
ok(full.mode === 'weights' && /void ngGcWeights\(vec3 p, out vec4 wA, out vec4 wB\) \{[\s\S]*ngTerrWeights\(p,/.test(full.glsl), 'terrain の重みの関数を写す');
ok(gcWeightsGLSL(undefined).mode === 'cover', 'coverRules が無い');

console.log(`groundcover-layout: ${n} 件 OK`);
