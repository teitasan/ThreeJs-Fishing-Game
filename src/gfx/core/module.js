/* ===========================================================
   モジュールの契約（ARCHITECTURE §4.9）
   -----------------------------------------------------------
   src/gfx/<m>/index.js は createModule(ctx) → NgModule を export する。
   Core-A は各パスにグレーボックスのスタブ（src/gfx/core/stubs/<m>.js）を置き、
   担当者は自分の index.js だけを差し替える。初期化に失敗したモジュールは
   core がスタブへ戻す（スタブは本番でも代替として動く）。
   モジュール間の受け口は ctx.services。提供者が居なければ既定値（ngServiceDefaults）を返し、
   関数の受け口はすべて例外を握りつぶす（ファサードから 25 か所以上呼ばれる）
   =========================================================== */
import { NG } from './frame.js';
import { cloudShadow } from './medium.js';

/** モジュールの一覧（読み込み・update の順） */
export const NG_MODULE_IDS = Object.freeze(['sky', 'water', 'underwater', 'terrain', 'trees', 'groundcover', 'shoreflora', 'hardscape', 'weatherfx', 'post']);

/**
 * モジュールの基底。既定の実装はすべて何もしない（スタブ・担当者の実装が必要なものだけ上書きする）
 *
 * ctx = { THREE, renderer, scene, camera, tier, profile, lake, terrain, heightfield, placement, frame, wind,
 *         pipeline, shadows, forge, workers, caustics, services, budget, log }
 * f   = { dt, sdt, envTime, waterTime, waterWind, hour, camera, camPos, focus, frameIndex, paused, uw, flowDir, flowStrength }
 */
export class NgModule {
  /** 'sky' | 'water' | ... */
  static id = 'module';

  /** @param {object} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    /** 自分の物体はすべてここに入れる（?ng=-<id> で丸ごと無効化できる） */
    this.root = new ctx.THREE.Group();
    this.root.name = `ng-${this.constructor.id}`;
    this.root.userData.ngOwned = true;
  }

  /** 重い処理は分割して await（1 回 ≤ 30ms）。progress(0..1) */
  async init(progress) { progress?.(1); }
  /** CPU の毎フレーム更新（gfx.updateModules から） */
  update(f) {}
  /** GPU の準備（P1、pipeline.prepare の中） */
  prepare(f) {}
  /** 各パスの直前（passId は NG_PASS） */
  beforePass(passId, camera) {}
  /** 品質の変更。部分集合の作り直しと RT の再確保だけ（ライト数・castShadow は変えない） */
  setQuality(tier, profile) {}
  /** LOD 倍率 */
  setLodScale(k) {}
  /** WebGL の文脈が戻ったとき（焼いた RT を作り直す） */
  restoreGPU() {}
  /** @returns {{draws:number, tris:number, instances:number, texBytes:number, programs:number}} */
  stats() { return { draws: 0, tris: 0, instances: 0, texBytes: 0, programs: 0 }; }
  dispose() {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => { o.geometry?.dispose?.(); });
  }
}

/**
 * services の既定値（提供者が居ないときに返る。§4.9 の表の全項目）。
 * 関数は «何もしない・中立の値を返す»。テクスチャは 1×1 の中立値（null を束縛させない）。
 * null のままの項目（water.detailTile・trees.impostorBake）は «機能が無い» の意味で、使う側が確かめる
 * @param {typeof import('three')} THREE
 * @param {{frame: import('./frame.js').NgFrame,
 *          underwaterContext: (camera: object) => object,
 *          registerDebugView: (name: string, glsl: string, uniforms?: object) => void,
 *          addDamper?: (list: Array<{x:number,z:number,r:number}>) => void,
 *          dampers?: Array<{x:number,z:number,r:number}>}} core
 *   core が持つ代替（水中の文脈は ngFrame から、デバッグ表示は core の登録表へ、減衰体は core の一覧へ）
 * @returns {Record<string, Record<string, any>>}
 */
