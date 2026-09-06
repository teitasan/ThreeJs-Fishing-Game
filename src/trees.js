/* ===========================================================
   樹木：骨格 → ジオメトリ化と LOD 付き InstancedMesh 管理

   treeSkeleton.js が作った折れ線の骨格を
     - 枝：平行移動フレームで捻れないチューブ
     - 葉：ひと房ぶんのカード（近景は十字 2 枚、中景は 1 枚）
   に変換する。遠景は起動時に 1 本だけオフスクリーンで焼いた
   インポスター（アルベドのみ）を十字 2 枚に貼る。

   遠景をインポスターにするのはポリゴン数のためだけではない。
   100m 先の細い枝をそのまま描くと 1 ピクセル未満の線が明滅して、
   森全体がチラチラした砂目に見えるため。
   =========================================================== */
import * as THREE from 'three';
import { growTree, SPECIES, deriveTreeHabit, lodFor, LOD_DIST } from './treeSkeleton.js?v=20260830-zone5';
import { lodForList } from './util.js?v=20260830-zone5';
import { boxBlurWrap } from './tileableNoise.js?v=20260830-zone5';
import { LodInstances, tintAt } from './lodInstances.js?v=20260830-zone5';
import { makeRng, TAU, lerp, clamp01 } from './util.js?v=20260830-zone5';
import { applyPatches, keepAuthoredNormals, foliageTranslucency, lodDitherFade }
  from './materialPatch.js?v=20260830-zone5';

export { LOD_DIST, lodFor };

/** 段の境界でクロスフェードする帯の幅（m） */
export const LOD_FADE_BAND = 12;

/** 種ごとの見た目のバリエーション数（LOD をまたいでも同じ骨格を使う） */
export const VARIANTS = 4;

/* ---------------- 樹皮テクスチャ ---------------- */

/** 横方向（幹のまわり）に継ぎ目が出ないよう、端をまたぐ図形は反対側にも描く */
function wrapDraw(ctx, size, x, fn) {
  fn(x);
  if (x < size * 0.25) fn(x + size);
  else if (x > size * 0.75) fn(x - size);
}

/**
 * 低周波の明暗を均す。
 *
 * 樹皮に «テクスチャの幅» ほどの緩い明暗のうねりがあると、円柱に巻いたとき
 * それが «陰影» に見えて幹が縦に凹んでいるように読める。照明を外しても
 * 暗いままなので照明のせいではない、と切り分けられる。
 * 局所平均を全体平均へ寄せて、模様（高周波）だけを残す。
 */
function flattenBarkShading(g, size, { radius = 0.2, amount = 0.85 } = {}) {
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const luma = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    luma[i] = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255 + 1e-3;
  }
  // タイル境界をまたぐぼかし（またがないと縁だけ均され方が変わる）
  const blur = boxBlurWrap(luma, size, Math.max(1, Math.round(radius * size)));
  let mean = 0;
  for (const v of luma) mean += v;
  mean /= luma.length;
  for (let i = 0; i < size * size; i++) {
    const k = 1 + amount * (mean / blur[i] - 1);
    const o = i * 4;
    d[o] = Math.min(255, d[o] * k);
    d[o + 1] = Math.min(255, d[o + 1] * k);
    d[o + 2] = Math.min(255, d[o + 2] * k);
  }
  g.putImageData(img, 0, 0);
}

/** 縦にも回り込ませて描く（上下の継ぎ目に線を残さない） */
function wrapDraw2(ctx, size, x, y, fn) {
  wrapDraw(ctx, size, x, (xx) => {
    fn(xx, y);
    if (y < size * 0.25) fn(xx, y + size);
    else if (y > size * 0.75) fn(xx, y - size);
  });
}

/**
 * 樹皮。
 * ブナ：灰白色でなめらか。地衣類の斑と横向きの皮目が特徴。
 * スギ：赤褐色で縦に裂ける繊維状。
 */
