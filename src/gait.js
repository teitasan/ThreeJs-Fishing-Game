/* ===========================================================
   足取り（歩き／走り）の目盛り

   ゲームは釣り人へ «moving» をひとつだけ渡すが、そこには二つの別の話が
   混ざっている。

     1. どちらの足取りか … 歩きなら 0.6・走りなら 1.0（game.js の moveAmt）
     2. 動いているか      … 止まっていれば 0・歩いていても走っていても 1

   1 をそのまま 2 として使うと、歩いている間ずっと «4 割は立っている»
   ことになる。実際そうなっていて、脚が «歩き 0.6 + 釣りの構え 0.4» の
   混ざりになり、さらに «竿を正面へ向けるための体の回転»（faceRod）が
   0.4 ぶん残って、正面へ進みながら 28 度斜めを向いていた。

   数字だけの変換なので three.js を使わない。検査から直に呼べるようにして
   ある（scripts/gait-test.mjs）。
   =========================================================== */

/** 歩きの足取り。これより上は走りへ寄っていく */
export const GAIT_WALK = 0.6;

/** ゲーム側の移動速度（m/s）。足取りの目盛りはこの割り当てに合わせてある */
export const WALK_SPEED = 3.1;
export const RUN_SPEED = 6.2;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 足取り → 動いている度合い 0..1。歩き（0.6）で 1 になる。
 * クリップの重みと «立っているか» の判定はこちらを使う。
 */
export const moveAmountOf = (gait) => clamp01(clamp01(gait) / GAIT_WALK);

/**
 * 速さ（m/s）→ 足取り。歩く速さで 0.6・走る速さで 1.0 になる。
 * 他プレイヤーは moveAmt を送ってこないので、見えている速さから作り直す。
 */
export function gaitOfSpeed(speed) {
  if (!(speed > 0)) return 0;
  if (speed <= WALK_SPEED) return (speed / WALK_SPEED) * GAIT_WALK;
  return GAIT_WALK + clamp01((speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED)) * (1 - GAIT_WALK);
}

/** 足取り → 速さ（m/s）。速さを渡してこない古い連携のための概算 */
export function speedOfGait(gait) {
  const g = clamp01(gait);
  return g <= GAIT_WALK
    ? (g / GAIT_WALK) * WALK_SPEED
    : WALK_SPEED + ((g - GAIT_WALK) / (1 - GAIT_WALK)) * (RUN_SPEED - WALK_SPEED);
}
