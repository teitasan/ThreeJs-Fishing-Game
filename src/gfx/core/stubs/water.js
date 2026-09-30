/* ===========================================================
   water のグレーボックス（本番の代替も兼ねる）
   -----------------------------------------------------------
   - 幾何：カメラ中心の入れ子の正方リング（中心 N² @ 32/N m、2 倍ずつ 5 段で ±512m）。
     最小の間隔でカメラへスナップ。粗いリングの内縁の «奇数の頂点» は両隣の平均に落として
     T 字の継ぎ目に隙間を作らない
   - 変位は縦だけ：y = ngWaveH·wind·ngShoalGain(ngDepth)（waveField の waveGLSL をそのまま埋める）。
     CPU の surfaceY と同じ関数。細かい波は法線だけ
   - 陰影：F·反射（reflRT、外れは skyView）+ (1−F)·屈折（sceneColor、深度で有効性を判定）
     + 浅場の散乱 + GGX の太陽（近景の影 × 高さ場影 × 雲影）。吸収は足さない（§3.4）。
     自分の鏡面にだけ空気の透過を掛ける
   - 裏面（水中から）：スネルの窓（臨界角 48.6°）、窓の外は全反射の水の色、水の区間の媒質
   - 波紋：最新 16 件の解析リング（全品質）。しぶき・インパルス・減衰体はスタブでは受けるだけ
   =========================================================== */
import { NgModule } from '../module.js';
import { NG_LAYER, ngOwn } from '../layers.js';
import { ngShaderMaterial } from '../extend.js';
import { NG_HEIGHTFIELD_GLSL } from '../glsl/heightfield.glsl.js';
import { NG_SKYSPEC_GLSL } from '../glsl/surface.glsl.js';
import { NG_SHADOW_GLSL } from '../glsl/shadow.glsl.js';
import { NG_WIND_GLSL } from '../glsl/wind.glsl.js';
import { NG_WATER_F0 } from '../palette.js';
import { waveGLSL } from '../../../waveField.js?v=20260828-lakescale1';

const RINGS = 5;
const RIPPLES = 16;
const GRID_N = { low: 64, mid: 96, high: 128 };

const VS = NG_HEIGHTFIELD_GLSL + waveGLSL({ prefix: 'ng' }) + /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>
uniform vec2 uSnap;
uniform float uTime;
uniform float uWind;
in vec3 aEdge;
out vec3 vWorld;
out float vViewZ;
float ngWaterAt(vec2 p) {
  float d = ngDepth(p);
  return d <= 0.0 ? 0.0 : ngWaveH(p, uTime) * uWind * ngShoalGain(d);
}
void main() {
  vec2 p = position.xz + uSnap;
  float h = aEdge.z > 0.5 ? 0.5 * (ngWaterAt(p - aEdge.xy) + ngWaterAt(p + aEdge.xy)) : ngWaterAt(p);
  vec4 worldPosition = vec4(p.x, h, p.y, 1.0);
  vWorld = worldPosition.xyz;
  vec4 mvPosition = viewMatrix * worldPosition;
  vViewZ = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  vec3 transformedNormal = normalMatrix * vec3(0.0, 1.0, 0.0);
  #include <shadowmap_vertex>
  #include <fog_vertex>
}
`;

const FS = NG_HEIGHTFIELD_GLSL + NG_SKYSPEC_GLSL + NG_WIND_GLSL + waveGLSL({ prefix: 'ng' }) + /* glsl */ `
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
#include <fog_pars_fragment>
` + NG_SHADOW_GLSL + /* glsl */ `
uniform sampler2D ngSceneColor;
uniform highp sampler2D ngSceneDepth;
uniform sampler2D ngReflection;
uniform mat4 ngReflMatrix;
uniform float ngReflValid;
uniform vec4 ngScreen;
uniform float uTime;
uniform float uWind;
uniform vec4 uRipple[${RIPPLES}];   // x, z, 開始時刻, 大きさ
uniform float uRippleDur[${RIPPLES}];
in vec3 vWorld;
in float vViewZ;

/* 細かい波の勾配：風で強さが変わる 2 スケールの値ノイズの解析的な勾配（猫足の斑と凪）。
   差分で何度も評価しない（水面は画面の半分を覆うので断片の手数がそのまま効く） */
