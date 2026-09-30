/* lab/core.html が起動して描けるかを見る（開発中の早い確認用） */
export default async function (h) {
  await h.open('lab/core.html?capture=1');
  await h.waitFor(() => window.__gfxReady === true, undefined, 120);
  const shots = [['dock-3p', 12, null], ['dock-3p', 12, 'falseColor'], ['noon-fp-down', 12.5, null], ['aerial60', 15, null]];
  for (const [cam, hour, view] of shots) {
    await h.eval(({ cam, hour, view }) => { const L = window.__lab; L.cam(cam); L.setHour(hour); L.view(view); L.tick(20); }, { cam, hour, view });
    await h.shot(`${cam}-${hour}${view ? '-' + view : ''}`);
  }
  await h.eval(() => { window.__lab.view(null); window.__lab.cam('dock-3p'); window.__lab.resume(); });
  await h.sleep(3000);
  console.log('stats', JSON.stringify(await h.eval(() => window.__lab.stats())));
}
