/* ===========================================================
   G0：本編（index.html）の遊びの流れをグレーボックスで一通り通す
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/g0-gameplay.mjs --out DIR [--size 1280x720]
   環境変数：TIERS=low,mid,high（既定は 3 段）、SEED=123456789、FISH_PLACE=1（桟橋から見える魚を必ず置き直す道を通す）
   各段について «その品質で起動»（セーブに品質を書いてから開く）し、次を確かめて撮る：
     1. 読み込みが終わる・start が効く・core の段が起動の品質と一致・全モジュールが居る
     2. 歩く（KeyW を押して 2 秒）：位置が進み、桟橋の床の高さに立つ
     3. 投げる（ため → 目印のパワーで離す）→ 着水 → «待ち»。ウキの y = water.surfaceY
     4. ウキの近接：真上から見下ろしたカメラで、描いた水面の深度から世界の y を戻し、
        CPU の surfaceY と比べる（中央値 < 5mm、ウキ・糸の画素は外す）
     5. アタリを早めて魚を寄せ、桟橋から水越しに魚を撮る（屈折）
     6. アワセ → ファイト → 水中カメラ（V）→ 戻す
     7. F3 のデバッグ表示（当たりの箱・障害物の円）を桟橋の上から撮る。例外が出ないこと
   結果は DIR/g0-gameplay.json。どれかが落ちたら例外で止める（shot.mjs が _failure.png を撮る）
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

/* ページ内：game.update を n 回（dt 固定）。pred が真になったら止めて回数を返す */
async function run(h, n, dt = 1 / 30, predSrc = null) {
  return h.eval(({ n, dt, predSrc }) => {
    const g = window.__game;
    const pred = predSrc ? new Function('g', `return (${predSrc});`) : null;
    for (let i = 0; i < n; i++) {
      g.update(dt);
      if (pred && pred(g)) return i + 1;
    }
    return pred ? -1 : n;
  }, { n, dt, predSrc });
}

/* ページ内：描いた水面の高さの読み戻し。カメラを (x, y0 + 3, z) から真下へ向けて 1 フレーム描き、
   mainRT の深度（水面は late パスで深度を書く）から画素ごとに世界の位置を戻して surfaceY と比べる */
async function surfaceReadback(h) {
  return h.eval(async () => {
    const g = window.__game;
    const { getGfx } = await import('/src/gfx/core/index.js');
    const gfx = getGfx();
    const THREE = gfx.THREE;
    const b = g.bobber.clone();
    const cam = g.camera;
    const saved = g._updateCamera;
    g._updateCamera = function () {
      cam.position.set(b.x + 0.001, b.y + 3, b.z + 0.001);
      cam.up.set(0, 0, -1);
      cam.lookAt(b.x, b.y, b.z);
      cam.updateMatrixWorld();
    };
    try {
      g.update(1 / 60);
      g.update(1 / 60);
    } finally {
      g._updateCamera = saved;
      cam.up.set(0, 1, 0);
    }
    const r = gfx.renderer, t = gfx.targets;
    const N = 17;
    const rt = new THREE.WebGLRenderTarget(N, N, { type: THREE.FloatType, depthBuffer: false });
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'in vec3 position; out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'precision highp float; uniform highp sampler2D tDepth; in vec2 vUv; out vec4 o;'
        + 'void main(){ vec2 uv = 0.5 + (vUv - 0.5) * 0.7; o = vec4(texture(tDepth, uv).r, uv, 1.0); }',
      uniforms: { tDepth: { value: t.main.depthTexture } }, depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)), mat);
    quad.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(quad);
    const oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt); r.render(sc, oc); r.setRenderTarget(prev);
    const px = new Float32Array(N * N * 4);
    r.readRenderTargetPixels(rt, 0, 0, N, N, px);
    rt.dispose(); mat.dispose(); quad.geometry.dispose();
    const inv = new THREE.Matrix4().copy(cam.projectionMatrixInverse);
    const errs = [], rej = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < N * N; i++) {
      const d = px[i * 4], u = px[i * 4 + 1], v = px[i * 4 + 2];
      if (!(d < 1)) continue;
      p.set(u * 2 - 1, v * 2 - 1, d * 2 - 1).applyMatrix4(inv).applyMatrix4(cam.matrixWorld);
      const want = g.water.surfaceY(p.x, p.z);
      const e = p.y - want;
      /* ウキ・糸・竿は水面より上に居る。4cm 以上浮いた画素は水面ではない */
      if (e > 0.04) { rej.push(+e.toFixed(3)); continue; }
      errs.push(Math.abs(e));
    }
    errs.sort((a, b2) => a - b2);
    const med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
    return {
      samples: errs.length, rejected: rej.length, medianMm: med == null ? null : +(med * 1000).toFixed(2),
      p95Mm: errs.length ? +(errs[Math.floor(errs.length * 0.95)] * 1000).toFixed(2) : null,
      maxMm: errs.length ? +(errs[errs.length - 1] * 1000).toFixed(2) : null,
      bobberY: +g.bobber.y.toFixed(4), surfaceAtBobber: +g.water.surfaceY(g.bobber.x, g.bobber.z).toFixed(4),
      waterTime: +g.water.time.toFixed(3),
    };
  });
}

