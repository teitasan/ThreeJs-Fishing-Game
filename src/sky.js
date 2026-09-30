/* ===========================================================
   Environment ファサード：時間帯・天候・光のリグ
   -----------------------------------------------------------
   空・雲・大気の «見た目» は src/gfx の sky モジュールが描く。ここは
   ゲームと約束した値（契約 §4.1）だけを持つ：
     - WEATHERS（サーバーの weather.js と同じ値。1 バイトも変えない）
     - 天候の状態機械（旧 sky.js:317-334 の逐語移植。マルチでは上書きされる）
     - 太陽の軌道（旧式：a = ((h−6)/24)·2π、sunDir = normalize(cos a, sin a, 0.34)）
       nightAmount = smoothstep(0.08, −0.16, sunDir.y)、月 = −sunDir
     - keyDir（昼は太陽・夜は月。切り替えは旧版と同じ «強い方»）
     - damp（cloud λ0.4・rain λ0.35、実秒）。{instant:true} で即時
     - 光のリグ（DirectionalLight 1 + LightProbe 1 + PointLight 1）を «起動時に» 作って
       core に渡す。ライト数と castShadow を実行中に変えると全マテリアルが再コンパイルされる
     - scene.fog は THREE.Fog のまま（USE_FOG を立てるため。near/far は媒質の双子から毎フレーム）
   core（Core-A）が居ない・例外を出す場合でも、旧版の色と霧の式で動き続ける。
   =========================================================== */
import * as THREE from 'three';
import { clamp01, lerp, smoothstep, rand, TAU, damp } from './util.js?v=20260830-zone5';
import { createGfx } from './gfx/core/index.js';

/* 時刻ごとの色キーフレーム（旧 sky.js と同じ値）。core の sky モジュールが色を返さないときの
   代わりと、keyDir の «太陽か月か» の判定（dir 列）に使う */
const KEYS = [
  { h: 0.0, zen: 0x0d2244, hor: 0x1a3055, sun: 0x16253c, amb: 0.38, dir: 0.05 },
  { h: 4.2, zen: 0x122a4c, hor: 0x223a60, sun: 0x2c3550, amb: 0.40, dir: 0.09 },
  { h: 5.4, zen: 0x18375c, hor: 0x7d4f5c, sun: 0xff8f52, amb: 0.40, dir: 0.55 },
  { h: 6.4, zen: 0x2a5c96, hor: 0xf7a068, sun: 0xffb478, amb: 0.66, dir: 1.9 },
  { h: 8.5, zen: 0x2d74be, hor: 0x9fc6e4, sun: 0xffeecd, amb: 0.90, dir: 2.9 },
  { h: 12.0, zen: 0x1f66c6, hor: 0xafd2ec, sun: 0xfffaf0, amb: 1.0, dir: 3.3 },
  { h: 15.5, zen: 0x2a6dbe, hor: 0xb6cee0, sun: 0xfff2d8, amb: 0.95, dir: 2.9 },
  { h: 17.6, zen: 0x24508c, hor: 0xf19256, sun: 0xffa055, amb: 0.68, dir: 1.7 },
  { h: 18.8, zen: 0x17305c, hor: 0xa85a50, sun: 0xf5713c, amb: 0.42, dir: 0.5 },
  { h: 20.0, zen: 0x14294c, hor: 0x2a3a5e, sun: 0x333b5c, amb: 0.42, dir: 0.11 },
  { h: 24.0, zen: 0x0d2244, hor: 0x1a3055, sun: 0x16253c, amb: 0.38, dir: 0.05 },
];

export const WEATHERS = {
  clear: { key: 'clear', name: '晴れ', icon: 'weather-clear', cloud: 0.14, rain: 0, bite: 1.0, weight: 44 },
  cloudy: { key: 'cloudy', name: 'くもり', icon: 'weather-cloudy', cloud: 0.72, rain: 0, bite: 1.12, weight: 34 },
  rain: { key: 'rain', name: '雨', icon: 'weather-rain', cloud: 0.95, rain: 0.85, bite: 1.3, weight: 22 },
};

