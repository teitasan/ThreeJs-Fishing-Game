/* ===========================================================
   高さ場の GPU テクスチャと派生マップ（ARCHITECTURE §4.7）
   -----------------------------------------------------------
   world 層（Core-B）の buildHeightGrids の出力をそのまま R32F にして、
   派生（法線・汀線距離・底質・樹冠・被覆）を GPU で作る。
   - 高さ：R32F・Nearest。補間は GLSL の手動バイリニア（glsl/heightfield.glsl.js）
   - 法線：oct（格子と同じ解像度、中心差分）。空いた成分に派生を同居させてサンプラーを 2 枚減らす：
       ngNormalNear = RGBA16F（xy 法線、z 汀線距離 m）、ngNormalFar = RGBA8（xy 法線、zw 樹冠の密度・高さ/40m）
   - 汀線距離：1024² のジャンプフラッド（JFA）の符号付き距離（陸 +、水 −、m）を near の法線へ写す
   - 底質：grids.bed（RGBA8：mud, sand, rock, v）をそのまま（lake.bedAt と一致）
   - 樹冠：placement.trees を CPU で ±512m @2m に散らし（RG8：密度・高さ/40m）、far の法線へ写す
   - 被覆：草・笹・シダ・花の密度（高さ・傾斜・汀線・樹冠からの仮の規則。
     groundcover / terrain が coverRules で差し替える前提の既定値）
   uniforms は共有の {value}。restoreGPU で派生だけ焼き直す
   =========================================================== */
import { buildHeightGrids, sampleGrid } from '../../world/heightgrid.js';
import { NG_HEIGHTFIELD_GLSL } from './glsl/heightfield.glsl.js';
import { NG_HASH_GLSL } from './glsl/noise.glsl.js';

/** 派生マップの範囲（near の格子と同じ ±260m、樹冠は far の ±512m） */
export const NG_HF_MAP = Object.freeze({ nearOrigin: -260, nearSize: 520, farOrigin: -512, farSize: 1024 });
const SHORE_N = 1024, COVER_N = 1024, CANOPY_N = 512;
const CANOPY_H_MAX = 40;

const NORMAL_FRAG = NG_HEIGHTFIELD_GLSL + /* glsl */ `
uniform float ngUseFar;
uniform sampler2D ngShoreSrc;     // JFA の結果（R16F、near の地図 ±260m）
uniform sampler2D ngCanopySrc;    // CPU の樹冠（RG8、far の地図 ±512m）
void main() {
  vec4 g = ngUseFar > 0.5 ? ngHfFar : ngHfNear;
  vec2 xz = g.xy + floor(vUv * g.w) / g.z;
  float e = 1.0 / g.z;
  float hx0, hx1, hz0, hz1;
  if (ngUseFar > 0.5) {
    hx0 = ngGridH(ngHeightFar, g, xz - vec2(e, 0.0)); hx1 = ngGridH(ngHeightFar, g, xz + vec2(e, 0.0));
    hz0 = ngGridH(ngHeightFar, g, xz - vec2(0.0, e)); hz1 = ngGridH(ngHeightFar, g, xz + vec2(0.0, e));
  } else {
    hx0 = ngGridH(ngHeightNear, g, xz - vec2(e, 0.0)); hx1 = ngGridH(ngHeightNear, g, xz + vec2(e, 0.0));
    hz0 = ngGridH(ngHeightNear, g, xz - vec2(0.0, e)); hz1 = ngGridH(ngHeightNear, g, xz + vec2(0.0, e));
  }
  vec3 n = normalize(vec3(hx0 - hx1, 2.0 * e, hz0 - hz1));
  vec2 extra = ngUseFar > 0.5 ? texture(ngCanopySrc, ngFarMapUV(xz)).rg : vec2(texture(ngShoreSrc, ngNearMapUV(xz)).r, 0.0);
  gl_FragColor = vec4(ngOctEncode(n), extra);
}
`;

