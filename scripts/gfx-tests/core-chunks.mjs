#!/usr/bin/env node
/* ===========================================================
   core-chunks（ARCHITECTURE §9-8）
   vendored three を Node で読み、ShaderChunk / ShaderLib の差し替えの前提を固定する：
   - ngExtendStandard のアンカーが physical / depth / distance に存在する
   - fog チャンクの差し替えと、fogColor を持つ全 ShaderLib への ngFrame と NG_FRAME
   - cloneUniforms / mergeUniforms が Float32Array を参照のまま保つ
   - installNg は冪等（2 回目で文字列が二重にならない）
   - 全体チャンクが宣言する識別子は ng / NG_ 接頭辞だけ。魚の名前（uCaust* 等）を宣言しない
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const THREE = await import(pathToFileURL(path.join(ROOT, 'vendor/three.module.min.js')).href);
const { installNg, ngChunkPatches, NG_EXTEND_ANCHORS: A, NG_LIGHTS_ANCHOR, NG_LIGHTS_RE_DIRECT } = await import(pathToFileURL(path.join(ROOT, 'src/gfx/core/chunks.js')).href);
const { ngFrameData } = await import(pathToFileURL(path.join(ROOT, 'src/gfx/core/frame.js')).href);

const SC = THREE.ShaderChunk, SL = THREE.ShaderLib;
const orig = {};
for (const k of ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment', 'lights_fragment_begin']) orig[k] = SC[k];

/* アンカー（差し替え前の vendored の文字列に対して） */
for (const [k, a] of Object.entries(A.vertex)) check(SL.physical.vertexShader.includes(a), `physical の頂点に ${k} のアンカー ${a}`);
for (const [k, a] of Object.entries(A.fragment)) check(SL.physical.fragmentShader.includes(a), `physical の断片に ${k} のアンカー ${a}`);
check(SL.physical.vertexShader.includes(A.main) && SL.physical.fragmentShader.includes(A.main), 'main のアンカー');
for (const lib of ['depth', 'distanceRGBA']) {
  for (const a of Object.values(A.depthVertex)) check(SL[lib].vertexShader.includes(a), `${lib} の頂点に ${a}`);
  for (const a of Object.values(A.depthFragment)) check(SL[lib].fragmentShader.includes(a), `${lib} の断片に ${a}`);
  check(SL[lib].vertexShader.includes(A.main), `${lib} の main`);
}
const dirBlock = orig.lights_fragment_begin.slice(orig.lights_fragment_begin.indexOf('NUM_DIR_LIGHTS > 0'));
check(dirBlock.includes(NG_LIGHTS_ANCHOR) && dirBlock.includes(NG_LIGHTS_RE_DIRECT), 'lights_fragment_begin の平行光ブロックのアンカー');
for (const k of ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment']) {
  for (const lib of ['standard', 'physical', 'lambert', 'basic']) {
    const src = k.endsWith('vertex') ? SL[lib].vertexShader : SL[lib].fragmentShader;
    check(src.includes(`#include <${k}>`), `${lib} が ${k} を含む`);
  }
}

/* 差し替え */
const state = installNg(THREE);
check(state.installed && state.lightsHook, 'installNg が入り、lights のフックも入った');
const again = installNg(THREE);
check(again === state, 'installNg は冪等（同じ状態を返す）');
const fogLibs = Object.keys(SL).filter((k) => SL[k].uniforms?.fogColor);
for (const k of ['basic', 'lambert', 'phong', 'standard', 'physical', 'toon', 'matcap', 'points', 'dashed', 'sprite']) {
  check(fogLibs.includes(k), `${k} は fogColor を持つ`);
}
for (const k of fogLibs) {
  check(SL[k].uniforms.ngFrame?.value === ngFrameData, `${k}.uniforms.ngFrame が共有配列`);
  check(SL[k].vertexShader.startsWith('#define NG_FRAME\n') && SL[k].fragmentShader.startsWith('#define NG_FRAME\n'), `${k} に NG_FRAME`);
  check(!SL[k].vertexShader.slice(1).includes('#define NG_FRAME'), `${k} の NG_FRAME が二重でない`);
}
check(SC.fog_fragment.includes('ngApplyMedium') && SC.fog_fragment.includes('#ifdef NG_FRAME'), 'fog_fragment は NG_FRAME のときだけ媒質');
check(SC.fog_fragment.includes('fogFactor'), 'fog_fragment の NG_FRAME 以外は元の線形霧');
check(SC.fog_vertex.includes('vNgWorld = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz'), 'fog_vertex が世界座標を渡す');
check(SC.lights_fragment_begin.includes('ngCloudShadow( vNgWorld ) * ngHfShadowAnalytic( vNgWorld )'), 'lights のフック');
check((SC.lights_fragment_begin.match(/UNROLLED_LOOP_INDEX == 0/g) || []).length === 2, 'フックは平行光 0 番だけ');

