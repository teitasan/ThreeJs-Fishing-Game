/* ===========================================================
   ためる量 → キャストのクリップのフレーム

   ここだけ独立しているのは、three.js を使わない純粋な計算で、
   単体テスト（scripts/cast-origin-test.mjs）から直接呼べるようにするため。
   =========================================================== */

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 「ためる量 0..1」→「クリップのフレーム」の対応表を作る。
 *
 * sweep はフレームごとの «竿の前後の傾き»（前向きが正）。ためる範囲を等間隔に
 * 送ると、前後の動きがためる量に比例しない。Mixamo のキャストは前半で竿を横へ
 * 払ってから後半で後ろへ倒すので、実測ではためる量 0→0.5 のあいだ竿先の前後が
 * 1.42→1.43m しか動かず、0.5→1.0 で一気に 1.94m 動いていた。狙う距離はメーターで
 * 決めるのに、その前半で竿がまったく反応しないため «連動していない» ように見える。
 * ここで sweep を逆に引いて、前後の動きが比例する表にする。
 *
 * @param {number[]} sweep フレームごとの竿の前後の傾き
 * @param {number} f0 ためる範囲の始まり（フレーム）
 * @param {number} f1 ためる範囲の終わり（フレーム）
 * @param {number} n 表の刻み数
 * @returns {number[]|null} 長さ n のフレーム列。作れなければ null（呼び出し側は等間隔に戻す）
 */
export function chargeFrameTable(sweep, f0, f1, n = 33) {
  if (!Array.isArray(sweep) || sweep.length < 3) return null;
  const a = Math.max(0, Math.round(f0));
  const b = Math.min(sweep.length - 1, Math.round(f1));
  if (b - a < 2) return null;
  /* まず単調にならす。«横へ払うだけ» の区間は前後がほとんど動かず、
     わずかに逆へ戻る山もあるので、そのままでは逆に引けない */
  const dir = Math.sign(sweep[b] - sweep[a]) || 1;
  const mono = [];
  let ext = sweep[a];
  for (let f = a; f <= b; f++) {
    if ((sweep[f] - ext) * dir > 0) ext = sweep[f];
    mono.push(ext);
  }
  const last = mono[mono.length - 1];
  if (Math.abs(last - mono[0]) < 1e-4) return null;
  const out = [];
  for (let k = 0; k < n; k++) {
    const target = lerp(mono[0], last, k / (n - 1));
    let f = b;
    for (let i = 0; i < mono.length - 1; i++) {
      const lo = mono[i], hi = mono[i + 1];
      if ((target - lo) * dir >= 0 && (hi - target) * dir >= 0) {
        const span = hi - lo;
        f = a + i + (Math.abs(span) > 1e-6 ? (target - lo) / span : 0);
        break;
      }
    }
    out.push(f);
  }
  return out;
}
