#!/usr/bin/env node
/**
 * Environment ファサードの天候・時刻の API（契約 §4.1）。
 *
 * - WEATHERS がサーバーと同じ値（c8490ed の記録とバイト一致）
 * - 太陽・月・夜の時刻表（sunDir / keyDir / nightAmount / moonAmount）が旧版と 1e−9 で一致
 * - damp（cloud λ0.4・rain λ0.35）の列と、tickWeather の抽選の列が旧版と一致（Math.random を差し替え）
 * - 抽選の分布（1 万回）：同じ天候は重み ×0.35、長さは 2.5〜6.5h
 * - 不正なキーは無視、weatherTimer は書き込める、dt = 0 で止まる、{instant:true} で即時
 * - 契約のフィールド：scene.fog（THREE.Fog）・sun（DirectionalLight、castShadow、visible）・sky / rain・
 *   skyUniforms.uStars / uLinearOut・各色（THREE.Color）・underwater の setter・光のリグを core に渡す
 */
import assert from 'node:assert/strict';
import { loadFacades, fixture, mulberry32 } from './facade-harness/index.mjs';

const F = await loadFacades();
const { THREE, Environment, WEATHERS, stub } = F;
const fx = fixture('sky.json');
const EPS = 1e-9;
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= EPS, `${what}: ${a} ≠ ${b}`);
const v3 = (v) => [v.x, v.y, v.z];
const cam = new THREE.PerspectiveCamera();

/* --- WEATHERS --- */
assert.equal(JSON.stringify(WEATHERS), JSON.stringify(fx.WEATHERS), 'WEATHERS が旧版と違う');

/* --- 時刻表 --- */
stub.resetStub();
{
  const env = new Environment(new THREE.Scene(), { exposure: 0.78 });
  for (const row of fx.table) {
    env.update(0, row.hour, cam, row.hour > 24 || row.hour < 0 || row.hour === 6 || row.hour === 18 ? null : new THREE.Vector3(3, 0, 4));
    v3(env.sunDir).forEach((v, i) => near(v, row.sunDir[i], `sunDir ${row.hour}h`));
    v3(env.keyDir).forEach((v, i) => near(v, row.keyDir[i], `keyDir ${row.hour}h`));
    near(env.nightAmount, row.night, `nightAmount ${row.hour}h`);
    assert.equal(env.moonAmount, row.moon, `moonAmount ${row.hour}h`);
  }
}

