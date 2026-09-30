# 湖畔のフィッシング 次世代環境グラフィック設計書「鏡の湖」— 単一ライティング／単一大気／同一フレーム屈折の Forward HDR + TAAU パイプライン（three r180 / WebGL2 / onBeforeCompile 互換）

## philosophy
1) 一つの光・一つの大気・一つの水。環境の自前シェーダも、触れない組込み MeshStandardMaterial（釣り人・竿・魚・リモートプレイヤー）も、ShaderChunk の差し替えと onBeforeCompile の連鎖で、同じ ng ライティングを通す。中身は、事前露出した物理単位の太陽／月照度、同じ空プローブ／SH、同じ CSM 可視度、同じ霧の閉形式積分。個々の技法を豪華にするより、全員が同じ光を受けることが写実を生む。
2) 水が主役。不透明物は 1 回だけ描き、同じフレームの色と深度から屈折・吸収・散乱を合成する（旧版の「シーン二重描画＋別 RT」は廃止）。これで魚・沈んだウキの下半分・仕掛けも自然に屈折に写る。反射は真の平面鏡パスで作り、釣り人・竿・ウキも写す。法線は次を重ねる：物理用の低周波波（CPU の surfaceY と同じ waveField 関数）、FFT の風紋（LEAN で分散を粗さに変換）、カメラ前方の対話波紋シミュ、解析リング、雨の輪。
3) ゆっくり変わるものは償却する。雲はカメラ非依存の空パノラマに 1/16 ずつ描き足す（反射・プローブ・スネルの窓も同じものを引く）。遠いカスケード・プローブの面・大気 LUT・地形影は間引いて更新し、ノイズは TAAU が時間方向に積分する。浮いた GPU 時間を 1440p の解像度・水・森に回し、DRS（動的解像度）で 60fps を守る。
4) ゲーム性のデータ（高さ・配置・当たり・波）は、描画から独立した純関数の層に置く（シード決定的・品質非依存・Math.random 禁止・Node でテスト可能）。見た目はすべてそこから導出するので「見えるもの＝当たるもの＝魚が知っているもの」が保証される。
5) 外部アセットはゼロ。すべて自前コードが起動時に GPU で合成する（地形 PBR 配列、樹皮・葉アトラス、雲ノイズ 3D、FFT スペクトル、インポスター）。コミットするのはオフライン生成のブルーノイズ 1 枚（≤ 256KB）だけ。
6) 壊れない。各モジュールは core の safe() で隔離する。初期化や描画に失敗したモジュールは自動で無効化して代替表示に落とし、フレームは必ず完走する（MP 同期を止めない）。
7) 9 人の並行開発を前提にする。モジュール同士は core の uniform・GLSL チャンク・レイヤ・パイプラインのステージ口だけで結合する。各モジュールは自分の lab ページと GPU ms 予算（すべて M1 Pro で実測する）で、品質と速度を自分で証明する。

## pipeline
■ 用語と前提
- O：出力解像度（drawing buffer = CSS × DPR）。R：内部描画解像度（O × renderScale）。renderScale は DRS が動かす。既定と範囲は high 0.80〔0.67–1.0〕、mid 0.85〔0.67–1.0〕、low 0.75〔0.5–1.0〕。
- HDR の RT はすべて RGBA16F（HalfFloatType）。EXT_color_buffer_float は必須で、無ければ low の LDR 経路（RGBA8 + FXAA）に落とす。
- 深度は DepthTexture(FloatType) = D32F。主 RT_A と RT_B で同じ depthTexture を共有する。
- renderer は antialias:false（game.js の 1 行修正。既定フレームバッファの MSAA は最終の全画面描画では無駄）。renderer.shadowMap は three のものを使わない（sun.castShadow=false）。
- ライト構成は起動時に固定する：DirectionalLight 1（太陽／月、既存どおり強い方）、PointLight 1（灯籠。昼は intensity 0）、HemisphereLight 0。組込みマテリアルの IBL は scene.environment（PMREM）で与える。
- game.update の中の既存フックは CPU 側の更新だけを行う。
- GPU の処理はすべて postfx.render(sdt) の中の NgPipeline.render が以下の順に実行する。water.capture / captureReflection は呼ばれても安全な no-op で、perf の 'capture'/'reflection' は ≈0ms になる。

■ CPU 側（game.update の既存順序のまま）
1. env.update(dt,hour,cam,focus)：Sky モジュールが時刻と天候の状態だけから次を計算し、NG uniform に書く（純関数）。
   - 太陽／月の方向と照度
   - 霧・エアロゾルの係数
   - 露出の目標 EV
   - CPU 近似の空色（sunColor など）
2. terrain.updateWind → NgWind（風向・風速・突風テクスチャのスクロール）。
3. terrain.updateTrees(dt,camPos)：NgInstanceSet（木・岩・葦・草の束）の LOD とカリングのリストを作り直す。250ms ごと、またはカメラが 2m／3° 動いたとき。
4. terrain.updateLamp(night, dt)：灯籠の点灯度を dt ベースの指数 damp で進める。
5. water.update(sdt,cam,env)：time += sdt、wind の式、causticsUniforms の .value、波紋・しぶきのキュー（上限つき、NaN を捨てる）。
6. updateUnderwaterProps / updateShore：水草の流れの uniform と、渚の uniform。

■ GPU 側：NgPipeline.render(dt) の順序
P0  Auditor（CPU 0.05ms）
    scene を走査し、gfx 所有でないオブジェクトを分類する：
    - transparent、depthTest=false、renderOrder≥3 → LATE レイヤ
    - castShadow の Mesh → CHAR_CASTER レイヤを追加
    - 組込みマテリアル → ngPatchBuiltin（後述）
    その週に新しく足された物も、初回描画より前に処理される。

P1  Sim ステージ（各モジュールの gpu('sim')）
    P1a 大気 LUT
        - Transmittance 256×64 RGBA16F と MultiScatter 32×32 RGBA16F：エアロゾル量が 1% 以上変わったときだけ作り直す。
        - SkyView 192×108 RGBA16F：毎フレーム（low は隔フレーム）。
    P1b 雲パノラマ
        - 上半球の緯度経度（仰角は v=√(elev/90°) で地平線側を厚くする）。high 2048×768 RGBA16F（rgb=内散乱、a=透過）と R16F の雲距離。ping-pong 2 枚。
        - 毎フレーム、4×4 ブロックのうち 1 画素だけ raymarch する（16 フレーム ≈ 0.27s で全面更新）。雲の移動量は game clock の純関数なので、MP の全員が同じ空を見る。
        - 雲影 512² R8：4Hz、±3km、太陽方向への被覆の積分。
    P1c 水 FFT
        - 256² RGBA32F の ping-pong で Stockham 8+8 パス。2 カスケード（16.3m と 3.7m）を、sx+i·sz の複素パッキングで RG/BA にまとめる。
        - 仕上げパスで LEAN モーメント (sx,sz,sx²,sz²) を RGBA16F の 2 層 ArrayTexture に書き、mip を作る。
    P1d 波紋シミュ
        - 768² RG16F（h, h_prev）の ping-pong。窓は 96m 四方で、中心はカメラの水平前方 28m。整数テクセル単位でスクロールする。
        - 120Hz 相当で 2 サブステップ。インパルスは Points 描画の加算で注入する。
    P1e caustics：256² 頂点グリッドを屈折投影して 512² RGBA16F に加算する（RGB で IOR をずらした色収差）。mip を作る。30Hz。
    P1f 地形の太陽影と風下遮蔽
        - 地形の太陽影 1024² R8（±1024m、地形＋樹冠高さの高さ場を raymarch）。太陽が 0.25° 動くか 2s ごとに更新し、4 フレームに分割する。
        - 風下遮蔽マップ 256² R8：風向が 10° 変わったときに更新する。

P2  影（core の NgShadows。影を描き直すのはここ 1 か所だけ）
    - CSM アトラス：high 4096² D32F に 2048² のタイル ×4。
    - 分割：high 0.1/6/20/64/220m、mid 0.1/8/30/120m（3 枚、1536²）、low 0.1/15/80m（2 枚、1024²）。
    - 球フィットで回転不変にし、テクセルにスナップする。
    - 更新：c0 と c1 は毎フレーム、c2 は隔フレーム、c3 は 4 フレームごと（互いにずらす）。各タイルは描いたときの行列を保持し、サンプリングはその行列で行う（古くても自己整合する）。
    - キャスタは 2 系統：
      (a) core の casterScene：環境物。モジュールが ngCasterMaterial で登録する。風の変位も同じ GLSL を使う。
      (b) main scene の CHAR_CASTER レイヤ：釣り人・竿。overrideMaterial=MeshDepthMaterial で、スキニングは three が処理する。c0–c1 のみ。

P3  プローブ（Sky モジュール）
    - 世界プローブ cube 256² RGBA16F を 1 面/フレーム描く。レイヤ WORLD|SKY、ngPassId=PROBE、解析フォグのみ、木はインポスター強制。
    - clippingPlanes で y<-0.05 を捨て、空いた下半球は「湖面色」で埋める。
    - 続いて GGX のプレフィルタを 1 面・1mip ずつ（5mip、FIS で 32 サンプル）。
    - SH9 は 9×1 に射影し、readRenderTargetPixelsAsync で 4Hz に CPU へ戻して uniform vec3[9] にする。サンプラーを 1 つ節約でき、CPU 側の解析近似がフォールバックになる。
    - 2s ごとに PMREMGenerator.fromCubemap(probe, pmremRT) を回して scene.environment にする（組込み用）。scene.environmentIntensity は毎フレーム、露出比・水中・夜で調整する。
    - プローブの位置はカメラの xz、y=1.7（水中のときは y=+0.25）。

P4  平面反射（Water モジュール）
    - Reflector 方式の仮想カメラ（位置と注視点を y=0 で鏡映。巻き順は反転しない）に、斜めの近クリップ面（y=-0.08）を入れる。
    - reflRT：R×0.5 の RGBA16F + DepthTexture。
    - レイヤは WORLD|SKY。SUBMERGED・NO_REFLECT・LATE・WATER は除く。ジッタなし、ngPassId=REFLECT（LOD バイアス 1.5、SSS 省略）。
    - 描いたあと「色＋反射点までの距離」を 5 段の mip に Kawase ダウンサンプルする。
    - setReflectionHidden のリストはこのパスの間だけ visible=false にする。
    - カメラが水中のとき、または湖面が画面に無いとき（CPU の錐台判定）はスキップ。

P5  主不透明パス → RT_A（R、RGBA16F、D32F）
    - 投影行列に Halton(2,3) のジッタ（high 16 相、mid 8 相）。
    - レイヤ：WORLD|SUBMERGED|NO_REFLECT|SKY。空は最後に描く（depth=far、LEQUAL、depthWrite 無し）ので、早期 Z が効く。
    - 描くもの：地形、森（LOD0/1、インポスター、樹冠シェル）、岩、桟橋、下草、葦、湖底、水草、魚、釣り人。
    - alpha チャンネルはタグとして使う：
      - ng マテリアル：0.5 × ambientFraction（間接光の輝度比、0–0.5）
      - 組込み：1.0（= リアクティブ、AO 全量）
      - 空：0

P6  線形深度：D → LZ（R、R32F）と LZ_half（R/2、チェッカーボードで min/max）。

P7  GTAO＋接触影（Post モジュール）：R/2、RG8。R=AO、G=太陽方向の接触影。4×4 の双方向ぼかし。時間方向の平滑は TAAU に任せる。

P8  フロクセル（AtmoFX モジュール）
    - high 160×90×64、mid 128×72×48。散乱・消散の 3D RGBA16F に書き、前フレームへ再投影して 0.92 でブレンドし、前→後に積分して 3D RGBA16F にする。
    - スライスは指数分布（0.5m〜ngVolEnd。high 128m、mid 96m）。
    - 深度に依存しないので P5 と独立。

P9  不透明リゾルブ → RT_B（D を共有）
    - 色の式：col = A.rgb × (1 − amb × (1−ao)) × (1 − (1−amb) × (1−contact))
    - 空気のフロクセルを合成する。ただしカメラが水上で、ヒット点の y < −0.05（水中の点）のときは合成しない。そこは水面シェーダが空気区間を担当する。
    - B.alpha にはリアクティブ度を書く：組込み 1、ng 0、空 0。

P10 屈折元
    - RT_B を copyFramebufferToTexture で REFR（R、RGBA16F、mip 付き）へ blit し、generateMipmap する（粗さに応じたぼかし用）。
    - water.rt はこの REFR を指す（perf の見積もり用）。

P11 水面 → RT_B（深度テスト・書き込みあり）
    - 水上：屈折・吸収・内散乱・平面反射・太陽／月の GGX・泡・雨の輪。そのあと空気区間の霧（フロクセル＋解析）を掛ける。
    - 水中：スネルの窓と全反射。
    - 出力 alpha = 0.25（TAA では弱いリアクティブ）。

P12 LATE／半透明：three の通常描画（ソートあり）で LATE レイヤを描き、続けて gfx のパーティクルを描く。
    - LATE：マーカー（renderOrder 6、fog:false）、糸、名札、debug（900）。
    - パーティクル：雨の筋・着弾、しぶき、蛍、光の塵、水中のマリンスノー。
    - パーティクルは LZ でソフト化し、ngApplyAtmo / ngFroxel で自分に霧を掛ける。
    - NormalBlending は dest alpha を上げるので、そのままリアクティブになる。

P13 水中の後処理（カメラが水面下のときだけ）
    - R/2 で 24 ステップ raymarch：光柱 = CSM × 表面の caustic × 下向き透過 × HG(g=0.85)。
    - 近平面での水面判定によるウォーターライン（半分潜ったときの境界）。
    - RT_B に合成する。

P14 TAAU（high/mid）
    - 入力：RT_B（R）＋ LZ ＋ 履歴（O、RGBA16F）。出力：新しい履歴（O）。
    - 再投影は深度から（空は回転のみ）。Catmull-Rom 5 タップで履歴を読む。
    - YCoCg で 3×3 の分散クリップ（γ=1.0、リアクティブのところは 0.6）。
    - ブレンド α：通常 1/12、リアクティブ 0.35。
    - アップサンプル重み：ジッタ距離に Blackman-Harris。
    - low は TAA を行わず、P17 の後に FXAA。

P15 露出測光：新しい履歴を 1/16 に落として log 平均（中心重み）→ 1×1 → 順応。readRenderTargetPixelsAsync で 4Hz に CPU へ戻す（事前露出に使う）。

P16 Bloom：O/2〜O/64 の 6 段。Jimenez 13 タップで下げ、9 タップのテントで上げる。しきい値は使わず、エネルギー保存で 3.5% を足す。

P17 最終 → canvas（既定 FB、RGBA8）
    - 露出の微調整 × (col + bloom) → AgX → グレーディング（色温度 CAT、log 空間の S カーブ、彩度、水中の色調）→ ビネット 0.12 → RCAS 0.2（TAAU の後）→ sRGB OETF → ±0.5 LSB のブルーノイズディザ（空のバンディング対策）。
    - ShaderMaterial は toneMapped:false。トーンマップはここで 1 回だけ。

■ どのパスに何が写るか（main / refl / probe / shadow）
- 空：○/○/○/×
- 地形クリップマップ：○/○(同メッシュ)/○(粗)/○（キャスタ専用の粗メッシュ。c0 は 0.5m、c1–3 は 2m セル）
- 遠景稜線：○/○/○/×（地形の太陽影テクスチャで代替）
- 木 LOD0/1：○/○/×/○（c0–c2）
- インポスター：○/○/○/○（c2–c3。太陽方向のフレームで影を落とす）
- 樹冠シェル：○/○/○/×（地形影に含める）
- 草・笹・小物（NO_REFLECT）：○/×/×/×
- 葦：○/○/×/c0（high のみ）
- 睡蓮：○/×/×/×
- 水草・湖底プロップ・沈みストラクチャー（SUBMERGED）：○（屈折で見える）/×/×/×
- 岩・桟橋・舟・灯籠：○/○/○(大のみ)/○
- 釣り人・竿・ウキ：○/○/○/c0–c1
- 魚：○/○（水面上へ跳ねたときだけ写る。斜めクリップが水中を自然に切る）/×/×
- 水面：P11 のみ
- 雨・パーティクル・マーカー・糸：P12 のみ

