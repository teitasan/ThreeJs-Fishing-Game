/* ===========================================================
   groundcover（下草）— ARCHITECTURE §6.6
   -----------------------------------------------------------
   1. 計算パス（clump.glsl.js）：カメラ中心のリング格子のセル 1 つ = 株 1 つ。prepare で全画面 1 回、
      株ごとの位置・種類・根元の色・風・踏み倒し・山の影を RGBA32F の表へ
   2. 描画（cover.glsl.js）：型板の幾何 + gl_InstanceID → 表を texelFetch（頂点の属性・インスタンスの属性なし）。
      近い草（8 枚 × 5 節）・遠い草（6 枚 × 3 節、太く）・クマザサとシダ・小物（小石・落ち枝・苔・落葉）の 4 描画、1 プログラム
   3. 藪（shrub.js）：placement.thicket の位置に低木（影を落とす、反射に写さない）
   すべて NO_REFLECT（藪は + SHADOW_ONLY）。近景の影を受ける。Math.random なし
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { ngExtendStandard, ngShaderMaterial, ngAttachDepth, ngCutout } from '../core/extend.js';
import { GC_QUALITY, GC_TEX_W, GC_TPL, gcLayout, gcWindow } from './quality.js';
import { GC_CLUMP_VS, gcClumpFS, gcWeightsGLSL, GC_MAX_REGIONS, GC_TRAMPLE_N } from './clump.glsl.js';
import {
  GC_TPL_ID, GC_VS_PARS, GC_VS_NORMAL, GC_VS_BEGIN, GC_FS_PARS, GC_FS_SURFACE, GC_FS_ALPHA, GC_FS_ROUGH, GC_FS_LIGHTS, GC_FS_AO,
} from './cover.glsl.js';
import {
  SHRUB_LEAF_FRAG, buildShrubGeometry, SHRUB_VS_PARS, SHRUB_VS_BEGIN, SHRUB_FS_PARS, SHRUB_FS_SURFACE, SHRUB_FS_ROUGH,
  SHRUB_FS_LIGHTS, SHRUB_FS_AO,
} from './shrub.js';

const ID = 'groundcover';
/* 藪を描く距離（m、LOD 倍率を掛ける）と 1 株の葉のカードの枚数 */
const SHRUB_RANGE = { low: 70, mid: 110, high: 150 };
const SHRUB_CARDS = 64;

