/* ===========================================================
   桟橋の座標系（three・DOM 無し）
   -----------------------------------------------------------
   旧 terrain.js の _findDock / _dockLocal / onDock / distToDock /
   dockBlocksSegment を «式の順番まで» そのまま移した。ウキの着水・歩行・
   糸の判定がこの値に乗っているので、浮動小数の丸めの順番が変わるだけで
   fixture（scripts/fixtures/terrain-*.json）と 1e−9 で合わなくなる。

   寸法（床幅 3.4m・歩ける半幅 1.62・先端 2.3m の手すり）は debug.js の
   箱（110 / 144-145 行）と組なので、変えるなら両方を直すこと。
   =========================================================== */
import { clamp } from '../util.js?v=20260830-zone5';

/** 床の半幅（見た目 3.4m のうち内側） */
export const DOCK_HALF_W = 1.62;
/** 床の見た目の幅 */
export const DOCK_W = 3.4;

/** 線分 vs AABB（スラブ法）。旧 terrain.js の segBoxHit と同じ */
export function segBoxHit(p0, p1, min, max) {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = p1[i] - p0[i];
    if (Math.abs(d) < 1e-9) {
      if (p0[i] < min[i] || p0[i] > max[i]) return false;
      continue;
    }
    let ta = (min[i] - p0[i]) / d, tb = (max[i] - p0[i]) / d;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * 湖の桟橋の値（旧 _findDock）。ベクトルは {x,y,z} のただのオブジェクト
 * （ファサードが THREE.Vector3 に写す）。
 */
export function makeDock(lake) {
  const d = lake.dock;
  const len = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z);
  const dockY = d.y;
  const dockDir = { x: d.dir.x, y: 0, z: d.dir.z };   // 岸→湖心
  const dockStart = { x: d.start.x, y: 0, z: d.start.z };
  const dockEnd = { x: d.end.x, y: 0, z: d.end.z };
  /* spawnPos = dockEnd.clone().addScaledVector(dockDir, -3).setY(dockY) と同じ丸め */
  const spawnPos = { x: dockEnd.x + dockDir.x * -3, y: dockY, z: dockEnd.z + dockDir.z * -3 };
  return {
    _dockU: { x: (d.end.x - d.start.x) / len, z: (d.end.z - d.start.z) / len },
    _dockLen: len,
    shoreR0: d.r0,
    dockDir, dockStart, dockEnd, dockY, spawnPos,
    dockAngle: d.angle,
  };
}

/**
 * 灯籠と小舟の位置（旧 _buildDock の Vector3 の計算を同じ順で）。
 * 当たり：灯籠 r0.26・上端 dockY+2.3、小舟 r0.85 の円 2 つ・上端 1.0。
 */
export function dockFixtures(dock) {
  const a = dock.dockStart, b = dock.dockEnd;
  /* new Vector3().subVectors(b, a).normalize()：length は x²+y²+z² の順、
     normalize は 1/len を掛ける（divideScalar → multiplyScalar(1/s)） */
  const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
  const inv = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1);
  const dir = { x: vx * inv, y: vy * inv, z: vz * inv };
  const yaw = Math.atan2(dir.x, dir.z);
  const W = DOCK_W;
  const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const lampOff = W / 2 - 0.15;
  const lamp = {
    x: a.x + dir.x * 1.2 + right.x * lampOff,
    z: a.z + dir.z * 1.2 + right.z * lampOff,
    r: 0.26,
    top: dock.dockY + 2.3,
    baseY: dock.dockY,
  };
  const boatOff = -(W / 2 + 1.7);
  const bx = a.x + dir.x * 4 + right.x * boatOff;
  const bz = a.z + dir.z * 4 + right.z * boatOff;
  const by = 0.05;
  const boat = {
    x: bx, y: by, z: bz, yaw: yaw + 0.25,
    circles: [-0.9, 0.9].map((t) => ({ x: bx + dir.x * t, z: bz + dir.z * t, r: 0.85, top: by + 0.95 })),
  };
  return { dir, yaw, right, lamp, boat };
}

/** 桟橋ローカル座標（al: 岸→沖 / si: 右）。out に書いて返す */
export function dockLocal(dock, x, z, out = { al: 0, si: 0 }) {
  const a = dock.dockStart;
  const u = dock._dockU;
  out.al = (x - a.x) * u.x + (z - a.z) * u.z;
  out.si = -(x - a.x) * u.z + (z - a.z) * u.x;
  return out;
}

const _dl = { al: 0, si: 0 };
const _dl2 = { al: 0, si: 0 };

/** 桟橋の床の上なら dockY、外なら null（矩形判定） */
export function onDock(dock, x, z) {
  const p = dockLocal(dock, x, z, _dl);
  if (p.al < 0 || p.al > dock._dockLen) return null;
  if (Math.abs(p.si) > DOCK_HALF_W) return null;
  return dock.dockY;
}

/** 桟橋の中心線までの距離（配置の除外用） */
export function distToDock(dock, x, z) {
  const p = dockLocal(dock, x, z, _dl);
  const al = clamp(p.al, 0, dock._dockLen);
  const dAl = p.al - al;
  return Math.hypot(dAl, p.si);
}

/** 線分が桟橋（床＋先端の手すり）を貫通するか */
export function dockBlocksSegment(dock, x0, y0, z0, x1, y1, z1) {
  const a = dockLocal(dock, x0, z0, _dl);
  const p0 = [a.al, y0, a.si];
  const b = dockLocal(dock, x1, z1, _dl2);
  const p1 = [b.al, y1, b.si];
  const L = dock._dockLen, W = DOCK_HALF_W, Y = dock.dockY;
  // 床（桁も含む厚み）
  if (segBoxHit(p0, p1, [0, Y - 0.42, -W], [L, Y + 0.18, W])) return true;
  // 先端の手すり
  if (segBoxHit(p0, p1, [L - 2.3, Y - 0.42, -W], [L, Y + 1.05, W])) return true;
  return false;
}
