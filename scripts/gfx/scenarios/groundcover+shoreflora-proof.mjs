/* ===========================================================
   groundcover + shoreflora の証拠一式（ARCHITECTURE §6.6・§6.7）
   -----------------------------------------------------------
   PW_MODULE=… node scripts/gfx/shot.mjs scripts/gfx/scenarios/groundcover+shoreflora-proof.mjs --out DIR --size 1280x720 --timeout 900
   環境変数：TIERS=high,mid,low（既定 3 段）、HERO=0（2560×1440 の撮影を省く）、BENCH=0（GPU ms を省く）
   lab/groundcover.html（統合済みの sky・water・terrain・trees + 担当の 2 つ、釣り人なし）で：
     1. 起動・止めずに 300 フレーム・健在（両モジュール）・プログラムの監査（各 ≤ 6、サンプラーの上限）・NaN 0
     2. 構図を «探す»（計算パスの読み戻しで草地・笹の群落、placement で逆光のヨシ原・睡蓮の群落・藪）
     3. §6.6：一人称の林床・岸の草地・17:30 の逆光の草原・藪の輪を 10m から・雨で濡れた草・消える縁（60m）
        §6.7：桟橋からヨシ原（夕方の逆光）・睡蓮の群落・藻場の水中・雨の浮葉・夜
     4. 数値：根元の色の ΔE（上から見て、根元 12% と同じ画素の地面）、浮葉の高さ（GPU の式 − CPU の surfaceY）、
        藻場の被覆（lake.flats の各円）、ヨシの水深（葦際の 1.5m の等深線の内側）と地図の重ね絵 2 枚
     5. GPU ms（全体 − 隠した、3 回の中央値）を視点ごと・段ごと
   出力：DIR/*.png、DIR/proof.json
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from '../png.mjs';

const IDS = ['groundcover', 'shoreflora'];
const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

/* sRGB 8bit → CIELAB（D65） */
function lab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export default async function (h) {
  const tiers = list(process.env.TIERS, ['high', 'mid', 'low']);
  const out = { tiers: {}, numbers: {} };
  const fail = [];
  const expect = (ok, msg) => { if (!ok) { fail.push(msg); console.log('  NG', msg); } };
  for (const tier of tiers) {
    const c0 = h.counts(), log0 = h.logs.length;
    await h.open(`lab/groundcover.html?capture=1&tier=${tier}&chars=0`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 300);
    const T = (out.tiers[tier] = { shots: {} });
    T.boot = await h.eval((ids) => {
      const L = window.__lab;
      return Object.fromEntries(ids.map((id) => {
        const m = L.gfx.modules.get(id);
        return [id, { stub: m?._ngStub ?? null, load: L.gfx.loadStats?.modules?.[id] ?? null }];
      }));
    }, IDS);
    for (const id of IDS) expect(T.boot[id].stub === false, `${tier}: ${id} がスタブ`);
    /* 止めずに回す（update の時間の道・踏み倒し・選び出し） */
    await h.eval(() => {
      const L = window.__lab;
      L.unfreeze(); L.cam('shore-low'); L.setHour(12.5); L.setWeather('clear', { instant: true });
      L.tick(300, 1 / 60);
    });

    /* ---- 構図を探す ---- */
    const spots = await h.eval(() => {
      const L = window.__lab, lake = L.lake, gc = L.gfx.modules.get('groundcover'), P = L.placement;
      const d = lake.dock, end = d.end, st = d.start;
      const ang0 = Math.atan2(end.z, end.x);
      const H = (x, z) => Math.max(lake.heightAt(x, z), 0);
      L.freeze(10);
      let meadow = null, sasa = null;
      for (let da = -Math.PI; da < Math.PI; da += 0.14) {
        for (const inland of [16, 26, 36]) {
          const a = ang0 + da, r = lake.shoreAtAngle(a) + inland;
          const x = Math.cos(a) * r, z = Math.sin(a) * r, y = H(x, z);
          L.cam({ pos: [x, y + 1.7, z], target: [x + Math.cos(a) * 8, H(x + Math.cos(a) * 8, z + Math.sin(a) * 8) + 0.3, z + Math.sin(a) * 8] });
          L.tick(2);
          const c = gc.debugCounts();
          const g = (c[0]?.alive || 0) + (c[1]?.alive || 0) * 0.5;
          const s = c[2]?.kinds?.[1] || 0, f = c[2]?.kinds?.[2] || 0;
          if (!meadow || g > meadow.score) meadow = { score: g, x, z, y, a };
          if (!sasa || s + f > sasa.score) sasa = { score: s + f, x, z, y, a, sasa: s, fern: f };
        }
      }
      /* 17:30 の逆光の草原：太陽へ向いて、草が多く・山の影の外（計算パスの hf）の所 */
      L.setHour(17.5); L.tick(24);
      const sa0 = ((17.5 - 6) / 24) * Math.PI * 2, sl = Math.hypot(Math.cos(sa0), 0.34), sux = Math.cos(sa0) / sl, suz = 0.34 / sl;
      let back = null;
      for (let da = -Math.PI; da < Math.PI; da += 0.14) {
        for (const inland of [12, 20, 30]) {
          const a = ang0 + da, r = lake.shoreAtAngle(a) + inland;
          const x = Math.cos(a) * r, z = Math.sin(a) * r, y = H(x, z);
          L.cam({ pos: [x, y + 1.6, z], target: [x + sux * 8, H(x + sux * 8, z + suz * 8) + 0.6, z + suz * 8] });
          L.tick(2);
          const c = gc.debugCounts();
          const g = ((c[0]?.alive || 0) + (c[1]?.alive || 0) * 0.5) * Math.pow(Math.min(c[0]?.hf ?? 0, c[1]?.hf ?? 0), 2);
          if (!back || g > back.score) back = { score: g, x, z, y, a, hf: c[0]?.hf };
        }
      }
      L.setHour(12.5); L.tick(24);
      /* 17:30 の太陽の方位（旧式の純関数：a = ((h − 6)/24)·2π、sunDir = (cos a, sin a, 0.34)） */
      const sunAt = (hr) => { const a = ((hr - 6) / 24) * Math.PI * 2; const v = [Math.cos(a), Math.sin(a), 0.34]; const l = Math.hypot(...v); return v.map((x) => x / l); };
      const s17 = sunAt(17.6);
      const sh = Math.hypot(s17[0], s17[2]), sx = s17[0] / sh, sz = s17[2] / sh;
      /* 桟橋の上で、太陽の方へ 4–30m にヨシが一番多い所 */
      let reed = null;
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const px = st.x + (end.x - st.x) * t, pz = st.z + (end.z - st.z) * t;
        let n = 0, cx = 0, cz = 0;
        for (const r of P.reeds) {
          const dx = r.x - px, dz = r.z - pz, dd = Math.hypot(dx, dz);
          if (dd < 4 || dd > 30) continue;
          if ((dx * sx + dz * sz) / dd < 0.8) continue;
          n++; cx += r.x; cz += r.z;
        }
        if (!reed || n > reed.n) reed = { n, x: px, z: pz, cx: cx / Math.max(n, 1), cz: cz / Math.max(n, 1) };
      }
      /* 睡蓮の群落：10m の格子で一番多いセルの重心 */
      const grid = new Map();
      for (const l of P.lilies) { const k = `${Math.floor(l.x / 10)},${Math.floor(l.z / 10)}`; const g = grid.get(k) || { n: 0, x: 0, z: 0 }; g.n++; g.x += l.x; g.z += l.z; grid.set(k, g); }
      const best = [...grid.values()].sort((a, b) => b.n - a.n)[0];
      const lily = { n: best.n, x: best.x / best.n, z: best.z / best.n };
      const lr = Math.hypot(lily.x, lily.z) || 1;
      /* 藪：桟橋の付け根に一番近い株 */
      let th = null;
      for (const t of P.thicket) { const dd = Math.hypot(t.x - st.x, t.z - st.z); if (!th || dd < th.d) th = { ...t, d: dd }; }
      return { meadow, sasa, back, reed, lily: { ...lily, ox: lily.x / lr, oz: lily.z / lr }, thicket: th, sun17: [sx, sz], dockY: L.gfx.f?.camPos ? null : null };
    });
    T.spots = spots;
    console.log(`== ${tier} spots`, JSON.stringify(spots));

    /* ---- 構図の一覧（名前, カメラ, 時刻, 天候, 選択：高さの段だけ） ---- */
    const Bk = spots.back || spots.meadow;
    const M = spots.meadow, S = spots.sasa, R = spots.reed, Ly = spots.lily, Th = spots.thicket;
    const sun = spots.sun17;
    const look = (x, y, z, dx, dz, dist, dy) => ({ pos: [x, y, z], target: [x + dx * dist, y + dy, z + dz * dist] });
    const ca = Math.cos(M.a), sa = Math.sin(M.a);
    const toLake = (() => { const st = Th ? Math.hypot(Th.x, Th.z) : 1; return Th ? [-Th.x / st, -Th.z / st] : [1, 0]; })();
    const views = [
      ['gc-forest-floor', { pos: [S.x, S.y + 1.65, S.z], target: [S.x + Math.cos(S.a) * 6, S.y + 0.4, S.z + Math.sin(S.a) * 6] }, 13, 'clear', true],
      ['gc-forest-floor-morning', { pos: [S.x, S.y + 1.65, S.z], target: [S.x + Math.cos(S.a + 1.2) * 6, S.y + 0.5, S.z + Math.sin(S.a + 1.2) * 6] }, 9, 'clear', false],
      ['gc-meadow', look(M.x, M.y + 1.7, M.z, ca, sa, 7, -1.0), 13, 'clear', true],
      ['gc-meadow-backlit-1730', look(Bk.x, Bk.y + 1.6, Bk.z, sun[0], sun[1], 8, -0.9), 17.5, 'clear', true],
      ['gc-meadow-rain', look(M.x, M.y + 1.7, M.z, ca, sa, 6, -1.1), 11, 'rain', true],
      ['gc-thicket-10m', Th ? { pos: [Th.x + toLake[0] * 9.2 - toLake[1] * 3.8, Th.y + 1.6, Th.z + toLake[1] * 9.2 + toLake[0] * 3.8], target: [Th.x, Th.y + 0.9, Th.z], groundEye: 1.6 } : 'forest-floor', 15, 'clear', true],
      ['gc-edge-60m', look(M.x - ca * 4, M.y + 2.3, M.z - sa * 4, ca, sa, 60, -1.2), 14, 'clear', true],
      ['gc-dusk', look(M.x, M.y + 1.7, M.z, ca, sa, 7, -1.0), 18.3, 'clear', false],
      ['sf-reeds-from-dock-dusk', { pos: [R.x, 0, R.z], target: [R.cx, 0.9, R.cz], dockEye: true }, 17.6, 'clear', true],
      ['sf-reeds-from-dock-noon', { pos: [R.x, 0, R.z], target: [R.cx, 0.9, R.cz], dockEye: true }, 12, 'clear', false],
      ['sf-reed-edge', 'reed-edge', 13, 'clear', true],
      ['sf-lilies', { pos: [Ly.x - Ly.ox * 4.5, 1.5, Ly.z - Ly.oz * 4.5], target: [Ly.x, 0, Ly.z] }, 12, 'clear', true],
      ['sf-lilies-rain', { pos: [Ly.x - Ly.ox * 3.5, 1.3, Ly.z - Ly.oz * 3.5], target: [Ly.x, 0, Ly.z] }, 11, 'rain', true],
      ['sf-weedbed-uw', 'weedbed-uw', 12, 'clear', true],
      ['sf-night', { pos: [R.x, 0, R.z], target: [R.cx, 0.9, R.cz], dockEye: true }, 22.5, 'clear', false],
      ['sf-dawn', 'shore-low', 6.1, 'clear', false],
    ];
    const pick = process.env.ONLY === 'numbers' ? [] : tier === 'high' ? views : views.filter((v) => ['gc-forest-floor', 'gc-meadow', 'sf-reeds-from-dock-dusk', 'sf-lilies', 'sf-weedbed-uw'].includes(v[0]));
    for (const [name, cam, hour, weather] of pick) {
      const r = await h.eval(({ cam, hour, weather }) => {
        const L = window.__lab;
        if (typeof cam === 'string') L.cam(cam);
        else {
          const c = { pos: cam.pos.slice(), target: cam.target.slice() };
          if (cam.dockEye) { const dy = L.dock?.dockY ?? 0.9; c.pos[1] = (Number.isFinite(dy) ? dy : 0.9) + 1.6; }
          if (cam.groundEye) c.pos[1] = Math.max(L.lake.heightAt(c.pos[0], c.pos[2]), 0) + cam.groundEye;
          L.cam(c);
        }
        L.setHour(hour); L.setWeather(weather, { instant: true }); L.view(null); L.freeze(10);
        L.tick(45);
        const nan = L.nanCheck();
        const s = L.stats();
        return { nan, gc: s.modules?.groundcover, sf: s.modules?.shoreflora, sfd: L.gfx.modules.get('shoreflora')?.debug };
      }, { cam, hour, weather });
      await h.shot(`${tier}-${name}`);
      T.shots[name] = r;
      expect(r.nan === 0, `${tier}-${name}: NaN ${r.nan}`);
    }

    /* ---- 数値（high だけ） ---- */
    if (tier === 'high') {
      /* 根元の色の ΔE：真上から見る。A = 根元の帯を «根元の色» で・法線を上（光を地面と同じに）、B = groundcover を隠す、Mk = マスク。
         地面の模様（描き込まれた草の葉・小石）は画素ごとに ΔE 5–10 の揺らぎを持つので、合格は 32px の区画の平均色の ΔE（低い周波数の一致）。
         画素ごとの中央値も記録する */
      out.numbers.rootDeltaE = {};
      for (const [spot, P0] of [['meadow', M], ['forest', S], ['backlit', Bk]]) {
        const setRoot = async (mode, hideGc) => h.eval(({ mode, hideGc, P0 }) => {
          const L = window.__lab, gc = L.gfx.modules.get('groundcover'), sf = L.gfx.modules.get('shoreflora');
          gc.debugRoot = mode;
          gc.root.visible = !hideGc;
          sf.root.visible = false;
          L.cam({ pos: [P0.x + 0.02, P0.y + 1.4, P0.z], target: [P0.x, P0.y, P0.z] });
          L.setHour(12.5); L.setWeather('clear', { instant: true }); L.freeze(10);
          L.tick(20);
        }, { mode, hideGc, P0 });
        await setRoot(2, false);
        const Mk = decodePNG(fs.readFileSync(await h.shot(`high-root-${spot}-mask`)));
        await setRoot(1, false);
        const A = decodePNG(fs.readFileSync(await h.shot(`high-root-${spot}-A`)));
        await setRoot(0, true);
        const B = decodePNG(fs.readFileSync(await h.shot(`high-root-${spot}-B`)));
        await h.eval(() => { const L = window.__lab; const gc = L.gfx.modules.get('groundcover'); gc.debugRoot = false; gc.root.visible = true; L.gfx.modules.get('shoreflora').root.visible = true; });
        const dE = [], W = A.width, BS = 32, blocks = new Map();
        for (let i = 0; i < A.data.length; i += 4) {
          const mr = Mk.data[i], mg = Mk.data[i + 1], mb = Mk.data[i + 2];
          if (!(mr - mg > 45 && mb - mg > 45)) continue;   // AgX で淡くなった赤紫
          const a = lab(A.data[i], A.data[i + 1], A.data[i + 2]), b = lab(B.data[i], B.data[i + 1], B.data[i + 2]);
          dE.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
          const px = (i / 4) % W, py = Math.floor(i / 4 / W), k = `${Math.floor(px / BS)},${Math.floor(py / BS)}`;
          const o = blocks.get(k) || { n: 0, a: [0, 0, 0], b: [0, 0, 0] };
          o.n++; for (let c = 0; c < 3; c++) { o.a[c] += a[c]; o.b[c] += b[c]; }
          blocks.set(k, o);
        }
        dE.sort((x, y) => x - y);
        const bl = [...blocks.values()].filter((o) => o.n >= 30).map((o) => Math.hypot(...o.a.map((v, c) => (v - o.b[c]) / o.n))).sort((x, y) => x - y);
        const q = (arr, p) => (arr.length ? +arr[Math.min(arr.length - 1, Math.floor(p * arr.length))].toFixed(2) : null);
        out.numbers.rootDeltaE[spot] = { pixels: dE.length, pixelMedian: q(dE, 0.5), blocks: bl.length, blockMedian: q(bl, 0.5), blockP90: q(bl, 0.9) };
        console.log(`  rootΔE ${spot}`, JSON.stringify(out.numbers.rootDeltaE[spot]));
        if (dE.length > 300) expect(q(bl, 0.5) < 6, `根元の色の ΔE（${spot}、区画の中央値）${q(bl, 0.5)}（< 6）`);
      }

      /* 浮葉の高さ：GPU の式（ngLiSurf）と CPU の surfaceY（waveHeight × shoalGain） */
      out.numbers.lilySurface = await h.eval(async () => {
        const L = window.__lab, sf = L.gfx.modules.get('shoreflora');
        L.unfreeze(); L.tick(30, 1 / 60); L.freeze(10); L.tick(2);
        const wf = await import(new URL('src/waveField.js', document.baseURI).href);
        const hf = L.gfx.heightfield;
        const pts = L.placement.lilies.slice(0, 200).map((l) => ({ x: l.x, z: l.z }));
        const gpu = sf.debugLilySurface(pts);
        const [t, wind] = [sf.waveU.ngSfWave.value.x, sf.waveU.ngSfWave.value.y];
        let max = 0, maxLake = 0, amp = 0;
        pts.forEach((p, i) => {
          const dHf = Math.max(-hf.heightAt(p.x, p.z), 0), dLk = Math.max(L.lake.depthAt(p.x, p.z), 0);
          const cpu = (dHf > 0 ? wf.waveHeight(p.x, p.z, t, wind) * wf.shoalGain(dHf) : 0) + 0.012;
          const cpuLake = (dLk > 0 ? wf.waveHeight(p.x, p.z, t, wind) * wf.shoalGain(dLk) : 0) + 0.012;
          max = Math.max(max, Math.abs(gpu[i] - cpu));
          maxLake = Math.max(maxLake, Math.abs(gpu[i] - cpuLake));
          amp = Math.max(amp, Math.abs(cpu - 0.012));
        });
        return { n: pts.length, t: +t.toFixed(3), wind: +wind.toFixed(3), maxErrHf_m: +max.toFixed(5), maxErrLakeDepth_m: +maxLake.toFixed(5), waveAmp_m: +amp.toFixed(4) };
      });
      console.log('  lilySurface', JSON.stringify(out.numbers.lilySurface));
      expect(out.numbers.lilySurface.maxErrLakeDepth_m < 0.01, `浮葉の高さの誤差 ${out.numbers.lilySurface.maxErrLakeDepth_m}m（±1cm）`);

      /* 藻場の被覆・ヨシの水深・重ね絵 */
      const ov = await h.eval(async () => {
        const L = window.__lab, lake = L.lake, P = L.placement;
        const Q = await import(new URL('src/gfx/shoreflora/quality.js', document.baseURI).href);
        const PL = await import(new URL('src/world/placement.js', document.baseURI).href);
        const sfw = L.gfx.modules.get('shoreflora')?.weeds || P.weeds;
        const cov = Q.sfFlatCoverage(lake.flats, sfw);
        const cov0 = Q.sfFlatCoverage(lake.flats, P.weeds);
        let inEdge = 0, deep = 0;
        for (const r of P.reeds) { if (r.depth > 0.05 && r.depth <= 1.5) inEdge++; if (r.depth > 1.5) deep++; }
        /* 1.5m の等深線の «内側の帯»（0.05 < 深さ ≤ 1.5 かつ汀線まで 12m）の格子のうち、ヨシの株が 3m 以内にある割合 */
        let band = 0, bandHit = 0;
        const rcell = new Map();
        for (const r of P.reeds) { const k = `${Math.floor(r.x / 3)},${Math.floor(r.z / 3)}`; rcell.set(k, (rcell.get(k) || 0) + 1); }
        const draw = (name, fn) => {
          const W = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = W;
          const g = cv.getContext('2d');
          const R = 300, s = W / (2 * R);
          const img = g.createImageData(W, W);
          for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
            const x = -R + (i + 0.5) / s, z = -R + (j + 0.5) / s;
            const dpt = lake.depthAt(x, z);
            let c;
            if (dpt <= 0) c = [70, 78, 58];
            else if (dpt <= 1.5) c = [120, 170, 190];
            else c = [40, 80 - Math.min(dpt, 12) * 3, 140 - Math.min(dpt, 12) * 6];
            const o = (j * W + i) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
          }
          g.putImageData(img, 0, 0);
          /* 1.5m の等深線 */
          g.fillStyle = '#ff3030';
          for (let j = 0; j < W; j += 1) for (let i = 0; i < W; i += 1) {
            const x = -R + (i + 0.5) / s, z = -R + (j + 0.5) / s;
            const a = lake.depthAt(x, z) > 1.5, b = lake.depthAt(x + 1 / s, z) > 1.5, c2 = lake.depthAt(x, z + 1 / s) > 1.5;
            if (a !== b || a !== c2) g.fillRect(i, j, 1.5, 1.5);
          }
          fn(g, (x) => (x + R) * s);
          return cv.toDataURL('image/png');
        };
        const iso = draw('iso', (g, m) => {
          g.fillStyle = 'rgba(40,220,60,0.9)';
          for (const r of P.reeds) g.fillRect(m(r.x) - 1, m(r.z) - 1, 2.2, 2.2);
          g.fillStyle = 'rgba(255,120,220,0.95)';
          for (const l of P.lilies) g.fillRect(m(l.x) - 1, m(l.z) - 1, 2.5, 2.5);
        });
        const flats = draw('flats', (g, m) => {
          g.strokeStyle = '#ffe040'; g.lineWidth = 2;
          for (const f of lake.flats) { g.beginPath(); g.arc(m(f.x), m(f.z), f.r * (1024 / 600), 0, Math.PI * 2); g.stroke(); }
          g.fillStyle = 'rgba(0,255,200,0.85)';
          for (const w of P.weeds) g.fillRect(m(w.x) - 1, m(w.z) - 1, 2.2, 2.2);
          g.fillStyle = 'rgba(255,160,40,0.85)';
          for (const w of sfw) if (w.filler) g.fillRect(m(w.x) - 1, m(w.z) - 1, 2.2, 2.2);
        });
        void band; void bandHit; void PL;
        return { coverage: cov.map((c) => +c.toFixed(3)), coveragePlacementOnly: cov0.map((c) => +c.toFixed(3)), fillers: sfw.filter((w) => w.filler).length, reeds: P.reeds.length, reedsInEdge: inEdge, reedsDeeper15: deep, iso, flats };
      });
      for (const [k, url] of [['overlay-isobath-reeds', ov.iso], ['overlay-flats-weeds', ov.flats]]) {
        fs.writeFileSync(path.join(h.out, `${k}.png`), Buffer.from(url.split(',')[1], 'base64'));
      }
      out.numbers.flats = { coverage: ov.coverage, placementOnly: ov.coveragePlacementOnly, fillers: ov.fillers };
      out.numbers.reeds = { total: ov.reeds, inEdgeBand: ov.reedsInEdge, deeperThan15: ov.reedsDeeper15 };
      console.log('  flats', JSON.stringify(out.numbers.flats), 'reeds', JSON.stringify(out.numbers.reeds));
      expect(ov.coverage.every((c) => c >= 0.9), `藻場の被覆 ${ov.coverage.join(', ')}（各円 ≥ 0.9）`);
      expect(ov.reedsDeeper15 === 0, `1.5m より深いヨシ ${ov.reedsDeeper15}`);
    }

    /* ---- 監査 ---- */
    T.audit = await h.eval((ids) => {
      const a = window.__lab.programAudit();
      const by = {};
      for (const id of ids) {
        const mine = a.programs.filter((p) => p.tag?.startsWith(id + ':'));
        by[id] = { n: mine.length, maxFrag: Math.max(0, ...mine.map((p) => p.frag)), maxVert: Math.max(0, ...mine.map((p) => p.vert)), tags: mine.map((p) => p.tag) };
      }
      return { total: a.count, over: a.over.length, failed: a.failed.length, by };
    }, IDS);
    console.log(`  ${tier} audit`, JSON.stringify(T.audit));
    for (const id of IDS) expect(T.audit.by[id].n >= 1 && T.audit.by[id].n <= 6, `${tier}: ${id} のプログラム ${T.audit.by[id].n}`);
    expect(T.audit.over === 0 && T.audit.failed === 0, `${tier}: サンプラー超過 ${T.audit.over}・リンク失敗 ${T.audit.failed}`);

    /* ---- GPU ms（全体 − 隠した、3 回の中央値）---- */
    if (process.env.BENCH !== '0') {
      const bviews = [
        ['meadow', look(M.x, M.y + 1.7, M.z, ca, sa, 7, -1.0)],
        ['forest', { pos: [S.x, S.y + 1.65, S.z], target: [S.x + Math.cos(S.a) * 6, S.y + 0.4, S.z + Math.sin(S.a) * 6] }],
        ['reeds', { pos: [R.x, 2.5, R.z], target: [R.cx, 0.9, R.cz] }],
        ['dock-3p', 'dock-3p'],
      ];
      T.bench = await h.eval(({ bviews, ids }) => {
        const L = window.__lab, res = {};
        for (const [v, cam] of bviews) {
          L.cam(cam); L.setHour(12.5); L.setWeather('clear', { instant: true }); L.freeze(10); L.tick(20);
          res[v] = {};
          for (const id of ids) {
            const runs = [];
            for (let k = 0; k < 3; k++) {
              const a = L.bench({ frames: 24, warm: 10, windows: 3, passes: true }), b = L.bench({ frames: 24, warm: 10, windows: 3, passes: true, hide: [id] });
              const per = Object.fromEntries(Object.keys(a.passMin || {}).map((p) => [p, (a.passMin[p] || 0) - (b.passMin?.[p] || 0)]));
              runs.push({ cost: a.frameMsMin - b.frameMsMin, frame: a.frameMsMin, per });
            }
            runs.sort((x, y) => x.cost - y.cost);
            const m = runs[1];
            res[v][id] = { cost: +m.cost.toFixed(2), frame: +m.frame.toFixed(2),
              passes: Object.fromEntries(Object.entries(m.per).filter(([, x]) => Math.abs(x) >= 0.05).map(([p, x]) => [p, +x.toFixed(2)])) };
          }
        }
        res.size = L.bench({ frames: 2, warm: 1, windows: 1, passes: false }).size;
        return res;
      }, { bviews, ids: IDS });
      console.log(`  ${tier} bench`, JSON.stringify(T.bench));
    }

    /* ---- 健在・console ---- */
    T.health = await h.eval((ids) => {
      const g = window.__lab.gfx, s = g.safety;
      return Object.fromEntries(ids.map((id) => {
        const m = g.modules.get(id);
        return [id, { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null, visible: m?.root?.visible ?? null,
          restarts: g._restarts?.get(id) || 0, stats: m?.stats?.() }];
      }).concat([['deadPasses', [...s.deadPasses]]]));
    }, IDS);
    const myWarn = h.logs.slice(log0).filter((l) => IDS.some((id) => l.includes(`[ng] ${id}.`) || l.includes(`モジュール ${id} `) || l.includes(`（${id}）`)));
    const c1 = h.counts();
    T.console = { errors: c1.errors - c0.errors, pageErrors: c1.pageErrors - c0.pageErrors, myWarnings: myWarn.length, sample: myWarn.slice(0, 3) };
    console.log(`  ${tier} health`, JSON.stringify(T.health), JSON.stringify(T.console));
    for (const id of IDS) {
      const H = T.health[id];
      expect(H.strikes === 0 && !H.disabled && H.stub === false && H.visible === true && H.restarts === 0, `${tier}: ${id} が健在でない ${JSON.stringify(H)}`);
    }
    expect(T.health.deadPasses.length === 0, `${tier}: 止まったパス ${T.health.deadPasses}`);
    expect(T.console.errors === 0 && T.console.pageErrors === 0 && myWarn.length === 0, `${tier}: console ${JSON.stringify(T.console)}`);

    /* ---- 2560×1440 の主役の絵（high） ---- */
    if (tier === 'high' && process.env.HERO !== '0') {
      const vp = h.page.viewportSize();
      await h.page.setViewportSize({ width: 2560, height: 1440 });
      await h.sleep(800);
      for (const [name, cam, hour, weather, hero] of views) {
        if (!hero || !['gc-forest-floor', 'gc-meadow-backlit-1730', 'gc-thicket-10m', 'sf-reeds-from-dock-dusk', 'sf-lilies', 'sf-weedbed-uw', 'gc-edge-60m'].includes(name)) continue;
        await h.eval(({ cam, hour, weather }) => {
          const L = window.__lab;
          if (typeof cam === 'string') L.cam(cam);
          else {
            const c = { pos: cam.pos.slice(), target: cam.target.slice() };
            if (cam.dockEye) { const dy = L.dock?.dockY ?? 0.9; c.pos[1] = (Number.isFinite(dy) ? dy : 0.9) + 1.6; }
            if (cam.groundEye) c.pos[1] = Math.max(L.lake.heightAt(c.pos[0], c.pos[2]), 0) + cam.groundEye;
            L.cam(c);
          }
          L.setHour(hour); L.setWeather(weather, { instant: true }); L.freeze(10); L.tick(40);
        }, { cam, hour, weather });
        await h.shot(`hero-1440p-${name}`);
      }
      await h.page.setViewportSize(vp);
    }
  }
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, 'proof.json'), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`groundcover+shoreflora-proof: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('groundcover+shoreflora-proof: 合格');
}
