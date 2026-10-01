/* ===========================================================
   インポスターの焼き込み（起動時、LOD0 から）
   -----------------------------------------------------------
   半八面体 8×8 フレーム × (樹種 × impVariants) 層を 2 枚の配列 RT に焼く：
     alb : rgb = √albedo（RGBA8 で暗い葉の段を残す）、a = 被覆
     nrm : rg = 木のローカルの法線（xzy の順で oct）、b = 葉の薄さ、a = AO
   1 層 = 1 回の描画（64 個のインスタンスが各フレームの升へ正射影する。shaders.js の IMP_BAKE_VS）。
   背景は (0,0,0,0)（被覆で割れば縁が黒くならない：前乗算の表現）
   =========================================================== */
import { IMP_BAKE_VS, IMP_BAKE_FS } from './shaders.js';
import { IMP_GRID } from './quality.js';

/**
 * @param {object} o
 * @param {typeof import('three')} o.T
 * @param {import('three').WebGLRenderer} o.renderer
 * @param {object} o.forge
 * @param {Array<{geo: import('three').BufferGeometry, cy:number, R:number, href:number}>} o.layers 層ごとの LOD0 と包み
 * @param {number} o.frame 1 フレームの px
 * @param {object} o.tex { barkAlb, leafAlb, leafNrm }
 */
export async function bakeImpostors(o) {
  const { T, renderer, forge, layers, frame, tex } = o;
  const size = frame * IMP_GRID;
  const mk = () => {
    const rt = new T.WebGLArrayRenderTarget(size, size, layers.length, { depthBuffer: true });
    const t = rt.texture;
    t.type = T.UnsignedByteType;
    t.format = T.RGBAFormat;
    t.minFilter = T.LinearMipmapLinearFilter;
    t.magFilter = T.LinearFilter;
    t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.anisotropy = 4;
    return rt;
  };
  const alb = mk(), nrm = mk();
  const uniforms = {
    ngBakeC: { value: new T.Vector4() }, ngMode: { value: 0 }, ngHref: { value: 20 },
    ngBarkAlb: { value: tex.barkAlb }, ngLeafAlb: { value: tex.leafAlb }, ngLeafNrm: { value: tex.leafNrm }, ngLeafSize: { value: tex.leafSize },
  };
  const mat = new T.ShaderMaterial({ vertexShader: IMP_BAKE_VS, fragmentShader: IMP_BAKE_FS, uniforms, side: T.DoubleSide });
  const scene = new T.Scene();
  const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevColor = new T.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = true;
  const meshes = [];
  try {
    for (let L = 0; L < layers.length; L++) {
      const src = layers[L];
      const g = new T.InstancedBufferGeometry();
      for (const [k, a] of Object.entries(src.geo.attributes)) g.setAttribute(k, a);
      g.setIndex(src.geo.index);
      g.instanceCount = IMP_GRID * IMP_GRID;
      const m = new T.Mesh(g, mat);
      m.frustumCulled = false;
      meshes.push(m);
      scene.add(m);
      uniforms.ngBakeC.value.set(0, src.cy, 0, src.R);
      uniforms.ngHref.value = src.href;
      for (const [rt, mode] of [[alb, 0], [nrm, 1]]) {
        uniforms.ngMode.value = mode;
        rt.texture.generateMipmaps = L === layers.length - 1;
        forge.renderView(rt, L, scene, cam);
      }
      scene.remove(m);
      await forge.step();
    }
  } finally {
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAuto;
    for (const m of meshes) m.geometry.dispose?.();
    mat.dispose();
  }
  alb.texture.generateMipmaps = nrm.texture.generateMipmaps = false;
  const texBytes = Math.round(size * size * layers.length * 4 * 2 * 1.333);
  return { alb, nrm, size, texBytes };
}
