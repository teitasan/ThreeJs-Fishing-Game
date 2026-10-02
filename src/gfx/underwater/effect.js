/* ===========================================================
   水中の後処理（services.underwater.createEffect() → pmndrs の Effect。CORE_API §6.3 の約束）
   -----------------------------------------------------------
   post が HDR の鎖の «先頭»（露出前）に差し込む。入力は露出前のリニア放射輝度（ngFrame の単位）
   1. 光柱（半解像度の自前の RT、Effect.update の中で描く）：視線に沿って最大 40m を N ステップ。
      各点で «水面から入った key の光» × 近景の影（桟橋・舟・釣り人で切れる）× caustics の焦点（光の筋）×
      HG 位相（前方散乱 g 0.82）を足し、fog チャンクが既に足した «等方で影の無い» key の内散乱を引く
      （= 内散乱の key の分を正しい位相・影・焦点に置き換える補正。負にもなる）。N = 0（low）は解析の光暈だけ
   2. 距離のぼけ：線形深度に応じた半径の 8 タップ（前景を背景に滲ませない重み）。水中の前方散乱の «遠くが柔らかい»
   3. ウォーターラインのメニスカス：近平面の 4 隅の «水面からの高さ»（CPU で waveField から）を双線形に補間して
      線を引く。線の帯は暗く、水側に薄い明線、屈折の歪み。カメラが水上で下半分が水に沈むときは水側を水の色へ
   水上（uw ≤ 0.5 かつ水面から 0.35m より遠い）では mainImage の先頭で帰る（予算：水上 0。光柱の RT も描かない）
   =========================================================== */
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { ngShaderMaterial } from '../core/extend.js';
import { NG_NEAR_SHADOW_GLSL } from '../core/glsl/shadow.glsl.js';
import { NG_BLUENOISE_GLSL } from '../core/glsl/bluenoise.glsl.js';
import { CAUSTICS_LOOP_SEC } from './caustics.glsl.js';

