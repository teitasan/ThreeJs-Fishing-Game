/* ===========================================================
   sky のグレーボックス（本番の代替も兼ねる）
   -----------------------------------------------------------
   光のリグの producer：ngFrame の slot 0–7・12・13・17 を書き、
   CPU 双子の色・key の色と強さ・SH（LightProbe）を返す（ARCHITECTURE §4.13）。
   空のモデルは «解析的な一次散乱 + 多重散乱の係数»：
     L(v) = E·T_s · (βR·P_R + βM·P_M)/(βR + βM) · (1 − e^(−τ(v))) · G + 夕方の青 + 夜の底
   τ(v) は Chapman 近似の空気量（地平で Rayleigh 35 倍・Mie 91 倍）。媒質 ngApplyMedium と
   同じ β を使うので、遠景の霞と空の地平が同じ色へ溶ける（残りは ngInscatterAmb で解く）。
   雲は ngCloudCoverAt の 2D 層（雲影と同じ式）、太陽円盤は周縁減光つき（FP16 でクランプ）。
   太陽の軌道は旧式（ファサードが sunDir を渡す）。key は太陽高度 −1° で月に替わり、
   交差点で両方の強度が 0 になる（影が跳ばない）
   =========================================================== */
import { NgModule } from '../module.js';
import { NG, NG_PASS, NG_FRAME_GLSL, ngFrameData } from '../frame.js';
import { NG_MEDIUM_GLSL } from '../glsl/medium.glsl.js';
import { NG_LAYER, ngOwn } from '../layers.js';
import { ngShaderMaterial } from '../extend.js';
import { NG_SURFACE_GLSL } from '../glsl/surface.glsl.js';
import { NG_UNITS, ngScheduledExposure, ngLuminance } from '../palette.js';
import { solveInscatterAmb, fogNearFar, cloudShadow } from '../medium.js';

const BETA_R = [5.8e-6, 13.5e-6, 33.1e-6];
const H_R = 8000, H_M = 1200, MIE_G = 0.76;
const BETA_M0 = 3.5e-5;
const K_R = 0.028, K_M = 0.011;               // 地平の空気量 1/K（35 倍・91 倍）
const SIN_1DEG = Math.sin(Math.PI / 180);
const MOON_E = NG_UNITS.MOON;
const NIGHT_FLOOR = [0.0011, 0.0016, 0.0029];
const TWILIGHT_BLUE = [0.0022, 0.0050, 0.0125];
const CLOUD_R = 1500;                          // 雲の領域の 24h 周期の円の半径（m）
const SH_DIRS = 128;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const airmass = (mu, k) => { const m = Math.max(mu, 0); return 1 / (m + k * Math.exp(-m / k)); };
const phaseR = (mu) => 0.0596831 * (1 + mu * mu);
const phaseHG = (mu, g) => { const d = Math.max(1 + g * g - 2 * g * mu, 1e-4); return 0.07957747 * (1 - g * g) / (d * Math.sqrt(d)); };

