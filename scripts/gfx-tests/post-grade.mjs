#!/usr/bin/env node
/* ===========================================================
   post-grade：post の純関数（three 無し）
   - 順応：±1EV（夜 +1.2EV）にクランプ、基準の明るさで 1、NaN で 1、dt = 0 で止まる、上げ τ1.2s / 下げ τ0.6s
   - 黒体・ホワイトバランス：輝度 1、2200K は暖色、ずらし 0 は恒等
   - グレード：彩度 1.0–1.12、プルキニエは夜だけ、全高度で有限
   - AgX：24 パッチ × ±4EV で単調・有限、18% グレーは中間、+4EV の白でも飽和しない（太陽の縁が切れない）
   - 光芒の門：画面外・水中・高い太陽で 0
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const G = await imp('src/gfx/post/grade.js');
const { postTier, POST_TIERS } = await imp('src/gfx/post/quality.js');
const { hsTier } = await imp('src/gfx/hardscape/quality.js');
const near = (a, b, e) => Math.abs(a - b) <= e;
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/* ---- 順応 ---- */
const kd = Math.log2(G.NG_ADAPT_KEY.day), kn = Math.log2(G.NG_ADAPT_KEY.night);
check(near(G.ngAdaptTarget(kd, 1, 0), 1, 1e-9), '昼の基準の明るさで順応 1');
check(near(G.ngAdaptTarget(kn, 1, 1), 1, 1e-9), '夜の基準の明るさで順応 1');
check(near(Math.log2(G.ngAdaptTarget(kd - 20, 1, 0)), 1, 1e-9), '昼の暗い景色は +1EV まで');
check(near(Math.log2(G.ngAdaptTarget(kn - 20, 1, 1)), 1.2, 1e-9), '夜は +1.2EV まで');
check(near(Math.log2(G.ngAdaptTarget(kd + 20, 1, 0)), -1, 1e-9), '明るい景色は −1EV まで');
check(G.ngAdaptTarget(NaN, 1, 0) === 1 && G.ngAdaptTarget(kd, 0, 0) === 1 && G.ngAdaptTarget(Infinity, 1, 0) === 1, 'NaN / 0 の順応で 1');
/* 掛かっていた順応を外して測る：同じ景色なら usedAdapt に依らず同じ目標（発振しない） */
{
  const scene = kd - 1.3;
  const a = G.ngAdaptTarget(scene, 1, 0), b = G.ngAdaptTarget(scene + Math.log2(1.6), 1.6, 0);
  check(near(a, b, 1e-9), `順応の目標が usedAdapt に依らない ${a} ${b}`);
}
check(G.ngAdaptStep(1.5, 0.5, 0) === 1.5 && G.ngAdaptStep(1.5, 0.5, -1) === 1.5, 'dt = 0（ポーズ）で順応が止まる');
check(G.ngAdaptStep(0, 2, 0.016) === 1 && G.ngAdaptStep(NaN, 2, 0.016) === 1, '壊れた順応は 1 に戻る');
{
  /* 上げ：τ1.2s → 1.2s で 63%、下げ：τ0.6s → 0.6s で 63%（対数で） */
  let u = 1, d = 1;
  for (let i = 0; i < 75; i++) { u = G.ngAdaptStep(u, 2, 1.2 / 75); d = G.ngAdaptStep(d, 0.5, 0.6 / 75); }
  check(near(Math.log2(u), 1 - Math.exp(-1), 0.01), `上げの τ ${Math.log2(u).toFixed(3)}`);
  check(near(-Math.log2(d), 1 - Math.exp(-1), 0.01), `下げの τ ${(-Math.log2(d)).toFixed(3)}`);
  /* 長い dt（タブ復帰）でも一気に飛ばない（0.25s で打ち切り） */
  const j = G.ngAdaptStep(1, 2, 10);
  check(Math.log2(j) < 0.2, `大きな dt で飛ばない ${j}`);
  /* 単調・行き過ぎない */
  let x = 0.5, prev = x, mono = true;
  for (let i = 0; i < 600; i++) { x = G.ngAdaptStep(x, 2, 1 / 60); if (x < prev - 1e-12 || x > 2 + 1e-9) mono = false; prev = x; }
  check(mono && near(x, 2, 0.01), `順応は単調に目標へ ${x}`);
}

