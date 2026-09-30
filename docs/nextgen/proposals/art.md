# 湖畔のフィッシング 次世代環境グラフィック設計書 — 「一つの光、一つの空気、一つの水」（アートディレクション優先版）

## philosophy
1) 絵のまとまりは技法の数では決まらない。すべてのピクセルが同じ光、同じ空気、同じ水を通っているかで決まる。そこで太陽・月・空の放射輝度、大気（空気遠近＋霧＋朝霧）、水の吸収・散乱は、core にある一つのモデル（ngAtmos / ngLight / ngMedium）だけから計算する。空・地形・植生・水・既存の MeshStandardMaterial のキャラクターまで、全員が同じ GLSL 関数と同じ uniform の参照を使う。
2) 画面はリニア HDR の scene-referred 単位で描き、露出・トーンマップ（AgX）・グレード・ディザは PostFX で最後に 1 回だけかける。各モジュールがトーンマップ後の見た目に合わせて色を「作る」ことは禁止する。守るのは §色彩バイブルのアルベド範囲と照度だけ。
3) 主役は水。旧版は鏡面のうち「空の反射」だけが強く、深さと透明度が絵になっていなかった（baseline noon-fp-down は一面群青、noon-shore は浅場だけ緑）。新版は、浅場の底が見えるテール→緑→深い青黒へ移る吸収ベースの色、突風の斑（cat's paw）で鏡面と細波が入れ替わる風の場、岸の舐め、Snell の窓で水を組み立てる。水面にどう映るかを基準に森と空の色を決めていく。
4) 植生は生態学的に置く。汀のヨシ・マコモ、ワンドのヒツジグサ、藻場のクロモ、水辺に張り出すヤナギ・ハンノキ、斜面下部のブナ・ミズナラ・イロハモミジの落葉広葉樹、中腹の四角く植林されたスギ・ヒノキの暗い帯、尾根のアカマツと露岩。こうすると「日本の山の湖」という輪郭が遠景の色の塊だけで読める。旧版の「均一な針葉樹の列＋ランダムな広葉樹」は捨てる。
5) 時刻と天候は、空・光・霧のパラメータを純関数で決める（MP の同期）。見た目の遷移は damp で遅らせ、撮影用に即時に反映する経路も持つ。
6) 性能は最後まで予算表で管理する。各モジュールは lab ページで自分の ms を測って証明し、統合後は core の動的解像度（high のみ 0.8〜1.0）を安全弁にする。
7) 描画は毎フレーム例外を出さない。初期化に失敗した機能は落として続行し、フレーム中は try で包み、NaN を防ぐクランプを入れる。この三つを core の義務にする。

## pipeline
【前提】three r180 WebGLRenderer / WebGL2。renderer.toneMapping=NoToneMapping、outputColorSpace=SRGB（最終 EffectPass が encode）。shadowMap.enabled=settings.shadow、type=PCFShadowMap（radius で軟らかく。PCFSoft は r18x で非推奨なので避ける）、shadowMap.autoUpdate=false（更新は下の P2 の 1 か所だけ）。renderer.info.autoReset=false（perf の前提）。

【レイヤー】layers は旧コードで一度も使っていないので、新しく割り当てる。
- 0 WORLD：不透明の世界とキャラクター。メインと反射の両方に写る
- 1 WATER：水面メッシュだけ
- 2 LATE：透明物（マーカー・ウキの輪・糸リボン・名札・しぶき・雨・デバッグ）。水の後に描く
- 3 MAIN_ONLY：下草・沈水植物・水中プロップ。反射に写さない
- 4 REFL_PROXY：反射専用の粗い代理（森の遠景など）

割り当ては core の Pipeline.classify() が行う。シーングラフのバージョン（子の数の和）が変わったとき、または 2 秒ごとに走査する。ng 以外のオブジェクトは、material.transparent が true なら LATE へ移し、それ以外は WORLD のまま。ng のモジュールは自分で layers を設定し、userData.ngOwned=true を付ける。game.js の marker / aimMarker は gfx.markLate() で明示的に登録する（安全網は classify）。

契約 API の setCaptureHidden / setReflectionHidden は、今までどおり visible を切り替えるリストとして残す。互換のため。

【1 フレームの順序】game.js の呼び出し順は変えない。中身を差し替える。

P0 CPU 更新（env.update → terrain.update* → water.update の中）
- gfx.beginFrame(dt, hour, camera)：FrameState を確定する。sunDir・月・keyDir、SH9 ambient（4Hz）、霧、wetness、wind、underwater
- 植生の cell カリングと LOD 選択：32m の cell ごとに視錐台、距離＋ヒステリシス、10Hz
- water.update：time += dt。gfx.U.ngWaterTime を書く。causticsUniforms の .value を書く

water.capture()：安全な no-op。カメラを記録するだけ。perf の 'capture' 区間は空になる。
water.captureReflection()：ここでは何もせず、予約フラグだけ立てる。反射は P5 で描く（opaque の後）。perf の 'reflection' ラベルは P5 で開始と終了を呼ぶ。

postfx.render(dt) の中が本体になる。

P1 GPU シミュ／LUT（小さい pass の集まり）
- skyView LUT：192×108 RGBA16F。太陽が 0.05° 動いたら更新。実質毎フレーム、0.03ms
- transmittance LUT：256×64 RGBA16F。起動時に 1 回
- multiscatter LUT：32×32。起動時と天候が変わったとき
- 波紋シミュ：波動方程式、RG16F の ping-pong。high 512²（48m 角、9.4cm/texel）、mid 256²（32m）、low は無し。カメラの xz に texel 単位でスナップして追従し、はみ出た分は 0 で埋める。1 フレーム 2 substep。注入は addRipple・雨・魚の点を 64 個までの uniform 配列で渡す
- caustics 生成：RG16F 512²（high 30Hz、mid 15Hz、low は起動時に焼いた 8 フレームの配列をフリップ）
- 雲の影：R8 256²（2Hz）
- 地形の日照（heightfield march）：R8 1024²（high）/512²。太陽が 0.2° 動いたら更新（≒実 0.8 秒ごと）。4 象限に分けて 4 フレームで回す
- env probe：cube 64² → PMREM。1 フレームに 1 面ずつ。天候が変わったとき、または時刻が 3 ゲーム分進んだとき

P2 近景の影＋不透明のメイン（layers 0|3）
- renderer.shadowMap.needsUpdate=true にしてから、メインカメラで WORLD+MAIN_ONLY を HDR MRT なしの RT へ描く。影の更新はこの render の冒頭で 1 回だけ起きる。キャラクターも木も影を落とす
- 影カメラ：sun 1 灯、ortho。high 4096² ±42m、mid 2048² ±32m、low 1024² ±22m。中心は focusPos。texel グリッドにスナップしてちらつきを止める。bias -0.0004、normalBias 0.035
- 目標 RT：sceneRT = RGBA16F（HalfFloat）＋DepthTexture（UnsignedInt24/Float32）。high は samples=4（MSAA）で、植生は alphaToCoverage。mid/low は MSAA 無しで alpha test（mip ごとに coverage を保存したマスク）
- 空は最後に描く（depth = far、depthFunc LEQUAL、renderOrder -1000 を維持）。overdraw を避けるため

P3 解決とコピー
- MSAA を resolve する（blitFramebuffer で色と深度）
- sceneColorCopy：RGBA16F。high 1.0 解像度、mid 0.5、low 0.5。mip は生成せず、屈折のぼかしは 4 tap で代える
- linearDepthCopy：R32F（または R16F）。同じ解像度で、fullscreen の 1 draw で書く。水が自分の書く深度バッファを読むと feedback になるので、コピーを読む

P4 空（sceneRT へ）。P2 の最後で描いてもよい。実装の都合で 1 か所に決める。

P5 反射（reflRT）
- 鏡映カメラ（y=0、斜めクリップ面 y=+0.02）。layers 0|4（MAIN_ONLY は除く）。setReflectionHidden のリストも隠す
- 解像度：high 0.5×（1280×720 @1440p）毎フレーム、mid 0.4× 毎フレーム、low 0.25× を 2 フレームに 1 回
- RGBA16F＋depth renderbuffer。generateMipmaps を有効にし、粗さに応じて textureLod で読む
- 描く中身：植生は LOD を +1 段落とす。groundcover は描かない（岸のヨシは LOD1 で描く）。影の更新はしない
- clearColor・clearAlpha は毎回明示する（旧版の 0x8fb8d8 残りの罠を避ける）

P6 水面（layer 1 → sceneRT、depthTest・depthWrite あり）
- 屈折 = sceneColorCopy。反射 = reflRT。深さ = linearDepthCopy
- 水上から見るときは表、水中から見るときは裏の Snell の窓

P7 水中のボリューム（カメラが水中、または水面が画面に入って水中量 > 0 のとき）
- 半解像度の RGBA16F に god rays と散乱を raymarch し、bilateral upsample で sceneRT に合成する

P8 LATE（layer 2、sceneRT、depth test あり）
- しぶき・雨・霧のカード・マーカー。renderOrder の既存値（波紋 3、糸 5、マーカー 6、debug 900）はこのパスの中で守る

P9 後処理（pmndrs EffectComposer。入力は sceneRT で、RenderPass は使わず自前の NgScenePass を入れる）
- EffectPass A：[NgUnderwaterEffect（水中モジュール提供）]
- EffectPass B：[Bloom（mipmap、luminanceThreshold 0、intensity 0.05〜0.09、エネルギー保存の mix）、NgAutoExposure、NgGrade＋ToneMapping(AGX)＋NgDither、SMAA（mid）/FXAA（low）]
- high は MSAA なので AA 無し。必要なら SMAA low
- エンコードは最終パスで 1 回だけ

【色の流れ】
- 自前の ShaderMaterial は uLinearOut=1 に固定する（契約）
- 露出 = baseExposure(時刻, 天候) × autoAdapt
- autoAdapt：64×36 の log 輝度 → 1×1 へ mip（GPU のみ）→ 1×1 の RG16F へ時間適応（τ=1.2s）
- クランプ：±0.7EV（昼）、夜は +1.2EV まで。夜を完全に明るくしないため
- baseExposure はバイブルの表からの純関数

