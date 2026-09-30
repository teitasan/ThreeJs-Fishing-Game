#!/usr/bin/env node
/* ===========================================================
   撮影の自動判定（ARCHITECTURE §4.12）
   -----------------------------------------------------------
   node scripts/gfx/art-metrics.mjs DIR [--json OUT] [--no-fail]
   DIR の *.png（lab-matrix.mjs の撮影なら同名の .json に時刻・天候・水平線の位置がある）を読んで判定する：
     clip       白飛び（どれかのチャンネル ≥ 250）< 0.5%
     crush      黒つぶれ（全チャンネル ≤ 3）< 1%（夜も同じ。«暗いと分かる暗さ» で潰さない）
     midBand    昼（7–17 時・水上）の画面平均の表示輝度（sRGB の輝度）が 0.15–0.65
     waterSky   水平視（|ピッチ| ≤ 15°、水平線が画面の 15–85%）の水／空の平均輝度比（線形）0.35–0.75
     waterHue   noon-fp-down の画面中央（縦 35–65%・横 30–70%。下は桟橋の床）の平均色相 160–200°
     banding    空（水平線より上）の縦の走査で、同じ 8bit 値が続く長さの p95 が 1080p 換算で 24px 以下
     dawn       同じプリセット・天候の 4:30–8:00 の絵を時刻順に並べ、平均の表示輝度が下がらない（2% の許し）
     night      同じプリセット・天候の 23:30 前後 / 12:30 前後の平均の表示輝度の比が 0.25–0.40
   失敗が 1 つでもあれば終了コード 1（--no-fail で常に 0）。関数は Node のテストからも使う
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './png.mjs';

/** 判定の閾値（ARCHITECTURE §4.12 の数値） */
export const ART_LIMITS = Object.freeze({
  clip: 0.005, crush: 0.01, midBand: [0.15, 0.65], waterSky: [0.35, 0.75], waterHue: [160, 200],
  bandingPx1080: 24, dawnSlack: 0.02, night: [0.25, 0.40],
});

const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const LIN = Float64Array.from({ length: 256 }, (_, i) => lin(i));
const lumLin = (d, o) => 0.2126 * LIN[d[o]] + 0.7152 * LIN[d[o + 1]] + 0.0722 * LIN[d[o + 2]];
/** 表示の輝度（sRGB の値で重み付け、0..1） */
const lumDisp = (d, o) => (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255;

/**
 * 画面全体（または行の範囲）の統計
 * @param {{width:number, height:number, data:Uint8Array}} img RGBA8
 * @param {{y0?:number, y1?:number, x0?:number, x1?:number}} [r] 画素の範囲（半開区間）
 * @returns {{n:number, clip:number, crush:number, meanDisp:number, meanLin:number, meanRGB:[number,number,number]}}
 */
export function regionStats(img, r = {}) {
  const { width: W, height: H, data: d } = img;
  const y0 = Math.max(0, r.y0 ?? 0), y1 = Math.min(H, r.y1 ?? H), x0 = Math.max(0, r.x0 ?? 0), x1 = Math.min(W, r.x1 ?? W);
  let n = 0, clip = 0, crush = 0, sd = 0, sl = 0, sr = 0, sg = 0, sb = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4, R = d[o], G = d[o + 1], B = d[o + 2];
      if (R >= 250 || G >= 250 || B >= 250) clip++;
      if (R <= 3 && G <= 3 && B <= 3) crush++;
      sd += lumDisp(d, o); sl += lumLin(d, o);
      sr += LIN[R]; sg += LIN[G]; sb += LIN[B];
      n++;
    }
  }
  const k = 1 / Math.max(1, n);
  return { n, clip: clip * k, crush: crush * k, meanDisp: sd * k, meanLin: sl * k, meanRGB: [sr * k, sg * k, sb * k] };
}

/**
 * 線形 RGB の色相（度、0..360）
 * @param {[number, number, number]} rgb
 * @returns {number}
 */
