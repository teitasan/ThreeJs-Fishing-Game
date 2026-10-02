/* ===========================================================
   underwater（§6.3）+ weatherfx（§6.9）の証拠一式
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/underwater+weatherfx-proof.mjs --out DIR [--size 2560x1440]
   環境変数：TIER（既定 high）、ONLY=名前,名前（撮る物を絞る）、BENCH=1（3 段の自分の GPU ms も測る。遅い）、NOSHOT=1
   撮る物（§6.3）：uw-dock 正午（桟橋の影で切れる光柱）・桟橋の下を横切る光柱・weedbed-uw・見上げのスネルの窓・半潜り・
     水中の夜明け / 黄金 / 夜 / 雨・noon-fp-down の湖底の caustics
   撮る物（§6.9）：雨の一人称・雨の三人称（桟橋の着弾）・雨の夜の灯籠・森の雨（樹冠の下は降らない）・日の出の朝霧（2 枚）・22:00 の蛍・森の朝の塵
   数値：各枚の NaN・両モジュールの stats、programAudit（自分のプログラム数・サンプラー）、本物の魚の caustics（fishCheck）、
     caustics の焼き込み ms、グレーカード（0.18）の 10/20/30m のコントラスト（GPU で実測 + 解析）、console のエラー 0・両モジュールの健在
   出力：DIR/<段>-<名前>.png と DIR/proof.json
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = [
  /* underwater */
  ['uw-dock-noon', 'uw-dock', 12.5, 'clear'],
  ['uw-dock-shafts', 'dockx:8', 12.5, 'clear'],
  ['uw-weedbed', 'weedbed-uw', 12.5, 'clear'],
  ['uw-snell', 'snell', 12.5, 'clear'],
  ['uw-halfsub', 'waterline', 12.5, 'clear'],
  ['uw-dawn', 'uw-dock', 6.3, 'clear'],
  ['uw-golden', 'sun:end:0:6', 17.6, 'clear'],
  ['uw-night', 'uw-dock', 22.5, 'clear'],
  ['uw-rain', 'uw-dock', 11, 'rain'],
  ['noon-fp-down', 'noon-fp-down', 12.5, 'clear'],
  /* weatherfx */
  ['rain-fp', 'rain-fp', 11, 'rain'],
  ['rain-3p', 'dock-3p', 11, 'rain'],
  ['rain-night-lamp', 'dockback', 21.5, 'rain'],
  ['rain-forest', 'forest-floor', 11, 'rain'],
  ['mist-dawn-3p', 'dawn-3p', 6.1, 'clear'],
  ['mist-dawn-low', '{"pos":[25,2.2,-78],"target":[10,1.2,-30]}', 5.7, 'clear'],
  ['fireflies-22', 'dockback', 22, 'clear'],
  ['motes-forest', 'sun:forest-floor:0:8', 7.2, 'clear'],
];

