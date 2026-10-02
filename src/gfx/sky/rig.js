/* ===========================================================
   光のリグと空の CPU 双子（three を import しない：Node のテストから読む）
   -----------------------------------------------------------
   produce の中身：時刻・天候 → ngFrame の slot 0–7・12・13・17、key（太陽 ↔ 月、交差点で強度 0）、
   SH L2（128 方向の空 + 地面の照り返し + 注視点の樹冠の遮り、0.25s ごと・時刻の跳びで即）、
   地平線の整合（8 方位）、朝霧・雨の霞・濡れ、ファサードの色。
   空の放射輝度は AtmosphereCPU（GPU の skyClear と同じ式）+ 雲の «見かけの» 模型
   （GPU の雲パノラマの方向ごとの平均。sky-proof が GPU の読み戻しと比べる）
   =========================================================== */
import { NG } from '../core/frame.js';
import { NG_UNITS, ngScheduledExposure, ngLuminance } from '../core/palette.js';
import { solveInscatterAmb } from '../core/medium.js';
import { AtmosphereCPU, ATMO, fibonacciSphere, clamp, clamp01, smooth, phaseHG, sunDirAt } from './atmosphere.js';

const SIN_1DEG = Math.sin(Math.PI / 180);
const SH_N = 128;
const HZ_N = 8;
const HZ_Y = 0.02;
/** 雲の流れの円の半径 m（24h で 1 周：≈393 m/h、時刻の純関数で真夜中に連続） */
export const CLOUD_R = 1500;
/** 夜空の底（大気光。放射輝度 ng）。NG_UNITS.NIGHT_SKY の ≈ 半分を空の底に */
export const NIGHT_FLOOR = Object.freeze([0.00024, 0.00040, 0.00084]);
/** 月の光の色（輝度 1）。物理の月光は太陽よりわずかに赤いが、夜の目（プルキンエ）と絵の約束（#0b1426 の天頂）で青へ寄せる。
    月の空の項・月の key・雲を照らす月の光に掛ける */
export const MOON_TINT = Object.freeze((() => { const c = [0.66, 0.90, 1.55]; const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return c.map((v) => v / l); })());
const MIE_G_MEDIUM = 0.76;

/**
 * 天候 → 空の係数（純関数）
 * @param {number} cloud 0..1（clear 0.14・cloudy 0.72・rain 0.95）
 * @param {number} rain 0..1（rain 0.85）
 * @param {number} hour
 */
export function weatherParams(cloud, rain, hour = 12) {
  const c = clamp01(cloud), r = clamp01(rain);
  const kc = clamp01((c - 0.14) / 0.58), kr = clamp01(r / 0.85);
  /* 晴れ（0.14）でも積雲が 3 割ほど浮かぶ（雲影も流れる）。曇り 0.77・雨 0.95+ */
  const cover = clamp01(0.30 + (c - 0.14) * 0.84);
  const strat = smooth(0.30, 0.90, c);
  /* 巻雲：晴れの日に多く、雨で隠れる。日ごとの量は時刻の周期関数（決定的） */
  const ciDay = 0.65 + 0.35 * Math.sin((hour / 24) * Math.PI * 2 + 1.3);
  return {
    cover, strat, kc, kr,
    haze: 1.6 + 1.0 * kc + 2.9 * kr,          // 晴れでも夏の日本の湿った空気（Hillaire の 1.6 倍）
    base: 1450 - 250 * kc - 700 * kr,             // m
    top: 2550 - 250 * kc + 500 * kr,              // m
    sigma: 48 - 26 * kc + 26 * kr,                // 1/km（積雲 48・層積雲 22・乱層雲 48）
    erosion: 0.55 - 0.20 * strat,
    belly: kr,
    cirrus: 0.62 * ciDay * (1 - smooth(0.1, 0.7, kc)) * (1 - kr),
    deckOcc: 0.97 * smooth(0.25, 1.0, cover),
    cloudDim: 1 - 0.9 * smooth(0.35, 1.0, cover),
    shadow: 0.85 * (1 - smooth(0.6, 0.97, cover)),
  };
}

