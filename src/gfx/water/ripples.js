/* ===========================================================
   波紋シミュ（high）：波動方程式、RG16F 512² の世界に固定した «繰り返しの» 格子
   -----------------------------------------------------------
   - テクセル (i, j) は世界の格子 (I, J) ≡ (i, j) mod 512 を持つ（トーラス）。窓（カメラの前方に寄せた 512² × 5cm）が
     動いても中身を写さない：窓から出て入り直したテクセルだけを 0 にする（前の窓と今の窓の «世界の番号» を比べる）
   - R = h(t)、G = h(t − dt)。2 サブステップ / フレーム（dt ≤ 1/120）。c = 0.34 m/s、減衰 0.6%/段
   - 減衰体：岸（ngDepth < 2cm は h = 0 の反射壁、浅場は強い減衰）、杭（services.hardscape.piles と
     core の services.water.dampers のうち窓に近い 48 個を円の反射壁に）、窓の縁 20 テクセルのスポンジ層
   - 衝撃（addImpulse・addRipple・しぶきの着水）は 1 フレームに最大 16 個、ガウスの盛り上がりで入れる
   - mid / low では作らない（解析リングだけ）
   =========================================================== */
import { ngShaderMaterial } from '../core/extend.js';
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';

const NS = 512;
const MAX_DAMP = 48;
const MAX_IMP = 16;

const VS = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FS = NG_HEIGHTFIELD_GLSL + /* glsl */ `
precision highp float;
uniform highp sampler2D uSrc;
uniform vec2 uWin;        // 今の窓の最小の世界の格子番号（整数）
uniform vec2 uWinPrev;    // 前の窓
uniform float uTexel;     // m
uniform float uC2;        // (c·dt/dx)²
uniform float uDamp;      // 1 段の減衰
uniform vec3 uDampers[${MAX_DAMP}];   // x, z, r（m）
uniform int uDamperN;
uniform vec4 uImp[${MAX_IMP}];        // x, z, 振幅 m, 半径 m
uniform int uImpN;
#define NS ${NS}.0
float ngSimH(ivec2 t) { return texelFetch(uSrc, ivec2(t.x & ${NS - 1}, t.y & ${NS - 1}), 0).r; }
void main() {
  ivec2 ti = ivec2(gl_FragCoord.xy);
  vec2 fi = vec2(ti);
  /* このテクセルの世界の番号（窓の中で一意） */
  vec2 W = uWin + mod(fi - uWin, NS);
  vec2 Wp = uWinPrev + mod(fi - uWinPrev, NS);
  vec2 hp = texelFetch(uSrc, ti, 0).rg;
  if (any(notEqual(W, Wp))) { gl_FragColor = vec4(0.0); return; }   // 窓に入り直した
  vec2 P = (W + 0.5) * uTexel;
  float h = hp.r, h1 = hp.g;
  float lap = ngSimH(ti + ivec2(1, 0)) + ngSimH(ti - ivec2(1, 0)) + ngSimH(ti + ivec2(0, 1)) + ngSimH(ti - ivec2(0, 1)) - 4.0 * h;
  /* 窓の縁のスポンジ層（反対側へ回り込ませない） */
  vec2 e = min(W - uWin, uWin + NS - 1.0 - W);
  float edge = min(e.x, e.y);
  float sponge = edge < 2.0 ? 0.0 : mix(0.82, 1.0, smoothstep(2.0, 20.0, edge));
  float hn = (2.0 * h - h1 + uC2 * lap) * uDamp * sponge;
  /* 岸：陸と 2cm 未満は反射壁、浅場は強く減衰 */
  float d = ngDepth(P);
  if (d < 0.02) hn = 0.0;
  else hn *= mix(0.94, 1.0, smoothstep(0.02, 0.25, d));
  for (int k = 0; k < ${MAX_DAMP}; k++) {
    if (k >= uDamperN) break;
    vec3 D = uDampers[k];
    vec2 dv = P - D.xy;
    if (dot(dv, dv) < D.z * D.z) hn = 0.0;
  }
  for (int k = 0; k < ${MAX_IMP}; k++) {
    if (k >= uImpN) break;
    vec4 I = uImp[k];
    vec2 dv = P - I.xy;
    float r2 = dot(dv, dv) / max(I.w * I.w, 1e-6);
    if (r2 < 9.0) hn += I.z * exp(-r2);
  }
  hn = clamp(hn, -0.05, 0.05);
  gl_FragColor = vec4(hn == hn ? hn : 0.0, h, 0.0, 1.0);
}
`;

