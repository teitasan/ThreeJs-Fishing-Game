/* ===========================================================
   釣り人・ロッド・ライン・ウキ
   =========================================================== */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp, clamp01, lerp, damp, TAU, lineSagProfile } from './util.js?v=20260830-zone5';
import { moveAmountOf, speedOfGait } from './gait.js?v=20260909-castsync';
import { chargeFrameTable } from './castCharge.js';
import { createBaitMesh, disposeBaitMesh, updateBaitMesh, createHookMesh, HOOK } from './baitMesh.js';
import { t } from './i18n.js';

const _v = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _v8 = new THREE.Vector3();
const _v9 = new THREE.Vector3();
const _v10 = new THREE.Vector3();
const _v11 = new THREE.Vector3();
const _v12 = new THREE.Vector3();
const _v13 = new THREE.Vector3();   // リールを巻く手のクランク円運動（_poseUpper 専用）
const _v14 = new THREE.Vector3();
const _v15 = new THREE.Vector3();
const _rodP = new THREE.Vector3();   // 竿の置き場所（root ローカル・_poseUpper 専用）
const _rodQt = new THREE.Quaternion();   // 竿の向き（同上）
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _q4 = new THREE.Quaternion();   // 竿を地面から起こす回転（_keepRodOffGround 専用）
const _euler = new THREE.Euler();
const _axis = new THREE.Vector3();   // しなりの回転軸（_applyBend 専用）
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/* ===========================================================
   外部アセット（すべて CC0 / Quaternius）
   釣り人 : Ultimate Modular Men Pack の "Casual"（62 ボーン・24 アニメーション）
   ロッド : Fishing Rod Lvl1〜5 をゲームの竿 5 種に対応させている
   =========================================================== */
/* 釣り人は Mixamo の Mannequin。釣りモーション 4 本を同梱してある
   （scripts/mannequin-build.py が Blender で組む）。
   キャラもモーションも mixamorig なのでリターゲットは要らない。

   ひとつ前の素体（Quaternius の低ポリ）と、そこへ移したクリップは
   assets/models/player-lowpoly.glb / assets/motions/*.json に残してある。
   scripts/mixamo-retarget.mjs も «Mixamo 以外の骨格へ移したくなったとき» の
   ために残してあるが、本体からはもう使わない */
const ANGLER_URL = './assets/models/mannequin.glb';
/** GLB に同梱されているクリップの名前 */
const CLIP = {
  fishIdle: 'FishingIdle',
  fishCast: 'FishingCast',
  walk: 'MixamoWalk',
  run: 'MixamoRun',
};
/** クリップを測るときの刻み（Mixamo はどれも 30fps） */
const MOTION_FPS = 30;
/* Mixamo のモーションで動かす状態。ファイトと取り込みは今までの手続き生成の
   ままにする。竿先を魚へ向ける必要があり（_aimPitch）、それに当たる Mixamo の
   クリップが無いので、置き換えると «引かれても竿が反応しない» ことになる */
/* 腕と竿をクリップに任せる状態。Mixamo のキャストはここでしか使わない。

   釣りの «構え» は Mixamo の Fishing Idle が竿をほぼ垂直（仰角 78 度・竿先が
   地上 3.4m）に立てて持っていて、水面へ差し出す構えとは合わない。狙いの角度も
   竿先から出る糸も要るので、構え・アタリ待ち・ファイトは手続き生成で作る。
   キャストの «振り» はクリップの見せ場なので、そこは丸ごとクリップに渡す
   （振り抜きのあいだも＝ castAnim 中も含める） */
const MOTION_STATES = new Set(['charge']);
/* クリップが書いた姿勢を控えておくボーン。腕と首はこのあと上書きするので、
   Mixamo が乗っているぶんを混ぜ戻すのに «元» が要る。
   名前は mixamorig を外した短い形（this.bones の索引がこれ） */
const MOTION_KEEP = [
  'RightArm', 'RightForeArm', 'RightHand',
  'LeftArm', 'LeftForeArm', 'LeftHand',
  'Head',
];
/** 竿を握る手 / 添える手 */
const GRIP_SIDE = 'Right';
const GRIP_HAND = `${GRIP_SIDE}Hand`;
/* 握っている筒の軸を測るための指。親指は筒の反対側へ回るので使わない */
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
const ROD_URLS = {
  bamboo: './assets/models/rod-bamboo.glb',
  glass:  './assets/models/rod-glass.glb',
  carbon: './assets/models/rod-carbon.glb',
  master: './assets/models/rod-master.glb',
  legend: './assets/models/rod-legend.glb',
};

/* 竿の性格を決める素の値（根本→先端の 6 節）。
   長さは作り直し前と同じで、しなりは先端ほどよく曲がる */
const ROD_SEG_BASE = [0.42, 0.40, 0.36, 0.34, 0.32, 0.28];
const ROD_FLEX_BASE = [0.22, 0.40, 0.70, 1.15, 1.70, 2.40];

/* 1 節をいくつに割るか。
   メッシュはスキンで竿に追従するが、重みが節の下端で 100% その関節・上端で
   100% ひとつ上の関節と振ってあるので、節の中間はふたつの結果の平均になり、
   両端の関節を結ぶ弦より外側へ膨らむ。ずれは
     0.25 × 節の長さ × 2sin(関節の角度 / 2)
   で、関節では 0・中間で最大。これが節ごとに繰り返されて波打って見えていた
   （6 節のとき、しなり 0.89 で先端側の節が 4.9cm 膨らんでいた）。
   節を割ると長さも関節の角度も同時に小さくなるので、ずれは割った数の
   2 乗で小さくなる。3 分割なら 1/9。
   総和は変わらないので、竿の長さもしなりの効き方も同じ */
const ROD_SUBDIV = 3;
const subdivide = (arr) => arr.flatMap((v) => Array(ROD_SUBDIV).fill(v / ROD_SUBDIV));

/** 関節の相対しなり（根本→先端）。先端ほどよく曲がる */
const ROD_FLEX = subdivide(ROD_FLEX_BASE);
const ROD_FLEX_SUM = ROD_FLEX.reduce((a, b) => a + b, 0);
/* 最大しなり角。以前は半円（180 度）だったが、それだと竿先が糸を通り越して
   曲がり切ってしまい、構えをどれだけ倒しても竿先を糸へ向けられない
   （実測：張力 0.9 で 170 度曲がり、ピッチを限界まで倒しても 53 度折れていた）。
   竿先が糸を向ける範囲に収めてある。109 度でも竿は充分深く曲がるし、
   張力の読み取りは 0〜109 度の振れ幅で残る */
const ROD_BEND_MAX = 1.9;

/* しなりの関節。合計は素の値と同じなので、竿先までの距離＝糸の出どころは変わらない */
const ROD_SEG_LEN = subdivide(ROD_SEG_BASE);
const ROD_BLANK_Y0 = 0.14;   // 最初の関節（グリップの上）の高さ
const ROD_TIP_Y = ROD_BLANK_Y0 + ROD_SEG_LEN.reduce((a, b) => a + b, 0);
const ROD_BUTT_Y = -0.17;    // グリップ尻。アセットはここに合わせて拡大・移動する
const BODY_PIVOT_Y = 1.00;   // 前傾の軸（腰の高さ。Mannequin の実測 0.998m）

/* ===========================================================
   モーションの調整値
   すべてここに集約してある。motion-editor.html がこのオブジェクトを
   直接いじってリアルタイムに反映し、localStorage に保存する。
   ゲーム側は読み込み時にそれを取り込む（別タブで編集すると即反映される）
   =========================================================== */
export const TUNING = {
  /* 姿勢ごとの「竿のピッチ（垂直から前へ倒す角。rad）」と
     「右手の位置（右肩からのオフセット m。root ローカルで +X 左・+Y 上・+Z 前）」、
     「前傾（rad）」。ピッチは自作モデル時代の「腕 + ロッドの合計角」を
     引き継いでいるので、狙いと着水の関係は変わらない */
  pose: {
    idle:   { pitch: 0.45, hand: [0.04, -0.34, 0.15], lean: 0 },
    charge: { pitch: -0.95, hand: [0.08, -0.16, -0.18], lean: -0.12 },
    wait:   { pitch: 1.00, hand: [0.03, -0.25, 0.24], lean: 0 },
    /* ファイトの pitch は、糸の先が分からないとき（モーションエディター）だけの
       控えの値。ゲーム中は竿先が魚を向くように幾何で決まる（_aimPitch）。
       lean は「張力ゼロのときの前傾」で、アタリ待ちと同じ＝掛かっても跳ねない */
    fight:  { pitch: 1.00, hand: [0.05, -0.20, 0.20], lean: 0 },
    landed: { pitch: 0.10, hand: [0.06, -0.14, 0.18], lean: 0 },
  },
  /* ファイト中の前傾。竿の角度のほうは数値で持たず、竿先が魚を向くように
     幾何で決まる（_aimPitch）。テンションが上がるほど、巻いているほど前へ入る */
  fight: { leanByTension: 0.30, leanByReelLay: 0.10 },
  /* ファイト中に竿が取れるピッチの範囲（垂直から前へ倒した角・rad）。
     角度そのものは「竿先が魚を向く」ように幾何で決まるので、ここは行き止まりだけ。
     min を下げると魚が近い時に竿が後ろへ倒れ、max を上げると真下の魚に竿先を
     突っ込めるようになる */
  fightAim: { min: -0.25, max: 1.75 },
  /* 一人称は視界に穂先を残したいので、アタリ待ちをさらに寝かせる。
     ファイトは幾何で決まるので視点による違いを持たない */
  fpv: { waitPitch: 1.20 },
  /* キャストの振り抜き。dur 秒かけて charge の姿勢から endPitch まで振る */
  cast: { dur: 0.34, endPitch: 0.60, leanFrom: -0.12, leanTo: 0.10, damp: 26 },
  /* 腕。pole は肘を張り出す向き（root ローカル）。これがないと肘が裏返る。
     gripY / leftY は竿のどこを右手・左手が握るか（竿のローカル高さ m） */
  arm: { poleR: [-0.5, -0.7, -0.5], poleL: [0.5, -0.8, -0.3], gripY: 0.06, leftY: -0.13 },
  /* 体。tilt は前傾を腰から上へ流す割合、head は狙いの方を向く強さ */
  body: { tilt: 0.55, headLook: 0.40, headLookMax: 0.45, headLean: 0.55 },
  /* 歩きと走り。
     Mixamo のクリップを «その場» で回すと、接地している足はちょうど地面の
     速さで後ろへ流れる。その «足が滑らない速さ» を骨格ごと実測して
     クリップに焼いてあるので（歩き 1.57 m/s / 走り 2.69 m/s）、再生倍率は
        ゲームの速さ ÷ そのクリップの足が滑らない速さ × rate
     で決まる。rate 1 なら足はまったく滑らない。
     ゲームは歩き 3.1 / 走り 6.2 m/s あるので rate 1 でどちらも約 2 倍で回る
     （ゲームの «歩き» はもう小走りの速さなので、これで釣り合う）。
     速すぎると感じたら rate を下げる。そのぶん足は滑る。
     runFrom / runTo は歩き → 走りの乗り換え（moveAmt。ゲームは歩きで 0.6・
     走りで 1.0 を渡す） */
  walk: { rate: 1.0, maxRate: 2.6, runFrom: 0.62, runTo: 0.95 },
  /* 指の曲げ（第 1〜3 関節 / 親指）。開いた手のままだと竿を握って見えない */
  fingers: { curl: [-1.05, -0.85, -0.55], thumb: [-0.55, -0.45] },
  /* 姿勢が切り替わるときの追従の速さ（大きいほど速い） */
  damp: { pitch: 9, hand: 9, lean: 8 },
  /* リール。巻いている間だけハンドルを handleSpeed（rad/s）で回し、
     ローターはギア比を掛けた速さで連動する。spinUp は回りだし／止まりの鈍さ
     （大きいほどキビキビ）。handleSpeed を負にすると逆回転になる。
     handMoveSpeed は左手が竿の握り位置とノブのあいだを行き来する速さ
     （spinUp より大きくして、機構の回り出しより先に手が追いつくようにしてある） */
  reel: { handleSpeed: 6.0, gearRatio: 5.2, spinUp: 9, handMoveSpeed: 18 },
  /* Mixamo から移したモーション。竿は右手のボーンへ剛体で付ける。

     使いどころを分けてある（MOTION_STATES）。

       キャストの振り … 竿ごとクリップに預ける。竿を立てて構え、体の横へ倒し、
                        下から振り抜く大きな動きがこのクリップの見せ場。
       それ以外       … 手続き生成。Fishing Idle は竿をほぼ垂直（仰角 78 度・
                        竿先が地上 3.4m）に立てて持っていて、水面へ差し出す
                        構えとは合わない。狙いの角度も竿先から出る糸も要る。

     竿がどこに付くかは «拳が握っている筒» を指の骨から実測して決める
     （rodaxis-probe.html で目で確かめられる）。以前ここを «右手首 → 左手首»
     の線で推測していたが、両手は竿の上に縦に並んでおらず 10cm 横へずれて
     添えられているので、その線は握り軸から 63 度ずれた別物だった。

       blend : 手続き生成との行き来の速さ（大きいほど速い）
       rodFloor : 竿先を地面から離しておく高さ（m）。Mixamo のキャストは
               もっと短い竿で描かれていて、2.43m の竿をそのまま付けると
               振り下ろしの底で竿先が足元より 0.6m 下＝桟橋を突き抜ける
       castBlend : ために入るときだけの速さ。メーターは 1.9 秒で往復するので、
               通常の blend（乗り切るまで 0.33 秒）だと最初の 3 割ほど竿が
               付いてこず、狙いを決める動きと連動していないように見える
       cast  : Fishing Cast のどこを使うか（フレーム）。振りかぶりは
               charge0〜charge1 を «ためる量» でスクラブし、離したら swing まで
               dur 秒かけて流す。

               charge1 は «竿先が地面すれすれまで下がるところ»（33）。ここから
               先は地面ガードが効きっぱなしになるので、ためる側では使わない。
               swing は «振り抜きが終わるところ»（63）。以前は 112 まで送って
               いたが、63〜112 は竿先が 0.3〜5m/s でほとんど動かない «戻り» で、
               それを dur に詰め込んでいたため 5.3 倍速になり «妙に早い»
               見え方になっていた。63 までなら 30 コマ＝1.0 秒ぶんで、
               dur 0.55 なら 1.8 倍速。
               release は «糸が離れるフレーム»（60）。竿先の前方への速さが
               ここで最大になる（実測 18.3m/s。総速度の最大は 59 の 26.9m/s）。
               ゲームはここまでウキの発射を待つ（playCast の castLead） */
  motion: {
    blend: 9, castBlend: 22, rodFloor: 0.2,
    cast: { charge0: 9, charge1: 33, swing: 63, release: 60, dur: 0.55 },
  },
};

