/* ===========================================================
   描画レイヤー（ARCHITECTURE §3.3）
   -----------------------------------------------------------
   three はカメラの layers で物体とライトを間引く。パスごとのマスクを
   ここだけで決め、各モジュールはレイヤー番号しか知らない。
   - ng の物体は layer 0 を外して自分の層へ（userData.ngOwned = true）
   - ゲームの物体は layer 0 のまま（raycast に影響させない）
   =========================================================== */

/** @enum {number} */
export const NG_LAYER = Object.freeze({
  DEFAULT: 0, WORLD: 1, NO_REFLECT: 2, UNDERWATER: 3, WATER: 4, LATE_FX: 5, LATE: 6, FAR: 7, SHADOW_ONLY: 8,
});

/**
 * 影の更新だけを起こすための空レイヤー。どの物体も置かない。
 * ライトは enableAll なので、この層だけを見るカメラで render すると
 * «何も描かずに影マップだけ更新» になる（pipeline.prepare）
 */
export const NG_LAYER_SHADOW_TICK = 31;

const mask = (...ls) => ls.reduce((m, l) => m | (1 << l), 0);

/** パスごとの camera.layers.mask */
export const NG_MASK = Object.freeze({
  OPAQUE: mask(0, 1, 2, 3, 7),
  REFLECTION: mask(0, 1, 7),
  LATE: mask(4, 5, 6),
  SHADOW: mask(0, 1, 7, 8),
  PROBE: mask(7),
  SHADOW_TICK: mask(NG_LAYER_SHADOW_TICK),
});

/**
 * obj とその子孫を ng の層に置く（layer 0 を外す）
 * @param {import('three').Object3D} obj
 * @param {number} layer NG_LAYER の値
 * @returns {import('three').Object3D} obj
 */
export function ngOwn(obj, layer) {
  obj.traverse((o) => {
    o.layers.set(layer);
    o.userData.ngOwned = true;
  });
  return obj;
}
