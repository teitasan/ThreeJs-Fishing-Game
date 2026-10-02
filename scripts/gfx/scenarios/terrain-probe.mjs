/* ===========================================================
   terrain-probe（開発用）：farAlbedo と層の重みを世界の点で読み出す
   PTS='x,z;x,z' で点を渡す（既定は空撮の視点の周り）
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { camsInPage } from './terrain-proof.mjs';

export default async function (h) {
  await h.open(`lab/terrain.html?capture=1&tier=${process.env.TIER || 'high'}&chart=0`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const cams = await h.eval(camsInPage);
  const out = await h.eval(({ pts, cam, line }) => {
    const L = window.__lab, g = L.gfx, m = g.modules.get('terrain'), ctx = m.ctx, T = ctx.THREE;
    let P = pts;
    if (!P.length) {
      const [x0, , z0] = cam.target;
      P = [];
      if (line) for (let k = 0; k < 64; k++) P.push([x0 + line[0] * k, z0 + line[1] * k]);
      else for (let k = -4; k <= 4; k++) for (let q = -4; q <= 4; q++) P.push([x0 + k * 25, z0 + q * 25]);
    }
    const n = P.length;
    /* 1 行 n 画素の RT に、点ごとの farAlbedo と 8 層の重み（2 画素目以降の行）を書く */
    const rt = ctx.forge.target(n, 4, { type: T.FloatType, filter: 'nearest', wrap: 'clamp' });
    const xs = new Float32Array(64 * 2);
    P.slice(0, 64).forEach((p, i) => { xs[i * 2] = p[0]; xs[i * 2 + 1] = p[1]; });
    const frag = ctx.services.terrain.coverRules + `
uniform sampler2D ngFarT;
uniform vec2 ngPts[64];
uniform vec4 ngDockP;
void main() {
  int i = int(gl_FragCoord.x), row = int(gl_FragCoord.y);
  vec2 xz = ngPts[i];
  vec4 wA, wB;
  vec3 Ng = ngTerrainN(xz);
  ngTerrWeights(vec3(xz.x, ngTerrainH(xz), xz.y), Ng, ngTerrShoreD(xz), ngTerrBed(xz), ngCanopyAt(xz), 0.0, wA, wB);
  if (row == 0) gl_FragColor = textureLod(ngFarT, ngFarMapUV(xz), 0.0);
  else if (row == 1) gl_FragColor = wA;
  else if (row == 2) gl_FragColor = wB;
  else gl_FragColor = vec4(ngCanopyAt(xz), ngTerrShoreD(xz), ngTerrainH(xz));
}`;
    ctx.forge.run(rt, frag, { ...ctx.heightfield.uniforms, ngFarT: { value: m.u.ngTerrFar.value }, ngPts: { value: Array.from({ length: 64 }, (_, i) => new T.Vector2(xs[i * 2], xs[i * 2 + 1])) } });
    const buf = new Float32Array(n * 4 * 4);
    L.renderer.readRenderTargetPixels(rt, 0, 0, n, 4, buf);
    rt.dispose();
    const r = [];
    for (let i = 0; i < Math.min(n, 64); i++) {
      const f = (k) => +buf[(k * n + i) * 4].toFixed(3);
      const row = (k) => Array.from(buf.subarray((k * n + i) * 4, (k * n + i) * 4 + 4)).map((v) => +v.toFixed(2));
      r.push({ p: P[i].map((v) => +v.toFixed(1)), far: row(0).map((v, j) => (j < 3 ? +v.toFixed(3) : v)), w: [...row(1), ...row(2)], cn: row(3), f: f(0) });
    }
    return r;
  }, { pts: (process.env.PTS || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number)), cam: cams[process.env.CAM || 'air200'], line: process.env.LINE ? process.env.LINE.split(',').map(Number) : null });
  for (const o of out) console.log(JSON.stringify(o.p), 'far', JSON.stringify(o.far), 'w', JSON.stringify(o.w), 'cn/sd/y', JSON.stringify(o.cn));
  fs.writeFileSync(path.join(h.out, 'probe.json'), JSON.stringify(out, null, 1));
}
