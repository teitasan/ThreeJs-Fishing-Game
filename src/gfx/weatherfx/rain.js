/* ===========================================================
   雨（ARCHITECTURE §6.9）：筋・着弾・遠景の幕
   -----------------------------------------------------------
   筋：カメラ中心の円柱（半径 25m・高さ 20m）で折り返すインスタンスの細い四角。位置は «粒の乱数・時刻・カメラ・風» の
     純関数（logic.js の rainDrop と同じ式）。風で傾け、長さは速さ × 1/60s × 1.6（シャッターの見え方）。
     幅は 1.5mm を画素の幅で下限を切り、明るさを面積で割って保つ（遠くの筋がちらつかない）。
     色：背景の屈折（sceneColor を筋の横へずらして読む）+ 空の放射輝度 + 逆光の key（HG g 0.9）+ 灯籠の光（距離の二乗）。
     樹冠の下（ngCanopyAt の密度の確率）・桟橋の下・地面と水面の下には降らせない
   着弾：カメラの周り半径 14m の地面と桟橋に、粒ごとの周期（0.45–0.75s）で王冠の板。位置は周期の番号のハッシュ。水の上は描かない
     （水面の雨は water の ngRainRings と、weatherfx が CPU で送る addImpulse）
   幕：カメラ中心の円筒の殻（半径 55m / 110m）に縦に流れる筋のノイズ。深度でソフト（地形に刺さった縁を消す）。媒質は fog チャンク
   =========================================================== */
import { ngShaderMaterial } from '../core/extend.js';
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { NG_WIND_GLSL } from '../core/glsl/wind.glsl.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { mulberry32, stream } from '../../world/rng.js';
import { RAIN } from './logic.js';

const fx = (v) => v.toFixed(4);

/* 雨の共有 uniform（筋・着弾・幕） */
const RAIN_PARS = /* glsl */ `
uniform vec4 ngRnA;      // (時刻 s, 雨 0..1, 画素のスケール = 高さ px / (2 tan(fov/2)), 灯籠の強さ)
uniform vec4 ngRnDock;   // 桟橋の付け根 xz, 先端 xz
uniform vec4 ngRnDock2;  // (床の半幅, 床の上面 y, 風の運ぶ割合, 0)
uniform vec3 ngRnLamp;   // 灯籠の位置
uniform vec3 ngRnLampC;  // 灯籠の色 × 強さ（three の PointLight の intensity・color）
/* 桟橋の床の下か（上から見た箱。床の上面より下で、幅の中） */
float ngRnUnderDock(vec3 P) {
  vec2 a = ngRnDock.xy, b = ngRnDock.zw, d = b - a;
  float L = max(length(d), 1e-3);
  vec2 u = d / L;
  vec2 q = P.xz - a;
  float f = dot(q, u), s = abs(q.x * u.y - q.y * u.x);
  return (f > -0.3 && f < L + 0.3 && s < ngRnDock2.x && P.y < ngRnDock2.y + 0.02) ? 1.0 : 0.0;
}
float ngRnHG(float mu, float g) {
  float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  return 0.07957747 * (1.0 - g * g) / (d * sqrt(d));
}
/* 雨粒の照らされ方（屈折した空 + 逆光の key + 灯籠）。vd = カメラ → 粒 */
vec3 ngRnLight(vec3 P, vec3 vd) {
  vec3 L = ngSkyIrr * 1.15 + ngInscatterAmb * 0.5;
  L += ngKeyRad * ngRnHG(dot(vd, ngKeyDir), 0.88) * 0.35;
  vec3 dl = ngRnLamp - P;
  float d2 = max(dot(dl, dl), 0.04);
  vec3 ld = dl * inversesqrt(d2);
  L += ngRnLampC * (0.04 + 0.9 * ngRnHG(dot(vd, ld), 0.8)) / d2 * ngRnA.w;
  return L;
}
`;

