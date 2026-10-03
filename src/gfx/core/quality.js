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
 *   pixelRatioMax:number, maxPixels?:number, drs:[number,number], hdr:boolean, msaa:number, postAA:'none'|'smaa'|'fxaa',
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
    pixelRatioMax: 2, drs: [0.7, 1.0], hdr: true, msaa: 4, postAA: 'none', maxPixels: 2.36e6,
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
 * 内部解像度の画素の上限（profile.maxPixels）による倍率。DRS の倍率はこの上に掛かる。
 * high の 2560×1440（3.7MP）は M1 で 1 画素あたりの重さ（MSAA・森の切り抜き・水・post）が 16ms を割らないので、
 * 内部を ≈2.36MP（1440p で 0.8 倍 = 2048×1152）に抑え、FINAL の CAS で戻す。1080p（2.07MP）以下では効かない
 * @param {{maxPixels?: number}} profile
 * @param {number} w 描画バッファの幅（物理 px）
 * @param {number} h
 * @returns {number}
 */
export function ngPixelCap(profile, w, h) {
  const m = profile?.maxPixels;
  if (!(m > 0) || !(w > 0) || !(h > 0)) return 1;
  return Math.min(1, Math.sqrt(m / (w * h)));
}

/**
 * 動的解像度の段（倍率）。RT は倍率が変わるたびに全部（main・copy・refl）作り直すので、細かく刻まない
 * （G0 後の修正：以前は 0.05 刻みで、1 段ごとに high 2560×1440 で +7ms の引っかかりが出ていた）。
 * 各段の範囲（profile.drs）の中の段だけを使う：low [1, 0.85, 0.7, 0.6]、mid [1, 0.85, 0.75]、high [1, 0.85, 0.7]
 */
export const NG_DRS_LEVELS = Object.freeze([1.0, 0.85, 0.75, 0.7, 0.6, 0.5]);

/**
 * 倍率を NG_DRS_LEVELS のいちばん近い段に丸める（pipeline.setRenderScale が使う。post がどんな値を渡しても段に乗る）
 * @param {number} s
 * @returns {number}
 */
export function ngSnapRenderScale(s) {
  const v = Number.isFinite(s) ? Math.min(1, Math.max(0.5, s)) : 1;
  let best = 1, d = Infinity;
  for (const l of NG_DRS_LEVELS) { const e = Math.abs(l - v); if (e < d - 1e-9) { d = e; best = l; } }
  return best;
}

/* 範囲の中の段（大きい順）。範囲の下限が段に無ければ足す */
function drsLevels(range) {
  const lo = Math.min(range?.[0] ?? 1, range?.[1] ?? 1), hi = Math.max(range?.[0] ?? 1, range?.[1] ?? 1);
  const out = NG_DRS_LEVELS.filter((l) => l <= hi + 1e-6 && l >= lo - 1e-6);
  if (!out.length) out.push(ngSnapRenderScale(hi));
  return out;
}

/**
 * 動的解像度の制御（§4.10）。2 秒の p90 が 17.2ms を超えたら 1 段下げ（NG_DRS_LEVELS）、
 * 続けて 14ms 未満が upWait 秒（既定 5）続き、かつ «上の段の見積もり = p90 × (上の段 / 今)²» が 16ms 未満なら 1 段上げる。
 * 上げてから 20 秒以内にまた下げたら（境目の負荷での往復）
 * upWait を倍に（上限 40 秒）、60 秒動かなければ 5 秒へ戻す。RT の作り直しは段の変化のときだけ。
 * window.__gfxCapture のときは 1.0 固定
 */
export class DrsController {
  /** @param {[number, number]} range */
  constructor(range = [0.7, 1.0]) {
    this.range = range;
    this.levels = drsLevels(range);
    this.scale = 1;
    /** 段を変えた回数（RT の作り直しの回数の目安） */
    this.changes = 0;
    this._win = [];
    this._t = 0;
    this._calm = 0;
    this._clock = 0;
    this._upWait = 5;
    this._lastUp = -Infinity;
    this._lastChange = 0;
    this._p90 = 0;
  }

  /** 段が変わったら範囲を差し替える（今の倍率は範囲の段に収める） */
  setRange(range) {
    this.range = range;
    this.levels = drsLevels(range);
    const lv = this.levels;
    if (!lv.includes(this.scale)) this.scale = lv.reduce((b, l) => (Math.abs(l - this.scale) < Math.abs(b - this.scale) ? l : b), lv[0]);
  }

  _step(dir) {
    const lv = this.levels;
    const i = Math.max(0, lv.indexOf(this.scale));
    const j = Math.min(lv.length - 1, Math.max(0, i + dir));
    if (j === i) return;
    this.scale = lv[j];
    this.changes++;
    this._lastChange = this._clock;
  }

  /**
   * 1 フレームぶん進める
   * @param {number} frameMs このフレームの所要時間（ms）
   * @param {number} dt 実時間の経過（s）
   * @param {boolean} frozen 撮影中など、倍率を 1 に固定するとき true
   * @returns {number} 倍率（NG_DRS_LEVELS のどれか）
   */
  update(frameMs, dt, frozen) {
    if (frozen) { this.scale = 1; this._win.length = 0; this._t = 0; this._calm = 0; return 1; }
    if (!(frameMs > 0) || !(dt > 0)) return this.scale;
    this._clock += dt;
    this._win.push(frameMs);
    this._t += dt;
    this._calm = frameMs < 14 ? this._calm + dt : 0;
    if (this._t >= 2) {
      const s = this._win.slice().sort((a, b) => a - b);
      const p90 = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
      this._p90 = p90;
      if (p90 > 17.2 && this.scale > this.levels[this.levels.length - 1]) {
        if (this._clock - this._lastUp < 20) this._upWait = Math.min(40, this._upWait * 2);
        this._step(+1);
        this._calm = 0;
      }
      this._win.length = 0;
      this._t = 0;
    }
    if (this._calm >= this._upWait && this.scale < this.levels[0]) {
      /* 上の段の重さを «画素の数に比例» で見積もり、予算に余裕で入るときだけ上げる（入らない段へ上げてすぐ下げる往復をしない） */
      const lv = this.levels, next = lv[Math.max(0, lv.indexOf(this.scale) - 1)];
      const k = (next / this.scale) ** 2;
      if (!(this._p90 > 0) || this._p90 * k < 16) {
        this._step(-1);
        this._lastUp = this._clock;
      }
      this._calm = 0;
    }
    if (this._clock - this._lastChange > 60) this._upWait = 5;
    return this.scale;
  }
}