/* ---------- 薄明の利得（ブルーアワー） ----------
   露出の時刻表（palette、post が持つ）は太陽 −4° で ×3.6、−8° で ×7 にしか上がらないのに、物理の空の照度は
   0° → −6° で 1/80 に落ちる。そのままだと薄明が真っ黒になるので、空の «太陽の項» だけを
   (1) 露出後の空の照度が日没 0.26 → 夜 0.12 へ単調に下がる明るさ、(2) RGB 3 波長のオゾンが作る
   赤紫の平均色度を «ブルーアワーの青» へ寄せた色度、に持ち上げる。方向ごとの比（ビーナスベルトの桃色・
   地球の影の青灰・太陽側の残照の橙）は物理の raymarch のまま残る（平均の色度だけを直す）。 */
/** 露出後の空の照度（輝度）の目標。sy = sin(太陽高度) */
export function twilightTarget(sy) { return 0.12 + 0.14 * smooth(-0.30, -0.02, sy); }
/** 薄明の平均の色度（輝度 1 に正規化して使う）：市民薄明の青と、航海薄明の深い青 */
export const TW_CIVIL = Object.freeze([0.70, 0.90, 2.10]);
/** 太陽の側の地平（残照）は物理の色度のまま明るさだけ持ち上げる：その重み（atmo.glsl.js の ngSkyWarmW と同じ式） */
export function warmWeight(vx, vy, vz, sx, sz) {
  const mu = (vx * sx + vz * sz) / Math.max(Math.hypot(vx, vz) * Math.hypot(sx, sz), 1e-4);
  const a = Math.max(0.5 + 0.5 * mu, 0), a2 = a * a;
  return a2 * a2 * a2 * smooth(0.0, 0.06, vy) * Math.exp(-Math.max(vy, 0) * 7.0);
}
/** 残照の色度（太陽の側の地平の数度上。RGB のオゾンが作る桃紫を橙へ寄せる） */
export const TW_GLOW = Object.freeze([2.0, 0.95, 0.40]);
export const TW_DEEP = Object.freeze([0.46, 0.80, 2.70]);
const TW_A0 = -24, TW_N = 31, TW_GMAX = 2000;

