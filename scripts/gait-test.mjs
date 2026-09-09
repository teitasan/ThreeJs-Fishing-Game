#!/usr/bin/env node
/* ===========================================================
   足取り（歩き／走り）の目盛りの検査

   直したのは «歩いている間ずっと 4 割は立っている» という取り違え。
   ゲームが渡してくる moving は «どちらの足取りか»（歩き 0.6 / 走り 1.0）
   なのに、それをそのまま «動いている度合い» として使っていた。

   その結果こうなっていた（実ゲームで実測）:
     - 釣りの構えのクリップが歩行中も 0.4 の重みで残る
     - 竿を正面へ向けるための体の回転が 0.4 ぶん残り、正面へ進みながら
       28 度斜めを向く
     - 走りへ切り替わる目盛り（0.62）を歩きの 0.6 が下回るぶんは正しいが、
       他プレイヤーは速さをそのまま 0..1 に潰していたので常に走りだった
   =========================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  GAIT_WALK, WALK_SPEED, RUN_SPEED, moveAmountOf, gaitOfSpeed, speedOfGait,
} from '../src/gait.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');
let bad = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  NG: ' + msg); bad++; } };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}（${a} と ${b} の差 ${Math.abs(a - b)} > ${eps}）`);

/* --- 1. 歩いていれば «立っている» は 0 --- */
near(moveAmountOf(GAIT_WALK), 1, 1e-9, '歩きの足取りで «動いている度合い» が 1 にならない');
near(moveAmountOf(1), 1, 1e-9, '走りの足取りで «動いている度合い» が 1 にならない');
near(moveAmountOf(0), 0, 1e-9, '止まっているのに動いていることになっている');
const standWalk = 1 - moveAmountOf(GAIT_WALK);
near(standWalk, 0, 1e-9, '歩行中に «立っている» ぶんが残っている');
console.log(`歩行中の «立っている» ぶん: ${standWalk.toFixed(3)}`
  + `（取り違えていたときは ${(1 - GAIT_WALK).toFixed(1)}）`);

/* --- 2. その «立っている» ぶんが体の回転に化けていたことを示す --- */
const src = read('src/angler.js');
const yawDeg = 70;   // 実測（釣りモーション: 竿の水平の向き -70度）
console.log(`体の回転に残っていた角度: ${(yawDeg * standWalk).toFixed(1)}度`
  + `（取り違えていたときは ${(yawDeg * (1 - GAIT_WALK)).toFixed(0)}度）`);
ok(yawDeg * (1 - GAIT_WALK) > 20, '取り違えの影響が小さすぎる（前提の確認）');

/* --- 3. 足取りと重みを別々に渡していること（元の取り違えの再発防止） --- */
const call = /this\._poseMove\(dt,\s*([A-Za-z_$][\w$]*),\s*([A-Za-z_$][\w$]*),/.exec(src);
ok(!!call, '_poseMove の呼び出しが見つからない');
if (call) {
  ok(call[1] !== call[2],
    `_poseMove に重みと足取りで同じ値を渡している（${call[1]}, ${call[2]}）。`
    + '重みは «動いている度合い»、足取りは «歩きか走りか» で別物');
  console.log(`_poseMove(dt, ${call[1]}, ${call[2]}, …): 重みと足取りは別の値`);
}
ok(/const mv = moveAmountOf\(gait\)/.test(src), 'クリップの重みが足取りから直に作られている');

/* --- 4. 歩く速さでは走りのクリップが乗らない --- */
const W = /walk:\s*\{[^}]*runFrom:\s*([\d.]+),\s*runTo:\s*([\d.]+)/.exec(src);
ok(!!W, 'TUNING.walk.runFrom / runTo が読めない');
if (W) {
  const [runFrom, runTo] = [+W[1], +W[2]];
  const runW = (g) => Math.min(1, Math.max(0, (g - runFrom) / (runTo - runFrom)));
  near(runW(GAIT_WALK), 0, 1e-9, '歩きの足取りで走りのクリップが乗っている');
  near(runW(1), 1, 1e-9, '走りの足取りで走りのクリップが乗り切っていない');
  console.log(`走りのクリップの重み: 歩き ${runW(GAIT_WALK).toFixed(2)} / 走り ${runW(1).toFixed(2)}`
    + `（切り替わりは ${runFrom}〜${runTo}）`);

  /* 他プレイヤーは moveAmt を送ってこないので速さから足取りを作り直す。
     以前は clamp01(speed / 3.1) をそのまま渡していて、歩く速さで 1.0 ＝
     走りのクリップになっていた */
  near(gaitOfSpeed(WALK_SPEED), GAIT_WALK, 1e-9, '歩く速さが歩きの足取りにならない');
  near(gaitOfSpeed(RUN_SPEED), 1, 1e-9, '走る速さが走りの足取りにならない');
  near(runW(gaitOfSpeed(WALK_SPEED)), 0, 1e-9, '他プレイヤーが歩く速さで走りのクリップになる');
  near(runW(gaitOfSpeed(RUN_SPEED)), 1, 1e-9, '他プレイヤーが走る速さで走りのクリップにならない');
  const before = runW(Math.min(1, WALK_SPEED / WALK_SPEED));
  console.log(`他プレイヤー: 歩く速さ ${WALK_SPEED} m/s → 足取り ${gaitOfSpeed(WALK_SPEED).toFixed(2)}`
    + ` / 走りの重み ${runW(gaitOfSpeed(WALK_SPEED)).toFixed(2)}`
    + `（直す前は ${before.toFixed(2)}）`);
  ok(before > 0.99, '他プレイヤーの取り違えが再現しない（前提の確認）');
}

/* --- 5. 速さと足取りは行き帰りできる --- */
for (const s of [0, 0.8, 1.55, WALK_SPEED, 4.6, RUN_SPEED]) {
  near(speedOfGait(gaitOfSpeed(s)), s, 1e-6, `速さ ${s} m/s の往復がずれる`);
}
near(speedOfGait(GAIT_WALK), WALK_SPEED, 1e-9, '歩きの足取りの速さがゲームの歩く速さと違う');

/* --- 6. 目盛りの定数を二重に持っていないこと --- */
const rp = read('src/multiplayer/remotePlayer.js');
ok(/from '\.\.\/gait\.js/.test(rp), '他プレイヤーが gait.js を使っていない');
ok(!/const\s+WALK_SPEED\s*=/.test(rp), '他プレイヤーが速さの定数を自前で持っている');
ok(/speed:\s*this\.speed/.test(rp), '他プレイヤーが実際の速さを渡していない（再生倍率が概算になる）');

if (bad) { console.error(`gait-test: NG（${bad} 件）`); process.exit(1); }
console.log('gait-test: ok');