export function makeBarkTexture(kind, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rng = makeRng(kind === 'beech' ? 0x8e3c11 : 0x2f77a3);

  /* 縦縞«だけ»で描くと、テクスチャが縦に繰り返したときに全長を貫く
     一本の帯になる。それが円柱に巻かれると «縞» ではなく «陰影» に見えて、
     幹が縦に凹んでいるように読める。どちらの樹種も横方向の構造を入れて、
     縞が上下に途切れるようにしてある。 */
  if (kind === 'beech') {
    /* ブナの樹皮はもともと滑らかで、縦に裂けない。
       雲のような斑・地衣類・皮目でできている */
    g.fillStyle = '#a9a79c';
    g.fillRect(0, 0, size, size);
    // 地の斑。大きさの違う楕円を重ねて «向きのない» ムラにする
    for (let i = 0; i < 120; i++) {
      const x = rng() * size, y = rng() * size;
      const rx = 10 + rng() * 46, ry = rx * (0.5 + rng() * 1.1);
      const light = rng() < 0.5;
      const a = 0.04 + rng() * 0.08;
      wrapDraw2(g, size, x, y, (xx, yy) => {
        const grd = g.createRadialGradient(xx, yy, 0, xx, yy, Math.max(rx, ry));
        const c = light ? '206,204,194' : '124,122,114';
        grd.addColorStop(0, `rgba(${c},${a})`);
        grd.addColorStop(1, `rgba(${c},0)`);
        g.save();
        g.translate(xx, yy); g.scale(1, ry / rx); g.translate(-xx, -yy);
        g.fillStyle = grd;
        g.beginPath(); g.arc(xx, yy, Math.max(rx, ry), 0, TAU); g.fill();
        g.restore();
      });
    }
    // 地衣類：緑がかった不定形の斑
    for (let i = 0; i < 46; i++) {
      const x = rng() * size, y = rng() * size, r = 6 + rng() * 26;
      wrapDraw2(g, size, x, y, (xx, yy) => {
        const grd = g.createRadialGradient(xx, yy, 0, xx, yy, r);
        const a = 0.10 + rng() * 0.16;
        grd.addColorStop(0, `rgba(176,183,158,${a})`);
        grd.addColorStop(1, 'rgba(176,183,158,0)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(xx, yy, r, 0, TAU); g.fill();
      });
    }
    // 皮目（横向きの短い線）。ブナらしさはここが一番出る
    for (let i = 0; i < 260; i++) {
      const x = rng() * size, y = rng() * size, w = 3 + rng() * 11;
      g.fillStyle = `rgba(88,84,76,${0.10 + rng() * 0.22})`;
      wrapDraw2(g, size, x, y, (xx, yy) => g.fillRect(xx, yy, w, 1));
    }
    // 古い傷あと（横に走る淡い帯）。縦の連続を切る
    for (let i = 0; i < 7; i++) {
      const y = rng() * size, h = 2 + rng() * 5;
      g.fillStyle = `rgba(132,128,118,${0.06 + rng() * 0.07})`;
      wrapDraw2(g, size, size * 0.5, y, (xx, yy) => g.fillRect(0, yy, size, h));
    }
  } else {
    g.fillStyle = '#6d4a37';
    g.fillRect(0, 0, size, size);
    /* 縦裂：スギは縦に裂けるので縦縞で正しいが、1 本が全長を貫くと
       «縞» ではなく «溝» に見える。実物も短冊が上下で途切れて重なっている
       ので、有限の長さの短冊として置く */
    for (let i = 0; i < 300; i++) {
      const x = rng() * size, w = 1 + rng() * 7;
      const y0 = rng() * size, len = 26 + rng() * 118;
      const dark = rng() < 0.55;
      const a = 0.08 + rng() * 0.26;
      g.fillStyle = dark ? `rgba(48,30,22,${a})` : `rgba(150,104,76,${a * 0.8})`;
      wrapDraw2(g, size, x, y0, (xx, yy) => {
        // 縞は真っ直ぐではなく少し蛇行させる（定規で引いた縞に見せない）
        let cx = xx;
        for (let d = 0; d < len; d += 8) {
          cx += (rng() - 0.5) * 1.6;
          g.fillRect(cx, yy + d, w, 9);
        }
      });
    }
    // 短冊の切れ目（横向きの暗い段）。縦の連続をはっきり断つ
    for (let i = 0; i < 34; i++) {
      const x = rng() * size, y = rng() * size, w = 10 + rng() * 40;
      g.fillStyle = `rgba(40,26,19,${0.10 + rng() * 0.14})`;
      wrapDraw2(g, size, x, y, (xx, yy) => g.fillRect(xx, yy, w, 1 + rng() * 3));
    }
    // 剥がれかけの繊維
    for (let i = 0; i < 40; i++) {
      const x = rng() * size, y = rng() * size, h = 14 + rng() * 46;
      g.fillStyle = `rgba(196,150,116,${0.10 + rng() * 0.16})`;
      wrapDraw2(g, size, x, y, (xx, yy) => g.fillRect(xx, yy, 1 + rng() * 2, h));
    }
  }

  flattenBarkShading(g, size);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/* ---------------- 葉テクスチャ ---------------- */

/** 縁が波打った卵形の葉（ブナ）を 1 枚描く */
function drawBeechLeaf(g, cx, cy, L, W, ang, fill, vein) {
  g.save();
  g.translate(cx, cy);
  g.rotate(ang);
  /* 右側を根元→先端、左側を先端→根元で引いて閉じる。
     幅は sin で膨らませ、さらに細かい波を乗せる（ブナの縁は鋸歯ではなく波状） */
  const half = (t) => W * 0.5 * Math.pow(Math.sin(t * Math.PI), 0.72)
    * (1 + Math.sin(t * Math.PI * 7) * 0.075);
  g.beginPath();
  for (let i = 0; i <= 14; i++) {
    const t = i / 14, y = -L * 0.5 + L * t;
    if (i === 0) g.moveTo(0, y); else g.lineTo(half(t), y);
  }
  for (let i = 14; i >= 0; i--) {
    const t = i / 14, y = -L * 0.5 + L * t;
    g.lineTo(-half(t), y);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  // 主脈と側脈
  g.strokeStyle = vein;
  g.lineWidth = Math.max(0.6, L * 0.022);
  g.beginPath(); g.moveTo(0, -L * 0.46); g.lineTo(0, L * 0.46); g.stroke();
  g.lineWidth = Math.max(0.4, L * 0.014);
  for (let i = 1; i <= 5; i++) {
    const t = i / 6, y = -L * 0.4 + L * 0.8 * t;
    const w = W * 0.42 * Math.pow(Math.sin(t * Math.PI), 0.7);
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y + L * 0.07); g.stroke();
    g.beginPath(); g.moveTo(0, y); g.lineTo(-w, y + L * 0.07); g.stroke();
  }
  g.restore();
}

/** 針状葉の房（スギ）を 1 本描く */
function drawCedarSpray(g, cx, cy, L, ang, rng, fill) {
  g.save();
  g.translate(cx, cy);
  g.rotate(ang);
  g.strokeStyle = fill;
  g.lineCap = 'round';
  // 中軸
  g.lineWidth = Math.max(1, L * 0.035);
  g.beginPath(); g.moveTo(0, L * 0.5); g.lineTo(0, -L * 0.5); g.stroke();
  // 螺旋状に付く鎌形の葉
  const n = Math.round(L * 0.22);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const y = L * 0.5 - L * t;
    const side = i % 2 ? 1 : -1;
    const nl = L * 0.20 * (0.55 + 0.45 * Math.sin(t * Math.PI)) * (0.7 + rng() * 0.6);
    g.lineWidth = Math.max(0.9, L * 0.028);
    g.beginPath();
    g.moveTo(0, y);
    // 先が内側へ反る（スギの葉は鎌状）
    g.quadraticCurveTo(side * nl * 0.7, y - nl * 0.35, side * nl * 0.75, y - nl * 0.85);
    g.stroke();
  }
  g.restore();
}

/** 葉テクスチャのアトラス割り（2×2）。房ごとに違うセルを引いて反復感を消す */
export const LEAF_ATLAS = 2;

/** 1 セルぶんのブナの房を描く（中心 cx,cy、1 辺 S） */
function drawBeechCluster(g, cx, cy, S, rng) {
  const M = S * 0.5 * 0.86;          // 縁に触れないよう内側に収める
  const twigs = 3 + (rng() < 0.5 ? 0 : 1);
  for (let w = 0; w < twigs; w++) {
    const a = -Math.PI / 2 + (w - (twigs - 1) / 2) * (0.52 + rng() * 0.18);
    const tl = M * (0.78 + rng() * 0.28);
    const ex = cx + Math.cos(a) * tl, ey = cy + M * 0.86 + Math.sin(a) * tl;
    g.strokeStyle = '#6b5b3e';
    g.lineWidth = S * 0.010;
    g.beginPath(); g.moveTo(cx, cy + M * 0.9); g.lineTo(ex, ey); g.stroke();

    const n = 5 + Math.round(rng() * 3);
    for (let i = 0; i < n; i++) {
      const t = 0.18 + 0.82 * ((i + rng() * 0.6) / n);
      const px = cx + (ex - cx) * t, py = cy + M * 0.9 + (ey - (cy + M * 0.9)) * t;
      const side = i % 2 ? 1 : -1;
      const L = S * (0.26 - t * 0.09) * (0.82 + rng() * 0.4);
      const W = L * (0.60 + rng() * 0.16);
      const g0 = 112 + Math.round(rng() * 48);
      drawBeechLeaf(
        g, px + side * L * 0.34, py, L, W,
        a + Math.PI / 2 + side * (0.55 + rng() * 0.55),
        `rgb(${Math.round(g0 * 0.60)},${g0 + 30},${Math.round(g0 * 0.44)})`,
        'rgba(220,234,172,0.5)'
      );
    }
  }
}

/** 1 セルぶんのスギの房を描く */
function drawCedarCluster(g, cx, cy, S, rng) {
  const M = S * 0.5 * 0.86;
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const a = (t - 0.5) * 1.55 + (rng() - 0.5) * 0.22;
    const L = M * (1.5 - Math.abs(t - 0.5) * 1.0) * (0.85 + rng() * 0.3);
    const px = cx + Math.sin(a) * M * 0.42;
    const py = cy + M * 0.72 - Math.cos(a) * L * 0.5;
    // スギは青みの強い濃緑。黄緑に振ると広葉樹と区別がつかなくなる
    const gr = 84 + Math.round(rng() * 40);
    drawCedarSpray(g, px, py, L, a, rng,
      `rgb(${Math.round(gr * 0.50)},${gr + 6},${Math.round(gr * 0.72)})`);
  }
}

