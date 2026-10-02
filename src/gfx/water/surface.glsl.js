/* ===========================================================
   水面のシェーダ（表と裏を 1 本で。全段で同じ GLSL、段の差は uniform）
   -----------------------------------------------------------
   頂点：y = ngWaveH·wind·ngShoalGain(ngDepth)（NG_WAVE_GLSL。CPU の surfaceY と同じ式。縦だけ）。
         空気（水中なら水）の区間の透過と内散乱は頂点で（滑らかなので）
   断片（表）：
     法線 = 波の解析勾配 + 生きた FFT 2 カスケード（風下へ回し、ngWindAt の局所の風で振幅：猫足の斑と鏡の凪）
            + 微細なきらめき（high）+ 解析リング 16 + 波紋シミュ（high）+ 雨の輪
     粗さ = LEAN（mip の 2 次モーメント − 1 次² = 解けない分散）+ 画面の微分の分散（解析波・輪の鏡面の AA）
     反射 = 平面反射 RT を «反射の向き R の 25m 先» の射影で読む（角度の歪みが正しい）。粗さで mip、外れは skyView。
            RT に写った太陽・月の円盤は key の方向の窓でクランプ（鏡面の GGX と二重に数えない）
     鏡面 = GGX（円盤光の粗さの拡張・正規化）× key × ngSunVisibility（近景の影 × 高さ場影 × 雲影）+ 灯籠の点光源
     屈折 = sceneColor を «法線の屈折 − 平らな屈折» の射影の差でずらす。深度で手前の物を拾ったら戻す。吸収は足さない（§3.4）
     汀  = 水柱 0–4cm で F → 0（硬い縁を出さない）、渚の遡上の位相で動く泡の線、杭・岩・ヨシの接触の泡（同じ水柱の項）
   断片（裏）：スネルの窓（臨界角 48.6°）、窓の中は屈折した向きの sceneColor / 空、窓の外は全反射（水の散乱色と暗い湖底）、
              窓の縁の明るさ。カメラ → 水面の水の区間はここで掛ける
   =========================================================== */
import { NG_HEIGHTFIELD_GLSL } from '../core/glsl/heightfield.glsl.js';
import { NG_SKYSPEC_GLSL } from '../core/glsl/surface.glsl.js';
import { NG_SHADOW_GLSL } from '../core/glsl/shadow.glsl.js';
import { NG_WIND_GLSL } from '../core/glsl/wind.glsl.js';
import { NG_WAVE_GLSL } from '../core/glsl/wave.glsl.js';
import { NG_MEDIUM_GLSL } from '../core/glsl/medium.glsl.js';
import { NG_WATER_F0 } from '../core/palette.js';
import { W as WAVES, PHASE_W } from '../../waveField.js?v=20260828-lakescale1';

export const RIPPLES = 16;

const PHF = ['ngWavePhA.x', 'ngWavePhA.y', 'ngWavePhA.z', 'ngWavePhA.w', 'ngWavePhB'];
const f5 = (v) => v.toFixed(6);
/* ゲームの 5 本の波の勾配を «1 本ずつ» 画素の大きさで LEAN する（ngWaveD と同じ式・同じ core の倍精度の位相）。
   画素の足跡（視線方向に 1/V.y で伸びる楕円）を波の進む向きへ射影し、波長の 0.25–0.6 倍を越えた波は
   平均の勾配から抜いて分散 (A·k)²/2 へ移す → 遠くの湖面で解けない波が «鏡のざわつき» ではなく正しい粗さになる */
