/* ===========================================================
   lab の GPU ベンチ：lab/core.html（または ?lab=<module>）を品質ごとに開いて、
   視点ごとのフレーム時間・パス別 GPU 時間・モジュール別の重さを JSON に出す
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/lab-bench.mjs --size 2560x1440 --out DIR
   環境変数：LAB（既定 core）、TIERS（既定 high,mid）、VIEWS（既定 dock-3p,noon-fp-down,aerial60,uw-dock）、
   MODULES=1 でモジュール別の重さも測る
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

export default async function (h) {
  const lab = process.env.LAB || 'core';
  const tiers = (process.env.TIERS || 'high,mid').split(',');
  const views = (process.env.VIEWS || 'dock-3p,noon-fp-down,aerial60,uw-dock').split(',');
  const out = { lab, size: null, tiers: {} };
  for (const tier of tiers) {
    await h.open(`lab/${lab}.html?capture=1&tier=${tier}&chart=0`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 180);
    const r = { msaa: await h.eval(() => window.__lab.msaa()), views: {} };
    for (const v of views) {
      r.views[v] = await h.eval((v) => {
        const L = window.__lab;
        L.cam(v); L.setHour(12); L.setWeather('clear', { instant: true }); L.freeze(10);
        return L.bench({ frames: 60 });
      }, v);
      await h.shot(`${tier}-${v}`);
    }
    if (process.env.MODULES === '1') {
      r.modules = await h.eval(() => { window.__lab.cam('dock-3p'); return window.__lab.moduleCosts({ frames: 40 }); });
    }
    r.audit = await h.eval(() => { const a = window.__lab.programAudit(); return { count: a.count, over: a.over, failed: a.failed }; });
    r.stats = await h.eval(() => { const s = window.__lab.stats(); delete s.modules; return s; });
    out.size = r.views[views[0]].size;
    out.tiers[tier] = r;
  }
  fs.writeFileSync(path.join(h.out, 'bench.json'), JSON.stringify(out, null, 1));
  for (const [tier, r] of Object.entries(out.tiers)) {
    console.log(`== ${tier} ${JSON.stringify(r.msaa?.decision)} programs ${r.audit.count} over ${r.audit.over.length} failed ${r.audit.failed.length}`);
    for (const [v, b] of Object.entries(r.views)) {
      const p = Object.entries(b.passes).map(([k, ms]) => `${k} ${ms.toFixed(2)}`).join(' ');
      console.log(`  ${v.padEnd(14)} frame ${b.frameMs.toFixed(2)}ms cpu ${b.cpuMs.toFixed(2)} | ${p}`);
    }
    if (r.modules) console.log('  modules', JSON.stringify(Object.fromEntries(Object.entries(r.modules.modules).map(([k, v]) => [k, +v.toFixed(2)]))));
  }
}
