/* ===========================================================
   CDLOD の四分木（Strugar 2009）— 純粋な JS（three・DOM 無し。Node でテストできる）
   -----------------------------------------------------------
   - 根 1024m（±512m、heightfield の far と同じ範囲）、葉 16m、7 段（段 0 = 葉）
   - 1 枚のパッチ（段 0 の格子 0.5m = near の格子と同じ点）をインスタンスで並べる。
     インスタンス = (x0, z0, 格子の間隔 cR, 表す段 L)。親の «子の 1/4 だけ» を親の細かさで描く区画は
     cR = 子の段の間隔・L = 親の段（VS が 2 格子ごとに丸める）。こうすると 1 枚のパッチで済む
   - 距離は xz の 2 次元（カメラの地面からの高さ dy は各段の範囲を √(r² − dy²) に縮めて効かせる）。
     2 次元なので «段 l の区画の縁はかならず [ρ_l, ρ_l + √2·s_l] の距離にある» が厳密に言え、
     段 l + 1 のジオモーフを ρ_l + √2·s_l より外から始めれば、隣り合う段の頂点が必ず一致する（T 字の隙間なし）
   - ジオモーフの区間 [a_l, b_l]：b_l = ρ_l、a_l = max(ρ_{l−1} + √2·s_{l−1} + ε, b_l·(1 − MORPH))
   出力は Float32Array（4 個ずつ）。毎フレームの new をしない
   =========================================================== */

export const CDLOD_ROOT = Object.freeze({ origin: -512, size: 1024 });
export const CDLOD_LEAF = 16;
export const CDLOD_LEVELS = 7;          // 段 0（16m）… 段 6（1024m = 根）。セル 32 のとき
/** 段の数の上限（セル 16 = 葉 8m で 8 段）。ジオモーフの表（vec4 × 8）と同じ */
export const CDLOD_MAX_LEVELS = 8;
export const CDLOD_MAX_INST = 1536;
/** 段 0 の範囲の下限 m：歩ける帯（足元から 24m）は段の倍率に依らず 0.5m の格子（描画の高さ = heightAt ± 2cm） */
export const CDLOD_WALK_R = 26;

/**
 * パッチのセル数から葉の大きさと段の数。段 0 の格子は常に 0.5m（= heightfield の near の格子）
 * @param {number} cells 16 | 32
 * @returns {{leaf:number, levels:number}}
 */
export function cdlodConfig(cells = 32) {
  const leaf = Math.max(4, cells * 0.5);
  return { leaf, levels: Math.round(Math.log2(CDLOD_ROOT.size / leaf)) + 1 };
}
/** ジオモーフの区間の割合（範囲の最後の 30%。隣の段の制約で短くなることがある） */
export const CDLOD_MORPH = 0.3;
const SQRT2 = Math.SQRT2;
const EPS = 0.5;

/** 段 l の区画の一辺 m */
export const nodeSize = (l, leaf = CDLOD_LEAF) => leaf * (1 << l);

/**
 * 各段の範囲（ρ_l）とジオモーフの区間を求める
 * @param {number} r0 段 0 の範囲（m。品質・LOD 倍率込み）
 * @param {number} dy カメラの地面からの高さ（m、≥ 0）
 * @param {Float32Array} rho 長さ CDLOD_LEVELS（出力。最後は Infinity 相当）
 * @param {Float32Array} morph 長さ 4·8（出力。vec4 の配列：x = a, y = b, z = 1/(b−a)）
 */