■ 水中経路（ngCamUnderwater=1）
- P4 と P8 を止める。
- プローブを (cam.x, 0.25, cam.z) に移し、上 5 面を優先して更新する。
- 全マテリアルの ngApplyAtmo は水の媒質の分岐になる（T=exp(−σt·d)、S=(σs/σt)(1−T)·下向き光(カメラ深さ)）。
- 水面は裏面の分岐で描く：
  - 窓の内側：refract で上向きに出した方向でプローブを引き、(1−F) を掛ける。
  - 窓の外側：全反射。high は 8 ステップの SSR、それ以外は深場の色。
- P13 の光柱とマリンスノーを足す。グレーディングは水中用（青緑、彩度 −20%）。

■ 色のパイプラインと露出
- シーンはリニア Rec.709。すべての光源強度に ngExposure（= 1/(1.2 × 2^EV100) × bias）を事前に掛ける（UE 式の pre-exposure）。
  - 太陽直下の白い拡散面が 1 前後に収まり、RGBA16F が溢れない。
  - 太陽の円盤は事前露出後で 30000 にクランプする（FP16 の上限 65504 対策）。
- bias = opts.exposure / 0.78（旧 EXPOSURE を基準 1 にする）。
- 目標 EV100 は、太陽高度・雲量・雨の関数表から決まる純関数：
  - 快晴の正午 14.6、曇りの正午 13.3、雨の正午 12.6
  - 太陽高度 5° で 12.8、日の出・日没 11.2
  - 太陽 −4°（ブルーアワー）8.5、航海薄明 6.0、月夜 1.2（写実より明るめ。夜のグレーディングで青く落とす）
  - 水中は −0.8EV 相対
- これに測光の順応（目標 ±1.5EV にクランプ、明るくなる方 1.2s・暗くなる方 0.6s、sdt=0 のときは停止）を掛ける。
- renderer.toneMappingExposure は使わない。uLinearOut は常に 1。

## core
■ 配置（src/gfx/core/）
- gfx.js：Gfx シングルトン
- uniforms.js：NG 共有 uniform
- layers.js
- chunks/*.glsl.js：ng_* の GLSL を THREE.ShaderChunk に登録する
- material.js：ngMaterial と ngCasterMaterial
- auditor.js：組込みマテリアルのパッチとレイヤ分類
- shadows.js：NgShadows
- wind.js：NgWind
- wet.js
- heightfield.js：NgHeightfield と Worker
- instancing.js：NgInstanceSet
- clipmap.js：共用のクリップマップ幾何
- pipeline.js、targets.js、fullscreen.js、gpuTimer.js、safe.js、quality.js
- src/gfx/world/：placement.js と collision.js（three 無し。gameplayContract を参照）
- lab/_lib/harness.js

■ Gfx（2 段階で起動する。Environment は湖より前、renderer は Terrain の opts で来る）
```js
export const NG_VERSION = 1;
export class Gfx {
  static early(scene): Gfx;          // Environment ctor: NG 生成、installNgChunks()、NgFog、レイヤ
  static get(): Gfx|null;
  bind({renderer, lake, quality}): void;  // Terrain ctor（opts.renderer）。heightfield と placement を起動
  bindCamera(camera): void;          // PostFX ctor
  ng: NgUniforms; layers: L; quality: {tier, p: TierParams};
  shadows: NgShadows; wind: NgWind; heightfield: NgHeightfield; layout: WorldLayout;
  pipeline: NgPipeline; targets: NgTargets; timers: NgGpuTimers; frame: NgFrameState;
  register(mod: NgModule): void;
  setQuality(tier): void;            // 冪等。4 つのファサードのどれから呼ばれてもよい
  onQuality(cb): () => void;
  setSize(wCss, hCss, dpr): void;
  safe(name, fn, fallback?): any;    // try/catch → モジュールを faulted にし、10s に 1 回ログ
  whenReady(onProgress?): Promise<void>;  // Worker・合成・インポスター・compileAsync
}
interface NgModule {
  name: string; budget: {low:number, mid:number, high:number};
  init(gfx): void|Promise<void>;     // 重い処理は分割して await（1 回 ≤ 30ms）
  setQuality(tier, p): void;
  update?(f: NgFrameState): void;    // CPU。ファサードの update* から呼ばれる
  gpu?(stage: 'sim'|'probe'|'reflect'|'postOpaque'|'water'|'late'|'underwater'|'post', f): void;
  dispose(): void;
}
NgFrameState = { dt, time /*ポーズで止まる視覚秒*/, hour, frame, camera, camPos, jitter: Vector2,
  renderScale, underwater: 0..1, passId, tier }
```

■ レイヤ（L）
- WORLD 0（既定。キャラクターもここ）
- CHAR_CASTER 1
- LATE 2
- WATER 3
- SUBMERGED 4
- NO_REFLECT 5
- SKY 6
- 太陽・月・灯籠のライトは layers.enableAll() にする（three はライトもレイヤで判定するため必須）。
- パスごとのマスク：main = 0|4|5|6、reflect = 0|6、probe = 0|6、late = 2、water = 3、charShadow = 1。

■ NG 共有 uniform（すべて {value} の単一参照。ngMaterial と組込みパッチの両方へ参照で配る）
- パス：ngPassId(int: 0 main / 1 reflect / 2 probe / 3 shadow / 4 bake)、ngCamPos(vec3)、ngFrame(int)、ngJitter(vec2)、ngViewport(vec4)、ngPrevViewProj(mat4)、ngQuality(int 0/1/2)、ngTime、ngHour、ngSeason（0..1、既定 0.42 = 初夏）
- 光：ngSunDir、ngMoonDir、ngKeyDir、ngSunE（vec3 事前露出照度 = 太陽定数 × 大気透過(地表) × 雲の平均透過）、ngMoonE、ngSH[9](vec3)、ngExposure、ngProbe(samplerCube、GGX mip)、ngProbeExposureRatio
- 大気：ngSkyViewLut、ngTransLut、ngFogA(vec4: ρ0, H, ρmist, Hmist)、ngFogB(vec4: apScale, gFog, volEnd, uwCut=-0.05)、ngFogCol(vec3 CPU 近似)
- 影：ngCsmAtlas(sampler2D、比較なし D32F)、ngCsmMat[4](mat4)、ngCsmSplit(vec4)、ngCsmTexel(vec4)、ngShadowOn、ngTerrainShadow(sampler2D)、ngCloudShadow(sampler2D)、ngCloudShadowMat(vec4)
- 風・濡れ：ngWind(vec4: dir.x, dir.z, U m/s, gust)、ngWindTex(256² R8 タイル可)、ngWindTexP(vec4)、ngWetness（0..1、雨で 90s かけて上がり 20min かけて乾く）、ngRain、ngCloud、ngNight
- 水：ngWaterTime、ngWaterWind（= water.time と water.wind）、ngCamUnderwater、ngWaterSigA(vec3 = 0.35, 0.065, 0.085 /m)、ngWaterSigS(vec3 = 0.030, 0.042, 0.050 /m × turbidity)
- 地形：ngHeightNear(R32F 2048²、±256m)、ngHeightFar(R32F 1024²、±1024m)、ngHeightP(vec4)
- ローカル光：ngLocalLights[4](vec4 pos+radius)、ngLocalCol[4](vec4)
- その他：ngFroxel(sampler3D)、ngFroxelP(vec4)、ngBlueNoise(sampler2DArray 64²×16)

■ GLSL ライブラリ
- ShaderChunk に ng_common / ng_uniforms / ng_atmo / ng_shadow / ng_lighting / ng_water / ng_wind / ng_wet / ng_froxel / ng_output / ng_instancing として登録し、#include <ng_x> で使う。
- 各チャンクは #ifndef NG_LIB_X ... #endif のインクルードガード付き。魚シェーダに CAUSTICS_GLSL と組込みパッチが二重に入っても再定義にならない。
- 公開名はすべて ng 接頭辞（lint で検査）。
```glsl
// ng_common
float ngSat(float); vec3 ngSat(vec3); float ngLuma(vec3);
float ngIGN(vec2 pix, int frame);           // Jimenez の IGN
float ngBN(vec2 pix);                       // STBN のスライス = ngFrame%16
vec2 ngOctEnc(vec3 n); vec3 ngOctDec(vec2 e); float ngHash12(vec2); vec2 ngHash22(vec2);
float ngDitherFade(float fade, vec2 pix);   // LOD クロスフェード（true なら discard）
// ng_atmo（どのパスでも使える。カメラ非依存。ngCamPos を起点にする）
vec3 ngSky(vec3 dirW);                      // SkyView + 雲パノラマ + 太陽/月の円盤 + 星（パス別に円盤を抑える）
void ngAtmoTerms(vec3 P, vec3 C, out vec3 T, out vec3 S);  // 解析: AP + 高さ霧 + 朝霧
vec3 ngApplyAtmo(vec3 col, vec3 P);         // 水上/水中、ngVolEnd の区間分割を自動で処理
vec3 ngSunTransmittance(vec3 dirW);         // TransLut
// ng_shadow
float ngCsm(vec3 P, vec3 Ng, vec2 pix);     // カスケード選択 + 10% ディザブレンド + normal offset + PCSS/PCF
float ngSunVis(vec3 P, vec3 Ng, vec2 pix);  // = mix(1, ngCsm·ngTerrainShadow·ngCloudShadow, ngShadowOn)
// ng_lighting
struct NgSurf { vec3 albedo; float rough; float metal; vec3 N; vec3 Ng; float ao; float spec;
                float sss; vec3 sssCol; float thick; float wet; float porosity; };
struct NgLit { vec3 direct; vec3 indirect; };
NgLit ngShade(NgSurf s, vec3 P, vec3 V, vec2 pix);  // 太陽+月: GGX(Smith 相関) + Lambert/π（three と同じ規約）
                                            //   + 葉の透過（HG g=0.5 × thick）+ 局所光 4 + SH 拡散 + プローブ鏡面
                                            //   + Karis の EnvBRDF 近似 + Lagarde の鏡面遮蔽
                                            //   水面下では ngDownwell と ngCausticLight を掛ける
vec3 ngIrrSH(vec3 N); vec3 ngProbeSpec(vec3 R, float rough);
float ngHG(float c, float g);
vec4 ngOut(NgLit l);                        // vec4(direct+indirect, 0.5·ambFrac) — P5 のタグ規約
// ng_water（waveField.waveGLSL({prefix:'ngW'}) の出力をそのまま埋め込む。手で写さない）
float ngWaveH(vec2 xz, float t, float wind); vec2 ngWaveSlope(vec2 xz, float t, float wind);
float ngShoal(float depth);                 // shoalGain と同じ式
float ngTerrainH(vec2 xz);                  // 手動バイリニア（Near/Far を選ぶ）
float ngWaterY(vec2 xz);                    // = ngWaveH·ngShoal(max(0,−ngTerrainH))
vec3 ngDownwell(vec3 P);                    // exp(−Kd·max(0, ngWaterY − P.y)/cosθ_refr)
vec3 ngCausticLight(vec3 P, vec3 Nw);       // Water Dynamics が実装。core はスタブで 0 を返す
// ng_wind
vec4 ngWindAt(vec2 xz);                     // (vx, vz, U, gust01)
vec3 ngSwayTree(vec3 pW, vec3 pivotW, float h01, vec4 br /*pivot 高, 剛性, 位相, 階層*/, float flutter);
vec3 ngSwayGrass(vec3 pW, vec2 rootXZ, float h01, float stiff);
// ng_wet
float ngWetAt(vec3 P, vec3 N, float shelter);   // ngWetness × 空への露出 × (1 − 樹冠遮蔽)
void ngApplyWet(inout NgSurf s, float wet);     // albedo *= mix(1, 0.45+0.35(1−porosity), wet)、rough → 0.08、法線を平らに
// ng_froxel
vec4 ngFroxel(vec2 uv, float linZ);         // rgb 内散乱、a 透過（トライリニア）
```

■ 大気・霧のモデル（全マテリアル共通、カメラ非依存）
L = L0·T + S。T = T_ap × T_fog。
- 大局の空気遠近（AP）
  - T_ap = exp(−(β_R + β_M,ext) · d · apScale)
  - apScale = 6：1km の世界で、日本の山並みらしい青い層状の稜線を出すため。
  - S_ap = ngSkyViewLut(dir の仰角を ≥1.5° にクランプ) × (1 − T_ap)
- 高さ霧は指数密度 ρ(y) = ρ0 · e^{−(y−y0)/H}。光学距離は閉形式：
  - τ = ρ0 · e^{−(c_y−y0)/H} · d · (1 − e^{−Δy/H}) / (Δy/H)
  - |Δy/H| < 1e−4 のときは極限値。
- 朝霧は ρmist · e^{−y/Hmist} × 湖上マスク（湖岸距離 SDF）。Hmist = 4m、ρmist は最大 0.012/m で、4:30–7:30 と雨上がりに出る。
- 霧の内散乱：S_fog = (1 − e^{−τ}) × [ ngSunE · ngSunTransmittance · HG(cosθ, 0.72) · 0.9 + ngIrrSH(up)/π · 0.9 ]
- 分割：main パスでフロクセルが有効なときだけ、解析は区間 [ngVolEnd, d] を担当し（始点 c' = c + dir · ngVolEnd）、[0, volEnd] はフロクセルが担当する（同じ密度関数＋平均 0 のノイズ）。
  - 反射・プローブ・影・焼き込みのパスでは ngVolEnd = 0 にして全区間を解析で扱う。
- 天候ごとの係数（Sky が毎フレーム書く）：
  - 晴れ：ρ0 3.5e−4/m、H 180m
  - 曇り：1.2e−3/m
  - 雨：4e−3/m（視程 ≈ 750m）、H 120m
  - 夜：6e−4/m
  - エアロゾルの Mie：晴れ ×1、曇り ×2.5、雨 ×6
- 水中の媒質：T = exp(−σt · d)、S = σs/σt · (1 − T) · ngDownwell(カメラ深さ) · (E_sun · HG(0.85) + E_sky)

■ 組込みマテリアル（釣り人・魚・リモート）への適用（auditor.js、three r180 のチャンクに合わせて固定）
1. installNgChunks() が起動時に ShaderChunk を差し替える。
   - fog_pars_vertex / fog_vertex：USE_FOG のとき varying vec3 vNgFogWorld を追加する。値は skinning/morph/instancing/batching を通った transformed に modelMatrix を掛けたもの。旧来の vFogDepth も残す。
   - fog_pars_fragment / fog_fragment：
     - #ifdef NG_ATMO：#include <ng_uniforms>、<ng_atmo>、<ng_shadow>、<ng_water>。gl_FragColor.rgb = ngApplyAtmo(gl_FragColor.rgb, vNgFogWorld)。
     - それ以外：従来の線形霧（NgFog の near/far/color を使う）。
   - lights_fragment_begin：getDirectionalLightInfo の直後に `#if defined(NG_ATMO) && UNROLLED_LOOP_INDEX == 0` を入れ、directLight.color *= ngSunVis(vNgFogWorld, inverseTransformDirection(geometryNormal, viewMatrix), gl_FragCoord.xy)。キャラクターが杉の木陰で暗くなる。receiveShadow=false でも効く。
   - lights_fragment_end の後：reflectedLight の 4 項に ngDownwell(vNgFogWorld) を掛ける（魚が深さで青緑になる）。
