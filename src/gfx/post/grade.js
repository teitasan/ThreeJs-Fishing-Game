/* ===========================================================
   post の純関数（three を import しない。Node のテストからも読む）
   -----------------------------------------------------------
   - 露出の順応（ARCHITECTURE §2）：測光の log 平均から ±1EV（夜は +1.2EV）にクランプ、
     明るくする向き τ 1.2s・暗くする向き τ 0.6s。dt = 0（ポーズ）で止まる
   - グレード（§6.10）：ホワイトバランス（夜明け・夕焼け +300K、ブルーアワー −800K）、
     プルキニエ（夜の青と彩度 −35%）、lift/gamma/gain、彩度 1.0–1.12、ビネット 0.12、Bloom の強さ
   - 黒体の色（線形 Rec.709、輝度 1 に正規化）
   =========================================================== */

/** 順応の基準：露出後の画面の log 平均輝度の «普通の景色» の値。lab の基準の構図を順応 1 で測った中央値
 *  （昼：noon-fp-down −3.47・noon-shore −3.37・dock-3p −3.17・shore-low −2.67 → 2^−3.32、夜：night-fp −6.72 → 2^−6.67）。
 *  基準の構図では順応 ≈ 1（撮影 = 本編）、林の陰・雨・水中だけが動く */
export const NG_ADAPT_KEY = Object.freeze({ day: 0.10, night: 0.0098 });
/** 順応の幅（EV）と時定数（s） */
export const NG_ADAPT = Object.freeze({ down: -1.0, up: 1.0, upNight: 1.2, tauUp: 1.2, tauDown: 0.6, gain: 0.65 });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * 測光値から順応の目標（倍率）を出す
 * @param {number} meterLog2 露出後の画面の log2 平均輝度
 * @param {number} usedAdapt その測光のフレームで掛かっていた順応の倍率
 * @param {number} night 0..1（slot 0.w）
 * @returns {number} 目標の順応倍率（2^−1 .. 2^+1、夜は 2^+1.2 まで）
 */
export function ngAdaptTarget(meterLog2, usedAdapt, night) {
  if (!Number.isFinite(meterLog2) || !(usedAdapt > 0)) return 1;
  const n = clamp(night || 0, 0, 1);
  const key = Math.exp(Math.log(NG_ADAPT_KEY.day) + (Math.log(NG_ADAPT_KEY.night) - Math.log(NG_ADAPT_KEY.day)) * n);
  const schedLog = meterLog2 - Math.log2(usedAdapt);      // 順応を外した «時刻表の露出だけ» の明るさ
  const ev = (Math.log2(key) - schedLog) * NG_ADAPT.gain;  // 部分的な順応（完全に戻すと夜も昼の明るさになる）
  const up = NG_ADAPT.up + (NG_ADAPT.upNight - NG_ADAPT.up) * n;
  return 2 ** clamp(ev, NG_ADAPT.down, up);
}

/**
 * 順応の 1 歩（対数で damp）。dt ≤ 0 なら止まる
 * @param {number} cur 今の倍率
 * @param {number} target 目標の倍率
 * @param {number} dt s
 * @returns {number}
 */
export function ngAdaptStep(cur, target, dt) {
  if (!(dt > 0) || !(cur > 0) || !(target > 0)) return cur > 0 ? cur : 1;
  const lc = Math.log2(cur), lt = Math.log2(target);
  const tau = lt > lc ? NG_ADAPT.tauUp : NG_ADAPT.tauDown;
  const k = 1 - Math.exp(-Math.min(dt, 0.25) / tau);
  return 2 ** (lc + (lt - lc) * k);
}

/**
 * 黒体の色（線形 Rec.709、Y = 1）。Kim らの Planck 軌跡の 3 次近似（1667–25000K）
 * @param {number} K
 * @returns {[number, number, number]}
 */
export function ngBlackbody(K) {
  const T = clamp(K, 1667, 25000);
  const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
  const x = T <= 4000 ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.179910
    : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.240390;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222 ? -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
  const X = x / y, Z = (1 - x - y) / y;
  let r = 3.2404542 * X - 1.5371385 - 0.4985314 * Z;
  let g = -0.9692660 * X + 1.8760108 + 0.0415560 * Z;
  let b = 0.0556434 * X - 0.2040259 + 1.0572252 * Z;
  r = Math.max(r, 0); g = Math.max(g, 0); b = Math.max(b, 0);
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b || 1;
  return [r / Y, g / Y, b / Y];
}

/**
 * ホワイトバランスの係数（輝度 1）。dK > 0 で暖かく（低い色温度の光で照らしたように）
 * @param {number} dK 色温度のずらし K
 * @returns {[number, number, number]}
 */
