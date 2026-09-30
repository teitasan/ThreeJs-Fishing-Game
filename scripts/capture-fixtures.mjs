#!/usr/bin/env node
/* ===========================================================
   Phase −1：旧グラフィック（c8490ed）のゲーム挙動を fixture に固定する
   -----------------------------------------------------------
   node scripts/capture-fixtures.mjs --old <c8490ed を展開したディレクトリ> [--out scripts/fixtures]

     git archive c8490ed | tar -x -C <dir>   で旧ツリーを用意しておく

   新しいファサード（src/terrain.js / water.js / sky.js）は «中身を作り直す» ので、
   作り直す前の挙動をここで数値として残し、terrain-api-parity などのテストで 1e−9 一致を確かめる。
   旧コードの Terrain / Water / Environment は three と DOM を使うので、旧ツリーに撮影ハーネス
   （scripts/gfx/shot.mjs）を複写して «旧ツリーを ROOT として» ヘッドレス Chrome で動かす。
   lakefield と waveField は three を使わないので Node で直接読む。

   Math.random に依存する所（天候の抽選）は mulberry32 に差し替えて列ごと記録する。
   障害物の中身（木・岩・藪）は作り直しで意図的に変わるので、糸の判定は
   «障害物込み» と «地形だけ» の 2 通りを記録し、障害物で結果が変わるものに印を付ける。
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const a = { old: null, out: path.join(ROOT, 'scripts/fixtures'), browser: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--old') a.old = path.resolve(argv[++i]);
    else if (argv[i] === '--out') a.out = path.resolve(argv[++i]);
    else if (argv[i] === '--node-only') a.browser = false;
  }
  if (!a.old) {
    console.error('usage: node scripts/capture-fixtures.mjs --old <c8490ed tree> [--out DIR] [--node-only]');
    process.exit(2);
  }
  return a;
}

/* fixture を取る湖。123456789 はマルチの固定シード、20240711 は旧 Terrain の既定シード */
export const FIXTURE_SEEDS = [123456789, 20240711];
/* 天候の抽選で Math.random の代わりに使う mulberry32 の種 */
export const WEATHER_RNG_SEED = 0x5eed1234;

/** 湖の «指紋»。lake-invariance が同じ関数で再計算して比べる */
export function lakeDigest(lake) {
  const N = 64, half = 500;
  const hs = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -half + (i + 0.5) * (2 * half / N);
      const z = -half + (j + 0.5) * (2 * half / N);
      hs[j * N + i] = lake.heightAt(x, z);
    }
  }
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(hs.buffer));
  h.update(JSON.stringify({
    seed: lake.seed,
    structures: lake.structures,
    flats: lake.flats,
    holes: lake.holes,
    dock: lake.dock,
  }));
  return h.digest('hex');
}