2. ngPatchBuiltin(mat) が行うこと：
   - defines.NG_ATMO を付ける。
   - onBeforeCompile を連鎖させる（先に元の関数を呼び、そのあと Object.assign(shader.uniforms, NG_BUILTIN)）。
   - customProgramCacheKey を連鎖させる（prev() + '|ng' + NG_VERSION）。
   - needsUpdate を立て、userData.ngPatched を付ける。
   - fog:false や ShaderMaterial は対象外。配列マテリアルは要素ごとに処理する。
3. 追加のサンプラーは skyView・csm・terrainShadow・cloudShadow の 4 つ。組込み側は PMREM(scene.environment) を含めて ≤ 10。
4. アンカー文字列が見つからないとき（three 更新時など）はパッチを諦めて従来の霧にし、1 回だけ警告する。テストでアンカーの存在を検査する。

■ 影（shadows.js）
```js
class NgShadows {
  atlas: WebGLRenderTarget;  // 色は R8（colorWrite:false）+ depthTexture D32F
  casterScene: THREE.Scene;  // 環境キャスタ（モジュールが addCaster で入れる）
  cascades: {near, far, mat: Matrix4 /*world→atlas uv,z*/, texelWorld, frame}[];
  addCaster(obj, {mask = 0b1111, static = false}): void;
  removeCaster(obj): void; markDirty(mask): void; update(f): void;  // P2
}
function ngCasterMaterial({vertexChunk?, alphaMap?, alphaTest = 0.5, instanced = true, side = DoubleSide}): ShaderMaterial;
```
- 各カスケードは、分割区間の錐台の外接球に合わせた正射影。太陽方向へ 400m 押し出し、near/far はキャスタの範囲に合わせる。
- バイアス：法線方向に 1.5 × texelWorld、光方向に 0.5 × texelWorld のオフセット。
- フィルタ（ループ回数は uniform なので品質を変えても再コンパイルしない）：
  - high：PCSS。Vogel 円盤 12 タップでブロッカーを探し、半影 w = (d_r − d_b) × tan(0.27° × 3)（杉の柔らかい影）、そのあと IGN で回転した 16 タップの手動比較 PCF。
  - mid：固定半径 8 タップ。
  - low：手動バイリニア 4 タップ。
- 最終カスケードの外側 20m で地形影テクスチャへフェードする。
- 地形影は ngTerrainShadow：高さ場＋樹冠高さを 64 ステップ raymarch し、錐の比率で半影を付ける。
- 雲影は ngCloudShadow。

■ 風（wind.js）
- 風向の角 = 0.6 + 0.5·sin(clock·2π/7h) + 天候オフセット。風速 U = 1.2 + 2.5·cloud + 4.5·rain m/s。
- 突風場：256² R8 のタイル可能 FBM（起動時に GPU で生成）を 400m に張る。U·0.8 で移流させ、2 スケールで合成する。
- CPU ミラー at(x,z) も持つ。
- 植生の曲げ、水の風紋（猫足状の突風帯）、雨の傾き、霧の流れがすべてこれを使う。草原と湖面を同じ突風が渡って見える。
- ゲーム用の water.wind（契約の式）とは独立で、見た目専用。

■ 濡れ（wet.js）
- ngWetness は rainIntensity に追従する。上がりは λ = 1/90s、乾きは 1/1200s（実秒）。
- 面ごとの濡れ = ngWetness × saturate(N.y × 1.5 + 0.3) × (1 − 樹冠遮蔽)。汀線の濡れ帯は地形モジュールが足す。

■ 水の状態：ngWaterTime と ngWaterWind は water.update が書く。ngCamUnderwater は getUnderwaterContext の strength を平滑化したもの。σ は ctx.turbidity で調整する。

■ 高さ場（heightfield.js）
- NgHeightfield.bake(lake, {workers: 4})：Worker で makeLake(lake.seed) を作り直し（結果が同一であることをテストで保証）、次を焼く。
  - Near：2048² R32F、±256m、0.25m
  - Far：1024² R32F、±1024m、2m
  - bedKind：512² R8、±256m（lake.bedAt から）
  - 湖岸距離 SDF：256² R16F
- 実測で heightAt は 0.53µs/点、合計 5.3M 点なので、4 Worker で ≈ 0.8s。
- Worker を作れないときは、メインスレッドで 64 行ずつ await しながら焼く。
- 法線・水平線 AO・傾斜は GPU で派生する。
- terrain.heightTexture = Near。

■ インスタンス（instancing.js）
- NgInstanceSet(def)：
  - インスタンスのデータは RGBA32F データテクスチャ（1 件 2 texel：pos.xyz+scale、rot/variant/tint/flags）。
  - CPU 側に 16m のバケット格子。
  - LOD ごとに InstancedBufferAttribute(Float32 のインデックス, DynamicDraw) を持ち、InstancedBufferGeometry.instanceCount で描く（frustumCulled=false）。
- カリング：距離＋主錐台の左右平面だけ（30% の余裕付き）。上下の平面を使わないので、平面反射の鏡映カメラでも同じリストが正しい。
- LOD：±2m のヒステリシスと 6m のクロスフェード帯（ngDitherFade + TAA）。
- 影用のリストは別（距離のみ、カスケード半径まで）。
- ドローコールの予算：全パス合計 ≤ 350/フレーム、JS の CPU ≤ 6ms。

■ マテリアル（material.js）
- ngMaterial({vertex, fragment, uniforms, defines, side, transparent, layers}) は ShaderMaterial を返す。
  - glslVersion は GLSL3。
  - NG の参照を注入する。
  - clipping:true（プローブの clippingPlanes のため）。
  - userData.ngOwned を付ける。
- 品質の差はなるべく uniform の ngQuality とループ上限で出し、define を増やさない（再コンパイルとコンパイル時間の対策）。
- サンプラーの上限は 1 マテリアル 16。重いマテリアルの内訳表を lint する（地形 14、水 14、木 11、組込み ≤ 10）。

■ 品質の配線（quality.js）
- TierParams 表（qualityTiers 参照）を 1 か所に持つ。
- Environment / Terrain / Water / PostFX の setQuality はすべて gfx.setQuality に集まる（冪等）。
- RT は作り直す。テクスチャ合成の解像度は「起動時の品質」と「それ以降の最大品質」で決め、品質を上げたときはバックグラウンドで作り直す（1 フレーム ≤ 8ms に分割）。
- settings.shadow は毎フレーム renderer.shadowMap.enabled を読んで ngShadowOn にし、OFF なら P2 を飛ばす。

■ 例外の隔離（safe.js）
- 全モジュールの update/gpu は gfx.safe(name, fn) を通す。
- 例外が出たら、そのモジュールを faulted にして、オブジェクトを隠し、代替（core のスタブ）へ切り替える。
- renderer.debug.onShaderError でコンパイル失敗を拾い、同じように隔離する。
- NgPipeline.render 全体も try で包む。失敗したら renderer.render(scene, camera) の素通しに落とす。

■ lab ハーネス（lab/_lib/harness.js）
- bootLab({modules, world: 'mp'|'bowl'|'flat', seed = 123456789}) の URL パラメータ：hour、weather、q、cam（dock-fp / dock-3p / shore / reeds / forest / aerial / underwater / closeup-*）、view（debug 表示：albedo, normal, rough, ao, shadowCascade, csmAtlas, froxel, refl, refr, caustics, wind, wet, lum, nan）、freeze、with=terrain,forest など（実モジュールを合成する。無いものは core のスタブ）。
- window.__gfx = { ready, setHour, setWeather(k, {instant}), setQuality, setCam, tick(n, dt = 1/60), stats() → {fps, gpuMs: {pass: ms}, draws, tris, programs, textures, rtBytes}, nanCheck() → 画素数 }。
- window.__gfxReady を立てると、scripts/gfx/shot.mjs でヘッドレス撮影できる。
- スタブのキャラクターとして釣り人の GLB（assets/models）を置き、組込みパッチの見え方も各 lab で確認できるようにする。

## modules

### M1 Sky & Lighting（空・大気 LUT・雲・天体・露出・プローブ/IBL・Environment ファサード）
files: src/sky.js（Environment ファサード：WEATHERS・tickWeather は旧実装と同じ挙動）
src/gfx/sky/{atmosphereLut.js, atmosphereCPU.js, skyMaterial.js, clouds.js, cloudNoise3d.js, cloudShadow.js, stars.js, moon.js, exposure.js, weatherVisual.js, probe.js, index.js}
lab/sky.html
scripts/gfx/scenarios/lab-sky.mjs
scripts/gfx-tests/sky-*.mjs

resp: 【契約の API】Environment の公開 API をすべて実装する（sunDir の式・nightAmount・damp の係数・tickWeather の抽選は旧版と同じ）：sunDir、keyDir、各色、underwater setter、sky/rain の Object3D、skyUniforms、sun、scene.fog = NgFog、this.scene。
【描画と光】
- 物理ベースの空（Hillaire 2020）、太陽・月の円盤、星と天の川
- 体積雲パノラマ、巻雲、雲影
- 露出の EV スケジュール
- 太陽・月の照度と霧の係数を NG に書く
- 世界プローブ（cube・GGX プレフィルタ・SH・組込み用 PMREM）
- 撮影用の即時天候：setWeather(k, {instant:true}) と snap()

tech: 【大気 LUT（Hillaire 2020）】
- 地球半径 6360km、大気の上端 6460km。
- Rayleigh β = (5.802, 13.558, 33.1)e−6/m、H = 8km。
- Mie βs = 3.996e−6、βa = 4.4e−6、H = 1.2km、g = 0.8（天候でエアロゾル量を ×1 / ×2.5 / ×6）。
- オゾン吸収 (0.650, 1.881, 0.085)e−6（25km ±15km のテント分布）。
- Transmittance 256×64 と MultiScatter 32×32 は 20 サンプル × 64 方向。
- SkyView 192×108：緯度を非線形に写像し、方位は太陽からの相対角。
- CPU 版（atmosphereCPU.js）は同じ積分を 16×8 サンプルで回し、4Hz で sunColor・horizonColor・zenithColor・fogColor・ngSunE・SH の初期値を出す。決定的で、Node でテストできる。

【太陽と月】
- 太陽の円盤：角半径 0.2666°、周縁減光、事前露出後で 30000 にクランプ。
- 月：角半径 0.26°。512² の手続き生成テクスチャ（クレーターは Worley と FBM）、Hapke 簡易の位相、アルベド 0.12、満月でおよそ 0.25 lux 相当。moonDir = −sunDir（契約）。

【星と天の川】
- 9000 個の星をシードで生成する。等級分布と色温度は実物に倣う。
- 描き方：最小 1.5px のインスタンス四角形。大気透過で地平線近くを減光し、地平線近くでシンチレーションさせる。
- 天の川：傾けた大円に沿った帯ノイズと暗黒帯。
- 夜空は反射にも写す（反射 RT では最小 1 テクセルに太らせる）。

【雲】
- ノイズ：Perlin-Worley 128³ RGBA8（形状）、Worley 32³ RGBA8（細部）、curl 128²。起動時に GPU で 128 スライス描画して作る（≈20ms）。天気マップ 512² は 20km 四方に張る。
- 雲層は 1500–4000m。
- raymarch：64 ステップに青ノイズのジッタ。光は円錐状の 6 ステップ。
- 照明：Beer–Powder、2 ローブ HG（0.8 / −0.3）、Wrenninge の多重散乱近似 3 オクターブ、空の SH で上下の環境光。
- 天候ごと：
  - 晴れ：積雲、被覆 0.25
  - 曇り：層積雲、被覆 0.75
  - 雨：乱層雲、被覆 0.95。雲底 600m で暗い
- 巻雲：8km の 2D 層。
- パノラマへの 1/16 償却更新と雲影（パイプラインの P1b）。
- 雲の移動量は game clock の純関数（MP で一致する）。

【プローブ／IBL】パイプラインの P3 のとおり。

【露出】EV100 の表は pipeline に記載。bias = opts.exposure / 0.78。

【光源】
- sun：DirectionalLight。color は正規化した色度、intensity は |E| × 事前露出（three の Lambert/π 規約と一致させる）。castShadow=false。shadow.map には CSM アトラスの RT を代入する（perf の見積もりが読める）。
- HemisphereLight は作らない（ライト数は起動時に固定）。

【NgFog】
- THREE.Fog を継承する。near = 透過が 0.98 になる距離、far = 0.1 になる距離、color = 地平線の霧色。
- debug の表示と、パッチされていないマテリアルのフォールバックに使う。

if: 【使うもの】
- NG、pipeline のステージ 'sim' と 'probe'
- gfx.frame
- wind（雲の流れ）

【公開するもの】
- テクスチャ：ngSkyViewLut、ngTransLut、ngCloudPano（ng_atmo の ngSky が引く）、ngCloudShadow、ngProbe
- 値：ngSH、ngSunE、ngMoonE、ngExposure、ngFogA/B、ngRain、ngCloud、ngNight
- GLSL：ng_sky（ngSky(dir) の実装で、core の空スタブを差し替える）
- CPU：env.state = { sunElev, ev100, fogParams, colors }

【他モジュールとの接点】
- rain の Object3D は AtmoFX の雨を env.rain として持つ（キャプチャ除外用）。
- underwater setter は ngCamUnderwater と水中用の霧色を書く。

budget: low 0.20 / mid 0.45 / high 1.0
内訳（high）：SkyView 0.05、空パス（R、最後に描く）0.12、雲パノラマ 1/16（98k レイ）0.55、雲影 0.03、プローブ 1 面＋プレフィルタ＋SH 0.25、PMREM は 2s ごとに 0.6ms のスパイクを 1 回。
low：2D 雲層だけで raymarch なし、プローブ 128² を 2 フレームで 1 面。

lab: lab/sky.html（world=flat の鏡面床＋グレー球 5 個（粗さ 0–1）と白色炉の球。湖面の代わりに完全鏡面の円盤）。撮るもの：
- 24 時間を 1 時間刻みで撮って 1 枚に並べたタイムラプス（各天候）
- 日の出前の地球の影とビーナスベルト、夕焼けの階調（バンディングが無いことを 400% で確認）
- 雲の銀の縁取り（太陽背後の積雲）、雨の乱層雲
- 月と星と天の川
- 白色炉：SH とプローブで照らした球が、空の平均輝度と一致すること（±5%）
- 露出：6 時刻で 18% グレーのカードが目標の輝度になること
証拠の数値：stats の gpuMs.sky ≤ 予算、NaN 0。

risks: - 雲パノラマの 1/16 更新で、太陽が雲を横切るときにちらつく → 再投影ブレンドと、更新順を STBN の順序にする。
- 地平線の分解能が足りず、遠くの雲がぼける → 仰角を √ 写像にし、パノラマを 2048 幅にする。
- PMREM のスパイク → 2s ごとに間引き、mid/low は 4s ごとにする。
- CPU の色と GPU の空の色がずれる → atmosphereCPU の単体テストで、LUT の読み戻しとの差 ≤ 3% を検査する。
- tickWeather の挙動の差 → 旧 sky.js:317-334 をそのまま移植し、分布のテストを付ける。

### M2 AtmoFX（体積フロクセル・朝霧・光芒・雨・蛍・水中ボリューム・ウォーターライン）
files: src/gfx/atmofx/{froxel.js, froxelGLSL.js（ng_froxel の実装）, mist.js, rain.js, rainImpacts.js, fireflies.js, motes.js, underwaterVolume.js, marineSnow.js, waterline.js, index.js}
lab/atmofx.html
scripts/gfx/scenarios/lab-atmofx.mjs

resp: 【空気中】
- フロクセル（P8）：散乱と消散、時間方向の再投影、積分
- 朝霧、雨の霞、森の光芒と灯籠の光暈（フロクセルの局所光）

【雨と空中の粒】（P12 のパーティクル）
- 雨の筋、地面と水面の着弾
- 蛍（初夏の晴れた夜、葦のまわり）、光芒の中の塵

【水中】
- 光柱の raymarch（P13）、マリンスノー、ウォーターライン
- env.rain の Object3D を提供する

