/* ===========================================================
   lab の撮影表（ARCHITECTURE §4.12）：プリセット × 時刻 × 天候
   -----------------------------------------------------------
   node scripts/gfx/shot.mjs scripts/gfx/scenarios/lab-matrix.mjs <module> --out DIR [--size 1920x1080]
     <module>：lab/<module>.html（省略・環境変数 LAB で core）
   環境変数で絞れる：PRESETS=dock-3p,aerial60（既定は全プリセット）、HOURS=5.67,12.5（既定の 6 時刻）、
   WEATHERS=clear,rain（既定 3 つ）、TIER=high|mid|low（既定 high）、FRAMES=24（1 枚ごとの空回し）
   1 枚ごとに DIR/<preset>_<hhmm>_<weather>.png と同名の .json（時刻・天候・水平線の位置・ピッチ・水中・stats）を書き、
   全体を DIR/matrix.json にまとめる。判定は scripts/gfx/art-metrics.mjs DIR
   =========================================================== */
import fs from 'node:fs';
import path from 'node:path';

/** 既定の時刻：5:40 朝霧、9:00、12:30、17:45 黄金、18:55 ブルーアワー、23:30 月夜 */
export const MATRIX_HOURS = Object.freeze([5 + 40 / 60, 9, 12.5, 17.75, 18 + 55 / 60, 23.5]);
export const MATRIX_WEATHERS = Object.freeze(['clear', 'cloudy', 'rain']);

const list = (v, def) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : def);
const hhmm = (h) => {
  const m = Math.round(h * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
};

/* shot.mjs は最初の位置引数をシナリオにし、残りを捨てる。シナリオの後ろの位置引数をモジュール名とする */
function moduleArg() {
  const a = process.argv.slice(2);
  const i = a.findIndex((s) => s.endsWith('lab-matrix.mjs'));
  for (let k = i + 1; k < a.length; k++) {
    if (a[k].startsWith('--')) { k++; continue; }
    return a[k];
  }
  return process.env.LAB || 'core';
}

export default async function (h) {
  const lab = moduleArg();
  const tier = process.env.TIER || 'high';
  const frames = Number(process.env.FRAMES) || 24;
  await h.open(`lab/${lab}.html?capture=1&tier=${tier}`);
  await h.waitFor(() => window.__gfxReady === true, undefined, 180);
  const presets = list(process.env.PRESETS, await h.eval(() => Object.keys(window.__lab.presets())));
  const hours = list(process.env.HOURS, MATRIX_HOURS.map(String)).map(Number);
  const weathers = list(process.env.WEATHERS, MATRIX_WEATHERS);
  const all = [];
  for (const preset of presets) {
    for (const hour of hours) {
      for (const weather of weathers) {
        const meta = await h.eval(({ preset, hour, weather, frames }) => {
          const L = window.__lab, cam = L.camera, T = L.gfx.THREE;
          L.cam(preset);                     // プリセットの時刻・天候より表の値を優先する
          L.setHour(hour);
          L.setWeather(weather, { instant: true });
          L.freeze(10);
          L.tick(frames);
          /* 水平線（y = 0 の平面の無限遠 = 視線の水平成分の方向）の画面の位置（上から 0..1）とピッチ */
          const f = new T.Vector3();
          cam.getWorldDirection(f);
          const hd = new T.Vector3(f.x, 0, f.z);
          let horizon = null;
          if (hd.lengthSq() > 1e-6) {
            const p = cam.position.clone().addScaledVector(hd.normalize(), 1e5).setY(cam.position.y).project(cam);
            if (Math.abs(p.x) <= 1.5 && p.z < 1) horizon = (1 - p.y) / 2;
          }
          const s = L.stats();
          return {
            hour, weather, horizon, pitchDeg: Math.asin(Math.max(-1, Math.min(1, f.y))) * 180 / Math.PI,
            uw: s.uw > 0.5, nan: L.nanCheck(),
            stats: { draws: s.draws, tris: s.tris, programs: s.programs, exposure: s.exposure, tier: s.tier, msaa: s.msaa, rtBytes: s.rtBytes },
          };
        }, { preset, hour, weather, frames });
        const name = `${preset}_${hhmm(hour)}_${weather}`;
        await h.shot(name);
        const rec = { name, preset, lab, ...meta };
        fs.writeFileSync(path.join(h.out, `${name}.json`), JSON.stringify(rec, null, 1));
        all.push(rec);
      }
    }
  }
  fs.writeFileSync(path.join(h.out, 'matrix.json'), JSON.stringify({ lab, tier, shots: all }, null, 1));
  const bad = all.filter((r) => r.nan > 0);
  console.log(`lab-matrix: ${lab} ${tier} ${all.length} 枚${bad.length ? `、NaN のある絵 ${bad.map((r) => r.name).join(', ')}` : '、NaN 0'}`);
}