【水中の経路】
- カメラが水中のとき（getUnderwaterContext.strength > 0）は、P5 の反射を止めて予算を返す
- P6 は裏面シェーダ（Snell の窓と全反射）を描く
- 全マテリアルの ngApplyAtmosphere が水中の媒質（Beer-Lambert＋散乱）に切り替わる
- P7 を有効にする。雨は非表示（env.underwater の setter）

【例外対策】
- 各 pass は try/catch で包み、失敗したら pass を無効化して 1 回だけログを出す
- render(dt) は必ず最後に画面を出す（最悪は sceneRT の直接コピー）
- 描画の例外を game へ再送出しないこと。これで MP の同期を守る

## core
■ ファイル（src/gfx/core/）
- context.js：gfx シングルトン
- state.js：FrameState
- uniforms.js：共有 uniform 群
- sun.js：天体の位置
- atmosphere.js：CPU の大気モデルと LUT pass
- lighting.js：SH・probe・far shadow
- shadows.js
- wind.js
- weather.js：wetness
- medium.js：水の光学定数
- quality.js
- pipeline.js
- post.js
- adopt.js：外来マテリアルの取り込み
- patch.js：ng マテリアルの注入
- glsl/*.glsl.js：文字列の export
- heightfield.js
- palette.js：色彩バイブルの定数
- lab/harness.js

■ 構築と取得
```
createGfx({ scene, quality }) -> gfx      // Environment の constructor 内で呼ぶ（湖より前）
getGfx() -> gfx                           // どこからでも同じインスタンス
gfx.attachRenderer(renderer)              // Terrain / PostFX の constructor から。LUT の初期化はここ
gfx.attachLake(lake, terrainFacade)       // Terrain の constructor。heightfield をここで作る（Web Worker）
gfx.registerModule({ name, init(gfx):Promise, update(frame), setQuality(q), passes?:{pre?(r,f),late?(r,f)}, dispose() })
gfx.U        // 共有 uniform（{value} の参照は固定。.value だけ書き換える）
gfx.frame    // FrameState（読み取り専用）
gfx.quality / gfx.onQuality(cb) / gfx.layers {WORLD:0,WATER:1,LATE:2,MAIN_ONLY:3,REFL_PROXY:4}
gfx.patchMaterial(mat, { wind?, wet?, underwater?:true, farShadow?:true, skyVis?:true, translucency?, porosity }) -> mat
gfx.adopt(root)                           // 外来（fish/angler/remote）のマテリアルに ng の大気・光を注入。冪等
gfx.markLate(obj) / gfx.snap()            // snap = 天候・露出・damp を即時に反映（撮影用）
```

■ FrameState（毎フレーム、env.update の中で確定）
- time, dt, hour, season（既定 0.15 = 初秋の気配）
- sunDir, moonDir（= -sunDir）, keyDir
- sunRadiance / moonRadiance：大気の透過後、vec3、ng 単位
- nightAmount = smoothstep(0.08, -0.16, sunDir.y)
- cloud, rain：damp 済み
- wetness：0..1。雨で 1 へ τ=12 ゲーム分、乾きは τ=90 ゲーム分
- wind：{ dir:vec2, speed m/s, gust }。clear 1.4 / cloudy 3.0 / rain 5.0、damp あり
- camera, camPos, underwater（0..1）, waterTime
- exposureBase

■ 太陽の軌道（純関数）
- 緯度 φ=36°、赤緯 0（春分と秋分）。H=(hour−12)·15°
- sunDir = normalize(−sin H, cos φ·cos H, sin φ·cos H)。+X=東、+Z=南
- 6:00 に日の出、18:00 に日没、南中の高度は 54°。旧版の 71° より低いので、夕方の斜光が長く続く
- 月 = −sunDir。深夜 0 時に南の空の 54°、満月固定

■ 単位（ng 単位）
- 晴れの南中：太陽の照度 E⊥ = 10.0、空の上半球の照度 ≈ 2.4
- 反射率 0.18 の水平面の輝度 ≈ 0.18·(10·0.81+2.4)/π ≈ 0.60
- 露出の基準：昼 0.30 で表示の中間灰 0.18
- 月の照度 E⊥ = 0.0045、星空の zenith 輝度 ≈ 0.0006
- 露出は EV の表（palette.js）で持ち、夜は「暗いと分かる暗さ」に残す

■ 大気（atmosphere.js と NG_ATMOS）
- Hillaire 2020 の簡易版：Rayleigh（地表の散乱係数 5.8, 13.5, 33.1 ×1e-6/m、スケール高 8km）、Mie（β 3e-6·haze、スケール高 1.2km、g=0.8）、オゾン吸収
- 地上の視点に固定するので、transmittance LUT と skyView LUT だけで足りる
- 同じ式の CPU 版（64 方向 × 16 step）を 4Hz で回す。出すものは次のとおり
  - SH9 の空の照度 → THREE.LightProbe（固定の 1 灯）
  - env.zenithColor / horizonColor / fogColor / sunColor（契約の THREE.Color）
  - 地面の照り返し：SH に ground albedo 0.12 の緑灰色を加算する

空気遠近と霧は 2 層の指数高さ霧で出す。
- haze：密度 d_h、スケール高 120m
- lake mist：密度 d_m、スケール高 4m。3D ノイズで斑にする（ノイズはサンプル点を y=1.5m 面に投影して 2 回引く）
- 光学的厚さ τ(p) は高さ霧の解析積分で求める
- 散乱光 inscatter = (1−e^−τ) · [ skyView(水平寄りの viewDir) · 0.9 + sunRadiance · HG(g=0.72, cosθ) · 0.35·(1−cloud) ]
- 天候の係数：d_h は clear 1、cloudy 2.2、rain 5.5（視程は約 350m）
- 朝霧 d_m は 4:30〜7:30 と雨上がりの 2 時間にピークを持つ。ピーク時の視程は 80m

GLSL の関数（接頭辞 ng）。GLSL の文字列は core/glsl から export する。
```
vec3 ngSkyRadiance(vec3 dirW);
void ngAerial(vec3 posW, out vec3 inscatter, out vec3 transmit);
vec3 ngApplyAtmosphere(vec3 c, vec3 posW);   // 水中のときは ngMediumApply に分岐
```
scene.fog は THREE.Fog のまま残し、near/far に「10%/90% に届く距離」を毎フレーム書く（debug.js 用）。

■ 光（lighting.js と NG_LIGHT）
ライトは起動時に固定する。
- DirectionalLight 1 灯：太陽と月の兼用、castShadow
- LightProbe 1 灯：SH9
- PointLight 1 灯：灯籠。影なし。昼は intensity 0 で、灯は消さない
- HemisphereLight は作らない

scene.environment は起動時に固定の PMREM RT を 1 枚入れ、中身だけ更新する。PMREMGenerator.fromCubemap(cube, sameRT) を使う（テクスチャの参照は変えないので再コンパイルは起きない）。この RT は sky＋遠景の稜線を描いた 64² の cube から作る。

GLSL の関数。
```
float ngCloudShadow(vec3 posW);       // 雲の影テクスチャ（xform 付き）。sunDir へ投影
float ngTerrainShadow(vec3 posW);     // heightfield march の日照。R8、ソフト
float ngFarKeyVis(vec3 posW, float viewDist); // 近景の影が届かない所だけ ngTerrainShadow を使う。フェード 0.8R〜R
float ngSkyVis(vec3 posW);            // 森の天空遮蔽（placement の密度をぼかしたもの）
vec3  ngUnderwaterAtten(vec3 posW);   // y<0 の点の太陽の減衰 = exp(−σ_t·depth/cos θ_refr)
vec3  ngCaustics(vec3 posW, vec3 nW); // 共有の caustics。causticLight もこれを呼ぶ
```

■ 注入（patch.js と adopt.js）
新しい ng の不透明マテリアルは、原則すべて MeshStandardMaterial ＋ onBeforeCompile で作る。キャラクターとまったく同じ BRDF・影・probe・env を通すため。注入する点は次のとおり。
1. 頂点の #include <project_vertex> の後ろ：vNgWorldPos を書く（instancing / skinning を考慮）。wind を使うなら begin_vertex で ngBendVegetation を呼ぶ
2. lights_fragment_begin の中の getDirectionalLightInfo(...) の直後：directLight.color *= ngCloudShadow·ngFarKeyVis·ngUnderwaterAtten
3. lights_fragment_maps の後ろ：irradiance *= ngSkyVis。水中なら ngUnderwaterAtten(0.6 倍の深さ) も掛ける
4. emissivemap_fragment の後ろ：totalEmissiveRadiance += ngCaustics（水中の点だけ）
5. fog_fragment を ngApplyAtmosphere に置き換える
6. envmap の強さは ngEnvScale（水中は 0.25）

adopt(root) は、fish・angler・remote のマテリアルの既存の onBeforeCompile と customProgramCacheKey をラップして同じ注入を足す。fish は自分で causticLight を入れているので、注入 4 を省く（userData.ngNoCaustics を自動で判定し、shader に causticLight があればスキップ）。

adopt を呼ぶ時点は次のとおり。
- build の最後の renderer.compile の前
- classify が新しいメッシュを見つけたとき（remote のプレイヤーが参加したときの 1 回だけの再コンパイルは許容する）

配列マテリアルにも needsUpdate を立てる。applyQuality のバグを避けるため。

■ 影
近景は three 標準の 1 枚（上記）。遠景は ngTerrainShadow。
- 入力：heightfield R16F 1024² ±512m ＋ 樹冠の高さ（placement の密度 × 樹高を足したもの）
- sunDir の方向に 48 step march する。penumbra は min(Δh/dist) から出す
- 山の影が夕方に湖を横切って伸びていくことと、森の自己遮蔽を、どちらも 0.3ms 以下で出す

■ 風（wind.js）
- 突風テクスチャ：R8 128² をタイリングし、0.5 km スケールで風下へ流す
- ngWindAt(xz) = dir·speed·(0.55 + 0.9·gust(xz − dir·t·speed·0.8))
- 植生の揺れ、水面の細波の強さ（cat's paw）、雨の傾き、霧のカードの流れは、すべてこの同じ関数を使う
- 契約の water.wind（物理）は別の式のまま。見た目の wind.speed は damp で相関させる

■ 濡れ（weather.js）
ngWetnessAt(posW, nW) = wetness · (0.35 + 0.65·max(nW.y, 0)) · ngSkyVis。
ngApplyWetness の処理：
- albedo *= mix(1, 0.55, wet·porosity)
- roughness = mix(r, 0.08, wet·(1 − porosity·0.5))
- 水平面の窪みに水たまり：heightfield の curvature が負のところ。F0 0.02 の鏡面

■ 水の媒質（medium.js）
- σ_a = (0.36, 0.072, 0.052) /m、σ_s = (0.012, 0.022, 0.020)。濁り turb = rain·0.6 + cloud·0.1 で σ_s ×(1 + 4turb)
- ngWaterAbsorb と ngWaterScatter は、水面・水中・caustics・getUnderwaterContext.absorb の全員が使う

■ 高さの場（heightfield.js）
lake.heightAt を Web Worker で評価する。lakefield は three を使わないので、worker で import してよい。作るものは次のとおり。
- ngHeightTex：R16F 1024² ±256m（0.5m/texel）＋ 512² ±512m
- ngShoreDist：汀線までの符号付き距離、R16F 512² ±256m
- bedKind：RGBA8 512²。mud/sand/rock の重みと slope

データは Float32Array の CPU 配列としても残し、植生の配置と水の LOD に使う。

■ 品質（quality.js）
- 'low'|'mid'|'high' だけを受ける。'medium' は 'mid' に正規化する
- quality.settings[q] の表（§qualityTiers）を持ち、onQuality で各モジュールへ配る
- ライト数と castShadow は変えない。影の ON/OFF だけは game.applyQuality の既存の経路に任せる

■ ポスト（post.js）
- NgAutoExposure / NgGrade を持つ
- NgGrade の中身：ホワイトバランスは 5600K 固定、25% だけ適応する。Purkinje：輝度 < 0.02 で青へ寄せ、彩度を下げる。contrast 1.04、saturation 1.0（バイブルで調整）、vignette 0.12
- 最後に AgX（pmndrs ToneMappingEffect の mode AGX）
- ディザ：64² のブルーノイズを起動時に void-and-cluster で生成し、±0.5/255 を足す

■ lab ハーネス（src/gfx/lab/harness.js）
- 本物の湖（resolveLake(123456789)）、core、Terrain の facade stub（数学系 API のみ）を用意する
- window.__lab に { setTime, setWeather(k, instant), setCam(preset), setQuality, setUnderwater, falseColor(on), timings() } を出す
- 準備ができたら window.__gfxReady = true
- カメラのプリセットは baseline と同じ 7 構図＋モジュール固有の構図
- 全 lab は画面の隅に「灰色の球、クロム球、24 パッチのカラーチャート」を固定位置に置く（光と露出の検証用）。false color の表示で、輝度の帯がバイブルの範囲に収まっているかを見る
- GPU の時間は EXT_disjoint_timer_query_webgl2 で pass ごとに測る。無ければ 300 フレームの平均 ms で代える

## modules

### sky（空・雲・天体）
files: src/gfx/sky/{skyDome.js, clouds.js, celestial.js, stars.js, cloudShadow.js}, lab/sky.html

resp: 空の描画（sky dome）、太陽と月の円盤、星と天の川、2 層の雲（積雲系の 2.5D の層と巻雲）、曇天の雲底、雨の雲、雲の影テクスチャ（core の ngCloudShadow が読む）。Environment の sky（Object3D）と skyUniforms.uStars / uLinearOut の互換。

tech: ■ 空の地
- core の skyView LUT を方向で引く（Hillaire 式の非線形な仰角のマッピング）
- 太陽円盤：角半径 0.27°、周縁減光 u=0.6。放射輝度は transmittance LUT から出すので、日の出はオレンジ
- 月円盤：角半径 0.26°。海のノイズ（fbm の 2 オクターブを球面に張る）とアルベド 0.12
- 空のハロー：Mie の前方散乱（月にも同じ LUT を 1/2200 の強度で使う）

■ 星
- 立方体の 6 面 × 64² のセルに hash で置く。等級は Pogson 分布で約 4500 個
- 色温度は 3000〜12000K
- 大気の減光で地平の近くを消す。瞬きは地平の近くだけ
- 天の川：銀河座標で傾けた帯に fbm と暗黒帯を入れる。clear の夜だけ。月明かりで 50% 消える
- uStars は反射のときに 0

■ 雲
- 高度 1600〜2600m の slab
- 2D の weather map：RG8 512² を起動時に生成する（coverage と type）
- 3D の低周波ノイズ：R8 64³ を起動時に生成（Perlin-Worley）
- 視線の march：high 16 step（ブルーノイズの jitter）、mid 8、low は 0（2D の光るテクスチャ）
- 光の march：2 step ＋ Beer-Powder
- 位相関数：二重 HG（g 0.75 / −0.2）。多重散乱は近似の 3 オクターブ（Wrenninge）
- 空の散乱光で下面を照らし、上面は太陽色
- 雲は 1/4 解像度の RGBA16F に描き、時間方向に再投影して 4 フレームで合成する（high）。mid は 1/4 解像度で再投影なし＋bilateral upsample
- 巻雲：2D の繊維ノイズ、高度 8km、夕焼けで最後まで赤く残す

■ 天候
- cloudy：coverage 0.75、底を 900m へ下げる
- rain：coverage 1.0、底 450m、下面は暗い（アルベド 0.6、厚さ ×3）。雨の筋は下面の fbm の縦方向の引き伸ばし
- 遷移は core の cloud/rain の damp に従う

■ 雲の影テクスチャ
- weather map を太陽方向へ投影し、R8 256² ±1.5km に 2Hz で焼く
- 地面・水・木の全員がこれを使う。雲の影が山肌を流れる

if: 入力：gfx.U（LUT、sunDir、moonDir、cloud、rain、nightAmount、wind）。
出力：
- env.sky（Mesh、renderOrder -1000、layer 0 と 4。反射にも写す）
- gfx.U.ngCloudShadowTex / ngCloudShadowXform
- skyUniforms.uStars / uLinearOut
- ngSkyRadiance の上に雲を重ねた ngSkyWithClouds(dir)。水の反射の fallback が使う

禁止：独自のトーンマップと露出。

budget: high 0.45（雲 0.3 を含む、1440p）/ mid 0.3 / low 0.12

lab: lab/sky.html。24 時刻 × 3 天候のコンタクトシート（各 384×216）。上向きの魚眼と、地平から 20° の 2 構図を並べる。
合格の条件：
- 日の出と日の入りに、太陽の周りの Mie のハローと、反対側の空にビーナスベルト（ピンクの帯）と地球の影の青い帯が出る
- 夜の zenith が黒ではなく #0b1426 付近
- 雲の下面が空の青を受け、上面が太陽色
- 曇天が均質な灰色の板ではなく、明暗 1.5:1 の緩い濃淡を持つ

risks: - 雲の march が 1440p で重い → 1/4 解像度と再投影、step の上限。
- 再投影のゴースト → カメラが速く回るときは履歴の重みを下げる。
- 星がちらつく → 1px 未満の星を面積で正規化する。
- LUT と CPU の色がずれて、空と霧の色が合わない → lab で CPU 版と GPU 版の差を ΔE < 3 で自動検査する。

### water（水面：主役）
files: src/gfx/water/{surface.js, surfaceMaterial.glsl.js, clipmap.js, ripples.js, reflection.js, shoreLap.js, splash.js}, src/water.js（facade）, lab/water.html

resp: 水面メッシュと表・裏のシェーディング。平面反射のパス。屈折と吸収の合成。風の細波。突風の斑。対話の波紋（波紋シミュ）。雨の輪。岸の舐めと泡。しぶきのパーティクル。Water facade の全 API（surfaceY/surfaceNormal/addRipple/addSplash/update/capture*/getUnderwaterContext/setUnderwaterView/uniforms.uLinearOut/causticsUniforms/rt/reflRT）。

