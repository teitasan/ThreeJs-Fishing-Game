/**
 * 投げるときの «糸が竿を離れる点» の検査。
 *
 * Mixamo のキャストを入れたとき、ウキが後ろへ飛ぶ不具合が出た。原因は
 * «竿先からウキを飛ばしていた» こと。Mixamo のキャストは竿を体の左へ低く
 * 落としてから振り抜く動きで、ゲームの竿は 2.43m と背丈 1.5m の釣り人には
 * 長いため、ためている最中の竿先は体の後ろ・地面の下まで回る。そこから
 * 前向きの初速で飛ばしても、出どころが後ろなので後ろへ飛んだように見える。
 *
 * 直し方はふたつで、どちらも崩れると同じ不具合が戻る。
 *   1. ためる範囲を、竿先が地上に残るところまでに切る
 *   2. 狙い・着水点の予測・実際の発射を、竿先ではなく «構えたときの竿先»
 *      （getCastOrigin）で揃える
 * ここではその両方を見る。1 はクリップの実データから幾何で、
 * 2 は呼び出し側が取り違えていないかで確かめる。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, buildRig } from './mixamo-retarget.mjs';
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

/* ---------------- クォータニオン ---------------- */
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function qap(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (v) => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
/** from → to の最小回転 */
function between(a, b) {
  const A = unit(a), B = unit(b);
  const c = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
  const q = [c[0], c[1], c[2], A[0] * B[0] + A[1] * B[1] + A[2] * B[2] + 1];
  const n = Math.hypot(...q);
  return q.map((v) => v / n);
}

/* ---------------- ためている間の竿先 ---------------- */
const rig = buildRig(readGlb(join(root, 'assets/models/player-lowpoly.glb')));
const clip = JSON.parse(read('assets/motions/fishing-cast.json'));
const tracks = new Map(
  clip.tracks.filter((t) => t.type === 'quaternion').map((t) => [t.name.replace('.quaternion', ''), t])
);
const rodQ = between([0, 1, 0], clip.grip.axis);

/** そのフレームの竿先（root ローカル。原点は足元・+Z が正面） */
function tipAt(f) {
  let hand = null;
  const walk = (i, pq, pp) => {
    const n = rig.nodes[i];
    const tr = tracks.get(n.name);
    const lq = tr ? tr.values.slice(f * 4, f * 4 + 4) : (n.rotation || [0, 0, 0, 1]);
    const q = qmul(pq, lq);
    const p = add(pp, qap(pq, n.translation || [0, 0, 0]));
    if (n.name === 'HandR') hand = { q, p };
    for (const c of n.children || []) walk(c, q, p);
  };
  for (const r of rig.roots) walk(r, [0, 0, 0, 1], [0, 0, 0]);
  assert.ok(hand, 'HandR が見つからない');
  const q = qmul(hand.q, rodQ);
  let p = add(hand.p, qap(hand.q, [0, -PALM, 0]));
  p = add(p, qap(q, [0, -GRIP_Y, 0]));
  return add(p, qap(q, [0, TIP_Y, 0]));
}

{
  const nFrames = clip.tracks[0].times.length;
  assert.ok(CHARGE1 < nFrames, `charge1 (${CHARGE1}) がクリップの長さ (${nFrames}) を超えている`);
  let worst = Infinity, worstAt = 0;
  for (let f = Math.floor(CHARGE0); f <= Math.ceil(CHARGE1); f++) {
    const y = tipAt(f)[1];
    if (y < worst) { worst = y; worstAt = f; }
  }
  /* 竿先が地面へ入ると、そこからウキが飛ぶ絵になる。
     0.15m はしゃがんだ姿勢でも残る程度の余裕 */
  assert.ok(worst > 0.15,
    `ためている間に竿先が地面へ入る: 最低 ${worst.toFixed(2)}m @ frame ${worstAt}`
    + `（ためる範囲 ${CHARGE0}〜${CHARGE1}）`);
  console.log(`ためる範囲 ${CHARGE0}〜${CHARGE1}: 竿先の最低高さ ${worst.toFixed(2)}m @ frame ${worstAt}`);
}

/* ---------------- ためる量と竿の前後が連動しているか ----------------
   狙う距離はためるメーターで決めるので、竿の前後がメーターに比例して
   動かないと «連動していない» ように見える。ためる範囲を等間隔に送ると、
   Mixamo のキャストは前半が «横へ払うだけ» なので前後がまったく動かない */
{
  const tipFore = (f) => {
    const lo = Math.floor(f), hi = Math.min(Math.ceil(f), clip.tracks[0].times.length - 1);
    const a = tipAt(lo)[2], b = tipAt(hi)[2];
    return a + (b - a) * (f - lo);
  };
  const N = 17;
  const spread = (frames) => {
    const fore = frames.map(tipFore);
    const step = [];
    for (let i = 1; i < fore.length; i++) step.push(fore[i - 1] - fore[i]);
    const travel = fore[0] - fore[fore.length - 1];
    const mean = travel / step.length;
    return { fore, step, travel, mean, worst: Math.max(...step), min: Math.min(...step) };
  };

  // 等間隔（直した前の挙動）
  const flat = spread([...Array(N)].map((_, k) => CHARGE0 + (CHARGE1 - CHARGE0) * (k / (N - 1))));
  // 逆引き（いまの挙動）
  const tbl = chargeFrameTable(clip.grip.sweep, CHARGE0, CHARGE1);
  assert.ok(tbl, 'ためる量 → フレームの表が作れない（grip.sweep が無い？）');
  const even = spread([...Array(N)].map((_, k) => {
    const x = (k / (N - 1)) * (tbl.length - 1);
    const i = Math.min(tbl.length - 2, Math.floor(x));
    return tbl[i] + (tbl[i + 1] - tbl[i]) * (x - i);
  }));

  assert.ok(even.travel > 1.2,
    `ためても竿が前後に動かない（${even.travel.toFixed(2)}m しか動いていない）`);
  assert.ok(even.min > -0.02,
    `ためる途中で竿が逆へ戻る（最小の刻み ${even.min.toFixed(3)}m）`);
  assert.ok(even.worst / even.mean < 1.4,
    `竿の前後がためる量に比例していない：いちばん大きい刻みが平均の `
    + `${(even.worst / even.mean).toFixed(1)} 倍（前半で動かない等）`);

  console.log(`竿の前後の動き: 合計 ${even.travel.toFixed(2)}m / `
    + `刻みのばらつき 平均の ${(even.worst / even.mean).toFixed(1)} 倍`
    + `（等間隔送りだと ${(flat.worst / flat.mean).toFixed(1)} 倍）`);
}

/* ---------------- 構えたときの竿先は体の前にあるか ---------------- */
{
  const sh = rig.world.get(rig.byName.get('Joint_ShoulderR')).p;
  const hand = add(sh, WAIT.hand);
  const dir = [0, Math.cos(WAIT.pitch), Math.sin(WAIT.pitch)];
  const tip = add(hand, dir.map((v) => v * (TIP_Y - GRIP_Y)));
  assert.ok(tip[2] > 0.5, `構えたときの竿先が前に出ていない（前後 ${tip[2].toFixed(2)}m）`);
  assert.ok(tip[1] > 1.2, `構えたときの竿先が低すぎる（高さ ${tip[1].toFixed(2)}m）`);
  console.log(`構えの竿先: 前後 +${tip[2].toFixed(2)}m / 高さ ${tip[1].toFixed(2)}m`);
}

/* ---------------- 呼び出し側が取り違えていないか ---------------- */
{
  assert.match(angler, /getCastOrigin\(out = new THREE\.Vector3\(\)\)/,
    'Angler.getCastOrigin が無い');
  /* ためる量 → フレームは逆引きを通す。等間隔に戻すと、メーターの前半で
     竿の前後がまったく動かなくなる */
  assert.match(angler, /return this\._chargeFrame\(st === 'charge'/,
    '_castFrame がためる量を _chargeFrame に通していない');
  assert.match(angler, /chargeFrameTable\(sweep, f0, f1\)/,
    'ためる量 → フレームの逆引き（chargeFrameTable）を使っていない');

  /** その関数の中で使っているのはどちらか */
  const bodyOf = (name) => {
    const i = game.indexOf(name);
    assert.ok(i >= 0, `${name} が game.js に無い`);
    return game.slice(i, i + 1400);
  };
  for (const fn of ['_updateAim(force = false) {', '_predictLanding(power,', '_releaseCast() {']) {
    const body = bodyOf(fn);
    assert.match(body, /angler\.getCastOrigin\(/,
      `${fn} が getCastOrigin を使っていない（竿先から投げるとウキが後ろへ飛ぶ）`);
    assert.doesNotMatch(body, /angler\.getRodTip\(/,
      `${fn} がまだ竿先 (getRodTip) を見ている`);
  }
  /* 糸は本物の竿先から描く。ここまで置き換えると、竿が振られている間も
     糸だけ «構えの位置» から出ることになって竿から浮く */
  assert.match(game, /this\.angler\.getRodTip\(_v1\);/,
    '糸の描画に使う竿先 (getRodTip) まで置き換わっている');
  assert.match(game, /updateLine\(_v1,/, 'updateLine が竿先 (_v1) から描いていない');
}

console.log('投げの出どころ: OK');
