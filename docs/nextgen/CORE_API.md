# CORE_API（凍結：G0、2026-10-01）

描画の芯（`src/gfx/core/`）と、10 のモジュール（sky・water・underwater・terrain・trees・groundcover・shoreflora・hardscape・weatherfx・post）
の **境界の正本**。モジュール担当は **この文書と ARCHITECTURE.md §6 の自分の節だけ** を読めば仕事ができるように書いてある。
内容は G0 の時点の実際のコード（`git log` の bf2c428 以降）から起こした。

- ARCHITECTURE.md §4 と食い違うときは **この文書が優先**（実装に合わせて凍結した。違いは «§4 からの変更» に印を付けた）
- 凍結：名前・引数・戻り値の形・slot の番号・レイヤー・パス ID・services の項目は Phase 1 の間は変えない。
  変えたいときは `docs/nextgen/core-requests.md` に書く（統合者が Phase の境目でまとめて判断する。§17）
- 例は全部、動くコードとして `src/gfx/core/examples/exampleModule.js` と `lab/example.html` にある（§15）

---

## 目次

1. 規則（所有・コミット・禁止事項）
2. フレームの順序とパス
3. モジュールの契約（NgModule・ctx・f・失敗の扱い）
4. レイヤーとパスのマスク
5. ngFrame（共有の 24 vec4）
6. services（モジュール間の受け口）と、core が直接呼ぶ口
7. マテリアル：ngExtendStandard / ngShaderMaterial / ngCutout / ngAttachDepth
8. GLSL ライブラリ
9. パイプラインの共有 uniforms と RT
10. 高さ場・配置・湖のデータ
11. 品質（段・プロファイル・プログラムの上限）
12. 予算（GPU・CPU・読み込み・VRAM）
13. forge（起動時のテクスチャ合成）
14. 影・風・媒質・色の JS 側
15. 最小のモジュールの例
16. lab キットと撮影
17. 合格の証拠と、変更の要望

---

## 1. 規則

### 1.1 所有

| 触ってよい | 触らない |
| --- | --- |
| `src/gfx/<自分>/**`（`index.js` が固定の入口。`quality.js` に自分の品質表） | `src/gfx/core/**`（統合者だけ。要望は core-requests.md） |
| `lab/<自分>.html` | 他のモジュールの `src/gfx/<m>/**`・`lab/<m>.html` |
| `scripts/gfx/scenarios/<自分>-*.mjs` | `lab/_kit/**`・`scripts/gfx/shot.mjs`・`scripts/gfx/art-metrics.mjs`・`scripts/gfx/png.mjs` |
| 自分のテスト（`scripts/gfx-tests/<自分>-*.mjs`。run-tests への登録は統合者に頼む） | ファサード `src/sky.js` `src/terrain.js` `src/water.js` `src/postfx.js` `src/shaders.js`、`src/world/**`、`src/waveField.js` |
| trees だけ：`scripts/bake/trees/**`・`assets/gfx/trees/**`（≤ 3MB） | `src/game.js`（§5.4 の許可リストは消化済み） |

**絶対に変更しない（保護ファイル）**：`src/lakefield.js` `src/util.js` `src/data.js` `src/i18n.js` `src/locales/*` `src/fish.js` `src/angler.js`
`src/baitMesh.js` `src/fishTextures.js` `src/fishing/**` `src/multiplayer/**` `src/network/**` `worker/**` `src/ui.js` `src/save.js` `src/audio.js` `vendor/**`。

例外：underwater は `src/gfx/underwater/caustics.glsl.js`（CAUSTICS_GLSL の本体）を持つ。契約（§6.4）は変えない。

### 1.2 コミット

- 各自の git worktree・ブランチで作業。**こまめにコミット**（利用の上限でいつ止まってもよいように）：
  意味のまとまりごとに `git add <明示したパス>` → `git commit -m "<日本語のメッセージ>"`。`git add -A` / `.` は使わない
- 環境：`export PATH=/Users/apple/.nvm/versions/node/v22.17.0/bin:$PATH`（既定の node は v16）。テストは `node scripts/run-tests.mjs`（常に緑）
- push はしない（統合者がまとめる）

### 1.3 禁止事項とコードの規則

- **Math.random を src/world と src/gfx で使わない**（テストが grep する）。乱数は `src/world/rng.js`（`hash01(seed, i, j)`・`cellRng`・`mulberry32(stream(seed, name))`）か
  GLSL の `ngHash*`。見た目もマルチで一致させる
- **ネットワーク・CDN・第三者のアセット禁止**。テクスチャは forge で起動時に合成（§13）。オフラインの焼き込みは trees の幾何だけ
- **フレーム中に例外を投げない**。init で失敗するのは構わない（core がスタブへ戻す）が、update / prepare / beforePass / setQuality / services の関数は
  NaN・範囲外・null を自分で捨てる。投げたら 3 回で無効化される（§3.5）
- **NaN を出さない**：`ngFrame` に書く値・uniform・頂点の位置。GLSL の割り算と `pow` / `sqrt` / `log` / `normalize` は `max(·, ε)` で守る
- **識別子は ng 接頭辞**：GLSL の関数・uniform・varying・#define は `ng` / `NG_`（自分の名前空間を付けて `ngWater…` 等）。全体チャンクに入るものは特に。
  `uCaust*` `causticLight` `cs*` `csWave*` `vFishWorldPos` `uTime` `uAmp` `uFreq` `uLen` `uBend` は魚・caustics が使うので **全体の GLSL で宣言しない**
  （自分のマテリアルの中だけで使う uniform に `uTime` と付けるのは構わない。例のモジュールもそうしている）
- GLSL のライブラリは `#ifndef NG_LIB_X` のインクルードガードで包む（何度連結しても 1 回）
- **ngFrame の slot は «書く人» だけが書く**（§5）。他人の slot は読むだけ
- **ライトを足さない・castShadow を変えない**：光のリグ（太陽/月の DirectionalLight 1・LightProbe 1・灯籠の PointLight 1）は起動時に固定。
  品質で変えてよいのは uniform・ループの上限・インスタンスの本数・RT の大きさ
- **define を品質で増やさない**（プログラムが増える）。品質の差は uniform とループの上限で
- **サンプラーの上限**：1 プログラムの断片 ≤ 12・頂点 ≤ 4（§11.3）。配列マテリアル（`mesh.material = [...]`）は使わない
- three は vendored の r180（`import * as THREE from 'three'`、importmap 済み）。`ctx.THREE` を使ってもよい（同じもの）

---

## 2. フレームの順序とパス

### 2.1 game.js の順序（変えない）と、モジュールのメソッドが呼ばれる時

| 順 | game.js | core | モジュールに来るもの |
| --- | --- | --- | --- |
| 1 | `env.update(dt, hour, cam, focus)` | `gfx.beginFrame(...)`：frameIndex++、失敗したシェーダの差し替え、slot 14/15/11 を書き、**sky の `produce(input)`** で slot 0–7・12・13・17 と光のリグ（key の色・強さ・向き・影の追従・SH） | sky：`produce` |
| 2 | `terrain.updateWind` | `gfx.wind.update`（記録だけ） | — |
| 3 | `terrain.updateTrees(dt, camPos)` | `gfx.updateModules`：**全モジュールの `update(f)`**（`NG_MODULE_IDS` の順） | 全員：`update(f)` |
| 4 | `terrain.updateLamp(night, dt)` | `services.hardscape.setLamp(night, dt)` | hardscape |
| 5 | `water.update(sdt, cam, env)` | `gfx.waterUpdate`：水の時刻・風・波の位相（slot 14.y・19・20）、カメラ位置の水面と水中の度合い（slot 8 の材料）、**underwater の `waterUpdate(f)`** | underwater：`waterUpdate(f)` |
| 6 | `terrain.updateUnderwaterProps` | `gfx.setFlow`（f.flowDir / f.flowStrength） | — |
| 7 | fish / angler / HUD | — | — |
| 8 | `water.capture()` | `pipeline.prepare()`：RT の確保、**全モジュールの `prepare(f)`**、`addPreparer` の関数、高さ場影のスライス、**`beforePass(SHADOW)` → 近景の影マップ** | 全員：`prepare(f)`、`beforePass(2, cam)` |
| 9 | `water.captureReflection()` | `pipeline.renderReflection()`：**`beforePass(REFLECTION, 鏡映カメラ)`** → 反射 | `beforePass(1, mirror)` |
| 10 | `postfx.updateUnderwater` | — | — |
| 11 | `postfx.render(sdt)` | `pipeline.renderMain(dt)`：**`beforePass(MAIN, cam)`** → 不透明 → コピー → late → **post の `renderPost(targets, dt)`** | `beforePass(0, cam)`、post：`renderPost` |

- `prepare` / `renderReflection` は同じフレームで何度呼ばれても 1 回だけ働く（冪等）。呼ばれなければ `renderMain` が呼ぶ
- **`f.waterTime` / `f.waterWind` / `f.sdt` / `f.uw` は 5 で書かれる**。3 の `update(f)` で読むと **1 フレーム前** の値。
  水面の高さや波に合わせる物は **`prepare(f)` で受ける**（G0 で水のスタブの 1 フレーム遅れ ≈1mm を直した。core-requests G-4）
- ポーズ中は `f.dt = 0`（`f.paused = true`）。`update` にも `prepare` にも 0 が来る。時間で進む物（揺れ・粒・波紋の減衰・天候）は `f.dt` で進める。`f.envTime` もポーズで止まる。
  ポーズ中も動いてよいのは LOD の切り替えだけで、そのときは実時間の `f.realDt` を使う（**G0 後の修正**：以前は game.js の実時間の dt が `f.dt` を上書きしていた。smoke-all が検査する）

### 2.2 パス（P1–P7）

| # | パス | 描く先 | camera.layers | passId（slot 8.w） | 内容 |
| --- | --- | --- | --- | --- | --- |
| P1 | preparers | 各モジュールの RT | — | （モジュール次第） | `prepare(f)`・`addPreparer`・高さ場影のスライス（core） |
| P2 | 近景の影 | key の影マップ | 何も描かない tick カメラ（layer 31）。影に入れる物は `NG_MASK.SHADOW` で判定 | 2 SHADOW | three の影マップを 1 フレーム 1 回 |
| P3 | 反射 | `targets.refl`（RGBA16F、main × reflection.scale、mip） | `NG_MASK.REFLECTION` | 1 REFLECTION | 鏡映カメラ（y = 0 で折り返し、斜め近クリップ y = −0.03）。late 物体と `setReflectionHidden` の物を隠す。**水中（uw > 0.5）・湖面（±600m の箱）が画面外・low の奇数フレームは描かない**（前の絵、`ngReflValid` = 0 か前の値） |
| P4 | 不透明 | `targets.main`（RGBA16F、MSAA = profile.msaa、DepthTexture） | `NG_MASK.OPAQUE` | 0 MAIN | late 物体は隠す。空のドームは最後（renderOrder 1e9、depth = 1・LEQUAL） |
| P5 | コピー | `targets.copy`（MRT：sceneColor RGBA16F + 線形深度 R32F） | — | — | 全画面 1 パス（MSAA の resolve 後） |
| P6 | late | `targets.main`（同じ MSAA） | `NG_MASK.LATE` | 0 MAIN | 水面（renderOrder 1、NoBlending、depthWrite）→ 粒・雨・霧の板 → ゲームの半透明（波紋 3・糸 5・マーカー 6・名札 7・debug 900） |
| P7 | post | 画面 | — | — | post の `renderPost(targets, dt)`。post が無い・落ちたら core が簡易トーンマップで main を出す |

- ライトは毎フレーム `layers.enableAll()`（late のマスクで太陽が消えない）
- late 物体の判定（ゲームの物だけ。`userData.ngOwned` の物は対象外）：`transparent` か `depthTest === false` か `renderOrder >= 5`。
  ng の物で late に描きたい物は自分で WATER / LATE_FX / LATE の層に置く
- 各パスは `safety.guardPass(id, fn)` で包まれる（60 フレームで 2 回失敗したパスは止めて、30 フレーム後に試し直す。続けて落ちるたびに待ちを倍に、上限 600 フレーム。
  **G0 後の修正**：以前はセッション中止で、不透明パスが止まると世界の絵が固まった）。パイプラインは game へ例外を出さない
- render の «中» で呼ばれる関数（物体の `onBeforeRender` / `onAfterRender` / `onBeforeShadow` / `onAfterShadow`、マテリアルの `onBeforeCompile` / `onBeforeRender`、
  影の変種のマテリアルも）は core が毎フレームの走査で包む。投げても render は続き（その物体のその回の準備が欠けるだけ）、**持ち主のモジュール**（root `ng-<id>` の子孫）に
  guard と同じ 1 回が数えられる（3 回でスタブへ）。ゲームの物体なら警告だけ。包んでも `onBeforeCompile` のプログラムの鍵は元の関数のまま
