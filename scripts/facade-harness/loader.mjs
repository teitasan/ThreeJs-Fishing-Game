/* Node で src のファサードを読むための resolve フック。
   - 'three' / 'three/addons/' → vendor の three（ブラウザの import map と同じ対応）
   - stubCore が有効なら src/gfx/core/index.js → stub-core.mjs（描画の芯を持たないテスト用） */
let cfg = {};
export async function initialize(data) { cfg = data || {}; }
export async function resolve(spec, ctx, next) {
  if (spec === 'three') return { url: cfg.threeUrl, shortCircuit: true, format: 'module' };
  if (spec.startsWith('three/addons/')) return { url: cfg.addonsBase + spec.slice('three/addons/'.length), shortCircuit: true, format: 'module' };
  if (cfg.stubUrl && ctx.parentURL && (spec.startsWith('.') || spec.startsWith('/'))) {
    try {
      const u = new URL(spec, ctx.parentURL);
      if (u.pathname.endsWith('/src/gfx/core/index.js')) return { url: cfg.stubUrl, shortCircuit: true, format: 'module' };
    } catch (e) { /* 次へ */ }
  }
  return next(spec, ctx);
}
