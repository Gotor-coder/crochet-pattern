/* 화면 연결: 입력 → 도안 생성 → 그리기 / 범례 / 단별 순서 / 저장 */
(function () {
  'use strict';

  const { HOOKS, STITCHES, estimateGauge, computeGrid, filetFoundationChains } = window.Gauge;
  const { withDefaultFill, toggleFill, displayPalette, toFiletPattern } = window.Filet;
  const { quantizeImage, toHex, hexToRgb, textColorFor } = window.Quantize;
  const {
    symbolFor, rowInstructions, countColors, mergeColor,
    circleCells, withMirror, paintCells, mirrorPattern, dropUnusedColors,
  } = window.Pattern;
  const Render = window.Render;

  const DEFAULT_HOOK_MM = 4.0;
  const SAMPLE_PER_CELL_MIN = 4; // 칸 하나 당 원본에서 읽을 픽셀 수(한 변)
  const SAMPLE_PER_CELL_MAX = 16;
  const MAX_WORK_PIXELS = 4000000; // 한 번에 처리할 원본 픽셀 상한 (속도)
  const SMALL_PATTERN_COLS = 40; // 이보다 작으면 작은 부분이 사라질 수 있다고 안내
  const MAX_CANVAS_SIDE = 8000;
  const MAX_FILE_BYTES = 30 * 1024 * 1024;
  const DEBOUNCE_MS = 250;
  const HISTORY_LIMIT = 50;

  const $ = (id) => document.getElementById(id);
  const el = {};
  [
    'fileInput', 'dropZone', 'dropText', 'thumb', 'hook', 'stitch', 'gaugeText', 'customGauge',
    'customGaugeFields', 'gaugeSts', 'gaugeRows', 'widthCm', 'heightCm', 'keepRatio', 'colorCount',
    'colorCountText', 'bgColor', 'summary', 'error', 'zoom', 'showSymbols', 'showGrid', 'paintMode',
    'undoBtn', 'savePng', 'printBtn', 'chartWrap', 'empty', 'chart', 'leftHanded', 'rowList',
    'originalImg', 'previewCanvas', 'totalText', 'mergeBox', 'selectedLabel', 'mergeTarget',
    'mergeBtn', 'clearSelect', 'legend', 'printImg', 'banner', 'saveFormat', 'detail', 'detailText',
    'brush', 'symmetry', 'offsetX', 'offsetY', 'offsetXText', 'offsetYText', 'offsetReset',
    'gaugeStsLabel', 'rowsHint',
  ].forEach((id) => { el[id] = $(id); });

  let state = {
    image: null,
    grid: null,
    gauge: null,
    pattern: null,
    palette: [],
    history: [],
    edited: false,
    selected: null,
    layout: null,
    doneRows: new Set(),
  };
  const setState = (patch) => { state = { ...state, ...patch }; };

  // ---------------- 초기화 ----------------
  function init() {
    HOOKS.forEach((h) => el.hook.add(new Option(`${h.label} (${h.mm}mm)`, String(h.mm), false, h.mm === DEFAULT_HOOK_MM)));
    Object.entries(STITCHES).forEach(([key, s]) => el.stitch.add(new Option(s.label, key)));
    bindInputs();
    bindImageInputs();
    bindChart();
    bindLegend();
    updateGaugeText();
    setupHost();
  }

  // claude.ai 공유 링크로 열렸을 때: 저장은 뷰어의 저장 기능으로, 인쇄는 지원되지 않으므로 숨김
  let hostDownloads = null; // Promise<downloads namespace | null>
  function setupHost() {
    const claude = window.claude;
    if (!claude || typeof claude.use !== 'function') {
      registerOfflineSupport();
      return;
    }
    el.printBtn.hidden = true;
    hostDownloads = claude.use('downloads').catch(() => null);
  }

  // 홈 화면 앱(PWA): 웹 주소(https/localhost)로 열렸을 때만 오프라인 저장본 등록
  function registerOfflineSupport() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('sw.js').catch(() => {
      // 오프라인 저장 실패는 앱 사용에 지장이 없으므로 화면에 알리지 않음 (온라인에선 그대로 동작)
    });
  }

  const debounce = (fn) => {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, DEBOUNCE_MS); };
  };
  const regenerateSoon = debounce(() => regenerate());

  function bindInputs() {
    const onGaugeInputs = () => { updateGaugeText(); regenerateSoon(); };
    el.hook.addEventListener('change', onGaugeInputs);
    el.stitch.addEventListener('change', onGaugeInputs);
    el.customGauge.addEventListener('change', () => {
      el.customGaugeFields.hidden = !el.customGauge.checked;
      if (el.customGauge.checked && !el.gaugeSts.value) {
        const g = estimateGauge(el.hook.value, el.stitch.value);
        el.gaugeSts.value = g.stitchesPer10cm;
        el.gaugeRows.value = g.rowsPer10cm;
      }
      onGaugeInputs();
    });
    el.gaugeSts.addEventListener('input', onGaugeInputs);
    el.gaugeRows.addEventListener('input', onGaugeInputs);
    // input(타이핑) + change(스피너·붙여넣기·포커스 이동) 둘 다 반영
    ['input', 'change'].forEach((ev) => {
      el.widthCm.addEventListener(ev, () => { syncRatio('width'); regenerateSoon(); });
      el.heightCm.addEventListener(ev, () => { syncRatio('height'); regenerateSoon(); });
    });
    el.keepRatio.addEventListener('change', () => { syncRatio('width'); regenerateSoon(); });
    el.colorCount.addEventListener('input', () => { el.colorCountText.textContent = el.colorCount.value; regenerateSoon(); });
    el.detail.addEventListener('input', () => { el.detailText.textContent = detailLabel(el.detail.value); regenerateSoon(); });
    el.detailText.textContent = detailLabel(el.detail.value);
    el.symmetry.addEventListener('change', regenerateSoon);
    const onOffset = () => {
      el.offsetXText.textContent = offsetLabel(el.offsetX.value, '오른쪽', '왼쪽');
      el.offsetYText.textContent = offsetLabel(el.offsetY.value, '아래', '위');
      regenerateSoon();
    };
    el.offsetX.addEventListener('input', onOffset);
    el.offsetY.addEventListener('input', onOffset);
    el.offsetReset.addEventListener('click', () => { el.offsetX.value = '0'; el.offsetY.value = '0'; onOffset(); });
    el.bgColor.addEventListener('input', regenerateSoon);

    el.zoom.addEventListener('input', drawChart);
    el.showSymbols.addEventListener('change', drawChart);
    el.showGrid.addEventListener('change', drawChart);
    el.paintMode.addEventListener('change', () => {
      el.chartWrap.classList.toggle('painting', el.paintMode.checked);
      drawChart();
    });
    el.undoBtn.addEventListener('click', undo);
    el.savePng.addEventListener('click', saveImage);
    el.printBtn.addEventListener('click', printPattern);
    el.leftHanded.addEventListener('change', renderRows);

    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !isTyping(e.target)) { e.preventDefault(); undo(); }
    });
  }

  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['chart', 'rows', 'original'].forEach((n) => { $(`tab-${n}`).hidden = n !== name; });
  }

  // ---------------- 이미지 불러오기 ----------------
  function bindImageInputs() {
    el.fileInput.addEventListener('change', () => el.fileInput.files[0] && loadFile(el.fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => el.dropZone.addEventListener(ev, (e) => {
      e.preventDefault(); el.dropZone.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => el.dropZone.addEventListener(ev, (e) => {
      e.preventDefault(); el.dropZone.classList.remove('over');
    }));
    el.dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    });
    document.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (item) loadFile(item.getAsFile());
    });
  }

  function loadFile(file) {
    if (!file.type.startsWith('image/')) return showError('이미지 파일만 불러올 수 있어요.');
    if (file.size > MAX_FILE_BYTES) return showError('이미지가 너무 커요 (30MB 이하).');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setState({ image: img, edited: false });
      el.thumb.src = url;
      el.thumb.hidden = false;
      el.dropText.hidden = true;
      el.originalImg.src = url;
      syncRatio('width');
      regenerate({ fresh: true });
    };
    img.onerror = () => { URL.revokeObjectURL(url); showError('이미지를 열 수 없어요. 다른 파일로 시도해 주세요.'); };
    img.src = url;
  }

  function syncRatio(changed) {
    if (!el.keepRatio.checked || !state.image) return;
    const ratio = state.image.naturalHeight / state.image.naturalWidth;
    if (changed === 'width') {
      const w = parseFloat(el.widthCm.value);
      if (w > 0) el.heightCm.value = round1(w * ratio);
    } else {
      const h = parseFloat(el.heightCm.value);
      if (h > 0) el.widthCm.value = round1(h / ratio);
    }
  }
  const round1 = (n) => Math.round(n * 10) / 10;
  const detailLabel = (v) => (v < 20 ? '약하게' : v < 70 ? '보통' : '강하게');
  // 슬라이더 값(-50~50) = 칸의 몇 % 만큼 미는지
  const offsetLabel = (v, plus, minus) => {
    const n = Number(v);
    return n === 0 ? '0' : `${n > 0 ? plus : minus} ${Math.abs(n) / 100}칸`;
  };

  // ---------------- 게이지 ----------------
  function currentGauge() {
    if (el.customGauge.checked) {
      return { stitchesPer10cm: parseFloat(el.gaugeSts.value), rowsPer10cm: parseFloat(el.gaugeRows.value) };
    }
    return estimateGauge(el.hook.value, el.stitch.value);
  }

  function updateGaugeText() {
    try {
      const g = currentGauge();
      el.gaugeText.textContent = `${g.stitchesPer10cm}${currentUnit()} × ${g.rowsPer10cm}단`;
      el.gaugeStsLabel.textContent = `10cm 당 ${currentUnit()} 수`;
    } catch (err) {
      el.gaugeText.textContent = '-';
    }
  }

  // ---------------- 도안 생성 ----------------
  // 설정이 바뀌면 항상 새로 만든다. 직접 고친 도안은 되돌리기(↶)로 복구할 수 있게 기록에 남긴다.
  function regenerate(opts) {
    if (!state.image) return;
    const fresh = opts && opts.fresh;
    try {
      const gauge = currentGauge();
      const grid = computeGrid(el.widthCm.value, el.heightCm.value, gauge);
      const built = buildPattern(state.image, grid, {
        colors: Number(el.colorCount.value),
        background: hexToRgb(el.bgColor.value),
        detail: Number(el.detail.value) / 100,
        offsetX: Number(el.offsetX.value) / 100,
        offsetY: Number(el.offsetY.value) / 100,
      });
      const mirrored = mirrorPattern({ cols: grid.cols, rows: grid.rows, indices: built.indices }, el.symmetry.value);
      const cleaned = dropUnusedColors(mirrored, built.palette);
      const filet = Boolean(STITCHES[el.stitch.value] && STITCHES[el.stitch.value].filet);
      const pattern = cleaned.pattern;
      const palette = filet ? withDefaultFill(cleaned.palette, hexToRgb(el.bgColor.value)) : cleaned.palette;
      const keepEdits = !fresh && state.edited && state.pattern;
      setState({
        gauge, grid, palette, pattern, filet,
        size: { width: el.widthCm.value, height: el.heightCm.value },
        history: keepEdits ? [...state.history, snapshot()].slice(-HISTORY_LIMIT) : [],
        edited: false, selected: null, doneRows: new Set(),
      });
      hideError();
      fitZoom(grid.cols);
      if (keepEdits) showNotice('설정이 바뀌어 도안을 새로 만들었어요. 직접 고친 도안은 ↶ 되돌리기로 복구할 수 있어요.');
      renderAll();
    } catch (err) {
      showError(`${err.message} (지금 보이는 도안은 이전 설정이에요)`);
    }
  }

  // 도안 가로가 화면 폭에 맞도록 확대 값을 정함 (휴대폰에서 처음부터 전체가 보이게)
  const ZOOM_MIN = 4;
  const ZOOM_DEFAULT = 14;
  const CHART_CHROME_PX = 2 * 34 + 24; // 번호 여백 양쪽 + 감싸는 상자 안쪽 여백
  function fitZoom(cols) {
    const available = el.chartWrap.clientWidth - CHART_CHROME_PX;
    if (available <= 0) return;
    const fit = Math.floor(available / cols);
    el.zoom.value = String(Math.max(ZOOM_MIN, Math.min(ZOOM_DEFAULT, fit)));
  }

  // 칸 하나 당 원본 픽셀을 여러 개(한 변 4~16개) 읽어서 칸 안의 색 비율을 셈.
  // offsetX/Y(칸 단위 비율)만큼 이미지를 밀어 그려서, 눈 같은 부분이 칸 가운데 오도록 맞출 수 있게 함.
  // 밀려서 빈 가장자리는 투명 → 배경색으로 처리됨.
  function buildPattern(img, grid, opts) {
    const perCell = Math.max(SAMPLE_PER_CELL_MIN, Math.min(SAMPLE_PER_CELL_MAX,
      Math.floor(Math.sqrt(MAX_WORK_PIXELS / (grid.cols * grid.rows)))));
    const sw = Math.max(grid.cols, Math.min(img.naturalWidth, grid.cols * perCell));
    const sh = Math.max(grid.rows, Math.min(img.naturalHeight, grid.rows * perCell));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    const dx = (opts.offsetX || 0) * (sw / grid.cols);
    const dy = (opts.offsetY || 0) * (sh / grid.rows);
    ctx.drawImage(img, dx, dy, sw, sh);
    const { data } = ctx.getImageData(0, 0, sw, sh);
    return quantizeImage(data, sw, sh, grid.cols, grid.rows, opts);
  }

  // ---------------- 그리기 ----------------
  function renderAll() {
    const ready = Boolean(state.pattern);
    el.empty.hidden = ready;
    el.chart.hidden = !ready;
    el.savePng.disabled = !ready;
    el.printBtn.disabled = !ready;
    el.undoBtn.disabled = state.history.length === 0;
    if (!ready) return;
    renderSummary();
    drawChart();
    renderLegend();
    renderRows();
    drawPreview();
  }

  function renderSummary() {
    const { grid, gauge, pattern, palette } = state;
    const custom = el.customGauge.checked;
    const unit = currentUnit();
    const total = (pattern.cols * pattern.rows).toLocaleString();
    el.summary.innerHTML =
      `도안: 가로 <b>${grid.cols}${unit}</b> × 세로 <b>${grid.rows}단</b><br>` +
      `완성 예상 크기: 약 ${grid.actualWidthCm} × ${grid.actualHeightCm} cm<br>` +
      (state.filet
        ? `총 ${total}칸 · 시작 사슬 <b>${filetFoundationChains(grid.cols)}코</b> + 첫 단 기둥 사슬 3코<br>`
        : `총 ${total}코 · ${palette.length}가지 색<br>`) +
      `<small>게이지 ${gauge.stitchesPer10cm}${unit} × ${gauge.rowsPer10cm}단 / 10cm ` +
      `${custom ? '(직접 입력)' : '(호수 기준 추정 — 실 굵기·손땀에 따라 달라요)'}</small>` +
      summaryNote(grid, unit);
  }

  function summaryNote(grid, unit) {
    if (state.filet) {
      return '<br><small>방안뜨기는 한 칸이 한길긴뜨기 3코 폭이라 칸이 커요. ' +
        '글자·실루엣처럼 단순한 무늬가 잘 어울리고, 아래 "사용 색상"에서 색마다 채움/비움을 바꿀 수 있어요.</small>';
    }
    if (grid.cols >= SMALL_PATTERN_COLS) return '';
    return `<br><small>⚠️ 가로 ${grid.cols}${unit}는 작은 편이라 눈·입 같은 작은 부분이 한두 칸으로 줄어들어요. ` +
      '더 선명하게 하려면 완성 크기를 키우거나 더 가는 바늘을 골라 보세요.</small>';
  }

  const currentUnit = () => (STITCHES[el.stitch.value] || STITCHES.sc).unit;
  // 화면에 칠할 팔레트: 방안뜨기면 채움(진한 색)/비움(흰색), 아니면 실제 색
  const shownPalette = () => (state.filet ? displayPalette(state.palette) : state.palette);

  function drawChart() {
    if (!state.pattern) return;
    const cellW = Number(el.zoom.value);
    const cellH = cellW * state.grid.cellAspect;
    const maxSide = Math.max(state.pattern.cols * cellW, state.pattern.rows * cellH) + 80;
    const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_CANVAS_SIDE / maxSide));
    const layout = Render.drawPattern(el.chart, state.pattern, shownPalette(), {
      cellW,
      cellAspect: state.grid.cellAspect,
      showSymbols: el.showSymbols.checked,
      showGrid: el.showGrid.checked,
      showNumbers: true,
      highlightColor: el.paintMode.checked ? null : state.selected,
      pixelRatio,
    });
    setState({ layout });
  }

  function drawPreview() {
    Render.drawPattern(el.previewCanvas, state.pattern, shownPalette(), {
      cellW: 4, cellAspect: state.grid.cellAspect, showSymbols: false, showGrid: false, showNumbers: false,
    });
  }

  // ---------------- 칠하기 ----------------
  function bindChart() {
    let drawing = false;
    const brushSize = () => Number(el.brush.value) || 1;
    // 1칸 붓은 끌면서 칠하고, 동그라미 붓은 누른 자리에 한 번 찍음. 좌우 대칭이 켜져 있으면 반대쪽에도.
    const paintAt = (e) => {
      const cell = Render.cellAt(el.chart, state.layout, e.clientX, e.clientY);
      if (!cell) return;
      const shape = circleCells(cell.x, cell.y, brushSize());
      const cells = el.symmetry.value === 'off' ? shape : withMirror(shape, state.pattern.cols);
      const next = paintCells(state.pattern, cells, state.selected);
      if (next !== state.pattern) {
        setState({ pattern: next, edited: true });
        drawChart();
      }
    };
    el.brush.addEventListener('change', () => {
      if (brushSize() > 1 && !el.paintMode.checked) el.paintMode.click(); // 도장을 고르면 칠하기 켜기
    });
    el.chart.addEventListener('pointerdown', (e) => {
      if (!el.paintMode.checked || !state.pattern) return;
      if (state.selected == null) return showError('칠할 색을 아래 "사용 색상"에서 먼저 골라 주세요.');
      hideError();
      pushHistory();
      drawing = true;
      el.chart.setPointerCapture(e.pointerId);
      paintAt(e);
    });
    el.chart.addEventListener('pointermove', (e) => { if (drawing && brushSize() === 1) paintAt(e); });
    const stop = () => {
      if (!drawing) return;
      drawing = false;
      renderLegend();
      renderRows();
      drawPreview();
    };
    el.chart.addEventListener('pointerup', stop);
    el.chart.addEventListener('pointercancel', stop);
  }

  const snapshot = () => ({
    pattern: state.pattern, palette: state.palette, grid: state.grid, gauge: state.gauge, size: state.size,
    filet: state.filet,
  });

  function pushHistory() {
    setState({ history: [...state.history, snapshot()].slice(-HISTORY_LIMIT) });
    el.undoBtn.disabled = false;
  }

  function undo() {
    const last = state.history[state.history.length - 1];
    if (!last) return;
    setState({ ...last, history: state.history.slice(0, -1), selected: null, edited: true });
    if (last.size) {
      el.widthCm.value = last.size.width;
      el.heightCm.value = last.size.height;
    }
    hideError();
    renderAll();
  }

  // ---------------- 범례 ----------------
  function bindLegend() {
    el.mergeBtn.addEventListener('click', () => {
      const to = Number(el.mergeTarget.value);
      if (state.selected == null || Number.isNaN(to)) return;
      pushHistory();
      const merged = mergeColor(state.pattern, state.palette, state.selected, to);
      setState({ ...merged, edited: true, selected: null });
      renderAll();
    });
    el.clearSelect.addEventListener('click', () => selectColor(null));
  }

  function selectColor(index) {
    setState({ selected: state.selected === index ? null : index });
    renderLegend();
    drawChart();
  }

  function renderLegend() {
    const counts = countColors(state.pattern, state.palette.length);
    const total = state.pattern.indices.length;
    el.totalText.textContent = state.filet ? filetTotals(counts) : `(${state.palette.length}색)`;
    el.legend.replaceChildren(...state.palette.map((color, i) => legendItem(color, i, counts[i], total)));

    const sel = state.selected;
    el.mergeBox.hidden = sel == null || state.palette.length < 2;
    if (sel == null) return;
    el.selectedLabel.textContent = `${symbolFor(sel)} 색`;
    el.mergeTarget.replaceChildren(...state.palette
      .map((c, i) => i)
      .filter((i) => i !== sel)
      .map((i) => new Option(`${symbolFor(i)} (${toHex(state.palette[i])})`, String(i))));
  }

  function legendItem(color, i, count, total) {
    const li = document.createElement('li');
    li.classList.toggle('selected', state.selected === i);
    li.title = '눌러서 이 색만 강조 / 칠하기 색으로 선택';

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = toHex(color);
    sw.style.color = textColorFor(color);
    sw.textContent = symbolFor(i);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.innerHTML = `${toHex(color)}<br><small>${count.toLocaleString()}${currentUnit()} · ${((count / total) * 100).toFixed(1)}%</small>`;

    if (state.filet) {
      li.append(sw, meta, fillToggle(color, i));
      li.addEventListener('click', () => selectColor(i));
      return li;
    }

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = toHex(color).toLowerCase();
    picker.title = '색 바꾸기 (가진 실 색에 맞추기)';
    picker.addEventListener('click', (e) => e.stopPropagation());
    picker.addEventListener('change', () => {
      pushHistory();
      const palette = state.palette.map((c, j) => (j === i ? { ...c, ...hexToRgb(picker.value) } : c));
      setState({ palette, edited: true });
      renderAll();
    });

    li.append(sw, meta, picker);
    li.addEventListener('click', () => selectColor(i));
    return li;
  }

  // 방안뜨기: 원래 색마다 채움/비움 바꾸는 버튼
  function fillToggle(color, i) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = color.filled ? 'fill-toggle is-filled' : 'fill-toggle';
    btn.textContent = color.filled ? '■ 채움' : '□ 비움';
    btn.title = '눌러서 채움/비움 바꾸기';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      pushHistory();
      setState({ palette: toggleFill(state.palette, i), edited: true });
      renderAll();
    });
    return btn;
  }

  function filetTotals(counts) {
    const filled = state.palette.reduce((s, c, i) => s + (c.filled ? counts[i] : 0), 0);
    const open = counts.reduce((s, n) => s + n, 0) - filled;
    return `(■ 채움 ${filled}칸 · □ 비움 ${open}칸)`;
  }

  // 단별 순서·저장에 쓸 도안: 방안뜨기면 채움/비움 두 가지로 바꿔서
  const outputPattern = () => (state.filet
    ? toFiletPattern(state.pattern, state.palette)
    : { pattern: state.pattern, palette: state.palette });

  // ---------------- 단별 순서 ----------------
  function renderRows() {
    if (!state.pattern) return;
    const out = outputPattern();
    el.rowsHint.hidden = !state.filet;
    const rows = rowInstructions(out.pattern, { leftHanded: el.leftHanded.checked });
    const fills = out.palette.map(toHex);
    const textColors = out.palette.map(textColorFor);
    const chipLabel = (color) => out.palette[color].name || symbolFor(color);
    const items = rows.map(({ row, direction, runs }) => {
      const li = document.createElement('li');
      li.classList.toggle('done', state.doneRows.has(row));
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.doneRows.has(row);
      box.title = '다 뜬 단 표시';
      box.addEventListener('change', () => {
        const doneRows = new Set(state.doneRows);
        if (box.checked) doneRows.add(row); else doneRows.delete(row);
        setState({ doneRows });
        li.classList.toggle('done', box.checked);
      });
      const label = document.createElement('span');
      label.className = 'rowno';
      label.textContent = `${row}단 ${direction}`;
      li.append(box, label, ...runs.map(({ color, count }) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.background = fills[color];
        chip.style.color = textColors[color];
        chip.textContent = `${chipLabel(color)} ${count}`;
        return chip;
      }));
      return li;
    });
    el.rowList.replaceChildren(...items);
  }

  // ---------------- 저장 / 인쇄 ----------------
  function exportCanvas() {
    const { grid, gauge } = state;
    const { pattern, palette } = outputPattern();
    const unit = currentUnit();
    const hookLabel = el.hook.options[el.hook.selectedIndex].text;
    const stitchLabel = STITCHES[el.stitch.value].label;
    const chainNote = state.filet ? ` · 시작 사슬 ${filetFoundationChains(grid.cols)}코 + 기둥 사슬 3코` : '';
    return Render.renderExport(pattern, palette, countColors(pattern, palette.length), {
      cellAspect: grid.cellAspect,
      unit,
      title: `코바늘 ${state.filet ? '방안뜨기 ' : ''}도안 · ${grid.cols}${unit} × ${grid.rows}단`,
      subtitle: `${hookLabel} · ${stitchLabel} · 게이지 ${gauge.stitchesPer10cm}${unit}×${gauge.rowsPer10cm}단/10cm · 완성 약 ${grid.actualWidthCm}×${grid.actualHeightCm}cm${chainNote} · 오른쪽 아래가 1단 1${unit}`,
    });
  }

  const SAVE_FORMATS = Object.freeze({
    png: { mime: 'image/png', ext: 'png', label: 'PNG', quality: undefined },
    jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG', quality: 0.95 },
  });

  function saveImage() {
    const format = SAVE_FORMATS[el.saveFormat.value] || SAVE_FORMATS.png;
    const filename = `코바늘도안_${state.grid.cols}x${state.grid.rows}.${format.ext}`;
    exportCanvas().toBlob((blob) => {
      if (!blob) return showError(`${format.label} 파일을 만들지 못했어요. 도안 크기를 줄여 다시 시도해 주세요.`);
      if (hostDownloads) return saveViaHost(filename, blob);
      const file = new File([blob], filename, { type: format.mime });
      if (canShareFile(file)) return saveViaShare(file);
      saveViaLink(filename, blob);
    }, format.mime, format.quality);
  }

  // 휴대폰(아이폰 등)에선 공유 시트를 띄워 "이미지 저장"으로 사진 앱에 바로 저장
  function canShareFile(file) {
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return touch && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  }

  async function saveViaShare(file) {
    try {
      await navigator.share({ files: [file], title: file.name });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 사용자가 닫음
      saveViaLink(file.name, file); // 공유가 막힌 경우 일반 다운로드로
    }
  }

  function saveViaLink(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const HOST_SAVE_MESSAGES = Object.freeze({
    declined: null, // 사용자가 취소 → 조용히 넘어감
    rate_limited: '저장 창이 이미 열려 있어요. 잠시 후 다시 눌러 주세요.',
    host_unavailable: '이 앱에서는 파일을 저장할 수 없어요. 브라우저나 컴퓨터에서 열어 저장해 주세요.',
    too_large: '파일이 너무 커요. 도안 크기를 줄여 다시 시도해 주세요.',
  });

  async function saveViaHost(filename, blob) {
    const downloads = await hostDownloads;
    if (!downloads) return showError('이 화면에서는 파일 저장을 쓸 수 없어요. 브라우저에서 열어 저장해 주세요.');
    try {
      await downloads.save({ filename, data: blob });
      hideError();
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') return;
      showError(HOST_SAVE_MESSAGES[code] || '파일을 저장하지 못했어요. 다시 시도해 주세요.');
    }
  }

  function printPattern() {
    el.printImg.onload = () => window.print();
    el.printImg.src = exportCanvas().toDataURL('image/png');
  }

  // ---------------- 알림 ----------------
  // 사이드바 아래쪽은 잘 안 보이므로 도안 위 배너에도 같이 표시
  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
    showBanner(message, true);
  }
  function showNotice(message) {
    showBanner(message, false);
  }
  function showBanner(message, isError) {
    el.banner.textContent = message;
    el.banner.classList.toggle('is-error', isError);
    el.banner.hidden = false;
  }
  function hideError() {
    el.error.hidden = true;
    el.banner.hidden = true;
  }

  init();
})();
