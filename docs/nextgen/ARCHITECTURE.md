# 次世代グラフィック：統合設計（v1）

この文書が実装の正本。ゲームロジックとの境界は [CONTRACT.md](CONTRACT.md)、技法の詳細は
[proposals/](proposals/) の 3 案（`robust.md` = 骨格、`fidelity.md` = 水・大気の技法、`art.md` = 色と生態）と
[judges.md](proposals/judges.md) を参照する。本書と proposals が食い違うときは **本書が優先**。

---

## 0. 決定事項（なぜこうするか）

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| 骨格 | robust 案（1 回描画・ShaderLib 経由の共有フレーム・固定ライト構成・ファイル所有の厳格化） | 審査 2 名とも採用。game.js の呼び出し順にそのまま乗る |
| 描画方式 | WebGL2 / three r180 のまま。**不透明を 1 回描く → コピー → 水と半透明を重ねる** | 旧版の「シーン二重描画」を廃止。屈折にキャラクターも魚も自然に写る |
| AA | high = **MSAA 4× + alpha-to-coverage**、mid = SMAA、low = FXAA。**TAA はやらない** | 糸・竿・ウキ・水越しの魚にゴーストを出さない（ゲーム性の読みやすさ） |
| 大気と霧 | 全マテリアル共通の解析媒質 `ngApplyMedium`。組込みマテリアル（釣り人・魚）には fog チャンクの差し替えで同じ関数を通す | 「一つの光・一つの空気・一つの水」 |
| ライト | DirectionalLight 1（昼=太陽／夜=月、影あり）+ LightProbe 1（SH9）+ PointLight 1（灯籠）。**起動時に固定**。HemisphereLight は廃止 | 再コンパイルを起こさない。キャラクターも同じ光を受ける |
| 影 | 近景 = three の影マップ（毎フレーム・プレイヤー中心）。中遠景 = **高さ場＋樹冠の太陽影テクスチャ**（2 段、償却更新）。雲の影 = 解析関数 | 山の影が夕方に湖を渡る。遠景の幾何を影パスで描かない |
| 水の波 | `waveField.js` を **1 バイトも変えず** 物理の唯一の定義にする。GPU は `waveGLSL` で同じ式の **縦変位のみ**。細かい波はすべて法線 | ウキ・魚が見た目の水面に正確に乗る |
| 水のディテール | 周期 FFT 法線（全品質）+ high は波動方程式の波紋シミュ（杭で反射）+ 解析リング（全品質）+ 雨の輪。粗さは LEAN/Toksvig | fidelity 案の技法を「予算を測ってから足す」段階で |
| 反射 | **全品質で平面反射**（low は 0.25× を隔フレーム）。反射は湖の生命線 | art 案の指摘 |
| トーンマップ | 露出（時刻・天候の純関数 + ±1EV の順応）→ AgX → グレード → ディザ。**最後に 1 回だけ** | 3 案とも AgX |
| 素材 | **外部アセットゼロ**。テクスチャはすべて起動時に GPU で合成（forge）。木の幾何だけオフラインの Node スクリプトで焼いてコミット（≤ 3MB） | ユーザーの要望「持てる力で最高に」。ダウンロード無し |
| 配置 | `src/world/`（three・DOM 無し）で **シードだけから決定的・品質非依存**。見た目は rank の入れ子で間引く。当たりは全品質で同一 | 旧版は品質で当たりが変わり、マルチでずれていた |
| 生態 | art 案の生態区分（汀のヤナギ・ハンノキ、下部斜面の落葉広葉樹、中腹のスギ・ヒノキ植林区画、尾根のアカマツと露岩） | 遠景の色の塊だけで「日本の山の湖」と読める |
| 太陽の軌道 | **旧式のまま**：`a = ((h-6)/24)·2π`、`sunDir = normalize(cos a, sin a, 0.34)`、`nightAmount = smoothstep(0.08, -0.16, sunDir.y)`、月 = −sunDir | 灯籠・音・夜の判定の時刻を変えない |
| 品質キー | `'low'|'mid'|'high'` のまま | セーブ互換 |

---

## 1. ファイル配置と所有

```
src/world/            three・DOM 無し。Node でテストできる（Core-B）
  heightgrid.js       高さ場の標本化（Worker とメインスレッド共通）
  heightWorker.js     module Worker。makeLake(resolvedSeed) を作り直して帯ごとに焼く
  species.js          樹種表（寸法・幹の太さ比）。木の焼き込みと当たりが共有する
  ecology.js          生態区分の場（標高・傾斜・汀線距離・斜面の向き・湿り気・植林区画）
  placement.js        buildPlacement(lake) → Placement（木・岩・藪・葦・睡蓮・藻・ストラクチャー・灯籠・小舟・流木）
  dock.js             桟橋の座標系（旧 _findDock / _dockLocal / onDock / distToDock / dockBlocksSegment の移植）
  collision.js        障害物の 8m ハッシュ（旧 addObstacle / blockedAt / obstacleTopAt / lineBlocked の移植）
  queries.js          heightAt 系・bedAt・structureNear などの旧ロジックの移植
src/gfx/core/         描画の芯（Core-A）
  index.js            installNg() / createGfx() / getGfx()
  chunks.js           ShaderChunk と ShaderLib の差し替え（fog / lights）
  frame.js            ngFrame（共有 Float32Array）と GLSL の #define 生成
  glsl/*.glsl.js      ng 接頭辞の GLSL ライブラリ（medium, noise, surface, wind, shadow, heightfield, hextile, oct, bluenoise）
  medium.js           ngApplyMedium の JS 双子（テストと scene.fog.near/far 用）
  extend.js           ngExtendStandard(mat, spec) / ngShaderMaterial(opts)
  layers.js           NG_LAYER
  pipeline.js         FramePipeline（prepare / renderReflection / renderMain）
  targets.js          RT の確保と再確保
  shadows.js          近景の影の追従・高さ場影（2 段）・ngSunVisibility
  wind.js             見た目の風（時刻と天候の純関数）と CPU 双子
  heightfield.js      高さ場テクスチャ（GPU）と派生（法線・汀線距離・底質・樹冠・被覆）
  forge.js            起動時のテクスチャ合成（2D / 配列 / 3D / オフスクリーン描画）
  quality.js          品質表と onQuality
  module.js           NgModule の基底と登録
  safe.js             guard / 隔離 / onShaderError
  budget.js           GPU/CPU 計測（performance.js のパス名 'capture'/'reflection'/'composer' を保つ）
  lab/labkit.js       lab ページの起動キット
src/gfx/<module>/     各モジュール（Phase 1 の担当者だけが触る）。index.js が固定の入口
  sky water underwater terrain trees groundcover shoreflora hardscape weatherfx post
src/sky.js            Environment ファサード（Core-B）
src/terrain.js        Terrain ファサード（Core-B）
src/water.js          Water ファサード（Core-B）
src/postfx.js         PostFX ファサード（Core-A）
src/shaders.js        CAUSTICS_GLSL / createCausticsUniforms（Core-A が受け口、中身は underwater モジュール）
lab/<module>.html     各モジュールの lab ページ（lab/_kit は Core-A）
scripts/gfx/          撮影ハーネス・シナリオ・art-metrics（Core-A）
scripts/bake/trees/   木のオフライン焼き込み（trees モジュール）
assets/gfx/           オフライン生成物（trees.bin / trees.json / 必要ならブルーノイズ）
```

**所有の規則**：Phase 1 では各モジュール担当は `src/gfx/<自分>/`・`lab/<自分>.html`・`scripts/gfx/scenarios/<自分>-*.mjs`・自分のテストだけを触る。
core・ファサード・他モジュールを変えたいときは `docs/nextgen/core-requests.md` に書く（統合時に取り込む）。

`src/world/` と `waveField.js` は Worker（Cloudflare）の import 鎖に **入れない**。lakefield / util / data は変更しない。

---

## 2. 色・単位・露出（色彩バイブル）

- シーンは **リニア Rec.709 の HDR**（RGBA16F）。`renderer.toneMapping = NoToneMapping`、`outputColorSpace = SRGB`。
  トーンマップと sRGB 変換は post の最終パスで 1 回だけ。自前シェーダはリニアで出す（`uLinearOut = 1` を post が保持）
- **ng 単位**（キャラクターの旧調整と整合）：快晴の南中の太陽照度 `E_key = 3.0`（DirectionalLight.intensity）、空の半球照度 ≈ 0.9、
  月の照度 0.012、夜空 0.004、灯籠 PointLight は 2200K
- **線形アルベドの範囲**（`src/gfx/core/palette.js` に定数で置き、lab の false color で検査する）：

| 素材 | 線形アルベド |
| --- | --- |
| 草地 | 0.10–0.16（初夏の黄緑、根元は暗く） |
| スギ・ヒノキの葉 | (0.028, 0.050, 0.030)–(0.032, 0.058, 0.032) |
| ブナ・ミズナラの葉 | (0.07, 0.11, 0.035) 前後 |
| 苔 | 0.06–0.10（緑寄り） |
| 林床（落葉・針葉） | 0.08–0.14 |
| 乾いた砂・砂利 | 0.25–0.35 |
| 濡れた砂 | ×0.55 |
| 湖底の泥 | 0.10–0.14（深さの色は媒質が付ける。アルベドは下げない） |
| 花崗岩・安山岩 | 0.18–0.25 |
| 風化した桟橋の杉材 | 0.28（灰銀〜茶のむら）、濡れ ×0.5 |
| 水の F0 | 0.02 |

