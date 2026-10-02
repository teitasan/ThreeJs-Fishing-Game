/* ===========================================================
   大気（Hillaire 2020）の定数と CPU 双子
   -----------------------------------------------------------
   GPU の LUT（glsl/atmo.glsl.js）と «同じ式・同じ写像» を JS で持つ。
   - 透過 LUT（Bruneton の (r, μ) 写像）・多重散乱 LUT（ψ_ms、Hillaire §5.5）・
     空の放射輝度（視線の raymarch。太陽と月の 2 灯）
   - 用途：SH の射影・地平線の整合・ファサードの色・key の色と強さ・sampleSky・テスト
   - 単位：大気の上端の照度 1 に対する放射輝度（ng 単位への換算は呼び手が E_top を掛ける）
   - three を import しない（Node のテストから読む）。Math.random を使わない
   =========================================================== */

/** 物理定数（m・1/m）。GLSL はこの値から生成する */
export const ATMO = Object.freeze({
  Rg: 6360e3,
  Rt: 6460e3,
  /** Rayleigh の散乱（吸収なし） */
  betaR: Object.freeze([5.802e-6, 13.558e-6, 33.1e-6]),
  HR: 8000,
  /** Mie の散乱・吸収（× haze） */
  mieS: 3.996e-6,
  mieA: 4.4e-6,
  HM: 1200,
  mieG: 0.8,
  /** オゾンの吸収（25km を頂点に ±15km のテント）。ブルーアワーの青はこれ */
  ozone: Object.freeze([0.650e-6, 1.881e-6, 0.085e-6]),
  ozoneC: 25e3,
  ozoneW: 15e3,
  /** 地面のアルベド（森と湖。多重散乱と地面の照り返し） */
  albedo: 0.12,
  /** 視点の高さ（湖面 + 目の高さ）。LUT は視点の高さに依らない（±70m の差は無視できる） */
  viewH: 20,
});

/** LUT の大きさ（GPU）。CPU 双子は小さい版 */
/** 太陽の項の太陽の最低の高度（sin(−9°)）と cos */
export const SUN_CLAMP_SY = Math.sin(-9 * Math.PI / 180);
export const SUN_CLAMP_C = Math.cos(-9 * Math.PI / 180);
export const LUT = Object.freeze({
  transW: 256, transH: 64, msN: 32, viewW: 256, viewH: 128,
  cpuTransW: 64, cpuTransH: 32, cpuMsN: 16,
});

const H_TOP = Math.sqrt(ATMO.Rt * ATMO.Rt - ATMO.Rg * ATMO.Rg);
const PI = Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const phaseR = (mu) => 0.0596831 * (1 + mu * mu);
export function phaseHG(mu, g) {
  const d = Math.max(1 + g * g - 2 * g * mu, 1e-4);
  return 0.07957747 * (1 - g * g) / (d * Math.sqrt(d));
}
/** Cornette-Shanks（Mie。HG より前方の峰が自然） */
export function phaseCS(mu, g) {
  const k = 0.1193662 * (1 - g * g) / (2 + g * g);   // 3/(8π)
  const d = Math.max(1 + g * g - 2 * g * mu, 1e-4);
  return k * (1 + mu * mu) / (d * Math.sqrt(d));
}

/**
 * 高さ h（m、地表から）の媒質
 * @param {number} h
 * @param {number} haze Mie の倍率
 * @returns {{sR:number[], sM:number, t:number[]}} 散乱 Rayleigh rgb・散乱 Mie・消散 rgb（1/m）
 */
export function medium(h, haze, out = { sR: [0, 0, 0], sM: 0, t: [0, 0, 0] }) {
  const rR = Math.exp(-Math.max(h, 0) / ATMO.HR);
  const rM = Math.exp(-Math.max(h, 0) / ATMO.HM);
  const rO = Math.max(0, 1 - Math.abs(h - ATMO.ozoneC) / ATMO.ozoneW);
  const sM = ATMO.mieS * haze * rM, aM = ATMO.mieA * haze * rM;
  for (let k = 0; k < 3; k++) {
    out.sR[k] = ATMO.betaR[k] * rR;
    out.t[k] = out.sR[k] + sM + aM + ATMO.ozone[k] * rO;
  }
  out.sM = sM;
  return out;
}

