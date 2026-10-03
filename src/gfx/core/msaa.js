/* ===========================================================
   MSAA の «resolve の後にもう一度描く» の実測と自動降格（ARCHITECTURE §3.2 / docs/nextgen/spikes.md S-1）
   -----------------------------------------------------------
   パイプラインは不透明を MSAA の mainRT に描いて resolve（コピー）し、同じ MSAA に水と半透明を
   重ねてもう一度 resolve する。タイル型の GPU（Apple）では 2 回目の描画の前に MSAA の全サンプルを
   メモリから読み戻し、1 回目の後で全サンプルを書き出す（本来 resolve だけで済む帯域）。
   この上乗せを起動時に «同じ大きさ・同じ形式・同じ順» の合成負荷で測り、閾値を超える GPU では
   high を 4× → 2× + SMAA に落とす（quality.msaaFallback）。
   - 測り方：各構成（MSAA 0 / 2 / 4）で «不透明 3 枚 → resolve → late 1 枚 → resolve» を回し、
     前後を 1×1 の readPixels で同期した実時間の中央値。cost(n) = t(n) − t(0)
   - 判定：cost(4) − cost(2) > NG_MSAA_FALLBACK_MS（2× + SMAA の SMAA ぶんを差し引いても 4× が高い）
   - URL の ?msaa=4|2 で判定を上書きできる（切り分け用）
   =========================================================== */

/** 4× を諦める閾値（ms）：4× と 2× の差がこれを超えたら 2× + SMAA（SMAA ≈ 0.35ms + 余裕）。
    0.9 → 0.6：実測の台（空に近い）の差は本編の差（不透明 + late で 1.5–2ms）より小さく、1440p の画素の上限の下で
    0.9 の前後を揺れて起動ごとに 4× / 2× が入れ替わっていた（本編の合計で ±0.6ms） */
export const NG_MSAA_FALLBACK_MS = 0.6;

const VS = /* glsl */ `
in vec3 position;
uniform float uZ;
uniform vec2 uScale;
void main() { gl_Position = vec4(position.xy * uScale, uZ, 1.0); }
`;
/* 不透明パス相当の軽い断片（帯域を測りたいので ALU は少なく、色は HDR の値） */
const FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
layout(location = 0) out vec4 oColor;
void main() { oColor = vec4(uColor * (1.0 + 0.001 * gl_FragCoord.x), 1.0); }
`;
const COPY_FS = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
layout(location = 0) out vec4 oColor;
void main() { oColor = texelFetch(tColor, ivec2(gl_FragCoord.xy), 0); }
`;

/**
 * MSAA の構成ごとの上乗せを測る
 * @param {typeof import('three')} THREE
 * @param {import('three').WebGLRenderer} renderer
 * @param {{width:number, height:number, iterations?:number, sync:() => void, hdr?:boolean}} o
 *   sync：GPU の完了を待つ関数（budget と同じ 1×1 の readPixels）
 * @returns {{width:number, height:number, ms:Record<string, number>, cost2:number, cost4:number, maxSamples:number}}
 */
export function measureMsaa(THREE, renderer, { width, height, iterations = 9, sync, hdr = true }) {
  const gl = renderer.getContext();
  const maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
  const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mats = [];
  /* 1 回の render() に 1 回の resolve（three は MSAA の RT への render ごとに resolve する）。
     不透明は 3 枚を 1 シーンで、late は半分の面積の 1 枚を別シーンで描く */
  const quad = (z, scale, c, fs = FS, extra = {}) => {
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs,
      uniforms: { uZ: { value: z }, uScale: { value: new THREE.Vector2(scale, scale) }, uColor: { value: new THREE.Color(c, c * 0.8, c * 0.6) }, ...extra },
    });
    mats.push(m);
    const mesh = new THREE.Mesh(tri, m);
    mesh.frustumCulled = false;
    return mesh;
  };
  const opaque = new THREE.Scene(), late = new THREE.Scene(), copyScene = new THREE.Scene();
  [[0.9, 2.0], [0.5, 1.0], [0.1, 0.5]].forEach(([z, c], i) => { const q = quad(z, 1, c); q.renderOrder = i; opaque.add(q); });
  late.add(quad(-0.2, 0.7, 3.0));
  const copyQuad = quad(0, 1, 1, COPY_FS, { tColor: { value: null } });
  copyQuad.material.depthTest = false;
  copyScene.add(copyQuad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const copy = new THREE.WebGLRenderTarget(width, height, { type, depthBuffer: false });
  const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
  const out = { width, height, ms: {}, cost2: 0, cost4: 0, maxSamples };
  renderer.autoClear = false;
  try {
    for (const samples of [0, 2, 4]) {
      if (samples > maxSamples) continue;
      const depthTexture = new THREE.DepthTexture(width, height);
      depthTexture.type = THREE.UnsignedIntType;
      const main = new THREE.WebGLRenderTarget(width, height, { type, samples, depthBuffer: true, depthTexture, stencilBuffer: false });
      copyQuad.material.uniforms.tColor.value = main.texture;
      const once = () => {
        renderer.setRenderTarget(main);
        renderer.clear(true, true, false);
        renderer.render(opaque, cam);           // P4（終わりに resolve）
        renderer.setRenderTarget(copy);
        renderer.render(copyScene, cam);        // P5（resolve 済みを読む）
        renderer.setRenderTarget(main);
        renderer.render(late, cam);             // P6（同じ MSAA へもう一度 → resolve）
      };
      for (let i = 0; i < 3; i++) once();
      const t = [];
      for (let i = 0; i < iterations; i++) {
        sync();
        const t0 = performance.now();
        once();
        sync();
        t.push(performance.now() - t0);
      }
      t.sort((a, b) => a - b);
      out.ms[samples] = t[t.length >> 1];
      main.dispose();
      depthTexture.dispose();
    }
  } finally {
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
    copy.dispose();
    for (const m of mats) m.dispose();
    tri.dispose();
  }
  const base = out.ms[0] ?? 0;
  if (out.ms[2] !== undefined) out.cost2 = Math.max(0, out.ms[2] - base);
  if (out.ms[4] !== undefined) out.cost4 = Math.max(0, out.ms[4] - base);
  return out;
}

/**
 * 実測から «high で 4× を諦めるか» を決める
 * @param {{cost2:number, cost4:number, maxSamples:number}} m measureMsaa の戻り値
 * @param {string|null} [override] URL の ?msaa=（'4' なら降格しない、'2' なら必ず降格）
 * @returns {{fallback:boolean, reason:string}}
 */
export function decideMsaa(m, override = null) {
  if (override === '4') return { fallback: false, reason: '?msaa=4' };
  if (override === '2') return { fallback: true, reason: '?msaa=2' };
  if (m.maxSamples < 4) return { fallback: true, reason: `MAX_SAMPLES ${m.maxSamples}` };
  const d = m.cost4 - m.cost2;
  return d > NG_MSAA_FALLBACK_MS
    ? { fallback: true, reason: `4× の上乗せ ${m.cost4.toFixed(2)}ms（2× より ${d.toFixed(2)}ms 高い）` }
    : { fallback: false, reason: `4× の上乗せ ${m.cost4.toFixed(2)}ms（2× との差 ${d.toFixed(2)}ms）` };
}