/** three の SphericalHarmonics3.getBasisAt と同じ順・係数 */
export function shBasis(x, y, z, out) {
  out[0] = 0.282095;
  out[1] = 0.488603 * y; out[2] = 0.488603 * z; out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y; out[5] = 1.092548 * y * z; out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z; out[8] = 0.546274 * (x * x - y * y);
  return out;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class SkyRig {
  constructor() {
    this.A = new AtmosphereCPU();
    this.B = new AtmosphereCPU();
    this.A.setHaze(1, true);
    this.sunCol = [1, 1, 1];
    this._calibrate();
    /* 薄明の利得の表（太陽高度 −24°〜+6° の 1° 刻み、rgb）。init で buildTwilight() を刻んで作る。それまでは 1 */
    this.twG = new Float32Array(TW_N * 3).fill(1);
    this.twW = new Float32Array(TW_N * 3).fill(1);
    this.twE = new Float32Array(TW_N * 3);
    this.twM = new Float32Array(TW_N);
    this.gW = [1, 1, 1];
    this.upTw = [0, 0, 0];
    this.twReady = false;
    this.gTw = [1, 1, 1];
    this.dirs = fibonacciSphere(SH_N);
    for (let i = 0; i < HZ_N; i++) {
      const a = (i / HZ_N) * Math.PI * 2, l = Math.hypot(1, HZ_Y);
      this.dirs.push([Math.cos(a) / l, HZ_Y / l, Math.sin(a) / l]);
    }
    const n = this.dirs.length;
    this.Lclear = new Float32Array(n * 3);
    this.Lsky = new Float32Array(n * 3);
    this.rr = 0;
    this.gen = null; this.genHaze = 0;
    this.wet = 0; this.puddle = 0;
    this.sh = new Float32Array(27);
    this.skyUp = [0, 0, 0];
    this._shT = -1; this._last = null;
    this.canopy = 0;
    this.uwInsc = null; this.uw = 0;
    this.p = { eS0: 0, eS: [0, 0, 0], eM: [0, 0, 0], ambTop: [0, 0, 0], ambBot: [0, 0, 0], deckL: [0, 0, 0], lightE: [0, 0, 0], light: [0, 1, 0], useMoonLight: false };
    this.out = {
      keyDir: [0, 1, 0], keyE: [0, 0, 0], keyColor: [1, 1, 1], keyIntensity: 0,
      zenith: [0, 0, 0], horizon: [0, 0, 0], exposure: 1, wp: null, sunDisk: [0, 0, 0], moonDisk: [0, 0, 0],
      stars: 0, milky: 0, jumped: true,
    };
    this._b = new Array(9).fill(0);
    this._t = [0, 0, 0];
  }

  /* 真昼・快晴（haze 1）の太陽の照度 = KEY_NOON、空の半球照度 = SKY_NOON、月の天頂 = MOON */
  _calibrate() {
    const A = this.A, noon = sunDirAt(12);
    const T = A.direct(noon[1], [0, 0, 0]);
    this.Etop = NG_UNITS.KEY_NOON / Math.max(ngLuminance(T[0], T[1], T[2]), 1e-6);
    const Tz = A.direct(1, [0, 0, 0]);
    this.moonTop = NG_UNITS.MOON / Math.max(ngLuminance(Tz[0], Tz[1], Tz[2]), 1e-6);
    const dirs = fibonacciSphere(SH_N), w = (4 * Math.PI) / SH_N, E = [0, 0, 0], eS = [this.Etop, this.Etop, this.Etop], z = [0, 0, 0];
    const o = [0, 0, 0];
    for (const d of dirs) {
      if (d[1] <= 0) continue;
      A.radiance(d[0], d[1], d[2], noon[0], noon[1], noon[2], eS, z, 1, 12, o);
      for (let k = 0; k < 3; k++) E[k] += o[k] * d[1] * w;
    }
    this.G = NG_UNITS.SKY_NOON / Math.max(ngLuminance(E[0], E[1], E[2]), 1e-9);
  }

  /**
   * 薄明の利得の表を作る生成器（高度ごとに yield。≈20ms）。晴れ（haze 1.6）・甲板なしの物理の空の照度と、
   * 同じ時刻の月の空の照度から、太陽の項の rgb の倍率を決める（twilightTarget・TW_CIVIL・TW_DEEP）
   */
  *buildTwilight() {
    const atm = new AtmosphereCPU();
    atm.setHaze(1.6, true);
    const dirs = fibonacciSphere(48), w = (4 * Math.PI) / 48, o = [0, 0, 0], z = [0, 0, 0];
    const flo = ngLuminance(NIGHT_FLOOR[0], NIGHT_FLOOR[1], NIGHT_FLOOR[2]) * Math.PI;
    const nC = (c) => { const l = ngLuminance(c[0], c[1], c[2]); return c.map((v) => v / l); };
    const civ = nC(TW_CIVIL), deep = nC(TW_DEEP), glow = nC(TW_GLOW);
    yield 0;
    for (let i = 0; i < TW_N; i++) {
      const alt = (TW_A0 + i) * Math.PI / 180, sy = Math.sin(alt);
      const s = [Math.cos(alt), sy, 0];
      const sunSky = smooth(-0.40, -0.05, sy), moonSky = smooth(-0.40, -0.05, -sy);
      const eS = [this.Etop * sunSky, this.Etop * sunSky, this.Etop * sunSky], eM = MOON_TINT.map((t) => this.moonTop * moonSky * t);
      const Es = [0, 0, 0];
      let Em = 0;
      for (const d of dirs) {
        if (d[1] <= 0) continue;
        if (sunSky > 0) { atm.radiance(d[0], d[1], d[2], s[0], s[1], s[2], eS, z, this.G, 10, o); for (let k = 0; k < 3; k++) Es[k] += o[k] * d[1] * w; }
        if (moonSky > 0) { atm.radiance(d[0], d[1], d[2], s[0], s[1], s[2], z, eM, this.G, 10, o); Em += ngLuminance(o[0], o[1], o[2]) * d[1] * w; }
      }
      const lp = ngLuminance(Es[0], Es[1], Es[2]);
      const ex = ngScheduledExposure(alt * 180 / Math.PI, 0, 0);
      const tgt = Math.max(twilightTarget(sy) / ex - Em - flo, 0) * (1 - smooth(-0.22, -0.31, sy));
      const lum = Math.max(lp, tgt);
      const w1 = smooth(0.0, -0.035, sy), w2 = smooth(-0.06, -0.16, sy);
      const gl = clamp(lp > 1e-12 ? lum / lp : 1, 1, TW_GMAX), wg = smooth(0.0, -0.03, sy);
      this.twM[i] = Em;
      for (let k = 0; k < 3; k++) {
        const cp = lp > 1e-12 ? Es[k] / lp : deep[k];
        const c = (cp + (civ[k] - cp) * w1) + (deep[k] - civ[k]) * w2 * w1;
        const g = Es[k] > 1e-12 ? (lum * c) / Es[k] : 1;
        this.twG[i * 3 + k] = clamp(Number.isFinite(g) ? g : 1, 0.05, TW_GMAX);
        this.twE[i * 3 + k] = Es[k] * this.twG[i * 3 + k];
        /* 太陽の側：明るさは同じ倍率、色度は物理の平均 → 残照の橙へ。深い薄明（−6° より下）では青へ戻す（残照は −10° で消える） */
        const gw = gl * Math.pow(glow[k] / Math.max(lp > 1e-12 ? Es[k] / lp : 1, 1e-3), 0.6 * wg);
        this.twW[i * 3 + k] = clamp(gw + (this.twG[i * 3 + k] - gw) * smooth(-0.10, -0.19, sy), 0.05, TW_GMAX);
      }
      yield i;
    }
    this.twReady = true;
  }

  /** 太陽高度 sy での薄明の利得 rgb（表を線形補間。表の外は端の値、+6° より上は 1） */
  twilightGain(sy, out = this.gTw) {
    const a = Math.asin(clampN(sy)) * 180 / Math.PI - TW_A0;
    const up = this.upTw;
    if (!this.twReady || a >= TW_N - 1) { out[0] = out[1] = out[2] = 1; this.gW.fill(1); up[0] = up[1] = up[2] = 0; return out; }
    const x = Math.max(0, a), i = Math.min(TW_N - 2, Math.floor(x)), f = Math.min(1, x - i);
    const t = smooth(4, 6, a + TW_A0);       // +4°〜+6° で 1 へ
    const lerp = (tab, j) => tab[j] + (tab[j + (tab === this.twM ? 1 : 3)] - tab[j]) * f;
    for (let k = 0; k < 3; k++) {
      const g = lerp(this.twG, i * 3 + k);
      out[k] = g + (1 - g) * t;
    }
    for (let k = 0; k < 3; k++) { const gw = lerp(this.twW, i * 3 + k); this.gW[k] = gw + (1 - gw) * t; }
    /* 薄明・夜の «甲板なしの» 空の照度 rgb（雲の上の環境光・甲板の底の明かり。昼は使わない） */
    const m = lerp(this.twM, i), fade = 1 - smooth(0.0, 0.10, Math.sin((a + TW_A0) * Math.PI / 180));
    for (let k = 0; k < 3; k++) up[k] = (lerp(this.twE, i * 3 + k) + m * MOON_TINT[k] + NIGHT_FLOOR[k] * Math.PI) * fade;
    return out;
  }

  /**
   * 1 フレーム。F（ngFrameData）の slot 0–7・12・13・17 を書き、結果（this.out）と SH（this.sh）を返す
   * @param {{dt:number, hour:number, weather:{cloud:number, rain:number}, sunDir:{x,y,z}, nightAmount?:number,
   *          envTime?:number, camera?:{position:{x,y,z}}}} input
   * @param {Float32Array} F
   */
  step(input, F) {
    const cloud = clamp01(fin(input.weather?.cloud, 0.14)), rain = clamp01(fin(input.weather?.rain, 0));
    const hour = fin(input.hour, 12);
    const h = ((hour % 24) + 24) % 24;
    const sd = input.sunDir || { x: 0, y: 1, z: 0 };
    const s = norm3(fin(sd.x, 0), fin(sd.y, 1), fin(sd.z, 0));
    const dt = Math.max(0, fin(input.dt, 0));
    const wp = weatherParams(cloud, rain, h);
    const L0 = this._last;
    const jumped = !L0 || Math.abs(angDiff(h, L0.h)) > 0.05 || Math.abs(cloud - L0.cloud) > 0.02 || Math.abs(rain - L0.rain) > 0.02;
    this._last = { h, cloud, rain };
    /* 大気の表（haze） */
    if (this._haze2(wp.haze, jumped)) this.rr = 0;
    const A = this.A;
    /* 光：太陽・月の上端の照度。空の LUT は両方を灯す（月は −sunDir） */
    const sunSky = smooth(-0.40, -0.05, s[1]), moonSky = smooth(-0.40, -0.05, -s[1]);
    const p = this.p;
    const gTw = this.twilightGain(s[1]);
    p.eS0 = this.Etop * sunSky;
    for (let k = 0; k < 3; k++) {
      p.eS[k] = this.Etop * this.sunCol[k] * sunSky * gTw[k];
      p.eM[k] = this.moonTop * this.sunCol[k] * moonSky * MOON_TINT[k];
    }
    /* 雲を照らす光：太陽が −6° より上なら太陽、それより下は月（月は 6° より上でだけ灯す → 切り替えで 0） */
    p.useMoonLight = s[1] < -0.10;
    p.light = p.useMoonLight ? [-s[0], -s[1], -s[2]] : s.slice();
    const lg = p.useMoonLight ? smooth(0.10, 0.25, -s[1]) : 1;
    for (let k = 0; k < 3; k++) p.lightE[k] = (p.useMoonLight ? this.moonTop * MOON_TINT[k] : this.Etop) * this.sunCol[k] * lg;
    /* key：太陽高度 −1° で月へ。交差点で両方 0 */
    const useSun = s[1] > -SIN_1DEG;
    const kd = useSun ? s : [-s[0], -s[1], -s[2]];
    const gate = useSun ? smooth(-SIN_1DEG, 0.10, s[1]) : smooth(SIN_1DEG, 0.10, -s[1]);
    const Tk = A.direct(kd[1], this._t);
    const top = useSun ? this.Etop : this.moonTop;
    const E = [0, 0, 0];
    for (let k = 0; k < 3; k++) E[k] = top * this.sunCol[k] * Tk[k] * gate * wp.cloudDim * (useSun ? 1 : MOON_TINT[k]);
    /* 雲の甲板（晴れの空の LUT の «甲板の下»）：底の放射輝度 */
    const Tcl = A.sunTransmittance(ATMO.Rg + wp.base, p.light[1], [0, 0, 0]);
    const tau = wp.sigma * (wp.top - wp.base) / 1000;
    const D = 1 / (1 + 0.75 * tau * 0.15);
    const lyE = Math.sqrt(Math.max(p.light[1], 0.03));
    const upT = this.upTw;
    for (let k = 0; k < 3; k++) p.deckL[k] = (p.lightE[k] * Tcl[k] * lyE + 0.6 * upT[k]) * D / Math.PI * smooth(0.2, 0.9, wp.cover);
    A.deck.h = wp.base; A.deck.occ = wp.deckOcc; A.deck.L = p.deckL;
    if (this.B !== A && this.B) { this.B.deck = A.deck; }
    /* 晴れの空の方向ごとの値（毎フレーム 9 方向ずつ、跳びは全部） */
    const n = this.dirs.length;
    const per = jumped || this.rr === 0 && !this._filled ? n : 9;
    const o = [0, 0, 0], eSd = [0, 0, 0];
    for (let c = 0; c < per; c++) {
      const i = this.rr % n;
      const d = this.dirs[i];
      const ww = warmWeight(d[0], d[1], d[2], s[0], s[2]);
      for (let k = 0; k < 3; k++) eSd[k] = p.eS0 * this.sunCol[k] * (gTw[k] + (this.gW[k] - gTw[k]) * ww);
      A.radiance(d[0], d[1], d[2], s[0], s[1], s[2], eSd, p.eM, this.G, 12, o);
      this.Lclear[i * 3] = o[0]; this.Lclear[i * 3 + 1] = o[1]; this.Lclear[i * 3 + 2] = o[2];
      this.rr = (this.rr + 1) % n;
    }
    this._filled = true;
    /* 雲を見かけの模型で重ねる（SH・地平・ファサード） */
    for (let i = 0; i < n; i++) this._cloudy(i, wp, Tcl, D);
    /* SH（0.25s ごと・跳びで即）と空の照度 */
    const t = fin(input.envTime, 0);
    if (jumped || this._shT < 0 || t - this._shT >= 0.25 || t < this._shT) {
      this._shT = t;
      this._projectSH(E, kd, wp);
    }
    const up = this.skyUp;
    /* 雲の上の空（雲の環境光）：空の半球照度 / π × 0.75（雲の中では上の雲が遮る）+ 夜の底 */
    for (let k = 0; k < 3; k++) p.ambTop[k] = (Math.max(this.skyUp[k], upT[k]) / Math.PI) * 0.55 + NIGHT_FLOOR[k];
    for (let k = 0; k < 3; k++) p.ambBot[k] = ATMO.albedo * (E[k] * Math.max(kd[1], 0) + up[k]) / Math.PI;
    /* 媒質（core の ngApplyMedium）：Rayleigh・谷の霞（雨で 2 倍以上）・朝霧 */
    const bM = 3.5e-5 * (1 + 1.5 * cloud + 3.5 * rain);
    set4(F, NG.BETA_R, ATMO.betaR[0], ATMO.betaR[1], ATMO.betaR[2], ATMO.HR);
    set4(F, NG.BETA_M, bM, bM, bM, ATMO.HM);
    const night = clamp01(fin(input.nightAmount, smooth(0.08, -0.16, s[1])));
    set4(F, NG.KEY, kd[0], kd[1], kd[2], night);
    set4(F, NG.KEYRAD, E[0], E[1], E[2], s[1]);
    set4(F, NG.SUN, s[0], s[1], s[2], useSun ? 0 : gate);
    set4(F, NG.AMB, up[0] / Math.PI, up[1] / Math.PI, up[2] / Math.PI, cloud);
    /* 雲影と雲（24h 周期の円を回る） */
    const a = (h / 24) * Math.PI * 2;
    set4(F, NG.CLOUDSH, Math.cos(a) * CLOUD_R, Math.sin(a) * CLOUD_R, 1 / 900, wp.shadow);
    set4(F, NG.CLOUDS, wp.cover, wp.base, wp.top, a);
    /* 朝霧：4:30–8:00、5:45 に最大。雨上がり（濡れ）で濃い */
    const dawn = smooth(4.5, 5.75, h) * (1 - smooth(5.75, 8.0, h));
    const wetTarget = rain > 0.1 ? 1 : 0;
    this.wet += (wetTarget - this.wet) * (1 - Math.exp(-dt / (wetTarget > this.wet ? 10 : 60)));
    this.puddle += (this.wet - this.puddle) * (1 - Math.exp(-dt / (this.wet > this.puddle ? 25 : 120)));
    if (!Number.isFinite(this.wet)) this.wet = 0;
    if (!Number.isFinite(this.puddle)) this.puddle = 0;
    set4(F, NG.MIST, 0.012 * dawn * (1 + this.wet) * (1 - 0.7 * rain), 0, 5, MIE_G_MEDIUM);
    set4(F, NG.WEATHER, this.wet, rain, this.puddle * 0.8, 0.42);
    /* 地平線の整合：8 方位の空の地平（雲込み）に 3km 先の霞の漸近値を合わせる */
    const cam = input.camera?.position || { x: 0, y: 2, z: 0 };
    let hi = 0;
    const base = SH_N * 3;
    const Ain = solveInscatterAmb(F, cam, () => { const j = base + (hi++ % HZ_N) * 3; return [this.Lsky[j], this.Lsky[j + 1], this.Lsky[j + 2]]; });
    set4(F, NG.INSC, Ain[0], Ain[1], Ain[2], 0.02 * (up[1] + E[1]));
    /* 結果 */
    const out = this.out;
    out.jumped = jumped; out.wp = wp;
    out.keyDir = kd;
    out.keyE = E;
    const lk = ngLuminance(E[0], E[1], E[2]);
    out.keyIntensity = lk;
    out.keyColor = lk > 1e-7 ? [E[0] / lk, E[1] / lk, E[2] / lk] : [1, 1, 1];
    out.exposure = ngScheduledExposure(Math.asin(clampN(s[1])) * 180 / Math.PI, cloud, rain);
    out.zenith = this.sampleSky(0, 1, 0);
    const hz = [0, 0, 0];
    for (let i = 0; i < HZ_N; i++) for (let k = 0; k < 3; k++) hz[k] += this.Lsky[base + i * 3 + k] / HZ_N;
    out.horizon = hz;
    const omegaSun = 6.8e-5;
    for (let k = 0; k < 3; k++) out.sunDisk[k] = this.Etop * this.sunCol[k] * smooth(-0.02, 0.0, s[1]) / omegaSun;
    /* 月の円盤は «見た目の» 値：露出 22 で AgX の肩に海が残る明るさ（照度としての月は key が持つ） */
    const mv = smooth(-0.02, 0.0, -s[1]);
    for (let k = 0; k < 3; k++) out.moonDisk[k] = 0.22 * this.sunCol[k] * mv * (k === 2 ? 0.96 : 1);
    /* 星（0 等星の照度 ≈ 月の 8e-6）・天の川（晴れの夜だけ、満月の明かりで半分） */
    out.stars = 8e-6 * NG_UNITS.MOON * 6.0;    // 満月でも星が見える «絵の» 明るさ（物理の 6 倍）
    out.milky = NIGHT_FLOOR[1] * 1.4 * (1 - smooth(0.3, 0.75, cloud)) * 0.5;
    out.night = night;
    return out;
  }

  /* 大気の表の入れ替え（2 つの AtmosphereCPU を交互に） */
  _haze2(target, jump) {
    const A = this.A;
    if (jump) {
      this.gen = null;
      if (Math.abs(target - A.haze) > 1e-3 * A.haze) { A.setHaze(target, true); return true; }
      return false;
    }
    if (!this.gen && Math.abs(target - A.haze) > 0.02 * A.haze) { this.gen = this.B.build(target); this.genHaze = target; }
    if (this.gen) {
      const t0 = now();
      while (now() - t0 < 0.6) {
        if (this.gen.next().done) {
          this.gen = null;
          const b = this.B; this.B = this.A; this.A = b;
          this.A.deck = this.B.deck;
          return true;
        }
      }
    }
    return false;
  }

  /* i 番目の方向の空（雲込み）= 晴れの空と雲の見かけの模型の混ぜ */
  _cloudy(i, wp, Tcl, D) {
    const d = this.dirs[i], j = i * 3, Lc = this.Lclear;
    if (d[1] <= 0 || wp.cover <= 0.002) { this.Lsky[j] = Lc[j]; this.Lsky[j + 1] = Lc[j + 1]; this.Lsky[j + 2] = Lc[j + 2]; return; }
    const p = this.p, y = Math.max(d[1], 0.06);
    const ce = 1 - Math.pow(1 - Math.min(wp.cover, 0.999), 1 / Math.pow(y, 0.6));
    const mu = d[0] * p.light[0] + d[1] * p.light[1] + d[2] * p.light[2];
    const w = (1 - wp.strat) * (0.35 + 0.65 * (1 - d[1]));
    const side = (0.16 + 0.85 * phaseHG(mu, 0.55)) * 0.32;
    const fh = 0.75 * (1 - smooth(0.0, 0.2, d[1]));
    const belly = 1 - 0.45 * wp.belly;
    for (let k = 0; k < 3; k++) {
      const Ecl = p.lightE[k] * Tcl[k];
      let c = Ecl * ((D / Math.PI) * (1 - w) * belly + w * side) + p.ambTop[k] * 0.35;
      c += (Lc[j + k] - c) * fh;
      this.Lsky[j + k] = Lc[j + k] + (c - Lc[j + k]) * ce;
    }
  }

  /* 128 方向の空（雲込み）+ 地面の照り返し（0.12）を SH L2 に。注視点の樹冠で上半球を遮り、葉を透けた緑を足す。水中は水の光で上書き */
  _projectSH(E, kd, wp) {
    const sh = this.sh, b = this._b, w = (4 * Math.PI) / SH_N;
    sh.fill(0);
    const up = [0, 0, 0];
    for (let i = 0; i < SH_N; i++) {
      const d = this.dirs[i];
      if (d[1] <= 0) continue;
      for (let k = 0; k < 3; k++) up[k] += this.Lsky[i * 3 + k] * d[1] * w;
    }
    for (let k = 0; k < 3; k++) up[k] += NIGHT_FLOOR[k] * Math.PI;
    this.skyUp = up;
    const ky = Math.max(kd[1], 0);
    const g = [0, 1, 2].map((k) => ATMO.albedo * (E[k] * ky + up[k]) / Math.PI);
    const cn = clamp01(this.canopy);
    const leaf = [0.05, 0.11, 0.03];
    const uw = smooth(0.3, 0.7, this.uw), wi = this.uwInsc;
    const L = [0, 0, 0];
    for (let i = 0; i < SH_N; i++) {
      const d = this.dirs[i];
      for (let k = 0; k < 3; k++) {
        let v = d[1] > 0 ? this.Lsky[i * 3 + k] + NIGHT_FLOOR[k] : g[k];
        if (d[1] > 0 && cn > 0) v = v * (1 - 0.8 * cn * d[1]) + cn * d[1] * leaf[k] * E[k] / Math.PI;
        if (uw > 0 && wi) v += (wi[k] * (0.55 + 0.9 * Math.max(d[1], 0)) - v) * uw;
        L[k] = v;
      }
      shBasis(d[0], d[1], d[2], b);
      for (let c = 0; c < 9; c++) { sh[c * 3] += L[0] * b[c] * w; sh[c * 3 + 1] += L[1] * b[c] * w; sh[c * 3 + 2] += L[2] * b[c] * w; }
    }
  }

  /**
   * 空の放射輝度（CPU 双子、雲込み、露出前の ng 単位）。最寄りの方向の値を重みで混ぜる（16 近傍）
   * @returns {number[]}
   */
  sampleSky(x, y, z) {
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const out = [0, 0, 0];
    let ws = 0;
    for (let i = 0; i < SH_N; i++) {
      const d = this.dirs[i];
      const c = d[0] * x + d[1] * y + d[2] * z;
      if (c < 0.80) continue;
      const wgt = Math.pow((c - 0.80) / 0.20, 4) + 1e-6;
      ws += wgt;
      for (let k = 0; k < 3; k++) out[k] += this.Lsky[i * 3 + k] * wgt;
    }
    if (ws <= 0) return [this.skyUp[0] / Math.PI, this.skyUp[1] / Math.PI, this.skyUp[2] / Math.PI];
    for (let k = 0; k < 3; k++) out[k] /= ws;
    return out;
  }
}

function fin(v, d) { return Number.isFinite(v) ? v : d; }
function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
function set4(F, slot, x, y, z, w) {
  F[slot * 4] = fin(x, 0); F[slot * 4 + 1] = fin(y, 0); F[slot * 4 + 2] = fin(z, 0); F[slot * 4 + 3] = fin(w, 0);
}
function clampN(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
function angDiff(a, b) { let d = a - b; d -= 24 * Math.round(d / 24); return d; }
