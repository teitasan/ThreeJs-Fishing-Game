/* ===========================================================
   water の手早い撮影（開発用）：SHOTS="名前|プリセット or JSON {pos,target} or sun:<前後の度>:<仰角の度>|時刻|天候[|view]" を ; 区切りで。TIER=high
   例：SHOTS="m:morning-fp:9:clear;d:noon-fp-down:12.5:clear" node scripts/gfx/shot.mjs scripts/gfx/scenarios/water-dev.mjs --out DIR
   各枚で NaN・プログラムの監査・console のエラーを出す
   =========================================================== */
export default async function (h) {
  const tier = process.env.TIER || 'high';
  const shots = (process.env.SHOTS || 'morning:morning-fp:9:clear').split(';').filter(Boolean).map((s) => s.split('|'));
  await h.open(`lab/water.html?capture=1&tier=${tier}${process.env.QUERY || ''}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 180);
  const boot = await h.eval(() => {
    const L = window.__lab, m = L.gfx.modules.get('water');
    const F = L.gfx.frame?.data;
    return { stub: m?._ngStub ?? null, stats: m?.stats() ?? null, tier: L.gfx.quality.tier, load: L.gfx.loadStats?.modules?.water, slopeVar: m?.fft?.slopeVar, wind: F ? Array.from(F.slice(44, 48)) : null };
  });
  console.log('boot', JSON.stringify(boot));
  for (const [name, cam, hour, weather, view, dbg] of shots) {
    const r = await h.eval(({ cam, hour, weather, view, dbg }) => {
      const L = window.__lab;
      L.gfx.modules.get('water')?.uniforms?.uDbg?.value.fromArray((dbg || '0000').split('').map(Number));
      L.unfreeze();
      L.setHour(Number(hour));
      if (cam.startsWith('{')) L.cam(JSON.parse(cam));
      else if (cam.startsWith('sun') || cam.startsWith('moon')) {
        /* 桟橋の先から key の方位へ向く（sun:<方位のずれ度>:<見下ろしの度>） */
        const [, da, pitch] = cam.split(':').map(Number);
        const P = L.presets()['dock-fp'];
        const hh = Number(hour), a = ((hh - 6) / 24) * Math.PI * 2;
        let d = [Math.cos(a), Math.sin(a), 0.34];
        if (cam.startsWith('moon')) d = d.map((v) => -v);
        let az = Math.atan2(d[2], d[0]) + (da || 0) * Math.PI / 180;
        const pos = [P.target[0], P.pos[1], P.target[2]];
        const pr = (pitch || 6) * Math.PI / 180;
        L.cam({ pos, target: [pos[0] + Math.cos(az) * Math.cos(pr) * 30, pos[1] - Math.sin(pr) * 30, pos[2] + Math.sin(az) * Math.cos(pr) * 30] });
      } else L.cam(cam); L.setWeather(weather, { instant: true }); L.view(view || null);
      L.tick(90, 1 / 60);
      L.freeze(10);
      L.tick(4);
      return { nan: L.nanCheck() };
    }, { cam, hour, weather, view, dbg });
    await h.shot(`${tier}-${name}`);
    console.log(name, JSON.stringify(r));
  }
  if (process.env.BENCH) {
    for (const cam of process.env.BENCH.split(',')) for (const dbg of (process.env.DBG || '0000').split(',')) {
      await h.eval((d) => { window.__waterDbg = d.split('').map(Number); }, dbg);
      const b = await h.eval((cam) => {
        const L = window.__lab;
        L.cam(cam); L.setHour(12); L.setWeather('clear', { instant: true }); L.view(null); L.freeze(10); L.tick(10);
        const res = [];
        const dbg = (window.__waterDbg || [0, 0, 0, 0]);
        L.gfx.modules.get('water').uniforms.uDbg?.value.fromArray(dbg);
        for (let i = 0; i < 3; i++) {
          const a = L.bench({ frames: 40, passes: true }), b = L.bench({ frames: 40, passes: true, hide: ['water'] });
          res.push({ full: a.frameMsMin, hidden: b.frameMsMin, cost: a.frameMsMin - b.frameMsMin, late: a.passMin?.late, lateH: b.passMin?.late, prep: a.passMin?.prepare, prepH: b.passMin?.prepare, size: a.size, msaa: a.msaa });
        }
        res.sort((x, y) => x.cost - y.cost);
        return { med: res[1], all: res.map((r) => +r.cost.toFixed(2)) };
      }, cam);
      console.log('bench', cam, dbg, JSON.stringify(b));
    }
  }
  const a = await h.eval(() => {
    const A = window.__lab.programAudit();
    const mine = A.programs.filter((p) => p.tag?.startsWith('water:'));
    return { total: A.count, mine: mine.map((p) => [p.tag, p.frag, p.vert]), over: A.over.length, failed: A.failed.length };
  });
  console.log('audit', JSON.stringify(a));
  const health = await h.eval(() => {
    const g = window.__lab.gfx, s = g.safety, m = g.modules.get('water');
    return { strikes: s.strikes.get('water') || 0, disabled: s.disabled.has('water'), stub: m?._ngStub ?? null, dead: [...s.deadPasses] };
  });
  console.log('health', JSON.stringify(health), JSON.stringify(h.counts()));
}
