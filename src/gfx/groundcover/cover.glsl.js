/* ===========================================================
   groundcover の描画（草・笹・シダ・小物）— ngExtendStandard の口
   -----------------------------------------------------------
   幾何は «型板» だけ（position = (刃の番号, 節 t, 横 ±1)、小物は単位球）。インスタンスの属性は無く、
   gl_InstanceID で計算パスの表（clump.glsl.js、RGBA32F の 3 帯）を texelFetch で 3 回読む。
   1 つのプログラムを 4 つの描画（近い草・遠い草・笹シダ・小物）が共有し、uniform ngGcTpl で型板を分ける。
   陰影：ラップ Lambert + 透過（逆光の HG）+ 先端の光沢 + 高さ方向の AO + 色むら・枯れた先端。
   近景の影は受ける（receiveShadow）、落とさない。根元の色 = 計算パスが地形の farAlbedo から取った色
   =========================================================== */
import { NG_NOISE_GLSL } from '../core/glsl/noise.glsl.js';
import { NG_SURFACE_GLSL } from '../core/glsl/surface.glsl.js';
import { GC_TEX_W } from './quality.js';

/* 型板の番号（ngGcTpl.x） */
export const GC_TPL_ID = Object.freeze({ near: 0, far: 1, plant: 2, debris: 3 });

/* 頂点：normal の口で全部を組み（objectNormal を書く）、begin の口で transformed に入れる。
   消えた株（大きさ 0）は main から早く抜ける（gl_Position を画面の外へ） */
export const GC_VS_PARS = NG_NOISE_GLSL + /* glsl */ `
precision highp sampler2D;
uniform highp sampler2D ngGcData;
uniform vec4 ngGcDraw;   // x = 最初の行, y = 型板（GC_TPL_ID）, z = 刃の数, w = セルの大きさ m
uniform vec4 ngGcLook;   // w = 1：検査（根元の色の ΔE。法線を上へ、根元の帯を根元の色で）、2：その画素のマスク
#define NG_GC_W ${GC_TEX_W}
out vec4 vGcA;   // x = t（根元 0 → 先 1）, y = 横 −1..1, z = 種類, w = 刃のハッシュ
out vec3 vGcRoot;
out vec4 vGcB;   // x = 空の見え, y = 山の影, z = 縮み（1 = 満開）, w = 枯れ
out vec3 vGcL;   // 小物：単位球の局所座標（模様）／草：(株の中心 xz, 突風)
vec3 ngGcP;
float ngGcBez(float a, float b, float c, float t) { float s = 1.0 - t; return s * s * a + 2.0 * s * t * b + t * t * c; }
vec3 ngGcBez3(vec3 a, vec3 b, vec3 c, float t) { float s = 1.0 - t; return s * s * a + 2.0 * s * t * b + t * t * c; }
vec3 ngGcBezD(vec3 a, vec3 b, vec3 c, float t) { return 2.0 * (1.0 - t) * (b - a) + 2.0 * t * (c - b); }
`;

