/* ===========================================================
   post + hardscape の開発用の撮影（手早く数枚）
   -----------------------------------------------------------
   PAGE=lab/post+hardscape.html（既定）  QUERY=&mods=…  TIER=high
   SHOTS="name:cam:hour:weather[:view],…"（cam はプリセット名か "x,y,z>tx,ty,tz"）
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const DEF = 'dock3p:dock-3p:12.5:clear,fp:dock-fp:9:clear,night:night-fp:22.5:clear,uw:uw-dock:12:clear';

export default async function (h) {
  const page = process.env.PAGE || 'lab/post+hardscape.html';
  const tier = process.env.TIER || 'high';
  const shots = (process.env.SHOTS || DEF).split(',').filter(Boolean).map((s) => s.split(':'));
  await h.open(`${page}?capture=1&tier=${tier}${process.env.QUERY || ''}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const out = {};
  for (const [name, cam, hour, weather, view] of shots) {
    const r = await h.eval(({ cam, hour, weather, view }) => {
      const L = window.__lab;
      if (cam.includes('>')) {
        const [a, b] = cam.split('>').map((v) => v.split(';').map(Number));
        L.cam({ pos: a, target: b });
      } else L.cam(cam);
      L.setHour(Number(hour)); L.setWeather(weather, { instant: true }); L.view(view || null); L.freeze(Number(hour) * 0 + 10);
      L.tick(40);
      const s = L.stats();
      return { nan: L.nanCheck(), exposure: s.exposure, modules: Object.fromEntries(Object.entries(s.modules).map(([k, v]) => [k, { stub: v.stub, disabled: v.disabled, draws: v.draws }])) };
    }, { cam, hour, weather, view });
    out[name] = r;
    await h.shot(name);
    console.log(name, JSON.stringify(r));
  }
  const c = h.counts();
  console.log('console', JSON.stringify(c));
  fs.writeFileSync(path.join(h.out, 'dev.json'), JSON.stringify(out, null, 1));
}
