/* ===========================================================
   歩ける帯の境目の藪（placement.thicket）の見た目
   -----------------------------------------------------------
   当たり r = 0.55m の円柱 1 本ごとに低木 1 株（見た目の半径 ≈ r × 1.1、高さ = thicket.height 1.25–2.1m）。
   形は 3 種（丸い株・壺形・低く広がる）を起動時に JS で組む（mulberry32、Math.random なし）。
   葉は forge で焼いた «葉の房» のカード（alpha、high は A2C）、枝は細い角柱。
   1 つの InstancedMesh（全形を 1 つの幾何に並べ、形は頂点の属性で選ぶ代わりに 3 つの InstancedMesh で同じマテリアル）。
   ngOwn(…, NO_REFLECT, SHADOW_ONLY)：不透明に描き、近景の影を落とし、反射には写さない
   =========================================================== */
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { NG_WIND_GLSL } from '../core/glsl/wind.glsl.js';
import { NG_SURFACE_GLSL } from '../core/glsl/surface.glsl.js';
import { mulberry32, stream } from '../../world/rng.js';

/** 葉の房のテクスチャ（左 7/8 = 葉の房、右の帯 = 樹皮）。線形アルベド + alpha */
export const SHRUB_LEAF_FRAG = NG_NOISE_GLSL + /* glsl */ `
float ngShLeaf(vec2 p, vec2 c, float ang, vec2 sz, out float vein) {
  vec2 d = p - c;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / sz;
  /* 卵形（先が尖る）：x が長軸 */
  float w = sqrt(max(1.0 - q.x * q.x, 0.0)) * mix(1.0, 0.55, smoothstep(-0.2, 1.0, q.x));
  float inside = step(abs(q.y), w) * step(abs(q.x), 1.0);
  vein = (1.0 - smoothstep(0.0, 0.06, abs(q.y))) + 0.5 * (1.0 - smoothstep(0.0, 0.05, abs(fract(q.x * 3.0 + abs(q.y) * 1.6) - 0.5) - 0.42));
  return inside;
}
void main() {
  vec2 uv = vUv;
  if (uv.x > 0.875) {
    float b = ngVNoise2(uv * vec2(40.0, 6.0));
    gl_FragColor = vec4(mix(vec3(0.055, 0.042, 0.030), vec3(0.12, 0.095, 0.07), b), 1.0);
    return;
  }
  vec2 p = vec2(uv.x / 0.875, uv.y);
  float a = 0.0;
  vec3 col = vec3(0.0);
  /* 葉 9 枚：小枝から放射状に。決まった配置（ハッシュ）で房の外形がカードの四角に見えない */
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 h = vec2(fract(sin(fi * 12.9898 + 1.3) * 43758.55), fract(sin(fi * 78.233 + 4.1) * 23421.63));
    float ang = fi * 0.72 + 0.4 + (h.x - 0.5) * 0.5;
    vec2 c = vec2(0.5, 0.42) + vec2(cos(ang), sin(ang)) * mix(0.16, 0.3, h.y);
    float vein;
    float l = ngShLeaf(p, c, ang, vec2(mix(0.15, 0.21, h.x), mix(0.07, 0.095, h.y)), vein);
    if (l > 0.5) {
      a = 1.0;
      vec3 base = mix(vec3(0.055, 0.095, 0.028), vec3(0.085, 0.125, 0.038), h.y);
      base *= mix(0.85, 1.12, ngVNoise2(p * 18.0 + fi));
      col = base * (1.0 - 0.18 * clamp(vein, 0.0, 1.0));
    }
  }
  /* 小枝 */
  float tw = 1.0 - smoothstep(0.006, 0.012, abs(p.x - 0.5 - (p.y - 0.42) * 0.1));
  if (a < 0.5 && tw > 0.5 && p.y < 0.5) { a = 1.0; col = vec3(0.07, 0.055, 0.04); }
  gl_FragColor = vec4(col, a);
}
`;

/**
 * 低木の幾何（高さ 1・半径 1 に正規化。インスタンスの行列で (r·1.1, height, r·1.1) に拡縮）
 * @param {typeof import('three')} T
 * @param {number} seed
 * @param {number} variant 0 丸い株・1 壺形・2 低く広がる
 * @param {number} cards 葉のカードの枚数
 */
