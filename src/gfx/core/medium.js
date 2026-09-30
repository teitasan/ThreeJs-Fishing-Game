/* ===========================================================
   ngApplyMedium の JS 双子（glsl/medium.glsl.js と同じ式）
   -----------------------------------------------------------
   用途：テスト（閉形式と数値積分の照合）、scene.fog.near / far の算出
   （debug.js が near.toFixed を呼ぶ）、CPU 側の雲影（キャラクターの key の減光）、
   地平線の自動整合（ngInscatterAmb を解く）。
   F は ngFrameData（Float32Array 96）。three を import しない
   =========================================================== */
import { NG } from './frame.js';

const o = (slot) => slot * 4;

/** (1 - e^-x) / x（x→0 は級数） */
export function expDiv(x) {
  return Math.abs(x) < 1e-2 ? 1 - x * (0.5 - x / 6) : (1 - Math.exp(-x)) / x;
}

/**
 * 高さ指数の媒質の光学的厚さ（GLSL と同じ式：低い方の端を基準に exp があふれない形）
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @param {number} beta 地表の消散係数（1/m）
 * @param {number} H スケール高（m）
 */
export function airOpticalDepth(a, b, beta, H) {
  H = Math.max(H, 1e-3);
  const ua = Math.max(a.y / H, -20), ub = Math.max(b.y / H, -20);
  const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  return beta * L * Math.exp(-Math.min(ua, ub)) * expDiv(Math.abs(ub - ua));
}

/** Rayleigh の位相関数 */
export const phaseR = (mu) => 0.0596831 * (1 + mu * mu);
/** Henyey-Greenstein の位相関数 */
export function phaseHG(mu, g) {
  const d = Math.max(1 + g * g - 2 * g * mu, 1e-4);
  return 0.07957747 * (1 - g * g) / (d * Math.sqrt(d));
}

function mistMask(F, x, z) {
  const R = F[o(NG.CORE) + 1];
  return R > 0 ? 1 - smoothstep(R, R + 80, Math.hypot(x, z)) : 1;
}

/**
 * 空気の区間 a→b
 * @returns {{T:number[], Lin:number[]}} rgb
 */
export function airSegment(F, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const L = Math.max(Math.hypot(dx, dy, dz), 1e-4);
  const odR = airOpticalDepth(a, b, 1, Math.max(F[o(NG.BETA_R) + 3], 1));
  const odM = airOpticalDepth(a, b, 1, Math.max(F[o(NG.BETA_M) + 3], 1));
  const mb = F[o(NG.MIST) + 1];
  const am = { x: a.x, y: Math.max(a.y - mb, 0), z: a.z }, bm = { x: b.x, y: Math.max(b.y - mb, 0), z: b.z };
  const odMist = Math.max(0, F[o(NG.MIST)] * mistMask(F, 0.5 * (a.x + b.x), 0.5 * (a.z + b.z))
    * airOpticalDepth(am, bm, 1, Math.max(F[o(NG.MIST) + 2], 0.1)));
  const kx = F[o(NG.KEY)], ky = F[o(NG.KEY) + 1], kz = F[o(NG.KEY) + 2];
  const mu = (dx * kx + dy * ky + dz * kz) / L;
  const pR = phaseR(mu), pM = phaseHG(mu, F[o(NG.MIST) + 3]);
  const T = [0, 0, 0], Lin = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const tR = Math.max(F[o(NG.BETA_R) + c], 0) * odR, tM = Math.max(F[o(NG.BETA_M) + c], 0) * odM;
    const tau = tR + tM + odMist;
    const E = F[o(NG.KEYRAD) + c], A = F[o(NG.INSC) + c];
    T[c] = Math.exp(-tau);
    const S = tR * (E * pR + A) + tM * (E * pM + A) + odMist * (E * pM + A + F[o(NG.INSC) + 3]);
    Lin[c] = S * (1 - T[c]) / Math.max(tau, 1e-7);
  }
  return { T, Lin };
}

