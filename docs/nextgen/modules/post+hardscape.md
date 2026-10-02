# post + hardscape（ARCHITECTURE §6.10・§6.8）— 作業の記録

ブランチ：`ng/post+hardscape` → `-r1` → `-r2`（利用制限で 2 回中断。各回は前のブランチから続けた）。
コード：`src/gfx/post/**`・`src/gfx/hardscape/**`。lab：`lab/post+hardscape.html`（`lab/post.html`・`lab/hardscape.html` は片方だけ本物）。
証拠：`scripts/gfx/scenarios/post+hardscape-proof.mjs`（lab）・`post+hardscape-game.mjs`（本編 index.html）・`post+hardscape-dev.mjs`（開発用）。
テスト：`scripts/gfx-tests/hardscape-geometry.mjs`（104 件）・`scripts/gfx-tests/post-grade.mjs`（49 件）。

## 状態

- [x] post：鎖の全段（下の «post の鎖»）・3 品質・`services.underwater.createEffect()` を露出前の先頭に・debug 表示は core の表へ登録だけ
- [x] post：露出 = 時刻表の純関数 × 順応（±1EV、夜 +1.2EV、ポーズで止まる、`__gfxCapture` で 1）・NaN/Inf の除去
- [x] post：グレーカードの目標（時刻ごと）・AgX の 24 パッチ ±4EV のチャート・露出の遷移（林 → 日向 → 水中）・DRS の追従
- [x] hardscape：契約の寸法の桟橋（床板 1 枚ずつ・隙間 1.5cm・反り・色むら）、forge の杉材、釘と錆、杭の藻、雨の濡れと水たまり
- [x] hardscape：灯籠（r0.26・上端 dockY+2.3・2200K・1/f の揺らぎ・固定の PointLight・`setLamp(night, dt)` の damp とポーズ・夜の蛾）
- [x] hardscape：和船と係留の縄（waveField の同じ関数で heave/pitch/roll）。**陸に掛かる placement では浜に引き揚げた姿勢**（r2）
- [x] hardscape：岩 8 形 × 3 LOD（窪みの AO・triplanar の花崗岩 / 安山岩・苔・水線 ±0.3m・シルト）、沈み岩と立ち枯れを `lake.structures` に正確に（UNDERWATER 層）、流木
- [x] hardscape：`services.hardscape.piles` と `water.addDamper`
- [x] 当たりの重ね表示（debug.js の箱）と数値：すべて 2cm 以内（下の表）
- [x] 本編（h.bootGame）で high / mid / low：console のエラー 0・警告 0・ページ例外 0・両モジュール健在・NaN 0・小舟が当たりの中（`shots/post+hardscape/game3-{high,mid,low}`）
- [x] node scripts/run-tests.mjs 緑
- [x] 自己批評 1 回（下）

## post の鎖（P7）

```
[GTAO（high・半解像度・2 スライス × 6 ステップ・1.2m）] [光芒（1/4 解像度・24/16 サンプル・近景の影マップで遮蔽）]
PRE（EffectPass）：underwater の Effect → NaN/Inf の除去 → AO（不透明の画素だけ・環境光の割合だけ）→ 光芒 → 露出
測光：32×18 の log 平均 → 1×1、4Hz の非同期の読み戻し → 順応（上げ τ1.2s・下げ τ0.6s、dt は 0.25s で打ち切り）
Bloom：mip（high 8 / mid 5 / low 無し）、最初の段は Karis 平均、しきい値なしのエネルギー保存の mix（3.5%、夜と水中 5%）
FINAL：CAS（DRS の時）→ Bloom → WB → プルキニエ → 彩度 → ビネット 0.12 → AgX → lift/gamma/gain → ブルーノイズ ±0.5LSB
AA：SMAA（mid）/ FXAA（low）/ なし（high は MSAA 4×）→ DRS の拡大
```
- プログラム 3 本（UTIL・FINAL・PRE）+ pmndrs の AA。hardscape も 3 本（hs-wood・hs-rock・hs-moth）。サンプラーの上限超え 0
- 順応の基準 `NG_ADAPT_KEY`：lab の基準の構図を順応 1 で測った中央値（昼 2^−3.32・夜 2^−6.67）→ 基準の構図では順応 ≈ 1（撮影 = 本編）
- 純関数は `src/gfx/post/grade.js`（three 無し・テストあり）

## 数値（r2、1280×720、M1。他のエンジニアの headless と GPU を共有しているので揺れる）

### 予算（ms、`L.bench` の passMin = 窓ごとの最小 / hardscape は `moduleCosts` の中央値。構図は dock-3p / noon-fp-down / night-fp / uw-dock）

同じ GPU で他のエンジニアの headless が同時に走っており、同じ構図・同じコードで 2–5 倍揺れる（frameMsMin が 3.5–8.5ms の間で動く）。
3 回の計測（r2 の proof・bench・bench2）の中央値で判定した。