tech: 【フロクセル】
- 大きさ：high 160×90×64、mid 128×72×48。z_i = 0.5 × (volEnd / 0.5)^(i/N)。
- 各セルの計算：
  - σ = 高さ霧（ng_atmo と同じ関数）＋ 朝霧 ρmist × (0.5 + FBM3D(p·0.05 + wind·t))^2 × 湖上マスク ＋ 雨の霞
  - 内散乱 = σs × [ ngSunE × ngSunVis(p) × HG_dual(0.75, −0.2, 0.7) ＋ 月 ＋ SH の等方項 ＋ 灯籠（逆二乗、半径 12m）]
  - 1 セルあたり CSM を 1 タップ、地形影、雲影。
- 時間方向：z のジッタは STBN。前フレームを ngPrevViewProj で再投影し、0.92 でブレンドする。
- 積分：3D RT の各スライスへ描く。スライス k は散乱テクスチャの 0..k を texelFetch で累積する。散乱と積分は別テクスチャ（フィードバックループを避ける）。
- 合成：P9（不透明）、水面、パーティクルがそれぞれ ngFroxel(uv, linZ) をトライリニアで引く。

【朝霧の見せ方】
- 太陽高度 < 12° で濃い。湖上に 2–6m の層で、突風場で流れる。
- 桟橋の釣り人の足元から対岸の杉並の足元が霞み、梢が抜ける絵にする。

【雨】
- 筋：high 12k 個のインスタンス四角形を、カメラ中心の半径 25m・高さ 20m の円柱に置く。
  - 位置は ngTime と ID ハッシュの純関数で、CPU の状態を持たない。
  - 速度 9m/s に風を足して傾ける。長さは速度 × 1/60s。
  - 陰影は、空・太陽・灯籠を拾った細い屈折風の明るさ。
  - 遮蔽：天空への露出を樹冠マップと上から見た高さで見て、桟橋の下や木の下には降らせない。
- 着弾：1.5k 個。高さ場の上で王冠と小さな飛沫。水面の着弾は Water Dynamics の波紋へ渡す（インパルスの共有 API）。
- 遠景：フロクセルの密度を上げて雨のカーテンを作る。

【蛍】
- 300 匹。葦の帯（placement の reedBeds）に沿ってカール場で漂う。
- 2–4 秒周期で点滅する、2400K の強い発光（bloom が効く）。
- ngSeason が初夏、夜、晴れ、雨 < 0.1 のときだけ。

【光芒の塵】1k 個。森の中、太陽が低いときだけ。

【水中ボリューム】
- R/2 で 24 ステップ。
- 光柱 = Σ σs × HG(0.85, 屈折後の太陽) × ngSunE × T_down(depth) × ngCsm(p) × caustic(p の水面への投影) × exp(−σt·t) × Δt。
- 深さに応じた色の吸収と、カメラ深さでの環境光。

【マリンスノー】4k 点、カメラ近くに 8m の箱でループさせる。

【ウォーターライン】
- 近平面上の各画素で ngWaterY と比べて水中マスクを作る。
- 境界に 1.5px のメニスカス（明るい線と屈折のにじみ）。上半分は空気、下半分は水の媒質。

if: 【使うもの】
- NG（影・霧・風）、LZ、NgShadows
- Sky の ngSunE と SH
- placement（葦の帯）
- Water Dynamics の addImpulse(x, z, amp)

【公開するもの】
- ngFroxel テクスチャと ng_froxel GLSL
- env.rain（Object3D）
- setUnderwaterStrength
- pipeline のステージ 'postOpaque'（P8）、'late'（パーティクル）、'underwater'（P13）

budget: low 0.10 / mid 0.50 / high 1.10
内訳（high）：フロクセル散乱 0.45、積分 0.12、再投影込み、雨 0.25（雨天のみ）、蛍・塵 0.05。
水中モード（フロクセルの代わり）：high 1.0 / mid 0.6 / low 0.3（R/4、12 ステップ）。
low の空気：フロクセル無し。解析霧に、任意で放射状ブラーの光芒 0.2ms。

lab: lab/atmofx.html（core のスタブ地形に、柱状のスタブキャスタ（杉の幹 30 本）、スタブ桟橋、水面）。撮るもの：
- 7:00 の森の光芒（柱の影が縞になって霧に抜ける）
- 5:30 の湖上の朝霧（岸の木の足元が霞む）
- 22:00 の灯籠の光暈と蛍
- 雨の近景（筋・着弾・遠景のカーテン）
- 水中の光柱が桟橋の影で切れる
- ウォーターラインの半潜り
- 静止カメラ 64 フレームの差分で時間方向のちらつきが閾値以下
- ghost テスト：カメラを振って霧に残像が出ない

risks: - 3D テクスチャのスライス描画の呼び出しが多い（64+64 ドロー）→ ドローはまとめて 1 パスの MRT 8 枚 × 8 回にする案を試す。上限を超えたら 32 スライスに落とす。
- 再投影の残像（カメラが速く回るとき）→ 近傍の min/max でクランプし、回転速度でブレンドを弱める。
- 雨のパーティクルが TAA でぼける → リアクティブ度 1、筋はやや太らせる。
- 霧の二重計上 → ngVolEnd の分割規則を lab の数値テストで確認する（霧なしシーンとの差が解析値と一致すること）。

### M3 Water Surface & Optics（水面メッシュ・シェーディング・平面反射・屈折/吸収/散乱・泡・スネルの窓・Water ファサード）
files: src/water.js（Water ファサード）
src/gfx/water/{waterMesh.js, waterMaterial.js, waterGLSL.js, reflectionPass.js, refraction.js, underside.js, foam.js, lakeMask.js, index.js}
lab/water.html
scripts/gfx/scenarios/lab-water.mjs
scripts/gfx-tests/water-*.mjs

resp: 【契約の API】Water の公開 API をすべて持つ：surfaceY、surfaceNormal、addRipple/addSplash（Water Dynamics へ委譲）、update、time/wind、capture 系（no-op）、getUnderwaterContext、setUnderwaterView、hidden リスト、uniforms.uLinearOut、causticsUniforms（同じ参照）、rt/reflRT。
【描画】
- 水面の幾何（クリップマップ）と、物理と一致する変位
- 水上と水中のシェーディング
- 平面反射パス（P4）と屈折元（P10）の使い方
- 渚の泡と遡上、ソフトエッジ
- 桟橋の杭のまわりの泡
- 風の突風帯と風下の鏡面

tech: 【幾何】
- カメラ中心の入れ子クリップマップ（正方リング）。L0 はセル 0.2m × 96²、以降セルを 2 倍にして 7 段（最外のセル 12.8m、覆う範囲 ≈ 1.2km）。
- 各段はセル 2 つ分の単位でスナップし、段の境界 10% でジオモーフする。
- InstancedBufferGeometry 1 ドロー（段 = instance）、頂点 ≈ 52k（high）。
- 湖岸距離 SDF で、岸 + 15m より外の頂点を退化させ、陸の塗りを削る。

【変位】
- y = ngWaveH(xz, ngWaterTime, ngWaterWind) × ngShoal(depth_GPU)。waveField と同じ式を GLSL に生成したもの。
- 水平の Gerstner 変位はやめる。CPU の surfaceY(x,z) = waveHeight × shoalGain と、深場で浮動小数の精度内で一致する。
- 250m より先は 0 にフェードする（物理に関係なく、エイリアシング対策）。
- 低周波の法線は、同じ関数の解析勾配から出す。

【法線の合成】
- 勾配空間で足す：s = s_wave + A(xz) × (s_fftA + s_fftB) + s_sim + s_ring + s_rain。N = normalize(−s.x, 1, −s.y)。
- A(xz) = (0.12 + 0.88 × smoothstep(0.25, 0.75, gust)) × shelter × (0.35 + 0.65 × U/6)。夜明けの凪は ×0.3。
- 猫足状の暗い突風帯と、風下の岸の鏡のような凪が同時に見える。

【粗さ：LEAN】
- σ² = Σ_c (E[s²] − E[s]²)_c を、ハードウェア mip で遠くほど自動で増やす。
- α² = 0.02² + 2σ²。
- 遠くの水面が正しくぼけた反射になり、きらつきのエイリアスが出ない。

【Fresnel】n = 1.333 の厳密な誘電体の式（偏光なし）。

【反射】
- uv_r = proj_refl(P_s) + N.xz × 0.35 / (1 + 0.05d)。
- lod = log2(1 + α × hit / (d + hit) × res × 0.5)。hit は反射点までの距離。
- 反射点が近いほど鋭く、遠いほどぼける（接触硬化の反射）。
- RT の外や遮蔽のところは ngProbeSpec(R, α) で補う。

【太陽と月の鏡面】
- GGX に円盤光の正規化（α' = √(α² + (0.5 × θ_sun)²)）。
- ngSunE × ngSunVis(P_s) × D × Vis × F。
- 黄金色の時間の光の道、夜の月の道、灯籠の GGX 点光源。

【屈折】
- uv_t = uv + N.xz × 0.06 × saturate(thick/2)。
- LZ(uv_t) が水面より手前なら uv に戻す（水上の物を引き込まない）。
- mip = 粗さ × 厚み。

【吸収と散乱】
- 視線が水中を通る長さ L（LZ から復元）。T = exp(−σt × L)。
- 内散乱は閉形式：S = σs × p × E0 × (1 − exp(−(σt + Kd × sinα) × L)) / (σt + Kd × sinα)。
  - E0 = 太陽 × (1 − F_sun) × HG(0.8, 屈折後の太陽) ＋ 空の SH の等方項。
  - Kd = σa + 0.3σs。α は屈折後の視線の俯角。
- 湖底の放射は湖底マテリアル側で下向きの減衰と caustics を済ませているので、ここで二重に掛けない。
- 濁りは ctx.turbidity（game の _fillUnderwaterOptics）で σs を掛け算する。

【泡】
- 渚：foam = saturate(1 − depth/0.35) × foamNoise(xz × 0.5 + 流れ) × (0.4 + 0.6 × 遡上の位相)。遡上は waveField.shoreRunUp の GLSL 版。
- 波紋シミュのエネルギーが大きいところ（杭・跳ね）にも泡を出す。
- 泡は albedo 0.8、粗さ 0.6 で ngShade を通す。

【ソフトエッジ】水の厚み 6cm で屈折へ線形に戻す。汀線に細い濡れ線を出す。

【水中から見た水面】
- 臨界角 48.6°。
- 窓の内側：refract(V, −N, 1.333) でプローブを引く（空・岸の杉・桟橋・釣り人が写る）× (1 − F)。屈折した太陽の円盤。
- 窓の外側：全反射。high は SSR 8 ステップ、フォールバックは深場の色。
- 波紋で窓がゆらぐ。

【パス】
- 平面反射 P4 を担当する（仮想カメラ、斜めクリップ y = −0.08、R×0.5、depthTexture、hit 距離の mip）。
- 水面が画面に映らないときや水中ではスキップする。

if: 【使うもの】
- NG（ng_water、ng_atmo、ng_shadow、ng_froxel）、REFR、LZ
- Water Dynamics のテクスチャ：ngFftMoments（ArrayTexture 2 層）、ngRippleSim、リングの uniform 配列、ngCausticTex
- Sky の ngProbe
- 湖岸 SDF、heightfield

【公開するもの】
- Water ファサード
- pipeline のステージ 'reflect'（P4）と 'water'（P11）
- reflRT、water.rt = REFR
- ngWaterY の CPU 実装は waveField をそのまま使う

budget: low 0.55 / mid 1.2 / high 2.4
内訳（high）：反射パスのシーン描画 1.3（R×0.5 = 1024×576、木は LOD バイアス 1.5、草なし）、反射の mip 0.05、水面の塗り 0.9（画面のおよそ半分が水）、屈折の blit と mip 0.15（core の計上）。
low：反射は R×0.33 で隔フレーム（地形・インポスター・桟橋・人物だけ）、LEAN は 1 カスケード、SSR なし。

lab: lab/water.html（world=mp の実際の湖、core の地形スタブ（高さ場＋単色）、スタブ桟橋、釣り人の GLB、魚のスタブ）。撮るもの：
- 夜明けの鏡面（対岸の稜線と杉並が逆さに写る）
- 正午に桟橋から真下（浅場の砂と caustics、深くなるほど青緑）
- 黄金色の時間の光の道
- 夜の月の道と星の映り込み
- 雨の輪
- 突風帯と凪
- 渚の遡上と泡
- 水中からスネルの窓（釣り人と竿が窓の中に写る）
数値のテスト：GPU の水面高さを 64 点で float RT に読み戻し、water.surfaceY との差が深場で < 1mm、浅場で < 5mm。

risks: - 反射パスの費用（シーン 2 回目）→ LOD バイアス、NO_REFLECT レイヤ、R×0.5、水面が見えないときはスキップ。low は隔フレーム。
- クリップマップの泳ぎと、段の境界の継ぎ目 → スナップとジオモーフ。変位が小さい（≤ 0.26m）ので目立ちにくい。
- 屈折の引き込みアーティファクト → 深度の検証とフォールバック。
- 水の外側（陸）の塗りの無駄 → SDF の退化と、早い discard。
- 1 フレームの時刻差（ウキは前フレームの time）→ 0.5mm 程度で問題なし。数値テストで確認する。

### M4 Water Dynamics & Caustics（FFT 風紋・対話波紋シミュ・解析リング・雨の輪・しぶき・caustics・CAUSTICS_GLSL）
files: src/shaders.js（CAUSTICS_GLSL と createCausticsUniforms を export）
src/gfx/waterdyn/{spectrum.js, fft.js, rippleSim.js, rings.js, rainRings.js, splash.js, caustics.js, causticsGLSL.js, index.js}
lab/waterdyn.html
scripts/gfx/scenarios/lab-waterdyn.mjs

resp: 【FFT】スペクトルの生成・時間発展・逆 FFT・LEAN モーメント
【波紋】
- 対話波紋シミュ（ウキ・魚・跳ね・雨・杭）
- addRipple の最新 16 件を解析リングにする
- 雨の輪
【しぶき】addSplash の GPU パーティクル
【caustics】
- caustics の生成
- 魚と共有する causticLight と causticsUniforms（16 個の uCaust* を維持）
- 湖底・岩・水草・組込みの魚が使う ngCausticLight

tech: 【FFT】
- JONSWAP：fetch F = 400m、U10 は NgWind の U（1–8m/s）。
  - α = 0.076 × (U²/(F·g))^0.22、ωp = 22 × (g²/(U·F))^(1/3)、γ = 3.3。
  - 方向分布は cos^2s（s = 8）。
- カスケード B には Elfouhaily の短波項を足す（毛管波 cm 級）。
- 分散関係 ω² = g·k + (σ/ρ)·k³（σ/ρ = 7.28e−5）。
- h0 は決定的ハッシュのガウス乱数で 1 回だけ作る。天候や風速が変わったら新しい h0 を作り、時間発展のパスで 4s かけて 2 本をクロスフェードする。
- 勾配スペクトル i·k·h を sx + i·sz の 1 本の複素数に詰め、Stockham の fragment FFT で逆変換する（256² で 8+8 パス、ツイドルは 8×256 RGBA32F）。
- 仕上げ：(sx, sz, sx², sz²) を ArrayTexture の 2 層に書き、mip を作る。
- 変位には使わない（法線専用。契約どおり）。

【波紋シミュ】
- 波動方程式 h' = (2h − h_prev + (cΔt/Δx)² × ∇²h) × (1 − γΔt)。
  - c = 0.38m/s、Δx = 0.125m（high）、Δt = 1/120、γ = 0.9/s。CFL = 0.025。
- 境界：湖岸 SDF で陸を強く減衰、杭と葦の茎は吸収体（桟橋の幾何から作ったマスク）。
- 窓をスクロールするときは整数テクセル分ずらし、新しく入った縁は 0 にする。
- インパルスはガウス（半径 0.08 × size）を Points の加算で入れる。
- 出力は勾配と、泡用のエネルギー。
- CPU の surfaceY には入れない（法線のみ）。

