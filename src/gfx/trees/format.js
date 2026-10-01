/* ===========================================================
   trees.bin の形式（焼き込み scripts/bake/trees と実行時の展開が共有する。three・DOM 無し）
   -----------------------------------------------------------
   幾何は «樹高 = 1» に正規化して焼く（インスタンスの拡大 = 実際の樹高 h）。
   幹の太さは r/h が species.js の trunkR と一致するので、拡大しても当たりの円（×1.15）と合う。

   3MB に 32 種類（8 樹種 × 4 variant）× 2 LOD を収めるため、頂点そのものではなく
   «管（幹・枝）の節» と «葉のカード» の記録で持ち、読み込み時に 20B の量子化頂点へ展開する：
     管の頭  8B : u16 節の数, u8 周の分割, u8 樹皮の層, u8 位相, u8 階層, u8 旗, u8 周の繰り返し
     管の節 12B : i16×3 位置, u16 半径（r/H, 0..R_MAX）, u16 v（樹皮の長さ m × V_SCALE）, u8 AO, u8 しなり
     カード 18B : i16×3 付け根, i8×2 長軸（oct）, i8×2 面の法線（oct）, u8 長さ, u8 幅, u8 葉の層, u8 垂れ,
                  u8 AO, u8 しなり, u8 枝の位相, u8 乱数
   GPU の頂点（20B、属性ごとの配列）：
     position Int16×3（正規化、× POS_RANGE）、normal Int8×2（oct、正規化）、uv Uint16×2（正規化）、
     ngWind Uint8×4（しなり, 枝の位相, 葉の震えの重み, 乱数）、ngExtra Uint8×4（AO, 旗, 樹冠の深さ, 厚み）
   旗（ngExtra.y × 255）：bit7 = 葉、下位 7bit = 樹皮 / 葉の配列の層
   =========================================================== */

export const TREES_FORMAT_VERSION = 1;
export const POS_RANGE = 1.25;          // 正規化した位置の範囲（±1.25 樹高）
export const R_MAX = 0.08;              // 管の半径の上限（r/H）
export const CARD_MAX = 0.16;           // カードの長さ・幅の上限（/H）
export const V_SCALE = 256;             // 樹皮の v（m）の量子化（1/256 m）
export const UV_V_RANGE = 64;           // GPU の uv.y（樹皮）の範囲（0..64 m）→ unorm16
export const UV_U_RANGE = 8;            // GPU の uv.x（樹皮の周の繰り返し）の範囲
export const TUBE_HEAD = 8, TUBE_NODE = 12, CARD_SIZE = 18;
export const FLAG_LEAF = 128;

