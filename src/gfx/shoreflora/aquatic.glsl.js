/* ===========================================================
   浮葉（ヒツジグサ・ヒシ）と沈水植物（クロモ・エビモ）— ngExtendStandard の口
   -----------------------------------------------------------
   浮葉：インスタンス = placement.lilies の群落（ngLi0 = (x, z, 広がり, 回転)、ngLi1 = (花, 種類, ハッシュ, 水深)）。
     型板 = 葉 6 枚（切れ込みのある円盤）+ ヒシのロゼット 6 個（菱形の葉 12 枚）+ 花 1 輪（花弁 12 + 黄色い芯）。
     葉の中心の y = ngWaveH(c, t)·wind·ngShoalGain(ngDepth(c)) + 0.012（CPU の surfaceY と同じ式、±1cm）、
     葉の面は波の勾配で傾ける（y = h + ∇h·L）。蝋質の鏡面。polygonOffset で水面と争わない
   沈水植物：インスタンス = placement.weeds（ngWi0 = (x, 湖底の y, z, 高さ)、ngWi1 = (回転, 藻場の番号, rank, ハッシュ)）。
     型板 = 茎 4 本 × 9 節のリボン（軸の周りでカメラへ）。流れ（f.flowDir / flowStrength）で倒れて揺れる。UNDERWATER 層
   =========================================================== */
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { NG_WAVE_GLSL } from '../core/glsl/wave.glsl.js';
import { NG_SURFACE_GLSL } from '../core/glsl/surface.glsl.js';
import { SF_TPL } from './quality.js';

/* ---------------- 浮葉 ---------------- */
/* 頂点の高さは ngTerrainH を使わない（ngDepth だけ）。頂点のサンプラーは高さの 2 枚 */
export const SF_LILY_VS_PARS = NG_HEIGHTFIELD_GLSL + NG_WAVE_GLSL + NG_NOISE_GLSL + /* glsl */ `
in vec4 ngLi0;
in vec4 ngLi1;
in float ngPart;
uniform vec4 ngSfWave;   // x = water.time, y = water.wind
out vec4 vLiA;   // x = 半径 r（葉）/ t（花弁）, y = 角 a / 横, z = 部位, w = 葉のハッシュ
out vec3 vLiL;   // 葉の局所座標（模様）
vec3 ngLiP;
float ngLiSurf(vec2 p, out vec2 g) {
  float d = ngDepth(p);
  if (d <= 0.0) { g = vec2(0.0); return 0.0; }
  float k = ngSfWave.y * ngShoalGain(d);
  g = ngWaveD(p, ngSfWave.x) * k;
  return ngWaveH(p, ngSfWave.x) * k;
}
`;

