# 湖畔 NextGen Environment — "One Light, One Medium, One Frame": a robust, budgeted, 9-module rebuild on three r180 / WebGL2

## philosophy
1) Everything in the world, including the untouched built-in MeshStandardMaterial characters, is lit by one fixed light rig (a key DirectionalLight that is the sun by day and the moon by night, one SH LightProbe, one lamp PointLight). Everything is also seen through one participating-medium function, ngApplyMedium(), which models air (Rayleigh, Mie and a ground-mist layer) and water (Beer-Lambert absorption plus in-scatter). A global fog-chunk patch injects that function into every fog-enabled program, so fish, angler, lakebed and mountains can never disagree about fog, depth colour or underwater light. 2) All shared per-frame state lives in one Float32Array (ngFrame, 20 vec4). It is added by reference to every built-in ShaderLib entry, and every custom material gets it the same way, so the core is a data layout, not a web of callbacks. 3) The scene is drawn once. There is no second 'capture' render: the opaque pass is copied, and the water, which is the hero, is composited over it with refraction, planar reflection, detail normals, ripples and foam. Underwater absorption is applied exactly once, at the fragment of the object that is seen. 4) Gameplay truth (heights, placement, collision, waves) is three-free, seeded, independent of quality tier and covered by Node tests. Visuals are strictly downstream of that data. 5) Every module has a hard GPU budget per tier, a lab page, a grey-box stub, a guarded update and a fallback, so one broken module turns itself off and never breaks a frame or multiplayer sync. 6) We prefer techniques whose cost is fixed and predictable: CDLOD with vertex texture fetch, periodic pre-baked FFT normals instead of a live simulation, analytic ring splats instead of a ripple PDE, analytic aerial perspective instead of froxels, and a scripted exposure curve instead of a histogram. Quality then comes from careful maths and dense, well-filtered content rather than fragile screen-space tricks. 7) Nothing is downloaded. Textures are forged on the GPU at load in about 0.3 s. Only tree geometry is baked offline by our own deterministic Node scripts (committed, ≤3 MB). 8) Parallel work is made safe by strict file ownership: core and facades belong to the core agents, each src/gfx/<module>/ belongs to exactly one agent, and ngFrame, layers, pass ids and GLSL names are frozen at gate G0.

## pipeline
COLOUR, UNITS AND EXPOSURE
- The whole scene is linear HDR in RGBA16F. renderer.toneMapping = NoToneMapping and outputColorSpace = SRGB. The single tone map (AgX) and the single sRGB encode happen in the last post pass. Every custom shader writes linear, and water.uniforms.uLinearOut / skyUniforms.uLinearOut are held at 1 by PostFX.
- ng radiometric units:
  - Key-light irradiance at clear noon is 3.0 (the value set on DirectionalLight.intensity).
  - SH sky irradiance at noon is about 0.9.
  - Moon irradiance is 0.012 and night sky irradiance is 0.004.
  - Reference albedos, linear: grass 0.10–0.16, cedar foliage 0.05–0.08, wet dark wood 0.04, sand 0.25–0.35, granite 0.18–0.25, water F0 0.02.
- Exposure is a pure function, ngExposure(sunAltDeg, cloud, rain, uwStrength, uwDepth), owned by the post module:
  - by sun altitude: ≥25° → 1.0, 10° → 1.15, 3° → 1.5, 0° → 2.1, −4° → 3.6, −8° → 7, −12° → 14, ≤−15° → 22
  - × (1 + 0.5·cloud) × (1 + 0.3·rain)
  - underwater × min(3, 1.3 + 0.08·depth)
  - Only the underwater factor is damped (λ = 1.5/s). The rest is instant, so multiplayer peers and screenshots agree.

RENDER TARGETS (high tier at 2560×1440 physical; s = dynamic-resolution scale, 0.7–1.0)
- mainRT: RGBA16F at W·s × H·s. samples = 4 on high (0 on mid/low). DepthTexture (UnsignedInt 24-bit) with resolveDepthBuffer = true.
- sceneColor: RGBA16F. Full resolution on high/mid, half on low. Four mips on high, used for rough refraction and underwater blur.
- sceneDepthLin: R32F linear view depth, full resolution, Nearest filtering. Falls back to R16F if EXT_color_buffer_float is missing.
- reflRT: RGBA16F at 0.6× on high and 0.5× on mid, 5 mips, depth renderbuffer, no MSAA. None on low.
- rippleNear: RGBA16F 512², 64 m window around the camera, 12.5 cm per texel.
- rippleFar: RGBA16F 512², 256 m window, 50 cm per texel. It covers the bobber up to the 84 m maximum cast. Low has only the far cascade, at 256².
  - Channel layout for both: R, G = surface slope dh/dx, dh/dz; B = foam; A = spare.
- nearShadow: three-managed map on env.sun. 3072² / 2048² / 1024².
- farShadow: two DepthTextures (compareFunction LessEqual) at 2048² on high, 1024² on mid, none on low. Ping-pong pair.
- probeCube: RGBA16F cube, 256 on low (main reflection source there), 128 on mid (fallback only).
- Sky LUTs:
  - skyView: RGBA16F 256×128, with mips
  - transmittance: 256×64
  - multi-scatter: 32²
  - cloudRT: RGBA16F at half resolution (colour + transmittance)
- Post: two RGBA8 full-res LDR buffers, pmndrs bloom mips, a half-res RGBA16F buffer for underwater shafts, a quarter-res RGBA8 buffer for sun shafts.

FRAME ORDER
game.js keeps its existing call order unchanged: water.capture → captureReflection → getUnderwaterContext → postfx.updateUnderwater → postfx.render.

0. CPU update, in game.update in the existing order.
   - env.update runs the sky producer. It writes the ngFrame slots for key light, sun, atmosphere and cloud shadow. It fits the near-shadow camera: texel-snapped, centred on focusPos, extent ±48 m, near 0.5, far 1500 so that low-sun mountain casters are included. It modulates key-light intensity by the CPU cloud-shadow value and the LightProbe by the canopy occlusion, both sampled at the focus point.
   - water.update: time += sdt; wind = 1 + rain·0.92 + cloud·0.14; causticsUniforms dynamic fields; ripple and splash spawns.
   - terrain.updateTrees: CDLOD quadtree select and tree/flora instance compaction, run only when the camera has moved more than 2 m or turned more than 5°, or 0.25 s has passed.
1. water.capture() → pipeline.prepare(). Idempotent per frame; if the game skipped it, postfx.render calls it.
   a. farShadow slice: every 3 s (high) or 4 s (mid), the back map is rendered in 4 scissor quadrants over 4 consecutive frames. Casters: coarse terrain, canopy shell, impostors and big boulders, 2048² over ±512 m. After the fourth quadrant the maps swap and a 2 s crossfade uniform runs. Cost is at most 0.3 ms in any one frame.
   b. Ripple splat: instanced ring quads (pool of 128) and splash foam decals are drawn additively into rippleNear and rippleFar after a clear. The ring profile is analytic: h(r,t) = A·e^(−t/τ)·sin(k(r−ct))·e^(−((r−ct)/w)²), and the splat stores its gradient. About 0.08 ms.
   c. Sky LUT update: skyView every frame (0.05 ms). Transmittance and multi-scatter only when the haze parameters change by more than 2%.
   d. probeCube: one face per frame every 20 s, layers NG_FAR + sky only. Used on low, and as fallback on mid.
   e. renderer.shadowMap.autoUpdate stays false. prepare() sets needsUpdate = true exactly once, immediately before the first scene render of the frame. That is the single, explicit shadow update point. sun.shadow.camera.layers is set to mask 0|1|7|8.
2. water.captureReflection() → pipeline.renderReflection(). Skipped on low and while uwStrength > 0.5.
   - A mirror camera about y = 0 with an oblique near plane at y = −0.03 (Reflector-style projection maths, re-implemented in core).
   - camera.layers = DEFAULT|WORLD|FAR. The game's setReflectionHidden list is toggled invisible.
   - ngFrame pass id = 1. Vegetation takes cheap branches and tree LODs are biased by 2×.
   - Target reflRT, then generate mips.
   - The near shadow map is rendered during this call and reused by every later pass.
3. postfx.render(dt) → pipeline.renderMain() followed by the post chain.
   A. Opaque call into mainRT.
      - camera.layers = DEFAULT|WORLD|NO_REFLECT|UNDERWATER|FAR; ngFrame pass id = 0.
      - Before the call, the pipeline's late-object scan hides every non-ng object that has material.transparent, depthTest === false or renderOrder ≥ 5. The scan is a scene.traverse of about 500 nodes per frame (about 20 µs) and covers markers, the line ribbon, bobber ring, name labels and debug.
      - Contents: terrain (including the lakebed), trees, ground cover, reeds, lily pads, weeds, rocks, dock, characters and fish (above and below water, which is how refraction contains characters), and the sky.
      - The sky is drawn last among opaques as a full-screen triangle at depth 1 with depthFunc LEQUAL, which saves fill.
      - The MSAA resolve (colour and depth) happens when the target changes.
   B. Copy pass: one full-screen triangle reads mainRT.texture and mainRT.depthTexture (neither is bound for writing) and writes sceneColor (with mips on high) and sceneDepthLin. 0.15 ms on high.
   C. Late call into mainRT (MSAA storage persists).
      - camera.layers = WATER|LATE_FX|LATE. Late game objects are tagged with layers.enable(NG_LATE). Layer 0 is kept, so raycasts are unaffected.
      - The water surface is drawn first (renderOrder 1, NoBlending, depthWrite true). It samples sceneColor, sceneDepthLin, reflRT/probe, the ripple cascades, the three shadow map (lights: true) and farShadow.
      - Then particles and rain (soft, using sceneDepthLin), mist sheets, splashes, fireflies and plankton.
      - Then game transparents in their own renderOrder (ripple 3, line 5, markers/rings 6, labels 7, debug 900 with depthTest false).
      - Second resolve.
   D. Post chain (post module) into the LDR buffers and then the screen:
      - [ExposureEffect: NaN/Inf kill, then × exposure]
      - [UnderwaterEffect: only when uwStrength > 0; provided by the underwater module]
      - [Bloom: pmndrs mipmap, threshold 1.0 after exposure, 8 levels high / 5 mid / off low]
      - [SunShafts: quarter res, only when the sun/moon is within 1.3× of the screen and altitude < 25°]
      - [Grade: white balance, lift/gamma/gain, saturation, Purkinje night shift, vignette]
      - [ToneMapping AGX]
      - [dither 1/255]
      - Then a separate pass: SMAA (mid) or FXAA (low). High relies on MSAA plus alphaToCoverage.
      - The dynamic-resolution upscale (bilinear plus a light CAS-style sharpen) happens in the grade pass.

UNDERWATER PATH (camera below the surface, uwStrength from water.getUnderwaterContext)
- The reflection pass is skipped, and its 1.8 ms is re-spent on underwater post.
- The opaque call is unchanged. ngApplyMedium sees ngCam.x > 0.5 and applies water absorption and in-scatter along camera→point for underwater points. For above-water points it applies only the air segment, surface→point.
- The water surface is drawn with gl_FrontFacing false:
  - Snell's window: n = 1.333, critical angle 48.6°.
  - Inside the window it refracts sceneColor, which is already air-fogged.
  - Outside the window it shows total internal reflection, made of the water in-scatter colour, a 0.35× mirrored-bed tint and ripple shimmer.
  - The water medium from camera to surface is applied to the whole surface fragment.
- The UnderwaterEffect adds:
  - Volumetric shafts: half res, 16 (high) or 8 (mid) steps. Each step samples the caustic shaft pattern projected along the refracted sun direction and multiplies by the near shadow map, so the dock, boat and angler cut the shafts.
  - Depth-based mip blur of sceneColor.
  - A waterline meniscus and split view, computed per pixel by testing the near-plane point against ngWaveH at the camera.
- Plankton (layer UNDERWATER, late FX) is visible only here.

MEDIUM RULES (each path segment is applied exactly once)

| Camera | Point | Where the medium is applied |
| --- | --- | --- |
| above water | above water | air, in the fog chunk |
| above water | below water | air (camera→surface entry) + water (entry→point) + downwelling attenuation exp(−σd·depth/cosθsun,w), all in the fog chunk. The water surface shader then adds no absorption; it only mixes F·reflection + (1−F)·refraction and applies T_air to its own specular and foam. |
| any, reflection pass (pass id 1) | any | whole path treated as air. The mirror-camera distance equals the real path length. |
| below water | below water | water, in the fog chunk |
| below water | above water | air segment only in the fog chunk; the water segment is applied by the underside shader |

RATES
- Every frame: shadows, reflection (mid and high), sky, clouds, ripples, water, post.
- Far shadow: every 3–4 s in slices.
- probeCube: every 20 s, one face per frame.
- SH probe: every 0.25 s (CPU).
- Instance compaction: on movement, or at 4 Hz.
- CDLOD selection: every frame, 0.1 ms.

DRAW-CALL CAPS (high): main ≤ 350, reflection ≤ 150, near shadow ≤ 150, far-shadow slice ≤ 60. CPU submission ≤ 3.5 ms per frame.

