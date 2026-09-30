/* ===========================================================
   lab キット（ARCHITECTURE §4.12）
   -----------------------------------------------------------
   Lab.boot({ modules, seed, tier, size, characters }) で «本物の湖・高さ場・placement・
   パイプライン・post» を組み、要求したモジュールだけ担当者の index.js を読み、残りは
   core のスタブで埋める。フレームの順は game.js と同じ（§3.1）。
   window.__lab = { setHour, setWeather, setTier, cam, freeze, tick, view, stats, nanCheck, gfx, ... }
   window.__gfxReady = true は compileAsync と 3 フレームの空回しの後。
   画面の隅にグレー球（0.18）・クロム球・24 パッチのチャート（?chart=0 で消す）
   =========================================================== */
import * as THREE from 'three';
import { createGfx } from '../index.js';
import { NG_LAYER, ngOwn } from '../layers.js';
import { NG } from '../frame.js';
import { NG_CHART_24, ngLuminance } from '../palette.js';
import { resolveLake } from '../../../lakefield.js';
import { buildHeightGrids } from '../../../world/heightgrid.js';
import { buildPlacement } from '../../../world/placement.js';
import { makeDock } from '../../../world/dock.js';
import { createCausticsUniforms } from '../../../shaders.js';

/** 旧 sky.js の WEATHERS と同じ cloud / rain */
export const LAB_WEATHERS = Object.freeze({
  clear: { key: 'clear', cloud: 0.14, rain: 0 },
  cloudy: { key: 'cloudy', cloud: 0.72, rain: 0 },
  rain: { key: 'rain', cloud: 0.95, rain: 0.85 },
});