| 品質 | post 予算 | post 実測（中央値・範囲） | hardscape 予算 | hardscape 実測（中央値・範囲） |
|---|---|---|---|---|
| high | 1.00 | 1.00（0.7–1.2） | 0.90 | 0.43（0.0–1.18、uw-dock が最大） |
| mid  | 0.75 | 0.75（0.6–0.9）← Bloom 5→4 段・光芒 16→12 の後 0.7 前後 | 0.55 | 0.24（0.0–0.29） |
| low  | 0.50 | 0.40（0.2–0.5） | 0.30 | 0.24（0.18–0.53、uw-dock だけ 0.47–0.53） |

- post high は予算どおり（GTAO・8 段の Bloom・光芒込み）。mid は SMAA（3 パス）で予算の縁 → Bloom 5→4 段・光芒 16→12 で 0.7 前後。
  それでも超えるなら次の手は SMAA の edge 検出を luma のみ・光芒を 1/4 → 1/6 解像度
- hardscape low の uw-dock（水中の層を水中と屈折で 2 回描く）が 0.47–0.53：沈み岩を mid / low で LOD1 にした（r2）。
  まだ超えるなら次は low で屈折の RT から水中の小石と縄を外す・沈み岩の苔の fbm を 1 オクターブ減らす
- 本編（index.html、他モジュールはその時のブランチ）：hs のドロー 33–44、post のドロー high 17–21 / mid 12 / low 3、DRS 0.70–0.85（headless の負荷で下がる）

### 露出とグレード（lab の proof-high.json）

| 時刻・天候 | 太陽高度 | 露出 | グレーカードの線形 | 表示 sRGB |
|---|---|---|---|---|
| 6:06 晴れ | 1.4° | 1.92 | 0.018 | 0.157 / 0.124 / 0.185 |
| 9:00 晴れ | 42° | 1.07 | 0.164 | 0.486 / 0.484 / 0.495 |
| 12:30 晴れ | 70° | 1.07 | 0.226 | 0.543 / 0.543 / 0.554 |
| 12:30 曇り | 70° | 1.36 | 0.143 | 0.470 / 0.462 / 0.457 |
| 11:00 雨 | 66° | 1.85 | 0.048 | 0.288 / 0.279 / 0.268 |
| 17:48 晴れ | 2.8° | 1.63 | 0.023 | 0.196 / 0.151 / 0.164 |
| 18:36 晴れ | −8.5° | 8.19 | 0.019 | 0.062 / 0.170 / 0.380 |
| 22:30 晴れ | −61° | 23.5 | 0.027 | 0.131 / 0.195 / 0.300 |

- 露出の遷移（順応）：林の陰 2.09（順応 1.96）→ 桟橋の日向 1.16（1.08）→ 水中 1.40（0.95）。ポーズの前後で順応は不変
- DRS：重い負荷で high 0.70 / mid 0.75 / low 0.60 まで下がり、軽くすると 1.0 に戻る
- AgX（post-grade テスト）：24 パッチ × ±4EV で単調・0..1、+2EV まで 1.0 に張り付かない、18% グレー → sRGB 0.38–0.55、太陽の縁（露出後 16–256）の 1/4EV の段差 < 0.03

### 当たり（collisionReport、cm。正 = はみ出し）

| 項目 | 値 |
|---|---|
| 床の上面 − dockY | 0 / −1.1 |
| 床の箱：下 / 上 / 手前 / 先 | −7.5 / −18 / −0.3 / −0.4 |
| 歩ける半幅 | 172.5（床幅 3.4m の半分 + 縁。当たりは 1.62） |
| 手すり：先端から / 横のはみ出し / 上端 | 230 / 0 / −1.5 |
| 灯籠：半径 / 上端の差 | −0.5 / 0 |
| 小舟：両端のはみ出し / 上端 | 1.6 / −41.8（lab、浜）。本編も 2cm 以内を game シナリオで検査 |
| 大岩・沈み岩と立ち枯れ（20 本）：半径 / 上端 | −2.6 / 0、−2.4 / 0 |
| 杭 | 26 本・間隔 240cm |

### art-metrics（`node scripts/gfx/art-metrics.mjs`）

- 証拠一式（42 枚）：白飛び・黒つぶれ・バンディングはすべて合格。ただし
  - `post-chart`・`post-ao-view` は debug 表示（チャートの黒と白、AO の白）なので対象外
  - `hs-lamp-close-night` の白飛び 0.64% → 和紙の放射輝度を −0.5EV（0.24 → 0.17）→ 再撮影（`r2-lamp`）で 0.49%、灯籠の夜景 7 枚すべて合格。水面の縦の光の帯は残る
  - `hs-boulder-rain` の黒つぶれ 2.5% は雨の日の林の幹（trees）とラボのクロム球。岩と地面ではない
