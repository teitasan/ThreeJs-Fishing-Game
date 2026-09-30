# Phase 0 のスパイクと実測（Core-A）

計測機：MacBook Pro（M1 Pro、GPU 14 コア）、Chrome（Playwright の headless、`--use-angle=metal`）。
数値はすべて `scripts/gfx/shot.mjs` のシナリオで再現できる（各節の «再現» の行）。
GPU 時間は budget の `'sync'` 方式（パスの前後を 1×1 の readPixels で挟んだ実時間。S-2）。
ほかのプロセスと GPU を取り合うので、窓に分けて **最小** を «邪魔の無いときの値» として採る。

---

## S-1. MSAA 4× の «resolve の後にもう一度描く» 帯域（ARCHITECTURE §3.2）

**問い**：不透明を MSAA の mainRT に描いて resolve（P5 のコピーが読む）し、同じ MSAA に水と半透明を重ねて
もう一度 resolve する（P6）。タイル型の GPU（Apple）は 2 回目の前に全サンプルをメモリから読み戻し、1 回目の後で
全サンプルを書き出す。RGBA16F・2560×1440 でこの上乗せはいくらか。

**測り方**（`src/gfx/core/msaa.js` の `measureMsaa`）：同じ大きさ・同じ形式（RGBA16F + DepthTexture）で
«不透明 3 枚 → resolve → コピー → late 1 枚 → resolve» を MSAA 0 / 2 / 4 で 9 回ずつ回し、中央値。cost(n) = t(n) − t(0)。

| 大きさ | 0× | 2× | 4× | cost2 | cost4 | 4× − 2× |
| --- | --- | --- | --- | --- | --- | --- |
| 2560×1440（5 回の起動の範囲） | 1.1–1.5ms | 2.8–3.1ms | 4.5–4.9ms | 1.6–1.8ms | 3.0–3.8ms | **1.4–2.1ms** |
| 1280×720 | 0.5ms | 0.9ms | 1.4ms | 0.4ms | 0.9ms | 0.5ms |

フレーム全体での確かめ（lab/core.html・全スタブ・high・2560×1440、`?msaa=` で固定）：

| | dock-3p | aerial60 | post |
| --- | --- | --- | --- |
| `?msaa=2`（2× + SMAA） | 20.9ms | 23.0ms | 1.27ms（SMAA 込み） |
| `?msaa=4`（4×、AA パス無し） | 22.9ms | 25.3ms | 0.48ms |

4× は SMAA（≈0.8ms）を差し引いても 2× + SMAA より 2ms 前後重い（どちらも最適化前のスタブでの値。差は MSAA の帯域なのでスタブに依らない）。

**決定と実装**：
- 起動時（high に入った最初の機会・`warmup`）に 1 回だけ `measureMsaa` を描画バッファの大きさで回し（≈60ms）、
  `cost4 − cost2 > NG_MSAA_FALLBACK_MS（0.9ms）` なら high を **2× + SMAA** に落とす（`quality.msaaFallback`、
  `Quality.profile` が `msaa: 2, postAA: 'smaa'` を返す）。1 セッション 1 回。判定は `gfx.msaa` と lab の `__lab.msaa()` で見える
- M1 Pro の 2560×1440 は毎回降格（上の表）。1280×720 は 4× のまま（差 0.5ms）
- `?msaa=4` / `?msaa=2` で判定を上書きできる（切り分け用）
- alpha-to-coverage は MSAA のある段（2× でも）で有効（`ngCutout`）。影は MSAA ではないので影用は alphaTest

再現：`QUERY='&msaa=4' TIERS=high VIEWS=dock-3p,aerial60 node scripts/gfx/shot.mjs scripts/gfx/scenarios/lab-bench.mjs --size 2560x1440 --out DIR`

---

## S-2. GPU 時間の測り方（budget.js）