/* ---- 黒体・WB ---- */
for (const K of [1800, 2200, 3200, 5000, 6500, 9000, 15000]) {
  const c = G.ngBlackbody(K);
  check(c.every(Number.isFinite) && near(lum(c), 1, 1e-6), `黒体 ${K}K の輝度 1`);
}
{
  const w = G.ngBlackbody(2200), n = G.ngBlackbody(6500), s = G.ngBlackbody(12000);
  check(w[0] > w[1] && w[1] > w[2] && w[2] < 0.35, `2200K は暖色 ${w.map((v) => v.toFixed(3))}`);
  check(Math.max(...n) / Math.min(...n) < 1.12, `6500K ≈ 白 ${n.map((v) => v.toFixed(3))}`);
  check(s[2] > s[0], '12000K は青い');
}
check(G.ngWhiteBalance(0).every((v) => v === 1) && G.ngWhiteBalance(NaN).every((v) => v === 1), 'WB のずらし 0 / NaN は恒等');
{
  const warm = G.ngWhiteBalance(300), cold = G.ngWhiteBalance(-800);
  check(near(lum(warm), 1, 1e-6) && near(lum(cold), 1, 1e-6), 'WB の輝度 1');
  check(warm[0] > 1 && warm[2] < 1 && cold[2] > 1 && cold[0] < 1, 'WB の向き（+ で暖かく、− で青く）');
  check(warm[0] < 1.12 && cold[2] < 1.4, `WB の幅が控えめ ${warm[0].toFixed(3)} ${cold[2].toFixed(3)}`);
}

/* ---- グレード ---- */
let finite = true, satOk = true;
for (let alt = -30; alt <= 80; alt += 0.5) {
  for (const cloud of [0, 1]) for (const rain of [0, 1]) for (const uw of [0, 1]) {
    const night = Math.max(0, Math.min(1, (-alt - 4) / 10));
    const g = G.ngGradeParams({ sunAltDeg: alt, night, cloud, rain, uw });
    const all = [g.dK, ...g.wb, g.sat, g.purkinje, ...g.lift, g.gamma, ...g.gain, g.vignette, g.bloom];
    if (!all.every(Number.isFinite)) finite = false;
    if (g.sat < 1 || g.sat > 1.12) satOk = false;
  }
}
check(finite, 'グレードの値が全高度で有限');
check(satOk, '彩度 1.0–1.12');
{
  const day = G.ngGradeParams({ sunAltDeg: 50, night: 0 }), nt = G.ngGradeParams({ sunAltDeg: -25, night: 1 });
  const ntu = G.ngGradeParams({ sunAltDeg: -25, night: 1, uw: 1 }), gold = G.ngGradeParams({ sunAltDeg: 2, night: 0 });
  const blue = G.ngGradeParams({ sunAltDeg: -6, night: 0.2 });
  check(day.purkinje === 0 && nt.purkinje === 1 && ntu.purkinje === 0, 'プルキニエは夜の水上だけ');
  check(near(day.dK, 0, 1e-6) && gold.dK > 250 && blue.dK < -500, `WB：昼 0・夕 +300K・ブルーアワー −800K（${gold.dK.toFixed(0)} / ${blue.dK.toFixed(0)}）`);
  check(day.vignette === 0.12, 'ビネット 0.12');
  check(nt.bloom > day.bloom && day.bloom < 0.06, 'Bloom の強さ（夜はやや強く）');
}