/**
 * 葉テクスチャ。1 枚が「葉」ではなく「小枝ひと房」に相当する。
 * 背景は完全透過。アルファテストで抜くので半透明の縁は作らない。
 *
 * 2×2 のアトラスにして房を 4 種類描く。1 種類だと、どの向きから見ても
 * 同じ形が並んで「同じ板を貼った」ことが一目で分かってしまう。
 * どの房も縁に触れないよう内側に収める。テクスチャが縁で切れると
 * アルファテストの境界がカードの矩形そのものになり、葉ではなく板に見える。
 */
export function makeLeafTexture(kind, cell = 256) {
  const size = cell * LEAF_ATLAS;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rng = makeRng(kind === 'beech' ? 0x41b207 : 0x7d1e64);

  for (let j = 0; j < LEAF_ATLAS; j++) {
    for (let i = 0; i < LEAF_ATLAS; i++) {
      const cx = (i + 0.5) * cell, cy = (j + 0.5) * cell;
      if (kind === 'beech') drawBeechCluster(g, cx, cy, cell, rng);
      else drawCedarCluster(g, cx, cy, cell, rng);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------------- ジオメトリ ---------------- */

/**
 * 枝をチューブ化する。
 * フレームは平行移動（parallel transport）で運ぶ。各点で法線を作り直すと
 * 曲がった枝が軸まわりに捻れ、樹皮の縞が螺旋に見えてしまう。
 */
/* 樹皮タイルの縦の縮尺。幹（半径 0.4m 前後）では u が 2 周ぶんで
   1 枚 ≒ 1.26m なので、縦もそこへ合わせて正方形にする。
   0.45（＝ 1 枚 2.2m）だと縦に 1.75 倍伸びて、縞がなお «溝» に見えた */
export function buildBranches(skel, { radial = [8, 5, 4, 3], levelMax = 99, vScale = 0.8 } = {}) {
  const pos = [], nor = [], uv = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  const prevN = new THREE.Vector3(), tmp = new THREE.Vector3();

  for (const br of skel.branches) {
    if (br.level > levelMax) continue;
    const rad = Math.max(3, radial[Math.min(br.level, radial.length - 1)]);
    const pts = br.points;
    const base = pos.length / 3;
    let vAcc = 0;

    // 最初のフレーム
    T.set(pts[1].x - pts[0].x, pts[1].y - pts[0].y, pts[1].z - pts[0].z).normalize();
    prevN.copy(Math.abs(T.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : up).cross(T).normalize();

    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
      T.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
      // 直前の法線から接線成分を抜いて運ぶ＝捻れないフレーム
      N.copy(prevN).addScaledVector(T, -prevN.dot(T));
      if (N.lengthSq() < 1e-8) N.copy(Math.abs(T.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : up).cross(T);
      N.normalize();
      prevN.copy(N);
      B.crossVectors(T, N);

      if (i > 0) {
        const p = pts[i - 1];
        vAcc += Math.hypot(pts[i].x - p.x, pts[i].y - p.y, pts[i].z - p.z);
      }
      const r = pts[i].r;
      for (let j = 0; j <= rad; j++) {
        const ang = (j / rad) * TAU;
        const cx = Math.cos(ang), sy = Math.sin(ang);
        tmp.set(N.x * cx + B.x * sy, N.y * cx + B.y * sy, N.z * cx + B.z * sy);
        pos.push(pts[i].x + tmp.x * r, pts[i].y + tmp.y * r, pts[i].z + tmp.z * r);
        nor.push(tmp.x, tmp.y, tmp.z);
        // u は幹の太さに合わせて巻き数を変える（細い枝で樹皮が拡大されない）
        uv.push((j / rad) * Math.max(1, r * 5), vAcc * vScale);
      }
    }
    const ring = rad + 1;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = 0; j < rad; j++) {
        const a = base + i * ring + j, b = a + ring;
        /* 巻きは «外向き» に取る。
           a=(輪 i, 角 j) / b=(輪 i+1, 角 j) / a+1=(輪 i, 角 j+1) とすると
             (a, b, a+1) の面法線は (b-a)×(a+1-a) = T×(r dθ dDir) = -dir
           で内向きになる。FrontSide で描いているので «手前の壁» が
           カリングされ、向こう側の内壁が見える＝幹が筒の内側に見える。
           近くで «⊂ のはずが ⊃ に見える» のはこれ。順を入れ替えて外向きにする。 */
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * 葉カード。
 * stride で間引き、sizeScale で 1 枚を大きくすることで、
 * 同じ骨格からシルエットを保ったまま枚数だけ落とせる（＝LOD）。
 *
 * 法線はカードの面法線ではなく樹冠中心からの外向きを主にする。
 * 面法線のままだと 1 枚ごとに明暗が割れて、葉が板の集合に見える。
 */
const CELL = 1 / LEAF_ATLAS;

export function buildLeaves(skel, { stride = 1, sizeScale = 1, cross = true } = {}) {
  const pos = [], nor = [], uv = [], col = [], flt = [], idx = [];
  const f = new THREE.Vector3(), u = new THREE.Vector3(), w = new THREE.Vector3();
  const outward = new THREE.Vector3(), nrm = new THREE.Vector3(), card = new THREE.Vector3();
  const ref = new THREE.Vector3();

  // 樹冠の中心（葉の重心）と広がり
  let cx = 0, cy = 0, cz = 0;
  for (const l of skel.leaves) { cx += l.x; cy += l.y; cz += l.z; }
  const n0 = Math.max(1, skel.leaves.length);
  cx /= n0; cy /= n0; cz /= n0;
  let spread = 0.001;
  for (const l of skel.leaves) spread = Math.max(spread, Math.hypot(l.x - cx, l.y - cy, l.z - cz));

  for (let i = 0; i < skel.leaves.length; i += stride) {
    const l = skel.leaves[i];
    f.set(l.dx, l.dy, l.dz).normalize();
    ref.set(0, 1, 0);
    if (Math.abs(f.y) > 0.92) ref.set(1, 0, 0);
    u.crossVectors(f, ref).normalize();
    // roll でカードを軸まわりに回す（房ごとに向きが揃わないように）
    const c = Math.cos(l.roll), s = Math.sin(l.roll);
    w.crossVectors(f, u);
    const ux = u.x * c + w.x * s, uy = u.y * c + w.y * s, uz = u.z * c + w.z * s;
    u.set(ux, uy, uz);
    w.crossVectors(f, u).normalize();

    outward.set(l.x - cx, l.y - cy, l.z - cz);
    if (outward.lengthSq() < 1e-6) outward.set(0, 1, 0);
    const depth = clamp01(outward.length() / spread);
    outward.normalize();
    // 内側の房を暗くする（葉の重なりによる遮蔽の近似）。
    // これが無いと樹冠が均一に光って綿菓子に見える
    const ao = lerp(0.62, 1.0, depth * depth);

    const sz = l.size * sizeScale;
    /* アトラスのどのセルを引くか。roll から決めるので seed が同じなら同じ絵になる */
    const cellIdx = Math.floor(l.roll / TAU * (LEAF_ATLAS * LEAF_ATLAS)) % (LEAF_ATLAS * LEAF_ATLAS);
    // 房ごとの震えの位相。位置と roll から決めるので seed が同じなら再現する
    const phase = l.roll * 3.3 + (l.x * 4.7 + l.y * 2.9 + l.z * 3.7);
    const cu = cellIdx % LEAF_ATLAS, cv = (cellIdx / LEAF_ATLAS) | 0;
    const planes = cross ? [u, w] : [u];
    for (let pi = 0; pi < planes.length; pi++) {
      const A = planes[pi];
      // このカードの面法線。外向きに少しだけ混ぜて平板感を崩す
      card.crossVectors(f, A).normalize();
      const base = pos.length / 3;
      // カードは f を長手方向、A を幅方向に取る
      for (let k = 0; k < 4; k++) {
        const sx = (k === 0 || k === 3) ? -0.5 : 0.5;
        const sy = (k < 2) ? -0.5 : 0.5;
        pos.push(
          l.x + A.x * sx * sz + f.x * sy * sz,
          l.y + A.y * sx * sz + f.y * sy * sz,
          l.z + A.z * sx * sz + f.z * sy * sz
        );
        nrm.copy(outward).multiplyScalar(0.78).addScaledVector(card, 0.22).normalize();
        nor.push(nrm.x, nrm.y, nrm.z);
        uv.push((cu + (k === 0 || k === 3 ? 0 : 1)) * CELL, (cv + (k < 2 ? 0 : 1)) * CELL);
        col.push(ao, ao, ao);
        // 房の 4 頂点すべてに同じ位相を入れる（頂点ごとに変えるとカードが歪む）
        flt.push(phase);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aFlutter', new THREE.Float32BufferAttribute(flt, 1));
  geo.setIndex(idx);
  return geo;
}

/* ---------------- 遠景インポスター ---------------- */

/**
 * 1 本を正射影で焼いて、遠景用の板に貼るテクスチャを作る。
 * 陰影は焼かずアルベドだけにする（焼き込むと夕方でも遠景の森だけ
 * 真昼の色のまま残る）。板側は通常のマテリアルなので空の色を拾う。
 */
export function bakeImpostor(renderer, parts, { width = 256, height = 384, clearColor = 0x6f9440 } = {}) {
  const scene = new THREE.Scene();
  const box = new THREE.Box3();
  for (const m of parts) {
    scene.add(m);
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox);
  }
  const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 1.06;
  const h = (box.max.y - box.min.y) * 1.04;
  const cyy = (box.max.y + box.min.y) * 0.5;

  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 400);
  cam.position.set(0, cyy, 120);
  cam.lookAt(0, cyy, 0);

  const rt = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    samples: 0,               // MSAA を切って二値アルファにする（縁の黒フリンジ対策）
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;

  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  /* 焼くのはアルベドなのでトーンマップは掛けない。
     掛けると板を描くときにもう一度掛かって遠景の森だけ白ちゃける */
  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  /* 透明部分の RGB を黒ではなく葉の色で埋める。黒のままだと mipmap で
     葉の縁が黒と混ざり、遠景の森だけ煤けた輪郭になる（アルファブリード） */
  renderer.setClearColor(clearColor, 0);
  renderer.clear(true, true, false);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.toneMapping = prevTone;

  for (const m of parts) scene.remove(m);
  return { texture: rt.texture, target: rt, width: w, height: h, baseY: box.min.y };
}

/** インポスターを貼る十字 2 枚。原点は根元 */
function impostorGeometry(w, h, baseY) {
  const geo = new THREE.BufferGeometry();
  const pos = [], nor = [], uv = [], idx = [];
  for (let p = 0; p < 2; p++) {
    const ax = p === 0 ? 1 : 0, az = p === 0 ? 0 : 1;
    const base = pos.length / 3;
    for (let k = 0; k < 4; k++) {
      const sx = (k === 0 || k === 3) ? -0.5 : 0.5;
      const sy = (k < 2) ? 0 : 1;
      pos.push(ax * sx * w, baseY + sy * h, az * sx * w);
      // 板の法線は面ではなく上向き寄りにする。真横向きだと
      // 太陽が回ったとき遠景の森が一斉に暗転して帯に見える
      nor.push(az * 0.45, 0.86, -ax * 0.45);
      uv.push(k === 0 || k === 3 ? 0 : 1, sy);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/* ---------------- LOD 付きインスタンス管理 ---------------- */

/**
 * 種 × バリエーション × LOD ごとに InstancedMesh を持ち、
 * カメラ距離で木を各 LOD へ振り分ける。
 *
 * 木の 1 本 1 本は {x,y,z,ry,scale,sp,va,lod} だけを持ち、
 * LOD が変わった木があったときだけ行列を作り直して再アップロードする。
 */
export class TreeSet {
  /**
   * @param {THREE.Scene} scene
   * @param {{quality?: string, renderer?: THREE.WebGLRenderer, seed?: number,
   *          addWindSway?: Function, capacity?: number}} opts
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.quality = opts.quality || 'mid';
    const q = this.quality;
    const seed = (opts.seed ?? 1) >>> 0;
    const cap = opts.capacity ?? 520;

    this.kinds = Object.keys(SPECIES);
    this.swayMaterials = [];
    /* 段の振り分けは他の植生と同じ仕組みに載せる。
       境界の前後でディザのクロスフェードを効かせるため
       （木は岩と違って «粗い段＝細かい段の部分集合» にできない） */
    this.set = new LodInstances(scene, {
      lodDist: [...LOD_DIST], hysteresis: 8, interval: 0.15, fadeBand: LOD_FADE_BAND,
    });
    /* 樹高 1 に正規化したあとの根元半径。当たり判定はこれ × 樹高 */
    this.trunkR = {};
    this.renderer = opts.renderer || null;
    this._pendingBake = [];

    /* 近景の枝の細かさ。low では 1 段落として辺の数を減らす */
    const radial0 = q === 'low' ? [6, 4, 3, 3] : q === 'high' ? [9, 6, 4, 3] : [8, 5, 4, 3];
    const leafStride = q === 'low' ? 2 : 1;

    /* 葉は写真のカード（2x2 アトラス、1 セル 512）。UV の切り出しは
       LEAF_ATLAS のまま変わらないので、差し替えるだけでよい。
       «あとから差し替え» にしないのは、遠景インポスターがこのテクスチャを
       描いて焼くから。焼いたあとに差し替えると近景だけ写真になる */
    this.textures = {};
    for (const k of this.kinds) {
      this.textures[k] = {
        bark: makeBarkTexture(k),
        leaf: opts.leafTextures?.[k] || makeLeafTexture(k),
      };
    }

    for (const k of this.kinds) {
      const sp = SPECIES[k];
      /* color は白のまま。テクスチャ側がすでに樹皮色・葉色を持っているので、
         ここで種の色を掛けると 2 回掛かって幹も葉も真っ黒に沈む */
      const barkBase = { map: this.textures[k].bark, roughness: 0.95, metalness: 0 };
      const leafBase = {
        map: this.textures[k].leaf,
        roughness: 0.86, metalness: 0,
        alphaTest: 0.42, transparent: false,
        side: THREE.DoubleSide, vertexColors: true,
      };

      /* 風は LOD ごとに段を落とす。
         近景：幹・枝と葉が「同じ bend」で一緒に曲がり、葉だけさらに震える。
               葉だけ動かすと、近くで見たとき葉が枝から剥がれて浮いて見える。
         中景：bend だけを葉に掛ける。34m 以遠では幹と葉の数十cm のずれは
               1px 未満なので、幹の頂点を毎フレーム動かす価値がない。
         遠景：板なので動かさない。 */
      const bend = {
        strength: q === 'low' ? 0.024 : 0.034,
        freq: 1.05, gustiness: 0.55,
        // 幹は根元が硬い。高さに比例させると幹全体が弓なりになって不自然
        bendPow: 1.7,
      };
      const sway = opts.addWindSway ? (o) => (m) => opts.addWindSway(m, o) : () => null;
      const fade = (m) => lodDitherFade(m, LOD_FADE_BAND);
      const barkNear = applyPatches(new THREE.MeshStandardMaterial(barkBase), [sway(bend), fade]);
      const barkMid = lodDitherFade(new THREE.MeshStandardMaterial(barkBase), LOD_FADE_BAND);
      /* 葉の法線は «樹冠中心からの外向き» を自分で入れてある。
         DoubleSide の反転は表裏で決まるので、放っておくと樹冠の奥側の葉が
         手前と同じだけ太陽を向き、暗い側が消えて葉群が白っぽく飛ぶ */
      const translucency = (m) => foliageTranslucency(m, 0.14);
      const leafNear = applyPatches(new THREE.MeshStandardMaterial(leafBase), [
        sway({ ...bend, flutter: q === 'low' ? 0 : 0.010, flutterFreq: 2.9 }),
        keepAuthoredNormals, translucency, fade,
      ]);
      const leafMid = applyPatches(new THREE.MeshStandardMaterial(leafBase),
        [sway(bend), keepAuthoredNormals, translucency, fade]);
      if (opts.addWindSway) this.swayMaterials.push(barkNear, leafNear, leafMid);

      for (let va = 0; va < VARIANTS; va++) {
        const vaRng = makeRng(seed ^ (0x9e37 * (this.kinds.indexOf(k) + 1)) ^ (va * 0x51ed));
        const habit = deriveTreeHabit(k, vaRng);
        const skel = growTree(k, vaRng, { habit });
        const norm = 1 / Math.max(skel.height, 0.001);   // 樹高 1 に正規化して置く
        this.trunkR[k] = Math.max(this.trunkR[k] || 0, sp.trunkRadius * norm);

        // --- LOD0：近景 ---
        const b0 = buildBranches(skel, { radial: radial0 });
        const l0 = buildLeaves(skel, { stride: leafStride, sizeScale: 1, cross: true });
        /* --- LOD1：中景。枝は最終段を落とし、葉は 1/7 の枚数を 2.5 倍の大きさで ---
           板 1 枚にすると真横から見たカードが消えて樹冠に穴があき、
           近景から切り替わった瞬間に «葉が減った» と分かる。
           枚数を減らしてでも十字のままにしたほうが安定する。
           房を大きくすれば被覆面積は保てるので、ここを削って浮いた予算を
           近景のしきい値（LOD_DIST[0]）を広げる方へ回している */
        const b1 = buildBranches(skel, { radial: [4, 3, 3, 3], levelMax: sp.levels.length - 2 });
        const l1 = buildLeaves(skel, { stride: 7, sizeScale: 2.5, cross: true });
        for (const g of [b0, l0, b1, l1]) g.scale(norm, norm, norm);

        this._addLevel(k, va, 0, [
          { geo: b0, mat: barkNear, shadow: true },
          { geo: l0, mat: leafNear, shadow: true },
        ], cap);
        this._addLevel(k, va, 1, [
          { geo: b1, mat: barkMid, shadow: false },
          { geo: l1, mat: leafMid, shadow: false },
        ], cap);

        /* --- LOD2：遠景インポスター ---
           焼くには実サイズのある描画バッファが要る。読み込み中のタブが
           バックグラウンドで 0×0 のことがあるので、まず中景で代用しておき、
           サイズが付いたフレームで焼き直す（_tryBake）。
           ここで無条件に render すると 0×0 のコンテキストで固まる */
        this._addLevel(k, va, 2, [{ geo: l1, mat: leafMid, shadow: false }], cap);
        if (opts.renderer) {
          this._pendingBake.push({
            key: `${k}|${va}`, kind: k, branchGeo: b0, leafGeo: l0,
          });
        }
      }
    }
  }

  _addLevel(kind, va, lod, parts, cap) {
    this.set.register(`${kind}|${va}`, lod, parts, cap);
  }

  /**
   * 木を 1 本足す。scale は「樹高（m）」で指定する。
   * ジオメトリは樹高 1 に正規化してあるので、そのまま倍率になる。
   */
  add(x, y, z, height, kind, variant, ry) {
    /* 木ごとの色ムラ。2000 本が同一の緑だと、形をいくら作り込んでも
       «同じ木を並べた» ことが一目で分かる。位置から決めるので
       seed が同じならワールドは再現できる */
    this.set.add(x, y, z, height, `${kind}|${variant}`, ry, tintAt(x, z, 0.26, 0.14));
  }

  /**
   * 歩ける範囲から遠すぎて «絶対に遠景のまま» の木を足す。
   * 毎フレームの距離判定にも行列の作り直しにも乗らない。
   */
  addFar(x, y, z, height, kind, variant, ry) {
    this.set.addFixed(x, y, z, height, `${kind}|${variant}`,
      LOD_DIST.length, ry, tintAt(x, z, 0.26, 0.14));
  }

  /** 配置が終わったら 1 回。addFar したぶんをまとめて書き込む */
  buildFar() { return this.set.buildFixed(); }

  /**
   * まだ焼けていない遠景インポスターを焼いて LOD2 に差し替える。
   * 描画バッファに実サイズが付くまでは何もしない。
   */
  _tryBake() {
    if (!this._pendingBake.length || !this.renderer) return;
    const ctx = this.renderer.getContext();
    if (!ctx || ctx.drawingBufferWidth < 8 || ctx.drawingBufferHeight < 8) return;

    for (const job of this._pendingBake) {
      const sp = SPECIES[job.kind];
      const tex = this.textures[job.kind];
      const imp = bakeImpostor(this.renderer, [
        new THREE.Mesh(job.branchGeo, new THREE.MeshBasicMaterial({ map: tex.bark })),
        new THREE.Mesh(job.leafGeo, new THREE.MeshBasicMaterial({
          map: tex.leaf, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true,
        })),
      ], { clearColor: sp.leafColor });
      const mat = applyPatches(new THREE.MeshStandardMaterial({
        map: imp.texture, roughness: 1, metalness: 0,
        /* mipmap を落とすと二値アルファは痩せる。しきい値を下げて
           遠景の樹冠がスカスカにならないようにする */
        alphaTest: 0.22, transparent: false, side: THREE.DoubleSide,
      }), [keepAuthoredNormals, (m) => foliageTranslucency(m, 0.10),
        (m) => lodDitherFade(m, LOD_FADE_BAND)]);
      const geo = impostorGeometry(imp.width, imp.height, imp.baseY);
      this.set.replace(job.key, 2, [{ geo, mat }]);
    }
    this._pendingBake.length = 0;
  }

  /** カメラ距離で LOD を振り直す。変化があったときだけ行列を作り直す */
  update(dt, cameraPos) {
    this._tryBake();
    this.set.update(dt, cameraPos);
  }

  /** 実機で負荷を見ながら振るためのしきい値（terrain.setLodScale が触る） */
  get lodDist() { return this.set.lodDist; }

  get meshes() { return this.set.meshes; }

  /** デバッグ／テスト用：LOD ごとの本数 */
  lodCounts() { return this.set.counts(); }

  dispose() { this.set.dispose(); }

  setQuality(q) { this.quality = q; }

  dispose() {
    for (const im of this.meshes) {
      this.scene.remove(im);
      im.geometry.dispose();
    }
    this.meshes.length = 0;
  }
}
