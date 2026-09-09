/* 他プレイヤー表示。既存 Angler をそのまま使い、竿・腕IK・リール・しなり・糸を再利用する。 */
import * as THREE from 'three';
import { Angler } from '../angler.js?v=20260909-rodaim';
import { clamp01, TAU } from '../util.js';
import { t } from '../i18n.js';
import { Vec3Stream, YawStream, recvTimeSec } from './interpolation.js';
import { gaitOfSpeed } from '../gait.js?v=20260909-rodaim';


const _v = new THREE.Vector3(), _lineEnd = new THREE.Vector3(), _prevPos = new THREE.Vector3();

function makeLabel(name) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
  const g = canvas.getContext('2d'); g.font = '600 30px "Hiragino Sans", "Noto Sans JP", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 6;
  g.strokeStyle = 'rgba(10, 22, 34, 0.85)'; g.strokeText(name, 128, 34); g.fillStyle = '#eaf4ff'; g.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false })); sprite.scale.set(1.7, 0.42, 1); sprite.renderOrder = 7; return sprite;
}

class RemotePlayer {
  constructor(scene, info) {
    this.scene = scene; this.id = info.id; this.name = info.name || ''; this.action = info.a || 'idle'; this.angler = new Angler(scene);
    this.label = makeLabel(this.name); this.label.position.y = 2.1; this.angler.root.add(this.label);
    this.posStream = new Vec3Stream(); this.yawStream = new YawStream(); this.lineStream = new Vec3Stream();
    this.target = new THREE.Vector3(info.x || 0, info.y || 0, info.z || 0);
    this.yawTarget = info.yaw || 0; this.yaw = this.yawTarget; this.speed = 0;
    this.hasPos = isFinite(info.x) && (info.x !== 0 || info.z !== 0);
    this.visual = { fs: 'idle', charge: 0, tension: 0, reeling: 0, rod: 'bamboo', bait: 'worm', rarity: 0, bx: 0, by: 0, bz: 0, line: false }; this._lastFs = 'idle';
    if (this.hasPos) {
      this.posStream.snap(info.x || 0, info.y || 0, info.z || 0);
      this.yawStream.snap(this.yaw);
      this.angler.root.position.set(info.x || 0, info.y || 0, info.z || 0);
    }
    this.angler.root.visible = this.hasPos;
  }
  async load() { await this.angler.load(); }
  setState(s) {
    const tSec = recvTimeSec(s);
    this.target.set(s.x, s.y, s.z);
    this.yawTarget = s.yaw || 0;
    this.posStream.push(tSec, s.x, s.y, s.z);
    this.yawStream.push(tSec, this.yawTarget);
    this.action = s.a || 'idle';
    if (!this.hasPos) {
      this.hasPos = true;
      this.posStream.snap(s.x, s.y, s.z);
      this.yawStream.snap(s.yaw || 0);
      this.yaw = s.yaw || 0;
      this.angler.root.position.set(s.x, s.y, s.z);
      this.angler.root.visible = true;
    }
  }
  setVisual(v) {
    this.visual = { ...this.visual, ...v };
    if (v.rod) this.angler.setRod(v.rod);
    if (v.bait) this.angler.setBait(v.bait);
    if ((v.fs === 'flight' || v.fs === 'cast') && this._lastFs !== 'flight' && this._lastFs !== 'cast') this.angler.playCast();
    this._lastFs = v.fs || this._lastFs;
    const tSec = recvTimeSec(v);
    if (v.line === false) this.lineStream.reset();
    else if (v.line || Number.isFinite(v.bx) || Number.isFinite(v.by) || Number.isFinite(v.bz)) {
      this.lineStream.push(tSec, v.bx ?? this.visual.bx, v.by ?? this.visual.by, v.bz ?? this.visual.bz);
    }
  }
  update(dt, camera) {
    if (!this.hasPos || !this.angler.ready) return;
    const now = performance.now() * 0.001;
    const p = this.angler.root.position;
    _prevPos.copy(p);
    if (this.posStream.sample(now, p)) {
      const dx = p.x - _prevPos.x, dz = p.z - _prevPos.z;
      const spd = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
      this.speed += (spd - this.speed) * (1 - Math.exp(-6 * dt));
    }
    const yawSample = this.yawStream.sample(now);
    if (yawSample != null) this.yaw = yawSample;
    this.angler.setYaw(this.yaw);
    const v = this.visual, state = normalizeState(v.fs, this.action);
    const hasLine = !!v.line && ['flight', 'wait', 'nibble', 'bite', 'fight', 'landing', 'landed'].includes(state);
    let lineEnd = null;
    if (hasLine && this.lineStream.sample(now, _lineEnd)) lineEnd = _lineEnd;
    else if (hasLine) lineEnd = _lineEnd.set(v.bx, v.by, v.bz);
    this.angler.update(dt, { state, charge: clamp01(v.charge), tension: clamp01(v.tension), reeling: clamp01(v.reeling), moving: gaitOfSpeed(this.speed), speed: this.speed, rarity: v.rarity || 0, lineEnd });
    this.angler.bobber.visible = hasLine && state !== 'fight';
    this.angler.bobberRing.visible = hasLine && ['wait', 'nibble', 'bite'].includes(state);
    if (hasLine && lineEnd) {
      this.angler.bobber.position.copy(lineEnd);
      if (this.angler.bobberRing.visible) {
        this.angler.bobberRing.position.set(lineEnd.x, lineEnd.y + 0.02, lineEnd.z);
        this.angler.bobberRing.scale.setScalar(state === 'nibble' ? 1.35 : 1);
      }
      if (camera) {
        const tip = this.angler.getRodTip(_v);
        this.angler.updateLine(tip, lineEnd, state === 'wait' ? 0.25 : 0.08, camera);
      }
    } else {
      this.angler.line.mesh.visible = false;
      this.angler.bobberRing.visible = false;
    }
  }
  dispose() { this.angler.root.remove(this.label); this.label.material.map.dispose(); this.label.material.dispose(); this.scene.remove(this.angler.root); this.scene.remove(this.angler.bobber); this.scene.remove(this.angler.bobberRing); this.scene.remove(this.angler.rig); this.scene.remove(this.angler.line.mesh); this.scene.remove(this.angler.lineLower.mesh); }
}

