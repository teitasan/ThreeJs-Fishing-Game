/* ===========================================================
   lab ページの共通の起動（lab/<module>.html から呼ぶ）
   -----------------------------------------------------------
   bootLabPage({ modules: ['water'] }) で Lab.boot し、URL の
   ?hour= &weather= &cam= &view= &freeze= &tier= &chart=0 &capture=1 を反映する。
   キー：1–9 でプリセット、[ / ] で 1 時間、w で天候、v でデバッグ表示を巡回、f で false color
   =========================================================== */
import { Lab } from '../../src/gfx/core/lab/labkit.js';

const VIEWS = [null, 'refl', 'sceneColor', 'depth', 'nearShadow', 'hfShadow', 'skyView', 'falseColor'];
const WEATHER = ['clear', 'cloudy', 'rain'];

/**
 * @param {{modules?: string[], characters?: boolean}} [o]
 * @returns {Promise<object>} window.__lab
 */
export async function bootLabPage(o = {}) {
  const q = new URLSearchParams(location.search);
  const status = document.getElementById('lab-status') || Object.assign(document.body.appendChild(document.createElement('div')), { id: 'lab-status' });
  if (q.get('capture') === '1') document.body.classList.add('capture');
  const lab = await Lab.boot({ ...o, onProgress: (t) => { status.textContent = t ? `lab: ${t}` : ''; } });
  if (q.has('cam')) lab.cam(q.get('cam'));
  if (q.has('hour')) lab.setHour(Number(q.get('hour')));
  if (q.has('weather')) lab.setWeather(q.get('weather'), { instant: true });
  if (q.has('view')) lab.view(q.get('view'));
  if (q.has('freeze')) lab.freeze(Number(q.get('freeze')));
  const names = Object.keys(lab.presets());
  let vi = 0, wi = 0, hour = q.has('hour') ? Number(q.get('hour')) : 12;
  addEventListener('keydown', (e) => {
    if (e.key >= '1' && e.key <= '9') lab.cam(names[Number(e.key) - 1]);
    else if (e.key === ']') lab.setHour((hour = (hour + 1) % 24));
    else if (e.key === '[') lab.setHour((hour = (hour + 23) % 24));
    else if (e.key === 'w') lab.setWeather(WEATHER[(wi = (wi + 1) % 3)]);
    else if (e.key === 'v') lab.view(VIEWS[(vi = (vi + 1) % VIEWS.length)]);
    else if (e.key === 'f') lab.view('falseColor');
  });
  if (q.get('capture') !== '1') {
    setInterval(() => {
      const s = lab.stats();
      const gpu = Object.entries(s.gpuMs).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ');
      status.textContent = `${s.tier} ${s.fps.toFixed(0)}fps draws ${s.draws} tris ${(s.tris / 1e6).toFixed(2)}M prog ${s.programs}\ngpu ${s.gpuTotal.toFixed(2)}ms: ${gpu}`;
    }, 500);
  }
  return lab;
}
