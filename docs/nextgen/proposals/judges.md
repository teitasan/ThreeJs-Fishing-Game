# judge 1
winner: robust

## scores
- fidelity: visual 9 feas 5.5 perf 6 contract 8 par 8 total 7.5
  Highest visual ceiling. One lighting model reaches the built-in characters too (CSM, terrain and cloud shadow, and ngDownwell through lights_fragment_begin). The ripple PDE reflects off the piles, LEAN roughness comes from FFT moments, froxel dawn mist and forest shafts are included, and the design is well structured for a lab-per-module workflow. It is also the riskiest. TAAU reprojects from depth only, with no motion vectors, so the skinned angler, undulating fish, swaying reeds and grass, and fish seen through refraction will ghost or smear, which hurts fish spotting (a gameplay readability problem). About 55 programs, custom CSM, froxels, a cloud panorama and TAAU all have to work at once. The GPU sum leaves no line for the shadow pass, so there is no real headroom at 1440p. Contract handling is careful (dummy underwaterProps group, lights layers.enableAll, waveGLSL parity, safe() isolation).
- robust: visual 7.5 feas 8 perf 7.5 contract 9 par 9 total 8.1
  Best skeleton to build on. It has phase −1 fixtures from the old code, a MEDIUM RULES table so every path segment is attenuated exactly once, and a Float32Array ngFrame shared through ShaderLib with a boot self-check (I checked the cloneUniforms reasoning against r180; it holds). It also has strict ownership with grey-box stubs at fixed paths, ?ng= bisect flags, nested rank subsets with tier-invariant colliders, and a MSAA 4x + alpha-to-coverage path that keeps thin lines and fish readable without TAA ghosting. It needs only 2 game.js edits. Visually it is a step below: pre-baked periodic FFT, analytic ring splats (no pile or shore reflection), no volumetric mist (sheets only), scripted exposure with no adaptation, and characters that only get the near shadow plus a CPU cloud dim. There is one real bug: the late/water camera mask excludes layer 0, so the lights are culled.
- art: visual 8 feas 6 perf 5.5 contract 6.5 par 7 total 6.7
  Strongest art direction. It has ecological zoning that reads from a distance (dark plantation sugi/hinoki blocks, riparian willow/alder, beech on the lower slopes, akamatsu on the ridges), a palette bible, a grey card and 24-patch chart in every lab, and automated art-metrics (per-time luminance bands, a 160–200° hue check on the noon-fp-down view, water/sky ratio). The engineering is weaker. Structures go into underwaterProps.group, which game.js hides above water, so they vanish from above. It changes the sun orbit and nightAmount formula. It keeps game.js creating caustics from a deleted module. Its lit water pass also culls the lights. The grass and reed counts are infeasible (up to ~9.6M grass vertices), a 1 m terrain grid plus an R16F heightfield will not meet the 2 cm heightAt target, and the budget sum of 15 ms is over target.