/* ---------- 筋 ---------- */
const STREAK_VS = NG_HEIGHTFIELD_GLSL + NG_WIND_GLSL + RAIN_PARS + /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aSeed;
out vec3 vCol;
out float vA;
out vec2 vQ;
void main() {
  const float R = ${fx(RAIN.R)}, H = ${fx(RAIN.H)}, BELOW = ${fx(RAIN.below)};
  float t = ngRnA.x;
  float v = ${fx(RAIN.vMin)} + ${fx(RAIN.vSpan)} * aSeed.w;
  vec3 c = cameraPosition;
  vec4 W0 = ngWindAt(c.xz);
  vec2 w = W0.xy * W0.z * ngRnDock2.z;
  /* 半分の粒は内側の円柱（半径 ${fx(RAIN.RN)}m）：画面に効くのは近くの筋なので、近くを濃く */
  float Ri = fract(aSeed.w * 37.13) < ${fx(RAIN.nearFrac)} ? ${fx(RAIN.RN)} : R;
  vec3 P;
  P.x = c.x - Ri + mod(aSeed.x * 2.0 * Ri + w.x * t - (c.x - Ri), 2.0 * Ri);
  P.z = c.z - Ri + mod(aSeed.y * 2.0 * Ri + w.y * t - (c.z - Ri), 2.0 * Ri);
  P.y = c.y - BELOW + mod(aSeed.z * H - v * t - (c.y - BELOW), H);
  /* 雨の強さで本数を間引く（弱い雨 = 少ない粒）・円柱の外は描かない */
  float pick = fract(aSeed.x * 91.7 + aSeed.z * 13.1 + aSeed.w * 7.3);
  float rh = length(P.xz - c.xz);
  float keep = step(pick, ngRnA.y) * step(rh, Ri);
  /* 地面・水面より下、桟橋の下、樹冠の下（密度の確率） */
  float gy = ngTerrainH(P.xz);
  keep *= step(max(gy, 0.0), P.y);
  keep *= 1.0 - ngRnUnderDock(P);
  vec2 cn = ngCanopyAt(P.xz);
  float under = step(P.y, gy + cn.y * 40.0) * step(fract(pick * 17.31), cn.x * 0.92);
  keep *= 1.0 - under;
  /* 筋の形：速度の向きに伸ばし、視線と直交する向きへ幅 */
  vec3 V = vec3(w.x, -v, w.y);
  float spd = length(V);
  vec3 ax = V / spd;
  vec3 vd = P - c;
  float dist = max(length(vd), 0.05);
  vd /= dist;
  vec3 side = cross(ax, vd);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  /* 長さ：1/40s のシャッター相当（映画の雨の見え方）。幅は 1.6mm を 1.1 画素で下限、覆う割合は平方根で圧縮
     （物理の面積比のままだと 10m 先の筋の α が 0.02 で雨が見えない。遠くほど «粒の重なり» で太く見えるのを近似） */
  float len = spd * (1.0 / 40.0) * 1.15;
  float pxW = dist / max(ngRnA.z, 1.0);
  float wW = max(0.0016, pxW * 1.1);
  float cover = sqrt(0.0016 / wW);
  vec3 pos = P + ax * (position.y - 0.5) * len + side * position.x * wW;
  vQ = position.xy;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = keep > 0.5 ? projectionMatrix * mvPosition : vec4(2.0, 2.0, 2.0, 1.0);
  /* 近すぎる粒（レンズの前を横切る）と円柱の上下の縁は薄く */
  float near = smoothstep(0.35, 1.4, dist);
  float edge = smoothstep(0.0, 1.5, P.y - (c.y - BELOW)) * (1.0 - smoothstep(H - 3.0, H, P.y - (c.y - BELOW))) * (1.0 - smoothstep(0.8 * Ri, Ri, rh));
  vA = keep * near * edge * cover * mix(0.20, 0.42, aSeed.w);
  vCol = ngRnLight(P, vd);
  #include <fog_vertex>
}
`;

const STREAK_FS = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D ngSceneColor;
uniform vec4 ngScreen;
in vec3 vCol;
in float vA;
in vec2 vQ;
void main() {
  if (vA < 1e-4) discard;
  /* 幅の方向は丸い断面、長さの方向は両端を細く */
  float a = (1.0 - vQ.x * vQ.x) * smoothstep(0.0, 0.25, vQ.y) * (1.0 - smoothstep(0.75, 1.0, vQ.y)) * vA;
  /* 屈折：背景を少し横へずらして読む（粒の向こうの景色が明るく歪んで見える） */
  vec2 suv = gl_FragCoord.xy * ngScreen.zw + vec2(vQ.x * 6.0, 4.0) * ngScreen.zw;
  vec3 bg = texture(ngSceneColor, suv).rgb;
  gl_FragColor = vec4(mix(vCol, bg * 1.25 + vCol * 0.3, 0.45), 1.0);
  #include <fog_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}
`;

