/* ===========================================================
   しぶき：GPU の解析弾道の粒（CPU の粒子ループなし）
   -----------------------------------------------------------
   - 粒ごとに (p0, t0) と (v0, 大きさ) を 1 回だけ書く（リングバッファ、書いた範囲だけを送る）
   - 頂点で p(τ) = p0 + 水平 v0·(1 − e^{−kτ})/k + 縦 (v0y·τ − ½gτ²)。水面より下・寿命の外は画面の外へ畳む
   - 速度の向きに伸ばした板（動きのぼけ 1/60s）。断片は丸い水滴：空の照り返し + 逆光の透け + key の点の照り
   - 着水：粒のうち大きい数個の着水時刻を CPU で解き、波紋シミュ（high）へ小さな衝撃を予約する
   - 乱数は hash01（Math.random を使わない。マルチでも同じ形）
   =========================================================== */
import { ngShaderMaterial } from '../core/extend.js';
import { hash01 } from '../../world/rng.js';

const VS = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform float uTime;
in vec4 aP0;     // x, y, z, t0
in vec4 aV0;     // vx, vy, vz, 大きさ m
out vec2 vQ;
out float vFade;
void main() {
  float tau = uTime - aP0.w;
  float life = 2.2;
  float k = 1.6;
  float e = exp(-k * max(tau, 0.0));
  vec3 P = aP0.xyz + vec3(aV0.x, 0.0, aV0.z) * (1.0 - e) / k;
  P.y += aV0.y * tau - 4.905 * tau * tau;
  vec3 vel = vec3(aV0.x * e, aV0.y - 9.81 * tau, aV0.z * e);
  bool alive = tau >= 0.0 && tau < life && P.y > -0.02 && aV0.w > 0.0;
  vec4 mvPosition = viewMatrix * vec4(P, 1.0);
  vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;
  vec2 ax = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(0.0, 1.0);
  vec2 ay = vec2(-ax.y, ax.x);
  /* 画面で ≈1.5px を割る水滴は大きさを保ち、その分だけ薄くする（遠くの着水が点滅せず、明るさの総量は同じ） */
  float sz0 = aV0.w;
  float sz = max(sz0, -mvPosition.z * 0.0018);
  float cover = (sz0 * sz0) / (sz * sz);
  float stretch = sz + length(vv.xy) * (1.0 / 60.0);
  mvPosition.xy += ax * position.y * stretch + ay * position.x * sz;
  vQ = position.xy * 2.0;
  vFade = (1.0 - smoothstep(life * 0.7, life, tau)) * smoothstep(-0.02, 0.03, P.y) * cover;
  gl_Position = alive ? projectionMatrix * mvPosition : vec4(2.0, 2.0, 2.0, 1.0);
  #include <fog_vertex>
}
`;

const FS = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
in vec2 vQ;
in float vFade;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  /* 水滴：縁ほど空を映し（Fresnel）、中は逆光の透け。key の点の照り */
  float rim = smoothstep(0.2, 1.0, r2);
  vec3 sky = ngSkyIrr * 1.25;
  vec3 key = ngKeyRad * vNgCloud;
  vec3 c = sky * (0.55 + 0.6 * rim) + key * (0.10 + 0.6 * exp(-r2 * 9.0) * 0.5);
  float a = (1.0 - r2 * r2) * 0.85 * vFade;
  gl_FragColor = vec4(c, a);
  #include <fog_fragment>
}
`;

export class WaterSplashes {
  constructor(ctx, owner) {
    this.ctx = ctx;
    this.owner = owner;
    this.T = ctx.THREE;
    this.cap = 0;
    this.mesh = null;
    this.material = null;
    this._next = 0;
    this._serial = 0;
    this._land = [];
    this._dirty = null;
    this._alive = 0;
    this.uniforms = { uTime: { value: 0 } };
  }

  async init() {
    const T = this.T;
    this.material = ngShaderMaterial({
      key: 'water-splash', module: 'water', lights: false,
      uniforms: this.uniforms, vertexShader: VS, fragmentShader: FS,
      transparent: true, depthWrite: false, blending: T.NormalBlending,
    });
    this._alloc(1024);
  }

