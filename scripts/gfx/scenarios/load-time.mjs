/* ===========================================================
   読み込み時間（ARCHITECTURE §8 / §9 の load-time）
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/load-time.mjs --out DIR [--size 2560x1440]
   環境変数：TIERS=low,mid,high（既定 high,mid）、RUNS=3、SEED=123456789
   新しいタブで «その品質で起動» を RUNS 回（撮影サーバーは no-store なので毎回取り直す）。
   #loading の文言が変わった時刻（shot.mjs の __loadMarks）から段ごとの実時間を出す：
     sky   = 空 → 湖（core の install・ngFrame・ライトのリグ）
     lake  = 湖 → 湖底（resolveLake・placement・当たり。高さ場の Worker が裏で走る）
     bed   = 湖底 → 水（terrain.ready：高さ場・派生・全モジュールの init）
     water = 水 → 魚の模様（Water・PostFX の構築）
     fishAngler = 魚 → 準備完了（魚・釣り人・竿の glTF と postfx.warmup：compileAsync・MSAA の実測・空回し 3 フレーム）
     ready = 準備完了 → 終わり
     core  = gfx.loadStats（高さ場・モジュールごとの init・warmup の内訳）
     total = 最初の文言 → 終わり
   旧版（c8490ed）でも同じシナリオが動く（文言と #loading は同じ）。差が «追加の読み込み»。
   結果は DIR/load-time.json（各回と中央値）
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);
const STAGES = [
  ['sky', '空を描いています', '湖と山を生成しています'],
  ['lake', '湖と山を生成しています', '湖底と陸の質感を敷いています'],
  ['bed', '湖底と陸の質感を敷いています', '水を注いでいます'],
  ['water', '水を注いでいます', '魚の模様を塗っています'],
  ['fishTex', '魚の模様を塗っています', '魚を放しています'],
  ['fishAngler', '魚を放しています', '準備完了'],
  ['ready', '準備完了', 'done'],
];

export default async function (h) {
  const tiers = list(process.env.TIERS, ['high', 'mid']);
  const runs = Number(process.env.RUNS) || 3;
  const seed = Number(process.env.SEED) || 123456789;
  const out = { seed, size: h.page.viewportSize(), tiers: {} };
  for (const tier of tiers) {
    const rows = [];
    for (let k = 0; k < runs; k++) {
      await h.bootGame({ quality: null, bootQuality: tier, seed, start: false });
      const marks = await h.eval(() => (window.__loadMarks || []).map((m) => ({ label: m.label.replace(/…$/, ''), t: m.t })));
      const at = (label) => marks.find((m) => m.label === label)?.t;
      const row = {};
      for (const [name, a, b] of STAGES) {
        const ta = at(a), tb = at(b);
        row[name] = ta != null && tb != null ? Math.round(tb - ta) : null;
      }
      const first = marks.find((m) => m.label !== 'nav')?.t;
      row.total = first != null && at('done') != null ? Math.round(at('done') - first) : null;
      row.navToDone = at('done') != null ? Math.round(at('done') - marks[0].t) : null;
      /* core の内訳（新しい描画だけ。旧版では null） */
      row.core = await h.eval(async () => {
        try { const { getGfx } = await import('/src/gfx/core/index.js'); return getGfx()?.loadStats || null; } catch (e) { return null; }
      });
      rows.push(row);
      console.log(`${tier} #${k + 1}`, JSON.stringify(row));
    }
    const med = {};
    for (const key of Object.keys(rows[0]).filter((k) => k !== 'core')) {
      const v = rows.map((r) => r[key]).filter((x) => x != null).sort((a, b) => a - b);
      med[key] = v.length ? v[Math.floor(v.length / 2)] : null;
    }
    out.tiers[tier] = { runs: rows, median: med };
    console.log(`${tier} median`, JSON.stringify(med));
  }
  fs.writeFileSync(path.join(h.out, 'load-time.json'), JSON.stringify(out, null, 1));
}
