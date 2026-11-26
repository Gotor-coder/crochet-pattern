/* 화면 연결: 입력 → 도안 생성 → 그리기 / 범례 / 단별 순서 / 저장 */
(function () {
  'use strict';

  const { HOOKS, STITCHES, estimateGauge, computeGrid } = window.Gauge;
  const { averageCells, quantize, toHex, hexToRgb, textColorFor } = window.Quantize;
  const { symbolFor, rowInstructions, countColors, paintCell, mergeColor } = window.Pattern;
  const Render = window.Render;

  const DEFAULT_HOOK_MM = 4.0;
  const SAMPLE_PER_CELL = 8; // 칸 하나 당 원본에서 읽을 픽셀 수(한 변)
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
    'mergeBtn', 'clearSelect', 'legend', 'printImg', 'banner', 'saveFormat',
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
      el.gaugeText.textContent = `${g.stitchesPer10cm}코 × ${g.rowsPer10cm}단`;
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
      const cells = sampleCells(state.image, grid, hexToRgb(el.bgColor.value));
      const { palette, indices } = quantize(cells, Number(el.colorCount.value));
      const keepEdits = !fresh && state.edited && state.pattern;
      setState({
        gauge, grid, palette, pattern: { cols: grid.cols, rows: grid.rows, indices },
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

  function sampleCells(img, grid, background) {
    const sw = Math.max(grid.cols, Math.min(img.naturalWidth, grid.cols * SAMPLE_PER_CELL));
    const sh = Math.max(grid.rows, Math.min(img.naturalHeight, grid.rows * SAMPLE_PER_CELL));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, sw, sh);
    const { data } = ctx.getImageData(0, 0, sw, sh);
    return averageCells(data, sw, sh, grid.cols, grid.rows, background);
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
    el.summary.innerHTML =
      `도안: 가로 <b>${grid.cols}코</b> × 세로 <b>${grid.rows}단</b><br>` +
      `완성 예상 크기: 약 ${grid.actualWidthCm} × ${grid.actualHeightCm} cm<br>` +
      `총 ${(pattern.cols * pattern.rows).toLocaleString()}코 · ${palette.length}가지 색<br>` +
      `<small>게이지 ${gauge.stitchesPer10cm}코 × ${gauge.rowsPer10cm}단 / 10cm ` +
      `${custom ? '(직접 입력)' : '(호수 기준 추정 — 실 굵기·손땀에 따라 달라요)'}</small>`;
  }

  function drawChart() {
    if (!state.pattern) return;
    const cellW = Number(el.zoom.value);
    const cellH = cellW * state.grid.cellAspect;
    const maxSide = Math.max(state.pattern.cols * cellW, state.pattern.rows * cellH) + 80;
    const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_CANVAS_SIDE / maxSide));
    const layout = Render.drawPattern(el.chart, state.pattern, state.palette, {
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
    Render.drawPattern(el.previewCanvas, state.pattern, state.palette, {
      cellW: 4, cellAspect: state.grid.cellAspect, showSymbols: false, showGrid: false, showNumbers: false,
    });
  }

  // ---------------- 칠하기 ----------------
  function bindChart() {
    let drawing = false;
    const paintAt = (e) => {
      const cell = Render.cellAt(el.chart, state.layout, e.clientX, e.clientY);
      if (!cell) return;
      const next = paintCell(state.pattern, cell.x, cell.y, state.selected);
      if (next !== state.pattern) {
        setState({ pattern: next, edited: true });
        drawChart();
      }
    };
    el.chart.addEventListener('pointerdown', (e) => {
      if (!el.paintMode.checked || !state.pattern) return;
      if (state.selected == null) return showError('칠할 색을 아래 "사용 색상"에서 먼저 골라 주세요.');
      hideError();
      pushHistory();
      drawing = true;
      el.chart.setPointerCapture(e.pointerId);
      paintAt(e);
    });
    el.chart.addEventListener('pointermove', (e) => { if (drawing) paintAt(e); });
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
    el.totalText.textContent = `(${state.palette.length}색)`;
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
    meta.innerHTML = `${toHex(color)}<br><small>${count.toLocaleString()}코 · ${((count / total) * 100).toFixed(1)}%</small>`;

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = toHex(color).toLowerCase();
    picker.title = '색 바꾸기 (가진 실 색에 맞추기)';
    picker.addEventListener('click', (e) => e.stopPropagation());
    picker.addEventListener('change', () => {
      pushHistory();
      const palette = state.palette.map((c, j) => (j === i ? { ...hexToRgb(picker.value), count: c.count } : c));
      setState({ palette, edited: true });
      renderAll();
    });

    li.append(sw, meta, picker);
    li.addEventListener('click', () => selectColor(i));
    return li;
  }

  // ---------------- 단별 순서 ----------------
  function renderRows() {
    if (!state.pattern) return;
    const rows = rowInstructions(state.pattern, { leftHanded: el.leftHanded.checked });
    const fills = state.palette.map(toHex);
    const textColors = state.palette.map(textColorFor);
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
        chip.textContent = `${symbolFor(color)} ${count}`;
        return chip;
      }));
      return li;
    });
    el.rowList.replaceChildren(...items);
  }

  // ---------------- 저장 / 인쇄 ----------------
  function exportCanvas() {
    const { grid, gauge, pattern, palette } = state;
    const hookLabel = el.hook.options[el.hook.selectedIndex].text;
    const stitchLabel = STITCHES[el.stitch.value].label;
    return Render.renderExport(pattern, palette, countColors(pattern, palette.length), {
      cellAspect: grid.cellAspect,
      title: `코바늘 도안 · ${grid.cols}코 × ${grid.rows}단`,
      subtitle: `${hookLabel} · ${stitchLabel} · 게이지 ${gauge.stitchesPer10cm}코×${gauge.rowsPer10cm}단/10cm · 완성 약 ${grid.actualWidthCm}×${grid.actualHeightCm}cm · 오른쪽 아래가 1단 1코`,
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