const WAVE_LEAN_GLSL = (() => {
  let body = '';
  WAVES.forEach((w, i) => {
    if (i >= PHF.length) return;
    const lam = (2 * Math.PI) / w.k;
    body += `  {
    float ph = (${f5(w.dx)} * p.x + ${f5(w.dz)} * p.y) * ${f5(w.k)} - (${PHF[i]} + (t - ngWaterTime) * ${f5(w.om)}) + phase * ${f5(PHASE_W[i])};
    float c = cos(ph) * ${f5(w.amp)};
    vec2 dir = vec2(${f5(w.dx)}, ${f5(w.dz)});
    float fpa = dot(dir, vh) * fpAlong, fpc = dot(dir, vp) * fpAcross;
    float fade = smoothstep(${f5(0.22 * lam)}, ${f5(0.6 * lam)}, sqrt(fpa * fpa + fpc * fpc));
    d += vec2(${f5(w.k * w.dx)} + ${f5(PHASE_W[i])} * pg.x, ${f5(w.k * w.dz)} + ${f5(PHASE_W[i])} * pg.y) * (c * (1.0 - fade));
    var += fade * ${f5(0.5 * (w.amp * w.k) ** 2)};
  }
`;
  });
  return /* glsl */ `
vec2 ngWaterWaveLean(vec2 p, float t, vec2 vh, float fpAlong, float fpAcross, out float var) {
  float phase = ngWavePhase(p);
  vec2 pg = ngWavePhaseGrad(p);
  vec2 vp = vec2(-vh.y, vh.x);
  vec2 d = vec2(0.0);
  var = 0.0;
${body}  return d;
}
`;
})();

/* 風速 → 細波の振幅（基準の風 3.5m/s のスペクトルに掛ける）。毛管の細波は «風が閾値を越えた所» にだけ立つ
   （猫足の斑）。粗いカスケードは湖全体の風で、凪でも少し残る（鏡の歪み） */
const AMP_GLSL = /* glsl */ `
/* 突風の斑（猫足）：局所の風速が湖全体の風速をどれだけ越えたか。凪の日も斑の中だけ細波が立つ */
float ngWaterPatch(float U, float Ug) {
  return smoothstep(0.06, 0.30, U / max(Ug, 0.3) - 1.0);
}
/* 全体の風の強さ（clear 1.4 → 0、cloudy 3.0 → 0.5、rain 5.0 → 1） */
float ngWaterWindy(float Ug) { return smoothstep(1.5, 4.6, Ug); }
/* 細かいカスケード（λ 1.7cm–36cm、単位の σ ≈ 0.17）：凪の所は σ ≈ 0.003 の鏡、斑の中は σ ≈ 0.05 */
float ngWaterFineAmp(float U, float Ug, float rain) {
  float pt = ngWaterPatch(U, Ug), wy = ngWaterWindy(Ug);
  return 0.018 + 0.30 * pt + wy * (0.25 + 0.35 * pt) + 0.5 * rain;
}
/* 粗いカスケード（λ 36cm–4.5m、単位の σ ≈ 0.08） */
float ngWaterCoarseAmp(float U, float Ug, float rain) {
  float pt = ngWaterPatch(U, Ug), wy = ngWaterWindy(Ug);
  return 0.05 + 0.16 * pt + wy * 0.45 + 0.25 * rain;
}
`;