export function ngWhiteBalance(dK) {
  if (!Number.isFinite(dK) || Math.abs(dK) < 1) return [1, 1, 1];
  const a = ngBlackbody(6500 - dK), b = ngBlackbody(6500);
  const g = [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
  const Y = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return [g[0] / Y, g[1] / Y, g[2] / Y];
}

/**
 * 時刻・天候からグレードの値
 * @param {{sunAltDeg:number, night:number, cloud:number, rain:number, uw:number}} s
 * @returns {{dK:number, wb:number[], sat:number, purkinje:number, lift:number[], gamma:number, gain:number[], vignette:number, bloom:number, golden:number, blue:number}}
 */
export function ngGradeParams(s) {
  const alt = Number.isFinite(s.sunAltDeg) ? s.sunAltDeg : 45;
  const night = clamp(s.night || 0, 0, 1), cloud = clamp(s.cloud || 0, 0, 1), rain = clamp(s.rain || 0, 0, 1), uw = clamp(s.uw || 0, 0, 1);
  const clear = 1 - 0.75 * cloud;
  const golden = smooth(-3, 0.5, alt) * (1 - smooth(5, 14, alt)) * clear;   // 日の出・日の入りの前後
  const blue = smooth(-11, -5, alt) * (1 - smooth(-2.5, 0, alt));            // ブルーアワー
  const day = smooth(4, 20, alt);
  const dK = 300 * golden - 800 * blue - 250 * night;
  const sat = clamp(1.0 + 0.05 * day * clear + 0.07 * golden - 0.05 * rain, 1.0, 1.12);
  /* 雨の夕方は黒が潰れる（r2 の lab-matrix で 17:45 の雨が 1.1–2.1%）。雨の霞の «ベール» として黒を少しだけ持ち上げる */
  const veil = 0.0018 * rain * (1 - day) * (1 - night);
  const lift = [0.0005 * golden + veil, 0.0015 * night + 0.0008 * blue + veil, 0.0045 * night + 0.003 * blue + veil];
  const gain = [1 + 0.015 * golden, 1, 1 - 0.02 * golden];
  /* 夜は中間調を少し持ち上げる（暗所視で «暗いと分かるが見える»。art-metrics の真夜中 / 真昼 0.25–0.40。r2：dock-3p が 0.23 だった） */
  const gamma = 1 + 0.02 * rain + 0.02 * cloud * (1 - night) + 0.05 * night * (1 - uw);
  return {
    dK, wb: ngWhiteBalance(dK), sat, purkinje: night * (1 - uw), lift, gamma, gain,
    vignette: 0.12, bloom: 0.035 + 0.015 * Math.max(night, uw), golden, blue,
  };
}

/**
 * 光芒を出すか（太陽が画面の 1.3 倍以内・高度 < 25°・水上・昼）と、その強さ 0..1
 * @param {number} sunAltDeg
 * @param {number} ndcX 太陽の画面の NDC（カメラの前にあるとき）
 * @param {number} ndcY
 * @param {boolean} front 太陽がカメラの前か
 * @param {number} uw 0..1
 * @returns {number}
 */
export function ngShaftGate(sunAltDeg, ndcX, ndcY, front, uw) {
  if (!front || !(uw < 0.5) || !Number.isFinite(sunAltDeg)) return 0;
  const m = Math.max(Math.abs(ndcX), Math.abs(ndcY));
  if (!(m < 1.3)) return 0;
  const alt = smooth(-1.5, 1.5, sunAltDeg) * (1 - smooth(18, 25, sunAltDeg));
  return alt * (1 - smooth(1.0, 1.3, m));
}

/* ---------- AgX の CPU 双子（FINAL_FS の ngAgx と同じ式。グレーカードの目標と 24 パッチの検査に使う） ---------- */
const AGX_TO2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0113], [0.0164, 0.0880, 0.8956]];
const AGX_FROM2020 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const AGX_INSET = [[0.856627153315983, 0.0951212405381588, 0.0482516061458583], [0.137318972929847, 0.761241990602591, 0.101439036467562], [0.11189821299995, 0.0767994186031903, 0.811302368396859]];
const AGX_OUTSET = [[1.1271005818144368, -0.11060664309660323, -0.016493938717834573], [-0.1413297634984383, 1.157823702216272, -0.016493938717834257], [-0.14132976349843826, -0.11060664309660294, 1.2519364065950405]];
const mul3 = (M, v) => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
const agxCurve = (x) => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };

/**
 * AgX（線形の表示の値 0..1 を返す。sRGB の符号化の前）
 * @param {number[]} rgb 露出後の線形 HDR
 * @returns {number[]}
 */
export function ngAgx(rgb) {
  let c = mul3(AGX_INSET, mul3(AGX_TO2020, rgb));
  c = c.map((v) => clamp((Math.log2(Math.max(v, 1e-10)) + 12.47393) / 16.5, 0, 1));
  c = mul3(AGX_OUTSET, c.map(agxCurve)).map((v) => Math.pow(Math.max(v, 0), 2.2));
  return mul3(AGX_FROM2020, c).map((v) => clamp(v, 0, 1));
}

/** 線形 → sRGB の符号化 */
export function ngToSrgb(x) { return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }

/**
 * 露出後の線形 HDR → 画面の sRGB（FINAL_FS の ngGrade と同じ順：WB → プルキニエ → 彩度 → AgX → lift/gain → gamma。ビネット・Bloom・ディザ抜き）
 * @param {number[]} rgb
 * @param {ReturnType<typeof ngGradeParams>} g
 * @returns {number[]}
 */
export function ngDisplay(rgb, g) {
  let c = [rgb[0] * g.wb[0], rgb[1] * g.wb[1], rgb[2] * g.wb[2]];
  let L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const rod = g.purkinje * (1 - smooth(0.02, 0.45, L));
  const tint = [0.84, 0.97, 1.32];
  c = c.map((v, i) => v + ((L + (v - L) * 0.65) * tint[i] - v) * rod);
  L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  c = c.map((v) => Math.max(L + (v - L) * g.sat, 0));
  let t = ngAgx(c);
  t = t.map((v, i) => g.gain[i] * (v + g.lift[i] * (1 - v)));
  t = t.map((v) => clamp(Math.pow(Math.max(v, 0), 1 / g.gamma), 0, 1));
  return t.map(ngToSrgb);
}