/* GLSL 版の空（ドームと skyView LUT が共有）。CPU の skyRadiance と同じ式 */
const SKY_GLSL = NG_SURFACE_GLSL + /* glsl */ `
uniform vec3 uSkySunE;     // E_top·T_s·G（太陽由来）
uniform vec3 uSkyMoonE;    // 月由来
uniform vec3 uSkyAmb;      // 夕方の青 + 夜の底（等方）
uniform vec3 uCloudLit;    // 雲の明るさ
float skyAirmass(float mu, float k) { float m = max(mu, 0.0); return 1.0 / (m + k * exp(-m / k)); }
float skyPhaseHG(float mu, float g) { float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4); return 0.07957747 * (1.0 - g * g) / (d * sqrt(d)); }
vec3 skyClear(vec3 v) {
  float vy = max(v.y, 0.0);
  vec3 bR = ngBetaR, bM = ngBetaM;
  vec3 tau = bR * ngHR * skyAirmass(vy, ${K_R}) + bM * ngHM * skyAirmass(vy, ${K_M});
  vec3 fill = 1.0 - exp(-tau);
  float mu = dot(v, ngSunDir);
  vec3 s = (bR * 0.0596831 * (1.0 + mu * mu) + bM * skyPhaseHG(mu, ngMieG)) / (bR + bM);
  vec3 m = (bR * 0.0596831 * (1.0 + mu * mu) + bM * skyPhaseHG(-mu, ngMieG)) / (bR + bM);
  return (uSkySunE * s + uSkyMoonE * m) * fill + uSkyAmb * (0.55 + 0.45 * fill);
}
/* 雲の 2D 層（雲影と同じ被覆）。地平へ向かうほど霞に溶ける */
vec3 skyWithClouds(vec3 v, vec3 cam) {
  vec3 L = skyClear(v);
  if (v.y <= 0.0) return L;
  float t = max(ngCloudBase - cam.y, 10.0) / max(v.y, 0.03);
  vec2 p = cam.xz + v.xz * t;
  float c = ngCloudCoverAt(p) * smoothstep(0.0, 0.12, v.y);
  float fwd = skyPhaseHG(dot(v, ngKeyDir), 0.6) * 4.0;       // 太陽側の雲の縁が明るい
  vec3 Lc = uCloudLit * (0.85 + 0.6 * fwd * (1.0 - c));
  return mix(L, Lc, c * 0.92);
}
`;