export const GC_VS_NORMAL = /* glsl */ `
{
  int ngI = gl_InstanceID;
  ivec2 ngTx = ivec2(ngI % NG_GC_W, int(ngGcDraw.x + 0.5) + ngI / NG_GC_W);
  vec4 ngA = texelFetch(ngGcData, ngTx, 0);
  if (ngA.w <= 0.0005) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec4 ngB = texelFetch(ngGcData, ngTx + ivec2(NG_GC_W, 0), 0);
  vec4 ngC = texelFetch(ngGcData, ngTx + ivec2(2 * NG_GC_W, 0), 0);
  vec3 base = ngA.xyz;
  float H = ngA.w;
  float kind = floor(ngB.a + 0.01);
  float shrink = clamp(fract(ngB.a + 0.01) / 0.9, 0.0, 1.0);
  if (ngB.a - kind > 0.899) shrink = 1.0;
  float skyV = floor(ngC.w) / 255.0, hfV = fract(ngC.w) / 0.99;
  vec2 bend = ngC.xy;
  float gust = ngC.z;
  float tpl = ngGcDraw.y;
  float bi = position.x, t = position.y, sd = position.z;
  float hb = ngHash12(base.xz * 13.17 + bi * 7.31 + 0.5);
  float hb2 = ngHash12(base.xz * 5.71 + bi * 3.17 + 1.3);
  float hc = ngHash12(base.xz * 0.731 + 2.9);
  vec3 P = base, N = vec3(0.0, 1.0, 0.0);
  float dry = 0.0;
  vGcL = vec3(base.xz, gust);
  if (tpl < 1.5) {
    /* ---- 草：刃 = 二次ベジエ。株の中心から黄金角で外へ。風の曲げ（計算パス）+ 刃ごとの細かい揺れ ---- */
    float nb = ngGcDraw.z;
    float ang = bi * 2.39996 + hc * 6.2831;
    vec2 dir = vec2(cos(ang), sin(ang));
    /* 刃の根元：半分は株の芯（小さな房）、残りはセルいっぱい（隣のセルへ少しはみ出す）に散らす → 格子が見えない */
    float cs = ngGcDraw.w;
    vec2 jit = (vec2(ngHash12(base.xz * 9.1 + bi * 1.37), ngHash12(base.xz * 4.3 + bi * 2.71 + 3.3)) - 0.5) * cs * 1.25;
    vec2 tuft = dir * cs * 0.22 * sqrt((bi + 0.5) / nb);
    vec2 off = mix(tuft, jit, step(0.45, hb2));
    vec3 p0 = base + vec3(off.x, -0.012, off.y);
    float len = H * mix(0.5, 1.0, hb) * (1.0 + 0.25 * (1.0 - (bi + 0.5) / nb));
    float tilt = mix(0.10, 0.62, hb2 * hb2) + 0.25 * (bi + 0.5) / nb;
    float fl = sin(ngEnvTime * (2.6 + 2.2 * hb) + hb * 6.2831 + dot(base.xz, vec2(0.7, 0.3))) * (0.015 + 0.05 * gust) * (0.4 + length(bend));
    vec2 D = dir * tilt + bend * (1.0 + 0.35 * (hb - 0.5)) + vec2(-dir.y, dir.x) * fl;
    float dl = length(D);
    /* 長い刃・強い曲げほど先が垂れる（長さはほぼ保つ） */
    vec3 tip = p0 + normalize(vec3(D.x, 1.0 - 0.35 * smoothstep(0.4, 1.4, dl) * hb, D.y)) * len;
    vec3 ctl = p0 + vec3(D.x * 0.18, 0.62, D.y * 0.18) * len;
    vec3 Pc = ngGcBez3(p0, ctl, tip, t);
    vec3 T = normalize(ngGcBezD(p0, ctl, tip, max(t, 0.02)) + vec3(0.0, 1e-4, 0.0));
    float tw = (hb - 0.5) * 1.2;
    vec3 sv = normalize(vec3(-dir.y * cos(tw) - dir.x * sin(tw) * 0.3, 0.0, dir.x * cos(tw) - dir.y * sin(tw) * 0.3));
    sv = normalize(sv - T * dot(sv, T));
    float wd = (tpl < 0.5 ? 0.0125 : 0.03) * mix(0.75, 1.3, hb2) * (1.0 - pow(t, 1.7)) * (0.35 + 0.65 * shrink);
    P = Pc + sv * wd * sd;
    vec3 Nf = normalize(cross(sv, T));
    if (dot(Nf, vec3(dir.x, 0.0, dir.y)) < 0.0) Nf = -Nf;
    N = normalize(Nf + sv * sd * 0.55 + vec3(0.0, 0.25, 0.0));
    if (ngGcLook.w > 0.5) N = vec3(0.0, 1.0, 0.0);
    dry = smoothstep(0.55, 1.0, t) * smoothstep(0.55, 0.95, ngHash12(base.xz * 3.3 + bi)) ;
  } else if (tpl < 2.5) {
    /* ---- 笹（クマザサ）とシダ：葉 = 太さの変わるリボン ---- */
    float nl = 16.0;
    if (kind < 1.5) {
      /* クマザサ：稈 3 本 × (稈 1 + 葉 4 枚)。稈は細い茎、葉は稈の先に掌状に広がる広い披針形（長さ 20–25cm、幅 4–5cm） */
      float culm = floor(bi / 8.0), li = mod(bi, 8.0);
      float ca = culm * 2.39996 + hc * 6.2831;
      vec2 cd = vec2(cos(ca), sin(ca)) * (0.04 + 0.16 * ngHash12(base.xz + culm * 9.7));
      float ch = H * mix(0.7, 1.0, ngHash12(base.xz * 2.1 + culm * 3.3));
      vec3 cb = base + vec3(cd.x, -0.02, cd.y);
      vec2 bw = bend * 0.35;
      vec3 ctop = cb + vec3(bw.x * ch * 0.6 + cd.x * 0.3, ch, bw.y * ch * 0.6 + cd.y * 0.3);
      if (li < 0.5) {
        /* 稈：細いリボン（カメラへ向けない。2 枚の葉の間の向き） */
        vec3 Pc = mix(cb, ctop, t);
        vec3 T = normalize(ctop - cb);
        vec3 sv = normalize(cross(T, vec3(cos(ca + 1.57), 0.0, sin(ca + 1.57))) + vec3(1e-4, 0.0, 0.0));
        P = Pc + sv * 0.0028 * sd * shrink;
        N = normalize(cross(sv, T) + sv * sd * 0.6);
        dry = 1.0;
      } else {
        float k = li - 1.0;
        float la = ca + k * 0.8976 + (hb - 0.5) * 0.7;
        vec2 ld = vec2(cos(la), sin(la));
        float L = clamp(0.24 * H / 0.65, 0.15, 0.28) * mix(0.82, 1.12, hb);
        vec3 p0 = ctop - vec3(0.0, k * 0.012, 0.0);
        vec3 ctl = p0 + vec3(ld.x * L * 0.5 + bw.x * L, L * (0.2 - 0.03 * k), ld.y * L * 0.5 + bw.y * L);
        vec3 tip = p0 + vec3(ld.x * L * 0.95 + bw.x * 2.0 * L, -L * (0.12 + 0.3 * hb2), ld.y * L * 0.95 + bw.y * 2.0 * L);
        vec3 Pc = ngGcBez3(p0, ctl, tip, t);
        vec3 T = normalize(ngGcBezD(p0, ctl, tip, max(t, 0.02)));
        vec3 sv = normalize(cross(T, vec3(0.0, 1.0, 0.0)) + vec3(0.0, (hb2 - 0.5) * 0.4, 0.0));
        float wd = L * 0.11 * sin(3.14159 * pow(clamp(t, 0.0, 1.0), 0.55)) * shrink;
        /* 葉は中肋で少し V 字に折れる */
        P = Pc + sv * wd * sd + vec3(0.0, abs(sd) * wd * 0.25, 0.0);
        N = normalize(cross(sv, T));
        if (N.y < 0.0) N = -N;
        N = normalize(N - sv * sd * 0.35);
        dry = smoothstep(0.82, 1.0, abs(sd)) * 0.6;
      }
    } else {
      /* シダ：葉（frond）8 枚 + 内側の若い葉 8 枚。中軸は弧を描いて外へ垂れる。小葉は断片のアルファ */
      float inner = step(8.0, bi);
      float fa = bi * 0.785 + hc * 6.2831 + inner * 0.39;
      vec2 fd = vec2(cos(fa), sin(fa));
      float L = H * mix(1.05, 1.45, hb) * mix(1.0, 0.6, inner);
      vec3 p0 = base + vec3(fd.x * 0.03, 0.0, fd.y * 0.03);
      vec2 bw = bend * 0.5;
      float up = mix(0.55, 0.85, inner) * mix(0.85, 1.1, hb2);
      vec3 ctl = p0 + vec3(fd.x * L * 0.35 + bw.x * L * 0.5, L * up, fd.y * L * 0.35 + bw.y * L * 0.5);
      vec3 tip = p0 + vec3(fd.x * L * 0.85 + bw.x * L, L * (0.18 + 0.3 * inner), fd.y * L * 0.85 + bw.y * L);
      vec3 Pc = ngGcBez3(p0, ctl, tip, t);
      vec3 T = normalize(ngGcBezD(p0, ctl, tip, max(t, 0.02)));
      vec3 sv = normalize(cross(T, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 1e-4));
      float wd = L * 0.2 * sin(3.14159 * pow(clamp(t, 0.0, 1.0), 0.8)) * mix(0.25, 1.0, smoothstep(0.0, 0.25, t)) * shrink;
      /* 小葉の面はやや下へ反る */
      P = Pc + sv * wd * sd - vec3(0.0, abs(sd) * wd * 0.35, 0.0);
      N = normalize(cross(sv, T));
      if (N.y < 0.0) N = -N;
      N = normalize(N - sv * sd * 0.3);
      dry = 0.0;
    }
  } else {
    /* ---- 小物：単位球を変形（小石・落ち枝・苔・落葉） ---- */
    vec3 s = position;
    vGcL = s;
    float ra = hc * 6.2831;
    mat2 rot = mat2(cos(ra), -sin(ra), sin(ra), cos(ra));
    vec3 q = s;
    vec3 n = s;
    if (kind < 3.5) {
      /* 小石：扁平な楕円体 + 塊のうねり。底を平らにして少し埋める */
      float lump = 1.0 + 0.22 * (ngVNoise3(s * 1.7 + hc * 31.0) - 0.5) + 0.08 * (ngVNoise3(s * 4.1 + hb2 * 17.0) - 0.5);
      vec3 ax = vec3(mix(1.2, 1.9, hb2), 1.0, mix(1.0, 1.5, hc)) * H * 0.5;
      q = s * lump;
      q.y = max(q.y, -0.25);
      q *= ax;
      q.y += H * 0.5 * 0.05;
      n = normalize(s / max(ax, vec3(1e-4)) + vec3(0.0, 0.3, 0.0) * step(q.y, -0.2 * ax.y));
    } else if (kind < 4.5) {
      /* 落ち枝：細長い円柱（球を伸ばす）、地面に寝かせて少し反らす */
      float r = mix(0.007, 0.016, hb2);
      q = vec3(s.x * H * 0.5, s.y * r + r * 0.6, s.z * r);
      q.y += 0.04 * H * (1.0 - s.x * s.x) * (hb - 0.3);
      n = normalize(vec3(s.x * 0.15, s.y, s.z));
    } else if (kind < 5.5) {
      /* 苔の塊：低いドーム、こぶ状 */
      float lump = 1.0 + 0.7 * (ngVNoise3(s * 2.1 + hc * 13.0) - 0.5) + 0.3 * (ngVNoise3(s * 5.3 + hb2 * 7.0) - 0.5);
      q = vec3(s.x * H * lump, max(s.y, -0.15) * H * 0.3 * lump, s.z * H * mix(0.6, 1.0, hb2) * lump);
      q.y -= H * 0.05;
      n = normalize(vec3(s.x, s.y * 2.0, s.z));
    } else {
      /* 落葉：薄い円盤（少し反る） */
      q = vec3(s.x * H, s.y * 0.002 + 0.004 + 0.25 * H * (s.x * s.x + s.z * s.z) * (hb - 0.4), s.z * H * 0.62);
      n = normalize(vec3(0.0, 1.0, 0.0) + vec3(s.x, 0.0, s.z) * 0.3 * (hb - 0.4));
    }
    q.xz = rot * q.xz;
    n.xz = rot * n.xz;
    P = base + q * shrink;
    N = n;
    t = 0.5 + 0.5 * s.y;
  }
  vGcA = vec4(t, sd, kind, hb);
  vGcRoot = ngB.rgb;
  vGcB = vec4(skyV, hfV, shrink, dry);
  ngGcP = P;
  objectNormal = N;
}
`;

