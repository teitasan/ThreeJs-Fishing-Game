/* ===========================================================
   マテリアルへのシェーダ注入を重ねて当てるための小物

   three のマテリアルは onBeforeCompile が 1 つしか持てないので、
   風揺れ・caustics・法線の扱いのように «複数の注入» を素直に呼ぶと
   最後に当てたものだけが効く。置換の目印（#include <...>）は置換後も
   残るので、コンパイル時に順番に呼べば全部効く。
   =========================================================== */

/**
 * 複数のパッチを 1 つのマテリアルへ重ねて当てる。
 * @param {THREE.Material} mat
 * @param {Array<((m: THREE.Material) => void)|null>} patches
 */
export function applyPatches(mat, patches) {
  const fns = [];
  const keys = [];
  for (const fn of patches) {
    if (!fn) continue;
    /* 何もしないパッチ（条件が揃わず素通しするもの）を渡されたとき、
       «いまの onBeforeCompile» を無条件に積むと直前のパッチを 2 回積む。
       同じ注入が 2 回走って GLSL が redefinition で落ちるので、
       変化したときだけ積む */
    const before = mat.onBeforeCompile;
    fn(mat);
    if (mat.onBeforeCompile && mat.onBeforeCompile !== before) fns.push(mat.onBeforeCompile);
    const key = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
    if (key && !keys.includes(key)) keys.push(key);
  }
  mat.onBeforeCompile = (shader, renderer) => {
    for (const f of fns) f(shader, renderer);
  };
  const key = keys.join('|');
  mat.customProgramCacheKey = () => key;
  return mat;
}

/**
 * 頂点に持たせた法線を、面の表裏で反転させない。
 *
 * DoubleSide のとき three は
 *   float faceDirection = gl_FrontFacing ? 1.0 : -1.0;  normal *= faceDirection;
 * を入れる。«面の向き» ではなく «どちら側から見ているか» で決まるので、
 * 葉カードのように «株の外向き» を自分で入れた法線だと、裏から見えている
 * カードの法線が反転して手前を向く。結果、樹冠の奥側の葉が手前側と同じだけ
 * 太陽を向いてしまい、樹冠の暗い側が消えて葉群ぜんたいが白っぽく飛ぶ。
 *
 * 葉は «自分で決めた向き» で陰影を付けたいので、反転を取り消して
 * 補間した法線をそのまま使う（滑らかシェーディング前提。flatShading では
 * vNormal が無いので使えない）。
 * @param {THREE.Material} mat
 */
export function keepAuthoredNormals(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      // 表裏による法線反転を取り消す（materialPatch.keepAuthoredNormals）
      normal = normalize( vNormal );`
    );
  };
  mat.customProgramCacheKey = () => 'keep-authored-normals';
  return mat;
}

/**
 * 葉の «光が透ける» ぶんを足す。
 *
 * 法線の反転を止めると樹冠に暗い側が戻るが、フィルが半球光だけなので
 * 日陰側がほぼ黒に落ちる。実際の葉は薄いので裏から光が抜け、
 * 日陰の葉は «暗い» のではなく «濃い緑» になる。
 * 透過は本来 -N·L に比例するが、three の直接光ループへ割り込むのは
 * バージョン差が大きいので、アルベドに比例した一定量を足す近似にする。
 * @param {THREE.Material} mat
 * @param {number} amount アルベドに対する割合
 */
export function foliageTranslucency(mat, amount = 0.14) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      // 葉を透ける光（materialPatch.foliageTranslucency）
      totalEmissiveRadiance += diffuseColor.rgb * ${amount.toFixed(3)};`
    );
  };
  mat.customProgramCacheKey = () => `foliage-translucency-${amount}`;
  return mat;
}