- lab-matrix（dock-3p・noon-fp-down・shore-low × 6 時刻 × 晴れ/雨 = 36 枚、`shots/post+hardscape/matrix`）：
  - 真夜中 / 真昼が dock-3p で 0.23（< 0.25）→ 夜の gamma +0.05（暗所視の中間調の持ち上げ）で 0.266 / 0.269、他の構図 0.287–0.333（すべて 0.25–0.40）
  - 17:45 の雨の黒つぶれ 1.1–2.1% → 雨の夕方だけ黒に 0.0018 のベール（霞）で 0（`matrix3`）
  - 夜明けの単調性・昼の中間輝度・白飛び・バンディングは合格
  - 残る不合格は `noon-fp-down` の水の色相 214–232°（目標 160–200°）だけ。正午の WB は 0K（post は中立）なので水の吸収の色（water へ依頼）

## 自己批評（1 回）

撮った物：`shots/post+hardscape/r2-high`（1280×720・42 枚）、`r2-mid`・`r2-low`、`r2-high-1440`（2560×1440・12 枚）、本編 `g3-high`・`g4`。

| # | 見つけた欠点 | 直したか |
|---|---|---|
| 1 | 本編で小舟が浜の砂に半分埋まる（placement の位置が陸、深さ 0、y = 0.05 のまま） | 直した：竜骨の下 9×3 点の地面に載せ、傾きに沿わせて片舷へ 4°、5cm めり込ませる。当たりの円の上端を越える分は沈める |
| 2 | 杭の側面に板目の弧が周に 4 倍に引き伸ばされた «指紋» の模様（丸太に見えない） | 直した：杭は地図をぼかして色だけ使い、周期のノイズで縦にまっすぐの木目 2 段・干割れ・法線を幾何寄りに |
| 3 | 桟橋の下の AO が弱い（on/off の差がほぼ見えない） | 強さ 1.25 → 1.6（環境光の割合だけに掛かる物理の形は維持） |
| 4 | 灯籠の接写で和紙が白飛び（赤のチャンネルが 0.64%） | 放射輝度 −0.5EV |
| 5 | 撮影で `readPixels: PIXEL_PACK buffer should not be bound` の警告 | シナリオの同期の読み戻しの前に PBO を外す（sky の非同期の読み戻しが束ねたまま。sky 側にも報告） |
| 6 | 大岩の花崗岩が全面同じ粒（漆喰のよう）、大きな節理・色の帯が無い | 未：Phase 2（下の «残り»） |
| 7 | 夜の湖底のコースティクスが白い網目として強く光る（露出 23.5 で目立つ） | 他モジュール（underwater）への依頼 |
| 8 | 水中の lab で画面の角に無地のベージュの楔（hardscape・lab の道具を消しても残る） | 他モジュール（terrain / water）への依頼 |
| 9 | 水面の反射が縦の帯にちぎれる（夕方・正午の水平視） | 他モジュール（water）への依頼 |
| 10 | 真夜中が暗すぎる（dock-3p の真夜中 / 真昼 0.23）・雨の夕方の黒つぶれ | 直した：夜の gamma +0.05・雨の夕方の黒のベール |
| 11 | 本編の浜の小舟が当たりの円の上端を 4cm 越え・両端 4.5cm はみ出し（傾けた舷が前へ出る） | 直した：実際の幾何で検査して傾きを弱め、上端の超過分を沈める（本編で両端 1.4・上端 −6.5cm） |

## 残り（open issues）

- mid の post が 0.05–0.15ms 超え（計画は上）
- 花崗岩のマクロの変化（節理の暗い筋・鉄の染み・大きな色むら）、大岩の «じゃがいも» 感：形の生成に節理の平面を 2–3 枚足す
- 本編のシード（既定）では小舟が陸。浜に載せたが、本当は «水に浮かぶ舟» が絵として欲しい：placement の小舟の位置を岸から 1–2m 沖へ（core / world の判断）
- 杭の藻は水中の霞で遠目に読みにくい（藻の色は 0.035–0.075 と暗いのに、水中の散乱で灰色に見える）

## 他モジュールへの依頼（core-requests.md には書かない）

- **underwater**：夜（月だけ）のコースティクスの強さを月の放射照度に比例させる（今は夜の露出 23.5 で網目が白く光る。lab の hs-deck-fp-night・hs-lamp-night）
- **water**：水平視の反射の縦の帯の «ちぎれ»（base-dusk-3p・base-noon-shore）。noon-fp-down の水の色相 214–232°（art-metrics の 160–200° の外。post の WB は正午 0K）
- **terrain / water**：lab の水中（`hs-snag-uw`・`hs-piles-uw-deep` の構図）で画面の角に無地の楔。hardscape と lab の道具を消しても残る。レイキャストに当たらないので GPU の地形か水の裏面
- **sky**：`readRenderTargetPixelsAsync` の待ちの間に PIXEL_PACK_BUFFER が束ねられたまま。他の同期の readPixels が INVALID_OPERATION（警告 1 件）
- **core / world**：既定のシードで `placement.boat` が陸（深さ 0）。浜に載せる処理で回避済み。岸から沖へずらすなら当たりの円も一緒に
- **trees**：雨の日の林の幹が黒つぶれ（hs-boulder-rain で 2.5%）
