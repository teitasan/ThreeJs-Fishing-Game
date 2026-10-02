# water モジュール（ARCHITECTURE §6.2）— 作業メモ

ブランチの系譜：`ng/water`（f400022：spectrum.js・lab）→ `ng/water-r1`（08969f7 FFT・quality、604e8b9 WIP：本体の大半）→
`ng/water-r2`（証拠・LEAN・読み戻し・WIP のリング計画）→ `ng/water-r3`（このメモ：仕上げと安定化）。

## 状態（チェックリスト）

- [x] 品質表 `src/gfx/water/quality.js`（§7 の water の行）
- [x] JONSWAP のスペクトル（`spectrum.js`、決定的、Node テスト `water-spectrum.mjs`）
- [x] 生きた周期 FFT（`fft.js`：2 段 DFT、2 カスケード、ω を 2π/256s に量子化、mip = LEAN の 1・2 次モーメント）
- [x] クリップマップの幾何（`mesh.js`：入れ子の正方リング、fine 段の先はセル 4 倍、T 字の継ぎ目、カメラへスナップ。Node テスト `water-mesh.mjs`）
- [x] 水面シェーダ（`surface.glsl.js`：NG_WAVE_GLSL の縦変位、反射・屈折・GGX・汀の泡・スネルの窓）
- [x] 波紋シミュ（`ripples.js`、high）・解析リング 16（全段）・雨の輪（ハッシュ 3 層）・しぶき（`splash.js`）
- [x] 証拠一式 `scripts/gfx/scenarios/water-proof.mjs`（§6.2 の撮影 + 読み戻し + ちらつき + 監査 + 健在）— PASS
- [x] 本編での確認 `scripts/gfx/scenarios/water-game.mjs`（h.bootGame、9 視点 + 着水、NaN 0・エラー 0・健在）— 合格
- [x] 予算の実測 `scripts/gfx/scenarios/water-bench.mjs`（本物 ↔ スタブ、同じ視点）
- [x] 自己批評 1 回（下）
- [x] run-tests 緑

## 設計の決定

- 縦の変位は NG_WAVE_GLSL の `ngWaveH · wind · ngShoalGain(ngDepth)` だけ（陸 = 0）。細波・輪・雨はすべて法線
- 細波は焼いたループではなく毎フレーム GPU で ĥ(k,t) → 2 段 DFT（N = P·Q ≤ 16·16）。ω の量子化で時間の折り返しが無い
- 粗さ：LEAN（FFT の mip の E[s²] − E[s]²）+ ゲームの 5 本の波を画素の足跡で 1 本ずつ LEAN + 画面微分の分散（輪・雨）+ 0.0015²
- 反射：R の 25m 先を ngReflMatrix で射影（平らなら鏡映カメラの視線と一致するので距離に依らず正確）、横幅で mip・縦は 2 点で伸ばす
- 屈折：法線の屈折と平らな屈折の射影の差で uv をずらす。**深度の検証は ruv と ±1.5px の 4 点の最小**（MSAA の解決色は輪郭の画素に
  手前の物の色を含むが深度は 1 サンプル。1 点だと桟橋・手すりの輪郭に沿って手前の色の粒が出た）。吸収は足さない（§3.4）
- 雨は毛管の細波を潰す（細かいカスケード ×(1 − 0.6·rain)、粗い ×(1 − 0.3·rain)）→ 雨の輪が読める（実際の雨の水面も短い波が減る）
- key の鏡面：厚い雲（ngCloudiness 0.55→1）で円盤を 0.22 rad まで広げ 25% へ弱める（雨の日に太陽の点を写さない。空の明るさは反射 RT が持つ）
- 影（近景 PCF 9 回 + 高さ場）は «見える» 鏡面の画素だけで読む：`s·lum(keyRad) > 0.004·lum(skyIrr)`。GGX の裾は影なしで足す
  （昼の見下ろしでは画面のほぼ全部が裾。内訳の計測で getShadowMask が最大の項だった）
- `NG_WBX`（既定 0）：ベンチ用のコンパイル時の切り替え（1 = 影なし、2 = 深度 1 点、16 = 灯籠なし、64 = 輪・シミュ・雨なし、128 = 泡なし）。
  `material.defines.NG_WBX = k; material.needsUpdate = true` で内訳を測る

## 計測

（下の «予算» と «証拠» を参照）

## 自己批評（1 回目：r3-a の証拠一式を見て）

1. **輪郭の手前の色の粒**（noon-fp-down・rain-rings-close：桟橋の床と手すりの輪郭に沿って明るい／木の色のギザギザ）→ 屈折の深度検証を 5 点の最小 + 滑らかな重みに。消えた
2. **雨の輪が読めない**（rain-rings-close：細波のざわつきに埋もれて輪が無い）→ 雨で毛管の細波を潰す。輪がくっきり（r3-b）
3. **雨の日に太陽の円盤が写る**（cloudiness 0.95 でも ngKeyRad が強い sky のスタブ）→ 雲量で円盤を広げて弱める
4. **昼の見下ろしの重さ**（1440p で水が 2–3ms、スタブとほぼ同じ）→ 内訳で影の読みが最大 → 見える鏡面だけで影を読む
5. **夜の浅場が青緑に光る**（moon-1930：棚の上に網目の caustics）→ 反射を切っても残る = caustics（underwater の担当）。要望へ
6. **浅場が乳白に見える**（noon-shore・岸の見下ろし）→ 屈折は湖底と caustics を正しく見せている。白っぽさは媒質の水の区間が
   «屈折で曲がらない直線» の長さ（斜めから見ると 1.5d ではなく d/sinθ ≈ 8d）で内散乱を掛けるのが主因 → core への要望
7. **水中から見上げた全反射の面が一様**（under-up・snell-window：窓の外が平らな色）→ 未対応（反射方向の sceneColor は画面外が多く、
   画面の縁で継ぎ目が出る）。open issue
8. 黄金時間の光の道が短い（風 1.4 の晴れは細波が弱い）→ 物理的にはこの風で正しい。cloudy／突風の斑の所で伸びる

## 他への要望

- **core（medium）**：空気 → 水中の点の水の区間を、交点 X → P の直線ではなく屈折後の長さ（≈ depth / cosθ_t）で数える
  （浅場を斜めから見ると内散乱が 4–6 倍に効いて乳白になる）。`ngMediumTerms` の `!camUnder` の枝
- **core（pipeline）**：late のパスは MSAA の色・深度を load/store し直すので、水が «面積 0» でも 1440p で ≈0.3–0.5ms（スタブも同じ）。
  water の予算 1.2ms のうちこれだけで 1/3。late に描く物をまとめる・store を省けるなら省く
- **underwater（caustics）**：夜（月）の caustics が明るすぎる（moon-1930 の棚が青緑に光る）。key の照度と ngSunVisibility に比例させる
- **sky**：cloudiness 0.95（雨）で ngKeyRad が晴れの 60% 残る（スタブ）。本物の sky で直達を雲で落とすこと（water は雲量で円盤を広げて対処済み）
