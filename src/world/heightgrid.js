/* ===========================================================
   高さ場の標本化（three・DOM 無し。Worker とメインスレッドで共通）
   -----------------------------------------------------------
   描画は地形・水・影・草のすべてが «同じ高さ» を見る必要があるので、
   lake.heightAt を格子に焼いて GPU へ渡す（core の heightfield.js）。
     near : 1040² @0.5m、原点 (-260,-260)。汀線 + 72m の最大 244m を覆う
     far  : 1024² @1m、  原点 (-512,-512)
     bed  : 260²  @2m、  原点 (-260,-260)。RGBA8 = mud, sand, rock の重み + v（lake.bedAt と同じ）
   値 [j·n + i] は (origin.x + i·step, origin.z + j·step) の標本（頂点中心）。
   補間は GPU でも CPU でも «手動のバイリニア»（sampleGrid）。Float32 の線形補間
   拡張（OES_texture_float_linear）に頼らない。

   2.1M 回の heightAt は 1 本だと 0.8s かかるので module Worker 4 本に割る。
   Worker は resolveLake が選んだ «最終のシード» で makeLake を作り直し、
   数点の高さがメインスレッドの湖とビット一致することを確かめてから焼く。
   一致しなければ（lakefield が変わった・Worker が古いキャッシュ等）メインで焼く。
   =========================================================== */

export const GRID_SPECS = {
  near: { n: 1040, origin: [-260, -260], step: 0.5 },
  far: { n: 1024, origin: [-512, -512], step: 1.0 },
  bed: { n: 260, origin: [-260, -260], step: 2.0 },
};

/* far のうち near と同じ点（整数座標）になる範囲。ここは near から写す */
const FAR_FROM_NEAR = (() => {
  const nr = GRID_SPECS.near, fr = GRID_SPECS.far;
  const i0 = nr.origin[0] - fr.origin[0];                       // 252
  const i1 = i0 + Math.floor((nr.n - 1) * nr.step / fr.step);   // 771
  return { i0, i1, j0: i0, j1: i1, ratio: fr.step / nr.step };
})();

/** 検証に使う固定の点（湖の中・汀線・山・遠景） */
export const PROBES = [
  [0, 0], [37.5, -12.25], [-118, 64], [131.5, 8], [-40, -150], [210, -205], [-333, 402], [480, 17],
  [-97.25, -96.5], [12, 144], [155, 155], [-250, 3], [60.5, -220], [-499, -499], [301, -12], [-7, 260],
];

