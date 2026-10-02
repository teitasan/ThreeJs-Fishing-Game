/* ===========================================================
   木のオフライン焼き込み（決定的・three 無し）
   -----------------------------------------------------------
   node scripts/bake/trees/bake.mjs [--check]
   8 樹種 × 4 variant × 2 LOD を assets/gfx/trees/trees.bin + trees.json に書く。
   --check は書かずに、今のファイルとバイト一致するかを確かめる（テストと同じ）。
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECIES_IDS, VARIANTS, SPECIES } from '../../../src/world/species.js';
import { ByteWriter, writeTube, writeCard, TREES_FORMAT_VERSION, POS_RANGE, CARD_SEGS, countLod } from '../../../src/gfx/trees/format.js';
import { GENERATORS, BREAST_FLAT } from './species.mjs';
import { fnv1a } from '../../../src/world/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const OUT_DIR = path.join(ROOT, 'assets/gfx/trees');

/** 全部を焼いてバイト列と JSON を返す（ファイルには書かない） */
export function bakeAll(log = () => {}) {
  const w = new ByteWriter(1 << 21);
  const variants = [];
  for (let s = 0; s < SPECIES_IDS.length; s++) {
    const id = SPECIES_IDS[s];
    for (let vi = 0; vi < VARIANTS; vi++) {
      const t0 = Date.now();
      const T = GENERATORS[id](vi);
      const lods = [];
      for (const [k, rec] of [[0, T.build], [1, T.lod1]]) {
        w.align(4);
        const tubeOffset = w.n;
        for (const t of rec.tubes) writeTube(w, t);
        w.align(2);
        const cardOffset = w.n;
        for (const c of rec.cards) writeCard(w, c);
        const c = countLod(rec, CARD_SEGS[k]);
        lods.push({ tubeOffset, tubes: rec.tubes.length, cardOffset, cards: rec.cards.length, verts: c.verts, tris: c.tris });
      }
      const r6 = (v) => Math.round(v * 1e6) / 1e6;
      variants.push({
        species: id, si: s, variant: vi, href: T.H,
        bounds: { R: r6(T.bounds.R), y0: r6(T.bounds.y0), y1: r6(T.bounds.y1) },
        crown: T.crown.map(r6), crownR: r6(T.crownRad),
        trunkR: SPECIES[id].trunkR[vi],
        lods,
      });
      log(`${id}#${vi}: LOD0 ${lods[0].tris} 三角形（管 ${lods[0].tubes}・カード ${lods[0].cards}）/ LOD1 ${lods[1].tris}  ${Date.now() - t0}ms`);
    }
  }
  const bin = w.bytes();
  const json = {
    version: TREES_FORMAT_VERSION, posRange: POS_RANGE, cardSegs: CARD_SEGS, breastFlat: BREAST_FLAT,
    bytes: bin.length, hash: fnv1aBytes(bin), variants,
  };
  return { bin, json, text: JSON.stringify(json, null, 1) + '\n' };
}

/** バイト列の FNV-1a（16 進 8 桁） */
export function fnv1aBytes(b) {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes('--check');
  const t0 = Date.now();
  const { bin, text, json } = bakeAll(console.log);
  console.log(`計 ${bin.length} B（${(bin.length / 1048576).toFixed(2)} MB）hash ${json.hash}  ${Date.now() - t0}ms`);
  if (check) {
    const a = fs.readFileSync(path.join(OUT_DIR, 'trees.bin'));
    const b = fs.readFileSync(path.join(OUT_DIR, 'trees.json'), 'utf8');
    const ok = Buffer.compare(a, Buffer.from(bin)) === 0 && b === text;
    console.log(ok ? '一致' : '不一致');
    process.exit(ok ? 0 : 1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'trees.bin'), bin);
  fs.writeFileSync(path.join(OUT_DIR, 'trees.json'), text);
  void fnv1a;
}
