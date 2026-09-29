#!/usr/bin/env node
/* ===========================================================
   描画確認用のヘッドレス撮影ハーネス
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs <scenario.mjs> [--out DIR] [--size 1280x720]

   - このリポジトリを一時的な静的サーバーで配信する（ポートは空きを自動で取る）
   - インストール済みの Google Chrome をヘッドレスで起動し、M1 の GPU（Metal）で描く
   - シナリオは default export の async 関数。引数 h の道具で撮る
       export default async function (h) {
         await h.open('lab/water.html');     // 既定は index.html
         await h.waitFor(() => window.__gfxReady);
         await h.shot('calm');               // DIR/calm.png
       }
   - コンソールのエラー / 警告 / ページ例外を DIR/console.txt に書き、要約を標準出力へ出す
   - playwright は PW_MODULE（index.mjs の絶対パス）→ 'playwright' の順で探す
   =========================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
};

function parseArgs(argv) {
  const a = { scenario: null, out: null, size: '1280x720', dpr: 1, timeout: 240 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--size') a.size = argv[++i];
    else if (k === '--dpr') a.dpr = Number(argv[++i]);
    else if (k === '--timeout') a.timeout = Number(argv[++i]);
    else if (!a.scenario) a.scenario = k;
  }
  if (!a.scenario) {
    console.error('usage: node scripts/gfx/shot.mjs <scenario.mjs> [--out DIR] [--size WxH] [--dpr N]');
    process.exit(2);
  }
  const [w, h] = a.size.split('x').map(Number);
  a.w = w; a.h = h;
  a.out = path.resolve(a.out || path.join(ROOT, '.gfx-shots', path.basename(a.scenario, '.mjs')));
  return a;
}

function serve() {
  const srv = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      let p = decodeURIComponent(u.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.stat(f, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
          'Content-Length': st.size,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(f).pipe(res);
      });
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function loadPlaywright() {
  const cands = [process.env.PW_MODULE, 'playwright'].filter(Boolean);
  for (const c of cands) {
    try { return await import(c.startsWith('/') ? pathToFileURL(c).href : c); } catch (e) { /* next */ }
  }
  throw new Error('playwright が見つかりません。PW_MODULE に playwright/index.mjs の絶対パスを渡してください');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const { chromium } = await loadPlaywright();
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: args.w, height: args.h }, deviceScaleFactor: args.dpr });
  const logs = [];
  let errors = 0, warnings = 0;
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') errors++;
    if (t === 'warning') warnings++;
    if (t === 'error' || t === 'warning' || t === 'log' || t === 'info') logs.push(`[${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => { errors++; logs.push(`[pageerror] ${e.stack || e.message}`); });

  const shots = [];
  const h = {
    page, sleep, base, root: ROOT, out: args.out,
    /* ページを開く（ROOT からの相対パス。クエリ付き可） */
    async open(rel = 'index.html') {
      await page.goto(base + rel.replace(/^\//, ''), { waitUntil: 'domcontentloaded', timeout: args.timeout * 1000 });
    },
    /* ページ内の関数が truthy を返すまで待つ */
    async waitFor(fn, arg, timeoutSec = args.timeout) {
      await page.waitForFunction(fn, arg, { timeout: timeoutSec * 1000, polling: 250 });
    },
    eval: (fn, arg) => page.evaluate(fn, arg),
    /* 本編（index.html）を開いて、読み込み完了→ゲーム開始まで進める */
    async bootGame({ quality = 'high', lang = 'ja', start = true, query = '' } = {}) {
      await h.open('index.html' + query);
      await h.waitFor(() => !!(window.__game && window.__game.ui));
      await h.waitFor(() => {
        const el = document.getElementById('loading');
        return el && (el.classList.contains('done') || el.style.display === 'none');
      });
      await page.evaluate(({ quality, lang }) => {
        const g = window.__game;
        g.state.settings.lang = lang;
        if (quality) { g.state.settings.quality = quality; g.applyQuality?.(); }
      }, { quality, lang });
      if (start) {
        await page.evaluate(() => window.__game.start(true));
        await sleep(800);
      }
    },
    /* ゲームの update を固定 dt で n 回進める（rAF とは別に確実に進めたいとき） */
    async tick(n = 20, dt = 1 / 30) {
      for (let i = 0; i < n; i++) {
        await page.evaluate((dt) => window.__game.update(dt), dt);
      }
    },
    /* HUD・トーストを隠して絵だけにする */
    async hideHud(on = true) {
      await page.evaluate((on) => {
        for (const id of ['hud', 'toasts']) {
          const el = document.getElementById(id);
          if (el) el.style.visibility = on ? 'hidden' : '';
        }
      }, on);
    },
    async shot(name, opts = {}) {
      const file = path.join(args.out, name.endsWith('.png') ? name : `${name}.png`);
      await page.screenshot({ path: file, type: 'png', ...opts });
      shots.push(file);
      console.log('shot', file);
      return file;
    },
    /* 描画統計（three の renderer.info） */
    async stats() {
      return page.evaluate(() => {
        const r = window.__game?.renderer || window.__renderer;
        if (!r) return null;
        const i = r.info;
        return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length };
      });
    },
    /* 実フレームの平均間隔（ms）。rAF を n フレーム回して測る */
    async frameMs(n = 90) {
      return page.evaluate((n) => new Promise((res) => {
        let c = 0; const t0 = performance.now();
        const f = () => { if (++c >= n) res((performance.now() - t0) / n); else requestAnimationFrame(f); };
        requestAnimationFrame(f);
      }), n);
    },
  };

  const mod = await import(pathToFileURL(path.resolve(args.scenario)).href);
  let failed = null;
  try {
    await mod.default(h);
  } catch (e) {
    failed = e;
    try { await h.shot('_failure'); } catch (_) { /* noop */ }
  }
  fs.writeFileSync(path.join(args.out, 'console.txt'), logs.join('\n') + '\n');
  await browser.close();
  srv.close();
  const tail = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')).slice(0, 25);
  console.log(`\nconsole: ${errors} errors, ${warnings} warnings (全文: ${path.join(args.out, 'console.txt')})`);
  for (const l of tail) console.log('  ' + l.slice(0, 400));
  if (failed) { console.error('\nscenario failed:', failed.stack || failed.message); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
