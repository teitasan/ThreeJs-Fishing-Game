/* ===========================================================
   コンタクトシート（sky の証拠と反復の道具。シナリオではない）
   -----------------------------------------------------------
   node scripts/gfx/scenarios/sky-sheet.mjs OUT.png COLS SCALE a.png b.png …
   各画像を 1/SCALE に箱フィルタで縮め、COLS 列に並べる（左上に番号の目印は付けない。並びは引数の順）
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { decodePNG, encodePNG } = await import(pathToFileURL(path.join(here, '../png.mjs')).href);

/**
 * @param {string[]} files
 * @param {number} cols
 * @param {string} out
 * @param {number} [scale=2] 縮小の倍率（整数）
 * @param {number} [gap=4]
 */
export function contactSheet(files, cols, out, scale = 2, gap = 4) {
  const imgs = files.filter((f) => fs.existsSync(f)).map((f) => decodePNG(fs.readFileSync(f)));
  if (!imgs.length) return null;
  const w = Math.floor(imgs[0].width / scale), h = Math.floor(imgs[0].height / scale);
  const rows = Math.ceil(imgs.length / cols);
  const W = cols * w + (cols + 1) * gap, H = rows * h + (rows + 1) * gap;
  const data = new Uint8Array(W * H * 4).fill(18);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  imgs.forEach((im, k) => {
    const ox = gap + (k % cols) * (w + gap), oy = gap + Math.floor(k / cols) * (h + gap);
    const ch = im.data.length / (im.width * im.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const sx = Math.min(im.width - 1, x * scale + dx), sy = Math.min(im.height - 1, y * scale + dy);
          const o = (sy * im.width + sx) * ch;
          r += im.data[o]; g += im.data[o + 1]; b += im.data[o + 2]; n++;
        }
        const o = ((oy + y) * W + ox + x) * 4;
        data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = 255;
      }
    }
  });
  fs.writeFileSync(out, encodePNG({ width: W, height: H, data }));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [out, cols, scale, ...files] = process.argv.slice(2);
  console.log(contactSheet(files, Number(cols) || 3, out, Number(scale) || 2));
}
