/* ===========================================================
   terrain のグレーボックス（本番の代替も兼ねる）
   -----------------------------------------------------------
   - 幾何：near ±260m @1m の格子と、far ±512m @4m の外周（中央 ±260m は抜く）。
     頂点の高さは VS で ngTerrainH（R32F の手動バイリニア）＝ lake.heightAt の格子と同じ値
   - 色：傾斜・汀線距離・底質（ngBedMap = lake.bedAt）・樹冠から。palette の範囲の線形アルベド。
     汀の濡れ帯と雨の濡れ（ngWet）。湖底は caustics と下向き光（媒質が付ける）
   - 遠景：512〜3000m のリング（FAR 層）。far の縁の高さから値ノイズの尾根へつなぐ。空気遠近は媒質
   - 影：depth: true（影マップにも同じ変位）。高さ場影は hfShadow
   =========================================================== */
import { NgModule } from '../module.js';
import { NG_LAYER, ngOwn } from '../layers.js';
import { ngExtendStandard, ngAttachDepth } from '../extend.js';
import { NG_HEIGHTFIELD_GLSL } from '../glsl/heightfield.glsl.js';
import { NG_SURFACE_GLSL } from '../glsl/surface.glsl.js';
import { vnoise } from '../wind.js';

const GROUND_GLSL = NG_HEIGHTFIELD_GLSL + NG_SURFACE_GLSL + /* glsl */ `
float ngTerrRough = 0.9;
vec3 ngStubGround(vec3 P) {
  vec2 xz = P.xz;
  vec3 n = ngTerrainN(xz);
  float slope = sqrt(max(1.0 - n.y * n.y, 0.0)) / max(n.y, 0.05);
  float sd = ngShoreD(xz);
  vec4 bed = ngBed(xz);
  vec2 cn = ngCanopyAt(xz);
  float m1 = ngVNoise2(xz * 0.035), m2 = ngVNoise2(xz * 0.21 + 3.1), m3 = ngVNoise2(xz * 1.7 + 9.4);
  vec3 grass = mix(vec3(0.070, 0.115, 0.032), vec3(0.115, 0.150, 0.048), m1) * (0.85 + 0.3 * m3);
  vec3 litter = vec3(0.105, 0.080, 0.050) * (0.85 + 0.3 * m2);
  vec3 rock = vec3(0.205, 0.195, 0.180) * (0.8 + 0.4 * m3);
  vec3 sand = vec3(0.300, 0.270, 0.215) * (0.9 + 0.2 * m2);
  vec3 mud = vec3(0.120, 0.105, 0.085);
  vec3 land = mix(grass, litter, smoothstep(0.15, 0.55, cn.x));
  land = mix(land, rock, smoothstep(0.55, 0.9, slope + (m2 - 0.5) * 0.3));
  land = mix(sand, land, smoothstep(1.0, 4.0, sd + m2 * 2.0));
  vec3 under = (bed.r * mud + bed.g * sand + bed.b * rock) / max(bed.r + bed.g + bed.b, 1e-3);
  vec3 c = mix(under, land, smoothstep(-0.3, 0.3, sd));
  /* 汀の濡れ帯（遡上ぶん）と雨の濡れ。水中の底はそのまま（深さの色は媒質） */
  float wetBand = (1.0 - smoothstep(0.1, 1.4, sd)) * step(-0.3, sd);
  float wet = max(wetBand, ngWet * 0.85 * step(0.0, sd));
  float r = 0.92;
  ngWetSurface(c, r, 0.8, wet);
  ngTerrRough = sd < -0.3 ? 0.85 : r;
  return c;
}
`;

/**
 * グレーボックスの terrain
 */
export class TerrainStub extends NgModule {
  static id = 'terrain';

