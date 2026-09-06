/* ===========================================================
   地形・湖底・岸辺の装飾・桟橋
   =========================================================== */
import * as THREE from 'three';
import { CAUSTICS_GLSL } from './shaders.js?v=20260830-zone5';
import { waveGLSL } from './waveField.js?v=20260828-lakescale1';
import { UnderwaterPropScatter, addUnderwaterCaustics, patchUwMaterial } from './underwaterProps.js?v=20260830-zone5';
import { WaterPlants, buildSubmergedTuft } from './waterPlants.js?v=20260830-zone5';
import { Undergrowth, UNDER_KINDS } from './undergrowth.js?v=20260830-zone5';
import { RockSet, makeSingleRock } from './rocks.js?v=20260906-rocktex1';
import { applyPatches, dockWaterline } from './materialPatch.js?v=20260906-algae1';
import { makeRng, clamp, clamp01, lerp, smoothstep, TAU, lineSagProfile } from './util.js?v=20260830-zone5';
import { buildRadialGrid, DETAIL_BY_QUALITY } from './terrainMesh.js?v=20260830-zone5';
import { makeTileableHeightField, makeTileablePebbleField, bakeLandDetailMaps }
  from './tileableNoise.js?v=20260830-zone5';
import { TreeSet, VARIANTS as TREE_VARIANTS, LOD_DIST as TREE_LOD_DIST, LOD_FADE_BAND as TREE_FADE_BAND }
  from './trees.js?v=20260906-leaftex1';
import { SPECIES_IDS } from './treeSkeleton.js?v=20260830-zone5';
import { WORLD_SIZE, WATER_REGION, MAX_DEPTH, resolveLake } from './lakefield.js';

export { WORLD_SIZE, WATER_REGION, MAX_DEPTH };

/**
 * 歩ける範囲（汀線から内陸へ何 m まで）。
 *
 * もとは「原点から 460m」で、汀線から 343m・61.3ha を歩けた。ところが
 * 飾ってあるのは下草が +110m、岩が +12m までで、それより内陸は木が
 * 立っているだけの裸の地面だった。61.3ha を全部飾るより、歩ける範囲を
 * «湖のまわり» に絞って、そこを完成させるほうが釣りゲームとして正しい。
 *
 * 絞ると副産物として «絶対に近づけない木» が確定するので、それを静的な
 * バケットへ回して遠景の本数を増やせる（TreeSet.addFar）。
 */
export const WALK_INLAND = 72;

const DOCK_HALF_W = 1.62;   // 床の半幅（見た目 3.4m のうち内側）
const OBS_CELL = 8;         // 障害物グリッドのセルサイズ(m)
const DOCK_WOOD_TILE = 0.62; // 桟橋テクスチャ 1 枚ぶんの実寸 (m)

/** BoxGeometry（1 セグメント）の各面 UV を実寸 / tile でスケールする */
function scaleBoxUVs(geo, width, height, depth, tile = DOCK_WOOD_TILE) {
  const uv = geo.attributes.uv;
  const faceWH = [
    [depth, height], [depth, height],
    [width, depth], [width, depth],
    [width, height], [width, height],
  ];
  for (let f = 0; f < 6; f++) {
    const uScale = faceWH[f][0] / tile;
    const vScale = faceWH[f][1] / tile;
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * uScale, uv.getY(idx) * vScale);
    }
  }
  uv.needsUpdate = true;
}

/** 杭テクスチャの縦木目を、箱の長辺へ回す */
function swapBoxUVs(geo) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
  uv.needsUpdate = true;
}

function scaleCylinderUVs(geo, radius, height, tile = DOCK_WOOD_TILE) {
  const uv = geo.attributes.uv;
  const uScale = (Math.PI * 2 * radius) / tile;
  const vScale = height / tile;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * uScale, uv.getY(i) * vScale);
  }
  uv.needsUpdate = true;
}

function makeDockWoodMat(
  map, fallbackColor, roughness, causticsUniforms, cacheKey, mapTint = 0xffffff,
  algaeTex = null, woodMaps = null
) {
  return applyPatches(
    new THREE.MeshStandardMaterial({
      map: map || null,
      color: map ? mapTint : fallbackColor,
      roughness,
      normalMap: woodMaps?.normalMap || null,
      /* 木目の起伏は 1mm 級。1.0 だと «彫った板» になる */
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughnessMap: woodMaps?.roughAoMap || null,
      aoMap: woodMaps?.roughAoMap || null,
      aoMapIntensity: 0.55,
    }),
    [
      (m) => addUnderwaterCaustics(m, causticsUniforms, cacheKey),
      (m) => dockWaterline(m, algaeTex),
    ]
  );
}

/** InstancedMesh の Y スケールを UV.y に乗せる（杭の高さごとに木目が伸びないように） */
function withInstanceUvY(mat, cacheKey) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (typeof prev === 'function') prev(shader);
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
#ifdef USE_MAP
#ifdef USE_INSTANCING
        vMapUv.y *= length(instanceMatrix[1].xyz);
#endif
#endif`
    );
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () =>
    `${typeof prevKey === 'function' ? prevKey() : cacheKey}-inst-uvy`;
  return mat;
}

const tmpColor = new THREE.Color();
const tmpSand = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const _dl = { al: 0, si: 0 };
const _dl2 = { al: 0, si: 0 };

/* ===========================================================
   渚の濡れ砂

   乾いた砂と水中の砂が同じアルベドで直結していると、水際が
   「紙を切って貼った」ように見える。ここでは
     ・いま水を被っている帯（遡上に追従して前後する）
     ・引き波が置いていった泡の名残
     ・毛管上昇でいつも湿っている帯
   の 3 段を作る。判定は水面シェーダと同じ高さテクスチャ基準なので、
   汀線の位置が水と地形でずれない。
   =========================================================== */
const SHORE_WET_GLSL = /* glsl */ `
uniform sampler2D uShoreHeightTex;
uniform float uShoreRegion;
uniform float uShoreTime;
uniform float uShoreWind;
uniform float uShoreTop;

${waveGLSL({ prefix: 'sw' })}

float shoreHash(vec2 p) {
  p = fract(p * vec2(127.31, 311.71));
  p += dot(p, p + 41.23);
  return fract(p.x * p.y);
}

float shoreNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = shoreHash(i);
  float b = shoreHash(i + vec2(1.0, 0.0));
  float c = shoreHash(i + vec2(0.0, 1.0));
  float d = shoreHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/* color / roughness / normal の 3 か所で使い回すので 1 回だけ評価する */
vec3 gShoreWet = vec3(0.0);

/** x = 濡れ具合 0..1、y = 泡の名残 0..1、z = 渚バンド（砂の作り込み用） */
vec3 shoreWetness(vec3 wp) {
  vec2 uv = clamp(wp.xz / uShoreRegion + 0.5, vec2(0.0005), vec2(0.9995));
  float ground = texture2D(uShoreHeightTex, uv).r;
  // 渚バンドの外（山側・深場）は何もしない
  float band = smoothstep(-0.60, -0.12, ground)
             * (1.0 - smoothstep(uShoreTop * 2.2, uShoreTop * 4.5, ground));
  if (band < 0.002) return vec3(0.0);
  // 陸側だけを濡らす（水中側は水シェーダの減衰が担当する）
  float onLand = smoothstep(-0.14, 0.02, ground);
  float now = swShoreRunUp(wp.xz, uShoreTime) * uShoreWind;
  float past = max(now, swShoreRunUp(wp.xz, uShoreTime - 2.1) * uShoreWind);
  float wetNow = smoothstep(0.035, -0.035, ground - now);
  float wetPast = smoothstep(0.09, -0.09, ground - past);
  // 毛管上昇の上端はノイズで崩す（真横一直線の境目にしない）
  float top = uShoreTop * (0.62 + 0.76 * shoreNoise(wp.xz * 0.42));
  float capillary = 1.0 - smoothstep(0.0, top, max(ground, 0.0));
  float wet = clamp(max(wetNow, wetPast * 0.82) + capillary * 0.34, 0.0, 1.0) * onLand;
  /* 引き波が残した泡：いま水が無いところにだけ、まばらなレースで乗る。
     ここを広く強く塗ると砂浜が白い斑（牛柄）になるので、面積も濃さも絞る。
     遡上が届いた上端ほど泡が残るので、そこへ寄せる */
  float laceLod = 1.0 - smoothstep(6.0, 24.0, length(wp - cameraPosition));
  float lace = smoothstep(0.60, 0.88, shoreNoise(wp.xz * 5.5))
             * mix(0.20, 1.0, smoothstep(0.42, 0.82, shoreNoise(wp.xz * 13.0)))
             * mix(0.55, 1.0, laceLod);
  float atReach = mix(0.30, 1.0, smoothstep(0.12, 0.0, abs(ground - past)));
  float residue = clamp(wetPast - wetNow, 0.0, 1.0) * lace * onLand * atReach;
  return vec3(wet, residue, band);
}

/**
 * 渚の砂を「無地」から救う。粒のムラ、満潮線の漂着物、濡れによる暗色化、
 * 引き波が残した泡の 4 段を、乾いた砂側だけに乗せる。
 */
vec3 shoreDress(vec3 base, vec3 wp, float under) {
  vec3 sw = gShoreWet;
  if (sw.z < 0.002) return base;
  float dry = sw.z * (1.0 - under);
  /* 手続きノイズには mipmap が無いので、遠景では 1 px より細かい模様が
     エイリアスして大きな斑（牛柄）になる。距離で帯域を落とす */
  float lod = 1.0 - smoothstep(5.0, 20.0, length(wp - cameraPosition));
  float fine = dry * lod;
  // 砂の粒ムラ
  float grain = shoreNoise(wp.xz * 6.0) * 0.6 + shoreNoise(wp.xz * 1.8) * 0.4;
  base *= mix(1.0, mix(0.965, 1.035, grain), fine);
  // 小石：まばらな明暗の点（強くすると牛柄になるので控えめに）
  float peb = smoothstep(0.90, 0.99, shoreNoise(wp.xz * 3.2 + 13.7));
  base = mix(base, base * mix(0.88, 1.10, shoreNoise(wp.xz * 9.0)), peb * fine * 0.30);
  // 満潮線に残る漂着物のすじ
  float wrack = smoothstep(0.60, 0.86, shoreNoise(wp.xz * 2.7))
              * smoothstep(0.26, 0.04, abs(wp.y - uShoreTop * 1.2)) * dry;
  base = mix(base, vec3(0.30, 0.26, 0.19), wrack * 0.45);
  // 濡れた砂は暗く濃くなる（これが無いと水際が紙を貼ったように見える）
  base *= mix(1.0, 0.66, sw.x);
  // 引き波が置いていった泡
  base = mix(base, vec3(0.88, 0.91, 0.92), sw.y * 0.32);
  return base;
}
`;

/** 湖底のmicro normal・roughness・色ムラを1枚にまとめたタイルテクスチャ。 */
/**
 * 地面の «粒» テクスチャ。RG = 傾き, B = 遮蔽, A = 粗さ。
 *
 * 砂利は «丸い石が敷き詰まったもの» なので fbm では出ない。
 * 石を 1 つずつドームとして置いた高さ場から法線・遮蔽・粗さを焼く
 * （makeTileablePebbleField）。
 * 石を 1000 個ぶんの «情報» を地面に持たせておいて、その上に本物の 3D 石を
 * 数十個だけ生やすほうが、全部を 3D にするより軽くて密度が出る。
 *
 * @param {'gravel'|'sand'} kind
 */
