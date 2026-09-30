/* ===========================================================
   配置（three・DOM 無し）：buildPlacement(lake, q) → Placement
   -----------------------------------------------------------
   木・岩・藪・ヨシ・睡蓮・藻・流木・灯籠・小舟を «シードだけ» から決める。
   品質の引数は取らない。見た目の間引きは rank の入れ子（low ⊂ mid ⊂ high）で
   描く側が行い、当たり（collide = 1）は全品質で同一。旧版は品質で本数と
   乱数列が変わり、マルチで «相手には見えない木» にぶつかっていた。

   候補は世界に固定したジッタ格子（木 4.2m・岩 9m・玉石 3.5m・ヨシ 0.9m・
   睡蓮 1.6m・藻 1.3m）。セルごとに cellRng(系統の種, i, j) を引くので、
   処理順や本数を変えても他のセルの結果は変わらない。藪の輪と流木だけは
   汀線に沿って歩く列（系統の mulberry32）。

   旧来の規則：木は h ≥ 1.6・傾斜 ≤ 0.78・桟橋から 3.6m・スポーンから 6m。
   岩は桟橋から 3.4m・スポーンから 6m。

   座標と向きの約束（描く側と共有）：
     y は根元／底面の高さ（木は地面 − 0.15m、岩は沈めた底面）
     rot は rotation.y、lean は «rot を向けた後のローカル +Z 側への傾き»（rad）
       ＝ 世界の方向 (sin rot, cos rot) へ倒れる
     岩の見た目の半径は 0.40·size·(sx, sz)、高さ size·sy（底面から）
   =========================================================== */
import { SPECIES, SPECIES_IDS, VARIANTS, trunkCollider } from './species.js';
import { makeQueries } from './queries.js';
import { makeDock, dockFixtures, distToDock } from './dock.js';
import { makeEcology, SP } from './ecology.js';
import { stream, cellSeq, hash01, mulberry32 } from './rng.js';
import { fnv1aWords } from './heightgrid.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** 歩ける範囲（汀線から内陸へ何 m まで）。game.js の _tryMove と組 */
export const WALK_INLAND = 72;
/**
 * 歩ける帯の外で幹の当たりを持たせる距離。帯の外の木は糸もカメラも届かないので
 * これで足りる（旧版の 169m は «遠景を静的にする» 境の副作用で、品質依存だった）。
 */
export const FAR_GATE = 20;
/** 帯の中 + 12m の当たりのある木は全品質で必ず描く（見えない幹を作らない） */
export const MUST_DRAW_GATE = 12;

export const CELLS = { tree: 4.2, rock: 9, cobble: 3.5, reed: 0.9, lily: 1.6, weed: 1.3 };
export const TREE_R_MAX = 480;

/** 見た目の密度（rank < これ なら描く）。当たりのあるものはこれに関係なく描く */
export const TIER_DENSITY = {
  trees: { low: 0.22, mid: 0.55, high: 1.0 },
  boulders: { low: 0.4, mid: 0.7, high: 1.0 },
  cobbles: { low: 0.4, mid: 0.7, high: 1.0 },
  thicket: { low: 1.0, mid: 1.0, high: 1.0 },
  reeds: { low: 0.2, mid: 0.5, high: 1.0 },
  lilies: { low: 0.2, mid: 0.5, high: 1.0 },
  weeds: { low: 0.2, mid: 0.5, high: 1.0 },
  driftwood: { low: 0.5, mid: 0.8, high: 1.0 },
};

/** 描くかどうか（入れ子：low ⊂ mid ⊂ high） */
export function isVisible(system, rank, tier, must = false) {
  return must || rank < (TIER_DENSITY[system]?.[tier] ?? 1);
}

/**
 * 葦際（図鑑の «葦際» と同じ条件）：水深 (0.05, 1.5] かつ汀線まで 12m 未満。
 * 汀線までの距離は湖の形の関数 shoreRadius との半径方向の差で測る
 * （実際の水際とのずれは最大 3m ほど）。
 */