/** 待ちと同じ姿勢を使う状態（アタリ前後は構えを変えない） */
/** smoothstep（3t²-2t³）の逆関数。0..1 → 0..1 */
const invSmoothstep = (x) => 0.5 - Math.sin(Math.asin(clamp(1 - 2 * clamp01(x), -1, 1)) / 3);

const POSE_ALIAS = { flight: 'wait', nibble: 'wait', bite: 'wait' };
const poseOf = (st) => TUNING.pose[POSE_ALIAS[st] || st] || TUNING.pose.idle;

/* ===========================================================
   リールの部品（GLB のノード名 → 回し方）
   ブランクと違って曲げず、原点（＝Blender で合わせた回転軸）まわりに回す。
   spin   : 回す軸。null は回らない部品（本体）
   orbitOf: 指定すると、その部品にぶら下がって公転だけする

   軸はモデルを 3 軸それぞれの方向から見て確かめた（スピニングリールの実物と同じ）。
     handle … 竿と直交する横向き（X）。X から見ると腕が 1 本の棒に見える
     rotor  … 竿と平行（Y）。Y から見たときだけ八角形＝円い断面になる。
              Z から見るとベール腕が 2 本立った横姿で、こちらは軸ではない
   ノブは公転を打ち消すだけなので、必ずハンドルと同じ軸にする
   =========================================================== */
const REEL_PARTS = {
  reel:     { spin: null },                     // 本体。回らないが竿と一緒に動く
  handle:   { spin: 'x' },                      // ハンドル（クランク）
  rotor:    { spin: 'y' },                      // ローター（糸を巻き取る回転部）
  ReelKnob: { spin: 'x', orbitOf: 'handle' },   // ノブ（取手）。公転だけする
};
/** その GLB がリールを別パーツで持っているか */
const hasReel = (src) => {
  let found = false;
  src.scene.traverse((n) => { if (n.isMesh && REEL_PARTS[n.name]) found = true; });
  return found;
};

const lerpArr = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * 張力 → 竿の効き 0..1。しなりの量と構えの角度で必ず同じ曲線を使う。
 * ここが食い違うと、竿が立つ速さと曲がる速さがずれて
 * 「先に立ってから遅れて曲がる」ちぐはぐな動きになる。
 * 低い張力から大きく効く（＝弱い引きでも竿が仕事をして見える）ための平方根
 */
const loadCurve = (t) => Math.sqrt(clamp01(t));

/** 既定値（エディターの「初期値に戻す」用） */
export const TUNING_DEFAULT = JSON.parse(JSON.stringify(TUNING));

/* 保存先。ファイトのピッチは意味の変わった値があるので（巻くと立てる→倒す、
   ファイトの基準角＝アタリ待ちと同じ）、古い保存がそのまま効くと直りが
   見えなくなる。キーに版を付けて、古いものは読まずに新しい既定値から始める */
const TUNING_KEY = 'lakeside.motion.v2';

/** 保存された調整値を取り込む（数値と配列だけを上書きする浅い再帰マージ） */
function mergeTuning(src, dst = TUNING) {
  if (!src || typeof src !== 'object') return;
  for (const k of Object.keys(dst)) {
    if (!(k in src)) continue;
    const a = dst[k], b = src[k];
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < a.length; i++) if (typeof b[i] === 'number') a[i] = b[i];
    } else if (typeof a === 'number' && typeof b === 'number') {
      dst[k] = b;
    } else if (a && typeof a === 'object' && b && typeof b === 'object') {
      mergeTuning(b, a);
    }
  }
}

/** localStorage から読み直す。エディターで保存すると別タブのゲームにも効く */
export function loadTuning() {
  try {
    const raw = localStorage.getItem(TUNING_KEY);
    if (raw) mergeTuning(JSON.parse(raw));
  } catch (e) { /* 壊れていたら既定値のまま */ }
}
export function saveTuning() {
  try { localStorage.setItem(TUNING_KEY, JSON.stringify(TUNING)); } catch (e) { /* noop */ }
}
export function resetTuning() {
  mergeTuning(TUNING_DEFAULT);
}
loadTuning();
if (typeof window !== 'undefined') {
  // 別タブ（エディター）で保存されたら取り込む＝ゲームを開いたまま調整できる
  window.addEventListener('storage', (e) => { if (e.key === TUNING_KEY) loadTuning(); });
}

/* ---------------- 画面上で一定の太さに見えるライン ---------------- */
class LineRibbon {
  constructor(scene, segments = 30) {
    this.segments = segments;
    const n = segments + 1;
    const pos = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xeaf4ff, transparent: true, opacity: 0.62,
      side: THREE.DoubleSide, depthWrite: false, fog: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** points: Vector3[] / count: 実際に使う点数（省略時は全部） */
  update(points, camera, count) {
    const arr = this.mesh.geometry.attributes.position.array;
    const n = Math.min(count ?? points.length, points.length);
    if (n < 2) { this.mesh.visible = false; return; }
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const nx = points[Math.min(i + 1, n - 1)];
      const pv = points[Math.max(i - 1, 0)];
      _v.subVectors(nx, pv);
      if (_v.lengthSq() < 1e-10) _v.set(0, 1, 0);
      _v2.subVectors(camera.position, p);
      const dist = _v2.length();
      _v2.multiplyScalar(1 / Math.max(0.001, dist));
      _v3.crossVectors(_v, _v2);
      if (_v3.lengthSq() < 1e-10) _v3.set(1, 0, 0);
      _v3.normalize().multiplyScalar(clamp(dist * 0.000433, 0.002, 0.0167));
      const o = i * 6;
      arr[o] = p.x + _v3.x; arr[o + 1] = p.y + _v3.y; arr[o + 2] = p.z + _v3.z;
      arr[o + 3] = p.x - _v3.x; arr[o + 4] = p.y - _v3.y; arr[o + 5] = p.z - _v3.z;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (n - 1) * 6);
  }
}