function write(out, name, obj) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, name);
  fs.writeFileSync(file, JSON.stringify(obj) + '\n');
  console.log('wrote', path.relative(ROOT, file), `${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

async function captureNode(args) {
  const lf = await import(pathToFileURL(path.join(args.old, 'src/lakefield.js')).href);
  const wf = await import(pathToFileURL(path.join(args.old, 'src/waveField.js')).href);

  /* 湖：resolveLake の試行回数と、makeLake 出力の指紋 */
  const lakes = {};
  for (const seed of FIXTURE_SEEDS) {
    const r = lf.resolveLake(seed);
    lakes[seed] = {
      resolvedSeed: r.seed, tries: r.tries, digest: lakeDigest(r.lake),
      structures: r.lake.structures, flats: r.lake.flats, holes: r.lake.holes, dock: r.lake.dock,
    };
  }
  write(args.out, 'lake.json', { captured: 'c8490ed', lakes });

  /* 波の物理（waveField は変えないが、変わっていないことをここでも固定する） */
  const pts = [];
  let s = 0x2545f491;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < 400; i++) {
    const x = (rnd() - 0.5) * 400, z = (rnd() - 0.5) * 400, t = rnd() * 3000, w = 1 + rnd() * 1.1;
    const d = rnd() * 8;
    const sl = wf.waveSlope(x, z, t, w);
    const dp = wf.waveDisplace(x, z, t, w);
    pts.push([x, z, t, w, d, wf.waveHeight(x, z, t, w), sl.dx, sl.dz, dp.dx, dp.dz,
      wf.shoreRunUp(x, z, t, w), wf.shoalGain(d)]);
  }
  write(args.out, 'waves.json', {
    captured: 'c8490ed',
    W: wf.W, PHASE_W: wf.PHASE_W, MAX_WAVE_AMP: wf.MAX_WAVE_AMP, SHOAL_BUMP: wf.SHOAL_BUMP,
    glslSha256: crypto.createHash('sha256').update(wf.waveGLSL({ prefix: 'ng' })).digest('hex'),
    columns: ['x', 'z', 't', 'wind', 'depth', 'h', 'sx', 'sz', 'dx', 'dz', 'runUp', 'shoal'],
    samples: pts,
  });
}

/* ----------------------------------------------------------
   ブラウザ側のシナリオ（旧ツリーの ROOT で動く）
   ---------------------------------------------------------- */
const SCENARIO = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const OUT = process.env.FIXTURE_OUT;
const SEEDS = JSON.parse(process.env.FIXTURE_SEEDS);
const WSEED = Number(process.env.FIXTURE_WSEED);
const save = (name, obj) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj) + '\n'); console.log('fixture', name); };

export default async function (h) {
  await h.bootGame({ start: false, quality: null });
  for (const seed of SEEDS) {
    const data = await h.eval(async (seed) => {
      const THREE = await import('three');
      const { Terrain } = await import('./src/terrain.js?v=20260906-wood1');
      const { Water } = await import('./src/water.js?v=20260906-props2');
      const { resolveLake } = await import('./src/lakefield.js');
      const g = window.__game;
      const r = resolveLake(seed);
      const scene = new THREE.Scene();
      const t = new Terrain(scene, { quality: 'low', lake: r.lake, causticsUniforms: g.water.causticsUniforms, renderer: g.renderer });
      const w = new Water(scene, t, { quality: 'low', causticsUniforms: g.water.causticsUniforms });
      let s = (seed ^ 0x9e3779b9) >>> 0;
      const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let q = s; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; };
      const U = (a, b) => a + rnd() * (b - a);
      const v3 = (v) => [v.x, v.y, v.z];

      /* --- 点の問い合わせ（約 2000 点） --- */
      const P = [];
      for (let i = 0; i < 600; i++) P.push([U(-260, 260), U(-260, 260)]);
      for (let i = 0; i < 600; i++) { const a = U(0, Math.PI * 2); const rr = t.shoreRadius(Math.cos(a) * 150, Math.sin(a) * 150) + U(-15, 25); P.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
      for (let i = 0; i < 300; i++) { const al = U(-8, t._dockLen + 8); const si = U(-9, 9); P.push([t.dockStart.x + t._dockU.x * al - t._dockU.z * si, t.dockStart.z + t._dockU.z * al + t._dockU.x * si]); }
      for (let i = 0; i < 300; i++) P.push([U(-500, 500), U(-500, 500)]);
      for (let i = 0; i < 200; i++) { const a = U(0, Math.PI * 2); const rr = t.shoreRadius(Math.cos(a) * 150, Math.sin(a) * 150) + U(55, 85); P.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
      const points = P.map(([x, z]) => {
        const b = t.bedAt(x, z);
        const sn = t.structureNear(x, z);
        return {
          x, z, h: t.heightAt(x, z), d: t.depthAt(x, z), slope: t.slopeAt(x, z), slope05: t.slopeAt(x, z, 0.5),
          bed: [b.v, b.kind], n: v3(t.normalAt(x, z)), n2: v3(t.normalAt(x, z, 2)), water: t.isWater(x, z),
          shoreR: t.shoreRadius(x, z), onDock: t.onDock(x, z), distToDock: t.distToDock(x, z),
          local: (() => { const o = t._dockLocal(x, z); return [o.al, o.si]; })(),
          sNear: sn ? [sn.x, sn.z] : null,
          sNear2: (() => { const q = t.structureNear(x, z, 2); return q ? [q.x, q.z] : null; })(),
          sNear9: (() => { const q = t.structureNear(x, z, 9); return q ? [q.x, q.z] : null; })(),
        };
      });
      /* ストラクチャーのすぐ近くも問い合わせる（structureNear が当たる点を確実に入れる） */
      const sPoints = [];
      for (const st of t.structures) {
        for (let k = 0; k < 4; k++) {
          const x = st.x + U(-5, 5), z = st.z + U(-5, 5);
          const q = t.structureNear(x, z);
          sPoints.push({ x, z, sNear: q ? [q.x, q.z] : null, full: q });
        }
      }

      /* --- 線分（約 700 本） --- */
      const S = [];
      const sp = t.spawnPos;
      for (let i = 0; i < 250; i++) {
        const x0 = sp.x + U(-1.5, 1.5), z0 = sp.z + U(-1.5, 1.5), y0 = t.dockY + U(1.2, 2.2);
        const a = Math.atan2(t.dockDir.z, t.dockDir.x) + U(-1.4, 1.4), dd = U(5, 60);
        S.push([x0, y0, z0, x0 + Math.cos(a) * dd, 0, z0 + Math.sin(a) * dd]);
      }
      for (let i = 0; i < 150; i++) {
        const a = U(0, Math.PI * 2); const sr = t.shoreRadius(Math.cos(a) * 150, Math.sin(a) * 150);
        const r0 = sr + U(0.5, 20); const x0 = Math.cos(a) * r0, z0 = Math.sin(a) * r0;
        const b = a + U(-0.4, 0.4); const r1 = sr - U(4, 50);
        S.push([x0, Math.max(0, t.heightAt(x0, z0)) + U(1.2, 2.0), z0, Math.cos(b) * r1, 0, Math.sin(b) * r1]);
      }
      for (let i = 0; i < 100; i++) S.push([U(-200, 200), U(-2, 30), U(-200, 200), U(-200, 200), U(-2, 30), U(-200, 200)]);
      for (let i = 0; i < 200; i++) {
        const p = () => { const al = U(-4, t._dockLen + 4), si = U(-4, 4); return [t.dockStart.x + t._dockU.x * al - t._dockU.z * si, t.dockStart.z + t._dockU.z * al + t._dockU.x * si]; };
        const [x0, z0] = p(); const [x1, z1] = p();
        S.push([x0, t.dockY + U(-1.2, 2.0), z0, x1, t.dockY + U(-1.2, 2.0), z1]);
      }
      const origTop = t.obstacleTopAt;
      const lb = (s, o) => t.lineBlocked(s[0], s[1], s[2], s[3], s[4], s[5], o);
      const segments = S.map((s) => {
        const full = { def: lb(s), s62: lb(s, { tol: 0.22, slack: 0.62 }), s50: lb(s, { tol: 0.22, slack: 0.5 }), s0: lb(s, { slack: 0 }) };
        t.obstacleTopAt = () => -Infinity;
        const terr = { def: lb(s), s62: lb(s, { tol: 0.22, slack: 0.62 }), s50: lb(s, { tol: 0.22, slack: 0.5 }), s0: lb(s, { slack: 0 }) };
        t.obstacleTopAt = origTop;
        const obstacleHit = JSON.stringify(full) !== JSON.stringify(terr);
        return { s, dock: t.dockBlocksSegment(...s), onDock0: t.onDock(s[0], s[2]), onDock1: t.onDock(s[3], s[5]), full, terr, obstacleHit };
      });

      /* --- 障害物：木・岩・藪は作り直しで変わる。灯籠・小舟・ストラクチャーは同じ規則で残る --- */
      const o = t.obstacles;
      const obstacles = [];
      for (let i = 0; i < o.length; i += 4) obstacles.push([o[i], o[i + 1], o[i + 2], o[i + 3]]);
      const blocked = [];
      for (let i = 0; i < 300; i++) {
        const x = sp.x + U(-30, 30), z = sp.z + U(-30, 30);
        blocked.push([x, z, t.blockedAt(x, z), t.blockedAt(x, z, 0.34), t.blockedAt(x, z, 0.3, 1.5), t.obstacleTopAt(x, z)]);
      }

      /* --- 水面（時刻 × 風 × 点） --- */
      const wp = [];
      for (let i = 0; i < 40; i++) { const a = U(0, Math.PI * 2); const rr = t.shoreRadius(Math.cos(a) * 150, Math.sin(a) * 150) - U(-2, 6); wp.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
      for (let i = 0; i < 40; i++) { const a = U(0, Math.PI * 2); const rr = U(0, 120); wp.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
      for (let i = 0; i < 20; i++) { const al = U(0, t._dockLen + 10); wp.push([t.dockStart.x + t._dockU.x * al, t.dockStart.z + t._dockU.z * al]); }
      const times = [0, 0.37, 1.5, 10, 123.456, 1000.1, 5000];
      const winds = [1, 1.14, 1.92, 2.06];
      const surface = [];
      const tmp = new THREE.Vector3();
      for (const time of times) for (const wind of winds) {
        w.time = time; w.wind = wind;
        for (const [x, z] of wp) {
          const n = w.surfaceNormal(x, z, tmp);
          const n2 = w.surfaceNormal(x, z);
          surface.push([time, wind, x, z, w.surfaceY(x, z), n.x, n.y, n.z, n2.x, n2.y, n2.z]);
        }
      }

      const dock = {
        dockStart: v3(t.dockStart), dockEnd: v3(t.dockEnd), dockDir: v3(t.dockDir), dockY: t.dockY,
        _dockLen: t._dockLen, _dockU: [t._dockU.x, t._dockU.z], spawnPos: v3(t.spawnPos),
        dockAngle: t.dockAngle, shoreR0: t.shoreR0, seed: t.seed,
        lamp: obstacles[0], boat: [obstacles[1], obstacles[2]],
      };
      return {
        seed, resolvedSeed: r.seed, tries: r.tries, dock, points, sPoints, segments,
        structures: t.structures, obstacles, obstacleCount: obstacles.length, blocked,
        surface: { columns: ['time', 'wind', 'x', 'z', 'y', 'nx', 'ny', 'nz', 'n2x', 'n2y', 'n2z'], rows: surface },
        uwContextKeys: Object.keys(w.getUnderwaterContext(g.camera)),
      };
    }, seed);
    save('terrain-' + seed + '.json', data);
  }

  /* --- 空：太陽・月・夜の時刻表、天候の damp と抽選 --- */
  const sky = await h.eval(async (WSEED) => {
    const THREE = await import('three');
    const { Environment, WEATHERS } = await import('./src/sky.js?v=20260828-uwgfx18');
    const mul = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const v3 = (v) => [v.x, v.y, v.z];
    const cam = new THREE.PerspectiveCamera();
    const env = new Environment(new THREE.Scene(), { exposure: 0.78 });
    const table = [];
    for (let i = 0; i <= 24 * 8; i++) {
      const hour = i / 8;
      env.update(0, hour, cam, new THREE.Vector3(3, 0, 4));
      table.push({ hour, sunDir: v3(env.sunDir), keyDir: v3(env.keyDir), night: env.nightAmount, moon: env.moonAmount,
        sunColor: env.sunColor.getHex(), zenith: env.zenithColor.getHex(), horizon: env.horizonColor.getHex(), fog: env.fogColor.getHex(),
        fogNear: env.scene.fog.near, fogFar: env.scene.fog.far, keyI: env.sun.intensity });
    }
    for (const hour of [-3.5, 25.25, 48.1, 6, 18, 5.9, 18.1]) {
      env.update(0, hour, cam, null);
      table.push({ hour, sunDir: v3(env.sunDir), keyDir: v3(env.keyDir), night: env.nightAmount, moon: env.moonAmount });
    }
    const realRandom = Math.random;
    Math.random = mul(WSEED);
    /* damp：雨にして 1/30 秒刻みで 300 フレーム、途中で晴れに戻す */
    const e2 = new Environment(new THREE.Scene(), { exposure: 0.78 });
    Math.random = mul(WSEED);
    const damp = [];
    e2.setWeather('rain');
    const timerAfterSet = e2.weatherTimer;
    for (let i = 0; i < 300; i++) {
      if (i === 180) e2.setWeather('clear');
      if (i === 200) e2.setWeather('bogus');
      e2.update(i % 7 === 3 ? 0 : 1 / 30, 12, cam, null);
      damp.push([e2.weather.key, e2.cloudiness, e2.rainIntensity]);
    }
    /* 抽選の列：毎回時間切れにして 2000 回、その後は通常の経過で 3000 回 */
    Math.random = mul(WSEED ^ 0x777);
    const e3 = new Environment(new THREE.Scene(), { exposure: 0.78 });
    Math.random = mul(WSEED ^ 0x777);
    e3.weather = WEATHERS.clear; e3.weatherTimer = 0;
    const forced = [];
    const matrix = { clear: { clear: 0, cloudy: 0, rain: 0 }, cloudy: { clear: 0, cloudy: 0, rain: 0 }, rain: { clear: 0, cloudy: 0, rain: 0 } };
    let tMin = Infinity, tMax = -Infinity, tSum = 0;
    for (let i = 0; i < 10000; i++) {
      const from = e3.weather.key;
      e3.weatherTimer = 0;
      const w = e3.tickWeather(0.01);
      matrix[from][w.key]++;
      tMin = Math.min(tMin, e3.weatherTimer); tMax = Math.max(tMax, e3.weatherTimer); tSum += e3.weatherTimer;
      if (i < 2000) forced.push([w.key, e3.weatherTimer]);
    }
    const natural = [];
    e3.weather = WEATHERS.cloudy; e3.weatherTimer = 1.3;
    for (let i = 0; i < 3000; i++) {
      const w = e3.tickWeather(0.05);
      natural.push(w ? w.key : 0, e3.weatherTimer);
    }
    Math.random = realRandom;
    return { WEATHERS, table, dampSeed: WSEED, timerAfterSet, damp, forcedSeed: WSEED ^ 0x777, forced, matrix,
      timerStats: { min: tMin, max: tMax, mean: tSum / 10000 }, natural,
      initial: { cloudiness: env.cloudiness, rainIntensity: 0, weather: 'clear' } };
  }, WSEED);
  save('sky.json', sky);
}
`;

async function captureBrowser(args) {
  const gfxDir = path.join(args.old, 'scripts/gfx');
  fs.mkdirSync(gfxDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/gfx/shot.mjs'), path.join(gfxDir, 'shot.mjs'));
  const scen = path.join(gfxDir, 'capture-fixtures.scenario.mjs');
  fs.writeFileSync(scen, SCENARIO);
  const shots = path.join(args.old, '.gfx-shots/capture-fixtures');
  const r = spawnSync(process.execPath, [path.join(gfxDir, 'shot.mjs'), scen, '--out', shots, '--timeout', '400'], {
    cwd: args.old, stdio: 'inherit',
    env: { ...process.env, FIXTURE_OUT: args.out, FIXTURE_SEEDS: JSON.stringify(FIXTURE_SEEDS), FIXTURE_WSEED: String(WEATHER_RNG_SEED) },
  });
  if (r.status !== 0) throw new Error('ブラウザでの記録に失敗');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  await captureNode(args);
  if (args.browser) await captureBrowser(args);
  console.log('done');
}
