#!/usr/bin/env node
/**
 * 湖が変わっていないことの検査（描画の作り直しで «湖の生成» に触れていない証拠）。
 *
 * - resolveLake(123456789).tries === 1（マルチの固定シードが 1 回目で通る）
 * - makeLake の出力（高さ 64² ・structures・flats・holes・dock）の SHA-256 が c8490ed の記録と一致
 * - lakefield / util / data / waveField のソースが c8490ed とバイト一致
 * - Cloudflare Worker の import 鎖に three・src/world・src/gfx・waveField が入っていない
 *   （入ると Durable Object が起動しない）
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLake, makeLake } from '../src/lakefield.js';
import { lakeDigest, FIXTURE_SEEDS } from './capture-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/lake.json'), 'utf8'));

assert.equal(resolveLake(123456789).tries, 1, 'マルチのシードが 1 回目で通らなくなった');
for (const seed of FIXTURE_SEEDS) {
  const want = fx.lakes[seed];
  const r = resolveLake(seed);
  assert.equal(r.seed, want.resolvedSeed, `seed ${seed}: 解決後のシードが変わった`);
  assert.equal(r.tries, want.tries, `seed ${seed}: 試行回数が変わった`);
  assert.equal(lakeDigest(makeLake(r.seed)), want.digest, `seed ${seed}: makeLake の出力が変わった`);
  assert.deepEqual(JSON.parse(JSON.stringify(r.lake.structures)), want.structures, `seed ${seed}: structures`);
  assert.deepEqual(JSON.parse(JSON.stringify(r.lake.flats)), want.flats, `seed ${seed}: flats`);
}

/* c8490ed の時点のソースの SHA-256（Worker と共有するので 1 バイトも変えない） */
const FROZEN = {
  'src/lakefield.js': '94a549256673856da7ca37704cadf9dc4da9a5b3d4faa1687a984aa791a70c8c',
  'src/util.js': '10bd5f5821ed84ecf214e0f9b7f9ba3bc191dca65c75f3c913aad6fb5fba3b6c',
  'src/data.js': '3c0e3e45e90141fc02ebd9889ccc40405efcb7429f4052e41e711af3c3deb38b',
  'src/waveField.js': '83ef274ffcf01e0ed1f4131e595ce852395782cd1a16228b75c3ca5a21ba2ce5',
};
for (const [rel, sha] of Object.entries(FROZEN)) {
  const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
  assert.equal(got, sha, `${rel} が c8490ed から変わっている`);
}

/* Worker の import 鎖を静的にたどる */
{
  const seen = new Set();
  const bad = [];
  const re = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec.startsWith('.')) { bad.push(`${path.relative(ROOT, file)} → ${spec}`); continue; }
      const next = path.resolve(path.dirname(file), spec.split('?')[0]);
      const rel = path.relative(ROOT, next);
      if (/^src\/(world|gfx)\//.test(rel) || rel === 'src/waveField.js' || rel === 'src/terrain.js'
        || rel === 'src/water.js' || rel === 'src/sky.js') bad.push(`${path.relative(ROOT, file)} → ${rel}`);
      if (fs.existsSync(next)) walk(next);
    }
  };
  walk(path.join(ROOT, 'worker/index.js'));
  assert.ok(seen.size > 3, 'Worker の import 鎖を読めていない');
  assert.deepEqual(bad, [], `Worker の import 鎖に描画側のモジュールが入っている:\n  ${bad.join('\n  ')}`);
}

console.log('lake-invariance-test: ok');
