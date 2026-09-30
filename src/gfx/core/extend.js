/* ===========================================================
   マテリアルの拡張（ARCHITECTURE §4.4）
   -----------------------------------------------------------
   ngExtendStandard：MeshStandard/Physical に «決まった口» からだけ GLSL を差し込む。
     three の光・影・霧（= ngApplyMedium）はそのまま効くので、地形も木も
     釣り人と同じ光と空気の中に居る。
   ngShaderMaterial：水・空・粒子のような自前シェーダ。lights / fog / GLSL ES 3.00 / NG_FRAME 付き。
   - アンカーが無ければ «構築時に» 例外（フレーム中は投げない）。ファサードがスタブへ切り替える
   - customProgramCacheKey = 'ng:' + key + ':' + tier（+ defines の指紋）。
     同じ key のマテリアルは同じ GLSL であること（key でプログラムを共有する）
   - シェーダ先頭に «// ngmod:<module>:<key>» を入れ、onShaderError で出どころを特定する
   - 品質の差は uniform とループ上限で出す（define を増やすとプログラムが増える）
   =========================================================== */
import * as THREE from 'three';
import { ngFrameData, NG_FRAME_GLSL } from './frame.js';
import { NG_MEDIUM_GLSL } from './glsl/medium.glsl.js';
import { NG_SHADOW_GLSL } from './glsl/shadow.glsl.js';
import { NG_EXTEND_ANCHORS as A } from './chunks.js';
import { NG_MODULE_TAG } from './safe.js';
import { CAUSTICS_GLSL } from '../../shaders.js';

/**
 * 拡張が参照する共有の口（gfx が起動時に埋める）。
 * caustics：causticsUniforms、shadow：高さ場影の uniforms、tier：現在の品質、lightsHook：ngNearVis の有無
 */
export const ngExtendContext = {
  caustics: null,
  shadowUniforms: null,
  tier: 'mid',
  lightsHook: true,
};

const STD = () => THREE.ShaderLib.physical;

function assertAnchors(src, anchors, where, keys) {
  for (const k of keys) {
    const a = anchors[k];
    if (!src.includes(a)) throw new Error(`[ng] ${where} にアンカー «${a}» が無い（three の版が変わった？）`);
  }
}

function definesGLSL(defines) {
  if (!defines) return '';
  return Object.entries(defines).map(([k, v]) => `#define ${k} ${v === true ? '' : v}`).join('\n') + '\n';
}

function insertAfter(src, anchor, code) {
  return code ? src.replace(anchor, `${anchor}\n${code}\n`) : src;
}
function insertBefore(src, anchor, code) {
  return code ? src.replace(anchor, `${code}\n${anchor}`) : src;
}

/**
 * MeshStandardMaterial / MeshPhysicalMaterial に ng の口を足す
 * @param {THREE.MeshStandardMaterial} mat
 * @param {{
 *   key:string, module?:string, uniforms?:object, defines?:object,
 *   vertex?:{pars?:string, begin?:string, normal?:string, world?:string},
 *   fragment?:{pars?:string, surface?:string, alpha?:string, normal?:string, rough?:string, ao?:string, emissive?:string, lights?:string},
 *   caustics?:boolean, depth?:boolean, hfShadow?:boolean
 * }} spec
 *   vertex.begin は begin_vertex の後（transformed を編集）、normal は beginnormal_vertex の後（objectNormal）、
 *   world は worldpos_vertex の後（worldPosition。影のあるとき定義される）。
 *   fragment.surface は map_fragment の後（diffuseColor）、alpha は alphamap_fragment の後（alphaTest の前）、
 *   normal は normal_fragment_maps の後（normal はビュー空間）、rough / ao / emissive はそれぞれの後、
 *   lights は lights_fragment_end の後（reflectedLight に透過や空の鏡面を足す。ngNearVis が使える）。
 *   世界座標は vNgWorld（fog チャンクが渡す）。
 *   depth: true の影用は vertex の pars / normal / begin と fragment の pars / alpha だけを使う
 *   （depth のシェーダに worldpos_vertex は無い。影に効く変形は begin に書く）。
 * @returns {THREE.MeshStandardMaterial} mat
 */