- **露出**：`ngExposure = scheduled(sunAltDeg, cloud, rain, uw) × adapt`
  - scheduled（純関数）：太陽高度 ≥25° → 1.0、10° → 1.15、3° → 1.5、0° → 2.1、−4° → 3.6、−8° → 7、−12° → 14、≤ −15° → 22。
    × (1 + 0.5·cloud) × (1 + 0.3·rain)。水中は × min(3, 1.3 + 0.08·depth)
  - adapt：画面の log 平均輝度から ±1EV（夜は +1.2EV まで）にクランプして順応（明るく 1.2s / 暗く 0.6s）。**ポーズ中は止まる**。
    `window.__gfxCapture = true` のときは adapt = 1 に固定（撮影の再現性）
- **夜は「暗いと分かる暗さ」**：月夜の zenith は #0b1426 付近、地形が読めること。真夜中の画面平均輝度は真昼の 25〜40%
- 地平線の自動整合：8 方位で空の地平輝度を CPU 双子で評価し、3km 先の媒質の内散乱がそれに一致するよう `ngInscatterAmb` を解く

---

## 3. フレームのパイプライン

### 3.1 game.js の順序（変えない）と中身

```
env.update(dt,hour,cam,focus)  → gfx.beginFrame(...)：時刻・天候から ngFrame の空・光・大気を書く（sky モジュールの producer）
terrain.updateWind             → 見た目の風（純関数なので実質 no-op、windPow は記録だけ）
terrain.updateTrees(dt,camPos) → gfx.updateModules(f)：全モジュールの CPU update（LOD 選択・インスタンスの詰め直し）
terrain.updateLamp(night,dt)   → hardscape の灯籠（dt で damp、ポーズで止まる）
water.update(sdt,cam,env)      → time/wind/causticsUniforms/波紋・しぶきの予約/ngFrame の水
terrain.updateUnderwaterProps  → 水草・プランクトンの流れ
terrain.updateShore(t,wind)    → ngFrame の水の時刻（実質 no-op）
…fish / angler / HUD…
water.capture()                → pipeline.prepare()        [perf 'capture']
water.captureReflection()      → pipeline.renderReflection() [perf 'reflection']
postfx.updateUnderwater(ctx)   → 水中の状態
postfx.render(sdt)             → pipeline.renderMain() + post チェーン [perf 'composer']
```

`prepare` / `renderReflection` は同じフレームで 2 回呼ばれても安全（冪等）。game が呼ばなかったら `renderMain` が呼ぶ。

### 3.2 パス（high、2560×1440 物理ピクセル、s = 動的解像度 0.7–1.0）

| # | パス | 出力 | 内容 |
| --- | --- | --- | --- |
| P1 | preparers | 各モジュールの RT | 空 LUT（skyView 毎フレーム、transmittance/multiscatter は霞が 2% 変わったとき）・雲パノラマの 1/16 更新・波紋シミュ／リング・caustics・高さ場影の償却スライス・SH の CPU 射影（4Hz） |
| P2 | 影 | three の影マップ | `renderer.shadowMap.autoUpdate = false`。**prepare の中で needsUpdate = true を 1 回だけ**立て、そのフレーム最初のシーン描画で更新（以降のパスは使い回す） |
| P3 | 反射 | reflRT（RGBA16F、0.6×、5 mip、depth RB） | 鏡映カメラ（y=0、斜め近クリップ y=−0.03）。layers = DEFAULT\|WORLD\|FAR。late と setReflectionHidden を隠す。passId=1。植生は LOD +1 段、草なし。カメラ水中または湖面が画面外ならスキップ |
| P4 | 不透明 | mainRT（RGBA16F、MSAA 4×、DepthTexture） | layers = DEFAULT\|WORLD\|NO_REFLECT\|UNDERWATER\|FAR。**late 物体（transparent / depthTest=false / renderOrder ≥ 5 の非 ng 物体）は visible を退避して隠し、描画後に必ず戻す**。空は最後に全画面三角形で depth=1・LEQUAL |
| P5 | コピー | sceneColor（RGBA16F、4 mip）+ sceneDepthLin（R32F） | 全画面 1 パス。MSAA の resolve 後 |
| P6 | late | mainRT（同じ MSAA） | layers = WATER\|LATE_FX\|LATE（late 物体は visible を戻して描く）。水面（renderOrder 1、NoBlending、depthWrite）→ パーティクル・雨・霧の板・しぶき・蛍・プランクトン → ゲームの半透明（波紋 3、糸 5、マーカー 6、名札 7、debug 900） |
| P7 | post | 画面 | NaN 除去 → 露出 → 水中エフェクト（水中時のみ）→ GTAO 合成（high、不透明の画素だけ）→ 光芒（太陽が画面近く・高度 < 25°）→ Bloom（エネルギー保存）→ グレード → AgX → ディザ → SMAA/FXAA（mid/low）→ 動的解像度のアップスケール |

- **ライトは必ず `layers.enableAll()`**（three はライトもカメラの layers で間引く。late のマスクで太陽が消える事故を防ぐ）
- **MSAA に resolve 後もう一度描く**のは Chrome では中身が保たれる（invalidate は OculusBrowser だけ）。ただし ANGLE/Metal の load/store の帯域を
  Phase 0 のスパイクで実測し、閾値超えなら high を 2×+SMAA に落とす判定を core に入れる
- 水中（`uwStrength > 0.5`）は P3 を止め、その予算を水中エフェクトへ回す
- 例外：各パスは `guardPass(id, fn)` で包む。失敗したパスは 1 回ログを出して、60 フレームで 2 回失敗したらそのセッションは無効化。
  **パイプラインは例外を game へ再送出しない**。最悪でも sceneColor を画面へ出す
- WebGL コンテキストの喪失：preventDefault して描画を止める（例外にしない）。復帰でモジュールの `restoreGPU()`

### 3.3 レイヤー

```
NG_LAYER = { DEFAULT:0, WORLD:1, NO_REFLECT:2, UNDERWATER:3, WATER:4, LATE_FX:5, LATE:6, FAR:7, SHADOW_ONLY:8 }
opaque = 0,1,2,3,7   reflection = 0,1,7   late = 4,5,6   shadow = 0,1,7,8
```

- ng の物体は layer 0 を外して自分の層に置く（`userData.ngOwned = true`）。ゲームの物体は layer 0 のまま（raycast に影響させない）
- 水中物（湖底の小物・藻・沈み岩・立ち枯れ）は UNDERWATER（反射に写らない、屈折には写る）
- `terrain.underwaterProps.group` は **空のダミー**（game.js が水上で visible=false にするため。実物をここに入れない）

### 3.4 媒質の規則（各区間を 1 回だけ減衰させる）

| カメラ | 点 | どこで媒質をかけるか |
| --- | --- | --- |
| 水上 | 水上 | 空気。fog チャンク（`ngApplyMedium`） |
| 水上 | 水中 | 空気（カメラ→水面の入射点）+ 水（入射点→点）+ 下向き光の減衰 `exp(−σd·depth/cosθ_sun,w)`。**すべて fog チャンク**。水面シェーダは F·反射 + (1−F)·屈折を混ぜ、自分の鏡面と泡にだけ空気の透過をかける（吸収は足さない） |
| 反射パス（passId 1） | 何でも | 全区間を空気として扱う（鏡映カメラの距離 = 実際の光路長） |
| 水中 | 水中 | 水。fog チャンク |
| 水中 | 水上 | fog チャンクは空気区間だけ。水の区間は水面の裏面シェーダがかける |

---

## 4. Core API

### 4.1 共有フレーム `ngFrame`（frame.js）

`export const ngFrameData = new Float32Array(4 * 24)`。**全 ShaderLib（fogColor を持つもの：basic, lambert, phong, standard, physical, toon,
matcap, points, dashed, sprite）の uniforms に `ngFrame = { value: ngFrameData }` を足す**。r180 の `cloneUniforms` は Float32Array を参照のまま渡す
（検証済み）ので、組込みマテリアル（魚の onBeforeCompile 後も含む）はすべて同じ配列を共有する。ng マテリアルも同じ参照を持つ。
GLSL の `#define` は下の表から生成する（JS と GLSL がずれない）。**先頭要素が NaN にならないこと**（three の flatten が配列をそのまま使う条件）。

| slot | xyz | w | 書く人 |
| --- | --- | --- | --- |
| 0 | keyDir | nightAmount | sky |
| 1 | key の地表放射照度 rgb（雲で減光済み） | sin(sunAlt) | sky |
| 2 | sunDir（常に太陽） | 月の照度係数 | sky |
| 3 | SH0 の空の照度/π rgb | cloudiness | sky |
| 4 | βR rgb × 霧の倍率 | H_R | sky |
| 5 | βM rgb | H_M | sky |
| 6 | 朝霧の密度, 基準 y, スケール高 | Mie g | sky |
| 7 | 環境内散乱の放射輝度 rgb（地平線の自動整合） | 朝霧の環境光の上乗せ | sky |
| 8 | uwStrength, カメラ位置の waterY, カメラの水面からの高さ | passId（0 main / 1 refl / 2 shadow / 3 hfshadow / 4 bake / 5 probe） | core |
| 9 | σa rgb | σs | underwater |
| 10 | 水の内散乱の放射輝度 rgb | 濁り | underwater |
| 11 | 風向 xy, 風速 m/s | 突風の振幅 | core wind |
| 12 | 濡れ, rain, 水たまり | season（0..1、既定 0.42 = 初夏） | sky |
| 13 | 雲影のオフセット xy, 1/スケール | 強さ | sky |
| 14 | hour, water.time, envTime（ポーズで止まる） | frameIndex % 1024 | core |
| 15 | focus xyz | lodScale | core |
| 16 | exposure, 1/exposure, EV100 | 予備 | post |
| 17 | 雲の被覆（全体）, 雲底, 雲頂 | 雲の流れの位相 | sky |
| 18–23 | 予備（core の承認で割り当て） | | |

`NgFrame.beginPass(passId, camera)` が slot 8 をパスごとに書き換える（three は render() ごとに `_currentMaterialId` を戻すので再送される）。

### 4.2 チャンクの差し替え（chunks.js、`installNg(THREE)` は冪等）

