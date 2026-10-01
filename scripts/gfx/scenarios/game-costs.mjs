/* ===========================================================
   本編（index.html）のパス別 GPU ms を «モジュールごと» に分ける
   -----------------------------------------------------------
   QUALITY=high node scripts/gfx/shot.mjs scripts/gfx/scenarios/game-costs.mjs --size 2560x1440 --out DIR
   環境変数：QUALITY=high|mid|low（既定 high）、VIEWS=above,below、HOUR=12、WEATHER=clear、
             FRAMES=40（1 窓のフレーム数）、ROUNDS=3（全体 ↔ 隠した の往復）
   - ?gpuTimer=sync（パスの前後を 1×1 の readPixels で挟む）、__gfxCapture で DRS を止めて «画面の大きさ» で測る
   - 各モジュールの root を隠したときの減り（全体 − 隠した）をパスごとに出す。往復して中央値（周波数の揺れを両方に乗せる）
   - all = 全モジュールを隠した残り（core・釣り人・魚・ゲームの半透明）
   隠すのは描画だけ（CPU の update・prepare・反射の preparer は残る）。結果は DIR/game-costs.json
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);
const PASSES = ['shadow', 'reflection', 'opaque', 'copy', 'late', 'post'];

export default async function (h) {
  const quality = process.env.QUALITY || 'high';
  const views = list(process.env.VIEWS, ['above', 'below']);
  const hour = Number(process.env.HOUR ?? 12);
  const weather = process.env.WEATHER || 'clear';
  const frames = Number(process.env.FRAMES) || 40;
  const rounds = Number(process.env.ROUNDS) || 3;
  await h.bootGame({ quality: null, bootQuality: quality, query: '?gpuTimer=sync' });
  await h.hideHud();
  await h.eval(() => { window.__gfxCapture = true; for (let i = 0; i < 3; i++) window.__game.update(1 / 60); });
  const out = { quality, hour, weather, frames, rounds, views: {} };
  for (const view of views) {
    await h.eval(({ hour, weather, view }) => {
      /* 置き直しの関数をページに残す（待ちの状態はゲームの状態機械が戻すことがあるので、測るたびに置く） */
      window.__placeView = () => {
      const g = window.__game;
      const end = g.terrain.dockEnd, dir = g.terrain.dockDir;
      g.env.setWeather?.(weather, { instant: true });
      g.state.clock = hour;
      if (view === 'below') {
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
      };
      const g = window.__game;
      window.__placeView();
      for (let i = 0; i < 30; i++) { g.state.clock = hour; g.update(1 / 60); }
      window.__placeView();
      for (let i = 0; i < 4; i++) { g.state.clock = hour; g.update(1 / 60); }
    }, { hour, weather, view });
    await h.shot(`costs-${quality}-${view}`);
    const r = await h.eval(async ({ frames, rounds, hour, PASSES }) => {
      const { getGfx } = await import('/src/gfx/core/index.js');
      const gfx = getGfx(), g = window.__game;
      const ids = [...gfx.modules.keys()];
      const measure = (hide) => {
        const saved = [];
        for (const id of hide) { const m = gfx.modules.get(id); if (m) { saved.push([m, m.root.visible]); m.root.visible = false; } }
        try {
          window.__placeView();
          for (let i = 0; i < 4; i++) { g.state.clock = hour; g.update(1 / 60); }
          gfx.budget.reset();
          for (let i = 0; i < frames; i++) { g.state.clock = hour; g.update(1 / 60); }
          const m = gfx.budget.mean().gpuMin;
          const o = {};
          for (const p of PASSES) o[p] = m[p] || 0;
          o.total = PASSES.reduce((s, p) => s + o[p], 0);
          return o;
        } finally {
          for (const [m, v] of saved) m.root.visible = v;
        }
      };
      const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
      const full = [];
      const res = { size: [gfx.targets.main.width, gfx.targets.main.height], msaa: gfx.quality.profile.msaa, uw: +gfx.frame.cam.uw.toFixed(2), modules: {} };
      for (const id of [...ids, 'all']) {
        const hide = id === 'all' ? ids : [id];
        const d = Object.fromEntries([...PASSES, 'total'].map((p) => [p, []]));
        for (let k = 0; k < rounds; k++) {
          const a = measure([]), b = measure(hide);
          full.push(a);
          for (const p of [...PASSES, 'total']) d[p].push(id === 'all' ? b[p] : a[p] - b[p]);
        }
        res.modules[id] = Object.fromEntries(Object.entries(d).map(([p, v]) => [p, +Math.max(0, med(v)).toFixed(2)]));
      }
      res.full = Object.fromEntries([...PASSES, 'total'].map((p) => [p, +Math.min(...full.map((f) => f[p])).toFixed(2)]));
      return res;
    }, { frames, rounds, hour, PASSES });
    out.views[view] = r;
    console.log(`== ${quality} ${view} ${r.size.join('x')} msaa ${r.msaa} uw ${r.uw}`);
    console.log(`${'module'.padEnd(12)}${PASSES.map((p) => p.padStart(11)).join('')}      total`);
    for (const [id, c] of [['FULL', r.full], ...Object.entries(r.modules)]) {
      console.log(`${id.padEnd(12)}${PASSES.map((p) => c[p].toFixed(2).padStart(11)).join('')}${c.total.toFixed(2).padStart(11)}`);
    }
  }
  fs.writeFileSync(path.join(h.out, 'game-costs.json'), JSON.stringify(out, null, 1));
}
