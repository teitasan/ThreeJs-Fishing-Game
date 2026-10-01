/* ===========================================================
   smoke-all（ARCHITECTURE §9 のブラウザ試験）：本編を 1200 フレーム揺さぶる
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/smoke-all.mjs --out DIR [--size 1280x720]
   - 時刻 0 → 24 を 0.25h 刻み（12.5 フレームごとに 1 段、96 段）
   - 天候の巡回 clear → cloudy → rain（150 フレームごと、1 回おきに instant）
   - 品質 low（100）→ mid（400）→ high（700）→ mid（1000）
   - 水中カメラの往復 ×4（180 / 480 / 780 / 1080 で «待ち» にして V、90 フレーム後に戻す）
   - 一人称の切り替え（250 / 850）、影の OFF（550）/ ON（650）、リサイズ ×2（300 で 960×540、900 で元へ）
   - 最初に «ポーズ中のフレーム»（ui.isBlocking = true）を 3 回：モジュールの update / prepare に来る f が
     dt = 0・paused = true で、realDt だけが実時間（CORE_API §3.4）
   - 合格：ページ例外 0・console のエラー 0・シェーダの失敗 0・game.update の例外 0・
     止まったパス / 無効化したモジュール 0、60 フレームごとの画面の中央の画素が NaN・真っ黒・白飛びでない
     （画面は最後のフレームの直後に readPixels。HDR の sceneColor の中央も有限であること）
   結果は DIR/smoke-all.json。途中の絵を 300 フレームごとに撮る
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const FRAMES = 1200;
const CHUNK = 60;

export default async function (h) {
  const size = h.page.viewportSize();
  const seed = Number(process.env.SEED) || 123456789;
  await h.bootGame({ quality: null, bootQuality: 'mid', seed, start: true });
  await h.hideHud();
  const c0 = h.counts();
  /* ページ内の状態：例外の数・シェーダの失敗の数（onShaderError を包んで数える） */
  await h.eval(async () => {
    const { getGfx } = await import('/src/gfx/core/index.js');
    const gfx = getGfx();
    const r = gfx.renderer;
    const S = window.__smoke = { throws: [], shaderErrors: 0, samples: [], events: [] };
    const prev = r.debug.onShaderError;
    r.debug.onShaderError = function (...a) { S.shaderErrors++; return prev?.apply(this, a); };
    /* 撮影の再現性（露出の順応・DRS を止める）。時刻はこちらで決める */
    window.__gfxCapture = true;
    const g = window.__game;
    g.pos.set(g.terrain.dockEnd.x - g.terrain.dockDir.x * 1.2, g.terrain.dockY, g.terrain.dockEnd.z - g.terrain.dockDir.z * 1.2);
    g.yaw = Math.atan2(g.terrain.dockDir.x, g.terrain.dockDir.z);
    g.pitch = -0.12;
  });

  /* ポーズ中のフレームでモジュールが見る f（CONTRACT §6：時計・波・天候・post の時刻はポーズで止まる） */
  const pause = await h.eval(async () => {
    const { getGfx } = await import('/src/gfx/core/index.js');
    const gfx = getGfx(), g = window.__game;
    const seen = [];
    const ms = [...gfx.modules.values()];
    const orig = ms.map((m) => [m, m.update, m.prepare]);
    for (const m of ms) {
      const u = m.update, p = m.prepare;
      m.update = function (f) { seen.push(['update', f.dt, f.paused, f.realDt]); return u.call(this, f); };
      m.prepare = function (f) { seen.push(['prepare', f.dt, f.paused, f.realDt]); return p.call(this, f); };
    }
    const blk = g.ui.isBlocking;
    g.ui.isBlocking = () => true;
    try { for (let i = 0; i < 3; i++) g.update(1 / 30); } finally {
      g.ui.isBlocking = blk;
      for (const [m, u, p] of orig) { m.update = u; m.prepare = p; }
    }
    const bad = seen.filter(([, dt, paused, realDt]) => dt !== 0 || paused !== true || !(realDt > 0));
    return { n: seen.length, bad: bad.slice(0, 4) };
  });
  console.log(`pause: ${pause.n} 回の update / prepare、ずれ ${pause.bad.length}`);

  for (let start = 0; start < FRAMES; start += CHUNK) {
    if (start === 300) await h.page.setViewportSize({ width: Math.round(size.width * 0.75), height: Math.round(size.height * 0.75) });
    if (start === 900) await h.page.setViewportSize(size);
    const res = await h.eval(async ({ start, n }) => {
      const { getGfx } = await import('/src/gfx/core/index.js');
      const gfx = getGfx();
      const g = window.__game, S = window.__smoke;
      const WEATHER = ['clear', 'cloudy', 'rain'];
      const TIER = { 100: 'low', 400: 'mid', 700: 'high', 1000: 'mid' };
      const note = (i, what) => S.events.push(`${i}:${what}`);
      /* «待ち» にして水中カメラへ。本物の流れ（ため → 離す → 着水）で入る */
      const castToWait = (i) => {
        const t = g.terrain, dir = t.dockDir;
        if (g.fs === 'wait' || g.fs === 'nibble' || g.fs === 'bite' || g.fs === 'fight') return true;
        if (g.ui.openModal === 'catch') g.dismissCatch();
        /* 一人称だと竿先の位置が違い、角度によっては糸が手すりに掛かる。角度を変えて 3 回まで */
        for (const pitch of [-0.45, -0.3, -0.2]) {
          g.fs = 'idle';
          g.pos.set(t.dockEnd.x - dir.x * 1.2, t.dockY, t.dockEnd.z - dir.z * 1.2);
          g.yaw = Math.atan2(dir.x, dir.z);
          g.pitch = pitch;
          g._actionDown();
          g.update(1 / 30);
          g.charge = g.targetPower ?? 0.5;
          g._actionUp();
          for (let k = 0; k < 120 && g.fs !== 'wait' && g.fs !== 'idle'; k++) g.update(1 / 30);
          note(i, `cast(${pitch})→${g.fs}`);
          if (g.fs === 'wait') return true;
        }
        return false;
      };
      for (let i = start; i < start + n; i++) {
        g.state.clock = (Math.floor(i / 12.5) * 0.25) % 24;
        if (i % 150 === 0) {
          const k = WEATHER[(i / 150) % 3];
          const instant = (i / 150) % 2 === 0;
          g.env.setWeather(k, { instant });
          note(i, `weather ${k}${instant ? ' instant' : ''}`);
        }
        if (TIER[i]) { g.state.settings.quality = TIER[i]; g.applyQuality(); note(i, `tier ${TIER[i]} → ${gfx.quality.tier}`); }
        if (i === 250 || i === 850) { g._setFirstPerson(!g.firstPerson); note(i, `fp ${g.firstPerson}`); }
        if (i === 550 || i === 650) { g.state.settings.shadow = i === 650; g.applyQuality(); note(i, `shadow ${g.state.settings.shadow}`); }
        if (i === 180 || i === 480 || i === 780 || i === 1080) {
          if (castToWait(i) && !g.underwaterCam) g._toggleUnderwater();
          note(i, `uw on ${g.underwaterCam} (${g.fs})`);
        }
        if (i === 270 || i === 570 || i === 870 || i === 1170) {
          if (g.underwaterCam) g._toggleUnderwater();
          note(i, `uw off ${g.underwaterCam}`);
        }
        try { g.update(1 / 30); } catch (e) { S.throws.push(`${i}: ${e && e.stack || e}`); }
      }
      /* 最後のフレームの直後（同じタスク）に画面の中央と 4 点を読む。preserveDrawingBuffer が無くても読める */
      const r = gfx.renderer, gl = r.getContext();
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const px = new Uint8Array(4);
      const pts = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      const screen = pts.map(([u, v]) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(Math.floor(W * u), Math.floor(H * v), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0], px[1], px[2]];
      });
      /* HDR の sceneColor（不透明の写し）の中央：半精度を読んで有限か */
      let hdr = null;
      try {
        const t = gfx.targets.copy;
        const u16 = new Uint16Array(4);
        r.readRenderTargetPixels(t, Math.floor(t.width / 2), Math.floor(t.height / 2), 1, 1, u16, undefined, 0);
        const half = (v) => {
          const s = v & 0x8000 ? -1 : 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
          if (e === 31) return f ? NaN : s * Infinity;
          return e === 0 ? s * f * 2 ** -24 : s * (1 + f / 1024) * 2 ** (e - 15);
        };
        hdr = [...u16].slice(0, 3).map(half);
      } catch (e) { hdr = String(e); }
      const c = screen[0];
      const sample = {
        frame: start + n, clock: +g.state.clock.toFixed(2), weather: g.env.weather.key, tier: gfx.quality.tier,
        uw: +gfx.frame.cam.uw.toFixed(2), fp: !!g.firstPerson, size: [W, H], screen, hdr,
        black: c[0] === 0 && c[1] === 0 && c[2] === 0, white: c[0] >= 254 && c[1] >= 254 && c[2] >= 254,
        hdrFinite: Array.isArray(hdr) && hdr.every((v) => Number.isFinite(v)),
      };
      S.samples.push(sample);
      return sample;
    }, { start, n: CHUNK });
    console.log(`${String(res.frame).padStart(4)} ${String(res.clock).padStart(5)}h ${res.weather.padEnd(6)} ${res.tier.padEnd(4)} uw ${res.uw} fp ${res.fp ? 1 : 0} ${res.size.join('x')} centre ${res.screen[0].join(',')} hdr ${Array.isArray(res.hdr) ? res.hdr.map((v) => v.toFixed(3)).join(',') : res.hdr}`);
    if ((start + CHUNK) % 300 === 0) await h.shot(`smoke-${String(start + CHUNK).padStart(4, '0')}`);
  }

  const S = await h.eval(async () => {
    const { getGfx } = await import('/src/gfx/core/index.js');
    const gfx = getGfx();
    const s = window.__smoke;
    return {
      throws: s.throws, shaderErrors: s.shaderErrors, events: s.events, samples: s.samples,
      deadPasses: [...gfx.safety.deadPasses], disabled: [...gfx.safety.disabled], strikes: Object.fromEntries(gfx.safety.strikes),
      shaderFailed: [...gfx.safety.shaderFailed], programs: gfx.renderer.info.programs.length, tier: gfx.quality.tier,
      msaa: gfx.msaa?.decision || null,
    };
  });
  const c1 = h.counts();
  const ngWarn = h.logs.filter((l) => l.startsWith('[warning]') && l.includes('[ng]'));
  const out = {
    frames: FRAMES, console: { errors: c1.errors - c0.errors, warnings: c1.warnings - c0.warnings, pageErrors: c1.pageErrors - c0.pageErrors },
    ngWarnings: ngWarn.slice(0, 20), pause, ...S,
  };
  fs.writeFileSync(path.join(h.out, 'smoke-all.json'), JSON.stringify(out, null, 1));
  const bad = [];
  if (!pause.n || pause.bad.length) bad.push(`ポーズ中の f が dt = 0・paused でない（${pause.n} 回中）：${JSON.stringify(pause.bad)}`);
  if (out.console.errors) bad.push(`console のエラー ${out.console.errors}`);
  if (out.console.pageErrors) bad.push(`ページ例外 ${out.console.pageErrors}`);
  if (S.throws.length) bad.push(`game.update の例外 ${S.throws.length}：${S.throws[0]}`);
  if (S.shaderErrors || S.shaderFailed.length) bad.push(`シェーダの失敗 ${S.shaderErrors}`);
  if (S.deadPasses.length) bad.push(`止まったパス ${S.deadPasses.join(',')}`);
  if (S.disabled.length) bad.push(`無効化したモジュール ${S.disabled.join(',')}`);
  if (ngWarn.length) bad.push(`[ng] の警告 ${ngWarn.length}：${ngWarn[0].slice(0, 200)}`);
  for (const s of S.samples) {
    if (s.black || s.white || !s.hdrFinite) bad.push(`フレーム ${s.frame}（${s.clock}h ${s.weather} ${s.tier} uw ${s.uw}）の中央が ${s.black ? '真っ黒' : s.white ? '白飛び' : 'NaN'}：${s.screen[0]} / ${s.hdr}`);
  }
  const uwOn = S.events.filter((e) => /uw on true/.test(e)).length;
  if (uwOn < 4) bad.push(`水中カメラに ${uwOn}/4 回しか入れていない：${S.events.filter((e) => /uw on/.test(e)).join(' | ')}`);
  const tiers = S.events.filter((e) => /tier/.test(e)).map((e) => e.split('→ ')[1]).join(',');
  if (tiers !== 'low,mid,high,mid') bad.push(`品質の切り替えが ${tiers}`);
  console.log(`\nsmoke-all: events ${S.events.length}, programs ${S.programs}, strikes ${JSON.stringify(S.strikes)}, msaa ${JSON.stringify(S.msaa)}`);
  if (bad.length) throw new Error(`smoke-all: ${bad.length} 件の不合格\n  ` + bad.join('\n  '));
  console.log('smoke-all: 合格（1200 フレーム、例外・エラー・NaN 0）');
}