/* --- damp と setWeather の列（Math.random を mulberry32 に差し替えて旧版と同じ手順） --- */
const realRandom = Math.random;
try {
  Math.random = mulberry32(fx.dampSeed);
  const e2 = new Environment(new THREE.Scene(), { exposure: 0.78 });
  Math.random = mulberry32(fx.dampSeed);
  e2.setWeather('rain');
  near(e2.weatherTimer, fx.timerAfterSet, 'setWeather の後の weatherTimer');
  for (let i = 0; i < 300; i++) {
    if (i === 180) e2.setWeather('clear');
    if (i === 200) e2.setWeather('bogus');
    e2.update(i % 7 === 3 ? 0 : 1 / 30, 12, cam, null);
    const [key, c, r] = fx.damp[i];
    assert.equal(e2.weather.key, key, `damp ${i}: weather`);
    near(e2.cloudiness, c, `damp ${i}: cloudiness`);
    near(e2.rainIntensity, r, `damp ${i}: rainIntensity`);
  }

  /* 抽選の列 */
  Math.random = mulberry32(fx.forcedSeed);
  const e3 = new Environment(new THREE.Scene(), { exposure: 0.78 });
  Math.random = mulberry32(fx.forcedSeed);
  e3.weather = WEATHERS.clear; e3.weatherTimer = 0;
  const matrix = { clear: { clear: 0, cloudy: 0, rain: 0 }, cloudy: { clear: 0, cloudy: 0, rain: 0 }, rain: { clear: 0, cloudy: 0, rain: 0 } };
  let tMin = Infinity, tMax = -Infinity, tSum = 0;
  for (let i = 0; i < 10000; i++) {
    const from = e3.weather.key;
    e3.weatherTimer = 0;
    const w = e3.tickWeather(0.01);
    assert.ok(w && WEATHERS[w.key] === w, 'tickWeather は WEATHERS の値を返す');
    matrix[from][w.key]++;
    tMin = Math.min(tMin, e3.weatherTimer); tMax = Math.max(tMax, e3.weatherTimer); tSum += e3.weatherTimer;
    if (i < 2000) {
      assert.equal(w.key, fx.forced[i][0], `抽選 ${i}: 天候`);
      near(e3.weatherTimer, fx.forced[i][1], `抽選 ${i}: 長さ`);
    }
  }
  assert.deepEqual(matrix, fx.matrix, '遷移の回数が旧版と違う');
  near(tMin, fx.timerStats.min, '長さの最小'); near(tMax, fx.timerStats.max, '長さの最大');
  near(tSum / 10000, fx.timerStats.mean, '長さの平均');
  e3.weather = WEATHERS.cloudy; e3.weatherTimer = 1.3;
  for (let i = 0; i < 3000; i++) {
    const w = e3.tickWeather(0.05);
    assert.equal(w ? w.key : 0, fx.natural[i * 2], `自然な経過 ${i}: 天候`);
    near(e3.weatherTimer, fx.natural[i * 2 + 1], `自然な経過 ${i}: 残り`);
  }

  /* 分布（重みと ×0.35）：理論値から 3% 以内 */
  const W = Object.values(WEATHERS);
  for (const from of W) {
    const tot = W.reduce((a, w) => a + (w === from ? w.weight * 0.35 : w.weight), 0);
    const row = matrix[from.key];
    const n = Object.values(row).reduce((a, b) => a + b, 0);
    for (const to of W) {
      const p = (to === from ? to.weight * 0.35 : to.weight) / tot;
      assert.ok(Math.abs(row[to.key] / n - p) < 0.03, `${from.key}→${to.key}: ${(row[to.key] / n).toFixed(3)} ≠ ${p.toFixed(3)}`);
    }
  }
  assert.ok(tMin >= 2.5 && tMax <= 6.5, `天候の長さ ${tMin}〜${tMax}`);
} finally {
  Math.random = realRandom;
}