/** 葉の配列の層（forge が焼く順） */
export const LEAF_LAYERS = ['sugi', 'hinoki', 'buna', 'mizunara', 'momiji', 'akamatsu', 'yanagi', 'hannoki'];
/** 樹皮の配列の層（アカマツは下の灰黒と上の赤の 2 層。幹の高さで混ぜる） */
export const BARK_LAYERS = ['sugi', 'hinoki', 'buna', 'mizunara', 'momiji', 'akamatsu', 'akamatsuUpper', 'yanagi', 'hannoki'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const q16 = (v) => clamp(Math.round((v / POS_RANGE) * 32767), -32767, 32767);
const u8 = (v) => clamp(Math.round(v * 255), 0, 255);

/** 単位ベクトル → oct の [-1,1]² */
export function octEncode(x, y, z) {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let a = x / s, b = y / s;
  if (z < 0) {
    const na = (1 - Math.abs(b)) * (a >= 0 ? 1 : -1), nb = (1 - Math.abs(a)) * (b >= 0 ? 1 : -1);
    a = na; b = nb;
  }
  return [a, b];
}
/** oct の [-1,1]² → 単位ベクトル */
export function octDecode(a, b, out = [0, 0, 0]) {
  let x = a, y = b, z = 1 - Math.abs(a) - Math.abs(b);
  const t = clamp(-z, 0, 1);
  x += x >= 0 ? -t : t;
  y += y >= 0 ? -t : t;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}
const i8 = (v) => clamp(Math.round(v * 127), -127, 127);

/* ---------------------------------------------------------------- 書き手（焼き込み） */

/** 可変長のバイト列（決定的に書く） */
export class ByteWriter {
  constructor(cap = 1 << 20) { this.buf = new Uint8Array(cap); this.dv = new DataView(this.buf.buffer); this.n = 0; }
  _grow(k) {
    if (this.n + k <= this.buf.length) return;
    let c = this.buf.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Uint8Array(c);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b; this.dv = new DataView(b.buffer);
  }
  u8(v) { this._grow(1); this.dv.setUint8(this.n, v); this.n += 1; }
  i8(v) { this._grow(1); this.dv.setInt8(this.n, v); this.n += 1; }
  u16(v) { this._grow(2); this.dv.setUint16(this.n, v, true); this.n += 2; }
  i16(v) { this._grow(2); this.dv.setInt16(this.n, v, true); this.n += 2; }
  u32(v) { this._grow(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; }
  align(k) { while (this.n % k) this.u8(0); }
  bytes() { return this.buf.slice(0, this.n); }
}

/**
 * 管を書く。nodes = [{ p:[x,y,z], r, v, ao, flex }]（正規化単位、v は m）
 */
export function writeTube(w, t) {
  w.u16(t.nodes.length); w.u8(t.radial); w.u8(t.bark); w.u8(u8(t.phase)); w.u8(t.level); w.u8(t.flags | 0); w.u8(t.uRepeat | 0);
  for (const n of t.nodes) {
    w.i16(q16(n.p[0])); w.i16(q16(n.p[1])); w.i16(q16(n.p[2]));
    w.u16(clamp(Math.round((n.r / R_MAX) * 65535), 0, 65535));
    w.u16(clamp(Math.round(n.v * V_SCALE), 0, 65535));
    w.u8(u8(n.ao)); w.u8(u8(n.flex));
  }
}

/** カードを書く。c = { p, dir, nrm, len, wid, layer, droop, ao, flex, phase, rand } */
export function writeCard(w, c) {
  w.i16(q16(c.p[0])); w.i16(q16(c.p[1])); w.i16(q16(c.p[2]));
  const d = octEncode(c.dir[0], c.dir[1], c.dir[2]), n = octEncode(c.nrm[0], c.nrm[1], c.nrm[2]);
  w.i8(i8(d[0])); w.i8(i8(d[1])); w.i8(i8(n[0])); w.i8(i8(n[1]));
  w.u8(u8(c.len / CARD_MAX)); w.u8(u8(c.wid / CARD_MAX)); w.u8(c.layer); w.u8(u8(c.droop));
  w.u8(u8(c.ao)); w.u8(u8(c.flex)); w.u8(u8(c.phase)); w.u8(u8(c.rand));
}

/* ---------------------------------------------------------------- 読み手（実行時・テスト） */

/** 管とカードの記録を読む（正規化単位へ戻す） */
export function readLod(bytes, lod) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tubes = [], cards = [];
  let o = lod.tubeOffset;
  for (let t = 0; t < lod.tubes; t++) {
    const count = dv.getUint16(o, true), radial = dv.getUint8(o + 2), bark = dv.getUint8(o + 3), phase = dv.getUint8(o + 4) / 255;
    const level = dv.getUint8(o + 5), flags = dv.getUint8(o + 6), uRepeat = dv.getUint8(o + 7);
    o += TUBE_HEAD;
    const nodes = [];
    for (let k = 0; k < count; k++) {
      nodes.push({
        p: [dv.getInt16(o, true) / 32767 * POS_RANGE, dv.getInt16(o + 2, true) / 32767 * POS_RANGE, dv.getInt16(o + 4, true) / 32767 * POS_RANGE],
        r: dv.getUint16(o + 6, true) / 65535 * R_MAX, v: dv.getUint16(o + 8, true) / V_SCALE,
        ao: dv.getUint8(o + 10) / 255, flex: dv.getUint8(o + 11) / 255,
      });
      o += TUBE_NODE;
    }
    tubes.push({ nodes, radial, bark, phase, level, flags, uRepeat });
  }
  o = lod.cardOffset;
  const tmp = [0, 0, 0];
  for (let c = 0; c < lod.cards; c++) {
    const p = [dv.getInt16(o, true) / 32767 * POS_RANGE, dv.getInt16(o + 2, true) / 32767 * POS_RANGE, dv.getInt16(o + 4, true) / 32767 * POS_RANGE];
    const dir = octDecode(dv.getInt8(o + 6) / 127, dv.getInt8(o + 7) / 127, [0, 0, 0]);
    const nrm = octDecode(dv.getInt8(o + 8) / 127, dv.getInt8(o + 9) / 127, tmp.slice());
    cards.push({
      p, dir, nrm, len: dv.getUint8(o + 10) / 255 * CARD_MAX, wid: dv.getUint8(o + 11) / 255 * CARD_MAX,
      layer: dv.getUint8(o + 12), droop: dv.getUint8(o + 13) / 255, ao: dv.getUint8(o + 14) / 255,
      flex: dv.getUint8(o + 15) / 255, phase: dv.getUint8(o + 16) / 255, rand: dv.getUint8(o + 17) / 255,
    });
    o += CARD_SIZE;
  }
  return { tubes, cards };
}

/** 展開した後の頂点数・三角形数（GPU の配列を確保する前に数える） */
export function countLod(rec, cardSegs) {
  let verts = 0, tris = 0;
  for (const t of rec.tubes) {
    const ring = t.radial + 1;
    verts += ring * t.nodes.length;
    tris += t.radial * 2 * (t.nodes.length - 1);
  }
  verts += rec.cards.length * 2 * (cardSegs + 1);
  tris += rec.cards.length * 2 * cardSegs;
  return { verts, tris };
}

/**
 * 管とカードを GPU の 20B 頂点へ展開する。
 * @param {{tubes, cards}} rec readLod の戻り値
 * @param {{cardSegs:number, crown:number[], bend:number}} o crown = 樹冠の中心（正規化）、bend = 法線を樹冠へ曲げる割合
 * @returns {{position:Int16Array, normal:Int8Array, uv:Uint16Array, wind:Uint8Array, extra:Uint8Array, index:Uint16Array|Uint32Array, verts:number, tris:number}}
 */
export function expandLod(rec, o) {
  const { verts, tris } = countLod(rec, o.cardSegs);
  const position = new Int16Array(verts * 3), normal = new Int8Array(verts * 2), uv = new Uint16Array(verts * 2);
  const wind = new Uint8Array(verts * 4), extra = new Uint8Array(verts * 4);
  const index = verts > 65535 ? new Uint32Array(tris * 3) : new Uint16Array(tris * 3);
  const crown = o.crown, bend = o.bend ?? 0.6, crownR = o.crownR || 0.3;
  let vi = 0, ii = 0;
  const put = (x, y, z, nx, ny, nz, u, v, w0, w1, w2, w3, e0, e1, e2, e3) => {
    position[vi * 3] = q16(x); position[vi * 3 + 1] = q16(y); position[vi * 3 + 2] = q16(z);
    const e = octEncode(nx, ny, nz);
    normal[vi * 2] = i8(e[0]); normal[vi * 2 + 1] = i8(e[1]);
    uv[vi * 2] = clamp(Math.round(u * 65535), 0, 65535); uv[vi * 2 + 1] = clamp(Math.round(v * 65535), 0, 65535);
    wind[vi * 4] = u8(w0); wind[vi * 4 + 1] = u8(w1); wind[vi * 4 + 2] = u8(w2); wind[vi * 4 + 3] = u8(w3);
    extra[vi * 4] = u8(e0); extra[vi * 4 + 1] = e1; extra[vi * 4 + 2] = u8(e2); extra[vi * 4 + 3] = u8(e3);
    return vi++;
  };
  const depthAt = (x, y, z) => {
    const d = Math.hypot(x - crown[0], (y - crown[1]) * 1.4, z - crown[2]);
    return clamp(1 - d / crownR, 0, 1);
  };
  /* 管：節ごとに輪。平行移動フレームで捩れを出さない */
  for (const t of rec.tubes) {
    const N = t.nodes, ring = t.radial + 1;
    const base = vi;
    let nx = 0, ny = 0, nz = 0;   // フレームの基準ベクトル
    for (let k = 0; k < N.length; k++) {
      const a = N[k], b = N[Math.min(k + 1, N.length - 1)], c = N[Math.max(k - 1, 0)];
      let tx = b.p[0] - c.p[0], ty = b.p[1] - c.p[1], tz = b.p[2] - c.p[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      if (k === 0) {
        /* 最初の基準：接線に垂直で、なるべく世界の x */
        let rx = 1, ry = 0, rz = 0;
        if (Math.abs(tx) > 0.9) { rx = 0; rz = 1; }
        const dd = rx * tx + ry * ty + rz * tz;
        nx = rx - tx * dd; ny = ry - ty * dd; nz = rz - tz * dd;
      } else {
        const dd = nx * tx + ny * ty + nz * tz;
        nx -= tx * dd; ny -= ty * dd; nz -= tz * dd;
      }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      const dep = depthAt(a.p[0], a.p[1], a.p[2]);
      for (let j = 0; j < ring; j++) {
        const ang = (j / t.radial) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const rx = nx * ca + bx * sa, ry = ny * ca + by * sa, rz = nz * ca + bz * sa;
        put(a.p[0] + rx * a.r, a.p[1] + ry * a.r, a.p[2] + rz * a.r, rx, ry, rz,
          (j / t.radial) * t.uRepeat / UV_U_RANGE, a.v / UV_V_RANGE,
          a.flex, t.phase, 0, 0, a.ao, t.bark & 127, dep, 0);
      }
    }
    for (let k = 0; k < N.length - 1; k++) {
      for (let j = 0; j < t.radial; j++) {
        const i0 = base + k * ring + j, i1 = i0 + 1, i2 = i0 + ring, i3 = i2 + 1;
        index[ii++] = i0; index[ii++] = i2; index[ii++] = i1;
        index[ii++] = i1; index[ii++] = i2; index[ii++] = i3;
      }
    }
  }
  /* カード：付け根から長軸へ。垂れ（droop）は先ほど下へ曲げる。法線は樹冠の中心から外へ bend だけ曲げる */
  const S = o.cardSegs;
  for (const c of rec.cards) {
    const base = vi;
    let dx = c.dir[0], dy = c.dir[1], dz = c.dir[2];
    let fx = c.nrm[0], fy = c.nrm[1], fz = c.nrm[2];
    let dd = fx * dx + fy * dy + fz * dz;
    fx -= dx * dd; fy -= dy * dd; fz -= dz * dd;
    let fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-4) { fx = 0; fy = 1; fz = 0; dd = dy; fx -= dx * dd; fy -= dy * dd; fz -= dz * dd; fl = Math.hypot(fx, fy, fz) || 1; }
    fx /= fl; fy /= fl; fz /= fl;
    /* 横の軸 = 長軸 × 法線 */
    const sx = dy * fz - dz * fy, sy = dz * fx - dx * fz, sz = dx * fy - dy * fx;
    let px = c.p[0], py = c.p[1], pz = c.p[2];
    const segL = c.len / S;
    let cdx = dx, cdy = dy, cdz = dz;
    for (let k = 0; k <= S; k++) {
      const t = k / S;
      for (let j = 0; j < 2; j++) {
        const s = j - 0.5;
        const x = px + sx * c.wid * s, y = py + sy * c.wid * s, z = pz + sz * c.wid * s;
        /* 法線：カードの面（上向きに揃える）と樹冠の外向きを混ぜる */
        let ox = x - crown[0], oy = (y - crown[1]) * 0.8 + 0.15 * crownR, oz = z - crown[2];
        const ol = Math.hypot(ox, oy, oz) || 1;
        ox /= ol; oy /= ol; oz /= ol;
        const flip = fx * ox + fy * oy + fz * oz < 0 ? -1 : 1;
        let mx = fx * flip * (1 - bend) + ox * bend, my = fy * flip * (1 - bend) + oy * bend, mz = fz * flip * (1 - bend) + oz * bend;
        const ml = Math.hypot(mx, my, mz) || 1;
        mx /= ml; my /= ml; mz /= ml;
        put(x, y, z, mx, my, mz, j, t, c.flex, c.phase, t, c.rand, c.ao, FLAG_LEAF | (c.layer & 127), depthAt(x, y, z), 0.5);
      }
      if (k < S) {
        /* 次の節：垂れの分だけ下へ回す */
        px += cdx * segL; py += cdy * segL; pz += cdz * segL;
        const drop = c.droop * 0.9 / S;
        cdy -= drop;
        const l = Math.hypot(cdx, cdy, cdz) || 1;
        cdx /= l; cdy /= l; cdz /= l;
      }
    }
    for (let k = 0; k < S; k++) {
      const i0 = base + k * 2, i1 = i0 + 1, i2 = i0 + 2, i3 = i0 + 3;
      index[ii++] = i0; index[ii++] = i1; index[ii++] = i2;
      index[ii++] = i1; index[ii++] = i3; index[ii++] = i2;
    }
  }
  return { position, normal, uv, wind, extra, index, verts, tris };
}
