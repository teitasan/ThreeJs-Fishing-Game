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

最終（lab/core.html、`lab-bench.mjs`、フレームの最小とパス別の最小）：

| 段・大きさ | 視点 | フレーム | shadow | reflection | opaque | copy | late | post |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| high 2560×1440（2× + SMAA） | dock-3p | 11.6 | 0.2 | 2.6 | 5.7 | 0.7 | 2.8 | 1.2 |
| | aerial60 | 11.9 | 0.3 | 2.4 | 5.1 | 0.7 | 3.7 | 1.1 |
| | noon-fp-down | 11.2 | 0.2 | 2.6 | 4.4 | 0.6 | 3.0 | 0.9 |
| | uw-dock | 8.5 | 0.3 | — | 5.4 | 0.7 | 1.8 | 1.1 |
| mid 1920×1080 | dock-3p | 5.3 | 0.0 | 1.8 | 2.9 | 0.1 | 0.9 | 0.5 |
| | aerial60 | 5.6 | 0.0 | 1.6 | 2.5 | 0.1 | 1.5 | 0.5 |
| | noon-fp-down | 5.1 | 0.0 | 1.6 | 2.1 | 0.0 | 1.0 | 0.4 |
| | uw-dock | 3.9 | 0.0 | — | 2.8 | 0.1 | 0.4 | 0.4 |

### 本編（index.html、全スタブ、`scripts/gfx/scenarios/game-matrix.mjs`）

> **G0 で訂正（S-4 を見ること）**：下の 2 表は (1) game-matrix が `__gfxCapture` を立てる前の版で、動的解像度が
> 計測の同期の重さに反応して内部解像度を落としていた（同じ条件の再測で 2176×1224 ≒ 0.85 倍）、
> (2) 近景の影マップが空だった（three は影の物体を render() のカメラの layers で判定するので、何も描かない tick カメラでは
> 何も入らない。G0 で修正 b3c210c）ので shadow 0.2ms は «空の影マップ» の値。どちらも今の値ではない。

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

---

## S-4. G0 の実測（統合者、2026-10-01）

同じ計測機。**ほかのアプリ（ChatGPT/Codex のレンダラ・WindowServer）が GPU を使っている状態**で、S-3 の頃より全体に遅い
（同じセッションで旧 4aa76f6 を同じ条件で測り直すと above_12_clear 12.3ms @2176×1224。S-3 の記録は 9.1ms）。
以下はすべて **DRS を止めた全解像度**（`__gfxCapture`）・**近景の影あり**（b3c210c の後）・`?gpuTimer=sync` のパス別最小。
«frame p50/p95» は同期を外した実フレーム（game.update + GPU の完了）。

### 本編・全スタブ（game-matrix、6/12/18.5/23 時 × 晴れ/雨 × 水上/水中）

| 段・大きさ | 視点 | パス合計（最小） | frame p50 | frame p95 | shadow | reflection | opaque | copy | late | post |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| high 2560×1440（2×+SMAA） | 水上 | 14.0–16.5 | 15.4–16.5 | 16.0–17.9 | 0.7–1.8 | 2.6–3.0 | 5.9–6.4 | 0.7–0.9 | 2.7–3.2 | 1.0–1.2 |
| | 水中 | 10.0–12.1 | 11.4–15.0 | 12.3–16.5 | 0.7–1.8 | — | 5.3–5.5 | 0.6–0.7 | 2.3–3.4 | 1.0 |
| mid 1920×1080 | 水上 | 7.6–8.5 | 9.0–9.8 | 9.7–12.3 | 0.6–1.1 | 1.9–2.1 | 3.4–3.5 | 0.1–0.3 | 1.0–1.3 | 0.5–0.6 |
| | 水中 | 5.0–5.9 | 6.4–8.8 | 7.0–12.0 | 0.6–1.0 | — | 2.9–3.0 | 0.1–0.2 | 0.8–1.5 | 0.4–0.5 |

shadow は 6:00 / 18:30（低い太陽で影が長く、3072² の範囲に入る遮蔽物が増える）で 1.5–1.8ms、昼と夜は 0.6–0.9ms。
水中の行の一部は game-matrix の置き直しの間に状態機械が «待ち» を外して uw 0 になる（その行は水上の値に近い。数字の範囲からは除いた）。

### モジュールごとの取り分（game-costs、12 時・晴れ、全体 ↔ 隠した の往復 3 回の中央値）

