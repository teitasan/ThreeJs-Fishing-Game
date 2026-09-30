/* ===========================================================
   生態区分の場（three・DOM 無し）
   -----------------------------------------------------------
   「日本の山の湖」を遠景の色の塊だけで読ませるための区分（art 案）：
     汀（汀線から 〜20m）       ヤナギ・ハンノキ（水辺に張り出す明るい緑）
     下部の緩い斜面（〜60m）     ブナ・ミズナラ・イロハモミジ（落葉広葉樹の明るいパッチ）
     中腹の植林区画（100–300m） スギ・ヒノキの列植（四角い暗い帯）
     尾根（標高 90m 超・凸・急） アカマツと露岩
   その間は広葉樹とスギの混交。沢筋（凹・湿）ほどスギ、乾いた凸地ほどアカマツ・ミズナラ。
   境目は fbm で崩す（一直線の境は «塗り分けた地図» に見える）。

   旧来の «木は h ≥ 1.6» を守るので、汀線から 0–12m には実際はほとんど木が立たない
   （その高さの砂浜・湿地は草とヨシの領分）。そのため汀の区分は «最初に立つ木の列» ＝
   汀線から 20m までにしてある。
   =========================================================== */
import { SPECIES_IDS } from './species.js';
import { stream, cellRng } from './rng.js';

export const SP = Object.fromEntries(SPECIES_IDS.map((id, i) => [id, i]));

