/* ===========================================================
   モジュールの契約（ARCHITECTURE §4.9）
   -----------------------------------------------------------
   src/gfx/<m>/index.js は createModule(ctx) → NgModule を export する。
   Core-A は各パスにグレーボックスのスタブ（src/gfx/core/stubs/<m>.js）を置き、
   担当者は自分の index.js だけを差し替える。初期化に失敗したモジュールは
   core がスタブへ戻す（スタブは本番でも代替として動く）。
   モジュール間の受け口は ctx.services。提供者が居なければ既定値（下の DEFAULTS）を返し、
   関数の受け口はすべて例外を握りつぶす（ファサードから 25 か所以上呼ばれる）
   =========================================================== */

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
 * services の既定値（提供者が居ないときに返る）。
 * 関数は «何もしない・中立の値を返す»。テクスチャは core が起動時に 1×1 を入れる
 */
function defaults() {
  return {
    sky: {
      skyViewTex: null, skyViewMips: 0, transmittanceTex: null, cloudPanoTex: null,
      sampleSky: () => [0.2, 0.3, 0.5], keyColor: [1, 1, 1], cloudShadowAt: () => 1,
    },
    water: {
      addRipple: () => {}, addSplash: () => {}, addImpulse: () => {}, addDamper: () => {}, detailTile: null,
    },
    underwater: { getUnderwaterContext: () => null, createEffect: () => null, optics: null },
    terrain: { coverRules: 'float ngGroundKind(vec3 p) { return 0.0; }\n', farAlbedoTex: null },
    trees: { impostorBake: null },
    hardscape: { piles: [], setLamp: () => {} },
    post: { registerDebugView: () => {} },
  };
}

/**
 * モジュール間の受け口。provide で提供者の値を差し込む（関数は例外を握りつぶす包みになる）
 */
export class Services {
  /** @param {import('./safe.js').Safety} safety */
  constructor(safety) {
    this._safety = safety;
    this._defaults = defaults();
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
    for (const [k, v] of Object.entries(impl || {})) {
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
