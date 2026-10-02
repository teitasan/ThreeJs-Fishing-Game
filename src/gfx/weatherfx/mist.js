/* ===========================================================
   朝霧の板（ARCHITECTURE §6.9）
   -----------------------------------------------------------
   水面の上 0.5–4m に浮かぶ大きなソフトなカード（60 / 32 / 16 枚）。カメラ中心の 280m の箱で折り返し、風で流れる。
   - 密度は core の朝霧と同じ場：ngMistDensity·e^(−(y − ngMistBaseY)/ngMistH)·ngMistMask（slot 6）。
     core の解析の朝霧が «平均» を受け持つので、カードは «濃淡の揺らぎ» の分だけを足す（ノイズの平均より濃い所。二重に濃くしない）
   - 縁を見せない：楕円の窓 × 2 段のノイズ（世界座標で読む = カードが重なっても模様が揃う）、深度でソフト、
     水面の近くと汀線の外で消える、カメラに近いと透明（板を突き抜ける瞬間を見せない）
   - 光：前方散乱（HG、ngMieG）で太陽側が光る + 環境の内散乱 + 朝霧の環境光（ngMistAmb）。媒質は fog チャンク
   =========================================================== */
import { ngShaderMaterial } from '../core/extend.js';
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { mulberry32, stream } from '../../world/rng.js';

const BOX = 140;   // 半辺 m

const VS = NG_HEIGHTFIELD_GLSL + /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform vec4 ngMsA;     // (時刻 s, 箱の半辺 m, 全体の濃さ, 0)
attribute vec4 aSeed;
out vec3 vW;
out vec2 vQ;
out float vA;
out vec3 vVd;
void main() {
  float t = ngMsA.x, B = ngMsA.y;
  vec3 c = cameraPosition;
  vec2 w = ngWindDir * ngWindSpeed * 0.55;
  vec2 xz;
  xz.x = c.x - B + mod(aSeed.x * 2.0 * B + w.x * t - (c.x - B), 2.0 * B);
  xz.y = c.z - B + mod(aSeed.y * 2.0 * B + w.y * t - (c.z - B), 2.0 * B);
  float wid = mix(24.0, 46.0, aSeed.z);
  float hgt = mix(3.0, 6.5, aSeed.w);
  float y0 = ngMistBaseY + 0.35 + 1.2 * fract(aSeed.z * 7.1);
  /* 水の上だけ：汀線の内 6m から（ngShoreD は陸 +、水 −） */
  float shore = ngShoreD(xz);
  float over = 1.0 - smoothstep(-14.0, -4.0, shore);
  vec3 base = vec3(xz.x, y0, xz.y);
  vec3 to = base - c;
  float d = length(to.xz);
  vec2 f = d > 1e-3 ? to.xz / d : vec2(0.0, 1.0);
  vec3 right = vec3(-f.y, 0.0, f.x);
  vec3 pos = base + right * position.x * wid * 0.5 + vec3(0.0, position.y * hgt, 0.0);
  vW = pos;
  vQ = position.xy;
  vVd = pos - c;
  /* カメラに近い板・箱の縁の板は薄く（折り返しで出入りする瞬間を見せない） */
  float edge = 1.0 - smoothstep(0.7 * B, 0.95 * B, max(abs(to.x), abs(to.z)));
  vA = over * edge * smoothstep(4.0, 22.0, d) * ngMsA.z;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = vA > 1e-4 ? projectionMatrix * mvPosition : vec4(2.0, 2.0, 2.0, 1.0);
  #include <fog_vertex>
}
`;

const FS = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec4 ngMsA;
uniform sampler2D ngMsNoise;
uniform highp sampler2D ngSceneDepth;
uniform vec4 ngScreen;
in vec3 vW;
in vec2 vQ;
in float vA;
in vec3 vVd;
float ngMsHG(float mu, float g) {
  float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  return 0.07957747 * (1.0 - g * g) / (d * sqrt(d));
}
void main() {
  if (vA < 1e-4) discard;
  /* 楕円の窓（縁はノイズで崩す） */
  vec2 q = vec2(vQ.x, vQ.y * 2.0 - 1.0);
  float t = ngMsA.x;
  vec2 wd = ngWindDir * ngWindSpeed;
  vec2 p = vec2(vW.x + vW.z, vW.y * 2.6) / 38.0 - wd * t / 38.0 * 0.4;
  float n1 = texture(ngMsNoise, p).r;
  float n2 = texture(ngMsNoise, p * 3.1 + vec2(0.37, t * 0.004)).g;
  float n = n1 * 0.7 + n2 * 0.3;
  float r = length(q * vec2(1.0, 1.0)) + (n - 0.5) * 0.55;
  float win = 1.0 - smoothstep(0.35, 1.0, r);
  /* 揺らぎの分だけ：ノイズの平均（≈ 0.45）より濃い所 */
  float var = max(n - 0.40, 0.0) * 1.9;
  float hy = max(vW.y - ngMistBaseY, 0.0);
  float rho = ngMistDensity * exp(-hy / max(ngMistH, 0.3)) * ngMistMask(vW.xz);
  float a = (1.0 - exp(-rho * 26.0 * var)) * win * vA;
  /* 水面の近く・深度（地形・桟橋・木）でソフトに */
  a *= smoothstep(0.0, 0.6, vW.y - 0.02);
  float zs = texture(ngSceneDepth, gl_FragCoord.xy * ngScreen.zw).r;
  float zf = gl_FragCoord.z / gl_FragCoord.w;
  a *= smoothstep(0.0, 5.0, zs - zf);
  if (a < 1e-3) discard;
  vec3 vd = normalize(vVd);
  /* 薄い層の単散乱：L = E·p(μ)（a ≈ τ で前乗せ）。太陽側の光暈は位相で、頭打ち 1.2 */
  vec3 E = ngKeyRad * vNgCloud * min(ngMsHG(dot(vd, ngKeyDir), clamp(ngMieG, 0.0, 0.9)), 1.2)
         + ngSkyIrr * 0.9 + vec3(ngMistAmb);
  gl_FragColor = vec4(E, 1.0);
  #include <fog_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}
`;

