/* ===========================================================
   岩の形（three を import しない。Node のテストからも読む）
   -----------------------------------------------------------
   icosphere（細分 4 / 3 / 2 = LOD0–2）→ 方向の関数で変位：
     楕円体 × fbm の塊 → 節理の欠け（数枚の平面で «柔らかく» 削る：角が丸まる = 風化・侵食）
     → 底を潰す（地面に座る）→ 細かい凹凸
   変位は単位方向だけの関数なので LOD を替えても輪郭が揃う（正規化の倍率も LOD0 の物を使う）。
   頂点の窪みの AO（凹んだ所・地面との接地を暗く）を ngRockV.x、高さ 0..1 を ngRockV.y に。
   正規化：底面中心が原点・上端 y = 1・xz の最大半径 = 1（placement の «半径 0.40·size·(sx, sz)、高さ size·sy»）
   =========================================================== */
import { mulberry32, stream } from '../../world/rng.js';

/** 形の数（placement.boulders[].shape 0..11 を % で畳む） */
export const ROCK_SHAPES = 8;
export const ROCK_LOD_DETAIL = [4, 3, 2];

/* ---- 3D の値ノイズ（整数格子のハッシュ。決定的） ---- */
function h3(i, j, k, s) {
  let h = (s ^ Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise3(x, y, z, s) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
  const fx = x - i, fy = y - j, fz = z - k;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  return L(
    L(L(h3(i, j, k, s), h3(i + 1, j, k, s), u), L(h3(i, j + 1, k, s), h3(i + 1, j + 1, k, s), u), v),
    L(L(h3(i, j, k + 1, s), h3(i + 1, j, k + 1, s), u), L(h3(i, j + 1, k + 1, s), h3(i + 1, j + 1, k + 1, s), u), v),
    w,
  );
}
export function fbm3(x, y, z, s, oct) {
  let a = 0.5, f = 1, t = 0, n = 0;
  for (let o = 0; o < oct; o++) { t += a * (vnoise3(x * f, y * f, z * f, s + o * 101) * 2 - 1); n += a; a *= 0.5; f *= 2.03; }
  return t / n;
}

/* ---- icosphere（索引つき） ---- */
export function icosphere(detail) {
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((p) => { const l = Math.hypot(...p); return [p[0] / l, p[1] / l, p[2] / l]; });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let d = 0; d < detail; d++) {
    const cache = new Map(), nf = [];
    const mid = (a, b) => {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      let m = cache.get(key);
      if (m === undefined) {
        const p = [(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2];
        const l = Math.hypot(...p);
        v.push([p[0] / l, p[1] / l, p[2] / l]);
        m = v.length - 1;
        cache.set(key, m);
      }
      return m;
    };
    for (const [a, b, c] of f) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = nf;
  }
  return { v, f };
}

/**
 * 形 k の変位（単位方向 → 点）
 * @param {number} seed
 * @param {number} k
 */
export function rockShapeFn(seed, k) {
  const rnd = mulberry32(stream(seed >>> 0, `hardscape-rock-${k}`));
  const s1 = (rnd() * 1e9) | 0, s2 = (rnd() * 1e9) | 0, s3 = (rnd() * 1e9) | 0;
  const e = [1, 0.8 + 0.3 * rnd(), 0.8 + 0.35 * rnd()];
  const lump = 0.16 + 0.1 * rnd();
  /* 節理の欠け：6–10 枚の面（横と上が多い）+ 6 割の形で平らな頂。kSoft が角の丸まり（風化・侵食）の幅 */
  const planes = [];
  const np = 6 + Math.floor(rnd() * 5);
  for (let i = 0; i < np; i++) {
    const th = rnd() * Math.PI * 2, y = -0.2 + 0.95 * rnd();
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    planes.push({ n: [Math.cos(th) * r, y, Math.sin(th) * r], d: 0.48 + 0.32 * rnd() });
  }
  if (rnd() < 0.6) {
    const tx = (rnd() - 0.5) * 0.5, tz = (rnd() - 0.5) * 0.5, l = Math.hypot(tx, 1, tz);
    planes.push({ n: [tx / l, 1 / l, tz / l], d: (0.5 + 0.25 * rnd()) * e[1] });
  }
  const kSoft = 0.022 + 0.04 * rnd();
  const sp = (s) => 0.5 * (s + Math.sqrt(s * s + kSoft * kSoft));
  return (p) => {
    const r = 1 + lump * fbm3(p[0] * 1.0, p[1] * 1.0, p[2] * 1.0, s1, 4) + 0.06 * fbm3(p[0] * 2.4, p[1] * 2.4, p[2] * 2.4, s2 + 7, 3) + 0.03 * fbm3(p[0] * 5.0, p[1] * 5.0, p[2] * 5.0, s2, 3);
    let q = [p[0] * r * e[0], p[1] * r * e[1], p[2] * r * e[2]];
    for (const pl of planes) {
      const s = q[0] * pl.n[0] + q[1] * pl.n[1] + q[2] * pl.n[2] - pl.d;
      const c = sp(s);
      q = [q[0] - pl.n[0] * c, q[1] - pl.n[1] * c, q[2] - pl.n[2] * c];
    }
    const yb = -0.32 * e[1];
    if (q[1] < yb) q[1] = yb + (q[1] - yb) * 0.22;
    const fine = 0.012 * fbm3(p[0] * 11, p[1] * 11, p[2] * 11, s3, 2);
    const l = Math.hypot(q[0], q[1], q[2]) || 1;
    return [q[0] + (q[0] / l) * fine, q[1] + (q[1] / l) * fine, q[2] + (q[2] / l) * fine];
  };
}

/**
 * 8 形 × 3 LOD を作る
 * @param {number} seed
 * @returns {{lods: {pos: Float32Array, nrm: Float32Array, rv: Float32Array, idx: Uint16Array|Uint32Array}[]}[]}
 */
export function buildRockShapes(seed) {
  const spheres = ROCK_LOD_DETAIL.map((d) => icosphere(d));
  const out = [];
  for (let k = 0; k < ROCK_SHAPES; k++) {
    const fn = rockShapeFn(seed, k);
    let norm = null;
    const lods = spheres.map((sp) => {
      const P = sp.v.map(fn);
      if (!norm) {
        let y0 = Infinity, y1 = -Infinity, rx = 0;
        let cx = 0, cz = 0;
        for (const p of P) { cx += p[0]; cz += p[2]; }
        cx /= P.length; cz /= P.length;
        for (const p of P) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); rx = Math.max(rx, Math.hypot(p[0] - cx, p[2] - cz)); }
        norm = { y0, sy: 1 / (y1 - y0), sr: 1 / rx, cx, cz };
      }
      const n = P.length;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = (P[i][0] - norm.cx) * norm.sr;
        pos[i * 3 + 1] = (P[i][1] - norm.y0) * norm.sy;
        pos[i * 3 + 2] = (P[i][2] - norm.cz) * norm.sr;
      }
      const idx = n > 65535 ? new Uint32Array(sp.f.length * 3) : new Uint16Array(sp.f.length * 3);
      /* icosphere の面は外から見て反時計回り（three の向き）か確かめて揃える */
      sp.f.forEach((t, i) => { idx[i * 3] = t[0]; idx[i * 3 + 1] = t[2]; idx[i * 3 + 2] = t[1]; });
      const nrm = vertexNormals(pos, idx);
      if (signedVolume(pos, idx) < 0) { for (let i = 0; i < idx.length; i += 3) { const a = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = a; } for (let i = 0; i < nrm.length; i++) nrm[i] = -nrm[i]; }
      const rv = cavityAO(pos, nrm, idx);
      return { pos, nrm, rv, idx };
    });
    out.push({ lods });
  }
  return out;
}

function vertexNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [a, b, c]) { n[q] += nx; n[q + 1] += ny; n[q + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}

function signedVolume(pos, idx) {
  let v = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v;
}

/* 窪みの AO：近傍の平均との差（法線方向）で凹凸を測る + 接地の暗さ。(ao, 高さ 0..1) */
function cavityAO(pos, nrm, idx) {
  const n = pos.length / 3;
  const sum = new Float32Array(n * 3), cnt = new Float32Array(n), el = new Float32Array(n);
  for (let k = 0; k < idx.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[k + e], b = idx[k + ((e + 1) % 3)];
      const d = Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
      for (const [p, q] of [[a, b], [b, a]]) {
        sum[p * 3] += pos[q * 3]; sum[p * 3 + 1] += pos[q * 3 + 1]; sum[p * 3 + 2] += pos[q * 3 + 2];
        cnt[p]++; el[p] += d;
      }
    }
  }
  const rv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const c = cnt[i] || 1;
    const dx = pos[i * 3] - sum[i * 3] / c, dy = pos[i * 3 + 1] - sum[i * 3 + 1] / c, dz = pos[i * 3 + 2] - sum[i * 3 + 2] / c;
    const k = (dx * nrm[i * 3] + dy * nrm[i * 3 + 1] + dz * nrm[i * 3 + 2]) / Math.max(el[i] / c, 1e-4);   // + 凸・− 凹
    const y = pos[i * 3 + 1];
    const ground = 0.5 + 0.5 * Math.min(1, Math.max(0, y / 0.3));
    rv[i * 2] = Math.min(1, Math.max(0.3, 0.86 + 1.6 * k)) * ground;
    rv[i * 2 + 1] = y;
  }
  return rv;
}