`scripts/gfx/scenarios/game-costs.mjs`（G0 で追加）。«all» = 全モジュールの root を隠した残り（core・釣り人・魚・ゲームの半透明・
post のスタブ）。隠すのは描画だけで、CPU の update・prepare は残る。±0.2ms は計測の揺れ。

**high 2560×1440（2× + SMAA）**

| 部分 | shadow | reflection | opaque | copy | late | post | 合計 | 水中の合計 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 全体 | 0.6 | 2.4 | 5.6 | 0.6 | 2.7 | 1.0 | **13.0** | **9.8** |
| sky（スタブ） | 0.0 | 0.1 | 0.1 | 0.0 | 0.0 | 0.1 | 0.4 | 0.5 |
| water（スタブ） | 0.1 | 0.0 | 0.0 | 0.0 | 1.9 | 0.0 | 1.8 | 1.8 |
| terrain（スタブ） | 0.1 | 0.6 | 2.1 | 0.0 | 0.0 | 0.0 | 2.8 | 0.7 |
| trees（スタブ） | 0.1 | 1.3 | 1.4 | 0.0 | 0.0 | 0.1 | 2.9 | 1.5 |
| hardscape（スタブ） | 0.1 | 0.3 | 0.0 | 0.0 | 0.0 | 0.0 | 0.2 | 0.8 |
| underwater / groundcover / shoreflora / weatherfx | ≈0 | ≈0 | ≈0 | ≈0 | ≈0 | ≈0 | ≈0 | ≈0 |
| **all（core + キャラクター + post スタブ）** | 0.4 | 0.2 | 1.3 | 0.6 | 0.8 | 1.0 | **4.3** | **4.6** |

**mid 1920×1080（MSAA なし、SMAA）**

| 部分 | shadow | reflection | opaque | copy | late | post | 合計 | 水中の合計 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 全体 | 0.4 | 1.6 | 2.8 | 0.0 | 0.8 | 0.4 | **6.2** | **4.1** |
| water | 0.0 | 0.0 | 0.0 | 0.0 | 1.0 | 0.1 | 1.0 | 0.9 |
| terrain | 0.1 | 0.4 | 1.3 | 0.0 | 0.0 | 0.0 | 1.8 | 1.0 |
| trees | 0.0 | 0.9 | 0.9 | 0.0 | 0.0 | 0.0 | 1.9 | 0.8 |
| hardscape | 0.1 | 0.3 | 0.3 | 0.0 | 0.0 | 0.1 | 0.6 | 0.6 |
| sky | 0.0 | 0.1 | 0.1 | 0.1 | 0.1 | 0.0 | 0.4 | 0.4 |
| **all** | 0.1 | 0.0 | 0.2 | 0.0 | 0.0 | 0.4 | **0.7** | **0.8** |

**どこが重いか（high 水上 13.0ms の内訳）**

| 費目 | ms | 誰の物か |
| --- | --- | --- |
| 地形スタブの opaque（2.1）+ 反射（0.6） | 2.7 | terrain のスタブ → 本物の terrain（予算 2.0：main 1.4・反射 0.3・影 0.3）が置き換える |
| 木のスタブの反射（1.3）+ opaque（1.4） | 2.7 | trees のスタブ（2 万本を全部、反射にも LOD なしで描く）→ 本物の trees（3.1、反射 0.5 は LOD +1・インポスター）が置き換える |
| 水のスタブの late | 1.9 | water のスタブ → 本物の water（1.2）。late パスの残り 0.8 は core（下） |
| MSAA の読み戻し + 2 回目の resolve（空の late）| 0.8 | **core**（2× の段。4× なら ≈ +1.4。S-1） |
| コピー（sceneColor + 線形深度、RGBA16F 2560×1440） | 0.6 | **core** |
| post のスタブ（露出・AgX・ディザ・SMAA） | 1.0 | post のスタブ → 本物の post（1.0）が置き換える |
| 釣り人・魚・ゲームの物の opaque と影 | 1.3 + 0.4 | キャラクター（§7 の予約 1.2）。影は G0 の修正で初めて払う |
| 反射の残り（釣り人・桟橋・空のドーム） | 0.2–0.4 | core + キャラクター |
| 影のスタブ分（地形・木・桟橋が影マップへ） | 0.2–0.3（昼）〜 1.1（朝夕） | 各スタブ → 本物は «近景の影の予算»（terrain 0.3・trees 0.6）に入れる。地形は高さ場影があるので近景の影に描かない選択肢がある |

