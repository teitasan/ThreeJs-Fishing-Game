/* ===========================================================
   描画の芯の入口（ARCHITECTURE §4.13）
   -----------------------------------------------------------
   ファサード（sky.js / terrain.js / water.js / postfx.js）はここだけを呼ぶ。
   - import した時点で installNg（ShaderChunk / ShaderLib の差し替え）。
     sky.js が最初に import するので、どのマテリアルのコンパイルよりも前に効く
   - createGfx({ scene }) は 1 シーンに 1 つ（同じ scene なら同じものを返す）
   - フレーム中の呼び出しは例外を投げない（safe.js で隔離）。初期化の失敗は機能を落として続ける
   - モジュールは attachWorld で src/gfx/<m>/index.js を動的 import する。
     読み込み・init に失敗したモジュールは core のスタブ（stubs/<m>.js）に戻す。
     ?ng=-trees,-grass でモジュールを外す（sky と post は外すとスタブになる）
   =========================================================== */
import * as THREE from 'three';
import { installNg, verifyNg } from './chunks.js';
import { NgFrame, NG, NG_PASS, ngFrameData } from './frame.js';
import { NG_LAYER, NG_MASK, ngOwn } from './layers.js';
import { Quality, NG_TIERS, normalizeTier } from './quality.js';
import { Safety } from './safe.js';
import { Budget } from './budget.js';
import { Wind } from './wind.js';
import { Forge } from './forge.js';
import { Targets } from './targets.js';
import { Shadows } from './shadows.js';
import { HeightField } from './heightfield.js';
import { FramePipeline } from './pipeline.js';
import { measureMsaa, decideMsaa } from './msaa.js';
import { NG_MODULE_IDS, Services, ngServiceDefaults } from './module.js';
import { ngExtendContext } from './extend.js';
import { fogNearFar } from './medium.js';
import { waveHeight, shoalGain } from '../../waveField.js?v=20260828-lakescale1';
import { wavePhases } from './glsl/wave.glsl.js';
import { createCausticsUniforms } from '../../shaders.js';
import * as STUBS from './stubs/index.js';

/** chunks の状態（import 時に 1 回） */
export const ngChunks = installNg(THREE);
/** ファサードとモジュールが core の入口だけから import できるように再 export する */
export { installNg, NG_LAYER, NG_MASK, NG_PASS, NG, ngFrameData, ngOwn, NG_TIERS };

/* モジュールの本体（担当者の index.js）。読み込み失敗はスタブで受ける */
const MODULE_URL = (id) => new URL(`../${id}/index.js`, import.meta.url).href;
const REQUIRED = new Set(['sky', 'post']);

let current = null;

/** 今の gfx（無ければ null） */
export function getGfx() { return current; }

/**
 * gfx を作る（同じ scene なら既存を返す）
 * @param {{scene: THREE.Scene, disabled?: string[], gpuTimers?: 'off'|'sync'|'query', only?: string[]|null}} o
 *   gpuTimers：GPU 計測の既定の方式（URL の ?gpuTimer= が優先。budget.js）。
 *   only：lab 用。ここに挙げたモジュールだけ担当者の index.js を読み、残りは core のスタブ
 * @returns {Gfx}
 */
export function createGfx(o) {
  if (current && current.scene === o.scene) return current;
  current?.dispose();
  current = new Gfx(o);
  return current;
}

function parseDisabled() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('ng') || '';
    return q.split(',').map((s) => s.trim()).filter((s) => s.startsWith('-')).map((s) => s.slice(1));
  } catch (e) { return []; }
}

/**
 * 描画の芯。ファサードから見える名前は §4.13 のとおり
 */
