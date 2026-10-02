/* ===========================================================
   groundcover / shoreflora の手早い確認（開発用）
   -----------------------------------------------------------
   LAB=groundcover|shoreflora TIER=high VIEWS='forest-floor@13;reed-edge@17.6' BENCH=1 Q='&chars=0'
     node scripts/gfx/shot.mjs scripts/gfx/scenarios/groundcover+shoreflora-quick.mjs --out DIR
   VIEWS の要素は «プリセット@時刻[@天候[@表示]]» か «x,y,z>tx,ty,tz@時刻…»
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(';').map((s) => s.trim()).filter(Boolean) : def);
const IDS = ['groundcover', 'shoreflora'];

export default async function (h) {
  const tier = process.env.TIER || 'high';
  const lab = process.env.LAB || 'groundcover';
  await h.open(`lab/${lab}.html?capture=1&tier=${tier}${process.env.Q || ''}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const out = { tier, boot: await h.eval((ids) => {
    const L = window.__lab;
    return Object.fromEntries(ids.map((id) => {
      const m = L.gfx.modules.get(id);
      return [id, { stub: m?._ngStub ?? null, stats: m?.stats?.() ?? null, load: L.gfx.loadStats?.modules?.[id] ?? null, debug: m?.debug ?? null }];
    }));
  }, IDS) };
  console.log('boot', JSON.stringify(out.boot));
  if (process.env.HIDE) {
    await h.eval((names) => { for (const n of names) { const o = window.__lab.scene.getObjectByName(n); if (o) o.visible = false; } }, process.env.HIDE.split(','));
  }
  out.views = [];
  for (const v of list(process.env.VIEWS, ['forest-floor@13', 'shore-low@13', 'dock-fp@17.6'])) {
    const [cam, hour, weather = 'clear', view = ''] = v.split('@');
    const name = (process.env.PREFIX || '') + cam.replace(/[^a-z0-9-]/gi, '_') + '-' + hour + (weather !== 'clear' ? '-' + weather : '') + (view ? '-' + view : '');
    const r = await h.eval(({ cam, hour, weather, view, bench, ids }) => {
      const L = window.__lab;
      if (cam.includes('>')) {
        const [a, b] = cam.split('>').map((s) => s.split(',').map(Number));
        L.cam({ pos: a, target: b });
      } else L.cam(cam);
      L.setHour(Number(hour)); L.setWeather(weather, { instant: true }); L.view(view || null); L.freeze(10);
      L.tick(40);
      const nan = L.nanCheck();
      const cost = {};
      if (bench) {
        const a = L.bench({ frames: 30, passes: true });
        for (const id of ids) {
          const b = L.bench({ frames: 30, passes: true, hide: [id] });
          cost[id] = { frame: +a.frameMsMin.toFixed(2), hidden: +b.frameMsMin.toFixed(2), cost: +(a.frameMsMin - b.frameMsMin).toFixed(2),
            passes: Object.fromEntries(Object.keys(a.passMin || {}).map((k) => [k, +((a.passMin[k] || 0) - (b.passMin[k] || 0)).toFixed(2)])) };
        }
      }
      const s = L.stats();
      const gcc = L.gfx.modules.get('groundcover')?.debugCounts?.() ?? null;
      return { nan, cost, gcc, draws: s.draws, tris: s.tris, mods: Object.fromEntries(ids.map((id) => [id, s.modules?.[id]])),
        dbg: Object.fromEntries(ids.map((id) => [id, L.gfx.modules.get(id)?.debug ?? null])) };
    }, { cam, hour, weather, view, bench: process.env.BENCH === '1', ids: IDS });
    await h.shot(name);
    console.log(name, JSON.stringify(r));
    out.views.push({ name, ...r });
  }
  out.health = await h.eval((ids) => {
    const g = window.__lab.gfx, s = g.safety;
    return Object.fromEntries(ids.map((id) => [id, { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: g.modules.get(id)?._ngStub ?? null }]));
  }, IDS);
  out.warn = h.logs.filter((l) => /\[ng\]|error|Error|WARNING/.test(l)).slice(0, 30);
  const c = h.counts();
  out.console = c;
  console.log('health', JSON.stringify(out.health));
  console.log('console', JSON.stringify(c), out.warn.slice(0, 8).join('\n'));
  fs.writeFileSync(path.join(h.out, 'quick.json'), JSON.stringify(out, null, 1));
}
