# groundcover + shoreflora — モジュールの記録

ARCHITECTURE §6.6（groundcover）・§6.7（shoreflora）・§7。担当のブランチ：`ng/groundcover+shoreflora` → `-r1` → **`ng/groundcover+shoreflora-r2`**（利用の上限で 2 回中断した後の続き）。
個別の入口：`docs/nextgen/modules/groundcover.md`・`docs/nextgen/modules/shoreflora.md`（この文書への案内）。

## 状態（チェックリスト）

groundcover（`src/gfx/groundcover/`）
- [x] 計算パス（`clump.glsl.js`）：カメラ中心のリング格子のセル 1 つ = 株 1 つ、RGBA32F の表 1 枚（横に 3 帯）へ全画面 1 回。頂点の属性・インスタンスの属性なし（型板 + `gl_InstanceID` → `texelFetch`）
- [x] 株の判定は terrain の `coverRules` の重み（`ngTerrWeights` を写した `ngGcWeights`。スタブなら `ngCover` の既定へ）。ハッシュのジッタ、視錐台の窓（CPU で足跡の外接矩形）
- [x] 草 8 枚 × 5 節（近）／6 枚 × 3 節・太い刃（遠）。距離の帯で «株を縮めて» 消す（点の出入りなし）
- [x] 陰影：ラップ Lambert・透過（HG g 0.55）・先端の光沢・高さ方向の AO・株／斑の色むら・枯れた先・季節（frame の季節）・雨の濡れ（`ngWetSurface`）。近景の影を受け、落とさない
- [x] 風 `ngWindAt`（38m・13m の斑が風下へ流れる突風）、踏み倒し（注視点の足跡 8 個、4 秒で起きる）
- [x] クマザサ（林床の群落、稈 + 掌状の葉）・シダ（沢筋と水辺、羽状の切れ込み）・苔の塊・落ち枝・落葉・玉石の浜の小石（半径 15m）
- [x] 藪（`shrub.js`）：placement.thicket に低木 3 形（葉の房のカード 64 枚 + 枝）、高さ ≥ 1.2m、見た目の半径 = 当たり × 1.1、`NO_REFLECT + SHADOW_ONLY`、影を落とす
- [x] 根元の色 = 近景の地形（ΔE、下の数値）。r2 で直した
- [x] 3 段（low / mid / high）の表 `quality.js`（§7 の株の数・距離・笹シダの密度）
- [x] Node のテスト `scripts/gfx-tests/groundcover-layout.mjs`

shoreflora（`src/gfx/shoreflora/`）
- [x] ヨシ・マコモ（placement.reeds = 葦際）：テーパーした茎 6 節 + 葉 + 穂、強い風の揺れ、水面の高さで濡れ色の根元。近い株は幾何（high 80m）、外は株のカード（420m）
- [x] 反射は LOD1（`beforePass(REFLECTION)` で近い株 ↔ LOD1 を入れ替え）。茎を water の減衰体として登録（`services.water.addDamper`、init で 1 回）
- [x] 浮葉：ヒツジグサの葉 + 白い花・ヒシのロゼット。頂点の y は CPU の surfaceY と同じ波の式（誤差 1.1mm）、波の勾配で傾ける、蝋質、+0.012m と polygonOffset
- [x] 沈水植物：placement.weeds + 埋め草（`sfWeedFillers`、placement が届かない lake.flats の隙間）。流れ（f.flowDir / flowStrength）で揺れる帯、UNDERWATER 層、caustics
- [x] 3 段は placement の rank の入れ子（`isVisible`）＋ 距離の表 `quality.js`
- [x] Node のテスト `scripts/gfx-tests/shoreflora-logic.mjs`

検査
- [x] lab：`lab/groundcover.html`・`lab/shoreflora.html`（統合済みの sky・water・terrain・trees の上。`&solo=1` で担当だけ本物）
- [x] 証拠一式：`scripts/gfx/scenarios/groundcover+shoreflora-proof.mjs`（下）
- [x] 本編（index.html）での確認：`scripts/gfx/scenarios/groundcover+shoreflora-game.mjs`（high / mid / low、11 構図、健在・エラー 0・NaN 0・隠した時との GPU ms）
- [x] art-metrics（下）
- [ ] 予算：high の «ヨシ原を間近に» の構図だけ shoreflora 2.0–2.5ms（予算 1.00）、low の草地の groundcover 0.7（予算 0.30）→ «課題»

## 決めたこと（設計）

