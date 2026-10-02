/* ===========================================================
   weatherfx の純関数（three を import しない。Node のテスト weatherfx-logic が検査する）
   -----------------------------------------------------------
   GLSL（rain.js・motes.js）と同じ式の JS 双子：
   - rainDrop：雨粒の位置は «粒の乱数 4 つ・時刻・カメラ・風» だけの純関数（生成と消滅の処理が無い）。
     世界の座標で落ちて、カメラ中心の箱（xz 2R・y H）へ折り返す → カメラが動いても粒は世界に留まる
   - 蛍・光芒の塵・霧の出る条件（時刻・天候・季節の連続な重み）
   - 水面への雨粒の衝撃：フレーム番号と粒の番号のハッシュで決まる点（マルチで一致）
   =========================================================== */

export const RAIN = Object.freeze({ R: 25, RN: 9, nearFrac: 0.5, H: 20, below: 7, vMin: 6.0, vSpan: 3.0, windCarry: 0.75 });

const fract = (x) => x - Math.floor(x);
const wrap = (v, lo, span) => lo + (((v - lo) % span) + span) % span;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * 雨粒の中心の位置（GLSL の ngRainDrop と同じ式）
 * @param {number[]} s 粒の乱数 [0,1)⁴
 * @param {number} t 時刻 s（envTime）
 * @param {{x:number,y:number,z:number}} cam カメラ
 * @param {{x:number,z:number}} w 風の速度 m/s（風向 × 風速 × windCarry）
 * @returns {{x:number,y:number,z:number,v:number}}
 */
export function rainDrop(s, t, cam, w) {
  const { H, below, vMin, vSpan } = RAIN;
  const R = fract(s[3] * 37.13) < RAIN.nearFrac ? RAIN.RN : RAIN.R;   // 半分は内側の円柱
  const v = vMin + vSpan * s[3];
  const x = wrap(s[0] * 2 * R + w.x * t, cam.x - R, 2 * R);
  const z = wrap(s[1] * 2 * R + w.z * t, cam.z - R, 2 * R);
  const y = wrap(s[2] * H - v * t, cam.y - below, H);
  return { x, y, z, v, R };
}

/**
 * 蛍が出る重み 0..1（初夏の晴れた夜、19:30–翌 1:00、雨と曇りで消える）
 * @param {{ night:number, rain:number, cloud:number, season:number, hour:number }} o
 */
export function fireflyActivity(o) {
  const h = ((o.hour % 24) + 24) % 24;
  const hh = h < 12 ? h + 24 : h;                     // 0–12 時は翌日の続き
  const time = smooth(19.3, 20.2, hh) * (1 - smooth(24.6, 25.4, hh));
  const season = smooth(0.30, 0.37, o.season) * (1 - smooth(0.50, 0.58, o.season));   // 既定 0.42 = 初夏
  return clamp01(smooth(0.55, 0.85, o.night) * time * season * (1 - smooth(0.02, 0.15, o.rain)) * (1 - smooth(0.45, 0.8, o.cloud)));
}

/**
 * 森の光芒の中の塵の重み 0..1（太陽が低い・晴れ・雨なし）。森の中かどうかは GLSL が樹冠で見る
 * @param {{ sinSunAlt:number, rain:number, cloud:number }} o
 */
export function motesActivity(o) {
  const lowSun = smooth(0.02, 0.10, o.sinSunAlt) * (1 - smooth(0.38, 0.55, o.sinSunAlt));
  return clamp01(lowSun * (1 - smooth(0.02, 0.2, o.rain)) * (1 - smooth(0.5, 0.85, o.cloud)));
}

/** 雨の強さ → 1 秒あたりの水面の衝撃の数（rain 0.85 で表の値の 0.85 倍） */
export function impulseRate(rain, perSec) { return Math.max(0, rain) * perSec; }

/**
 * フレーム f の k 番目の衝撃の点（カメラ中心の半径 r の円盤、一様）と振幅
 * @returns {{x:number, z:number, amp:number}}
 */
export function impulseAt(seed, f, k, cx, cz, r) {
  const a = hash(seed, f, k * 2 + 1), b = hash(seed, f, k * 2 + 2), c = hash(seed, f + 7919, k);
  const rr = r * Math.sqrt(a), th = b * Math.PI * 2;
  return { x: cx + Math.cos(th) * rr, z: cz + Math.sin(th) * rr, amp: 0.0016 + 0.0024 * c };
}

/* 32bit の整数ハッシュ（world/rng の hashCell と同じ考え方。3 つの整数 → [0,1)） */
export function hash(s, i, j) {
  let h = (s ^ Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/** 蛍の明滅（周期 p 秒・位相 ph）：0..1。光っている時間は周期の 22%（ゲンジボタルの «ふわっ» と点いて消える） */
export function fireflyBlink(t, p, ph) {
  const u = fract(t / p + ph);
  const on = smooth(0.0, 0.07, u) * (1 - smooth(0.12, 0.24, u));
  return on;
}

function clamp01(v) { return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }
