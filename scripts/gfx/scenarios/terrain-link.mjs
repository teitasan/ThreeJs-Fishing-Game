/* ===========================================================
   terrain-link：地形のシェーダが 3 段（low / mid / high）で全部リンクすることを確かめる（速い。〜1 分）
   -----------------------------------------------------------
   地形が落ちると森が空中に浮く（G1 の WIP で upland の宣言の順の誤りがそうなった）ので、撮影の前に必ずこれを通す。
   - lab/terrain.html を各段で開き、warmup のコンパイルの後に 60 フレーム回す
   - programAudit：terrain の印のプログラムが 2 本以上・失敗 0・サンプラーの超過 0
   - onShaderError の差し替え（MeshLambertMaterial）が起きていない・スタブでない・無効化されていない
   - 遠景の稜線の色が «白くない»（地形の素材が落ちると稜線まで白く見えた件の再発防止）：
     稜線だけを写す視点で中央の帯の平均の輝度が露出前で 0.6 未満、青み（b > r）
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/terrain-link.mjs --out DIR
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

export default async function (h) {
  const tiers = (process.env.TIERS || 'low,mid,high').split(',');
  const res = {};
  const fail = [];
  for (const tier of tiers) {
    const c0 = h.counts();
    await h.open(`lab/terrain.html?capture=1&tier=${tier}&chart=0`);
    await h.waitFor(() => window.__gfxReady === true, undefined, 240);
    const r = await h.eval(() => {
      const L = window.__lab, g = L.gfx, m = g.modules.get('terrain');
      L.unfreeze(); L.cam('dock-3p'); L.setHour(12.5); L.setWeather('clear', { instant: true }); L.tick(60, 1 / 60);
      const a = L.programAudit();
      const mine = a.programs.filter((p) => p.tag?.startsWith('terrain:'));
      const s = g.safety;
      const matTypes = [];
      m?.root?.traverse?.((o) => { if (o.material) matTypes.push(o.material.type); });
      /* 稜線の色：桟橋の先から湖の向こうの稜線へ、地形の CDLOD を隠して稜線だけを写す */
      const D = L.dock;
      const e = { x: D.dockEnd.x + D.dockDir.x, z: D.dockEnd.z + D.dockDir.z };
      L.cam({ pos: [e.x, D.dockY + 1.7, e.z], target: [e.x + D.dockDir.x * 1500, 200, e.z + D.dockDir.z * 1500] });
      L.freeze(10); L.tick(6);
      const T = m.ctx.THREE, rt = g.pipeline.targets.copy;
      const W = rt.width, H = rt.height, buf = new Float32Array(W * H * 4);
      /* 色（露出前の HDR）と線形深度を 1 枚に：rgb = 色、a = 深度 m */
      const tmp = m.ctx.forge.target(W, H, { type: T.FloatType, filter: 'nearest', wrap: 'clamp' });
      m.ctx.forge.run(tmp, 'uniform sampler2D ngC;\nuniform highp sampler2D ngD;\nvoid main() { gl_FragColor = vec4(texture(ngC, vUv).rgb, texture(ngD, vUv).r); }\n',
        { ngC: { value: g.pipeline.uniforms.ngSceneColor.value }, ngD: { value: g.pipeline.uniforms.ngSceneDepth.value } });
      L.renderer.readRenderTargetPixels(tmp, 0, 0, W, H, buf);
      tmp.dispose();
      /* 稜線の画素：深度 700m〜2900m（遠景の帯だけ）。距離の 3 帯ごとの平均も */
      let sr = 0, sg = 0, sb = 0, n = 0;
      const bands = [[700, 1300], [1300, 2000], [2000, 2900]].map((b) => ({ b, c: [0, 0, 0], n: 0 }));
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        const o = (y * W + x) * 4, d = buf[o + 3];
        if (!(d > 700 && d < 2900)) continue;
        sr += buf[o]; sg += buf[o + 1]; sb += buf[o + 2]; n++;
        for (const B of bands) if (d >= B.b[0] && d < B.b[1]) { B.c[0] += buf[o]; B.c[1] += buf[o + 1]; B.c[2] += buf[o + 2]; B.n++; }
      }
      n = Math.max(n, 1);
      const ridgeBands = bands.map((B) => ({ range: B.b, n: B.n, rgb: B.c.map((v) => +(v / Math.max(B.n, 1)).toFixed(4)) }));
      const ridge = [sr / n, sg / n, sb / n];
      return {
        stub: m?._ngStub ?? null, disabled: s.disabled.has('terrain'), strikes: s.strikes.get('terrain') || 0,
        mine: mine.map((p) => [p.tag, p.frag, p.vert]), failed: a.failed.map((p) => p.tag), over: a.over.map((p) => p.tag),
        matTypes, ridge, ridgeBands, ridgePx: n, nan: L.nanCheck(),
      };
    });
    const c1 = h.counts();
    r.errors = c1.errors - c0.errors; r.pageErrors = c1.pageErrors - c0.pageErrors;
    res[tier] = r;
    console.log(tier, JSON.stringify(r));
    const ex = (ok, msg) => { if (!ok) fail.push(`${tier}: ${msg}`); };
    ex(r.stub === false && !r.disabled && r.strikes === 0, 'スタブ・無効化・例外');
    ex(r.mine.length >= 2, `terrain のプログラム ${r.mine.length} 本`);
    ex(r.failed.length === 0, `リンクの失敗 ${r.failed.join(',')}`);
    ex(r.over.length === 0, `サンプラーの超過 ${r.over.join(',')}`);
    ex(!r.matTypes.includes('MeshLambertMaterial'), `シェーダの失敗で差し替えられた（${r.matTypes.join(',')}）`);
    ex(r.errors === 0 && r.pageErrors === 0, `console のエラー ${r.errors}・例外 ${r.pageErrors}`);
    ex(r.nan === 0, `NaN ${r.nan}`);
    const lum = 0.2126 * r.ridge[0] + 0.7152 * r.ridge[1] + 0.0722 * r.ridge[2];
    ex(r.ridgePx > 200, `稜線の画素が少ない（${r.ridgePx}）`);
    ex(lum < 0.6 && r.ridge[2] > r.ridge[0], `稜線が白い・青くない（${r.ridge.map((v) => v.toFixed(3)).join(', ')}）`);
    /* 遠い帯ほど青い（b / g が増える）＝層の山並み */
    const bg = r.ridgeBands.filter((B) => B.n > 50).map((B) => B.rgb[2] / Math.max(B.rgb[1], 1e-4));
    ex(bg.length < 2 || bg.every((v, i) => i === 0 || v >= bg[i - 1] - 0.02), `遠い帯ほど青くない（b/g ${bg.map((v) => v.toFixed(2)).join(' → ')}）`);
    await h.shot(`link-${tier}-ridge`);
  }
  fs.writeFileSync(path.join(h.out, 'terrain-link.json'), JSON.stringify({ res, fail }, null, 1));
  if (fail.length) throw new Error('terrain-link: ' + fail.join(' / '));
  console.log('terrain-link: 合格');
}
