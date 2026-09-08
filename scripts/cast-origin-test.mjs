/**
 * 投げるときの «糸が竿を離れる点» と、ためる動きの検査。
 *
 * 釣り人は Mixamo の Mannequin で、竿は右手の骨へ剛体で付く。クリップは
 * assets/models/mannequin.glb に同梱してあるので、そこから実データの幾何を
 * 出して確かめる。押さえているのは、実際に出た 3 つの不具合。
 *
 *  1. ウキが後ろへ飛ぶ。竿先からウキを飛ばしていたのが原因。Mixamo の
 *     キャストは竿を体の左へ低く落としてから振り抜くので、ためている最中の
 *     竿先は体の後ろ・地面の下まで回る。実際の投げでも糸が離れるのは振り
 *     抜いた瞬間なので、狙い・予測・発射は «構えたときの竿先»（getCastOrigin）
 *     で揃える。
 *  2. ためても竿が動かない。ためる範囲をフレームの等間隔で送ると、前半が
 *     «横へ払うだけ» なので竿の前後がまったく動かない。竿の前後の傾きを
 *     逆に引いて比例させる（chargeFrameTable）。
 *  3. 投げ終わりに竿が跳ねる。振り終わりでフレームをため始めへ戻していた。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGlb, clipSampler, poseWorld, qapply, qinv, qmul, qBetween, vsub, vadd, vunit } from './glbClip.mjs';
import { chargeFrameTable } from '../src/castCharge.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');
const angler = read('src/angler.js');
const game = read('src/game.js');

/* ---------------- angler.js から寸法と調整値を読む ---------------- */
const num = (re, what) => {
  const m = angler.match(re);
  assert.ok(m, `${what} が読めない（angler.js の書き方が変わった？）`);
  return Number(m[1]);
};
const CHARGE0 = num(/charge0:\s*([\d.]+)/, 'motion.cast.charge0');
const CHARGE1 = num(/charge1:\s*([\d.]+)/, 'motion.cast.charge1');
const SWING = num(/swing:\s*([\d.]+)/, 'motion.cast.swing');
const PALM = num(/palm:\s*([\d.]+)/, 'motion.palm');
const GRIP_Y = num(/gripY:\s*([\d.-]+)/, 'arm.gripY');
const BLANK_Y0 = num(/const ROD_BLANK_Y0 = ([\d.]+)/, 'ROD_BLANK_Y0');
const SEG = (() => {
  const m = angler.match(/const ROD_SEG_BASE = \[([^\]]+)\]/);
  assert.ok(m, 'ROD_SEG_BASE が読めない');
  return m[1].split(',').map(Number);
})();
const TIP_Y = BLANK_Y0 + SEG.reduce((a, b) => a + b, 0);
const WAIT = (() => {
  const m = angler.match(/wait:\s*\{\s*pitch:\s*([\d.-]+),\s*hand:\s*\[([^\]]+)\]/);
  assert.ok(m, 'pose.wait が読めない');
  return { pitch: Number(m[1]), hand: m[2].split(',').map(Number) };
})();
const FPS = 30;

/* ---------------- 素体とクリップ ---------------- */
const glb = openGlb(join(root, 'assets/models/mannequin.glb'));
const HAND = 'mixamorig:RightHand', HELP = 'mixamorig:LeftHand', ARM = 'mixamorig:RightArm';
const WANT = new Set([HAND, HELP, ARM]);

/* 竿の軸は angler.js と同じやり方で実測する（両手が同じ竿を握っているので
   «左手 → 右手» がそのまま軸）。焼いた定数を持たないので食い違いが起きない */
const idle = clipSampler(glb, 'FishingIdle');
const AXIS = (() => {
  let acc = [0, 0, 0];
  const n = 60;
  for (let i = 0; i < n; i++) {
    const w = poseWorld(glb, idle.at((i / (n - 1)) * idle.duration), WANT);
    const h = w.get(HAND), l = w.get(HELP);
    acc = vadd(acc, qapply(qinv(h.q), vunit(vsub(h.p, l.p))));
  }
  return vunit(acc);
})();
const ROD_Q = qBetween([0, 1, 0], AXIS);

const cast = clipSampler(glb, 'FishingCast');
const FRAMES = Math.round(cast.duration * FPS);

/** そのフレームの竿先と竿の向き（root ローカル。原点は足元・+Z が正面） */
function rodAt(frame) {
  const w = poseWorld(glb, cast.at(Math.min(frame, FRAMES) / FPS), WANT);
  const h = w.get(HAND);
  const q = qmul(h.q, ROD_Q);
  const dir = qapply(q, [0, 1, 0]);
  let p = vadd(h.p, qapply(h.q, [0, -PALM, 0]));
  p = vadd(p, qapply(q, [0, -GRIP_Y, 0]));
  return { tip: vadd(p, dir.map((v) => v * TIP_Y)), dir };
}

/* ---------------- 1. ためている間、竿先は地面より上にあるか ---------------- */
{
  assert.ok(CHARGE1 <= FRAMES, `charge1 (${CHARGE1}) がクリップの長さ (${FRAMES}) を超えている`);
  let worst = Infinity, worstAt = 0;
  for (let f = Math.floor(CHARGE0); f <= Math.ceil(CHARGE1); f++) {
    const y = rodAt(f).tip[1];
    if (y < worst) { worst = y; worstAt = f; }
  }
  /* 竿先が地面へ入ると、そこからウキが飛ぶ絵になる */
  assert.ok(worst > 0.15,
    `ためている間に竿先が地面へ入る: 最低 ${worst.toFixed(2)}m @ frame ${worstAt}`
    + `（ためる範囲 ${CHARGE0}〜${CHARGE1}）`);
  console.log(`ためる範囲 ${CHARGE0}〜${CHARGE1}: 竿先の最低高さ ${worst.toFixed(2)}m @ frame ${worstAt}`);
}

