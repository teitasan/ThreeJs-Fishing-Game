/* ===========================================================
   品質表（ARCHITECTURE §7 の全体の行）と onQuality
   -----------------------------------------------------------
   - キーは 'low' | 'mid' | 'high'（セーブ互換）
   - 各モジュールは src/gfx/<m>/quality.js に自分の表を持ち、ここは core の分だけ
   - setQuality は RT の再確保と部分集合の作り直しだけ。ライト数と castShadow は変えない
   - MSAA の自動降格（high の 4× → 2× + SMAA）は msaaFallback で表す（docs/nextgen/spikes.md）
   three を import しない
   =========================================================== */

/** @typedef {'low'|'mid'|'high'} NgTier */

/**
 * core の品質プロファイル
 * @type {Readonly<Record<NgTier, {
 *   pixelRatioMax:number, drs:[number,number], hdr:boolean, msaa:number, postAA:'none'|'smaa'|'fxaa',
 *   copyScale:number, copyMips:number,
 *   nearShadow:{size:number, extent:number, radius:number},
 *   hfShadow:{levels:number, size:number},
 *   reflection:{scale:number, everyOther:boolean, lodBias:number, mips:number},
 *   causticsStrength:number
 * }>>}
 */
export const NG_TIERS = Object.freeze({
  low: {
    pixelRatioMax: 1, drs: [0.6, 1.0], hdr: true, msaa: 0, postAA: 'fxaa',
    copyScale: 0.5, copyMips: 0,
    nearShadow: { size: 1024, extent: 30, radius: 1.5 },
    hfShadow: { levels: 1, size: 512 },
    reflection: { scale: 0.25, everyOther: true, lodBias: 1, mips: 3 },
    causticsStrength: 0.32,
  },
  mid: {
    pixelRatioMax: 1.5, drs: [0.75, 1.0], hdr: true, msaa: 0, postAA: 'smaa',
    copyScale: 1, copyMips: 0,
    nearShadow: { size: 2048, extent: 40, radius: 1.75 },
    hfShadow: { levels: 2, size: 1024 },
    reflection: { scale: 0.5, everyOther: false, lodBias: 1, mips: 4 },
    causticsStrength: 0.72,
  },
  high: {
    pixelRatioMax: 2, drs: [0.7, 1.0], hdr: true, msaa: 4, postAA: 'none',
    copyScale: 1, copyMips: 4,
    nearShadow: { size: 3072, extent: 48, radius: 2 },
    hfShadow: { levels: 2, size: 1024 },
    reflection: { scale: 0.6, everyOther: false, lodBias: 0, mips: 5 },
    causticsStrength: 1.0,
  },
});

/**
 * プログラムとサンプラーの上限（統合者の決定、core-requests A-6）。
 * - total：1 つの段・影あり で同時に生きているプログラムの総数（ゲームの釣り人・魚・UI を含む）。
 *   段を替えると core が古い段の ng のプログラムを手放す（index.js の _releaseStalePrograms）
 * - perModule：1 モジュールが 1 つの段で持つプログラム（影用の depth / distance の変種も 1 本と数える）
 * - samplers：1 プログラムの断片 / 頂点のサンプラーの数（MAX_TEXTURE_IMAGE_UNITS が 16 の環境を守る）
 */
export const NG_PROGRAM_BUDGET = Object.freeze({ total: 90, perModule: 6, samplers: Object.freeze({ frag: 12, vert: 4 }) });

/** 旧キー 'medium' などを正規化する */
export function normalizeTier(q) {
  return q === 'low' || q === 'high' ? q : 'mid';
}

/**
 * 現在の品質と購読者。setQuality は冪等（同じ段なら何もしない）
 */
export class Quality {
  constructor(tier = 'mid') {
    /** @type {NgTier} */
    this.tier = normalizeTier(tier);
    /**
     * MSAA の降格（spikes.md の判定）。true なら high でも 2× + SMAA
     * @type {boolean}
     */
    this.msaaFallback = false;
    this._subs = new Set();
  }

  /** 現在の段の core プロファイル（msaaFallback を反映した写し） */
  get profile() {
    const p = NG_TIERS[this.tier];
    if (this.tier === 'high' && this.msaaFallback) return { ...p, msaa: 2, postAA: 'smaa' };
    return p;
  }

  /**
   * 段を変える。変わったときだけ購読者へ (tier, profile) を配る
   * @param {string} q
   * @returns {boolean} 変わったら true
   */
  set(q) {
    const t = normalizeTier(q);
    if (t === this.tier) return false;
    this.tier = t;
    this._emit();
    return true;
  }

  /** MSAA の降格を切り替える（変わったときだけ配る） */
  setMsaaFallback(on) {
    if (this.msaaFallback === !!on) return;
    this.msaaFallback = !!on;
    this._emit();
  }

  /**
   * 品質の変更を購読する
   * @param {(tier:NgTier, profile:object) => void} fn
   * @returns {() => void} 解除
   */
  onQuality(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit() {
    const p = this.profile;
    for (const fn of this._subs) {
      try { fn(this.tier, p); } catch (e) { console.warn('[ng] onQuality の購読者が例外', e); }
    }
  }
}

/**
 * 動的解像度の制御（§4.10）。2 秒の p90 が 17.2ms を超えたら −0.05、
 * 5 秒続けて 14ms 未満なら +0.05。window.__gfxCapture のときは 1.0 固定
 */
export class DrsController {
  /** @param {[number, number]} range */
  constructor(range = [0.7, 1.0]) {
    this.range = range;
    this.scale = 1;
    this._win = [];
    this._t = 0;
    this._calm = 0;
  }

  /** 段が変わったら範囲を差し替える（今の倍率は範囲に収める） */
  setRange(range) {
    this.range = range;
    this.scale = Math.min(range[1], Math.max(range[0], this.scale));
  }

  /**
   * 1 フレームぶん進める
   * @param {number} frameMs このフレームの所要時間（ms）
   * @param {number} dt 実時間の経過（s）
   * @param {boolean} frozen 撮影中など、倍率を 1 に固定するとき true
   * @returns {number} 倍率
   */
  update(frameMs, dt, frozen) {
    if (frozen) { this.scale = 1; this._win.length = 0; this._t = 0; this._calm = 0; return 1; }
    if (!(frameMs > 0) || !(dt > 0)) return this.scale;
    this._win.push(frameMs);
    this._t += dt;
    this._calm = frameMs < 14 ? this._calm + dt : 0;
    if (this._t >= 2) {
      const s = this._win.slice().sort((a, b) => a - b);
      const p90 = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
      if (p90 > 17.2) this.scale = Math.max(this.range[0], this.scale - 0.05);
      this._win.length = 0;
      this._t = 0;
    }
    if (this._calm >= 5) { this.scale = Math.min(this.range[1], this.scale + 0.05); this._calm = 0; }
    return this.scale;
  }
}
