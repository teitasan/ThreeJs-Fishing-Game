/* ===========================================================
   terrain-isolate：他のモジュールを隠して、地形だけの見え方を撮る（開発用）
   CAM=@air200 HOUR=13 HIDE='none|groundcover|groundcover,trees'
   =========================================================== */
import { camsInPage } from './terrain-proof.mjs';

export default async function (h) {
  const tier = process.env.TIER || 'high';
  await h.open(`lab/terrain.html?capture=1&tier=${tier}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const cams = await h.eval(camsInPage);
  const c0 = process.env.CAM || '@air200';
  const cam = c0.startsWith('@') ? cams[c0.slice(1)] : c0;
  const sets = (process.env.HIDE || 'none|groundcover|groundcover,trees').split('|');
  for (const set of sets) {
    const ids = await h.eval(({ cam, set, hour, dbg }) => {
      const L = window.__lab, g = L.gfx;
      const hide = set.split(',');
      const ids = [];
      for (const [id, m] of g.modules) { if (m.root) m.root.visible = !hide.includes(id); ids.push(id); }
      L.cam(cam); g.modules.get('terrain')?.setDebug?.(Number(dbg)); L.setHour(hour); L.setWeather('clear', { instant: true }); L.freeze(10); L.tick(20);
      return ids;
    }, { cam, set, hour: Number(process.env.HOUR || 13), dbg: process.env.DBG || 0 });
    console.log('modules', ids.join(','));
    await h.shot(`${tier}-${c0.replace('@', '')}-hide-${set.replace(/,/g, '+')}${process.env.DBG ? '-dbg' + process.env.DBG : ''}`);
  }
}
