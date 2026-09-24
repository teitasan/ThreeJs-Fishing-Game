/* ===========================================================
   Clearwater-inspired spectral waves and local ripple simulation.
   MIT-derived algorithms: see third_party/clearwater-NOTICE.txt.
   =========================================================== */
import * as THREE from 'three';

const PATCH_SIZE = 32;
const RIPPLE_SIZE = 20;
const TARGET_SLOPE = 0.055;

const FULLSCREEN_VERTEX = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function makeMaterial(fragmentShader, uniforms = {}) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function makeTarget(size, { linear = false, mipmaps = false } = {}) {
  const target = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : linear ? THREE.LinearFilter : THREE.NearestFilter,
    magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: mipmaps,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.generateMipmaps = mipmaps;
  return target;
}

function seededRandom(seed) {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeSpectrum(size) {
  const random = seededRandom(0x43ea71);
  const gaussian = () => {
    let u = 0;
    while (u === 0) u = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
  const re = new Float32Array(size * size);
  const im = new Float32Array(size * size);
  let slope2 = 0;
  const peak = 2 * Math.PI / 3.8;
  const cutoff = 2 * Math.PI / 0.38;
  const wind = [0.8, 0.6];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x < size / 2 ? x : x - size;
      const ny = y < size / 2 ? y : y - size;
      const kx = 2 * Math.PI * nx / PATCH_SIZE;
      const kz = 2 * Math.PI * ny / PATCH_SIZE;
      const k = Math.hypot(kx, kz);
      let power = 0;
      if (k > 1e-6) {
        const logPeak = Math.log(k / peak);
        const swell = 0.34 * Math.exp(-0.5 * (Math.log(k / (2 * Math.PI / 13)) / 0.34) ** 2);
        const peakBand = Math.exp(-0.5 * (logPeak / 0.42) ** 2);
        const tail = 0.035 * Math.exp(-((peak / k) ** 2)) * Math.exp(-((k / cutoff) ** 2));
        const alignment = (kx * wind[0] + kz * wind[1]) / k;
        const spread = (0.3 + 0.7 * alignment * alignment) * (alignment < 0 ? 0.35 : 1);
        power = (peakBand + tail + swell) * spread / (k ** 4);
      }
      const i = y * size + x;
      const scale = Math.sqrt(power / 2);
      re[i] = gaussian() * scale;
      im[i] = gaussian() * scale;
      slope2 += 2 * k * k * (re[i] * re[i] + im[i] * im[i]);
    }
  }

  const scale = TARGET_SLOPE / Math.sqrt(Math.max(slope2, 1e-12));
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const opposite = ((size - y) % size) * size + ((size - x) % size);
      const o = i * 4;
      data[o] = re[i] * scale;
      data[o + 1] = im[i] * scale;
      data[o + 2] = re[opposite] * scale;
      data[o + 3] = -im[opposite] * scale;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const SPECTRUM_FRAGMENT = (size) => /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  precision highp int;
  uniform sampler2D uH0;
  uniform float uTime;
  out vec4 outColor;
  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }
  void main() {
    ivec2 id = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(uH0, id, 0);
    vec2 n = vec2(id);
    n -= step(${size / 2}.0, n) * ${size}.0;
    vec2 k = 6.28318530718 * n / ${PATCH_SIZE}.0;
    float kl = length(k);
    float w = sqrt(9.81*kl + 7.4e-5*kl*kl*kl);
    float w0 = 6.28318530718 / 60.0;
    w = floor(w / w0) * w0;
    float c = cos(w*uTime), sn = sin(w*uTime);
    vec2 H = cmul(s.xy, vec2(c,sn)) + cmul(s.zw, vec2(c,-sn));
    outColor = vec4(H, 0.0, 0.0);
  }
`;

const FFT_FRAGMENT = (size) => /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  precision highp int;
  uniform sampler2D uSource;
  uniform int uButterfly;
  uniform int uHorizontal;
  out vec4 outColor;
  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }
  void main() {
    ivec2 id = ivec2(gl_FragCoord.xy);
    int j = uHorizontal == 1 ? id.x : id.y;
    int k = j & (uButterfly - 1);
    int i = ((j - (j & (2*uButterfly - 1))) >> 1) + k;
    bool upper = (j & uButterfly) != 0;
    ivec2 a = uHorizontal == 1 ? ivec2(i, id.y) : ivec2(id.x, i);
    ivec2 b = uHorizontal == 1 ? ivec2(i+${size / 2}, id.y) : ivec2(id.x, i+${size / 2});
    vec4 x0 = texelFetch(uSource, a, 0);
    vec4 x1 = texelFetch(uSource, b, 0);
    float angle = 3.14159265359 * float(k) / float(uButterfly);
    vec2 twiddle = vec2(cos(angle), sin(angle));
    vec4 wx = vec4(cmul(twiddle,x1.xy), cmul(twiddle,x1.zw));
    outColor = upper ? x0-wx : x0+wx;
  }
`;

