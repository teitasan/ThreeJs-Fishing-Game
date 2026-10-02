# underwater + weatherfx（ARCHITECTURE §6.3 / §6.9）— 進捗の記録

ブランチ：`ng/underwater+weatherfx-r1`（前の `ng/underwater+weatherfx` は quality.js だけで中断。そこから続けた）。
`underwater.md`・`weatherfx.md` はこのファイルを指す。lab：`lab/underwater+weatherfx.html`（`lab/underwater.html`・`lab/weatherfx.html` は同じ中身）。
統合済みの sky・water・terrain・trees を本物で動かす（`?only=1` で underwater と weatherfx だけ本物）。

## 状態
- [x] underwater：caustics の焼き込み（周期スペクトルのヘッセ行列 16 × 512² / 8 × 256²、時刻のフレーム）
- [x] underwater：新しい CAUSTICS_GLSL（16 名、面積比 1/|det(I + D·H)|、RGB 分散、2 向きのタイルの和、深さで mip、旧式の分岐）
- [x] underwater：光学（σa/σs/内散乱・濁り、Fresnel の透過）・getUnderwaterContext
- [x] underwater：水中の Effect（光柱：近景の影・太い筋・前方散乱、距離のぼけ、メニスカス、空の画素を «無限の水» で埋める）
- [x] underwater：プランクトン / マリンスノー
- [ ] underwater：読みやすさの数値（10/20/30m のグレーカード）
- [ ] weatherfx：雨の筋・着弾・水面の衝撃・遠景の霞
- [ ] weatherfx：朝霧の板・蛍・光芒の塵・env.rain
- [ ] lab・シナリオ・テスト・予算・art-metrics・本編の確認
- [ ] 自己批評 1 回

## 設計の決定
- **caustics は «ヘッセ行列を焼いて受け手で面積比»**（Evan Wallace の格子の面積比の解析形）。光子を 3m の面に撒く焼き込みだと
  (1) 時刻のフレームの線形補間で明線が二重写しになる（波は 1 フレームで数十 cm 進む）、(2) 深さで焦点が変わらない。
  ヘッセ行列は線形なので、フレームの補間・2 向きのタイルの和（115°・0.79 倍）が «正しい波の場» のまま。D = 光路長 × (1 − 1/n) で
  浅瀬は自然に弱く、焦点の深さ（短い波 ≈ 1–3m、長い波は深い）で鋭くなる。RGB は n = 1.329 / 1.334 / 1.341
- water の `detailTile` は null（water が提供しない）なので、caustics は自分の周期スペクトル（spectrum.js、40 成分、格子に吸着 = 空間 L = 7m で厳密に周期、
  時間は 1 巡 8 秒の整数周波数 = 厳密に周期）
- 平均の補正：1/|det| の平均は焦点の先で 1 を超える（折り返しを数える）ので m(x) = 1 + c·x²·e^(−0.35x²) で割る（c は焼くときに CPU で当てはめ、uCaustMag）
- 出力 = E·cosθ/π·(A_b·max(I−1,0) − A_d·min(1−I,1))（A_b 0.30・A_d 0.22）。E = uCaustMixW = 水面を透過した key（Fresnel 込み）。水の減衰は fog チャンク
- uniform の意味は本番と旧式（core のスタブの網目）で分岐（uCaustShape.x ≥ 1.5 が本番）。dispose で旧式の既定値へ戻す（スタブが立て直したとき網目を正しく読む）
- 光柱：fog チャンクの «等方・影なし» の key の内散乱を、HG 位相（g 0.82）× 近景の影 × 太い筋に置き換える補正（負にもなる）。
  σs 0.03 の澄んだ水では揺らぎが 2% 未満で消えるので、揺らぎ (V − 1) だけは懸濁物 σp 0.14/m の前方散乱として足す（平均は物理のまま。art の判断）。
  ステップは s = L·u²（近くに密）、ブルーノイズのディザ → 半解像度の分離ぼかし（深さで重み）→ 合成で 5 タップ
- 空の画素（線形深度 ≈ far）を水中から下・水平に見ているときは «無限に続く水» の色（fog チャンクと同じ式の閉形式）で埋める。
  理由：湖底の CDLOD の抜け（下の «要望»）と、sky のドームの地面色（ベージュ）が水中から丸見えになっていた

## 計測
- caustics の焼き込み（high 16 × 512²）：141ms（層ごとの読み戻し）→ 層を縦に積んで 2 回の読み戻しへ（測り直す）

## 未解決・他への要望
- **terrain（または core の CDLOD）**：水中のカメラから、深さ 4m より深い湖底のパッチが描かれていない（線形深度 = far。
  CPU の lake.heightAt では 30–50m 先に湖底がある）。lab の `sun:mid:-100:5`（12:30）で再現。underwater の Effect が水の色で埋めて隠している
- **sky**：水中のカメラでドームの地平線より下（地面色のベージュ）に水の媒質が掛からない。上と同じく Effect が埋めている