/* ページ側：カメラの指定（プリセット名・JSON・sun:<基準>:<方位のずれ>:<仰角>[:<高さ>]・dockx:<仰角>[:<横>]・snell・dockback） */
function camSpec(cam, hour) {
  const L = window.__lab, D = L.dock;
  const len = Math.hypot(D.dockEnd.x - D.dockStart.x, D.dockEnd.z - D.dockStart.z);
  if (cam.startsWith('{')) return L.cam(JSON.parse(cam));
  if (cam === 'snell') {
    /* 桟橋の先 3m・深さ 1.8m から、ほぼ真上（天頂から 25°）を見上げる */
    const x = D.dockEnd.x + D.dockDir.x * 3, z = D.dockEnd.z + D.dockDir.z * 3;
    const y = -Math.min(1.8, L.lake.depthAt(x, z) * 0.6);
    return L.cam({ pos: [x, y, z], target: [x + D.dockDir.x * 4.2, y + 9, z + D.dockDir.z * 4.2] });
  }
  if (cam === 'dockback') {
    /* 桟橋の中ほどから付け根・汀線の葦を振り返る（灯籠・蛍） */
    const x = D.dockEnd.x - D.dockDir.x * len * 0.45, z = D.dockEnd.z - D.dockDir.z * len * 0.45;
    return L.cam({ pos: [x, D.dockY + 1.45, z], target: [D.dockStart.x + D.dockDir.z * 4, 0.8, D.dockStart.z - D.dockDir.x * 4] });
  }
  if (cam.startsWith('sun:')) {
    const [, base, da, pitch, yy] = cam.split(':');
    let P = L.presets()[base];
    if (base === 'end') {
      const x = D.dockEnd.x + D.dockDir.x * 3, z = D.dockEnd.z + D.dockDir.z * 3;
      P = { pos: [x, -Math.min(1.6, L.lake.depthAt(x, z) * 0.5), z] };
    }
    const a = ((Number(hour) - 6) / 24) * Math.PI * 2;
    const az = Math.atan2(0.34, Math.cos(a)) + (Number(da) || 0) * Math.PI / 180;
    const pos = [P.pos[0], yy !== undefined ? Number(yy) : P.pos[1], P.pos[2]];
    const pr = (Number(pitch) || 0) * Math.PI / 180;
    return L.cam({ pos, target: [pos[0] + Math.cos(az) * Math.cos(pr) * 30, pos[1] + Math.sin(pr) * 30, pos[2] + Math.sin(az) * Math.cos(pr) * 30] });
  }
  if (cam.startsWith('dockx:')) {
    const [, pitch, side] = cam.split(':').map(Number);
    const s = side || 4.5;
    const cx = D.dockEnd.x - D.dockDir.x * 0.3 * len, cz = D.dockEnd.z - D.dockDir.z * 0.3 * len;
    const x = cx + D.dockDir.z * s, z = cz - D.dockDir.x * s;
    const y = -Math.min(1.4, L.lake.depthAt(x, z) * 0.55);
    const pr = (pitch || 0) * Math.PI / 180, dx = cx - x, dz = cz - z, dl = Math.hypot(dx, dz);
    return L.cam({ pos: [x, y, z], target: [x + dx / dl * 10 * Math.cos(pr), y + Math.sin(pr) * 10, z + dz / dl * 10 * Math.cos(pr)] });
  }
  return L.cam(cam);
}

