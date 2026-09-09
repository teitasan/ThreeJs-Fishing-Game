/* ===========================================================
   ゲーム本体：状態機械・キャスト・ファイト・進行
   =========================================================== */
import * as THREE from 'three';
import { Environment } from './sky.js?v=20260828-uwgfx18';
import { Terrain, WATER_REGION, WALK_INLAND } from './terrain.js?v=20260906-wood1';
import { resolveLake } from './lakefield.js';
import { Water } from './water.js?v=20260906-props2';
import { FishSchool } from './fish.js?v=20260827-lkwgfx';
import { preloadFishTextures } from './fishTextures.js';
import { preloadTerrainIcons } from './terrainIcons.js';
import { Angler } from './angler.js?v=20260909-gait';
import { UI } from './ui.js';
import { Debug } from './debug.js';
import { AudioEngine } from './audio.js';
import * as Save from './save.js';
import {
  REAL_FISH, JUNK, GEAR, ACHIEVEMENTS, RIG_LAYERS, rigLayerOf, swimLayer, depthFit,
  bedAffinity, structureBonus, terrainMatches, TERRAIN_BY_ID,
  rollWeight, catchDisplayName, catchDisplayPrefix, valueOf, xpOf, rollLength, rollAlbino, fightPattern,
  baitPrefMult,
} from './data.js';
import {
  clamp, clamp01, lerp, damp, smoothstep, rand, pick, weightedPick, TAU, timeBand, fmt1,
} from './util.js?v=20260830-zone5';
import { iconHtml, iconLabel } from './icons.js';
import {
  t, joinList, gearName, terrainName, weatherName, achievementName,
  fightHint, rigName, dirLabel,
} from './i18n.js';
import { MultiplayerClient, MULTIPLAYER_SEED } from './network/multiplayer.js';
/* ?v= は «読み込む側» が新しくならないと効かない。ここを上げないと、
   キャッシュされた remotePlayer.js が古い angler.js を引いてしまい、
   釣り人のモーションが 2 つ読まれる（実測で新 72KB と旧 56KB の両方） */
import { RemotePlayers } from './multiplayer/remotePlayer.js?v=20260909-gait';
import { PostFX } from './postfx.js?v=20260828-bloom1';
import { createCausticTexture } from './causticTexture.js?v=20260828-caustnet3';
import { FrameProfiler } from './performance.js?v=20260827-lkwgfx';

const GRAVITY = 9.8;
const EXPOSURE = 0.78;
const PLAYER_RADIUS = 0.34;
/* 追従カメラの当たり半径。ニアクリップぶんの余裕を持たせて、
   幹の面がカメラの手前を横切らないようにする */
const CAM_RADIUS = 0.30;
/* 背後の物で引き寄せるときの下限（m）。これ以上寄せると釣り人の頭に入る。
   三人称の最短 CAM_MIN(1.6m) より少し内側までは許す（一時的な回避なので） */
const CAM_PULL_MIN = 1.1;
/* キャストの狙い */
/* 最弱キャストの初速。ロッド先端は足元より少し前（約1.25m）にあるので、
   初速を絞ってもそれ未満にはならない。0.5 でおよそ 1.5〜2m まで縮む */
const CAST_SPEED_MIN = 0.5;
const CAST_TOL = 0.06;         // 目印に合っていると見なすパワーの許容差
/* キャスト精度が 0 になる誤差。CAST_TOL 以内なら 1、ここまで外すと 0 で、その間は連続。
   「ジャストか外したか」の 2 択だと惜しいキャストが大外しと同じ扱いになり、
   目印に近づける練習が報われなかった */
const CAST_MISS = 0.30;
/* 着水で魚が驚く半径（m）。ジャスト → 大外し。大外し側は投げた強さでさらに広がる。
   ジャストならウキの真下がひと揺れする程度で、周りの魚は残る */
const STARTLE_R = [1.0, 3.2];
/* 驚いている時間（秒）。ジャスト → 大外し。驚いている魚はアタリの相手に選ばれない */
const STARTLE_SEC = [0.8, 5.0];
/* 竿の到達距離より少し余分に初速を出しておく。ぴったりだとパワー 1.0 に
   張り付いて「狙い通り」が出せなくなる */
const CAST_HEADROOM = 1.07;
/* 糸の長さ = 竿の最大飛距離 + 走られる余裕 + 手元の余り */
const LINE_SLACK = 8;
const HOURS_PER_SEC = 1 / 60;   // 実 1 秒 = ゲーム内 1 分（1 日 = 実 24 分）
/* ファイト（残り距離は実際のメートル）
   REEL_MPS  巻き取り速度の基準（m/s）。ロッドの reel と魚の抵抗で増減する
   LINEOUT_MPS 糸を送っているときに出ていく速さ（m/s・引きの強さ 1 あたり）
   RUN_MARGIN 掛けた地点よりどれだけ走られたら逃走か（m）。距離に関係なく一定に
              しているので、バーの「目印から右端まで」はいつでも同じ 16m ぶん
   LAND_M    ここまで寄せたら取り込み */
/* アタリを逃したときにエサが残る確率（残りはエサを持っていかれる） */
const BAIT_KEEP_ON_MISS = 0.2;
const REEL_MPS = 4.6;
const LINEOUT_MPS = 0.70;
/* リールの立ち上がり（慣性）。押し始めは糸を巻けず、押し続けるほど乗ってくる。
   40ms 間隔で叩くと 3 割しか乗らないので、細かく叩くのは損になる
   （そのぶん巻き取りの基準速度は 4.2 → 4.6 m/s に上げて全体の間延びを抑えた）。
   引きの強い魚は長く押せない＝乗り切らないので、ここが装備の壁にもなる */
const SPIN_UP = 0.22;     // 押している間の立ち上がり時定数（秒）
const SPIN_DOWN = 0.12;   // 離したときに落ちる時定数（秒）
/* 道糸のたるみ。アタリ待ちは自重で垂れるが、魚が掛かれば張る。
   LINE_TIGHTEN_SEC はアワセてから張り切るまでの秒数（＝糸が鳴る一瞬）。
   ファイト中の残りたるみは張力で 0 まで詰まる（9m 先で最大 7cm なので実質まっすぐ） */
const LINE_SLACK_WAIT = 0.62;
const LINE_SLACK_FIGHT = 0.06;
const LINE_TIGHTEN_SEC = 0.15;
const RUN_MARGIN = 16;
const LAND_M = 0.7;
/* 取り込みは「水平距離が詰まった」だけでは成立させない。実際の取り込みと同じで
   水面から出るまで巻く（F.fishDepth <= 0）。これが無いと、桟橋の深穴で真下に
   掛けた魚が水深 10m のまま「釣り上げた」ことになってしまう。
   LAND_LIFT_M は最後に水面より上へ引き上げる高さ（m） */
const LAND_LIFT_M = 0.12;
/* 浮上を始める残り距離を「今の深さ × これ」にする。おおよそ 45 度で上がってくるので、
   深い魚が水面へロケットのように飛び出すことがない */
const RISE_SLOPE = 1.1;
const RISE_MIN = 2.5;
const RISE_MAX = 12;
/* 浮き上がる速さの上限（m/s）。真下に深く掛けた場合は水平距離に余裕が無く、
   傾斜だけでは水面へ飛び出してしまうので速さそのものを抑える。
   取り込みは深さの条件付きなので、そのぶんファイトが伸びる */
const RISE_MPS = 3.0;
/* 魚が跳ねられる深さ（m）。水面近くにいる時だけ跳ぶ＝実際の魚と同じで、
   深いところで掛かった魚は寄せて浮かせてから跳ぶようになる。
   ここを深くすると、跳び始めに水中から水面へ瞬間移動する量が増える */
const JUMP_MAX_DEPTH = 1.2;
/* 上の深さに居るあいだ、走っている魚が跳ねだす速さ（回/秒）。
   走り 1 回（約 1.2 秒）を通して浅ければ 8 割がた跳ぶ、くらいの値 */
const JUMP_RATE = 1.4;
/* ラインブレイクの警告（画面端の赤・バーの点滅）を出し始める「切れるまでの残り秒数」。
   テンションの % で警告すると、張力の上がる速さが魚と装備で 2 倍以上違うため
   猶予がまったく揃わない（実測：80% から切れるまで通常 0.4〜0.6 秒、
   突進中はどれも 0.26〜0.32 秒しかなく、人の反応速度では間に合わない）。
   残り秒数で出せば、引きが強い相手ほど自動的に早い段階から警告が出る */
const SNAP_WARN_LEAD = 1.5;
/* 張力が上下する速さの倍率（ファイトのテンポ）。gain・decay・走り中の押し戻しを
   同じ倍率で遅くするので、押している時間と離している時間の比＝duty は保たれる。
   1.0 だとゲージが 2.1〜2.7 秒で上がり切り、反射神経の勝負になっていた。
   0.5 で 4.1〜5.4 秒。
   ただし警告どおりに離すプレイでは、警告が出るまで長く巻けるぶん結果的に easier に
   なる（実測：チョウザメ123cm カーボン+PE2号 35 秒 → 22 秒）。
   飛距離ゲート（竹竿 10m では深場の魚に届かない）と引きの強さでレア 4〜5 は
   引き続き弾かれるので、装備の段差そのものは残っている */
const TENSION_TEMPO = 0.5;
/* ただし張力が低いうちは警告しない（掛けた直後から赤くならないように）。
   この比率までは警告を抑え、以降で徐々に効かせる */
const SNAP_WARN_GATE = [0.30, 0.50];
const EYE_H = 1.62;
/* レベル解禁前でも残る重みの下限（伝説タグの魚は対象外＝完全に解禁待ち）
   0.008 = Lv1・深い淵の底層・夜で エピックが約 1%（100 回のアタリに 1 回）。
   生息水深の判定が厳しくなり深場の競合が減ったので、以前より小さい値で足りる */
const LV_FLOOR = 0.008;
/* ウキ周辺の回遊魚：索敵は水平距離（XZ）。エサはウキ直下なので水深 30m でも
   垂直方向は入らない。同種がこの半径内にいれば抽選重みにボーナス */
const NEARBY_FISH_R = 18;
const NEARBY_SPECIES_BONUS = 2.0;
/* 湖の測量（M キーのマップ）
   WATER_REGION（440m）を MAP_N×MAP_N の格子で覆い、歩いた所・投げた所だけ開く */
const MAP_N = 72;
const MAP_WALK_R = 30;    // 歩いて分かる半径（m）
const MAP_CAST_R = 30;    // 着水して分かる半径（m）
/* 水中カメラの寄り引き（m） */
const UW_MIN = 0.9;
const UW_MAX = 6.5;
/* カメラ距離（三人称）。CAM_MIN からさらに手前へ回すと一人称 */
const CAM_MIN = 1.6;
const CAM_MAX = 9;

/* 釣り人のモデルを作り直すまでの暫定措置。
   true のあいだは一人称に固定し、体も腕も出さない（竿とリールだけが宙に浮いて見える）。
   ボーンは今までどおり動いていて竿を手の位置に置いているので、
   狙い・飛距離・しなりの計算は何も変わらない。見た目が出ないだけ。
   自作のモデルに差し替えたら、この 1 行を false に戻せば三人称も体も戻る */
const FPV_ONLY = false;

/** 湖を作り直して再読み込みした直後は、タイトルを飛ばして再開する */
export const AUTOSTART_KEY = 'lakeside-fishing-autostart';


/* ---------------- キャストの弾道 ----------------
   仕掛けは空気抵抗を受けるので、飛距離は初速に比例しない。
   狙いの逆算・着水予測・竿ごとの倍率の逆算で、すべて同じ積分を使う */

/** 投げ出す角度（水平＝0 として上向き成分）。見上げるほど山なりになる */
const elevFor = (pitch) => clamp(0.46 + pitch * 0.55, 0.16, 0.95);

/** 初速 speed・仰角成分 elev・高さ y0 から投げたときの水平到達距離（m） */
function flightRange(speed, elev, y0) {
  const n = Math.hypot(1, elev);
  let vx = speed / n;
  let vy = (speed * elev) / n;
  let x = 0, y = y0;
  const dt = 0.055;
  for (let i = 0; i < 200 && y > 0; i++) {
    vy -= GRAVITY * dt;
    const k = 1 - 0.0055 * Math.hypot(vx, vy) * dt;
    vx *= k; vy *= k;
    x += vx * dt; y += vy * dt;
  }
  return x;
}

/**
 * 「この竿は何 m まで届く」から初速の上限を逆算する。
 * 基準は水平に近い構え（遠投の姿勢）と、ロッド先端の高さ 3m。
 */