/* 旧版の月の強さ（keyDir の判定だけに使う。実際の照度は ng 単位で sky モジュールが決める） */
const MOON_INTENSITY = 1.7;
const MOON_COLOR = new THREE.Color(0x9fb6e8);
/** 灯籠の色（2200K の黒体。sRGB で書き、three が線形へ直す） */
const LAMP_COLOR = 0xffa64d;

const c1 = new THREE.Color();
const c2 = new THREE.Color();
const horizonGate = (y) => smoothstep(-0.02, 0.14, y);

/* フレーム中の例外は «ログを 1 回出して続ける»（MP の同期まで止めない） */
const warned = new Set();
function warnOnce(tag, e) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[sky] ${tag}`, e);
}

export class Environment {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.exposure = opts.exposure ?? 1.0;
    this.hour = 9;
    this.sunDir = new THREE.Vector3(0.3, 0.6, 0.4).normalize();
    /** 影と陰影を作っている光の向き（昼＝太陽、夜＝月）。caustics や光の柱もこれを見る */
    this.keyDir = new THREE.Vector3(0, 1, 0);
    this.nightAmount = 0;
    this.moonAmount = 0;
    this.horizonColor = new THREE.Color(0x9fc4de);
    this.zenithColor = new THREE.Color(0x2c72cc);
    this.sunColor = new THREE.Color(0xffffff);
    this.fogColor = new THREE.Color(0x9fc4de);

    /* ---- 天候 ---- */
    this.weather = WEATHERS.clear;
    this.nextWeather = WEATHERS.clear;
    this.weatherTimer = rand(3, 6); // 残りゲーム内時間
    this.cloudiness = this.weather.cloud;
    this.rainIntensity = 0;
    this._underwater = false;

    /* 空ドームの uniform の互換。uLinearOut は後処理の持ち主（post）が 1 に保つ */
    this.skyUniforms = {
      uStars: { value: 1 },
      uLinearOut: { value: 1 },
      uTime: { value: 0 },
      uExposure: { value: this.exposure },
    };
    /* 空と雨の «入れ物»。描くのは sky / weatherfx モジュール。game.js が除外リストに渡す */
    this.sky = new THREE.Group();
    this.sky.name = 'env-sky';
    this.rain = new THREE.Group();
    this.rain.name = 'env-rain';
    this.rain.visible = false;
    scene.add(this.sky, this.rain);

    this._buildLights();
    scene.fog = new THREE.Fog(this.fogColor.getHex(), 90, 620);

    /* core は湖より前に立てる（ngFrame・チャンクの差し替え・ライトのリグ） */
    this.gfx = null;
    try {
      this.gfx = createGfx({ scene }) || null;
      this.gfx?.setLightRig?.({ key: this.sun, probe: this.probe, lamp: this.lamp });
    } catch (e) {
      warnOnce('core の初期化に失敗、旧版の色と霧で続行します', e);
      this.gfx = null;
    }
  }

  /* ---------------- ライト（起動時に固定） ---------------- */
  _buildLights() {
    /* 平行光 1 本を «昼は太陽・夜は月» として使い回す。影を落とす平行光が 2 本になると
       シャドウマップがもう 1 枚要るうえ、castShadow を切り替えた瞬間に全マテリアルが
       組み直される。月は太陽のちょうど反対側にあって同時に空へ出ることが無い */
    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.name = 'ng-key';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.near = 0.5;
    cam.far = 1500;
    cam.left = -40; cam.right = 40; cam.top = 40; cam.bottom = -40;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sunTarget = new THREE.Object3D();
    this.sun.target = this.sunTarget;
    this.sun.layers.enableAll();
    /* 空の照度（SH L2）。sky モジュールが 4Hz で射影して書く */
    this.probe = new THREE.LightProbe();
    this.probe.name = 'ng-probe';
    this.probe.layers.enableAll();
    /* 灯籠。昼は intensity 0 のまま «存在だけ» させる（夜に増やすと再コンパイルになる） */
    this.lamp = new THREE.PointLight(LAMP_COLOR, 0, 26, 2);
    this.lamp.name = 'ng-lamp';
    this.lamp.position.set(0, -1000, 0);
    this.lamp.layers.enableAll();
    this.scene.add(this.sun, this.sunTarget, this.probe, this.lamp);
  }

  get underwater() { return this._underwater; }
  /** 水中フォグ・環境光の上乗せ・雨の非表示（game._setUnderwaterFx が切り替える） */
  set underwater(on) {
    this._underwater = !!on;
    try { this.gfx?.setUnderwater?.(this._underwater); } catch (e) { warnOnce('setUnderwater', e); }
    if (this._underwater) this.rain.visible = false;
  }

  /** 天候の進行（dtHours: 経過ゲーム内時間）。旧 sky.js:317-334 と同じ抽選 */
  tickWeather(dtHours) {
    this.weatherTimer -= dtHours;
    if (this.weatherTimer <= 0) {
      const list = Object.values(WEATHERS);
      let total = 0;
      for (const w of list) total += w === this.weather ? w.weight * 0.35 : w.weight;
      let r = Math.random() * total;
      let chosen = list[0];
      for (const w of list) {
        r -= w === this.weather ? w.weight * 0.35 : w.weight;
        if (r <= 0) { chosen = w; break; }
      }
      this.weather = chosen;
      this.weatherTimer = rand(2.5, 6.5);
      return chosen;
    }
    return null;
  }

  /**
   * 天候を切り替える（不正なキーは無視）。見た目は damp で追従する。
   * instant: true で雲量・雨量を即座に合わせる（撮影ハーネス用）
   */
  setWeather(key, { instant = false } = {}) {
    if (WEATHERS[key]) {
      this.weather = WEATHERS[key];
      this.weatherTimer = rand(3, 6);
      if (instant) {
        this.cloudiness = this.weather.cloud;
        this.rainIntensity = this.weather.rain;
      }
    }
  }

  /** 1 フレーム更新。dt = 0 でポーズ（damp も止まる） */
  update(dt, hour, camera, focus) {
    this.hour = hour;
    const t = ((hour % 24) + 24) % 24;

    // --- 太陽方向（旧式のまま。灯籠・音・夜の判定の時刻を変えない） ---
    const ang = ((t - 6) / 24) * TAU;
    this.sunDir.set(Math.cos(ang), Math.sin(ang), 0.34).normalize();
    this.nightAmount = clamp01(smoothstep(0.08, -0.16, this.sunDir.y));

    // --- 天候の滑らかな遷移 ---
    this.cloudiness = damp(this.cloudiness, this.weather.cloud, 0.4, dt);
    this.rainIntensity = damp(this.rainIntensity, this.weather.rain, 0.35, dt);

    // --- キーフレーム（core が色を返さないときの代わり・keyDir の判定） ---
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= t) i++;
    const A = KEYS[i], B = KEYS[i + 1];
    const f = clamp01((t - A.h) / (B.h - A.h));
    const dirI = lerp(A.dir, B.dir, f);
    const cloudDim = 1 - this.cloudiness * 0.45;
    const sunI = dirI * cloudDim * horizonGate(this.sunDir.y);
    const moonI = MOON_INTENSITY * cloudDim * horizonGate(-this.sunDir.y);
    this.moonAmount = moonI > sunI ? 1 : 0;
    if (this.moonAmount) this.keyDir.copy(this.sunDir).negate();
    else this.keyDir.copy(this.sunDir);

    this.skyUniforms.uTime.value += dt;

    let res = null;
    if (this.gfx) {
      try {
        res = this.gfx.beginFrame?.({
          dt, hour, camera, focus,
          weather: { key: this.weather.key, cloud: this.cloudiness, rain: this.rainIntensity },
          nightAmount: this.nightAmount, sunDir: this.sunDir, keyDir: this.keyDir,
        }) || null;
      } catch (e) {
        warnOnce('beginFrame が失敗、旧版の色で続行します', e);
        res = null;
      }
    }
    this._applyFrame(res, A, B, f, sunI, moonI, focus);
    this.rain.visible = !this._underwater && this.rainIntensity > 0.03;
  }

  /** core の結果（色・霧・key）を契約のフィールドへ写す。無ければ旧版の式 */
  _applyFrame(res, A, B, f, sunI, moonI, focus) {
    const fog = this.scene.fog;
    const col = res?.colors;
    if (col?.zenithColor && col?.horizonColor && col?.sunColor) {
      this.zenithColor.copy(col.zenithColor);
      this.horizonColor.copy(col.horizonColor);
      this.sunColor.copy(col.sunColor);
      if (col.fogColor) this.fogColor.copy(col.fogColor);
      else this.fogColor.copy(this.horizonColor).lerp(this.zenithColor, 0.28);
    } else {
      this.zenithColor.copy(c1.setHex(A.zen)).lerp(c2.setHex(B.zen), f);
      this.horizonColor.copy(c1.setHex(A.hor)).lerp(c2.setHex(B.hor), f);
      this.sunColor.copy(c1.setHex(A.sun)).lerp(c2.setHex(B.sun), f);
      this.fogColor.copy(this.horizonColor).lerp(this.zenithColor, 0.28);
      if (this.cloudiness > 0.4) this.fogColor.lerp(c1.setRGB(0.42, 0.46, 0.5), (this.cloudiness - 0.4) * 0.5);
      if (this._underwater) this.fogColor.setRGB(0.055, 0.16, 0.19).multiplyScalar(lerp(1, 0.62, this.nightAmount));
    }
    if (fog) {
      const fr = res?.fog;
      if (fr && Number.isFinite(fr.near) && Number.isFinite(fr.far)) {
        fog.near = fr.near;
        fog.far = fr.far;
        fog.color.copy(fr.color || this.fogColor);
      } else {
        fog.color.copy(this.fogColor);
        if (this._underwater) {
          fog.near = lerp(30, 22, this.nightAmount);
          fog.far = lerp(250, 190, this.nightAmount);
        } else {
          fog.near = lerp(150, 30, this.rainIntensity);
          fog.far = lerp(900, 210, this.rainIntensity);
        }
      }
    }
    /* key：色と強さは sky の producer が ng 単位で決める。影の追従（テクセルスナップ）は core */
    const key = res?.key;
    if (key && Number.isFinite(key.intensity)) {
      if (key.color) this.sun.color.copy(key.color);
      this.sun.intensity = key.intensity;
    } else {
      if (this.moonAmount) { this.sun.color.copy(MOON_COLOR); this.sun.intensity = moonI; }
      else { this.sun.color.copy(this.sunColor); this.sun.intensity = sunI; }
      const fx = focus ? focus.x : 0, fz = focus ? focus.z : 0;
      this.sunTarget.position.set(fx, 0, fz);
      this.sun.position.set(fx + this.keyDir.x * 150, this.keyDir.y * 150 + 6, fz + this.keyDir.z * 150);
      if (!res) {
        /* core が無いときの環境光（SH の L0 だけ）。キャラクターが真っ黒にならない程度 */
        const amb = lerp(0.25, 0.9, 1 - this.nightAmount) * lerp(1, 0.8, this.cloudiness);
        this.probe.sh.coefficients[0].set(0.52, 0.62, 0.78).multiplyScalar(amb * 0.886);
      }
    }
    /* 影マップ（sun.shadow.map）を perf が読むので、太陽は常に visible */
    this.sun.visible = true;
  }

  setQuality(q) {
    this.quality = q;
    try { this.gfx?.setQuality?.(q); } catch (e) { warnOnce('setQuality', e); }
  }
}
