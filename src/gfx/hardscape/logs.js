/* ===========================================================
   流木・立ち枯れ（白く晒された幹と枝）の幾何（three を import しない）
   -----------------------------------------------------------
   - 立ち枯れ：lake.structures の snag を x, z, rot, h, r に «正確に»。幹の根元は湖底（heightfield の高さ）、上端 = 湖底 + h。
     幹の半径 ≈ 0.42r（根元の張り 0.55r）、枝は軸から r の内側（当たりは r × 1.15）。折れた上端はぎざぎざ
   - 流木：placement.driftwood の x, z, rot, len, radius。地面に半分埋めて寝かせ、傾きは地面に沿わせる
   =========================================================== */
import { GeoBuilder, WOOD_KIND as K } from './geo.js';
import { mulberry32, stream } from '../../world/rng.js';

/**
 * 立ち枯れ 1 本（世界座標）
 * @param {GeoBuilder} g
 * @param {{x:number, z:number, rot:number, h:number, r:number}} s
 * @param {number} baseY 湖底の高さ
 * @param {number} seed
 * @param {number} idx
 */
export function addSnag(g, s, baseY, seed, idx) {
  const rnd = mulberry32(stream(seed >>> 0, `hardscape-snag-${idx}`));
  const rb = 0.36 * s.r;
  /* 傾き：上端のずれは 0.3r まで（当たりの円から出ない） */
  const lean = Math.min(0.12, (0.3 * s.r) / Math.max(s.h, 0.1));
  const ld = [Math.sin(s.rot) * lean, Math.cos(s.rot) * lean];
  const top = [s.x + ld[0] * s.h, baseY + s.h, s.z + ld[1] * s.h];
  const p0 = [s.x, baseY - 0.25, s.z];
  const ph = rnd() * 6.283, ph2 = rnd() * 6.283;
  const tone = rnd();
  const rFn = (t, th) => {
    const flare = 1 + 0.35 * Math.pow(Math.max(0, 1 - t / 0.12), 2) * (1 + 0.4 * Math.sin(th * 4 + ph));
    const taper = 1 - 0.55 * t;
    const furrow = 1 + 0.06 * Math.sin(th * 7 + ph2 + t * 5) + 0.03 * Math.sin(th * 13 + t * 17);
    return rb * flare * taper * furrow;
  };
  const rows = Math.max(8, Math.round(s.h / 0.3));
  /* 折れた上端：最後の段を角度ごとに上下させる（ぎざぎざ） */
  const segs = 16;
  const base = g.count;
  g.log(p0, top, rFn, segs, rows + 1, [K.BLEACHED, tone, 0, 0], [rnd() * 0.75, rnd() * 4], false, false);
  const cols = segs + 1;
  const last = base + rows * cols;
  const ax = [(top[0] - p0[0]), (top[1] - p0[1]), (top[2] - p0[2])];
  const al = Math.hypot(...ax);
  for (let j = 0; j <= segs; j++) {
    const th = ((j % segs) / segs) * Math.PI * 2;
    const jag = -0.18 * s.r * (0.5 + 0.5 * Math.sin(th * 3 + ph)) - 0.12 * s.r * rnd();
    const k = (last + j) * 3;
    g.pos[k] += (ax[0] / al) * jag; g.pos[k + 1] += (ax[1] / al) * jag; g.pos[k + 2] += (ax[2] / al) * jag;
  }
  /* 上端の折れ口（中心を少し低く：裂けた芯） */
  const cc = g.v(top[0] - (ax[0] / al) * 0.2 * s.r, top[1] - (ax[1] / al) * 0.2 * s.r, top[2] - (ax[2] / al) * 0.2 * s.r, 0.1, 0.1, [K.BLEACHED, tone, 1, 0]);
  for (let j = 0; j < segs; j++) g.tri(cc, last + j, last + j + 1);
  /* 枝：2–4 本、上 45% から。水平の届きは r − 幹の半径 */
  const nb = 3 + Math.floor(rnd() * 3);
  for (let b = 0; b < nb; b++) {
    const t = 0.42 + 0.5 * rnd();
    const th = rnd() * Math.PI * 2;
    const rt = rFn(t, th);
    const c = [p0[0] + ax[0] * t, p0[1] + ax[1] * t, p0[2] + ax[2] * t];
    const up = 0.5 + 0.6 * rnd();
    const reach = Math.max(0.15, (s.r * 1.08 - rt * 0.4 - Math.hypot(ld[0], ld[1]) * s.h * t));
    const len = reach / Math.cos(Math.atan(up));
    const d = [Math.cos(th), up, Math.sin(th)];
    const dl = Math.hypot(...d);
    const e = [c[0] + (d[0] / dl) * len, c[1] + (d[1] / dl) * len, c[2] + (d[2] / dl) * len];
    const br = rt * (0.28 + 0.15 * rnd());
    const s0 = [c[0] - (d[0] / dl) * rt * 0.6, c[1] - (d[1] / dl) * rt * 0.6, c[2] - (d[2] / dl) * rt * 0.6];
    g.log(s0, e, (tt) => br * (1 - 0.75 * tt) + 0.004, 7, 5, [K.BLEACHED, tone, 0, 0], [rnd() * 0.75, rnd() * 4], false, true);
    /* 小枝 1 本（枝の 55–80% から上へ）。届きは親の枝の内側 */
    const tt = 0.55 + 0.25 * rnd();
    const c2 = [s0[0] + (e[0] - s0[0]) * tt, s0[1] + (e[1] - s0[1]) * tt, s0[2] + (e[2] - s0[2]) * tt];
    const th2 = th + (rnd() - 0.5) * 1.6;
    const l2 = len * (0.3 + 0.2 * rnd());
    const d2 = [Math.cos(th2) * 0.5, 1.0, Math.sin(th2) * 0.5], dl2 = Math.hypot(...d2);
    const e2 = [c2[0] + (d2[0] / dl2) * l2, c2[1] + (d2[1] / dl2) * l2, c2[2] + (d2[2] / dl2) * l2];
    const rr = Math.hypot(e2[0] - s.x, e2[2] - s.z);
    if (rr < s.r * 1.1 && e2[1] < top[1] - 0.02) g.log(c2, e2, (q) => br * 0.45 * (1 - 0.8 * q) + 0.003, 5, 3, [K.BLEACHED, tone, 0, 0], [rnd() * 0.75, rnd() * 4], false, true);
  }
  return { top: baseY + s.h, maxR: s.r * 1.1 };
}