/* ---- AgX：24 パッチ × ±4EV ---- */
const PATCHES = [
  [0.400, 0.350, 0.336], [0.392, 0.231, 0.168], [0.101, 0.135, 0.212], [0.118, 0.161, 0.077],
  [0.127, 0.145, 0.233], [0.150, 0.323, 0.251], [0.505, 0.251, 0.065], [0.090, 0.110, 0.299],
  [0.440, 0.120, 0.135], [0.098, 0.050, 0.121], [0.359, 0.422, 0.075], [0.497, 0.352, 0.051],
  [0.044, 0.053, 0.214], [0.087, 0.235, 0.087], [0.333, 0.050, 0.051], [0.596, 0.528, 0.044],
  [0.351, 0.118, 0.248], [0.031, 0.205, 0.290], [0.900, 0.900, 0.890], [0.590, 0.590, 0.590],
  [0.360, 0.360, 0.360], [0.190, 0.190, 0.190], [0.090, 0.090, 0.090], [0.031, 0.031, 0.031],
];
const neutral = G.ngGradeParams({ sunAltDeg: 50, night: 0 });
let agxOk = true, monoOk = true, worstClip = 0;
for (const p of PATCHES) {
  let prevL = -1;
  for (let ev = -4; ev <= 4; ev += 0.25) {
    const k = 2 ** ev, d = G.ngDisplay(p.map((v) => v * k), neutral);
    if (!d.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) agxOk = false;
    const L = lum(d);
    if (L < prevL - 1e-6) monoOk = false;
    prevL = L;
    if (ev <= 2) worstClip = Math.max(worstClip, ...d);
  }
}
check(agxOk, 'AgX：24 パッチ × ±4EV で有限・0..1');
check(monoOk, 'AgX：露出を上げると輝度が単調に上がる');
check(worstClip < 0.995, `AgX：+2EV までは 1.0 に張り付かない（最大 ${worstClip.toFixed(4)}）`);
{
  const grey = G.ngDisplay([0.18, 0.18, 0.18], neutral)[1];
  check(grey > 0.38 && grey < 0.55, `18% グレーは中間の sRGB ${grey.toFixed(3)}`);
  const black = G.ngDisplay([0, 0, 0], neutral)[1];
  check(black < 0.02, `黒は黒 ${black.toFixed(4)}`);
  /* 太陽の縁（露出後 16–200）：段差が無い（隣の 1/4EV の差が小さい） */
  let maxStep = 0, prev = null;
  for (let ev = 4; ev <= 8; ev += 0.25) { const d = lum(G.ngDisplay([2 ** ev, 2 ** ev * 0.95, 2 ** ev * 0.85], neutral)); if (prev != null) maxStep = Math.max(maxStep, Math.abs(d - prev)); prev = d; }
  check(maxStep < 0.03, `太陽の縁の階調に段差が無い（1/4EV の差の最大 ${maxStep.toFixed(4)}）`);
}

/* ---- 光芒の門 ---- */
check(G.ngShaftGate(10, 0, 0, true, 0) > 0.9, '低い太陽が画面の中なら光芒');
check(G.ngShaftGate(10, 0, 0, false, 0) === 0, '太陽が後ろなら 0');
check(G.ngShaftGate(10, 2, 0, true, 0) === 0, '画面の外（1.3 倍の外）なら 0');
check(G.ngShaftGate(10, 0, 0, true, 1) === 0, '水中なら 0');
check(G.ngShaftGate(40, 0, 0, true, 0) === 0, '高い太陽なら 0');
check(G.ngShaftGate(-5, 0, 0, true, 0) === 0, '沈んだ太陽なら 0');
check(G.ngShaftGate(NaN, 0, 0, true, 0) === 0, 'NaN なら 0');

/* ---- 品質表 ---- */
check(postTier('nope') === POST_TIERS.high && postTier('low').gtao === false && postTier('high').gtao === true, 'post の品質表（GTAO は high だけ）');
check(postTier('low').bloom === 0 && postTier('mid').bloom > 0 && postTier('high').bloom >= postTier('mid').bloom, 'Bloom の段数');
check(hsTier('low').moths < hsTier('high').moths && hsTier('low').lod0 < hsTier('high').lod0, 'hardscape の品質表');

done('post-grade');