export function cdlodRanges(r0, dy, rho, morph, cells = 32, walkR = 0) {
  const { leaf, levels } = cdlodConfig(cells);
  const d2 = Math.max(0, dy) ** 2;
  for (let l = 0; l < CDLOD_MAX_LEVELS; l++) {
    if (l >= levels - 1) { rho[l] = 1e9; continue; }
    /* 段 0 は歩ける帯の下限（ジオモーフが始まる 0.7ρ が足元から walkR より外） */
    const r = l === 0 ? Math.max(r0, walkR / (1 - CDLOD_MORPH)) : r0 * (1 << l);
    let p = Math.sqrt(Math.max(r * r - d2, 0));
    if (l > 0) p = Math.max(p, rho[l - 1] + SQRT2 * nodeSize(l - 1, leaf) + EPS + 0.18 * nodeSize(l, leaf));
    rho[l] = p;
  }
  for (let l = 0; l < 8; l++) {
    const o = l * 4;
    if (l >= levels - 1) { morph[o] = 1e9; morph[o + 1] = 1e9 + 1; morph[o + 2] = 0; morph[o + 3] = 0; continue; }
    const b = rho[l];
    let a = b * (1 - CDLOD_MORPH);
    if (l > 0) a = Math.max(a, rho[l - 1] + SQRT2 * nodeSize(l - 1, leaf) + EPS);
    if (b <= 0) { morph[o] = -2; morph[o + 1] = -1; morph[o + 2] = 1; morph[o + 3] = 0; continue; }   // 段 0 が無い（カメラが高い）
    a = Math.min(a, b - 0.05);
    morph[o] = a; morph[o + 1] = b; morph[o + 2] = 1 / Math.max(b - a, 1e-3); morph[o + 3] = 0;
  }
}

