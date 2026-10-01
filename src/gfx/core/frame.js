/* ===========================================================
   ngFrame：全シェーダが共有する 1 フレーム分の状態（ARCHITECTURE §4.1）
   -----------------------------------------------------------
   - 1 本の Float32Array（24 vec4）を全 ShaderLib と ng マテリアルに
     参照のまま配る。three の cloneUniforms は Float32Array を複製しないので、
     魚の onBeforeCompile 後も含めて全プログラムが同じ配列を見る
   - GLSL の #define は下の表 NG_SLOTS から生成する（JS と GLSL をずらさない）
   - three は vec4 配列の先頭要素が数値なら配列をそのまま gl.uniform4fv に渡す。
     NaN が入ると flatten の分岐が変わるので、書き込みは必ず有限値に丸める
   - three を import しない（Node のテストから直接読む）
   =========================================================== */

/** vec4 の本数 */
export const NG_FRAME_VEC4 = 24;

/** 全シェーダが参照する唯一の配列。差し替えないこと（参照が切れる） */
export const ngFrameData = new Float32Array(4 * NG_FRAME_VEC4);

/**
 * パス ID（slot 8.w）。three の描画 1 回ごとに NgFrame.beginPass で書き換える
 * @enum {number}
 */
export const NG_PASS = { MAIN: 0, REFLECTION: 1, SHADOW: 2, HF_SHADOW: 3, BAKE: 4, PROBE: 5 };

/**
 * slot の表。fields の各キーは GLSL の swizzle（x, y, z, w, xy, xyz）、値は #define 名。
 * owner は «そのスロットを書いてよい唯一の担当»（ngframe-layout テストで 1 対 1 を検査）。
 * 名前はすべて ng 接頭辞。マクロなので、同名のローカル変数を GLSL に書かないこと。
 * @type {ReadonlyArray<{slot:number, id:string, owner:string, fields:Record<string,string>, doc:string}>}
 */
export const NG_SLOTS = Object.freeze([
  { slot: 0, id: 'KEY', owner: 'sky', fields: { xyz: 'ngKeyDir', w: 'ngNight' }, doc: 'key の向き（昼=太陽、夜=月）, nightAmount' },
  { slot: 1, id: 'KEYRAD', owner: 'sky', fields: { xyz: 'ngKeyRad', w: 'ngSinSunAlt' }, doc: 'key の地表放射照度 rgb（雲で減光済み）, sin(太陽高度)' },
  { slot: 2, id: 'SUN', owner: 'sky', fields: { xyz: 'ngSunDir', w: 'ngMoonIllum' }, doc: '太陽の向き（常に太陽）, 月の照度係数' },
  { slot: 3, id: 'AMB', owner: 'sky', fields: { xyz: 'ngSkyIrr', w: 'ngCloudiness' }, doc: 'SH0 の空の照度/π rgb, 雲量' },
  { slot: 4, id: 'BETA_R', owner: 'sky', fields: { xyz: 'ngBetaR', w: 'ngHR' }, doc: 'βR rgb（1/m、霧の倍率込み）, H_R（m）' },
  { slot: 5, id: 'BETA_M', owner: 'sky', fields: { xyz: 'ngBetaM', w: 'ngHM' }, doc: 'βM rgb（1/m）, H_M（m）' },
  { slot: 6, id: 'MIST', owner: 'sky', fields: { x: 'ngMistDensity', y: 'ngMistBaseY', z: 'ngMistH', w: 'ngMieG' }, doc: '朝霧の密度（1/m）, 基準 y, スケール高, Mie g' },
  { slot: 7, id: 'INSC', owner: 'sky', fields: { xyz: 'ngInscatterAmb', w: 'ngMistAmb' }, doc: '環境内散乱の放射輝度 rgb（地平線の自動整合）, 朝霧の環境光の上乗せ' },
  { slot: 8, id: 'CAM', owner: 'core', fields: { x: 'ngUwStrength', y: 'ngCamWaterY', z: 'ngCamHeight', w: 'ngPassId' }, doc: 'uwStrength, カメラ位置の水面 y, カメラの水面からの高さ, passId（NG_PASS）' },
  { slot: 9, id: 'W_SIGMA', owner: 'underwater', fields: { xyz: 'ngSigmaA', w: 'ngSigmaS' }, doc: '水の吸収 σa rgb（1/m）, 散乱 σs' },
  { slot: 10, id: 'W_INSC', owner: 'underwater', fields: { xyz: 'ngWaterInsc', w: 'ngTurbidity' }, doc: '水の内散乱の放射輝度 rgb, 濁り' },
  { slot: 11, id: 'WIND', owner: 'core', fields: { xy: 'ngWindDir', z: 'ngWindSpeed', w: 'ngGustAmp' }, doc: '見た目の風向 xy（単位）, 風速 m/s, 突風の振幅' },
  { slot: 12, id: 'WEATHER', owner: 'sky', fields: { x: 'ngWet', y: 'ngRain', z: 'ngPuddleAmt', w: 'ngSeason' }, doc: '濡れ, 雨の強さ, 水たまり, 季節（0..1、既定 0.42）' },
  { slot: 13, id: 'CLOUDSH', owner: 'sky', fields: { xy: 'ngCloudShOffset', z: 'ngCloudShInvScale', w: 'ngCloudShStrength' }, doc: '雲影のオフセット xy（m）, 1/スケール（1/m）, 強さ' },
  { slot: 14, id: 'TIME', owner: 'core', fields: { x: 'ngHour', y: 'ngWaterTime', z: 'ngEnvTime', w: 'ngFrameIndex' }, doc: '時刻（h）, water.time, envTime（ポーズで止まる）, frameIndex % 1024' },
  { slot: 15, id: 'FOCUS', owner: 'core', fields: { xyz: 'ngFocus', w: 'ngLodScale' }, doc: '注視点 xyz, LOD 倍率' },
  { slot: 16, id: 'EXPO', owner: 'post', fields: { x: 'ngExposure', y: 'ngInvExposure', z: 'ngEV100' }, doc: '露出, 1/露出, EV（正午基準の −log2 露出）' },
  { slot: 17, id: 'CLOUDS', owner: 'sky', fields: { x: 'ngCloudCover', y: 'ngCloudBase', z: 'ngCloudTop', w: 'ngCloudPhase' }, doc: '雲の被覆（全体）, 雲底 m, 雲頂 m, 雲の流れの位相' },
  { slot: 18, id: 'CORE', owner: 'core', fields: { x: 'ngVolEnd', y: 'ngLakeRadius', z: 'ngNearShadowR' }, doc: '予約：フロクセルの区間境界（Phase 1 は常に 0 で誰も読まない。Phase 2 で core が ngApplyMedium の区間分割と書く口を足す）, 湖の平均汀線半径 m, 近景の影の半径 m' },
  { slot: 19, id: 'WAVEPH_A', owner: 'core', fields: { xyzw: 'ngWavePhA' }, doc: '波 0–3 の位相 mod(water.time·ω_i, 2π)（倍精度で求めた値。glsl/wave.glsl.js）' },
  { slot: 20, id: 'WAVEPH_B', owner: 'core', fields: { x: 'ngWavePhB' }, doc: '波 4 の位相（yzw は予備）' },
  { slot: 21, id: 'RES21', owner: 'reserved', fields: {}, doc: '予備' },
  { slot: 22, id: 'RES22', owner: 'reserved', fields: {}, doc: '予備' },
  { slot: 23, id: 'RES23', owner: 'reserved', fields: {}, doc: '予備' },
]);

