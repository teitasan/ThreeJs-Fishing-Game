#!/usr/bin/env node
/* ===========================================================
   terrain-cdlod：CDLOD の選択とジオモーフの純粋な式（src/gfx/terrain/cdlod.js）と、地形の GLSL の静的な検査
   -----------------------------------------------------------
   1. 選択が根（±512m）を重なり無く覆う（面積の和 = 1024²、葉どうしが重ならない）。段の差は隣で 1 段まで
   2. 継ぎ目が水密：隣り合う 2 つの区画の共有の辺で、両側の頂点（ジオモーフ後、cdlodVertex = VS の双子）の
      «異なる点の集合» が一致する（T 字の隙間なし）。カメラ 7 か所 × 高さ 3 × 品質 3（セル 16/32、範囲の倍率）
   3. GLSL：関数の中で «宣言より前に使うローカル変数» が無い（G1 の WIP で upland を先に使ってリンクに失敗し、
      森が空中に浮いた）。地形・稜線・farAlbedo・coverRules の全部の文字列を検査する
   4. ridges：同じ種で同じ高さ（決定的）、内側の列は heightAt と一致、地平の角は有限
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const C = await imp('src/gfx/terrain/cdlod.js');
const Q = await imp('src/gfx/terrain/quality.js');

/* ---------- 1・2 ---------- */
function runCase(cx, cz, dy, tierKey) {
  const q = Q.terrainTier(tierKey);
  const rho = new Float32Array(C.CDLOD_MAX_LEVELS), morph = new Float32Array(32);
  C.cdlodRanges(Q.TERRAIN_R0 * q.rangeK, dy, rho, morph, q.cells, C.CDLOD_WALK_R);
  const list = new C.CdlodList();
  C.cdlodSelect(cx, cz, rho, list, q.cells);
  check(list.overflow === 0, `溢れ 0（${list.overflow}）`);
  const nodes = [];
  let area = 0;
  for (let i = 0; i < list.count; i++) {
    const o = i * 4;
    nodes.push({ x0: list.data[o], z0: list.data[o + 1], cR: list.data[o + 2], L: list.data[o + 3], s: list.size[i], inst: Array.from(list.data.subarray(o, o + 4)) });
    area += list.size[i] ** 2;
  }
  check(Math.abs(area - 1024 * 1024) < 1, `面積の和 ${area}`);
  /* 葉の格子で «どの区画か» の表 */
  const LEAF = C.cdlodConfig(q.cells).leaf, N = 1024 / LEAF, owner = new Int32Array(N * N).fill(-1);
  let overlap = 0;
  nodes.forEach((n, k) => {
    const i0 = Math.round((n.x0 + 512) / LEAF), j0 = Math.round((n.z0 + 512) / LEAF), w = Math.round(n.s / LEAF);
    for (let j = j0; j < j0 + w; j++) for (let i = i0; i < i0 + w; i++) { if (owner[j * N + i] >= 0) overlap++; owner[j * N + i] = k; }
  });
  check(overlap === 0, `重なり ${overlap}`);
  /* 共有の辺 */
  const key = (x, z) => `${Math.round(x * 100)},${Math.round(z * 100)}`;   // 1cm（float32 の丸めの差は除く）
  const edgePts = (n, side) => {
    const pts = new Set(), c = q.cells;
    for (let t = 0; t <= c; t++) {
      const [gi, gj] = side === 0 ? [t, 0] : side === 1 ? [c, t] : side === 2 ? [t, c] : [0, t];
      const [x, z] = C.cdlodVertex(gi, gj, n.inst, cx, cz, morph, c);
      pts.add(key(x, z));
    }
    return pts;
  };
  let bad = 0, pairs = 0, maxDL = 0;
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (Math.hypot(n.x0 + n.s / 2, n.z0 + n.s / 2) > 470) continue;   // 遠景の帯へ寄せる所は除く
    /* 右（+x）と上（+z）の隣：辺の 16m ごとに隣の区画を引く */
    for (const side of [1, 2]) {
      const seen = new Set();
      for (let t = 0; t < n.s; t += LEAF) {
        const px = side === 1 ? n.x0 + n.s + LEAF / 2 : n.x0 + t + LEAF / 2, pz = side === 1 ? n.z0 + t + LEAF / 2 : n.z0 + n.s + LEAF / 2;
        const i = Math.floor((px + 512) / LEAF), j = Math.floor((pz + 512) / LEAF);
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const m = owner[j * N + i];
        if (m < 0 || seen.has(m)) continue;
        seen.add(m);
        const o = nodes[m];
        maxDL = Math.max(maxDL, Math.abs(Math.log2(o.s) - Math.log2(n.s)));
        /* 共有の区間 */
        const a0 = side === 1 ? Math.max(n.z0, o.z0) : Math.max(n.x0, o.x0);
        const a1 = side === 1 ? Math.min(n.z0 + n.s, o.z0 + o.s) : Math.min(n.x0 + n.s, o.x0 + o.s);
        const inSeg = (s) => { const [x, z] = s.split(",").map((v) => Number(v) / 100); const a = side === 1 ? z : x; return a >= a0 - 1e-3 && a <= a1 + 1e-3; };
        const A = [...edgePts(n, side)].filter(inSeg).sort();
        const B = [...edgePts(o, side === 1 ? 3 : 0)].filter(inSeg).sort();
        pairs++;
        if (A.join('|') !== B.join('|')) bad++;
      }
    }
  }
  return { bad, pairs, maxDL, count: list.count };
}

