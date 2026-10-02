/* ===========================================================
   terrain の証拠一式（ARCHITECTURE §6.4）を lab/terrain.html で撮って測る
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/terrain-proof.mjs --out DIR [--size 1280x720]
   環境変数：TIERS=high,mid,low（既定 3 段）、PROOF=full|lite（lite は各段の標準の構図だけ）、BENCH=0 でベンチを飛ばす
   撮る物（high は全部、mid/low は標準の構図）：
     1. shore-low 13:00 の 4 コマ（遡上で動く濡れ帯）    2. forest-floor（林床・苔）
     3. 空撮 3 距離（タイルの繰り返しが見えない）          4. 遠景の稜線 6:00 / 17:45（+ 曇り）
     5. noon-fp-down の湖底                                6. 雨の水たまり（踏み跡）
     7. LOD の色・パッチの格子                             8. 高さの誤差のヒートマップ（GPU の深度 → 世界 y と heightAt の差）
   数値：NaN・プログラムの監査・自分の GPU ms（moduleCosts とパス別）・高さの誤差・console のエラー・健在
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { encodePNG } from '../png.mjs';

const ID = 'terrain';
const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

/* ブラウザの中で使うカメラ（湖の座標から組む） */
export function camsInPage() {
  const L = window.__lab, lake = L.lake, D = L.dock, hf = L.gfx.heightfield;
  const g = (x, z) => Math.max(hf.heightAt(x, z), 0);
  const dir = { x: D.dockDir.x, z: D.dockDir.z };
  const ang0 = Math.atan2(D.dockEnd.z, D.dockEnd.x);
  const shore = (da, inland) => { const a = ang0 + da, r = lake.shoreAtAngle(a) + inland; return { x: Math.cos(a) * r, z: Math.sin(a) * r, a }; };
  const c = {};
  /* 桟橋の先から湖の向こうの山並みへ（釣り人の体を避けて先端の 1m 前） */
  const e = { x: D.dockEnd.x + dir.x * 1.0, z: D.dockEnd.z + dir.z * 1.0 };
  c.ridge = { pos: [e.x, D.dockY + 1.7, e.z], target: [e.x + dir.x * 1500, 160, e.z + dir.z * 1500] };
  c.ridgeWide = { pos: [e.x - dir.x * 30, D.dockY + 6, e.z - dir.z * 30], target: [e.x + dir.x * 1400 + dir.z * 500, 120, e.z + dir.z * 1400 - dir.x * 500] };
  /* 踏み跡（桟橋の付け根から内陸へ）を見下ろす */
  const s = D.dockStart, inl = { x: -dir.x, z: -dir.z };
  const tp = { x: s.x + inl.x * 2 + dir.z * 2.5, z: s.z + inl.z * 2 - dir.x * 2.5 };
  c.trail = { pos: [tp.x, g(tp.x, tp.z) + 1.7, tp.z], target: [s.x + inl.x * 12, g(s.x + inl.x * 12, s.z + inl.z * 12), s.z + inl.z * 12] };
  /* 空撮：岸から 35m 内陸の点を 3 つの高さから（湖を背に、陸の上） */
  const a = shore(1.2, 35), b = shore(1.2, 80);
  for (const [k, hgt, back] of [['air20', 20, 25], ['air70', 70, 70], ['air200', 200, 160]]) {
    const px = a.x - Math.cos(a.a) * back, pz = a.z - Math.sin(a.a) * back;
    c[k] = { pos: [px, g(px, pz) + hgt, pz], target: [b.x, g(b.x, b.z), b.z] };
  }
  /* 近寄り：浜（汀線から 1.5m）・草地・崖（急斜面を探す） */
  for (const [k, da, i0, i1] of [['beach', 0.5, -0.5, 3.5], ['beach2', 2.2, -0.5, 3.5], ['meadow', 3.0, 14, 19]]) {
    const p = shore(da, i0), q = shore(da + 0.004, i1);
    c[k] = { pos: [p.x, g(p.x, p.z) + 1.5, p.z], target: [q.x, g(q.x, q.z), q.z] };
  }
  let best = null;
  for (let r = 200; r < 440; r += 6) for (let t = 0; t < 6.283; t += 0.02) {
    const x = Math.cos(t) * r, z = Math.sin(t) * r;
    const s = Math.abs(hf.heightAt(x + 1, z) - hf.heightAt(x - 1, z)) / 2 + Math.abs(hf.heightAt(x, z + 1) - hf.heightAt(x, z - 1)) / 2;
    if (!best || s > best.s) best = { s, x, z, t, r };
  }
  if (best) {
    const bx = Math.cos(best.t) * (best.r - 22), bz = Math.sin(best.t) * (best.r - 22);
    c.cliff = { pos: [bx, g(bx, bz) + 2.5, bz], target: [best.x, g(best.x, best.z), best.z], slope: best.s };
  }
  /* 高さの誤差を測る歩ける帯の視点（目の高さから 35° 見下ろす） */
  c.err = [];
  for (const da of [0.15, 0.9, 1.7, 2.6, 3.4, 4.3, 5.2]) {
    const p = shore(da, 6), q = shore(da + 0.05, 18);
    c.err.push({ pos: [p.x, g(p.x, p.z) + 1.7, p.z], target: [q.x, g(q.x, q.z), q.z] });
  }
  return c;
}

