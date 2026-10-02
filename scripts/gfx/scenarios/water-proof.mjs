/* ===========================================================
   water の証拠一式（ARCHITECTURE §6.2 の «証拠»）
   -----------------------------------------------------------
   9:00 の鏡・突風の斑（clear / cloudy）・黄金時間の光の道（+ 時間方向のちらつきの数値）・月の道（23:30 と低い月 19:30）・
   noon-fp-down・雨の輪・ウキの輪の連続・スネルの窓・ウォーターライン・夜の灯籠・3 段の比較、
   GPU/CPU の水面高さの読み戻し（深場 64 点 < 1mm・浅場 64 点 < 5mm、3 段）。
   SET=hi（--size 2560x1440 と一緒に）で 1440p の部分集合だけを撮る。結果は <out>/proof.json
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from '../png.mjs';

/* 2 枚の PNG の領域（x0, y0, x1, y1 は 0..1）の平均輝度と、平均の |Δ輝度| / 平均輝度 */
function flicker(a, b, r) {
  const A = decodePNG(fs.readFileSync(a)), B = decodePNG(fs.readFileSync(b));
  const ch = A.data.length / (A.width * A.height);
  const x0 = Math.floor(r[0] * A.width), x1 = Math.floor(r[2] * A.width), y0 = Math.floor(r[1] * A.height), y1 = Math.floor(r[3] * A.height);
  let s = 0, d = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * A.width + x) * ch;
    const la = 0.2126 * A.data[i] + 0.7152 * A.data[i + 1] + 0.0722 * A.data[i + 2];
    const lb = 0.2126 * B.data[i] + 0.7152 * B.data[i + 1] + 0.0722 * B.data[i + 2];
    s += la; d += Math.abs(la - lb); n++;
  }
  return { mean: +(s / n).toFixed(2), flicker: +(d / Math.max(s, 1)).toFixed(4) };
}

/* ページ内：描いた水面の高さの読み戻し（水面のシェーダの uDbg.x = 3：r = y、g/b = カメラからの x/z）。
   (x, 3, z) から真下を向いて 2 フレーム描き、mainRT の中央 60% の 8×8 = 64 点を CPU の surfaceY と比べる */
