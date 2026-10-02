/* ===========================================================
   sky の証拠一式（ARCHITECTURE §6.1 の «証拠»）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/sky-proof.mjs --out DIR [--size 1280x720]
   SETS=sheet,blue,golden,overcast,rain,night,numbers（既定は全部）  TIER=high
   - sheet：24 時刻（0:30〜23:30）× {clear, cloudy, rain} のコンタクトシート（sheet-<天候>.png）
   - blue：ブルーアワー（太陽 −2°〜−6°）の反太陽側（ビーナスベルト・地球の影）と太陽側、夜明け
   - golden：黄金時間の逆光の積雲（太陽へ向く、17:00〜17:40）
   - overcast：曇天（天頂と地平）、rain：雨、night：23:30 の月夜（釣り人の視点・広角・天頂）
   - numbers：GPU の skyView の地平（8 方位）と CPU 双子の地平の差（地平線の連続 < 4%）、天頂の比較、
     23:30 の天頂の色（#0b1426 との比較）、24h の key・SH・空の照度の表 + グラフ（sky-graph.png）、NaN、
     プログラムの監査、健在
   出力：DIR/*.png と DIR/sky-proof.json
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { encodePNG } = await import(pathToFileURL(path.join(here, '../png.mjs')).href);
const { contactSheet } = await import(pathToFileURL(path.join(here, 'sky-sheet.mjs')).href);

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

/** カメラ：プリセット名、または «horizon:方位°:仰角°:画角°»（dock-fp の位置から） */
async function aim(h, cam) {
  await h.eval((cam) => {
    const L = window.__lab;
    L.camera.fov = 55; L.camera.updateProjectionMatrix();
    if (cam.startsWith('horizon:')) {
      const a = cam.split(':'), az = +a[1], el = +a[2], fov = a[3] ? +a[3] : 55;
      const p = L.presets()['dock-fp'].pos, r = Math.PI / 180;
      L.cam({ pos: p, target: [p[0] + Math.cos(el * r) * Math.cos(az * r) * 100, p[1] + Math.sin(el * r) * 100, p[2] + Math.cos(el * r) * Math.sin(az * r) * 100] });
      L.camera.fov = fov; L.camera.updateProjectionMatrix();
    } else L.cam(cam);
  }, cam);
}

async function shoot(h, name, cam, hour, weather, frames = 36) {
  await aim(h, cam);
  const r = await h.eval(({ hour, weather, frames }) => {
    const L = window.__lab;
    L.setHour(hour); L.setWeather(weather, { instant: true }); L.freeze(10); L.tick(frames);
    return { lum: L.meanLuminance(), expo: L.stats().exposure, nan: L.nanCheck() };
  }, { hour, weather, frames });
  await h.shot(name);
  return { name, cam, hour, weather, ...r };
}

/* 太陽の方位（xz、度）と高度：旧式の軌道 sunDir = normalize(cos a, sin a, 0.34) */
const sunAz = (hour) => { const a = ((hour - 6) / 24) * Math.PI * 2; return Math.atan2(0.34, Math.cos(a)) * 180 / Math.PI; };
const sunAlt = (hour) => { const a = ((hour - 6) / 24) * Math.PI * 2; return Math.asin(Math.sin(a) / Math.hypot(1, 0.34)) * 180 / Math.PI; };