- WebGL の文脈の喪失：描画を止める。復帰で core の RT が作り直され、**モジュールの `restoreGPU()`** が呼ばれる（自分の焼いた RT を焼き直す。
  喪失前の GL の物は dispose しない）

---

## 3. モジュールの契約

### 3.1 入口

```js
// src/gfx/<id>/index.js — いまは core のスタブを再 export している。担当者が中身を差し替える
export function createModule(ctx) { return new MyModule(ctx); }
```

- core は attachWorld の中で `import('src/gfx/<id>/index.js')` し、`createModule(ctx)` → `await m.init(progress)` →
  `m.setQuality(tier, profile)` → `m.setLodScale(k)` の順で起動する。**init が投げたら core のスタブで作り直す**（読み込みの失敗も同じ）
- `?ng=-trees,-groundcover` でモジュールを外せる（切り分け用）。sky と post は外すとスタブになる（必須）
- 起動の順と update の順：`NG_MODULE_IDS = ['sky', 'water', 'underwater', 'terrain', 'trees', 'groundcover', 'shoreflora', 'hardscape', 'weatherfx', 'post']`

### 3.2 NgModule（`src/gfx/core/module.js`）

```js
import { NgModule } from '../core/module.js';
class MyModule extends NgModule {
  static id = 'trees';                 // 必須。gfx.modules のキー、safety の数え上げ、シェーダの印に使う
  constructor(ctx)                     // super(ctx) で this.ctx と this.root（THREE.Group、name 'ng-<id>'、userData.ngOwned）。重い処理はしない
  async init(progress)                 // progress(0..1)。重い処理は分割して await（1 回 ≤ 30ms。ctx.forge.step() で譲る）。最後に ctx.scene.add(this.root)
  update(f) {}                         // CPU の毎フレーム（§2.1 の 3）
  prepare(f) {}                        // GPU の準備（P1）。水の値はここで受ける
  beforePass(passId, camera) {}        // 各パスの直前（passId = NG_PASS.SHADOW / REFLECTION / MAIN）
  setQuality(tier, profile) {}         // 段が変わったとき（と起動時に 1 回）。冪等に
  setLodScale(k) {}                    // LOD の倍率（既定 1）
  restoreGPU() {}                      // 文脈の復帰
  stats() { return { draws, tris, instances, texBytes, programs }; }
  dispose() {}                         // 既定：root を外して geometry を捨てる。マテリアル・RT は自分で
  root                                 // 自分の物体はすべてここ（?ng=-<id> と無効化で丸ごと隠れる）
}
```

core が **特定のモジュールにだけ** 直接呼ぶメソッド（§6.7）：sky の `produce(input)`、underwater の `waterUpdate(f)`、
post の `renderPost(targets, dt)` / `compile()` / `setSize(w, h)`。

### 3.3 ctx（`createModule(ctx)` の引数。**作った時点の写し**）

| キー | 型 | 中身 |
| --- | --- | --- |
| `THREE` | module | vendored の three r180 |
| `renderer` | WebGLRenderer | 共有。`toneMapping = NoToneMapping`、`shadowMap.type = PCFShadowMap`・`autoUpdate = false`、`outputColorSpace = SRGB` |
| `scene` | Scene | 自分の `root` を足す先 |
| `camera` | PerspectiveCamera \| null | 起動時のカメラ（null のことがある）。**毎フレームは `f.camera` を使う** |
| `tier` / `profile` | string / object | 起動時の段と core のプロファイル（§11）。**以後は `setQuality` の引数を使う** |
| `lake` | object | lakefield の湖（§10.4）。`lake.dock` / `lake.structures` / `lake.flats` / `heightAt` / `depthAt` / `shoreAtAngle` / `seed` |
| `terrain` | Terrain | ファサード（読むだけ）。読んでよい項目：`dockY`・`dockDir` / `dockStart` / `dockEnd` / `spawnPos`（Vector3）・`shoreR0`・`dockAngle`・`onDock` / `distToDock` / `dockBlocksSegment`・`heightAt` / `depthAt` / `isWater` / `normalAt` / `slopeAt` / `bedAt` / `shoreRadius`（lakefield）・`placement`・`structures`・`heightTexture`・`causticsUniforms`。**lab では同じ項目を持つ写し**（`makeLabTerrain`、`isLabFacade = true`。当たりと描画のフックは無い。G0 後の修正：以前の lab は null） |
| `heightfield` | HeightField | 高さ場の GPU テクスチャと CPU の双子（§10.1） |
| `placement` | Placement | 配置（§10.3）。**品質に依らない** |
| `frame` | NgFrame | ngFrame の書き込み口（§5）。`frame.data` が共有の Float32Array、`frame.cam.uw` / `frame.cam.waterY` |
| `wind` | Wind | 見た目の風の CPU 双子（§14.2） |
| `pipeline` | FramePipeline | `pipeline.uniforms`（§9）・`addPreparer`・`setRenderScale`・`targets`・`state` |
| `shadows` | Shadows | `shadows.uniforms`（高さ場影）・`shadows.key` |
| `forge` | Forge | 起動時の焼き込み（§13） |
| `workers` | null | 予約（Phase 1 では null。Worker が要るモジュールは自分で `new Worker(new URL('./x.js', import.meta.url), { type: 'module' })`） |
| `caustics` | object | causticsUniforms（16 個の `uCaust*` の `{value}`。魚と同じ参照。§6.4） |
| `services` | Services | モジュール間の受け口（§6） |
| `budget` | Budget | 計測（§16.4。lab 用） |
| `gfx` | Gfx | **読むだけの逃げ道**：`gfx.rig`（key / probe / lamp のライト）・`gfx.quality.profile`（今のプロファイル）・`gfx.f`・`gfx.msaa`・`gfx.targets`・`gfx.debugViews`。`_` で始まる物は触らない |
| `log` | (key, ...args) => void | レート制限つきの警告（同じ key は 10 秒に 1 回、`[ng] ` 付き） |

### 3.4 f（`update` / `prepare` / `waterUpdate` の引数。**毎フレーム書き換わる同じオブジェクト。保存しない**）

| キー | 型・単位 | 中身・書かれる時 |
| --- | --- | --- |
| `dt` | s | 環境の dt（beginFrame。ポーズで 0） |
| `realDt` | s | 実時間の dt（updateModules。**ポーズでも 0 にならない**。LOD の切り替えのような «止めなくてよい» 物だけ） |
| `sdt` | s | 水の dt（waterUpdate。ゲームの時間の倍率込み） |
| `envTime` | s | ポーズで止まる累積時間（slot 14.z と同じ） |
| `waterTime` | s | `water.time`（波の時刻。waterUpdate で更新。slot 14.y） |
| `waterWind` | 倍率 | ゲームの `water.wind`（1 + rain·0.92 + cloud·0.14。波の振幅に掛ける。**見た目の風 ngWindAt とは別物**） |
| `hour` | 0..24 | ゲーム内の時刻 |
| `camera` | Camera | 今フレーム描くカメラ |
| `camPos` / `focus` | Vector3 | カメラ位置 / 注視点（釣り人。影の中心） |
| `frameIndex` | int | フレーム番号（slot 14.w は % 1024） |
| `paused` | bool | dt === 0 |
| `uw` | 0..1 | 水中の度合い（> 0.5 で水中扱い） |
| `flowDir` / `flowStrength` | Vector2 / 0..1 | 水中の流れ。flowDir は **世界の xz の単位ベクトル**（`.x` = 世界 x、`.y` = 世界 z）。game.js は桟橋の向き（岸 → 湖心）、強さ 0.035 + water.wind·0.018（lab も同じ。`__lab.setFlow` で上書き）。**G0 後の修正**：以前は Vector3 の z が落ちて長さ 0.3 の x 軸になっていた |
| `keyDir` / `sunDir` | Vector3 | key（光の来る向き、昼 = 太陽・夜 = 月）/ 常に太陽 |
| `weather` | `{ key, cloud, rain }` | damp 済みの天候（clear 0.14/0、cloudy 0.72/0、rain 0.95/0.85 へ向かう） |
| `tier` | string | 今の段 |

### 3.5 失敗の扱い（safe.js）

- `update` / `prepare` / `beforePass` / `setQuality` / `setLodScale` / `stats` / `produce` / `waterUpdate` / `setSize` は `safety.guard` で呼ばれる。
  **3 回投げたらそのモジュールは無効化**（root を隠す）→ **core のスタブで立て直す**（スタブ自身が落ちたら 1 回だけ作り直す）。services も既定値に戻る
- post の `renderPost` は P7 の `guardPass('post')` の中（60 フレームで 2 回投げたらパスを止め、止めている間は core の簡易表示。間を空けて試し直す。post が無効化されてスタブで立て直されるとすぐ戻る）
- 描画の中の関数（§2.2）が投げた分も、そのモジュールの 3 回に数えられる
- services の関数は provide の時点で包まれる：投げたら既定値の関数の結果を返す（ファサードの 25 か所以上から呼ばれる）
- シェーダのリンクに失敗：`renderer.debug.onShaderError` がシェーダ先頭の印 `// ngmod:<id>:<key>` からモジュールを特定し、
  **次のフレームでそのモジュールの全マテリアルを MeshLambertMaterial に差し替える**（印は ngExtendStandard / ngShaderMaterial が自動で入れる。
  自前の RawShaderMaterial を使うときは先頭に `// ngmod:<id>:<key>` を自分で書く）
- 故障の注入の撮影（`scripts/gfx/scenarios/fault-inject.mjs`）が全モジュールで «フレームの完走・画面の維持・MP の後処理が走る» を確かめ、
  最後に描画の中の故障（ゲームとモジュールの物体の onBeforeRender / onBeforeCompile）で «パスが止まらない・持ち主だけがスタブへ» を確かめる

---

## 4. レイヤーとパスのマスク（`src/gfx/core/layers.js`）

```js
import { NG_LAYER, NG_MASK, ngOwn } from '../core/layers.js';
NG_LAYER = { DEFAULT: 0, WORLD: 1, NO_REFLECT: 2, UNDERWATER: 3, WATER: 4, LATE_FX: 5, LATE: 6, FAR: 7, SHADOW_ONLY: 8 }
NG_LAYER_SHADOW_TICK = 31   // core 専用（何も置かない）
```

| マスク | 層 | 使うパス |
| --- | --- | --- |
| `NG_MASK.OPAQUE` | 0, 1, 2, 3, 7 | P4 不透明 |
| `NG_MASK.REFLECTION` | 0, 1, 7 | P3 反射 |
| `NG_MASK.LATE` | 4, 5, 6 | P6 late |
| `NG_MASK.SHADOW` | 0, 1, 7, 8 | P2 近景の影（影に入れる物の判定） |
| `NG_MASK.PROBE` | 7 | 予約 |

| 置き場所 | 反射 | 屈折（sceneColor） | 近景の影を落とす | 例 |
| --- | --- | --- | --- | --- |
| WORLD | ○ | ○ | ○（castShadow なら） | 地形・木・桟橋・岩・空のドーム |
| NO_REFLECT | × | ○ | × | 草・小物・lab のチャート |
| UNDERWATER | × | ○ | × | 湖底の小物・藻・沈み岩・立ち枯れ（水上のカメラからは屈折で見える） |
| FAR | ○ | ○ | ○ | 遠景の稜線・樹冠シェル |
| SHADOW_ONLY | × | × | ○ | 影だけ落とす代理（樹冠シェルの影など） |
| WATER | × | ×（late） | × | 水面 |
| LATE_FX | × | ×（late） | × | 雨・霧の板・しぶき・粒・蛍 |
| LATE | × | ×（late） | × | ゲームの半透明（core が自動で付ける。ng の物は使わない） |

- **ng の物は layer 0 を外して自分の層へ**：`ngOwn(obj, NG_LAYER.WORLD)`（子孫すべての `layers.set(layer)` と `userData.ngOwned = true`）。
  子を後から足したら `ngOwn` をもう一度。ゲームの物は layer 0 のまま（raycast を変えない）
- 影を落とす物は `castShadow = true` と SHADOW のマスクに入る層（0/1/7/8）の両方が要る
- `terrain.underwaterProps.group` は空のダミー（game.js が水上で visible=false にする）。水中の物は UNDERWATER 層に
- パス ID（`import { NG_PASS } from '../core/frame.js'`）：`MAIN 0, REFLECTION 1, SHADOW 2, HF_SHADOW 3, BAKE 4, PROBE 5`。
  GLSL では `ngPassId` と `NG_PASS_MAIN` … の #define。`beforePass` に来るのは 2・1・0（P2・P3・P4/P6）。
  BAKE は `forge.renderView` の間（媒質を掛けない）、HF_SHADOW・PROBE は予約