const RAYS_VS = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const RAYS_FS = NG_NEAR_SHADOW_GLSL + NG_BLUENOISE_GLSL + /* glsl */ `
uniform highp sampler2DArray uCaustTex;
uniform highp sampler2D ngSceneDepth;
uniform vec3 ngUwC00, ngUwC10, ngUwC01, ngUwC11;   // 視線の向き（view の z = −1 の点、世界）
uniform vec3 ngUwCam;
uniform vec3 ngUwKeyE;      // 水面を透過した key の放射照度 rgb（水平面）
uniform vec3 ngUwLw;        // 水中の key の向き（光へ向かう、上向き）
uniform vec4 ngUwCs;        // (1/タイル m, ヘッセ行列の幅, 平均の補正, 時刻 s)
uniform vec4 ngUwRay;       // (ステップ数, 最大距離 m, フレーム番号, 水面の y)
in vec2 vUv;

float ngUwHG(float mu, float g) {
  float d = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  return 0.07957747 * (1.0 - g * g) / (d * sqrt(d));
}
/* 近景の影の 1 タップ（光柱は多数のステップで平均されるので PCF は要らない） */
float ngUwShadow1(vec3 P) {
  vec4 c = ngNearShadowMatrix * vec4(P, 1.0);
  vec3 s = c.xyz / max(c.w, 1e-6);
  s.z += ngNearShadowParams.z;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0 || s.z < 0.0 || s.z > 1.0) return 1.0;
  return mix(1.0, ngNearTap(s.xy, s.z), ngNearShadowParams.w);
}
/* 水中の点 P を通る光の筋の明るさ（P から光へ遡った水面の点で caustics のタイル、mip を上げてならす） */
float ngUwFocus(vec3 P, float depth) {
  float layers = float(textureSize(uCaustTex, 0).z);
  if (layers < 1.5 || ngUwCs.y <= 0.0) return 1.0;
  vec2 q = P.xz + ngUwLw.xz / max(ngUwLw.y, 0.2) * depth;
  float f = fract(ngUwCs.w / ${CAUSTICS_LOOP_SEC.toFixed(1)}) * layers;
  float l0 = floor(f), l1 = l0 + 1.0 >= layers ? 0.0 : l0 + 1.0;
  vec2 uv = q * ngUwCs.x + vec2(0.0061, 0.0023) * ngUwCs.w;
  vec3 H = (mix(texture(uCaustTex, vec3(uv, l0), 3.0).rgb, texture(uCaustTex, vec3(uv, l1), 3.0).rgb, f - l0) * 2.0 - 1.0) * ngUwCs.y;
  /* 太い光の筋（1–3m）：mip 3 の長めの波だけを、焦点を 3 倍に寄せて読む（細い網目は視線の積分で消える） */
  float D = depth / max(ngUwLw.y, 0.2) * 0.75;
  float det = (1.0 + D * H.x) * (1.0 + D * H.y) - D * D * H.z * H.z;
  float I = inversesqrt(det * det + 0.04);
  float x = D * ngUwCs.y * 0.385 * 0.125;
  I /= 1.0 + ngUwCs.z * x * x * exp(-0.35 * x * x);
  return clamp(I, 0.0, 4.0);
}

void main() {
  vec3 dirZ = mix(mix(ngUwC00, ngUwC10, vUv.x), mix(ngUwC01, ngUwC11, vUv.x), vUv.y);
  float z = texture(ngSceneDepth, vUv).r;
  float len = length(dirZ);
  vec3 dir = dirZ / max(len, 1e-5);
  float dist = z * len;
  vec3 sa = ngSigmaA, st = ngSigmaA + vec3(ngSigmaS);
  vec3 kd = ngSigmaA + vec3(0.3 * ngSigmaS);
  float cw = max(ngUwLw.y, 0.2);
  float mu = dot(dir, ngUwLw);
  /* 位相：前方散乱の HG（湖の懸濁物 g 0.82）と等方の混ぜ。fog チャンクの等方の key の分（0.55/2π × 青緑）を引く */
  float ph = 0.72 * ngUwHG(mu, 0.82) + 0.28 * 0.07957747;
  /* fog チャンクの内散乱は «水平面の» 放射照度（E·sinα）で数えている。ngUwKeyE は光に垂直な面の値 */
  vec3 iso = 0.55 * 0.15915494 * vec3(0.86, 1.0, 0.84) * clamp(ngKeyDir.y, 0.08, 1.0);
  float Lmax = min(dist, ngUwRay.y);
  float wY = ngUwRay.w;
  /* 水面より上の区間は数えない（水中のカメラから水面の向こう） */
  if (dir.y > 1e-4) Lmax = min(Lmax, max((wY - ngUwCam.y) / dir.y, 0.0));
  vec3 acc = vec3(0.0);
  int N = int(ngUwRay.x + 0.5);
  if (N <= 0) {
    /* 解析の光暈：カメラの深さの下向き光で一様に（影・筋なし） */
    float d0 = max(wY - ngUwCam.y, 0.0);
    vec3 Td = exp(-kd * d0 / cw);
    acc = ngSigmaS * Td * (ph - iso) * (1.0 - exp(-st * Lmax)) / max(st, vec3(1e-4));
  } else {
    /* ステップは近くに密（s = Lmax·u²）：光の筋が読めるのはカメラから数 m。
       始点を画素ごとにずらす（ブルーノイズ。交互の勾配ノイズは格子の模様が見えた）。合成で 5 タップにならす */
    float jit = ngBlueNoise(gl_FragCoord.xy, ngUwRay.z);
    float invN = 1.0 / float(N);
    for (int i = 0; i < 24; i++) {
      if (i >= N) break;
      float u = (float(i) + jit) * invN;
      float s = Lmax * u * u;
      float ds = Lmax * 2.0 * u * invN;
      vec3 P = ngUwCam + dir * s;
      float depth = max(wY - P.y, 0.0);
      vec3 W = exp(-st * s - kd * depth / cw) * ds;
      float V = ngUwShadow1(P) * ngUwFocus(P, depth);
      /* 平均は物理のまま（σs で ph − iso）。影と筋の «揺らぎ» (V − 1) は懸濁物の前方散乱 σp = 0.14/m が
         作るものとして別に足す（σs 0.03 の澄んだ水の等方の値では横から見た筋が 2% 未満で消えるため。art の判断） */
      acc += W * (ph - iso + (0.14 / max(ngSigmaS, 1e-3)) * ph * (V - 1.0));
    }
    acc *= ngSigmaS;
  }
  vec3 L = ngUwKeyE * acc;
  if (ngUwRay.y < 0.0) {   // 開発用：5m 先の点の焦点と影
    vec3 P5 = ngUwCam + dir * 4.5;
    vec3 Pb = ngUwCam + dir * min(dist, 60.0) * 0.99;
    L = vec3(ngUwFocus(P5, max(wY - P5.y, 0.0)) * 0.1 - 0.1, ngUwShadow1(P5) * 0.1 - 0.05, ngNearShadowAt(Pb) * 0.1 - 0.05);
  }
  gl_FragColor = vec4(clamp(L, vec3(-60000.0), vec3(60000.0)), z);
}
`;

