/* ===========================================================
   post の GLSL
   -----------------------------------------------------------
   プログラムは 3 本（+ AA の pmndrs の分）：
   - PRE_FS（pmndrs の Effect。水中の Effect の後ろに連結される）：NaN/Inf の除去 → GTAO の合成（不透明の画素だけ）
     → 光芒の足し込み → 露出。出力は HDR（RGBA16F）
   - UTIL_FS（ngShaderMaterial 1 本を ngMode で使い分ける）：測光・集約・Bloom の縮小（Karis）/拡大・
     GTAO・AO のぼかし・光芒
   - FINAL_FS：CAS → Bloom（エネルギー保存の mix）→ ホワイトバランス → プルキニエ → 彩度 → ビネット → AgX
     → lift/gamma/gain → ブルーノイズのディザ（sRGB で ±0.5 LSB）→ 出力（画面なら sRGB をそのまま、RT なら線形へ戻す）
   =========================================================== */
import { NG_NEAR_SHADOW_GLSL } from '../core/glsl/shadow.glsl.js';

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/* pmndrs の Effect：inputColor は水中の Effect の後の HDR（露出前） */
export const PRE_FS = /* glsl */ `
// ngmod:post:post-pre
uniform float ngPostExposure;
uniform float ngPostAoAmt;
uniform float ngPostShaftAmt;
uniform sampler2D ngPostAoTex;
uniform sampler2D ngPostShaftTex;
uniform sampler2D ngSceneColor;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  bvec3 bad = bvec3(c.r != c.r || c.r > 65000.0, c.g != c.g || c.g > 65000.0, c.b != c.b || c.b > 65000.0);
  c = any(bad) ? vec3(0.0) : max(c, vec3(0.0));
  if (ngPostAoAmt > 0.0) {
    /* 不透明の画素だけ：最終の色が不透明の写し（late の前）と同じ所。水面・粒・半透明の上には掛けない */
    vec3 raw = texture(inputBuffer, uv).rgb;
    vec3 opq = texture(ngSceneColor, uv).rgb;
    float lr = dot(raw, vec3(0.2126, 0.7152, 0.0722)), lo = dot(opq, vec3(0.2126, 0.7152, 0.0722));
    float diff = abs(lr - lo) / max(max(lr, lo), 1e-4);
    float opaque = 1.0 - smoothstep(0.015, 0.05, diff);
    float ao = texture(ngPostAoTex, uv).r;
    c *= mix(1.0, ao, opaque * ngPostAoAmt);
  }
  if (ngPostShaftAmt > 0.0) c += max(texture(ngPostShaftTex, uv).rgb, vec3(0.0)) * ngPostShaftAmt;
  outputColor = vec4(min(c * ngPostExposure, vec3(60000.0)), inputColor.a);
}
`;