tech: ■ 幾何
- カメラに追従する clipmap。5 リング × 128×128 quad、最小 0.25m、リングごとに 2 倍。1 リング約 66k 頂点
- xz をスナップし、リングの境界はモーフで継ぐ
- 範囲は「汀線 + 72m」ではなく、湖の最大汀線 172m + 余裕で ±200m を覆う
- 陸は ngShoreDist > 0.6m で discard する
- 頂点の変位は waveGLSL({prefix:'ng'}) の 5 本の Gerstner × shoalGain(depth) × wind。CPU の surfaceY と同じ関数で、変位はこれだけ
- 深さは ngHeightTex から引く

■ 法線
1. 波の解析的な微分
2. 細波
   - 起動時に GPU で JONSWAP スペクトル（風 2〜6 m/s）から 256² の法線タイルを 3 枚作る。波長 0.3〜4m、周期ループあり
   - 3 スケールでスクロールし、強さ = ngGust(xz)·rain_boost
   - 突風の弱い所は鏡のまま残す（cat's paw の斑）
   - 桟橋の風下と岸の近くの風の陰：ngShoreDist と風向きで弱める
3. 波紋シミュの法線
4. 雨の輪
   - 遠景：ringTex（手続きの 4 セル × 4 位相）を hash 配置する
   - 近景：波紋シミュへの注入
5. 合成は RNM（reoriented normal mapping）

距離による滑らかさ：法線の分散 σ² を距離と mip から推定し、roughness = sqrt(0.02² + σ²)（LEAN/Toksvig）。遠景のモアレを消し、夕日のきらめきの帯を正しく伸ばす。

■ シェーディング（表）
- F = Schlick(F0 0.02)。粗さで補正する
- 反射 L_r = reflRT(uv_scr + N.xz · 0.035 / max(viewZ·0.02, 1), lod = roughness·6)
- reflRT の外や、鏡映の深度が無効な所は ngSkyWithClouds(reflect(V,N)) で埋める
- 近景の法線の歪みは距離でフェードする
- 屈折
  - uv_t = uv + N.xz · k · saturate(Δd/4)
  - サンプルした深度が水面より手前なら、歪みの無い uv に戻す（岸の木が滲むのを防ぐ）
  - 水の中の光路長 d = linearDepthCopy − 水面の深度。水中の点の輝度は、opaque の段階で ngUnderwaterAtten と caustics を受けている
  - T = exp(−σ_t·d)
  - L_t = sceneCopy · T + L_in·(1 − T)
  - L_in = (σ_s/σ_t) · (E_sky_uw · 0.33 + sunRadiance_refracted · HG(0.6) · ngTerrainShadow · ngCloudShadow)
  - 結果：浅場は底の色、3〜6m はテールグリーン、深場は青黒
