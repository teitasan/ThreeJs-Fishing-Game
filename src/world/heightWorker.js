/* ===========================================================
   高さ場の module Worker
   -----------------------------------------------------------
   メインスレッドの湖を受け取れない（関数を渡せない）ので、resolveLake が
   選んだ最終のシードで makeLake を作り直す。作り直した湖が同じかどうかは
   固定点の高さ（PROBES）をメインに返して、メイン側でビット一致を確かめる。
   =========================================================== */
import { makeLake } from '../lakefield.js';
import { bakeRows, probeHeights } from './heightgrid.js';

const lakes = new Map();
const lakeFor = (seed) => {
  let l = lakes.get(seed);
  if (!l) { l = makeLake(seed); lakes.set(seed, l); }
  return l;
};

self.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.type !== 'job') return;
  try {
    const lake = lakeFor(m.seed);
    const data = bakeRows(lake, m.kind, m.j0, m.j1, m.skip);
    self.postMessage({ type: 'done', id: m.id, seed: lake.seed, probes: probeHeights(lake), data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
});

self.postMessage({ type: 'ready' });
