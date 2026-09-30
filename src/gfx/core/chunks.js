/* ===========================================================
   ShaderChunk / ShaderLib の差し替え（ARCHITECTURE §4.2）
   -----------------------------------------------------------
   組込みマテリアル（釣り人・魚を含む）を ng の «一つの光・一つの空気» に通す芯。
   - fog チャンク：NG_FRAME のときだけ ngApplyMedium。それ以外は元の線形霧
     （ngFrame を持たない他人の ShaderMaterial を壊さない）
   - lights_fragment_begin：key（平行光 0 番）に雲影と高さ場影を掛け、
     three の近景の影だけの比 ngNearVis を取り出す（caustics・透過が使う）
   - NG_FRAME の #define は ShaderLib の文字列の先頭と ng マテリアルにだけ入れる
   - 全体チャンクが宣言するのは ng / NG_ 接頭辞の識別子だけ（魚の uCaust* 等と衝突させない）
   three を import しない（THREE を引数で受ける。Node のテストから直接呼べる）
   =========================================================== */
import { NG_FRAME_GLSL, ngFrameData } from './frame.js';
import { NG_MEDIUM_GLSL } from './glsl/medium.glsl.js';

const STATE = Symbol.for('ng.chunks.state');

/** 平行光のループの中で差し込む位置（getDirectionalLightInfo の直後） */
export const NG_LIGHTS_ANCHOR = 'getDirectionalLightInfo( directionalLight, directLight );';
/** 平行光ブロックの RE_Direct（ここで影の掛かった後の色を読む） */
export const NG_LIGHTS_RE_DIRECT = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
const DIR_BLOCK_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';

/**
 * ngExtendStandard が使うアンカー（vendored の ShaderLib に存在することを Node テストが検査する）。
 * キーは spec の口の名前、値は «この行の直後に差し込む» 文字列
 */
export const NG_EXTEND_ANCHORS = Object.freeze({
  vertex: {
    begin: '#include <begin_vertex>',
    normal: '#include <beginnormal_vertex>',
    world: '#include <worldpos_vertex>',
  },
  fragment: {
    common: '#include <common>',
    surface: '#include <map_fragment>',
    alpha: '#include <alphamap_fragment>',
    normal: '#include <normal_fragment_maps>',
    rough: '#include <roughnessmap_fragment>',
    ao: '#include <aomap_fragment>',
    emissive: '#include <emissivemap_fragment>',
    lights: '#include <lights_fragment_end>',
  },
  /** pars を差し込む位置（この文字列の直前） */
  main: 'void main() {',
  /** depth: true の影用マテリアル（MeshDepthMaterial / MeshDistanceMaterial）の口 */
  depthVertex: { begin: '#include <begin_vertex>', project: '#include <project_vertex>' },
  depthFragment: { alpha: '#include <alphamap_fragment>' },
});

