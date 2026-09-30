/* ===========================================================
   中身の無いグレーボックス（groundcover / shoreflora / weatherfx）
   -----------------------------------------------------------
   本番のモジュールが来るまで root だけを持つ。受け口の既定値は module.js の Services
   =========================================================== */
import { NgModule } from '../module.js';

/**
 * id だけを持つ空のモジュールのクラスを作る
 * @param {string} id
 * @returns {typeof NgModule}
 */
export function emptyModule(id) {
  return class extends NgModule {
    static id = id;
    async init(progress) {
      this.ctx.scene.add(this.root);
      progress?.(1);
    }
  };
}

const Groundcover = emptyModule('groundcover');
const Shoreflora = emptyModule('shoreflora');
const Weatherfx = emptyModule('weatherfx');

/** @param {object} ctx */
export const groundcover = (ctx) => new Groundcover(ctx);
/** @param {object} ctx */
export const shoreflora = (ctx) => new Shoreflora(ctx);
/** @param {object} ctx */
export const weatherfx = (ctx) => new Weatherfx(ctx);