function castTopSpeed(rangeM) {
  const elev = elevFor(-0.03);
  const want = rangeM * CAST_HEADROOM;
  let lo = 5, hi = 60;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (flightRange(mid, elev, 3) < want) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();
const _lineEnd = new THREE.Vector3();

/** トースト等の innerHTML に他人の名前を入れる前のエスケープ */
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export class Game {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.bootedWithSave = Save.hasSave();
    this.state = Save.load();

    /* --- マルチプレイ --- */
    this.multiplayer = !!opts.multiplayer;
    this.playerName = opts.playerName || '';
    this.mp = null;              // MultiplayerClient（接続後に入る）
    this.remotePlayers = null;   // RemotePlayers（マルチ時のみ）
    /* マルチ中はシングル用のセーブ項目（湖シード・時刻・測量マップ）を
       上書きしない。ここで退避して、保存時に必ず書き戻す */
    this._soloKeep = this.multiplayer ? {
      seed: this.state.seed,
      clock: this.state.clock,
      map: {
        seed: this.state.map ? this.state.map.seed : null,
        cells: this.state.map ? this.state.map.cells : '',
      },
    } : null;
    this.audio = new AudioEngine();
    this.playing = false;
    this.time = 0;
    this.hudDepth = 0;
    this.hudRig = 0;

    /* --- 入力 --- */
    this.keys = new Set();
    this.actionHeld = false;
    this.locked = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.rmb = false;

    /* --- プレイヤー --- */
    this.pos = new THREE.Vector3();
    this.visY = 0;
    this.yaw = 0;
    this.pitch = -0.12;
    this.moveAmt = 0;
    this.moveSpeed = 0;   // 地面の速さ（m/s）。釣り人の歩きの再生倍率に渡す
    this.underwaterCam = false;
    // 水中カメラ：マウスで回す（プレイヤーの向きとは独立）
    this.uwYaw = 0;
    this.uwPitch = -0.18;
    this.uwDist = 2.6;
    this.camDist = 4.6;
    this.firstPerson = false;

    /* --- 釣り --- */
    this.fs = 'idle'; // idle|charge|flight|wait|nibble|bite|fight|landing|card
    this.charge = 0;
    this.chargeDir = 1;
    this.castPower = 0;
    this.castPerfect = false;
    this.castAcc = 0;         // キャスト精度 0〜1（着水の静かさ・魚が散る範囲に効く）
    this.bobber = new THREE.Vector3();
    this.bobberVel = new THREE.Vector3();
    this.bobberOffset = 0;
    this.castOrigin = new THREE.Vector3();
    this.castDist = 0;
    this.biteTimer = 0;
    this.hookFish = null;
    this.fight = null;
    this.retrieving = false;
    this.stateTime = 0;
    this.lastStepAt = 0;
    this.baitPos = new THREE.Vector3();
    this.approachT = 0;
  }

  /* =========================================================
     構築
     ========================================================= */
  async build(onProgress) {
    const q = this.state.settings.quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: q !== 'low', powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 2 : q === 'low' ? 1 : 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.shadowMap.enabled = this.state.settings.shadow;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.perf = new FrameProfiler(this.renderer);
    this.perf.setQuality(q);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.camera.position.set(0, 5, 0);

    await onProgress(t('ui.loadingSky'));
    this.env = new Environment(this.scene, { exposure: EXPOSURE });
    this.env.setQuality(q);

    await onProgress(t('ui.loadingLake'));
    // シードを決めて、遊べる湖になるまで検証してから採用する。
    // みんなで遊ぶときは全員が同じ固定シード＝同じ湖（地形の同期は不要）
    const wantSeed = this.multiplayer ? MULTIPLAYER_SEED
      : (this.state.settings.randomLake || !this.state.seed)
        ? Save.randomLakeSeed() : this.state.seed;
    const resolved = resolveLake(wantSeed);
    this.lake = resolved.lake;
    this.lakeStats = resolved.stats;
    this.lakeTries = resolved.tries;
    if (this.multiplayer) {
      // 表示・測量マップの照合用。保存には _soloKeep の値が使われる
      this.state.seed = resolved.seed;
    } else if (this.state.seed !== resolved.seed) {
      this.state.seed = resolved.seed;
      Save.saveNow(this.state);
    }
    await onProgress(t('ui.loadingBed'));
    let bedTextures = null;
    let dockTextures = null;
    let landTextures = null;
    let leafTextures = null;
    const texResults = await Promise.allSettled([
      Terrain.loadBedTextures(),
      Terrain.loadDockTextures(),
      Terrain.loadLandTextures(),
      Terrain.loadLeafTextures(),
    ]);
    if (texResults[0].status === 'fulfilled') bedTextures = texResults[0].value;
    else console.warn('湖底テクスチャの読み込みに失敗、頂点色で描画します', texResults[0].reason);
    if (texResults[1].status === 'fulfilled') dockTextures = texResults[1].value;
    else console.warn('桟橋テクスチャの読み込みに失敗、単色で描画します', texResults[1].reason);
    if (texResults[2].status === 'fulfilled') landTextures = texResults[2].value;
    else console.warn('陸テクスチャの読み込みに失敗、頂点色で描画します', texResults[2].reason);
    if (texResults[3].status === 'fulfilled') leafTextures = texResults[3].value;
    else console.warn('葉テクスチャの読み込みに失敗、手続き生成のカードを使います', texResults[3].reason);
    const causticsUniforms = {
      // ボロノイ境界の明線を焼いたタイルテクスチャ（湖底・魚・水中プロップ共用）
      uCaustTex: { value: createCausticTexture() },
      /* 網目の見え方の調整点。ランタイムで詰められるよう uniform で持つ。
         既定値は実機で見比べて決めたもの（1 タイル 9.5m / 6.0m の 2 枚重ね） */
      uCaustScale: { value: new THREE.Vector2(0.105, 0.166) },
      uCaustShape: { value: new THREE.Vector2(1.0, 1.4) },
      uCaustRange: { value: new THREE.Vector2(1.3, 0.22) },
      uCaustDepth: { value: new THREE.Vector2(0.07, 0.60) },
      uCaustDist: { value: new THREE.Vector2(28.0, 60.0) },
      uCaustFar: { value: new THREE.Vector2(6.0, 20.0) },
      // x = 歪める量, y = 横ずれに効かせる深度の上限（m）
      uCaustWarp: { value: new THREE.Vector2(1.15, 2.5) },
      uCaustMag: { value: 0.18 },
      uCaustMixW: { value: new THREE.Vector3(1.0, 0.5, 0.0) },
      uCaustTime: { value: 0 },
      uCaustSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCaustNight: { value: 0 },
      uCaustRain: { value: 0 },
      uCaustCloud: { value: 0 },
      uCaustStrength: { value: 0 },
    };
    this.terrain = new Terrain(this.scene, {
      quality: q, lake: resolved.lake, bedTextures, dockTextures, landTextures, leafTextures,
      causticsUniforms,
      // 遠景の木のインポスターを起動時に焼くのに使う
      renderer: this.renderer,
    });
    this._initMap();

    await onProgress(t('ui.loadingWater'));
    this.water = new Water(this.scene, this.terrain, {
      quality: q, exposure: EXPOSURE, causticsUniforms,
      skyUniforms: this.env.skyUniforms,
    });

    // 後処理（Bloom は high のみ）。water/sky はリニア出力へ切り替わる
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, {
      quality: q, water: this.water, sky: this.env.skyUniforms, exposure: EXPOSURE,
    });

    await onProgress(t('ui.loadingFishTex'));
    try {
      await Promise.all([preloadFishTextures(), preloadTerrainIcons()]);
    } catch (e) {
      console.warn('図鑑画像の読み込みに失敗', e);
    }

    await onProgress(t('ui.loadingFish'));
    this.school = new FishSchool(this.scene, this.terrain, this.water, {
      count: q === 'low' ? 14 : q === 'high' ? 30 : 22,
    });

    this.angler = new Angler(this.scene);
    // 釣り人と竿は外部の glTF なので読み終わるまで待つ
    await this.angler.load(onProgress);
    this.angler.setRod(this.state.gear.rod);   // セーブから復元した竿の見た目にする

    if (this.multiplayer) {
      this.remotePlayers = new RemotePlayers(this.scene);
      await this.remotePlayers.load(onProgress);
    }

    /* 水面のマーカー（狙い点・着水予測）は水面に置いた輪 */
    const mkMarker = (r0, r1, color, opacity) => {
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false, fog: false, side: THREE.DoubleSide,
      });
      const geo = new THREE.RingGeometry(r0, r1, 36);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 6;
      this.scene.add(mesh);
      return mesh;
    };
    // キャスト予測の輪
    this.marker = mkMarker(0.86, 1.12, 0xffe98a, 0.92);
    this.markerMat = this.marker.material;
    // 狙い点の輪（視線が水面と交わる位置）
    this.aimMarker = mkMarker(0.5, 0.66, 0x9ff0ff, 0.85);
    this.aimMat = this.aimMarker.material;

    this.ui = new UI(this);
    this.debug = new Debug(this);
    this._bindInput();

    // 初期位置（桟橋の先端）
    this.pos.copy(this.terrain.spawnPos);
    this.visY = this.pos.y;
    this.yaw = Math.atan2(this.terrain.dockDir.x, this.terrain.dockDir.z);
    this.angler.setPosition(this.pos.x, this.pos.y, this.pos.z);
    this.angler.setYaw(this.yaw);
    this.angler.setBait(this.bait.id);

    /* 水越しの絵に写らないもの（空・雨・陸の木と岩）はキャプチャから外す */
    this.water.setCaptureHidden([this.env.sky, this.env.rain, ...(this.terrain.overWaterProps || [])]);
    // 反射では空・岸木を残す。カメラ追従の雨線だけは鏡像から外す。
    /* 完全に水中の物は水面の鏡像に絶対に写らないので反射パスから外す。
       クロモは 1900 株あるので、これだけで 1 パスぶん丸ごと減る */
    this.water.setReflectionHidden([
      this.env.rain,
      this.terrain.underwaterProps?.group,
      ...(this.terrain.waterPlants?.submergedMeshes || []),
    ]);

    this.school.populate(this.pos, (d) => this.rollSpecies(d));
    if (this.state.settings.debug) this.debug.setEnabled(true);
    if (FPV_ONLY) this.angler.setBodyVisible(false);
    if (FPV_ONLY || this.state.settings.fpv) this._setFirstPerson(true, true);
    this._updateCamera(0.016, true);
    const compileT0 = performance.now();
    this.renderer.compile(this.scene, this.camera);
    this.perf?.setCompileStats(
      performance.now() - compileT0,
      this.renderer.info.programs?.length || 0
    );
    await onProgress(t('ui.loadingReady'));
  }

  /* =========================================================
     入力
     ========================================================= */
  _bindInput() {
    const c = this.canvas;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      if (this.postfx) this.postfx.setSize(window.innerWidth, window.innerHeight);
    });

    c.addEventListener('mousedown', (e) => {
      if (!this.playing) return;
      // 釣果カード中はポインタロック下でもクリックで進める
      if (this.ui.openModal === 'catch') {
        if (e.button === 0) this.dismissCatch();
        return;
      }
      if (this.ui.isBlocking()) return;
      if (e.button === 2) { this.rmb = true; return; }
      if (!this.locked && document.pointerLockElement !== c) {
        const p = c.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
        return;
      }
      if (e.button === 0) this._actionDown();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rmb = false;
      if (e.button === 0 && this.actionHeld) this._actionUp();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.playing) return;
      if (this.locked || this.rmb) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    });

    window.addEventListener('wheel', (e) => {
      if (!this.playing || this.ui.isBlocking()) return;
      const d = Math.sign(e.deltaY);
      if (!d) return;
      // 水中カメラ中はカメラの寄り引き
      if (this.underwaterCam) {
        this.uwDist = clamp(this.uwDist + d * 0.35, UW_MIN, UW_MAX);
        return;
      }
      // 一人称に固定している間は、視点の寄り引きそのものが無い
      if (FPV_ONLY) return;
      // 三人称の最短(CAM_MIN)からさらに手前へ回すと一人称、奥へ回すと三人称に戻る
      if (this.firstPerson) {
        if (d > 0) this._setFirstPerson(false);
      } else if (d < 0 && this.camDist <= CAM_MIN + 1e-3) {
        this._setFirstPerson(true);
      } else {
        this.camDist = clamp(this.camDist + d * 0.5, CAM_MIN, CAM_MAX);
      }
    }, { passive: true });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      // 仕掛けウインドウ中は上下キーでも層を選べる
      if (this.ui.openModal === 'rig' && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
        e.preventDefault();
        const i = RIG_LAYERS.findIndex((l) => l.id === this.rigLayer.id);
        const next = RIG_LAYERS[clamp(i + (e.code === 'ArrowDown' ? 1 : -1), 0, RIG_LAYERS.length - 1)];
        if (next.id !== this.rigLayer.id) {
          this.setRigLayer(next.id);
          this.ui.renderRig();
          this.audio.reelTick(0.35);
        }
        return;
      }
      if (e.repeat) return;

      // デバッグ表示はどの状態でも切り替えられる
      if (e.code === 'F3' || (e.code === 'Backquote' && !this.ui.isBlocking())) {
        e.preventDefault();
        this.debug.toggle();
        return;
      }

      // モーダル中の処理
      if (this.ui.openModal === 'catch') {
        if (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape') this.dismissCatch();
        return;
      }
      if (this.ui.isBlocking()) {
        if (this.ui.openModal === 'fishDetail'
          && (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter')) {
          this.ui.closeFishDetail();
          return;
        }
        if (e.code === 'Escape' || e.code === 'KeyQ' || e.code === 'KeyB' || e.code === 'KeyE'
          || e.code === 'KeyM') this.ui.closeAll();
        return;
      }
      if (!this.playing) {
        if (e.code === 'Space' || e.code === 'Enter') this.start(Save.hasSave());
        return;
      }

      this.keys.add(e.code);
      switch (e.code) {
        case 'Space': this._actionDown(); break;
        case 'KeyQ': this._cancelCharge(); this._exitLock(); this.ui.openJournal(); this.audio.click(); break;
        case 'KeyB': this._cancelCharge(); this._exitLock(); this.ui.openShop(); this.audio.click(); break;
        case 'Escape': this._cancelCharge(); this._exitLock(); this.ui.openPause(); break;
        case 'KeyE': this._openRig(); break;
        case 'KeyV': this._toggleUnderwater(); break;
        case 'KeyM': this._cancelCharge(); this._exitLock(); this.ui.openMap(); this.audio.click(); break;
        case 'KeyU': this._cycleFightUi(); break;
        case 'KeyO':
          if (this.multiplayer && this.mp?.connected && this.othello) {
            this._cancelCharge();
            this._exitLock();
            this.othello.toggle();
          }
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space' && this.actionHeld) this._actionUp();
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      if (this.actionHeld) this._actionUp();
    });
  }

  _exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /* =========================================================
     開始 / セーブ
     ========================================================= */
  start(useSave) {
    if (!useSave) {
      // 設定は引き継ぎつつ、同じオブジェクトのまま初期化（UI の参照を保つ）
      const keep = this.state.settings;
      Object.assign(this.state, Save.defaultState(), { settings: keep });
      if (this.bootedWithSave) {
        // 既存セーブの湖で起動していたので、新しい湖を引き直して作り直す
        this._reloadWithLake(Save.randomLakeSeed());
        return;
      }
      this.state.seed = this.lake.seed;   // 起動時に引いた湖をそのまま使う
      Save.saveNow(this.state);
    }
    this.audio.init();
    this.audio.setVolume(this.state.settings.volume);
    this.audio.setBgm(this.state.settings.bgm ?? 0.7);
    this.audio.resume();
    this.audio.playTheme('./assets/audio/theme.mp3');
    this.playing = true;
    document.body.classList.add('playing');
    this.ui.el.title.classList.remove('open');
    this.ui.toast(t('ui.toast.welcome'), 'gold');
    setTimeout(() => {
      if (this.playing && !this.ui.isBlocking()) {
        const p = this.canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      }
    }, 200);
  }

  /* =========================================================
     マルチプレイ
     ========================================================= */
  /** マルチプレイで開始（build 済み・固定シードの湖で呼ばれる） */
  startMultiplayer() {
    document.body.classList.add('multiplayer');
    this.start(true);   // セーブ（お金・装備）は普段のものを使う
    // 全員が桟橋の同じ先端に重ならないよう、横と岸側へ少しずらす
    const dir = this.terrain.dockDir;
    const rightX = -dir.z, rightZ = dir.x;
    const side = (Math.random() * 2 - 1) * 1.5;
    const back = -1.2 - Math.random() * 1.8;
    const nx = this.pos.x + rightX * side + dir.x * back;
    const nz = this.pos.z + rightZ * side + dir.z * back;
    if (this.terrain.onDock(nx, nz) !== null) {
      this.pos.x = nx;
      this.pos.z = nz;
      const y = this.terrain.onDock(nx, nz);
      this.pos.y = y;
      this.visY = y;
      this.angler.setPosition(nx, y, nz);
    }
    this._connectMultiplayer();
  }

  _connectMultiplayer() {
    const mp = new MultiplayerClient();
    this.mp = mp;
    mp.onWelcome = (m) => {
      // 時刻はサーバー基準。以降は実時間から復元するので、裏タブでもずれない
      this._mpClockBase = m.clock;
      this._mpClockWall = Date.now();
      this.state.clock = m.clock;
      for (const p of m.players) this.remotePlayers.upsert(p);
      this.ui.toast(t('ui.toast.mpConnected', {
        icon: iconHtml('ui-sparkle'), n: m.players.length + 1,
      }), 'gold');
    };
    mp.onJoin = (p) => {
      this.remotePlayers.upsert(p);
      this.ui.toast(t('ui.toast.mpJoined', { name: escHtml(p.name) }), 'good');
    };
    mp.onLeave = (p) => {
      const name = this.remotePlayers.nameOf(p.id) || p.name || '';
      this.remotePlayers.remove(p.id);
      if (name) this.ui.toast(t('ui.toast.mpLeft', { name: escHtml(name) }));
    };
    mp.onState = (p) => this.remotePlayers.upsert(p);
    mp.onError = (code) => {
      this.ui.toast(t(code === 'full' ? 'ui.toast.mpFull'
        : code === 'version' ? 'ui.toast.mpVersion' : 'ui.toast.mpError'), 'bad');
    };
    mp.onClose = () => this.ui.toast(t('ui.toast.mpClosed'), 'bad');
    mp.connect(this.playerName);
    /* 描画ループは裏タブで止まるので、位置送信だけはタイマーで回す。
       裏にいる間はブラウザが 1Hz 程度まで間引くが、完全に凍りはしない */
    if (this._mpTimer) clearInterval(this._mpTimer);
    this._mpTimer = setInterval(() => {
      if (this.playing && this.mp) {
        this.mp.sendState(this.pos.x, this.visY, this.pos.z, this.yaw, this._mpAction());
        this.mp.flushUpdate();
      }
    }, 100);
  }

  /** 他プレイヤーに見せる自分のアクション */
  _mpAction() {
    switch (this.fs) {
      case 'charge': return 'charge';
      case 'flight': return this.retrieving ? 'reel' : 'cast';
      case 'wait': case 'nibble': case 'bite': return 'wait';
      case 'fight': return 'fight';
      case 'landing': case 'card': return 'landed';
      default:
        return this.moveAmt > 0.65 ? 'run' : this.moveAmt > 0.05 ? 'walk' : 'idle';
    }
  }

  saveState() { this._persist(false); }

  /**
   * セーブの実体。マルチ中は湖シード・時刻・測量マップをシングルの値へ
   * 戻してから保存する（お金・XP・装備・図鑑は両モード共通で持ち帰る）
   */
  _persist(immediate) {
    // 測量した格子はビット列 → base64 にして持たせる
    if (this._mapDirty && this.mapBits) {
      this.state.map.cells = btoa(String.fromCharCode(...this.mapBits));
      this.state.map.seed = this.state.seed;
      this._mapDirty = false;
    }
    const data = this.multiplayer ? { ...this.state, ...this._soloKeep } : this.state;
    if (immediate) Save.saveNow(data);
    else Save.save(data);
  }

  resetSave() {
    Save.wipe();
    location.reload();
  }

  /* =========================================================
     湖（シード）
     ========================================================= */
  /** シードを保存して再読み込み。復帰後はタイトルを飛ばしてそのまま再開する */
  _reloadWithLake(seed) {
    this.state.seed = seed >>> 0;
    Save.saveNow(this.state);
    try { sessionStorage.setItem(AUTOSTART_KEY, '1'); } catch (e) { /* noop */ }
    location.reload();
  }

  /** シードを指定して湖を作り直す（再読み込み） */
  setLakeSeed(seed) {
    if (this.multiplayer) return false;   // みんなで遊ぶ湖は固定シード
    const n = Math.floor(Number(seed));
    if (!Number.isFinite(n) || n < 1 || n > 0xffffffff) {
      this.ui.toast(t('ui.toast.badSeed'), 'bad');
      this.audio.deny();
      return false;
    }
    this._reloadWithLake(n);
    return true;
  }

  newRandomLake() { return this.setLakeSeed(Save.randomLakeSeed()); }

  /** ポーズ画面に出す、いまの湖の要約 */
  lakeInfo() {
    const S = this.lakeStats || {};
    const d = this.terrain.dockEnd, dir = this.terrain.dockDir;
    const rightX = -dir.z, rightZ = dir.x;
    const dirOf = (p) => {
      const vx = p.x - d.x, vz = p.z - d.z;
      const fwd = vx * dir.x + vz * dir.z;
      const side = vx * rightX + vz * rightZ;
      const dist = Math.hypot(vx, vz);
      const lr = dirLabel(side > 0 ? 'right' : 'left');
      const fb = dirLabel(fwd > dist * 0.35 ? 'ahead' : fwd < -dist * 0.35 ? 'behind' : 'beside');
      return `${joinList([lr, fb])} ${Math.round(dist)} m`;
    };
    return {
      seed: this.state.seed,
      tries: this.lakeTries || 1,
      dockDepth: S.dockTipDepth,
      holeDepth: S.holeDepth,
      holeWhere: dirOf(this.terrain.hole),
      holeCount: this.terrain.lake.holes.length,
      flatCount: this.terrain.lake.flats.length,
      dockLen: this.terrain.lake.dock.len,
      flatDepth: S.flatDepth,
      flatWhere: dirOf(this.terrain.flat),
      shoreR: S.shoreR0,
      minDepth: S.minDepth,
      maxDepth: S.maxDepth,
    };
  }

  rest() {
    if (this.multiplayer) {
      // 時刻はサーバー基準なので一人だけ進められない
      this.ui.toast(t('ui.toast.mpNoRest'), 'bad');
      this.audio.deny();
      return;
    }
    if (this.fs !== 'idle') {
      this.ui.toast(t('ui.toast.restBusy'), 'bad');
      this.audio.deny();
      return;
    }
    this.state.clock = (this.state.clock + 1) % 24;
    this.env.tickWeather(1.2);
    this.audio.click();
    this.ui.toast(t('ui.toast.rested', {
      icon: iconHtml('ui-tea'),
      time: Math.floor(this.state.clock),
    }), 'good');
    this.saveState();
  }

  applyQuality() {
    const q = this.state.settings.quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 2 : q === 'low' ? 1 : 1.5));
    this.renderer.shadowMap.enabled = this.state.settings.shadow;
    this.env.setQuality(q);
    this.postfx?.setQuality(q);
    this.water?.setQuality(q);
    this.terrain?.setQuality(q);
    this.perf?.setQuality(q);
    if (this.postfx) {
      const s = new THREE.Vector2();
      this.renderer.getSize(s);
      this.postfx.setSize(s.x, s.y);
    }
    this.school.setCount(q === 'low' ? 14 : q === 'high' ? 30 : 22);
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    const compileT0 = performance.now();
    this.renderer.compile(this.scene, this.camera);
    this.perf?.setCompileStats(
      performance.now() - compileT0,
      this.renderer.info.programs?.length || 0
    );
  }

  /* =========================================================
     装備
     ========================================================= */
  get rod() { return GEAR.rod.find((r) => r.id === this.state.gear.rod) || GEAR.rod[0]; }
  get line() { return GEAR.line.find((r) => r.id === this.state.gear.line) || GEAR.line[0]; }
  get bait() { return GEAR.bait.find((r) => r.id === this.state.gear.bait) || GEAR.bait[0]; }

  buy(kind, id) {
    const item = GEAR[kind].find((x) => x.id === id);
    if (!item) return false;
    if (this.state.level < item.level) { this.audio.deny(); return false; }
    if (this.state.money < item.price) {
      this.ui.toast(t('ui.toast.notEnoughMoney'), 'bad');
      this.audio.deny();
      return false;
    }
    this.state.money -= item.price;
    if (kind === 'bait') {
      // エサは消耗品：束（pack）ぶん在庫に足す。何度でも買える
      const st = this.state.baitStock;
      st[item.id] = (st[item.id] || 0) + item.pack;
      this.state.gear.bait = item.id;
      this.angler.setBait(item.id);
      this.audio.buy();
      this.ui.toast(t('ui.toast.boughtPack', {
        icon: iconHtml(item.icon), name: gearName(item), n: item.pack, left: st[item.id],
      }), 'gold');
      this.saveState();
      return true;
    }
    if (!this.state.owned[kind].includes(item.id)) this.state.owned[kind].push(item.id);
    this.state.gear[kind] = item.id;
    this.audio.buy();
    this.ui.toast(t('ui.toast.boughtItem', {
      icon: iconHtml(item.icon), name: gearName(item),
    }), 'gold');
    this.saveState();
    return true;
  }

  /* ---------------- エサの在庫 ---------------- */
  baitCount(id = this.state.gear.bait) { return this.state.baitStock[id] || 0; }
  get hasBait() { return this.baitCount() > 0; }

  /** 在庫のある一番安いエサ（持ち替え先） */
  _cheapestBait() {
    return GEAR.bait
      .filter((b) => this.baitCount(b.id) > 0 && b.id !== this.state.gear.bait)
      .sort((a, b) => a.price - b.price)[0] || null;
  }

  /**
   * エサを 1 個消費する。無くなったら在庫のあるエサへ持ち替え、
   * それも無ければキャストできない状態にする（ミミズは 0G なので詰まらない）
   * @param {string} why  取られた理由（トーストの文言）
   */
  _useBait(why) {
    const id = this.state.gear.bait;
    const st = this.state.baitStock;
    const left = Math.max(0, (st[id] || 0) - 1);
    st[id] = left;
    const bait = this.bait;
    if (why) {
      this.ui.toast(t('ui.toast.baitUsed', {
        icon: iconHtml(bait.icon), reason: why, name: gearName(bait), left,
      }),
        left <= 0 ? 'bad' : left <= 2 ? 'gold' : '');
    }
    if (left <= 0) {
      const next = this._cheapestBait();
      if (next) {
        this.state.gear.bait = next.id;
        this.angler.setBait(next.id);
        this.ui.toast(t('ui.toast.baitSwitched', {
          icon: iconHtml(next.icon), name: gearName(next), left: this.baitCount(next.id),
        }), 'gold');
      } else {
        this.ui.toast(t('ui.toast.baitEmpty'), 'bad');
      }
    }
    this.saveState();
  }

  equip(kind, id) {
    if (kind === 'bait') {
      if (this.baitCount(id) <= 0) { this.audio.deny(); return; }
    } else if (!this.state.owned[kind].includes(id)) return;
    this.state.gear[kind] = id;
    if (kind === 'bait') this.angler.setBait(id);
    if (kind === 'rod') this.angler.setRod(id);
    this.audio.click();
    const item = GEAR[kind].find((x) => x.id === id);
    this.ui.toast(t('ui.toast.equipped', {
      icon: iconLabel(item.icon, gearName(item)),
    }), 'good');
    this.saveState();
  }

  /* =========================================================
     湖の測量（マップ）
     ========================================================= */
  /** セーブから復元。湖が変わっていたら測量はやり直し */
  _initMap() {
    const bytes = Math.ceil((MAP_N * MAP_N) / 8);
    const m = this.state.map || (this.state.map = { seed: null, cells: '' });
    this.mapBits = new Uint8Array(bytes);
    if (m.seed === this.state.seed && m.cells) {
      try {
        const u = Uint8Array.from(atob(m.cells), (c) => c.charCodeAt(0));
        if (u.length === bytes) this.mapBits.set(u);
      } catch (e) { /* 壊れていたら白紙から */ }
    }
    m.seed = this.state.seed;
    // 測量できる範囲（湖 + 岸から 24m）のセル数を数えて分母にする
    let total = 0;
    for (let j = 0; j < MAP_N; j++) {
      for (let i = 0; i < MAP_N; i++) {
        const [x, z] = this._mapCellPos(i, j);
        const r = Math.hypot(x, z);
        if (r < this.terrain.shoreRadius(x, z) + 24) total++;
      }
    }
    this.mapTotal = Math.max(1, total);
    this._mapDirty = false;
  }

  /** セル中心のワールド座標 */
  _mapCellPos(i, j) {
    const step = WATER_REGION / MAP_N;
    return [(i + 0.5) * step - WATER_REGION / 2, (j + 0.5) * step - WATER_REGION / 2];
  }

  mapHas(i, j) {
    const k = j * MAP_N + i;
    return (this.mapBits[k >> 3] >> (k & 7)) & 1;
  }

  /** その地点のまわりを測量済みにする */
  _revealMap(x, z, radius) {
    const step = WATER_REGION / MAP_N;
    const half = WATER_REGION / 2;
    const i0 = Math.max(0, Math.floor((x - radius + half) / step));
    const i1 = Math.min(MAP_N - 1, Math.floor((x + radius + half) / step));
    const j0 = Math.max(0, Math.floor((z - radius + half) / step));
    const j1 = Math.min(MAP_N - 1, Math.floor((z + radius + half) / step));
    const r2 = radius * radius;
    let added = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const [cx, cz] = this._mapCellPos(i, j);
        if ((cx - x) ** 2 + (cz - z) ** 2 > r2) continue;
        const k = j * MAP_N + i;
        const b = k >> 3, m = 1 << (k & 7);
        if (this.mapBits[b] & m) continue;
        this.mapBits[b] |= m;
        added++;
      }
    }
    if (added) this._mapDirty = true;
    return added;
  }

  /** 測量済みの割合（0〜1） */
  mapProgress() {
    let n = 0;
    for (let j = 0; j < MAP_N; j++) {
      for (let i = 0; i < MAP_N; i++) {
        if (!this.mapHas(i, j)) continue;
        const [x, z] = this._mapCellPos(i, j);
        if (Math.hypot(x, z) < this.terrain.shoreRadius(x, z) + 24) n++;
      }
    }
    return clamp01(n / this.mapTotal);
  }

  get mapN() { return MAP_N; }
  get mapStep() { return WATER_REGION / MAP_N; }

  /* =========================================================
     地形図鑑
     ========================================================= */
  /** デバッグ表示中は図鑑を全部見せる */
  get revealAll() { return !!this.state.settings.debug; }

  /**
   * その地点の地形を調べる（地形図鑑の判定材料）。
   * grad = 沖へ向かう水深の傾き（かけあがりの判定用）
   */
  terrainCtxAt(x, z) {
    const t = this.terrain, L = t.lake;
    const depth = t.depthAt(x, z);
    const r = Math.hypot(x, z) || 1e-4;
    const ux = x / r, uz = z / r;
    // 沖（湖心）へ向かってどれだけ落ちているか。+ が「沖へ深くなる」
    const grad = (t.depthAt(x - ux * 4, z - uz * 4) - t.depthAt(x + ux * 4, z + uz * 4)) / 8;
    const st = t.structureNear(x, z, 4.5);
    // 淵・浅い平場は複数あるので、どれかの中に居れば良い
    const inside = (list) => list.some((o) =>
      o.amp > 0 && (x - o.x) ** 2 + (z - o.z) ** 2 < (o.r * 0.8) ** 2);
    return {
      x, z, depth, grad,
      bed: t.bedAt(x, z).kind,
      struct: st ? st.kind : null,
      inHole: depth >= 19 && inside(L.holes),
      inFlat: depth <= 5.5 && inside(L.flats),
      dockDist: t.distToDock(x, z),
    };
  }

  /** 着水したら、その地点の地形を図鑑に登録する */
  _noteTerrain(x, z) {
    const ctx = this.terrainCtxAt(x, z);
    const ids = terrainMatches(ctx);
    this.spotTerrain = ids;
    const book = this.state.terrain;
    const fresh = [];
    for (const id of ids) {
      let e = book[id];
      if (!e) {
        e = book[id] = { casts: 0, depth: +ctx.depth.toFixed(1), fish: [] };
        fresh.push(id);
      }
      e.casts++;
    }
    if (fresh.length) {
      this.ui.toast(t('ui.toast.terrainLogged', {
        icon: iconHtml('ui-map'),
        name: joinList(fresh.map((id) => terrainName(TERRAIN_BY_ID[id]))),
      }), 'gold');
    }
    this.saveState();
    return ids;
  }

  /* =========================================================
     魚種の抽選
     ========================================================= */
  /** 魚種ごと・エサごとの食いつき（0〜3 の好き嫌い表を倍率に変換） */
  baitAffinity(sp) {
    return baitPrefMult(sp, this.bait);
  }

  /**
   * 水深 depth の場所に居そうな魚を抽選
   * opts.bait: エサ・タナ・レベルまで考慮する（アタリの抽選）。
   *            省略時は「そこに居るか」だけ（魚群の配置用）
   * opts.layer: プレイヤーが選んだ層（top|mid|bottom）
   * opts.near: ウキ周辺を回遊中の種 id の Set（見える魚ボーナス）
   */
  rollSpecies(depth, opts = {}) {
    const band = timeBand(this.state.clock);
    const wk = this.env.weather.key;
    const useBait = !!opts.bait;
    const bait = this.bait;
    const layerId = opts.layer ?? this.rigLayer.id;
    const bed = opts.bed ?? null;                       // 'sand' | 'rock' | 'mud'
    const nearStruct = !!opts.struct;
    const near = opts.near || null;
    // 底質は底を釣るときほど効く
    const bottomness = layerId === 'bottom' ? 1 : layerId === 'mid' ? 0.35 : 0.1;

    return weightedPick(REAL_FISH, (sp) => {
      let w = sp.spawn;
      if (w <= 0) return 0;
      /* ② 生息水深：その場所の水深が、その魚が居る水深か。
         帯を外れるほど 0 に近づき、大きく外れたら完全に 0（＝深場にドジョウは居ない）。
         日周移動する魚は時間帯で帯そのものがずれる（夜に浅場へ差すナマズなど） */
      const fit = depthFit(sp, depth, band);
      if (fit <= 0) return 0;
      w *= fit;
      w *= sp.times[band] ?? 1;
      w *= sp.weather[wk] ?? 1;
      if (useBait) {
        w *= this.baitAffinity(sp);
        /* ⑥ 遊泳層：プレイヤーが選んだ層 × その魚がその層で食うか。
           絶対メートルではなく相対位置で比べるので、浅場でも
           「底物は表層で食わない」「藻場の雷魚は表層で食う」が成立する。
           日周鉛直移動を持つ魚は、時間帯ごとに重みが入れ替わる */
        w *= swimLayer(sp, band)[layerId] ?? 1;
        // ⑧ 底質（砂地・岩場・泥底）と ⑨ 水中ストラクチャー
        if (bed) w *= bedAffinity(sp, bed, bottomness);
        if (nearStruct) w *= structureBonus(sp);
        if (sp.rarity >= 3) w *= bait.rare;
        w *= this.rod.attract;
        /* 序盤に強すぎる魚が来て理不尽にならないよう、レベルで解禁。
           ただし伝説（湖の主・イトウ）以外は解禁前も LV_FLOOR の重みで抽選に残し、
           「レベルが足りないうちに掛かってしまう大物」が極低確率で起きるようにする
           （道具が足りなければ切られるが、それはそれで一つの体験） */
        const lv = this.state.level;
        const gate = (from, span) => {
          const g = clamp01((lv - from) / span);
          return sp.tags.includes('legend') ? g : Math.max(LV_FLOOR, g);
        };
        if (sp.rarity === 4) w *= gate(2, 5);
        if (sp.rarity === 5) w *= gate(5, 6);
        if (near && near.has(sp.id)) w *= NEARBY_SPECIES_BONUS;
      }
      return w;
    });
  }

  /** ウキから水平距離 r 以内を回遊中の種 id（深さは見ない＝エサはウキ直下） */
  _nearbyWanderSpecies(x, z, r = NEARBY_FISH_R) {
    const ids = new Set();
    for (const f of this.school.fishes) {
      if (!f.active || f.state !== 'wander' || !f.species) continue;
      if (f.startle > 0) continue;   // 驚いている魚はエサに寄って来ない
      if (Math.hypot(f.pos.x - x, f.pos.z - z) < r) ids.add(f.species.id);
    }
    return ids;
  }

  /* =========================================================
     アクション（クリック / スペース）
     ========================================================= */
  _actionDown() {
    if (this.actionHeld) return;
    this.actionHeld = true;
    this.audio.resume();

    switch (this.fs) {
      case 'idle':
        if (!this.hasBait) {
          this.ui.toast(t('ui.toast.noBaitCast'), 'bad');
          this.audio.deny();
          break;
        }
        this.fs = 'charge';
        this.charge = 0;
        this.chargeDir = 1;
        this.stateTime = 0;
        this.audio.charge();
        break;
      case 'wait':
      case 'nibble':
        this._retrieve();
        break;
      case 'bite':
        this._setHook();
        break;
      default:
        break;
    }
  }

  _actionUp() {
    this.actionHeld = false;
    if (this.ui.isBlocking()) return;      // メニュー中は発射しない
    if (this.fs === 'charge') this._releaseCast();
  }

  /** ため動作を取り消す（メニューを開いた時など） */
  _cancelCharge() {
    if (this.fs !== 'charge') return;
    this.fs = 'idle';
    this.charge = 0;
    this.chargeDir = 1;
    this.castObstruction = null;
    this.marker.visible = false;
    this.ui.showPower(false);
    this.ui.setPrompt('');
  }

  /* ---------------- キャスト ---------------- */
  _aimDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  /* 竿ごとの初速上限と糸の長さ。ロッドが変わったときだけ計算し直す */
  _rodCast() {
    const rod = this.rod;
    if (this._rodCastId !== rod.id) {
      this._rodCastId = rod.id;
      this._castTop = castTopSpeed(rod.cast);
      this._maxLine = rod.cast + RUN_MARGIN + LINE_SLACK;
    }
  }

  /** 竿が狙える最大距離（m） */
  get castRange() { return this.rod.cast; }
  /** 出せる糸の長さ（m）。竿の飛距離に走られる余裕を足したもの */
  get maxLine() { this._rodCast(); return this._maxLine; }

  _castVelocity(power, out = new THREE.Vector3()) {
    this._aimDir(out);
    out.y = 0;
    if (out.lengthSq() < 1e-6) out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    out.normalize();
    out.y = elevFor(this.pitch);
    out.normalize();
    this._rodCast();
    return out.multiplyScalar(lerp(CAST_SPEED_MIN, this._castTop, power));
  }

  /**
   * あるパワーで水面（y=0）に落ちるまでの水平距離。
   * 地形サンプルを使わない軽量版で、目印の逆算に使う。
   */
  _rangeForPower(power) {
    this._rodCast();
    return flightRange(lerp(CAST_SPEED_MIN, this._castTop, power), elevFor(this.pitch), this._tipY || 3);
  }

  /**
   * 狙い距離（プレイヤー基準）に必要なパワーを二分探索で求める。
   * _rangeForPower はロッド先端からの距離なので、先端の前方オフセットを引く。
   */
  _solveTargetPower(aimDist) {
    const want = aimDist - (this._tipFwd || 0);
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (this._rangeForPower(mid) < want) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * 狙い点（照準が水面と交わる位置）・必要パワー・最短距離を更新。
   * 見下ろすほど近く、水平に近いほど遠くなる。
   */
  _updateAim(force = false) {
    if (!this.aimPoint) this.aimPoint = new THREE.Vector3();
    /* 糸が竿を離れる点（スカラーで退避：_v4 はこの後使い回す）。
       竿先そのものではないのは、ためている最中の竿先が体の後ろにあるため
       （Mixamo のキャストだと左へ 2.4m・地面の下 0.5m まで回る）。
       狙い・着水点の予測・実際の発射をすべてこの点で揃える */
    this.angler.getCastOrigin(_v4);
    const tipX = _v4.x, tipZ = _v4.z;
    this._tipY = _v4.y;
    // 狙い方向
    const dir = this._aimDir(_v4);
    const dirY = dir.y;
    const h = Math.hypot(dir.x, dir.z) || 1e-4;
    const fx = dir.x / h, fz = dir.z / h;
    this._tipFwd = (tipX - this.pos.x) * fx + (tipZ - this.pos.z) * fz;
    this.minCastDist = this._rangeForPower(0) + this._tipFwd;

    const eyeY = this.visY + EYE_H;
    const aimMax = Math.max(this.minCastDist, this.castRange);   // 竿ごとの上限
    // 視線が y=0 に達する距離。ほぼ水平〜上向きなら「無限に遠く」＝竿の限界で頭打ち
    const look = dirY < -0.02 ? h * (-eyeY / dirY) : Infinity;
    this.aimCapped = look > aimMax;
    const dist = clamp(Math.min(look, aimMax), this.minCastDist, aimMax);
    this.aimDist = dist;
    this.aimPoint.set(this.pos.x + fx * dist, 0, this.pos.z + fz * dist);

    if (force || Math.abs(dist - (this._solvedFor ?? -1)) > 0.3) {
      this._solvedFor = dist;
      this.targetPower = clamp(this._solveTargetPower(dist), 0, 1);
    }
    return dist;
  }

  /** 着水点を予測（描画マーカー用） */
  _predictLanding(power, out = new THREE.Vector3()) {
    this.angler.getCastOrigin(_v1);
    _v2.copy(_v1);
    this._castVelocity(power, _v3);
    // マーカー用の概算なので、水面は y=0 とみなして地形サンプルを半分に減らす
    const dt = 0.055;
    for (let i = 0; i < 160; i++) {
      _v3.y -= GRAVITY * dt;
      _v3.multiplyScalar(1 - 0.055 * dt * _v3.length() * 0.1);
      _v2.addScaledVector(_v3, dt);
      const ground = this.terrain.heightAt(_v2.x, _v2.z);
      if (_v2.y <= (ground < 0 ? 0 : ground)) break;
      if (_v2.distanceTo(_v1) > this.maxLine) break;
    }
    return out.copy(_v2);
  }

  _releaseCast() {
    this._updateAim(true);
    // 目印（狙った距離に必要なパワー）に合っていれば「狙い通り」
    const target = this.targetPower ?? 0.78;
    const err = Math.abs(this.charge - target);
    this.castPerfect = err <= CAST_TOL;
    /* 目印からの遠さを 0〜1 の精度にする。着水の水音・飛沫、驚く魚の範囲と時間、
       アタリの速さがこの値で連続に変わる */
    this.castAcc = clamp01(1 - Math.max(0, err - CAST_TOL) / (CAST_MISS - CAST_TOL));
    // 合っていれば小さな誤差を補正して、狙い点にきっちり落とす
    const power = this.castPerfect ? target : this.charge;
    this.castPower = power;
    this.charge = power;
    this.fs = 'flight';
    this.stateTime = 0;
    this.angler.playCast();
    this.audio.cast(power);
    this.angler.getCastOrigin(this.bobber);
    this.castOrigin.copy(this.bobber);
    this._castVelocity(power, this.bobberVel);
    this.angler.bobber.visible = true;
    this.angler.setBait(this.bait.id);
    this.marker.visible = false;
    this.aimMarker.visible = false;
    this.ui.showPower(false);
    if (this.castPerfect) {
      this.ui.toast(t('ui.toast.castPerfect', {
        icon: iconHtml('ui-sparkle'), m: fmt1(this.aimDist),
      }), 'good');
    } else {
      /* 外したときは「魚をどれだけ散らしたか」まで出す。
         これが無いと精度が着水の静かさにしか出ず、練習する手がかりにならない */
      const over = this.charge > (this.targetPower ?? 0.78);
      const label = t(over ? 'ui.toast.castOver' : 'ui.toast.castShort');
      const sub = t(this.castAcc > 0.45 ? 'ui.toast.fishScatteredLittle' : 'ui.toast.fishScattered');
      this.ui.toast(`${label} <small style="opacity:.75">${sub}</small>`, '');
    }
  }

  /** ロッド先端 → 到達点 の糸が桟橋を貫通するか */
  _lineHitsDock(tip, end) {
    return this.terrain.dockBlocksSegment(tip.x, tip.y, tip.z, end.x, end.y, end.z);
  }

  /**
   * 糸が何かを貫通しているか。'dock' | 'terrain' | 'rock' | null
   * 桟橋・陸の張り出し・岩を同じ枠組みで扱う。
   */
  lineObstruction(tip, end, slack = 0.5) {
    if (this._lineHitsDock(tip, end)) return 'dock';
    const hit = this.terrain.lineBlocked(tip.x, tip.y, tip.z, end.x, end.y, end.z, { slack });
    return hit ? hit.kind : null;
  }

  _snagOnDock(msg) {
    this.ui.toast(msg, 'bad');
    this.audio.deny();
    this._retrieve();
  }

  /** 障害の種類に応じたメッセージで回収 */
  _snagLine(kind) {
    const msg = t(kind === 'dock' ? 'ui.toast.snagDock'
      : kind === 'rock' ? 'ui.toast.snagRock' : 'ui.toast.snagLand');
    this._snagOnDock(msg);
  }

  /* ---------------- 回収 ---------------- */
  _retrieve() {
    if (this.hookFish) {
      this.hookFish.state = 'flee';
      this.hookFish.timer = 2.2;
      this.hookFish = null;
    }
    this.retrieving = true;
    this.fs = 'flight';
    this.stateTime = 0;
    this.bobberVel.set(0, 0, 0);
    // 水中カメラのまま回収すると、マウスが uwYaw にだけ入り
    // 水上の視点が動かなくなる（カメラは通常視点に戻るのに flag が残る）
    this.underwaterCam = false;
  }

  /* ---------------- アワセ ---------------- */
  _setHook() {
    const f = this.hookFish;
    if (!f) return;
    this.audio.hookSet();
    const sp = f.species;
    f.state = 'hooked';
    const sizeF = 0.55 + (f.length / sp.len[1]) * 0.75;
    const pattern = fightPattern(sp);
    /* 残り距離は実際のメートルで持つ（近くに掛けたら早く寄る）。
       逃走ラインは「掛けた距離 + 走られてよい余裕（一定）」 */
    this.bobberFar = this.bobber.clone();
    const len0 = Math.max(2.5, Math.hypot(
      this.bobber.x - (this.pos.x + Math.sin(this.yaw) * 1.6),
      this.bobber.z - (this.pos.z + Math.cos(this.yaw) * 1.6)
    ));
    const surge = sp.str * sizeF >= 1.2 && pattern.runGap < 50;
    // 掛かった深さ（水面からの距離）。ファイト中はここを起点に、疲れたら浮く
    const surf0 = this.water.surfaceY(f.pos.x, f.pos.z);
    const hookDepth = clamp(surf0 - f.pos.y, 0.4, 48);
    this.fight = {
      // 掛けた瞬間の向き。魚の見た目の位置はこれを基準にする（毎フレームの
      // 現在の向きを使うと、ファイト中に視点を回すだけで魚が振り回されて見える）
      yaw0: this.yaw,
      // 糸の残りぶんしか走らせられないので、目一杯投げたときはそこで打ち止め
      span: Math.max(len0 + 4, Math.min(len0 + RUN_MARGIN, this.maxLine)),
      dist: len0,
      tension: 0,
      stamina: 1,
      runTimer: rand(1.4, 3.2) * pattern.runGap,
      // 重い魚は掛かった瞬間に走る（近くに掛けても一方的にならないように）
      running: surge,
      runDur: surge ? rand(0.6, 1.2) * pattern.runDur : 0,
      lateral: 0,
      spin: 0,             // リールの乗り（0〜1）。押し続けると立ち上がる
      px: this.bobber.x,   // 前フレームの魚の位置（向きを動いている方へ向けるため）
      pz: this.bobber.z,
      face: 'player',      // いま向いている基準（player / move / jump）
      sizeF,
      pull0: sp.str * sizeF,
      time: 0,
      jumps: 0,
      pattern,
      jumpQueued: 0,   // 走りの途中で跳ねるまでの秒数
      jumpT: 0,        // 跳ねている残り時間
      jumpFromY: null, // 跳ね始めた高さ（弧をここから立ち上げる）
      shakeT: rand(0.6, 1.3),
      shakeOn: false,
      shakeAge: 0,
      hookDepth,         // ヒット深度（m）。2.4m 上限で浅い層へワープさせない
      fishDepth: hookDepth,  // 今の魚の深さ（m）。取り込み条件に使うので浅い側で初期化しない
      prevTension: 0,    // 張力の上がる速さを実測するための前フレーム値
      rise: 0,           // 張力の上昇（/秒・なました値）
      danger: 0,         // 0..1。切れるまでの残り秒数から出す警告の強さ
      ttl: Infinity,     // 切れるまでの推定残り秒数（デバッグ表示用）
    };
    this.fs = 'fight';
    this.stateTime = 0;
    this.water.addSplash(this.bobber.x, this.water.surfaceY(this.bobber.x, this.bobber.z), this.bobber.z, 14, 1.0);
    this.water.addRipple(this.bobber.x, this.bobber.z, 1.1, 1.4);
    if (surge) this.audio.drag();
    // レア度ではなく「手応え」と「ファイトの型」で知らせる（種は取り込むまで伏せる）
    const heavy = this.fight.pull0;
    const feel = t(heavy >= 2.0 ? 'ui.toast.hitHeavy2'
      : heavy >= 1.2 ? 'ui.toast.hitHeavy12' : 'ui.toast.hitHooked');
    this.ui.toast(
      t('ui.toast.hitBanner', { feel })
      + `<small style="opacity:.75"> — ${fightHint(pattern)}</small>`,
      heavy >= 2.0 ? 'gold' : 'good'
    );
  }

  /* =========================================================
     メインループ
     ========================================================= */
  update(dt) {
    dt = Math.min(dt, 0.1); // 極端に重い環境でも破綻しない範囲でスロー化を抑える
    const frameT0 = performance.now();
    this.perf?.beginFrame(frameT0);

    // メニュー（ポーズ・ショップ・図鑑）を開いている間は世界を止める。
    // 止めないと、ため中にメニューを開いてもキャストが進み、
    // ボタンを離した瞬間にメニュー越しに発射されてしまう。
    // みんなで遊んでいる間は世界を止められない（時刻と他プレイヤーが進み続ける）
    const paused = !this.multiplayer
      && this.playing && this.ui.isBlocking() && this.ui.openModal !== 'catch';
    const sdt = paused ? 0 : dt;
    this.time += sdt;

    if (this.playing && !paused) {
      if (this.multiplayer && this._mpClockWall != null) {
        this.state.clock = (this._mpClockBase
          + ((Date.now() - this._mpClockWall) / 1000) * HOURS_PER_SEC) % 24;
      } else {
        this.state.clock = (this.state.clock + dt * HOURS_PER_SEC) % 24;
      }
      const changed = this.env.tickWeather(dt * HOURS_PER_SEC);
      if (changed) {
        this.ui.toast(t('ui.toast.weatherChanged', {
          icon: iconHtml(changed.icon), name: weatherName(changed),
        }));
      }
    }

    if (!paused) {
      this._updateLook(dt);
      this._updateMove(dt);
      this._updateFishing(dt);
    }
    this._updateCamera(sdt);

    this.env.update(sdt, this.state.clock, this.camera, this.pos);
    // 風揺れ（雨・くもりほど強く）
    const windPow = 1 + this.env.rainIntensity * 0.9 + this.env.cloudiness * 0.2;
    this.terrain.updateWind(this.time, windPow);
    this.terrain.updateTrees(dt, this.camera.position);
    this.terrain.updateLamp(this.env.nightAmount, sdt);
    this.water.update(sdt, this.camera, this.env);
    const flowStrength = 0.035 + this.water.wind * 0.018;
    this.terrain.updateUnderwaterProps(this.time, this.camera, this.terrain.dockDir, flowStrength);
    // 渚の濡れ砂は水面と同じ時刻・風速で遡上を評価する（汀線を一致させる）
    this.terrain.updateShore(this.water.time, this.water.wind);

    this.audio.setRain(this.env.rainIntensity);
    this.audio.setNight(this.env.nightAmount);

    // 魚群（ポーズ中は入れ替えも止める）
    if (!paused) this.school.update(dt, {
      water: this.water,
      terrain: this.terrain,
      time: this.time,
      center: this.pos,
      bait: this.baitPos,
      rollSpecies: (d) => this.rollSpecies(d),
      band: timeBand(this.state.clock),
      onSplash: (f) => {
        if (f.pos.distanceTo(this.camera.position) < 60) this.audio.splash(0.6);
      },
    });

    // 他プレイヤー（補間）と自分の状態送信（10Hz に間引かれる）
    if (this.multiplayer && this.remotePlayers) {
      this.remotePlayers.update(dt);
    }

    /* 釣り人。しなりの向きと竿先の狙いは、道糸が実際につながっている先＝ウキ。
       ファイト中に魚の口を渡すと、ウキは水面・魚は水中なので竿先が魚を向いても
       竿先とウキの間で糸が折れる（実測 30 度）。仕掛けはウキから下に伸びるので、
       曲がるのはウキの所で正しい */
    const fightT = this.fight ? clamp01(this.fight.tension / this.line.cap) : 0;
    let lineEnd = null;
    if (this.fs === 'fight' && this.hookFish) {
      lineEnd = _lineEnd.copy(this.bobber);
    } else if (
      this.fs === 'flight' || this.fs === 'wait'
      || this.fs === 'nibble' || this.fs === 'bite'
    ) {
      lineEnd = this.bobber;
    }
    this.angler.pitch = this.pitch;
    this.angler.update(dt, {
      // ナブル・アタリは「待ち」の姿勢のまま、竿先の震え・引き込みだけ別枠で乗る
      state: this.fs === 'charge' ? 'charge'
        : this.fs === 'fight' ? 'fight'
          : this.fs === 'landing' || this.fs === 'card' ? 'landed'
            : this.fs === 'nibble' ? 'nibble'
              : this.fs === 'bite' ? 'bite'
                : this.fs === 'wait' ? 'wait'
                  : this.fs === 'flight' ? 'flight' : 'idle',
      charge: this.charge,
      tension: fightT,
      moving: this.moveAmt,
      speed: this.moveSpeed,
      /* どれだけ巻けているか 0..1。真偽値ではなくファイトの F.spin
         （押してから実際にリールが乗るまでの立ち上がり）をそのまま渡す。
         真偽値だと押した瞬間に姿勢だけが段差で変わり、張力＝しなりは
         1 秒かけて来るので、竿が立ってから曲がる不自然な動きになる。
         回収中は全速で巻いているので 1（姿勢には影響せずリールだけ回る） */
      reeling: this.fs === 'fight' ? (this.fight ? this.fight.spin : 0)
        : (this.retrieving ? 1 : 0),
      rarity: this.hookFish ? this.hookFish.species.rarity : 0,
      time: this.time,
      lineEnd,
    });

    this.ui.updateHUD(this);
    const updateEnd = performance.now();
    this.perf?.markUpdate(updateEnd - frameT0);
    const uwPropGroup = this.terrain.underwaterProps?.group;
    const uwPropWasVisible = uwPropGroup?.visible;
    try {
      this.perf?.beginRender(updateEnd);
      // 水越しの絵のために、水面を隠したシーンを 1 枚描いておく
      this.perf?.beginPass('capture');
      this.water.capture(this.renderer, this.scene, this.camera);
      this.perf?.endPass('capture');
      // 水上mainではWaterがcapture結果を合成するため、同じ水中propを二重描画しない。
      if (uwPropGroup) uwPropGroup.visible = false;
      // 水面の映り込み（30Hz に間引き）
      this.perf?.beginPass('reflection');
      this.water.captureReflection(this.renderer, this.scene, this.camera);
      this.perf?.endPass('reflection');
      const uwCtx = this.water.getUnderwaterContext(this.camera);
      uwCtx.cloud = this.env.cloudiness;
      this._fillUnderwaterOptics(uwCtx);
      if (uwPropGroup) uwPropGroup.visible = !!uwPropWasVisible && uwCtx.strength > 0.05;
      this.postfx.updateUnderwater(uwCtx);
      this.perf?.beginPass('composer');
      this.postfx.render(sdt);
      this.perf?.endPass('composer');
      this.perf?.endFrame(performance.now());
    } catch (error) {
      this.perf?.abortFrame();
      throw error;
    } finally {
      if (uwPropGroup) uwPropGroup.visible = uwPropWasVisible;
    }
    this.debug.update(dt);
  }

  /* ---------------- 視点 ---------------- */
  _updateLook(dt) {
    const sens = 0.0022 * this.state.settings.sens;
    /* 水中カメラ中は、プレイヤーの向きは固定してカメラだけ回す
       （竿や糸が振り回されないし、V で戻ったときに視点が飛ばない） */
    const uwLive = this.underwaterCam
      && (this.fs === 'wait' || this.fs === 'nibble' || this.fs === 'bite' || this.fs === 'fight');
    if (this.underwaterCam && !uwLive) {
      // 回収などで状態が変わったのに flag だけ残っていた場合
      this.underwaterCam = false;
    }
    if (uwLive) {
      if (this.mouseDX || this.mouseDY) {
        this.uwYaw -= this.mouseDX * sens;
        this.uwPitch = clamp(this.uwPitch - this.mouseDY * sens, -1.15, 1.15);
        this.mouseDX = 0;
        this.mouseDY = 0;
      }
      if (this.uwYaw > Math.PI) this.uwYaw -= TAU;
      if (this.uwYaw < -Math.PI) this.uwYaw += TAU;
      return;
    }
    if (this.mouseDX || this.mouseDY) {
      this.yaw -= this.mouseDX * sens;
      this.pitch = clamp(this.pitch - this.mouseDY * sens, -1.15, 0.7);
      this.mouseDX = 0;
      this.mouseDY = 0;
    }
    if (this.yaw > Math.PI) this.yaw -= TAU;
    if (this.yaw < -Math.PI) this.yaw += TAU;
    this.angler.setYaw(this.yaw);
  }

  /* ---------------- 移動 ---------------- */
  _updateMove(dt) {
    // 歩いた所を測量（2m 動くごと）
    if (this.mapBits) {
      if (!this._mapFrom) {
        // 立っている場所のまわりは最初から見えている
        this._mapFrom = this.pos.clone();
        this._revealMap(this.pos.x, this.pos.z, MAP_WALK_R);
      }
      if (this._mapFrom.distanceToSquared(this.pos) > 4) {
        this._mapFrom.copy(this.pos);
        if (this._revealMap(this.pos.x, this.pos.z, MAP_WALK_R)) this.saveState();
      }
    }
    let mx = 0, mz = 0;
    if (this.playing && !this.ui.isBlocking()) {
      if (this.keys.has('KeyW')) mz += 1;
      if (this.keys.has('KeyS')) mz -= 1;
      if (this.keys.has('KeyA')) mx -= 1;
      if (this.keys.has('KeyD')) mx += 1;
    }
    const len = Math.hypot(mx, mz);
    let target = 0;
    // 動く前の位置。«実際に進んだ距離» から地面の速さを出して釣り人へ渡す
    const wasX = this.pos.x, wasZ = this.pos.z;
    if (len > 0) {
      mx /= len; mz /= len;
      const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      let speed = run ? 6.2 : 3.1;
      if (this.fs === 'fight') speed *= 0.42;
      else if (this.fs !== 'idle') speed *= 0.75;

      // 前方 = (sin yaw, cos yaw) / 右 = (-cos yaw, sin yaw)
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      const dx = (mz * sy - mx * cy) * speed * dt;
      const dz = (mz * cy + mx * sy) * speed * dt;
      if (this._tryMove(this.pos.x + dx, this.pos.z + dz)) target = run ? 1 : 0.6;
      else if (this._tryMove(this.pos.x + dx, this.pos.z)) target = 0.5;
      else if (this._tryMove(this.pos.x, this.pos.z + dz)) target = 0.5;

      // 足音
      if (target > 0 && this.time - this.lastStepAt > (run ? 0.32 : 0.52)) {
        this.lastStepAt = this.time;
        this.audio.step();
      }
    }
    this.moveAmt = damp(this.moveAmt, target, 8, dt);
    /* 地面の速さ。釣り人の歩き／走りの再生倍率がこれで決まる（足が滑らない
       速さはクリップごとに実測してある）。入力や竿の状態から逆算するのでは
       なく実際に進んだ距離で測るので、壁ぎわで斜めに滑っているときも合う */
    const moved = Math.hypot(this.pos.x - wasX, this.pos.z - wasZ);
    this.moveSpeed = damp(this.moveSpeed, dt > 1e-4 ? moved / dt : 0, 8, dt);

    // 立ち位置の高さ
    const dockY = this.terrain.onDock(this.pos.x, this.pos.z);
    const groundY = dockY !== null ? dockY : this.terrain.heightAt(this.pos.x, this.pos.z);
    this.pos.y = groundY;
    this.visY = damp(this.visY, groundY, 14, dt);
    this.angler.setPosition(this.pos.x, this.visY, this.pos.z);
  }

  _tryMove(nx, nz) {
    /* 歩けるのは湖のまわりの帯だけ。原点から 460m だと汀線から 343m・
       61.3ha になるが、飾ってあるのは +110m までで、その外は木が立って
       いるだけの裸の地面だった。帯に絞って «歩けるところは全部完成して
       いる» ようにする（→ terrain.js WALK_INLAND）。
       境界には藪を植えてあるので、見えない壁ではなく «抜けられない茂み» */
    if (!this.debug?.enabled
      && Math.hypot(nx, nz) > this.terrain.shoreRadius(nx, nz) + WALK_INLAND) return false;
    if (this.terrain.blockedAt(nx, nz, PLAYER_RADIUS)) return false;   // 岩・木・灯篭・小舟
    const dock = this.terrain.onDock(nx, nz);
    if (dock !== null) { this.pos.x = nx; this.pos.z = nz; return true; }
    const h = this.terrain.heightAt(nx, nz);
    // 通常は膝丈まで。デバッグ中は湖底まで歩ける
    if (!this.debug?.enabled && h < -0.55) return false;
    if (h > 0.6 && this.terrain.slopeAt(nx, nz) > 1.5) return false; // 崖
    // 桟橋から降りる時の段差（デバッグ水中歩行時はスキップ）
    const cur = this.terrain.onDock(this.pos.x, this.pos.z);
    if (!this.debug?.enabled && cur !== null && h < cur - 1.9) return false;
    this.pos.x = nx; this.pos.z = nz;
    return true;
  }

  /* ---------------- カメラ ---------------- */
  _updateCamera(dt, snap = false) {
    const cam = this.camera;

    // タイトル中はゆっくり周回するアトラクトカメラ
    if (!this.playing) {
      const a = this.time * 0.045 + 1.2;
      const c = this.terrain.dockEnd;
      cam.position.set(c.x + Math.cos(a) * 17, 4.2 + Math.sin(this.time * 0.2) * 0.5, c.z + Math.sin(a) * 17);
      _v1.set(c.x + this.terrain.dockDir.x * 5, 1.1, c.z + this.terrain.dockDir.z * 5);
      cam.lookAt(_v1);
      return;
    }

    if (this.underwaterCam && (this.fs === 'wait' || this.fs === 'nibble' || this.fs === 'bite' || this.fs === 'fight')) {
      /* 水中カメラ：注視点（ファイト中は魚・それ以外はエサ）のまわりを
         マウスで回す。向きの符号は通常のマウス操作と同じ */
      const hooked = this.fs === 'fight' && this.hookFish ? this.hookFish.pos : null;
      const b = this.bobber;
      const look = _v2.set(
        hooked ? hooked.x : b.x,
        hooked ? hooked.y : this.baitY - 0.05,
        hooked ? hooked.z : b.z
      );
      const surf = this.water.surfaceY(look.x, look.z);
      const bed = this.terrain.heightAt(look.x, look.z);
      look.y = clamp(look.y, bed + 0.2, surf - 0.2);
      const cp = Math.cos(this.uwPitch);
      _v1.set(Math.sin(this.uwYaw) * cp, Math.sin(this.uwPitch), Math.cos(this.uwYaw) * cp);
      const want = _v3.copy(look).addScaledVector(_v1, -this.uwDist);
      // 水面より下・湖底より上に収める
      const wSurf = this.water.surfaceY(want.x, want.z);
      const wBed = this.terrain.heightAt(want.x, want.z);
      want.y = clamp(want.y, wBed + 0.35, wSurf - 0.28);
      cam.position.lerp(want, snap ? 1 : 1 - Math.exp(-10 * dt));
      cam.lookAt(look);
      this._setUnderwaterFx(cam.position.y < this.water.surfaceY(cam.position.x, cam.position.z));
      return;
    }

    if (this.firstPerson) {
      this._updateFpvCamera();
      return;
    }

    const dir = this._aimDir(_v1);
    const pivotY = this.visY + EYE_H;
    // 肩越し（右肩側にずらす）
    const right = _v2.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const pivot = _v3.set(this.pos.x, pivotY, this.pos.z).addScaledVector(right, 0.42);

    let dist = this.camDist;
    if (this.fs === 'fight') dist = this.camDist * 0.82;
    const want = pivot.clone().addScaledVector(dir, -dist);
    want.y += 0.35;

    /* 背後の木や岩にめり込まないように引き寄せる。
       これまで地面と水面しか見ていなかったので、木を背にして立つと
       カメラが幹の «中» へ入った。手前の面はカリングされるので、
       向こう側の内壁が見えて幹が凹んで見える。 */
    const clear = this._camClear(pivot, want);
    if (clear < 1) want.copy(pivot).lerp(want, clear);

    // 地面/水面にめり込まないように（デバッグで水中歩行中は湖底に追従）
    const gh = this.terrain.heightAt(want.x, want.z);
    const wh = gh < 0 ? this.water.surfaceY(want.x, want.z) : gh;
    const debugUw = this.debug?.enabled && this.pos.y < -0.2;
    const minY = debugUw ? gh + 0.45 : Math.max(gh + 0.45, wh + 0.35);
    if (want.y < minY) want.y = minY;

    if (snap) cam.position.copy(want);
    else cam.position.lerp(want, 1 - Math.exp(-14 * dt));

    // 注視点
    const look = pivot.clone().addScaledVector(dir, 12);
    if (this.fs === 'fight' && this.hookFish) {
      look.lerp(this.hookFish.pos, 0.35);
      // 手ブレ
      const t = clamp01(this.fight.tension / this.line.cap);
      cam.position.x += Math.sin(this.time * 31) * 0.012 * t;
      cam.position.y += Math.sin(this.time * 27) * 0.012 * t;
    } else if (this.fs === 'flight' || this.fs === 'wait' || this.fs === 'nibble' || this.fs === 'bite') {
      look.lerp(this.bobber, 0.32);
    } else if (this.fs === 'landing' || this.fs === 'card') {
      if (this.hookFish) look.lerp(this.hookFish.pos, 0.6);
    }
    cam.lookAt(look);
    const camSurf = this.water.surfaceY(cam.position.x, cam.position.z);
    this._setUnderwaterFx(debugUw && cam.position.y < camSurf);
  }

  /**
   * pivot から want までを辿って、最初にぶつかる手前までの割合を返す。
   *
   * 木の幹は当たり判定を持っているので、それをそのまま使う。
   * 足元の藪で押されないよう «その高さまである物» だけを見る。
   * @returns {number} 0〜1
   */
  _camClear(pivot, want) {
    const dx = want.x - pivot.x, dy = want.y - pivot.y, dz = want.z - pivot.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return 1;
    const steps = Math.max(2, Math.ceil(len / 0.25));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (this.terrain.blockedAt(
        pivot.x + dx * t, pivot.z + dz * t, CAM_RADIUS, pivot.y + dy * t)) {
        /* ぶつかった 1 つ手前より、さらに気持ち内側で止める。
           ただし寄せすぎない：林の中では常にどれかの幹に当たるので、
           0 まで許すとカメラが釣り人の頭に入ってしまう。
           少し幹に近づくほうが、視点が顔にめり込むよりマシ */
        return Math.max(CAM_PULL_MIN / len, (i - 1) / steps - 0.05);
      }
    }
    return 1;
  }

  /** 一人称：カメラは頭の位置そのまま。視線はマウス（レティクル＝狙い）に完全一致させる */
  _updateFpvCamera() {
    const cam = this.camera;
    // 歩行の上下（三人称の胴の bob より控えめ）
    const bob = Math.abs(Math.sin(this.angler.walkPhase)) * 0.022 * this.moveAmt;
    cam.position.set(this.pos.x, this.visY + EYE_H + bob, this.pos.z);
    if (this.fs === 'fight' && this.fight) {
      // 手ブレは一人称だと効きすぎるので弱める
      const t = clamp01(this.fight.tension / this.line.cap);
      cam.position.x += Math.sin(this.time * 31) * 0.005 * t;
      cam.position.y += Math.sin(this.time * 27) * 0.005 * t;
    }
    const dir = this._aimDir(_v1);
    cam.lookAt(_v2.copy(cam.position).addScaledVector(dir, 12));
    const surf = this.water.surfaceY(cam.position.x, cam.position.z);
    this._setUnderwaterFx(!!this.debug?.enabled && cam.position.y < surf);
  }

  _setFirstPerson(on, quiet = false) {
    if (FPV_ONLY && !on) return;   // 一人称に固定している間は三人称へ戻さない
    if (this.firstPerson === on) return;
    this.firstPerson = on;
    this.camDist = CAM_MIN;
    this.angler.setFirstPerson(on);
    this.state.settings.fpv = on;
    this.saveState();
    if (quiet) return;
    this.audio.click();
    this.ui.toast(on
      ? t('ui.toast.fpvOn', { icon: iconHtml('ui-eye') })
      : t('ui.toast.fpvOff'));
  }

  /** 水中の濁り。雨・くもりで増す（光の柱の向きは PostFX が屈折から作る） */
  _fillUnderwaterOptics(ctx) {
    ctx.turbidity = 1 + this.env.rainIntensity * 0.5 + this.env.cloudiness * 0.12;
  }

  _setUnderwaterFx(on) {
    if (this._uwFx === on) return;
    this._uwFx = on;
    this.env.underwater = on;
    this.water?.setUnderwaterView(on);
    this.audio.setUnderwater(on);
  }

  /** ファイト中の表示量を U キーで回す。ファイト中でも即時に切り替わる */
  _cycleFightUi() {
    const mode = this.ui.cycleFightUi(this.state);
    this.ui.toast(t('ui.toast.fightUiMode', { mode: t(`fightUi.${mode}`) }), 'good');
    this.audio.click();
    this.saveState();
  }

  _toggleUnderwater() {
    const ok = ['wait', 'nibble', 'bite', 'fight'].includes(this.fs);
    if (!ok) {
      this.ui.toast(t('ui.toast.uwNeed'), 'bad');
      this.audio.deny();
      return;
    }
    this.underwaterCam = !this.underwaterCam;
    if (this.underwaterCam) {
      // いまの立ち位置から仕掛けを見る向きで始める
      this.uwYaw = Math.atan2(this.bobber.x - this.pos.x, this.bobber.z - this.pos.z);
      this.uwPitch = -0.18;
    }
    this.audio.click();
    this.ui.toast(this.underwaterCam
      ? t('ui.toast.uwOn', { icon: iconHtml('ui-wave') })
      : t('ui.toast.uwOff'));
  }

  /* =========================================================
     釣りの状態機械
     ========================================================= */
  /**
   * 水面より下の糸を隠すためのクリップ高さ。
   * 陸の上、または水中カメラ中（水中の糸を見せたい）は null。
   */
  _clipY(x, z) {
    if (this._uwFx) return null;
    if (this.terrain.depthAt(x, z) <= 0.02) return null;
    return this.water.surfaceY(x, z);
  }

  /* ---------------- タナ（狙う層） ----------------
     表層 / 中層 / 底層 の 3 択。実際の深さは着水地点の水深に対する比率で
     自動的に決まるので、場所を移っても釣り分けの意味が変わらない */
  get rigLayer() {
    return rigLayerOf(this.state.rigLayer);
  }

  /** その場所でエサが実際に入る深さ（m） */
  rigDepthAt(x, z) {
    return this.rigDepthFor(this.terrain.depthAt(x, z));
  }

  /** 水深 d の場所での深さ。底に埋まらないよう 0.35m の余裕を残す */
  rigDepthFor(d, layer = this.rigLayer) {
    if (!(d > 0)) return 0.35;
    return clamp(d * layer.ratio, 0.35, Math.max(0.35, d - 0.35));
  }

  /** 底べた（ゴミが増える層）か */
  get rigOnBottom() {
    return this.rigLayer.id === 'bottom';
  }

  /** 仕掛けウインドウ（E）。投げてしまったら結び直せないので、キャスト前だけ */
  _openRig() {
    if (this.fs !== 'idle' && this.fs !== 'charge') {
      this.ui.toast(t('ui.toast.rigLocked'), 'bad');
      this.audio.deny();
      return;
    }
    this._cancelCharge();
    this._exitLock();
    this.ui.openRig();
    this.audio.click();
  }

  setRigLayer(id) {
    if (!RIG_LAYERS.some((l) => l.id === id) || this.state.rigLayer === id) return;
    this.state.rigLayer = id;
    this.saveState();
  }

  get baitY() {
    return -this.rigDepthAt(this.bobber.x, this.bobber.z);
  }

  _updateFishing(dt) {
    if (!this.playing) {
      this.ui.setPrompt('');
      this.ui.showPower(false);
      this.ui.showFight(false);
      return;
    }
    this.stateTime += dt;
    const ui = this.ui;
    const bob = this.angler.bobber;
    this.angler.getRodTip(_v1);

    switch (this.fs) {
      /* ---------------- 待機 ---------------- */
      case 'idle': {
        // 照準の狙い点を出しておく（水深の下見にも使える）
        this._updateAim();
        const ad = this.terrain.depthAt(this.aimPoint.x, this.aimPoint.z);
        this.hudDepth = ad;
        this.hudRig = this.rigDepthAt(this.aimPoint.x, this.aimPoint.z);
        this.hudAim = this.aimDist;
        this.aimMarker.visible = true;
        this.aimMarker.position.set(
          this.aimPoint.x,
          (ad > 0 ? this.water.surfaceY(this.aimPoint.x, this.aimPoint.z) : this.terrain.heightAt(this.aimPoint.x, this.aimPoint.z)) + 0.05,
          this.aimPoint.z
        );
        this.aimMat.color.setHex(ad > 0.4 ? 0x9ff0ff : 0xff9a80);
        this.aimMarker.scale.setScalar(1);
        bob.visible = false;
        this.angler.hideLine();
        this.marker.visible = false;
        ui.showPower(false);
        ui.showFight(false);
        ui.setPrompt(this.hasBait
          ? t('ui.toast.idleHint', { name: rigName(this.rigLayer) })
            + (this.aimCapped ? t('ui.prompt.rodLimit', { m: this.castRange }) : '')
          : t('ui.toast.idleNoBait'));
        break;
      }

      /* ---------------- 力をためる ---------------- */
      case 'charge': {
        if (this.stateTime < dt * 1.5) { this.castObstruction = null; this._obsCheckT = 1; }
        const rate = 1.05;
        this.charge += this.chargeDir * rate * dt;
        if (this.charge >= 1) { this.charge = 1; this.chargeDir = -1; }
        if (this.charge <= 0.0) { this.charge = 0; this.chargeDir = 1; }

        // 狙い点と、その距離に必要なパワー（目印）
        this._updateAim();
        const onTarget = Math.abs(this.charge - this.targetPower) <= CAST_TOL;
        ui.showPower(true, this.charge, this.targetPower, CAST_TOL);
        const aimDepth = this.terrain.depthAt(this.aimPoint.x, this.aimPoint.z);
        this.hudAim = this.aimDist;
        this.aimMarker.visible = true;
        this.aimMarker.position.set(
          this.aimPoint.x,
          (aimDepth > 0 ? this.water.surfaceY(this.aimPoint.x, this.aimPoint.z) : this.terrain.heightAt(this.aimPoint.x, this.aimPoint.z)) + 0.05,
          this.aimPoint.z
        );
        this.aimMat.color.setHex(onTarget ? 0x9dffb4 : 0x9ff0ff);
        this.aimMarker.scale.setScalar(onTarget ? 1.1 : 1);

        ui.setPrompt(onTarget
          ? t('ui.toast.chargeNow')
          : t('ui.toast.chargeHold', { m: fmt1(this.aimDist) }));
        // 着水点予測（糸が何かに掛かる場合は赤くして知らせる）
        this._predictLanding(this.charge, _v2);
        const d = this.terrain.depthAt(_v2.x, _v2.z);
        // 糸の判定は毎フレームやると重いので 12Hz で更新
        this._obsCheckT = (this._obsCheckT || 0) + dt;
        if (this._obsCheckT > 0.08) {
          this._obsCheckT = 0;
          this.castObstruction = d > 0.25 ? this.lineObstruction(_v1, _v2, 0.62) : null;
        }
        const obstruct = this.castObstruction;
        this.hudDepth = d;
        this.hudRig = this.rigDepthAt(_v2.x, _v2.z);
        this.marker.visible = true;
        this.marker.position.set(_v2.x, (d > 0 ? this.water.surfaceY(_v2.x, _v2.z) : this.terrain.heightAt(_v2.x, _v2.z)) + 0.06, _v2.z);
        this.marker.scale.setScalar(1 + (1 - this.charge) * 0.5);
        this.markerMat.color.setHex(obstruct ? 0xff5a4a : d > 0.4 ? 0xfff0b0 : 0xff8a6a);
        if (obstruct) {
          const key = obstruct === 'dock' ? 'ui.toast.obstructDock'
            : obstruct === 'rock' ? 'ui.toast.obstructRock' : 'ui.toast.obstructLand';
          ui.setPrompt(`${iconHtml('ui-warn')} ${t(key)}`);
        }
        bob.visible = false;
        this.angler.hideLine();
        break;
      }

      /* ---------------- 飛行 / 回収 ---------------- */
      case 'flight': {
        ui.setPrompt('');
        this.aimMarker.visible = false;
        if (this.retrieving) {
          // ウキを手元へ
          _v2.subVectors(_v1, this.bobber);
          const d = _v2.length();
          if (d < 0.8) {
            this.retrieving = false;
            this.fs = 'idle';
            bob.visible = false;
            this.angler.hideLine();
            break;
          }
          _v2.multiplyScalar(1 / d);
          const sp = 9 + this.rod.reel * 6;
          this.bobber.addScaledVector(_v2, Math.min(d, sp * dt));
          const surf = this.water.surfaceY(this.bobber.x, this.bobber.z);
          if (this.bobber.y < surf) {
            this.bobber.y = lerp(this.bobber.y, surf, 0.3);
            if (Math.random() < dt * 8) this.water.addRipple(this.bobber.x, this.bobber.z, 0.35, 0.8);
          }
          this.audio.reelTick(1.5);
        } else {
          // 放物線
          _v3.copy(this.bobber);                       // 直前位置（桟橋との判定用）
          this.bobberVel.y -= GRAVITY * dt;
          const spd = this.bobberVel.length();
          this.bobberVel.multiplyScalar(1 - 0.0055 * spd * dt);
          this.bobber.addScaledVector(this.bobberVel, dt);

          // 桟橋に当たったら落ちる
          if (this.terrain.dockBlocksSegment(_v3.x, _v3.y, _v3.z, this.bobber.x, this.bobber.y, this.bobber.z)) {
            this.bobber.copy(_v3);
            this._snagOnDock(t('ui.toast.dockHit'));
            break;
          }

          const ground = this.terrain.heightAt(this.bobber.x, this.bobber.z);
          const surf = ground < 0 ? this.water.surfaceY(this.bobber.x, this.bobber.z) : ground;
          const lineOut = this.bobber.distanceTo(this.castOrigin);

          if (this.bobber.y <= surf || lineOut > this.maxLine) {
            this.bobber.y = surf;
            if (ground < -0.25) this._onLandWater();
            else this._onLandGround();
          }
        }
        bob.visible = true;
        bob.position.copy(this.bobber);
        bob.rotation.set(0, 0, 0);
        this.angler.updateLine(_v1, this.bobber, 0.25, this.camera,
          this._clipY(this.bobber.x, this.bobber.z));
        this.angler.updateRig(this.bobber, this.baitPos, this.camera, false, dt);
        this.angler.bobberRing.visible = false;
        break;
      }

      /* ---------------- アタリ待ち ---------------- */
      case 'wait':
      case 'nibble': {
        const surf = this.water.surfaceY(this.bobber.x, this.bobber.z);
        this.hudDepth = this.terrain.depthAt(this.bobber.x, this.bobber.z);
        this.hudRig = this.rigDepthAt(this.bobber.x, this.bobber.z);
        this.hudAim = 0;
        this.aimMarker.visible = false;
        this.baitPos.set(this.bobber.x, this.baitY, this.bobber.z);

        // ウキの挙動
        let off = 0;
        if (this.fs === 'nibble') {
          off = -0.045 + Math.sin(this.stateTime * 17) * 0.05 - 0.02;
          if (Math.random() < dt * 3.5) {
            this.water.addRipple(this.bobber.x, this.bobber.z, 0.3, 0.9);
            this.audio.nibble();
          }
        } else {
          off = Math.sin(this.time * 1.6) * 0.012;
        }
        this.bobberOffset = damp(this.bobberOffset, off, 10, dt);
        this.bobber.y = surf + 0.012 + this.bobberOffset;
        bob.visible = true;
        bob.position.copy(this.bobber);
        this.water.surfaceNormal(this.bobber.x, this.bobber.z, _v2);
        bob.quaternion.setFromUnitVectors(UP, _v2);
        this.angler.updateLine(_v1, this.bobber, LINE_SLACK_WAIT, this.camera, this._uwFx ? null : surf);
        // 水中の仕掛けは水中カメラの時だけ見せる
        this.angler.updateRig(this.bobber, this.baitPos, this.camera, !!this._uwFx, dt);
        // 水面のリング（遠くでもウキが見えるように）
        const ring = this.angler.bobberRing;
        ring.visible = true;
        ring.position.set(this.bobber.x, surf + 0.02, this.bobber.z);
        ring.scale.setScalar(1 + Math.sin(this.time * 1.7) * 0.07 + (this.fs === 'nibble' ? 0.35 : 0));
        ring.material.opacity = this.fs === 'nibble' ? 0.55 : 0.34;

        // 糸が伸びきったら強制回収
        if (_v1.distanceTo(this.bobber) > this.maxLine) {
          this.ui.toast(t('ui.toast.lineMax'), 'bad');
          this._retrieve();
          break;
        }
        // 歩いて障害物を挟んでしまったら糸が掛かる
        if (this.moveAmt > 0.02) {
          const obs = this.lineObstruction(_v1, this.bobber, 0.62);
          if (obs) { this._snagLine(obs); break; }
        }

        // アタリ抽選
        this.biteTimer -= dt;
        if (this.fs === 'wait') {
          if (!this.hookFish && this.biteTimer <= 0) this._chooseBiter();
          if (this.hookFish) {
            this.approachT += dt;
            // 接近中の魚が餌に着いたら nibble へ
            if (this.hookFish.state === 'nibble') {
              this.fs = 'nibble';
              this.stateTime = 0;
              this.nibbleDur = rand(0.7, 1.9) * (this.hookFish.species.rarity >= 4 ? 1.5 : 1);
            } else if (this.hookFish.state !== 'approach' || this.approachT > 22) {
              // 逃げた・辿り着けない
              if (this.hookFish.state === 'approach') this.hookFish.state = 'wander';
              this.hookFish = null;
              this.biteTimer = rand(2, 5);
            }
          }
          ui.setPrompt(this._waitPrompt());
        } else {
          if (this.stateTime > this.nibbleDur) this._startBite();
          ui.setPrompt(t('ui.toast.nibble'));
        }
        break;
      }

      /* ---------------- アタリ本番 ---------------- */
      case 'bite': {
        const surf = this.water.surfaceY(this.bobber.x, this.bobber.z);
        const biteProgress = clamp01(this.stateTime / 0.22);
        this.bobber.y = surf + 0.012 - biteProgress * 0.42 - Math.sin(this.stateTime * 24) * 0.03;
        bob.position.copy(this.bobber);
        if (Math.random() < dt * 6) this.water.addRipple(this.bobber.x, this.bobber.z, 0.5, 0.9);
        this.angler.updateLine(_v1, this.bobber, 0.25, this.camera, this._uwFx ? null : surf);
        this.angler.updateRig(this.bobber, this.baitPos, this.camera, !!this._uwFx, dt);
        this.angler.bobberRing.visible = false;
        ui.setPrompt(t('ui.toast.biteNow'));
        if (this.stateTime > this.biteWindow) this._missBite();
        break;
      }

      /* ---------------- ファイト ---------------- */
      case 'fight': {
        this.aimMarker.visible = false;
        this._updateFight(dt, _v1);
        break;
      }

      /* ---------------- 取り込み ---------------- */
      case 'landing': {
        const f = this.hookFish;
        this.aimMarker.visible = false;
        ui.showFight(false);
        ui.setPrompt('');
        if (!f) { this.fs = 'idle'; break; }
        const t = clamp01(this.stateTime / 0.85);
        // 一人称は目の前に来すぎるので、少し遠く・低い位置で持ち上げる
        const lift = this.firstPerson ? 1.7 : 1.1;
        _v2.copy(this.pos);
        _v2.y = this.visY + (this.firstPerson ? 0.95 : 1.15);
        _v2.x += Math.sin(this.yaw) * lift;
        _v2.z += Math.cos(this.yaw) * lift;
        f.pos.lerp(_v2, 1 - Math.exp(-6 * dt));
        f.state = 'landed';
        f.mesh.position.copy(f.pos);
        f.mesh.rotation.set(0, -this.yaw + Math.PI * 0.5, lerp(0, 0.5, t));
        // 糸（とウキ）は口に付く。持ち上げた魚は口から下がる
        this.bobber.copy(f.mouthPos(_v5)).y += 0.06;
        bob.position.copy(this.bobber);
        this.angler.updateLine(_v1, this.bobber, 0.9, this.camera);
        if (this.stateTime > 0.8 && !this.cardShown) this._showCatchCard();
        break;
      }

      case 'card': {
        const f = this.hookFish;
        if (f) {
          f.mesh.position.copy(f.pos);
          f.mesh.rotation.z = 0.5 + Math.sin(this.time * 3) * 0.12;
        }
        this.angler.updateLine(_v1, this.bobber, 0.9, this.camera);
        break;
      }
    }
  }

  _waitPrompt() {
    if (this.hookFish) {
      const d = this.hookFish.pos.distanceTo(this.baitPos);
      if (d < 4.5) return t('ui.toast.waitNear');
    }
    const d = this.terrain.depthAt(this.bobber.x, this.bobber.z);
    return t('ui.toast.waitBite', {
      depth: fmt1(d),
      name: rigName(this.rigLayer),
    });
  }

  /* ---------------- 着水 ---------------- */
  _onLandWater() {
    const x = this.bobber.x, z = this.bobber.z;
    // 桟橋・陸の張り出し・岩を挟んで着水した場合は糸が掛かっている
    const obstruct = this.lineObstruction(this.angler.getRodTip(_v1), this.bobber, 0.62);
    if (obstruct) {
      this._snagLine(obstruct);
      return;
    }
    this.fs = 'wait';
    this.stateTime = 0;
    this.castDist = Math.hypot(x - this.pos.x, z - this.pos.z);
    this._noteTerrain(x, z);
    this._revealMap(x, z, MAP_CAST_R);
    /* 精度が高いほど静かに落ちる。魚が散るかどうかは音と飛沫の大きさで見えるので、
       プレイヤーが「今のは静かだった」と分かるように見た目も揃える */
    const acc = this.castAcc ?? 0;
    const soft = 1 - acc * 0.55;
    this.audio.splash((0.55 + this.castPower * 0.5) * soft);
    this.water.addSplash(x, this.water.surfaceY(x, z), z,
      Math.max(4, Math.round(16 * soft)), (0.9 + this.castPower * 0.5) * soft);
    this.water.addRipple(x, z, (1.0 + this.castPower * 0.7) * soft, 1.9);
    this.water.addRipple(x, z, 0.6 * soft, 1.3);
    /* 近くの魚を驚かせる。半径と時間を精度で連続に変えるので、狙い通り決めれば
       着水地点の魚がその場に残り、大外しすると周りの魚が数秒散る */
    this.school.startle(x, z,
      lerp(STARTLE_R[0], STARTLE_R[1] + this.castPower * 2.0, 1 - acc),
      lerp(STARTLE_SEC[0], STARTLE_SEC[1], 1 - acc));
    // アタリまでの時間（ラインの見え方も効く：フロロは速く、PEはやや遅い）
    const attract = this.bait.attract * this.rod.attract * this.line.attract
      * this.env.weather.bite * (1 + 0.18 * acc);
    const depth = this.terrain.depthAt(x, z);
    let base = rand(2.2, 7.0) / attract;
    if (depth < 0.9) base *= 1.7;
    this.biteTimer = base;
    this.hookFish = null;
  }

  _onLandGround() {
    this.fs = 'flight';
    this.retrieving = true;
    this.stateTime = 0;
    this.ui.toast(t('ui.toast.landGround'), 'bad');
    this.audio.deny();
  }

  /* ---------------- アタリの主を決める ---------------- */
  _chooseBiter() {
    const x = this.bobber.x, z = this.bobber.z;
    const depth = this.terrain.depthAt(x, z);
    const baitDepth = -this.baitY;

    /* ゴミ抽選：ゴミは底に沈んでいるものなので、底層だと増え、
       表層・中層では減る（タナを選ぶ意味をゴミ側にも持たせる） */
    const junkP = 0.085 * this.bait.junk * (depth < 1.4 ? 1.8 : 1)
      * (this.rigOnBottom ? 1.5 : 0.55) * (this.state.totalCaught < 3 ? 0.3 : 1);
    let sp = null;
    if (Math.random() < junkP) {
      sp = pick(JUNK);
    } else {
      sp = this.rollSpecies(depth, {
        bait: true, layer: this.rigLayer.id,
        bed: this.terrain.bedAt(x, z).kind,
        struct: !!this.terrain.structureNear(x, z, 4.5),
        near: this._nearbyWanderSpecies(x, z),
      });
    }
    if (!sp) { this.biteTimer = rand(2, 4); return; }

    // ゴミは泳いで来ないので、その場で引っ掛かる
    if (sp.rarity === 0) {
      const junkFish = this.school.reserve();
      junkFish.spawn(sp, Math.round(rand(sp.len[0], sp.len[1]) * 10) / 10,
        _v2.set(x + rand(-0.3, 0.3), this.baitY - 0.1, z + rand(-0.3, 0.3)));
      junkFish.state = 'nibble';
      junkFish.timer = 6;
      this.hookFish = junkFish;
      this.approachT = 0;
      return;
    }

    const albino = rollAlbino(sp);

    // その魚種の個体が近くにいれば呼び寄せる（水平距離・エサはウキ直下）
    let fish = null;
    let bestD = 1e9;
    {
      for (const f of this.school.fishes) {
        if (!f.active || f.species !== sp) continue;
        if (f.state !== 'wander' || f.startle > 0) continue;
        const d = Math.hypot(f.pos.x - x, f.pos.z - z);
        if (d < NEARBY_FISH_R && d < bestD) { bestD = d; fish = f; }
      }
    }
    if (fish) {
      if (albino) fish.spawn(sp, fish.length, fish.pos.clone(), { albino: true });
    } else {
      // 視界の外から呼ぶ
      fish = this.school.reserve();
      const a = rand(0, TAU);
      const len = rollLength(sp, this.bait.rare * 0.25);
      let ok = false;
      for (let i = 0; i < 20; i++) {
        const r = rand(5.5, 9.5);
        const px = x + Math.cos(a + i * 0.7) * r;
        const pz = z + Math.sin(a + i * 0.7) * r;
        const d = this.terrain.depthAt(px, pz);
        if (d < 0.8) continue;
        const y = -clamp(Math.min(baitDepth + rand(-1, 1), d - 0.4), 0.35, Math.max(0.4, d - 0.35));
        fish.spawn(sp, len, _v2.set(px, y, pz), { albino });
        fish._depthBias = Math.random();
        ok = true;
        break;
      }
      if (!ok) { this.biteTimer = rand(2, 4); return; }
    }

    fish.state = 'approach';
    fish.timer = 14;
    this.hookFish = fish;
    this.approachT = 0;
  }

  _startBite() {
    const sp = this.hookFish.species;
    this.fs = 'bite';
    this.stateTime = 0;
    // ラインの伸びが少ないほどアタリが直に伝わる＝アワセの猶予が長い（PE は長く、ナイロンは短い）
    this.biteWindow = lerp(1.55, 0.85, clamp01(sp.rarity / 5))
      * (sp.tags.includes('trout') ? 0.8 : 1) * this.line.biteWindow;
    this.audio.bite();
    this.ui.biteAlert();
    this.water.addSplash(this.bobber.x, this.water.surfaceY(this.bobber.x, this.bobber.z), this.bobber.z, 8, 0.5);
  }

  _missBite() {
    const f = this.hookFish;
    if (f) {
      f.state = 'flee';
      f.timer = 3;
      _v2.set(f.pos.x - this.pos.x, 0, f.pos.z - this.pos.z).normalize().multiplyScalar(22);
      f.target.set(f.pos.x + _v2.x, f.pos.y - 1, f.pos.z + _v2.z);
    }
    this.hookFish = null;
    this.fs = 'wait';
    this.stateTime = 0;
    this.biteTimer = rand(3, 6);
    this.audio.escape();
    this.ui.toast(t('ui.toast.missBite'), 'bad');
    // 逃げ際にエサを持っていかれる（2 割は無事に残って、そのまま釣り続けられる）
    if (Math.random() < BAIT_KEEP_ON_MISS) {
      this.ui.toast(t('ui.toast.baitSafe'), 'good');
    } else {
      this._useBait(t('ui.toast.baitStolen'));
      this._retrieve();   // 針が空になったので回収するしかない
    }
  }

  /* =========================================================
     ファイト
     ========================================================= */
  _updateFight(dt, tipPos) {
    const F = this.fight;
    const f = this.hookFish;
    if (!f) { this.fs = 'idle'; return; }
    const sp = f.species;
    const cap = this.line.cap;
    F.time += dt;

    const P = F.pattern;

    /* --- 突進 --- */
    F.runTimer -= dt;
    if (F.running) {
      F.runDur -= dt;
      // 跳ねている間は突進を終わらせない（「走ったら離す」だけで跳ねにも対応できる）
      if (F.runDur <= 0 && F.jumpT <= 0 && F.jumpQueued <= 0) {
        F.running = false;
        F.runTimer = rand(1.8, 4.2) * P.runGap / (0.6 + sp.agg * 0.8);
      }
    } else if (F.runTimer <= 0 && F.stamina > 0.16 && P.runGap < 50) {
      F.running = true;
      F.runDur = rand(0.7, 1.9) * P.runDur * (0.7 + sp.agg * 0.5);
      this.audio.drag();
      /* 「何が起きたか」だけ知らせる。どう捌くかは操作する側に任せる。
         跳ぶ魚が水面近くにいる時は「跳ねた！」が出るので、ここでは出さない */
      const willJump = P.jump > 0 && F.fishDepth <= JUMP_MAX_DEPTH;
      if (!willJump && F.pull0 >= 1.2 && Math.random() < 0.4) {
        this.ui.toast(t('ui.toast.ran'), 'bad');
      }
    }

    /* --- 首振り（振っている間は巻いても進まず、張力だけ上がる） --- */
    if (P.shake > 0 && F.stamina > 0.12) {
      F.shakeT -= dt;
      if (F.shakeOn) F.shakeAge += dt;
      if (F.shakeT <= 0) {
        F.shakeOn = !F.shakeOn;
        F.shakeAge = 0;
        const span = F.shakeOn ? (P.shakeOn || [0.34, 0.62]) : (P.shakeOff || [0.65, 1.35]);
        F.shakeT = rand(span[0], span[1]);
        if (F.shakeOn) this.audio.drag();
      }
    } else {
      F.shakeOn = false;
    }
    // 演出は始まった瞬間から、ペナルティは猶予の後から
    const shakeBite = F.shakeOn && F.shakeAge > (P.shakeGrace || 0);

    /* --- ジャンプ（予告 → 0.62秒の空中） ---
       走っているあいだ、水面近くに来たら跳ぶ。判定を「走り出した一瞬」に限ると、
       走り出すと魚は少し潜る仕様と噛み合わず、深く掛かった魚は走り出しがいつも
       深いので一度も跳ねないまま終わる（ヒット深度 5m・10m で実測 0 回）。
       毎フレーム抽選にすると「浮いてきた所で跳ぶ」になり、
       深い魚は寄せてから跳ぶ・浅い魚は最初から跳ぶ、と自然に分かれる */
    const jumpDur = P.jumpDur || 0.62;
    if (F.running && P.jump > 0 && F.jumps < 4 && F.jumpQueued <= 0 && F.jumpT <= 0
      && F.fishDepth <= JUMP_MAX_DEPTH && Math.random() < dt * JUMP_RATE) {
      F.jumpQueued = rand(0.15, 0.35);   // 予告（水しぶきの前の一瞬）
    }
    if (F.jumpQueued > 0) {
      F.jumpQueued -= dt;
      if (F.jumpQueued <= 0) {
        /* 深さで跳ぶかどうかを決めるのは予約した時（走り出した瞬間）だけ。
           ここで測り直してはいけない。走っている間は魚が少し潜る仕様なので、
           走り出しに浅くても跳ぶ頃には閾値を超えていて、
           ジャンパーがほぼ跳ばなくなる（ヒット深度 2m で 0 回になった）。
           跳び始めの高さから弧を立ち上げるので、多少沈んでいても飛びはしない */
        F.jumpT = jumpDur;
        F.jumps++;
        F.jumpFromY = f.pos.y;   // 弧をここから立ち上げる（下の fy を参照）
        this.audio.splash(1.0);
        this.ui.toast(t('ui.toast.jumped'), 'bad');
      }
    }
    if (F.jumpT > 0) F.jumpT = Math.max(0, F.jumpT - dt);
    const jumping = F.jumpT > 0;
    const jumpBite = jumping && F.jumpT < jumpDur - (P.jumpGrace || 0);

    const reeling = this.actionHeld;
    // 糸が短いほど衝撃を吸収できない＝テンションが跳ねやすい
    const shortLine = clamp(1.35 - F.dist * 0.025, 1.0, 1.35);
    const pull = F.pull0 * P.pull * (F.running ? 2.0 * P.runPull : 1.0) * (0.5 + 0.5 * F.stamina);

    if (reeling) {
      // リールが乗るまでは巻けない（押し始め 0 → 押し続けて 1）
      F.spin = 1 - (1 - F.spin) * Math.exp(-dt / SPIN_UP);
      const resist = clamp(1.70 - pull * 0.75, 0.35, 1.60) * (shakeBite ? P.shakeReel : 1);
      // m/s。遠いうちは糸を送り込むだけなので速く、寄せるほど重くなる
      const rate = this.rod.reel * REEL_MPS * resist * (1 + F.dist * 0.012) * F.spin;
      /* 取り込みは深さの条件も満たすまで待つので、その間も巻けてしまう。
         下限を切らないと魚が足元を通り越して背後に回る */
      F.dist = Math.max(0.15, F.dist - rate * dt);
      // ラインの伸び（shock）：ナイロンは衝撃を逃がして上がりにくく、PE は伸びずに直に伝わる
      let gain = (0.08 + pull * 0.55) * P.tensionGain * shortLine * this.line.shock * TENSION_TEMPO;
      if (shakeBite) gain *= P.shakeGain;
      if (jumpBite) gain *= P.jumpTension;
      F.tension += gain * dt / this.rod.power;
      this.audio.reelTick(0.7 + resist * F.spin);
    } else {
      F.spin *= Math.exp(-dt / SPIN_DOWN);             // 離すとリールは止まっていく
      F.dist += pull * LINEOUT_MPS * P.lineOut * dt;   // 出される糸は距離に関係なく m/s
      /* 張力の回復は cap に比例させる。比例させないと、回復量が絶対値なのに
         バーの高さは cap で割って表示されるため、強い糸（cap 大）ほど
         「バーが戻るのが遅い」ことになり、強度を上げたのに戦いにくくなる逆転が起きる。
         cap を掛けることで「バーの割合で見た回復速度」が糸によらず一定になる
         （基準のナイロン2号 cap=1.0 は従来と同じ挙動） */
      F.tension -= (1.30 + pull * 0.30) * P.tensionDecay * cap * TENSION_TEMPO * dt;
      /* 走られている間は張力が抜けにくい。ここに line.shock を掛けると PE が
         「巻けば急に張る・離しても抜けない」の二重苦になり、
         cap で勝っているのに実戦では弱いという逆転が起きるため掛けない */
      if (F.running) F.tension += pull * 0.30 * shortLine * cap * TENSION_TEMPO * dt;
      // 跳ねている間に糸を送れていれば、魚が余計に消耗する
      if (jumping) F.stamina -= (P.jumpDrain || 0) * dt;
    }
    F.tension = clamp(F.tension, 0, cap * 1.2);

    // 体力（テンションを掛け続けると疲れる）
    const tRatio = clamp01(F.tension / cap);
    F.stamina -= (0.022 + tRatio * 0.17 + (reeling ? 0.02 : 0)) * P.staminaDrain * dt / Math.max(0.4, sp.sta);
    F.stamina = clamp01(F.stamina);

    /* --- ラインブレイクの警告 ---
       張力の上がる速さを実測して「あと何秒で切れるか」を出し、それで警告する。
       上がる速さは魚の引き × サイズ × 竿の power × 糸の shock で 2 倍以上変わるので、
       テンションの % で警告すると猶予が揃わない（引きが強い相手ほど一瞬になる）。
       残り秒数で見れば、強い相手には自動的に早い段階から警告が出る */
    const rise = (F.tension - F.prevTension) / Math.max(dt, 1e-4);
    F.prevTension = F.tension;
    F.rise = damp(F.rise, rise, 9, dt);
    F.ttl = F.rise > 1e-4 ? (cap - F.tension) / F.rise : Infinity;
    // 掛けた直後の低い張力では警告しない（そこから赤いと常時点灯になる）
    const gate = smoothstep(SNAP_WARN_GATE[0], SNAP_WARN_GATE[1], tRatio);
    const dangerRaw = clamp01(1 - F.ttl / SNAP_WARN_LEAD) * gate;
    // 立ち上がりは即座に、収まりはゆっくり（一瞬の揺れでちらつかせない）
    F.danger = dangerRaw > F.danger ? dangerRaw : damp(F.danger, dangerRaw, 5, dt);

    // ドラグの鳴き（張力と危険度で速く・高く鳴る＝耳でも限界が分かる）
    this.audio.dragTick(tRatio, F.danger);

    /* --- 魚の位置（見た目） ---
       near は「掛けた時の向き」で固定する（this.yaw を使うと、ファイト中に
       視点を動かしただけで near が振れて魚が一緒に振り回されてしまう） */
    if (!this.bobberFar) this.bobberFar = this.bobber.clone();
    const near = _v2.set(this.pos.x, 0, this.pos.z);
    near.x += Math.sin(F.yaw0) * 1.6;
    near.z += Math.cos(F.yaw0) * 1.6;
    const far = _v3.copy(this.bobberFar);

    F.lateral = damp(F.lateral, (F.running ? Math.sin(F.time * 1.7) * 1.9 : Math.sin(F.time * 0.9) * 0.7), 3, dt);
    // 着水点の方向へ、残り距離ぶん離した所に魚を置く（メートルそのまま）
    let dx = far.x - near.x, dz = far.z - near.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    const px = -dz, pz = dx;
    // 着水点より外へ出るときは、陸に乗らない所までにする
    let reach = F.dist;
    for (let i = 0; i < 4 && reach > dl; i++) {
      if (this.terrain.depthAt(near.x + dx * reach + px * F.lateral,
        near.z + dz * reach + pz * F.lateral) > 0.35) break;
      reach = dl + (reach - dl) * 0.5;
    }
    const wx = near.x + dx * reach + px * F.lateral;
    const wz = near.z + dz * reach + pz * F.lateral;
    const depth = this.terrain.depthAt(wx, wz);
    const surf = this.water.surfaceY(wx, wz);
    /* 深さ：ヒット深度を起点に、疲れたら浮く（固定 2.4m 上限は使わない）。
       水平は毎フレーム再配置するが、Y は damp でワープさせない */
    const hookD = F.hookDepth ?? 2.4;
    const floatD = 0.4;
    let wantDepth = lerp(floatD, hookD, F.stamina * F.stamina);
    // 走り中は少し潜る（ヒット深度を大きく超えない）
    if (F.running) wantDepth = Math.min(hookD + 0.8, wantDepth + Math.min(1.4, hookD * 0.12));
    wantDepth = clamp(wantDepth, 0.25, Math.max(0.25, depth - 0.25));
    /* 寄せ切る手前で水面へ引き上げる。浮上を始める距離を今の深さに比例させているので、
       水深 20m の魚は 12m 手前から、浅場の魚は 2.5m 手前から上がってくる。
       最後は水面より上（-LAND_LIFT_M）が目標なので、巻き続けると魚は水面を割って出る */
    const riseFrom = clamp(wantDepth * RISE_SLOPE, RISE_MIN, RISE_MAX);
    wantDepth = lerp(-LAND_LIFT_M, wantDepth, clamp01((F.dist - LAND_M) / riseFrom));
    let fy;
    if (jumping) {
      /* 空中に跳ね上がる（0 → 1 → 0 の弧）。
         立ち上がりは水面ではなく「跳ね始めた高さ」から。surf 決め打ちだと、
         少しでも沈んでいたぶんがそのまま 1 コマのワープになる
         （深さを見ずに跳ばせていた頃は、水深 5m から 1 コマで 4.7m 飛んでいた）。
         着地は水面ちょうどなので、跳び終わりも damp へ滑らかにつながる */
      const jt = 1 - F.jumpT / jumpDur;
      const from = F.jumpFromY ?? surf;
      fy = lerp(from, surf, jt) + Math.sin(Math.PI * jt) * (0.45 + Math.min(1.1, F.pull0 * 0.32));
      if (Math.random() < dt * 26) {
        this.water.addSplash(wx, surf, wz, 6, 1.0);
        this.water.addRipple(wx, wz, 0.8, 1.2);
      }
    } else {
      const targetY = surf - wantDepth;
      /* 浮くときは速く、沈むときはゆっくり。糸で引き上げられる分は
         寄せる速さに追いつく必要があり、2.4 のままだと取り込み間際でも
         数 m 下に残って「深いのに釣り上げた」ことになる */
      const ny = damp(f.pos.y, targetY, targetY > f.pos.y ? 5.5 : 2.4, dt);
      fy = Math.min(ny, f.pos.y + RISE_MPS * dt);
    }
    f.pos.set(wx, fy, wz);
    const prevDepth = F.fishDepth;
    F.fishDepth = surf - fy;   // 負なら水面より上
    // 水面を割って出た瞬間の飛沫と、出ている間の水しぶき
    if (!jumping && prevDepth > 0 && F.fishDepth <= 0) {
      this.water.addSplash(wx, surf, wz, 8, 0.9);
      this.water.addRipple(wx, wz, 0.7, 1.1);
    } else if (!jumping && F.fishDepth < 0.25 && Math.random() < dt * 14) {
      this.water.addSplash(wx, surf, wz, 3, 0.5);
      this.water.addRipple(wx, wz, 0.45, 0.7);
    }
    f.state = 'hooked';
    f.mesh.position.copy(f.pos);
    /* 向き
       - 巻かれている間：引かれるのでプレイヤーを向く
       - それ以外（走り・糸を送っている間）：実際に動いている方へ向く
         （横に張るランなら横、プレイヤーから離れるランなら沖向きになる）
       - 跳ねている間：上／下向き */
    const jumpUp = jumping && F.jumpT > (P.jumpDur || 0.62) * 0.5;
    const mvx = wx - (F.px ?? wx), mvz = wz - (F.pz ?? wz);
    const mvSpeed = Math.hypot(mvx, mvz) / Math.max(dt, 1e-4);
    F.px = wx; F.pz = wz;
    if (jumping) {
      F.face = 'jump';
      _v1.set(near.x - wx, jumpUp ? 0.85 : -0.85, near.z - wz).normalize();
    } else {
      const moving = !reeling && Math.hypot(mvx, mvz) > 1e-4;
      F.face = moving ? 'move' : 'player';
      if (moving) _v1.set(mvx, 0, mvz);
      else _v1.set(near.x - wx, 0, near.z - wz);
      _v1.normalize();
      _v1.y = 0.03;
      _v1.normalize();
    }
    const roll = jumping ? Math.sin(F.time * 22) * 0.9
      : F.shakeOn ? Math.sin(F.time * 26) * 0.55
        : Math.sin(F.time * 7) * 0.5 * (F.running ? 1 : 0.35);
    f._orient(dt, _v1, roll);
    // 体のうねり（魚群側の hooked では触らないので、ここだけで決める）
    f._wiggle(dt,
      4.6 + (F.running ? 2.2 : 0) + (F.shakeOn ? 3.4 : 0) + (jumping ? 3.0 : 0),
      0.13 + (F.running ? 0.09 : 0) + (F.shakeOn ? 0.13 : 0));

    // 水面の演出
    if (!jumping && f.pos.y > surf - 0.35) {
      if (Math.random() < dt * 14) {
        this.water.addSplash(wx, surf, wz, 4, 0.5 + F.pull0 * 0.2);
        this.water.addRipple(wx, wz, 0.55, 1.0);
      }
    }
    // 首振りは水面にも波紋を出す（見て分かるように）
    if (F.shakeOn && Math.random() < dt * 9) {
      this.water.addRipple(wx, wz, 0.5, 0.8);
    }

    /* --- ウキ / 糸 ---
       アタリ待ちと同じ描き方をそのまま続ける。
         竿先 ──たるんだ道糸── ウキ（水面・魚の真上） ──仕掛け── 魚
       ウキが指すのは「魚がいる場所」で、寄せたぶんだけ手前に来る。

       以前はファイト中だけ「糸が水面と交わる点」に置いていた。幾何としては
       正しいが、魚は水中にいるので交点は魚よりずっと手前に来る。そのため
       掛けた瞬間にウキの意味が入れ替わり、魚は動いていないのにウキだけが
       内側へ飛んでいた（実測：掛ける前 6.75m → 4.31m。同じとき魚は 7.64m
       先の水深 4.51m にいて、ウキは魚より 3.3m 手前を指していた）。

       跳ねて魚が空中にいる間もウキは水面に残る（浮きなので水面より上には
       行かない）。仕掛けがウキから斜め上の魚へ伸びる形になる */
    const tip = this.angler.getRodTip(_v4);
    const mouth = f.mouthPos(_v5);
    /* 魚が付いた道糸は張る。アワセた瞬間のたるみ（アタリ待ちのまま）から
       LINE_TIGHTEN_SEC 秒で張り切らせるので、掛けた手応えが糸にも出る。
       残りのたるみは張力で 0 まで詰まる */
    const slack = lerp(LINE_SLACK_WAIT, clamp01(1 - tRatio) * LINE_SLACK_FIGHT,
      clamp01(F.time / LINE_TIGHTEN_SEC));
    this.bobber.set(mouth.x, this.water.surfaceY(mouth.x, mouth.z), mouth.z);
    this.angler.bobber.visible = true;
    this.angler.bobber.position.copy(this.bobber);
    this.water.surfaceNormal(this.bobber.x, this.bobber.z, _v7);
    this.angler.bobber.quaternion.setFromUnitVectors(UP, _v7);
    // 糸は水面で切って、水中は描かない（水中カメラ中は見せる）
    this.angler.updateLine(tip, this.bobber, slack, this.camera, this._uwFx ? null : surf);
    this.angler.updateRig(this.bobber, mouth, this.camera, false, dt);

    /* --- UI --- */
    // 魚種とレア度は取り込むまで伏せる（引きの強さだけを見せる）
    this.hudDepth = depth;
    /* 出すのはテンションと警告だけ。残り距離・魚の体力・手応えの見出しは廃止した
       （数字を追うより竿・音・画面端の赤で戦ってもらう）。
       跳ねた／首を振っている／走っているも竿の動きと水音で分かるので文字にしない */
    this.ui.showFight(true, {
      tension: tRatio,
      danger: F.danger,   // 切れるまでの残り秒数から出した警告の強さ（画面端の赤・点滅）
      reeling,
    });
    this.ui.setPrompt('');

    /* --- 決着 --- */
    if (F.tension >= cap) return this._lineSnap();
    if (F.dist >= F.span) return this._fishEscaped();
    // 水平距離だけでなく、魚が水面から出ていることも条件にする
    if (F.dist <= LAND_M && F.fishDepth <= 0) return this._land();
  }


  _lineSnap() {
    this.audio.snap();
    this.ui.toast(t('ui.toast.lineSnap', { icon: iconHtml('ui-boom') }), 'bad');
    this._useBait(t('ui.toast.baitGoneWithRig'));
    if (this.fight && this.fight.pull0 > this.line.cap * 1.35) {
      setTimeout(() => this.ui.toast(t('ui.toast.gearWeak'), 'gold'), 1200);
    }
    this.state.snapped++;
    this._releaseFish(true);
  }

  _fishEscaped() {
    this.audio.escape();
    this.ui.toast(t('ui.toast.escaped'), 'bad');
    this._useBait(t('ui.toast.baitTaken'));
    this.state.escaped++;
    this._releaseFish(true);
  }

  _releaseFish(flee) {
    const f = this.hookFish;
    if (f) {
      if (flee) {
        f.state = 'flee';
        f.timer = 4;
        _v2.set(f.pos.x - this.pos.x, 0, f.pos.z - this.pos.z).normalize().multiplyScalar(30);
        f.target.set(f.pos.x + _v2.x, f.pos.y - 2, f.pos.z + _v2.z);
      } else {
        f.despawn();
      }
    }
    this.hookFish = null;
    this.fight = null;
    this.bobberFar = null;
    this.ui.showFight(false);
    this.underwaterCam = false;
    /* 逃げ・ラインブレイクでは餌は水中に残っていてもサーバー側は
       endFight で餌を消す。クライアントも餌なしへ戻して次のキャストで
       BAIT_PLACED が確実に発火するようにする */
    this.fishing?.setBaitPresent(false, { source: 'escape' });
    this.retrieving = true;
    this.fs = 'flight';
    this.stateTime = 0;
    this.saveState();
  }

  /* ---------------- 釣り上げ ---------------- */
  _land() {
    const f = this.hookFish;
    const sp = f.species;
    this.fs = 'landing';
    this.stateTime = 0;
    this.cardShown = false;
    this.underwaterCam = false;
    const surf = this.water.surfaceY(f.pos.x, f.pos.z);
    this.water.addSplash(f.pos.x, surf, f.pos.z, 24, 1.2);
    this.water.addRipple(f.pos.x, f.pos.z, 1.4, 1.6);
    this.audio.catchFanfare(sp.rarity);
    this.ui.showFight(false);
    this._useBait(null);   // 取り込んだエサは駄目になる（在庫だけ静かに減らす）
  }

  _showCatchCard() {
    this.cardShown = true;
    const f = this.hookFish;
    const sp = f.species;
    const len = Math.round(f.length * 10) / 10;
    const weight = rollWeight(sp, len);
    const value = valueOf(sp, len);
    const xp = xpOf(sp, len);
    const s = this.state;

    const rec = s.records[sp.id];
    const isNew = !rec;
    const albino = !!f.albino;
    const isNewAlbino = albino && !(rec && rec.albinoCaught);
    const record = !!rec && len > rec.maxLen;
    const title = catchDisplayName(sp, len, weight, albino);
    const titlePrefix = catchDisplayPrefix(sp, len, weight, albino);
    if (isNew) {
      s.records[sp.id] = {
        count: 1, maxLen: len, maxWeight: weight, firstAt: Date.now(),
        albinoCaught: albino,
      };
    } else {
      rec.count++;
      rec.maxLen = Math.max(rec.maxLen, len);
      rec.maxWeight = Math.max(rec.maxWeight, weight);
      if (albino) rec.albinoCaught = true;
    }
    // 釣れた地形にも記録する（地形図鑑の「ここで釣れた魚」）
    for (const id of this.spotTerrain || []) {
      const e = s.terrain[id];
      if (e && !e.fish.includes(sp.id)) e.fish.push(sp.id);
    }
    s.money += value;
    s.totalEarned += value;
    s.totalCaught++;
    s.maxLen = Math.max(s.maxLen, len);
    if (sp.rarity === 5) s.legendCaught++;
    if (timeBand(s.clock) === 'night') s.nightCaught++;
    this._gainXp(xp);

    this.fs = 'card';
    this._exitLock(); // カーソルを戻し、カードをマウスで操作できるようにする
    this.ui.showCatch({ sp, len, weight, value, xp, record, isNew, albino, isNewAlbino, title, titlePrefix });
    this._checkAchievements();
    this._persist(true);
  }

  dismissCatch() {
    if (this.fs !== 'card') { this.ui.hideCatch(); return; }
    this.ui.hideCatch();
    if (this.hookFish) this.hookFish.despawn();
    this.hookFish = null;
    this.fight = null;
    this.bobberFar = null;
    this.fs = 'idle';
    /* 水中の餌は取り込みで消滅済み。ここで餌なし状態へ戻さないと
       次のキャストで BAIT_PLACED が発火せず、マルチではサーバーに
       餌が登録されず魚が寄ってこなくなる */
    this.fishing?.setBaitPresent(false, { source: 'catch' });
    this.angler.bobber.visible = false;
    this.angler.hideLine();
    this.audio.click();
    if (this.playing && !this.ui.isBlocking() && !document.pointerLockElement) {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }

  _gainXp(xp) {
    const s = this.state;
    s.xp += xp;
    let leveled = 0;
    while (s.xp >= Save.xpForLevel(s.level)) {
      s.level++;
      leveled++;
    }
    if (leveled) {
      this.audio.levelUp();
      setTimeout(() => {
        this.ui.toast(t('ui.toast.levelUp', {
          icon: iconHtml('ui-levelup'), level: s.level,
        }), 'gold');
      }, 500);
    }
  }

  _checkAchievements() {
    const s = this.state;
    const stats = {
      totalCaught: s.totalCaught,
      maxLen: s.maxLen,
      speciesCount: Object.keys(s.records).length,
      legendCaught: s.legendCaught,
      totalEarned: s.totalEarned,
    };
    for (const a of ACHIEVEMENTS) {
      if (s.achievements.includes(a.id)) continue;
      if (a.test(stats)) {
        s.achievements.push(a.id);
        setTimeout(() => this.ui.toast(t('ui.toast.achUnlock', {
          icon: iconHtml('ui-medal'), name: achievementName(a),
        }), 'gold'), 900);
      }
    }
  }
}
