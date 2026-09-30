/* ===========================================================
   Terrain ファサード：地形の問い合わせ・当たり・桟橋・描画への受け口
   -----------------------------------------------------------
   地形・森・下草・水辺の植物・岩・桟橋の «見た目» は src/gfx のモジュールが描く。
   ここはゲームと約束した値（契約 §4.2）だけを持つ：
     - 問い合わせ（heightAt ほか）と当たり（障害物の 8m ハッシュ・糸・桟橋）は
       src/world に移した旧ロジック。fixture（scripts/fixtures）と 1e−9 で一致する
     - 障害物は placement（シードだけから決まる）から «全品質で同じ» ものを積む
     - コンストラクタが終わった時点で数学系と当たりはすぐ使える（_initMap が直後に呼ぶ）
     - 高さ場の格子（Worker）と描画の初期化は ready（Promise）。game.js が Bed の段で待つ
   =========================================================== */
import * as THREE from 'three';
import { WORLD_SIZE, WATER_REGION, MAX_DEPTH, resolveLake } from './lakefield.js';
import { makeQueries } from './world/queries.js';
import { makeDock, dockLocal, onDock, distToDock, dockBlocksSegment } from './world/dock.js';
import { ObstacleGrid, lineBlocked } from './world/collision.js';
import { buildPlacement, obstacleList, collisionHash, WALK_INLAND } from './world/placement.js';
import { buildHeightGrids, prewarmHeightWorkers } from './world/heightgrid.js';
import { getGfx } from './gfx/core/index.js';

export { WORLD_SIZE, WATER_REGION, MAX_DEPTH, WALK_INLAND };

const v3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

