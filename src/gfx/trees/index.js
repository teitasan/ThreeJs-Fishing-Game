/* ===========================================================
   trees モジュール（ARCHITECTURE §6.5）
   -----------------------------------------------------------
   - 幾何：オフラインで焼いた assets/gfx/trees/trees.bin（8 樹種 × 4 variant × LOD0/LOD1）を
     読み込み時に 20B の量子化頂点へ展開し、BatchedMesh 2 本（LOD0・LOD1）に積む（1 パス 2 ドロー）
   - 木の割り当て：16m のセルの格子から、カメラの近くの木を 4Hz か «動いた・向きが変わった» ときに
     LOD0 / LOD1 / 反射用の代理へ詰め直す（LOD1 は水平の視野の扇で間引く。影のための LOD0 は全周）
   - インポスター：半八面体 8×8 を起動時に焼き、全部の木を 1 ドロー（頂点で距離の外を潰す）。同じ BRDF で再ライティング
   - 樹冠シェル：placement の全部の木から焼いた樹冠の地図（密度・樹高・針葉の割合）で、遠景の山肌の森
   - テクスチャ：樹皮の配列・葉のアトラスを forge で焼く（textures.js）
   当たりは placement が持つ（幹の見た目 × 1.15 = 当たりの半径。焼き込みが species.js の trunkR に合わせる）
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { ngExtendStandard, ngAttachDepth, ngCutout } from '../core/extend.js';
import { SPECIES, SPECIES_IDS } from '../../world/species.js';
import { TIER_DENSITY } from '../../world/placement.js';
import { readLod, expandLod, POS_RANGE } from './format.js';
import { bakeTreeTextures } from './textures.js';
import { bakeImpostors } from './impostor.js';
import { TREE_HOOKS, IMP_HOOKS, SHELL_HOOKS } from './shaders.js';
import { treesQuality, IMP_GRID } from './quality.js';
import { trunkProfileOf, trunkWiden, visualTrunkR } from './fit.js';

const ASSET_DIR = new URL('../../../assets/gfx/trees/', import.meta.url);
const CELL = 16;
const GRID_HALF = 512;
const GRID_N = (GRID_HALF * 2) / CELL;
/** 遠景の色むら（樹種の明るさ）。シェルの a に入れる */
const SPECIES_BRIGHT = { sugi: 0.35, hinoki: 0.45, buna: 0.62, mizunara: 0.55, momiji: 0.78, akamatsu: 0.45, yanagi: 0.85, hannoki: 0.55 };