- 太陽と月の鏡面：GGX（sun 円盤を area light として近似。roughness を太陽の角半径で広げる）× sunRadiance × 近景の影
  - 水面は ShaderMaterial に lights:true と UniformsLib.lights を付け、getShadow を呼ぶ。桟橋と釣り人の影できらめきが欠ける
- 岸の舐め（shoreLap）
  - waveField の shoreRunUp(x,z,t,wind) を CPU・GPU 共通で使う
  - 汀線から 0〜0.6m に、細い泡の線（手続きの泡ノイズ、白 0.7）と、引き波の濡れの帯を出す
  - 湖なので泡は細く、量は控えめ
- 最後に ngApplyAtmosphere

■ シェーディング（裏：水中から見上げたとき）
- Snell の窓：臨界角 48.6°
- 窓の中：sceneCopy を屈折 uv で引き、ngSkyWithClouds と Fresnel で合成する
- 窓の外：全反射で ngMedium の散乱色と、湖底の近似色（深度に応じた暗さ）
- 窓の縁は法線でゆらぎ、虹色は出さない

■ 波紋シミュ
- h_{t+1} = (2h_t − h_{t−1} + c²Δt²∇²h)·(1 − 0.012)
- addRipple(x,z,size,dur)：振幅 = 0.012·size、半径 = 0.1·size で注入。満杯のときは古いものから捨てる。例外は出さない
- low：解析的な輪の decal を 24 個（旧版と同等）

■ しぶき（splash）
- GPU パーティクル 256 個の ring buffer
- 重力と空気抵抗。着水時に ripple を注入
- 照明は ngSky と太陽で、透過気味
- layer は LATE

if: 入力：
- core U：waterTime、wind（見た目）、sunRadiance、LUT、ngHeightTex、ngShoreDist、medium、shadow、cloudShadow、terrainShadow
- pipeline：sceneColorCopy、linearDepthCopy、reflRT

出力：
- Water facade（契約の §4.3 をすべて）
- surfaceY = 陸（depthAt ≤ 0）では 0。水では waveHeight × shoalGain × wind（waveField.js をそのまま使う）
- reflection pass（pipeline に登録）
- ngSkyWithClouds の利用
- getUnderwaterContext → { strength, time, sunDir, night, rain, cloud, absorb=σ_a, camPos, camNear, camFar, waterY=surfaceY(cam) }
- causticsUniforms は game.js で作った同じオブジェクトへ .value を書く（生成は underwater モジュールの caustics）

budget: high 2.6（反射のパス 1.4 ＋ 水面 0.95 ＋ シミュ 0.15 ＋ しぶき 0.1）/ mid 1.8（反射 0.9）/ low 0.9（反射 0.4 を 2 フレームに 1 回）

lab: lab/water.html。構図は次のとおり。
- 桟橋から真下（noon-fp-down と同じ）：底と深場への色のグラデーション
- 桟橋からの水平視（morning-fp と同じ）：対岸の森の鏡像、突風の斑
- 夕日の逆光：きらめきの帯
- 岸の浅場（noon-shore と同じ）：底の caustics と岸の舐め
- 雨：雨の輪が全面に出る
- 夜の灯籠：映り込みの縦長の帯
- 水中から見上げる：Snell の窓
合格の条件：
- 反射の輝度 ≈ 空の輝度 × Fresnel（地平付近 0.4〜0.6、真下 0.02〜0.05）。真下を見たとき、2m の浅場で底の石が識別できる
- 5m でテール、10m 超で青黒
- 突風の斑が水平視で 3〜6 枚見える
- surfaceY と GPU の変位の差が 1mm 未満（lab のテストが float RT に読み出して検証する）

risks: - 屈折の滲み：水面の手前にある物が、歪みの uv に入り込む → 深度で判定して戻す。
- 反射と屈折のコピーの帯域：1440p の RGBA16F → mid/low は 0.5 解像度。
- 鏡映カメラの斜めクリップ面が、tone の違う物を切る → clip の y を 0.02 にし、水面下の物は layer で除く。
- 1 フレームの時刻のずれ（CPU は前のフレームの water.time）→ 契約どおり。ウキは GPU 側で同じ前フレームの時刻を使う必要は無い（差は 1 フレームで数 mm）。
- 低品質でも鏡像を失わないこと（アート上の生命線）。

### underwater（水中の見た目と caustics）
files: src/gfx/underwater/{caustics.js, causticsGen.glsl.js, volume.js, underwaterEffect.js, marineSnow.js}, src/shaders.js（CAUSTICS_GLSL の再実装）, lab/underwater.html

resp: caustics の生成（毎フレーム）と、共有の uCaust* 16 個の意味の再定義。CAUSTICS_GLSL の causticLight（魚との契約）。水中のボリューム散乱と god rays。水中の後処理 NgUnderwaterEffect（postfx.updateUnderwater(ctx) の受け口）。マリンスノー。水面近くの泡。

tech: ■ caustics の生成
- 256² の格子メッシュを、波の場（waveGLSL の低周波＋細波の JONSWAP タイルの法線）で屈折させる。基準深度 3m の面へ投影し、Evan Wallace 式に面積の比（dFdx/dFdy のヤコビアン）で明るさを出す
- 加算で RG16F 512² のタイル（周期 8m）へ描く。R と G は深度 1.5m と 6m の 2 層。深くするほどぼける
- high は 3 チャンネルで少しずらして分光（R/G/B で屈折率 1.331/1.334/1.338）
- 更新は high 30Hz、mid 15Hz。low は起動時に 8 フレームを焼いた配列を補間する
- 雨と曇りで弱める。強さ ∝ sunRadiance·ngCloudShadow

■ causticLight(worldPos, viewNormal)（契約。y > −0.02 は 0）
- 太陽の屈折方向へ投影した xz で caustics タイルを引く
- 深度による減衰：exp(−σ_t·depth)
- 法線の上向き成分で重みを付ける（viewNormal を viewMatrix の転置で world に戻す）
- uCaust* 16 個：名前はすべて残す。uCaustTex=タイルの RT、uCaustScale=タイルの周期、uCaustDepth=2 層の深度、uCaustStrength=品質と時刻の総合など
- ng 側の ngCaustics と同じ関数本体を共有する（文字列の二重定義は避け、ngCaustics は CAUSTICS_GLSL の関数を呼ぶだけ。魚と地形が同じ明るさになる）

■ 水中の媒質
- 全マテリアルの ngApplyAtmosphere が水中の分岐へ入る
  - L = L0·exp(−σ_t·d) + L_in·(1 − exp(−σ_t·d))
  - L_in = 散乱の色 × (空の照度の水中値 + 太陽 × HG(g 0.85) × 深度減衰)
- 水平の視程：晴れ 18m、雨 8m

■ god rays
- 半解像度（high）/ 1/4（mid）で、カメラから 24 / 12 step
- 各点の光 = caustics タイル（ぼかした mip）× ngTerrainShadow × exp(−σ_t·depth)
- ブルーノイズの jitter と、4 フレームの時間方向の蓄積
- low は画面空間の放射ブラー（窓の方向から 8 tap）

■ NgUnderwaterEffect
- 水面が画面を横切るときの境界線：カメラの近くの水面の高さ surfaceY で判定し、画面空間で波打つ線にする。上半分は空気、下半分は水
- レンズの水滴は無し
- 弱い色収差は無し（アート方針）
- 軽い uv のゆらぎ（振幅 0.0015）

■ マリンスノー
- カメラ周りの 20m 立方体の中で wrap する
- 3000 / 1500 / 400 粒
- 散乱光で照らす

if: 入力：core U（medium、sunDir、waterTime、wind）、water の波の場の GLSL、pipeline の linearDepth。
出力：
- causticsUniforms の .value（game.js で作った同じ参照）
- shaders.js の CAUSTICS_GLSL と causticLight
- ngCaustics
- pipeline の P7 pass
- postfx.updateUnderwater(ctx) の実装
- terrain.underwaterProps{group, activeCounts}：水中プロップの group（マリンスノー、泡）

budget: high 1.1（水中にいるとき。caustics 生成 0.15 は常時）/ mid 0.7 / low 0.3

lab: lab/underwater.html。構図は次のとおり。
- 水深 2m / 6m / 15m で、水平・見上げ・見下ろし
- 水面の境界の横切り
- caustics が当たった灰色の球と魚のテスト体（fish.js の createFishMaterial を使う）
合格の条件：
- 魚と湖底の caustics の明るさが一致する
- 6m で青緑に沈み、15m でほぼ無彩の暗い緑
- god rays が窓の方向から収束する
- 夜は caustics が 0 で、月明かりの弱い散乱だけ

risks: - 共有 uniform の名前の衝突：魚が CAUSTICS_GLSL を自分で入れているので、ng の注入は causticLight を再定義しない。
- caustics の加算の過剰 → strength を上限 0.8 に抑える。
- 水面の境界を画面空間で判定すると、カメラの傾きで破綻する → 近平面の 4 隅の surfaceY で線を引く。

### terrain（地形のメッシュと素材）
files: src/gfx/terrain/{mesh.js, heightWorker.js, materialArray.js, terrainMaterial.glsl.js, canopyShell.js, bed.js}, src/terrain.js（facade：数学とゲームの API はそのまま lake へ委譲）, lab/terrain.html

resp: 地面と湖底のメッシュ。見た目は lake.heightAt に一致させる。素材 8 層のテクスチャ配列（起動時に GPU で生成）。生態学的な splat。崖の triplanar。岸の濡れの帯。遠い山肌の樹冠シェル。湖底の底質（mud/sand/rock を lake.bedAt に合わせる）。Terrain facade の全 API（数学系はコンストラクタの直後から使えること）。

