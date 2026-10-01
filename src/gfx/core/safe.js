/* ===========================================================
   例外の隔離（ARCHITECTURE §3.2 / §4.11）
   -----------------------------------------------------------
   描画の例外は MP の同期まで止める（game.update が再送出する）ので、
   ng はフレーム中に絶対に投げない。ここが «捕まえて・数えて・切る» 口。
   - guard(module, method, ...args)：3 回投げたらそのモジュールを無効化（root を隠す）
   - guardPass(id, fn)：60 フレームで 2 回失敗したパスは止めて、間を空けて試し直す（30 → 60 → … → 600 フレーム）。
     不透明・late のような «無いと世界が描けない» パスをセッション中に失わない
   - guardRenderHooks(obj, owner)：renderer.render の «中» で呼ばれる物体とマテリアルの関数
     （onBeforeRender / onAfterRender / onBeforeShadow / onAfterShadow、マテリアルの onBeforeCompile / onBeforeRender）を
     包み、例外を render の外へ出さない。持ち主のモジュールには guard と同じ数え方で 1 回と数える（3 回で無効化 → スタブ）
   - onShaderError：シェーダ先頭の «// ngmod:<id>» で失敗したモジュールを特定する
   - 警告はキーごとに 10 秒に 1 回まで
   =========================================================== */

const WARN_INTERVAL_MS = 10000;
/** 止めたパスを試し直すまでのフレーム数（失敗が続くたびに倍、上限あり） */
const PASS_RETRY_FRAMES = 30;
const PASS_RETRY_MAX = 600;
/** 包んだ関数の印 */
const HOOK_WRAPPED = Symbol('ngHookWrapped');
const OBJECT_HOOKS = ['onBeforeRender', 'onAfterRender', 'onBeforeShadow', 'onAfterShadow'];
const MATERIAL_HOOKS = ['onBeforeCompile', 'onBeforeRender'];

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
    /** @type {Set<string>} 止めているパス（retryAt のフレームで試し直す） */
    this.deadPasses = new Set();
    /** @type {Map<string, {at:number, wait:number}>} 止めたパスを試し直すフレームと、次の待ち */
    this.passRetry = new Map();
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
      this.strike(id, method, e);
      return undefined;
    }
  }

  /**
   * モジュールの失敗を 1 回と数える（guard と描画の中の関数で共通）。3 回で無効化
   * @param {string} id
   * @param {string} what
   * @param {*} e
   */
  strike(id, what, e) {
    if (this.disabled.has(id)) return;
    const n = (this.strikes.get(id) || 0) + 1;
    this.strikes.set(id, n);
    this.warn(`${id}.${what} が例外（${n}/3）`, e);
    if (n >= 3) this.disable(id, e);
  }

  /**
   * renderer.render の中で呼ばれる関数を包む（冪等。差し替えられた関数は次の呼び出しで包み直す）。
   * 投げても render は続き（その物体の準備がその回だけ欠ける）、持ち主のモジュールに 1 回と数える。
   * 持ち主の無い（ゲームの）物体は警告だけ
   * @param {object} obj Object3D
   * @param {(obj:object) => (string|null)} owner 持ち主のモジュール id（失敗したときだけ呼ぶ）
   * @param {{object:object, material:object}} protos three の Object3D.prototype / Material.prototype（既定の関数は包まない）
   */
  guardRenderHooks(obj, owner, protos) {
    for (const k of OBJECT_HOOKS) this._wrapHook(obj, obj, k, owner, protos.object[k], null);
    const m = obj.material;
    if (m) {
      if (Array.isArray(m)) { for (const x of m) this._guardMaterial(x, obj, owner, protos); } else this._guardMaterial(m, obj, owner, protos);
    }
    if (obj.customDepthMaterial) this._guardMaterial(obj.customDepthMaterial, obj, owner, protos);
    if (obj.customDistanceMaterial) this._guardMaterial(obj.customDistanceMaterial, obj, owner, protos);
  }

  _guardMaterial(mat, obj, owner, protos) {
    for (const k of MATERIAL_HOOKS) this._wrapHook(mat, obj, k, owner, protos.material[k], protos.material.customProgramCacheKey);
  }

  _wrapHook(target, obj, key, owner, dflt, dfltCacheKey) {
    const fn = target[key];
    if (typeof fn !== 'function' || fn === dflt || fn[HOOK_WRAPPED]) return;
    /* three の既定の customProgramCacheKey は onBeforeCompile.toString()。包むと全部の包みが同じ文字列になり、
       別々のマテリアルがプログラムを取り違えるので、元の関数の文字列を鍵に残す */
    if (key === 'onBeforeCompile' && target.customProgramCacheKey === dfltCacheKey) {
      const k = fn.toString();
      target.customProgramCacheKey = () => k;
    }
    const safety = this;
    const w = function (...a) {
      try { return fn.apply(this, a); } catch (e) {
        let id = null;
        try { id = owner(obj); } catch (e2) { /* 持ち主の判定で落とさない */ }
        if (id) safety.strike(id, `${key}（描画の中）`, e);
        else safety.warn(`ゲームの物体 ${obj?.name || obj?.type || '?'} の ${key} が例外（描画は続ける）`, e);
        return undefined;
      }
    };
    w[HOOK_WRAPPED] = true;
    target[key] = w;
  }

  /** モジュールを無効化する（冪等） */
  disable(id, reason) {
    if (this.disabled.has(id)) return;
    this.disabled.add(id);
    console.warn(`[ng] モジュール ${id} を無効化`, reason || '');
    try { this.onDisable?.(id); } catch (e) { /* 無効化の通知で落とさない */ }
  }

  /**
   * パスを例外なしで実行する。60 フレームで 2 回失敗したら止め、PASS_RETRY_FRAMES 後に試し直す
   * （また 60 フレーム以内に落ちたら待ちを倍に、上限 PASS_RETRY_MAX）。成功したら待ちを戻す
   * @param {string} id
   * @param {() => void} fn
   * @returns {boolean} 成功したら true
   */
  guardPass(id, fn) {
    if (this.deadPasses.has(id)) {
      const r = this.passRetry.get(id);
      if (r && this.frameIndex < r.at) return false;
      this.deadPasses.delete(id);
    }
    try {
      fn();
      const r = this.passRetry.get(id);
      if (r && !r.ok) {
        r.ok = true;
        console.warn(`[ng] パス ${id} が戻った`);
      }
      return true;
    } catch (e) {
      const list = (this.passFails.get(id) || []).filter((f) => this.frameIndex - f < 60);
      list.push(this.frameIndex);
      this.passFails.set(id, list);
      if (list.length === 1) this.warn(`パス ${id} が例外`, e);
      if (list.length >= 2) {
        const prev = this.passRetry.get(id);
        const wait = prev && !prev.ok ? Math.min(PASS_RETRY_MAX, prev.wait * 2) : PASS_RETRY_FRAMES;
        this.passRetry.set(id, { at: this.frameIndex + wait, wait, ok: false });
        this.deadPasses.add(id);
        this.warn(`パス ${id} を止める`, `（60 フレームで 2 回失敗。${wait} フレーム後に試し直す）`, e);
      }
      return false;
    }
  }

  /** パスを止めた状態から戻す（落ちたモジュールを立て直したとき） */
  revivePass(id) {
    this.deadPasses.delete(id);
    this.passFails.delete(id);
    this.passRetry.delete(id);
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