/** 半径 r の点から μ 方向で大気の上端までの距離 */
export function distToTop(r, mu) {
  const disc = r * r * (mu * mu - 1) + ATMO.Rt * ATMO.Rt;
  return Math.max(-r * mu + Math.sqrt(Math.max(disc, 0)), 0);
}
/** 地面に当たるなら距離、当たらなければ -1 */
export function distToGround(r, mu) {
  const disc = r * r * (mu * mu - 1) + ATMO.Rg * ATMO.Rg;
  if (mu >= 0 || disc < 0) return -1;
  return Math.max(-r * mu - Math.sqrt(disc), 0);
}
/** 地平の μ（これより下を向く光線は地面に当たる） */
export const muHorizon = (r) => -Math.sqrt(Math.max(1 - (ATMO.Rg / r) ** 2, 0));

/* ---------- 透過 LUT の写像（Bruneton 2017。GLSL と同じ） ---------- */
const unitToUv = (x, n) => 0.5 / n + x * (1 - 1 / n);
const uvToUnit = (u, n) => (u - 0.5 / n) / (1 - 1 / n);

/** (r, μ) → LUT の uv */
export function transUV(r, mu, W = LUT.transW, H = LUT.transH) {
  const rho = Math.sqrt(Math.max(r * r - ATMO.Rg * ATMO.Rg, 0));
  const d = distToTop(r, mu);
  const dMin = ATMO.Rt - r, dMax = rho + H_TOP;
  const xm = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0;
  return [unitToUv(clamp01(xm), W), unitToUv(clamp01(rho / H_TOP), H)];
}
/** LUT の uv → (r, μ) */
export function transRMu(u, v, W = LUT.transW, H = LUT.transH) {
  const xm = clamp01(uvToUnit(u, W)), xr = clamp01(uvToUnit(v, H));
  const rho = H_TOP * xr;
  const r = Math.sqrt(rho * rho + ATMO.Rg * ATMO.Rg);
  const dMin = ATMO.Rt - r, dMax = rho + H_TOP;
  const d = dMin + xm * (dMax - dMin);
  const mu = d === 0 ? 1 : clamp((H_TOP * H_TOP - rho * rho - d * d) / (2 * r * d), -1, 1);
  return [r, mu];
}

/** 数値積分の透過（上端まで。地面は見ない）rgb */
export function transmittanceNumeric(r, mu, haze, steps = 40) {
  const d = distToTop(r, mu), dt = d / steps;
  const od = [0, 0, 0], m = { sR: [0, 0, 0], sM: 0, t: [0, 0, 0] };
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - ATMO.Rg;
    medium(h, haze, m);
    for (let k = 0; k < 3; k++) od[k] += m.t[k] * dt;
  }
  return od.map((x) => Math.exp(-x));
}

/**
 * CPU の大気。haze が 2% 変わったら LUT を作り直す（GPU と同じ規則）
 */
export class AtmosphereCPU {
  constructor() {
    this.haze = -1;
    this.trans = new Float32Array(LUT.cpuTransW * LUT.cpuTransH * 3);
    this.ms = new Float32Array(LUT.cpuMsN * LUT.cpuMsN * 3);
    this._m = { sR: [0, 0, 0], sM: 0, t: [0, 0, 0] };
    this._t = [0, 0, 0];
    this._t2 = [0, 0, 0];
    this._ms = [0, 0, 0];
    this.rView = ATMO.Rg + ATMO.viewH;
    this.dirs = fibonacciSphere(16);
    this.deck = { h: 1400, occ: 0, L: [0, 0, 0] };
    this._r0 = [0, 0, 0]; this._r1 = [0, 0, 0]; this._r2 = [0, 0, 0]; this._r3 = [0, 0, 0]; this._r4 = [0, 0, 0];
  }