export const GC_VS_BEGIN = /* glsl */ `transformed = ngGcP;`;

/* ---------------- 断片 ---------------- */
export const GC_FS_PARS = NG_SURFACE_GLSL + /* glsl */ `
in vec4 vGcA;
in vec3 vGcRoot;
in vec4 vGcB;
in vec3 vGcL;
uniform vec4 ngGcLook;   // x = 透過の強さ, y = 季節の枯れ, z = 草の明るさ倍率, w = 1 で検査（根元の ΔE）
float ngGcKind() { return vGcA.z; }
`;

/* アルベド（線形）。草 0.10–0.16（palette）を中心に、根元は地形の色、先は枯れ色へ */
export const GC_FS_SURFACE = /* glsl */ `
float ngGcT = clamp(vGcA.x, 0.0, 1.0);
float ngGcK = vGcA.z;
float ngGcH = vGcA.w;
float ngGcPorous = 0.3;
vec3 ngGcAlb;
{
  vec2 cxz = vGcL.xy;
  float ngPch = ngVNoise2(vNgWorld.xz * 0.35 + 3.0);
  float ngPch2 = ngVNoise2(vNgWorld.xz * 1.7 + 9.0);
  if (ngGcK < 0.5) {
    /* 草（スゲ・イネ科）：初夏の黄緑〜青緑。株ごと・斑ごとの色むら、先の枯れ */
    vec3 fresh = mix(vec3(0.062, 0.135, 0.032), vec3(0.105, 0.165, 0.040), ngPch);
    fresh = mix(fresh, vec3(0.072, 0.118, 0.052), smoothstep(0.55, 0.95, ngGcH) * 0.6);
    fresh *= mix(0.82, 1.12, ngPch2) * ngGcLook.z;
    vec3 straw = vec3(0.215, 0.175, 0.085);
    float dry = clamp(vGcB.w + ngGcLook.y * smoothstep(0.6, 1.0, ngGcT) * ngPch, 0.0, 1.0);
    vec3 c = mix(fresh, straw, dry * 0.85);
    /* 中肋の線（刃の中央で少し明るい） */
    c *= 1.0 + 0.10 * (1.0 - smoothstep(0.0, 0.25, abs(vGcA.y)));
    /* 根元 → 地形の色（ΔE < 6 の約束）。根元 5% は地形の色そのもの、30% までで刃の色へ */
    ngGcAlb = mix(vGcRoot, c, smoothstep(0.05, 0.3, ngGcT));
    ngGcPorous = 0.25;
  } else if (ngGcK < 1.5) {
    /* クマザサ：濃い緑、ろう質。縁がわずかに淡い */
    vec3 c = mix(vec3(0.040, 0.085, 0.024), vec3(0.058, 0.108, 0.030), ngGcH) * mix(0.85, 1.1, ngPch2);
    c = mix(c, vec3(0.15, 0.14, 0.08), smoothstep(0.86, 1.0, abs(vGcA.y)) * 0.55 * step(vGcB.w, 0.9));
    if (vGcB.w > 0.9) c = vec3(0.11, 0.11, 0.055);
    ngGcAlb = mix(vec3(0.07, 0.08, 0.035), c, smoothstep(0.0, 0.12, ngGcT));
    ngGcPorous = 0.1;
  } else if (ngGcK < 2.5) {
    /* シダ：明るい黄緑の若い葉と濃い葉。中軸は茶。小葉の切れ込みは alpha の口 */
    vec3 c = mix(vec3(0.050, 0.110, 0.026), vec3(0.085, 0.150, 0.035), ngGcH) * mix(0.85, 1.12, ngPch);
    float rach = 1.0 - smoothstep(0.03, 0.08, abs(vGcA.y));
    ngGcAlb = mix(c, vec3(0.09, 0.07, 0.035), rach * 0.8);
    ngGcPorous = 0.2;
  } else if (ngGcK < 3.5) {
    /* 玉石の小石（岩の肌：花崗岩・安山岩 0.18–0.25）。粒の斑と石ごとの色 */
    float sp = ngVNoise3(vGcL * 9.0 + ngGcH * 40.0);
    float sp2 = ngVNoise3(vGcL * 23.0 + ngGcH * 11.0);
    vec3 c = mix(vec3(0.16, 0.155, 0.145), vec3(0.24, 0.225, 0.20), ngGcH);
    c = mix(c, vec3(0.27, 0.25, 0.22), smoothstep(0.62, 0.8, sp2) * 0.7);
    c *= mix(0.75, 1.1, sp);
    c = mix(c, c * vec3(0.95, 1.0, 0.85), smoothstep(0.3, 0.9, ngPch) * 0.3);
    /* 下半分は土で汚れる */
    ngGcAlb = mix(vGcRoot * 0.9, c, smoothstep(0.08, 0.35, ngGcT));
    ngGcPorous = 0.35;
  } else if (ngGcK < 4.5) {
    /* 落ち枝：樹皮 */
    float bark = ngVNoise3(vGcL * vec3(3.0, 30.0, 30.0) + ngGcH * 9.0);
    ngGcAlb = mix(vec3(0.045, 0.034, 0.024), vec3(0.11, 0.085, 0.06), bark) * mix(0.8, 1.2, ngGcH);
    ngGcPorous = 0.6;
  } else if (ngGcK < 5.5) {
    /* 苔の塊 */
    float m = ngVNoise3(vGcL * 7.0 + ngGcH * 21.0);
    ngGcAlb = mix(vec3(0.040, 0.068, 0.018), vec3(0.085, 0.115, 0.028), m) * mix(0.85, 1.1, ngPch2);
    ngGcAlb = mix(vGcRoot, ngGcAlb, smoothstep(0.2, 0.75, ngGcT) * 0.8);
    ngGcPorous = 0.8;
  } else {
    /* 落葉：茶・橙・黄土 */
    vec3 a = vec3(0.20, 0.10, 0.045), b = vec3(0.16, 0.13, 0.06), c2 = vec3(0.09, 0.06, 0.035);
    float r = ngGcH;
    ngGcAlb = r < 0.4 ? mix(a, b, r / 0.4) : mix(b, c2, (r - 0.4) / 0.6);
    ngGcAlb *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.12, abs(vGcL.z)));
    ngGcPorous = 0.5;
  }
  /* 消える途中の株は地形の色へ寄せる（縁の色の段を消す） */
  ngGcAlb = mix(vGcRoot, ngGcAlb, smoothstep(0.0, 0.7, vGcB.z));
}
diffuseColor.rgb = ngGcAlb;
/* 検査：根元の帯（下 20%）を «根元の色そのもの» で描く（ΔE は根元の色と、同じ画素の地面との差） */
if (ngGcLook.w > 0.5) {
  if (ngGcK > 0.5 || ngGcT > 0.2) discard;
  diffuseColor.rgb = ngGcLook.w > 1.5 ? vec3(1.0, 0.0, 1.0) : vGcRoot;
}
`;

