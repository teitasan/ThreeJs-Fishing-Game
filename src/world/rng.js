/* ===========================================================
   決定的な乱数（three・DOM 無し）
   -----------------------------------------------------------
   配置は «シードだけ» から決まらなければならない（マルチの全員が同じ木に
   ぶつかる）。Math.random は禁止（placement-determinism が grep する）。
     stream(seed, 'trees')     系統ごとの種 = fnv1a(seed + ':trees')
     cellRng(s, i, j)          世界に固定した格子のセルごとの列。処理順・本数に依存しない
   =========================================================== */
import { makeRng } from '../util.js?v=20260830-zone5';

/** 文字列の 32bit FNV-1a */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32（util.makeRng と同じもの） */
export const mulberry32 = makeRng;

/** 系統ごとの種 */
export const stream = (seed, name) => fnv1a(`${seed >>> 0}:${name}`);

const mix = (h) => {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
};

/** 整数セル (i, j) のハッシュ（lowbias32 を 2 段） */
export function hashCell(s, i, j) {
  return mix(mix((s ^ Math.imul(i | 0, 0x9e3779b1)) >>> 0) ^ Math.imul(j | 0, 0x85ebca77));
}

/** セルのハッシュを [0,1) に */
export const hash01 = (s, i, j) => hashCell(s, i, j) / 4294967296;

/** セルごとの乱数列 */
export const cellRng = (s, i, j) => makeRng(hashCell(s, i, j));
