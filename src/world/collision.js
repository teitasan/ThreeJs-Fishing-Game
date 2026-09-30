/* ===========================================================
   障害物の 8m ハッシュ（three・DOM 無し）
   -----------------------------------------------------------
   旧 terrain.js の addObstacle / blockedAt / obstacleTopAt / lineBlocked を
   そのまま移した。obstacles は [x, z, r, top, ...] の平らな配列、_obsGrid は
   セル番号 → obstacles の添字の Map。debug.js がどちらも直接読む。

   3×3 セルしか見ないので、半径（+ 問い合わせ半径）は 8m 未満でなければ
   ならない。置く側（placement）は 7.6m 未満に収めること。
   =========================================================== */
import { lineSagProfile } from '../util.js?v=20260830-zone5';

export const OBS_CELL = 8;
/** 3×3 セルで拾える障害物の半径の上限 */
export const OBS_R_MAX = 7.6;

const cellKey = (cx, cz) => ((cx & 1023) << 10) | (cz & 1023);

export class ObstacleGrid {
  constructor() {
    this.obstacles = [];        // [x, z, r, top, x, z, r, top, ...]
    this._obsGrid = new Map();
  }

  add(x, z, r, top = 0) {
    this.obstacles.push(x, z, r, top);
    const key = ((Math.floor(x / OBS_CELL) & 1023) << 10) | (Math.floor(z / OBS_CELL) & 1023);
    let arr = this._obsGrid.get(key);
    if (!arr) { arr = []; this._obsGrid.set(key, arr); }
    arr.push(this.obstacles.length - 4);
  }

  /** (x,z) が半径 rad の円として障害物にぶつかるか。y を渡すと «その高さより上まである» ものだけ */
  blockedAt(x, z, rad = 0.32, y) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    const o = this.obstacles;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._obsGrid.get(cellKey(cx + dx, cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          if (y !== undefined && o[i + 3] < y) continue;
          const ddx = x - o[i], ddz = z - o[i + 1], rr = o[i + 2] + rad;
          if (ddx * ddx + ddz * ddz < rr * rr) return true;
        }
      }
    }
    return false;
  }

  /** (x,z) を覆っている障害物の上端の最大値（無ければ -Infinity） */
  obstacleTopAt(x, z) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    const o = this.obstacles;
    let top = -Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._obsGrid.get(cellKey(cx + dx, cz + dz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - o[i], ddz = z - o[i + 1], rr = o[i + 2];
          if (ddx * ddx + ddz * ddz < rr * rr && o[i + 3] > top) top = o[i + 3];
        }
      }
    }
    return top;
  }
}

/**
 * 糸（竿先 → 到達点）が地形や障害物を貫通するか。たるみも描画と同じ形で見る。
 * q は heightAt(x,z) と obstacleTopAt(x,z) を持つもの（Terrain ファサード）。
 * @returns {null|{x:number,y:number,z:number,ground:number,kind:'terrain'|'rock'}}
 */
export function lineBlocked(q, x0, y0, z0, x1, y1, z1, opts = {}) {
  const tol = opts.tol ?? 0.22;
  const slack = opts.slack ?? 0.5;
  const dx = x1 - x0, dz = z1 - z0;
  const dist = Math.hypot(dx, dz, y1 - y0);
  if (dist < 1) return null;
  const sag = Math.min(dist * 0.16, 1.2) * slack;
  // 地形の細部ノイズは波長 18m 程度なので 1.6m 刻みで十分
  const N = Math.min(40, Math.max(8, Math.ceil(dist / 1.6)));
  for (let i = 1; i < N; i++) {
    const t = i / N;
    const x = x0 + dx * t, z = z0 + dz * t;
    const y = y0 + (y1 - y0) * t - lineSagProfile(t) * sag;   // 描画と同じたるみの形
    const g = q.heightAt(x, z);
    if (y + tol < g) return { x, y, z, ground: g, kind: 'terrain' };
    const ot = q.obstacleTopAt(x, z);
    if (ot > -Infinity && y + tol < ot) return { x, y, z, ground: ot, kind: 'rock' };
  }
  return null;
}