export class Angler {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);

    this.yaw = 0;
    this.pitch = 0;
    this.walkPhase = 0;
    this.bend = 0;       // 0..1（1 で半円）
    this._bendAz = 0;    // しなる向き（rodMount 局所・水平面内の方位角）
    this._nibbleT = 0;    // ピクピク（ナブル）の経過時間
    this._biteT = 0;      // アタリ本番の経過時間（0 未満＝未突入）
    this._prevSt = null;  // 前フレームの状態（'nibble'/'bite' への切り替わり検出用）
    this._lineEnd = new THREE.Vector3();
    this._hasLineEnd = false;
    this.castAnim = -1;  // >=0 でキャストモーション中
    this.castLead = 0;   // 糸が離れるまでの時間（playCast が入れる）
    this.rodPitch = TUNING.pose.idle.pitch;   // 竿のピッチ（垂直から前へ倒した角。ワールド基準）
    this.motionW = 0;    // Mixamo のモーションの乗り（0 = 今までの手続き生成だけ）
    this._castW = 0;     // Fishing Idle ↔ Fishing Cast の混ぜ具合
    this._movePhase = 0;  // 歩き／走りの位相（0..1）。両方をこれで揃える
    this.moveRate = 0;    // いまの歩き／走りの再生倍率（1 で等倍＝足が滑らない）
    this.moveShownSpeed = 0;   // 脚が描いている速さ（m/s）
    this._motion = null; // 読み込んだモーション（竿の軸・握りの重み）
    this._clipQ = {};    // クリップが書いた姿勢の控え
    /* 竿の付き方（RightHand ローカル）。どちらも指の骨から読み込み時に測る。
       クリップが手を動かしているとき、竿はこの点・この向きで付く
         _gripLocal : 握る点（指の付け根の中心）
         _rodQ      : 竿の +Y を «拳が握っている筒の軸» へ向ける回転 */
    this._gripLocal = new THREE.Vector3(0, 0.118, 0);
    this._rodQ = new THREE.Quaternion();
    this.bodyLean = 0;
    this.fpv = false;
    this._bodyVisible = true;   // setBodyVisible(false) で体ごと消せる
    this.ready = false;  // glTF を読み終わるまで false
    this.bones = {};
    this.rodMeshes = [];   // ブランク（しなるスキンメッシュ）だけ
    this._rodParts = [];   // 竿を替えるときに片付ける対象（ブランク + リール）
    // GLB に REEL_PARTS のノードがあれば、巻いている間だけ回す
    this.reelHandle = null;
    this.reelRotor = null;
    this.reelKnob = null;
    this._reelSpin = 0;    // リールの回転の乗り（0=止まっている 1=最高速）
    this._reelHandBlend = 0;   // 左手を竿の握り→ノブへ寄せる度合い（0..1、_reelSpin より速く追従させる）
    this._handOff = TUNING.pose.idle.hand.slice();
    this._rodId = null;

    /* ロッドは釣り人のボーンの子にはせず root に直付けし、毎フレーム
       「手の位置」と「設計どおりのピッチ」で置く。手のボーンの子にすると
       リグの癖がそのまま竿の角度に乗り、狙いの計算まで動いてしまう */
    this.rodMount = new THREE.Object3D();
    this.root.add(this.rodMount);
    /* しなりのボーン列を載せる台。しなる向きは各関節の回転軸で作るので、
       ここは回さない（回すとガイドやリールまで軸まわりに回ってしまう） */
    this.rodFlexRoot = new THREE.Object3D();
    this.rodMount.add(this.rodFlexRoot);
    this._buildRodBones();
    this._segBase = this.rodSegs.map(() => 0);

    this.line = new LineRibbon(scene, 26);
    this._linePts = [];
    for (let i = 0; i < 27; i++) this._linePts.push(new THREE.Vector3());
    this._buildBobber();
  }

  /**
   * モデルを読み込む（game.build から await される）。
   * 釣り人とロッドは CC0 の外部アセット（Quaternius）で、glTF なので非同期。
   * 読み終わるまで ready=false のまま＝姿勢の計算をまるごと飛ばす
   */
  async load(onProgress) {
    const loader = new GLTFLoader();
    if (onProgress) await onProgress(t('ui.loadingAngler'));
    const body = await loader.loadAsync(ANGLER_URL);
    this._setupBody(body);
    this._setupMotions(body);
    if (onProgress) await onProgress(t('ui.loadingRods'));
    this._rodSrc = {};
    for (const [id, url] of Object.entries(ROD_URLS)) {
      this._rodSrc[id] = await loader.loadAsync(url);
    }
    this.setRod('bamboo');
    this.ready = true;
  }

  /* ---------------- 釣り人 ---------------- */
  /* 新キャラは各可動部が別オブジェクト（ボーンではなく実メッシュ）で、
     関節の一つ上のパーツの原点＝関節位置になるように作ってある。
     子は局所 -Y に伸びる（Blender の -Z 下向きが glTF 変換で -Y になる）ので、
     以前のボーンリグ（子が局所 +Y）と符号が逆になる点に注意 */
  _setupBody(gltf) {
    const model = gltf.scene;
    /* 骨は mixamorig:RightHand のような名前で来る。GLTFLoader が名前から «:» を
       落とすことがあるので接頭辞を正規表現で外し、短い名前（RightHand）で引く */
    model.traverse((o) => {
      const m = /^mixamorig\d*[:._-]?(.+)$/i.exec(o.name || '');
      if (m) this.bones[m[1]] = o;
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false;   // スキンで動くので元の AABB が当てにならない
    });
    if (!this.bones[GRIP_HAND]) {
      throw new Error(`${ANGLER_URL}: mixamorig の骨が見つからない`);
    }
    /* 前傾は mixer が触らない包みのグループで作る。
       AnimationMixer は「値が前フレームと変わらなければ書き戻さない」ので、
       アニメーション対象のボーンに角度を足すと戻されず毎フレーム積み上がる
       （実際に体が折れ曲がった）。腰の高さを軸にしたいので位置をずらしてある */
    this.tilt = new THREE.Group();
    this.tilt.position.y = BODY_PIVOT_Y;
    this.root.add(this.tilt);
    model.position.y = -BODY_PIVOT_Y;
    this.tilt.add(model);
    this.model = model;
    model.visible = this._bodyVisible;   // 読み込み前に消してあっても効くように

    this.mixer = new THREE.AnimationMixer(model);
    /* 首の静止姿勢。AnimationMixer は「値が前フレームと変わらなければ
       書き戻さない」ので、ボーンに角度を足すと戻されず積み上がる。
       首はここを基準に毎フレーム決め打ちで入れる（足さない） */
    this._restQ = {};
    for (const n of ['Head']) {
      if (this.bones[n]) this._restQ[n] = this.bones[n].quaternion.clone();
    }

    /* 腕のリンク長を実測しておく（逆運動学で使う）。glTF の Armature ノードは
       スケール 0.01（骨格が cm）なので、ワールド距離で取ればメートルになる */
    model.updateMatrixWorld(true);
    const wp = (n) => this.bones[n].getWorldPosition(new THREE.Vector3());
    this.armLen = {};
    for (const s of ['Left', 'Right']) {
      const u = wp(`${s}Arm`), l = wp(`${s}ForeArm`), w = wp(`${s}Hand`);
      this.armLen[s] = { upper: u.distanceTo(l), fore: l.distanceTo(w) };
    }
  }

  /**
   * 骨盤の «上» が局所のどの軸か（0=x, 1=y, 2=z）。
   * 水平の移動だけ抜きたいので、上以外の 2 成分を止める
   */
  _hipsUpAxis() {
    const hips = this.bones.Hips;
    if (!hips || !hips.parent) return 1;
    hips.parent.updateWorldMatrix(true, false);
    _v1.set(0, 1, 0).applyQuaternion(hips.parent.getWorldQuaternion(_q).invert());
    let best = 0;
    for (let i = 1; i < 3; i++) {
      if (Math.abs(_v1.getComponent(i)) > Math.abs(_v1.getComponent(best))) best = i;
    }
    return best;
  }

  /**
   * 同梱のモーションを使えるようにする。
   *
   * 旧素体のときは «Mixamo → 低ポリの剛体リグ» のリターゲットが要ったが、
   * Mannequin は Mixamo と同じ骨格なのでクリップをそのまま再生できる。
   * かわりに、リターゲット時にオフラインで焼いていた次の値を読み込み時に測る。
   *   grip   : 拳が握っている点と筒の軸（指の骨から実測）。竿をここへ付ける
   *   arc    : キャストの各フレームまでに竿が振れた «累積の角度»。ためる量に
   *            振りの進み方を比例させるのに使う
   *   stride : «足が滑らない速さ» と 1 周の尺。歩き／走りの再生倍率に使う
   *
   * 測れなくてもゲームは動く（手続き生成のまま）ので、落とさない
   */
  _setupMotions(gltf) {
    try {
      const byName = new Map((gltf.animations || []).map((c) => [c.name, c]));
      const missing = Object.values(CLIP).filter((n) => !byName.has(n));
      if (missing.length) throw new Error('クリップが無い: ' + missing.join(', '));

      /* その場で回す。歩きと走りは実際に前進するクリップ（Mixamo 実測で
         歩き 1.89 / 走り 3.3m ぶん進む）だが、位置はゲームが動かすので
         水平の移動だけ抜く。上下の揺れは残す。

         どの成分が «高さ» かは決め打ちできない。glTF は Y-up への変換を
         Armature ノードの回転として持つことがあり、その場合ボーンの局所軸は
         Blender の Z-up のままになる（この GLB は骨盤の静止値が
         [x, 前後, -高さ] ＝ 上が index 2）。親のワールド回転に問い合わせて
         «ワールドの上» がどの局所軸かを調べる。

         抜き方は «最初のキーの値で埋める»。0 にすると骨盤の前後の下駄（3cm）
         まで消えて、体が少し後ろへずれる */
      const upIdx = this._hipsUpAxis();
      const inPlace = (clip) => {
        const c = clip.clone();
        for (const tr of c.tracks) {
          if (!/Hips\.position$/.test(tr.name) || tr.values.length < 3) continue;
          const keep0 = [tr.values[0], tr.values[1], tr.values[2]];
          for (let i = 0; i < tr.values.length; i += 3) {
            for (let k = 0; k < 3; k++) if (k !== upIdx) tr.values[i + k] = keep0[k];
          }
        }
        return c;
      };
      const clip = {};
      for (const [id, name] of Object.entries(CLIP)) clip[id] = inPlace(byName.get(name));

      /* --- 測る --- */
      const frames = (c) => Math.max(2, Math.round(c.duration * MOTION_FPS) + 1);
      const sample = (c, n, fn) => {
        const mx = new THREE.AnimationMixer(this.model);
        const a = mx.clipAction(c);
        a.play();
        const out = [];
        for (let i = 0; i < n; i++) {
          mx.setTime((i / (n - 1)) * c.duration);
          this.model.updateMatrixWorld(true);
          out.push(fn(i));
        }
        a.stop();
        mx.uncacheClip(c);
        return out;
      };
      const hand = this.bones[GRIP_HAND];
      const _hp = new THREE.Vector3();
      const _hq = new THREE.Quaternion(), _mq = new THREE.Quaternion();

      /* --- 拳が握っている «筒» を測る ---
         拳を握ると、4 本の指の «付け根と第 2 関節の中点» はその筒の上に並ぶ。
         その中心が握り点、その並びが筒の軸。左右の拳で軸が 5.7 度しか違わない
         ＝両手は本当に 1 本を握っている（rodaxis-probe.html で目で見られる）。

         握り点は «竿をどこに付けるか»、軸は «竿がどちらを向くか» にそのまま使う
         （キャストの振りのあいだだけ。それ以外は手続き側が構えの角度で置く） */
      const fistOf = (side) => {
        const pts = FINGERS.map((f) => {
          const a = this.bones[`${side}Hand${f}1`];
          const b = this.bones[`${side}Hand${f}3`];
          if (!a || !b) return null;
          return a.getWorldPosition(new THREE.Vector3())
            .add(b.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
        });
        if (pts.some((v) => !v)) return null;
        const center = pts.reduce((a, v) => a.add(v), new THREE.Vector3())
          .multiplyScalar(1 / pts.length);
        // 人差し指側が竿先のほう（親指が上に来る握り）
        return { center, dir: pts[0].clone().sub(pts[FINGERS.length - 1]).normalize() };
      };
      const fists = sample(clip.fishIdle, 30, () => {
        const f = fistOf(GRIP_SIDE);
        if (!f) return null;
        hand.getWorldQuaternion(_hq).invert();
        return {
          grip: f.center.sub(hand.getWorldPosition(_hp)).applyQuaternion(_hq).clone(),
          axis: f.dir.applyQuaternion(_hq).clone(),
        };
      });
      let axis;
      if (fists[0]) {
        const mean = (k) => fists.reduce((a, f) => a.add(f[k]), new THREE.Vector3())
          .multiplyScalar(1 / fists.length);
        this._gripLocal.copy(mean('grip'));
        axis = mean('axis').normalize();
      } else {
        // 指の骨が無いリグ。握り点は既定のまま、軸は手の +Y（子の向き）で代用
        axis = new THREE.Vector3(0, 1, 0);
      }
      this._rodQ.setFromUnitVectors(_up, axis);

      /** 竿の向き（モデル空間。+Z が正面・+Y が上） */
      const rodDir = () => _v2.copy(axis)
        .applyQuaternion(hand.getWorldQuaternion(_hq))
        .applyQuaternion(this.model.getWorldQuaternion(_mq).invert())
        .normalize();
      /* 竿が振れた累積の角度。ためる量にこれを比例させると、振りが等速に見える。
         «前後の傾き» で計ると、竿を立てたまま横へ回している前半（実測で
         フレーム 0〜12）が «動いていない» ことになってしまう */
      let acc = 0;
      const prev = new THREE.Vector3();
      const arc = sample(clip.fishCast, frames(clip.fishCast), (i) => {
        const d = rodDir();
        if (i > 0) acc += prev.angleTo(d);
        prev.copy(d);
        return acc;
      });

      /* «足が滑らない速さ»。その場で回すと接地している足はちょうど地面の速さで
         後ろへ流れる。接地は «低いほう» の足で見分け、走りには両足が浮く瞬間が
         あるので中央値で弾く */
      const ankle = { L: this.bones.LeftFoot, R: this.bones.RightFoot };
      const strideOf = (c) => {
        const n = frames(c);
        const pos = sample(c, n, () => ({
          L: ankle.L.getWorldPosition(new THREE.Vector3()),
          R: ankle.R.getWorldPosition(new THREE.Vector3()),
        }));
        const dt = c.duration / (n - 1);
        const sp = [];
        for (let i = 1; i < n; i++) {
          for (const [a, b] of [['L', 'R'], ['R', 'L']]) {
            if (pos[i - 1][a].y <= pos[i - 1][b].y && pos[i][a].y <= pos[i][b].y) {
              sp.push(Math.hypot(pos[i][a].x - pos[i - 1][a].x, pos[i][a].z - pos[i - 1][a].z) / dt);
            }
          }
        }
        sp.sort((x, y) => x - y);
        return { speed: sp.length ? sp[sp.length >> 1] : 1, cycle: c.duration };
      };

      this._motion = {
        fps: MOTION_FPS,
        arc,
        stride: { walk: strideOf(clip.walk), run: strideOf(clip.run) },
      };

      /* --- 再生の口 --- */
      const act = (c) => this.mixer.clipAction(c);
      this.actFishIdle = act(clip.fishIdle);
      this.actFishCast = act(clip.fishCast);
      this.actMoveWalk = act(clip.walk);
      this.actMoveRun = act(clip.run);
      for (const a of [this.actFishIdle, this.actFishCast, this.actMoveWalk, this.actMoveRun]) {
        a.play();
        a.setEffectiveWeight(0);
      }
      /* 振りの «どこを見せるか» と、歩き／走りの位相はこちらで決めるので、
         時間は進めさせない。歩きと走りは 1 周の尺が違うので、それぞれの倍率で
         勝手に回すと混ぜている間に脚の位相がずれて足が震える */
      this.actFishCast.paused = true;
      this.actMoveWalk.paused = true;
      this.actMoveRun.paused = true;
      this._moveDur = { walk: clip.walk.duration, run: clip.run.duration };
      for (const n of MOTION_KEEP) this._clipQ[n] = new THREE.Quaternion();
      this.model.updateMatrixWorld(true);
      const deg = (v) => (v * 180 / Math.PI).toFixed(0);
      console.info(
        `釣りモーション: 握り点 手首から ${(this._gripLocal.length() * 100).toFixed(1)}cm / `
        + `振りの累積角 ${(arc[arc.length - 1] * 180 / Math.PI).toFixed(0)}度 / `
        + `足が滑らない速さ 歩き ${this._motion.stride.walk.speed.toFixed(2)} ・ `
        + `走り ${this._motion.stride.run.speed.toFixed(2)} m/s`
      );
    } catch (e) {
      console.warn('釣りモーションを使えなかったので手続き生成のままにする', e);
      this._motion = null;
    }
  }

  /**
   * 歩きと走り。位相をひとつだけ持って両方のクリップに同じところを見せる。
   *
   * それぞれを自分の再生倍率で回すと、1 周の尺が違うぶん（歩き 1.07 秒 /
   * 走り 0.73 秒）混ぜている間に脚の位相がずれて、足が地面で震える。
   * 位相を共通にすれば、乗り換えの途中でも «同じ歩調の歩きと走り» を
   * 混ぜることになるので破綻しない。
   *
   * 進み方は «1 周で進む距離» から出す。クリップごとに実測してある
   * 足が滑らない速さ × 1 周の尺 がそれで、これでゲームの速さを割れば
   * 1 秒あたりの周回数になる。つまり rate 1 のとき足はまったく滑らない。
   *
   * @param {number} weight 歩き＋走りに割り当てる重み（動いている度合い 0..1）
   * @param {number} gait   足取り（歩きで 0.6・走りで 1.0）。歩きと走りのどちらを
   *                        見せるかを決めるだけで、重みには使わない
   * @param {number} speed  実際の地面の速さ（m/s）。ゲームが渡してくる
   */
  _poseMove(dt, weight, gait, speed) {
    const W = TUNING.walk;
    const S = this._motion.stride;
    const runW = clamp01((gait - W.runFrom) / Math.max(1e-3, W.runTo - W.runFrom));
    // 速さを渡してこない呼び出し元（古い連携）には足取りから概算させる
    const spd = Number.isFinite(speed) ? speed : speedOfGait(gait);
    const cycle = lerp(S.walk.cycle, S.run.cycle, runW);
    const perCycle = lerp(S.walk.speed * S.walk.cycle, S.run.speed * S.run.cycle, runW);
    // 再生倍率（1 で等倍）。上げすぎると脚が回りすぎて見えるので頭打ちにする
    const mult = Math.min(W.maxRate, (spd * W.rate) / Math.max(0.01, perCycle) * cycle);
    this.moveRate = mult;
    /* 脚が実際に «描いている» 速さ。ゲームの速さとの比がそのまま足の滑りになる */
    this.moveShownSpeed = perCycle * mult / Math.max(0.01, cycle);
    if (weight > 1e-3) {
      this._movePhase = (this._movePhase + dt * mult / Math.max(0.01, cycle)) % 1;
    }
    this.actMoveWalk.time = this._movePhase * this._moveDur.walk;
    this.actMoveRun.time = this._movePhase * this._moveDur.run;
    this.actMoveWalk.setEffectiveWeight(weight * (1 - runW));
    this.actMoveRun.setEffectiveWeight(weight * runW);
  }

  /** Fishing Cast のどのフレームを見せるか（振りかぶり → 振り抜き） */
  _castFrame(st, p) {
    const C = TUNING.motion.cast;
    if (this.castAnim >= 0) {
      const e = clamp01(this.castAnim / Math.max(0.05, C.dur));
      return lerp(C.charge1, C.swing, e * e * (3 - 2 * e));
    }
    if (st === 'charge') return this._chargeFrame(clamp01(p.charge || 0));
    /* 振り終わったら振り抜きの最後で止めておく。ここでため始めへ戻すと、
       アタリ待ちへの混ざりが抜け切る前に竿が跳ねる（振り抜き 112 と
       ため始め 10 では竿先が 73cm ずれていて、しかもその瞬間はまだ
       キャストのクリップに重みが乗り切っている） */
    return C.swing;
  }

  /**
   * ためる量 0..1 → Fishing Cast のフレーム。
   *
   * ためる範囲を等間隔に送ってはいけない。Mixamo のキャストは前半で竿を立てた
   * まま向きだけ回し、後半で一気に倒すので、フレームを等間隔に送るとメーターの
   * 前半で竿が «ほとんど動かない» ように見える（実測：フレーム 0→12 で竿の
   * 振れは 26 度、12→33 で 131 度）。
   *
   * クリップの «累積の振れ角»（_motion.arc）を逆に引いて、竿の振れがためる量に
   * 比例するフレームを返す
   */
  _chargeFrame(charge) {
    const C = TUNING.motion.cast;
    const tbl = this._chargeTable(C.charge0, C.charge1);
    if (!tbl) return lerp(C.charge0, C.charge1, charge);
    const x = clamp01(charge) * (tbl.length - 1);
    const i = Math.min(tbl.length - 2, Math.floor(x));
    return lerp(tbl[i], tbl[i + 1], x - i);
  }

  /** 上の逆引きの表。ためる範囲が変わったときだけ作り直す（エディターで動かせる） */
  _chargeTable(f0, f1) {
    const arc = this._motion && this._motion.arc;
    if (!arc) return null;
    const key = `${f0}:${f1}`;
    if (this._chargeKey !== key) {
      this._chargeKey = key;
      this._chargeCache = chargeFrameTable(arc, f0, f1);
    }
    return this._chargeCache;
  }


  /* ---------------- ロッド ---------------- */
  /**
   * しなり用のボーン列。アセットのロッドは 1 枚の固いメッシュなので、
   * この列に沿って重みを振って曲げる（作り直し前と同じ 6 関節・同じ長さ）
   */
  _buildRodBones() {
    let parent = this.rodFlexRoot;
    this.rodSegs = [];
    for (let i = 0; i < ROD_SEG_LEN.length; i++) {
      const b = new THREE.Bone();
      b.position.y = i === 0 ? ROD_BLANK_Y0 : ROD_SEG_LEN[i - 1];
      parent.add(b);
      parent = b;
      this.rodSegs.push(b);
    }
    this.rodTip = new THREE.Object3D();
    this.rodTip.position.y = ROD_SEG_LEN[ROD_SEG_LEN.length - 1];
    parent.add(this.rodTip);
    // ボーンの世界行列が確定してから骨格を作る（bind の基準になる）
    this.rodMount.updateMatrixWorld(true);
    this.rodSkeleton = new THREE.Skeleton(this.rodSegs);
    // 関節の高さ（重み付けに使う）
    this._segY = [];
    let y = ROD_BLANK_Y0;
    for (let i = 0; i < ROD_SEG_LEN.length; i++) { this._segY.push(y); y += ROD_SEG_LEN[i]; }
    this._segY.push(y);   // 穂先
  }

  /** ロッドの種類を切り替える（竿を買うと見た目も変わる） */
  setRod(id) {
    if (!this._rodSrc || this._rodId === id) return;
    const src = this._rodSrc[id] || this._rodSrc.bamboo;
    if (!src) return;
    this._rodId = id;

    // 前の竿を片付ける。ジオメトリもマテリアルもここで複製したものなので捨てる
    for (const part of this._rodParts) {
      part.removeFromParent();
      part.traverse((n) => {
        if (!n.isMesh) return;
        n.geometry.dispose();
        n.material.dispose();
      });
    }
    this._rodParts = [];
    this.rodMeshes = [];
    this.reelHandle = null;
    this.reelRotor = null;
    this.reelKnob = null;
    this._reelSpin = 0;

    this._buildBlank(src);
    /* リールを別パーツで持っているのは今のところ竹竿の GLB だけなので、
       入っていない竿は竹竿のリールを借りる。自前のリールが入れば
       そちらが自動で使われる（この分岐に触らなくてよい） */
    this._buildReel(hasReel(src) ? src : this._rodSrc.bamboo);
  }

  /**
   * モデルの寸法はまちまち（全長 6〜8m のものもある）なので、
   * 上端＝穂先・下端＝グリップ尻がボーン列の両端に来る倍率と下駄を出す
   */
  _rodFit(src) {
    src.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(src.scene);
    const s = (ROD_TIP_Y - ROD_BUTT_Y) / Math.max(1e-3, box.max.y - box.min.y);
    return { s, o: ROD_TIP_Y - box.max.y * s };
  }

  /** GLB のノードから、竿ローカル座標に載せ替えたジオメトリを作る */
  _rodGeo(node, s, o) {
    const geo = node.geometry.clone();
    geo.applyMatrix4(node.matrixWorld);   // ノードのスケール（×100）・位置を焼き込む
    geo.scale(s, s, s);
    geo.translate(0, o, 0);
    return geo;
  }

  /** しなるブランク（竿本体）。高さで重みを振ってボーン列に沿って曲げる */
  _buildBlank(src) {
    const { s, o } = this._rodFit(src);
    src.scene.traverse((n) => {
      if (!n.isMesh || REEL_PARTS[n.name]) return;
      const geo = this._rodGeo(n, s, o);
      this._weightRod(geo);
      const mat = n.material.clone();
      /* glTF の既定は metalness=1。このシーンには環境マップが無く、
         金属は反射する先が無くて黒く沈むので、他のパーツに合わせて落とす */
      mat.metalness = 0;
      mat.roughness = Math.max(0.55, mat.roughness);
      const mesh = new THREE.SkinnedMesh(geo, mat);
      mesh.castShadow = true;
      mesh.frustumCulled = false;   // スキンで動くので元の AABB が当てにならない
      this.rodMount.add(mesh);
      mesh.updateMatrixWorld(true);
      mesh.bind(this.rodSkeleton);
      this.rodMeshes.push(mesh);
      this._rodParts.push(mesh);
    });
  }

  /**
   * リール。曲がらない固まりなので、スキンではなく根元のボーンにぶら下げる。
   *
   * ここがスキンメッシュだと絶対に回らない。three.js の SkinnedMesh は既定の
   * bindMode='attached' だと updateMatrixWorld のたびに
   * bindMatrixInverse = matrixWorld⁻¹ を作り直すため、頂点の行き先が
   *   matrixWorld × matrixWorld⁻¹ × ボーン行列 × bindMatrix
   * になり、自分のワールド行列がきれいに打ち消される。つまり包んだグループを
   * いくら回しても見た目が 1 ミリも変わらない（＝リールが回らなかった原因）。
   * 素の Mesh にすれば、ふつうに親の回転が効く。
   *
   * ぶら下げ先の rodSegs[0] は、グリップの頂点が 100% 乗っているボーンでもある
   * ので、竿の傾き・しなり・しなる向きにリールが一体でついてくる
   */
  _buildReel(src) {
    if (!src) return;
    const nodes = {};
    src.scene.updateMatrixWorld(true);
    src.scene.traverse((n) => { if (n.isMesh && REEL_PARTS[n.name]) nodes[n.name] = n; });
    if (!Object.keys(nodes).length) return;

    const { s, o } = this._rodFit(src);
    // 根元ボーンの中を竿ローカル座標に戻す入れ物。中身はそのままの座標で置ける
    const root = new THREE.Group();
    root.position.y = -ROD_BLANK_Y0;
    this.rodSegs[0].add(root);
    this._rodParts.push(root);

    /* 回転軸＝ノードの原点（Blender 側で合わせてある）。
       部品ごとに「軸を原点に置き直したメッシュ」を包むグループを作る。
       そうしないと竿の原点を中心に振り回ってしまう */
    const groups = {};
    const pivots = {};
    for (const name of Object.keys(REEL_PARTS)) {
      const n = nodes[name];
      if (!n) continue;
      const pivot = n.getWorldPosition(new THREE.Vector3()).multiplyScalar(s);
      pivot.y += o;
      const geo = this._rodGeo(n, s, o);
      geo.translate(-pivot.x, -pivot.y, -pivot.z);

      const mat = n.material.clone();
      /* 環境マップが無いので金属度を上げるとリールが真っ黒になる。
         わずかに残して、太陽のハイライトだけ金属らしく光らせる */
      mat.metalness = Math.min(mat.metalness, 0.15);
      mat.roughness = clamp(mat.roughness, 0.30, 0.60);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;

      const g = new THREE.Group();
      g.position.copy(pivot);
      g.add(mesh);
      groups[name] = g;
      pivots[name] = pivot;
    }

    // 公転させたい部品は、親ができてから相対位置に置き直してぶら下げる
    for (const [name, g] of Object.entries(groups)) {
      const parent = REEL_PARTS[name].orbitOf;
      if (parent && groups[parent]) {
        g.position.sub(pivots[parent]);
        groups[parent].add(g);
      } else {
        root.add(g);
      }
    }

    this.reelHandle = groups.handle || null;
    this.reelRotor = groups.rotor || null;
    this.reelKnob = groups.ReelKnob || null;
  }

  /**
   * 高さから skinIndex / skinWeight を作る。
   * 関節 i と i+1 のあいだの頂点は 2 つのボーンで線形に混ぜるので、
   * 曲げても折れ目が出ずに滑らかにしなる
   */
  _weightRod(geo) {
    const pos = geo.attributes.position;
    const n = pos.count;
    const idx = new Uint16Array(n * 4);
    const wgt = new Float32Array(n * 4);
    const Y = this._segY;
    const last = this.rodSegs.length - 1;
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      let a = 0, t = 0;
      if (y <= Y[0]) { a = 0; t = 0; }                 // グリップより下は根元と一緒に動く
      else if (y >= Y[last + 1]) { a = last; t = 0; }
      else {
        while (a < last && y > Y[a + 1]) a++;
        t = (y - Y[a]) / Math.max(1e-6, Y[a + 1] - Y[a]);
      }
      const b = Math.min(a + 1, last);
      idx[i * 4] = a; idx[i * 4 + 1] = b;
      wgt[i * 4] = 1 - t; wgt[i * 4 + 1] = t;
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(wgt, 4));
  }

  _buildBobber() {
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xe2452f, roughness: 0.55 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf7f7f2, roughness: 0.6 });
    const R = 0.1;
    const top = new THREE.Mesh(new THREE.SphereGeometry(R, 14, 9, 0, TAU, 0, Math.PI / 2), red);
    const bot = new THREE.Mesh(new THREE.SphereGeometry(R, 14, 9, 0, TAU, Math.PI / 2, Math.PI / 2), white);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.007, 0.34, 5), red);
    stem.position.y = 0.22;
    const tipBall = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), white);
    tipBall.position.y = 0.4;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.018, 0.004, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x9a9aa2, metalness: 0.6, roughness: 0.4 })
    );
    ring.position.y = -R - 0.01;
    ring.rotation.x = Math.PI / 2;
    g.add(top, bot, stem, tipBall, ring);
    g.visible = false;
    this.bobber = g;
    this.scene.add(g);

    // 水面のリング（遠くでもウキの位置が分かるように）
    const ringGeo = new THREE.RingGeometry(0.30, 0.40, 28);
    ringGeo.rotateX(-Math.PI / 2);
    this.bobberRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xd8f0ff, transparent: true, opacity: 0.4, depthWrite: false, fog: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.bobberRing.visible = false;
    this.bobberRing.renderOrder = 6;
    this.scene.add(this.bobberRing);

    // 仕掛け（オモリ・ハリ・エサ）
    // 座標系：原点＝道糸の付け根（ハリのチモト）、局所 -Y＝軸方向（水底側）
    const rig = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x8b8b93, metalness: 0.7, roughness: 0.35 });
    // オモリはハリ軸に沿った小さな涙滴。大きすぎると糸が「重心」に刺さって見える
    const sinker = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 8, 6), metal);
    sinker.scale.set(0.85, 1.45, 0.85);
    sinker.position.y = HOOK.shankTop * 0.55;
    // チモトの環（糸がここに着く見た目）
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.0036, 0.00105, 4, 8), metal);
    eye.position.y = 0.0005;
    eye.rotation.x = Math.PI / 2;
    // ハリ：軸＋ふところ＋針先（エサと同じ座標系で作る）
    const hookG = createHookMesh(metal);
    // エサ（種別に差し替え）。ハリと同じ原点なので、エサ側が刺さる位置を持つ
    const baitRoot = new THREE.Group();
    this.baitRoot = baitRoot;
    this.baitMesh = null;
    this.baitId = null;
    this._baitTime = 0;
    rig.add(sinker, eye, hookG, baitRoot);
    rig.visible = false;
    this.rig = rig;
    this.scene.add(rig);
    this.setBait('worm');

    this.lineLower = new LineRibbon(this.scene, 6);
    this._lowerPts = [];
    for (let i = 0; i < 7; i++) this._lowerPts.push(new THREE.Vector3());
  }

  /** 装備中のエサメッシュを差し替える */
  setBait(id) {
    const next = id || 'worm';
    if (this.baitId === next && this.baitMesh) return;
    if (this.baitMesh) {
      this.baitRoot.remove(this.baitMesh);
      disposeBaitMesh(this.baitMesh);
      this.baitMesh = null;
    }
    this.baitMesh = createBaitMesh(next);
    this.baitRoot.add(this.baitMesh);
    this.baitId = next;
  }

  /** ウキ → 仕掛け（水中）の糸と、仕掛けの表示。水中カメラの時だけ見せる */
  updateRig(bobberPos, baitPos, camera, show, dt = 0.016) {
    this.rig.visible = show;
    this.lineLower.mesh.visible = show;
    if (!show) return;
    // 糸の先＝チモト（原点）。ハリ軸（局所 -Y）が糸の延長になるよう向ける
    this.rig.position.copy(baitPos);
    _v.subVectors(bobberPos, baitPos);
    if (_v.lengthSq() > 1e-8) {
      _v.normalize();
      this.rig.quaternion.setFromUnitVectors(_up, _v);
    }
    this._baitTime += dt;
    this._animateBait(this._baitTime);
    const pts = this._lowerPts;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // ウキ→チモトを直線。横ブレを入れると針軸とずれた「重心へ刺さる」見た目になる
      pts[i].lerpVectors(bobberPos, baitPos, t);
    }
    this.lineLower.update(pts, camera);
  }

  /** 種別ごとの弱いうねり・揺れ（関節ごとの動きは baitMesh 側が持つ） */
  _animateBait(t) {
    updateBaitMesh(this.baitMesh, t);
  }

  /* ---------------- 更新 ---------------- */
  setYaw(y) { this.yaw = y; }

  /** 一人称：頭・首・胴を画面から消す（腕とロッドは残す）。影はそのまま落ちる */
  setFirstPerson(on) {
    this.fpv = on;
    /* 旧素体は頭・胴を «部位ごとの別メッシュ» として消していたが、Mixamo の
       キャラは全身が 1 枚のスキンメッシュなので部位単位では消せない。
       頭の骨を潰すだけでは、カメラが体の内側に入って «裏面から向こうが
       透けて見える» ことになる（面は片側だけ描くので）。体ごと消す。
       竿・糸・ウキは別のオブジェクトなので残る */
    if (this.model) {
      this.model.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) o.visible = !on;
      });
    }
  }

  /**
   * 釣り人の体を丸ごと出す／消す（影ごと。竿・リール・糸・ウキは残る）。
   * 消してもボーンは動き続けるので、竿は今までどおり手の位置に置かれる。
   * つまり見た目だけが消えて、狙いや着水の計算は何も変わらない。
   * モーションエディターは体を見ながら姿勢を詰めるので、ここは呼ばない
   */
  setBodyVisible(on) {
    this._bodyVisible = on;
    if (this.model) this.model.visible = on;
  }

  /**
   * キャストの振りを始める。
   *
   * castLead は «糸が離れるまでの時間»（秒）。ゲームはこれだけウキの発射を
   * 遅らせる。ボタンを離した瞬間にウキが飛ぶと、まだ振りかぶっている絵の
   * うしろでウキだけが飛んでいくことになり «振りと連動していない» 見え方に
   * なる。振り抜きは charge1 → swing を smoothstep で送るので、糸が離れる
   * フレーム（release）に着く «時間» は smoothstep の逆関数で出す。
   *
   * 手続き生成の振り（一人称など）は昔から離した瞬間に飛ばしているので、
   * クリップに乗っているぶん（motionW）だけ待たせる。
   */
  playCast() {
    this.castAnim = 0;
    const C = TUNING.motion.cast;
    const dur = Math.max(0.05, lerp(TUNING.cast.dur, C.dur, this.motionW));
    const span = C.swing - C.charge1;
    const x = span > 1e-3 ? clamp01((C.release - C.charge1) / span) : 1;
    this.castLead = invSmoothstep(x) * dur * clamp01(this.motionW);
  }

  /**
   * @param {object} p
   *  state: 'idle'|'charge'|'flight'|'wait'|'nibble'|'bite'|'fight'|'landed'
   *  charge: 0..1  tension: 0..1  moving: 0..1  dt
   *  reeling: 0..1  どれだけ巻けているか（ゲームは F.spin をそのまま渡す）。
   *           true/false でも受けるが、段差になるので実際の乗りを渡すのが望ましい
   *  rarity?: 0..5  掛かっている（掛かりかけの）魚のレア度。ナブル・アタリの
   *           震え・引き込みの強さに使う（無指定は 0 扱い）
   *  lineEnd?: Vector3  糸の先（ウキ／魚の口）。しなり方向の目標
   */
  update(dt, p) {
    const st = p.state;
    // 外部の一時 Vector3 を参照し続けない（毎フレームコピー）
    if (p.lineEnd) {
      this._lineEnd.copy(p.lineEnd);
      this._hasLineEnd = true;
    } else {
      this._hasLineEnd = false;
    }
    this.root.rotation.y = this.yaw;
    /* 足取り（歩き 0.6 / 走り 1.0）と «動いている度合い»（歩きで 1）は別物。
       混ぜると歩きが立ちに薄まる（GAIT_WALK の説明） */
    const gait = clamp01(p.moving);
    // 足音は walkPhase を見ているので、読み込み前でも進めておく
    this.walkPhase += dt * (4 + gait * 6) * (gait > 0.02 ? 1 : 0);
    if (!this.ready) return;

    /* 歩きと待機はアセットのアニメーションを重みで混ぜる。
       脚と体幹はこれに任せ、腕だけこのあと上書きする */
    const mv = moveAmountOf(gait);
    const stand = 1 - mv;
    /* クリップの重みは «立っているか歩いているか» だけで決まる。立っていれば
       釣りの構え（ため中はキャスト）、歩いていれば歩き／走り。

       motionW は別の話で、«腕と竿をクリップに任せるか、手続き生成で作るか» の
       度合い。ファイトと取り込みは竿先を魚へ向ける必要があって当たるクリップが
       無いので手続き生成に落とす。歩いている間も、竿を持った腕はクリップの
       腕振りではなく竿を握らせたいので落とす。
       一人称も落とす。Mixamo の構えは竿が立っていて（垂直から 32 度）、
       一人称のために寝かせてある fpv.waitPitch（69 度）と食い違い、穂先が
       視界の上へ抜けてしまう */
    const useMotion = this._motion && !this.fpv
      && (MOTION_STATES.has(st) || this.castAnim >= 0);
    const motionT = (useMotion ? 1 : 0) * stand;
    this.motionW = damp(this.motionW, motionT, TUNING.motion.blend, dt);
    const w = this.motionW;
    if (this._motion) {
      const castT = (st === 'charge' || this.castAnim >= 0) ? 1 : 0;
      /* ために入るときだけ速く乗せる。抜けるほうは急ぐ理由がない */
      const cb = castT > this._castW ? TUNING.motion.castBlend : TUNING.motion.blend;
      this._castW = damp(this._castW, castT, cb, dt);
      this.actFishIdle.setEffectiveWeight(stand * (1 - this._castW));
      this.actFishCast.setEffectiveWeight(stand * this._castW);
      this.actFishCast.time = this._castFrame(st, p) / this._motion.fps;
      this._poseMove(dt, mv, gait, p.speed);
    }
    this.mixer.update(dt);

    /* 竿のピッチと手の位置。ピッチは作り直し前の「腕 + ロッドの合計角」を
       そのまま引き継いでいるので、狙いと着水の関係は変わらない */
    const T = TUNING;
    /* 「どれだけ巻けているか」0..1。ゲームは F.spin（リールの立ち上がり）を
       そのまま渡してくる。真偽値だと押した瞬間に 0→1 の段差になり、
       竿だけが跳ね上がってから曲がる、という動きになる */
    const reel = p.reeling === true ? 1 : clamp01(p.reeling || 0);
    const pose = poseOf(st);
    let pitchT = pose.pitch;
    let handT = pose.hand;
    let leanT = pose.lean;
    if (st === 'charge') {
      pitchT = lerp(T.pose.idle.pitch, T.pose.charge.pitch, p.charge);
      handT = lerpArr(T.pose.idle.hand, T.pose.charge.hand, p.charge);
      leanT = T.pose.charge.lean * p.charge;
    } else if (st === 'fight') {
      // 前傾は張力と巻きで決める。竿の角度は一人称の分岐のあとでまとめて決める
      const F = T.fight;
      const load = loadCurve(p.tension);
      leanT = T.pose.fight.lean + load * (F.leanByTension + reel * F.leanByReelLay);
    }
    /* 一人称は視界に穂先を残したいので、待ちとファイトをさらに寝かせる
       （構え・キャストは三人称と同じ＝飛距離の計算が視点で変わらないように） */
    if (this.fpv && ['wait', 'flight', 'nibble', 'bite', 'fight'].includes(st)) {
      pitchT = T.fpv.waitPitch;
    }
    /* ファイト中は「竿先が糸の先を向く角度」へ、張力が乗ったぶんだけ寄せる。
       張力ゼロならアタリ待ちの構えのままなので、掛かった瞬間に竿は動かない */
    if (st === 'fight') pitchT = this._aimPitch(pitchT, loadCurve(p.tension));

    // キャストのスイング（振りかぶり → 振り抜き）
    if (this.castAnim >= 0) {
      this.castAnim += dt;
      /* Mixamo の振りは手続きの振り（0.34 秒）より長い。乗っているぶんだけ
         尺を伸ばして、振り抜きが途中で切れないようにする。
         浮きはこの前に投げ終わっているので、尺を変えても飛距離は変わらない */
      const dur = Math.max(0.05, lerp(T.cast.dur, T.motion.cast.dur, this.motionW));
      const t = this.castAnim / dur;
      if (t >= 1) {
        this.castAnim = -1;
      } else {
        const e = t * t * (3 - 2 * t);
        pitchT = lerp(T.pose.charge.pitch, T.cast.endPitch, e);
        handT = lerpArr(T.pose.charge.hand, T.pose.wait.hand, e);
        leanT = lerp(T.cast.leanFrom, T.cast.leanTo, e);
        const cd = T.cast.damp;
        this.rodPitch = damp(this.rodPitch, pitchT, cd, dt);
        this._handOff[0] = damp(this._handOff[0], handT[0], cd, dt);
        this._handOff[1] = damp(this._handOff[1], handT[1], cd, dt);
        this._handOff[2] = damp(this._handOff[2], handT[2], cd, dt);
        this.bodyLean = damp(this.bodyLean, leanT, cd * 0.7, dt);
        this._poseUpper();
        this._applyBend(dt, p);
        return;
      }
    }

    this.rodPitch = damp(this.rodPitch, pitchT, T.damp.pitch, dt);
    for (let i = 0; i < 3; i++) this._handOff[i] = damp(this._handOff[i], handT[i], T.damp.hand, dt);
    this.bodyLean = damp(this.bodyLean, leanT, T.damp.lean, dt);
    this._poseUpper();
    this._applyBend(dt, p);
  }

  /**
   * ファイト中の竿のピッチ。「構え＋しなり」の合計が糸の先（魚）を向く角度を返す。
   *
   * しなり量は張力の表示を兼ねていて 0°〜最大まで大きく振れるが、魚を向くのに
   * 要る角はほぼ一定（実測 89〜112°）なので、しなり量そのもので竿先を魚へ
   * 向けることはできない。そこで差を構えの角度で吸収する。
   * 結果として「張力が低いと竿を倒して魚を指し、高いと立てて溜める」という、
   * 実際のやり取りと同じ動きになる。
   *
   * ピッチは「垂直から前へ倒した角」なので、
   *   ピッチ ＋ しなり角 ＝ 竿先から糸の先への角度（垂直から測る）
   * を解くだけ。竿先の位置は前フレームのものを使うが、ピッチは damp を通るので
   * 誤差は次のフレームで詰まる。
   *
   * 効かせる量は張力ぶん。糸を引かれていないなら竿先を糸へ向ける理由も無いし、
   * 全部効かせると掛かった瞬間に竿が水面へ倒れる（実測で水平から +21 度 →
   * -10 度。31 度も寝ていた）。張力ゼロで base ＝ アタリ待ちの構えのままなら、
   * 掛けた瞬間に竿は動かず、引かれるほど糸の方を向いていく。
   * @param {number} base 張力ゼロのときの角度（＝アタリ待ちの構え）
   * @param {number} load 0..1。しなり量と同じ loadCurve を使う
   */
  _aimPitch(base, load) {
    if (!this._hasLineEnd || load <= 1e-3) return base;
    this.getRodTip(_v1);
    _v2.copy(this._lineEnd).sub(_v1);
    // 竿のピッチは root ローカルの前後傾きなので、体の向きを外して測る
    _v2.applyQuaternion(_q.copy(this.root.quaternion).invert());
    const fwd = Math.hypot(_v2.x, _v2.z);
    if (!Number.isFinite(fwd) || (fwd < 1e-3 && Math.abs(_v2.y) < 1e-3)) return base;
    const aim = Math.atan2(fwd, _v2.y);            // 垂直から前へ倒した角
    const A = TUNING.fightAim;
    return lerp(base, clamp(aim - this.bend * ROD_BEND_MAX, A.min, A.max), load);
  }

  /**
   * 上半身を作る。順番が大事：
   *  1. 体を前傾させ、頭を狙いの方へ向ける
   *  2. 右手の位置を決め、そこにグリップが来るようロッドを置く
   *  3. 右腕・左腕を逆運動学でその位置へ通す
   * ロッドを手のボーンの子にせず「手の位置に置く」ようにしているので、
   * リグの癖や腕の解の揺れが竿の角度に漏れない
   */
  /**
   * 竿が地面へめり込まないように、竿先が地面より上へ来るまで起こす。
   *
   * Mixamo のキャストは «もっと短い竿» で描かれている。振り下ろしの底では
   * 拳の握り軸が伏せ角 72 度まで倒れるので、1.5m ほどの竿なら竿先は足元の
   * 0.2m 上に残るが、このゲームの竿は 2.43m あり、そのまま付けると足元より
   * 0.6m 下＝桟橋を突き抜ける。
   *
   * 水平の向き（どちらへ振っているか）は動きの読み取りそのものなので変えない。
   * 竿先が地面すれすれを滑るところまで «起こす» だけにする。
   *
   * @param {THREE.Vector3}    p 竿の根元（root ローカル。y=0 が足元の地面）
   * @param {THREE.Quaternion} q 竿の向き（root ローカル）。ここを書き換える
   */
  _keepRodOffGround(p, q) {
    const minY = TUNING.motion.rodFloor;
    _v8.set(0, 1, 0).applyQuaternion(q);
    const need = (minY - p.y) / ROD_TIP_Y;      // 竿先を持ち上げるのに要る dir.y
    if (!(need > _v8.y) || need >= 1) return;   // すでに上／持ち上げようがない
    /* 水平の成分を保ったまま dir.y を need まで起こす */
    const h = Math.hypot(_v8.x, _v8.z);
    const k = h > 1e-6 ? Math.sqrt(Math.max(0, 1 - need * need)) / h : 0;
    _v9.set(_v8.x * k, need, _v8.z * k).normalize();
    // もとの向き → 起こした向き の回転を前から掛ける（竿まわりのねじれは残す）
    q.premultiply(_q4.setFromUnitVectors(_v8, _v9));
  }

  _poseUpper() {
    const B = this.bones;
    const T = TUNING;
    const w = this.motionW;

    /* クリップが書いた姿勢を先に控える。腕と首はこのあと上書きするので、
       Mixamo が乗っているぶんを混ぜ戻すための «元» が要る。
       ここは mixer.update の直後なので、控えるのはクリップの出力そのもの */
    if (w > 1e-3) {
      for (const n of MOTION_KEEP) if (B[n]) this._clipQ[n].copy(B[n].quaternion);
    }

    /* 前傾（腰を軸に体ごと）と、狙いの方を向く首。
       Mixamo 側は自前の前傾と首の動きを持っているので、乗っているぶんは薄める */
    this.tilt.rotation.x = this.bodyLean * T.body.tilt * (1 - w);
    if (B.Head && this._restQ.Head) {
      /* 足さずに毎フレーム決め打ちで入れる（足すと積み上がる）。
         Mixamo が乗っているときは、その首の向きを土台にする */
      B.Head.quaternion.copy(w > 0.02 ? this._clipQ.Head : this._restQ.Head);
      const m = T.body.headLookMax;
      B.Head.rotateX(
        (clamp(-this.pitch * T.body.headLook, -m, m) - this.bodyLean * T.body.headLean) * (1 - w * 0.6)
      );
    }
    this.root.updateMatrixWorld(true);

    /* 右手の目標＝腕の根元 + 姿勢で決めたオフセット（root の向きに合わせて回す）。
       基準は鎖骨の根元（RightShoulder）ではなく腕の根元（RightArm）にする。
       鎖骨の根元は背骨寄り（実測 x=-0.06m）で、旧素体の肩（-0.20m）とは
       14cm ずれるため、姿勢の数値がそのまま使えない */
    B.RightArm.getWorldPosition(_v1);
    _v2.set(this._handOff[0], this._handOff[1], this._handOff[2]).applyQuaternion(this.root.quaternion);
    const hand = _v3.copy(_v1).add(_v2);

    /* --- ロッドを置く ---
       構え・アタリ待ち・ファイトは手続き側が «構えの角度»（rodPitch）で置く。
       狙いの角度も、竿先から出る糸も、そこで要るから。

       キャストの振りのあいだ（w > 0）は、竿を丸ごとクリップの右手に預ける。
       Mixamo のキャストは竿を立てて構えてから体の横へ倒し、下から振り抜く
       大きな動きで、そこがこのクリップの見せ場。手続きの «前後に倒すだけ» に
       置き換えると、その振りが死ぬ。

       どちらも root ローカルの位置と向きで出してから混ぜる（親子付けそのものを
       切り替えると、乗り移る瞬間に竿が飛ぶ） */
    this.root.worldToLocal(_v4.copy(hand));
    _v5.set(0, Math.cos(this.rodPitch), Math.sin(this.rodPitch));   // root ローカルでの竿の向き
    _rodP.copy(_v4).addScaledVector(_v5, -T.arm.gripY);
    _rodQt.setFromEuler(_euler.set(this.rodPitch, 0, 0));
    if (w > 1e-3) {
      /* 右手のワールド姿勢から。握り点（指の付け根の中心＝実測 _gripLocal）へ
         寄せ、竿の +Y を拳が握っている筒の軸へ向けたうえで、グリップのどこを
         握るか（gripY）ぶん軸に沿って戻す。握り点に手首を使うと竿が 17cm
         後ろ（前腕側）へずれる */
      B.RightHand.getWorldQuaternion(_q2);
      _v14.copy(this._gripLocal).applyQuaternion(_q2).add(B.RightHand.getWorldPosition(_v15));
      _q2.multiply(this._rodQ);
      _v14.addScaledVector(_v15.set(0, 1, 0).applyQuaternion(_q2), -T.arm.gripY);
      this.root.worldToLocal(_v14);
      _q3.copy(this.root.quaternion).invert().multiply(_q2);
      _rodP.lerp(_v14, w);
      _rodQt.slerp(_q3, w);
    }
    this._keepRodOffGround(_rodP, _rodQt);
    this.rodMount.position.copy(_rodP);
    this.rodMount.quaternion.copy(_rodQt);
    this.rodMount.updateMatrixWorld(true);

    /* 右腕：肘は外側後ろへ張り出す（竿を握る側の手なので、巻いていても動かさない）。
       クリップに乗り切っているときは触らない（竿はその右手から置いてあるので、
       クリップのままで «竿を握った手» と過不足なく一致する） */
    if (w < 0.999) {
      _v6.set(...T.arm.poleR).applyQuaternion(this.root.quaternion);
      this._solveArm('Right', hand, _v6);
      if (w > 1e-3) {
        B.RightArm.quaternion.slerp(this._clipQ.RightArm, w);
        B.RightForeArm.quaternion.slerp(this._clipQ.RightForeArm, w);
      }
      this.root.updateMatrixWorld(true);
    }
    /* 左手は右手のすぐ下に添える。腕が肩から手首まで 0.42m しかなく、
       体をまたいでリールまでは届かないので、両手で握る形にしている */
    this.rodMount.localToWorld(_v3.set(0.02, T.arm.leftY, 0.015));
    /* 巻いている間は、この左手をハンドルのノブの実際の位置へ寄せる。
       ノブは公転するだけの向きを持たないグループだが、位置はワールドで
       追える（このすぐ上で rodMount.updateMatrixWorld 済み）ので、
       角度から円を作って近似するのではなく実位置にそのまま追従させる */
    if (this.reelKnob && this._reelHandBlend > 1e-3) {
      this.reelKnob.getWorldPosition(_v13);
      _v3.lerp(_v13, this._reelHandBlend);
    }
    /* 左手。クリップは両手を竿に乗せてくれている（Fishing Idle の実測で竿の線
       から 0.2cm）ので、ふだんは触らない。旧素体は腕が短くて 17cm 浮いたので
       IK で竿へ引っ張っていたが、Mannequin にそれをやると届かない目標
       （肩から 0.61m。腕は 0.49m しかない）へ引っ張って腕が伸び切る。

       手を出すのは «手続き生成のとき»（ファイト・取り込み・歩き・一人称）と
       «巻いているとき»（左手をリールのノブへ寄せる）だけ */
    const reelPull = this.reelKnob ? clamp01(this._reelHandBlend) : 0;
    const leftIK = Math.max(1 - w, reelPull);
    if (leftIK > 1e-3) {
      if (leftIK < 0.999) _v3.lerp(B.LeftHand.getWorldPosition(_v14), 1 - leftIK);
      _v6.set(...T.arm.poleL).applyQuaternion(this.root.quaternion);
      this._solveArm('Left', _v3, _v6);
      if (leftIK < 0.999) {
        B.LeftArm.quaternion.slerp(this._clipQ.LeftArm, 1 - leftIK);
        B.LeftForeArm.quaternion.slerp(this._clipQ.LeftForeArm, 1 - leftIK);
      }
      // 手を竿の向きへ向ける（指ボーンは握らせないので向きだけ）
      _v2.set(0, 1, 0).applyQuaternion(this.rodMount.getWorldQuaternion(_q));
      this._aimBone(B.LeftHand, _v2);
      if (leftIK < 0.999) B.LeftHand.quaternion.slerp(this._clipQ.LeftHand, 1 - leftIK);
    }
    if (w < 0.999) {
      _v2.set(0, 1, 0).applyQuaternion(this.rodMount.getWorldQuaternion(_q));
      this._aimBone(B.RightHand, _v2);
      if (w > 1e-3) B.RightHand.quaternion.slerp(this._clipQ.RightHand, w);
    }
  }

  /**
   * 骨をワールドの向き dir へ向ける。
   * mixamorig はどの骨も子が局所 +Y にあるので、+Y を dir に合わせればよい
   * （旧素体は子が -Y だったので符号が逆だった）
   */
  _aimBone(bone, dir) {
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(_q).invert();
    _v7.copy(dir).applyQuaternion(_q).normalize();
    bone.quaternion.setFromUnitVectors(_up, _v7);
  }

  /**
   * 肩→肘→手首の 2 リンクを目標へ通す（解析的な逆運動学）。
   * pole は肘を張り出す向き。これがないと肘が裏返ったり体にめり込む
   */
  _solveArm(side, target, pole) {
    const B = this.bones;
    const upper = B[`${side}Arm`], lower = B[`${side}ForeArm`];
    const L1 = this.armLen[side].upper, L2 = this.armLen[side].fore;
    upper.updateWorldMatrix(true, false);
    upper.getWorldPosition(_v8);
    _v9.subVectors(target, _v8);
    const d = clamp(_v9.length(), Math.abs(L1 - L2) + 0.02, L1 + L2 - 0.008);
    _v9.normalize();
    // 肩から肘までの、目標方向に沿った距離と横へのずれ
    const a = (d * d + L1 * L1 - L2 * L2) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    _v10.copy(pole).addScaledVector(_v9, -pole.dot(_v9));   // 目標方向と直交させる
    if (_v10.lengthSq() < 1e-8) _v10.set(0, -1, 0);
    _v10.normalize();
    const elbow = _v11.copy(_v8).addScaledVector(_v9, a).addScaledVector(_v10, h);
    this._aimBone(upper, _v12.subVectors(elbow, _v8).normalize());
    lower.updateWorldMatrix(true, false);
    lower.getWorldPosition(_v8);
    this._aimBone(lower, _v12.subVectors(target, _v8).normalize());
  }

  _applyBend(dt, p) {
    const st = p.state;
    const tension = p.tension || 0;
    const rf = clamp01((p.rarity ?? 0) / 5);   // レア度 0..5 → 0..1

    /* --- 滑らかな曲げ（土台）。ファイトは以前よりずっと過敏に反応させる
       （生の tension に比例させると、大物の引き / ラインブレイク寸前まで
       ほとんど曲がらず地味に見えるため、べき乗で低めのテンションから
       大きく曲がるようにする） */
    let targetAmt = 0.05;
    if (st === 'fight') {
      /* テンション 1.0 でようやく最大しなりに届く曲線にする。
         以前は pow(t,0.55)*1.25 で、テンション 67% で半円に飽和していたため
         そこから切れる 100% までまったく見た目が変わらず、
         いちばん知りたい危険域が竿から読み取れなかった。
         低いテンションでも大きく曲がる「速い立ち上がり」は指数で維持する */
      // 構えの角度もこの loadCurve で動く＝立つのと曲がるのが必ず一緒に進む
      targetAmt = tension > 0.001 ? loadCurve(tension) : 0.08;
    } else if (st === 'nibble' || st === 'bite') {
      targetAmt = 0.10;
    }
    this.bend = damp(this.bend, targetAmt, 10, dt);
    const total = this.bend * ROD_BEND_MAX;

    /* --- 竿先の一時的な動き ---
       ナブル：小さく速い震え（レアなほど速く・大きく＝警戒感）
       アタリ：ガクッと引き込まれ、そのまま小刻みに震え続ける */
    let tip = 0;
    if (st === 'nibble') {
      if (this._prevSt !== 'nibble') this._nibbleT = 0;
      this._nibbleT += dt;
      const freq = lerp(12, 20, rf);
      const amp = lerp(0.05, 0.11, rf);
      tip = Math.sin(this._nibbleT * freq) * amp * (0.55 + 0.45 * Math.sin(this._nibbleT * 3.1 + 1));
    } else if (st === 'bite') {
      if (this._prevSt !== 'bite') this._biteT = 0;
      this._biteT += dt;
      const kickWindow = 0.16;
      const kick = Math.sin(clamp01(this._biteT / kickWindow) * Math.PI);       // 0→1→0 の速いガクッ
      const kickAmp = lerp(0.32, 0.62, rf);
      const settleAmp = lerp(0.08, 0.20, rf);
      const settle = Math.sin(this._biteT * 22) * settleAmp * clamp01(this._biteT / kickWindow);
      tip = kick * kickAmp + settle;
    }
    this._prevSt = st;

    /* しなる向き。糸の先（バット基準）がほぼ真上／真下で水平方向の
       手がかりが無い時（取り込み間際など）は向きを求め直さず、
       直前の向きを保つ（さもないと正規化が暴れて画面が乱れる） */
    if (this._hasLineEnd) {
      this.rodMount.updateWorldMatrix(true, false);
      _m.copy(this.rodMount.matrixWorld).invert();
      _v2.copy(this._lineEnd).applyMatrix4(_m);
      const hl = Math.hypot(_v2.x, _v2.z);
      if (hl > 0.12 && Number.isFinite(hl)) {
        const az = Math.atan2(_v2.x, _v2.z);
        let d = az - this._bendAz;
        d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;    // 最短方向に正規化
        this._bendAz += d * (1 - Math.exp(-8 * dt));
      }
    }
    if (!Number.isFinite(this._bendAz)) this._bendAz = 0;

    /* しなる向きは、竿を軸まわりにひねって作らない。
       以前は根元を _bendAz だけ Y 回転させ、あとは各関節を X まわりに曲げていた。
       ブランクは丸いのでひねっても分からなかったが、ガイドとリールが付いた今は
       「キャスト後に視点を左右へ振ると竿ごと回る」形で見えてしまう
       （ウキはワールドに固定なので、振り向くと竿から見た方位が変わるため）。

       代わりに、全関節を「その方位へ倒れる水平軸」まわりに曲げる。
       竿先は Y 軸の上にあってひねっても動かないので、
       しなりの量・向き・竿先の位置＝糸の出どころは、ひねっていた頃と完全に同じ */
    _axis.set(Math.cos(this._bendAz), 0, -Math.sin(this._bendAz));

    const n = this.rodSegs.length;
    for (let i = 0; i < n; i++) {
      const share = (ROD_FLEX[i] ?? ROD_FLEX[ROD_FLEX.length - 1]) / ROD_FLEX_SUM;
      const seg = this.rodSegs[i];
      // 土台（滑らかに追従）と竿先の一時的な動き（減衰させず生で乗せる）を別々に持つ。
      // 同じ場所へ混ぜて damp() すると、震えの成分まで丸められて鈍ってしまうため
      this._segBase[i] = damp(this._segBase[i], total * share, 14, dt);
      let ang = this._segBase[i] + tip * share;
      // 一度 NaN が入ると damp が NaN を返し続けるので、土台ごと戻す
      if (!Number.isFinite(ang)) { ang = 0; this._segBase[i] = 0; }
      seg.quaternion.setFromAxisAngle(_axis, ang);
    }

    this._spinReel(dt, p.reeling === true ? 1 : clamp01(p.reeling || 0));
  }

  /**
   * リールを回す。巻いている間だけハンドルが TUNING.reel.handleSpeed まで乗る。
   * 押した瞬間に最高速だと機械的に見えるので、回りだしと止まりは鈍らせる
   * （ゲーム側もファイト中は F.spin で同じように巻き取りを立ち上げている）。
   * ローターはギア比を掛けた速さで連動。ノブ（取手）は公転だけさせたいので、
   * 親（ハンドル）の回転を打ち消して向きを一定に保つ（地球の周りを回る月と同じ考え方）
   */
  _spinReel(dt, reel) {
    if (!this.reelHandle) return;
    const R = TUNING.reel;
    this._reelSpin = damp(this._reelSpin, reel, R.spinUp, dt);
    // 左手の追従は機構の回り出しより速く（巻き始めた／やめた瞬間に手だけ遅れて見えないように）
    this._reelHandBlend = damp(this._reelHandBlend, reel, R.handMoveSpeed, dt);
    if (this._reelSpin < 1e-4) return;
    // 回す軸は REEL_PARTS だけに書く（ここで決め打ちすると表と食い違う）
    const dA = dt * R.handleSpeed * this._reelSpin;
    // 角度は溜め込まず一周で折り返す（長く遊んでも float の精度が落ちない）
    const a = (this.reelHandle.rotation[REEL_PARTS.handle.spin] + dA) % TAU;
    this.reelHandle.rotation[REEL_PARTS.handle.spin] = a;
    if (this.reelRotor) {
      const ax = REEL_PARTS.rotor.spin;
      this.reelRotor.rotation[ax] = (this.reelRotor.rotation[ax] + dA * R.gearRatio) % TAU;
    }
    // 差分を引くのではなく毎フレーム打ち消し切る（ズレが溜まらない）
    if (this.reelKnob) this.reelKnob.rotation[REEL_PARTS.ReelKnob.spin] = -a;
  }

  getRodTip(out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    return this.rodTip.getWorldPosition(out);
  }

  /**
   * 糸が竿を離れる点。ウキはここから飛び、狙いと着水点の予測もここを基準にする。
   *
   * 竿先そのもの（getRodTip）を使ってはいけない。振りかぶっている最中の竿先は
   * 体の後ろにあり、Mixamo のキャストでは左へ 2.4m・地面の下 0.5m まで回る。
   * そこから投げるとウキが後ろへ飛ぶ。実際の投げでも糸が離れるのは竿を
   * 振り抜いた瞬間なので、«構えたときの竿先» を使う。
   *
   * モーションの途中の姿勢に依らないので、ためている間に狙いの目印が
   * 暴れることもなくなる（竿先を使うと前後に 4m 動いていた）
   */
  getCastOrigin(out = new THREE.Vector3()) {
    if (!this.ready || !this.bones.RightArm) return this.getRodTip(out);
    const T = TUNING;
    const pitch = this.fpv ? T.fpv.waitPitch : T.pose.wait.pitch;
    this.root.updateMatrixWorld(true);
    this.bones.RightArm.getWorldPosition(out);
    _v1.set(...T.pose.wait.hand).applyQuaternion(this.root.quaternion);
    out.add(_v1);
    _v1.set(0, Math.cos(pitch), Math.sin(pitch)).applyQuaternion(this.root.quaternion);
    return out.addScaledVector(_v1, ROD_TIP_Y - T.arm.gripY);
  }

  /** 糸のたるみ量（ウキを糸の上に乗せるので game 側でも使う） */
  static sagFor(dist, slack) {
    return Math.min(dist * 0.16, 1.2) * clamp(slack, 0, 1);
  }

  /** たるみの形（t: 0=竿先 1=終点 → 下がる量）。形の定義は util.js の lineSagProfile */
  static sagAt(t, sag) {
    return lineSagProfile(t) * sag;
  }

  /**
   * ロッド先端 → ウキ の糸を張る（slack: 0=ピンピン 1=たるみ）
   * clipY を渡すと、その高さ（水面）より下は描画しない
   */
  updateLine(tipPos, endPos, slack, camera, clipY = null) {
    const pts = this._linePts;
    const total = pts.length;
    const dist = tipPos.distanceTo(endPos);
    const sag = Angler.sagFor(dist, slack);
    /* 竿先からはピンと張って出て、ウキ寄りでたるむ。
       以前は穂先の向きへ糸を寄せる区間を設けて竿と糸をなめらかに繋いでいたが、
       穂先の向きと糸の向きの差ぶん、竿先の手前で糸が持ち上がって戻る S 字になり
       「竿先で糸がたるんでいる」ように見えていた。
       実際の竿先はガイドで糸が折れ返る＝竿と糸は鋭角に交わるので、
       糸は竿先から終点へ真っ直ぐ出す（たるみの形は sagAt が持つ） */
    for (let i = 0; i < total; i++) {
      const t = i / (total - 1);
      pts[i].set(
        lerp(tipPos.x, endPos.x, t),
        lerp(tipPos.y, endPos.y, t) - Angler.sagAt(t, sag),
        lerp(tipPos.z, endPos.z, t)
      );
    }

    // 水面より下は切る（水中の糸は見せない）
    let n = total;
    if (clipY !== null) {
      for (let i = 1; i < total; i++) {
        if (pts[i].y < clipY) {
          const a = _v.copy(pts[i - 1]);
          const b = pts[i];
          const denom = a.y - b.y;
          const t = denom > 1e-5 ? clamp((a.y - clipY) / denom, 0, 1) : 0;
          pts[i].lerpVectors(a, b, t);
          n = i + 1;
          break;
        }
      }
    }
    if (n < 2) { this.line.mesh.visible = false; return; }
    this.line.update(pts, camera, n);
    this.line.mesh.visible = true;
  }

  hideLine() {
    this.line.mesh.visible = false;
    this.lineLower.mesh.visible = false;
    this.rig.visible = false;
    this.bobberRing.visible = false;
  }

  setPosition(x, y, z) { this.root.position.set(x, y, z); }
}