---

## 5. ngFrame（`src/gfx/core/frame.js`）

`ngFrameData = new Float32Array(4 × 24)`。全 ShaderLib（fogColor を持つもの：basic・lambert・phong・standard・physical・toon・matcap・points・
dashed・sprite）と ng のマテリアルが **同じ参照** を `uniform vec4 ngFrame[24]` として持つ。GLSL の名前は下の #define（`NG_FRAME_GLSL` が生成。
マクロなので **同じ名前のローカル変数を書かない**）。

| slot | 成分 → GLSL の名前 | 単位・意味 | 書く人 |
| --- | --- | --- | --- |
| 0 | xyz `ngKeyDir`, w `ngNight` | key の向き（光へ向かう単位ベクトル。昼 = 太陽、太陽高度 −1° 未満で月）、nightAmount 0..1 | sky |
| 1 | xyz `ngKeyRad`, w `ngSinSunAlt` | key の地表放射照度 rgb（ng 単位、雲で減光済み。快晴の南中 ≈ 3.0）、sin(太陽高度) | sky |
| 2 | xyz `ngSunDir`, w `ngMoonIllum` | 太陽の向き（常に太陽）、月の照度係数 | sky |
| 3 | xyz `ngSkyIrr`, w `ngCloudiness` | SH0 の空の照度 / π（rgb、放射輝度の平均）、雲量 0..1 | sky |
| 4 | xyz `ngBetaR`, w `ngHR` | Rayleigh 散乱係数 rgb（1/m、霧の倍率込み）、スケール高（m） | sky |
| 5 | xyz `ngBetaM`, w `ngHM` | Mie 散乱係数 rgb（1/m）、スケール高（m） | sky |
| 6 | x `ngMistDensity`, y `ngMistBaseY`, z `ngMistH`, w `ngMieG` | 朝霧の密度（1/m）・基準 y（m）・スケール高（m）、Mie の g | sky |
| 7 | xyz `ngInscatterAmb`, w `ngMistAmb` | 環境内散乱の放射輝度 rgb（地平線の自動整合）、朝霧の環境光の上乗せ | sky |
| 8 | x `ngUwStrength`, y `ngCamWaterY`, z `ngCamHeight`, w `ngPassId` | 水中の度合い、カメラ位置の水面 y（m）、カメラの水面からの高さ（m）、パス ID | core（パスごとに書き換え） |
| 9 | xyz `ngSigmaA`, w `ngSigmaS` | 水の吸収 σa rgb（1/m、既定 0.20, 0.075, 0.045）、散乱 σs（既定 0.03） | underwater |
| 10 | xyz `ngWaterInsc`, w `ngTurbidity` | 水の内散乱の放射輝度 rgb、濁り | underwater |
| 11 | xy `ngWindDir`, z `ngWindSpeed`, w `ngGustAmp` | 見た目の風向（xz の単位ベクトル）、風速 m/s（clear 1.4 / cloudy 3.0 / rain 5.0）、突風の振幅 | core（wind） |
| 12 | x `ngWet`, y `ngRain`, z `ngPuddleAmt`, w `ngSeason` | 濡れ 0..1、雨 0..1、水たまり 0..1、季節 0..1（既定 0.42 = 初夏） | sky |
| 13 | xy `ngCloudShOffset`, z `ngCloudShInvScale`, w `ngCloudShStrength` | 雲影のオフセット（m）、1/スケール（1/m）、強さ | sky |
| 14 | x `ngHour`, y `ngWaterTime`, z `ngEnvTime`, w `ngFrameIndex` | 時刻 h、water.time（s）、envTime（s、ポーズで止まる）、frameIndex % 1024 | core |
| 15 | xyz `ngFocus`, w `ngLodScale` | 注視点（m）、LOD 倍率 | core |
| 16 | x `ngExposure`, y `ngInvExposure`, z `ngEV100` | 露出、1/露出、EV（正午基準の −log2 露出） | post |
| 17 | x `ngCloudCover`, y `ngCloudBase`, z `ngCloudTop`, w `ngCloudPhase` | 雲の被覆 0..1、雲底 m、雲頂 m、雲の流れの位相 | sky |
| 18 | x `ngVolEnd`, y `ngLakeRadius`, z `ngNearShadowR` | フロクセルの区間境界（0 = 全区間を解析）、湖の平均汀線半径 m、近景の影の半径 m（段の extent） | core |
| 19 | xyzw `ngWavePhA` | 波 0–3 の位相 mod(water.time·ω_i, 2π)（JS の倍精度で計算） | core |
| 20 | x `ngWavePhB` | 波 4 の位相（yzw は予備） | core |
| 21–23 | — | 予備（core の承認で割り当て。要望は core-requests） | reserved |

JS から：

```js
import { NG, NG_PASS, NG_SLOTS, NG_FRAME_GLSL, ngFrameData } from '../core/frame.js';
ctx.frame.set(NG.W_SIGMA, a, b, c, s);      // 4 成分（有限値に丸める。NaN を入れない）
ctx.frame.setVec3(NG.KEY, vec3, w);         // xyz に {x,y,z} か {r,g,b}
ctx.frame.setComp(NG.EXPO, 0, exposure);    // 1 成分
ctx.frame.get(NG.KEY, 3);                   // 読む（F[slot*4 + c] と同じ）
```

slot の id：`KEY KEYRAD SUN AMB BETA_R BETA_M MIST INSC CAM W_SIGMA W_INSC WIND WEATHER CLOUDSH TIME FOCUS EXPO CLOUDS CORE WAVEPH_A WAVEPH_B`。
«書く人» の一意性は `scripts/gfx-tests/ngframe-layout.mjs` が検査する。

---

## 6. services と、core が直接呼ぶ口

`ctx.services.<提供者>.<項目>`。**提供者が居なくても既定値が返る**（関数は何もしない・中立の値）。提供は init の中で：

```js
ctx.services.provide('water', { addRipple: (x, z, size, dur) => this.addRipple(x, z, size, dur), detailTile: null, ... });
```

provide は既定値の上に重ねる（足りない項目は既定のまま）。関数は例外を握りつぶす包みになる。値（テクスチャ等）は参照のまま。
**使う側は毎回 `ctx.services.sky.skyViewTex` のように引き直す**（provide で項目のオブジェクトが差し替わる。無効化で既定へ戻る）。

### 6.1 sky（提供：sky）

| 項目 | 型・シグネチャ | 既定値 | 使う人 |
| --- | --- | --- | --- |
| `skyViewTex` | Texture（RGBA16F 推奨、緯度経度、**`ngSkyViewUV` の写像**、mip 付き） | 1×1 (0.2, 0.3, 0.5) | water・terrain・trees（空の鏡面 `ngSkySpecular`） |
| `skyViewMips` | number（最大の mip 段） | 0 | 同上（`ngSkyViewMips` uniform に入れる） |
| `transmittanceTex` | Texture（大気の透過 LUT） | 1×1 白 | water・post |
| `cloudPanoTex` | Texture（上半球の雲パノラマ。rgb = 雲の内散乱、a = 透過） | 1×1 (0,0,0,1)（雲なし） | water（反射の外れ）・post |
| `sampleSky(dir)` | `({x,y,z}) → [r,g,b]` 放射輝度（露出前） | slot 3 の rgb | CPU の色合わせ |
| `keyColor` | THREE.Color（key の色、正規化） | 白 | trees（透過）など |
| `cloudShadowAt(x, z)` | `→ 0..1`（1 = 日向。ngCloudShadow の CPU 双子） | 双子の式 | キャラクター用の key 減光・CPU の判断 |

**sky の producer（core が毎フレーム直接呼ぶ）**：`produce(input) → result`。init の前にも呼ばれうる（スタブが代わりに動く）。

```js
input  = { dt, hour, camera, focus, weather: { key, cloud, rain }, nightAmount, sunDir /*Vector3*/, keyDir /*旧版の判定。使わない*/, envTime }
result = {
  colors: { sunColor, zenithColor, horizonColor, fogColor },   // THREE.Color。露出を掛けた «見た目の» 線形色（ファサードの互換）
  fog:    { near, far, color },                                 // near/far は core が媒質の双子で上書きする
  key:    { color /*THREE.Color 正規化*/, intensity /*ng 単位*/ },// core が DirectionalLight へ写す
  sh:     THREE.SphericalHarmonics3,                            // core が LightProbe.sh へ写す（放射輝度の SH、地面の照り返し込み）
  keyDir: [x, y, z],                                            // 影・caustics・env.keyDir に使う «実際の» key の向き
}
```

- produce は slot 0–7・12・13・17 を書く（§5）。key は太陽高度 −1° で月に切り替え（交差点で強度 0）。SH は 0.25s ごと **と時刻の跳び（> 0.05h）・天候の即時切り替え** で射影し直す
- sunDir・nightAmount は旧式の純関数（変えない）：`a = ((h−6)/24)·2π`、`sunDir = normalize(cos a, sin a, 0.34)`、`nightAmount = smoothstep(0.08, −0.16, sunDir.y)`

### 6.2 water（提供：water）

| 項目 | シグネチャ | 既定 | 呼ぶ人 |
| --- | --- | --- | --- |
| `addRipple(x, z, size, dur)` | size m（ファサードが 0.01–50 に丸める）、dur s（≤ 30） | 何もしない | ファサード（ゲームのウキ・魚・着水）・weatherfx・hardscape |
| `addSplash(x, y, z, count, power)` | count 0–256 の整数、power 0–20 | 何もしない | ファサード |
| `addImpulse(x, z, amp)` | 波紋シミュへの点の衝撃（雨粒など） | 何もしない | weatherfx |
| `addDamper(list)` | `list: Array<{x, z, r}>`（m。杭・茎・岩の円。波紋シミュの減衰体。**G0 で決めた形**） | 何もしない | shoreflora・hardscape（init の後で 1 回） |
| `detailTile` | `{ tex /*周期 FFT の高さ・勾配の配列テクスチャ（層 = 時刻のフレーム）*/, period /*タイルの一辺 m*/, frames, loopSec }` または null（**G0 で決めた形**。足りなければ water と underwater で相談して core-requests へ） | null（機能なし） | underwater（caustics） |

**投げない・NaN は捨てる**（ゲームから 25 か所以上）。リングバッファで受ける。

### 6.3 underwater（提供：underwater）

| 項目 | シグネチャ | 既定 | 使う人 |
| --- | --- | --- | --- |
| `getUnderwaterContext(camera)` | `→ { strength, time, sunDir, night, rain, cloud, absorb /*Vector3 = σa*/, camPos, camNear, camFar, waterY }`（同じオブジェクトを書き換えて返してよい） | ngFrame から組む core の代替 | ファサード（旧 `Water.getUnderwaterContext` と同じ形）・post |
| `createEffect()` | `→ pmndrs の Effect \| null`（水中の後処理。post が差し込む。下の «水中の Effect の約束»） | null | post |
| `optics` | `{ sigmaA: Vector3, sigmaS: number, insc: Vector3 }`（毎フレーム更新） | 既定の水 | water・post |

**水中の Effect の約束**（G0 後に決めた。post のスタブ `src/gfx/core/stubs/post.js` が実装の手本、core-robust の post-underwater が検査）：

- post は `ctx.services.underwater` の **オブジェクトが変わるたびに 1 回** `createEffect()` を呼ぶ（underwater の init で provide した後・
  underwater が無効化されて既定へ戻った後・スタブで立て直されて provide し直した後）。同じオブジェクトの間は呼び直さない。null なら差し込まない
- 差し込む位置は **HDR の鎖の先頭**：入力は露出前のリニアの放射輝度（ngFrame と同じ単位。`targets.main` の resolve 済みの色）。
  その後に露出 → AO・光芒・Bloom → グレード → AgX → ディザ（pmndrs は深度を使う Effect を前へ並べ替えるので、先頭なら深度の有無に依らない）
- post が渡す物：`mainCamera = ctx.gfx.camera`（その時点の描くカメラ）、`setDepthTexture(targets.main.depthTexture)`（RT を作り直したら渡し直す。
  BasicDepthPacking の非線形の深度。線形の m が要るなら `ctx.pipeline.uniforms.ngSceneDepth` を自分の uniform に）。毎フレーム `uw` などは自分で ngFrame / services から読む
- Effect は underwater の物：post は dispose しない（underwater の `dispose()` で捨てる）。水上（uw ≤ 0.5）でも鎖に居るので、
  水上では `mainImage` の早い return か `blendMode.opacity = 0` で 0 に近い重さにする（予算 §12：水上 0）