export class WaterRipples {
  /**
   * @param {object} ctx
   * @param {object} owner WaterModule（uniforms.uSim / uSimXf を書く）
   */
  constructor(ctx, owner) {
    this.ctx = ctx;
    this.owner = owner;
    this.T = ctx.THREE;
    this.on = false;
    this.texel = 0.05;
    this.rts = null;
    this.cur = 0;
    this.material = null;
    this.draws = 0;
    this.programs = 0;
    this._win = null;
    this._imp = [];
    this._pending = [];
    this._dampSel = [];
    this._dampKey = '';
    const T = this.T;
    this.uniforms = {
      uSrc: { value: null }, uWin: { value: new T.Vector2() }, uWinPrev: { value: new T.Vector2() },
      uTexel: { value: 0.05 }, uC2: { value: 0.05 }, uDamp: { value: 0.994 },
      uDampers: { value: Array.from({ length: MAX_DAMP }, () => new T.Vector3()) }, uDamperN: { value: 0 },
      uImp: { value: Array.from({ length: MAX_IMP }, () => new T.Vector4()) }, uImpN: { value: 0 },
      ...ctx.heightfield?.uniforms,
    };
  }

  setTier(q) {
    const want = !!q.sim;
    this.texel = q.simTexel || 0.05;
    if (want === this.on && (this.rts || !want)) return;
    this.on = want;
    if (want) this._alloc();
    else this._free();
  }

  _alloc() {
    const T = this.T;
    if (!this.material) {
      this.material = ngShaderMaterial({
        key: 'water-sim', module: 'water', lights: false, fog: false,
        uniforms: this.uniforms, vertexShader: VS, fragmentShader: FS, depthTest: false, depthWrite: false,
      });
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      const m = new T.Mesh(g, this.material);
      m.frustumCulled = false;
      this._scene = new T.Scene();
      this._scene.add(m);
      this._cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    const ex = this.ctx.renderer.extensions;
    const f32 = !!(ex?.has?.('EXT_color_buffer_float') && ex?.has?.('OES_texture_float_linear'));
    const mk = () => {
      const rt = new T.WebGLRenderTarget(NS, NS, { depthBuffer: false, type: f32 ? T.FloatType : T.HalfFloatType, format: T.RGBAFormat });
      rt.texture.wrapS = rt.texture.wrapT = T.RepeatWrapping;
      rt.texture.magFilter = rt.texture.minFilter = T.LinearFilter;
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this.rts = [mk(), mk()];
    this.programs = 1;
    this.reset();
  }

  _free() {
    if (this.rts) for (const r of this.rts) r.dispose();
    this.rts = null;
    this.programs = 0;
    this.draws = 0;
    const u = this.owner.uniforms;
    u.uSim.value = this.owner._blank;
    u.uSimXf.value.w = 0;
  }

  reset() {
    this._win = null;
    if (!this.rts) return;
    const r = this.ctx.renderer, prev = r.getRenderTarget();
    for (const rt of this.rts) { r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(true, false, false); }
    r.setRenderTarget(prev);
  }

  /** 点の衝撃（m の高さ）。NaN は捨てる。満杯なら古い物を捨てる */
  impulse(x, z, amp) {
    if (!this.on || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(amp)) return;
    const a = Math.max(-0.02, Math.min(0.02, amp));
    if (this._pending.length >= MAX_IMP) this._pending.shift();
    this._pending.push([x, z, a, Math.max(this.texel * 1.6, 0.06)]);
  }

  /* 減衰体：杭（hardscape.piles）と core の一覧から、窓の中心に近い MAX_DAMP 個 */
  _dampers(cx, cz, half) {
    const s = this.ctx.services;
    const piles = s.hardscape?.piles || [];
    const list = s.water?.dampers || [];
    const key = `${piles.length}:${list.version ?? list.length}:${Math.round(cx / 2)}:${Math.round(cz / 2)}`;
    if (key === this._dampKey) return;
    this._dampKey = key;
    const cand = [];
    const take = (d) => {
      if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.z) || !(d.r > 0)) return;
      const dx = d.x - cx, dz = d.z - cz;
      if (Math.abs(dx) > half + d.r || Math.abs(dz) > half + d.r) return;
      cand.push([dx * dx + dz * dz, d.x, d.z, Math.min(d.r, 3)]);
    };
    for (const d of piles) take(d);
    for (const d of list) take(d);
    cand.sort((a, b) => a[0] - b[0]);
    const u = this.uniforms.uDampers.value;
    const n = Math.min(cand.length, MAX_DAMP);
    for (let i = 0; i < n; i++) u[i].set(cand[i][1], cand[i][2], cand[i][3]);
    this.uniforms.uDamperN.value = n;
  }

