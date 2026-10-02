/* ===========================================================
   木の和船（小さな伝馬船）の幾何（three を import しない）
   -----------------------------------------------------------
   船の座標：x = 幅（右舷 +）、y = 上（喫水線 0）、z = 長さ（舳先 +z）。全長 3.4m・最大幅 1.1m・深さ ≈ 0.42m
   - 平らな底（チャイン 1 本の角）・外へ開く舷側・反り上がる舳先と水押（みよし）・戸立て（平らな艫）
   - 床板は喫水線より上（y = 0.07。船の中に水面が透けない）・腰掛け 2 枚・櫓を 1 本
   当たり（placement.boat.circles：r 0.85 の円 2 つ・上端 by + 0.95）の内側に収まる
   =========================================================== */
import { GeoBuilder, WOOD_KIND as K } from './geo.js';

export const BOAT_DIM = Object.freeze({ HALF_L: 1.7, MAX_HALF_B: 0.55, FLOOR_Y: 0.07, BOW_CLEAT: [0, 0.5, 1.48] });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 舷側の最大半幅（t：0 = 艫、1 = 舳先） */
export function boatHalfB(t) {
  if (t < 0.45) return 0.32 + 0.23 * Math.sin((t / 0.45) * Math.PI * 0.5);
  const x = (t - 0.45) / 0.55;
  return Math.max(0.004, 0.55 * Math.pow(Math.max(0, 1 - Math.pow(x, 2.2)), 0.55));
}
export function boatBottomY(t) { return -0.11 + 0.04 * Math.pow(Math.max(0, 1 - t / 0.12), 2) + 0.30 * Math.pow(Math.max(0, (t - 0.62) / 0.38), 2.2); }
export function boatSheerY(t) { return 0.30 + 0.05 * Math.pow(Math.max(0, 1 - t / 0.2), 2) + 0.24 * Math.pow(Math.max(0, (t - 0.55) / 0.45), 2.4); }
export function boatBottomB(t) { return boatHalfB(t) * (0.66 - 0.2 * Math.max(0, (t - 0.6) / 0.4)); }

/** 高さ y での船の内側の半幅（内張りから 0.03m 内） */
export function boatInnerHalf(t, y) {
  const yb = boatBottomY(t) + 0.025, ys = boatSheerY(t);
  const k = clamp((y - yb) / Math.max(ys - yb, 1e-3), 0, 1);
  return boatBottomB(t) + (boatHalfB(t) - boatBottomB(t)) * k - 0.03;
}

/**
 * @param {() => number} rnd 決定的な乱数
 * @returns {GeoBuilder}
 */
