/* ===========================================================
   underwater + weatherfx の GPU の重さ（直接の同期計測）
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/underwater+weatherfx-bench.mjs --out DIR --size 2560x1440   （high）
   TIER=mid --size 1920x1080 / TIER=low --size 1280x720
   -----------------------------------------------------------
   全体 − 隠した（moduleCosts）は他の担当の Chrome と GPU を取り合う今の環境では ±4ms 揺れて負にもなる。
   しかも hide は root を隠すだけで、post の中の水中の Effect は消えない。なので «自分の描画だけ» を
   1×1 の readPixels で挟んで N 回まとめて測る（5 回の最小 = 邪魔の無いときの値。CORE_API §16.4）
   - underwater：光柱（半解像度の RT + 分離ぼかし 2 回 = fx.renderRays）、合成（post の EffectPass を uP.x 1 / 0 で比べる）、プランクトン
   - weatherfx：自分の root（雨の筋・着弾・幕・霧の板・蛍・塵）を main の RT（不透明の深度入り）へ重ねて描く。雨・夜明け・22 時
   出力：DIR/bench-<段>.json
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

export default async function (h) {
  const tier = process.env.TIER || 'high';
  await h.open(`lab/underwater+weatherfx.html?capture=1&tier=${tier}&chart=0`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const r = await h.eval(() => {
    const L = window.__lab, g = L.gfx, R = L.renderer, gl = R.getContext();
    const uw = g.modules.get('underwater'), wf = g.modules.get('weatherfx');
    const px = new Uint8Array(4);
    const sync = (rt) => { R.setRenderTarget(rt || null); if (rt && rt.texture.type !== 1009) { const f = new Uint16Array(4); R.readRenderTargetPixels(rt, 0, 0, 1, 1, f); } else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const time = (fn, rt, n = 20) => {
      const res = [];
      for (let k = 0; k < 5; k++) {
        sync(rt);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        sync(rt);
        res.push((performance.now() - t0) / n);
      }
      res.sort((a, b) => a - b);
      return +res[0].toFixed(3);
    };
    const setView = (cam, hour, wx) => { L.unfreeze(); L.cam(cam); L.setHour(hour); L.setWeather(wx, { instant: true }); L.tick(40, 1 / 60); L.freeze(10); L.tick(3); };
    const out = { size: [g.targets.main.width, g.targets.main.height], tier: g.quality.tier };

    /* ---- underwater（uw-dock の正午） ---- */
    setView('uw-dock', 12.5, 'clear');
    const fx = uw.fx, main = g.targets.main;
    out.uw = { raysOn: fx.raysOn, steps: fx.steps };
    out.uw.rays = fx.raysOn ? time(() => fx.renderRays(R, main), fx.rt) : 0;
    /* 合成：1 フレームの post のパスの GPU 時間（sync の bench）を Effect の有効 / 無効で比べる */
    const postMs = (on) => {
      globalThis.__ngUwFxOff = !on;
      const b = L.bench({ frames: 30, warm: 4, windows: 3, passes: true });
      globalThis.__ngUwFxOff = false;
      return b.passMin;
    };
    const pOn = postMs(true), pOff = postMs(false);
    out.uw.passOn = pOn; out.uw.passOff = pOff;
    const scene0 = new (uw.ctx.THREE.Scene)();
    const pl = uw.plankton?.points || uw.root;
    const parent = uw.root.parent;
    scene0.add(uw.root);
    const cam = L.camera, mask = cam.layers.mask;
    cam.layers.enableAll();
    const ac = R.autoClear; R.autoClear = false;
    out.uw.plankton = time(() => { R.setRenderTarget(main); R.render(scene0, cam); }, main);
    const empty = new (uw.ctx.THREE.Scene)();
    out.uw.emptyRender = time(() => { R.setRenderTarget(main); R.render(empty, cam); }, main);
    parent.add(uw.root);
    void pl;

    /* ---- weatherfx ---- */
    const wfMs = (camv, hour, wx) => {
      cam.layers.mask = mask;
      setView(camv, hour, wx);
      cam.layers.enableAll();
      const p = wf.root.parent;
      const s = new (uw.ctx.THREE.Scene)();
      s.add(wf.root);
      const draw = () => { R.setRenderTarget(main); R.render(s, cam); };
      /* 自分の root の «見える物» を 1 つずつ（他を隠して）と、全部、何も無し。差 = その物の GPU ms */
      const kids = wf.root.children.filter((c) => c.visible);
      const none = () => { for (const c of kids) c.visible = false; };
      const all = () => { for (const c of kids) c.visible = true; };
      none(); const t0 = time(draw, main); all();
      const tAll = time(draw, main);
      const parts = {};
      for (const c of kids) { none(); c.visible = true; parts[c.name] = +(time(draw, main) - t0).toFixed(3); }
      all();
      p.add(wf.root);
      return { ms: +(tAll - t0).toFixed(3), parts, stats: wf.stats() };
    };
    out.wf = {
      rain: wfMs('rain-fp', 11, 'rain'),
      rain3p: wfMs('dock-3p', 11, 'rain'),
      dawn: wfMs('dawn-3p', 6.1, 'clear'),
      fireflies: wfMs('night-fp', 22, 'clear'),
      noonClear: wfMs('dock-3p', 12.5, 'clear'),
    };
    R.autoClear = ac;
    cam.layers.mask = mask;
    R.setRenderTarget(null);
    return out;
  });
  fs.writeFileSync(path.join(h.out, `bench-${tier}.json`), JSON.stringify(r, null, 1));
  const net = (v) => +(v - r.uw.emptyRender).toFixed(3);
  const show = (v) => v;
  console.log(`== ${tier} ${r.size.join('x')}`);
  console.log(`underwater: rays ${r.uw.rays}ms (steps ${r.uw.steps}) / post on ${JSON.stringify(r.uw.passOn)} off ${JSON.stringify(r.uw.passOff)} / plankton ${net(r.uw.plankton)}ms（空の描画 ${r.uw.emptyRender} を引いた）`);
  for (const [k, v] of Object.entries(r.wf)) console.log(`weatherfx ${k}: ${show(v.ms)}ms ${JSON.stringify(v.parts)} draws ${v.stats.draws} inst ${v.stats.instances}`);
  console.log('counts', JSON.stringify(h.counts()));
}