  step(f) {
    if (!this.on || !this.rts || !this.material) { this.draws = 0; return; }
    const cam = f.camera;
    if (!cam || f.uw > 0.5) { this.draws = 0; return; }
    const T = this.T, u = this.uniforms;
    const W = NS * this.texel;
    /* 窓：カメラの前方へ 0.3W 寄せ、テクセルに丸める */
    const e = cam.matrixWorld.elements;
    let fx = -e[8], fz = -e[10];
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    const cx = cam.position.x + fx * W * 0.3, cz = cam.position.z + fz * W * 0.3;
    const wx = Math.floor(cx / this.texel) - NS / 2, wz = Math.floor(cz / this.texel) - NS / 2;
    if (!this._win) this._win = [wx, wz];
    u.uWinPrev.value.set(this._win[0], this._win[1]);
    u.uWin.value.set(wx, wz);
    this._win = [wx, wz];
    this._dampers(cx, cz, W / 2);
    const dt = Math.min(Math.max(f.dt || 0, 0), 1 / 30);
    const r = this.ctx.renderer, prev = r.getRenderTarget(), auto = r.autoClear;
    r.autoClear = false;
    let draws = 0;
    try {
      const sub = dt > 0 ? 2 : (u.uWin.value.equals(u.uWinPrev.value) ? 0 : 1);
      const h = dt > 0 ? dt / 2 : 0;
      const c = 0.34;
      u.uC2.value = h > 0 ? Math.min((c * h / this.texel) ** 2, 0.45) : 0;
      u.uDamp.value = h > 0 ? Math.pow(0.994, h * 120) : 1;
      for (let s = 0; s < sub; s++) {
        /* 衝撃は最初のサブステップだけ */
        const imp = s === 0 ? this._pending : [];
        const n = Math.min(imp.length, MAX_IMP);
        for (let i = 0; i < n; i++) u.uImp.value[i].set(imp[i][0], imp[i][1], imp[i][2], imp[i][3]);
        u.uImpN.value = n;
        if (s > 0) u.uWinPrev.value.copy(u.uWin.value);
        const src = this.rts[this.cur], dst = this.rts[1 - this.cur];
        u.uSrc.value = src.texture;
        r.setRenderTarget(dst);
        r.render(this._scene, this._cam);
        this.cur = 1 - this.cur;
        draws++;
      }
      if (sub > 0) this._pending.length = 0;
    } finally {
      r.setRenderTarget(prev);
      r.autoClear = auto;
    }
    this.draws = draws;
    const o = this.owner.uniforms;
    o.uSim.value = this.rts[this.cur].texture;
    o.uSimXf.value.set((wx + NS / 2) * this.texel, (wz + NS / 2) * this.texel, 1 / W, 1);
  }

  texBytes() { return this.rts ? NS * NS * 8 * 2 : 0; }

  dispose() {
    this._free();
    this.material?.dispose();
    this._scene?.children[0]?.geometry.dispose();
  }
}
