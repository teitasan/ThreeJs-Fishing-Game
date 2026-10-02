/* ===========================================================
   蛍と光芒の塵（ARCHITECTURE §6.9）：同じ点のシェーダ（1 本のプログラム）を 2 つの Points で
   -----------------------------------------------------------
   蛍（mode 0）：初夏の晴れた夜、桟橋に近い葦（placement.reeds）の上 0.3–1.8m を漂う。2–4 秒周期の明滅（logic.js の
     fireflyBlink と同じ式）。光るのは周期の 2 割ほど。黄緑の発光（ゲンジボタル ≈ 565nm）、芯 + にじみ。加算
   塵（mode 1）：森の中（カメラの樹冠の密度）で太陽が低いとき、カメラ中心 10m の箱で漂う。近景の影（ngNearShadowAt）で
     日向の粒だけが前方散乱で光る = 木漏れ日の光芒の中に塵が浮かぶ（光芒そのものは post）
   媒質は透過だけ（ngMediumTerms。加算の粒に内散乱を足さない）
   =========================================================== */
import { ngShaderMaterial } from '../core/extend.js';
import { NG_MEDIUM_GLSL } from '../core/glsl/medium.glsl.js';
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { NG_NEAR_SHADOW_GLSL } from '../core/glsl/shadow.glsl.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { mulberry32, stream } from '../../world/rng.js';

const VS = NG_MEDIUM_GLSL + NG_HEIGHTFIELD_GLSL + NG_NEAR_SHADOW_GLSL + /* glsl */ `
uniform vec4 ngPtA;     // (時刻 s, 重み 0..1, 画素のスケール, mode)
attribute vec4 aSeed;   // 乱数
attribute vec3 aAnchor; // 蛍：葦の場所（x, 水面からの高さ, z）。塵：未使用
out vec3 vCol;
out float vA;
out float vCore;
float ngPtHG(float mu, float g) {
  float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  return 0.07957747 * (1.0 - g * g) / (d * sqrt(d));
}
float ngPtSm(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
void main() {
  float t = ngPtA.x, wgt = ngPtA.y;
  vec3 c = cameraPosition;
  vec3 P;
  vec3 L;
  float sizeM, a;
  if (ngPtA.w < 0.5) {
    /* 蛍：葦の上をゆっくり漂う（2 つの周期のリサジュー） */
    float ph = aSeed.x * 6.2831853;
    vec3 off = vec3(sin(t * (0.21 + 0.1 * aSeed.y) + ph) * 1.6 + sin(t * 0.53 + ph * 2.1) * 0.5,
                    0.35 + 0.9 * aSeed.z + 0.35 * sin(t * 0.37 + ph * 1.3),
                    cos(t * (0.17 + 0.1 * aSeed.w) + ph) * 1.6 + cos(t * 0.61 + ph * 1.7) * 0.5);
    P = vec3(aAnchor.x, aAnchor.y, aAnchor.z) + off;
    float per = 2.0 + 2.0 * aSeed.w;
    float u = fract(t / per + aSeed.y);
    float b = ngPtSm(0.0, 0.07, u) * (1.0 - ngPtSm(0.12, 0.24, u));
    a = b * wgt;
    sizeM = 0.012;
    /* 発光（ng 単位の放射輝度。夜の露出で明るい点になる）。1 匹ずつ明るさ 0.45–1.15 倍・黄緑の幅 */
    L = mix(vec3(0.55, 1.0, 0.16), vec3(0.78, 1.0, 0.28), fract(aSeed.z * 17.3)) * 0.9 * mix(0.45, 1.15, fract(aSeed.x * 53.1));
  } else {
    /* 塵：カメラ中心 10m の箱で折り返す。日向だけ光る */
    const float B = 10.0;
    vec3 p0 = aSeed.xyz * B;
    vec3 drift = vec3(ngWindDir.x, 0.0, ngWindDir.y) * 0.12 * t + vec3(0.0, 0.015 * t, 0.0)
      + 0.15 * vec3(sin(t * 0.3 + aSeed.w * 40.0), sin(t * 0.23 + aSeed.x * 31.0), sin(t * 0.27 + aSeed.y * 27.0));
    vec3 rel = mod(p0 + drift - c + 0.5 * B, B) - 0.5 * B;
    P = c + rel;
    float sun = ngNearShadowAt(P) * ngCloudShadow(P);
    vec3 vd = normalize(P - c);
    L = ngKeyRad * ngPtHG(dot(vd, ngKeyDir), 0.7) * 0.6 * sun;
    float edge = 1.0 - ngPtSm(0.38, 0.5, max(max(abs(rel.x), abs(rel.y)), abs(rel.z)) / B);
    a = wgt * edge * step(ngTerrainH(P.xz) + 0.1, P.y);
    sizeM = mix(0.0006, 0.0016, aSeed.w);
  }
  vec4 mv = viewMatrix * vec4(P, 1.0);
  gl_Position = projectionMatrix * mv;
  float z = max(-mv.z, 0.05);
  float px = sizeM * ngPtA.z / z;
  float ps = ngPtA.w < 0.5 ? max(px * 7.0, 6.0) : max(px, 1.25);   // 蛍はにじみを含む大きさ
  gl_PointSize = a > 1e-4 ? ps : 0.0;
  vCore = ngPtA.w < 0.5 ? clamp(max(px, 1.6) / ps, 0.05, 1.0) : 1.0;
  float cover = ngPtA.w < 0.5 ? 1.0 : min(1.0, (px * px + 0.15) / (ps * ps));
  vec3 T, Lin;
  ngMediumTerms(P, T, Lin);
  vCol = L * T;
  vA = a * cover * ngPtSm(0.15, 0.6, z);
}
`;

