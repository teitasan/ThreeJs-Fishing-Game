/* ===========================================================
   桟橋・灯籠の幾何（three を import しない。Node のテストからも読む）
   -----------------------------------------------------------
   寸法は契約どおり（src/world/dock.js・debug.js の箱）：
     床幅 3.4m（床板の長さ）・床の上面 = dockY・床と桁は [dockY − 0.42, dockY + 0.18] の箱の中
     先端 2.3m の手すり（上端 ≤ dockY + 1.05、|si| ≤ 1.62）・杭は 2.4m 間隔（先端から数える）
     灯籠 r 0.26・上端 dockY + 2.3（placement.lamp）
   座標：P(al, si, y) = start + dir·al + right·si（right = dockFixtures の right。灯籠・小舟と同じ向き）
   床板は 1 枚ずつ幅・反り（カップ・弓なり・ねじれ）・隙間 1.5cm・端の不揃い・色むら（ngWood.y）
   =========================================================== */
import { GeoBuilder, WOOD_KIND as K } from './geo.js';
import { mulberry32, stream } from '../../world/rng.js';

/** 寸法の定数（テストと当たりの検査が読む） */
export const DOCK_DIM = Object.freeze({
  W: 3.4, HALF_WALK: 1.62, PLANK_T: 0.035, GAP: 0.015, STRINGER_H: 0.16, BEARER_H: 0.15,
  PILE_SPACING: 2.4, PILE_SI: 1.45, RAIL_LEN: 2.3, RAIL_TOP: 1.035, BOX_BOTTOM: 0.42, BOX_TOP_RAIL: 1.05,
  STRINGER_SI: [-1.3, 0, 1.3], LAMP_POST_TOP: 1.86, LAMP_HALF: 0.18, LAMP_TOP: 2.3,
});

/**
 * @param {{start:{x:number,z:number}, dir:{x:number,z:number}, right:{x:number,z:number}, L:number, Y:number,
 *          lamp:{x:number,z:number}, groundAt:(x:number,z:number)=>number, seed:number}} o
 * @returns {{geo: GeoBuilder, piles: {x:number,z:number,r:number,top:number,al:number,si:number}[], lampLight: number[], rows: number[]}}
 */