【解析リング】
- addRipple の最新 16 件を uniform の vec4 配列 (x, z, t0, size) と減衰 τ = dur に入れる。
- 法線 = ∂/∂r [A × sin(k(r − v·t)) × env((r − v_g·t)/w) × e^{−t/τ}]、k = 2π/0.06m、v = 0.23m/s。
- 細かい同心円はここで出し、大きな乱れと岸・杭での反射はシミュが担当する。

【雨の輪】
- 0.25m セルのハッシュ格子で、各セルに乱数の時刻オフセットを持つ解析リング（2×2 近傍の 4 セル）。3 スケールを重ね、強さは rainIntensity。テクスチャ不要。
- 雨粒のうち大きいもの（1/40）は、シミュにも注入する。

【しぶき】
- 2048 個のリングバッファ。1 回の発生で最大 16 件を uniform で渡す。
- 位置は解析的な弾道 p(t) = p0 + v0·t + ½g·t²（CPU の粒子ループ無し）。
- 描き方：速度方向に伸ばした水滴、プローブ反射、太陽の輝点、ソフトパーティクル。
- 着水の時刻に、中心の波紋を遅れて入れる。

【caustics】
- 256² の格子を FFT タイル（16.3m）に張る。各頂点で、屈折した太陽の光線を深さ D = 1.6m の平面まで延ばして投影する。
- 強度は、元の面積と投影後の面積の比（dFdx/dFdy から）。
- 512² RGBA16F に加算する。RGB で IOR を 1.331/1.333/1.337 とずらした色収差。タイルは ±1 の 4 コピーを描いて巻き戻す。そのあと mip を作る。

【causticLight(worldPos, viewNormal)】（シグネチャは不変）
- uv = (P.xz − sunRefr.xz / sunRefr.y × depth + 低周波波の勾配 × min(depth, uCaustWarp.y) × uCaustWarp.x) × uCaustScale.x。
- mip = log2(1 + |depth − 1.6| × uCaustMag × 8)。
- 返り値 = uCaustMixW（事前露出した太陽の水中照度の色）× max(c − 1, 0) × uCaustRange.y × 深さ・距離のフェード × max(N·L, 0) × uCaustStrength。
- 低周波の勾配は waveGLSL({prefix: 'ngCs', slim: true}) で生成する。
- uCaust* の 16 個の名前はすべて残し、意味を上のように割り当てる。

【createCausticsUniforms()】
- game.js の生成箇所をこれに置き換える。
- uCaustTex.value には、caustics RT のテクスチャ（ずっと同じオブジェクト）を最初から入れる。
- water.update が .value を毎フレーム書く。

if: 【使うもの】
- NgWind、湖岸 SDF、桟橋の幾何（Props が core 経由で提供する杭のリスト）
- NG の水の値

【公開するもの（Water Surface と、ほかの水中マテリアル向け）】
- ngFftMoments（sampler2DArray）、ngRippleSim（sampler2D）と窓のパラメータ ngRippleP
- ngRings[16]
- 雨の輪の GLSL：ngRainRingSlope(xz)
- ngCausticTex と ng_caustics の GLSL（ngCausticLight）

【API】
- addRipple(x, z, size, dur)、addSplash(x, y, z, count, power)：キューが満杯なら古いものを捨てる。NaN なら何もしない。
- addImpulse(x, z, amp)：AtmoFX の雨が使う。

【その他】
- shaders.js の CAUSTICS_GLSL と createCausticsUniforms
- pipeline のステージ 'sim'（P1c–e）と 'late'（しぶき）

budget: low 0.10 / mid 0.25 / high 0.50
内訳（high）：FFT 2 カスケード 0.14、LEAN と mip 0.03、シミュ 2 ステップ（768²）0.12、caustics 30Hz で平均 0.08、しぶき 0.05（発生時）。
mid：256² と 128²、シミュ 512²、caustics はモノクロ 20Hz。
low：128² を 1 本（30Hz）、シミュ 256² を 1 ステップ、caustics 256² を 15Hz。

lab: lab/waterdyn.html（平らな深い水盤と浅い砂の段、桟橋の杭スタブ）。撮るもの：
- FFT の勾配と LEAN 分散の可視化（view=fft）、風速 1/4/8m/s の比較
- シミュに addRipple を 1Hz でスクリプト投入：杭での反射と岸での吸収の連続写真
- 解析リングの近接（ウキ規模）
- 雨の輪の密度 3 段階
- しぶきのバースト
- caustics テクスチャ（色収差の縁）と、砂の上の caustics（深さ 0.5/1.6/4m）
- 魚スタブ（createFishMaterial）に causticLight が乗る
数値：addRipple と addSplash を各 10000 回投げても例外 0。

risks: - FFT が float RT に依存する（EXT_color_buffer_float）→ 無い環境は low の経路にし、事前に作った 4 位相のループ法線にする。
- 波紋シミュの窓がカメラについて動くと、ウキの波紋が窓の外へ出る → 解析リングが常に補う。
- caustics が明るすぎ／暗すぎる → 事前露出した太陽照度から直接計算し、白色炉と比べる。
- 魚シェーダの名前衝突 → ngCs* と uCaust* だけを使い、lint する。

### M5 Terrain（クリップマップ地形・PBR 合成配列・湖底と汀線・遠景稜線・地形太陽影）
files: src/terrain.js（Terrain ファサード。数学系と当たりは src/gfx/world を呼ぶ）
src/gfx/terrain/{terrainMesh.js（クリップマップ）, terrainMaterial.js, terrainGLSL.js, synth/{layers.js, stones.js, soil.js, rock.js, mud.js, bake.js}, control.js, horizonRanges.js, terrainShadow.js, shelter.js, index.js}
lab/terrain.html
scripts/gfx/scenarios/lab-terrain.mjs

resp: 【地形の描画】
- 陸と湖底の描画。heightAt と一致させ、盛り上げない。
- 材料 8 層の GPU 合成と高さベースのブレンド。
- 汀線の濡れ帯と遡上の痕、雨の濡れ。
- 湖底の底質は bedAt と一致させ、caustics を乗せる。
- 世界の外（±1km 超）の遠景稜線。

【派生テクスチャ】
- 地形太陽影（P1f）と風下遮蔽マップ
- 制御テクスチャ（草の密度を含む）を他モジュールへ公開する

【Terrain の描画フック】updateShore、setQuality、setLodScale

tech: 【幾何】
- GPU クリップマップ（Losasso–Hoppe）。6 段 × 128² 頂点。L0 のセルは 0.25m（ハイトマップ Near のテクセルと一致）。段の境界 10% でジオモーフ。
- 頂点シェーダで ngTerrainH を手動バイリニア（R32F、線形フィルタに依存しない）。
- 頂点 ≈ 98k、1 ドロー。
- 影用には、Near/Far から作った静的な粗メッシュを別に持つ（2m セル。c0 には 0.5m のパッチ）。

【材料（Texture2DArray、high 1024²、mip 付き）】
2 枚の配列：A = albedo.rgb + height、B = 法線.xy + 粗さ + AO。8 層：
0 杉の落葉と腐葉土
1 苔
2 草地の土
3 玉石の浜（Voronoi の石の高さ場、石ごとに色をずらす、隙間に砂）
4 浅場の砂とシルト（波紋の筋）
5 深場の泥（有機物で黒っぽく、落ち枝の痕）
6 岩（安山岩、地衣類の斑）
7 踏み跡の土
合成は fragment シェーダ（FBM、ドメインワープ、Voronoi の石、勾配マップ）。法線は高さから Sobel で出す。層ごとに 2–4m のタイル。

【ブレンド】
- 高さブレンド：w_i' = max(h_i + w_i − max_j(h_j + w_j) + 0.08, 0)。
- 制御テクスチャ（Near 2048² × 2 枚、RGBA8）は GPU で作る。入力は傾斜、標高、汀線距離、bedKind（lake.bedAt から焼いたもので、底質はゲーム性と一致）、樹冠密度マップ（placement から）、桟橋からの踏み跡、崖（傾斜 > 0.6 で triplanar）。

【反タイリング】
- high：近景 60m は Mikkelsen の hex-tiling（上位 2 層だけ 3 タップ）。
- 距離で 2 スケールをブレンドする。
- 150m より先は、同じ規則で焼いたマクロ色 1024²（±1024m）を 1 タップ。

【汀線】
- 濡れ = saturate((runUpMax + 0.25 − h) / 0.6)。遡上は waveField.shoreRunUp の GLSL 版で、時間で動く。
- 遡上の縁に泡の痕。濡れた砂は albedo × 0.55、粗さ 0.12。
- 雨のときは ngWetAt を足す。平らな土には水たまりを作り、プローブで反射させる。

【湖底】
- 水中の点は ngDownwell と ngCausticLight を通す。
- 沈んだ落ち葉と小枝の斑。

【遠景稜線】
- r = 1.0–2.8km の極座標メッシュ（24k 三角形）。r = 1km で heightAt と連続するリッジノイズ（ゲーム性には関係しない）。
- 樹冠はテクスチャで表し、空気遠近を強くして日本の山並みの青い層を出す。
- カメラの far 3000m の内側に収める。

【地形の太陽影】高さ場＋樹冠の高さを 64 ステップ raymarch し、錐の比率で半影を付ける（1024² R8）。

【風下遮蔽】風上 60m 以内の最大の遮蔽角から 256² を作る。水の突風帯が使う。

【AO】起動時に高さ場の水平線 AO を 8 方向で焼く（1024² R8）。

if: 【使うもの】
- heightfield（Near、Far、bedKind、湖岸 SDF）
- placement（樹冠密度、桟橋の回廊）
- NG（影、霧、濡れ、caustics）

【公開するもの】
- ngTerrainShadow、ngShelter
- ngTerrainControl（草の密度、苔、浜の種類）：Flora が引く
- ngMacroColor
- clipmap.js の段の幾何：Forest の樹冠シェルが使う
- Terrain ファサードの描画フック

budget: low 0.45 / mid 0.80 / high 1.50
内訳（high）：クリップマップの本描画 1.1（hex-tiling、triplanar、PCSS を含む）、遠景稜線 0.1、反射パス内の地形 0.2（反射側の予算に含める）、地形影の更新 0.03（平均）、影キャスタ 0.15（core の影の予算）。
低品質：配列 256²、hex-tiling 無し、triplanar は崖だけ 1 軸。

lab: lab/terrain.html（world=mp、実際の heightfield、スタブの水）。撮るもの：
- 玉石の浜の近景（足元 1.6m）、晴れ／雨
- 杉林の林床
- 崖の triplanar
- 渚の遡上の連続写真
- 水中から見た湖底の泥・砂・岩
- 対岸の遠景稜線の層（16 時と 18:20）
- view=bedKind の重ね表示と terrain.bedAt の比較（一致率 ≥ 99%）
数値：足元 1000 点で、GPU の描画高さ（float RT の読み戻し）と heightAt の差 < 2cm。

risks: - 高さの不一致（足が浮く・沈む）→ L0 のセルとテクセルを 0.25m でそろえ、読み戻しテストで保証する。
- サンプラー上限 16 → 配列にまとめ、表で管理する。
- 合成テクスチャの時間（1024² × 8 層 × 2）→ 層ごとに await して分割する（≤ 25ms × 16）。
- 遠景のタイリング → マクロ色と距離の 2 スケール。
- 湖底を POM などで盛り上げない（魚が埋まる）→ 法線だけにする。

### M6 Forest（杉・ブナ・モミジ・アカマツ・ハンノキ：手続き生成・LOD・八面体インポスター・樹冠シェル・風）
files: src/gfx/forest/{species.js（TREE_SPECIES の寸法は world/placement と共有）, treeGen.worker.js, treeGen.js, barkSynth.js, leafAtlas.js, treeMaterial.js, impostorBake.js, impostorMaterial.js, canopyShell.js, forest.js, index.js}
lab/forest.html
scripts/gfx/scenarios/lab-forest.mjs

resp: 【木】
- placement.trees を読んで、全樹木を描画する（全品質で配置は同じ。見た目の間引きは当たりの無い遠景だけ）。
- 樹種ごとの手続きメッシュ（LOD0/LOD1）、樹皮と葉のテクスチャの合成。
- 起動時のインポスター焼き込みと、時刻に応じた再ライティング。
- 450m より先の樹冠シェル。
- 階層的な風の揺れ。

【影と情報】
- CSM のキャスタ（LOD 別）。
- 樹冠密度・樹冠高さのマップを Terrain・水・雨の遮蔽へ公開する。
- 当たりの寸法（幹の半径と樹高）が表どおりであることを保証する。

tech: 【樹種（種類 × 4 バリエーション。寸法は species.js の表で、ゲーム用の当たりの計算と共有する）】
- 杉：18–32m、まっすぐな幹、上 60% が円錐の樹冠、ほぼ水平でやや垂れる輪生枝、針葉のスプレーの房。赤褐色の縦に裂けた樹皮。
- ブナ：12–24m、多幹気味の丸い樹冠、灰色の滑らかな樹皮に白と緑の地衣の斑。
- イロハモミジ：5–10m。岸沿いで水面へ張り出す層状の枝、掌状の葉。
- アカマツ：尾根の岩場、樹皮の上半分が赤い。
- ハンノキ：水辺 0–6m。

【生成】Worker で決定的に作る（種と variant のシード）。
- 杉：輪生の枝を円錐の包絡に置く。
- ブナとモミジ：空間コロニゼーション（アトラクタ 600–1500）→ 平行移動フレームのチューブ。
- 枝の属性 ngBranch = (pivot の高さ, 剛性, 位相, 階層)。

【葉】
- 葉は房状のカード（杉 900、ブナ 1200 など）。カードの法線と樹冠の球の法線を 0.6 で混ぜ、樹冠を滑らかに陰影する。
- 透過：thick × HG(0.5) で、黄金色の時間に葉が光る。
- 葉のアトラス（2048²：albedo+alpha と、法線・透過・粗さ）は SDF で描く。杉のスプレー、ブナの鋸歯、掌状、松の針。
- アルファの mip はカバレッジを保存するように調整する。アルファテストは Wyman のハッシュ方式（TAA で安定する）。

【LOD】
- LOD0：0–40m（high）、8–16k 三角形。
- LOD1：40–180m、1.5–2.5k 三角形。細い枝を落とし、カードを 2 倍の大きさ・1/4 の枚数にして、同じシルエットに合わせる。
- インポスター：180–450m。
- 樹冠シェル：450m 以遠。
- LOD の間は NgInstanceSet の 6m ディザで切り替える。

【インポスター】
- 半八面体 8×8 フレーム × 128²。樹種ごとに 2048² の 2 枚（4 variant）。
  - A：albedo + カバレッジ
  - B：法線（oct）.xy + 深度 + AO
- 起動時に MRT（count:2）で LOD0 を 1024 回描く（≈ 60ms GPU）。
- 実行時：3 フレームの重心ブレンドと、深度オフセットによる視差補正。
  - ngShade で再ライティングする（時刻・天候に追従）。
  - 深度から復元した位置で CSM を受ける。深度の幅から透過の厚みを出す。
- 影のパスでは、太陽方向に最も近いフレームでアルファテストする（c2–c3）。

【樹冠シェル】
- 地形のクリップマップの外側 3 段を流用する。heightAt + 樹冠高さ（placement から 512² に焼いたもの）だけ持ち上げる。
- 樹冠の凹凸ノイズで法線を作り、葉の SSS と、隙間の暗さで陰影する。
- 樹冠密度 < 0.5 のところは discard。

【風】ngSwayTree（GPU Gems 3 の 16 章式）。
- 幹：高さの 2 乗で曲がる。
- 枝：位相つきの振動。
- 葉：揺らぎ（flutter）。
- 突風場で、林を波のように渡る。

【本数】
- 湖外の森：≈ 30k 本（世界 1km²、25m² あたり 1 本、空き地あり）。
- 当たりのある近景の木（帯の中と FAR_GATE 以内）は全品質で同じ。
- low は 450m 以遠を 50% 間引く（当たりの無い木だけ）。

