/*
 * 코바늘 호수 → 게이지(10cm 당 코/단 수) 추정, 완성 크기 → 도안 칸 수 계산.
 * 브라우저(window.Gauge)와 Node(require) 양쪽에서 사용.
 */
(function (root) {
  'use strict';

  // 국내에서 주로 쓰는 일본식 호수 표기 + 점보 바늘
  const HOOKS = Object.freeze([
    { label: '2/0호', mm: 2.0 },
    { label: '3/0호', mm: 2.3 },
    { label: '4/0호', mm: 2.5 },
    { label: '5/0호', mm: 3.0 },
    { label: '6/0호', mm: 3.5 },
    { label: '7/0호', mm: 4.0 },
    { label: '7.5/0호', mm: 4.5 },
    { label: '8/0호', mm: 5.0 },
    { label: '9/0호', mm: 5.5 },
    { label: '10/0호', mm: 6.0 },
    { label: '점보 7mm', mm: 7.0 },
    { label: '점보 8mm', mm: 8.0 },
    { label: '점보 10mm', mm: 10.0 },
    { label: '점보 12mm', mm: 12.0 },
  ]);

  // 짧은뜨기 기준, 해당 바늘에 권장 굵기 실을 썼을 때 10cm 당 코 수 (평균값)
  const SC_STITCH_TABLE = Object.freeze([
    [2.0, 28], [2.5, 25], [3.0, 22], [3.5, 20], [4.0, 17], [4.5, 16],
    [5.0, 14], [5.5, 13], [6.0, 12], [7.0, 10.5], [8.0, 9], [10.0, 7], [12.0, 6],
  ]);

  // 뜨개 기법별: 코 수 보정, 단 수 = 코 수 × rowRatio
  const STITCHES = Object.freeze({
    sc: { label: '짧은뜨기', stitchFactor: 1.0, rowRatio: 1.1 },
    hdc: { label: '긴뜨기', stitchFactor: 0.9, rowRatio: 0.8 },
    dc: { label: '한길긴뜨기', stitchFactor: 0.85, rowRatio: 0.57 },
  });

  const CM_PER_GAUGE = 10;
  const MAX_CELLS_PER_SIDE = 400;

  function interpolate(table, x) {
    if (x <= table[0][0]) return table[0][1];
    const last = table[table.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < table.length; i++) {
      const [x1, y1] = table[i];
      if (x <= x1) {
        const [x0, y0] = table[i - 1];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return last[1];
  }

  /** 바늘 mm와 기법으로 10cm 당 코/단 수 추정 */
  function estimateGauge(hookMm, stitchKey) {
    const mm = Number(hookMm);
    if (!Number.isFinite(mm) || mm <= 0) throw new Error('코바늘 굵기(mm)가 올바르지 않습니다.');
    const stitch = STITCHES[stitchKey];
    if (!stitch) throw new Error(`알 수 없는 뜨개 기법: ${stitchKey}`);
    const stitches = interpolate(SC_STITCH_TABLE, mm) * stitch.stitchFactor;
    return {
      stitchesPer10cm: round1(stitches),
      rowsPer10cm: round1(stitches * stitch.rowRatio),
    };
  }

  /** 완성 크기(cm)와 게이지로 도안의 가로 코 수 × 세로 단 수 계산 */
  function computeGrid(widthCm, heightCm, gauge) {
    const w = Number(widthCm);
    const h = Number(heightCm);
    if (!(w > 0) || !(h > 0)) throw new Error('완성 크기는 0보다 커야 합니다.');
    const { stitchesPer10cm, rowsPer10cm } = gauge;
    if (!(stitchesPer10cm > 0) || !(rowsPer10cm > 0)) throw new Error('게이지는 0보다 커야 합니다.');

    const cols = Math.max(1, Math.round((w / CM_PER_GAUGE) * stitchesPer10cm));
    const rows = Math.max(1, Math.round((h / CM_PER_GAUGE) * rowsPer10cm));
    if (cols > MAX_CELLS_PER_SIDE || rows > MAX_CELLS_PER_SIDE) {
      throw new Error(`도안이 너무 큽니다 (${cols}코 × ${rows}단). 한 변 ${MAX_CELLS_PER_SIDE}칸 이하로 줄여 주세요.`);
    }
    return {
      cols,
      rows,
      // 한 코의 세로/가로 비율 → 화면에 실제 모양대로 그리기 위해 사용
      cellAspect: stitchesPer10cm / rowsPer10cm,
      actualWidthCm: round1((cols / stitchesPer10cm) * CM_PER_GAUGE),
      actualHeightCm: round1((rows / rowsPer10cm) * CM_PER_GAUGE),
    };
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  const api = { HOOKS, STITCHES, MAX_CELLS_PER_SIDE, estimateGauge, computeGrid };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Gauge = api;
})(typeof self !== 'undefined' ? self : this);
