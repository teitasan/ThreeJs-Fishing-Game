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

---

## Core-A（描画の芯・lab・撮影）から

### A-1. 近景の影の PCF を差し替えた（§4.5 の «PCFShadowMap と radius» からのずれ）

- three r180 の PCFShadowMap は 1 断片あたり 17 回の RGBA 読み + アンパック。水面だけで ≈1.3ms（2560×1440）かかった。
- `shadowmap_pars_fragment` の PCF の分岐に `#if defined( SHADOWMAP_TYPE_PCF ) && defined( NG_FRAME )` の枝を足し、
  3×3 テクセルの二次 B スプライン重みの `ngShadowPCF`（9 回の読み、テクセルの境で重みが連続）にした。半影 ≈1.5 テクセル（high ≈5cm）。
- `renderer.shadowMap.type` は PCFShadowMap のまま。`quality` の `nearShadow.radius` は NG_FRAME の無いシェーダ（chunks の自己検査が落ちた degraded）だけに効く。
- 影をもっと柔らかくしたいモジュールは自前で広げず core に要望を（段ごとの uniform で重みの幅を変える案がある）。

### A-2. high は M1 Pro の 2560×1440 で 2× + SMAA に落ちる（§3.2 の判定を入れた結果）

- `docs/nextgen/spikes.md` S-1。4× − 2× の上乗せ 1.4–2.1ms > 閾値 0.9ms。1280×720 では 4× のまま。
- `quality.profile` は降格すると `msaa: 2, postAA: 'smaa'` を返す。post モジュールは `profile.postAA` を見て AA を選ぶこと（high = 'none' と決め打ちしない）。

### A-3. 雲影は頂点で評価して varying で渡す（§4.2 の lights のフックの式からのずれ）

- fog_vertex が `vNgCloud = ngCloudShadow( vNgWorld )`。lights のフックは `ngKeyVis = vNgCloud * ngHfShadowAnalytic( vNgWorld ); directLight.color *= ngKeyVis;`。
- 雲の斑は 900m 規模なので頂点の間隔で足りる（全画面で 0.43ms の節約）。100m を超える三角形では線形補間になる（遠景の稜線リングなど。見た目の差は無い）。
- ngExtendStandard の caustics は `ngKeyVis * ngNearVis` を使い回す。fog チャンクを含む自前シェーダは `ngSunVisibilityC(P, nearVis, vNgCloud)` を使う（`ngSunVisibility` は断片で雲影を評価する版として残す）。

### A-4. caustics のグレーボックスは «焼いたタイル»（underwater モジュールへ）

- `CAUSTICS_GLSL` は解析の Worley をやめ、uCaustTex（sampler2DArray、層 = 時刻のフレーム、R/G = 網 A/B）を 4 回読む。
  弱める係数（視距離・深さ・面の向き・夜・雨・雲・太陽）を先に掛けて 0 なら読まない（全画面 2.58 → 0.17ms）。
- タイルは underwater のスタブが起動時に `forge.bakeArrayPixels` で焼いて `updateCausticsTexture` で入れる（テクスチャのオブジェクトは同じ）。
  1 層のプレースホルダのままなら caustics は 0（一様な光を出さない）。形は `CAUSTICS_TILE`（caustics.glsl.js）。
- 本番の underwater は屈折格子の面積比（Evan Wallace 式）の焼き込みに置き換えてよい。契約（16 名・署名・y > −0.02 で 0・sampler2DArray だけ）は caustics-contract が固定。

### A-5. 予算の実測が §7 の表に届かない所

- core の取り分（2560×1440 high、全モジュールを隠した lab）：copy 0.6ms + 空の late 0.6–0.8ms（MSAA の読み戻しと 2 回目の resolve）+ post 0.9–1.0ms。
  §7 の core 0.70ms（コピー 0.15・resolve 0.35）は RGBA16F の 2560×1440 では無理。**core の行を 1.3ms、post を 1.0ms で見込み直す**ことを提案。
- G0 の «グレーボックスの GPU < 5ms»：本編の全スタブで high 2560×1440 は 9.0–11.1ms（水上）/ 6.9–8.1ms（水中）、mid 1920×1080 は 5.5–6.5ms / 3.5–4.0ms。
  スタブは placement の全部（木 2 万本・岩・桟橋）を描くので «何も無い» グレーボックスより重い。スタブの反射（1.8–2.3ms）は
  «植生は LOD +1、草なし» を担当者が入れれば下がる。数字は `docs/nextgen/spikes.md` S-3。

### A-6. プログラム数とサンプラーの余裕が少ない

- グレーボックスだけで 52–58 本（§4.4 の上限 60）。customProgramCacheKey に tier が入るので、段の切り替えの直後は古い段のプログラムも一時的に数に入る。
  10 モジュールが入ると超える見込み。**上限を 90 に上げるか、各モジュールの予算を «4 本まで» と決める**ことを統合時に判断してほしい。
- terrain のスタブの断片のサンプラーは 11/12（高さ場ライブラリが 8 枚：高さ ×2・法線 ×2・汀線・底質・樹冠・被覆）。
  terrain の担当者は素材の配列 2 枚を足すと超えるので、`ngShoreDist`（R16F）・`ngBedMap`・`ngCoverMap` を 1 枚の RGBA16F に詰める変更を core に頼むこと（要望があれば Phase 1 の途中でも入れる）。

### A-7. core の API に足したもの（§4 の凍結に追記）

- `forge.bakeArrayPixels({ w, h, layers, frag, uniforms }) → { data, width, height, depth }`（参照を差し替えられない DataArrayTexture へ中身を入れる）
- GLSL：`NG_CLOUD_GLSL`（medium.glsl.js から分けた雲だけの部品）、`vNgCloud`・`ngKeyVis`（fog / lights のチャンク）、`ngSunVisibilityC`、`ngVNoise2D`（値ノイズと解析的な勾配）、
  `ngShadowPCF`（chunks）
- `NG_SHADOW_GETSHADOW` / `NG_SHADOW_PCF_BRANCH`（chunks のアンカー。core-chunks テストが vendored の three に対して検査）
- lab：`__lab.bench / moduleCosts / programAudit / fishCheck / msaa / glsl / meanLuminance / views`。
  撮影：`scenarios/lab-matrix.mjs`・`game-matrix.mjs`・`core-robust.mjs`・`core-glsl-cost.mjs`・`lab-bench.mjs`、判定 `scripts/gfx/art-metrics.mjs`、PNG の読み書き `scripts/gfx/png.mjs`

### A-8. グレーボックスの見た目は art-metrics に通らない（sky / water / post の担当者の出発点）

- `lab-matrix`（dock-3p・noon-fp-down・dawn-3p × 5:40–23:30 × 晴れ・雨）で：17:45 の黒つぶれ 17–54%（低い太陽が山の陰・雨で key がほぼ 0・
  post のスタブは画面輝度の順応 ±1EV を持たない）、noon-fp-down の水の色相 204–229°（160–200° の外）。真夜中／真昼の比 0.25（下限ぎりぎり）。
- 露出の順応（§2 の adapt）は post モジュールの仕事として残した（スタブは時刻表 × 水中だけ）。
- sky のスタブの SH が «4Hz の実時間» でしか更新されず、時間を止めた撮影で時刻を変えると昼の環境光が残っていた。時刻の跳び（0.05h）と
  天候の即時切り替えでも射影し直すようにした。本番の sky モジュールも同じ条件を入れること。
