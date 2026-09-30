/* ===========================================================
   hardscape のグレーボックス（本番の代替も兼ねる）
   -----------------------------------------------------------
   - 桟橋：契約の寸法（床幅 3.4m・床の上面 = dockY・杭 2.4m 間隔・先端 2.3m の手すり）。
     当たり（src/world/dock.js の dockBlocksSegment）と同じ箱に収める
   - 灯籠：r 0.26・上端 dockY + 2.3。PointLight（リグの lamp）を電球へ置き、setLamp で damp
   - 小舟：上下とピッチ・ロールは waveField の同じ関数
   - 大岩：placement.boulders（見た目の半径 0.40·size·(sx, sz)、高さ size·sy）
   - ストラクチャー：lake.structures の x, z, rot, h, r に正確に。UNDERWATER 層
   =========================================================== */
import { NgModule } from '../module.js';
import { NG_LAYER, ngOwn } from '../layers.js';
import { ngExtendStandard } from '../extend.js';
import { DOCK_W } from '../../../world/dock.js';
import { TIER_DENSITY } from '../../../world/placement.js';
import { waveHeight, waveSlope, shoalGain } from '../../../waveField.js?v=20260828-lakescale1';

const WOOD = 0x8f8272;      // 風化した杉材（線形 ≈ 0.26–0.28）
const ROCK = 0x7b7873;      // 花崗岩・安山岩（≈ 0.19）
const LAMP_K = [1.0, 0.54, 0.18];   // 2200K の黒体（線形、正規化）

/**
 * グレーボックスの hardscape
 */
export class HardscapeStub extends NgModule {
  static id = 'hardscape';

  constructor(ctx) {
    super(ctx);
    this.lamp = 0;
    this.piles = [];
    this.boat = null;
    this.bulb = null;
  }

  async init(progress) {
    const ctx = this.ctx, T = ctx.THREE, lake = ctx.lake;
    if (!lake) { progress?.(1); return; }
    const mat = (key, color, rough) => ngExtendStandard(new T.MeshStandardMaterial({ color, roughness: rough, metalness: 0 }), {
      key, module: 'hardscape', caustics: true, hfShadow: true,
    });
    this.mats = { wood: mat('hardscape-wood', WOOD, 0.85), rock: mat('hardscape-rock', ROCK, 0.9) };
    const world = new T.Group();
    this._buildDock(world);
    this._buildBoulders(world, ctx.tier);
    ngOwn(world, NG_LAYER.WORLD);
    const under = new T.Group();
    this._buildStructures(under);
    ngOwn(under, NG_LAYER.UNDERWATER);
    this.root.add(world, under);
    this.root.userData.ngOwned = true;
    ctx.scene.add(this.root);
    ctx.services.provide('hardscape', { piles: this.piles, setLamp: (n, dt) => this.setLamp(n, dt) });
    progress?.(1);
  }

