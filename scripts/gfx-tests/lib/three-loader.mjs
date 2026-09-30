/* ===========================================================
   Node の ESM ローダー：ブラウザの importmap と同じ解決をする
   'three' → vendor/three.module.min.js、'postprocessing' → vendor/postprocessing/index.js
   lib/env.mjs の withThree が --experimental-loader で自分自身を起動し直すときに使う
   =========================================================== */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP = {
  three: pathToFileURL(path.join(ROOT, 'vendor/three.module.min.js')).href,
  postprocessing: pathToFileURL(path.join(ROOT, 'vendor/postprocessing/index.js')).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (MAP[specifier]) return { url: MAP[specifier], shortCircuit: true };
  return nextResolve(specifier, context);
}