async function readback(h, site) {
  return h.eval(async (site) => {
    const L = window.__lab, g = L.gfx, m = g.modules.get('water');
    const WF = await import('/src/waveField.js?v=20260828-lakescale1');
    const lake = L.lake;
    m.uniforms.uDbg.value.set(3, 0, 0, 0);
    L.cam({ pos: [site.x, 3, site.z], target: [site.x + 0.0015, -1, site.z] });
    L.freeze();
    L.tick(3);
    const rt = g.targets.main, T = g.THREE;
    const W = rt.width, H = rt.height, N = 8;
    const out = [];
    const half = (v) => {
      const e = (v >> 10) & 31, f = v & 1023, s = v >> 15 ? -1 : 1;
      if (e === 0) return s * f * 2 ** -24;
      if (e === 31) return f ? NaN : s * Infinity;
      return s * (1 + f / 1024) * 2 ** (e - 15);
    };
    const r = g.renderer;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const px = Math.floor(W * (0.2 + 0.6 * (i + 0.5) / N)), py = Math.floor(H * (0.2 + 0.6 * (j + 0.5) / N));
      let v;
      if (rt.texture.type === T.HalfFloatType) {
        const b = new Uint16Array(4);
        r.readRenderTargetPixels(rt, px, py, 1, 1, b);
        v = [half(b[0]), half(b[1]), half(b[2]), half(b[3])];
      } else {
        const b = new Float32Array(4);
        r.readRenderTargetPixels(rt, px, py, 1, 1, b);
        v = [b[0], b[1], b[2], b[3]];
      }
      out.push(v);
    }
    m.uniforms.uDbg.value.set(0, 0, 0, 0);
    const t = m.uniforms.uTime.value, wind = m.uniforms.uWind.value;
    const cam = L.camera.position;
    const errs = [], errsHf = [], worst = [];
    let depthMin = 1e9, depthMax = -1e9;
    let other = 0;
    for (const [y, dx, dz, a] of out) {
      /* a = 0.25 の画素だけが水面（ウキ・糸・魚などの画素は数えない） */
      if (!Number.isFinite(y) || Math.abs(a - 0.25) > 0.01) { other++; continue; }
      const x = cam.x + dx, z = cam.z + dz;
      const d = lake.depthAt(x, z);
      const dh = Math.max(-g.heightfield.heightAt(x, z), 0);
      depthMin = Math.min(depthMin, d); depthMax = Math.max(depthMax, d);
      /* ゲームの surfaceY（lakefield の深さ）と、GPU の深さ（heightfield の双子）での値 */
      const want = d <= 0 ? 0 : WF.waveHeight(x, z, t, wind) * WF.shoalGain(d);
      const wantHf = dh <= 0 ? 0 : WF.waveHeight(x, z, t, wind) * WF.shoalGain(dh);
      errs.push(Math.abs(y - want));
      if (Math.abs(y - want) > 0.005) worst.push([+y.toFixed(4), +dx.toFixed(3), +dz.toFixed(3), +want.toFixed(4), +d.toFixed(2)]);
      errsHf.push(Math.abs(y - wantHf));
    }
    const st = (e) => {
      e.sort((a, b) => a - b);
      return e.length ? { n: e.length, medianMm: +(e[e.length >> 1] * 1000).toFixed(3), p95Mm: +(e[Math.floor(e.length * 0.95)] * 1000).toFixed(3), maxMm: +(e[e.length - 1] * 1000).toFixed(3) } : null;
    };
    return { site, waterTime: +t.toFixed(3), wind: +wind.toFixed(3), depth: [+depthMin.toFixed(2), +depthMax.toFixed(2)], vsGame: st(errs), vsHeightfield: st(errsHf), worst: worst.slice(0, 6), other, tier: g.quality.tier, msaa: g.msaa?.samples ?? null };
  }, site);
}

