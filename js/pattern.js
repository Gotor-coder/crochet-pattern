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

  /** from 색을 to 색으로 합치고 팔레트에서 from 제거 */
  function mergeColor(pattern, palette, from, to) {
    if (from === to) return { pattern, palette };
    const shift = (i) => (i > from ? i - 1 : i);
    const indices = pattern.indices.map((i) => shift(i === from ? to : i));
    const nextPalette = palette.filter((_, i) => i !== from);
    return { pattern: { ...pattern, indices }, palette: nextPalette };
  }

  // 칸 동그라미: 반지름보다 살짝 안쪽까지만 채워야 3칸은 +, 4칸은 모서리 빠진 네모처럼 예쁘게 나옴
  const CIRCLE_FILL = 0.85;

  /** 지름 d칸 동그라미의 칸 좌표. (x, y)가 동그라미 가운데(짝수면 가운데 4칸 중 왼쪽 위) */
  function circleCells(x, y, d) {
    const size = Math.max(1, Math.floor(d));
    const half = size / 2;
    const limit = half * half * CIRCLE_FILL;
    const start = Math.floor((size - 1) / 2);
    const cells = [];
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const dx = i + 0.5 - half;
        const dy = j + 0.5 - half;
        if (size === 1 || dx * dx + dy * dy <= limit) cells.push({ x: x - start + i, y: y - start + j });
      }
    }
    return cells;
  }

  /** 칸 목록에 좌우 거울 위치를 더함 (중복 제거) */
  function withMirror(cells, cols) {
    const seen = new Set();
    const out = [];
    for (const c of [...cells, ...cells.map(({ x, y }) => ({ x: cols - 1 - x, y }))]) {
      const key = `${c.x},${c.y}`;
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    }
    return out;
  }

  /** 여러 칸을 한 번에 칠한 새 도안 (도안 밖 칸은 무시). 변경 없으면 같은 객체 */
  function paintCells(pattern, cells, color) {
    let indices = null;
    for (const { x, y } of cells) {
      if (x < 0 || y < 0 || x >= pattern.cols || y >= pattern.rows) continue;
      const at = y * pattern.cols + x;
      if (pattern.indices[at] === color) continue;
      if (!indices) indices = pattern.indices.slice();
      indices[at] = color;
    }
    return indices ? { ...pattern, indices } : pattern;
  }

  /** 좌우 대칭: side 'left' 면 왼쪽 절반을 오른쪽에, 'right' 면 반대로 복사 */
  function mirrorPattern(pattern, side) {
    if (side !== 'left' && side !== 'right') return pattern;
    const { cols, rows } = pattern;
    const indices = pattern.indices.slice();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const mirrorX = cols - 1 - x;
        const isTarget = side === 'left' ? x > mirrorX : x < mirrorX;
        if (isTarget) indices[y * cols + x] = pattern.indices[y * cols + mirrorX];
      }
    }
    return { ...pattern, indices };
  }

  /** 도안에서 안 쓰는 색을 팔레트에서 빼고 번호를 다시 매김 */
  function dropUnusedColors(pattern, palette) {
    const used = countColors(pattern, palette.length).map((n) => n > 0);
    if (used.every(Boolean)) return { pattern, palette };
    const newIndex = [];
    let next = 0;
    used.forEach((u, i) => { newIndex[i] = u ? next++ : -1; });
    return {
      pattern: { ...pattern, indices: pattern.indices.map((i) => newIndex[i]) },
      palette: palette.filter((_, i) => used[i]),
    };
  }

  const api = {
    symbolFor, rowInstructions, countColors, mergeColor,
    circleCells, withMirror, paintCells, mirrorPattern, dropUnusedColors,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Pattern = api;
})(typeof self !== 'undefined' ? self : this);