export function buildBoat(rnd) {
  const g = new GeoBuilder();
  const HL = BOAT_DIM.HALF_L;
  const NT = 28;
  const ts = Array.from({ length: NT + 1 }, (_, i) => i / NT);
  const z = (t) => -HL + 2 * HL * t;
  const tone = 0.3 + 0.3 * rnd();
  const Uc = (girth) => (1 + 0.04 + 0.92 * clamp(girth / 0.5, 0, 1)) / 4;
  /* 舷側（外と内）：チャイン → 舷縁を 4 段 */
  for (const sgn of [-1, 1]) {
    for (const inner of [0, 1]) {
      const off = inner ? 0.024 : 0;
      g.grid(ts.length, 5, (i, j) => {
        const t = ts[i], k = j / 4;
        const B = boatHalfB(t), b = boatBottomB(t), yb = boatBottomY(t), ys = boatSheerY(t);
        const x = (b + (B - b) * k) - off * (1 - 0.3 * k), y = yb + (ys - yb) * k + (inner ? off * (1 - k) : 0);
        const girth = Math.hypot(B - b, ys - yb) * k;
        return [sgn * Math.max(x, 0.002), y, z(t), Uc(girth), z(t) / 4];
      }, [K.BOAT, tone, inner, 0], (sgn < 0) !== !!inner);
    }
  }
  /* 底（外は下向き・内は上向き） */
  for (const inner of [0, 1]) {
    const off = inner ? 0.024 : 0;
    g.grid(ts.length, 3, (i, j) => {
      const t = ts[i], b = Math.max(boatBottomB(t) - off, 0.002);
      const x = (j - 1) * b;
      return [x, boatBottomY(t) + off, z(t), (2 + 0.04 + 0.92 * (j / 2)) / 4, z(t) / 4];
    }, [K.BOAT, tone * 0.8, inner, 0], !!inner);
  }
  /* 舷縁の笠木（外と内を繋ぐ帯） */
  for (const sgn of [-1, 1]) {
    g.grid(ts.length, 3, (i, j) => {
      const t = ts[i], B = boatHalfB(t), ys = boatSheerY(t);
      const x = j === 0 ? B + 0.012 : j === 1 ? B - 0.012 : B - 0.04;
      const y = j === 1 ? ys + 0.022 : ys + 0.004;
      return [sgn * Math.max(x, 0.002), y, z(t), (3 + 0.1 + 0.3 * j) / 4, z(t) / 4];
    }, [K.TIMBER, 0.75, 0, 0.05], sgn < 0);
  }
  /* 戸立て（艫の板）：外は −z、内は +z */
  for (const inner of [0, 1]) {
    const t = 0.0, B = boatHalfB(t), b = boatBottomB(t), yb = boatBottomY(t), ys = boatSheerY(t);
    const zz = z(t) + (inner ? 0.024 : 0);
    const p = [[-b, yb], [b, yb], [B, ys], [-B, ys]].map(([x, y]) => g.v(x * (inner ? 0.95 : 1), y + (inner ? 0.02 : 0), zz, (1.1 + 0.8 * (x / (2 * B) + 0.5)) / 4, (y + 0.2) / 4, [K.BOAT, tone, 0, 0]));
    if (inner) g.quad(p[0], p[1], p[2], p[3]); else g.quad(p[0], p[3], p[2], p[1]);
  }
  /* 水押（舳先の柱） */
  g.box([0, (boatBottomY(1) + boatSheerY(1)) / 2 + 0.02, HL - 0.005], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.03, (boatSheerY(1) - boatBottomY(1)) / 2 + 0.06, 0.03, [K.TIMBER, 0.8, 0, 0.06], [0.4, 0.2]);
  /* 床板（喫水線より上）：3 枚、内側の幅で長さを決める */
  const fy = BOAT_DIM.FLOOR_Y;
  for (const xc of [-0.24, 0, 0.24]) {
    let t0 = -1, t1 = -1;
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const ok = Math.abs(xc) + 0.11 < boatInnerHalf(t, fy) && boatBottomY(t) + 0.04 < fy;
      if (ok && t0 < 0) t0 = t;
      if (ok) t1 = t;
    }
    if (t0 < 0 || t1 - t0 < 0.1) continue;
    const zc = (z(t0) + z(t1)) / 2, hl = (z(t1) - z(t0)) / 2 - 0.01;
    g.box([xc, fy, zc], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.1, 0.012, hl, [K.TIMBER, 0.55 + 0.3 * rnd(), 0, 0.2], [rnd() * 0.7, rnd() * 4]);
  }
  /* 腰掛け 2 枚 */
  for (const t of [0.3, 0.63]) {
    const y = 0.25, hw = boatInnerHalf(t, y) + 0.012;
    g.box([0, y, z(t)], [1, 0, 0], [0, 1, 0], [0, 0, 1], hw, 0.016, 0.1, [K.TIMBER, 0.6, 0, 0.2], [rnd() * 0.7, rnd() * 4]);
  }
  /* 肋（ろく）：内側の補強 5 本 */
  for (const t of [0.12, 0.3, 0.47, 0.63, 0.78]) {
    for (const sgn of [-1, 1]) {
      const B = boatHalfB(t), b = boatBottomB(t), yb = boatBottomY(t) + 0.024, ys = boatSheerY(t) - 0.02;
      const x0 = sgn * (b - 0.03), x1 = sgn * (B - 0.05);
      const c = [(x0 + x1) / 2, (yb + ys) / 2, z(t)];
      const d = [x1 - x0, ys - yb, 0], L = Math.hypot(d[0], d[1]);
      const ay = [d[0] / L, d[1] / L, 0];
      const ax = [ay[1], -ay[0], 0];
      g.box(c, ax, ay, [0, 0, 1], 0.012, L / 2, 0.02, [K.TIMBER, 0.7, 0, 0.04], [0.3, 0.3]);
    }
  }
  /* 櫓（腰掛けに渡して寝かせる） */
  g.log([-0.28, 0.29, -1.35], [0.22, 0.29, 0.9], (t) => 0.022 + (t < 0.18 ? 0.025 * (1 - t / 0.18) : 0), 7, 6, [K.TIMBER, 0.45, 0, 0.04], [0.6, 0.1]);
  /* 舳先の係留の金物 */
  const bc = BOAT_DIM.BOW_CLEAT;
  g.box([bc[0], boatSheerY((bc[2] + HL) / (2 * HL)) + 0.015, bc[2]], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.04, 0.012, 0.025, [K.IRON, 0.5, 0, 0]);
  return g;
}

/**
 * 小舟（休止の姿勢）が当たりの円 2 つの和の内側か（cm。正 = はみ出し）と上端
 * @param {ArrayLike<number>} pos 船の座標の位置
 * @param {{x:number, y:number, z:number, yaw:number, pitch?:number, roll?:number, circles:{x:number,z:number,r:number,top:number}[]}} bp
 */
export function boatContractReport(pos, bp) {
  const c = Math.cos(bp.yaw), s = Math.sin(bp.yaw);
  let out = -Infinity, outEnds = -Infinity, top = -Infinity;
  const [c0, c1] = bp.circles;
  const mx = (c0.x + c1.x) / 2, mz = (c0.z + c1.z) / 2, ax = c1.x - c0.x, az = c1.z - c0.z, half = Math.hypot(ax, az) / 2;
  /* 浜に引き揚げた姿勢（pitch・roll。YXZ：R = Ry · Rx · Rz）。浮いている時は 0 */
  const cp = Math.cos(bp.pitch || 0), sp = Math.sin(bp.pitch || 0), cr = Math.cos(bp.roll || 0), sr = Math.sin(bp.roll || 0);
  for (let i = 0; i < pos.length; i += 3) {
    const lx = pos[i] * cr - pos[i + 1] * sr, ly0 = pos[i] * sr + pos[i + 1] * cr;
    const ly = ly0 * cp - pos[i + 2] * sp, lz = ly0 * sp + pos[i + 2] * cp;
    const x = bp.x + lx * c + lz * s, y = bp.y + ly, z = bp.z - lx * s + lz * c;
    top = Math.max(top, y);
    let d = Infinity;
    for (const k of bp.circles) d = Math.min(d, Math.hypot(x - k.x, z - k.z) - k.r);
    out = Math.max(out, d);
    /* 円の中心より外側（舳先・艫の側）。中ほどは 2 つの円の間の隙間（当たりの近似そのものの欠け）なので別に数える */
    const along = Math.abs(((x - mx) * ax + (z - mz) * az) / (2 * half));
    if (along >= half) outEnds = Math.max(outEnds, d);
  }
  const cm = (v) => Math.round(v * 1000) / 10;
  return { outside: cm(out), outsideEnds: cm(outEnds), waistGap: cm(half - c0.r), topOver: cm(top - (c0?.top ?? 1)) };
}
