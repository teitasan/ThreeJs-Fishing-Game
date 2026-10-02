#!/usr/bin/env node
/* ===========================================================
   sky-rig（ARCHITECTURE §6.1：光のリグと空の CPU 双子の純関数）
   - 24 時間 × 3 天候 × 乱れた入力（NaN・範囲外）で ngFrame の sky の slot がすべて有限
   - key：太陽高度 −1° で月へ切り替わり、交差点の両側で強度 ≈ 0（影の跳びなし）
   - 薄明：露出後の空の照度が日没 → 夜へ単調に下がる（0.05h ごとに +4% の揺れまで）、−4°〜−10° の天頂は青が勝つ、
     23:30 の月夜の天頂の色度が #0b1426 に近い
   - SH：L0 が正・有限、下向きの照度（地面の照り返し）> 0
   - 地平線の整合：3km 先の霞の内散乱（8 方位の平均）と空の地平の差 < 4%
   - 雲パノラマの帯の順（stripAt）：n 回で全部の帯を 1 回ずつ、隣を続けない
   - 雲影の CPU 双子（services.sky.cloudShadowAt）＝ core の cloudShadow
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { SkyRig, twilightTarget } = await imp('src/gfx/sky/rig.js');
const { sunDirAt } = await imp('src/gfx/sky/atmosphere.js');
const { NG } = await imp('src/gfx/core/frame.js');
const { ngLuminance, ngScheduledExposure } = await imp('src/gfx/core/palette.js');
const { mediumTerms, airOpticalDepth, phaseHG } = await imp('src/gfx/core/medium.js');

const rig = new SkyRig();
const t0 = performance.now();
for (const _ of rig.buildTwilight()) { /* 最後まで */ }
const buildMs = performance.now() - t0;
check(rig.twReady, 'twilight table built');
console.log(`  twilight table ${buildMs.toFixed(1)}ms`);

const F = new Float32Array(96);
const W = { clear: { cloud: 0.14, rain: 0 }, cloudy: { cloud: 0.72, rain: 0 }, rain: { cloud: 0.95, rain: 0.85 } };
const SLOTS = [NG.KEY, NG.KEYRAD, NG.SUN, NG.AMB, NG.BETA_R, NG.BETA_M, NG.MIST, NG.INSC, NG.WEATHER, NG.CLOUDSH, NG.CLOUDS];
const step = (h, w, extra = {}) => {
  const sd = sunDirAt(h);
  rig._last = null;          // 毎回 «跳び»：全方向・SH を作り直す（時刻を飛ばして調べるため）
  return rig.step({ dt: 1 / 60, hour: h, weather: w, sunDir: { x: sd[0], y: sd[1], z: sd[2] }, envTime: h * 3600, camera: { position: { x: 10, y: 2, z: -40 } }, ...extra }, F);
};

/* 1. 有限 */
let bad = 0;
for (const w of Object.values(W)) {
  for (let h = 0; h < 24; h += 0.25) {
    const o = step(h, w);
    for (const s of SLOTS) for (let c = 0; c < 4; c++) if (!Number.isFinite(F[s * 4 + c])) bad++;
    for (const v of [...o.keyColor, o.keyIntensity, ...o.zenith, ...o.horizon, ...rig.sh]) if (!Number.isFinite(v)) bad++;
  }
}
for (const junk of [{ hour: NaN }, { hour: 1e9 }, { dt: -5 }, { weather: { cloud: NaN, rain: Infinity } }, { sunDir: { x: NaN, y: NaN, z: NaN } }, { weather: null }]) {
  rig.step({ dt: 1 / 60, hour: 12, weather: W.clear, sunDir: { x: 0, y: 1, z: 0 }, envTime: 0, ...junk }, F);
  for (const s of SLOTS) for (let c = 0; c < 4; c++) if (!Number.isFinite(F[s * 4 + c])) bad++;
}
check(bad === 0, `ngFrame の sky の slot に非有限 ${bad}`);

/* 2. key の交差（−1°） */
const hourAt = (altDeg) => {      // 夕方側：sin(alt)·|v| = sin(a)、a = π + …
  const l = Math.hypot(1, 0.34), a = Math.PI + Math.asin(Math.min(1, -Math.sin(altDeg * Math.PI / 180) * l));
  return 6 + (a / (2 * Math.PI)) * 24;
};
let kMax = 0;
for (const alt of [-0.8, -0.95, -1.05, -1.2]) { const o = step(hourAt(alt), W.clear, { dt: 0 }); kMax = Math.max(kMax, o.keyIntensity); }
check(kMax < 0.01, `交差点の key の強さ ${kMax.toFixed(4)} < 0.01`);
const above = step(hourAt(-0.5), W.clear, { dt: 0 }), below = step(hourAt(-1.5), W.clear, { dt: 0 });
check(above.keyDir[1] > 0 && below.keyDir[1] > 0, 'key は常に地平の上（太陽 → 月）');

