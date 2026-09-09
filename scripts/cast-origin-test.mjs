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
 *  2. ためる動きと竿が噛み合わない。Mixamo のキャストは竿を体の «横へ»
 *     振り回す動きで、«前後» にはならない（ためる 0→1 で竿の水平の向きが
 *     140 度回り、竿先が左へ 2.0m 出る）。ゲームは «ためる量に竿の前後が
 *     対応する» ことで距離を読ませているので、竿の «向き» はいつもゲームが
 *     決め（構えの角度 rodPitch）、クリップは «どこを持つか»＝拳の握り点だけを
 *     動かす。振りかぶりの見え方がその前後と歩調を合わせるように、クリップの
 *     フレームは竿の前後の傾きから逆に引く（chargeFrameTable）。
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
const GRIP_Y = num(/gripY:\s*([\d.-]+)/, 'arm.gripY');
const POSE_PITCH = (st) => num(new RegExp(`${st}:\\s*\\{\\s*pitch:\\s*([\\d.-]+)`), `pose.${st}.pitch`);
const IDLE_PITCH = POSE_PITCH('idle');
const CHARGE_PITCH = POSE_PITCH('charge');
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
const HAND = 'mixamorig:RightHand', ARM = 'mixamorig:RightArm';
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
const WANT = new Set([HAND, ARM,
  ...FINGERS.flatMap((f) => [`mixamorig:RightHand${f}1`, `mixamorig:RightHand${f}3`])]);

/* 拳が握っている «筒» を angler.js と同じやり方で測る。4 本の指の
   «付け根と第 2 関節の中点» はその筒の上に並ぶので、中心が握り点・並びが軸。
   焼いた定数を持たないので食い違いが起きない。

     握り点 … 竿をどこに付けるか（そのまま使う）
     軸     … クリップの竿がどれだけ前後にあるか（sweep）を測るのに使う。
              向きそのものには使わない（Fishing Idle の軸は仰角 79 度＝
              ほぼ垂直で、水面へ差し出す釣りの構えには合わない）

   以前は «左手首 → 右手首» の線を竿の軸として «測って» いた。それは握り軸から
   63 度ずれた別物で（下の 6 番で確かめている）、その水平のずれを体ごと回して
   打ち消していたため、体の向きとキャストの向きが 70 度食い違っていた */
const idle = clipSampler(glb, 'FishingIdle');
const fistOf = (w, side) => {
  const pts = FINGERS.map((f) => {
    const a = w.get(`mixamorig:${side}Hand${f}1`).p;
    const b = w.get(`mixamorig:${side}Hand${f}3`).p;
    return a.map((v, k) => (v + b[k]) / 2);
  });
  const center = pts.reduce((acc, q) => acc.map((v, k) => v + q[k] / pts.length), [0, 0, 0]);
  return { center, dir: vunit(vsub(pts[0], pts[pts.length - 1])) };
};
/** 手のローカルで見た握り点と筒の軸（構えを通した平均） */
const { GRIP, FIST_AXIS } = (() => {
  let g = [0, 0, 0], a = [0, 0, 0];
  const n = 30;
  for (let i = 0; i < n; i++) {
    const w = poseWorld(glb, idle.at((i / (n - 1)) * idle.duration), WANT);
    const h = w.get(HAND), f = fistOf(w, 'Right');
    g = vadd(g, qapply(qinv(h.q), vsub(f.center, h.p)));
    a = vadd(a, qapply(qinv(h.q), f.dir));
  }
  return { GRIP: g.map((v) => v / n), FIST_AXIS: vunit(a) };
})();

const cast = clipSampler(glb, 'FishingCast');
const FRAMES = Math.round(cast.duration * FPS);

/** そのフレームで «クリップの竿» がどこを向いているか（モデル空間） */
function clipRodDir(frame) {
  const w = poseWorld(glb, cast.at(Math.min(frame, FRAMES) / FPS), WANT);
  return qapply(w.get(HAND).q, FIST_AXIS);
}