/* ---------- 着弾 ---------- */
const SPLASH_VS = NG_HEIGHTFIELD_GLSL + RAIN_PARS + /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aSeed;
out vec3 vCol;
out float vA;
out vec2 vQ;
out float vU;
float ngRnH21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  const float RS = 14.0;
  float t = ngRnA.x;
  float per = 0.45 + 0.30 * aSeed.z;
  float ph = t / per + aSeed.w;
  float k = floor(ph);
  float u = fract(ph);
  vec3 c = cameraPosition;
  float ra = ngRnH21(vec2(k * 0.731 + aSeed.x * 17.0, aSeed.y * 29.0));
  float rb = ngRnH21(vec2(aSeed.y * 13.0 - k * 0.377, k * 0.113 + aSeed.x * 5.0));
  float rr = RS * sqrt(ra), th = rb * 6.2831853;
  vec3 P = vec3(c.x + cos(th) * rr, 0.0, c.z + sin(th) * rr);
  float gy = ngTerrainH(P.xz);
  float dockTop = ngRnDock2.y;
  float onDock = ngRnUnderDock(vec3(P.x, dockTop - 0.01, P.z));
  P.y = onDock > 0.5 ? dockTop : gy;
  float keep = step(aSeed.x, ngRnA.y) * (onDock > 0.5 ? 1.0 : step(0.02, gy));   // 水の上は描かない
  vec2 cn = ngCanopyAt(P.xz);
  keep *= 1.0 - step(fract(aSeed.y * 7.7 + k * 0.31), cn.x * 0.9);
  /* カメラを向く縦の板（下端が地面） */
  vec3 vd = P - c;
  float dist = max(length(vd), 0.05);
  vd /= dist;
  vec3 right = normalize(vec3(-vd.z, 0.0, vd.x) + vec3(1e-4, 0.0, 0.0));
  float size = mix(0.07, 0.15, aSeed.z) * (0.6 + 0.6 * u);
  float pxW = dist / max(ngRnA.z, 1.0);
  size = max(size, pxW * 3.0);
  vec3 pos = P + right * position.x * size + vec3(0.0, position.y * size * 0.8, 0.0);
  vQ = position.xy;
  vU = u;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = keep > 0.5 ? projectionMatrix * mvPosition : vec4(2.0, 2.0, 2.0, 1.0);
  vA = keep * smoothstep(0.6, 1.5, dist) * (1.0 - smoothstep(RS * 0.75, RS, rr));
  vCol = ngRnLight(P + vec3(0.0, 0.05, 0.0), vd);
  #include <fog_vertex>
}
`;

const SPLASH_FS = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
in vec3 vCol;
in float vA;
in vec2 vQ;
in float vU;
void main() {
  if (vA < 1e-4) discard;
  /* しぶき：低く広がる柔らかい塊 + 放物線で跳ねる 6 粒（ガウス）。王冠の弧や足もとの輪は数画素の板では
     «白い括弧» の記号に見えたので描かない */
  float u = vU;
  float x = vQ.x, y = vQ.y;
  float r = 0.3 + 0.7 * sqrt(u);
  vec2 bq = vec2(x / (0.55 * r), (y - 0.04) / 0.16);
  float blob = exp(-dot(bq, bq)) * (1.0 - u) * 0.8;
  float drops = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float vx = (fi - 2.5) * 0.36 * (0.8 + 0.4 * fract(fi * 0.618 + vA * 7.0));
    float vy = 1.7 - abs(fi - 2.5) * 0.28;
    vec2 dp = vec2(vx * u * 1.6, vy * u - 2.2 * u * u + 0.05);
    vec2 dd = (vec2(x, y) - dp) / 0.06;
    drops += exp(-dot(dd, dd)) * step(0.0, dp.y);
  }
  float a = clamp(blob + drops * 0.8, 0.0, 1.0) * (1.0 - smoothstep(0.5, 1.0, u)) * vA * 0.3;
  if (a < 1e-3) discard;
  gl_FragColor = vec4(vCol * 1.3, 1.0);
  #include <fog_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}
`;

