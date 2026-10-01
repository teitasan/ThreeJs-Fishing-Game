/* ===========================================================
   樹種ごとの木の組み立て（決定的・three 無し。正規化単位 = 樹高 1）
   -----------------------------------------------------------
   - 針葉（スギ・ヒノキ）：単軸の幹 + 輪生の枝 + 針葉のスプレー（カード）
   - 広葉（ブナ・ミズナラ・モミジ・ハンノキ）・アカマツ・ヤナギ：空間コロニゼーション
     （Runions 2007）→ パイプモデルの半径 → 太い子を辿る鎖で管に分ける → 末端に葉の房のカード
   幹の胸高の半径は species.js の trunkR（r/H）に正確に合わせる（当たり = 見た目 × 1.15）。
   =========================================================== */
import { SPECIES, SPECIES_IDS } from '../../../src/world/species.js';
import { BARK_LAYERS } from '../../../src/gfx/trees/format.js';
import {
  TAU, clamp, lerp, smooth, add, sub, mul, dot, cross, len, norm, madd, dist, dirAE, rotAxis, perp, rngFor, noise1, TreeBuild,
} from './lib.mjs';

const GOLDEN = 2.399963;
export const BARK = Object.fromEntries(BARK_LAYERS.map((n, i) => [n, i]));
export const LEAF = Object.fromEntries(SPECIES_IDS.map((n, i) => [n, i]));

/** 胸高の平坦部（正規化の高さ）。h = 13〜40m の胸高 1.3m がこの中に入る */
export const BREAST_FLAT = [0.032, 0.10];

/**
 * 幹の半径の形（正規化）：根張り → 胸高の平坦部（= trunkR）→ 梢へ細る
 * @param {number} y 正規化の高さ
 * @param {number} r0 trunkR
 * @param {number} top 幹の上端（正規化）
 * @param {number} flare 根張りの倍率
 */
export function trunkProfile(y, r0, top = 1, flare = 0.42, exp = 0.9) {
  const [f0, f1] = BREAST_FLAT;
  if (y < f0) { const t = 1 - y / f0; return r0 * (1 + flare * t * t * t); }
  if (y <= f1) return r0;
  const t = clamp((top - y) / Math.max(top - f1, 1e-3), 0, 1);
  return r0 * Math.max(Math.pow(t, exp), 0.04);
}

/** 幹の点列（下ほど細かく）。sway(y) → [dx, dz] の曲がり */
function trunkPoints(top, sway, ys = null) {
  const pts = [];
  const list = ys || [0, 0.008, 0.018, 0.032, 0.05, 0.075, 0.1];
  for (const y of list) if (y < top) pts.push(y);
  let y = 0.1;
  while (y < top - 1e-4) { y = Math.min(top, y + 0.045); pts.push(y); }
  if (pts[pts.length - 1] < top) pts.push(top);
  return pts.map((yy) => { const s = sway(yy); return [s[0], yy, s[1]]; });
}

/* ================================================================ 針葉（スギ・ヒノキ） */