/**
 * ためる量 charge のときの竿先と竿の向き（root ローカル。原点は足元・+Z が正面）。
 *
 * 向きはゲームが決める（構えの角度＝ idle→charge を charge で送ったもの）。
 * 位置はクリップが動かしている拳の握り点。どのフレームを見せるかは
 * chargeFrameTable が竿の前後から逆に引く。
 */
function rodAtCharge(charge) {
  const dir = [0, Math.cos(rodPitchAt(charge)), Math.sin(rodPitchAt(charge))];
  const w = poseWorld(glb, cast.at(Math.min(frameAt(charge), FRAMES) / FPS), WANT);
  const h = w.get(HAND);
  const grip = vadd(h.p, qapply(h.q, GRIP));
  const base = vadd(grip, dir.map((v) => v * -GRIP_Y));
  return { tip: vadd(base, dir.map((v) => v * TIP_Y)), dir, frame: frameAt(charge) };
}
const rodPitchAt = (c) => IDLE_PITCH + (CHARGE_PITCH - IDLE_PITCH) * c;

/* ためる量 → クリップのフレーム。angler.js と同じ表を作る */
const CLIP_SWEEP = (() => {
  const out = [];
  for (let f = 0; f <= FRAMES; f++) out.push(clipRodDir(f)[2]);
  return out;
})();
const CHARGE_TABLE = chargeFrameTable(CLIP_SWEEP, CHARGE0, CHARGE1);
assert.ok(CHARGE_TABLE, 'ためる量 → フレームの表が作れない');
function frameAt(charge) {
  const x = Math.max(0, Math.min(1, charge)) * (CHARGE_TABLE.length - 1);
  const i = Math.min(CHARGE_TABLE.length - 2, Math.floor(x));
  return CHARGE_TABLE[i] + (CHARGE_TABLE[i + 1] - CHARGE_TABLE[i]) * (x - i);
}

/* ---------------- 1. ためている間、竿先は地面より上にあるか ---------------- */
{
  assert.ok(CHARGE1 <= FRAMES, `charge1 (${CHARGE1}) がクリップの長さ (${FRAMES}) を超えている`);
  let worst = Infinity, worstAt = 0;
  for (let i = 0; i <= 40; i++) {
    const c = i / 40;
    const y = rodAtCharge(c).tip[1];
    if (y < worst) { worst = y; worstAt = c; }
  }
  /* 竿先が地面へ入ると、そこからウキが飛ぶ絵になる */
  assert.ok(worst > 0.15,
    `ためている間に竿先が地面へ入る: 最低 ${worst.toFixed(2)}m @ ためる ${worstAt.toFixed(2)}`);
  console.log(`ためる 0〜1: 竿先の最低高さ ${worst.toFixed(2)}m @ ためる ${worstAt.toFixed(2)}`);
}

