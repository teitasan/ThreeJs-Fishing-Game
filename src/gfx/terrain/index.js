/* ===========================================================
   terrain モジュール（ARCHITECTURE §6.4・CORE_API §6.5）
   -----------------------------------------------------------
   - 幾何：CDLOD（根 1024m・葉 16m・7 段、33² / 17² のパッチ 1 枚をインスタンスで）。選択は prepare で 1 回、
     パスごとに視錐台で詰め直す（主・近景の影は同じ選択、反射は LOD を 2 倍粗くした別の選択）。
     頂点の高さは ngTerrainH（R32F の手動バイリニア = heightfield.heightAt）。段 0 の格子は near の 0.5m の格子点そのもの
   - 素材：起動時に forge で焼いた 8 層 × 2 配列（layers.glsl.js）。重み・上位 2 層の高さブレンド・hex・triplanar・
     マクロの色むら・farAlbedo・汀の濡れ帯・雨・水たまりは terrain.glsl.js
   - 遠景：508m から 2.75km の稜線の帯（ridges.js、FAR 層）
   - services.terrain：coverRules（ngGroundKind）・farAlbedoTex
   - 高さ場影は core が焼く（受け手として hfShadow: true）。terrain は焼かない
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { NG_PASS } from '../core/frame.js';
import { ngExtendStandard, ngAttachDepth } from '../core/extend.js';
import { CdlodList, cdlodRanges, cdlodSelect, heightPyramid, nodeHeightRange, CDLOD_MAX_INST, CDLOD_MAX_LEVELS, CDLOD_WALK_R } from './cdlod.js';
import { TERRAIN_R0, terrainTier } from './quality.js';
import { TERRAIN_BAKE_A, TERRAIN_BAKE_B, TERRAIN_BAKE_MACRO, TERRAIN_TILE_M, TERRAIN_RELIEF_M } from './layers.glsl.js';
import {
  TERRAIN_VERT_PARS, TERRAIN_VERT_NORMAL, TERRAIN_VERT_BEGIN, TERRAIN_FRAG_PARS, TERRAIN_FRAG_SURFACE,
  TERRAIN_FRAG_NORMAL, TERRAIN_FRAG_ROUGH, TERRAIN_FRAG_LIGHTS, TERRAIN_FRAG_AO, terrainCoverRules,
} from './terrain.glsl.js';
import { FAR_BAKE, FAR_SIZE, buildCanopyColor } from './farAlbedo.js';
import {
  buildRidgeArraysAsync, RIDGE_HORIZON_BAKE, RIDGE_MAX_ROWS, RIDGE_CLIP, RIDGE_VERT_PARS, RIDGE_VERT_BEGIN, RIDGE_FRAG_PARS, RIDGE_FRAG_SURFACE, RIDGE_FRAG_NORMAL, RIDGE_FRAG_LIGHTS,
} from './ridges.js';

const MACRO_SIZE = 512;
const NODE_MARGIN = 6;

export class TerrainModule extends NgModule {
  static id = 'terrain';

  constructor(ctx) {
    super(ctx);
    this.q = terrainTier(ctx.tier);
    this._lodK = 1;
    this._debug = 0;
    this.list = new CdlodList();
    this.reflList = new CdlodList();
    this._rho = new Float32Array(CDLOD_MAX_LEVELS);
    this._rhoR = new Float32Array(CDLOD_MAX_LEVELS);
    this._morphMain = new Float32Array(32);
    this._morphRefl = new Float32Array(32);
    this._hr = [0, 0];
    this._eye = { x: 0, y: 0, z: 0 };
    this._texSize = 0;
    this._cells = 0;
    this.mesh = null;
    this.ridges = null;
    this._passCounts = { main: 0, refl: 0, shadow: 0 };
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE, hf = ctx.heightfield, lake = ctx.lake;
    if (!hf?.ready) throw new Error('[ng] terrain: heightfield が未構築');
    const t0 = performance.now();
    this.pyr = heightPyramid(hf.grids?.far);
    this._frustum = new T.Frustum();
    this._box = new T.Box3();
    this._m4 = new T.Matrix4();

    /* 踏み跡（桟橋の付け根から内陸へ）と藻場 */
    const dk = lake?.dock;
    const sx = dk?.start?.x ?? 0, sz = dk?.start?.z ?? 0;
    let ix = -(dk?.dir?.x ?? 0), iz = -(dk?.dir?.z ?? 1);
    const il = Math.hypot(ix, iz) || 1; ix /= il; iz /= il;
    this._dock = { start: { x: sx, z: sz }, inland: { x: ix, z: iz } };
    const flats = [0, 1, 2, 3].map((i) => {
      const fl = lake?.flats?.[i];
      return fl && Number.isFinite(fl.x) ? new T.Vector4(fl.x, fl.z, fl.r, fl.main ? 1.0 : 0.8) : new T.Vector4(0, 0, 0, 0);
    });

    const sky = ctx.services.sky;
    this.u = {
      ngTerrA: { value: null }, ngTerrB: { value: null }, ngTerrMacro: { value: null }, ngTerrFar: { value: null },
      ngSkyViewTex: { value: sky.skyViewTex }, ngSkyViewMips: { value: sky.skyViewMips || 0 },
      ngTerrParams: { value: new T.Vector4(this.q.hexMode, this.q.triplanar, this.q.farFrom, 0) },
      ngTerrWave: { value: new T.Vector4(0, 1, 0, 0) },
      ngTerrDock: { value: new T.Vector4(sx, sz, ix, iz) },
      ngTerrFlats: { value: flats },
      ngTerrMorph: { value: this._morphMain },
      ngTerrEye: { value: new T.Vector4(0, 0, 0, this.q.cells) },
      ngTerrClipR: { value: RIDGE_CLIP },
    };

    /* 1. 素材の配列とマクロ、farAlbedo（forge） */
    const P = (this._loadParts = {});
    let tp = performance.now();
    const lap = (k) => { const n = performance.now(); P[k] = +(n - tp).toFixed(1); tp = n; };
    this._canopyCol = buildCanopyColor(T, ctx.placement, (lake?.seed ?? 1) >>> 0);
    lap('canopyCPU');
    await this._bakeLayers(this.q.texSize, true);
    lap('layers');
    progress?.(0.45);
    this._bakeMacro();
    await ctx.forge.step();
    lap('macro');
    this._bakeFar();
    await ctx.forge.step();
    lap('far');
    progress?.(0.6);

    /* 2. 地形の素材とメッシュ */
    const mat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 1, metalness: 0 }), {
      key: 'terrain-ground', module: 'terrain',
      uniforms: { ...hf.uniforms, ...this.u },
      vertex: { pars: TERRAIN_VERT_PARS, normal: TERRAIN_VERT_NORMAL, begin: TERRAIN_VERT_BEGIN },
      fragment: {
        pars: TERRAIN_FRAG_PARS, surface: TERRAIN_FRAG_SURFACE, normal: TERRAIN_FRAG_NORMAL,
        rough: TERRAIN_FRAG_ROUGH, lights: TERRAIN_FRAG_LIGHTS, ao: TERRAIN_FRAG_AO,
      },
      caustics: true, hfShadow: true, depth: true,
    });
    this.material = mat;
    this._cells = this.q.cells;
    const geo = patchGeometry(T, this._cells);
    const mesh = new T.Mesh(geo, mat);
    mesh.name = 'ng-terrain-cdlod';
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    ngAttachDepth(mesh);
    this.mesh = mesh;
    this.root.add(mesh);
    ngOwn(this.root, NG_LAYER.WORLD);
    await ctx.forge.step();
    lap('mesh');
    progress?.(0.75);

    /* 3. 遠景の稜線 */
    this.ridges = await this._buildRidges();
    ngOwn(this.ridges, NG_LAYER.FAR);
    this.root.add(this.ridges);
    lap('ridges');
    progress?.(0.95);

    /* 4. services */
    ctx.services.provide('terrain', {
      coverRules: terrainCoverRules(this._dock.start, this._dock.inland),
      farAlbedoTex: this.u.ngTerrFar.value,
    });
    ctx.scene.add(this.root);
    this.loadMs = performance.now() - t0;
    progress?.(1);
  }

  /* ---------- 焼き込み ---------- */
  /* 8 層 × 2 配列。層ごとに焼き、init では層ごとに GPU を待って譲る（1024² の 1 層 ≈ 20–40ms の GPU。
     まとめて投げると後の最初の同期の呼び出しで 250ms 止まっていた） */
  async _bakeLayers(size, yieldBetween) {
    const { THREE: T, forge, renderer } = this.ctx;
    const mk = (name) => {
      const rt = new T.WebGLArrayRenderTarget(size, size, 8, { depthBuffer: false });
      const t = rt.texture;
      t.type = T.UnsignedByteType; t.format = T.RGBAFormat;
      t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter;
      t.wrapS = t.wrapT = t.wrapR = T.RepeatWrapping;
      t.anisotropy = 8; t.name = name;
      /* mip の全段を確保させてから自動生成を止める（generateMipmaps = false で確保すると 1 段しか作られない） */
      t.generateMipmaps = true;
      renderer.initRenderTarget(rt);
      t.generateMipmaps = false;
      return rt;
    };
    const A = mk('ng-terrain-layersA'), B = mk('ng-terrain-layersB');
    const gl = renderer.getContext();
    const uB = { ngSrcA: { value: A.texture }, ngTileM: { value: [...TERRAIN_TILE_M] }, ngReliefM: { value: [...TERRAIN_RELIEF_M] } };
    for (const [rt, frag, uni] of [[A, TERRAIN_BAKE_A, {}], [B, TERRAIN_BAKE_B, uB]]) {
      for (let l = 0; l < 8; l++) {
        rt.texture.generateMipmaps = l === 7;     // mip は最後の層の後に 1 回（three が render の後に作る）
        forge.run(rt, frag, uni, l);
        if (yieldBetween) { gl.finish(); await forge.step(); }
      }
    }
    const oldA = this._rtA, oldB = this._rtB;
    this._rtA = A; this._rtB = B;
    this.u.ngTerrA.value = A.texture;
    this.u.ngTerrB.value = B.texture;
    oldA?.dispose(); oldB?.dispose();
    this._texSize = size;
  }

  _bakeMacro() {
    this.u.ngTerrMacro.value = this.ctx.forge.bake2D({ w: MACRO_SIZE, h: MACRO_SIZE, frag: TERRAIN_BAKE_MACRO, mips: true, wrap: 'repeat' });
  }

  _bakeFar() {
    const { THREE: T, forge, heightfield: hf } = this.ctx;
    const tex = forge.bake2D({
      w: FAR_SIZE, h: FAR_SIZE, frag: FAR_BAKE, type: T.UnsignedByteType, mips: true, wrap: 'clamp', colorSpace: T.SRGBColorSpace, anisotropy: 4,
      uniforms: {
        ...hf.uniforms, ngTerrA: this.u.ngTerrA, ngTerrMacro: this.u.ngTerrMacro, ngTerrCanopyCol: { value: this._canopyCol },
        ngTerrDock: this.u.ngTerrDock, ngTerrFlats: this.u.ngTerrFlats, ngTerrMaxLod: { value: Math.log2(this._texSize) },
      },
    });
    tex.name = 'ng-terrain-farAlbedo';
    this.u.ngTerrFar.value = tex;
  }

  async _buildRidges() {
    const { THREE: T, heightfield: hf, lake } = this.ctx;
    const seed = ((lake?.seed ?? 1) ^ 0x5bd1e995) >>> 0;
    const R = await buildRidgeArraysAsync({
      seed,
      baseAt: (x, z) => { const h = lake?.heightAt?.(x, z); return Number.isFinite(h) ? h : 150; },
      innerAt: (x, z) => hf.heightAt(x, z),
    }, () => this.ctx.forge.step());
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(R.pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(R.nrm, 3));
    g.setAttribute('aNgRidgeIJ', new T.BufferAttribute(R.ij, 2));
    g.setIndex(new T.BufferAttribute(R.index, 1));
    g.computeBoundingSphere();
    /* 地平の角を GPU で焼く（高さの R32F → 8 方位 × 18 歩） */
    const Ht = new T.DataTexture(R.H, R.seg, R.rows, T.RedFormat, T.FloatType);
    Ht.magFilter = Ht.minFilter = T.NearestFilter;
    Ht.needsUpdate = true;
    this._ridgeH = Ht;
    this._ridgeDims = { seg: R.seg, rows: R.rows, radii: R.radii };
    this.uRidge = { ngRidgeHor0: { value: null }, ngRidgeHor1: { value: null } };
    this._bakeHorizons();
    const mat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.92, metalness: 0 }), {
      key: 'terrain-ridges', module: 'terrain', uniforms: this.uRidge,
      vertex: { pars: RIDGE_VERT_PARS, begin: RIDGE_VERT_BEGIN },
      fragment: { pars: RIDGE_FRAG_PARS, surface: RIDGE_FRAG_SURFACE, normal: RIDGE_FRAG_NORMAL, lights: RIDGE_FRAG_LIGHTS },
    });
    this.ridgeMaterial = mat;
    const m = new T.Mesh(g, mat);
    m.name = 'ng-terrain-ridges';
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    this._ridgeTris = R.index.length / 3;
    return m;
  }

  _bakeHorizons() {
    const { THREE: T, forge, heightfield: hf } = this.ctx, D = this._ridgeDims;
    const radii = new Float32Array(RIDGE_MAX_ROWS).fill(1e9);
    radii.set(D.radii.subarray(0, Math.min(D.radii.length, RIDGE_MAX_ROWS)));
    for (let k = 0; k < 2; k++) {
      this.uRidge[k ? 'ngRidgeHor1' : 'ngRidgeHor0'].value = forge.bake2D({
        w: D.seg, h: D.rows, frag: RIDGE_HORIZON_BAKE, type: T.HalfFloatType, filter: 'nearest', wrap: 'clamp',
        uniforms: { ...hf.uniforms, ngRidgeH: { value: this._ridgeH }, ngRidgeRadii: { value: Array.from(radii) }, ngRidgeDims: { value: new T.Vector3(D.seg, D.rows, k) } },
      });
    }
  }

  /* ---------- 毎フレーム ---------- */
  prepare(f) {
    if (!this.mesh) return;
    const u = this.u;
    const wt = Number.isFinite(f.waterTime) ? f.waterTime : 0, ww = Number.isFinite(f.waterWind) ? f.waterWind : 1;
    u.ngTerrWave.value.set(wt, ww, 0, 0);
    const sky = this.ctx.services.sky;
    u.ngSkyViewTex.value = sky.skyViewTex;
    u.ngSkyViewMips.value = Number.isFinite(sky.skyViewMips) ? sky.skyViewMips : 0;
    const c = f.camera?.position;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) return;
    const gh = this.ctx.heightfield.heightAt(c.x, c.z);
    const dy = Math.max(0, c.y - (Number.isFinite(gh) ? gh : 0));
    const r0 = TERRAIN_R0 * this.q.rangeK * this._lodK;
    cdlodRanges(r0, dy, this._rho, this._morphMain, this._cells, CDLOD_WALK_R);
    cdlodSelect(c.x, c.z, this._rho, this.list, this._cells);
    cdlodRanges(r0 * this.q.reflBias, dy, this._rhoR, this._morphRefl, this._cells, 0);
    cdlodSelect(c.x, c.z, this._rhoR, this.reflList, this._cells);
    this._eye.x = c.x; this._eye.y = c.y; this._eye.z = c.z;
    u.ngTerrEye.value.set(c.x, c.y, c.z, this._cells);
  }

  beforePass(passId, camera) {
    if (!this.mesh) return;
    const u = this.u;
    if (passId === NG_PASS.SHADOW) {
      const key = this.ctx.shadows?.key;
      u.ngTerrMorph.value = this._morphMain;
      let fr = null;
      if (key?.shadow?.camera) {
        key.shadow.updateMatrices(key);
        fr = key.shadow.getFrustum();
      }
      this._passCounts.shadow = this._fill(this.list, fr, -1e9);
    } else if (passId === NG_PASS.REFLECTION) {
      u.ngTerrMorph.value = this._morphRefl;
      this._passCounts.refl = this._fill(this.reflList, this._camFrustum(camera), -0.05);
    } else {
      u.ngTerrMorph.value = this._morphMain;
      this._passCounts.main = this._fill(this.list, this._camFrustum(camera), -1e9);
    }
  }

  _camFrustum(cam) {
    if (!cam?.projectionMatrix) return null;
    cam.updateMatrixWorld();
    this._m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m4);
    return this._frustum;
  }

  /* 選択を視錐台と «湖面より上» で詰め、インスタンスの属性へ */
  _fill(src, frustum, minTop) {
    const geo = this.mesh.geometry, attr = geo.attributes.aNgInst, dst = attr.array, d = src.data;
    const box = this._box, hr = this._hr, clip = RIDGE_CLIP + 2;
    let n = 0;
    for (let i = 0; i < src.count; i++) {
      const o = i * 4, x0 = d[o], z0 = d[o + 1], s = src.size[i];
      /* 遠景の帯の外の区画は描かない（頂点は 508m の円へ寄せる） */
      const nx = Math.min(Math.max(0, x0), x0 + s), nz = Math.min(Math.max(0, z0), z0 + s);
      if (nx * nx + nz * nz > clip * clip) continue;
      nodeHeightRange(this.pyr, x0, z0, s, hr);
      if (hr[1] < minTop) continue;
      if (frustum) {
        box.min.set(x0 - NODE_MARGIN, hr[0] - NODE_MARGIN, z0 - NODE_MARGIN);
        box.max.set(x0 + s + NODE_MARGIN, hr[1] + NODE_MARGIN, z0 + s + NODE_MARGIN);
        if (!frustum.intersectsBox(box)) continue;
      }
      dst[n * 4] = x0; dst[n * 4 + 1] = z0; dst[n * 4 + 2] = d[o + 2]; dst[n * 4 + 3] = d[o + 3];
      n++;
    }
    geo.instanceCount = n;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, Math.max(n, 1) * 4);
    attr.needsUpdate = true;
    return n;
  }

  /* ---------- 品質 ---------- */
  setQuality(tier) {
    this.q = terrainTier(tier);
    if (!this.mesh) return;
    const T = this.ctx.THREE;
    if (this.q.cells !== this._cells) {
      const old = this.mesh.geometry;
      this._cells = this.q.cells;
      this.mesh.geometry = patchGeometry(T, this._cells);
      old.dispose();
    }
    if (this.q.texSize !== this._texSize) {
      /* 段の切り替え（設定の変更）のときだけ。焼き直しは同期（1024² × 8 層 × 2） */
      this._bakeLayers(this.q.texSize, false);
    }
    this.u.ngTerrParams.value.set(this.q.hexMode, this.q.triplanar, this.q.farFrom, this._debug);
    this.u.ngTerrEye.value.w = this._cells;
  }

  setLodScale(k) { this._lodK = Number.isFinite(k) && k > 0 ? Math.min(4, Math.max(0.25, k)) : 1; }

  /** デバッグ表示：0 = 通常、1 = LOD の色、2 = 一番重い層、3 = パッチの格子 */
  setDebug(mode) {
    this._debug = Number.isFinite(mode) ? mode : 0;
    if (this.u) this.u.ngTerrParams.value.w = this._debug;
  }

  restoreGPU() {
    if (!this.u) return;
    this._bakeLayers(this._texSize || this.q.texSize, false);
    this._bakeMacro();
    this._bakeFar();
    if (this._ridgeH) { this._ridgeH.needsUpdate = true; this._bakeHorizons(); }
    this._canopyCol.needsUpdate = true;
    this.ctx.services.provide('terrain', {
      coverRules: terrainCoverRules(this._dock.start, this._dock.inland),
      farAlbedoTex: this.u.ngTerrFar.value,
    });
  }

  stats() {
    const n = this.mesh?.geometry?.instanceCount || 0, cells = this._cells || 32;
    const tex = this._texSize || 0;
    const texBytes = Math.round(tex * tex * 4 * 8 * 2 * 1.33 + FAR_SIZE * FAR_SIZE * 4 * 1.33 + MACRO_SIZE * MACRO_SIZE * 8 * 1.33 + 256 * 256 * 4);
    return {
      draws: (n > 0 ? 1 : 0) + (this.ridges ? 1 : 0),
      tris: n * cells * cells * 2 + (this._ridgeTris || 0),
      instances: n,
      texBytes,
      programs: 3,
      passes: { ...this._passCounts },
      selected: this.list.count, overflow: this.list.overflow,
      loadMs: this.loadMs, loadParts: this._loadParts,
    };
  }

  dispose() {
    this.material?.dispose();
    this.material?.userData?.ngDepth?.dispose();
    this.material?.userData?.ngDistance?.dispose();
    this.ridgeMaterial?.dispose();
    this._canopyCol?.dispose();
    this._ridgeH?.dispose();
    this._rtA?.dispose(); this._rtB?.dispose();
    super.dispose();
  }
}

