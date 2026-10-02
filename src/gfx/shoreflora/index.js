/* ===========================================================
   shoreflora（水生植物）— ARCHITECTURE §6.7
   -----------------------------------------------------------
   1. ヨシ・マコモ（placement.reeds、葦際）：近い株は幾何（reeds.glsl.js、茎 8 × 6 節 + 葉 + 穂）、
      反射は LOD1（茎 5 本・葉 2 枚）、近い株の外は株のカード。近い株の選び出しは CPU（カメラが動いたら）。
      茎は water の減衰体（services.water.addDamper、init で 1 回）。近景の影を落とす
   2. 浮葉（placement.lilies）：ヒツジグサの葉と花・ヒシのロゼット。頂点の y は CPU の surfaceY と同じ波の式
   3. 沈水植物（placement.weeds、lake.flats の藻場）：流れで揺れる帯。UNDERWATER 層、caustics
   本数の段は placement の rank の入れ子（isVisible）。Math.random なし
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { NG_PASS } from '../core/frame.js';
import { ngExtendStandard, ngAttachDepth, ngCutout, ngShaderMaterial } from '../core/extend.js';
import { isVisible } from '../../world/placement.js';
import { hash01 } from '../../world/rng.js';
import { SF_QUALITY, SF_TPL, sfStemCount, sfWeedFillers } from './quality.js';
import {
  SF_REED_VS_PARS, SF_REED_VS_NORMAL, SF_REED_VS_BEGIN, SF_REED_FS_PARS, SF_REED_FS_SURFACE, SF_REED_FS_ALPHA,
  SF_REED_FS_ROUGH, SF_REED_FS_LIGHTS, SF_REED_FS_AO, reedTemplate, reedCardTemplate,
} from './reeds.glsl.js';
import {
  SF_LILY_VS_PARS, SF_LILY_VS_NORMAL, SF_LILY_VS_BEGIN, SF_LILY_FS_PARS, SF_LILY_FS_SURFACE, SF_LILY_FS_NORMAL,
  SF_LILY_FS_ROUGH, SF_LILY_FS_LIGHTS, lilyTemplate,
  SF_WEED_VS_PARS, SF_WEED_VS_NORMAL, SF_WEED_VS_BEGIN, SF_WEED_FS_PARS, SF_WEED_FS_SURFACE, SF_WEED_FS_ALPHA,
  SF_WEED_FS_ROUGH, SF_WEED_FS_LIGHTS, weedTemplate,
} from './aquatic.glsl.js';
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { NG_WAVE_GLSL } from '../core/glsl/wave.glsl.js';

const ID = 'shoreflora';
/** 反射の LOD1 の茎を描く距離 m（その先はカード） */
const SF_REFL_NEAR = 40;
/** 近景の型板（茎 12 本・葉 5 枚）を使う距離 m（+ 株ごとに 0..6m）。その先の近い株は LOD1 の型板 */
const SF_MID_D = 26;

export class ShorefloraModule extends NgModule {
  static id = ID;

  constructor(ctx) {
    super(ctx);
    const T = ctx.THREE;
    this.tier = ctx.tier || 'high';
    this.profile = ctx.profile || null;
    this.lod = 1;
    this.reedU = { ngSfCam: { value: new T.Vector3() } };
    this.waveU = { ngSfWave: { value: new T.Vector4(0, 1, 0, 0) } };
    this.flowU = { ngSfFlow: { value: new T.Vector4(1, 0, 0.04, 0) } };
    this._sel = null;
    this._frustum = new T.Frustum();
    this._m4 = new T.Matrix4();
    this._sph = new T.Sphere();
    this.debug = { reedsNear: 0, reedsCard: 0, stemsNear: 0, lilies: 0, weeds: 0, dampers: 0 };
  }