/* 区画（矩形 x0..x0+s, z0..z0+s）とカメラ（xz）の最短距離 */
function nodeDist(x0, z0, s, cx, cz) {
  const dx = Math.max(x0 - cx, 0, cx - x0 - s), dz = Math.max(z0 - cz, 0, cz - z0 - s);
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * 選択の結果を入れる箱（使い回す）
 */
export class CdlodList {
  constructor(max = CDLOD_MAX_INST) {
    this.max = max;
    this.data = new Float32Array(max * 4);    // x0, z0, cR, L
    this.dist = new Float32Array(max);        // カメラからの最短距離（並べ替え用）
    this.size = new Float32Array(max);        // 区画の一辺
    this.count = 0;
    this.overflow = 0;
    this._order = new Uint16Array(max);
    this._tmp = new Float32Array(max * 4);
  }
  clear() { this.count = 0; this.overflow = 0; }
  push(x0, z0, s, cR, L, d) {
    if (this.count >= this.max) { this.overflow++; return; }
    const i = this.count++, o = i * 4;
    this.data[o] = x0; this.data[o + 1] = z0; this.data[o + 2] = cR; this.data[o + 3] = L;
    this.dist[i] = d; this.size[i] = s;
  }
  /** 近い順に並べる（地形どうしの重ね描きを減らす）。挿入ソート（ほぼ整列済み） */
  sortByDistance() {
    const n = this.count, ord = this._order, d = this.dist;
    for (let i = 0; i < n; i++) ord[i] = i;
    for (let i = 1; i < n; i++) {
      const v = ord[i], dv = d[v];
      let j = i - 1;
      while (j >= 0 && d[ord[j]] > dv) { ord[j + 1] = ord[j]; j--; }
      ord[j + 1] = v;
    }
    const t = this._tmp, src = this.data;
    const ds = Float32Array.from(d.subarray(0, n)), ss = Float32Array.from(this.size.subarray(0, n));
    for (let k = 0; k < n; k++) {
      const i = ord[k];
      t[k * 4] = src[i * 4]; t[k * 4 + 1] = src[i * 4 + 1]; t[k * 4 + 2] = src[i * 4 + 2]; t[k * 4 + 3] = src[i * 4 + 3];
      this.dist[k] = ds[i]; this.size[k] = ss[i];
    }
    src.set(t.subarray(0, n * 4));
  }
}

/**
 * 四分木を選ぶ（視錐台では間引かない。間引きはパスごとに filterInto で）
 * @param {number} cx カメラの x
 * @param {number} cz カメラの z
 * @param {Float32Array} rho cdlodRanges の出力
 * @param {CdlodList} out
 * @param {number} [cells=32] パッチの一辺のセル数（high/mid 32、low 16）
 */
export function cdlodSelect(cx, cz, rho, out, cells = 32) {
  out.clear();
  const { leaf, levels } = cdlodConfig(cells);
  selectNode(CDLOD_ROOT.origin, CDLOD_ROOT.origin, levels - 1, cx, cz, rho, out, cells, leaf);
}

function selectNode(x0, z0, l, cx, cz, rho, out, cells, leaf) {
  const s = nodeSize(l, leaf);
  if (l === 0 || nodeDist(x0, z0, s, cx, cz) >= rho[l - 1]) {
    out.push(x0, z0, s, s / cells, l, nodeDist(x0, z0, s, cx, cz));
    return;
  }
  const h = s / 2, rc = rho[l - 1];
  for (let k = 0; k < 4; k++) {
    const qx = x0 + (k & 1) * h, qz = z0 + (k >> 1) * h;
    const d = nodeDist(qx, qz, h, cx, cz);
    if (d < rc) selectNode(qx, qz, l - 1, cx, cz, rho, out, cells, leaf);
    else out.push(qx, qz, h, h / cells, l, d);   // 子の大きさを親の細かさで（VS が 2 格子ごとに丸める）
  }
}

/**
 * 選択から «このパスで描く物» を詰め直す
 * @param {CdlodList} src
 * @param {Float32Array} dst 長さ ≥ src.count·4
 * @param {(x0:number, z0:number, s:number) => boolean} keep
 * @returns {number} 個数
 */
export function filterInto(src, dst, keep) {
  let n = 0;
  const d = src.data;
  for (let i = 0; i < src.count; i++) {
    const o = i * 4;
    if (!keep(d[o], d[o + 1], src.size[i])) continue;
    dst[n * 4] = d[o]; dst[n * 4 + 1] = d[o + 1]; dst[n * 4 + 2] = d[o + 2]; dst[n * 4 + 3] = d[o + 3];
    n++;
  }
  return n;
}

/**
 * GPU の頂点の式の CPU 双子（テスト用。terrain.glsl.js の ngTerrVertex と同じ式）：パッチの格子 (gi, gj) とインスタンスから世界の xz
 * @param {number} gi 0..cells
 * @param {number} gj
 * @param {number[]|Float32Array} inst [x0, z0, cR, L]
 * @param {number} cx
 * @param {number} cz
 * @param {Float32Array} morph cdlodRanges の出力
 * @param {number} [cells=32]
 * @returns {[number, number]}
 */
export function cdlodVertex(gi, gj, inst, cx, cz, morph, cells = 32) {
  const [x0, z0, cR, L] = inst;
  const cL = 0.5 * (1 << L);                  // 段 L の本来の格子の間隔（= nodeSize(L, leaf) / cells。段 0 は 0.5m）
  const g = Math.max(1, Math.round(cL / cR)); // 1（普通）か 2（親の 1/4）
  const pi = Math.floor(gi / g + 1e-4) * g, pj = Math.floor(gj / g + 1e-4) * g;
  const wx = x0 + pi * cR, wz = z0 + pj * cR;
  const dist = Math.hypot(wx - cx, wz - cz);
  const o = L * 4;
  const k = Math.min(1, Math.max(0, (dist - morph[o]) * morph[o + 2]));
  let qi = pi / g, qj = pj / g;
  qi -= fract(qi * 0.5) * 2 * k;
  qj -= fract(qj * 0.5) * 2 * k;
  return [x0 + qi * cL, z0 + qj * cL];
}

function fract(v) { return v - Math.floor(v); }

/**
 * 高さの最小・最大のピラミッド（視錐台の間引き用）。far の格子（1m）から葉ごとに
 * @param {{data:Float32Array, n:number, origin:number[], step:number}} far
 * @returns {{min: Float32Array[], max: Float32Array[]}} 段ごとの (64>>l)² の表
 */
export function heightPyramid(far) {
  const nLeaf = CDLOD_ROOT.size / CDLOD_LEAF;
  const mins = [], maxs = [];
  const m0 = new Float32Array(nLeaf * nLeaf).fill(1e9), M0 = new Float32Array(nLeaf * nLeaf).fill(-1e9);
  if (far && far.data) {
    const { data, n, origin, step } = far;
    for (let j = 0; j < n; j++) {
      const z = origin[1] + j * step;
      const lj = Math.min(nLeaf - 1, Math.max(0, Math.floor((z - CDLOD_ROOT.origin) / CDLOD_LEAF)));
      for (let i = 0; i < n; i++) {
        const x = origin[0] + i * step;
        const li = Math.min(nLeaf - 1, Math.max(0, Math.floor((x - CDLOD_ROOT.origin) / CDLOD_LEAF)));
        const h = data[j * n + i];
        const k = lj * nLeaf + li;
        if (h < m0[k]) m0[k] = h;
        if (h > M0[k]) M0[k] = h;
        /* 区画の縁の点は隣の葉にも入れる（縁の高さを両方が含む） */
        const ex = ((x - CDLOD_ROOT.origin) % CDLOD_LEAF === 0) && li > 0, ez = ((z - CDLOD_ROOT.origin) % CDLOD_LEAF === 0) && lj > 0;
        if (ex) { const k2 = k - 1; if (h < m0[k2]) m0[k2] = h; if (h > M0[k2]) M0[k2] = h; }
        if (ez) { const k2 = k - nLeaf; if (h < m0[k2]) m0[k2] = h; if (h > M0[k2]) M0[k2] = h; }
      }
    }
  }
  for (let k = 0; k < m0.length; k++) { if (m0[k] > M0[k]) { m0[k] = -30; M0[k] = 30; } m0[k] -= 1; M0[k] += 1; }
  mins.push(m0); maxs.push(M0);
  for (let l = 1; l < CDLOD_LEVELS; l++) {
    const nPrev = nLeaf >> (l - 1), nn = nLeaf >> l;
    const pm = mins[l - 1], pM = maxs[l - 1];
    const m = new Float32Array(nn * nn), M = new Float32Array(nn * nn);
    for (let j = 0; j < nn; j++) for (let i = 0; i < nn; i++) {
      let a = 1e9, b = -1e9;
      for (let q = 0; q < 4; q++) {
        const k = (j * 2 + (q >> 1)) * nPrev + (i * 2 + (q & 1));
        a = Math.min(a, pm[k]); b = Math.max(b, pM[k]);
      }
      m[j * nn + i] = a; M[j * nn + i] = b;
    }
    mins.push(m); maxs.push(M);
  }
  return { min: mins, max: maxs };
}

/**
 * 区画の高さの範囲（ピラミッドを引く）。区画の大きさから段を逆算する
 * @param {{min: Float32Array[], max: Float32Array[]}} pyr
 * @param {number} x0
 * @param {number} z0
 * @param {number} s
 * @param {number[]} out [min, max]
 */
export function nodeHeightRange(pyr, x0, z0, s, out) {
  /* ピラミッドは 16m の葉から。8m の区画（セル 16）はそれを含む 16m の葉の範囲（安全側） */
  const l = Math.max(0, Math.min(CDLOD_LEVELS - 1, Math.round(Math.log2(s / CDLOD_LEAF))));
  const nn = (CDLOD_ROOT.size / CDLOD_LEAF) >> l;
  const i = Math.min(nn - 1, Math.max(0, Math.floor((x0 - CDLOD_ROOT.origin) / nodeSize(l))));
  const j = Math.min(nn - 1, Math.max(0, Math.floor((z0 - CDLOD_ROOT.origin) / nodeSize(l))));
  out[0] = pyr.min[l][j * nn + i];
  out[1] = pyr.max[l][j * nn + i];
  return out;
}
