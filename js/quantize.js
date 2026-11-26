/*
 * 이미지 → 칸 단위 평균색(다운샘플) → k-means 색 줄이기.
 * 순수 함수만 포함 (DOM 의존 없음). window.Quantize / require 둘 다 지원.
 */
(function (root) {
  'use strict';

  const ALPHA_THRESHOLD = 0.5; // 칸의 절반 이상이 투명하면 배경색으로 처리
  const MAX_ITERATIONS = 24;
  const MAX_SAMPLES = 6000;

  /**
   * RGBA 픽셀 배열을 cols × rows 칸으로 나눠 각 칸의 평균색을 구함.
   * 투명한 부분은 background 색으로 합성.
   * @returns {Array<{r:number,g:number,b:number}>} 길이 cols*rows, 위→아래, 왼→오른 순서
   */
  function averageCells(data, srcW, srcH, cols, rows, background) {
    if (data.length < srcW * srcH * 4) throw new Error('픽셀 데이터 크기가 맞지 않습니다.');
    const bg = background || { r: 255, g: 255, b: 255 };
    const cells = new Array(cols * rows);
    const cellW = srcW / cols;
    const cellH = srcH / rows;

    for (let cy = 0; cy < rows; cy++) {
      const y0 = Math.floor(cy * cellH);
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cellH));
      for (let cx = 0; cx < cols; cx++) {
        const x0 = Math.floor(cx * cellW);
        const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cellW));
        cells[cy * cols + cx] = averageBlock(data, srcW, x0, Math.min(x1, srcW), y0, Math.min(y1, srcH), bg);
      }
    }
    return cells;
  }

  function averageBlock(data, srcW, x0, x1, y0, y1, bg) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * srcW + x) * 4;
        const alpha = data[i + 3] / 255;
        r += data[i] * alpha;
        g += data[i + 1] * alpha;
        b += data[i + 2] * alpha;
        a += alpha;
        n++;
      }
    }
    if (n === 0 || a / n < ALPHA_THRESHOLD) return { ...bg };
    // 반투명 부분은 배경색과 섞기
    const cover = a / n;
    return {
      r: Math.round((r / a) * cover + bg.r * (1 - cover)),
      g: Math.round((g / a) * cover + bg.g * (1 - cover)),
      b: Math.round((b / a) * cover + bg.b * (1 - cover)),
    };
  }

  // ---------- 색 공간 변환 (sRGB ↔ CIE Lab) : 사람 눈에 가까운 색 거리 ----------
  function srgbToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(v) {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  }
  const WHITE = { x: 0.95047, y: 1.0, z: 1.08883 };
  function fLab(t) {
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  }
  function fLabInv(t) {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  }

  function rgbToLab({ r, g, b }) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / WHITE.x;
    const y = (lr * 0.2126 + lg * 0.7152 + lb * 0.0722) / WHITE.y;
    const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / WHITE.z;
    const fx = fLab(x), fy = fLab(y), fz = fLab(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labToRgb([L, A, B]) {
    const fy = (L + 16) / 116;
    const x = fLabInv(fy + A / 500) * WHITE.x;
    const y = fLabInv(fy) * WHITE.y;
    const z = fLabInv(fy - B / 200) * WHITE.z;
    return {
      r: linearToSrgb(x * 3.2406 + y * -1.5372 + z * -0.4986),
      g: linearToSrgb(x * -0.9689 + y * 1.8758 + z * 0.0415),
      b: linearToSrgb(x * 0.0557 + y * -0.204 + z * 1.057),
    };
  }

  function dist2(p, q) {
    const d0 = p[0] - q[0], d1 = p[1] - q[1], d2 = p[2] - q[2];
    return d0 * d0 + d1 * d1 + d2 * d2;
  }

  // 결과가 매번 같도록 고정 시드 난수
  function seededRandom(seed) {
    let s = seed >>> 0;
    return function next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function nearestIndex(point, centers) {
    let best = 0, bestD = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const d = dist2(point, centers[c]);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // k-means++ 초기 중심 선택
  function initCenters(points, k, rand) {
    const centers = [points[Math.floor(rand() * points.length)]];
    const d = points.map((p) => dist2(p, centers[0]));
    while (centers.length < k) {
      const total = d.reduce((s, v) => s + v, 0);
      if (total === 0) break; // 서로 다른 색이 k개보다 적음
      let target = rand() * total;
      let pick = 0;
      for (; pick < points.length - 1; pick++) {
        target -= d[pick];
        if (target <= 0) break;
      }
      const c = points[pick];
      centers.push(c);
      for (let i = 0; i < points.length; i++) d[i] = Math.min(d[i], dist2(points[i], c));
    }
    return centers;
  }

  function sample(points, rand) {
    if (points.length <= MAX_SAMPLES) return points;
    const out = new Array(MAX_SAMPLES);
    for (let i = 0; i < MAX_SAMPLES; i++) out[i] = points[Math.floor(rand() * points.length)];
    return out;
  }

  function kmeans(points, k, rand) {
    const train = sample(points, rand);
    let centers = initCenters(train, k, rand);
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const sums = centers.map(() => [0, 0, 0, 0]);
      for (const p of train) {
        const s = sums[nearestIndex(p, centers)];
        s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
      }
      let moved = 0;
      const next = centers.map((c, i) => {
        const s = sums[i];
        if (s[3] === 0) return c;
        const nc = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
        moved = Math.max(moved, dist2(c, nc));
        return nc;
      });
      centers = next;
      if (moved < 0.01) break;
    }
    return centers;
  }

  /**
   * 칸 색 목록을 최대 colorCount 가지 색으로 줄임.
   * @returns {{palette: Array<{r,g,b,count}>, indices: number[]}} 팔레트는 많이 쓰인 순
   */
  function quantize(cells, colorCount, seed) {
    const k = Math.max(1, Math.min(Math.floor(colorCount), cells.length));
    const rand = seededRandom(seed == null ? 1234 : seed);
    const points = cells.map(rgbToLab);
    const centers = kmeans(points, k, rand);
    const raw = points.map((p) => nearestIndex(p, centers));
    return compactPalette(centers.map(labToRgb), raw);
  }

  // 안 쓰인 색 제거, 같은 RGB로 반올림된 색 합치기, 사용량 순 정렬
  function compactPalette(colors, rawIndices) {
    const keyOf = (c) => `${c.r},${c.g},${c.b}`;
    const uniqueByKey = new Map();
    const counts = new Map();
    const remap = colors.map((c) => {
      const key = keyOf(c);
      if (!uniqueByKey.has(key)) uniqueByKey.set(key, c);
      return key;
    });
    rawIndices.forEach((i) => counts.set(remap[i], (counts.get(remap[i]) || 0) + 1));

    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const newIndexOf = new Map(ordered.map(([key], i) => [key, i]));
    return {
      palette: ordered.map(([key, count]) => ({ ...uniqueByKey.get(key), count })),
      indices: rawIndices.map((i) => newIndexOf.get(remap[i])),
    };
  }

  function toHex({ r, g, b }) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) throw new Error(`색상 코드가 올바르지 않습니다: ${hex}`);
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /** 배경 위 글자색: 밝은 칸엔 검정, 어두운 칸엔 흰색 */
  function textColorFor({ r, g, b }) {
    return rgbToLab({ r, g, b })[0] > 60 ? '#222' : '#fff';
  }

  const api = { averageCells, quantize, rgbToLab, labToRgb, toHex, hexToRgb, textColorFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Quantize = api;
})(typeof self !== 'undefined' ? self : this);