**underwater の waterUpdate（core が直接呼ぶ）**：`waterUpdate(f)`（`gfx.waterUpdate` の中、§2.1 の 5）。slot 9・10 と causticsUniforms の動く 6 つ
（`uCaustTime = f.waterTime`・`uCaustSunDir = keyDir`・`uCaustNight`・`uCaustRain`・`uCaustCloud`・`uCaustStrength = profile.causticsStrength`）を書く。

### 6.4 caustics の契約（underwater が持ち、魚・湖底・水中の物が共有）

- `src/shaders.js` が再 export：`CAUSTICS_GLSL`（本体は `src/gfx/underwater/caustics.glsl.js`）、`createCausticsUniforms()`、`updateCausticsTexture(u, img)`、`CAUSTICS_UNIFORM_NAMES`
- `vec3 causticLight(vec3 worldPos, vec3 viewNormal)`（加算の放射輝度）。`worldPos.y > −0.02` は 0。サンプラーは `uCaustTex`（sampler2DArray）だけ
- 16 名は固定：`uCaustTime uCaustSunDir uCaustNight uCaustRain uCaustCloud uCaustStrength uCaustTex uCaustScale uCaustShape uCaustRange uCaustDepth uCaustDist uCaustFar uCaustWarp uCaustMag uCaustMixW`
  （既定値 `uCaustWarp (1.15, 2.5)`・`uCaustFar (6, 20)` はテストが固定）
- `uCaustTex.value` の **テクスチャのオブジェクトは差し替えない**（魚のマテリアルが参照を握っている）。中身は `updateCausticsTexture(ctx.caustics, { data, width, height, depth })`
  （`forge.bakeArrayPixels` の戻り値をそのまま渡せる）。1 層のプレースホルダのうちは caustics = 0
- 魚は `#include <common>` の直後に CAUSTICS_GLSL を入れる（ngFrame の前）ので、**CAUSTICS_GLSL は ng のフレームやライブラリに頼らない**。`cs` 接頭辞は文字列の中だけ
- 検査：`scripts/gfx-tests/caustics-contract.mjs`

### 6.5 terrain（提供：terrain）

| 項目 | 型 | 既定 | 使う人 |
| --- | --- | --- | --- |
| `coverRules` | GLSL 文字列。`float ngGroundKind(vec3 p)` を定義する（地面の種類のコード：0 = 既定。値の割り当ては terrain が文書化して groundcover と合わせる） | `'float ngGroundKind(vec3 p) { return 0.0; }\n'` | groundcover（自分のシェーダに連結） |
| `farAlbedoTex` | Texture（2048² ±512m の上から見た地形 + 樹冠の色、uv = `ngFarMapUV(xz)`） | 1×1 (0.12, 0.13, 0.09) | groundcover・trees（遠景の色合わせ） |

### 6.6 trees / hardscape / post（提供：各モジュール）

| 項目 | 型・シグネチャ | 既定 | 使う人 |
| --- | --- | --- | --- |
| `trees.impostorBake` | `{ albedoTex, normalDepthTex, frames, size }`（半八面体のインポスターの配列テクスチャ。**G0 で決めた形**）または null | null | hardscape（立ち枯れ） |
| `hardscape.piles` | `Array<{ x, z, r }>`（m。桟橋の杭・係留杭の円） | `[]` | water（減衰体・接触の泡） |
| `hardscape.setLamp(night, dt)` | night 0..1、dt s（damp。ポーズで止まる）。灯籠の PointLight（`ctx.gfx.rig.lamp`、2200K、起動時は intensity 0・位置 (0, −1000, 0)）を `placement.lamp` の位置へ置き、強さを決める | 何もしない | ファサード（`terrain.updateLamp`） |
| `post.registerDebugView(name, glsl, uniforms?)` | glsl は `vec4 ngDebug(vec2 uv)` を定義する断片の部品。使える入力：NG_FRAME の #define、`ngSceneColor`・`ngSceneDepth`・`ngReflection`・`ngScreen`、渡した uniforms。出力はリニアの色（0..1、表示で sRGB） | core の登録表（lab の `view(name)`） | 全員 |

### 6.7 post の口（core が直接呼ぶ）

- `renderPost(targets, dt)`：P7。`targets.main`（resolve 済みの HDR）から **画面（render target null）** へ。水中エフェクト
  （`services.underwater.createEffect()`。§6.3 の約束：鎖の先頭・露出前）→ 露出（slot 16 を書く）→ AO・光芒・Bloom・グレード・AgX・ディザ → `profile.postAA`（'none' | 'smaa' | 'fxaa'）→ DRS のアップスケール。
  （**G0 後の変更**：以前の表は «露出 → 水中» の順だったが、pmndrs が深度を使う Effect を前へ並べ替えるので先頭に固定した）
  DRS は `ctx.pipeline.setRenderScale(s)`（`DrsController` が quality.js にある。`window.__gfxCapture` のときは 1.0 固定）
- `async compile()`（任意）：warmup の中で 1 回。自分のパスのプログラムを先に作る
- `setSize(w, h)`：描画バッファの大きさが変わった
- 読み込み中・失敗時は core が `main` を露出 × Reinhard で画面へ出す（黒い画面にしない）

---

## 7. マテリアル（`src/gfx/core/extend.js`）

### 7.1 ngExtendStandard（地形・木・草・桟橋・岩など、three の光・影・霧をそのまま使う物）

```js
import { ngExtendStandard, ngAttachDepth, ngCutout } from '../core/extend.js';
ngExtendStandard(mat /* MeshStandardMaterial | MeshPhysicalMaterial */, {
  key: 'trees-leaf',          // 必須。customProgramCacheKey = 'ng:' + module + ':' + key + ':' + tier（+ defines の指紋・caustics の印）。
                              // key はモジュールの名前空間の中。同じモジュールの同じ key = 同じ GLSL（違えば警告を 1 回）
  module: 'trees',            // シェーダの印 «// ngmod:trees:trees-leaf»（onShaderError の出どころ）
  uniforms: { ...ctx.heightfield.uniforms, uLeafTex: { value: tex } },   // 共有の {value} をそのまま（複製しない）
  defines: { NG_TREES_LEAF: 1 },                                            // 段で変えない
  vertex:   { pars, normal, begin, world },
  fragment: { pars, surface, alpha, rough, normal, emissive, lights, ao },
  caustics: true,             // CAUSTICS_GLSL を入れ、lights の後で totalEmissiveRadiance += causticLight(vNgWorld, normal) * ngKeyVis * ngNearVis
  depth: true,                // 影用の MeshDepthMaterial / MeshDistanceMaterial を同じ頂点の変形とアルファで作る（mat.userData.ngDepth / ngDistance）
  hfShadow: true,             // 近景の影の外で高さ場影（NG_HF_SHADOW。断片のサンプラー +2）
}) → mat
```

**口ごとに差し込まれる位置と、そこで使える変数**（vendored r180 の physical。アンカーは `scripts/gfx-tests/core-chunks.mjs` が検査）：

| 口 | 位置 | 使える・書く変数 |
| --- | --- | --- |
| `vertex.pars` | `void main()` の直前（`NG_FRAME_GLSL` が前に付く） | 関数・uniform・attribute・varying の宣言 |
| `vertex.normal` | `#include <beginnormal_vertex>` の後（begin より前） | `objectNormal`（オブジェクト空間、書いてよい） |
| `vertex.begin` | `#include <begin_vertex>` の後 | **`transformed`（オブジェクト空間の位置、書いてよい。ここが唯一の «動かす» 口）**、`position`、`normal`、`instanceMatrix`（InstancedMesh）、`uv`。影の変種でも同じ式が走る |
| `vertex.world` | `#include <worldpos_vertex>` の後 | `worldPosition`（vec4。影・環境マップがあるときだけ定義される。**読むだけ**：ここで動かしても gl_Position は変わらない） |
| `fragment.pars` | `void main()` の直前（fog の部品の後なので NG_FRAME の #define・`NG_MEDIUM_GLSL` の関数・`vNgWorld`・`vNgCloud` が使える） | 宣言 |
| `fragment.surface` | `#include <map_fragment>` の後 | `diffuseColor`（vec4、リニアのアルベド × α）、`vNgWorld`（世界座標）、`vUv` |
| `fragment.alpha` | `#include <alphamap_fragment>` の後（alphaTest の前） | `diffuseColor.a`。影の変種にも入る |
| `fragment.rough` | `#include <roughnessmap_fragment>` の後 | `roughnessFactor`（metalness は `metalnessFactor`。metalnessmap の後で上書きされるので注意） |
| `fragment.normal` | `#include <normal_fragment_maps>` の後 | `normal`（**ビュー空間**）。世界の法線が要るなら `inverseTransformDirection(normal, viewMatrix)` |
| `fragment.emissive` | `#include <emissivemap_fragment>` の後 | `totalEmissiveRadiance` |
| `fragment.lights` | `#include <lights_fragment_end>` の後 | `reflectedLight`（directDiffuse / directSpecular / indirectDiffuse / indirectSpecular）、`material`、`geometryNormal`、**`ngKeyVis`**（key の雲影 × 高さ場影）、**`ngNearVis`**（three の近景の影だけの比 0..1）、`totalEmissiveRadiance`。透過・空の鏡面・caustics をここで足す |
| `fragment.ao` | `#include <aomap_fragment>` の後（lights より後） | `reflectedLight.indirect*` の遮蔽 |

- 世界座標は **`vNgWorld`**（fog チャンクが渡す。instancing・鏡映カメラでも正しい）。雲影は **`vNgCloud`**（頂点で評価済み）
- key（平行光 0 番）には core が `ngKeyVis = vNgCloud × ngHfShadowAnalytic(vNgWorld)` を掛けている（hfShadow: true なら本物の高さ場影）。自分で掛け直さない
- 媒質（大気・水）は fog チャンクが `ngApplyMedium` で掛ける。**自分で霧を足さない**。`mat.fog` は true のまま、`scene.fog` は core が管理
- アンカーが無ければ **構築時に** 例外（three の版が変わったとき）。init の中で作ること（フレーム中に作らない）
- `depth: true` の影の変種に入るのは `vertex.pars / normal / begin` と `fragment.pars / alpha` だけ（worldpos は無い）。`frustumCulled` は自分で判断（頂点で大きく動かすなら false）
- 影の変種を mesh に付ける：`ngAttachDepth(mesh)`（map / alphaMap / alphaTest / side を写す。map を差し替えたらもう一度）
- 切り抜き（葉・草のカード）：`ngCutout(mat, profile, cutoff = 0.5)` を setQuality で呼ぶ。MSAA の段（high、2× 降格でも）は alpha-to-coverage、無い段は alphaTest。影は常に alphaTest。
  **A2C の段でも `alphaTest = cutoff` が残る**（three の A2C は `smoothstep(alphaTest, alphaTest + fwidth(a), a)` と «0 なら discard»）ので、
  MSAA の無い RT（反射 `targets.refl`・`forge.renderView` のインポスター）でも抜ける（**G0 後の修正**：以前は A2C で alphaTest = 0 にしていて、
  反射とインポスターでカードが四角く塗られた。core-robust の materials が検査）
- `mat.userData.ngTiered = true` が付く（段を替えると core が古い段のプログラムを手放す）
- **鍵の名前空間（G0 後の修正）**：以前の鍵は `'ng:' + key + ':' + tier` で module を含まず、trees と shoreflora が同じ `'leaf'` を使うと
  後から作った方が先の方のプログラム（GLSL と `ngmod` の印）を黙って共有した。今は module と caustics の有無が鍵に入る。
  同じ «module:key» を違う口の文字列・defines・uniforms の名前で作ると `[ng] ngExtendStandard: «module:key» が違う GLSL で作られた` と警告する

### 7.2 ngShaderMaterial（水・空・粒子のような自前シェーダ）

```js
import { ngShaderMaterial } from '../core/extend.js';
const m = ngShaderMaterial({
  key: 'water-surface', module: 'water',
  uniforms: { ...this.uniforms, ...ctx.heightfield.uniforms, ...ctx.shadows.uniforms, ...ctx.pipeline.uniforms },
  vertexShader, fragmentShader,
  lights: true,               // 既定 true：UniformsLib.lights を足す（three の光と影のチャンクを #include して使う）
  fog: true,                  // 既定 true：UniformsLib.fog
  defines, transparent, blending, depthWrite, side, ...           // 残りは ShaderMaterial へ
});
```