/* ngMode：0 測光 / 1 集約 / 2 Bloom の縮小 / 3 Bloom の拡大 / 4 AO のぼかし / 5 光芒 / 6 GTAO */
export const UTIL_FS = /* glsl */ `
${NG_NEAR_SHADOW_GLSL}
uniform int ngMode;
uniform sampler2D ngSrc;
uniform sampler2D ngSrc2;
uniform highp sampler2D ngSceneDepth;
uniform sampler2D ngBlueNoiseTex;
uniform vec4 ngSrcTexel;        // (1/w, 1/h, w, h) of ngSrc
uniform vec4 ngDstSize;         // (w, h, 1/w, 1/h) of the target
uniform float ngKaris;          // 1 = 最初の段（Karis 平均）
uniform float ngUpMix;          // 拡大の混ぜ（半径）
uniform vec4 ngProj;            // (P00, P11, near, far)
uniform mat4 ngCamWorld;        // カメラの matrixWorld
uniform vec4 ngDepthTexel;      // ngSceneDepth の (1/w, 1/h, w, h)
uniform vec4 ngShaft;           // (σ, ステップ数, 最大距離 m, 水面より上なら 1)
uniform vec4 ngAo;              // (半径 m, ステップ数, 強さ, 距離のフェード m)
uniform float ngFrameNo;
uniform float ngSrcGain;        // 測光・Bloom の最初の段の入力の倍率（PRE を飛ばした «融合» の道では露出をここで掛ける）
varying vec2 vUv;

float ngPostLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 ngSrcAt(vec2 uv) { return max(texture(ngSrc, uv).rgb * ngSrcGain, vec3(0.0)); }
float ngPostNoise(vec2 fc, float k) {
  return fract(texelFetch(ngBlueNoiseTex, ivec2(fc) & ivec2(63), 0).r + k * 0.61803398875);
}
vec3 ngPostViewPos(vec2 uv, float d) { return vec3((uv * 2.0 - 1.0) / ngProj.xy * d, -d); }
float ngPostDepth(vec2 uv) { return texture(ngSceneDepth, uv).r; }

vec4 ngModeMeter() {
  /* 32×18 の測光：各画素は自分の区画を 4×4 の双線形のタップで覆う（= 1/80 縮小の log 平均）。中央を重く（周辺 40%） */
  float s = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 uv = vUv + (vec2(float(i), float(j)) - 1.5) * 0.25 * ngDstSize.zw;
      s += log2(max(ngPostLum(ngSrcAt(uv)), 1e-5));
    }
  }
  vec2 q = (vUv - 0.5) * vec2(1.6, 1.9);
  float w = mix(0.4, 1.0, exp(-dot(q, q) * 2.2));
  return vec4(s * 0.0625 * w, w, 0.0, 1.0);
}

vec4 ngModeReduce() {
  /* 測光の RT（32×18）を 1 画素へ。結果は RGBA8 に詰める：log2 L ∈ [−20, 12] → 16 bit */
  float sl = 0.0, sw = 0.0;
  for (int j = 0; j < 18; j++) {
    for (int i = 0; i < 32; i++) {
      vec4 m = texelFetch(ngSrc, ivec2(i, j), 0);
      sl += m.r; sw += m.g;
    }
  }
  float L = sl / max(sw, 1e-4);
  L = (L != L) ? 0.0 : L;
  float v = floor(clamp((L + 20.0) / 32.0, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(v / 256.0), lo = v - hi * 256.0;
  return vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
}

vec3 ngKarisW(vec3 c) { return c / (1.0 + ngPostLum(c)); }
vec4 ngModeDown() {
  /* COD の 13 タップ縮小。最初の段は 5 つの箱を Karis 平均（輝点のちらつきを抑える） */
  vec2 t = ngSrcTexel.xy;
  vec3 a = ngSrcAt(vUv + t * vec2(-2.0, -2.0));
  vec3 b = ngSrcAt(vUv + t * vec2( 0.0, -2.0));
  vec3 c = ngSrcAt(vUv + t * vec2( 2.0, -2.0));
  vec3 d = ngSrcAt(vUv + t * vec2(-2.0,  0.0));
  vec3 e = ngSrcAt(vUv);
  vec3 f = ngSrcAt(vUv + t * vec2( 2.0,  0.0));
  vec3 g = ngSrcAt(vUv + t * vec2(-2.0,  2.0));
  vec3 h = ngSrcAt(vUv + t * vec2( 0.0,  2.0));
  vec3 i = ngSrcAt(vUv + t * vec2( 2.0,  2.0));
  vec3 j = ngSrcAt(vUv + t * vec2(-1.0, -1.0));
  vec3 k = ngSrcAt(vUv + t * vec2( 1.0, -1.0));
  vec3 l = ngSrcAt(vUv + t * vec2(-1.0,  1.0));
  vec3 m = ngSrcAt(vUv + t * vec2( 1.0,  1.0));
  vec3 o;
  if (ngKaris > 0.5) {
    vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25, g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
    float w0 = 1.0 / (1.0 + ngPostLum(g0)), w1 = 1.0 / (1.0 + ngPostLum(g1)), w2 = 1.0 / (1.0 + ngPostLum(g2)), w3 = 1.0 / (1.0 + ngPostLum(g3)), w4 = 1.0 / (1.0 + ngPostLum(g4));
    w0 *= 0.5; w1 *= 0.125; w2 *= 0.125; w3 *= 0.125; w4 *= 0.125;
    o = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  o = (o.r != o.r || o.g != o.g || o.b != o.b) ? vec3(0.0) : min(o, vec3(60000.0));
  /* 最初の段：太陽の円盤（露出後 ~4e4）を 256 で頭打ち。エネルギー保存の 3.5% でも画面の 1/4 が白く飛ぶ光暈にしない */
  if (ngKaris > 0.5) o *= min(1.0, 256.0 / max(ngPostLum(o), 1e-4));
  return vec4(o, 1.0);
}

vec4 ngModeUp() {
  /* 3×3 のテント（下の段）と、この段の縮小を混ぜる（正規化した和なのでエネルギーは増えない） */
  vec2 t = ngSrcTexel.xy;
  vec3 s = texture(ngSrc, vUv).rgb * 4.0;
  s += (texture(ngSrc, vUv + vec2(-t.x, 0.0)).rgb + texture(ngSrc, vUv + vec2(t.x, 0.0)).rgb + texture(ngSrc, vUv + vec2(0.0, -t.y)).rgb + texture(ngSrc, vUv + vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(ngSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(ngSrc, vUv + vec2(t.x, -t.y)).rgb + texture(ngSrc, vUv + vec2(-t.x, t.y)).rgb + texture(ngSrc, vUv + vec2(t.x, t.y)).rgb;
  return vec4(mix(texture(ngSrc2, vUv).rgb, s / 16.0, ngUpMix), 1.0);
}

vec4 ngModeAoBlur() {
  /* 4×4 の深度つきのぼかし（GTAO の 4×4 の雑音の型を消す）。r = AO, g = 深度 */
  vec2 t = ngSrcTexel.xy;
  vec2 c = texture(ngSrc, vUv).rg;
  float s = 0.0, w = 0.0;
  for (int j = -2; j < 2; j++) {
    for (int i = -2; i < 2; i++) {
      vec2 v = texture(ngSrc, vUv + (vec2(float(i), float(j)) + 0.5) * t).rg;
      float k = exp(-abs(v.g - c.g) / max(c.g * 0.04, 0.02));
      s += v.r * k; w += k;
    }
  }
  return vec4(s / max(w, 1e-4), c.g, 0.0, 1.0);
}

/* 光芒：視線を近景の影で区切って、key の前方散乱を足す（1 タップの影。雑音はブルーノイズで散らす） */
float ngShaftVis(vec3 P) {
  vec4 c = ngNearShadowMatrix * vec4(P, 1.0);
  vec3 s = c.xyz / max(c.w, 1e-6);
  s.z += ngNearShadowParams.z;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0 || s.z < 0.0 || s.z > 1.0) return 1.0;
  return mix(1.0, ngNearTap(s.xy, s.z), ngNearShadowParams.w);
}
vec4 ngModeShaft() {
  vec3 vd = normalize(vec3((vUv * 2.0 - 1.0) / ngProj.xy, -1.0));
  vec3 dir = normalize(mat3(ngCamWorld) * vd);
  vec3 cam = ngCamWorld[3].xyz;
  float d = ngPostDepth(vUv);
  float tEnd = min(d / max(-vd.z, 1e-3), ngShaft.z);
  if (ngShaft.w > 0.5 && dir.y < -1e-3) tEnd = min(tEnd, max(cam.y - ngCamWaterY, 0.0) / -dir.y);
  int n = int(ngShaft.y);
  float ds = tEnd / max(ngShaft.y, 1.0);
  float j = ngPostNoise(gl_FragCoord.xy, ngFrameNo);
  float vis = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= n) break;
    vis += ngShaftVis(cam + dir * ((float(i) + j) * ds));
  }
  float mu = dot(dir, ngSunDir);
  float g = 0.72, g2 = g * g;
  float hg = (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
  float phase = mix(0.0796, hg, 0.85);
  vec3 L = ngKeyRad * (phase * ngShaft.x * vis * ds);
  return vec4(L, 1.0);
}

/* GTAO（Jimenez 2016）：2 スライス × 両側 n ステップ、半径 R m。環境光の割合だけ暗くする（日向の直射は残す） */
vec4 ngModeGtao() {
  float d = ngPostDepth(vUv);
  if (d >= ngProj.w * 0.98 || d <= 0.0) return vec4(1.0, d, 0.0, 1.0);
  vec3 P = ngPostViewPos(vUv, d);
  vec2 tx = ngDepthTexel.xy;
  float dl = ngPostDepth(vUv - vec2(tx.x, 0.0)), dr = ngPostDepth(vUv + vec2(tx.x, 0.0));
  float db = ngPostDepth(vUv - vec2(0.0, tx.y)), dt = ngPostDepth(vUv + vec2(0.0, tx.y));
  vec3 dx = abs(dr - d) < abs(d - dl) ? ngPostViewPos(vUv + vec2(tx.x, 0.0), dr) - P : P - ngPostViewPos(vUv - vec2(tx.x, 0.0), dl);
  vec3 dy = abs(dt - d) < abs(d - db) ? ngPostViewPos(vUv + vec2(0.0, tx.y), dt) - P : P - ngPostViewPos(vUv - vec2(0.0, tx.y), db);
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;
  float R = ngAo.x;
  float rPx = R * ngProj.y * 0.5 * ngDepthTexel.w / d;
  rPx = min(rPx, 0.12 * ngDepthTexel.w);
  if (rPx < 1.5) return vec4(1.0, d, 0.0, 1.0);
  /* 4×4 の交互の雑音（ぼかしで消える） */
  ivec2 ip = ivec2(gl_FragCoord.xy) & 3;
  float jr = float((ip.x + ip.y * 4) * 7 & 15) / 16.0;
  float jo = fract(float(ip.y * 2 + ip.x) * 0.25 + float((ip.x + ip.y) & 1) * 0.125 + 0.0625);
  int steps = int(ngAo.y);
  float vis = 0.0;
  for (int s = 0; s < 2; s++) {
    float phi = (float(s) + jr) * 1.5707963;
    vec2 dir2 = vec2(cos(phi), sin(phi));
    vec3 dv = vec3(dir2, 0.0);
    vec3 ortho = dv - dot(dv, V) * V;
    vec3 axis = normalize(cross(dv, V));
    vec3 pn = N - axis * dot(N, axis);
    float pl = max(length(pn), 1e-4);
    float sgn = sign(dot(ortho, pn));
    float cn = clamp(dot(pn, V) / pl, -1.0, 1.0);
    float nAng = sgn * acos(cn);
    float h0c = -1.0, h1c = -1.0;
    for (int k = 0; k < 8; k++) {
      if (k >= steps) break;
      float f = (float(k) + jo) / float(steps);
      f = f * f;
      vec2 off = dir2 * max(f * rPx, 1.0 + float(k)) * ngDepthTexel.xy;
      for (int side = 0; side < 2; side++) {
        vec2 suv = side == 0 ? vUv + off : vUv - off;
        float sd = ngPostDepth(suv);
        vec3 S = ngPostViewPos(suv, sd) - P;
        float len = length(S);
        float cosH = dot(S, V) / max(len, 1e-4);
        float fall = clamp(1.0 - len * len / (R * R), 0.0, 1.0);
        cosH = mix(-1.0, cosH, fall);
        if (side == 0) h0c = max(h0c, cosH); else h1c = max(h1c, cosH);
      }
    }
    /* side 0（+dir）が正の角、side 1（−dir）が負の角 */
    float h1 = nAng + min(acos(clamp(h0c, -1.0, 1.0)) - nAng, 1.5707963);
    float h0 = nAng + max(-acos(clamp(h1c, -1.0, 1.0)) - nAng, -1.5707963);
    float sn = sin(nAng);
    vis += pl * ((-cos(2.0 * h0 - nAng) + cn + 2.0 * h0 * sn) + (-cos(2.0 * h1 - nAng) + cn + 2.0 * h1 * sn)) * 0.25;
  }
  float ao = clamp(vis * 0.5, 0.0, 1.0);
  /* 直射の割合：日向（近景の影）× N·L。環境光（ngSkyIrr·π）の割合だけ AO を掛ける */
  vec3 Pw = (ngCamWorld * vec4(P, 1.0)).xyz;
  vec3 Nw = normalize(mat3(ngCamWorld) * N);
  float sun = ngNearShadowAt(Pw + Nw * 0.05) * max(dot(Nw, ngKeyDir), 0.0) * ngPostLum(ngKeyRad);
  float amb = ngPostLum(ngSkyIrr) * 3.14159;
  float fAmb = amb / max(amb + sun, 1e-5);
  float fade = 1.0 - smoothstep(ngAo.w * 0.6, ngAo.w, d);
  ao = mix(1.0, pow(ao, ngAo.z), fAmb * fade);
  return vec4(ao, d, 0.0, 1.0);
}

void main() {
  vec4 o;
  if (ngMode == 0) o = ngModeMeter();
  else if (ngMode == 1) o = ngModeReduce();
  else if (ngMode == 2) o = ngModeDown();
  else if (ngMode == 3) o = ngModeUp();
  else if (ngMode == 4) o = ngModeAoBlur();
  else if (ngMode == 5) o = ngModeShaft();
  else o = ngModeGtao();
  gl_FragColor = o;
}
`;

