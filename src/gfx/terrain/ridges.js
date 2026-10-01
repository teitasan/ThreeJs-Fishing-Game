/* ===========================================================
   遠景の稜線（ARCHITECTURE §6.4）：高さ場（±512m）の縁から 2.75km まで
   -----------------------------------------------------------
   - 1 枚の極座標の帯（1024 方位 × 40 列）。内側の列は heightfield.heightAt（GPU の地形と同じ高さ）、
     560〜1100m で lake.heightAt の山の続きから «3 本の山並み»（1000 / 1650 / 2450m を中心に蛇行）へ移る。
     遠い山並みほど高く、手前の稜線の上に頭を出す → 空気遠近（core の媒質）で日本の青い層の山並み
   - 高さは CPU で 1 回（シードだけで決まる。Math.random なし）。法線は格子の中心差分
   - 地平の角（8 方位）を頂点に焼き、太陽が低いと山の陰が谷に落ちる（夕方の稜線の層を立たせる）
   - 素材：植林の暗い帯・広葉樹の明るい斑・尾根のアカマツ・急斜面の露岩。樹冠の凹凸は法線だけ
   純粋な JS の部分（ridgeHeight・buildRidgeArrays）は Node でテストできる
   =========================================================== */
import { hash01 } from '../../world/rng.js';
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';

export const RIDGE_R0 = 496;          // 地形の下へ潜り込ませる最初の列（地形は 508m で切れる）
export const RIDGE_CLIP = 508;
export const RIDGE_R1 = 2750;
export const RIDGE_SEG = 1024;
export const RIDGE_HORIZON_DIRS = 8;

