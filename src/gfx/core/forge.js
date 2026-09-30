/* ===========================================================
   forge：起動時のテクスチャ合成（ARCHITECTURE §4.8）
   -----------------------------------------------------------
   外部アセットゼロ。ノイズ・素材・派生マップはすべてここで GPU に描いて作る。
   - bake2D / bakeArray / bake3D：全画面三角形 1 枚で RT に描く
     frag は main() を持つ断片シェーダ本体（three が GLSL ES 3.00 で組む。gl_FragColor に書く）。使える入力：
       varying vec2 vUv（0..1）、uniform float ngLayer（配列の層番号）、
       uniform float ngSlice（3D の z、0..1 のテクセル中心）、uniform vec2 ngTexel（1/サイズ）
   - coverageAlpha：mip ごとに «基準 ref を超える画素の割合» を α に入れる。
     alphaTest / alpha-to-coverage が遠くで痩せない（葉のカード）
   - 1 回の焼き込みは GPU に投げるだけなので速い。重い CPU 処理（ブルーノイズ）は
     step() で 30ms ごとに await して読み込み画面を止めない
   =========================================================== */
import { NG, NG_PASS } from './frame.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG_HEAD = /* glsl */ `
varying vec2 vUv;
uniform float ngLayer;
uniform float ngSlice;
uniform vec2 ngTexel;
`;

/* 被覆保存の縮小：色は α で重み付けした平均、α は «子の被覆の平均»。
   段 1 だけは子の α を ref で 0/1 にしてから平均する（以降は割合の平均） */
const COVERAGE_DOWN = /* glsl */ `
uniform sampler2D ngSrc;
uniform float ngSrcLod;
uniform float ngRef;
uniform float ngFirst;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec4 s0 = texelFetch(ngSrc, p, int(ngSrcLod));
  vec4 s1 = texelFetch(ngSrc, p + ivec2(1, 0), int(ngSrcLod));
  vec4 s2 = texelFetch(ngSrc, p + ivec2(0, 1), int(ngSrcLod));
  vec4 s3 = texelFetch(ngSrc, p + ivec2(1, 1), int(ngSrcLod));
  vec4 a = vec4(s0.a, s1.a, s2.a, s3.a);
  vec4 c = ngFirst > 0.5 ? step(vec4(ngRef), a) : a;
  float wsum = max(dot(a, vec4(1.0)), 1e-5);
  vec3 rgb = (s0.rgb * s0.a + s1.rgb * s1.a + s2.rgb * s2.a + s3.rgb * s3.a) / wsum;
  gl_FragColor = vec4(rgb, dot(c, vec4(0.25)));
}
`;

/**
 * 起動時の焼き込み器。作った RT は forge が持ち、dispose で解放する
 */
export class Forge {
  /**
   * @param {typeof import('three')} THREE
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('./frame.js').NgFrame|null} [frame] renderView の間だけ passId を BAKE にする（媒質を掛けない）
   */
  constructor(THREE, renderer, frame = null) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.frame = frame;
    this._scene = null;
    this._cam = null;
    this._tri = null;
    this._mats = new Map();
    this._owned = new Set();
    this._t0 = now();
    this._blue = null;
  }

  _quad(frag, uniforms) {
    const T = this.THREE;
    if (!this._tri) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      this._tri = new T.Mesh(g, null);
      this._tri.frustumCulled = false;
      this._scene = new T.Scene();
      this._scene.add(this._tri);
      this._cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    let mat = this._mats.get(frag);
    if (!mat) {
      mat = new T.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG_HEAD + frag,
        uniforms: { ngLayer: { value: 0 }, ngSlice: { value: 0 }, ngTexel: { value: new T.Vector2() } },
        depthTest: false, depthWrite: false,
      });
      this._mats.set(frag, mat);
    }
    Object.assign(mat.uniforms, uniforms);
    this._tri.material = mat;
    return mat;
  }

  _draw(rt, layer = 0, level = 0) {
    const r = this.renderer;
    const prev = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(rt, layer, level);
    r.render(this._scene, this._cam);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
  }

  _target(Ctor, w, h, d, { type, format, filter, wrap, mips }) {
    const T = this.THREE;
    const rt = d ? new Ctor(w, h, d, { depthBuffer: false }) : new Ctor(w, h, { depthBuffer: false });
    const tex = rt.texture;
    tex.type = type ?? T.HalfFloatType;
    tex.format = format ?? T.RGBAFormat;
    const lin = filter !== 'nearest';
    tex.magFilter = lin ? T.LinearFilter : T.NearestFilter;
    tex.minFilter = mips ? T.LinearMipmapLinearFilter : lin ? T.LinearFilter : T.NearestFilter;
    tex.generateMipmaps = !!mips;
    const wr = wrap === 'clamp' ? T.ClampToEdgeWrapping : T.RepeatWrapping;
    tex.wrapS = tex.wrapT = wr;
    if (d) tex.wrapR = wr;
    this._owned.add(rt);
    return rt;
  }

  /**
   * 2D テクスチャを焼く
   * @param {{w:number, h:number, frag:string, uniforms?:object, type?:number, format?:number,
   *          mips?:boolean, coverageAlpha?:number, filter?:'linear'|'nearest', wrap?:'repeat'|'clamp',
   *          colorSpace?:string, anisotropy?:number}} o
   * @returns {import('three').Texture} RT のテクスチャ（RT は forge が持つ）
   */
  bake2D(o) {
    const T = this.THREE;
    const rt = this._target(T.WebGLRenderTarget, o.w, o.h, 0, o);
    if (o.colorSpace) rt.texture.colorSpace = o.colorSpace;
    if (o.anisotropy) rt.texture.anisotropy = o.anisotropy;
    rt.texture.userData.ngBake = o;
    this._render2D(rt, o);
    return rt.texture;
  }

  _render2D(rt, o) {
    const m = this._quad(o.frag, o.uniforms || {});
    m.uniforms.ngTexel.value.set(1 / o.w, 1 / o.h);
    if (!(o.mips && o.coverageAlpha > 0)) { this._draw(rt); return; }
    /* 被覆保存の mip：一度 generateMipmaps=true で全段を確保させてから自動生成を止め、段ごとに描く */
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.setRenderTarget(prev);
    rt.texture.generateMipmaps = false;
    this._draw(rt);
    const down = this._quad(COVERAGE_DOWN, {
      ngSrc: { value: rt.texture }, ngSrcLod: { value: 0 }, ngRef: { value: o.coverageAlpha }, ngFirst: { value: 1 },
    });
    const levels = Math.floor(Math.log2(Math.max(o.w, o.h)));
    for (let l = 1; l <= levels; l++) {
      down.uniforms.ngSrcLod.value = l - 1;
      down.uniforms.ngFirst.value = l === 1 ? 1 : 0;
      rt.viewport.set(0, 0, Math.max(1, o.w >> l), Math.max(1, o.h >> l));
      this._draw(rt, 0, l);
    }
    rt.viewport.set(0, 0, o.w, o.h);
  }

  /**
   * 配列テクスチャを焼く（層ごとに ngLayer を変えて描く）
   * @param {{w:number, h:number, layers:number, frag:string, uniforms?:object, type?:number, format?:number,
   *          mips?:boolean, filter?:'linear'|'nearest', wrap?:'repeat'|'clamp'}} o
   * @returns {import('three').Texture}
   */
  bakeArray(o) {
    const T = this.THREE;
    const rt = this._target(T.WebGLArrayRenderTarget, o.w, o.h, o.layers, o);
    rt.texture.userData.ngBake = o;
    const m = this._quad(o.frag, o.uniforms || {});
    m.uniforms.ngTexel.value.set(1 / o.w, 1 / o.h);
    for (let l = 0; l < o.layers; l++) {
      m.uniforms.ngLayer.value = l;
      this._draw(rt, l);
    }
    return rt.texture;
  }

  /**
   * 3D テクスチャを焼く（z スライスごとに ngSlice を変えて描く）
   * @param {{w:number, h:number, d:number, frag:string, uniforms?:object, type?:number, format?:number,
   *          filter?:'linear'|'nearest', wrap?:'repeat'|'clamp'}} o
   * @returns {import('three').Texture}
   */
  bake3D(o) {
    const T = this.THREE;
    const rt = this._target(T.WebGL3DRenderTarget, o.w, o.h, o.d, { ...o, mips: false });
    rt.texture.userData.ngBake = o;
    const m = this._quad(o.frag, o.uniforms || {});
    m.uniforms.ngTexel.value.set(1 / o.w, 1 / o.h);
    for (let z = 0; z < o.d; z++) {
      m.uniforms.ngSlice.value = (z + 0.5) / o.d;
      this._draw(rt, z);
    }
    return rt.texture;
  }

  /**
   * 全画面の断片シェーダを既存の RT へ描く（毎フレームの小さな焼き込み・派生マップ用）
   * @param {import('three').WebGLRenderTarget} rt
   * @param {string} frag
   * @param {object} uniforms
   * @param {number} [layer=0]
   */
  run(rt, frag, uniforms, layer = 0) {
    const m = this._quad(frag, uniforms);
    m.uniforms.ngTexel.value.set(1 / rt.width, 1 / rt.height);
    m.uniforms.ngLayer.value = layer;
    this._draw(rt, layer);
  }

  /**
   * インポスターなどの撮影：scene を camera で rt（の層）へ描く。
   * 描く間は ngFrame の passId を BAKE にする（ngApplyMedium が空気を掛けない＝素の放射輝度を焼く）。
   * autoClear と camera.layers は呼び手のまま
   * @param {import('three').WebGLRenderTarget} rt
   * @param {number} layer 配列 RT の層（2D は 0）
   * @param {import('three').Scene} scene
   * @param {import('three').Camera} camera
   */
  renderView(rt, layer, scene, camera) {
    const r = this.renderer, fr = this.frame;
    const prev = r.getRenderTarget();
    const pass = fr ? fr.get(NG.CAM, 3) : 0;
    fr?.setComp(NG.CAM, 3, NG_PASS.BAKE);
    try {
      r.setRenderTarget(rt, layer);
      r.render(scene, camera);
    } finally {
      r.setRenderTarget(prev);
      fr?.setComp(NG.CAM, 3, pass);
    }
  }

  /** 使い捨ての RT を作る（呼び手が dispose する。forge は持たない） */
  target(w, h, o = {}) {
    const T = this.THREE;
    const rt = this._target(T.WebGLRenderTarget, w, h, 0, o);
    this._owned.delete(rt);
    return rt;
  }

  /** 焼き込み用の三角形とマテリアルを捨てる（テクスチャは残す） */
  releaseScratch() {
    for (const m of this._mats.values()) m.dispose();
    this._mats.clear();
    if (this._tri) { this._tri.geometry.dispose(); this._tri = null; this._scene = null; this._cam = null; }
  }

  /** forge が作った RT を全部捨てる */
  dispose() {
    this.releaseScratch();
    for (const rt of this._owned) rt.dispose();
    this._owned.clear();
    this._blue?.dispose();
    this._blue = null;
  }

  /**
   * 前回の yield から 30ms 経っていたら 1 回譲る（読み込み画面の進捗を止めない）
   * @returns {Promise<void>|void}
   */
  step() {
    if (now() - this._t0 < 30) return undefined;
    return new Promise((res) => setTimeout(() => { this._t0 = now(); res(); }, 0));
  }

  /**
   * 64² のブルーノイズ（void-and-cluster、Ulichney 1993）を R8 で返す。1 回だけ作る
   * @returns {Promise<import('three').DataTexture>}
   */
  async blueNoise() {
    if (this._blue) return this._blue;
    const T = this.THREE;
    const rank = await voidAndCluster(64, () => this.step());
    const data = new Uint8Array(64 * 64);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor((rank[i] / data.length) * 256);
    const tex = new T.DataTexture(data, 64, 64, T.RedFormat, T.UnsignedByteType);
    tex.magFilter = tex.minFilter = T.NearestFilter;
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.needsUpdate = true;
    this._blue = tex;
    return tex;
  }
}

/**
 * void-and-cluster の順位表（0..n²-1）。決定的（初期点は固定の LCG で選ぶ）
 * @param {number} n 一辺
 * @param {() => (Promise<void>|void)} yieldFn
 * @returns {Promise<Uint16Array>}
 */
export async function voidAndCluster(n, yieldFn) {
  const N = n * n, sigma = 1.9, R = 6;
  const kern = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) kern.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))]);
  const energy = new Float64Array(N);
  const on = new Uint8Array(N);
  const rank = new Uint16Array(N);
  const splat = (i, s) => {
    const x = i % n, y = (i / n) | 0;
    for (const [dx, dy, w] of kern) energy[((y + dy + n) % n) * n + ((x + dx + n) % n)] += s * w;
  };
  const argBest = (want, sign) => {
    let best = -1, bv = sign > 0 ? -Infinity : Infinity;
    for (let i = 0; i < N; i++) {
      if (on[i] !== want) continue;
      const e = energy[i];
      if (sign > 0 ? e > bv : e < bv) { bv = e; best = i; }
    }
    return best;
  };
  /* 初期の点（10%）を決定的に撒いて、最密の点を最疎へ移すのを収束まで繰り返す */
  let s = 12345;
  const lcg = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const initial = Math.floor(N * 0.1);
  let placed = 0;
  while (placed < initial) {
    const i = Math.floor(lcg() * N);
    if (on[i]) continue;
    on[i] = 1; splat(i, 1); placed++;
  }
  for (let it = 0; it < N; it++) {
    const c = argBest(1, 1);
    on[c] = 0; splat(c, -1);
    const v = argBest(0, -1);
    if (v === c) { on[c] = 1; splat(c, 1); break; }
    on[v] = 1; splat(v, 1);
    if ((it & 63) === 0) await yieldFn();
  }
  /* 段 1：初期点を最密から順に外して順位を下げる */
  const saveE = Float64Array.from(energy), saveOn = Uint8Array.from(on);
  for (let r = placed - 1; r >= 0; r--) {
    const c = argBest(1, 1);
    on[c] = 0; splat(c, -1); rank[c] = r;
    if ((r & 63) === 0) await yieldFn();
  }
  energy.set(saveE); on.set(saveOn);
  /* 段 2・3：最疎の空きを順に埋めて順位を上げる */
  for (let r = placed; r < N; r++) {
    const v = argBest(0, -1);
    on[v] = 1; splat(v, 1); rank[v] = r;
    if ((r & 63) === 0) await yieldFn();
  }
  return rank;
}

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