/* JFA の種：符号の変わる隣があれば、零点をテクセル座標で線形補間して置く */
const JFA_SEED = NG_HEIGHTFIELD_GLSL + /* glsl */ `
vec2 ngMapXZ(vec2 t) { return ngHfMapXf.x + t / ${SHORE_N}.0 / ngHfMapXf.y; }
void main() {
  vec2 t = floor(vUv * ${SHORE_N}.0) + 0.5;
  float h = ngTerrainH(ngMapXZ(t));
  vec2 best = vec2(-1.0); float bd = 1e9;
  for (int k = 0; k < 4; k++) {
    vec2 o = k == 0 ? vec2(1, 0) : k == 1 ? vec2(-1, 0) : k == 2 ? vec2(0, 1) : vec2(0, -1);
    float hn = ngTerrainH(ngMapXZ(t + o));
    if ((h > 0.0) != (hn > 0.0)) {
      float f = clamp(h / (h - hn), 0.0, 1.0);
      if (f < bd) { bd = f; best = t + o * f; }
    }
  }
  gl_FragColor = vec4(best, bd < 1e8 ? 1.0 : 0.0, h);
}
`;
const JFA_STEP = /* glsl */ `
uniform sampler2D ngSrc;
uniform float ngStep;
void main() {
  vec2 t = floor(vUv * ${SHORE_N}.0) + 0.5;
  vec4 me = texture(ngSrc, vUv);
  vec4 best = me; float bd = me.z > 0.5 ? distance(me.xy, t) : 1e9;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 q = t + vec2(float(x), float(y)) * ngStep;
    if (q.x < 0.0 || q.y < 0.0 || q.x >= ${SHORE_N}.0 || q.y >= ${SHORE_N}.0) continue;
    vec4 s = texture(ngSrc, q / ${SHORE_N}.0);
    if (s.z < 0.5) continue;
    float d = distance(s.xy, t);
    if (d < bd) { bd = d; best = vec4(s.xyz, me.w); }
  }
  gl_FragColor = vec4(best.xyz, me.w);
}
`;
const JFA_FINAL = /* glsl */ `
uniform sampler2D ngSrc;
uniform float ngTexelM;
void main() {
  vec2 t = floor(vUv * ${SHORE_N}.0) + 0.5;
  vec4 s = texture(ngSrc, vUv);
  float d = s.z > 0.5 ? distance(s.xy, t) * ngTexelM : 300.0;
  gl_FragColor = vec4(s.w > 0.0 ? d : -d, 0.0, 0.0, 1.0);
}
`;
const COVER_FRAG = NG_HEIGHTFIELD_GLSL + NG_HASH_GLSL + /* glsl */ `
void main() {
  vec2 xz = ngHfMapXf.x + vUv / ngHfMapXf.y;
  float sd = ngShoreD(xz);
  vec3 n = ngTerrainN(xz);
  float slope = sqrt(max(1.0 - n.y * n.y, 0.0)) / max(n.y, 0.05);
  vec2 cn = ngCanopyAt(xz);
  float land = smoothstep(0.3, 1.5, sd);
  float flat01 = 1.0 - smoothstep(0.35, 0.7, slope);
  float open01 = 1.0 - cn.x;
  float grass = land * flat01 * mix(0.25, 1.0, open01);
  float sasa = land * flat01 * cn.x * smoothstep(4.0, 12.0, sd);
  float fern = land * (1.0 - smoothstep(2.0, 14.0, sd)) * mix(0.3, 1.0, cn.x);
  float flower = grass * open01 * step(0.93, ngHash12(floor(xz * 0.5)));
  gl_FragColor = vec4(grass, sasa, fern, flower);
}
`;

/**
 * 高さ場の GPU 側
 */