let tot = 0, totBad = 0, maxDL = 0;
for (const tier of ['low', 'mid', 'high']) {
  for (const [cx, cz] of [[0, 0], [37.3, -81.9], [-200.2, 155.7], [301, 12.4], [-5.5, -390.1], [88.8, 88.8], [-123.4, -17.2]]) {
    for (const dy of [1.7, 20, 140]) {
      const r = runCase(cx, cz, dy, tier);
      tot += r.pairs; totBad += r.bad; maxDL = Math.max(maxDL, r.maxDL);
      if (r.bad) console.error(`  継ぎ目の不一致 ${tier} (${cx}, ${cz}) dy ${dy}: ${r.bad}/${r.pairs}`);
    }
  }
}
check(tot > 500, `辺の組の数 ${tot}`);
check(totBad === 0, `T 字の隙間のある辺 ${totBad}/${tot}`);
check(maxDL <= 2, `隣の区画の大きさの差 ${maxDL} 段（親の 1/4 を親の細かさで描く区画を含む）`);

/* 段 0 の格子 = near の格子（0.5m）：全段で（low は葉 8m × 16 セル） */
for (const cells of [16, 32]) {
  const { leaf, levels } = C.cdlodConfig(cells);
  check(leaf / cells === 0.5 && leaf * 2 ** (levels - 1) === 1024, `セル ${cells}：葉 ${leaf}m・${levels} 段`);
}
/* 歩ける帯：段 0 のジオモーフは足元から CDLOD_WALK_R より外（全段） */
for (const tier of ['low', 'mid', 'high']) {
  const q = Q.terrainTier(tier), rho = new Float32Array(8), morph = new Float32Array(32);
  C.cdlodRanges(Q.TERRAIN_R0 * q.rangeK, 1.7, rho, morph, q.cells, C.CDLOD_WALK_R);
  check(morph[0] >= C.CDLOD_WALK_R - 0.1, `${tier}：段 0 のジオモーフの始め ${morph[0].toFixed(1)}m ≥ ${C.CDLOD_WALK_R}m`);
}

/* ---------- 3. GLSL の静的な検査 ---------- */
const TG = await imp('src/gfx/terrain/terrain.glsl.js');
const LG = await imp('src/gfx/terrain/layers.glsl.js');
const RG = await imp('src/gfx/terrain/ridges.js');
const FG = await imp('src/gfx/terrain/farAlbedo.js');

