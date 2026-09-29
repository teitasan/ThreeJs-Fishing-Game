/* 現行ビルドの見た目を一通り撮る（夜明け・昼・夕・夜・雨・一人称・俯瞰・水中） */
export default async function (h) {
  await h.bootGame();
  await h.hideHud();
  const place = (o) => h.eval(({ back, pitch, clock, fp, weather, yawOff }) => {
    const g = window.__game;
    const end = g.terrain.dockEnd, dir = g.terrain.dockDir;
    g.pos.set(end.x - dir.x * back, 0, end.z - dir.z * back);
    g.yaw = Math.atan2(dir.x, dir.z) + (yawOff || 0);
    g.pitch = pitch;
    g._setFirstPerson?.(fp, true);
    g.state.clock = clock;
    if (weather) g.env.setWeather?.(weather);
  }, o);
  const views = [
    ['dawn-3p', { back: 3.2, pitch: -0.08, clock: 6.1, fp: false }],
    ['morning-fp', { back: 1.6, pitch: -0.12, clock: 8.5, fp: true }],
    ['noon-fp-down', { back: 1.6, pitch: -0.45, clock: 12.5, fp: true }],
    ['noon-shore', { back: 1.6, pitch: -0.05, clock: 13, fp: true, yawOff: Math.PI * 0.75 }],
    ['dusk-3p', { back: 3.2, pitch: -0.05, clock: 18.3, fp: false }],
    ['night-fp', { back: 1.6, pitch: -0.05, clock: 22.5, fp: true }],
    ['rain-fp', { back: 1.6, pitch: -0.1, clock: 11, fp: true, weather: 'rain' }],
  ];
  for (const [name, o] of views) {
    await place(o);
    await h.tick(40);
    await h.sleep(300);
    await h.shot(name);
  }
  console.log('stats', JSON.stringify(await h.stats()));
}