/* ---------------- 2. ためる量と竿の前後が比例しているか ---------------- */
{
  const sweep = [];
  for (let f = 0; f <= FRAMES; f++) sweep.push(rodAt(f).dir[2]);
  const foreAt = (f) => {
    const lo = Math.floor(f), hi = Math.min(Math.ceil(f), FRAMES);
    const a = rodAt(lo).tip[2], b = rodAt(hi).tip[2];
    return a + (b - a) * (f - lo);
  };
  const N = 17;
  const spread = (frames) => {
    const fore = frames.map(foreAt);
    const step = [];
    for (let i = 1; i < fore.length; i++) step.push(fore[i - 1] - fore[i]);
    const travel = fore[0] - fore[fore.length - 1];
    return { travel, mean: travel / step.length, worst: Math.max(...step), min: Math.min(...step) };
  };
  const flat = spread([...Array(N)].map((_, k) => CHARGE0 + (CHARGE1 - CHARGE0) * (k / (N - 1))));
  const tbl = chargeFrameTable(sweep, CHARGE0, CHARGE1);
  assert.ok(tbl, 'ためる量 → フレームの表が作れない');
  const even = spread([...Array(N)].map((_, k) => {
    const x = (k / (N - 1)) * (tbl.length - 1);
    const i = Math.min(tbl.length - 2, Math.floor(x));
    return tbl[i] + (tbl[i + 1] - tbl[i]) * (x - i);
  }));

  assert.ok(even.travel > 1.0,
    `ためても竿が前後に動かない（${even.travel.toFixed(2)}m しか動いていない）`);
  assert.ok(even.min > -0.03,
    `ためる途中で竿が逆へ戻る（最小の刻み ${even.min.toFixed(3)}m）`);
  assert.ok(even.worst / even.mean < 1.6,
    `竿の前後がためる量に比例していない：いちばん大きい刻みが平均の `
    + `${(even.worst / even.mean).toFixed(1)} 倍（前半で動かない等）`);
  console.log(`竿の前後の動き: 合計 ${even.travel.toFixed(2)}m / `
    + `刻みのばらつき 平均の ${(even.worst / even.mean).toFixed(1)} 倍`
    + `（等間隔送りだと ${(flat.worst / flat.mean).toFixed(1)} 倍）`);
}

/* ---------------- 3. 構えたときの竿先は体の前にあるか ---------------- */
{
  const arm = poseWorld(glb, null, WANT).get(ARM).p;
  const hand = vadd(arm, WAIT.hand);
  const dir = [0, Math.cos(WAIT.pitch), Math.sin(WAIT.pitch)];
  const tip = vadd(hand, dir.map((v) => v * (TIP_Y - GRIP_Y)));
  assert.ok(tip[2] > 0.5, `構えたときの竿先が前に出ていない（前後 ${tip[2].toFixed(2)}m）`);
  assert.ok(tip[1] > 1.2, `構えたときの竿先が低すぎる（高さ ${tip[1].toFixed(2)}m）`);
  console.log(`構えの竿先: 前後 +${tip[2].toFixed(2)}m / 高さ ${tip[1].toFixed(2)}m`);
}

/* ---------------- 4. 呼び出し側が取り違えていないか ---------------- */
{
  assert.match(angler, /getCastOrigin\(out = new THREE\.Vector3\(\)\)/, 'Angler.getCastOrigin が無い');
  assert.match(angler, /if \(st === 'charge'\) return this\._chargeFrame\(/,
    '_castFrame がためる量を _chargeFrame に通していない');
  assert.match(angler, /chargeFrameTable\(sweep, f0, f1\)/,
    'ためる量 → フレームの逆引き（chargeFrameTable）を使っていない');

  const bodyOf = (name) => {
    const i = game.indexOf(name);
    assert.ok(i >= 0, `${name} が game.js に無い`);
    return game.slice(i, i + 1400);
  };
  for (const fn of ['_updateAim(force = false) {', '_predictLanding(power,', '_releaseCast() {']) {
    const body = bodyOf(fn);
    assert.match(body, /angler\.getCastOrigin\(/,
      `${fn} が getCastOrigin を使っていない（竿先から投げるとウキが後ろへ飛ぶ）`);
    assert.doesNotMatch(body, /angler\.getRodTip\(/, `${fn} がまだ竿先 (getRodTip) を見ている`);
  }
  assert.match(game, /this\.angler\.getRodTip\(_v1\);/, '糸の描画に使う竿先まで置き換わっている');
  assert.match(game, /updateLine\(_v1,/, 'updateLine が竿先 (_v1) から描いていない');

  // 振り終わりはそのフレームで止める。ため始めへ戻すと竿が跳ねる
  const a = rodAt(Math.round(CHARGE0)).tip, b = rodAt(Math.round(SWING)).tip;
  const jump = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (jump > 0.15) {
    assert.match(angler, /return C\.swing;/,
      `振り終わりでフレームを保持していない（ため始めへ戻ると竿先が ${jump.toFixed(2)}m 跳ぶ）`);
  }
  console.log(`振り終わりの保持: 戻すと竿先が ${jump.toFixed(2)}m 跳ぶので保持している`);
}

console.log('投げの出どころ: OK');
