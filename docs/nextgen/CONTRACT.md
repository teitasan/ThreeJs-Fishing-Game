# 次世代グラフィック：ゲームロジックとの契約

このフォーク（`fork/nextgen-graphics`）では、環境の見た目（水・地面・植生・岩・空・光・後処理・小物）を
**すべて捨てて作り直す**。ゲーム性・キャラクター・UI・セーブ・マルチプレイ・湖の生成は **そのまま動かす**。

この文書は「作り直しても壊してはいけない境界」をまとめたもの。行番号は作り直し前（`c8490ed`）の値。
調査の元データ：`/private/tmp/claude-501/-Users-apple-Fishing-Game/ba633276-ef99-4741-99a0-6e6d9578f4c6/scratchpad/maps/*.json`

---

## 1. 触らないもの（中身を変えない）

| 対象 | 理由 |
| --- | --- |
| `src/lakefield.js` | Worker が `makeLake(123456789)` をそのまま使う。1bit でも変えるとマルチの湖がずれる。`resolveLake(123456789).tries === 1` を保つ |
| `src/util.js` / `src/data.js` / `src/i18n.js` / `src/locales/*` | lakefield と Worker が共有。値を変えない（`RODS.cast` は湖の妥当性判定に効く） |
| `src/fishing/**` / `src/multiplayer/**` / `src/network/**` / `worker/**` / `src/games/**` | ゲーム性とマルチ |
| `src/fish.js` / `src/angler.js` / `src/baitMesh.js` / `src/fishTextures.js` | キャラクター。例外は §4.5（caustics の注入口だけは合わせて直してよい） |
| `src/ui.js` / `src/save.js` / `src/audio.js` / `src/icons.js` / `src/terrainIcons.js` | UI・セーブ・音。M キーの測量マップは three を使わない 2D |
| `assets/models` `assets/icons` `assets/fish` `assets/terrain`（図鑑サムネ） `assets/audio` `assets/motions` | キャラクターと UI |

