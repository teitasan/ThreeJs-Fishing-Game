/* ===========================================================
   underwater と weatherfx を本編（index.html）で確かめる（他のモジュールはその時のブランチのまま）
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/underwater+weatherfx-game.mjs --out DIR [--size 1280x720]
   環境変数：QUALITY=high|mid|low（既定 high）
   - 300 フレーム回す → 雨の一人称・雨の夜の灯籠（振り返り）・夜明けの朝霧・22 時の蛍（振り返り）・水中の正午 / 夜明け / 雨 を撮る
   - env.rain（ファサードの Group）を weatherfx が見つける・雨で水面へ衝撃を送る・水中で雨を描かない
   - NaN 0・console のエラー 0・ページ例外 0・両モジュールが健在
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

export default async function (h) {
  const quality = process.env.QUALITY || 'high';
  await h.bootGame({ quality: null, bootQuality: quality });
  await h.hideHud();
  const fail = [];
  const expect = (ok, msg) => { if (!ok) { fail.push(msg); console.log('  NG', msg); } };
  const out = { quality, shots: {} };
  out.boot = await h.eval(async () => {
    const { getGfx } = await import('/src/gfx/core/index.js');
    window.__ngGfx = getGfx();
    const gfx = window.__ngGfx, r = { tier: gfx?.quality?.tier };
    for (const id of ['underwater', 'weatherfx']) { const m = gfx?.modules?.get(id); r[id] = { present: !!m, stub: m?._ngStub ?? null, stats: m?.stats?.() }; }
    return r;
  });
  console.log('boot', JSON.stringify(out.boot));
  for (const id of ['underwater', 'weatherfx']) expect(out.boot[id].present && out.boot[id].stub === false, `${id} が本物でない`);
  await h.tick(300);

  const place = (o) => h.eval(({ back, pitch, clock, fp, weather, yawOff, under }) => {
    const g = window.__game;
    const end = g.terrain.dockEnd, dir = g.terrain.dockDir;
    g.env.setWeather?.(weather || 'clear', { instant: true });
    g.state.clock = clock;
    if (under) {
      g.pos.set(end.x - dir.x * 1.2, 0, end.z - dir.z * 1.2);
      g.yaw = Math.atan2(dir.x, dir.z);
      g.fs = 'wait';
      g.bobber.set(end.x + dir.x * 9, 0, end.z + dir.z * 9);
      g.baitY = -1.6;
      g.underwaterCam = true;
      g.uwYaw = Math.atan2(dir.x, dir.z);
      g.uwPitch = 0.28;
      g.uwDist = 3.2;
      return;
    }
    g.underwaterCam = false;
    g.fs = 'idle';
    g.pos.set(end.x - dir.x * back, 0, end.z - dir.z * back);
    g.yaw = Math.atan2(dir.x, dir.z) + (yawOff || 0);
    g.pitch = pitch;
    g._setFirstPerson?.(fp, true);
  }, o);
  const views = [
    ['rain-fp', { back: 1.6, pitch: -0.1, clock: 11, fp: true, weather: 'rain' }],
    ['rain-night-back', { back: 8, pitch: -0.08, clock: 21.5, fp: true, weather: 'rain', yawOff: Math.PI }],
    ['dawn-mist-3p', { back: 3.2, pitch: -0.05, clock: 6.1, fp: false }],
    ['fireflies-back', { back: 8, pitch: -0.08, clock: 22, fp: true, yawOff: Math.PI }],
    ['under-noon', { clock: 12.5, under: true }],
    ['under-dawn', { clock: 6.3, under: true }],
    ['under-rain', { clock: 11, under: true, weather: 'rain' }],
  ];
  for (const [name, o] of views) {
    await place(o);
    await h.tick(60);
    /* 水中：待っている間に魚が掛かると game.js が水中カメラを戻す（fs が wait 以外）→ 置き直して短く回す */
    if (o.under) { await place(o); await h.tick(12); }
    await h.sleep(200);
    await h.shot(name);
    const r = await h.eval(() => {
      const gfx = window.__ngGfx, rt = gfx.targets.main;
      let nan = null;
      if (rt.texture.type === gfx.THREE.HalfFloatType) {
        const buf = new Uint16Array(rt.width * rt.height * 4);
        gfx.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
        nan = 0;
        for (let k = 0; k < buf.length; k += 4) if (((buf[k] & 0x7c00) === 0x7c00) || ((buf[k + 1] & 0x7c00) === 0x7c00) || ((buf[k + 2] & 0x7c00) === 0x7c00)) nan++;
      }
      const w = gfx.modules.get('weatherfx'), u = gfx.modules.get('underwater');
      return { nan, uw: gfx.frame?.cam?.uw, weatherfx: w?.stats?.(), underwater: u?.stats?.(), streaks: w?.rain?.streakMesh?.visible, envRainVisible: w?._envRain?.visible };
    });
    out.shots[name] = r;
    console.log(name, JSON.stringify(r));
    if (r.nan != null) expect(r.nan === 0, `${name}: NaN ${r.nan}`);
    if (name === 'rain-fp') expect(r.streaks === true && r.weatherfx.impulses > 0, `雨の筋・水面の衝撃が無い ${JSON.stringify(r.weatherfx)}`);
    if (name.startsWith('under')) expect(r.streaks !== true, `${name}: 水中で雨の筋を描いている`);
    if (name === 'fireflies-back') expect(r.weatherfx.fireflies > 0.5, `22 時の蛍が出ない ${r.weatherfx.fireflies}`);
    if (name.startsWith('under')) expect(r.underwater.uwActive === true, `${name}: 水中の Effect が動いていない`);
  }
  expect(out.shots['rain-fp'].weatherfx.envRain === true, 'env.rain（env-rain）が見つからない');

  out.health = await h.eval(() => {
    const gfx = window.__ngGfx, s = gfx.safety, r = {};
    for (const id of ['underwater', 'weatherfx']) {
      const m = gfx.modules.get(id);
      r[id] = { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null, restarts: gfx._restarts?.get(id) || 0 };
    }
    r.dead = [...s.deadPasses];
    return r;
  });
  out.counts = h.counts();
  out.warnings = h.logs.filter((l) => /\[ng\] (underwater|weatherfx)\.|モジュール (underwater|weatherfx) /.test(l)).length;
  console.log('health', JSON.stringify(out.health), JSON.stringify(out.counts), 'warnings', out.warnings);
  for (const id of ['underwater', 'weatherfx']) {
    const H = out.health[id];
    expect(H.strikes === 0 && !H.disabled && H.stub === false && H.restarts === 0, `${id} が健在でない ${JSON.stringify(H)}`);
  }
  expect(out.health.dead.length === 0, `止まったパス ${out.health.dead}`);
  expect(out.counts.errors === 0 && out.counts.pageErrors === 0, `console のエラー ${out.counts.errors}・ページ例外 ${out.counts.pageErrors}`);
  expect(out.warnings === 0, `underwater / weatherfx の警告 ${out.warnings}`);
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, 'underwater+weatherfx-game.json'), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`underwater+weatherfx-game: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('underwater+weatherfx-game: 合格');
}
