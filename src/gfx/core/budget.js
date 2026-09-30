/* ===========================================================
   GPU / CPU の計測（ARCHITECTURE §4.11）
   -----------------------------------------------------------
   - EXT_disjoint_timer_query_webgl2 があればパスごとの GPU 時間（ns → ms）。
     TIME_ELAPSED は入れ子にできないので、パスは順に begin → end する
   - 結果は数フレーム遅れて返るので、ポーリングして指数移動平均にする
   - performance.js のパス名 'capture' / 'reflection' / 'composer' を保つ。
     composer は opaque + copy + late + post の和（派生）
   - 計測は gpu: true のときだけ（lab・?gpuTimer=1）。本編では CPU 時間のみ
   =========================================================== */

/** composer に含めるサブパス */
export const NG_COMPOSER_PASSES = ['opaque', 'copy', 'late', 'post'];

const EMA = 0.1;

/**
 * パスごとの計測
 */
export class Budget {
  /**
   * @param {WebGL2RenderingContext|null} gl
   * @param {{gpu?: boolean}} [opts]
   */
  constructor(gl, { gpu = false } = {}) {
    this.gl = gl;
    this.ext = gpu && gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    /** @type {Record<string, number>} パス名 → GPU ms（移動平均） */
    this.gpuMs = {};
    /** @type {Record<string, number>} パス名 → CPU ms（移動平均） */
    this.cpuMs = {};
    this._pool = [];
    this._pending = [];
    this._active = null;
    this._cpu0 = 0;
  }

  /** GPU 計測が有効か */
  get gpuEnabled() { return !!this.ext; }

  /**
   * パスの計測を始める（前のパスが開いていたら閉じる）
   * @param {string} name
   */
  begin(name) {
    if (this._active) this.end();
    this._active = name;
    this._cpu0 = performance.now();
    if (!this.ext) return;
    const gl = this.gl;
    const q = this._pool.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._pending.push({ name, q });
  }

  /** 開いているパスを閉じる */
  end() {
    const name = this._active;
    if (!name) return;
    this._active = null;
    ema(this.cpuMs, name, performance.now() - this._cpu0);
    if (this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }

  /**
   * パスを計測しながら fn を実行する（例外は呼び出し側へ）
   * @template T
   * @param {string} name
   * @param {() => T} fn
   * @returns {T}
   */
  measure(name, fn) {
    this.begin(name);
    try { return fn(); } finally { this.end(); }
  }

  /** フレームの終わりに呼ぶ。返ってきたクエリの結果を集める */
  poll() {
    if (this._active) this.end();
    if (!this.ext || this._pending.length === 0) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    let keep = 0;
    for (let i = 0; i < this._pending.length; i++) {
      const p = this._pending[i];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { this._pending[keep++] = p; continue; }
      const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
      if (!disjoint) ema(this.gpuMs, p.name, ns / 1e6);
      this._pool.push(p.q);
    }
    this._pending.length = keep;
    if (this._pending.length > 256) this._pending.splice(0, this._pending.length - 256);   // 返らないクエリを溜めない
    const comp = NG_COMPOSER_PASSES.reduce((s, k) => s + (this.gpuMs[k] || 0), 0);
    if (comp > 0) this.gpuMs.composer = comp;
  }

  /** GPU の合計（ms）。composer は重ねて数えない */
  gpuTotal() {
    let s = 0;
    for (const [k, v] of Object.entries(this.gpuMs)) if (k !== 'composer') s += v;
    return s;
  }

  /** 計測値を捨てる（品質やカメラを変えたとき） */
  reset() {
    this.gpuMs = {};
    this.cpuMs = {};
  }
}

function ema(tab, k, v) {
  if (!Number.isFinite(v)) return;
  tab[k] = tab[k] === undefined ? v : tab[k] + (v - tab[k]) * EMA;
}
