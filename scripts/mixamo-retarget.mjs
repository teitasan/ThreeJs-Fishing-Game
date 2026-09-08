/* ===========================================================
   Mixamo のモーションを釣り人（player-lowpoly.glb）へリターゲットする

     node scripts/mixamo-retarget.mjs --dump <dump.json> --out assets/motions/xxx.json
       [--name Fishing] [--root none|y|full] [--yaw auto|keep|<deg>]

   ダンプは scripts/mixamo-dump.py が Blender で吐いたもの。

   ■ なぜ「回転のコピー」ではなく「向き合わせ」なのか
   Mixamo の素体は T ポーズ、こちらの釣り人は腕を下ろした I ポーズで、
   静止姿勢が 90 度ちがう。回転をそのまま移すと腕が体にめり込む。
   こちらの素体は各パーツの原点＝関節位置で、パーツは決まった局所軸へ
   伸びているだけなので、「その軸を Mixamo の骨の向きへ合わせる」ほうが
   静止姿勢の違いに一切影響されない（angler.js の _aimBone と同じ考え方）。

   ■ ねじりも拾う
   向きだけ合わせると、腕や胴のねじり（ロール）が落ちて棒のように見える。
   そこで、フレーム f のこちらのパーツのワールド回転を

       R(f) = M̂(f) · K       K = M̂(0)⁻¹ · A⁻¹ · R(0)

   と決める。M̂(f) は Mixamo の骨のワールド回転を「局所 +Y ＝ 骨の向き」に
   直したもの、R(0) はこちらの静止ワールド回転、A は「Mixamo の静止向き →
   こちらの静止向き」の最小回転。K は骨ごとに 1 回出す定数で、
   これだと R(f)·u ＝ Mixamo の骨の向き が厳密に成り立ちつつ
   （u はこちらのパーツが伸びる局所軸）、ロールは Mixamo のものが乗る。
   =========================================================== */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';

/* ---------------- 素体のどのパーツを、どの骨に合わせるか ----------------
   dir: Mixamo 側の [根元の骨, 向きの先の骨]
   axis: こちらのパーツが伸びる局所軸。子の局所位置から決まるものは省略でき、
         葉（手・足）だけ明示する（HandL は局所 -Y、FootL は局所 -Z へ伸びる） */
const MAP = [
  ['Hips',      ['Hips', 'Spine']],
  ['Waist',     ['Spine', 'Spine1']],
  ['Belly',     ['Spine1', 'Spine2']],
  ['Chest',     ['Spine2', 'Neck']],
  ['Head',      ['Head', 'HeadTop_End']],
  ['UpperArmL', ['LeftArm', 'LeftForeArm']],
  ['LowerArmL', ['LeftForeArm', 'LeftHand']],
  ['HandL',     ['LeftHand', 'LeftHandMiddle1', 'LeftHandIndex1'], [0, -1, 0]],
  ['UpperArmR', ['RightArm', 'RightForeArm']],
  ['LowerArmR', ['RightForeArm', 'RightHand']],
  ['HandR',     ['RightHand', 'RightHandMiddle1', 'RightHandIndex1'], [0, -1, 0]],
  ['UpperLegL', ['LeftUpLeg', 'LeftLeg']],
  ['LowerLegL', ['LeftLeg', 'LeftFoot']],
  ['FootL',     ['LeftFoot', 'LeftToeBase', 'LeftToe_End'], [0, 0, -1]],
  ['UpperLegR', ['RightUpLeg', 'RightLeg']],
  ['LowerLegR', ['RightLeg', 'RightFoot']],
  ['FootR',     ['RightFoot', 'RightToeBase', 'RightToe_End'], [0, 0, -1]],
];