- `fog_pars_vertex += 'varying vec3 vNgWorld;'`、`fog_vertex += 'vNgWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;'`
  （instancing・points・sprite・鏡映カメラでも成り立つ）
- `fog_pars_fragment` / `fog_fragment`：**`#ifdef NG_FRAME` のときだけ** `gl_FragColor.rgb = ngApplyMedium(gl_FragColor.rgb, vNgWorld)`。
  それ以外は元の線形霧（ngFrame を持たない他人の ShaderMaterial を壊さない）。`NG_FRAME` は ShaderLib のシェーダ文字列の先頭と `ngShaderMaterial` にだけ入れる
- `lights_fragment_begin`：`getDirectionalLightInfo` の直後に `#if defined(NG_FRAME) && UNROLLED_LOOP_INDEX == 0` で
  `directLight.color *= ngCloudShadow(vNgWorld) * ngHfShadowAnalytic(vNgWorld)`（どちらもサンプラーを使わない解析版）。キャラクターも雲の影で暗くなる
- 水中の点の下向き光の減衰は fog チャンクの `ngApplyMedium` の中で行う（§3.4）
- **起動時の自己検査**：MeshStandardMaterial を 1 枚コンパイルし、`renderer.properties.get(m).uniforms.ngFrame.value === ngFrameData` と
  アンカーの存在を確かめる。失敗したらチャンクを元に戻し `core.degraded = 'fog'`（ただの THREE.Fog に落ちる）
- 全体チャンクは `ng` 接頭辞の識別子だけを宣言する。`uCaust*` `causticLight` `cs*` `csWave*` `vFishWorldPos` `uTime` `uAmp` `uFreq` `uLen` `uBend` は宣言しない。
  すべての GLSL ライブラリに `#ifndef NG_LIB_X` のインクルードガード

### 4.3 媒質（glsl/medium.glsl.js と medium.js）

```glsl
vec3 ngApplyMedium(vec3 L, vec3 P);                    // §3.4 の規則を内部で分岐
void ngMediumTerms(vec3 P, out vec3 T, out vec3 Lin);
float ngAirOpticalDepth(vec3 a, vec3 b, float beta, float H);   // 高さ指数の閉形式。|Δy|<1e-3 は極限
float ngCloudShadow(vec3 P);                           // 解析（sky の被覆関数と同じ式）
```

- 空気：τ = β·H·(e^(−ya/H) − e^(−yb/H))·|b−a|/(yb−ya)。内散乱 Lin = Σ_{R,M,mist}(τ_i/τ)(1−e^(−τ))(E_key·P_i(μ) + A)。P_R = 3/(16π)(1+μ²)、P_M = HG(g)
- 朝霧：密度 ρmist・スケール高 5m、湖上マスクは汀線距離の解析近似（`lake.shoreRadius` を GLSL に持たないので、`ngFrame` の湖の中心半径の近似でよい）
- 水：T_w = e^(−(σa+σs)·L_w)、Lin_w = (1−T_w)·ngWaterInsc·e^(−σd·平均深さ)、σd = σa + 0.3σs。既定 σa = (0.20, 0.075, 0.045)/m、σs = 0.03（視程 26–70m）
- H と β には `max(·, ε)`（ゼロ除算の黒・NaN を防ぐ）
- JS 双子は同じ式を持ち、`scene.fog.near / far`（T = 0.98 / 0.02 になる距離）を毎フレーム書く（debug.js 用）。1000 区間の数値積分との差 < 1% をテスト
- 将来のフロクセル用に `ngVolEnd`（区間分割の境界、既定 0 = 全区間を解析）を予約しておく

### 4.4 マテリアル（extend.js）

```js
ngExtendStandard(mat /*MeshStandardMaterial|MeshPhysicalMaterial*/, spec) → mat
spec = {
  key,                      // customProgramCacheKey = 'ng:' + key + ':' + tier
  uniforms, defines,        // 共有の {value} 参照を onBeforeCompile でマージ
  vertex:   { pars, begin /*begin_vertex の後。transformed を編集*/, normal /*beginnormal_vertex の後*/, world /*worldpos_vertex の後*/ },
  fragment: { pars, surface /*map_fragment の後*/, alpha, normal /*normal_fragment_maps の後*/, rough /*roughnessmap_fragment の後*/,
              ao /*aomap_fragment の後*/, emissive /*emissivemap_fragment の後*/, lights /*lights_fragment_end の後：透過や空の鏡面を足す*/ },
  caustics: true,           // CAUSTICS_GLSL を魚と同じ位置に 1 回だけ入れ、causticLight(vWorld, normal) × ngSunVisibility を足す
  depth: true,              // customDepthMaterial / customDistanceMaterial を同じ頂点の変形とアルファで作る（影が揺れに追従）
  hfShadow: true,           // 高さ場影テクスチャを近景の影の外で使う（サンプラー 1）
}
ngShaderMaterial(opts) → ShaderMaterial   // lights:true, fog:true, GLSL3, NG_FRAME 付き。three の光・影・霧のチャンクを含む（水・空・パーティクル用）
```

- アンカーは vendored の ShaderChunk に対して Node テストで存在を検査する。実行時にアンカーが無ければ **構築時に** 例外（フレーム中は投げない）→ ファサードがスタブに切り替える
- サンプラーの上限：1 プログラムあたり fragment ≤ 12・vertex ≤ 4。lab で `gl.getActiveUniform` を数えて検査
- 品質の差は **uniform とループの上限** で出し、define を増やさない（コンパイル数と時間の対策）。プログラム総数 ≤ 60
- 配列マテリアルは使わない（applyQuality の needsUpdate が効かない）

### 4.5 影（shadows.js）

- 近景：`env.sun`（DirectionalLight、castShadow）の three 影。high 3072² ±48m / mid 2048² ±40m / low 1024² ±30m。`PCFShadowMap` と radius。
  bias −0.0004、normalBias 0.04。**テクセルにスナップ**して focusPos に追従。near 0.5、far 1500（低い太陽で山の影も入る）。
  `shadow.camera.layers` は shadow マスク。影の強さは雲量で 1 → 0.35
- 高さ場影：地形 + 樹冠の高さ場を太陽方向に raymarch して R8（半影付き）に焼く。2 段：±256m @1024²（0.5m）と ±1024m @1024²（2m）。
  **太陽は 1 実秒で 0.25° 動く**ので、更新は 4 象限 × 4 フレーム ≒ 0.27s ごと（高さ場の往復なので幾何を描かない）
- GLSL：`float ngHfShadow(vec3 P)`、`float ngSunVisibility(vec3 P, float nearVis)`（近景 → 高さ場影を 0.8R〜R でブレンドし、雲影を掛ける）
- 組込み（キャラクター）は近景の影 + 雲影（解析）+ 高さ場影の解析近似（なし or 太陽高度で弱い暗化）。キャラクターは常に近景の範囲内

### 4.6 風（wind.js）

- 基準の風向 φ(hour, weather) と風速（clear 1.4 / cloudy 3.0 / rain 5.0 m/s、damp）。**時刻と天候の純関数**（マルチで一致）
- `vec4 ngWindAt(vec2 xz)`：38m と 13m の 2 オクターブの値ノイズの突風を、風下へ 3m/s·速さ係数で流す。水面の猫足（cat's paw）・草の波・雨の傾き・霧の流れが全部これを使う
- ハッシュは浮動小数（Dave Hoskins 型）。uint ハッシュのドライバ差を避ける。JS 双子あり
- ゲーム用の `water.wind`（契約の式）とは別物

### 4.7 高さ場（heightfield.js / src/world/heightgrid.js）

- Worker 4 本（`min(4, hardwareConcurrency-1)`、無ければメインスレッドで 64 行ずつ await）が **resolveLake の結果の seed** で `makeLake` を作り直し、
  メインスレッドの湖と一致することを数点のハッシュで確かめてから焼く（一致しなければメインスレッドで焼く）
- near：1040² @0.5m ±260m（汀線 + 72m の最大 244m を覆う）、far：1024² @1m ±512m、どちらも R32F・Nearest。**補間はシェーダで手動バイリニア**
  （`OES_texture_float_linear` に依存しない）。JS の `sampleGrid(x,z)` が GPU と同じ補間を持つ（テスト用）
- 派生（GPU）：`ngNormalNear/Far`（oct RGBA8）、`ngShoreDist`（R16F 1024²、ジャンプフラッド、符号付き汀線距離）、
  `ngBedMap`（RGBA8 ±260m @2m：mud/sand/rock の重み + v。**lake.bedAt と一致**）、`ngCanopy`（RG8：樹冠密度・高さ、placement から）、
  `ngCoverMap`（RGBA8 ±260m：草・笹・シダ・花の密度、placement/ecology から）
- GLSL：`float ngTerrainH(vec2)`、`float ngDepth(vec2)`、`vec3 ngTerrainN(vec2)`、`float ngShoreD(vec2)`
- `terrain.heightTexture` は ngHeightNear を指す

### 4.8 forge（forge.js）

```js
forge.bake2D({ w, h, type, format, frag, uniforms, mips, coverageAlpha })   // coverageAlpha: mip ごとにα被覆を保つ（参照 0.5）
forge.bakeArray({ w, h, layers, frag })      // ngLayer を使う。WebGLArrayRenderTarget
forge.bake3D({ w, h, d, frag })
forge.renderView(rt, layer, scene, camera)   // インポスターの撮影
forge.releaseScratch()
```

共有ノイズ（glsl/noise.glsl.js）：`ngHash12/22/33, ngVNoise2/3, ngGNoise2, ngWorley2/3, ngFbm, ngRidged, ngWarp` と周期版、`ngHexTile`（Mikkelsen 2022）、
`ngOct` の符号化、`ngBlueNoise(frag, frameIndex)`（起動時に void-and-cluster で 64² を焼く）。**焼き込みは 1 回 ≤ 30ms に刻んで await**（読み込み画面を止めない）。