function conifer(id, vi) {
  const S = SPECIES[id];
  const hinoki = id === 'hinoki';
  const rng = rngFor(`tree:${id}:${vi}`);
  const H = (S.heights[0] + S.heights[1]) / 2;
  const B = new TreeBuild(H);
  const r0 = S.trunkR[vi];
  const cb = S.crownBase * rng.range(0.9, 1.12);
  const crownR = S.crownR * rng.range(0.9, 1.1);
  const nx = noise1(rng), nz = noise1(rng);
  const sway = (y) => [nx(y * 6) * 0.0035 * y, nz(y * 6) * 0.0035 * y];
  const tp = trunkPoints(0.995, sway);
  const trunkRad = tp.map((p) => trunkProfile(p[1], r0, 1.0, 0.45, 0.95));
  B.tube(tp, trunkRad, { radial: 12, bark: BARK[id], level: 0, flex: tp.map((p) => p[1] * 0.2), uRepeat: 0 });
  B.trunk = { points: tp, radii: trunkRad };
  const trunkAt = (y) => {
    for (let k = 1; k < tp.length; k++) if (tp[k][1] >= y) {
      const t = (y - tp[k - 1][1]) / Math.max(tp[k][1] - tp[k - 1][1], 1e-6);
      return { p: [lerp(tp[k - 1][0], tp[k][0], t), y, lerp(tp[k - 1][2], tp[k][2], t)], r: lerp(trunkRad[k - 1], trunkRad[k], t) };
    }
    return { p: tp[tp.length - 1], r: trunkRad[trunkRad.length - 1] };
  };
  /* 樹冠の半径（円錐。ヒノキは肩が丸い） */
  const Rc = (y) => {
    const t = clamp((1 - y) / (1 - cb), 0, 1);
    const shape = hinoki ? Math.pow(t, 0.62) * (1 - 0.18 * t * t) : Math.pow(t, 0.92) * (1 + 0.12 * Math.sin(t * Math.PI));
    return crownR * shape;
  };
  /* 枯れ枝の残り（枝打ちの跡）：樹冠の下に数本 */
  let az = rng() * TAU;
  for (let y = cb * 0.45; y < cb - 0.02; y += rng.range(0.03, 0.06)) {
    az += GOLDEN;
    const T = trunkAt(y), d = dirAE(az, rng.range(-0.3, 0.1)), L = rng.range(0.006, 0.02);
    const a = madd(T.p, d, T.r * 0.9), b = madd(a, d, L);
    B.tube([a, b], [Math.min(T.r * 0.12, 0.0016), 0.0004], { radial: 3, bark: BARK[id], level: 2, flex: [0.05, 0.3], phase: rng(), uRepeat: 1 });
  }
  /* 輪生の枝 */
  const whorlGap = hinoki ? 0.019 : 0.021;
  let y = cb - 0.03;
  let wi = 0;
  while (y < 0.975) {
    const n = hinoki ? (wi % 2 ? 2 : 3) : rng.int(3, 5);
    const T = trunkAt(y);
    const rel = clamp((y - cb) / (1 - cb), 0, 1);
    for (let b = 0; b < n; b++) {
      const a0 = az + (b / n) * TAU + rng.sym(0.35);
      const Lc = Rc(y) * rng.range(0.82, 1.12);
      if (Lc < 0.006) continue;
      /* 仰角：下枝は垂れ、上枝は立つ */
      const el = lerp(hinoki ? -0.12 : -0.3, hinoki ? 0.45 : 0.72, Math.pow(rel, 1.25)) + rng.sym(0.1);
      const droop = lerp(hinoki ? 0.18 : 0.42, 0.05, rel) * Lc;
      const h = dirAE(a0, 0);
      const start = madd(T.p, h, T.r * 0.85);
      const pts = [];
      const NN = 5;
      for (let k = 0; k < NN; k++) {
        const t = k / (NN - 1);
        const p = madd(start, h, Lc * t * Math.cos(el));
        p[1] += Lc * t * Math.sin(el) - droop * t * t;
        /* 先が少し持ち上がる（スギの枝先） */
        if (!hinoki) p[1] += droop * 0.35 * Math.pow(t, 4);
        pts.push(p);
      }
      const rb = clamp(T.r * 0.32, 0.0009, 0.0055) * lerp(1, 0.75, rel);
      const radii = pts.map((_, k) => rb * lerp(1, 0.28, k / (NN - 1)));
      const flex = pts.map((_, k) => Math.pow(k / (NN - 1), 1.4) * lerp(0.75, 1, 1 - rel));
      const phase = rng();
      B.tube(pts, radii, { radial: rb * H > 0.035 ? 4 : 3, bark: BARK[id], level: 1, flex, phase, uRepeat: 1 });
      /* 葉のスプレー：枝の 25% から先へ、先ほど密に */
      const nc = clamp(Math.round(Lc / (hinoki ? 0.009 : 0.010)), 2, 16);
      for (let c = 0; c < nc; c++) {
        const t = lerp(0.22, 1.0, Math.pow((c + rng()) / nc, 0.75));
        const k = Math.min(NN - 2, Math.floor(t * (NN - 1)));
        const ft = t * (NN - 1) - k;
        const p = add(mul(pts[k], 1 - ft), mul(pts[k + 1], ft));
        const tan = norm(sub(pts[k + 1], pts[k]));
        let dir, nrm;
        if (hinoki) {
          /* 扇状の平たいスプレー：枝の向きに沿い、面はほぼ水平 */
          dir = norm(add(rotAxis(tan, [0, 1, 0], rng.sym(0.9)), [0, rng.sym(0.15), 0]));
          nrm = norm(add([0, 1, 0], mul(perp(dir), rng.sym(0.35))));
        } else {
          /* スギ：房（クラスタ）。先へ向かいつつ上下左右へ散る */
          dir = norm(add(add(tan, mul(rotAxis(perp(tan), tan, rng() * TAU), rng.range(0.35, 0.9))), [0, rng.range(-0.15, 0.35), 0]));
          nrm = rotAxis(perp(dir), dir, rng() * TAU);
        }
        const sz = (hinoki ? rng.range(0.55, 0.85) : rng.range(0.5, 0.82)) / H * (0.8 + 0.4 * t) * (1 - 0.35 * rel);
        B.card({
          p, dir, nrm, len: sz, wid: sz * (hinoki ? 0.8 : 0.72), layer: LEAF[id], droop: hinoki ? rng.range(0.05, 0.25) : rng.range(0.15, 0.45),
          ao: 1, flex: clamp(flex[k] + 0.1, 0, 1), phase, rand: rng(),
        });
      }
    }
    az += GOLDEN * 1.3;
    y += whorlGap * rng.range(0.8, 1.2);
    wi++;
  }
  /* 梢（頂芽の房） */
  const top = trunkAt(0.99).p;
  for (let c = 0; c < 9; c++) {
    const dir = norm([rng.sym(0.45), 1, rng.sym(0.45)]);
    const sz = rng.range(0.45, 0.7) / H;
    B.card({ p: madd(top, [0, -1, 0], rng.range(0.0, 0.035)), dir, nrm: rotAxis(perp(dir), dir, rng() * TAU), len: sz, wid: sz * 0.6,
      layer: LEAF[id], droop: 0.08, ao: 1, flex: 0.7, phase: rng(), rand: rng() });
  }
  return finish(B, { id, vi, H, crownR, cb, cardsLod1: 300 });
}