/** 水の区間 a→b */
export function waterSegment(F, a, b) {
  const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const dAvg = Math.max(-0.5 * (a.y + b.y), 0);
  const T = [0, 0, 0], Lin = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const sa = F[o(NG.W_SIGMA) + c], ss = F[o(NG.W_SIGMA) + 3];
    T[c] = Math.exp(-(sa + ss) * L);
    Lin[c] = (1 - T[c]) * F[o(NG.W_INSC) + c] * Math.exp(-(sa + 0.3 * ss) * dAvg);
  }
  return { T, Lin };
}

/** 水中の点に届く下向き光（rgb） */
export function downwelling(F, depth) {
  const ky = clamp(F[o(NG.KEY) + 1], 0, 1);
  const cw = Math.sqrt(Math.max(1 - (1 - ky * ky) * 0.56279, 0));
  return [0, 1, 2].map((c) => Math.exp(-(F[o(NG.W_SIGMA) + c] + 0.3 * F[o(NG.W_SIGMA) + 3])
    * Math.max(depth, 0) / Math.max(cw, 0.2)));
}

/**
 * 点 P を camera C から見たときの T と Lin（§3.4 の区間規則。GLSL の ngMediumTerms と同じ）
 * @returns {{T:number[], Lin:number[]}}
 */
export function mediumTerms(F, C, P) {
  const pass = F[o(NG.CAM) + 3];
  if (pass > 1.5) return { T: [1, 1, 1], Lin: [0, 0, 0] };
  if (pass > 0.5) return airSegment(F, C, P);
  const camUnder = F[o(NG.CAM)] > 0.5, ptUnder = P.y < 0;
  if (!camUnder && !ptUnder) return airSegment(F, C, P);
  const dy = C.y - P.y;
  const t = clamp(C.y / (Math.abs(dy) < 1e-4 ? 1e-4 : dy), 0, 1);
  const X = { x: C.x + (P.x - C.x) * t, y: C.y + (P.y - C.y) * t, z: C.z + (P.z - C.z) * t };
  if (!camUnder) {
    const a = airSegment(F, C, X), w = waterSegment(F, X, P), d = downwelling(F, -P.y);
    return { T: [0, 1, 2].map((c) => d[c] * w.T[c] * a.T[c]), Lin: [0, 1, 2].map((c) => w.Lin[c] * a.T[c] + a.Lin[c]) };
  }
  if (ptUnder) {
    const w = waterSegment(F, C, P), d = downwelling(F, -P.y);
    return { T: [0, 1, 2].map((c) => d[c] * w.T[c]), Lin: w.Lin };
  }
  return airSegment(F, X, P);
}

/** L·T + Lin */
export function applyMedium(F, C, L, P) {
  const { T, Lin } = mediumTerms(F, C, P);
  return [L[0] * T[0] + Lin[0], L[1] * T[1] + Lin[1], L[2] * T[2] + Lin[2]];
}

/* ---------- 雲（GLSL の ngCloudCoverAt と同じ式） ---------- */
const fract = (v) => v - Math.floor(v);
/** Dave Hoskins の hash12（GLSL の ngHash12 と同じ式。精度は float64） */
export function hash12(x, y) {
  let p0 = fract(x * 0.1031), p1 = fract(y * 0.1031), p2 = fract(x * 0.1031);
  const d = p0 * (p1 + 33.33) + p1 * (p2 + 33.33) + p2 * (p0 + 33.33);
  p0 += d; p1 += d; p2 += d;
  return fract((p0 + p1) * p2);
}
function cloudNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy), b = hash12(ix + 1, iy), c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}
/** 雲の被覆 0..1（x, z は世界座標） */
export function cloudCoverAt(F, x, z) {
  const s = F[o(NG.CLOUDSH) + 2];
  const qx = (x + F[o(NG.CLOUDSH)]) * s, qy = (z + F[o(NG.CLOUDSH) + 1]) * s;
  const n = 0.5 * cloudNoise(qx, qy) + 0.3 * cloudNoise(qx * 2.03 + 11.7, qy * 2.03 + 11.7)
    + 0.2 * cloudNoise(qx * 4.11 + 3.9, qy * 4.11 + 3.9);
  const c = clamp(F[o(NG.CLOUDS)], 0, 1);
  return smoothstep(1 - c - 0.12, 1 - c + 0.22, n);
}
/** 雲の影（1 = 日向）。P は世界座標 */
export function cloudShadow(F, P) {
  const kx = F[o(NG.KEY)], ky = F[o(NG.KEY) + 1], kz = F[o(NG.KEY) + 2];
  const up = Math.max(ky, 0.05), h = Math.max(F[o(NG.CLOUDS) + 1] - P.y, 0);
  return 1 - clamp(F[o(NG.CLOUDSH) + 3], 0, 1) * cloudCoverAt(F, P.x + kx / up * h, P.z + kz / up * h);
}