### 4.9 モジュールの契約（module.js）

```js
// src/gfx/<m>/index.js は必ずこれを export する（Core-A がスタブを置き、担当者が中身を差し替える）
export function createModule(ctx) → NgModule
class NgModule {
  static id                          // 'sky' | 'water' | ...
  async init(progress)               // 重い処理は分割して await（1 回 ≤ 30ms）
  update(f)                          // CPU。gfx.updateModules から毎フレーム
  prepare(f)                         // GPU の準備（P1）。任意
  beforePass(passId, camera)         // 任意
  setQuality(tier, profile)
  setLodScale(k)
  restoreGPU()
  stats() → { draws, tris, instances, texBytes, programs }
  dispose()
  root: THREE.Group                  // 自分の物体はここに入れる（?ng=-<id> で丸ごと無効化できる）
}
ctx = { THREE, renderer, scene, camera, tier, profile, lake, terrain /*ファサード*/, heightfield, placement, frame, wind, pipeline,
        shadows, forge, workers, caustics /*causticsUniforms*/, services /*モジュール間の受け口（下）*/, budget, log }
f   = { dt, sdt, envTime, waterTime, waterWind, hour, camera, camPos, focus, frameIndex, paused, uw, flowDir, flowStrength }
```

**モジュール間の受け口**（`ctx.services`。提供者が無いときは core のスタブが既定値を返す）：

| 受け口 | 提供 | 使う人 |
| --- | --- | --- |
| `sky.skyViewTex / transmittanceTex / cloudPanoTex / sampleSky(dir) / keyColor / cloudShadowAt(x,z)` | sky | water, underwater, terrain, trees, post |
| `water.addRipple / addSplash / addImpulse(x,z,amp) / addDamper(list)` | water | ファサード, weatherfx, shoreflora, hardscape |
| `water.detailTile`（周期 FFT の高さ／勾配の結果） | water | underwater（caustics） |
| `underwater.getUnderwaterContext / createEffect() / optics` | underwater | ファサード, post |
| `terrain.coverRules`（GLSL 文字列：`ngGroundKind(p)`）/ `farAlbedoTex` | terrain | groundcover |
| `trees.impostorBake` | trees | hardscape（立ち枯れ）|
| `hardscape.piles`（杭と茎の円の一覧）/ `setLamp(night, dt)` | hardscape | water（減衰体）, ファサード |
| `post.registerDebugView(name, glsl)` | post | 全員 |

### 4.10 品質（quality.js）

- 全体の表（§7）を 1 か所に持ち、`onQuality(fn)` で配る。各モジュールは `src/gfx/<m>/quality.js` に自分の表を持つ
- setQuality は部分集合の作り直しと RT の再確保だけ。**ライト数と castShadow は変えない**
- 動的解像度（post/drs.js）：2 秒の p90 が 17.2ms を超えたら −0.05、5 秒 14ms 未満なら +0.05。範囲は high 0.7–1.0 / mid 0.75–1.0 / low 0.6–1.0。
  `window.__gfxCapture` のときは無効

### 4.11 例外と計測（safe.js / budget.js）

- `guard(module, method, ...args)`：update が投げたら 3 回でそのモジュールを無効化（root を隠す）し、レート制限つきで警告
- `renderer.debug.onShaderError`：失敗したプログラムのモジュールは次のフレームで代替マテリアル（MeshLambertMaterial）へ
- 計測：`EXT_disjoint_timer_query_webgl2` があればパスごとの GPU 時間（lab）、無ければ CPU。performance.js のパス名 'capture' 'reflection' 'composer' を保つ
- `?ng=-trees,-grass` でモジュール単位の無効化（切り分け用）

### 4.12 lab キット（lab/labkit.js）

```js
Lab.boot({ modules: ['water', ...], seed: 123456789, tier: 'high', size, characters: true /*Angler と魚 6 匹*/ })
window.__lab = { setHour, setWeather(k, { instant: true }), setTier, cam(preset | { pos, target }), freeze(t), tick(n, dt),
                 view('refl'|'sceneColor'|'depth'|'nearShadow'|'hfShadow'|'skyView'|'overdraw'|'falseColor'|<registerDebugView 名>),
                 stats() → { fps, gpuMs: {pass: ms}, draws, tris, programs, textures, rtBytes }, nanCheck() → 画素数 }
window.__gfxReady = true   // compileAsync 後
```

- 実物の湖（resolveLake(123456789)）・高さ場・placement・パイプライン・post を組み、要求したモジュール以外はスタブ
- カメラのプリセット：`dock-fp, dock-3p, shore-low, aerial60, far-ridge, forest-floor, reed-edge, weedbed-uw, uw-dock, waterline` と
  baseline の 7 構図（`dawn-3p, morning-fp, noon-fp-down, noon-shore, dusk-3p, night-fp, rain-fp`）
- **全 lab の画面の隅にグレー球・クロム球・24 パッチのカラーチャート**（`?chart=0` で消せる）。false color 表示で輝度帯を確認
- `scripts/gfx/scenarios/lab-matrix.mjs <module>`：プリセット × {5:40 朝霧, 9:00, 12:30, 17:45 黄金, 18:55 ブルーアワー, 23:30 月夜} × {clear, cloudy, rain} を撮り、stats を JSON に出す
- `scripts/gfx/art-metrics.mjs`：PNG から自動判定（中間輝度の帯、白飛び < 0.5%・黒つぶれ < 1%、水平視の水／空の輝度比 0.35–0.75、
  noon-fp-down の水の色相 160–200°、夜明けの露出の単調性、空のバンディング検出）

### 4.13 ファサード（Core-B）→ core（Core-A）の呼び出し（両者の接点。名前を変えない）

```js
import { createGfx, getGfx } from './gfx/core/index.js';
// Environment の constructor（湖より前）
const gfx = createGfx({ scene });                 // installNg() 済み。ngFrame・layers・スタブのモジュール表を持つ
gfx.setLightRig({ key: sunDirectionalLight, probe: lightProbe, lamp: lampPointLight });   // Environment が作って渡す（起動時に固定）
// Environment.update(dt, hour, camera, focus)
gfx.beginFrame({ dt, hour, camera, focus, weather: { key, cloud, rain }, nightAmount, sunDir, keyDir });
//   → sky モジュールの producer が ngFrame を書き、CPU 双子の色（sunColor / zenithColor / horizonColor / fogColor）と
//     fogNear / fogFar と key の色・強度と SH を返す：{ colors, fog: { near, far, color }, key: { color, intensity }, sh }
// Environment.underwater setter / Water.setUnderwaterView
gfx.setUnderwater(on);
// Terrain の constructor
gfx.attachRenderer(renderer);
const ready = gfx.attachWorld({ lake, terrain /*ファサード自身*/, placement, grids /*buildHeightGrids の Promise*/, progress });
//   → heightfield の GPU テクスチャ、派生マップ、全モジュールの init を行う Promise（terrain.ready の中身）
// Terrain の描画フック
gfx.wind.update(time, windPow);                   // updateWind
gfx.updateModules({ dt, camPos });                // updateTrees
gfx.services.hardscape.setLamp(night, dt);        // updateLamp
gfx.setFlow(flowDir, flowStrength);               // updateUnderwaterProps
gfx.setLodScale(k); gfx.setQuality(q);            // setQuality は冪等。どのファサードから呼んでもよい
// Water
gfx.waterUpdate({ sdt, time, wind, camera });     // Water.update の中。causticsUniforms の .value もここ（underwater モジュール）
gfx.services.water.addRipple(x, z, size, dur); gfx.services.water.addSplash(x, y, z, count, power);   // 投げない
gfx.pipeline.prepare(); gfx.pipeline.renderReflection();   // capture / captureReflection
gfx.setReflectionHidden(list);
gfx.getUnderwaterContext(camera);                 // 旧形のオブジェクト
// PostFX（Core-A 自身のファサード）
gfx.bindCamera(camera); gfx.pipeline.renderMain(dt); gfx.warmup();
```

**world 層（Core-B）→ core（Core-A）の受け渡し**：

```js
// src/world/heightgrid.js
buildHeightGrids(lake, { resolvedSeed, workers = 4 }) → Promise<{
  near: { data: Float32Array, n: 1040, origin: [-260, -260], step: 0.5 },
  far:  { data: Float32Array, n: 1024, origin: [-512, -512], step: 1.0 },
  bed:  { data: Uint8Array /*RGBA: mud,sand,rock,v*/, n: 260, origin: [-260, -260], step: 2.0 },
  hash }>                                         // メインスレッドの湖との一致を確かめ済み
sampleGrid(grid, x, z) → number                   // GPU と同じ手動バイリニア（テスト用）
// src/world/placement.js
buildPlacement(lake, queries) → Placement          // §5.2
isEdge(x, z, queries) → boolean
// src/world/species.js
SPECIES = { sugi: { heights: [18, 32], trunkR: [...4 variant], ... }, hinoki, buna, mizunara, momiji, akamatsu, yanagi, hannoki }
```

---

## 5. 世界データ層（src/world/、Core-B）

### 5.1 Phase −1：旧挙動の固定（何かを消す前に）

`scripts/capture-fixtures.mjs` で **旧コード（c8490ed）** の挙動を記録する（Node で lakefield/waveField、ブラウザで旧 Terrain/Water/Environment）：
約 2000 点の heightAt・depthAt・slopeAt・bedAt・normalAt・isWater・shoreRadius、約 500 本の onDock・dockBlocksSegment・lineBlocked（tol 0.22、slack 0.62 を含む。
障害物に当たるものは別扱い）、structureNear、桟橋の各値（dockStart/End/Dir/Y/_dockLen/_dockU/spawnPos/dockAngle/shoreR0）、
時刻 × 点の surfaceY・surfaceNormal、tickWeather の遷移統計、sunDir・nightAmount・keyDir の時刻表。
`scripts/fixtures/*.json` にコミットし、新しいファサードが **1e−9 で一致**することをテストする（障害物の中身だけは意図的に変わる）。

