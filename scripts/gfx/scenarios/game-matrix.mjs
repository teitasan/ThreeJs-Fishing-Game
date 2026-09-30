/* ===========================================================
   本編（index.html）の撮影表とパス別の GPU 時間
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/game-matrix.mjs --size 2560x1440 --out DIR
   環境変数：QUALITY=high|mid|low（既定 high）、HOURS=6,12,18.5,23、WEATHERS=clear,rain、
   VIEWS=above,below（below は水中カメラ：仕掛けを投げた «待ち» の状態にして桟橋の方を見上げる）、
   SHOTS=0 で撮らない、BENCH=0 で計測しない、FRAMES=60（計測のフレーム数）
   計測は ?gpuTimer=sync（パスの前後を 1×1 の readPixels で挟む）。DIR/game-matrix.json に
   視点ごとのパス別の GPU ms（中央値の代わりに最小と平均）と合計を書く
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

export default async function (h) {
  const quality = process.env.QUALITY || 'high';
  const hours = list(process.env.HOURS, ['6', '12', '18.5', '23']).map(Number);
  const weathers = list(process.env.WEATHERS, ['clear', 'rain']);
  const views = list(process.env.VIEWS, ['above', 'below']);
  const shots = process.env.SHOTS !== '0', bench = process.env.BENCH !== '0';
  const frames = Number(process.env.FRAMES) || 60;
  await h.bootGame({ quality, query: '?gpuTimer=sync' });
  await h.hideHud();
  const out = { quality, size: null, views: {} };
  for (const hour of hours) {
    for (const weather of weathers) {
      for (const view of views) {
        const name = `${view}_${String(hour).replace('.', '')}_${weather}`;
        /* 待ちの状態はゲームの状態機械が戻すことがあるので、空回しの前後で 2 回置く */
        const place = () => h.eval(({ hour, weather, view }) => {
          const g = window.__game;
          const end = g.terrain.dockEnd, dir = g.terrain.dockDir;
          g.env.setWeather?.(weather, { instant: true });
          g.state.clock = hour;
          if (view === 'below') {
            /* 水中カメラ：桟橋の先 9m に仕掛けを置いた «待ち»。桟橋と釣り人を水中から見上げる */
            g.pos.set(end.x - dir.x * 1.2, 0, end.z - dir.z * 1.2);
            g.yaw = Math.atan2(dir.x, dir.z);
            g.fs = 'wait';
            g.bobber.set(end.x + dir.x * 9, 0, end.z + dir.z * 9);
            g.baitY = -1.6;
            g.underwaterCam = true;
            g.uwYaw = Math.atan2(dir.x, dir.z);
            g.uwPitch = 0.28;
            g.uwDist = 3.2;
          } else {
            g.underwaterCam = false;
            g.fs = 'idle';
            g.pos.set(end.x - dir.x * 3.2, 0, end.z - dir.z * 3.2);
            g.yaw = Math.atan2(dir.x, dir.z);
            g.pitch = -0.06;
            g._setFirstPerson?.(false, true);
          }
          return true;
        }, { hour, weather, view });
        await place();
        await h.tick(30);
        await place();
        await h.tick(4);
        if (shots) await h.shot(name);
        if (bench) {
          const r = await h.eval(async ({ frames, hour }) => {
            const { getGfx } = await import('/src/gfx/core/index.js');
            const gfx = getGfx(), g = window.__game;
            gfx.budget.reset();
            for (let i = 0; i < frames; i++) { g.state.clock = hour; g.update(1 / 60); }
            const m = gfx.budget.mean();
            const rt = gfx.targets.main;
            const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'capture' && k !== 'composer').map(([k, v]) => [k, +v.toFixed(2)]));
            const sum = (o) => +Object.entries(o).filter(([k]) => k !== 'capture' && k !== 'composer').reduce((s, [, v]) => s + v, 0).toFixed(2);
            return {
              size: [rt.width, rt.height], msaa: gfx.quality.profile.msaa, uw: +gfx.frame.cam.uw.toFixed(2),
              gpuMin: pick(m.gpuMin), gpuMean: pick(m.gpuMs), totalMin: sum(m.gpuMin), totalMean: sum(m.gpuMs),
            };
          }, { frames, hour });
          out.size = r.size;
          out.views[name] = r;
          console.log(`${name.padEnd(22)} total min ${r.totalMin.toFixed(2)} mean ${r.totalMean.toFixed(2)}ms (uw ${r.uw}) | ${Object.entries(r.gpuMin).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' ')}`);
        }
      }
    }
  }
  const gl = await h.eval(async () => {
    const { getGfx } = await import('/src/gfx/core/index.js');
    const gfx = getGfx();
    return { msaa: gfx.msaa, degraded: gfx.degraded, modules: Object.fromEntries([...gfx.modules].map(([k, m]) => [k, !!m._ngStub])) };
  });
  out.core = gl;
  fs.writeFileSync(path.join(h.out, 'game-matrix.json'), JSON.stringify(out, null, 1));
  console.log('core', JSON.stringify(gl));
}
