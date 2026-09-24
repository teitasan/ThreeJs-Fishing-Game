/* ===========================================================
   後処理（pmndrs postprocessing を vendor 同梱で使用）
   全品質で composer を使い、水中カメラ時は UnderwaterEffect を適用。
   high 品質のときだけ Bloom を追加する。
   カスタムシェーダ（water/sky）は全品質で uLinearOut=1 のリニア出力にし、
   トーンマップ + sRGB エンコードは ToneMappingEffect で 1 回だけ行う
   =========================================================== */
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  KernelSize,
  Effect,
  EffectAttribute,
} from 'postprocessing';
import * as THREE from 'three';

/* Bloom の基準強度。水中では updateUnderwater がここから下げる */
const BLOOM_INTENSITY = 0.35;

const UNDERWATER_FRAG = /* glsl */ `
uniform float uStrength;
uniform float uTime;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uRain;
uniform float uCloud;
uniform vec3 uAbsorb;
uniform vec3 uCamPos;
uniform float uCamNear;
uniform float uCamFar;
uniform float uWaterY;
uniform float uLinear;
uniform mat4 uInvProj;    // カメラの projectionMatrixInverse（深度→ワールド復元用）
uniform mat4 uCamWorld;   // カメラの matrixWorld
uniform float uShaft;     // 光の柱の強さ（0 で無効）
uniform float uTurbidity; // 濁り（1 で標準）

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  return vnoise(p) * 0.6667 + vnoise(p * 2.03) * 0.3333;
}

float eyeZ(float depth) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * uCamNear * uCamFar) / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
}

/** 深度バッファからワールド座標を復元する */
vec3 worldAt(vec2 uv, float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 vp = uInvProj * ndc;
  return (uCamWorld * vec4(vp.xyz / vp.w, 1.0)).xyz;
}

/**
 * 水中で「太陽へ向かう」方向。Snell（sinθw = sinθa / 1.333）で屈折するので、
 * 水中から見た太陽は空気中よりずっと天頂寄りに立つ。
 * 空気中の方向をそのまま使うと光の柱の向きと出どころがずれる。
 */
vec3 sunUnderwater(vec3 sd) {
  float ca = max(sd.y, 0.05);
  float sa = sqrt(max(0.0, 1.0 - ca * ca));
  float sw = sa / 1.333;
  float cw = sqrt(max(0.0, 1.0 - sw * sw));
  float hl = length(sd.xz);
  vec2 hz = hl > 1e-4 ? sd.xz / hl : vec2(0.0, 1.0);
  return normalize(vec3(hz.x * sw, cw, hz.y * sw));
}

/**
 * 光線方向に垂直な平面上のノイズ。光線に沿っては一定なので、
 * 世界に貼り付いた「平行な筋」になる。
 * 画面座標の極座標でノイズを引くと、旭日旗のような放射スポークになり、
 * しかもカメラを振るたび模様が泳いで酔うので使わない。
 */
float shaftMask(vec3 p, vec3 U, vec3 V, float t) {
  vec2 q = vec2(dot(p, U), dot(p, V));
  float s = fbm2(q * vec2(0.62, 0.24) + vec2(t * 0.021, -t * 0.014));
  s += fbm2(q * vec2(1.45, 0.55) + vec2(-t * 0.017, t * 0.026)) * 0.5;
  return smoothstep(0.62, 1.02, s);
}

void mainUv(inout vec2 uv) {
  if (uStrength < 0.001) return;
  vec2 n = vec2(
    fbm2(uv * 14.0 + vec2(uTime * 0.06, uTime * 0.05)),
    fbm2(uv * 14.0 + vec2(5.7, 2.3) + vec2(uTime * 0.05, -uTime * 0.06))
  );
  uv += (n - 0.5) * 0.0007 * uStrength * (1.0 - uRain * 0.35);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uStrength < 0.001) {
    outputColor = inputColor;
    return;
  }

  float depth = readDepth(uv);
  float viewZ = eyeZ(depth);
  float dist = max(0.0, viewZ);

  vec3 col = inputColor.rgb;

  /* --- 体積散乱（Beer-Lambert + 単一散乱の内向き加算） ---
     以前は線形の THREE.Fog がほぼすべてを担っていたため、水が「平たい
     水色の板」に見えていた。水は指数かつ波長選択で減衰するので、
     透過に exp を、抜けた分に散乱光を足す形へ置き換える。
     こうすると遠くが「水の色に収束」し、近くだけ素の色が残る */
  float camDepth = max(0.0, uWaterY - uCamPos.y);
  vec3 sigma = uAbsorb * uTurbidity;
  vec3 trans = exp(-sigma * dist);

  /* uSunDir には «いま照らしている光»（夜は月）の向きが入る。夜の係数は
     常に満月という世界設定に合わせて、消すのではなく 3 分の 1 に落とす */
  float sunGate = smoothstep(-0.05, 0.35, uSunDir.y)
                * (1.0 - uNight * 0.66) * (1.0 - uCloud * 0.55);
  /* 水中の環境光は深さで指数的に落ちる。20m 潜れば同じ湖底でも別の暗さになる */
  float ambient = exp(-camDepth * 0.043) * mix(0.28, 1.0, sunGate);
  vec3 scatterCol = mix(vec3(0.085, 0.30, 0.34), vec3(0.048, 0.165, 0.215), uNight);
  vec3 inscatter = scatterCol * ambient * (vec3(1.0) - trans);

  col = col * trans + inscatter * uStrength;

  /* --- 光の柱（薄明光線） ---
     水面で屈折した平行光が濁りに散乱して筋になる。屈折後の光線方向に
     垂直な平面のノイズを、視線に沿って数点サンプルして積む。
     こうすると筋が世界に貼り付き、カメラを振っても向きが変わらない。
     深さで指数的に減衰するので、深場では自然に消える */
  if (uShaft > 0.001 && sunGate > 0.001) {
    vec3 Lup = sunUnderwater(normalize(uSunDir));
    vec3 U = normalize(cross(Lup, vec3(0.0, 0.0, 1.0)));
    vec3 V = cross(Lup, U);
    vec3 rd = normalize(worldAt(uv, depth) - uCamPos);
    float march = min(dist, 72.0);
    float acc = 0.0;
    for (int i = 0; i < 3; i++) {
      vec3 p = uCamPos + rd * (march * (float(i) + 0.5) / 3.0);
      float below = uWaterY - p.y;                      // 水面からの深さ
      acc += shaftMask(p, U, V, uTime)
           * smoothstep(0.0, 0.6, below)                // 水面より上には出さない
           * exp(-max(below, 0.0) * 0.085);             // 深いほど届かない
    }
    acc /= 3.0;
    // 目の前と遠景には乗せない（視界が汚れて「歪んで見える」原因になる）
    acc *= smoothstep(2.4, 12.0, march) * (1.0 - smoothstep(48.0, 80.0, march));
    col += vec3(0.42, 0.78, 0.86) * acc * sunGate * uStrength * uShaft
         * (1.0 - uRain * 0.4);
  }

  /* --- 水面直下の明るみ --- */
  float surfaceLight = exp(-camDepth * 0.21);
  col += vec3(0.30, 0.66, 0.76) * surfaceLight * sunGate * uStrength * 0.05
       * mix(0.35, 1.0, uLinear);

  /* 周辺減光：水中は視界が閉じる */
  float vig = 1.0 - smoothstep(0.32, 0.92, length(uv - 0.5) * 1.42);
  col *= mix(1.0, 0.78 + 0.22 * vig, uStrength);

  /* コントラストをわずかに落として水中感を出す */
  col = mix(col, col * col, 0.015 * uStrength);

  outputColor = vec4(col, inputColor.a);
}
`;

