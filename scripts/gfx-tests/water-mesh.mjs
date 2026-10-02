/* water の水面のリングの検査（src/gfx/water/mesh.js、three 無し：最小の偽の T で組む）
   - ringPlan：3 段で ±512m に届く、内側の穴の縁が外側のセルの整数倍、セルの比は 2 か 4
   - buildRings：外縁の頂点（aEdge.z > 0）は外側のリングの辺の上（S の倍数の間）にあり、
     外側のリングの内縁の頂点は内側のリングの頂点と重なる（T 字の継ぎ目に隙間を作らない）
   - 穴の中に三角形を作らない・三角形がリングの間で重ならない（面積の和 = (2E)²）
   - 頂点数・三角形の数の上限（high ≤ 100k 頂点） */
import assert from 'node:assert/strict';
import { ringPlan, buildRings } from '../../src/gfx/water/mesh.js';
import { WATER_TIERS } from '../../src/gfx/water/quality.js';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

class Attr { constructor(a, s) { this.array = Float32Array.from(a); this.itemSize = s; } }
class UAttr { constructor(a, s) { this.array = Uint32Array.from(a); this.itemSize = s; } }
class Geo {
  setAttribute(k, a) { this[k] = a; return this; }
  setIndex(i) { this.index = Array.isArray(i) ? { array: i } : i; }
}
const T = { BufferGeometry: Geo, Float32BufferAttribute: Attr, Uint32BufferAttribute: UAttr, Sphere: class {}, Vector3: class {} };

for (const [tier, q] of Object.entries(WATER_TIERS)) {
  const plan = ringPlan(q.gridN, q.cell, { fine: q.fine, nMin: q.gridN / 4, reach: 512 });
  ok(plan[plan.length - 1].E >= 512, `${tier}: ±${plan[plan.length - 1].E}m まで届く`);
  for (let k = 1; k < plan.length; k++) {
    const r = plan[k].s / plan[k - 1].s;
    ok(r === 2 || r === 4, `${tier}: リング ${k} のセルの比 ${r}`);
    ok(Number.isInteger(plan[k - 1].E / plan[k].s), `${tier}: リング ${k} の穴の縁がセルの整数倍`);
    ok(Math.abs(plan[k].n * plan[k].s - 2 * plan[k].E) < 1e-9, `${tier}: リング ${k} の一辺`);
    if (k <= q.fine) ok(r === 2, `${tier}: fine のリング ${k} は 2 倍`);
  }
  const g = buildRings(T, plan);
  const P = g.position.array, E = g.aEdge.array, I = g.index.array;
  const nv = P.length / 3;
  ok(nv <= 100000, `${tier}: 頂点 ${nv} ≤ 100k`);
  /* 外縁の頂点：外側のリングの辺の上 */
  let edges = 0;
  for (let v = 0; v < nv; v++) {
    const S = E[v * 3 + 2];
    if (!(S > 0)) continue;
    edges++;
    const x = P[v * 3], z = P[v * 3 + 2], ex = E[v * 3], ez = E[v * 3 + 1];
    const u = ex ? x : z, w = ex ? z : x;
    const ring = plan.findIndex((r) => Math.abs(Math.abs(w) - r.E) < 1e-6);
    ok(ring >= 0 && ring + 1 < plan.length && Math.abs(plan[ring + 1].s - S) < 1e-9, `${tier}: 外縁の頂点 (${x}, ${z}) の S`);
    ok(Math.abs(u / S - Math.round(u / S)) > 1e-6, `${tier}: 外縁の頂点 (${x}, ${z}) は外側の頂点と重ならない`);
  }
  ok(edges > 0, `${tier}: 外縁の頂点がある（${edges}）`);
  /* 面積の和 = (2E)²（穴と重なりが無い） */
  let area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    area += Math.abs((P[b] - P[a]) * (P[c + 2] - P[a + 2]) - (P[c] - P[a]) * (P[b + 2] - P[a + 2])) / 2;
  }
  const want = (2 * plan[plan.length - 1].E) ** 2;
  ok(Math.abs(area - want) / want < 1e-9, `${tier}: 面積 ${area} = ${want}`);
}

console.log(`water-mesh: ${n} 件合格`);