function fnv1aBytes(b) {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export class TreesModule extends NgModule {
  static id = 'trees';

  constructor(ctx) {
    super(ctx);
    this.tier = ctx.tier || 'high';
    this.q = treesQuality(this.tier);
    this.lodScale = 1;
    this.lastEye = { x: 1e9, z: 1e9, yaw: 0, t: 0 };
    this.counts = { lod0: 0, lod1: 0, proxy: 0, imp: 0 };
    this.texBytes = 0;
    this.forceBuild = true;
    this.clock = 0;
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE;
    const q = this.q;
    /* ---- 1. 読み込み（同じ出どころの静的ファイル。第三者のアセットではない） */
    const [json, bin] = await Promise.all([
      fetch(new URL('trees.json', ASSET_DIR)).then((r) => { if (!r.ok) throw new Error(`trees.json ${r.status}`); return r.json(); }),
      fetch(new URL('trees.bin', ASSET_DIR)).then((r) => { if (!r.ok) throw new Error(`trees.bin ${r.status}`); return r.arrayBuffer(); }),
    ]);
    const bytes = new Uint8Array(bin);
    if (bytes.length !== json.bytes || fnv1aBytes(bytes) !== json.hash) throw new Error('[ng] trees.bin の hash が trees.json と違う');
    this.meta = json;
    progress?.(0.08);
    /* ---- 2. 展開（20B の量子化頂点） */
    this.geos = [[], []];
    this.vstats = [];
    this.profiles = [];
    for (let i = 0; i < json.variants.length; i++) {
      const V = json.variants[i];
      for (let k = 0; k < 2; k++) {
        const rec = readLod(bytes, V.lods[k]);
        if (k === 0) this.profiles.push(trunkProfileOf(rec));
        const e = expandLod(rec, { cardSegs: json.cardSegs[k], crown: V.crown, crownR: V.crownR, href: V.href, bend: 0.6, lod: k });
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(e.position, 3, true));
        g.setAttribute('ngNrm', new T.BufferAttribute(e.normal, 2, true));
        g.setAttribute('ngUv', new T.BufferAttribute(e.uv, 2, true));
        g.setAttribute('ngWind', new T.BufferAttribute(e.wind, 4, true));
        g.setAttribute('ngExtra', new T.BufferAttribute(e.extra, 4, true));
        g.setIndex(new T.BufferAttribute(e.index, 1));
        g.boundingSphere = new T.Sphere(new T.Vector3(0, 0.5 / POS_RANGE, 0), 0.8 / POS_RANGE);
        g.boundingBox = new T.Box3(new T.Vector3(-1, -1, -1), new T.Vector3(1, 1, 1));
        this.geos[k].push(g);
        if (k === 0) this.vstats.push({ verts: e.verts, tris: e.tris, pos: e.position });
      }
      if (i % 4 === 3) await ctx.forge.step();
    }
    progress?.(0.25);
    /* ---- 3. テクスチャ */
    this.tex = await bakeTreeTextures(ctx.forge, T, { bark: q.bark, leafW: q.leaf[0], leafH: q.leaf[1] });
    this.texBytes = this.tex.texBytes;
    this.tex.leafSize = new T.Vector2(q.leaf[0], q.leaf[1]);
    progress?.(0.4);
    /* ---- 4. マテリアル（木・インポスター・シェルで LOD の uniforms を共有）。樹冠の地図を先に */
    this.canopyTex = this._bakeCanopyMap();
    this.U = {
      ngTreeEye: { value: new T.Vector4(0, 0, 0, 1) },
      ngTreeLod: { value: new T.Vector4(q.lod0, q.lod1, q.fade0, q.fade1) },
      ngTreeWindK: { value: new T.Vector4(0.0011, 0.016, 0.0045, 1) },
      ngTreePass: { value: new T.Vector4(q.lod0, q.fade1, 22, 0) },
      ngTreeMisc: { value: new T.Vector4(0, 1, 0, 0) },
      ngImpLod: { value: new T.Vector4(q.lod1, q.fade1, q.imp, q.fade1) },
      ngShellLod: { value: new T.Vector4(q.shell, q.shellFade, 0, 0) },
      ngSkyViewTex: { value: ctx.services.sky.skyViewTex },
      ngSkyViewMips: { value: ctx.services.sky.skyViewMips || 0 },
      ngCanopyMap: { value: this.canopyTex },
    };
    const U = this.U;
    this.treeMat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.7, metalness: 0, side: T.DoubleSide }), {
      key: 'trees-tree', module: 'trees',
      uniforms: {
        ngBarkAlb: { value: this.tex.barkAlb }, ngBarkNrm: { value: this.tex.barkNrm }, ngLeafAlb: { value: this.tex.leafAlb }, ngLeafNrm: { value: this.tex.leafNrm }, ngLeafSize: { value: this.tex.leafSize },
        ngTreeEye: U.ngTreeEye, ngTreeLod: U.ngTreeLod, ngTreeWindK: U.ngTreeWindK, ngTreeMisc: U.ngTreeMisc, ngTreePass: U.ngTreePass,
        ngSkyViewTex: U.ngSkyViewTex, ngSkyViewMips: U.ngSkyViewMips, ngCanopyMap: U.ngCanopyMap,
      },
      vertex: TREE_HOOKS.vertex, fragment: TREE_HOOKS.fragment, depth: true, hfShadow: true,
    });
    /* ---- 5. BatchedMesh（LOD0・LOD1） */
    this.batches = [0, 1].map((k) => {
      let nv = 0, ni = 0;
      for (const g of this.geos[k]) { nv += g.attributes.position.count; ni += g.index.count; }
      const cap = k === 0 ? q.cap0 : q.cap1 + q.cap0;
      const bm = new T.BatchedMesh(cap, nv, ni, this.treeMat);
      bm.name = `trees-lod${k}`;
      bm.perObjectFrustumCulled = false;
      bm.sortObjects = false;
      bm.frustumCulled = false;
      bm.castShadow = true;
      bm.receiveShadow = true;
      const ids = this.geos[k].map((g) => bm.addGeometry(g));
      for (let i = 0; i < cap; i++) { const id = bm.addInstance(ids[0]); bm.setVisibleAt(id, false); }
      ngAttachDepth(bm);
      this.root.add(bm);
      return { bm, ids, cap, used: 0 };
    });
    progress?.(0.5);
    /* ---- 6. 木の表（高さは GPU の地形と同じ補間）と格子 */
    this._buildTreeTable();
    await ctx.forge.step();
    /* ---- 7. インポスター */
    const impV = q.impVariants;
    const layers = [];
    this.impMeta = [];
    for (let s = 0; s < SPECIES_IDS.length; s++) {
      for (let v = 0; v < impV; v++) {
        const vi = s * 4 + v;
        const V = json.variants[vi];
        /* 中心と半径：LOD0 の全頂点を包む球（中心は幹の軸の上） */
        const cy = (V.bounds.y0 + V.bounds.y1) / 2;
        const pos = this.vstats[vi].pos;
        const ds = new Float32Array(pos.length / 3);
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i] / 32767 * POS_RANGE, y = pos[i + 1] / 32767 * POS_RANGE, z = pos[i + 2] / 32767 * POS_RANGE;
          ds[i / 3] = Math.hypot(x, y - cy, z);
        }
        ds.sort();
        /* 外れの頂点（垂れた葉の先など）で枠を広げない：99.7 分位 × 1.03 */
        const R = ds[Math.floor(ds.length * 0.997)] * 1.03;
        /* 水平の広がり（幹の軸から）：板の横幅に使う */
        const dh = new Float32Array(pos.length / 3);
        for (let i = 0; i < pos.length; i += 3) dh[i / 3] = Math.hypot(pos[i], pos[i + 2]) / 32767 * POS_RANGE;
        dh.sort();
        const Rh = Math.min(R, dh[Math.floor(dh.length * 0.997)] * 1.06);
        layers.push({ geo: this.geos[0][vi], cy, R, href: V.href });
        this.impMeta.push(new T.Vector4(cy, R, Rh, s));
      }
    }
    while (this.impMeta.length < 16) this.impMeta.push(new T.Vector4(0.5, 0.6, 0, 0));
    this.imp = await bakeImpostors({ T, renderer: ctx.renderer, forge: ctx.forge, layers, frame: q.impFrame, tex: this.tex });
    this.texBytes += this.imp.texBytes;
    this.impVariants = impV;
    progress?.(0.75);
    this.impMat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.6, metalness: 0, side: T.FrontSide }), {
      key: 'trees-impostor', module: 'trees',
      uniforms: {
        ngImpAlb: { value: this.imp.alb.texture }, ngImpNrm: { value: this.imp.nrm.texture }, ngImpMeta: { value: this.impMeta },
        ngImpLod: U.ngImpLod, ngTreePass: U.ngTreePass, ngTreeEye: U.ngTreeEye, ngTreeMisc: U.ngTreeMisc, ngSkyViewTex: U.ngSkyViewTex, ngSkyViewMips: U.ngSkyViewMips, ngCanopyMap: U.ngCanopyMap,
      },
      vertex: IMP_HOOKS.vertex, fragment: IMP_HOOKS.fragment, hfShadow: true,
    });
    this.impGeo = new T.InstancedBufferGeometry();
    this.impGeo.setAttribute('position', new T.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    this.impGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.impMesh = new T.Mesh(this.impGeo, this.impMat);
    this.impMesh.name = 'trees-impostors';
    this.impMesh.frustumCulled = false;
    this.impMesh.receiveShadow = true;
    this.root.add(this.impMesh);
    /* ---- 8. 樹冠シェル */
    const sg = new T.PlaneGeometry(GRID_HALF * 2, GRID_HALF * 2, 256, 256);
    sg.rotateX(-Math.PI / 2);
    this.shellMat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.75, metalness: 0 }), {
      key: 'trees-shell', module: 'trees',
      uniforms: { ...ctx.heightfield.uniforms, ngCanopyMap: U.ngCanopyMap, ngTreeEye: U.ngTreeEye, ngShellLod: U.ngShellLod, ngTreeMisc: U.ngTreeMisc },
      vertex: SHELL_HOOKS.vertex, fragment: SHELL_HOOKS.fragment, hfShadow: true,
    });
    this.shell = new T.Mesh(sg, this.shellMat);
    this.shell.name = 'trees-shell';
    this.shell.frustumCulled = false;
    this.shell.receiveShadow = true;
    this.root.add(this.shell);
    /* ---- 層・品質・提供 */
    ngOwn(this.root, NG_LAYER.WORLD);
    ngOwn(this.shell, NG_LAYER.FAR);
    this.setQuality(this.tier, ctx.profile);
    ctx.services.provide('trees', {
      impostorBake: { albedoTex: this.imp.alb.texture, normalDepthTex: this.imp.nrm.texture, frames: IMP_GRID, size: this.imp.size },
    });
    this._registerDebug();
    ctx.scene.add(this.root);
    progress?.(1);
  }

  /** lab の view(name)：葉のアトラス・樹皮の配列・インポスターの層・樹冠の地図 */
  _registerDebug() {
    const reg = this.ctx.services.post.registerDebugView;
    const u = {
      ngDbgLeaf: { value: this.tex.leafAlb }, ngDbgLeafN: { value: this.tex.leafNrm }, ngDbgBark: { value: this.tex.barkAlb },
      ngDbgImp: { value: this.imp.alb.texture }, ngDbgImpN: { value: this.imp.nrm.texture }, ngDbgCan: { value: this.canopyTex },
    };
    const chk = 'float ngChk(vec2 uv) { vec2 c = floor(uv * 64.0); return mod(c.x + c.y, 2.0) * 0.1 + 0.2; }\n';
    reg('trees-atlas', `uniform sampler2D ngDbgLeaf;\n${chk}vec4 ngDebug(vec2 uv) { vec4 a = texture(ngDbgLeaf, uv); return vec4(mix(vec3(ngChk(uv)), clamp(a.rgb * 5.0, 0.0, 1.0), a.a), 1.0); }`, u);
    reg('trees-atlas-n', `uniform sampler2D ngDbgLeafN;\nvec4 ngDebug(vec2 uv) { return vec4(texture(ngDbgLeafN, uv).rgb, 1.0); }`, u);
    reg('trees-bark', `uniform highp sampler2DArray ngDbgBark;\nvec4 ngDebug(vec2 uv) { vec2 g = uv * 3.0; float l = floor(g.x) + floor(g.y) * 3.0; return vec4(clamp(texture(ngDbgBark, vec3(fract(g), l)).rgb * 2.0, 0.0, 1.0), 1.0); }`, u);
    reg('trees-imp', `uniform highp sampler2DArray ngDbgImp;\nvec4 ngDebug(vec2 uv) { vec2 g = uv * 4.0; float l = floor(g.x) + floor(g.y) * 4.0; vec4 a = texture(ngDbgImp, vec3(fract(g), l)); return vec4(mix(vec3(0.25), a.rgb / max(a.a, 0.01) * 1.6, a.a), 1.0); }`, u);
    reg('trees-imp-n', `uniform highp sampler2DArray ngDbgImpN;\nvec4 ngDebug(vec2 uv) { vec2 g = uv * 4.0; float l = floor(g.x) + floor(g.y) * 4.0; return vec4(texture(ngDbgImpN, vec3(fract(g), l)).rgb, 1.0); }`, u);
    reg('trees-canopy', `uniform sampler2D ngDbgCan;\nvec4 ngDebug(vec2 uv) { vec4 c = texture(ngDbgCan, uv); return vec4(c.r, c.g, c.b, 1.0); }`, u);
  }

  /** placement の木：描画の高さ・行列の材料・16m の格子 */
  _buildTreeTable() {
    const P = this.ctx.placement?.trees;
    const n = P?.count || 0;
    this.n = n;
    this.baseY = new Float32Array(n);
    this.widen = new Float32Array(n);
    this.visR = new Float32Array(n);
    const hf = this.ctx.heightfield;
    const hAt = (x, z) => {
      const y = hf?.ready ? hf.heightAt(x, z) : NaN;
      return Number.isFinite(y) ? y : NaN;
    };
    for (let k = 0; k < n; k++) {
      const prof = this.profiles[P.species[k] * 4 + (P.variant[k] | 0)] || this.profiles[0];
      const w = trunkWiden(prof, P.h[k], P.r[k]);
      this.widen[k] = w;
      this.visR[k] = visualTrunkR(prof, P.h[k], w);
      /* 浮かせない：根張り（胸高の半径 × 1.6 + 10cm）の 4 点と中心の最も低い所から 12cm 沈める */
      const x = P.x[k], z = P.z[k], rf = this.visR[k] * 1.6 + 0.1;
      let y = hAt(x, z);
      if (Number.isFinite(y)) {
        for (const [dx, dz] of [[rf, 0], [-rf, 0], [0, rf], [0, -rf]]) { const v = hAt(x + dx, z + dz); if (Number.isFinite(v)) y = Math.min(y, v); }
      } else y = P.y[k] + 0.15;
      this.baseY[k] = y - 0.12;
    }
    this.hfKey = this._hfKey();
    this.cellStart = new Int32Array(GRID_N * GRID_N + 1);
    this.cellList = new Int32Array(n);
    const cellOf = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const i = Math.min(GRID_N - 1, Math.max(0, Math.floor((P.x[k] + GRID_HALF) / CELL)));
      const j = Math.min(GRID_N - 1, Math.max(0, Math.floor((P.z[k] + GRID_HALF) / CELL)));
      cellOf[k] = j * GRID_N + i;
      this.cellStart[cellOf[k] + 1]++;
    }
    for (let c = 0; c < GRID_N * GRID_N; c++) this.cellStart[c + 1] += this.cellStart[c];
    const fill = this.cellStart.slice(0, GRID_N * GRID_N);
    for (let k = 0; k < n; k++) this.cellList[fill[cellOf[k]]++] = k;
    this._m = new this.ctx.THREE.Matrix4();
    this._qa = new this.ctx.THREE.Quaternion();
    this._qb = new this.ctx.THREE.Quaternion();
    this._v = new this.ctx.THREE.Vector3();
    this._s = new this.ctx.THREE.Vector3();
    this._ax = new this.ctx.THREE.Vector3(1, 0, 0);
    this._ay = new this.ctx.THREE.Vector3(0, 1, 0);
  }

  /** 樹冠の地図（512²、±512m、2m/テクセル）：r = 密度、g = 平均樹高/40、b = 針葉の割合、a = 明るさのむら */
  _bakeCanopyMap() {
    const T = this.ctx.THREE, P = this.ctx.placement?.trees;
    const N = 512, S = (GRID_HALF * 2) / N;
    const cov = new Float32Array(N * N), hs = new Float32Array(N * N), cs = new Float32Array(N * N), bs = new Float32Array(N * N);
    const n = P?.count || 0;
    for (let k = 0; k < n; k++) {
      const sp = SPECIES[SPECIES_IDS[P.species[k]]] || SPECIES.sugi;
      const h = P.h[k];
      const cr = Math.max(1.6, sp.crownR * h * 1.1);
      const cx = (P.x[k] + GRID_HALF) / S, cz = (P.z[k] + GRID_HALF) / S, r = cr / S;
      const conifer = sp.form === 'conifer' ? 1 : sp.form === 'pine' ? 0.7 : 0;
      const br = SPECIES_BRIGHT[sp.id] ?? 0.5;
      for (let j = Math.max(0, Math.floor(cz - r)); j <= Math.min(N - 1, Math.ceil(cz + r)); j++) {
        for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(N - 1, Math.ceil(cx + r)); i++) {
          const d2 = ((i + 0.5 - cx) ** 2 + (j + 0.5 - cz) ** 2) / (r * r);
          if (d2 >= 1) continue;
          const w = 1 - d2;
          const id = j * N + i;
          cov[id] += w; hs[id] += w * h; cs[id] += w * conifer; bs[id] += w * br;
        }
      }
    }
    const data = new Uint8Array(N * N * 4);
    const blur = (src) => {
      const out = new Float32Array(N * N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const x = i + di, y = j + dj;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          const w = di || dj ? (di && dj ? 1 : 2) : 4;
          s += src[y * N + x] * w; c += w;
        }
        out[j * N + i] = s / c;
      }
      return out;
    };
    const C = blur(cov), Hs = blur(hs), Cs = blur(cs), Bs = blur(bs);
    for (let id = 0; id < N * N; id++) {
      const c = C[id];
      const dens = 1 - Math.exp(-c * 1.6);
      const h = c > 1e-4 ? Hs[id] / c : 0, con = c > 1e-4 ? Cs[id] / c : 0, br = c > 1e-4 ? Bs[id] / c : 0.5;
      data[id * 4] = Math.round(Math.min(1, dens) * 255);
      data[id * 4 + 1] = Math.round(Math.min(1, h / 40) * 255);
      data[id * 4 + 2] = Math.round(Math.min(1, con) * 255);
      data[id * 4 + 3] = Math.round(Math.min(1, br) * 255);
    }
    const tex = new T.DataTexture(data, N, N, T.RGBAFormat, T.UnsignedByteType);
    tex.magFilter = T.LinearFilter;
    tex.minFilter = T.LinearFilter;
    tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.texBytes += N * N * 4;
    this.canopyData = data;
    return tex;
  }

  /** インポスターのインスタンス（段の rank の入れ子で全部の見える木） */
  _buildImpostors() {
    const T = this.ctx.THREE, P = this.ctx.placement?.trees;
    if (!P || !this.impGeo) return;
    const dens = TIER_DENSITY.trees[this.tier] ?? 1;
    const list = [];
    for (let k = 0; k < this.n; k++) if (P.rank[k] < dens || P.mustDraw[k]) list.push(k);
    const pos = new Float32Array(list.length * 4), rot = new Float32Array(list.length * 4);
    list.forEach((k, i) => {
      pos[i * 4] = P.x[k]; pos[i * 4 + 1] = this.baseY[k]; pos[i * 4 + 2] = P.z[k]; pos[i * 4 + 3] = P.h[k];
      rot[i * 4] = P.rot[k];
      rot[i * 4 + 1] = P.species[k] * this.impVariants + ((P.variant[k] | 0) % this.impVariants);
      rot[i * 4 + 2] = ((k * 0.6180339) % 1 + (P.x[k] * 0.0131) % 1 + 1) % 1;
      rot[i * 4 + 3] = P.lean[k];
    });
    this.impGeo.setAttribute('ngIPos', new T.InstancedBufferAttribute(pos, 4));
    this.impGeo.setAttribute('ngIRot', new T.InstancedBufferAttribute(rot, 4));
    this.impGeo.instanceCount = list.length;
    this.counts.imp = list.length;
    this.visible = new Uint8Array(this.n);
    for (const k of list) this.visible[k] = 1;
  }

  /** 木の行列（根元・回転・傾き・樹高 × POS_RANGE）。flag は [3][3]（2 = 反射だけの代理） */
  _matrix(k, flag) {
    const P = this.ctx.placement.trees;
    this._qa.setFromAxisAngle(this._ay, P.rot[k]);
    this._qb.setFromAxisAngle(this._ax, P.lean[k]);
    this._qa.multiply(this._qb);
    const s = P.h[k] * POS_RANGE;
    this._v.set(P.x[k], this.baseY[k], P.z[k]);
    this._s.set(s, s, s);
    this._m.compose(this._v, this._qa, this._s);
    this._m.elements[15] = flag;
    this._m.elements[3] = this.widen[k];
    return this._m;
  }

  /** カメラの近くの木を LOD0 / LOD1 / 代理 / 影だけへ詰め直す。
   *  LOD0・LOD1 の距離は «視野の中の本数の上限»（q.n0 / q.n1）で縮める（深い森で頂点が溢れない）。
   *  縮めた距離は update で毎フレーム滑らかに追う（シェーダのディザの境目が跳ばない） */
  _assign(cam) {
    const P = this.ctx.placement?.trees;
    if (!P || !this.batches || !this.visible) return;
    const q = this.q, k = this.lodScale;
    const ex = cam.position.x, ez = cam.position.z;
    const L0 = this.L0eff, L1 = this.L1eff, W0 = q.fade0 * k;
    /* 水平の視野の扇：横の半画角 + 余裕 25° */
    const fwd = this._v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    let fx = fwd.x, fz = fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    const vfov = ((cam.fov || 60) * Math.PI) / 180;
    const hfov = Math.atan(Math.tan(vfov / 2) * (cam.aspect || 1.78));
    const cosCut = Math.cos(Math.min(Math.PI, hfov + 0.44));
    const lookDown = Math.abs(fwd.y) > 0.8;
    const [b0, b1] = this.batches;
    let n0 = 0, n1 = 0, np = 0, ns = 0;
    const SR = this.shadowR || 60;
    const R = q.lod1 * k + 2;
    const i0 = Math.max(0, Math.floor((ex - R + GRID_HALF) / CELL)), i1 = Math.min(GRID_N - 1, Math.floor((ex + R + GRID_HALF) / CELL));
    const j0 = Math.max(0, Math.floor((ez - R + GRID_HALF) / CELL)), j1 = Math.min(GRID_N - 1, Math.floor((ez + R + GRID_HALF) / CELL));
    const gid = (t) => P.species[t] * 4 + (P.variant[t] | 0);
    const cand = this._cand || (this._cand = new Int32Array(8192));
    const cd = this._cd || (this._cd = new Float32Array(8192));
    let nc = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * GRID_N + i;
        for (let e = this.cellStart[c]; e < this.cellStart[c + 1] && nc < 8192; e++) {
          const t = this.cellList[e];
          if (!this.visible[t]) continue;
          const dx = P.x[t] - ex, dz = P.z[t] - ez;
          const d = Math.hypot(dx, dz);
          if (d >= R) continue;
          const slack = P.h[t] * 0.35;
          const inView = lookDown || d < slack + 4 || (dx * fx + dz * fz) / Math.max(d, 1e-3) > cosCut - slack / Math.max(d, 1);
          cand[nc] = inView ? t : -1 - t;
          cd[nc] = d;
          nc++;
        }
      }
    }
    /* 視野の中の本数から距離の上限（k 番目に近い木の距離） */
    const dv = [];
    for (let c = 0; c < nc; c++) if (cand[c] >= 0) dv.push(cd[c]);
    dv.sort((a, b) => a - b);
    const kth = (n) => (dv.length > n ? dv[n] : Infinity);
    this.L0target = Math.max(q.lod0 * 0.35, Math.min(q.lod0, kth(q.n0) / k)) ;
    this.L1target = Math.max(q.lod0 * 1.2, Math.min(q.lod1, kth(q.n1) / k));
    for (let c = 0; c < nc; c++) {
      const inView = cand[c] >= 0;
      const t = inView ? cand[c] : -1 - cand[c];
      const d = cd[c];
      if (inView && d < L0) {
        if (n0 < b0.cap) { const id = n0++; b0.bm.setGeometryIdAt(id, b0.ids[gid(t)]); b0.bm.setMatrixAt(id, this._matrix(t, 1)); }
        if (n1 < b1.cap) {
          /* 切り替えの帯は本物の LOD1（ディザ）、内側は代理（反射と遠めの影） */
          const proxy = d < L0 - W0 - 1;
          const id = n1++;
          b1.bm.setGeometryIdAt(id, b1.ids[gid(t)]);
          b1.bm.setMatrixAt(id, this._matrix(t, proxy ? 2 : 1));
          if (proxy) np++;
        }
      } else if (inView && d < L1) {
        if (n1 < b1.cap) { const id = n1++; b1.bm.setGeometryIdAt(id, b1.ids[gid(t)]); b1.bm.setMatrixAt(id, this._matrix(t, 1)); }
      } else if (!inView && d < SR && n1 < b1.cap) {
        /* 視野の外の近い木：影だけ（LOD1） */
        const id = n1++;
        b1.bm.setGeometryIdAt(id, b1.ids[gid(t)]);
        b1.bm.setMatrixAt(id, this._matrix(t, 3));
        ns++;
      }
    }
    for (const [b, n] of [[b0, n0], [b1, n1]]) {
      for (let i = n; i < b.used; i++) b.bm.setVisibleAt(i, false);
      for (let i = 0; i < n; i++) b.bm.setVisibleAt(i, true);
      b.used = n;
      /* setGeometryIdAt は描く一覧の作り直しを立てない（three r180）ので立てる */
      b.bm._visibilityChanged = true;
    }
    this.counts.lod0 = n0; this.counts.lod1 = n1 - np - ns; this.counts.proxy = np; this.counts.shadowOnly = ns;
  }

  /** 描いた幹の胸高の半径 m（当たりの重ね表示・テスト用） */
  visualTrunkR(k) { return this.visR?.[k] ?? 0; }

  /** 高さ場の版（作り直されたら変わる） */
  _hfKey() {
    const hf = this.ctx.heightfield;
    return hf?.ready ? (hf.grids?.hash ?? hf.grids?.near?.data ?? true) : null;
  }

  update(f) {
    const cam = f?.camera;
    if (!cam || !this.batches) return;
    /* 高さ場が作り直されたら（terrain の差し替え）根元の高さを取り直す */
    if (this._hfKey() !== this.hfKey) { this._buildTreeTable(); this._buildImpostors(); this.forceBuild = true; }
    const p = cam.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    this.U.ngTreeEye.value.set(p.x, p.y, p.z, this.lodScale);
    /* LOD の距離を目標へ滑らかに（縮めるのは速く、広げるのはゆっくり）。シェーダの距離は ÷ lodScale */
    const q = this.q, dt = Math.min(Math.max(Number.isFinite(f.realDt) ? f.realDt : 0, Number.isFinite(f.dt) ? f.dt : 0, 1 / 60), 0.1);
    const ease = (cur, tgt) => cur + (tgt - cur) * Math.min(1, dt * (tgt < cur ? 3 : 0.8));
    this.clock += dt;
    this.L0n = ease(this.L0n ?? q.lod0, this.L0target ?? q.lod0);
    this.L1n = ease(this.L1n ?? q.lod1, this.L1target ?? q.lod1);
    if (this.forceBuild) { this.L0n = this.L0target ?? this.L0n; this.L1n = this.L1target ?? this.L1n; }
    this.U.ngTreeLod.value.x = this.L0n;
    this.U.ngTreeLod.value.y = this.L1n;
    this.U.ngImpLod.value.x = this.L1n;
    /* 割り当ては滑らかな距離 + ディザの幅の分だけ外まで（シェーダが残す割合を決める） */
    this.L0eff = (this.L0n + 2) * this.lodScale;
    this.L1eff = (this.L1n + 2) * this.lodScale;
    const fwd = this._v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const yaw = Math.atan2(fwd.x, fwd.z);
    const L = this.lastEye;
    let dy = Math.abs(yaw - L.yaw);
    if (dy > Math.PI) dy = 2 * Math.PI - dy;
    const moved = Math.hypot(p.x - L.x, p.z - L.z);
    const lodMoved = Math.abs((this.L0n ?? 0) - (L.l0 ?? 0)) > 1 || Math.abs((this.L1n ?? 0) - (L.l1 ?? 0)) > 2;
    if (this.forceBuild || moved > 1.5 || dy > 0.12 || lodMoved || this.clock - L.t > 0.25) {
      L.l0 = this.L0n; L.l1 = this.L1n;
      if (this.forceBuild) { this._assign(cam); this.L0n = this.L0target; this.L1n = this.L1target; this.L0eff = (this.L0n + 2) * this.lodScale; this.L1eff = (this.L1n + 2) * this.lodScale; }
      this._assign(cam);
      L.x = p.x; L.z = p.z; L.yaw = yaw; L.t = this.clock;
      this.forceBuild = false;
    }
  }

  prepare() {
    /* 空の鏡面：sky の提供は作り直しで差し替わるので毎フレーム引き直す */
    const sky = this.ctx.services.sky;
    if (this.U) {
      if (sky.skyViewTex && this.U.ngSkyViewTex.value !== sky.skyViewTex) this.U.ngSkyViewTex.value = sky.skyViewTex;
      this.U.ngSkyViewMips.value = Number.isFinite(sky.skyViewMips) ? sky.skyViewMips : 0;
    }
  }

  setQuality(tier, profile) {
    if (!this.treeMat) return;
    this.tier = tier;
    this.q = treesQuality(tier);
    const q = this.q;
    this.U.ngTreeLod.value.set(q.lod0, q.lod1, q.fade0, q.fade1);
    this.U.ngImpLod.value.set(q.lod1, q.fade1, q.imp, q.fade1);
    this.U.ngShellLod.value.set(q.shell, q.shellFade, 0, 0);
    this.U.ngTreePass.value.set(q.lod0 * (q.reflLod ?? 1), q.fade1 * 0.5, q.shadowLod0, 0);
    const a2c = (profile?.msaa | 0) > 0;
    this.U.ngTreeMisc.value.x = a2c ? 1 : 0;
    /* 影を落とす範囲：近景の影の半幅 + 樹高の分（視野の外の木もここまでは影だけ描く） */
    this.shadowR = (profile?.nearShadow?.extent || 48) + 14;
    ngCutout(this.treeMat, profile, 0.5);
    ngCutout(this.impMat, profile, 0.5);
    ngCutout(this.shellMat, profile, 0.5);
    for (const b of this.batches) ngAttachDepth(b.bm);
    this._buildImpostors();
    this.forceBuild = true;
  }

  setLodScale(k) {
    if (!Number.isFinite(k) || k <= 0) return;
    this.lodScale = Math.min(Math.max(k, 0.25), 4);
    this.forceBuild = true;
  }

  restoreGPU() {
    /* 焼いたテクスチャ・インポスターは文脈の喪失で消える。Phase 1 は作り直さない（core-requests へ）：
       幾何・placement は残るので、次の起動で戻る。ここでは割り当てだけやり直す */
    this.forceBuild = true;
  }

  stats() {
    if (!this.batches) return { draws: 0, tris: 0, instances: 0, texBytes: 0, programs: 0 };
    const P = this.ctx.placement?.trees;
    let tris = 0;
    for (const [k, b] of this.batches.entries()) {
      for (let i = 0; i < b.used; i++) tris += this.geos[k][b.bm.getGeometryIdAt(i)].index.count / 3;
    }
    tris += this.counts.imp * 2 + 256 * 256 * 2;
    return {
      draws: 4, tris, instances: this.counts.lod0 + this.counts.lod1 + this.counts.imp, texBytes: this.texBytes, programs: 4,
      lod0: this.counts.lod0, lod1: this.counts.lod1, proxy: this.counts.proxy, shadowOnly: this.counts.shadowOnly,
      lodDist: [+(this.L0n ?? 0).toFixed(1), +(this.L1n ?? 0).toFixed(1), +(this.L0target ?? 0).toFixed(1), +(this.L1target ?? 0).toFixed(1)], impostors: this.counts.imp, trees: P?.count || 0,
    };
  }

  dispose() {
    super.dispose();
    for (const m of [this.treeMat, this.impMat, this.shellMat]) { m?.userData?.ngDepth?.dispose(); m?.userData?.ngDistance?.dispose(); m?.dispose(); }
    for (const b of this.batches || []) b.bm.dispose();
    this.imp?.alb.dispose(); this.imp?.nrm.dispose();
    this.canopyTex?.dispose();
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new TreesModule(ctx); }