/* シダの小葉の切れ込み（羽状）。他は不透明 */
export const GC_FS_ALPHA = /* glsl */ `
if (vGcA.z > 1.5 && vGcA.z < 2.5) {
  float v = abs(vGcA.y);
  float k = vGcA.x * 18.0 + v * 2.2;
  float pin = fract(k);
  float lobe = 1.0 - smoothstep(0.55, 0.75, abs(pin - 0.5) * 2.0 + v * 0.35);
  float core = 1.0 - smoothstep(0.05, 0.09, v);
  diffuseColor.a = max(max(lobe, core), step(v, 0.02)) * step(v, 0.98);
}
`;

/* 検査の時だけ：法線を世界の上へ（裏面の反転に依らず地面と同じ光） */
export const GC_FS_NORMAL = /* glsl */ `
if (ngGcLook.w > 0.5) normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
`;

export const GC_FS_ROUGH = /* glsl */ `
{
  float k = vGcA.z;
  float r = k < 0.5 ? mix(0.82, 0.48, smoothstep(0.3, 1.0, ngGcT)) : (k < 1.5 ? 0.42 : (k < 2.5 ? 0.6 : (k < 3.5 ? 0.72 : (k < 4.5 ? 0.85 : (k < 5.5 ? 0.95 : 0.7)))));
  roughnessFactor = r;
  ngWetSurface(diffuseColor.rgb, roughnessFactor, ngGcPorous, ngWet);
}
`;

