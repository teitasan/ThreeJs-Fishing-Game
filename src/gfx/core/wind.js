/* ===========================================================
   見た目の風（ARCHITECTURE §4.6）と CPU 双子
   -----------------------------------------------------------
   - 基準の風向 φ と風速は «時刻と（damp 済みの）天候» の純関数（マルチで一致）。
     風速は clear 1.4 / cloudy 3.0 / rain 5.0 m/s
   - GPU は glsl/wind.glsl.js の ngWindAt(xz)。ここの sample が同じ式
   - ゲーム用の water.wind（1 + rain·0.92 + cloud·0.14）とは別物
   three を import しない
   =========================================================== */
import { NG } from './frame.js';
import { hash12 } from './medium.js';

const CLEAR_CLOUD = 0.14, CLOUDY_CLOUD = 0.72;   // WEATHERS の cloud（sky.js）

/**
 * 見た目の風の状態。ngFrame の slot 11 を書く
 */
export class Wind {
  /** @param {import('./frame.js').NgFrame} frame */
  constructor(frame) {
    this.frame = frame;
    /** 風向（単位ベクトル） */
    this.dir = { x: 1, z: 0 };
    /** 基準の風速 m/s */
    this.speed = 1.4;
    /** 突風の振幅（0..1） */
    this.gust = 0.35;
    /** ゲームの windPow（updateWind の引数。記録だけ） */
    this.windPow = 1;
    this.envTime = 0;
  }

  /**
   * ファサードの updateWind(time, windPow) から呼ばれる。見た目の風は純関数なので記録だけ
   * @param {number} time
   * @param {number} windPow
   */
  update(time, windPow) {
    if (Number.isFinite(windPow)) this.windPow = windPow;
  }

  /**
   * 時刻と天候から風を決め、slot 11 を書く（gfx.beginFrame から毎フレーム）
   * @param {number} hour 0..24
   * @param {number} cloud damp 済みの雲量
   * @param {number} rain damp 済みの雨
   * @param {number} envTime ポーズで止まる時間（s）
   */
  setState(hour, cloud, rain, envTime) {
    const r = clamp01(rain);
    const s = clamp01((cloud - CLEAR_CLOUD) / (CLOUDY_CLOUD - CLEAR_CLOUD));
    const phi = 0.9 + 0.5 * Math.sin((hour - 9) / 24 * Math.PI * 2) + 0.6 * r + 0.25 * s;
    this.dir.x = Math.cos(phi); this.dir.z = Math.sin(phi);
    this.speed = 1.4 + 1.6 * s + (3.6 / 1.53) * r;       // rain の r = 0.85 で 5.0 m/s
    this.gust = 0.35 + 0.3 * r;
    this.envTime = envTime;
    this.frame.set(NG.WIND, this.dir.x, this.dir.z, this.speed, this.gust);
  }

  /**
   * GLSL の ngWindAt と同じ式
   * @param {number} x
   * @param {number} z
   * @param {number} [t=this.envTime]
   * @returns {{dx:number, dz:number, speed:number, gust:number}}
   */
  sample(x, z, t = this.envTime) {
    const k = t * 3 * (0.5 + this.speed / 6);
    const px = x - this.dir.x * k, pz = z - this.dir.z * k;
    const g = 0.65 * vnoise(px / 38, pz / 38) + 0.35 * vnoise(px / 13 + 7.1, pz / 13 + 7.1);
    return { dx: this.dir.x, dz: this.dir.z, speed: this.speed * Math.max(1 + (g - 0.5) * 2 * this.gust, 0), gust: g };
  }
}

/** GLSL の ngVNoise2 と同じ（five-order 補間の値ノイズ） */
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash12(ix, iy), b = hash12(ix + 1, iy), c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
  const ab = a + (b - a) * ux, cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
