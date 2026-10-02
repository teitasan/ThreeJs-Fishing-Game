/* underwater の純関数の検査（src/gfx/underwater/optics.js・spectrum.js・quality.js、three 無し）
   - 光学：§6.3 の σa・σs、雨で濁る、Fresnel の透過（正面 ≈ 0.98、低い太陽ほど小さい）、内散乱は正
   - 読みやすさ（ゲーム性）：グレーカード（0.18）のコントラストが 10m で十分・距離で単調に減り、30m で «霞に溶ける»。雨で下がる
   - caustics のスペクトル：決定的、空間と時間で厳密に周期（ヘッセ行列が L と 1 巡で一致）、面積比の明るさの平均 ≈ 1（浅い所）
   - 品質表：§6.3 / §7 の値 */
import assert from 'node:assert/strict';
import { waterOptics, fresnelTransmit, greyCardContrast, UW_SIGMA_A } from '../../src/gfx/underwater/optics.js';
import { causticSpectrum, spectrumHessian, causticIntensity, CS_WAVES } from '../../src/gfx/underwater/spectrum.js';
import { UW_TIERS, uwTier } from '../../src/gfx/underwater/quality.js';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

/* ---- 光学 ---- */
const noon = { keyRad: [3.2, 3.0, 2.7], keyY: 0.9, skyIrr: [0.25, 0.32, 0.45] };
const clear = waterOptics(noon), rain = waterOptics({ ...noon, rain: 1, cloud: 1 });
ok(clear.sigmaA.every((v, i) => Math.abs(v - UW_SIGMA_A[i]) < 1e-12) && Math.abs(clear.sigmaS - 0.03) < 1e-12, '晴れの σa・σs（§6.3）');
ok(rain.sigmaA.every((v, i) => Math.abs(v - UW_SIGMA_A[i] * 1.5) < 1e-12) && Math.abs(rain.sigmaS - 0.06) < 1e-12, '雨で σa × 1.5、σs 0.06');
ok(Math.abs(rain.turbidity - 1.62) < 1e-9 && clear.turbidity === 1, '濁り = 1 + 0.5·rain + 0.12·cloud');
ok(clear.insc.every((v) => v > 0 && Number.isFinite(v)), '内散乱は正');
ok(clear.insc[1] > clear.insc[0], '内散乱は青緑（G > R）');
ok(fresnelTransmit(1) > 0.97 && fresnelTransmit(1) < 0.99, `正面の透過 ${fresnelTransmit(1).toFixed(3)}`);
ok(fresnelTransmit(0.1) < fresnelTransmit(0.5) && fresnelTransmit(0.5) < fresnelTransmit(1), '低い太陽ほど透過が小さい');
ok(fresnelTransmit(NaN) >= 0 && fresnelTransmit(-3) >= 0, 'NaN・負でも範囲内');
const night = waterOptics({ keyRad: [0, 0, 0], keyY: -0.3, skyIrr: [0.001, 0.001, 0.002] });
ok(night.keyE.every((v) => v === 0) && night.insc.every((v) => v >= 0), '夜は key の E = 0');

/* ---- 読みやすさ（グレーカード 0.18、カメラを向く縦の板、深さ 2m。水平に見る）----
   縦の板の放射照度：屈折した key（天頂から ≈ 43°）の方位平均 ≈ 0.3·E_key、空の光は半球の半分 ≈ 0.5·E_sky */
const Eplate = (op, depth) => op.keyE.map((e, k) => (e * 0.3 + noon.skyIrr[k] * Math.PI * 0.8 * 0.5) * Math.exp(-(op.sigmaA[k] + 0.3 * op.sigmaS) * depth));
const c = [10, 20, 30].map((d) => greyCardContrast(d, clear, Eplate(clear, 2)));
const cr = [10, 20, 30].map((d) => greyCardContrast(d, rain, Eplate(rain, 2)));
console.log(`  グレーカードのコントラスト 晴れ 10/20/30m = ${c.map((v) => v.toFixed(3)).join(' / ')}、雨 = ${cr.map((v) => v.toFixed(3)).join(' / ')}`);
ok(c[0] > 0.1, `10m で読める（${c[0].toFixed(3)} > 0.1）`);
ok(c[0] > c[1] && c[1] > c[2], '距離で単調に減る');
ok(c[1] > 0.02, `20m で «影» として残る（${c[1].toFixed(3)} > 0.02）`);
ok(c[2] < 0.05, `30m で霞に溶ける（${c[2].toFixed(3)} < 0.05）`);
ok(cr[0] < c[0] && cr[1] < c[1], '雨で読みにくくなる');

/* ---- caustics のスペクトル ---- */
const S = causticSpectrum({ seed: 5 }), S2 = causticSpectrum({ seed: 5 });
ok(S.waves.length === CS_WAVES, `成分 ${S.waves.length} = ${CS_WAVES}`);
ok(JSON.stringify(S.waves) === JSON.stringify(S2.waves), 'スペクトルは決定的');
for (const [x, y, ph] of [[0.3, 1.7, 0.1], [5.1, -2.2, 0.77], [12.0, 3.3, 0.5]]) {
  const a = spectrumHessian(S, x, y, ph), b = spectrumHessian(S, x + S.period, y - S.period, ph + 1);
  ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-6 * (1 + Math.abs(v))), `空間 L・時間 1 巡で周期（${x}, ${y}）`);
}
/* 浅い所（D 小）では面積比の平均 ≈ 1（エネルギーの保存）、深くすると明線が立つ（分散が増える） */
const stat = (D) => {
  let s = 0, s2 = 0, m = 0;
  for (let i = 0; i < 48; i++) for (let j = 0; j < 48; j++) {
    const h = spectrumHessian(S, (i / 48) * S.period, (j / 48) * S.period, 0.3);
    const I = causticIntensity(h[0], h[1], h[2], D);
    s += I; s2 += I * I; m++;
  }
  const mean = s / m;
  return { mean, sd: Math.sqrt(Math.max(s2 / m - mean * mean, 0)) };
};
const sh = stat(0.05), dp = stat(0.6);
ok(Math.abs(sh.mean - 1) < 0.05, `浅い所の平均 ${sh.mean.toFixed(3)} ≈ 1`);
ok(dp.sd > sh.sd * 3, `深いと明線が立つ（sd ${sh.sd.toFixed(3)} → ${dp.sd.toFixed(3)}）`);

/* ---- 品質表（§6.3 / §7） ---- */
ok(UW_TIERS.high.tile === 512 && UW_TIERS.high.frames === 16 && UW_TIERS.mid.tile === 256 && UW_TIERS.mid.frames === 8 && UW_TIERS.low.frames === 8, 'caustics の焼き込み 16 × 512² / 8 × 256²');
ok(UW_TIERS.high.plankton === 800 && UW_TIERS.mid.plankton === 400 && UW_TIERS.low.plankton === 150, 'プランクトン 800 / 400 / 150');
ok(UW_TIERS.high.shaftSteps >= 12 && UW_TIERS.mid.shaftSteps >= 8 && UW_TIERS.low.shaftSteps === 0, '光柱 12 / 8 ステップ・low は解析');
ok(UW_TIERS.high.shaftScale >= UW_TIERS.mid.shaftScale && UW_TIERS.mid.shaftScale >= UW_TIERS.low.shaftScale, '光柱の解像度は段で単調');
ok(uwTier('x') === UW_TIERS.mid, '知らない段は mid');

console.log(`underwater-optics: ${n} 件合格`);