/**
 * LOD の切り替わりをディザでクロスフェードする。
 *
 * 段が変わる瞬間にジオメトリが差し替わるので、木のように
 * «粗い段を細かい段の部分集合にできない» ものは形が飛んで見える。
 * 境界の前後に帯を設けて両方の段を描き、画面空間のディザで
 * それぞれを間引けば、実際には «だんだん入れ替わる» ように見える。
 *
 * 各段のジオメトリは «自分が受け持つ距離の範囲» を aLodBand（vec2）で
 * 持つ。マテリアルは段をまたいで共有するので、範囲は頂点属性で渡す。
 *
 * 影の深度パスにはこの注入が入らないので、影だけは帯の中でも
 * 切り替わる。近景しか影を落とさないので実害は小さい。
 * @param {THREE.Material} mat
 * @param {number} band 帯の幅（m）
 */
export function lodDitherFade(mat, band = 10) {
  const uniforms = { uLodFadeBand: { value: band } };
  mat.userData.lodFadeUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aLodBand;
        uniform float uLodFadeBand;
        varying float vLodFade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 lodPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #else
            vec3 lodPos = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          float lodD = distance(lodPos, cameraPosition);
          float b = max(uLodFadeBand, 0.001);
          /* 手前の境界では入り、奥の境界では抜ける。
             aLodBand.x <= 0 は «最も近い段» ＝ 手前側の境界が無い */
          float inA = aLodBand.x <= 0.0 ? 1.0 : smoothstep(aLodBand.x - b, aLodBand.x, lodD);
          float outA = aLodBand.y <= 0.0 ? 0.0 : smoothstep(aLodBand.y, aLodBand.y + b, lodD);
          vLodFade = clamp(inA * (1.0 - outA), 0.0, 1.0);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vLodFade;
        /* interleaved gradient noise。表を持たずに済むディザ */
        float lodIgn(vec2 p) {
          return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
        }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vLodFade < 0.999 && vLodFade <= lodIgn(gl_FragCoord.xy)) discard;`);
  };
  mat.customProgramCacheKey = () => `lod-dither-fade-${band}`;
  return mat;
}

/**
 * 杭の水際の藻と «濡れ»。
 *桟橋はこれまで «濡れ» をまったく持っていなかったので、
 * 水に浸かっている部分も乾いた木のままだった。
 *
 * 帯の位置は UV ではなくワールド Y で決める。杭は InstancedMesh で
 * 高さが違い、UV は withInstanceUvY で伸縮させているので、UV で切ると
 * 杭ごとに水位がずれる。
 * @param {THREE.Material} mat
 * @param {THREE.Texture|null} algaeTex
 */
export function dockWaterline(mat, algaeTex) {
  if (!algaeTex) return mat;
  const uniforms = { uAlgae: { value: algaeTex } };
  mat.userData.algaeUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n        varying vec3 vDockWorldPos;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vDockWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vDockWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vDockWorldPos;
        uniform sampler2D uAlgae;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        #ifdef USE_MAP
        {
          float y = vDockWorldPos.y;
          /* 水位はどの杭でも同じ高さで止まらない。低い周波数で境界をずらす。
             ハッシュで振ると杭 1 本の中でも暴れて «白いノイズ» になるので、
             滑らかな関数を使うこと */
          float wob = sin(vDockWorldPos.x * 2.1) * 0.035
                    + sin(vDockWorldPos.z * 1.7 + 1.3) * 0.030;
          float top = 0.11 + wob;
          float wet = 1.0 - smoothstep(top - 0.07, top + 0.02, y);
          /* 藻は木目の UV に乗せる。杭は縦長なので、投影を作り直すより
             すでに «縦へ伸ばしてある» この UV を使うほうが素直 */
          vec3 algae = texture2D(uAlgae, vMapUv * 2.2).rgb;
          // 深いほど密。水面すぐ下は «まばらに付いた» 状態にする
          float dens = wet * mix(0.50, 1.0, 1.0 - smoothstep(-0.9, 0.04, y));
          diffuseColor.rgb = mix(diffuseColor.rgb, algae, clamp(dens, 0.0, 1.0) * 0.86);
          // 濡れた木は暗く、少し滑らかになる
          diffuseColor.rgb *= mix(1.0, 0.74, wet);
          roughnessFactor = mix(roughnessFactor, 0.44, wet * 0.80);
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => 'dock-waterline-v1';
  return mat;
}