## core
OWNERSHIP
- Core-A (render core) owns src/gfx/core/**, the facades src/postfx.js and src/shaders.js, lab/_kit and scripts/gfx/*.
- Core-B (world core) owns src/world/** (three-free), the facades src/terrain.js, src/water.js and src/sky.js, the heightfield workers and the tests.
- Everything below is frozen at gate G0. Changes after G0 go through a core-change request to the Core-A/B owners.

1) INSTALL AND GLOBAL CHUNK PATCH — src/gfx/core/chunks.js
   export function installNg(THREE) is idempotent and is called at import time of src/gfx/core/index.js. sky.js imports it, so it runs before any material compiles.
   - export const ngFrameData = new Float32Array(4*20)
     - Every ShaderLib entry that has fogColor (basic, lambert, phong, standard, physical, toon, matcap, points, dashed, sprite) gets ShaderLib[k].uniforms.ngFrame = { value: ngFrameData }.
     - Verified in the vendored r180: cloneUniforms() copies Float32Array values by reference, because they are neither Array nor isVector. All built-in programs, including fish after their onBeforeCompile, therefore share this one array.
     - Samplers cannot be shared this way (cloneUniforms nulls render-target textures), so built-ins get analytic functions only.
   - ShaderChunk.fog_pars_vertex += 'varying vec3 vNgWorld;'
   - ShaderChunk.fog_vertex += 'vNgWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;'
     - This works for instancing, points, sprites and the mirrored reflection camera, since the rotation is orthonormal.
   - ShaderChunk.fog_pars_fragment is replaced with NG_FRAME_GLSL plus NG_MEDIUM_GLSL, keeping the original uniforms: fogColor, fogNear, fogFar, vFogDepth.
   - ShaderChunk.fog_fragment → '#ifdef USE_FOG gl_FragColor.rgb = ngApplyMedium(gl_FragColor.rgb, vNgWorld); #endif'
   - Boot self-check: compile a MeshStandardMaterial and assert renderer.properties.get(m).uniforms.ngFrame.value === ngFrameData. If it fails, restore the original chunks and set core.degraded = 'fog', so the game falls back to plain THREE.Fog.
   - Rule: global chunks declare only ng-prefixed identifiers. They never declare uCaust*, causticLight, cs* or csWave*.

2) ngFrame LAYOUT — src/gfx/core/frame.js
   export const NG = { KEY:0, KEYRAD:1, SUN:2, AMB:3, BETA_R:4, BETA_M:5, MIST:6, INSC:7, CAM:8, W_SIGMA:9, W_INSC:10, WIND:11, WEATHER:12, CLOUDSH:13, TIME:14, FOCUS:15, EXPO:16 /*17-19 reserved*/ }
   The GLSL #defines are generated from this same table, e.g. '#define ngKeyDir ngFrame[0].xyz', so JS and GLSL cannot drift apart.

   | Slot | Contents | Producer |
   | --- | --- | --- |
   | 0 | key dir, w = nightAmount | sky |
   | 1 | key radiance at ground (cloud-dimmed), w = sin(sunAlt) | sky |
   | 2 | sun dir (always the sun), w = moon illumination | sky |
   | 3 | SH0 sky irradiance/π, w = cloudiness | sky |
   | 4 | βR (1/m) × fog scale, w = H_R | sky |
   | 5 | βM, w = H_M | sky |
   | 6 | mist density (1/m), base y, scale height, Mie g | sky |
   | 7 | ambient in-scatter radiance, w = mist ambient boost | sky |
   | 8 | x uwStrength, y waterY at camera, z camera height above water, w pass id (0 main, 1 reflection, 2 near shadow, 3 far shadow, 4 bake, 5 probe) | core |
   | 9 | σa rgb, w = σs | underwater |
   | 10 | water in-scatter radiance rgb, w = turbidity | underwater |
   | 11 | wind dir.xy, speed (m/s), gust amplitude | core wind |
   | 12 | wetness, rain, puddle, reserved | sky |
   | 13 | cloud-shadow offset.xy, 1/scale, strength | sky |
   | 14 | hour, water.time, envTime (pause-aware), frameIndex % 1024 | core |
   | 15 | focus xyz, lodScale | core |
   | 16 | exposure, 1/exposure | post |

   class NgFrame { data; set(slot, x, y, z, w); setVec3(slot, v, w); beginPass(passId, camera) /* rewrites slot 8 before every renderer.render; three re-uploads because _currentMaterialId resets per render() and the values differ */ }

3) MEDIUM MODEL — src/gfx/core/glsl/medium.glsl.js, with a JS twin in medium.js for tests and CPU fog near/far
   vec3 ngApplyMedium(vec3 L, vec3 P)
   void ngMediumTerms(vec3 P, out vec3 T, out vec3 Lin)
   float ngAirOpticalDepth(vec3 a, vec3 b, float beta, float H)
   - Height-exponential closed form: τ = β·H·(e^(−ya/H) − e^(−yb/H))·|b−a|/(yb−ya), falling back to β·e^(−ya/H)·|b−a| when |Δy| < 1e−3.
   - Air in-scatter:
     Lin = Σ_{i∈R,M,mist} (τ_i/τ)(1−e^(−τ))·(E_key·P_i(μ) + A)
     where P_R = 3/(16π)(1+μ²), P_M = Henyey-Greenstein(g), and A = ngInscatterAmb.
   - Water: T_w = e^(−(σa+σs)·L_w); Lin_w = (1−T_w)·ngWaterInsc·e^(−σd·ȳ_depth) with σd = σa + 0.3σs; downwelling light on underwater points is exp(−σd·depth/cosθ_sun,w).
   - Default water coefficients: σa = (0.20, 0.075, 0.045)/m and σs = 0.03, giving the contracted 26–70 m visibility.
   - The rules for segment splitting are the MEDIUM RULES in the pipeline section.
   - About 45 ALU. No textures, so it is legal in built-in programs.
   - The CPU twin computes scene.fog.near and .far (distances where T = 0.98 and T = 0.02) every frame, so debug.js:462 keeps working.

4) MATERIAL EXTENSION — src/gfx/core/extend.js
   ngExtendStandard(mat /*MeshStandardMaterial|MeshPhysicalMaterial*/, spec) → mat
   spec = {
     key,
     uniforms,   // shared {value} refs, merged in onBeforeCompile
     defines,
     vertex:   { pars, begin /*after begin_vertex: edit transformed*/, normal /*after beginnormal_vertex*/, world /*after worldpos_vertex*/ },
     fragment: { pars, surface /*after map_fragment*/, alpha, normal /*after normal_fragment_maps*/, rough /*after roughnessmap_fragment*/, ao /*after aomap_fragment*/, emissive /*after emissivemap_fragment*/, lights /*after lights_fragment_end: may add reflectedLight terms (translucency, sky specular)*/ },
     caustics: true,  // injects CAUSTICS_GLSL once, like fish, and adds causticLight(vWorld, normal) × ngSunVis
     depth: true      // also builds customDepthMaterial and customDistanceMaterial (MeshDepthMaterial + the same vertex spec + alpha test)
   }
   - customProgramCacheKey = 'ng:' + key + ':' + tier.
   - The anchors are asserted in a Node test against the vendored ShaderChunk. At runtime a missing anchor throws at build time (never per frame), and the facade swaps in the module's stub.
   ngShaderMaterial(opts) → ShaderMaterial with lights:true and fog:true. It includes the three light, shadow and fog chunks plus ngFrame. Used by water, sky and particles, which then receive shadows through three's own getShadow().
   Sampler budget: ≤ 12 fragment and ≤ 4 vertex samplers per program. Verified in the lab by reading gl.getActiveUniform on every program.

5) LAYERS — src/gfx/core/layers.js
   NG_LAYER = { DEFAULT:0, WORLD:1, NO_REFLECT:2, UNDERWATER:3, WATER:4, LATE_FX:5, LATE:6, FAR:7, SHADOW_ONLY:8 }

   | Mask | Layers |
   | --- | --- |
   | opaque | 0,1,2,3,7 |
   | reflection | 0,1,7 |
   | late | 4,5,6 |
   | shadow | 0,1,7,8 |
   | probe | 7 + sky |

6) PIPELINE — src/gfx/core/pipeline.js
   class FramePipeline {
     constructor(renderer, scene, camera, { frame, shadows, quality })
     prepare()
     renderReflection()
     renderMain(dt, post)
     addPreparer(id, fn, budgetMs)
     setSize(w,h)
     setQuality(q)
     setRenderScale(s)
     uniforms: { ngSceneColor, ngSceneDepth, ngReflection, ngReflValid, ngProbe, ngRippleNear, ngRippleFar, ngRippleNearXform, ngRippleFarXform, ngFarShadow0, ngFarShadow1, ngFarShadowMat0, ngFarShadowMat1, ngFarShadowFade, ngScreen }
     // stable {value} objects; RT swaps on resize only change .value
     state: { frameIndex, underwater, reflectionEnabled }
   }
   - Every pass runs through guardPass(id, fn). A thrown pass is logged once. After 2 failures in 60 frames it is disabled for the session and the frame continues; the pipeline never rethrows.
   - webglcontextlost: preventDefault and suspend rendering (the render calls become no-ops). webglcontextrestored: modules' restoreGPU().

7) SHADOWS — src/gfx/core/shadows.js
   NearShadow.configure(sun, tier)
   - DirectionalLight.shadow sizes 1024/2048/3072, ortho extent ±30/±40/±48 m, PCFShadowMap with radius 1.5–2.
   - bias −0.0004, normalBias 0.04.
   - shadow.intensity follows cloudiness: 1 → 0.35.
   - Texel snapping: project focusPos into light space and floor to texel size.
   FarShadow
   - Owns the two maps.
   - GLSL: float ngFarShadow(vec3 P) does 4-tap hardware PCF with fade.
   - GLSL: float ngSunVisibility(vec3 P, float nearVis) blends near to far between 0.8R and R and multiplies by ngCloudShadow(P).
   - Only custom and extended materials use far shadow. Built-in characters are always inside the near map.

8) WIND — src/gfx/core/wind.js, with GLSL wind.glsl.js
   - Wind.update(hour, weather): base direction φ(hour, weatherKey) and speed 0.6/2.2/4.5 m/s for clear/cloudy/rain. Pure function of time and weather.
   - Wind.sample(x, z, t) → { dx, dz, speed, gust }
   - vec4 ngWindAt(vec2 xz): gust is two octaves of value noise at 38 m and 13 m, advected downwind at 3 m/s·speedFactor. It produces cat's-paw patches on the water and rolling waves through grass.
   - Hashes are Dave-Hoskins-style float hashes, avoiding uint-hash driver risk. The JS twin uses the same maths (visual use only).

9) WORLD DATA — src/gfx/core/world/heightfield.js (GPU side) and src/world/heightgrid.js (three-free)
   HeightField.build(lake, { workers }) samples lake.heightAt in 4 module workers. Measured cost is 0.45 µs per call, so about 0.25 s wall time.
   - near grid: 1040² at 0.5 m over ±260 m (covers shore + 72 m, up to 244 m)
   - far grid: 1024² at 1 m over ±512 m
   - bed map: 2 m cells, from bedAt
   Textures:
   - ngHeightNear, ngHeightFar: R32F, Nearest; bilinear filtering done by hand in the shader
   - ngNormalNear: RGBA8 octahedral, computed on the GPU
   - ngShoreDist: R16F signed distance to the waterline, jump flood on the GPU, 1024²
   - ngBedMap: RGBA8 mud/sand/rock weights plus v
   - ngCanopy: RG8 density and height, splatted from placement
   GLSL: float ngTerrainH(vec2), float ngDepth(vec2), vec3 ngTerrainN(vec2), float ngShoreD(vec2).
   JS: sampleGrid(x, z) uses the same bilinear as the GPU, for tests.

10) WAVES
   waveField.js is kept byte-identical and is the single source. GPU code uses waveGLSL({prefix:'ng'}), which emits ngWavePhase, ngWaveD, ngWaveH, ngWaveDisp, ngShoreRunUp and ngShoalGain.
   Visual displacement = vec3(0, ngWaveH(p, t)·wind·ngShoalGain(depth), 0) with vertical displacement only, so the rendered surface equals CPU surfaceY.

11) TEXTURE FORGE — src/gfx/core/forge.js
   forge.bake2D({ w, h, type, format, frag, uniforms, mips, coverageAlpha /*ref 0.5: rescale alpha per mip to preserve coverage*/ })
   forge.bakeArray({ w, h, layers, frag /*uses ngLayer*/ })   // WebGLArrayRenderTarget; setRenderTarget(rt, layer)
   forge.bake3D(...)
   forge.renderView(rt, layer, scene, camera)                  // impostor capture
   forge.releaseScratch()
   Shared GLSL library (glsl/noise.glsl.js): ngHash12/22/33, ngVNoise2/3, ngGNoise2, ngWorley2/3, ngFbm, ngRidged, ngWarp, plus tileable (period) variants, ngHexTile (Mikkelsen 2022), ngOct encode/decode, ngBlueNoise(frag, frameIndex) from a 64² forge-baked texture.

12) SHARED SURFACE HELPERS — glsl/surface.glsl.js
   - ngWetSurface(inout albedo, inout rough, porosity, wet): albedo ^= (1 + 1.5·porosity·wet); rough → mix(rough, 0.08, wet)
   - ngPuddle(xz, slope)
   - ngRainRings(xz, t, rain) → vec2 slope: 3 hashed cell layers at 0.35/0.6/1.1 m, one expanding ring per cell per 0.9 s. Shared by the water, dock puddles and rocks.
   - ngCloudShadow(P) (analytic, matching the sky's CPU twin)
   - ngSkySpecular(R, rough): skyView LUT with mip by roughness. Used for sky specular on custom and extended materials. Built-ins get no environment map, which keeps the angler as tuned.

13) QUALITY — src/gfx/core/quality.js
   - Global profile table: pixel ratio, DRS range, MSAA, shadow, reflection, copy resolution, far shadow.
   - Each module owns src/gfx/<m>/quality.js with its own tier table.
   - onQuality(fn). setQuality may rebuild instance subsets and set defines; it never changes light count or castShadow, and never uses multi-material meshes, because applyQuality's needsUpdate traverse does not handle material arrays.
   DRS (post/drs.js, disabled when window.__gfxCapture is set)
   - Scale down 0.05 when the 2 s p90 frame time exceeds 17.2 ms.
   - Scale up 0.05 when it stays below 14 ms for 5 s.
   - Range 0.7–1.0 on high, 0.75–1.0 on mid, 0.6–1.0 on low.

14) GUARDS AND BUDGET — src/gfx/core/safe.js, src/gfx/core/budget.js
   - guard(module, method, ...args): a thrown update disables the module (its root group becomes invisible) after 3 strikes and logs a rate-limited warning.
   - Programs are checked through renderer.debug.onShaderError. A failed program sets a flag and the module swaps to its fallback material (MeshLambertMaterial) on the next frame.
   - Budget.tag(passId|module): uses GPU timer queries when EXT_disjoint_timer_query_webgl2 exists (lab), and CPU otherwise. The performance.js pass names 'capture', 'reflection' and 'composer' are preserved.