export const SF_LILY_VS_NORMAL = /* glsl */ `
{
  vec2 cl = ngLi0.xy;
  float spread = max(ngLi0.z, 0.2), rot = ngLi0.w;
  float flower = ngLi1.x, kind = ngLi1.y, hc = ngLi1.z;
  float part = ngPart;
  float pi = floor(position.x / 16.0), li = mod(position.x, 16.0);
  float u = position.y, v = position.z;
  bool dead = false;
  /* 葉 i の中心：群落の中にハッシュで散らす（中心ほど密） */
  float hp = ngHash12(cl * 3.17 + pi * 7.7 + 0.4);
  float hp2 = ngHash12(cl * 1.31 + pi * 2.9 + 5.1);
  float npads = 4.0 + floor(hc * 2.99);   // 群落 1 つに葉 4–6 枚（疎らな紙吹雪にしない）
  float ang = pi * 2.39996 + hc * 6.2831;
  float rr = spread * 0.5 * sqrt((pi + 0.5) / 6.0) * mix(0.7, 1.15, hp);
  vec2 c = cl + vec2(cos(ang), sin(ang)) * rr;
  if (part > 0.5 && part < 1.5) c = cl + vec2(cos(ang + 1.2), sin(ang + 1.2)) * rr * 0.6;   // 花は葉の間
  vec2 g;
  float h = ngLiSurf(c, g) + 0.012;
  vec3 P = vec3(c.x, h, c.y), N = normalize(vec3(-g.x, 1.0, -g.y));
  float yaw = rot + hp * 6.2831 + 0.12 * sin(ngEnvTime * 0.25 + hp * 6.0);
  mat2 R = mat2(cos(yaw), -sin(yaw), sin(yaw), cos(yaw));
  vec3 L = vec3(0.0);
  if (part < 0.5) {
    /* ---- ヒツジグサの葉：切れ込み（30°）のある円盤、縁がわずかに反る ---- */
    if (kind > 0.5 || pi >= npads) dead = true;
    float rad = mix(0.10, 0.17, hp2);
    float a = mix(0.26, 6.2832 - 0.26, v);
    vec2 q = vec2(cos(a), sin(a)) * u * rad * vec2(1.0, 0.86);
    L = vec3(q.x, 0.004 * pow(u, 4.0), q.y);
  } else if (part < 1.5) {
    /* ---- 花：白い花弁 12 枚（2 重）が杯形に開く + 黄色い芯 ---- */
    if (kind > 0.5 || flower < 0.5) dead = true;
    float ring = step(6.0, li);
    float pa = li * 1.0472 + ring * 0.5236;
    float len = mix(0.045, 0.036, ring);
    float open = mix(0.55, 0.9, ring) ;
    vec2 dir = vec2(cos(pa), sin(pa));
    float t = u, sd = v;
    float w = len * 0.42 * sin(3.14159 * pow(clamp(t, 0.0, 1.0), 0.6));
    vec2 side = vec2(-dir.y, dir.x);
    float rise = t * len * (1.0 - open) * 1.6 + 0.004;
    L = vec3(dir.x * t * len * open + side.x * w * sd, rise + 0.006, dir.y * t * len * open + side.y * w * sd);
    if (li > 11.5) { L = vec3(cos(v * 6.2832), 0.0, sin(v * 6.2832)) * u * 0.011 + vec3(0.0, 0.014, 0.0); }
    N = normalize(vec3(-dir.x * (0.4 + open), 1.0, -dir.y * (0.4 + open)));
  } else {
    /* ---- ヒシのロゼット：菱形の葉 12 枚が放射状に重なる（直径 ≈ 20–28cm） ---- */
    if (kind < 0.5 || pi >= npads) dead = true;
    float la = li * 0.5236 + hp * 0.5;
    vec2 dir = vec2(cos(la), sin(la));
    vec2 side = vec2(-dir.y, dir.x);
    float len = mix(0.075, 0.1, hp2) * mix(0.75, 1.0, fract(li * 0.618));
    float r0 = 0.012 + 0.03 * step(6.0, li);
    /* u = 0 根元、0.55 の幅、1 先。v = 横 −1..1 */
    float w = u < 0.55 ? u / 0.55 : (1.0 - u) / 0.45;
    L = vec3(dir.x * (r0 + u * len) + side.x * w * len * 0.62 * v, 0.003 * (12.0 - li) / 12.0, dir.y * (r0 + u * len) + side.y * w * len * 0.62 * v);
  }
  L.xz = R * L.xz;
  /* 面を波の勾配へ沿わせる */
  P += L + vec3(0.0, dot(g, L.xz), 0.0);
  vLiA = vec4(u, v, part + (part > 1.5 ? 0.0 : 0.0), hp);
  if (part > 0.5 && part < 1.5 && li > 11.5) vLiA.z = 1.6;   // 芯
  vLiL = vec3(L.x, L.z, hp2);
  if (dead) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  ngLiP = P;
  objectNormal = N;
}
`;
export const SF_LILY_VS_BEGIN = /* glsl */ `transformed = ngLiP;`;

