/* ===========================================================
   プランクトン / マリンスノー（ARCHITECTURE §6.3）
   -----------------------------------------------------------
   カメラ中心の 12m の箱で wrap するソフトな点（生成と消滅の処理なし。位置は seed と時刻の純関数）。
   - 流れ（f.flowDir / flowStrength）で流れ、ゆっくり沈み、小さく揺れる
   - 照らすのは水面から入った key（下向き光の減衰）× 前方散乱（光の方を見るときらめく）+ 水の内散乱の環境光
   - 媒質は透過だけ（加算の粒に内散乱を足すと霞が粒の数だけ重なる）。ngMediumTerms を頂点で
   - 近い粒は焦点が外れてにじむ（点を大きく、明るさは面積で割って保つ）。箱の縁・水面の上では消える
   - 水上（uw ≤ 0.5）では描かない（予算：水上 0）
   =========================================================== */
import { ngShaderMaterial } from '../core/extend.js';
import { NG_MEDIUM_GLSL } from '../core/glsl/medium.glsl.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { mulberry32, stream } from '../../world/rng.js';

export const PLANKTON_BOX = 12;
const MAX_N = 800;

const VS = NG_MEDIUM_GLSL + /* glsl */ `
uniform vec3 ngPkCam;
uniform vec4 ngPkT;       // (時刻 s, 箱 m, 画素のスケール, 水面の y)
uniform vec3 ngPkFlow;    // 流れ m/s（世界）
uniform vec3 ngPkKeyE;    // 水面を透過した key の放射照度 rgb
uniform vec3 ngPkLw;      // 水中の key の向き（光へ）
attribute vec4 aSeed;
out vec3 vCol;
out float vA;
float ngPkHG(float mu, float g) {
  float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  return 0.07957747 * (1.0 - g * g) / (d * sqrt(d));
}
void main() {
  float t = ngPkT.x, box = ngPkT.y;
  vec3 p0 = aSeed.xyz * box;
  float ph = aSeed.w * 61.0;
  vec3 drift = ngPkFlow * t + vec3(0.0, -0.011 * t, 0.0)
    + 0.06 * vec3(sin(t * 0.31 + ph), sin(t * 0.23 + ph * 1.7), sin(t * 0.27 + ph * 2.3));
  vec3 rel = mod(p0 + drift - ngPkCam + 0.5 * box, box) - 0.5 * box;
  vec3 P = ngPkCam + rel;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  gl_Position = projectionMatrix * mv;
  float z = max(-mv.z, 0.02);
  float sizeM = mix(0.0012, 0.0045, fract(aSeed.w * 7.13));
  float px = sizeM * ngPkT.z / z;
  float coc = 9.0 * max(0.0, 0.7 - z) / 0.7;          // 近すぎる粒の焦点外れ（px）
  float ps = max(px, 1.25) + coc;
  gl_PointSize = ps;
  float cover = min(1.0, (px * px + 0.2) / (ps * ps));
  float depth = max(ngPkT.w - P.y, 0.0);
  vec3 Td = exp(-(ngSigmaA + vec3(0.3 * ngSigmaS)) * depth / max(ngPkLw.y, 0.2));
  vec3 vd = normalize(P - cameraPosition);
  float p = ngPkHG(dot(vd, ngPkLw), 0.65);   // 光の進む向き（−Lw）と粒 → カメラ（−vd）の角
  vec3 E = ngPkKeyE * Td * (0.25 + 6.0 * p) + ngWaterInsc * 6.2831853;
  vec3 L = 0.55 * 0.31830989 * E;
  vec3 T, Lin;
  ngMediumTerms(P, T, Lin);
  vCol = L * T;
  float edge = 1.0 - smoothstep(0.36, 0.5, max(max(abs(rel.x), abs(rel.y)), abs(rel.z)) / box);
  float wet = 1.0 - smoothstep(-0.12, -0.02, P.y - ngPkT.w);
  vA = cover * edge * wet * smoothstep(0.06, 0.2, z) * mix(0.35, 1.0, fract(aSeed.w * 3.7));
}
`;

const FS = /* glsl */ `
in vec3 vCol;
in float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.2) * vA;
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

export class Plankton {
  constructor(ctx, root, seed) {
    const T = ctx.THREE;
    this.ctx = ctx;
    const rnd = mulberry32(stream(seed, 'uw-plankton'));
    const seeds = new Float32Array(MAX_N * 4);
    for (let i = 0; i < MAX_N * 4; i++) seeds[i] = rnd();
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(MAX_N * 3), 3));
    g.setAttribute('aSeed', new T.BufferAttribute(seeds, 4));
    g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
    this.u = {
      ngPkCam: { value: new T.Vector3() }, ngPkT: { value: new T.Vector4(0, PLANKTON_BOX, 1000, 0) },
      ngPkFlow: { value: new T.Vector3() }, ngPkKeyE: { value: new T.Vector3() }, ngPkLw: { value: new T.Vector3(0, 1, 0) },
    };
    this.mat = ngShaderMaterial({
      key: 'underwater-plankton', module: 'underwater', lights: false, fog: false,
      uniforms: this.u, vertexShader: VS, fragmentShader: FS,
      transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending,
    });
    this.points = new T.Points(g, this.mat);
    this.points.name = 'ng-uw-plankton';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
    root.add(this.points);
    ngOwn(this.points, NG_LAYER.LATE_FX);
    this.count = 0;
  }

  setCount(n) {
    this.count = Math.max(0, Math.min(MAX_N, n | 0));
    this.points.geometry.setDrawRange(0, this.count);
  }

  /**
   * @param {object} f
   * @param {object} st { uw, keyE, lw, waterY, time }
   */
  update(f, st) {
    const on = st.uw > 0.5 && this.count > 0;
    this.points.visible = on;
    if (!on) return;
    const u = this.u, cam = f.camera;
    u.ngPkCam.value.copy(cam.position);
    const hPx = this.ctx.pipeline.uniforms.ngScreen?.value?.y || 1080;
    const pxScale = cam.isPerspectiveCamera ? hPx / (2 * Math.tan((cam.fov * Math.PI) / 360)) : 1000;
    u.ngPkT.value.set(st.time % 3600, PLANKTON_BOX, pxScale, st.waterY);
    const fs = Number.isFinite(f.flowStrength) ? f.flowStrength : 0;
    u.ngPkFlow.value.set((f.flowDir?.x || 0) * fs, 0, (f.flowDir?.y || 0) * fs);
    u.ngPkKeyE.value.copy(st.keyE);
    u.ngPkLw.value.copy(st.lw);
  }

  dispose() { this.mat.dispose(); this.points.geometry.dispose(); }
}
