#!/usr/bin/env node
/* リポジトリ内の Node 単体テストを一括実行（Node 22 推奨）
   順番：ゲーム性の KEEP テストと walk-zone → 世界データとファサードのテスト → 描画の芯（scripts/gfx-tests）。
   最初の失敗で止まるので、描画のテストが落ちてもゲーム性のテストは必ず先に走る */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tests = [
  /* ゲーム性（KEEP）：描画の作り直しでは中身を変えない */
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
  'scripts/mixamo-retarget-test.mjs',
  'scripts/cast-origin-test.mjs',
  'scripts/gait-test.mjs',
  'scripts/walk-zone-test.mjs',
  /* MIXED：残す文字列と波の物理 */
  'scripts/performance-test.mjs',
  'scripts/lake-calm-water-test.mjs',
  /* 世界データ層とファサード（Core-B） */
  'scripts/lake-invariance-test.mjs',
  'scripts/terrain-api-parity-test.mjs',
  'scripts/placement-determinism-test.mjs',
  'scripts/collision-dims-test.mjs',
  'scripts/wave-agreement-test.mjs',
  'scripts/weather-api-test.mjs',
  'scripts/api-safety-test.mjs',
];
/* 描画の芯とモジュールのテスト（名前順。_ で始まるものは補助） */
const gfxDir = join(root, 'scripts/gfx-tests');
if (existsSync(gfxDir)) {
  for (const f of readdirSync(gfxDir).filter((n) => n.endsWith('.mjs') && !n.startsWith('_')).sort()) {
    tests.push(`scripts/gfx-tests/${f}`);
  }
}

for (const rel of tests) {
  const path = join(root, rel);
  process.stdout.write(`\n== ${rel} ==\n`);
  const r = spawnSync(process.execPath, [path], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log('\nすべての単体テストに合格');
