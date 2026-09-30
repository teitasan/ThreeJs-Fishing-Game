#!/usr/bin/env node
/* ===========================================================
   medium-twin（ARCHITECTURE §9-10 / §4.3）
   - 高さ指数の光学的厚さ：閉形式（ngAirOpticalDepth の JS 双子）と 1000 区間の数値積分の差 < 1%
     （地表付近・山・ほぼ水平・下り・朝霧の 5m のスケール高を含む無作為の 1000 本）
   - 空気の区間の透過 T が数値積分の exp(−∫σ) と一致、単一種の内散乱が数値の単一散乱積分と一致
   - 区間の規則（§3.4）：水上→水中は «空気 × 水 × 下向き光»、反射パスは全区間を空気
   - scene.fog の near < far、霞・朝霧が濃いほど far が短い（単調）
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const M = await imp('src/gfx/core/medium.js');
const { NG } = await imp('src/gfx/core/frame.js');

let s = 20260930;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };

/* 数値積分（中点、1000 区間）。丸めは閉形式と同じ y/H ≥ −20 */
function numeric(a, b, beta, H, n = 1000) {
  const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, y = a.y + (b.y - a.y) * t;
    acc += beta * Math.exp(-Math.max(y / H, -20));
  }
  return acc * L / n;
}
/* 定義域：空気の点は y ≥ −30m（湖底より上）。朝霧（H 5m）は基準 y より下を 0 に丸めて渡される */
let worst = 0;
for (let i = 0; i < 1000; i++) {
  const H = [8000, 1200, 5, 40][i % 4];
  const kind = i % 5;
  const floor = H === 5 ? 0 : -30;
  const a = { x: 0, y: kind === 4 ? floor + rnd() * 3 : floor + rnd() * 300, z: 0 };
  const horiz = 10 + rnd() * 4000;
  const by = kind === 2 ? a.y + (rnd() - 0.5) * 1e-3 : kind === 3 ? floor + rnd() * (a.y - floor) : a.y + rnd() * 1500;
  const b = { x: horiz, y: by, z: rnd() * 50 };
  const cf = M.airOpticalDepth(a, b, 1e-5, H), nm = numeric(a, b, 1e-5, H);
  const err = Math.abs(cf - nm) / Math.max(nm, 1e-12);
  worst = Math.max(worst, err);
}
check(worst < 0.01, `閉形式と数値積分の差 < 1%（最大 ${(worst * 100).toFixed(3)}%）`);
check(M.expDiv(1e-9) === 1 - 1e-9 * (0.5 - 1e-9 / 6) && Math.abs(M.expDiv(2) - (1 - Math.exp(-2)) / 2) < 1e-15, 'expDiv の級数と閉形式');

/* 典型の ngFrame（真昼・快晴） */
const F = new Float32Array(96);
const set = (slot, x, y, z, w) => { F[slot * 4] = x; F[slot * 4 + 1] = y; F[slot * 4 + 2] = z; F[slot * 4 + 3] = w; };
set(NG.KEY, 0, 0.947, 0.32, 0);
set(NG.KEYRAD, 3.0, 2.9, 2.5, 0.947);
set(NG.BETA_R, 5.8e-6, 13.5e-6, 33.1e-6, 8000);
set(NG.BETA_M, 4.2e-5, 4.2e-5, 4.2e-5, 1200);
set(NG.MIST, 0, 0, 5, 0.76);
set(NG.INSC, 0.05, 0.08, 0.14, 0);
set(NG.W_SIGMA, 0.20, 0.075, 0.045, 0.03);
set(NG.W_INSC, 0.02, 0.05, 0.06, 1);
set(NG.CAM, 0, 0, 0, 0);