/* --- API の細部 --- */
stub.resetStub();
{
  const scene = new THREE.Scene();
  const env = new Environment(scene, { exposure: 0.78 });
  /* 光のリグを起動時に core へ渡す */
  const rig = stub.calls.find((c) => c[0] === 'setLightRig');
  assert.ok(rig, 'setLightRig が呼ばれていない');
  assert.ok(rig[1][0].key instanceof THREE.DirectionalLight && rig[1][0].key === env.sun, 'key は env.sun');
  assert.ok(rig[1][0].probe instanceof THREE.LightProbe, 'probe は LightProbe');
  assert.ok(rig[1][0].lamp instanceof THREE.PointLight, 'lamp は PointLight');
  assert.ok(env.sun.castShadow, 'sun は影を落とす');
  assert.ok(!scene.children.some((o) => o.isHemisphereLight), 'HemisphereLight は廃止');
  const lights = () => { const l = []; scene.traverse((o) => { if (o.isLight) l.push(o); }); return l.length; };
  const nLights = lights();

  /* 不正なキー */
  env.weather = WEATHERS.cloudy; env.weatherTimer = 2;
  env.setWeather('snow');
  assert.equal(env.weather, WEATHERS.cloudy, '不正なキーで天候が変わった');
  assert.equal(env.weatherTimer, 2, '不正なキーで残り時間が変わった');
  /* weatherTimer は書き込める（マルチが ≥1e8 に固定する） */
  env.weatherTimer = 1e8;
  for (let i = 0; i < 100; i++) assert.equal(env.tickWeather(1), null, 'weatherTimer を固定しても抽選された');
  assert.equal(env.weatherTimer, 1e8 - 100);
  /* dt = 0 で止まる */
  env.setWeather('rain');
  env.update(1, 10, cam, null);
  const c0 = env.cloudiness, r0 = env.rainIntensity;
  for (let i = 0; i < 20; i++) env.update(0, 10, cam, null);
  assert.equal(env.cloudiness, c0, 'dt = 0 で雲量が動いた');
  assert.equal(env.rainIntensity, r0, 'dt = 0 で雨量が動いた');
  /* instant */
  env.setWeather('clear', { instant: true });
  assert.equal(env.cloudiness, WEATHERS.clear.cloud);
  assert.equal(env.rainIntensity, 0);
  env.setWeather('rain', { instant: true });
  assert.equal(env.cloudiness, WEATHERS.rain.cloud);
  assert.equal(env.rainIntensity, WEATHERS.rain.rain);

  /* 契約のフィールド */
  env.update(1 / 60, 12, cam, new THREE.Vector3());
  assert.ok(scene.fog instanceof THREE.Fog, 'scene.fog は THREE.Fog');
  assert.ok(Number.isFinite(scene.fog.near) && Number.isFinite(scene.fog.far) && scene.fog.near < scene.fog.far, 'fog.near / far');
  assert.equal(typeof scene.fog.near.toFixed, 'function', 'debug.js が near.toFixed を呼ぶ');
  assert.ok(env.sun.visible, 'sun は常に visible');
  assert.ok(env.sky instanceof THREE.Object3D && env.rain instanceof THREE.Object3D, 'sky / rain は Object3D');
  assert.ok(env.rain.visible, '雨のときは rain が visible');
  assert.equal(env.skyUniforms.uStars.value, 1);
  assert.ok('value' in env.skyUniforms.uLinearOut);
  for (const k of ['sunColor', 'zenithColor', 'horizonColor', 'fogColor']) assert.ok(env[k] instanceof THREE.Color, `${k} は Color`);
  assert.ok(env.sunDir instanceof THREE.Vector3 && env.keyDir instanceof THREE.Vector3);
  const sunRef = env.sunDir, keyRef = env.keyDir;
  env.update(1 / 60, 23, cam, null);
  assert.equal(env.sunDir, sunRef, 'sunDir は in-place'); assert.equal(env.keyDir, keyRef, 'keyDir は in-place');
  assert.ok(env.nightAmount > 0.9, '23 時は夜');
  near(env.keyDir.y, -env.sunDir.y, '夜の keyDir は月（−sunDir）');
  /* 水中 */
  env.underwater = true;
  assert.equal(env.underwater, true);
  assert.ok(stub.calls.some((c) => c[0] === 'setUnderwater' && c[1][0] === true), 'underwater が core に届かない');
  env.update(1 / 60, 12, cam, null);
  assert.ok(!env.rain.visible, '水中で雨が見えている');
  env.underwater = false;
  /* core が返す色・霧・key を使う */
  stub.control.frameResult = {
    colors: { sunColor: new THREE.Color(1, 0, 0), zenithColor: new THREE.Color(0, 0, 1), horizonColor: new THREE.Color(0, 1, 0) },
    fog: { near: 12, far: 3400, color: new THREE.Color(0.5, 0.5, 0.5) },
    key: { color: new THREE.Color(1, 1, 0), intensity: 2.5 },
  };
  env.update(1 / 60, 12, cam, null);
  assert.equal(scene.fog.near, 12); assert.equal(scene.fog.far, 3400);
  /* 光の向きは producer が決めたもの（実際に影を落としている光）に合わせる */
  stub.control.frameResult.keyDir = [-0.2, -0.9, -0.1];
  env.update(1 / 60, 12, cam, null);
  assert.deepEqual(v3(env.keyDir), [-0.2, -0.9, -0.1], 'producer の keyDir を使っていない');
  assert.equal(env.moonAmount, 1, 'keyDir が太陽の反対なら月');
  delete stub.control.frameResult.keyDir;
  assert.equal(env.sun.intensity, 2.5);
  assert.equal(env.sunColor.r, 1); assert.equal(env.zenithColor.b, 1);
  stub.control.frameResult = null;
  /* 品質を変えてもライトの数と castShadow は変わらない */
  for (const q of ['low', 'high', 'mid']) env.setQuality(q);
  assert.equal(lights(), nLights, 'setQuality でライトの数が変わった');
  assert.ok(env.sun.castShadow);
  /* core が投げても update は投げない */
  stub.control.throwOn.add('beginFrame');
  env.update(1 / 60, 7, cam, null);
  assert.ok(Number.isFinite(scene.fog.near), 'core が投げたときの霧');
  stub.control.throwOn.clear();
}

/* core を作れなくても Environment は動く */
stub.resetStub();
stub.control.throwOn.add('createGfx');
{
  const env = new Environment(new THREE.Scene(), {});
  env.update(1 / 60, 9, cam, null);
  env.underwater = true; env.setQuality('high');
  assert.equal(env.gfx, null);
}
stub.resetStub();

console.log('weather-api-test: ok');
