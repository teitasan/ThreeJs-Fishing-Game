# core への要望と、仕様からのずれ（統合時に取り込む）

凍結した API（ARCHITECTURE §4.13）の変更要望と、実装で仕様どおりにできなかった点をここに書く。
統合者が Phase の境目でまとめて判断する。

---

## Core-B（世界データ層・ファサード）から

### B-1. keyDir の切り替えは producer に合わせた（§5.3 と §6.1 の食い違い）

- §6.1：key は「太陽高度 −1° で月に切り替え（交差点で強度 0）」。Core-A の sky スタブの `produce` もこの規則。
- Phase −1 の fixture（`scripts/fixtures/sky.json`）の keyDir は旧版の «強い方» の規則（日の出・日没の 0.5° ほど手前で切り替わる）。
- **決定**：`Environment.update` は `gfx.beginFrame` の戻り値の `keyDir` をそのまま `env.keyDir` にする（実際に影を落としている光と
  caustics・水中の光柱・getUnderwaterContext の sunDir を一致させるため。«一つの光»）。core が居ない・例外のときは旧版の規則
  （fixture と 1e−9 一致、`weather-api-test` が検査）。sunDir・nightAmount は常に旧式。
- sky モジュールの担当者へ：`produce(input)` の `input.keyDir` は旧版の判定の値なので使わず、今のまま自分の規則で `keyDir` を返してよい。

### B-2. waveGLSL の 5 桁の定数による CPU/GPU の位相のずれ（water モジュールへ）

- `waveField.js` は変えない約束なので、`waveGLSL({prefix:'ng'})` は定数を `toFixed(5)` で焼いたまま。ω の丸め × 時刻で位相がずれ、
  縦の変位の差は **10 分で最大 0.45mm、1 時間で 1.8mm**（`wave-agreement-test` が生成した GLSL を JS で評価して測っている）。
  §6.2 の読み戻しの合格条件（深場 < 1mm）を長時間のプレイで割る。
- 提案：water モジュールは生成した GLSL の `t * <ω>` を、JS の倍精度で計算した `mod(t·ω_i, 2π)` の uniform（5 本）へ文字列置換する
  （定数は `W[i].om`）。あるいは `ngFrame` の予備スロットに位相を置く。どちらも waveField.js は変えない。

### B-3. fish.js の shaders.js の ?v= が古いまま

- game.js は `./shaders.js?v=20261001-ng1`（新しい内容なので ?v= を上げた）、fish.js は `./shaders.js?v=20260830-zone5`、
  core の index.js は無印 `../../shaders.js` を読む。**3 つの別インスタンス**になる（中身は同じ文字列・同じ関数なので動作は同じ）。
- 問題はブラウザのキャッシュ：以前に遊んだ人の HTTP キャッシュに `shaders.js?v=20260830-zone5` の **旧版**（sampler2D の uCaustTex）が残っていると、
  fish.js が旧 CAUSTICS_GLSL を読み、新しい uCaustTex（DataArrayTexture）と型が合わず魚のシェーダが落ちうる。
- 提案（CONTRACT §4.5 で許されている範囲）：fish.js の import を `./shaders.js?v=20261001-ng1` に揃える。fish.js は Core-B の所有外なので触っていない。

### B-4. heightTexture と rt / reflRT は core の実物を指す

- `terrain.heightTexture` は `gfx.heightfield.uniforms.ngHeightNear.value`。heightfield が未構築なら、格子（`terrain.grids.near`）から
  R32F・Nearest の DataTexture を遅延で作る（使われたときだけアップロードされる）。
- `water.rt` は `gfx.pipeline.targets.copy`、`water.reflRT` は `gfx.pipeline.targets.refl`（無ければ null）。名前を変えるときはファサードも直す。

### B-5. Terrain の追加オプション `grids`

- `new Terrain(scene, { ..., grids })`：作り済みの格子（か Promise）を渡せる。`false` で作らない（Node のテストで 1s の格子づくりを省く）。
  lab キットが格子を使い回すときにも使える。契約（game.js からの呼び方）は変わらない。

### B-6. 配置の予算（250ms）

- Chrome（M1）の実測 144ms、Node の冷えた 1 回目で 190–300ms（温まると 140–230ms）。重いのは heightAt / slopeAt / shoreRadius（lakefield の fbm）。
  `placement.stats.sections` に系統ごとの時間を出している。予算を超える機械が出たら、帯 + 20m の外の木（当たりの無い見た目だけのもの）を
  `terrain.ready` の後段へ回すのが次の手（Placement の形は変えずに、`trees` を 2 回に分けて埋める）。

### B-7. 汀（ヤナギ・ハンノキ）の区分は «汀線から 20m»

- §5.2 は「汀線 0–12m にヤナギ・ハンノキ」だが、同じ節の «旧来の規則：木は h ≥ 1.6» を守ると、汀線から 10m ほどは標高 0.7–1.6m で木が立たない。
  そのため汀の区分を «最初に立つ木の列（汀線から 20m・標高 5m 未満）» にした。水際のヤナギの張り出しは lean（湖心へ 0.05–0.18rad）で出す。

### B-8. 生態と配置の約束（描く側へ）

- `placement.trees`（SoA、Float32Array）：`x z y h species variant rot lean rank collide mustDraw zone r top bandD`。
  `y` は根元（地面 − 0.15）、`rot` は rotation.y、`lean` は rot を向けた後のローカル +Z 側への傾き（世界の方向 (sin rot, cos rot)）。
  `zone`：0 汀・1 下部広葉樹・2 植林・3 混交・4 尾根。`mustDraw = 1` は全品質で必ず描く（帯 + 12m の当たりのある木）。
- 見た目の間引きは `isVisible(system, rank, tier, must)`（`TIER_DENSITY`）。当たりのある大岩（`collide`）と藪は must で全品質で描く。
- 大岩・玉石の見た目：底面中心が原点、半径 0.40·size·(sx, sz)、高さ size·sy（`y` は沈めた底面）。当たりは r = 見た目の半径 × 1.05、上端 = y + size·sy。
- `placement.ecology`：植林区画（中心・幅・奥行き・回転・主木・樹齢・列の間隔）とノイズの係数。被覆マップの焼き込みで同じ場を作れる。
- 旧版の `terrain.treeSet` / `rockSet` / `waterPlants.emergent` などは無い（モジュールが placement から描く）。

### B-9. 灯籠の PointLight は Environment が持つ

- 光のリグは起動時に固定する（§0）ので、灯籠の PointLight（2200K、intensity 0、`name = 'ng-lamp'`）は Environment が作って
  `setLightRig({ lamp })` で渡す。位置は `(0, -1000, 0)` のまま。hardscape が `placement.lamp`（x, z, top）の位置へ動かし、`setLamp(night, dt)` で強さを決める。