Worker がたどる import（lakefield / util / data / i18n / locales / fishing/simulation/* / speciesDisplay / othelloLogic）に
**three や DOM を入れない**。入れると Durable Object が起動せず CI（`run-mp-protocol-test`）が落ちる。

## 2. 捨てるもの

`src/sky.js` `src/water.js` `src/terrain.js`（見た目部分） `src/postfx.js` `src/shaders.js` `src/causticTexture.js`
`src/trees.js` `src/treeSkeleton.js` `src/rocks.js` `src/rockShape.js` `src/undergrowth.js` `src/waterPlants.js`
`src/underwaterProps.js` `src/underwaterScatterMath.js` `src/lodInstances.js` `src/tileableNoise.js` `src/materialPatch.js`
`src/terrainMesh.js` `src/reflectionMath.js` `src/dioramaCube.js` `shore-diorama.html` `assets/textures/*`
と、それらのソース文字列を正規表現で固定しているテスト（§7）。

`sky.js` `water.js` `terrain.js` `postfx.js` `shaders.js` は **ファイル名と export 名を残し、中身を新しい実装に差し替える**
（game.js・installSingleRuntime.js・fish.js の import を最小の変更で済ませるため）。新しい実装の本体は `src/gfx/` に置く。

## 3. 座標と単位

- ワールドはメートル、Y 上。湖の中心が原点。**静水面は y = 0**（Worker も `surfaceY: 0` 固定）
- `heightAt(x,z) < 0` が水中。地形の見た目は **解析関数 `lake.heightAt` に一致させる**（足・糸・魚のクランプがこれだけを見る）
- `WORLD_SIZE = 1000`、`WATER_REGION = 440`、`MAX_DEPTH = 26`、湖岸半径 88〜172m、歩ける帯は汀線から `WALK_INLAND = 72` m
- 時刻 `state.clock` は 0〜24 の時。実 1 秒 = ゲーム内 1 分。空と光は **時刻と天候だけで決まる純関数** にする（マルチの時刻同期）

## 4. 外部から見える API

### 4.1 `Environment`（`src/sky.js` から export。`WEATHERS` も）

```
new Environment(scene, { exposure })          // 湖より前に作れること
update(dt, hour, camera, focusPos)            // dt=0 でポーズ（時計・天候の遷移が止まる）
tickWeather(dtHours) → WeatherDef | null      // 残り時間が切れたら重み抽選して返す（同じ天候は重み×0.35、2.5〜6.5h）
setWeather(key)                               // 不正なキーは無視。見た目は damp で遷移（MP の切り替え）
setQuality('low'|'mid'|'high')
weather { key:'clear'|'cloudy'|'rain', name, icon:'weather-*', cloud, rain, bite, weight }
weatherTimer (書き込み可の数値。MP が毎フレーム ≥1e8 に固定する)
rainIntensity / cloudiness (0..1、damp で追従)   // water.wind の式に入る → 波の高さ → ウキ
nightAmount (0..1、太陽高度から)
sunDir / keyDir (Vector3 を in-place 更新。keyDir は夜は月方向。月 = -sunDir)
sunColor / zenithColor / horizonColor / fogColor (THREE.Color)
underwater (setter: 水中フォグ・環境光の上乗せ・雨の非表示)
sky / rain (Object3D。キャプチャの除外に使う)
skyUniforms.uStars / .uLinearOut
sun: DirectionalLight（影を落とす。sun.shadow.map を perf が読む）
scene.fog: THREE.Fog（near/far を持つこと。debug.js:462 が near.toFixed を呼ぶ）
```

WEATHERS の値（bite 1.0/1.12/1.3、weight 44/34/22 など）はサーバーの `weather.js` と揃っているので変えない。

### 4.2 `Terrain`（`src/terrain.js` から export。`WATER_REGION` `WALK_INLAND` も）

**データ・判定（ゲーム性）** — すべて解析関数か、シードから決定的に作った配置から計算する：

```
heightAt / depthAt / slopeAt(x,z,e=1.2) / shoreRadius / bedAt(x,z) → {v, kind:'mud'|'sand'|'rock'}
normalAt(x,z,e=0.7) / isWater(x,z)
structureNear(x,z,r=4.5) → {x,z,kind:'rock'|'snag',r,top,depth} | null
structures[]  (lake.structures から。top = heightAt + h)
onDock(x,z) → dockY | null      // 矩形。桟橋ローカル al∈[0,_dockLen]、|si| ≤ 1.62
distToDock(x,z)
dockBlocksSegment(x0,y0,z0,x1,y1,z1)   // 床の箱 y∈[dockY-0.42, dockY+0.18]、先端 2.3m の手すりの箱 y ≤ dockY+1.05
addObstacle(x,z,r,top) / blockedAt(x,z,rad=0.32,y?) / obstacleTopAt(x,z)
lineBlocked(x0,y0,z0,x1,y1,z1,{tol=0.22,slack=0.5}) → {x,y,z,ground,kind:'terrain'|'rock'} | null
obstacles (flat [x,z,r,top,...])、_obsGrid (8m ハッシュ、半径は 7.6m 未満)
dockStart / dockEnd / dockDir / dockY / spawnPos (= dockEnd - 3·dockDir, y=dockY) / dockAngle / shoreR0
_dockU / _dockLen / _dockLocal(x,z,out)   // debug.js が読む
lake / seed / noise / hole / flat
heightTexture                             // 必要なら残す（新しい描画が使わなくてもよい）
```

**描画のフック**（名前と引数は残す。中身は新しい描画へ委譲してよい）：

```
new Terrain(scene, { quality, lake, causticsUniforms, renderer, ... })
static loadBedTextures() / loadDockTextures() / loadLandTextures() / loadLeafTextures()  // 不要なら null を返す Promise でよい
updateWind(time, windPow) / updateTrees(dt, cameraPos) / updateLamp(nightAmount, dt)
updateUnderwaterProps(time, camera, flowDir, flowStrength) / updateShore(waterTime, wind)
setQuality(q) / setLodScale(k)
overWaterProps[] / underwaterProps{group, activeCounts} / waterPlants{submergedMeshes}   // game.js が除外リストに渡す
```

### 4.3 `Water`（`src/water.js` から export）

```
new Water(scene, terrain, { quality, exposure, causticsUniforms, skyUniforms })   // Terrain の後、PostFX と FishSchool の前
surfaceY(x,z) → m            // ★物理。陸（depthAt ≤ 0）では 0。見た目の水面と一致させる
surfaceNormal(x,z,out) → out // ウキの傾き
addRipple(x,z,size=1,dur=1.6) / addSplash(x,y,z,count=14,power=1)   // 25 か所以上から呼ばれる。満杯でも例外を出さない
update(dt, camera, env)      // time += dt（ポーズ中は 0）、wind = 1 + rain·0.92 + cloud·0.14、causticsUniforms を毎フレーム書く
time / wind                  // terrain.updateShore(water.time, water.wind) と組
capture(renderer, scene, camera) / captureReflection(renderer, scene, camera)   // 呼ばれても安全であること（中身は新パイプラインへ）
getUnderwaterContext(camera) → { strength, time, sunDir, night, rain, cloud, absorb, camPos, camNear, camFar, waterY }
setUnderwaterView(on) / setCaptureHidden(list) / setReflectionHidden(list) / setQuality(q)
uniforms.uLinearOut（構築直後から存在） / causticsUniforms（同じ参照のまま） / rt / reflRT（RT か null）
```

**波の物理**：今は `waveField.js` の 5 本の正弦波（振幅合計 < 0.27m、1 本 ≤ 0.12m、速さ ≤ 1.75）× `shoalGain(depth)` × wind。
ウキ・魚の跳ね・取り込み条件・カメラのクランプがこの高さに乗る。**見た目の変位（GPU）と CPU の `surfaceY` を同じ関数で出す**こと。
細かい波（風紋・さざ波・雨の輪・ウキの波紋）は法線だけにして、変位はこの低周波の波に限るのが安全。
湖は「穏やか」を保つ（`lake-calm-water-test` の波の検査は残す）。

### 4.4 `PostFX`（`src/postfx.js` から export）

```
new PostFX(renderer, scene, camera, { quality, water, sky, exposure })
setSize(w,h) / setQuality(q) / updateUnderwater(ctx) / render(dt)
composer / bloom   // performance.js の RT 見積もりが optional chaining で読むだけ。無くても落ちない
```

### 4.5 caustics（魚と共有）

- `water.causticsUniforms`：16 個の `uCaust*` を持つ `{value}` のオブジェクト。**FishSchool より前に作り、以後は同じ参照のまま `.value` だけ書き換える**
- `shaders.js` の `CAUSTICS_GLSL` が `vec3 causticLight(vec3 worldPos, vec3 viewNormal)`（加算の放射輝度、y > -0.02 は 0）を宣言する
- 魚は `fish.js:965-975` で `#include <common>` の後ろに `CAUSTICS_GLSL`、`#include <emissivemap_fragment>` の後ろに
  `totalEmissiveRadiance += causticLight(vFishWorldPos, normal);` を入れる。**新しい caustics もこの形で入れられること**
  （魚側の注入を共有モジュールの関数呼び出しに置き換えるのは可。そのときは remoteFish も同じ経路になる）
- 魚の頂点シェーダは `uTime uAmp uFreq uLen uBend` `vFishWorldPos`、断片には `csWave*` `causticLight` `uCaust*` が入る。
  **全マテリアル共通のチャンク上書きで同じ名前を宣言しない**（redefinition でコンパイルが落ちる）。新しい共有 GLSL は接頭辞 `ng` を付ける

### 4.6 game.js との接点

- build の順序と進捗文言：`ui.loadingSky → Lake → Bed → Water → FishTex → Fish → Angler → Rods → (Players) → Ready`。各段で await して描画の機会を譲る
- `applyQuality()`：`state.settings.quality`（'low'|'mid'|'high'）と `settings.shadow` を反映する唯一の入口。魚の数 14/22/30 も今はここ
- `_setUnderwaterFx(on)`：`env.underwater`、`water.setUnderwaterView`、`audio.setUnderwater`。`_uwFx` は糸のクリップにも効く
- 狙いの輪 `marker` / `aimMarker`：MeshBasicMaterial、fog:false、renderOrder 6。水上で常に見えること
- `window.__game` と、撮影ハーネス・capture-docs・mp-browser-test が使う内部（`pos yaw pitch state.clock _setFirstPerson _setUnderwaterFx uwYaw marker aimMarker`）
- `main.js` の rAF ループは update の例外を握りつぶして続ける。描画の例外は `perf.abortFrame` の経路を守る
- 描画順の既存値：空 -1000、波紋 3、糸 5、マーカー・ウキの輪 6、debug 900（depthTest:false で全パスに写る）

## 5. 配置と当たり判定（いちばん壊しやすい所）

今は障害物とストラクチャーが **見た目の配置ループの中で作られている**（`terrain.js` の `_buildDock` `_buildProps` `_buildUndergrowth`）。
作り直しでは **ゲーム用の配置レイヤー**を独立させる：

- シードだけから決まる（`Math.random` 禁止）。**品質に依存しない**（今は品質で本数と rng 列が変わり、マルチで当たりがずれている）
- 系統ごとに rng を分ける（木・岩・藪…）。見た目の密度は品質で変えてよいが、**当たりを持つもの（幹・大岩・藪・灯籠・小舟・ストラクチャー）は全品質で同じ**
- 見た目と当たりを一致させる：幹の当たり半径 = 見た目の幹の太さ × 1.15（最小 0.28）、上端 ≈ 0.9 × 樹高。大岩は見た目の大きさから
- 残す当たり：灯籠（r0.26、top dockY+2.3）、小舟（2×r0.85）、歩ける帯の中と FAR_GATE 以内の木の幹、大岩（size>1.4 かつ h>-0.9）、
  沈んだストラクチャー（r·1.15、top = 湖底 + h、水面下）、**歩ける帯の境目の藪の輪**（r0.55、shoreRadius + 72 − 5 〜 +4、見えない壁の代わり）
- 桟橋・スポーンの周りは空ける（木・岩は桟橋から 3.4〜3.6m、スポーンから 6m）
- **沈み岩と立ち枯れは `lake.structures` の x,z に正確に置く**（見えるものと魚のボーナスを一致させる）
- **藻場 = `lake.flats`** を水草で覆う（図鑑の «藻場»）。**水深 ≤ 1.5m の縁にヨシ**（図鑑の «葦際»）
- 見た目の湖底・地面は `heightAt` から大きく盛り上げない（魚が湖底 +0.22 までクランプされるので、深い変位や POM は魚が埋まって見える）
- 桟橋の寸法（床幅 3.4m、歩ける半幅 1.62、手すり先端 2.3m、床の上面 ≈ dockY）を変えるなら `onDock` `dockBlocksSegment` `debug.js:110,139-140` を一緒に

## 6. 描画のパイプライン

- 今は影マップの更新が `water.capture` の中だけにある（`autoUpdate` を true→false）。**新しいパイプラインでは影の更新を明示的に 1 か所で持つ**
- 水面越しに見える魚・沈んだウキの下半分・水中カメラ時の仕掛けは、屈折（またはそれに代わる方式）に **キャラクターも写る**こと。反射にも釣り人・竿・ウキが写ること
- 色の流れ：シーンは **リニア HDR** で描き、**トーンマップと sRGB 変換は最後に 1 回だけ**。カスタムシェーダの `uLinearOut` は後処理の持ち主が管理する
- 露出は明示的に持つ（今は `renderer.toneMappingExposure = 0.78` を ACES が暗黙に使っている）
- 魚・釣り人は MeshStandardMaterial（onBeforeCompile で魚のうねり）。**WebGL2 + onBeforeCompile の前提は崩さない**（WebGPU/TSL にはしない）
- 釣り人・竿は環境マップ無しの前提で metalness を下げてある。`scene.environment` を入れるなら水中では弱める
- ライト数や castShadow を実行中に変えると全マテリアルが再コンパイルされる。ライト構成は起動時に固定する
- ポーズ中：時計・波・天候・後処理の時間は止まる（sdt=0）。LOD は動いてよい

## 7. テスト

`node scripts/run-tests.mjs` の 35 本のうち：

- **KEEP（17 本）**：fishing-* / bite-timing / species-display / mp-* / othello-* / runtime-config / mixamo-retarget / cast-origin / gait。そのまま通す
- **MIXED**：`performance-test`（`addRT(game.env?.sun?.shadow?.map)` の文字列と estimateRtBytes の形）、
  `lake-calm-water-test`（前半の波の物理は残す、後半の正規表現は捨てる）、`walk-zone-test`（game.js の歩行とカメラの文字列、藪と blockedAt(y)）
- **GRAPHICS（15 本）**：water-spec / water-reflection / repeat-wrapping-detail / underwater-props / tree / lod-instances / water-plant /
  rock / ground-grain / land-texture / terrain-mesh / caustics-light / night-sky / undergrowth / shore-diorama-smoke。
  描画と一緒に消し、**新しい描画の純関数・契約のテストに置き換える**

新しく足すテスト：湖が変わっていないこと（`resolveLake(123456789).tries === 1`、`makeLake` 出力のハッシュ）、
配置レイヤーの決定性と品質非依存、当たりの寸法、`surfaceY` と GPU 変位の関数一致、天候の API。

## 8. 既知の罠

- `?v=` 付き import はクエリが違うと別モジュールになる。`installSingleRuntime.js` は `'../../sky.js'`（クエリなし）を読むので、
  game.js が同じ無印 URL で sky.js を読むと、今は効いていないプロトタイプ上書きが急に効き始める。**game.js は ?v= 付きのまま**にする
- WebGL2 の `MAX_TEXTURE_IMAGE_UNITS` は 16 の環境がある。超えるとリンクに失敗して地形が丸ごと消えるが例外は出ない。サンプラーは配列テクスチャにまとめ、上限を決める
- Float32 テクスチャの線形補間は `OES_texture_float_linear` が要る。無い環境では手で補間するか half float にする
- 品質 'mid' と 'medium' の食い違い（旧 terrainMesh）。キーは 'low'|'mid'|'high'
- 天候の見た目は damp（λ≈0.35/実秒）で遅れる。撮影では即時に反映する手段を用意する
- `captureReflection` の後、クリア色が 0x8fb8d8 のまま残っていた。新しいパイプラインはクリア色を毎パス明示する

## 9. 網羅性チェックで見つかった追加事項

- **歩ける範囲は ±220m をはみ出しうる**：汀線 88〜172m + `WALK_INLAND` 72m = 最大 244m。地形の高さキャッシュ・水面の範囲・近景の描画は
  `WATER_REGION` ではなく「汀線 + 72m（+ 視界の余裕）」を基準にする。MP のシードでは最大 218.5m
- **旧版の木と下草は影を落としていなかった**（影の更新が屈折キャプチャの中だけで、そこで木を隠していたため）。新版では影のパスを独立させ、木にも影を落とす
- **描画の例外は MP の同期まで止める**：game.update の描画は例外を再送出し、MP ラッパーの `sharedFish.update` `mp.sendVisual`
  `sendFightPosition` と `debug.update` `voice.update` が飛ぶ。新しい描画は **毎フレーム例外を出さないこと**（初期化の失敗は機能を落として続行）
- 糸の判定は呼び出し 3 か所とも `slack = 0.62`（たるみ最大 0.744m）。桟橋の判定はたるみ無しの直線。沈んだストラクチャーは水面より 0.5m 以上下なので、
  実際に効くのはデバッグの水中歩行と追従カメラだけ
- 追従カメラは桟橋をすり抜ける（`_camClear` は円柱の障害物しか見ない）。今と同じ挙動でよい
- レイヤー・`scene.environment`・`scene.background`・`envMap`・`onBeforeRender` は旧コードで一度も使われていない。除外は `visible` のリストだけ
- `applyQuality` の `o.material.needsUpdate = true` は配列マテリアルに効かない。マルチマテリアルを使うならここも直す
- `run-tests.mjs` は最初の失敗で止まる。グラフィックのテストが落ちると、後ろの KEEP テストが実行されない
- Terrain のコンストラクタが終わった時点で数学系の API がすぐ使えること（`_initMap` が直後に `shoreRadius` を 72×72 回呼ぶ）
- シングルで実際に動いている魚・天候のコードは `fish.js` と `sky.js` 側（`installSingleRuntime` のパッチは別インスタンスに当たっていて効いていない）。
  新しい `sky.js` でも、`tickWeather` の抽選は今の `sky.js:317-334` と同じ挙動にする
- `_updateFishing` は `water.update` より前に走るので、ウキの `surfaceY` は 1 フレーム前の `water.time` を使う。GPU で水面を進めるなら、この時刻のずれを意識する
