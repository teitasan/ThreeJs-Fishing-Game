/* ===========================================================
   故障の注入（ARCHITECTURE §9）：各モジュールの update / prepare（と sky の produce・post の renderPost・
   underwater の waterUpdate・services の関数）に throw を入れても、
     - game.update が例外を出さずにフレームを完走する
     - 描画の後ろの MP ラッパー（sharedFish.update・sendFightPosition）と debug.update が毎フレーム走る
     - 画面が描かれ続ける（中央の画素が NaN・真っ黒でない。post が止まったら sceneColor の簡易表示）
     - 3 回で無効化され、新しいスタブで立て直される（水面・地形・空が消えない）。警告は 10 秒に 1 回に抑えられる
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/fault-inject.mjs --out DIR
   モジュールごとに新しいページで起動する（無効化は 1 セッション限りなので、前の注入を持ち越さない）。
   最後に «描画の中» の故障（renderer.render の中で呼ばれる onBeforeRender / onBeforeCompile が投げる）を、
   ゲームの物体とモジュールの物体の両方で入れる：不透明パスが止まらず（deadPasses 0）、カメラを回すと絵が変わり、
   投げ続けるモジュールの物体はそのモジュールだけが数えられてスタブで立て直される（RENDER=0 で省く）
   環境変数 MODULES=sky,water,... で絞れる。結果は DIR/fault-inject.json
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const ALL = ['sky', 'water', 'underwater', 'terrain', 'trees', 'groundcover', 'shoreflora', 'hardscape', 'weatherfx', 'post'];
const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

export default async function (h) {
  const mods = list(process.env.MODULES, ALL);
  const seed = Number(process.env.SEED) || 123456789;
  const out = { seed, modules: {} };
  const bad = [];
  for (const id of mods) {
    await h.bootGame({ quality: null, bootQuality: 'mid', seed, start: true });
    await h.hideHud();
    const c0 = h.counts();
    const r = await h.eval(async ({ id }) => {
      const { getGfx } = await import('/src/gfx/core/index.js');
      const gfx = getGfx();
      const g = window.__game;
      g.state.clock = 12;
      const m = gfx.modules.get(id);
      if (!m) return { error: `モジュール ${id} が居ない` };
      /* 描画の後ろで走るもの：MP ラッパーの sharedFish.update / sendFightPosition と debug.update。
         multiplayer = true で MP ラッパーの分岐に入れる（接続は無いので送信は走らない） */
      const calls = { shared: 0, fight: 0, debug: 0 };
      const mp0 = g.multiplayer;
      g.multiplayer = true;
      g.sharedFish = { update() { calls.shared++; } };
      const mf0 = g.multiplayerFishing;
      g.multiplayerFishing = { sendFightPosition() { calls.fight++; }, dispose() {} };
      const dbg0 = g.debug.update;
      g.debug.update = function (...a) { calls.debug++; return dbg0.apply(this, a); };
      const boom = (what) => function () { throw new Error(`注入した例外：${id}.${what}`); };
      const patched = [];
      const patch = (obj, key, what) => { if (obj && typeof obj[key] === 'function') { obj[key] = boom(what); patched.push(what); } };
      patch(m, 'update', 'update');
      patch(m, 'prepare', 'prepare');
      patch(m, 'beforePass', 'beforePass');
      if (id === 'sky') patch(m, 'produce', 'produce');
      if (id === 'post') patch(m, 'renderPost', 'renderPost');
      if (id === 'underwater') patch(m, 'waterUpdate', 'waterUpdate');
      /* services の関数も（ファサードから呼ばれる口。既定値へ落ちること） */
      const sv = gfx.services[id];
      if (sv) {
        for (const k of Object.keys(sv)) {
          if (typeof sv[k] === 'function') {
            const inner = boom(`services.${k}`);
            gfx.services.provide(id, { ...sv, [k]: inner });
            patched.push(`services.${k}`);
            break;
          }
        }
      }
      const throws = [];
      const gl = gfx.renderer.getContext();
      const px = new Uint8Array(4);
      const centre = [];
      for (let i = 0; i < 90; i++) {
        try {
          g.update(1 / 30);
          g.water.addRipple(g.pos.x + 3, g.pos.z + 3, 1, 1);
          g.water.addSplash(g.pos.x + 3, 0, g.pos.z + 3, 6, 1);
          g.terrain.updateLamp(0.5, 1 / 30);
        } catch (e) { throws.push(String(e && e.stack || e)); }
        if (i % 30 === 29) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          centre.push([px[0], px[1], px[2]]);
        }
      }
      /* 無効化の後も «時刻の光» が進むこと（sky が落ちても代わりの producer が ngFrame を書く）と、
         必須モジュール（sky / post）がスタブで立て直されること */
      await new Promise((r) => setTimeout(r, 300));
      g.state.clock = 0;
      for (let i = 0; i < 4; i++) g.update(1 / 30);
      const nightAt0 = gfx.frame.data[3];
      g.state.clock = 12;
      for (let i = 0; i < 4; i++) g.update(1 / 30);
      const nightAt12 = gfx.frame.data[3];
      const res = {
        nightAt0: +nightAt0.toFixed(3), nightAt12: +nightAt12.toFixed(3),
        patched, throws: throws.slice(0, 3), nThrows: throws.length, calls,
        disabled: [...gfx.safety.disabled], deadPasses: [...gfx.safety.deadPasses], strikes: gfx.safety.strikes.get(id) || 0,
        stillRegistered: gfx.modules.has(id), stub: !!gfx.modules.get(id)?._ngStub,
        rootVisible: gfx.modules.get(id)?.root?.visible ?? null, centre,
        frameIndex: gfx.pipeline.state.frameIndex, rendered: gfx.pipeline.state.rendered,
      };
      g.multiplayer = mp0;
      g.sharedFish = undefined;
      g.multiplayerFishing = mf0;
      g.debug.update = dbg0;
      return res;
    }, { id });
    await h.shot(`fault-${id}`);
    const c1 = h.counts();
    r.console = { errors: c1.errors - c0.errors, pageErrors: c1.pageErrors - c0.pageErrors, warnings: c1.warnings - c0.warnings };
    out.modules[id] = r;
    console.log(`${id.padEnd(11)} patched ${r.patched?.join(',')} | throws ${r.nThrows} | after-render ${JSON.stringify(r.calls)} | disabled ${r.disabled} | dead ${r.deadPasses} | centre ${JSON.stringify(r.centre)} | console err ${r.console.errors} warn ${r.console.warnings}`);
    const B = (ok, msg) => { if (!ok) bad.push(`${id}: ${msg}`); };
    B(!r.error, r.error);
    B(r.nThrows === 0, `game.update が例外を出した：${r.throws?.[0]}`);
    /* 90 フレーム + 時刻の確かめの 8 フレーム + 待つ間の rAF の分。3 つが同じ数だけ呼ばれていること */
    B(r.calls.shared >= 98 && r.calls.fight === r.calls.shared && r.calls.debug === r.calls.shared, `描画の後ろが走っていない ${JSON.stringify(r.calls)}`);
    B(r.rendered === r.frameIndex, `最後のフレームが描かれていない（rendered ${r.rendered} / frame ${r.frameIndex}）`);
    B(r.centre.every((c) => c[0] + c[1] + c[2] > 0), `画面が真っ黒 ${JSON.stringify(r.centre)}`);
    B(r.console.errors === 0 && r.console.pageErrors === 0, `console のエラー ${r.console.errors}・ページ例外 ${r.console.pageErrors}`);
    B(r.nightAt0 > 0.9 && r.nightAt12 < 0.1, `無効化の後に時刻の光が進まない（0 時の night ${r.nightAt0}、12 時 ${r.nightAt12}）`);
    B(r.stillRegistered && r.stub && r.rootVisible !== false && !r.disabled.includes(id), `${id} がスタブで立て直されていない`);
    if (id === 'post') B(!r.deadPasses.includes('post'), 'post のパスが止まったまま');
    B(r.console.warnings <= 12, `警告が多すぎる（${r.console.warnings}。レート制限が効いていない）`);
  }
  if (process.env.RENDER !== '0') {
    await h.bootGame({ quality: null, bootQuality: 'mid', seed, start: true });
    await h.hideHud();
    const c0 = h.counts();
    const r = await h.eval(async () => {
      const { getGfx } = await import('/src/gfx/core/index.js');
      const gfx = getGfx(), T = gfx.THREE, g = window.__game;
      g.state.clock = 12;
      for (let i = 0; i < 3; i++) g.update(1 / 30);
      const cam = g.camera, fwd = new T.Vector3();
      cam.getWorldDirection(fwd);
      const at = cam.position.clone().addScaledVector(fwd, 3);
      const mk = (color) => { const m = new T.Mesh(new T.BoxGeometry(0.4, 0.4, 0.4), new T.MeshStandardMaterial({ color })); m.position.copy(at); return m; };
      /* 1. ゲームの物体：onBeforeRender が最初の 2 回だけ投げる（旧版はこれで不透明パスがセッション中止） */
      let n1 = 0;
      const gameObj = mk(0xff0000);
      gameObj.name = 'fault-game-obr';
      gameObj.onBeforeRender = () => { if (n1++ < 2) throw new Error('注入：ゲームの onBeforeRender'); };
      /* 2. ゲームのマテリアル：onBeforeCompile が投げる */
      const gameMat = mk(0x00ff00);
      gameMat.position.x += 0.6;
      gameMat.name = 'fault-game-obc';
      gameMat.material.onBeforeCompile = () => { throw new Error('注入：ゲームの onBeforeCompile'); };
      g.scene.add(gameObj, gameMat);
      /* 3. trees の root の子：onBeforeRender が投げ続ける → trees だけが数えられ、3 回でスタブへ */
      const trees = gfx.modules.get('trees');
      const treeObj = mk(0x0000ff);
      treeObj.position.x -= 0.6;
      treeObj.onBeforeRender = () => { throw new Error('注入：trees の onBeforeRender'); };
      trees.root.add(treeObj);
      /* 4. terrain の root の子：onBeforeCompile が投げる → terrain に 1 回 */
      const terr = gfx.modules.get('terrain');
      const terrObj = mk(0xffff00);
      terrObj.position.y += 0.6;
      terrObj.material.onBeforeCompile = () => { throw new Error('注入：terrain の onBeforeCompile'); };
      terr.root.add(terrObj);
      const throws = [];
      const passFailFrames = [];
      for (let i = 0; i < 30; i++) {
        try { g.update(1 / 30); } catch (e) { throws.push(String(e && e.stack || e)); }
        if (gfx.safety.passFails.get('opaque')?.length) passFailFrames.push(i);
      }
      g.scene.remove(gameObj, gameMat);
      terrObj.parent?.remove(terrObj);
      await new Promise((res) => setTimeout(res, 300));   // スタブの init（async）を待つ
      const gl = gfx.renderer.getContext();
      const read = () => {
        const px = new Uint8Array(4 * 9), out = [];
        for (const [u, v] of [[0.3, 0.3], [0.5, 0.5], [0.7, 0.7]]) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(Math.floor(gl.drawingBufferWidth * u), Math.floor(gl.drawingBufferHeight * v), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          out.push(px[0], px[1], px[2]);
        }
        return out;
      };
      g.update(1 / 30);
      const before = read();
      g.yaw += Math.PI;
      for (let i = 0; i < 4; i++) g.update(1 / 30);
      const after = read();
      const diff = before.reduce((s, v, k) => s + Math.abs(v - after[k]), 0);
      return {
        throws: throws.slice(0, 3), nThrows: throws.length, gameCalls: n1, passFailFrames,
        deadPasses: [...gfx.safety.deadPasses], disabled: [...gfx.safety.disabled], strikes: Object.fromEntries(gfx.safety.strikes),
        treesRestarted: gfx.modules.get('trees') !== trees && !!gfx.modules.get('trees')?._ngStub, treesRestarts: gfx._restarts.get('trees') || 0,
        terrainSame: gfx.modules.get('terrain') === terr, rendered: gfx.pipeline.state.rendered, frameIndex: gfx.pipeline.state.frameIndex,
        before, after, diff,
      };
    });
    await h.shot('fault-render-hooks');
    const c1 = h.counts();
    r.console = { errors: c1.errors - c0.errors, pageErrors: c1.pageErrors - c0.pageErrors, warnings: c1.warnings - c0.warnings };
    out.renderHooks = r;
    console.log(`render-hooks throws ${r.nThrows} | dead ${r.deadPasses} | disabled ${r.disabled} | strikes ${JSON.stringify(r.strikes)} | trees restarted ${r.treesRestarted} | diff ${r.diff} | console err ${r.console.errors} warn ${r.console.warnings}`);
    const B = (ok, msg) => { if (!ok) bad.push(`render-hooks: ${msg}`); };
    B(r.nThrows === 0, `game.update が例外を出した：${r.throws[0]}`);
    B(r.deadPasses.length === 0 && r.passFailFrames.length === 0, `描画の中の例外がパスまで漏れた（dead ${r.deadPasses}、opaque の失敗 ${r.passFailFrames.length} フレーム）`);
    B(r.gameCalls > 2, `ゲームの物体の onBeforeRender が描画で呼ばれていない（${r.gameCalls}）`);
    B(r.treesRestarted && r.treesRestarts === 1, 'trees の物体が投げ続けても trees がスタブで立て直されていない');
    B((r.strikes.terrain || 0) >= 1 && r.terrainSame, `terrain の onBeforeCompile が terrain に数えられていない（${JSON.stringify(r.strikes)}）`);
    B(!r.disabled.includes('terrain'), 'terrain が無効化された（1 回で止めすぎ）');
    B(r.rendered === r.frameIndex && r.diff > 30, `カメラを回しても絵が変わらない（diff ${r.diff}）`);
    B(r.console.errors === 0 && r.console.pageErrors === 0, `console のエラー ${r.console.errors}・ページ例外 ${r.console.pageErrors}`);
  }
  out.fail = bad;
  fs.writeFileSync(path.join(h.out, 'fault-inject.json'), JSON.stringify(out, null, 1));
  if (bad.length) throw new Error(`fault-inject: ${bad.length} 件の不合格\n  ` + bad.join('\n  '));
  console.log('fault-inject: 合格（全モジュールで、フレームの完走・描画の後ろの MP ラッパー・画面の維持）');
}