export function buildDock(o) {
  const { start, dir, right, L, Y, lamp, groundAt } = o;
  const D = DOCK_DIM;
  const rnd = mulberry32(stream(o.seed >>> 0, 'hardscape-dock'));
  const g = new GeoBuilder();
  const P = (al, si, y) => [start.x + dir.x * al + right.x * si, y, start.z + dir.z * al + right.z * si];
  const AX = [right.x, 0, right.z], AY = [0, 1, 0], AZ = [dir.x, 0, dir.z];

  /* ---- 床板：岸から先端へ。板は桟橋を横切る向き（長さ 3.4m） ---- */
  let al = 0.004;
  let n = 0;
  while (al < L - 0.05) {
    let w = 0.15 + 0.06 * rnd();
    if (al + w > L - 0.004) w = L - 0.004 - al;
    if (w < 0.06) break;
    const variant = Math.floor(rnd() * 4) % 4;
    const voff = rnd() * 4;
    const tone = rnd();
    const cup = 0.001 + 0.0028 * rnd();
    const bow = (rnd() - 0.5) * 0.007;
    const twist = (rnd() - 0.5) * 0.005;
    const e0 = (rnd() - 0.5) * 0.05, e1 = (rnd() - 0.5) * 0.05;
    const yawJ = (rnd() - 0.5) * 0.006;
    const len0 = -D.W / 2 + e0, len1 = D.W / 2 + e1;
    const wv = [K.DECK, tone, n, w];
    const yTop = (s, q) => {
      const x = (2 * s) / w - 1, qq = (2 * q) / D.W;
      return Y - 0.0035 + cup * (x * x - 1) + bow * (1 - qq * qq) + twist * x * qq;
    };
    const cols = [0, 0.006, w * 0.5, w - 0.006, w];
    const drop = [0.0035, 0, 0, 0, 0.0035];
    const rows = 17;
    const q = (i) => len0 + (len1 - len0) * (i / (rows - 1));
    const at = (s, qq, y) => {
      const a = al + s + qq * yawJ;
      return P(a, qq, y);
    };
    const U = (s) => (variant + 0.04 + 0.92 * (s / w)) / 4;
    /* 上面（s が dir・q が right の格子。dir × right = up なのでそのままで上向き） */
    g.grid(rows, cols.length, (i, j) => {
      const s = cols[j], qq = q(i);
      const p = at(s, qq, yTop(s, qq) - drop[j]);
      return [p[0], p[1], p[2], U(s), (voff + qq) / 4];
    }, wv, false);
    /* 長い側面 2 枚（s = 0 と s = w） */
    for (const side of [0, 1]) {
      const s = side ? w : 0;
      g.grid(rows, 2, (i, j) => {
        const qq = q(i);
        const y = j === 0 ? yTop(s, qq) - drop[side ? 4 : 0] : Y - D.PLANK_T;
        const p = at(s, qq, y);
        return [p[0], p[1], p[2], U(side ? w * 0.97 : w * 0.03) + (j ? 0.004 : 0), (voff + qq) / 4];
      }, wv, side === 0);
    }
    /* 底 */
    g.grid(rows, 2, (i, j) => {
      const s = j ? w : 0, qq = q(i);
      const p = at(s, qq, Y - D.PLANK_T);
      return [p[0], p[1], p[2], U(s), (voff + qq) / 4];
    }, wv, true);
    /* 木口 2 枚 */
    for (const end of [0, 1]) {
      const qq = end ? len1 : len0;
      g.grid(cols.length, 2, (j, k) => {
        const s = cols[j];
        const y = k === 0 ? yTop(s, qq) - drop[j] : Y - D.PLANK_T;
        const p = at(s, qq, y);
        return [p[0], p[1], p[2], U(s), (voff + qq + (k ? 0.03 : 0)) / 4];
      }, [K.DECK, tone, n, w], end === 1);
    }
    al += w + D.GAP + (rnd() - 0.5) * 0.004;
    n++;
  }

  /* ---- 桁（長手）3 本：床板の下 ---- */
  const yStr = Y - D.PLANK_T - D.STRINGER_H / 2;
  for (const si of D.STRINGER_SI) {
    g.box(P(L / 2, si, yStr), AX, AY, AZ, 0.045, D.STRINGER_H / 2, L / 2 - 0.02, [K.TIMBER, 0.3 + 0.4 * rnd(), 0, 0.09], [rnd() * 0.7, rnd() * 4]);
  }

  /* ---- 杭の列：先端から 2.4m ごと ---- */
  const rows = [];
  for (let a = L - 0.25; a >= 0.15; a -= D.PILE_SPACING) rows.push(a);
  rows.reverse();
  const yBear = Y - D.PLANK_T - D.STRINGER_H - D.BEARER_H / 2;
  const bearBot = yBear - D.BEARER_H / 2;
  const piles = [];
  rows.forEach((ra, k) => {
    /* 受け梁（横） */
    g.box(P(ra, 0, yBear), AZ, AY, AX, 0.065, D.BEARER_H / 2, D.HALF_WALK + 0.03, [K.TIMBER, 0.2 + 0.5 * rnd(), 0, 0.13], [rnd() * 0.7, rnd() * 4]);
    for (const sgn of [-1, 1]) {
      const si = sgn * D.PILE_SI;
      const base = P(ra, si, 0);
      const ground = groundAt(base[0], base[2]);
      const bot = Math.min(ground - 0.45, bearBot - 0.3);
      const r0 = 0.125 + 0.025 * rnd();
      const lean = [(rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.03];
      const top = P(ra, si, bearBot);
      const b0 = [base[0] + lean[0] * (top[1] - bot), bot, base[2] + lean[1] * (top[1] - bot)];
      const ph = rnd() * 6.283, ph2 = rnd() * 6.283;
      const rFn = (t, th) => r0 * (1 + 0.035 * Math.sin(th * 3 + ph) + 0.02 * Math.sin(th * 5 + ph2 + t * 9) + 0.04 * (1 - t) * 0.5);
      const H = top[1] - bot;
      const nRows = Math.max(6, Math.min(26, Math.round(H / 0.5)));
      const tn = rnd(), u0 = rnd() * 0.75, v0 = rnd() * 4;
      g.log(b0, top, rFn, 14, nRows + 1, [K.PILE, tn, r0, u0], [u0, v0], false, true);   // w.w = u0（杭の周の木目の位相）
      piles.push({ x: base[0], z: base[2], r: r0 * 1.04, top: bearBot, al: ra, si });
      /* ボルト（受け梁を貫く） */
      g.log(P(ra - 0.1, si, yBear), P(ra + 0.1, si, yBear), () => 0.011, 6, 2, [K.IRON, rnd(), 0, 0]);
      g.box(P(ra - 0.068, si, yBear), AZ, AY, AX, 0.004, 0.022, 0.022, [K.IRON, rnd(), 0, 0]);
      g.box(P(ra + 0.068, si, yBear), AZ, AY, AX, 0.004, 0.022, 0.022, [K.IRON, rnd(), 0, 0]);
    }
    /* 筋交い（列ごとに向きを替える）。水面の少し上まで */
    const gL = groundAt(...xz(P(ra, -D.PILE_SI, 0))), gR = groundAt(...xz(P(ra, D.PILE_SI, 0)));
    const yLow = Math.max(Math.max(gL, gR) + 0.25, 0.22);
    if (bearBot - 0.05 - yLow > 0.35) {
      const s0 = (k & 1) ? -1 : 1;
      const a0 = P(ra + 0.16, s0 * (D.PILE_SI - 0.02), bearBot - 0.04), a1 = P(ra + 0.16, -s0 * (D.PILE_SI - 0.02), yLow);
      const c = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2, (a0[2] + a1[2]) / 2];
      const d = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const az = [d[0] / len, d[1] / len, d[2] / len];
      const ax = [dir.x, 0, dir.z];
      const ay = crossN(az, ax);
      g.box(c, ax, ay, az, 0.022, 0.06, len / 2, [K.TIMBER, 0.6 + 0.3 * rnd(), 1, 0.12], [rnd() * 0.7, rnd() * 4]);
    }
  });

  /* ---- 岸の土台（付け根の横木） ---- */
  {
    const gm = Math.min(groundAt(...xz(P(0.08, -1.5, 0))), groundAt(...xz(P(0.08, 1.5, 0))));
    const top = Y - D.PLANK_T, bot = Math.max(gm - 0.25, Y - 1.6);
    if (top - bot > 0.1) g.box(P(0.08, 0, (top + bot) / 2), AZ, AY, AX, 0.075, (top - bot) / 2, D.HALF_WALK + 0.04, [K.TIMBER, 0.85, 2, 0.15], [0.1, 1.3]);
  }

  /* ---- 先端の手すり（先端から 2.3m・上端 dockY + 1.035） ---- */
  const railSi = D.HALF_WALK - 0.05;
  for (const a of [L - 0.05, L - 1.15, L - 2.25]) {
    for (const sgn of [-1, 1]) {
      g.box(P(a, sgn * railSi, Y + (D.RAIL_TOP - 0.045) / 2), AX, AY, AZ, 0.045, (D.RAIL_TOP - 0.045) / 2, 0.045, [K.TIMBER, 0.4 + 0.4 * rnd(), 0, 0.09], [rnd() * 0.7, rnd() * 4]);
    }
  }
  for (const sgn of [-1, 1]) {
    g.box(P(L - 1.15, sgn * railSi, Y + D.RAIL_TOP - 0.0225), AX, AY, AZ, 0.05, 0.0225, 1.15, [K.TIMBER, 0.35, 0, 0.1], [rnd() * 0.7, rnd() * 4]);
    g.box(P(L - 1.15, sgn * railSi, Y + 0.55), AX, AY, AZ, 0.028, 0.035, 1.13, [K.TIMBER, 0.5, 0, 0.07], [rnd() * 0.7, rnd() * 4]);
  }
  g.box(P(L - 0.05, 0, Y + D.RAIL_TOP - 0.0225), AZ, AY, AX, 0.05, 0.0225, D.HALF_WALK - 0.001, [K.TIMBER, 0.35, 0, 0.1], [rnd() * 0.7, rnd() * 4]);
  g.box(P(L - 0.05, 0, Y + 0.55), AZ, AY, AX, 0.028, 0.035, railSi, [K.TIMBER, 0.5, 0, 0.07], [rnd() * 0.7, rnd() * 4]);

  /* ---- 灯籠：柱 + 行灯（和紙の 4 面）+ 寄棟の屋根。上端 dockY + 2.3 ---- */
  const lx = lamp.x, lz = lamp.z;
  const LP = (dx, dz, y) => [lx + right.x * dx + dir.x * dz, y, lz + right.z * dx + dir.z * dz];
  const yPT = Y + D.LAMP_POST_TOP;
  g.box(LP(0, 0, Y + D.LAMP_POST_TOP / 2), AX, AY, AZ, 0.055, D.LAMP_POST_TOP / 2, 0.055, [K.TIMBER, 0.7, 0, 0.11], [0.3, 0.5]);
  /* 柱の根元の金物 */
  g.box(LP(0, 0, Y + 0.08), AX, AY, AZ, 0.062, 0.08, 0.062, [K.IRON, 0.5, 0, 0]);
  const yB = yPT + 0.012, yT = Y + 2.165;
  g.box(LP(0, 0, yB), AX, AY, AZ, 0.165, 0.012, 0.165, [K.TIMBER, 0.9, 0, 0.33], [0.2, 0.1]);
  for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    g.box(LP(cx * 0.138, cz * 0.138, (yB + yT) / 2), AX, AY, AZ, 0.017, (yT - yB) / 2, 0.017, [K.TIMBER, 0.9, 0, 0.034], [0.5, 0.3]);
  }
  /* 和紙：面の中の (u, v) を ngWood.zw に入れて組子の格子を描く */
  const panel = (fx, fz) => {
    const nx = fx, nz = fz;                     // 外向き（right / dir の成分）
    const tx = -fz, tz = fx;                    // 面の横
    const h0 = yB + 0.012, h1 = yT - 0.012, half = 0.121, off = 0.132;
    const base = g.count;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const u = j, v = i;
        const p = LP(nx * off + tx * (u * 2 - 1) * half, nz * off + tz * (u * 2 - 1) * half, h0 + (h1 - h0) * v);
        g.v(p[0], p[1], p[2], 0.5, 0.5, [K.PAPER, 0.5, u, v]);
      }
    }
    g.quad(base, base + 2, base + 3, base + 1);
  };
  panel(1, 0); panel(0, 1); panel(-1, 0); panel(0, -1);
  g.box(LP(0, 0, yT + 0.008), AX, AY, AZ, 0.172, 0.009, 0.172, [K.TIMBER, 0.9, 0, 0.34], [0.2, 0.2]);
  /* 屋根（四角錐）：底 dockY + 2.18、頂 dockY + 2.285、宝珠で 2.3 */
  {
    const y0 = yT + 0.017, y1 = Y + 2.285, h = D.LAMP_HALF;
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => LP(a * h, b * h, y0));
    const apex = LP(0, 0, y1);
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      const i0 = g.v(a[0], a[1], a[2], 0.1, 0, [K.TIMBER, 0.95, 0, 0]);
      const i1 = g.v(b[0], b[1], b[2], 0.2, 0, [K.TIMBER, 0.95, 0, 0]);
      const i2 = g.v(apex[0], apex[1], apex[2], 0.15, 0.05, [K.TIMBER, 0.95, 0, 0]);
      g.tri(i0, i2, i1);
      g.tri(i0, i1, i2);
    }
    const u0 = c.map((p) => g.v(p[0], p[1] - 0.004, p[2], 0.1, 0, [K.TIMBER, 0.95, 0, 0]));
    g.quad(u0[0], u0[1], u0[2], u0[3]);
    g.quad(u0[0], u0[3], u0[2], u0[1]);
    g.log(LP(0, 0, y1 - 0.01), LP(0, 0, Y + D.LAMP_TOP - 0.0005), (t) => 0.018 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.85)) + 0.004, 8, 5, [K.IRON, 0.6, 0, 0], [0, 0], false, false);
  }
  /* 屋根の三角は両面に張った（片側だけだと寄棟の向きで欠ける）。法線は面ごと */
  const lampLight = LP(0, 0, (yB + yT) / 2 + 0.01);
  return { geo: g, piles, lampLight, rows };

  function xz(p) { return [p[0], p[2]]; }
}

