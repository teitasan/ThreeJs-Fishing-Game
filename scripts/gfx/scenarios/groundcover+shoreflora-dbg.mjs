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
  const a = await h.eval(() => {
    const L = window.__lab, A = L.programAudit(), g = L.gfx;
    L.cam({ pos: [36.86, 2.5, -111.02], target: [27.1, 0.9, -111.61] }); L.tick(5);
    const sf = g.modules.get('shoreflora');
    return { failed: A.failed, over: A.over, shaderFailed: [...(g.safety.shaderFailed || [])], sfDebug: sf?.debug,
      vis: ['reedNear', 'reedMid', 'reedLod1', 'reedCard'].map((k) => [k, sf?.[k]?.visible, sf?.[k]?.geometry?.instanceCount, sf?.[k]?.material?.userData?.ngFailed ?? null]) };
  });
  console.log('audit', JSON.stringify(a));
  await h.shot('dbg');
}
