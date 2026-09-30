/* ===========================================================
   trees のグレーボックス（本番の代替も兼ねる）
   -----------------------------------------------------------
   placement.trees の位置に «幹の円柱 + 樹冠（針葉 = 円錐、広葉 = 潰した多面体）» を
   インスタンスで描く。寸法と色は src/world/species.js（当たりと同じ表）。
   - 描く木：rank < TIER_DENSITY.trees[tier]、または mustDraw（帯の中 + 12m の当たりのある木）
   - 120m のセルごとに InstancedMesh を分けて視錐台で間引く
   - 風：ngWindAt で樹冠を揺らす（depth: true なので影も揺れる）
   =========================================================== */
import { NgModule } from '../module.js';
import { NG_LAYER, ngOwn } from '../layers.js';
import { ngExtendStandard, ngAttachDepth } from '../extend.js';
import { NG_WIND_GLSL } from '../glsl/wind.glsl.js';
import { SPECIES, SPECIES_IDS } from '../../../world/species.js';
import { TIER_DENSITY } from '../../../world/placement.js';

const CELL = 120;

/* 揺れ：局所の高さ（0..1）の 2 乗で曲げる。量は世界の m で決めてから、インスタンスの行列の逆で
   ローカルへ戻す。行列は «y 軸の回転 × 拡大» なので逆は Mᵀ を列の長さの 2 乗で割るだけ
   （頂点ごとの inverse(mat3) は重い。影のパスでも同じ頂点シェーダが走る） */
const SWAY = /* glsl */ `
#ifdef USE_INSTANCING
  vec3 ngRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  mat3 ngM = mat3(instanceMatrix);
  vec3 ngS2 = vec3(dot(ngM[0], ngM[0]), dot(ngM[1], ngM[1]), dot(ngM[2], ngM[2]));
  vec4 ngW = ngWindAt(ngRoot.xz);
  float ngA = 0.012 * sqrt(ngS2.y) * (ngW.z / 5.0) * position.y * position.y * (0.75 + 0.25 * sin(ngEnvTime * 1.3 + ngRoot.x * 0.3));
  transformed += (transpose(ngM) * vec3(ngW.x * ngA, 0.0, ngW.y * ngA)) / ngS2;
#endif
`;

/**
 * グレーボックスの trees
 */
export class TreesStub extends NgModule {
  static id = 'trees';

  constructor(ctx) {
    super(ctx);
    this.cells = [];
    this.count = 0;
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE;
    const make = (key, color) => ngExtendStandard(new T.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 }), {
      key, module: 'trees', vertex: { pars: NG_WIND_GLSL, begin: SWAY }, hfShadow: true, depth: true,
    });
    this.mats = { crown: make('trees-stub-crown', 0xffffff), trunk: make('trees-stub-trunk', 0xffffff) };
    const cone = new T.ConeGeometry(1, 1, 9, 1);
    cone.translate(0, 0.5, 0);
    const blob = new T.IcosahedronGeometry(0.5, 0);   // 20 面。グレーボックスは形より本数（影のパスも頂点で効く）
    blob.scale(1, 0.8, 1);
    blob.translate(0, 0.5, 0);
    const trunk = new T.CylinderGeometry(0.8, 1, 1, 7, 1);
    trunk.translate(0, 0.5, 0);
    this.geos = { cone, blob, trunk };
    this._build(ctx.tier);
    ngOwn(this.root, NG_LAYER.WORLD);
    ctx.scene.add(this.root);
    progress?.(1);
  }

  _build(tier) {
    const T = this.ctx.THREE, P = this.ctx.placement?.trees;
    for (const c of this.cells) { this.root.remove(c); c.dispose(); }
    this.cells = [];
    this.count = 0;
    if (!P || !P.count) return;
    const dens = TIER_DENSITY.trees[tier] ?? 1;
    const buckets = new Map();
    for (let k = 0; k < P.count; k++) {
      if (!(P.rank[k] < dens || P.mustDraw[k])) continue;
      const key = `${Math.floor(P.x[k] / CELL)},${Math.floor(P.z[k] / CELL)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(k);
    }
    const m = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(), p = new T.Vector3(), e = new T.Euler();
    const col = new T.Color();
    for (const list of buckets.values()) {
      const conifer = [], broad = [];
      for (const k of list) {
        const form = SPECIES[SPECIES_IDS[P.species[k]]]?.form;
        (form === 'broadleaf' || form === 'weeping' ? broad : conifer).push(k);
      }
      const groups = [[this.geos.cone, conifer, 'crown'], [this.geos.blob, broad, 'crown'], [this.geos.trunk, list, 'trunk']];
      for (const [geo, ids, part] of groups) {
        if (!ids.length) continue;
        const im = new T.InstancedMesh(geo, this.mats[part], ids.length);
        ids.forEach((k, n) => {
          const S = SPECIES[SPECIES_IDS[P.species[k]]] || SPECIES.sugi;
          const h = P.h[k];
          e.set(0, P.rot[k], 0);
          q.setFromEuler(e);
          if (part === 'trunk') {
            const r = Math.max(S.trunkR[P.variant[k] | 0] * h, 0.08);
            p.set(P.x[k], P.y[k], P.z[k]);
            s.set(r, h * (S.crownBase + 0.2), r);
            col.setRGB(S.bark[0], S.bark[1], S.bark[2]);
          } else {
            const base = h * S.crownBase, rr = S.crownR * h;
            p.set(P.x[k], P.y[k] + base, P.z[k]);
            s.set(rr, h - base, rr);
            const v = 0.85 + 0.3 * ((k * 0.61803) % 1);
            col.setRGB(S.leaf[0] * v, S.leaf[1] * v, S.leaf[2] * v);
          }
          m.compose(p, q, s);
          im.setMatrixAt(n, m);
          im.setColorAt(n, col);
        });
        im.instanceMatrix.needsUpdate = true;
        im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = true;
        im.receiveShadow = true;
        ngAttachDepth(im);
        this.root.add(im);
        this.cells.push(im);
      }
      this.count += list.length;
    }
    ngOwn(this.root, NG_LAYER.WORLD);
  }

  setQuality(tier) { if (this.mats) this._build(tier); }

  stats() {
    let tris = 0;
    for (const c of this.cells) tris += (c.geometry.index ? c.geometry.index.count : c.geometry.attributes.position.count) / 3 * c.count;
    return { draws: this.cells.length, tris, instances: this.count, texBytes: 0, programs: 2 };
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new TreesStub(ctx); }
