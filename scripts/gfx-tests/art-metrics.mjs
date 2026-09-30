#!/usr/bin/env node
/* ===========================================================
   art-metrics と png.mjs の判定が正しく働くか（ARCHITECTURE §4.12）。合成した絵で確かめる
   - PNG の書き出し → 読み込みで画素が一致する（フィルタ付きの PNG も読める）
   - 白飛び・黒つぶれ・色相・水／空の比・バンディング（ディザあり/なし）・夜明けの単調性・夜の比
   =========================================================== */
import zlib from 'node:zlib';
import { check, done } from './lib/env.mjs';
import { encodePNG, decodePNG } from '../gfx/png.mjs';
import { judgeImage, judgeSeries, regionStats, hueDeg, bandingRuns } from '../gfx/art-metrics.mjs';

const W = 192, H = 108;
function img(fn, w = W, h = H) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y), o = (y * w + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}
/* 決定的なディザ（整数ハッシュ。Math.random を使わない） */
const hash = (x, y) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/* PNG の往復と、Paeth フィルタの PNG の読み */
const a = img((x, y) => [x, y * 2, (x * y) & 255]);
const b = decodePNG(encodePNG(a));
check(b.width === W && b.height === H && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0, 'PNG の往復で画素が一致');
{
  /* 手で Paeth（type 4）の RGB の PNG を作って読む */
  const w = 3, h = 2, px = [[10, 20, 30], [40, 50, 60], [70, 80, 90], [15, 25, 35], [45, 55, 65], [75, 85, 95]];
  const raw = [];
  const at = (x, y, c) => (x < 0 || y < 0 ? 0 : px[y * w + x][c]);
  for (let y = 0; y < h; y++) {
    raw.push(4);
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      const l = at(x - 1, y, c), u = at(x, y - 1, c), ul = at(x - 1, y - 1, c), p = l + u - ul;
      const pa = Math.abs(p - l), pb = Math.abs(p - u), pc = Math.abs(p - ul);
      const pred = pa <= pb && pa <= pc ? l : pb <= pc ? u : ul;
      raw.push((px[y * w + x][c] - pred) & 255);
    }
  }
  const png = Buffer.from(encodePNG({ width: 1, height: 1, data: new Uint8Array(4) }));
  /* IHDR を差し替えた PNG を組み直す（encodePNG の chunk を流用せず、IDAT だけ差し替える） */
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const chunk = (t, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(t, 'latin1'), body, Buffer.alloc(4)]);   // CRC は decode が見ない
  };
  const file = Buffer.concat([png.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
  const d = decodePNG(file);
  check(d.data[4 * 4] === 45 && d.data[4 * 4 + 1] === 55 && d.data[5 * 4 + 2] === 95 && d.data[3] === 255, 'Paeth フィルタの RGB PNG を読める');
}

/* 白飛び・黒つぶれ */
const white = img((x) => (x < 20 ? [255, 255, 255] : [120, 120, 120]));
check(regionStats(white).clip > 0.1 && !judgeImage(white).checks.find((c) => c.id === 'clip').pass, '白飛びを検出');
const black = img((x) => (x < 20 ? [0, 0, 0] : [60, 60, 60]));
check(!judgeImage(black).checks.find((c) => c.id === 'crush').pass, '黒つぶれを検出');
const mid = img(() => [110, 115, 120]);
const jm = judgeImage(mid, { hour: 12 });
check(jm.checks.every((c) => c.pass), `中間の灰は全部合格（${JSON.stringify(jm.checks)}）`);
check(!judgeImage(img(() => [20, 20, 20]), { hour: 12 }).checks.find((c) => c.id === 'midBand').pass, '昼に暗すぎる絵は midBand で落ちる');

/* 色相 */
check(Math.abs(hueDeg([0, 0.5, 0.5]) - 180) < 1e-6 && Math.abs(hueDeg([1, 0, 0])) < 1e-6 && Math.abs(hueDeg([0, 0, 1]) - 240) < 1e-6, '色相の計算');
const teal = img(() => [30, 110, 105]);
check(judgeImage(teal, { preset: 'noon-fp-down', hour: 12.5 }).checks.find((c) => c.id === 'waterHue').pass, '青緑の水は合格');
const brown = img(() => [110, 80, 40]);
check(!judgeImage(brown, { preset: 'noon-fp-down', hour: 12.5 }).checks.find((c) => c.id === 'waterHue').pass, '茶色の水は落ちる');

/* 水／空の比：水平線 0.5、上が空 200、下が水 */
const ws = (w) => img((x, y) => (y < H / 2 ? [200, 200, 200] : [w, w, w]));
const wsOk = judgeImage(ws(150), { hour: 12, horizon: 0.5, pitchDeg: 0 }).checks.find((c) => c.id === 'waterSky');
check(wsOk && wsOk.pass, `水が空の約半分の明るさなら合格（${wsOk && wsOk.value}）`);
check(!judgeImage(ws(200), { hour: 12, horizon: 0.5, pitchDeg: 0 }).checks.find((c) => c.id === 'waterSky').pass, '水が空と同じ明るさは落ちる');
check(!judgeImage(ws(150), { hour: 12, horizon: 0.5, pitchDeg: -40 }).checks.some((c) => c.id === 'waterSky'), '見下ろしでは水／空を測らない');

/* バンディング：1080 行の縦のなめらかな階調（12 LSB）を 8bit に丸めた絵（ディザ無し）と、±0.5 LSB のディザ */
const GH = 1080;
const grad = (dither) => img((x, y) => {
  const v = 80 + (y / GH) * 12 + (dither ? hash(x, y) - 0.5 : 0);
  const q = Math.round(v);
  return [q, q, q];
}, 64, GH);
const plain = bandingRuns(grad(false), 0, GH), dith = bandingRuns(grad(true), 0, GH);
check(plain.p95 > dith.p95 * 2, `ディザ無しの階調は同じ値が長く続く（${plain.p95} > ${dith.p95}）`);
check(!judgeImage(grad(false), { hour: 20 }).checks.find((c) => c.id === 'banding').pass, 'ディザ無しの空はバンディングで落ちる');
check(judgeImage(grad(true), { hour: 20 }).checks.find((c) => c.id === 'banding').pass, 'ディザありの空は合格');

/* 夜明けの単調性と夜の比 */
const sh = (hour, m, weather = 'clear') => ({ name: `p_${hour}`, preset: 'p', weather, hour, stats: { meanDisp: m } });
const up = judgeSeries([sh(5, 0.1), sh(6, 0.2), sh(7.5, 0.3)]).find((c) => c.id === 'dawn');
check(up && up.pass, '夜明けに明るくなるのは合格');
const down = judgeSeries([sh(5, 0.3), sh(6, 0.2), sh(7.5, 0.35)]).find((c) => c.id === 'dawn');
check(down && !down.pass, '夜明けに暗くなるのは落ちる');
check(judgeSeries([sh(12.5, 0.4), sh(23.5, 0.13)]).find((c) => c.id === 'night').pass, '真夜中が真昼の 1/3 は合格');
check(!judgeSeries([sh(12.5, 0.4), sh(23.5, 0.02)]).find((c) => c.id === 'night').pass, '真夜中が暗すぎるのは落ちる');
check(judgeSeries([sh(12.5, 0.4), sh(23.5, 0.13, 'rain')]).every((c) => c.id !== 'night'), '天候が違う絵どうしは比べない');

done('art-metrics');