- 先頭に `// ngmod:<module>:<key>`・`#define NG_FRAME`・`NG_FRAME_GLSL`（両段）、断片には更に `NG_MEDIUM_GLSL` が入っている
- three が GLSL ES 3.00 で組む（`glslVersion` は指定しない。`in` / `out` / `texture` も `varying` / `gl_FragColor` / `texture2D` も使える）
- 媒質を通すには `#include <fog_pars_vertex>` / `<fog_vertex>`（`mvPosition` が要る。`vNgWorld`・`vNgCloud` を作る）と
  `#include <fog_pars_fragment>` / `<fog_fragment>`（`gl_FragColor.rgb = ngApplyMedium(...)`）。水面のように自分で区間を分けるなら fog_fragment を入れずに
  `ngApplyMedium` / `ngMediumTerms` を自分で呼ぶ（§3.4 の «各区間を 1 回だけ»：ARCHITECTURE §3.4 の表）
- 影を受けるなら `<common>` `<packing>` `<lights_pars_begin>` `<shadowmap_pars_vertex/fragment>` `<shadowmap_vertex>` `<shadowmask_pars_fragment>` を #include（水のスタブ `src/gfx/core/stubs/water.js` が完全な例）
- `customProgramCacheKey` は付かない（品質で GLSL を変えないこと）。段で変える物は uniform に

### 7.3 ngExtendContext（core が埋める。モジュールは読むだけ）

`{ caustics /*causticsUniforms*/, shadowUniforms /*shadows.uniforms*/, tier, lightsHook /*ngNearVis が使えるか*/ }`

---

## 8. GLSL ライブラリ（`src/gfx/core/glsl/*.glsl.js`）

文字列の定数を JS で連結して使う（`#include` ではない）。依存はそれぞれが中に含む（ガード付きなので重複してよい）。
**«要 NG_FRAME»** は ngFrame の #define を使うので、`NG_FRAME_GLSL` の後に置く（ngExtendStandard の pars・ngShaderMaterial では自動で満たされる）。
重さは全画面 2560×1440 を 1 回覆ったときの上乗せ（spikes.md S-3、M1 Pro）。

### 8.1 `frame.js` — `NG_FRAME_GLSL`

`uniform vec4 ngFrame[24];` と §5 の #define、`NG_PASS_MAIN` … `NG_PASS_PROBE`。ガード `NG_LIB_FRAME`。

### 8.2 `noise.glsl.js` — `NG_HASH_GLSL` / `NG_NOISE_GLSL`

| 関数 | 説明 |
| --- | --- |
| `float ngHash12(vec2)` / `float ngHash13(vec3)` / `vec2 ngHash22(vec2)` / `vec3 ngHash33(vec3)` | 浮動小数のハッシュ（Dave Hoskins）。0..1。JS 双子 `medium.js` の `hash12` |
| `float ngVNoise2(vec2)` | 値ノイズ 0..1（5 次補間） |
| `vec3 ngVNoise2D(vec2)` | 値ノイズと解析的な勾配：(値, ∂/∂x, ∂/∂y)。法線の細かい揺れを 1 回で |
| `float ngVNoise2P(vec2 p, vec2 period)` / `float ngVNoise3(vec3)` | 周期版 / 3D |
| `float ngGNoise2(vec2)` / `float ngGNoise2P(vec2, vec2 period)` | 勾配ノイズ（−1..1 付近） |
| `vec3 ngWorley2(vec2)` / `vec3 ngWorley2P(vec2, vec2 period)` | (最近点の距離, 2 番目, セルの乱数)。**0.90ms：焼き込み向き** |
| `float ngWorley3(vec3)` | 3D の最近点の距離 |
| `float ngFbm(vec2 p, int octaves)` / `float ngFbmP(vec2, vec2 period, int)` | fbm 0..1（octaves ≤ 8）。3 oct で 0.45ms |
| `float ngRidged(vec2 p, int octaves)` | 尾根ノイズ 0..1 |
| `vec2 ngWarp(vec2 p, float amp)` | ドメインワープ（Quilez） |

### 8.3 `medium.glsl.js` — `NG_CLOUD_GLSL` / `NG_MEDIUM_GLSL`（要 NG_FRAME）

| 関数 | 説明 | ms |
| --- | --- | --- |
| `float ngCloudCoverAt(vec2 xz)` / `float ngCloudShadow(vec3 P)` | 雲の被覆 / 雲影（1 = 日向。key の向きに雲底へ投影）。組込みは頂点で `vNgCloud` | 0.43 |
| `vec3 ngApplyMedium(vec3 L, vec3 P)` | 点 P の放射輝度 L に媒質（空気・水）を掛ける。カメラ × 点 × パスの区間分けは中で | 0.24（水上）/ 0.34（水中） |
| `void ngMediumTerms(vec3 P, out vec3 T, out vec3 Lin)` | 透過と内散乱（`L·T + Lin`） | |
| `void ngAirSegment(vec3 a, vec3 b, out vec3 T, out vec3 Lin)` / `void ngWaterSegment(…)` | 区間ごと（水面のシェーダが自分で分けるとき） | |
| `float ngAirOpticalDepth(vec3 a, vec3 b, float beta, float H)` | 高さ指数の閉形式 | |
| `vec3 ngDownwelling(float depth)` | 水中の点に届く下向き光（屈折した key の光路） | |
| `float ngPhaseR(float mu)` / `float ngPhaseHG(float mu, float g)` | 位相関数 | |
| `float ngLuminance(vec3)` / `float ngExpDiv(float)` / `float ngMistMask(vec2)` | 補助 | |
| `float ngHfShadowAnalytic(vec3 P)` | 高さ場影の代わり（NG_HF_SHADOW なら本物の `ngHfShadowFar`） | |

JS 双子：`src/gfx/core/medium.js`（`applyMedium(F, C, L, P)`・`mediumTerms`・`airSegment`・`waterSegment`・`downwelling`・`cloudCoverAt(F, x, z)`・`cloudShadow(F, P)`・
`fogNearFar(F, camPos)`・`solveInscatterAmb`）。式を変えたら両方（`scripts/gfx-tests/medium-twin.mjs`）。

### 8.4 `shadow.glsl.js` — `NG_SHADOW_GLSL`（要 NG_MEDIUM。uniforms は `ctx.shadows.uniforms`、サンプラー 2）

| 関数 | 説明 | ms |
| --- | --- | --- |
| `float ngHfShadow(vec3 P)` | 高さ場影（地形 + 樹冠を key 方向へ raymarch して焼いた 2 段：±256m / ±1024m。low は ±1024m のみ） | 0.21 |
| `float ngHfShadowFar(vec3 P)` | 近景の影の外だけ高さ場影（中は 1） | |
| `float ngNearToFar(vec3 P)` | 注視点から 0.8R〜R で 0 → 1（R = `ngNearShadowR`） | |
| `float ngSunVisibilityC(vec3 P, float nearVis, float cloud)` | 近景 → 高さ場をブレンドして雲影を掛ける。**fog チャンクのあるシェーダは `cloud = vNgCloud`** | |
| `float ngSunVisibility(vec3 P, float nearVis)` | 同じで雲影を断片で評価する版 | 0.47 |

uniforms：`ngHfShadow0`・`ngHfShadow1`（R8 相当、1 = 日向）・`ngHfShadowXf`（x = 1/(2·256)、y = 1/(2·1024)、z = 段 0 が有効なら 1）。
近景の影：three の DirectionalLight の影マップを PCF（core の `ngShadowPCF`：3×3 の二次 B スプライン、9 回の読み、半影 ≈1.5 テクセル）。

### 8.5 `heightfield.glsl.js` — `NG_HEIGHTFIELD_GLSL`（uniforms は `ctx.heightfield.uniforms`。サンプラー最大 6）

| 関数 | 説明 | ms |
| --- | --- | --- |
| `float ngTerrainH(vec2 xz)` | 地形の高さ m（near ±260m @0.5m と far ±512m @1m の手動バイリニア、near の縁 4m でブレンド。**CPU の `heightfield.heightAt` と同じ**）。頂点でも使える（サンプラー 2） | 0.26 |
| `float ngDepth(vec2 xz)` | 水深 = max(−ngTerrainH, 0) | |
| `vec3 ngTerrainN(vec2 xz)` | 地形の法線（世界、単位） | 0.14 |
| `float ngShoreD(vec2 xz)` | 汀線までの符号付き距離 m（陸 +、水 −。near の範囲 ±260m の外は縁の値。汀線が見つからない画素は ±300） | |
| `vec4 ngBed(vec2 xz)` | 底質（mud, sand, rock の重み, lake.bedAt の v）。**ゲームの bedAt と一致** | |
| `vec2 ngCanopyAt(vec2 xz)` | 樹冠（密度 0..1, 高さ / 40m）。±512m | |
| `vec4 ngCover(vec2 xz)` | 被覆の既定（草, 笹, シダ, 花の密度）。±260m。groundcover / terrain の coverRules が上書きする前提 | ShoreD+Bed+Canopy+Cover で 0.31 |
| `vec2 ngNearMapUV(vec2)` / `vec2 ngFarMapUV(vec2)` / `vec2 ngGridUV(vec4, vec2)` / `float ngGridH(…)` / `float ngNearInset(vec2)` | 写像の補助（`ngFarMapUV` は farAlbedoTex にも使う） | |

**サンプラーの名前（`ngNormalNear` 等）に頼らず関数だけを使う**（G0 で汀線距離を ngNormalNear.z、樹冠を ngNormalFar.zw に同居させた。また動かしうる）。
派生マップの範囲：`NG_HF_MAP = { nearOrigin: −260, nearSize: 520, farOrigin: −512, farSize: 1024 }`（heightfield.js）。

### 8.6 `wind.glsl.js` — `NG_WIND_GLSL`（要 NG_FRAME）

`vec4 ngWindAt(vec2 xz)` → (風向 xz の単位ベクトル, その点の風速 m/s, 突風の強さ 0..1)。38m と 13m の 2 オクターブの斑を風下へ流す。
水面の猫足・草の波・雨の傾き・霧の流れが全部これ。**頂点で評価できるなら頂点で**（断片 0.29ms）。JS 双子 `ctx.wind.sample(x, z)`。

### 8.7 `surface.glsl.js` — `NG_SURFACE_GLSL` / `NG_SKYSPEC_GLSL`（要 NG_FRAME）

| 関数 | 説明 | ms |
| --- | --- | --- |
| `void ngWetSurface(inout vec3 albedo, inout float rough, float porosity, float wet)` | 濡れ（多孔質ほど暗く、滑らかに）。`wet` には `ngWet` | |
| `float ngPuddle(vec2 xz, float slope)` | 水たまりの覆い 0..1（`ngPuddleAmt`） | |
| `vec2 ngRainRings(vec2 xz, float t, float rain)` | 雨の輪の勾配（dh/dx, dh/dz）。3 層のハッシュセル。`rain < 0.01` で即 0。水面・桟橋・岩・地形で共有 | 0.79（雨のときだけ） |
| `vec2 ngSkyViewUV(vec3 d)` / `vec3 ngSkyViewDir(vec2 uv)` | skyView の緯度経度の写像（**凍結**：u = 方位、v = 0.5 が地平・1 が天頂、仰角は √ で詰める） | |
| `vec3 ngSkySpecular(vec3 R, float rough)` | skyView を粗さで mip を選んで読む（`NG_SKYSPEC_GLSL`。uniform `ngSkyViewTex`・`ngSkyViewMips` を自分の uniforms に入れて毎フレーム services.sky から写す） | 0.21 |

### 8.8 `wave.glsl.js` — `NG_WAVE_GLSL`（要 NG_FRAME）

`waveField.js` の `waveGLSL({ prefix: 'ng' })` の «t·ω» を ngFrame の倍精度の位相（slot 19–20）に置き換えたもの。**水の高さ・勾配はこれだけを使う**（`waveGLSL` を直接使わない）。

| 関数 | 説明 |
| --- | --- |
| `float ngWaveH(vec2 p, float t)` | 縦の変位 m（wind = 1）。**表示の水面 = `ngWaveH(p, t) · wind · ngShoalGain(ngDepth(p))`（陸 = 0）**。CPU の `water.surfaceY` と同じ |
| `vec2 ngWaveD(vec2 p, float t)` | 勾配（dh/dx, dh/dz）。× wind × shoal |
| `vec2 ngWaveDisp(vec2 p, float t)` | 水平変位（見た目に使うなら法線だけで。GPU の水面は縦だけ動かす約束） |
| `float ngShoreRunUp(vec2 p, float t)` | 渚の遡上 m（+ 乗り上げ、− 引き波） |
| `float ngShoalGain(float depth)` | 浅水の振幅係数 |
| `float ngWavePhase(vec2)` / `vec2 ngWavePhaseGrad(vec2)` | 位相のずらし |