const RESOLVE_FRAGMENT = (size) => /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D uSource;
  out vec4 outColor;
  float heightAt(ivec2 p) {
    ivec2 n = ivec2(${size});
    return texelFetch(uSource, (p+n)%n, 0).x;
  }
  void main() {
    ivec2 id = ivec2(gl_FragCoord.xy);
    vec2 stepM = vec2(${PATCH_SIZE}.0 / ${size}.0);
    float h = heightAt(id);
    float dx = (heightAt(id+ivec2(1,0))-heightAt(id-ivec2(1,0))) / (2.0*stepM.x);
    float dz = (heightAt(id+ivec2(0,1))-heightAt(id-ivec2(0,1))) / (2.0*stepM.y);
    outColor = vec4(h, dx, dz, dx*dx+dz*dz);
  }
`;

const RIPPLE_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uSource;
  uniform vec2 uShift;
  uniform vec4 uDrop;
  out vec4 outColor;
  void main() {
    vec2 px = 1.0 / vec2(textureSize(uSource, 0));
    vec2 uv = vUv + uShift;
    vec4 c = texture(uSource, uv);
    float avg = 0.25 * (
      texture(uSource, uv+vec2(px.x,0)).r + texture(uSource, uv-vec2(px.x,0)).r +
      texture(uSource, uv+vec2(0,px.y)).r + texture(uSource, uv-vec2(0,px.y)).r
    );
    float velocity = (c.g + (avg-c.r)*0.9) * 0.9955;
    float height = (c.r + velocity) * 0.9985;
    float d = length((vUv-uDrop.xy));
    if (uDrop.w > 0.0 && d < uDrop.z) {
      height -= uDrop.w * (0.5 + 0.5*cos(3.14159265*d/uDrop.z));
    }
    vec2 edgeDist = min(vUv, 1.0-vUv);
    float edge = smoothstep(0.0, 0.06, min(edgeDist.x, edgeDist.y));
    height *= mix(0.90, 1.0, edge);
    velocity *= mix(0.90, 1.0, edge);
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
      height = 0.0;
      velocity = 0.0;
    }
    outColor = vec4(height, velocity, 0.0, 1.0);
  }
`;

const RIPPLE_NORMAL_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  uniform sampler2D uSource;
  uniform float uTexel;
  out vec4 outColor;
  void main() {
    vec2 px = 1.0 / vec2(textureSize(uSource, 0));
    float h = texture(uSource, vUv).r;
    float hx = texture(uSource, vUv+vec2(px.x,0)).r - texture(uSource, vUv-vec2(px.x,0)).r;
    float hz = texture(uSource, vUv+vec2(0,px.y)).r - texture(uSource, vUv-vec2(0,px.y)).r;
    float lap = (texture(uSource, vUv+vec2(px.x,0)).r + texture(uSource, vUv-vec2(px.x,0)).r +
      texture(uSource, vUv+vec2(0,px.y)).r + texture(uSource, vUv-vec2(0,px.y)).r - 4.0*h) /
      (uTexel*uTexel);
    outColor = vec4(h, hx/(2.0*uTexel), hz/(2.0*uTexel), lap);
  }
`;

const CLEAR_FRAGMENT = /* glsl */ `
  precision highp float;
  out vec4 outColor;
  void main() { outColor = vec4(0.0); }
