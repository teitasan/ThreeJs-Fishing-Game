/* ===========================================================
   farAlbedo（CORE_API §6.5）：±512m を上から見た地形 + 樹冠の色（2048²、0.5m/テクセル）
   -----------------------------------------------------------
   - 地形の色：素材と同じ重み（ngTerrWeights）× 層の平均色（配列 A の最後の mip）× 同じマクロの色むら。
     素材の «180m より先と反射» はこれをそのまま読むので、近景から遠景への渡りで色が跳ばない
   - 樹冠の色：placement.trees を樹種の葉の色で 4m の格子へ散らした CPU の地図（植林の暗い帯・広葉樹の明るい斑）。
     樹冠の密度（ngCanopyAt）で地形の色へ混ぜる。trees・groundcover が遠景の色合わせに使う
   - RGBA8 sRGB（線形で書けばハードウェアが詰める）、mip あり
   =========================================================== */
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { SPECIES, SPECIES_IDS } from '../../world/species.js';
import { hash01 } from '../../world/rng.js';
import { terrainWeightsGLSL } from './terrain.glsl.js';

export const FAR_SIZE = 2048;
export const CANOPY_N = 256;         // ±512m @4m

export const FAR_BAKE = NG_HEIGHTFIELD_GLSL + terrainWeightsGLSL() + /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray ngTerrA;
uniform sampler2D ngTerrMacro;
uniform sampler2D ngTerrCanopyCol;
uniform vec4 ngTerrDock;
uniform vec4 ngTerrFlats[4];
uniform float ngTerrMaxLod;
const float ngTerrPoroB[8] = float[8](0.6, 0.35, 0.75, 0.35, 0.9, 0.5, 0.25, 0.85);
vec3 ngTerrMacroTintB(vec4 m1, vec4 m2, vec4 m3, float veg) {
  float br = 1.0 + 0.11 * (m1.r * 2.0 - 1.0) + 0.15 * (m2.g * 2.0 - 1.0) + 0.12 * (m3.b * 2.0 - 1.0);
  vec3 hue = mix(vec3(1.05, 1.0, 0.88), vec3(0.94, 1.0, 1.07), m2.a);
  vec3 vh = mix(vec3(1.10, 1.06, 0.78), vec3(0.86, 1.0, 1.02), m1.b);
  return br * mix(vec3(1.0), hue, 0.6) * mix(vec3(1.0), vh, veg * 0.8);
}
void main() {
  vec2 xz = ngHfMapXf.z + vUv / ngHfMapXf.w;
  float y = ngTerrainH(xz);
  vec3 Ng = ngTerrainN(xz);
  float sd = ngTerrShoreD(xz);
  vec2 cn = ngCanopyAt(xz);
  float w[8];
  ngTerrWeights(vec3(xz.x, y, xz.y), Ng, sd, ngTerrBed(xz), cn, ngTerrTrailAt(xz, ngTerrDock), w);
  vec3 c = vec3(0.0);
  /* 層の平均色：16² の段を 4×4 で読む（最後の 1×1 の段に頼らない） */
  for (int i = 0; i < 8; i++) {
    if (w[i] < 1e-3) continue;
    vec3 a = vec3(0.0);
    for (int k = 0; k < 16; k++) {
      vec2 q = (vec2(float(k & 3), float(k >> 2)) + 0.5) * 0.25;
      vec3 t = textureLod(ngTerrA, vec3(q, float(i)), ngTerrMaxLod - 4.0).rgb;
      a += t * t;
    }
    c += w[i] * a / 16.0;
  }
  float veg = w[0] * 0.4 + w[1] + w[2];
  vec4 m1 = textureLod(ngTerrMacro, xz * (1.0 / 23.0), 3.0);
  vec4 m2 = textureLod(ngTerrMacro, xz * (1.0 / 97.0) + 0.37, 1.0);
  vec4 m3 = textureLod(ngTerrMacro, xz * (1.0 / 431.0) + 0.71, 0.0);
  c *= ngTerrMacroTintB(m1, m2, m3, veg);
  /* 藻場の暗さ（素材と同じ） */
  float weed = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 fl = ngTerrFlats[i];
    if (fl.z <= 0.0) continue;
    weed = max(weed, (1.0 - smoothstep(fl.z * 0.45, fl.z * 1.05, distance(xz, fl.xy) + 6.0 * (ngVNoise2(xz * 0.12 + float(i)) - 0.5))) * fl.w);
  }
  weed *= 1.0 - smoothstep(-0.6, 0.0, y);
  c = mix(c, c * vec3(0.55, 0.62, 0.45), weed * 0.75);
  float under = 1.0 - smoothstep(-0.12, 0.02, y);
  float poro = 0.0;
  for (int i = 0; i < 8; i++) poro += w[i] * ngTerrPoroB[i];
  c *= 1.0 - under * 0.8 * poro * 0.48;
  vec4 cc = texture(ngTerrCanopyCol, ngFarMapUV(xz));
  float a = smoothstep(0.12, 0.7, cn.x) * 0.85 * cc.a;
  gl_FragColor = vec4(mix(c, cc.rgb, a), a);
}
`;

/**
 * 樹冠の色の地図（CPU、RGBA8 sRGB）。rgb = 樹種の葉の色の平均（影の分だけ暗く）、a = 木のある割合
 * @param {typeof import('three')} T
 * @param {object} placement
 * @param {number} seed
 * @returns {import('three').DataTexture}
 */
export function buildCanopyColor(T, placement, seed) {
  const N = CANOPY_N, cell = 1024 / N;
  const acc = new Float32Array(N * N * 4);
  const tr = placement?.trees;
  const n = tr?.count || 0;
  for (let k = 0; k < n; k++) {
    const sp = SPECIES[SPECIES_IDS[tr.species[k]]] || SPECIES.sugi;
    const h = tr.h[k], R = Math.max(1.5, (sp.crownR || 0.2) * h);
    const v = 0.82 + 0.3 * hash01(seed, k, 17);
    const x = tr.x[k], z = tr.z[k];
    const i0 = Math.floor((x - R + 512) / cell), i1 = Math.floor((x + R + 512) / cell);
    const j0 = Math.floor((z - R + 512) / cell), j1 = Math.floor((z + R + 512) / cell);
    for (let j = Math.max(0, j0); j <= Math.min(N - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(N - 1, i1); i++) {
        const cx = -512 + (i + 0.5) * cell, cz = -512 + (j + 0.5) * cell;
        const d = Math.hypot(cx - x, cz - z) / (R + cell * 0.7);
        if (d >= 1) continue;
        const wgt = (1 - d * d) * h;
        const o = (j * N + i) * 4;
        acc[o] += sp.leaf[0] * v * wgt; acc[o + 1] += sp.leaf[1] * v * wgt; acc[o + 2] += sp.leaf[2] * v * wgt; acc[o + 3] += wgt;
      }
    }
  }
  const px = new Uint8Array(N * N * 4);
  const enc = (c) => {
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255)));
  };
  for (let k = 0; k < N * N; k++) {
    const wsum = acc[k * 4 + 3];
    /* 上から見た樹冠は葉の隙間の影で葉 1 枚より暗い（×0.78） */
    const r = wsum > 0 ? (acc[k * 4] / wsum) * 0.78 : 0.035, g = wsum > 0 ? (acc[k * 4 + 1] / wsum) * 0.78 : 0.052, b = wsum > 0 ? (acc[k * 4 + 2] / wsum) * 0.78 : 0.03;
    px[k * 4] = enc(r); px[k * 4 + 1] = enc(g); px[k * 4 + 2] = enc(b);
    px[k * 4 + 3] = Math.round(Math.min(1, wsum / 20) * 255);
  }
  const tex = new T.DataTexture(px, N, N, T.RGBAFormat, T.UnsignedByteType);
  tex.colorSpace = T.SRGBColorSpace;
  tex.magFilter = T.LinearFilter;
  tex.minFilter = T.LinearFilter;
  tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  tex.name = 'ng-terrain-canopyColor';
  return tex;
}