  async init(progress) {
    const { THREE: T, placement, heightfield, services, forge, lake } = this.ctx;
    if (!placement || !heightfield) throw new Error('shoreflora: placement / heightfield が無い');
    /* ---- 1. ヨシ ---- */
    const reeds = (placement.reeds || []).filter((r) => [r.x, r.z, r.height].every(Number.isFinite)).slice().sort((a, b) => a.rank - b.rank);
    this.reeds = reeds;
    const n = Math.max(1, reeds.length);
    this.rA0 = new Float32Array(n * 4);
    this.rA1 = new Float32Array(n * 4);
    reeds.forEach((r, i) => {
      const y = Math.min(heightfield.heightAt(r.x, r.z), -0.02);
      this.rA0.set([r.x, y, r.z, r.height], i * 4);
      this.rA1.set([r.density, r.rot, r.kind, hash01(placement.seed ?? 1, i, 77)], i * 4);
    });
    this.nearA0 = new T.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(T.DynamicDrawUsage);
    this.nearA1 = new T.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(T.DynamicDrawUsage);
    this.midA0 = new T.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(T.DynamicDrawUsage);
    this.midA1 = new T.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(T.DynamicDrawUsage);
    this.cardA0 = new T.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(T.DynamicDrawUsage);
    this.cardA1 = new T.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(T.DynamicDrawUsage);
    const reedMat = (mode) => {
      const ru = { value: new T.Vector4(mode, 80, 10, 420) };
      const u = { ngSfReed: ru, ngSfCam: this.reedU.ngSfCam };
      const m = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.6, metalness: 0, side: T.DoubleSide, alphaTest: 0.5 }), {
        key: 'sf-reed', module: ID, uniforms: u,
        vertex: { pars: SF_REED_VS_PARS, normal: SF_REED_VS_NORMAL, begin: SF_REED_VS_BEGIN },
        fragment: { pars: SF_REED_FS_PARS, surface: SF_REED_FS_SURFACE, alpha: SF_REED_FS_ALPHA, rough: SF_REED_FS_ROUGH, lights: SF_REED_FS_LIGHTS, ao: SF_REED_FS_AO },
        depth: true,
      });
      m.userData.sfMode = mode;
      m.userData.ngSfReedU = ru;
      return m;
    };
    const mk = (geo, a0, a1, mat, name) => {
      geo.setAttribute('ngRi0', a0);
      geo.setAttribute('ngRi1', a1);
      const mesh = new T.Mesh(geo, mat);
      mesh.name = name;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      return mesh;
    };
    this.reedNear = mk(reedTemplate(T, SF_TPL.reed, true), this.nearA0, this.nearA1, reedMat(0), 'ng-sf-reeds');
    this.reedNear.castShadow = true;
    ngAttachDepth(this.reedNear);
    this.reedLod1 = mk(reedTemplate(T, SF_TPL.reedLod1, true), this.nearA0, this.nearA1, reedMat(1), 'ng-sf-reeds-lod1');
    this.reedLod1.visible = false;
    /* 中景（SF_MID_D より先の近い株）：LOD1 の型板（茎 6 本・葉 2 枚）を主のパスで。LOD1 と同じマテリアル */
    this.reedMid = mk(reedTemplate(T, SF_TPL.reedLod1, true), this.midA0, this.midA1, this.reedLod1.material, 'ng-sf-reeds-mid');
    this.reedCard = mk(reedCardTemplate(T), this.cardA0, this.cardA1, reedMat(2), 'ng-sf-reed-cards');
    this.reedMats = [this.reedNear.material, this.reedLod1.material, this.reedCard.material];
    /* 減衰体：株の円（init で 1 回。core が一覧を持つ） */
    try {
      const list = reeds.map((r) => ({ x: r.x, z: r.z, r: 0.15 + 0.3 * Math.max(0, Math.min(1, r.density)) }));
      services.water.addDamper(list);
      this.debug.dampers = list.length;
    } catch (e) { this.ctx.log?.('sf-damper', e); }
    await forge.step();
    progress?.(0.4);

    /* ---- 2. 浮葉 ---- */
    const lilies = (placement.lilies || []).filter((l) => [l.x, l.z].every(Number.isFinite)).slice().sort((a, b) => a.rank - b.rank);
    this.lilies = lilies;
    const nl = Math.max(1, lilies.length);
    const l0 = new Float32Array(nl * 4), l1 = new Float32Array(nl * 4);
    lilies.forEach((l, i) => {
      const h = hash01(placement.seed ?? 1, i, 91);
      /* ヒシ（kind 1）は深め・開けた所に多い */
      const kind = h < 0.28 + 0.25 * Math.min(1, Math.max(0, (l.depth - 0.6) / 0.6)) ? 1 : 0;
      l0.set([l.x, l.z, l.spread || 0.6, l.rot || 0], i * 4);
      l1.set([l.flower ? 1 : 0, kind, hash01(placement.seed ?? 1, i, 92), l.depth || 0.5], i * 4);
    });
    const lg = lilyTemplate(T);
    lg.setAttribute('ngLi0', new T.InstancedBufferAttribute(l0, 4));
    lg.setAttribute('ngLi1', new T.InstancedBufferAttribute(l1, 4));
    const lilyMat = ngExtendStandard(new T.MeshStandardMaterial({
      roughness: 0.25, metalness: 0, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }), {
      key: 'sf-lily', module: ID, uniforms: { ...heightfield.uniforms, ...this.waveU },
      vertex: { pars: SF_LILY_VS_PARS, normal: SF_LILY_VS_NORMAL, begin: SF_LILY_VS_BEGIN },
      fragment: { pars: SF_LILY_FS_PARS, surface: SF_LILY_FS_SURFACE, normal: SF_LILY_FS_NORMAL, rough: SF_LILY_FS_ROUGH, lights: SF_LILY_FS_LIGHTS },
    });
    this.lily = new T.Mesh(lg, lilyMat);
    this.lily.name = 'ng-sf-lilies';
    this.lily.frustumCulled = false;
    this.lily.receiveShadow = true;
    this.root.add(this.lily);
    await forge.step();
    progress?.(0.6);

    /* ---- 3. 沈水植物 ---- */
    const base = (placement.weeds || []).filter((w) => [w.x, w.z, w.height].every(Number.isFinite));
    const seed = placement.seed ?? 1;
    const fill = sfWeedFillers(lake?.flats || [], base, (x, z) => Math.max(-heightfield.heightAt(x, z), 0), (i, j, k) => hash01(seed + k * 7919, i, j));
    this.weedFillers = fill.length;
    const weeds = base.concat(fill).sort((a, b) => a.rank - b.rank);
    this.weeds = weeds;
    const nw = Math.max(1, weeds.length);
    const w0 = new Float32Array(nw * 4), w1 = new Float32Array(nw * 4);
    weeds.forEach((w, i) => {
      const y = heightfield.heightAt(w.x, w.z);
      w0.set([w.x, Number.isFinite(y) ? y : w.y, w.z, w.height], i * 4);
      w1.set([w.rot || 0, w.flat || 0, w.rank, hash01(placement.seed ?? 1, i, 93)], i * 4);
    });
    const wg = weedTemplate(T);
    wg.setAttribute('ngWi0', new T.InstancedBufferAttribute(w0, 4));
    wg.setAttribute('ngWi1', new T.InstancedBufferAttribute(w1, 4));
    const weedMat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.55, metalness: 0, side: T.DoubleSide, alphaTest: 0.5 }), {
      key: 'sf-weed', module: ID, uniforms: { ...this.flowU },
      vertex: { pars: SF_WEED_VS_PARS, normal: SF_WEED_VS_NORMAL, begin: SF_WEED_VS_BEGIN },
      fragment: { pars: SF_WEED_FS_PARS, surface: SF_WEED_FS_SURFACE, alpha: SF_WEED_FS_ALPHA, rough: SF_WEED_FS_ROUGH, lights: SF_WEED_FS_LIGHTS },
      caustics: true,
    });
    this.weed = new T.Mesh(wg, weedMat);
    this.weed.name = 'ng-sf-weeds';
    this.weed.frustumCulled = false;
    this.weed.receiveShadow = true;
    this.root.add(this.weed);
    progress?.(0.8);

    ngOwn(this.root, NG_LAYER.WORLD);
    ngOwn(this.lily, NG_LAYER.NO_REFLECT);
    ngOwn(this.weed, NG_LAYER.UNDERWATER);
    this._applyTier(this.tier, this.profile);
    this.ctx.scene.add(this.root);
    progress?.(1);
  }

  _applyTier(tier, profile) {
    this.tier = SF_QUALITY[tier] ? tier : 'high';
    if (profile) this.profile = profile;
    const q = SF_QUALITY[this.tier];
    const cnt = (list, sys) => { let k = 0; while (k < list.length && isVisible(sys, list[k].rank, this.tier)) k++; return k; };
    this.reedTierN = cnt(this.reeds || [], 'reeds');
    if (this.lily) this.lily.geometry.instanceCount = cnt(this.lilies, 'lilies');
    if (this.weed) this.weed.geometry.instanceCount = cnt(this.weeds, 'weeds');
    this.debug.lilies = this.lily?.geometry.instanceCount || 0;
    this.debug.weeds = this.weed?.geometry.instanceCount || 0;
    this.debug.weedFillers = this.weedFillers || 0;
    for (const m of this.reedMats || []) ngCutout(m, this.profile, 0.5);
    if (this.reedNear) ngAttachDepth(this.reedNear);
    if (this.weed) ngCutout(this.weed.material, this.profile, 0.5);
    this._sel = null;
  }

  /* 近い株とカードの選び出し（カメラが 1.5m 動くか 4° 向きを変えたら）。近い株は主の視錐台か、その水面の鏡像が入る物 */
  _select(cam) {
    const p = cam.position;
    const fx = -cam.matrixWorld.elements[8], fz = -cam.matrixWorld.elements[10], fy = -cam.matrixWorld.elements[9];
    const s = this._sel;
    if (s && s.tier === this.tier && Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) < 1.5 && fx * s.fx + fy * s.fy + fz * s.fz > 0.9976) return;
    this._sel = { x: p.x, y: p.y, z: p.z, fx, fy, fz, tier: this.tier };
    const q = SF_QUALITY[this.tier];
    const near = q.near * this.lod, far = q.card * this.lod;
    this._frustum.setFromProjectionMatrix(this._m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const fr = this._frustum, sph = this._sph;
    const A0 = this.rA0, A1 = this.rA1, N0 = this.nearA0.array, N1 = this.nearA1.array, C0 = this.cardA0.array, C1 = this.cardA1.array;
    let nn = 0, nm = 0, nc = 0, stems = 0;
    const M0 = this.midA0.array, M1 = this.midA1.array;
    for (let i = 0; i < this.reedTierN; i++) {
      const o = i * 4, x = A0[o], z = A0[o + 2], h = A0[o + 3];
      const d = Math.hypot(x - p.x, z - p.z);
      if (d > far) continue;
      if (d < near) {
        sph.center.set(x, h * 0.5, z); sph.radius = h * 0.6 + 1.2;
        let vis = fr.intersectsSphere(sph);
        if (!vis) { sph.center.y = -h * 0.5; vis = fr.intersectsSphere(sph); }
        if (vis) {
          /* 近景の型板は SF_MID_D（株ごとに +0..6m のずれ：輪の線を出さない）まで、その先は LOD1 の型板 */
          if (d < SF_MID_D + 6 * A1[o + 3]) {
            N0.set(A0.subarray(o, o + 4), nn * 4); N1.set(A1.subarray(o, o + 4), nn * 4); nn++;
            stems += sfStemCount(A1[o]);
          } else {
            M0.set(A0.subarray(o, o + 4), nm * 4); M1.set(A1.subarray(o, o + 4), nm * 4); nm++;
            stems += Math.min(6, sfStemCount(A1[o]));
          }
        }
      }
      if (d > near - q.fadeBand || (d > 15 && A1[o] > 0.35)) { C0.set(A0.subarray(o, o + 4), nc * 4); C1.set(A1.subarray(o, o + 4), nc * 4); nc++; }
    }
    for (const a of [this.nearA0, this.nearA1]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(nn, 1) * 4); a.needsUpdate = true; }
    for (const a of [this.midA0, this.midA1]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(nm, 1) * 4); a.needsUpdate = true; }
    for (const a of [this.cardA0, this.cardA1]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(nc, 1) * 4); a.needsUpdate = true; }
    this.reedNear.geometry.instanceCount = nn;
    this.reedLod1.geometry.instanceCount = nn;
    this.reedMid.geometry.instanceCount = nm;
    this.reedCard.geometry.instanceCount = nc;
    this.debug.reedsMid = nm;
    this.debug.reedsNear = nn; this.debug.reedsCard = nc; this.debug.stemsNear = stems;
  }

  prepare(f) {
    const cam = f.camera;
    if (!cam || !this.reedNear) return;
    cam.updateMatrixWorld();
    this.reedU.ngSfCam.value.copy(cam.position);
    const q = SF_QUALITY[this.tier];
    for (const m of this.reedMats) {
      const u = m.userData.ngSfReedU;
      if (u) u.value.set(m.userData.sfMode, q.near * this.lod, q.fadeBand, q.card * this.lod);
    }
    const wt = Number.isFinite(f.waterTime) ? f.waterTime : 0, ww = Number.isFinite(f.waterWind) ? f.waterWind : 1;
    this.waveU.ngSfWave.value.set(wt, ww, 0, 0);
    const fd = f.flowDir, fs = Number.isFinite(f.flowStrength) ? f.flowStrength : 0.04;
    if (fd && Number.isFinite(fd.x) && Number.isFinite(fd.y)) {
      const l = Math.hypot(fd.x, fd.y) || 1;
      this.flowU.ngSfFlow.value.set(fd.x / l, fd.y / l, fs, 0);
    }
    this._select(cam);
  }

  beforePass(passId) {
    if (!this.reedNear) return;
    const refl = passId === NG_PASS.REFLECTION;
    this.reedNear.visible = !refl;
    this.reedLod1.visible = refl;
    /* 反射では LOD1 の茎を 40m まで、その先は株のカード（反射は粗く揺れるので幾何は要らない）。主のパスでは元の距離 */
    const q = SF_QUALITY[this.tier];
    const near = (refl ? Math.min(SF_REFL_NEAR, q.near) : q.near) * this.lod;
    for (const m of [this.reedLod1.material, this.reedCard.material]) {
      const u = m.userData.ngSfReedU;
      if (u) u.value.y = near;
    }
  }

  setQuality(tier, profile) { this._applyTier(tier, profile); }

  setLodScale(k) { if (Number.isFinite(k) && k > 0) { this.lod = Math.min(2, Math.max(0.25, k)); this._applyTier(this.tier, this.profile); } }

  /**
   * 検査用：浮葉の中心の高さを GPU の式（ngLiSurf と同じ）で読む。points: [{x, z}]、t・wind は今の uniform
   * @returns {number[]|null}
   */
  debugLilySurface(points) {
    const { THREE: T, renderer, heightfield } = this.ctx;
    const n = Math.min(points.length, 256);
    if (!n) return [];
    const data = new Float32Array(256 * 4);
    points.slice(0, n).forEach((p, i) => { data[i * 4] = p.x; data[i * 4 + 1] = p.z; });
    const tex = new T.DataTexture(data, 256, 1, T.RGBAFormat, T.FloatType);
    tex.needsUpdate = true;
    const rt = new T.WebGLRenderTarget(256, 1, { type: T.FloatType, minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false });
    const mat = ngShaderMaterial({
      key: 'sf-probe', module: ID, lights: false, fog: false, depthTest: false, depthWrite: false,
      uniforms: { ...heightfield.uniforms, ...this.waveU, ngSfPts: { value: tex } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: NG_HEIGHTFIELD_GLSL + NG_WAVE_GLSL + `
uniform highp sampler2D ngSfPts;
uniform vec4 ngSfWave;
void main() {
  vec2 p = texelFetch(ngSfPts, ivec2(gl_FragCoord.xy), 0).xy;
  float d = ngDepth(p);
  float h = d <= 0.0 ? 0.0 : ngWaveH(p, ngSfWave.x) * ngSfWave.y * ngShoalGain(d);
  gl_FragColor = vec4(h + 0.012, d, 0.0, 1.0);
}`,
    });
    const sc = new T.Scene(), q = new T.Mesh(new T.PlaneGeometry(2, 2), mat);
    q.frustumCulled = false;
    sc.add(q);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(sc, new T.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    const out = new Float32Array(256 * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, 256, 1, out);
    renderer.setRenderTarget(prev);
    rt.dispose(); tex.dispose(); mat.dispose(); q.geometry.dispose();
    return Array.from({ length: n }, (_, i) => out[i * 4]);
  }

  stats() {
    const nr = this.reedNear?.geometry.instanceCount || 0, nc = this.reedCard?.geometry.instanceCount || 0;
    const nm = this.reedMid?.geometry.instanceCount || 0;
    const nl = this.lily?.geometry.instanceCount || 0, nw = this.weed?.geometry.instanceCount || 0;
    const tri = (m) => (m?.geometry.index ? m.geometry.index.count / 3 : 0);
    const draws = (nr ? 1 : 0) + (nm ? 1 : 0) + (nc ? 1 : 0) + (nl ? 1 : 0) + (nw ? 1 : 0);
    return {
      draws, tris: nr * tri(this.reedNear) + nm * tri(this.reedMid) + nc * 2 + nl * tri(this.lily) + nw * tri(this.weed),
      instances: nr + nm + nc + nl + nw, texBytes: 0, programs: 4,
    };
  }

  dispose() {
    for (const m of this.reedMats || []) m.dispose();
    this.lily?.material.dispose();
    this.weed?.material.dispose();
    super.dispose();
  }
}

export function createModule(ctx) { return new ShorefloraModule(ctx); }
