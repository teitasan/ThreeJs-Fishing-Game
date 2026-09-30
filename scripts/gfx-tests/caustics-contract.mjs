#!/usr/bin/env node
/* ===========================================================
   caustics-contract（ARCHITECTURE §5.3 / §9-11、CONTRACT §4.5）
   - CAUSTICS_GLSL：causticLight の署名、16 個の uCaust* の宣言、sampler2DArray だけ、水上（y > −0.02）で 0
   - createCausticsUniforms：16 名ちょうど・{value}・既定値（uCaustWarp (1.15, 2.5)、uCaustFar (6, 20)）
   - uCaustTex は 1×1 の DataArrayTexture。焼き込みの差し込みでもオブジェクトは同じ（魚の参照が切れない）
   - 魚の注入の形（#include <common> の後）で ng のライブラリと名前が衝突しない
   =========================================================== */
import { withThree, check, done } from './lib/env.mjs';

withThree(import.meta.url);
const THREE = await import('three');
const { CAUSTICS_GLSL, CAUSTICS_UNIFORM_NAMES, createCausticsUniforms, updateCausticsTexture } = await import('../../src/shaders.js');
const { NG_MEDIUM_GLSL } = await import('../../src/gfx/core/glsl/medium.glsl.js');

check(/vec3\s+causticLight\s*\(\s*vec3\s+worldPos\s*,\s*vec3\s+viewNormal\s*\)/.test(CAUSTICS_GLSL), 'causticLight(vec3 worldPos, vec3 viewNormal)');
check(/worldPos\.y\s*>\s*-0\.02\)\s*return vec3\(0\.0\)/.test(CAUSTICS_GLSL), '水上（y > −0.02）は 0');
check(CAUSTICS_UNIFORM_NAMES.length === 16, '名前は 16 個');
for (const n of CAUSTICS_UNIFORM_NAMES) {
  check(new RegExp(`uniform\\s+[\\w\\s]*\\b${n}\\s*;`).test(CAUSTICS_GLSL), `${n} を宣言`);
}
const declared = [...CAUSTICS_GLSL.matchAll(/uniform\s+[\w\s]*?\b(uCaust\w+)\s*;/g)].map((m) => m[1]);
check(declared.length === 16 && new Set(declared).size === 16, `uCaust* はちょうど 16 個（${declared.length}）`);
check(/uniform\s+highp\s+sampler2DArray\s+uCaustTex/.test(CAUSTICS_GLSL), 'uCaustTex は sampler2DArray');
check(!/\bsampler2D\b(?!Array)/.test(CAUSTICS_GLSL) && !/texture2D\s*\(/.test(CAUSTICS_GLSL), 'sampler2D / texture2D を使わない');
check(!/\bngFrame\b|\bng[A-Z]\w*\s*\(/.test(CAUSTICS_GLSL), 'ng のフレーム・関数に頼らない（魚では fog_pars より前に入る）');
const mediumFns = new Set([...NG_MEDIUM_GLSL.matchAll(/\b(?:float|vec[234]|void)\s+(\w+)\s*\(/g)].map((m) => m[1]));
const caustFns = [...CAUSTICS_GLSL.matchAll(/\b(?:float|vec[234]|void)\s+(\w+)\s*\(/g)].map((m) => m[1]);
check(caustFns.every((n) => !mediumFns.has(n)), '媒質ライブラリと関数名が衝突しない');
check(caustFns.every((n) => n === 'causticLight' || n.startsWith('cs')), `caustics の関数は cs 接頭辞（${caustFns.join(',')}）`);

const u = createCausticsUniforms();
const keys = Object.keys(u).sort();
check(keys.length === 16 && keys.join() === [...CAUSTICS_UNIFORM_NAMES].sort().join(), '16 名ちょうど');
check(keys.every((k) => u[k] && 'value' in u[k]), 'すべて {value}');
check(u.uCaustWarp.value.x === 1.15 && u.uCaustWarp.value.y === 2.5, 'uCaustWarp の既定 (1.15, 2.5)');
check(u.uCaustFar.value.x === 6 && u.uCaustFar.value.y === 20, 'uCaustFar の既定 (6, 20)');
const tex = u.uCaustTex.value;
check(tex instanceof THREE.DataArrayTexture && tex.image.width === 1 && tex.image.height === 1 && tex.image.depth === 1, 'uCaustTex は 1×1×1 の DataArrayTexture');
updateCausticsTexture(u, { data: new Uint8Array(8 * 8 * 4 * 3), width: 8, height: 8, depth: 3 });
check(u.uCaustTex.value === tex && tex.image.width === 8 && tex.image.depth === 3, '焼き込みの差し込みでもテクスチャは同じオブジェクト');
check(createCausticsUniforms().uCaustTex.value !== tex, '作るたびに別のテクスチャ');

done('caustics-contract');