vec2 ngDetailSlope(vec2 p, float t, float amp) {
  vec3 a = ngVNoise2D(p * 0.9 + vec2(t * 0.35, t * 0.21));
  vec3 b = ngVNoise2D(p * 2.3 - vec2(t * 0.52, -t * 0.4));
  return (a.yz * 0.9 * 0.012 + b.yz * 2.3 * 0.006) * amp;
}
/* 波紋の輪（最新 16 件）。r = 経過 × 速さ、減衰する sin の帯 */
vec2 ngRippleSlope(vec2 p) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 R = uRipple[i];
    float age = uTime - R.z;
    float dur = uRippleDur[i];
    if (R.w <= 0.0 || age < 0.0 || age > dur) continue;
    vec2 dv = p - R.xy;
    float d = length(dv);
    float rr = age * 0.75 * (0.6 + 0.4 * R.w);
    float x = (d - rr) / (0.12 * R.w + 0.05);
    float a = R.w * 0.05 * (1.0 - age / dur) * exp(-x * x);
    g += a * cos(x * 4.0) * dv / max(d, 1e-3);
  }
  return g;
}
float ngGGX(float NoH, float a) { float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (3.14159265 * d * d); }

void main() {
  vec2 p = vWorld.xz;
  float depthW = ngDepth(p);
  float shoal = depthW <= 0.0 ? 0.0 : ngShoalGain(depthW);
  vec4 wnd = ngWindAt(p);
  vec2 slope = ngWaveD(p, uTime) * uWind * shoal;
  slope += ngDetailSlope(p, ngEnvTime, 0.35 + 0.35 * wnd.z) + ngRippleSlope(p) + ngRainRings(p, ngEnvTime, ngRain) * 3.0;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 V = normalize(cameraPosition - vWorld);
  vec2 suv = gl_FragCoord.xy * ngScreen.zw;
  float rough = 0.04 + 0.05 * ngRain + 0.02 * wnd.z;
  vec3 col;
  if (gl_FrontFacing) {
    float NoV = max(dot(N, V), 1e-3);
    float F = ${NG_WATER_F0.toFixed(3)} + (1.0 - ${NG_WATER_F0.toFixed(3)}) * pow(1.0 - NoV, 5.0);
    /* 反射：射影テクスチャ + 法線の歪み。外れ・無効は skyView */
    vec3 R = reflect(-V, N);
    vec3 refl = ngSkySpecular(R, rough * 4.0);
    if (ngReflValid > 0.5) {
      vec4 q = ngReflMatrix * vec4(vWorld + vec3(N.x, 0.0, N.z) * 0.6, 1.0);
      vec2 ruv = q.xy / q.w;
      if (q.w > 0.0 && ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0) {
        vec4 rc = textureLod(ngReflection, ruv, rough * 6.0);
        refl = mix(refl, rc.rgb, rc.a > 0.0 ? 1.0 : 0.0);
      }
    }
    /* 屈折：厚み（不透明の深度 − 自分の深度）で歪みを弱め、手前の物を拾ったら元へ戻す */
    float sceneZ = texture(ngSceneDepth, suv).r;
    float thick = max(sceneZ - vViewZ, 0.0);
    vec2 ruv2 = suv + N.xz * 0.035 * clamp(thick / 1.5, 0.0, 1.0);
    if (texture(ngSceneDepth, ruv2).r < vViewZ) ruv2 = suv;
    vec3 refr = texture(ngSceneColor, ruv2).rgb;
    /* 岸の 0–3cm では硬い縁を出さない */
    float edge = smoothstep(0.0, 0.03, thick);
    F *= edge;
    float vis = ngSunVisibility(vWorld, getShadowMask());
    vec3 T, Lin;
    ngMediumTerms(vWorld, T, Lin);
    vec3 scatter = (1.0 - F) * ngWaterInsc * 0.15 * vis * edge;
    vec3 H = normalize(ngKeyDir + V);
    float NoL = max(dot(N, ngKeyDir), 0.0);
    float spec = ngGGX(max(dot(N, H), 0.0), rough + 0.02) * F * NoL * 0.25 / max(NoV * max(NoL, 0.1), 0.1);
    col = mix(refr, refl, F) + scatter + ngKeyRad * spec * vis * T;
  } else {
    /* 水中から見上げる：スネルの窓。窓の中は空気側（sceneColor は空気の媒質済み）、外は全反射 */
    vec3 n = -N;
    vec3 I = -V;
    vec3 t = refract(I, n, 1.333);
    vec3 win;
    if (dot(t, t) < 1e-4) {
      win = ngWaterInsc * 0.9 + texture(ngSceneColor, suv).rgb * 0.08;
    } else {
      float c = max(dot(-I, n), 0.0);
      float Fr = 0.02 + 0.98 * pow(1.0 - c, 5.0);
      vec2 ruv = suv + t.xz * 0.02;
      win = mix(texture(ngSceneColor, ruv).rgb, ngWaterInsc, clamp(Fr, 0.0, 1.0)) * (1.0 + 0.6 * smoothstep(0.55, 0.75, length(cross(I, n))));
    }
    vec3 Tw, Lw;
    ngWaterSegment(cameraPosition, vWorld, Tw, Lw);
    col = win * Tw + Lw;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/* 入れ子のリング：中心 N² セル、以降 N² − (N/2)² セルを 2 倍ずつ。
   aEdge = (隣への半歩 x, z, 1)：外縁の奇数番目の頂点は、外側の粗いリングの辺の中点に当たるので
   両隣の平均の高さに落とす（T 字の継ぎ目に隙間を作らない） */
function buildRings(T, N, s0) {
  const pos = [], edge = [], idx = [];
  for (let k = 0; k <= RINGS; k++) {
    const s = s0 * (1 << k), h = N / 2, hole = k ? N / 2 : 0, base = pos.length / 3;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        pos.push((i - h) * s, 0, (j - h) * s);
        const onX = i === 0 || i === N, onZ = j === 0 || j === N;
        if (k < RINGS && onX && !onZ && (j & 1)) edge.push(0, s, 1);
        else if (k < RINGS && onZ && !onX && (i & 1)) edge.push(s, 0, 1);
        else edge.push(0, 0, 0);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (hole && Math.abs(i - h + 0.5) < hole / 2 && Math.abs(j - h + 0.5) < hole / 2) continue;
        const a = base + j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('aEdge', new T.Float32BufferAttribute(edge, 3));
  g.setIndex(idx);
  g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
  return g;
}

/**
 * グレーボックスの water
 */
export class WaterStub extends NgModule {
  static id = 'water';

  constructor(ctx) {
    super(ctx);
    const T = ctx.THREE;
    this._ripples = Array.from({ length: RIPPLES }, () => new T.Vector4(0, 0, -1e9, 0));
    this._rippleDur = new Array(RIPPLES).fill(1);
    this._next = 0;
    this.uniforms = {
      uSnap: { value: new T.Vector2() }, uTime: { value: 0 }, uWind: { value: 1 },
      uRipple: { value: this._ripples }, uRippleDur: { value: this._rippleDur },
      ngSkyViewTex: { value: null }, ngSkyViewMips: { value: 6 },
    };
    this.mesh = null;
    this._n = 0;
  }

  async init(progress) {
    const ctx = this.ctx;
    const mat = ngShaderMaterial({
      key: 'water-stub', module: 'water',
      uniforms: { ...this.uniforms, ...ctx.heightfield?.uniforms, ...ctx.shadows.uniforms, ...ctx.pipeline.uniforms },
      vertexShader: VS, fragmentShader: FS,
      side: ctx.THREE.DoubleSide, blending: ctx.THREE.NoBlending, depthWrite: true,
    });
    this.material = mat;
    this._rebuild(ctx.tier);
    ngOwn(this.root, NG_LAYER.WATER);
    ctx.scene.add(this.root);
    ctx.services.provide('water', {
      addRipple: (x, z, size = 1, dur = 1.6) => this.addRipple(x, z, size, dur),
      addSplash: () => {}, addImpulse: () => {}, addDamper: () => {}, detailTile: null,
    });
    progress?.(1);
  }

  _rebuild(tier) {
    const T = this.ctx.THREE;
    const n = GRID_N[tier] || 96;
    if (n === this._n && this.mesh) return;
    this._n = n;
    const g = buildRings(T, n, 32 / n);
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.geometry = g; return; }
    this.mesh = new T.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ng-water-surface';
    this.root.add(this.mesh);
    ngOwn(this.root, NG_LAYER.WATER);
  }

  /** 波紋の予約（リングバッファ。NaN や範囲外は捨てる。投げない） */
  addRipple(x, z, size = 1, dur = 1.6) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(size > 0) || !(dur > 0)) return;
    const k = this._next;
    this._next = (k + 1) % RIPPLES;
    this._ripples[k].set(x, z, this.uniforms.uTime.value, Math.min(size, 6));
    this._rippleDur[k] = Math.min(dur, 8);
  }

  update(f) {
    const u = this.uniforms;
    u.uTime.value = f.waterTime;
    u.uWind.value = f.waterWind;
    const s = 32 / this._n;
    const c = f.camera?.position;
    if (c) u.uSnap.value.set(Math.round(c.x / s) * s, Math.round(c.z / s) * s);
    u.ngSkyViewTex.value = this.ctx.services.sky.skyViewTex;
    u.ngSkyViewMips.value = this.ctx.services.sky.skyViewMips || 0;
  }

  setQuality(tier) { if (this.mesh) this._rebuild(tier); }

  stats() {
    const g = this.mesh?.geometry;
    return { draws: 1, tris: g ? g.index.count / 3 : 0, instances: 0, texBytes: 0, programs: 1 };
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new WaterStub(ctx); }