export class Gfx {
  constructor({ scene, disabled = parseDisabled(), gpuTimers = 'off', only = null }) {
    this.THREE = THREE;
    this.scene = scene;
    this.chunks = ngChunks;
    this.frame = new NgFrame();
    this.quality = new Quality('mid');
    this.safety = new Safety();
    /** デバッグ表示の登録表（services.post.registerDebugView → lab の view(name)） */
    this.debugViews = new Map();
    this._uwCtx = null;
    this.services = new Services(this.safety, ngServiceDefaults(THREE, {
      frame: this.frame,
      underwaterContext: (cam) => this._underwaterFallback(cam),
      registerDebugView: (name, glsl, uniforms) => this.registerDebugView(name, glsl, uniforms),
    }));
    this.wind = new Wind(this.frame);
    this.layers = NG_LAYER;
    this.disabled = new Set(disabled);
    this.only = only ? new Set(only) : null;
    this.gpuTimers = gpuTimers;
    /** @type {Map<string, import('./module.js').NgModule>} */
    this.modules = new Map();
    this.renderer = null;
    this.camera = null;
    this.forge = null;
    this.targets = null;
    this.budget = new Budget(null);
    this.pipeline = null;
    this.heightfield = null;
    this.shadows = new Shadows(THREE, this.frame, null);
    this.shadows.configure(this.quality.profile);
    this.rig = { key: null, probe: null, lamp: null };
    this.world = null;
    this.caustics = null;
    this.ready = false;
    /** MSAA の実測と判定（probeMsaa。未実測は null） */
    this.msaa = null;
    this._gpuSync = null;
    this._envTime = 0;
    this._hour = 12;
    this._uwView = false;
    this._lod = 1;
    this._flow = { dir: new THREE.Vector2(1, 0), strength: 0 };
    this._camPos = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this._keyDir = new THREE.Vector3(0, 1, 0);
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._weather = { key: 'clear', cloud: 0.14, rain: 0 };
    this._waterTime = 0;
    this._waterWind = 1;
    /** モジュールの update / prepare に渡す f（毎フレーム書き換える同じオブジェクト） */
    this.f = {
      dt: 0, realDt: 0, sdt: 0, envTime: 0, waterTime: 0, waterWind: 1, hour: 12, camera: null, camPos: this._camPos,
      focus: this._focus, frameIndex: 0, paused: false, uw: 0, flowDir: this._flow.dir, flowStrength: 0,
      keyDir: this._keyDir, sunDir: this._sunDir, weather: this._weather, tier: this.quality.tier,
    };
    /* 水の光学の既定（underwater モジュールが毎フレーム上書きする）と露出 1 */
    this.frame.set(NG.W_SIGMA, 0.20, 0.075, 0.045, 0.03);
    this.frame.set(NG.W_INSC, 0.02, 0.05, 0.06, 1);
    this.frame.set(NG.EXPO, 1, 1, 0, 0);
    /* スタブは renderer 無しで作れる（sky の producer は init 前でも動く） */
    this._skyStub = STUBS.sky(this._ctx());
    /* 代わりの producer は別の id で数える（sky モジュールが無効化されても、こちらは生き残る） */
    this._skyFallback = { id: 'sky-fallback', produce: (input) => this._skyStub.produce(input) };
    /** 読み込みの実時間（ms）。attachWorld の内訳（高さ場・モジュールごとの init）と warmup の内訳。
     *  spikes.md の «追加の読み込み» と、モジュールの読み込み予算（§6）の確かめに使う */
    this.loadStats = { heightfield: 0, modules: {}, attachWorld: 0, warmup: null };
    /** 無効化したモジュールをスタブで立て直した回数（スタブ自身の作り直しは 1 セッション 1 回まで） */
    this._restarts = new Map();
    this.safety.onDisable = (id) => this._onModuleDisabled(id);
    this.quality.onQuality((tier, profile) => this._applyQuality(tier, profile));
    this._modulesLoading = this._importModules();
  }

  /** chunks の自己検査が落ちたら 'fog' */
  get degraded() { return this.chunks.degraded; }

  _ctx() {
    return {
      THREE, renderer: this.renderer, scene: this.scene, camera: this.camera, tier: this.quality.tier,
      profile: this.quality.profile, lake: this.world?.lake || null, terrain: this.world?.terrain || null,
      heightfield: this.heightfield, placement: this.world?.placement || null, frame: this.frame, wind: this.wind,
      pipeline: this.pipeline, shadows: this.shadows, forge: this.forge, workers: null, caustics: this.caustics,
      services: this.services, budget: this.budget, gfx: this,
      log: (...a) => this.safety.warn(...a),
    };
  }

  /* 担当者の index.js を先に読み始める（attachWorld で待つ） */
  _importModules() {
    const out = {};
    for (const id of NG_MODULE_IDS) {
      if (this.disabled.has(id) || (this.only && !this.only.has(id))) continue;
      out[id] = import(MODULE_URL(id)).then((m) => m, (e) => {
        this.safety.warn(`モジュール ${id} の読み込みに失敗、スタブで続行`, e);
        return null;
      });
    }
    return out;
  }

  /**
   * 光のリグを受け取る（Environment が起動時に作って渡す。以後ライト数は変えない）
   * @param {{key: THREE.DirectionalLight, probe: THREE.LightProbe, lamp: THREE.PointLight}} rig
   */
  setLightRig(rig) {
    this.rig = { key: rig.key || null, probe: rig.probe || null, lamp: rig.lamp || null };
    for (const l of Object.values(this.rig)) l?.layers?.enableAll();
    if (this.rig.key) this.shadows.setKey(this.rig.key);
  }

