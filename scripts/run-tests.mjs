#!/usr/bin/env node
/* リポジトリ内の Node 単体テストを一括実行（Node 22 推奨） */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tests = [
  'scripts/fishing-session-test.mjs',
  'scripts/fishing-controller-test.mjs',
  'scripts/fishing-install-order-test.mjs',
  'scripts/bite-timing-test.mjs',
  'scripts/species-display-test.mjs',
  'scripts/mp-interpolation-test.mjs',
  'scripts/mp-fishing-sync-test.mjs',
  'scripts/mp-hook-reject-test.mjs',
  'scripts/mp-world-test.mjs',
  'scripts/mp-single-parity-test.mjs',
  'scripts/mp-bait-rearm-test.mjs',
  'scripts/mp-chat-test.mjs',
  'scripts/othello-logic-test.mjs',
  'scripts/othello-room-test.mjs',
  'scripts/runtime-config-test.mjs',
  'scripts/performance-test.mjs',
  'scripts/underwater-props-test.mjs',
  'scripts/water-reflection-test.mjs',
  'scripts/water-spec-test.mjs',
  'scripts/repeat-wrapping-detail-test.mjs',
  'scripts/lake-calm-water-test.mjs',
  'scripts/tree-test.mjs',
  'scripts/lod-instances-test.mjs',
  'scripts/water-plant-test.mjs',
  'scripts/rock-test.mjs',
  'scripts/ground-grain-test.mjs',
  'scripts/land-texture-test.mjs',
  'scripts/terrain-mesh-test.mjs',
  'scripts/caustics-light-test.mjs',
  'scripts/night-sky-test.mjs',
  'scripts/undergrowth-test.mjs',
  'scripts/walk-zone-test.mjs',
  'scripts/mixamo-retarget-test.mjs',
];

for (const rel of tests) {
  const path = join(root, rel);
  process.stdout.write(`\n== ${rel} ==\n`);
  const r = spawnSync(process.execPath, [path], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log('\nすべての単体テストに合格');