- `EXT_disjoint_timer_query_webgl2` の TIME_ELAPSED は ANGLE/Metal ではコマンドバッファの境目の待ちまで数え、
  パスの合計が実フレーム時間を大きく超える（使えない）。Windows / ANGLE-D3D11 のために `'query'` 方式として残す
- Chrome の `gl.finish()` は待たずに戻る（実測 0.005ms）。**1×1 の RT を塗ってから readPixels** すると、
  それより前の仕事の完了を待てる（`gfx._gpuSync`）。往復の固定費は起動時に較正して引く
- `'sync'` は GPU のパイプラインを止めるので lab とベンチ専用（本編の既定は `'off'`。`?gpuTimer=sync` で有効）
- 分解能は performance.now の 0.1ms。0.1ms 未満のパス（prep・hfShadow）は 0.0 と出る

---

## S-3. core の GLSL ライブラリの重さ（モジュールの予算の見積もり用）

全画面（2560×1440）を **1 回** 覆ったときの上乗せ（`scripts/gfx/scenarios/core-glsl-cost.mjs`、何もしない断片 0.09ms との差）。
水面のように画面の半分を覆うなら半分、重ね描きがあれば回数倍。

| 関数 | ms | メモ |
| --- | --- | --- |
| `ngApplyMedium`（水上の点） | 0.24 | fog チャンクが全組込みマテリアルで払う |
| `ngApplyMedium`（水中の点） | 0.34 | 空気 + 水 + 下向き光 |
| `ngCloudShadow` | 0.43 | 3 オクターブ × 4 ハッシュ。**組込みは頂点で評価して `vNgCloud`**（下の改善 1） |
| `ngTerrainH` | 0.26 | near/far の手動バイリニア（texelFetch 8 回） |
| `ngTerrainN` | 0.14 | |
| `ngShoreD + ngBed + ngCanopyAt + ngCover` | 0.31 | 4 回の読み |
| `ngHfShadow` | 0.21 | 2 段 |
| `ngSunVisibility` | 0.47 | 雲影込み。fog チャンクのあるシェーダは `ngSunVisibilityC(P, near, vNgCloud)` |
| `ngWindAt` | 0.29 | 頂点で評価できるなら頂点で |
| `ngWaveH + ngWaveD` | 0.44 | waveGLSL の 5 波 |
| `ngRainRings` | 0.79 | 雨のときだけ（rain < 0.01 で即 return） |
| `causticLight` | 0.17 | 焼いたタイル 4 回の読み（改善 2 の後。前は 2.58） |
| `ngFbm`（3 oct） | 0.45 | |
| `ngWorley2` | 0.90 | 焼き込み向き。毎フレームの断片では避ける |
| `ngSkySpecular` | 0.21 | |

three の近景の影（PCFShadowMap）は 1 断片あたり 17 回の RGBA 読み + アンパックで、水面だけで ≈1.3ms かかっていた（改善 3）。

### Phase 0 で入れた改善（2560×1440 high・lab/core.html・全スタブ、フレームの最小）

| 段階 | dock-3p | aerial60 | noon-fp-down |
| --- | --- | --- | --- |
| 再開時（地形スタブの 4 段の区画・解析勾配の後） | 17.5ms | 20.5ms | 17.2ms |
| 1. 雲影を頂点で・key の見え方の使い回し、2. caustics を焼いたタイル + 早期の打ち切り | 14.4 | 16.1 | 14.2 |
| 木の揺れの逆行列の撤去・広葉の樹冠 20 面・水の水深と風を頂点で・地形の法線 1 回 | 13.4 | 14.6 | 13.1 |
| 3. PCF を 9 回の読み（`ngShadowPCF`）・生きている波紋だけを詰める・近景の外で影マップを読まない | **11.7** | **11.9** | **11.2** |

1. **雲影を頂点で**：fog_vertex が `vNgCloud = ngCloudShadow(vNgWorld)`。lights のフックは `ngKeyVis = vNgCloud × ngHfShadowAnalytic`。
   caustics の遮りは `ngKeyVis × ngNearVis` を使い回す（前は雲影・高さ場影を 2 回ずつ計算していた）。雲の斑は 900m 規模なので頂点の間隔で足りる