  /** @returns {boolean} 作り直したか（同期。重い：≈5ms） */
  setHaze(haze, force = false) {
    if (!force && this.haze > 0 && Math.abs(haze - this.haze) <= 0.02 * this.haze) return false;
    for (const _ of this.build(haze)) { /* 最後まで */ }
    return true;
  }

  /**
   * 表を作り直す生成器（行ごとに yield。呼び手が時間で刻む）。作っている間の表引きは使わないこと
   * （SkyModule は 2 つの AtmosphereCPU を交互に使う）
   */
  *build(haze) {
    this.haze = haze;
    const W = LUT.cpuTransW, H = LUT.cpuTransH;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const [r, mu] = transRMu((i + 0.5) / W, (j + 0.5) / H, W, H);
        const T = transmittanceNumeric(r, mu, haze, 32);
        const o = (j * W + i) * 3;
        this.trans[o] = T[0]; this.trans[o + 1] = T[1]; this.trans[o + 2] = T[2];
      }
      if ((j & 3) === 3) yield j;
    }
    yield* this._buildMS();
  }

  /** 透過（上端まで、地面は見ない）。out に rgb */
  transmittance(r, mu, out = this._t) {
    const W = LUT.cpuTransW, H = LUT.cpuTransH;
    const [u, v] = transUV(r, mu, W, H);
    return bilerp(this.trans, W, H, u, v, out);
  }

  /** 太陽への透過（地球の影込み：光線が地面に当たれば 0、太陽の半径ぶん滑らかに） */
  sunTransmittance(r, muS, out = this._t2) {
    this.transmittance(r, muS, out);
    const mh = muHorizon(r);
    const s = smooth(mh - 0.006, mh + 0.006, muS);
    out[0] *= s; out[1] *= s; out[2] *= s;
    return out;
  }

  /** 多重散乱 ψ_ms(r, μs) rgb */
  multiScatter(r, muS, out = this._ms) {
    const N = LUT.cpuMsN;
    const u = unitToUv(clamp01(muS * 0.5 + 0.5), N), v = unitToUv(clamp01((r - ATMO.Rg) / (ATMO.Rt - ATMO.Rg)), N);
    return bilerp(this.ms, N, N, u, v, out);
  }

  *_buildMS() {
    const N = LUT.cpuMsN, dirs = this.dirs, steps = 12;
    const m = this._m, tS = [0, 0, 0];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const muS = clamp(uvToUnit((i + 0.5) / N, N) * 2 - 1, -1, 1);
        const r = ATMO.Rg + clamp01(uvToUnit((j + 0.5) / N, N)) * (ATMO.Rt - ATMO.Rg) + 1;
        const sunY = muS, sunX = Math.sqrt(Math.max(1 - muS * muS, 0));
        const L2 = [0, 0, 0], F = [0, 0, 0];
        for (const d of dirs) {
          const mu = d[1];
          const tG = distToGround(r, mu);
          const tMax = tG >= 0 ? tG : distToTop(r, mu);
          const dt = tMax / steps;
          const thr = [1, 1, 1], L = [0, 0, 0], f = [0, 0, 0];
          for (let s = 0; s < steps; s++) {
            const t = (s + 0.5) * dt;
            /* 点の位置（平面の 2D：上 = y、太陽は x-y 面） */
            const px = d[0] * t, py = r + mu * t, pz = d[2] * t;
            const rp = Math.hypot(px, py, pz);
            const muSp = (px * sunX + py * sunY) / rp;
            medium(rp - ATMO.Rg, this.haze, m);
            this.sunTransmittance(rp, muSp, tS);
            for (let k = 0; k < 3; k++) {
              const sig = m.sR[k] + m.sM, ext = Math.max(m.t[k], 1e-12);
              const Tk = Math.exp(-ext * dt);
              const S = sig * tS[k] * 0.07957747;            // 等方の位相 1/(4π)、上端の照度 1
              L[k] += thr[k] * (S - S * Tk) / ext;
              f[k] += thr[k] * (sig - sig * Tk) / ext;
              thr[k] *= Tk;
            }
          }
          if (tG >= 0) {
            const px = d[0] * tMax, py = r + mu * tMax, pz = d[2] * tMax;
            const rp = Math.hypot(px, py, pz);
            const muSp = (px * sunX + py * sunY) / rp;
            this.sunTransmittance(rp, muSp, tS);
            for (let k = 0; k < 3; k++) L[k] += thr[k] * tS[k] * Math.max(muSp, 0) * ATMO.albedo / PI;
          }
          for (let k = 0; k < 3; k++) { L2[k] += L[k] / dirs.length; F[k] += f[k] / dirs.length; }
        }
        const o = (j * N + i) * 3;
        for (let k = 0; k < 3; k++) this.ms[o + k] = L2[k] / Math.max(1 - F[k], 1e-3);
      }
      yield j;
    }
  }

  /**
   * 視線 v（単位、y が上）の空の放射輝度（ng 単位）。GPU の ngSkyRadiance（atmo.glsl.js）と同じ raymarch。
   * eS / eM：太陽・月の上端の照度 rgb（ng）、G：空の係数（較正）。this.deck：雲の甲板
   * （h m、occ = 甲板の下の太陽の遮り 0..1、L = 甲板の底の放射輝度 rgb）
   * @returns {number[]} rgb
   */
  radiance(vx, vy, vz, sx, sy, sz, eS, eM, G, steps = 16, out = [0, 0, 0]) {
    const r = this.rView;
    const tG = distToGround(r, vy);
    const tMax = Math.min(tG >= 0 ? tG : distToTop(r, vy), 400e3);
    const m = this._m, tS = this._r0, tM = this._r1, msS = this._r2, msM = this._r3;
    const muSv = vx * sx + vy * sy + vz * sz;
    /* 太陽の項の太陽は SUN_CLAMP_SY（−9°）より下へ沈めない（GPU の sS と同じ）。深い薄明は «−9° の空の形 × 利得»：
       物理の空は −11°〜−12° で崖のように落ち、段数の違う CPU と GPU・時刻表の利得（×2000）が崖の位置で食い違った */
    let qx = sx, qy = sy, qz = sz;
    if (sy < SUN_CLAMP_SY) { const hl = Math.hypot(sx + 1e-6, sz) || 1; qx = (sx + 1e-6) / hl * SUN_CLAMP_C; qy = SUN_CLAMP_SY; qz = sz / hl * SUN_CLAMP_C; }
    const muSvS = vx * qx + vy * qy + vz * qz;
    const pRs = phaseR(muSvS), pMs = phaseCS(muSvS, ATMO.mieG);
    const pRm = phaseR(-muSv), pMm = phaseCS(-muSv, ATMO.mieG);
    const useS = eS[0] + eS[1] + eS[2] > 0, useM = eM[0] + eM[1] + eM[2] > 0;
    const dk = this.deck, gInv = 1 / Math.max(G, 1e-6);
    const thr = this._r4;
    thr[0] = thr[1] = thr[2] = 1;
    out[0] = out[1] = out[2] = 0;
    let tPrev = 0;
    for (let i = 0; i < steps; i++) {
      const a = (i + 1) / steps;
      const t1 = tMax * a * a;
      const tm = 0.5 * (tPrev + t1), dt = t1 - tPrev;
      tPrev = t1;
      const px = vx * tm, py = r + vy * tm, pz = vz * tm;
      const rp = Math.hypot(px, py, pz);
      const muS = (px * sx + py * sy + pz * sz) / rp, muSs = (px * qx + py * qy + pz * qz) / rp;
      const h = rp - ATMO.Rg;
      medium(h, this.haze, m);
      if (useS) { this.sunTransmittance(rp, muSs, tS); this.multiScatter(rp, muSs, msS); }
      if (useM) { this.sunTransmittance(rp, -muS, tM); this.multiScatter(rp, -muS, msM); }
      const below = 1 - smooth(dk.h - 200, dk.h + 200, h);
      const occ = 1 - dk.occ * below;
      for (let k = 0; k < 3; k++) {
        const sig = m.sR[k] + m.sM, ext = Math.max(m.t[k], 1e-12);
        let S = 0;
        if (useS) S += eS[k] * occ * (tS[k] * (m.sR[k] * pRs + m.sM * pMs) + msS[k] * sig);
        if (useM) S += eM[k] * occ * (tM[k] * (m.sR[k] * pRm + m.sM * pMm) + msM[k] * sig);
        S += dk.L[k] * sig * 0.5 * below * gInv;
        const Tk = Math.exp(-ext * dt);
        out[k] += thr[k] * (S - S * Tk) / ext;
        thr[k] *= Tk;
      }
    }
    /* 地面（地平より下）：地面の照り返し（太陽・月）× 視線の透過 */
    if (tG >= 0 && tG < 400e3) {
      const px = vx * tMax, py = r + vy * tMax, pz = vz * tMax;
      const rp = Math.hypot(px, py, pz);
      const muS = (px * sx + py * sy + pz * sz) / rp, muSs = (px * qx + py * qy + pz * qz) / rp;
      if (useS) this.sunTransmittance(rp, muSs, tS);
      if (useM) this.sunTransmittance(rp, -muS, tM);
      for (let k = 0; k < 3; k++) {
        const E = (useS ? eS[k] * tS[k] * Math.max(muSs, 0) : 0) + (useM ? eM[k] * tM[k] * Math.max(-muS, 0) : 0);
        out[k] += thr[k] * E * (1 - dk.occ) * ATMO.albedo / PI;
      }
    }
    for (let k = 0; k < 3; k++) out[k] *= G;
    twShape(vx, vy, vz, sx, sy, sz, out);
    return out;
  }

  /** 地上の視点から太陽方向の直達（上端 1 あたり、地球の影込み）rgb */
  direct(sy, out = [0, 0, 0]) {
    return this.sunTransmittance(this.rView, sy, out);
  }
}