tech: ■ メッシュ
- 高さは Web Worker の heightAt で評価する
- 3 つの帯
  - 内側：±260m、1m 格子。271k 頂点。ただし岸の 30m 帯はさらに 0.5m へ細分する
  - 中間：±520m、4m
  - 外側：±1000m のスカート、16m
- 帯の境界は T 字接合を避けるため、stitch strip で継ぐ
- 32m の chunk に分けて視錐台カリング
- 法線は解析の差分で出す（中心差分 0.5m）
- 変位は加えない。ディテールは法線のみで、見た目の凹凸は ≤3cm 相当（魚のクランプとの契約）

■ 素材の配列
- 1024² × 8 層。2 枚の配列：A=albedo＋height、B=normal.xy＋rough＋AO。RGBA8、mip あり
- 起動時に GPU の fragment で生成する：ノイズ、Voronoi、粒状の分布
- 8 層：苔と土、落葉（ブナの葉と針葉）、苔の塊、砂（汀の白い砂利まじり）、礫、泥とシルト（湖底）、花崗岩と安山岩、濡れた黒土

■ splat
- placement の ecology 場（標高、傾斜、汀線距離、斜面の向き、湿り気、林冠の密度）から、1024² ±512m の RGBA8 × 2 を起動時に焼く
- 高さを使った blend（height-lerp）で、境界を自然に噛み合わせる
- タイルの繰り返しを隠すため、2 スケール（1.3m と 7.1m）＋ stochastic なタイル回転（hash のセル）＋ マクロの色むら（200m の fbm）

■ 崖
- slope > 0.85 で triplanar の岩に切り替える。縦の筋を入れる

■ 岸
- ngShoreDist と waveField.shoreRunUp の最大遡上から、濡れの帯（albedo × 0.6、rough 0.15）を出す
- 水の縁の 0〜0.4m は、砂または泥の層へ寄せる

■ 湖底
- bedKind で泥・砂・岩
- 深くなると色を落とすのは媒質なので、アルベドは上げたまま（泥 0.10〜0.14、砂 0.25〜0.32）
- 注入 4 の caustics を受ける

■ 遠景の樹冠シェル
- 400m より先で、森の密度が高いところは、地形のシェーダが「樹冠の凹凸」を出す
  - 法線は球状の粒の Voronoi
  - 色は樹種の塊（スギ・ヒノキの帯は暗い緑 0.045、広葉樹は明るい緑 0.09、初秋は season で少し黄とカエデの赤を混ぜる）
- 樹冠の高さは ngTerrainShadow にも入る
- 400〜700m では impostor と混ぜる

if: 入力：lake、core U、placement の ecology 場。
出力：
- Terrain facade：heightAt 系、structureNear、onDock、dockBlocksSegment、obstacles、lineBlocked ほか §4.2 のすべて
- load*Textures は null を返す Promise
- updateWind / updateTrees / updateLamp / updateUnderwaterProps / updateShore / setQuality / setLodScale：各モジュールへ配る
- overWaterProps / underwaterProps / waterPlants を集めて facade に出す
- heightTexture（ngHeightTex を指す）

budget: high 1.3 / mid 0.9 / low 0.55

lab: lab/terrain.html。構図は次のとおり。
- 岸に立って汀線を見る
- 対岸の斜面を 300m から
- 空撮の俯瞰
- 崖のクローズアップ
- 湖底の水深 2m
合格の条件：
- 50m 先でタイルの繰り返しが見えない（FFT のピーク検査を lab に付ける）
- 汀線の濡れの帯が波に合わせて 1m 以内で動く
- 山肌が「植林の暗い帯＋広葉樹の明るいパッチ」に読める
- heightAt と描画の差が内側の帯で 2cm 以内（raycast の検査）

risks: - Web Worker 内の heightAt が遅い → 内側の帯を 4 並列に分ける。見積もりは 300k 回 × 約 3µs = 0.9 秒 / 4。
- 配列テクスチャのサンプラー数 → 地形のシェーダは 8 サンプラー以内（MAX 16 の半分）。
- 帯の継ぎ目の亀裂。

### forest（樹木）
files: src/gfx/forest/{species.js, treeGen.js, bark.js, leafAtlas.js, impostor.js, forestSet.js, forestMaterial.glsl.js}, lab/forest.html

resp: 8 樹種 × 3 変種の手続きの樹木。LOD0 / LOD1 / impostor。葉のテクスチャの手続き生成。風の揺れ。透過光。影（近景の影マップに落とす）。遠景の impostor。placement の木の配置を描く。当たり（幹）は placement が持つので、forest は描くだけ。

tech: ■ 樹種と配色（線形アルベド）
- スギ：円錐形の尖った樹冠、赤褐色の縦に裂けた樹皮。葉は暗緑 (0.028, 0.050, 0.030)
- ヒノキ：丸みのある尖り、鱗状の葉。(0.032, 0.058, 0.032)
- アカマツ：尾根に立つ。曲がった赤い幹、傘状の樹冠
- ブナ：灰白の平滑な樹皮と地衣の斑、明るい葉 (0.07, 0.11, 0.035)
- ミズナラ
- イロハモミジ：season で赤へ
- ヤナギ：垂れる枝。水辺
- ハンノキ：水辺

■ 生成
- 旧 treeSkeleton の考え方（空間コロニゼーション／L-system の混成）を三つを使わない純 JS で新しく書く
- 枝：平行移動フレームのチューブ
- 葉：塊ごとのカードのクラスタ。カードの法線は樹冠の球状の法線で置き換え、ふわっとした陰影にする
- 葉のアトラス：2048²（high）/1024²。RGBA8（albedo＋α）と、法線・透過・AO。起動時に GPU で葉の形を描く

■ LOD
- LOD0：8〜14k 三角形。high <45m、mid <32m、low <20m
- LOD1：1.5〜2.5k 三角形。<170m / 130m / 90m。葉のカードをまとめ、幹は 6 角
- LOD2：hemi-octahedral impostor
  - 8×8 ビュー × 64²（high）→ 1 変種 512²。24 層の配列を 2 枚（albedo＋α、法線＋深度）。約 50MB（mip 込み）
  - mid は 6×6 × 48²、low は 4×4 × 48²
  - 起動時にオフスクリーンで焼き、ビュー間は 3 フレームの blend
  - 距離 <700m（mid 550、low 400）
- LOD の境界：ディザのクロスフェード 6m（ブルーノイズ）

■ 数（placement の出力。品質で描く本数だけを変え、配置は同じ）
- 描画 rank < 1.0 / 0.7 / 0.45
- LOD0 ≈ 250、LOD1 ≈ 2500、impostor ≈ 25k（high）
- InstancedMesh は 種 × 変種 × LOD のバケット
- cell（32m）単位で rebuild を間引く（10Hz、1 フレームで最大 4 cell）

■ シェーディング
- MeshStandardMaterial ＋ gfx.patchMaterial({wind, wet, farShadow, skyVis, translucency})
- 透過光：薄い葉の透過 = albedo·transColor·max(0, −N·L)^… の wrap に、背景の sun を HG(0.5) で加える（逆光の輝き。夕方の森の縁が光る）
- 自己陰影：樹冠内の深さ（頂点属性）で ambient を落とす
- 風：3 段の揺れ（幹の曲げ、枝の揺れ、葉の震え）。ngWindAt と ngGust の同じ場。スギは硬く、ヤナギは大きく

■ 影
- LOD0 と LOD1 は近景の影マップに落とす（customDepthMaterial で α 付き）
- impostor は落とさない（遠景は ngTerrainShadow の樹冠の高さで代える）

if: 入力：placement の trees 配列（x, z, y, species, variant, scale, rot, rank, lean）、core U、wind。
出力：
- group（layer 0。遠景の反射の代理は layer 4 にしてもよい）
- terrain.overWaterProps に入れるメッシュ
- update(cameraPos)

budget: high 2.8（影 0.5 を含む）/ mid 1.9 / low 1.1

lab: lab/forest.html。構図は次のとおり。
- 1 本ずつの回転台（8 種 × 3 変種）。夕方の逆光と昼の順光
- 林縁を 30m から
- 山肌を 400m から（impostor とシェル）
- 樹冠の下から見上げる
合格の条件：
- シルエットで樹種が識別できる（スギの尖った帯、ブナの丸い塊）
- LOD の切り替えがポップしない（録画のフレーム差分）
- 逆光で葉の縁が光る
- 影の中の葉が真っ黒にならない（輝度 ≥ 空の照度 × 0.02）

risks: - impostor の焼きのメモリと起動時間 → 配列テクスチャに 1 回だけ焼き、0.8 秒以内（24 変種 × 64 ビュー）。
- alpha to coverage は MSAA が無いと使えない → mid/low は mip ごとの α の補正。
- 幹の見た目の太さ × 1.15 と当たりの一致 → placement が太さを決め、forest はそれを使うだけ。
- インスタンス行列の再アップロードの CPU 負荷。

### groundcover（下草・笹・シダ・藪）
files: src/gfx/groundcover/{grass.js, sasa.js, fern.js, shrubs.js, groundcoverMaterial.glsl.js}, lab/groundcover.html

resp: 草（スゲ、ススキの穂は初秋）、クマザサ、シダ、低木（ツツジ、ウツギ）、落ち枝。歩ける帯の境目の藪の輪（見た目。当たりは placement）。林床と岸の草地の見た目。

tech: ■ GPU の手続き配置
- ngGroundcoverMask（RGBA8 1024² ±256m：草、笹、シダ、花）を placement が焼き、それを読む
- カメラの周りを 1m / 2m のセルで覆うリングのインスタンス。インスタンス ID → セルの xz → hash で jitter → マスクで存在の確率を決め、無ければ頂点を退化させる
- 高さは ngHeightTex と法線から出す

■ 草
- 1 株 = 8〜16 枚のテーパーした刃。1 枚 5 頂点
- 数：high 120k 株 <60m、mid 50k <40m、low 12k <22m
- 遠くは株を減らし、刃を太くして面積を保つ
- 地形の色と根元の色を ngPalette で一致させる（地面から浮かない）

■ 笹：葉のカードを 6〜10 枚。20k / 10k / 3k

■ シダ：放射状に広がる葉。6k / 3k / 1k

■ 低木：placement の固定のインスタンス（藪の輪の当たりと同じ x, z）。小さな葉の塊の LOD 2 段