### 5.2 placement

```js
buildPlacement(lake, q /*queries*/) → Placement   // lake.seed だけから決定的。品質の引数を取らない
Placement = {
  trees: { x,z,y,h,species,variant,rot,lean,rank,collide } (SoA, Float32Array),
  boulders[], cobbles[], thicket[], reeds[], lilies[], weeds[], driftwood[],
  structures /* = lake.structures そのもの */, lamp, boat,
  ecology /* 焼き込み用の場のパラメータ */, hash
}
```

- 乱数：系統ごとに独立 `mulberry32(fnv1a(seed + ':trees'|':rocks'|':thicket'|':reeds'|':lilies'|':weeds'|':pebbles'|':understory'))`。
  **Math.random 禁止**（src/world と src/gfx を grep するテスト）
- 候補は世界に固定したジッタ格子（処理順・本数に依存しない）：木 4.2m セル（汀線 + 5m 〜 480m）、岩 9m、葦 0.9m（縁の帯）、睡蓮 1.6m
- 旧来の規則を守る：木は h ≥ 1.6、slope ≤ 0.78、桟橋から ≥ 3.6m、スポーンから ≥ 6m。岩は桟橋から ≥ 3.4m
- **生態区分**（art 案）：汀線 0–12m にヤナギ・ハンノキ、緩い下部斜面にブナ・ミズナラ・イロハモミジ、中腹に 100–300m の四角い **スギ・ヒノキ植林区画**
  （列植、暗い帯）、標高 90m 超・急な尾根にアカマツと露岩。空き地と林縁を作る
- rank = hash01(セル)。見た目は `rank < TIER_DENSITY[system][tier]`（例：木 low 0.22 / mid 0.55 / high 1.0）。**入れ子**（low ⊂ mid ⊂ high）
- **当たり（collide = 1）は全品質で同一**。次の物：
  - 歩ける帯の中と、帯の外 `FAR_GATE = 20m` 以内の木の幹（帯の外の木は糸もカメラも届かないので、これ以上は不要。旧版の 169m は品質依存の副作用だった）
  - 大岩（size > 1.4 かつ h > −0.9）
  - 歩ける帯の境目の藪の輪（r 0.55、`shoreRadius + 72 − 5 〜 + 4`、角度間隔は thicket の rng）
  - 灯籠（r 0.26、top = dockY + 2.3）、小舟（r 0.85 の円 2 つ）
  - ストラクチャー（r·1.15、top = heightAt + h）
- 寸法：幹 r = max(SPECIES[s].trunkR[v]·h·1.15, 0.28)、top = y + 0.9·h。大岩 r = 見た目の半径 × 1.05、top = 見た目の上端
- **帯の中 + 12m の当たりのある木は全品質で必ず描く**。それより外の当たり（帯の外 12〜20m）は描画を間引いてよい（触れない）
- 対応：藻場 = `lake.flats`（各円を水草で覆う）。葦際 = `isEdge(x,z) = depthAt ∈ (0.05, 1.5] ∧ 汀線まで < 12m`（placement から export、テストでも使う）。
  除外：桟橋の回廊 ±6m、スポーン 6m。それ以外の縁は 10m を超える空白を作らない。ストラクチャーの見た目は `lake.structures` の x, z, rot, h, r に正確に
- 予算 ≤ 250ms、Terrain のコンストラクタの中で同期に作る（`_initMap` がすぐ使えるように）

### 5.3 ファサード

- **Terrain**：数学系と当たりは src/world から旧ロジックを移植（§5.1 の fixture で一致を保証）。`heightTexture` = ngHeightNear。
  `static load*Textures()` は `Promise.resolve(null)` だが、Worker（高さ場・FFT・木の .bin の fetch）を早めに起動する。
  `ready: Promise` を持ち、game.js が Bed の段で 1 回 await する。`overWaterProps = []`、`underwaterProps = { group: new THREE.Group() /*空*/, activeCounts }`、
  `waterPlants = { submergedMeshes: [] }`。描画フックは §3.1 のとおりモジュールへ
- **Water**：`surfaceY(x,z) = depthAt ≤ 0 ? 0 : waveHeight(x,z,time,wind)·shoalGain(depth)`（旧 water.js:1013-1017 と同一）。surfaceNormal も旧式。
  `capture → pipeline.prepare`、`captureReflection → pipeline.renderReflection`。addRipple/addSplash はリングバッファで **絶対に投げない**（NaN は捨てる）。
  `uniforms.uLinearOut`（構築時から value 1）、`uniforms.uShallow / uDeep`（THREE.Color）、`causticsUniforms`（同じ参照）、`rt` = sceneColor の RT、`reflRT`
- **Environment**：`WEATHERS` はバイト一致。天候の状態機械は旧 sky.js:317-334 を逐語移植。`weatherTimer` は書き込み可。`setWeather(key, { instant })`。
  damp は旧係数（cloud λ 0.4、rain λ 0.35、実秒）。`scene.fog = new THREE.Fog`（near/far は媒質の双子から毎フレーム）。`sun`（DirectionalLight、castShadow、常に visible）。
  `sky` / `rain`（Object3D）、`skyUniforms.uStars / uLinearOut`、各色（THREE.Color）、`underwater` setter、`this.scene`
- **PostFX**：`renderer.toneMapping = NoToneMapping` を設定（game.js の ACES を上書き）。`setSize / setQuality / updateUnderwater / render` は投げない。
  `composer` / `bloom` は performance.js の RT 見積もり用の互換。`warmup()`（compileAsync + 各パスの空回し 3 フレーム）
- **shaders.js**：`CAUSTICS_GLSL`（新しい中身、同じシグネチャ `vec3 causticLight(vec3 worldPos, vec3 viewNormal)`、y > −0.02 は 0、16 個の `uCaust*` 名を維持）と
  `createCausticsUniforms()`（uCaustTex は最初から最後まで同じテクスチャオブジェクト。焼き終わるまでは 1×1 の配列テクスチャ）

### 5.4 game.js の変更（許可リスト。これ以外は触らない）

1. `createCausticTexture` の import と causticsUniforms の生成を `createCausticsUniforms()` に置き換える
2. renderer の `antialias: false`（MSAA は mainRT で行う。既定のフレームバッファの MSAA は無駄）
3. Terrain を作った後の Bed の段で `await this.terrain.ready`
4. Ready の前に `await this.postfx.warmup?.()`

`?v=` 付きの import は維持（installSingleRuntime のパッチが別インスタンスに当たっている現状を変えない）。debug.js は現状のまま動くこと
（`scene.fog.near/far`、`water.wind`、terrain の `obstacles/_obsGrid/_dockU/_dockLen/_dockLocal/structures`、桟橋の寸法は不変）。

---

## 6. モジュール（Phase 1、10 人が並行）

各モジュールの **合格条件**：lab の証拠一式（撮影と数値）・3 品質で予算内・例外 0・NaN 0・サンプラー上限内・ドロー数の予算内・run-tests 緑・
art-metrics の該当項目が合格。技法の詳細は proposals の該当節（→）を読む。

### 6.1 sky（空・大気・雲・天体・光のリグ）→ robust §sky、fidelity M1、art §sky
- Hillaire 2020：Rayleigh (5.8,13.5,33.1)e−6/m H 8km、Mie 3.996e−6 × haze（1 / 2.2 / 4.5 + 夜明け項）H 1.2km g 0.8、**オゾン** (0.65,1.88,0.085)e−6（ブルーアワーに必須）。
  transmittance 256×64、multiscatter 32²、skyView 256×128（毎フレーム、mip 付きで ngSkySpecular に使う）
- 空のドーム：全画面三角形、最後に描く。太陽円盤 0.53°（周縁減光、FP16 対策でクランプ）、月 0.52°（起動時に焼く 512² の海、満月固定）、
  星 ≈ 6000（等級分布・色温度・地平の減光・雲で消える・反射では 1.5 倍）、天の川（晴れの夜のみ、月明かりで弱まる）
- 雲：**カメラ非依存の雲パノラマ**（上半球の緯度経度、仰角 √ 写像、high 2048×768 RGBA16F、毎フレーム 1/16 を raymarch）。被覆は 24h 周期の領域で
  時刻の純関数（マルチで一致・真夜中で連続）。Perlin-Worley 64³ + 32³ の詳細、Beer-Powder、二重 HG (0.6/−0.2)、多重散乱近似。巻雲 8km。
  雨は乱層雲（被覆 0.95、底 600m、暗い腹）。low は 2D の fbm 層
- 雲影：`ngCloudShadow`（解析、同じ被覆関数）と CPU 双子（focus 点でキャラクター用の key を減光）
- 光のリグ：key は太陽高度 −1° で月に切り替え（交差点で強度 0 → 影の跳びなし）。SH L2 を 0.25s ごとに 128 方向から CPU で射影
  （地面の照り返し 0.12 と、focus 点の樹冠遮蔽を含む）→ LightProbe。水中では水の内散乱色で上書き
- 地平線の自動整合（§2）、朝霧（4:30–8:00、5:45 にピーク、雨上がりで増す）と雨の霞のパラメータ、濡れ（雨で τ 10 ゲーム分、乾き 60 ゲーム分）
- 予算：main high 0.70 / mid 0.50 / low 0.25、反射 0.25 / 0.15 / 0.10、LUT 0.05、CPU ≤ 0.3ms、読み込み ≤ 200ms
- 証拠：24 時刻のコンタクトシート（各天候）、ブルーアワーのビーナスベルトと地球の影、黄金時間の逆光の積雲、曇天、雨、23:30 の月夜、地平線の連続性（段差 < 4%）、SH と key 色の時刻グラフ