export function hueDeg([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (c <= 1e-9) return 0;
  let h;
  if (mx === r) h = ((g - b) / c) % 6;
  else if (mx === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  return (h * 60 + 360) % 360;
}

/**
 * 空のバンディング：縦の走査で同じ 8bit の緑が続く長さの p95（画素）。
 * 列の上下で 4 LSB 以上変わる（＝諧調がある）列だけを数える（一様な面は長く続いて当然なので除く）
 * @param {{width:number, height:number, data:Uint8Array}} img
 * @param {number} y0 走査する行の範囲（半開区間）
 * @param {number} y1
 * @returns {{p95:number, columns:number}}
 */
export function bandingRuns(img, y0, y1) {
  const { width: W, data: d } = img;
  const runs = [];
  let cols = 0;
  for (let x = 0; x < W; x += 4) {
    const top = d[(y0 * W + x) * 4 + 1], bot = d[((y1 - 1) * W + x) * 4 + 1];
    if (Math.abs(top - bot) < 4) continue;
    cols++;
    let run = 1;
    for (let y = y0 + 1; y < y1; y++) {
      if (d[(y * W + x) * 4 + 1] === d[((y - 1) * W + x) * 4 + 1]) run++;
      else { runs.push(run); run = 1; }
    }
    runs.push(run);
  }
  runs.sort((a, b) => a - b);
  return { p95: runs.length ? runs[Math.floor(runs.length * 0.95)] : 0, columns: cols };
}

const inRange = (v, [lo, hi]) => v >= lo && v <= hi;

/**
 * 1 枚の判定
 * @param {{width:number, height:number, data:Uint8Array}} img
 * @param {{name?:string, preset?:string, hour?:number, horizon?:number|null, pitchDeg?:number, uw?:boolean}} [meta]
 * @returns {{name:string, checks: Array<{id:string, pass:boolean, value:number, limit:any}>, stats:object}}
 */
export function judgeImage(img, meta = {}) {
  const L = ART_LIMITS, checks = [];
  const all = regionStats(img);
  const add = (id, pass, value, limit) => checks.push({ id, pass, value: +value.toFixed(4), limit });
  add('clip', all.clip < L.clip, all.clip, `< ${L.clip}`);
  add('crush', all.crush < L.crush, all.crush, `< ${L.crush}`);
  const hour = meta.hour, day = Number.isFinite(hour) && hour >= 7 && hour <= 17;
  if (day && !meta.uw) add('midBand', inRange(all.meanDisp, L.midBand), all.meanDisp, L.midBand);
  const H = img.height, hz = meta.horizon;
  const level = Number.isFinite(meta.pitchDeg) && Math.abs(meta.pitchDeg) <= 15 && Number.isFinite(hz) && hz >= 0.15 && hz <= 0.85;
  if (level && !meta.uw) {
    const hy = Math.round(hz * H);
    const sky = regionStats(img, { y0: Math.round(hy - 0.3 * H), y1: Math.round(hy - 0.08 * H) });
    const water = regionStats(img, { y0: Math.round(hy + 0.08 * H), y1: Math.round(hy + 0.3 * H) });
    if (sky.n > 0 && water.n > 0) {
      const ratio = water.meanLin / Math.max(sky.meanLin, 1e-6);
      add('waterSky', inRange(ratio, L.waterSky), ratio, L.waterSky);
    }
  }
  if (meta.preset === 'noon-fp-down' && !meta.uw) {
    const W = img.width;
    const st = regionStats(img, { y0: Math.round(H * 0.35), y1: Math.round(H * 0.65), x0: Math.round(W * 0.3), x1: Math.round(W * 0.7) });
    const hue = hueDeg(st.meanRGB);
    add('waterHue', inRange(hue, L.waterHue), hue, L.waterHue);
  }
  if (!meta.uw) {
    const y1 = Number.isFinite(hz) ? Math.round(Math.min(Math.max(hz, 0), 1) * H) - Math.round(0.03 * H) : Math.round(0.3 * H);
    if (y1 > 16) {
      const b = bandingRuns(img, 0, y1);
      const lim = L.bandingPx1080 * (H / 1080);
      if (b.columns > 0) add('banding', b.p95 <= lim, b.p95, `<= ${lim.toFixed(1)}px`);
    }
  }
  return { name: meta.name || '', checks, stats: { meanDisp: all.meanDisp, meanLin: all.meanLin } };
}

/**
 * 複数の絵にまたがる判定（夜明けの単調性・真夜中と真昼の比）
 * @param {Array<{name:string, preset?:string, weather?:string, hour?:number, uw?:boolean, stats:{meanDisp:number}}>} shots
 * @returns {Array<{id:string, group:string, pass:boolean, value:number, limit:any}>}
 */
export function judgeSeries(shots) {
  const L = ART_LIMITS, out = [];
  const groups = new Map();
  for (const s of shots) {
    if (!Number.isFinite(s.hour) || s.uw) continue;
    const k = `${s.preset || ''}|${s.weather || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  for (const [k, g] of groups) {
    const dawn = g.filter((s) => s.hour >= 4.5 && s.hour <= 8).sort((a, b) => a.hour - b.hour);
    if (dawn.length >= 2) {
      let worst = 0;
      for (let i = 1; i < dawn.length; i++) worst = Math.min(worst, dawn[i].stats.meanDisp - dawn[i - 1].stats.meanDisp * (1 - L.dawnSlack));
      out.push({ id: 'dawn', group: k, pass: worst >= 0, value: +worst.toFixed(4), limit: '単調増加' });
    }
    const near = (h) => g.reduce((best, s) => (Math.abs(s.hour - h) < 0.6 && (!best || Math.abs(s.hour - h) < Math.abs(best.hour - h)) ? s : best), null);
    const noon = near(12.5), night = near(23.5);
    if (noon && night) {
      const r = night.stats.meanDisp / Math.max(noon.stats.meanDisp, 1e-6);
      out.push({ id: 'night', group: k, pass: inRange(r, L.night), value: +r.toFixed(4), limit: L.night });
    }
  }
  return out;
}

/**
 * DIR の全部を判定する
 * @param {string} dir
 * @returns {{shots: object[], series: object[], failed: number}}
 */
export function judgeDir(dir) {
  const shots = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort()) {
    const base = f.slice(0, -4);
    const mf = path.join(dir, `${base}.json`);
    const meta = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : { name: base };
    const r = judgeImage(decodePNG(fs.readFileSync(path.join(dir, f))), { name: base, ...meta });
    shots.push({ ...r, preset: meta.preset, weather: meta.weather, hour: meta.hour, uw: meta.uw });
  }
  const series = judgeSeries(shots);
  const failed = shots.reduce((n, s) => n + s.checks.filter((c) => !c.pass).length, 0) + series.filter((c) => !c.pass).length;
  return { shots, series, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('usage: node scripts/gfx/art-metrics.mjs DIR [--json OUT] [--no-fail]'); process.exit(2); }
  const ji = args.indexOf('--json');
  const res = judgeDir(dir);
  for (const s of res.shots) {
    const bad = s.checks.filter((c) => !c.pass);
    console.log(`${bad.length ? 'NG' : 'ok'} ${s.name.padEnd(36)} ${s.checks.map((c) => `${c.id} ${c.value}${c.pass ? '' : '!'}`).join('  ')}`);
  }
  for (const c of res.series) console.log(`${c.pass ? 'ok' : 'NG'} ${c.id.padEnd(6)} ${c.group.padEnd(30)} ${c.value}（${JSON.stringify(c.limit)}）`);
  console.log(`art-metrics: ${res.shots.length} 枚、失敗 ${res.failed}`);
  if (ji >= 0 && args[ji + 1]) fs.writeFileSync(args[ji + 1], JSON.stringify(res, null, 1));
  process.exit(res.failed && !args.includes('--no-fail') ? 1 : 0);
}