/* 光：透過（逆光の HG）とラップ Lambert を key に足す。空の見え（樹冠）と高さ方向の AO は ao の口 */
export const GC_FS_LIGHTS = /* glsl */ `
{
  float k = vGcA.z;
  vec3 Lw = ngKeyDir;
  vec3 Vw = normalize(cameraPosition - vNgWorld);
  vec3 Nw = inverseTransformDirection(normal, viewMatrix);
  vec3 E = ngKeyPreShadow * ngNearVis * mix(1.0, vGcB.y, 0.85);
  reflectedLight.directDiffuse *= mix(1.0, vGcB.y, 0.85);
  reflectedLight.directSpecular *= mix(1.0, vGcB.y, 0.85);
  if (k < 2.5 && ngGcLook.w < 0.5) {
    float ndl = dot(Nw, Lw);
    /* ラップ：刃は細く丸いので、裏へ回った光も少し届く */
    float wrap = max((ndl + 0.45) / 1.45, 0.0) - max(ndl, 0.0);
    vec3 alb = diffuseColor.rgb;
    reflectedLight.directDiffuse += E * alb * (wrap * 0.55 / 3.14159265);
    /* 透過：光を背にした葉が黄緑に光る（HG g = 0.55）。厚い笹は弱く */
    float mu = dot(-Vw, Lw);
    float g = 0.55;
    float hg = (1.0 - g * g) / (4.0 * 3.14159265 * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
    float thin = k < 0.5 ? 1.0 : (k < 1.5 ? 0.45 : 0.8);
    float back = smoothstep(-0.2, 0.4, -ndl * sign(dot(Nw, Vw) + 1e-4)) * 0.6 + 0.4;
    vec3 trc = alb * vec3(1.25, 1.55, 0.75) + vec3(0.010, 0.018, 0.0);
    float tip = k < 0.5 ? mix(0.35, 1.0, ngGcT) : 1.0;
    reflectedLight.directDiffuse += E * trc * (hg * 2.2 + 0.08) * thin * back * tip * ngGcLook.x * max(Lw.y + 0.15, 0.0);
    /* 先端の光沢（細い刃の縁で日を拾う） */
    if (k < 0.5) {
      vec3 Hh = normalize(Lw + Vw);
      float sh = pow(max(dot(Nw, Hh), 0.0), 24.0) * smoothstep(0.4, 1.0, ngGcT);
      reflectedLight.directSpecular += E * sh * 0.06 * (1.0 + 2.0 * ngWet);
    }
  }
}
`;

