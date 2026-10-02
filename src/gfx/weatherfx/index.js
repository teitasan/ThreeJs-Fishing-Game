/* ===========================================================
   weatherfx モジュール（ARCHITECTURE §6.9：雨・霧・粒）
   -----------------------------------------------------------
   - 雨（rain.js）：筋・着弾・遠景の幕。水面へは services.water.addImpulse（CPU、フレームと粒の番号のハッシュ）
   - 朝霧の板（mist.js）：core の朝霧と同じ密度場の «濃淡の揺らぎ»
   - 蛍・光芒の塵（motes.js）
   - env.rain（ファサードの Group、名前 'env-rain'）との互換：game.js は水中・捕獲の写真で env.rain.visible を切る。
     雨の物は自分の root に置いたまま（?ng=-weatherfx と無効化で丸ごと隠れる）、env.rain が見えないときは雨を描かない。
     見つからない（lab）ときは «水中（uw > 0.5）で雨を隠す» だけ
   すべて LATE_FX 層（反射・屈折に写らない）。時間で進む物は f.envTime（ポーズで止まる）
   =========================================================== */
import { NgModule } from '../core/module.js';
import { NG } from '../core/frame.js';
import { DOCK_W } from '../../world/dock.js';
import { wfxTier } from './quality.js';
import { Rain } from './rain.js';
import { Mist } from './mist.js';
import { Motes } from './motes.js';
import { fireflyActivity, motesActivity, impulseRate, impulseAt } from './logic.js';

export class WeatherFxModule extends NgModule {
  static id = 'weatherfx';

  constructor(ctx) {
    super(ctx);
    this.tier = ctx.tier || 'mid';
    this.q = wfxTier(this.tier);
    this._impAcc = 0;
    this._envRain = null;
    this._envLook = 0;
    this._st = { rain: { rain: 0, show: false, t: 0, lamp: null }, mist: { show: false, t: 0, density: 0 }, pts: { t: 0, fireflies: 0, motes: 0, show: true } };
    this.act = { fireflies: 0, motes: 0, impulsesSent: 0 };
  }

  async init(progress) {
    const ctx = this.ctx, seed = ctx.lake?.seed ?? 1;
    this.rain = new Rain(ctx, this.root, seed);
    await this.rain.bake();
    await ctx.forge.step();
    progress?.(0.4);
    this.mist = new Mist(ctx, this.root, seed);
    await this.mist.bake();
    progress?.(0.7);
    this.motes = new Motes(ctx, this.root, seed);
    const dock = ctx.lake?.dock;
    this.rain.setDock(dock, ctx.terrain?.dockY ?? 1, DOCK_W / 2);
    this.setQuality(this.tier);
    this._findEnvRain();
    ctx.scene.add(this.root);
    progress?.(1);
  }

  /* ファサードの env.rain（名前 'env-rain'）。init の後に作られることがあるので、見つかるまで 2 秒ごとに探す */
  _findEnvRain() {
    try { this._envRain = this.ctx.scene.getObjectByName('env-rain') || null; } catch (e) { this._envRain = null; }
  }

  setQuality(tier) {
    this.tier = tier;
    this.q = wfxTier(tier);
    this.rain?.setCounts(this.q);
    this.mist?.setCount(this.q.mist);
    this.motes?.setCounts(this.q);
  }

  /** CPU（§2.1 の 3）：水面への雨粒の衝撃（ポーズで止まる） */
  update(f) {
    if (!this._envRain && (this._envLook = (this._envLook + (f.realDt || 0))) > 2) { this._envLook = 0; this._findEnvRain(); }
    const rain = fin(f.weather?.rain);
    const dt = fin(f.dt);
    if (rain < 0.05 || dt <= 0 || !(this._rainShown)) { this._impAcc = 0; return; }
    const cam = f.camera?.position;
    const lake = this.ctx.lake;
    if (!cam || !lake) return;
    this._impAcc += impulseRate(rain, this.q.impulses) * dt;
    const n = Math.min(12, Math.floor(this._impAcc));
    this._impAcc -= n;
    const water = this.ctx.services.water;
    const fi = f.frameIndex | 0;
    for (let k = 0; k < n; k++) {
      const p = impulseAt(lake.seed >>> 0, fi, k, cam.x, cam.z, 18);
      if (lake.depthAt(p.x, p.z) <= 0.05) continue;
      water.addImpulse(p.x, p.z, p.amp);
      this.act.impulsesSent++;
    }
  }

