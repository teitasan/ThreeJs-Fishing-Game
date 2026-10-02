# underwater + weatherfx（ARCHITECTURE §6.3 / §6.9）— 進捗の記録

ブランチ：`ng/underwater+weatherfx`（fork/nextgen-graphics から）。`underwater.md`・`weatherfx.md` はこのファイルを指す。

## 状態
- [ ] underwater：caustics の焼き込み（屈折した格子の面積比、RGB 分散、時刻フレーム）
- [ ] underwater：新しい CAUSTICS_GLSL（16 名、魚の GLSL3 で動く）
- [ ] underwater：光学（σa/σs/内散乱・濁り）・getUnderwaterContext
- [ ] underwater：水中の Effect（光柱・距離のぼけ・メニスカス）
- [ ] underwater：プランクトン / マリンスノー
- [ ] underwater：読みやすさの数値（10/20/30m のグレーカード）
- [ ] weatherfx：雨の筋・着弾・水面の衝撃・遠景の霞
- [ ] weatherfx：朝霧の板・蛍・光芒の塵・env.rain
- [ ] lab・シナリオ・テスト・予算・art-metrics・本編の確認
- [ ] 自己批評 1 回

## 設計の決定
（作業しながら追記）

## 計測

## 未解決・他への要望