export const GC_FS_AO = /* glsl */ `
{
  float k = vGcA.z;
  float skyV = mix(1.0, vGcB.x, 0.9);
  float ao = 1.0;
  if (k < 0.5) ao = mix(0.32, 1.0, pow(ngGcT, 0.7));
  else if (k < 1.5) ao = vGcB.w > 0.9 ? 0.7 : mix(0.5, 1.0, smoothstep(0.0, 0.7, ngGcT));
  else if (k < 2.5) ao = mix(0.5, 1.0, ngGcT);
  else ao = mix(0.35, 1.0, smoothstep(0.0, 0.7, ngGcT));
  if (ngGcLook.w > 0.5) {
    /* 検査：地形と同じ光の掛け方（TERRAIN_FRAG_AO、素材の AO ≈ 0.8、空の見え 1 − 0.75·樹冠） */
    float cnv = clamp((1.0 - vGcB.x) / 0.62, 0.0, 1.0), aoT = 0.8;
    float occ = (1.0 - 0.75 * cnv) * mix(1.0, aoT, 0.7);
    reflectedLight.indirectDiffuse *= aoT * (occ * 0.6 + 0.4);
    reflectedLight.indirectSpecular *= occ;
    reflectedLight.directDiffuse *= mix(1.0, aoT, 0.45);
  } else {
  reflectedLight.indirectDiffuse *= ao * skyV;
  reflectedLight.indirectSpecular *= ao * skyV;
  reflectedLight.directDiffuse *= mix(1.0, ao, 0.35);
  }
}
`;