/* cloneUniforms は Float32Array を参照のまま（組込みマテリアルの共有の前提） */
const cl = THREE.UniformsUtils.clone(SL.physical.uniforms);
check(cl.ngFrame.value === ngFrameData, 'UniformsUtils.clone が Float32Array を参照で保つ');
const mg = THREE.UniformsUtils.merge([SL.standard.uniforms, { x: { value: 1 } }]);
check(mg.ngFrame.value === ngFrameData, 'UniformsUtils.merge も参照で保つ');
check(ngFrameData[0] === ngFrameData[0], 'ngFrame の先頭が NaN でない');

/* 全体チャンクの識別子（差し替えで足した部分だけを検査する） */
const patches = ngChunkPatches(orig);
/* 行単位の差分：差し替え後にだけある行 */
const added = Object.entries(patches).map(([k, v]) => {
  const have = new Set(orig[k].split('\n').map((l) => l.trim()));
  return v.split('\n').filter((l) => !have.has(l.trim())).join('\n');
}).join('\n');
const FORBIDDEN = /\b(uCaust\w*|causticLight|cs[A-Z]\w*|csWave\w*|vFishWorldPos|uTime|uAmp|uFreq|uLen|uBend)\b/;
check(!FORBIDDEN.test(added), `全体チャンクに魚の名前が無い（${(added.match(FORBIDDEN) || [])[0] || ''}）`);
const bad = globalDeclarations(added).filter((n) => !/^(ng|NG_|vNg)/.test(n));   // varying は vNg（§4.2 の vNgWorld）
check(bad.length === 0, `全体チャンクの宣言は ng 接頭辞だけ: ${bad.join(', ')}`);
const guards = (added.match(/#ifndef NG_LIB_\w+/g) || []).length;
check(guards >= 3, `GLSL ライブラリにインクルードガード（${guards}）`);

done('core-chunks');

/* GLSL の «トップレベル» の宣言名（関数・uniform・varying・const・変数・#define）を拾う */
function globalDeclarations(src) {
  const names = [];
  const lines = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('\n');
  const body = [];
  for (const l of lines) {
    const t = l.trim();
    const m = t.match(/^#define\s+(\w+)/);
    if (m) names.push(m[1]);
    if (!t.startsWith('#')) body.push(l);
  }
  const text = body.join('\n');
  let depth = 0, stmt = '';
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) pushDecl(stmt, names, true);
      depth++; stmt = '';
    } else if (ch === '}') {
      depth--; stmt = '';
    } else if (ch === ';' && depth === 0) {
      pushDecl(stmt, names, false); stmt = '';
    } else if (depth === 0) stmt += ch;
  }
  return names;
}
function pushDecl(stmt, names, isFn) {
  const s = stmt.replace(/\s+/g, ' ').trim();
  if (!s) return;
  if (isFn) {
    const m = s.match(/(\w+)\s*\(/);
    if (m && !['if', 'for', 'while'].includes(m[1])) names.push(m[1]);
    return;
  }
  if (/\(/.test(s) && !/=/.test(s)) { const m = s.match(/(\w+)\s*\(/); if (m) names.push(m[1]); return; }   // 前方宣言
  const m = s.replace(/\b(uniform|varying|const|highp|mediump|lowp|in|out|flat)\b/g, '').trim().match(/^\w+\s+(\w+)/);
  if (m) names.push(m[1]);
}
