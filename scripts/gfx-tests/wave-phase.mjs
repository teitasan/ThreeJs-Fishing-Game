#!/usr/bin/env node
/* ===========================================================
   wave-phase（core-requests B-2）：GPU の波の高さが CPU の surfaceY と «何時間でも» 1mm 以内
   - NG_WAVE_GLSL が waveGLSL('ng') の 15 か所（5 波 × 高さ・勾配・水平変位）の «t × ω» を
     ngFrame の位相に置き換えている（遡上の 2 波と «t × 0.30» はそのまま）
   - 生成物の ngWaveH を JS に訳し、uniform の float32 化（t・ngWaterTime・位相）を Math.fround で再現して
     t = 0 〜 10 万秒（28 時間）で waveHeight と比べる：歩ける帯の中（|p| ≤ 250m）で < 1mm。
     置き換える前の生成物は 1 時間で 1mm を超えることも示す（この試験が «効いている» ことの確かめ）
   - core の wavePhases が mod(t·ω, 2π) を [0, 2π) で返す
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const wf = await imp('src/waveField.js');
const { NG_WAVE_GLSL, NG_WAVE_PHASE_OK, NG_WAVE_PHASE_FIELDS, ngWaveGLSL, wavePhases } = await imp('src/gfx/core/glsl/wave.glsl.js');

check(NG_WAVE_PHASE_OK, `置き換えが 15 か所（${ngWaveGLSL().replaced}）`);
check(NG_WAVE_GLSL.includes('#ifndef NG_LIB_WAVE'), 'インクルードガード');
for (const fn of ['float ngWaveH(', 'vec2 ngWaveD(', 'vec2 ngWaveDisp(', 'float ngShoreRunUp(', 'float ngShoalGain(']) {
  check(NG_WAVE_GLSL.includes(fn), `${fn} がある（waveGLSL と同じ名前）`);
}
for (let i = 0; i < 5; i++) {
  const n = NG_WAVE_GLSL.split(NG_WAVE_PHASE_FIELDS[i]).length - 1;
  check(n === 3, `波 ${i} の位相が 3 回（高さ・勾配・水平変位）使われる（${n}）`);
}
for (const w of wf.W) check(!NG_WAVE_GLSL.includes(`- t * ${w.om.toFixed(5)} + phase`), `ω ${w.om.toFixed(5)} の «t × ω» が残っていない`);

/* 生成物を JS に訳す（sin/cos/exp/smoothstep/max だけの式） */
const body = (g, name) => {
  const i = g.indexOf(name);
  const open = g.indexOf('{', i);
  let depth = 0, k = open;
  for (; k < g.length; k++) { if (g[k] === '{') depth++; else if (g[k] === '}' && --depth === 0) break; }
  return g.slice(open + 1, k);
};
const toJs = (src) => src.replace(/\bfloat\s+/g, 'let ').replace(/\bp\.x\b/g, 'p[0]').replace(/\bp\.y\b/g, 'p[1]')
  .replace(/ngWavePhA\.([xyzw])/g, (_, c) => `PH[${'xyzw'.indexOf(c)}]`).replace(/\bngWavePhB\b/g, 'PH[4]');
const math = 'const sin = Math.sin, cos = Math.cos;';
const mk = (g) => {
  const phase = new Function('p', math + toJs(body(g, 'float ngWavePhase(')));
  const h = new Function('p', 't', 'ngWavePhase', 'PH', 'ngWaterTime', math + toJs(body(g, 'float ngWaveH(')));
  return (x, z, t, PH, tw) => h([x, z], t, phase, PH, tw);
};
const newH = mk(NG_WAVE_GLSL);
const oldH = mk(wf.waveGLSL({ prefix: 'ng' }));
const f32 = Math.fround;
const errAt = (fn, t0, t1) => {
  let m = 0;
  const ph = new Float64Array(5);
  for (let k = 0; k < 600; k++) {
    const x = -250 + (k * 37.1) % 500, z = -250 + (k * 91.7) % 500;
    if (Math.hypot(x, z) > 250) continue;
    const t = t0 + ((k * 0.618034) % 1) * (t1 - t0);
    wavePhases(t, ph);
    const PH = [...ph].map(f32);
    const gpu = fn(x, z, f32(t), PH, f32(t));
    m = Math.max(m, Math.abs(gpu - wf.waveHeight(x, z, t, 1)));
  }
  return m;
};
const e1h = errAt(newH, 0, 3600), e28h = errAt(newH, 3600, 1e5);
const old1h = errAt(oldH, 3000, 3600);
check(e1h < 1e-3, `最初の 1 時間で < 1mm（${(e1h * 1000).toFixed(3)}mm）`);
check(e28h < 1e-3, `28 時間まで < 1mm（${(e28h * 1000).toFixed(3)}mm）`);
check(old1h > e28h, `置き換える前（1 時間で ${(old1h * 1000).toFixed(3)}mm）より良い`);
console.log(`  GPU の波の高さと CPU の差：1 時間 ${(e1h * 1000).toFixed(3)}mm、28 時間 ${(e28h * 1000).toFixed(3)}mm（置き換え前は 1 時間で ${(old1h * 1000).toFixed(3)}mm）`);

/* wavePhases */
{
  const ph = wavePhases(12345.678);
  let ok = true;
  for (let i = 0; i < 5; i++) {
    const want = (12345.678 * wf.W[i].om) % (Math.PI * 2);
    ok = ok && ph[i] >= 0 && ph[i] < Math.PI * 2 && Math.abs(ph[i] - want) < 1e-9;
  }
  check(ok, 'wavePhases = mod(t·ω, 2π)');
  check([...wavePhases(NaN)].every((v) => v === 0), '非有限の t は 0');
}

done('wave-phase');
