/* ===========================================================
   post + hardscape を本編（index.html）で確かめる：両方とも本物、他はその時のブランチのまま
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/post+hardscape-game.mjs --out DIR [--size 1280x720]
   環境変数：QUALITY=high|mid|low（既定 high）
   - 止めずに 300 フレーム回す（順応・DRS・灯籠の damp が本編の時計で動く）→ baseline の視点 + 桟橋の上・灯籠の夜・雨・水中
   - NaN 0・console のエラー 0・ページ例外 0・post と hardscape が健在（例外 0・無効化なし・スタブでない・止まったパスなし）
   - 露出（slot 16）と順応・灯籠の点灯・小舟の上下（waveField と一致）を数値で
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
    const gfx = window.__ngGfx;
    const one = (id) => { const m = gfx?.modules?.get(id); return { present: !!m, stub: m?._ngStub ?? null, stats: m?.stats?.() }; };
    return { tier: gfx?.quality?.tier, post: one('post'), hardscape: one('hardscape'), msaa: gfx?.msaa };
  });
  console.log('boot', JSON.stringify(out.boot));
  expect(out.boot.post.present && out.boot.post.stub === false, 'post が本物でない');
  expect(out.boot.hardscape.present && out.boot.hardscape.stub === false, 'hardscape が本物でない');
  await h.tick(300);

  const place = (o) => h.eval(({ back, start, pitch, clock, fp, weather, yawOff, under }) => {
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
      g.uwYaw = Math.atan2(dir.x, dir.z) + Math.PI * 0.85;
      g.uwPitch = 0.22;
      g.uwDist = 3.2;
      return;
    }
    g.underwaterCam = false;
    g.fs = 'idle';
    if (start != null) { const s0 = g.terrain.dockStart; g.pos.set(s0.x + dir.x * start, 0, s0.z + dir.z * start); }
    else g.pos.set(end.x - dir.x * back, 0, end.z - dir.z * back);
    g.yaw = Math.atan2(dir.x, dir.z) + (yawOff || 0);
    g.pitch = pitch;
    g._setFirstPerson?.(fp, true);
  }, o);
  const views = [
    ['dawn-3p', { back: 3.2, pitch: -0.06, clock: 6.1, fp: false }],
    ['morning-fp', { back: 1.6, pitch: -0.12, clock: 8.5, fp: true }],
    ['noon-fp-down', { back: 1.6, pitch: -0.45, clock: 12.5, fp: true }],
    ['noon-shore', { back: 1.6, pitch: -0.05, clock: 13, fp: true, yawOff: Math.PI * 0.75 }],
    ['deck-back-fp', { back: 6, pitch: -0.32, clock: 15, fp: true, yawOff: Math.PI }],
    ['boat-fp', { start: 8.5, pitch: -0.32, clock: 9.5, fp: true, yawOff: -Math.PI * 0.72 }],
    ['dusk-3p', { back: 3.2, pitch: -0.05, clock: 18.3, fp: false }],
    ['night-fp', { back: 1.6, pitch: -0.05, clock: 22.5, fp: true }],
    ['night-lamp-fp', { back: 20, pitch: -0.1, clock: 22.5, fp: true, yawOff: Math.PI }],
    ['rain-fp', { back: 1.6, pitch: -0.1, clock: 11, fp: true, weather: 'rain' }],
    ['rain-deck-fp', { back: 4, pitch: -0.55, clock: 11, fp: true, weather: 'rain', yawOff: Math.PI }],
    ['under-dock', { clock: 12.5, under: true }],
  ];
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [name, o] of views) {
    if (only && !only.some((k) => name.startsWith(k))) continue;
    await place(o);
    await h.tick(60);
    await h.sleep(200);
    await h.shot(name);
    const r = await h.eval(() => {
      const gfx = window.__ngGfx, rt = gfx.targets.main;
      let bad = null;
      if (rt.texture.type === gfx.THREE.HalfFloatType) {
        const buf = new Uint16Array(rt.width * rt.height * 4);
        /* sky の非同期の読み戻しが PIXEL_PACK を束ねたままのことがある（同期の readPixels が INVALID_OPERATION） */
        try { const gl = gfx.renderer.getContext(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch (e) { /* 無視 */ }
        gfx.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
        bad = 0;
        for (let k = 0; k < buf.length; k += 4) if (((buf[k] & 0x7c00) === 0x7c00) || ((buf[k + 1] & 0x7c00) === 0x7c00) || ((buf[k + 2] & 0x7c00) === 0x7c00)) bad++;
      }
      const p = gfx.modules.get('post').stats(), hs = gfx.modules.get('hardscape').stats();
      return { nan: bad, exposure: +p.exposure.toFixed(3), adapt: +p.adapt.toFixed(3), lamp: +hs.lamp.toFixed(3), scale: gfx.pipeline.renderScale, hsDraws: hs.draws, postDraws: p.draws };
    });
    out.shots[name] = r;
    console.log(name, JSON.stringify(r));
    if (r.nan != null) expect(r.nan === 0, `${name}: NaN ${r.nan}`);
    if (name.startsWith('night')) expect(r.lamp > 0.9, `${name}: 夜に灯籠が点かない ${r.lamp}`);
    if (name.startsWith('noon')) expect(r.lamp < 0.05, `${name}: 昼に灯籠が点いている ${r.lamp}`);
    expect(Math.abs(Math.log2(r.adapt)) <= 1.21, `${name}: 順応が範囲外 ${r.adapt}`);
  }

  /* 小舟の上下が water.surfaceY と合う（同じ waveField） */
  out.boat = await h.eval(() => {
    const gfx = window.__ngGfx, m = gfx.modules.get('hardscape'), g = window.__game;
    const b = m.boat, o = b.userData.base;
    const sy = g.water.surfaceY ? g.water.surfaceY(o.x, o.z) : null;
    const beach = m._beach || null;
    const ground = beach ? m._groundAt(o.x, o.z) : null;
    return { boatY: b.position.y, baseY: o.y, surfaceY: sy, pitch: b.rotation.x, roll: b.rotation.z, beached: !!beach, ground };
  });
  console.log('boat', JSON.stringify(out.boat));
  if (out.boat.beached) expect(out.boat.boatY > out.boat.ground - 0.2 && out.boat.boatY < out.boat.ground + 0.3, `浜の舟が地面に載っていない ${JSON.stringify(out.boat)}`);
  else if (out.boat.surfaceY != null) expect(Math.abs(out.boat.boatY - out.boat.baseY - out.boat.surfaceY) < 0.06, `小舟の上下が水面とずれる ${JSON.stringify(out.boat)}`);

  out.health = await h.eval(() => {
    const gfx = window.__ngGfx, s = gfx.safety;
    const one = (id) => { const m = gfx.modules.get(id); return { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null, restarts: gfx._restarts?.get(id) || 0 }; };
    return { post: one('post'), hardscape: one('hardscape'), dead: [...s.deadPasses] };
  });
  out.counts = h.counts();
  out.warnings = h.logs.filter((l) => /\[ng\] (post|hardscape)\.|モジュール (post|hardscape) /.test(l)).length;
  console.log('health', JSON.stringify(out.health), JSON.stringify(out.counts), 'warnings', out.warnings);
  for (const id of ['post', 'hardscape']) {
    const H = out.health[id];
    expect(H.strikes === 0 && !H.disabled && H.stub === false && H.restarts === 0, `${id} が健在でない ${JSON.stringify(H)}`);
  }
  expect(out.health.dead.length === 0, `止まったパス ${out.health.dead}`);
  expect(out.counts.errors === 0 && out.counts.pageErrors === 0, `console のエラー ${out.counts.errors}・ページ例外 ${out.counts.pageErrors}`);
  expect(out.warnings === 0, `post / hardscape の警告 ${out.warnings}`);
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, `game-${quality}.json`), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`post+hardscape-game: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('post+hardscape-game: 合格');
}