- **プログラム**：groundcover 4 本（計算パス・草/笹/小物の 1 本・藪 + 藪の影）、shoreflora 4 本（ヨシ + ヨシの影・浮葉・沈水植物）。どちらも ≤ 6。サンプラー最大 frag 8 / vert 2
- **4 描画 1 プログラム**：近い草・遠い草・笹シダ・小物は同じ `gc-cover` を uniform `ngGcDraw`（型板の番号・行・セルの大きさ）だけ変えて描く
- **計算パスの帯**：MRT を使わず、RT の横 3 帯に A（位置・大きさ）／B（根元の色・種類 + 縮み）／C（曲げ・突風・空の見え + 山の影）。各画素は同じ株を計算して自分の帯だけを書く
- **根元の色（r2）**：farAlbedo の rgb は «地面 c と森の色 can を a2 で混ぜた物»（a2 = max(樹冠, 林床・苔の重み × 0.82)）。最初は fa.rgb をそのまま使い、林床の重みのある草地で根元が茶色く浮いた（ΔE 7.5–9.2）。
  開けた所（樹冠 < 0.3）では can = 林の陰の色 gen を同じ式で作れるので c = (fa − a2·gen)/(1 − a2) と解き戻す。さらに草地の層だけ近景の素材が farAlbedo より暗く緑（ΔE ≈ 12）なので、
  草地の重みに比例した倍率 (0.42, 0.54, 0.60) を掛けた（lab の ΔE の検査で合わせた）。検査の光は地形と同じ掛け方（`TERRAIN_FRAG_AO` の素材 AO ≈ 0.8・空の見え）
- **藪の葉の mip（r2）**：forge の `coverageAlpha` は同じテクスチャの段を読みながら書くので Chrome が «Feedback loop formed between Framebuffer and active Texture» を 8 回出した。
  普通の mip にして、断片で mip の段ごとに α を持ち上げる（1 + 0.28·段）
- **ヨシの選び出し**：CPU（カメラが 1.5m 動くか 4° 向きを変えた時）。近い株は主の視錐台か水面の鏡像が入る物だけ
- **ヨシの距離の段（r2）**：近景の型板（茎 ≤12 本 × 6 節・葉 5 枚・穂 2）は 26m（+ 株ごとに 0–6m、輪の線を出さない）まで、その先 80m までは LOD1 の型板
  （茎 ≤6 本 × 3 節・葉 2 枚、太い茎）を主のパスで（`ng-sf-reeds-mid`、反射の LOD1 と同じマテリアル）、その先は株のカード（420m）。
  25m より先の茎は 55% まで間引いて太らせる。反射の LOD1 は 40m まで（先はカード、`beforePass` で uniform を入れ替え）。
  密な株の «補いのカード» は 15m から（画面の大きなカードの α の 9 回の繰り返しが重かった）。high の reeds の構図 3.4 → 1.9ms（720p）
- **草の法線（r2）**：両面の刃は three が裏面で法線を反転するので、裏を見ている刃の法線が下を向き、空の光を受けずに黒く沈んだ（夕方 18:30 の crush 26%、雨 3.4%）。
  断片で上下だけ上向きへ折り返し（横の成分は視点へ向いたまま）、頂点の法線も面の上へ寄せた（+0.85·上）。雨 0.9% に
- **低い太陽の透過（r2）**：透過の項に `max(Lw.y + 0.15, 0)` を掛けていたので、肝心の夕方の逆光（太陽の高さ ≈ 0.05）で 1/4 に落ちていた。地平の下で消す `smoothstep(−0.03, 0.10, Lw.y)` に
- **斑の雑音を頂点へ（r2）**：草の色むらの 2 つの値の雑音（0.35/m・1.7/m）を断片から株の根元へ（株ごとに 1 色相＝黄緑の株・青緑の株、断片の負荷を減らす）。去年の枯れ葉（刃の 6%）

## 数値（high、lab。`final-high`・`final-1440`）

| 項目 | 値 | 合格 |
|---|---|---|
| 根元の色の ΔE（32px 区画の中央値 / p90）草地・林床・逆光の草地 | 720p：2.77 / 4.61・2.67 / 5.94・2.47 / 4.69、1440p：3.69・3.84・3.21 | < 6 |
| 浮葉の高さ − CPU の surfaceY（lake.depthAt、200 群落） | 最大 1.1mm（波の振幅 19cm） | ±1cm |
| 藻場の被覆（lake.flats の 3 円、2m 格子が 2.5m 以内に草） | 0.95 / 1.00 / 1.00（placement だけなら 0.85 / 0.71 / 0.79、埋め草 463） | ≥ 0.9 |
| ヨシの株の水深 | 4962 株すべて (0.05, 1.5]（1.5m より深い 0） | 0 |
| プログラム / サンプラー | 4 + 4、超過 0・リンク失敗 0 | ≤ 6 |

## 予算（GPU ms、全体 − 隠した、3 回の中央値、lab、無印 M1・他の担当の headless Chrome と同じ GPU を共有）

§7 の予算は «M1 Pro 2560×1440»。ここは無印 M1（GPU コア 8 / M1 Pro 14–16）。混み具合で ±1ms ほど揺れたので、静かだった回の値。

| 段・解像度 | 構図 | groundcover | shoreflora |
|---|---|---|---|
| high 2560×1440 | 草地 / 林床 / ヨシ原 / 桟橋 3 人称 | 1.43 / 0.81 / 1.11 / 0.75（予算 1.35） | 0.83 / 0.25 / **2.46** / 0.98（予算 1.00） |
| high 1280×720 | 同 | 2.06 / 1.12 / 1.73 / 1.18 | 0.64 / 0.55 / **1.93** / 0.73 |
| mid 1280×720 | 同 | 0.94 / 0.71 / 0.86 / 0.61（予算 0.85） | 0.38 / 0.29 / 0.66 / 0.46（予算 0.60） |
| low 1280×720 | 同 | **0.71** / 0.44 / 0.66 / 0.34（予算 0.30） | 0.15 / 0.11 / 0.25 / 0.21（予算 0.30） |