export default async function (h) {
  const tier = process.env.TIER || 'high';
  const sets = new Set(list(process.env.SETS, ['sheet', 'blue', 'golden', 'overcast', 'rain', 'night', 'numbers']));
  await h.open(`lab/sky.html?capture=1&chart=0&chars=${process.env.CHARS ?? 0}&tier=${tier}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 180);
  const out = { tier, shots: [], size: await h.eval(() => [window.__lab.renderer.domElement.width, window.__lab.renderer.domElement.height]) };
  const add = (r) => { out.shots.push(r); console.log(r.name, JSON.stringify({ lum: +r.lum.toFixed(4), expo: +r.expo.toFixed(2), nan: r.nan })); };
  const P = (n) => path.join(h.out, n + '.png');

  if (sets.has('sheet')) {
    /* 太陽の通り道（南 = +z）を向いた広角。朝は左（+x）、夕は右（−x） */
    for (const w of ['clear', 'cloudy', 'rain']) {
      const files = [];
      for (let k = 0; k < 24; k++) {
        const hour = k + 0.5, name = `sheet-${w}-${String(k).padStart(2, '0')}30`;
        add(await shoot(h, name, 'horizon:90:14:96', hour, w, 30));
        files.push(P(name));
      }
      contactSheet(files, 6, P(`sheet-${w}`), 4);
    }
  }
  if (sets.has('blue')) {
    for (const hour of [18.0, 18.15, 18.3, 18.45, 18.6]) {
      const az = sunAz(hour);
      add(await shoot(h, `blue-anti-${hour}`, `horizon:${(az + 180).toFixed(1)}:9:90`, hour, 'clear'));
      add(await shoot(h, `blue-sun-${hour}`, `horizon:${az.toFixed(1)}:9:90`, hour, 'clear'));
    }
    add(await shoot(h, 'blue-dawn-5.8', `horizon:${sunAz(5.8).toFixed(1)}:8:90`, 5.8, 'clear'));
    add(await shoot(h, 'blue-dawn-anti-5.8', `horizon:${(sunAz(5.8) + 180).toFixed(1)}:8:90`, 5.8, 'clear'));
    add(await shoot(h, 'blue-dusk3p-18.3', 'dusk-3p', 18.3, 'clear'));
    contactSheet(['18.0', '18.15', '18.3', '18.45', '18.6'].flatMap((x) => [P(`blue-anti-${x}`), P(`blue-sun-${x}`)]), 2, P('sheet-blue'), 2);
  }
  if (sets.has('golden')) {
    for (const hour of [16.6, 17.0, 17.3, 17.6]) {
      add(await shoot(h, `golden-${hour}`, `horizon:${sunAz(hour).toFixed(1)}:${Math.max(sunAlt(hour) + 3, 6).toFixed(1)}:80`, hour, 'clear'));
    }
    add(await shoot(h, 'golden-dusk3p-17.5', 'dusk-3p', 17.5, 'clear'));
  }
  if (sets.has('overcast')) {
    add(await shoot(h, 'overcast-up-12', 'horizon:30:60:110', 12, 'cloudy'));
    add(await shoot(h, 'overcast-horizon-12', 'horizon:30:10:80', 12, 'cloudy'));
    add(await shoot(h, 'overcast-dockfp-15', 'dock-fp', 15, 'cloudy'));
    add(await shoot(h, 'overcast-dusk-18.2', 'dusk-3p', 18.2, 'cloudy'));
  }
  if (sets.has('rain')) {
    add(await shoot(h, 'rain-fp-11', 'rain-fp', 11, 'rain'));
    add(await shoot(h, 'rain-up-11', 'horizon:30:60:110', 11, 'rain'));
    add(await shoot(h, 'rain-horizon-14', 'horizon:200:8:80', 14, 'rain'));
  }
  if (sets.has('night')) {
    add(await shoot(h, 'night-fp-23.5', 'night-fp', 23.5, 'clear'));
    add(await shoot(h, 'night-wide-23.5', 'horizon:90:20:100', 23.5, 'clear'));
    add(await shoot(h, 'night-up-23.5', 'horizon:30:75:100', 23.5, 'clear'));
    add(await shoot(h, 'night-cloudy-23.5', 'night-fp', 23.5, 'cloudy'));
    add(await shoot(h, 'night-noon-ref-12.5', 'night-fp', 12.5, 'clear'));
  }
  if (sets.has('numbers')) {
    await aim(h, 'dock-fp');
    out.numbers = await h.eval(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const L = window.__lab, g = L.gfx, m = g.modules.get('sky'), R = L.renderer, F = g.frame.data;
      const half = (u) => { const s = (u & 0x8000) ? -1 : 1, e = (u >> 10) & 31, f = u & 1023; return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15); };
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const read = (rt, x, y) => { const b = new Uint16Array(4); R.readRenderTargetPixels(rt, x, y, 1, 1, b); return [half(b[0]), half(b[1]), half(b[2])]; };
      const res = { horizon: [], zenith: [] };
      for (const [hour, w] of [[6.2, 'clear'], [9, 'clear'], [12.5, 'clear'], [17.5, 'clear'], [18.3, 'clear'], [23.5, 'clear'], [12, 'cloudy'], [11, 'rain'], [18.2, 'cloudy']]) {
        L.setHour(hour); L.setWeather(w, { instant: true }); L.freeze(10); L.tick(40);
        /* GPU の空の読み戻し（非同期、0.25s ごと）が戻るまで回す（tick は同期なので間に事象の環を回す） */
        for (let k = 0; k < 4; k++) { await sleep(280); L.tick(2); }
        const rt = m.rtView, W = rt.width, H = rt.height;
        /* 地平の仰角 1.15°（HZ_Y = 0.02）：ngSkyViewUV の v = 0.5 + 0.5·sqrt(el/90°) */
        const el = Math.atan(0.02) * 180 / Math.PI;
        const v = 0.5 + 0.5 * Math.sqrt(el / 90);
        /* 縮小の 17 行目と同じ核：縦は v で双一次、横は 8 テクセルの箱 → 32 マスを方位で線形補間（rig._fromGpu と同じ）。
           核が違うと、太陽側の残照のような方位の鋭い山で «GPU と CPU の差» でなく «測り方の差» を測ってしまう */
        const yv = v * H - 0.5, r0 = Math.floor(yv), fy = yv - r0;
        const rb0 = new Uint16Array(W * 4), rb1 = new Uint16Array(W * 4);
        R.readRenderTargetPixels(rt, 0, r0, W, 1, rb0);
        R.readRenderTargetPixels(rt, 0, Math.min(H - 1, r0 + 1), W, 1, rb1);
        const PW = 32, cell = (j, k) => { let a = 0; for (let t = 0; t < 8; t++) { const x = j * 8 + t; a += half(rb0[x * 4 + k]) * (1 - fy) + half(rb1[x * 4 + k]) * fy; } return a / 8; };
        let gpu = [0, 0, 0], cpu = [0, 0, 0];
        for (let i = 0; i < 8; i++) {
          const az = (i / 8) * Math.PI * 2;
          /* ngSkyViewUV：u = atan(z, x) / 2π + 0.5 */
          const u = Math.atan2(Math.sin(az), Math.cos(az)) / (2 * Math.PI) + 0.5;
          const xx = u * PW - 0.5, x0 = Math.floor(xx), fx = xx - x0, xa = ((x0 % PW) + PW) % PW, xb = (xa + 1) % PW;
          const c = [0, 1, 2].map((k) => cell(xa, k) * (1 - fx) + cell(xb, k) * fx);
          const s = m.rig.Lsky.slice(128 * 3 + i * 3, 128 * 3 + i * 3 + 3);
          for (let k = 0; k < 3; k++) { gpu[k] += c[k] / 8; cpu[k] += s[k] / 8; }
        }
        const err = Math.abs(lum(gpu) - lum(cpu)) / Math.max(lum(cpu), 1e-9);
        res.horizon.push({ hour, w, gpu: gpu.map((x) => +x.toPrecision(4)), cpu: cpu.map((x) => +x.toPrecision(4)), err: +(err * 100).toFixed(2) });
        const z = read(rt, W >> 1, H - 1), zc = m.rig.out.zenith;
        res.zenith.push({ hour, w, gpu: z.map((x) => +x.toPrecision(4)), cpu: zc.map((x) => +x.toPrecision(4)), expo: +L.stats().exposure.toFixed(3), gpuSky: !!m.rig.gpuSky });
      }
      /* 24h の表（CPU のリグ。晴れ） */
      const rig = m.rig, rows = [];
      const Fs = new Float32Array(96);
      for (let k = 0; k <= 96; k++) {
        const hour = k / 4, a = ((hour - 6) / 24) * Math.PI * 2, l = Math.hypot(1, 0.34);
        rig._last = null;
        const o = rig.step({ dt: 0, hour, weather: { cloud: 0.14, rain: 0 }, sunDir: { x: Math.cos(a) / l, y: Math.sin(a) / l, z: 0.34 / l }, envTime: hour * 3600 }, Fs);
        rows.push({ hour, key: o.keyColor.map((x) => +x.toFixed(3)), keyI: +o.keyIntensity.toPrecision(4), sh0: [rig.sh[0], rig.sh[1], rig.sh[2]].map((x) => +x.toPrecision(4)), skyUp: rig.skyUp.map((x) => +x.toPrecision(4)), zenith: o.zenith.map((x) => +x.toPrecision(4)), horizon: o.horizon.map((x) => +x.toPrecision(4)), expo: +o.exposure.toFixed(3) });
      }
      rig._last = null;
      res.day = rows;
      res.programs = L.programAudit().byModule?.sky ?? null;
      res.over = L.programAudit().over.length;
      const s = g.safety;
      res.health = { strikes: s.strikes.get('sky') || 0, disabled: s.disabled.has('sky'), stub: m._ngStub ?? null, restarts: g._restarts.get('sky') || 0 };
      res.stats = L.stats().modules?.sky ?? null;
      res.loadMs = g.loadStats?.modules?.sky ?? null;
      res.loadParts = m.loadParts ?? null;
      return res;
    });
    const n = out.numbers;
    out.horizonWorstPct = Math.max(...n.horizon.map((x) => x.err));
    console.log('horizon (GPU vs CPU) worst %', out.horizonWorstPct, JSON.stringify(n.horizon.map((x) => `${x.w}@${x.hour}:${x.err}`)));
    console.log('programs', JSON.stringify(n.programs), 'over', n.over, 'health', JSON.stringify(n.health), 'loadMs', n.loadMs, JSON.stringify(n.loadParts));
    graph(n.day, path.join(h.out, 'sky-graph.png'));
  }
  out.console = h.counts();
  fs.writeFileSync(path.join(h.out, 'sky-proof.json'), JSON.stringify(out, null, 1));
  console.log('console', JSON.stringify(out.console));
}

/* 24h のグラフ（PNG）：上から key の強さ × 露出（対数）・空の照度 × 露出（対数）の線、
   key の色・SH L0 の色・天頂の色（露出後、簡易のトーンマップ）・地平の色の帯 */
function graph(rows, file) {
  const W = 960, H = 420, data = new Uint8Array(W * H * 4).fill(20);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const px = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; };
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const srgb = (v) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  const tm = (c, k = 1) => c.map((v) => srgb((v * k) / (1 + v * k)));
  const X = (hour) => Math.round(20 + (hour / 24) * (W - 40));
  /* 枠と 6 時間ごとの線 */
  for (let hh = 0; hh <= 24; hh += 6) for (let y = 10; y < 230; y++) px(X(hh), y, [60, 60, 60]);
  const Y = (v) => Math.round(220 - ((Math.log10(Math.max(v, 1e-4)) + 4) / 4.7) * 200);   // 1e-4 .. 5
  for (const d of [1e-3, 1e-2, 1e-1, 1]) for (let x = 20; x < W - 20; x += 3) px(x, Y(d), [45, 45, 45]);
  let prev = null;
  for (const r of rows) {
    const x = X(r.hour), yk = Y(r.keyI * r.expo), ys = Y(lum(r.skyUp) * r.expo);
    if (prev) {
      for (let t = 0; t <= 1; t += 0.05) {
        px(Math.round(prev.x + (x - prev.x) * t), Math.round(prev.yk + (yk - prev.yk) * t), [255, 200, 80]);
        px(Math.round(prev.x + (x - prev.x) * t), Math.round(prev.ys + (ys - prev.ys) * t), [110, 170, 255]);
      }
    }
    prev = { x, yk, ys };
  }
  const band = (y0, y1, colorOf) => {
    for (let i = 0; i < rows.length - 1; i++) {
      const c = colorOf(rows[i]);
      for (let x = X(rows[i].hour); x < X(rows[i + 1].hour); x++) for (let y = y0; y < y1; y++) px(x, y, c);
    }
  };
  band(240, 275, (r) => tm(r.key, 0.8));
  band(280, 315, (r) => { const l = Math.max(lum(r.sh0), 1e-9); return tm(r.sh0.map((v) => v / l), 0.8); });
  band(320, 365, (r) => tm(r.zenith, r.expo * 1.6));
  band(370, 410, (r) => tm(r.horizon, r.expo * 1.6));
  fs.writeFileSync(file, encodePNG({ width: W, height: H, data }));
}
