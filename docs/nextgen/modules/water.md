# water モジュール（ARCHITECTURE §6.2）— 作業メモ

ブランチの系譜：`ng/water`（f400022：spectrum.js・lab）→ `ng/water-r1`（08969f7 FFT・quality、604e8b9 WIP：本体の大半）→ `ng/water-r2`（このメモから）。

## 状態（チェックリスト）

- [x] 品質表 `src/gfx/water/quality.js`（§7 の water の行）
- [x] JONSWAP のスペクトル（`spectrum.js`、決定的、Node テスト `water-spectrum.mjs`）
- [x] 生きた周期 FFT（`fft.js`：2 段 DFT、2 カスケード、ω を 2π/256s に量子化、mip = LEAN の 1・2 次モーメント）
- [x] クリップマップの幾何（`mesh.js`：入れ子の正方リング、T 字の継ぎ目、カメラへスナップ）
- [x] 水面シェーダ（`surface.glsl.js`：NG_WAVE_GLSL の縦変位、反射・屈折・GGX・汀の泡・スネルの窓）
- [x] 波紋シミュ（`ripples.js`、high）・しぶき（`splash.js`）
- [ ] 証拠一式 `scripts/gfx/scenarios/water-proof.mjs`（§6.2 の撮影 + 読み戻し）
- [ ] 本編での確認（h.bootGame）
- [ ] 予算の実測（3 段）
- [ ] 自己批評 2 回
- [ ] Node テスト（純粋な論理）・run-tests 緑

## 設計の決定

- 縦の変位は NG_WAVE_GLSL の `ngWaveH · wind · ngShoalGain(ngDepth)` だけ（陸 = 0）。細波・輪・雨はすべて法線
- 細波は焼いたループではなく毎フレーム GPU で ĥ(k,t) → 2 段 DFT（N = P·Q ≤ 16·16）。ω の量子化で時間の折り返しが無い
- 粗さ：LEAN（FFT の mip の E[s²] − E[s]²）+ 画面微分の分散（解析の波・輪）+ 0.0015²
- 反射：R の 25m 先を ngReflMatrix で射影、横幅で mip・縦は 2 点で伸ばす（斜めの映りの縦の伸び）
- 屈折：法線の屈折と平らな屈折の射影の差で uv をずらす、深度で手前を拾えば戻す。吸収は足さない（§3.4）

## 計測

（未）

## 自己批評

（未）

## 他への要望

（未）
