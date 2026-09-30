/* ===========================================================
   高さ場のサンプリング（ARCHITECTURE §4.7）
   -----------------------------------------------------------
   - ngHeightNear（±260m @0.5m）/ ngHeightFar（±512m @1m）は R32F・Nearest。
     補間は texelFetch の手動バイリニア（OES_texture_float_linear に依存しない）。
     JS の sampleGrid（src/world/heightgrid.js）が同じ補間を持つ
   - 格子点 k は x = origin + k·step。テクスチャの行は z（data[iz·n + ix]）
   - near と far は near の縁 4m でブレンドする
   - 派生マップ（法線・汀線距離・底質・被覆）は near の範囲 ±260m、樹冠は far の範囲
   - サンプラーは 6 枚（高さ ×2・法線 ×2・底質・被覆）。汀線距離は ngNormalNear の z、樹冠は ngNormalFar の zw に
     同居させてある（地形のモジュールが素材の配列 2 枚を足しても断片 12 枚に収まるように。core-requests A-6）。
     モジュールは関数（ngShoreD / ngCanopyAt …）だけを使い、サンプラーの名前に頼らないこと
   uniforms は heightfield.js の HeightField.uniforms（共有の {value}）
   =========================================================== */
import { NG_OCT_GLSL } from './oct.glsl.js';

/** ngTerrainH / ngDepth / ngTerrainN / ngShoreD / ngBed / ngCanopyAt / ngCover */
export const NG_HEIGHTFIELD_GLSL = NG_OCT_GLSL + /* glsl */ `
#ifndef NG_LIB_HEIGHTFIELD
#define NG_LIB_HEIGHTFIELD
uniform highp sampler2D ngHeightNear;
uniform highp sampler2D ngHeightFar;
uniform sampler2D ngNormalNear;   // RGBA16F（格子と同じ解像度、線形補間）：xy = oct 法線、z = 汀線までの符号付き距離 m（陸 +、水 −）
uniform sampler2D ngNormalFar;    // RGBA8：xy = oct 法線、z = 樹冠の密度、w = 樹冠の高さ / 40m
uniform sampler2D ngBedMap;       // RGBA8：mud, sand, rock の重み, lake.bedAt の v
uniform sampler2D ngCoverMap;     // RGBA8：草, 笹, シダ, 花の密度
uniform vec4 ngHfNear;            // origin.x, origin.z, 1/step, n
uniform vec4 ngHfFar;
uniform vec4 ngHfMapXf;           // near の原点, 1/near の幅, far の原点, 1/far の幅（正方形）

float ngGridH(highp sampler2D t, vec4 g, vec2 xz) {
  vec2 f = (xz - g.xy) * g.z;
  vec2 i = floor(f), w = f - i;
  int n = int(g.w) - 1;
  ivec2 a = clamp(ivec2(i), ivec2(0), ivec2(n)), b = clamp(ivec2(i) + 1, ivec2(0), ivec2(n));
  float h00 = texelFetch(t, a, 0).r, h10 = texelFetch(t, ivec2(b.x, a.y), 0).r;
  float h01 = texelFetch(t, ivec2(a.x, b.y), 0).r, h11 = texelFetch(t, b, 0).r;
  return mix(mix(h00, h10, w.x), mix(h01, h11, w.x), w.y);
}
/* near の縁までの距離（m）。負なら near の外 */
float ngNearInset(vec2 xz) {
  vec2 lo = ngHfNear.xy, hi = ngHfNear.xy + (ngHfNear.w - 1.0) / ngHfNear.z;
  vec2 d = min(xz - lo, hi - xz);
  return min(d.x, d.y);
}
float ngTerrainH(vec2 xz) {
  float k = smoothstep(0.0, 4.0, ngNearInset(xz));
  float hf = ngGridH(ngHeightFar, ngHfFar, xz);
  return k > 0.0 ? mix(hf, ngGridH(ngHeightNear, ngHfNear, xz), k) : hf;
}
float ngDepth(vec2 xz) { return max(-ngTerrainH(xz), 0.0); }
vec2 ngGridUV(vec4 g, vec2 xz) { return ((xz - g.xy) * g.z + 0.5) / g.w; }
vec3 ngTerrainN(vec2 xz) {
  float k = smoothstep(0.0, 4.0, ngNearInset(xz));
  vec3 nf = ngOctDecode(texture(ngNormalFar, ngGridUV(ngHfFar, xz)).xy);
  if (k <= 0.0) return nf;
  vec3 nn = ngOctDecode(texture(ngNormalNear, ngGridUV(ngHfNear, xz)).xy);
  return normalize(mix(nf, nn, k));
}
vec2 ngNearMapUV(vec2 xz) { return (xz - ngHfMapXf.x) * ngHfMapXf.y; }
vec2 ngFarMapUV(vec2 xz) { return (xz - ngHfMapXf.z) * ngHfMapXf.w; }
float ngShoreD(vec2 xz) { return texture(ngNormalNear, ngGridUV(ngHfNear, xz)).z; }
vec4 ngBed(vec2 xz) { return texture(ngBedMap, ngNearMapUV(xz)); }
vec2 ngCanopyAt(vec2 xz) { return texture(ngNormalFar, ngGridUV(ngHfFar, xz)).zw; }
vec4 ngCover(vec2 xz) { return texture(ngCoverMap, ngNearMapUV(xz)); }
#endif
`;
