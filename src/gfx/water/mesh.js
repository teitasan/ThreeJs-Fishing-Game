/* ===========================================================
   水面の幾何：カメラ中心の入れ子の正方リング
   -----------------------------------------------------------
   中心 N² セル（一辺 N·s0、s0 = 0.125m）、以降は一辺を 2 倍ずつ。セルは «fine» 段までは 2 倍ずつ、
   その先は 4 倍ずつ（一辺のセル数が nMin を割らない所まで）、残りは 2 倍ずつ。
   なぜ 4 倍：低い視点（桟橋の目の高さ 2.6m）から斜めに見た遠くのリングは、セルが距離に比例するだけだと
   縦の大きさが 1px を割り、2×2 のクワッドの重ね塗り（と三角形の設定）で水面の画素の重さが数倍になっていた
   （G0 のリング：1440p の late で «一色» でも 0.8ms）。縦に 3px 程度を保つには s ∝ d² が要る。
   aEdge = (辺の向き x, z, 外側のリングの頂点の間隔 S)：外縁の頂点は外側の粗いリングの辺の上に落とす
   （両端の頂点の高さを直線補間。比が 2 でも 4 でも T 字の継ぎ目に隙間を作らない）。最小の間隔でカメラへスナップする
   =========================================================== */

/**
 * リングの段の一覧（純関数。Node のテストが読む）
 * @param {number} N 中心の一辺のセル数（8 の倍数）
 * @param {number} s0 中心のセルの一辺 m
 * @param {{ fine?: number, nMin?: number, reach?: number }} [o] fine = 2 倍で育てるリングの数、nMin = 一辺のセル数の下限、reach = 届かせる半幅 m
 * @returns {Array<{ E: number, s: number, n: number }>} E = 半幅 m、s = セル m、n = 一辺のセル数
 */
export function ringPlan(N, s0, { fine = 2, nMin = N / 4, reach = 512 } = {}) {
  const out = [{ E: (N * s0) / 2, s: s0, n: N }];
  for (let k = 1; out[out.length - 1].E < reach && k < 16; k++) {
    const prev = out[out.length - 1];
    const E = prev.E * 2;
    let s = prev.s * 2;
    /* 4 倍：一辺のセル数が nMin 以上で、内側の穴の縁（prev.E）が新しいセルの整数倍のときだけ */
    if (k > fine && (2 * E) / (prev.s * 4) >= nMin && Number.isInteger(prev.E / (prev.s * 4))) s = prev.s * 4;
    out.push({ E, s, n: Math.round((2 * E) / s) });
  }
  return out;
}

/**
 * @param {typeof import('three')} T
 * @param {Array<{ E: number, s: number, n: number }>} plan ringPlan の戻り値
 */
export function buildRings(T, plan) {
  const pos = [], edge = [], idx = [];
  for (let k = 0; k < plan.length; k++) {
    const { E, s, n } = plan[k];
    const S = k + 1 < plan.length ? plan[k + 1].s : 0;          // 外側のリングの頂点の間隔
    const holeE = k ? plan[k - 1].E : 0;
    const base = pos.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = -E + i * s, z = -E + j * s;
        pos.push(x, 0, z);
        const onX = i === 0 || i === n, onZ = j === 0 || j === n;
        /* 外縁で、外側のリングの頂点に当たらない頂点（x 方向の辺は z が動く） */
        if (S > 0 && onX && !onZ && Math.abs(z / S - Math.round(z / S)) > 1e-6) edge.push(0, 1, S);
        else if (S > 0 && onZ && !onX && Math.abs(x / S - Math.round(x / S)) > 1e-6) edge.push(1, 0, S);
        else edge.push(0, 0, 0);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const cx = -E + (i + 0.5) * s, cz = -E + (j + 0.5) * s;
        if (holeE && Math.abs(cx) < holeE && Math.abs(cz) < holeE) continue;
        const a = base + j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        /* 対角線の向きを市松に替える（遠くのリングで斜めの縞を作らない） */
        if ((i + j) & 1) idx.push(a, c, b, b, c, d);
        else idx.push(a, c, d, a, d, b);
      }
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('aEdge', new T.Float32BufferAttribute(edge, 3));
  if (pos.length / 3 > 65535) g.setIndex(new T.Uint32BufferAttribute(idx, 1));
  else g.setIndex(idx);
  g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
  return g;
}