- **`t` には `f.waterTime`（= ngWaterTime）を prepare で uniform に入れて渡す**（`(t − ngWaterTime)` が 0 になり位相は倍精度のまま。G0 の読み戻しで high 0.26mm）
- `wind` は `f.waterWind`。JS：`import { wavePhases, NG_WAVE_PHASE_OK } from '../core/glsl/wave.glsl.js'`、波の CPU 側は `src/waveField.js`（`waveHeight(x, z, t, wind)`・`waveSlope`・`shoalGain`）
- 検査：`scripts/gfx-tests/wave-phase.mjs`・`wave-agreement-test.mjs`、本編の読み戻しは g0-gameplay

### 8.9 その他

| 定数（ファイル） | 関数 |
| --- | --- |
| `NG_OCT_GLSL`（oct.glsl.js） | `vec2 ngOctEncode(vec3 n)` → [0,1]²、`vec3 ngOctDecode(vec2 e)`（RGBA8 に法線を詰める） |
| `NG_HEXTILE_GLSL`（hextile.glsl.js） | `vec4 ngHexTile(sampler2D tex, vec2 uv, float rotStrength)`、`vec4 ngHexTileArr(sampler2DArray tex, vec2 uv, float layer, float rotStrength)`（Mikkelsen 2022。読み 3 回） |
| `NG_BLUENOISE_GLSL`（bluenoise.glsl.js） | `uniform sampler2D ngBlueNoiseTex;`、`float ngBlueNoise(vec2 fragCoord, float frameIndex)` → [0,1)（テクスチャは `await ctx.forge.blueNoise()`） |
| `CAUSTICS_GLSL`（shaders.js） | §6.4 |
| chunks（自動） | `vNgWorld`（varying、世界座標）・`vNgCloud`（varying、雲影）・`ngKeyVis` / `ngNearVis`（lights の後）・`ngShadowPCF` |

---

## 9. パイプラインの共有 uniforms と RT（`ctx.pipeline`）

`ctx.pipeline.uniforms`（`{value}` は RT を作り直しても同じオブジェクト。自分の uniforms に `...ctx.pipeline.uniforms` で入れる）：

| uniform | 型 | 中身 |
| --- | --- | --- |
| `ngSceneColor` | sampler2D | 不透明の写し（RGBA16F、リニアの HDR、露出前。high は mip 4 段 = `ngCopyMips`。low は半解像度） |
| `ngSceneDepth` | highp sampler2D | 不透明の **線形深度 m**（R32F、Nearest。空 = camera.far） |
| `ngReflection` | sampler2D | 反射（RGBA16F、mip。a = 0 は何も写っていない画素 → skyView で補う） |
| `ngReflMatrix` | mat4 | 世界座標 → 反射 RT の uv（射影テクスチャ。`q = M·vec4(P,1); uv = q.xy/q.w`） |
| `ngReflValid` | float | 1 = 今フレームの反射が有効（水中・画面外・low の隔フレームで 0 か前の値） |
| `ngScreen` | vec4 | (mainRT の幅, 高さ, 1/幅, 1/高さ) px |
| `ngCopyMips` | float | sceneColor の mip 段数 |

- `ctx.pipeline.targets`：`main`（WebGLRenderTarget、samples = profile.msaa、`depthTexture`）・`copy`（`textures[0]` sceneColor、`textures[1]` 線形深度）・`refl`
- 大きさ = 描画バッファの物理 px × DRS の倍率（`pipeline.renderScale`、0.5–1.0）。毎フレーム必要なら作り直す
- `ctx.pipeline.addPreparer(id, fn, budgetMs)`：P1 に毎フレームの関数を足す（guardPass で包まれる）。モジュールは普通 `prepare(f)` で足りる
- `ctx.pipeline.state`：`{ frameIndex, underwater, reflectionEnabled, prepared, reflected, rendered, lost }`（読むだけ）
- sceneColor を読むのは late の物（水面・粒）だけ。不透明の物が読むと 1 フレーム前の絵になる

---

## 10. 高さ場・配置・湖のデータ

### 10.1 HeightField（`ctx.heightfield`、src/gfx/core/heightfield.js）

| メンバ | 型 | 中身 |
| --- | --- | --- |
| `uniforms` | object | `ngHeightNear` `ngHeightFar`（R32F・Nearest DataTexture）、`ngNormalNear`（RGBA16F：oct 法線 xy・汀線距離 z）、`ngNormalFar`（RGBA8：oct 法線 xy・樹冠 zw）、`ngBedMap`（RGBA8）、`ngCoverMap`（RGBA8）、`ngHfNear` `ngHfFar`（vec4：origin.x, origin.z, 1/step, n）、`ngHfMapXf`（vec4：near の原点, 1/near の幅, far の原点, 1/far の幅）。build の前は 1×1 の中立値 |
| `heightAt(x, z)` | number m | **GPU の `ngTerrainH` と同じ補間** の CPU 双子（描画の高さ合わせに使う。ゲームの当たりは `terrain.heightAt`） |
| `grids` | object | `{ near: { data: Float32Array, n: 1040, origin: [−260, −260], step: 0.5 }, far: { n: 1024, origin: [−512, −512], step: 1.0 }, bed: { data: Uint8Array RGBA, n: 260, origin: [−260, −260], step: 2.0 }, hash }`。格子点 k は x = origin + k·step、行は z（`data[iz·n + ix]`） |
| `maps` | `{ shore, canopy }` | 同居させる前の派生（lab の表示用） |
| `ready` | bool | 構築済み |

- `terrain.heightTexture` は `ngHeightNear` のテクスチャ。歩ける帯で «描画の高さと heightAt の差 < 2cm» が terrain の合格条件
- 底質の値は `lake.bedAt` と一致（`src/world/heightgrid.js` の `bedWeights(v)`）

### 10.2 湖と桟橋（`ctx.lake`、lakefield。保護ファイル。読むだけ）

- `lake.seed`（u32）、`lake.heightAt(x, z)` / `depthAt` / `slopeAt` / `bedAt(x, z) → { v, kind }` / `shoreAtAngle(a)` / `noise.fbm(x, z, oct)`
- `lake.dock`：`{ start: {x,z}, end: {x,z}, dir: {x,z}, … }`（桟橋の付け根・先端・向き）。寸法は `src/world/dock.js`：`DOCK_W = 3.4`（床幅）、`DOCK_HALF_W = 1.62`（歩ける半幅）、
  床の上面 = `terrain.dockY`、杭 2.4m 間隔、先端 2.3m の手すり。`makeDock(lake)` / `dockLocal` / `onDock` / `distToDock` / `dockBlocksSegment`（**当たりと同じ箱に収めること**）
- `lake.structures`：`[{ x, z, depth, kind: 'rock' | 'snag', h, r, rot, v }]`（沈み岩と立ち枯れ。見た目は x, z, rot, h, r に正確に）
- `lake.flats`：`[{ x, z, r, angle, inset, amp, main }]`（藻場の円。沈水植物で覆う）

### 10.3 Placement（`ctx.placement`、src/world/placement.js。**seed だけから決定的・品質に依らない**）

```js
Placement = {
  seed,
  trees: { count, x, z, y, h, species, variant, rot, lean, rank, collide, mustDraw, zone, r, top, bandD },  // SoA（各 Float32Array[count]）
  boulders:  [{ x, z, y, size, sx, sy, sz, rot, shape /*0..11*/, rank, collide, r, top }],
  cobbles:   [{ x, z, y, size, sx, sy, sz, rot, shape, rank }],
  thicket:   [{ x, z, y, height, variant, rot, r /*0.55*/, top, collide /*1*/, rank }],
  reeds:     [{ x, z, y /*= −depth*/, depth, kind /*0 ヨシ・1 マコモ*/, height, density, rot, rank }],
  lilies:    [{ x, z, depth, spread, rot, flower /*0|1*/, rank }],
  weeds:     [{ x, z, y /*= −depth*/, depth, height, rot, rank, flat /*lake.flats の番号*/ }],
  driftwood: [{ x, z, y, len, radius, rot, rank }],
  structures /* = lake.structures */, lamp: { x, z, r: 0.26, top, baseY }, boat: { x, y, z, yaw, circles: [{ x, z, r, top }] },
  dock: { yaw, dir, right }, ecology /* 生態の場のパラメータ（植林区画など） */, hash, stats,
}
```

| フィールド | 単位・意味 |
| --- | --- |
| `x, z` | m（世界）。`y` = 根元 / 底面の高さ m（木は地面 − 0.15、岩は沈めた底面、水草は湖底） |
| `h` | 樹高 m。`species` は `SPECIES_IDS` の番号（0 sugi・1 hinoki・2 buna・3 mizunara・4 momiji・5 akamatsu・6 yanagi・7 hannoki）、`variant` 0..3 |
| `rot` | rotation.y（rad）。`lean` = rot を向けた後のローカル +Z への傾き rad（世界の方向 (sin rot, cos rot) へ倒れる） |
| `rank` | 0..1。見た目の間引き：`isVisible(system, rank, tier, must)`（`TIER_DENSITY`：trees 0.22 / 0.55 / 1.0、boulders・cobbles 0.4 / 0.7 / 1.0、reeds・lilies・weeds 0.2 / 0.5 / 1.0、driftwood 0.5 / 0.8 / 1.0、thicket 1.0）。**入れ子**（low ⊂ mid ⊂ high） |
| `collide` / `r` / `top` | 当たりあり（全品質で同一）/ 当たりの半径 m / 上端の y m（幹 r = max(trunkR·h·1.15, 0.28)、top = y + 0.9h。大岩 r = 見た目の半径 × 1.05） |
| `mustDraw` | 1 = **全品質で必ず描く**（歩ける帯 + 12m の当たりのある木。見えない幹を作らない） |
| `zone` | 0 汀（**汀線から 20m・標高 5m 未満の最初の列**、ヤナギ・ハンノキ。core-requests B-7）・1 下部広葉樹・2 植林・3 混交・4 尾根 |
| `bandD` | 歩ける帯からの距離 m |
| 岩の見た目 | 底面中心が原点、半径 0.40·size·(sx, sz)、高さ size·sy |

- 樹種の寸法：`src/world/species.js` の `SPECIES`（heights・trunkR[4]・crownR・crownBase・leaf / bark の線形アルベド・stiffness）・`trunkCollider()`
- 当たりの一覧（ゲームの障害物）は `obstacleList(P, q)`。**描画は当たりに合わせる**（trees：幹の見た目 × 1.15 と当たりの差 ≤ 5%、hardscape：debug.js の箱と 2cm 以内）
- 葦際：`isEdge(x, z, q)`（水深 (0.05, 1.5] かつ汀線まで < 12m）。`WALK_INLAND = 72`、`FAR_GATE = 20`、`MUST_DRAW_GATE = 12`、セル `CELLS = { tree: 4.2, rock: 9, cobble: 3.5, reed: 0.9, lily: 1.6, weed: 1.3 }`

### 10.4 CPU の高さを使い分ける

| 使い道 | 関数 |
| --- | --- |
| GPU の地形と同じ高さに物を置く（描画） | `ctx.heightfield.heightAt(x, z)` |
| ゲームの当たり・歩ける高さ（変えない） | `ctx.terrain.heightAt` / `ctx.lake.heightAt` |
| 水面（波込み） | `waveHeight(x, z, f.waterTime, f.waterWind) * shoalGain(depth)`（depth ≤ 0 は 0）= `water.surfaceY` |

---

## 11. 品質

### 11.1 段とプロファイル（`src/gfx/core/quality.js`）

段のキーは `'low' | 'mid' | 'high'`（セーブ互換）。`setQuality(tier, profile)` の `profile` は core の表 `NG_TIERS[tier]`（high は MSAA の降格を反映した写し）：

| フィールド | low | mid | high | 意味 |
| --- | --- | --- | --- | --- |
| `pixelRatioMax` | 1 | 1.5 | 2 | 既存の上限 |
| `drs` | [0.6, 1.0] | [0.75, 1.0] | [0.7, 1.0] | 動的解像度の範囲（post の DrsController） |
| `hdr` | true | true | true | mainRT を RGBA16F（無ければ RGBA8） |
| `msaa` | 0 | 0 | **4（実測で 2 に降格しうる）** | mainRT の MSAA。**ここを見る**（>0 なら A2C を使える） |
| `postAA` | 'fxaa' | 'smaa' | **'none'（降格で 'smaa'）** | post の AA。**決め打ちしない** |
| `copyScale` / `copyMips` | 0.5 / 0 | 1 / 0 | 1 / 4 | sceneColor の解像度と mip |
| `nearShadow` | { 1024, ±30m, 1.5 } | { 2048, ±40m, 1.75 } | { 3072, ±48m, 2 } | `{ size, extent, radius }`（radius は degraded のときだけ） |
| `hfShadow` | { levels 1, 512 } | { 2, 1024 } | { 2, 1024 } | 高さ場影 |
| `reflection` | { 0.25, everyOther, lodBias 1, mips 3 } | { 0.5, false, 1, 4 } | { 0.6, false, 0, 5 } | `{ scale, everyOther, lodBias, mips }`。**反射の LOD +lodBias 段はモジュールが beforePass(REFLECTION) で行う** |
| `causticsStrength` | 0.32 | 0.72 | 1.0 | underwater が uCaustStrength に入れる |