export function ngServiceDefaults(THREE, core) {
  const px = (r, g, b, a, name) => {
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
    t.name = name;
    t.needsUpdate = true;
    return t;
  };
  const F = core.frame.data;
  const optics = { sigmaA: new THREE.Vector3(0.20, 0.075, 0.045), sigmaS: 0.03, insc: new THREE.Vector3() };
  return {
    sky: {
      /* 空の放射輝度の緯度経度（ngSkyViewUV）。既定は中立の青灰 */
      skyViewTex: px(51, 77, 128, 255, 'ng-default-skyView'), skyViewMips: 0,
      /* 大気の透過（1 = 減衰なし） */
      transmittanceTex: px(255, 255, 255, 255, 'ng-default-transmittance'),
      /* 雲のパノラマ（rgb = 雲の内散乱、a = 透過。既定は雲なし） */
      cloudPanoTex: px(0, 0, 0, 255, 'ng-default-cloudPano'),
      /** @param {{x:number,y:number,z:number}} dir @returns {number[]} rgb（既定は空の平均放射輝度 = SH0/π） */
      sampleSky: () => [F[NG.AMB * 4], F[NG.AMB * 4 + 1], F[NG.AMB * 4 + 2]],
      keyColor: new THREE.Color(1, 1, 1),
      /* 雲の影（1 = 日向）。ngCloudShadow の CPU 双子 */
      cloudShadowAt: (x, z) => cloudShadow(F, { x, y: 0, z }),
    },
    water: {
      addRipple: () => {}, addSplash: () => {}, addImpulse: () => {},
      /* 減衰体は core が持つ（NG_CORE_OWNED）：呼ぶ人の順・water の作り直しに依らず、water は dampers を prepare で読む */
      addDamper: core.addDamper || (() => {}), dampers: core.dampers || [],
      detailTile: null,
    },
    underwater: {
      getUnderwaterContext: (camera) => core.underwaterContext(camera),
      createEffect: () => null,
      optics,
    },
    terrain: {
      coverRules: 'float ngGroundKind(vec3 p) { return 0.0; }\n',
      farAlbedoTex: px(31, 33, 24, 255, 'ng-default-farAlbedo'),
    },
    trees: { impostorBake: null },
    hardscape: { piles: [], setLamp: () => {} },
    post: { registerDebugView: (name, glsl, uniforms) => core.registerDebugView(name, glsl, uniforms) },
  };
}

/**
 * core が持ち、提供者が上書きできない項目（provide に入れても無視して警告する）。
 * - water.addDamper / water.dampers：減衰体の一覧（shoreflora・hardscape が init で足し、water が prepare で読む。
 *   water が先に init されても、無効化されて立て直されても一覧は残る）
 * - post.registerDebugView：デバッグ表示の登録表（gfx.debugViews。lab の view(name) と、post が本編で出すときの元）
 */
export const NG_CORE_OWNED = Object.freeze({ water: Object.freeze(['addDamper', 'dampers']), post: Object.freeze(['registerDebugView']) });

/**
 * モジュール間の受け口。provide で提供者の値を差し込む（関数は例外を握りつぶす包みになる）
 */
export class Services {
  /**
   * @param {import('./safe.js').Safety} safety
   * @param {Record<string, Record<string, any>>} defaults ngServiceDefaults の戻り値
   */
  constructor(safety, defaults) {
    this._safety = safety;
    this._defaults = defaults;
    for (const [k, v] of Object.entries(this._defaults)) this[k] = { ...v };
  }

  /**
   * 提供者の値を差し込む。未提供のキーは既定値のまま
   * @param {string} id 'sky' | 'water' | ...
   * @param {object} impl
   */
  provide(id, impl) {
    const base = this._defaults[id] || {};
    const out = { ...base };
    const owned = NG_CORE_OWNED[id] || [];
    for (const [k, v] of Object.entries(impl || {})) {
      if (owned.includes(k)) {
        if (v !== base[k]) this._safety.warn(`services.${id}.${k} は core が持つ項目（provide では上書きしない。CORE_API §6）`);
        continue;
      }
      if (typeof v !== 'function') { out[k] = v; continue; }
      const fallback = base[k];
      out[k] = (...args) => {
        try { return v(...args); } catch (e) {
          this._safety.warn(`services.${id}.${k} が例外`, e);
          return typeof fallback === 'function' ? fallback(...args) : undefined;
        }
      };
    }
    this[id] = out;
  }

  /** 提供者を外して既定値へ戻す（モジュールの無効化・スタブへの差し戻し） */
  reset(id) {
    if (this._defaults[id]) this[id] = { ...this._defaults[id] };
  }
}