export function isEdge(x, z, q) {
  const d = q.depthAt(x, z);
  if (!(d > 0.05 && d <= 1.5)) return false;
  return Math.abs(Math.hypot(x, z) - q.shoreRadius(x, z)) < 12;
}

/** 汀線半径の角度表（候補の粗い足切り用。厳密な判定は shoreRadius で行う） */
function makeShoreTable(lake, N = 1440) {
  const t = new Float64Array(N + 1);
  for (let k = 0; k <= N; k++) t[k] = lake.shoreAtAngle((k / N) * TAU);
  let max = 0, min = Infinity;
  for (let k = 0; k < N; k++) { max = Math.max(max, t[k]); min = Math.min(min, t[k]); }
  const at = (x, z) => {
    const a = Math.atan2(z, x);
    const f = ((a / TAU) % 1 + 1) % 1 * N;
    const k = Math.floor(f);
    return t[k] + (t[k + 1] - t[k]) * (f - k);
  };
  return { t, N, at, max, min };
}

/**
 * 歩ける帯の外までの距離（帯の中は負）。帯 = {r ≤ shoreRadius + WALK_INLAND}
 * （game.js の _tryMove と同じ）。外の点は帯の境の曲線までのユークリッド距離を
 * 近くの角度で探す（汀線は波打つので、半径方向の差より近いことがある）。
 */
function makeBand(shore) {
  const { t, N } = shore;
  const bx = new Float64Array(N), bz = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU, r = t[k] + WALK_INLAND;
    bx[k] = Math.cos(a) * r; bz[k] = Math.sin(a) * r;
  }
  const rMax = shore.max + WALK_INLAND;
  return (x, z, radialOut, gate = Infinity) => {
    if (radialOut <= 0) return radialOut;
    const r = Math.hypot(x, z) || 1;
    /* 帯の境はどこも半径 rMax 以内なので、それより gate 以上外なら探すまでもない */
    if (r - rMax > gate) return r - rMax;
    const a = Math.atan2(z, x);
    const k0 = Math.round(((a / TAU) % 1 + 1) % 1 * N);
    const w = Math.min(N >> 2, Math.ceil(((radialOut + 4) / r) / (TAU / N)) + 2);
    let best = radialOut;
    for (let dk = -w; dk <= w; dk++) {
      const k = (k0 + dk + N) % N;
      const d = Math.hypot(x - bx[k], z - bz[k]);
      if (d < best) best = d;
    }
    return best;
  };
}

/**
 * セルの中心が半径 [rIn, rOut] の輪（±1.5 セルの余裕）から外れていれば true。
 * 候補点はセルの中にあるので、これで落ちるセルは後段の厳密な判定でも必ず落ちる
 * （乱数を引く前に捨てて、格子の走査を安くする）
 */
const outsideRing = (i, j, C, rIn, rOut) => {
  const rc = Math.hypot((i + 0.5) * C, (j + 0.5) * C);
  return rc < rIn - 1.5 * C || rc > rOut + 1.5 * C;
};

/* SoA を組む小道具 */
function soa(fields) {
  const cols = Object.fromEntries(fields.map((f) => [f, []]));
  return {
    cols,
    push(o) { for (const f of fields) cols[f].push(o[f]); },
    build() {
      const out = { count: cols[fields[0]].length };
      for (const f of fields) out[f] = Float32Array.from(cols[f]);
      return out;
    },
  };
}

/**
 * 汀線に沿った空白を埋める。cand は {a: 角度, r: 半径, keep} の列（格子の順）。
 * 残した株どうしの間（汀線に沿った弧長）が maxGap を超えるところで、間引かれた候補を
 * step 以上の間隔で拾い直す。候補の無い所（桟橋の回廊・急な岸）は空白のまま
 */
