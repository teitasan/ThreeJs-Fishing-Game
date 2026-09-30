/* ===========================================================
   描画の芯の頑丈さ（lab/core.html で実機の GPU に対して確かめる）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/core-robust.mjs --out DIR
   - prepare / renderReflection の冪等（同じフレームで 2 回呼んでも描画の回数が増えない）
   - late 物体（ゲームの半透明）の visible の退避と復元、ライトの layers.enableAll
   - 品質の切り替え（high → mid → low → high）でライトの数・castShadow・影の種類が変わらない
   - 故障の注入：モジュールの update / prepare が投げてもフレームは完走し、3 回で無効化してスタブで立て直す
   - WebGL の文脈の喪失と復帰：喪失中のフレームが例外にならず、復帰後に NaN の無い絵に戻る
   - サンプラーの上限（fragment ≤ 12・vertex ≤ 4）と全プログラムのリンク、本物の createFishMaterial の caustics
   すべての判定を console に PASS / FAIL で出し、FAIL があれば終了コード 1
   =========================================================== */
export default async function (h) {
  await h.open('lab/core.html?capture=1&tier=high');
  await h.waitFor(() => window.__gfxReady === true, undefined, 180);
  const results = [];
  const run = async (name, fn, arg) => {
    const r = await h.eval(fn, arg);
    for (const [k, ok, info] of r) results.push([`${name}: ${k}`, ok, info]);
  };

  await run('idempotent', () => {
    const L = window.__lab, g = L.gfx, r = L.renderer, p = g.pipeline;
    L.cam('dock-3p'); L.freeze(10); L.tick(3);
    const calls = (fn) => { r.info.reset(); fn(); return r.info.render.calls; };
    const f = { dt: 0, hour: 12, camera: L.camera, weather: { key: 'clear', cloud: 0.14, rain: 0 }, sunDir: L.camera.up, keyDir: L.camera.up, nightAmount: 0 };
    g.beginFrame(f);
    const once = calls(() => { p.prepare(); p.renderReflection(); });
    const twice = calls(() => { p.prepare(); p.renderReflection(); });
    const main1 = calls(() => p.renderMain(0));
    const main2 = calls(() => p.renderMain(0));
    return [
      ['prepare + renderReflection の 2 回目は何も描かない', twice === 0, `${once} → ${twice}`],
      ['renderMain の 2 回目は何も描かない', main1 > 0 && main2 === 0, `${main1} → ${main2}`],
    ];
  });

  await run('programs', () => {
    const L = window.__lab;
    L.cam('noon-fp-down'); L.tick(3);
    const a = L.programAudit(), f = L.fishCheck();
    const worst = a.programs.reduce((m, p) => (p.frag > m.frag ? p : m), { frag: 0 });
    return [
      ['全プログラムのサンプラーが上限内', a.over.length === 0, `${a.count} 本、fragment 最大 ${worst.frag}（${worst.tag}）${a.over.map((o) => o.tag).join(',')}`],
      ['全プログラムがリンクできた', a.failed.length === 0, a.failed.map((o) => o.tag).join(',')],
      ['本物の魚のマテリアルが caustics 付きで動く', f.present && f.runnable && f.causticLight && f.sharesFrame && f.sameCausticsTex, JSON.stringify(f)],
    ];
  });

  await run('late', () => {
    const L = window.__lab, g = L.gfx, T = g.THREE;
    const m = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.5 }));
    m.position.set(L.camera.position.x, L.camera.position.y, L.camera.position.z - 3);
    L.scene.add(m);
    const hidden = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ transparent: true }));
    hidden.visible = false;
    L.scene.add(hidden);
    const key = g.rig.key;
    key.layers.set(0);                 // ゲームがうっかりライトの層を絞っても
    L.tick(2);
    const out = [
      ['late 物体は描いた後も visible', m.visible === true, ''],
      ['隠れていた late 物体は隠れたまま', hidden.visible === false, ''],
      ['late 物体に LATE 層が付く', m.layers.isEnabled(6), m.layers.mask],
      ['ライトは毎フレーム全層に戻る', key.layers.mask === 0xffffffff || key.layers.mask === -1, key.layers.mask],
    ];
    L.scene.remove(m, hidden);
    return out;
  });

  await run('quality', () => {
    const L = window.__lab, g = L.gfx;
    const lights = () => { const a = []; L.scene.traverse((o) => { if (o.isLight) a.push(`${o.type}:${o.castShadow}`); }); return a.join(','); };
    const before = lights(), type = L.renderer.shadowMap.type;
    const seq = ['mid', 'low', 'high', 'mid', 'high'];
    const progs = [];
    for (const t of seq) { L.setTier(t); L.tick(3); progs.push(L.renderer.info.programs.length); }
    const after = lights();
    return [
      ['ライトの数と castShadow が変わらない', before === after, `${before} | ${after}`],
      ['影の種類が変わらない', type === L.renderer.shadowMap.type, type],
      ['戻した段で NaN が無い', L.nanCheck() === 0, ''],
      ['プログラムの総数 ≤ 60', Math.max(...progs) <= 60, progs.join(',')],
    ];
  });

  await run('fault', () => {
    const L = window.__lab, g = L.gfx;
    const w = g.modules.get('water'), t = g.modules.get('trees');
    const origU = w.update, origP = t.prepare;
    let errors = 0;
    w.update = () => { throw new Error('注入した update の例外'); };
    t.prepare = () => { throw new Error('注入した prepare の例外'); };
    try { L.tick(5); } catch (e) { errors++; }
    const out = [
      ['注入した例外でフレームが止まらない', errors === 0, errors],
      /* 3 回で無効化 → 隠して外し、新しいスタブで立て直す（index.js の _onModuleDisabled） */
      ['3 回投げた water は外されてスタブで立て直される', w.root.visible === false && g.modules.get('water') !== w && g._restarts.get('water') === 1, [...g.safety.disabled].join(',')],
      ['trees も同じ', g.modules.get('trees') !== t && g._restarts.get('trees') === 1, ''],
    ];
    w.update = origU; t.prepare = origP;
    L.tick(2);
    return out;
  });

  const lost = await h.eval(async () => {
    const L = window.__lab, gl = L.renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (!ext) return [['WEBGL_lose_context が無い（確かめられない）', true, '']];
    let errors = 0;
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 200));
    try { L.tick(5); } catch (e) { errors++; }
    const stopped = L.gfx.pipeline.state.lost === true;
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 1500));
    try { L.tick(10); } catch (e) { errors++; }
    return [
      ['喪失中のフレームが例外にならない', errors === 0, errors],
      ['喪失を pipeline が知る', stopped, ''],
      ['復帰で描画に戻る', L.gfx.pipeline.state.lost === false, ''],
      ['復帰後の絵に NaN が無い', L.nanCheck() === 0, ''],
    ];
  });
  for (const [k, ok, info] of lost) results.push([`context: ${k}`, ok, info]);
  await h.eval(() => { window.__lab.tick(5); });
  await h.shot('after-restore');

  let fail = 0;
  for (const [k, ok, info] of results) {
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${k}${info !== '' && info !== undefined ? `（${info}）` : ''}`);
  }
  console.log(`core-robust: ${results.length - fail}/${results.length}`);
  if (fail) throw new Error(`core-robust: ${fail} 件失敗`);
}