## graft
- fidelity: The ngSunVis hook in lights_fragment_begin (right after getDirectionalLightInfo, UNROLLED_LOOP_INDEX==0). Built-in angler, fish and remote players then darken correctly under cedar shade and far or cloud shadow. Add sampler uniforms per material through the auditor's onBeforeCompile chain, since ShaderLib cannot share samplers.
- fidelity: Multiply ngDownwell into the built-in reflectedLight terms (the four terms after lights_fragment_end). Fish then shift to teal with depth, consistent with the lakebed and absorption applied once, as in robust's MEDIUM RULES.
- fidelity: A camera-forward ripple PDE (RG16F, 512–768²) with pile, reed and shore damping masks, plus 16 analytic rings for bobber-scale detail and hashed rain rings. On mid/high this replaces robust's splat-only ripples, which cannot reflect off piles.
- fidelity: LEAN/Toksvig variance from FFT slope moments. The far lake then blurs into a correct glitter path at golden hour without sparkle aliasing. Keep robust's periodic pre-baked FFT as the low-tier fallback.
- fidelity: A terrain plus canopy heightfield-march sun shadow (1024² R8, amortised). Mountain shadows sweep across the lake at dusk, and it acts as the far-shadow fallback beyond the near map.
- fidelity: A froxel volume (high only; mid uses analytic) with the ngVolEnd split rule, for dawn lake mist, forest light shafts and a lamp halo in mist. Robust's mist sheets stay as the low/mid fallback.
- fidelity: Light objects use layers.enableAll(). Add a lab stats() and nanCheck(), a registerDebugView(name, glsl) debug-view registry, safe() module quarantine that switches to a core stub, and weather snap {instant:true}.
- fidelity: The GPU-vs-CPU water height readback test (<1 mm deep, <5 mm shallow) and the terrain readback test (<2 cm in the walk band).
- fidelity: A world probe with SH9 read back through readRenderTargetPixelsAsync, and a PMREM for scene.environment whose intensity is scaled down underwater and at night. This fits the contract note about the angler being tuned without an environment map.
- art: Ecological placement tables: riparian willow/alder at 0–12 m, beech/mizunara/maple on gentle lower slopes, 100–300 m blocks of dark sugi/hinoki plantation in rows, akamatsu and bare rock above 90 m. Put these in the three-free placement layer so the mountain silhouette reads as a Japanese lake from colour masses alone.
- art: palette.js as a colour bible (linear albedo ranges, ng illuminance units). Every lab carries a grey ball, a chrome ball and a 24-patch chart, with a false-colour view.
- art: art-metrics.mjs automated checks: luminance bands per time of day, clipping below 0.5% and crush below 1%, a 160–200° hue for the noon-fp-down water (the old 225° ultramarine fails), a water/sky ratio of 0.35–0.75, sky banding detection, and luminance that changes monotonically through dawn to catch exposure pops.
- art: The principle that low tier must never lose the mirror reflection (it is the art lifeline). Also water σ tuned to read as bed colour, then teal at 3–6 m, then blue-black past 10 m, and a lab check that caustic luminance on fish equals that on the bed.
- robust: Phase −1 golden fixtures captured from the old c8490ed code for the Terrain, Water and Environment behaviour, with parity to 1e−9.
- robust: The MEDIUM RULES table (camera and point, each above or below water, and the reflection pass) as the single normative spec for where air and water attenuation are applied.
- robust: Late-object handling that keeps layer 0 (so raycasts are unaffected) and toggles visibility during the opaque call. Fidelity's auditor moves objects onto a LATE layer instead, which would break raycasts.
- robust: MSAA 4x + alphaToCoverage on high as the default AA. It keeps the fishing line, rod, bobber and fish seen through refraction sharp, with no temporal ghosting. TAAU becomes an optional later add-on, and only with a velocity buffer.
- robust: The underwater visibility metric (grey-card contrast at 10/20/30 m) as a gameplay-readability gate for spotting fish. Extend it so weed beds (lake.flats), 葦際 reeds and structures stay readable from the dock through refraction.
- robust: Automatic horizon matching (solve ngInscatterAmb so terrain haze at 3 km equals the sky's horizon radiance), and ?ng=-module bisect flags.

## mustFix
- robust + art: three culls lights by camera.layers (projectObject checks object.layers.test(camera.layers) before pushLight). Robust's late mask (4,5,6) and art's water pass (layer 1) exclude layer 0, so the lights:true water shader gets no sun, moon, lamp, SH probe or shadow. Every light and the LightProbe must call layers.enableAll() (fidelity already does this).
- robust + art: Both render the late/water pass back into the same MSAA RT after it has been resolved and sampled. three r180's updateMultisampleRenderTarget may invalidateFramebuffer on the renderbuffers after the blit, so opaque colour and depth could be lost on ANGLE/Metal. Verify this in a phase-0 spike. Otherwise draw late into the resolved single-sample target with the copied depth, or keep ignoreDepthForMultisampleCopy/resolve flags explicit.
- art: Sunken rocks, snags and props are put into terrain.underwaterProps.group. game.js:1606 sets that group invisible in the above-water main pass, so structures disappear from the dock view through refraction. underwaterProps.group must be an empty dummy, with the real content on its own layer (as fidelity and robust do).
- art: game.js still creates causticsUniforms itself, but causticTexture.js/createCausticTexture is deleted (contract §2). Export createCausticsUniforms() from shaders.js and change the one game.js import.
- art: The sun orbit is replaced (latitude 36°, noon altitude 54°) and nightAmount is redefined. This shifts the lamp (updateLamp) and audio.setNight timing and breaks parity with the old sky.js:362 formula (cos ang, sin ang, 0.34). Keep the old sunDir/nightAmount, or get this explicitly approved and update the tests.
- art: Water displacement is described as '5 本の Gerstner'. It must be vertical-only waveHeight × shoalGain (waveGLSL), with no horizontal Gerstner shift, or the visual surface will not match surfaceY for the bobber and fish.
- art: Grass at 120k clumps × 8–16 blades × 5 vertices (up to ~9.6M vertices) in 1.3 ms, and reeds at 50k, are infeasible at 1440p. Cap at about 25–30k clumps and 16–30k reeds, as the other designs do.
- art: A 1 m inner terrain grid plus an R16F ngHeightTex (about 6 cm quantisation at 100 m altitude) cannot meet the 2 cm heightAt target, and grass or pebbles will float or sink. Use a 0.25–0.5 m near LOD and R32F heights with manual bilinear filtering.
- art: The high-tier budget sums to 15.0 ms, over the 14 ms target, with a DRS floor of only 0.8. Season defaults to 0.15 ('初秋') while fireflies require summer. Pick one season convention.
- fidelity: TAAU reprojects from depth only, with no motion vectors. It will ghost the skinned angler, the vertex-animated fish (visible through refraction and underwater), wind-swayed foliage, reeds, grass, the line and rain, and a reactive mask does not fix this. Add an MRT velocity buffer (previous modelMatrix, previous wind/fish time through onBeforeCompile), or ship MSAA/SMAA on high. Also strip the projection jitter before any gameplay code reads camera.projectionMatrix (raycast/unproject).
- fidelity: The budget table has no core line for the CSM shadow pass (c0 and c1 every frame at 4×2048 with forest casters, plus character casters) or for the PMREM spikes. The module sum is about 11.7 ms before shadows and characters, so it is at or over 14 ms even at renderScale 0.8. Add explicit core lines and a tested cut order.
- fidelity: The auditor moves transparent, depthTest=false and renderOrder≥3 game objects onto a LATE layer (main mask 0|4|5|6), which takes them off layer 0 and breaks any raycast. Keep layer 0 and toggle visibility (robust's approach).
- fidelity + robust: FAR_GATE is invented (24 m and 12 m). The old value was derived (TREE_LOD_DIST[last] + TREE_FADE_BAND + 12, terrain.js:1834). Derive it from the old constants so the set of colliding trunks matches expectations, and pin it with a fixture test.
- all: The heightfield workers rebuild the lake. They must use exactly the resolved lake parameters (the resolveLake result or seed after retries), not makeLake(lake.seed) blindly, and must assert a hash equal to the main-thread lake before any bake is used.
- robust: Exposure is fully scripted with no adaptation (only an underwater factor), so the forest interior, under the dock and the dusk forest edge will read too dark or too bright. Add fidelity's metered adaptation clamped to ±1–1.5 EV around the scheduled EV, frozen at sdt=0 and disabled under capture.
- robust: Built-in characters get only the near shadow plus a CPU cloud-shadow dim at the focus point, so remote players and fish farther away do not match the terrain lighting. Add the fidelity-style per-material sampler patch for ngSunVis (far shadow and cloud shadow) through adopt/onBeforeCompile on known character materials.

## advice
Build on the robust design. Take its ownership model, frozen ngFrame, MEDIUM RULES, guards, phase −1 fixtures, grey-box stubs, nested rank subsets and 2-line game.js diff. Keep MSAA 4x + A2C on high (SMAA on mid, FXAA on low) as the shipping AA. That protects gameplay readability of the line, bobber and fish through refraction. TAAU can come later behind a flag, and only once a velocity buffer exists.

Then raise the visual ceiling with fidelity's pieces:
- the per-material character patch (ngSunVis in lights_fragment_begin, ngDownwell on reflectedLight), added through an onBeforeCompile auditor alongside the ShaderLib fog patch
- the ripple PDE with pile, reed and shore damping, plus the analytic rings
- LEAN roughness from FFT moments, keeping the periodic pre-baked FFT for low
- the heightfield-march terrain and canopy sun shadow for mountain shadows over the lake
- froxel mist on high only
- the world probe with SH and PMREM, attenuated underwater
- the readback parity labs

Fix the light-layer culling bug and verify MSAA re-rendering after resolve in the phase-0 spike.

Adopt art's ecology placement tables inside the three-free placement layer. Treat palette.js, the chart and false colour in every lab, and art-metrics.mjs as hard merge gates. Look-dev then converges on one coherent Japanese mountain lake instead of nine per-lab looks.

Keep the old sunDir/nightAmount formula.

Add gameplay-readability gates next to the beauty gates:
- the grey card underwater at 10/20/30 m
- weed beds on lake.flats, 葦際 reeds and structures readable from the dock through refraction at noon and at dusk
- the bobber and markers always visible
- 2-client obstacle hash equality

Make the budget honest: explicit core lines for shadows, copies, resolves, probe and characters. Hold the high tier at ≤14 ms at 1440p before DRS, and publish the cut order in advance: froxels, then PCSS, then reflection resolution, then grass radius.
# judge 2
winner: robust

## scores
- robust: visual 7.5 feas 8.5 perf 7.5 contract 9.5 par 9 total 8.2
  基盤として採用する。r180 で実際に動くことを確かめた（下記）。まず、ShaderLib の ngFrame を Float32Array の参照で共有する方式は成立する：cloneUniforms は Array.isArray/isVector 以外の値を参照のまま渡す。次に、MSAA の RT への 2 回目の描画も成立する：解決後の invalidateFramebuffer は OculusBrowser のときだけ走るので、Chrome では MSAA の中身が残る。パイプラインは game.js の既存の呼び出し順（capture→captureReflection→render）にそのまま乗る。影の更新は 1 か所。固定の光源構成、Phase −1 で旧コードの振る舞いを fixture に記録すること、ファイルの所有を厳密に分けること、スタブを固定パスに置くことで、9 人が並行して作っても壊れにくい。弱いのは見た目の上限。フロクセル・AO・TAA が無い。波紋はスプラットだけで、杭での反射が無い。FFT は 16 秒周期の焼き込み。遠景の影は 3 秒ごとの別マップ。low では平面反射が無い。
- fidelity: visual 9.5 feas 6 perf 5.5 contract 8.5 par 7.5 total 7.5
  見た目の上限はいちばん高い。独自 CSM＋PCSS、TAAU＋DRS、フロクセル、雲のパノラマ、FFT＋LEAN、波動方程式の波紋シミュ、同じフレームで行う屈折、Hillaire の LUT、SH とプローブを持つ。技術的にも大半は正しい。UNROLLED_LOOP_INDEX==0 へのパッチは、インクルードを展開した後にループを展開する r180 の仕組みと両立する。インクルードガード付きの ng_* と waveGLSL の prefix 'ngW'／'ngCs' の使い方も正しい。問題は三つ。まず、GPU の合計が 14ms に収まっていない：モジュールだけで 11.7ms、ほかに core の CSM（4 カスケードで森を描く）とキャラクターの分が未計上。次に、core が巨大で、2 人・2〜3 日では終わらない。最後に、TAAU に速度バッファが無いので、揺れる植生・魚・竿・糸にゴーストが出る。水のサンプラーは 14 と見積もっているが、実際に数えると 16 を超える。技法は採用する価値があるが、そのまま全部を実装するには危険。
- art: visual 8 feas 6 perf 5 contract 7 par 6.5 total 6.6
  アートディレクションの価値が最も大きい。生態に沿った配置（植林のスギ・ヒノキの区画、水辺のヤナギ・ハンノキ、尾根のアカマツ）、palette.js の色彩バイブル、全 lab 共通のグレーカードとチャート、PNG から自動で測る art-metrics（真下視の色相 160〜200°、輝度の帯、露出の跳び）は取り込むべき。技術面の欠陥は多い。高さ場が R16F で精度が足りない。草は high で 6〜9.6M 頂点になり、1.3ms の予算を大きく超える。underwaterProps.group に実物を入れているので、game.js が水上でそれを隠し、単一パスの屈折では見えなくなる。太陽の軌道の式を変えている。core API（ステージ、pass ID、所有）の定義も粗い。high の合計は 15ms で、予算をすでに超えている。

## graft
- [fidelity] high 限定で波動方程式の波紋シミュ（RG16F、カメラ前方の窓、整数テクセルでスクロール、杭と葦を吸収体にする）を入れる。robust のスプラット式リングは mid/low と、窓の外（ウキが遠いとき）の補完に残す。
- [fidelity] 水の粗さは LEAN モーメント（sx, sz, sx², sz² の mip）で出す。σ² を GGX の α² = 0.02² + 2σ² に足し、遠景のきらつきを消しつつ、光の道を正しく伸ばす。robust の Toksvig を置き換える。
- [fidelity] 水中の内散乱を閉形式にする：S = σs·p·E0·(1−exp(−(σt+Kd·sinα)L))/(σt+Kd·sinα)。水面の hit 距離の mip で、近いほど鋭く遠いほどぼける反射（lod = log2(1 + α·hit/(d+hit)·res·0.5)）。
- [fidelity] 霧の分割規則：ngVolEnd で区間を分け、反射・プローブ・影・焼き込みのパスでは解析の霧で全区間を担当する。フロクセルは high の任意機能として後から入れる。入れても受け口は同じ ngApplyMedium のまま。
- [fidelity] 組込みマテリアルのパッチでは、lights_fragment_begin の getDirectionalLightInfo の直後に '#if UNROLLED_LOOP_INDEX == 0' で遠景の影と雲の影を掛ける。r180 のチャンクで動くことを確認済み。キャラクターも杉の木陰で暗くなる。robust は near map に頼っているので、ここを強化する。
- [fidelity] 撮影と検証の仕組み：'nan' のデバッグ表示と nanCheck()、view=csmAtlas/refl/refr/caustics などの切り替え、故障の注入テスト（各モジュールの gpu() に throw を入れる）、GPU と CPU の水面高さを 64 点で読み戻して比べる数値テスト（深場 < 1mm）。
- [fidelity] 露出は EV100 の純関数の表に pre-exposure を掛ける。太陽円盤は FP16 の溢れを防ぐため 30000 でクランプする。空のバンディングはブルーノイズの ±0.5 LSB ディザで消す。
- [fidelity] 雲の移動量を game clock の純関数にして MP で一致させる。16 フレーム償却のパノラマは、反射・プローブ・Snell の窓の全員が同じものを引く（high の任意機能）。
- [art] palette.js の色彩バイブル（アルベドの範囲、照度の単位）と、全 lab 共通のグレー球・クロム球・24 パッチのチャート、false color 表示。
- [art] art-metrics.mjs：PNG から自動で合否を出す。中間の輝度の帯、白飛び・黒つぶれの割合、水平視の水と空の輝度比 0.35〜0.75、noon-fp-down の色相 160〜200°、5:00〜7:00 の露出の単調性、空のバンディングの検出。
- [art] 生態に沿った配置：植林のスギ・ヒノキを 100〜300m の四角い区画に、汀線 0〜12m にヤナギとハンノキ、緩斜面にブナ・ミズナラ・カエデ、標高 90m 超にアカマツと露岩。遠景の色の塊だけで「日本の山の湖」と読めるようにする。
- [art] 灯籠の光が水面に縦長の帯として映ること、夜の zenith が #0b1426 付近であることを、lab の合格条件に明記する。
- [robust] 地平線の自動整合（8 方位で ngInscatterAmb を解き、3km 先の霧の色を空に一致させる）。Phase −1 の fixture 記録。?ng=-trees のようなモジュール単位の無効化による切り分け。obstacle ハッシュを MP でログに出すこと。

## mustFix
- [robust] ShaderChunk.fog_* をグローバルに差し替えると、ngFrame を持たない ShaderMaterial（fog:true）も ngApplyMedium を呼ぶ。その uniform はゼロのままなので、H=0 の割り算で NaN や黒が出る。#ifdef NG_FRAME（ShaderLib の注入と ngShaderMaterial のときだけ define する）で守るか、H と β に max(ε) を入れる。
- [robust] game.js の antialias: q !== 'low' を残すと、既定のフレームバッファが MSAA 4× になる。1440p で約 60MB と、無駄な resolve が増える。最終パスは全画面の描画なので、antialias:false の 1 行を許可リストに入れる（fidelity と同じ）。
- [robust] 4× MSAA の RGBA16F RT に 2 回描くと、ANGLE/Metal ではパスの境目で MSAA の store/load が起きる（1440p で約 118MB の往復）。resolve の予算 0.35ms は過小。lab で実測し、閾値を超えたら 2×＋SMAA に落とす判定を core に入れる。
- [robust] 遅い物体の走査（visible=false で隠す）は、game が同じフレームで書く visible を上書きする。退避と復元を必ず対にする。あるいは layers だけで分離する（layer 0 を外すと raycast に影響するので、レイキャスト対象かどうかを確認してから）。反射パスのマスクに 0 が入っているので、マーカーが鏡像に写る点も直す。
- [robust] 水面の反射がない low は、見た目の生命線を失う（art の指摘）。low でも 0.25×、隔フレームの平面反射を地形・インポスター・桟橋・人物だけで出すか、プローブを 256 以上にする。
- [robust] 遠景の影は 3 秒ごとの別マップを 2 秒でクロスフェードする。ゲーム内で 1 分に太陽は 0.25° 動くので、影の縁が滑って見える。更新の周期と太陽の移動量の上限を検証する。
- [robust] FAR_GATE_NG = 12m は、旧コードの FAR_GATE（TREE_LOD_DIST の最後 + TREE_FADE_BAND + 12、品質に依存）と異なる。当たりを持つ木の範囲を、旧 high の値に固定した定数として明記し、テストに入れる。
- [fidelity] TAAU に速度バッファが無い。風で揺れる植生、魚の頂点アニメ、スキニング、竿、糸がすべてゴーストする。ng マテリアルは前フレームの位置（ngPrevViewProj＋前フレームの風の時刻）で RG16F の velocity を MRT に書く。組込みは reactive の扱いにする。マーカー・糸・名札・debug（LATE）は TAAU の後に出力解像度で描く。
- [fidelity] 水のサンプラーを数えると、REFR、LZ、refl、probe、FFT 配列、ripple、skyView、cloudPano、transLut、CSM、地形影、雲影、froxel、heightNear、heightFar、shoreSDF、wind、blueNoise、foam で 19 になり、16 を超える。transLut は uniform に、depth と shoal は SDF の別チャンネルか頂点の varying に、blue noise は IGN にまとめる。lint の表を実数で作り直す。
- [fidelity] GPU 予算が 14ms に収まっていない。モジュールで 11.7ms、ほかに core の CSM（森の LOD1 1600 本と 4 カスケード）、キャラクター 1ms、反射パスの森がある。core の影の予算を明記する。high の既定は、フロクセルなし・PCSS なしの構成から始めて、実測で足す順序に改める。
- [fidelity] Core のフェーズが 2 人・2〜3 日では非現実的。CSM、TAAU の骨組み、auditor、heightfield Worker、instancing、clipmap、lab をすべて含む。TAAU とフロクセルの実装は M9／M2 に移し、core にはスタブの受け口だけを置く。
- [fidelity] P10 の copyFramebufferToTexture で RGBA16F を読むには EXT_color_buffer_float の拡張経路が必要。全画面の copy パスか blitFramebuffer にし、mip 生成と同時に済ませる。
- [fidelity] sun.castShadow=false に CSM の RT を shadow.map に差す方式は、契約の「影を落とす DirectionalLight」とずれる。settings.shadow の切り替えで shadowMapEnabled が変わると組込みが再コンパイルされる点も含め、perf-test と walk の文字列テストが通ることを確認する。
- [fidelity] 投影のジッタは描画の後に必ず元へ戻す。game の aimMarker の投影やレイキャストがジッタの入った projectionMatrix を読まないようにする。
- [art] 高さ場が R16F（±256m）。32〜64m の標高では量子化が約 3cm、64m 超では約 6cm になり、草・小石・葦の根元が浮いたり沈んだりする。R32F と texelFetch の手動バイリニアにする。
- [art] 地形の内側の帯が 1m 格子の静的メッシュ。斜面の線形補間の誤差が、合格条件の 2cm を超える。歩ける帯は 0.5m 以下にするか、R32F の VTF を使うクリップマップ／CDLOD にする。
- [art] 草が high で 120k 株 × 8〜16 枚 × 5 頂点 = 6〜9.6M 頂点になり、1.3ms では描けない。25〜30k 株、45m 程度に落とす。ヨシの 50k 本も同様に削る。
- [art] rocksprops と underwater が terrain.underwaterProps.group に実物（ストラクチャー、泡、マリンスノー）を入れている。game.js:1606 が水上の main パスでこの group を visible=false にするので、単一パスの屈折では沈み岩と立ち枯れが見えなくなる。group は空のダミーにし、実物は専用のレイヤーに置く。
- [art] 太陽の軌道（緯度 36°、南中 54°、6:00 の日の出）を旧式から変えている。nightAmount・keyDir・updateLamp・audio.setNight の時刻が変わる。変えるなら fishing と MP で夜の判定を使っていないことをテストで示し、変えないなら旧式を移植する。
- [art] interfaces に書いた surfaceY の式が「waveHeight × shoalGain × wind」になっている。JS の waveHeight は内部で wind を掛けるので、wind が二重になる。GPU は ngWaveH(p,t)·wind、CPU は waveHeight(x,z,t,wind)·shoalGain と明記する。
- [art] 既定のフレームバッファの antialias を残したまま、sceneRT でも MSAA×4 を使っている（二重の MSAA）。core API のステージ、pass ID、サンプラーの予算表も無い。registerModule の pre/late だけでは、9 人が並行して組むのに足りない。

## advice
robust を骨格にする。理由は四つ：game.js の呼び出し順にそのまま乗る、ShaderLib の ngFrame を参照で共有する、影の更新が 1 か所、Phase −1 で旧コードの振る舞いを fixture に固定する。そのうえで、fidelity の水と大気の品質を「予算を実測してから足す」段階制で入れる。

(1) core は robust の ngFrame、layers、FramePipeline、NgModule、guard を採用する。fog チャンクの差し替えは #ifdef NG_FRAME で守る。組込みのパッチでは、fidelity の UNROLLED_LOOP_INDEX==0 のアンカーを使い、遠景の影と雲の影を追加する。サンプラーは組込みで 4 つまで、ng で 12 以下にし、lint で数える。

(2) 描画は単一パスにする：opaque → copy → late。AA は MSAA 4×（high）/SMAA/FXAA を既定にし、TAAU は M9 の任意機能として後から試す。試すなら velocity MRT を必須にし、LATE（マーカー・糸・名札・debug）は TAAU の後に描く。antialias:false を game.js の許可リストに入れる。

(3) 水には fidelity の技法を入れる。high だけ波動方程式の波紋シミュ（mid/low は robust のスプラット）、LEAN の粗さ、閉形式の内散乱、hit 距離の mip で鋭さが変わる反射。FFT は、周期の焼き込み（robust）を low/mid に使い、ライブの FFT は high の任意機能にする。どの品質でも平面反射を残す（low は 0.25×、隔フレーム）。

(4) 大気は robust の解析媒質を基本にする。fidelity の ngVolEnd の分割規則を最初から API に入れておき、high のフロクセルは予算に余裕があるときだけ有効にする。robust の地平線の自動整合と、EV の pre-exposure の表を併用する。

(5) 配置は art の生態の規則（植林の区画、汀線の樹種、尾根のアカマツ）を、robust の決定的な格子 rng と rank の入れ子に載せる。FAR_GATE は旧 high の値に固定する。

(6) 品質の保証として、art の palette.js、グレーカードとチャート、art-metrics.mjs を全 lab の合格条件にする。fidelity の nanCheck と故障注入、robust の perf-matrix と sampler-audit を CI に入れる。

(7) 予算は、high 1440p の合計 14ms（キャラクター 1.2ms と core の影を含む）の表を core の担当が持つ。任意機能（フロクセル、ライブ FFT、PCSS、TAAU）は、実測の余裕に応じて足す順序を決めておく。