/** slot 番号の表（NG.KEY === 0 …） */
export const NG = Object.freeze(Object.fromEntries(NG_SLOTS.map((s) => [s.id, s.slot])));

/** GLSL のインクルードガード付きで、uniform 宣言と slot の #define を生成する */
export function frameGLSL() {
  const lines = [
    '#ifndef NG_LIB_FRAME',
    '#define NG_LIB_FRAME',
    `uniform vec4 ngFrame[ ${NG_FRAME_VEC4} ];`,
  ];
  for (const s of NG_SLOTS) {
    for (const [sw, name] of Object.entries(s.fields)) lines.push(`#define ${name} ngFrame[ ${s.slot} ].${sw}`);
  }
  lines.push(`#define NG_PASS_MAIN ${NG_PASS.MAIN}.0`, `#define NG_PASS_REFLECTION ${NG_PASS.REFLECTION}.0`,
    `#define NG_PASS_SHADOW ${NG_PASS.SHADOW}.0`, `#define NG_PASS_HF_SHADOW ${NG_PASS.HF_SHADOW}.0`,
    `#define NG_PASS_BAKE ${NG_PASS.BAKE}.0`, `#define NG_PASS_PROBE ${NG_PASS.PROBE}.0`);
  lines.push('#endif', '');
  return lines.join('\n');
}

/** frameGLSL() の結果（起動時に 1 回だけ作る） */
export const NG_FRAME_GLSL = frameGLSL();

const fin = (v) => (Number.isFinite(v) ? v : 0);

/**
 * ngFrameData への書き込み口。値は有限に丸める（NaN を配列に入れない）
 */
export class NgFrame {
  constructor() {
    /** 共有配列そのもの */
    this.data = ngFrameData;
    /** 水中の状態（slot 8 の材料。pipeline と gfx.setUnderwater が書く） */
    this.cam = { uw: 0, waterY: 0 };
  }

  /** slot に 4 成分を書く */
  set(slot, x = 0, y = 0, z = 0, w = 0) {
    const o = slot * 4, d = this.data;
    d[o] = fin(x); d[o + 1] = fin(y); d[o + 2] = fin(z); d[o + 3] = fin(w);
  }

  /** slot の xyz に {x,y,z}（Vector3 / Color は r,g,b も可）を書き、w も書く */
  setVec3(slot, v, w = this.data[slot * 4 + 3]) {
    this.set(slot, v.x ?? v.r, v.y ?? v.g, v.z ?? v.b, w);
  }

  /** slot の 1 成分（0..3）だけを書く */
  setComp(slot, c, v) { this.data[slot * 4 + c] = fin(v); }

  /** slot の 1 成分を読む */
  get(slot, c) { return this.data[slot * 4 + c]; }

  /**
   * three の render() の直前に呼ぶ。slot 8 をパスとカメラに合わせて書き換える。
   * three は render() ごとに _currentMaterialId を戻すので、同じマテリアルでも再送される
   * @param {number} passId NG_PASS
   * @param {{position:{y:number}}|null} camera
   */
  beginPass(passId, camera) {
    const cy = camera ? camera.position.y : 0;
    this.set(NG.CAM, this.cam.uw, this.cam.waterY, cy - this.cam.waterY, passId);
  }
}
