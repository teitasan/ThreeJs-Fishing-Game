/* ===========================================================
   地形の問い合わせ（three・DOM 無し）
   -----------------------------------------------------------
   旧 terrain.js の heightAt / depthAt / isWater / normalAt / slopeAt /
   shoreRadius / bedAt / structureNear を式の順番ごと移した。
   足・糸・魚のクランプ・底質・ストラクチャーのボーナスがこれを見るので、
   fixture と 1e−9 で一致しなければならない。

   normalAt は {x,y,z} を返す（ファサードが THREE.Vector3 にする）。
   正規化は Vector3.normalize と同じ «1/長さを掛ける» 丸めにしてある。
   =========================================================== */

/**
 * 湖から問い合わせの束を作る。placement の q にも、ファサードの中身にもなる。
 * @param {object} lake lakefield.makeLake / resolveLake の lake
 */
export function makeQueries(lake) {
  const heightAt = (x, z) => lake.heightAt(x, z);
  const q = {
    lake,
    heightAt,
    shoreRadius: (x, z) => lake.shoreRadius(x, z),
    depthAt: (x, z) => Math.max(0, -heightAt(x, z)),
    isWater: (x, z) => heightAt(x, z) < 0,
    normalAt(x, z, e = 0.7) {
      const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
      const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
      return normalize3(hL - hR, 2 * e, hD - hU);
    },
    slopeAt(x, z, e = 1.2) {
      const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
      const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
      const dx = (hR - hL) / (2 * e), dz = (hU - hD) / (2 * e);
      return Math.sqrt(dx * dx + dz * dz);
    },
    /** 底質（'mud' | 'sand' | 'rock'）と連続値 v */
    bedAt: (x, z) => lake.bedAt(x, z),
    structures: buildStructures(lake),
    structureNear(x, z, radius = 4.5) {
      return structureNear(q.structures, x, z, radius);
    },
  };
  return q;
}

/** THREE.Vector3(x,y,z).normalize() と同じ丸め */
export function normalize3(x, y, z) {
  const len = Math.sqrt(x * x + y * y + z * z);
  const s = 1 / (len || 1);
  return { x: x * s, y: y * s, z: z * s };
}

/**
 * ゲームが見るストラクチャーの一覧（旧 _buildProps の this.structures と同じ形）。
 * top は湖底 + h（lakefield が水面より 0.5m 以上下に収めている）。
 */
export function buildStructures(lake) {
  const out = [];
  for (const t of lake.structures) {
    const bedY = lake.heightAt(t.x, t.z);
    out.push({ x: t.x, z: t.z, kind: t.kind, r: t.r, top: bedY + t.h, depth: t.depth });
  }
  return out;
}

/** 一番近いストラクチャー（半径の外なら null） */
export function structureNear(list, x, z, radius = 4.5) {
  let best = null, bd = radius * radius;
  for (const t of list || []) {
    const d = (t.x - x) ** 2 + (t.z - z) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