/* ---------- 遠景の幕 ---------- */
const HAZE_VS = NG_WIND_GLSL + RAIN_PARS + /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform float ngRnRadius;
out vec3 vDir;
out float vH;
void main() {
  vec3 c = cameraPosition;
  vec3 pos = vec3(c.x + position.x * ngRnRadius, position.y, c.z + position.z * ngRnRadius);
  vDir = normalize(pos - c);
  vH = position.y;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const HAZE_FS = RAIN_PARS + /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D ngRnNoise;
uniform highp sampler2D ngSceneDepth;
uniform vec4 ngScreen;
uniform float ngRnRadius;
in vec3 vDir;
in float vH;
void main() {
  float rain = ngRnA.y;
  if (rain < 0.01) discard;
  float az = atan(vDir.z, vDir.x) / 6.2831853;
  vec2 wd = ngWindDir * ngWindSpeed;
  /* 縦に流れる筋（下へ 9m/s、風で横へ）。2 つの尺度 */
  /* 1 周期 = 横 18m・縦 26m（ノイズは横 24 セル = 幕の筋 0.75m。細かすぎると遠景に «櫛» の模様が出る） */
  vec2 uv = vec2(az * ngRnRadius / 18.0 + ngRnA.x * dot(wd, vec2(-vDir.z, vDir.x)) / 18.0, (vH + ngRnA.x * 9.0) / 26.0);
  float n = texture(ngRnNoise, uv).r * 0.65 + texture(ngRnNoise, uv * vec2(2.3, 1.7) + 0.37).g * 0.35;
  /* 幕は一様にしない：大きな尺度（90m × 80m）の濃淡で «雨の帯» が流れて来ては去る（一様だと遠景が櫛の模様） */
  float m = smoothstep(0.25, 0.8, texture(ngRnNoise, vec2(az * ngRnRadius / 90.0 + ngRnA.x * 0.004, vH / 80.0 + 0.31)).r);
  float a = rain * (0.05 + (0.04 + 0.08 * n) * m) * smoothstep(0.0, 6.0, vH) * (1.0 - smoothstep(30.0, 55.0, vH));
  /* 地形に刺さる縁を消す（不透明の深度との差でソフト） */
  float zs = texture(ngSceneDepth, gl_FragCoord.xy * ngScreen.zw).r;
  float zf = gl_FragCoord.z / gl_FragCoord.w;
  a *= smoothstep(0.0, 18.0, zs - zf);
  if (a < 1e-3) discard;
  vec3 L = ngSkyIrr * 1.1 + ngKeyRad * ngRnHG(dot(vDir, ngKeyDir), 0.75) * 0.25 + ngInscatterAmb * 0.4;
  gl_FragColor = vec4(L, 1.0);
  #include <fog_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}
`;

/* 幕のノイズ（縦に伸びた周期の値ノイズ：r = 粗い、g = 細かい）。forge で焼く */
const HAZE_NOISE_FRAG = /* glsl */ `
void main() {
  vec2 p = vUv;
  float a = ngFbmP(p * vec2(24.0, 3.0), vec2(24.0, 3.0), 4);
  float b = ngFbmP(p * vec2(48.0, 5.0) + 3.1, vec2(48.0, 5.0), 3);
  gl_FragColor = vec4(smoothstep(0.35, 0.8, a), smoothstep(0.4, 0.85, b), 0.0, 1.0);
}
`;

/**
 * 雨の一式
 */
export class Rain {
  constructor(ctx, root, seed) {
    const T = ctx.THREE;
    this.ctx = ctx;
    this.T = T;
    this.u = {
      ngRnA: { value: new T.Vector4(0, 0, 1000, 0) }, ngRnDock: { value: new T.Vector4(0, 0, 0, 0) },
      ngRnDock2: { value: new T.Vector4(1.7, 1, RAIN.windCarry, 0) },
      ngRnLamp: { value: new T.Vector3(0, -1000, 0) }, ngRnLampC: { value: new T.Vector3() },
    };
    const rnd = mulberry32(stream(seed, 'wfx-rain'));
    /* 筋：四角（x −1..1、y 0..1）のインスタンス */
    this.streaks = this._instanced(T, 12000, rnd, [-1, 0, 1, 0, 1, 1, -1, 1], [0, 1, 2, 0, 2, 3]);
    this.streakMat = ngShaderMaterial({
      key: 'weatherfx-rain', module: 'weatherfx', lights: false, fog: true,
      uniforms: { ...this.u, ...ctx.heightfield.uniforms, ngSceneColor: ctx.pipeline.uniforms.ngSceneColor, ngScreen: ctx.pipeline.uniforms.ngScreen },
      vertexShader: STREAK_VS, fragmentShader: STREAK_FS,
      /* 両面：筋の四角の巻き方は (side, ax) で決まり、視線に対して裏になる（片面だと 1 本も描かれない） */
      transparent: true, depthWrite: false, depthTest: true, side: T.DoubleSide, blending: T.CustomBlending,
      blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendEquation: T.AddEquation,
    });
    this.streakMesh = this._mesh(T, this.streaks, this.streakMat, 'ng-wfx-rain', root);
    /* 着弾 */
    this.splashes = this._instanced(T, 400, rnd, [-1, 0, 1, 0, 1, 1, -1, 1], [0, 1, 2, 0, 2, 3]);
    this.splashMat = ngShaderMaterial({
      key: 'weatherfx-splash', module: 'weatherfx', lights: false, fog: true,
      uniforms: { ...this.u, ...ctx.heightfield.uniforms },
      vertexShader: SPLASH_VS, fragmentShader: SPLASH_FS,
      transparent: true, depthWrite: false, depthTest: true, blending: T.CustomBlending,
      blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendEquation: T.AddEquation,
    });
    this.splashMesh = this._mesh(T, this.splashes, this.splashMat, 'ng-wfx-splash', root);
    /* 幕：開いた円筒（半径 1、高さ 0..60m）を 2 枚 */
    this.noise = { value: null };
    this.haze = [];
    const cyl = new T.CylinderGeometry(1, 1, 60, 64, 1, true).translate(0, 30, 0);
    for (const r of [55, 110]) {
      const mat = ngShaderMaterial({
        key: 'weatherfx-haze', module: 'weatherfx', lights: false, fog: true,
        uniforms: { ...this.u, ngRnRadius: { value: r }, ngRnNoise: this.noise, ngSceneDepth: ctx.pipeline.uniforms.ngSceneDepth, ngScreen: ctx.pipeline.uniforms.ngScreen },
        vertexShader: HAZE_VS, fragmentShader: HAZE_FS,
        transparent: true, depthWrite: false, depthTest: true, side: T.BackSide, blending: T.CustomBlending,
        blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendEquation: T.AddEquation,
      });
      const m = new T.Mesh(cyl, mat);
      m.frustumCulled = false;
      m.renderOrder = 2 - r / 1000;   // 遠い殻から
      m.name = `ng-wfx-haze-${r}`;
      m.visible = false;
      root.add(m);
      ngOwn(m, NG_LAYER.LATE_FX);
      this.haze.push(m);
    }
    this.hazeCount = 2;
  }

  async bake() {
    const T = this.T;
    const { NG_NOISE_GLSL } = await import('../core/glsl/noise.glsl.js');
    this.noise.value = this.ctx.forge.bake2D({ w: 256, h: 256, frag: NG_NOISE_GLSL + HAZE_NOISE_FRAG, mips: true, wrap: 'repeat', type: T.UnsignedByteType });
  }

  _instanced(T, n, rnd, quad, idx) {
    const g = new T.InstancedBufferGeometry();
    const pos = [];
    for (let i = 0; i < quad.length; i += 2) pos.push(quad[i], quad[i + 1], 0);
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const s = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) s[i] = rnd();
    g.setAttribute('aSeed', new T.InstancedBufferAttribute(s, 4));
    g.instanceCount = 0;
    g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
    g.userData.max = n;
    return g;
  }

  _mesh(T, g, mat, name, root) {
    const m = new T.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = 3;
    m.name = name;
    m.visible = false;
    root.add(m);
    ngOwn(m, NG_LAYER.LATE_FX);
    return m;
  }

  setCounts(q) {
    this.streaks.instanceCount = 0;
    this._nStreaks = Math.min(q.streaks, this.streaks.userData.max);
    this._nSplash = Math.min(q.splashes, this.splashes.userData.max);
    this.hazeCount = q.haze;
  }

  /**
   * 毎フレーム（prepare）
   * @param {object} f
   * @param {{ rain:number, show:boolean, t:number, lamp:object|null }} st
   */
  update(f, st) {
    const u = this.u, cam = f.camera;
    const on = st.show && st.rain > 0.02;
    this.streakMesh.visible = on;
    this.splashMesh.visible = on && st.rain > 0.08;
    for (let i = 0; i < this.haze.length; i++) this.haze[i].visible = on && st.rain > 0.15 && i < this.hazeCount;
    /* 雨の強さで本数を減らす分は GLSL の pick（弱い雨でも描く数は同じ = 引いた粒は頂点で捨てる）。描く上限だけ段で */
    this.streaks.instanceCount = on ? this._nStreaks : 0;
    this.splashes.instanceCount = on ? this._nSplash : 0;
    if (!on) return;
    const hPx = this.ctx.pipeline.uniforms.ngScreen?.value?.y || 1080;
    const pxScale = cam?.isPerspectiveCamera ? hPx / (2 * Math.tan((cam.fov * Math.PI) / 360)) : 1000;
    u.ngRnA.value.set(st.t, Math.min(1, st.rain / 0.85), pxScale, 1);
    const lamp = st.lamp;
    if (lamp && lamp.intensity > 0) {
      u.ngRnLamp.value.copy(lamp.position);
      u.ngRnLampC.value.set(lamp.color.r, lamp.color.g, lamp.color.b).multiplyScalar(lamp.intensity);
    } else u.ngRnLampC.value.set(0, 0, 0);
  }

  setDock(dock, dockY, halfW) {
    if (!dock) return;
    this.u.ngRnDock.value.set(dock.start.x, dock.start.z, dock.end.x, dock.end.z);
    this.u.ngRnDock2.value.set(halfW, dockY, RAIN.windCarry, 0);
  }

  stats() {
    const n = this.streakMesh.visible ? this.streaks.instanceCount : 0, s = this.splashMesh.visible ? this.splashes.instanceCount : 0;
    const h = this.haze.filter((m) => m.visible).length;
    return { draws: (n ? 1 : 0) + (s ? 1 : 0) + h, tris: n * 2 + s * 2 + h * 128, instances: n + s };
  }

  dispose() {
    this.streakMat.dispose(); this.splashMat.dispose();
    for (const m of this.haze) m.material.dispose();
    this.streaks.dispose(); this.splashes.dispose(); this.haze[0]?.geometry.dispose();
  }
}
