/* ===========================================================
   terrain-bench：terrain の GPU の重さ（全体 − terrain を隠した、の中央値）をパス別に。3 段 × 視点
   TIERS=high,mid,low VIEWS=dock-3p,noon-shore,... ROUNDS=5
   lab/terrain.html?gpuTimer=sync（パスの前後を 1×1 の readPixels で挟む）。他の撮影と GPU を取り合うので
   «最小の窓» を採って往復の差を取る（CORE_API §16.4）
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { camsInPage } from './terrain-proof.mjs';

export default async function (h) {
  const tiers = (process.env.TIERS || 'high,mid,low').split(',');
  const views = (process.env.VIEWS || 'dock-3p,noon-shore,shore-low,forest-floor,@air70').split(',');
  const rounds = Number(process.env.ROUNDS || 5);
  const res = {};
  for (const tier of tiers) {
    await h.open(`lab/terrain.html?capture=1&tier=${tier}&gpuTimer=sync&chart=0`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 240);
    const cams = await h.eval(camsInPage);
    res[tier] = {};
    /* VARIANTS='名前:式;名前:式'（式は m = terrain のモジュール、L = __lab で評価。開発中の切り分け用） */
    const variants = (process.env.VARIANTS || 'base:0').split(';').map((s) => { const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; });
    for (const [vn, expr] of variants) for (const v of views) {
      await h.eval((expr) => { const L = window.__lab, m = L.gfx.modules.get('terrain'); (0, eval)('(function(m, L){' + expr + '})')(m, L); }, expr);
      const cam = v.startsWith('@') ? cams[v.slice(1)] : v;
      const r = await h.eval(({ cam, rounds }) => {
        const L = window.__lab;
        L.cam(cam); L.setHour(13); L.setWeather('clear', { instant: true }); L.freeze(10); L.tick(10);
        const tot = [], pass = {};
        for (let k = 0; k < rounds; k++) {
          const a = L.bench({ frames: 24, warm: 6, windows: 3 }), b = L.bench({ frames: 24, warm: 6, windows: 3, hide: ['terrain'] });
          tot.push(a.frameMsMin - b.frameMsMin);
          for (const p of ['shadow', 'reflection', 'opaque']) {
            const pa = (a.passMin || a.passes || {})[p], pb = (b.passMin || b.passes || {})[p];
            if (Number.isFinite(pa) && Number.isFinite(pb)) (pass[p] ||= []).push(pa - pb);
          }
        }
        const med = (x) => { const s = [...x].sort((p, q) => p - q); return +s[s.length >> 1].toFixed(2); };
        const st = L.gfx.modules.get('terrain').stats();
        return { total: med(tot), shadow: pass.shadow ? med(pass.shadow) : null, reflection: pass.reflection ? med(pass.reflection) : null,
          opaque: pass.opaque ? med(pass.opaque) : null, inst: st.passes, tris: st.tris, size: L.bench({ frames: 4, warm: 1, windows: 1, passes: false }).size };
      }, { cam, rounds });
      res[tier][vn + ' ' + v] = r;
      console.log(tier, vn, v, JSON.stringify(r));
    }
  }
  fs.writeFileSync(path.join(h.out, 'terrain-bench.json'), JSON.stringify(res, null, 1));
}
