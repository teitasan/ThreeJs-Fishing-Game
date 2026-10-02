/* ===========================================================
   trees の証拠一式（ARCHITECTURE §6.5「証拠」）
   -----------------------------------------------------------
   PW_MODULE=… node scripts/gfx/shot.mjs scripts/gfx/scenarios/trees-proof.mjs --out DIR [--size 1280x720]
   環境変数：TIERS=high（既定 high。low,mid,high で段ごと）、SET=all|hi（hi は 2560 用の少ない組）、BENCH=1（GPU ms）
   撮る物：
     lookup-*       森の中の見上げ（透過と木漏れ日）
     interior-*     林床（forest-floor）
     dolly-NN       林縁へ 30 → 170m の 8 段（LOD の切り替え：隣どうしの差を JSON に）
     shell-*        far-ridge・高所から山肌（インポスター → 樹冠シェル）
     backlit-sugi   黄金時間の逆光のスギ（縁の輝き）
     wind-NN        風の 8 コマ（雨の日の 5m/s。コマ間の差を JSON に）
     shadow-*       木の影（朝・昼）
     collide        当たりの重ね表示（赤い輪 = 当たりの半径、胸高 1.3m）
     blocks         遠景の色の塊（植林の暗い帯と広葉樹の明るいパッチ）
     weather-*      晴・曇・雨・夜・朝・夕
   数値：NaN・プログラムの監査・サンプラー・stats・健在・（BENCH=1）自分の GPU ms
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from '../png.mjs';

const ID = 'trees';
const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);

/** 2 枚の PNG の平均の差（0..255）。region = [x0, y0, x1, y1]（0..1） */
function pngDiff(a, b, region = [0, 0, 1, 1]) {
  const A = decodePNG(fs.readFileSync(a)), B = decodePNG(fs.readFileSync(b));
  const x0 = Math.floor(region[0] * A.width), x1 = Math.floor(region[2] * A.width);
  const y0 = Math.floor(region[1] * A.height), y1 = Math.floor(region[3] * A.height);
  let s = 0, n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const o = (y * A.width + x) * 4;
    s += Math.abs(A.data[o] - B.data[o]) + Math.abs(A.data[o + 1] - B.data[o + 1]) + Math.abs(A.data[o + 2] - B.data[o + 2]);
    n += 3;
  }
  return s / Math.max(n, 1);
}

