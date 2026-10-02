/* ===========================================================
   地形の制御の配列（ngTerrCtl）：素材の断片が毎画素で計算していた «位置だけで決まる値» を起動時に焼く
   -----------------------------------------------------------
   層 0 = 重み wA（林床・苔・草地・玉石）、層 1 = 重み wB（砂・泥・岩・踏み跡）：±256m を 0.5m（high）/ 1m（mid・low）
   層 2 = マクロの色むら（タイル、2D のマクロを写す）
   - 重みは ngTerrWeights（coverRules・farAlbedo と同じ関数）をテクセルの中心で。高さ・法線・汀線距離・底質・樹冠・踏み跡は
     heightfield から。断片はこれを 2 回読むだけになる（値ノイズ 3 + 踏み跡 + 底質の読みが消える。1440p で約 2ms）
   - 範囲の外（±256m より先で 180m 以内に見える所）は断片が同じ関数で計算する（境は値が一致するので見えない）
   - RGBA8、mip あり（遠目の重みは平均）。配列はリピート（マクロのため）なので、重みの uv は断片が内側に限る
   =========================================================== */
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { terrainWeightsGLSL } from './terrain.glsl.js';
import { CTL_ORIGIN, CTL_SIZE } from './quality.js';

export const CTL_BAKE = NG_HEIGHTFIELD_GLSL + terrainWeightsGLSL() + /* glsl */ `
uniform sampler2D ngTerrMacro;
uniform vec4 ngTerrDock;
void main() {
  int L = int(ngLayer + 0.5);
  if (L == 2) { gl_FragColor = texture(ngTerrMacro, vUv); return; }
  vec2 xz = ${CTL_ORIGIN.toFixed(1)} + vUv * ${CTL_SIZE.toFixed(1)};
  vec4 wA, wB;
  ngTerrWeights(vec3(xz.x, ngTerrainH(xz), xz.y), ngTerrainN(xz), ngTerrShoreD(xz), ngTerrBed(xz), ngCanopyAt(xz),
    ngTerrTrailAt(xz, ngTerrDock), wA, wB);
  gl_FragColor = L == 0 ? wA : wB;
}
`;