本編（index.html、`groundcover+shoreflora-game.mjs` → `shots/groundcover+shoreflora/game2`、720p、桟橋 / 岸 / 内陸）：groundcover high 1.3 / 1.0 / 1.8・mid 0.7 / 0.6 / 1.0・low 0.1 / 0.4 / 0.3、shoreflora high 1.0 / 2.3 / 2.0・mid 0.6 / 0.7 / 0.7・low 0.4 / 0.3 / 0.5（岸の high は LOD の段の前 3.9）。3 段とも健在・console のエラー 0・ページ例外 0・警告 0・NaN 0。
三角形（high、草地）：groundcover 1.10M（r1 の 1.73M から：笹シダのリング 0.6m × 47 → 0.7m × 41）、shoreflora 0.51M。プログラム 4 + 4、テクスチャ 2.5MB（計算パスの RT 768 × 行 + 藪の葉 256²）

## 自己批評（1 巡、r2）

撮った物：`shots/groundcover+shoreflora/full1`（直す前）→ `final`（3 段 720p）・`final-high`・`final-1440`（high 2560×1440）。
1. **草地の根元が茶色く浮く**（ΔE 7.5–9.2）→ farAlbedo の解き戻しと草地の倍率（上の «決めたこと»）。ΔE 区画の中央値 2.8 / 2.7 / 2.5
2. **草が «緑の針の絨毯»**：株ごとに同じ緑・まっすぐ・刃の向きが揃う → 株ごとの色相（黄緑・青緑）、去年の枯れ葉 6%、傾きの幅を広げた
3. **夕方・雨に草が地面より黒く沈む**（裏面の法線）→ 法線の折り返し。夕方の crush 26% → 14%（地形だけでも 9%：残りは露出・空の側）
4. **17:30 の逆光で草も穂も光らない**（透過に太陽の高さを掛けていた）→ 地平の下でだけ消す。逆光の草原の縁が金色に
5. **逆光の草原の構図が木の幹で塞がる・藪の構図に藪が写らない**（proof の構図の選び方）→ 前の 40° の扇に木の無い所、仲間の多い藪の輪を湖側 10m から
6. **藪が暗い «濡れたモップ»**：葉の色を明るく、株ごとの色相の幅を広げた（形の繰り返しは残る：課題）
7. **ヨシの葉がのっぺりしたプラスチック**：灰緑へ彩度を落とし、中肋と平行脈・付け根の暗さ。葉 8 → 5 枚（§6.7 の 4–6 枚）で軽く
8. **ヨシ原が重い**（間近で 3.4ms）→ 距離の段（上）。1.9ms
9. **浮葉が紙吹雪**（群落 1 つに葉 2–5 枚）→ 4–6 枚・半径 10–17cm
10. **藪の葉の mip の «Feedback loop» の警告 8 件** → 段ごとの α の持ち上げ

残した物（次の巡）：ヨシ原の密度は placement の株の数で決まり桟橋から見ると疎ら／藪の形の繰り返し／浮葉の群落の広がり／
水中の藻場は underwater がスタブで平板（担当の外）／遠い草の縁（low の 17.5m）がわずかに線に見える

## art-metrics（`final-high`）

担当の絵 16 枚のうち失敗は `high-gc-dusk`（18:18、crush 13.7%）だけ。groundcover を隠しても 9.3% あり、露出（post はスタブ）と空の側の暗さ。
重ね絵 2 枚（地図）は判定の対象外（banding が出るのは平らな塗り）。

## 自己批評（1 巡）

（下に追記）

## 課題・依頼

- shoreflora の予算：high のヨシ原を間近に見る構図（桟橋の脇、近い株 100 + 中景 550）が 1440p で 2.5ms（予算 1.0、無印 M1）。
  計画：(1) 近景の型板の距離を 26 → 18m、(2) 中景の茎を 6 → 4 本、(3) 影はヨシの近景だけ（今は近景の型板が影を落とす：0.1–0.4ms）、
  (4) 反射の LOD1 を 40 → 25m。M1 Pro では 1.5ms 前後の見込み
- groundcover の low：草地で 0.7ms（予算 0.30）。low の遠い草（0.9m × 24）を外すと §7 の 4k 株を割る。計画：遠い草を low だけ 1.2m セル・3 節 → 2 節

- terrain へ：farAlbedo の草地の層が近景の素材より明るく黄色い（ΔE ≈ 12、32px 区画）。遠景への渡り（180m）でも段になるはず。直ったら `NG_GC_MEADOW_GAIN` を 1 へ戻す
- core へ：`forge.bake2D({ mips: true, coverageAlpha })` が «Feedback loop» の警告を出す（同じテクスチャの mip を読みながら書く。`TEXTURE_BASE_LEVEL / MAX_LEVEL` で読む段を絞るか、別の RT を往復させる）