2. **caustics**：グレーボックスの解析（Worley 3×3 を 2 層・sin 36 回）をやめ、underwater のスタブが起動時に周期タイル
   （256² × 16 フレーム、R/G = 網 A/B）を forge で焼いて uCaustTex（同じ DataArrayTexture）へ入れる。弱める係数を先に掛けて 0 なら読まない
3. **PCF**：`shadowmap_pars_fragment` の PCF の分岐に NG_FRAME の枝を足し、3×3 テクセルの二次 B スプライン重み（9 回、重みはテクセルの境で連続）。
   半影は ≈1.5 テクセル（high ≈5cm）。`shadow.radius` は NG_FRAME の無いシェーダ（degraded の時）だけに効く

### 本編（index.html、全スタブ、`scripts/gfx/scenarios/game-matrix.mjs`）

パス別の GPU ms（最小）。水上 = 桟橋の 3.2m 後ろの三人称、水中 = 水中カメラで桟橋を見上げる。

**high・2560×1440（MSAA は S-1 の判定で 2× + SMAA）**

| 視点 | shadow | reflection | opaque | copy | late | post | 合計 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6:00 晴れ 水上 | 0.2 | 2.3 | 4.9 | 0.5 | 2.3 | 0.9 | 11.1 |
| 12:00 晴れ 水上 | 0.2 | 2.1 | 3.9 | 0.3 | 1.6 | 1.0 | 9.1 |
| 12:00 雨 水上 | 0.2 | 2.2 | 3.9 | 0.3 | 1.9 | 1.0 | 9.5 |
| 18:30 晴れ 水上 | 0.2 | 2.2 | 3.9 | 0.3 | 1.6 | 1.0 | 9.2 |
| 23:00 晴れ 水上 | 0.2 | 2.1 | 3.9 | 0.3 | 1.6 | 0.9 | 9.0 |
| 12:00 晴れ 水中 | 0.2 | —（水中は止める） | 3.6 | 0.3 | 2.0 | 0.9 | 7.0 |
| 23:00 雨 水中 | 0.2 | — | 3.6 | 0.3 | 1.8 | 1.0 | 6.9 |

**mid・1920×1080（MSAA なし、SMAA）**

| 視点 | shadow | reflection | opaque | copy | late | post | 合計 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 6:00 晴れ 水上 | 0.1 | 1.9 | 3.1 | 0.1 | 0.8 | 0.5 | 6.5 |
| 12:00 晴れ 水上 | 0.1 | 1.8 | 2.7 | 0.0 | 0.7 | 0.5 | 5.8 |
| 18:30 晴れ 水上 | 0.0 | 1.8 | 2.7 | 0.0 | 0.6 | 0.4 | 5.5 |
| 23:00 雨 水上 | 0.0 | 1.8 | 2.7 | 0.0 | 0.8 | 0.5 | 5.8 |
| 12:00 晴れ 水中 | 0.1 | — | 2.4 | 0.0 | 0.5 | 0.5 | 3.5 |

core そのものの取り分（lab で全モジュールの root を隠したとき、high 2560×1440）：opaque 1.1–1.4ms（釣り人・魚 6 匹）、
copy 0.6、late 0.6–0.8（**空の late でも MSAA の読み戻しと 2 回目の resolve**）、post 0.9–1.0、reflection 0.3–0.4、shadow 0.2、合計 ≈4.2–4.4ms。
§7 の core の予算 0.70ms（コピー 0.15・resolve 0.35）は 2560×1440 の RGBA16F では届かない（コピー + late の空打ちで ≈1.3ms）。

再現：`QUALITY=high node scripts/gfx/shot.mjs scripts/gfx/scenarios/game-matrix.mjs --size 2560x1440 --out DIR`、
`QUALITY=mid … --size 1920x1080`。