/** 32bit FNV-1a（ワード単位）。格子の中身の指紋 */
export function fnv1aWords(u32, h = 0x811c9dc5) {
  for (let i = 0; i < u32.length; i++) {
    h ^= u32[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 湖の数点の高さ（Worker とメインで比べる） */
export function probeHeights(lake) {
  const out = new Float64Array(PROBES.length);
  for (let i = 0; i < PROBES.length; i++) out[i] = lake.heightAt(PROBES[i][0], PROBES[i][1]);
  return out;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 底質の重み。kind の境（v = 0.34 / 0.68、lakefield の bedKindOf）を中心に
 * ±0.04 だけ混ぜる。argmax は lake.bedAt の kind と一致する（境の上ちょうどは同値）。
 */
export function bedWeights(v) {
  const mud = 1 - smooth(0.30, 0.38, v);
  const rock = smooth(0.64, 0.72, v);
  const sand = Math.max(0, 1 - mud - rock);
  return [mud, sand, rock];
}

/**
 * 1 本の帯（行 j0..j1-1）を焼く。Worker とメインのフォールバックが同じ関数を使う。
 * skip は near から写す矩形（far のみ）。そこは 0 のまま返す。
 */
export function bakeRows(lake, kind, j0, j1, skip = null) {
  const spec = GRID_SPECS[kind];
  const { n, step } = spec;
  const ox = spec.origin[0], oz = spec.origin[1];
  if (kind === 'bed') {
    const out = new Uint8Array((j1 - j0) * n * 4);
    for (let j = j0; j < j1; j++) {
      const z = oz + j * step;
      for (let i = 0; i < n; i++) {
        const x = ox + i * step;
        const v = lake.bedAt(x, z).v;
        const w = bedWeights(v);
        const o = ((j - j0) * n + i) * 4;
        out[o] = Math.round(w[0] * 255);
        out[o + 1] = Math.round(w[1] * 255);
        out[o + 2] = Math.round(w[2] * 255);
        out[o + 3] = Math.round(v * 255);
      }
    }
    return out;
  }
  const out = new Float32Array((j1 - j0) * n);
  for (let j = j0; j < j1; j++) {
    const z = oz + j * step;
    const skipRow = skip && j >= skip.j0 && j <= skip.j1;
    for (let i = 0; i < n; i++) {
      if (skipRow && i >= skip.i0 && i <= skip.i1) continue;
      out[(j - j0) * n + i] = lake.heightAt(ox + i * step, z);
    }
  }
  return out;
}

/** far の重なり部分を near から写す（同じ座標なので値もビット一致） */
function fillFarFromNear(far, near) {
  const f = FAR_FROM_NEAR, nn = GRID_SPECS.near.n, fn = GRID_SPECS.far.n;
  for (let j = f.j0; j <= f.j1; j++) {
    const jn = (j - f.j0) * f.ratio;
    for (let i = f.i0; i <= f.i1; i++) {
      far[j * fn + i] = near[jn * nn + (i - f.i0) * f.ratio];
    }
  }
}

/**
 * GPU と同じ手動バイリニア（テストと CPU 側の読み戻し用）。
 * 格子の外は端の値で止める。
 */
export function sampleGrid(grid, x, z) {
  const { n, step, data } = grid;
  let u = (x - grid.origin[0]) / step, v = (z - grid.origin[1]) / step;
  u = Math.min(n - 1, Math.max(0, u));
  v = Math.min(n - 1, Math.max(0, v));
  const i0 = Math.min(n - 2, Math.floor(u)), j0 = Math.min(n - 2, Math.floor(v));
  const fu = u - i0, fv = v - j0;
  const a = data[j0 * n + i0], b = data[j0 * n + i0 + 1];
  const c = data[(j0 + 1) * n + i0], d = data[(j0 + 1) * n + i0 + 1];
  return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
}

/* ----------------------------------------------------------
   Worker のプール（Terrain.load*Textures が早めに起こす）
   ---------------------------------------------------------- */
let pool = null;

function workerCount(want = 4) {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(want, hc - 1));
}

/**
 * module Worker を先に起こしておく（lakefield の import と JIT の温まりを待たずに済む）。
 * Worker が使えない環境（Node・file://・CSP）では何もしない。何度呼んでもよい。
 */
export function prewarmHeightWorkers(want = 4) {
  if (pool) return pool;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  const workers = [];
  try {
    const url = new URL('./heightWorker.js', import.meta.url);
    for (let i = 0; i < workerCount(want); i++) {
      const w = new Worker(url, { type: 'module' });
      w._ready = new Promise((res) => {
        const onMsg = (e) => { if (e.data?.type === 'ready') { w.removeEventListener('message', onMsg); res(true); } };
        w.addEventListener('message', onMsg);
        w.addEventListener('error', () => res(false), { once: true });
      });
      workers.push(w);
    }
  } catch (e) {
    for (const w of workers) w.terminate();
    return null;
  }
  pool = workers;
  return pool;
}

function releasePool() {
  if (!pool) return;
  for (const w of pool) w.terminate();
  pool = null;
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

/** Worker なしで焼く（64 行ずつ間を空けて、読み込み画面を止めない） */
async function bakeOnMain(lake, kind, skip, dst) {
  const { n } = GRID_SPECS[kind];
  const per = kind === 'bed' ? 4 : 1;
  for (let j0 = 0; j0 < n; j0 += 64) {
    const j1 = Math.min(n, j0 + 64);
    dst.set(bakeRows(lake, kind, j0, j1, skip), j0 * n * per);
    await yieldFrame();
  }
}

/** Worker 群で焼く。途中で 1 本でも失敗・不一致なら null（呼び手がメインで焼き直す） */
async function bakeOnWorkers(lake, seed, workers, out) {
  const ok = await Promise.all(workers.map((w) => Promise.race([
    w._ready, new Promise((r) => setTimeout(() => r(false), 8000)),
  ])));
  const alive = workers.filter((w, i) => ok[i]);
  if (!alive.length) return false;
  const probes = probeHeights(lake);
  const jobs = [];
  const band = (kind, parts, skip) => {
    const { n } = GRID_SPECS[kind];
    for (let p = 0; p < parts; p++) {
      jobs.push({ kind, j0: Math.floor((p * n) / parts), j1: Math.floor(((p + 1) * n) / parts), skip });
    }
  };
  band('near', 8, null);
  band('far', 8, FAR_FROM_NEAR);
  band('bed', 4, null);
  let next = 0, failed = false, id = 0;
  const runOne = (w) => new Promise((resolve) => {
    const loop = () => {
      if (failed || next >= jobs.length) { resolve(); return; }
      const job = jobs[next++];
      const myId = ++id;
      const timer = setTimeout(() => { failed = true; cleanup(); resolve(); }, 20000);
      const onMsg = (e) => {
        const m = e.data;
        if (!m || m.id !== myId) return;
        cleanup();
        if (m.type !== 'done' || m.seed !== seed || !sameProbes(m.probes, probes)) { failed = true; resolve(); return; }
        const { n } = GRID_SPECS[job.kind];
        const per = job.kind === 'bed' ? 4 : 1;
        out[job.kind].set(m.data, job.j0 * n * per);
        loop();
      };
      const onErr = () => { cleanup(); failed = true; resolve(); };
      function cleanup() {
        clearTimeout(timer);
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
      }
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.postMessage({ type: 'job', id: myId, seed, ...job });
    };
    loop();
  });
  await Promise.all(alive.map(runOne));
  return !failed;
}

function sameProbes(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * 高さ場の格子を作る。失敗しない（Worker が駄目ならメインスレッドで焼く）。
 * @param {object} lake
 * @param {{resolvedSeed?:number, workers?:number, onProgress?:(f:number)=>void}} opts
 * @returns {Promise<{near, far, bed, hash, source:'workers'|'main'}>}
 */
export async function buildHeightGrids(lake, { resolvedSeed = lake.seed, workers = 4 } = {}) {
  const mk = (kind) => {
    const s = GRID_SPECS[kind];
    const len = s.n * s.n * (kind === 'bed' ? 4 : 1);
    return { ...s, origin: [...s.origin], data: kind === 'bed' ? new Uint8Array(len) : new Float32Array(len) };
  };
  const g = { near: mk('near'), far: mk('far'), bed: mk('bed') };
  const out = { near: g.near.data, far: g.far.data, bed: g.bed.data };
  let source = 'main';
  /* Worker は «最終のシード» の湖を作り直すので、lake.seed と違うシードでは使えない */
  const ws = resolvedSeed === lake.seed && workers > 0 ? prewarmHeightWorkers(workers) : null;
  if (ws) {
    try {
      if (await bakeOnWorkers(lake, resolvedSeed, ws, out)) source = 'workers';
    } catch (e) { /* メインで焼き直す */ }
    releasePool();
  }
  if (source === 'main') {
    await bakeOnMain(lake, 'near', null, out.near);
    await bakeOnMain(lake, 'far', FAR_FROM_NEAR, out.far);
    await bakeOnMain(lake, 'bed', null, out.bed);
  }
  fillFarFromNear(out.far, out.near);
  const probes = probeHeights(lake);
  const hash = [
    fnv1aWords(new Uint32Array(out.near.buffer)),
    fnv1aWords(new Uint32Array(out.far.buffer)),
    fnv1aWords(new Uint32Array(out.bed.buffer)),
    fnv1aWords(new Uint32Array(probes.buffer)),
  ].map((h) => h.toString(16).padStart(8, '0')).join('-');
  return { ...g, hash, source };
}