/* ---------- scene.fog と地平線の整合 ---------- */

/**
 * カメラの高さでの水平視線の消散から、T = 0.98 / 0.02 になる距離を返す（scene.fog.near / far）。
 * 水中カメラでは水の消散（緑）を使う
 * @returns {{near:number, far:number}}
 */
export function fogNearFar(F, camPos) {
  let sigma;
  if (F[o(NG.CAM)] > 0.5) sigma = F[o(NG.W_SIGMA) + 1] + F[o(NG.W_SIGMA) + 3];
  else {
    const y = camPos.y;
    const eR = Math.exp(-Math.max(y / Math.max(F[o(NG.BETA_R) + 3], 1), -20));
    const eM = Math.exp(-Math.max(y / Math.max(F[o(NG.BETA_M) + 3], 1), -20));
    const mist = F[o(NG.MIST)] * mistMask(F, camPos.x, camPos.z)
      * Math.exp(-Math.max(y - F[o(NG.MIST) + 1], 0) / Math.max(F[o(NG.MIST) + 2], 0.1));
    sigma = F[o(NG.BETA_R) + 1] * eR + F[o(NG.BETA_M) + 1] * eM + mist;
  }
  sigma = Math.max(sigma, 1e-7);
  return { near: Math.min(-Math.log(0.98) / sigma, 1e5), far: Math.min(-Math.log(0.02) / sigma, 5e6) };
}

/**
 * 地平線の自動整合（§2）：8 方位の空の地平輝度 skyAt(dirX, dirZ) → [r,g,b] に、
 * 3km 先の媒質の内散乱の漸近値（E·P の重み付き平均 + A）が最小二乗で一致する A を解く。
 * ngInscatterAmb（slot 7.xyz）に入れる値を返す（負は 0 に丸める）
 * @param {Float32Array} F
 * @param {{x:number,y:number,z:number}} cam
 * @param {(dx:number, dz:number) => number[]} skyAt
 * @returns {number[]} rgb
 */
export function solveInscatterAmb(F, cam, skyAt) {
  const A = [0, 0, 0];
  const kx = F[o(NG.KEY)], kz = F[o(NG.KEY) + 2];
  /* 水平線なので方位によらず光学的厚さは同じ。比 tR:tM だけが効く */
  const far = { x: cam.x + 3000, y: cam.y, z: cam.z };
  const odR = airOpticalDepth(cam, far, 1, Math.max(F[o(NG.BETA_R) + 3], 1));
  const odM = airOpticalDepth(cam, far, 1, Math.max(F[o(NG.BETA_M) + 3], 1));
  for (let i = 0; i < 8; i++) {
    const az = (i / 8) * Math.PI * 2, dx = Math.cos(az), dz = Math.sin(az);
    const mu = dx * kx + dz * kz;
    const pR = phaseR(mu), pM = phaseHG(mu, F[o(NG.MIST) + 3]);
    const L = skyAt(dx, dz);
    for (let c = 0; c < 3; c++) {
      const tR = F[o(NG.BETA_R) + c] * odR, tM = F[o(NG.BETA_M) + c] * odM;
      const E = F[o(NG.KEYRAD) + c];
      const dir = (tR * E * pR + tM * E * pM) / Math.max(tR + tM, 1e-9);
      A[c] += (L[c] - dir) / 8;
    }
  }
  return A.map((v) => Math.max(v, 0));
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