/* 光柱の半解像度の分離ぼかし（9 タップ、深さ（a）の近いタップだけ）。ディザの粒をならす */
const BLUR_FS = /* glsl */ `
uniform sampler2D tNgUwSrc;
uniform vec2 ngUwStep;
in vec2 vUv;
void main() {
  vec4 c = texture(tNgUwSrc, vUv);
  vec3 sum = c.rgb * 0.2270270; float ws = 0.2270270;
  const float W[4] = float[4](0.1945946, 0.1216216, 0.0540541, 0.0162162);
  for (int i = 1; i <= 4; i++) {
    for (int sgn = -1; sgn <= 1; sgn += 2) {
      vec4 t = texture(tNgUwSrc, vUv + ngUwStep * float(i * sgn));
      float w = W[i - 1] * exp(-abs(t.a - c.a) / (0.08 * c.a + 0.3));
      sum += t.rgb * w; ws += w;
    }
  }
  gl_FragColor = vec4(sum / ws, c.a);
}
`;

const COMPOSITE_FS = /* glsl */ `
uniform sampler2D tRays;
uniform highp sampler2D tLin;
uniform vec4 uP;      // x 有効, y ぼけの半径 px, z 光柱あり, w ビネット
uniform vec4 uMenD;   // 近平面の 4 隅の «水面からの高さ» m（00, 10, 01, 11）
uniform vec4 uMen;    // x メニスカスあり, y カメラが水中, z 帯の幅 px, w 時刻
uniform vec3 uFog;    // 水の内散乱の放射輝度（水上のカメラの沈んだ側）
uniform vec3 uSig;    // σt rgb
uniform vec3 uKd;     // 下向き光の減衰 σa + 0.3σs
uniform vec4 uCam;    // x カメラの深さ m, y far m
uniform vec3 uC00, uC10, uC01, uC11;   // 視線の向き（view の z = −1、世界）
uniform float uDbg;   // 開発用：1 = 線形深度 /100、2 = 光柱 ×4 + 0.5

const vec2 PD[8] = vec2[8](vec2(-0.613, 0.617), vec2(0.170, -0.040), vec2(-0.299, 0.791), vec2(0.645, 0.493),
  vec2(-0.651, -0.717), vec2(0.421, 0.027), vec2(-0.817, 0.054), vec2(-0.105, -0.892));

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uP.x < 0.5) { outputColor = inputColor; return; }
  vec3 col = inputColor.rgb;
  float z = texture(tLin, uv).r;
  if (uDbg > 0.5) {
    outputColor = uDbg < 1.5 ? vec4(vec3(z / 100.0), 1.0) : uDbg < 2.5 ? vec4(texture(tRays, uv).rgb * 4.0 + 0.5, 1.0)
      : vec4(z > uCam.y * 0.9 ? 1.0 : 0.0, uMen.y, uCam.y / 4000.0, 1.0);
    return;
  }
  if (uMen.y > 0.5) {
    /* 何も描かれていない画素（空のドーム）を水中から見ている：下・水平の向きは «無限に続く水» の色
       （内散乱を光路で積分した閉形式。湖底の抜け・空のドームの地面色を水の奥行きにする） */
    vec3 dz = mix(mix(uC00, uC10, uv.x), mix(uC01, uC11, uv.x), uv.y);
    float dy = dz.y / max(length(dz), 1e-5);
    /* fog チャンク（ngWaterSegment）と同じ形：区間の平均の深さの下向き光 × (1 − T)。光路は 3/σt（T ≈ 5%）で打ち切る */
    vec3 Lf = 3.0 / max(uSig, vec3(1e-3));
    vec3 Linf = uFog * exp(-uKd * max(uCam.x - 0.5 * min(dy, 0.0) * Lf, 0.0)) * (1.0 - exp(-uSig * Lf));
    float wInf = 1.0 - smoothstep(0.04, 0.22, dy);
    float zFar = uCam.y * 0.9;
    if (z > zFar) col = mix(col, Linf, wInf);
    else if (wInf > 0.0) {
      /* 縁の画素（MSAA の解決で空の色が混ざる）：隣が空なら半分だけ水の色へ */
      float zn = max(max(texture(tLin, uv + vec2(texelSize.x, 0.0)).r, texture(tLin, uv - vec2(texelSize.x, 0.0)).r),
                     max(texture(tLin, uv + vec2(0.0, texelSize.y)).r, texture(tLin, uv - vec2(0.0, texelSize.y)).r));
      if (zn > zFar) col = mix(col, Linf, 0.6 * wInf);
    }
    /* 距離のぼけ：前方散乱で遠くが柔らかい。前景（近いタップ）は背景へ混ぜない。空の画素のタップは水の色で */
    float r = uP.y * (1.0 - exp(-min(z, 200.0) * 0.045));
    if (r > 0.6) {
      vec3 sum = col; float wsum = 1.0;
      for (int i = 0; i < 8; i++) {
        vec2 o = uv + PD[i] * r * texelSize;
        float zt = texture(tLin, o).r;
        float w = smoothstep(0.55, 0.85, zt / max(z, 1e-3));
        vec3 ct = texture(inputBuffer, o).rgb;
        if (zt > zFar) ct = mix(ct, Linf, wInf);
        sum += ct * w; wsum += w;
      }
      col = mix(col, sum / wsum, smoothstep(1.5, 18.0, z) * 0.9);
    }
    if (uP.z > 0.5) {
      /* 光柱（半解像度）：深さの近いタップだけで双線形の継ぎ目を抑える */
      /* 半解像度の光柱を 5 タップ（十字、1.5 半解像度の画素）で深さを見ながらならす（ブルーノイズのディザを消す） */
      vec2 rt = 3.0 * texelSize;
      vec3 rs = vec3(0.0); float rw = 0.0;
      for (int i = 0; i < 5; i++) {
        vec2 o = i == 0 ? vec2(0.0) : i == 1 ? vec2(rt.x, 0.0) : i == 2 ? vec2(-rt.x, 0.0) : i == 3 ? vec2(0.0, rt.y) : vec2(0.0, -rt.y);
        vec4 R = texture(tRays, uv + o);
        float w = exp(-abs(R.a - z) / (0.08 * z + 0.25)) * (i == 0 ? 2.0 : 1.0) + 1e-3;
        rs += R.rgb * w; rw += w;
      }
      col += rs / rw;
    }
    /* レンズの周辺減光（水のマスク越しの見え方。控えめ） */
    vec2 c = uv - 0.5;
    col *= 1.0 - uP.w * dot(c, c) * 2.0;
  }
  if (uMen.x > 0.5) {
    float d = mix(mix(uMenD.x, uMenD.y, uv.x), mix(uMenD.z, uMenD.w, uv.x), uv.y);
    d += 0.0035 * sin(uv.x * 37.0 + uMen.w * 2.3) + 0.002 * sin(uv.x * 91.0 - uMen.w * 3.1);
    float px = d / max(fwidth(d), 1e-6);   // 線からの符号付きの距離 px（+ = 近平面の点が水面より上）
    float band = uMen.z;
    float k = exp(-(px * px) / (band * band));
    /* 線の近くは水の曲面のレンズで縦に引き伸ばされる */
    vec2 o = uv + vec2(0.0, -sign(px) * band * 0.6 * k) * texelSize;
    vec3 base = k > 0.02 ? texture(inputBuffer, o).rgb : col;
    if (uMen.y < 0.5 && px < 0.0) {
      /* 水上のカメラ：沈んだ側は水越し（緑がかった霞と減衰） */
      vec3 T = exp(-uSig * 2.5);
      base = base * T * vec3(0.78, 0.92, 0.90) + uFog * (1.0 - T);
    } else if (uMen.y > 0.5 && px > 0.0) {
      /* 水中のカメラ：近平面の上の端は空気（水の霞が薄い） */
      base = base * 1.15;
    }
    col = mix(col, base, max(k, step(0.0, -px) * (1.0 - uMen.y) + step(0.0, px) * uMen.y));
    /* 帯：暗い縁と、水側の細い明線 */
    col *= 1.0 - 0.62 * k;
    float hi = exp(-pow((px + band * 0.45) / (band * 0.18), 2.0));
    col += hi * 0.35 * max(dot(base, vec3(0.2126, 0.7152, 0.0722)), 0.02);
  }
  outputColor = vec4(max(col, vec3(0.0)), inputColor.a);
}
`;

