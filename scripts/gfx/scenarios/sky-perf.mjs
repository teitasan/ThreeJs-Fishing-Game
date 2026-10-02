/* ===========================================================
   sky の重さ（ARCHITECTURE §6.1 の予算：main high 0.70 / mid 0.50 / low 0.25、反射 0.25 / 0.15 / 0.10、LUT 0.05、CPU ≤ 0.3ms）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/sky-perf.mjs --out DIR [--size 2560x1440]
   TIERS=low,mid,high  ROUNDS=5
   各段で：
     prepare（P1：LUT・晴れの空・雲パノラマの 1/16・skyView）の GPU ms = 1×1 の readPixels で挟んだ実時間（30 回の中央値の窓の最小）
     ドーム（P4 + P3）= bench の «全体 − sky の root を隠した» の差（moduleCosts と同じ往復）
     CPU = produce + prepare の CPU ms（300 フレームの平均）
   結果を DIR/sky-perf.json に。GPU は他の撮影と取り合うので、窓ごとの最小を採る
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

export default async function (h) {
  const tiers = list(process.env.TIERS, ['low', 'mid', 'high']);
  const rounds = Number(process.env.ROUNDS) || 5;
  const out = {};
  for (const tier of tiers) {
    await h.open(`lab/sky.html?capture=1&chart=0&tier=${tier}`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 180);
    const r = await h.eval(({ rounds }) => {
      const L = window.__lab, g = L.gfx, T = g.THREE, m = g.modules.get('sky'), R = L.renderer;
      /* core の GPU の同期（1×1 の RT に描いて readPixels。lab のベンチと同じ物。読むだけ） */
      const sync = g._gpuSync || (() => {});
      const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
      const res = {};
      for (const [name, cam, hour, weather] of [['noon', 'dock-fp', 12.5, 'clear'], ['cloudy', 'dock-fp', 12, 'cloudy'], ['rain', 'rain-fp', 11, 'rain'], ['dusk', 'dusk-3p', 18.3, 'clear'], ['night', 'night-fp', 23.5, 'clear']]) {
        L.cam(cam); L.setHour(hour); L.setWeather(weather, { instant: true }); L.freeze(10); L.tick(20);
        /* prepare の GPU（帯 1 本の普段のフレーム） */
        const prep = [];
        for (let k = 0; k < rounds; k++) {
          const w = [];
          for (let i = 0; i < 24; i++) {
            sync(); const t0 = performance.now(); m._gpu(false); sync(); w.push(performance.now() - t0);
          }
          prep.push(med(w));
        }
        /* 全部を描き直すフレーム（時刻の跳び） */
        const full = [];
        for (let i = 0; i < 5; i++) { m.full = true; sync(); const t0 = performance.now(); m._gpu(false); sync(); full.push(performance.now() - t0); }
        /* 1×1 の readPixels 自体の重さ */
        const base = [];
        for (let i = 0; i < 24; i++) { sync(); const t0 = performance.now(); sync(); base.push(performance.now() - t0); }
        const b0 = med(base);
        /* ドーム（全体 − 隠した）。passes で P3（反射）と P4（不透明）の差も */
        const dome = [], domeRefl = [], domeMain = [];
        for (let k = 0; k < rounds; k++) {
          const a = L.bench({ frames: 30, warm: 4, windows: 3, passes: true });
          const hdn = L.bench({ frames: 30, warm: 4, windows: 3, passes: true, hide: ['sky'] });
          dome.push(a.frameMsMin - hdn.frameMsMin);
          const pa = a.passMin || a.passes || {}, ph = hdn.passMin || hdn.passes || {};
          const key = (o, re) => Object.keys(o).find((k2) => re.test(k2));
          const kr = key(pa, /refl/i), ko = key(pa, /opaque|main/i);
          if (kr) domeRefl.push((pa[kr] || 0) - (ph[kr] || 0));
          if (ko) domeMain.push((pa[ko] || 0) - (ph[ko] || 0));
          if (k === 0) res._passKeys = Object.keys(pa);
        }
        /* CPU：produce + prepare */
        let cpu = 0;
        const input = { dt: 1 / 60, hour, camera: L.camera, focus: L.camera.position, weather: { key: weather, ...g._weather }, sunDir: null, envTime: 0 };
        const a0 = ((hour - 6) / 24) * Math.PI * 2;
        const N = 300;
        for (let i = 0; i < N; i++) {
          const hh = hour + i / 3600;
          const a = ((hh - 6) / 24) * Math.PI * 2;
          input.hour = hh; input.envTime = i / 60;
          input.sunDir = new T.Vector3(Math.cos(a), Math.sin(a), 0.34).normalize();
          const t0 = performance.now();
          m.produce(input);
          cpu += performance.now() - t0;
        }
        void a0;
        res[name] = {
          prepGpu: +(Math.max(0, Math.min(...prep) - b0)).toFixed(3),
          prepGpuMed: +(Math.max(0, med(prep) - b0)).toFixed(3),
          fullGpu: +(Math.max(0, med(full) - b0)).toFixed(2),
          dome: +Math.max(0, med(dome)).toFixed(3),
          domeMain: domeMain.length ? +med(domeMain).toFixed(3) : null,
          domeRefl: domeRefl.length ? +med(domeRefl).toFixed(3) : null,
          produceCpu: +(cpu / N).toFixed(3),
          syncBase: +b0.toFixed(3),
        };
      }
      res.size = [R.domElement.width, R.domElement.height];
      res.programs = L.programAudit().byModule?.sky ?? null;
      return res;
    }, { rounds });
    out[tier] = r;
    console.log(tier, JSON.stringify(r));
  }
  fs.writeFileSync(path.join(h.out, 'sky-perf.json'), JSON.stringify(out, null, 1));
}
