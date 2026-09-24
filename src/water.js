/* ===========================================================
   水面：波シェーダ / 波紋 / 水しぶき
   CPU と GPU で同一の波関数を使い、ウキが正しく浮くようにする
   =========================================================== */
import * as THREE from 'three';
import { COMMON_GLSL } from './shaders.js?v=20260830-zone5';
import { WATER_REGION } from './lakefield.js';
import { rand, TAU, clamp, smoothstep } from './util.js?v=20260830-zone5';
import { makeTileableHeightField } from './tileableNoise.js?v=20260827-orgnoise4';
import { reflectCameraMatrixY } from './reflectionMath.js?v=20260827-lkwgfx';
import {
  WAVES, MAX_WAVE_AMP, waveGLSL, waveHeight, waveSlope, waveDisplace, shoreRunUp, shoalGain,
  wavePhaseOffset, wavePhaseOffsetGrad,
} from './waveField.js?v=20260828-lakescale1';

/* 波の定義そのものは waveField.js（CPU/GPU 共通の単一定義元）にある。
   従来の import 経路を壊さないよう、ここから再輸出しておく */
export {
  WAVES, MAX_WAVE_AMP, waveHeight, waveSlope, waveDisplace, shoreRunUp, shoalGain,
  wavePhaseOffset, wavePhaseOffsetGrad,
};

/** 波の法線（解析微分） */
export function waveNormal(x, z, t, wind = 1, out = new THREE.Vector3()) {
  const s = waveSlope(x, z, t, wind);
  return out.set(-s.dx, 1, -s.dz).normalize();
}

/* --- planar reflection 用の一時オブジェクト（GC 抑制） --- */
const _reflMat4 = new THREE.Matrix4();
const _reflVP = new THREE.Matrix4();
const _reflPlaneCam = new THREE.Plane();
const _reflClip = new THREE.Vector4();
const _reflV = new THREE.Vector3();

/**
 * 射影行列の near 面を任意平面（カメラ空間）へ置き換える。
 * Lengyel, "Oblique View Frustum Depth Projection and Clipping" 相当。
 */
function _calcOblique(proj, clip) {
  const e = proj.elements;
  const qx = (Math.sign(clip.x) + e[8]) / e[0];
  const qy = (Math.sign(clip.y) + e[9]) / e[5];
  const qz = -1.0;
  const qw = (1.0 + e[10]) / e[14];
  const dot = clip.x * qx + clip.y * qy + clip.z * qz + clip.w * qw;
  if (Math.abs(dot) < 1e-8) return;
  const f = 2.0 / dot;
  e[2] = clip.x * f;
  e[6] = clip.y * f;
  e[10] = clip.z * f + 1.0;
  e[14] = clip.w * f;
}

/**
 * 微細波用のタイル可能な法線テクスチャを一度だけ生成する。
 * 大きな波と中波は従来どおり解析式／手続きノイズで保ち、画面を埋める
 * 極小リップルだけをスクロールする法線テクスチャへ逃がすことで、
 * fragment ごとの vnoise 評価を抑える。
 */
function createRippleNormalTexture() {
  /* フラグメント側の fbm を全部ここへ寄せるので、以前の 128 では
     低周波レイヤに使ったときに解像度が足りない。256 / 5 octave にする */
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const height = makeTileableHeightField(size, 0xa1f0001, {
    octaves: 5,
    baseFrequency: 4,
    secondaryFrequency: 9,
    secondaryMix: 0.34,
    gain: 0.54,
    amplitude: 4.2,
  });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (height(x + 1, y) - height(x - 1, y)) * 0.72;
      const dy = (height(x, y + 1) - height(x, y - 1)) * 0.72;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 渚の泡のマスク。1 タイル ≒ 30cm の «泡そのもの» の写真で、輝度が被覆率。
 *
 * 以前はここを fbm2 + vnoise ×2 の手続きで作っていた（hash21 が 1px あたり
 * 16 回）。手続きノイズは «滑らかな塊» しか作れないので、コメントに
 * «泡ではなく煙に見える» と書いて 5〜10 倍細かくした経緯がある。写真には
 * レースの穴・泡の塊・気泡の 3 階層が最初から入っているので、1 枚を 3 つの
 * スケールで叩けば足りる（テクスチャフェッチ 3 回。mipmap も効く）。
 *
 * colorSpace を NoColorSpace にするのが肝。«色» ではなく «被覆率» なので
 * リニアへ変換されると平均 0.47 が 0.19 まで落ちて、閾値が全部狂う。
 */
function loadFoamTexture(onReady) {
  /* 読めなかったときの 1x1。閾値を通すと «レースの無いべた塗りの帯» に
     なるだけで、泡そのものは消えない */
  const fallback = new THREE.DataTexture(
    new Uint8Array([150, 150, 150, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
  );
  fallback.colorSpace = THREE.NoColorSpace;
  fallback.needsUpdate = true;
  if (typeof document === 'undefined') return fallback;
  new THREE.TextureLoader().load('./assets/textures/foam.webp', (tex) => {
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    onReady(tex);
  }, undefined, () => {});
  return fallback;
}

/* しぶきアトラスのセル。three は画像を上下反転して読む（flipY）ので、
   v=0 は «画像の下端» ＝ PNG の下の段になる。
   PNG は 上段 = 雫 / 飛び散り、下段 = 霧 / 伸びた雫 */
/**
 * 雨の着弾リング。4x4 の 16 コマ。アルファだけ使う。
 * 読めなければ «透明な 1x1» を返す（リングが出なくなるだけ）。
 */
function loadRainRingTexture(onReady) {
  const blank = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
  );
  blank.needsUpdate = true;
  if (typeof document === 'undefined') return blank;
  new THREE.TextureLoader().load('./assets/textures/rain-ring.png', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    // アトラスなので端は繰り返さない
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    onReady(tex);
  }, undefined, () => {});
  return blank;
}

const SPLASH_MIST = 0;
const SPLASH_STREAK = 1;
const SPLASH_DROP = 2;
const SPLASH_BURST = 3;

/**
 * しぶきの 2x2 アトラス。読み終わるまでは «4 セルとも同じ丸» の
 * canvas を出しておくので、セル番号がどれでも破綻しない。
 * @param {(tex: THREE.Texture) => void} onReady
 */
function loadSplashTexture(onReady) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  /* 4 セルとも同じ丸を描いておく。読み込みに失敗しても、セル番号が
     どれでも同じ絵になるだけで破綻しない */
  for (let i = 0; i < 4; i++) {
    const cx = (i % 2) * 32 + 16;
    const cy = Math.floor(i / 2) * 32 + 16;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 15);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(230,245,255,0.75)');
    g.addColorStop(1, 'rgba(200,230,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect((i % 2) * 32, Math.floor(i / 2) * 32, 32, 32);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (typeof document !== 'undefined') {
    new THREE.TextureLoader().load('./assets/textures/splash.png', (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      /* アトラスなので端は繰り返さない。ミップは残す（点は小さくなるので
         切ると盛大にジャギる）。セル間はもともと余白が広いので、
         深いミップで多少にじんでも «白い粒» のままになる */
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      onReady(t);
    }, undefined, () => {});
  }
  return tex;
}

const _m4 = new THREE.Matrix4();