- **core そのものの取り分は ≈1.5ms**（コピー 0.6 + late の MSAA 0.8 + 影の追従・高さ場影のスライス 0.1。2560×1440 の RGBA16F）。§7 の 0.70 は届かない（A-5 の見直し：core 1.5・キャラクター 1.5 で見込む）
- **G0 の «グレーボックスの GPU < 5ms»**：全モジュールを隠した残り（core + キャラクター + post スタブ）は high 4.3–4.6ms・mid 0.7–0.8ms で合格。
  スタブ込みの全体は high 13.0ms / 9.8ms（水中）・mid 6.2 / 4.1ms で、その 2/3 は置き換えられるスタブ
- §9 perf-matrix の «high の p95 ≤ 16.0ms» はスタブ込みの今は 16.0–17.9ms で届かない（Phase 2 のゲート。スタブの木と地形が本物の LOD に置き換わって初めて意味のある数字になる）
- 再現：`QUALITY=high node scripts/gfx/shot.mjs scripts/gfx/scenarios/game-costs.mjs --size 2560x1440 --out DIR`、
  `QUALITY=high SHOTS=0 … game-matrix.mjs --size 2560x1440`（mid は 1920x1080）

### 読み込み（load-time、1920×1080、コールド 3 回の中央値、`#loading` の文言の時刻から）

| 段 | 旧 c8490ed low / mid / high | 新（全スタブ）low / mid / high |
| --- | --- | --- |
| 湖（lake） | 16 / 17 / 23ms | 20 / 24 / 21ms |
| 湖底（bed：旧は地形・木・水草の構築、新は placement・高さ場・全モジュールの init） | 1467 / 1885 / 2232 | 562 / 534 / 563 |
| 水（water） | 101 / 105 / 111 | 11 / 6 / 8 |
| 魚 → 準備完了（fishAngler：新は postfx.warmup を含む） | 122 / 126 / 125 | 343 / 330 / 571 |
| **合計（最初の文言 → 終わり）** | **1755 / 2171 / 2509** | **998 / 953 / 1214** |
| **追加の読み込み（新 − 旧）** | | **−757 / −1218 / −1295ms** |

- core の内訳（gfx.loadStats）：高さ場（Worker 4 本の格子 + GPU の派生）310–370ms、モジュールの init 計 70–90ms（underwater の caustics の焼き込み 21ms・
  post 25ms・trees 12–28ms）、warmup 215–470ms（compile 130–165ms・high は MSAA の実測 150ms・空回し 3 フレーム 75–175ms）
- G0 の修正：warmup の compileAsync を画面（sRGB 出力）に対して行っていたので、three が «描く先の色空間» 違いのプログラムを全マテリアルで
  1 本ずつ余分に作っていた（lab で 33 → 23 本）。mainRT を束縛してからコンパイルする（index.js の warmup）
- 予算の目安（§8・§6）：追加 ≤ 3.5s（上限 6s）。本物のモジュールの読み込み予算は sky 0.2・terrain 0.6・trees 0.9s など（§6）。今の余裕は旧版より 0.8–1.3s 速い分も含めて ≈ 4.3–4.8s
- 再現：`TIERS=low,mid,high RUNS=3 node scripts/gfx/shot.mjs scripts/gfx/scenarios/load-time.mjs --size 1920x1080 --out DIR`。
  旧版は c8490ed を取り出したツリーに新しい shot.mjs と load-time.mjs を写して同じコマンド

### 水面の読み戻し（g0-gameplay、ウキの真上 3m から 17×17 点、CPU の surfaceY との差）

| 段 | 中央値 | p95 | 10 時間後の中央値 / p95 |
| --- | --- | --- | --- |
| low（64² の水面メッシュ） | 0.96mm | 2.77mm | 1.36 / 3.95mm |
| mid | 0.57mm | 1.31mm | 0.63 / 1.59mm |
| high | 0.26mm | 0.71mm | 0.37 / 1.07mm |

G0 の修正：水のスタブが水の時刻を update で受けていた（gfx.waterUpdate は updateModules の後なので 1 フレーム前の波。high の中央値 1.3mm）。
prepare で受け直す（ac223f8）。low の残りは 64² のリングの頂点間の線形補間。