export const FINAL_FS = /* glsl */ `
/* AgX（Sobotka。three r180 の AgXToneMapping・pmndrs の AGX と同じ式。toneMappingExposure には頼らない：露出は PRE で掛け済み） */
vec3 ngAgxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 ngAgx(vec3 c) {
  const mat3 toRec2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 fromRec2020 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  c = inset * (toRec2020 * c);
  c = clamp((log2(max(c, vec3(1e-10))) + 12.47393) / 16.5, 0.0, 1.0);
  c = outset * ngAgxContrast(c);
  c = pow(max(c, vec3(0.0)), vec3(2.2));
  return clamp(fromRec2020 * c, 0.0, 1.0);
}
uniform sampler2D ngHdr;
uniform sampler2D ngBloom;
uniform sampler2D ngBlueNoiseTex;
uniform vec4 ngHdrTexel;        // (1/w, 1/h, w, h)
uniform float ngBloomAmt;
uniform float ngCas;
uniform vec3 ngWb;
uniform float ngSat;
uniform float ngPurk;
uniform float ngVig;
uniform vec3 ngLift;
uniform float ngGamma;
uniform vec3 ngGain;
uniform float ngFrameNo;
uniform float ngOutSrgb;        // 1 = 画面へ（sRGB の値をそのまま書く）、0 = sRGB8 の RT へ（線形へ戻す）
uniform float ngChart;          // 1 = AgX のチャート（24 パッチ × ±4EV）
uniform vec3 ngChartCols[24];
uniform float ngDither;
/* 融合の道（水中の Effect が休んでいる水上）：PRE（NaN の除去・AO・光芒・露出）をここで行い、HDR の RT の書き出しと読みを省く */
uniform float ngFused;
uniform float ngFExpo;
uniform float ngFAoAmt;
uniform float ngFShaftAmt;
uniform sampler2D ngFAoTex;
uniform sampler2D ngFShaftTex;
uniform sampler2D ngFSceneColor;
varying vec2 vUv;
vec3 ngClean(vec3 c) {
  bvec3 bad = bvec3(c.r != c.r || c.r > 65000.0, c.g != c.g || c.g > 65000.0, c.b != c.b || c.b > 65000.0);
  return any(bad) ? vec3(0.0) : max(c, vec3(0.0));
}
vec3 ngHdrAt(vec2 uv) { vec3 c = texture(ngHdr, uv).rgb; return ngFused > 0.5 ? min(ngClean(c) * ngFExpo, vec3(60000.0)) : c; }
vec3 ngHdrCenter(vec2 uv) {
  vec3 raw = texture(ngHdr, uv).rgb;
  if (ngFused < 0.5) return raw;
  vec3 c = ngClean(raw);
  if (ngFAoAmt > 0.0) {
    vec3 opq = texture(ngFSceneColor, uv).rgb;
    float lr = dot(raw, vec3(0.2126, 0.7152, 0.0722)), lo = dot(opq, vec3(0.2126, 0.7152, 0.0722));
    float diff = abs(lr - lo) / max(max(lr, lo), 1e-4);
    float opaque = 1.0 - smoothstep(0.015, 0.05, diff);
    c *= mix(1.0, texture(ngFAoTex, uv).r, opaque * ngFAoAmt);
  }
  if (ngFShaftAmt > 0.0) c += max(texture(ngFShaftTex, uv).rgb, vec3(0.0)) * ngFShaftAmt;
  return min(c * ngFExpo, vec3(60000.0));
}

float ngPostLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float ngToSrgb(float x) { return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
float ngToLin(float x) { return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }

vec3 ngGrade(vec3 c, float vig) {
  c *= ngWb;
  float L = ngPostLum(c);
  /* プルキニエ：暗い所ほど杆体（青寄り・彩度が落ちる）。灯籠の光（明るい所）は色を残す */
  float rod = ngPurk * (1.0 - smoothstep(0.02, 0.45, L));
  c = mix(c, mix(vec3(L), c, 0.65) * vec3(0.84, 0.97, 1.32), rod);
  L = ngPostLum(c);
  c = max(vec3(L) + (c - vec3(L)) * ngSat, vec3(0.0));
  c *= vig;
  vec3 t = ngAgx(c);
  t = ngGain * (t + ngLift * (1.0 - t));
  t = pow(max(t, vec3(0.0)), vec3(1.0 / ngGamma));
  return clamp(t, 0.0, 1.0);
}

void main() {
  vec3 c;
  float vig = 1.0;
  if (ngChart > 0.5) {
    /* 9 段（−4..+4EV）× 24 パッチ。18% 灰が 0EV の行で «景色の中間灰» になる */
    vec2 g = vec2(vUv.x * 24.0, (1.0 - vUv.y) * 9.0);
    int i = int(clamp(floor(g.x), 0.0, 23.0));
    float ev = floor(g.y) - 4.0;
    vec2 f = fract(g);
    float edge = step(0.06, f.x) * step(f.x, 0.94) * step(0.08, f.y) * step(f.y, 0.92);
    c = ngChartCols[i] * exp2(ev) * edge;
  } else {
    vec2 t = ngHdrTexel.xy;
    c = ngHdrCenter(vUv);
    if (ngCas > 0.0) {
      /* 軽い CAS（AMD FidelityFX の簡略）：近傍の輝度の幅で鋭さを決める（DRS で落とした解像度を戻す） */
      vec3 a = ngHdrAt(vUv - vec2(0.0, t.y)), b = ngHdrAt(vUv - vec2(t.x, 0.0));
      vec3 d = ngHdrAt(vUv + vec2(t.x, 0.0)), e = ngHdrAt(vUv + vec2(0.0, t.y));
      vec3 mn = min(min(min(a, b), min(d, e)), c), mx = max(max(max(a, b), max(d, e)), c);
      vec3 cm = mn / (1.0 + mn), cx = mx / (1.0 + mx);
      vec3 amp = sqrt(clamp(min(cm, 1.0 - cx) / max(cx, 1e-4), 0.0, 1.0));
      vec3 w = -amp * mix(0.125, 0.2, ngCas);
      c = max((c + (a + b + d + e) * w) / (1.0 + 4.0 * w), vec3(0.0));
    }
    c = mix(c, texture(ngBloom, vUv).rgb, ngBloomAmt);
    vec2 q = (vUv - 0.5) * vec2(ngHdrTexel.z / ngHdrTexel.w, 1.0);
    float r2 = dot(q, q) / (0.25 * (ngHdrTexel.z * ngHdrTexel.z / (ngHdrTexel.w * ngHdrTexel.w)) + 0.25);
    vig = 1.0 - ngVig * pow(clamp(r2, 0.0, 1.0), 1.25);
  }
  vec3 t = ngGrade(c, vig);
  vec3 s = vec3(ngToSrgb(t.r), ngToSrgb(t.g), ngToSrgb(t.b));
  /* ブルーノイズのディザ：sRGB で ±0.5 LSB（三角分布：2 枚を引き算） */
  ivec2 p = ivec2(gl_FragCoord.xy);
  float n1 = fract(texelFetch(ngBlueNoiseTex, p & ivec2(63), 0).r + ngFrameNo * 0.61803398875);
  float n2 = fract(texelFetch(ngBlueNoiseTex, (p + ivec2(17, 41)) & ivec2(63), 0).r + ngFrameNo * 0.7548776662);
  s = clamp(s + (n1 - n2) * (ngDither / 255.0), 0.0, 1.0);
  gl_FragColor = ngOutSrgb > 0.5 ? vec4(s, 1.0) : vec4(ngToLin(s.r), ngToLin(s.g), ngToLin(s.b), 1.0);
}
`;
