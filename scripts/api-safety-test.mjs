#!/usr/bin/env node
/**
 * ファサードの «投げない» 約束（契約 §9：描画の例外は MP の同期まで止める）。
 *
 * - Water.addRipple / addSplash を 1 万回（NaN・Infinity・範囲外・負の数・文字列を含む）呼んでも例外なし。
 *   core に渡るのは有限の値だけ。core が投げても外へ出さない
 * - getUnderwaterContext のキーが旧形（fixture）と同じで、core が一部だけ返しても埋まる
 * - causticsUniforms は 16 名、構築から update 後まで同じ参照（中の {value} も同じ）
 * - uniforms.uLinearOut は構築直後から 1、uShallow / uDeep は THREE.Color
 * - capture / captureReflection は何度呼んでも安全、rt / reflRT は RT か null
 * - Terrain の描画フックは core の全メソッドが投げても例外を出さず、ready は resolve する
 */
import assert from 'node:assert/strict';
import { loadFacades, fixture, mulberry32 } from './facade-harness/index.mjs';

const F = await loadFacades();
const { THREE, Terrain, Water, Environment, CAUSTICS_UNIFORM_NAMES, stub } = F;
const { resolveLake } = await import('../src/lakefield.js');

/* 警告は 1 回ずつ出るだけ。テストの出力を埋めないよう数えるだけにする */
const warn = console.warn;
let warns = 0;
console.warn = () => { warns++; };

stub.resetStub();
const scene = new THREE.Scene();
const env = new Environment(scene, { exposure: 0.78 });
const lake = resolveLake(123456789).lake;
const terrain = new Terrain(scene, { quality: 'mid', lake, grids: false });

/* game.js と同じ形の causticsUniforms（shaders.js の createCausticsUniforms があればそれ） */
let caustics = null;
try {
  const sh = await import('../src/shaders.js');
  if (typeof sh.createCausticsUniforms === 'function') caustics = sh.createCausticsUniforms();
} catch (e) { /* core の shaders.js がまだ無い */ }
if (!caustics) {
  caustics = Object.fromEntries(CAUSTICS_UNIFORM_NAMES.map((n) => [n, { value: n === 'uCaustSunDir' ? new THREE.Vector3(0, 1, 0) : 0 }]));
  console.log('  （shaders.js の createCausticsUniforms がまだ無いので、同じ 16 名の代わりで検査）');
}
assert.deepEqual(Object.keys(caustics).sort(), [...CAUSTICS_UNIFORM_NAMES].sort(), 'causticsUniforms の 16 名');
const inner = Object.fromEntries(Object.entries(caustics).map(([k, v]) => [k, v]));

const water = new Water(scene, terrain, { quality: 'mid', exposure: 0.78, causticsUniforms: caustics, skyUniforms: env.skyUniforms });
assert.equal(water.causticsUniforms, caustics, 'causticsUniforms は渡された参照のまま');
assert.equal(water.uniforms.uLinearOut.value, 1, 'uLinearOut は構築直後から 1');
assert.ok(water.uniforms.uShallow.value instanceof THREE.Color && water.uniforms.uDeep.value instanceof THREE.Color, 'uShallow / uDeep');
{
  const w2 = new Water(scene, terrain, {});
  assert.deepEqual(Object.keys(w2.causticsUniforms).sort(), [...CAUSTICS_UNIFORM_NAMES].sort(), '渡されないときも 16 名');
}

/* --- 1 万回の波紋としぶき --- */
{
  const rnd = mulberry32(99);
  const weird = [NaN, Infinity, -Infinity, 1e308, -1e308, 0, -0, -5, 1e-320, undefined, null, '3', {}, []];
  const pick = () => (rnd() < 0.3 ? weird[Math.floor(rnd() * weird.length)] : (rnd() - 0.5) * 600);
  const before = stub.calls.length;
  for (let i = 0; i < 10000; i++) {
    water.addRipple(pick(), pick(), pick(), pick());
    water.addSplash(pick(), pick(), pick(), pick(), pick());
    if (i % 3 === 0) water.addRipple(pick(), pick());
    if (i % 5 === 0) water.addSplash(pick(), pick(), pick());
  }
  const sent = stub.calls.slice(before).filter((c) => c[0] === 'water.addRipple' || c[0] === 'water.addSplash');
  assert.ok(sent.length > 1000, 'core に波紋が届いていない');
  for (const [, args] of sent) for (const a of args) assert.ok(Number.isFinite(a), `core に有限でない値が届いた: ${args}`);
  assert.equal(water.ripples.length, 32, '波紋のリングバッファが伸びた');
  assert.equal(water.splashes.length, 64, 'しぶきのリングバッファが伸びた');
  /* core が投げても外へ出さない */
  stub.control.throwOn.add('water.addRipple');
  stub.control.throwOn.add('water.addSplash');
  for (let i = 0; i < 1000; i++) { water.addRipple(i, i, 1, 1); water.addSplash(i, 0, i, 14, 1); }
  stub.control.throwOn.clear();
}

