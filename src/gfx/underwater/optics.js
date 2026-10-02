/* ===========================================================
   水の光学（純関数。Node のテスト underwater-optics が検査する）
   -----------------------------------------------------------
   ARCHITECTURE §6.3：σa = (0.20, 0.075, 0.045) × (1 + 0.5·rain)、σs 0.03–0.06。
     ngWaterInsc = σs/(σa+σs) × (E_key·透過·0.55 + E_sky·0.8) × 青緑 / 2π
   - 透過は空気 → 水の Fresnel（偏光なしの平均）。低い太陽ほど水面で跳ね返される
   - 青緑：山の湖の黄色物質（CDOM）と植物プランクトンで、純水の «青» を少し緑へ寄せる
   - 濁り（slot 10.w）= 1 + 0.5·rain + 0.12·cloud（旧 game.js の turbidity と同じ式）。雨は σs も上げる（泥の巻き上げ）
   =========================================================== */

export const UW_SIGMA_A = Object.freeze([0.20, 0.075, 0.045]);
/** 内散乱の色味（青緑）。R を少し、B を少し落とす */
export const UW_INSC_TINT = Object.freeze([0.86, 1.0, 0.84]);
/** 水の屈折率 */
export const UW_IOR = 1.333;

/**
 * 空気 → 水の Fresnel の透過率（偏光なしの平均）
 * @param {number} cosI 入射角の cos（水面の法線と光の向き）
 */
export function fresnelTransmit(cosI) {
  const ci = Math.min(1, Math.max(1e-4, cosI));
  const si = Math.sqrt(Math.max(0, 1 - ci * ci));
  const st = si / UW_IOR;
  const ct = Math.sqrt(Math.max(0, 1 - st * st));
  const rs = (ci - UW_IOR * ct) / (ci + UW_IOR * ct);
  const rp = (ct - UW_IOR * ci) / (ct + UW_IOR * ci);
  return Math.min(1, Math.max(0, 1 - 0.5 * (rs * rs + rp * rp)));
}

/**
 * 水の光学の値（ngFrame slot 9・10 と optics）
 * @param {{ rain?: number, cloud?: number, keyRad: ArrayLike<number>, keyY: number, skyIrr: ArrayLike<number> }} o
 *   keyRad = ngKeyRad（key の地表放射照度 rgb、法線入射）、keyY = key の向きの y（sin 高度）、skyIrr = ngSkyIrr（空の放射輝度の平均 rgb）
 * @returns {{ sigmaA: number[], sigmaS: number, insc: number[], turbidity: number, keyT: number, keyE: number[] }}
 *   keyE = 水面を透過した key の «水平面の» 放射照度 rgb（caustics・光柱の E）
 */
export function waterOptics(o) {
  const rain = clamp01(o.rain || 0), cloud = clamp01(o.cloud || 0);
  const sigmaA = UW_SIGMA_A.map((v) => v * (1 + 0.5 * rain));
  const sigmaS = 0.03 + 0.03 * rain;
  const ky = Math.max(0, Number.isFinite(o.keyY) ? o.keyY : 0);
  const keyT = fresnelTransmit(ky);
  const keyE = [0, 1, 2].map((k) => fin(o.keyRad[k]) * ky * keyT);
  const insc = [0, 1, 2].map((k) => {
    const E = keyE[k] * 0.55 + fin(o.skyIrr[k]) * Math.PI * 0.8;
    return (sigmaS / (sigmaA[k] + sigmaS)) * E * UW_INSC_TINT[k] / (2 * Math.PI);
  });
  return { sigmaA, sigmaS, insc, turbidity: 1 + 0.5 * rain + 0.12 * cloud, keyT, keyE };
}

/**
 * 水中の灰色の板（アルベド 0.18、正面を向く）が距離 d でどれだけ背景（水の霞）から浮くか。
 * カメラと板が同じ深さ（水中 → 水中）の Beer-Lambert + 内散乱の解析。返す値は Weber のコントラスト |C − B| / B
 * @param {number} d 距離 m
 * @param {{ sigmaA: number[], sigmaS: number, insc: number[] }} op waterOptics の戻り
 * @param {number[]} Eplate 板が受ける放射照度 rgb（下向き光 × cos）
 */
export function greyCardContrast(d, op, Eplate) {
  let c = 0, b = 0;
  const W = [0.2126, 0.7152, 0.0722];
  for (let k = 0; k < 3; k++) {
    const st = op.sigmaA[k] + op.sigmaS;
    const T = Math.exp(-st * d);
    const Lcard = (0.18 / Math.PI) * Eplate[k];
    c += W[k] * (Lcard * T + op.insc[k] * (1 - T));
    b += W[k] * op.insc[k];
  }
  return b > 1e-9 ? Math.abs(c - b) / b : 0;
}

function clamp01(v) { return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }
function fin(v) { return Number.isFinite(v) ? v : 0; }
