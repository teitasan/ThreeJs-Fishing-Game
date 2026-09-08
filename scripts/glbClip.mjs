/* ===========================================================
   GLB のアニメーションを Node から読む

   three を使わずに、クリップのチャンネルとキーフレームを取り出して
   任意の時刻の姿勢を作る。検査（scripts/*-test.mjs）が «実データの幾何» を
   確かめられるようにするためのもの。
   =========================================================== */
import { readFileSync } from 'node:fs';

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** GLB を JSON チャンクとバイナリチャンクに分ける */
export function openGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb: ' + path);
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  if (!json) throw new Error('no json chunk: ' + path);
  return { json, bin };
}

/** アクセサを型付き配列にする（疎な bufferView・stride つきも読む） */
export function readAccessor({ json, bin }, index) {
  const acc = json.accessors[index];
  const n = NUM[acc.type];
  const Type = COMP[acc.componentType];
  if (!Type) throw new Error('未対応の componentType: ' + acc.componentType);
  const out = new Float32Array(acc.count * n);
  if (acc.bufferView === undefined) return out;   // 全部ゼロ
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const packed = n * Type.BYTES_PER_ELEMENT;
  const stride = bv.byteStride || packed;
  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride;
    const src = new Type(bin.buffer, bin.byteOffset + at, n);
    for (let k = 0; k < n; k++) out[i * n + k] = src[k];
  }
  return out;
}

const qslerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let B = b;
  if (d < 0) { B = b.map((v) => -v); d = -d; }
  if (d > 0.9995) {
    const o = a.map((v, i) => v + (B[i] - v) * t);
    const n = Math.hypot(...o) || 1;
    return o.map((v) => v / n);
  }
  const th = Math.acos(d), s = Math.sin(th);
  const w1 = Math.sin((1 - t) * th) / s, w2 = Math.sin(t * th) / s;
  return a.map((v, i) => v * w1 + B[i] * w2);
};

/**
 * 名前でクリップを取り、時刻から «ノード番号 → {t,q,s}» を返す関数を作る。
 * 補間は LINEAR と STEP。Blender の glTF 書き出しはこのどちらか
 */
export function clipSampler(glb, name) {
  const { json } = glb;
  const anim = (json.animations || []).find((a) => a.name === name);
  if (!anim) throw new Error(`クリップ ${name} が無い（あるのは ${(json.animations || []).map((a) => a.name)}）`);
  const chans = [];
  let duration = 0;
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const times = readAccessor(glb, s.input);
    const values = readAccessor(glb, s.output);
    const interp = s.interpolation || 'LINEAR';
    if (interp === 'CUBICSPLINE') throw new Error('CUBICSPLINE は未対応');
    const stride = values.length / times.length;
    chans.push({ node: ch.target.node, path: ch.target.path, times, values, stride, interp });
    duration = Math.max(duration, times[times.length - 1]);
  }
  const sample = (c, time) => {
    const { times, values, stride } = c;
    let i = 0;
    while (i < times.length - 1 && times[i + 1] < time) i++;
    const a = values.slice(i * stride, i * stride + stride);
    if (i >= times.length - 1 || c.interp === 'STEP') return Array.from(a);
    const b = values.slice((i + 1) * stride, (i + 1) * stride + stride);
    const span = times[i + 1] - times[i];
    const t = span > 1e-9 ? (time - times[i]) / span : 0;
    if (c.path === 'rotation') return qslerp(Array.from(a), Array.from(b), t);
    return Array.from(a).map((v, k) => v + (b[k] - v) * t);
  };
  return {
    duration,
    channels: chans,
    at(time) {
      const pose = new Map();
      for (const c of chans) {
        let e = pose.get(c.node);
        if (!e) { e = {}; pose.set(c.node, e); }
        e[c.path] = sample(c, Math.min(Math.max(time, 0), duration));
      }
      return pose;
    },
  };
}

/* ---------------- 姿勢を解く ---------------- */
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qapply = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
export const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vunit = (v) => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
/** from → to の最小回転 */
export function qBetween(a, b) {
  const A = vunit(a), B = vunit(b);
  const c = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
  const q = [c[0], c[1], c[2], A[0] * B[0] + A[1] * B[1] + A[2] * B[2] + 1];
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n);
}

/**
 * ポーズ（clipSampler().at() の戻り）から、指定した名前のノードの
 * ワールド位置と姿勢を出す。スケールも掛けるので単位はメートルになる
 * （glTF の Armature ノードはスケール 0.01 ＝ 骨格が cm）
 */
export function poseWorld({ json }, pose, want) {
  const nodes = json.nodes;
  const names = nodes.map((n) => n.name || '');
  const out = new Map();
  const walk = (i, pq, pp, ps) => {
    const n = nodes[i];
    const e = (pose && pose.get(i)) || {};
    const t = (e.translation || n.translation || [0, 0, 0]).map((v, k) => v * ps[k]);
    const r = e.rotation || n.rotation || [0, 0, 0, 1];
    const sc = e.scale || n.scale || [1, 1, 1];
    const rt = qapply(pq, t);
    const p = [pp[0] + rt[0], pp[1] + rt[1], pp[2] + rt[2]];
    const q = qmul(pq, r);
    if (!want || want.has(names[i])) out.set(names[i], { p, q });
    for (const c of n.children || []) walk(c, q, p, [ps[0] * sc[0], ps[1] * sc[1], ps[2] * sc[2]]);
  };
  for (const r of json.scenes[0].nodes) walk(r, [0, 0, 0, 1], [0, 0, 0], [1, 1, 1]);
  return out;
}
export { qmul };
