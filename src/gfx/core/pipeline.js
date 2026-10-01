/* ===========================================================
   フレームのパイプライン（ARCHITECTURE §3.1–3.3）
   -----------------------------------------------------------
   game.js の呼び出し順（capture → captureReflection → updateUnderwater → render）に
   そのまま乗る：
     prepare()          P1 preparers（モジュールの prepare・高さ場影のスライス）+ P2 近景の影を 1 回
     renderReflection() P3 平面反射（鏡映カメラ、斜め近クリップ y = −0.03、passId 1）
     renderMain(dt)     P4 不透明 → P5 コピー（sceneColor + 線形深度）→ P6 late → P7 post
   - prepare / renderReflection は同じフレームで何度呼ばれても 1 回だけ働く（冪等）。
     game が呼ばなかったら renderMain が呼ぶ
   - late 物体（ng 以外で transparent / depthTest=false / renderOrder ≥ 5）は不透明パスで
     visible を退避して隠し、LATE 層を足して late パスで描く。描画後は必ず戻す
   - ライトは毎フレーム layers.enableAll（late のマスクで太陽が消える事故を防ぐ）
   - 各パスは guardPass で包む。パイプラインは例外を game へ再送出しない。止まったパスは間を空けて試し直す。
     post が落ちたら sceneColor（main）を簡易トーンマップで画面へ出す
   - render の中で呼ばれる物体・マテリアルの関数（onBeforeRender・onBeforeCompile など）は毎フレームの走査で
     包む（safety.guardRenderHooks）。投げても render は外へ例外を出さず、持ち主のモジュールだけが数えられる
   - WebGL の文脈の喪失：preventDefault して描画を止め、復帰でモジュールの restoreGPU
   =========================================================== */
import { NG_PASS } from './frame.js';
import { NG_LAYER, NG_MASK } from './layers.js';
import { ngSnapRenderScale } from './quality.js';

const COPY_VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
/* 不透明の写し：色と、深度バッファからの線形深度（m）。空（深度 1）は far */
const COPY_FS = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform highp sampler2D tDepth;
uniform vec2 uNearFar;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDepth;
void main() {
  vec4 c = texture(tColor, vUv);
  oColor = vec4(max(c.rgb, vec3(0.0)), 1.0);
  float d = texture(tDepth, vUv).r;
  float n = uNearFar.x, f = uNearFar.y;
  float z = d >= 1.0 ? f : (n * f) / (f - d * (f - n));
  oDepth = vec4(z, 0.0, 0.0, 1.0);
}
`;
/* post が使えないときの最後の砦：露出 × Reinhard × sRGB */
const BLIT_FS = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform float uExposure;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
void main() {
  vec3 c = max(texture(tColor, vUv).rgb, vec3(0.0)) * uExposure;
  c = c / (1.0 + c);
  oColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}
`;

/**
 * パスを順に回す
 */