/* 周期の fbm（r = 粗い、g = 細かい） */
const NOISE_FRAG = /* glsl */ `
void main() {
  float a = ngFbmP(vUv * 4.0, vec2(4.0), 5);
  float b = ngFbmP(vUv * 8.0 + 1.7, vec2(8.0), 4);
  gl_FragColor = vec4(a, b, 0.0, 1.0);
}
`;

export class Mist {
  constructor(ctx, root, seed) {
    const T = ctx.THREE;
    this.ctx = ctx;
    this.T = T;
    const N = 60;
    const rnd = mulberry32(stream(seed, 'wfx-mist'));
    const g = new T.InstancedBufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const s = new Float32Array(N * 4);
    for (let i = 0; i < N * 4; i++) s[i] = rnd();
    g.setAttribute('aSeed', new T.InstancedBufferAttribute(s, 4));
    g.instanceCount = 0;
    g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
    this.geo = g;
    this.max = N;
    this.n = 32;
    this.noise = { value: null };
    this.u = { ngMsA: { value: new T.Vector4(0, BOX, 0, 0) }, ngMsNoise: this.noise };
    this.mat = ngShaderMaterial({
      key: 'weatherfx-mist', module: 'weatherfx', lights: false, fog: true,
      uniforms: { ...this.u, ...ctx.heightfield.uniforms, ngSceneDepth: ctx.pipeline.uniforms.ngSceneDepth, ngScreen: ctx.pipeline.uniforms.ngScreen },
      vertexShader: VS, fragmentShader: FS,
      transparent: true, depthWrite: false, depthTest: true, side: T.DoubleSide, blending: T.CustomBlending,
      blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendEquation: T.AddEquation,
    });
    this.mesh = new T.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2.5;
    this.mesh.name = 'ng-wfx-mist';
    this.mesh.visible = false;
    root.add(this.mesh);
    ngOwn(this.mesh, NG_LAYER.LATE_FX);
  }

  async bake() {
    const { NG_NOISE_GLSL } = await import('../core/glsl/noise.glsl.js');
    this.noise.value = this.ctx.forge.bake2D({ w: 256, h: 256, frag: NG_NOISE_GLSL + NOISE_FRAG, mips: true, wrap: 'repeat', type: this.T.UnsignedByteType });
  }

  setCount(n) { this.n = Math.max(0, Math.min(this.max, n | 0)); }

  /**
   * @param {object} f
   * @param {{ show:boolean, t:number, density:number }} st density = ngMistDensity（1/m）
   */
  update(f, st) {
    const on = st.show && st.density > 2e-4 && this.n > 0;
    this.mesh.visible = on;
    this.geo.instanceCount = on ? this.n : 0;
    if (!on) return;
    this.u.ngMsA.value.set(st.t, BOX, Math.min(1, st.density / 0.004), 0);
  }

  stats() { const n = this.mesh.visible ? this.geo.instanceCount : 0; return { draws: n ? 1 : 0, tris: n * 2, instances: n }; }

  dispose() { this.mat.dispose(); this.geo.dispose(); }
}
