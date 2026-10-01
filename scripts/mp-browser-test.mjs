/* マルチプレイのブラウザ実機テスト（依存なし・CDP 直叩き）
   ヘッドレス Chrome で 2 タブを開き、両方をマルチプレイで湖へ入れて
   「片方が歩くと、もう片方から見える位置が動く」ことを確かめる。
   使い方: 先に Chrome を --remote-debugging-port=9222 で起動しておき、
           node --experimental-websocket scripts/mp-browser-test.mjs [URL]
*/

const GAME_URL = process.argv[2] || 'http://localhost:8787/';
const CDP = 'http://127.0.0.1:9222';

const fail = (msg) => { console.error(`NG: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 切断判定用: 実際の player id を CDP 評価式へ埋め込む（'bId' 文字列リテラル回帰防止） */
export function remotePlayerPresenceScript(playerId) {
  const id = JSON.stringify(playerId);
  return `(() => { const id = ${id}; return [...window.__game.remotePlayers.map.values()].some(p => p.id === id) ? 'still' : 'gone'; })()`;
}

if (process.argv.includes('--self-test')) {
  const s = remotePlayerPresenceScript('abc123');
  if (!s.includes('"abc123"')) fail('player id が評価式に埋め込まれていない');
  if (s.includes("'bId'") || s.includes('"bId"')) fail('bId 文字列リテラルが残っている');
  ok('remotePlayerPresenceScript は動的 id を埋め込む');
  process.exit(0);
}

/** 1 タブぶんの CDP セッション */
async function openTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const waiting = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { res: resolve, rej } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) rej(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
    }
  };
  const send = (method, params = {}) => new Promise((resolve, rej) => {
    const id = ++seq;
    waiting.set(id, { res: resolve, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    }
    return r.result.value;
  };
  return { info, send, evalJs, errors, close: () => ws.close() };
}

/** 失敗時もゾンビタブを残さないよう、最後に必ず閉じる */
const tabs = [];
process.on('exit', () => { for (const t of tabs) try { t.close(); } catch (e) {} });

/** ゲームがマルチプレイで湖に立つまで待つ */
async function waitReady(tab, label, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await tab.evalJs(`(() => {
      const g = window.__game;
      if (!g) return 'boot';
      if (!g.playing) return 'loading';
      if (!g.multiplayer) return 'not-mp';
      if (!g.mp || !g.mp.connected) return 'connecting';
      return 'ready';
    })()`).catch((e) => `eval:${e.message}`);
    if (st === 'ready') { ok(`${label}: マルチプレイで湖に入った (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return; }
    if (st === 'not-mp') fail(`${label}: マルチプレイモードで起動していない`);
    await sleep(1000);
  }
  fail(`${label}: 起動がタイムアウト（コンソールエラー: ${tab.errors.join(' / ') || 'なし'}）`);
}

async function screenshot(tab, path) {
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, Buffer.from(data, 'base64'));
  ok(`スクリーンショット: ${path}`);
}

