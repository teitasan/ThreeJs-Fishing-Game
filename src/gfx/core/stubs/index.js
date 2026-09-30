/* ===========================================================
   グレーボックスの一覧（core が持つ代替）。キーはモジュール id、値は createModule
   src/gfx/<m>/index.js は最初これを再 export し、担当者が中身を差し替える
   =========================================================== */
export { createModule as sky } from './sky.js';
export { createModule as water } from './water.js';
export { createModule as underwater } from './underwater.js';
export { createModule as terrain } from './terrain.js';
export { createModule as trees } from './trees.js';
export { createModule as hardscape } from './hardscape.js';
export { createModule as post } from './post.js';
export { groundcover, shoreflora, weatherfx } from './empty.js';
