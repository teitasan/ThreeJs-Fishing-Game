/* 開発用：根元の色（計算パスの表）と地形の farAlbedo を同じ所で読む。
   P='x,z' node scripts/gfx/shot.mjs scripts/gfx/scenarios/groundcover+shoreflora-dbg.mjs --out DIR */
export default async function (h) {
  await h.open('lab/groundcover.html?capture=1&tier=high&chars=0');
  await h.waitFor(() => window.__gfxReady === true, undefined, 240);
  const [x, z] = (process.env.P || '122.79,-62.65').split(',').map(Number);
  const r = await h.eval(({ x, z }) => {
    const L = window.__lab, gc = L.gfx.modules.get('groundcover');
    const y = Math.max(L.lake.heightAt(x, z), 0);
    L.cam({ pos: [x + 0.02, y + 1.4, z], target: [x, y, z] });
    L.setHour(12.5); L.setWeather('clear', { instant: true }); L.freeze(10); L.tick(10);
    const c = gc.debugCounts();
    const tex = L.gfx.services?.terrain?.farAlbedoTex || gc.cu.ngGcFarAlb.value;
    let far = null;
    try {
      const T = L.gfx.THREE || window.THREE;
      void T;
      const rt = tex?.isRenderTargetTexture ? null : null;
      void rt;
      far = { name: tex?.name, w: tex?.image?.width, isRT: !!tex?.isRenderTargetTexture, type: tex?.type };
    } catch (e) { far = String(e); }
    return { c: c.map((o) => ({ name: o.name, alive: o.alive, root: o.root, kinds: o.kinds, hf: o.hf })), far };
  }, { x, z });
  console.log(JSON.stringify(r, null, 1));
  await h.shot('dbg');
}