const FS = /* glsl */ `
in vec3 vCol;
in float vA;
in float vCore;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0 || vA < 1e-4) discard;
  /* 芯（鋭い）+ にじみ（広い）。塵は芯だけ */
  float core = exp(-pow(r / max(vCore, 0.02), 2.0) * 2.5);
  float halo = exp(-r * r * 4.0) * 0.12 * (1.0 - step(0.99, vCore));
  gl_FragColor = vec4(vCol * (core + halo) * vA, 1.0);
}
`;

export class Motes {
  constructor(ctx, root, seed) {
    const T = ctx.THREE;
    this.ctx = ctx;
    const rnd = mulberry32(stream(seed, 'wfx-motes'));
    this.u = { ngPtA: { value: new T.Vector4() } };
    const mk = (n, name, mode) => {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3), 3));
      const s = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) s[i] = rnd();
      g.setAttribute('aSeed', new T.BufferAttribute(s, 4));
      g.setAttribute('aAnchor', new T.BufferAttribute(new Float32Array(n * 3), 3));
      g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
      g.setDrawRange(0, 0);
      const u = { ngPtA: { value: new T.Vector4(0, 0, 1000, mode) } };
      const mat = ngShaderMaterial({
        key: 'weatherfx-points', module: 'weatherfx', lights: false, fog: false,
        uniforms: { ...u, ...ctx.heightfield.uniforms, ...ctx.shadows.nearUniforms },
        vertexShader: VS, fragmentShader: FS,
        transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending,
      });
      const p = new T.Points(g, mat);
      p.frustumCulled = false;
      p.renderOrder = 3;
      p.name = name;
      p.visible = false;
      root.add(p);
      ngOwn(p, NG_LAYER.LATE_FX);
      return { points: p, geo: g, mat, u, max: n, n: 0 };
    };
    this.ff = mk(200, 'ng-wfx-fireflies', 0);
    this.dust = mk(300, 'ng-wfx-motes', 1);
    this._anchors(ctx, rnd);
  }

  /* 蛍の居場所：桟橋の付け根に近い葦（無ければ汀線の点）。近い順に 200 か所（同じ葦に 2 匹まで） */
  _anchors(ctx, rnd) {
    const P = ctx.placement, lake = ctx.lake, dock = lake?.dock;
    const cx = dock?.start?.x ?? 0, cz = dock?.start?.z ?? 0;
    let list = (P?.reeds || []).map((r) => ({ x: r.x, z: r.z, d: Math.hypot(r.x - cx, r.z - cz) })).filter((r) => r.d < 140);
    list.sort((a, b) => a.d - b.d);
    if (list.length < 20 && lake?.shoreAtAngle) {
      const a0 = Math.atan2(cz, cx);
      list = [];
      for (let i = 0; i < 120; i++) {
        const a = a0 + (i / 120 - 0.5) * 0.9, r = lake.shoreAtAngle(a) - 2;
        list.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, d: 0 });
      }
    }
    const A = this.ff.geo.getAttribute('aAnchor');
    for (let i = 0; i < this.ff.max; i++) {
      const r = list.length ? list[Math.min(list.length - 1, (i * 0.5) | 0)] : { x: cx, z: cz };
      A.setXYZ(i, r.x + (rnd() - 0.5) * 1.5, 0, r.z + (rnd() - 0.5) * 1.5);
    }
    A.needsUpdate = true;
    this.anchorCount = list.length;
  }

  setCounts(q) {
    this.ff.n = Math.min(q.fireflies, this.ff.max);
    this.dust.n = Math.min(q.motes, this.dust.max);
  }

  /**
   * @param {object} f
   * @param {{ t:number, fireflies:number, motes:number, show:boolean }} st 重み 0..1
   */
  update(f, st) {
    const cam = f.camera;
    const hPx = this.ctx.pipeline.uniforms.ngScreen?.value?.y || 1080;
    const pxScale = cam?.isPerspectiveCamera ? hPx / (2 * Math.tan((cam.fov * Math.PI) / 360)) : 1000;
    for (const [o, w] of [[this.ff, st.fireflies], [this.dust, st.motes]]) {
      const on = st.show && w > 0.01 && o.n > 0;
      o.points.visible = on;
      o.geo.setDrawRange(0, on ? o.n : 0);
      if (on) { const v = o.u.ngPtA.value; v.set(st.t, w, pxScale, v.w); }
    }
  }

  stats() {
    let draws = 0, inst = 0;
    for (const o of [this.ff, this.dust]) if (o.points.visible) { draws++; inst += o.n; }
    return { draws, tris: 0, instances: inst };
  }

  dispose() { for (const o of [this.ff, this.dust]) { o.mat.dispose(); o.geo.dispose(); } }
}