### 6.2 water（水面）→ robust §water、fidelity M3/M4、art §water
- 幾何：カメラ中心のクリップマップ（中心 0.25m、2 倍ずつ 5 リング、〜520m、high ≈ 80k 頂点）。リングごとにスナップ。
  VS：`y = ngWaveH(p,t)·wind·ngShoalGain(ngDepth(p))`（`waveGLSL({prefix:'ng'})` の出力をそのまま埋め込む。手で写さない）。陸は平らにして地形の下へ
- 法線：波の解析勾配 + 周期 FFT（JONSWAP、fetch 300m、風 1–6m/s、ω を 2π/16s の倍数に量子化して周期化、32 フレーム × 256² の勾配を配列に、
  2–3 スケール）× `ngWindAt` の振幅（猫足の斑と鏡のような凪）+ high は **波動方程式の波紋シミュ**（RG16F 512²、カメラ前方の窓、整数テクセルでスクロール、
  杭・葦・岸を減衰体に、2 サブステップ）+ 解析リング（最新 16 件、全品質、ウキが遠くても）+ 雨の輪（ハッシュセル 3 層）
- 粗さ：LEAN/Toksvig（mip の分散から α² = 0.02² + 2σ²）。遠くの湖面が正しくぼけ、黄金時間の光の道にきらつきのエイリアスが出ない
- 反射：reflRT を画面 uv + 法線の歪み、粗さ（と反射点までの距離）で mip を選ぶ。外れは skyView/雲パノラマで補う。Fresnel は Schlick F0 0.02 を粗さ補正
- 鏡面：GGX（円盤光の粗さ拡張）× key × ngSunVisibility（桟橋や釣り人の影できらめきが欠ける）。夜は月の道。灯籠の点光源
- 屈折：sceneColor（uv + 法線 × 厚みで歪み、深度で有効性を判定して戻す）。**吸収は足さない**（§3.4）。浅場の淡い青緑の散乱項だけ
- 汀：厚み 0–3cm で F → 0（硬い縁を出さない）、泡（forge の泡ノイズ × 薄さ × `ngShoreRunUp` の位相）、杭・葦・岩の周りの接触の泡
- 裏面：スネルの窓（臨界角 48.6°）、窓の外は全反射（水の散乱色 + 湖底の暗い映り）、窓の縁の明るさ
- しぶき：GPU の解析弾道（1024 粒、CPU の粒子ループなし）。着水で波紋を予約
- 予算：水面 high 1.10 / mid 0.80 / low 0.60（波紋を含む）、しぶき最大 0.1、CPU 0.2ms。反射パスの中身は各モジュールの反射列
- 証拠：9:00 の鏡面、突風 4m/s の斑と凪、黄金時間の光の道（720p と 1440p）、23:30 の月の道、noon-fp-down（湖底・藻・魚の屈折、深さの色、杭の泡）、
  雨の輪、ウキの輪の連続、スネルの窓、ウォーターライン、**GPU/CPU の水面高さの読み戻し（64 点、深場 < 1mm・浅場 < 5mm）**

### 6.3 underwater（caustics・水の光学・水中の見た目）→ robust §underwater、fidelity M4、art §underwater
- caustics：屈折した格子を面積比で加算（Evan Wallace 式）。周期 FFT の詳細高さ + 長い波。深さ 3m の面、RGB で分散。high 16 × 512²（配列）、
  mid/low 8 × 256²。uCaustTex は常に同じ DataArrayTexture（最初は 1×1）
- 新しい `CAUSTICS_GLSL`：同じ 16 名（テストが固定する既定値 `uCaustWarp (1.15, 2.5)`・`uCaustFar (6, 20)` は維持）、Snell で屈折した太陽方向へ投影、
  `csWaveD` は文字列の中だけで宣言、時刻フレームの線形補間、深さで LOD、太陽高度・夜・雨・雲で弱める。サンプラーは sampler2DArray のみ（魚の GLSL3 で動く）
- 光学：σa = (0.20, 0.075, 0.045) × (1 + 0.5·rain)、σs 0.03–0.06。ngWaterInsc = σs/(σa+σs) × (E_key·透過·0.55 + E_sky·0.8) × 青緑
- `getUnderwaterContext(camera)` → `{strength, time, sunDir, night, rain, cloud, absorb (Vector3 = σa), camPos, camNear, camFar, waterY}`
- 水中エフェクト（pmndrs Effect、post が差し込む）：光柱（半解像度 16 ステップ、caustics パターン × 近景の影 × 減衰。桟橋・舟・釣り人で切れる）、
  距離による mip ぼけ、ウォーターラインのメニスカス（近平面の 4 隅の surfaceY で線を引く）
- プランクトン：800/400/150 のソフト点、カメラ中心の 12m 箱で wrap（生成と消滅の処理なし）
- 読みやすさ：**10/20/30m のグレーカードのコントラスト**を数値化（魚を見つけるゲーム性）。藻場・葦際・ストラクチャーが桟橋から屈折で読めること
- 予算：水上 0（caustics はホストのマテリアルに含む）、水中 high 1.2 / mid 0.8 / low 0.4、焼き込み ≤ 30ms
- 証拠：uw-dock 正午（桟橋の影で切れる光柱）、weedbed-uw、見上げのスネルの窓、半潜り、夜明け・黄金・夜・雨、noon-fp-down の湖底の caustics、
  魚の近接（本物の createFishMaterial でコンパイルし、caustics が動く）

### 6.4 terrain（地形と湖底）→ robust §terrain、fidelity M5、art §terrain
- CDLOD（根 1024m、葉 16m、33² パッチ 1 枚をインスタンスで、LOD 範囲 24/48/96/192/384/768m、最後の 30% でジオモーフ）。
  VS で ngHeightNear/Far を手動バイリニア（境界 4m でブレンド）。**描画高さと heightAt の差：歩ける帯 < 2cm**（読み戻しテスト）。変位は ±2cm の微細のみ、POM なし
- 素材：8 層 × 2 配列（albedo+height / normal.xy+rough+AO）RGBA8、high 1024²（mid/low 512²）を forge で合成：
  杉の落葉と腐葉土、苔、草地の土、玉石の浜（Voronoi の石・隙間の砂）、浅場の砂とシルト（波紋の筋）、深場の泥、岩（安山岩・地衣類）、踏み跡の土
- ブレンド：高さ・傾斜・`ngShoreD`・`ngBedMap`（**底質はゲームと一致**）・`ngCanopy`（林床）・藻場（lake.flats の暗化）・湿り気・桟橋からの踏み跡。
  上位 2 層を高さブレンド。high は上位 2 層に hex-tiling、崖（傾斜 > 0.6）は triplanar。3 スケールのマクロ色むら
- 180m より先と反射パス：farAlbedo（2048² ±512m、起動時に上から描いた地形 + 樹冠色）
- 汀：`ngShoreRunUp` の遡上に合わせた濡れ帯（albedo × 0.55、粗さ 0.12、空の鏡面）。雨の濡れ・水たまり（雨の輪の法線）。水中は下向き光と caustics
- 遠景の稜線：700–1200 / 1200–2000 / 2000–3000m の 3 リング（ridged ノイズで lakefield の山を延長）、FAR 層。空気遠近で日本の青い層の山並み
- 高さ場影（§4.5）の焼き込みは terrain が担当（樹冠の高さは ngCanopy）
- 予算：main high 1.40 / mid 1.00 / low 0.80、反射 0.30 / 0.20、近景の影 0.30 / 0.20 / 0.15、CPU 0.15ms、読み込み ≤ 600ms
- 証拠：shore-low 13:00（砂 → 草 → 林床の移り変わりと濡れ帯の 4 コマ）、forest-floor、aerial60（3 距離でタイル繰り返しが見えない）、
  far-ridge 6:00 と 17:45、noon-fp-down の湖底、雨の水たまり、LOD の色分け、heightAt 誤差のヒートマップ

### 6.5 trees（森）→ robust §trees、fidelity M6、art §forest
- オフライン焼き込み（`scripts/bake/trees/*.mjs`、決定的・three 無し・`src/world/species.js` から）：
  スギ（単軸の円錐、輪生の垂れ枝、針葉のスプレー）、ヒノキ（鱗片葉、丸みのある尖り）、ブナ（空間コロニゼーション、灰白の樹皮に地衣の斑）、
  ミズナラ、イロハモミジ（層状の枝、掌状の葉）、アカマツ（曲がった赤い幹、傘状の樹冠）、ヤナギ（垂れ枝）、ハンノキ。
  **優先順位はスギ・ブナ・モミジ・アカマツ・ヤナギ**（残りは variant と色で近似してよい）。各 4 variant、LOD0（9–14k 三角形）/ LOD1（1.5–2.5k）。
  20B 量子化頂点（位置 int16×3、oct 法線、UV、風の属性、AO）。`assets/gfx/trees/trees.bin` + `trees.json` ≤ 3MB。再焼き込みでハッシュ一致をテスト
- テクスチャ（forge）：樹皮配列、葉アトラス（1 枚ずつの手続き葉：卵形・鋸歯・葉脈、針葉 → カードへ SDF で描く。albedo+α と normal+透過+粗さ、被覆保存 mip）
- シェーディング（ngExtendStandard）：葉は両面・法線を樹冠中心へ 60% 曲げる・透過（key × 厚み × 逆光 × 影、黄金時間に縁が光る）・個体の色むら。
  alpha-to-coverage（high）/ alphaTest（mid/low）。幹は苔（北・上面）と濡れ。風は深度の変種も同じ（幹 0.2Hz、枝の階層、葉 4–7Hz）