if: 【使うもの】
- placement.trees と TREE_SPECIES
- heightfield、NG（風・影・霧・濡れ）
- NgInstanceSet、NgShadows.addCaster
- clipmap の幾何

【公開するもの】
- ngCanopyDensity（512²）、ngCanopyHeight：Terrain・AtmoFX・水が使う
- Terrain.updateTrees と setLodScale の実装
- 検証用の treeDims(species, variant) → {baseR, H}：当たりの寸法の検査に使う

budget: low 0.45 / mid 1.00 / high 2.00
内訳（high）：
- LOD0 ≈ 150 本 0.5
- LOD1 ≈ 1600 本（3.2M 三角形）0.7
- インポスター ≈ 12k 枚 0.5
- 樹冠シェル 0.15
- 風と透過を含む
- 反射パス内の森 0.5 と、影キャスタ 0.5 は、それぞれ水・core 影の予算に含める
mid：LOD0 28m、LOD1 120m、インポスター 1024²。low：LOD0 15m、LOD1 70m、インポスター 300m。

lab: lab/forest.html。撮るもの：
- 樹種の整列：各種 LOD0 / LOD1 / インポスターを、同じ画素サイズに合わせて横に並べる（色・明るさ・シルエットの差 ≤ 8%。自動の画像差分）
- 7:00 と 16:30 の杉林の中
- 対岸の森の壁（湖から、正午・黄金色・ブルーアワー）
- 風のフレーム列（10 枚）
- view=shadowCascade で木の影
- 逆光のブナの葉の透過
数値：幹の半径と樹高を species の表と照合する（誤差 ≤ 5%）。

risks: - 描画の負荷が最大級：斜面のインポスターが重なって塗りが膨らむ → 手前から描く順にし、450m より先はシェルにする。インポスターの mip バイアス。
- 焼き込みの時間とメモリ（2048² × 2 × 5 樹種 ≈ 100MB）→ mid/low は 1024²。
- LOD の切り替えで色が跳ぶ → 同じ ngShade を使い、焼き込みの AO と法線を合わせる。整列の lab で比較する。
- CPU のリスト作り直し → バケット単位にし、250ms ごとに間引く。

### M7 Flora（草・笹・シダ・苔・葦・睡蓮・水草（藻場）・小石の散布）
files: src/gfx/flora/{grass.js, grassGLSL.js, sasa.js, ferns.js, scatter.js, reeds.js, lilies.js, weedBeds.js, floraAtlas.js, index.js}
lab/flora.html
scripts/gfx/scenarios/lab-flora.mjs

resp: 【陸】
- 密な GPU の草（逆光の透過、踏み倒し）
- 林床の笹・シダ、花（控えめ）、玉石の浜の小石
【水辺と水中】
- 水深 ≤ 1.5m の縁の葦：placement.reedBeds と一致させる（図鑑の «葦際»）
- 睡蓮：波と同じ関数で上下させる
- 藻場：lake.flats を覆う沈水植物。流れで揺らす（updateUnderwaterProps）
- 水中の caustics と下向き減衰
【当たり】当たりは持たない。藪の輪の当たりは placement が持つ。見た目の藪の輪は Props が担当する。

tech: 【草】
- 頂点属性を使わない手続きインスタンス。インスタンスの ID → カメラ中心のリング格子のセル → ハッシュでジッタ → ngTerrainControl の草密度で判定し、落ちたら退化させる。
- 1 インスタンスは 8 枚の房（1 枚 7 頂点、5 節）。
- 本数：high 30k 房（半径 45m）、mid 12k（28m）、low 3k（14m）。
- 陰影：
  - Lambert にラップ（0.4）と透過（逆光、HG(0.6)）、先端のシーン光沢
  - 高さ方向の AO、根元の暗さ
  - マクロノイズの色むら、枯れた先端
- CSM を受け、影は落とさない（接触影と GTAO で補う）。
- 風は ngSwayGrass。踏み倒しはプレイヤーの足元（uniform 4 点）から押し退ける。
- 45m より先は地形の草土の色と法線に溶かす。

【笹】
- 林床の群落を少ポリのメッシュでインスタンス化する（high 6k 株、半径 35m）。
- 光沢のある葉、SSS、風の揺らぎ。

【シダ】沢筋と水辺（2k 株）。

【小石】
- 玉石の浜の上に、実体の小石を半径 15m で 8k 個、GPU で散布する（高さ場に置く）。
- 形は 4 種、Props の岩のマテリアルを共用し、濡れ帯では濡らす。

【葦（ヨシ）】
- placement.reedBeds（汀線の水深 0.15–1.5m、各点で lake.depthAt から判定）に、40 本/m² の茎を立てる。
- 茎 16 頂点と葉 4 枚 × 12 頂点、高さ 1.8–2.8m、穂。
- 本数：high 16k 本（半径 70m）、その先は房カード（〜250m）。mid 7k（45m）、low 2k（25m）。
- 強い風の揺れ。反射に写す（L:WORLD）。影は high の c0 だけ。

【睡蓮】
- 入り江の浅場（水深 0.4–1.6m）の群落。直径 15–30cm の切れ込みのある円盤、蝋質の鏡面、たまに白や桃色の花。
- 高さは ngWaterY と同じ関数で上下させる（波と完全に同期）。
- NO_REFLECT レイヤ。波紋シミュには減衰体として登録する。

【藻場】
- lake.flats の各円を、ガウス減衰の密度で覆う。水深 1.2–4m で密。
- エビモとクロモ風の茎（1 株 5–9 本、高さ 0.4–1.5m）を high で 20k 本。
- 流れの向き（updateUnderwaterProps の flowDir と flowStrength）で揺らす。
- ngDownwell と caustics を通す。SUBMERGED レイヤ。

if: 【使うもの】
- placement（reedBeds、lilyPatches、weedBeds = lake.flats、clearings）
- ngTerrainControl、heightfield
- NG（風・影・水・caustics）
- Water Dynamics の addDamper

【公開するもの】
- Terrain.updateUnderwaterProps の実装
- underwaterProps.activeCounts（数値）

budget: low 0.20 / mid 0.50 / high 1.20
内訳（high）：草 0.55、笹・シダ 0.2、葦 0.3（反射分 0.1 は水の予算）、睡蓮と小石 0.05、藻場 0.1。

lab: lab/flora.html。撮るもの：
- 17:30 の草原の逆光
- ブナ林の笹の群落
- 汀の葦原（view=depth で水深 1.5m の等深線を重ね、葦の分布と一致すること）
- 睡蓮が波に乗る（ウキのスタブと一緒に上下する連続写真）
- 水中の藻場（lake.flats の円を重ね表示し、覆っていること）
- 雨で濡れた草
数値：草の頂点数と draws、NaN 0。

risks: - 草の頂点負荷と塗りの重なり → 房にまとめ、距離でまばらにする。low は半径 14m。
- TAA で草がぼける・揺れて残像 → 弱いリアクティブ（0.3）を書く。
- «葦際» と見た目のずれ → 判定は placement の同じ関数で行い、テストする。
- 睡蓮と水面がちらつく（Z ファイト）→ 水面より 1cm 上に置き、polygonOffset。

### M8 Props（桟橋・灯籠・小舟・大岩と苔・沈み岩と立ち枯れ・流木・湖底の小物・境界の藪）
files: src/gfx/props/{dock.js, woodSynth.js, lantern.js, boat.js, rocks.js, rockGen.worker.js, rockMaterial.js, structures.js, driftwood.js, bedDebris.js, bushRing.js, index.js}
lab/props.html
scripts/gfx/scenarios/lab-props.mjs

resp: 【桟橋】
- 契約の寸法：床幅 3.4m、歩ける半幅 1.62m、床の上面 ≈ dockY、先端の手すり 2.3m。
- 風化した板、杭と藻、濡れ。

【灯籠】
- PointLight は起動時に固定。発光とゆらぎ。蛾の粒。
- updateLamp の実装（dt ベース）。

【小舟と岩】
- 小舟：waveField で揺らす。当たりは静的。
- 大岩：形は placement.boulders の size/h から。苔と地衣、汀の藻。

【ストラクチャー】沈み岩と立ち枯れを lake.structures の x,z,r,h,rot にぴったり置く。

【小物と藪】
- 流木、湖底の枝・落ち葉。
- 歩ける帯の境目の藪の輪（見た目は当たりの輪と一致させる）。

【影】これらすべての CSM キャスタ。

tech: 【木材の合成】（配列 1024² × 2）
- 年輪と木目（ドメインワープした縦のノイズ）、節、ひび。
- 灰銀色への風化（紫外線劣化）、縁ほど暗い。
- 釘の錆の垂れ。
- 板ごとにインスタンスで色むら・反り・隙間を変える。

【桟橋】
- 板の間 1.5cm の隙間から、下の水面が見える。
- 杭は 2.4m 間隔。水線より下に藻の帯（y < 0.1）、その上に乾いた縁。
- 手すりの上に苔。
- 雨では暗くなり、粗さ 0.15 になり、平らな板に水たまりの輪（ng_wet の雨粒の法線）。

【灯籠】
- 木の柱の灯り。当たりは r0.26、top = dockY + 2.3。
- 2200K の発光に 1/f のゆらぎ。
- 光の届き方：PointLight（組込み向け）、ngLocalLights[0]（ng マテリアルとフロクセル向け）、水面の GGX の点光源。
- 夜に蛾 20 匹。

【岩】
- Worker で icosphere → ノイズ → 角の欠け → 熱侵食 → 窪みの AO を頂点色に焼く。形 8 種 × LOD 3。
- マテリアル：triplanar の安山岩と花崗岩（配列 3 層）。
  - 上向きの面（N.y > 0.4）に苔。日陰（樹冠）と水辺の湿りで厚くする。
  - 水線に沿った濡れた暗い帯と藻（y < 0.05）。
- 水中の岩は ngDownwell と caustics を通す。

【立ち枯れ】
- 樹皮の剥げた白っぽい幹と折れた枝（structures の h の高さ、r で太さ）。
- 沈み岩は r × (1–1.15)、top = 湖底 + h（ゲーム側の top と一致）。

【小舟】
- 木造の和船風。係留ロープ付き。
- ピッチとロールを waveField の勾配から計算する（CPU と同じ関数）。

【境界の藪】
- 当たりの輪（placement.bushRing、r0.55）の位置に、低木の塊を置く。
- 見た目の半径 ≈ 当たり × 1.1。見えない壁を、自然な藪として見せる。

【ドローの予算】桟橋はマージして 2 ドロー、岩は 3 ドロー（LOD）、ストラクチャーは 2 ドロー。

if: 【使うもの】
- placement（boulders、structures、lantern、boat、bushRing、driftwood）
- terrain の桟橋フレーム（dockStart/End/Dir/Y/_dockLen）
- heightfield、NG、NgShadows.addCaster、NgInstanceSet

【公開するもの】
- 杭と茎のリスト → Water Dynamics の減衰体
- ngLocalLights[0]
- 岩のマテリアル関数 → Flora の小石
- Terrain.updateLamp の実装

budget: low 0.15 / mid 0.30 / high 0.60
内訳（high）：桟橋・灯籠・舟 0.2、岩 0.25（苔の triplanar）、ストラクチャーと湖底の小物 0.1、藪 0.05。

lab: lab/props.html。撮るもの：
- 桟橋の一人称（板の風化と隙間から見える水）、晴れ・雨・夜
- 灯籠の光と蛾
- 杭の藻の帯（水中から）
- 苔むした大岩
- 立ち枯れのストラクチャー（水中カメラ）
数値の重ね表示（view=collision）：lake.structures、obstacles、onDock の矩形、dockBlocksSegment の箱を線で描き、見た目と一致すること（撮影で目視＋自動の距離計測）。

risks: - 見た目と当たりの不一致 → 寸法はすべて placement と terrain の値から作り、テストする。
- 桟橋の寸法を変えると、onDock と debug のハードコードがずれる → 寸法は変えない（契約どおり）。
- 灯籠の PointLight が組込みを再コンパイルさせる → 起動時に作り、以後は数を変えない。

### M9 Post & AA（GTAO・接触影・不透明リゾルブ・TAAU・露出測光・Bloom・AgX とグレーディング・DRS・FXAA・debug 表示）
files: src/postfx.js（PostFX ファサード）
src/gfx/post/{gtao.js, contactShadow.js, resolve.js, taau.js, exposure.js, bloom.js, finalPass.js, agx.glsl.js, fxaa.js, drs.js, debugViews.js, nanCheck.js, index.js}
lab/post.html
scripts/gfx/scenarios/lab-post.mjs

resp: 【パイプラインの担当】P7、P9、P14–P17。
【PostFX の契約 API】setSize、setQuality、updateUnderwater(ctx) → gfx.frame.underwater と濁り、render(dt) → NgPipeline.render、composer/bloom（null 可）、warmup（compileAsync）。
【その他】
- DRS：GPU タイマー、無ければ rAF の間隔で判定する。
- debug の各表示と NaN の検出。

tech: 【GTAO】
- R/2。high は 2 スライス × 両側 6 ステップ、半径 1.2m（≤ 64px）、遠くほど弱める。mid は 1 スライス × 4 ステップ。
- 法線は深度の 5 タップの最良勾配から復元する。
- 4×4 の双方向デノイズ。時間方向は TAAU に任せる。

【接触影】太陽方向に 12 ステップ、最大 0.6m、厚み 0.15m。太陽が見えるときだけ。

【リゾルブ】alpha タグを解読して、AO は間接光の分、接触影は直接光の分にだけ掛ける。フロクセルの合成と、水中点の除外（pipeline P9）。

【TAAU】
- Halton の 16 相。
- 深度から再投影する。
- Catmull-Rom 5 タップで履歴を読む。
- YCoCg で分散クリップ（γ 1.0、リアクティブのところは 0.6）。
- 輝度で重みを付けるちらつき対策。
- アップサンプルは Blackman-Harris の重み。
- 履歴を捨てる条件：カメラが瞬間移動（> 5m/フレーム）、水中との切り替え、品質の変更。

【RCAS】0.2。

【露出】
- 中心重みの log 平均を 1×1 で順応させる。
- 非同期の読み戻しで CPU の事前露出へ戻す（4Hz、±1.5EV にクランプ、ポーズ中は止める）。

【Bloom】
- 6 段の mip。下げは 13 タップ（最初の段は Karis 平均でホタル対策）、上げは 9 タップのテント。3.5% を足す。
- 夜と水中は 5% に上げる。

【最終パス】
- AgX（Sobotka の基本形に、控えめな Punchy の見た目。時刻で彩度 1.0–1.12）。
- グレーディング：
  - Bradford の CAT。夜明け +300K の暖色、ブルーアワー −800K の寒色、夜はプルキニエ風の青と彩度 −35%。
  - log 空間の S カーブ。
  - 水中：青緑、彩度 −20%、周辺の色収差 0.3px。
- ビネット 0.12、フィルムグレイン 0.4%（ngTime で動く、ポーズで止まる）。
- sRGB と ±0.5LSB のブルーノイズディザ。

【FXAA】low のみ。

【DRS】
- 1s ごとに GPU の ms を目標（high 14.0、mid 15.0 相当）と比べ、renderScale を ±0.05 動かす。範囲は tier ごと。
- 変えたときは TAAU の重みを調整する。

【NaN の検出】debug のときだけ。HDR を 1/8 に縮小しながら NaN と Inf を数える。

if: 【使うもの】
- RT_A、RT_B、D、LZ、ngFroxel（AtmoFX）
- 露出の目標（Sky）
- gfx.frame のジッタ

【公開するもの】
- PostFX ファサード
- ngJitter の生成
- 露出の読み戻し → Sky
- debug 表示の登録 API：registerDebugView(name, glsl)。各モジュールが自分の表示を足せる