function createGroundDetailTexture(kind, size = 384) {
  const cfg = kind === 'gravel'
    // タイル 1.1m。石の半径 3〜11cm
    ? { seed: 0x9a31c4, count: 300, rMin: 0.018, rMax: 0.11, flat: 0.74, grain: 0.16, grainFreq: 30, aoRadius: 0.055 }
    // タイル 0.30m。粒 2〜5mm
    : { seed: 0x4c7215, count: 900, rMin: 0.006, rMax: 0.017, flat: 0.50, grain: 0.55, grainFreq: 44, aoRadius: 0.020 };
  const f = makeTileablePebbleField(size, cfg.seed, cfg);
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => f.h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 中央差分で傾きを取る。テクセル 1 つぶんの差なので係数で持ち上げる
      const sx = (at(x + 1, y) - at(x - 1, y)) * 3.4;
      const sz = (at(x, y + 1) - at(x, y - 1)) * 3.4;
      const j = y * size + x;
      data[i] = Math.round(clamp01(sx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(clamp01(sz * 0.5 + 0.5) * 255);
      /* B は «高さ»。視差（POM）はこれを辿る。
         遮蔽はもともとここに入れていたが、視差が «どれだけ沈んだか» を
         返すので、そちらから取ったほうが実際の凹凸と合う */
      data[i + 2] = Math.round(f.h[j] * 255);
      /* 砂利は A に «石ごとの色味»（砂は 0）を入れて、粗さはそこから
         シェーダ側で引く。砂には石がないので粗さをそのまま入れる */
      data[i + 3] = Math.round((kind === 'gravel' ? f.tint[j] : f.rough[j]) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function createBedDetailTexture() {
  const size = 128;
  const height = makeTileableHeightField(size, 0xbed0421, {
    octaves: 4,
    baseFrequency: 9,
    secondaryFrequency: 15,
    secondaryMix: 0.4,
    gain: 0.48,
    amplitude: 3.6,
  });
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = height(x, y);
      const sx = (height(x + 1, y) - height(x - 1, y)) * 0.72;
      const sz = (height(x, y + 1) - height(x, y - 1)) * 0.72;
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp01(sx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(clamp01(sz * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(clamp01(h * 0.42 + 0.5) * 255);
      data[i + 3] = Math.round(clamp01(0.5 + h * 0.34) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const LAND_DETAIL_OPTS = {
  beach: { aoRadius: 0.02, nScale: 1.1, roughLo: 0.88, roughHi: 0.97 },
  grass: { aoRadius: 0.04, nScale: 2.2, roughLo: 0.80, roughHi: 0.94 },
  forest: { aoRadius: 0.05, nScale: 2.6, roughLo: 0.58, roughHi: 0.90 },
  rock: { aoRadius: 0.055, nScale: 3.2, roughLo: 0.68, roughHi: 0.88 },
};

/** 陸タイルの並び。シェーダ側の層番号（LAND_LAYER）と一致させる */
export const LAND_KINDS = ['beach', 'grass', 'forest', 'rock'];
const LAND_ALBEDO_SIZE = 1024;
const LAND_DETAIL_SIZE = 512;
/** 湖底アルベドの 1 層あたりの辺。元の webp が 512 なので合わせる */
const BED_ALBEDO_SIZE = 512;
/** 木材の派生マップの辺。板 1 枚が UV 1m ぶんなので 512 で 2mm/px */
const WOOD_DETAIL_SIZE = 512;
/* 木目の起伏は浅い。法線を強くすると «彫刻した板» になる。
   粗さは «明るいほど荒い»（風化して毛羽立った面が明るく、
   詰まった晩材の筋が暗く滑らか） */
const WOOD_DETAIL_OPTS = { aoRadius: 0.022, nScale: 1.9, roughLo: 0.70, roughHi: 0.96 };

/** 画像を canvas 経由で RGBA バイト列にする */
function imageToRgba(img, size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

/**
 * 4 枚を 1 本のサンプラにまとめる。
 *
 * 別々の sampler2D で持つと、湖底 3 枚 + 粒 2 枚 + コースティクス + 汀線 +
 * 陸 8 枚 で MAX_TEXTURE_IMAGE_UNITS(16) を超えてリンクに失敗する。
 * 超えると地形マテリアルが «program not valid» になって地面が丸ごと消える。
 * 2D 配列テクスチャなら 4 層で 1 本しか食わない。
 */
function makeLandArrayTexture(layers, size, colorSpace) {
  const stride = size * size * 4;
  const data = new Uint8Array(stride * layers.length);
  layers.forEach((src, i) => data.set(src, stride * i));
  const tex = new THREE.DataArrayTexture(data, size, size, layers.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 陸アルベドの輝度から Height→Normal/AO/Roughness を焼く。
 * 砂浜は粒を pebble field が持つので、ここの法線は弱め（nScale 1.1）。
 */
function bakeLandDetailLayer(img, opts = {}) {
  const size = LAND_DETAIL_SIZE;
  const luma = new Float32Array(size * size);
  if (typeof document !== 'undefined' && img) {
    const pix = imageToRgba(img, size);
    for (let i = 0; i < size * size; i++) {
      const o = i * 4;
      luma[i] = (0.2126 * pix[o] + 0.7152 * pix[o + 1] + 0.0722 * pix[o + 2]) / 255;
    }
  } else {
    luma.fill(0.5);
  }
  return bakeLandDetailMaps(luma, size, opts).data;
}

/** 湖底アルベドが読めなかったときの 1x1x3。層番号だけ合っていればいい */
/** 木材の派生マップ用の DataTexture。色ではなくデータなので NoColorSpace */
function makeWoodDataTex(data, size) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * 木材アルベドの輝度から、法線・粗さ・遮蔽を焼く。
 *
 * 桟橋の板と杭は 1024² のアルベドを持っているのに roughness が定数で、
 * «印刷された紙» に見えていた。プレイヤーが立っている板で、ほぼ全画面に
 * 入る最近接オブジェクトなのに、そこだけ凹凸がなかった。
 * 陸タイルと同じ焼き方（bakeLandDetailMaps）がそのまま使えるので、
 * 画像を作り直さずに済む。
 * @param {HTMLImageElement} img
 */
function bakeWoodMaps(img) {
  const size = WOOD_DETAIL_SIZE;
  if (typeof document === 'undefined' || !img) return null;
  const pix = imageToRgba(img, size);
  const luma = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    luma[i] = (0.2126 * pix[o] + 0.7152 * pix[o + 1] + 0.0722 * pix[o + 2]) / 255;
  }
  const { data } = bakeLandDetailMaps(luma, size, WOOD_DETAIL_OPTS);
  const nrm = new Uint8Array(size * size * 4);
  const rgh = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    // 法線は RG に入っている。Z は面から立てたままでよい
    nrm[o] = data[o]; nrm[o + 1] = data[o + 1]; nrm[o + 2] = 255; nrm[o + 3] = 255;
    /* three は aoMap を R、roughnessMap を G から読む。
       1 枚に詰めればサンプラも 1 本で済む */
    rgh[o] = data[o + 2];
    rgh[o + 1] = data[o + 3];
    rgh[o + 2] = 0; rgh[o + 3] = 255;
  }
  return { normalMap: makeWoodDataTex(nrm, size), roughAoMap: makeWoodDataTex(rgh, size) };
}

function dummyBedArray() {
  const t = new THREE.DataArrayTexture(
    new Uint8Array([160, 150, 130, 255, 150, 148, 142, 255, 96, 92, 74, 255]), 1, 1, 3
  );
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** 陸テクスチャが読めなかったときの 1x1x4。層番号だけ合っていればいい */
function dummyLandArray(fill, colorSpace) {
  return makeLandArrayTexture(
    LAND_KINDS.map(() => Uint8Array.from(fill)), 1, colorSpace,
  );
}

/**
 * 植生マテリアルに風揺れを注入する。
 *
 * 揺れは 2 帯域に分ける。
 *   bend    株ごとに位相が決まる大きなしなり。根元は動かず先端ほど曲がる。
 *           幹・枝と葉に「同じ式」を掛けるのが肝で、葉だけ動かすと
 *           近くで見たとき葉が枝から剥がれて浮いているように見える。
 *   flutter 葉カードごとに位相が違う細かい震え（aFlutter 属性が要る）。
 *           こちらは葉だけに掛ける。
 *
 * インスタンス座標を bend の位相源にするので、追加ジオメトリも CPU 更新も要らない。
 *
 * @param {THREE.Material} mat
 * @param {{strength?: number, freq?: number, gustiness?: number,
 *          bendPow?: number, flutter?: number, flutterFreq?: number}} opts
 *   bendPow  1 で高さに比例（草・葦）。木の幹は根元が硬いので 1.6 前後にすると
 *            «下は動かず梢だけ大きく揺れる» 曲がり方になる
 *   flutter  0 で無効。>0 なら aFlutter 属性を位相にした細かい震えを足す
 */
function addWindSway(mat, {
  strength = 0.06,     // 先端の最大振れ幅（ローカル単位）
  freq = 1.6,          // 基本の揺れ速さ
  gustiness = 0.5,     // 突風の強さ（0 で一定風）
  bendPow = 1,         // 高さ方向の効き。>1 で根元が硬くなる
  flutter = 0,         // 葉のこまかい震え
  flutterFreq = 3.1,
} = {}) {
  const useFlutter = flutter > 0;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = { value: 0 };
    shader.uniforms.uWindStrength = { value: strength };
    shader.uniforms.uWindGust = { value: gustiness };
    shader.uniforms.uWindFlutter = { value: flutter };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uWindTime;
        uniform float uWindStrength;
        uniform float uWindGust;
        uniform float uWindFlutter;
        ${useFlutter ? 'attribute float aFlutter;' : ''}`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          // ローカルの高さ（幹・葉とも原点が根元なので y のみで良い）
          float swayH = clamp(transformed.y, 0.0, 8.0);
          float swayW = ${bendPow === 1 ? 'swayH' : `pow(swayH, ${bendPow.toFixed(2)})`};
          // インスタンス位置で位相をずらす（隣の木が同じタイミングで揺れない）
          vec3 ipos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float phase = dot(ipos.xz, vec2(0.71, 0.53));
          // 全体をなびかせる風 + 局所的なそよぎ
          float g = 1.0 + uWindGust * sin(uWindTime * 0.9 + phase * 0.35) * sin(uWindTime * 2.13 + phase);
          float w1 = sin(uWindTime * ${freq.toFixed(2)} + phase);
          float w2 = sin(uWindTime * ${(freq * 2.37).toFixed(2)} + phase * 1.7 + 1.3);
          transformed.x += (w1 * 0.7 + w2 * 0.3) * g * uWindStrength * swayW;
          transformed.z += (w2 * 0.7 - w1 * 0.3) * g * uWindStrength * swayW * 0.62;
${useFlutter ? `          /* 葉カードごとの震え。位相は房ごとに固定なので、
             1 枚のカードが引き延ばされずに丸ごと動く */
          float fa = aFlutter;
          float f1 = sin(uWindTime * ${flutterFreq.toFixed(2)} + fa);
          float f2 = sin(uWindTime * ${(flutterFreq * 1.73).toFixed(2)} + fa * 2.3);
          float fw = uWindFlutter * g * mix(0.35, 1.0, swayH);
          transformed.x += (f1 * 0.7 + f2 * 0.3) * fw;
          transformed.y += sin(uWindTime * ${(flutterFreq * 0.81).toFixed(2)} + fa * 1.9) * fw * 0.55;
          transformed.z += (f2 * 0.7 - f1 * 0.3) * fw;` : ''}
        }`
      );
    mat.userData.windUniforms = shader.uniforms;
  };
  mat.customProgramCacheKey = () =>
    `wind-sway-${strength}-${freq}-${gustiness}-${bendPow}-${flutter}-${flutterFreq}`;
  mat.userData._windBase = strength;
  mat.userData._flutterBase = flutter;
  return mat;
}

/** 風の時刻を進める（terrain.updateLamp などから毎フレーム呼ぶ） */
export function tickVegetationWind(list, t, windPow = 1) {
  for (const m of list) {
    const u = m.userData?.windUniforms;
    if (!u || !u.uWindTime) continue;   // 初回コンパイル前
    u.uWindTime.value = t;
    if (u.uWindStrength) u.uWindStrength.value = m.userData._windBase * windPow;
    if (u.uWindFlutter) u.uWindFlutter.value = m.userData._flutterBase * windPow;
  }
}

/** 線分 vs AABB（スラブ法） */
function segBoxHit(p0, p1, min, max) {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = p1[i] - p0[i];
    if (Math.abs(d) < 1e-9) {
      if (p0[i] < min[i] || p0[i] > max[i]) return false;
      continue;
    }
    let ta = (min[i] - p0[i]) / d, tb = (max[i] - p0[i]) / d;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * 水中の立ち枯れ（ローポリ）。
 * 歪んだ幹・折れた梢・枝・根張りで「沈んだ枯れ木」に見せる。
 */
function makeSnagGroup(t, bedY, woodMat, tipMat) {
  const g = new THREE.Group();
  const h = t.h;
  const r0 = t.r * 0.52;
  const v = t.v;

  // 幹：下太・上細、途中でいびつ、梢は折れて尖る
  const trunkPts = [];
  for (let i = 0; i <= 11; i++) {
    const u = i / 11;
    let rad = r0 * lerp(1.25, 0.38, Math.pow(u, 0.85));
    rad *= 1 + Math.sin(u * 17 + v * 9) * 0.1 + Math.sin(u * 5 + 2) * 0.05;
    if (u > 0.82) rad *= lerp(1, 0.12 + v * 0.18, (u - 0.82) / 0.18);
    trunkPts.push(new THREE.Vector2(Math.max(0.025, rad), u * h));
  }
  const trunk = new THREE.Mesh(new THREE.LatheGeometry(trunkPts, 7), woodMat);
  g.add(trunk);

  // 折れた梢の破片（斜めに刺さった感じ）
  const tip = new THREE.Mesh(new THREE.ConeGeometry(r0 * 0.32, h * 0.14, 5), tipMat);
  tip.position.set(r0 * 0.08, h * 0.97, -r0 * 0.05);
  tip.rotation.set(0.35 + v * 0.4, v * 2.1, -0.25);
  g.add(tip);

  // 枝：幹の中腹〜上から外へ伸び、先は折れている
  const nBranch = 4 + (v > 0.55 ? 1 : 0);
  for (let k = 0; k < nBranch; k++) {
    const along = 0.32 + (k / Math.max(1, nBranch - 1)) * 0.52;
    const len = h * (0.28 + (1 - k / nBranch) * 0.32 + (v % 0.3) * 0.15);
    const br = r0 * (0.42 - k * 0.04);
    const ba = k * (TAU / nBranch) + v * 1.7;
    const pitch = 0.75 + (k % 3) * 0.22 + v * 0.15;

    const bPts = [];
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      let rad = br * (1 - u * 0.72);
      if (u > 0.78) rad *= 0.35; // 折れた先端
      bPts.push(new THREE.Vector2(Math.max(0.015, rad), u * len));
    }
    const branch = new THREE.Mesh(new THREE.LatheGeometry(bPts, 5), woodMat);
    const trunkR = r0 * lerp(1.1, 0.4, along);
    branch.position.set(Math.cos(ba) * trunkR * 0.65, along * h, Math.sin(ba) * trunkR * 0.65);
    branch.quaternion.setFromEuler(new THREE.Euler(
      pitch,
      ba,
      (k % 2 === 0 ? 1 : -1) * (0.25 + v * 0.35)
    ));
    g.add(branch);

    // 小枝（半分の枝にだけ）
    if (k % 2 === 0) {
      const twLen = len * (0.28 + v * 0.12);
      const twig = new THREE.Mesh(
        new THREE.CylinderGeometry(br * 0.18, br * 0.32, twLen, 4),
        woodMat
      );
      twig.geometry.translate(0, twLen * 0.5, 0);
      twig.position.set(0, len * (0.4 + (k % 3) * 0.08), 0);
      twig.rotation.set(0.2, ba * 0.3, 1.05 + v * 0.4);
      branch.add(twig);
    }
  }

  // 根張り：底に這う短い根
  const nRoot = 3 + (v > 0.45 ? 1 : 0);
  for (let k = 0; k < nRoot; k++) {
    const ra = k * (TAU / nRoot) + v * 0.8;
    const rl = r0 * (2.0 + (k % 2) * 0.6 + v * 0.5);
    const root = new THREE.Mesh(
      new THREE.CylinderGeometry(r0 * 0.12, r0 * 0.38, rl, 5),
      woodMat
    );
    root.geometry.translate(0, rl * 0.5, 0);
    root.position.set(Math.cos(ra) * r0 * 0.35, r0 * 0.05, Math.sin(ra) * r0 * 0.35);
    root.quaternion.setFromEuler(new THREE.Euler(1.05 + (k % 2) * 0.2, ra, 0.15));
    g.add(root);
  }

  // 幹の途中に短い折れ枝の切り株
  const stub = new THREE.Mesh(
    new THREE.CylinderGeometry(r0 * 0.22, r0 * 0.28, r0 * 0.9, 5),
    tipMat
  );
  stub.geometry.translate(0, r0 * 0.45, 0);
  stub.position.set(-r0 * 0.55, h * (0.4 + v * 0.15), r0 * 0.1);
  stub.quaternion.setFromEuler(new THREE.Euler(1.2, v * 3, 0.4));
  g.add(stub);

  // 全体を少し傾ける（沈んで傾いた枯れ木）
  const lean = 0.1 + v * 0.28;
  g.rotation.set(lean * 0.35, t.rot, lean);
  g.position.set(t.x, bedY - r0 * 0.15, t.z);
  return g;
}

export class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts  lake（lakefield.resolveLake の結果）または seed
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.quality = opts.quality || 'mid';

    // 地形の数学部分は lakefield.js（検証済みの湖）に委譲
    this.lake = opts.lake || resolveLake(opts.seed ?? 20240711).lake;
    this.seed = this.lake.seed;
    this.noise = this.lake.noise;
    this.hole = this.lake.hole;
    this.flat = this.lake.flat;
    this.dockAngle = this.lake.dock.angle;

    this.obstacles = [];        // [x, z, r, x, z, r, ...]
    this._obsGrid = new Map();

    this._buildHeightTexture();
    this.bedDetailTexture = createBedDetailTexture();
    /* 地面の粒。汀線まわりは砂利、その上と深場は砂 */
    this.groundGravel = createGroundDetailTexture('gravel');
    this.groundSand = createGroundDetailTexture('sand');
    /* 渚の濡れ砂は水面シェーダと同じ高さテクスチャ・同じ遡上式を見る */
    this._shoreUniforms = {
      uShoreHeightTex: { value: this.heightTexture },
      uShoreRegion: { value: WATER_REGION },
      uShoreTime: { value: 0 },
      uShoreWind: { value: 1 },
      uShoreTop: { value: 0.34 },
    };
    this._causticsUniforms = opts.causticsUniforms || null;
    /* 遠景インポスターを起動時に 1 回だけ焼くのに使う。無ければ中景で代用する */
    this._renderer = opts.renderer || null;
    this._dockTextures = opts.dockTextures || null;
    this._leafTextures = opts.leafTextures || null;
    this._landTextures = opts.landTextures || null;
    this._buildTerrainMesh(opts.bedTextures || null, this._landTextures);
    this._findDock();
    this._buildDock();
    this._buildProps();
    this.underwaterProps = new UnderwaterPropScatter(this.scene, this, {
      causticsUniforms: this._causticsUniforms,
      quality: this.quality,
      // 湖底の «藻» を円錐からカードの房に差し替える（クロモと質感を揃える）
      weedGeo: buildSubmergedTuft(this.seed ^ 0x6c1b),
      weedMap: this.waterPlants?.bladeTex?.tuft || null,
    });
  }

  /** 品質変更（水中プロップの密度のみランタイム反映） */
  setQuality(q) {
    this.quality = q;
    this.underwaterProps?.setQuality(q);
    const u = this.mesh?.material?.userData?.bedUniforms;
    if (u?.uPom) {
      u.uPom.value.z = q === 'high' ? 16 : q === 'low' ? 0 : 10;
    }
    if (u?.uGroundStrength) {
      u.uGroundStrength.value = q === 'high' ? 1 : q === 'low' ? 0.45 : 0.75;
    }
    if (u?.uBedDetailStrength) {
      u.uBedDetailStrength.value = q === 'high' ? 0.34 : q === 'low' ? 0.16 : 0.25;
    }
  }

  /** 水中プロップ：カメラ・流れ・時刻 */
  updateUnderwaterProps(time, camera, flowDir, flowStrength) {
    this.underwaterProps?.update(time, camera, flowDir, flowStrength);
    // クロモも水中プロップと同じマテリアルなので、流れと caustics を同じ値で回す
    for (const mat of this.waterPlants?.uwMaterials || []) {
      const u = mat.userData?.uwUniforms;
      if (!u) continue;
      if (u.uUwTime) u.uUwTime.value = time;
      if (u.uUwCamPos) u.uUwCamPos.value.copy(camera.position);
      if (u.uFlowDir) u.uFlowDir.value.set(flowDir.x, flowDir.z);
      if (u.uFlowStrength) u.uFlowStrength.value = flowStrength;
    }
  }

  /** 渚の濡れ砂：水面と同じ時刻・風速を渡す（毎フレーム） */
  updateShore(time, wind) {
    const u = this._shoreUniforms;
    u.uShoreTime.value = time;
    u.uShoreWind.value = wind;
  }

  static _loadRepeatTexture(url, colorSpace = THREE.SRGBColorSpace) {
    return new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = colorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        resolve(tex);
      }, undefined, reject);
    });
  }

  /** 砂地・岩場・泥底のタイルテクスチャを読み込む */
  static loadBedTextures() {
    return Promise.all([
      Terrain._loadRepeatTexture('./assets/textures/bed-sand.webp'),
      Terrain._loadRepeatTexture('./assets/textures/bed-rock.webp'),
      Terrain._loadRepeatTexture('./assets/textures/bed-mud.webp'),
      /* 湖底アルベドの 2 オクターブ目。平均 0.5 の中立タイルなので、
         «色» ではなく «倍率» として扱う（→ NoColorSpace） */
      Terrain._loadRepeatTexture('./assets/textures/bed-grain.webp', THREE.NoColorSpace),
    ]).then(([sand, rock, mud, grain]) => {
      /* 砂・岩・泥は 1 本の 2D 配列テクスチャにまとめる。別々の sampler2D の
         ままだと、粒タイルを足したところで地形フラグメントのサンプラが
         上限（land-texture-test の 9 本）を超える。陸タイルと同じ手 */
      const albedo = makeLandArrayTexture(
        [sand, rock, mud].map((t) => imageToRgba(t.image, BED_ALBEDO_SIZE)),
        BED_ALBEDO_SIZE, THREE.SRGBColorSpace,
      );
      for (const t of [sand, rock, mud]) t.dispose();
      return { albedo, grain };
    });
  }

  /** 桟橋の木材アルベド（床板 / 杭・桁） */
  static loadDockTextures() {
    return Promise.all([
      Terrain._loadRepeatTexture('./assets/textures/dock-plank.webp'),
      Terrain._loadRepeatTexture('./assets/textures/dock-piling.webp'),
      // 水際の藻。帯の «位置» はワールド Y で決めるので、これは面の色だけ
      Terrain._loadRepeatTexture('./assets/textures/piling-algae.webp'),
    ]).then(([plank, piling, algae]) => ({
      plank, piling, algae,
      // アルベドの輝度から凹凸を起こす。新しい画像は要らない
      plankMaps: bakeWoodMaps(plank.image),
      pilingMaps: bakeWoodMaps(piling.image),
    }));
  }

  /**
   * 陸のアルベド 4 種。派生マップ（法線・遮蔽・粗さ）は輝度からその場で焼く。
   *
   * 4 種は 1 本の 2D 配列テクスチャにまとめる。別々の sampler2D にすると
   * 地形フラグメントのサンプラが 16 本を超えてリンクに失敗し、地面が
   * 丸ごと描画されなくなる（→ makeLandArrayTexture）。
   */
  /**
   * 葉のカード（2x2 アトラス、RGBA）。
   *
   * 遠景インポスターはこのテクスチャを描いて焼くので «あとから差し替え»
   * にはできない。地形を組み立てる前に読み終えておくこと。
   * 片方でも読めなければ null を返し、手続き生成のカードのままにする。
   */
  static loadLeafTextures() {
    const load = (kind) => new Promise((resolve) => {
      new THREE.TextureLoader().load(`./assets/textures/leaf-${kind}.png`, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;   // アトラスなので繰り返さない
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        resolve(tex);
      }, undefined, () => resolve(null));
    });
    return Promise.all([load('beech'), load('cedar')])
      .then(([beech, cedar]) => (beech && cedar ? { beech, cedar } : null));
  }

  static loadLandTextures() {
    return Promise.all(
      LAND_KINDS.map((k) => Terrain._loadRepeatTexture(`./assets/textures/land-${k}.webp`)),
    ).then((maps) => {
      const albedo = makeLandArrayTexture(
        maps.map((m) => imageToRgba(m.image, LAND_ALBEDO_SIZE)),
        LAND_ALBEDO_SIZE, THREE.SRGBColorSpace,
      );
      const detail = makeLandArrayTexture(
        maps.map((m, i) => bakeLandDetailLayer(m.image, LAND_DETAIL_OPTS[LAND_KINDS[i]])),
        LAND_DETAIL_SIZE, THREE.NoColorSpace,
      );
      // 配列へ焼いたので元の 1 枚ものはもう要らない
      for (const m of maps) m.dispose();
      return { albedo, detail };
    });
  }

  /* ---------------- 高さ関数（lakefield へ委譲） ---------------- */
  shoreRadius(x, z) { return this.lake.shoreRadius(x, z); }
  heightAt(x, z) { return this.lake.heightAt(x, z); }

  depthAt(x, z) {
    return Math.max(0, -this.heightAt(x, z));
  }

  isWater(x, z) {
    return this.heightAt(x, z) < 0;
  }

  normalAt(x, z, e = 0.7) {
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
  }

  slopeAt(x, z, e = 1.2) {
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    const dx = (hR - hL) / (2 * e), dz = (hU - hD) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  /* ---------------- 水面シェーダ用の高さテクスチャ ---------------- */
  _buildHeightTexture() {
    const N = 512;
    const data = new Float32Array(N * N);
    const half = WATER_REGION / 2;
    for (let j = 0; j < N; j++) {
      const z = (j / (N - 1)) * WATER_REGION - half;
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * WATER_REGION - half;
        data[j * N + i] = this.heightAt(x, z);
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.heightTexture = tex;
  }

  /* ---------------- 地形メッシュ ---------------- */
  /**
   * 同心円の格子で地形を組む。
   *
   * 一様な 1000m 四方の格子（セル 3.85m）だと、プレイヤーがいる汀線の帯には
   * 13.5 万枚のうち 4400 枚しか無かった。面積の 96% を占める深場と遠くの山が
   * 三角形をぜんぶ持っていく。一様に細かくしても無駄が増えるだけなので、
   * 湖と同じ極座標で組んで汀線のバンドだけ詰める（→ terrainMesh.js）。
   * 結果、三角形は 135k → 168k とほぼ据え置きのまま、汀線には 111k が乗る。
   */
  _buildTerrainMesh(bedTextures, landTextures) {
    const grid = buildRadialGrid({ detail: DETAIL_BY_QUALITY[this.quality] ?? 1 });
    const n = grid.vertexCount;
    const verts = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const beds = new Float32Array(n);
    const slopes = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const x = grid.xz[i * 2], z = grid.xz[i * 2 + 1];
      const h = this.heightAt(x, z);
      verts[i * 3] = x;
      verts[i * 3 + 1] = h;
      verts[i * 3 + 2] = z;
      // 傾きを取る幅は «そこのセルの大きさ»。一様格子ではないので頂点ごとに違う
      const slope = this.slopeAt(x, z, grid.cell[i]);
      this._terrainColor(h, slope, x, z, tmpColor);
      colors[i * 3] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
      beds[i] = h < 0.2 ? this.lake.bedAt(x, z, slope).v : 0.5;
      slopes[i] = slope;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aBed', new THREE.BufferAttribute(beds, 1));
    geo.setAttribute('aSlope', new THREE.BufferAttribute(slopes, 1));
    geo.setIndex(new THREE.BufferAttribute(grid.index, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      /* flatShading を切った。3.85m の面を 1 枚ずつハードな法線で塗っていたので、
         地面に入れた砂利・砂の法線とケンカして «折り紙» に見えていた。
         細かい凹凸はディテール法線が持つので、面はなめらかでいい */
    });
    if (bedTextures || landTextures) {
      this._applyBedTextures(mat, bedTextures, this._causticsUniforms, landTextures);
    } else {
      this._applyTerrainCaustics(mat, this._causticsUniforms);
    }
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
    this.scene.add(this.mesh);
  }

  /**
   * 湖底の砂／岩／泥と、陸の浜／草地／林床／岩肌をブレンドして貼る。
   * 陸タイルの目標色は頂点色の実測平均なので、貼っても見た目の色は変わらない。
   */
  _applyBedTextures(mat, tex, causticsUniforms, landTextures) {
    /* 粒タイルが無いときの 1x1。中立（0.5）なので ×2 で 1.0 になり、
       掛けても色が動かない */
    const dummyNeutral = (() => {
      const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    })();
    const uniforms = {
      uBedTex: { value: tex?.albedo || dummyBedArray() },
      uBedGrain: { value: tex?.grain || dummyNeutral },
      /* 粒の効き。1 に近づけるほど «色のムラ» が強くなる */
      uBedGrainAmt: { value: tex?.grain ? 0.62 : 0.0 },
      uBedScale: { value: 1 / 12 }, // 1 タイル ≈ 12 m
      uBedDetail: { value: this.bedDetailTexture },
      uBedDetailScale: { value: 1 / 1.8 },
      uGroundGravel: { value: this.groundGravel },
      uGroundSand: { value: this.groundSand },
      // タイルの一辺（1/m）。砂利 1.1m、砂 0.30m
      uGroundScale: { value: new THREE.Vector2(1 / 1.1, 1 / 0.30) },
      /* 遠景では粒が 1px 未満になってチラつくので距離で消す。
         代わりに «実物の 3D 石» が遠景のシルエットを担う */
      uGroundFade: { value: new THREE.Vector2(26, 95) },
      /* 視差（POM）。x = 砂利の起伏[m], y = 砂の起伏[m], z = 最大ステップ数。
         砂利は 1.1m タイルに半径 12cm の石なので起伏は 9cm ほど。
         深くしすぎると浅い角度で模様が «泳ぐ» */
      uPom: {
        value: new THREE.Vector3(0.055, 0.004,
          this.quality === 'high' ? 16 : this.quality === 'low' ? 0 : 10),
      },
      /* 視差を効かせる距離。1 画素あたりの起伏が見えなくなったら
         ステップを回すだけ無駄になる */
      uPomFade: { value: new THREE.Vector2(3, 15) },
      uGroundStrength: { value: this.quality === 'high' ? 1 : this.quality === 'low' ? 0.45 : 0.75 },
      uBedDetailStrength: { value: this.quality === 'high' ? 0.34 : this.quality === 'low' ? 0.16 : 0.25 },
      uLandAlbedo: { value: landTextures?.albedo || dummyLandArray([160, 150, 130, 255], THREE.SRGBColorSpace) },
      uLandDetail: { value: landTextures?.detail || dummyLandArray([128, 128, 128, 230], THREE.NoColorSpace) },
      // 浜 2m / 草地 3m / 林床 3m / 岩肌 4m
      uLandScale: { value: new THREE.Vector4(1 / 2, 1 / 3, 1 / 3, 1 / 4) },
      /* 遠景では効かないので切る。切っても «色» は変わらない
         （タイルの平均色 = 頂点色の実測） */
      uLandFade: { value: new THREE.Vector2(110, 190) },
      uLandOn: { value: landTextures ? 1 : 0 },
    };
    Object.assign(uniforms, this._shoreUniforms);
    if (causticsUniforms) Object.assign(uniforms, causticsUniforms);
    mat.userData.bedUniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aBed;
          attribute float aSlope;
          varying float vBed;
          varying float vSlope;
          varying vec3 vBedWorldPos;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vBed = aBed;
          vSlope = aSlope;
          vBedWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          ${CAUSTICS_GLSL}
          ${SHORE_WET_GLSL}
          /* 砂・岩・泥の 3 層。層番号は loadBedTextures の並び順 */
          uniform sampler2DArray uBedTex;
          #define BED_SAND 0.0
          #define BED_ROCK 1.0
          #define BED_MUD  2.0
          uniform sampler2D uBedGrain;
          uniform float uBedGrainAmt;
          uniform sampler2D uBedDetail;
          uniform sampler2D uGroundGravel;
          uniform sampler2D uGroundSand;
          /* 陸の 4 種は層で持つ。sampler2D 8 本に分けると
             MAX_TEXTURE_IMAGE_UNITS(16) を超えてリンクに失敗する */
          uniform sampler2DArray uLandAlbedo;
          uniform sampler2DArray uLandDetail;
          #define LAND_BEACH 0.0
          #define LAND_GRASS 1.0
          #define LAND_FOREST 2.0
          #define LAND_ROCK 3.0
          uniform vec2 uGroundScale;
          uniform vec2 uGroundFade;
          uniform vec3 uPom;
          uniform vec2 uPomFade;
          uniform float uGroundStrength;
          uniform float uBedScale;
          uniform float uBedDetailScale;
          uniform float uBedDetailStrength;
          uniform vec4 uLandScale;
          uniform vec2 uLandFade;
          uniform float uLandOn;
          varying float vBed;
          varying float vSlope;
          varying vec3 vBedWorldPos;

          /* 地面の «粒»：砂利と砂を選んで 1 枚にまとめる。
             RG = 傾き, B = 高さ, A = 色味（砂利）／粗さ（砂）。
             w.x = 効かせ具合（距離フェード込み）、w.y = 砂利の割合 */
          vec4 gGround = vec4(0.5, 0.5, 0.5, 0.9);
          vec2 gGroundW = vec2(0.0);
          float gGravelTint = 1.0;
          /* 視差でずらす «世界座標のずれ» と、視線が沈んだ深さ（0〜1）。
             ずれはアルベドにも同じだけ掛けないと «形だけ動いて絵が動かない» */
          vec2 gPomOff = vec2(0.0);
          float gPomSink = 0.0;
          /* 視差の効き具合（距離フェード）。遮蔽の混ぜ方に使う。
             これを使わずに «沈んだかどうか» で切り替えると、
             フェードの終わりにプレイヤーを中心とした円が見える */
          float gPomW = 0.0;
          float gGravelMix = 0.0;

          /**
           * 視差オクルージョン（POM）。
           *
           * 地面はほぼ水平で、模様は world.xz をそのまま UV にしているので、
           * 接空間は «接 +X / 従接 +Z / 法線 +Y» と決まっている。だから
           * 接線を持たない地形メッシュでも、視線をそのまま高さ場へ通せる。
           *
           * 視線が高さ場に «最初にぶつかる» ところまで辿り、世界座標の
           * ずれと沈んだ深さを返す。沈んだ深さはそのまま遮蔽に使える
           * （谷ほど深く沈む）。
           */
          vec3 pomTrace(sampler2D tex, vec2 wxz, float invTile,
                        vec3 V, float depth, float steps) {
            // 完全に沈んだときの世界座標のずれ。視線と «逆» へ動く
            vec2 maxOff = -(V.xz / max(V.y, 0.30)) * depth;
            float dz = 1.0 / steps;
            vec2 dOff = maxOff * dz;
            vec2 off = vec2(0.0);
            float rayH = 1.0;
            float h = texture2D(tex, wxz * invTile).b;
            float prevH = h, prevRay = rayH;
            for (int i = 0; i < 32; i++) {
              if (float(i) >= steps || h >= rayH) break;
              prevH = h; prevRay = rayH;
              off += dOff; rayH -= dz;
              h = texture2D(tex, (wxz + off) * invTile).b;
            }
            /* 最後の 1 歩を線形に詰める。詰めないと段差が縞になって出る */
            float a = h - rayH, b = prevH - prevRay;
            float t = clamp(b / max(b - a, 1e-4), 0.0, 1.0);
            off -= dOff * (1.0 - t);
            return vec3(off, 1.0 - mix(prevRay, rayH, t));
          }

          /* 砂利は «汀線まわり» と «岩質の底»。それ以外は砂。
             まっすぐな帯にならないようノイズで崩す。
             shoreNoise は fbm なので、必要になるまで呼ばないこと */
          float gravelMix(vec3 wp, float bedKind) {
            float g = clamp((1.0 - smoothstep(0.05, 1.10, wp.y))
                          + smoothstep(0.55, 0.75, bedKind), 0.0, 1.0);
            return g * (0.30 + 0.70 * smoothstep(0.30, 0.70, shoreNoise(wp.xz * 0.16)));
          }

          /* 砂利／砂の別と視差のずれを先に決める。
             アルベド（applyLandAlbedo）より前に呼ぶ必要がある。
             «遠い» と分かった時点で即戻る：ここで fbm を回すと、地形の
             全ピクセル（遠くの山まで）に費用が乗る */
          void groundParallax(vec3 wp, float bedKind) {
            gGravelMix = -1.0;          // まだ決めていない印
            gPomOff = vec2(0.0);
            gPomSink = 0.0;
            gPomW = 0.0;
            if (uPom.z < 0.5) return;
            float pf = 1.0 - smoothstep(uPomFade.x, uPomFade.y,
              length(wp - cameraPosition));
            if (pf < 0.01) return;
            float g = gravelMix(wp, bedKind);
            gGravelMix = g;
            vec3 V = normalize(cameraPosition - wp);
            // 真上から見下ろすほどずれは小さいので、ステップも減らせる
            float steps = mix(uPom.z, 8.0, clamp(V.y * 1.4, 0.0, 1.0));
            vec3 r = (g > 0.5)
              ? pomTrace(uGroundGravel, wp.xz, uGroundScale.x, V, uPom.x * pf, steps)
              : pomTrace(uGroundSand, wp.xz, uGroundScale.y, V, uPom.y * pf, steps);
            gPomOff = r.xy;
            gPomSink = r.z;
            gPomW = pf;
          }

          void groundDetail(vec3 wp, float bedKind) {
            float fade = 1.0 - smoothstep(uGroundFade.x, uGroundFade.y,
              length(wp - cameraPosition));
            if (fade < 0.002) { gGroundW = vec2(0.0); return; }
            // 視差が «遠い» で戻っていたら、ここで初めて砂利の割合を決める
            float g = gGravelMix < 0.0 ? gravelMix(wp, bedKind) : gGravelMix;
            vec2 pxz = wp.xz + gPomOff;      // 視差でずらした位置
            /* 1 枚をそのまま貼ると «同じ石の並び» が 1.1m ごとに現れて
               プチプチに見える。回して縮めた 2 枚目を重ねて周期を殺す。
               2 枚目は法線だけ弱めに足し、高さと粗さは 1 枚目を主にする */
            vec2 uv = pxz * uGroundScale.x;
            /* 2 枚目は «回して 1.63m» にする。1.1 と 1.63 は割り切れないので
               重ねた見た目の周期がとても長くなる。倍率を下げて大きくすると
               今度は 30cm の塊がぼやけて見えるので、石の大きさは揃える */
            vec2 uv2 = mat2(0.83, -0.56, 0.56, 0.83) * pxz * (uGroundScale.x * 0.675);
            vec4 gv = texture2D(uGroundGravel, uv);
            vec4 gv2 = texture2D(uGroundGravel, uv2);
            gv.xy = (gv.xy + gv2.xy) * 0.5;
            gv.b = min(gv.b, gv2.b * 1.15);
            /* 石 1 個ずつの色味と粗さ。砂利は A に色味が入っている */
            float stone = smoothstep(0.04, 0.30, gv.a);
            gGravelTint = mix(1.0, 0.80 + gv.a * 0.40, stone);
            gv.a = clamp(0.92 - stone * 0.34, 0.0, 1.0);
            vec4 sd = texture2D(uGroundSand, pxz * uGroundScale.y);
            gGround = mix(sd, gv, g);
            gGravelTint = mix(1.0, gGravelTint, g);
            gGroundW = vec2(fade * uGroundStrength, g);
          }

          vec4 gLandDet = vec4(0.5, 0.5, 0.5, 0.9);
          float gLandAmt = 0.0;
          vec4 gLandW = vec4(0.0);
          /* 回して縮めた 2 枚目を混ぜてタイルの周期を殺す。
             砂利と同じ手。1.0 と 0.73 は割り切れないので繰り返しが目立たない */
          vec3 sampleLand(float layer, vec2 xz, float invTile) {
            vec3 a = texture(uLandAlbedo, vec3(xz * invTile, layer)).rgb;
            vec2 uv2 = mat2(0.83, -0.56, 0.56, 0.83) * xz * (invTile * 0.73);
            vec3 b = texture(uLandAlbedo, vec3(uv2, layer)).rgb;
            return mix(a, b, 0.34);
          }
          /* 派生（法線・遮蔽・粗さ）は 1 タップ。
             アルベドと違って繰り返しが目に付かないので、
             周期を殺す 2 枚目に取り出しコストを払う価値がない */
          vec4 sampleLand4(float layer, vec2 xz, float invTile) {
            return texture(uLandDetail, vec3(xz * invTile, layer));
          }
          vec3 applyLandAlbedo(vec3 wp, float under, vec3 diffuse) {
            gLandAmt = 0.0;
            if (uLandOn < 0.5) return diffuse;
            /* タイルが 1px を割る遠景では、取り出しても頂点色との差が出ない。
               タイルの平均色は頂点色の実測に合わせてあるので、
               消しても «色が変わる» ことはない。遠くの山ぜんぶで
               16 回のテクスチャ取り出しを省ける */
            float lFade = 1.0 - smoothstep(uLandFade.x, uLandFade.y,
              length(wp - cameraPosition));
            if (lFade < 0.004 || under > 0.995) return diffuse;
            float h = wp.y;
            float wBeach = 1.0 - smoothstep(0.85, 1.35, h);
            float wForest = smoothstep(6.5, 9.5, h);
            float wGrass = max(0.0, 1.0 - wBeach - wForest);
            float wRock = smoothstep(0.45, 0.72, vSlope);
            // 雪は無い（森林限界より下の山）。高い所も林床タイルのまま
            float wSum = max(1e-4, wBeach + wGrass + wForest);
            // 視差のずれはアルベドにも掛ける。掛けないと «凹凸だけ動いて絵が動かない»
            vec2 xz = wp.xz + gPomOff;
            vec3 col = (sampleLand(LAND_BEACH, xz, uLandScale.x) * wBeach
                      + sampleLand(LAND_GRASS, xz, uLandScale.y) * wGrass
                      + sampleLand(LAND_FOREST, xz, uLandScale.z) * wForest) / wSum;
            col = mix(col, sampleLand(LAND_ROCK, xz, uLandScale.w), wRock * 0.85);
            gLandAmt = (1.0 - under) * uLandOn * lFade;
            gLandW = vec4(wBeach, wGrass, wForest, wRock);
            gLandDet = (sampleLand4(LAND_BEACH, xz, uLandScale.x) * wBeach
                      + sampleLand4(LAND_GRASS, xz, uLandScale.y) * wGrass
                      + sampleLand4(LAND_FOREST, xz, uLandScale.z) * wForest) / wSum;
            gLandDet = mix(gLandDet, sampleLand4(LAND_ROCK, xz, uLandScale.w), wRock * 0.85);
            diffuse = mix(diffuse, col, gLandAmt);
            float aoW = gLandAmt * mix(0.22, 0.80, 1.0 - gLandW.x);
            diffuse *= mix(vec3(1.0), mix(vec3(0.84), vec3(1.06), gLandDet.b), aoW);
            return diffuse;
          }`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float under = smoothstep(0.12, -0.28, vBedWorldPos.y);
            if (under > 0.001) {
              vec2 uv = vBedWorldPos.xz * uBedScale;
              vec3 mudC  = texture(uBedTex, vec3(uv, BED_MUD)).rgb;
              vec3 sandC = texture(uBedTex, vec3(uv, BED_SAND)).rgb;
              vec3 rockC = texture(uBedTex, vec3(uv, BED_ROCK)).rgb;
              vec4 detail = texture2D(uBedDetail, vBedWorldPos.xz * uBedDetailScale);
              float v = vBed;
              float wMud  = 1.0 - smoothstep(0.28, 0.40, v);
              float wRock = smoothstep(0.62, 0.74, v);
              float wSand = max(0.0, 1.0 - wMud - wRock);
              float wSum = max(1e-4, wMud + wSand + wRock);
              vec3 bedCol = (mudC * wMud + sandC * wSand + rockC * wRock) / wSum;
              bedCol *= mix(0.88, 1.10, detail.b);
              /* 湖底のアルベドは 1 タイル 12m（≒8.5px/m）と粗い。凹凸のほうは
                 uBedDetailScale = 1/1.8m で細かいので、寄ると «凹凸だけ鮮明で
                 色はボケる» ちぐはぐが出る（立方体モード・俯瞰・水中カメラで
                 目立つ）。同じ 1.8m で色の 2 オクターブ目を掛ける。
                 平均 0.5 の中立タイルなので ×2 で明るさは動かない。
                 遠景では mip が 0.5 へ寄って自動的に効かなくなる */
              vec3 grain = texture2D(uBedGrain, vBedWorldPos.xz * uBedDetailScale).rgb;
              bedCol *= mix(vec3(1.0), grain * 2.0, uBedGrainAmt);
              float d = clamp(-vBedWorldPos.y / 16.0, 0.0, 1.0);
              bedCol *= mix(1.0, 0.38, d);
              diffuseColor.rgb = mix(diffuseColor.rgb, bedCol, under);
            }
            /* 視差のずれを先に決める。アルベドも粒も同じずれを使う */
            groundParallax(vBedWorldPos, vBed);
            diffuseColor.rgb = applyLandAlbedo(vBedWorldPos, under, diffuseColor.rgb);
            gShoreWet = shoreWetness(vBedWorldPos);
            diffuseColor.rgb = shoreDress(diffuseColor.rgb, vBedWorldPos, under);
            /* 粒の遮蔽。石の «あいだ» が締まるので、平らな砂浜が
               «塗った面» に見えなくなる。ここは水中も陸も同じに掛ける。
               視差が効いている間は «視線がどれだけ沈んだか» を使う
               （谷ほど深く沈むので実際の凹凸とずれない）。外では高さで代用。
               2 つの切り替えは «視差の効き具合» で連続に混ぜること。
               step で切り替えると、フェードが終わる 15m のところに
               プレイヤーを中心とした円がはっきり出る（実際に出した） */
            groundDetail(vBedWorldPos, vBed);
            /* 2 つの式は «平均» も揃えておく。高さ由来は平均 0.95、
               沈み込み由来を 1.10 - sink*0.52 にすると平均 0.84 で、
               連続に混ぜても «手前だけ暗い暈» として残る。
               1.21 起点にすると両方 0.95 になり、差は «濃淡の強さ» だけ */
            float grainAo = mix(mix(0.80, 1.10, gGround.b),
              1.21 - gPomSink * 0.52, gPomW);
            diffuseColor.rgb *= mix(1.0, grainAo * gGravelTint, gGroundW.x);
          }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          {
            float under = smoothstep(0.12, -0.28, vBedWorldPos.y);
            vec4 detail = texture2D(uBedDetail, vBedWorldPos.xz * uBedDetailScale);
            float bedRough = mix(0.98, 0.88, smoothstep(0.28, 0.40, vBed));
            bedRough = mix(bedRough, 0.76, smoothstep(0.62, 0.74, vBed));
            bedRough = clamp(bedRough + (detail.a - 0.5) * 0.14, 0.66, 1.0);
          roughnessFactor = mix(roughnessFactor, bedRough, under);
          roughnessFactor = mix(roughnessFactor, gLandDet.a, gLandAmt * 0.65);
          /* 粒ごとの粗さ。磨かれた石は滑らかで砂は粗いので、
             同じ濡れ具合でも石だけ先に光る */
          roughnessFactor = mix(roughnessFactor, gGround.a, gGroundW.x * 0.75);
          // 濡れた砂は鏡面が立つ。太陽が低いときの照り返しがここで出る
          roughnessFactor = mix(roughnessFactor, 0.28, gShoreWet.x * 0.85);
          }`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            float under = smoothstep(0.12, -0.28, vBedWorldPos.y);
            vec2 detailSlope = texture2D(uBedDetail, vBedWorldPos.xz * uBedDetailScale).xy * 2.0 - 1.0;
            vec3 detailView = mat3(viewMatrix) * vec3(-detailSlope.x, 0.0, -detailSlope.y);
            float detailAmt = uBedDetailStrength * max(under, gShoreWet.z * 0.28)
                            * (1.0 - gShoreWet.x * 0.65);
            normal = normalize(normal + detailView * detailAmt);
            /* 粒の凹凸。以前は湖底だけに掛けていたので、乾いた砂浜が
               のっぺりした面のままだった。陸にも同じだけ掛ける */
            vec2 gs = gGround.xy * 2.0 - 1.0;
            vec3 gView = mat3(viewMatrix) * vec3(-gs.x, 0.0, -gs.y);
            normal = normalize(normal + gView * (gGroundW.x * 0.40));
            /* 陸タイル由来の凹凸。砂浜は pebble field に任せるので弱く */
            vec2 ls = gLandDet.xy * 2.0 - 1.0;
            vec3 lView = mat3(viewMatrix) * vec3(-ls.x, 0.0, -ls.y);
            float nAmt = gLandAmt * (0.10 * gLandW.x + 0.40 * gLandW.y
                       + 0.48 * gLandW.z + 0.58 * gLandW.w);
            normal = normalize(normal + lView * nAmt);
          }`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += causticLight(vBedWorldPos, normal);`
        );
    };
    mat.customProgramCacheKey = () => 'terrain-bed-tex-v17-pom-ring';
  }

  /** 湖底テクスチャが使えない環境でも、頂点色の湖底へコースティクスを載せる。 */
  _applyTerrainCaustics(mat, causticsUniforms) {
    if (!causticsUniforms) return;
    mat.userData.causticsUniforms = causticsUniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this._shoreUniforms);
      Object.assign(shader.uniforms, causticsUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vTerrainWorldPos;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vTerrainWorldPos;
          ${CAUSTICS_GLSL}
          ${SHORE_WET_GLSL}`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float under = smoothstep(0.12, -0.28, vTerrainWorldPos.y);
            gShoreWet = shoreWetness(vTerrainWorldPos);
            diffuseColor.rgb = shoreDress(diffuseColor.rgb, vTerrainWorldPos, under);
          }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.28, gShoreWet.x * 0.85);`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += causticLight(vTerrainWorldPos, normal);`
        );
    };
    mat.customProgramCacheKey = () => 'terrain-vcolor-v3-shorewet-caustics';
  }

  _terrainColor(h, slope, x, z, out) {
    const n = this.noise.fbm(x * 0.09, z * 0.09, 2) * 0.5 + 0.5;
    /* 波長 2.4m の細かいほう。3.85m 格子では拾えなかったので入れていなかったが、
       汀線バンドが 1.25m になったので «地面のムラ» として効くようになった。
       陸にはテクスチャが無く、頂点色だけで «地面らしさ» を作る必要がある */
    const nf = this.noise.fbm(x * 0.42, z * 0.42, 2) * 0.5 + 0.5;
    const nl = n * 0.58 + nf * 0.42;
    const rocky = clamp01((slope - 0.5) * 1.6);

    if (h < -0.15) {
      /* 湖底：底質（砂地・岩場・泥底）で色を変える。
         深いほど暗く落として、水の透明度と合わせる */
      const bed = this.lake.bedAt(x, z, slope);
      const d = clamp01(-h / 16);
      const shade = lerp(1.0, 0.34, d);
      if (bed.kind === 'rock') {
        out.setRGB((0.40 + n * 0.10) * shade, (0.39 + n * 0.09) * shade, (0.36 + n * 0.08) * shade);
      } else if (bed.kind === 'sand') {
        out.setRGB((0.52 + n * 0.07) * shade, (0.46 + n * 0.06) * shade, (0.31 + n * 0.05) * shade);
      } else {
        // 泥底：砂より少し暗いベージュ（炭黒にしない）
        out.setRGB((0.42 + n * 0.06) * shade, (0.36 + n * 0.05) * shade, (0.24 + n * 0.04) * shade);
      }
      // 砂と岩の境目を少し混ぜて、パッチの縁を柔らかくする
      if (bed.v > 0.62 && bed.v < 0.74) out.multiplyScalar(0.94);
    } else if (h < 1.1) {
      // 汀線の砂浜
      const t = clamp01((h + 0.15) / 1.25);
      out.setRGB(0.52 + nl * 0.09, 0.47 + nl * 0.08, 0.36 + nl * 0.06);
      out.lerp(tmpSand.setRGB(0.30 + nl * 0.10, 0.36 + nl * 0.11, 0.19), t * 0.55);
    } else {
      const t = clamp01((h - 1.1) / 22);
      // 草地 -> 深い森
      out.setRGB(
        lerp(0.24, 0.13, t) + nl * 0.09,
        lerp(0.36, 0.24, t) + nl * 0.12,
        lerp(0.15, 0.12, t) + nl * 0.05
      );
      // 岩肌
      out.lerp(tmpSand.setRGB(0.30 + nl * 0.08, 0.29 + nl * 0.07, 0.27 + nl * 0.06), rocky * 0.85);
      /* 雪はやめた。ここは森林限界より下の山で、頂上まで木が生えている。
         標高の高いところは針葉樹が増えるぶん、少しだけ暗く沈ませる */
      out.lerp(tmpSand.setRGB(0.10 + nl * 0.05, 0.17 + nl * 0.07, 0.11 + nl * 0.04),
        smoothstep(60, 140, h) * 0.55 * (1 - rocky * 0.6));
    }
  }

  /* ---------------- 桟橋（位置は lakefield が決定・検証済み） ---------------- */
  _findDock() {
    const d = this.lake.dock;
    const len = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z);
    this._dockU = { x: (d.end.x - d.start.x) / len, z: (d.end.z - d.start.z) / len };
    this._dockLen = len;
    this.shoreR0 = d.r0;
    this.dockDir = new THREE.Vector3(d.dir.x, 0, d.dir.z);   // 岸→湖心
    this.dockStart = new THREE.Vector3(d.start.x, 0, d.start.z);
    this.dockEnd = new THREE.Vector3(d.end.x, 0, d.end.z);
    this.dockY = d.y;
    this.spawnPos = this.dockEnd.clone().addScaledVector(this.dockDir, -3).setY(this.dockY);
  }

  _buildDock() {
    const g = new THREE.Group();
    const plankMap = this._dockTextures?.plank || null;
    const pilingMap = this._dockTextures?.piling || null;
    const algaeMap = this._dockTextures?.algae || null;
    const woodMat = makeDockWoodMat(
      plankMap, 0x7a5b3c, 0.92, this._causticsUniforms, 'dock-wood-caustics-v1',
      0xffffff, algaeMap, this._dockTextures?.plankMaps || null
    );
    const woodDark = makeDockWoodMat(
      pilingMap, 0x5a4029, 0.95, this._causticsUniforms, 'dock-dark-caustics-v1', 0xc8b49a,
      algaeMap, this._dockTextures?.pilingMaps || null
    );
    const postMat = withInstanceUvY(
      makeDockWoodMat(
        pilingMap, 0x5a4029, 0.95, this._causticsUniforms, 'dock-post-caustics-v1', 0xc8b49a,
        algaeMap, this._dockTextures?.pilingMaps || null
      ),
      'dock-post-caustics-v1'
    );

    const a = this.dockStart, b = this.dockEnd;
    const len = a.distanceTo(b);
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const W = 3.4;

    // 板（インスタンス）
    const plankCount = Math.max(6, Math.floor(len / 0.55));
    const plankGeo = new THREE.BoxGeometry(W, 0.12, 0.42);
    scaleBoxUVs(plankGeo, W, 0.12, 0.42);
    const planks = new THREE.InstancedMesh(plankGeo, woodMat, plankCount);
    planks.castShadow = true; planks.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < plankCount; i++) {
      const t = (i + 0.5) / plankCount;
      p.lerpVectors(a, b, t).setY(this.dockY);
      s.set(1, 1, 0.92 + (i % 3) * 0.04);
      m.compose(p, q, s);
      planks.setMatrixAt(i, m);
    }
    planks.instanceMatrix.needsUpdate = true;
    g.add(planks);

    // 縦桁
    const beamGeo = new THREE.BoxGeometry(0.22, 0.28, len);
    scaleBoxUVs(beamGeo, 0.22, 0.28, len);
    swapBoxUVs(beamGeo);
    for (const off of [-W / 2 + 0.2, W / 2 - 0.2]) {
      const beam = new THREE.Mesh(beamGeo, woodDark);
      beam.position.copy(mid).setY(this.dockY - 0.2);
      beam.position.x += Math.cos(yaw) * off;
      beam.position.z += -Math.sin(yaw) * off;
      beam.rotation.y = yaw;
      beam.castShadow = true;
      g.add(beam);
    }

    // 杭
    const postGeo = new THREE.CylinderGeometry(0.16, 0.19, 1, 7);
    scaleCylinderUVs(postGeo, 0.175, 1);
    const postRows = Math.max(2, Math.floor(len / 3.2));
    const posts = new THREE.InstancedMesh(postGeo, postMat, postRows * 2);
    posts.castShadow = true;
    let pi = 0;
    for (let i = 0; i < postRows; i++) {
      const t = (i + 0.5) / postRows;
      const base = new THREE.Vector3().lerpVectors(a, b, t);
      for (const off of [-W / 2 + 0.25, W / 2 - 0.25]) {
        const px = base.x + Math.cos(yaw) * off;
        const pz = base.z - Math.sin(yaw) * off;
        const bed = this.heightAt(px, pz);
        const bot = Math.min(bed - 0.4, this.dockY - 0.6);
        const hh = this.dockY - 0.28 - bot;
        p.set(px, bot + hh / 2, pz);
        s.set(1, hh, 1);
        m.compose(p, new THREE.Quaternion(), s);
        posts.setMatrixAt(pi++, m);
      }
    }
    posts.count = pi;
    posts.instanceMatrix.needsUpdate = true;
    g.add(posts);

    // 手すり（先端の3方向）
    const railMat = woodDark;
    const railPost = new THREE.CylinderGeometry(0.07, 0.08, 0.95, 6);
    scaleCylinderUVs(railPost, 0.075, 0.95);
    const barLen = W - 0.4;
    const railBar = new THREE.BoxGeometry(0.09, 0.09, barLen);
    scaleBoxUVs(railBar, 0.09, 0.09, barLen);
    swapBoxUVs(railBar);
    const tip = b.clone();
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const corners = [
      tip.clone().addScaledVector(right, -W / 2 + 0.2),
      tip.clone().addScaledVector(right, W / 2 - 0.2),
      tip.clone().addScaledVector(right, -W / 2 + 0.2).addScaledVector(dir, -1.9),
      tip.clone().addScaledVector(right, W / 2 - 0.2).addScaledVector(dir, -1.9),
    ];
    corners.forEach((cp) => {
      const rp = new THREE.Mesh(railPost, railMat);
      rp.position.copy(cp).setY(this.dockY + 0.48);
      rp.castShadow = true;
      g.add(rp);
    });
    // 先端の横バー
    const bar = new THREE.Mesh(railBar, railMat);
    bar.position.copy(tip).setY(this.dockY + 0.9);
    bar.rotation.y = yaw + Math.PI / 2;
    g.add(bar);

    // 灯篭（夜に点く）
    const lampPostGeo = new THREE.CylinderGeometry(0.08, 0.1, 2.2, 7);
    scaleCylinderUVs(lampPostGeo, 0.09, 2.2);
    const lampPost = new THREE.Mesh(lampPostGeo, woodDark);
    const lampBase = a.clone().addScaledVector(dir, 1.2).addScaledVector(right, W / 2 - 0.15);
    lampPost.position.copy(lampBase).setY(this.dockY + 1.0);
    lampPost.castShadow = true;
    g.add(lampPost);

    this.lampMat = new THREE.MeshStandardMaterial({
      color: 0xffd9a0, emissive: 0xffb050, emissiveIntensity: 0, roughness: 0.5,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), this.lampMat);
    bulb.position.copy(lampBase).setY(this.dockY + 2.15);
    g.add(bulb);
    this.lampLight = new THREE.PointLight(0xffb060, 0, 26, 2);
    this.lampLight.position.copy(bulb.position);
    g.add(this.lampLight);
    this.addObstacle(lampBase.x, lampBase.z, 0.26, this.dockY + 2.3);

    // 小舟（雰囲気）
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.62, 2.6, 4, 10),
      makeDockWoodMat(
        pilingMap, 0x8a6a45, 0.9, this._causticsUniforms, 'boat-hull-caustics-v1'
      )
    );
    hull.rotation.z = Math.PI / 2;
    hull.scale.set(1, 1, 0.55);
    boat.add(hull);
    const inner = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.5, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 1 })
    );
    inner.position.y = 0.45;
    boat.add(inner);
    boat.position.copy(a).addScaledVector(dir, 4).addScaledVector(right, -(W / 2 + 1.7));
    boat.position.y = 0.05;
    boat.rotation.y = yaw + 0.25;
    boat.castShadow = true;
    this.boat = boat;
    g.add(boat);
    // 小舟にも当たり判定（船体に沿って2点）
    for (const t of [-0.9, 0.9]) {
      this.addObstacle(boat.position.x + dir.x * t, boat.position.z + dir.z * t, 0.85, boat.position.y + 0.95);
    }

    this.dock = g;
    this.scene.add(g);
  }

  /** 桟橋の上か（歩行判定用） */
  /** 桟橋ローカル座標（along: 岸→沖 / side: 右） */
  _dockLocal(x, z, out = { al: 0, si: 0 }) {
    const a = this.dockStart;
    out.al = (x - a.x) * this._dockU.x + (z - a.z) * this._dockU.z;
    out.si = -(x - a.x) * this._dockU.z + (z - a.z) * this._dockU.x;
    return out;
  }

  /**
   * 桟橋の床の上か（矩形判定）。以前はカプセル判定だったため、
   * 先端の外側に半円状の「見えない床」ができていた。
   */
  onDock(x, z) {
    const p = this._dockLocal(x, z, _dl);
    if (p.al < 0 || p.al > this._dockLen) return null;
    if (Math.abs(p.si) > DOCK_HALF_W) return null;
    return this.dockY;
  }

  /** 桟橋の中心線までの距離（装飾の配置除外用） */
  distToDock(x, z) {
    const p = this._dockLocal(x, z, _dl);
    const al = clamp(p.al, 0, this._dockLen);
    const dAl = p.al - al;
    return Math.hypot(dAl, p.si);
  }

  /**
   * 線分が桟橋（床＋先端の手すり）を貫通するか。
   * 糸が桟橋を突き抜けて釣りができてしまうのを防ぐ。
   */
  dockBlocksSegment(x0, y0, z0, x1, y1, z1) {
    const a = this._dockLocal(x0, z0, _dl);
    const p0 = [a.al, y0, a.si];
    const b = this._dockLocal(x1, z1, _dl2);
    const p1 = [b.al, y1, b.si];
    const L = this._dockLen, W = DOCK_HALF_W, Y = this.dockY;
    // 床（桁も含む厚み）
    if (segBoxHit(p0, p1, [0, Y - 0.42, -W], [L, Y + 0.18, W])) return true;
    // 先端の手すり
    if (segBoxHit(p0, p1, [L - 2.3, Y - 0.42, -W], [L, Y + 1.05, W])) return true;
    return false;
  }

  /* ---------------- 障害物（岩・木） ---------------- */
  /** @param top 上端の高さ（糸の判定に使う） */
  /** 水中ストラクチャーが近くにあるか（あれば一番近いものを返す） */
  structureNear(x, z, radius = 4.5) {
    let best = null, bd = radius * radius;
    for (const t of this.structures || []) {
      const d = (t.x - x) ** 2 + (t.z - z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /** 底質（'mud' | 'sand' | 'rock'） */
  bedAt(x, z) { return this.lake.bedAt(x, z); }

  addObstacle(x, z, r, top = 0) {
    this.obstacles.push(x, z, r, top);
    const key = ((Math.floor(x / OBS_CELL) & 1023) << 10) | (Math.floor(z / OBS_CELL) & 1023);
    let arr = this._obsGrid.get(key);
    if (!arr) { arr = []; this._obsGrid.set(key, arr); }
    arr.push(this.obstacles.length - 4);
  }

  /** (x,z) が半径 rad の円として障害物にぶつかるか */
  /**
   * @param {number} [y] 指定すると «その高さより上まである» 障害物だけを見る。
   *   カメラの当たり判定で使う（足元の藪でカメラが押されると鬱陶しい）。
   *   歩く判定は高さを見ない＝これまでどおり。
   */
  blockedAt(x, z, rad = 0.32, y) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    const o = this.obstacles;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._obsGrid.get((((cx + dx) & 1023) << 10) | ((cz + dz) & 1023));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          if (y !== undefined && o[i + 3] < y) continue;
          const ddx = x - o[i], ddz = z - o[i + 1], rr = o[i + 2] + rad;
          if (ddx * ddx + ddz * ddz < rr * rr) return true;
        }
      }
    }
    return false;
  }

  /** (x,z) を覆っている障害物の上端の最大値（無ければ -Infinity） */
  obstacleTopAt(x, z) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    const o = this.obstacles;
    let top = -Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._obsGrid.get((((cx + dx) & 1023) << 10) | ((cz + dz) & 1023));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - o[i], ddz = z - o[i + 1], rr = o[i + 2];
          if (ddx * ddx + ddz * ddz < rr * rr && o[i + 3] > top) top = o[i + 3];
        }
      }
    }
    return top;
  }

  /**
   * 糸（ロッド先端 → 到達点）が地形や岩を貫通するか。
   * たるみ（sag）も考慮した曲線でサンプリングする。
   * @returns {null|{x:number,y:number,z:number,ground:number,kind:string}}
   */
  lineBlocked(x0, y0, z0, x1, y1, z1, opts = {}) {
    const tol = opts.tol ?? 0.22;
    const slack = opts.slack ?? 0.5;
    const dx = x1 - x0, dz = z1 - z0;
    const dist = Math.hypot(dx, dz, y1 - y0);
    if (dist < 1) return null;
    const sag = Math.min(dist * 0.16, 1.2) * slack;
    // 地形の細部ノイズは波長 18m 程度なので 1.6m 刻みで十分
    const N = Math.min(40, Math.max(8, Math.ceil(dist / 1.6)));
    for (let i = 1; i < N; i++) {
      const t = i / N;
      const x = x0 + dx * t, z = z0 + dz * t;
      const y = y0 + (y1 - y0) * t - lineSagProfile(t) * sag;   // 描画と同じたるみの形
      const g = this.heightAt(x, z);
      if (y + tol < g) return { x, y, z, ground: g, kind: 'terrain' };
      const ot = this.obstacleTopAt(x, z);
      if (ot > -Infinity && y + tol < ot) return { x, y, z, ground: ot, kind: 'rock' };
    }
    return null;
  }

  /* ---------------- 岸辺の装飾 ---------------- */
  _buildProps() {
    const rng = makeRng(this.seed ^ 0x5a5a);
    const q = this.quality;
    /* 遠景がインポスター 4 ポリなので、本数は近景の面積だけで決まる。
       900 本だと 20m 間隔の疎林で「植えた公園」に見えるため増やす */
    /* 本数は «歩ける帯の中» と «その外» で別に決める。
       一律に増やすと近景の密度まで上がって、林の中に立ったときの
       近景・中景がそのまま倍になる（60000 本を一律で撒いたら林内で
       15.2M 三角形・42ms になった）。移動制限は近景を軽くしない。

       外側はほぼインポスターで、27000 本を湖越しに全部映しても
       GPU 0.8ms・330k 三角形・ドローコール 10 だった。しかも歩ける範囲を
       絞ったことで «絶対に近づけない» と配置時に確定でき、毎フレームの
       距離判定からも外せる（TreeSet.addFar）。だから外は好きなだけ増やせる。 */
    const treeNear = q === 'low' ? 3000 : q === 'high' ? 8000 : 5000;
    const treeFar = q === 'low' ? 14000 : q === 'high' ? 52000 : 29000;
    const treeTarget = treeNear + treeFar;
    /* 岩は大きさで作りを分ける。
         大岩 水面をまたぐのでシルエットが景観に効く。3D + LOD
         中石 低ポリ 3D を InstancedMesh で撒く
         小石 近距離だけ 3D。遠くは地面テクスチャに任せる
       «全部テクスチャ» でも «全部ポリゴン» でもなく、大きさで分ける */
    const rockScale = q === 'low' ? 0.45 : q === 'high' ? 1 : 0.7;
    const ROCK = {
      boulder: Math.round(220 * rockScale),
      cobble: Math.round(900 * rockScale),
      pebble: Math.round(2600 * rockScale),
    };
    /* 水辺〜水中の植物。
       生育可能面積を実測すると ヨシ 5982 / マコモ 2780 / クロモ 10539 m2 で、
       1500 / 700 / 1900 株では 0.2 株/m2 ＝ 現実の 1/10 の疎さだった
       （実際のヨシ原は 50〜200 稈/m2、マコモも夏で 100〜200 芽/m2）。
       1 株が «葉の束を描いたカード» 3 枚 ＝ 12 三角なので、
       株密度を 1 桁上げても近景の面積ぶんしか増えない */
    const plantScale = q === 'low' ? 0.40 : q === 'high' ? 1 : 0.68;
    const PLANT = {
      reed: Math.round(14400 * plantScale),
      manomo: Math.round(3200 * plantScale),
      hydrilla: Math.round(16000 * plantScale),
    };

    /* --- 木（ブナ・スギ） ---
       円柱＋円錐をやめ、骨格から起こした枝と葉カードにする。
       近景 / 中景 / 遠景インポスターの 3 段を種 × バリエーションごとに
       持ち、カメラ距離で振り分ける（trees.js / treeSkeleton.js） */
    this.treeSet = new TreeSet(this.scene, {
      leafTextures: this._leafTextures,
      quality: q,
      renderer: this._renderer,
      seed: this.seed ^ 0x7ee5,
      addWindSway,
      capacity: Math.ceil(treeNear / SPECIES_IDS.length / TREE_VARIANTS) + 60,
    });

    // 岩・葦の配置でも使い回すスクラッチ
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const qt = new THREE.Quaternion();
    const s = new THREE.Vector3();

    /* 山は森林限界より «下» なので、頂上まで木を生やす。
       以前は標高 66m で打ち切っていて、陸の 66% が丸ごと裸だった。
       半径も 370m までしか撒いておらず、その外の 58ha が空だった。 */
    const TREE_R_MAX = 715;   // 地形の外周（720m）まで

    /* 歩ける帯からの距離を見積もる。
       帯は «汀線 −10m 〜 +WALK_INLAND» の環なので、木から一番近い帯の点は
       だいたい同じ角度の外縁にある。ただし汀線は 116〜153m と波打っている
       ので、前後 40° のうち «一番外へ張り出した汀線» を使って距離を短めに
       見積もる。短めに出す＝静的にする木を減らす方向なので、間違って
       «近づけるのに遠景のまま» になることはない。 */
    const SHORE_N = 360;
    const shoreTab = new Float32Array(SHORE_N);
    for (let i = 0; i < SHORE_N; i++) {
      const a = (i / SHORE_N) * TAU;
      shoreTab[i] = this.shoreRadius(Math.cos(a) * 150, Math.sin(a) * 150);
    }
    const WIN = 40;                       // ±40 サンプル ＝ ±40°
    const shoreMaxNear = (ang) => {
      const c = Math.round((((ang % TAU) + TAU) % TAU) / TAU * SHORE_N);
      let m = 0;
      for (let k = -WIN; k <= WIN; k++) {
        const v = shoreTab[((c + k) % SHORE_N + SHORE_N) % SHORE_N];
        if (v > m) m = v;
      }
      return m;
    };
    /* 最終段のしきい値より遠ければ、どう歩いても遠景のまま。
       クロスフェードの帯ぶんだけ余裕を足す */
    const FAR_GATE = TREE_LOD_DIST[TREE_LOD_DIST.length - 1] + TREE_FADE_BAND + 12;

    let near = 0, far = 0, tries = 0;
    while ((near < treeNear || far < treeFar) && tries < treeTarget * 24) {
      tries++;
      const ang = rng() * TAU;
      const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
      const rMin = rr + 5;
      /* 半径で一様に取ると内側に偏るので、面積で一様になるよう平方根で引く。
         そのうえで手前をわずかに厚くして、湖から見たときの «林縁の壁» を作る */
      const u = Math.pow(rng(), 0.88);
      const dist = Math.sqrt(rMin * rMin + u * (TREE_R_MAX * TREE_R_MAX - rMin * rMin));
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const h = this.heightAt(x, z);
      if (h < 1.6) continue;
      // 崖には生えない。ただし «岩がちの尾根» に少しは残したいので緩めに切る
      if (this.slopeAt(x, z) > 0.78) continue;
      if (this.distToDock(x, z) < 3.6) continue;
      if (Math.hypot(x - this.spawnPos.x, z - this.spawnPos.z) < 6) continue;

      /* 樹種の分布：スギは沢筋〜低い斜面に群れ、ブナは尾根側。
         参考 preset の closed-canopy 構成を、2 種の世界で近似する。
         完全なランダムだと «植えた林» に見えるので、多段ノイズで塊と空明を作る */
      const forestCoarse = this.noise.fbm(x * 0.009, z * 0.009, 3);
      const forestFine = this.noise.fbm(x * 0.038 + 11.3, z * 0.038 - 11.3, 2);
      const forestField = forestCoarse * 0.58 + forestFine * 0.42;
      if (forestField < -0.07) continue;   // 空明（gapRate 相当）
      const cluster = this.noise.fbm(x * 0.015 + 3.1, z * 0.015 - 3.1, 2);
      if (cluster < -0.14 && rng() > 0.38) continue;

      const patch = this.noise.fbm(x * 0.011, z * 0.011, 2);
      const valley = clamp01(0.70 - (h - 6) / 50) * 0.88;
      const cedarBias = valley + patch * 0.16;
      const kind = (patch * 0.5 + 0.5) < cedarBias + (rng() - 0.5) * 0.20 ? 'cedar' : 'beech';
      const va = Math.floor(rng() * TREE_VARIANTS);

      // 樹高（m）。高いところほど風衝で低く。若木・古木の段を混ぜる
      const alt = clamp01(h / 150);
      let height = kind === 'cedar'
        ? lerp(16, 30, rng()) * lerp(1, 0.58, alt)
        : lerp(11, 22, rng()) * lerp(1, 0.62, alt);
      const tierRoll = rng();
      if (tierRoll < 0.20) height *= lerp(0.30, 0.48, rng());
      else if (tierRoll > 0.90) height *= lerp(1.08, 1.30, rng());

      const toBand = dist - shoreMaxNear(ang) - WALK_INLAND;
      if (toBand > FAR_GATE) {
        // 絶対に近づけない＝ずっと遠景。毎フレームの計算から外す
        if (far >= treeFar) continue;
        this.treeSet.addFar(x, h - 0.15, z, height, kind, va, rng() * TAU);
        far++;
      } else {
        if (near >= treeNear) continue;
        this.treeSet.add(x, h - 0.15, z, height, kind, va, rng() * TAU);
        /* 幹の当たり判定。歩ける範囲の外はグリッドを太らせるだけなので入れない
           （半径は樹高から逆算する。ジオメトリは樹高 1 に正規化済み） */
        const trunkR = (this.treeSet.trunkR[kind] || 0.02) * height;
        this.addObstacle(x, z, Math.max(trunkR * 1.15, 0.28), h - 0.15 + height * 0.9);
        near++;
      }
    }
    this.treeSet.buildFar();
    this.treeCount = near + far;
    this.treeNearCount = near;
    this.treeFarCount = far;

    // 水面より上にしか存在しない物（水越しには絶対に写らないので、
    // 水中描画用のシーン取り込みでは省いて負荷を下げる）。
    // 岸の岩は水際にまたがって置かれる＝水中部分が見えるので入れない
    this.overWaterProps = this.treeSet.meshes.slice();
    // reedMat は後段（葦）で生成するので、ここでは葉だけ入れて後で追加する
    this.swayMaterials = this.treeSet.swayMaterials.slice();

    /* --- 岩（大岩・中石・小石） ---
       正二十面体 1 個をランダムスケールで撒くのをやめ、
       ノイズ変形 → 角の欠け → 熱侵食 → 窪み AO を通した形を
       種類ぶん焼いて置く（rocks.js / rockShape.js）。
       貼りは triplanar。岩に UV を張るとどこかで必ず伸びる */
    this.rockSet = new RockSet(this.scene, {
      quality: q,
      seed: this.seed ^ 0x40c7,
      causticsUniforms: this._causticsUniforms,
      addUnderwaterCaustics,
      /* 段ごとの枠。近景を広げたので、どの段にも «その階層の全数» が
         入りうる。溢れると黙って描かれなくなるので余裕を取る */
      capacity: {
        boulder: [150, 150, 150].map((n) => Math.ceil(n * rockScale)),
        cobble: [440, 440].map((n) => Math.ceil(n * rockScale)),
        pebble: [1200].map((n) => Math.ceil(n * rockScale)),
      },
    });

    /* 階層ごとの置き方。
       band  汀線からどこまで内外に散らすか（m）
       h     地面の高さの帯
       size  岩の高さ（m）
       水際に寄せるのは意図的。水面と交差する石は形そのものが効くので、
       ここに立体を集めると岸辺が «平坦» に見えなくなる */
    const ROCK_BANDS = [
      {
        tier: 'boulder', n: ROCK.boulder, inward: 26, outward: 12,
        // size は «岩のいちばん長い辺(m)»
        hMin: -2.6, hMax: 13, size: [1.1, 4.6], obstacle: true,
      },
      {
        tier: 'cobble', n: ROCK.cobble, inward: 18, outward: 9,
        hMin: -1.8, hMax: 6, size: [0.30, 1.05], obstacle: false,
      },
      {
        tier: 'pebble', n: ROCK.pebble, inward: 12, outward: 5,
        hMin: -1.1, hMax: 2.2, size: [0.08, 0.26], obstacle: false,
      },
      /* 林床の石。これまで岩は汀線 ±26m にしか無く、内陸へ歩くと
         地面に何も落ちていなかった。歩ける帯（+72m）とその見通しぶんを
         埋める。水際の «磨かれた丸石» とは違って苔むした転石なので、
         大きさの幅を広く取る */
      {
        tier: 'boulder', n: Math.round(ROCK.boulder * 1.1), inward: -8, outward: 130,
        hMin: 1.2, hMax: 999, size: [0.9, 3.4], obstacle: true,
      },
      {
        tier: 'cobble', n: Math.round(ROCK.cobble * 1.6), inward: -8, outward: 130,
        hMin: 1.2, hMax: 999, size: [0.22, 0.9], obstacle: false,
      },
    ];

    this.rockCounts = {};
    for (const b of ROCK_BANDS) {
      let placed = 0; tries = 0;
      while (placed < b.n && tries < b.n * 40) {
        tries++;
        const ang = rng() * TAU;
        const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
        const dist = rr + b.outward - rng() * (b.inward + b.outward);
        const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
        const h = this.heightAt(x, z);
        if (h < b.hMin || h > b.hMax) continue;
        if (this.distToDock(x, z) < 3.4) continue;
        // 小さい石ほど数が多く、大きい石は稀（べき乗で偏らせる）
        const size = lerp(b.size[0], b.size[1], Math.pow(rng(), 2.2));
        /* 少し埋める。地面にぴったり載せると «置いた» ように見えるが、
           埋めすぎると水際で石が消える */
        const sink = size * (0.10 + rng() * 0.16);
        const spread = { sx: 0.8 + rng() * 0.7, sz: 0.8 + rng() * 0.7 };
        this.rockSet.add(b.tier, x, h - sink, z, size, spread,
          (rng() * 5) | 0, rng() * TAU);
        if (b.obstacle && h > -0.9 && size > 1.4) {
          this.addObstacle(x, z, size * Math.max(spread.sx, spread.sz) * 0.42,
            h - sink + size * 0.70);
        }
        placed++;
      }
      this.rockCounts[b.tier] = placed;
    }

    /* --- 水中のストラクチャー（沈み岩・立ち枯れ） ---
       湖底に置いて、必ず水面より下に収める。糸は水面上を通るので
       キャストの邪魔にはならないが、水中カメラで見えて魚が付く */
    this.structures = [];
    {
      /* 沈み岩も岸の岩と同じ作り（triplanar / 窪み AO / 濡れ）にする。
         水面下なので «濡れ» は常に 1、苔は水面より上の条件で出ない */
      const sRockGeo = makeSingleRock('boulder', this.seed ^ 0x9a17, 2);
      const sRockMat = this.rockSet.mats.boulder;
      const sRocks = new THREE.InstancedMesh(
        sRockGeo, sRockMat, Math.max(1, this.lake.structures.length * 3)
      );
      sRocks.receiveShadow = true;
      const snagMat = addUnderwaterCaustics(new THREE.MeshStandardMaterial({
        color: 0x5c4a36, roughness: 1, flatShading: true,
      }), this._causticsUniforms, 'snag-wood-caustics-v1');
      const snagTipMat = addUnderwaterCaustics(new THREE.MeshStandardMaterial({
        color: 0x3d342a, roughness: 1, flatShading: true,
      }), this._causticsUniforms, 'snag-tip-caustics-v1');
      const snagRoot = new THREE.Group();
      snagRoot.name = 'snags';
      let si = 0;
      for (const t of this.lake.structures) {
        const bedY = this.heightAt(t.x, t.z);
        if (t.kind === 'rock') {
          // 3 つの岩を寄せて 1 つのシモリにする
          for (let k = 0; k < 3; k++) {
            const ox = (k === 0 ? 0 : (k === 1 ? 1 : -1)) * t.r * 0.75;
            const oz = (k === 0 ? 0 : (k === 1 ? -1 : 1)) * t.r * 0.55;
            const sc = t.r * (k === 0 ? 1 : 0.62) * (0.85 + t.v * 0.3);
            /* 岩の原点は底面中央なので、湖底の高さへそのまま置く
               （中心原点の頃は sc*0.35 だけ持ち上げていた）。
               Y 軸まわりだけ回す。倒すと底面が浮いて «宙に浮いた岩» になる */
            qt.setFromAxisAngle(UP, t.rot * 2.3 + k);
            p.set(t.x + ox, bedY - sc * 0.10, t.z + oz);
            s.set(sc * 1.35, sc * (0.75 + t.v * 0.4), sc * 1.35);
            m.compose(p, qt, s);
            if (si < sRocks.count) sRocks.setMatrixAt(si++, m);
          }
        } else {
          snagRoot.add(makeSnagGroup(t, bedY, snagMat, snagTipMat));
        }
        // 当たり判定（上端は水面下なので、糸には掛からない＝キャストの邪魔をしない）
        this.addObstacle(t.x, t.z, t.r * 1.15, bedY + t.h);
        this.structures.push({ x: t.x, z: t.z, kind: t.kind, r: t.r, top: bedY + t.h, depth: t.depth });
      }
      sRocks.count = si;
      sRocks.instanceMatrix.needsUpdate = true;
      this.scene.add(sRocks, snagRoot);
    }

    /* --- 水辺〜水中の植物（ヨシ・マコモ・クロモ） ---
       円錐 1 個の «葦» をやめ、種ごとに株を組んで生やす。
       水深の帯で棲み分けさせ、さらにノイズで «群落» に固める。
       等確率で撒くと岸をぐるりと均一に縁取って、植えた花壇に見える */
    this.waterPlants = new WaterPlants(this.scene, {
      quality: q,
      seed: this.seed ^ 0x2f19,
      /* 段ごとの枠。近景は «汀線から半径 16m の帯» にしか入らないので、
         遠景と同じ枠を確保すると丸ごと無駄になる */
      capacity: {
        reed: [900, 1800, 9000].map((n) => Math.ceil(n * plantScale)),
        manomo: [320, 720, 2600].map((n) => Math.ceil(n * plantScale)),
        hydrilla: [1100, 9000].map((n) => Math.ceil(n * plantScale)),
      },
      addWindSway,
      addUnderwaterCaustics,
      patchUwMaterial,
      causticsUniforms: this._causticsUniforms,
    });

    const BANDS = [
      /* kind, 目標数, 汀線からどこまで内側を探すか(m), 地面の高さの帯,
         株の高さ(m), 群落ノイズのしきい値と種 */
      { kind: 'reed', n: PLANT.reed, reach: 20, hMin: -0.95, hMax: 0.45, s0: 1.7, s1: 3.1, thr: -0.10, salt: 11.3 },
      { kind: 'manomo', n: PLANT.manomo, reach: 28, hMin: -1.30, hMax: -0.06, s0: 1.0, s1: 1.7, thr: 0.10, salt: -37.7 },
      // クロモは株を小さく（実物の葉 5〜20mm に見合う大きさ）、そのぶん数を増やす
      { kind: 'hydrilla', n: PLANT.hydrilla, reach: 95, hMin: -4.60, hMax: -0.60, s0: 0.35, s1: 0.95, thr: -0.20, salt: 61.9 },
    ];

    this.plantCounts = {};
    for (const b of BANDS) {
      let placed = 0; tries = 0;
      while (placed < b.n && tries < b.n * 40) {
        tries++;
        const ang = rng() * TAU;
        const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
        const dist = rr + 1.5 - Math.pow(rng(), 0.75) * b.reach;
        const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
        const h = this.heightAt(x, z);
        if (h < b.hMin || h > b.hMax) continue;
        if (this.slopeAt(x, z) > 1.15) continue;
        if (this.distToDock(x, z) < 2.4) continue;   // 板を突き抜けないように
        // 群落：同じ種は塊で生える。種ごとに salt を変えて場所をずらす
        if (this.noise.fbm(x * 0.042 + b.salt, z * 0.042 - b.salt, 2) < b.thr) continue;
        // 小さい株がやや多い（群落の縁は背が低い）
        const sc = lerp(b.s0, b.s1, Math.pow(rng(), 1.35));
        this.waterPlants.add(b.kind, x, h, z, sc, (rng() * 3) | 0, rng() * TAU);
        placed++;
      }
      this.plantCounts[b.kind] = placed;
    }
    this.swayMaterials.push(...this.waterPlants.swayMaterials);
    this._buildUndergrowth(q);
  }

  /**
   * 下草の塊マスク。参考 foliageSpecies の clumping / patchScale を
   * 既存の fbm ノイズで近似する。
   */
  _underClumpMask(x, z, clumping, patchScale, salt = 0) {
    const s = Math.max(0.004, patchScale * 0.011);
    const coarse = this.noise.fbm(x * s + salt, z * s - salt, 3);
    const fine = this.noise.fbm(x * s * 2.6 + salt * 1.9, z * s * 2.6 - salt * 1.9, 2);
    return coarse * (0.52 + clumping * 0.48) + fine * (0.48 - clumping * 0.28);
  }

  /**
   * 下草（低木・シダ・草の塊）。
   *
   * 木をいくら増やしても «森の中» には見えない。目の高さから下が空で、
   * 地面と幹の境目がそのまま見えているからで、そこを埋めるのがこの層。
   * 描かれるのは 48m まで（それより遠い株は段を持たない）なので、
   * 撒くのも汀線まわりの帯だけでいい。
   */
  _buildUndergrowth(q) {
    const scale = q === 'low' ? 0.35 : q === 'high' ? 1 : 0.62;
    /* 描画中 1063 株のとき GPU への上乗せは 0.1ms（計測誤差）だった。
       «森の中» に見せるには株の間隔を 2m くらいまで詰める必要があるので、
       ここは思い切って増やす */
    const want = {
      moss: Math.round(9000 * scale),
      herb: Math.round(21000 * scale),
      rush: Math.round(4800 * scale),
      fern: Math.round(5200 * scale),
      bracken: Math.round(2600 * scale),
      bush: Math.round(2600 * scale),
      bramble: Math.round(1400 * scale),
    };
    this.undergrowth = new Undergrowth(this.scene, {
      seed: this.seed ^ 0x3a91,
      addWindSway,
      capacity: {
        moss: [Math.round(2200 * scale), Math.round(7200 * scale)],
        herb: [Math.round(2200 * scale), Math.round(7800 * scale)],
        rush: [Math.round(700 * scale), Math.round(2400 * scale)],
        fern: [Math.round(750 * scale), Math.round(2500 * scale)],
        bracken: [Math.round(420 * scale), Math.round(1400 * scale)],
        bush: [Math.round(380 * scale), Math.round(1200 * scale)],
        bramble: [Math.round(220 * scale), Math.round(720 * scale)],
      },
    });
    const rng = makeRng(this.seed ^ 0x5c2e);
    const KIND_SALT = {
      moss: 0, herb: 19.3, rush: 41.7, fern: 31.7, bracken: 58.2, bush: 64.3, bramble: 77.1,
    };
    this.undergrowthCounts = {};
    for (const kind of Object.keys(want)) {
      const cfg = UNDER_KINDS[kind];
      const salt = KIND_SALT[kind] ?? 0;
      /* clumping が高い種ほどしきい値を上げ、塊の中だけ連続させる */
      const thr = lerp(-0.52, 0.06, cfg.clumping);
      let placed = 0;
      for (let i = 0; i < want[kind] * 8 && placed < want[kind]; i++) {
        const ang = rng() * TAU;
        const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
        const dist = rr - 8 + rng() * 138;
        const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
        const h = this.heightAt(x, z);
        if (h < 0.9 || this.slopeAt(x, z) > 0.9) continue;
        if (this.distToDock(x, z) < 2.6) continue;
        const clump = this._underClumpMask(x, z, cfg.clumping, cfg.patchScale, salt);
        if (clump < thr) continue;
        /* 種ごとの生育帯。苔は日陰寄り、ワラビは空明寄り */
        const shade = clamp01(1 - h / 95);
        if (kind === 'moss' && shade < 0.22 && rng() > 0.35) continue;
        if (kind === 'bracken' && clump > 0.38 && rng() > 0.55) continue;
        if (kind === 'bramble' && clump < -0.05 && rng() > 0.45) continue;
        const height = lerp(cfg.height[0], cfg.height[1], Math.pow(rng(), 1.2));
        this.undergrowth.add(kind, x, h - 0.04, z, height,
          (rng() * 3) | 0, rng() * TAU);
        placed++;
      }
      this.undergrowthCounts[kind] = placed;
    }

    /* 歩ける範囲の境目に藪を植える。
       見えない壁で止められるより «茂みで進めない» ほうが納得できる。
       当たり判定を持たせてあるので、実際にはこの藪で止まって、
       _tryMove の線は保険として後ろに控える形になる */
    {
      const want = Math.round(3200 * scale);
      let placed = 0;
      for (let i = 0; i < want * 5 && placed < want; i++) {
        const ang = rng() * TAU;
        const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
        const dist = rr + WALK_INLAND - 5 + rng() * 9;
        const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
        const h = this.heightAt(x, z);
        if (h < 0.9 || this.slopeAt(x, z) > 1.2) continue;
        const height = lerp(1.25, 2.1, Math.pow(rng(), 0.8));
        this.undergrowth.add('bush', x, h - 0.04, z, height, (rng() * 3) | 0, rng() * TAU);
        this.addObstacle(x, z, 0.55, h + height * 0.8);
        placed++;
      }
      this.undergrowthCounts.thicket = placed;
    }

    this.overWaterProps.push(...this.undergrowth.meshes);
    this.swayMaterials.push(...this.undergrowth.swayMaterials);
  }

  /** 夜間の灯り更新 */
  updateLamp(nightAmount, dt) {
    const target = nightAmount;
    this.lampMat.emissiveIntensity = lerp(this.lampMat.emissiveIntensity, target * 2.4, 0.06);
    this.lampLight.intensity = lerp(this.lampLight.intensity, target * 26, 0.06);
  }

  /** 風揺れの時刻を進める（windPow: 雨天ほど強く） */
  updateWind(time, windPow = 1) {
    if (this.swayMaterials) tickVegetationWind(this.swayMaterials, time * 1.0, windPow);
  }

  /**
   * 近景の範囲を一括で伸縮する（負荷の確認用）。
   *
   * すべての LOD しきい値に scale を掛ける。1 が既定、2 で «近景の半径 2 倍
   * ＝ 面積 4 倍»。段の枠（capacity）は既定値のまま増えないので、
   * 大きくしすぎると溢れたぶんは黙って描かれなくなる。
   *
   *   __game.terrain.setLodScale(1.5)
   *   __game.perf.getSnapshot(__game)   // fps / frameMs / cpuMs / gpuMs
   *
   * @param {number} scale
   */
  setLodScale(scale = 1) {
    const k = Math.max(0.1, Math.min(4, scale));
    const sets = [];
    if (this.treeSet) sets.push(this.treeSet);
    for (const s of [this.waterPlants?.emergent, this.waterPlants?.submerged, this.undergrowth?.set]) {
      if (s) sets.push(s);
    }
    for (const s of Object.values(this.rockSet?.sets || {})) sets.push(s);
    for (const set of sets) {
      if (!set._lodBase) set._lodBase = [...set.lodDist];
      for (let i = 0; i < set.lodDist.length; i++) set.lodDist[i] = set._lodBase[i] * k;
      set._dirty = true;
    }
    this.lodScale = k;
    return k;
  }

  /** 木・水辺の植物・岩の LOD をカメラ距離で振り直す（変化時だけ作り直す） */
  updateTrees(dt, cameraPos) {
    this.treeSet?.update(dt, cameraPos);
    this.waterPlants?.update(dt, cameraPos);
    this.undergrowth?.update(dt, cameraPos);
    this.rockSet?.update(dt, cameraPos);
  }
}