/** ゲームの origin を開いてから join フラグを入れてリロード（タイトルのボタンと同じ流れ） */
async function joinAs(tab, name, quality = null) {
  /* quality：その品質で «起動» させる。ページのスクリプトより先にセーブの設定へ書く
     （読み込み直しの直前にゲームが unload でセーブを書き戻すので、evaluate で書くと消える）。
     当たりが品質に依らないことを確かめる（ARCHITECTURE §9） */
  if (quality) {
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { const K = 'lakeside-fishing-save-v1';
      const s = JSON.parse(localStorage.getItem(K) || '{}');
      s.settings = { ...(s.settings || {}), quality: ${JSON.stringify(quality)}, debug: false };
      localStorage.setItem(K, JSON.stringify(s)); } catch (e) {}` });
  }
  await tab.send('Page.navigate', { url: GAME_URL });
  await sleep(2000);
  /* 初回は wrangler の配信が遅いことがある。ゲームの origin に入るまで待つ */
  const origin = new URL(GAME_URL).origin;
  for (let i = 0; i < 60; i++) {
    const o = await tab.evalJs('location.origin').catch(() => null);
    if (o === origin) break;
    await sleep(500);
  }
  await tab.evalJs(
    `sessionStorage.setItem('lakeside-fishing-mp-join', ${JSON.stringify(name)}); location.reload(); 'ok'`
  );
}

/** 当たり（障害物の配列・桟橋の寸法）と湖のハッシュ。品質の違う 2 クライアントで一致すること（ARCHITECTURE §9） */
const COLLISION_HASH = `(() => {
  const g = window.__game, t = g.terrain;
  let h = 2166136261 >>> 0;
  const mix = (v) => { const s = Number.isFinite(v) ? v.toFixed(5) : String(v); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
  for (const v of t.obstacles) mix(v);
  for (const v of [t.dockY, t._dockLen, t.dockStart.x, t.dockStart.z, t.dockEnd.x, t.dockEnd.z]) mix(v);
  for (const s of t.structures || []) mix(s.x), mix(s.z), mix(s.r);
  return { hash: h.toString(16), n: t.obstacles.length / 4, quality: g.state.settings.quality, seed: g.state.seed };
})()`;

/* ---- タブ A（あさひ） ---- */
const a = await openTab('about:blank');
tabs.push(a);
await joinAs(a, 'あさひ', 'low');
await waitReady(a, 'A(あさひ)');

/* ---- タブ B（ゆうひ） ---- */
const b = await openTab('about:blank');
tabs.push(b);
await joinAs(b, 'ゆうひ', 'high');
await waitReady(b, 'B(ゆうひ)');

await sleep(1500);   // 参加通知と初回状態の往復を待つ

/* ---- 品質の違う 2 クライアントで当たりが同じか ---- */
const colA = await a.evalJs(COLLISION_HASH);
const colB = await b.evalJs(COLLISION_HASH);
if (colA.quality === colB.quality) fail(`2 つのタブの品質が同じ（${colA.quality}）。品質を変えて起動できていない`);
if (colA.hash !== colB.hash || colA.n !== colB.n) fail(`当たりが品質で違う：A(${colA.quality}) ${colA.hash}/${colA.n} ・ B(${colB.quality}) ${colB.hash}/${colB.n}`);
ok(`品質 ${colA.quality} と ${colB.quality} で当たりが一致（障害物 ${colA.n}、ハッシュ ${colA.hash}、湖 ${colA.seed}/${colB.seed}）`);

/* ---- 相互に見えているか ----
   同じ Chrome 内の他タブ（以前の実行の残骸など）がいる可能性を除き、
   自分の相手（ゆうひ / あさひ）が見えていることを名前で確認する */
const namesByA = await a.evalJs(`[...window.__game.remotePlayers.map.values()].map(p => p.name)`);
const namesByB = await b.evalJs(`[...window.__game.remotePlayers.map.values()].map(p => p.name)`);
if (!namesByA.includes('ゆうひ')) fail(`A から「ゆうひ」が見えていない（見えているのは ${JSON.stringify(namesByA)}）`);
if (!namesByB.includes('あさひ')) fail(`B から「あさひ」が見えていない（見えているのは ${JSON.stringify(namesByB)}）`);
ok(`A と B が互いを認識している（A の視界: ${JSON.stringify(namesByA)}）`);

const nameSeenByA = await a.evalJs(
  `[...window.__game.remotePlayers.map.values()].find(p => p.name === 'ゆうひ')?.name`
);
if (nameSeenByA !== 'ゆうひ') fail(`A から見えた名前が「${nameSeenByA}」（「ゆうひ」のはず）`);
ok('名前も正しく届いている（日本語 OK）');

/* ---- B が動く → A から見た B の位置が動くか ----
   桟橋先端は湖側へ歩けないので、キー入力ではなく座標を動かして
   「送信 → サーバー中継 → 相手の補間」を確かめる */
const posBefore = await a.evalJs(
  `(() => { const p = [...window.__game.remotePlayers.map.values()].find(p => p.name === 'ゆうひ').angler.root.position; return [p.x, p.z]; })()`
);
const bMovedTo = await b.evalJs(`(() => {
  const g = window.__game;
  const dir = g.terrain.dockDir;
  g.pos.x -= dir.x * 8;
  g.pos.z -= dir.z * 8;
  return [g.pos.x, g.pos.z];
})()`);
await sleep(800);
/* 裏タブは描画（補間）が止まるので、A を前面にしてから見た目を測る */
await a.send('Page.bringToFront');
await sleep(1200);
const netAfter = await a.evalJs(
  `(() => { const p = [...window.__game.remotePlayers.map.values()].find(p => p.name === 'ゆうひ'); return [p.target.x, p.target.z]; })()`
);
const posAfter = await a.evalJs(
  `(() => { const p = [...window.__game.remotePlayers.map.values()].find(p => p.name === 'ゆうひ').angler.root.position; return [p.x, p.z]; })()`
);
const netMoved = Math.hypot(netAfter[0] - posBefore[0], netAfter[1] - posBefore[1]);
const moved = Math.hypot(posAfter[0] - posBefore[0], posAfter[1] - posBefore[1]);
if (netMoved < 3) {
  fail(`B の移動が A に届いていない (net ${netMoved.toFixed(2)}m, Bは ${bMovedTo})`);
}
if (moved < 2) {
  fail(`B の移動は届いたが、A の見た目が追従していない (${moved.toFixed(2)}m, net ${netMoved.toFixed(2)}m)`);
}
ok(`B の移動が A の画面へ反映された（見た目 ${moved.toFixed(1)}m / 受信 ${netMoved.toFixed(1)}m）`);

/* ---- 時刻が両者で揃っているか ---- */
await a.evalJs(`window.__game.update(0.016)`);
await b.evalJs(`window.__game.update(0.016)`);
const clockA = await a.evalJs(`window.__game.state.clock`);
const clockB = await b.evalJs(`window.__game.state.clock`);
const clockDiffMin = Math.abs(clockA - clockB) * 60;
if (clockDiffMin > 2) fail(`時刻が ${clockDiffMin.toFixed(1)} 分ずれている`);
ok(`ゲーム内時刻が揃っている（差 ${clockDiffMin.toFixed(2)} 分）`);

/* ---- A のカメラを B へ向けてスクリーンショット ---- */
await a.evalJs(`(() => {
  const g = window.__game;
  const r = [...g.remotePlayers.map.values()].find(p => p.name === 'ゆうひ').angler.root.position;
  g.yaw = Math.atan2(r.x - g.pos.x, r.z - g.pos.z);
  g.pitch = -0.05;
  return 'ok';
})()`);
await sleep(800);
await screenshot(a, '/tmp/lakeside-mp-viewA.png');
await screenshot(b, '/tmp/lakeside-mp-viewB.png');

/* ---- B を切断 → A に反映されるか ----
   同名の残骸タブがいる可能性があるので、B の接続 id を直接探して消えたか見る */
const bId = await b.evalJs(`window.__game.mp.id`);
await b.evalJs(`window.__game.mp.close(); 'ok'`);
await sleep(1200);
const afterLeave = await a.evalJs(remotePlayerPresenceScript(bId));
if (afterLeave !== 'gone') fail(`B が切断したのに A からまだ見えている (id=${bId})`);
ok('切断が A へ届き、B の姿が消えた');

const errA = a.errors.filter((e) => !/AudioContext|autoplay/i.test(e));
const errB = b.errors.filter((e) => !/AudioContext|autoplay/i.test(e));
if (errA.length || errB.length) {
  console.warn(`コンソールエラー A: ${errA.join(' / ') || 'なし'}`);
  console.warn(`コンソールエラー B: ${errB.join(' / ') || 'なし'}`);
}

a.close();
b.close();
console.log('\nブラウザ実機テストにすべて合格');
process.exit(0);
