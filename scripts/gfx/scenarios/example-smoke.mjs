/* ===========================================================
   core の最小モジュールの例（lab/example.html）を撮って確かめる。
   モジュール担当者の scripts/gfx/scenarios/<module>-*.mjs の雛形（docs/nextgen/CORE_API.md §13）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/example-smoke.mjs --out DIR [--size 1280x720]
   環境変数：TIERS=low,mid,high（既定 3 段）。INJECT=update|prepare で自分のメソッドに例外を入れる（雛形が
   «落ちたモジュール» を不合格にできることの確かめ。この場合は不合格になるのが正しい）
   各段で：起動 → モジュールが居る → 止めずに 300 フレーム（update の時間で進む道を通す）→
   撮影（晴れ・雨・夜・デバッグ表示）→ NaN 0 → プログラムの監査
   （モジュールの本数 ≤ NG_PROGRAM_BUDGET.perModule・サンプラー上限）→ ベンチで自分の GPU ms
   → console のエラー 0 → 最後に «自分が健在»（例外の数 0・無効化されていない・スタブへ差し戻されていない・
   止まったパス無し・'[ng] <id>.' の警告 0）。どれかが落ちたら例外（shot.mjs が _failure.png を撮って終了コード 1）
   ※ 例外は safety.guard が握って console.warn にするので、console のエラーだけを見ても落ちたモジュールは見えない
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const ID = 'example';
const INJECT = process.env.INJECT || '';
const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

export default async function (h) {
  const tiers = list(process.env.TIERS, ['low', 'mid', 'high']);
  const out = { id: ID, tiers: {} };
  const fail = [];
  const expect = (ok, msg) => { if (!ok) { fail.push(msg); console.log('  NG', msg); } };
  for (const tier of tiers) {
    const c0 = h.counts();
    const log0 = h.logs.length;
    await h.open(`lab/example.html?capture=1&tier=${tier}`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 180);
    const T = {};
    out.tiers[tier] = T;
    T.boot = await h.eval((id) => {
      const L = window.__lab, m = L.gfx.modules.get(id);
      return { present: !!m, stub: m?._ngStub ?? null, stats: m?.stats() ?? null, tier: L.gfx.quality.tier };
    }, ID);
    console.log(`== ${tier}`, JSON.stringify(T.boot));
    expect(T.boot.present && T.boot.stub === false, `${tier}: モジュール ${ID} が居ない`);
    expect(T.boot.tier === tier, `${tier}: 段が ${T.boot.tier}`);
    if (INJECT) {
      await h.eval(({ id, method }) => {
        const m = window.__lab.gfx.modules.get(id);
        if (m) m[method] = () => { throw new Error('injected boom'); };
      }, { id: ID, method: INJECT });
    }
    /* 止めずに回す（freeze すると dt = 0 で update の時間の道が通らない。G0 の雛形はここを見逃した） */
    T.run = await h.eval(() => {
      const L = window.__lab;
      L.unfreeze(); L.cam('dock-3p'); L.setHour(12.5); L.setWeather('clear', { instant: true });
      L.tick(300, 1 / 60);
      return { frames: L.tick(0) };
    });
    /* 撮影：時刻・天候・カメラを決めて時間を止め、数フレーム回してから撮る */
    for (const [name, cam, hour, weather, view] of [
      ['noon', 'dock-3p', 12.5, 'clear', null], ['rain', 'dock-3p', 11, 'rain', null],
      ['night', 'dock-3p', 22.5, 'clear', null], ['debug', 'dock-3p', 12.5, 'clear', 'example-depth'],
      ['aerial', 'aerial60', 15, 'clear', null],
    ]) {
      const nan = await h.eval(({ cam, hour, weather, view }) => {
        const L = window.__lab;
        L.cam(cam); L.setHour(hour); L.setWeather(weather, { instant: true }); L.view(view); L.freeze(10);
        L.tick(30);
        return L.nanCheck();
      }, { cam, hour, weather, view });
      await h.shot(`${tier}-${name}`);
      expect(nan === 0, `${tier}-${name}: NaN の画素 ${nan}`);
    }
    await h.eval(() => window.__lab.view(null));
    /* プログラムの監査（ARCHITECTURE §4.4 / CORE_API §8） */
    T.audit = await h.eval((id) => {
      const a = window.__lab.programAudit();
      const mine = a.programs.filter((p) => p.tag?.startsWith(id + ':'));
      return { total: a.count, mine: mine.length, over: a.over.length, failed: a.failed.length, samplers: mine.map((p) => [p.tag, p.frag, p.vert]) };
    }, ID);
    console.log('  audit', JSON.stringify(T.audit));
    expect(T.audit.mine >= 1 && T.audit.mine <= 6, `${tier}: ${ID} のプログラムが ${T.audit.mine} 本`);
    expect(T.audit.over === 0 && T.audit.failed === 0, `${tier}: サンプラー超過 ${T.audit.over}・リンク失敗 ${T.audit.failed}`);
    /* 自分の GPU ms（全体 − 自分の root を隠したもの） */
    T.bench = await h.eval((id) => {
      const L = window.__lab;
      L.cam('dock-3p'); L.setHour(12); L.setWeather('clear', { instant: true }); L.freeze(10);
      const a = L.bench({ frames: 40, passes: false }), b = L.bench({ frames: 40, passes: false, hide: [id] });
      return { frameMin: +a.frameMsMin.toFixed(2), hiddenMin: +b.frameMsMin.toFixed(2), costMs: +Math.max(0, a.frameMsMin - b.frameMsMin).toFixed(2), size: a.size };
    }, ID);
    console.log('  bench', JSON.stringify(T.bench));
    const c1 = h.counts();
    T.console = { errors: c1.errors - c0.errors, pageErrors: c1.pageErrors - c0.pageErrors };
    expect(T.console.errors === 0 && T.console.pageErrors === 0, `${tier}: console のエラー ${T.console.errors}・ページ例外 ${T.console.pageErrors}`);
    /* 自分が健在か（例外は guard が握るので、ここで数える）。本物の 10 の id は無効化されるとスタブで立て直されるので、
       «居る» だけでなく «スタブでない・作り直しが 0» を見る */
    T.health = await h.eval((id) => {
      const g = window.__lab.gfx, s = g.safety, m = g.modules.get(id);
      return {
        strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), present: !!m, stub: m?._ngStub ?? null,
        visible: m?.root?.visible ?? null, restarts: g._restarts.get(id) || 0, deadPasses: [...s.deadPasses],
      };
    }, ID);
    const myWarn = h.logs.slice(log0).filter((l) => l.includes(`[ng] ${ID}.`) || l.includes(`モジュール ${ID} `));
    T.health.warnings = myWarn.length;
    console.log('  health', JSON.stringify(T.health));
    const H = T.health;
    expect(H.strikes === 0 && !H.disabled && H.present && H.stub === false && H.visible === true && H.restarts === 0,
      `${tier}: ${ID} が健在でない ${JSON.stringify(H)}`);
    expect(H.deadPasses.length === 0, `${tier}: 止まったパス ${H.deadPasses.join(',')}`);
    expect(myWarn.length === 0, `${tier}: ${ID} の警告 ${myWarn.length} 件：${myWarn.slice(0, 3).map((l) => l.split('\n')[0]).join(' / ')}`);
  }
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, 'example-smoke.json'), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`example-smoke: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('example-smoke: 合格');
}
