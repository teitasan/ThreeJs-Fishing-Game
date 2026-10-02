/* ===========================================================
   underwater + weatherfx の手早い撮影（開発用）
   SHOTS="名前|プリセット or JSON {pos,target}|時刻|天候[|view]" を ; 区切り。TIER=high、QUERY=&only=1 など
   例：SHOTS="uw|uw-dock|12.5|clear;rain|rain-fp|11|rain" node scripts/gfx/shot.mjs scripts/gfx/scenarios/underwater+weatherfx-dev.mjs --out DIR
   各枚で NaN を出す。最後に両モジュールの健在と console のエラー数
   =========================================================== */
export default async function (h) {
  const tier = process.env.TIER || 'high';
  const shots = (process.env.SHOTS || 'uw|uw-dock|12.5|clear').split(';').filter(Boolean).map((s) => s.split('|'));
  await h.open(`lab/underwater+weatherfx.html?capture=1&tier=${tier}${process.env.QUERY || ''}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  if (process.env.UWDBG) await h.eval((d) => { window.__ngUwDbg = Number(d); }, process.env.UWDBG);
  if (process.env.PROBE) await h.eval((p) => { window.__probeUv = p.split(',').map(Number); }, process.env.PROBE);
  const boot = await h.eval(() => {
    const L = window.__lab, g = L.gfx;
    const r = {};
    for (const id of ['underwater', 'weatherfx']) {
      const m = g.modules.get(id);
      r[id] = { stub: m?._ngStub ?? null, stats: m?.stats?.() ?? null, load: g.loadStats?.modules?.[id] };
    }
    return r;
  });
  console.log('boot', JSON.stringify(boot));
  for (const [name, cam, hour, weather, view] of shots) {
    const r = await h.eval(({ cam, hour, weather, view }) => {
      const L = window.__lab;
      L.unfreeze();
      L.setHour(Number(hour));
      if (cam.startsWith('{')) L.cam(JSON.parse(cam));
      else if (cam.startsWith('sun:')) {
        /* sun:<基準のプリセット>:<方位のずれ度>:<仰角の度>[:<高さ m>]：基準の位置から太陽の方位へ向く */
        const [, base, da, pitch, y] = cam.split(':');
        /* end：桟橋の先から 3m 先・深さの半分（最大 1.6m）の水中 */
        let P = L.presets()[base];
        if (base === 'end' || base === 'mid') {
          const D = L.dock, k = base === 'end' ? 3 : -0.45;
          const len = Math.hypot(D.dockEnd.x - D.dockStart.x, D.dockEnd.z - D.dockStart.z);
          const x = base === 'end' ? D.dockEnd.x + D.dockDir.x * k : D.dockEnd.x + D.dockDir.x * k * len + D.dockDir.z * 2.6;
          const z = base === 'end' ? D.dockEnd.z + D.dockDir.z * k : D.dockEnd.z + D.dockDir.z * k * len - D.dockDir.x * 2.6;
          const dep = L.lake.depthAt(x, z);
          P = { pos: [x, -Math.min(1.6, dep * 0.5), z] };
        }
        const hh = Number(hour), a = ((hh - 6) / 24) * Math.PI * 2;
        const d = [Math.cos(a), Math.sin(a), 0.34];
        const az = Math.atan2(d[2], d[0]) + (Number(da) || 0) * Math.PI / 180;
        const pos = [P.pos[0], y !== undefined ? Number(y) : P.pos[1], P.pos[2]];
        const pr = (Number(pitch) || 0) * Math.PI / 180;
        L.cam({ pos, target: [pos[0] + Math.cos(az) * Math.cos(pr) * 30, pos[1] + Math.sin(pr) * 30, pos[2] + Math.sin(az) * Math.cos(pr) * 30] });
      } else L.cam(cam);
      L.setHour(Number(hour));
      L.setWeather(weather, { instant: true });
      L.view(view || null);
      L.tick(Number(window.__devTicks || 90), 1 / 60);
      L.freeze(10);
      L.tick(4);
      const um = L.gfx.modules.get('underwater'), post = L.gfx.modules.get('post');
      const fx = um?.fx;
      return {
        nan: L.nanCheck(), uw: L.stats().uw, fx: fx ? { active: fx.active, rays: fx.raysOn, steps: fx.steps, P: fx.u.uP.value.toArray(), men: fx.u.uMen.value.toArray(), cs: fx.raysU.ngUwCs.value.toArray().map((v) => +v.toFixed(3)), keyE: fx.raysU.ngUwKeyE.value.toArray().map((v) => +v.toFixed(3)) } : null,
        post: post?.stats?.()?.underwaterEffect ?? null,
        depthProbe: (() => {
          if (!window.__probeUv) return null;
          const rt = L.gfx.pipeline.targets.copy, buf = new Float32Array(4);
          const [u, v] = window.__probeUv;
          try { L.renderer.readRenderTargetPixels(rt, (u * rt.width) | 0, (v * rt.height) | 0, 1, 1, buf, undefined, 1); } catch (e) { return String(e); }
          return Array.from(buf);
        })(),
        postFs: (() => {
          const m = post?.main?.fullscreenMaterial; if (!m) return null;
          const fsrc = m.fragmentShader || '';
          return { hasUw: fsrc.includes('Linf'), len: fsrc.length, effects: (post.main.effects || []).map((e) => e.name), uniforms: Object.keys(m.uniforms).filter((k) => /Men|Cam|uP|Lin|Rays/.test(k)) };
        })(),
      };
    }, { cam, hour, weather, view });
    await h.shot(`${tier}-${name}`);
    console.log(name, JSON.stringify(r));
  }
  const health = await h.eval(() => {
    const g = window.__lab.gfx, s = g.safety, r = {};
    for (const id of ['underwater', 'weatherfx']) {
      const m = g.modules.get(id);
      r[id] = { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null, restarts: g._restarts.get(id) || 0 };
    }
    r.deadPasses = [...s.deadPasses];
    return r;
  });
  console.log('health', JSON.stringify(health), JSON.stringify(h.counts()));
}
