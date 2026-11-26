/*
 * 방안뜨기(필레 뜨기): 도안의 각 색을 "채움(■)" 또는 "비움(□)"으로 나눠 두 가지 칸으로 보여줌.
 * 도안 데이터는 그대로 여러 색으로 두고, 팔레트 색마다 filled(true/false) 표시만 붙인다.
 * 그래서 칠하기·색 합치기·대칭은 기존 그대로 동작하고, 화면·단별 순서·저장만 두 가지로 바뀐다.
 */
(function (root) {
  'use strict';

  const rgbToLab = typeof module !== 'undefined' && module.exports
    ? require('./quantize.js').rgbToLab
    : root.Quantize.rgbToLab;

  const FILLED = Object.freeze({ r: 58, g: 54, b: 50, name: '■ 채움', symbol: '' });
  const OPEN = Object.freeze({ r: 255, g: 255, b: 255, name: '□ 비움', symbol: '' });

  const lightness = (c) => rgbToLab(c)[0];

  /**
   * 기본 채움/비움 정하기: 배경색 밝기와 가장 어두운 색 밝기의 중간보다 어두우면 채움.
   * (밝은 바탕에 어두운 무늬가 채워지는 일반적인 방안뜨기)
   */
  function withDefaultFill(palette, background) {
    if (palette.length === 0) return palette;
    const bgL = lightness(background);
    const levels = palette.map(lightness);
    const darkest = Math.min(...levels);
    const middle = (bgL + darkest) / 2;
    const hasContrast = Math.abs(bgL - darkest) > 1;
    return palette.map((c, i) => ({ ...c, filled: hasContrast ? levels[i] < middle : false }));
  }

  function toggleFill(palette, index) {
    return palette.map((c, i) => (i === index ? { ...c, filled: !c.filled } : c));
  }

  /** 화면에 칠할 색: 채움은 진한 색, 비움은 흰색 */
  function displayPalette(palette) {
    return palette.map((c) => (c.filled ? FILLED : OPEN));
  }

  /** 채움/비움 두 가지로 바꾼 도안 (0 = 채움, 1 = 비움) — 단별 순서·저장용 */
  function toFiletPattern(pattern, palette) {
    const indices = pattern.indices.map((i) => (palette[i] && palette[i].filled ? 0 : 1));
    return { pattern: { ...pattern, indices }, palette: [FILLED, OPEN] };
  }

  const api = { FILLED, OPEN, withDefaultFill, toggleFill, displayPalette, toFiletPattern };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Filet = api;
})(typeof self !== 'undefined' ? self : this);