export function ngExtendStandard(mat, spec) {
  if (!spec || !spec.key) throw new Error('[ng] ngExtendStandard: spec.key が必要');
  const vs = STD().vertexShader, fs = STD().fragmentShader;
  const v = spec.vertex || {}, f = spec.fragment || {};
  assertAnchors(vs, A.vertex, 'physical の頂点シェーダ', Object.keys(A.vertex).filter((k) => v[k]));
  assertAnchors(fs, A.fragment, 'physical の断片シェーダ', ['common', 'lights', ...Object.keys(A.fragment).filter((k) => f[k])]);
  if (!vs.includes(A.main) || !fs.includes(A.main)) throw new Error('[ng] main のアンカーが無い');
  const module = spec.module || 'core';
  const defs = { ...(spec.defines || {}) };
  if (spec.hfShadow) defs.NG_HF_SHADOW = true;
  const defTag = Object.keys(defs).length ? ':' + JSON.stringify(defs) : '';
  const head = `${NG_MODULE_TAG}${module}:${spec.key}\n#ifndef NG_FRAME\n#define NG_FRAME\n#endif\n${definesGLSL(defs)}`;
  const shared = { ngFrame: { value: ngFrameData } };
  const extra = spec.uniforms || {};

  mat.customProgramCacheKey = () => `ng:${spec.key}:${ngExtendContext.tier}${defTag}`;
  mat.userData.ngModule = module;
  mat.userData.ngKey = spec.key;
  /* プログラムの鍵に段が入る印。段を替えたら gfx が古い段のプログラムを手放す（_releaseStalePrograms） */
  mat.userData.ngTiered = true;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, extra);
    if (spec.hfShadow && ngExtendContext.shadowUniforms) Object.assign(shader.uniforms, ngExtendContext.shadowUniforms);
    const caustics = spec.caustics && ngExtendContext.caustics;
    if (caustics) Object.assign(shader.uniforms, caustics);
    let V = head + shader.vertexShader;
    V = insertBefore(V, A.main, v.pars ? NG_FRAME_GLSL + v.pars : '');
    V = insertAfter(V, A.vertex.begin, v.begin);
    V = insertAfter(V, A.vertex.normal, v.normal);
    V = insertAfter(V, A.vertex.world, v.world);
    let F = head + shader.fragmentShader;
    if (caustics) F = insertAfter(F, A.fragment.common, CAUSTICS_GLSL);
    const pars = (spec.hfShadow ? NG_SHADOW_GLSL : '') + (f.pars || '');
    F = insertBefore(F, A.main, pars);
    F = insertAfter(F, A.fragment.surface, f.surface);
    F = insertAfter(F, A.fragment.alpha, f.alpha);
    F = insertAfter(F, A.fragment.normal, f.normal);
    F = insertAfter(F, A.fragment.rough, f.rough);
    F = insertAfter(F, A.fragment.ao, f.ao);
    F = insertAfter(F, A.fragment.emissive, f.emissive);
    let lights = f.lights || '';
    if (caustics) {
      /* caustics は key の見え方（近景の影 × 高さ場影 × 雲影）で切る。桟橋の影で網目が欠ける。
         lights のフックが key に掛けた雲影 × 高さ場影（ngKeyVis）を使い回す（同じ値を 2 回計算しない） */
      const vis = ngExtendContext.lightsHook ? 'ngKeyVis * ngNearVis' : 'vNgCloud';
      lights += `\ntotalEmissiveRadiance += causticLight( vNgWorld, normal ) * ${vis};`;
    }
    F = insertAfter(F, A.fragment.lights, lights);
    shader.vertexShader = V;
    shader.fragmentShader = F;
  };
  mat.needsUpdate = true;
  if (spec.depth) {
    /* 影用は NG_HF_SHADOW を立てない（媒質ライブラリの前方宣言を宙に浮かせない） */
    const dHead = `${NG_MODULE_TAG}${module}:${spec.key}\n#ifndef NG_FRAME\n#define NG_FRAME\n#endif\n${definesGLSL(spec.defines)}`;
    buildDepthVariants(mat, spec, dHead, shared, extra);
  }
  return mat;
}

/* 影用のマテリアル：同じ頂点の変形とアルファ。vNgWorld はここで自前に渡す
   （depth / distance のシェーダは fog チャンクを含まない）。断片に入るのは
   frame・媒質（高さ場影は解析版）・hfShadow なら影のライブラリと f.pars だけ */
function buildDepthVariants(mat, spec, head, shared, extra) {
  const v = spec.vertex || {}, f = spec.fragment || {};
  const D = A.depthVertex, DF = A.depthFragment;
  for (const lib of [THREE.ShaderLib.depth, THREE.ShaderLib.distanceRGBA]) {
    assertAnchors(lib.vertexShader, D, 'depth の頂点シェーダ', ['begin', 'project']);
    if (f.alpha) assertAnchors(lib.fragmentShader, DF, 'depth の断片シェーダ', ['alpha']);
  }
  const defTag = spec.defines && Object.keys(spec.defines).length ? ':' + JSON.stringify(spec.defines) : '';
  const make = (m, kind) => {
    syncDepth(m, mat);
    m.customProgramCacheKey = () => `ng:${spec.key}:${kind}:${ngExtendContext.tier}${defTag}`;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared, extra);
      if (spec.hfShadow && ngExtendContext.shadowUniforms) Object.assign(shader.uniforms, ngExtendContext.shadowUniforms);
      let V = head + shader.vertexShader;
      V = insertBefore(V, A.main, NG_FRAME_GLSL + 'varying vec3 vNgWorld;\n' + (v.pars || ''));
      const pre = v.normal ? '#ifndef USE_DISPLACEMENTMAP\nvec3 objectNormal = vec3( normal );\n#endif\n' + v.normal : '';
      V = insertBefore(V, D.begin, pre);
      V = insertAfter(V, D.begin, v.begin);
      V = insertAfter(V, D.project, 'vNgWorld = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;');
      let F = head + shader.fragmentShader;
      const sh = spec.hfShadow ? NG_SHADOW_GLSL : '';
      F = insertBefore(F, A.main, NG_FRAME_GLSL + NG_MEDIUM_GLSL + sh + 'varying vec3 vNgWorld;\n' + (f.pars || ''));
      F = insertAfter(F, DF.alpha, f.alpha);
      shader.vertexShader = V;
      shader.fragmentShader = F;
    };
    return m;
  };
  mat.userData.ngDepth = make(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), 'depth');
  mat.userData.ngDistance = make(new THREE.MeshDistanceMaterial(), 'distance');
}

