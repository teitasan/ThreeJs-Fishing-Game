/* ===========================================================
   hardscape モジュール（ARCHITECTURE §6.8）
   -----------------------------------------------------------
   - 桟橋：契約の寸法（床幅 3.4m・上面 = dockY・杭 2.4m・先端 2.3m の手すり）。床板 1 枚ずつ（幅・反り・隙間 1.5cm・色むら）、
     forge の杉材（木目・節・干割れ・灰銀の風化）、釘の錆、杭の水線下の藻、雨の濡れと水たまり。木部は 1 本の幾何 = 1 ドロー
   - 灯籠：r 0.26・上端 dockY + 2.3。和紙の 2200K の発光に 1/f の揺らぎ、PointLight（リグの lamp を置くだけ）、夜に蛾
   - 小舟：木の和船と係留の縄。上下・ピッチ・ロールは waveField の同じ関数（舳先・艫・両舷の 4 点）
   - 岩：8 形 × 3 LOD（icosphere → 塊 → 節理の柔らかい欠け → 底 → 細部、窪みの AO）、triplanar の花崗岩 / 安山岩、
     上向きの面に苔（森の中と水辺で厚く）、水線 ±0.3m の濡れと藻、水中のシルト。placement の boulders / cobbles
   - ストラクチャー：沈み岩と立ち枯れを lake.structures の x, z, rot, h, r に正確に（UNDERWATER 層）。流木（placement.driftwood）
   - services.hardscape.piles（杭の円）と water.addDamper
   プログラム 3 本：hs-wood・hs-rock（instanced）・hs-moth（instanced）
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG_LAYER, ngOwn } from '../core/layers.js';
import { NG_PASS } from '../core/frame.js';
import { ngExtendStandard } from '../core/extend.js';
import { makeDock, dockFixtures } from '../../world/dock.js';
import { TIER_DENSITY } from '../../world/placement.js';
import { mulberry32, stream, hash01 } from '../../world/rng.js';
import { waveHeight, shoalGain } from '../../waveField.js?v=20260828-lakescale1';
import { ngBlackbody } from '../post/grade.js';
import { GeoBuilder, WOOD_KIND, tubePositions } from './geo.js';
import { buildDock, DOCK_DIM, dockContractReport } from './dock.js';
import { buildBoat, BOAT_DIM, boatContractReport, boatBottomY, boatBottomB } from './boat.js';
import { buildRockShapes, ROCK_SHAPES } from './rocks.js';
import { addSnag, addDriftwood } from './logs.js';
import { bakeHardscapeTextures } from './textures.js';
import { hsTier, lampFlicker } from './quality.js';
import {
  WOOD_VERT_PARS, WOOD_VERT_BEGIN, WOOD_FRAG_PARS, WOOD_FRAG_SURFACE, WOOD_FRAG_NORMAL, WOOD_FRAG_EMISSIVE, CAV_FRAG_AO,
  ROCK_VERT_PARS, ROCK_VERT_BEGIN, ROCK_FRAG_PARS, ROCK_FRAG_SURFACE, ROCK_FRAG_NORMAL,
} from './shaders.js';

/** 灯籠の点光源（ng 単位の光度。真下の床 2m で ≈0.3 ng = 月の 25 倍） */
const LAMP_I = 1.25;
/** 和紙の発光の放射輝度（露出前。夜の露出 ≈22 で ≈5 = AgX で白に近い暖色） */
const LAMP_EMIT = 0.24;
const ROPE_N = 22, ROPE_SEGS = 6, ROPE_R = 0.011;

export class HardscapeModule extends NgModule {
  static id = 'hardscape';

