/* ===========================================================
   underwater のグレーボックス（本番の代替も兼ねる）
   -----------------------------------------------------------
   - 水の光学（ngFrame slot 9–10）：σa = (0.20, 0.075, 0.045)·(1 + 0.5·rain)、σs = 0.03–0.06。
     水の内散乱 = σs/(σa+σs) × (key の水面透過 0.55 + 空 0.8) の散乱光 / 2π（多重散乱込みの目安）
   - causticsUniforms の動く 6 つ（時刻・key の向き・夜・雨・雲・強さ）を毎フレーム書く。
     uCaustTex には起動時に周期タイル（Worley の境界の明線、R = 網 A・G = 網 B、16 フレームで一巡）を
     forge で焼いて差し込む（オブジェクトは同じまま。魚のマテリアルの参照が切れない）。
     本番の underwater モジュールは屈折した格子の面積比（Evan Wallace 式）に置き換える
   - getUnderwaterContext は旧 Water と同じ形。createEffect は null（水中の後処理なし）
   =========================================================== */
import { NgModule } from '../module.js';
import { NG } from '../frame.js';
import { NG_HASH_GLSL } from '../glsl/noise.glsl.js';
import { updateCausticsTexture } from '../../../shaders.js';
import { CAUSTICS_TILE } from '../../underwater/caustics.glsl.js';

const SIGMA_A = [0.20, 0.075, 0.045];

/* 周期タイルの網目：タイルを cells 個のセルに割った Worley の F2 − F1（境界で 0）を exp(−9·) で明線に。
   セルの特徴点は時刻の一巡（層）で円を 1 周する（最後の層の次が最初の層に繋がる） */
const TILE_FRAG = NG_HASH_GLSL + /* glsl */ `
uniform float ngFrames;
float ngTileNet(vec2 uv, float cells, float t, float seed) {
  vec2 p = uv * cells, i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 h = ngHash22(mod(i + g, cells) + seed);
    vec2 o = 0.5 + 0.35 * vec2(sin(6.2831853 * (t + h.x)), cos(6.2831853 * (t + h.y)));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return exp(-(d2 - d1) * 9.0);
}
void main() {
  float t = ngLayer / ngFrames;
  gl_FragColor = vec4(ngTileNet(vUv, ${CAUSTICS_TILE.cellsA.toFixed(1)}, t, 17.0), ngTileNet(vUv, ${CAUSTICS_TILE.cellsB.toFixed(1)}, t, 71.0), 0.0, 1.0);
}
`;

/**
 * グレーボックスの underwater
 */
export class UnderwaterStub extends NgModule {
  static id = 'underwater';

  constructor(ctx) {
    super(ctx);
    const T = ctx.THREE;
    this.optics = { sigmaA: new T.Vector3(...SIGMA_A), sigmaS: 0.03, insc: new T.Vector3() };
    this._ctx = {
      strength: 0, time: 0, sunDir: new T.Vector3(0, 1, 0), night: 0, rain: 0, cloud: 0,
      absorb: new T.Vector3(...SIGMA_A), camPos: new T.Vector3(), camNear: 0.1, camFar: 3000, waterY: 0,
    };
  }

  async init(progress) {
    this._bakeCaustics();
    this.ctx.services.provide('underwater', {
      getUnderwaterContext: (camera) => this.getUnderwaterContext(camera),
      createEffect: () => null,
      optics: this.optics,
    });
    progress?.(1);
  }

  /* 網目のタイルを焼いて uCaustTex へ（失敗しても caustics が無いだけ） */
  _bakeCaustics() {
    const cu = this.ctx.caustics, forge = this.ctx.forge;
    if (!cu?.uCaustTex || !forge) return;
    try {
      const n = CAUSTICS_TILE.size;
      const img = forge.bakeArrayPixels({ w: n, h: n, layers: CAUSTICS_TILE.frames, frag: TILE_FRAG, uniforms: { ngFrames: { value: CAUSTICS_TILE.frames } } });
      updateCausticsTexture(cu, img);
    } catch (e) {
      this.ctx.log('caustics のタイルを焼けなかった（caustics なしで続行）', e);
    }
  }

  /**
   * Water.update の中から（gfx.waterUpdate）。光学と caustics の動く値
   * @param {object} f
   */
  waterUpdate(f) {
    const frame = this.ctx.frame, F = frame.data;
    const rain = f.weather?.rain || 0, cloud = f.weather?.cloud || 0;
    const sa = SIGMA_A.map((v) => v * (1 + 0.5 * rain));
    const ss = 0.03 + 0.03 * rain;
    frame.set(NG.W_SIGMA, sa[0], sa[1], sa[2], ss);
    const ky = Math.max(F[NG.KEY * 4 + 1], 0);
    const L = [0, 1, 2].map((k) => {
      const E = F[NG.KEYRAD * 4 + k] * ky * 0.98 * 0.55 + F[NG.AMB * 4 + k] * Math.PI * 0.8;
      return (ss / (sa[k] + ss)) * E / (2 * Math.PI);
    });
    frame.set(NG.W_INSC, L[0], L[1], L[2], 1 + rain);
    this.optics.sigmaA.set(sa[0], sa[1], sa[2]);
    this.optics.sigmaS = ss;
    this.optics.insc.set(L[0], L[1], L[2]);
    const cu = this.ctx.caustics;
    if (cu) {
      cu.uCaustTime.value = f.waterTime;
      cu.uCaustSunDir.value.set(F[NG.KEY * 4], F[NG.KEY * 4 + 1], F[NG.KEY * 4 + 2]);
      cu.uCaustNight.value = F[NG.KEY * 4 + 3];
      cu.uCaustRain.value = rain;
      cu.uCaustCloud.value = cloud;
      cu.uCaustStrength.value = this.ctx.gfx?.quality.profile.causticsStrength ?? 0.7;
    }
  }

  /**
   * 旧 Water.getUnderwaterContext と同じ形（同じオブジェクトを書き換えて返す）
   * @param {import('three').Camera} camera
   */
  getUnderwaterContext(camera) {
    const F = this.ctx.frame.data, c = this._ctx, f = this.ctx.gfx?.f;
    c.strength = this.ctx.frame.cam.uw;
    c.time = f?.waterTime ?? 0;
    c.sunDir.set(F[NG.KEY * 4], F[NG.KEY * 4 + 1], F[NG.KEY * 4 + 2]);
    c.night = F[NG.KEY * 4 + 3];
    c.rain = f?.weather?.rain ?? 0;
    c.cloud = f?.weather?.cloud ?? 0;
    c.absorb.copy(this.optics.sigmaA);
    if (camera) { c.camPos.copy(camera.position); c.camNear = camera.near; c.camFar = camera.far; }
    c.waterY = this.ctx.frame.cam.waterY;
    return c;
  }
}

/** @param {object} ctx */
export function createModule(ctx) { return new UnderwaterStub(ctx); }