  constructor(ctx) {
    super(ctx);
    this.meshes = [];
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE, hf = ctx.heightfield;
    if (!hf?.ready) { progress?.(1); return; }
    const mat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }), {
      key: 'terrain-stub', module: 'terrain', uniforms: hf.uniforms,
      vertex: {
        pars: NG_HEIGHTFIELD_GLSL,
        normal: 'objectNormal = ngTerrainN( position.xz );',
        begin: 'transformed.y = ngTerrainH( position.xz );',
      },
      fragment: {
        pars: GROUND_GLSL,
        surface: 'diffuseColor.rgb = ngStubGround( vNgWorld );',
        normal: 'normal = normalize( ( viewMatrix * vec4( ngTerrainN( vNgWorld.xz ), 0.0 ) ).xyz );',
        rough: 'roughnessFactor = ngTerrRough;',
      },
      caustics: true, hfShadow: true, depth: true,
    });
    this.material = mat;
    const near = gridGeometry(T, -260, 260, 1, null);
    const far = gridGeometry(T, -512, 512, 4, 260);
    for (const [g, name] of [[near, 'ng-terrain-near'], [far, 'ng-terrain-far']]) {
      const m = ngAttachDepth(new T.Mesh(g, mat));
      m.name = name;
      m.castShadow = true;
      m.receiveShadow = true;
      this.root.add(m);
      this.meshes.push(m);
    }
    ngOwn(this.root, NG_LAYER.WORLD);
    const ring = this._ridgeRing(hf);
    ngOwn(ring, NG_LAYER.FAR);
    this.root.add(ring);
    ctx.scene.add(this.root);
    progress?.(1);
  }

  /* 遠景の尾根：far の縁（512m）から 3km まで。高さは CPU で焼く（静的） */
  _ridgeRing(hf) {
    const T = this.ctx.THREE;
    const NA = 256, radii = [510, 560, 650, 780, 950, 1200, 1500, 1900, 2400, 3000];
    const pos = [], col = [], idx = [];
    for (let j = 0; j < radii.length; j++) {
      const r = radii[j];
      for (let i = 0; i <= NA; i++) {
        const a = (i / NA) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
        const edge = hf.heightAt(Math.cos(a) * 511, Math.sin(a) * 511);
        const u = i / NA * 24;
        const ridge = 70 + 330 * Math.pow(1 - Math.abs(vnoise(u, r / 700) * 2 - 1), 2) + 90 * vnoise(u * 3.1, r / 300);
        const k = smooth(512, 1100, r);
        const y = edge + (ridge * (0.55 + 0.45 * smooth(900, 2600, r)) - edge) * k;
        pos.push(x, y, z);
        const rockT = smooth(160, 360, y);
        col.push(0.035 + 0.14 * rockT, 0.050 + 0.12 * rockT, 0.030 + 0.12 * rockT);
      }
    }
    for (let j = 0; j < radii.length - 1; j++) {
      for (let i = 0; i < NA; i++) {
        const a = j * (NA + 1) + i, b = a + 1, c = a + NA + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new T.Mesh(g, new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    m.name = 'ng-terrain-ridges';
    m.receiveShadow = true;
    return m;
  }

  stats() {
    let tris = 0;
    for (const m of this.meshes) tris += m.geometry.index.count / 3;
    return { draws: this.meshes.length + 1, tris, instances: 0, texBytes: 0, programs: 2 };
  }
}

/* xz の正方格子（y = 0。VS が高さを入れる）。hole があれば ±hole の内側を抜く */
function gridGeometry(T, lo, hi, step, hole) {
  const n = Math.round((hi - lo) / step);
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let p = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) { pos[p++] = lo + i * step; pos[p++] = 0; pos[p++] = lo + j * step; }
  }
  const idx = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (hole) {
        const cx = lo + (i + 0.5) * step, cz = lo + (j + 0.5) * step;
        if (Math.abs(cx) < hole && Math.abs(cz) < hole) continue;
      }
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.BufferAttribute(new Float32Array(pos.length).fill(0).map((v, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.boundingBox = new T.Box3(new T.Vector3(lo, -40, lo), new T.Vector3(hi, 400, hi));
  g.boundingSphere = new T.Sphere(new T.Vector3(0, 0, 0), Math.hypot(hi - lo, 400) * 0.75);
  return g;
}

function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** @param {object} ctx */
export function createModule(ctx) { return new TerrainStub(ctx); }