/** 双一次補間（rgb の 3 成分の表、テクセル中心の uv） */
function bilerp(tab, W, H, u, v, out) {
  const x = clamp(u * W - 0.5, 0, W - 1), y = clamp(v * H - 0.5, 0, H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0, fy = y - y0;
  for (let k = 0; k < 3; k++) {
    const a = tab[(y0 * W + x0) * 3 + k], b = tab[(y0 * W + x1) * 3 + k];
    const c = tab[(y1 * W + x0) * 3 + k], d = tab[(y1 * W + x1) * 3 + k];
    out[k] = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }
  return out;
}

/** n 方向のフィボナッチ球（決定的） */
export function fibonacciSphere(n) {
  const out = [], ga = PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(Math.max(1 - y * y, 0)), a = ga * i;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
}

/** 太陽の軌道（旧式・契約）：時刻 → 単位ベクトル */
export function sunDirAt(hour) {
  const a = (((hour % 24) + 24) % 24 - 6) / 24 * PI * 2;
  const x = Math.cos(a), y = Math.sin(a), z = 0.34, l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/* ---------- 薄明の見た目の整形（ブルーアワー） ----------
   RGB 3 波長の raymarch は、太陽が沈むと多重散乱とオゾンの吸収の釣り合いで方向によらず «灰がかった
   ラベンダー» に寄る（実際の空は連続スペクトルで青が残る）。また rig.js の薄明の利得（−14° で ×1800）が
   地平の多重散乱をそのまま持ち上げ、深い薄明の反太陽側の地平が灰色に光る。
   ここで «太陽の側の残照（warmW）以外» の空を、輝度を保ったまま
   - 地平：淡い青 → 天頂：市民薄明の青 → 航海薄明の深い青（仰角と太陽の深さで）
   - 反太陽側の地平の数度上：ビーナスベルトの桃色（太陽 +2°〜−5°、地球の影の上端より上の帯）
   - 地球の影（帯より下）：青灰
   の色度へ寄せ、深い薄明（−4° より下）の地平を仰角に応じて暗くする。純関数（GLSL の ngSkyTwShape と同じ式）。
   rig.js の薄明の利得の表はこの整形込みの空から作る（照度の目標はそのまま） */
const lumN = (c) => { const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return Object.freeze(c.map((v) => v / l)); };
export const TWS = Object.freeze({
  hor: lumN([0.70, 0.95, 1.60]), horD: lumN([0.45, 0.80, 2.20]),
  zen: lumN([0.40, 0.72, 2.60]), zenD: lumN([0.26, 0.56, 3.40]),
  belt: lumN([1.60, 0.78, 1.00]), shadow: lumN([0.55, 0.82, 1.90]), glow: lumN([2.0, 0.80, 0.40]),
});
/** 太陽の側の地平（残照）の重み（rig.js の warmWeight・GLSL の ngSkyWarmW と同じ式） */
export function warmW(vx, vy, vz, sx, sz) {
  const mu = (vx * sx + vz * sz) / Math.max(Math.hypot(vx, vz) * Math.hypot(sx, sz), 1e-4);
  const a = Math.max(0.5 + 0.5 * mu, 0), a2 = a * a;
  return a2 * a2 * a2 * smooth(0.0, 0.06, vy) * Math.exp(-Math.max(vy, 0) * 7.0);
}
/** 薄明の整形の係数（太陽高度の sin だけで決まる）：[色度の重み, 深さ 0..1, ベルトの重み, 地平を暗くする重み, 地球の影の上端 sin] */
export function twShapeParams(sy, out = [0, 0, 0, 0, 0]) {
  const fade = 1 - smooth(-0.24, -0.32, sy);
  out[0] = smooth(0.06, -0.02, sy) * fade;
  out[1] = smooth(-0.01, -0.12, sy);
  out[2] = smooth(0.035, 0.0, sy) * (1 - smooth(-0.035, -0.075, sy));
  out[3] = smooth(-0.07, -0.18, sy) * fade;
  out[4] = Math.max(0.004, -sy * 0.85 + 0.006);
  return out;
}
const _twp = [0, 0, 0, 0, 0];
/** L（rgb、その場で書き換え）に薄明の整形を掛ける */
export function twShape(vx, vy, vz, sx, sy, sz, L) {
  if (!(sy <= 0.06)) return L;
  const p = twShapeParams(sy, _twp);
  if (p[0] <= 0) return L;
  const e = clamp01(vy);
  const mu = (vx * sx + vz * sz) / Math.max(Math.hypot(vx, vz) * Math.hypot(sx, sz), 1e-4);
  /* 残照の側（地平まで含む。warmW と違い地平で 0 に落とさない）は物理の色度のまま */
  const a = Math.max(0.5 + 0.5 * mu, 0), a2 = a * a;
  const w0 = a2 * a2 * Math.exp(-5.0 * e);
  /* 深い薄明（−5° より下）では残照の側も整形する（物理のままだと利得 ×300 で灰白に光る）：地平の細い帯だけ残照の橙へ */
  const deep = smooth(-0.09, -0.17, sy), ww = w0 * (1 - deep), glow = w0 * deep * Math.exp(-6.0 * e);
  const anti = smooth(0.0, -0.85, mu);
  const t = smooth(0.0, 0.45, e), dp = p[1];
  const sh = p[4], bt = sh + 0.16;
  const belt = p[2] * anti * smooth(sh * 0.6, sh + 0.03, e) * (1 - smooth(bt - 0.06, bt + 0.04, e));
  const shadow = p[2] * anti * (1 - smooth(sh * 0.5, sh + 0.02, e));
  const C = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const h = TWS.hor[k] + (TWS.horD[k] - TWS.hor[k]) * dp, z = TWS.zen[k] + (TWS.zenD[k] - TWS.zen[k]) * dp;
    let c = h + (z - h) * t;
    c += (TWS.belt[k] - c) * belt * 0.95;
    c += (TWS.shadow[k] - c) * shadow * 0.7;
    c += (TWS.glow[k] - c) * glow;
    C[k] = c;
  }
  const cl = 0.2126 * C[0] + 0.7152 * C[1] + 0.0722 * C[2];
  const lum = 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
  const cw = p[0] * (1 - ww) * 0.9;
  const dim = 1 + (0.38 + 0.62 * smooth(0.0, 0.4, e) - 1) * p[3] * (1 - ww);
  for (let k = 0; k < 3; k++) L[k] = (L[k] + (lum * C[k] / cl - L[k]) * cw) * dim;
  return L;
}
