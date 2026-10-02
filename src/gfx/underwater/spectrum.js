/* ===========================================================
   caustics の周期スペクトル（純関数。Node のテスト underwater-spectrum が検査する）
   -----------------------------------------------------------
   water の services.detailTile は Phase 1 では null（water が提供しない）なので、caustics は
   自分で «タイルと時刻の両方で周期的な» 細かい波の場を持つ：
     h(x, t) = Σ a_i · cos(k_i · x − 2π j_i t / T + φ_i)
   - k_i はタイルの格子（2π/L·(n, m)）に吸着 → 空間で厳密に周期 L
   - j_i は整数（1 巡 T 秒で j_i 周）→ 時間で厳密に周期 T（層 = 時刻のフレーム）
   - 振幅は «傾き» のスペクトルで決める（各成分の傾き a·k がほぼ等しい = 曲率 a·k² は短い波ほど大きい）。
     焦点の深さ d_f ≈ 1 / ((1 − 1/n)·|H|) なので、短い波は浅い所で、長い波は深い所で焦点を結ぶ
   焼くのは波の場の «ヘッセ行列»（hxx, hyy, hxy）。caustics の明るさは受け手の点で
   1 / |det(I + D·H)|（D = 光路長 × (1 − 1/n)。面積比 = Evan Wallace 式の格子の面積比の解析形）。
   ヘッセ行列は線形なので «時刻のフレームの補間» と «2 つの向きのタイルの足し合わせ» がどちらも
   物理的に正しい波の場になる（明線の二重写しが出ない。CAUSTICS_GLSL の頭書き）
   =========================================================== */
import { mulberry32, stream } from '../../world/rng.js';

/** 波の成分の数（GLSL の uniform 配列の長さ） */
export const CS_WAVES = 40;

/**
 * 周期スペクトルを作る
 * @param {{ seed?: number, period?: number, jMax?: number, slope?: number, lambdaMin?: number, lambdaMax?: number }} [o]
 * @returns {{ period:number, waves: Array<{kx:number, ky:number, a:number, phi:number, j:number, n:number, m:number}>, hScale:number, slopeRms:number, hessRms:number }}
 */
export function causticSpectrum(o = {}) {
  const L = o.period ?? 7.0;
  const jMax = Math.max(1, Math.floor(o.jMax ?? 2));
  const slope = o.slope ?? 0.085;            // 全体の傾きの rms（穏やかな湖の細かい波）
  const lmin = o.lambdaMin ?? 0.28, lmax = o.lambdaMax ?? 3.2;
  const rnd = mulberry32(stream(o.seed ?? 20261002, 'caustic-spectrum'));
  const used = new Set();
  const waves = [];
  let guard = 0;
  while (waves.length < CS_WAVES && guard++ < 4000) {
    /* 波長は対数一様、向きは主風向 (+x) の周り ±100°（cos² に寄せる）。格子に吸着 */
    const lam = lmin * Math.pow(lmax / lmin, rnd());
    const u = rnd() * 2 - 1;
    const ang = Math.sign(u) * Math.pow(Math.abs(u), 1.5) * (100 * Math.PI / 180);
    const kk = (2 * Math.PI) / lam;
    const n = Math.round((kk * Math.cos(ang) * L) / (2 * Math.PI));
    const m = Math.round((kk * Math.sin(ang) * L) / (2 * Math.PI));
    if (n === 0 && m === 0) continue;
    const key = `${n},${m}`;
    if (used.has(key) || used.has(`${-n},${-m}`)) continue;
    used.add(key);
    const kx = (2 * Math.PI * n) / L, ky = (2 * Math.PI * m) / L;
    const k = Math.hypot(kx, ky);
    /* 時間の周波数：短い波ほど速い（分散 ω = √(g k) を 1 巡 T の整数に丸め、上限 jMax）。
       実際の ω より遅い（1 巡 8 秒）。動きの主役は GLSL のタイルの流れと長い波の歪み */
    const j = Math.max(1, Math.min(jMax, Math.round(Math.sqrt(k / ((2 * Math.PI) / lmax)) * 0.7)));
    waves.push({ n, m, kx, ky, k, a: 0, phi: rnd() * Math.PI * 2, j: rnd() < 0.5 ? j : j });
  }
  /* 傾きの振幅：各成分の傾き a·k を同じに（傾きの rms = √(Σ (a k)²/2) = slope） */
  const s1 = slope * Math.sqrt(2 / waves.length);
  let hess2 = 0;
  for (const w of waves) {
    w.a = s1 / w.k;
    hess2 += (w.a * w.k * w.k) ** 2 / 2;
  }
  const hessRms = Math.sqrt(hess2);
  return {
    period: L,
    waves,
    /* ヘッセ行列の符号化の幅（±hScale を 0..1 へ）。成分ごとの rms の約 2.6 倍で切る */
    hScale: hessRms * 2.6,
    slopeRms: s1 * Math.sqrt(waves.length / 2),
    hessRms,
  };
}

/**
 * CPU でヘッセ行列を評価する（テストと検算用。GLSL の焼き込みと同じ式）
 * @param {ReturnType<typeof causticSpectrum>} S
 * @param {number} x
 * @param {number} y
 * @param {number} ph 時刻の位相（0..1 で 1 巡）
 * @returns {[number, number, number, number]} [hxx, hyy, hxy, h]
 */
export function spectrumHessian(S, x, y, ph) {
  let hxx = 0, hyy = 0, hxy = 0, h = 0;
  for (const w of S.waves) {
    const c = Math.cos(w.kx * x + w.ky * y - 2 * Math.PI * w.j * ph + w.phi);
    hxx -= w.a * w.kx * w.kx * c;
    hyy -= w.a * w.ky * w.ky * c;
    hxy -= w.a * w.kx * w.ky * c;
    h += w.a * c;
  }
  return [hxx, hyy, hxy, h];
}

/**
 * 受け手の点の caustics の明るさ（面積比）。D = 光路長 × (1 − 1/n)、eps は焦点の頭打ち
 * @param {number} hxx
 * @param {number} hyy
 * @param {number} hxy
 * @param {number} D
 * @param {number} [eps]
 */
export function causticIntensity(hxx, hyy, hxy, D, eps = 0.12) {
  const det = (1 + D * hxx) * (1 + D * hyy) - D * D * hxy * hxy;
  return 1 / Math.sqrt(det * det + eps * eps);
}

/** GLSL の uniform 配列へ（vec4 (kx, ky, a, phi) と float j） */
export function spectrumUniforms(S, T) {
  const W = [], J = [];
  for (let i = 0; i < CS_WAVES; i++) {
    const w = S.waves[i];
    W.push(w ? new T.Vector4(w.kx, w.ky, w.a, w.phi) : new T.Vector4(0, 0, 0, 0));
    J.push(w ? w.j : 0);
  }
  return { W, J };
}
