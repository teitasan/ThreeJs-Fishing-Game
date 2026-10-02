/* ===========================================================
   水面の幾何：カメラ中心の入れ子の正方リング
   -----------------------------------------------------------
   中心 N² セル（一辺 32m、N = 128 なら 0.25m）、以降 N² − (N/2)² セルを 2 倍ずつ rings 段（±16·2^rings m）。
   aEdge = (隣への半歩 x, z, 1)：外縁の奇数番目の頂点は外側の粗いリングの辺の中点に当たるので、
   両隣の平均の高さに落とす（T 字の継ぎ目に隙間を作らない）。最小の間隔でカメラへスナップする
   （縦の変位は低周波の 5 本だけで、法線は断片の解析の勾配なので、粗いリングの «泳ぎ» は見えない）
   =========================================================== */

/**
 * @param {typeof import('three')} T
 * @param {number} N 中心の一辺のセル数（偶数）
 * @param {number} s0 中心のセルの一辺 m
 * @param {number} rings 粗いリングの数
 */
export function buildRings(T, N, s0, rings) {
  const pos = [], edge = [], idx = [];
  for (let k = 0; k <= rings; k++) {
    const s = s0 * (1 << k), h = N / 2, hole = k ? N / 2 : 0, base = pos.length / 3;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        pos.push((i - h) * s, 0, (j - h) * s);
        const onX = i === 0 || i === N, onZ = j === 0 || j === N;
        if (k < rings && onX && !onZ && (j & 1)) edge.push(0, s, 1);
        else if (k < rings && onZ && !onX && (i & 1)) edge.push(s, 0, 1);
        else edge.push(0, 0, 0);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (hole && Math.abs(i - h + 0.5) < hole / 2 && Math.abs(j - h + 0.5) < hole / 2) continue;
        const a = base + j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
        /* 対角線の向きを市松に替える（遠くのリングで斜めの縞を作らない） */
        if ((i + j) & 1) idx.push(a, c, b, b, c, d);
        else idx.push(a, c, d, a, d, b);
      }
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('aEdge', new T.Float32BufferAttribute(edge, 3));
  g.setIndex(idx);
  g.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
  return g;
}