/* ================================================================ 空間コロニゼーション */

/**
 * @param {object} o
 *  envelope(rng) → 点（樹冠の中の誘引点）、count、D（1 歩）、ri（影響半径）、rk（消す半径）、
 *  start（幹の先の節）、trop（屈性 [x,y,z]）
 */
function colonize(rng, o) {
  const attr = [];
  let guard = 0;
  while (attr.length < o.count && guard++ < o.count * 50) { const p = o.envelope(rng); if (p) attr.push(p); }
  const nodes = o.seed.map((p, i) => ({ p, parent: i - 1, kids: [], dirs: null }));
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].kids.push(i);
  const cell = o.ri;
  const grid = new Map();
  const key = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  const addNode = (i) => { const k = key(nodes[i].p); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); };
  nodes.forEach((_, i) => addNode(i));
  const near = (p, r, fn) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (a) for (const i of a) fn(i);
    }
  };
  let alive = attr.map(() => true);
  for (let it = 0; it < o.iters; it++) {
    const pull = new Map();
    let any = false;
    for (let a = 0; a < attr.length; a++) {
      if (!alive[a]) continue;
      const P = attr[a];
      let best = -1, bd = o.ri;
      /* 影響半径の外でも、近い節が無ければ広く探す（樹冠の端まで育てる） */
      near(P, o.ri, (i) => { const d = dist(nodes[i].p, P); if (d < bd) { bd = d; best = i; } });
      if (best < 0) continue;
      if (bd < o.rk) { alive[a] = false; continue; }
      any = true;
      const d = norm(sub(P, nodes[best].p));
      const cur = pull.get(best);
      if (cur) { cur[0] += d[0]; cur[1] += d[1]; cur[2] += d[2]; cur[3]++; } else pull.set(best, [d[0], d[1], d[2], 1]);
    }
    if (!any) {
      /* まだ誘引点が届かない（幹が樹冠の下で止まっている）：最後の節を残りの重心へ伸ばす */
      const live = attr.filter((_, a) => alive[a]);
      if (!live.length || nodes.length > o.seed.length + 400) break;
      if (nodes.length > o.seed.length && it > 3) break;
      let cx = 0, cy = 0, cz = 0;
      for (const p of live) { cx += p[0]; cy += p[1]; cz += p[2]; }
      const tipI = nodes.length - 1, tip = nodes[tipI];
      const d = norm([cx / live.length - tip.p[0], cy / live.length - tip.p[1], cz / live.length - tip.p[2]]);
      const ni = nodes.length;
      nodes.push({ p: madd(tip.p, d, o.D), parent: tipI, kids: [] });
      tip.kids.push(ni);
      addNode(ni);
      it--;
      continue;
    }
    const grow = [...pull.entries()].sort((a, b) => a[0] - b[0]);
    for (const [i, v] of grow) {
      let d = norm([v[0] + o.trop[0] + rng.sym(o.jitter), v[1] + o.trop[1] + rng.sym(o.jitter), v[2] + o.trop[2] + rng.sym(o.jitter)]);
      /* 同じ向きの子を二重に作らない */
      const n = nodes[i];
      if (n.kids.some((k) => dot(norm(sub(nodes[k].p, n.p)), d) > 0.94)) continue;
      const p = madd(n.p, d, o.D);
      const ni = nodes.length;
      nodes.push({ p, parent: i, kids: [] });
      n.kids.push(ni);
      addNode(ni);
    }
    /* 消す半径の中の誘引点を消す */
    for (let a = 0; a < attr.length; a++) {
      if (!alive[a]) continue;
      near(attr[a], o.rk, (i) => { if (alive[a] && dist(nodes[i].p, attr[a]) < o.rk) alive[a] = false; });
    }
  }
  return nodes;
}

