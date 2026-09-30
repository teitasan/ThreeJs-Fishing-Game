/* ===========================================================
   core の GLSL ライブラリの重さ（全画面 1 回ぶんの GPU ms）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/core-glsl-cost.mjs --size 2560x1440 --out DIR
   lab/core.html の実物の uniforms（高さ場・影・caustics・ngFrame）で、関数を 1 つだけ呼ぶ
   全画面の断片シェーダを RGBA16F に 10 回描き、1×1 の readPixels で挟んだ実時間を測る。
   «何もしない» 版との差がその関数の «画面を 1 回覆ったときの» 重さ。
   モジュールの担当者が予算を見積もるための表（docs/nextgen/spikes.md S-3）。結果は DIR/glsl-cost.json
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

/* 名前 → 断片の式（vec4）。P は画面を 300m 四方の湖畔へ写した点、N は上向き */
const VARIANTS = {
  base: 'vec4(P, 1.0)',
  medium: 'vec4(ngApplyMedium(vec3(0.5), P), 1.0)',
  mediumUnder: 'vec4(ngApplyMedium(vec3(0.5), P - vec3(0.0, 2.0, 0.0)), 1.0)',
  cloudShadow: 'vec4(ngCloudShadow(P))',
  terrainH: 'vec4(ngTerrainH(P.xz))',
  terrainN: 'vec4(ngTerrainN(P.xz), 1.0)',
  maps4: 'vec4(ngShoreD(P.xz), ngBed(P.xz).x, ngCanopyAt(P.xz).x, ngCover(P.xz).x)',
  hfShadow: 'vec4(ngHfShadow(P))',
  sunVisibility: 'vec4(ngSunVisibility(P, 1.0))',
  windAt: 'ngWindAt(P.xz)',
  waveHD: 'vec4(ngWaveH(P.xz, ngWaterTime), ngWaveD(P.xz, ngWaterTime), 1.0)',
  rainRings: 'vec4(ngRainRings(P.xz, ngEnvTime, 1.0), 0.0, 1.0)',
  caustics: 'vec4(causticLight(vec3(P.x, -1.5, P.z), N), 1.0)',
  fbm3: 'vec4(ngFbm(P.xz * 0.3, 3))',
  worley2: 'vec4(ngWorley2(P.xz * 0.3), 1.0)',
  skySpecular: 'vec4(ngSkySpecular(normalize(vec3(P.x, 40.0, P.z)), 0.2), 1.0)',
};

export default async function (h) {
  await h.open('lab/core.html?capture=1&chart=0&tier=high');
  await h.waitFor(() => window.__gfxReady === true, undefined, 180);
  const res = await h.eval((VARIANTS) => {
    const L = window.__lab, g = L.gfx, T = g.THREE, r = L.renderer;
    L.cam('dock-3p'); L.setHour(12); L.freeze(10); L.tick(5);
    for (const m of g.modules.values()) m.root.visible = false;
    const { NG_FRAME_GLSL, NG_MEDIUM_GLSL, NG_HEIGHTFIELD_GLSL, NG_SHADOW_GLSL, NG_WIND_GLSL, NG_SKYSPEC_GLSL, CAUSTICS_GLSL, waveGLSL } = L.glsl;
    const size = r.getDrawingBufferSize(new T.Vector2());
    const rt = new T.WebGLRenderTarget(size.x, size.y, { type: T.HalfFloatType, depthBuffer: false });
    g.caustics.uCaustStrength.value = 1;
    const scene = new T.Scene(), tri = new T.BufferGeometry();
    tri.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mesh = new T.Mesh(tri);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const libs = NG_FRAME_GLSL + NG_MEDIUM_GLSL + NG_HEIGHTFIELD_GLSL + NG_SHADOW_GLSL + NG_WIND_GLSL + NG_SKYSPEC_GLSL
      + waveGLSL({ prefix: 'ng' }) + CAUSTICS_GLSL;
    const uniforms = {
      ...g.heightfield.uniforms, ...g.shadows.uniforms, ...g.caustics, ngFrame: { value: g.frame.data },
      ngSkyViewTex: { value: g.services.sky.skyViewTex }, ngSkyViewMips: { value: 0 }, uRes: { value: size.clone() },
    };
    const sync = g._gpuSync;
    const out = {};
    for (const [name, expr] of Object.entries(VARIANTS)) {
      mesh.material = new T.ShaderMaterial({
        uniforms, depthTest: false, depthWrite: false,
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `#define NG_FRAME\n${libs}\nuniform vec2 uRes;\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / uRes;\n  vec3 P = vec3((uv.x - 0.5) * 300.0, 0.5, (uv.y - 0.5) * 300.0);\n  vec3 N = vec3(0.0, 1.0, 0.0);\n  gl_FragColor = ${expr};\n}`,
      });
      r.setRenderTarget(rt);
      for (let i = 0; i < 3; i++) r.render(scene, L.camera);
      const t = [];
      for (let w = 0; w < 5; w++) {
        sync();
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) r.render(scene, L.camera);
        sync();
        t.push((performance.now() - t0) / 10);
      }
      r.setRenderTarget(null);
      t.sort((a, b) => a - b);
      out[name] = t[0];
      mesh.material.dispose();
    }
    rt.dispose();
    for (const m of g.modules.values()) m.root.visible = true;
    const base = out.base;
    return { size: [size.x, size.y], raw: out, cost: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.max(0, v - base)])) };
  }, VARIANTS);
  fs.writeFileSync(path.join(h.out, 'glsl-cost.json'), JSON.stringify(res, null, 1));
  console.log(`size ${res.size.join('x')}  base ${res.raw.base.toFixed(2)}ms（全画面 1 回の書き込み）`);
  for (const [k, v] of Object.entries(res.cost)) if (k !== 'base') console.log(`  ${k.padEnd(14)} +${v.toFixed(2)}ms`);
}