/** fog / lights の差し替え本体（installNg とテストが共有する） */
export function ngChunkPatches(orig) {
  const fogFrag = orig.fog_fragment.replace('#ifdef USE_FOG', '').replace(/#endif\s*$/, '');
  const lights = patchLights(orig.lights_fragment_begin);
  return {
    fog_pars_vertex: orig.fog_pars_vertex + `
#ifdef NG_FRAME
${NG_FRAME_GLSL}
varying vec3 vNgWorld;
#endif
`,
    fog_vertex: orig.fog_vertex + `
#ifdef NG_FRAME
	vNgWorld = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
#endif
`,
    fog_pars_fragment: orig.fog_pars_fragment + `
#ifdef NG_FRAME
${NG_FRAME_GLSL}
${NG_MEDIUM_GLSL}
varying vec3 vNgWorld;
#endif
`,
    fog_fragment: `#ifdef USE_FOG
#ifdef NG_FRAME
	gl_FragColor.rgb = ngApplyMedium( gl_FragColor.rgb, vNgWorld );
#else
${fogFrag}
#endif
#endif
`,
    lights_fragment_begin: lights,
  };
}

/* 平行光ブロックだけを対象に、アンカーの直後と RE_Direct の直前へ差し込む。
   見つからなければ null（installNg はフックを諦めて警告する。霧は生きる） */
function patchLights(src) {
  const s = src.indexOf(DIR_BLOCK_START);
  if (s < 0) return null;
  const e = src.indexOf('#pragma unroll_loop_end', s);
  const block = src.slice(s, e);
  if (e < 0 || !block.includes(NG_LIGHTS_ANCHOR) || !block.includes(NG_LIGHTS_RE_DIRECT)) return null;
  const patched = block
    .replace(NG_LIGHTS_ANCHOR, `${NG_LIGHTS_ANCHOR}
		#if defined( NG_FRAME ) && ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= ngCloudShadow( vNgWorld ) * ngHfShadowAnalytic( vNgWorld );
		ngKeyPreShadow = directLight.color;
		#endif`)
    .replace(NG_LIGHTS_RE_DIRECT, `#if defined( NG_FRAME ) && ( UNROLLED_LOOP_INDEX == 0 )
		ngNearVis = ngLuminance( ngKeyPreShadow ) > 1e-6 ? ngLuminance( directLight.color ) / ngLuminance( ngKeyPreShadow ) : 1.0;
		#endif
		${NG_LIGHTS_RE_DIRECT}`);
  return `#ifdef NG_FRAME
float ngNearVis = 1.0;
vec3 ngKeyPreShadow = vec3( 0.0 );
#endif
` + src.slice(0, s) + patched + src.slice(e);
}

/**
 * ShaderChunk と ShaderLib を差し替える（冪等）。
 * @param {typeof import('three')} THREE
 * @returns {{installed:boolean, degraded:string|null, lightsHook:boolean, libKeys:string[]}} 状態（同じオブジェクトを返し続ける）
 */
export function installNg(THREE) {
  const SC = THREE.ShaderChunk, SL = THREE.ShaderLib;
  if (SC[STATE]) return SC[STATE];
  const names = ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment', 'lights_fragment_begin'];
  const orig = Object.fromEntries(names.map((n) => [n, SC[n]]));
  const patch = ngChunkPatches(orig);
  const state = { installed: true, degraded: null, lightsHook: !!patch.lights_fragment_begin, libKeys: [], orig };
  for (const n of names) if (patch[n]) SC[n] = patch[n];
  if (!state.lightsHook) console.warn('[ng] lights_fragment_begin のアンカーが無いので雲影のフックを省略');
  for (const k of Object.keys(SL)) {
    const lib = SL[k];
    if (!lib.uniforms || !lib.uniforms.fogColor) continue;
    lib.uniforms.ngFrame = { value: ngFrameData };
    lib.vertexShader = '#define NG_FRAME\n' + lib.vertexShader;
    lib.fragmentShader = '#define NG_FRAME\n' + lib.fragmentShader;
    state.libKeys.push(k);
  }
  Object.defineProperty(SC, STATE, { value: state, enumerable: false });
  return state;
}

/**
 * 組込みを ng から外す（自己検査の失敗時）。ShaderLib の NG_FRAME を取り除くと
 * 組込みは元の THREE.Fog に戻る。差し替えたチャンクは NG_FRAME が無いと元と同じなので残す
 * （ngExtendStandard / ngShaderMaterial は自分で NG_FRAME を定義するので動き続ける）
 * @param {typeof import('three')} THREE
 * @param {string} reason
 */
export function degradeNg(THREE, reason) {
  const state = THREE.ShaderChunk[STATE];
  if (!state || state.degraded) return;
  for (const k of state.libKeys) {
    const lib = THREE.ShaderLib[k];
    lib.vertexShader = lib.vertexShader.replace(/^#define NG_FRAME\n/, '');
    lib.fragmentShader = lib.fragmentShader.replace(/^#define NG_FRAME\n/, '');
  }
  state.degraded = 'fog';
  console.warn('[ng] 組込みマテリアルの媒質を無効化（THREE.Fog に戻す）:', reason);
}

/**
 * 起動時の自己検査：MeshStandardMaterial を 1 枚、1×1 の RT へ実際に描き、
 * ngFrame が参照で共有されていること・リンクに成功したことを確かめる。
 * 失敗したら degradeNg。例外は投げない
 * @param {typeof import('three')} THREE
 * @param {import('three').WebGLRenderer} renderer
 * @returns {boolean} 合格なら true
 */
export function verifyNg(THREE, renderer) {
  const state = THREE.ShaderChunk[STATE];
  if (!state) return false;
  if (state.degraded) return false;
  const prevRT = renderer.getRenderTarget();
  const rt = new THREE.WebGLRenderTarget(1, 1);
  const mat = new THREE.MeshStandardMaterial();
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0, 1, 2);
  const light = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(light, new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat));
  const cam = new THREE.PerspectiveCamera();
  cam.position.z = 1;
  let reason = null;
  try {
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    const props = renderer.properties.get(mat);
    const prog = props.currentProgram;
    if (!props.uniforms || props.uniforms.ngFrame?.value !== ngFrameData) reason = 'ngFrame が参照で共有されていない';
    else if (!prog || (prog.diagnostics && !prog.diagnostics.runnable)) reason = 'プログラムのリンクに失敗';
    else {
      const gl = renderer.getContext();
      const fs = gl.getShaderSource(prog.fragmentShader) || '';
      if (!fs.includes('ngApplyMedium')) reason = 'fog チャンクの差し替えが効いていない';
    }
  } catch (e) {
    reason = '検査中の例外: ' + (e && e.message);
  } finally {
    renderer.setRenderTarget(prevRT);
    rt.dispose(); mat.dispose();
    scene.traverse((o) => o.geometry?.dispose());
  }
  if (reason) { degradeNg(THREE, reason); return false; }
  return true;
}
