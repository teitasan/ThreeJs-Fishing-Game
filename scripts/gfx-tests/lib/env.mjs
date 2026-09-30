/* ===========================================================
   gfx-tests の共通（lib/ はテストではない。run-tests は scripts/gfx-tests/*.mjs だけを回す）：'three' の解決と小さな assert
   -----------------------------------------------------------
   テストは run-tests.mjs から素の node で起動される。'three' を import する
   モジュール（extend.js / shaders.js など）を読むテストは、先頭で
   await withThree(import.meta.url) を呼ぶ。ローダー無しで起動されていたら
   --experimental-loader 付きで自分を起動し直し、その終了コードで終わる
   =========================================================== */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** ローダー付きで動いていなければ起動し直す（戻らない） */
export function withThree(selfUrl) {
  if (process.env.NG_THREE_LOADER === '1') return;
  const loader = new URL('./three-loader.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, fileURLToPath(selfUrl), ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, NG_THREE_LOADER: '1' },
  });
  process.exit(r.status ?? 1);
}

let failures = 0, passes = 0;
/** 条件が偽なら失敗として数える（最後に done() で終了コードを決める） */
export function check(cond, msg) {
  if (cond) { passes++; return; }
  failures++;
  console.error('  NG:', msg);
}
/** 失敗があれば非 0 で終わる */
export function done(name) {
  if (failures) { console.error(`${name}: ${failures} 件失敗（${passes} 件合格）`); process.exit(1); }
  console.log(`${name}: ${passes} 件合格`);
}
