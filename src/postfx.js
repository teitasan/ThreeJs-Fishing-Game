/* ===========================================================
   PostFX ファサード（ARCHITECTURE §5.3、CONTRACT §4.4）
   -----------------------------------------------------------
   game.js から見える形だけを保ち、中身は描画の芯（src/gfx/core）へ委ねる：
     new PostFX(renderer, scene, camera, { quality, water, sky, exposure })
     setSize / setQuality / updateUnderwater / render(dt) / warmup()
   - renderer.toneMapping = NoToneMapping（トーンマップは post の最後に 1 回だけ。game の ACES を上書き）
   - water / sky の uLinearOut は 1 に保つ（自前シェーダはリニアで出す）
   - どのメソッドも例外を投げない（描画の例外は MP の同期まで止めるため）
   - composer / bloom は performance.js の RT 見積もり用の互換（optional chaining で読まれるだけ）
   =========================================================== */
import * as THREE from 'three';
import { createGfx, getGfx } from './gfx/core/index.js';

const warned = new Set();
function warnOnce(tag, e) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[postfx] ${tag}`, e);
}

/**
 * game.js の PostFX（CONTRACT §4.4）。中身は描画の芯のパイプラインと post モジュール
 */
export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {{quality?:string, water?:object, sky?:object, exposure?:number}} [opts]
   */
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.water = opts.water || null;
    this.sky = opts.sky || null;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.gfx = null;
    try {
      this.gfx = getGfx() || createGfx({ scene });
      this.gfx.attachRenderer(renderer);
      this.gfx.bindCamera(camera);
      this.gfx.setQuality(opts.quality || 'mid');
    } catch (e) {
      warnOnce('core の初期化に失敗、素のレンダリングで続行します', e);
      this.gfx = null;
    }
    this._holdLinearOut();
    const t = this.gfx?.targets;
    /** performance.js の RT 見積もりの互換（main と sceneColor の写し） */
    this.composer = {
      get inputBuffer() { return t?.main || null; },
      get outputBuffer() { return t?.copy || null; },
      depthRenderTarget: null,
    };
    /** Bloom は post モジュールの持ち物。見積もりの互換だけ */
    this.bloom = null;
  }

  _holdLinearOut() {
    if (this.water?.uniforms?.uLinearOut) this.water.uniforms.uLinearOut.value = 1;
    if (this.sky?.uLinearOut) this.sky.uLinearOut.value = 1;
  }

  /** 画面の大きさ（CSS px。RT は描画バッファの物理 px で作り直す） */
  setSize(w, h) {
    try { this.gfx?.setSize(w, h); } catch (e) { warnOnce('setSize', e); }
  }

  /** 品質（'low' | 'mid' | 'high'） */
  setQuality(q) {
    try { this.gfx?.setQuality(q); } catch (e) { warnOnce('setQuality', e); }
  }

  /** 水中の状態（Water.getUnderwaterContext の戻り値）。水中の後処理は post モジュールが読む */
  updateUnderwater(ctx) {
    this.uw = ctx || null;
  }

  /** 1 フレームを描く（P4–P7）。core が無ければ素の render */
  render(dt) {
    this._holdLinearOut();
    if (!this.gfx) {
      try { this.renderer.render(this.scene, this.camera); } catch (e) { warnOnce('render', e); }
      return;
    }
    try {
      this.gfx.bindCamera(this.camera);
      this.gfx.pipeline?.renderMain(dt);
    } catch (e) { warnOnce('render', e); }
  }

  /** 読み込みの最後：compileAsync + 各パスの空回し 3 フレーム */
  async warmup() {
    try { await this.gfx?.warmup(); } catch (e) { warnOnce('warmup', e); }
  }
}
