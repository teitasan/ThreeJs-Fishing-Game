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
- [ ] 本編（index.html）での確認 → 下の «本編»

## 決めたこと（設計）

- **プログラム**：groundcover 4 本（計算パス・草/笹/小物の 1 本・藪 + 藪の影）、shoreflora 4 本（ヨシ + ヨシの影・浮葉・沈水植物）。どちらも ≤ 6。サンプラー最大 frag 8 / vert 2
- **4 描画 1 プログラム**：近い草・遠い草・笹シダ・小物は同じ `gc-cover` を uniform `ngGcDraw`（型板の番号・行・セルの大きさ）だけ変えて描く
- **計算パスの帯**：MRT を使わず、RT の横 3 帯に A（位置・大きさ）／B（根元の色・種類 + 縮み）／C（曲げ・突風・空の見え + 山の影）。各画素は同じ株を計算して自分の帯だけを書く
- **根元の色（r2）**：farAlbedo の rgb は «地面 c と森の色 can を a2 で混ぜた物»（a2 = max(樹冠, 林床・苔の重み × 0.82)）。最初は fa.rgb をそのまま使い、林床の重みのある草地で根元が茶色く浮いた（ΔE 7.5–9.2）。
  開けた所（樹冠 < 0.3）では can = 林の陰の色 gen を同じ式で作れるので c = (fa − a2·gen)/(1 − a2) と解き戻す。さらに草地の層だけ近景の素材が farAlbedo より暗く緑（ΔE ≈ 12）なので、
  草地の重みに比例した倍率 (0.42, 0.54, 0.60) を掛けた（lab の ΔE の検査で合わせた）。検査の光は地形と同じ掛け方（`TERRAIN_FRAG_AO` の素材 AO ≈ 0.8・空の見え）
- **藪の葉の mip（r2）**：forge の `coverageAlpha` は同じテクスチャの段を読みながら書くので Chrome が «Feedback loop formed between Framebuffer and active Texture» を 8 回出した。
  普通の mip にして、断片で mip の段ごとに α を持ち上げる（1 + 0.28·段）
- **ヨシの選び出し**：CPU（カメラが 1.5m 動くか 4° 向きを変えた時）。近い株は主の視錐台か水面の鏡像が入る物だけ（反射の LOD1 も同じ一覧）

## 数値（high、1280×720、lab）

| 項目 | 値 | 合格 |
|---|---|---|
| 根元の色の ΔE（32px 区画の中央値 / p90）草地・林床・逆光の草地 | 2.81 / 4.55・2.65 / 6.09・3.42 / 5.54 | < 6 |
| 浮葉の高さ − CPU の surfaceY（lake.depthAt、200 群落） | 最大 1.1mm（波の振幅 19cm） | ±1cm |
| 藻場の被覆（lake.flats の 3 円、2m 格子が 2.5m 以内に草） | 0.95 / 1.00 / 1.00（placement だけなら 0.85 / 0.71 / 0.79、埋め草 463） | ≥ 0.9 |
| ヨシの株の水深 | 4962 株すべて (0.05, 1.5]（1.5m より深い 0） | 0 |
| プログラム / サンプラー | 4 + 4、超過 0・リンク失敗 0 | ≤ 6 |

## 予算（GPU ms、全体 − 隠した、3 回の中央値）

（full proof の結果を書く）

## 自己批評（1 巡）

（下に追記）

## 課題・依頼

- terrain へ：farAlbedo の草地の層が近景の素材より明るく黄色い（ΔE ≈ 12、32px 区画）。遠景への渡り（180m）でも段になるはず。直ったら `NG_GC_MEADOW_GAIN` を 1 へ戻す
- core へ：`forge.bake2D({ mips: true, coverageAlpha })` が «Feedback loop» の警告を出す（同じテクスチャの mip を読みながら書く。`TEXTURE_BASE_LEVEL / MAX_LEVEL` で読む段を絞るか、別の RT を往復させる）
