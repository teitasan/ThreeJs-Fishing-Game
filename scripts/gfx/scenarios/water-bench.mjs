/* ===========================================================
   water の GPU の重さ：本物 と スタブ（gfx._onModuleDisabled で差し戻した物）を同じ視点で
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/water-bench.mjs --size 2560x1440 --out DIR
   環境変数：TIERS=high（既定）、VIEWS=dock-fp,noon-fp-down,morning-fp、ROUNDS=5、DBG=0000,1000,...（本物だけの内訳）
   コスト = frameMsMin(全部) − frameMsMin(water の root を隠す) の往復の中央値（隠しても FFT・シミュの prepare は回る →
   それは prep 込みの «全部» − «スタブ» の差に出る）。結果は DIR/water-bench.json
   ※ 他のエンジニアの Chrome と GPU を取り合うので、往復して中央値を取る
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

export default async function (h) {
  const tiers = list(process.env.TIERS, ['high']);
  const views = list(process.env.VIEWS, ['dock-fp', 'noon-fp-down', 'morning-fp']);
  const rounds = Number(process.env.ROUNDS) || 5;
  const dbgs = list(process.env.DBG, ['0000']);
  const out = { rounds, tiers: {} };
  for (const tier of tiers) {
    await h.open(`lab/water.html?capture=1&tier=${tier}`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 240);
    const T = (out.tiers[tier] = { real: {}, stub: {}, size: null });
    const run = (key, dbg) => h.eval(({ views, rounds, dbg }) => {
      const L = window.__lab, m = L.gfx.modules.get('water');
      const res = {};
      for (const v of views) {
        L.cam(v); L.setHour(12); L.setWeather('clear', { instant: true }); L.view(null); L.freeze(10); L.tick(10);
        m.uniforms?.uDbg?.value.fromArray(dbg.split('').map(Number));
        const full = [], hid = [], diff = [];
        for (let i = 0; i < rounds; i++) {
          const a = L.bench({ frames: 30, warm: 8, windows: 3, passes: false });
          const b = L.bench({ frames: 30, warm: 8, windows: 3, passes: false, hide: ['water'] });
          full.push(a.frameMsMin); hid.push(b.frameMsMin); diff.push(a.frameMsMin - b.frameMsMin);
        }
        m.uniforms?.uDbg?.value.set(0, 0, 0, 0);
        const md = (x) => { const s = [...x].sort((p, q) => p - q); return +s[s.length >> 1].toFixed(2); };
        res[v] = { fullMs: md(full), hiddenMs: md(hid), waterMs: md(diff) };
      }
      return { res, size: [L.gfx.targets.main.width, L.gfx.targets.main.height], msaa: L.gfx.quality.profile.msaa };
    }, { views, rounds, dbg });
    for (const d of dbgs) {
      const r = await run('real', d);
      T.real[d] = r.res; T.size = r.size; T.msaa = r.msaa;
      console.log(tier, 'real', d, JSON.stringify(r.res));
    }
    /* スタブへ差し戻して同じ視点 */
    await h.eval(() => { const g = window.__lab.gfx; g._onModuleDisabled('water'); });
    await h.waitFor(() => window.__lab.gfx.modules.get('water')?._ngStub === true, undefined, 60);
    await h.eval(() => window.__lab.tick(30));
    const s = await run('stub', '0000');
    T.stub = s.res;
    console.log(tier, 'stub', JSON.stringify(s.res));
  }
  fs.writeFileSync(path.join(h.out, 'water-bench.json'), JSON.stringify(out, null, 1));
}