15) MODULE CONTRACT — src/gfx/core/module.js
   class NgModule {
     static id
     constructor(ctx)
     async init(progress)
     update(f)
     beforePass(passId, camera)
     setQuality(q)
     setLodScale(k)
     restoreGPU()
     stats() → { draws, tris, instances, texBytes, programs }
     dispose()
     root: THREE.Group
   }
   ctx = { THREE, renderer, scene, camera, tier, profile, lake, heightfield, placement, frame, wind, pipeline, shadows, forge, workers, caustics, sky /*SkyServices: skyViewTex, transmittanceTex, sampleSky(dir) JS, keyColor*/, budget, log }
   f = { dt, sdt, envTime, waterTime, hour, camera, focus, frameIndex, paused, uw }
   The facades import the fixed module paths src/gfx/<m>/index.js. Core ships a grey-box stub at each path, and module agents replace only their own index.js.

16) LAB HARNESS — src/gfx/core/lab/labkit.js
   Lab.boot({ modules, seed:123456789, tier, size })
   - Builds the real lake, heightfield, placement, pipeline and post, plus the requested modules; stubs fill every other slot.
   - Can instantiate the real Angler, and a FishSchool with 6 fish, so characters appear in module labs.
   - Camera presets: dock-fp, dock-3p, shore-low, aerial60, far-ridge, forest-floor, reed-edge, weedbed-uw, uw-dock, waterline.
   window.__lab = { setHour, setWeather(k,{instant:true}), setTier, cam(preset|{pos,target}), freeze(t), tick(n,dt), view('refl'|'sceneColor'|'depth'|'rippleN'|'rippleF'|'nearShadow'|'farShadow'|'skyView'|'overdraw'), stats() }
   window.__gfxReady is set after renderer.compileAsync completes.
   scripts/gfx/scenarios/lab-matrix.mjs <module> shoots presets × {5:40 dawn mist, 9:00, 12:30, 17:45 golden, 18:55 blue hour, 23:30 moon} × {clear, cloudy, rain} and writes stats JSON.

## modules

### sky (atmosphere producer, sky dome, clouds, stars/moon, light rig)
files: src/gfx/sky/{index.js, SkyModule.js, atmoConstants.js, atmosphere.js (CPU twin), atmosphere.glsl.js, luts.js, skyDome.js, clouds.js, clouds.glsl.js, stars.glsl.js, moon.js, lightRig.js (key light, SH projection, focus modulation), producer.js (ngFrame slots 0-7,12,13), quality.js}; lab/sky.html; scripts/gfx/scenarios/sky-*.mjs. The Environment facade (src/sky.js, with its weather state machine and API) is Core-B's; this module plugs into it.

resp: A physically based sky that is a pure function of hour and weather. The single source of atmosphere coefficients for ngApplyMedium, so the horizon matches the terrain haze. Clouds, including cloud shadows on the ground and water. Stars, Milky Way and a full moon with phase glow. The key DirectionalLight (sun/moon swap) and the SH LightProbe. The dawn-mist and rain-haze parameters. skyUniforms.uStars and .uLinearOut. The env.sky Object3D, and the env.sunColor, zenithColor, horizonColor and fogColor THREE.Color values.

tech: MODEL
- Bruneton/Hillaire constants: Earth radius 6360 km, top 6420 km.
- Rayleigh βR = (5.8, 13.5, 33.1)e-6 per m, H = 8 km.
- Mie βM = 3.996e-6 × haze, where haze is 1 clear / 2.2 cloudy / 4.5 rain, plus a dawn term. H = 1.2 km, g = 0.8.
- Ozone absorption (0.65, 1.88, 0.085)e-6, tent 25±15 km. Ozone is essential for the blue hour.

LUTs
- Transmittance LUT 256×64: rebuilt only when haze changes by more than 2%.
- Multi-scatter LUT 32² (Hillaire psi_ms), rebuilt on the same trigger.
- Sky-view LUT 256×128 every frame: 32-step raymarch, non-linear latitude mapping for horizon detail, mipmapped for ngSkySpecular.

SKY DOME
- A full-screen triangle drawn last in the opaque call. It samples the sky-view LUT.
- Sun disc: 0.53°, with limb darkening.
- Moon disc: 0.52°, with a procedural maria albedo forged at load (512²) and an earthshine-free full phase.
- Stars: cube-face hash cells at 4096 per face equivalent, a magnitude distribution with about 6000 visible, twinkle driven by turbulence, attenuated by transmittance, and removed under clouds.
- Milky Way: a ridged-fbm band.
- In the reflection pass, stars are 1.5× larger to avoid aliasing, and uStars is not zeroed.

CLOUDS (2.5D)
- Cumulus / stratocumulus slab from 1400 to 2600 m.
- Coverage map: fbm in a domain periodic over 24 h (offset = R·(cos 2πh/24, sin 2πh/24)), plus the weather cloudiness. The result is deterministic across multiplayer peers and continuous across midnight.
- Shape: a 64³ Perlin-Worley 3D noise, forged at load, with a 32³ detail noise.
- Raymarch into cloudRT at half resolution:
  - 12 steps on high, 8 on mid
  - 3-tap light march
  - Beer-powder
  - dual Henyey-Greenstein lobes (0.6 / −0.2)
  - ambient from the top of the sky-view LUT
  - depth-aware upsample using the sky mask
- Cirrus: a 2D forged streak texture at 8 km.
- Low tier: a 2D fbm layer only.
- Rain: nimbostratus with coverage 0.95, base at 600 m and a dark belly.

CLOUD SHADOWS
- ngCloudShadow uses the same coverage map, projected along the sun direction to 2000 m. The CPU twin gives the value at the focus point, which scales the key-light intensity for characters.

LIGHT RIG
- The key light is the sun until sunAlt < −1°, then the moon. The intensity crossfade reaches zero at the swap, so there is no shadow pop.
- SH L2 is projected every 0.25 s from 128 CPU directions of the same model, plus ground bounce (albedo 0.12 × E_key·cosθ) and canopy occlusion at the focus point. Underwater it is overridden with the water in-scatter colour.
- The old HemisphereLight is removed. The LightProbe provides diffuse ambient only.

HORIZON MATCHING
- Each frame the CPU evaluates the sky radiance at the horizon for 8 azimuths and solves ngInscatterAmb so that ngApplyMedium at 3 km equals it. Terrain silhouettes then dissolve seamlessly into the sky.

MIST
- Dawn mist density is 0.012 per m from 4:30 to 8:00, peaking at 5:45, scaled up after rain (the wetness memory), base 0 m, scale height 5 m.
- Rain haze doubles βM.

if: Consumes: ngFrame, forge, pipeline (it registers the skyView and cloudRT preparers), and the weather state (rainIntensity, cloudiness, key, damped) from the Environment facade.
Exposes:
- SkyServices on ctx.sky: skyViewTex, transmittanceTex, sampleSky(dir) (CPU), cloudShadowAt(x, z) (CPU), keyRadiance.
- The Environment facade fields: sunDir, keyDir, sunColor, zenithColor, horizonColor, fogColor, nightAmount, sun (DirectionalLight), sky (Object3D), skyUniforms.
- The ngFrame slots 0–7, 12 and 13.
The wetness producer: damped rise τ = 10 game-min under rain, drying τ = 60 game-min.

budget: Main pass, sky and clouds: high 0.70, mid 0.50, low 0.25. Reflection pass: high 0.25, mid 0.15, low none. LUTs 0.05 on every tier. CPU 0.3 ms per frame (SH projection amortised). Load ≤ 200 ms.

lab: lab/sky.html shows a fisheye / horizon strip view and the dock-fp preset over terrain stubs, with a time scrubber and weather buttons.
Proof set:
1. A 24-frame time-lapse contact sheet at 1-hour steps, clear weather.
2. Blue hour at 18:55 showing the ozone blue band and the Belt of Venus.
3. Golden hour at 17:45 with cumulus lit from behind.
4. Overcast noon with flat light and soft shadows.
5. Rain with a dark, low base.
6. 23:30 moonlit: moon glow, stars and a readable landscape.
7. A horizon continuity crop: the far ridge against the sky, with a luminance-step metric below 4%.
8. A graph of the SH and key-light colour against the hour, dumped as JSON.

risks: - Horizon and aerial-perspective mismatch. Mitigated by the automatic horizon solve.
- Cloud cost at 1440p. Mitigated by the half-res target, step caps and the low-tier 2D fallback.
- Stars shimmering in reflections. Mitigated by the size bias and the mip.
- Discontinuity at midnight. Mitigated by the periodic domain.
- Night that is either too dark or too flat. Owned jointly with post through the exposure table, tested with the 23:30 proof.

### water (surface shading, reflection use, detail normals, ripples, splashes, shore)
files: src/gfx/water/{index.js, WaterSurface.js, water.glsl.js, underside.glsl.js, mesh.js (clipmap rings), detailNormals.js + fft.worker.js, ripples.js, splashes.js, shore.glsl.js, quality.js}; lab/water.html; scripts/gfx/scenarios/water-*.mjs. The Water facade (src/water.js: physics, pools and API shape) belongs to Core-B and delegates the visuals here.

resp: The hero surface:
- mirror reflections
- wind ripples with drifting cat's-paw patches and glassy calm areas
- depth-correct refraction
- sun and moon glitter
- rain rings
- interactive rings from the bobber, fish, splashes and rain
- splash droplets
- contact foam and shore lapping
- the underside with Snell's window
The GPU displacement must equal the CPU surfaceY.

tech: GEOMETRY
- Camera-centred clipmap: a centre 128×128 quad patch at 0.25 m, then 5 rings of 128×128 − 64×64 quads, doubling spacing (0.5 m to 8 m) out to 520 m. About 80k vertices on high; 64×64 base on low.
- Each ring is snapped to its own spacing to avoid swimming.
- VS: y = ngWaveH(p, t)·wind·ngShoalGain(ngDepth(p)). Depth is read from ngHeightNear/Far with texelFetch bilinear. Land vertices are therefore flat and hidden under the terrain.
- Slope: ngWaveD·wind·shoal.

DETAIL NORMALS
- A worker computes a lake-appropriate spectrum: JONSWAP with fetch 300 m and wind 1–6 m/s, capillary cut-off below 1.7 cm.
- Dispersion is quantised so that ω_k is a multiple of 2π/16 s, which makes the result exactly periodic.
- 32 inverse FFTs at 256² → 32 frames of slope (RG8) stored in an array texture (8 MB high; 16×128² on low). Toksvig variance is kept in the mip alpha.
- The FS samples 2 scales (tile 3.7 m at 0° and 13 m at 37°; high adds a third at 0.9 m) with linear interpolation between frames.
- Amplitude = base(wind) × ngWindAt(p).z. This gives travelling cat's-paws and glassy patches.
- Distance roll-off plus Toksvig: roughness_eff = sqrt(r² + σ²_mip) keeps the far lake from sparkling or aliasing.

RIPPLES
- Sampled from rippleNear/rippleFar with a blend at the cascade edge.
- ngRainRings × rain.
- Rain also adds +0.06 roughness and damps the mirror.

REFLECTION
- UV = screenUV + n.xz·k/(1 + 0.02·viewZ), sampling reflRT at mip = f(roughness_eff).
- The upper-edge miss falls back to probeCube (low) or the skyView LUT.
- Fresnel: Schlick F0 = 0.02 with the roughness-aware Karis fit, evaluated on the filtered normal.

SPECULAR
- GGX with key radiance × ngSunVisibility (near shadow through lights:true plus far and cloud shadow).
- The moon glitter path comes free, because the key light is the moon at night.
- High adds hashed micro-glints near the sun path.

REFRACTION
- sceneColor at uv + n.xz·0.035·saturate(thickness/1.5).
- Validity test: if sampled depth < water depth, use the unrefracted uv.
- No absorption here; it was already applied at the seen fragment.
- Surface scattering term: (1 − F)·ngWaterInsc·0.15·shadow, for the soft teal body in the shallows.

SHORE
- thickness = sceneDepthLin − waterDepth.
- Contact softening: over 0–3 cm, F → 0 and blend to pure refraction, so there is no hard edge.
- Foam: a forged 512² foam noise × smoothstep(0.35, 0, thickness) × lapping phase from ngShoreRunUp, applied to the lake as a thin wet rim plus bubbles.
- Contact foam around piles, reeds and rocks comes automatically from the same thickness term.
- The 'splash' foam channel of the ripple RT adds decals.

UNDERSIDE
- Chosen with gl_FrontFacing.
- Snell: refract(V, n, 1.333). Total internal reflection when sinθ > 0.75.
- Window-edge brightening.
- The water medium from camera to surface is applied here, per the medium rules.

SPLASHES
- Pool of 1024 droplets (512 mid, 256 low) as instanced camera-facing quads.
- The position is analytic in the VS from spawn data (p0, v0, t0, seed): p = p0 + v t + ½ g t² with drag.
- No CPU simulation. A spawn is one sub-buffer upload.
- On landing, a ring is scheduled (CPU keeps the spawn time + t_land in a small list).

API SAFETY
- addRipple and addSplash write into ring buffers, overwriting the oldest entry, and clamp NaN inputs. They never throw.

if: Consumes:
- pipeline.uniforms (sceneColor, depth, reflection, probe, ripple cascades, far shadow)
- heightfield uniforms
- ngFrame
- SkyServices.skyViewTex
- the three shadow of env.sun (ngShaderMaterial with lights: true)
- waveGLSL('ng')
- the forge
- Water facade state: time, wind, uw
Exposes:
- WaterSurface (layer WATER, renderOrder 1)
- ripples.add(x, z, size, dur) and splashes.add(x, y, z, count, power), called by the facade's addRipple and addSplash
- the preparer 'water.ripples'
- uniforms.uLinearOut, and uShallow/uDeep as THREE.Color for compatibility
No other module reads water internals. Terrain gets the shore run-up through ngShoreRunUp and ngFrame time only.

budget: Surface fragment including ripples: high 1.10, mid 0.80, low 0.60. The ripple splat is included (0.08). Splashes at peak 0.1. Water geometry VS about 0.1. CPU 0.2 ms. Load: FFT worker 0.4 s, overlapped with the Bed step.

lab: lab/water.html runs the real lake with terrain, sky and hardscape stubs or the real modules, and buttons to spawn ripples, splashes and rain.
Proof set:
1. Calm 9:00 dock-fp mirror of the far shore with the reflected forest silhouette crisp.
2. Wind gusts at 4 m/s: cat's-paw patches next to glassy areas.
3. Golden-hour sun glitter path, with no far sparkle aliasing (720p and 1440p crops).
4. Moon glitter at 23:30.
5. noon-fp-down: refraction of the lakebed, weeds and fish, depth colour gradient and contact foam at the piles.
6. Rain rings over the whole lake.
7. The bobber ring sequence (6 frames).
8. Underside Snell window from uw-dock.
9. Waterline split view.
10. GPU-vs-CPU wave readback test: render displaced heights at 64 probe points into an R32F target and compare with surfaceY. Must be < 5 mm.