  /**
   * renderer を受け取る（冪等）。forge・RT・パイプラインを作り、chunks を自己検査する
   * @param {THREE.WebGLRenderer} renderer
   */
  attachRenderer(renderer) {
    if (this.renderer === renderer) return;
    this.renderer = renderer;
    renderer.shadowMap.enabled = renderer.shadowMap.enabled !== false;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.debug.onShaderError = this.safety.shaderErrorHandler();
    const ok = verifyNg(THREE, renderer);
    ngExtendContext.lightsHook = this.chunks.lightsHook;
    if (!ok) this.safety.warn('chunks の自己検査に失敗（組込みは THREE.Fog）');
    this.forge = new Forge(THREE, renderer, this.frame);
    this.shadows.forge = this.forge;
    this.targets = new Targets(THREE, renderer);
    this._gpuSync = gpuSync(renderer);
    this.budget.attach(renderer.getContext(), { mode: budgetMode(this.gpuTimers), sync: this._gpuSync });
    this.pipeline = new FramePipeline({
      THREE, renderer, scene: this.scene, frame: this.frame, shadows: this.shadows, quality: this.quality,
      targets: this.targets, budget: this.budget, safety: this.safety,
      frameInfo: () => this.f,
      prepareModules: (f) => this._each('prepare', f),
      beforePass: (passId, cam) => this._each('beforePass', passId, cam),
      ownerOf: (o) => this._ownerOf(o),
    });
    this.pipeline.setReflectionHidden(this._reflHidden || []);
    if (this.camera) this.pipeline.setCamera(this.camera);
    this.pipeline.post = (t, dt) => this._post(t, dt);
    this.pipeline.onRestore = () => this._restoreGPU();
    this._wrapCompile(renderer);
  }

  /* renderer.compile を «mainRT を束縛して» コンパイルする形に包む。three はプログラムの鍵に描く先の色空間を入れる
     （画面 = sRGB、RT = リニア）が、シーンはいつも mainRT（と反射・影の RT）へ描く。game.js は読み込みと applyQuality で
     画面に対して renderer.compile を呼ぶので、包まないと全マテリアルで «使われない画面向け» のプログラムが 1 本ずつ増える
     （G0：sky・water・地形… が 2 本ずつ）。compileAsync も中で this.compile を呼ぶので同じく効く */
  _wrapCompile(renderer) {
    if (renderer.userData?.ngCompileWrapped) return;
    const compile = renderer.compile.bind(renderer);
    renderer.compile = (scene, camera, targetScene = null) => {
      let bound = false;
      if (renderer.getRenderTarget() === null) {
        this.safety.guardPass('targets', () => this.pipeline?._ensureTargets());
        const main = this.targets?.main;
        if (main) { renderer.setRenderTarget(main); bound = true; }
      }
      try { return compile(scene, camera, targetScene); } finally { if (bound) renderer.setRenderTarget(null); }
    };
    renderer.userData = { ...(renderer.userData || {}), ngCompileWrapped: true };
  }

  /** 描くカメラ（PostFX が渡す） */
  bindCamera(camera) {
    this.camera = camera;
    this.f.camera = camera;
    this.pipeline?.setCamera(camera);
  }

  /**
   * 世界を受け取り、高さ場・派生マップ・全モジュールの init を行う（terrain.ready の中身）。
   * 失敗しても reject しない（その機能を落として続ける）
   * @param {{lake:object, terrain?:object, placement?:object, grids?:Promise<object>|object, progress?:(f:number)=>void, caustics?:object}} o
   * @returns {Promise<void>}
   */
  attachWorld(o) {
    if (this._worldPromise) return this._worldPromise;
    this._worldPromise = this._attachWorld(o).catch((e) => {
      console.warn('[ng] attachWorld の失敗（グレーボックスで続行）', e);
    });
    return this._worldPromise;
  }

