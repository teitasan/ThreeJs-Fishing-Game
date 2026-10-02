/* ===========================================================
   post + hardscape の証拠一式（ARCHITECTURE §6.8・§6.10）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/post+hardscape-proof.mjs --out DIR [--size 2560x1440]
   環境変数：TIER=high|mid|low（既定 high）  ONLY=名前,…（撮る物を絞る）  BENCH=1（GPU の計測も）
   hardscape：桟橋の一人称（晴れ・雨・夜）、床板の接写、横から（杭・筋交い・小舟）、小舟、灯籠（夕・夜。水面の縦の帯）、
              杭の藻（水中から）、苔むした大岩、水中の立ち枯れ、当たりの重ね表示（debug.js の箱）+ 数値（collisionReport）
   post：AO の有無、AgX のチャート（24 パッチ ±4EV）、Bloom（太陽と灯籠）、光芒、露出の遷移（林の陰 → 日向 → 水中）、
         DRS の追従、グレーカードの目標（時刻ごと）、baseline の 7 構図
   各撮影で NaN 0、最後に console のエラー 0・両モジュールが健在
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

export default async function (h) {
  const tier = process.env.TIER || 'high';
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
  const want = (n) => !only || only.has(n) || [...only].some((o) => n.startsWith(o));
  await h.open(`lab/post+hardscape.html?capture=1&tier=${tier}${process.env.QUERY || ''}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 300);
  const fail = [];
  const expect = (ok, msg) => { if (!ok) { fail.push(msg); console.log('  NG', msg); } };
  const out = { tier, shots: {} };

  /* ページ側の道具：桟橋の座標系（spawn 基準の f 前・s 右・y 高さ）でカメラを置く */
  await h.eval(() => {
    const L = window.__lab, D = L.dock, T = L.gfx.THREE;
    const dir = { x: D.dockDir.x, z: D.dockDir.z }, right = { x: dir.z, z: -dir.x };
    const sp = D.spawnPos, Y = D.dockY;
    const at = (f, s, y) => [sp.x + dir.x * f + right.x * s, y, sp.z + dir.z * f + right.z * s];
    const lamp = L.placement.lamp;
    const fl = (lamp.x - sp.x) * dir.x + (lamp.z - sp.z) * dir.z, sl = (lamp.x - sp.x) * right.x + (lamp.z - sp.z) * right.z;
    /* 当たりの重ね表示（debug.js の 2 つの箱と、近くの障害物の円） */
    let overlay = null;
    const setOverlay = (on) => {
      if (overlay) { L.scene.remove(overlay); overlay = null; }
      if (!on) return;
      const t = D, g = new T.Group();
      const yaw = Math.atan2(t._dockU.x, t._dockU.z);
      const Ld = t._dockLen, HW = 1.62;
      const mat = (c) => new T.LineBasicMaterial({ color: c, transparent: true, opacity: 0.95, depthTest: false, fog: false });
      const box = (along, yc, sa, sy, c) => {
        const b = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(HW * 2, sy, sa)), mat(c));
        b.position.set(t.dockStart.x + t._dockU.x * along, yc, t.dockStart.z + t._dockU.z * along);
        b.rotation.y = yaw; b.renderOrder = 900; g.add(b);
      };
      box(Ld / 2, Y - 0.12, Ld, 0.6, 0xff5a4a);
      box(Ld - 1.15, Y + 0.315, 2.3, 1.47, 0xff5a4a);
      const ring = (x, z, r, top, c) => {
        const pts = [];
        for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push(new T.Vector3(x + Math.cos(a) * r, top, z + Math.sin(a) * r)); }
        const l = new T.Line(new T.BufferGeometry().setFromPoints(pts), mat(c));
        l.renderOrder = 900; g.add(l);
      };
      ring(lamp.x, lamp.z, lamp.r, lamp.top, 0x6de08a);
      ring(lamp.x, lamp.z, lamp.r, Y + 0.02, 0x6de08a);
      for (const c of L.placement.boat.circles) { ring(c.x, c.z, c.r, c.top, 0x58b4ff); ring(c.x, c.z, c.r, 0.05, 0x58b4ff); }
      overlay = g; L.scene.add(g);
    };
    window.__ph = {
      Y, at, fl, sl, setOverlay,
      place(o) {
        const pos = o.pos || at(o.f, o.s, o.y), tgt = o.target || at(o.tf, o.ts, o.ty);
        L.cam({ pos, target: tgt });
        L.setHour(o.hour ?? 12.5);
        L.setWeather(o.weather || 'clear', { instant: true });
        L.view(o.view || null);
        const post = L.gfx.modules.get('post');
        post.force = o.force || null;
        post.chart = o.chart ? 1 : 0;
        L.freeze(10);
        L.tick(o.frames || 30);
        const s = L.stats();
        return { nan: L.nanCheck(), exposure: s.exposure, gpu: s.gpuTotal, post: s.modules.post, hs: s.modules.hardscape };
      },
      snag() {
        const S = L.lake.structures.filter((s) => s.kind === 'snag');
        let best = S[0], bd = Infinity;
        for (const s of S) { const d = Math.hypot(s.x - sp.x, s.z - sp.z); if (d < bd) { bd = d; best = s; } }
        return best;
      },
      boulder() {
        let best = null, bd = Infinity;
        for (const b of L.placement.boulders) {
          if (!b.collide || b.size < 1.6 || b.y < 0.6) continue;
          const d = Math.hypot(b.x - sp.x, b.z - sp.z);
          if (d < bd) { bd = d; best = b; }
        }
        return best;
      },
    };
  });

  const P = await h.eval(() => ({ fl: window.__ph.fl, sl: window.__ph.sl, Y: window.__ph.Y }));
  const Y = P.Y;
  const snag = await h.eval(() => window.__ph.snag());
  const bould = await h.eval(() => window.__ph.boulder());
  const shot = async (name, o) => {
    if (!want(name)) return null;
    const r = await h.eval((oo) => window.__ph.place(oo), o);
    await h.shot(name);
    out.shots[name] = r;
    expect(r.nan === 0, `${name}: NaN ${r.nan}`);
    console.log(name, JSON.stringify({ nan: r.nan, exposure: +r.exposure.toFixed(3), hsDraws: r.hs?.draws, postDraws: r.post?.draws }));
    return r;
  };

  /* ---------------- hardscape ---------------- */
  await shot('hs-deck-fp-noon', { f: -6, s: 0.4, y: Y + 1.62, tf: 2, ts: 0, ty: Y + 0.1, hour: 12.5 });
  await shot('hs-deck-fp-rain', { f: -6, s: 0.4, y: Y + 1.62, tf: 2, ts: 0, ty: Y + 0.1, hour: 11, weather: 'rain' });
  await shot('hs-deck-fp-night', { f: -6, s: 0.4, y: Y + 1.62, tf: -20, ts: 1.0, ty: Y + 0.6, hour: 22.5 });
  await shot('hs-deck-macro', { f: -1.2, s: 0.7, y: Y + 0.5, tf: -0.1, ts: 0.2, ty: Y, hour: 10.5 });
  await shot('hs-deck-macro-rain', { f: -1.2, s: 0.7, y: Y + 0.5, tf: -0.1, ts: 0.2, ty: Y, hour: 11, weather: 'rain' });
  await shot('hs-dock-side', { f: -13, s: -8.5, y: 0.7, tf: -13, ts: 0, ty: Y - 0.7, hour: 9 });
  await shot('hs-dock-under', { f: -9, s: -2.4, y: 0.45, tf: -14, ts: 0.5, ty: Y - 0.5, hour: 15 });
  await shot('hs-boat', { f: -22.2, s: -6.6, y: 1.5, tf: -24.5, ts: -3.4, ty: 0.2, hour: 16.5 });
  await shot('hs-lamp-dusk', { f: -24.2, s: 4.2, y: Y + 1.2, tf: P.fl, ts: P.sl, ty: Y + 1.8, hour: 19.1 });
  await shot('hs-lamp-night', { f: -16, s: 11, y: 1.3, tf: P.fl, ts: P.sl, ty: Y + 0.8, hour: 22.5 });
  await shot('hs-lamp-close-night', { f: P.fl + 2.2, s: P.sl - 1.3, y: Y + 1.9, tf: P.fl, ts: P.sl, ty: Y + 2.0, hour: 23 });
  await shot('hs-piles-uw', { f: -5.4, s: -2.5, y: -0.45, tf: -6.85, ts: -1.45, ty: -0.05, hour: 12.5 });
  await shot('hs-piles-uw-deep', { f: -3.0, s: -2.6, y: -2.8, tf: -4.45, ts: -1.45, ty: -3.6, hour: 12.5 });
  if (snag) await shot('hs-snag-uw', { pos: [snag.x + 4.2, -4.0, snag.z + 3.2], target: [snag.x, -9.1 + snag.h * 0.5 - 0.5, snag.z], hour: 12.5 });
  if (bould) {
    const d = 2.6 * bould.size;
    await shot('hs-boulder-moss', { pos: [bould.x + d * 0.8, bould.y + bould.size * 1.1, bould.z + d * 0.6], target: [bould.x, bould.y + bould.size * 0.45, bould.z], hour: 10.5 });
    await shot('hs-boulder-rain', { pos: [bould.x + d * 0.8, bould.y + bould.size * 1.1, bould.z + d * 0.6], target: [bould.x, bould.y + bould.size * 0.45, bould.z], hour: 10.5, weather: 'rain' });
  }
  await shot('hs-shore-rocks', { preset: null, ...(await h.eval(() => window.__lab.presets()['shore-low'])), hour: 9.5 });
  if (want('hs-overlay')) {
    await h.eval(() => window.__ph.setOverlay(true));
    await shot('hs-overlay', { f: -5, s: -6.5, y: Y + 3.2, tf: 0.5, ts: 0, ty: Y + 0.2, hour: 12.5 });
    await shot('hs-overlay-lamp', { f: P.fl + 3, s: P.sl - 4.5, y: Y + 2.8, tf: P.fl, ts: P.sl, ty: Y + 1.0, hour: 12.5 });
    await shot('hs-overlay-boat', { f: -24.5, s: -3.4, y: 7, tf: -24.4, ts: -3.4, ty: 0, hour: 12.5 });
    await h.eval(() => window.__ph.setOverlay(false));
  }
  out.collision = await h.eval(() => window.__lab.gfx.modules.get('hardscape').collisionReport());
  console.log('collision', JSON.stringify(out.collision));
  const C = out.collision;
  expect(Math.abs(C.deckTop.max) <= 2 && Math.abs(C.deckTop.min) <= 2, `床の上面 ${JSON.stringify(C.deckTop)}`);
  expect(C.floorBox.bottomBelow <= 2 && C.floorBox.topOver <= 2 && C.floorBox.alBefore <= 2 && C.floorBox.alOver <= 2, `床の箱 ${JSON.stringify(C.floorBox)}`);
  expect(C.rail.lenFromTip <= 232 && C.rail.siOver <= 2 && C.rail.topOver <= 2, `手すり ${JSON.stringify(C.rail)}`);
  expect(C.lamp.rOver <= 2 && Math.abs(C.lamp.topDiff) <= 2, `灯籠 ${JSON.stringify(C.lamp)}`);
  expect(C.boat.outsideEnds <= 2 && C.boat.topOver <= 2, `小舟 ${JSON.stringify(C.boat)}`);
  expect(C.boulders.rOver <= 2 && C.boulders.topDiff <= 2, `大岩 ${JSON.stringify(C.boulders)}`);
  expect(C.structures.rOver <= 2 && C.structures.topDiff <= 2, `ストラクチャー ${JSON.stringify(C.structures)}`);

  /* ---------------- post ---------------- */
  const pre = await h.eval(() => window.__lab.presets());
  const pv = (n, extra = {}) => ({ pos: pre[n].pos, target: pre[n].target, hour: pre[n].hour, weather: pre[n].weather, ...extra });
  for (const n of ['dawn-3p', 'morning-fp', 'noon-fp-down', 'noon-shore', 'dusk-3p', 'night-fp', 'rain-fp']) await shot(`base-${n}`, pv(n));
  await shot('post-ao-on', { f: -9, s: -2.4, y: 0.45, tf: -14, ts: 0.5, ty: Y - 0.5, hour: 15 });
  await shot('post-ao-off', { f: -9, s: -2.4, y: 0.45, tf: -14, ts: 0.5, ty: Y - 0.5, hour: 15, force: { ao: 0 } });
  await shot('post-ao-view', { f: -9, s: -2.4, y: 0.45, tf: -14, ts: 0.5, ty: Y - 0.5, hour: 15, view: 'post-ao' });
  await shot('post-ao-forest-on', pv('forest-floor', { hour: 11 }));
  await shot('post-ao-forest-off', pv('forest-floor', { hour: 11, force: { ao: 0 } }));
  await shot('post-chart', { f: -6, s: 0, y: Y + 1.6, tf: 2, ts: 0, ty: Y + 1.2, hour: 12.5, chart: true });
  /* 夕日の方角へ向けた構図（桟橋の上から） */
  const sunCam = await h.eval(() => {
    const L = window.__lab, ph = window.__ph;
    L.setHour(17.8); L.freeze(10); L.tick(2);
    const F = L.gfx.frame.data, p = ph.at(-6, 0, ph.Y + 1.6);
    return { pos: p, target: [p[0] + F[8] * 100, p[1] + F[9] * 100, p[2] + F[10] * 100] };
  });
  await shot('post-bloom-sun', { ...sunCam, hour: 17.8 });
  await shot('post-bloom-sun-off', { ...sunCam, hour: 17.8, force: { bloom: 0 } });
  await shot('post-bloom-sun-noshaft', { ...sunCam, hour: 17.8, force: { shaft: 0 } });
  await shot('post-bloom-lamp', { f: -16, s: 11, y: 1.3, tf: P.fl, ts: P.sl, ty: Y + 0.8, hour: 22.5 });
  await shot('post-bloom-lamp-off', { f: -16, s: 11, y: 1.3, tf: P.fl, ts: P.sl, ty: Y + 0.8, hour: 22.5, force: { bloom: 0 } });
  /* 光芒：夕方の低い太陽を林越しに（林の陰から） */
  if (want('post-shaft')) {
    const sh = await h.eval(() => {
      const L = window.__lab; L.setHour(17.2); L.tick(2);
      const F = L.gfx.frame.data, D = L.dock;
      const p = L.presets()['forest-floor'].pos;
      return { pos: p, target: [p[0] + F[8] * 30, p[1] + F[9] * 30, p[2] + F[10] * 30] };
    });
    await shot('post-shaft-on', { ...sh, hour: 17.2 });
    await shot('post-shaft-off', { ...sh, hour: 17.2, force: { shaft: 0 } });
    await shot('post-shaft-view', { ...sh, hour: 17.2, view: 'post-shaft' });
  }

  /* グレーカード（18%・上向き）の表示値：時刻ごと（AgX の CPU 双子） */
  out.greyCard = await h.eval(async () => {
    const { ngGradeParams, ngDisplay } = await import('/src/gfx/post/grade.js');
    const L = window.__lab, F = L.gfx.frame.data, rows = [];
    for (const [hour, w] of [[6.1, 'clear'], [7.5, 'clear'], [9, 'clear'], [12.5, 'clear'], [12.5, 'cloudy'], [11, 'rain'], [16.5, 'clear'], [17.8, 'clear'], [18.6, 'clear'], [19.3, 'clear'], [22.5, 'clear'], [2, 'clear']]) {
      L.setHour(hour); L.setWeather(w, { instant: true }); L.freeze(10); L.tick(3);
      const kr = [F[4], F[5], F[6]], kd = F[1], sky = [F[12], F[13], F[14]], e = F[64];
      const E = kr.map((v, i) => v * Math.max(kd, 0) + Math.PI * sky[i]);
      const Lc = E.map((v) => 0.18 * v / Math.PI * e);
      const alt = Math.asin(Math.max(-1, Math.min(1, F[7]))) * 180 / Math.PI;
      const g = ngGradeParams({ sunAltDeg: alt, night: F[3], cloud: w === 'clear' ? 0.14 : w === 'cloudy' ? 0.72 : 0.95, rain: w === 'rain' ? 0.85 : 0, uw: 0 });
      const d = ngDisplay(Lc, g);
      rows.push({ hour, w, alt: +alt.toFixed(1), exposure: +e.toFixed(3), cardLin: +(0.2126 * Lc[0] + 0.7152 * Lc[1] + 0.0722 * Lc[2]).toFixed(4), display: d.map((v) => +v.toFixed(3)) });
    }
    return rows;
  });
  console.log('greyCard', JSON.stringify(out.greyCard));

  /* 露出の遷移（順応を動かす：撮影の固定を外す）：林の陰 → 日向の桟橋 → 水中 */
  if (want('post-expo')) {
    out.exposure = await h.eval(async () => {
      const L = window.__lab, post = L.gfx.modules.get('post'), pr = L.presets();
      const seq = [];
      const run = async (name, cam, sec) => {
        L.cam(cam);
        for (let i = 0; i < sec * 30; i++) {
          L.tick(1, 1 / 30);
          if (i % 3 === 0) await new Promise((r) => setTimeout(r, 4));
          if (i % 6 === 0) seq.push({ seg: name, t: +(seq.length * 0.2).toFixed(1), e: +post.exposure.toFixed(4), adapt: +post.adapt.toFixed(4), meter: Number.isFinite(post.meterLog2) ? +post.meterLog2.toFixed(3) : null });
        }
      };
      L.setHour(11); L.setWeather('clear', { instant: true });
      L.unfreeze();
      post.adapt = 1; post.adaptTarget = 1;
      await run('forest', { pos: pr['forest-floor'].pos, target: pr['forest-floor'].target }, 5);
      await run('dock', { pos: pr['noon-shore'].pos, target: pr['noon-shore'].target }, 5);
      await run('uw', { pos: pr['uw-dock'].pos, target: pr['uw-dock'].target }, 5);
      /* ポーズ（dt = 0）で順応が止まる */
      const a0 = post.adapt;
      for (let i = 0; i < 20; i++) { L.tick(1, 0); await new Promise((r) => setTimeout(r, 4)); }
      const paused = { before: a0, after: post.adapt };
      L.freeze(10);
      return { seq, paused };
    });
    const ex = out.exposure;
    const seg = (s) => ex.seq.filter((r) => r.seg === s);
    const last = (s) => seg(s)[seg(s).length - 1];
    console.log('exposure', JSON.stringify({ forest: last('forest'), dock: last('dock'), uw: last('uw'), paused: ex.paused }));
    let maxJump = 0;
    for (let i = 1; i < ex.seq.length; i++) maxJump = Math.max(maxJump, Math.abs(Math.log2(ex.seq[i].e / ex.seq[i - 1].e)));
    ex.maxStepEV = +maxJump.toFixed(3);
    expect(Math.abs(Math.log2(last('forest').adapt)) <= 1.01 && Math.abs(Math.log2(last('dock').adapt)) <= 1.01, '順応が ±1EV を超えた');
    expect(ex.paused.before === ex.paused.after, `ポーズで順応が止まらない ${JSON.stringify(ex.paused)}`);
    /* 0.2 秒ごとの露出の変化が 0.5EV 未満（滑らか）。水中への切り替えの 1 歩は水中の係数の damp で滑らか */
    expect(maxJump < 0.5, `露出の遷移が急 ${maxJump}`);
  }

  /* DRS の追従：重いフレーム（30ms）を見せると段が下がり、軽く（8ms）すると戻る。下がった所の絵（拡大 + CAS）も撮る */
  if (want('post-drs')) {
    await h.eval((y) => window.__ph.place({ f: -6, s: 0.4, y: y + 1.62, tf: 2, ts: 0, ty: y + 0.1, hour: 12.5 }), Y);
    const drsRun = (ms, sec) => h.eval(async ({ ms, sec }) => {
      const L = window.__lab, post = L.gfx.modules.get('post'), pipe = L.gfx.pipeline;
      L.unfreeze();
      /* DRS に «このフレームは ms かかった» と見せる（実時間の 1/30 秒ずつ進む模擬） */
      const orig = post.drs.update;
      post.drs.update = (f, d, frozen) => orig.call(post.drs, ms, 1 / 30, frozen);
      const seq = [];
      try {
        for (let i = 0; i < sec * 30; i++) {
          L.tick(1, 1 / 30);
          if (i % 15 === 0) { seq.push({ ms, scale: pipe.renderScale }); await new Promise((r) => setTimeout(r, 1)); }
        }
      } finally { post.drs.update = orig; }
      return { scale: pipe.renderScale, changes: post.drs.changes, seq };
    }, { ms, sec });
    const heavy = await drsRun(30, 8);
    if (want('post-drs')) await h.shot('post-drs-low');
    const light = await drsRun(8, 30);
    await h.eval(() => window.__lab.freeze(10));
    out.drs = { low: heavy.scale, back: light.scale, changes: light.changes, seq: [...heavy.seq, ...light.seq] };
    console.log('drs', JSON.stringify({ low: out.drs.low, back: out.drs.back, changes: out.drs.changes }));
    expect(out.drs.low < 1 && out.drs.back > out.drs.low, `DRS が追従しない ${JSON.stringify({ low: out.drs.low, back: out.drs.back })}`);
  }

  /* プログラムの監査（サンプラーの上限・自分のプログラム ≤ 6） */
  out.programs = await h.eval(() => {
    const a = window.__lab.programAudit();
    return { count: a.count, over: a.over, failed: a.failed, byModule: a.byModule };
  });
  console.log('programs', JSON.stringify({ count: out.programs.count, post: out.programs.byModule?.post, hardscape: out.programs.byModule?.hardscape, over: out.programs.over?.length, failed: out.programs.failed?.length }));
  expect(!(out.programs.over?.length) && !(out.programs.failed?.length), `サンプラーの上限超え / リンク失敗 ${JSON.stringify({ over: out.programs.over, failed: out.programs.failed })}`);
  for (const id of ['post', 'hardscape']) {
    const n = out.programs.byModule?.[id];
    expect((n || 0) <= 6, `${id} のプログラム ${n} > 6`);
  }

  if (process.env.BENCH === '1') {
    out.bench = await h.eval(() => {
      const L = window.__lab, pr = L.presets();
      const res = {};
      for (const n of ['dock-3p', 'noon-fp-down', 'night-fp', 'uw-dock']) {
        L.cam({ pos: pr[n].pos, target: pr[n].target });
        L.setHour(pr[n].hour ?? 12.5); L.setWeather(pr[n].weather || 'clear', { instant: true }); L.freeze(10); L.tick(5);
        const b = L.bench({ frames: 40, windows: 5, passes: true });
        const mc = L.moduleCosts({ frames: 30, rounds: 3 });
        res[n] = { frameMsMin: b.frameMsMin, post: b.passes?.post, passMin: b.passMin?.post, hardscape: mc.modules.hardscape, size: b.size };
      }
      return res;
    });
    console.log('bench', JSON.stringify(out.bench));
  }

  out.health = await h.eval(() => {
    const gfx = window.__lab.gfx, s = gfx.safety;
    const one = (id) => { const m = gfx.modules.get(id); return { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null }; };
    return { post: one('post'), hardscape: one('hardscape'), dead: [...s.deadPasses] };
  });
  out.counts = h.counts();
  out.warnings = h.logs.filter((l) => /\[ng\] (post|hardscape)\.|モジュール (post|hardscape) /.test(l)).length;
  console.log('health', JSON.stringify(out.health), JSON.stringify(out.counts), 'warnings', out.warnings);
  for (const id of ['post', 'hardscape']) {
    const H = out.health[id];
    expect(H.strikes === 0 && !H.disabled && H.stub === false, `${id} が健在でない ${JSON.stringify(H)}`);
  }
  expect(out.health.dead.length === 0, `止まったパス ${out.health.dead}`);
  expect(out.counts.errors === 0 && out.counts.pageErrors === 0, `console のエラー ${out.counts.errors}・ページ例外 ${out.counts.pageErrors}`);
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, `proof-${tier}.json`), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`post+hardscape-proof: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('post+hardscape-proof: 合格');
}