risks: - Refraction artefacts at object edges. Mitigated by the validity test.
- Normal aliasing at distance. Mitigated by Toksvig and the roll-off.
- Seams between ripple cascades. Mitigated by blending with the cascade-edge fade.
- Planar reflection lag or seam at the screen top. Mitigated by the sky/probe fallback.
- The clipmap intersecting the dock and piles. Solved by the contact softening.
- A one-frame time lag for the bobber (sub-millimetre).

### underwater (caustics, optics, underwater post, plankton)
files: src/gfx/underwater/{index.js, causticsBake.js, caustics.glsl.js (body of the new CAUSTICS_GLSL, re-exported by src/shaders.js), optics.js (σ, in-scatter producer, getUnderwaterContext core), UnderwaterEffect.js (pmndrs Effect), shafts.glsl.js, plankton.js, quality.js}; lab/underwater.html

resp: Caustics shared with fish through the unchanged injection contract. Water optical coefficients as a pure function of weather, time and turbidity (ngFrame slots 9–10). The six dynamic causticsUniforms fields, written every frame through water.update. The underwater view: volumetric god rays, depth blur and the waterline. Plankton and detritus near the camera. The shape of getUnderwaterContext.

tech: CAUSTICS BAKE (load, about 20 ms GPU)
- A photon-splat mesh: a 512² grid (256² on mid/low) refracted through the periodic detail height field plus the long waves onto a plane at depth D = 3 m.
- Additive into R16F with 3×3 tiling for wrap-around.
- Three channels at D·(1 ± 0.02) give chromatic dispersion.
- 16 time frames on high, 8 on mid/low, stored as an RGBA8 array texture (16 MB on high).
- causticsUniforms.uCaustTex.value is always a DataArrayTexture: a 1×1×1 placeholder until the bake finishes, then the baked array. The object reference never changes.

NEW CAUSTICS_GLSL (same signature: vec3 causticLight(vec3 worldPos, vec3 viewNormal); returns 0 for y > −0.02)
- The same 16 uCaust* names, with the same defaults where tests pin them (uCaustWarp (1.15, 2.5), uCaustFar (6, 20)).
- Projects along the Snell-refracted sun direction.
- Warps the pattern with csWaveD, which is emitted inside the string only.
- Two array layers at 2 scales, linearly interpolated between time frames.
- LOD by depth.
- Gating by sun altitude, night, rain and cloud.
- Uses only sampler2DArray plus built-in uniforms, so it compiles inside the fish GLSL3 programs.
- ngExtendStandard materials multiply the result by ngSunVisibility, so the dock shadow removes caustics. Fish do not, which is acceptable.

OPTICS
- σa = (0.20, 0.075, 0.045) × (1 + 0.5·rain) (turbidity), σs = 0.03–0.06.
- ngWaterInsc = σs/(σa + σs) × (E_key·transmittance(surface) × 0.55 + E_sky × 0.8) × a 0.9 green-teal tint.

GOD RAYS (UnderwaterEffect; when uwStrength > 0)
- Half resolution. 16 steps on high, 8 on mid, up to min(sceneDepth, 40 m). Blue-noise jitter per pixel, rotated each frame.
- Density at each step = shaft(p) × nearShadow(p) × e^(−σ·(depth + dist)).
- shaft(p) = the caustic pattern sampled at p.xz + sunRefr.xz·(−p.y) with mip 3, which gives shafts aligned with the floor caustics.
- Bilateral depth-aware upsample.
- Low tier: an analytic radial glow toward the refracted sun instead of marching.
- Also: sceneColor mip blur of 0–2 levels by distance, faint chromatic offset, and the waterline meniscus (a 1.5 px dark-and-bright line where ngWaveH at the near plane crosses the view) with a split above/below-water blend.

PLANKTON
- 800/400/150 instanced soft points in a 12 m box wrapped around the camera. Position = fract((seed − cam)/12)·12 + cam, so no respawn logic is needed.
- Lit by key × e^(−σd·depth) plus in-scatter.
- Brownian drift driven by envTime.

if: Consumes: ngFrame, pipeline.uniforms (sceneColor, sceneDepth), the near shadow map and matrix (env.sun.shadow), the detail height tile from the water module's worker output (shared by core as ctx.workers.result('water.fft')), and the forge.
Exposes:
- CAUSTICS_GLSL and createCausticsUniforms() through src/shaders.js. game.js calls them where it used to call createCausticTexture.
- optics.update(f, env), called from the Water facade update.
- getUnderwaterContext(camera) → {strength, time, sunDir, night, rain, cloud, absorb (Vector3 = σa), camPos, camNear, camFar, waterY}.
- createEffect() → a pmndrs Effect, inserted by the post module.
- The plankton object (layers UNDERWATER + LATE_FX).

budget: Above water: 0, because caustics cost is counted inside the host materials, at about 8 ALU plus 4 fetches. Underwater view (it replaces the skipped reflection pass): high 1.2, mid 0.8, low 0.4. Plankton 0.05–0.15. Bake ≤ 30 ms.

lab: lab/underwater.html runs the real lake, terrain, shore-flora stubs and 6 real fish.
Proof set:
1. uw-dock at noon: god rays cut by the dock shadow, piles fading into blue-green.
2. weedbed-uw: weeds, fish lit by caustics, and the lakebed readable to 26 m.
3. Looking up: the Snell window with the forest and sky compressed into the circle.
4. Waterline half-submerged frame.
5. Dawn, golden hour, night and rain underwater variants.
6. noon-fp-down from above: the caustic net on the lakebed, synced to the waves.
7. A fish close-up proving the injection compiles and the caustics move.
8. A visibility metric: luminance contrast of a grey card at 10/20/30 m.

risks: - Changing the uCaustTex sampler type affects fish compilation. Mitigated by a lab test with the real createFishMaterial, and remoteFish takes the same path.
- A double attenuation look (the CAUSTICS_GLSL depth fade combined with ngApplyMedium). Tuned in the lab.
- God-ray cost at 1440p. Mitigated by the step caps, half resolution and the low-tier fallback.
- A waterline flicker when the camera sits at wave height. Mitigated by damping uwStrength (the old 0..1 strength semantics).