  async _attachWorld({ lake, terrain = null, placement = null, grids = null, progress = null, caustics = null }) {
    if (!this.renderer) throw new Error('attachRenderer の前に attachWorld が呼ばれた');
    this.world = { lake, terrain, placement };
    this.caustics = caustics || terrain?.causticsUniforms || terrain?._causticsUniforms || createCausticsUniforms();
    ngExtendContext.caustics = this.caustics;
    ngExtendContext.shadowUniforms = this.shadows.uniforms;
    ngExtendContext.tier = this.quality.tier;
    this.frame.setComp(NG.CORE, 1, meanShore(lake));
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    const prog = (a, b) => (f) => { try { progress?.(a + (b - a) * f); } catch (e) { /* 進捗の表示で落とさない */ } };
    this.heightfield = new HeightField(THREE, this.forge);
    try {
      await this.heightfield.build({ lake, grids, placement, progress: prog(0, 0.35) });
      this.shadows.attachHeightfield(this.heightfield.uniforms, this._keyDir);
    } catch (e) {
      console.warn('[ng] 高さ場の構築に失敗（地形の無いグレーボックス）', e);
    }
    this.loadStats.heightfield = Math.round(now() - t0);
    const loaded = this._modulesLoading;
    const ids = NG_MODULE_IDS.filter((id) => !this.disabled.has(id) || REQUIRED.has(id));
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const mod = loaded[id] ? await loaded[id] : null;
      const tm = now();
      await this._startModule(id, mod, prog(0.35 + 0.65 * (i / ids.length), 0.35 + 0.65 * ((i + 1) / ids.length)));
      this.loadStats.modules[id] = Math.round(now() - tm);
      await this.forge.step();
    }
    this.forge.releaseScratch();
    this.loadStats.attachWorld = Math.round(now() - t0);
    this.ready = true;
  }

  /* モジュールを作って init する。失敗したらスタブで作り直す */
  async _startModule(id, mod, progress) {
    const tryMake = async (factory, isStub) => {
      const m = factory(this._ctx());
      await m.init(progress);
      m.setQuality(this.quality.tier, this.quality.profile);
      m.setLodScale(this._lod);
      m._ngStub = isStub;
      return m;
    };
    let m = null;
    if (mod?.createModule) {
      try { m = await tryMake(mod.createModule, mod.createModule === STUBS[id]); } catch (e) {
        this.safety.warn(`モジュール ${id} の init に失敗、スタブへ`, e);
        this._cleanupRoot(id);
        this.services.reset(id);
      }
    }
    if (!m) {
      try { m = await tryMake(STUBS[id], true); } catch (e) {
        this.safety.warn(`スタブ ${id} の init にも失敗（この機能は無し）`, e);
        this._cleanupRoot(id);
        return;
      }
    }
    this.modules.set(id, m);
  }

  /* 物体の持ち主のモジュール（root «ng-<id>» の子孫なら id）。いちばん外側の root を採る
     （モジュールの中の物の名前が ng- で始まってもよい） */
  _ownerOf(o) {
    let id = null;
    for (let p = o; p; p = p.parent) {
      const n = p.name;
      if (p.userData?.ngOwned && typeof n === 'string' && n.startsWith('ng-') && this.modules.has(n.slice(3))) id = n.slice(3);
    }
    return id;
  }

  _cleanupRoot(id) {
    const r = this.scene.getObjectByName(`ng-${id}`);
    r?.parent?.remove(r);
  }

  /* 全モジュールの method を例外なしで呼ぶ */
  _each(method, ...args) {
    for (const m of this.modules.values()) this.safety.guard(m, method, ...args);
  }

  /* 3 回投げたモジュール：root を隠し、スタブで立て直す（水面・地形・空が消えるとゲームが読めない）。
     担当者の実装が落ちたらスタブへ差し戻す。スタブ自身が落ちたときも 1 回だけ新しいスタブで作り直す
     （同じ不具合なら次も落ちるので、それ以上は繰り返さず、隠したままにする） */
  _onModuleDisabled(id) {
    const m = this.modules.get(id);
    if (m) m.root.visible = false;
    if (!m || !STUBS[id]) return;
    const n = this._restarts.get(id) || 0;
    if (m._ngStub && n >= 1) return;
    this._restarts.set(id, n + 1);
    this.modules.delete(id);
    try { m.dispose(); } catch (e) { /* 落ちたモジュールの後片付けで落とさない */ }
    this.services.reset(id);
    this.safety.disabled.delete(id);
    this.safety.strikes.delete(id);
    /* post の P7 は guardPass でも数えている。止まっていたら新しい post で生き返らせる */
    if (id === 'post') this.safety.revivePass('post');
    console.warn(`[ng] モジュール ${id} をスタブで立て直す（${m._ngStub ? 'スタブの作り直し' : '担当者の実装から差し戻し'}）`);
    this._startModule(id, null, null);
  }

  /* シェーダが落ちたモジュール：次のフレームで Lambert の代替へ */
  _swapFailedShaders() {
    const failed = this.safety.shaderFailed;
    if (!failed.size) return;
    for (const id of failed) {
      const m = this.modules.get(id);
      m?.root.traverse((o) => {
        if (!o.material || o.material.userData?.ngFallback) return;
        const c = o.material.color || new THREE.Color(0.5, 0.5, 0.5);
        const lam = new THREE.MeshLambertMaterial({ color: c });
        lam.userData.ngFallback = true;
        o.material = lam;
        o.customDepthMaterial = undefined;
        o.customDistanceMaterial = undefined;
      });
    }
    failed.clear();
  }

  /**
   * フレームの始まり（Environment.update）。時刻・天候から ngFrame の空・光・大気を書き、
   * 光のリグ（key の向き・影の追従・SH）に適用し、ファサード用の値を返す
   * @param {{dt:number, hour:number, camera:THREE.Camera, focus?:THREE.Vector3, weather:{key:string, cloud:number, rain:number},
   *          nightAmount:number, sunDir:THREE.Vector3, keyDir:THREE.Vector3}} i
   * @returns {{colors:object, fog:{near:number, far:number, color:THREE.Color}, key:{color:THREE.Color, intensity:number}, sh:THREE.SphericalHarmonics3}|null}
   */
  beginFrame(i) {
    try {
      return this._beginFrame(i);
    } catch (e) {
      this.safety.warn('beginFrame が例外', e);
      return null;
    }
  }

  _beginFrame(i) {
    this.pipeline?.beginFrame();
    this._swapFailedShaders();
    const dt = Number.isFinite(i.dt) ? Math.max(0, i.dt) : 0;
    this._envTime += dt;
    this._hour = Number.isFinite(i.hour) ? i.hour : this._hour;
    if (i.camera && !this.camera) this.bindCamera(i.camera);
    const cam = i.camera || this.camera;
    if (i.sunDir) this._sunDir.copy(i.sunDir);
    if (i.weather) Object.assign(this._weather, i.weather);
    const focus = i.focus || cam?.position;
    if (focus) this._focus.copy(focus);
    if (cam) this._camPos.copy(cam.position);
    const fi = this.pipeline ? this.pipeline.state.frameIndex : 0;
    const f = this.f;
    Object.assign(f, {
      dt, realDt: dt, sdt: dt, envTime: this._envTime, hour: this._hour, camera: cam, frameIndex: fi, paused: dt === 0,
      tier: this.quality.tier,
    });
    this.frame.set(NG.TIME, this._hour, this._waterTime, this._envTime, fi % 1024);
    this.frame.set(NG.FOCUS, this._focus.x, this._focus.y, this._focus.z, this._lod);
    this.wind.setState(this._hour, this._weather.cloud, this._weather.rain, this._envTime);
    const sky = this._skyProducer();
    const input = { ...i, dt, envTime: this._envTime, camera: cam, weather: this._weather };
    const res = (sky !== this._skyStub && this.safety.guard(sky, 'produce', input)) || this.safety.guard(this._skyFallback, 'produce', input);
    if (!res) return null;
    const kd = res.keyDir;
    this._keyDir.set(kd[0], kd[1], kd[2]);
    this._applyRig(res);
    if (cam) {
      const fnf = fogNearFar(this.frame.data, cam.position);
      res.fog.near = fnf.near; res.fog.far = fnf.far;
    }
    return res;
  }

  /* init が済んだ sky モジュールが居ればそれ、無ければスタブ（init 前でも動く） */
  _skyProducer() {
    const m = this.modules.get('sky');
    return m && typeof m.produce === 'function' ? m : this._skyStub;
  }

  _applyRig(res) {
    const { key, probe } = this.rig;
    if (key) {
      key.color.copy(res.key.color);
      key.intensity = res.key.intensity;
      this.shadows.fit(this._focus, this._keyDir, this._weather.cloud);
    }
    if (probe && res.sh) probe.sh.copy(res.sh);
  }

  /**
   * 水中カメラの見た目（Environment.underwater / Water.setUnderwaterView）
   * @param {boolean} on
   */
  setUnderwater(on) {
    this._uwView = !!on;
    if (this.pipeline) this.pipeline.state.underwater = this._uwView;
  }

  /**
   * Water.update の中から。水の時刻・風・水中の状態・caustics の動く値（underwater モジュール）
   * @param {{sdt:number, time:number, wind:number, camera:THREE.Camera}} o
   */
  waterUpdate({ sdt = 0, time = 0, wind = 1, camera = null } = {}) {
    this._waterTime = Number.isFinite(time) ? time : this._waterTime;
    this._waterWind = Number.isFinite(wind) ? wind : this._waterWind;
    const f = this.f;
    f.sdt = sdt; f.waterTime = this._waterTime; f.waterWind = this._waterWind;
    this.frame.setComp(NG.TIME, 1, this._waterTime);
    this._writeWavePhases();
    const cam = camera || this.camera;
    if (cam) this._updateUnderwaterState(cam);
    const uw = this.modules.get('underwater');
    if (uw) this.safety.guard(uw, 'waterUpdate', f);
  }

  /* 波の位相（倍精度の mod(t·ω, 2π)）を slot 19 / 20 へ。GPU の ngWaveH が CPU の surfaceY と
     何時間遊んでもずれない（glsl/wave.glsl.js、core-requests B-2） */
  _writeWavePhases() {
    const ph = wavePhases(this._waterTime, this._wavePh || (this._wavePh = new Float64Array(5)));
    this.frame.set(NG.WAVEPH_A, ph[0], ph[1], ph[2], ph[3]);
    this.frame.setComp(NG.WAVEPH_B, 0, ph[4]);
  }

  /* カメラ位置の水面の高さ（waveField と同じ式）と、水中の度合い */
  _updateUnderwaterState(cam) {
    const p = cam.position;
    const lake = this.world?.lake;
    const depth = lake ? lake.depthAt(p.x, p.z) : 10;
    const wy = depth <= 0 ? 0 : waveHeight(p.x, p.z, this._waterTime, this._waterWind) * shoalGain(depth);
    const d = p.y - wy;
    const geo = d < -0.05 ? 1 : d > 0.05 ? 0 : 0.5 - d * 10;
    const uw = this._uwView ? Math.max(geo, d < 0.1 ? 1 : 0) : geo;
    this.frame.cam.uw = uw;
    this.frame.cam.waterY = wy;
    this.f.uw = uw;
  }

  /**
   * 全モジュールの CPU 更新（Terrain.updateTrees）。
   * game.js はポーズ中も «実時間の» dt を渡してくるので、f.dt には書かない（beginFrame の環境の dt のまま。
   * ポーズで 0 = CORE_API §3.4）。実時間は f.realDt に置く（ポーズ中も動いてよい LOD の切り替えだけが使う）
   * @param {{dt?:number, camPos?:THREE.Vector3}} o
   */
  updateModules({ dt, camPos } = {}) {
    if (camPos) this._camPos.copy(camPos);
    this.f.realDt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this._each('update', this.f);
  }

  /** 水中の流れ（Terrain.updateUnderwaterProps） */
  setFlow(flowDir, flowStrength) {
    if (flowDir) this._flow.dir.set(flowDir.x ?? 1, flowDir.y ?? flowDir.z ?? 0);
    this.f.flowStrength = Number.isFinite(flowStrength) ? flowStrength : 0;
  }

  /** LOD 倍率 */
  setLodScale(k) {
    if (!Number.isFinite(k)) return;
    this._lod = k;
    this.frame.setComp(NG.FOCUS, 3, k);
    this._each('setLodScale', k);
  }

  /**
   * 品質（冪等。どのファサードから呼んでもよい）
   * @param {string} q 'low' | 'mid' | 'high'
   */
  setQuality(q) { this.quality.set(normalizeTier(q)); }

  _applyQuality(tier, profile) {
    if (tier === 'high' && !this.msaa && this.ready) {
      /* 降格が決まると onQuality がもう一度（降格した profile で）呼ばれるので、こちらは打ち切る */
      const before = this.quality.msaaFallback;
      this.probeMsaa();
      if (this.quality.msaaFallback !== before) return;
    }
    ngExtendContext.tier = tier;
    this.f.tier = tier;
    this.shadows.configure(profile);
    this.pipeline?.setQuality(tier);
    this._each('setQuality', tier, profile);
    this._releaseStalePrograms();
  }

  /* 段の切り替えで古い段のプログラムを手放す。ngExtendStandard の鍵には段が入るので、three は
     マテリアルごとに «前の段のプログラム» を持ち続ける（low → mid → high → mid で 2 倍近くに増える）。
     dispose はマテリアルの GL 側の状態だけを捨てる（テクスチャや uniform はそのまま、次の描画で組み直す） */
  _releaseStalePrograms() {
    if (!this.renderer) return;
    const seen = new Set();
    this.scene.traverse((o) => {
      const m = o.material;
      if (!m || Array.isArray(m) || seen.has(m) || !m.userData?.ngTiered) return;
      seen.add(m);
      for (const x of [m, m.userData.ngDepth, m.userData.ngDistance]) {
        try { x?.dispose(); } catch (e) { /* 片付けで落とさない */ }
      }
    });
  }

  /**
   * MSAA 4× の «resolve 後の再描画» の上乗せを実測し、閾値を超えたら high を 2× + SMAA に落とす
   * （msaa.js、docs/nextgen/spikes.md S-1）。1 セッション 1 回（≈ 60ms）。high に入った最初の機会に呼ばれる
   * @param {{force?: boolean}} [o]
   * @returns {{probe: object, decision: {fallback: boolean, reason: string}}|null}
   */
  probeMsaa({ force = false } = {}) {
    if (!this.renderer || (this.msaa && !force)) return this.msaa || null;
    let override = null;
    try { override = new URLSearchParams(globalThis.location?.search || '').get('msaa'); } catch (e) { /* Node */ }
    try {
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const k = this.pipeline?.renderScale || 1;
      const probe = override ? null : measureMsaa(THREE, this.renderer, {
        width: Math.max(64, Math.round(s.x * k)), height: Math.max(64, Math.round(s.y * k)), sync: this._gpuSync,
      });
      const decision = decideMsaa(probe || { cost2: 0, cost4: 0, maxSamples: 4 }, override);
      this.msaa = { probe, decision };
      if (decision.fallback) console.info(`[ng] MSAA を 2× + SMAA に落とす：${decision.reason}`);
      this.quality.setMsaaFallback(decision.fallback);
    } catch (e) {
      this.safety.warn('MSAA の実測に失敗（4× のまま）', e);
      this.msaa = { probe: null, decision: { fallback: false, reason: '実測に失敗' } };
    }
    return this.msaa;
  }

  /** 反射に写さない物（Water.setReflectionHidden） */
  setReflectionHidden(list) {
    this._reflHidden = list || [];
    this.pipeline?.setReflectionHidden(this._reflHidden);
  }

  /**
   * 水中の文脈（旧 Water.getUnderwaterContext と同じ形）
   * @param {THREE.Camera} camera
   * @returns {{strength:number, time:number, sunDir:THREE.Vector3, night:number, rain:number, cloud:number,
   *            absorb:THREE.Vector3, camPos:THREE.Vector3, camNear:number, camFar:number, waterY:number}}
   */
  getUnderwaterContext(camera) {
    const cam = camera || this.camera;
    return this.services.underwater.getUnderwaterContext(cam) || this._underwaterFallback(cam);
  }

  /* underwater モジュールが居ないときの文脈（ngFrame から。同じオブジェクトを書き換えて返す） */
  _underwaterFallback(cam) {
    const F = this.frame.data;
    const c = this._uwCtx || (this._uwCtx = {
      strength: 0, time: 0, sunDir: new THREE.Vector3(), night: 0, rain: 0, cloud: 0, absorb: new THREE.Vector3(),
      camPos: new THREE.Vector3(), camNear: 0.1, camFar: 3000, waterY: 0,
    });
    c.strength = this.frame.cam.uw;
    c.time = this._waterTime;
    c.sunDir.copy(this._keyDir);
    c.night = F[NG.KEY * 4 + 3];
    c.rain = this._weather.rain;
    c.cloud = this._weather.cloud;
    c.absorb.set(F[NG.W_SIGMA * 4], F[NG.W_SIGMA * 4 + 1], F[NG.W_SIGMA * 4 + 2]);
    if (cam) { c.camPos.copy(cam.position); c.camNear = cam.near ?? 0.1; c.camFar = cam.far ?? 3000; }
    c.waterY = this.frame.cam.waterY;
    return c;
  }

  /**
   * デバッグ表示を登録する（services.post.registerDebugView の本体）。lab の view(name) で全画面に出る。
   * glsl は «vec4 ngDebug(vec2 uv)» を定義する断片シェーダの部品。使える入力は NG_FRAME の #define、
   * pipeline の共有 uniforms（ngSceneColor・ngSceneDepth・ngReflection・ngScreen）と、渡した uniforms。
   * 出力は表示する色（リニア、0..1 に収めて sRGB で出す）
   * @param {string} name
   * @param {string} glsl
   * @param {Record<string, {value:any}>} [uniforms]
   */
  registerDebugView(name, glsl, uniforms = {}) {
    if (typeof name !== 'string' || typeof glsl !== 'string') return;
    this.debugViews.set(name, { glsl, uniforms });
  }

  /** 描画バッファの大きさ（PostFX.setSize） */
  setSize(w, h) {
    this.pipeline?.setSize(w, h);
    const post = this.modules.get('post');
    if (post) this.safety.guard(post, 'setSize', w, h);
  }

  /* post モジュールの描画（パイプラインの P7）。未初期化なら false（パイプラインが簡易表示する） */
  _post(targets, dt) {
    const post = this.modules.get('post');
    if (!post || typeof post.renderPost !== 'function') return false;
    post.renderPost(targets, dt);
    return true;
  }

  /**
   * 読み込みの最後（PostFX.warmup）：compileAsync + 各パスの空回し 3 フレーム
   * @returns {Promise<void>}
   */
  async warmup() {
    const r = this.renderer, cam = this.camera;
    if (!r || !cam) return;
    const now = () => performance.now();
    const w = { wait: 0, compile: 0, msaa: 0, frames: 0, total: 0 };
    let t = now();
    const t0 = t;
    const lap = (k) => { const n = now(); w[k] = Math.round(n - t); t = n; };
    try { await this._worldPromise; } catch (e) { /* attachWorld は reject しない */ }
    lap('wait');
    try {
      const mask = cam.layers.mask;
      cam.layers.enableAll();
      /* three はプログラムの鍵に «描く先» の色空間を入れる（画面 = sRGB、RT = リニア）。シーンはいつも mainRT へ
         描くので、mainRT を束縛してからコンパイルする（画面向けに作ると、使われないプログラムが全部の
         マテリアルで 1 本ずつ増え、読み込み時間とプログラムの予算を食う）。compile の本体は同期で、
         待つのは KHR_parallel_shader_compile の完了だけなので、束縛は compile の呼び出しの間だけでよい */
      const prev = r.getRenderTarget();
      this.safety.guardPass('targets', () => this.pipeline._ensureTargets());
      if (this.targets?.main) r.setRenderTarget(this.targets.main);
      let done;
      try { done = r.compileAsync(this.scene, cam); } finally { r.setRenderTarget(prev); cam.layers.mask = mask; }
      await done;
    } catch (e) { this.safety.warn('compileAsync に失敗（同期コンパイルで続行）', e); }
    const post = this.modules.get('post');
    if (post) {
      try { await post.compile?.(); } catch (e) { this.safety.warn('post の compile に失敗', e); }
    }
    lap('compile');
    if (this.quality.tier === 'high') this.probeMsaa();
    lap('msaa');
    for (let k = 0; k < 3; k++) {
      this.pipeline.beginFrame();
      this.pipeline.renderMain(0);
      await new Promise((res) => setTimeout(res, 0));
    }
    lap('frames');
    w.total = Math.round(now() - t0);
    this.loadStats.warmup = w;
  }

  /* 文脈の復帰：焼いた RT を作り直す */
  _restoreGPU() {
    this.heightfield?.restoreGPU();
    this.shadows.restoreGPU(this._keyDir);
    this._each('restoreGPU');
  }

  /** lab と budget 用の集計 */
  stats() {
    const out = { modules: {}, gpuMs: { ...this.budget.gpuMs }, cpuMs: { ...this.budget.cpuMs }, rtBytes: this.targets?.bytes() || 0 };
    for (const [id, m] of this.modules) {
      out.modules[id] = { stub: !!m._ngStub, disabled: this.safety.disabled.has(id), ...(this.safety.guard(m, 'stats') || {}) };
    }
    return out;
  }

  dispose() {
    for (const m of this.modules.values()) this.safety.guard(m, 'dispose');
    this.modules.clear();
    this.pipeline?.dispose();
    this.forge?.dispose();
    if (current === this) current = null;
  }
}

/* 計測の方式：?gpuTimer=sync|query|1（1 は query）。lab は gpuTimers で 'sync' を指定できる */
function budgetMode(opt) {
  let q = null;
  try { q = new URLSearchParams(globalThis.location?.search || '').get('gpuTimer'); } catch (e) { /* Node */ }
  const m = q === '1' ? 'query' : q || (typeof opt === 'string' ? opt : 'off');
  return m;
}

/* GPU の完了を待つ。1×1 の RT を «塗ってから» 読む：ANGLE/Metal は読む資源に未完了の書き込みが
   無ければ待たずに返すので、塗り（キューの最後）を待たせて、それより前の仕事の完了を保証する。
   three の束縛を壊さないよう setRenderTarget / readRenderTargetPixels 越しに */
function gpuSync(renderer) {
  let rt = null;
  const px = new Uint8Array(4);
  return () => {
    rt = rt || new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prev);
    renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, px);
  };
}

/* 湖の平均の汀線半径（朝霧の湖上マスク用） */
function meanShore(lake) {
  if (!lake?.shoreAtAngle) return 0;
  let s = 0;
  for (let k = 0; k < 32; k++) s += lake.shoreAtAngle((k / 32) * Math.PI * 2);
  return s / 32;
}