export default async function (h) {
  const tiers = list(process.env.TIERS, ['low', 'mid', 'high']);
  const seed = Number(process.env.SEED) || 123456789;
  const out = { seed, tiers: {} };
  const fail = [];
  const expect = (ok, msg) => { if (!ok) { fail.push(msg); console.log('  NG', msg); } };

  for (const tier of tiers) {
    console.log(`== ${tier}`);
    const T = { };
    out.tiers[tier] = T;
    const c0 = h.counts();
    await h.bootGame({ quality: null, bootQuality: tier, seed, start: false });
    T.load = await h.eval(() => {
      const m = window.__loadMarks || [];
      const t0 = m.find((x) => x.label !== 'nav')?.t ?? 0;
      return m.map((x) => ({ label: x.label, ms: Math.round(x.t - t0) }));
    });
    await h.eval(() => window.__game.start(true));
    await h.sleep(500);
    await h.hideHud();
    const boot = await h.eval(async () => {
      const g = window.__game;
      const { getGfx } = await import('/src/gfx/core/index.js');
      const gfx = getGfx();
      g.state.clock = 12;
      g.env.setWeather('clear', { instant: true });
      return {
        playing: !!g.playing, settings: g.state.settings.quality, tier: gfx.quality.tier, msaa: gfx.quality.profile.msaa,
        postAA: gfx.quality.profile.postAA, ready: gfx.ready, degraded: gfx.degraded || null,
        modules: [...gfx.modules.keys()], seed: g.state.seed, fish: g.school.fishes.filter((f) => f.active).length,
        programs: gfx.renderer.info.programs.length,
      };
    });
    T.boot = boot;
    console.log('  boot', JSON.stringify(boot));
    expect(boot.playing, `${tier}: start でゲームが始まらない`);
    expect(boot.tier === tier, `${tier}: core の段が ${boot.tier}`);
    expect(boot.ready, `${tier}: gfx.ready でない`);
    expect(boot.modules.length === 10, `${tier}: モジュールが ${boot.modules.length} 個`);
    expect(boot.seed === seed, `${tier}: 湖のシードが ${boot.seed}`);

    /* 2. 歩く：スポーン（桟橋の上）から湖の方へ 2 秒 */
    const walk = await h.eval(() => {
      const g = window.__game;
      const t = g.terrain, dir = t.dockDir;
      g.fs = 'idle';
      g.pos.set(t.spawnPos.x - dir.x * 4, t.dockY, t.spawnPos.z - dir.z * 4);
      g.yaw = Math.atan2(dir.x, dir.z);
      g.pitch = -0.06;
      g._setFirstPerson?.(false, true);
      g.update(1 / 30);
      const a = g.pos.clone();
      g.keys.add('KeyW');
      for (let i = 0; i < 60; i++) g.update(1 / 30);
      g.keys.delete('KeyW');
      for (let i = 0; i < 10; i++) g.update(1 / 30);
      const d = Math.hypot(g.pos.x - a.x, g.pos.z - a.z);
      return { moved: +d.toFixed(2), onDock: t.onDock(g.pos.x, g.pos.z), y: +g.pos.y.toFixed(3), dockY: t.dockY };
    });
    T.walk = walk;
    console.log('  walk', JSON.stringify(walk));
    expect(walk.moved > 3, `${tier}: 歩いても ${walk.moved}m しか進まない`);
    expect(walk.onDock !== null && Math.abs(walk.y - walk.dockY) < 1e-6, `${tier}: 桟橋の床の高さに立っていない`);
    await h.shot(`${tier}-walk-3p`);

    /* 3. 投げる：桟橋の先から、目印のパワーでキャスト → 待ち */
    const cast = await h.eval(() => {
      const g = window.__game;
      const t = g.terrain, dir = t.dockDir;
      g.pos.set(t.dockEnd.x - dir.x * 1.2, t.dockY, t.dockEnd.z - dir.z * 1.2);
      g.yaw = Math.atan2(dir.x, dir.z) + 0.15;
      /* 浅いタナ・近めに投げる（桟橋から水越しに魚が見える距離） */
      g.setRigLayer?.('top');
      g.pitch = -0.5;
      for (let i = 0; i < 5; i++) g.update(1 / 30);
      g._actionDown();
      for (let i = 0; i < 8; i++) g.update(1 / 30);
      const fs0 = g.fs;
      g.charge = g.targetPower ?? 0.6;
      g._actionUp();
      return { fs0, fs1: g.fs, target: g.targetPower, aimDist: g.aimDist };
    });
    const nWait = await run(h, 400, 1 / 30, "g.fs === 'wait'");
    const waitState = await h.eval(() => {
      const g = window.__game;
      for (let i = 0; i < 20; i++) g.update(1 / 30);
      const b = g.bobber;
      return {
        fs: g.fs, bobber: [b.x, b.y, b.z].map((v) => +v.toFixed(3)), surfaceY: +g.water.surfaceY(b.x, b.z).toFixed(4),
        depth: +g.terrain.depthAt(b.x, b.z).toFixed(2), dist: +Math.hypot(b.x - g.pos.x, b.z - g.pos.z).toFixed(2),
      };
    });
    T.cast = { ...cast, framesToWait: nWait, ...waitState };
    console.log('  cast', JSON.stringify(T.cast));
    expect(cast.fs0 === 'charge' && cast.fs1 === 'flight', `${tier}: ため → 飛行にならない（${cast.fs0} → ${cast.fs1}）`);
    expect(nWait > 0 && waitState.fs === 'wait', `${tier}: 着水して «待ち» にならない（${waitState.fs}）`);
    await h.shot(`${tier}-wait-3p`);

    /* 4. ウキの近接：描いた水面と CPU の surfaceY */
    const rb = await surfaceReadback(h);
    T.surface = rb;
    console.log('  surface', JSON.stringify(rb));
    expect(rb.samples > 100 && rb.medianMm < 5 && rb.p95Mm < 15, `${tier}: 描いた水面と surfaceY がずれる（${JSON.stringify(rb)}）`);
    expect(Math.abs(rb.bobberY - rb.surfaceAtBobber) < 0.03, `${tier}: ウキが水面に乗っていない（${rb.bobberY} / ${rb.surfaceAtBobber}）`);
    /* 10 時間遊んだ後でも GPU と CPU の波がずれない（波の位相を ngFrame で渡す：core-requests B-2） */
    await h.eval(() => { window.__game.water.time += 36000; });
    const rb10 = await surfaceReadback(h);
    T.surface10h = rb10;
    console.log('  surface +10h', JSON.stringify(rb10));
    expect(rb10.samples > 100 && rb10.medianMm < 5 && rb10.p95Mm < 15, `${tier}: 10 時間後に描いた水面と surfaceY がずれる（${JSON.stringify(rb10)}）`);
    /* 近接の絵：ウキの斜め上 1.6m から */
    await h.eval(() => {
      const g = window.__game, cam = g.camera, b = g.bobber.clone(), dir = g.terrain.dockDir;
      g.__savedCam = g._updateCamera;
      g._updateCamera = function () {
        cam.position.set(b.x - dir.x * 1.6, 0.9, b.z - dir.z * 1.6);
        cam.lookAt(b.x, b.y, b.z);
        cam.updateMatrixWorld();
      };
      for (let i = 0; i < 4; i++) g.update(1 / 60);
    });
    await h.shot(`${tier}-bobber-close`);
    await h.eval(() => { const g = window.__game; g._updateCamera = g.__savedCam; delete g.__savedCam; });

    /* 5. 魚を寄せる（アタリの抽選を早める）→ 桟橋から一人称で見下ろして水越しに撮る */
    await h.eval(() => {
      const g = window.__game;
      g._setFirstPerson?.(true, true);
      const b = g.bobber, dx = b.x - g.pos.x, dz = b.z - g.pos.z;
      g.yaw = Math.atan2(dx, dz);
      g.pitch = -Math.atan2(g.terrain.dockY + 1.6, Math.hypot(dx, dz));
      g.biteTimer = 0;
    });
    const nNear = await run(h, 1500, 1 / 30,
      "g.hookFish && Math.hypot(g.hookFish.pos.x - g.bobber.x, g.hookFish.pos.z - g.bobber.z) < 2.5 || g.fs === 'bite'");
    const fishInfo = await h.eval(() => {
      const g = window.__game, f = g.hookFish;
      if (!f) return { fs: g.fs, hook: null };
      /* 一人称の目から魚へ向ける（目の高さ ≈ 床 + 1.6m） */
      const dx = f.pos.x - g.pos.x, dz = f.pos.z - g.pos.z;
      g.yaw = Math.atan2(dx, dz);
      g.pitch = -Math.atan2(g.visY + 1.6 - f.pos.y, Math.hypot(dx, dz));
      g.update(1 / 60); g.update(1 / 60);
      const v = f.pos.clone().project(g.camera);
      return {
        fs: g.fs, species: f.species?.id, pos: [f.pos.x, f.pos.y, f.pos.z].map((x) => +x.toFixed(2)),
        ndc: [v.x, v.y, v.z].map((x) => +x.toFixed(3)), meshVisible: !!(f.mesh?.visible ?? f.group?.visible ?? true),
      };
    });
    T.fish = { frames: nNear, ...fishInfo };
    console.log('  fish', JSON.stringify(T.fish));
    expect(nNear > 0 && fishInfo.hook !== null, `${tier}: 魚が寄ってこない（${fishInfo.fs}）`);
    await h.shot(`${tier}-fish-refraction`);
    /* 水越しの魚の近接：桟橋の縁の目の高さ（床 + 1.6m）から、桟橋に一番よく見える魚（大きさ ÷ 距離が最大）を見下ろす。
       9 時（正午の太陽の照り返しが画面の真ん中に来ない）。カメラは桟橋の上だけに置く */
    const fishClose = await h.eval((forcePlace) => {
      const g = window.__game, cam = g.camera, t = g.terrain;
      /* 桟橋ローカル（al: 岸→沖、si: 右）で、魚の横の床の縁（|si| = 1.2m、歩ける半幅 1.62m の内側）に立つ */
      const U = t._dockU, A = t.dockStart, len = t._dockLen;
      const loc = (x, z) => ({ al: (x - A.x) * U.x + (z - A.z) * U.z, si: -(x - A.x) * U.z + (z - A.z) * U.x });
      const world = (al, si) => ({ x: A.x + U.x * al - U.z * si, z: A.z + U.z * al + U.x * si });
      let best = null;
      const pick = () => {
      best = null;
      for (const f of g.school.fishes) {
        if (!f.active || !f.mesh?.visible) continue;
        const q = loc(f.pos.x, f.pos.z);
        const al = Math.max(1, Math.min(len - 1, q.al)), si = Math.sign(q.si || 1) * 1.2;
        const c = world(al, si);
        const d = Math.hypot(f.pos.x - c.x, f.pos.z - c.z);
        if (Math.abs(q.si) < 3.2 || d > 14) continue;   /* 床の下（半幅 1.7m）と遠すぎる魚は外す */
        /* 太陽を背にする（9 時の太陽の水平の向き。照り返しの中の魚は見えない）・深さ 4.5m まで */
        const sx = Math.cos(Math.PI / 4), sz = 0.34;
        const facing = ((f.pos.x - c.x) * sx + (f.pos.z - c.z) * sz) / Math.max(d, 1e-3) / Math.hypot(sx, sz);
        if (-f.pos.y > 4.5) continue;
        const score = (f.length || 20) / Math.max(2, Math.hypot(d, f.pos.y - t.dockY - 1.6)) * (facing > 0 ? 1e-3 : 1);   /* 逆光の候補は最後の手段 */
        if (!best || score > best.score) best = { f, c, d, score };
      }
      };
      pick();
      if (forcePlace) best = null;   // 置き直しの道を確かめる（FISH_PLACE=1）
      /* 魚の位置は fish.js の Math.random で決まる（low は 14 匹）。候補が居なければ、掛かっていない魚を 1 匹
         桟橋の横（縁から 2.5〜3.3m 外、深さ 1.2〜2.5m）へ置き直して決定的にする（どちらの道かを JSON に残す） */
      let placed = false;
      if (!best) {
        const spare = g.school.fishes.find((f) => f.active && f.mesh?.visible && f !== g.hookFish && f.state !== 'hooked' && f.state !== 'nibble' && f.state !== 'bite');
        for (const frac of [0.6, 0.45, 0.75, 0.3, 0.9]) {
          if (!spare || best) break;
          for (const side of [1, -1]) {
            const p = world(len * frac, side * 4.5);
            const depth = g.lake?.depthAt ? g.lake.depthAt(p.x, p.z) : (t.lake?.depthAt?.(p.x, p.z) ?? 0);
            if (!(depth > 1.6)) continue;
            const y = -Math.min(2.5, Math.max(1.2, depth * 0.5));
            spare.pos.set(p.x, y, p.z);
            spare.mesh.position.copy(spare.pos);
            spare.home?.copy?.(spare.pos);
            spare.target.copy(spare.pos);
            spare.state = 'wander';
            spare.timer = 30;
            placed = true;
            pick();
            if (best) break;
          }
        }
      }
      if (!best) return { placed, onDock: false };
      const { f } = best;
      g.state.clock = 9;
      g.__savedCam = g._updateCamera;
      g._updateCamera = function () {
        cam.position.set(best.c.x, t.dockY + 1.6, best.c.z);
        cam.lookAt(f.pos.x, f.pos.y, f.pos.z);
        cam.updateMatrixWorld();
      };
      for (let i = 0; i < 4; i++) g.update(1 / 60);
      const v = f.pos.clone().project(cam);
      return {
        species: f.species?.id, depth: +(-f.pos.y).toFixed(2), lengthCm: +(f.length || 0).toFixed(1), horizFromDock: +best.d.toFixed(2),
        camToFish: +f.pos.distanceTo(cam.position).toFixed(2), onDock: t.onDock(cam.position.x, cam.position.z) !== null, ndc: [v.x, v.y].map((x) => +x.toFixed(3)),
        placed,
      };
    }, process.env.FISH_PLACE === '1');
    T.fishClose = fishClose;
    console.log('  fish close', JSON.stringify(fishClose));
    expect(fishClose && fishClose.onDock, `${tier}: 桟橋から見える魚が居ない（${JSON.stringify(fishClose)}）`);
    await h.shot(`${tier}-fish-refraction-close`);
    await h.eval(() => { const g = window.__game; g.state.clock = 12; if (g.__savedCam) { g._updateCamera = g.__savedCam; delete g.__savedCam; } });

    /* 6. アタリ → アワセ → ファイト → 水中カメラ */
    const nBite = await run(h, 1500, 1 / 30, "g.fs === 'bite'");
    const fight = await h.eval(() => {
      const g = window.__game;
      const fs0 = g.fs;
      if (g.fs === 'bite') { g._actionDown(); g._actionUp(); }
      for (let i = 0; i < 20; i++) g.update(1 / 30);
      return { fs0, fs1: g.fs };
    });
    T.fight = { framesToBite: nBite, ...fight };
    console.log('  fight', JSON.stringify(T.fight));
    expect(nBite > 0 && fight.fs1 === 'fight', `${tier}: アワセでファイトにならない（${fight.fs0} → ${fight.fs1}）`);
    await h.eval(() => { const g = window.__game; g._setFirstPerson?.(false, true); g.pitch = -0.1; for (let i = 0; i < 20; i++) g.update(1 / 30); });
    await h.shot(`${tier}-fight-3p`);
    const uw = await h.eval(async () => {
      const g = window.__game;
      const { getGfx } = await import('/src/gfx/core/index.js');
      const gfx = getGfx();
      const on0 = g.underwaterCam;
      g._toggleUnderwater();
      for (let i = 0; i < 30; i++) g.update(1 / 30);
      return { on0, on1: g.underwaterCam, fs: g.fs, uw: +gfx.frame.cam.uw.toFixed(2), camY: +g.camera.position.y.toFixed(2) };
    });
    T.underwater = uw;
    console.log('  underwater', JSON.stringify(uw));
    await h.shot(`${tier}-fight-underwater`);
    expect(uw.on1 === true && (uw.fs !== 'fight' || uw.uw > 0.5), `${tier}: 水中カメラにならない（${JSON.stringify(uw)}）`);
    /* 巻いて取り込むか切れるまで（最大 120 秒）。どちらでもファイトの流れが最後まで通ること */
    const end = await h.eval(() => {
      const g = window.__game;
      /* 張力を見て巻く／止める（人の遊び方。巻きっぱなしだと強い魚で糸が切れて «取り込み» を通らない） */
      let n = 0, landed = false, snapped = false;
      for (; n < 3600 && g.fs === 'fight'; n++) {
        const t = g.fight ? g.fight.tension / g.line.cap : 0;
        g.actionHeld = t < 0.7;
        g.update(1 / 30);
      }
      const F = g.fight;
      const left = F ? { dist: +F.dist.toFixed(2), tension: +(F.tension / g.line.cap).toFixed(2), stamina: +(F.stamina ?? 0).toFixed(2) } : null;
      g.actionHeld = false;
      const fs = g.fs;
      landed = fs === 'landing';
      for (let i = 0; i < 300 && g.fs === 'landing'; i++) g.update(1 / 30);
      snapped = fs !== 'landing';
      const modal = g.ui.openModal || null;
      if (g.ui.openModal === 'catch') g.dismissCatch();
      if (g.underwaterCam) g._toggleUnderwater();
      for (let i = 0; i < 20; i++) g.update(1 / 30);
      return { frames: n, fsAfterFight: fs, landed, snapped, modal, left, fs: g.fs, uwCam: g.underwaterCam };
    });
    T.fightEnd = end;
    console.log('  fight end', JSON.stringify(end));
    expect(end.fsAfterFight !== 'fight', `${tier}: 120 秒巻いてもファイトが終わらない（${JSON.stringify(end.left)}）`);
    expect(end.landed, `${tier}: 張力を見て巻いても取り込み（landing）に入らない（${end.fsAfterFight}）`);

    /* 7. F3 のデバッグ表示（当たりの箱と障害物の円）を桟橋の斜め上から */
    const dbg = await h.eval(() => {
      const g = window.__game;
      const t = g.terrain, dir = t.dockDir;
      g.fs = 'idle';
      g.pos.set(t.dockStart.x + dir.x * 2, t.dockY, t.dockStart.z + dir.z * 2);
      g.yaw = Math.atan2(dir.x, dir.z) + Math.PI;
      g.pitch = -0.35;
      g._setFirstPerson?.(false, true);
      /* セーブが前の起動の «デバッグ ON» を覚えていることがあるので、OFF から始めて F3 で ON にする */
      if (g.debug.enabled) g.debug.toggle();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F3' }));
      let threw = null;
      try { for (let i = 0; i < 40; i++) g.update(1 / 30); } catch (e) { threw = String(e); }
      return { enabled: g.debug.enabled, threw, obstacles: t.obstacles.length / 4, fogNear: g.scene.fog.near, fogFar: g.scene.fog.far };
    });
    T.debug = dbg;
    console.log('  debug', JSON.stringify(dbg));
    expect(dbg.enabled && !dbg.threw, `${tier}: F3 のデバッグ表示で例外（${dbg.threw}）`);
    await h.shot(`${tier}-debug-dock`);
    /* 桟橋の先の手すりと灯籠の当たりを近くから */
    await h.eval(() => {
      const g = window.__game, t = g.terrain, dir = t.dockDir;
      g.pos.set(t.dockEnd.x - dir.x * 5, t.dockY, t.dockEnd.z - dir.z * 5);
      g.yaw = Math.atan2(dir.x, dir.z) + 0.4;
      g.pitch = -0.3;
      for (let i = 0; i < 20; i++) g.update(1 / 30);
    });
    await h.shot(`${tier}-debug-tip`);
    await h.eval(() => {
      const g = window.__game;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F3' }));
      for (let i = 0; i < 4; i++) g.update(1 / 30);
    });
    const c1 = h.counts();
    T.console = { errors: c1.errors - c0.errors, pageErrors: c1.pageErrors - c0.pageErrors, warnings: c1.warnings - c0.warnings };
    console.log('  console', JSON.stringify(T.console));
    expect(T.console.errors === 0 && T.console.pageErrors === 0, `${tier}: console のエラー ${T.console.errors}・ページ例外 ${T.console.pageErrors}`);
  }
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, 'g0-gameplay.json'), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`G0 gameplay: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('G0 gameplay: すべて合格');
}