/* --- update / capture / 反射 --- */
const cam = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 3000);
cam.position.set(terrain.spawnPos.x, 2, terrain.spawnPos.z);
for (let i = 0; i < 200; i++) {
  env.update(1 / 60, 6 + i * 0.1, cam, cam.position);
  water.update(i % 10 === 0 ? 0 : 1 / 60, cam, env);
  water.capture(null, scene, cam); water.capture(null, scene, cam);
  water.captureReflection(null, scene, cam); water.captureReflection(null, scene, cam);
}
assert.equal(water.causticsUniforms, caustics, 'update の後も同じ参照');
for (const [k, v] of Object.entries(inner)) assert.equal(caustics[k], v, `${k} の {value} が差し替わった`);
assert.ok(caustics.uCaustTime.value > 0, 'uCaustTime が進んでいない');
assert.ok(water.rt === null || water.rt.isWebGLRenderTarget, 'rt');
assert.ok(water.reflRT === null || water.reflRT.isWebGLRenderTarget, 'reflRT');
assert.ok(Math.abs(water.wind - (1 + env.rainIntensity * 0.92 + env.cloudiness * 0.14)) < 1e-12, 'water.wind の式');

/* --- getUnderwaterContext --- */
{
  const keys = fixture('terrain-123456789.json').uwContextKeys;
  water.setUnderwaterView(true);
  let ctx = water.getUnderwaterContext(cam);
  assert.deepEqual(Object.keys(ctx), keys, 'getUnderwaterContext のキー');
  assert.equal(ctx.strength, 1);
  assert.ok(ctx.absorb instanceof THREE.Vector3 && ctx.sunDir instanceof THREE.Vector3 && ctx.camPos === cam.position);
  for (const k of ['time', 'night', 'rain', 'cloud', 'camNear', 'camFar', 'waterY']) assert.ok(Number.isFinite(ctx[k]), `${k} が数値でない`);
  /* core が一部だけ・壊れた値を返しても、欠けたキーは旧形で埋まる */
  const gfx = stub.getGfx();
  gfx.getUnderwaterContext = () => ({ strength: 0.5, waterY: NaN, absorb: new THREE.Vector3(1, 2, 3) });
  ctx = water.getUnderwaterContext(cam);
  assert.deepEqual(Object.keys(ctx), keys);
  assert.equal(ctx.strength, 0.5);
  assert.ok(Number.isFinite(ctx.waterY), '壊れた waterY が通った');
  assert.equal(ctx.absorb.z, 3);
  gfx.getUnderwaterContext = () => { throw new Error('boom'); };
  ctx = water.getUnderwaterContext(cam);
  assert.deepEqual(Object.keys(ctx), keys);
  water.setUnderwaterView(false);
}

/* --- core の全メソッドが投げても、ファサードは投げない --- */
{
  const all = ['setLightRig', 'beginFrame', 'setUnderwater', 'attachRenderer', 'attachWorld', 'wind.update', 'updateModules',
    'hardscape.setLamp', 'water.addRipple', 'water.addSplash', 'setFlow', 'setLodScale', 'setQuality', 'waterUpdate',
    'pipeline.prepare', 'pipeline.renderReflection', 'setReflectionHidden', 'getUnderwaterContext'];
  for (const n of all) stub.control.throwOn.add(n);
  const t2 = new Terrain(scene, { quality: 'low', lake, grids: false, renderer: {} });
  await t2.ready;   // attachWorld が投げても resolve する
  const flow = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < 50; i++) {
    t2.updateWind(i, 1.2); t2.updateTrees(1 / 60, cam.position); t2.updateLamp(0.5, 1 / 60);
    t2.updateUnderwaterProps(i, cam, flow, 0.3); t2.updateShore(i, 1.1);
    t2.setQuality(['low', 'mid', 'high'][i % 3]);
    assert.equal(t2.setLodScale(i * 0.1), Math.max(0.1, Math.min(4, i * 0.1)), 'setLodScale の戻り値');
    env.update(1 / 60, i, cam, null); env.underwater = i % 2 === 0; env.setQuality('mid');
    water.update(1 / 60, cam, env); water.capture(null, scene, cam); water.captureReflection(null, scene, cam);
    water.setUnderwaterView(i % 2 === 0); water.setReflectionHidden([env.rain, null]); water.setCaptureHidden(null);
    water.setQuality('high'); water.getUnderwaterContext(cam);
    water.addRipple(1, 2); water.addSplash(1, 0, 2);
  }
  env.underwater = false;
  stub.control.throwOn.clear();
  /* 当たりと問い合わせはそのまま使える */
  assert.equal(t2.collisionHash, terrain.collisionHash);
  assert.ok(Number.isFinite(t2.heightAt(0, 0)));
}

/* --- 互換の入れ物 --- */
assert.deepEqual(terrain.overWaterProps, [], 'overWaterProps は空');
assert.ok(terrain.underwaterProps.group instanceof THREE.Group && terrain.underwaterProps.group.children.length === 0, 'underwaterProps.group は空の Group');
assert.equal(typeof terrain.underwaterProps.activeCounts, 'object');
assert.deepEqual(terrain.waterPlants.submergedMeshes, []);
for (const m of ['loadBedTextures', 'loadDockTextures', 'loadLandTextures', 'loadLeafTextures']) {
  assert.equal(await Terrain[m](), null, `${m} は null を返す`);
}
await terrain.ready;

console.warn = warn;
console.log(`api-safety-test: ok（ファサードの警告 ${warns} 件は 1 回ずつに抑えられている）`);