/**
 * 流木 1 本（世界座標）。groundAt で両端の高さに沿わせる
 * @param {GeoBuilder} g
 * @param {{x:number, z:number, y:number, rot:number, len:number, radius:number}} d
 * @param {(x:number, z:number) => number} groundAt
 * @param {number} seed
 * @param {number} idx
 */
export function addDriftwood(g, d, groundAt, seed, idx) {
  const rnd = mulberry32(stream(seed >>> 0, `hardscape-drift-${idx}`));
  const ux = Math.sin(d.rot), uz = Math.cos(d.rot);
  const hl = d.len / 2;
  const ax = d.x - ux * hl, az = d.z - uz * hl, bx = d.x + ux * hl, bz = d.z + uz * hl;
  const r = d.radius;
  const ya = groundAt(ax, az) + r * 0.45, yb = groundAt(bx, bz) + r * 0.45;
  const ph = rnd() * 6.283, tone = 0.5 + 0.5 * rnd();
  const rFn = (t, th) => r * (1 - 0.3 * t) * (1 + 0.07 * Math.sin(th * 5 + ph + t * 8) + 0.05 * Math.sin(th * 2 + ph * 2));
  g.log([ax, ya, az], [bx, yb, bz], rFn, 11, Math.max(4, Math.round(d.len / 0.25)) + 1, [K.BLEACHED, tone, 0, 0], [rnd() * 0.75, rnd() * 4], true, true);
  /* 枝の付け根（1–2 本の折れた短い枝） */
  const nb = rnd() < 0.7 ? 1 + (rnd() < 0.4 ? 1 : 0) : 0;
  for (let b = 0; b < nb; b++) {
    const t = 0.25 + 0.5 * rnd();
    const c = [ax + (bx - ax) * t, ya + (yb - ya) * t, az + (bz - az) * t];
    const side = rnd() < 0.5 ? -1 : 1;
    const dir = [uz * side * 0.8 + ux * 0.4, 0.35 + 0.4 * rnd(), -ux * side * 0.8 + uz * 0.4];
    const L = r * (2.5 + 3 * rnd());
    const e = [c[0] + dir[0] * L, c[1] + dir[1] * L, c[2] + dir[2] * L];
    g.log(c, e, (tt) => r * 0.35 * (1 - 0.6 * tt), 6, 3, [K.BLEACHED, tone, 0, 0], [rnd() * 0.75, rnd() * 4], false, true);
  }
}