  constructor(ctx) {
    super(ctx);
    this.lamp = 0;
    this.piles = [];
    this.cfg = hsTier(ctx.tier);
    this.tier = ctx.tier || 'high';
    this._t = 0;
    this._flick = 1;
    this._bucketAt = null;
    this._draws = 0;
    this._rockMeshes = [];
    this._cobbleMeshes = [];
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE, lake = ctx.lake;
    if (!lake) { progress?.(1); return; }
    const seed = (lake.seed ?? 123456789) >>> 0;
    this.seed = seed;
    const hf = ctx.heightfield;
    const groundAt = (x, z) => (hf?.ready ? hf.heightAt(x, z) : lake.heightAt(x, z));
    this._groundAt = groundAt;

    /* ---- テクスチャ（forge） ---- */
    this.tex = await bakeHardscapeTextures(ctx.forge, T);
    progress?.(0.15);

    /* ---- 桟橋の座標系（当たりと同じ式） ---- */
    const D = makeDock(lake), fx = dockFixtures(D);
    this.dock = D; this.fx = fx;
    const P = ctx.placement;
    const lamp = P?.lamp || fx.lamp, boat0 = P?.boat || fx.boat;
    /* 小舟の向きは当たりの円 2 つの軸に揃える（placement の yaw = 桟橋 + 0.25rad のままだと 3.4m の船の両端が円から 19cm 出る。
       係留した舟は桟橋に沿う方が自然でもある）。位置は placement のまま */
    const cc = boat0.circles || [];
    const boatP = { ...boat0, yaw: cc.length === 2 ? Math.atan2(cc[1].x - cc[0].x, cc[1].z - cc[0].z) : boat0.yaw };
    this.lampPos = lamp; this.boatP = boatP;
    /* 浜に引き揚げた舟：placement の位置が陸（シードによっては浅瀬の手前）だと、y=0.05 の舟の腹が砂に埋まる。
       竜骨の下の地面に載せ、地面の傾きに沿わせ、少し片舷へ傾ける（当たりの円は placement のまま） */
    this._beach = this._beachPose(boatP, groundAt);
    if (this._beach) boatP.y = this._beach.y;

    /* ---- マテリアル ---- */
    const u = {
      ngHsDock: { value: new T.Vector4(D.dockStart.x, D.dockStart.z, fx.right.x, fx.right.z) },
      ngHsDock2: { value: new T.Vector4(fx.dir.x, fx.dir.z, D.dockY, D._dockLen) },
      ngHsLamp: { value: new T.Vector4(0, 0, 0, 0) },
    };
    this.u = u;
    const wood = new T.MeshStandardMaterial({ map: this.tex.woodA, normalMap: this.tex.woodN, roughness: 1, metalness: 0 });
    wood.normalScale.set(1, 1);
    this.woodMat = ngExtendStandard(wood, {
      key: 'hs-wood', module: 'hardscape', uniforms: u,
      vertex: { pars: WOOD_VERT_PARS, begin: WOOD_VERT_BEGIN },
      fragment: { pars: WOOD_FRAG_PARS, surface: WOOD_FRAG_SURFACE, normal: WOOD_FRAG_NORMAL, emissive: WOOD_FRAG_EMISSIVE, ao: CAV_FRAG_AO },
      caustics: true, hfShadow: true,
    });
    this.rockMat = ngExtendStandard(new T.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }), {
      key: 'hs-rock', module: 'hardscape', uniforms: { ngRockA: { value: this.tex.rockA }, ngRockN: { value: this.tex.rockN } },
      vertex: { pars: ROCK_VERT_PARS, begin: ROCK_VERT_BEGIN },
      fragment: { pars: ROCK_FRAG_PARS, surface: ROCK_FRAG_SURFACE, normal: ROCK_FRAG_NORMAL, ao: CAV_FRAG_AO },
      caustics: true, hfShadow: true,
    });
    this.mothMat = ngExtendStandard(new T.MeshStandardMaterial({ color: new T.Color().setRGB(0.42, 0.37, 0.29), roughness: 0.85, metalness: 0, side: T.DoubleSide }), {
      key: 'hs-moth', module: 'hardscape',
    });

    const world = new T.Group(); world.name = 'hs-world';
    const under = new T.Group(); under.name = 'hs-under';
    this.world = world; this.under = under;

    /* ---- 桟橋・灯籠 ---- */
    const dk = buildDock({ start: D.dockStart, dir: fx.dir, right: fx.right, L: D._dockLen, Y: D.dockY, lamp, groundAt, seed });
    this.piles = dk.piles.map((p) => ({ x: p.x, z: p.z, r: p.r }));
    this._pileFull = dk.piles;
    this.lampLight = dk.lampLight;
    /* 係留：小舟の舳先に最も近い杭に縄を巻く */
    const rnd = mulberry32(stream(seed, 'hardscape-misc'));
    const bowW = this._boatLocalToWorld(BOAT_DIM.BOW_CLEAT, { y: boatP.y, pitch: 0, roll: 0 });
    let best = null, bd = Infinity;
    for (const p of dk.piles) { const d = Math.hypot(p.x - bowW[0], p.z - bowW[2]); if (d < bd) { bd = d; best = p; } }
    this.ropePile = best;
    if (best) {
      const ay = D.dockY - 0.62;
      const ring = [];
      for (let i = 0; i <= 16; i++) {
        const th = (i / 16) * Math.PI * 2;
        ring.push([best.x + Math.cos(th) * (best.r + 0.012), ay + 0.012 * Math.sin(th * 3), best.z + Math.sin(th) * (best.r + 0.012)]);
      }
      dk.geo.tube(ring, ROPE_R * 1.1, ROPE_SEGS, [WOOD_KIND.ROPE, 0.5, 0, 0], true);
      const dx = bowW[0] - best.x, dz = bowW[2] - best.z, dl = Math.hypot(dx, dz) || 1;
      this.ropeA = [best.x + (dx / dl) * (best.r + 0.02), ay, best.z + (dz / dl) * (best.r + 0.02)];
    }
    this.dockGeo = dk.geo.toGeometry(T);
    this.dockMesh = new T.Mesh(this.dockGeo, this.woodMat);
    this.dockMesh.name = 'hs-dock';
    this.dockMesh.castShadow = this.dockMesh.receiveShadow = true;
    world.add(this.dockMesh);
    await ctx.forge.step();
    progress?.(0.3);

    /* ---- 小舟と縄 ---- */
    const bg = buildBoat(rnd);
    this.boatGeo = bg.toGeometry(T);
    this.boatLocal = bg;
    this.boat = new T.Mesh(this.boatGeo, this.woodMat);
    this.boat.name = 'hs-boat';
    this.boat.position.set(boatP.x, boatP.y, boatP.z);
    this.boat.rotation.set(0, boatP.yaw, 0, 'YXZ');
    this.boat.castShadow = this.boat.receiveShadow = true;
    this.boat.userData.base = { x: boatP.x, y: boatP.y, z: boatP.z, yaw: boatP.yaw };
    world.add(this.boat);
    if (this.ropeA) {
      const rg = new GeoBuilder();
      this._ropePts = Array.from({ length: ROPE_N }, () => [0, 0, 0]);
      this._ropeFill(bowW);
      rg.tube(this._ropePts, ROPE_R, ROPE_SEGS, [WOOD_KIND.ROPE, 0.6, 0, 0]);
      this.ropeGeo = rg.toGeometry(T);
      this.ropeGeo.attributes.position.setUsage(T.DynamicDrawUsage);
      this.ropeGeo.attributes.normal.setUsage(T.DynamicDrawUsage);
      this.rope = new T.Mesh(this.ropeGeo, this.woodMat);
      this.rope.name = 'hs-rope';
      this.rope.frustumCulled = false;
      this.rope.castShadow = true; this.rope.receiveShadow = true;
      world.add(this.rope);
    }
    await ctx.forge.step();

    /* ---- 岩の形（8 × 3 LOD） ---- */
    this.shapes = buildRockShapes(seed);
    await ctx.forge.step();
    this.rockGeos = this.shapes.map((s) => s.lods.map((l) => {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(l.pos, 3));
      g.setAttribute('normal', new T.BufferAttribute(l.nrm, 3));
      g.setAttribute('ngRockV', new T.BufferAttribute(l.rv, 2));
      g.setIndex(new T.BufferAttribute(l.idx, 1));
      g.computeBoundingSphere();
      return g;
    }));
    progress?.(0.5);

    /* ---- ストラクチャー（UNDERWATER）：沈み岩と立ち枯れ ---- */
    this._buildStructures(under);
    await ctx.forge.step();
    progress?.(0.6);

    /* ---- 蛾 ---- */
    const mg = new T.BufferGeometry();
    mg.setAttribute('position', new T.Float32BufferAttribute([0, 0, 0, -0.018, 0.004, -0.008, -0.016, 0.002, 0.01, 0, 0, 0, 0.018, 0.004, -0.008, 0.016, 0.002, 0.01], 3));
    mg.setAttribute('normal', new T.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    this.moths = new T.InstancedMesh(mg, this.mothMat, 16);
    this.moths.name = 'hs-moths';
    this.moths.frustumCulled = false;
    this.moths.count = 0;
    this.moths.visible = false;
    world.add(this.moths);
    this._mothSeed = Array.from({ length: 16 }, (_, i) => [hash01(seed, i, 1), hash01(seed, i, 2), hash01(seed, i, 3), hash01(seed, i, 4)]);

    ngOwn(world, NG_LAYER.WORLD);
    ngOwn(under, NG_LAYER.UNDERWATER);
    this.root.add(world, under);
    this.root.userData.ngOwned = true;

    /* 岩・流木（段に依る部分集合）は setQuality で作る。起動時は ctx.tier で 1 回 */
    this._fillTier(this.tier);
    ctx.scene.add(this.root);
    ctx.services.provide('hardscape', { piles: this.piles, setLamp: (n, dt) => this.setLamp(n, dt) });
    ctx.services.water.addDamper(this.piles);
    this._lampColor = ngBlackbody(2200);
    progress?.(1);
  }

  /* 竜骨の下（艫〜舳先 9 点 × 3 列）の地面と船底の差から、浜に載った姿勢を出す。水に浮くなら null */
  _beachPose(b, groundAt) {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const W = (lx, lz) => [b.x + lx * c + lz * s, b.z - lx * s + lz * c];
    let need = -Infinity, gF = 0, gA = 0, gP = 0, gS = 0;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, lz = (t * 2 - 1) * BOAT_DIM.HALF_L, bot = boatBottomY(t), hb = boatBottomB(t);
      for (const lx of [-hb, 0, hb]) {
        const [x, z] = W(lx, lz), g = groundAt(x, z);
        if (Number.isFinite(g)) need = Math.max(need, g - bot);
      }
    }
    if (!(need > b.y + 0.02)) return null;
    const L = BOAT_DIM.HALF_L * 0.8;
    { const [x, z] = W(0, L); gF = groundAt(x, z); }
    { const [x, z] = W(0, -L); gA = groundAt(x, z); }
    { const [x, z] = W(-0.4, 0); gP = groundAt(x, z); }
    { const [x, z] = W(0.4, 0); gS = groundAt(x, z); }
    const pitch = Math.atan2(gF - gA, 2 * L), roll = Math.atan2(gS - gP, 0.8) + 0.07;
    /* 砂に 5cm めり込ませる（宙に浮かない） */
    return { y: need - 0.05, pitch: -Math.max(-0.2, Math.min(0.2, pitch)), roll: Math.max(-0.25, Math.min(0.25, roll)) };
  }

  /* 船の座標 → 世界（休止の姿勢 + heave / pitch / roll） */
  _boatLocalToWorld(p, pose) {
    const b = this.boatP, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch), cr = Math.cos(pose.roll), sr = Math.sin(pose.roll);
    /* YXZ：R = Ry · Rx · Rz */
    let x = p[0] * cr - p[1] * sr, y = p[0] * sr + p[1] * cr, z = p[2];
    const y2 = y * cp - z * sp, z2 = y * sp + z * cp;
    y = y2; z = z2;
    return [b.x + x * c + z * s, pose.y + y, b.z - x * s + z * c];
  }

  /* 縄の点（杭 → 舳先、たるみ 0.2m の放物線）を _ropePts に */
  _ropeFill(bow) {
    const a = this.ropeA, pts = this._ropePts;
    const len = Math.hypot(bow[0] - a[0], bow[1] - a[1], bow[2] - a[2]);
    const sag = 0.08 + 0.06 * len;
    for (let i = 0; i < ROPE_N; i++) {
      const t = i / (ROPE_N - 1);
      pts[i][0] = a[0] + (bow[0] - a[0]) * t;
      pts[i][1] = a[1] + (bow[1] - a[1]) * t - sag * 4 * t * (1 - t);
      pts[i][2] = a[2] + (bow[2] - a[2]) * t;
    }
  }

  _buildStructures(g) {
    const T = this.ctx.THREE, lake = this.ctx.lake, S = lake.structures || [];
    const sb = new GeoBuilder();
    const rocks = [];
    this._structReport = [];
    S.forEach((s, i) => {
      const bed = lake.heightAt(s.x, s.z);   // 当たりの高さ（obstacleList と同じ）
      if (s.kind === 'snag') {
        const r = addSnag(sb, s, bed, this.seed, i);
        this._structReport.push({ kind: 'snag', i, r: s.r, h: s.h, top: r.top, wantTop: bed + s.h, maxR: r.maxR });
      } else {
        rocks.push({ s, bed, shape: Math.floor(hash01(this.seed, i, 77) * ROCK_SHAPES) % ROCK_SHAPES });
        this._structReport.push({ kind: 'rock', i, r: s.r, h: s.h, top: bed + s.h, wantTop: bed + s.h, maxR: s.r });
      }
    });
    if (sb.count) {
      this.snagMesh = new T.Mesh(sb.toGeometry(T), this.woodMat);
      this.snagMesh.name = 'hs-snags';
      this.snagMesh.receiveShadow = true;
      g.add(this.snagMesh);
    }
    /* 沈み岩：形ごとの InstancedMesh（LOD0） */
    const byShape = new Map();
    for (const r of rocks) { if (!byShape.has(r.shape)) byShape.set(r.shape, []); byShape.get(r.shape).push(r); }
    const m = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), v = new T.Vector3(), sc = new T.Vector3();
    for (const [k, list] of byShape) {
      const geo = this._instGeo(this.rockGeos[k][0], list.length);
      const im = new T.InstancedMesh(geo, this.rockMat, list.length);
      im.name = `hs-struct-rock-${k}`;
      const info = geo.attributes.ngRockI.array;
      list.forEach((r, j) => {
        const s = r.s;
        q.setFromEuler(e.set(0, s.rot, 0));
        m.compose(v.set(s.x, r.bed - 0.12 * s.h, s.z), q, sc.set(s.r, 1.12 * s.h, s.r * 0.85));
        im.setMatrixAt(j, m);
        info.set([hash01(this.seed, j, k) < 0.6 ? 0 : 1, 0, hash01(this.seed, j, k + 9), 0], j * 4);
      });
      im.receiveShadow = true;
      im.computeBoundingSphere();
      g.add(im);
    }
  }

  /* 形の幾何を共有し、インスタンスの属性（ngRockI）だけ自分の物にした幾何 */
  _instGeo(src, cap) {
    const T = this.ctx.THREE;
    const g = new T.BufferGeometry();
    for (const k of ['position', 'normal', 'ngRockV']) g.setAttribute(k, src.attributes[k]);
    g.setIndex(src.index);
    g.boundingSphere = src.boundingSphere;
    const a = new T.InstancedBufferAttribute(new Float32Array(Math.max(1, cap) * 4), 4);
    a.setUsage(T.DynamicDrawUsage);
    g.setAttribute('ngRockI', a);
    return g;
  }

  /* 段に依る部分集合：岩（boulders / cobbles）の候補と、流木 */
  _fillTier(tier) {
    const ctx = this.ctx, T = ctx.THREE, P = ctx.placement, lake = ctx.lake;
    this.tier = tier;
    this.cfg = hsTier(tier);
    for (const im of [...this._rockMeshes.flat(), ...this._cobbleMeshes.flat()]) { if (im) { this.world.remove(im); im.geometry.dispose(); im.dispose(); } }
    const dB = TIER_DENSITY.boulders[tier] ?? 1, dC = TIER_DENSITY.cobbles[tier] ?? 1, dD = TIER_DENSITY.driftwood[tier] ?? 1;
    const inland = (x, z) => Math.hypot(x, z) - lake.shoreAtAngle(Math.atan2(z, x));
    const prep = (b, i, kind) => {
      const r = 0.4 * b.size;
      const d = inland(b.x, b.z);
      const moss = Math.min(1, 0.2 + 0.55 * smooth(6, 40, d) + 0.35 * (1 - smooth(0, 6, Math.abs(d))) + 0.25 * hash01(this.seed, i, kind + 3));
      return {
        x: b.x, y: b.y, z: b.z, size: b.size, shape: (b.shape | 0) % ROCK_SHAPES,
        m: new T.Matrix4().compose(new T.Vector3(b.x, b.y, b.z), new T.Quaternion().setFromEuler(new T.Euler(0, b.rot, 0)), new T.Vector3(r * b.sx, b.size * b.sy, r * b.sz)),
        info: [hash01(this.seed, i, kind) < 0.55 ? 0 : 1, moss, hash01(this.seed, i, kind + 1), 0],
      };
    };
    this._boulders = (P?.boulders || []).filter((b) => b.collide || b.rank < dB).map((b, i) => prep(b, i, 11));
    this._cobbles = (P?.cobbles || []).filter((b) => b.rank < dC).map((b, i) => prep(b, i, 21));
    const mk = (list, lods, name, shadowLods) => {
      const cnt = new Array(ROCK_SHAPES).fill(0);
      for (const r of list) cnt[r.shape]++;
      return Array.from({ length: ROCK_SHAPES }, (_, k) => lods.map((lod) => {
        if (!cnt[k]) return null;
        const im = new T.InstancedMesh(this._instGeo(this.rockGeos[k][lod], cnt[k]), this.rockMat, cnt[k]);
        im.name = `${name}-${k}-${lod}`;
        im.count = 0; im.visible = false;
        im.castShadow = shadowLods.includes(lod); im.receiveShadow = true;
        im.instanceMatrix.setUsage(T.DynamicDrawUsage);
        ngOwn(im, NG_LAYER.WORLD);
        this.world.add(im);
        return im;
      }));
    };
    this._rockMeshes = mk(this._boulders, [0, 1, 2], 'hs-boulder', [0, 1]);
    this._cobbleMeshes = mk(this._cobbles, [1, 2], 'hs-cobble', [1]);
    this._bucketAt = null;

    /* 流木（1 本の幾何） */
    if (this.driftMesh) { this.world.remove(this.driftMesh); this.driftMesh.geometry.dispose(); this.driftMesh = null; }
    const dg = new GeoBuilder();
    (P?.driftwood || []).forEach((d, i) => { if (d.rank < dD) addDriftwood(dg, d, this._groundAt, this.seed, i); });
    if (dg.count) {
      this.driftMesh = new T.Mesh(dg.toGeometry(T), this.woodMat);
      this.driftMesh.name = 'hs-driftwood';
      this.driftMesh.castShadow = this.driftMesh.receiveShadow = true;
      ngOwn(this.driftMesh, NG_LAYER.WORLD);
      this.world.add(this.driftMesh);
    }
  }

  /* 岩の LOD の振り分け（カメラが 3m 動くたび） */
  _bucket(cx, cz) {
    const cfg = this.cfg;
    const fill = (list, meshes, isCobble) => {
      for (const row of meshes) for (const im of row || []) if (im) im.count = 0;
      for (const r of list) {
        const d = Math.hypot(r.x - cx, r.z - cz) / Math.max(0.55, Math.sqrt(r.size));
        let lod;
        if (isCobble) {
          if (Math.hypot(r.x - cx, r.z - cz) > cfg.cobbleCull) continue;
          lod = d < cfg.lod0 ? 0 : 1;      // cobbles の列は [LOD1, LOD2]
        } else lod = d < cfg.lod0 ? 0 : d < cfg.lod1 ? 1 : 2;
        const im = meshes[r.shape]?.[lod];
        if (!im) continue;
        const j = im.count++;
        im.instanceMatrix.array.set(r.m.elements, j * 16);
        im.geometry.attributes.ngRockI.array.set(r.info, j * 4);
      }
      for (const row of meshes) {
        for (const im of row || []) {
          if (!im) continue;
          im.visible = im.count > 0;
          if (!im.visible) continue;
          im.instanceMatrix.needsUpdate = true;
          im.geometry.attributes.ngRockI.needsUpdate = true;
          im.boundingSphere = null;
        }
      }
    };
    fill(this._boulders, this._rockMeshes, false);
    fill(this._cobbles, this._cobbleMeshes, true);
  }

  update(f) {
    const dt = Math.max(0, Number.isFinite(f.dt) ? f.dt : 0);
    this._t += dt;
    this._flick = lampFlicker(this._t);
    this._updateMoths();
  }

  prepare(f) {
    /* 小舟：waveField の同じ関数（4 点）で上下・ピッチ・ロール（水の値は prepare で受ける） */
    const b = this.boat;
    if (b) {
      const o = b.userData.base, lake = this.ctx.lake;
      const t = f.waterTime || 0, w = Number.isFinite(f.waterWind) ? f.waterWind : 1;
      const H = (lx, lz) => {
        const p = this._boatLocalToWorld([lx, 0, lz], { y: 0, pitch: 0, roll: 0 });
        const g = shoalGain(Math.max(0, lake.depthAt(p[0], p[2])));
        return waveHeight(p[0], p[2], t, w) * g;
      };
      const hb = H(0, 1.25), hs = H(0, -1.25), hp = H(-0.45, 0), hst = H(0.45, 0);
      const heave = (hb + hs + hp + hst) * 0.25;
      const pitch = Math.atan2(hb - hs, 2.5), roll = Math.atan2(hst - hp, 0.9);
      if (this._beach) {
        const B = this._beach;
        if (!this._pose) {
          b.position.y = B.y;
          b.rotation.set(B.pitch, o.yaw, B.roll, 'YXZ');
          this._pose = { y: B.y, pitch: B.pitch, roll: B.roll };
        }
      } else if (Number.isFinite(heave) && Number.isFinite(pitch) && Number.isFinite(roll)) {
        b.position.y = o.y + heave;
        b.rotation.set(-pitch * 0.85, o.yaw, roll * 0.85, 'YXZ');
        this._pose = { y: o.y + heave, pitch: -pitch * 0.85, roll: roll * 0.85 };
      }
      if (this.rope && this._pose) {
        const bow = this._boatLocalToWorld(BOAT_DIM.BOW_CLEAT, this._pose);
        this._ropeFill(bow);
        const pa = this.ropeGeo.attributes.position, na = this.ropeGeo.attributes.normal;
        tubePositions(pa.array, this._ropePts, ROPE_R, ROPE_SEGS, false, na.array);
        pa.needsUpdate = true; na.needsUpdate = true;
      }
    }
    /* 岩の LOD */
    const c = f.camPos;
    if (c && (!this._bucketAt || Math.hypot(c.x - this._bucketAt[0], c.z - this._bucketAt[1]) > 3)) {
      this._bucketAt = [c.x, c.z];
      this._bucket(c.x, c.z);
    }
  }

  beforePass(passId) {
    /* 反射：小石と蛾は写さない（数 px 未満・反射の LOD +1 の代わり） */
    const refl = passId === NG_PASS.REFLECTION;
    for (const row of this._cobbleMeshes) for (const im of row || []) if (im) im.visible = !refl && im.count > 0;
    if (this.moths) this.moths.visible = !refl && this.moths.count > 0;
  }

  _updateMoths() {
    const ms = this.moths;
    if (!ms) return;
    const on = this.lamp > 0.35;
    const n = on ? Math.min(16, this.cfg.moths) : 0;
    ms.count = n;
    ms.visible = n > 0;
    if (!n) return;
    const T = this.ctx.THREE, c = this.lampLight;
    const m = this._mm || (this._mm = new T.Matrix4());
    const q = this._mq || (this._mq = new T.Quaternion());
    const e = this._me || (this._me = new T.Euler());
    const p = this._mp || (this._mp = new T.Vector3());
    const s = this._ms || (this._ms = new T.Vector3());
    const t = this._t;
    for (let i = 0; i < n; i++) {
      const [a, b, cc, d] = this._mothSeed[i];
      const r = 0.22 + 0.4 * a;
      const w1 = 0.7 + 1.3 * b, w2 = 1.1 + 1.7 * cc;
      const th = t * w1 + a * 6.28 + 0.6 * Math.sin(t * 3.1 * w2 + d * 6.0);
      const x = c[0] + Math.cos(th) * r + 0.06 * Math.sin(t * 7.3 + i);
      const z = c[2] + Math.sin(th * 1.13) * r * 0.9;
      const y = c[1] + 0.05 + 0.28 * Math.sin(t * w2 * 0.8 + b * 6.0) + 0.05 * Math.sin(t * 11.0 + a * 9.0);
      const flap = 0.25 + 0.75 * Math.abs(Math.sin(t * (38 + 20 * d) + i));
      q.setFromEuler(e.set(0.3 * Math.sin(t * 5 + i), -th, 0));
      m.compose(p.set(x, y, z), q, s.set(flap, 1, 1));
      ms.setMatrixAt(i, m);
    }
    ms.instanceMatrix.needsUpdate = true;
  }

  /**
   * 灯籠（Terrain.updateLamp）。dt で damp、ポーズ（dt = 0）で止まる
   * @param {number} night
   * @param {number} dt
   */
  setLamp(night, dt) {
    const nn = Number.isFinite(night) ? night : 0;
    const d = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const target = smooth(0.3, 0.7, nn);
    /* 撮影中（__gfxCapture：時間が止まり dt = 0）は目標へ即座に（撮影の再現性。post の水中の係数と同じ扱い） */
    if (globalThis.__gfxCapture) this.lamp = target;
    else this.lamp += (target - this.lamp) * (1 - Math.exp(-d * 2));
    const L = this.lamp * this._flick;
    const col = this._lampColor || [1, 0.54, 0.18];
    const light = this.ctx.gfx?.rig?.lamp;
    if (light && this.lampLight) {
      light.position.set(this.lampLight[0], this.lampLight[1], this.lampLight[2]);
      light.color.setRGB(col[0], col[1], col[2]);
      light.intensity = LAMP_I * L;
      light.distance = 30;
      light.decay = 2;
    }
    if (this.u) this.u.ngHsLamp.value.set(col[0] * LAMP_EMIT * L, col[1] * LAMP_EMIT * L, col[2] * LAMP_EMIT * L, L);
  }

  setQuality(tier) {
    if (!this.world) return;
    if (tier !== this.tier || !this._boulders) this._fillTier(tier);
  }

  /**
   * 当たり（debug.js の箱・placement の円）と見た目の差（m）。lab の証拠と Node のテストが読む
   */
  collisionReport() {
    const D = this.dock, fx = this.fx;
    const dock = dockContractReport(this.dockGeo.attributes.position.array, this.dockGeo.attributes.ngWood.array, {
      start: D.dockStart, dir: fx.dir, right: fx.right, Y: D.dockY, L: D._dockLen, lamp: this.lampPos,
    });
    const boat = boatContractReport(this.boatGeo.attributes.position.array, this.boatP);
    /* 大岩：見た目の半径（形の xz の最大 = 1 × 0.40·size·max(sx, sz)）と当たりの半径・上端 */
    let bR = -Infinity, bT = 0;
    for (const b of this.ctx.placement?.boulders || []) {
      if (!b.collide) continue;
      bR = Math.max(bR, 0.4 * b.size * Math.max(b.sx, b.sz) - b.r);
      bT = Math.max(bT, Math.abs(b.y + b.size * b.sy - b.top));
    }
    let sR = -Infinity, sT = 0;
    for (const s of this._structReport || []) { sR = Math.max(sR, s.maxR - s.r * 1.15); sT = Math.max(sT, Math.abs(s.top - s.wantTop)); }
    const cm = (v) => Math.round(v * 1000) / 10;
    return {
      ...dock, boat,
      boulders: { rOver: cm(bR), topDiff: cm(bT) },
      structures: { rOver: cm(sR), topDiff: cm(sT), n: (this._structReport || []).length },
      piles: this.piles.length,
      pileSpacing: (() => { const a = [...new Set((this._pileFull || []).map((p) => p.al.toFixed(3)))].map(Number).sort((x, y) => x - y); return a.length > 1 ? cm(a[1] - a[0]) : 0; })(),
    };
  }

  stats() {
    let draws = 1 + (this.boat ? 1 : 0) + (this.rope ? 1 : 0) + (this.driftMesh ? 1 : 0) + (this.snagMesh ? 1 : 0) + (this.moths?.visible ? 1 : 0);
    let tris = (this.dockGeo?.index.count || 0) / 3 + (this.boatGeo?.index.count || 0) / 3;
    let inst = 0;
    for (const row of [...this._rockMeshes, ...this._cobbleMeshes]) {
      for (const im of row || []) {
        if (!im || !im.visible) continue;
        draws++; inst += im.count; tris += (im.geometry.index.count / 3) * im.count;
      }
    }
    for (const c of this.under?.children || []) if (c.isInstancedMesh) { draws++; inst += c.count; tris += (c.geometry.index.count / 3) * c.count; }
    return { draws, tris: Math.round(tris), instances: inst, texBytes: this.tex?.bytes || 0, programs: 3, lamp: this.lamp };
  }

  dispose() {
    super.dispose();
    for (const m of [this.woodMat, this.rockMat, this.mothMat]) m?.dispose();
  }
}

function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** @param {object} ctx */
export function createModule(ctx) { return new HardscapeModule(ctx); }

export { DOCK_DIM };