/** パイプモデルの半径（先端 rTip、親 = (Σ 子^e)^(1/e)） */
function pipeRadii(nodes, rTip, e = 2.4) {
  const r = new Float64Array(nodes.length);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n.kids.length) { r[i] = rTip; continue; }
    let s = 0;
    for (const k of n.kids) s += Math.pow(r[k], e);
    r[i] = Math.pow(s, 1 / e);
  }
  return r;
}

/** 節の位置を均す（根の数節は固定） */
function smoothNodes(nodes, fixed, iters = 2) {
  for (let it = 0; it < iters; it++) {
    const np = nodes.map((n) => n.p.slice());
    for (let i = fixed; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.parent < 0 || n.kids.length !== 1) continue;
      const a = nodes[n.parent].p, b = nodes[n.kids[0]].p;
      np[i] = add(mul(n.p, 0.5), mul(add(a, b), 0.25));
    }
    nodes.forEach((n, i) => { n.p = np[i]; });
  }
}

/** 太い子を辿る鎖へ分ける → [{ idx:[...], startParent }] */
function chains(nodes, r) {
  const out = [];
  const stack = [{ i: 0, from: -1 }];
  while (stack.length) {
    const { i, from } = stack.pop();
    const idx = from >= 0 ? [from, i] : [i];
    let cur = i;
    for (;;) {
      const kids = nodes[cur].kids;
      if (!kids.length) break;
      let main = kids[0];
      for (const k of kids) if (r[k] > r[main]) main = k;
      for (const k of kids) if (k !== main) stack.push({ i: k, from: cur });
      idx.push(main);
      cur = main;
    }
    out.push(idx);
  }
  return out;
}

/**
 * 空間コロニゼーションの木
 * @param {string} id 樹種
 * @param {number} vi variant
 * @param {object} P 形のパラメータ
 */