- **各モジュールは自分の表を `src/gfx/<m>/quality.js` に持つ**（ARCHITECTURE §7 の自分の行：本数・距離・RT の大きさ・ループの上限）
- setQuality は «部分集合の作り直しと RT の再確保» だけ。ライト数・castShadow は変えない。同じ段で何度呼ばれてもよい（起動時に 1 回、段の切り替え、MSAA の降格で high のまま 2 回目が来る）
- 段を替えると core が ngExtendStandard の古い段のプログラムを手放す（`userData.ngTiered`）。自前のマテリアルで同じことをしたいなら setQuality で `dispose()`
- MSAA の降格（spikes.md S-1）：high に入った最初の機会に 1 回だけ実測し、4× − 2× の上乗せ > 0.9ms なら 2× + SMAA。`ctx.gfx.msaa` で判定が見える。`?msaa=4` / `?msaa=2` で上書き
- LOD 倍率 `setLodScale(k)`（slot 15.w にも入る）。距離の閾値に掛ける

### 11.2 NG_PROGRAM_BUDGET（**§4 からの変更**：総数 60 → 90）

```js
import { NG_PROGRAM_BUDGET } from '../core/quality.js';
NG_PROGRAM_BUDGET = { total: 90, perModule: 6, samplers: { frag: 12, vert: 4 } }
```

- `total`：1 つの段・影ありで同時に生きているプログラムの総数（ゲームの釣り人・魚・UI・影の変種を含む。G0 の本編の起動時は全スタブ込みで 31–34 本、smoke-all の最後で 50 本）
- core は `renderer.compile` を mainRT に束縛して包んでいる（画面向けの余分なプログラムを作らない）。自分で `compile` を呼ぶ必要は無い（warmup が全部を先にコンパイルする）
- `perModule`：**1 モジュールが 1 つの段で持つプログラム ≤ 6**（影の depth / distance の変種も 1 本と数える。同じ key のマテリアルは 1 本を共有する）
- 数え方：`__lab.programAudit().byModule`（シェーダの印の id ごと）。example-smoke が雛形（§16.3）

### 11.3 サンプラー

- 1 プログラム：断片 ≤ 12・頂点 ≤ 4（`MAX_TEXTURE_IMAGE_UNITS` が 16 の環境を守る）。three が足す物（影マップ 1 枚 / 影のある平行光、map・normalMap など）も数に入る
- 主な消費：heightfield ライブラリ 最大 6（頂点で ngTerrainH だけなら 2）、hfShadow +2、caustics +1、skySpecular +1、pipeline（sceneColor・sceneDepth・reflection）+3
- 検査：`__lab.programAudit()`（全プログラムの能動なサンプラーを数える。`over` が空であること）

---

## 12. 予算

### 12.1 GPU（ARCHITECTURE §6・§7 のまま。Phase 1 の合格条件）

| モジュール | high（2560×1440、M1 Pro） | mid（1080p） | low | 内訳・注 |
| --- | --- | --- | --- | --- |
| sky | main 0.70・反射 0.25・LUT 0.05（計 1.00） | 0.50 / 0.15 | 0.25 / 0.10 | CPU ≤ 0.3ms、読み込み ≤ 200ms |
| water | 水面 1.10（波紋込み）+ しぶき ≤ 0.1（計 1.20） | 0.80 | 0.60 | CPU 0.2ms |
| underwater | 水上 0（caustics はホストのマテリアル）、水中 1.2 | 水中 0.8 | 0.4 | 焼き込み ≤ 30ms |
| terrain | main 1.40・反射 0.30・近景の影 0.30（計 2.00） | 1.00 / 0.20 / 0.20 | 0.80 / — / 0.15 | CPU 0.15ms、読み込み ≤ 600ms |
| trees | main 2.00・反射 0.50・近景の影 0.60（計 3.10） | 1.50 / 0.35 / 0.45 | 1.20 / — / 0.30 | CPU ≤ 0.5ms、読み込み ≤ 900ms |
| groundcover | 1.35 | 0.85 | 0.30 | 反射に写さない |
| shoreflora | 1.00 | 0.60 | 0.30 | |
| hardscape | 0.90 | 0.55 | 0.30 | |
| weatherfx | 0.40（雨天 +0.25） | 0.30 | 0.15 | |
| post | 1.00 | 0.75 | 0.50 | SMAA・DRS 込み |
| core | **1.50**（G0 の実測で見直し：コピー 0.6・late の MSAA 0.8・影と高さ場影 0.1） | ≈0.3 | | core-requests A-5 |
| キャラクター（予約） | **1.50**（影を含む） | | | |

- 合計は high で ≈14.9ms（目標 14ms を ≈1ms 超える）。**Phase 1 は各自の行を合格条件にする**。超過分は Phase 2 で §7 の削る順
  （フロクセル → GTAO → 光芒のサンプル数 → 反射の解像度 → 草の半径 → 木の LOD0 距離 → MSAA 2× + SMAA）で詰める（統合者）
- 測り方：自分の lab で `__lab.moduleCosts()` / `bench({ hide: [id] })`（§16）、本編で `game-costs.mjs`（パスごとの差）。perf-matrix は 1.25 倍超で失敗
- G0 のスタブの重さ（置き換える相手。spikes.md S-4）：high 水上で terrain 2.8・trees 2.9（反射 1.3）・water 1.8・hardscape 0.2–0.8・sky 0.4ms

### 12.2 読み込み・CPU・VRAM

- 追加の読み込み ≤ 3.5s（上限 6s）。G0 の全スタブは旧版より 1.0–1.5s **速い**（high 1.05s / 旧 2.51s）。各自の init の時間は `gfx.loadStats.modules[id]`（ms）で見える
- init の中の重い処理は 1 回 ≤ 30ms に刻んで `await ctx.forge.step()`（読み込み画面を止めない）
- CPU：update + prepare の合計を各自の CPU 予算に（`f` の生成や毎フレームの new を避ける。three の物は使い回す）
- VRAM：high ≈ 800MB、mid ≈ 330MB、low ≈ 140MB（全体）。`stats().texBytes` に自分の分を出す

---

## 13. forge（`ctx.forge`、src/gfx/core/forge.js）

外部アセットの代わりに起動時に GPU で焼く。frag は **main() を持つ断片シェーダの本体**（three が GLSL ES 3.00 で組み、`gl_FragColor` に書く）。
使える入力：`varying vec2 vUv`（0..1）、`uniform float ngLayer`（配列の層）、`uniform float ngSlice`（3D の z、テクセル中心 0..1）、`uniform vec2 ngTexel`（1/サイズ）。
GLSL ライブラリは frag の前に連結する（`NG_NOISE_GLSL + frag`。ngFrame は無い）。

```js
forge.bake2D({ w, h, frag, uniforms, type = HalfFloatType, format = RGBAFormat, mips = false, coverageAlpha = 0 /*0.5 で葉の被覆を保つ mip*/,
               filter = 'linear' | 'nearest', wrap = 'repeat' | 'clamp', colorSpace, anisotropy }) → Texture   // RT は forge が持つ
forge.bakeArray({ w, h, layers, frag, uniforms, type, format, mips, filter, wrap }) → Texture                  // WebGLArrayRenderTarget
forge.bakeArrayPixels({ w, h, layers, frag, uniforms }) → { data: Uint8Array, width, height, depth }          // CPU の画素（参照を差し替えられない DataArrayTexture 用）
forge.bake3D({ w, h, d, frag, uniforms, type, format, filter, wrap }) → Texture
forge.run(rt, frag, uniforms, layer = 0)                 // 既存の RT へ全画面（毎フレームの小さな焼き込み・派生）
forge.renderView(rt, layer, scene, camera)               // インポスター等の撮影。間は passId = BAKE（媒質を掛けない素の放射輝度）。autoClear と camera.layers は呼び手のまま
forge.target(w, h, { type, format, filter, wrap, mips }) → WebGLRenderTarget   // 使い捨て（呼び手が dispose）
await forge.step()                                       // 前回から 30ms 経っていたら 1 回譲る
await forge.blueNoise() → DataTexture                    // 64² の void-and-cluster（R8）。1 回だけ作る
forge.releaseScratch()                                   // core が読み込みの最後に呼ぶ
```

- アルベドはリニアで焼く（HalfFloat の既定ならそのまま `map` に。RGBA8 に焼くなら sRGB で焼いて `colorSpace: SRGBColorSpace`）
- 焼いたテクスチャは文脈の喪失で消える：`restoreGPU()` で焼き直す

---

## 14. 影・風・媒質・色の JS 側

### 14.1 影（`ctx.shadows`、shadows.js）

- 近景：key の three の影マップ。`shadow.camera.layers.mask = NG_MASK.SHADOW`。注視点へテクセルスナップで追従、光は注視点から 600m、near 0.5 / far 600 + 2·extent（high 696m）、
  bias = −0.04m ÷ (far − near)（**世界の長さで 4cm**。G0 後の修正：以前の −0.0004 は far 1500 で ≈0.6m に当たり、受け手から 0.6m 以内の遮蔽物の影が消えていた。core-robust の shadow-bias が 0.1m の遮蔽物を検査）/ normalBias 0.04、
  テクセルスナップの格子は注視点の近くの基準点（`ctx.shadows.snapAnchor`：32m のセルの中心、注視点が 24m 離れたら 1 回だけ移す）に固定（**G0 後の修正**：原点に固定していたので、
  太陽の回転で格子が «原点からの距離 × 角» だけ毎フレーム滑り、原点から 88m の桟橋で影の縁がざわついた。core-robust の shadow-shimmer が検査）。
  雲量で `shadow.intensity` 1 → 0.35。更新は P2 で 1 フレーム 1 回（`renderer.shadowMap.autoUpdate = false`）。
  **G0 の修正（b3c210c）**：影に入れる物の判定は shadow.camera のマスク（three r180 の仕様の回避）。影を落とす物は castShadow と層（§4）
- 高さ場影：core が焼く（地形の高さ場 + `ngCanopyAt` の樹冠）。2 段 × 4 象限を 16 フレームで一巡、key が 2° 跳んだら全部。`NG_HF_SHADOW_R = [256, 1024]`

### 14.2 風（`ctx.wind`、wind.js）

`wind.dir {x, z}`・`wind.speed` m/s・`wind.gust`・`wind.sample(x, z, t?) → { dx, dz, speed, gust }`（`ngWindAt` の双子）。時刻と天候の純関数（マルチで一致）。

### 14.3 色と単位（`src/gfx/core/palette.js`）

- シーンはリニア Rec.709 の HDR。トーンマップと sRGB は post で 1 回だけ。**自前のシェーダはリニアで出す**
- `NG_UNITS = { KEY_NOON: 3.0, SKY_NOON: 0.9, MOON: 0.012, NIGHT_SKY: 0.004, LAMP_K: 2200 }`
- `NG_ALBEDO`（素材の線形アルベドの範囲。草 0.10–0.16、スギの葉 (0.028,0.050,0.030)–(0.032,0.058,0.032)、砂 0.25–0.35（濡れ ×0.55）、岩 0.18–0.25、
  桟橋の杉材 0.28（濡れ ×0.5）…）、`NG_WATER_F0 = 0.02`、`NG_EXPOSURE_TABLE`・`ngScheduledExposure(sunAltDeg, cloud, rain, uwDepth)`、`ngLuminance(r,g,b)`、`NG_CHART_24`
- lab の `view('falseColor')` で輝度帯を確かめる（18% 灰を 0 とした EV の帯）

---

## 15. 最小のモジュールの例

`src/gfx/core/examples/exampleModule.js`（id `'example'`）が、ここまでの口を全部使った «動く» 雛形。`lab/example.html` で起動し、
`scripts/gfx/scenarios/example-smoke.mjs` が 3 段で撮って検査する（G0 で合格：プログラム 3 本（杭・杭の影・浮き輪）・断片サンプラー最大 4・頂点 2・GPU ≈0.04ms・NaN 0・エラー 0）。

中身（抜粋。全文はファイルを読むこと）：

