/* ===========================================================
   trees の手早い確認（開発用）：lab/trees.html を開いて、いくつかの構図を撮り、
   自分の GPU ms（全体 − trees を隠した）と stats を出す
   -----------------------------------------------------------
   TIER=high VIEWS=shore-low@13,far-ridge@12 BENCH=1 node scripts/gfx/shot.mjs scripts/gfx/scenarios/trees-quick.mjs --out DIR
   VIEWS の要素は «プリセット@時刻[@天候]» か «x,y,z>tx,ty,tz@時刻»
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(';').map((s) => s.trim()).filter(Boolean) : def);

export default async function (h) {
  const tier = process.env.TIER || 'high';
  const extra = process.env.Q || '';
  await h.open(`lab/${process.env.LAB || 'trees'}.html?capture=1&tier=${tier}${extra}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const out = { tier, boot: await h.eval(() => {
    const L = window.__lab, m = L.gfx.modules.get('trees');
    return { stub: m?._ngStub ?? null, stats: m?.stats?.() ?? null, load: L.gfx.loadStats?.modules?.trees ?? null };
  }) };
  console.log('boot', JSON.stringify(out.boot));
  out.views = [];
  for (const v of list(process.env.VIEWS, ['shore-low@13', 'far-ridge@12', 'forest-floor@13', 'dock-3p@17.6'])) {
    const [cam, hour, weather = 'clear', view = ''] = v.split('@');
    const name = (process.env.PREFIX || '') + cam.replace(/[^a-z0-9-]/gi, '_') + '-' + hour + (weather !== 'clear' ? '-' + weather : '') + (view ? '-' + view : '');
    const r = await h.eval(({ cam, hour, weather, view, bench }) => {
      const L = window.__lab;
      if (cam.includes('>')) {
        const [a, b] = cam.split('>').map((s) => s.split(',').map(Number));
        L.cam({ pos: a, target: b });
      } else L.cam(cam);
      L.setHour(Number(hour)); L.setWeather(weather, { instant: true }); L.view(view || null); L.freeze(Number(hour) * 0 + 10);
      L.tick(40);
      const nan = L.nanCheck();
      let cost = null;
      if (bench) {
        const a = L.bench({ frames: 30, passes: true }), b = L.bench({ frames: 30, passes: true, hide: ['trees'] });
        cost = { frame: +a.frameMsMin.toFixed(2), hidden: +b.frameMsMin.toFixed(2), cost: +(a.frameMsMin - b.frameMsMin).toFixed(2),
          passes: Object.fromEntries(Object.keys(a.passMin || {}).map((k) => [k, +((a.passMin[k] || 0) - (b.passMin[k] || 0)).toFixed(2)])) };
      }
      const s = L.stats();
      return { nan, cost, draws: s.draws, tris: s.tris, trees: s.modules?.trees };
    }, { cam, hour, weather, view, bench: process.env.BENCH === '1' });
    await h.shot(name);
    console.log(name, JSON.stringify(r));
    out.views.push({ name, ...r });
  }
  const c = h.counts();
  out.console = c;
  console.log('console', JSON.stringify(c));
  fs.writeFileSync(path.join(h.out, 'trees-quick.json'), JSON.stringify(out, null, 1));
}
