/*
 * 이미지 → 칸 도안 색 정하기.
 * 1) 원본 픽셀에서 k-means로 "깨끗한" 대표 색(팔레트)을 뽑고
 * 2) 원본 픽셀 하나하나를 팔레트 색으로 바꾼 뒤
 * 3) 칸마다 가장 많이 차지한 색을 고름. 단, 눈·입처럼 전체에서 드문 색은 가중치를 줘서 살림.
 * 칸 평균색을 쓰면 경계가 섞여 뭉개지므로 평균을 쓰지 않는다.
 * 순수 함수만 포함 (DOM 의존 없음). window.Quantize / require 둘 다 지원.
 */
(function (root) {
  'use strict';

  const ALPHA_THRESHOLD = 128; // 이보다 투명하면 배경색으로 처리
  const MAX_ITERATIONS = 24;
  const MAX_SAMPLES = 6000;
  const PALETTE_SAMPLE_PIXELS = 40000; // 팔레트 뽑을 때 읽는 원본 픽셀 수(대략)
  const DETAIL_EXPONENT_SCALE = 0.6; // detail 1 일 때 드문 색 가중치 지수
  const DEFAULT_DETAIL = 0.6;
  const WHITE_BG = Object.freeze({ r: 255, g: 255, b: 255 });

  function pixelAt(data, i, bg) {
    if (data[i + 3] < ALPHA_THRESHOLD) return bg;
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
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
   * RGBA 원본(srcW×srcH)을 cols×rows 칸 도안으로 변환.
   * @param opts {colors, background, detail(0~1: 작은 부분 살리기 정도), seed}
   * @returns {{palette: Array<{r,g,b,count}>, indices: number[]}} 팔레트는 많이 쓰인 순
   */
  function quantizeImage(data, srcW, srcH, cols, rows, opts) {
    if (data.length < srcW * srcH * 4) throw new Error('픽셀 데이터 크기가 맞지 않습니다.');
    const o = opts || {};
    const bg = o.background || WHITE_BG;
    const detail = o.detail == null ? DEFAULT_DETAIL : Math.max(0, Math.min(1, o.detail));
    const rand = seededRandom(o.seed == null ? 1234 : o.seed);

    const samples = samplePalettePoints(data, srcW, srcH, bg);
    const k = Math.max(1, Math.min(Math.floor(o.colors || 6), samples.length));
    const centers = kmeans(samples, k, rand);
    const nearest = makeNearestLookup(centers);

    const { cellCounts, totals } = countCellColors(data, srcW, srcH, cols, rows, k, bg, nearest);
    const weights = rarityWeights(totals, detail);
    const raw = new Array(cols * rows);
    for (let c = 0; c < cols * rows; c++) raw[c] = pickCellColor(cellCounts, c * k, k, weights);
    return compactPalette(centers.map(labToRgb), raw);
  }

  // 팔레트용 표본: 원본을 일정 간격으로 훑어 Lab 점 목록 생성
  function samplePalettePoints(data, srcW, srcH, bg) {
    const step = Math.max(1, Math.floor(Math.sqrt((srcW * srcH) / PALETTE_SAMPLE_PIXELS)));
    const points = [];
    for (let y = 0; y < srcH; y += step) {
      for (let x = 0; x < srcW; x += step) points.push(rgbToLab(pixelAt(data, (y * srcW + x) * 4, bg)));
    }
    return points;
  }

  // 같은 색을 여러 번 계산하지 않도록 RGB(각 6비트) → 팔레트 번호 캐시
  function makeNearestLookup(centers) {
    const cache = new Int16Array(1 << 18).fill(-1);
    return ({ r, g, b }) => {
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      if (cache[key] < 0) cache[key] = nearestIndex(rgbToLab({ r, g, b }), centers);
      return cache[key];
    };
  }

  // 칸마다 팔레트 색별 픽셀 수, 그리고 전체 픽셀 수
  function countCellColors(data, srcW, srcH, cols, rows, k, bg, nearest) {
    const cellCounts = new Uint32Array(cols * rows * k);
    const totals = new Float64Array(k);
    for (let y = 0; y < srcH; y++) {
      const cy = Math.min(rows - 1, Math.floor((y * rows) / srcH));
      for (let x = 0; x < srcW; x++) {
        const cx = Math.min(cols - 1, Math.floor((x * cols) / srcW));
        const color = nearest(pixelAt(data, (y * srcW + x) * 4, bg));
        cellCounts[(cy * cols + cx) * k + color]++;
        totals[color]++;
      }
    }
    return { cellCounts, totals };
  }

  // 전체에서 드문 색일수록 큰 가중치 (detail 0 이면 모두 1 → 단순 다수결)
  function rarityWeights(totals, detail) {
    const sum = totals.reduce((s, v) => s + v, 0) || 1;
    const exponent = detail * DETAIL_EXPONENT_SCALE;
    return Array.from(totals, (t) => (t > 0 ? Math.pow(t / sum, -exponent) : 0));
  }

  function pickCellColor(cellCounts, offset, k, weights) {
    let best = 0, bestScore = -1;
    for (let i = 0; i < k; i++) {
      const score = cellCounts[offset + i] * weights[i];
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
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

  const api = { quantizeImage, rgbToLab, labToRgb, toHex, hexToRgb, textColorFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Quantize = api;
})(typeof self !== 'undefined' ? self : this);