```js
import { NgModule } from '../module.js';
import { NG_LAYER, ngOwn } from '../layers.js';
import { NG_PASS } from '../frame.js';
import { ngExtendStandard, ngShaderMaterial, ngAttachDepth } from '../extend.js';
import { NG_HEIGHTFIELD_GLSL } from '../glsl/heightfield.glsl.js';
import { NG_WIND_GLSL } from '../glsl/wind.glsl.js';
import { NG_SURFACE_GLSL } from '../glsl/surface.glsl.js';
import { NG_WAVE_GLSL } from '../glsl/wave.glsl.js';
import { hash01 } from '../../../world/rng.js';

export class ExampleModule extends NgModule {
  static id = 'example';
  async init(progress) {
    const { THREE: T, forge, lake, heightfield, services } = this.ctx;
    this.stripes = forge.bake2D({ w: 16, h: 256, frag: STRIPE_FRAG, mips: true, wrap: 'clamp' });   // §13
    await forge.step();
    // 位置は hash01（Math.random 禁止）、高さは heightfield.heightAt（GPU と同じ補間）、rank の入れ子で段の本数
    const mat = ngExtendStandard(new T.MeshStandardMaterial({ map: this.stripes, roughness: 0.7 }), {
      key: 'example-stake', module: 'example', uniforms: { ...heightfield.uniforms },
      vertex: { pars: NG_HEIGHTFIELD_GLSL + NG_WIND_GLSL, begin: `
          vec3 ngBase = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec4 ngW = ngWindAt(ngBase.xz);
          float ngK = transformed.y / 1.20;
          transformed.xz += ngW.xy * (ngK * ngK * 0.015 * ngW.z);
          transformed.y += ngTerrainH(ngBase.xz) - 0.05;` },
      fragment: { pars: NG_SURFACE_GLSL, rough: 'ngWetSurface(diffuseColor.rgb, roughnessFactor, 0.6, ngWet);' },
      depth: true, hfShadow: true,
    });
    this.stakes = new T.InstancedMesh(geo, mat, n); this.stakes.castShadow = true; ngAttachDepth(this.stakes);
    // 波に乗る浮き輪（ngShaderMaterial + NG_WAVE_GLSL + fog チャンク）
    const fmat = ngShaderMaterial({ key: 'example-float', module: 'example', lights: false,
      uniforms: { ...this.uniforms, ...heightfield.uniforms }, vertexShader: FLOAT_VS, fragmentShader: FLOAT_FS });
    ngOwn(this.root, NG_LAYER.WORLD);
    this.ctx.scene.add(this.root);
    services.post.registerDebugView('example-depth', 'vec4 ngDebug(vec2 uv) { … }');
    progress?.(1);
  }
  update(f)   { /* CPU。2.5 秒ごとに ctx.services.water.addRipple(…) */ }
  prepare(f)  { this.uniforms.uTime.value = f.waterTime; this.uniforms.uWind.value = f.waterWind; }   // 水の値は prepare で
  beforePass(passId) { this.float.visible = passId !== NG_PASS.REFLECTION; }
  setQuality(tier) { this._fill(tier); }
  stats() { return { draws, tris, instances, texBytes, programs }; }
}
export function createModule(ctx) { return new ExampleModule(ctx); }
```

自分のモジュールにするには：`src/gfx/<id>/index.js` に `export function createModule(ctx)` を書き（`static id = '<id>'`）、
`lab/<id>.html` を `bootLabPage({ modules: ['<id>'] })` にする（`extraModules` は例のための口で、本物には要らない）。

---

## 16. lab キットと撮影

### 16.1 lab ページ（`lab/<id>.html`）

`lab/example.html` か `lab/core.html` を写して、最後の 2 行を：

```html
<script type="module">
import { bootLabPage } from './lab/_kit/page.js';
bootLabPage({ modules: ['water'] });   // ここに挙げた id だけ担当者の index.js、残りは core のスタブ
</script>
```

- `Lab.boot({ modules, seed = 123456789, tier = 'high', size, characters = true /*本物の Angler と魚 6 匹*/, chart = true, extraModules })`：
  本物の湖（resolveLake(123456789)）・高さ場・placement・パイプライン・post を組み、フレームを game.js と同じ順（§2.1）で回す
- URL：`?tier=low|mid|high` `&hour=12.5` `&weather=clear|cloudy|rain` `&cam=<プリセット>` `&view=<表示>` `&freeze=10` `&chart=0` `&capture=1`（HUD を隠す）
  `&msaa=2|4` `&gpuTimer=sync` `&ng=-trees`（モジュールを外す）`&dpr=2`
- キー：1–9 プリセット、[ ] で 1 時間、w 天候、v 表示の巡回、f false color
- 隅にグレー球（0.18）・クロム球・24 パッチのチャート（NO_REFLECT 層、カメラの子）
- 開き方（手で見る）：リポジトリの根を静的に配信して `http://127.0.0.1:<port>/lab/<id>.html`（撮影は shot.mjs が自前のサーバーで配信する）

### 16.2 `window.__lab`

| API | 説明 |
| --- | --- |
| `gfx` `renderer` `scene` `camera` `lake` `dock` `placement` `worldMs` | 中身 |
| `setHour(h)` / `setWeather(k, { instant })` / `setTier(t)` | 時刻・天候（instant で damp を飛ばす）・段 |
| `setFlow({x, z} \| null, strength = 0.06)` | 水中の流れを上書き（null で game.js と同じ既定：桟橋の向き） |
| `cam(preset \| { pos: [x,y,z], target: [x,y,z], hour?, weather? })` / `presets()` | カメラ |
| `freeze(t?)` / `unfreeze()` | 時間を止める（`__gfxCapture = true`：露出の順応・DRS も止まる。撮影の再現性） |
| `tick(n = 1, dt = 1/60)` / `resume()` | 同期で n フレーム進める（rAF を止める）/ rAF に戻す |
| `view(name \| null)` / `views()` | 表示：`refl` `sceneColor` `depth` `nearShadow` `hfShadow` `hfShadow0` `skyView` `falseColor` `overdraw` と registerDebugView の名前 |
| `stats()` | `{ fps, gpuMs: {pass: ms}, cpuMs, gpuTotal, draws, tris, programs, textures, geometries, rtBytes, modules: {id: stats + stub/disabled}, degraded, tier, msaa, exposure, uw, msaaFallback }` |
| `bench({ frames = 60, warm = 30, windows = 5, hide = [], passes = true })` | `{ size, tier, msaa, frameMs, frameMsMin, frameMsMax, cpuMs, gpuPassSum, passes, passMin, passCpu }`（passes は `'sync'` 方式のパス別 GPU ms） |
| `moduleCosts({ frames = 40, rounds = 3 })` | `{ base, modules: { id: ms } }`（全体 − 隠した、の中央値） |
| `programAudit({ frag = 12, vert = 4 })` | `{ count, over, failed, byModule, programs: [{ tag, name, frag, vert, samplers, runnable, over }] }` |
| `nanCheck()` | mainRT の NaN / Inf の画素数 |
| `meanLuminance()` | 画面中央の平均輝度（リニア、露出前） |
| `fishCheck()` | 本物の createFishMaterial が caustics 付きでリンクできたか |
| `msaa()` | MSAA の実測と判定 |
| `glsl` | core の GLSL 文字列（自前の計測シェーダ用） |
| `addModule(createModule)` | 10 の id 以外のモジュールを足す（例のための口） |
| `onBeforeRender` | 各フレームの prepare の直前に呼ぶ関数（撮影で uniform を上書きする口） |
| `window.__gfxReady` | compileAsync と 3 フレームの空回しの後に true |

**カメラのプリセット**：`dock-fp` `dock-3p` `shore-low` `aerial60` `far-ridge` `forest-floor` `reed-edge` `weedbed-uw` `uw-dock` `waterline` と
baseline の 7 構図（時刻・天候付き）`dawn-3p`（6:06 晴）`morning-fp`（8:30）`noon-fp-down`（12:30）`noon-shore`（13:00）`dusk-3p`（18:18）`night-fp`（22:30）`rain-fp`（11:00 雨）。

### 16.3 撮影（`scripts/gfx/shot.mjs`）とシナリオ

```bash
export PATH=/Users/apple/.nvm/versions/node/v22.17.0/bin:$PATH
PW_MODULE=<playwright の index.mjs の絶対パス> node scripts/gfx/shot.mjs scripts/gfx/scenarios/<id>-matrix.mjs --out <DIR> [--size 1920x1080] [--timeout 180]
```

- ヘッドレスの Chrome（Metal の GPU）で開き、console のエラー・警告・ページ例外を `<DIR>/console.txt` に書く。シナリオが投げたら `_failure.png` を撮って終了コード 1
- シナリオ = `export default async function (h)`。道具：`h.open(rel)`・`h.waitFor(fn, arg, sec)`・`h.eval(fn, arg)`・`h.shot(name)`・`h.counts()`（errors / warnings / pageErrors）・
  `h.logs`・`h.sleep(ms)`・`h.page`（playwright）・`h.out`・本編用 `h.bootGame({ quality, bootQuality, seed, start, query })`・`h.tick(n, dt)`・`h.hideHud()`・`h.stats()`・`h.frameMs(n)`
- **雛形**：`scripts/gfx/scenarios/example-smoke.mjs`（起動・撮影・NaN・プログラムの監査・自分の GPU ms・エラー 0。`ID` を自分の id に変える）

| 既存のシナリオ | 用途 |
| --- | --- |
| `lab-matrix.mjs <id>` | プリセット × {5:40, 9:00, 12:30, 17:45, 18:55, 23:30} × {clear, cloudy, rain} を撮り、各 PNG に同名の .json（時刻・天候・水平線・stats）。`PRESETS=` `HOURS=` `WEATHERS=` `TIER=` `FRAMES=` で絞る |
| `node scripts/gfx/art-metrics.mjs <DIR> [--json OUT] [--no-fail]` | lab-matrix の撮影を自動判定：白飛び < 0.5%、黒つぶれ < 1%、昼の中間輝度 0.15–0.65、水平視の水／空 0.35–0.75、noon-fp-down の水の色相 160–200°、空のバンディング、夜明けの単調性、真夜中／真昼 0.25–0.40 |
| `lab-bench.mjs`（`LAB=<id> TIERS= VIEWS= MODULES=1`） | 視点ごとのフレーム時間・パス別 GPU ms・モジュール別 |
| `lab-smoke.mjs` / `core-robust.mjs` / `core-glsl-cost.mjs` | core の確認（冪等・late・品質・故障・文脈の喪失・サンプラー・影マップ / GLSL の重さ） |
| `g0-gameplay.mjs` / `smoke-all.mjs` / `fault-inject.mjs` / `game-matrix.mjs` / `game-costs.mjs` / `load-time.mjs` | 本編（index.html）：遊びの流れ・1200 フレームの揺さぶり・故障の注入・視点 × 時刻の GPU ms・モジュール別の GPU ms・読み込み時間 |

### 16.4 計測の注意

- GPU 時間は `?gpuTimer=sync`（パスの前後を 1×1 の readPixels で挟む実時間）。GPU を止めるので lab とベンチ専用。分解能 0.1ms
- Apple の GPU は負荷で周波数が揺れ、他のアプリとも取り合う → **最小** を «邪魔の無いときの値» として採り、全体 ↔ 隠した を往復して差を取る
- 撮影・計測は `__gfxCapture = true`（`freeze()`）で DRS と順応を止める（止めないと内部解像度が落ちた数字になる。spikes.md S-4）
- `ctx.budget.measure(name, fn)` で自分のサブパスを測れる（sync のときだけ GPU 時間。パス名は自分の id を接頭辞に）

---

## 17. 合格の証拠と、変更の要望

### 17.1 各モジュールの合格条件（ARCHITECTURE §6 の自分の節 + 共通）

1. lab の証拠一式：§6 の «証拠» の撮影（lab-matrix と自分のシナリオ）と数値の JSON
2. 3 段で予算内（§12、lab の moduleCosts と本編の game-costs）
3. 例外 0・console のエラー 0・NaN 0（nanCheck）・シェーダの失敗 0
4. サンプラーの上限内・自分のプログラム ≤ 6（programAudit）・ドロー数が自分の予算内（stats）
5. `node scripts/run-tests.mjs` 緑、Math.random なし
6. art-metrics の該当項目に合格
7. 本編で：`g0-gameplay.mjs`・`smoke-all.mjs`・`fault-inject.mjs`（MODULES=<id>）が合格（自分のモジュールを入れた状態で）

### 17.2 変更の要望（core-requests.md）

core・ファサード・他モジュール・この文書の変更が要るときは `docs/nextgen/core-requests.md` の自分の節に «何を・なぜ・代案» を書く。
統合者が Phase の境目でまとめて判断し、この文書を改訂する（判断の記録は core-requests.md の «G0 の統合での判断» の表と同じ形）。
急ぎ（作業が止まる）なら、その旨を書いて統合者に知らせる。それまでは自分のモジュールの中で回避する（core を直接変えない）。
