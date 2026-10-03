/* ===========================================================
   ShaderChunk / ShaderLib の差し替え（ARCHITECTURE §4.2）
   -----------------------------------------------------------
   組込みマテリアル（釣り人・魚を含む）を ng の «一つの光・一つの空気» に通す芯。
   - fog チャンク：NG_FRAME のときだけ ngApplyMedium。それ以外は元の線形霧
     （ngFrame を持たない他人の ShaderMaterial を壊さない）
   - lights_fragment_begin：key（平行光 0 番）に雲影と高さ場影を掛け（その積が ngKeyVis）、
     three の近景の影だけの比 ngNearVis を取り出す（caustics・透過が使う）
   - shadowmap_pars_fragment：NG_FRAME のとき PCF を 3×3 テクセルの二次 B スプライン重み（9 回の読み）に
     差し替える（three の PCF は 17 回。近景の影は画面のほぼ全部の断片が払う。spikes.md S-3）
   - 雲影は頂点で 1 回だけ評価して vNgCloud で渡す（900m 規模の斑なので頂点の間隔で足りる。
     断片の 3 オクターブ × 4 ハッシュは全画面で ≈0.45ms。docs/nextgen/spikes.md S-3）
   - NG_FRAME の #define は ShaderLib の文字列の先頭と ng マテリアルにだけ入れる
   - 全体チャンクが宣言するのは ng / NG_ 接頭辞の識別子だけ（魚の uCaust* 等と衝突させない）
   three を import しない（THREE を引数で受ける。Node のテストから直接呼べる）
   =========================================================== */
import { NG_FRAME_GLSL, ngFrameData } from './frame.js';
import { NG_MEDIUM_GLSL, NG_CLOUD_GLSL } from './glsl/medium.glsl.js';

const STATE = Symbol.for('ng.chunks.state');

/** 平行光のループの中で差し込む位置（getDirectionalLightInfo の直後） */
export const NG_LIGHTS_ANCHOR = 'getDirectionalLightInfo( directionalLight, directLight );';
/** 平行光ブロックの RE_Direct（ここで影の掛かった後の色を読む） */
export const NG_LIGHTS_RE_DIRECT = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
const DIR_BLOCK_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
/** 影の読みの差し替え位置 1：getShadow の定義（この直前に ngShadowPCF を置く） */
export const NG_SHADOW_GETSHADOW = 'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {';
/** 影の読みの差し替え位置 2：getShadow の中の PCF の分岐（NG_FRAME の枝を頭に足す） */
export const NG_SHADOW_PCF_BRANCH = '#if defined( SHADOWMAP_TYPE_PCF )';

/* 3×3 テクセルの二次 B スプライン（重みの和は 1、テクセルの境で連続）の PCF。
   three の PCF（17 回の読み・半径で広げる）の約半分の読みで、縁が段にも縞にもならない。
   半影は約 1.5 テクセル（high 3072² ±48m で ≈5cm） */
const NG_PCF_GLSL = `
#ifdef NG_FRAME
	float ngShadowRow( sampler2D map, vec2 p, vec2 inv, vec3 wx, float z ) {
		return wx.x * texture2DCompare( map, p - vec2( inv.x, 0.0 ), z ) + wx.y * texture2DCompare( map, p, z )
			+ wx.z * texture2DCompare( map, p + vec2( inv.x, 0.0 ), z );
	}
	float ngShadowPCF( sampler2D map, vec2 size, vec2 uv, float z ) {
		vec2 t = uv * size, c = floor( t ), d = t - c - 0.5;
		vec2 w0 = 0.5 * ( 0.5 - d ) * ( 0.5 - d ), w1 = 0.75 - d * d, w2 = 0.5 * ( 0.5 + d ) * ( 0.5 + d );
		vec2 inv = 1.0 / size, p = ( c + 0.5 ) * inv;
		vec3 wx = vec3( w0.x, w1.x, w2.x );
		return w0.y * ngShadowRow( map, p - vec2( 0.0, inv.y ), inv, wx, z ) + w1.y * ngShadowRow( map, p, inv, wx, z )
			+ w2.y * ngShadowRow( map, p + vec2( 0.0, inv.y ), inv, wx, z );
	}
#endif
`;

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
  const shadow = patchShadow(orig.shadowmap_pars_fragment);
  return {
    shadowmap_pars_fragment: shadow,
    fog_pars_vertex: orig.fog_pars_vertex + `
#ifdef NG_FRAME
${NG_FRAME_GLSL}
${NG_CLOUD_GLSL}
varying vec3 vNgWorld;
varying float vNgCloud;
#endif
`,
    fog_vertex: orig.fog_vertex + `
#ifdef NG_FRAME
	vNgWorld = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
	vNgCloud = ngCloudShadow( vNgWorld );
#endif
`,
    fog_pars_fragment: orig.fog_pars_fragment + `
#ifdef NG_FRAME
${NG_FRAME_GLSL}
${NG_MEDIUM_GLSL}
varying vec3 vNgWorld;
varying float vNgCloud;
#endif
`,
    fog_fragment: `#ifdef USE_FOG
#ifdef NG_FRAME
	gl_FragColor.rgb = ngApplyMedium( gl_FragColor.rgb, vNgWorld );
#if defined( ALPHA_TO_COVERAGE )
	/* 反射の RT（MSAA なし）では a2c の a（縁で 0..1 に研いだ値）が «覆い» として残り、水が空と混ぜて
	   木の映りに縦の筋と白い粒が出た。反射のパスでは切り抜きを 0.5 で決めて a = 1 にする */
	if ( ngPassId > 0.5 && ngPassId < 1.5 ) { if ( gl_FragColor.a < 0.5 ) discard; gl_FragColor.a = 1.0; }
#endif
#else
${fogFrag}
#endif
#endif
`,
    lights_fragment_begin: lights,
  };
}