function fillReedGaps(cand, maxGap, step) {
  const N = cand.length;
  if (!N) return;
  const order = cand.map((c, i) => i).sort((i, j) => cand[i].a - cand[j].a || i - j);
  const A = (k) => cand[order[k % N]].a + (k >= N ? TAU : 0);
  let first = -1;
  for (let k = 0; k < N; k++) if (cand[order[k]].keep) { first = k; break; }
  if (first < 0) { cand[order[0]].keep = true; first = 0; }
  /* 元の «残した株» の次の位置（2 周ぶんの添字） */
  const nextKept = new Int32Array(2 * N);
  let nk = 4 * N;
  for (let k = 2 * N - 1; k >= 0; k--) {
    if (cand[order[k % N]].keep) nk = k;
    nextKept[k] = nk;
  }
  let last = first;
  for (let k = first + 1; k < first + N; k++) {
    const c = cand[order[k % N]];
    if (c.keep) { last = k; continue; }
    const nx = nextKept[k];
    const span = ((nx < 4 * N ? A(nx) : A(first) + TAU) - A(last)) * c.r;
    const sinceLast = (A(k) - A(last)) * c.r;
    if (span > maxGap && sinceLast >= step) { c.keep = true; last = k; }
  }
}

export const TREE_FIELDS = ['x', 'z', 'y', 'h', 'species', 'variant', 'rot', 'lean', 'rank', 'collide', 'mustDraw', 'zone', 'r', 'top', 'bandD'];

/**
 * @param {object} lake lakefield の湖
 * @param {object} [q] makeQueries(lake)
 */
