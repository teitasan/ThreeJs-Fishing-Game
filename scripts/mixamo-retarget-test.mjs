/**
 * Mixamo → 釣り人（player-lowpoly.glb）のリターゲットの検査。
 *
 * 素体は Mixamo とは骨組みも静止姿勢も違う。Mixamo は T ポーズの
 * スキンつきリグ、こちらは «腕を下ろした I ポーズ・関節ごとに独立した
 * 剛体パーツ» で、しかも背骨は子が局所 +Y・手足は -Y・足先は -Z と
 * 伸びる向きが部位ごとに違う。回転をそのまま移すやり方だと、この差が
 * まるごと誤差になって腕が体にめり込む。
 *
 * そこで scripts/mixamo-retarget.mjs は «パーツの伸びる軸を Mixamo の
 * 骨の向きへ合わせる» 方式にしてある。ここで確かめたいのはその一点、
 *
 *   出力したクリップを順運動学で解き直したとき、各パーツの伸びる軸が
 *   Mixamo の骨の向きと一致するか
 *
 * で、Mixamo の実ファイルが無くても合成スケルトンで検査できる。
 * FBX を差し替えても、この性質が崩れていなければ姿勢は合っている。
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP, axisOf, buildRig, readGlb } from './mixamo-retarget.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---------------- ベクトル・クォータニオン ---------------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(v) {
  const n = Math.hypot(...v);
  return n < 1e-9 ? [0, 1, 0] : [v[0] / n, v[1] / n, v[2] / n];
}
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function qapply(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
const qAxis = (axis, ang) => {
  const a = unit(axis), s = Math.sin(ang / 2);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)];
};

/* ---------------- 合成した Mixamo スケルトン ----------------
   単位は cm（Mixamo の FBX と同じ桁）。腰の高さで正規化されることまで見る */
const SKEL = [
  ['Hips', null, [0, 100, 0]],
  ['Spine', 'Hips', [0, 10, 0]],
  ['Spine1', 'Spine', [0, 10, 0]],
  ['Spine2', 'Spine1', [0, 10, 0]],
  ['Neck', 'Spine2', [0, 15, 0]],
  ['Head', 'Neck', [0, 7, 0]],
  ['HeadTop_End', 'Head', [0, 18, 0]],
  ['LeftShoulder', 'Spine2', [5, 13, 0]],
  ['LeftArm', 'LeftShoulder', [13, 0, 0]],
  ['LeftForeArm', 'LeftArm', [27, 0, 0]],
  ['LeftHand', 'LeftForeArm', [25, 0, 0]],
  ['LeftHandMiddle1', 'LeftHand', [8, 0, 0]],
  ['RightShoulder', 'Spine2', [-5, 13, 0]],
  ['RightArm', 'RightShoulder', [-13, 0, 0]],
  ['RightForeArm', 'RightArm', [-27, 0, 0]],
  ['RightHand', 'RightForeArm', [-25, 0, 0]],
  ['RightHandMiddle1', 'RightHand', [-8, 0, 0]],
  ['LeftUpLeg', 'Hips', [9, -2, 0]],
  ['LeftLeg', 'LeftUpLeg', [0, -43, 0]],
  ['LeftFoot', 'LeftLeg', [0, -45, 0]],
  ['LeftToeBase', 'LeftFoot', [0, -8, 15]],
  ['LeftToe_End', 'LeftToeBase', [0, 0, 10]],
  ['RightUpLeg', 'Hips', [-9, -2, 0]],
  ['RightLeg', 'RightUpLeg', [0, -43, 0]],
  ['RightFoot', 'RightLeg', [0, -45, 0]],
  ['RightToeBase', 'RightFoot', [0, -8, 15]],
  ['RightToe_End', 'RightToeBase', [0, 0, 10]],
];
const PARENT = Object.fromEntries(SKEL.map(([n, p]) => [n, p]));
const OFFSET = Object.fromEntries(SKEL.map(([n, , o]) => [n, o]));
/** 骨の向きを測る先（mixamo-retarget.mjs の MAP と同じ相手） */
const PRIMARY = {
  Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck',
  Neck: 'Head', Head: 'HeadTop_End',
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand',
  LeftHand: 'LeftHandMiddle1',
  RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand',
  RightHand: 'RightHandMiddle1',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'LeftToeBase',
  LeftToeBase: 'LeftToe_End',
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase',
  RightToeBase: 'RightToe_End',
};