- LOD（high）：LOD0 < 45m、LOD1 < 140m、インポスター < 420m、樹冠シェル > 380m（mid 30/100/320/300、low 20/70/250/230）。
  インポスターは半八面体 8×8 フレーム（albedo+α、normal+depth）を起動時に焼き、3 フレームブレンド + 深度視差、**同じ BRDF で再ライティング**（時刻に追従）
- 樹冠シェル：far の高さ場（4m）を ngCanopy の高さだけ持ち上げ、Worley の樹冠の凹凸 + 葉の BRDF。FAR + SHADOW_ONLY
- 本数：当たりのある木（帯の中 + 12m）は常に描く。見た目の木（420m 以内）high 45k / mid 25k / low 10k（rank で入れ子）
- 予算：main high 2.00 / mid 1.50 / low 1.20、反射 0.50 / 0.35、近景の影 0.60 / 0.45 / 0.30、CPU ≤ 0.5ms、読み込み ≤ 900ms
- 証拠：森の中の見上げ（透過と木漏れ日）、林縁 40–150m（LOD の切り替えが見えない）、far-ridge のシェル、黄金時間の逆光のスギ、風の 8 コマ、影、
  **当たりの重ね表示（幹の見た目 × 1.15 と当たり半径の差 ≤ 5%）**、遠景の色の塊でスギ植林の暗い帯と広葉樹の明るいパッチが読める

### 6.6 groundcover（下草）→ robust §groundcover、fidelity M7、art §groundcover
- 草（スゲ・イネ科）：頂点属性なしの手続きインスタンス。ID → カメラ中心のリング格子のセル → ハッシュのジッタ → `ngCoverMap` で判定（落ちたら退化）。
  1 株 8 枚（5 節）。high 25k 株 / 32m、mid 12k / 25m、low 4k / 18m。遠くは株を減らし刃を太くして面積を保つ。**根元の色を地形と一致**（ΔE < 6）
- 陰影：ラップ Lambert + 透過（逆光 HG）+ 先端の光沢 + 高さ方向の AO + 色むら・枯れた先端。近景の影を受け、落とさない。風は `ngWindAt`、プレイヤーの踏み倒し
- クマザサ（林床の群落）、シダ（沢筋と水辺）、苔の塊、落ち枝と落葉、玉石の浜の小石（実体、半径 15m、岩のマテリアルを共有）
- 歩ける帯の境目の藪の見た目（placement.thicket の位置に低木の塊、見た目の半径 ≈ 当たり × 1.1、高さ ≥ 1.2m、低木は影を落とす）
- 予算：high 1.35 / mid 0.85 / low 0.30。反射には写さない（NO_REFLECT）
- 証拠：一人称の林床、岸の草地、17:30 の逆光の草原、藪の輪を 10m から、雨で濡れた草、草の消える縁が見えない（60m）

### 6.7 shoreflora（水生植物）→ robust §shoreflora、fidelity M7、art §aquatic
- ヨシ・マコモ：placement.reeds（isEdge）に茎（テーパーしたリボン 6 節）+ 葉 4–6 枚、穂。high 30k 本（〜80m、その先は株のカード）/ mid 15k / low 6k。
  強い風の揺れ、根元の濡れ色（水面の高さで）。反射に写す（LOD1）。water の減衰体として茎を登録
- 睡蓮（ヒツジグサ）・ヒシ：入り江の浅場の群落。**頂点の y は同じ波の関数**（CPU の surfaceY と一致、±1cm）、水面の法線で傾ける、蝋質の鏡面、白い花が少し。+0.01m と polygonOffset
- 沈水植物（クロモ・エビモ）：`lake.flats` の各円を覆う（ガウス減衰の密度、1.2–4m で密）、流れで揺れる帯。UNDERWATER 層
- 予算：high 1.00 / mid 0.60 / low 0.30
- 証拠：桟橋からヨシ原（夕方の逆光で穂が光る）、睡蓮の群落、藻場の水中（lake.flats の円を重ねて覆っていること）、雨の浮葉、水深 1.5m の等深線とヨシの分布の一致

### 6.8 hardscape（桟橋・灯籠・小舟・岩・ストラクチャー）→ robust §hardscape、fidelity M8、art §rocksprops
- 桟橋：**寸法は契約どおり**（床幅 3.4m、歩ける半幅 1.62、床の上面 = dockY、先端 2.3m の手すり、杭 2.4m 間隔）。床板は 1 枚ずつ幅・反り・隙間（1.5cm、下の水が見える）・色むら。
  木材は forge（年輪・木目・節・ひび・灰銀の風化・釘の錆の垂れ）。杭の水線下に藻の帯。雨で濡れ（粗さ 0.15、水たまりの輪）
- 灯籠：r 0.26 / top dockY + 2.3。2200K の発光に 1/f のゆらぎ。PointLight（起動時に固定、昼は intensity 0）。`setLamp(night, dt)`（dt で damp、ポーズで止まる）。夜に蛾
- 小舟：木の和船、係留ロープ。**上下とピッチ・ロールは waveField の同じ関数**
- 岩：Worker で icosphere → ノイズ → 角の欠け → 熱侵食 → 窪みの AO（8–12 形 × 3 LOD）。triplanar の安山岩・花崗岩、上向きの面に苔（樹冠の陰と水辺で厚く）、
  水線 ±0.3m の濡れと藻、水中はシルト
- ストラクチャー：沈み岩と立ち枯れ（白く晒された幹と枝）を `lake.structures` の x, z, rot, h, r に **正確に**。UNDERWATER 層（屈折で桟橋から見える）
- 流木、湖底の枝と落葉
- 予算：high 0.90 / mid 0.55 / low 0.30
- 証拠：桟橋の一人称（晴れ・雨・夜）、灯籠の光が水面に縦長の帯、杭の藻（水中から）、苔むした大岩、水中の立ち枯れ、**当たりの重ね表示（debug.js の箱と 2cm 以内）**

### 6.9 weatherfx（雨・霧・粒）→ robust §weatherfx、fidelity M2、art §weatherfx
- 雨：カメラ中心の円柱（半径 25m、高さ 20m）で wrap する筋（high 12k / mid 6k / low 2.5k）。位置は時刻と ID の純関数。風で傾け、長さは速さ × 1/60s。
  逆光・灯籠で光る細い屈折風。樹冠と桟橋の下には降らせない（ngCanopy と上から見た高さ）。着弾（地面・桟橋の王冠）、水面へは water の addImpulse。遠景は霞
- 朝霧の板：水面上 0.5–4m の大きなソフトカード（60 / 32 / 16）、風で流す、深度でソフト、カメラに近いと透明、前方散乱で太陽側が光る。core の朝霧と同じ密度場
- 蛍（初夏の晴れた夜、葦の上、2–4 秒周期の点滅）、光芒の中の塵（森の中、太陽が低いとき）
- `env.rain`（Object3D）を提供、`env.underwater` で雨を隠す
- **high の任意機能**：フロクセル（160×90×64、`ngVolEnd` の区間分割、朝霧・森の光芒・灯籠の光暈）。予算に余裕があるときだけ
- 予算：high 0.40（雨天 +0.25）/ mid 0.30 / low 0.15
- 証拠：雨の一人称、雨の夜の灯籠、日の出の朝霧（層として読め、カードの縁が見えない）、22:00 の蛍

### 6.10 post（露出・AO・光芒・Bloom・グレード・AgX・AA・DRS）→ robust §post、fidelity M9、art §post
- 露出（§2、adapt の測光は 1/16 縮小の log 平均 → 1×1、`readRenderTargetPixelsAsync` 4Hz）、NaN/Inf の除去
- GTAO（high、半解像度、2 スライス × 6 ステップ、半径 1.2m）→ **不透明の画素だけ**に合成（最終深度 = 不透明深度のところ）。mid/low は無し
- 光芒：1/4 解像度、24 / 16 サンプル、太陽が画面の 1.3 倍以内・高度 < 25° のとき。**近景の影マップで遮蔽**（森の木漏れ日）
- Bloom：pmndrs の mipmap（high 8 段 / mid 5 / low なし）、しきい値なし・エネルギー保存 3.5%（夜と水中 5%）、最初の段は Karis 平均
- グレード：ホワイトバランス（夜明け +300K、ブルーアワー −800K、夜はプルキニエ風の青と彩度 −35%）、lift/gamma/gain、彩度（時刻で 1.0–1.12）、ビネット 0.12
- AgX（pmndrs ToneMappingEffect の AGX）→ ±0.5 LSB のブルーノイズディザ → SMAA（mid）/ FXAA（low）→ DRS のアップスケール（+ 軽い CAS）
- underwater の `createEffect()` を差し込む（null なら無し）。debug 表示の登録 API
- 予算：high 1.00 / mid 0.75 / low 0.50
- 証拠：AO の有無、露出の遷移（林の陰 → 日向 → 水中）、AgX のチャート（24 パッチ ±4EV）、Bloom（太陽と灯籠）、DRS の追従

---

## 7. 品質段階（当たりと配置は全品質で同一）

