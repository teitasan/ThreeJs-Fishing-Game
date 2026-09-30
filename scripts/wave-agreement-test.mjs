#!/usr/bin/env node
/**
 * 波の «唯一の定義» が CPU（ウキ）と GPU（水面の変位）で同じであることの検査。
 *
 * - waveGLSL({prefix:'ng'}) の定数が waveField の W・SHOAL_BUMP と一致し、c8490ed の出力とバイト一致
 * - waveField の関数値が c8490ed の記録と一致（400 点 × 時刻 × 風）
 * - Water.surfaceY / surfaceNormal が «depth ≤ 0 なら 0、それ以外は waveHeight·shoalGain» の式で、
 *   旧 fixture（50 点 × 20 の時刻×風）と一致
 * - 見た目の変位は縦だけ：GLSL の高さは waveH·wind·shoalGain で出す（水平の Gerstner は使わない）
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadFacades, fixture } from './facade-harness/index.mjs';

const F = await loadFacades();
const { THREE, Terrain, Water } = F;
const wf = await import('../src/waveField.js');
const { resolveLake } = await import('../src/lakefield.js');

/* --- GLSL の定数 --- */
{
  const g = wf.waveGLSL({ prefix: 'ng' });
  for (const fn of ['float ngWaveH(', 'vec2 ngWaveD(', 'float ngShoalGain(', 'float ngWavePhase(']) {
    assert.ok(g.includes(fn), `waveGLSL('ng') に ${fn} が無い`);
  }
  for (const w of wf.W) {
    for (const v of [w.amp, w.k, w.om, w.dx, w.dz]) assert.ok(g.includes(v.toFixed(5)), `GLSL に ${v} が無い`);
  }
  assert.ok(g.includes(wf.SHOAL_BUMP.toFixed(5)), 'GLSL に SHOAL_BUMP が無い');
  const want = fixture('waves.json');
  assert.equal(crypto.createHash('sha256').update(g).digest('hex'), want.glslSha256, 'waveGLSL の出力が c8490ed と違う');
  assert.deepEqual(JSON.parse(JSON.stringify(wf.W)), want.W, 'W が c8490ed と違う');
  assert.deepEqual(wf.PHASE_W, want.PHASE_W, 'PHASE_W');
  assert.equal(wf.SHOAL_BUMP, want.SHOAL_BUMP, 'SHOAL_BUMP');
  assert.equal(wf.MAX_WAVE_AMP, want.MAX_WAVE_AMP, 'MAX_WAVE_AMP');

  /* 関数値（Node 同士なのでビット一致） */
  for (const row of want.samples) {
    const [x, z, t, w, d, h, sx, sz, dx, dz, run, shoal] = row;
    assert.equal(wf.waveHeight(x, z, t, w), h, 'waveHeight');
    const s = wf.waveSlope(x, z, t, w);
    assert.equal(s.dx, sx, 'waveSlope.dx'); assert.equal(s.dz, sz, 'waveSlope.dz');
    const p = wf.waveDisplace(x, z, t, w);
    assert.equal(p.dx, dx, 'waveDisplace.dx'); assert.equal(p.dz, dz, 'waveDisplace.dz');
    assert.equal(wf.shoreRunUp(x, z, t, w), run, 'shoreRunUp');
    assert.equal(wf.shoalGain(d), shoal, 'shoalGain');
  }
}

