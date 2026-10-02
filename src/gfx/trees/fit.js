/* ===========================================================
   幹の見た目を当たりに合わせる（純関数。three 無し。Node のテスト trees-collide が同じ関数を使う）
   -----------------------------------------------------------
   契約（CORE_API §10.3）：幹の見た目（胸高 1.3m の半径）× 1.15 = placement の当たりの半径（差 ≤ 5%）。
   当たりは max(trunkR·h·1.15, 0.28)（species.js の TRUNK_R_MIN）なので、細い木（若いモミジ・ヒノキ・低いハンノキなど、
   当たりのある木の 54%）は焼いた幹のままでは見た目が当たりより細い。そこで木ごとに «幹を太らせる倍率» w を決め、
   シェーダが幹（管の level 0）の根元の帯だけを w 倍に太らせる（上へ行くほど 1 + 0.3(w − 1) へ戻る：瓶のように見せない）。
   w は BatchedMesh の行列の使っていない要素（elements[3] = m[0][3]）で渡し、シェーダが読んだら 0 に戻す。
   =========================================================== */

export const BREAST_H = 1.3;            // 胸高 m
export const WIDEN_MAX = 4;             // 太らせる倍率の上限（これを超える木は差が残る。trees.md の要望）
export const WIDEN_BAND = [1.7, 1.5, 0.2];   // 帯：y < 1.7m は w、そこから max(1.5m, 0.2h) で 1 + 0.3(w−1) へ（シェーダと同じ）

/** LOD0 の記録（readLod の戻り値）から幹（level 0 の管）の輪郭 [[y, r], ...]（正規化 = ÷ 樹高） */
export function trunkProfileOf(rec) {
  const t = rec.tubes.find((u) => u.level === 0) || rec.tubes[0];
  if (!t) return [[0, 0.01], [1, 0.001]];
  return t.nodes.map((n) => [n.p[1], n.r]);
}

/** 輪郭の y（正規化）での半径（正規化）。範囲の外は端の値 */
export function radiusAt(profile, yn) {
  if (!profile.length) return 0;
  if (yn <= profile[0][0]) return profile[0][1];
  for (let k = 1; k < profile.length; k++) {
    const [y1, r1] = profile[k];
    if (yn <= y1) {
      const [y0, r0] = profile[k - 1];
      const t = y1 > y0 ? (yn - y0) / (y1 - y0) : 0;
      return r0 + (r1 - r0) * t;
    }
  }
  return profile[profile.length - 1][1];
}

/** シェーダと同じ帯の倍率：高さ y m（根元から）、樹高 h、倍率 w */
export function widenAt(y, h, w) {
  const [a, b, c] = WIDEN_BAND;
  const e = a + Math.max(b, c * h);
  const t = Math.min(1, Math.max(0, (y - a) / (e - a)));
  const s = t * t * (3 - 2 * t);
  return w + (1 + 0.3 * (w - 1) - w) * s;
}

/** 太らせる倍率：当たりの半径 r を見た目の胸高の半径 × 1.15 で割る（1..WIDEN_MAX） */
export function trunkWiden(profile, h, r, pad = 1.15) {
  const rv = radiusAt(profile, BREAST_H / Math.max(h, 0.5)) * h;
  if (!(rv > 0) || !(r > 0)) return 1;
  return Math.min(WIDEN_MAX, Math.max(1, r / (rv * pad)));
}

/** 描いた幹の胸高の半径 m（太らせた後） */
export function visualTrunkR(profile, h, w) {
  return radiusAt(profile, BREAST_H / Math.max(h, 0.5)) * h * widenAt(BREAST_H, h, w);
}