export function buildShrubGeometry(T, seed, variant, cards) {
  const rng = mulberry32(stream(seed, `gc-shrub-${variant}`));
  const pos = [], nrm = [], uv = [], info = [], idx = [];
  const push = (p, n, u, v, h, leaf) => {
    pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); uv.push(u, v); info.push(h, leaf, 0, 0);
    return pos.length / 3 - 1;
  };
  /* 冠の形（中心の高さ, 縦の半径, 横の半径）。高さ 1 に正規化 */
  const crown = [[0.58, 0.42, 0.92], [0.62, 0.38, 0.78], [0.42, 0.36, 1.0]][variant] || [0.58, 0.42, 0.92];
  /* 枝：根元から冠へ */
  const stems = 6 + Math.floor(rng() * 3);
  const tips = [];
  for (let s = 0; s < stems; s++) {
    const a = (s / stems) * Math.PI * 2 + rng() * 0.6;
    const out = (variant === 1 ? 0.35 : 0.55) * (0.6 + 0.4 * rng());
    const top = [Math.cos(a) * out, crown[0] + crown[1] * (0.2 + 0.5 * rng()), Math.sin(a) * out];
    tips.push(top);
    const base = [Math.cos(a) * 0.05, -0.02, Math.sin(a) * 0.05];
    const segs = 3;
    const ring = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const c = [base[0] + (top[0] - base[0]) * t * t, base[1] + (top[1] - base[1]) * t, base[2] + (top[2] - base[2]) * t * t];
      const r = 0.018 * (1 - 0.7 * t);
      const row = [];
      for (let j = 0; j < 4; j++) {
        const b = (j / 4) * Math.PI * 2;
        const n = [Math.cos(b), 0, Math.sin(b)];
        row.push(push([c[0] + n[0] * r, c[1], c[2] + n[2] * r], n, 0.93, t, c[1], 0));
      }
      ring.push(row);
    }
    for (let k = 0; k < segs; k++) for (let j = 0; j < 4; j++) {
      const a0 = ring[k][j], a1 = ring[k][(j + 1) % 4], b0 = ring[k + 1][j], b1 = ring[k + 1][(j + 1) % 4];
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  /* 葉のカード：冠の楕円体の中（外側に寄せる）。法線は冠の中心から外へ曲げる（柔らかい塊の陰影） */
  for (let i = 0; i < cards; i++) {
    let x, y, z, d;
    do {
      x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; d = x * x + y * y + z * z;
    } while (d > 1 || d < 0.12);
    const sh = Math.pow(d, 0.25);
    const c = [x / Math.sqrt(d) * sh * crown[2] * 0.95, crown[0] + y / Math.sqrt(d) * sh * crown[1], z / Math.sqrt(d) * sh * crown[2] * 0.95];
    if (c[1] < 0.08) c[1] = 0.08 + rng() * 0.1;
    const out = [c[0], (c[1] - crown[0]) * 1.6, c[2]];
    const ol = Math.hypot(out[0], out[1], out[2]) || 1;
    const on = [out[0] / ol, out[1] / ol, out[2] / ol];
    /* カードの面：外向きの法線に乱れを足し、上向きに少し寄せる */
    let n = [on[0] + (rng() - 0.5) * 0.9, on[1] + 0.35 + (rng() - 0.5) * 0.6, on[2] + (rng() - 0.5) * 0.9];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    let tA = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [tA[1] * n[2] - tA[2] * n[1], tA[2] * n[0] - tA[0] * n[2], tA[0] * n[1] - tA[1] * n[0]];
    const ul = Math.hypot(u[0], u[1], u[2]) || 1;
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const ang = rng() * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
    const U = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
    const V = [v[0] * ca - u[0] * sa, v[1] * ca - u[1] * sa, v[2] * ca - u[2] * sa];
    const s = (0.26 + 0.14 * rng()) * (variant === 2 ? 1.1 : 1.0);
    /* 頂点の法線 = 冠の外向き 0.65 + カードの面 0.35 */
    const bn = [on[0] * 0.65 + n[0] * 0.35, on[1] * 0.65 + n[1] * 0.35, on[2] * 0.65 + n[2] * 0.35];
    const bl = Math.hypot(bn[0], bn[1], bn[2]) || 1;
    const N = [bn[0] / bl, bn[1] / bl, bn[2] / bl];
    const q = [];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [c[0] + (U[0] * a + V[0] * b) * s * 0.5, c[1] + (U[1] * a + V[1] * b) * s * 0.5, c[2] + (U[2] * a + V[2] * b) * s * 0.5];
      q.push(push(p, N, (a * 0.5 + 0.5) * 0.86, b * 0.5 + 0.5, p[1], 1));
    }
    idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setAttribute('ngShrub', new T.Float32BufferAttribute(info, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export const SHRUB_VS_PARS = NG_WIND_GLSL + /* glsl */ `
in vec4 ngShrub;      // x = 高さ（正規化 0..1）, y = 葉 1 / 枝 0
out vec4 vShInfo;     // x = 高さ, y = 葉, z = 株のハッシュ, w = 突風
`;
export const SHRUB_VS_BEGIN = /* glsl */ `
{
  vec3 ngBase = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec4 ngW = ngWindAt(ngBase.xz);
  float hh = ngHash12(ngBase.xz * 0.37);
  float k = max(transformed.y, 0.0);
  float sway = (0.012 + 0.028 * ngW.w) * ngW.z * 0.3;
  float ph = ngEnvTime * (1.3 + 0.4 * hh) + hh * 6.2831 + dot(ngBase.xz, ngW.xy) * 0.3;
  vec2 ofs = ngW.xy * (sway * (0.7 + 0.3 * sin(ph))) * k * k;
  /* 葉のはためき（カードごと） */
  float fl = ngShrub.y * sin(ngEnvTime * 5.3 + dot(transformed, vec3(17.0, 9.0, 13.0))) * 0.012 * (0.3 + ngW.w) * ngW.z * 0.25;
  /* 世界の m のずれを株の局所（回転・拡縮した前）へ戻して足す */
  transformed += inverse(mat3(instanceMatrix)) * vec3(ofs.x + fl, fl, ofs.y - fl);
  vShInfo = vec4(ngShrub.x, ngShrub.y, hh, ngW.w);
}
`;

export const SHRUB_FS_PARS = NG_SURFACE_GLSL + /* glsl */ `
in vec4 vShInfo;
`;
export const SHRUB_FS_SURFACE = /* glsl */ `
{
  /* 株ごとの色むら（同じ緑の塊が並ばない）。下の葉は暗く、上は明るい若葉 */
  float hh = vShInfo.z;
  vec3 tint = mix(vec3(0.92, 1.0, 0.86), vec3(1.12, 1.05, 0.9), hh);
  if (vShInfo.y > 0.5) diffuseColor.rgb *= tint * mix(0.8, 1.1, smoothstep(0.2, 1.0, vShInfo.x));
}
`;
export const SHRUB_FS_ROUGH = /* glsl */ `
roughnessFactor = vShInfo.y > 0.5 ? 0.55 : 0.85;
ngWetSurface(diffuseColor.rgb, roughnessFactor, 0.2, ngWet);
`;
export const SHRUB_FS_LIGHTS = /* glsl */ `
if (vShInfo.y > 0.5) {
  vec3 Lw = ngKeyDir;
  vec3 Vw = normalize(cameraPosition - vNgWorld);
  vec3 Nw = inverseTransformDirection(normal, viewMatrix);
  vec3 E = ngKeyPreShadow * ngNearVis;
  float ndl = dot(Nw, Lw);
  float wrap = max((ndl + 0.5) / 1.5, 0.0) - max(ndl, 0.0);
  reflectedLight.directDiffuse += E * diffuseColor.rgb * (wrap * 0.5 / 3.14159265);
  float mu = dot(-Vw, Lw), g = 0.5;
  float hg = (1.0 - g * g) / (4.0 * 3.14159265 * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
  reflectedLight.directDiffuse += E * (diffuseColor.rgb * vec3(1.2, 1.5, 0.7)) * hg * 1.4 * max(Lw.y + 0.1, 0.0);
}
`;
export const SHRUB_FS_AO = /* glsl */ `
{
  float ao = mix(0.35, 1.0, smoothstep(0.0, 0.85, vShInfo.x));
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.indirectSpecular *= ao;
  reflectedLight.directDiffuse *= mix(1.0, ao, 0.3);
}
`;