  /** P1：GPU の値（時刻・天候・見え方） */
  prepare(f) {
    const F = this.ctx.frame.data, uw = this.ctx.frame.cam.uw;
    const t = fin(f.envTime) % 1800;
    const rain = fin(f.weather?.rain), cloud = fin(f.weather?.cloud);
    const envOk = this._envRain ? this._envRain.visible !== false : true;
    const above = uw <= 0.5;
    const sr = this._st.rain;
    sr.rain = rain; sr.show = above && envOk; sr.t = t; sr.lamp = this.ctx.gfx?.rig?.lamp || null;
    this._rainShown = sr.show;
    this.rain?.update(f, sr);
    const sm = this._st.mist;
    sm.show = above; sm.t = t; sm.density = F[NG.MIST * 4];
    this.mist?.update(f, sm);
    const sp = this._st.pts;
    sp.t = t; sp.show = above;
    sp.fireflies = fireflyActivity({ night: F[NG.KEY * 4 + 3], rain, cloud, season: F[NG.WEATHER * 4 + 3], hour: fin(f.hour) });
    /* 塵：太陽が低い・晴れ、かつカメラが森の中（樹冠の密度は CPU の双子が無いので placement の木の近さで代える） */
    sp.motes = motesActivity({ sinSunAlt: F[NG.KEYRAD * 4 + 3], rain, cloud }) * this._forestAt(f.camera?.position);
    this.act.fireflies = sp.fireflies; this.act.motes = sp.motes;
    this.motes?.update(f, sp);
  }

  /* カメラの周り 9m に木が何本あるか → 0..1（3 本で 1）。重いので 0.5m 動いたときだけ数え直す */
  _forestAt(p) {
    if (!p) return 0;
    if (this._fp && Math.abs(this._fp.x - p.x) < 0.5 && Math.abs(this._fp.z - p.z) < 0.5) return this._fv;
    const T = this.ctx.placement?.trees;
    let n = 0;
    if (T?.count) {
      for (let i = 0; i < T.count; i++) {
        const dx = T.x[i] - p.x, dz = T.z[i] - p.z;
        if (dx * dx + dz * dz < 81) { n++; if (n >= 3) break; }
      }
    }
    this._fp = { x: p.x, z: p.z };
    this._fv = Math.min(1, n / 3);
    return this._fv;
  }

  stats() {
    const a = this.rain?.stats() || { draws: 0, tris: 0, instances: 0 };
    const b = this.mist?.stats() || { draws: 0, tris: 0, instances: 0 };
    const c = this.motes?.stats() || { draws: 0, tris: 0, instances: 0 };
    return {
      draws: a.draws + b.draws + c.draws, tris: a.tris + b.tris + c.tris, instances: a.instances + b.instances + c.instances,
      texBytes: 2 * 256 * 256 * 4 * 1.33, programs: 5, fireflies: +this.act.fireflies.toFixed(2), motes: +this.act.motes.toFixed(2),
      impulses: this.act.impulsesSent, envRain: !!this._envRain,
    };
  }

  dispose() {
    this.rain?.dispose(); this.mist?.dispose(); this.motes?.dispose();
    super.dispose();
  }
}

function fin(v) { return Number.isFinite(v) ? v : 0; }

/** @param {object} ctx */
export function createModule(ctx) { return new WeatherFxModule(ctx); }
