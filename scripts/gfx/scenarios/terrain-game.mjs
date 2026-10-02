/* ===========================================================
   terrain-game：本編（index.html）で terrain が生きていることを確かめて撮る
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/terrain-game.mjs --out DIR [--size 1280x720]
   環境変数：QUALITIES=high,mid,low（既定 3 段）、VIEWS=noon-shore,noon-fp-down,dusk-3p,rain-fp（既定は baseline の地形が写る構図）
   検査：terrain がスタブでない・無効化されていない・strike 0・プログラムのリンク失敗 0・NaN 0・console のエラー / ページ例外 0
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);
const VIEWS = {
  'dawn-3p': { back: 3.2, pitch: -0.08, clock: 6.1, fp: false },
  'noon-fp-down': { back: 1.6, pitch: -0.45, clock: 12.5, fp: true },
  'noon-shore': { back: 1.6, pitch: -0.05, clock: 13, fp: true, yawOff: Math.PI * 0.75 },
  'noon-inland': { back: 1.6, pitch: -0.12, clock: 11, fp: true, yawOff: Math.PI },
  'dusk-3p': { back: 3.2, pitch: -0.05, clock: 18.3, fp: false },
  'rain-fp': { back: 1.6, pitch: -0.1, clock: 11, fp: true, weather: 'rain' },
};

export default async function (h) {
  const quals = list(process.env.QUALITIES, ['high', 'mid', 'low']);
  const views = list(process.env.VIEWS, ['noon-shore', 'noon-inland', 'noon-fp-down', 'dusk-3p', 'rain-fp']);
  const out = {};
  const fail = [];
  for (const q of quals) {
    const c0 = h.counts();
    await h.bootGame({ quality: null, bootQuality: q });
    await h.hideHud();
    for (const name of views) {
      await h.eval(({ back, pitch, clock, fp, weather, yawOff }) => {
        const g = window.__game;
        const end = g.terrain.dockEnd, dir = g.terrain.dockDir;
        g.pos.set(end.x - dir.x * back, 0, end.z - dir.z * back);
        g.yaw = Math.atan2(dir.x, dir.z) + (yawOff || 0);
        g.pitch = pitch;
        g._setFirstPerson?.(fp, true);
        g.state.clock = clock;
        g.env.setWeather?.(weather || 'clear');
      }, VIEWS[name]);
      await h.tick(40);
      await h.sleep(300);
      await h.shot(`${q}-${name}`);
    }
    const r = await h.eval(async () => {
      const { getGfx } = await import('/src/gfx/core/index.js');
      const gfx = getGfx(), m = gfx.modules.get('terrain'), s = gfx.safety;
      const progs = gfx.renderer.info.programs || [];
      let failed = 0;
      for (const p of progs) { try { const gl = gfx.renderer.getContext(); if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) failed++; } catch (e) { /* 無い */ } }
      return {
        tier: gfx.quality.tier, stub: m?._ngStub ?? null, disabled: s.disabled.has('terrain'), strikes: s.strikes.get('terrain') || 0,
        stats: m?.stats?.() ?? null, programs: progs.length, failed, load: gfx.loadStats?.modules?.terrain ?? null,
      };
    });
    const c1 = h.counts();
    r.errors = c1.errors - c0.errors; r.pageErrors = c1.pageErrors - c0.pageErrors;
    console.log(q, JSON.stringify(r));
    out[q] = r;
    if (r.stub !== false) fail.push(`${q}: terrain がスタブ（${r.stub}）`);
    if (r.disabled || r.strikes) fail.push(`${q}: terrain が無効化 / strike ${r.strikes}`);
    if (r.failed) fail.push(`${q}: リンクに失敗したプログラム ${r.failed}`);
    if (r.errors || r.pageErrors) fail.push(`${q}: console のエラー ${r.errors}・ページ例外 ${r.pageErrors}`);
  }
  fs.writeFileSync(path.join(h.out, 'terrain-game.json'), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error('terrain-game: ' + fail.join(' / '));
  console.log('terrain-game: 合格');
}