/** 局所回転（骨名 → クォータニオン）から、骨ごとのワールド頭位置と姿勢を作る */
function poseSkeleton(localQ = {}) {
  const wq = {}, wp = {};
  for (const [name, parent] of SKEL) {
    const lq = localQ[name] || [0, 0, 0, 1];
    if (!parent) {
      wq[name] = lq;
      wp[name] = OFFSET[name];
    } else {
      wq[name] = qmul(wq[parent], lq);
      wp[name] = add(wp[parent], qapply(wq[parent], OFFSET[name]));
    }
  }
  // ダンプと同じ形（頭の位置と X/Y/Z 軸）へ。Y を骨の向きに取り、ロールは決め打ち
  const snap = {};
  for (const [name] of SKEL) {
    const kid = PRIMARY[name];
    const y = kid ? unit(sub(wp[kid], wp[name])) : qapply(wq[name], [0, 1, 0]);
    const ref = Math.abs(dot(y, [0, 0, 1])) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const x = unit(cross(y, ref));
    snap[name] = { head: wp[name], x, y, z: cross(x, y) };
  }
  return { snap, wp };
}

/* ---------------- 素体（GLB）の階層 ---------------- */
const gltf = readGlb(join(root, 'assets/models/player-lowpoly.glb'));
const rig = buildRig(gltf);
const byName = rig.byName;

/** クリップの局所回転で順運動学。各ノードのワールド回転・位置を返す */
function forward(localQ) {
  const world = new Map();
  const walk = (i, pq, pp) => {
    const n = gltf.nodes[i];
    const q = qmul(pq, localQ.get(n.name) || n.rotation || [0, 0, 0, 1]);
    const p = add(pp, qapply(pq, n.translation || [0, 0, 0]));
    world.set(n.name, { q, p });
    for (const c of n.children || []) walk(c, q, p);
  };
  for (const r of gltf.scenes[0].nodes) walk(r, [0, 0, 0, 1], [0, 0, 0]);
  return world;
}

/* 検査する対応は MAP そのものを使う。表を書き写すと «表どうしは合っているが
   実物と食い違う» という一番たちの悪いすれ違いが起きる */
const CHECK = MAP.map(([node, bones, axis]) => ({
  node,
  root: bones[0],
  child: bones.slice(1).find((b) => OFFSET[b] !== undefined),
  axis: axisOf(rig, byName.get(node), axis),
}));

/* ---------------- 軸の指定そのものが正しいか ----------------
   «向きが合っているか» の検査は MAP の軸を前提にしてしまうので、
   軸を間違えて指定した場合（Hips の軸に横向きの Joint_HipR を拾う等）は
   すり抜ける。そこで軸だけは «メッシュが実際にどちらへ伸びているか» と
   突き合わせる。パーツはどれも関節から片側へ伸びる箱なので、
   ローカル境界箱の中心の向きがそのまま伸びる向きになる */
for (const { node, axis } of CHECK) {
  const n = gltf.nodes[byName.get(node)];
  const prim = gltf.meshes[n.mesh].primitives[0];
  const acc = gltf.accessors[prim.attributes.POSITION];
  const c = unit(acc.min.map((v, i) => v + acc.max[i]));
  const deg = Math.acos(Math.min(1, Math.max(-1, dot(c, axis)))) * 180 / Math.PI;
  assert.ok(deg < 25,
    `${node} の軸 [${axis.map((v) => v.toFixed(2))}] が、メッシュの伸びる向き ` +
    `[${c.map((v) => v.toFixed(2))}] と ${deg.toFixed(0)}度 食い違っている`);
}

/* ---------------- 検査するポーズ ----------------
   T ポーズそのままだけだと «静止姿勢を写しただけ» でも通ってしまうので、
   胴をひねり、腕を畳み、脚を曲げた «釣りらしい» 姿勢を混ぜる */