### terrain (CDLOD ground and lakebed, materials, far albedo, distant ridges)
files: src/gfx/terrain/{index.js, cdlod.js, TerrainMaterial.js, terrain.glsl.js, groundLayers.bake.js, farAlbedo.js, ridges.js, shoreWet.glsl.js, quality.js}; lab/terrain.html. The Terrain facade gameplay API (src/terrain.js plus src/world/*) belongs to Core-B.

resp: All land and lakebed surfaces, matched to lake.heightAt. Meadow, forest floor, moss, soil, sand/gravel, cobbles, granite and lake silt. The shore wet band animated by run-up. Rain wetness and puddles. Bed kinds from bedAt, and darkening at the weed beds on lake.flats. A far albedo map. Layered distant ridges to 3 km for the Japanese blue-layer mountain look.

tech: CDLOD
- Quadtree root 1024 m, leaves 16 m.
- One instanced patch mesh: 33² vertices (2048 triangles) on high and mid, 17² on low.
- LOD ranges on high: 24, 48, 96, 192, 384, 768 m. ×0.75 on mid, ×0.6 on low.
- Geomorphing in the last 30% of each range.
- VS: texelFetch bilinear from ngHeightNear (0.5 m) inside ±258 m, otherwise ngHeightFar (1 m), with a blend over the 4 m border.
- Normals from ngNormalNear/Far.
- Selection per pass: main every frame; reflection with 2× bias; near shadow in the light-space box; far shadow at a fixed 4 m LOD.
- About 400 instances, around 800k triangles on high.
- The lakebed is the same mesh (layer WORLD).
- Displacement is limited to ±2 cm of micro-detail. No POM (fish clamp to the bed + 0.22).
- Error vs heightAt: the sample points are exact. The GPU bilinear matches sampleGrid(), tested at < 5 cm across the walk band and the lake.

MATERIAL (ngExtendStandard)
- Two RGBA8 array textures: (albedo, height) and (normal xy, roughness, AO). 8 layers, 1024² on high, 512² on mid/low. Forged at load from noise, Worley and domain-warp recipes, including stones, needles, leaves and moss.
- Weights per pixel from:
  - height and slope
  - ngShoreD (the signed shore distance)
  - ngBedMap (mud/sand/rock)
  - ngCanopy (forest floor under trees)
  - the weed density at lake.flats
  - a moisture fbm
  - a worn dirt trail from dock.start 30 m inland (deterministic from the dock)
- Top-2 layer selection with a height-blended transition.
- Hex-tiling (Mikkelsen) on the top-2 layers on high, the top-1 on mid, and simple dual-scale on low.
- Three-scale macro tint noise to break repetition.
- Beyond 180 m, and in the reflection pass: the farAlbedo map. This is 2048² RGBA8 over 1 km, rendered once at load from above with the terrain material plus the canopy colour, with mips.
- Shore wet band: h ∈ [0, 0.4 m] above ngShoreRunUp(p, t)·wind darkens albedo, sets roughness 0.12 and adds sky specular (ngSkySpecular).
- Rain: ngWetSurface with porosity per layer, and ngPuddle on flat trail and mud where slope < 0.05, with ngRainRings normals.
- Underwater: silt, organics and dark algae stones in the shallows, plus causticLight × ngSunVisibility. The shallow bed near the dock shows the light-sand ripple pattern.

DISTANT RIDGES
- 3 ring meshes at 700–1200, 1200–2000 and 2000–3000 m. Each is 1024 segments × 12 rows, with ridged-noise heights continuing the lakefield mountain style and a canopy tint on the nearest ring.
- Layer FAR. The aerial perspective turns them into receding blue layers.
- About 40k triangles in total.

if: Consumes: heightfield textures and GLSL, placement (canopy and weed densities, through core maps), ngFrame, the forge, wind (not used), caustics, and the far shadow.
Exposes:
- terrainMesh (castShadow via the auto depth variant; receiveShadow)
- farAlbedoTex and coverRules GLSL (ngGroundKind(p)) for groundcover colour matching
- preparers: none
- updateShore(time, wind) → uniform storage only

budget: Main pass: high 1.40, mid 1.00, low 0.80. Reflection: high 0.30, mid 0.20. Near shadow: 0.30 / 0.20 / 0.15. Far-shadow slice: 0.1. CPU 0.15 ms (quadtree). Load ≤ 600 ms, including the layer forge (60 ms) and the far-albedo render (40 ms).

lab: lab/terrain.html runs with tree, flora and water stubs (a flat plane with the refraction path).
Proof set:
1. shore-low at 13:00: sand-to-grass-to-forest-floor transition and wet band with lapping (4-frame strip).
2. forest-floor: needles and moss under canopy.
3. aerial60: no visible tiling or repetition (a 2560×1440 crop at 3 distances).
4. far-ridge at 6:00 and 17:45: blue layered ridges and a clean horizon blend.
5. noon-fp-down lakebed: mud, sand and rock with caustics.
6. Rain puddles on the trail.
7. Wireframe and LOD-colour debug view.
8. A heightAt error heatmap: GPU readback against CPU on a 256² grid.

risks: - R32F vertex fetch cost on weak GPUs. Low uses 17² patches and a 1 m near grid.
- Hex-tiling cost. Enabled per tier.
- Seams at the near/far grid border. Handled by the blend band plus a skirt.
- Too many samplers. Budgeted at 10.
- Matching at the waterline where terrain meets water. The water owns the edge softening.

### trees (sugi / buna forests, LOD, impostors, canopy shell)
files: src/gfx/trees/{index.js, TreeSystem.js, loader.js, impostor.js, canopyShell.js, bark.bake.js, foliage.bake.js, foliage.glsl.js, compaction.js, quality.js}; scripts/bake/trees/{bake.mjs, skeleton.mjs, sugi.mjs, buna.mjs, cards.mjs, quantize.mjs}; assets/gfx/trees/{trees.bin, trees.json}; lab/trees.html

resp: A photoreal-leaning Japanese mixed forest: tall conical sugi (Cryptomeria) with reddish fibrous bark and dark needle sprays, and broad buna (Fagus crenata) with smooth grey, lichen-spotted bark and layered bright leaves. Wind animation. LOD down to impostors, and a canopy shell for the mountainsides. Shadows in both the near and far maps. The visual trunk thickness must equal the collision spec in the species table.

tech: OFFLINE BAKER
- Deterministic, three-free Node. Seeded from the SPECIES table in src/world/species.js, which is the input spec shared with the collision code.
- Sugi: a monopodial tapered trunk (base radius = table.trunkR × height, exact), whorled drooping branches, and needle sprays as curved cross-cards.
- Buna: sympodial branching by space colonisation in an ellipsoid crown, a smooth trunk with buttress flare, and leaf-cluster cards.
- 4 variants per species, plus 2 saplings.
- LOD0: trunk with 12 radial segments, branches down to 3 cm, 400–700 cards; 9–12k triangles.
- LOD1: 2–2.5k triangles, 6 radial segments and about 80 large clumps.
- Vertex format, 20 B: int16×3 position, oct int8×2 normal, unorm16×2 UV, uint8×4 wind (hierarchy level, phase, stiffness, flutter), uint8 AO.
- Total about 2.0 MB, plus trees.json with per-variant bounds, baseRadius and crown centre.

TEXTURES (GPU forge at load)
- Bark arrays (sugi and buna): 512², 2 layers × 2 maps.
- Foliage atlases: 1024² on high, 512² on mid/low. Individual procedural leaves (ovate, serrated, veined) and needles (awl-shaped on spiral twigs) are rasterised with SDF instancing into cards: albedo + alpha, then normal + translucency + roughness. Coverage-preserving alpha mips.

SHADING (ngExtendStandard)
- Leaves:
  - two-sided with a normal flip
  - normals bent 60% toward (pos − crownCentre) for a soft crown
  - translucency added after lights_fragment_end: key × thickness × pow(saturate(dot(V, −L)), 4) × shadow
  - per-instance hue and ageing
  - alphaToCoverage on high, alphaTest 0.5 on mid/low
- Trunks: bark plus moss on the north/up side, and wetness.
- Wind, identical in the depth variant:
  - trunk sway from ngWindAt(instance).z at 0.2 Hz
  - branch bend weighted by hierarchy
  - leaf flutter at 4–7 Hz

LOD (high)
- LOD0 < 45 m, LOD1 45–140 m, impostor 140–420 m, canopy shell > 380 m.
- mid 30/100/320/300 m, low 20/70/250/230 m. 5% hysteresis.
- LOD0 to LOD1 uses a pop with hysteresis (similar silhouettes). The impostor transition uses a 4 m dithered crossfade (blue noise; on high MSAA plus alpha-to-coverage smooths it).

IMPOSTORS
- Hemi-octahedral, 8×8 frames of 128² on high (96² mid, 64² low), 8 variant layers × (albedo+alpha, normal+depth).
- Baked at load from LOD0 through forge.renderView (512 small renders, about 150 ms).
- Three-frame blend with depth-based parallax.
- Static per 128 m cell (one draw per cell per species, variant chosen by a layer attribute).
- The VS collapses instances closer than 130 m.

COMPACTION
- LOD0 and LOD1 instance buffers are rebuilt on the CPU for trees within 150 m (≤ 4k) on movement or at 4 Hz, as dynamic InstancedBufferAttributes with an update range.
- 2 species × 5 variants × 2 parts × 2 LODs gives about 40 draws.

CANOPY SHELL
- The far heightfield grid (4 m) displaced by ngCanopy height (18–30 m), with Worley crown bumps and a normal from noise.
- Foliage BRDF plus fake crown occlusion.
- Layers FAR + SHADOW_ONLY (it casts into the far shadow). It also serves the reflection and the probe.

COUNTS
- Colliding trees (about 4–6k) are always drawn.
- Visual trees within 420 m: high 45k, mid 25k, low 10k, by placement rank.

if: Consumes: placement.trees (SoA: x, z, y, height, species, variant, rot, rank, collide), SPECIES, heightfield, wind, ngFrame, the forge, far and near shadows, and SkyServices for the ambient under the canopy.
Exposes:
- TreeSystem root (layer WORLD; the canopy shell on FAR + SHADOW_ONLY)
- canopyShell
- update(f) compaction
- setLodScale
- the impostor bake API, reused by hardscape for snag impostors if needed
Sends nothing back to gameplay.

budget: Main pass: high 2.00, mid 1.50, low 1.20. Reflection: high 0.50, mid 0.35. Near shadow: 0.60 / 0.45 / 0.30 (LOD1 is used for shadow casting beyond 20 m). Far-shadow share: 0.1. CPU ≤ 0.5 ms (compaction, amortised). Load ≤ 900 ms: fetch and decode 60 ms, forge 100 ms, impostors 150 ms, instances 40 ms.

lab: lab/trees.html runs terrain and sky with the real placement.
Proof set:
1. forest-floor looking up at 13:00, with translucency and sun flecks.
2. shore-low looking at the forest edge wall across 40–150 m (the LOD transition must be invisible).
3. far-ridge covered by the canopy shell, with no gap between the impostor and shell bands.
4. Golden-hour backlit sugi silhouettes.
5. Wind gust sequence (8 frames).
6. Near-shadow and far-shadow debug views showing tree shadows over the dock and lake.
7. Overdraw view within budget.
8. An LOD-colour debug view.
9. A collision overlay: the trunk circles from placement drawn over the visual trunks. Visual radius × 1.15 must equal the collision radius within 5%.

risks: - Foliage overdraw and alpha cost at 1440p. Mitigated by cards clipped to alpha bounds, alpha-to-coverage on high, and early-z via an opaque trunk pass first.
- Shadow cost. LOD1 is used for casters.
- An impostor lighting mismatch. Impostors store normals and are shaded in the same BRDF.
- Baker and table drift. Enforced by a test.
- A LOD pop in reflections. Reflections use the bias.
- Instance buffer uploads. Bounded by the update range.

### groundcover (grass, sasa, ferns, moss clumps, litter, pebbles, thicket ring visuals)
files: src/gfx/groundcover/{index.js, coverMap.js, grass.js, grass.glsl.js, sasa.js, ferns.js, thicket.js, pebbles.js, litter.js, cards.bake.js, quality.js}; lab/groundcover.html

resp: Dense and living ground cover:
- meadow grasses and sedges on the open shore band
- kumazasa (sasa bamboo grass) under the beech and sugi
- ferns in moist shade
- moss clumps
- fallen twigs and leaves
- shoreline pebbles and cobbles
- the dense shrub visuals of the walk-boundary thicket ring (the collision already comes from placement)
The colour of the ground cover must fade into the terrain albedo at distance.

tech: COVER MAP
- RGBA8 1024² over ±260 m (grass, sasa, fern, pebble densities), forged at load from ngGroundKind rules, canopy and shore distance.

GRASS
- GPU-procedural. An InstancedBufferGeometry clump of 5–7 blades, each a 4-segment curved strip, with no textures (the VS builds a width profile and the FS does a tip gradient).
- A world-anchored jittered grid around the camera, in rings:
  - 0–10 m: 6 clumps/m²
  - 10–22 m: 2 clumps/m², 1.6× wider
  - 22–32 m: 0.6 clumps/m² as cards
- instanceID → world cell (stable while the camera moves, no popping) → hash jitter → the cover map sets density and height. Rejected instances collapse to degenerate triangles.
- Wind: ngWindAt, a gust wave plus per-blade phase.
- An angler push-away radius of 0.6 m around the focus point.
- Shading: two-sided, translucency, base AO, a colour ramp from the terrain meadow colour, and specular sheen.
- Clumps: high 25k, mid 12k, low 4k.
- Layer NO_REFLECT. Receives shadow and casts none.

SASA AND FERNS
- Static instanced meshes (sasa: 8 leaf fans, 300 triangles; fern: 6 fronds, 400 triangles) from placement.pebbles/understory (visual-only, rank-subset: high 100%, mid 60%, low 30%) within 60 m, and cards to 90 m.

MOSS AND LITTER
- Small instanced clumps and decal quads aligned to the terrain normal, within 30 m.

PEBBLES AND COBBLES
- Instanced procedural low-poly stones (4 variants, 80 triangles) along the waterline band from −0.6 to +1.5 m. Wet and dark below the run-up.

THICKET RING
- Placement gives rings of r = 0.55 m obstacles at shoreRadius + 72 − 5 to + 4. Visuals are dense shrubs (utsugi/hagi-like: branch skeleton plus leaf cards, 3 variants, LOD0/cards) at exactly those centres.
- Always drawn on all tiers, because they carry collision.

if: Consumes: heightfield, placement (thickets, understory, pebbles; visual subsets by rank), terrain.coverRules GLSL, wind, ngFrame, focus position, and the forge.
Exposes: its root group (layers NO_REFLECT, with thickets on WORLD so they reflect at the shore) and update(f) for ring recentring. There is no per-frame CPU instance writing for grass.

budget: Main pass: high 1.30, mid 0.80, low 0.40. Reflection: only the thicket ring, 0.05. Near shadow: thickets only, 0.05. CPU 0.1. Load ≤ 250 ms.

lab: lab/groundcover.html runs terrain, sky and trees (stub or real).
Proof set:
1. shore-low at 9:00 with backlit meadow grass along the shore.
2. forest-floor sasa carpet.
3. A wind gust wave across the meadow (8 frames).
4. Walking sequence (10 frames moving 1 m each) showing no swimming or popping.
5. Pebble waterline at noon and in rain.
6. The walk-boundary thicket reading as a natural wall, with the collision overlay aligned.
7. A fade to terrain at 30 m, with no ring visible (1440p crop).

risks: - Vertex cost of the blades. Tiered counts, and a hard cap.
- Temporal aliasing of the blades without TAA. Mitigated by the width floor (≥ 1 px via a projected-width clamp), MSAA on high and distance fade.
- A density mismatch with the terrain colour. Shared cover rules.
- The thicket needing to look natural as a wall. Varied heights and irregular spacing, but the obstacle positions stay fixed.

### shoreflora (reeds at the 葦際, lily pads, submerged weed beds at the 藻場)
files: src/gfx/shoreflora/{index.js, reeds.js, lilies.js, weeds.js, flora.glsl.js, flora.bake.js, quality.js}; lab/shoreflora.html

resp: The visual truth of the field-guide zones:
- ヨシ (Phragmites) beds along the edge where depth ≤ 1.5 m
- ヒツジグサ water lilies floating in sheltered shallows, opening their flowers around 14:00
- submerged pondweed and hornwort strands covering lake.flats
- the interaction of all three with the water (bobbing on the waves, contact foam)

tech: REEDS
- Positions come from placement.reeds, which are clustered beds along the shore where depth ∈ [0.05, 1.5] m, plus wet land ≤ 0.3 m above water. There is a noise-based patchiness, and the dock (4 m) and spawn areas are excluded.
- Stems: 3 segments, 2–3 long leaves and a small summer plume. 30–40 triangles.
- High 30k, mid 15k, low 6k (rank).
- Heavy wind sway driven by ngWindAt. A per-stem phase. The base is fixed at the bed height.
- Beyond 60 m, card clumps.
- Layer WORLD, so reeds reflect in the mirror water (iconic). Receive shadow; cast only on high within 30 m.

LILY PADS
- A flat disc with a notch (24 triangles) and a waxy BRDF.
- The VS sets y = ngWaveH(p, t)·wind·shoal + 0.005, the same wave function as the water, so pads bob with the surface. A slight tilt from ngWaveD.
- Wet edges, and a red underside visible at the rim.
- White flowers (60 triangles) open between 13:00 and 17:00 as a smooth function of the hour.
- Placed from placement.lilies on the lake.flats margins and sheltered coves at depth 0.3–2.5 m.
- High 3k, mid 1.5k, low 600.
- Layer WORLD (they reflect).

WEEDS
- Ribbon strands of 6–10 segments, 0.5–2.5 m tall, growing from the bed height (ngTerrainH).
- Sway from the underwater current (flowDir and flowStrength from updateUnderwaterProps plus ngWindAt).
- Dark olive to bright green. Caustics injected, with ngApplyMedium.
- Density falls off with the radius of each lake.flats patch.
- High 6k, mid 3k, low 1.2k.
- Layer UNDERWATER.
- terrain.underwaterProps.group is an empty dummy (see the gameplay contract).

if: Consumes: placement (reeds, lilies, weeds, built from lake.flats and the depth rule), the heightfield, waveGLSL('ng') through core, wind, ngFrame, caustics, and the flow from the Terrain facade's updateUnderwaterProps.
Exposes: its root groups (reeds and lilies on WORLD, weeds on UNDERWATER) and update(f).

budget: Main pass: high 0.60, mid 0.45, low 0.25. Reflection: high 0.25, mid 0.15. Near shadow: high 0.15, mid 0.10. CPU 0.05. Load ≤ 250 ms.

lab: lab/shoreflora.html runs terrain, water and sky with the real or stub modules.
Proof set:
1. reed-edge at golden hour: backlit plumes and reeds reflected in calm water.
2. A lily colony at 14:00 with flowers open, and the same colony at 9:00 closed.
3. Pads bobbing in phase with the water (4-frame strip, with a wave overlay).
4. weedbed-uw: a swaying forest of strands.
5. From the dock, noon-fp-down: weed beds visible through refraction.
6. A zone overlay: the 葦際 depth ≤ 1.5 m mask and the 藻場 = lake.flats circles, with the reeds and weeds covering them.

risks: - Reed overdraw along the shore. Tiered counts and cards.
- Pads z-fighting with the water. Mitigated by the +5 mm offset, the shared wave function and a polygonOffset on the water side.
- Correspondence with the gameplay zones. Tested with the placement predicates imported from src/world.

### hardscape (dock, lamp, boat, boulders, sunken rocks and snags at lake.structures)
files: src/gfx/hardscape/{index.js, dock.js, wood.bake.js, lamp.js, boat.js, rocks.js + rock.worker.js, rock.bake.js, structures.js, quality.js}; lab/hardscape.html

resp: A weathered wooden dock with exactly the contract dimensions:
- deck width 3.4 m
- walkable half-width 1.62 m
- tip handrail 2.3 m
- deck top at dockY
- pilings with an algae band at the waterline

Also:
- the lamp at r 0.26 and top dockY + 2.3, with a PointLight that always exists and a warm glow
- the small wooden boat (2 × r 0.85)
- mossy granite boulders at the placement positions and sizes
- sunken rocks and standing or sunken snags exactly at lake.structures
- rain wetness and puddles on the planks

tech: DOCK
- Procedural geometry: 2 stringers, cross beams every 1.2 m, pilings every 2.4 m (r 0.09–0.12 with a slight lean), planks 0.2 m with 1 cm gaps and individual warp, twist and height jitter of ±4 mm, nail heads with rust streaks, and the handrail at the tip.
- Planks as one instanced mesh. About 20k triangles in total.
- Wood arrays forged at load: ring grain with distorted rings, cracks, silver-grey weathering by exposure (top faces greyer), moss in the gaps and edges, and a dark wet band on the pilings below +0.15 m with green algae below the water.
- Rain: ngWetSurface (porosity 0.8), plus puddles in plank cupping via the ngPuddle mask and ngRainRings.

LAMP
- A wooden post with a paper or stone-style lantern head.
- The PointLight is created at init with intensity 0 by day. Warm 2200 K, distance 18 m, decay 2, no shadow.
- updateLamp(night, dt) is framerate-independent (λ = 1.2/s) and paused when dt = 0.
- An emissive head, and a soft glow sprite on layer LATE_FX that gets a halo in mist from ngFrame mist density.

BOAT
- A small wooden 和船 hull from lofted sections (3k triangles), weathered paint and wood.
- Moored in the water or pulled up at the placement pose. When in water, it bobs with ngWaveH at 3 hull points on the CPU, using the same functions.

BOULDERS
- 8 variants generated in a worker: an icosphere at subdivision 5, displaced by ridged, Worley and fbm noise, with a flattened base and an erosion-like smoothing pass. LOD 10k / 2k / 400 triangles.
- Triplanar granite, with moss on up-facing and north faces, lichen spots, a wet line near the water and algae below it.
- Visual bounding sizes are exactly placement.size.

STRUCTURES
- For each lake.structure: 'rock' is a submerged boulder variant scaled to r and h, with top = bed + h. 'snag' is a dead, bleached trunk with broken branches (a skeleton plus tubes, 1.5k triangles), standing or leaning according to depth, with algae below the water.
- Positions are exactly at x, z, with rot from lake data.

if: Consumes: the dock geometry from the Terrain facade (dockStart, dockEnd, dockDir, dockY, _dockLen, spawnPos), placement (boulders, lamp, boat, structures), the heightfield, ngFrame, caustics, the forge and the workers.
Exposes:
- the lamp PointLight, added once at boot
- updateLamp
- its root groups: dock, lamp, boat and boulders on WORLD; submerged structures on UNDERWATER plus WORLD, with the reflection clipped by the plane anyway
- casters: dock, boat, boulders

budget: Main pass: high 0.50, mid 0.40, low 0.30. Reflection: high 0.20, mid 0.15. Near shadow: 0.20 / 0.15 / 0.10. Load ≤ 400 ms (rocks in a worker, 150 ms).

lab: lab/hardscape.html runs terrain, water and sky stubs or the real modules.
Proof set:
1. dock-3p at morning, noon, golden hour and night with the lamp on.
2. Rain on the dock: puddles with rings.
3. The piling waterline band close up.
4. Boulder cluster at the shore: moss and wet line.
5. uw-dock with snags and sunken rocks at the structures.
6. A collision overlay drawn in the debug.js style: the onDock rectangle, the dockBlocksSegment boxes, the lamp and boat circles, the structure circles and the boulder circles, all aligned with the geometry.

risks: - A dock dimension drift that breaks onDock/dockBlocksSegment and debug.js. Mitigated by the dimensions being constants imported from src/world/dock.js and by a test.
- A lamp PointLight added late would recompile everything. It is created in the Terrain constructor, before the first compile.
- Structures visually mismatching the fish bonus. Guarded by the exact positions and a test.

### weatherfx + post (rain, mist sheets, fireflies, motes; exposure, bloom, shafts, grade, tone map, AA, DRS)
files: src/gfx/weatherfx/{index.js, rain.js, groundSplash.js, mist.js, fireflies.js, motes.js, quality.js}; src/gfx/post/{index.js, PostChain.js, ExposureEffect.js, GradeEffect.js, SunShaftsEffect.js, exposureCurve.js, grades.js, drs.js, quality.js}; lab/post.html, lab/weatherfx.html. The src/postfx.js facade belongs to Core-A. These are one agent's two sub-areas, because both are screen-space and particle work of moderate size.

resp: WeatherFX:
- rain streaks and splashes on the dock and ground, and rain haze (as consumer)
- dawn and after-rain mist sheets drifting over the water
- summer-night fireflies (ホタル) along the reeds
- dust motes in golden light
- env.rain as an Object3D

Post:
- the only place exposure, tone mapping and the sRGB encode happen
- NaN kill
- bloom and sun shafts
- a time-of-day grade with the night Purkinje shift
- dither and AA
- DRS
- PostFX compatibility fields (composer and bloom)

tech: RAIN
- A camera-centred cylinder of r 25 m and h 18 m with instanced quads (12k / 6k / 2.5k).
- Analytic fall at 7–9 m/s with wind slant from ngWindAt. Positions wrap by fract, so there are no respawns.
- Streak length = v·(1/60 s) for a motion-blur look.
- Shading: lit by key and SH ambient with a refraction-ish rim, then ngApplyMedium. Soft depth fade against sceneDepthLin, and killed below the water surface and inside terrain.
- Opacity scales with env.rainIntensity (damped).
- Ground and dock splashes: an instanced pool of 400 crowns at random positions within 15 m, with height from HeightField.sampleGrid or dockY, on a 0.3 s life.

MIST SHEETS
- 60 / 32 / 16 large soft billboards, 20–40 m, just above the water. They drift with the wind.
- Density follows ngFrame mist. They are lit with the Mie forward lobe, so they glow when backlit at dawn.
- Depth-faded (soft particles).

FIREFLIES
- 200 / 120 / 60 emissive points (HDR 6.0) near the reed beds, from 20:00 to 23:00 on clear or cloudy nights.
- Blinking by a hashed 2–3 s rhythm on a Lissajous path. They bloom.

MOTES
- 300 points within 6 m of the camera, visible only in the sun Mie lobe, from 6:00 to 9:00 and 16:30 to 18:30.

POST CHAIN
- The chain runs on the pipeline-owned mainRT (resolved texture plus depth).
- Implemented with pmndrs EffectPass. Effects: ExposureEffect (isnan/isinf → 0, × exposure, clamp 64), then UnderwaterEffect (from the underwater module), BloomEffect, SunShaftsEffect, GradeEffect, and ToneMappingEffect(AGX), with dithering. Then a second EffectPass with SMAA (mid, preset MEDIUM) or FXAA (low).
- If standalone EffectPass use proves fragile in the phase-0 spike, the chain wraps an EffectComposer whose first pass is an NgScenePass (this is local to the module).

SUN SHAFTS
- Occlusion mask from depth (sky = 1) × sky luminance at quarter resolution.
- 24 samples on high, 16 on mid; 2 radial passes.
- Enabled when the key light is within 1.3× of the screen and its altitude < 25°, or the key is the moon.

GRADE
- Keys over the hour: dawn (cool lift, warm highlights), noon (neutral, saturation 1.05), golden (warm white balance, +contrast), blue hour (cool, low saturation), night (Purkinje: desaturate below 0.05 luminance and shift toward 0.45/0.55/0.9 blue, slight grain-free noise floor lift), overcast (saturation 0.9, lower contrast), rain (0.85, cool).
- Vignette 0.15.
- Where DRS is active, the upscale and a light sharpen run here.

DRS
- As described in the core. It writes pipeline.setRenderScale.

EXPOSURE CURVE
- As in the pipeline section. It writes ngFrame slot 16.

if: Consumes: ngFrame, pipeline (mainRT, sceneDepth, frame stats), the underwater module's createEffect, the key light screen position, Environment rainIntensity, cloudiness and hour, placement.reeds for the firefly anchors, and the heightfield.
Exposes:
- PostChain.render(dt)
- setSize and setQuality
- the compatibility fields composer {inputBuffer, outputBuffer} and bloom (BloomEffect | null)
- env.rain (Object3D)
- WeatherFX update(f)

budget: WeatherFX: high 0.40 (rain peak 0.70), mid 0.35 (0.50), low 0.25 (0.40).
Post:
- high 1.00: exposure+NaN 0.05, bloom 0.45, shafts 0.20, grade+tonemap+dither 0.25, upscale 0.05
- mid 1.15: bloom 0.35, shafts 0.15, grade 0.20, SMAA 0.45
- low 0.45: grade 0.20, FXAA 0.25
CPU 0.1.

lab: lab/post.html shows a synthetic HDR test scene (grey cards, a bright sun disc, a gradient sky, emissive points) plus the full-world mode.
Proof set:
1. Exposure ladder images for the 7 standard times.
2. A banding test on the dusk sky gradient (dither on/off).
3. A NaN injection test: an intentional NaN pixel must stay local, with no black bloom blow-up.
4. SMAA/FXAA crops of foliage edges.
5. A DRS step test: forced scale 0.7 must show no shimmer.

lab/weatherfx.html proof set:
1. rain-fp: streaks, splashes and wet dock.
2. Dawn mist sheets backlit at 5:45.
3. Fireflies at 21:00.
4. Golden motes.
5. Rain streaks cut at the water line and not visible inside the dock.

risks: - pmndrs standalone pass integration. The fallback path is defined above.
- Post cost at 1440p. Half/quarter resolution and tier gating.
- Fireflies and bloom producing hot pixels. Mitigated by the clamp at 64.
- Rain overdraw close to the camera. Mitigated by a minimum distance of 0.8 m and a size clamp.
- Grade drift between modules. Post is the only owner; modules must not tone map or grade.

## gameplayContract
WORLD DATA LAYER (three-free; Node-testable; quality-independent)
Core-B owns these files under src/world/:
- heightgrid.js
- placement.js
- species.js
- dock.js
- collision.js (the obstacles grid)
- queries.js (a port of the old gameplay code)
None of them imports three or the DOM, and the Worker never imports them (the Worker keeps using only lakefield).

PHASE −1 (before anything is deleted)
A script, scripts/capture-fixtures.mjs, runs the OLD c8490ed code headlessly (Node for lakefield and waveField; a browser for Terrain via the shot harness) and records golden fixtures:
- about 2000 sample points of heightAt, depthAt, slopeAt, bedAt, normalAt, isWater and shoreRadius
- onDock, dockBlocksSegment and lineBlocked for about 500 segments (including the tol 0.22 and slack 0.62 cases)
- structureNear
- the dock dimensions
- surfaceY and surfaceNormal on a time × point grid
- tickWeather transition statistics
The new facades must match these exactly. The only allowed difference is obstacle content, which intentionally changes (see below).

PLACEMENT — buildPlacement(lake, q = queries) → Placement, deterministic from lake.seed only
- RNG: a separate stream per system: mulberry32(fnv1a(seed + ':trees' | ':rocks' | ':thicket' | ':reeds' | ':lilies' | ':weeds' | ':pebbles' | ':understory')). Math.random is banned, and a lint test greps src/world and src/gfx for it.
- Candidates come from world-anchored jittered grids, so the result does not depend on iteration order or counts:
  - trees: 4.2 m cells, from shore + 5 m to 480 m, using the old rules (h ≥ 1.6, slope ≤ 0.78, dock ≥ 3.6 m, spawn ≥ 6 m, lake.noise forest field, gaps and clusters, sugi valley / buna ridge bias, height tiers)
  - boulders: 9 m cells
  - reeds: 0.9 m cells in the edge band
  - lilies: 1.6 m cells
- Every item gets rank = hash01(cell). Visual tiers draw items with rank < TIER_DENSITY[system][tier] (for example trees low 0.22, mid 0.55, high 1.0).
- Collision items are flagged collide = 1 and are drawn on every tier. They are:
  - tree trunks inside the walk band or within FAR_GATE_NG = 12 m beyond it
  - boulders with size > 1.4 and h > −0.9
  - thicket-ring shrubs
  - lamp and boat
  - structures
- Collision dimensions:
  - trunk r = max(SPECIES[s].trunkR[v] · height · 1.15, 0.28); top = y + 0.9·height
  - boulder r from the visual size (placement.size·0.5·1.05); top from the visual height
  - lamp r 0.26, top dockY + 2.3
  - boat: two circles of r 0.85
  - structures: r·1.15, top = heightAt + h (always ≥ 0.5 m below the surface, by the lakefield constraint)
  - thicket ring: r 0.55 at shoreRadius + 72 − 5 to + 4, with angular spacing from the thicket rng
- Only the Terrain facade calls addObstacle and fills the 8 m hash (_obsGrid, radius < 7.6 m) and the flat obstacles array.
- Clearances: trees and rocks ≥ 3.4–3.6 m from the dock and ≥ 6 m from spawn.
- Visual subsets are nested (low ⊂ mid ⊂ high) and never add or remove colliders. Multiplayer peers on different tiers therefore share identical collision; the old tier-dependent drift is fixed.
- Budget ≤ 250 ms, synchronous inside the Terrain constructor, so blockedAt and lineBlocked are valid immediately. The math API (heightAt, shoreRadius) is analytic and available before placement; _initMap's 72×72 shoreRadius calls stay cheap.

ZONE CORRESPONDENCE
- 藻場 = lake.flats. The weed strands and the terrain weed-darkening use each flat's x, z and r.
- 葦際 = shore edge with depth ≤ 1.5 m (data.js rule). The reeds predicate is isEdge(x,z) = depthAt ∈ (0.05, 1.5] ∧ distance to shoreline < 12 m, exported from src/world/placement.js and reused by the test.
- Structures: 'rock' and 'snag' meshes are placed exactly at lake.structures x, z, rot.

TERRAIN FACADE (src/terrain.js)
Exports Terrain, WATER_REGION and WALK_INLAND, with every contract field.
- Data and collision API: ported verbatim from the old code into src/world/queries.js. This includes heightAt, depthAt, slopeAt, shoreRadius, bedAt, normalAt, isWater, structureNear, structures, onDock, distToDock, dockBlocksSegment (deck box y ∈ [dockY−0.42, dockY+0.18], rail box y ≤ dockY+1.05 over the tip 2.3 m), addObstacle, blockedAt(x, z, rad, y), obstacleTopAt, lineBlocked (tol 0.22, slack 0.5 default; callers pass 0.62), obstacles, _obsGrid, dockStart, dockEnd, dockDir, dockY, spawnPos, dockAngle, shoreR0, _dockU, _dockLen, _dockLocal, lake, seed, noise, hole and flat.
- heightTexture: the new ngHeightNear DataTexture.
- The camera still passes through the dock (unchanged behaviour).
- Render hooks:
  - the static load*Textures() resolve null, but start workers early: heightfield, FFT, tree .bin fetch
  - a new `ready` Promise that game.js awaits once in the 'Bed' step. This is the only added line besides the caustics import.
  - updateWind → Wind
  - updateTrees → the modules' LOD
  - updateLamp → hardscape, dt-correct
  - updateUnderwaterProps → weeds, plankton flow
  - updateShore → uniforms
  - setQuality, setLodScale
- Compatibility shims:
  - overWaterProps = []: the capture-hide list is moot, because there is no separate capture render.
  - underwaterProps = {group: new Group() /*empty dummy*/, activeCounts: {}}: game.js toggles this group invisible in the above-water main pass, so the real underwater content lives on NG_LAYER.UNDERWATER instead. It is excluded from reflection by layer mask and stays visible through refraction.
  - waterPlants = {submergedMeshes: []}