const warned = new Set();
function warnOnce(tag, e) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[terrain] ${tag}`, e);
}

export class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts  lake（lakefield.resolveLake の結果）または seed
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.quality = opts.quality || 'mid';

    // 地形の数学部分は lakefield.js（検証済みの湖）に委譲
    this.lake = opts.lake || resolveLake(opts.seed ?? 20240711).lake;
    this.seed = this.lake.seed;
    this.noise = this.lake.noise;
    this.hole = this.lake.hole;
    this.flat = this.lake.flat;
    this.dockAngle = this.lake.dock.angle;
    this._q = makeQueries(this.lake);

    /* ---- 桟橋（位置は lakefield が決定・検証済み） ---- */
    const d = makeDock(this.lake);
    this._dockU = d._dockU;
    this._dockLen = d._dockLen;
    this.shoreR0 = d.shoreR0;
    this.dockDir = v3(d.dockDir);      // 岸→湖心
    this.dockStart = v3(d.dockStart);
    this.dockEnd = v3(d.dockEnd);
    this.dockY = d.dockY;
    this.spawnPos = v3(d.spawnPos);

    /* ---- 当たり：placement から全品質で同じものを積む ---- */
    this._grid = new ObstacleGrid();
    this.obstacles = this._grid.obstacles;      // [x, z, r, top, ...]（debug.js が読む）
    this._obsGrid = this._grid._obsGrid;
    /** 水中ストラクチャー（top = 湖底 + h）。structureNear と図鑑が見る */
    this.structures = this._q.structures;
    this.placement = buildPlacement(this.lake, this._q);
    const obs = obstacleList(this.placement, this._q);
    for (let i = 0; i < obs.length; i += 4) this.addObstacle(obs[i], obs[i + 1], obs[i + 2], obs[i + 3]);
    this.collisionHash = collisionHash(this.placement, this._q);
    this.treeCount = this.placement.trees.count;

    /* ---- 互換のための空の入れ物（game.js が除外リストや表示の切り替えに使う） ---- */
    /** 1 回描画のパイプラインでは水越しの除外が要らないので空 */
    this.overWaterProps = [];
    /** 水上で visible=false にされる。実物は NG_LAYER.UNDERWATER に居るのでここは空のまま */
    this.underwaterProps = { group: new THREE.Group(), activeCounts: { weeds: 0, pebbles: 0, debris: 0 } };
    this.underwaterProps.group.name = 'underwater-props-compat';
    scene.add(this.underwaterProps.group);
    this.waterPlants = { submergedMeshes: [] };
    this.lodScale = 1;
    this._shore = { time: 0, wind: 1 };
    this._windPow = 1;

    /* ---- 高さ場（Worker）と描画の初期化 ---- */
    this.grids = null;
    this._heightTex = null;
    /* opts.grids：作り済みの格子（か、その Promise）を渡せる。false で作らない（Node のテスト用） */
    const gridsSrc = opts.grids === false ? Promise.resolve(null)
      : opts.grids ? Promise.resolve(opts.grids)
        : buildHeightGrids(this.lake, { resolvedSeed: this.lake.seed, workers: 4 });
    this._gridsPromise = gridsSrc
      .then((g) => { this.grids = g || null; return this.grids; })
      .catch((e) => { warnOnce('高さ場の格子を作れませんでした', e); return null; });
    /** game.js が作った caustics の uniform（湖底・魚・水中の物で共有。core に同じ参照を渡す） */
    this.causticsUniforms = opts.causticsUniforms || null;
    const gfx = this.gfx;
    let attach = null;
    try {
      if (opts.renderer) gfx?.attachRenderer?.(opts.renderer);
      attach = gfx?.attachWorld?.({
        lake: this.lake, terrain: this, placement: this.placement, grids: this._gridsPromise,
        progress: opts.progress || null, caustics: this.causticsUniforms,
      }) || null;
    } catch (e) {
      warnOnce('attachWorld が失敗、当たりと問い合わせだけで続行します', e);
      attach = null;
    }
    /** 描画の準備（地形の素材・木・下草…）。失敗しても resolve する（game.js の build を止めない） */
    this.ready = Promise.all([
      this._gridsPromise,
      Promise.resolve(attach).catch((e) => { warnOnce('attachWorld の初期化に失敗', e); }),
    ]).then(() => undefined, (e) => { warnOnce('ready', e); });
  }

  get gfx() {
    try { return getGfx() || null; } catch (e) { return null; }
  }

  /**
   * 高さ場（near 1040² @0.5m、R32F・Nearest）。core の heightfield が持っていればそれを、
   * 無ければ格子から DataTexture を作る（アップロードは使われたときだけ）。
   */
  get heightTexture() {
    const hf = this.gfx?.heightfield;
    const t = hf?.uniforms?.ngHeightNear?.value || null;
    if (t) return t;
    if (!this._heightTex && this.grids?.near) {
      const g = this.grids.near;
      const tex = new THREE.DataTexture(g.data, g.n, g.n, THREE.RedFormat, THREE.FloatType);
      tex.magFilter = tex.minFilter = THREE.NearestFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this._heightTex = tex;
    }
    return this._heightTex;
  }

  /* ---------------- 読み込み（旧 API。外部テクスチャはもう無い） ---------------- */
  /* 画像は読まない（素材はすべて起動時に GPU で合成する）。代わりに高さ場の Worker を
     早めに起こしておく（lakefield の import と JIT の温まりを Lake の段に重ねる） */
  static loadBedTextures() { prewarmHeightWorkers(); return Promise.resolve(null); }
  static loadDockTextures() { prewarmHeightWorkers(); return Promise.resolve(null); }
  static loadLandTextures() { prewarmHeightWorkers(); return Promise.resolve(null); }
  static loadLeafTextures() { prewarmHeightWorkers(); return Promise.resolve(null); }

  /* ---------------- 高さ関数（lakefield へ委譲。旧版と同じ式） ---------------- */
  shoreRadius(x, z) { return this.lake.shoreRadius(x, z); }
  heightAt(x, z) { return this.lake.heightAt(x, z); }

  depthAt(x, z) {
    return Math.max(0, -this.heightAt(x, z));
  }

  isWater(x, z) {
    return this.heightAt(x, z) < 0;
  }

  normalAt(x, z, e = 0.7) {
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
  }

  slopeAt(x, z, e = 1.2) {
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    const dx = (hR - hL) / (2 * e), dz = (hU - hD) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** 底質（'mud' | 'sand' | 'rock'） */
  bedAt(x, z) { return this.lake.bedAt(x, z); }

  /** 水中ストラクチャーが近くにあるか（あれば一番近いものを返す） */
  structureNear(x, z, radius = 4.5) {
    return this._q.structureNear(x, z, radius);
  }

  /* ---------------- 桟橋 ---------------- */
  /** 桟橋ローカル座標（along: 岸→沖 / side: 右） */
  _dockLocal(x, z, out = { al: 0, si: 0 }) { return dockLocal(this, x, z, out); }
  /** 桟橋の床の上なら dockY（矩形判定） */
  onDock(x, z) { return onDock(this, x, z); }
  /** 桟橋の中心線までの距離 */
  distToDock(x, z) { return distToDock(this, x, z); }
  /** 線分が桟橋（床＋先端の手すり）を貫通するか */
  dockBlocksSegment(x0, y0, z0, x1, y1, z1) { return dockBlocksSegment(this, x0, y0, z0, x1, y1, z1); }

  /* ---------------- 障害物 ---------------- */
  /** @param top 上端の高さ（糸の判定に使う） */
  addObstacle(x, z, r, top = 0) { this._grid.add(x, z, r, top); }
  /** (x,z) が半径 rad の円として障害物にぶつかるか。y を渡すと «その高さより上まである» ものだけ */
  blockedAt(x, z, rad = 0.32, y) { return this._grid.blockedAt(x, z, rad, y); }
  /** (x,z) を覆っている障害物の上端の最大値（無ければ -Infinity） */
  obstacleTopAt(x, z) { return this._grid.obstacleTopAt(x, z); }
  /**
   * 糸（竿先 → 到達点）が地形や岩を貫通するか。
   * @returns {null|{x:number,y:number,z:number,ground:number,kind:string}}
   */
  lineBlocked(x0, y0, z0, x1, y1, z1, opts = {}) { return lineBlocked(this, x0, y0, z0, x1, y1, z1, opts); }

  /* ---------------- 描画のフック（中身はモジュールへ。例外は外へ出さない） ---------------- */
  /** 見た目の風（時刻と天候の純関数。windPow は記録だけ） */
  updateWind(time, windPow = 1) {
    this._windPow = windPow;
    try { this.gfx?.wind?.update?.(time, windPow); } catch (e) { warnOnce('updateWind', e); }
  }

  /** 全モジュールの CPU 更新（LOD の選び直し・インスタンスの詰め直し） */
  updateTrees(dt, cameraPos) {
    try { this.gfx?.updateModules?.({ dt, camPos: cameraPos }); } catch (e) { warnOnce('updateTrees', e); }
  }

  /** 灯籠（dt で damp するのでポーズで止まる） */
  updateLamp(nightAmount, dt) {
    try { this.gfx?.services?.hardscape?.setLamp?.(nightAmount, dt); } catch (e) { warnOnce('updateLamp', e); }
  }

  /** 水草・プランクトンの流れ */
  updateUnderwaterProps(time, camera, flowDir, flowStrength) {
    try { this.gfx?.setFlow?.(flowDir, flowStrength); } catch (e) { warnOnce('updateUnderwaterProps', e); }
  }

  /** 渚：水面と同じ時刻・風速（水の時刻は ngFrame に core が書くので記録だけ） */
  updateShore(time, wind) {
    this._shore.time = time;
    this._shore.wind = wind;
  }

  setQuality(q) {
    this.quality = q;
    try { this.gfx?.setQuality?.(q); } catch (e) { warnOnce('setQuality', e); }
  }

  /**
   * 近景の範囲を一括で伸縮する（負荷の確認用）。__game.terrain.setLodScale(1.5)
   * @param {number} scale
   */
  setLodScale(scale = 1) {
    const k = Math.max(0.1, Math.min(4, scale));
    this.lodScale = k;
    try { this.gfx?.setLodScale?.(k); } catch (e) { warnOnce('setLodScale', e); }
    return k;
  }
}
