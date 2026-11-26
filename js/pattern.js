/*
 * 도안 데이터 도우미: 색 기호, 단별 뜨기 순서, 칸 칠하기(불변), 색 합치기.
 * 도안 데이터 = { cols, rows, indices: number[] (위→아래, 왼→오른) }
 */
(function (root) {
  'use strict';

  const SYMBOLS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 헷갈리는 I, O 제외

  function symbolFor(index) {
    if (index < SYMBOLS.length) return SYMBOLS[index];
    return SYMBOLS[Math.floor(index / SYMBOLS.length) - 1] + SYMBOLS[index % SYMBOLS.length];
  }

  /**
   * 단별 뜨기 순서. 1단 = 도안 맨 아래 줄.
   * 오른손잡이 기준 홀수 단은 오른쪽→왼쪽, 짝수 단은 왼쪽→오른쪽.
   * @returns {Array<{row:number, direction:'←'|'→', runs:Array<{color:number,count:number}>}>}
   */
  function rowInstructions(pattern, options) {
    const leftHanded = Boolean(options && options.leftHanded);
    const { cols, rows, indices } = pattern;
    const result = [];
    for (let row = 1; row <= rows; row++) {
      const gridY = rows - row;
      const line = indices.slice(gridY * cols, gridY * cols + cols);
      const rightToLeft = (row % 2 === 1) !== leftHanded;
      const ordered = rightToLeft ? line.slice().reverse() : line;
      result.push({ row, direction: rightToLeft ? '←' : '→', runs: toRuns(ordered) });
    }
    return result;
  }

  function toRuns(line) {
    const runs = [];
    for (const color of line) {
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.count++;
      else runs.push({ color, count: 1 });
    }
    return runs;
  }

  function countColors(pattern, colorCount) {
    const counts = new Array(colorCount).fill(0);
    for (const i of pattern.indices) counts[i]++;
    return counts;
  }

  /** (x, y) 칸을 color로 칠한 새 도안 반환. 변경 없으면 같은 객체 반환 */
  function paintCell(pattern, x, y, color) {
    if (x < 0 || y < 0 || x >= pattern.cols || y >= pattern.rows) return pattern;
    const at = y * pattern.cols + x;
    if (pattern.indices[at] === color) return pattern;
    const indices = pattern.indices.slice();
    indices[at] = color;
    return { ...pattern, indices };
  }

  /** from 색을 to 색으로 합치고 팔레트에서 from 제거 */
  function mergeColor(pattern, palette, from, to) {
    if (from === to) return { pattern, palette };
    const shift = (i) => (i > from ? i - 1 : i);
    const indices = pattern.indices.map((i) => shift(i === from ? to : i));
    const nextPalette = palette.filter((_, i) => i !== from);
    return { pattern: { ...pattern, indices }, palette: nextPalette };
  }

  const api = { symbolFor, rowInstructions, countColors, paintCell, mergeColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Pattern = api;
})(typeof self !== 'undefined' ? self : this);