WATER FACADE (src/water.js)
- surfaceY(x,z) = depthAt ≤ 0 ? 0 : waveHeight(x, z, time, wind)·shoalGain(depth). This is identical to the old water.js:1013-1017.
- surfaceNormal is the old waveNormal expression.
- The GPU uses waveGLSL('ng') with vertical-only displacement: ngWaveH·wind·ngShoalGain(depth from the height grid). The old visual Gerstner horizontal shift is dropped, so the picture equals the physics.
- The only difference is depth: grid-bilinear on the GPU vs analytic on the CPU, below 1 cm. The lab readback test asserts < 5 mm.
- The one-frame lag (the bobber evaluates before water.update) is unchanged and is about 0.5 mm.
- lake-calm-water-test keeps the physics part (amplitude, speed and run-up), because waveField.js is untouched.
- update(dt, camera, env):
  - time += dt, which freezes on pause
  - wind = 1 + rain·0.92 + cloud·0.14
  - optics.update writes the 6 dynamic causticsUniforms each frame, by value
  - ripple and splash bookkeeping
  - camera.updateMatrixWorld()
- addRipple and addSplash use ring buffers and never throw.
- capture() → pipeline.prepare(), which runs the shadow update exactly once per frame. captureReflection() → the reflection pass (it may no-op). Both are safe in any order and on repeat calls.
- setCaptureHidden(list) is stored as a no-op. setReflectionHidden(list) is honoured by a visible toggle in the reflection pass.
- getUnderwaterContext keeps its shape.
- setUnderwaterView(on) sets the core underwater target.
- uniforms.uLinearOut exists at construction (value 1). uniforms.uShallow and uDeep are THREE.Color.
- causticsUniforms keeps the same reference.
- rt = the sceneColor RT. reflRT = the reflection RT or null.

