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
 *  2. ためても竿が動いて見えない。Mixamo のキャストは前半で竿を立てたまま
 *     向きだけ回し、後半で一気に倒すので、フレームを等間隔に送るとメーターの
 *     前半で竿がほとんど動かない。竿が振れた «累積の角度» を逆に引いて、
 *     振れがためる量に比例するようにする（chargeFrameTable）。
 *  3. 投げ終わりに竿が跳ねる。振り終わりでフレームをため始めへ戻していた。
 *  4. 竿が地面を突き抜ける。このクリップは «もっと短い竿» で描かれていて、
 *     振り下ろしの底では 2.43m の竿の竿先が足元より 0.6m 下へ入る。水平の
 *     向きは動きの読み取りそのものなので変えず、竿先が地面すれすれに残る
 *     ところまで起こす（_keepRodOffGround）。
 *
 * 使いどころの分け方もここで押さえる。キャストの振りは竿ごとクリップに預け
 * （そこがこのクリップの見せ場）、構え・アタリ待ち・ファイトは手続き生成にする
 * （Fishing Idle は竿をほぼ垂直に立てて持っていて、水面へ差し出す構えとは
 * 合わない。狙いの角度も竿先から出る糸もそこで要る）。
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
const RELEASE = num(/release:\s*([\d.]+)/, 'motion.cast.release');
const CAST_DUR = num(/swing:\s*[\d.]+,\s*release:\s*[\d.]+,\s*dur:\s*([\d.]+)/, 'motion.cast.dur');
const GRIP_Y = num(/gripY:\s*([\d.-]+)/, 'arm.gripY');
const ROD_FLOOR = num(/rodFloor:\s*([\d.]+)/, 'motion.rodFloor');
const BLANK_Y0 = num(/const ROD_BLANK_Y0 = ([\d.]+)/, 'ROD_BLANK_Y0');
const SEG = (() => {
  const m = angler.match(/const ROD_SEG_BASE = \[([^\]]+)\]/);
  assert.ok(m, 'ROD_SEG_BASE が読めない');
  return m[1].split(',').map(Number);
})();
const TIP_Y = BLANK_Y0 + SEG.reduce((a, b) => a + b, 0);
const POSE = (st) => {
  const m = angler.match(new RegExp(`${st}:\\s*\\{\\s*pitch:\\s*([\\d.-]+),\\s*hand:\\s*\\[([^\\]]+)\\]`));
  assert.ok(m, `pose.${st} が読めない`);
  return { pitch: Number(m[1]), hand: m[2].split(',').map(Number) };
};
const WAIT = POSE('wait');
const IDLE = POSE('idle');
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

     握り点 … 竿をどこに付けるか
     軸     … 竿がどちらを向くか（キャストの振りのあいだだけ）

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

/**
 * そのフレームの竿（root ローカル。原点は足元・+Z が正面）。
 * キャストの振りのあいだの姿で、angler.js の «w = 1» の枝と同じ組み立て。
 *   raw   … 地面ガードを掛ける前の竿先の高さ
 *   guard … ガードが効いたか
 */
function rodAt(frame) {
  const w = poseWorld(glb, cast.at(Math.min(frame, FRAMES) / FPS), WANT);
  const h = w.get(HAND);
  let dir = qapply(h.q, FIST_AXIS);
  const base = vadd(vadd(h.p, qapply(h.q, GRIP)), dir.map((v) => v * -GRIP_Y));
  const raw = base[1] + dir[1] * TIP_Y;
  // 地面ガード（_keepRodOffGround と同じ計算）
  const need = (ROD_FLOOR - base[1]) / TIP_Y;
  let guard = false;
  if (need > dir[1] && need < 1) {
    const hz = Math.hypot(dir[0], dir[2]);
    const k = hz > 1e-6 ? Math.sqrt(Math.max(0, 1 - need * need)) / hz : 0;
    dir = vunit([dir[0] * k, need, dir[2] * k]);
    guard = true;
  }
  return { base, dir, tip: vadd(base, dir.map((v) => v * TIP_Y)), raw, guard };
}

