/* ===========================================================
   hardscape の幾何の組み立て（three を import しない。Node のテストからも読む）
   -----------------------------------------------------------
   GeoBuilder：位置・法線（後で計算）・uv・ngWood（vec4：素材の種類と補助値）を貯めて、
   1 本の BufferGeometry にまとめる（桟橋の全部の木部 = 1 ドロー）。
   部品どうしは頂点を共有しないので、法線の平滑化は部品の中だけで効く
   =========================================================== */

/** 木部の素材の種類（ngWood.x）。シェーダの NG_HS_* と同じ番号 */
export const WOOD_KIND = Object.freeze({ DECK: 0, TIMBER: 1, PILE: 2, BOAT: 3, BLEACHED: 4, ROPE: 5, PAPER: 6, IRON: 7 });

export class GeoBuilder {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.w = [];
    this.idx = [];
  }

  get count() { return this.pos.length / 3; }

  /** 頂点を 1 つ足して番号を返す */
  v(x, y, z, u, vv, w) {
    this.pos.push(x, y, z);
    this.uv.push(u, vv);
    this.w.push(w[0], w[1], w[2], w[3]);
    return this.pos.length / 3 - 1;
  }

  /** 三角形（反時計回りが表） */
  tri(a, b, c) { this.idx.push(a, b, c); }

  /** 四角形 a-b-c-d（反時計回り） */
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /**
   * 格子（rows × cols の頂点。fn(i, j) → [x, y, z, u, v]）を面にする。flip で裏返す
   */
  grid(rows, cols, fn, w, flip = false) {
    const base = this.count;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const p = fn(i, j);
        this.v(p[0], p[1], p[2], p[3], p[4], w);
      }
    }
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = base + i * cols + j, b = a + 1, c = a + cols + 1, d = a + cols;
        if (flip) this.quad(a, d, c, b); else this.quad(a, b, c, d);
      }
    }
    return base;
  }

  /**
   * 向きのある箱（中心 c、軸 ax/ay/az の単位ベクトル、半寸 hx/hy/hz）。面ごとに頂点を分ける（角は立てる）。
   * uv：長手（az）方向を v（m / 4）、幅を u（列の中）
   */
  box(c, ax, ay, az, hx, hy, hz, w, uv0 = [0, 0]) {
    const P = (sx, sy, sz) => [
      c[0] + ax[0] * hx * sx + ay[0] * hy * sy + az[0] * hz * sz,
      c[1] + ax[1] * hx * sx + ay[1] * hy * sy + az[1] * hz * sz,
      c[2] + ax[2] * hx * sx + ay[2] * hy * sy + az[2] * hz * sz,
    ];
    const faces = [
      [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1], 'y'],    // +x
      [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1], 'y'], // −x
      [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1], 'x'],    // +y
      [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1], 'x'], // −y
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], 'e'],    // +z
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], 'e'], // −z
    ];
    const L = hz * 2, Wd = hx * 2, H = hy * 2;
    const cz = cross(ax, ay), rh = cz[0] * az[0] + cz[1] * az[1] + cz[2] * az[2] > 0;
    for (const f of faces) {
      const ids = f.slice(0, 4).map((s) => {
        const p = P(s[0], s[1], s[2]);
        let u, vv;
        if (f[4] === 'x') { u = (s[0] * 0.5 + 0.5) * Math.min(1, Wd / 0.2); vv = (s[2] * 0.5 + 0.5) * L / 4; }
        else if (f[4] === 'y') { u = (s[1] * 0.5 + 0.5) * Math.min(1, H / 0.2); vv = (s[2] * 0.5 + 0.5) * L / 4; }
        else { u = (s[0] * 0.5 + 0.5) * Math.min(1, Wd / 0.2); vv = (s[1] * 0.5 + 0.5) * H / 4; }
        return this.v(p[0], p[1], p[2], uv0[0] + u * 0.24, uv0[1] + vv, w);
      });
      // 右手系の軸（ax × ay = az）で外から見て反時計回り。左手系なら裏返す
      if (rh) this.quad(ids[0], ids[1], ids[2], ids[3]); else this.quad(ids[0], ids[3], ids[2], ids[1]);
    }
  }

  /**
   * 丸太・杭（下端 p0 → 上端 p1、半径 r(t, θ)。segs 周 × rows 段）。uv：u = 周（列の中）、v = 高さ m / 4
   * cap0 / cap1 で端を塞ぐ
   */
  log(p0, p1, rFn, segs, rows, w, uv0 = [0, 0], cap0 = true, cap1 = true, rowsAt = null) {
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    const a = [d[0] / L, d[1] / L, d[2] / L];
    const ref = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const b = norm(cross(a, ref)), c = cross(a, b);
    const ts = rowsAt || Array.from({ length: rows }, (_, i) => i / (rows - 1));
    const R = ts.length;
    const base = this.count;
    for (let i = 0; i < R; i++) {
      const t = ts[i];
      for (let j = 0; j <= segs; j++) {
        const th = (j / segs) * Math.PI * 2;
        const r = rFn(t, th);
        const cx = Math.cos(th) * r, cy = Math.sin(th) * r;
        this.v(
          p0[0] + d[0] * t + b[0] * cx + c[0] * cy,
          p0[1] + d[1] * t + b[1] * cx + c[1] * cy,
          p0[2] + d[2] * t + b[2] * cx + c[2] * cy,
          uv0[0] + (j / segs) * 0.24, uv0[1] + (t * L) / 4, w,
        );
      }
    }
    const cols = segs + 1;
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const p = base + i * cols + j;
        this.quad(p, p + 1, p + cols + 1, p + cols);
      }
    }
    const cap = (t, sgn) => {
      const cc = this.v(p0[0] + d[0] * t, p0[1] + d[1] * t, p0[2] + d[2] * t, uv0[0] + 0.12, uv0[1], w);
      const ring = [];
      for (let j = 0; j < segs; j++) {
        const th = (j / segs) * Math.PI * 2;
        const r = rFn(t, th) * 0.999;
        ring.push(this.v(
          p0[0] + d[0] * t + (b[0] * Math.cos(th) + c[0] * Math.sin(th)) * r,
          p0[1] + d[1] * t + (b[1] * Math.cos(th) + c[1] * Math.sin(th)) * r,
          p0[2] + d[2] * t + (b[2] * Math.cos(th) + c[2] * Math.sin(th)) * r,
          uv0[0] + 0.12 + Math.cos(th) * 0.1, uv0[1] + Math.sin(th) * 0.1 * 0.05, w,
        ));
      }
      for (let j = 0; j < segs; j++) {
        if (sgn > 0) this.tri(cc, ring[j], ring[(j + 1) % segs]);
        else this.tri(cc, ring[(j + 1) % segs], ring[j]);
      }
    };
    if (cap0) cap(ts[0], -1);
    if (cap1) cap(ts[R - 1], 1);
  }

  /** 他のビルダーを座標変換（3×4 の行優先 m）して足す */
  append(g, m = null) {
    const base = this.count;
    for (let i = 0; i < g.pos.length; i += 3) {
      const x = g.pos[i], y = g.pos[i + 1], z = g.pos[i + 2];
      if (m) this.pos.push(m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]);
      else this.pos.push(x, y, z);
    }
    for (const u of g.uv) this.uv.push(u);
    for (const w of g.w) this.w.push(w);
    for (const k of g.idx) this.idx.push(k + base);
  }

  /**
   * 折れ線に沿う管（縄）。頂点の並びは tubePositions と同じ（点 i ごとに segs + 1 個）
   * @returns {number} 先頭の頂点番号
   */
  tube(pts, r, segs, w, closed = false) {
    const base = this.count;
    const P = new Float32Array(pts.length * (segs + 1) * 3);
    tubePositions(P, pts, r, segs, closed);
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j <= segs; j++) {
        const k = (i * (segs + 1) + j) * 3;
        this.v(P[k], P[k + 1], P[k + 2], (j / segs) * 0.24, i * 0.01, w);
      }
    }
    const cols = segs + 1;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const p = base + i * cols + j;
        this.quad(p, p + 1, p + cols + 1, p + cols);
      }
    }
    return base;
  }

  /** 平滑化した法線（部品の中の共有頂点だけ） */
  normals() {
    const n = new Float32Array(this.pos.length), p = this.pos, I = this.idx;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const q of [a, b, c]) { n[q] += nx; n[q + 1] += ny; n[q + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
  }

  /** three の BufferGeometry へ */
  toGeometry(T) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(this.normals(), 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('ngWood', new T.Float32BufferAttribute(this.w, 4));
    const n = this.count;
    g.setIndex(n > 65535 ? new T.Uint32BufferAttribute(this.idx, 1) : new T.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * 管の頂点の位置を out に書く（毎フレームの縄の更新でも同じ式）。法線は (位置 − 中心) / r
 * @param {Float32Array} out
 * @param {number[][]} pts
 */
export function tubePositions(out, pts, r, segs, closed = false, nrm = null) {
  const n = pts.length;
  let prevB = null;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let t = closed ? sub(pts[(i + 1) % n], pts[(i - 1 + n) % n]) : sub(b, a);
    t = norm(t);
    const up = prevB || (Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    const nx = norm(cross(up, t));
    const ny = cross(t, nx);
    prevB = ny;
    for (let j = 0; j <= segs; j++) {
      const th = (j / segs) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const dx = nx[0] * c + ny[0] * s, dy = nx[1] * c + ny[1] * s, dz = nx[2] * c + ny[2] * s;
      const k = (i * (segs + 1) + j) * 3;
      out[k] = pts[i][0] + dx * r; out[k + 1] = pts[i][1] + dy * r; out[k + 2] = pts[i][2] + dz * r;
      if (nrm) { nrm[k] = dx; nrm[k + 1] = dy; nrm[k + 2] = dz; }
    }
  }
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
