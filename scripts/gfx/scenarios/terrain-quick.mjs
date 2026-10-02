/* ===========================================================
   terrain の素早い確認（開発中）：lab/terrain.html を開き、健在とプログラムを見て、数枚撮る
   SHOTS=dock-fp:12.5:clear,aerial60:15:clear TIER=high
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { camsInPage } from './terrain-proof.mjs';

export default async function (h) {
  const tier = process.env.TIER || 'high';
  const shots = (process.env.SHOTS || 'noon-shore:13:clear,aerial60:15:clear,shore-low:13:clear,forest-floor:10:clear,far-ridge:17.75:clear,noon-fp-down:12.5:clear')
    .split(',').map((s) => s.split(':'));
  await h.open(`lab/terrain.html?capture=1&tier=${tier}${process.env.Q || ''}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const boot = await h.eval(() => {
    const L = window.__lab, m = L.gfx.modules.get('terrain');
    return { stub: m?._ngStub ?? null, stats: m?.stats?.() ?? null, load: L.gfx.loadStats?.modules?.terrain ?? null };
  });
  console.log('boot', JSON.stringify(boot));
  /* '@名前' は terrain-proof の計算した視点（@ridge・@air70・@trail・@cliff …） */
  const cams = await h.eval(camsInPage);
  for (const [cam0, hour, weather, view, dbg] of shots) {
    const cam = cam0.startsWith('@') ? cams[cam0.slice(1)] : cam0;
    const r = await h.eval(({ cam, hour, weather, view, dbg }) => {
      const L = window.__lab;
      L.cam(cam); L.setHour(Number(hour)); L.setWeather(weather, { instant: true }); L.view(view || null);
      L.gfx.modules.get('terrain')?.setDebug?.(Number(dbg || 0));
      L.freeze(10); L.tick(20);
      return { nan: L.nanCheck(), st: L.gfx.modules.get('terrain')?.stats?.() };
    }, { cam, hour, weather, view, dbg });
    await h.shot(`${tier}-${cam0.replace('@', '')}-${hour}-${weather}${dbg ? '-dbg' + dbg : ''}${view ? '-' + view : ''}`);
    console.log(cam0, hour, weather, JSON.stringify(r));
  }
  const audit = await h.eval(() => {
    const a = window.__lab.programAudit();
    const mine = a.programs.filter((p) => p.tag?.startsWith('terrain:'));
    return { total: a.count, over: a.over.map((p) => p.tag), failed: a.failed.map((p) => p.tag), mine: mine.map((p) => [p.tag, p.frag, p.vert]) };
  });
  console.log('audit', JSON.stringify(audit));
  const health = await h.eval(() => {
    const g = window.__lab.gfx, s = g.safety, m = g.modules.get('terrain');
    return { strikes: s.strikes.get('terrain') || 0, disabled: s.disabled.has('terrain'), stub: m?._ngStub ?? null, dead: [...s.deadPasses] };
  });
  console.log('health', JSON.stringify(health), 'counts', JSON.stringify(h.counts()));
  fs.writeFileSync(path.join(h.out, 'quick.json'), JSON.stringify({ boot, audit, health }, null, 1));
}