  _alloc(n) {
    const T = this.T;
    if (n === this.cap && this.mesh) return;
    this.cap = n;
    const g = new T.InstancedBufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this._p0 = new Float32Array(n * 4).fill(0);
    this._v0 = new Float32Array(n * 4).fill(0);
    for (let i = 0; i < n; i++) this._p0[i * 4 + 3] = -1e9;
    this.aP0 = new T.InstancedBufferAttribute(this._p0, 4);
    this.aV0 = new T.InstancedBufferAttribute(this._v0, 4);
    this.aP0.setUsage(T.DynamicDrawUsage);
    this.aV0.setUsage(T.DynamicDrawUsage);
    g.setAttribute('aP0', this.aP0);
    g.setAttribute('aV0', this.aV0);
    g.instanceCount = n;
    g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.geometry = g; }
    else {
      this.mesh = new T.Mesh(g, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 2;
      this.mesh.name = 'ng-water-splash';
    }
    this._next = 0;
  }

  setTier(q) { this._alloc(q.splashes || 512); }

  /** しぶき（count 0–256 の整数、power 0–20）。NaN は捨てる。投げない */
  add(x, y, z, count = 14, power = 1) {
    if (!this.mesh || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const n = Math.max(0, Math.min(256, Math.floor(Number.isFinite(count) ? count : 0)));
    const pw = Math.max(0, Math.min(20, Number.isFinite(power) ? power : 1));
    if (!n || pw <= 0) return;
    const t0 = this.uniforms.uTime.value;
    const sp = Math.sqrt(pw);
    const s = ++this._serial;
    const lands = [];
    for (let i = 0; i < n; i++) {
      const k = this._next;
      this._next = (k + 1) % this.cap;
      const u1 = hash01(0x51a5, s, i * 4), u2 = hash01(0x51a5, s, i * 4 + 1), u3 = hash01(0x51a5, s, i * 4 + 2), u4 = hash01(0x51a5, s, i * 4 + 3);
      const a = u1 * Math.PI * 2;
      const hv = (0.25 + 0.85 * u2) * sp * 0.9;
      const vy = (0.9 + 1.7 * u3) * sp * (0.85 + 0.3 * u2);
      const size = 0.005 + 0.013 * u4 * u4;
      const P = this._p0, V = this._v0, o = k * 4;
      P[o] = x + Math.cos(a) * 0.03; P[o + 1] = Math.max(y, 0) + 0.01; P[o + 2] = z + Math.sin(a) * 0.03; P[o + 3] = t0 + u4 * 0.04;
      V[o] = Math.cos(a) * hv; V[o + 1] = vy; V[o + 2] = Math.sin(a) * hv; V[o + 3] = size;
      if (size > 0.012 && lands.length < 4) {
        /* 着水の時刻（抗力の水平の距離も） */
        const tl = (vy + Math.sqrt(vy * vy + 19.62 * (P[o + 1]))) / 9.81;
        const reach = (1 - Math.exp(-1.6 * tl)) / 1.6;
        lands.push([P[o + 3] + tl, P[o] + V[o] * reach, P[o + 2] + V[o + 2] * reach, size]);
      }
      this._mark(k);
    }
    for (const l of lands) { if (this._land.length < 64) this._land.push(l); }
  }

  _mark(k) {
    if (!this._dirty) this._dirty = [k, k];
    else { this._dirty[0] = Math.min(this._dirty[0], k); this._dirty[1] = Math.max(this._dirty[1], k); }
  }

  update() {}

  prepare(f) {
    const t = Number.isFinite(f.waterTime) ? f.waterTime : 0;
    this.uniforms.uTime.value = t;
    if (this._dirty) {
      const [a, b] = this._dirty;
      for (const at of [this.aP0, this.aV0]) {
        at.clearUpdateRanges?.();
        at.addUpdateRange?.(a * 4, (b - a + 1) * 4);
        at.needsUpdate = true;
      }
      this._dirty = null;
    }
    if (this._land.length) {
      const keep = [];
      for (const l of this._land) {
        if (t >= l[0]) this.owner.ripples?.impulse(l[1], l[2], 0.0012 + l[3] * 0.05);
        else if (t > l[0] - 5) keep.push(l);
      }
      this._land = keep;
    }
  }

  stats() { return { draws: this.mesh ? 1 : 0, tris: this.cap * 2, instances: this.cap, programs: 1 }; }

  dispose() {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}