export const SF_LILY_FS_PARS = NG_SURFACE_GLSL + /* glsl */ `
in vec4 vLiA;
in vec3 vLiL;
`;
export const SF_LILY_FS_SURFACE = /* glsl */ `
float ngLiPart = vLiA.z;
{
  vec3 c;
  if (ngLiPart < 0.5) {
    /* 葉の表：暗い緑、放射の葉脈、縁と斑に赤褐色（ヒツジグサ） */
    float r = vLiA.x;
    float a = vLiA.y * 6.2832;
    float vein = 1.0 - smoothstep(0.0, 0.06, abs(fract(a * 3.2) - 0.5) * (0.4 + r));
    c = mix(vec3(0.040, 0.078, 0.026), vec3(0.060, 0.098, 0.030), vLiA.w);
    c *= 1.0 + 0.10 * vein;
    float blot = smoothstep(0.62, 0.8, ngVNoise2(vLiL.xy * 38.0 + vLiL.z * 17.0)) * step(0.55, vLiL.z);
    c = mix(c, vec3(0.085, 0.045, 0.025), max(blot * 0.6, smoothstep(0.88, 1.0, r) * 0.55));
  } else if (ngLiPart < 1.55) {
    /* 花弁：白（根元はわずかに緑） */
    c = mix(vec3(0.42, 0.48, 0.32), vec3(0.78, 0.77, 0.72), smoothstep(0.0, 0.4, vLiA.x));
  } else if (ngLiPart < 1.7) {
    c = vec3(0.58, 0.40, 0.05);
  } else {
    /* ヒシの葉：明るめの緑、ギザの縁は暗く、中心は赤み */
    c = mix(vec3(0.050, 0.090, 0.028), vec3(0.075, 0.112, 0.032), vLiA.w);
    c = mix(c, vec3(0.09, 0.05, 0.03), (1.0 - smoothstep(0.0, 0.25, vLiA.x)) * 0.5);
    c *= 1.0 - 0.25 * smoothstep(0.75, 1.0, abs(vLiA.y));
  }
  diffuseColor.rgb = c;
}
`;
export const SF_LILY_FS_NORMAL = /* glsl */ `
{
  /* 雨の水滴（葉の上の小さな玉）：細かいセルのハッシュで法線を盛る */
  if (ngRain > 0.02 && vLiA.z < 0.5) {
    vec2 q = vLiL.xy * 90.0;
    vec2 id = floor(q), f = fract(q) - 0.5;
    float hsh = ngHash12(id + vLiL.z * 31.0);
    float r = 0.18 + 0.15 * hsh;
    float d = length(f - (vec2(ngHash12(id + 3.0), ngHash12(id + 7.0)) - 0.5) * 0.4);
    float on = step(hsh, 0.35 * ngRain) * (1.0 - smoothstep(r * 0.7, r, d));
    vec3 bump = vec3(f.x, 0.0, f.y) * (on * 1.6);
    normal = normalize(normal + (viewMatrix * vec4(bump, 0.0)).xyz);
  }
}
`;
export const SF_LILY_FS_ROUGH = /* glsl */ `
roughnessFactor = vLiA.z < 0.5 ? 0.24 : (vLiA.z < 1.7 ? 0.55 : 0.32);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.5, ngWet);
`;
export const SF_LILY_FS_LIGHTS = /* glsl */ `
{
  /* 花弁の透過（白い花が逆光で光る）と、葉の縁から少し光が抜ける */
  vec3 Lw = ngKeyDir;
  vec3 Vw = normalize(cameraPosition - vNgWorld);
  vec3 E = ngKeyPreShadow * ngNearVis;
  float mu = dot(-Vw, Lw), g = 0.45;
  float hg = (1.0 - g * g) / (4.0 * 3.14159265 * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
  float k = vLiA.z > 0.5 && vLiA.z < 1.55 ? 1.4 : 0.15;
  reflectedLight.directDiffuse += E * diffuseColor.rgb * hg * k * max(Lw.y + 0.1, 0.0);
}
`;

