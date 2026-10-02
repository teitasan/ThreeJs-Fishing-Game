/* 雲パノラマの帯の順（three を import しない：Node のテストから読む） */
/** 帯の順（n 本を «黄金比の歩み» で巡る：続けて隣を描かず、n 回で全部を 1 回ずつ） */
export function stripAt(k, n) {
  const step = Math.max(1, Math.round(n * 0.381966));
  let s = step;
  while (gcd(s, n) !== 1) s++;
  return ((k % n) * s) % n;
}
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
