/* テストからファサードを読む入口。
     const F = await loadFacades();            // stub の core
     F.Terrain / F.Water / F.Environment / F.WEATHERS / F.THREE / F.stub（calls, control, resetStub）
   'three' は vendor のものを読む。src/gfx/core は stub に差し替える（Node に WebGL は無い） */
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let registered = false;

export async function loadFacades() {
  if (!registered) {
    register(pathToFileURL(path.join(ROOT, 'scripts/facade-harness/loader.mjs')).href, {
      data: {
        threeUrl: pathToFileURL(path.join(ROOT, 'vendor/three.module.min.js')).href,
        addonsBase: pathToFileURL(path.join(ROOT, 'vendor/addons')).href + '/',
        stubUrl: pathToFileURL(path.join(ROOT, 'scripts/facade-harness/stub-core.mjs')).href,
      },
    });
    registered = true;
  }
  const src = (p) => pathToFileURL(path.join(ROOT, 'src', p)).href;
  const [THREE, terrain, water, sky, stub] = await Promise.all([
    import(pathToFileURL(path.join(ROOT, 'vendor/three.module.min.js')).href),
    import(src('terrain.js')),
    import(src('water.js')),
    import(src('sky.js')),
    import(pathToFileURL(path.join(ROOT, 'scripts/facade-harness/stub-core.mjs')).href),
  ]);
  return { THREE, ...terrain, ...water, ...sky, stub, ROOT };
}

/** fixture を読む */
import fs from 'node:fs';
export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures', name), 'utf8'));

/** Math.random の差し替えに使う mulberry32（fixture の記録と同じ） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