class NgUnderwaterEffect extends Effect {
  constructor(owner, uniforms) {
    super('NgUnderwater', COMPOSITE_FS, { attributes: EffectAttribute.CONVOLUTION, blendFunction: BlendFunction.NORMAL, uniforms });
    this._owner = owner;
  }

  update(renderer, inputBuffer, dt) {
    try { this._owner.renderRays(renderer, inputBuffer); } catch (e) { this._owner.fail(e); }
  }
}

/**
 * 水中の後処理の持ち主（underwater モジュールが 1 つ持つ）
 */
export class UnderwaterFx {
  /**
   * @param {object} ctx モジュールの ctx
   * @param {object} mod underwater モジュール（optics・段の表・ログ）
   */
  constructor(ctx, mod) {
    const T = ctx.THREE;
    this.ctx = ctx;
    this.mod = mod;
    this.T = T;
    this.rt = new T.WebGLRenderTarget(4, 4, { type: T.HalfFloatType, format: T.RGBAFormat, depthBuffer: false, magFilter: T.LinearFilter, minFilter: T.LinearFilter });
    this.rt.texture.name = 'ng-uw-rays';
    this.rt2 = this.rt.clone();
    this.rt2.texture.name = 'ng-uw-rays-b';
    this.blue = { value: null };
    this.raysU = {
      ngUwC00: { value: new T.Vector3() }, ngUwC10: { value: new T.Vector3() }, ngUwC01: { value: new T.Vector3() }, ngUwC11: { value: new T.Vector3() },
      ngUwCam: { value: new T.Vector3() }, ngUwKeyE: { value: new T.Vector3() }, ngUwLw: { value: new T.Vector3(0, 1, 0) },
      ngUwCs: { value: new T.Vector4(1 / 7, 0, 0, 0) }, ngUwRay: { value: new T.Vector4(16, 40, 0, 0) },
    };
    this.raysMat = ngShaderMaterial({
      key: 'underwater-rays', module: 'underwater', lights: false, fog: false,
      uniforms: { ...this.raysU, ...ctx.shadows.nearUniforms, ngSceneDepth: ctx.pipeline.uniforms.ngSceneDepth, uCaustTex: ctx.caustics.uCaustTex, ngBlueNoiseTex: this.blue },
      vertexShader: RAYS_VS, fragmentShader: RAYS_FS, depthTest: false, depthWrite: false,
    });
    this.blurU = { tNgUwSrc: { value: this.rt.texture }, ngUwStep: { value: new T.Vector2() } };
    this.blurMat = ngShaderMaterial({
      key: 'underwater-raysblur', module: 'underwater', lights: false, fog: false,
      uniforms: this.blurU, vertexShader: RAYS_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false,
    });
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.tri = new T.Mesh(g, this.raysMat);
    this.tri.frustumCulled = false;
    this.scene = new T.Scene();
    this.scene.add(this.tri);
    this.cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.u = {
      tRays: new T.Uniform(this.rt.texture),
      tLin: ctx.pipeline.uniforms.ngSceneDepth,
      uP: new T.Uniform(new T.Vector4(0, 0, 0, 0)),
      uMenD: new T.Uniform(new T.Vector4(1, 1, 1, 1)),
      uMen: new T.Uniform(new T.Vector4(0, 0, 6, 0)),
      uFog: new T.Uniform(new T.Vector3()),
      uSig: new T.Uniform(new T.Vector3(0.23, 0.105, 0.075)),
      uKd: new T.Uniform(new T.Vector3(0.21, 0.084, 0.054)),
      uCam: new T.Uniform(new T.Vector4(1, 3000, 0, 0)),
      uDbg: new T.Uniform(0),
      uC00: new T.Uniform(this.raysU.ngUwC00.value), uC10: new T.Uniform(this.raysU.ngUwC10.value),
      uC01: new T.Uniform(this.raysU.ngUwC01.value), uC11: new T.Uniform(this.raysU.ngUwC11.value),
    };
    this.effect = new NgUnderwaterEffect(this, new Map(Object.entries(this.u)));
    this.active = false;
    this.raysOn = false;
    this._v = new T.Vector3();
    this._fails = 0;
    this.lastRaysMs = 0;
  }