ENVIRONMENT FACADE (src/sky.js)
Exports Environment and WEATHERS, whose values are byte-identical.
- The weather state machine is ported verbatim from sky.js:317-334: weighted draw, same weather ×0.35, 2.5–6.5 h duration.
- The weatherTimer field is writable (multiplayer holds it ≥ 1e8).
- setWeather ignores invalid keys, damps with λ ≈ 0.35/s, and takes an added {instant: true} option for the harness.
- rainIntensity, cloudiness, nightAmount.
- sunDir and keyDir are updated in place.
- The colours sunColor, zenithColor, horizonColor, fogColor.
- underwater setter.
- sky, rain, skyUniforms.uStars / uLinearOut.
- sun (DirectionalLight, castShadow, with sun.shadow.map read by perf; always visible).
- scene.fog = new THREE.Fog, with near and far set every frame from the medium's CPU twin. This keeps USE_FOG on and satisfies debug.js near.toFixed.
- The Environment is constructed before the lake, as before.
- Sky and light are pure functions of the hour and the damped weather.

POSTFX FACADE (src/postfx.js)
- constructor(renderer, scene, camera, {quality, water, sky, exposure}) sets renderer.toneMapping = NoToneMapping. This overrides game.js line 302, so ACES is not applied implicitly. The exposure is explicit and owned here.
- setSize, setQuality, updateUnderwater(ctx) and render(dt) never throw. They catch, log and render a fallback copy.
- composer and bloom are compatibility shims for the performance.js RT estimate.

CAUSTICS WITH FISH
- src/shaders.js exports CAUSTICS_GLSL (new body, same signature and uCaust* names) and createCausticsUniforms().
- game.js:353-374 changes one import: the 16-field object is now built by the factory, still before Terrain and FishSchool, and it never changes identity.
- fish.js:965-975 injects it unchanged, and remoteFish takes the same path.
- The global chunks never declare those names.
- The fish's own uTime/uAmp/uFreq/uLen/uBend and vFishWorldPos are untouched. The fog-chunk varying is vNgWorld, so there is no collision.

CHARACTERS
- They get the ng medium and fog through ShaderLib, the key light (with near shadows), the SH probe and the lamp. There is no scene.environment, so the tuned low-metalness look stays.
- The angler, rod and bobber render in the opaque call, so they appear in the refraction copy and in the planar reflection.
- Markers and aimMarker (fog:false, renderOrder 6) render in the late call, so they are always visible above the water.

GAME.JS CHANGES (the complete list)
1. Import createCausticsUniforms instead of createCausticTexture.
2. await this.terrain.ready in the 'Bed' step.
3. Nothing else. The ?v= query strings stay, and the render block, the applyQuality flow and the fish counts 14/22/30 are unchanged.

DEBUG.JS
Compatible as is: g.water.wind, scene.fog.near/far, terrain obstacles/_obsGrid/_dockU/_dockLen/_dockLocal/structures, and the dock boxes at debug.js:110 and 144-145 (the dimensions are unchanged). Debug objects draw in the late call, so they stay visible over the water.

EXCEPTION SAFETY
- Every module update and every pass is guarded.
- Shader failures swap the fallback material through onShaderError.
- A context loss suspends rendering instead of throwing.
- The facade methods called from game.update contain no throw paths, so the multiplayer wrapper's sharedFish.update, sendVisual and sendFightPosition always run.

## assets
PRINCIPLE: no downloaded or third-party assets. Everything is produced by our code.
- (a) Offline Node bakes, deterministic and committed: only where CPU-heavy growth algorithms pay off. Hard budget ≤ 3 MB committed; alarm at 4 MB.
- (b) GPU forge at load: all textures.
- (c) CPU workers at load: data grids, FFT, rocks.
- The rebuild target is ≤ 3.5 s added on M1 Pro, against a 6 s cap.