■ シェーディング
- 簡易な MeshStandard ＋ 透過光 ＋ wind。近景の影は受けるが落とさない（草は影を落とさない。低木は落とす）
- 端の α は high では alphaToCoverage
- 反射には写さない（layer 3）

if: 入力：placement の groundcover マスク、藪の配列、core U。
出力：update(camera)、group（layer 3）、terrain.overWaterProps。

budget: high 1.3 / mid 0.85 / low 0.3

lab: lab/groundcover.html。構図は次のとおり。
- 一人称の目の高さで林床
- 岸の草地
- 藪の輪（歩ける帯の境目）を 10m から
- 雨で濡れた状態
合格の条件：
- 地面と草の根元の色の差が ΔE < 6
- 60m 先で草が消える縁が見えない（密度と色のフェード）
- 藪の輪が「自然な茂み」に見え、見えない壁として機能する高さ（≥1.2m）

risks: - 頂点シェーダの負荷（120k × 50 頂点 = 6M）→ 遠くの LOD の刃を 2 枚に減らす。
- 草が水中に生える → マスクは depth < 0 で 0。
- 動くリングのインスタンスでのちらつき → セルを世界に固定し、hash で決定的にする。

### aquatic（水生植物）
files: src/gfx/aquatic/{reeds.js, lilies.js, submerged.js, aquaticMaterial.glsl.js}, lab/aquatic.html

resp: ヨシ（抽水）、マコモ、ヒツジグサとヒシの浮葉、クロモとエビモの沈水植物。藻場（lake.flats）を水草で覆う。水深 ≤ 1.5m の縁にヨシを置く（図鑑の «葦際» と «藻場»）。terrain.waterPlants{submergedMeshes}。

tech: ■ ヨシ
- 茎：インスタンスのテーパーしたリボン（6 節、12 頂点）＋ 葉 4〜6 枚。初秋は穂
- 数：high 50k 本 <80m、mid 25k、low 8k
- 遠景：株のカード
- 配置：placement の reedBeds（ワンドの凹んだ岸、水深 0〜1.5m、泥底、波当たりが弱い所）。株の塊は Poisson の 2 段
- 水面との交線：水面の高さ（waveGLSL）で根元を濡れた色に。波で茎の根元をわずかに揺らす
- 反射に写す（LOD1）

■ 浮葉（ヒツジグサ）
- 切れ込みのある円盤（16 頂点）
- 数：4k / 2k / 600、白い花が数十
- 水深 0.6〜2.5m の泥底で、風の陰
- 頂点の y = 同じ波の関数で浮かせる（CPU の surfaceY と同じ）
- 水面の法線に沿って傾ける。ぬれた光沢、rough 0.25
- 水面の上に乗るので layer 0 に置き、水の後の深度で正しく出る。水面のわずかに上 +0.01m

■ ヒシ：ロゼットを 1k

■ 沈水植物（クロモ）
- 流れで揺れる帯（8 節）
- 数：high 20k、mid 10k、low 3k
- lake.flats の円の中はすべて覆う。泥の 1.5〜5m に点在
- 水中の媒質と caustics を受ける
- layer 3（反射に写さない）

■ シェーディング：patchMaterial（underwater の減衰、caustics、wet）

if: 入力：placement の reedBeds / lilyBeds / weedBeds、lake.flats、waveGLSL、core U。
出力：
- terrain.waterPlants{submergedMeshes}
- overWaterProps（ヨシ）
- update(dt, cameraPos, flow)

budget: high 0.85 / mid 0.55 / low 0.25

lab: lab/aquatic.html。構図は次のとおり。
- 桟橋からヨシ原を見る（夕方の逆光で穂が光る）
- 浮葉の群落を見下ろす
- 藻場の水中
- 雨の浮葉
合格の条件：
- lake.flats の円がすべて水草で覆われている（lab で上から見て検査する）
- ヨシが水深 ≤ 1.5m の外に無い（placement のテスト）
- 浮葉が水面から浮かず、沈まない（±1cm）

risks: - 浮葉と水面の z-fighting → 浮葉を +0.01m 上げ、polygonOffset を使う。
- ヨシの密度と頂点の負荷。
- 水中で植物の色が明るすぎる → 媒質の減衰は注入で自動的にかかる。

### rocksprops（岩・桟橋・小物・ストラクチャー）
files: src/gfx/props/{rockGen.js, rocks.js, dock.js, lamp.js, boat.js, structures.js, driftwood.js, propsMaterial.glsl.js}, lab/props.html

resp: 大岩、玉石、小石。苔むした岩。風化した木の桟橋（杭、桁、床板、手すり、先端の手すりの箱）。灯籠（r0.26、top dockY+2.3）。小舟（和船）。沈み岩と立ち枯れ（lake.structures の x, z に正確に置く）。流木。灯籠の PointLight（core が作った固定の 1 灯を動かす）。

tech: ■ 岩
- icosphere（subdiv 5）に、ridged のノイズ、角の欠け、熱侵食の 20 回、窪みの AO を加える（純 JS）
- 12 形 × 3 LOD（5k / 1.2k / 300 三角形）
- 素材：花崗岩と安山岩の triplanar（terrain の配列テクスチャを共有）
- 苔：上向きの面 × 湿り気 × 北向き × 林冠の密度
- 水際：水位 ±0.3m に藻と濡れの帯
- 水中：シルトの被り
- 数：大岩 300、玉石 8k / 4k / 1k、小石 20k / 8k / 2k

■ 桟橋
- 床幅 3.4m。床の上面 = dockY。床板は 1 枚ずつ、幅と高さと反りを乱数で変え、隙間 1cm
- 杭は丸太で、濡れの帯と藻
- 素材：スギ材の銀灰色の風化（アルベド 0.28、灰から茶へのむら）、木目の手続き
- 雨で濡れて暗く光る
- 寸法は契約どおり（onDock の |si| ≤ 1.62、先端 2.3m の手すり、y ≤ dockY+1.05）

■ 灯籠：石の灯籠。夜は火袋から 2200K の光（intensity は nightAmount で上げる。dt を使い、ポーズ中は止める）

■ 小舟：木の和船。水に浮き、同じ波の関数で上下と傾き

■ ストラクチャー
- 沈み岩：r × 1.15、top = 湖底 + h
- 立ち枯れ：白く晒された幹と枝。水面下に収める
- どちらも lake.structures の x, z, rot, h, r に正確に合わせる

if: 入力：placement の rocks / boulders / cobble / structures / dock frame / lamp / boat、core U。
出力：
- group
- structures のメッシュ
- updateLamp(night, dt)
- underwaterProps の group の一部

budget: high 0.85 / mid 0.55 / low 0.3

lab: lab/props.html。構図は次のとおり。
- 桟橋を三人称で（dawn-3p、dusk-3p と同じ）
- 雨の桟橋
- 夜の灯籠
- 水辺の苔むした大岩
- 水中の立ち枯れ
合格の条件：
- 桟橋の床板が 1 枚ずつ違って見える
- 灯籠の光が水面に縦長の帯として映る
- debug.js の当たりの箱と見た目が 2cm 以内で一致する

risks: - 桟橋の寸法を変えると debug.js と onDock がずれる → 寸法は変えない。
- 灯籠の PointLight の intensity の変化は再コンパイルを起こさない（数は固定）。

### weatherfx（雨・霧・大気の小物）
files: src/gfx/weatherfx/{rain.js, rainSplash.js, mistCards.js, motes.js, fireflies.js}, lab/weatherfx.html

resp: 雨の筋、地面と桟橋の雨の飛沫、雨の輪を波紋シミュへ注入、朝霧のカード、光の中の塵と花粉、夏の夜のホタル（season < 0.3、晴れの夜だけ）。env.rain（Object3D）。env.underwater で雨を隠す。

tech: ■ 雨の筋
- カメラ中心の円柱（半径 25m、高さ 20m）の中で wrap する
- instanced quad：8k / 4k / 1.5k
- 長さは速さ × 露光 1/60 秒。ngWind で傾ける
- 照明：空の照度（SH）と灯籠。逆光で明るくする
- 深度でソフトに消す（soft particle）
- layer は LATE（反射には写さない）

■ 飛沫
- 地面と桟橋に、GPU の flipbook の輪を 1024 / 512 / 128
- 位置は高さの場から
- 水面へは 1 秒に 60 点、波紋シミュへ注入する

■ 朝霧のカード
- 水面の上 0.5〜4m に、大きなソフトなカード 60 / 30 / 0 枚
- 風で流す
- 深度でソフトに消し、カメラに近づくと透明にする
- 前方散乱で太陽側を光らせる
- core の lake mist と同じ密度の場で重みを付ける

■ 塵：光の中の 400 粒

■ ホタル：ヨシ原の上に 150 点。発光（emissive）で bloom に乗る

if: 入力：core U（rain、wind、wetness、mist の密度、sunDir）、water の addRipple（またはシミュへの直接注入）、高さの場。
出力：
- env.rain
- update(dt, camera)
- LATE の group

budget: high 0.65 / mid 0.4 / low 0.2

lab: lab/weatherfx.html。構図は次のとおり。
- 雨の一人称（rain-fp と同じ）
- 雨の夜の灯籠
- 朝霧の日の出（dawn）
合格の条件：
- 雨の筋が画面の 10% 以上を白くしない
- 朝霧が層として読め、カードの縁が見えない

risks: - 透明の overdraw（1440p）→ 画面に近い筋を減らす。
- 霧のカードが地形と交差したときの縁 → soft particle で消す。

## gameplayContract
■ 配置と当たりの層：src/gfx/world/placement.js（three を使わない純 JS。Node でテストできる）
- 入力は lake と seed だけ。Math.random は禁止
- 乱数は系統ごとの独立した列：makeRng(hash(seed, 'tree' | 'rock' | 'bush' | 'reed' | 'lily' | 'weed' | 'cobble' | 'grass'))
- 配置の方法：2D の jittered grid（セルごとに hash）で候補を作り、ecology 場で採否を決める。各候補に rank ∈ [0,1) を付ける
- 品質は「描く rank の上限」だけを変える。配置の列は全品質で同じ

