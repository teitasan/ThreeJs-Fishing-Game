/* ===========================================================
   最小の «本物の» モジュールの例（docs/nextgen/CORE_API.md §12）
   -----------------------------------------------------------
   lab/example.html が Lab.boot({ extraModules: [createModule] }) で起動する。
   モジュール担当者が src/gfx/<自分>/index.js を書くときの雛形。使っている口：
     - NgModule の基底（static id・root・init/update/prepare/beforePass/setQuality/stats/dispose）
     - ngExtendStandard：インスタンスの杭。頂点で地形に乗せ（ngTerrainH）、風で揺らし（ngWindAt）、
       断片で雨の濡れ（ngWetSurface × ngWet）。depth: true で影も同じ変形、hfShadow: true で遠くの山の影
     - ngShaderMaterial：波に乗る浮き輪。waveField と同じ波（NG_WAVE_GLSL・位相は ngFrame）で
       CPU の water.surfaceY と同じ高さに浮く。fog チャンクで ngApplyMedium（一つの空気）
     - forge.bake2D：杭の縞の albedo を起動時に焼く（外部アセットなし）
     - services：water.addRipple（浮き輪の周りに波紋）、post.registerDebugView（lab の view 名）
     - 品質：段ごとの本数（rank の入れ子 low ⊂ mid ⊂ high）と、ライト・castShadow を変えない約束
   Math.random は使わない（位置は world/rng の hash01 で決める）。フレーム中は例外を投げない
   =========================================================== */
import { NgModule } from '../module.js';
import { NG_LAYER, ngOwn } from '../layers.js';
import { NG_PASS } from '../frame.js';
import { ngExtendStandard, ngShaderMaterial, ngAttachDepth } from '../extend.js';
import { NG_HEIGHTFIELD_GLSL } from '../glsl/heightfield.glsl.js';
import { NG_WIND_GLSL } from '../glsl/wind.glsl.js';
import { NG_SURFACE_GLSL } from '../glsl/surface.glsl.js';
import { NG_WAVE_GLSL } from '../glsl/wave.glsl.js';
import { hash01 } from '../../../world/rng.js';

/** 自分の品質表（本物のモジュールは src/gfx/<m>/quality.js に置く）。rank < density の物だけ描く */
const DENSITY = { low: 0.25, mid: 0.5, high: 1.0 };
const CANDIDATES = 96;
const STAKE_H = 1.2;

/* 杭の縞（forge.bake2D の frag。vUv は 0..1、gl_FragColor に «線形» の値を書く） */
const STRIPE_FRAG = /* glsl */ `
void main() {
  float band = step(0.5, fract(vUv.y * 6.0));
  vec3 paint = mix(vec3(0.62, 0.05, 0.03), vec3(0.70, 0.68, 0.62), band);   // 赤白の測量杭（線形アルベド）
  gl_FragColor = vec4(paint, 1.0);
}
`;