export class HeightField {
  /**
   * @param {typeof import('three')} THREE
   * @param {import('./forge.js').Forge} forge
   */
  constructor(THREE, forge) {
    this.THREE = THREE;
    this.forge = forge;
    this.grids = null;
    this.ready = false;
    const T = THREE, px = (c) => {
      const t = new T.DataTexture(new Uint8Array(c), 1, 1, T.RGBAFormat);
      t.needsUpdate = true;
      return t;
    };
    const f1 = () => {
      const t = new T.DataTexture(new Float32Array([0]), 1, 1, T.RedFormat, T.FloatType);
      t.needsUpdate = true;
      return t;
    };
    /** GLSL の heightfield ライブラリが読む共有 uniforms（build 前は 1×1 の中立値） */
    this.uniforms = {
      ngHeightNear: { value: f1() }, ngHeightFar: { value: f1() },
      /* 法線（真上）+ 同居の派生。build 前は汀線距離 0・樹冠 0 */
      ngNormalNear: { value: px([128, 128, 0, 0]) }, ngNormalFar: { value: px([128, 128, 0, 0]) },
      ngBedMap: { value: px([255, 0, 0, 0]) }, ngCoverMap: { value: px([0, 0, 0, 0]) },
      ngHfNear: { value: new T.Vector4(0, 0, 1, 1) }, ngHfFar: { value: new T.Vector4(0, 0, 1, 1) },
      ngHfMapXf: { value: new T.Vector4(NG_HF_MAP.nearOrigin, 1 / NG_HF_MAP.nearSize, NG_HF_MAP.farOrigin, 1 / NG_HF_MAP.farSize) },
    };
    this._derived = [];
    this._placement = null;
    /** 同居させる前の派生（lab の表示・デバッグ用。GLSL は ngNormalNear.z / ngNormalFar.zw を読む） */
    this.maps = { shore: null, canopy: null };
  }

  /**
   * 格子を受け取り（無ければ world 層で焼き）、GPU テクスチャと派生を作る
   * @param {{lake:object, grids?:Promise<object>|object|null, placement?:object|null, progress?:(f:number)=>void}} o
   */
  async build({ lake, grids = null, placement = null, progress = null }) {
    const T = this.THREE;
    const g = await (grids || buildHeightGrids(lake, { resolvedSeed: lake.seed }));
    this.grids = g;
    this._placement = placement;
    const u = this.uniforms;
    const hTex = (grid) => {
      const t = new T.DataTexture(grid.data, grid.n, grid.n, T.RedFormat, T.FloatType);
      t.magFilter = t.minFilter = T.NearestFilter;
      t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
      t.unpackAlignment = 1;
      t.needsUpdate = true;
      return t;
    };
    u.ngHeightNear.value = hTex(g.near);
    u.ngHeightFar.value = hTex(g.far);
    u.ngHfNear.value.set(g.near.origin[0], g.near.origin[1], 1 / g.near.step, g.near.n);
    u.ngHfFar.value.set(g.far.origin[0], g.far.origin[1], 1 / g.far.step, g.far.n);
    const bed = new T.DataTexture(g.bed.data, g.bed.n, g.bed.n, T.RGBAFormat);
    bed.magFilter = bed.minFilter = T.LinearFilter;
    bed.wrapS = bed.wrapT = T.ClampToEdgeWrapping;
    bed.needsUpdate = true;
    u.ngBedMap.value = bed;
    progress?.(0.4);
    await this.forge.step();
    this.maps.canopy = this._canopyTexture(placement);
    this._bakeDerived();
    progress?.(1);
    this.ready = true;
  }