/** 草・葉の型板：刃 b × 節 k × 横 ±1。position = (b, t, ±1) */
function bladeTemplate(T, blades, nodes) {
  const pos = [], idx = [];
  for (let b = 0; b < blades; b++) {
    const o = pos.length / 3;
    for (let k = 0; k < nodes; k++) {
      const t = k / (nodes - 1);
      pos.push(b, t, -1, b, t, 1);
    }
    for (let k = 0; k < nodes - 1; k++) {
      const a = o + 2 * k;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new T.InstancedBufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.instanceCount = 0;
  return g;
}

/** 小物の型板：単位球（8 × 5） */
function sphereTemplate(T) {
  const s = new T.SphereGeometry(1, 8, 5);
  const g = new T.InstancedBufferGeometry();
  g.setAttribute('position', s.getAttribute('position'));
  g.setIndex(s.getIndex());
  g.instanceCount = 0;
  s.dispose();
  return g;
}

export class GroundcoverModule extends NgModule {
  static id = ID;

  constructor(ctx) {
    super(ctx);
    const T = ctx.THREE;
    this.tier = ctx.tier || 'high';
    this.profile = ctx.profile || null;
    this.lod = 1;
    this.layout = gcLayout(this.tier);
    this.draws = [];
    this.shrubs = [];
    this.rt = null;
    this._trample = Array.from({ length: GC_TRAMPLE_N }, () => new T.Vector4(0, 0, 0.45, 0));
    this._trHead = 0;
    this._trLast = null;
    this._frustum = new T.Frustum();
    this._m4 = new T.Matrix4();
    this._v3 = new T.Vector3();
    this._shrubAt = null;
    this._shrubTier = null;
    this.debug = { windows: [], instances: 0, shrubs: 0, weightsMode: '' };
    const v4 = () => Array.from({ length: GC_MAX_REGIONS }, () => new T.Vector4());
    this.cu = {
      ngGcFarAlb: { value: null },
      ngGcReg: { value: v4() }, ngGcReg2: { value: v4() }, ngGcReg3: { value: v4() }, ngGcReg4: { value: v4() },
      ngGcNReg: { value: 0 },
      ngGcCam: { value: new T.Vector3() },
      ngGcPlanes: { value: Array.from({ length: 6 }, () => new T.Vector4(0, 0, 0, 1e6)) },
      ngGcTrample: { value: this._trample },
      ngGcLod: { value: 1 },
    };
    this.shared = { ngGcData: { value: null }, ngGcLook: { value: new T.Vector4(1, 0.25, 1, 0) } };
  }

  async init(progress) {
    const { THREE: T, renderer, heightfield, shadows, services, forge, placement } = this.ctx;
    if (!heightfield) throw new Error('groundcover: heightfield が無い');
    const gl = renderer.getContext();
    if (!(renderer.capabilities?.isWebGL2) || !renderer.extensions.has('EXT_color_buffer_float')) {
      throw new Error('groundcover: RGBA32F の描画先が無い（EXT_color_buffer_float）');
    }
    void gl;
    /* 1. 計算パスの RT（全段の最大の行数で 1 回だけ確保） */
    const rows = Math.max(...['low', 'mid', 'high'].map((t) => gcLayout(t).rows));
    this.rt = new T.WebGLRenderTarget(GC_TEX_W * 3, rows, {
      type: T.FloatType, format: T.RGBAFormat, minFilter: T.NearestFilter, magFilter: T.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.rt.texture.name = 'ng-gc-clumps';
    this.shared.ngGcData.value = this.rt.texture;
    const cover = services.terrain.coverRules;
    const W = gcWeightsGLSL(cover);
    this.debug.weightsMode = W.mode;
    this.cu.ngGcFarAlb.value = services.terrain.farAlbedoTex;
    this.clumpMat = ngShaderMaterial({
      key: 'gc-clump', module: ID, lights: false, fog: false,
      uniforms: { ...heightfield.uniforms, ...shadows.uniforms, ...this.cu },
      vertexShader: GC_CLUMP_VS, fragmentShader: gcClumpFS(W.glsl),
      depthTest: false, depthWrite: false,
    });
    this.quadScene = new T.Scene();
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2), this.clumpMat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
    this.quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    await forge.step();
    progress?.(0.2);

    /* 2. 描画の 4 本（1 プログラム。uniform の ngGcDraw だけ違う） */
    const tpl = [
      ['grass0', bladeTemplate(T, GC_TPL.near.blades, GC_TPL.near.nodes), GC_TPL_ID.near, GC_TPL.near.blades, 1.0],
      ['grass1', bladeTemplate(T, GC_TPL.far.blades, GC_TPL.far.nodes), GC_TPL_ID.far, GC_TPL.far.blades, 1.0],
      ['plants', bladeTemplate(T, GC_TPL.plant.leaves, GC_TPL.plant.nodes), GC_TPL_ID.plant, GC_TPL.plant.leaves, 1.0],
      ['debris', sphereTemplate(T), GC_TPL_ID.debris, 1, 1.0],
    ];
    for (const [name, geo, tid, nb, wm] of tpl) {
      const draw = { value: new T.Vector4(0, tid, nb, wm) };
      const mat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.7, metalness: 0, side: T.DoubleSide }), {
        key: 'gc-cover', module: ID,
        uniforms: { ngGcData: this.shared.ngGcData, ngGcLook: this.shared.ngGcLook, ngGcDraw: draw },
        vertex: { pars: GC_VS_PARS, normal: GC_VS_NORMAL, begin: GC_VS_BEGIN },
        fragment: { pars: GC_FS_PARS, surface: GC_FS_SURFACE, alpha: GC_FS_ALPHA, rough: GC_FS_ROUGH, lights: GC_FS_LIGHTS, ao: GC_FS_AO },
      });
      const mesh = new T.Mesh(geo, mat);
      mesh.name = `ng-gc-${name}`;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.root.add(mesh);
      this.draws.push({ name, mesh, draw, tris: geo.index.count / 3 });
    }
    progress?.(0.4);

    /* 3. 藪：葉の房のテクスチャ（forge）と 3 形の幾何 */
    this.leafTex = forge.bake2D({ w: 256, h: 256, frag: SHRUB_LEAF_FRAG, mips: true, coverageAlpha: 0.5, wrap: 'clamp', anisotropy: 4 });
    await forge.step();
    const seed = placement?.seed ?? this.ctx.lake?.seed ?? 1;
    this.shrubMat = ngExtendStandard(new T.MeshStandardMaterial({ map: this.leafTex, roughness: 0.6, metalness: 0, side: T.DoubleSide, alphaTest: 0.5 }), {
      key: 'gc-shrub', module: ID,
      vertex: { pars: SHRUB_VS_PARS, begin: SHRUB_VS_BEGIN },
      fragment: { pars: SHRUB_FS_PARS, surface: SHRUB_FS_SURFACE, rough: SHRUB_FS_ROUGH, lights: SHRUB_FS_LIGHTS, ao: SHRUB_FS_AO },
      depth: true,
    });
    const list = (placement?.thicket || []).filter((t) => Number.isFinite(t.x) && Number.isFinite(t.z));
    this._shrubList = list.map((t) => ({
      x: t.x, z: t.z, y: heightfield.heightAt(t.x, t.z) - 0.06, h: Math.max(1.2, t.height || 1.5), rot: t.rot || 0,
      v: (t.variant | 0) % 3, s: (t.r || 0.55) * 1.1,
    }));
    for (let v = 0; v < 3; v++) {
      const geo = buildShrubGeometry(T, seed, v, SHRUB_CARDS);
      const n = Math.max(1, this._shrubList.filter((s) => s.v === v).length);
      const mesh = new T.InstancedMesh(geo, this.shrubMat, n);
      mesh.count = 0;
      mesh.name = `ng-gc-shrub${v}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      ngAttachDepth(mesh);
      this.shrubs.push(mesh);
      this.root.add(mesh);
      await forge.step();
    }
    progress?.(0.8);

    ngOwn(this.root, NG_LAYER.NO_REFLECT);
    for (const m of this.shrubs) ngOwn(m, NG_LAYER.NO_REFLECT, NG_LAYER.SHADOW_ONLY);
    this._applyTier(this.tier, this.profile);
    this.ctx.scene.add(this.root);
    progress?.(1);
  }

  /* 段の表 → 計算パスの uniform */
  _applyTier(tier, profile) {
    this.tier = GC_QUALITY[tier] ? tier : 'high';
    this.layout = gcLayout(this.tier);
    const L = this.layout.regions;
    const u = this.cu;
    u.ngGcNReg.value = L.length;
    for (let i = 0; i < GC_MAX_REGIONS; i++) {
      const r = L[i];
      if (!r) { u.ngGcReg.value[i].set(-1, 0, 1, 1); continue; }
      /* 遠い草の内の帯 = 近い草の外の帯（同じ距離で縮み合う） */
      const inner = r.r0 > 0 ? Math.max(0.5, (L.find((o) => o.sys === r.sys && o.r0 === 0)?.r1 ?? r.r0) - r.r0) : 0;
      u.ngGcReg.value[i].set(r.row0, r.rows, r.c, r.n);
      u.ngGcReg2.value[i].set(r.r0, r.r1, r.fade, inner);
      u.ngGcReg3.value[i].set(r.sys, r.density ?? 1, r.tpl === 'far' ? 1 : 0, 0);
      u.ngGcReg4.value[i].set(0, 0, 2 * r.n, 2 * r.n);
      const d = this.draws[i];
      if (d) d.draw.value.x = r.row0;
    }
    if (profile) this.profile = profile;
    for (const d of this.draws) ngCutout(d.mesh.material, this.profile, 0.5);
    if (this.shrubMat) ngCutout(this.shrubMat, this.profile, 0.5);
    for (const m of this.shrubs) ngAttachDepth(m);
    this._shrubAt = null;
  }

  update(f) {
    /* 踏み倒し：注視点（釣り人）が 0.35m 動くたびに足跡を 1 つ。4 秒で起き上がる */
    const dt = Number.isFinite(f.dt) ? f.dt : 0;
    for (const t of this._trample) t.w = Math.max(0, t.w - dt / 4);
    const p = f.focus;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      const last = this._trLast;
      if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.35) {
        const t = this._trample[this._trHead];
        this._trHead = (this._trHead + 1) % GC_TRAMPLE_N;
        t.set(p.x, p.z, 0.5, 1);
        this._trLast = { x: p.x, z: p.z };
      }
    }
  }

  prepare(f) {
    const cam = f.camera;
    if (!cam || !this.rt) return;
    const { renderer, services } = this.ctx;
    cam.updateMatrixWorld();
    const u = this.cu;
    u.ngGcFarAlb.value = services.terrain.farAlbedoTex;
    u.ngGcLod.value = this.lod;
    u.ngGcCam.value.copy(cam.position);
    this._frustum.setFromProjectionMatrix(this._m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    this._frustum.planes.forEach((pl, i) => u.ngGcPlanes.value[i].set(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant));
    /* 窓：視錐台を r1 で切った 8 隅の xz の外接矩形 */
    let inst = 0;
    this.debug.windows.length = 0;
    this.layout.regions.forEach((r, i) => {
      const w = gcWindow(cam, r.c, r.n, r.r1 * this.lod + 1.5, 1.5);
      u.ngGcReg4.value[i].set(w.ox, w.oz, w.w, w.h);
      const d = this.draws[i];
      if (d) d.mesh.geometry.instanceCount = w.w * w.h;
      inst += w.w * w.h;
      this.debug.windows.push([w.w, w.h]);
    });
    this.debug.instances = inst;
    /* 季節の枯れ（初夏 0.42 → 先が少し枯れる）。雨は ngWet が濡らす */
    const F = this.ctx.frame?.data;
    const season = F ? F[12 * 4 + 3] : 0.42;
    this.shared.ngGcLook.value.set(1, Math.max(0, Math.min(1, 0.15 + 0.6 * Math.max(0, season - 0.55))), 1, 0);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(prev);
    this._updateShrubs(cam.position);
  }

  /* 藪：カメラから SHRUB_RANGE 以内だけを詰める（4m 動くか段が変わったら） */
  _updateShrubs(cp) {
    const at = this._shrubAt;
    if (at && this._shrubTier === this.tier && Math.hypot(cp.x - at.x, cp.z - at.z) < 4) return;
    this._shrubAt = { x: cp.x, z: cp.z };
    this._shrubTier = this.tier;
    const T = this.ctx.THREE, m = this._m4, q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), up = new T.Vector3(0, 1, 0);
    const R = (SHRUB_RANGE[this.tier] || 150) * this.lod;
    const n = [0, 0, 0];
    let total = 0;
    for (const sh of this._shrubList) {
      if (Math.hypot(sh.x - cp.x, sh.z - cp.z) > R) continue;
      const mesh = this.shrubs[sh.v];
      if (!mesh || n[sh.v] >= mesh.instanceMatrix.count) continue;
      q.setFromAxisAngle(up, sh.rot);
      s.set(sh.s, sh.h, sh.s);
      p.set(sh.x, sh.y, sh.z);
      m.compose(p, q, s);
      mesh.setMatrixAt(n[sh.v]++, m);
      total++;
    }
    this.shrubs.forEach((mesh, v) => { mesh.count = n[v]; mesh.instanceMatrix.needsUpdate = true; });
    this.debug.shrubs = total;
  }

  /**
   * 検査用：計算パスの表を読み、領域ごとの «生きている株の数» と種類の内訳・根元の色の平均を返す（同期の読み戻し。lab 専用）
   * @returns {Array<{name:string, alive:number, kinds:Record<number, number>, root:number[]}>}
   */
  debugCounts() {
    const { renderer } = this.ctx;
    if (!this.rt) return [];
    const W = this.rt.width, H = this.rt.height;
    const buf = new Float32Array(W * H * 4);
    renderer.readRenderTargetPixels(this.rt, 0, 0, W, H, buf);
    return this.layout.regions.map((r, i) => {
      const kinds = {}, root = [0, 0, 0], samples = {};
      let alive = 0;
      const n = (this.draws[i]?.mesh.geometry.instanceCount) || 0;
      for (let k = 0; k < n; k++) {
        const row = r.row0 + Math.floor(k / GC_TEX_W), col = k % GC_TEX_W;
        const a = (row * W + col) * 4, b = (row * W + col + GC_TEX_W) * 4;
        if (!(buf[a + 3] > 0.0005)) continue;
        alive++;
        const kind = Math.floor(buf[b + 3] + 0.01);
        kinds[kind] = (kinds[kind] || 0) + 1;
        if (!samples[kind]) samples[kind] = [+buf[a].toFixed(2), +buf[a + 1].toFixed(2), +buf[a + 2].toFixed(2), +buf[a + 3].toFixed(3)];
        root[0] += buf[b]; root[1] += buf[b + 1]; root[2] += buf[b + 2];
      }
      return { name: this.draws[i]?.name || r.name, alive, kinds, samples, root: root.map((v) => +(v / Math.max(alive, 1)).toFixed(4)) };
    });
  }

  setQuality(tier, profile) { this._applyTier(tier, profile); }

  setLodScale(k) { if (Number.isFinite(k) && k > 0) { this.lod = Math.min(2, Math.max(0.25, k)); this._shrubAt = null; } }

  restoreGPU() {
    try {
      const tex = this.ctx.forge.bake2D({ w: 256, h: 256, frag: SHRUB_LEAF_FRAG, mips: true, coverageAlpha: 0.5, wrap: 'clamp', anisotropy: 4 });
      this.leafTex = tex;
      if (this.shrubMat) { this.shrubMat.map = tex; this.shrubMat.needsUpdate = true; for (const m of this.shrubs) ngAttachDepth(m); }
    } catch (e) { this.ctx.log?.('gc-restore', e); }
  }

  stats() {
    let draws = 0, tris = 0, instances = 0;
    for (const d of this.draws) {
      const n = d.mesh.geometry.instanceCount || 0;
      if (n > 0) { draws++; tris += n * d.tris; instances += n; }
    }
    for (const m of this.shrubs) if (m.count > 0) { draws++; tris += m.count * (m.geometry.index.count / 3); instances += m.count; }
    const texBytes = (this.rt ? this.rt.width * this.rt.height * 16 : 0) + 256 * 256 * 8 * 1.34;
    return { draws, tris, instances, texBytes, programs: 4 };
  }

  dispose() {
    this.rt?.dispose();
    this.clumpMat?.dispose();
    for (const d of this.draws) d.mesh.material.dispose();
    this.shrubMat?.dispose();
    this.quadScene?.traverse((o) => o.geometry?.dispose?.());
    super.dispose();
  }
}

export function createModule(ctx) { return new GroundcoverModule(ctx); }