export default async function (h) {
  const tiers = list(process.env.TIERS, ['high', 'mid', 'low']);
  const full = (process.env.PROOF || 'full') === 'full';
  const bench = process.env.BENCH !== '0';
  const res = { id: ID, tiers: {} };
  const fail = [];
  const expect = (ok, msg) => { if (!ok) { fail.push(msg); console.log('  NG', msg); } };

  for (const tier of tiers) {
    const c0 = h.counts();
    const log0 = h.logs.length;
    await h.open(`lab/terrain.html?capture=1&tier=${tier}`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 240);
    const R = (res.tiers[tier] = {});
    R.boot = await h.eval((id) => {
      const L = window.__lab, m = L.gfx.modules.get(id);
      return { stub: m?._ngStub ?? null, stats: m?.stats() ?? null, loadMs: L.gfx.loadStats?.modules?.[id] ?? null };
    }, ID);
    console.log(`== ${tier}`, JSON.stringify(R.boot));
    expect(R.boot.stub === false, `${tier}: terrain がスタブ`);
    /* 止めずに回す（update / prepare の時間の道） */
    await h.eval(() => { const L = window.__lab; L.unfreeze(); L.cam('dock-3p'); L.setHour(12.5); L.setWeather('clear', { instant: true }); L.tick(300, 1 / 60); });
    const cams = await h.eval(camsInPage);

    const shoot = async (name, o) => {
      const nan = await h.eval((o) => {
        const L = window.__lab, m = L.gfx.modules.get('terrain');
        L.cam(o.cam); L.setHour(o.hour); L.setWeather(o.weather || 'clear', { instant: true }); L.view(o.view || null);
        m?.setDebug?.(o.dbg || 0);
        L.freeze(o.t ?? 10); L.tick(o.frames || 24);
        return L.nanCheck();
      }, o);
      await h.shot(`${tier}-${name}`);
      expect(nan === 0, `${tier}-${name}: NaN ${nan}`);
    };
    /* 標準の構図（全段） */
    await shoot('noon-shore', { cam: 'noon-shore', hour: 13 });
    await shoot('shore-low', { cam: 'shore-low', hour: 13 });
    await shoot('forest-floor', { cam: 'forest-floor', hour: 10 });
    await shoot('air70', { cam: cams.air70, hour: 14.5 });
    await shoot('ridge-1745', { cam: cams.ridge, hour: 17.75 });
    if (full && tier === 'high') {
      for (let k = 0; k < 4; k++) await shoot(`shore-low-strip${k}`, { cam: 'shore-low', hour: 13, t: 40 + k * 0.9, frames: 6 });
      await shoot('forest-floor-1530', { cam: 'forest-floor', hour: 15.5 });
      for (const k of ['beach', 'beach2', 'meadow', 'cliff']) if (cams[k]) await shoot(`close-${k}`, { cam: cams[k], hour: 14 });
      await shoot('air20', { cam: cams.air20, hour: 14.5 });
      await shoot('air200', { cam: cams.air200, hour: 14.5 });
      await shoot('ridge-0600', { cam: cams.ridge, hour: 6.0 });
      await shoot('ridge-wide-1745', { cam: cams.ridgeWide, hour: 17.75 });
      await shoot('ridge-cloudy-1100', { cam: cams.ridge, hour: 11, weather: 'cloudy' });
      await shoot('ridge-noon', { cam: cams.ridge, hour: 12.5 });
      await shoot('noon-fp-down', { cam: 'noon-fp-down', hour: 12.5 });
      await shoot('rain-trail', { cam: cams.trail, hour: 11, weather: 'rain', frames: 60 });
      await shoot('clear-trail', { cam: cams.trail, hour: 11 });
      await shoot('rain-fp', { cam: 'rain-fp', hour: 11, weather: 'rain', frames: 60 });
      await shoot('morning-fp', { cam: 'morning-fp', hour: 8.5 });
      await shoot('dusk-3p', { cam: 'dusk-3p', hour: 18.3 });
      await shoot('night-fp', { cam: 'night-fp', hour: 22.5 });
      await shoot('dawn-3p', { cam: 'dawn-3p', hour: 6.1 });
      await shoot('weedbed-uw', { cam: 'weedbed-uw', hour: 12.5 });
      await shoot('lod-colour', { cam: cams.air200, hour: 14.5, dbg: 1 });
      await shoot('lod-grid', { cam: cams.air20, hour: 14.5, dbg: 3 });
      await shoot('layers', { cam: cams.air70, hour: 14.5, dbg: 2 });
    }
    await h.eval(() => { window.__lab.view(null); window.__lab.gfx.modules.get('terrain')?.setDebug?.(0); });

    /* 高さの誤差：線形深度（ngSceneDepth = view の z）から世界の点を戻し、heightfield.heightAt / lake.heightAt と比べる。
       他のモジュールの物体を隠して地形だけを測る */
    R.heightErr = await h.eval((errCams) => {
      const L = window.__lab, gfx = L.gfx, r = L.renderer;
      const hide = [];
      for (const [id, m] of gfx.modules) if (id !== 'terrain' && id !== 'sky' && m.root?.visible) { hide.push(m.root); m.root.visible = false; }
      for (const ch of L.camera.children) if (ch.visible) { hide.push(ch); ch.visible = false; }   // 隅のチャート
      const lake = L.lake, hf = gfx.heightfield;
      const out = { cams: [], maps: [] };
      const all = [];
      for (const cam of errCams) {
        L.cam(cam); L.setHour(12.5); L.freeze(10); L.tick(4);
        const rt = gfx.pipeline.targets.copy, W = rt.width, H = rt.height;
        const step = 4, w = Math.floor(W / step), hgt = Math.floor(H / step);
        const buf = new Float32Array(W * H * 4);
        /* 線形深度（R32F）は three の readRenderTargetPixels で読めないので RGBA32F へ写して読む */
        const tctx = gfx.modules.get('terrain').ctx, TT = tctx.THREE;
        const rtD = tctx.forge.target(W, H, { type: TT.FloatType, filter: 'nearest', wrap: 'clamp' });
        tctx.forge.run(rtD, 'uniform highp sampler2D ngD;\nvoid main() { gl_FragColor = vec4(texture(ngD, vUv).r, 0.0, 0.0, 1.0); }\n',
          { ngD: { value: gfx.pipeline.uniforms.ngSceneDepth.value } });
        r.readRenderTargetPixels(rtD, 0, 0, W, H, buf);
        rtD.dispose();
        const C = L.camera;
        C.updateMatrixWorld();
        const inv = C.projectionMatrixInverse, mw = C.matrixWorld;
        const errs = [], img = new Uint8Array(w * hgt * 4);
        const v = { x: 0, y: 0, z: 0 };
        for (let j = 0; j < hgt; j++) for (let i = 0; i < w; i++) {
          const px = i * step + step / 2, py = j * step + step / 2;
          const z = buf[(py * W + px) * 4];
          const o = ((hgt - 1 - j) * w + i) * 4;
          img[o + 3] = 255;
          if (!(z > 0.1 && z < 120)) { img[o] = img[o + 1] = img[o + 2] = 30; continue; }
          /* NDC → view（z = −depth の面）→ world */
          const nx = (px / W) * 2 - 1, ny = (py / H) * 2 - 1;
          const e = inv.elements;
          const vx = e[0] * nx + e[4] * ny + e[8] * 1 + e[12], vy = e[1] * nx + e[5] * ny + e[9] * 1 + e[13], vz = e[2] * nx + e[6] * ny + e[10] * 1 + e[14], vw = e[3] * nx + e[7] * ny + e[11] * 1 + e[15];
          const dx = vx / vw, dy = vy / vw, dz = vz / vw;
          const k = z / -dz;
          v.x = dx * k; v.y = dy * k; v.z = -z;
          const m = mw.elements;
          const wx = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12], wy = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13], wz = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
          const hTw = hf.heightAt(wx, wz), hGame = lake.heightAt(wx, wz);
          const r0 = Math.hypot(wx, wz), sr = lake.shoreAtAngle(Math.atan2(wz, wx));
          const band = r0 > sr - 3 && r0 < sr + 72 && hGame > -0.6;
          const eT = wy - hTw, eG = wy - hGame;
          if (band) { errs.push([Math.abs(eT), Math.abs(eG), z]); all.push([Math.abs(eT), z]); }
          /* 色：緑 < 1cm、黄 < 2cm、赤 ≥ 5cm（twin との差）。帯の外は暗く */
          const a = Math.abs(eT), t = Math.min(1, a / 0.05);
          const col = a < 0.01 ? [40, 200, 70] : a < 0.02 ? [220, 210, 40] : [Math.round(200 + 55 * t), Math.round(120 * (1 - t)), 30];
          const dim = band ? 1 : 0.35;
          img[o] = col[0] * dim; img[o + 1] = col[1] * dim; img[o + 2] = col[2] * dim;
        }
        errs.sort((p, q) => p[0] - q[0]);
        const pick = (k, q) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(errs.length * q))][k] : null);
        const maxG = errs.reduce((m, e) => Math.max(m, e[1]), 0);
        out.cams.push({ n: errs.length, p50: pick(0, 0.5), p99: pick(0, 0.99), max: pick(0, 1), maxVsGame: maxG,
          within2cm: errs.length ? errs.filter((e) => e[0] < 0.02).length / errs.length : null });
        out.maps.push({ w, h: hgt, data: Array.from(img) });
      }
      for (const o of hide) o.visible = true;
      /* 段 0 の範囲（カメラから 24m 以内：歩くときに足元に見える所）と、120m までの全部 */
      const stat = (arr) => {
        const a = arr.map((e) => e[0]).sort((p, q) => p - q);
        return { n: a.length, p50: a[a.length >> 1] ?? null, p99: a[Math.floor(a.length * 0.99)] ?? null, max: a[a.length - 1] ?? null,
          within2cm: a.length ? a.filter((e) => e < 0.02).length / a.length : null };
      };
      out.near = stat(all.filter((e) => e[1] < 24));
      out.all = stat(all);
      return out;
    }, cams.err);
    for (let k = 0; k < R.heightErr.maps.length; k++) {
      const m = R.heightErr.maps[k];
      fs.writeFileSync(path.join(h.out, `${tier}-height-err-${k}.png`), encodePNG({ width: m.w, height: m.h, data: Uint8Array.from(m.data) }));
    }
    delete R.heightErr.maps;
    console.log('  heightErr near', JSON.stringify(R.heightErr.near), 'all', JSON.stringify(R.heightErr.all));
    expect((R.heightErr.near.within2cm ?? 0) > 0.999, `${tier}: 歩ける帯（24m 以内）の高さの誤差 2cm 以内が ${R.heightErr.near.within2cm}`);

    /* プログラムの監査 */
    R.audit = await h.eval((id) => {
      const a = window.__lab.programAudit();
      const mine = a.programs.filter((p) => p.tag?.startsWith(id + ':'));
      return { total: a.count, mine: mine.length, over: a.over.length, failed: a.failed.length, samplers: mine.map((p) => [p.tag, p.frag, p.vert]) };
    }, ID);
    console.log('  audit', JSON.stringify(R.audit));
    expect(R.audit.mine >= 1 && R.audit.mine <= 6, `${tier}: プログラム ${R.audit.mine} 本`);
    expect(R.audit.over === 0 && R.audit.failed === 0, `${tier}: サンプラー超過 ${R.audit.over}・失敗 ${R.audit.failed}`);

    /* GPU：全体 − terrain を隠した、の中央値（3 視点）。パス別の差も */
    if (bench) {
      R.bench = await h.eval(({ id, views }) => {
        const L = window.__lab, out = {};
        for (const [name, cam, hour] of views) {
          L.cam(cam); L.setHour(hour); L.setWeather('clear', { instant: true }); L.freeze(10); L.tick(10);
          const d = [], pm = {}, ph = {};
          for (let k = 0; k < 3; k++) {
            const a = L.bench({ frames: 30, warm: 6, windows: 3 }), b = L.bench({ frames: 30, warm: 6, windows: 3, hide: [id] });
            d.push(a.frameMsMin - b.frameMsMin);
            for (const [p, v] of Object.entries(a.passMin || a.passes || {})) (pm[p] ||= []).push(v);
            for (const [p, v] of Object.entries(b.passMin || b.passes || {})) (ph[p] ||= []).push(v);
          }
          const med = (x) => { const s = [...x].sort((p, q) => p - q); return s[s.length >> 1]; };
          const passes = {};
          for (const p of Object.keys(pm)) if (ph[p]) passes[p] = +(med(pm[p]) - med(ph[p])).toFixed(3);
          out[name] = { costMs: +Math.max(0, med(d)).toFixed(3), passes, frameMs: +L.bench({ frames: 20, warm: 4, windows: 2, passes: false }).frameMsMin.toFixed(2) };
        }
        return out;
      }, { id: ID, views: [['dock-3p', 'dock-3p', 12], ['noon-shore', 'noon-shore', 13], ['air70', cams.air70, 14.5]] });
      console.log('  bench', JSON.stringify(R.bench));
    }
    const c1 = h.counts();
    R.console = { errors: c1.errors - c0.errors, pageErrors: c1.pageErrors - c0.pageErrors };
    expect(R.console.errors === 0 && R.console.pageErrors === 0, `${tier}: console のエラー ${R.console.errors}・例外 ${R.console.pageErrors}`);
    R.health = await h.eval((id) => {
      const g = window.__lab.gfx, s = g.safety, m = g.modules.get(id);
      return { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null, visible: m?.root?.visible ?? null,
        restarts: g._restarts?.get(id) || 0, dead: [...s.deadPasses], stats: m?.stats?.() };
    }, ID);
    const myWarn = h.logs.slice(log0).filter((l) => l.includes(`[ng] ${ID}.`) || l.includes(`モジュール ${ID} `) || l.includes('terrain:'));
    R.health.warnings = myWarn.length;
    console.log('  health', JSON.stringify(R.health));
    const H = R.health;
    expect(H.strikes === 0 && !H.disabled && H.stub === false && H.visible === true && H.restarts === 0, `${tier}: 健在でない`);
    expect(H.dead.length === 0, `${tier}: 止まったパス ${H.dead.join(',')}`);
    expect(myWarn.length === 0, `${tier}: 警告 ${myWarn.slice(0, 2).join(' / ')}`);
  }
  res.fail = fail;
  fs.writeFileSync(path.join(h.out, 'terrain-proof.json'), JSON.stringify(res, null, 1));
  if (fail.length) throw new Error(`terrain-proof: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('terrain-proof: 合格');
}