/* 浮き輪：頂点を «ゲームと同じ» 水面の高さへ。uTime には water.time（f.waterTime）を渡す */
const FLOAT_VS = NG_HEIGHTFIELD_GLSL + NG_WAVE_GLSL + /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform float uTime;
uniform float uWind;
uniform vec2 uAt;
out vec3 vN;
void main() {
  float d = ngDepth(uAt);
  float h = d <= 0.0 ? 0.0 : ngWaveH(uAt, uTime) * uWind * ngShoalGain(d);
  vec3 p = position + vec3(uAt.x, h, uAt.y);
  vN = normal;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const FLOAT_FS = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
in vec3 vN;
void main() {
  /* ngFrame の key（雲で減光済みの放射照度）と空の照度だけの簡単な拡散。露出・トーンマップは post が掛ける */
  vec3 n = normalize(vN);
  vec3 E = ngKeyRad * max(dot(n, ngKeyDir), 0.0) * vNgCloud + ngSkyIrr * 3.14159265 * (0.5 + 0.5 * n.y);
  gl_FragColor = vec4(uColor * E / 3.14159265, 1.0);
  #include <fog_fragment>
}
`;

/**
 * 例のモジュール
 */
export class ExampleModule extends NgModule {
  /** gfx.modules のキー・safety の数え上げ・シェーダの印（ngmod:example:…）に使う。必ず書く */
  static id = 'example';

  constructor(ctx) {
    super(ctx);
    /* 構築では重い処理をしない（init で）。ctx は «作った時点の写し»：tier / profile / camera は
       setQuality と f で受け直すこと */
    this.tier = ctx.tier;
    this.stakes = null;
    this.float = null;
    this._ripT = 0;
    this._list = [];
    this.uniforms = {
      uTime: { value: 0 }, uWind: { value: 1 }, uAt: { value: new ctx.THREE.Vector2() },
      uColor: { value: new ctx.THREE.Color(0.75, 0.32, 0.05) },
    };
  }

  async init(progress) {
    const { THREE: T, forge, lake, heightfield, services } = this.ctx;
    if (!lake || !heightfield) { progress?.(1); return; }   // lab の外・高さ場の失敗でも落とさない
    /* 1. 起動時のテクスチャ（forge）。frag は全画面三角形 1 枚で焼く。重い処理の合間に forge.step() で譲る */
    this.stripes = forge.bake2D({ w: 16, h: 256, frag: STRIPE_FRAG, mips: true, wrap: 'clamp' });
    await forge.step();
    progress?.(0.3);

    /* 2. 杭の位置：桟橋の付け根の周りの陸。world/rng の hash01 で決定的に（Math.random 禁止）。
       rank を持たせて、段の本数は rank < DENSITY[tier] の入れ子にする（low ⊂ mid ⊂ high） */
    const d = lake.dock, base = { x: d.start.x, z: d.start.z };
    for (let i = 0; i < CANDIDATES; i++) {
      const a = (i / CANDIDATES) * Math.PI * 2;
      const r = 5 + 6 * hash01(lake.seed, i, 1);
      const x = base.x + Math.cos(a) * r, z = base.z + Math.sin(a) * r;
      if (heightfield.heightAt(x, z) < 0.15) continue;          // CPU の高さ（GPU の ngTerrainH と同じ補間）
      this._list.push({ x, z, rank: hash01(lake.seed, i, 2) });
    }

    /* 3. ngExtendStandard：three の光・影・霧（ngApplyMedium）はそのまま効く。決まった口にだけ GLSL を入れる */
    const mat = new T.MeshStandardMaterial({ map: this.stripes, roughness: 0.7, metalness: 0 });
    ngExtendStandard(mat, {
      key: 'example-stake',       // customProgramCacheKey = 'ng:example-stake:<tier>'。同じ key = 同じ GLSL
      module: 'example',
      uniforms: { ...heightfield.uniforms },   // 共有の {value} をそのまま（複製しない）
      vertex: {
        pars: NG_HEIGHTFIELD_GLSL + NG_WIND_GLSL,
        /* begin_vertex の後：transformed はオブジェクト空間。インスタンスは回転・拡縮なしなので向きは世界と同じ */
        begin: /* glsl */ `
          vec3 ngBase = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec4 ngW = ngWindAt(ngBase.xz);
          float ngK = transformed.y / ${STAKE_H.toFixed(2)};
          transformed.xz += ngW.xy * (ngK * ngK * 0.015 * ngW.z);
          transformed.y += ngTerrainH(ngBase.xz) - 0.05;`,
      },
      fragment: {
        pars: NG_SURFACE_GLSL,
        /* roughnessmap_fragment の後：diffuseColor と roughnessFactor が使える。ngWet は ngFrame の濡れ */
        rough: 'ngWetSurface(diffuseColor.rgb, roughnessFactor, 0.6, ngWet);',
      },
      depth: true,       // 影も同じ変形（揺れと地形）
      hfShadow: true,    // 近景の影の外で高さ場影（サンプラー 2 枚）
    });
    const geo = new T.CylinderGeometry(0.035, 0.045, STAKE_H, 6, 4).translate(0, STAKE_H / 2, 0);
    this.stakes = new T.InstancedMesh(geo, mat, this._list.length);
    this.stakes.castShadow = true;
    this.stakes.receiveShadow = true;
    this.stakes.frustumCulled = false;   // 頂点で動かすので three の境界球は当てにならない
    ngAttachDepth(this.stakes);
    this.stakes.name = 'ng-example-stakes';
    this.root.add(this.stakes);
    this._fill(this.tier);
    progress?.(0.7);

    /* 4. ngShaderMaterial：自前のシェーダ（lights / fog 付き、NG_FRAME 済み）。波の位相は ngFrame の slot 19–20 */
    const end = d.end, dir = { x: d.end.x - d.start.x, z: d.end.z - d.start.z };
    const L = Math.hypot(dir.x, dir.z) || 1;
    this.uniforms.uAt.value.set(end.x + (dir.x / L) * 4, end.z + (dir.z / L) * 4);
    const fmat = ngShaderMaterial({
      key: 'example-float', module: 'example', lights: false,
      uniforms: { ...this.uniforms, ...heightfield.uniforms },
      vertexShader: FLOAT_VS, fragmentShader: FLOAT_FS,
    });
    this.float = new T.Mesh(new T.TorusGeometry(0.35, 0.09, 10, 28).rotateX(Math.PI / 2), fmat);
    this.float.frustumCulled = false;
    this.float.name = 'ng-example-float';
    this.root.add(this.float);

    /* 5. 層：ng の物体は layer 0 を外して自分の層へ（反射・屈折・影のマスクが決まる）。scene へ足すのは root だけ */
    ngOwn(this.root, NG_LAYER.WORLD);
    this.ctx.scene.add(this.root);

    /* 6. services：提供者が居なくても既定値が返る（関数は投げない）。lab の view('example-depth') で見える */
    services.post.registerDebugView('example-depth', /* glsl */ `
      vec4 ngDebug(vec2 uv) {
        float z = texture(ngSceneDepth, uv).r;      // 不透明の線形深度（m）
        return vec4(vec3(fract(z / 10.0)), 1.0);   // 10m ごとの縞
      }`);
    progress?.(1);
  }

  /* 段の本数だけインスタンスを詰める（rank の入れ子） */
  _fill(tier) {
    const T = this.ctx.THREE, m = new T.Matrix4();
    let n = 0;
    for (const s of this._list) {
      if (s.rank >= (DENSITY[tier] ?? 1)) continue;
      m.makeTranslation(s.x, 0, s.z);
      this.stakes.setMatrixAt(n++, m);
    }
    this.stakes.count = n;
    this.stakes.instanceMatrix.needsUpdate = true;
  }

  /** 毎フレームの CPU（gfx.updateModules から。f は毎フレーム書き換わる同じオブジェクト。保存しない） */
  update(f) {
    const u = this.uniforms;
    u.uTime.value = f.waterTime;     // 浮き輪は water.time の波（ngWaterTime と同じ値 → 位相は倍精度）
    u.uWind.value = f.waterWind;
    if (f.paused) return;            // ポーズ中は時間の進む物を止める
    this._ripT += f.dt;
    if (this._ripT > 2.5) {          // 2.5 秒ごとに浮き輪の周りへ波紋（water モジュールの受け口。投げない）
      this._ripT = 0;
      const p = u.uAt.value;
      this.ctx.services.water.addRipple(p.x, p.y, 0.8, 2.0);
    }
  }

  /** パスの直前（任意）。反射では浮き輪を出さない、のようなパス別の切り替えに使う */
  beforePass(passId) {
    if (this.float) this.float.visible = passId !== NG_PASS.REFLECTION;
  }

  /** 品質：部分集合の作り直しだけ（ライト数・castShadow は変えない）。同じ段で何度呼ばれてもよい */
  setQuality(tier) {
    this.tier = tier;
    if (this.stakes) this._fill(tier);
  }

  stats() {
    const n = this.stakes?.count || 0;
    return { draws: (n ? 1 : 0) + (this.float ? 1 : 0), tris: n * 48 + (this.float ? 560 : 0), instances: n, texBytes: 16 * 256 * 8 * 1.34, programs: 3 };
  }

  dispose() {
    this.stakes?.material.dispose();
    this.float?.material.dispose();
    super.dispose();   // root を外し、geometry を捨てる（forge の焼いたテクスチャは forge が持つ）
  }
}

/** src/gfx/<m>/index.js が export する唯一の入口 */
export function createModule(ctx) { return new ExampleModule(ctx); }