/** 手続き側の竿（構え・アタリ待ち・ファイト）。腕の根元 + 姿勢のオフセット */
function rodByPose(pitch, handOff) {
  const arm = poseWorld(glb, null, WANT).get(ARM).p;
  const dir = [0, Math.cos(pitch), Math.sin(pitch)];
  const base = vadd(vadd(arm, handOff), dir.map((v) => v * -GRIP_Y));
  return { dir, tip: vadd(base, dir.map((v) => v * TIP_Y)) };
}

/* ためる量 → クリップのフレーム。angler.js と同じ «累積の振れ角» の表を作る */
const CLIP_ARC = (() => {
  const out = [0];
  let acc = 0, prev = rodAt(0).dir;
  for (let f = 1; f <= FRAMES; f++) {
    const d = rodAt(f).dir;
    acc += Math.acos(Math.max(-1, Math.min(1, d[0] * prev[0] + d[1] * prev[1] + d[2] * prev[2])));
    prev = d;
    out.push(acc);
  }
  return out;
})();
const CHARGE_TABLE = chargeFrameTable(CLIP_ARC, CHARGE0, CHARGE1);
assert.ok(CHARGE_TABLE, 'ためる量 → フレームの表が作れない');
function frameAt(charge) {
  const x = Math.max(0, Math.min(1, charge)) * (CHARGE_TABLE.length - 1);
  const i = Math.min(CHARGE_TABLE.length - 2, Math.floor(x));
  return CHARGE_TABLE[i] + (CHARGE_TABLE[i + 1] - CHARGE_TABLE[i]) * (x - i);
}
const rodAtCharge = (charge) => ({ ...rodAt(frameAt(charge)), frame: frameAt(charge) });

/* ---------------- 1. ためている間、竿先は地面より上にあるか ---------------- */
{
  assert.ok(CHARGE1 <= FRAMES, `charge1 (${CHARGE1}) がクリップの長さ (${FRAMES}) を超えている`);
  let worst = Infinity, worstAt = 0, rawWorst = Infinity;
  for (let i = 0; i <= 40; i++) {
    const c = i / 40, r = rodAtCharge(c);
    if (r.tip[1] < worst) { worst = r.tip[1]; worstAt = c; }
    rawWorst = Math.min(rawWorst, r.raw);
  }
  assert.ok(worst > ROD_FLOOR - 1e-6,
    `ためている間に竿先が地面へ入る: 最低 ${worst.toFixed(2)}m @ ためる ${worstAt.toFixed(2)}`);
  console.log(`ためる 0〜1: 竿先の最低高さ ${worst.toFixed(2)}m @ ためる ${worstAt.toFixed(2)}`
    + `（ガード無しなら ${rawWorst.toFixed(2)}m）`);

  /* 振り抜きの通り道。ここがこのクリップのいちばん低いところで、
     ガードが無いと竿先が足元より 0.6m 下＝桟橋を突き抜ける */
  let swWorst = Infinity, swRaw = Infinity, guarded = 0, n = 0;
  for (let i = 0; i <= 40; i++) {
    const e = i / 40, ee = e * e * (3 - 2 * e);
    const r = rodAt(CHARGE1 + (SWING - CHARGE1) * ee);
    swWorst = Math.min(swWorst, r.tip[1]);
    swRaw = Math.min(swRaw, r.raw);
    if (r.guard) guarded++;
    n++;
  }
  assert.ok(swWorst > ROD_FLOOR - 1e-6,
    `振り抜きで竿先が地面へ入る: 最低 ${swWorst.toFixed(2)}m`);
  assert.ok(swRaw < 0, 'ガードが要らないなら、この検査の前提（竿がクリップより長い）が崩れている');
  assert.match(angler, /_keepRodOffGround\(_rodP, _rodQt\)/, '竿の地面ガードを呼んでいない');
  console.log(`振り抜き: 竿先の最低高さ ${swWorst.toFixed(2)}m`
    + `（ガード無しなら ${swRaw.toFixed(2)}m / ${Math.round(guarded / n * 100)}% の区間でガードが効く）`);
}