/* ---------------- ベクトルとクォータニオン ---------------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 1e-9) return [0, 1, 0];
  return [v[0] / n, v[1] / n, v[2] / n];
}
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
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
function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
/** from → to の最小回転（three の setFromUnitVectors と同じ） */
function qBetween(from, to) {
  const a = unit(from), b = unit(to);
  let r = dot(a, b) + 1;
  if (r < 1e-6) {
    // 真逆。適当な直交軸まわりに 180 度
    r = 0;
    const c = Math.abs(a[0]) > Math.abs(a[2]) ? [-a[1], a[0], 0] : [0, -a[2], a[1]];
    return qnorm([c[0], c[1], c[2], 0]);
  }
  const c = cross(a, b);
  return qnorm([c[0], c[1], c[2], r]);
}
/** 直交化した基底（列 x,y,z）→ クォータニオン */
function qFromBasis(bx, by, bz) {
  const y = unit(by);
  let x = sub(unit(bx), y.map((v) => v * dot(unit(bx), y)));
  if (Math.hypot(...x) < 1e-6) x = unit(cross(y, unit(bz)));
  x = unit(x);
  const z = cross(x, y);
  const m = [x, y, z];   // m[col][row]
  const g = (r, c) => m[c][r];
  const tr = g(0, 0) + g(1, 1) + g(2, 2);
  let q;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(g(2, 1) - g(1, 2)) * s, (g(0, 2) - g(2, 0)) * s, (g(1, 0) - g(0, 1)) * s, 0.25 / s];
  } else if (g(0, 0) > g(1, 1) && g(0, 0) > g(2, 2)) {
    const s = 2 * Math.sqrt(1 + g(0, 0) - g(1, 1) - g(2, 2));
    q = [0.25 * s, (g(0, 1) + g(1, 0)) / s, (g(0, 2) + g(2, 0)) / s, (g(2, 1) - g(1, 2)) / s];
  } else if (g(1, 1) > g(2, 2)) {
    const s = 2 * Math.sqrt(1 + g(1, 1) - g(0, 0) - g(2, 2));
    q = [(g(0, 1) + g(1, 0)) / s, 0.25 * s, (g(1, 2) + g(2, 1)) / s, (g(0, 2) - g(2, 0)) / s];
  } else {
    const s = 2 * Math.sqrt(1 + g(2, 2) - g(0, 0) - g(1, 1));
    q = [(g(0, 2) + g(2, 0)) / s, (g(1, 2) + g(2, 1)) / s, 0.25 * s, (g(1, 0) - g(0, 1)) / s];
  }
  return qnorm(q);
}

/* ---------------- 素体（GLB）の階層を読む ---------------- */
function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb: ' + path);
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) return JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len;
  }
  throw new Error('no json chunk: ' + path);
}

function buildRig(gltf) {
  const nodes = gltf.nodes;
  const byName = new Map();
  const parent = new Map();
  nodes.forEach((n, i) => {
    byName.set(n.name, i);
    for (const c of n.children || []) parent.set(c, i);
  });
  const local = (i) => ({
    t: nodes[i].translation || [0, 0, 0],
    q: nodes[i].rotation || [0, 0, 0, 1],
  });
  /** 静止時のワールド回転と位置 */
  const world = new Map();
  const walk = (i, pq, pp) => {
    const { t, q } = local(i);
    const rt = qapply(pq, t);
    const wp = [pp[0] + rt[0], pp[1] + rt[1], pp[2] + rt[2]];
    const wq = qmul(pq, q);
    world.set(i, { q: wq, p: wp });
    for (const c of nodes[i].children || []) walk(c, wq, wp);
  };
  const roots = gltf.scenes[0].nodes;
  for (const r of roots) walk(r, [0, 0, 0, 1], [0, 0, 0]);
  return { nodes, byName, parent, local, world, roots };
}

/* ---------------- 引数 ---------------- */
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const dumpPath = arg('dump');
const outPath = arg('out');
if (!dumpPath || !outPath) {
  console.error('usage: node scripts/mixamo-retarget.mjs --dump <dump.json> --out <clip.json> [--name N] [--root none|y|full] [--yaw auto|keep|<deg>]');
  process.exit(1);
}
const rootMode = arg('root', 'y');
const yawMode = arg('yaw', 'auto');
const bodyPath = arg('body', 'assets/models/player-lowpoly.glb');

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const clipName = arg('name', dump.action || basename(dumpPath).replace(/\.json$/, ''));
const rig = buildRig(readGlb(bodyPath));

/* ---------------- 骨ごとの下ごしらえ ---------------- */
/** Mixamo 側：骨の向きを「局所 +Y」に直したワールド回転 */
function mixQuat(snap, boneName, childName) {
  const b = snap[boneName];
  const raw = qFromBasis(b.x, b.y, b.z);
  const c = childName ? snap[childName] : null;
  const dir = c ? unit(sub(c.head, b.head)) : qapply(raw, [0, 1, 0]);
  return { q: qmul(qBetween(qapply(raw, [0, 1, 0]), dir), raw), dir };
}

