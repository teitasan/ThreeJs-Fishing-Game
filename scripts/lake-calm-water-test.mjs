#!/usr/bin/env node
/* 湖波・渚（swash）の物理の回帰テスト。
   waveField.js はウキ・魚の跳ね・取り込み条件・カメラのクランプが乗る «唯一の定義» なので、
   湖が «穏やか» なままであることをここで固定する（契約 §4.3）。
   旧版の後半（水面シェーダ・後処理のソース文字列の検査）は描画の作り直しで捨てた。 */
import assert from 'node:assert/strict';
import {
  WAVES, PHASE_W, W, MAX_WAVE_AMP, WAVE_STEEPNESS, CHOPPINESS, SWASH_GAIN, SHOAL_BUMP,
  waveHeight, waveSlope, waveDisplace, shoreRunUp, shoalGain, wavePhaseOffset, waveGLSL,
} from '../src/waveField.js';

/* ---------------- 波そのもの ---------------- */
assert.ok(WAVES.length >= 4, 'expected multi-octave lake waves');
for (const w of WAVES) {
  assert.ok(w.speed <= 1.75, `wave speed should stay lake-calm, got ${w.speed}`);
  assert.ok(w.amp <= 0.12, `wave amp should stay moderate, got ${w.amp}`);
}
assert.ok(MAX_WAVE_AMP < 0.27, `total wave amp should be calmer, got ${MAX_WAVE_AMP}`);
assert.equal(PHASE_W.length, WAVES.length, 'phase weights must cover every wave');

const t = 12.7;
const h0 = waveHeight(4.2, -8.1, t);
const h1 = waveHeight(4.2, -8.1, t + 0.5);
assert.ok(Number.isFinite(h0) && Number.isFinite(h1), 'waveHeight must stay finite');
assert.ok(Math.abs(h1 - h0) < 0.08, 'half-second height delta should stay gentle');

assert.ok(Math.abs(wavePhaseOffset(0, 0) - wavePhaseOffset(40, -22)) > 0.05,
  'phase offset must vary spatially');

/* 解析微分が数値微分と一致すること（法線が波とずれないことの担保） */
{
  const e = 1e-4;
  const s = waveSlope(3.1, -7.4, t);
  const nx = (waveHeight(3.1 + e, -7.4, t) - waveHeight(3.1 - e, -7.4, t)) / (2 * e);
  const nz = (waveHeight(3.1, -7.4 + e, t) - waveHeight(3.1, -7.4 - e, t)) / (2 * e);
  assert.ok(Math.abs(s.dx - nx) < 1e-5, `waveSlope.dx must match finite difference: ${s.dx} vs ${nx}`);
  assert.ok(Math.abs(s.dz - nz) < 1e-5, `waveSlope.dz must match finite difference: ${s.dz} vs ${nz}`);
}

/* ---------------- Gerstner（峰の尖り） ---------------- */
assert.ok(CHOPPINESS > 1, 'Gerstner choppiness must actually sharpen crests');
assert.ok(WAVE_STEEPNESS < 1,
  `sum of Q*A*k must stay under 1 or the Gerstner surface self-intersects, got ${WAVE_STEEPNESS}`);
{
  const d = waveDisplace(11.3, 4.9, t);
  assert.ok(Number.isFinite(d.dx) && Number.isFinite(d.dz), 'waveDisplace must stay finite');
  let maxDisp = 0;
  for (let i = 0; i < 400; i++) {
    const p = waveDisplace(i * 0.73, -i * 1.19, t + i * 0.031);
    maxDisp = Math.max(maxDisp, Math.hypot(p.dx, p.dz));
  }
  assert.ok(maxDisp > 0.05, 'horizontal displacement must be visible');
  assert.ok(maxDisp < 1.2, `horizontal displacement must stay lake-scale, got ${maxDisp}`);
}