| 項目 | low | mid | high |
| --- | --- | --- | --- |
| pixelRatio 上限（既存） | 1 | 1.5 | 2 |
| DRS の範囲 | 0.6–1.0 | 0.75–1.0 | 0.7–1.0 |
| mainRT | RGBA16F（無ければ RGBA8）、MSAA なし | RGBA16F | RGBA16F、MSAA 4× + A2C |
| post AA | FXAA | SMAA | なし（MSAA） |
| scene copy | 半解像度、mip なし | 全解像度 | 全解像度 + 4 mip |
| 近景の影 | 1024² ±30m | 2048² ±40m | 3072² ±48m |
| 高さ場影 | ±1024m 512² のみ | 2 段 1024² | 2 段 1024² |
| 平面反射 | **0.25×、隔フレーム**（地形・インポスター・桟橋・人物） | 0.5×、毎フレーム、LOD +1 | 0.6×、毎フレーム |
| 水の詳細法線 | 16 × 128²、2 スケール | 32 × 256²、2 スケール | 32 × 256²、3 スケール + 微細なきらめき |
| 波紋 | 解析リング | 解析リング | 波動方程式シミュ 512² + 解析リング |
| 水面メッシュ | 64² 基準、4 リング | 96²、5 リング | 128²、5 リング |
| caustics | 8 × 256²、強さ 0.32 | 8 × 256²、0.72 | 16 × 512²、1.0 |
| 水中の光柱 | 解析の光暈 | 8 ステップ | 16 ステップ |
| 雲 | 2D fbm 層 + 巻雲 | パノラマ 1536×576、1/16 更新 | パノラマ 2048×768、1/16 更新 |
| 地形 CDLOD | 17² パッチ、範囲 ×0.6 | 33²、×0.75 | 33²、×1.0 |
| 地形の素材 | 512²、2 スケール | 512²、hex 上位 1 | 1024²、hex 上位 2 |
| 木（見た目、420m 以内） | 10k | 25k | 45k |
| 木の LOD0 / LOD1 / インポスター / シェル | 20 / 70 / 250 / 230m | 30 / 100 / 320 / 300m | 45 / 140 / 420 / 380m |
| インポスター | 8×8 @64² | 8×8 @96² | 8×8 @128² |
| 葉のアトラス | 512²、alphaTest | 512²、alphaTest | 1024²、A2C |
| 草 | 4k 株 / 18m | 12k / 25m | 25k / 32m |
| 笹・シダ | 30% | 60% | 100% |
| ヨシ | 6k | 15k | 30k |
| 睡蓮 / 沈水植物 | 600 / 1.2k | 1.5k / 3k | 3k / 6k |
| 当たりの無い岩・小石 | 40% | 70% | 100% |
| 雨の筋 / 着弾 | 2.5k / 150 | 6k / 250 | 12k / 400 |
| しぶき | 256 | 512 | 1024 |
| 霧の板 / 蛍 / 塵 | 16 / 60 / 0 | 32 / 120 / 150 | 60 / 200 / 300 |
| GTAO | なし | なし | 半解像度 |
| Bloom | なし | 5 段 | 8 段 |
| 光芒 | なし | 16 サンプル | 24 サンプル |
| 魚の数（ゲーム性、変えない） | 14 | 22 | 30 |
| GPU の目標 | Iris Xe 1080p ≤ 25ms | 無印 M1 1080p ≤ 13ms | **M1 Pro 2560×1440 ≤ 14ms** |

### high の予算（2560×1440、M1 Pro、ms）

| 項目 | ms |
| --- | --- |
| core（コピー 0.15、resolve 0.35、高さ場影のスライス 0.1、SH・LUT 0.1） | 0.70 |
| sky（main + 反射 + LUT） | 1.00 |
| water | 1.20 |
| terrain（main + 反射 + 近景の影） | 2.00 |
| trees（main + 反射 + 近景の影） | 3.10 |
| groundcover | 1.35 |
| shoreflora | 1.00 |
| hardscape | 0.90 |
| weatherfx | 0.40 |
| post | 1.00 |
| キャラクター（予約） | 1.20 |
| **合計** | **≈ 13.85** |

削る順番（実測で超えたら上から）：フロクセル → GTAO → 光芒のサンプル数 → 反射の解像度 → 草の半径 → 木の LOD0 距離 → MSAA 2× + SMAA。

---

## 8. 読み込み（既存の進捗の段に乗せる。各段で await して描画の機会を譲る）

| 段 | 仕事 | 目標 |
| --- | --- | --- |
| loadingSky | core の install、NgFrame、forge、空の LUT とノイズ | 0.15s |
| Lake | resolveLake（既存）、高さ場の Worker（load*Textures で先に起動）、placement、collision | 0.5s |
| Bed | terrain.ready：地形の素材 + CDLOD + farAlbedo、木の decode・forge・インポスター、下草、水生植物、hardscape | 1.3s |
| Water | FFT の upload、caustics の焼き込み、水面、RT | 0.15s |
| FishTex / Fish / Angler / Rods | 変えない | — |
| Ready | `postfx.warmup()`：compileAsync（KHR_parallel_shader_compile）+ 各パスの空回し 3 フレーム | ≤ 1.5s |

追加の読み込み時間は M1 Pro で ≤ 3.5s（上限 6s）。VRAM：high ≈ 800MB、mid ≈ 330MB、low ≈ 140MB。

---

## 9. テスト

### Node（`scripts/run-tests.mjs`。KEEP の 17 本と walk-zone を先頭に並べ替える）
1. **lake-invariance**：`resolveLake(123456789).tries === 1`、makeLake(123456789) の出力（heightAt 64²・structures・flats・holes・dock）の SHA-256 が c8490ed の値と一致
2. **terrain-api-parity**：Phase −1 の fixture すべてに 1e−9 で一致
3. **placement-determinism**：2 回作ってバイト一致、当たりの配列ハッシュが low/mid/high で同一、見た目の部分集合が入れ子、Math.random の不使用（grep）
4. **collision-dims**：幹・大岩・灯籠・小舟・藪の輪の寸法と帯、桟橋とスポーンの空き、ストラクチャーの位置、葦は isEdge、藻は flats
5. **species-bake-consistency**：trees.json の幹の太さが SPECIES の 2% 以内、再焼き込みで trees.bin のハッシュ一致
6. **wave-agreement**：waveGLSL('ng') の定数が waveField と一致、surfaceY/surfaceNormal が旧 fixture と一致、lake-calm-water の物理部分は残す
7. **weather-api**：WEATHERS 同一、tickWeather の分布（1 万回、同じ天候 ×0.35、2.5–6.5h）、不正キーの無視、weatherTimer の書き込み、dt=0 で停止、instant
8. **core-chunks**（vendored three を Node で import）：extend のアンカーが ShaderChunk/ShaderLib に存在、fog の差し替えと ngFrame の注入、
   cloneUniforms が Float32Array を参照で保つ、全体チャンクに ng 以外の識別子・`uCaust*`・`causticLight`・`cs*` が無い
9. **ngframe-layout**：生成した #define が JS の表と一致、slot の書く人が 1 対 1
10. **medium-twin**：閉形式の光学的厚さが 256 ステップの数値積分と < 1%、scene.fog の near/far が単調
11. **api-safety**：addRipple/addSplash を NaN・Infinity・範囲外・1 万回で呼んでも例外なし、getUnderwaterContext のキー、causticsUniforms の 16 名と参照の不変
12. **performance-test / walk-zone-test（MIXED）**：残す文字列と形を維持

### ブラウザ（`scripts/gfx/shot.mjs`、ヘッドレス Chrome、M1 の GPU）
- **smoke-all**（index.html）：1200 フレーム、時刻 0→24 を 0.25h 刻み、天候の巡回、品質 low→mid→high→mid、水中の往復 4 回、一人称の切り替え、リサイズ 2 回、
  影の ON/OFF。ページ例外 0・console エラー 0・onShaderError 0、60 フレームごとに中央画素が NaN/黒/白飛びでない
- **故障の注入**：各モジュールの update/prepare に throw を入れても、フレームが完走し、MP ラッパー（sharedFish.update 等）が走り続ける
- 読み戻し：水面 GPU/CPU < 5mm（深場 < 1mm）、地形 < 2cm（歩ける帯）
- caustics-fish：本物の createFishMaterial がコンパイルでき、正午 3m で caustics > 0、水上で 0
- sampler-audit：全プログラムで fragment ≤ 12・vertex ≤ 4
- perf-matrix：6 視点 + 雨 + 水中、high 2560×1440 と mid 1920×1080、DRS 無効。high の p95 > 16.0ms で失敗、モジュール予算の 1.25 倍超で失敗
- load-time：Sky → Ready の実時間、コールドで 3 回。追加 > 6s で失敗、> 4s で警告
- **art-metrics**（§4.12）と **読みやすさ**：水中のグレーカード 10/20/30m、藻場・葦際・ストラクチャーが桟橋から読める、ウキとマーカーが常に見える
- mp-browser-test（既存）：品質の違う 2 クライアントで当たりのハッシュが一致
- 比較撮影：baseline の 7 視点 + 水中・曇り・雨の夜・森の中を、旧版と並べて `docs/nextgen/shots/` へ

---

## 10. 工程とゲート

| 段 | 担当 | 内容 | ゲート |
| --- | --- | --- | --- |
| Phase −1 | Core-B | 旧コードの fixture を記録（§5.1）。**旧ファイルを消す前に** | fixture がコミットされている |
| Phase 0 | Core-A / Core-B 並行 | Core-A：§4 の全部 + postfx/shaders ファサード + labkit + 10 モジュールのグレーボックスのスタブ + MSAA のスパイク。Core-B：§5 の全部 + ファサード 3 本 + game.js の 4 変更 + 旧ファイルと GRAPHICS テストの削除 + 新しい Node テスト | **G0**：run-tests 緑、3 品質でグレーボックスが起動、smoke-all 合格、MP ブラウザテスト合格、グレーボックスの GPU < 5ms、追加の読み込み < 2s、`docs/nextgen/CORE_API.md`（凍結した API） |
| Phase 1 | 10 モジュール並行（各自の git worktree） | §6 | 各モジュールの合格条件 |
| Phase 2 | 統合 + ルック開発 | 全モジュールを入れた本編で、時刻 × 天候 × 視点の撮影表でルックを詰める。アートレビューの批評パネル → 修正のループ。予算の再配分 | art-metrics 合格、perf-matrix 合格 |
| Phase 3 | 検証と出荷 | 全テスト、故障注入、MP、読み込み時間、メモリ、README と docs、比較撮影 | すべて緑 |

凍結した API の変更要望は `docs/nextgen/core-requests.md` に書く。統合者が週ごとではなく **Phase の境目で** まとめて取り込む。
