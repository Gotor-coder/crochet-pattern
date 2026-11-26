/*
 * 캔버스에 도안 그리기 (격자, 5/10칸 굵은 선, 단·코 번호, 색 기호) + PNG 내보내기용 범례.
 */
(function (root) {
  'use strict';

  const { symbolFor } = root.Pattern;
  // 팔레트 색에 symbol 이 따로 있으면(방안뜨기의 채움/비움 등) 그걸, 없으면 A·B·C 기호
  const symbolOf = (palette, i) => (palette[i] && palette[i].symbol != null ? palette[i].symbol : symbolFor(i));
  const { textColorFor, toHex } = root.Quantize;

  const MARGIN = 34; // 번호 표시 여백(px)
  const FONT = '"Pretendard", "Malgun Gothic", system-ui, sans-serif';
  const LINE_THIN = 'rgba(0,0,0,0.18)';
  const LINE_FIVE = 'rgba(0,0,0,0.45)';
  const LINE_TEN = 'rgba(180,40,40,0.85)';

  /**
   * @param opts {cellW, cellAspect, showSymbols, showGrid, showNumbers, highlightColor}
   * @returns layout 정보 (클릭 좌표 → 칸 계산용)
   */
  function drawPattern(canvas, pattern, palette, opts) {
    const { cols, rows, indices } = pattern;
    const cellW = opts.cellW;
    const cellH = cellW * opts.cellAspect;
    const margin = opts.showNumbers ? MARGIN : 0;
    const width = Math.ceil(cols * cellW + margin * 2);
    const height = Math.ceil(rows * cellH + margin * 2);
    const dpr = opts.pixelRatio || 1;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    const fills = palette.map(toHex);
    const dim = opts.highlightColor != null;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const c = indices[y * cols + x];
        ctx.fillStyle = fills[c];
        ctx.globalAlpha = dim && c !== opts.highlightColor ? 0.18 : 1;
        ctx.fillRect(margin + x * cellW, margin + y * cellH, cellW + 0.5, cellH + 0.5);
      }
    }
    ctx.globalAlpha = 1;

    if (opts.showSymbols && cellW >= 9 && cellH >= 9) drawSymbols(ctx, pattern, palette, margin, cellW, cellH);
    if (opts.showGrid) drawGrid(ctx, cols, rows, margin, cellW, cellH);
    if (opts.showNumbers) drawNumbers(ctx, cols, rows, margin, cellW, cellH);

    return { margin, cellW, cellH, cols, rows };
  }

  function drawSymbols(ctx, pattern, palette, margin, cellW, cellH) {
    const { cols, rows, indices } = pattern;
    const textColors = palette.map(textColorFor);
    const size = Math.min(cellW, cellH) * 0.6;
    ctx.font = `600 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const c = indices[y * cols + x];
        ctx.fillStyle = textColors[c];
        ctx.fillText(symbolOf(palette, c), margin + (x + 0.5) * cellW, margin + (y + 0.5) * cellH + 0.5);
      }
    }
  }

  // 오른쪽 아래(1단 1코)부터 세기 때문에 선 굵기도 오른쪽/아래 기준
  function drawGrid(ctx, cols, rows, margin, cellW, cellH) {
    const line = (x0, y0, x1, y1, style, w) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    };
    const styleFor = (n) => (n % 10 === 0 ? [LINE_TEN, 1.6] : n % 5 === 0 ? [LINE_FIVE, 1.2] : [LINE_THIN, 0.6]);
    const right = margin + cols * cellW;
    const bottom = margin + rows * cellH;

    for (let i = 0; i <= cols; i++) {
      const fromRight = cols - i;
      const [s, w] = fromRight === 0 || i === 0 ? [LINE_FIVE, 1.2] : styleFor(fromRight);
      const x = margin + i * cellW;
      line(x, margin, x, bottom, s, w);
    }
    for (let j = 0; j <= rows; j++) {
      const fromBottom = rows - j;
      const [s, w] = fromBottom === 0 || j === 0 ? [LINE_FIVE, 1.2] : styleFor(fromBottom);
      const y = margin + j * cellH;
      line(margin, y, right, y, s, w);
    }
  }

  function drawNumbers(ctx, cols, rows, margin, cellW, cellH) {
    ctx.fillStyle = '#555';
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'middle';
    const every = (cell) => (cell >= 14 ? 1 : cell >= 7 ? 5 : 10);

    // 단 번호: 오른쪽, 아래가 1단
    const rowStep = every(cellH);
    ctx.textAlign = 'left';
    for (let r = 1; r <= rows; r++) {
      if (r !== 1 && r % rowStep !== 0) continue;
      const y = margin + (rows - r + 0.5) * cellH;
      ctx.fillText(String(r), margin + cols * cellW + 5, y);
    }
    // 코 번호: 아래쪽, 오른쪽이 1코
    const colStep = every(cellW);
    ctx.textAlign = 'center';
    for (let c = 1; c <= cols; c++) {
      if (c !== 1 && c % colStep !== 0) continue;
      const x = margin + (cols - c + 0.5) * cellW;
      ctx.fillText(String(c), x, margin + rows * cellH + 14);
    }
  }

  /** 화면 좌표 → 칸 좌표 (밖이면 null) */
  function cellAt(canvas, layout, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = parseFloat(canvas.style.width) / rect.width;
    const scaleY = parseFloat(canvas.style.height) / rect.height;
    const px = (clientX - rect.left) * scaleX - layout.margin;
    const py = (clientY - rect.top) * scaleY - layout.margin;
    const x = Math.floor(px / layout.cellW);
    const y = Math.floor(py / layout.cellH);
    if (x < 0 || y < 0 || x >= layout.cols || y >= layout.rows) return null;
    return { x, y };
  }

  /** 인쇄/저장용: 제목 + 도안 + 범례를 한 장의 캔버스로 */
  function renderExport(pattern, palette, counts, info) {
    const gridCanvas = document.createElement('canvas');
    const cellW = Math.max(12, Math.min(24, Math.floor(2400 / pattern.cols)));
    drawPattern(gridCanvas, pattern, palette, {
      cellW, cellAspect: info.cellAspect, showSymbols: true, showGrid: true, showNumbers: true,
    });

    const pad = 32;
    const headerH = 70;
    const swatchRowH = 30;
    const perRow = Math.max(1, Math.floor((gridCanvas.width - pad) / 230));
    const legendH = Math.ceil(palette.length / perRow) * swatchRowH + 40;
    const out = document.createElement('canvas');
    out.width = Math.max(gridCanvas.width + pad * 2, 520);
    out.height = headerH + gridCanvas.height + legendH + pad;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);

    ctx.fillStyle = '#222';
    ctx.font = `700 22px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.fillText(info.title, pad, 20);
    ctx.font = `14px ${FONT}`;
    ctx.fillStyle = '#555';
    ctx.fillText(info.subtitle, pad, 48);

    ctx.drawImage(gridCanvas, pad, headerH);

    let y = headerH + gridCanvas.height + 20;
    ctx.font = `600 15px ${FONT}`;
    ctx.fillStyle = '#222';
    ctx.fillText('사용 색상', pad, y);
    y += 26;
    ctx.font = `13px ${FONT}`;
    palette.forEach((color, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x0 = pad + col * 230;
      const y0 = y + row * swatchRowH;
      ctx.fillStyle = toHex(color);
      ctx.fillRect(x0, y0, 22, 22);
      ctx.strokeStyle = '#999';
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, 21, 21);
      ctx.fillStyle = textColorFor(color);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(symbolOf(palette, i), x0 + 11, y0 + 12);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#333';
      ctx.fillText(`${color.name || toHex(color)}  ·  ${counts[i]}${info.unit || "코"}`, x0 + 30, y0 + 12);
    });
    return out;
  }

  root.Render = { drawPattern, cellAt, renderExport };
})(typeof self !== 'undefined' ? self : this);