  fail(e) {
    this._fails++;
    this.ctx.log('underwater-fx', '水中の光柱を描けなかった（光柱なしで続ける）', e);
    if (this._fails > 2) this.raysOn = false;
  }

  /**
   * 毎フレーム（underwater の prepare）。有効か・光柱の uniform・メニスカスの 4 隅
   * @param {object} f
   * @param {{ shaftSteps:number, shaftScale:number, blurPx:number }} q 段の表
   * @param {object} st { uw, camDepth, keyE, lw, cs, menD, menOn, fog, sigT }
   */
  setFrame(f, q, st) {
    const u = this.u;
    this.active = st.uw > 0.5 || st.menOn;
    u.uP.value.set(this.active ? 1 : 0, q.blurPx, st.uw > 0.5 && this._fails <= 2 ? 1 : 0, 0.22);
    u.uMen.value.set(st.menOn ? 1 : 0, st.uw > 0.5 ? 1 : 0, q.menBand, f.envTime || 0);
    u.uMenD.value.copy(st.menD);
    u.uFog.value.copy(st.fog);
    u.uSig.value.copy(st.sigT);
    u.uKd.value.copy(st.kd);
    u.uDbg.value = Math.min(3, Number(globalThis.__ngUwDbg) || 0) === 3 && Number(globalThis.__ngUwDbg) === 5 ? 2 : (Number(globalThis.__ngUwDbg) || 0);
    this.raysOn = this.active && st.uw > 0.5 && this._fails <= 2 && !globalThis.__ngUwNoRays;
    if (!this.raysOn) u.uP.value.z = 0;
    this.steps = q.shaftSteps;
    this.scale = q.shaftScale;
    const R = this.raysU;
    R.ngUwKeyE.value.copy(st.keyE);
    R.ngUwLw.value.copy(st.lw);
    R.ngUwCs.value.copy(st.cs);
    R.ngUwRay.value.set(q.shaftSteps, Number(globalThis.__ngUwDbg) === 5 ? -1 : 40, (f.frameIndex || 0) % 1024, st.waterY);
    const cam = f.camera;
    if (cam && cam.isPerspectiveCamera) {
      cam.updateMatrixWorld();
      R.ngUwCam.value.copy(cam.position);
      u.uCam.value.set(Math.max(st.waterY - cam.position.y, 0), cam.far, 0, 0);
      const th = Math.tan((cam.fov * Math.PI) / 360) / (cam.zoom || 1), a = cam.aspect;
      const set = (v, x, y) => v.set(x * th * a, y * th, -1).transformDirection(cam.matrixWorld).multiplyScalar(1 / this._cosZ(x, y, th, a));
      set(R.ngUwC00.value, -1, -1); set(R.ngUwC10.value, 1, -1); set(R.ngUwC01.value, -1, 1); set(R.ngUwC11.value, 1, 1);
    }
  }