当たりを持つものは rank に関係なく全品質で同じにする。
- 幹：歩ける帯の中と FAR_GATE 以内。当たり半径 = 見た目の幹の太さ × 1.15（最小 0.28）、上端 = 0.9 × 樹高
- 大岩：size > 1.4 かつ h > −0.9
- 藪の輪：r 0.55、shoreRadius + 72 − 5 〜 +4
- 灯籠：r 0.26、top dockY+2.3
- 小舟：2 × r 0.85
- 沈んだストラクチャー：r × 1.15、top = 湖底 + h

空けておく範囲：木と岩は桟橋から 3.4〜3.6m、スポーンから 6m。

出力（typed array）：trees、boulders、cobbles、bushes、reedBeds、lilyBeds、weedBeds、structures（lake.structures をそのまま写す）、obstacles。

Terrain facade は、この obstacles で addObstacle と _obsGrid（8m ハッシュ）を組み立てる。Terrain のコンストラクタの中で同期的に完了させる（_initMap が直後に shoreRadius を呼ぶので、数学系の API もすぐ使える）。

ecology 場（評価関数）：標高、傾斜、汀線距離、斜面の向き、湿り気（fbm と、凹みの curvature）、ワンドの度合い（shoreAtAngle の局所の凹み）。
樹種の選び方（確率の表）：
- 汀線 0〜12m：ヤナギとハンノキ
- 12〜60m、傾斜が緩い：ブナ・ミズナラ・カエデ
- 植林のパッチ：100〜300m の四角い区画（placement のノイズの閾値）はスギ・ヒノキを密に列で
- 標高 > 90m：アカマツと露岩

■ 藻場とヨシ
- weedBeds は lake.flats の円を必ず含む（テストで網羅率 ≥ 95%）
- reedBeds は水深 ≤ 1.5m の中だけ（テスト）

■ 桟橋
- 寸法は変えない：床幅 3.4、歩ける半幅 1.62、手すりの先端 2.3m、床の上面 ≈ dockY
- onDock、dockBlocksSegment、debug.js:110 と 144-145 をそのまま使う
- 見た目の dock.js は facade の _dockU / _dockLen / _dockLocal から作る

■ 波の物理
- waveField.js は変えない。GPU は waveGLSL({prefix:'ng'}) を使う
- surfaceY(x,z) = depthAt ≤ 0 なら 0、それ以外は waveHeight(x,z,time,wind) × shoalGain(depth)（旧の式と同じ）
- 見た目の変位は、この低周波の 5 本だけにする。細波・雨・波紋は法線だけ
- lake-calm-water-test の前半（波の検査）はそのまま通す
- 一致の検査：lab/water-parity.html
  - 100 点の xz で、GPU の頂点シェーダの変位を transform feedback（または float RT）に書き出し、CPU の surfaceY と比べる
  - |Δ| < 1mm を合格にする

■ caustics（魚との共有）
- game.js が作る causticsUniforms（16 個の uCaust*）は、同じオブジェクトのまま
- underwater モジュールが毎フレーム .value を書く
- shaders.js の CAUSTICS_GLSL は causticLight(vec3 worldPos, vec3 viewNormal) を宣言し、y > −0.02 は 0
- fish.js の注入の形（#include <common> の後、#include <emissivemap_fragment> の後）はそのまま効く
- ng の注入は、causticLight を持つシェーダでは caustics を重ねない（二重を避ける）
- ng の GLSL はすべて接頭辞 ng。csWave* と uCaust* は再宣言しない

■ Facade の対応
- Environment（src/sky.js）
  - constructor：createGfx を呼び、sky / rain / sun を作る。scene.fog = new THREE.Fog を持つ
  - update(dt, hour, camera, focus)：gfx.beginFrame
  - tickWeather：旧 sky.js:317-334 の抽選をそのまま移植する（重み、同じ天候は × 0.35、2.5〜6.5h）
  - setWeather（不正なキーは無視）、weather、weatherTimer、rainIntensity / cloudiness（damp λ 0.35 / 0.4）
  - nightAmount、sunDir / keyDir（in-place）、sunColor ほかの Color
  - underwater の setter
  - skyUniforms
  - sun：DirectionalLight。shadow.map を perf が読む
- Terrain（src/terrain.js）：上記
- Water（src/water.js）：上記。capture / captureReflection は安全な no-op と予約フラグ。rt = sceneColorCopy（RT）、reflRT = 反射の RT、uniforms.uLinearOut
- PostFX（src/postfx.js）：constructor で pipeline を作る。setSize / setQuality / updateUnderwater / render(dt)。composer と bloom を公開する（performance.js の見積もり用）

■ debug.js の互換
- scene.fog.near / far は数値
- _dockU / _dockLen / _dockLocal、obstacles、_obsGrid
- debug のオブジェクトは renderOrder 900、depthTest false → classify で LATE に入るので、全パスの最後に写る

■ game.js の最小の変更
- markLate(marker / aimMarker)
- build の最後に gfx.adopt(scene)
- applyQuality でマテリアルの配列にも needsUpdate を立てる
- ?v= 付きの import はそのまま
- 読み込みの文言の順（Sky → Lake → Bed → Water → …）も変えない
  - Bed の段で、Terrain の中の Web Worker の heightfield と、テクスチャ配列の生成を await する
  - 各段で await して描画の機会を譲る