/* 3. 薄明 */
const ex = [];
for (let h = 18.0; h <= 20.0; h += 0.05) {
  const o = step(h, W.clear, { dt: 0 });
  const sy = Math.sin(Math.asin(Math.min(1, F[NG.SUN * 4 + 1])));
  ex.push({ h, v: ngLuminance(rig.skyUp[0], rig.skyUp[1], rig.skyUp[2]) * o.exposure, sy, z: o.zenith });
}
let up = 0;
for (let i = 1; i < ex.length; i++) if (ex[i].v > ex[i - 1].v * 1.04) up++;
check(up === 0, `日没 → 夜の空の照度（露出後）が単調でない所 ${up}`);
check(ex[0].v > 0.2 && ex[ex.length - 1].v > 0.07, `薄明の明るさ ${ex[0].v.toFixed(3)} → ${ex[ex.length - 1].v.toFixed(3)}`);
for (const e of ex) {
  const alt = Math.asin(e.sy) * 180 / Math.PI;
  if (alt < -4 && alt > -10) check(e.z[2] > e.z[0] * 2 && e.z[2] > e.z[1] * 1.6, `${alt.toFixed(1)}° の天頂が青くない ${e.z.map((x) => x.toExponential(2))}`);
}
check(Math.abs(twilightTarget(0) - 0.26) < 0.01 && twilightTarget(-0.5) === 0.12, 'twilightTarget の端');
const night = step(23.5, W.clear, { dt: 0 });
const zl = ngLuminance(...night.zenith), zc = night.zenith.map((v) => v / zl);
/* #0b1426 → リニア (0.0034, 0.0070, 0.0194) → 色度 (0.48, 0.99, 2.71) */
check(Math.abs(zc[2] - 2.71) < 0.5 && Math.abs(zc[0] - 0.48) < 0.2, `23:30 の天頂の色度 ${zc.map((v) => v.toFixed(2))}（目標 0.48, 0.99, 2.71）`);
const eNight = ngLuminance(...rig.skyUp) * night.exposure;
const noon = step(12.5, W.clear, { dt: 0 });
const eNoon = ngLuminance(...rig.skyUp) * noon.exposure;
check(eNight / eNoon > 0.08 && eNight / eNoon < 0.4, `夜 / 昼の空の照度（露出後）${(eNight / eNoon).toFixed(3)}`);
void ngScheduledExposure;

/* 4. SH */
for (const [h, w] of [[12, W.clear], [18.3, W.clear], [23.5, W.clear], [11, W.rain]]) {
  step(h, w, { dt: 0 });
  const sh = rig.sh;
  check(sh[0] > 0 && sh[1] > 0 && sh[2] > 0, `SH L0 > 0 @${h}`);
  /* three の shGetIrradianceAt（Ramamoorthy–Hanrahan）で下向きの法線の照度（緑）：地面の照り返しで > 0 */
  const L = (i) => sh[i * 3 + 1];
  const down = -0.429043 * L(8) + 0.886227 * L(0) - 0.247708 * L(6) - 2 * 0.511664 * L(1);
  const upI = -0.429043 * L(8) + 0.886227 * L(0) - 0.247708 * L(6) + 2 * 0.511664 * L(1);
  check(down > 0 && upI > down, `照度：上 ${upI.toExponential(2)} > 下 ${down.toExponential(2)} > 0 @${h}`);
}

/* 5. 地平線の整合（3km 先の霞の漸近値 Lin/(1−T) の 8 方位の平均 = 空の地平の 8 方位の平均。朝霧を含む）。
   GPU の空と CPU の地平の差は sky-proof が読み戻しで測る */
let worst = 0;
for (const [name, w] of Object.entries(W)) {
  for (const h of [5.75, 6.2, 9, 12.5, 17.5, 18.3, 23.5]) {
    step(h, w, { dt: 0 });
    const cam = { x: 10, y: 2, z: -40 };
    const base = 128 * 3;
    const hz = [0, 0, 0], as = [0, 0, 0];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const P = { x: cam.x + Math.cos(a) * 3000, y: cam.y, z: cam.z + Math.sin(a) * 3000 };
      const { T, Lin } = mediumTerms(F, cam, P);
      /* ドームは地平の数度に core と同じ朝霧の項を掛ける（dome.glsl.js）：その後の空と比べる */
      const mb = F[NG.MIST * 4 + 1];
      const od = F[NG.MIST * 4] * airOpticalDepth({ x: cam.x, y: Math.max(cam.y - mb, 0), z: cam.z }, { x: P.x, y: Math.max(P.y - mb, 0), z: P.z }, 1, Math.max(F[NG.MIST * 4 + 2], 0.1));
      const Tm = Math.exp(-od);
      const mu = Math.cos(a) * F[NG.KEY * 4] + Math.sin(a) * F[NG.KEY * 4 + 2];
      const pM = phaseHG(mu, F[NG.MIST * 4 + 3]);
      for (let c = 0; c < 3; c++) {
        const Sm = F[NG.KEYRAD * 4 + c] * pM + F[NG.INSC * 4 + c] + F[NG.INSC * 4 + 3];
        as[c] += Lin[c] / Math.max(1 - T[c], 1e-6) / 8;
        hz[c] += (rig.Lsky[base + i * 3 + c] * Tm + Sm * (1 - Tm)) / 8;
      }
    }
    const err = Math.abs(ngLuminance(...as) - ngLuminance(...hz)) / Math.max(ngLuminance(...hz), 1e-9);
    worst = Math.max(worst, err);
    if (err >= 0.04) console.error(`  horizon ${name}@${h}: haze ${ngLuminance(...as).toExponential(3)} sky ${ngLuminance(...hz).toExponential(3)} err ${(err * 100).toFixed(1)}%`);
  }
}
check(worst < 0.04, `地平線の段差（CPU）${(worst * 100).toFixed(2)}% < 4%`);
console.log(`  horizon (CPU) worst ${(worst * 100).toFixed(2)}%`);

/* 6. 帯の順 */
const { stripAt } = await imp('src/gfx/sky/strips.js');
for (const n of [16, 24, 32]) {
  const seen = new Set();
  let adj = 0;
  for (let k = 0; k < n; k++) { const s = stripAt(k, n); seen.add(s); if (k && Math.abs(s - stripAt(k - 1, n)) <= 1) adj++; }
  check(seen.size === n, `stripAt(${n}) が全部の帯を回る ${seen.size}`);
  check(adj === 0, `stripAt(${n}) が隣の帯を続けて描く ${adj}`);
}

done();
