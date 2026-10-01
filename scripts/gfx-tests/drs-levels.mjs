#!/usr/bin/env node
/* ===========================================================
   drs-levels：動的解像度は粗い段（NG_DRS_LEVELS）だけを動き、境目の負荷で往復しない
   - RT（main・copy・refl）は倍率が変わるたびに全部作り直す（high 2560×1440 で +7ms の 1 フレーム）。
     以前の 0.05 刻みの制御と同じ負荷の列で «段を変えた回数» を比べ、半分以下であること
   - 重い負荷（倍率 1 で 24ms、画素に比例）では予算内の段まで下がる（DRS が効く）
   - 境目の負荷（倍率 1 で 18ms ± ゆらぎ）で、上げ下げの往復は 40 秒に 1 回より少ない
   - pipeline.setRenderScale の丸め（ngSnapRenderScale）が段のどれかを返す
   =========================================================== */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, check, done } from './lib/env.mjs';

const { DrsController, NG_DRS_LEVELS, ngSnapRenderScale, NG_TIERS } = await import(pathToFileURL(path.join(ROOT, 'src/gfx/core/quality.js')).href);

/* G0 の制御（0.05 刻み、5 秒の calm で上げる）をそのまま写したもの：比べる相手 */
class OldDrs {
  constructor(range) { this.range = range; this.scale = 1; this._win = []; this._t = 0; this._calm = 0; this.changes = 0; }
  update(ms, dt) {
    const s0 = this.scale;
    this._win.push(ms); this._t += dt; this._calm = ms < 14 ? this._calm + dt : 0;
    if (this._t >= 2) {
      const s = this._win.slice().sort((a, b) => a - b);
      const p90 = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
      if (p90 > 17.2) this.scale = Math.max(this.range[0], +(this.scale - 0.05).toFixed(4));
      this._win.length = 0; this._t = 0;
    }
    if (this._calm >= 5) { this.scale = Math.min(this.range[1], +(this.scale + 0.05).toFixed(4)); this._calm = 0; }
    if (this.scale !== s0) this.changes++;
    return this.scale;
  }
}

/* 決定的なゆらぎ（LCG）。GPU が律速：frameMs = base · scale² + ゆらぎ */
function run(ctrl, base, seconds, jitter = 1.5) {
  let x = 12345, s = 1;
  const dt = 1 / 60, seen = new Set();
  for (let t = 0; t < seconds; t += dt) {
    x = (x * 1103515245 + 12345) >>> 0;
    const n = (x / 4294967296 - 0.5) * 2 * jitter;
    const b = typeof base === 'function' ? base(t) : base;
    s = ctrl.update(b * s * s + n, dt, false);
    seen.add(s);
  }
  return { scale: s, seen };
}

const range = NG_TIERS.high.drs;
/* 境目の負荷：1.0 では少し超え、0.95 では calm（14ms 未満）に入りうる */
const edge = (t) => 17.6 + 2.2 * Math.sin(t / 9);
const o = new OldDrs(range), n = new DrsController(range);
const ro = run(o, edge, 600), rn = run(n, edge, 600);
console.log(`  境目の負荷 600 秒：段の変化 旧 ${o.changes} 回 → 新 ${n.changes} 回`);
check(n.changes * 2 <= o.changes, `段を変える回数が旧の半分以下（旧 ${o.changes}・新 ${n.changes}）`);
check(n.changes <= 600 / 40, `往復は 40 秒に 1 回より少ない（${n.changes} 回 / 600 秒）`);
for (const s of rn.seen) check(NG_DRS_LEVELS.includes(s), `倍率 ${s} が NG_DRS_LEVELS の段`);
void ro;

/* 重い負荷：倍率 1 で 24ms → 予算内（p90 ≤ 17.2）の段まで下がる */
const heavy = new DrsController(range);
const rh = run(heavy, 24, 60, 0.5);
check(24 * rh.scale * rh.scale <= 17.2 + 1, `重い負荷で予算内の段まで下がる（倍率 ${rh.scale}）`);
check(rh.scale >= range[0], `範囲の下限 ${range[0]} より下げない（${rh.scale}）`);

/* 軽い負荷では 1.0 に戻る */
const light = new DrsController(range);
light.scale = 0.7;
const rl = run(light, 8, 60, 0.5);
check(rl.scale === 1, `軽い負荷で 1.0 に戻る（${rl.scale}）`);

/* 段の範囲と丸め */
for (const [tier, p] of Object.entries(NG_TIERS)) {
  const c = new DrsController(p.drs);
  check(c.levels[0] === 1 && c.levels[c.levels.length - 1] === p.drs[0], `${tier}：段 ${c.levels.join(',')} が 1.0 から下限 ${p.drs[0]} まで`);
  check(c.levels.every((l) => NG_DRS_LEVELS.includes(l)), `${tier}：段が NG_DRS_LEVELS の中`);
}
for (const [v, want] of [[1, 1], [0.97, 1], [0.9, 0.85], [0.8, 0.85], [0.76, 0.75], [0.72, 0.7], [0.66, 0.7], [0.62, 0.6], [0.3, 0.5], [NaN, 1]]) {
  check(ngSnapRenderScale(v) === want, `ngSnapRenderScale(${v}) = ${want}（${ngSnapRenderScale(v)}）`);
}
const fr = new DrsController(range);
fr.scale = 0.7;
check(fr.update(30, 1 / 60, true) === 1, '撮影中（frozen）は 1.0');

done('drs-levels');