function colonized(id, vi, P) {
  const S = SPECIES[id];
  const rng = rngFor(`tree:${id}:${vi}`);
  const H = (S.heights[0] + S.heights[1]) / 2;
  const B = new TreeBuild(H);
  const r0 = S.trunkR[vi];
  const cb = S.crownBase * rng.range(0.92, 1.08);
  const crownR = S.crownR * rng.range(0.88, 1.1) * (P.crownMul || 1);
  const split = P.split * rng.range(0.9, 1.1);
  const nx = noise1(rng), nz = noise1(rng);
  const crook = P.crook || 0.004;
  const sway = (y) => [nx(y * 5) * crook * Math.min(1, y * 4) + (P.trunkLean || 0) * y, nz(y * 5) * crook * Math.min(1, y * 4)];
  /* 幹（割れる所まで）は節を密に置き、そこから先を育てる */
  const seed = [];
  for (let y = 0; y <= split + 1e-6; y += Math.min(0.03, split / 4)) { const s = sway(y); seed.push([s[0], y, s[1]]); }
  const cy = cb + (1 - cb) * (P.cyRel ?? 0.52);
  const ry = (1 - cb) * 0.5 * (P.ryMul || 1);
  const env = P.envelope || ((rr) => {
    const u = [rr.sym(1), rr.sym(1), rr.sym(1)];
    const d2 = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
    if (d2 > 1) return null;
    if (P.layers && ((u[1] * 0.5 + 0.5) * P.layers) % 1 > 0.62) return null;
    if (P.hollow && d2 < P.hollow * P.hollow) return null;
    const flatTop = P.flatTop ? Math.min(1, 1 - Math.max(0, u[1] - P.flatTop) * 1.2) : 1;
    return [u[0] * crownR * flatTop, cy + u[1] * ry, u[2] * crownR * flatTop];
  });
  const nodes = colonize(rng, {
    count: P.attractors, envelope: env, D: P.D, ri: P.ri, rk: P.rk, iters: 220, seed,
    trop: P.trop || [0, 0.25, 0], jitter: P.jitter ?? 0.15,
  });
  smoothNodes(nodes, seed.length, 2);
  const rTip = 0.0007;
  const rp = pipeRadii(nodes, rTip, P.pipeE || 2.4);
  /* 幹：胸高 = trunkR。割れる所の半径でパイプモデル全体を合わせる */
  const splitIdx = seed.length - 1;
  const kScale = trunkProfile(split, r0, P.trunkTop ?? 1, P.flare ?? 0.5, 0.8) / rp[splitIdx];
  const R = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    if (i <= splitIdx) R[i] = trunkProfile(nodes[i].p[1], r0, P.trunkTop ?? 1, P.flare ?? 0.5, 0.8);
    else R[i] = Math.max(rp[i] * kScale, rTip * 0.8);
  }
  /* 管 */
  const minTube = P.minTube || 0.0011;
  const tubeOf = new Int32Array(nodes.length).fill(-1);
  const flexOf = new Float64Array(nodes.length);
  const lvlOf = new Int32Array(nodes.length);
  const phaseOf = new Float64Array(nodes.length);
  const ch = chains(nodes, R);
  /* 鎖の階層：根からの分かれの回数 */
  ch.forEach((idx, c) => {
    const head = idx[0];
    const lvl = c === 0 ? 0 : Math.min(3, lvlOf[head] + 1);
    const ph = c === 0 ? 0 : rng();
    for (let k = c === 0 ? 0 : 1; k < idx.length; k++) {
      lvlOf[idx[k]] = lvl; phaseOf[idx[k]] = ph;
    }
  });
  for (let i = 0; i < nodes.length; i++) {
    /* しなり：太さが細いほど・根から遠いほど大きい */
    const rr = R[i] / r0;
    flexOf[i] = i <= splitIdx ? nodes[i].p[1] * 0.15 : clamp(1 - Math.pow(rr, 0.45), 0, 1);
  }
  ch.forEach((idx) => {
    const keep = idx.filter((i, k) => k === 0 || R[i] >= minTube);
    if (keep.length < 2) return;
    if (R[keep[0]] < minTube && keep.length < 3) return;
    const pts = keep.map((i) => nodes[i].p);
    const radii = keep.map((i) => R[i]);
    const lvl = lvlOf[keep[keep.length - 1]];
    const rb = radii[0];
    const radial = lvl === 0 ? 12 : rb * H > 0.12 ? 8 : rb * H > 0.05 ? 6 : rb * H > 0.025 ? 4 : 3;
    B.tube(pts, radii, { radial, bark: P.bark ?? BARK[id], level: lvl, flex: keep.map((i) => flexOf[i]), phase: phaseOf[keep[keep.length - 1]], uRepeat: lvl === 0 ? 0 : Math.max(1, Math.round(rb * H * TAU / 0.45)) });
    if (lvl === 0 && !B.trunk) B.trunk = { points: pts, radii };
  });
  /* 葉の房：細い節（末端から数節）に置く */
  const leafR = P.leafR || 0.0016;
  const cand = [];
  for (let i = splitIdx + 1; i < nodes.length; i++) if (R[i] < leafR) cand.push(i);
  const want = P.cards;
  const prob = Math.min(1, want / Math.max(cand.length, 1));
  let acc = 0;
  for (const i of cand) {
    acc += prob;
    if (acc < 1) continue;
    acc -= 1;
    const n = nodes[i];
    const par = nodes[n.parent];
    const tan = norm(sub(n.p, par.p));
    const out = norm([n.p[0], (n.p[1] - cy) * 0.6, n.p[2]]);
    const per = P.perNode || 1;
    for (let q = 0; q < per; q++) {
      let dir, nrm;
      if (P.hang) {
        /* ヤナギ：枝垂れ。外向きに少し出てから下へ */
        dir = norm([out[0] * 0.35 + rng.sym(0.12), -1, out[2] * 0.35 + rng.sym(0.12)]);
        nrm = norm(cross(dir, [-out[2], 0, out[0]]));
        if (len(nrm) < 0.5) nrm = perp(dir);
      } else if (P.tuft) {
        /* アカマツ：針葉の房を放射状に */
        dir = norm(add(mul(tan, 0.6), [rng.sym(0.9), rng.range(-0.2, 0.9), rng.sym(0.9)]));
        nrm = rotAxis(perp(dir), dir, rng() * TAU);
      } else {
        /* 広葉：光へ向く（面は上と外）。房は枝の先へ */
        dir = norm(add(add(mul(tan, 0.8), mul(out, 0.45)), [rng.sym(0.5), rng.sym(0.35), rng.sym(0.5)]));
        const up = norm(add(add([0, P.flatLeaves ? 1.6 : 0.9, 0], mul(out, 0.6)), [rng.sym(0.4), 0, rng.sym(0.4)]));
        nrm = norm(sub(up, mul(dir, dot(up, dir))));
      }
      const sz = rng.range(P.cardSize[0], P.cardSize[1]) / H;
      B.card({
        p: n.p, dir, nrm, len: sz, wid: sz * (P.cardAspect || 0.85), layer: LEAF[id],
        droop: P.hang ? rng.range(0.35, 0.7) : rng.range(P.droop?.[0] ?? 0.05, P.droop?.[1] ?? 0.3), ao: 1,
        flex: clamp(flexOf[i] + 0.15, 0, 1), phase: phaseOf[i], rand: rng(),
      });
    }
  }
  return finish(B, { id, vi, H, crownR, cb, cardsLod1: P.cardsLod1 || 320 });
}