/* ---------------- 沈水植物 ---------------- */
export const SF_WEED_VS_PARS = NG_NOISE_GLSL + /* glsl */ `
in vec4 ngWi0;
in vec4 ngWi1;
uniform vec4 ngSfFlow;   // xy = 流れの向き（世界 xz）, z = 強さ, w = 未使用
out vec4 vWeA;   // x = t, y = 横, z = 種類 0 クロモ・1 エビモ, w = ハッシュ
out float vWeL;  // 茎の長さ m（輪生の間隔を m で決める）
vec3 ngWeP;
`;
export const SF_WEED_VS_NORMAL = /* glsl */ `
{
  vec3 base = ngWi0.xyz;
  float H = max(ngWi0.w, 0.15);
  float rot = ngWi1.x, hc = ngWi1.w;
  float si = position.x, t = position.y, sd = position.z;
  float hs = ngHash12(base.xz * 5.3 + si * 4.7 + 0.2);
  float kind = step(0.62, ngHash12(base.xz * 0.37 + 1.9));
  float ang = si * 2.39996 + rot;
  float rr = 0.18 * sqrt((si + 0.5) / 4.0) * (0.6 + 0.8 * hc);
  vec3 root = base + vec3(cos(ang) * rr, -0.03, sin(ang) * rr);
  float h = H * mix(0.65, 1.1, hs);
  /* 水面の 8cm 下で止める（それ以上は流れの向きへ寝る） */
  float top = min(root.y + h, -0.08);
  float L = h;
  vec2 fd = ngSfFlow.xy;
  float fs = clamp(ngSfFlow.z, 0.0, 0.3);
  float ph = ngEnvTime * (0.55 + 0.25 * hs) + hs * 6.2831 - dot(base.xz, fd) * 0.6;
  vec2 perp = vec2(-fd.y, fd.x);
  /* 流れで倒れる（上ほど）+ ゆっくりした揺れ（波の下の往復流） */
  float lean = (0.18 + 2.2 * fs) * mix(0.8, 1.2, hs);
  float sway = 0.10 + 0.5 * fs;
  float a = t;
  vec2 off = (fd * (lean * a * a + sway * a * sin(ph + a * 2.2)) + perp * (sway * 0.6 * a * sin(ph * 0.73 + a * 3.1 + 1.0))) * L;
  float y = root.y + L * a * (1.0 - 0.35 * lean * a * a);
  vec3 Pc = vec3(root.x + off.x, min(y, top), root.z + off.y);
  /* 接線（数値） */
  float a2 = min(a + 0.06, 1.0);
  vec2 off2 = (fd * (lean * a2 * a2 + sway * a2 * sin(ph + a2 * 2.2)) + perp * (sway * 0.6 * a2 * sin(ph * 0.73 + a2 * 3.1 + 1.0))) * L;
  vec3 Pn = vec3(root.x + off2.x, min(root.y + L * a2 * (1.0 - 0.35 * lean * a2 * a2), top), root.z + off2.y);
  vec3 T = normalize(Pn - Pc + vec3(0.0, 1e-4, 0.0));
  vec3 V = normalize(cameraPosition - Pc);
  vec3 S = normalize(cross(T, V) + vec3(1e-5));
  float w = (kind < 0.5 ? 0.07 : 0.032) * mix(0.55, 1.0, sin(3.14159 * min(t * 1.1 + 0.05, 1.0)));
  vWeL = L;
  ngWeP = Pc + S * w * sd;
  objectNormal = normalize(cross(S, T) * (dot(cross(S, T), V) < 0.0 ? -1.0 : 1.0) + S * sd * 0.5);
  vWeA = vec4(t, sd, kind, hs);
}
`;
export const SF_WEED_VS_BEGIN = /* glsl */ `transformed = ngWeP;`;
export const SF_WEED_FS_PARS = NG_SURFACE_GLSL + /* glsl */ `
in vec4 vWeA;
in float vWeL;
`;
export const SF_WEED_FS_SURFACE = /* glsl */ `
{
  vec3 c = mix(vec3(0.030, 0.062, 0.020), vec3(0.058, 0.082, 0.026), vWeA.w);
  c = mix(vec3(0.045, 0.040, 0.024), c, smoothstep(0.0, 0.3, vWeA.x));
  c *= mix(0.8, 1.15, smoothstep(0.3, 1.0, vWeA.x));
  diffuseColor.rgb = c;
}
`;
/* クロモ：節ごとに輪生する細い葉。エビモ：波打つ縁の細長い葉（縁を細く削る） */
export const SF_WEED_FS_ALPHA = /* glsl */ `
{
  float v = abs(vWeA.y), t = vWeA.x;
  float a;
  if (vWeA.z < 0.5) {
    /* 輪生：2.2cm おきの節から細い葉が斜め上へ（羽状の線）。茎の芯は細く */
    float k = fract(t * vWeL / 0.022 + vWeA.w * 3.0 - v * 0.9);
    float th = mix(0.16, 0.07, v);
    float leaf = (1.0 - smoothstep(th * 0.5, th, abs(k - 0.5))) * (1.0 - smoothstep(0.82, 1.0, v));
    a = max(leaf, 1.0 - smoothstep(0.04, 0.08, v));
  } else {
    float e = 0.78 + 0.18 * sin(t * 70.0 + vWeA.w * 9.0);
    a = 1.0 - smoothstep(e - 0.08, e, v);
  }
  diffuseColor.a = a;
}
`;
export const SF_WEED_FS_ROUGH = /* glsl */ `roughnessFactor = 0.55;`;
export const SF_WEED_FS_LIGHTS = /* glsl */ `
{
  /* 水中の葉の透過（下向き光を背に） */
  vec3 Vw = normalize(cameraPosition - vNgWorld);
  vec3 E = ngKeyPreShadow * ngNearVis;
  float mu = dot(-Vw, ngKeyDir);
  reflectedLight.directDiffuse += E * diffuseColor.rgb * vec3(1.1, 1.4, 0.7) * (0.12 + 0.3 * smoothstep(0.2, 1.0, mu));
  reflectedLight.indirectDiffuse *= mix(0.45, 1.0, vWeA.x);
}
`;