export const WATER_VS = NG_HEIGHTFIELD_GLSL + NG_WIND_GLSL + NG_WAVE_GLSL + NG_MEDIUM_GLSL + /* glsl */ `
#include <common>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>
uniform vec2 uSnap;
uniform float uTime;
uniform float uWind;
uniform vec4 uDbg;
uniform vec4 uLakeBox;        // 湖を囲む箱（min x, min z, max x, max z）。外の頂点は縁へ寄せて三角形を潰す（遠くの陸の上の細かい三角形を描かない）
in vec3 aEdge;
out vec3 vWorld;
out float vViewZ;
out vec4 vWnd;
out float vShoal;
out vec3 vSegT;
out vec3 vSegL;
float ngWaterAt(vec2 p) {
  float d = ngDepth(p);
  return d <= 0.0 ? 0.0 : ngWaveH(p, uTime) * uWind * ngShoalGain(d);
}
void main() {
  vec2 p = clamp(position.xz + uSnap, uLakeBox.xy, uLakeBox.zw);
  if (uDbg.z > 2.5) {
    vWorld = vec3(p.x, 0.0, p.y); vShoal = 1.0; vWnd = vec4(1.0, 0.0, 1.0, 0.5); vSegT = vec3(1.0); vSegL = vec3(0.0);
    vec4 mvP = viewMatrix * vec4(vWorld, 1.0); vViewZ = -mvP.z; gl_Position = projectionMatrix * mvP; vNgWorld = vWorld; vNgCloud = 1.0;
    return;
  }
  float h = aEdge.z > 0.5 ? 0.5 * (ngWaterAt(p - aEdge.xy) + ngWaterAt(p + aEdge.xy)) : ngWaterAt(p);
  vec4 worldPosition = vec4(p.x, h, p.y, 1.0);
  vWorld = worldPosition.xyz;
  float d = ngDepth(p);
  vShoal = d <= 0.0 ? 0.0 : ngShoalGain(d);
  vWnd = ngWindAt(p);
  /* カメラ → 水面の区間（表：空気、裏：水）。点ごとに 1 回だけ（§3.4） */
  if (ngUwStrength > 0.5) ngWaterSegment(cameraPosition, worldPosition.xyz, vSegT, vSegL);
  else ngAirSegment(cameraPosition, worldPosition.xyz, vSegT, vSegL);
  vec4 mvPosition = viewMatrix * worldPosition;
  vViewZ = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  vec3 transformedNormal = normalMatrix * vec3(0.0, 1.0, 0.0);
  #include <shadowmap_vertex>
  #include <fog_vertex>
}
`;

