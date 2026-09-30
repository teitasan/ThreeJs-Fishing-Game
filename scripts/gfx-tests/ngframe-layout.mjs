#!/usr/bin/env node
/* ===========================================================
   ngframe-layout（ARCHITECTURE §9-9 / §4.1）
   - 生成した GLSL の #define が JS の表（NG_SLOTS）と 1 対 1
   - slot 0..23 がちょうど 1 回ずつ現れ、書く人が §4.1 の表どおり
   - 同じ slot の成分が重ならない、名前が ng 接頭辞で一意
   - マクロ名が GLSL ライブラリの関数名とぶつからない（マクロは全トークンを置換する）
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { NG_SLOTS, NG_FRAME_GLSL, NG_FRAME_VEC4, ngFrameData, NG, NgFrame } = await imp('src/gfx/core/frame.js');

check(NG_FRAME_VEC4 === 24 && ngFrameData.length === 96, 'ngFrame は 24 vec4');
check(NG_FRAME_GLSL.includes('uniform vec4 ngFrame[ 24 ];'), 'uniform の宣言');
check(NG_FRAME_GLSL.includes('#ifndef NG_LIB_FRAME'), 'インクルードガード');
check(NG_SLOTS.length === 24 && NG_SLOTS.every((s, i) => s.slot === i), 'slot 0..23 が 1 回ずつ順に');

const OWNERS = { sky: [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 17], core: [8, 11, 14, 15, 18], underwater: [9, 10], post: [16] };
for (const [owner, slots] of Object.entries(OWNERS)) {
  for (const s of slots) check(NG_SLOTS[s].owner === owner, `slot ${s} の書く人は ${owner}（表は ${NG_SLOTS[s].owner}）`);
}
for (let s = 19; s < 24; s++) check(NG_SLOTS[s].owner === 'reserved' && Object.keys(NG_SLOTS[s].fields).length === 0, `slot ${s} は予備`);

const names = new Set();
const defs = [...NG_FRAME_GLSL.matchAll(/#define (ng\w+) ngFrame\[ (\d+) \]\.(\w+)/g)];
let fields = 0;
for (const s of NG_SLOTS) {
  const used = new Set();
  for (const [sw, name] of Object.entries(s.fields)) {
    fields++;
    check(/^ng[A-Z]/.test(name), `${name} は ng 接頭辞`);
    check(!names.has(name), `${name} が一意`);
    names.add(name);
    const d = defs.find((m) => m[1] === name);
    check(d && Number(d[2]) === s.slot && d[3] === sw, `${name} → ngFrame[${s.slot}].${sw}`);
    for (const c of sw) { check(!used.has(c), `slot ${s.slot} の成分 ${c} が重ならない`); used.add(c); }
  }
}
check(defs.length === fields, `#define の数 ${defs.length} = 表の成分 ${fields}`);
check(NG.KEY === 0 && NG.CAM === 8 && NG.EXPO === 16 && NG.CLOUDS === 17, 'NG の slot 番号');

/* マクロと関数名の衝突 */
const libs = ['noise', 'medium', 'surface', 'wind', 'shadow', 'heightfield', 'hextile', 'oct', 'bluenoise'];
const fnNames = new Set();
for (const l of libs) {
  const m = await imp(`src/gfx/core/glsl/${l}.glsl.js`);
  for (const v of Object.values(m)) {
    if (typeof v !== 'string') continue;
    for (const f of v.matchAll(/\b(?:float|vec[234]|void|mat[234]|bool|ivec[234])\s+(ng\w+)\s*\(/g)) fnNames.add(f[1]);
  }
}
for (const n of names) check(!fnNames.has(n), `マクロ ${n} が関数名とぶつからない`);
check(fnNames.size > 30, `ライブラリの関数を拾えている（${fnNames.size}）`);

/* NgFrame：NaN を入れない、beginPass が slot 8 を書く */
const f = new NgFrame();
f.set(NG.KEY, NaN, Infinity, 1, 2);
check(ngFrameData[0] === 0 && ngFrameData[1] === 0 && ngFrameData[2] === 1, 'set は非有限を 0 に丸める');
f.cam.uw = 1; f.cam.waterY = 0.1;
f.beginPass(1, { position: { y: 2.1 } });
check(ngFrameData[32] === 1 && Math.abs(ngFrameData[33] - 0.1) < 1e-6 && Math.abs(ngFrameData[34] - 2.0) < 1e-6 && ngFrameData[35] === 1, 'beginPass が slot 8');

done('ngframe-layout');