export function buildPlacement(lake, q = makeQueries(lake)) {
  const clock = typeof performance !== 'undefined' ? performance : Date;
  const t0 = clock.now();
  const sections = {};
  let tMark = t0;
  const mark = (name) => { const t = clock.now(); sections[name] = t - tMark; tMark = t; };
  const seed = lake.seed >>> 0;
  const dock = makeDock(lake);
  const fx = dockFixtures(dock);
  const sp = dock.spawnPos;
  const eco = makeEcology(lake, q);
  const seq = cellSeq();
  const shore = makeShoreTable(lake);
  const bandDist = makeBand(shore);
  const nearDock = (x, z, r) => distToDock(dock, x, z) < r;
  const nearSpawn = (x, z, r) => (x - sp.x) * (x - sp.x) + (z - sp.z) * (z - sp.z) < r * r;

  mark('setup');
  /* ---------------- 木 ---------------- */
  const trees = soa(TREE_FIELDS);
  const addTree = (x, z, h, species, variant, height, rot, lean, rank, zone, sr) => {
    const y = h - 0.15;
    const radialOut = Math.hypot(x, z) - sr - WALK_INLAND;
    const bd = bandDist(x, z, radialOut, FAR_GATE + 1);
    const collide = bd <= FAR_GATE ? 1 : 0;
    const c = trunkCollider(species, variant, height, y);
    trees.push({
      x, z, y, h: height, species, variant, rot, lean, rank, collide,
      mustDraw: collide && bd <= MUST_DRAW_GATE ? 1 : 0, zone, r: c.r, top: c.top, bandD: bd,
    });
  };
  const altScale = (h, k) => lerp(1, k, clamp01(h / 150));
  {
    const C = CELLS.tree;
    const sT = stream(seed, 'trees');
    const sR = stream(seed, 'trees:rank');
    const n = Math.ceil(TREE_R_MAX / C);
    for (let j = -n; j < n; j++) {
      for (let i = -n; i < n; i++) {
        if (outsideRing(i, j, C, shore.min + 5, TREE_R_MAX)) continue;
        const rng = seq.reset(sT, i, j);
        const x = (i + 0.15 + 0.7 * rng()) * C;
        const z = (j + 0.15 + 0.7 * rng()) * C;
        const r = Math.hypot(x, z);
        if (r > TREE_R_MAX || r < shore.at(x, z) + 1) continue;
        if (eco.plantationAt(x, z)) continue;   // 植林区画は列植の格子が受け持つ
        if (nearDock(x, z, 3.6) || nearSpawn(x, z, 6)) continue;
        /* 安い判定（ノイズ）を先に。heightAt と slopeAt・shoreRadius が配置の費用の大半 */
        if (eco.forestGap(x, z) < -0.07) continue;   // 空き地
        const u0 = rng();
        if (eco.forestCluster(x, z) < -0.14 && u0 > 0.38) continue;
        const sr = q.shoreRadius(x, z);
        if (r < sr + 5) continue;
        const h = q.heightAt(x, z);
        if (h < 1.6) continue;
        const slope = q.slopeAt(x, z);
        if (slope > 0.78) continue;
        const shoreD = r - sr;
        const pick = eco.pickNatural(x, z, h, slope, shoreD, rng(), rng());
        const S = SPECIES[SPECIES_IDS[pick.species]];
        const variant = Math.min(VARIANTS - 1, Math.floor(rng() * VARIANTS));
        let height = lerp(S.heights[0], S.heights[1], rng()) * altScale(h, 0.62);
        const tierRoll = rng(), tierU = rng();
        if (tierRoll < 0.20) height *= lerp(0.30, 0.48, tierU);          // 若木
        else if (tierRoll > 0.90) height *= lerp(1.08, 1.30, tierU);     // 古木
        let rot = rng() * TAU, lean;
        const ul = rng();
        if (S.riparian) {
          /* 水辺の木は湖へ張り出す */
          rot = Math.atan2(-x, -z) + (ul - 0.5) * 0.9;
          lean = 0.05 + rng() * 0.13;
        } else if (pick.species === SP.akamatsu) {
          lean = 0.03 + ul * 0.09;
        } else {
          lean = ul * 0.045;
        }
        addTree(x, z, h, pick.species, variant, height, rot, lean, hash01(sR, i, j), pick.zone, sr);
      }
    }
    mark('trees');
    /* 植林：区画ごとの列植（同齢・等間隔）。遠景で «四角い暗い帯» に読ませる */
    for (const p of eco.plantations) {
      const sP = stream(seed, `trees:plant:${p.id}`);
      const sPR = stream(seed, `trees:plant:${p.id}:rank`);
      const c = Math.cos(p.rot), s = Math.sin(p.rot);
      const na = Math.floor(p.w / p.treeGap / 2), nb = Math.floor(p.d / p.rowGap / 2);
      for (let b = -nb; b <= nb; b++) {
        for (let a = -na; a <= na; a++) {
          const rng = seq.reset(sP, a, b);
          const u = a * p.treeGap + (rng() - 0.5) * 0.6;
          const v = b * p.rowGap + (rng() - 0.5) * 0.4;
          const x = p.cx + u * c - v * s;
          const z = p.cz + u * s + v * c;
          const r = Math.hypot(x, z);
          if (r > TREE_R_MAX) continue;
          if (rng() < 0.07) continue;   // 枯れ・間伐の欠け
          const sr = q.shoreRadius(x, z);
          if (r < sr + 5) continue;
          const h = q.heightAt(x, z);
          if (h < 1.6) continue;
          if (q.slopeAt(x, z) > 0.78) continue;
          if (nearDock(x, z, 3.6) || nearSpawn(x, z, 6)) continue;
          const species = rng() < 0.94 ? p.dominant : (p.dominant === SP.sugi ? SP.hinoki : SP.sugi);
          const S = SPECIES[SPECIES_IDS[species]];
          const variant = Math.min(VARIANTS - 1, Math.floor(rng() * VARIANTS));
          const height = S.heights[1] * p.age * lerp(0.92, 1.06, rng()) * altScale(h, 0.7);
          addTree(x, z, h, species, variant, height, rng() * TAU, rng() * 0.02, hash01(sPR, a, b), 2, sr);
        }
      }
    }
  }

  mark('plantations');
  /* ---------------- 大岩 ---------------- */
  const boulders = [];
  {
    const C = CELLS.rock;
    const sK = stream(seed, 'rocks');
    const sR = stream(seed, 'rocks:rank');
    const n = Math.ceil(TREE_R_MAX / C);
    for (let j = -n; j < n; j++) {
      for (let i = -n; i < n; i++) {
        if (outsideRing(i, j, C, shore.min - 30, TREE_R_MAX)) continue;
        const rng = seq.reset(sK, i, j);
        const x = (i + 0.1 + 0.8 * rng()) * C;
        const z = (j + 0.1 + 0.8 * rng()) * C;
        const r = Math.hypot(x, z);
        if (r > TREE_R_MAX) continue;
        const dApprox = r - shore.at(x, z);
        if (dApprox < -30) continue;
        const u = rng(), su = rng();
        let size;
        let h;
        if (dApprox < 14) {
          /* 水際：水面をまたぐ岩はシルエットが景観に効く */
          const d = r - q.shoreRadius(x, z);
          if (d < -26 || d > 12 || u > 0.42) continue;
          h = q.heightAt(x, z);
          if (h < -2.6 || h > 13) continue;
          size = lerp(1.1, 4.6, Math.pow(su, 2.2));
        } else if (dApprox < 132) {
          /* 林床の転石 */
          if (u > 0.16) continue;
          const d = r - q.shoreRadius(x, z);
          if (d < 8 || d > 130) continue;
          h = q.heightAt(x, z);
          if (h < 1.2) continue;
          size = lerp(0.9, 3.4, Math.pow(su, 2.2));
        } else {
          /* 尾根の露岩 */
          h = q.heightAt(x, z);
          if (h < 80) continue;
          if (u > 0.5 * smooth(80, 125, h)) continue;
          if (q.slopeAt(x, z) < 0.3) continue;
          size = lerp(1.4, 5.2, Math.pow(su, 1.6));
        }
        if (nearDock(x, z, 3.4) || nearSpawn(x, z, 6)) continue;
        const sx = 0.8 + rng() * 0.7, sz = 0.8 + rng() * 0.7, sy = 0.55 + rng() * 0.3;
        const sink = size * (0.10 + rng() * 0.16);
        const y = h - sink;
        const collide = size > 1.4 && h > -0.9 ? 1 : 0;
        boulders.push({
          x, z, y, size, sx, sy, sz, rot: rng() * TAU, shape: Math.floor(rng() * 12) % 12,
          rank: hash01(sR, i, j), collide,
          r: 0.40 * size * Math.max(sx, sz) * 1.05, top: y + size * sy,
        });
      }
    }
  }

  mark('boulders');
  /* ---------------- 玉石（当たり無し） ---------------- */
  const cobbles = [];
  {
    const C = CELLS.cobble;
    const sK = stream(seed, 'pebbles');
    const sR = stream(seed, 'pebbles:rank');
    const lim = shore.max + 132;
    const n = Math.ceil(lim / C);
    for (let j = -n; j < n; j++) {
      for (let i = -n; i < n; i++) {
        if (outsideRing(i, j, C, shore.min - 20, shore.max + 132)) continue;
        const rng = seq.reset(sK, i, j);
        const x = (i + 0.1 + 0.8 * rng()) * C;
        const z = (j + 0.1 + 0.8 * rng()) * C;
        const r = Math.hypot(x, z);
        const dA = r - shore.at(x, z);
        if (dA < -20 || dA > 132) continue;
        const u = rng(), su = rng();
        if (u > (dA < 10 ? 0.55 : 0.12)) continue;
        const d = r - q.shoreRadius(x, z);
        const h = q.heightAt(x, z);
        let size;
        if (d >= -18 && d <= 9 && h >= -1.8 && h <= 6) size = lerp(0.30, 1.05, Math.pow(su, 2.2));
        else if (d > 9 && d <= 130 && h > 1.2) size = lerp(0.22, 0.9, Math.pow(su, 2.2));
        else continue;
        if (nearDock(x, z, 2.5) || nearSpawn(x, z, 3)) continue;
        const sx = 0.8 + rng() * 0.7, sz = 0.8 + rng() * 0.7, sy = 0.5 + rng() * 0.35;
        cobbles.push({
          x, z, y: h - size * (0.12 + rng() * 0.18), size, sx, sy, sz,
          rot: rng() * TAU, shape: Math.floor(rng() * 12) % 12, rank: hash01(sR, i, j),
        });
      }
    }
  }

  mark('cobbles');
  /* ---------------- 藪の輪（歩ける帯の境目） ----------------
     見えない壁で止めるより «茂みで進めない» ほうが納得できる。
     shoreRadius + 72 − 5 〜 +4 の帯を、汀線に沿って 0.6–1.1m 刻みで歩く */
  const thicket = [];
  {
    const rng = mulberry32(stream(seed, 'thicket'));
    const sR = stream(seed, 'thicket:rank');
    let a = rng() * 0.01, k = 0;
    while (a < TAU) {
      const rr = q.shoreRadius(Math.cos(a) * 150, Math.sin(a) * 150);
      const dist = rr + WALK_INLAND - 5 + rng() * 9;
      const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
      const height = lerp(1.25, 2.1, Math.pow(rng(), 0.8));
      const variant = Math.floor(rng() * 3) % 3, rot = rng() * TAU;
      const h = q.heightAt(x, z);
      if (h >= 0.9 && q.slopeAt(x, z) <= 1.2) {
        thicket.push({ x, z, y: h - 0.04, height, variant, rot, r: 0.55, top: h + height * 0.8, collide: 1, rank: hash01(sR, k, 0) });
      }
      k++;
      a += (0.6 + rng() * 0.5) / dist;
    }
  }

  mark('thicket');
  /* ---------------- ヨシ・マコモ（葦際） ----------------
     群落はノイズで塊にするが、縁に 10m を超える空白は作らない（図鑑の «葦際» が
     どこでも見つかるように）。間引かれた候補を汀線に沿って拾い直して埋める */
  const reeds = [];
  {
    const C = CELLS.reed;
    const sK = stream(seed, 'reeds');
    const sR = stream(seed, 'reeds:rank');
    const n = Math.ceil((shore.max + 16) / C);
    const cand = [];
    for (let j = -n; j < n; j++) {
      const z0 = (j + 0.5) * C;
      for (let i = -n; i < n; i++) {
        if (outsideRing(i, j, C, shore.min - 13.5, shore.max + 4.5)) continue;
        const xc = (i + 0.5) * C;
        const rc = Math.hypot(xc, z0);
        /* 葦際は水の中（depth > 0.05）。実際の水際は shoreRadius から最大 3.3m ずれる */
        const dr = rc - shore.at(xc, z0);
        if (dr < -13.5 || dr > 4.5) continue;
        const rng = seq.reset(sK, i, j);
        const x = (i + 0.1 + 0.8 * rng()) * C;
        const z = (j + 0.1 + 0.8 * rng()) * C;
        if (!isEdge(x, z, q)) continue;
        if (nearDock(x, z, 6) || nearSpawn(x, z, 6)) continue;
        const clump = lake.noise.fbm(x * 0.042 + 11.3, z * 0.042 - 11.3, 2);
        const keep = rng() <= 0.2 + 0.8 * smooth(-0.3, 0.3, clump);
        const depth = q.depthAt(x, z);
        const mk = lake.noise.fbm(x * 0.05 - 37.7, z * 0.05 + 37.7, 2);
        const kind = depth < 0.7 && mk > 0.1 ? 1 : 0;   // 0 ヨシ / 1 マコモ（浅い所の群落）
        cand.push({
          a: Math.atan2(z, x), r: Math.hypot(x, z), keep,
          item: {
            x, z, y: -depth, depth, kind,
            height: (kind ? lerp(1.0, 1.8, rng()) : lerp(1.7, 3.1, Math.pow(rng(), 1.35))) + depth * 0.3,
            density: 0.35 + 0.65 * smooth(-0.3, 0.5, clump), rot: rng() * TAU, rank: hash01(sR, i, j),
          },
        });
      }
    }
    fillReedGaps(cand, 9.5, 4.5);
    for (const c of cand) if (c.keep) reeds.push(c.item);
  }

  mark('reeds');
  /* ---------------- 睡蓮（入り江の浅場の群落） ---------------- */
  const lilies = [];
  {
    const C = CELLS.lily;
    const sK = stream(seed, 'lilies');
    const sR = stream(seed, 'lilies:rank');
    const n = Math.ceil((shore.max + 4) / C);
    for (let j = -n; j < n; j++) {
      for (let i = -n; i < n; i++) {
        if (outsideRing(i, j, C, shore.min - 28, shore.max + 4)) continue;
        const xc = (i + 0.5) * C, zc = (j + 0.5) * C;
        const dA = shore.at(xc, zc) - Math.hypot(xc, zc);
        if (dA < -4 || dA > 28) continue;
        const rng = seq.reset(sK, i, j);
        const x = (i + 0.1 + 0.8 * rng()) * C;
        const z = (j + 0.1 + 0.8 * rng()) * C;
        const depth = q.depthAt(x, z);
        if (depth < 0.4 || depth > 2.2) continue;
        if (nearDock(x, z, 8) || nearSpawn(x, z, 8)) continue;
        const cove = eco.coveAt(x, z);
        const col = lake.noise.fbm(x * 0.05 + 41.7, z * 0.05 - 9.2, 2);
        const p = clamp01(cove * 1.2 + (col - 0.15) * 1.6) * smooth(0.4, 0.8, depth) * (1 - smooth(1.7, 2.2, depth));
        if (rng() > p) continue;
        lilies.push({
          x, z, depth, spread: 0.5 + rng() * 0.6, rot: rng() * TAU,
          flower: rng() < 0.12 ? 1 : 0, rank: hash01(sR, i, j),
        });
      }
    }
  }

  mark('lilies');
  /* ---------------- 沈水植物（藻場 = lake.flats） ---------------- */
  const weeds = [];
  {
    const C = CELLS.weed;
    const sK = stream(seed, 'weeds');
    const sR = stream(seed, 'weeds:rank');
    const seen = new Set();
    lake.flats.forEach((f, fi) => {
      const i0 = Math.floor((f.x - f.r) / C), i1 = Math.ceil((f.x + f.r) / C);
      const j0 = Math.floor((f.z - f.r) / C), j1 = Math.ceil((f.z + f.r) / C);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = i * 65536 + j;
          if (seen.has(key)) continue;
          const rng = seq.reset(sK, i, j);
          const x = (i + 0.1 + 0.8 * rng()) * C;
          const z = (j + 0.1 + 0.8 * rng()) * C;
          const dd = Math.hypot(x - f.x, z - f.z);
          if (dd > f.r) continue;
          const depth = q.depthAt(x, z);
          if (depth < 0.5) continue;
          seen.add(key);
          const gauss = Math.exp(-(dd / f.r) * (dd / f.r) * 1.6);
          const dens = (0.55 + 0.45 * gauss) * (1 - smooth(6, 9, depth));
          if (rng() > dens) continue;
          weeds.push({
            x, z, y: -depth, depth,
            height: Math.min(depth - 0.3, lerp(0.5, 2.2, rng() * (0.4 + 0.6 * gauss))),
            rot: rng() * TAU, rank: hash01(sR, i, j), flat: fi,
          });
        }
      }
    });
  }

  mark('weeds');
  /* ---------------- 流木（汀線に打ち上がったもの） ---------------- */
  const driftwood = [];
  {
    const rng = mulberry32(stream(seed, 'understory'));
    for (let k = 0; k < 90 && driftwood.length < 48; k++) {
      const a = rng() * TAU;
      const rr = q.shoreRadius(Math.cos(a), Math.sin(a)) + (rng() - 0.5) * 3;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const len = lerp(0.8, 3.2, Math.pow(rng(), 1.4)), radius = lerp(0.05, 0.16, rng()), rot = rng() * TAU;
      const rank = rng();
      const h = q.heightAt(x, z);
      if (h < -0.25 || h > 0.7) continue;
      if (nearDock(x, z, 4) || nearSpawn(x, z, 6)) continue;
      driftwood.push({ x, z, y: h, len, radius, rot, rank });
    }
  }

  mark('driftwood');
  const P = {
    seed,
    trees: trees.build(),
    boulders, cobbles, thicket, reeds, lilies, weeds, driftwood,
    structures: lake.structures,
    lamp: fx.lamp,
    boat: fx.boat,
    dock: { yaw: fx.yaw, dir: fx.dir, right: fx.right },
    ecology: eco.params,
  };
  P.hash = placementHash(P);
  mark('hash');
  P.stats = {
    ms: clock.now() - t0, sections,
    trees: P.trees.count, treesCollide: countIf(P.trees.collide), boulders: boulders.length, cobbles: cobbles.length,
    thicket: thicket.length, reeds: reeds.length, lilies: lilies.length, weeds: weeds.length, driftwood: driftwood.length,
  };
  return P;
}

