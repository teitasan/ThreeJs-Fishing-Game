/* ===========================================================
   ためる量 → キャストのクリップのフレーム

   ここだけ独立しているのは、three.js を使わない純粋な計算で、
   単体テスト（scripts/cast-origin-test.mjs）から直接呼べるようにするため。
   =========================================================== */

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 「ためる量 0..1」→「クリップのフレーム」の対応表を作る。
 *
 * progress はフレームごとの «振りの進み具合»（単調に増える／減る量。いまは竿が
 * 振れた累積の角度）。ためる範囲を等間隔に送ると、この進み具合がためる量に
 * 比例しない。Mixamo のキャストは前半で竿を立てたまま向きだけ回し、後半で一気に
 * 倒すので、実測ではフレーム 0→12 で竿の振れが 26 度、12→33 で 131 度だった。
 * メーターの前半で竿が «ほとんど動かない» ように見えるので、ここで progress を
 * 逆に引いて、振れがためる量に比例する表にする。
 *
 * @param {number[]} progress フレームごとの振りの進み具合（単調に近いこと）
 * @param {number} f0 ためる範囲の始まり（フレーム）
 * @param {number} f1 ためる範囲の終わり（フレーム）
 * @param {number} n 表の刻み数
 * @returns {number[]|null} 長さ n のフレーム列。作れなければ null（呼び出し側は等間隔に戻す）
 */
export function chargeFrameTable(progress, f0, f1, n = 33) {
  if (!Array.isArray(progress) || progress.length < 3) return null;
  const a = Math.max(0, Math.round(f0));
  const b = Math.min(progress.length - 1, Math.round(f1));
  if (b - a < 2) return null;
  /* まず単調にならす。ほとんど動かない区間や、わずかに逆へ戻る山があると
     そのままでは逆に引けない */
  const dir = Math.sign(progress[b] - progress[a]) || 1;
  const mono = [];
  let ext = progress[a];
  for (let f = a; f <= b; f++) {
    if ((progress[f] - ext) * dir > 0) ext = progress[f];
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