/* パッチ：0..cells の格子（x = i、z = j の格子の番号）。インスタンス属性 aNgInst。三角形の対角は揃える
   （ジオモーフで奇数の格子点が偶数へ寄ると、粗い段と同じ三角形になる） */
function patchGeometry(T, cells) {
  const n = cells, W = n + 1;
  const pos = new Float32Array(W * W * 3), nrm = new Float32Array(W * W * 3);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const v = j * W + i;
    pos[v * 3] = i; pos[v * 3 + 2] = j; nrm[v * 3 + 1] = 1;
  }
  const idx = new Uint16Array(n * n * 6);
  let k = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b;
    idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  const g = new T.InstancedBufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
  g.setIndex(new T.BufferAttribute(idx, 1));
  const inst = new T.InstancedBufferAttribute(new Float32Array(CDLOD_MAX_INST * 4), 4);
  inst.setUsage(T.DynamicDrawUsage);
  g.setAttribute('aNgInst', inst);
  g.instanceCount = 0;
  g.boundingSphere = new T.Sphere(new T.Vector3(0, 0, 0), 4000);
  g.boundingBox = new T.Box3(new T.Vector3(-4000, -100, -4000), new T.Vector3(4000, 2000, 4000));
  return g;
}

/** @param {object} ctx */
export function createModule(ctx) { return new TerrainModule(ctx); }