function normalizeState(fs, action) { if (['idle', 'charge', 'flight', 'wait', 'nibble', 'bite', 'fight', 'landed'].includes(fs)) return fs; if (action === 'cast') return 'flight'; if (action === 'waiting') return 'wait'; if (action === 'reel' || action === 'fight') return 'fight'; return 'idle'; }

export class RemotePlayers {
  constructor(scene) { this.scene = scene; this.map = new Map(); this.loaded = false; this.pending = new Map(); this.camera = null; }
  async load(onProgress) { if (onProgress) await onProgress(t('ui.loadingPlayers')); this.loaded = true; }
  upsert(info) { if (!this.loaded || !info?.id) return; const cur = this.map.get(info.id); if (cur) { cur.setState(info); return; } const p = new RemotePlayer(this.scene, info); this.map.set(info.id, p); p.load().then(() => { const v = this.pending.get(info.id); if (v) { p.setVisual(v); this.pending.delete(info.id); } }).catch(() => this.remove(info.id)); }
  setVisual(info) { if (!info?.id) return; const p = this.map.get(info.id); if (p?.angler.ready) p.setVisual(info); else this.pending.set(info.id, info); }
  remove(id) { const p = this.map.get(id); if (p) p.dispose(); this.map.delete(id); this.pending.delete(id); }
  nameOf(id) { return this.map.get(id)?.name || ''; } get count() { return this.map.size; }
  update(dt, camera = null) { const cam = camera || this.camera; for (const p of this.map.values()) p.update(dt, cam); }
}