const POSES = [
  {},
  {
    Spine1: qAxis([1, 0, 0], 0.25),
    Spine2: qAxis([0, 1, 0], -0.35),
    RightArm: qmul(qAxis([0, 0, 1], -1.1), qAxis([0, 1, 0], 0.6)),
    RightForeArm: qAxis([0, 1, 0], 1.2),
    LeftArm: qAxis([0, 0, 1], 0.9),
    LeftForeArm: qAxis([0, 1, 0], -1.0),
    LeftUpLeg: qAxis([1, 0, 0], 0.3),
    LeftLeg: qAxis([1, 0, 0], -0.5),
    Head: qAxis([1, 0, 0], -0.2),
  },
  {
    Hips: qAxis([0, 1, 0], 0.4),
    Spine: qAxis([1, 0, 0], -0.3),
    RightArm: qAxis([0, 0, 1], -1.6),
    RightForeArm: qAxis([0, 1, 0], 0.4),
    RightFoot: qAxis([1, 0, 0], 0.4),
  },
];

const frames = [];
const posed = POSES.map((p) => poseSkeleton(p));
for (const { snap } of posed) frames.push(snap);
const rest = poseSkeleton({}).snap;

const dir = mkdtempSync(join(tmpdir(), 'mixamo-retarget-'));
const dumpPath = join(dir, 'dump.json');
const outPath = join(dir, 'clip.json');
writeFileSync(dumpPath, JSON.stringify({
  source: 'synthetic', action: 'SyntheticFishing', fps: 30,
  frameStart: 0, frameEnd: frames.length - 1,
  order: SKEL.map(([n]) => n), parent: PARENT, children: {},
  rest, frames,
}));

const r = spawnSync(process.execPath, [
  join(root, 'scripts/mixamo-retarget.mjs'),
  '--dump', dumpPath, '--out', outPath, '--yaw', 'keep', '--root', 'full',
], { cwd: root, encoding: 'utf8' });
assert.strictEqual(r.status, 0, `リターゲットが失敗した:\n${r.stdout}\n${r.stderr}`);
assert.doesNotMatch(r.stdout, /対応が取れなかった部位/, `骨の対応が落ちている:\n${r.stdout}`);

const clip = JSON.parse(readFileSync(outPath, 'utf8'));

/* --- 出力の形 --- */
assert.strictEqual(clip.name, 'SyntheticFishing', 'クリップ名がアクション名にならない');

/* uuid が無いと THREE.AnimationClip.parse が clip.uuid = undefined にしてしまい、
   AnimationMixer.clipAction のキャッシュがクリップ間で衝突する。
   «2 本目のモーションに切り替えたのに 1 本目が鳴り続ける» という、
   見た目からは原因の分からない壊れ方をするので、形と一意性を押さえておく */
