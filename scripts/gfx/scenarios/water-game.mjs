/* ===========================================================
   water を本編（index.html）で確かめる：water は本物、他はその時のブランチのまま（スタブでも本物でも）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/water-game.mjs --out DIR [--size 1280x720]
   環境変数：QUALITY=high|mid|low（既定 high）
   - 止めずに 300 フレーム回す → baseline の視点（朝・昼の見下ろし・岸・夕・夜・雨）+ ウキの着水（ゲームの facade の
     addSplash / addRipple が水面に届くか）+ 水中の見上げを撮る
   - NaN 0・console のエラー 0・ページ例外 0・water が健在（例外 0・無効化なし・スタブでない・作り直し 0・止まったパス 0）
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { encodePNG } from '../png.mjs';

/* 反射 RT（targets.refl）をそのまま PNG へ（露出 → Reinhard → 2.2。上下はそのまま = 鏡映の絵）。
   r4 で見つけた «対岸の汀の下の白い帯» の原因（反射のパスに地形が写っていない）を誰でも確かめられるように */
async function dumpRefl(h, file) {
  const px = await h.eval(() => {
    const gfx = window.__ngGfx, rt = gfx.targets?.refl, T = gfx.THREE;
    if (!rt) return null;
    const n = rt.width * rt.height * 4, half = rt.texture.type === T.HalfFloatType;
    const buf = half ? new Uint16Array(n) : new Uint8Array(n);
    gfx.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
    const h2f = (v) => { const e = (v >> 10) & 31, f = v & 1023; return e === 0 ? 6.1035e-5 * (f / 1024) : e === 31 ? 0 : Math.pow(2, e - 15) * (1 + f / 1024); };
    const ex = gfx.frame.get(16, 0) || 1, out = new Array(n);
    for (let k = 0; k < n; k++) {
      if ((k & 3) === 3) { out[k] = 255; continue; }
      const v = (half ? h2f(buf[k]) : buf[k] / 255) * ex;
      out[k] = Math.min(255, Math.pow(Math.max(v / (1 + v), 0), 1 / 2.2) * 255) | 0;
    }
    return { w: rt.width, h: rt.height, d: out };
  });
  if (!px) return;
  const d = new Uint8Array(px.w * px.h * 4), row = px.w * 4;
  for (let y = 0; y < px.h; y++) for (let x = 0; x < row; x++) d[y * row + x] = px.d[(px.h - 1 - y) * row + x];
  fs.writeFileSync(file, encodePNG({ width: px.w, height: px.h, data: d }));
}

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
    const m = gfx?.modules?.get('water');
    return { present: !!m, stub: m?._ngStub ?? null, tier: gfx?.quality?.tier, stats: m?.stats?.() };
  });
  console.log('boot', JSON.stringify(out.boot));
  expect(out.boot.present && out.boot.stub === false, 'water が本物でない');
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
    ['morning-fp', { back: 1.6, pitch: -0.12, clock: 8.5, fp: true }],
    ['mirror-0900-fp', { back: 1.6, pitch: -0.04, clock: 9, fp: true }],
    ['noon-fp-down', { back: 1.6, pitch: -0.45, clock: 12.5, fp: true }],
    ['noon-shore', { back: 1.6, pitch: -0.05, clock: 13, fp: true, yawOff: Math.PI * 0.75 }],
    ['golden-3p', { back: 3.2, pitch: -0.06, clock: 17.5, fp: false }],
    ['dusk-3p', { back: 3.2, pitch: -0.05, clock: 18.3, fp: false }],
    ['night-fp', { back: 1.6, pitch: -0.05, clock: 22.5, fp: true }],
    ['rain-fp', { back: 1.6, pitch: -0.1, clock: 11, fp: true, weather: 'rain' }],
    ['under-up', { clock: 12.5, under: true }],
  ];
  for (const [name, o] of views) {
    await place(o);
    await h.tick(40);
    await h.sleep(200);
    await h.shot(name);
    if (name === 'mirror-0900-fp') await dumpRefl(h, path.join(h.out, 'mirror-0900-refl-rt.png'));
    const nan = await h.eval(() => {
      /* main の RT の half の Inf/NaN の画素を数える（labkit の nanCheck と同じ） */
      const gfx = window.__ngGfx, rt = gfx.targets.main;
      if (rt.texture.type !== gfx.THREE.HalfFloatType) return null;
      const buf = new Uint16Array(rt.width * rt.height * 4);
      gfx.renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
      let bad = 0;
      for (let k = 0; k < buf.length; k += 4) if (((buf[k] & 0x7c00) === 0x7c00) || ((buf[k + 1] & 0x7c00) === 0x7c00) || ((buf[k + 2] & 0x7c00) === 0x7c00)) bad++;
      return bad;
    });
    out.shots[name] = { nan };
    if (nan != null) expect(nan === 0, `${name}: NaN ${nan}`);
  }

  /* ウキの着水：ゲームの facade から輪と水しぶき（game.js の着水と同じ呼び方）→ 撮る */
  await place({ back: 1.6, pitch: -0.22, clock: 10, fp: true });
  await h.tick(20);
  out.splash = await h.eval(() => {
    const g = window.__game, end = g.terrain.dockEnd, dir = g.terrain.dockDir;
    const x = end.x + dir.x * 9, z = end.z + dir.z * 9;
    const m = window.__ngGfx.modules.get('water');
    const n0 = m._next;
    g.water.addSplash(x, g.water.surfaceY(x, z), z, 14, 1.0);
    g.water.addRipple(x, z, 1.6, 1.9);
    g.water.addRipple(x, z, 0.6, 1.3);
    return { ringsQueued: (m._next - n0 + 16) % 16, splashes: m.splashes?.stats?.() };
  });
  await h.tick(22);
  await h.shot('bobber-landing');
  console.log('splash', JSON.stringify(out.splash));
  expect(out.splash.ringsQueued === 2, `facade の addRipple が水面に届かない ${JSON.stringify(out.splash)}`);

  out.health = await h.eval(() => {
    const gfx = window.__ngGfx, s = gfx.safety, m = gfx.modules.get('water');
    return { strikes: s.strikes.get('water') || 0, disabled: s.disabled.has('water'), stub: m?._ngStub ?? null, restarts: gfx._restarts?.get('water') || 0, dead: [...s.deadPasses] };
  });
  out.counts = h.counts();
  out.warnings = h.logs.filter((l) => l.includes('[ng] water.') || l.includes('モジュール water ')).length;
  console.log('health', JSON.stringify(out.health), JSON.stringify(out.counts), 'water warnings', out.warnings);
  const H = out.health;
  expect(H.strikes === 0 && !H.disabled && H.stub === false && H.restarts === 0 && H.dead.length === 0, `water が健在でない ${JSON.stringify(H)}`);
  expect(out.counts.errors === 0 && out.counts.pageErrors === 0, `console のエラー ${out.counts.errors}・ページ例外 ${out.counts.pageErrors}`);
  expect(out.warnings === 0, `water の警告 ${out.warnings}`);
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, 'water-game.json'), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`water-game: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('water-game: 合格');
}
