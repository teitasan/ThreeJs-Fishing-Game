/* 描画の芯（src/gfx/core/index.js）の代わり。ARCHITECTURE §4.13 の名前だけを持ち、
   呼ばれた回数と引数を記録する。throwOn に名前を入れると、その呼び出しで例外を投げる
   （ファサードが例外を外へ出さないことの検査用） */
export const calls = [];
export const control = { throwOn: new Set(), frameResult: null };
let gfx = null;
const rec = (name, ret) => (...args) => {
  calls.push([name, args]);
  if (control.throwOn.has(name)) throw new Error(`stub: ${name}`);
  return typeof ret === 'function' ? ret(...args) : ret;
};
export function createGfx(opts) {
  calls.push(['createGfx', [opts]]);
  if (control.throwOn.has('createGfx')) throw new Error('stub: createGfx');
  gfx = {
    setLightRig: rec('setLightRig'),
    beginFrame: rec('beginFrame', () => control.frameResult),
    setUnderwater: rec('setUnderwater'),
    attachRenderer: rec('attachRenderer'),
    attachWorld: rec('attachWorld', (w) => Promise.resolve(w.grids).then(() => undefined)),
    wind: { update: rec('wind.update') },
    updateModules: rec('updateModules'),
    services: {
      hardscape: { setLamp: rec('hardscape.setLamp') },
      water: { addRipple: rec('water.addRipple'), addSplash: rec('water.addSplash') },
    },
    setFlow: rec('setFlow'),
    setLodScale: rec('setLodScale'),
    setQuality: rec('setQuality'),
    waterUpdate: rec('waterUpdate'),
    pipeline: { prepare: rec('pipeline.prepare'), renderReflection: rec('pipeline.renderReflection'), renderMain: rec('pipeline.renderMain') },
    setReflectionHidden: rec('setReflectionHidden'),
    getUnderwaterContext: rec('getUnderwaterContext', () => null),
    bindCamera: rec('bindCamera'),
    warmup: rec('warmup', () => Promise.resolve()),
  };
  return gfx;
}
export function getGfx() { return gfx; }
export function resetStub() { gfx = null; calls.length = 0; control.throwOn.clear(); control.frameResult = null; }
