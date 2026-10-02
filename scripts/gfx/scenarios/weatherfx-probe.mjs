/* weatherfx の位置の確認（開発用）：桟橋・蛍の居場所・プリセットのカメラ・太陽の向き */
export default async function (h) {
  await h.open(`lab/underwater+weatherfx.html?capture=1&tier=high`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const r = await h.eval(() => {
    const L = window.__lab, m = L.gfx.modules.get('weatherfx');
    const A = m.motes.ff.geo.getAttribute('aAnchor');
    const an = [];
    for (let i = 0; i < 200; i += 25) an.push([+A.getX(i).toFixed(1), +A.getZ(i).toFixed(1)]);
    const pr = L.presets();
    return {
      dock: L.dock, anchorCount: m.motes.anchorCount, reeds: L.placement.reeds?.length, an,
      presets: Object.fromEntries(Object.entries(pr).map(([k, v]) => [k, [v.pos, v.target, v.hour, v.weather]])),
    };
  });
  console.log('probe', JSON.stringify(r));
}
