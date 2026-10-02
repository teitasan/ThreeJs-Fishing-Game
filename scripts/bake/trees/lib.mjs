/* ===========================================================
   木の焼き込みの道具（決定的・three 無し）
   -----------------------------------------------------------
   ベクトル・乱数・管とカードの組み立て・ボクセルの AO・LOD1 の簡約。
   すべて «樹高 = 1» の正規化単位で作る（樹皮の v と葉のカードの寸法だけは実寸 m を H で割って入れる）
   =========================================================== */
import { mulberry32, stream } from '../../../src/world/rng.js';

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** 方位 az（rad、+x から +z へ）と仰角 el の単位ベクトル */
export const dirAE = (az, el) => [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
/** a を軸 k（単位）の周りに ang 回す（Rodrigues） */
export function rotAxis(a, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), d = dot(k, a), x = cross(k, a);
  return [a[0] * c + x[0] * s + k[0] * d * (1 - c), a[1] * c + x[1] * s + k[1] * d * (1 - c), a[2] * c + x[2] * s + k[2] * d * (1 - c)];
}
/** a に垂直な単位ベクトル（なるべく up 寄り） */
export function perp(a, up = [0, 1, 0]) {
  let p = sub(up, mul(a, dot(a, up)));
  if (len(p) < 1e-4) p = sub([1, 0, 0], mul(a, a[0]));
  return norm(p);
}

