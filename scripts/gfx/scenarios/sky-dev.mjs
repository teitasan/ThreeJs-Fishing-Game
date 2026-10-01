/* ===========================================================
   sky の開発用の撮影（反復用。証拠は sky-proof.mjs）
   -----------------------------------------------------------
   SHOTS="dock-fp@12.5@clear,far-ridge@18.9@clear,up@23.5@clear" TIER=high
   カメラ名は lab のプリセットか «up»（天頂の魚眼代わり：真上を見る）・«horizon:<方位°>:<仰角°>»
   EVAL="<式>" を足すと最後に __lab で評価して表示する
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

export default async function (h) {
  const tier = process.env.TIER || 'high';
  const q = process.env.QUERY || '';
  await h.open(`lab/sky.html?capture=1&chart=0&chars=0&tier=${tier}${q}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 180);
  const shots = list(process.env.SHOTS, ['dock-fp@12.5@clear']);
  const res = [];
  for (const s of shots) {
    const [cam, hour, weather, frames] = s.split('@');
    const r = await h.eval(({ cam, hour, weather, frames }) => {
      const L = window.__lab;
      if (cam === 'up' || cam.startsWith('horizon:')) {
        const p = L.presets()['dock-fp'];
        let az = 0, el = 89.5, fov = null;
        if (cam.startsWith('horizon:')) { const a = cam.split(':'); az = +a[1]; el = +a[2]; fov = a[3] ? +a[3] : null; }
        const pos = p.pos, rad = Math.PI / 180;
        const tgt = [pos[0] + Math.cos(el * rad) * Math.cos(az * rad) * 100, pos[1] + Math.sin(el * rad) * 100, pos[2] + Math.cos(el * rad) * Math.sin(az * rad) * 100];
        L.cam({ pos, target: tgt });
        if (fov) { L.camera.fov = fov; L.camera.updateProjectionMatrix(); }
      } else L.cam(cam);
      L.setHour(+hour);
      L.setWeather(weather || 'clear', { instant: true });
      L.freeze(10);
      L.tick(+(frames || 40));
      const m = L.gfx.modules.get('sky');
      return { nan: L.nanCheck(), stub: m?._ngStub ?? null, lum: L.meanLuminance(), expo: L.stats().exposure };
    }, { cam, hour, weather, frames });
    const name = `${tier}-${cam.replace(/[:]/g, '_')}-${hour}-${weather || 'clear'}`;
    await h.shot(name);
    res.push({ name, ...r });
    console.log(name, JSON.stringify(r));
    await h.eval(() => { const L = window.__lab; L.camera.fov = 55; L.camera.updateProjectionMatrix(); });
  }
  if (process.env.EVAL) {
    const v = await h.eval((src) => { const L = window.__lab; return JSON.stringify((0, eval)(src)); }, process.env.EVAL);
    console.log('EVAL', v);
  }
  const health = await h.eval(() => {
    const g = window.__lab.gfx, s = g.safety, m = g.modules.get('sky');
    return { strikes: s.strikes.get('sky') || 0, disabled: s.disabled.has('sky'), stub: m?._ngStub ?? null, restarts: g._restarts.get('sky') || 0 };
  });
  console.log('health', JSON.stringify(health), 'console', JSON.stringify(h.counts()));
  fs.writeFileSync(path.join(h.out, 'dev.json'), JSON.stringify({ res, health }, null, 1));
}