  _buildDock(g) {
    const T = this.ctx.THREE, d = this.ctx.lake.dock, lake = this.ctx.lake;
    const a = new T.Vector3(d.start.x, 0, d.start.z), b = new T.Vector3(d.end.x, 0, d.end.z);
    const L = a.distanceTo(b), dir = b.clone().sub(a).normalize();
    const yaw = Math.atan2(dir.x, dir.z), right = new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const Y = d.y, W = DOCK_W;
    const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), yaw);
    const m = new T.Matrix4(), p = new T.Vector3(), s = new T.Vector3(1, 1, 1);
    const box = (w, h, l) => new T.BoxGeometry(w, h, l);
    /* 床板：1.5cm の隙間、上面 = dockY */
    const pitch = 0.435, n = Math.max(6, Math.floor(L / pitch));
    const planks = new T.InstancedMesh(box(W, 0.1, pitch - 0.015), this.mats.wood, n);
    for (let i = 0; i < n; i++) {
      p.copy(a).lerp(b, (i + 0.5) / n).setY(Y - 0.05);
      m.compose(p, q, s.set(1, 1, 1));
      planks.setMatrixAt(i, m);
    }
    const parts = [planks];
    for (const off of [-W / 2 + 0.2, W / 2 - 0.2]) {
      const beam = new T.Mesh(box(0.22, 0.26, L), this.mats.wood);
      beam.position.copy(a).lerp(b, 0.5).addScaledVector(right, off).setY(Y - 0.23);
      beam.quaternion.copy(q);
      parts.push(beam);
    }
    /* 杭：2.4m 間隔、湖底 −0.4m から桁の下まで */
    const rows = Math.max(2, Math.floor(L / 2.4) + 1);
    const posts = new T.InstancedMesh(new T.CylinderGeometry(0.15, 0.18, 1, 8), this.mats.wood, rows * 2);
    let k = 0;
    for (let i = 0; i < rows; i++) {
      const base = a.clone().lerp(b, rows === 1 ? 0 : i / (rows - 1));
      for (const off of [-W / 2 + 0.25, W / 2 - 0.25]) {
        const px = base.x + right.x * off, pz = base.z + right.z * off;
        const bot = Math.min(lake.heightAt(px, pz) - 0.4, Y - 0.6), top = Y - 0.34;
        m.compose(p.set(px, (bot + top) / 2, pz), new T.Quaternion(), s.set(1, top - bot, 1));
        posts.setMatrixAt(k++, m);
        this.piles.push({ x: px, z: pz, r: 0.17 });
      }
    }
    posts.count = k;
    parts.push(posts);
    /* 先端の手すり（先端から 2.3m の範囲、上端 dockY + 1.05 の当たりの箱の中） */
    for (const t of [0, 2.1]) {
      for (const off of [-W / 2 + 0.2, W / 2 - 0.2]) {
        const rp = new T.Mesh(new T.CylinderGeometry(0.07, 0.08, 0.95, 6), this.mats.wood);
        rp.position.copy(b).addScaledVector(dir, -t).addScaledVector(right, off).setY(Y + 0.47);
        parts.push(rp);
      }
    }
    const tipBar = new T.Mesh(box(W - 0.3, 0.09, 0.09), this.mats.wood);
    tipBar.position.copy(b).setY(Y + 0.9);
    tipBar.quaternion.copy(q);
    parts.push(tipBar);
    for (const off of [-W / 2 + 0.2, W / 2 - 0.2]) {
      const side = new T.Mesh(box(0.09, 0.09, 2.1), this.mats.wood);
      side.position.copy(b).addScaledVector(dir, -1.05).addScaledVector(right, off).setY(Y + 0.9);
      side.quaternion.copy(q);
      parts.push(side);
    }
    /* 灯籠：placement.lamp（当たりと同じ点） */
    const lp = this.ctx.placement?.lamp || { x: a.x + dir.x * 1.2 + right.x * (W / 2 - 0.15), z: a.z + dir.z * 1.2 + right.z * (W / 2 - 0.15) };
    const post = new T.Mesh(new T.CylinderGeometry(0.08, 0.1, 2.2, 7), this.mats.wood);
    post.position.set(lp.x, Y + 1.0, lp.z);
    parts.push(post);
    this.bulbMat = new T.MeshStandardMaterial({ color: 0xffe0b0, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.5 });
    this.bulbMat.emissive.setRGB(...LAMP_K);
    this.bulb = new T.Mesh(new T.SphereGeometry(0.2, 12, 8), this.bulbMat);
    this.bulb.position.set(lp.x, Y + 2.1, lp.z);
    parts.push(this.bulb);
    /* 小舟 */
    const bt = this.ctx.placement?.boat || { x: a.x + dir.x * 4 - right.x * (W / 2 + 1.7), y: 0.05, z: a.z + dir.z * 4 - right.z * (W / 2 + 1.7), yaw: yaw + 0.25 };
    const boat = new T.Group();
    const hull = new T.Mesh(new T.BoxGeometry(1.1, 0.45, 3.4), this.mats.wood);
    hull.position.y = 0.12;
    const inner = new T.Mesh(new T.BoxGeometry(0.9, 0.3, 3.1), new T.MeshStandardMaterial({ color: 0x3a2d22, roughness: 0.95 }));
    inner.position.y = 0.25;
    boat.add(hull, inner);
    boat.position.set(bt.x, bt.y, bt.z);
    boat.userData.base = { x: bt.x, y: bt.y, z: bt.z, yaw: bt.yaw };
    boat.rotation.y = bt.yaw;
    this.boat = boat;
    parts.push(boat);
    for (const o of parts) { o.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } }); g.add(o); }
  }

  _buildBoulders(g, tier) {
    const T = this.ctx.THREE, B = this.ctx.placement?.boulders || [];
    const dens = TIER_DENSITY.boulders[tier] ?? 1;
    const list = B.filter((b) => b.collide || b.rank < dens);
    if (!list.length) return;
    const im = new T.InstancedMesh(new T.IcosahedronGeometry(1, 1), this.mats.rock, list.length);
    const m = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler();
    list.forEach((b, i) => {
      q.setFromEuler(e.set(0, b.rot, 0));
      const r = 0.40 * b.size, hy = b.size * b.sy;
      m.compose(new T.Vector3(b.x, b.y + hy * 0.5, b.z), q, new T.Vector3(r * b.sx, hy * 0.5, r * b.sz));
      im.setMatrixAt(i, m);
    });
    im.computeBoundingSphere();
    im.castShadow = im.receiveShadow = true;
    g.add(im);
  }

  _buildStructures(g) {
    const T = this.ctx.THREE, lake = this.ctx.lake;
    for (const s of lake.structures || []) {
      const y0 = lake.heightAt(s.x, s.z);
      let o;
      if (s.kind === 'rock') {
        o = new T.Mesh(new T.IcosahedronGeometry(1, 1), this.mats.rock);
        o.scale.set(s.r, s.h * 0.5, s.r * 0.85);
        o.position.set(s.x, y0 + s.h * 0.5, s.z);
      } else {
        o = new T.Mesh(new T.CylinderGeometry(s.r * 0.35, s.r * 0.5, s.h, 7), this.mats.wood);
        o.position.set(s.x, y0 + s.h * 0.5, s.z);
        o.rotation.z = 0.12;
      }
      o.rotation.y = s.rot;
      o.receiveShadow = true;
      g.add(o);
    }
  }

  /**
   * 灯籠（Terrain.updateLamp）。dt で damp、ポーズ（dt = 0）で止まる
   * @param {number} night
   * @param {number} dt
   */
  setLamp(night, dt) {
    const target = smooth(0.3, 0.7, night);
    this.lamp += (target - this.lamp) * (1 - Math.exp(-Math.max(0, dt || 0) * 2));
    const lamp = this.ctx.gfx?.rig.lamp;
    if (lamp && this.bulb) {
      lamp.position.copy(this.bulb.position);
      lamp.color.setRGB(...LAMP_K);
      lamp.intensity = 6 * this.lamp;
      lamp.distance = 26;
      lamp.decay = 2;
    }
    if (this.bulbMat) this.bulbMat.emissiveIntensity = 40 * this.lamp;
  }

  update(f) {
    const b = this.boat;
    if (!b) return;
    const o = b.userData.base, lake = this.ctx.lake;
    const depth = Math.max(0, lake.depthAt(o.x, o.z));
    const g = shoalGain(depth);
    b.position.y = o.y + waveHeight(o.x, o.z, f.waterTime, f.waterWind) * g;
    const sl = waveSlope(o.x, o.z, f.waterTime, f.waterWind);
    b.rotation.set(Math.atan(sl.dz * g) * 0.6, o.yaw, -Math.atan(sl.dx * g) * 0.6, 'YXZ');
  }

  setQuality(tier) {
    const g = this.root.children[0];
    if (!g || !this.mats) return;
    for (const c of [...g.children]) if (c.isInstancedMesh && c.material === this.mats.rock) g.remove(c);
    this._buildBoulders(g, tier);
    ngOwn(g, NG_LAYER.WORLD);
  }
}

function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** @param {object} ctx */
export function createModule(ctx) { return new HardscapeStub(ctx); }
