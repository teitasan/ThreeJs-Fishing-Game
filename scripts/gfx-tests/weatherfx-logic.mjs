/* weatherfx の純関数の検査（src/gfx/weatherfx/logic.js・quality.js、three 無し）
   - rainDrop：時刻と粒の乱数だけの純関数（同じ入力で同じ値）、カメラ中心の箱の中、下へ落ち続ける（折り返しを除く）、
     カメラが動いても世界に留まる（箱の中にいる限り位置が変わらない）、半分は内側の円柱
   - 蛍：初夏の晴れた夜だけ（昼・雨・曇り・冬は 0）、明滅は周期の 2 割ほど光る
   - 塵：低い太陽・晴れだけ
   - 水面の衝撃：決定的、半径の中、振幅の範囲、1 秒あたりの数は雨に比例
   - 品質表：段で単調、上限は high */
import assert from 'node:assert/strict';
import { RAIN, rainDrop, fireflyActivity, motesActivity, impulseRate, impulseAt, hash, fireflyBlink } from '../../src/gfx/weatherfx/logic.js';
import { WFX_TIERS, WFX_MAX, wfxTier } from '../../src/gfx/weatherfx/quality.js';
import { mulberry32 } from '../../src/world/rng.js';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

/* ---- 雨粒 ---- */
const rnd = mulberry32(7);
const seeds = Array.from({ length: 400 }, () => [rnd(), rnd(), rnd(), rnd()]);
const cam = { x: 12.5, y: 2.75, z: -80 }, wind = { x: 0.8, z: -0.3 };
let near = 0;
for (const s of seeds) {
  const a = rainDrop(s, 13.37, cam, wind), b = rainDrop(s, 13.37, cam, wind);
  ok(a.x === b.x && a.y === b.y && a.z === b.z, '雨粒は純関数');
  ok(Math.abs(a.x - cam.x) <= a.R + 1e-9 && Math.abs(a.z - cam.z) <= a.R + 1e-9, '雨粒は箱の中（xz）');
  ok(a.y >= cam.y - RAIN.below - 1e-9 && a.y <= cam.y - RAIN.below + RAIN.H + 1e-9, '雨粒は箱の中（y）');
  ok(a.v >= RAIN.vMin && a.v <= RAIN.vMin + RAIN.vSpan, '落ちる速さの範囲');
  if (a.R === RAIN.RN) near++;
  /* 短い時間では下へ v·dt だけ落ちる（折り返しの瞬間を除く） */
  const c = rainDrop(s, 13.37 + 0.01, cam, wind);
  if (Math.abs(c.y - a.y) < RAIN.H / 2) ok(Math.abs((a.y - c.y) - a.v * 0.01) < 1e-6, '雨粒は v で落ちる');
  /* カメラを少し動かしても（箱の縁から遠い粒は）世界の位置が同じ */
  const cam2 = { x: cam.x + 0.4, y: cam.y, z: cam.z - 0.3 };
  const d = rainDrop(s, 13.37, cam2, wind);
  const inner = Math.abs(a.x - cam.x) < a.R - 1 && Math.abs(a.z - cam.z) < a.R - 1 && a.y - (cam.y - RAIN.below) > 1 && a.y - (cam.y - RAIN.below) < RAIN.H - 1;
  if (inner) ok(Math.abs(d.x - a.x) < 1e-9 && Math.abs(d.z - a.z) < 1e-9 && Math.abs(d.y - a.y) < 1e-9, 'カメラが動いても雨粒は世界に留まる');
}
ok(near > 400 * 0.4 && near < 400 * 0.6, `内側の円柱は約半分（${near}/400）`);

/* ---- 蛍 ---- */
const night = { night: 1, rain: 0, cloud: 0.1, season: 0.42 };
ok(fireflyActivity({ ...night, hour: 22 }) > 0.99, '初夏の晴れた 22 時は蛍');
ok(fireflyActivity({ ...night, hour: 0.5 }) > 0.5, '0:30 はまだ蛍');
ok(fireflyActivity({ ...night, hour: 12, night: 0 }) === 0, '昼は蛍なし');
ok(fireflyActivity({ ...night, hour: 3 }) === 0, '3 時は蛍なし');
ok(fireflyActivity({ ...night, hour: 22, rain: 0.5 }) === 0, '雨は蛍なし');
ok(fireflyActivity({ ...night, hour: 22, cloud: 0.95 }) === 0, '厚い曇りは蛍なし');
ok(fireflyActivity({ ...night, hour: 22, season: 0.8 }) === 0, '季節の外は蛍なし');
ok(fireflyActivity({ night: NaN, rain: NaN, cloud: NaN, season: NaN, hour: NaN }) === 0, 'NaN でも 0');
let lit = 0;
for (let i = 0; i < 1000; i++) lit += fireflyBlink(i * 0.0137, 3, 0.2) > 0.5 ? 1 : 0;
ok(lit > 60 && lit < 260, `蛍は周期の 1–2 割ほど光る（${lit}/1000）`);

/* ---- 塵 ---- */
ok(motesActivity({ sinSunAlt: 0.2, rain: 0, cloud: 0 }) > 0.99, '低い太陽・晴れは塵');
ok(motesActivity({ sinSunAlt: 0.9, rain: 0, cloud: 0 }) === 0, '真昼は塵なし');
ok(motesActivity({ sinSunAlt: -0.1, rain: 0, cloud: 0 }) === 0, '夜は塵なし');
ok(motesActivity({ sinSunAlt: 0.2, rain: 0.5, cloud: 0 }) === 0, '雨は塵なし');

/* ---- 水面の衝撃 ---- */
ok(impulseRate(0.85, 240) === 0.85 * 240 && impulseRate(-1, 240) === 0, '衝撃の数は雨に比例');
for (let k = 0; k < 200; k++) {
  const p = impulseAt(123, 777, k, 10, -20, 18), q = impulseAt(123, 777, k, 10, -20, 18);
  ok(p.x === q.x && p.z === q.z && p.amp === q.amp, '衝撃は決定的');
  ok(Math.hypot(p.x - 10, p.z + 20) <= 18 + 1e-9, '衝撃は半径の中');
  ok(p.amp >= 0.0016 && p.amp <= 0.004, '衝撃の振幅の範囲');
}
let hs = 0;
for (let i = 0; i < 5000; i++) { const h = hash(1, i, 3); ok(h >= 0 && h < 1, 'hash は [0,1)'); hs += h; }
ok(Math.abs(hs / 5000 - 0.5) < 0.02, 'hash の平均 ≈ 0.5');

/* ---- 品質表 ---- */
const keys = ['streaks', 'splashes', 'haze', 'impulses', 'mist', 'fireflies', 'motes'];
for (const k of keys) {
  ok(WFX_TIERS.low[k] <= WFX_TIERS.mid[k] && WFX_TIERS.mid[k] <= WFX_TIERS.high[k], `段で単調（${k}）`);
  ok(WFX_MAX[k] === WFX_TIERS.high[k], `上限 = high（${k}）`);
}
ok(WFX_TIERS.high.streaks === 12000 && WFX_TIERS.mid.streaks === 6000 && WFX_TIERS.low.streaks === 2500, '雨の筋 12k / 6k / 2.5k（§6.9）');
ok(WFX_TIERS.high.mist === 60 && WFX_TIERS.mid.mist === 32 && WFX_TIERS.low.mist === 16, '霧の板 60 / 32 / 16（§6.9）');
ok(wfxTier('nope') === WFX_TIERS.mid, '知らない段は mid');

console.log(`weatherfx-logic: ${n} 件合格`);