function crossN(a, b) {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const l = Math.hypot(c[0], c[1], c[2]) || 1;
  return [c[0] / l, c[1] / l, c[2] / l];
}

/**
 * 当たりの箱（debug.js：床 [0, L] × [Y − 0.42, Y + 0.18] × ±1.62、先端の手すり [L − 2.3, L] × 上端 Y + 1.05）と
 * 灯籠（r 0.26・上端 Y + 2.3）に対する見た目の差（cm）。正 = 箱の外へはみ出す量
 * @param {ArrayLike<number>} pos 世界の位置（xyz）
 * @param {ArrayLike<number>} w ngWood（種類, 色, 札, 幅）
 */
export function dockContractReport(pos, w, o) {
  const { start, dir, right, Y, L, lamp } = o;
  const r = { deckTopMax: -Infinity, deckTopMin: Infinity, floorBottom: Infinity, floorAlMin: Infinity, floorAlMax: -Infinity, floorTop: -Infinity,
    railAlMin: Infinity, railSiMax: 0, railTop: -Infinity, lampR: 0, lampTop: -Infinity, deckSiMax: 0, bad: 0 };
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 4) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2], kind = Math.round(w[j]), tag = Math.round(w[j + 2]);
    if (!Number.isFinite(x + y + z)) { r.bad++; continue; }
    const dx = x - start.x, dz = z - start.z;
    const al = dx * dir.x + dz * dir.z, si = dx * right.x + dz * right.z;
    const dl = Math.hypot(x - lamp.x, z - lamp.z);
    if (dl < 0.5 && y > Y + 0.05) { r.lampR = Math.max(r.lampR, dl); r.lampTop = Math.max(r.lampTop, y); continue; }
    if (kind === K.DECK) {
      r.deckTopMax = Math.max(r.deckTopMax, y);
      if (y > Y - 0.012) r.deckTopMin = Math.min(r.deckTopMin, y);
      r.deckSiMax = Math.max(r.deckSiMax, Math.abs(si));
    }
    if (kind === K.PILE || kind === K.ROPE || (kind === K.TIMBER && tag > 0)) continue;
    if (y > Y + 0.2) {
      r.railAlMin = Math.min(r.railAlMin, al); r.railSiMax = Math.max(r.railSiMax, Math.abs(si)); r.railTop = Math.max(r.railTop, y);
    } else {
      r.floorBottom = Math.min(r.floorBottom, y); r.floorTop = Math.max(r.floorTop, y);
      r.floorAlMin = Math.min(r.floorAlMin, al); r.floorAlMax = Math.max(r.floorAlMax, al);
    }
  }
  const cm = (v) => Math.round(v * 1000) / 10;
  return {
    deckTop: { max: cm(r.deckTopMax - Y), min: cm(r.deckTopMin - Y) },
    floorBox: { bottomBelow: cm((Y - 0.42) - r.floorBottom), topOver: cm(r.floorTop - (Y + 0.18)), alBefore: cm(-r.floorAlMin), alOver: cm(r.floorAlMax - L) },
    deckHalfWidth: cm(r.deckSiMax),
    rail: { lenFromTip: cm(L - r.railAlMin), siOver: cm(r.railSiMax - DOCK_DIM.HALF_WALK), topOver: cm(r.railTop - (Y + DOCK_DIM.BOX_TOP_RAIL)) },
    lamp: { rOver: cm(r.lampR - 0.26), topDiff: cm(r.lampTop - (lamp.top ?? Y + DOCK_DIM.LAMP_TOP)) },
    nonFinite: r.bad,
  };
}