class UnderwaterEffect extends Effect {
  constructor() {
    super('UnderwaterEffect', UNDERWATER_FRAG, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uStrength', new THREE.Uniform(0)],
        ['uTime', new THREE.Uniform(0)],
        ['uSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ['uNight', new THREE.Uniform(0)],
        ['uRain', new THREE.Uniform(0)],
        ['uCloud', new THREE.Uniform(0)],
        ['uAbsorb', new THREE.Uniform(new THREE.Vector3(0.18, 0.075, 0.045))],
        ['uCamPos', new THREE.Uniform(new THREE.Vector3())],
        ['uCamNear', new THREE.Uniform(0.1)],
        ['uCamFar', new THREE.Uniform(3000)],
        ['uWaterY', new THREE.Uniform(0)],
        ['uLinear', new THREE.Uniform(0)],
        ['uInvProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uShaft', new THREE.Uniform(0.30)],
        ['uTurbidity', new THREE.Uniform(1)],
      ]),
    });
  }
}

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {{quality: string, water: object, sky: object, exposure: number}} opts
   */
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = opts.quality || 'mid';
    this.composer = null;
    this.underwater = null;
    this.bloom = null;
    this.toneMapping = null;
    this.effectPass = null;

    this._linearTargets = [];
    if (opts.water?.uniforms?.uLinearOut) this._linearTargets.push(opts.water.uniforms.uLinearOut);
    if (opts.sky?.uLinearOut) this._linearTargets.push(opts.sky.uLinearOut);

    this._build(this.quality);
  }

  setLinearOutput(on) {
    for (const u of this._linearTargets) u.value = on ? 1 : 0;
    if (this.underwater) this.underwater.uniforms.get('uLinear').value = on ? 1 : 0;
  }

  _build(q) {
    this.dispose();
    this.quality = q;
    const high = q === 'high';
    // EffectPass は dispose 時に Effect も破棄するため、品質変更ごとに作り直す。
    this.underwater = new UnderwaterEffect();

    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: high ? THREE.HalfFloatType : undefined,
      multisampling: high ? Math.min(4, this.renderer.capabilities.maxSamples || 0) : 0,
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const effects = [];
    if (high) {
      /* しきい値が低いと空や明るい浅場まで滲み、その滲みが竿や釣り人・
         桟橋のような細い/暗い物の上へかぶって黄色いモヤに見える
         （竿は完全に飲まれて消える）。水面を明るくしたぶん画面の大半が
         0.62 を超えるようになったので、太陽のきらめきだけが滲むところまで
         しきい値を上げ、半径と強度も絞る */
      this.bloom = new BloomEffect({
        luminanceThreshold: 0.85,
        luminanceSmoothing: 0.40,
        intensity: BLOOM_INTENSITY,
        mipmapBlur: true,
        kernelSize: KernelSize.MEDIUM,
      });
      if (this.bloom.mipmapBlurPass) this.bloom.mipmapBlurPass.radius = 0.55;
      effects.push(this.bloom);
    } else {
      this.bloom = null;
    }
    effects.push(this.underwater);
    // composer の入力を全品質でリニアに揃え、ここで ACES と sRGB 変換を一度だけ行う。
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    effects.push(this.toneMapping);

    this.effectPass = new EffectPass(this.camera, ...effects);
    this.effectPass.encodeOutput = true;
    this.composer.addPass(this.effectPass);
    this.setLinearOutput(true);
  }

  /** 水中カメラ用 uniform を更新（毎フレーム） */
  updateUnderwater(ctx) {
    if (!ctx || !this.underwater) return;
    const u = this.underwater.uniforms;
    const strength = ctx.strength ?? 0;
    u.get('uStrength').value = strength;
    u.get('uTime').value = ctx.time ?? 0;
    u.get('uSunDir').value.copy(ctx.sunDir);
    u.get('uNight').value = ctx.night ?? 0;
    u.get('uRain').value = ctx.rain ?? 0;
    u.get('uCloud').value = ctx.cloud ?? 0;
    u.get('uAbsorb').value.copy(ctx.absorb);
    u.get('uCamPos').value.copy(ctx.camPos);
    u.get('uCamNear').value = ctx.camNear ?? 0.1;
    u.get('uCamFar').value = ctx.camFar ?? 3000;
    u.get('uWaterY').value = ctx.waterY ?? 0;
    u.get('uTurbidity').value = ctx.turbidity ?? 1;
    /* 光の柱をワールド空間で作るので、深度→ワールドの復元行列を渡す */
    u.get('uInvProj').value.copy(this.camera.projectionMatrixInverse);
    u.get('uCamWorld').value.copy(this.camera.matrixWorld);
    // 水中でもBloomは残すが、視界を白く曇らせないよう大幅に弱める。
    if (this.bloom) this.bloom.intensity = THREE.MathUtils.lerp(BLOOM_INTENSITY, 0.08, strength);
  }

  /** 品質変更 */
  setQuality(q) {
    if (q === this.quality && this.composer) return;
    this._build(q);
    const size = this.renderer.getSize(new THREE.Vector2());
    this.setSize(size.width, size.height);
  }

  setSize(width, height) {
    if (this.composer) this.composer.setSize(width, height);
  }

  render(dt) {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    this.effectPass = null;
    this.bloom = null;
    this.toneMapping = null;
    this.underwater = null;
    this.renderer.autoClear = true;
  }
}
