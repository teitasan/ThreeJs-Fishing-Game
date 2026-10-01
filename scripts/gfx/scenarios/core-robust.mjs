/* ===========================================================
   描画の芯の頑丈さ（lab/core.html で実機の GPU に対して確かめる）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/core-robust.mjs --out DIR
   - prepare / renderReflection の冪等（同じフレームで 2 回呼んでも描画の回数が増えない）
   - late 物体（ゲームの半透明）の visible の退避と復元、ライトの layers.enableAll
   - 0.1〜0.4m の低い遮蔽物も近景の影を落とす（bias が世界の長さで小さい）
   - 太陽が回っても桟橋の位置で近景の影の縁がざわつかない（スナップの基準点が注視点の近く）
   - 品質の切り替え（high → mid → low → high）でライトの数・castShadow・影の種類が変わらない
   - 故障の注入：モジュールの update / prepare が投げてもフレームは完走し、3 回で無効化してスタブで立て直す
   - 止まったパス（不透明）は間を空けて試し直して戻る
   - ngCutout（A2C）が MSAA の無い RT でも抜く・ngExtendStandard の鍵がモジュールの名前空間の中
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

  /* 近景の影マップに物が入っていること（three は影の物体を render() のカメラの layers で判定するので、
     何も描かない tick カメラのままだと影マップが空になる。shadows.js の renderNear） */
  await run('shadow', () => {
    const L = window.__lab, g = L.gfx, r = L.renderer;
    L.cam('dock-3p'); L.setHour(12); L.freeze(10); L.tick(3);
    const map = g.rig.key?.shadow?.map;
    if (!map) return [['近景の影マップがある', false, 'map なし']];
    const n = 64, x = (map.width - n) >> 1, y = (map.height - n) >> 1;
    const px = new Uint8Array(n * n * 4);
    r.readRenderTargetPixels(map, x, y, n, n, px);
    let occ = 0;
    for (let k = 0; k < px.length; k += 4) if (px[k] < 255 || px[k + 1] < 255 || px[k + 2] < 255) occ++;
    return [['近景の影マップの中央（注視点 = 釣り人・桟橋）に遮蔽物が描かれている', occ > 16, `${occ}/${n * n} 画素`]];
  });

  /* 低い遮蔽物も影を落とす（bias は世界の長さ 4cm。以前の −0.0004 は far 1500m で 0.6m に当たり、足元の影が消えた）。
     桟橋の先の水の上 2m に白い受け板、その上 0.1m・0.2m・0.4m に «影だけ» の板（SHADOW_ONLY 層）を浮かべ、
     受け板の上の影の位置と日向の輝度（sceneColor、露出前）を比べる */
  await run('shadow-bias', () => {
    const L = window.__lab, g = L.gfx, T = g.THREE, r = L.renderer, D = L.dock;
    L.setHour(12.5); L.setWeather('clear', { instant: true }); L.freeze(10);
    const dir = new T.Vector3(D.dockDir.x, 0, D.dockDir.z).normalize();
    const c = new T.Vector3(D.dockEnd.x, 2, D.dockEnd.z).addScaledVector(dir, 6);
    const right = new T.Vector3(dir.z, 0, -dir.x);
    const grp = new T.Group();
    const recv = new T.Mesh(new T.PlaneGeometry(7, 3).rotateX(-Math.PI / 2), new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }));
    recv.position.copy(c);
    recv.receiveShadow = true;
    grp.add(recv);
    const hs = [0.1, 0.2, 0.4];
    const occ = hs.map((hgt, i) => {
      const m = new T.Mesh(new T.PlaneGeometry(0.6, 0.6).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ side: T.DoubleSide }));
      m.position.copy(c).addScaledVector(right, (i - 1) * 2.2).add(new T.Vector3(0, hgt, 0));
      m.castShadow = true;
      m.layers.set(8);   // SHADOW_ONLY：影だけ
      grp.add(m);
      return m;
    });
    L.scene.add(grp);
    L.cam({ pos: [c.x - dir.x * 4, c.y + 5, c.z - dir.z * 4], target: [c.x, c.y, c.z] });
    L.tick(4);
    const kd = g.f.keyDir, cam = L.camera, rt = g.targets.copy;
    const half = (v) => { const e = (v >> 10) & 31, f = v & 1023; return e === 0 ? f * 2 ** -24 : e === 31 ? NaN : (1 + f / 1024) * 2 ** (e - 15) * (v & 0x8000 ? -1 : 1); };
    const lum = (p) => {
      const v = p.clone().project(cam);
      const x = Math.round((v.x * 0.5 + 0.5) * rt.width), y = Math.round((v.y * 0.5 + 0.5) * rt.height);
      const buf = new Uint16Array(4 * 9);
      r.readRenderTargetPixels(rt, x - 1, y - 1, 3, 3, buf, undefined, 0);
      let s = 0;
      for (let k = 0; k < buf.length; k += 4) s += 0.2126 * half(buf[k]) + 0.7152 * half(buf[k + 1]) + 0.0722 * half(buf[k + 2]);
      return s / 9;
    };
    const lit = lum(c.clone().addScaledVector(dir, -1.1));
    const res = occ.map((m, i) => {
      const p = m.position.clone().addScaledVector(kd, -hs[i] / Math.max(kd.y, 0.05));
      p.y = c.y;
      return +(lum(p) / Math.max(lit, 1e-6)).toFixed(3);
    });
    L.scene.remove(grp);
    grp.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    return [
      ['0.1m・0.2m・0.4m の高さの遮蔽物が影を落とす（影の輝度 / 日向 < 0.6）', res.every((x) => x < 0.6), `${res.join(' / ')}（日向 ${lit.toFixed(3)}、bias ${g.rig.key.shadow.bias.toExponential(2)}、far ${g.rig.key.shadow.camera.far}）`],
    ];
  });

  /* 太陽が回っても近景の影の縁がざわつかない（テクセルスナップの格子は注視点の近くの基準点に固定。
     原点に固定すると原点から 88m の桟橋で毎フレーム 0.2 テクセル滑る）。
     桟橋の先の受け板に «影だけ» の細い柱 36 本、カメラ固定で時刻を 1/3600h（60fps の 1 フレーム分）ずつ進め、
     連続フレームで sceneColor の G が 0.2 以上変わった画素を数える */
  await run('shadow-shimmer', () => {
    const L = window.__lab, g = L.gfx, T = g.THREE, r = L.renderer, D = L.dock;
    L.setWeather('clear', { instant: true }); L.freeze(100);
    const dir = new T.Vector3(D.dockDir.x, 0, D.dockDir.z).normalize();
    const c = new T.Vector3(D.dockEnd.x, 2, D.dockEnd.z).addScaledVector(dir, 8);
    const grp = new T.Group();
    const recv = new T.Mesh(new T.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }));
    recv.position.copy(c); recv.receiveShadow = true; grp.add(recv);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      const p = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 2, 8), new T.MeshStandardMaterial());
      p.position.set(c.x - 4 + i * 1.5, c.y + 1, c.z - 4 + j * 1.5); p.rotation.z = 0.3; p.castShadow = true; p.layers.set(8); grp.add(p);
    }
    L.scene.add(grp);
    L.cam({ pos: [c.x, c.y + 8, c.z + 0.01], target: [c.x, c.y, c.z] });
    let hour = 15; L.setHour(hour); L.tick(6);
    const read = () => { const t = g.targets.copy, b = new Uint16Array(t.width * t.height * 4); r.readRenderTargetPixels(t, 0, 0, t.width, t.height, b, undefined, 0); return b; };
    const half = (v) => { const e = (v >> 10) & 31, f = v & 1023; return e === 0 ? f * 2 ** -24 : (1 + f / 1024) * 2 ** (e - 15); };
    let prev = read();
    const steps = [];
    for (let k = 0; k < 6; k++) {
      hour += 1 / 3600; L.setHour(hour); L.tick(1);
      const cur = read();
      let n = 0;
      for (let i = 1; i < cur.length; i += 4) if (Math.abs(half(cur[i]) - half(prev[i])) > 0.2) n++;
      steps.push(n); prev = cur;
    }
    const A = g.shadows.snapAnchor, F = g.shadows.focus;
    L.scene.remove(grp);
    grp.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    const t = g.targets.copy, lim = Math.round(t.width * t.height * 0.0008);   // 1280×720 で 737px（基準点 12.7m で ≈430、原点に固定した旧版は ≈930）
    return [
      ['時刻を 1 フレーム進めても影の縁の変化が小さい（桟橋の位置）', Math.max(...steps) < lim,
        `${steps.join(',')} px（上限 ${lim}、注視点の原点からの距離 ${Math.hypot(F.x, F.z).toFixed(0)}m、基準点まで ${Math.hypot(F.x - A.x, F.z - A.z).toFixed(1)}m）`],
    ];
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
      /* 上限は quality.js の NG_PROGRAM_BUDGET（統合者の決定：total 90・1 モジュール 6） */
      ['プログラムの総数 ≤ 90（段の往復の後も）', Math.max(...progs) <= 90, progs.join(',')],
      ['1 モジュールのプログラム ≤ 6', Object.entries(L.programAudit().byModule).every(([id, n]) => id === 'game' || id === 'core' || n <= 6), JSON.stringify(L.programAudit().byModule)],
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

  /* 止まったパスは試し直す（不透明パスをセッション中に失わない。safe.js の guardPass） */
  await run('pass-retry', () => {
    const L = window.__lab, g = L.gfx, p = g.pipeline;
    L.cam('dock-3p'); L.freeze(10); L.tick(2);
    const orig = p._beforePass;
    let n = 0;
    p._beforePass = function (id, cam) { if (id === 0 && n < 2) { n++; throw new Error('注入：不透明パスの例外'); } return orig.call(this, id, cam); };
    let errors = 0;
    try { L.tick(3); } catch (e) { errors++; }
    const deadAfter = g.safety.deadPasses.has('opaque');
    try { L.tick(40); } catch (e) { errors++; }
    p._beforePass = orig;
    return [
      ['不透明パスが 2 回落ちたら止まる', deadAfter, [...g.safety.deadPasses].join(',')],
      ['止めた不透明パスは試し直して戻る', !g.safety.deadPasses.has('opaque') && p.state.rendered === p.state.frameIndex, [...g.safety.deadPasses].join(',')],
      ['例外がフレームの外へ出ない', errors === 0, errors],
    ];
  });

  /* マテリアルの口：ngCutout は MSAA の無い RT（反射・インポスターの撮影）でも抜ける。ngExtendStandard の鍵は
     モジュールの名前空間の中（別のモジュールの同じ key が同じプログラムを共有しない） */
  await run('materials', async () => {
    const { ngExtendStandard, ngCutout } = await import('/src/gfx/core/extend.js');
    const L = window.__lab, g = L.gfx, T = g.THREE, R = L.renderer;
    const tex = new T.DataTexture(new Uint8Array([200, 200, 200, 0, 200, 200, 200, 255]), 2, 1, T.RGBAFormat);
    tex.magFilter = tex.minFilter = T.NearestFilter; tex.needsUpdate = true;
    const mat = ngExtendStandard(new T.MeshStandardMaterial({ map: tex, side: T.DoubleSide }), { key: 'robust-card', module: 'robust' });
    ngCutout(mat, g.quality.profile);
    const sc = new T.Scene(); sc.add(new T.Mesh(new T.PlaneGeometry(2, 2), mat), new T.AmbientLight(0xffffff, 1));
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); cam.position.z = 5; cam.layers.enableAll();
    const count = (rt) => {
      R.setRenderTarget(rt); R.setClearColor(0x000000, 0); R.clear(); R.setRenderTarget(null);
      g.forge.renderView(rt, 0, sc, cam);
      const px = new Uint8Array(64 * 64 * 4);
      R.readRenderTargetPixels(rt, 0, 0, 64, 64, px);
      let left = 0, right = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (px[(y * 64 + x) * 4] > 0) { if (x < 32) left++; else right++; }
      return { left, right };
    };
    const single = new T.WebGLRenderTarget(64, 64), msaa = new T.WebGLRenderTarget(64, 64, { samples: 4 });
    const s1 = count(single), s4 = count(msaa);
    const mk = (module, rgb) => ngExtendStandard(new T.MeshStandardMaterial({ color: 0xffffff }), {
      key: 'robust-leaf', module, fragment: { surface: `diffuseColor.rgb = vec3(${rgb});` } });
    const a = new T.Mesh(new T.PlaneGeometry(1, 2), mk('trees', '1.0, 0.0, 0.0'));
    const b = new T.Mesh(new T.PlaneGeometry(1, 2), mk('shoreflora', '0.0, 1.0, 0.0'));
    a.position.x = -0.5; b.position.x = 0.5;
    const sc2 = new T.Scene(); sc2.add(a, b, new T.AmbientLight(0xffffff, 3));
    R.setRenderTarget(single); R.setClearColor(0, 0); R.clear(); R.render(sc2, cam); R.setRenderTarget(null);
    const px = new Uint8Array(64 * 64 * 4); R.readRenderTargetPixels(single, 0, 0, 64, 64, px);
    const at = (x) => Array.from(px.slice((32 * 64 + x) * 4, (32 * 64 + x) * 4 + 3));
    const pa = R.properties.get(a.material).currentProgram, pb = R.properties.get(b.material).currentProgram;
    const left = at(16), right = at(48);
    for (const m of [mat, a.material, b.material]) m.dispose();
    single.dispose(); msaa.dispose(); tex.dispose();
    R.resetState();
    return [
      ['ngCutout（high は A2C）が MSAA の無い RT で透明の半分を抜く', g.quality.profile.msaa === 0 || (mat.alphaToCoverage && s1.left === 0 && s1.right > 1500), `A2C ${mat.alphaToCoverage}・alphaTest ${mat.alphaTest}・単一 ${JSON.stringify(s1)}`],
      ['ngCutout が MSAA の RT でも抜く', s4.left === 0 && s4.right > 1500, JSON.stringify(s4)],
      ['別のモジュールの同じ key は別のプログラム', pa && pb && pa !== pb && left[0] > 100 && left[1] < 30 && right[1] > 100 && right[0] < 30, `trees ${left}・shoreflora ${right}`],
    ];
  });

  /* 水中の流れ：game.js が渡す Vector3（y = 0）の z を落とさない。lab も game.js と同じ流れを入れる */
  await run('flow', () => {
    const L = window.__lab, g = L.gfx, T = g.THREE;
    L.tick(1);
    const lab = [g.f.flowDir.x, g.f.flowDir.y, g.f.flowStrength];
    g.setFlow(new T.Vector3(-0.315, 0, 0.949), 0.5);
    const v3 = [g.f.flowDir.x, g.f.flowDir.y];
    g.setFlow(new T.Vector2(0.6, 0.8), 0.2);
    const v2 = [g.f.flowDir.x, g.f.flowDir.y];
    L.tick(1);
    const d = L.dock.dockDir;
    return [
      ['Vector3 の流れの z が f.flowDir.y に入り、単位ベクトルになる', Math.abs(v3[0] + 0.315) < 0.01 && Math.abs(v3[1] - 0.949) < 0.01 && Math.abs(Math.hypot(...v3) - 1) < 1e-6, v3.map((x) => x.toFixed(3)).join(',')],
      ['Vector2 の流れはそのまま', Math.abs(v2[0] - 0.6) < 1e-6 && Math.abs(v2[1] - 0.8) < 1e-6, v2.join(',')],
      ['lab は桟橋の向きの流れを入れる', lab[2] > 0.03 && Math.abs(lab[0] * d.x + lab[1] * d.z - 1) < 1e-3, lab.map((x) => x.toFixed(3)).join(',')],
    ];
  });

  /* lab の ctx.terrain は本編の Terrain と同じ読むだけの項目を持つ（CORE_API §3.3・§10.2） */
  await run('ctx-terrain', () => {
    const L = window.__lab, c = L.gfx._ctx(), t = c.terrain, d = L.dock;
    const mid = { x: (d.dockStart.x + d.dockEnd.x) / 2, z: (d.dockStart.z + d.dockEnd.z) / 2 };
    const ok = !!t && t.dockY === d.dockY && t.dockDir.isVector3 && t.spawnPos.isVector3 && Math.abs(t.heightAt(3, 4) - L.lake.heightAt(3, 4)) < 1e-9
      && t.onDock(mid.x, mid.z) !== false && t.onDock(mid.x, mid.z) !== null && t.heightTexture === c.heightfield.uniforms.ngHeightNear.value;
    return [['lab の ctx.terrain が dockY・dockDir・heightAt・onDock・heightTexture を持つ', ok, t ? `dockY ${t.dockY}・onDock ${t.onDock(mid.x, mid.z)}` : 'null']];
  });

  /* post のスタブが services.underwater.createEffect() の Effect を鎖の先頭に差し込み、service が差し替わったら引き直す */
  await run('post-underwater', async () => {
    const { Effect, EffectAttribute } = await import('postprocessing');
    const L = window.__lab, g = L.gfx, R = L.renderer, gl = R.getContext();
    const prev = g.services.underwater;
    let calls = 0;
    const fx = new Effect('NgRobustUw', `void mainImage(const in vec4 c, const in vec2 uv, const in float depth, out vec4 o) { o = vec4(depth < 1.0 ? 4.0 : 0.0, 0.0, 0.0, 1.0); }`,
      { attributes: EffectAttribute.DEPTH });
    g.services.provide('underwater', { ...prev, createEffect: () => { calls++; return fx; } });
    L.cam('dock-3p'); L.freeze(10);
    L.tick(4);
    const px = new Uint8Array(4);
    R.setRenderTarget(null);
    gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // 下：桟橋（深度 < 1）
    const sky = new Uint8Array(4);
    gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight - 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sky);   // 上：空（深度 = 1）
    const post = g.modules.get('post');
    const inChain = post?.main?.effects?.[0] === fx;
    g.services.underwater = prev;   // 元の service へ（差し替わったので外れる）
    L.tick(2);
    const removed = !post?.main?.effects?.includes(fx);
    return [
      ['createEffect の Effect が鎖の先頭に入り、深度付きで描かれる', inChain && px[0] > px[1] + 50 && px[0] > px[2] + 50 && Math.max(sky[0], sky[1], sky[2]) < 30,
        `先頭 ${inChain}・桟橋 ${Array.from(px)}・空 ${Array.from(sky)}（露出と AgX の後）`],
      ['createEffect は service のオブジェクトにつき 1 回', calls === 1, calls],
      ['service が差し替わると外れる', removed, ''],
    ];
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