function countIf(a) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i]) n++; return n; }

/**
 * 当たりの一覧（[x, z, r, top] の平らな Float64Array）。Terrain ファサードがこの順で
 * addObstacle する：灯籠 → 小舟 → ストラクチャー → 幹 → 大岩 → 藪。
 */
export function obstacleList(P, q) {
  const out = [];
  out.push(P.lamp.x, P.lamp.z, P.lamp.r, P.lamp.top);
  for (const c of P.boat.circles) out.push(c.x, c.z, c.r, c.top);
  for (const t of P.structures) out.push(t.x, t.z, t.r * 1.15, q.heightAt(t.x, t.z) + t.h);
  const T = P.trees;
  for (let i = 0; i < T.count; i++) if (T.collide[i]) out.push(T.x[i], T.z[i], T.r[i], T.top[i]);
  for (const b of P.boulders) if (b.collide) out.push(b.x, b.z, b.r, b.top);
  for (const b of P.thicket) out.push(b.x, b.z, b.r, b.top);
  return Float64Array.from(out);
}

/** 配置全体の指紋（2 回作ってバイト一致・品質で不変を確かめる） */
export function placementHash(P) {
  const parts = [];
  for (const f of TREE_FIELDS) parts.push(fnv1aWords(new Uint32Array(P.trees[f].buffer)));
  for (const k of ['boulders', 'cobbles', 'thicket', 'reeds', 'lilies', 'weeds', 'driftwood']) {
    const a = P[k];
    const flat = new Float64Array(a.length * 4);
    for (let i = 0; i < a.length; i++) {
      flat[i * 4] = a[i].x; flat[i * 4 + 1] = a[i].z; flat[i * 4 + 2] = a[i].rank; flat[i * 4 + 3] = a[i].y ?? a[i].depth ?? 0;
    }
    parts.push(fnv1aWords(new Uint32Array(flat.buffer)));
  }
  return parts.map((h) => h.toString(16).padStart(8, '0')).join('');
}

/** 当たりの指紋（マルチの 2 人で一致するべき値） */
export function collisionHash(P, q) {
  return fnv1aWords(new Uint32Array(obstacleList(P, q).buffer)).toString(16).padStart(8, '0');
}