budget: low 0.50 / mid 0.75 / high 1.40
内訳（high）：GTAO と接触影 0.45、リゾルブ 0.12、TAAU（O = 2560×1440）0.35、露出 0.03、Bloom 0.25、最終と RCAS 0.2。
low：AO と TAA 無し。FXAA 0.15、Bloom 4 段、最終パス。

lab: lab/post.html（静止シーン＋スクリプトで動くカメラ、細い竿と糸のスタブ、草、きらつく水面の球）。撮るもの：
- TAA の負荷試験（竿の振り、横移動、草の揺れ）：残像とちらつきを 64 フレームの差分で数値化
- AO と接触影の有無の比較
- 露出の遷移（林の陰 → 日向 → 水中）の連続写真
- AgX とトーンカーブの確認用チャート（24 色パッチ、±4EV）
- Bloom（太陽と灯籠）
- DRS の追従グラフ

risks: - TAA の残像（キャラクター、ウキ、糸、魚）→ リアクティブタグ、分散クリップ、履歴を捨てる条件。最悪の場合は設定で FXAA に切り替えられるようにする。
- 外れ値の多さ（太陽の glint）でホタル → 輝度で重みを付け、Bloom の最初の段は Karis 平均。
- 露出の読み戻しの遅れ → 目標 EV は CPU の純関数で先に決まっているので、測光は微調整だけ。
- GPU タイマーが無い環境 → rAF の間隔で DRS し、ヒステリシスを大きくする。

## gameplayContract
■ 配置と当たりの層（src/gfx/world/placement.js と collision.js。three・DOM 無し。Math.random 禁止）
- 乱数
  - rng は mulberry32(hash32(seed, STREAM)) を系統ごとに分ける：'trees'、'boulders'、'bush'、'reeds'、'lilies'、'weeds'、'driftwood'、'props'。
  - セル局所の決定的配置 cellRng(seed, stream, cx, cz) を使う：木は 4m セルのジッタ格子で 1 候補（±1.4m）、岩は 16m セル。
  - 結果は処理の順序やスレッドに依存しない。一部の領域だけ Worker で作っても同じになる。
- API
```js
export const PLACEMENT_VERSION = 1, FAR_GATE = 24, TREE_SPECIES = {...};  // 樹種・variant ごとの canonical {H, baseR}
export function placeCollidables(lake): Collidables;  // 同期。Terrain ctor の中、≤ 30ms
export function placeWorld(lake): WorldLayout;        // 全体。Worker でも可。collidables を含む
export function hashLayout(x): string;                // テスト用
WorldLayout = { trees: Float32Array /*stride 8: x,z,y,species,variant,scale,rot,flags*/, treeCount,
  boulders[], bushRing[], lantern, boat, structures[], reedBeds[], lilyPatches[], weedBeds[],
  driftwood[], canopyGrid, clearings }
```
- 木の生え方の規則：旧版の規則を引き継ぐ。
  - heightAt ≥ 1.6、slope ≤ 0.78、桟橋から ≥ 3.6m、スポーンから ≥ 6m。
  - 森の場（ノイズ）で空き地を作る。杉は沢筋と低い斜面、ブナは尾根、モミジは汀線から 5–25m、ハンノキは 0–6m、アカマツは急な尾根。
- 樹高とスケール
  - 樹高 = scale × H_variant。幹の半径 = scale × baseR_variant。
  - 当たり：{r: max(幹の半径 × 1.15, 0.28), top: y + 0.9 × 樹高}。
  - 帯の中（汀線 + WALK_INLAND）と FAR_GATE 以内の木だけを登録する。
  - 見た目のメッシュは species の表の canonical 寸法に合わせて作り、テストで誤差 ≤ 5% を保証する。
- 大岩：size > 1.4 かつ h > −0.9 のときだけ当たりを持つ（r = 見た目の半径 × 0.95、top = y + 高さ × 0.9）。見た目は同じ size/h から作る。
- 藪の輪：shoreRadius + 72 − 5 〜 +4 の帯。角度を 1.1m 間隔にして r0.55。
- 灯籠：r0.26、top = dockY + 2.3。位置は旧版の定数で決める。
- 小舟：r0.85 の円 2 つ。
- 空けておく範囲：桟橋から 3.4–3.6m、スポーンから 6m。
- 品質に依存しない：品質の引数は受け取らない。見た目の間引きは、当たりの無い遠景の木だけに visualKeep(i, tier) で行う。
- collision.js
  - 旧 terrain.js の addObstacle / blockedAt / obstacleTopAt / lineBlocked と桟橋の判定（_findDock、onDock、distToDock、dockBlocksSegment、_dockLocal）を、ロジックを変えずに移す。
  - 8m のハッシュ（半径 < 7.6m）、obstacles は平らな配列。
- 構築の順序：Terrain の ctor は同期で次を済ませる。これで _initMap がすぐ shoreRadius を呼べる。
  1. lake の包み
  2. collision の構築
  3. placeCollidables を登録
  4. structures（top = heightAt + h）
  - 見た目用の placeWorld は、そのあと非同期で作る。

■ ストラクチャー・藻場・葦の対応
- 沈み岩と立ち枯れ：lake.structures の x,z,r,h,rot,kind にぴったり置く（Props）。terrain.structures と structureNear は同じ配列から作る。
- 藻場：lake.flats の各円を weedBeds として覆う（Flora）。
- 葦：reedBeds は汀線の帯のうち、lake.depthAt が 0.15–1.5m の点だけにする。
  - 除外：桟橋の回廊 ±6m、スポーン 6m、急な岩の岸（1m 以内に 1.5m を超える水深の帯が無い所）。
  - それ以外の縁は、10m を超えて空白が続かないようにする。«葦際»（水深 1.5m 以下の岸ぎわ）と見た目が一致する。
- どの対応も placement.test で数値検査する。

■ 波の物理（CPU と GPU の一致）
- src/waveField.js は変更せずに残す（物理の唯一の定義元）。
- Water.surfaceY(x,z) = depthAt ≤ 0 なら 0、それ以外は waveHeight(x, z, time, wind) × shoalGain(depth)。surfaceNormal も旧版と同じ。
- GPU の水面変位は waveGLSL({prefix: 'ngW'}) の出力を ng_water チャンクに埋め込み、同じ時刻・同じ wind（ngWaterTime と ngWaterWind は water.update が書く）で評価する。
- 水平の Gerstner 変位は使わない。高さ場として一致する。
- 細かい成分（FFT・シミュ・リング・雨）は法線だけ。
- 睡蓮と小舟も同じ関数で上下させる。
- 1 フレームの時刻差（ウキは前フレームの time を使う）は ≈ 0.5mm で許容する。
- テスト：lake-calm-water-test の物理部分をそのまま残す。そのうえで lab の読み戻しで、GPU と CPU の差（深場 < 1mm）を検査する。

■ caustics（魚と共有）
- shaders.js が次を export する：
  - CAUSTICS_GLSL：uCaust* の 16 個の宣言と vec3 causticLight(vec3 worldPos, vec3 viewNormal)。y > −0.02 は 0。内部は ngCs* と、インクルードガード付きの ng チャンク。
  - createCausticsUniforms()
- game.js は createCausticTexture の代わりにこれを呼ぶ（1 行）。
- 同じオブジェクトを Terrain → Water（water.causticsUniforms）→ FishSchool → RemoteFishSchool に配る。
- water.update は .value だけを毎フレーム書く。uCaustTex.value は caustics RT の不変なテクスチャ。
- 魚の注入の形（#include <common> の後ろに CAUSTICS_GLSL、emissivemap の後ろに加算）はそのまま動く。
- 組込みパッチの ng チャンクはガード付きなので、再定義にならない。

■ ファサード
- Environment（sky.js）
  - WEATHERS は同じ値。
  - tickWeather は旧 317–334 行を移植する（同じ天候は重み ×0.35、2.5–6.5h）。
  - setWeather：不正なキーは無視し、見た目は λ ≈ 0.35 で damp。{instant} は撮影用。
  - weatherTimer は書き込み可。
  - rainIntensity / cloudiness の damp（0.35 / 0.4、実秒）、nightAmount、sunDir と keyDir（in-place）、各色は THREE.Color。
  - underwater setter、sky / rain、skyUniforms.uStars / uLinearOut。
  - sun（DirectionalLight）。shadow.map には CSM の RT。
  - scene.fog は NgFog（near/far あり）。this.scene も持つ（debug.js が env.scene.fog を読む）。
- Terrain（terrain.js）
  - 数学系は lake に直結する。当たりは collision。
  - heightTexture は Near の高さ場。
  - static load*Textures() は Promise.resolve(null)。
  - updateWind / updateTrees / updateLamp / updateUnderwaterProps / updateShore / setQuality / setLodScale は各モジュールへ。
  - overWaterProps = []。
  - underwaterProps = {group: new Group()（空のダミー）, activeCounts}：game が水上で group.visible=false にしても、本物の水中物が消えないようにする。
  - waterPlants = {submergedMeshes: []}。
  - whenReady(onProgress) を追加する。
- Water（water.js）
  - capture / captureReflection は no-op。
  - getUnderwaterContext は旧版と同じキーを返す。
  - setCaptureHidden は保存だけ、setReflectionHidden は P4 で使う。
  - rt = REFR、reflRT = 反射の RT。
  - addRipple / addSplash は満杯でも例外を出さない。
- PostFX（postfx.js）：composer = null、bloom = null（perf は optional chaining で読む）。warmup() を追加する。

■ game.js の変更（許可リスト。?v= 付きの import は維持）
1. causticsUniforms を createCausticsUniforms() にする。
2. renderer の antialias:false。
3. Terrain を作った直後に await this.terrain.whenReady?.(p)（文言は Lake / Bed の段のまま）。
4. 'Ready' の前に await this.postfx.warmup?.()（renderer.compileAsync）。
- それ以外は変えない。
- applyQuality の needsUpdate は配列マテリアルに効かないので、gfx のマテリアルは配列を使わない。

■ debug.js との互換
- 読まれるものを維持する：scene.fog.near/far、terrain._dockU / _dockLen / _dockLocal / obstacles / _obsGrid / structures / lake / hole(s) / flat(s)、env の各値、water.wind。
- debug のヘルパー（depthTest:false、renderOrder 900）は、auditor が LATE に入れて最後に描く。
- 水中を歩く debug（一人称のカメラが水中）も、水中経路がどのカメラでも動くので対応できる。

■ マーカーと描画順
- aimMarker / marker（fog:false、renderOrder 6）は LATE で水面の後に描く。
- GPU の水面は CPU と一致するので、+0.03m のマーカーは常に見える。
- ウキ・糸・名札も LATE か WORLD。屈折と反射への写り方は pipeline の表のとおり。

■ Worker への汚染防止：src/gfx/world と waveField は、lakefield と同じく three・DOM 無しの規則で書く。Worker の import 鎖には何も足さない。

## assets
■ 方針
- 環境のテクスチャとメッシュは 100%、自前のコードで起動時に生成する（GPU の fragment 合成、または Worker で CPU 生成）。
- オフラインで焼いてコミットするのは 1 点だけ：scripts/gfx/bake-bluenoise.mjs（void-and-cluster を 16 スライスの時空間ブルーノイズに拡張）→ assets/gfx/stbn64x16.png（64×1024 R8、≈ 70KB）。
- コミットするバイナリの上限は合計 256KB。
- 失敗時のフォールバック：STBN が読めなければ IGN のハッシュを使う。

■ 起動時に生成するもの（high の寸法。mid は 1/2、low は 1/4。M1 Pro 実測の目標時間）
1. 高さ場（core、Worker 4 本）：Near 2048² R32F（16MB）、Far 1024² R32F（4MB）、bedKind 512² R8、湖岸 SDF 256² R16F。0.8s（他と並行）。
2. 配置（core）：collidables は同期 30ms、placeWorld は Worker で 0.2s。
3. 派生（GPU）：地形の法線と AO（水平線 AO 8 方向）1024² 30ms、マクロ色 1024²、制御テクスチャ 2048² × 2、風下遮蔽、樹冠密度と高さ 512²。計 60ms。
4. 地形の PBR 配列：2 × 8 層 × 1024² RGBA8 + mip（85MB）。16 回に分けて各 ≤ 25ms、計 250ms。
5. 樹木：
   - メッシュ 5 種 × 4 variant × LOD 2（Worker、0.6s）
   - 樹皮の配列 5 層 × 1024² × 2（60ms）
   - 葉のアトラス 2048² × 2（80ms。草・笹・葦・睡蓮・シダも同じアトラスに入れる）
   - インポスター 5 × 2048² × 2（100MB）、焼き込み 1024 ドローで 60–100ms
6. 岩：形 8 × LOD 3（Worker、0.15s）、岩の配列 3 × 1024² × 2（40ms）。
7. 木材：配列 4 × 1024² × 2（30ms）。
8. 空：
   - 雲のノイズ：Perlin-Worley 128³ RGBA8（8MB）、Worley 32³、curl 128²、天気マップ 512²。30ms。
   - 大気 LUT 2ms、月 512²、星 9000 個（CPU 5ms）。
9. 水：FFT の h0 と twiddle（5ms）、泡のノイズ 512²（5ms）。
10. シェーダ：≈ 55 本の ng プログラムと組込み ≈ 6 本を KHR_parallel_shader_compile + renderer.compileAsync でコンパイルする。1.2–2.0s（読み込み画面の 'Ready' 前）。

- 合計の見込み：クリティカルパスで ≈ 3.5–4.5s。予算は 6s 以内。
- build() の各段で await する。GPU の合成は 1 回 ≤ 30ms に刻み、読み込み画面の描画を止めない。

■ GPU メモリの見込み（high）
- 描画 RT：A / B / D / LZ / REFR（R = 2048×1152）≈ 75MB
- TAAU の履歴 2 枚（O = 2560×1440）59MB
- Bloom 20MB、反射 8MB、フロクセル 3 枚 22MB、CSM 67MB、雲パノラマ 25MB、プローブと PMREM 8MB
- テクスチャ ≈ 330MB
- 合計 ≈ 620MB。M1 Pro の統合メモリで許容する。mid ≈ 300MB、low ≈ 150MB。

## qualityTiers
全項目 low / mid / high（予算は M1 Pro で実測する。mid の実機（無印 M1）は ×2.0、low の実機（弱い内蔵 GPU）は ×8 を目安に換算）