  /* 樹冠：木ごとに樹冠の円を密度と高さで散らす（CPU、±512m @2m） */
  _canopyTexture(P) {
    const T = this.THREE;
    const n = CANOPY_N, cell = NG_HF_MAP.farSize / n, o = NG_HF_MAP.farOrigin;
    const dens = new Float32Array(n * n), top = new Float32Array(n * n);
    const tr = P?.trees;
    if (tr && tr.count) {
      for (let k = 0; k < tr.count; k++) {
        const h = tr.h[k], R = Math.max(1.2, h * 0.22);
        const cx = (tr.x[k] - o) / cell, cz = (tr.z[k] - o) / cell, rc = R / cell;
        const i0 = Math.max(0, Math.floor(cx - rc)), i1 = Math.min(n - 1, Math.ceil(cx + rc));
        const j0 = Math.max(0, Math.floor(cz - rc)), j1 = Math.min(n - 1, Math.ceil(cz + rc));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) / rc;
            if (d >= 1) continue;
            const w = 1 - d * d;
            const idx = j * n + i;
            dens[idx] = 1 - (1 - dens[idx]) * (1 - 0.85 * w);
            top[idx] = Math.max(top[idx], h * Math.sqrt(w));   // 地面からの樹冠の上面（半球の断面）
          }
        }
      }
    }
    const data = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      data[i * 4] = Math.round(Math.min(1, dens[i]) * 255);
      data[i * 4 + 1] = Math.round(Math.min(1, top[i] / CANOPY_H_MAX) * 255);
    }
    const t = new T.DataTexture(data, n, n, T.RGBAFormat);
    t.magFilter = t.minFilter = T.LinearFilter;
    t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  /* 汀線距離（JFA）→ 法線（near に汀線距離、far に樹冠を同居）→ 被覆（GPU）。restoreGPU でも呼ぶ。
     JFA の種は高さだけを読み、被覆は同居させた後の ngShoreD / ngCanopyAt を読む */
  _bakeDerived() {
    const T = this.THREE, f = this.forge, u = this.uniforms, g = this.grids;
    for (const t of this._derived) t.dispose();
    this._derived.length = 0;
    const own = (t) => { this._derived.push(t); return t; };
    /* 汀線距離（JFA）。一時 RT は使い捨て */
    const mk = () => f.target(SHORE_N, SHORE_N, { type: T.HalfFloatType, filter: 'nearest', wrap: 'clamp' });
    let a = mk(), b = mk();
    f.run(a, JFA_SEED, { ...u });
    for (let s = SHORE_N / 2; s >= 1; s >>= 1) {
      f.run(b, JFA_STEP, { ngSrc: { value: a.texture }, ngStep: { value: s } });
      [a, b] = [b, a];
    }
    const shore = f.bake2D({
      w: SHORE_N, h: SHORE_N, frag: JFA_FINAL, type: T.HalfFloatType, format: T.RedFormat, wrap: 'clamp',
      uniforms: { ngSrc: { value: a.texture }, ngTexelM: { value: NG_HF_MAP.nearSize / SHORE_N } },
    });
    a.dispose(); b.dispose();
    this.maps.shore = own(shore);
    const normal = (useFar, n, type) => f.bake2D({
      w: n, h: n, frag: NORMAL_FRAG, type, wrap: 'clamp',
      uniforms: { ...u, ngUseFar: { value: useFar }, ngShoreSrc: { value: shore }, ngCanopySrc: { value: this.maps.canopy } },
    });
    u.ngNormalNear.value = own(normal(0, g.near.n, T.HalfFloatType));
    u.ngNormalFar.value = own(normal(1, g.far.n, T.UnsignedByteType));
    u.ngCoverMap.value = own(f.bake2D({ w: COVER_N, h: COVER_N, frag: COVER_FRAG, type: T.UnsignedByteType, wrap: 'clamp', uniforms: { ...u } }));
  }

  /**
   * GPU と同じ補間の高さ（near → far、near の縁 4m でブレンド）
   * @param {number} x
   * @param {number} z
   */
  heightAt(x, z) {
    const g = this.grids;
    if (!g) return 0;
    const hf = sampleGrid(g.far, x, z);
    const lo = g.near.origin, hi = [lo[0] + (g.near.n - 1) * g.near.step, lo[1] + (g.near.n - 1) * g.near.step];
    const inset = Math.min(x - lo[0], hi[0] - x, z - lo[1], hi[1] - z);
    const k = smoothstep(0, 4, inset);
    return k > 0 ? hf + (sampleGrid(g.near, x, z) - hf) * k : hf;
  }

  /** 文脈の喪失から戻ったとき：DataTexture は three が上げ直すので、派生だけ焼き直す。
   *  古い派生は dispose しない（喪失前の GL の物を消すと «別の文脈の物» の警告が出るだけ。GL 側はもう無い） */
  restoreGPU() {
    if (!this.grids) return;
    this._derived.length = 0;
    this._bakeDerived();
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