const DEBUG_FS = /* glsl */ `
precision highp float;
uniform sampler2D tMap;
uniform int uMode;       // 0 色（露出×Reinhard）, 1 深度（log）, 2 生の値, 3 false color（EV の帯）
uniform float uExposure;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
vec3 band(float ev) {
  /* 18% 灰を 0 とした EV の帯：-6 紫, -4 青, -2 水, 0 緑, +2 黄, +4 橙, +6 赤 */
  vec3 c[7] = vec3[7](vec3(0.3, 0.0, 0.5), vec3(0.0, 0.1, 0.8), vec3(0.0, 0.6, 0.8), vec3(0.1, 0.7, 0.1), vec3(0.9, 0.9, 0.1), vec3(1.0, 0.5, 0.0), vec3(1.0, 0.0, 0.0));
  float t = clamp((ev + 6.0) / 2.0, 0.0, 6.0);
  int i = int(floor(t));
  return mix(c[i], c[min(i + 1, 6)], fract(t) > 0.9 ? 1.0 : 0.0);
}
void main() {
  vec4 v = texture(tMap, vUv);
  vec3 c;
  if (uMode == 1) c = vec3(log2(1.0 + v.r) / log2(3001.0));
  else if (uMode == 2) c = v.rgb;
  else if (uMode == 3) {
    float L = dot(max(v.rgb, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722)) * uExposure;
    c = band(log2(max(L, 1e-6) / 0.18));
  } else { c = max(v.rgb, vec3(0.0)) * uExposure; c = c / (1.0 + c); }
  oColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;
const DEBUG_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * lab の起動
 */
export const Lab = {
  /**
   * @param {{modules?:string[], seed?:number, tier?:string, size?:[number,number]|null, characters?:boolean,
   *          canvas?:HTMLCanvasElement, chart?:boolean, onProgress?:(t:string)=>void}} o
   * @returns {Promise<object>} window.__lab と同じもの
   */
  async boot(o = {}) {
    const q = new URLSearchParams(location.search);
    const seed = o.seed ?? 123456789;
    const tier = q.get('tier') || o.tier || 'high';
    const chart = q.get('chart') !== '0' && o.chart !== false;
    const say = (t) => { try { o.onProgress?.(t); } catch (e) { /* 表示で落とさない */ } };
    const canvas = o.canvas || document.querySelector('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    const dpr = Number(q.get('dpr')) || 1;
    renderer.setPixelRatio(dpr);
    const [W, H] = o.size || [innerWidth, innerHeight];
    renderer.setSize(W, H, !o.size);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.info.autoReset = false;   // 1 フレームに render() が何度もあるので、フレームの頭で手で戻す
    window.__renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x888888, 100, 1000);
    const camera = new THREE.PerspectiveCamera(58, W / H, 0.1, 3000);
    scene.add(camera);

    say('lake');
    const resolved = resolveLake(seed);
    const lake = resolved.lake;
    const gfx = createGfx({ scene, gpuTimers: true, only: o.modules || [] });
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.castShadow = true;
    const target = new THREE.Object3D();
    key.target = target;
    const probe = new THREE.LightProbe();
    const lamp = new THREE.PointLight(0xffa64d, 0, 26, 2);
    lamp.position.set(0, -1000, 0);
    scene.add(key, target, probe, lamp);
    gfx.setLightRig({ key, probe, lamp });
    gfx.attachRenderer(renderer);
    gfx.bindCamera(camera);
    gfx.setQuality(tier);
    const caustics = createCausticsUniforms();
    say('placement');
    const placement = buildPlacement(lake);
    const dock = makeDock(lake);
    say('world');
    const t0 = performance.now();
    await gfx.attachWorld({
      lake, placement, caustics, grids: buildHeightGrids(lake, { resolvedSeed: resolved.seed }),
      progress: (f) => say(`world ${(f * 100) | 0}%`),
    });
    const worldMs = performance.now() - t0;

    /* キャラクター（本物の Angler と魚 6 匹） */
    const chars = { angler: null, fish: [] };
    if (o.characters !== false) {
      say('characters');
      try {
        const [{ Angler }, fishMod, data] = await Promise.all([
          import('../../../angler.js'), import('../../../fish.js'), import('../../../data.js'),
        ]);
        const a = new Angler(scene);
        await a.load(() => {});
        a.setPosition(dock.spawnPos.x, dock.spawnPos.y, dock.spawnPos.z);
        a.setYaw(Math.atan2(dock.dockDir.x, dock.dockDir.z));
        chars.angler = a;
        const cache = new Map();
        const real = data.REAL_FISH;
        for (let i = 0; i < 6; i++) {
          const f = new fishMod.Fish(cache, () => fishMod.createFishMaterial(0.4, caustics));
          const d = 3 + i * 1.4;
          const px = dock.dockEnd.x + dock.dockDir.x * (4 + i * 1.5) + (i - 2.5) * 1.2 * dock.dockDir.z;
          const pz = dock.dockEnd.z + dock.dockDir.z * (4 + i * 1.5) - (i - 2.5) * 1.2 * dock.dockDir.x;
          const bed = lake.heightAt(px, pz);
          f.spawn(real[(i * 7) % real.length], 35 + i * 6, new THREE.Vector3(px, Math.max(bed + 0.5, -d * 0.5), pz));
          f.mesh.rotation.y = Math.atan2(dock.dockDir.x, dock.dockDir.z) + i;
          chars.fish.push(f);
        }
      } catch (e) {
        console.warn('[lab] キャラクターの読み込みに失敗', e);
      }
    }

    /* 隅のチャート（カメラの子。NO_REFLECT で反射に写さない） */
    const chartGroup = new THREE.Group();
    if (chart) {
      const grey = new THREE.Mesh(new THREE.SphereGeometry(0.035, 24, 16), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.18, 0.18, 0.18), roughness: 0.8, metalness: 0 }));
      const chrome = new THREE.Mesh(new THREE.SphereGeometry(0.035, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 1 }));
      grey.position.set(0, 0, 0); chrome.position.set(0.085, 0, 0);
      chartGroup.add(grey, chrome);
      const pg = new THREE.PlaneGeometry(0.022, 0.022);
      NG_CHART_24.forEach((c, i) => {
        const m = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.9, metalness: 0 }));
        m.position.set(-0.03 + (i % 6) * 0.025 + 0.1, -0.075 + Math.floor(i / 6) * 0.025 + 0.02, 0);
        chartGroup.add(m);
      });
      chartGroup.position.set(-0.56 * camera.aspect / 1.78, -0.3, -1.0);
      chartGroup.rotation.x = 0.25;
      ngOwn(chartGroup, NG_LAYER.NO_REFLECT);
      camera.add(chartGroup);
    }

    const lab = makeLabApi({ renderer, scene, camera, gfx, lake, dock, placement, caustics, chars, worldMs });
    window.__lab = lab;
    say('compile');
    await gfx.warmup();
    lab._loop();
    window.__gfxReady = true;
    say('');
    return lab;
  },
};

/* __lab の中身 */
function makeLabApi(env) {
  const { renderer, scene, camera, gfx, lake, dock, chars } = env;
  const st = {
    hour: 12, weather: { ...LAB_WEATHERS.clear }, target: LAB_WEATHERS.clear, time: 0, waterTime: 0,
    frozen: false, running: true, view: null, frames: 0, fps: 0, lastT: performance.now(), fpsT: 0, fpsN: 0,
  };
  const sunDir = new THREE.Vector3(), keyDir = new THREE.Vector3(), focus = new THREE.Vector3();
  const dbg = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: DEBUG_VS, fragmentShader: DEBUG_FS, depthTest: false, depthWrite: false,
    uniforms: { tMap: { value: null }, uMode: { value: 0 }, uExposure: { value: 1 } },
  });
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const dbgScene = new THREE.Scene(), dbgMesh = new THREE.Mesh(tri, dbg);
  dbgMesh.frustumCulled = false;
  dbgScene.add(dbgMesh);
  const dbgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function frame(dt) {
    const sdt = st.frozen ? 0 : dt;
    st.time += sdt;
    st.waterTime += sdt;
    const w = st.weather, tg = st.target;
    w.cloud += (tg.cloud - w.cloud) * (1 - Math.exp(-0.4 * sdt));
    w.rain += (tg.rain - w.rain) * (1 - Math.exp(-0.35 * sdt));
    w.key = tg.key;
    const t = ((st.hour % 24) + 24) % 24;
    const a = ((t - 6) / 24) * Math.PI * 2;
    sunDir.set(Math.cos(a), Math.sin(a), 0.34).normalize();
    const night = Math.min(1, Math.max(0, smooth(0.08, -0.16, sunDir.y)));
    keyDir.copy(sunDir).multiplyScalar(sunDir.y > -0.0175 ? 1 : -1);
    focus.copy(chars.angler ? chars.angler.root.position : camera.position);
    renderer.info.reset();
    const res = gfx.beginFrame({ dt: sdt, hour: st.hour, camera, focus, weather: { ...w }, nightAmount: night, sunDir, keyDir });
    if (res && scene.fog) { scene.fog.near = res.fog.near; scene.fog.far = res.fog.far; scene.fog.color.copy(res.fog.color); }
    gfx.wind.update(st.time, 1);
    gfx.updateModules({ dt: sdt, camPos: camera.position });
    gfx.services.hardscape.setLamp(night, sdt);
    gfx.waterUpdate({ sdt, time: st.waterTime, wind: 1 + w.rain * 0.92 + w.cloud * 0.14, camera });
    gfx.setUnderwater(camera.position.y < gfx.frame.cam.waterY);
    if (chars.angler) {
      try {
        chars.angler.update(sdt, { state: 'idle', charge: 0, tension: 0, moving: 0, speed: 0, reeling: 0, rarity: 0, time: st.time, lineEnd: null });
      } catch (e) { /* キャラクターの更新で lab を止めない */ }
    }
    for (const f of chars.fish) f.mesh.material.userData.u.uTime.value = st.time;
    gfx.pipeline.prepare();
    gfx.pipeline.renderReflection();
    gfx.pipeline.renderMain(sdt);
    if (st.view) drawView(st.view);
    st.frames++;
  }

  function drawView(name) {
    const t = gfx.targets, u = dbg.uniforms;
    const views = {
      refl: [t.refl.texture, 0], sceneColor: [t.copy.textures[0], 0], depth: [t.copy.textures[1], 1],
      nearShadow: [gfx.rig.key?.shadow?.map?.texture, 2], hfShadow: [gfx.shadows.uniforms.ngHfShadow1.value, 2],
      hfShadow0: [gfx.shadows.uniforms.ngHfShadow0.value, 2], skyView: [gfx.services.sky.skyViewTex, 0],
      falseColor: [t.main.texture, 3],
    };
    const v = views[name];
    if (!v || !v[0]) return;
    u.tMap.value = v[0];
    u.uMode.value = v[1];
    u.uExposure.value = gfx.frame.get(NG.EXPO, 0) || 1;
    renderer.setRenderTarget(null);
    renderer.render(dbgScene, dbgCam);
  }

  const api = {
    gfx, renderer, scene, camera, lake, dock, placement: env.placement, worldMs: env.worldMs,
    /** 時刻（0..24） */
    setHour(h) { st.hour = h; },
    /** 天候。instant: true で damp を飛ばす */
    setWeather(k, { instant = false } = {}) {
      const w = LAB_WEATHERS[k];
      if (!w) return;
      st.target = w;
      if (instant) Object.assign(st.weather, w);
    },
    /** 品質 */
    setTier(t) { gfx.setQuality(t); },
    /** カメラ：プリセット名 か {pos:[x,y,z], target:[x,y,z]} */
    cam(p) {
      const c = typeof p === 'string' ? preset(p) : p;
      if (!c) return false;
      camera.position.fromArray(c.pos);
      camera.lookAt(new THREE.Vector3().fromArray(c.target));
      camera.updateMatrixWorld();
      if (c.hour !== undefined) st.hour = c.hour;
      if (c.weather) api.setWeather(c.weather, { instant: true });
      return true;
    },
    presets: () => PRESETS,
    /** 時間を止める（t を与えれば水と環境の時刻もそこへ）。撮影の再現性のため __gfxCapture も立てる */
    freeze(t) {
      st.frozen = true;
      window.__gfxCapture = true;
      if (Number.isFinite(t)) { st.time = t; st.waterTime = t; }
    },
    unfreeze() { st.frozen = false; window.__gfxCapture = false; },
    /** n フレームを同期で進める */
    tick(n = 1, dt = 1 / 60) {
      st.running = false;
      for (let i = 0; i < n; i++) frame(dt);
      return st.frames;
    },
    resume() { st.running = true; st.lastT = performance.now(); },
    /** デバッグ表示（null で通常） */
    view(name) { st.view = name || null; },
    stats() {
      const s = gfx.stats(), i = renderer.info;
      return {
        fps: st.fps, gpuMs: s.gpuMs, cpuMs: s.cpuMs, gpuTotal: gfx.budget.gpuTotal(), draws: i.render.calls, tris: i.render.triangles,
        programs: i.programs?.length || 0, textures: i.memory.textures, geometries: i.memory.geometries, rtBytes: s.rtBytes,
        modules: s.modules, degraded: gfx.degraded, tier: gfx.quality.tier, msaa: gfx.quality.profile.msaa,
        exposure: gfx.frame.get(NG.EXPO, 0), uw: gfx.frame.cam.uw,
      };
    },
    /** main RT の NaN / Inf の画素数（半精度をそのまま読む） */
    nanCheck() {
      const rt = gfx.targets.main;
      const buf = new Uint16Array(rt.width * rt.height * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
      let bad = 0;
      for (let k = 0; k < buf.length; k += 4) {
        if (((buf[k] & 0x7c00) === 0x7c00) || ((buf[k + 1] & 0x7c00) === 0x7c00) || ((buf[k + 2] & 0x7c00) === 0x7c00)) bad++;
      }
      return bad;
    },
    /** 画面中央付近の平均輝度（線形、露出前） */
    meanLuminance() {
      const rt = gfx.targets.copy;
      const w = 64, h = 36, x = (rt.width - w) >> 1, y = (rt.height - h) >> 1;
      const buf = new Uint16Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, x, y, w, h, buf, undefined, 0);
      let s = 0;
      for (let k = 0; k < buf.length; k += 4) s += ngLuminance(half(buf[k]), half(buf[k + 1]), half(buf[k + 2]));
      return s / (w * h);
    },
    _loop() {
      const step = () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - st.lastT) / 1000);
        st.lastT = now;
        if (st.running) {
          frame(dt);
          st.fpsN++; st.fpsT += dt;
          if (st.fpsT >= 1) { st.fps = st.fpsN / st.fpsT; st.fpsN = 0; st.fpsT = 0; }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
  };

  /* カメラのプリセット（桟橋の座標系から。hour / weather 付きは baseline の 7 構図） */
  const D = dock, dir = new THREE.Vector3(D.dockDir.x, 0, D.dockDir.z), right = new THREE.Vector3(dir.z, 0, -dir.x);
  const sp = new THREE.Vector3(D.spawnPos.x, D.dockY, D.spawnPos.z);
  const at = (base, f, s, y) => base.clone().addScaledVector(dir, f).addScaledVector(right, s).setY(y);
  const eye = D.dockY + 1.6;
  const shoreAt = (da, inland) => {
    const ang = Math.atan2(D.dockEnd.z, D.dockEnd.x) + da;
    const r = lake.shoreAtAngle(ang) + inland;
    return new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
  };
  const ground = (p, h) => p.clone().setY(Math.max(lake.heightAt(p.x, p.z), 0) + h);
  const fl = lake.flat || lake.flats?.[0] || { x: 0, z: 0 };
  const PRESETS = {
    'dock-fp': { pos: at(sp, 0, 0, eye), target: at(sp, 12, 0, eye - 1.2) },
    'dock-3p': { pos: at(sp, -3.2, 0.6, D.dockY + 2.4), target: at(sp, 6, 0, D.dockY + 1.0) },
    'shore-low': (() => { const p = ground(shoreAt(0.9, 2.5), 1.2); return { pos: p, target: new THREE.Vector3(0, 0.5, 0).lerp(p, 0.6) }; })(),
    aerial60: { pos: at(sp, -40, 0, 70), target: at(sp, 10, 0, 0) },
    'far-ridge': { pos: at(sp, 0, 0, eye), target: at(sp, 400, 0, 55) },
    'forest-floor': (() => { const p = ground(shoreAt(1.6, 34), 1.7); const q = ground(shoreAt(1.62, 44), 2.2); return { pos: p, target: q }; })(),
    'reed-edge': (() => { const p = ground(shoreAt(-0.5, -4), 0.0).setY(1.1); return { pos: p, target: ground(shoreAt(-0.42, -3), 0).setY(0.2) }; })(),
    'weedbed-uw': { pos: new THREE.Vector3(fl.x, Math.max(lake.heightAt(fl.x, fl.z) + 1.2, -3), fl.z), target: new THREE.Vector3(fl.x + 8, lake.heightAt(fl.x, fl.z) + 0.3, fl.z + 3) },
    'uw-dock': { pos: at(sp, 2, 4.5, -1.0), target: at(sp, -3, 0, -0.6) },
    waterline: { pos: at(sp, 6, 2.5, 0.06), target: at(sp, 30, 0, 0.1) },
    'dawn-3p': { pos: at(sp, -3.2, 0, D.dockY + 2.4), target: at(sp, 10, 0, D.dockY + 1.0), hour: 6.1, weather: 'clear' },
    'morning-fp': { pos: at(sp, 1.4, 0, eye), target: at(sp, 12, 0, eye - 1.4), hour: 8.5, weather: 'clear' },
    'noon-fp-down': { pos: at(sp, 1.4, 0, eye), target: at(sp, 5, 0, eye - 2.2), hour: 12.5, weather: 'clear' },
    'noon-shore': { pos: at(sp, 1.4, 0, eye), target: at(sp, -6, -8, eye - 0.3), hour: 13, weather: 'clear' },
    'dusk-3p': { pos: at(sp, -3.2, 0, D.dockY + 2.4), target: at(sp, 10, 0, D.dockY + 1.2), hour: 18.3, weather: 'clear' },
    'night-fp': { pos: at(sp, 1.4, 0, eye), target: at(sp, 12, 0, eye - 0.6), hour: 22.5, weather: 'clear' },
    'rain-fp': { pos: at(sp, 1.4, 0, eye), target: at(sp, 12, 0, eye - 1.2), hour: 11, weather: 'rain' },
  };
  for (const v of Object.values(PRESETS)) { v.pos = v.pos.toArray(); v.target = v.target.toArray(); }
  function preset(name) { return PRESETS[name] || null; }
  api.cam('dock-3p');
  return api;
}

function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function half(h) {
  const e = (h >> 10) & 31, m = h & 1023, s = h >> 15 ? -1 : 1;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
