/* ===========================================================
   GPU / CPU の計測（ARCHITECTURE §4.11）
   -----------------------------------------------------------
   計測の方式は 3 つ（mode）：
   - 'off'   ：CPU 時間だけ（本編の既定。GPU を止めない）
   - 'sync'  ：パスの前後で 1×1 の RT を readPixels して GPU の完了を待ち、その間の実時間を測る。
               GPU のパイプラインを止めるので lab とベンチ専用。Chrome の gl.finish() は待たない
               （実測 0.005ms で戻る）ので readPixels で同期する。往復の固定費は較正して引く
   - 'query' ：EXT_disjoint_timer_query_webgl2 の TIME_ELAPSED。ANGLE/Metal（Chrome の macOS）では
               コマンドバッファの境目の待ちまで数えて合計が実フレーム時間を大きく超える
               （docs/nextgen/spikes.md の S-2）。Windows/ANGLE-D3D11 向けに残す
   - TIME_ELAPSED は入れ子にできない。performance.js が 1 フレーム全体を包む問い合わせを
     開いているときは（CURRENT_QUERY が非 null）、そのパスの問い合わせを諦める（警告を出さない）
   - performance.js のパス名 'capture' / 'reflection' / 'composer' を保つ。
     capture = prep + hfShadow + shadow、composer = opaque + copy + late + post（どちらも派生）
   =========================================================== */

/** capture に含めるサブパス */
export const NG_CAPTURE_PASSES = Object.freeze(['prep', 'hfShadow', 'shadow']);
/** composer に含めるサブパス */
export const NG_COMPOSER_PASSES = Object.freeze(['opaque', 'copy', 'late', 'post']);
/** 計測の方式 */
export const NG_BUDGET_MODES = Object.freeze(['off', 'sync', 'query']);

const EMA = 0.1;

/**
 * パスごとの計測
 */
export class Budget {
  /**
   * @param {WebGL2RenderingContext|null} gl
   * @param {{mode?: 'off'|'sync'|'query', sync?: (() => void)|null}} [opts]
   *   sync：GPU の完了を待つ関数（1×1 の RT の readPixels。gfx が three 越しに作って渡す）
   */
  constructor(gl, { mode = 'off', sync = null } = {}) {
    this.gl = gl;
    this._sync = sync;
    this.ext = null;
    /** @type {Record<string, number>} パス名 → GPU ms（移動平均） */
    this.gpuMs = {};
    /** @type {Record<string, number>} パス名 → CPU ms（移動平均。sync では GPU を待つ前まで） */
    this.cpuMs = {};
    this.mode = 'off';
    this._syncCost = 0;
    this._pool = [];
    this._pending = [];
    this._active = null;
    this._query = null;
    this._cpu0 = 0;
    this._gpu0 = 0;
    this._gpuSum = {};
    this._cpuSum = {};
    this.setMode(mode);
  }

  /**
   * renderer が来たときに GL と同期の口を差し込む（gfx.attachRenderer。モジュールの ctx.budget は同じ物のまま）
   * @param {WebGL2RenderingContext} gl
   * @param {{mode?: 'off'|'sync'|'query', sync?: (() => void)|null}} [opts]
   */
  attach(gl, { mode = this.mode, sync = this._sync } = {}) {
    this.gl = gl;
    this._sync = sync;
    this.ext = null;
    this.setMode(mode);
  }

  /** GPU 計測が有効か */
  get gpuEnabled() { return this.mode !== 'off'; }

  /**
   * 計測の方式を変える（lab のベンチが 'sync' にして、終わったら戻す）。
   * 使えない方式は 'off' に落ちる。計測値は捨てる
   * @param {'off'|'sync'|'query'} mode
   * @returns {string} 実際の方式
   */
  setMode(mode) {
    if (this._active) this.end();
    let m = NG_BUDGET_MODES.includes(mode) ? mode : 'off';
    if (m === 'query') {
      this.ext = this.ext || (this.gl ? this.gl.getExtension('EXT_disjoint_timer_query_webgl2') : null);
      if (!this.ext) m = 'off';
    }
    if (m === 'sync' && !this._sync) m = 'off';
    this.mode = m;
    if (m === 'sync') this._calibrate();
    this.reset();
    return m;
  }