export default async function (h) {
  const set = process.env.SET || 'full';
  const tier0 = process.env.TIER || 'high';
  await h.open(`lab/water.html?capture=1&tier=${tier0}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const proof = { set, size: null, shots: {}, readback: [], flicker: {}, audit: null, health: null };
  proof.size = await h.eval(() => [innerWidth, innerHeight, devicePixelRatio]);

  /* 撮影の 1 枚：{ cam, hour, weather, view, tier, pre(L, m) を文字列で, settle } */
  async function shot(name, o) {
    const r = await h.eval((o) => {
      const L = window.__lab, m = L.gfx.modules.get('water');
      if (o.tier && L.gfx.quality.tier !== o.tier) L.setTier(o.tier);
      L.unfreeze();
      L.setHour(o.hour);
      L.setWeather(o.weather || 'clear', { instant: true });
      const P = L.presets();
      let c = o.cam;
      if (typeof c === 'string' && (c.startsWith('sun') || c.startsWith('moon'))) {
        const [, da, pitch] = c.split(':').map(Number);
        const D = P['dock-fp'];
        const a = ((o.hour - 6) / 24) * Math.PI * 2;
        let d = [Math.cos(a), Math.sin(a), 0.34];
        if (c.startsWith('moon')) d = d.map((v) => -v);
        const az = Math.atan2(d[2], d[0]) + (da || 0) * Math.PI / 180;
        const pos = [D.target[0], D.pos[1], D.target[2]];
        const pr = (pitch || 6) * Math.PI / 180;
        c = { pos, target: [pos[0] + Math.cos(az) * Math.cos(pr) * 30, pos[1] - Math.sin(pr) * 30, pos[2] + Math.sin(az) * Math.cos(pr) * 30] };
      } else if (typeof c === 'string' && c.startsWith('rel:')) {
        /* rel:<前>:<右>:<y>:<前>:<右>:<y>（spawn の桟橋の座標系で pos と target） */
        const v = c.split(':').slice(1).map(Number);
        const D = P['dock-fp'];
        const sp = D.pos, fw = [D.target[0] - D.pos[0], D.target[2] - D.pos[2]];
        const l = Math.hypot(fw[0], fw[1]); fw[0] /= l; fw[1] /= l;
        const rt = [fw[1], -fw[0]];
        const at = (f, s, y) => [sp[0] + fw[0] * f + rt[0] * s, y, sp[2] + fw[1] * f + rt[1] * s];
        c = { pos: at(v[0], v[1], v[2]), target: at(v[3], v[4], v[5]) };
      }
      if (typeof c === 'string') { const pp = { ...P[c] }; delete pp.hour; delete pp.weather; L.cam(pp); } else L.cam(c);
      L.view(o.view || null);
      if (!L._fov0) L._fov0 = L.camera.fov;
      L.camera.fov = o.fov || L._fov0; L.camera.updateProjectionMatrix();
      L.tick(o.settle ?? 90, 1 / 60);
      if (o.pre) (new Function('L', 'm', o.pre))(L, m);
      L.freeze();
      L.tick(4);
      return { nan: L.nanCheck(), tier: L.gfx.quality.tier, lum: +L.meanLuminance().toFixed(4) };
    }, o);
    await h.shot(name);
    proof.shots[name] = { ...o, pre: o.pre ? true : undefined, ...r };
    console.log(name, JSON.stringify(r));
    return r;
  }

  /* ウキの輪：0.8 秒ごとに 1 つの輪を足しながら 3 秒回す（連続）。位置は桟橋の先の 7m 前 */
  const BOB = `
    const D = L.presets()['dock-fp'];
    const fx = D.target[0] - D.pos[0], fz = D.target[2] - D.pos[2], l = Math.hypot(fx, fz);
    const x = D.pos[0] + fx / l * 6.5, z = D.pos[2] + fz / l * 6.5;
    for (let k = 0; k < 4; k++) { m.addRipple(x, z, 1.0, 2.6); L.tick(48, 1 / 60); }
    m.addRipple(x + 0.9, z - 0.6, 2.2, 3.0); L.tick(30, 1 / 60);`;

  if (process.env.ONLY) {
    /* 開発用：ONLY=名前,名前 で full の一部だけ */
    const want = new Set(process.env.ONLY.split(','));
    const all = {
      'rain-rings-close': { cam: 'rel:2.8:0.4:2.7:6.0:0.8:-1.6', hour: 11, weather: 'rain' },
      'bobber-rings': { cam: 'rel:2.8:0:2.7:6.5:0:-1.4', hour: 10, pre: BOB, settle: 10 },
      'snell-window': { cam: 'rel:9:3:-2.4:9.05:3:2', hour: 12.5, fov: 115 },
      'snell-window-oblique': { cam: 'rel:9:3:-1.6:16:3:1.5', hour: 12.5, fov: 75 },
      'mirror-0900': { cam: 'morning-fp', hour: 9 },
      'golden-1730': { cam: 'sun:0:4', hour: 17.5 },
      'noon-fp-down': { cam: 'noon-fp-down', hour: 12.5 },
      'gust-clear-1000': { cam: 'rel:-2:0:9:60:10:0', hour: 10 },
      'rain-fp': { cam: 'rain-fp', hour: 11, weather: 'rain' },
      'moon-1930': { cam: 'moon:0:5', hour: 19.5 },
      'noon-shore': { cam: 'noon-shore', hour: 13 },
    };
    for (const [k, v] of Object.entries(all)) if (want.has(k)) await shot(k, v);
  } else if (set === 'hi') {
    await shot('hi-golden-1730', { cam: 'sun:0:4', hour: 17.5 });
    await shot('hi-mirror-0900', { cam: 'morning-fp', hour: 9 });
    await shot('hi-noon-fp-down', { cam: 'noon-fp-down', hour: 12.5 });
    await shot('hi-moon-1930', { cam: 'moon:0:5', hour: 19.5 });
  } else if (set === 'full') {
    await shot('mirror-0900', { cam: 'morning-fp', hour: 9 });
    await shot('mirror-0900-high-view', { cam: 'rel:0:0:9:80:0:0', hour: 9 });
    await shot('gust-clear-1000', { cam: 'rel:-2:0:9:60:10:0', hour: 10 });
    await shot('gust-cloudy-1000', { cam: 'rel:-2:0:9:60:10:0', hour: 10, weather: 'cloudy' });
    await shot('golden-1730', { cam: 'sun:0:4', hour: 17.5 });
    await shot('golden-1800', { cam: 'sun:0:3', hour: 18.0 });
    await shot('moon-2330', { cam: 'moon:0:62', hour: 23.5 });
    await shot('moon-1930', { cam: 'moon:0:5', hour: 19.5 });
    await shot('noon-fp-down', { cam: 'noon-fp-down', hour: 12.5 });
    await shot('noon-shore', { cam: 'noon-shore', hour: 13 });
    await shot('rain-fp', { cam: 'rain-fp', hour: 11, weather: 'rain' });
    await shot('rain-rings-close', { cam: 'rel:2.8:0.4:2.7:6.0:0.8:-1.6', hour: 11, weather: 'rain' });
    await shot('bobber-rings', { cam: 'rel:2.8:0:2.7:6.5:0:-1.4', hour: 10, pre: BOB, settle: 10 });
    await shot('snell-window', { cam: 'rel:9:3:-2.4:9.05:3:2', hour: 12.5, fov: 115 });
    await shot('snell-window-oblique', { cam: 'rel:9:3:-1.6:16:3:1.5', hour: 12.5, fov: 75 });
    await shot('waterline', { cam: 'waterline', hour: 12.5 });
    await shot('night-lamp-2230', { cam: 'night-fp', hour: 22.5 });
    await shot('dusk-3p', { cam: 'dusk-3p', hour: 18.3 });
    for (const t of ['low', 'mid']) {
      await shot(`${t}-mirror-0900`, { cam: 'morning-fp', hour: 9, tier: t });
      await shot(`${t}-golden-1730`, { cam: 'sun:0:4', hour: 17.5, tier: t });
      await shot(`${t}-noon-fp-down`, { cam: 'noon-fp-down', hour: 12.5, tier: t });
    }
    await h.eval(() => { const L = window.__lab; L.setTier('high'); L.camera.fov = L._fov0 || L.camera.fov; L.camera.updateProjectionMatrix(); });
  }

  /* 黄金時間のきらめきの時間方向のちらつき（1/60s 離れた 2 枚。露出と DRS は止めたまま時間だけ進める） */
  for (const t of (process.env.ONLY ? [] : set === 'hi' ? ['high'] : set === 'full' ? ['high', 'mid', 'low'] : [])) {
    await h.eval((t) => {
      const L = window.__lab;
      if (L.gfx.quality.tier !== t) L.setTier(t);
      L.setHour(17.5); L.setWeather('clear', { instant: true });
      L.unfreeze(); window.__gfxCapture = true;
      L.tick(60, 1 / 60);
    }, t);
    await h.shot(`_flick-${t}-a`);
    await h.eval(() => window.__lab.tick(1, 1 / 60));
    await h.shot(`_flick-${t}-b`);
    proof.flicker[t] = flicker(path.join(h.out, `_flick-${t}-a.png`), path.join(h.out, `_flick-${t}-b.png`), [0.3, 0.55, 0.7, 0.95]);
    console.log('flicker', t, JSON.stringify(proof.flicker[t]));
  }

  /* 読み戻し：深場（桟橋の先 + 10m）と浅場（汀線の 2–5m 内側）を 3 段で */
  if (set !== 'hi' && !process.env.ONLY) {
    const sites = await h.eval(() => {
      const L = window.__lab, lake = L.lake, D = L.presets()['dock-fp'];
      const fx = D.target[0] - D.pos[0], fz = D.target[2] - D.pos[2], l = Math.hypot(fx, fz);
      const deep = { kind: 'deep', x: D.pos[0] + fx / l * 14, z: D.pos[2] + fz / l * 14 };
      deep.depth = lake.depthAt(deep.x, deep.z);
      let shallow = null;
      for (let a = 0.6; a < 6.2 && !shallow; a += 0.05) {
        const r0 = lake.shoreAtAngle(a);
        for (let k = 1; k < 30; k++) {
          const r = r0 - k * 0.5, x = Math.cos(a) * r, z = Math.sin(a) * r, d = lake.depthAt(x, z);
          if (d > 0.55 && d < 1.2) {
            /* 8×8 の点の範囲（±1.2m）が全部水 */
            let ok = true;
            for (const [ox, oz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) if (!(lake.depthAt(x + ox, z + oz) > 0.15)) ok = false;
            if (ok) { shallow = { kind: 'shallow', x, z, depth: d }; break; }
          }
        }
      }
      return [deep, shallow].filter(Boolean);
    });
    for (const t of ['high', 'mid', 'low']) {
      await h.eval((t) => { const L = window.__lab; if (L.gfx.quality.tier !== t) L.setTier(t); L.setHour(10); L.setWeather('rain', { instant: true }); L.unfreeze(); L.tick(30); }, t);
      for (const s of sites) {
        const rb = await readback(h, s);
        proof.readback.push(rb);
        console.log('readback', t, s.kind, JSON.stringify(rb));
      }
    }
    await h.eval(() => window.__lab.setTier('high'));
  }

  proof.audit = await h.eval(() => {
    const A = window.__lab.programAudit();
    const mine = A.programs.filter((p) => p.tag?.startsWith('water:'));
    return { total: A.count, mine: mine.map((p) => [p.tag, p.frag, p.vert]), over: A.over.length, failed: A.failed.length };
  });
  proof.health = await h.eval(() => {
    const g = window.__lab.gfx, s = g.safety, m = g.modules.get('water');
    return { strikes: s.strikes.get('water') || 0, disabled: s.disabled.has('water'), stub: m?._ngStub ?? null, dead: [...s.deadPasses], stats: m?.stats?.() };
  });
  proof.counts = h.counts();
  console.log('audit', JSON.stringify(proof.audit));
  console.log('health', JSON.stringify(proof.health), JSON.stringify(proof.counts));
  fs.writeFileSync(path.join(h.out, set === 'hi' ? 'proof-hi.json' : 'proof.json'), JSON.stringify(proof, null, 1));
  /* 合否 */
  const bad = [];
  for (const [k, v] of Object.entries(proof.shots)) if (v.nan) bad.push(`${k}: NaN ${v.nan}`);
  for (const rb of proof.readback) {
    const lim = rb.site.kind === 'deep' ? 1 : 5;
    if (!rb.vsGame || rb.vsGame.n < 48 || rb.vsGame.maxMm > lim) bad.push(`readback ${rb.tier} ${rb.site.kind}: ${JSON.stringify(rb.vsGame)}`);
  }
  if (proof.audit.over || proof.audit.failed) bad.push('programAudit');
  if (proof.audit.mine.length > 6) bad.push(`programs ${proof.audit.mine.length}`);
  if (proof.health.strikes || proof.health.disabled || proof.health.stub) bad.push('health');
  if (proof.counts.errors || proof.counts.pageErrors) bad.push('console errors');
  console.log(bad.length ? `FAIL ${bad.join(' / ')}` : 'PASS');
  if (bad.length) throw new Error(bad.join(' / '));
}
