/* ===========================================================
   groundcover + shoreflora の本編（index.html）での確認
   -----------------------------------------------------------
   PW_MODULE=… node scripts/gfx/shot.mjs scripts/gfx/scenarios/groundcover+shoreflora-game.mjs --out DIR
   環境変数：TIERS=high,low（既定 high）、Q=&ng=-groundcover（スタブと比べる：健在の検査を省く）、VIEWS=0（撮らずに測るだけ）
   本編を h.bootGame で起動し（groundcover・shoreflora は本物、他はそのブランチのまま）、基準の構図を撮って
   両モジュールが健在（スタブでない・故障 0・止まったパス 0）、console のエラー・ページ例外 0、NaN 0、
   それぞれを隠した時との GPU ms の差（3 回の中央値）を出す
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const IDS = ['groundcover', 'shoreflora'];
const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

export default async function (h) {
  const tiers = list(process.env.TIERS, ['high']);
  const out = { tiers: {} };
  const fail = [];
  const expect = (ok, msg) => { if (!ok) { fail.push(msg); console.log('  NG', msg); } };
  for (const tier of tiers) {
    const c0 = h.counts();
    await h.bootGame({ quality: null, bootQuality: tier, query: '?gpuTimer=sync' + (process.env.Q || '') });
    await h.hideHud();
    await h.eval(() => { window.__gfxCapture = true; for (let i = 0; i < 3; i++) window.__game.update(1 / 60); });
    const R = (out.tiers[tier] = { shots: {} });
    const views = [
      ['dawn-3p', { back: 3.2, pitch: -0.08, clock: 6.1, fp: false }],
      ['morning-fp', { back: 1.6, pitch: -0.12, clock: 8.5, fp: true }],
      ['noon-shore', { back: 1.6, pitch: -0.05, clock: 13, fp: true, yawOff: Math.PI * 0.75 }],
      ['noon-inland', { back: 1.6, pitch: 0.02, clock: 12.5, fp: true, yawOff: Math.PI }],
      ['golden-3p', { back: 3.2, pitch: -0.03, clock: 17.4, fp: false, yawOff: Math.PI * 0.5 }],
      ['dusk-3p', { back: 3.2, pitch: -0.05, clock: 18.3, fp: false }],
      ['dusk-3p-1830', { back: 3.2, pitch: -0.05, clock: 18.5, fp: false }],
      ['night-fp', { back: 1.6, pitch: -0.05, clock: 22.5, fp: true }],
      ['rain-fp', { back: 1.6, pitch: -0.1, clock: 11, fp: true, weather: 'rain' }],
      ['shore-down-fp', { back: 1.6, pitch: -0.45, clock: 14, fp: true, yawOff: Math.PI * 0.6 }],
      ['underwater', { back: 1.6, pitch: -0.2, clock: 12, fp: true, uw: true }],
    ];
    for (const [name, o] of process.env.VIEWS === '0' ? [] : views) {
      const r = await h.eval(async (o) => {
        const { getGfx } = await import('/src/gfx/core/index.js');
        const g = window.__game, gfx = getGfx();
        const place = () => {
          const end = g.terrain.dockEnd, dir = g.terrain.dockDir;
          g.env.setWeather?.(o.weather || 'clear', { instant: true });
          g.underwaterCam = !!o.uw;
          g.fs = 'idle';
          g.pos.set(end.x - dir.x * o.back, 0, end.z - dir.z * o.back);
          g.yaw = Math.atan2(dir.x, dir.z) + (o.yawOff || 0);
          g.pitch = o.pitch;
          g._setFirstPerson?.(o.fp, true);
          g.state.clock = o.clock;
        };
        place();
        for (let i = 0; i < 30; i++) { g.state.clock = o.clock; g.update(1 / 60); }
        place();
        for (let i = 0; i < 6; i++) { g.state.clock = o.clock; g.update(1 / 60); }
        const st = Object.fromEntries(['groundcover', 'shoreflora'].map((id) => [id, gfx.modules.get(id)?.stats?.() ?? null]));
        g.underwaterCam = false;
        return { stats: st, nan: gfx.lab?.nanCheck?.() ?? null };
      }, o);
      await h.shot(`${tier}-game-${name}`);
      R.shots[name] = r;
      expect(r.nan == null || r.nan === 0, `${tier}-${name}: NaN ${r.nan}`);
      console.log(`  ${tier} ${name}`, JSON.stringify(r.stats));
    }
    /* 各モジュールの GPU ms：隠した時との差（3 回の中央値）。視点は桟橋の 3 人称・岸の 1 人称・内陸 */
    R.cost = {};
    for (const ID of IDS) R.cost[ID] = await h.eval(async (ID) => {
      const { getGfx } = await import('/src/gfx/core/index.js');
      const gfx = getGfx(), g = window.__game;
      const views = { dock: [3.2, 0, -0.06, false], shore: [1.6, Math.PI * 0.75, -0.05, true], inland: [1.6, Math.PI, 0.02, true] };
      const res = {};
      for (const [v, [back, yo, pitch, fp]] of Object.entries(views)) {
        const place = () => {
          const end = g.terrain.dockEnd, dir = g.terrain.dockDir;
          g.env.setWeather?.('clear', { instant: true });
          g.pos.set(end.x - dir.x * back, 0, end.z - dir.z * back);
          g.yaw = Math.atan2(dir.x, dir.z) + yo; g.pitch = pitch; g._setFirstPerson?.(fp, true); g.state.clock = 12.5;
        };
        const measure = (hide) => {
          const m = gfx.modules.get(ID);
          const was = m.root.visible;
          if (hide) m.root.visible = false;
          try {
            place();
            for (let i = 0; i < 6; i++) { g.state.clock = 12.5; g.update(1 / 60); }
            gfx.budget.reset();
            for (let i = 0; i < 40; i++) { g.state.clock = 12.5; g.update(1 / 60); }
            const mm = gfx.budget.mean().gpuMin;
            /* capture / composer は派生（capture = prep + hfShadow + shadow、composer = opaque + copy + late + post）なので数えない */
            const o = { total: 0 };
            for (const [k, x] of Object.entries(mm)) if (k !== 'capture' && k !== 'composer') { o[k] = x || 0; o.total += x || 0; }
            return o;
          } finally { m.root.visible = was; }
        };
        const runs = [];
        for (let r = 0; r < 3; r++) {
          const a = measure(false), b = measure(true);
          runs.push(Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - (b[k] || 0)])));
        }
        runs.sort((a, b) => a.total - b.total);
        const m = runs[1];
        res[v] = Object.fromEntries(Object.entries(m).filter(([k, x]) => k === 'total' || Math.abs(x) >= 0.05).map(([k, x]) => [k, +x.toFixed(2)]));
      }
      return res;
    }, ID);
    console.log(`  ${tier} cost(ms)`, JSON.stringify(R.cost));
    R.health = await h.eval(async (IDS) => {
      const { getGfx } = await import('/src/gfx/core/index.js');
      const g = getGfx(), s = g.safety;
      const per = Object.fromEntries(IDS.map((id) => { const m = g.modules.get(id); return [id, { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null, visible: m?.root?.visible ?? null }]; }));
      return { tier: g.quality.tier, per, deadPasses: [...s.deadPasses], shaderFailed: [...s.shaderFailed], programs: g.renderer.info.programs.length };
    }, IDS);
    const c1 = h.counts();
    R.console = { errors: c1.errors - c0.errors, pageErrors: c1.pageErrors - c0.pageErrors, warnings: c1.warnings - c0.warnings };
    console.log(`  ${tier} health`, JSON.stringify(R.health), JSON.stringify(R.console));
    const H = R.health;
    for (const id of IDS) {
      const P = H.per[id];
      if (!(process.env.Q || '').includes('-' + id)) expect(P.stub === false && !P.disabled && P.strikes === 0 && P.visible === true, `${tier}: ${id} が健在でない ${JSON.stringify(P)}`);
    }
    expect(H.deadPasses.length === 0 && H.shaderFailed.length === 0, `${tier}: 止まったパス・シェーダーの失敗`);
    expect(R.console.errors === 0 && R.console.pageErrors === 0, `${tier}: console のエラー ${R.console.errors}・ページ例外 ${R.console.pageErrors}`);
  }
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, 'groundcover+shoreflora-game.json'), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`groundcover+shoreflora-game: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('groundcover+shoreflora-game: 合格');
}