  /* readPixels の往復の固定費（空のパイプラインでの中央値） */
  _calibrate() {
    const s = [];
    this._sync();
    for (let i = 0; i < 9; i++) {
      const t = now();
      this._sync();
      s.push(now() - t);
    }
    s.sort((a, b) => a - b);
    this._syncCost = s[4];
  }

  /**
   * パスの計測を始める（前のパスが開いていたら閉じる）
   * @param {string} name
   */
  begin(name) {
    if (this._active) this.end();
    this._active = name;
    if (this.mode === 'sync') { this._sync(); this._gpu0 = now(); }
    this._cpu0 = now();
    if (this.mode !== 'query') return;
    const gl = this.gl;
    if (gl.getQuery(this.ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) { this._query = null; return; }
    const q = this._pool.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._query = q;
    this._pending.push({ name, q });
  }

  /** 開いているパスを閉じる */
  end() {
    const name = this._active;
    if (!name) return;
    this._active = null;
    this._add(this.cpuMs, this._cpuSum, name, now() - this._cpu0);
    if (this.mode === 'sync') {
      this._sync();
      this._add(this.gpuMs, this._gpuSum, name, Math.max(0, now() - this._gpu0 - this._syncCost));
    } else if (this.mode === 'query' && this._query) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this._query = null;
    }
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

  /** フレームの終わりに呼ぶ。返ってきたクエリの結果を集め、派生（capture / composer）を足す */
  poll() {
    if (this._active) this.end();
    if (this.mode === 'query' && this._pending.length) {
      const gl = this.gl;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      let keep = 0;
      for (let i = 0; i < this._pending.length; i++) {
        const p = this._pending[i];
        if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { this._pending[keep++] = p; continue; }
        const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
        if (!disjoint) this._add(this.gpuMs, this._gpuSum, p.name, ns / 1e6);
        this._pool.push(p.q);
      }
      this._pending.length = keep;
      /* 返らないクエリ（文脈の喪失など）は捨てて溜めない */
      while (this._pending.length > 64) gl.deleteQuery(this._pending.shift().q);
    }
    derive(this.gpuMs);
    derive(this.cpuMs);
  }

  /** GPU の合計（ms）。派生（capture / composer）は重ねて数えない */
  gpuTotal() {
    let s = 0;
    for (const [k, v] of Object.entries(this.gpuMs)) if (k !== 'composer' && k !== 'capture') s += v;
    return s;
  }

  /** 計測値を捨てる（品質やカメラを変えたとき・ベンチの頭） */
  reset() {
    this.gpuMs = {};
    this.cpuMs = {};
    this._gpuSum = {};
    this._cpuSum = {};
  }

  /**
   * reset からの単純平均と最小（ベンチ用）。ほかのプロセスが GPU を取り合う機械では、
   * 最小が «邪魔の無いときの値» の良い推定になる
   * @returns {{gpuMs: Record<string, number>, cpuMs: Record<string, number>, gpuMin: Record<string, number>}}
   */
  mean() {
    const pick = (acc, i) => {
      const out = {};
      for (const [k, a] of Object.entries(acc)) out[k] = i === 0 ? a[0] / a[1] : a[2];
      derive(out);
      return out;
    };
    return { gpuMs: pick(this._gpuSum, 0), cpuMs: pick(this._cpuSum, 0), gpuMin: pick(this._gpuSum, 2) };
  }

  _add(tab, acc, k, v) {
    if (!Number.isFinite(v)) return;
    ema(tab, k, v);
    const a = acc[k] || (acc[k] = [0, 0, Infinity]);
    a[0] += v; a[1]++;
    if (v < a[2]) a[2] = v;
  }

  /** WebGL の文脈が戻ったとき：古い問い合わせは無効なので捨てる */
  restoreGPU() {
    this._pool.length = 0;
    this._pending.length = 0;
    this._query = null;
    this._active = null;
  }
}

function derive(tab) {
  const sum = (keys) => keys.reduce((s, k) => s + (tab[k] || 0), 0);
  const cap = sum(NG_CAPTURE_PASSES), comp = sum(NG_COMPOSER_PASSES);
  if (cap > 0) tab.capture = cap;
  if (comp > 0) tab.composer = comp;
}

function ema(tab, k, v) {
  if (!Number.isFinite(v)) return;
  tab[k] = tab[k] === undefined ? v : tab[k] + (v - tab[k]) * EMA;
}

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
