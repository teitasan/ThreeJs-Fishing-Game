/* ===========================================================
   描画ターゲットの確保と再確保（ARCHITECTURE §3.2 / §7）
   -----------------------------------------------------------
   main   : RGBA16F（無ければ RGBA8）、high は MSAA、DepthTexture（resolve される）
   copy   : 不透明パスの写し。MRT で sceneColor（RGBA16F、high は mip）と
            sceneDepthLin（R32F の線形深度 m、Nearest）。low は半解像度
   refl   : 平面反射（RGBA16F、mip、深度 RB）。大きさは main × reflection.scale
   大きさは «描画バッファの物理ピクセル × 画素の上限の倍率（profile.maxPixels）× 動的解像度の倍率»。同じ大きさなら何もしない
   =========================================================== */
import { ngPixelCap } from './quality.js';

/**
 * RT の組
 */
export class Targets {
  /**
   * @param {typeof import('three')} THREE
   * @param {import('three').WebGLRenderer} renderer
   */
  constructor(THREE, renderer) {
    this.THREE = THREE;
    this.renderer = renderer;
    const gl = renderer.getContext();
    /** RGBA16F を描けるか（EXT_color_buffer_float / half_float） */
    this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.main = null;
    this.copy = null;
    this.refl = null;
    this._key = '';
  }

  /**
   * 必要なら作り直す
   * @param {number} w 描画バッファの幅（物理 px）
   * @param {number} h
   * @param {number} scale 動的解像度の倍率
   * @param {object} profile quality.js のプロファイル
   * @returns {boolean} 作り直したら true
   */
  ensure(w, h, scale, profile) {
    scale *= ngPixelCap(profile, w, h);
    const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
    const key = [W, H, profile.msaa, profile.copyScale, profile.copyMips, profile.reflection.scale, profile.reflection.mips].join();
    if (key === this._key) return false;
    this._key = key;
    this.dispose();
    const T = this.THREE;
    const type = this.hdr && profile.hdr ? T.HalfFloatType : T.UnsignedByteType;
    const depthTexture = new T.DepthTexture(W, H);
    depthTexture.type = T.UnsignedIntType;
    this.main = new T.WebGLRenderTarget(W, H, {
      type, samples: profile.msaa, depthBuffer: true, depthTexture, stencilBuffer: false,
    });
    this.main.texture.name = 'ng-main';
    const cw = Math.max(1, Math.round(W * profile.copyScale)), ch = Math.max(1, Math.round(H * profile.copyScale));
    this.copy = new T.WebGLRenderTarget(cw, ch, { count: 2, type, depthBuffer: false });
    const [color, depth] = this.copy.textures;
    color.name = 'ng-sceneColor';
    color.generateMipmaps = profile.copyMips > 0;
    color.minFilter = profile.copyMips > 0 ? T.LinearMipmapLinearFilter : T.LinearFilter;
    depth.name = 'ng-sceneDepthLin';
    depth.type = this.hdr ? T.FloatType : T.HalfFloatType;
    depth.format = T.RedFormat;
    depth.minFilter = depth.magFilter = T.NearestFilter;
    depth.generateMipmaps = false;
    const rs = profile.reflection.scale;
    const rw = Math.max(1, Math.round(W * rs)), rh = Math.max(1, Math.round(H * rs));
    this.refl = new T.WebGLRenderTarget(rw, rh, { type, depthBuffer: true, stencilBuffer: false });
    this.refl.texture.name = 'ng-reflection';
    this.refl.texture.generateMipmaps = true;
    this.refl.texture.minFilter = T.LinearMipmapLinearFilter;
    return true;
  }

  /** 推定の VRAM（バイト）。performance.js の RT 見積もりと lab の stats 用 */
  bytes() {
    const px = (rt, bpp) => (rt ? rt.width * rt.height * bpp : 0);
    const m = this.main;
    const s = Math.max(1, m?.samples || 1);
    return px(m, 8) * (s > 1 ? s + 1 : 1) + px(m, 4) * s + px(this.copy, 8) * 1.34 + px(this.copy, 4) + px(this.refl, 8) * 1.34 + px(this.refl, 4);
  }

  /** 文脈の喪失から戻ったとき：喪失前の RT を dispose せずに手放す（次の ensure で作り直す） */
  forget() {
    this.main = this.copy = this.refl = null;
    this._key = '';
  }

  dispose() {
    this.main?.depthTexture?.dispose();
    this.main?.dispose();
    this.copy?.dispose();
    this.refl?.dispose();
    this.main = this.copy = this.refl = null;
  }
}