const TYPES = 'float|int|bool|vec2|vec3|vec4|ivec2|ivec3|mat2|mat3|mat4';
/** 関数の本体ごとに、宣言の前に同じ名前が出てくるローカルを探す */
function useBeforeDecl(src) {
  const out = [];
  const fnRe = new RegExp(`\\b(?:${TYPES}|void)\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{`, 'g');
  let m;
  while ((m = fnRe.exec(src))) {
    const name = m[1], params = m[2];
    let depth = 0, k = fnRe.lastIndex - 1;
    for (; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) break; }
    const body = src.slice(fnRe.lastIndex, k).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const pnames = new Set((params.match(/\w+(?=\s*(?:,|$|\[))/g) || []));
    const declRe = new RegExp(`(?:^|[;{}(\\s])(?:const\\s+)?(?:${TYPES})\\s+([A-Za-z_]\\w*)\\s*(?=[=;,\\[)])`, 'g');
    let d;
    while ((d = declRe.exec(body))) {
      /* 同じ文の «, 名前» も拾う（括弧の深さ 0 の , だけ） */
      const names = [d[1]];
      let depth = 0, seg = '';
      for (let q = d.index + d[0].length; q < body.length; q++) {
        const ch = body[q];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') { if (--depth < 0) break; }
        else if (ch === ';' && depth === 0) break;
        else if (ch === ',' && depth === 0) { seg = ''; const mm = body.slice(q + 1).match(/^\s*([A-Za-z_]\w*)\s*(?=[=;,\[])/); if (mm) names.push(mm[1]); }
      }
      for (const v of names) {
        if (pnames.has(v)) continue;
        const before = body.slice(0, d.index);
        if (new RegExp(`(?<![.\\w])${v}\\b`).test(before)) {
          if (new RegExp(`\\b(?:${TYPES})\\s+${v}\\b`).test(before)) continue;
          out.push(`${name}: ${v}`);
        }
      }
    }
    fnRe.lastIndex = k;
  }
  return out;
}
const glsl = {
  'terrain vert': TG.TERRAIN_VERT_PARS + TG.TERRAIN_VERT_BEGIN,
  'terrain frag': TG.TERRAIN_FRAG_PARS,
  'coverRules': TG.terrainCoverRules({ x: 1, z: 2 }, { x: 0, z: 1 }),
  'bake A': LG.TERRAIN_BAKE_A, 'bake B': LG.TERRAIN_BAKE_B, 'macro': LG.TERRAIN_BAKE_MACRO,
  'ridge frag': RG.RIDGE_FRAG_PARS, 'ridge vert': RG.RIDGE_VERT_PARS + RG.RIDGE_VERT_BEGIN, 'horizon': RG.RIDGE_HORIZON_BAKE, 'farAlbedo': FG.FAR_BAKE,
};
for (const [k, s] of Object.entries(glsl)) {
  const u = useBeforeDecl(s);
  check(u.length === 0, `${k}：宣言の前に使うローカル ${u.join(', ')}`);
  check(!/\bMath\.random\b/.test(s), `${k}：Math.random`);
}
/* 検査が効いていることの確かめ（わざと壊した断片） */
check(useBeforeDecl('float f(vec2 p) { float a = b + 1.0; float b = 2.0; return a; }').length === 1, '検査そのものが upland の型の誤りを見つける');
check(TG.terrainCoverRules({ x: 1, z: 2 }, { x: 0, z: 1 }).includes('float ngGroundKind(vec3 p)'), 'coverRules が ngGroundKind を定義する');
/* 識別子は ng 接頭辞（関数・uniform・varying） */
for (const [k, s] of Object.entries(glsl)) {
  const bad = [...s.matchAll(/^\s*(?:uniform|varying|attribute)\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)/gm)].map((m) => m[1]).filter((n) => !/^(ng|NG_|aNg)/.test(n) && n !== 'vUv');
  check(bad.length === 0, `${k}：ng 接頭辞でない宣言 ${bad.join(', ')}`);
}

/* ---------- 4. ridges ---------- */
const flat = (x, z) => 2 + 0.01 * x;
const a = RG.buildRidgeArrays({ seed: 7, baseAt: flat, innerAt: flat, seg: 128 });
const b = RG.buildRidgeArrays({ seed: 7, baseAt: flat, innerAt: flat, seg: 128 });
check(a.pos.every((v, i) => v === b.pos[i]), '稜線は決定的');
let finite = true;
for (const arr of [a.pos, a.nrm, a.H, a.ij]) for (const v of arr) if (!Number.isFinite(v)) finite = false;
check(finite, '稜線の頂点・法線・高さが有限');
const W = a.seg + 1;
let edgeErr = 0;
for (let i = 0; i < a.seg; i++) { const x = a.pos[(W + i) * 3], z = a.pos[(W + i) * 3 + 2]; edgeErr = Math.max(edgeErr, Math.abs(a.pos[(W + i) * 3 + 1] - flat(x, z))); }
check(edgeErr < 1e-3, `稜線の内側の列は地形の縁と同じ高さ（${edgeErr}）`);
const far = a.rows - 1;
let peak = 0;
for (let i = 0; i < a.seg; i++) peak = Math.max(peak, a.pos[((far - 4) * W + i) * 3 + 1]);
check(peak > 300, `奥の山並みが立つ（${peak.toFixed(0)}m）`);
check(a.rows <= RG.RIDGE_MAX_ROWS, `稜線の列 ${a.rows} ≤ ${RG.RIDGE_MAX_ROWS}（地平の角の焼き込みの uniform 配列）`);

done('terrain-cdlod');