assert.match(clip.uuid || '', /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/,
  `uuid が uuid の形をしていない: ${clip.uuid}`);
{
  const run = (name, out) => {
    const rr = spawnSync(process.execPath, [
      join(root, 'scripts/mixamo-retarget.mjs'),
      '--dump', dumpPath, '--out', out, '--name', name, '--yaw', 'keep',
    ], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(rr.status, 0, `リターゲットが失敗した:\n${rr.stdout}\n${rr.stderr}`);
    return JSON.parse(readFileSync(out, 'utf8')).uuid;
  };
  const a = run('SyntheticFishing', join(dir, 'again.json'));
  const b = run('SomethingElse', join(dir, 'other.json'));
  assert.strictEqual(a, clip.uuid, 'uuid が作り直すたびに変わる（差分が無駄に出る）');
  assert.notStrictEqual(a, b, 'クリップ名が違うのに uuid が同じ');
}
assert.ok(Math.abs(clip.duration - (frames.length - 1) / 30) < 1e-6, '尺が fps と合わない');
for (const tr of clip.tracks) {
  assert.strictEqual(tr.times.length, frames.length, `${tr.name}: キー数がフレーム数と違う`);
  const stride = tr.type === 'quaternion' ? 4 : 3;
  assert.strictEqual(tr.values.length, frames.length * stride, `${tr.name}: 値の数が合わない`);
  assert.ok(tr.values.every(Number.isFinite), `${tr.name}: NaN が混じっている`);
}
const names = new Set(clip.tracks.map((t) => t.name));
for (const { node } of CHECK) {
  assert.ok(names.has(`${node}.quaternion`), `${node} のトラックが無い`);
}
assert.ok(names.has('Hips.position'), 'Hips の移動トラックが無い');

/* --- 本題：伸びる軸が Mixamo の骨の向きに一致するか --- */
const qTracks = new Map(
  clip.tracks.filter((t) => t.type === 'quaternion').map((t) => [t.name.replace('.quaternion', ''), t])
);
let worst = 0, worstAt = '';
for (let f = 0; f < frames.length; f++) {
  const localQ = new Map();
  for (const [node, tr] of qTracks) localQ.set(node, tr.values.slice(f * 4, f * 4 + 4));
  const world = forward(localQ);
  for (const { node, root: boneA, child: boneB, axis } of CHECK) {
    const want = unit(sub(posed[f].wp[boneB], posed[f].wp[boneA]));
    const got = unit(qapply(world.get(node).q, axis));
    const deg = Math.acos(Math.min(1, Math.max(-1, dot(want, got)))) * 180 / Math.PI;
    if (deg > worst) { worst = deg; worstAt = `${node} (frame ${f})`; }
  }
}
assert.ok(worst < 0.05, `パーツの向きが Mixamo の骨とずれている: 最大 ${worst.toFixed(3)}° @ ${worstAt}`);

/* --- 握りの情報 ----------------------------------------------------------
   竿は右手へ剛体で付けるので «右手ローカルで見た竿の軸» が要る。
   素体は Mixamo より腕が短く、向きを合わせると両手が 1 点に集まらないので、
   左腕は実行時に IK で竿へ戻す。ただしキャスト後半のように本当に手を
   離している区間まで戻すと嘘になるため、握っている度合いも一緒に出す */
{
  const g = clip.grip;
  assert.ok(g, '握りの情報 (grip) が出ていない');
  assert.ok(Math.abs(Math.hypot(...g.axis) - 1) < 1e-3,
    `竿の軸が単位ベクトルでない: [${g.axis}]`);
  assert.strictEqual(g.leftGrip.length, frames.length, '握りの重みがフレーム数と違う');
  assert.ok(g.leftGrip.every((v) => v >= 0 && v <= 1), '握りの重みが 0..1 に収まっていない');

  // 軸は外から固定できること（クリップごとに違う軸になると、切り替えで竿が飛ぶ）
  const forced = join(dir, 'forced.json');
  const rr = spawnSync(process.execPath, [
    join(root, 'scripts/mixamo-retarget.mjs'),
    '--dump', dumpPath, '--out', forced, '--yaw', 'keep', '--rod-axis', '0,0,1',
  ], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(rr.status, 0, `--rod-axis つきで失敗した:\n${rr.stdout}\n${rr.stderr}`);
  assert.deepStrictEqual(JSON.parse(readFileSync(forced, 'utf8')).grip.axis, [0, 0, 1],
    '--rod-axis で渡した軸が使われていない');
}

/* --- 腰の高さは «こちらの背丈» に正規化されること --- */
const hips = clip.tracks.find((t) => t.name === 'Hips.position');
const restY = gltf.nodes[byName.get('Hips')].translation[1];
assert.ok(Math.abs(hips.values[1] - restY) < 1e-4, '静止フレームで腰が静止位置から動いている');
{
  // 合成側は cm（腰 100）、素体は m（腰 0.9）。3 フレーム目は腰を回しただけなので
  // 高さは変わらないが、単位のまま流し込んでいれば桁で破綻する
  const ys = [];
  for (let f = 0; f < frames.length; f++) ys.push(hips.values[f * 3 + 1]);
  const span = Math.max(...ys) - Math.min(...ys);
  assert.ok(span < 0.2, `腰の上下が大きすぎる（単位の取り違え？） span=${span.toFixed(3)}m`);
}

console.log(`mixamo リターゲット: OK（向きのずれ 最大 ${worst.toFixed(4)}°, トラック ${clip.tracks.length} 本）`);