`;

/** GPU water fields that fit into the game's Three.js water pipeline. */
export class ClearwaterWaterField {
  constructor(renderer, quality = 'mid') {
    this.renderer = renderer;
    this.quality = quality;
    this.size = 256;
    this.rippleSize = RIPPLE_SIZE;
    this.center = new THREE.Vector2();
    this._forward = new THREE.Vector3();
    this._shift = new THREE.Vector2();
    this.drops = [];
    this.activeFrames = 900;
    this.rippleIndex = 0;
    this.fftA = makeTarget(this.size);
    this.fftB = makeTarget(this.size);
    this.surface = makeTarget(this.size, { linear: true, mipmaps: true });
    this.rippleA = makeTarget(this.size, { linear: true });
    this.rippleB = makeTarget(this.size, { linear: true });
    this.rippleNormals = makeTarget(this.size, { linear: true });
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), makeMaterial(CLEAR_FRAGMENT));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this._buildMaterials();
    this._initializeTargets();
    this.updateSpectrum(0);
    this.lastSpectrumAt = 0;
  }

  _buildMaterials() {
    this.h0Texture = makeSpectrum(this.size);
    this.spec = makeMaterial(SPECTRUM_FRAGMENT(this.size), {
      uH0: { value: this.h0Texture }, uTime: { value: 0 },
    });
    this.fft = makeMaterial(FFT_FRAGMENT(this.size), {
      uSource: { value: null }, uButterfly: { value: 1 }, uHorizontal: { value: 1 },
    });
    this.resolve = makeMaterial(RESOLVE_FRAGMENT(this.size), { uSource: { value: null } });
    this.ripple = makeMaterial(RIPPLE_FRAGMENT, {
      uSource: { value: null }, uShift: { value: new THREE.Vector2() },
      uDrop: { value: new THREE.Vector4(-10, -10, 0, 0) },
    });
    this.rippleNormal = makeMaterial(RIPPLE_NORMAL_FRAGMENT, {
      uSource: { value: null }, uTexel: { value: this.rippleSize / this.size },
    });
    this.clear = makeMaterial(CLEAR_FRAGMENT);
  }

  _render(material, target) {
    const previous = this.renderer.getRenderTarget();
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(previous);
  }

  _initializeTargets() {
    this._render(this.clear, this.rippleA);
    this._render(this.clear, this.rippleB);
    this._render(this.clear, this.rippleNormals);
  }

  updateSpectrum(time) {
    this.spec.uniforms.uTime.value = time;
    this._render(this.spec, this.fftA);
    let source = this.fftA;
    let destination = this.fftB;
    for (const horizontal of [1, 0]) {
      this.fft.uniforms.uHorizontal.value = horizontal;
      for (let stage = 0; stage < Math.log2(this.size); stage++) {
        this.fft.uniforms.uSource.value = source.texture;
        this.fft.uniforms.uButterfly.value = 1 << stage;
        this._render(this.fft, destination);
        [source, destination] = [destination, source];
      }
    }
    this.resolve.uniforms.uSource.value = source.texture;
    this._render(this.resolve, this.surface);
  }

  _moveCenter(camera) {
    const forward = this._forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const look = camera.position.y > 0
      ? -camera.position.y / Math.min(forward.y, -0.2) * 0.9
      : 0;
    const wantX = camera.position.x + forward.x * look;
    const wantZ = camera.position.z + forward.z * look;
    const texel = this.rippleSize / this.size;
    const dx = Math.round((wantX - this.center.x) / texel);
    const dz = Math.round((wantZ - this.center.y) / texel);
    return { dx, dz, shift: this._shift.set(dx / this.size, dz / this.size) };
  }

  addRipple(x, z, size = 1) {
    if (Math.max(Math.abs(x - this.center.x), Math.abs(z - this.center.y)) > this.rippleSize * 0.45) {
      this.center.set(x, z);
      this._initializeTargets();
      this.rippleIndex = 0;
    }
    this.drops.push({ x, z, size });
    if (this.drops.length > 24) this.drops.shift();
    this.activeFrames = 0;
  }

  update(dt, time, camera) {
    if (time - this.lastSpectrumAt >= 1 / 30) {
      this.updateSpectrum(time);
      this.lastSpectrumAt = time;
    }
    const move = this._moveCenter(camera);
    if (Math.abs(move.dx) >= this.size || Math.abs(move.dz) >= this.size) {
      this.center.set(camera.position.x, camera.position.z);
      this._initializeTargets();
      this.rippleIndex = 0;
      move.dx = 0;
      move.dz = 0;
    }
    this.center.x += move.dx * this.rippleSize / this.size;
    this.center.y += move.dz * this.rippleSize / this.size;

    if (this.activeFrames >= 900 && this.drops.length === 0) return;
    const source = this.rippleIndex === 0 ? this.rippleA : this.rippleB;
    const destination = this.rippleIndex === 0 ? this.rippleB : this.rippleA;
    this.ripple.uniforms.uSource.value = source.texture;
    this.ripple.uniforms.uShift.value.copy(move.shift);
    const drop = this.drops.shift();
    if (drop) {
      const uvx = (drop.x - this.center.x) / this.rippleSize + 0.5;
      const uvz = (drop.z - this.center.y) / this.rippleSize + 0.5;
      const radius = (0.32 + Math.min(drop.size, 1.8) * 0.09) / this.rippleSize;
      const strength = 0.08 * Math.min(Math.max(drop.size, 0.25), 1.8);
      this.ripple.uniforms.uDrop.value.set(uvx, uvz, radius, strength);
    } else {
      this.ripple.uniforms.uDrop.value.set(-10, -10, 0, 0);
    }
    this._render(this.ripple, destination);
    this.rippleIndex = 1 - this.rippleIndex;
    const current = this.rippleIndex === 0 ? this.rippleA : this.rippleB;
    this.rippleNormal.uniforms.uSource.value = current.texture;
    this._render(this.rippleNormal, this.rippleNormals);
    this.activeFrames++;
  }

  dispose() {
    for (const target of [this.fftA, this.fftB, this.surface, this.rippleA, this.rippleB, this.rippleNormals]) {
      target?.dispose();
    }
    this.h0Texture?.dispose();
    this.quad?.geometry?.dispose();
    for (const material of [this.spec, this.fft, this.resolve, this.ripple, this.rippleNormal, this.clear]) {
      material?.dispose();
    }
  }

  get surfaceTexture() { return this.surface.texture; }
  get rippleTexture() { return this.rippleNormals.texture; }
}