/* ---------------- 2. ためる量と竿の前後が比例しているか ---------------- */
{
  const N = 21;
  const at = (k) => rodAtCharge(k / (N - 1));
  const fore = [...Array(N)].map((_, k) => at(k).tip[2]);
  const step = [];
  for (let i = 1; i < N; i++) step.push(fore[i - 1] - fore[i]);
  const travel = fore[0] - fore[N - 1];
  const mean = travel / step.length;
  const worst = Math.max(...step), min = Math.min(...step);

  assert.ok(travel > 1.0, `ためても竿が前後に動かない（${travel.toFixed(2)}m しか動いていない）`);
  assert.ok(min > -0.01, `ためる途中で竿が前へ戻る（最小の刻み ${min.toFixed(3)}m）`);
  assert.ok(worst / mean < 1.6,
    `竿の前後がためる量に比例していない：いちばん大きい刻みが平均の `
    + `${(worst / mean).toFixed(1)} 倍`);

  /* 竿は «横» を向いてはいけない。ここがゲームの読み取り（前後で距離）と
     クリップの動き（横へ 140 度）の食い違いだったところ。

     竿先が横へずれるぶんは «手がそこへ動いた» ぶんだけであるべきで、
     2.4m 先の竿先が手より大きく横へ出たら、竿が横を向いている */
  const sideways = Math.max(...[...Array(N)].map((_, k) => Math.abs(at(k).dir[0])));
  assert.ok(sideways < 1e-6,
    `竿の向きに横の成分がある（最大 ${sideways.toFixed(3)}）。`
    + '竿の向きは «前後と上下だけ»（構えの角度）でなければならない');
  /* 本体側でも、竿の向きがクリップに引きずられていないことを見る。
     _rodQt をクリップの姿勢へ混ぜると横振りが戻ってくる */
  assert.doesNotMatch(angler, /_rodQt\.slerp/,
    '竿の向きをクリップの姿勢へ混ぜている（Mixamo の横振りが竿に乗る）');
  assert.match(angler, /_rodQt\.setFromEuler\(_euler\.set\(this\.rodPitch, 0, 0\)\)/,
    '竿の向きが構えの角度（rodPitch）から作られていない');
  const side = Math.max(...[...Array(N)].map((_, k) => Math.abs(at(k).tip[0])));
  const gripSide = Math.max(...[...Array(N)].map((_, k) => {
    const w = poseWorld(glb, cast.at(Math.min(at(k).frame, FRAMES) / FPS), WANT);
    const h = w.get(HAND);
    return Math.abs(vadd(h.p, qapply(h.q, GRIP))[0]);
  }));
  assert.ok(side < gripSide + 0.12,
    `竿先が手より横へ出ている（竿先 ${side.toFixed(2)}m / 手 ${gripSide.toFixed(2)}m）`);

  /* 振りかぶりの見え方（クリップのフレーム）が、その前後と歩調を合わせて
     いること。等間隔送りだと前半が «横へ払うだけ» で竿が動かない */
  const clipFore = [...Array(N)].map((_, k) => clipRodDir(at(k).frame)[2]);
  const cStep = [];
  for (let i = 1; i < N; i++) cStep.push(clipFore[i - 1] - clipFore[i]);
  const cMean = (clipFore[0] - clipFore[N - 1]) / cStep.length;
  const flatFore = [...Array(N)].map((_, k) =>
    clipRodDir(CHARGE0 + (CHARGE1 - CHARGE0) * (k / (N - 1)))[2]);
  const fStep = [];
  for (let i = 1; i < N; i++) fStep.push(flatFore[i - 1] - flatFore[i]);
  const fMean = (flatFore[0] - flatFore[N - 1]) / fStep.length;
  assert.ok(Math.max(...cStep) / cMean < 1.6,
    `振りかぶりの送りが偏っている：いちばん大きい刻みが平均の `
    + `${(Math.max(...cStep) / cMean).toFixed(1)} 倍`);

  console.log(`竿の前後の動き: 合計 ${travel.toFixed(2)}m / `
    + `刻みのばらつき 平均の ${(worst / mean).toFixed(1)} 倍 / `
    + `横の成分なし（竿先 ${side.toFixed(2)}m ≦ 手 ${gripSide.toFixed(2)}m + 12cm）`);
  console.log(`振りかぶりの送り: ばらつき 平均の ${(Math.max(...cStep) / cMean).toFixed(1)} 倍`
    + `（等間隔送りだと ${(Math.max(...fStep) / fMean).toFixed(1)} 倍）`);
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

  /* 振り終わりはそのフレームで止める。ため始めへ戻すと竿が跳ねる。
     竿の向きはもうクリップに依らないので、跳ぶのは «握り点»＝手の位置 */
  const gripAt = (frame) => {
    const w = poseWorld(glb, cast.at(Math.min(frame, FRAMES) / FPS), WANT);
    const h = w.get(HAND);
    return vadd(h.p, qapply(h.q, GRIP));
  };
  const a = gripAt(Math.round(CHARGE0)), b = gripAt(Math.round(SWING));
  const jump = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (jump > 0.10) {
    assert.match(angler, /return C\.swing;/,
      `振り終わりでフレームを保持していない（ため始めへ戻ると握り点が ${jump.toFixed(2)}m 跳ぶ）`);
  }
  console.log(`振り終わりの保持: 戻すと握り点が ${jump.toFixed(2)}m 跳ぶので保持している`);
}