/* 空気の区間：T と内散乱（βM = 0 の単一種は閉形式が厳密） */
{
  const G = Float32Array.from(F);
  G[NG.BETA_M * 4] = G[NG.BETA_M * 4 + 1] = G[NG.BETA_M * 4 + 2] = 0;
  const a = { x: 0, y: 2, z: 0 }, b = { x: 2500, y: 180, z: 900 };
  const { T, Lin } = M.airSegment(G, a, b);
  const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const v = [(b.x - a.x) / L, (b.y - a.y) / L, (b.z - a.z) / L];
  const mu = v[0] * G[0] + v[1] * G[1] + v[2] * G[2];
  const n = 4000;
  for (let c = 0; c < 3; c++) {
    const beta = G[NG.BETA_R * 4 + c];
    let od = 0, lin = 0;
    const src = G[NG.KEYRAD * 4 + c] * M.phaseR(mu) + G[NG.INSC * 4 + c];
    for (let i = 0; i < n; i++) {
      const y = a.y + (b.y - a.y) * (i + 0.5) / n;
      const sig = beta * Math.exp(-y / 8000) * L / n;
      lin += src * sig * Math.exp(-(od + sig * 0.5));
      od += sig;
    }
    check(Math.abs(T[c] - Math.exp(-od)) / Math.exp(-od) < 0.01, `空気の透過 c${c}`);
    check(Math.abs(Lin[c] - lin) / lin < 0.01, `単一種の内散乱 c${c}（${Lin[c].toExponential(3)} / ${lin.toExponential(3)}）`);
  }
}

/* 区間の規則（§3.4） */
{
  const C = { x: 0, y: 2, z: 0 }, P = { x: 10, y: -3, z: 0 };
  const r = M.mediumTerms(F, C, P);
  const t = 2 / 5, X = { x: 10 * t, y: 0, z: 0 };
  const a = M.airSegment(F, C, X), w = M.waterSegment(F, X, P), d = M.downwelling(F, 3);
  check([0, 1, 2].every((c) => Math.abs(r.T[c] - a.T[c] * w.T[c] * d[c]) < 1e-9), '水上 → 水中：T = 空気 × 水 × 下向き光');
  check([0, 1, 2].every((c) => Math.abs(r.Lin[c] - (w.Lin[c] * a.T[c] + a.Lin[c])) < 1e-9), '水上 → 水中：Lin = 水の Lin × 空気の T + 空気の Lin');
  const G = Float32Array.from(F); G[NG.CAM * 4 + 3] = 1;
  const rr = M.mediumTerms(G, C, P), aa = M.airSegment(G, C, P);
  check([0, 1, 2].every((c) => rr.T[c] === aa.T[c]), '反射パスは全区間を空気');
  const U = Float32Array.from(F); U[NG.CAM * 4] = 1;
  const Cu = { x: 0, y: -2, z: 0 }, Pa = { x: 0, y: 5, z: 30 };
  const ru = M.mediumTerms(U, Cu, Pa), au = M.airSegment(U, { x: 0, y: 0, z: 30 * (2 / 7) }, Pa);
  check([0, 1, 2].every((c) => Math.abs(ru.T[c] - au.T[c]) < 1e-9), '水中 → 水上：空気の区間だけ');
  const wv = M.waterSegment(F, { x: 0, y: -1, z: 0 }, { x: 0, y: -1, z: 26 });
  check(wv.T[0] < wv.T[1] && wv.T[1] < wv.T[2], '水は赤から先に消える（σa の順）');
}

/* scene.fog の near/far：単調 */
{
  const cam = { x: 0, y: 2, z: 0 };
  let prev = M.fogNearFar(F, cam);
  check(prev.near > 0 && prev.near < prev.far, `near < far（${prev.near.toFixed(1)} / ${prev.far.toFixed(1)}）`);
  let mono = true;
  for (const k of [2, 4, 8, 16]) {
    const G = Float32Array.from(F);
    for (let c = 0; c < 3; c++) G[NG.BETA_M * 4 + c] *= k;
    const r = M.fogNearFar(G, cam);
    if (!(r.far < prev.far && r.near < prev.near)) mono = false;
    prev = r;
  }
  check(mono, '霞が濃いほど near / far が短い');
  const G = Float32Array.from(F); G[NG.MIST * 4] = 0.012;
  check(M.fogNearFar(G, cam).far < M.fogNearFar(F, cam).far, '朝霧で far が短い');
  const U = Float32Array.from(F); U[NG.CAM * 4] = 1;
  check(M.fogNearFar(U, cam).far < 60, '水中は水の消散で far が短い');
}

done('medium-twin');