/* 種つきの値ノイズ（2D、5 次補間） */
function vn(seed, x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash01(seed, ix, iy), b = hash01(seed, ix + 1, iy), c = hash01(seed, ix, iy + 1), d = hash01(seed, ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
/* 周期の 1D の尾根ノイズ（θ 方向に一周で閉じる）：period = 一周の格子数 */
function ridged1(seed, t, period, oct) {
  let s = 0, a = 0.5, n = 0, w = 1, p = period, x = t;
  for (let k = 0; k < oct; k++) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    const h0 = hash01(seed + k * 101, ((i % p) + p) % p, 7), h1 = hash01(seed + k * 101, (((i + 1) % p) + p) % p, 7);
    let r = 1 - Math.abs((h0 + (h1 - h0) * u) * 2 - 1);
    r = r * r * w;
    w = Math.min(1, Math.max(0, r * 1.7));
    s += a * r; n += a; a *= 0.5; x *= 2; p *= 2;
  }
  return s / n;
}
function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** 3 本の山並み：中心の半径 m、幅 m、頂の高さ m、尾根の周期（一周の山の数） */
export const RIDGE_RANGES = Object.freeze([
  { c: 1000, w: 300, h: 360, n: 22 },
  { c: 1650, w: 380, h: 640, n: 17 },
  { c: 2450, w: 520, h: 980, n: 13 },
]);

/**
 * 遠景の高さ（m）。極座標（r, θ）で。base(r, θ) は内側の地形の高さ（r < 1100m で効く）
 * @param {number} seed
 * @param {number} r
 * @param {number} th 0..2π
 * @param {number} base
 * @returns {number}
 */
export function ridgeHeight(seed, r, th, base) {
  const u = th / (Math.PI * 2);
  let m = 120 + 0.12 * (r - 500);
  for (let i = 0; i < RIDGE_RANGES.length; i++) {
    const R = RIDGE_RANGES[i];
    const wob = 160 * (vn(seed + 31 * i, u * 9, i * 3.1) - 0.5) + 90 * (vn(seed + 57 * i, u * 23, i) - 0.5);
    const rr = (r - R.c - wob) / R.w;
    const ridge = ridged1(seed + 13 * i, u * R.n, R.n, 4);
    const prof = Math.exp(-rr * rr * 1.6);
    m = Math.max(m, R.h * (0.42 + 0.58 * ridge) * prof + (110 + 0.1 * (R.c - 500)) * (1 - prof));
  }
  const det = 38 * (vn(seed + 999, r / 140, u * 160) - 0.5) + 16 * (vn(seed + 777, r / 55, u * 420) - 0.5);
  m += det * smooth(700, 1400, r);
  const k = smooth(560, 1100, r);
  return base + (m - base) * k;
}

/**
 * 帯の格子（列の半径・高さ・法線・地平の角）を作る
 * @param {{seed:number, baseAt:(x:number,z:number)=>number, innerAt:(x:number,z:number)=>number, seg?:number, rows?:number}} o
 *   baseAt = lake.heightAt（山の続き）、innerAt = heightfield.heightAt（地形と同じ補間。r ≤ 508）
 * @returns {{radii:Float32Array, pos:Float32Array, nrm:Float32Array, hor0:Float32Array, hor1:Float32Array, index:Uint32Array, seg:number, rows:number}}
 */
export function buildRidgeArrays(o) {
  const seg = o.seg || RIDGE_SEG;
  const radii = [RIDGE_R0, RIDGE_CLIP];
  let r = RIDGE_CLIP;
  while (r < RIDGE_R1) { r = Math.min(RIDGE_R1, r * 1.055 + 4); radii.push(r); }
  const rows = radii.length, W = seg + 1;
  const H = new Float32Array(rows * seg);
  for (let j = 0; j < rows; j++) {
    const rj = radii[j];
    for (let i = 0; i < seg; i++) {
      const th = (i / seg) * Math.PI * 2, x = Math.cos(th) * rj, z = Math.sin(th) * rj;
      let h;
      if (j <= 1) h = o.innerAt(Math.cos(th) * RIDGE_CLIP, Math.sin(th) * RIDGE_CLIP) - (j === 0 ? 2.5 : 0);
      else {
        const base = rj < 1150 ? o.baseAt(x, z) : 0;
        /* 地形の縁（508m）の高さから lake の山へ滑らかにつなぐ（縁では地形と同じ高さ） */
        const edge = o.innerAt(Math.cos(th) * RIDGE_CLIP, Math.sin(th) * RIDGE_CLIP);
        const b = edge + (base - edge) * smooth(RIDGE_CLIP, 640, rj);
        h = ridgeHeight(o.seed, rj, th, b);
      }
      H[j * seg + i] = h;
    }
  }
  const pos = new Float32Array(rows * W * 3), nrm = new Float32Array(rows * W * 3);
  const at = (j, i) => H[Math.min(rows - 1, Math.max(0, j)) * seg + (((i % seg) + seg) % seg)];
  for (let j = 0; j < rows; j++) {
    const rj = radii[j];
    const jr0 = Math.max(0, j - 1), jr1 = Math.min(rows - 1, j + 1);
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const v = j * W + i, h = at(j, i);
      pos[v * 3] = c * rj; pos[v * 3 + 1] = h; pos[v * 3 + 2] = s * rj;
      /* 中心差分：半径方向と接線方向の傾き → 世界の法線 */
      const dr = (at(jr1, i) - at(jr0, i)) / Math.max(radii[jr1] - radii[jr0], 1e-3);
      const dt = (at(j, i + 1) - at(j, i - 1)) / ((2 * Math.PI * 2 * rj) / seg);
      const gx = dr * c - dt * s, gz = dr * s + dt * c;
      const l = Math.hypot(gx, 1, gz);
      nrm[v * 3] = -gx / l; nrm[v * 3 + 1] = 1 / l; nrm[v * 3 + 2] = -gz / l;
    }
  }
  /* 地平の角（tan）：8 方位（+x から反時計回り 45° ずつ）へ、極座標の格子を引きながら進む */
  const hor0 = new Float32Array(rows * W * 4), hor1 = new Float32Array(rows * W * 4);
  const lookup = (x, z) => {
    const rr = Math.hypot(x, z);
    if (rr < RIDGE_CLIP) return o.innerAt(x, z);
    if (rr >= RIDGE_R1) return -1e4;
    let j = 1;
    while (j < rows - 1 && radii[j + 1] < rr) j++;
    const t = (rr - radii[j]) / Math.max(radii[j + 1] - radii[j], 1e-3);
    let a = Math.atan2(z, x); if (a < 0) a += Math.PI * 2;
    const fi = (a / (Math.PI * 2)) * seg, i0 = Math.floor(fi), fu = fi - i0;
    const h0 = at(j, i0) + (at(j, i0 + 1) - at(j, i0)) * fu, h1 = at(j + 1, i0) + (at(j + 1, i0 + 1) - at(j + 1, i0)) * fu;
    return h0 + (h1 - h0) * Math.min(1, Math.max(0, t));
  };
  const STEPS = 18;
  for (let j = 1; j < rows; j++) {
    for (let i = 0; i < seg; i++) {
      const v = j * W + i;
      const x0 = pos[v * 3], y0 = pos[v * 3 + 1], z0 = pos[v * 3 + 2];
      for (let d = 0; d < RIDGE_HORIZON_DIRS; d++) {
        const a = (d / RIDGE_HORIZON_DIRS) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
        let best = -0.3, step = 12;
        let tt = 0;
        for (let k = 0; k < STEPS; k++) {
          tt += step; step *= 1.32;
          const hh = lookup(x0 + dx * tt, z0 + dz * tt);
          const tn = (hh - y0) / tt;
          if (tn > best) best = tn;
        }
        (d < 4 ? hor0 : hor1)[v * 4 + (d & 3)] = best;
      }
    }
  }
  for (let j = 0; j < rows; j++) {               // 一周の継ぎ目（i = seg は i = 0 と同じ）と内側の列
    for (let k = 0; k < 4; k++) {
      hor0[(j * W + seg) * 4 + k] = hor0[(j * W) * 4 + k];
      hor1[(j * W + seg) * 4 + k] = hor1[(j * W) * 4 + k];
      if (j === 0) { hor0[k] = hor0[(W) * 4 + k]; hor1[k] = hor1[(W) * 4 + k]; }
    }
  }
  for (let i = 1; i <= seg; i++) for (let k = 0; k < 4; k++) { hor0[i * 4 + k] = hor0[(W + i) * 4 + k]; hor1[i * 4 + k] = hor1[(W + i) * 4 + k]; }
  const index = new Uint32Array((rows - 1) * seg * 6);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      /* 上から見て反時計回り（法線が上） */
      index[n++] = a; index[n++] = c; index[n++] = b;
      index[n++] = b; index[n++] = c; index[n++] = d;
    }
  }
  return { radii: Float32Array.from(radii), pos, nrm, hor0, hor1, index, seg, rows };
}