export default async function (h) {
  const tier = process.env.TIER || 'high';
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
  await h.open(`lab/underwater+weatherfx.html?capture=1&tier=${tier}${process.env.QUERY || ''}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  await h.page.evaluate(`window.__uwfxCam = ${camSpec.toString()}`);
  const out = { tier, shots: {}, boot: null };
  out.boot = await h.eval(() => {
    const L = window.__lab, g = L.gfx, r = {};
    for (const id of ['underwater', 'weatherfx']) {
      const m = g.modules.get(id);
      r[id] = { stub: m?._ngStub ?? null, load: g.loadStats?.modules?.[id], stats: m?.stats?.() };
    }
    r.bake = g.modules.get('underwater')?.bakeInfo || null;
    return r;
  });
  console.log('boot', JSON.stringify(out.boot));

  for (const [name, cam, hour, weather] of SHOTS) {
    if (only && !only.has(name)) continue;
    const r = await h.eval(({ cam, hour, weather }) => {
      const L = window.__lab;
      L.unfreeze();
      L.setHour(Number(hour));
      window.__uwfxCam(cam, hour);
      L.setHour(Number(hour));
      L.setWeather(weather, { instant: true });
      L.view(null);
      L.tick(90, 1 / 60);
      L.freeze(10);
      L.tick(4);
      const g = L.gfx, s = L.stats();
      const uw = g.modules.get('underwater'), wf = g.modules.get('weatherfx');
      return { nan: L.nanCheck(), uw: s.uw, lum: +L.meanLuminance().toFixed(5), underwater: uw?.stats?.(), weatherfx: wf?.stats?.(), draws: s.draws };
    }, { cam, hour, weather });
    if (!process.env.NOSHOT) await h.shot(`${tier}-${name}`);
    out.shots[name] = r;
    console.log(name, JSON.stringify(r));
    if (r.nan > 0) throw new Error(`${name}: NaN ${r.nan}`);
  }

  /* グレーカード（アルベド 0.18、1.6m 角、カメラを向く）を 10/20/30m に並べて、露出前のリニアの輝度を GPU で読む。
     背景 = 板の横（板の幅 1.2 枚分の外）の同じ高さ。コントラスト = |板 − 背景| / 背景（Weber）。
     カメラ：桟橋の先 3m・深さ 1.5m から沖へ水平に（水中 → 水中）。晴れの正午と雨 */
  out.greyCards = {};
  if (!only || only.has('greycards')) {
    for (const [wx, hour] of [['clear', 12.5], ['rain', 11]]) {
      out.greyCards[wx] = await h.eval(async ({ wx, hour }) => {
        const L = window.__lab, T = L.gfx.modules.get('underwater').ctx.THREE;
        const { ngExtendStandard } = await import(new URL('src/gfx/core/extend.js', document.baseURI).href);
        const { greyCardContrast } = await import(new URL('src/gfx/underwater/optics.js', document.baseURI).href);
        const D = L.dock;
        const x0 = D.dockEnd.x + D.dockDir.x * 3, z0 = D.dockEnd.z + D.dockDir.z * 3, y0 = -1.5;
        const fwd = new T.Vector3(D.dockDir.x, 0, D.dockDir.z).normalize(), side = new T.Vector3(fwd.z, 0, -fwd.x);
        L.unfreeze(); L.setHour(hour); L.setWeather(wx, { instant: true });
        L.cam({ pos: [x0, y0, z0], target: [x0 + fwd.x * 40, y0, z0 + fwd.z * 40] });
        const mat = ngExtendStandard(new T.MeshStandardMaterial({ color: new T.Color().setRGB(0.18, 0.18, 0.18), roughness: 1, metalness: 0 }), { key: 'proof-greycard', module: 'proof' });
        const geo = new T.PlaneGeometry(1.6, 1.6);
        const cards = [];
        const dists = [10, 20, 30];
        dists.forEach((d, i) => {
          const m = new T.Mesh(geo, mat);
          const off = (i - 1) * d * Math.tan(9 * Math.PI / 180);
          m.position.set(x0 + fwd.x * d + side.x * off, y0, z0 + fwd.z * d + side.z * off);
          m.lookAt(x0, y0, z0);
          L.scene.add(m);
          cards.push(m);
        });
        /* 背景の壁（アルベド 0.18、90m 先）：透過 e^(−σt·90) < 1e-4 なので «水の霞» そのもの。
           sceneColor は post の前なので空の画素は空のドームの色のまま（Effect の «無限の水» が入らない）→ 壁で霞を描かせる */
        const wallGeo = new T.PlaneGeometry(120, 60);
        const wall = new T.Mesh(wallGeo, mat);
        wall.position.set(x0 + fwd.x * 90, y0, z0 + fwd.z * 90);
        wall.lookAt(x0, y0, z0);
        L.scene.add(wall);
        L.tick(60, 1 / 60); L.freeze(10); L.tick(4);
        const rt = L.gfx.targets.copy, cam = L.camera;
        const half = (v) => { const s = v & 0x8000 ? -1 : 1, e = (v >> 10) & 31, f = v & 1023; return s * (e === 0 ? 6.1035e-5 * (f / 1024) : e === 31 ? 0 : Math.pow(2, e - 15) * (1 + f / 1024)); };
        const lumAt = (p) => {
          const v = p.clone().project(cam);
          const px = Math.round((v.x * 0.5 + 0.5) * rt.width), py = Math.round((v.y * 0.5 + 0.5) * rt.height);
          const w = 4, buf = new Uint16Array(w * w * 4);
          L.renderer.readRenderTargetPixels(rt, px - 2, py - 2, w, w, buf, undefined, 0);
          let s = 0;
          for (let k = 0; k < buf.length; k += 4) s += 0.2126 * half(buf[k]) + 0.7152 * half(buf[k + 1]) + 0.0722 * half(buf[k + 2]);
          return s / (w * w);
        };
        const res = {};
        cards.forEach((m, i) => {
          const c = lumAt(m.position.clone());
          const bp = m.position.clone().addScaledVector(side, 1.6 * 1.2 * (i === 0 ? -1 : 1));
          const b = lumAt(bp);
          res[`${dists[i]}m`] = { card: +c.toFixed(5), bg: +b.toFixed(5), weber: +(Math.abs(c - b) / Math.max(b, 1e-6)).toFixed(3) };
        });
        /* 解析（optics.js）：同じ光学の値、縦の板の放射照度は «屈折した key の方位平均 0.3 + 空の半分 0.5»、深さ 1.5m */
        const uw = L.gfx.modules.get('underwater'), op = uw._op;
        const { NG } = await import(new URL('src/gfx/core/frame.js', document.baseURI).href);
        const F = uw.ctx.frame.data;
        if (op) {
          const E = op.keyE.map((e, k) => (e * 0.3 + F[NG.AMB * 4 + k] * Math.PI * 0.8 * 0.5) * Math.exp(-(op.sigmaA[k] + 0.3 * op.sigmaS) * 1.5));
          res.analytic = Object.fromEntries(dists.map((d) => [`${d}m`, +greyCardContrast(d, op, E).toFixed(3)]));
        }
        for (const m of cards) L.scene.remove(m);
        L.scene.remove(wall);
        geo.dispose(); wallGeo.dispose(); mat.dispose();
        return res;
      }, { wx, hour });
      if (!process.env.NOSHOT) await h.shot(`${tier}-greycards-${wx}`);
      console.log('greycards', wx, JSON.stringify(out.greyCards[wx]));
    }
  }

  /* プログラムの監査（自分の 2 つ）と本物の魚 */
  out.audit = await h.eval(() => {
    const a = window.__lab.programAudit();
    const mine = a.programs.filter((p) => /underwater|weatherfx/.test(p.tag || '') || /underwater|weatherfx/.test(p.name || ''));
    return { count: a.count, over: a.over, failed: a.failed, byModule: { underwater: a.byModule?.underwater, weatherfx: a.byModule?.weatherfx }, mine: mine.map((p) => ({ name: p.name, tag: p.tag, frag: p.frag, vert: p.vert, runnable: p.runnable })) };
  });
  out.fish = await h.eval(() => window.__lab.fishCheck());
  console.log('audit', JSON.stringify(out.audit));
  console.log('fish', JSON.stringify(out.fish));

  /* 予算（BENCH=1）：全体 − 自分を隠した、の差の中央値（5 回）。underwater は水中（uw-dock）と水上（dock-3p）、weatherfx は雨（rain-fp）と晴れの夜明け（dawn-3p） */
  if (process.env.BENCH === '1') {
    out.bench = await h.eval(() => {
      const L = window.__lab, r = {};
      const cost = (id) => {
        const d = [];
        for (let k = 0; k < 5; k++) {
          const a = L.bench({ frames: 40, warm: 6, windows: 3, passes: false });
          const b = L.bench({ frames: 40, warm: 6, windows: 3, passes: false, hide: [id] });
          d.push(a.frameMsMin - b.frameMsMin);
        }
        d.sort((x, y) => x - y);
        return +d[2].toFixed(3);
      };
      for (const [view, hour, wx, id] of [['uw-dock', 12.5, 'clear', 'underwater'], ['dock-3p', 12.5, 'clear', 'underwater'], ['rain-fp', 11, 'rain', 'weatherfx'], ['dawn-3p', 6.1, 'clear', 'weatherfx'], ['dock-3p', 12.5, 'clear', 'weatherfx']]) {
        L.unfreeze(); L.cam(view); L.setHour(hour); L.setWeather(wx, { instant: true }); L.tick(30); L.freeze(10);
        r[`${id}@${view}/${wx}`] = { ms: cost(id), frameMs: +L.bench({ frames: 40, passes: false }).frameMsMin.toFixed(2) };
      }
      return r;
    });
    console.log('bench', JSON.stringify(out.bench));
  }

  out.health = await h.eval(() => {
    const g = window.__lab.gfx, s = g.safety, r = {};
    for (const id of ['underwater', 'weatherfx']) {
      const m = g.modules.get(id);
      r[id] = { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null, restarts: g._restarts.get(id) || 0 };
    }
    r.deadPasses = [...s.deadPasses];
    return r;
  });
  out.console = h.counts();
  console.log('health', JSON.stringify(out.health), JSON.stringify(out.console));
  fs.writeFileSync(path.join(h.out, `proof-${tier}.json`), JSON.stringify(out, null, 1));
  for (const id of ['underwater', 'weatherfx']) {
    const st = out.health[id];
    if (st.stub || st.disabled || st.strikes) throw new Error(`${id} が健在でない ${JSON.stringify(st)}`);
  }
  if (out.console.errors || out.console.pageErrors) throw new Error(`console のエラー ${JSON.stringify(out.console)}`);
}