/** 区分の名前（焼き込み・デバッグ表示用） */
export const ZONES = ['riparian', 'lower', 'plantation', 'mixed', 'ridge'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/* 植林区画を置く粗い格子（世界に固定）。1 セルに最大 1 区画 */
const PLANT_CELL = 260;

/**
 * 植林区画の一覧を作る。区画は回転した長方形（幅 100–300m）。
 * 中心が中腹（標高 12–110m、汀線から 60m 以上）にあるものだけ残す。
 */
export function makePlantations(lake, q = lake) {
  const s = stream(lake.seed, 'plantations');
  const out = [];
  const R = 520;
  const n = Math.ceil(R / PLANT_CELL);
  for (let j = -n; j < n; j++) {
    for (let i = -n; i < n; i++) {
      const rng = cellRng(s, i, j);
      if (rng() > 0.72) continue;
      const cx = (i + 0.2 + rng() * 0.6) * PLANT_CELL;
      const cz = (j + 0.2 + rng() * 0.6) * PLANT_CELL;
      const r = Math.hypot(cx, cz);
      if (r > 470) continue;
      const h = q.heightAt(cx, cz);
      const shoreD = r - q.shoreRadius(cx, cz);
      if (h < 12 || h > 110 || shoreD < 60) continue;
      const w = 100 + rng() * 200, d = 80 + rng() * 150;
      /* 植林は等高線に沿って列を切るので、区画の長辺も斜面を横切る向きに寄せる */
      const radial = Math.atan2(cz, cx);
      const rot = radial + Math.PI / 2 + (rng() - 0.5) * 0.9;
      out.push({
        cx, cz, w, d, rot,
        /* 区画ごとに主木を決める（ヒノキの区画は少し明るい） */
        dominant: rng() < 0.68 ? SP.sugi : SP.hinoki,
        /* 同齢林：区画ごとの樹齢（樹高の倍率） */
        age: 0.72 + rng() * 0.3,
        /* 列の間隔（m）。間伐後の成林で 1 本あたり 11–13m² */
        rowGap: 3.4 + rng() * 0.5, treeGap: 3.1 + rng() * 0.4,
        id: out.length,
      });
    }
  }
  return out;
}

/** 点が区画の中なら区画、外なら null。edge は縁からの距離（m、内側で正） */
export function plantationAt(plantations, x, z) {
  for (const p of plantations) {
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    const dx = x - p.cx, dz = z - p.cz;
    const u = dx * c + dz * s, v = -dx * s + dz * c;
    const eu = p.w / 2 - Math.abs(u), ev = p.d / 2 - Math.abs(v);
    if (eu > 0 && ev > 0) return { p, u, v, edge: Math.min(eu, ev) };
  }
  return null;
}

/**
 * 生態の場。heightAt 以外の «高い» 評価（曲率）は呼び手が要るときだけ取る。
 * @param {object} lake
 * @param {object} q makeQueries(lake)
 */
export function makeEcology(lake, q) {
  const noise = lake.noise;
  const plantations = makePlantations(lake, q);
  /* 入り江の度合い：その角度の汀線が両隣（±0.12rad）より外へ張り出しているほど «ワンド» */
  const COVE_N = 720;
  const cove = new Float32Array(COVE_N);
  {
    const sr = new Float64Array(COVE_N);
    for (let k = 0; k < COVE_N; k++) sr[k] = lake.shoreAtAngle((k / COVE_N) * Math.PI * 2);
    const w = Math.round(0.12 / (Math.PI * 2 / COVE_N));
    for (let k = 0; k < COVE_N; k++) {
      const m = (sr[(k - w + COVE_N) % COVE_N] + sr[(k + w) % COVE_N]) / 2;
      cove[k] = clamp01((sr[k] - m) / 6);
    }
  }
  const coveAt = (x, z) => {
    const a = Math.atan2(z, x);
    const k = Math.round(((a / (Math.PI * 2)) % 1 + 1) % 1 * COVE_N) % COVE_N;
    return cove[k];
  };

  /** 湿り気 0..1：汀線の近さ・沢筋（凹）・北向き・fbm */
  const moistureAt = (x, z, shoreD, curv, aspectN) => {
    const n = noise.fbm(x * 0.0065 + 17.3, z * 0.0065 - 8.1, 2);
    return clamp01(0.45 + n * 0.35 + clamp01(1 - shoreD / 40) * 0.35 + curv * 0.9 + aspectN * 0.12);
  };

  /* 曲率と斜面の向きは 10m 刻みの粗い高さ格子から取る（木 1 本ごとに heightAt を
     4 回足すと配置の予算 250ms を超える）。格子も lake だけから決まるので決定的 */
  const G = 10, GN = 101, GO = -500;
  const coarse = new Float64Array(GN * GN);
  for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) coarse[j * GN + i] = q.heightAt(GO + i * G, GO + j * G);
  const hC = (x, z) => {
    let u = (x - GO) / G, v = (z - GO) / G;
    u = Math.min(GN - 1.000001, Math.max(0, u)); v = Math.min(GN - 1.000001, Math.max(0, v));
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const a = coarse[j * GN + i], b = coarse[j * GN + i + 1], c = coarse[(j + 1) * GN + i], d = coarse[(j + 1) * GN + i + 1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  };

  /** 曲率（10m の 5 点ラプラシアン、凹で正）と北向きの度合い */
  const terrainShape = (x, z) => {
    const e = 10;
    const h = hC(x, z);
    const hL = hC(x - e, z), hR = hC(x + e, z);
    const hD = hC(x, z - e), hU = hC(x, z + e);
    const curv = (hL + hR + hD + hU - 4 * h) / (e * e);
    /* 下り斜面の向き。z+ を «北» とする（sunDir.z = +0.34 の南中の太陽は z+ 側に傾くので、
       z− を向いた斜面が日陰になる） */
    const gx = (hR - hL) / (2 * e), gz = (hU - hD) / (2 * e);
    const g = Math.hypot(gx, gz) || 1;
    const aspectN = clamp01(gz / g) * clamp01(g * 3);
    return { curv: Math.max(-0.08, Math.min(0.08, curv)) * 6, aspectN };
  };

  /**
   * 自然林（植林区画の外）の樹種を選ぶ。u は [0,1) の一様乱数。
   * @returns {{species:number, zone:number}}
   */
  const pickNatural = (x, z, h, slope, shoreD, u, u2) => {
    const wob = noise.fbm(x * 0.021 - 5.1, z * 0.021 + 2.7, 2) * 7;   // 境目を崩す
    if (shoreD + wob < 20 && h < 5) {
      /* 汀：ヤナギとハンノキ。入り江ほどヤナギ */
      const cv = coveAt(x, z);
      if (u < 0.40 + cv * 0.25) return { species: SP.yanagi, zone: 0 };
      if (u < 0.88) return { species: SP.hannoki, zone: 0 };
      return { species: SP.momiji, zone: 0 };
    }
    const { curv, aspectN } = terrainShape(x, z);
    const ridge = smooth(78, 105, h + wob * 2) * (0.6 + 0.4 * smooth(-0.1, -0.35, curv)) + smooth(0.55, 0.9, slope) * smooth(55, 90, h) * 0.5;
    if (ridge > 0.55 || (ridge > 0.3 && u2 < ridge)) {
      if (u < 0.72) return { species: SP.akamatsu, zone: 4 };
      if (u < 0.88) return { species: SP.mizunara, zone: 4 };
      return { species: SP.momiji, zone: 4 };
    }
    const moist = moistureAt(x, z, shoreD, curv, aspectN);
    if (shoreD + wob < 60 && slope < 0.45) {
      /* 下部の緩斜面：落葉広葉樹。湿ったところにハンノキが混じる */
      if (u < 0.36) return { species: SP.buna, zone: 1 };
      if (u < 0.64) return { species: SP.mizunara, zone: 1 };
      if (u < 0.84) return { species: SP.momiji, zone: 1 };
      if (u < 0.84 + moist * 0.16) return { species: SP.hannoki, zone: 1 };
      return { species: SP.buna, zone: 1 };
    }
    /* 中腹の混交林：沢筋ほどスギ、乾いた凸地ほどアカマツ・ミズナラ */
    const pSugi = 0.08 + moist * 0.34;
    const pPine = 0.04 + clamp01(0.55 - moist) * 0.3;
    if (u < pSugi) return { species: SP.sugi, zone: 3 };
    if (u < pSugi + pPine) return { species: SP.akamatsu, zone: 3 };
    const r = (u - pSugi - pPine) / (1 - pSugi - pPine);
    if (r < 0.42) return { species: SP.buna, zone: 3 };
    if (r < 0.74) return { species: SP.mizunara, zone: 3 };
    if (r < 0.9) return { species: SP.momiji, zone: 3 };
    return { species: SP.hinoki, zone: 3 };
  };

  /** 林の空き地（旧 _buildProps の forestField / cluster と同じ場） */
  const forestGap = (x, z) => {
    const forestCoarse = noise.fbm(x * 0.009, z * 0.009, 3);
    const forestFine = noise.fbm(x * 0.038 + 11.3, z * 0.038 - 11.3, 2);
    return forestCoarse * 0.58 + forestFine * 0.42;
  };
  const forestCluster = (x, z) => noise.fbm(x * 0.015 + 3.1, z * 0.015 - 3.1, 2);

  return {
    plantations,
    coveAt,
    pickNatural,
    forestGap,
    forestCluster,
    terrainShape,
    moistureAt,
    plantationAt: (x, z) => plantationAt(plantations, x, z),
    /** 焼き込み（GPU の被覆マップなど）に渡すパラメータ */
    params: {
      zones: ZONES,
      plantations: plantations.map((p) => ({ ...p })),
      riparianShoreD: 20, lowerShoreD: 60, ridgeH: [78, 105],
      noise: {
        gap: { coarse: [0.009, 3], fine: [0.038, 2, 11.3], mix: [0.58, 0.42], threshold: -0.07 },
        cluster: { scale: 0.015, offset: 3.1, threshold: -0.14 },
        wobble: { scale: 0.021, offset: [-5.1, 2.7], amp: 7 },
        moisture: { scale: 0.0065, offset: [17.3, -8.1] },
      },
    },
  };
}
