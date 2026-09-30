/* ===========================================================
   面の共通ヘルパ（濡れ・水たまり・雨の輪・空の鏡面）
   -----------------------------------------------------------
   水面・桟橋・岩・地形が同じ «雨の輪» と «濡れ» を使うので見た目が揃う。
   skyView の緯度経度の写像（ngSkyViewUV / ngSkyViewDir）はここで凍結する：
   sky が焼き、water・terrain が読む。u = 方位、v = 0.5 が地平線・1 が天頂で、
   地平付近を細かくするため仰角は √ で詰める（Hillaire 2020 と同じ）
   =========================================================== */
import { NG_NOISE_GLSL } from './noise.glsl.js';

/** ngWetSurface / ngPuddle / ngRainRings / ngSkyViewUV / ngSkyViewDir（サンプラー無し） */
export const NG_SURFACE_GLSL = NG_NOISE_GLSL + /* glsl */ `
#ifndef NG_LIB_SURFACE
#define NG_LIB_SURFACE
/* 濡れ：水膜で拡散反射が暗くなり（多孔質ほど強い）、面が滑らかになる */
void ngWetSurface(inout vec3 albedo, inout float rough, float porosity, float wet) {
  albedo = pow(max(albedo, vec3(1e-4)), vec3(1.0 + 1.5 * porosity * wet));
  rough = mix(rough, 0.08, wet);
}
/* 水たまりの覆い（0..1）。平らな所ほど、ngPuddle が大きいほど広がる */
float ngPuddle(vec2 xz, float slope) {
  float n = ngFbm(xz * 0.35, 3);
  float flat01 = 1.0 - smoothstep(0.02, 0.12, slope);
  return smoothstep(1.0 - ngPuddleAmt, 1.0 - ngPuddleAmt + 0.12, n) * flat01;
}
/* 雨の輪の勾配（dh/dx, dh/dz）。3 層のハッシュセル（0.35/0.6/1.1m）、
   セルごとに 0.9 秒に 1 つ広がる輪。輪はセルの内側に収まる大きさに止める */
vec2 ngRainRings(vec2 xz, float t, float rain) {
  vec2 g = vec2(0.0);
  if (rain < 0.01) return g;
  for (int k = 0; k < 3; k++) {
    float s = k == 0 ? 0.35 : k == 1 ? 0.6 : 1.1;
    vec2 q = xz / s + float(k) * 17.3;
    vec2 cell = floor(q);
    vec2 h = ngHash22(cell);
    if (ngHash12(cell + 5.1) > rain) continue;                 // 雨が弱いと輪の出るセルが減る
    float ph = t / 0.9 + h.x;
    float age = fract(ph);
    vec2 c = cell + 0.25 + 0.5 * ngHash22(cell + floor(ph));    // 輪ごとに中心を変える
    vec2 dv = q - c;
    float d = length(dv);
    float r = age * 0.24;
    float x = (d - r) / 0.045;
    float a = (1.0 - age) * exp(-x * x);
    float dh = a * cos(x * 3.0) * 3.0;                          // 輪の断面の傾き
    g += dh * dv / max(d, 1e-3) * (0.9 / s) * 0.02;
  }
  return g;
}
vec2 ngSkyViewUV(vec3 d) {
  float u = atan(d.z, d.x) * 0.15915494 + 0.5;
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) * 0.63661977);
  return vec2(u, v);
}
vec3 ngSkyViewDir(vec2 uv) {
  float az = (uv.x - 0.5) * 6.28318531;
  float s = uv.y * 2.0 - 1.0;
  float el = sign(s) * s * s * 1.57079633;
  return vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
}
#endif
`;

/** uniform sampler2D ngSkyViewTex / float ngSkyViewMips と vec3 ngSkySpecular(vec3 R, float rough) */
export const NG_SKYSPEC_GLSL = NG_SURFACE_GLSL + /* glsl */ `
#ifndef NG_LIB_SKYSPEC
#define NG_LIB_SKYSPEC
uniform sampler2D ngSkyViewTex;
uniform float ngSkyViewMips;
/* 粗さで mip を選ぶ。u の継ぎ目で微分が跳ぶので textureLod で明示する */
vec3 ngSkySpecular(vec3 R, float rough) {
  vec3 r = R;
  r.y = max(r.y, 0.0);                                         // 地平より下は地平の色（地面の反射は各自）
  return textureLod(ngSkyViewTex, ngSkyViewUV(normalize(r)), clamp(rough, 0.0, 1.0) * ngSkyViewMips).rgb;
}
#endif
`;
