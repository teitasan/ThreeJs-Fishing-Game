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
function readGlb(path) {
  const buf = readFileSync(path);
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    if (buf.readUInt32LE(off + 4) === 0x4e4f534a) {
      return JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
    }
    off += 8 + len;
  }
  throw new Error('no json chunk');
}
const gltf = readGlb(join(root, 'assets/models/player-lowpoly.glb'));
const byName = new Map(gltf.nodes.map((n, i) => [n.name, i]));

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

/** そのパーツが伸びる局所軸（葉だけ明示。retarget 側の MAP と同じ） */
const AXIS = { HandL: [0, -1, 0], HandR: [0, -1, 0], FootL: [0, 0, -1], FootR: [0, 0, -1] };
function axisOf(name) {
  if (AXIS[name]) return unit(AXIS[name]);
  const n = gltf.nodes[byName.get(name)];
  const kid = (n.children || [])
    .map((c) => gltf.nodes[c].translation || [0, 0, 0])
    .find((t) => Math.hypot(...t) > 1e-6);
  return unit(kid || [0, -1, 0]);
}

/* 素体のパーツ → Mixamo の [根元, 向きの先] */
const CHECK = [
  ['Hips', 'Hips', 'Spine'],
  ['Waist', 'Spine', 'Spine1'],
  ['Belly', 'Spine1', 'Spine2'],
  ['Chest', 'Spine2', 'Neck'],
  ['Head', 'Head', 'HeadTop_End'],
  ['UpperArmL', 'LeftArm', 'LeftForeArm'],
  ['LowerArmL', 'LeftForeArm', 'LeftHand'],
  ['HandL', 'LeftHand', 'LeftHandMiddle1'],
  ['UpperArmR', 'RightArm', 'RightForeArm'],
  ['LowerArmR', 'RightForeArm', 'RightHand'],
  ['HandR', 'RightHand', 'RightHandMiddle1'],
  ['UpperLegL', 'LeftUpLeg', 'LeftLeg'],
  ['LowerLegL', 'LeftLeg', 'LeftFoot'],
  ['FootL', 'LeftFoot', 'LeftToeBase'],
  ['UpperLegR', 'RightUpLeg', 'RightLeg'],
  ['LowerLegR', 'RightLeg', 'RightFoot'],
  ['FootR', 'RightFoot', 'RightToeBase'],
];

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
assert.ok(Math.abs(clip.duration - (frames.length - 1) / 30) < 1e-6, '尺が fps と合わない');
for (const tr of clip.tracks) {
  assert.strictEqual(tr.times.length, frames.length, `${tr.name}: キー数がフレーム数と違う`);
  const stride = tr.type === 'quaternion' ? 4 : 3;
  assert.strictEqual(tr.values.length, frames.length * stride, `${tr.name}: 値の数が合わない`);
  assert.ok(tr.values.every(Number.isFinite), `${tr.name}: NaN が混じっている`);
}
const names = new Set(clip.tracks.map((t) => t.name));
for (const [node] of CHECK) {
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
  for (const [node, boneA, boneB] of CHECK) {
    const want = unit(sub(posed[f].wp[boneB], posed[f].wp[boneA]));
    const got = unit(qapply(world.get(node).q, axisOf(node)));
    const deg = Math.acos(Math.min(1, Math.max(-1, dot(want, got)))) * 180 / Math.PI;
    if (deg > worst) { worst = deg; worstAt = `${node} (frame ${f})`; }
  }
}
assert.ok(worst < 0.05, `パーツの向きが Mixamo の骨とずれている: 最大 ${worst.toFixed(3)}° @ ${worstAt}`);

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