export const WATER_FS = NG_SKYSPEC_GLSL + NG_WAVE_GLSL + WAVE_LEAN_GLSL + AMP_GLSL + /* glsl */ `
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
#include <fog_pars_fragment>
` + NG_SHADOW_GLSL + /* glsl */ `
uniform sampler2D ngSceneColor;
uniform highp sampler2D ngSceneDepth;
uniform sampler2D ngReflection;
uniform mat4 ngReflMatrix;
uniform float ngReflValid;
uniform vec4 ngScreen;
uniform float ngCopyMips;
uniform float uTime;
uniform float uWind;
uniform sampler2D uFft0;
uniform sampler2D uFft1;
uniform vec2 uFftL;
uniform sampler2D uSim;
uniform vec4 uSimXf;          // x, z = 窓の中心（m）、z = 1/窓の一辺（1/m）、w = 有効なら 1
uniform sampler2D uFoam;
uniform vec4 uTierW;          // x = 微細なきらめき, y = 反射の mip 段, z = 反射の px/rad, w = 描くカメラの 1 画素の角 rad
uniform vec4 uRipple[${RIPPLES}];   // x, z, 開始時刻, 大きさ（生きている物だけを先頭に詰める）
uniform float uRippleDur[${RIPPLES}];
uniform int uRippleN;
uniform vec4 uDbg;            // 計測用の切り替え（x: 細波, y: 反射, z: 屈折, w: 鏡面）。0 = 全部
uniform vec3 uLampPos;        // 灯籠の世界の位置（pointLights[0] の位置はビュー空間なので CPU から）
in vec3 vWorld;
in float vViewZ;
in vec4 vWnd;
in float vShoal;
in vec3 vSegT;
in vec3 vSegL;

#define NG_F0 ${NG_WATER_F0.toFixed(3)}

/* 解析リング：ウキ・魚・着水の輪の列（分散で外ほど波長が伸び、3 つほどの山が r = v·age を走る）。
   振幅は年齢と √半径で減る。勾配（dh/dx, dh/dz）を返す */
vec2 ngRippleSlope(vec2 p) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < ${RIPPLES}; i++) {
    if (i >= uRippleN) break;
    vec4 R = uRipple[i];
    float age = uTime - R.z;
    float dur = uRippleDur[i];
    if (age < 0.0 || age > dur) continue;
    vec2 dv = p - R.xy;
    float d = length(dv);
    float sz = R.w;
    float r = age * (0.26 + 0.10 * sz);
    float lam = 0.055 + 0.035 * sz + 0.05 * age;
    float sig = 1.3 * lam + 0.03 * sz;
    float x = d - r;
    if (abs(x) > 3.0 * sig) continue;
    float env = exp(-(x * x) / (sig * sig));
    float life = 1.0 - age / dur;
    float A = sz * 0.0045 * life * life / sqrt(1.0 + r / 0.25);
    float k = 6.2831853 / lam;
    float s = -A * env * (k * sin(k * x) + 2.0 * x / (sig * sig) * cos(k * x));
    g += s * dv / max(d, 1e-3);
  }
  return g;
}

/* 波紋シミュ（high）：世界に固定した繰り返しの格子（窓の中だけ有効）。中央差分の勾配 */
vec2 ngSimSlope(vec2 p) {
  if (uSimXf.w < 0.5 || uDbg.w > 1.5) return vec2(0.0);
  vec2 rel = (p - uSimXf.xy) * uSimXf.z;
  float edge = max(abs(rel.x), abs(rel.y));
  if (edge > 0.5) return vec2(0.0);
  vec2 uv = p * uSimXf.z;
  float e = 1.0 / 512.0;
  float hx1 = texture(uSim, uv + vec2(e, 0.0)).r, hx0 = texture(uSim, uv - vec2(e, 0.0)).r;
  float hz1 = texture(uSim, uv + vec2(0.0, e)).r, hz0 = texture(uSim, uv - vec2(0.0, e)).r;
  float inv = 0.5 * uSimXf.z * 512.0;
  return vec2(hx1 - hx0, hz1 - hz0) * inv * (1.0 - smoothstep(0.38, 0.5, edge));
}

float ngGGXD(float NoH, float a2) {
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}
/* Smith の相関した可視項 V = G / (4 NoL NoV) */
float ngSmithV(float NoV, float NoL, float a2) {
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

/* 世界の点 → 画面の uv */
uniform mat4 uViewProj;       // 描くカメラの projection × view（CPU で 1 回）
vec2 ngToScreen(vec3 P) {
  vec4 c = uViewProj * vec4(P, 1.0);
  return c.xy / max(c.w, 1e-4) * 0.5 + 0.5;
}

void main() {
  /* 計測：x = 3 は読み戻し（r = 描いた水面の y、g/b = カメラからの x/z。half でも mm が残る）、x = 2 は一色 */
  if (uDbg.x > 2.5) { gl_FragColor = vec4(vWorld.y, vWorld.x - cameraPosition.x, vWorld.z - cameraPosition.z, 0.25); return; }
  if (uDbg.x > 1.5) { gl_FragColor = vec4(0.05, 0.08, 0.1, 1.0); return; }
  vec2 p = vWorld.xz;
  vec3 Vv = cameraPosition - vWorld;
  float dist = max(length(Vv), 1e-3);
  vec3 V = Vv / dist;
  vec2 suv = gl_FragCoord.xy * ngScreen.zw;
  vec4 wnd = vWnd;
  float rain = clamp(ngRain, 0.0, 1.0);

  /* ---- 法線 ---- */
  /* ゲームの 5 本の波（縦の変位はそのまま）。法線では凪の日ほど弱める：湖にうねりは無く、鏡の歪みが強すぎる */
  /* 画素の足跡（m）：縦の画角の 1 画素の角 × 距離、視線方向は 1/V.y で伸びる */
  float pxAng = uTierW.w;
  float fpX = dist * pxAng;
  float fpL = fpX / max(V.y, 0.03);
  vec2 vh = normalize(-Vv.xz + vec2(1e-5, 0.0));
  float waveS = uWind * vShoal * mix(0.2, 1.0, smoothstep(1.5, 5.0, ngWindSpeed));
  float varW = 0.0;
  vec2 sl = uDbg.y > 1.5 ? vec2(0.0) : ngWaterWaveLean(p, uTime, vh, fpL, fpX, varW) * waveS;
  varW *= waveS * waveS;
  vec2 wd = normalize(ngWindDir + vec2(1e-5, 0.0));
  vec2 wp = vec2(-wd.y, wd.x);
  vec2 q = vec2(dot(p, wd), dot(p, wp));
  float shallow = 0.35 + 0.65 * smoothstep(0.0, 0.6, vShoal);
  float a0 = ngWaterFineAmp(wnd.z, ngWindSpeed, rain) * shallow;
  float a1 = ngWaterCoarseAmp(wnd.z, ngWindSpeed, rain) * shallow;
  vec4 f0 = vec4(0.0), f1 = vec4(0.0);
  if (uDbg.x < 0.5) {
  f0 = texture(uFft0, q / uFftL.x);
  f1 = texture(uFft1, q / uFftL.y + vec2(0.37, 0.61));
  }
  vec2 sd = f0.xy * a0 + f1.xy * a1;
  float var = a0 * a0 * max(f0.z - dot(f0.xy, f0.xy), 0.0) + a1 * a1 * max(f1.z - dot(f1.xy, f1.xy), 0.0);
  if (uTierW.x > 0.0 && dist < 40.0) {
    /* 微細なきらめき：細かいカスケードをもう一度、0.29 倍の大きさ・回して（近くだけ） */
    vec2 q2 = mat2(0.8, -0.6, 0.6, 0.8) * q;
    vec4 f2 = texture(uFft0, q2 / (uFftL.x * 0.29) + 0.5);
    float a2 = a0 * 0.35 * uTierW.x * (1.0 - smoothstep(20.0, 40.0, dist));
    sd += mat2(0.8, 0.6, -0.6, 0.8) * f2.xy * a2;
    var += a2 * a2 * max(f2.z - dot(f2.xy, f2.xy), 0.0);
  }
  sl += sd.x * wd + sd.y * wp;
  vec2 ring = ngRippleSlope(p) + ngSimSlope(p) + ngRainRings(p, ngEnvTime, rain) * 2.4;
  sl += ring;
  /* 鏡面の AA：輪・シミュ・雨は画面の微分から «画素に解けない» 勾配の分散（波は上で 1 本ずつ LEAN 済み） */
  vec2 dsx = dFdx(ring), dsy = dFdy(ring);
  float varGeo = min(0.5 * (dot(dsx, dsx) + dot(dsy, dsy)), 0.03);
  float a2r = 0.0015 * 0.0015 + var + varW + varGeo + 0.004 * rain;
  float alpha = sqrt(a2r);
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
  vec3 col;

  if (gl_FrontFacing) {
    float NoV = max(dot(N, V), 1e-4);
    /* ---- 屈折（sceneColor）と水柱 ---- */
    float sceneZ = texture(ngSceneDepth, suv).r;
    float thickZ = max(sceneZ - vViewZ, 0.0);
    float path = thickZ * dist / max(vViewZ, 1e-3);          // 視線に沿った水中の長さ
    float colW = path * max(V.y, 0.02);                       // 水柱（平らな底の近似の深さ）
    vec3 Tn = refract(-V, N, 0.75);
    vec3 Tf = refract(-V, vec3(0.0, 1.0, 0.0), 0.75);
    float L = min(path, 4.0);
    vec2 ruv = suv + (ngToScreen(vWorld + Tn * L) - ngToScreen(vWorld + Tf * L));
    ruv = clamp(ruv, ngScreen.zw, 1.0 - ngScreen.zw);
    if (uDbg.z > 0.5) ruv = suv;
    if (texture(ngSceneDepth, ruv).r < vViewZ) ruv = suv;
    float rlod = clamp(log2(1.0 + alpha * min(path, 6.0) * 40.0), 0.0, ngCopyMips);
    vec3 refr = textureLod(ngSceneColor, ruv, rlod).rgb;
    float soft = smoothstep(0.0, 0.04, colW);

    /* ---- 反射 ---- */
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.004);
    R = normalize(R);
    float lod = clamp(log2(max(2.0 * alpha * uTierW.z, 1.0)), 0.0, uTierW.y);
    vec3 refl = vec3(0.0);
    float cover = 0.0;
    if (ngReflValid > 0.5 && uDbg.y < 0.5) {
      vec4 qr = ngReflMatrix * vec4(vWorld + R * 25.0, 1.0);
      if (qr.w > 0.0) {
        /* RT の外へ出た uv は縁へ寄せる（画面の縁で空へ落とすと明るい筋になる。a = 0 の所だけ空） */
        vec2 uvr = clamp(qr.xy / qr.w, vec2(0.001), vec2(0.999));
        /* 斜めから見た水面の映りは縦に伸び、横は鋭いまま（横へ傾いた法線は反射の向きを sinθ ぶんしか振らない）。
           横の幅で mip を選び、縦は 4 点で伸ばす */
        float spread = 2.0 * alpha;                                  // 反射の向きの広がり rad ≈ uv（縦の画角 ≈ 1 rad）
        float lodH = clamp(log2(max(spread * uTierW.z * clamp(2.5 * V.y + 0.12, 0.12, 1.0), 1.0)), 0.0, uTierW.y);
        float dv = spread * 0.35;
        float lodV = clamp(log2(max(dv * uTierW.z, 1.0)), 0.0, uTierW.y);
        float lr = max(lodH, lodV);
        vec4 rc = 0.5 * (textureLod(ngReflection, clamp(uvr + vec2(0.0, dv), 0.001, 0.999), lr)
                       + textureLod(ngReflection, clamp(uvr - vec2(0.0, dv), 0.001, 0.999), lr));
        /* RT に写った太陽・月の円盤（鏡面の GGX が持つ分）を窓の中だけ空の明るさに抑える */
        float win = smoothstep(0.9990 - 0.0015 * lod, 0.99985 - 0.0015 * lod, dot(R, ngKeyDir));
        cover = clamp(rc.a, 0.0, 1.0);
        refl = rc.rgb / max(cover, 1e-3);
        if (win > 0.0) {
          float cap = 6.0 * max(ngLuminance(ngSkySpecular(R, 0.5)), 1e-4);
          refl *= mix(1.0, min(1.0, cap / max(ngLuminance(refl), 1e-6)), win);
        }
      }
    }
    if (cover < 0.999) refl = mix(ngSkySpecular(R, clamp(alpha * 3.0, 0.0, 1.0)), refl, cover);
    /* Fresnel（Schlick、粗さで頭打ち） */
    float fr = pow(1.0 - NoV, 5.0);
    float F = (NG_F0 + (max(1.0 - alpha, NG_F0) - NG_F0) * fr) * soft;

    /* ---- key の鏡面（太陽 / 月） ---- */
    vec3 Ld = ngKeyDir;
    float NoL = dot(N, Ld);
    vec3 spec = vec3(0.0);
    float vis = 1.0;
    if (NoL > 0.0 && dot(ngKeyRad, vec3(1.0)) > 1e-6 && uDbg.w < 0.5) {
      vec3 H = normalize(Ld + V);
      float NoH = max(dot(N, H), 0.0);
      float aS = alpha + 0.0024;                              // 円盤（角半径 0.27°）の広がり
      float a2s = aS * aS;
      float D = ngGGXD(NoH, a2s) * (a2r / a2s);
      float Vis = ngSmithV(NoV, NoL, a2s);
      float VoH = max(dot(V, H), 0.0);
      float Fs = NG_F0 + (1.0 - NG_F0) * pow(1.0 - VoH, 5.0);
      float s = D * Vis * Fs * NoL;
      if (s > 1e-4) {
        float nearW = ngNearToFar(vWorld);
        /* 近景の影マップには地形が入らない（地形は影を落とさず高さ場影だけ）ので、高さ場影は近くでも掛ける */
        vis = min(ngSunVisibilityC(vWorld, nearW < 1.0 ? getShadowMask() : 1.0, vNgCloud), ngHfShadow(vWorld) * vNgCloud);
        spec = ngKeyRad * (s * vis * soft);
      } else {
        vis = vNgCloud;
      }
    } else {
      vis = vNgCloud;
    }
#if NUM_POINT_LIGHTS > 0
    /* 灯籠：GGX の点光源（夜の縦長の映り込み）。消えている昼は払わない */
    if (dot(pointLights[0].color, vec3(1.0)) > 1e-4) {
      vec3 lv = uLampPos - vWorld;
      float ld = length(lv);
      vec3 Lp = lv / max(ld, 1e-3);
      float NoLp = dot(N, Lp);
      if (NoLp > 0.0) {
        vec3 Hp = normalize(Lp + V);
        float a2p = a2r + 0.0004;
        float Dp = ngGGXD(max(dot(N, Hp), 0.0), a2p);
        float Fp = NG_F0 + (1.0 - NG_F0) * pow(1.0 - max(dot(V, Hp), 0.0), 5.0);
        float att = getDistanceAttenuation(ld, pointLights[0].distance, pointLights[0].decay);
        spec += pointLights[0].color * (Dp * ngSmithV(NoV, NoLp, a2p) * Fp * NoLp * att * soft);
      }
    }
#endif

    /* ---- 浅場の散乱（水の体の淡い青緑。日の当たる所だけ少し明るく） ---- */
    float lit = 0.35 + 0.65 * vis;
    vec3 scat = (1.0 - F) * ngWaterInsc * (0.10 * lit) * smoothstep(0.02, 0.5, colW) * exp(-0.06 * path);

    col = mix(refr, refl, F) + (spec + scat) * vSegT;

    /* ---- 汀の泡（渚の遡上の位相で動く細い線）と接触の泡（杭・岩・ヨシ） ---- */
    if (colW < 0.35) {
      float run = ngShoreRunUp(p, uTime) * uWind;
      float band = 0.05 + 0.22 * max(run, 0.0) + 0.04 * rain;
      float shoreW = (1.0 - smoothstep(0.0, band, colW)) * smoothstep(0.0, 0.006, colW);
      vec2 fuv = p * 0.9 + wd * (uTime * 0.03);
      vec4 fm = texture(uFoam, fuv);
      vec4 fm2 = texture(uFoam, p * 2.7 - wp * (uTime * 0.05) + 0.31);
      float lace = smoothstep(0.42, 0.78, fm.r * 0.65 + fm2.g * 0.55 - 0.25 * (colW / max(band, 1e-3)));
      float cov = shoreW * lace * (0.55 + 0.45 * smoothstep(-0.02, 0.03, run));
      vec3 E = ngKeyRad * max(Ld.y, 0.0) * vis * 0.3183 + ngSkyIrr;
      vec3 foamL = 0.62 * E;
      col = mix(col, foamL * vSegT + vSegL, clamp(cov, 0.0, 0.85));
    }
  } else {
    /* ---- 裏：水中から見上げる。スネルの窓 ---- */
    vec3 n = -N;
    vec3 I = -V;
    vec3 t = refract(I, n, 1.333);
    vec3 win;
    float cosI = max(dot(-I, n), 0.0);
    if (dot(t, t) < 1e-5) {
      /* 全反射：水の散乱色と暗い湖底の映り（深いほど暗い） */
      win = ngWaterInsc * 0.85 + texture(ngSceneColor, suv).rgb * 0.04;
    } else {
      float Fr = NG_F0 + (1.0 - NG_F0) * pow(1.0 - cosI, 5.0);
      Fr = clamp(Fr, 0.0, 1.0);
      vec3 tt = normalize(t);
      vec2 tuv = ngToScreen(vWorld + tt * 30.0);
      vec3 above = ngSkySpecular(tt, clamp(alpha * 3.0, 0.0, 1.0));
      if (tuv.x > 0.0 && tuv.x < 1.0 && tuv.y > 0.0 && tuv.y < 1.0) {
        float z = texture(ngSceneDepth, tuv).r;
        vec3 sc = textureLod(ngSceneColor, tuv, clamp(alpha * 20.0, 0.0, ngCopyMips)).rgb;
        if (z > vViewZ * 0.98) above = sc;                     // 手前（水中）の物を拾わない
      }
      /* 窓の縁（臨界角の近く）は Fresnel で全反射の色へ、縁の明るい輪 */
      float rim = smoothstep(0.62, 0.745, length(cross(I, n)));
      win = mix(above, ngWaterInsc * 0.85, Fr) * (1.0 + 0.5 * rim);
    }
    col = win * vSegT + vSegL;
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;