const plan = [];
const missing = [];
for (const [nodeName, bones, axis] of MAP) {
  const idx = rig.byName.get(nodeName);
  if (idx === undefined) { missing.push(nodeName + ' (素体に無い)'); continue; }
  const root = bones[0];
  if (!dump.rest[root]) { missing.push(nodeName + ' ← ' + root + ' (Mixamo に無い)'); continue; }
  const child = bones.slice(1).find((b) => dump.rest[b]) || null;

  // こちらのパーツが伸びる局所軸 u。子の局所位置から決まるなら、それを使う
  let u = axis;
  if (!u) {
    const kid = (rig.nodes[idx].children || [])
      .map((c) => rig.local(c).t)
      .find((t) => Math.hypot(...t) > 1e-6);
    u = kid ? unit(kid) : [0, -1, 0];
  }
  u = unit(u);

  const R0 = rig.world.get(idx).q;
  const d0 = qapply(R0, u);                       // こちらの静止向き（ワールド）
  const M0 = mixQuat(dump.rest, root, child);     // Mixamo の静止姿勢
  const A = qBetween(M0.dir, d0);                 // Mixamo の静止向き → こちらの静止向き
  const K = qmul(qmul(qinv(M0.q), qinv(A)), R0);
  plan.push({ nodeName, idx, root, child, K });
}

/* ---------------- 体の向きの補正 ---------------- */
let yawQ = [0, 0, 0, 1];
if (yawMode !== 'keep') {
  let deg = 0;
  if (yawMode === 'auto') {
    const hips = plan.find((p) => p.nodeName === 'Hips');
    if (hips) {
      const R = qmul(mixQuat(dump.frames[0], hips.root, hips.child).q, hips.K);
      const f = qapply(R, [0, 0, 1]);
      deg = Math.atan2(f[0], f[2]) * 180 / Math.PI;
    }
  } else {
    deg = -Number(yawMode) || 0;
  }
  const h = -deg * Math.PI / 360;
  yawQ = [0, Math.sin(h), 0, Math.cos(h)];
}

/* ---------------- 毎フレーム解く ---------------- */
const byIdx = new Map(plan.map((p) => [p.idx, p]));
const times = [];
const tracks = new Map(plan.map((p) => [p.idx, []]));
const hipsPos = [];
const hipsIdx = rig.byName.get('Hips');
const hipsRest = rig.local(hipsIdx).t;
const hipsBone = plan.find((p) => p.nodeName === 'Hips');
const scale = hipsBone
  ? rig.world.get(hipsIdx).p[1] / Math.max(1e-6, dump.rest[hipsBone.root].head[1])
  : 1;
const hips0 = hipsBone ? dump.frames[0][hipsBone.root].head : [0, 0, 0];

const solve = (idx, parentQ, snap) => {
  const p = byIdx.get(idx);
  let localQ;
  let worldQ;
  if (p) {
    let R = qmul(mixQuat(snap, p.root, p.child).q, p.K);
    if (idx === hipsIdx) R = qmul(yawQ, R);
    localQ = qnorm(qmul(qinv(parentQ), R));
    worldQ = R;
  } else {
    localQ = rig.local(idx).q;
    worldQ = qmul(parentQ, localQ);
  }
  if (p) {
    const arr = tracks.get(idx);
    const prev = arr.length >= 4 ? arr.slice(-4) : null;
    // 隣り合うキーで符号が反転すると回りすぎるので、内積が正になる側へ揃える
    if (prev && prev[0] * localQ[0] + prev[1] * localQ[1] + prev[2] * localQ[2] + prev[3] * localQ[3] < 0) {
      localQ = localQ.map((v) => -v);
    }
    arr.push(...localQ);
  }
  for (const c of rig.nodes[idx].children || []) solve(c, worldQ, snap);
};

dump.frames.forEach((snap, i) => {
  times.push(i / dump.fps);
  for (const r of rig.roots) solve(r, [0, 0, 0, 1], snap);
  if (rootMode !== 'none' && hipsBone) {
    const d = sub(snap[hipsBone.root].head, hips0).map((v) => v * scale);
    const dr = qapply(yawQ, d);
    hipsPos.push(
      rootMode === 'full' ? hipsRest[0] + dr[0] : hipsRest[0],
      hipsRest[1] + dr[1],
      rootMode === 'full' ? hipsRest[2] + dr[2] : hipsRest[2],
    );
  }
});
/* ---------------- three.js の AnimationClip JSON ---------------- */
const round = (a, n = 5) => a.map((v) => Number(v.toFixed(n)));
const clip = {
  name: clipName,
  duration: times[times.length - 1],
  tracks: plan.map((p) => ({
    name: `${p.nodeName}.quaternion`,
    type: 'quaternion',
    times: round(times, 4),
    values: round(tracks.get(p.idx)),
  })),
};
if (rootMode !== 'none' && hipsPos.length) {
  clip.tracks.push({
    name: 'Hips.position',
    type: 'vector3',
    times: round(times, 4),
    values: round(hipsPos),
  });
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(clip));
console.log(
  `RETARGET_OK "${clipName}" ${times.length}f / ${clip.duration.toFixed(2)}s  tracks=${clip.tracks.length}  -> ${outPath}`
);
if (missing.length) console.log('  対応が取れなかった部位:', missing.join(', '));