export default async function (h) {
  const tiers = list(process.env.TIERS, ['high']);
  const set = process.env.SET || 'all';
  const out = { id: ID, set, tiers: {} };
  const fail = [];
  const expect = (ok, msg) => { if (!ok) { fail.push(msg); console.log('  NG', msg); } };
  for (const tier of tiers) {
    const c0 = h.counts();
    const log0 = h.logs.length;
    await h.open(`lab/${process.env.LAB || 'trees'}.html?capture=1&chars=${process.env.CHARS || '0'}&tier=${tier}${process.env.Q || ''}`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 240);
    const R = (out.tiers[tier] = { shots: {} });
    R.boot = await h.eval((id) => {
      const L = window.__lab, m = L.gfx.modules.get(id);
      return { stub: m?._ngStub ?? null, stats: m?.stats?.() ?? null, load: L.gfx.loadStats?.modules?.[id] ?? null, tier: L.gfx.quality.tier };
    }, ID);
    console.log(`== ${tier}`, JSON.stringify(R.boot));
    expect(R.boot.stub === false, `${tier}: trees がスタブ`);
    /* 止めずに回す（update の時間の道） */
    await h.eval(() => { const L = window.__lab; L.unfreeze(); L.cam('dock-3p'); L.setHour(12.5); L.setWeather('clear', { instant: true }); L.tick(240, 1 / 60); });
    /* 構図は placement から組む（樹種の分かる木を選ぶ） */
    const cams = await h.eval(() => {
      const L = window.__lab, P = L.placement.trees, lake = L.lake;
      const sp = L.dock.spawnPos, dir = L.dock.dockDir;
      const hAt = (x, z) => lake.heightAt(x, z);
      /* 帯の中で樹冠の密な所（林床の見上げ）：mustDraw の木の多いセル */
      let best = null, bestN = 0;
      for (let k = 0; k < P.count; k += 7) {
        if (!P.mustDraw[k]) continue;
        let n = 0;
        for (let j = 0; j < P.count; j += 3) { const dx = P.x[j] - P.x[k], dz = P.z[j] - P.z[k]; if (dx * dx + dz * dz < 144 && P.species[j] >= 2) n++; }
        if (n > bestN) { bestN = n; best = k; }
      }
      const bx = P.x[best] + 2.2, bz = P.z[best] + 1.7, by = hAt(bx, bz) + 1.6;
      /* スギ（無ければヒノキ）：太陽の側（17.3 時の西）が湖で開けた汀の木。カメラは木の陸側から太陽へ向く（逆光） */
      const sunA = ((17.3 - 6) / 24) * Math.PI * 2;
      const sdx = Math.cos(sunA), sdz = 0.34;
      const sl = Math.hypot(sdx, sdz);
      const ux = sdx / sl, uz = sdz / sl;
      const BACK = 15;
      const cand = [];
      for (let k = 0; k < P.count; k++) {
        if (P.h[k] < 10) continue;
        let open = 0;
        for (let d = 12; d <= 72; d += 10) if (hAt(P.x[k] + ux * d, P.z[k] + uz * d) < 0) open++;
        const con = P.species[k] <= 1;
        /* スギ・ヒノキは植林で汀に少ない：湖の見えが 2 段でも採る */
        if (open < (con ? 2 : 4)) continue;
        const cx = P.x[k] - ux * BACK, cz = P.z[k] - uz * BACK;
        if (hAt(cx, cz) < 0.5) continue;
        const score = P.h[k] + open * 2 - Math.abs(hAt(cx, cz) - hAt(P.x[k], P.z[k])) * 2 + (P.species[k] === 0 ? 40 : P.species[k] === 1 ? 32 : 0);
        cand.push([score, k]);
      }
      cand.sort((a, b) => b[0] - a[0]);
      /* カメラから木までの線分に他の幹が無い（幹 + 1.2m）候補 */
      let sugi = -1;
      for (const [, k] of cand.slice(0, 60)) {
        const ax = P.x[k] - ux * BACK, az = P.z[k] - uz * BACK;
        let clear = true;
        for (let j = 0; j < P.count && clear; j++) {
          if (j === k) continue;
          const dx = P.x[j] - ax, dz = P.z[j] - az;
          if (dx * dx + dz * dz > (BACK + 4) ** 2) continue;
          const t = Math.max(0, Math.min(1, (dx * ux + dz * uz) / BACK));
          if (Math.hypot(dx - ux * BACK * t, dz - uz * BACK * t) < P.r[j] + 1.2) clear = false;
        }
        if (clear) { sugi = k; break; }
      }
      if (sugi < 0) sugi = cand.length ? cand[0][1] : P.species.findIndex((s, k) => s === 0 && P.mustDraw[k]);
      const sx = P.x[sugi], sz = P.z[sugi], sy = hAt(sx, sz);
      const scx = sx - ux * BACK, scz = sz - uz * BACK;
      /* 林縁への寄り：桟橋の付け根から内陸へ */
      const inland = [-dir.x, -dir.z];
      const base = [L.dock.dockStart.x, L.dock.dockStart.z];
      const dolly = [];
      for (let i = 0; i < 8; i++) {
        const back = 10 + i * 20;
        const px = base[0] + dir.x * back, pz = base[1] + dir.z * back;
        dolly.push({ pos: [px, Math.max(hAt(px, pz), 0) + 2.2, pz], target: [base[0] + inland[0] * 40, hAt(base[0] + inland[0] * 40, base[1] + inland[1] * 40) + 9, base[1] + inland[1] * 40] });
      }
      /* 当たりの重ね：最寄りの当たりのある木 4 本の間 */
      let ck = -1, cd = 1e9;
      for (let k = 0; k < P.count; k++) {
        if (!P.collide[k]) continue;
        const d = Math.hypot(P.x[k] - sp.x, P.z[k] - sp.z);
        if (d < cd && d > 8) { cd = d; ck = k; }
      }
      const kx = P.x[ck], kz = P.z[ck];
      return {
        lookup: { pos: [bx, by, bz], target: [bx + 1.5, by + 14, bz + 2.5] },
        interiorDense: { pos: [bx, by, bz], target: [bx + 12, by + 2, bz + 9] },
        sugi: { pos: [scx, Math.max(hAt(scx, scz), 0) + 1.6, scz], target: [sx, sy + P.h[sugi] * 0.62, sz], k: sugi, h: P.h[sugi], sp: P.species[sugi] },
        dolly,
        collide: { pos: [kx + 3.2, hAt(kx, kz) + 2.6, kz + 3.2], target: [kx, hAt(kx, kz) + 1.0, kz], k: ck },
        aerialHigh: { pos: [sp.x - dir.x * 120, 230, sp.z - dir.z * 120], target: [-sp.x * 1.4, 40, -sp.z * 1.4] },
        blocks: { pos: [0, 360, 0], target: [1, 0, 0] },
      };
    });
    R.cams = { sugi: cams.sugi.k, sugiSpecies: cams.sugi.sp, collide: cams.collide.k, lookup: cams.lookup, interior: cams.interiorDense, backlit: cams.sugi };
    /* 開発用：ONLY=lookup-13,interior-13 で一部だけ撮る、DBG=N で調べ物の表示（ngTreeMisc.w） */
    const only = list(process.env.ONLY, null);
    if (process.env.DBG) await h.eval((w) => { window.__lab.gfx.modules.get('trees').U.ngTreeMisc.value.w = w; }, Number(process.env.DBG));
    const shoot = async (name, cam, hour, weather = 'clear', view = null, ticks = 30) => {
      if (only && !only.includes(name)) return null;
      const r = await h.eval(({ cam, hour, weather, view, ticks }) => {
        const L = window.__lab;
        L.cam(cam); L.setHour(hour); L.setWeather(weather, { instant: true }); L.view(view); L.freeze(10);
        L.tick(ticks);
        const s = L.stats();
        return { nan: L.nanCheck(), trees: s.modules?.trees, draws: s.draws };
      }, { cam, hour, weather, view, ticks });
      const file = `${tier}-${name}`;
      await h.shot(file);
      R.shots[name] = r;
      expect(r.nan === 0, `${tier}-${name}: NaN ${r.nan}`);
      return path.join(h.out, file + '.png');
    };
    const hi = set === 'hi';
    await shoot('lookup-13', cams.lookup, 13);
    await shoot('interior-13', cams.interiorDense, 13);
    await shoot('backlit-sugi-17.3', cams.sugi, 17.3);
    await shoot('backlit-sugi-18.0', cams.sugi, 18.0);
    await shoot('shell-far-ridge-12', 'far-ridge', 12);
    await shoot('shell-aerial-12', cams.aerialHigh, 12);
    await shoot('weather-noon-shore', 'noon-shore', 13);
    await shoot('weather-dusk-3p', 'dusk-3p', 18.3);
    if (!hi) {
      await shoot('forest-floor-13', 'forest-floor', 13);
      await shoot('blocks-12', cams.blocks, 12);
      await shoot('shadow-9', 'aerial60', 9);
      await shoot('shadow-near-9', cams.collide, 9);
      await shoot('collide-12', cams.collide, 12);
      await shoot('weather-morning-fp', 'morning-fp', 8.5);
      await shoot('weather-dawn-3p', 'dawn-3p', 6.1);
      await shoot('weather-cloudy', 'noon-shore', 13, 'cloudy');
      await shoot('weather-rain-fp', 'rain-fp', 11, 'rain');
      await shoot('weather-night-fp', 'night-fp', 22.5);
      await shoot('shore-low-13', 'shore-low', 13);
      await shoot('reflect-dock-fp-16', 'dock-fp', 16);
      /* 当たりの重ね表示：赤い輪 = placement の当たりの半径、緑の輪 = 見た目の幹の半径（胸高）× 1.15 */
      await h.eval(async (k) => {
        const T = await import('three');
        const L = window.__lab, P = L.placement.trees;
        const g = new T.Group();
        g.name = 'trees-collide-overlay';
        const ring = (x, y, z, r, col) => {
          const pts = [];
          for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push(new T.Vector3(x + Math.cos(a) * r, y, z + Math.sin(a) * r)); }
          const l = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: col, depthTest: false }));
          l.renderOrder = 999;
          g.add(l);
        };
        for (let j = 0; j < P.count; j++) {
          if (!P.collide[j]) continue;
          if (Math.hypot(P.x[j] - P.x[k], P.z[j] - P.z[k]) > 25) continue;
          const y = L.lake.heightAt(P.x[j], P.z[j]) + 1.3;
          ring(P.x[j], y, P.z[j], P.r[j], 0xff2020);
          ring(P.x[j], y + 0.02, P.z[j], (L.gfx.modules.get('trees').visualTrunkR?.(j) ?? 0) * 1.15, 0x20ff40);
        }
        L.scene.add(g);
      }, cams.collide.k);
      await shoot('collide-overlay-12', cams.collide, 12);
      await h.eval(() => { const L = window.__lab; const g = L.scene.getObjectByName('trees-collide-overlay'); if (g) L.scene.remove(g); });
      if (only) { console.log('  ONLY: 寄り・風は省く'); } else {
      /* 林縁への寄り（LOD の切り替え）：8 段、隣どうしの差 */
      const dollyFiles = [];
      for (let i = 0; i < cams.dolly.length; i++) dollyFiles.push(await shoot(`dolly-${String(i).padStart(2, '0')}`, cams.dolly[i], 12));
      /* 同じ所を 2 回撮ってディザの揺れの下限を見る（凍結しているので 0 のはず） */
      R.dollyDiff = [];
      for (let i = 1; i < dollyFiles.length; i++) R.dollyDiff.push(+pngDiff(dollyFiles[i - 1], dollyFiles[i], [0, 0.2, 1, 0.7]).toFixed(2));
      console.log('  dolly diff', JSON.stringify(R.dollyDiff));
      /* 風の 8 コマ（雨 = 5m/s）：凍結を解いて 1/8 秒ずつ */
      const windFiles = [];
      await h.eval((cam) => { const L = window.__lab; L.cam(cam); L.setHour(11); L.setWeather('rain', { instant: true }); L.view(null); L.freeze(10); L.tick(20); }, cams.sugi);
      for (let i = 0; i < 8; i++) {
        await h.eval(() => { const L = window.__lab; L.unfreeze(); L.tick(8, 1 / 64); L.freeze(); L.tick(1, 0); });
        const f = `${tier}-wind-${String(i).padStart(2, '0')}`;
        await h.shot(f);
        windFiles.push(path.join(h.out, f + '.png'));
      }
      R.windDiff = [];
      for (let i = 1; i < windFiles.length; i++) R.windDiff.push(+pngDiff(windFiles[i - 1], windFiles[i], [0.25, 0.05, 0.75, 0.6]).toFixed(2));
      console.log('  wind diff', JSON.stringify(R.windDiff));
      expect(R.windDiff.some((d) => d > 0.05), `${tier}: 風で木が動いていない`);
      }
    }
    await h.eval(() => window.__lab.view(null));
    R.audit = await h.eval((id) => {
      const a = window.__lab.programAudit();
      const mine = a.programs.filter((p) => p.tag?.startsWith(id + ':'));
      return { total: a.count, mine: mine.length, over: a.over.length, failed: a.failed.length, samplers: mine.map((p) => [p.tag, p.frag, p.vert]) };
    }, ID);
    console.log('  audit', JSON.stringify(R.audit));
    expect(R.audit.mine >= 1 && R.audit.mine <= 6, `${tier}: trees のプログラム ${R.audit.mine} 本`);
    expect(R.audit.over === 0 && R.audit.failed === 0, `${tier}: サンプラー超過 ${R.audit.over}・リンク失敗 ${R.audit.failed}`);
    if (process.env.BENCH === '1') {
      R.bench = {};
      for (const v of ['dock-3p', 'shore-low', 'forest-floor', 'aerial60', 'noon-shore']) {
        R.bench[v] = await h.eval(({ id, v }) => {
          const L = window.__lab;
          L.cam(v); L.setHour(12.5); L.setWeather('clear', { instant: true }); L.view(null); L.freeze(10); L.tick(20);
          const runs = [];
          for (let r = 0; r < 3; r++) {
            const a = L.bench({ frames: 30, passes: true }), b = L.bench({ frames: 30, passes: true, hide: [id] });
            runs.push({ cost: a.frameMsMin - b.frameMsMin, passes: Object.fromEntries(Object.keys(a.passMin || {}).map((k) => [k, (a.passMin[k] || 0) - (b.passMin[k] || 0)])) });
          }
          const med = (arr) => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length / 2)];
          const keys = Object.keys(runs[0].passes);
          return {
            cost: +med(runs.map((r) => r.cost)).toFixed(2),
            passes: Object.fromEntries(keys.map((k) => [k, +med(runs.map((r) => r.passes[k])).toFixed(2)])),
            stats: L.gfx.modules.get(id).stats(),
          };
        }, { id: ID, v });
        console.log('  bench', v, JSON.stringify(R.bench[v]));
      }
    }
    const c1 = h.counts();
    R.console = { errors: c1.errors - c0.errors, pageErrors: c1.pageErrors - c0.pageErrors };
    expect(R.console.errors === 0 && R.console.pageErrors === 0, `${tier}: console のエラー ${R.console.errors}・ページ例外 ${R.console.pageErrors}`);
    R.health = await h.eval((id) => {
      const g = window.__lab.gfx, s = g.safety, m = g.modules.get(id);
      return { strikes: s.strikes.get(id) || 0, disabled: s.disabled.has(id), stub: m?._ngStub ?? null, visible: m?.root?.visible ?? null, restarts: g._restarts.get(id) || 0, deadPasses: [...s.deadPasses] };
    }, ID);
    const myWarn = h.logs.slice(log0).filter((l) => l.includes(`[ng] ${ID}.`) || l.includes(`モジュール ${ID} `));
    R.health.warnings = myWarn.length;
    console.log('  health', JSON.stringify(R.health));
    const H = R.health;
    expect(H.strikes === 0 && !H.disabled && H.stub === false && H.visible === true && H.restarts === 0, `${tier}: trees が健在でない ${JSON.stringify(H)}`);
    expect(H.deadPasses.length === 0, `${tier}: 止まったパス ${H.deadPasses.join(',')}`);
    expect(myWarn.length === 0, `${tier}: trees の警告 ${myWarn.length} 件`);
  }
  out.fail = fail;
  fs.writeFileSync(path.join(h.out, 'trees-proof.json'), JSON.stringify(out, null, 1));
  if (fail.length) throw new Error(`trees-proof: ${fail.length} 件の不合格\n` + fail.join('\n'));
  console.log('trees-proof: 合格');
}
