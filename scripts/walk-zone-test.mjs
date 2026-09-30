/**
 * 歩ける範囲（湖のまわりの帯）の検査。
 *
 * もとは「原点から 460m」で、汀線から 343m・61.3ha を歩けた。飾ってあるのは汀線まわりだけで、
 * 内陸は裸の地面だった。61.3ha を全部飾るより帯に絞るほうが釣りゲームとして正しい。
 *
 * 描画の作り直しで、配置と当たりは src/world/placement.js（シードだけから決まる）に移った。
 * ここでは game.js の歩行・カメラの文字列と、帯の境目の藪の輪・blockedAt(y) の振る舞いを見る。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { loadFacades } from './facade-harness/index.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const game = read('src/game.js');

const F = await loadFacades();
const { THREE, Terrain, WALK_INLAND } = F;
const { WALK_INLAND: W_PLACEMENT, FAR_GATE } = await import('../src/world/placement.js');
const { resolveLake } = await import('../src/lakefield.js');

/* --- 帯そのもの --- */
{
  assert.equal(WALK_INLAND, W_PLACEMENT, 'terrain.js と placement の WALK_INLAND が違う');
  const w = WALK_INLAND;
  assert.ok(w >= 40 && w <= 120, `帯が極端 (${w}m)`);

  // 移動判定は «原点から» ではなく «汀線から» で切ること
  assert.match(game, /this\.terrain\.shoreRadius\(nx, nz\) \+ WALK_INLAND/,
    '移動制限が汀線基準になっていない');
  assert.doesNotMatch(game, /Math\.hypot\(nx, nz\) > 460/, '旧い «原点から 460m» が残っている');
  // 中を見に行けなくなると困るので、デバッグ中は素通りする
  assert.match(game, /!this\.debug\?\.enabled\s*\n\s*&& Math\.hypot\(nx, nz\)/,
    'デバッグ中も帯で止まってしまう');
}

const lake = resolveLake(123456789).lake;
const t = new Terrain(new THREE.Scene(), { quality: 'low', lake, grids: false });
const P = t.placement;
const shoreD = (x, z) => Math.hypot(x, z) - t.shoreRadius(x, z);

/* --- 飾りは «帯 ＋ 見通し» を覆う（歩ける場所なのに地面に何も無い一角を作らない） --- */
{
  const far = (list) => list.reduce((m, o) => Math.max(m, shoreD(o.x, o.z)), -Infinity);
  assert.ok(far(P.cobbles) > WALK_INLAND + 40, `林床の石が帯の外まで無い（${far(P.cobbles).toFixed(0)}m）`);
  assert.ok(far(P.boulders) > WALK_INLAND + 40, `転石が帯の外まで無い（${far(P.boulders).toFixed(0)}m）`);
  let treesBeyond = 0;
  for (let i = 0; i < P.trees.count; i++) if (shoreD(P.trees.x[i], P.trees.z[i]) > WALK_INLAND + 40) treesBeyond++;
  assert.ok(treesBeyond > 1000, `帯の外の森が薄い（${treesBeyond} 本）`);
}

/* --- 境界の見せ方：藪の輪（見えない壁ではなく «茂みで進めない»） --- */
{
  const ring = P.thicket;
  assert.ok(ring.length > 800, `藪の輪が疎ら（${ring.length} 株）`);
  let maxGap = 0;
  const ang = ring.map((b) => Math.atan2(b.z, b.x)).sort((a, b) => a - b);
  for (let i = 0; i < ang.length; i++) {
    const a0 = ang[i], a1 = i + 1 < ang.length ? ang[i + 1] : ang[0] + Math.PI * 2;
    maxGap = Math.max(maxGap, (a1 - a0) * (lake.shoreAtAngle(a0) + WALK_INLAND));
  }
  assert.ok(maxGap < 12, `藪の輪に ${maxGap.toFixed(1)}m の切れ目がある`);
  for (const b of ring) {
    const d = shoreD(b.x, b.z);
    assert.ok(d >= WALK_INLAND - 5 - 1e-6 && d <= WALK_INLAND + 4 + 1e-6, `藪が帯の境から外れている（${d.toFixed(2)}m）`);
    assert.equal(b.r, 0.55, '藪の当たり半径');
    assert.equal(b.collide, 1, '藪に当たり判定が無いと «茂みで止まった» ことにならない');
  }
  // 当たりとして積まれていて、実際に止まる
  const b = ring[Math.floor(ring.length / 3)];
  assert.ok(t.blockedAt(b.x, b.z, 0.34), '藪の上で止まらない');
  assert.ok(t.blockedAt(b.x + 0.7, b.z, 0.34), '藪の縁（0.55 + 0.34 の内側）で止まらない');
}

/* --- 帯の外の木：FAR_GATE の外は当たりを持たない（糸もカメラも届かない） --- */
{
  const T = P.trees;
  let inBand = 0, inBandCollide = 0, farCollide = 0;
  for (let i = 0; i < T.count; i++) {
    const d = shoreD(T.x[i], T.z[i]) - WALK_INLAND;
    if (d < 0) { inBand++; if (T.collide[i]) inBandCollide++; }
    if (T.bandD[i] > FAR_GATE + 1e-3 && T.collide[i]) farCollide++;
  }
  assert.ok(inBand > 500, `帯の中の木が少ない（${inBand}）`);
  assert.equal(inBandCollide, inBand, '帯の中の木はすべて当たりを持つ');
  assert.equal(farCollide, 0, 'FAR_GATE の外の木が当たりを持っている');
}

/* 追従カメラの当たり判定。
   pivot から後ろへ引くだけだと、木を背にして立ったときカメラが幹の «中» へ入る。
   木の当たり判定をそのまま使って止める。 */
{
  assert.match(game, /const clear = this\._camClear\(pivot, want\);/,
    '追従カメラが背後の物を見ていない');
  assert.match(game, /_camClear\(pivot, want\) \{/, '_camClear が無い');
  assert.match(game, /const CAM_RADIUS = /, 'カメラの当たり半径が無い');
  // 足元の藪でカメラが押されないよう、高さを見て弾く
  assert.match(game, /CAM_RADIUS, pivot\.y \+ dy \* t\)/,
    'カメラの当たり判定に高さを渡していない');
  // 歩く判定は高さを見ない（これまでどおり）
  assert.match(game, /this\.terrain\.blockedAt\(nx, nz, PLAYER_RADIUS\)/,
    '歩く判定に高さが混ざっている');

  /* blockedAt(y)：その高さより低い障害物は弾く（藪の上端は h + 0.8·height） */
  const b = P.thicket[7];
  assert.ok(t.blockedAt(b.x, b.z, 0.3, b.top - 0.05), '上端より下の高さで藪を無視している');
  assert.ok(!t.blockedAt(b.x, b.z, 0.3, b.top + 0.05) || t.obstacleTopAt(b.x, b.z) > b.top + 0.05,
    '上端より上の高さなのに藪で止まる');
  assert.ok(t.blockedAt(b.x, b.z, 0.3), '高さを渡さないときは藪で止まる');
}

await t.ready;
console.log('walk-zone-test: ok');