/* 影用のマテリアルへ、アルファに効く設定を写す（map を後から差し替えても影の抜けが一致する）。
   影マップは MSAA ではないので、alpha-to-coverage の段でも影は alphaTest で抜く（ngCutout が閾値を残す） */
function syncDepth(d, mat) {
  const test = mat.userData.ngDepthAlphaTest ?? mat.alphaTest;
  if (d.map !== mat.map || d.alphaMap !== mat.alphaMap || d.alphaTest !== test || d.alphaHash !== mat.alphaHash) {
    d.map = mat.map; d.alphaMap = mat.alphaMap; d.alphaTest = test; d.alphaHash = mat.alphaHash;
    d.needsUpdate = true;
  }
  d.side = mat.side;
}

/**
 * ngExtendStandard(depth: true) で作った影用マテリアルを mesh に付ける。
 * マテリアルの map / alphaMap / alphaTest / alphaHash / side を影用へ写し直す
 * （ngExtendStandard の後で map を差し替えたら、もう一度呼ぶ）
 * @param {THREE.Mesh} mesh
 * @returns {THREE.Mesh} mesh
 */
export function ngAttachDepth(mesh) {
  const m = mesh.material;
  if (m?.userData?.ngDepth) {
    syncDepth(m.userData.ngDepth, m);
    syncDepth(m.userData.ngDistance, m);
    mesh.customDepthMaterial = m.userData.ngDepth;
    mesh.customDistanceMaterial = m.userData.ngDistance;
  }
  return mesh;
}

/**
 * 切り抜き（葉・草のカード）の抜き方を品質に合わせる：MSAA のある段は alpha-to-coverage、
 * 無い段は alphaTest。どちらも define が変わるので、変わったときだけ needsUpdate（setQuality から呼ぶ）
 * @param {THREE.Material} mat
 * @param {{msaa:number}} profile quality.js のプロファイル
 * @param {number} [cutoff=0.5] alphaTest の閾値
 * @returns {THREE.Material} mat
 */
export function ngCutout(mat, profile, cutoff = 0.5) {
  const a2c = (profile?.msaa || 0) > 0;
  const test = a2c ? 0 : cutoff;
  mat.userData.ngDepthAlphaTest = cutoff;
  if (mat.alphaToCoverage !== a2c || mat.alphaTest !== test) {
    mat.alphaToCoverage = a2c;
    mat.alphaTest = test;
    mat.needsUpdate = true;
    if (mat.userData.ngDepth) { syncDepth(mat.userData.ngDepth, mat); syncDepth(mat.userData.ngDistance, mat); }
  }
  return mat;
}

/**
 * 自前シェーダ（lights: true / fog: true / GLSL ES 3.00 / NG_FRAME）。gl_FragColor に書く。
 * three の光・影のチャンク（lights_pars_begin, shadowmap_pars_* 等）を自分で #include して使う。
 * NG_FRAME_GLSL（両段）と NG_MEDIUM_GLSL（断片）は先頭に入っている
 * @param {{key:string, module?:string, uniforms?:object, vertexShader:string, fragmentShader:string,
 *          defines?:object, lights?:boolean, fog?:boolean} & object} opts 残りは ShaderMaterial へ
 * @returns {THREE.ShaderMaterial}
 */
export function ngShaderMaterial(opts) {
  const { key, module = 'core', uniforms = {}, vertexShader, fragmentShader, lights = true, fog = true, ...rest } = opts;
  if (!key) throw new Error('[ng] ngShaderMaterial: key が必要');
  const base = THREE.UniformsUtils.merge([lights ? THREE.UniformsLib.lights : {}, fog ? THREE.UniformsLib.fog : {}]);
  const u = Object.assign(base, uniforms, { ngFrame: { value: ngFrameData } });
  const head = `${NG_MODULE_TAG}${module}:${key}\n#define NG_FRAME\n${NG_FRAME_GLSL}`;
  /* glslVersion は指定しない：three が GLSL ES 3.00 で組み、gl_FragColor / varying / texture2D の互換を足す */
  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: head + vertexShader,
    fragmentShader: head + NG_MEDIUM_GLSL + fragmentShader,
    lights, fog, ...rest,
  });
  mat.userData.ngModule = module;
  mat.userData.ngKey = key;
  return mat;
}