/* 素材：樹冠のまだら・露岩・地平の角による山の陰 */
export const RIDGE_VERT_PARS = /* glsl */ `
attribute vec4 aNgHor0;
attribute vec4 aNgHor1;
varying float ngRidgeSun;
`;
export const RIDGE_VERT_BEGIN = /* glsl */ `
{
  /* key の方位で 8 方位の地平の角を補間し、key の高度と比べる（半影 ≈ 2.5°） */
  vec3 kd = ngKeyDir;
  float az = atan(kd.z, kd.x);
  if (az < 0.0) az += 6.2831853;
  float fi = az / 0.78539816;
  int i0 = int(floor(fi)) & 7, i1 = (i0 + 1) & 7;
  float fu = fract(fi);
  float hs[8];
  hs[0] = aNgHor0.x; hs[1] = aNgHor0.y; hs[2] = aNgHor0.z; hs[3] = aNgHor0.w;
  hs[4] = aNgHor1.x; hs[5] = aNgHor1.y; hs[6] = aNgHor1.z; hs[7] = aNgHor1.w;
  float hz = mix(hs[i0], hs[i1], fu);
  float tk = kd.y / max(length(kd.xz), 1e-3);
  ngRidgeSun = smoothstep(hz - 0.03, hz + 0.03, tk);
}
`;
export const RIDGE_FRAG_PARS = NG_NOISE_GLSL + /* glsl */ `
varying float ngRidgeSun;
vec3 ngRidgeAlbedo(vec3 P, vec3 Nw) {
  vec2 xz = P.xz;
  float slope = sqrt(max(1.0 - Nw.y * Nw.y, 0.0)) / max(Nw.y, 0.05);
  float a = ngVNoise2(xz / 210.0), b = ngVNoise2(xz / 75.0 + 5.3), c = ngVNoise2(xz / 31.0 + 1.7);
  vec3 conifer = vec3(0.024, 0.040, 0.025), broad = vec3(0.050, 0.078, 0.030), pine = vec3(0.038, 0.050, 0.028);
  /* 植林の帯は谷筋から中腹に（斑の閾値を標高で動かす） */
  float plant = smoothstep(0.40, 0.50, a + 0.12 * (b - 0.5) - 0.0003 * (P.y - 250.0));
  vec3 col = mix(broad * (0.8 + 0.4 * c), conifer * (0.85 + 0.3 * c), plant);
  float ridgeTop = smoothstep(0.55, 0.75, b) * smoothstep(250.0, 600.0, P.y);
  col = mix(col, pine, ridgeTop * 0.6);
  /* 初夏の明るい新緑の斑（季節で） */
  col = mix(col, vec3(0.085, 0.125, 0.038), smoothstep(0.7, 0.85, c) * (1.0 - plant) * smoothstep(0.3, 0.5, ngSeason));
  float rock = smoothstep(0.85, 1.25, slope + 0.35 * (c - 0.5)) + smoothstep(820.0, 1000.0, P.y + 120.0 * (b - 0.5)) * 0.5;
  col = mix(col, vec3(0.19, 0.185, 0.17) * (0.8 + 0.3 * b), clamp(rock, 0.0, 0.85));
  return col;
}
vec3 ngRidgeBump(vec3 P, vec3 Nw, float footprint) {
  /* 樹冠の凹凸：28m の値ノイズの勾配。画素が粗いほど弱める（ちらつき防止） */
  vec3 g = ngVNoise2D(P.xz / 28.0);
  vec3 g2 = ngVNoise2D(P.xz / 9.0 + 3.1);
  float k = 1.0 - smoothstep(4.0, 20.0, footprint);
  float k2 = 1.0 - smoothstep(1.5, 7.0, footprint);
  vec2 d = g.yz * 0.55 * k + g2.yz * 0.35 * k2;
  return normalize(Nw - vec3(d.x, 0.0, d.y) * 0.9);
}
`;
export const RIDGE_FRAG_SURFACE = /* glsl */ `
diffuseColor.rgb = ngRidgeAlbedo( vNgWorld, normalize( inverseTransformDirection( normalize( vNormal ), viewMatrix ) ) );
`;
export const RIDGE_FRAG_NORMAL = /* glsl */ `
{
  vec3 ngNw = normalize( inverseTransformDirection( normal, viewMatrix ) );
  normal = normalize( ( viewMatrix * vec4( ngRidgeBump( vNgWorld, ngNw, length( fwidth( vNgWorld ) ) ), 0.0 ) ).xyz );
}
`;
/* key（平行光 0 番）の直達だけに山の陰を掛ける（空の光は残す） */
export const RIDGE_FRAG_LIGHTS = 'reflectedLight.directDiffuse *= ngRidgeSun; reflectedLight.directSpecular *= ngRidgeSun;';