/* ---------------- 5. 体の向きとキャストの向きが一致しているか ---------------- */
{
  /* 竿の水平の向きは «体の正面» でなければならない。ここがずれていた時代は
     そのずれを体ごと回して打ち消していたので、体の向きとキャストの向きが
     70 度食い違って «真横を向いて投げている» ように見えていた */
  const dir = rodAtCharge(0).dir;
  const yaw = Math.atan2(dir[0], dir[2]) * 180 / Math.PI;
  assert.ok(Math.abs(yaw) < 5,
    `構えたときの竿が体の正面を向いていない（水平 ${yaw.toFixed(0)}度）。`
    + 'ここがずれると体の向きとキャストの向きが食い違う');
  const elev = Math.asin(Math.max(-1, Math.min(1, dir[1]))) * 180 / Math.PI;
  assert.ok(elev > 15 && elev < 65,
    `構えたときの竿の仰角が釣りらしくない（${elev.toFixed(0)}度）`);
  // 体を回して打ち消す仕掛けが残っていないこと
  assert.doesNotMatch(angler, /model\.rotation\.y\s*=/,
    '体ごと回して竿の向きを合わせる処理が残っている');
  assert.doesNotMatch(angler, /faceRod/, 'faceRod が残っている');
  console.log(`構えの竿の向き: 水平 ${yaw.toFixed(0)}度（体の正面）/ 仰角 ${elev.toFixed(0)}度`);
}

/* ---------------- 6. «手首どうし» を竿の軸にしてはいけない ---------------- */
{
  /* 拳が実際に握っている軸は、4 本の指の «付け根と第 2 関節の中点» を通る線。
     以前はこれを «左手首 → 右手首» で代用していたが、両手は竿の上に縦に
     並んでいるのではなく 13cm 横へずれて添えられているので、その線は竿では
     ない。«左手も竿の線に 0.2cm で乗る» という以前の実測は、その «竿の線» を
     両手首から定義していたせいで必ず 0 になる循環した測り方だった */
  const w = poseWorld(glb, idle.at(idle.duration * 0.3), new Set([...WANT,
    'mixamorig:LeftHand',
    ...FINGERS.flatMap((f) => [`mixamorig:LeftHand${f}1`, `mixamorig:LeftHand${f}3`])]));
  const fist = (side) => {
    const pts = FINGERS.map((f) => {
      const a = w.get(`mixamorig:${side}Hand${f}1`).p;
      const b = w.get(`mixamorig:${side}Hand${f}3`).p;
      return a.map((v, k) => (v + b[k]) / 2);
    });
    const center = pts.reduce((acc, q) => acc.map((v, k) => v + q[k] / pts.length), [0, 0, 0]);
    return { center, dir: vunit(vsub(pts[0], pts[pts.length - 1])) };
  };
  const R = fist('Right'), L = fist('Left');
  const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;

  // 左右の拳が同じ向きの筒を握っている＝これが本当の竿の軸
  const between = ang(R.dir, L.dir);
  assert.ok(between < 20,
    `左右の拳の握り軸が食い違う（${between.toFixed(0)}度）。竿の軸の測り方の前提が崩れている`);

  // その軸と «手首どうし» の線は別物
  const wrist = vunit(vsub(w.get(HAND).p, w.get('mixamorig:LeftHand').p));
  const off = ang(R.dir, wrist);
  assert.ok(off > 60,
    `«手首どうし» が握り軸と一致してしまっている（${off.toFixed(0)}度）。`
    + 'この検査の前提が崩れているので測り方を見直すこと');

  // 左の拳は右の拳の軸線から外れている（縦に並んでいない）
  const d = vsub(L.center, R.center);
  const along = d[0] * R.dir[0] + d[1] * R.dir[1] + d[2] * R.dir[2];
  const perp = Math.hypot(...d.map((v, k) => v - along * R.dir[k]));
  assert.ok(perp > 0.05,
    `左の拳が右の拳の軸線に乗っている（${(perp * 100).toFixed(1)}cm）。`
    + '«両手が竿の線に乗る» を根拠にしてよいことになるので測り方を見直すこと');
  console.log(`拳の握り軸: 左右で ${between.toFixed(0)}度違い / «手首どうし» とは ${off.toFixed(0)}度違い`
    + ` / 左の拳は軸線から ${(perp * 100).toFixed(1)}cm 外れている`);
}

console.log('投げの出どころ: OK');