## assets
■ 方針：リポジトリに入れるバイナリは 0 バイト
- 環境のテクスチャとモデルは、すべて起動時に手続きで作る
- assets/textures/* は削除する
- 例外として許すもの：オフラインの Node スクリプト（scripts/gfx/bake/*.mjs）で作った小さな LUT やブルーノイズ。上限は合計 256KB。これも起動時に作れるなら作る

■ 起動時の生成（M1 Pro の目標：追加の読み込み時間 ≤ 6 秒）
| 項目 | 方法 | サイズと形式 | 時間の目安 |
|---|---|---|---|
| heightfield（内側 ±260m 1m、中間 4m、外側 16m）＋ ngHeightTex 1024² ＋ ngShoreDist 512² ＋ bedKind 512² | Web Worker × 4 で heightAt | R16F / RGBA8 | 1.2 秒（並列） |
| placement（全系統）＋ ecology 場 ＋ splat 1024² × 2 ＋ groundcover マスク 1024² | 同じ worker | RGBA8 | 0.6 秒 |
| 地形の素材の配列 1024² × 8 層 × 2 | GPU の fragment → 配列の各層、mip | RGBA8、約 22MB | 0.25 秒 |
| 葉のアトラス（2048²）、樹皮（512² × 4） | GPU | RGBA8 | 0.15 秒 |
| 木のメッシュ 8 種 × 3 変種 × 2 LOD、岩 12 形 × 3 LOD | CPU（worker） | 合計 約 6M 三角形の VBO | 0.9 秒 |
| impostor の焼き（24 変種 × 64 ビュー） | GPU のオフスクリーン | 512² × 24 層 × 2 | 0.6 秒 |
| 細波の JONSWAP タイル 256² × 3、雨の輪、泡のノイズ | GPU | RG16F / R8 | 0.05 秒 |
| 雲の weather map 512² と 3D ノイズ 64³ | GPU（3D は 64 層に分けて描く） | RG8 / R8 | 0.1 秒 |
| 大気の LUT、ブルーノイズ 64²（void-and-cluster、CPU） | GPU / CPU | RGBA16F / R8 | 0.1 秒 |
| シェーダのコンパイル（renderer.compileAsync、KHR_parallel_shader_compile） | GPU | — | 1.0〜1.5 秒 |
合計 約 5 秒。worker と GPU を重ねて 4 秒を狙う。

■ GPU メモリの目安
- high：約 380MB。内訳は sceneRT の MSAA ×4 16F で 118MB（M1 の TBDR なので実際の帯域はもっと小さい）、コピー 30MB、反射 8MB、impostor 50MB、地形 22MB、葉 16MB、影 64MB
- mid：約 190MB
- low：約 100MB

■ low 向けの軽減
- 配列テクスチャは 512²
- impostor は 4×4
- 木のメッシュ生成は LOD1 だけ（LOD0 は作らない）

## qualityTiers
| 項目 | low | mid | high |
|---|---|---|---|
| 解像度 | DPR 上限 1、描画倍率 0.75 | DPR 上限 1.5、1.0 | DPR 上限 2、1.0（動的 0.8〜1.0） |
| AA | FXAA | SMAA（medium） | MSAA×4 ＋ alphaToCoverage |
| HDR RT | RGBA16F | RGBA16F | RGBA16F |
| 近景の影 | 1024² ±22m | 2048² ±32m | 4096² ±42m、PCF の radius 大 |
| 地形の日照 | 512²、24 step | 1024²、32 step | 1024²、48 step |
| 雲の影 | 128² | 256² | 256² |
| 空の雲 | 2D のテクスチャ | 8 step、1/4 解像度 | 16 step、1/4 解像度＋時間方向の再投影 |
| 反射 | 0.25×、2 フレームに 1 回、木は impostor だけ | 0.4×、毎フレーム | 0.5×、毎フレーム |
| 屈折のコピー | 0.5× | 0.5× | 1.0× |
| 波紋シミュ | 無し（解析の輪を 24 個） | 256²（32m） | 512²（48m） |
| caustics | 焼いた 8 フレーム | 512² 15Hz | 512² 30Hz、分光あり |
| god rays | 放射ブラー | 1/4 解像度 12 step | 1/2 解像度 24 step |
| 木の LOD0 / LOD1 / impostor の距離 | 20 / 90 / 400m | 32 / 130 / 550m | 45 / 170 / 700m |
| impostor | 4×4 × 48² | 6×6 × 48² | 8×8 × 64² |
| 木の描画 rank | 0.45 | 0.7 | 1.0 |
| 草の株 | 12k <22m | 50k <40m | 120k <60m |
| 笹 / シダ | 3k / 1k | 10k / 3k | 20k / 6k |
| ヨシ / 浮葉 / 沈水 | 8k / 600 / 3k | 25k / 2k / 10k | 50k / 4k / 20k |
| 玉石 / 小石 | 1k / 2k | 4k / 8k | 8k / 20k |
| 雨の筋 / 飛沫 | 1.5k / 128 | 4k / 512 | 8k / 1024 |
| 霧のカード | 0 | 30 | 60 |
| マリンスノー | 400 | 1500 | 3000 |
| Bloom | 3 mip | 5 mip | 6 mip |
| env probe | 32²、30 秒ごと | 64²、5 秒ごと | 64²、3 秒ごと |
| 当たり（全品質で同じ） | 同じ | 同じ | 同じ |

GPU 予算（ms）の合計の目安。
- high 1440p（M1 Pro）：15.0 ms
- mid 1080p（M1）：10.5 ms
- low 720p（Iris Xe の弱い側）：6.5 ms

core の行の内訳（high / mid / low）
- 影：1.3 / 0.8 / 0.4
- シミュと LUT：0.3 / 0.2 / 0.1
- ポスト：1.4 / 1.0 / 0.5
- キャラクター（既存）：1.0 / 0.8 / 0.6

## buildOrder
■ Phase 0：core（2 エージェント、並行）

C1（パイプラインと色）が作るもの
- context、state、uniforms
- sun と大気（CPU 版と LUT）
- lighting（SH、probe、PointLight）
- shadows
- pipeline（P0〜P9、layers、classify、コピー、反射の枠）
- post（露出、グレード、AgX、ディザ）
- patch と adopt
- NG_* の GLSL
- 仮の facade 4 本：Environment（tickWeather を移植）、Water（surfaceY と waveField、平らな水面）、Terrain（数学系 API を lake へ委譲）、PostFX
- palette.js（色彩バイブル）
- lab ハーネス、グレーカードとカラーチャート、false color

C2（世界とデータ）が作るもの
- heightfield と Web Worker
- placement（全系統と当たり）
- ecology 場と splat の焼き
- wind、weather の wetness、medium
- Terrain facade の当たり系の API（obstacles、_obsGrid、onDock ほか）
- 新しいテスト（湖のハッシュ、placement の決定性、当たりの寸法、天候の API）
- テストの並び順の整理：KEEP を先に並べ、GRAPHICS の 15 本は削除して新しいテストに置き換える

Phase 0 の完了の条件
- ゲームが灰色の地形と平らな水で、例外 0 のまま遊べる
- node scripts/run-tests.mjs が全部通る
- lab の雛形（lab/core.html）で、チャートの 24 パッチが基準の照度で表の値（±5%）
- 各モジュールのインターフェースを固定する：core/API.md を freeze し、変更は core のオーナーだけが行う

■ Phase 1：9 モジュールの並行開発
- sky、water、underwater、terrain、forest、groundcover、aquatic、rocksprops、weatherfx
- それぞれ src/gfx/<module>/ と lab/<module>.html だけを触る
- facade（src/water.js と src/terrain.js）への取り付けは、各オーナーが自分の部分だけを登録する（registerModule を経由する）
- 毎日の義務：lab の標準の構図の撮影、予算の ms の表、例外 0

依存関係
- core → すべて
- water ↔ underwater：CAUSTICS_GLSL と waveGLSL の分担は core の API.md で固定
- terrain の配列テクスチャ → rocksprops（triplanar を共有）
- placement → forest / groundcover / aquatic / rocksprops
- sky の ngSkyWithClouds → water の反射の fallback（それまでは ngSkyRadiance で代える）

■ Phase 2：統合（統合エージェント 1 ＋ アートディレクター 1）
- index.html で全モジュールを有効にする
- 予算の超過を調整する
- 7 時刻 × 3 天候 × 3 カメラ × 3 品質の撮影の行列
- バイブルの数値の検査（下のテスト計画）
- 色の不一致（地面と草、水と空、魚と湖底）を直す
- 最後に動的解像度とパフォーマンスの安全弁を入れる

## testPlan
■ Node テスト（CI、run-tests.mjs に登録。KEEP の 17 本を先に並べる）
1. lake-identity：resolveLake(123456789).tries === 1。makeLake の出力（heightAt を 4096 点、structures、dock、flats、holes）のハッシュが固定値に一致する
2. placement-determinism：同じ seed で 2 回生成すると、バイト単位で同一。low / mid / high で当たりの配列が同一。描画の rank の集合は包含関係（low ⊂ mid ⊂ high）
3. collider-dims：
   - 幹の当たり = 見た目の太さ × 1.15（最小 0.28）、上端 0.9 × 樹高
   - 藪の輪の帯の範囲
   - 灯籠と小舟
   - 桟橋から 3.4m、スポーンから 6m の空き
   - structures の x, z が lake.structures と完全に一致する
4. ecology：weedBeds が lake.flats を 95% 以上覆う。reedBeds が水深 ≤ 1.5m の中にある
5. wave-parity（Node 側）：surfaceY と waveField の一致。陸で 0。lake-calm-water の波の検査
6. weather-api：tickWeather の抽選の分布（重み、× 0.35、2.5〜6.5h）、setWeather に不正なキーを渡しても無視、weatherTimer の書き込み
7. env-pure：同じ (hour, weather) → 同じ sunDir と色（CPU の大気）。nightAmount の境界
8. performance-test（MIXED）：addRT(game.env?.sun?.shadow?.map) の文字列と estimateRtBytes の形を残す
9. walk-zone：藪の輪と blockedAt(y)

■ ブラウザのテスト（scripts/gfx/*.mjs、headless Chrome と M1 の GPU）
10. water-parity：lab/water-parity.html。GPU の変位と CPU の差 < 1mm
11. frame-safety：本物のゲームで次を回し、例外 0・NaN 0・GL エラー 0 を確認する（console.txt）
    - 時刻 24 × 天候 3 × 品質 3 × カメラ 4（水中を含む）
    - 600 フレーム
    - 品質の切り替え、天候の即時の切り替え、ポーズの on/off、リサイズ
12. perf：固定の 5 構図で GPU の timer query（無ければ 300 フレームの平均）を取り、予算表との差を出す。high 1440p で 16.6ms を超えたら失敗
13. shot-matrix：7 構図（baseline と同じ）＋水中 2 構図 × 3 天候 × 3 品質

■ 撮影の合格の条件（art-metrics.mjs が PNG から自動で算出。アートディレクターの目視の前段）
- 中間の輝度（Rec.709 の平均、表示後）
  - 晴れの昼 0.38〜0.48、ゴールデンアワー 0.28〜0.38、ブルーアワー 0.12〜0.20、夜 0.04〜0.08、雨の昼 0.30〜0.40
- 白飛び（≥ 0.99）の画素 < 0.5%。例外は太陽の円盤、鏡面、灯籠
- 黒つぶれ（≤ 0.01）の画素 < 1%。夜は < 5%
- 水と空の比：水平視で「水面の下 1/3 の平均輝度 / 空の地平帯」= 0.35〜0.75
- 真下視（noon-fp-down）の水の色相が 160〜200°（テール〜青緑）。旧版の群青（225°）は不合格
- 色のまとまり：同じ構図の中で、地面・草・葉の彩度の中央値の差が 0.15 以内
- 空のグラデーションに段が無い（隣の画素の差のヒストグラムで帯を検出する）
- 時系列：同じ構図で 5:00〜7:00 を 10 分刻みで撮ったとき、平均輝度が単調に変化し、隣の差が 0.08 以内（露出のポップの検出）

■ 目視のチェックリスト（アートディレクター）
- dawn：朝霧が湖面の層として見え、太陽の側が光る。対岸の森がシルエットになる
- noon：浅場の底、テール、深い青のグラデーション。雲の影が山肌を流れる
- golden：森の縁の逆光と、水面のきらめきの帯
- blue hour：空の反射と灯籠が画面の主役
- night：月の光の道、星、青い夜の暗さ（黒ではない）
- rain：遠景が溶け、水面は全面に雨の輪。濡れた桟橋が光る
- underwater：Snell の窓と god rays、青緑の減衰

## topRisks
1. 外来マテリアル（fish/angler）への注入が壊れる。onBeforeCompile の連鎖や、three の chunk の文字列の置換が失敗する恐れがある
→ adopt は置換が成功したかを検証し、失敗したら注入を諦めて素のまま描く（例外は出さない）。lab/core.html に fish と angler を置いた回帰の撮影を用意する。three r180 の chunk の名前は固定の版で検査する。

2. 性能。1440p で MSAA×4、RGBA16F、反射、屈折のコピーが重なり、帯域が足りない恐れがある
→ 予算表と動的解像度で抑える。MSAA が 2ms を超えたら SMAA に落とす。反射は 0.5 倍に抑え、groundcover は写さない。

3. 色のまとまりが崩れる。9 人がそれぞれの lab で「よく見える」色を作り、統合したときにばらばらになる
→ palette.js（アルベドの範囲と照度）と、全 lab 共通のグレーカードとチャート、自動の art-metrics で縛る。モジュールでの独自の露出とトーンマップは禁止。

4. 水の屈折の滲みや反射の破綻が、主役の絵を壊す（岸の木が水面へ滲む、斜めクリップ面の欠け）
→ 深度で判定して戻す。水中の物は layer で除き、clip の y を小さくする。lab で 7 構図を撮る。

5. 読み込み時間が 6 秒を超える（heightAt、木の生成、impostor の焼き、シェーダのコンパイル）
→ Web Worker × 4、compileAsync、読み込みの段ごとに await、Phase 2 でプロファイルする。

6. 決定性が崩れる。placement に品質や Math.random が入り込み、マルチの当たりがずれる
→ Node のテスト 2 と 3。placement は three を使わず、品質を引数に取らない。

7. MP の同期が止まる。描画の例外が game.update へ漏れる
→ pipeline の各 pass を try で包み、NaN のクランプを入れる。frame-safety のテストで 600 フレーム × 全条件を回す。

8. 共有 uniform の名前の衝突や、サンプラー数の上限 16 を超えること（地形が丸ごと消えても例外が出ない）
→ 接頭辞 ng。1 シェーダ 12 サンプラー以内（配列テクスチャにまとめる）。lab の起動時に、全プログラムの link の状態と、アクティブなサンプラー数を検査する。

9. ライト数や castShadow の変更による再コンパイル
→ ライトは起動時に固定。灯籠は intensity だけを変える。env map のテクスチャの参照は変えない。

10. 1 フレームの時刻のずれ（CPU の surfaceY は前のフレームの water.time を使う）
→ 契約どおり受け入れる（差は数 mm）。GPU は現在の time を使う。
