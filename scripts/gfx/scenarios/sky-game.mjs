/* ===========================================================
   本編（index.html）で sky を確かめる：baseline の 7 構図 + ブルーアワー・23:30・雨の夕方。
   止めずに回して撮る（ゲームの時計・天候の遷移・露出の順応込み）。
   出力：DIR/game-*.png・DIR/sky-game.json（sky の健在・stats・console）。console のエラー / 例外が 0 でなければ投げる
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

export default async function (h) {
  await h.bootGame({ quality: process.env.Q || 'high' });
  await h.hideHud();
  const place = (o) => h.eval(({ back, pitch, clock, fp, weather, yawOff }) => {
    const g = window.__game;
    const end = g.terrain.dockEnd, dir = g.terrain.dockDir;
    g.pos.set(end.x - dir.x * back, 0, end.z - dir.z * back);
    g.yaw = Math.atan2(dir.x, dir.z) + (yawOff || 0);
    g.pitch = pitch;
    g._setFirstPerson?.(fp, true);
    g.state.clock = clock;
    g.env.setWeather?.(weather || 'clear');
  }, o);
  const views = [
    ['dawn-3p', { back: 3.2, pitch: -0.08, clock: 6.1, fp: false }],
    ['morning-fp', { back: 1.6, pitch: -0.12, clock: 8.5, fp: true }],
    ['noon-fp-down', { back: 1.6, pitch: -0.45, clock: 12.5, fp: true }],
    ['noon-shore', { back: 1.6, pitch: -0.05, clock: 13, fp: true, yawOff: Math.PI * 0.75 }],
    ['dusk-3p', { back: 3.2, pitch: -0.05, clock: 18.3, fp: false }],
    ['bluehour-fp', { back: 1.6, pitch: 0.12, clock: 18.5, fp: true, yawOff: Math.PI }],
    ['night-fp', { back: 1.6, pitch: -0.05, clock: 22.5, fp: true }],
    ['night2330-fp', { back: 1.6, pitch: 0.05, clock: 23.5, fp: true }],
    ['rain-fp', { back: 1.6, pitch: -0.1, clock: 11, fp: true, weather: 'rain' }],
    ['rain-dusk-fp', { back: 1.6, pitch: 0.05, clock: 18.3, fp: true, weather: 'rain' }],
  ];
  const res = [];
  for (const [name, o] of views) {
    await place(o);
    await h.tick(90);
    await h.sleep(400);
    await h.tick(10);
    await h.shot('game-' + name);
    const s = await h.eval(() => {
      const g = window.__game, gfx = g?.gfx || g?.env?.gfx || window.__gfx, m = gfx?.modules?.get?.('sky');
      const sf = gfx?.safety;
      return {
        health: m ? { stub: m._ngStub ?? null, strikes: sf?.strikes?.get('sky') || 0, disabled: !!sf?.disabled?.has('sky'), restarts: gfx._restarts?.get('sky') || 0 } : null,
        exposure: m?.rig?.out?.exposure ?? null,
      };
    });
    res.push({ name, ...s });
    console.log(name, JSON.stringify(s));
  }
  const stats = await h.stats();
  const counts = h.counts();
  fs.writeFileSync(path.join(h.out, 'sky-game.json'), JSON.stringify({ res, stats, counts }, null, 1));
  console.log('stats', JSON.stringify(stats?.modules?.sky ?? stats));
  console.log('console', JSON.stringify(counts));
  if (counts.errors || counts.pageErrors) throw new Error('console errors / page exceptions');
  if (res.some((r) => !r.health || r.health.stub || r.health.disabled || r.health.strikes)) throw new Error('sky not healthy');
}