OFFLINE (scripts/bake/*, run with `node scripts/bake/all.mjs`; the outputs are byte-reproducible and checked by a test that re-bakes and compares the hash)
- assets/gfx/trees/trees.bin (≈ 2.0 MB) and trees.json (≈ 20 KB):
  - 4 sugi + 4 buna + 2 sapling variants
  - LOD0 and LOD1 each
  - 20 B quantised vertices, uint16 indices
  - wind and AO attributes
  - loaded with fetch + DataView decode in ≈ 60 ms
- Nothing else is offline. Snags, rocks, dock, boat, reeds, grass and lily meshes are generated at load, because they are cheap.

GPU FORGE AT LOAD (≈ 350 ms total GPU on M1 Pro; each bake is a full-screen fragment program into an RT or array RT, then mips; the scratch RTs are released)
- Terrain layers: 8 layers × 2 arrays (albedo+height, normal/rough/AO) RGBA8. 1024² on high (≈ 85 MB with mips), 512² on mid/low (≈ 21 MB). ≈ 60 ms.
- farAlbedo: 2048² RGBA8 with mips (22 MB), a top-down render. ≈ 40 ms.
- ngShoreDist: R16F 1024², jump flood in 11 passes, ≈ 8 ms.
- ngNormalNear/Far: RGBA8, ≈ 3 ms.
- Cover map: RGBA8 1024². Canopy: RG8 1024². ≈ 5 ms.
- Bark: 2 species × 2 maps × 512².
- Foliage atlases: 2 × 2 maps × 1024² (512² on mid/low), coverage-preserving mips. ≈ 60 ms.
- Impostors: 8 variant layers × 2 maps × 1024² on high (≈ 85 MB; 21 MB mid, 5 MB low). ≈ 150 ms.
- Wood arrays (dock): 4 layers × 2 × 512². Rock arrays: 3 × 2 × 1024² on high. ≈ 30 ms.
- Water:
  - foam noise 512² R8
  - detail normals (32 × 256² RG8 = 4 MB; the Toksvig variance goes into a second array or the mip alpha), uploaded from the worker result
  - caustics: 16 × 512² RGBA8 = 16 MB on high, 8 × 256² on mid/low, ≈ 20 ms
- Sky:
  - cloud Perlin-Worley 64³ RGBA8 (1 MB) and detail 32³
  - cirrus 1024² R8
  - moon 512²
  - blue noise 64²
  - LUTs
  - ≈ 30 ms

CPU WORKERS AT LOAD (module workers: the lakefield import is DOM/three-free and safe)
- Heightfield: 1.5M heightAt calls at 0.45 µs, spread over 4 workers, ≈ 0.25 s wall. Plus the bed map (65k bedAt calls).
- FFT detail spectrum: 32 periodic inverse FFTs at 256², ≈ 0.4 s in 1 worker, overlapped.
- Rocks: 8 variants × 3 LODs, ≈ 0.15 s.
- Placement: synchronous in the Terrain constructor, ≤ 250 ms.
- Transfers use transferable ArrayBuffers.

LOAD SCHEDULE (the existing progress steps; each awaits and yields)

| Step | Work | Target |
| --- | --- | --- |
| loadingSky | core install, NgFrame, forge, sky LUT/noise bakes | 0.15 s |
| Lake | resolveLake (existing), heightfield workers (started earlier by load*Textures), placement, collision | 0.5 s |
| Bed | terrain.ready: terrain textures + CDLOD + farAlbedo, trees decode/forge/impostors, groundcover, shoreflora, hardscape | 1.3 s |
| Water | FFT upload, caustics bake, water mesh, RTs | 0.15 s |
| FishTex / Fish / Angler / Rods | unchanged | — |
| Ready | renderer.compileAsync(scene, camera) using KHR_parallel_shader_compile, then 3 warm-up frames of every pass (reflection, shadow, late, post) behind the loading screen | ≤ 1.5 s |

- Program budget: ≤ 48 environment programs in total, because uniforms (not defines) drive pass and weather differences.
- Per-module load budgets are tracked by core (Budget.load) and printed in the lab.

VRAM TOTALS
- high ≈ 820 MB (RTs ≈ 440 MB, of which MSAA 4× RGBA16F at 1440p is ≈ 177 MB including depth; textures ≈ 380 MB)
- mid ≈ 330 MB
- low ≈ 140 MB

## qualityTiers
KEYS stay 'low' | 'mid' | 'high' (persisted). Rows marked * are gameplay-neutral visual subsets. Collision is identical on every tier.

| Feature | low | mid | high |
| --- | --- | --- | --- |
| pixelRatio cap (existing) | 1 | 1.5 | 2 |
| DRS render-scale range (off under capture) | 0.6–1.0, target 33 ms | 0.75–1.0, target 16.6 ms | 0.7–1.0, target 16.6 ms |
| mainRT | RGBA16F, no MSAA (fallback RGBA8 if no float RT) | RGBA16F | RGBA16F, MSAA 4× + alphaToCoverage |
| post AA | FXAA | SMAA medium | none (MSAA) |
| scene copy | half res, no mips | full res | full res + 4 mips |
| near shadow | 1024², ±30 m, PCF r1 | 2048², ±40 m | 3072², ±48 m |
| far shadow | off (cloud shadow only) | 1024², ±512 m, every 4 s, sliced | 2048², every 3 s, sliced |
| planar reflection | off → probe cube 256 (1 face/frame every 20 s) | 0.5× res, every frame, LOD bias 2 | 0.6× res, every frame |
| ripple cascades | 1 × 256² (256 m) | 2 × 512² | 2 × 512² |
| water detail normals | 16 × 128², 2 scales | 32 × 256², 2 scales | 32 × 256², 3 scales + glints |
| water mesh | 64² base, 4 rings | 96², 5 rings | 128², 5 rings |
| caustics | 8 × 256², strength 0.32 | 8 × 256², 0.72 | 16 × 512², 1.0 |
| underwater god rays | analytic glow | 8 steps, half res | 16 steps, half res |
| plankton | 150 | 400 | 800 |
| clouds | 2D fbm layer + cirrus | raymarch 8 steps, half res | raymarch 12 steps + 3 light taps, half res |
| terrain CDLOD | 17² patch, ranges ×0.6, 1 m near grid | 33² patch, ×0.75 | 33² patch, ×1.0, 0.5 m near grid |
| terrain textures | 512², dual-scale | 512², hex top-1 | 1024², hex top-2 |
| trees* visual (≤ 420 m; colliders always drawn) | 10k | 25k | 45k |
| tree LOD0 / LOD1 / impostor / shell (m) | 20 / 70 / 250 / 230 | 30 / 100 / 320 / 300 | 45 / 140 / 420 / 380 |
| impostor frames | 8×8 @ 64² | 8×8 @ 96² | 8×8 @ 128² |
| foliage atlas | 512², alphaTest | 512², alphaTest | 1024², A2C |
| grass clumps / radius | 4k / 18 m | 12k / 25 m | 25k / 32 m |
| sasa & ferns* | 30% | 60% | 100% |
| reeds* | 6k | 15k | 30k |
| lily pads* | 600 | 1.5k | 3k |
| weed strands* | 1.2k | 3k | 6k |
| non-colliding rocks & pebbles* | 40% | 70% | 100% |
| rain streaks / ground splashes | 2.5k / 150 | 6k / 250 | 12k / 400 |
| splash droplet pool | 256 | 512 | 1024 |
| mist sheets / fireflies / motes | 16 / 60 / 0 | 32 / 120 / 150 | 60 / 200 / 300 |
| bloom | off | 5 levels | 8 levels |
| sun shafts | off | 16 samples, ¼ res | 24 samples, ¼ res |
| fish count (gameplay, unchanged) | 14 | 22 | 30 |
| GPU budget, ours + characters | ≤ 25 ms at 1080p on Iris Xe-class (30–40 fps "playable") | ≤ 13 ms at 1080p on base M1 (60 fps) | ≤ 14 ms at 2560×1440 on M1 Pro (60 fps, 2.6 ms headroom + DRS) |
| VRAM | ≈ 140 MB | ≈ 330 MB | ≈ 820 MB |

HIGH-TIER BUDGET SUM (ms)

| Item | ms |
| --- | --- |
| core overhead (copy 0.15, resolves 0.35, far-shadow slice 0.3, probe 0.15) | 0.95 |
| sky | 1.00 |
| water | 1.10 |
| terrain | 2.00 |
| trees | 3.10 |
| groundcover | 1.35 |
| shoreflora | 1.00 |
| hardscape | 0.90 |
| weatherfx | 0.40 |
| post | 1.00 |
| characters (reserved) | 1.20 |
| **total** | **≈ 14.0** |

When the camera is underwater, the reflection column (≈ 1.8 ms) is replaced by the underwater post (1.2 ms).

Tier change: game.applyQuality → the facades → each module's setQuality. Changes are subset rebuilds and RT reallocations; the tier define in the cache key forces a single recompile, done inside applyQuality's existing renderer.compile. Light count and castShadow never change. settings.shadow toggles renderer.shadowMap.enabled and FarShadow.enabled; cloud shadows stay.

## buildOrder
PHASE −1 (Core-A, half a day): safety net
- Record fixtures from the OLD code with scripts/capture-fixtures.mjs: the Terrain, Water and Environment behaviour listed in the gameplay contract, plus baseline screenshots, which already exist.
- Reorder scripts/run-tests.mjs so the 17 KEEP tests and walk-zone run first. Mark the 15 GRAPHICS tests for deletion together with the old files.

PHASE 0 (Core-A and Core-B in parallel, about 2 days): "grey-box game on the new pipeline"
Core-A (render core):
- chunks.js with the ShaderLib ngFrame patch and boot self-check
- frame.js, medium GLSL and its JS twin
- extend.js with the anchor test
- layers
- pipeline.js: RTs, prepare, reflection, opaque, copy, late, the late-object scan, guards, context loss
- shadows (near fit, far infrastructure)
- quality and DRS hooks
- forge with the noise library and blue noise
- budget and timers
- src/postfx.js facade with a minimal chain (Exposure + AgX + FXAA), then a spike to confirm pmndrs standalone EffectPass versus the composer wrapper
- src/shaders.js facade: CAUSTICS_GLSL placeholder (analytic, sampler2DArray 1×1) and createCausticsUniforms
- labkit and lab-matrix.mjs
- grey-box stubs for all 9 modules at src/gfx/<m>/index.js:
  - sky: analytic gradient with the light rig
  - water: flat fresnel surface on the real pipeline, refraction and reflection
  - terrain: a heightfield mesh coloured by slope
  - trees: instanced cones at the placement positions
  - others: empty or simple

Core-B (world core):
- src/world/* (heightgrid, placement, species, dock, collision, queries)
- the heightfield workers and GPU textures
- the Terrain facade (full gameplay API and render hooks forwarding to modules, the compatibility shims, `ready`)
- the Water facade (physics, pools, API shape)
- the Environment facade (weather state machine port, fog object, fields)
- the Wind module
- the two game.js edits
- deleting the old graphics files and GRAPHICS tests
- the new Node tests

GATE G0 (the API freeze)
- node scripts/run-tests.mjs is green.
- The game boots in grey-box on all 3 tiers.
- smoke-all passes: 1200 frames, time sweep, weather cycle, tier switches, underwater toggle, FP toggle, resize.
- Multiplayer browser test is green.
- Grey-box GPU < 5 ms on M1 Pro at 1440p.
- Load added < 2 s.
- docs/nextgen/CORE_API.md is generated from the JSDoc of the frozen interfaces: ngFrame layout, layers, pass ids, ctx and f shapes, uniform names, GLSL helper names.

PHASE 1 (9 module agents in parallel, about 4–6 days; each works only in its own directory, its own lab page, scenarios and tests)

| Agent | Module | Notes |
| --- | --- | --- |
| 1 | sky | |
| 2 | water | |
| 3 | underwater | caustics + post effect |
| 4 | terrain | |
| 5 | trees | including the Node baker |
| 6 | groundcover | |
| 7 | shoreflora | |
| 8 | hardscape | |
| 9 | weatherfx + post | one agent |

Dependency graph: every module depends only on the core and facades, never on another module's code. The runtime data flows are all mediated by core:
- sky → ngFrame and SkyServices → everyone
- water ↔ underwater share the FFT worker result via ctx.workers
- underwater → post via createEffect(); post falls back to "no effect" if it is null
- terrain → groundcover via terrain.coverRules GLSL, published as a core-registered string with a stub default
- trees → hardscape impostor API (optional)

Each agent works against the stubs, so it never waits.

Merge rule: a module may land on fork/nextgen-graphics when all of these hold:
- its lab proof set is shot and checked into .gfx-shots/ (as review artefacts, not committed binaries)
- it is within budget on high at 1440p and on mid at 1080p on the M1 Pro proxy (mid × 0.5 frame-time scaling rule)
- smoke-all is green with the module enabled
- there are no console errors
- run-tests is green

Every module can be disabled at runtime with ?ng=-trees,-grass for bisecting. Core-change requests go to Core-A or Core-B, who stay on duty for triage and small additions to the reserved ngFrame slots during phase 1.

PHASE 2 (Core-A plus one look-dev integration agent, about 2 days)
- Full-game look-dev across the 7 baseline views plus underwater, cloudy and night-rain.
- Cross-module albedo and roughness calibration against a lab albedo chart.
- Grade keys.
- Budget rebalancing with the real per-pass GPU timings.
- Load-time profiling.
- Memory check.
- Final baseline-next.mjs screenshot set at 1280×720 and 2560×1440.
- README graphics notes.
- Cleanup of stubs, which stay as runtime fallbacks.

## testPlan
NODE TESTS (scripts/run-tests.mjs; the KEEP tests run first; each new test targets < 3 s)
1. lake-invariance: resolveLake(123456789).tries === 1. A SHA-256 over makeLake(123456789), covering the heightAt 64×64 grid, structures, flats, holes and dock JSON, equals the constant recorded at c8490ed.
2. terrain-api-parity: every fixture from phase −1 (heightAt, depthAt, slopeAt, bedAt, normalAt, isWater, shoreRadius, onDock, distToDock, dockBlocksSegment, lineBlocked with terrain hits, structureNear, spawnPos, dock fields) matches to 1e−9. The obstacle-driven cases are compared against the new placement fixtures.
3. placement-determinism: buildPlacement run twice gives byte-identical output. The collision set (obstacles Float32Array hash) is identical for low, mid and high. Visual subsets are nested. No Math.random appears in src/world or src/gfx (grep lint).
4. collision-dims:
   - trunk r = max(trunkR·h·1.15, 0.28), top 0.9·h
   - boulder rule size > 1.4 ∧ h > −0.9
   - lamp r 0.26 at dockY + 2.3
   - boat 2 × 0.85
   - thicket ring radius ∈ [shoreR + 67, shoreR + 76]
   - clearances from dock and spawn
   - structures exactly at lake.structures
   - reeds only where isEdge; weeds only in flats
5. species-bake-consistency: trees.json baseRadius per variant is within 2% of SPECIES.trunkR. Re-baking reproduces the trees.bin hash.
6. wave-agreement:
   - waveGLSL('ng') constants match W and SHOAL_BUMP.
   - surfaceY and surfaceNormal equal the old fixtures on a 50 × 20 point × time grid.
   - The lake-calm-water physics section is retained.
7. weather-api:
   - WEATHERS is identical.
   - Over 10k draws of tickWeather with Math.random stubbed, the weights and the ×0.35 repeat factor hold within tolerance, and durations lie in 2.5–6.5 h.
   - setWeather ignores invalid keys.
   - weatherTimer is writable and dt = 0 freezes.
   - {instant: true} snaps.
8. core-chunks (the vendored three imported in Node): every anchor used by ngExtendStandard exists in ShaderChunk/ShaderLib (standard, physical, depth, distance). The fog chunks are patched and ShaderLib entries carry ngFrame. cloneUniforms keeps the Float32Array by reference. No global chunk declares a non-ng identifier or any uCaust*/causticLight/cs* name.
9. ngframe-layout: the generated GLSL #defines equal the JS table. The producer ownership map covers every slot exactly once.
10. medium-twin: sample ngApplyMedium's JS twin at 1000 random segments and check the closed-form optical depth against a 256-step numeric integral (< 1%). Check the scene.fog near/far derivation is monotonic.
11. performance-test (MIXED): the kept strings, including 'addRT(game.env?.sun?.shadow?.map)' and the estimateRtBytes shape, now reading pipeline RTs through the shims.
12. walk-zone-test (MIXED): the game.js walking and camera strings, thicket-ring blocking, and blockedAt(y).

BROWSER TESTS (scripts/gfx/*.mjs through shot.mjs on the M1 Pro)
- smoke-all:
  - index.html single-player
  - 1200 frames: sweep clock 0→24 in steps of 0.25 h, cycle the weather, switch tier low→mid→high→mid, toggle underwater on/off 4 times, toggle FP, resize ×2, toggle settings.shadow
  - assert 0 page exceptions and 0 console errors
  - assert renderer.debug onShaderError was never called
  - every 60 frames: a gl.getError() probe (lab mode only) and a centre-pixel readback that is not NaN, black or white-clipped
- mp-browser-test (existing): passes with the new graphics, two peers on different tiers; also check the obstacle hash is logged equal on both.
- wave-readback (lab/water.html): GPU vs CPU displacement at 64 points < 5 mm, and fish-vs-bed clamp visual check.
- terrain-readback: GPU height vs sampleGrid on a 256² grid < 5 cm, and < 2 cm inside the walk band.
- caustics-fish: the real createFishMaterial compiles with the new CAUSTICS_GLSL, the uniform identity is preserved after the bake swap, and the caustic luminance on a fish at 3 m depth is > 0 at noon and 0 above the water.
- sampler-audit: enumerate every linked program, and require ≤ 12 fragment and ≤ 4 vertex samplers.
- perf-matrix:
  - Chrome with --disable-gpu-vsync --disable-frame-rate-limit.
  - Views: 6 standard ones plus rain plus underwater, at 2560×1440 high and 1920×1080 mid, DRS disabled.
  - Record the median and p95 frame times and the per-pass GPU timings (when timer queries are available).
  - Fail if high p95 > 16.0 ms, or mid 1080p on M1 Pro > 8.0 ms (the proxy for base M1 at 16 ms), or any module exceeds its budget by more than 25%.
- load-time: build() wall time from 'loadingSky' to 'Ready', 3 runs cold cache. Fail if the added time is > 6 s; warn if > 4 s. Per-module load budgets are reported.
- memory: sum the RT and texture estimate against the tier caps.
- visual-sanity (automated): the mean luminance per standard view is within the expected band for its time of day. The horizon step between terrain and sky is < 4%. There is no large region of pure black or white. A downsampled reflection of the far shore in the dock-fp morning view correlates > 0.6 with the vertically flipped shore band, which proves the mirror.
- visual review (human/agent): baseline-next.mjs at the 7 baseline views plus underwater, cloudy and night-rain, compared side by side with the old baseline PNGs. Each module lab proof set is attached to its merge.

## topRisks
1. THE GLOBAL SHADERLIB/CHUNK PATCH is the keystone of consistent lighting and fog for the untouched characters.
   - Risk: it relies on cloneUniforms passing Float32Array values by reference, and on the fog chunks being included in every program.
   - Mitigations:
     - Node test on the vendored r180.
     - Boot self-check, with automatic fallback to plain THREE.Fog (core.degraded = 'fog').
     - Only ng-prefixed names.
     - three stays vendored and pinned.

2. SHADER COMPILE AND LOAD TIME ON ANGLE/METAL.
   - Risk: too many programs and variants blow the 6 s budget.
   - Mitigations:
     - A program budget of ≤ 48.
     - Uniform-driven pass and weather branches, no defines.
     - compileAsync with KHR_parallel_shader_compile and warm-up frames.
     - Workers started early by the load*Textures hooks.
     - Per-module load budgets enforced in the lab.
     - Offline tree bake to avoid CPU growth at load.

3. GPU BUDGET AT 2560×1440.
   - Risk: MSAA 4× on RGBA16F, foliage overdraw and grass vertex cost.
   - Mitigations:
     - Per-module budgets checked at every merge.
     - The overdraw debug view.
     - LOD1 used for shadow casters.
     - Half/quarter-resolution effects.
     - Reflection with a LOD bias and no grass.
     - DRS as a safety net (0.7–1.0).
     - Fallbacks: MSAA 2× + SMAA if the 4× resolve or memory is too costly; drop the high-tier third normal scale and glints.

4. THE TWO-CALL MAIN PASS AND THE LATE-OBJECT SCAN.
   - Risk: a game transparent object is drawn before the water and hidden by it.
   - Mitigations:
     - A conservative rule (transparent, depthTest false, or renderOrder ≥ 5).
     - A per-frame scan, and a lab overlay listing the late objects.
     - smoke-all checks that markers, the bobber ring, the line and labels are visible above water.
     - Layer 0 is kept on tagged objects, so raycasts are unaffected.

5. GAMEPLAY AND MULTIPLAYER DIVERGENCE.
   - Risk: placement or collision differs between tiers or peers, or the visuals disagree with the fish bonus zones.
   - Mitigations:
     - A three-free, seeded, grid-anchored placement.
     - Collision independent of tier.
     - Fixtures from the old code.
     - Tests for 葦際, 藻場 and structure correspondence.
     - The obstacle hash logged in multiplayer.
     - lakefield untouched, with a hash test.

6. PER-FRAME EXCEPTIONS STALLING MULTIPLAYER SYNC.
   - Mitigations:
     - Guard wrappers and module self-disable.
     - Pass guards.
     - onShaderError fallbacks.
     - Context-loss suspension.
     - Pools that never throw.
     - NaN-clamping of API inputs.
     - A smoke test with zero errors.

7. LOOK INCOHERENCE ACROSS 9 AGENTS.
   - Risk: exposure, albedo or colour drift between modules.
   - Mitigations:
     - One radiometric unit system.
     - Albedo ranges in the core documentation, plus the lab albedo chart.
     - Tone mapping and grade owned only by post.
     - Horizon auto-matching.
     - Characters in every lab.
     - A phase-2 look-dev pass.

8. WATER EDGE CASES.
   - Risks: the camera crossing the surface, refraction leaks, far glitter aliasing, cascade seams, the reflection missing at the screen top.
   - Mitigations:
     - A per-pixel waterline mask and damped uwStrength.
     - The refraction validity test.
     - Toksvig filtering.
     - Cascade fade.
     - A probe/sky fallback.
     - The wave readback test for physics equality.

9. MEMORY ON HIGH (≈ 820 MB) AND WEAK iGPUs.
   - Mitigations:
     - Tier texture sizes.
     - Low has no MSAA, far shadow or planar reflection.
     - A float-RT capability check with an RGBA8 / R16F fallback path.
     - Allocation checks (gl.getError after RT creation) that degrade the tier's MSAA or reflection instead of failing.

10. WEBGL LIMITS.
    - Risks: 16 texture units, float filtering, and ANGLE compiler quirks.
    - Mitigations:
      - A sampler audit (≤ 12 / ≤ 4).
      - R32F only through texelFetch; half float everywhere that needs filtering.
      - Constant loop bounds.
      - Float hashes rather than uint.
      - No dynamic indexing into sampler arrays.

11. PARALLEL-EDIT COLLISIONS.
    - Mitigations:
      - Strict directory ownership.
      - Facades and core owned by the core agents.
      - Stubs at fixed import paths, so no shared registry file.
      - A reserved-slot protocol for ngFrame.
      - ?ng= flags to bisect a regression to one module.