| 項目 | low | mid | high |
|---|---|---|---|
| 基準の出力と目標 | 1280×720、M1 Pro で ≤ 3.5ms（弱い iGPU で ≈ 30fps） | 1920×1080、M1 Pro で ≤ 7.0ms（無印 M1 で 60fps） | 2560×1440、M1 Pro で ≤ 14.0ms（60fps） |
| renderScale の既定〔DRS の範囲〕 | 0.75〔0.5–1.0〕 | 0.85〔0.67–1.0〕 | 0.80〔0.67–1.0〕 |
| AA | FXAA | TAAU 8 相 | TAAU 16 相 + RCAS |
| HDR の形式 | RGBA16F（無ければ RGBA8 の LDR） | RGBA16F | RGBA16F |
| CSM | 2 × 1024、4 タップ | 3 × 1536、PCF 8 | 4 × 2048、PCSS 12+16 |
| 地形の太陽影と雲影 | 512² / 256² | 1024² / 512² | 1024² / 512² |
| 平面反射 | R × 0.33、隔フレーム、地形・インポスター・桟橋・人物だけ | R × 0.4、毎フレーム、草なし | R × 0.5、毎フレーム、LOD バイアス 1.5 |
| 水の FFT | 128² × 1、30Hz | 256² + 128² | 256² × 2 |
| 波紋シミュ | 256²、48m、1 ステップ | 512²、80m、2 ステップ | 768²、96m、2 ステップ |
| caustics | 256² モノクロ、15Hz | 512² モノクロ、20Hz | 512² RGB、30Hz |
| 水面メッシュ | 6 段 × 48² | 7 × 64² | 7 × 96² |
| 雲 | 2D 3 層（raymarch なし）、パノラマ 1024×384、1/8 更新 | 1536×576、48+4 ステップ、1/16 | 2048×768、64+6 ステップ、1/16 |
| 大気 LUT | SkyView は隔フレーム | 毎フレーム | 毎フレーム |
| プローブ | 128²、2 フレームに 1 面 | 128²、1 面/フレーム | 256²、1 面/フレーム |
| PMREM の間隔 | 4s | 4s | 2s |
| フロクセル | なし（解析霧＋任意で放射状の光芒） | 128×72×48、96m、30Hz | 160×90×64、128m |
| 水中ボリューム | R/4、12 ステップ | R/2、16 ステップ | R/2、24 ステップ |
| GTAO / 接触影 | なし（焼いた AO と SH） | R/2、1 スライス × 4 / 8 ステップ | R/2、2 × 6 / 12 ステップ |
| 地形のクリップマップ | 5 段 × 64² | 6 × 96² | 6 × 128² |
| 地形の材料配列 | 256²、hex-tiling なし | 512²、hex-tiling なし | 1024²、近景 60m は hex-tiling |
| 木の LOD（LOD0 / LOD1 / インポスター / 以遠） | 15 / 70 / 300m / シェル（遠景 50% 間引き） | 28 / 120 / 400m / シェル | 40 / 180 / 450m / シェル |
| インポスターのアトラス | 1024² | 1024² | 2048² |
| 草 | 3k 房、14m | 12k、28m | 30k、45m |
| 笹・シダ | 1k 株 | 3k | 8k |
| 葦 | 2k 本、25m | 7k、45m | 16k、70m（その先はカード 250m） |
| 藻場 | 4k 本 | 10k | 20k |
| 小石 | なし | 3k | 8k |
| 雨の筋 / 着弾 | 2.5k / 400 | 6k / 800 | 12k / 1.5k |
| しぶきのプール | 512 | 1024 | 2048 |
| 蛍 | 80 | 150 | 300 |
| Bloom | 4 段 | 5 段 | 6 段 |
| 露出 | 予定の EV だけ | 予定の EV + 測光 | 予定の EV + 測光 |
| DPR の上限（game.js 既存） | 1 | 1.5 | 2 |
| GPU メモリ | ≈ 150MB | ≈ 300MB | ≈ 620MB |

- 当たりと配置は、全品質で同一。
- 品質の切り替えで再コンパイルするのは RT の形式に関わる少数のパスだけ（残りは ngQuality の uniform）。
- テクスチャ合成の解像度は、それまでの最大品質を保つ。品質を上げたときはバックグラウンドで作り直す。

## buildOrder
■ フェーズ 0（0.5 日、Core-A が単独）：足場
- run-tests.mjs の並びを直す。KEEP の 17 本を先頭にする。GRAPHICS の 15 本と、MIXED の後半の正規表現は削除する。
- 旧ファイル（§2）を削除し、ファサードをスタブにする。
- game.js の許可リスト 4 点を修正する。
- lab/_lib/harness.js の骨組みを作る。
- ゲートの条件：
  - ゲームが灰色の世界で起動する。
  - KEEP のテストが緑。
  - 600 フレームの連続実行で例外 0。

■ フェーズ 1（2–3 日、並行 2 人）：Core
- Core-A（描画の芯）
  - uniforms / layers / ng_* の GLSL チャンク（大気は解析式と定数 LUT のスタブ、caustics・フロクセル・空はスタブ）
  - material.js、auditor.js（組込みパッチ）
  - NgShadows（CSM 全部）、NgWind、濡れ
  - NgPipeline の P0–P17 の骨組み：各ステージの口と単純な既定実装（トーンマップは ACES の仮実装、AO なし、TAA なし）
  - targets / fullscreen / gpuTimer / safe / quality
  - lab ハーネスの完成
- Core-B（世界データ）
  - heightfield（Worker）、placement / collision（ロジックの移植と、決定性・品質非依存のテスト）
  - Terrain / Water / Environment ファサードの数学・当たり・天候の API（旧挙動の移植）
  - NgInstanceSet、clipmap の幾何
  - 灰色のクリップマップ地形と、単純な水面（フレネル＋プローブのスタブ）
- ゲート（Core 受け入れ）：
  - ゲーム内で、地形・水・影・組込みキャラクターの霧と影がスタブの見た目で正しく動く。
  - 契約テスト（後述）が全部緑。
  - 各 lab で撮影できる。
  - 予算の計測が出る。
  - core の API は v1 として凍結する。変更の要望は docs/nextgen/core-requests.md へ書き、core の担当が毎日まとめて取り込む。

■ フェーズ 2（4–6 日、並行 9 人）：モジュール
- 各自の場所：src/gfx/<module>/ と lab/<module>.html とシナリオとテストだけを触る。ファサードは担当者だけが触る：
  - sky.js → M1
  - water.js → M3
  - shaders.js → M4
  - terrain.js の描画フック → M5（木・草・岩の委譲は 1 行ずつで、各担当が PR に含める）
  - postfx.js → M9
- 依存関係（スタブで切ってあるので、すべて初日から並行できる）
  - core → 全員
  - M4（FFT・シミュ・caustics のテクスチャ）→ M3。それまでは平らな法線と静的な caustics
  - M1（SH、プローブ、SkyView）→ M2 / M3 / 全マテリアル。それまでは CPU の解析スタブ
  - M5（ngTerrainControl、clipmap）→ M7（草の密度。それまでは core の傾斜・標高による粗い規則）
  - M6（樹冠マップ）→ M5 / M2。それまでは placement から core が焼く粗い版
  - M8（杭のリスト）→ M4 の減衰体
  - M9 → 独立（core の RT だけを使う）
- 毎晩、integration ブランチへマージし、全体の撮影（baseline.mjs の 7 視点＋水中＋雨夜）で結合の破綻を早く見つける。
- 各モジュールの完了条件：
  - lab の証拠一式（撮影と数値）
  - GPU の予算内（M1 Pro、3 品質）
  - 例外 0、NaN 0
  - サンプラー ≤ 16
  - ドロー数の予算
  - テスト緑

■ フェーズ 3（2–3 日、2 人）：統合とルック開発
- 全モジュールを入れた本番のゲームで調整する。
  - 時刻 9 点 × 天候 3 × 視点 6 の撮影表でルックを詰める。露出・霧・水の係数・グレーディングは Sky と Post の担当と一緒に。
  - 性能：DRS なしで high ≤ 14ms を目指す。ボトルネックの予算を再配分する。
- MP の確認：mp-browser-test、2 クライアントで配置と当たりのハッシュが一致すること。
- capture-docs の撮り直し。
- 品質の切り替えと水中の往復の連続試験。
- 最終のテスト一式を回し、README / CONTRACT を更新する。

■ フェーズ 4（任意）：磨き込み
- Display P3 の出力、reversed-Z（EXT_clip_control）、季節の切り替え（紅葉）、流れ星、雷。

## testPlan
■ Node の単体テスト（run-tests.mjs。KEEP を先頭にして、最初の失敗で後ろが止まっても KEEP が必ず走る順にする）
1. lake-unchanged
   - resolveLake(123456789).tries === 1。
   - makeLake(123456789) の出力（heightAt を 64² で標本化、structures、flats、holes、dock）の SHA がコミット時の値と一致する。
2. placement-determinism
   - placeWorld を 2 回、および別の分割（領域ごとに Worker 相当）で作っても hashLayout が同一。
   - Math.random をモックで壊しても結果が変わらない。
3. placement-quality-independent：collidables と obstacles の配列が、quality 引数なし・tier の偽装 3 通りで同一。
4. collision-dims
   - 幹の r = max(baseR × scale × 1.15, 0.28)、top = y + 0.9H。
   - 大岩の条件（size > 1.4 かつ h > −0.9）。
   - 藪の輪の帯と r0.55。
   - 灯籠 r0.26 / top dockY + 2.3、小舟 2 × r0.85。
   - 桟橋からの距離 3.4–3.6m、スポーンからの距離 6m。
   - _obsGrid の半径 < 7.6m。
   - onDock と dockBlocksSegment の境界値（旧版と同じ期待値の表）。
5. structures-exact：terrain.structures の x,z が lake.structures と完全一致、top = heightAt + h。見た目の配置表（Props が export）も一致。
6. reeds-and-weeds
   - reedBeds の全点で 0.15 ≤ depthAt ≤ 1.5。
   - 除外区域の外で、汀線の空白が 10m を超えない。
   - weedBeds が lake.flats を 1 対 1 で覆う。
7. wave-parity
   - Water.surfaceY = waveHeight × shoalGain（旧仕様）。
   - GPU のチャンク文字列が waveGLSL({prefix: 'ngW'}) の出力を含む（手で写していない）。
   - lake-calm-water-test の物理部分は、そのまま残す。
8. weather-api
   - tickWeather の抽選分布（10 万回。同じ天候の ×0.35、2.5–6.5h）。
   - setWeather の不正なキーを無視。
   - weatherTimer を書ける。
   - damp の係数。
   - nightAmount と sunDir の式が旧版と一致。
9. env-pure：同じ (hour, weather の状態) なら、sunDir・色・ngSunE・EV・霧の係数がビット単位で同一（atmosphereCPU の決定性）。
10. api-safety：addRipple / addSplash を NaN・Infinity・範囲外・1 万回で呼んでも例外なし。getUnderwaterContext のキーがそろっている。causticsUniforms が 16 個の uCaust* を持ち、参照が不変。
11. glsl-lint
    - src/gfx の全 GLSL で、トップレベルの関数・uniform・varying・define が ng 接頭辞である（例外は CAUSTICS_GLSL の causticLight / uCaust* / ngCs*）。
    - 魚のシェーダ名（csWave*、uTime、uAmp、uFreq、uLen、uBend、vFishWorldPos）と衝突しない。
    - すべてのチャンクにインクルードガードがある。
12. chunk-anchors：three r180 の ShaderChunk に、auditor の差し込み先（getDirectionalLightInfo、lights_fragment_end、fog_*）が存在する。
13. performance-test（MIXED）：addRT(game.env?.sun?.shadow?.map) の文字列と estimateRtBytes の形を維持。water.rt / reflRT が RT か null。
14. walk-zone-test（MIXED）：藪と blockedAt(y)、game.js の歩行とカメラの文字列。

■ ブラウザのテスト（scripts/gfx/shot.mjs。ヘッドレス Chrome で M1 の GPU を使う）
1. 各 lab のシナリオ
   - 撮影の行列：時刻 7 点 × 天候 3 × 品質 3 の部分集合。
   - console のエラーと警告が 0。
   - __gfx.stats() の gpuMs がモジュール予算 × 1.25 以下。
   - draws と programs が上限以下。
   - nanCheck() === 0。
2. 読み戻しの数値テスト
   - 水面の GPU と CPU の差（深場 < 1mm）。
   - 地形の描画高さと heightAt の差 < 2cm。
   - bedKind の一致率 ≥ 99%。
   - 白色炉 ±5%。
   - 18% グレーの露出。
   - LOD の整列の差 ≤ 8%。
3. soak（index.html）
   - 3000 フレームを通す。時刻の早送り、天候の即時切り替え、品質の往復、水中の往復、addSplash の嵐、MP ダミーのプレイヤーの出入りを含める。
   - 例外 0、描画の abortFrame 0。
   - メモリ（renderer.info.memory）が単調に増えない。
   - 全モジュールが faulted = false。
4. 故障の注入：各モジュールの gpu() に throw を入れても、フレームが完走し、代替表示になり、MP のラッパー（sharedFish.update など）が走り続ける。
5. シェーダのコンパイル失敗を注入すると、該当モジュールだけが隔離される。
6. ゴールデン画像
   - baseline.mjs の 7 視点（dawn-3p、morning-fp、noon-fp-down、noon-shore、dusk-3p、night-fp、rain-fp）に、水中・ブルーアワー・曇り・森の中を足した 12 視点。
   - 前回の採用画像との SSIM を見る。閾値を下回ったらレビュー（見た目の退行の検出）。
   - 新旧の比較は docs/nextgen/shots/ に保存する。
7. 性能の回帰：high の 1440p で 5 視点の gpuMs と CPU ms を記録する。10% を超えて悪化したら失敗。
8. MP：mp-browser-test と run-mp-protocol-test がそのまま通る。2 クライアントで配置のハッシュが一致する。
9. 起動時間：M1 Pro で build 開始から Ready まで、旧版 + 6s 以内。各段の内訳をログする。

## topRisks
1. GPU 予算の超過（1440p で平面反射・密な森・PCSS・フロクセル・水が重なる）
   → 対策：M1 Pro で実測する予算を全モジュールに割り付け、lab で自動の合否にする。DRS（0.67 まで）。反射の LOD バイアスと NO_REFLECT レイヤ。遠いカスケードとプローブと雲の償却。削る順番を決めておく：フロクセルを 30Hz → PCSS を PCF に → 反射 R×0.4 → 草の半径。

2. シェーダのコンパイル時間とコンパイル時のカクつき（ANGLE Metal で 1 本 50–150ms × 60 本）
   → 対策：品質の差は uniform で出し、define の組み合わせを最小にする。KHR_parallel_shader_compile と compileAsync を 'Ready' の前に済ませる。auditor が初回描画の前にパッチする（2 回コンパイルしない）。lab で programs の数を監視する。

3. three の内部に依存した組込みパッチ（チャンク文字列の差し込み）が壊れやすい
   → 対策：r180 を vendor で固定する。アンカーの存在テスト。見つからなければ従来の霧へ自動で落とす。魚との名前衝突は ng 接頭辞、インクルードガード、lint で防ぐ。

4. サンプラーの上限 16（超えるとリンク失敗で、例外無しに消える）
   → 対策：配列テクスチャにまとめる。SH は uniform。重いマテリアルの内訳表を lint する。onShaderError での隔離。

5. TAAU の残像とぼけ（竿・糸・ウキ・魚・草・水の glint）
   → 対策：alpha タグによるリアクティブの仕組み、分散クリップ、履歴を捨てる条件、輝度重み、RCAS。最後の手段として、設定で FXAA に切り替えられる。

6. 配置と当たりの決定性が崩れる（MP で当たりがずれる。旧版の実際の不具合）
   → 対策：配置の層を純関数・品質非依存・セル局所の rng にする。ハッシュのテストと、2 クライアントでの一致テスト。見た目は配置から導出するだけ。

7. 毎フレームの例外（MP の同期を止める）
   → 対策：全モジュールを safe() で隔離する。パイプライン全体の try で素通しの描画へ落とす。入力の NaN を捨てる。キューは上限つき。故障注入のテスト。

8. 起動時間とメモリ（≈ 620MB、4.5s）
   → 対策：Worker による並行化、GPU 合成を 30ms 単位に刻む、tier ごとの解像度。インポスターは mid/low で 1024²。読み込み画面の各段で await。

9. 9 人の結合でルックがばらばらになる（光・霧・露出の解釈の違い）
   → 対策：ライティング・大気・露出は core の ngShade / ngApplyAtmo だけで行う（自前の光の計算を禁止）。白色炉とグレーカードの lab。毎晩の統合撮影。フェーズ 3 に専任のルック開発。

10. 浮動小数の RT とフィルタの対応差（EXT_color_buffer_float、OES_texture_float_linear）
    → 対策：起動時に能力を判定する。高さ場は手動バイリニア。無い環境は low の LDR 経路。FFT を諦めて 4 位相のループ法線にする。

11. 平面反射と屈折の境界の破綻（汀線・杭の足元・水面を貫く物）
    → 対策：斜めクリップを y = −0.08 にする。屈折は深度で検証する。厚みでのソフトエッジ。接触硬化の反射のぼかし。

12. CPU の負荷（ドローコールと JS のリスト更新）
    → 対策：全パスで ≤ 350 ドロー。インスタンスのリストは 250ms ごとのバケット単位。静的物は matrixAutoUpdate=false。auditor は WeakSet で差分だけ見る。