/* ---------------- 浅水変形（shoaling） ---------------- */
const pureDamp = (d) => {
  const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return ss(0, 1.6, d) * 0.85 + 0.15 * ss(0, 5, d);
};
assert.equal(shoalGain(0), 0, 'no waves exactly at the waterline');
assert.ok(shoalGain(0.95) > shoalGain(0.3) * 4, 'waves must swell before the shore');
assert.ok(Math.abs(shoalGain(5) - 1) < 1e-6, 'deep water must be unchanged (gain 1)');
assert.ok(shoalGain(2) < 1, 'shoaling must not brighten the whole lake');
{
  // 盛り上がりは残すが、湖にうねりは来ないので海の surf 並みには膨らませない
  const bump = shoalGain(0.95) / pureDamp(0.95);
  assert.ok(bump > 1.05, `the shoaling bump must still be visible, got ${bump}`);
  assert.ok(bump < 1.25, `a lake must not swell like pre-breaking surf, got ${bump}`);
  assert.ok(SHOAL_BUMP > 0 && SHOAL_BUMP < 0.2, `SHOAL_BUMP must stay lake-scale, got ${SHOAL_BUMP}`);
}

/* ---------------- 渚の遡上（swash） ---------------- */
{
  let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
  for (let tt = 0; tt < 240; tt += 0.11) {
    for (const [x, z] of [[10, 20], [-40, 55], [120, 70], [-95, -33]]) {
      const r = shoreRunUp(x, z, tt, 1);
      mn = Math.min(mn, r); mx = Math.max(mx, r); sum += r; n++;
    }
  }
  assert.ok(mx > 0.012, `run-up must still move the waterline, got ${mx}`);
  assert.ok(mn < -0.012, `back-wash must still expose a little sand, got ${mn}`);
  /* ここは「湖」なので、遡上は砂浜のスケールにしない。
     典型的な岸の勾配 0.065 で汀線の往復が 1.5m を超えると海に見える
     （0.85 のときは 4.9m 動いていて「波打ち際が荒すぎて海みたい」だった） */
  const shoreSlope = 0.065;
  const sweep = (mx - mn) / shoreSlope;
  assert.ok(sweep > 0.25, `the waterline must not look frozen, got ${sweep}m`);
  assert.ok(sweep < 1.5, `a lake shoreline must only lap, not run up a beach, got ${sweep}m`);
  // 平均が 0 付近でないと汀線の平均位置がずれ、水深・キャスト距離の意味が変わる
  assert.ok(Math.abs(sum / n) < 0.03, `mean waterline must not drift, got ${sum / n}`);
}
assert.ok(SWASH_GAIN > 0, 'swash gain must be positive');
assert.ok(SWASH_GAIN < 0.3, `swash gain must stay lake-scale, got ${SWASH_GAIN}`);

/* ---------------- CPU / GPU の式が同一であること ---------------- */
{
  const glsl = waveGLSL();
  for (const fn of ['float waveH(', 'vec2 waveD(', 'vec2 waveDisp(', 'float shoreRunUp(', 'float shoalGain(']) {
    assert.ok(glsl.includes(fn), `generated GLSL must define ${fn}`);
  }
  // 波テーブルの数値がそのまま GLSL に焼かれていること
  for (const w of W) {
    assert.ok(glsl.includes(w.amp.toFixed(5)), `GLSL must carry amp ${w.amp}`);
    assert.ok(glsl.includes(w.k.toFixed(5)), `GLSL must carry k ${w.k}`);
    assert.ok(glsl.includes((CHOPPINESS * w.amp).toFixed(5)), `GLSL must carry Q*A for ${w.amp}`);
  }
  assert.ok(glsl.includes(SWASH_GAIN.toFixed(5)), 'GLSL must carry the swash gain');

  const slim = waveGLSL({ prefix: 'cs', slim: true });
  assert.ok(slim.includes('vec2 csWaveD('), 'slim GLSL must expose the prefixed slope');
  assert.ok(!slim.includes('csWaveH('), 'slim GLSL must not emit the unused height sum');
  assert.ok(waveGLSL({ prefix: 'sw' }).includes('float swShoreRunUp('),
    'prefixed GLSL must expose the shore run-up for the terrain shader');
}

console.log('lake-calm-water-test: ok');
