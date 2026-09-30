/* ===========================================================
   例外の隔離（ARCHITECTURE §3.2 / §4.11）
   -----------------------------------------------------------
   描画の例外は MP の同期まで止める（game.update が再送出する）ので、
   ng はフレーム中に絶対に投げない。ここが «捕まえて・数えて・切る» 口。
   - guard(module, method, ...args)：3 回投げたらそのモジュールを無効化（root を隠す）
   - guardPass(id, fn)：60 フレームで 2 回失敗したパスはセッション中止
   - onShaderError：シェーダ先頭の «// ngmod:<id>» で失敗したモジュールを特定する
   - 警告はキーごとに 10 秒に 1 回まで
   =========================================================== */

const WARN_INTERVAL_MS = 10000;

/** モジュールと GLSL の出どころを示すシェーダ先頭の印 */
export const NG_MODULE_TAG = '// ngmod:';

/**
 * 例外の集計と無効化の判断をまとめて持つ
 */
export class Safety {
  constructor() {
    /** @type {Map<string, number>} モジュール id → 失敗回数 */
    this.strikes = new Map();
    /** @type {Set<string>} 無効化したモジュール id */
    this.disabled = new Set();
    /** @type {Map<string, number[]>} パス id → 失敗したフレーム番号 */
    this.passFails = new Map();
    /** @type {Set<string>} 止めたパス */
    this.deadPasses = new Set();
    /** @type {Set<string>} シェーダが落ちたモジュール id（次のフレームで代替マテリアルへ） */
    this.shaderFailed = new Set();
    this.frameIndex = 0;
    this._lastWarn = new Map();
    /** モジュールを無効化したときに呼ぶ（gfx が root を隠す） */
    this.onDisable = null;
  }

  /** キーごとにレート制限した警告 */
  warn(key, ...args) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const t = this._lastWarn.get(key);
    if (t !== undefined && now - t < WARN_INTERVAL_MS) return;
    this._lastWarn.set(key, now);
    console.warn(`[ng] ${key}`, ...args);
  }

  /**
   * module[method](...args) を例外なしで呼ぶ。3 回失敗したら無効化
   * @param {{constructor:{id?:string}, id?:string}} module
   * @param {string} method
   * @returns {*} 戻り値（失敗・無効時は undefined）
   */
  guard(module, method, ...args) {
    const id = module?.constructor?.id || module?.id || '?';
    if (this.disabled.has(id)) return undefined;
    const fn = module && module[method];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(module, args);
    } catch (e) {
      const n = (this.strikes.get(id) || 0) + 1;
      this.strikes.set(id, n);
      this.warn(`${id}.${method} が例外（${n}/3）`, e);
      if (n >= 3) this.disable(id, e);
      return undefined;
    }
  }

  /** モジュールを無効化する（冪等） */
  disable(id, reason) {
    if (this.disabled.has(id)) return;
    this.disabled.add(id);
    console.warn(`[ng] モジュール ${id} を無効化`, reason || '');
    try { this.onDisable?.(id); } catch (e) { /* 無効化の通知で落とさない */ }
  }

  /**
   * パスを例外なしで実行する。60 フレームで 2 回失敗したらセッション中は止める
   * @param {string} id
   * @param {() => void} fn
   * @returns {boolean} 成功したら true
   */
  guardPass(id, fn) {
    if (this.deadPasses.has(id)) return false;
    try {
      fn();
      return true;
    } catch (e) {
      const list = (this.passFails.get(id) || []).filter((f) => this.frameIndex - f < 60);
      list.push(this.frameIndex);
      this.passFails.set(id, list);
      if (list.length === 1) console.warn(`[ng] パス ${id} が例外`, e);
      if (list.length >= 2) {
        this.deadPasses.add(id);
        console.warn(`[ng] パス ${id} を停止（60 フレームで 2 回失敗）`);
      }
      return false;
    }
  }

  /**
   * renderer.debug.onShaderError に入れる関数を作る。three の既定のログは残しつつ、
   * 印からモジュールを特定して shaderFailed に積む
   * @returns {(gl:WebGL2RenderingContext, program:WebGLProgram, vs:WebGLShader, fs:WebGLShader) => void}
   */
  shaderErrorHandler() {
    return (gl, program, vs, fs) => {
      let src = '';
      try { src = (gl.getShaderSource(fs) || '') + (gl.getShaderSource(vs) || ''); } catch (e) { /* 失われた文脈 */ }
      const i = src.indexOf(NG_MODULE_TAG);
      const id = i >= 0 ? src.slice(i + NG_MODULE_TAG.length).split(/[:\s]/)[0] : null;
      let log = '';
      try {
        log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
          .filter(Boolean).join('\n').slice(0, 2000);
      } catch (e) { /* noop */ }
      console.error(`[ng] シェーダのリンクに失敗（${id || '非 ng'}）\n${log}`);
      if (id) this.shaderFailed.add(id);
    };
  }
}