  /* transformDirection は正規化するので、view の z = −1 の点の長さへ戻す */
  _cosZ(x, y, th, a) { return 1 / Math.hypot(x * th * a, y * th, 1); }

  /* Effect.update から（post の EffectPass.render の直前）。半解像度の光柱 */
  renderRays(renderer, inputBuffer) {
    if (!this.raysOn || !inputBuffer) return;
    const w = Math.max(4, Math.round(inputBuffer.width * this.scale)), h = Math.max(4, Math.round(inputBuffer.height * this.scale));
    if (this.rt.width !== w || this.rt.height !== h) { this.rt.setSize(w, h); this.rt2.setSize(w, h); }
    const prev = renderer.getRenderTarget();
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    this.tri.material = this.raysMat;
    renderer.render(this.scene, this.cam);
    /* 分離ぼかし：rt → rt2（横）→ rt（縦） */
    this.tri.material = this.blurMat;
    this.blurU.tNgUwSrc.value = this.rt.texture; this.blurU.ngUwStep.value.set(1.5 / w, 0);
    renderer.setRenderTarget(this.rt2);
    renderer.render(this.scene, this.cam);
    this.blurU.tNgUwSrc.value = this.rt2.texture; this.blurU.ngUwStep.value.set(0, 1.5 / h);
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = ac;
  }

  dispose() {
    this.rt.dispose();
    this.rt2.dispose();
    this.raysMat.dispose();
    this.blurMat.dispose();
    this.tri.geometry.dispose();
    this.effect.dispose();
  }
}
