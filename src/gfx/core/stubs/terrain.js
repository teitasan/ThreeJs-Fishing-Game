/* ===========================================================
   terrain のグレーボックス（本番の代替も兼ねる）
   -----------------------------------------------------------
   - 幾何：±512m を 32m の区画に割り、区画ごとにカメラからの距離で 4 段の細かさ（1/2/4/8m）を選ぶ
     （段ごとに 1 枚のパッチを InstancedMesh で並べる。継ぎ目の T 字の隙間は区画の縁の «スカート» で隠す）。
     細かい三角形を遠くに並べない（画素より小さい三角形は quad の無駄な陰影で GPU を食う）ため。
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

/** 区画の一辺（m）と、±EXTENT を覆う区画の数 */
const PATCH = 32, EXTENT = 512, CHUNKS = (2 * EXTENT) / PATCH;
/** 段の格子の間隔（m）と、段を切り替える距離（m。品質と LOD 倍率で縮める） */
const LOD_STEPS = [1, 2, 4, 8];
const LOD_RANGES = [64, 160, 320];
const RANGE_K = { low: 0.6, mid: 0.75, high: 1.0 };

/* 区画のローカル座標 → 世界の xz（インスタンスの平行移動だけ） */
const TERRAIN_BEGIN = /* glsl */ `
#ifdef USE_INSTANCING
  vec2 ngXZ = position.xz + instanceMatrix[3].xz;
#else
  vec2 ngXZ = position.xz;
#endif
  transformed.y = ngTerrainH( ngXZ ) - aSkirt;
`;
const TERRAIN_NORMAL = /* glsl */ `
#ifdef USE_INSTANCING
  objectNormal = ngTerrainN( position.xz + instanceMatrix[3].xz );
#else
  objectNormal = ngTerrainN( position.xz );
#endif
`;

const GROUND_GLSL = NG_HEIGHTFIELD_GLSL + NG_SURFACE_GLSL + /* glsl */ `
float ngTerrRough = 0.9;
vec3 ngTerrNrm = vec3(0.0, 1.0, 0.0);   // 色を決めるときに読んだ法線（normal の口で使い回す）
vec3 ngStubGround(vec3 P) {
  vec2 xz = P.xz;
  vec3 n = ngTerrainN(xz);
  ngTerrNrm = n;
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
    this.lods = null;
    this._tierK = RANGE_K[ctx.tier] ?? 1;
    this._lodK = 1;
    this._range = this._tierK;
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE, hf = ctx.heightfield;
    if (!hf?.ready) { progress?.(1); return; }
    const mat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }), {
      key: 'terrain-stub', module: 'terrain', uniforms: hf.uniforms,
      vertex: {
        pars: NG_HEIGHTFIELD_GLSL + 'attribute float aSkirt;\n',
        normal: TERRAIN_NORMAL,
        begin: TERRAIN_BEGIN,
      },
      fragment: {
        pars: GROUND_GLSL,
        surface: 'diffuseColor.rgb = ngStubGround( vNgWorld );',
        normal: 'normal = normalize( ( viewMatrix * vec4( ngTerrNrm, 0.0 ) ).xyz );',
        rough: 'roughnessFactor = ngTerrRough;',
      },
      caustics: true, hfShadow: true, depth: true,
    });
    this.material = mat;
    /* 段ごとのパッチ（区画のローカル 0..PATCH）。1 段に最大で全区画ぶんのインスタンス */
    this.lods = LOD_STEPS.map((step, i) => {
      const im = new T.InstancedMesh(patchGeometry(T, step), mat, CHUNKS * CHUNKS);
      im.name = `ng-terrain-lod${i}`;
      im.count = 0;
      im.frustumCulled = false;             // 区画は毎フレーム選び直す。影・反射のカメラでも同じ集合
      im.castShadow = true;
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(T.DynamicDrawUsage);
      ngAttachDepth(im);
      this.root.add(im);
      this.meshes.push(im);
      return im;
    });
    this._m4 = new T.Matrix4();
    this._lastKey = '';
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

  /* 区画の細かさを選び直す（カメラが区画の 1/4 動くか、LOD 倍率・品質が変わったときだけ） */
  update(f) {
    const c = f.camera?.position;
    if (!this.lods || !c) return;
    const q = PATCH / 4;
    const key = `${Math.round(c.x / q)},${Math.round(c.z / q)},${this._range}`;
    if (key === this._lastKey) return;
    this._lastKey = key;
    for (const im of this.lods) im.count = 0;
    const m = this._m4, r = this._range;
    for (let j = 0; j < CHUNKS; j++) {
      for (let i = 0; i < CHUNKS; i++) {
        const x0 = -EXTENT + i * PATCH, z0 = -EXTENT + j * PATCH;
        /* 区画の中でカメラに一番近い点までの距離 */
        const dx = Math.max(x0 - c.x, 0, c.x - x0 - PATCH), dz = Math.max(z0 - c.z, 0, c.z - z0 - PATCH);
        const d = Math.hypot(dx, dz);
        const lod = d < LOD_RANGES[0] * r ? 0 : d < LOD_RANGES[1] * r ? 1 : d < LOD_RANGES[2] * r ? 2 : 3;
        const im = this.lods[lod];
        m.makeTranslation(x0, 0, z0);
        im.setMatrixAt(im.count++, m);
      }
    }
    for (const im of this.lods) im.instanceMatrix.needsUpdate = true;
  }

  setQuality(tier) { this._tierK = RANGE_K[tier] ?? 1; this._range = this._tierK * this._lodK; this._lastKey = ''; }

  setLodScale(k) { this._lodK = Number.isFinite(k) && k > 0 ? k : 1; this._range = this._tierK * this._lodK; this._lastKey = ''; }

  stats() {
    let tris = 0, inst = 0;
    for (const m of this.meshes) { tris += (m.geometry.index.count / 3) * m.count; inst += m.count; }
    return { draws: this.meshes.length + 1, tris, instances: inst, texBytes: 0, programs: 2 };
  }
}

/* 区画のパッチ：0..PATCH の正方格子 + 縁のスカート（aSkirt = 下げる量 m）。
   法線は VS が高さ場から入れるので上向きの仮の値 */
function patchGeometry(T, step) {
  const n = Math.round(PATCH / step);
  const pos = [], skirt = [], idx = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) { pos.push(i * step, 0, j * step); skirt.push(0); }
  }
  const at = (i, j) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = at(i, j), b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  /* 縁を一周して、各辺の外側に垂れ幕を下ろす（隣の区画が粗くても隙間が見えない） */
  const ring = [];
  for (let i = 0; i < n; i++) ring.push(at(i, 0));
  for (let j = 0; j < n; j++) ring.push(at(n, j));
  for (let i = n; i > 0; i--) ring.push(at(i, n));
  for (let j = n; j > 0; j--) ring.push(at(0, j));
  const base = pos.length / 3;
  for (const v of ring) { pos.push(pos[v * 3], 0, pos[v * 3 + 2]); skirt.push(step * 1.5 + 0.5); }
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length], a2 = base + k, b2 = base + ((k + 1) % ring.length);
    idx.push(a, a2, b, b, a2, b2);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.Float32BufferAttribute(pos.map((v, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('aSkirt', new T.Float32BufferAttribute(skirt, 1));
  g.setIndex(idx);
  return g;
}

function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** @param {object} ctx */
export function createModule(ctx) { return new TerrainStub(ctx); }