/** 種と名前ごとの乱数 */
export function rngFor(name) {
  const r = mulberry32(stream(20261001, name));
  r.range = (a, b) => a + (b - a) * r();
  r.sym = (a) => (r() * 2 - 1) * a;
  r.int = (a, b) => a + Math.floor(r() * (b - a + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  return r;
}

/** 1D の滑らかな値ノイズ（決定的、整数格子に rng の値） */
export function noise1(seedR, n = 64) {
  const t = Array.from({ length: n }, () => seedR() * 2 - 1);
  return (x) => {
    const i = Math.floor(x), f = x - i, a = t[((i % n) + n) % n], b = t[(((i + 1) % n) + n) % n];
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  };
}

/**
 * 1 本の木の組み立て（正規化単位）
 */
export class TreeBuild {
  constructor(H) {
    this.H = H;
    this.tubes = [];   // { nodes:[{p, r, v, ao, flex}], radial, bark, phase, level, flags, uRepeat }
    this.cards = [];   // { p, dir, nrm, len, wid, layer, droop, ao, flex, phase, rand }
  }
  /** 点列から管を足す。radii は節ごと（正規化）、v は 0 から実寸 m で積む */
  tube(points, radii, o) {
    const nodes = [];
    let v = o.v0 || 0;
    for (let k = 0; k < points.length; k++) {
      if (k) v += dist(points[k], points[k - 1]) * this.H;
      nodes.push({ p: points[k], r: radii[k], v, ao: 1, flex: o.flex ? o.flex[k] : 0 });
    }
    const t = { nodes, radial: o.radial, bark: o.bark, phase: o.phase ?? 0, level: o.level ?? 0, flags: o.flags ?? 0, uRepeat: Math.min(8, o.uRepeat || Math.max(1, Math.round(radii[Math.min(radii.length - 1, 4)] * this.H * 6.283 / 0.5))) };
    this.tubes.push(t);
    return t;
  }
  card(c) { this.cards.push(c); return c; }

  bounds() {
    let R = 0, y0 = 0, y1 = 0;
    const acc = (p, e = 0) => { R = Math.max(R, Math.hypot(p[0], p[2]) + e); y0 = Math.min(y0, p[1] - e); y1 = Math.max(y1, p[1] + e); };
    for (const t of this.tubes) for (const n of t.nodes) acc(n.p, n.r);
    for (const c of this.cards) { acc(c.p, 0); acc(madd(c.p, c.dir, c.len), c.wid * 0.5); }
    return { R, y0, y1 };
  }

  /** 樹冠の中心（葉の面積で重み付け） */
  crownCenter() {
    let s = 0, x = 0, y = 0, z = 0;
    for (const c of this.cards) {
      const a = c.len * c.wid, m = madd(c.p, c.dir, c.len * 0.5);
      s += a; x += m[0] * a; y += m[1] * a; z += m[2] * a;
    }
    if (!s) return [0, 0.6, 0];
    return [x / s, y / s, z / s];
  }

  /**
   * 葉の面積のボクセルから AO（上半球の 9 方向の透過の平均）を焼く。
   * カードの AO・管の節の AO に入れる（0.22..1）
   */
  bakeAO(sigma = 30) {
    const { R, y1 } = this.bounds();
    const N = 22, ext = Math.max(R, 0.05) * 1.05, ylo = -0.02, yhi = Math.max(y1, 0.1) * 1.03;
    const sx = (2 * ext) / N, sy = (yhi - ylo) / N;
    const grid = new Float64Array(N * N * N);
    const cell = (p) => {
      const i = Math.floor((p[0] + ext) / sx), j = Math.floor((p[1] - ylo) / sy), k = Math.floor((p[2] + ext) / sx);
      if (i < 0 || j < 0 || k < 0 || i >= N || j >= N || k >= N) return -1;
      return (j * N + k) * N + i;
    };
    const vol = sx * sx * sy;
    for (const c of this.cards) {
      for (let s = 0; s < 3; s++) {
        const id = cell(madd(c.p, c.dir, c.len * (s + 0.5) / 3));
        if (id >= 0) grid[id] += (c.len * c.wid / 3) * 0.55 / vol;   // 葉の面積密度（被覆 55%）
      }
    }
    for (const t of this.tubes) {
      for (let k = 1; k < t.nodes.length; k++) {
        const a = t.nodes[k - 1], b = t.nodes[k];
        const id = cell(mul(add(a.p, b.p), 0.5));
        if (id >= 0) grid[id] += (2 * a.r * dist(a.p, b.p)) / vol;
      }
    }
    const dirs = [];
    for (let k = 0; k < 9; k++) {
      const el = k === 0 ? Math.PI / 2 : k < 5 ? 0.85 : 0.25;
      const az = k === 0 ? 0 : (k * TAU) / 4 + (k >= 5 ? Math.PI / 4 : 0);
      dirs.push(dirAE(az, el));
    }
    const step = Math.min(sx, sy) * 0.9, steps = Math.ceil((ext * 2.2) / step);
    const occ = (p) => {
      let vis = 0;
      for (const d of dirs) {
        let tau = 0;
        for (let s = 1; s <= steps; s++) {
          const q = madd(p, d, s * step);
          const id = cell(q);
          if (id < 0) break;
          tau += grid[id] * step;
        }
        vis += Math.exp(-tau * sigma * 0.02) * (d[1] * 0.5 + 0.5);
      }
      return vis / dirs.reduce((a, d) => a + d[1] * 0.5 + 0.5, 0);
    };
    for (const c of this.cards) c.ao = clamp(0.22 + 0.78 * occ(madd(c.p, c.dir, c.len * 0.5)), 0, 1);
    for (const t of this.tubes) for (const n of t.nodes) n.ao = clamp(0.22 + 0.78 * occ(n.p), 0, 1);
  }

  stats(cardSegs) {
    let verts = 0, tris = 0;
    for (const t of this.tubes) { verts += (t.radial + 1) * t.nodes.length; tris += t.radial * 2 * (t.nodes.length - 1); }
    verts += this.cards.length * 2 * (cardSegs + 1);
    tris += this.cards.length * 2 * cardSegs;
    return { verts, tris, tubes: this.tubes.length, cards: this.cards.length };
  }
}

/** 点列を k 個おきに間引く（端は残す） */
export function decimate(arr, keepEvery) {
  if (arr.length <= 2) return arr.slice();
  const out = [];
  for (let i = 0; i < arr.length; i += keepEvery) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

/**
 * LOD1 のカード：格子のセルごとにカードをまとめ、面積を保つ大きなカードにする。
 * 目標の枚数になるよう格子の大きさを二分探索する（決定的）
 */
export function clusterCards(cards, target, cardMax) {
  if (cards.length <= target) return cards.map((c) => ({ ...c }));
  const run = (g) => {
    const cells = new Map();
    for (const c of cards) {
      const m = madd(c.p, c.dir, c.len * 0.5);
      const key = `${Math.floor(m[0] / g)},${Math.floor(m[1] / (g * 0.8))},${Math.floor(m[2] / g)},${c.layer}`;
      let a = cells.get(key);
      if (!a) cells.set(key, (a = []));
      a.push(c);
    }
    return cells;
  };
  let lo = 0.002, hi = 0.5;
  for (let it = 0; it < 30; it++) {
    const mid = Math.sqrt(lo * hi);
    if (run(mid).size > target) lo = mid; else hi = mid;
  }
  const out = [];
  for (const group of run(hi).values()) {
    let A = 0, p = [0, 0, 0], d = [0, 0, 0], n = [0, 0, 0], ao = 0, flex = 0, phase = 0, droop = 0, asp = 0;
    const ref = group[0].nrm;
    for (const c of group) {
      const a = c.len * c.wid;
      A += a;
      p = madd(p, c.p, a); d = madd(d, c.dir, a);
      n = madd(n, dot(c.nrm, ref) < 0 ? mul(c.nrm, -1) : c.nrm, a);
      ao += c.ao * a; flex += c.flex * a; phase += c.phase * a; droop += c.droop * a; asp += (c.len / c.wid) * a;
    }
    asp /= A;
    const k = group.length > 1 ? 0.8 : 1.0;   // 重なりの分（まとめた方が被覆は少ない）
    let wid = Math.sqrt((A * k) / asp), L = wid * asp;
    if (L > cardMax) { const s = cardMax / L; L *= s; wid *= s; }
    out.push({
      p: mul(p, 1 / A), dir: norm(d), nrm: norm(n), len: L, wid, layer: group[0].layer, droop: droop / A,
      ao: ao / A, flex: flex / A, phase: phase / A, rand: group[0].rand,
    });
  }
  return out;
}