/* getShadow の前に ngShadowPCF を置き、PCF の分岐の頭に NG_FRAME の枝を足す。見つからなければ null（元の PCF のまま） */
function patchShadow(src) {
  const g = src.indexOf(NG_SHADOW_GETSHADOW);
  if (g < 0) return null;
  const b = src.indexOf(NG_SHADOW_PCF_BRANCH, g);
  if (b < 0) return null;
  return src.slice(0, g) + NG_PCF_GLSL + src.slice(g, b)
    + `#if defined( SHADOWMAP_TYPE_PCF ) && defined( NG_FRAME )
			shadow = ngShadowPCF( shadowMap, shadowMapSize, shadowCoord.xy, shadowCoord.z );
		#elif defined( SHADOWMAP_TYPE_PCF )` + src.slice(b + NG_SHADOW_PCF_BRANCH.length);
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
		ngKeyVis = vNgCloud * ngHfShadowAnalytic( vNgWorld );
		directLight.color *= ngKeyVis;
		ngKeyPreShadow = directLight.color;
		#endif`)
    .replace(NG_LIGHTS_RE_DIRECT, `#if defined( NG_FRAME ) && ( UNROLLED_LOOP_INDEX == 0 )
		ngNearVis = ngLuminance( ngKeyPreShadow ) > 1e-6 ? ngLuminance( directLight.color ) / ngLuminance( ngKeyPreShadow ) : 1.0;
		#endif
		${NG_LIGHTS_RE_DIRECT}`);
  return `#ifdef NG_FRAME
float ngNearVis = 1.0;
float ngKeyVis = 1.0;
vec3 ngKeyPreShadow = vec3( 0.0 );
#endif
` + src.slice(0, s) + patched + src.slice(e);
}

/**
 * ShaderChunk と ShaderLib を差し替える（冪等）。
 * @param {typeof import('three')} THREE
 * @returns {{installed:boolean, degraded:string|null, lightsHook:boolean, pcf:boolean, libKeys:string[]}} 状態（同じオブジェクトを返し続ける）
 */
export function installNg(THREE) {
  const SC = THREE.ShaderChunk, SL = THREE.ShaderLib;
  if (SC[STATE]) return SC[STATE];
  const names = ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment', 'lights_fragment_begin', 'shadowmap_pars_fragment'];
  const orig = Object.fromEntries(names.map((n) => [n, SC[n]]));
  const patch = ngChunkPatches(orig);
  const state = { installed: true, degraded: null, lightsHook: !!patch.lights_fragment_begin, pcf: !!patch.shadowmap_pars_fragment, libKeys: [], orig };
  for (const n of names) if (patch[n]) SC[n] = patch[n];
  if (!state.lightsHook) console.warn('[ng] lights_fragment_begin のアンカーが無いので雲影のフックを省略');
  if (!state.pcf) console.warn('[ng] shadowmap_pars_fragment のアンカーが無いので three の PCF のまま');
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