/* ================================================================ 仕上げ（AO・樹冠の中心・LOD1） */

import { decimate, clusterCards } from './lib.mjs';
import { CARD_MAX } from '../../../src/gfx/trees/format.js';

const CARD_SEGS_ = [3, 2];
const tubeTris = (t) => t.radial * 2 * (t.nodes.length - 1);
/** 三角形の予算に収める：細い枝の管から落とし、それでも多ければ周の分割を減らす（幹は残す） */
function fitBudget(rec, segs, max) {
  const total = () => rec.tubes.reduce((a, t) => a + tubeTris(t), 0) + rec.cards.length * 2 * segs;
  if (total() <= max) return;
  const order = rec.tubes.map((t, i) => [t.level === 0 ? 1e9 : t.nodes[0].r, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const drop = new Set();
  let tt = total();
  for (const [r, i] of order) {
    if (tt <= max || r >= 1e9) break;
    const t = rec.tubes[i];
    if (t.radial > 3) { tt -= tubeTris(t); t.radial = Math.max(3, t.radial - 2); tt += tubeTris(t); continue; }
    drop.add(i); tt -= tubeTris(t);
  }
  rec.tubes = rec.tubes.filter((_, i) => !drop.has(i));
}

function finish(B, o) {
  B.bakeAO(o.id === 'sugi' || o.id === 'hinoki' ? 34 : 28);
  const crown = B.crownCenter();
  const bounds = B.bounds();
  /* 樹冠の半径（葉の重心からの距離の 85 分位） */
  const ds = B.cards.map((c) => Math.hypot(c.p[0] - crown[0], (c.p[1] - crown[1]) * 1.4, c.p[2] - crown[2])).sort((a, b) => a - b);
  const crownRad = ds.length ? ds[Math.floor(ds.length * 0.85)] : o.crownR;
  /* LOD1：幹は 6 角・節を間引く、枝は太い物だけ 3 角、葉は面積を保ってまとめる */
  const lod1 = { tubes: [], cards: [] };
  for (const t of B.tubes) {
    const rb = t.nodes[0].r;
    if (t.level === 0) {
      lod1.tubes.push({ ...t, radial: 6, nodes: decimate(t.nodes, 2) });
    } else if (t.level <= 2 && rb * B.H > 0.03 && t.nodes.length >= 2) {
      lod1.tubes.push({ ...t, radial: 3, nodes: decimate(t.nodes, t.nodes.length > 6 ? 3 : 2) });
    }
  }
  lod1.cards = clusterCards(B.cards, o.cardsLod1, CARD_MAX * 0.98);
  for (let k = 0; k < 4; k++) { fitBudget(B, CARD_SEGS_[0], 13600); fitBudget(lod1, CARD_SEGS_[1], 2450); }
  return { build: B, lod1, crown, crownRad, bounds, H: B.H, id: o.id, vi: o.vi };
}

/* ================================================================ 樹種の表 */

export const GENERATORS = {
  sugi: (vi) => conifer('sugi', vi),
  hinoki: (vi) => conifer('hinoki', vi),
  buna: (vi) => colonized('buna', vi, {
    split: 0.36, attractors: 1100, D: 0.022, ri: 0.13, rk: 0.03, cards: 1050, cardSize: [0.75, 1.05], leafR: 0.0019,
    trop: [0, 0.18, 0], jitter: 0.12, crook: 0.005, hollow: 0.35, cardsLod1: 330,
  }),
  mizunara: (vi) => colonized('mizunara', vi, {
    split: 0.3, attractors: 950, D: 0.024, ri: 0.14, rk: 0.032, cards: 980, cardSize: [0.75, 1.1], leafR: 0.0019,
    trop: [0, 0.08, 0], jitter: 0.3, crook: 0.012, hollow: 0.3, cardsLod1: 320,
  }),
  momiji: (vi) => colonized('momiji', vi, {
    split: 0.2, attractors: 900, D: 0.03, ri: 0.16, rk: 0.035, cards: 900, cardSize: [0.5, 0.75], leafR: 0.0028,
    trop: [0, 0.05, 0], jitter: 0.25, crook: 0.014, layers: 4.5, ryMul: 0.8, flatLeaves: true, cardsLod1: 300, flare: 0.35,
  }),
  hannoki: (vi) => colonized('hannoki', vi, {
    split: 0.4, attractors: 900, D: 0.024, ri: 0.13, rk: 0.03, cards: 950, cardSize: [0.65, 0.95], leafR: 0.0018,
    trop: [0, 0.35, 0], jitter: 0.15, crook: 0.006, ryMul: 1.05, cardsLod1: 300,
  }),
  akamatsu: (vi) => colonized('akamatsu', vi, {
    split: 0.62, attractors: 480, D: 0.026, ri: 0.18, rk: 0.04, cards: 420, perNode: 3, cardSize: [0.7, 1.0], leafR: 0.0032,
    trop: [0, 0.3, 0], jitter: 0.25, crook: 0.03, trunkLean: 0.02, tuft: true, flatTop: 0.25, ryMul: 0.75, cyRel: 0.5,
    bark: BARK.akamatsu, cardAspect: 0.9, cardsLod1: 280, trunkTop: 1.05, flare: 0.35,
  }),
  yanagi: (vi) => colonized('yanagi', vi, {
    split: 0.24, attractors: 520, D: 0.03, ri: 0.17, rk: 0.035, cards: 560, cardSize: [1.4, 2.0], leafR: 0.0026,
    trop: [0, 0.3, 0], jitter: 0.25, crook: 0.012, hang: true, cardAspect: 0.32, ryMul: 0.9, cyRel: 0.62, cardsLod1: 260, flare: 0.55,
  }),
};