export class FramePipeline {
  /**
   * @param {object} o
   * @param {typeof import('three')} o.THREE
   * @param {import('three').WebGLRenderer} o.renderer
   * @param {import('three').Scene} o.scene
   * @param {import('./frame.js').NgFrame} o.frame
   * @param {import('./shadows.js').Shadows} o.shadows
   * @param {import('./quality.js').Quality} o.quality
   * @param {import('./targets.js').Targets} o.targets
   * @param {import('./budget.js').Budget} o.budget
   * @param {import('./safe.js').Safety} o.safety
   * @param {() => object} o.frameInfo gfx の f（モジュールの prepare に渡す）
   * @param {(f:object) => void} o.prepareModules
   * @param {(passId:number, camera:object) => void} o.beforePass
   * @param {(obj:object) => (string|null)} [o.ownerOf] 物体の持ち主のモジュール id（描画の中の失敗の数え先）
   */
  constructor(o) {
    Object.assign(this, {
      THREE: o.THREE, renderer: o.renderer, scene: o.scene, frame: o.frame, shadows: o.shadows,
      quality: o.quality, targets: o.targets, budget: o.budget, safety: o.safety,
      _frameInfo: o.frameInfo, _prepareModules: o.prepareModules, _beforePass: o.beforePass,
      _ownerOf: o.ownerOf || (() => null),
    });
    const T = this.THREE;
    this._protos = { object: T.Object3D.prototype, material: T.Material.prototype };
    /** @type {import('three').PerspectiveCamera|null} */
    this.camera = null;
    /** 共有 uniforms（RT を作り直しても {value} は同じ。水・post が読む） */
    this.uniforms = {
      ngSceneColor: { value: null },
      ngSceneDepth: { value: null },
      ngReflection: { value: null },
      ngReflMatrix: { value: new T.Matrix4() },
      ngReflValid: { value: 0 },
      ngScreen: { value: new T.Vector4(1, 1, 1, 1) },
      ngCopyMips: { value: 0 },
    };
    /** フレームの状態（lab と post が読む） */
    this.state = { frameIndex: 0, underwater: false, reflectionEnabled: true, prepared: -1, reflected: -1, rendered: -1, lost: false };
    this.renderScale = 1;
    this._size = new T.Vector2(1, 1);
    this._preparers = [];
    this._reflHidden = [];
    this._late = [];
    this._scannedFrame = -1;
    this._hidden = [];
    this._mirror = new T.PerspectiveCamera();
    this._mirror.layers.mask = NG_MASK.REFLECTION;
    this._frustum = new T.Frustum();
    this._m4 = new T.Matrix4();
    this._lakeBox = new T.Box3(new T.Vector3(-600, -0.4, -600), new T.Vector3(600, 0.4, 600));
    this._plane = new T.Plane();
    this._clip = new T.Vector4();
    this._q = new T.Vector4();
    this._up = new T.Vector3(0, 1, 0);
    this._fsScene = new T.Scene();
    this._fsCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = new T.BufferGeometry();
    tri.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this._copyMat = new T.RawShaderMaterial({
      glslVersion: T.GLSL3, vertexShader: COPY_VS, fragmentShader: COPY_FS, depthTest: false, depthWrite: false,
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uNearFar: { value: new T.Vector2(0.1, 3000) } },
    });
    this._blitMat = new T.RawShaderMaterial({
      glslVersion: T.GLSL3, vertexShader: COPY_VS, fragmentShader: BLIT_FS, depthTest: false, depthWrite: false,
      uniforms: { tColor: { value: null }, uExposure: { value: 1 } },
    });
    this._fsMesh = new T.Mesh(tri, this._copyMat);
    this._fsMesh.frustumCulled = false;
    this._fsScene.add(this._fsMesh);
    /** post（gfx が post モジュールの renderPost を入れる）。(targets, dt) → 画面へ描く。準備前は false を返す */
    this.post = null;
    this._onLost = (e) => { e.preventDefault(); this.state.lost = true; };
    /* three の復帰処理（renderer が先に登録）の後に走る。GL の物は three が遅延で作り直すので、
       ここでは «中身を焼き直す» ものだけ（onRestore）と、無効になった問い合わせを捨てる */
    this._onRestored = () => {
      this.state.lost = false;
      this.targets.forget();
      this.uniforms.ngReflValid.value = 0;
      this.budget.restoreGPU();
      try { this.onRestore?.(); } catch (e) { this.safety.warn('文脈の復帰で例外', e); }
    };
    const el = this.renderer.domElement;
    el?.addEventListener?.('webglcontextlost', this._onLost, false);
    el?.addEventListener?.('webglcontextrestored', this._onRestored, false);
    /** 文脈の復帰で呼ぶ（gfx がモジュールの restoreGPU を入れる） */
    this.onRestore = null;
  }

  /** 描くカメラ（PostFX が bindCamera で渡す） */
  setCamera(camera) { this.camera = camera; }

  /**
   * P1 に準備の仕事を足す（毎フレーム、prepare の中で順に呼ぶ）
   * @param {string} id
   * @param {() => void} fn
   * @param {number} [budgetMs]
   */
  addPreparer(id, fn, budgetMs = 0) { this._preparers.push({ id, fn, budgetMs }); }

  /**
   * 画面の大きさが変わった（PostFX.setSize）。RT は毎フレーム描画バッファの物理 px と
   * 比べて作り直すので、ここでは次の確保を強制するだけ
   */
  setSize() { this.targets._key = ''; }

  /** 動的解像度の倍率。NG_DRS_LEVELS の段に丸める（RT の作り直しは段が変わったときだけ） */
  setRenderScale(s) { this.renderScale = ngSnapRenderScale(s || 1); }

  /** 品質の変更（RT は次の描画で作り直す） */
  setQuality() { this.targets._key = ''; }

  /** 反射に写さない物（ゲームの setReflectionHidden） */
  setReflectionHidden(list) { this._reflHidden = (list || []).filter(Boolean); }

  /** 新しいフレームを始める（gfx.beginFrame から） */
  beginFrame() {
    this.state.frameIndex++;
    this.safety.frameIndex = this.state.frameIndex;
  }

  _ensureTargets() {
    const r = this.renderer;
    const s = this._size;
    r.getDrawingBufferSize(s);
    const changed = this.targets.ensure(s.x, s.y, this.renderScale, this.quality.profile);
    const t = this.targets;
    const u = this.uniforms;
    u.ngSceneColor.value = t.copy.textures[0];
    u.ngSceneDepth.value = t.copy.textures[1];
    u.ngReflection.value = t.refl.texture;
    u.ngScreen.value.set(t.main.width, t.main.height, 1 / t.main.width, 1 / t.main.height);
    u.ngCopyMips.value = this.quality.profile.copyMips;
    return changed;
  }

  /* ゲームの late 物体を集め、ライトを全層にし、描画の中で呼ばれる関数を包む（1 回の traverse）。反射と本描画で同じフレームに
     2 回呼ばれるが、その間に game は物体を動かさない（updateUnderwater だけ）ので 1 フレーム 1 回 */
  _scan() {
    if (this._scannedFrame === this.state.frameIndex) return;
    this._scannedFrame = this.state.frameIndex;
    const late = this._late;
    late.length = 0;
    const safety = this.safety, owner = this._ownerOf, protos = this._protos;
    this.scene.traverse((o) => {
      if (o.isLight) { o.layers.enableAll(); return; }
      safety.guardRenderHooks(o, owner, protos);
      if (o.userData.ngOwned) return;
      const m = o.material;
      if (!m || !(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
      const mm = Array.isArray(m) ? m[0] : m;
      if (mm && (mm.transparent || mm.depthTest === false || o.renderOrder >= 5)) {
        o.layers.enable(NG_LAYER.LATE);
        if (o.visible) late.push(o);
      } else {
        o.layers.disable(NG_LAYER.LATE);   // 不透明に戻った物を二重に描かない
      }
    });
  }

  _hide(list) {
    const h = this._hidden;
    for (const o of list) if (o && o.visible) { o.visible = false; h.push(o); }
  }
  _restoreHidden() {
    for (const o of this._hidden) o.visible = true;
    this._hidden.length = 0;
  }

  /**
   * P1 + P2。冪等（同じフレームで 2 回目以降は何もしない）。
   * 計測はサブパス prep / hfShadow / shadow（budget が capture にまとめる）
   */
  prepare() {
    const st = this.state;
    if (st.lost || st.prepared === st.frameIndex || !this.camera) return;
    st.prepared = st.frameIndex;
    const r = this.renderer, b = this.budget;
    this.safety.guardPass('targets', () => this._ensureTargets());
    const f = this._frameInfo();
    b.begin('prep');
    this.safety.guardPass('preparers', () => {
      this._prepareModules(f);
      for (const p of this._preparers) this.safety.guardPass('prep:' + p.id, p.fn);
    });
    b.begin('hfShadow');
    this.safety.guardPass('hfShadow', () => this.shadows.updateHf(f.keyDir));
    b.begin('shadow');
    const auto = r.autoClear;
    r.autoClear = false;
    r.shadowMap.autoUpdate = false;
    this.safety.guardPass('shadow', () => {
      this._beforePass(NG_PASS.SHADOW, this.camera);
      this.shadows.renderNear(r, this.scene);
    });
    r.autoClear = auto;
    b.end();
  }

  /* 湖面が画面に入っているか（入っていなければ反射を描かない） */
  _lakeVisible(cam) {
    this._m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m4);
    return this._frustum.intersectsBox(this._lakeBox);
  }

  /**
   * P3 平面反射。冪等。水中・湖面が画面外・low の隔フレームでは描かない（前の絵を使う）
   */
  renderReflection() {
    const st = this.state, cam = this.camera;
    if (st.lost || st.reflected === st.frameIndex || !cam) return;
    if (st.prepared !== st.frameIndex) this.prepare();
    st.reflected = st.frameIndex;
    const prof = this.quality.profile;
    const u = this.uniforms;
    cam.updateMatrixWorld();
    const skip = this.frame.cam.uw > 0.5 || !st.reflectionEnabled || !this._lakeVisible(cam);
    if (skip) { u.ngReflValid.value = 0; return; }
    if (prof.reflection.everyOther && (st.frameIndex & 1) && u.ngReflValid.value > 0) return;
    this.budget.begin('reflection');
    const r = this.renderer;
    const auto = r.autoClear, mask = cam.layers.mask;
    this._scan();
    const ok = this.safety.guardPass('reflection', () => {
      const m = this._setupMirror(cam);
      this._hide(this._reflHidden);
      this._hide(this._late);
      try {
        r.autoClear = false;
        this.frame.beginPass(NG_PASS.REFLECTION, m);
        this._beforePass(NG_PASS.REFLECTION, m);
        r.setRenderTarget(this.targets.refl);
        r.setClearColor(0x000000, 0);
        r.clear(true, true, false);
        r.render(this.scene, m);
      } finally {
        this._restoreHidden();
        r.autoClear = auto;
        cam.layers.mask = mask;
      }
      /* 世界座標 → 反射 RT の uv（射影テクスチャ） */
      u.ngReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
        .multiply(m.projectionMatrix).multiply(m.matrixWorldInverse);
    });
    u.ngReflValid.value = ok ? 1 : 0;
    this.budget.end();
  }

  /* 鏡映カメラ：y = 0 で位置・視線・上方向を折り返し、y = −0.03 の斜め近クリップ面を入れる */
  _setupMirror(cam) {
    const m = this._mirror;
    const e = cam.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    m.position.set(px, -py, pz);
    m.up.set(e[4], -e[5], e[6]);
    m.lookAt(px - e[8], -(py - e[9]), pz - e[10]);
    m.near = cam.near; m.far = cam.far; m.fov = cam.fov; m.aspect = cam.aspect; m.zoom = cam.zoom;
    m.updateProjectionMatrix();
    m.updateMatrixWorld();
    m.matrixWorldInverse.copy(m.matrixWorld).invert();
    const plane = this._plane.set(this._up, 0.03).applyMatrix4(m.matrixWorldInverse);
    const c = this._clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const P = m.projectionMatrix.elements;
    const q = this._q.set((Math.sign(c.x) + P[8]) / P[0], (Math.sign(c.y) + P[9]) / P[5], -1, (1 + P[10]) / P[14]);
    c.multiplyScalar(2 / c.dot(q));
    P[2] = c.x; P[6] = c.y; P[10] = c.z + 1; P[14] = c.w;
    m.projectionMatrixInverse.copy(m.projectionMatrix).invert();
    m.layers.mask = NG_MASK.REFLECTION;
    return m;
  }

  /**
   * P4–P7。game が prepare / renderReflection を呼んでいなければここで呼ぶ
   * @param {number} dt
   */
  renderMain(dt) {
    const st = this.state, cam = this.camera;
    if (st.lost || !cam) return;
    if (st.prepared !== st.frameIndex) this.prepare();
    if (st.reflected !== st.frameIndex) this.renderReflection();
    if (st.rendered === st.frameIndex) return;
    st.rendered = st.frameIndex;
    const r = this.renderer, t = this.targets;
    if (!t.main) return;
    const auto = r.autoClear, mask = cam.layers.mask;
    r.autoClear = false;
    this._scan();
    try {
      this.budget.begin('opaque');
      this.safety.guardPass('opaque', () => {
        this._hide(this._late);
        try {
          cam.layers.mask = NG_MASK.OPAQUE;
          this.frame.beginPass(NG_PASS.MAIN, cam);
          this._beforePass(NG_PASS.MAIN, cam);
          r.setRenderTarget(t.main);
          r.setClearColor(0x000000, 0);
          r.clear(true, true, true);
          r.render(this.scene, cam);
        } finally {
          this._restoreHidden();
        }
      });
      this.budget.begin('copy');
      this.safety.guardPass('copy', () => {
        this._copyMat.uniforms.tColor.value = t.main.texture;
        this._copyMat.uniforms.tDepth.value = t.main.depthTexture;
        this._copyMat.uniforms.uNearFar.value.set(cam.near, cam.far);
        this._fsMesh.material = this._copyMat;
        r.setRenderTarget(t.copy);
        r.render(this._fsScene, this._fsCam);
      });
      this.budget.begin('late');
      this.safety.guardPass('late', () => {
        /* three は render() の頭で scene.background を塗る。late で塗ると不透明の絵が消えるので外す */
        const bg = this.scene.background;
        this.scene.background = null;
        try {
          cam.layers.mask = NG_MASK.LATE;
          this.frame.beginPass(NG_PASS.MAIN, cam);
          r.setRenderTarget(t.main);
          r.render(this.scene, cam);
        } finally {
          this.scene.background = bg;
        }
      });
      this.budget.begin('post');
      let posted = false;
      if (this.post) this.safety.guardPass('post', () => { posted = this.post(t, dt) !== false; });
      if (!posted) this._blitFallback(t);
      this.budget.end();
    } finally {
      cam.layers.mask = mask;
      r.autoClear = auto;
      r.setRenderTarget(null);
      this.budget.poll();
    }
  }

  /* post が無い・落ちたとき：main を簡易トーンマップで画面へ */
  _blitFallback(t) {
    const r = this.renderer;
    this.safety.guardPass('blit', () => {
      this._blitMat.uniforms.tColor.value = t.main.texture;
      this._blitMat.uniforms.uExposure.value = this.frame.get(16, 0) || 1;
      this._fsMesh.material = this._blitMat;
      r.setRenderTarget(null);
      r.render(this._fsScene, this._fsCam);
    });
  }

  dispose() {
    const el = this.renderer.domElement;
    el?.removeEventListener?.('webglcontextlost', this._onLost);
    el?.removeEventListener?.('webglcontextrestored', this._onRestored);
    this._copyMat.dispose(); this._blitMat.dispose();
    this._fsMesh.geometry.dispose();
    this.targets.dispose();
  }
}
