/* ===========================================================
   caustics の受け口（ARCHITECTURE §5.3、CONTRACT §4.5）
   -----------------------------------------------------------
   魚（fish.js）・湖底・水中の小物が同じ網目を見る。本体の GLSL は underwater
   モジュール（src/gfx/underwater/caustics.glsl.js）が持ち、ここは契約の形だけを保つ：
   - CAUSTICS_GLSL：vec3 causticLight(vec3 worldPos, vec3 viewNormal)、16 個の uCaust*
   - createCausticsUniforms()：FishSchool より前に 1 回作り、以後は同じ参照の .value だけ書く。
     uCaustTex は最初から最後まで同じ DataArrayTexture（焼くまでは 1×1×1 の白）
   - updateCausticsTexture()：焼き込みの結果を «同じテクスチャオブジェクト» に差し込む
   =========================================================== */
import * as THREE from 'three';
import { CAUSTICS_GLSL, CAUSTICS_PLACEHOLDER_LAYERS } from './gfx/underwater/caustics.glsl.js';

/** caustics の GLSL（underwater モジュールの本体を再 export。魚の onBeforeCompile が #include <common> の後へ入れる） */
export { CAUSTICS_GLSL };

/** 契約で固定された 16 個の uniform 名（名前も数も変えない） */
export const CAUSTICS_UNIFORM_NAMES = Object.freeze([
  'uCaustTime', 'uCaustSunDir', 'uCaustNight', 'uCaustRain', 'uCaustCloud', 'uCaustStrength', 'uCaustTex',
  'uCaustScale', 'uCaustShape', 'uCaustRange', 'uCaustDepth', 'uCaustDist', 'uCaustFar', 'uCaustWarp',
  'uCaustMag', 'uCaustMixW',
]);

/**
 * caustics の uniforms を作る。既定値は旧版の実機調整値（uCaustWarp / uCaustFar はテストが固定）
 * @returns {Record<string, {value:any}>}
 */
export function createCausticsUniforms() {
  const tex = new THREE.DataArrayTexture(new Uint8Array(4 * CAUSTICS_PLACEHOLDER_LAYERS).fill(255), 1, 1, CAUSTICS_PLACEHOLDER_LAYERS);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.name = 'ng-caustics';
  tex.needsUpdate = true;
  return {
    uCaustTex: { value: tex },
    uCaustScale: { value: new THREE.Vector2(0.105, 0.166) },
    uCaustShape: { value: new THREE.Vector2(1.0, 1.4) },
    uCaustRange: { value: new THREE.Vector2(1.3, 0.22) },
    uCaustDepth: { value: new THREE.Vector2(0.07, 0.60) },
    uCaustDist: { value: new THREE.Vector2(28.0, 60.0) },
    uCaustFar: { value: new THREE.Vector2(6.0, 20.0) },
    uCaustWarp: { value: new THREE.Vector2(1.15, 2.5) },
    uCaustMag: { value: 0.18 },
    uCaustMixW: { value: new THREE.Vector3(1.0, 0.5, 0.0) },
    uCaustTime: { value: 0 },
    uCaustSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uCaustNight: { value: 0 },
    uCaustRain: { value: 0 },
    uCaustCloud: { value: 0 },
    uCaustStrength: { value: 0 },
  };
}

/**
 * 焼いた網目を uCaustTex に差し込む（テクスチャオブジェクトは差し替えない）
 * @param {Record<string, {value:any}>} u createCausticsUniforms() の戻り値
 * @param {{data:Uint8Array|Uint16Array|Float32Array, width:number, height:number, depth:number,
 *          format?:number, type?:number}} img 層 = 時刻のフレーム
 */
export function updateCausticsTexture(u, img) {
  const tex = u.uCaustTex.value;
  /* texStorage の不変な確保は大きさを変えられないので、GL 側だけ捨てて作り直させる
     （Texture オブジェクトは同じまま＝魚のマテリアルの参照は切れない） */
  tex.dispose();
  tex.image = { data: img.data, width: img.width, height: img.height, depth: img.depth };
  if (img.format !== undefined) tex.format = img.format;
  if (img.type !== undefined) tex.type = img.type;
  tex.needsUpdate = true;
}