/* ---------------- 2. ためる量と竿の振れが比例しているか ---------------- */
{
  const N = 21;
  const at = (k) => rodAtCharge(k / (N - 1));
  const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const step = [];
  for (let k = 1; k < N; k++) step.push(ang(at(k - 1).dir, at(k).dir) * 180 / Math.PI);
  const total = step.reduce((a, v) => a + v, 0);
  const mean = total / step.length;

  assert.ok(total > 60, `ためても竿が振れない（合計 ${total.toFixed(0)} 度）`);
  assert.ok(Math.max(...step) / mean < 1.8,
    `竿の振れがためる量に比例していない：いちばん大きい刻みが平均の `
    + `${(Math.max(...step) / mean).toFixed(1)} 倍`);
  assert.ok(Math.min(...step) > mean * 0.2,
    `ためても竿がほとんど動かない区間がある（最小の刻み ${Math.min(...step).toFixed(1)} 度 / `
    + `平均 ${mean.toFixed(1)} 度）`);

  // 等間隔にフレームを送ったときとの比較（この表が効いていることの確認）
  const flat = [];
  for (let k = 1; k < N; k++) {
    const f0 = CHARGE0 + (CHARGE1 - CHARGE0) * ((k - 1) / (N - 1));
    const f1 = CHARGE0 + (CHARGE1 - CHARGE0) * (k / (N - 1));
    flat.push(ang(rodAt(f0).dir, rodAt(f1).dir) * 180 / Math.PI);
  }
  const flatMean = flat.reduce((a, v) => a + v, 0) / flat.length;
  console.log(`竿の振れ: 合計 ${total.toFixed(0)}度 / 刻みのばらつき 平均の `
    + `${(Math.max(...step) / mean).toFixed(1)} 倍（等間隔送りだと ${(Math.max(...flat) / flatMean).toFixed(1)} 倍）`);

  /* 竿はクリップの振りに任せているので «横へ» 大きく出てよい。それがこの
     クリップの見せ場。ここでは «ちゃんと振れている» ことだけ見る */
  const side = Math.max(...[...Array(N)].map((_, k) => Math.abs(at(k).tip[0])));
  assert.ok(side > 0.8, `振りが小さい（竿先が横へ ${side.toFixed(2)}m しか出ない）`);
  /* 竿の向きをクリップから取っていること。ここを手続きの «前後に倒すだけ» に
     すると、この横への振りがまるごと消える */
  assert.match(angler, /_rodQt\.slerp\(_q3, w\)/,
    '竿の向きをクリップから取っていない（Mixamo の振りが竿に乗らない）');
  assert.match(angler, /_v14\.copy\(this\._gripLocal\)/,
    '竿を拳の握り点へ付けていない（手首に付けると 17cm 前腕側へずれる）');
  console.log(`振りの大きさ: 竿先が横へ ${side.toFixed(2)}m`);
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
  assert.match(angler, /chargeFrameTable\(arc, f0, f1\)/,
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

/* ---------------- 5. 使いどころの分け方と、体の向き ---------------- */
{
  /* 腕と竿をクリップに任せるのはキャストの振りのあいだだけ。構え・アタリ待ち・
     ファイトまで任せると、Fishing Idle の «竿をほぼ垂直に立てた» 構えになって
     水面へ差し出せず、狙いの角度も竿先から出る糸も作れない */
  const m = angler.match(/const MOTION_STATES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'MOTION_STATES が読めない');
  const states = m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepStrictEqual(states, ['charge'],
    `腕と竿をクリップに任せる状態が «ためる» 以外にある（${states.join(', ')}）`);
  assert.match(angler, /MOTION_STATES\.has\(st\) \|\| this\.castAnim >= 0/,
    '振り抜きのあいだにクリップから降りてしまう（腕だけ手続きに戻って胴と食い違う）');

  /* 構えとアタリ待ちは手続き側。竿は «体の正面» を向いて水面へ差し出される。
     ここがずれていた時代は、竿の向きのずれを体ごと回して打ち消していたので、
     体の向きとキャストの向きが 70 度食い違って見えていた */
  for (const [name, pose] of [['構え', IDLE], ['アタリ待ち', WAIT]]) {
    const { dir, tip } = rodByPose(pose.pitch, pose.hand);
    const yaw = Math.atan2(dir[0], dir[2]) * 180 / Math.PI;
    assert.ok(Math.abs(yaw) < 5, `${name}の竿が体の正面を向いていない（水平 ${yaw.toFixed(0)}度）`);
    assert.ok(tip[2] > 0.5, `${name}の竿先が前に出ていない（前後 ${tip[2].toFixed(2)}m）`);
    const elev = Math.asin(Math.max(-1, Math.min(1, dir[1]))) * 180 / Math.PI;
    console.log(`${name}の竿: 水平 ${yaw.toFixed(0)}度（体の正面）/ 仰角 ${elev.toFixed(0)}度`
      + ` / 竿先 前後 +${tip[2].toFixed(2)}m`);
  }
  // 体を回して打ち消す仕掛けが残っていないこと
  assert.doesNotMatch(angler, /model\.rotation\.y\s*=/,
    '体ごと回して竿の向きを合わせる処理が残っている');
  assert.doesNotMatch(angler, /faceRod/, 'faceRod が残っている');
}

/* ---------------- 6. 振り抜きの速さと、糸が離れる瞬間 ---------------- */
{
  /* 振り抜きは «竿が動いているところ» だけを送る。以前は 112 まで送っていたが、
     63〜112 は竿先がほとんど動かない «戻り» で、それを dur に詰め込んでいた
     ため 5 倍速を超えて «妙に早い» 見え方になっていた */
  const rate = (SWING - CHARGE1) / FPS / CAST_DUR;
  assert.ok(rate > 0.8 && rate < 2.6,
    `振り抜きの再生倍率が釣りらしくない（${rate.toFixed(1)} 倍速）。`
    + `フレーム ${CHARGE1}→${SWING} ＝ ${((SWING - CHARGE1) / FPS).toFixed(2)}s を ${CAST_DUR}s で送っている`);

  /* 竿先の «前へ出る速さ» が最大になるところが、糸が離れる瞬間 */
  const fwdSpeed = (f) => (rodAt(f + 0.5).tip[2] - rodAt(f - 0.5).tip[2]) * FPS;
  let peak = CHARGE1, peakV = -Infinity;
  for (let f = CHARGE1; f <= Math.min(SWING + 6, FRAMES - 1); f++) {
    const v = fwdSpeed(f);
    if (v > peakV) { peakV = v; peak = f; }
  }
  assert.ok(Math.abs(RELEASE - peak) <= 2,
    `糸が離れるフレーム（${RELEASE}）が振り抜きの頂点（${peak}）と合っていない`);
  assert.ok(RELEASE > CHARGE1 && RELEASE <= SWING,
    `糸が離れるフレーム（${RELEASE}）が振り抜きの範囲 ${CHARGE1}〜${SWING} の外にある`);

  /* そこへ着くまでの «時間»。フレームは smoothstep で送るので逆関数で出す */
  const invSmoothstep = (x) => 0.5 - Math.sin(Math.asin(Math.max(-1, Math.min(1, 1 - 2 * x))) / 3);
  const lead = invSmoothstep((RELEASE - CHARGE1) / (SWING - CHARGE1)) * CAST_DUR;
  assert.ok(lead > 0.15 && lead < CAST_DUR,
    `糸が離れるまでの待ちがおかしい（${lead.toFixed(2)}s / 尺 ${CAST_DUR}s）`);
  assert.match(angler, /this\.castLead = invSmoothstep\(x\) \* dur \* clamp01\(this\.motionW\)/,
    'playCast が «糸が離れるまでの時間» を出していない');

  /* ゲーム側が待っていること。ここを待たないと、まだ振りかぶっている絵の
     うしろでウキだけが飛んでいく */
  assert.match(game, /this\.castLead = this\.angler\.castLead \|\| 0;/,
    'ゲームが釣り人の «糸が離れるまでの時間» を受け取っていない');
  assert.match(game, /\} else if \(this\.castLead > 0\) \{/,
    '飛んでいる間の処理が castLead を待っていない');
  const flight = game.slice(game.indexOf('} else if (this.castLead > 0) {'), game.indexOf('} else if (this.castLead > 0) {') + 400);
  assert.match(flight, /bob\.visible = false/, '待っている間にウキが見えている');
  assert.match(flight, /hideLine\(\)/, '待っている間に糸が見えている');
  console.log(`振り抜き: フレーム ${CHARGE1}→${SWING}（${rate.toFixed(1)} 倍速）/ `
    + `糸が離れるのはフレーム ${RELEASE}＝振り抜きの頂点（前へ ${peakV.toFixed(1)} m/s）の ${lead.toFixed(2)} 秒後`);
}

/* ---------------- 7. «手首どうし» を竿の軸にしてはいけない ---------------- */
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