export class Water {
  constructor(scene, terrain, opts = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.time = 0;
    this.wind = 1;
    this.rippleNormalTex = createRippleNormalTexture();

    const segs = opts.quality === 'low' ? 150 : opts.quality === 'high' ? 300 : 230;
    const geo = new THREE.PlaneGeometry(WATER_REGION, WATER_REGION, segs, segs);
    geo.rotateX(-Math.PI / 2);
    /* 渚では水面を「地形に沿う薄いシート」に持ち上げる。持ち上げ量は
       水面メッシュ 1 マスぶんの地形補間誤差を吸収できる大きさが必要 */
    const shoreLift = clamp((WATER_REGION / segs) * 0.075, 0.08, 0.22);

    /** 影を作っている光の向き（昼＝太陽・夜＝月）。updateEnv で差し替わる */

    this._keyDir = new THREE.Vector3(0, 1, 0);

    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: 1 },
      uHeightTex: { value: terrain.heightTexture },
      uRegion: { value: WATER_REGION },
      uShoreLift: { value: shoreLift },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uZenith: { value: new THREE.Color(0x2c72cc) },
      uHorizon: { value: new THREE.Color(0xd3e8f8) },
      uFogColor: { value: new THREE.Color(0xd3e8f8) },
      uFogNear: { value: 90 },
      uFogFar: { value: 620 },
      uNight: { value: 0 },
      uRain: { value: 0 },
      uShallow: { value: new THREE.Color(0x40907e) },
      uDeep: { value: new THREE.Color(0x0a2740) },
      uExposure: { value: opts.exposure ?? 1.0 },
      uCamPos: { value: new THREE.Vector3() },
      /* 水中の見え方：シーンを一度描いたテクスチャを、水を通る距離で減衰させて合成する。
         「不透明度で水を被せる」方式だと湖底の色との差で境目が出るため */
      uSceneColor: { value: null },
      uSceneDepth: { value: null },
      /* 水中から見上げたとき、屈折した向きを本カメラで投影し直して
         capture を引くために使う（スネルの窓に水上の景色を映す） */
      uProjView: { value: new THREE.Matrix4() },
      uInvProjView: { value: new THREE.Matrix4() },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCamNear: { value: 0.1 },
      uCamFar: { value: 3000 },
      // 1m あたりの吸収（赤から先に消える）
      uAbsorb: { value: new THREE.Vector3(0.18, 0.075, 0.045) },
      uRippleNormal: { value: this.rippleNormalTex },
      /* 渚の泡もランタイムで詰めたいので出しておく
         x,y = 先端の白線の内外幅 / z,w = 後方の泡帯の内外幅 */
      uFoamTex: { value: loadFoamTexture((tex) => { this.uniforms.uFoamTex.value = tex; }) },
      uRainRing: { value: loadRainRingTexture((tex) => { this.uniforms.uRainRing.value = tex; }) },
      uFoamTip: { value: new THREE.Vector4(0.016, 0.002, 0.036, 0.004) },
      // x = レースの下閾値, y = 上閾値, z = 泡の合成量, w = 古い泡の減衰
      /* x,y = レースの閾値。写真そのものにコントラストがあるので、
         手続きノイズ時代（0.54〜0.86）より浅く取る。z = 泡の混ぜ量、w = 経年 */
      uFoamLace: { value: new THREE.Vector4(0.40, 0.68, 0.62, 0.76) },
      /* 水越しの見え方の内訳。切り分け・調整用に uniform で出しておく
         x = 水の色（内向き散乱）, y = 逆光の透け, z = 水面反射 */
      uMixAmt: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      uDebug: { value: 0 },   // 1=シーンテクスチャ 2=水の厚み（開発用）
      uLinearOut: { value: 0 },
      /* --- 平面反射（planar reflection） ---
         ミラーカメラで水面より上を描いたテクスチャを、波の法線で揺らして貼る */
      uReflColor: { value: null },
      uReflTexel: { value: 1 / 512 },
      uTexMat: { value: new THREE.Matrix4() },
      uHasRefl: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: false,
      side: THREE.DoubleSide,
      depthWrite: true,
      /* three のクリッピング面を効かせる（渚ディオラマの «立方体に切り取る»
         モードで使う）。組み込みマテリアルと違い ShaderMaterial は自分で
         チャンクを入れる必要がある。面を 1 枚も渡さなければ
         NUM_CLIPPING_PLANES が 0 になり、何も生成されない */
      clipping: true,
      /* 渚で地形とほぼ同一平面になるので、深度の綴じ込みを一段ずらす */
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      vertexShader: /* glsl */ `
        ${waveGLSL()}
        #include <clipping_planes_pars_vertex>
        uniform float uTime, uWind, uRegion, uShoreLift;
        uniform sampler2D uHeightTex;
        varying vec3 vWorld;
        varying vec2 vWaveD;
        varying float vDepth;
        varying float vFogDepth;
        varying float vFlatDepth;
        varying float vWaveH;

        float groundAt(vec2 xz) {
          vec2 uv = clamp(xz / uRegion + 0.5, vec2(0.0005), vec2(0.9995));
          return texture2D(uHeightTex, uv).r;
        }

        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);

          /* Gerstner 水平変位。岸では 0 に落として地形へ乗り上げないようにする */
          float depth = max(0.0, -groundAt(wp.xz));
          wp.xz += waveDisp(wp.xz, uTime) * uWind * shoalGain(depth);

          // 変位後の位置で水深を取り直す（浅場の見た目がずれないように）
          float ground = groundAt(wp.xz);
          depth = max(0.0, -ground);
          vDepth = depth;

          float gain = shoalGain(depth) * uWind;
          float h = waveH(wp.xz, uTime) * gain;
          vWaveH = h;
          vWaveD = waveD(wp.xz, uTime) * gain;

          /* 渚：水は薄いシートになって砂に沿って登る。
             ground + uShoreLift が波面より高いのは水際の数十cmだけなので、
             深場では max が自動的に波面を選ぶ。陸側は遡上の上限で止める */
          float sheet = min(ground + uShoreLift, uShoreLift + 0.36 * uWind);
          wp.y += max(h, sheet);

          vWorld = wp.xyz;
          vec4 mv = viewMatrix * wp;
          #if NUM_CLIPPING_PLANES > 0
            vClipPosition = -mv.xyz;
          #endif
          vFogDepth = -mv.z;
          // 静水面（y=0）までの視距離。水の厚みはこちらを基準にする
          vFlatDepth = -(viewMatrix * vec4(wp.x, 0.0, wp.z, 1.0)).z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON_GLSL}
        ${waveGLSL()}
        uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uFogColor, uShallow, uDeep, uCamPos, uAbsorb;
        uniform float uTime, uNight, uRain, uFogNear, uFogFar, uExposure, uWind, uCamNear, uCamFar;
        uniform sampler2D uSceneColor, uSceneDepth, uReflColor, uRippleNormal, uHeightTex;
        uniform sampler2D uFoamTex;
        uniform sampler2D uRainRing;
        uniform mat4 uTexMat;
        uniform mat4 uProjView, uInvProjView;
        uniform float uHasRefl, uReflTexel;
        uniform vec4 uFoamTip, uFoamLace;
        uniform vec3 uMixAmt;
        uniform vec2 uResolution;
        uniform float uDebug;
        uniform float uLinearOut;
        uniform float uRegion;
        #include <clipping_planes_pars_fragment>
        varying vec3 vWorld;
        varying vec2 vWaveD;
        varying float vDepth;
        varying float vFogDepth;
        varying float vFlatDepth;
        varying float vWaveH;

        float groundAtF(vec2 xz) {
          vec2 uv = clamp(xz / uRegion + 0.5, vec2(0.0005), vec2(0.9995));
          return texture2D(uHeightTex, uv).r;
        }

        /* 微細リップルはすべてスクロールする法線テクスチャで作る。
           以前は fbm2 を差分法で 6 回評価していて 1 px あたり hash が 48 回
           走っていた。回転させた 5 枚のタップに寄せると、表情を保ったまま
           テクスチャフェッチ 5 回で済む（帯域は mipmap が面倒を見る）。 */
        const float PI_W = 3.14159265;

        vec2 rippleTexSlope(vec2 uv) {
          return texture2D(uRippleNormal, uv).xy * 2.0 - 1.0;
        }

        /* 各レイヤを違う角度へ回して、タイルの格子が重なるのを避ける */
        vec2 rot(vec2 p, float a) {
          float c = cos(a), s = sin(a);
          return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
        }

        vec2 rippleSlope(vec2 xz, float t) {
          vec2 d = vec2(0.0);
          d += rot(rippleTexSlope(rot(xz, 0.00) * 0.185 + vec2(0.21, -0.61) * t * 0.030), -0.00) * 0.185;
          d += rot(rippleTexSlope(rot(xz, 0.91) * 0.390 + vec2(0.83, 0.37) * t * 0.055 + vec2(0.19, 0.53)), -0.91) * 0.125;
          d += rot(rippleTexSlope(rot(xz, 2.05) * 0.760 + vec2(-0.47, 0.79) * t * 0.090 + vec2(0.61, 0.11)), -2.05) * 0.100;
          d += rot(rippleTexSlope(rot(xz, 3.44) * 1.480 + vec2(0.62, -0.72) * t * 0.135 + vec2(0.37, 0.81)), -3.44) * 0.060;
          d += rot(rippleTexSlope(rot(xz, 4.77) * 2.850 + vec2(-0.91, -0.28) * t * 0.190 + vec2(0.73, 0.29)), -4.77) * 0.035;
          return d;
        }

        /* --- 円盤光源のマイクロファセット鏡面（GGX / Cook-Torrance） ---
           太陽・月の «照り» は «視半径 0.27° の円盤の鏡像» であって、
           指数を固定した pow(N·H, k) ではない。固定指数だと
             ・ローブの角幅が水面の状態と無関係に決まる
             ・広がっても暗くならない（正規化が無い）
           ので、光源を «見下ろす» 配置（月が天頂・視線が真下）になると
           N·H が広い範囲で 1 に張り付き、ローブが一枚の板に潰れて
           水面に膜が浮いたように見えていた。

           GGX なら
             ・粗さ α に光源の視半径 r を足した α' でローブを広げ
             ・円盤の立体角 Ω = π·r² を掛ける
           ので、ピークは Ω·D(0,α') ≒ r²/α'² に収まる。つまり
           凪（α ≪ r）では «光源そのものの鏡像» としてまぶしい点になり、
           荒れる（α ≫ r）ほど広く淡く散る。«広がったぶん暗くなる» が
           自動的に効くので、どの配置でも «光» のまま潰れない。

           フレネルは合成時に fres で一度かけるので、ここでは含めない。 */
        const float LIGHT_R = 0.00465;             // 太陽・月の視半径（rad）
        float diskSpec(vec3 N, vec3 V, vec3 L, float rough) {
          float NoL = dot(N, L);
          if (NoL <= 0.0) return 0.0;
          vec3 H = normalize(V + L);
          float NoH = clamp(dot(N, H), 0.0, 1.0);
          float NoV = max(dot(N, V), 1e-4);
          float a2 = rough * rough + LIGHT_R * LIGHT_R;
          float d = NoH * NoH * (a2 - 1.0) + 1.0;
          float D = a2 / (PI_W * d * d);
          // Smith（高さ相関）。G/(4·NoV·NoL) までを含んだ可視性項
          float lv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
          float ll = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
          float Vis = 0.5 / max(lv + ll, 1e-5);
          return D * Vis * NoL * (PI_W * LIGHT_R * LIGHT_R);
        }

        /** 深度テクスチャの値 → ビュー空間の z 距離（m） */
        float eyeZ(float depth) {
          float z = depth * 2.0 - 1.0;                                   // NDC
          return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
        }

        vec3 skyAt(vec3 dir) {
          float g = pow(clamp(dir.y, 0.0, 1.0), 0.62);
          vec3 c = mix(uHorizon, uZenith, g);
          float sd = max(dot(dir, uSunDir), 0.0);
          c += uSunColor * pow(sd, 9.0) * 0.34;
          /* 太陽まわりの広いにじみ。空ドームでは自然でも、水面に «映り込む»
             と太陽側の半分ぜんたいが一様に白っぽくなり、膜のように見える。
             水用のこの skyAt では絞る */
          c += uSunColor * pow(sd, 2.2) * 0.06;
          return c;
        }

        void main() {
          /* 立方体に切り取るモード用。水中側の early return より前に置く */
          #include <clipping_planes_fragment>

          /* --- 汀線 ---
             水深は頂点補間ではなくフラグメントで高さテクスチャから直接引く。
             頂点補間だと閾値が粗い三角形の上で折れて、浅場に等高線図のような
             同心リングとファセットが出る。
             さらに遡上（swash）を足すので、水際の線が波に合わせて前後する */
          float ground = groundAtF(vWorld.xz);
          float still = -ground;                                  // 静水深（負なら陸）
          float runUp = shoreRunUp(vWorld.xz, uTime) * uWind;
          float wet = still + runUp;                              // 実効水深
          if (wet <= 0.004) discard;
          float depth = max(still, 0.0);

          // --- 法線（大波 + 細かいリップル） ---
          vec2 rip = rippleSlope(vWorld.xz, uTime);
          float farRip = mix(1.0, 0.38, smoothstep(75.0, 220.0, vFogDepth));
          float ripAmt = (0.34 + uRain * 0.90) * smoothstep(0.0, 1.2, depth) * farRip;
          vec2 slope = vec2(vWaveD.x + rip.x * ripAmt, vWaveD.y + rip.y * ripAmt);
          vec3 N = normalize(vec3(-vWaveD.x - rip.x * ripAmt, 1.0, -vWaveD.y - rip.y * ripAmt));

          /* この 1 px の中で法線がどれだけ暴れているか。«解決できていない
             粗さ» の主役で、遠景ほど 1 px に多くの波が入るので自動的に
             大きくなる（閃きのエイリアスもこれで丸まる）。
             微分は分岐の外で取る。スネルの窓の early return より後ろだと
             未定義になる */
          vec2 dN = fwidth(N.xz);

          vec3 V = normalize(uCamPos - vWorld);
          bool under = dot(N, V) < 0.0;
          if (under) N = -N;

          float ndv = clamp(dot(N, V), 0.0, 1.0);
          float fres = pow(1.0 - ndv, 5.0) * 0.94 + 0.045;
          vec2 suv = gl_FragCoord.xy / uResolution;

          /* --- 水中から見上げた水面：スネルの窓と全反射 ---
             水中では臨界角（cos ≈ 0.744）より内側だけ水上が見え、外側は
             全反射で水中側が鏡のように映る。以前は水路長の計算が空気側の
             距離を拾っていたため、見上げても濃紺の霧壁しか出ていなかった */
          if (under) {
            /* 臨界角 cos(asin(1/1.333)) = 0.6612。ここより内側だけ空が見える。
               （0.7442 は 41.9° 相当で、48.6° の窓が 14% 狭かった。そのぶん
                 太陽高度が 28° を切ると太陽の像が窓の外に落ちて消えていた）
               Snell で屈折方向を作ると、臨界角へ近づくほど視線が水平へ
               寝るので、窓の縁が自然に明るい環になる（全方位の圧縮）。
               窓の位置は水面法線＝ほぼ真上に決まり、太陽の方向とは無関係。
               太陽は「窓の中のどこに写るか」で効く */
            const float CRIT = 0.6612;
            /* 実際の縁は波でぼやけるので軟らかく。ただし CRIT を中心に対称に
               取る。片側へ寄せると窓そのものの大きさが狂う */
            float win = smoothstep(CRIT - 0.065, CRIT + 0.065, ndv);
            vec3 up = -N;                                  // 水面の外向き（上）法線
            vec3 I = -V;                                   // 目 → 水面
            float sinI = sqrt(max(0.0, 1.0 - ndv * ndv));
            float sinT = min(sinI * 1.333, 0.9995);        // 水 → 空気
            float cosT = sqrt(max(0.0, 1.0 - sinT * sinT));
            vec3 horiz = I - dot(I, up) * up;
            vec3 tangent = length(horiz) > 1e-4 ? normalize(horiz) : vec3(1.0, 0.0, 0.0);
            vec3 Rf = tangent * sinT + up * cosT;

            /* 窓の中身（1）空と太陽。
               太陽は屈折後の向きに写るので、低いほど窓の中心から縁へ寄る
               （仰角 20° なら天頂から 44.8°、窓の縁 48.6° の 92% の位置）。
               skyAt には円盤が無く pow(sd,9) のにじみだけなので、そのままだと
               「太陽がどっちにあるか」が窓の中に出ない。空ドームと同じ円盤を
               ここでだけ足す（skyAt は水面反射にも使うので、そちらに足すと
               鏡像のギラつきが二重になる） */
            vec3 dirSky = vec3(Rf.x, max(Rf.y, 0.012), Rf.z);
            vec3 aboveLin = skyAt(dirSky);
            float sdw = max(dot(dirSky, uSunDir), 0.0);
            aboveLin += uSunColor * smoothstep(0.9994, 0.99975, sdw) * 14.0 * (1.0 - uNight);
            aboveLin += uSunColor * pow(sdw, 220.0) * 1.6 * (1.0 - uNight);

            /* 窓の中身（2）水上の景色。
               実際のスネルの窓には空だけでなく桟橋・釣り人・岸が圧縮されて映る。
               capture は本カメラの視野ぶんしか無いので、屈折方向を本カメラで
               投影し直し、そこに写っているものが水面より上ならその色を使う。
               視野外／水面下に当たった向きは空のままにする（岸の圧縮像は
               本カメラの画角を超えるので窓の縁までは埋まらない） */
            vec4 wp4 = uProjView * vec4(vWorld + Rf * 32.0, 1.0);
            if (wp4.w > 0.001) {
              vec2 wuv = wp4.xy / wp4.w * 0.5 + 0.5;
              if (all(greaterThan(wuv, vec2(0.002))) && all(lessThan(wuv, vec2(0.998)))) {
                float wz = texture2D(uSceneDepth, wuv).x;
                if (wz < 0.9999) {
                  vec4 wpos = uInvProjView * vec4(wuv * 2.0 - 1.0, wz * 2.0 - 1.0, 1.0);
                  wpos /= wpos.w;
                  if (wpos.y > 0.05) aboveLin = texture2D(uSceneColor, wuv).rgb;
                }
              }
            }

            // 窓の外：全反射。水中の濁りが波形にゆらぐ鏡になる
            float shimmer = smoothstep(0.0, 0.34, length(slope));
            vec3 tirLin = mix(uDeep, uShallow, 0.34) * (0.62 + 1.05 * shimmer);
            tirLin *= mix(0.22, 1.0, 1.0 - uNight * 0.82);
            vec3 lin = mix(tirLin, aboveLin, win);
            /* 縁が明るいのは、地平線までの 180° が細い環に圧縮されるから。
               太陽色を一様に足すと方位に依らない偽の光輪になる（太陽をどこへ
               動かしても窓の見た目が変わらなくなる）。その向きの空そのものを
               持ち上げれば、太陽側の縁だけが明るくなる */
            float rim = win * (1.0 - win) * 4.0;
            lin += aboveLin * rim * 0.42 * (1.0 - uNight * 0.9);
            if (uDebug > 0.5) { gl_FragColor = vec4(vec3(win), 1.0); return; }
            gl_FragColor = vec4(encodeOut(lin, uExposure, uLinearOut), 1.0);
            return;
          }

          // --- 反射 ---
          vec3 R = reflect(-V, N);
          R.y = abs(R.y);
          vec3 refl = skyAt(R);

          /* --- 平面反射 ---
             水面より上を描いたミラー画像。波の法線で反射ベクトルの足元を
             揺らしてサンプリングする（uv は uTexMat が画面座標へ運ぶ）。
             RT に焼いた色は sRGB 済みなので、そのまま合成してよい。
             実物の水面は映り込みが縦へ伸びてにじむので、縦 3 タップで
             ぼかす。ぼかし幅は波の傾きと距離で増やす（＝粗さ LOD）。 */
          if (uHasRefl > 0.5) {
            vec3 Rd = reflect(-V, N);
            float dist = length(vWorld - uCamPos);
            // 波の傾きに応じて反射点を横へずらす（揺れの主役）
            vec4 rp = uTexMat * vec4(vWorld + Rd * (0.35 + dist * 0.10), 1.0);
            vec2 ruv = clamp(rp.xy / rp.w * 0.5 + 0.5, 0.0, 1.0);
            float rough = clamp(length(slope) * 1.55 + smoothstep(70.0, 300.0, dist) * 0.7, 0.0, 1.6);
            float blur = uReflTexel * (1.4 + rough * 7.0);
            vec3 mirror = texture2D(uReflColor, clamp(ruv + vec2(0.0, -blur), 0.0, 1.0)).rgb * 0.27
                        + texture2D(uReflColor, ruv).rgb * 0.46
                        + texture2D(uReflColor, clamp(ruv + vec2(0.0, blur), 0.0, 1.0)).rgb * 0.27;
            // 空だけの領域（RT の初期化色）との差が少ない所ほど信頼する。
            // 粗い（＝法線が散る）所は鏡像を信じず空色へ返す
            float mirrorW = smoothstep(0.02, 0.25, fres) * (1.0 - smoothstep(0.95, 2.0, rough));
            refl = mix(refl, mirror, mirrorW * 0.85);
          }

          /* --- 水中の見え方 ---
             法線に応じて屈折オフセットを付けた UV からシーン色を読む。
             シーンを描いたテクスチャから「水面より奥にある物」を取り出し、
             水を通る距離ぶん指数関数で減衰させる。距離はピクセルごとに
             連続なので、透ける／透けないの境目が出ない */
          /* 屈折のずらし量は以前 0.018 が上限で、浅場の湖底がほぼ歪んで
             いなかった。実際の浅い水は湖底が大きく揺らぐので、波の傾きに
             比例させたうえで上限を引き上げる */
          float refrAmt = (0.45 + length(slope) * 2.2) * smoothstep(0.0, 1.4, depth)
                        * mix(0.020, 0.052, 1.0 - uRain * 0.35);
          vec2 refrOff = N.xz * refrAmt;
          vec2 ruv0 = clamp(suv + refrOff, vec2(0.001), vec2(0.999));
          float sceneZ = eyeZ(texture2D(uSceneDepth, ruv0).x);
          float sceneZ0 = eyeZ(texture2D(uSceneDepth, suv).x);
          /* ずらした先が水面より手前にある＝水上の物（桟橋の杭・竿・釣り人）を
             拾っている。そのまま使うとその色が水面へにじみ、波に合わせて
             揺れる「陽炎」になるので、元の UV に戻す。
             深度が大きく飛ぶ場合も同様に縁のにじみを抑える */
          bool refrBad = sceneZ < vFogDepth - 0.02 || abs(sceneZ - sceneZ0) > 2.5;
          vec2 ruv = refrBad ? suv : ruv0;
          // ビュー空間の z 差を視線方向の長さに直す
          float rayScale = length(vWorld - uCamPos) / max(vFogDepth, 0.001);
          /* 厚みはずらす前のサンプル × 静水面基準で測る。
             屈折でずらした深度や波で上下する面から測ると、厚みが波と一緒に
             脈打ち、水越しの暗い物（杭・竿・釣り人）の上でヴェールが明滅して
             陽炎のように見える */
          float path = max(0.0, sceneZ0 - vFlatDepth) * rayScale;
          vec3 sceneCol = texture2D(uSceneColor, ruv).rgb;

          float dn = smoothstep(0.4, 13.0, path);
          vec3 body = mix(uShallow, uDeep, dn);
          body *= mix(0.22, 1.0, 1.0 - uNight * 0.82);

          /* --- 逆光の峰が透ける（sub-surface scattering 近似） ---
             太陽を背にした波の峰は、薄い水を光が通って緑〜黄に発光する。
             これが無いと、どれだけ反射を作り込んでも「板」に見える */
          float hUp = clamp(vWaveH / ${MAX_WAVE_AMP.toFixed(3)} * 1.35, 0.0, 1.0);
          float backLit = pow(max(dot(V, -uSunDir), 0.0), 3.0);
          /* 定数項は付けない。付けると太陽と反対を向いた浅場ぜんたいが
             緑がかって光り、水が氷のように見えてしまう。
             また「透け」は水中で散乱した光なので、光路長に比例させないと
             水が薄いところ（桟橋の杭や竿のすぐ手前）でも同じだけ光り、
             暗い物の上に黄色い陽炎が乗ってしまう */
          float sssPath = 1.0 - exp(-uAbsorb.g * path * 1.6);
          vec3 sss = uShallow * uSunColor * (hUp * hUp * 0.55) * sssPath
                   * backLit * (1.0 - uNight) * (1.0 - uRain * 0.5);

          /* --- 水面で反射する光（空 + 太陽・月） --- */
          vec3 surf = refl;

          /* 粗さは «1 px の中で解決できていない斜面のばらつき» だけを数える。
             大波とリップルは法線 N として描けているので粗さではない
             （二重に数えるとローブが広がりすぎて、また膜になる）。
             数えるのは
               (1) 1 px 内での法線の暴れ（dN）
               (2) 距離 LOD で寝かせたリップルぶん。描かないがばらつきは在る
               (3) 描いていない毛細波。雨はこれを増やす */
          float lodRough = 0.050 * (1.0 - farRip);
          float capRough = 0.018 + 0.045 * uRain;
          float rough = sqrt(dot(dN, dN) * 0.35
                           + lodRough * lodRough + capRough * capRough);

          /* --- きらめきのゆらぎ ---
             rough は «1 px の中に何枚の面があるか» の平均しか持たないので、
             ローブが狭くても «その中では一様» になる。実際は 1 px ごとに
             «たまたま光源を向いた面の数» がばらつき、それが閃きになる。
             とくに浅場は shoalGain で波が消えて鏡のように平らなので、
             解析的なローブだけだと滑らかな白い染みになってしまう。
             （ここを距離で切ると、近くの凪いだ浅場が染みのまま残る）

             ノイズは期待値 1 になるよう作るのでエネルギーは増減しない。
             glitter の期待値は閾値の緩さ gSoft で 0.052（近景）〜0.060（遠景）
             と動くので、ゲインもそれに合わせて引く（数値積分の線形近似）。
             遠景では 1 px に多数の面が入って実際に平均化されるので落とす。

             ノイズ自体は波と一緒に運ばれ（位相を vWaveD へ結び付ける）、
             1〜2Hz で明滅する。世界固定・低速だと «漂う模様» になり、
             光ではなく水面に浮いた膜に見える。 */
          float gScale = 16.0 / (1.0 + vFogDepth * 0.06);
          vec2 gp = vWorld.xz * gScale + vWaveD * 6.0 + vec2(uTime * 1.35, uTime * -0.98);
          float g1 = vnoise(gp);
          float g2 = vnoise(gp * 2.63 + vec2(uTime * -2.05, uTime * 1.62) + 13.7);
          // 遠いほど閾値を緩めて、点がちらつき（エイリアス）に化けるのを抑える
          float gSoft = 0.07 + 0.16 * smoothstep(35.0, 170.0, vFogDepth);
          float glitter = smoothstep(0.66 - gSoft, 0.74 + gSoft, g1)
                        * smoothstep(0.60 - gSoft, 0.72 + gSoft, g2);
          float sparkAmt = 0.80 * (1.0 - smoothstep(60.0, 240.0, vFogDepth));
          float gGain = 1.0 / (0.0518 + (gSoft - 0.07) * 0.0513);
          float sparkle = mix(1.0, glitter * gGain, sparkAmt);

          /* 円盤の «輝度»。太陽の実際の輝度は空の 10^5 倍だが、夜は露出が
             上がるので、月は太陽の 0.8 倍という «見た目の» 比で持つ。
             凪の水面が光源をまともに映したとき白熱するよう校正してある */
          const float SUN_RAD  = 1400.0;
          const float MOON_RAD = 1100.0;
          // 1 px だけが極端に明るくなる（fireflies）のは Bloom で目立つので抑える
          float sunSpec  = min(diskSpec(N, V,  uSunDir, rough) * sparkle * SUN_RAD,  60.0);
          float moonSpec = min(diskSpec(N, V, -uSunDir, rough) * sparkle * MOON_RAD, 60.0);
          surf += uSunColor * sunSpec * (1.0 - uNight) * (1.0 - uRain * 0.4);
          // 月の道。常に満月なので、これが夜の湖の主役になる
          surf += vec3(0.80, 0.87, 1.0) * moonSpec * uNight * (1.0 - uRain * 0.4);

          /* --- 泡（渚） ---
             遡上（swash）の先端に細い白線を立て、その後ろをレース状に崩す。
             以前は fbm の特徴サイズが数メートルあり、泡ではなく「煙」に
             見えていたので 5〜10 倍細かくした。さらに先端から離れた泡は
             古いものとして薄め、寄せて引く一往復が絵に出るようにする。
             沖の波頭泡は従来どおり強風・雨のときだけ。 */
          float tip = smoothstep(uFoamTip.x, uFoamTip.y, wet);
          float band = smoothstep(uFoamTip.z, uFoamTip.w, wet);
          float shoreFoam = 0.0;
          float foamBright = 0.55;
          if (tip + band > 0.002) {
            vec2 wFlow = normalize(vWaveD * 1.4 + vec2(0.02, 0.01));
            vec2 fPerp = vec2(-wFlow.y, wFlow.x);
            vec2 sp = vWorld.xz;
            // 泡は水と一緒に運ばれる：遡上量で位相をずらして波に追従させる
            float foamLag = runUp * 2.6 - uTime * 0.05;
            /* 岸に平行へ伸ばした座標。泡の筋が汀線に沿って走る。
               手続きノイズのときは 9.5 まで潰していたが、写真は潰すと
               «縞» が見えるので 6.0 に留める（テクスチャ自身が筋を持つ） */
            vec2 fa = vec2(dot(sp, wFlow) * 3.4, dot(sp, fPerp) * 6.0);

            /* 細かい層は距離で寝かせる。テクスチャなので mipmap は効くが、
               二値に近いマスクを縮小すると平均へ寄って «べた塗り» に化ける。
               閾値の効きを距離で緩めるのは以前と同じ理由 */
            float foamLod = 1.0 - smoothstep(9.0, 32.0, vFogDepth);
            /* fa は «1 単位 = 1 タイル» になっている（3.4 tiles/m ≒ 29cm）。
               テクスチャの実寸 30cm とほぼ一致するので、そのまま UV に使える。
               2 枚目・3 枚目はスケールを上げ、さらに回してタイルの格子が
               重ならないようにする（rippleSlope と同じ手） */
            float n1 = texture2D(uFoamTex,
              fa + wFlow * foamLag * 3.4 + vec2(uTime * 0.42, uTime * 0.28)).r;
            float n2 = texture2D(uFoamTex,
              rot(fa, 1.94) * 2.7 + wFlow * (foamLag * 1.5) + vec2(-uTime * 0.31, uTime * 0.24)).r;
            float n3 = texture2D(uFoamTex,
              rot(fa, 3.71) * 6.1 - wFlow * (foamLag * 2.2) + vec2(uTime * 0.44, -uTime * 0.37)).r;
            /* 閾値を画素の足跡で緩める。
               二値に近いマスクは mip が効くほど平均（0.47）へ寄るので、
               固定の閾値で切ると «寄った先» が閾値の下に入って泡がまるごと
               消える。汀線は斜めから見ることが多く、そこは 1 画素の足跡が
               長いので、距離ではなく fwidth で測らないと当たらない
               （手続きノイズ時代の foamLod は距離での近似だった）。
               足跡が伸びるほど閾値を平均へ寄せる ＝ 被覆率を保ったまま
               レースが «霞んだ帯» へ連続に落ちる */
            float fw = clamp(max(fwidth(fa.x), fwidth(fa.y)) * 0.5, 0.0, 1.0);
            float lo = mix(uFoamLace.x, 0.44, fw);
            float hi = mix(uFoamLace.y, 0.53, fw);
            float lace = smoothstep(lo, hi, n1)
                       * mix(0.10, 1.0, mix(0.72, smoothstep(lo - 0.06, hi + 0.06, n2), foamLod))
                       * mix(0.30, 1.0, mix(0.78, smoothstep(lo - 0.06, hi + 0.10, n3), foamLod));
            // 汀線に沿った粗い切れ目（n1 の再閾値のみ。追加サンプルなし）
            float shoreVar = mix(0.40, 1.0, smoothstep(lo + 0.03, hi - 0.02, n1));
            // 寄せ先端：n2/n3 で白線を割り、runUp 位相で流す
            float edgeGrain = n2 * 0.55 + n3 * 0.45 + foamLag * 0.10;
            float edgeBreak = mix(0.30, 1.0, smoothstep(lo - 0.10, hi + 0.02, edgeGrain));
            edgeBreak *= mix(0.55, 1.0, smoothstep(lo - 0.14, hi - 0.02, n3 + foamLag * 0.06));
            float age = smoothstep(0.04, 0.22, wet);
            // 狭い破れた先端と、広い引き波レースを層に分ける
            float leading = tip * edgeBreak * shoreVar * smoothstep(0.16, 0.66, lace) * 0.78;
            float retreat = band * lace * shoreVar * (1.0 - age * uFoamLace.w)
                          * mix(0.22, 0.52, smoothstep(lo - 0.04, hi + 0.04, n2))
                          * (1.0 - tip * 0.62);
            shoreFoam = clamp(leading + retreat, 0.0, 1.0);
            shoreFoam *= 1.0 - smoothstep(70.0, 230.0, vFogDepth);
            foamBright = mix(0.52, 0.96, leading) + retreat * 0.06 + tip * edgeBreak * 0.07;
          }

          float crest = smoothstep(0.58, 0.92, vWaveH / ${MAX_WAVE_AMP.toFixed(3)} / max(uWind, 0.35));
          float crestN = vnoise(vWorld.xz * 6.5 + uTime * 0.29);
          // 晴天の湖に白波を常在させず、強風・雨のときだけ波頭を泡立たせる。
          float crestWeather = smoothstep(1.12, 1.75, uWind) * mix(0.25, 1.0, uRain);
          float crestFoam = crest * smoothstep(0.34, 0.76, crestN) * 0.42 * crestWeather;
          float foam = clamp(shoreFoam + crestFoam, 0.0, 1.0);

          float sunFoam = pow(max(dot(N, normalize(V + uSunDir)), 0.0), 3.0) * 0.18 * (1.0 - uNight);
          vec3 foamTint = mix(uShallow * 1.35, vec3(0.90, 0.95, 0.97), clamp(tip + band * 0.45, 0.0, 1.0));
          vec3 foamCol = foamTint * foamBright + uSunColor * sunFoam;
          foamCol *= mix(0.38, 1.0, 1.0 - uNight * 0.38);

          /* --- 雨粒 ---
             以前は解析式のリング 1 本（smoothstep で細い環を描くだけ）。
             着弾の王冠も、2 本目の環も、崩れ方も無かった。
             16 コマのスプライトシートへ差し替える。
             セルの中でリングがあまり広がらない絵なので、UV 側でも
             コマの進みに合わせて拡大する（＝実際の広がりはこちらが持つ） */
          if (uRain > 0.02) {
            vec2 rp = vWorld.xz * 3.4;
            float t = uTime * 3.0;
            float cellT = floor(t);
            vec2 cell = floor(rp);
            float r = hash21(cell + cellT * 7.1);
            float ring = fract(t);
            if (r > 0.86) {
              /* セル内の座標を «広がる» ぶんだけ縮めてから引く。
                 0.34 → 1.0 まで開くので、絵の中の環がそのまま外へ育つ */
              float grow = mix(0.34, 1.0, ring);
              vec2 luv = (fract(rp) - 0.5) / max(grow, 0.001) + 0.5;
              if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) {
                float f = floor(ring * 16.0);
                vec2 fc = vec2(mod(f, 4.0), 3.0 - floor(f * 0.25));   // 左上が 1 コマ目
                vec4 ringTex = texture2D(uRainRing, (luv + fc) * 0.25);
                /* 旧実装（vec3(0.5) * drop * uRain）は小雨だと «乗せた分» が
                   0.08 ほどしか無く、ほぼ見えなかった。雨量に対して線形だと
                   小雨で消えるので、下駄を履かせて効かせる */
                surf += vec3(0.62, 0.68, 0.72) * ringTex.a * (1.0 - ring)
                      * (0.55 + uRain * 1.5);
              }
            }
          }

          /* --- 合成 ---
             下から来る光（湖底が水で減衰したもの）と、水面の反射をフレネルで混ぜる。
             不透明度で被せる方式と違い、湖底は「水の色に溶けていく」ので境目が出ない */
          vec3 bodyEnc = encodeOut(body, uExposure, uLinearOut);
          vec3 trans = exp(-uAbsorb * path);
          vec3 below = mix(bodyEnc, sceneCol, mix(vec3(1.0), trans, uMixAmt.x))
                     + encodeOut(sss, uExposure, uLinearOut) * uMixAmt.y;
          vec3 outc = mix(below, encodeOut(surf, uExposure, uLinearOut), fres * uMixAmt.z);
          outc = mix(outc, encodeOut(foamCol, uExposure, uLinearOut), foam * uFoamLace.z);

          if (uDebug > 0.5) {
            if (uDebug < 1.5) { gl_FragColor = vec4(sceneCol, 1.0); return; }
            gl_FragColor = vec4(vec3(clamp(path / 12.0, 0.0, 1.0)), 1.0); return;
          }
          // --- フォグ ---
          float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
          outc = mix(outc, encodeOut(uFogColor, uExposure, uLinearOut), fog);
          gl_FragColor = vec4(outc, 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'water';
    scene.add(this.mesh);

    this._buildRipples();
    this._buildSplash();
    this._buildPlankton(opts.quality || 'mid');
    this.quality = opts.quality || 'mid';
    /** 空ドームの uniform。映り込みを焼くあいだ点星を切るのに使う */
    this.skyUniforms = opts.skyUniforms || null;
    this._underwaterView = false;

    /* 湖底・魚シェーダが参照するコースティクス uniform */
    this.causticsUniforms = opts.causticsUniforms || {
      uCaustTime: { value: 0 },
      uCaustSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCaustNight: { value: 0 },
      uCaustRain: { value: 0 },
      uCaustCloud: { value: 0 },
      uCaustStrength: { value: 0 },
    };

    /* 水面より下を写すレンダーターゲット。水越しの絵はぼやけて見えるので
       解像度は 0.6 倍で足りる（負荷も下がる） */
    this.rtScale = opts.quality === 'low' ? 0.4 : opts.quality === 'high' ? 0.7 : 0.55;
    this.rt = null;

    /* --- 平面反射の準備 ---
       low 品質では無効。ミラー RT は小さめで十分（揺らして見るので） */
    this.reflEnabled = opts.quality !== 'low';
    /* 映り込みは縦にぼかして貼るので、以前の 512 では対岸の木が
       ブロック状の「シール」に見えていた。high は 1024 に上げる */
    this.reflHz = opts.quality === 'high' ? 0 : 30;   // 0 = 毎フレーム
    if (this.reflEnabled) {
      const reflSize = opts.quality === 'high' ? 1024 : 512;
      this.reflRT = new THREE.WebGLRenderTarget(reflSize, reflSize, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: true,
      });
      this.reflRT.texture.colorSpace = THREE.SRGBColorSpace;
      // 描画漏れの領域は空色で埋める（skyAt の近似色）
      this.reflClearColor = new THREE.Color(0x8fb8d8);
      this.reflCam = new THREE.PerspectiveCamera();
      // render() 内の updateMatrixWorld() に position/quaternion を壊されないよう
      // 通常の autoUpdate のまま使う（_updateReflCam が同期する）
      this.reflPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.uniforms.uReflColor.value = this.reflRT.texture;
      this.uniforms.uReflTexel.value = 1 / reflSize;
      this.uniforms.uHasRefl.value = 1;
      this._lastReflAt = -Infinity;
    }
  }

  /** 画面サイズに合わせてレンダーターゲットを用意する */
  _ensureRT(renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(2, Math.floor(size.x * this.rtScale));
    const h = Math.max(2, Math.floor(size.y * this.rtScale));
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    if (this.rt) this.rt.dispose();
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      depthTexture: depth,
      depthBuffer: true,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;   // 画面と同じ色空間で受け取る
    this.uniforms.uSceneColor.value = this.rt.texture;
    this.uniforms.uSceneDepth.value = depth;
    this.uniforms.uResolution.value.set(size.x, size.y);
  }

  /**
   * 水面を隠した状態でシーンを 1 枚描いておく（毎フレーム、本描画の直前に呼ぶ）。
   * これを水面シェーダが読んで、水中の減衰込みで合成する
   */
  /** 水越しには写らないもの（空・雨・陸の木や岩）を登録しておくと、キャプチャを軽くできる */
  setCaptureHidden(list) {
    this._extraHidden = (list || []).filter(Boolean);
  }

  /** 平面反射だけから外すもの。透過capture用リストとは共有しない。 */
  setReflectionHidden(list) {
    this._reflectionHidden = (list || []).filter(Boolean);
  }

  /* ---------------- 平面反射 ---------------- */
  /**
   * 主カメラを水面（y=0）で鏡映しにしたミラーカメラを作る。
   * 斜めクリッピング平面（oblique projection）で「水面より上」だけを描く。
   */
  _updateReflCam(camera) {
    const cam = this.reflCam;
    const p = this.reflPlane;
    // 反射は水面の少し上（0.06m）で切る：波の峰が平面を突き抜けて
    // 映り込みが欠けるのを防ぐ。高すぎると岸が切れるので小さく抑える
    p.constant = -0.06;
    // y=0でposition/forward/upを鏡映し、local Xだけ反転して右手系へ戻す。
    // Z位置やforwardを反転すると対岸側の逆向きカメラになるため触らない。
    reflectCameraMatrixY(camera.matrixWorld.elements, _reflMat4.elements);
    cam.matrixWorld.copy(_reflMat4);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // three は render() 内で camera.updateMatrixWorld() を呼び、matrixAutoUpdate
    // なら matrix を position/quaternion から作り直す。手計算した結果を保持するため
    // decompose で同期しておく（scale は鏡映で負になるが decompose/invert で不変）
    cam.matrix.copy(_reflMat4);
    cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
    cam.projectionMatrix.copy(camera.projectionMatrix);
    // 射影行列に斜めクリッピング平面（水面）を焼き込む
    _reflPlaneCam.copy(p).applyMatrix4(cam.matrixWorldInverse);
    _reflClip.set(
      _reflPlaneCam.normal.x, _reflPlaneCam.normal.y, _reflPlaneCam.normal.z, _reflPlaneCam.constant
    );
    _calcOblique(cam.projectionMatrix, _reflClip);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    return cam;
  }

  /**
   * 水面より上をミラーカメラで描いて RT に焼く（本描画の直前に呼ぶ）。
   * 負荷軽減のため 30Hz に間引く。
   */
  captureReflection(renderer, scene, camera) {
    if (!this.reflEnabled) return;
    if (this.reflHz > 0 && this.time - this._lastReflAt < 1 / this.reflHz) return;
    this._lastReflAt = this.time;
    const cam = this._updateReflCam(camera);
    // ワールド → uv 変換行列をシェーダへ渡す（world→clip→[0,1]）
    _reflVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.uniforms.uTexMat.value.copy(_reflVP);

    const hidden = [this.mesh, this.splash];
    if (this.plankton) hidden.push(this.plankton);
    for (const r of this.ripples) hidden.push(r.mesh);
    hidden.push(...(this._reflectionHidden || []).filter(Boolean));
    const vis = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    /* 点星だけは映り込みに焼かない。
       星は «画面 1 ピクセル» の光点として描いているが、この RT は 1024px
       しかないうえ、貼るときに縦へぼかす。だから RT の 1 px がそのまま
       画面の数 px へ引き伸ばされて、水面にだけ «巨大な星» が並ぶ。
       物理的にも、さざ波の立った水面は 1 つの星の光を長く引き延ばして
       散らすので、点として見えるのは鏡のような凪のときだけ。
       天の川や月のような «広がった光» はそのまま映してよい */
    const skyU = this.skyUniforms;
    const starsWas = skyU ? skyU.uStars.value : 0;
    if (skyU) skyU.uStars.value = 0;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.reflRT);
    renderer.setClearColor(this.reflClearColor, 1);
    renderer.clear();
    // 影は本描画（capture 内）で更新済みなのでここでは作り直さない
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.render(scene, cam);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setClearColor(null, 0);
    renderer.setRenderTarget(prevTarget);
    if (skyU) skyU.uStars.value = starsWas;
    hidden.forEach((o, i) => { o.visible = vis[i]; });
  }

  capture(renderer, scene, camera) {
    this._ensureRT(renderer);
    this.uniforms.uCamNear.value = camera.near;
    this.uniforms.uCamFar.value = camera.far;
    const hidden = [this.mesh, this.splash, ...(this._extraHidden || [])];
    if (this.plankton) hidden.push(this.plankton);
    for (const r of this.ripples) hidden.push(r.mesh);
    const vis = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    // 影はこのパスで更新し、本描画では作り直さない（1 フレーム 2 回描くので）
    renderer.shadowMap.autoUpdate = true;
    renderer.render(scene, camera);
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(prevTarget);
    hidden.forEach((o, i) => { o.visible = vis[i]; });
  }

  /* ---------------- CPU 側のサンプリング ---------------- */
  surfaceY(x, z) {
    const depth = this.terrain.depthAt(x, z);
    if (depth <= 0) return 0;
    // GPU 側と同じ浅水変形込みの係数を使う（ウキが波とずれないように）
    return waveHeight(x, z, this.time, this.wind) * shoalGain(depth);
  }

  surfaceNormal(x, z, out) {
    const depth = this.terrain.depthAt(x, z);
    return waveNormal(x, z, this.time, this.wind * (depth <= 0 ? 0 : shoalGain(depth)), out);
  }

  /** 渚の遡上量（m）。地形シェーダの濡れ砂と同じ式を CPU からも引ける */
  shoreRunUpAt(x, z) {
    return shoreRunUp(x, z, this.time, this.wind);
  }

  /* ---------------- 波紋 ---------------- */
  _buildRipples() {
    this.ripples = [];
    const geo = new THREE.RingGeometry(0.62, 0.98, 40, 1);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 18; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xdff2ff, transparent: true, opacity: 0, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 3;
      this.scene.add(m);
      this.ripples.push({ mesh: m, life: 0, dur: 1, size: 1, x: 0, z: 0 });
    }
    this._rippleIdx = 0;
  }

  addRipple(x, z, size = 1, dur = 1.6) {
    const r = this.ripples[this._rippleIdx++ % this.ripples.length];
    r.life = 0; r.dur = dur; r.size = size; r.x = x; r.z = z;
    r.mesh.visible = true;
    r.mesh.position.set(x, this.surfaceY(x, z) + 0.03, z);
    r.mesh.scale.setScalar(0.25 * size);
    r.mesh.material.opacity = 0.85;
  }

  /* ---------------- 水しぶき ---------------- */
  _buildSplash() {
    const MAX = 220;
    this.splashMax = MAX;
    this.splashParts = [];
    const pos = new Float32Array(MAX * 3);
    const col = new Float32Array(MAX * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);

    /* 粒ごとに «どのしぶきか» を選ぶ。2x2 アトラスのセル番号 */
    geo.setAttribute('aCell', new THREE.BufferAttribute(new Float32Array(MAX), 1));

    /* 以前は 32x32 の放射グラデーション 1 枚だった。キャストと魚とのやり取りの
       «音がしそうな瞬間» がその解像度で、ただのボヤけた点になっていた。
       写真の 2x2 アトラス（1 セル 256）へ差し替える */
    let mat = null;
    const tex = loadSplashTexture((t) => { mat.map = t; mat.needsUpdate = true; });
    mat = new THREE.PointsMaterial({
      size: 0.3, map: tex, transparent: true, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: true,
    });
    /* PointsMaterial は gl_PointCoord をそのまま UV に使うので、
       粒ごとにセルをずらすには varying を 1 本足すしかない */
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute float aCell;\nvarying float vCell;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvCell = aCell;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCell;')
        .replace('#include <map_particle_fragment>', `
          #if defined( USE_MAP ) || defined( USE_ALPHAMAP )
            vec2 uvBase = vec2( gl_PointCoord.x, 1.0 - gl_PointCoord.y );
            vec2 cell = vec2( mod( vCell, 2.0 ), floor( vCell * 0.5 ) );
            vec2 uv = uvBase * 0.5 + cell * 0.5;
          #endif
          #ifdef USE_MAP
            diffuseColor *= texture2D( map, uv );
          #endif
          #ifdef USE_ALPHAMAP
            diffuseColor.a *= texture2D( alphaMap, uv ).g;
          #endif
        `);
    };
    mat.customProgramCacheKey = () => 'splash-atlas-v1';
    this.splash = new THREE.Points(geo, mat);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 4;
    this.scene.add(this.splash);
    for (let i = 0; i < MAX; i++) {
      this.splashParts.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, dur: 1, sz: 1, cell: 0,
      });
    }
  }

  /* ---------------- 水中プランクトン（プール済み） ---------------- */
  _buildPlankton(quality) {
    const counts = { low: 210, mid: 420, high: 740 };
    this.planktonMax = counts[quality] || counts.mid;
    this.planktonParts = [];
    const pos = new Float32Array(this.planktonMax * 3);
    const col = new Float32Array(this.planktonMax * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);

    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    g.addColorStop(0, 'rgba(220,245,255,0.95)');
    g.addColorStop(0.45, 'rgba(180,230,250,0.55)');
    g.addColorStop(1, 'rgba(160,220,240,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 16, 16);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.PointsMaterial({
      size: 0.075,
      map: tex,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      fog: true,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      sizeAttenuation: true,
    });
    /* sizeAttenuation だけだと目の前の粒が巨大な白丸になり、
       レンズの汚れか降雪に見える。画面上のサイズに上限を入れる */
    mat.onBeforeCompile = (shader) => {
      // sizeAttenuation の直後（logdepthbuf の手前）で画面サイズを丸める
      shader.vertexShader = shader.vertexShader.replace(
        '#include <logdepthbuf_vertex>',
        'gl_PointSize = min(gl_PointSize, 5.0);\n#include <logdepthbuf_vertex>'
      );
    };
    mat.customProgramCacheKey = () => 'plankton-clamped-v1';
    this.plankton = new THREE.Points(geo, mat);
    this.plankton.frustumCulled = false;
    this.plankton.renderOrder = 2;
    this.plankton.visible = false;
    this.scene.add(this.plankton);

    for (let i = 0; i < this.planktonMax; i++) {
      this.planktonParts.push({
        x: 0, y: -1, z: 0,
        vx: 0, vy: 0, vz: 0,
        phase: rand(0, TAU),
        size: rand(0.6, 1.2),
      });
    }
  }

  setQuality(q) {
    this.quality = q;
    const rtScale = q === 'low' ? 0.4 : q === 'high' ? 0.7 : 0.55;
    if (rtScale !== this.rtScale) {
      this.rtScale = rtScale;
      if (this.rt) {
        this.rt.dispose();
        this.rt = null;
      }
    }
    this.reflHz = q === 'high' ? 0 : 30;
    if (q !== 'low' && !this.reflEnabled) {
      this.reflEnabled = true;
      const reflSize = q === 'high' ? 1024 : 512;
      this.reflRT = new THREE.WebGLRenderTarget(reflSize, reflSize, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: true,
      });
      this.reflRT.texture.colorSpace = THREE.SRGBColorSpace;
      this.reflClearColor = new THREE.Color(0x8fb8d8);
      this.reflCam = new THREE.PerspectiveCamera();
      this.reflPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.uniforms.uReflColor.value = this.reflRT.texture;
      this.uniforms.uReflTexel.value = 1 / reflSize;
      this.uniforms.uHasRefl.value = 1;
      this._lastReflAt = -Infinity;
    } else if (q === 'low' && this.reflEnabled) {
      this.reflEnabled = false;
      this.uniforms.uHasRefl.value = 0;
      if (this.reflRT) {
        this.reflRT.dispose();
        this.reflRT = null;
      }
    } else if (this.reflEnabled && this.reflRT) {
      const want = q === 'high' ? 1024 : 512;
      if (this.reflRT.width !== want) {
        this.reflRT.dispose();
        this.reflRT = new THREE.WebGLRenderTarget(want, want, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          generateMipmaps: false,
          depthBuffer: true,
        });
        this.reflRT.texture.colorSpace = THREE.SRGBColorSpace;
        this.uniforms.uReflColor.value = this.reflRT.texture;
        this.uniforms.uReflTexel.value = 1 / want;
      }
    }
    const counts = { low: 210, mid: 420, high: 740 };
    const wantN = counts[q] || counts.mid;
    if (wantN !== this.planktonMax) this._resizePlankton(wantN);
  }

  _resizePlankton(n) {
    if (!this.plankton) return;
    this.planktonMax = n;
    this.planktonParts.length = n;
    for (let i = 0; i < n; i++) {
      if (!this.planktonParts[i]) {
        this.planktonParts[i] = {
          x: 0, y: -1, z: 0, vx: 0, vy: 0, vz: 0, phase: rand(0, TAU), size: rand(0.6, 1.2),
        };
      }
    }
    const oldGeo = this.plankton.geometry;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setDrawRange(0, 0);
    this.plankton.geometry = geo;
    oldGeo.dispose();
  }

  setUnderwaterView(on) {
    this._underwaterView = !!on;
  }

  getUnderwaterContext(camera) {
    const surf = this.surfaceY(camera.position.x, camera.position.z);
    return {
      strength: this._underwaterView ? 1 : 0,
      time: this.time,
      // 光の柱と散乱ゲートは «いま照らしている光» の向き（夜は月）
      sunDir: this._keyDir,
      night: this.uniforms.uNight.value,
      rain: this.uniforms.uRain.value,
      cloud: 0,
      absorb: this.uniforms.uAbsorb.value,
      camPos: camera.position,
      camNear: camera.near,
      camFar: camera.far,
      waterY: surf,
    };
  }

  _updatePlankton(dt, camera) {
    if (!this.plankton || !this._underwaterView) {
      if (this.plankton) this.plankton.visible = false;
      return;
    }
    this.plankton.visible = true;
    const posAttr = this.plankton.geometry.attributes.position;
    const colAttr = this.plankton.geometry.attributes.color;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const spread = this.quality === 'low' ? 10 : this.quality === 'high' ? 16 : 13;
    let n = 0;
    for (let i = 0; i < this.planktonMax; i++) {
      const p = this.planktonParts[i];
      if (p.y < -0.5) {
        p.x = cx + rand(-spread, spread);
        p.y = cy + rand(-spread * 0.5, spread * 0.5);
        p.z = cz + rand(-spread, spread);
        const bed = this.terrain.heightAt(p.x, p.z);
        const surf = this.surfaceY(p.x, p.z);
        p.y = clamp(p.y, bed + 0.3, surf - 0.25);
        p.vx = rand(-0.08, 0.08);
        p.vy = rand(-0.02, 0.02);
        p.vz = rand(-0.08, 0.08);
      }
      p.x += (p.vx + Math.sin(this.time * 0.7 + p.phase) * 0.012) * dt;
      p.y += (p.vy + Math.sin(this.time * 0.5 + p.phase * 1.7) * 0.004) * dt;
      p.z += (p.vz + Math.cos(this.time * 0.6 + p.phase) * 0.012) * dt;
      const bed = this.terrain.heightAt(p.x, p.z);
      const surf = this.surfaceY(p.x, p.z);
      if (p.y < bed + 0.2 || p.y > surf - 0.15) {
        p.y = -1;
        continue;
      }
      const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
      if (dx * dx + dy * dy + dz * dz > spread * spread * 1.4) {
        p.y = -1;
        continue;
      }
      const tw = 0.45 + 0.55 * Math.sin(this.time * 1.8 + p.phase);
      /* 近すぎる粒はフェードインさせ、遠い粒は視界の霧へ溶かす。
         これが無いと粒が「星」に見えて距離感が壊れる */
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const fade = smoothstep(0.35, 1.4, d) * (1 - smoothstep(spread * 0.55, spread * 1.1, d));
      const a = tw * p.size * fade;
      posAttr.array[n * 3] = p.x;
      posAttr.array[n * 3 + 1] = p.y;
      posAttr.array[n * 3 + 2] = p.z;
      colAttr.array[n * 3] = a;
      colAttr.array[n * 3 + 1] = a * 1.05;
      colAttr.array[n * 3 + 2] = a * 1.1;
      n++;
    }
    this.plankton.geometry.setDrawRange(0, n);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  addSplash(x, y, z, count = 14, power = 1) {
    let added = 0;
    for (let i = 0; i < this.splashMax && added < count; i++) {
      const p = this.splashParts[i];
      if (p.alive) continue;
      p.alive = true;
      const a = rand(0, TAU);
      const sp = rand(0.6, 2.6) * power;
      p.x = x + Math.cos(a) * rand(0, 0.16) * power;
      p.z = z + Math.sin(a) * rand(0, 0.16) * power;
      p.y = y + rand(0, 0.1);
      p.vx = Math.cos(a) * sp * 0.55;
      p.vz = Math.sin(a) * sp * 0.55;
      p.vy = rand(1.4, 4.2) * power;
      p.life = 0;
      p.dur = rand(0.5, 1.1);
      p.sz = rand(0.5, 1.3);
      /* 速い粒は «伸びた雫»、遅い粒は «霧»。着水直後の速い粒がぜんぶ
         同じ丸だと «泡» に見えてしまう。
         «飛び散り» はセル 1 枚でしぶき全体の絵になっているので、
         10 粒ぜんぶがそれだと過剰。ごく稀に混ぜて核にする */
      const fast = (p.vy + sp) / power;
      const r = Math.random();
      p.cell = fast > 4.2
        ? (r < 0.10 ? SPLASH_BURST : (r < 0.62 ? SPLASH_STREAK : SPLASH_DROP))
        : (r < 0.46 ? SPLASH_MIST : SPLASH_DROP);
      added++;
    }
  }

  /* ---------------- 更新 ---------------- */
  update(dt, camera, env) {
    this.time += dt;
    const u = this.uniforms;
    u.uTime.value = this.time;
    this.wind = 1 + env.rainIntensity * 0.92 + env.cloudiness * 0.14;
    u.uWind.value = this.wind;
    u.uSunDir.value.copy(env.sunDir);
    this._keyDir = env.keyDir;
    u.uSunColor.value.copy(env.sunColor);
    u.uZenith.value.copy(env.zenithColor);
    u.uHorizon.value.copy(env.horizonColor);
    u.uFogColor.value.copy(env.fogColor);
    u.uFogNear.value = env.scene.fog.near;
    u.uFogFar.value = env.scene.fog.far;
    u.uNight.value = env.nightAmount;
    u.uRain.value = env.rainIntensity;
    u.uCamPos.value.copy(camera.position);
    /* 水中から見上げる窓の中身を capture から引くための行列。
       matrixWorldInverse は renderer が更新するので 1 フレーム遅れる。
       ここで自前に作り直して、屈折方向と capture をずらさない */
    camera.updateMatrixWorld();
    _m4.copy(camera.matrixWorld).invert();
    u.uProjView.value.multiplyMatrices(camera.projectionMatrix, _m4);
    u.uInvProjView.value.copy(u.uProjView.value).invert();

    const cu = this.causticsUniforms;
    cu.uCaustTime.value = this.time;
    // 昼は太陽、夜は月。網目の伸びる向きが光源と食い違わないように
    cu.uCaustSunDir.value.copy(env.keyDir);
    cu.uCaustNight.value = env.nightAmount;
    cu.uCaustRain.value = env.rainIntensity;
    cu.uCaustCloud.value = env.cloudiness;
    // 水上から湖底を見るscene captureにもcausticsを焼き込む。品質側で強度を抑え、
    // 夜・雨・雲・太陽高度による減衰はCAUSTICS_GLSL内で共通処理する。
    cu.uCaustStrength.value = this.quality === 'high' ? 1.0 : this.quality === 'low' ? 0.32 : 0.72;

    this._updatePlankton(dt, camera);

    // 波紋
    for (const r of this.ripples) {
      if (!r.mesh.visible) continue;
      r.life += dt;
      const t = r.life / r.dur;
      if (t >= 1) { r.mesh.visible = false; continue; }
      const sc = (0.25 + t * 2.6) * r.size;
      r.mesh.scale.setScalar(sc);
      r.mesh.material.opacity = 0.8 * (1 - t) * (1 - t);
      r.mesh.position.y = this.surfaceY(r.x, r.z) + 0.03;
    }

    // しぶき
    const posAttr = this.splash.geometry.attributes.position;
    const colAttr = this.splash.geometry.attributes.color;
    const cellAttr = this.splash.geometry.attributes.aCell;
    let n = 0;
    for (let i = 0; i < this.splashMax; i++) {
      const p = this.splashParts[i];
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.dur) { p.alive = false; continue; }
      p.vy -= 9.8 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const surf = this.surfaceY(p.x, p.z);
      if (p.y < surf) {
        p.alive = false;
        if (p.vy < -1.2 && Math.random() < 0.25) this.addRipple(p.x, p.z, 0.28, 0.9);
        continue;
      }
      const a = (1 - p.life / p.dur) * 0.95;
      posAttr.array[n * 3] = p.x;
      posAttr.array[n * 3 + 1] = p.y;
      posAttr.array[n * 3 + 2] = p.z;
      colAttr.array[n * 3] = a * p.sz;
      colAttr.array[n * 3 + 1] = a * p.sz;
      colAttr.array[n * 3 + 2] = a * p.sz;
      cellAttr.array[n] = p.cell;
      n++;
    }
    this.splash.geometry.setDrawRange(0, n);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    cellAttr.needsUpdate = true;
  }
}