const DOME_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vec2 ndc = position.xy;
  vec3 dv = vec3((ndc.x + projectionMatrix[2][0]) / projectionMatrix[0][0], (ndc.y + projectionMatrix[2][1]) / projectionMatrix[1][1], -1.0);
  vDir = transpose(mat3(viewMatrix)) * dv;
  gl_Position = vec4(ndc, 1.0, 1.0);
}
`;
const DOME_FS = SKY_GLSL + /* glsl */ `
uniform vec3 uSunDisk;     // 円盤の放射輝度（雲の減光前）
uniform vec3 uMoonDisk;
uniform float uStars;
varying vec3 vDir;
void main() {
  vec3 v = normalize(vDir);
  vec3 L = skyWithClouds(v, cameraPosition);
  float cover = v.y > 0.0 ? ngCloudCoverAt(cameraPosition.xz + v.xz * max(ngCloudBase - cameraPosition.y, 10.0) / max(v.y, 0.03)) : 1.0;
  /* 太陽 0.53°・月 0.52°。周縁減光 */
  float cs = dot(v, ngSunDir);
  float r = sqrt(max(1.0 - cs * cs, 0.0)) / 0.004625;
  if (cs > 0.0 && r < 1.0) L += uSunDisk * (1.0 - 0.6 * (1.0 - sqrt(1.0 - r * r))) * (1.0 - cover);
  float cm = -cs;
  float rm = sqrt(max(1.0 - cm * cm, 0.0)) / 0.004538;
  if (cm > 0.0 && rm < 1.0) L += uMoonDisk * (0.85 + 0.15 * ngHash12(floor(v.xz * 900.0))) * (1.0 - cover);
  /* 星：正積に近い写像のセル。夜だけ・雲で消える・反射では大きく */
  if (uStars > 0.0 && v.y > 0.0 && ngNight > 0.01) {
    float sz = ngPassId > 0.5 ? 180.0 : 320.0;
    vec2 q = v.xz / (1.0 + v.y) * sz;
    vec2 cell = floor(q);
    float h = ngHash12(cell);
    if (h > 0.985) {
      vec2 o = ngHash22(cell) * 0.6 + 0.2;
      float d = length(q - cell - o);
      float b = pow(ngHash12(cell + 7.7), 6.0) * 0.06 + 0.004;
      L += vec3(0.8, 0.9, 1.0) * b * smoothstep(0.35, 0.0, d) * ngNight * (1.0 - cover) * smoothstep(0.0, 0.2, v.y);
    }
  }
  if (v.y < 0.0) L *= mix(1.0, 0.45, smoothstep(0.0, -0.2, v.y));
  gl_FragColor = vec4(min(L, vec3(30000.0)), 1.0);
}
`;
const SKYVIEW_FRAG = NG_FRAME_GLSL + NG_MEDIUM_GLSL + SKY_GLSL + /* glsl */ `
uniform vec3 uCam;
void main() {
  vec3 v = ngSkyViewDir(vUv);
  vec3 L = skyWithClouds(v, uCam);
  if (v.y < 0.0) L *= mix(1.0, 0.45, smoothstep(0.0, -0.2, v.y));
  gl_FragColor = vec4(L, 1.0);
}
`;

/**
 * 空の CPU 双子（SH・地平の整合・色）。GLSL の skyWithClouds を «雲の平均被覆» で近似
 * @param {Float32Array} F ngFrameData
 * @param {object} p produce が決めた係数
 * @param {number} x
 * @param {number} y
 * @param {number} z 単位ベクトル
 * @returns {number[]} rgb
 */
export function skyRadiance(F, p, x, y, z) {
  const vy = Math.max(y, 0);
  const sx = F[NG.SUN * 4], sy = F[NG.SUN * 4 + 1], sz = F[NG.SUN * 4 + 2];
  const mu = x * sx + y * sy + z * sz;
  const mR = airmass(vy, K_R), mM = airmass(vy, K_M);
  const out = [0, 0, 0];
  const c = p.coverMean * smooth(0, 0.12, y);
  for (let k = 0; k < 3; k++) {
    const bR = F[NG.BETA_R * 4 + k], bM = F[NG.BETA_M * 4 + k];
    const fill = 1 - Math.exp(-(bR * H_R * mR + bM * H_M * mM));
    const s = (bR * phaseR(mu) + bM * phaseHG(mu, MIE_G)) / (bR + bM);
    const m = (bR * phaseR(mu) + bM * phaseHG(-mu, MIE_G)) / (bR + bM);
    let L = (p.sunE[k] * s + p.moonE[k] * m) * fill + p.amb[k] * (0.55 + 0.45 * fill);
    if (y > 0) L += (p.cloudLit[k] * 0.9 - L) * c * 0.92;
    if (y < 0) L *= 1 - 0.55 * smooth(0, -0.2, y);
    out[k] = L;
  }
  return out;
}

/**
 * グレーボックスの sky
 */
export class SkyStub extends NgModule {
  static id = 'sky';

  constructor(ctx) {
    super(ctx);
    const T = ctx.THREE;
    this.wet = 0;
    this.gain = 1;
    this.p = { sunE: [0, 0, 0], moonE: [0, 0, 0], amb: [0, 0, 0], cloudLit: [0, 0, 0], coverMean: 0 };
    this.colors = {
      sunColor: new T.Color(), zenithColor: new T.Color(), horizonColor: new T.Color(), fogColor: new T.Color(),
    };
    this.key = { color: new T.Color(), intensity: 0 };
    this.fog = { near: 100, far: 1000, color: this.colors.fogColor };
    this.sh = new T.SphericalHarmonics3();
    this._shT = -1;
    this._shDirs = fibonacciSphere(SH_DIRS);
    this._basis = Array.from({ length: 9 }, () => new T.Vector3());
    this._v = new T.Vector3();
    this.uniforms = {
      uSkySunE: { value: new T.Vector3() }, uSkyMoonE: { value: new T.Vector3() },
      uSkyAmb: { value: new T.Vector3() }, uCloudLit: { value: new T.Vector3() },
      uSunDisk: { value: new T.Vector3() }, uMoonDisk: { value: new T.Vector3() },
      uStars: { value: 1 }, uCam: { value: new T.Vector3() }, ngFrame: { value: ngFrameData },
    };
    this.gain = this._calibrate();
    this.skyView = null;
    this.dome = null;
  }

  async init(progress) {
    const T = this.ctx.THREE;
    const mat = ngShaderMaterial({
      key: 'sky-stub-dome', module: 'sky', uniforms: this.uniforms,
      vertexShader: DOME_VS, fragmentShader: DOME_FS,
      lights: false, fog: false, depthWrite: false, depthTest: true, depthFunc: T.LessEqualDepth,
    });
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.dome = new T.Mesh(g, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1e9;          // 不透明の最後（depth = 1・LEQUAL で空の画素だけ塗る）
    this.dome.name = 'ng-sky-dome';
    this.root.add(this.dome);
    ngOwn(this.root, NG_LAYER.WORLD);
    this.ctx.scene.add(this.root);
    this.skyView = this.ctx.forge.target(128, 64, { type: T.HalfFloatType, mips: true, wrap: 'clamp' });
    this.skyView.texture.wrapS = T.RepeatWrapping;
    this.ctx.services.provide('sky', {
      skyViewTex: this.skyView.texture, skyViewMips: 6,
      sampleSky: (d) => skyRadiance(this.ctx.frame.data, this.p, d.x, d.y, d.z),
      keyColor: this.key.color,
      cloudShadowAt: (x, z) => cloudShadow(this.ctx.frame.data, { x, y: 0, z }),
    });
    progress?.(1);
  }

  /* 真昼・快晴の空の照度が NG_UNITS.SKY_NOON になる多重散乱の係数 G を解く */
  _calibrate() {
    const F = new Float32Array(this.ctx.frame.data.length);
    const noonSun = norm3(0, 1, 0.34);
    this._coeffs(F, noonSun, 0.14, 0, 1);
    const E = this._irradianceUp(F);
    return NG_UNITS.SKY_NOON / Math.max(ngLuminance(E[0], E[1], E[2]), 1e-6);
  }

  _irradianceUp(F) {
    const E = [0, 0, 0];
    const dirs = this._shDirs, w = (4 * Math.PI) / dirs.length;
    for (const d of dirs) {
      if (d[1] <= 0) continue;
      const L = skyRadiance(F, this.p, d[0], d[1], d[2]);
      for (let k = 0; k < 3; k++) E[k] += L[k] * d[1] * w;
    }
    return E;
  }

  /* 太陽・月・雲・霞の係数を F と this.p に書く（produce と較正が共有） */
  _coeffs(F, sun, cloud, rain, gain) {
    const c = clamp01(cloud), r = clamp01(rain);
    const haze = 1 + 1.5 * c + 3.5 * r;
    const bM = BETA_M0 * haze;
    set4(F, NG.BETA_R, BETA_R[0], BETA_R[1], BETA_R[2], H_R);
    set4(F, NG.BETA_M, bM, bM, bM, H_M);
    set4(F, NG.SUN, sun[0], sun[1], sun[2], 1);
    const tSun = trans(sun[1], bM);
    const tZen = trans(1, BETA_M0 * 1.21);
    const Etop = NG_UNITS.KEY_NOON / Math.max(ngLuminance(tZen[0], tZen[1], tZen[2]) * 1.02, 1e-6);
    const sunUp = smooth(-0.30, 0.02, sun[1]);             // 沈んでも上空は暫く照らされる
    const moonT = trans(-sun[1], bM);
    const moonUp = smooth(-0.30, 0.02, -sun[1]);
    const moonTop = MOON_E / Math.max(ngLuminance(tZen[0], tZen[1], tZen[2]), 1e-6);
    const dim = 1 - 0.55 * c * c;                          // 空そのものの暗さ（雲の下）
    const tw = smooth(-0.22, -0.02, sun[1]) * (1 - smooth(-0.02, 0.18, sun[1]));
    for (let k = 0; k < 3; k++) {
      this.p.sunE[k] = Etop * tSun[k] * sunUp * gain * dim;
      this.p.moonE[k] = moonTop * moonT[k] * moonUp * gain * dim;
      this.p.amb[k] = NIGHT_FLOOR[k] + TWILIGHT_BLUE[k] * tw * Etop / 3.6;
    }
    /* 雲の明るさ：日向の雲は key の 9%、雨の乱層雲は暗い腹 */
    const lit = (0.10 + 0.06 * (1 - c)) * (1 - 0.6 * r);
    for (let k = 0; k < 3; k++) {
      this.p.cloudLit[k] = (Etop * tSun[k] * sunUp + moonTop * moonT[k] * moonUp) * lit + this.p.amb[k];
    }
    this.p.coverMean = clamp01(c * 1.05);
    return { tSun, Etop, sunUp, moonT, moonTop, moonUp };
  }

  /**
   * 光のリグの producer（gfx.beginFrame から毎フレーム。init の前でも動く）
   * @param {{dt:number, hour:number, weather:{cloud:number, rain:number}, sunDir:{x,y,z}, camera:object, focus:object}} input
   * @returns {{colors:object, fog:{near:number, far:number, color:object}, key:{color:object, intensity:number}, sh:object, keyDir:number[]}}
   */
  produce(input) {
    const F = this.ctx.frame.data, frame = this.ctx.frame;
    const cloud = clamp01(input.weather?.cloud ?? 0.14), rain = clamp01(input.weather?.rain ?? 0);
    const s = norm3(input.sunDir.x, input.sunDir.y, input.sunDir.z);
    const cf = this._coeffs(F, s, cloud, rain, this.gain);
    /* key：太陽高度 −1° で月へ。交差点で両方 0（sunGate(−1°) = moonGate(+1°) = 0） */
    const useSun = s[1] > -SIN_1DEG;
    const kd = useSun ? s : [-s[0], -s[1], -s[2]];
    const gate = useSun ? smooth(-SIN_1DEG, 0.10, s[1]) : smooth(SIN_1DEG, 0.10, -s[1]);
    const cloudDim = 1 - 0.82 * cloud * cloud;
    const E = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      E[k] = (useSun ? cf.Etop * cf.tSun[k] : cf.moonTop * cf.moonT[k]) * gate * cloudDim;
    }
    const night = clamp01(input.nightAmount ?? smooth(0.08, -0.16, s[1]));
    frame.set(NG.KEY, kd[0], kd[1], kd[2], night);
    frame.set(NG.KEYRAD, E[0], E[1], E[2], s[1]);
    frame.setComp(NG.SUN, 3, useSun ? 0 : gate);
    /* 雲影：被覆の領域は 24h 周期の円を回る（時刻の純関数・真夜中で連続） */
    const a = ((input.hour % 24) / 24) * Math.PI * 2;
    const shStrength = 0.6 * smooth(0.15, 0.5, cloud) * (1 - smooth(0.85, 1.0, cloud));
    frame.set(NG.CLOUDSH, Math.cos(a) * CLOUD_R, Math.sin(a) * CLOUD_R, 1 / 900, shStrength);
    frame.set(NG.CLOUDS, clamp01(cloud * 1.05), rain > 0.3 ? 600 : 1400, rain > 0.3 ? 2400 : 2600, a);
    /* 朝霧：4:30–8:00、5:45 に最大。雨上がり（濡れ）で濃い */
    const h = ((input.hour % 24) + 24) % 24;
    const dawn = smooth(4.5, 5.75, h) * (1 - smooth(5.75, 8.0, h));
    const dt = Math.max(0, input.dt || 0);
    const wetTarget = rain > 0.1 ? 1 : 0;
    const tau = wetTarget > this.wet ? 10 : 60;            // 実秒 = ゲーム分
    this.wet += (wetTarget - this.wet) * (1 - Math.exp(-dt / tau));
    frame.set(NG.MIST, 0.012 * dawn * (1 + this.wet) * (1 - 0.7 * rain), 0, 5, MIE_G);
    frame.set(NG.WEATHER, this.wet, rain, this.wet * 0.6, 0.42);
    /* SH（4Hz）と空の照度 */
    const t = input.envTime ?? 0;
    if (this._shT < 0 || t - this._shT >= 0.25 || t < this._shT) {
      this._shT = t;
      this._projectSH(F, E);
    }
    const up = this._shUp;
    frame.set(NG.AMB, up[0] / Math.PI, up[1] / Math.PI, up[2] / Math.PI, cloud);
    /* 地平線の整合：8 方位の空の地平に 3km 先の霞の漸近値を合わせる */
    const cam = input.camera?.position || { x: 0, y: 2, z: 0 };
    const A = solveInscatterAmb(F, cam, (dx, dz) => skyRadiance(F, this.p, dx, 0.02, dz));
    frame.set(NG.INSC, A[0], A[1], A[2], 0.02 * (up[1] + E[1]));
    /* GLSL の空の係数 */
    const u = this.uniforms;
    u.uSkySunE.value.fromArray(this.p.sunE);
    u.uSkyMoonE.value.fromArray(this.p.moonE);
    u.uSkyAmb.value.fromArray(this.p.amb);
    u.uCloudLit.value.fromArray(this.p.cloudLit);
    const omegaSun = 6.8e-5, omegaMoon = 6.4e-5;
    u.uSunDisk.value.set(cf.Etop * cf.tSun[0], cf.Etop * cf.tSun[1], cf.Etop * cf.tSun[2]).multiplyScalar(smooth(-0.01, 0.01, s[1]) / omegaSun);
    u.uMoonDisk.value.set(cf.moonTop * cf.moonT[0], cf.moonTop * cf.moonT[1], cf.moonTop * cf.moonT[2]).multiplyScalar(0.6 * smooth(-0.01, 0.01, -s[1]) / omegaMoon);
    /* ファサードへ返す色（露出を掛けた «見た目の» 線形色）と key */
    const ex = ngScheduledExposure(Math.asin(clampN(s[1])) * 180 / Math.PI, cloud, rain);
    const zen = skyRadiance(F, this.p, 0, 1, 0), hor = skyRadiance(F, this.p, 1, 0.03, 0);
    const lk = ngLuminance(E[0], E[1], E[2]);
    const col = this.colors;
    col.zenithColor.setRGB(zen[0] * ex, zen[1] * ex, zen[2] * ex);
    col.horizonColor.setRGB(hor[0] * ex, hor[1] * ex, hor[2] * ex);
    col.fogColor.copy(col.horizonColor);
    if (lk > 1e-6) col.sunColor.setRGB(E[0] / lk, E[1] / lk, E[2] / lk); else col.sunColor.setRGB(1, 1, 1);
    this.key.color.copy(col.sunColor);
    this.key.intensity = lk;
    const fnf = fogNearFar(F, cam);
    this.fog.near = fnf.near; this.fog.far = fnf.far;
    return { colors: col, fog: this.fog, key: this.key, sh: this.sh, keyDir: kd };
  }

  /* 128 方向の空 + 地面の照り返し（アルベド 0.12）を SH L2 に射影する（放射輝度の SH） */
  _projectSH(F, E) {
    const T = this.ctx.THREE, sh = this.sh, basis = this._basis, v = this._v;
    const w = (4 * Math.PI) / this._shDirs.length;
    for (const c of sh.coefficients) c.set(0, 0, 0);
    const up = this._irradianceUp(F);
    this._shUp = up;
    const ky = Math.max(F[NG.KEY * 4 + 1], 0);
    const g = [0, 1, 2].map((k) => 0.12 * (E[k] * ky + up[k]) / Math.PI);
    for (const d of this._shDirs) {
      const L = d[1] > 0 ? skyRadiance(F, this.p, d[0], d[1], d[2]) : g;
      v.set(d[0], d[1], d[2]);
      T.SphericalHarmonics3.getBasisAt(v, basis);
      for (let i = 0; i < 9; i++) sh.coefficients[i].x += L[0] * basis[i] * w;
      for (let i = 0; i < 9; i++) sh.coefficients[i].y += L[1] * basis[i] * w;
      for (let i = 0; i < 9; i++) sh.coefficients[i].z += L[2] * basis[i] * w;
    }
  }

  prepare() {
    if (!this.skyView) return;
    const c = this.ctx.camera?.position;
    if (c) this.uniforms.uCam.value.copy(c);
    this.ctx.frame.setComp(NG.CAM, 3, NG_PASS.BAKE);
    this.ctx.forge.run(this.skyView, SKYVIEW_FRAG, this.uniforms);
  }

  stats() {
    return { draws: 2, tris: 2, instances: 0, texBytes: 128 * 64 * 8 * 1.34, programs: 2 };
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new SkyStub(ctx); }

function trans(mu, bM) {
  const mR = airmass(mu, K_R), mM = airmass(mu, K_M);
  return BETA_R.map((b) => Math.exp(-(b * H_R * mR + bM * H_M * mM)));
}
function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
function set4(F, slot, x, y, z, w) { F[slot * 4] = x; F[slot * 4 + 1] = y; F[slot * 4 + 2] = z; F[slot * 4 + 3] = w; }
function clampN(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
function fibonacciSphere(n) {
  const out = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = ga * i;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
}