/* --- GLSL の縦の変位を JS で評価して、CPU の式と同じになること --- */
{
  /* 生成した GLSL をそのまま JS に訳して評価する（sin/cos/exp/smoothstep/max だけの式なので可能）。
     手で写した式ではなく «生成物» を評価することで、GLSL と waveField のずれを捕まえる */
  const g = wf.waveGLSL({ prefix: 'ng' });
  const body = (name) => {
    const i = g.indexOf(name);
    const open = g.indexOf('{', i);
    let depth = 0, k = open;
    for (; k < g.length; k++) { if (g[k] === '{') depth++; else if (g[k] === '}' && --depth === 0) break; }
    return g.slice(open + 1, k);
  };
  const toJs = (src) => src.replace(/\bfloat\s+/g, 'let ').replace(/\bvec2\s+(\w+)\s*=\s*vec2\(0\.0\)/g, 'let $1 = [0, 0]')
    .replace(/\bp\.x\b/g, 'p[0]').replace(/\bp\.y\b/g, 'p[1]');
  const math = 'const sin = Math.sin, cos = Math.cos, exp = Math.exp, max = Math.max;'
    + 'const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };';
  const phase = new Function('p', math + toJs(body('float ngWavePhase(')));
  const waveH = new Function('p', 't', 'ngWavePhase', math + toJs(body('float ngWaveH(')));
  const shoal = new Function('depth', math + toJs(body('float ngShoalGain(')));
  const errAt = (tMax) => {
    let m = 0;
    for (let k = 0; k < 500; k++) {
      const x = -200 + (k * 37.1) % 400, z = -200 + (k * 91.7) % 400, t = (k / 499) * tMax, wind = 1 + (k % 7) * 0.15, d = (k % 13) * 0.4;
      const gpu = waveH([x, z], t, phase) * wind * shoal(d);
      const cpu = wf.waveHeight(x, z, t, wind) * wf.shoalGain(d);
      m = Math.max(m, Math.abs(gpu - cpu));
    }
    return m;
  };
  /* GLSL は定数を 5 桁で焼くので、ω の丸め × 時刻の分だけ位相が少しずつずれる
     （waveField.js は変えない約束なので、長時間の対策は water モジュール側：core-requests.md）。
     最初の 10 分はウキの許容（< 0.5mm）に収まること */
  const maxErr = errAt(600);
  assert.ok(maxErr < 5e-4, `GLSL の縦の変位が CPU と ${maxErr} m ずれる（10 分以内）`);
  const drift1h = errAt(3600);
  console.log(`  GLSL（5 桁の定数）の縦の変位と CPU の差：10 分で最大 ${(maxErr * 1000).toFixed(3)} mm、1 時間で ${(drift1h * 1000).toFixed(3)} mm`);
}

/* --- Water ファサードの式と旧 fixture --- */
for (const seed of [123456789, 20240711]) {
  const lake = resolveLake(seed).lake;
  const t = new Terrain(new THREE.Scene(), { quality: 'low', lake, grids: false });
  const water = new Water(new THREE.Scene(), t, { quality: 'low' });
  for (let k = 0; k < 400; k++) {
    const x = -180 + (k * 13.7) % 360, z = -180 + (k * 29.3) % 360;
    water.time = k * 1.7; water.wind = 1 + (k % 5) * 0.2;
    const d = t.depthAt(x, z);
    const want = d <= 0 ? 0 : wf.waveHeight(x, z, water.time, water.wind) * wf.shoalGain(d);
    assert.equal(water.surfaceY(x, z), want, 'surfaceY の式');
    if (d <= 0) assert.equal(water.surfaceY(x, z), 0, '陸では 0');
  }
  const fx = fixture(`terrain-${seed}.json`);
  /* 50 点 × 20（時刻 × 風）の格子 */
  const rows = fx.surface.rows;
  const pts = [...new Set(rows.map((r) => `${r[2]},${r[3]}`))].slice(0, 50);
  const pick = new Set(pts);
  const combos = [...new Set(rows.map((r) => `${r[0]},${r[1]}`))].slice(0, 20);
  const pickC = new Set(combos);
  let n = 0;
  const tmp = new THREE.Vector3();
  for (const r of rows) {
    if (!pick.has(`${r[2]},${r[3]}`) || !pickC.has(`${r[0]},${r[1]}`)) continue;
    water.time = r[0]; water.wind = r[1];
    assert.ok(Math.abs(water.surfaceY(r[2], r[3]) - r[4]) <= 1e-9, 'surfaceY が旧 fixture と違う');
    const nn = water.surfaceNormal(r[2], r[3], tmp);
    assert.ok(Math.abs(nn.x - r[5]) <= 1e-9 && Math.abs(nn.y - r[6]) <= 1e-9 && Math.abs(nn.z - r[7]) <= 1e-9, 'surfaceNormal が旧 fixture と違う');
    n++;
  }
  assert.equal(n, 50 * 20, '50 点 × 20 の格子を比べていない');
}

/* --- 湖は穏やか（lake-calm-water の物理の要点も残す） --- */
assert.ok(wf.MAX_WAVE_AMP < 0.27, '波の振幅の合計');
for (const w of wf.WAVES) assert.ok(w.amp <= 0.12 && w.speed <= 1.75, '1 本の波が荒い');

console.log('wave-agreement-test: ok');