/** 浮葉の型板：葉 6 枚（中心 + 2 環 × 14）、花（花弁 12 + 芯）、ロゼット 6 × 12 枚 */
export function lilyTemplate(T) {
  const pos = [], part = [], idx = [];
  const S = SF_TPL.lily.padSeg;
  for (let p = 0; p < SF_TPL.lily.pads; p++) {
    const o = pos.length / 3;
    pos.push(p * 16, 0, 0.5); part.push(0);
    for (const r of [0.55, 1.0]) for (let k = 0; k <= S; k++) { pos.push(p * 16, r, k / S); part.push(0); }
    for (let k = 0; k < S; k++) idx.push(o, o + 1 + k + 1, o + 1 + k);
    const r0 = o + 1, r1 = o + 1 + (S + 1);
    for (let k = 0; k < S; k++) { idx.push(r0 + k, r0 + k + 1, r1 + k, r0 + k + 1, r1 + k + 1, r1 + k); }
  }
  /* 花：花弁 12（3 × 2 頂点）+ 芯（扇 8） */
  for (let k = 0; k < 12; k++) {
    const o = pos.length / 3;
    for (const t of [0, 0.5, 1]) for (const s of [-1, 1]) { pos.push(k, t, s); part.push(1); }
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4, o + 3, o + 5, o + 4);
  }
  {
    const o = pos.length / 3;
    pos.push(12, 0, 0); part.push(1);
    for (let k = 0; k <= 8; k++) { pos.push(12, 1, k / 8); part.push(1); }
    for (let k = 0; k < 8; k++) idx.push(o, o + 1 + k + 1, o + 1 + k);
  }
  /* ロゼット：菱形 4 頂点（根元・左・右・先） */
  for (let p = 0; p < SF_TPL.lily.pads; p++) for (let k = 0; k < SF_TPL.lily.rosette; k++) {
    const o = pos.length / 3, id = p * 16 + k;
    pos.push(id, 0, 0, id, 0.55, -1, id, 0.55, 1, id, 1, 0); part.push(2, 2, 2, 2);
    idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
  }
  const g = new T.InstancedBufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('ngPart', new T.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  g.instanceCount = 0;
  return g;
}

/** 沈水植物の型板：茎 4 本 × 9 節 */
export function weedTemplate(T) {
  const pos = [], idx = [];
  const { stems, nodes } = SF_TPL.weed;
  for (let s = 0; s < stems; s++) {
    const o = pos.length / 3;
    for (let k = 0; k < nodes; k++) { const t = k / (nodes - 1); pos.push(s, t, -1, s, t, 1); }
    for (let k = 0; k < nodes - 1; k++) { const a = o + 2 * k; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new T.InstancedBufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.instanceCount = 0;
  return g;
}
