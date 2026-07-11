/**
 * ui/overlay.js
 *
 * Responsabilità:
 * - Definire e disegnare la FINESTRA DI LETTURA FISSA: una piccola area
 *   rettangolare, larga quanto serve per contenere 18 pixel fisici e alta
 *   solo quanto un pixel (proporzione ~18:1), posizionata al centro dello
 *   schermo. Il dispositivo funziona come uno scanner: l'utente allinea
 *   fisicamente la stampa a questa finestra, invece di far cercare la
 *   griglia dall'algoritmo in tutto il fotogramma.
 * - Tutto ciò che è FUORI dalla finestra viene disegnato con una maschera
 *   scura semi-opaca; SOLO l'area della finestra resta nitida/trasparente.
 * - Esporre a GridDetector la corrispondente area in coordinate VIDEO
 *   (getVideoScanWindowRect), così l'analisi CV lavora esclusivamente su
 *   quel ritaglio.
 * - Disegnare i 18 segmenti rilevati dentro la finestra (pieno = match
 *   diretto col blob, tratteggiato = cella interpolata)
 * - Aggiornare l'etichetta di stato testuale
 * - Gestire il resize del canvas al cambio di viewport/orientamento
 *
 * Espone: window.Overlay
 */

(function () {
  'use strict';

  let canvas = null;
  let ctx = null;
  let statusLabelEl = null;

  // --- Finestra di lettura fissa -------------------------------------------
  // Larghezza come frazione della larghezza del canvas; l'altezza è
  // derivata dal rapporto 18:1 (18 pixel fisici in fila, ciascuno quadrato).
  const SCAN_WINDOW_WIDTH_FRACTION = 0.88;
  const DEFAULT_ASPECT_RATIO = 18;

  const MASK_COLOR = 'rgba(16, 14, 12, 0.72)';
  const WINDOW_BORDER_COLOR = 'rgba(226, 163, 95, 0.9)';
  const SEGMENT_MATCHED_COLOR = 'rgba(226, 163, 95, 0.9)';
  const SEGMENT_INTERPOLATED_COLOR = 'rgba(122, 87, 56, 0.8)';
  const PLAYHEAD_COLOR = 'rgba(239, 103, 10, 0.75)'; // arancione UI (#EF670A), pieno ma
                                                      // con leggera trasparenza per lasciar
                                                      // intravedere il pixel che sta suonando

  function init(canvasEl, statusEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    statusLabelEl = statusEl || null;

    resizeCanvasToDisplaySize();
    window.addEventListener('resize', resizeCanvasToDisplaySize);
    window.addEventListener('orientationchange', resizeCanvasToDisplaySize);
  }

  function resizeCanvasToDisplaySize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = Math.round(window.innerWidth * dpr);
    const displayHeight = Math.round(window.innerHeight * dpr);
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }
  }

  function getExpectedAspectRatio() {
    return (window.GridDetector && window.GridDetector.EXPECTED_ROW_ASPECT_RATIO) || DEFAULT_ASPECT_RATIO;
  }

  /**
   * Rettangolo della finestra di lettura in coordinate CANVAS (schermo),
   * centrato, con proporzione 18:1.
   */
  function getScanWindowCanvasRect() {
    if (!canvas) return null;
    const aspect = getExpectedAspectRatio();
    const windowWidth = canvas.width * SCAN_WINDOW_WIDTH_FRACTION;
    const windowHeight = windowWidth / aspect;

    return {
      x: (canvas.width - windowWidth) / 2,
      y: (canvas.height - windowHeight) / 2,
      width: windowWidth,
      height: windowHeight,
    };
  }

  /**
   * Fit "cover" del video nel canvas: scala e offset necessari per disegnare
   * il feed camera a schermo intero senza deformarlo.
   */
  function computeCoverFit(videoWidth, videoHeight) {
    const coverScale = Math.max(canvas.width / videoWidth, canvas.height / videoHeight);
    const drawnWidth = videoWidth * coverScale;
    const drawnHeight = videoHeight * coverScale;
    const offsetX = (canvas.width - drawnWidth) / 2;
    const offsetY = (canvas.height - drawnHeight) / 2;
    return { coverScale, offsetX, offsetY };
  }

  /**
   * Rettangolo della finestra di lettura in coordinate VIDEO (sorgente):
   * è l'inverso del fit "cover" applicato al rettangolo-finestra in
   * coordinate canvas. Usato da GridDetector per ritagliare dal video
   * SOLO il contenuto della finestra visibile.
   */
  function getVideoScanWindowRect(videoWidth, videoHeight) {
    if (!canvas || !videoWidth || !videoHeight) return null;

    const { coverScale, offsetX, offsetY } = computeCoverFit(videoWidth, videoHeight);
    const windowRect = getScanWindowCanvasRect();
    if (!windowRect) return null;

    return {
      x: (windowRect.x - offsetX) / coverScale,
      y: (windowRect.y - offsetY) / coverScale,
      width: windowRect.width / coverScale,
      height: windowRect.height / coverScale,
    };
  }

  /**
   * Converte un punto nello spazio di analisi di GridDetector (il piccolo
   * ritaglio a bassa risoluzione) direttamente nello spazio della finestra
   * visibile sul canvas: essendo l'analisi già un ritaglio 1:1 proporzionale
   * della finestra, la mappatura è una semplice proporzione, senza bisogno
   * di passare per lo spazio video.
   */
  function analysisPointToWindowCanvas(ax, ay, analysisWidth, analysisHeight, windowRect) {
    return {
      x: windowRect.x + (ax / analysisWidth) * windowRect.width,
      y: windowRect.y + (ay / analysisHeight) * windowRect.height,
    };
  }

  function drawSegments(pixelDetectorResult, analysisWidth, analysisHeight, windowRect) {
    if (!pixelDetectorResult) return;

    for (const cell of pixelDetectorResult.cells) {
      const p0 = analysisPointToWindowCanvas(cell.left, cell.top, analysisWidth, analysisHeight, windowRect);
      const p1 = analysisPointToWindowCanvas(cell.right, cell.bottom, analysisWidth, analysisHeight, windowRect);
      const w = p1.x - p0.x;
      const h = p1.y - p0.y;

      ctx.strokeStyle = cell.hasDirectBlobMatch ? SEGMENT_MATCHED_COLOR : SEGMENT_INTERPOLATED_COLOR;
      ctx.lineWidth = cell.hasDirectBlobMatch ? 2 : 1;
      ctx.setLineDash(cell.hasDirectBlobMatch ? [] : [4, 3]);
      ctx.strokeRect(p0.x, p0.y, w, h);
    }
    ctx.setLineDash([]);
  }

  /**
   * DIAGNOSTICA: disegna un pallino su ogni blob rilevato dentro la finestra,
   * indipendentemente dal fatto che formino una riga valida. Serve durante
   * la taratura per vedere esattamente cosa la pipeline sta trovando (o non
   * trovando) frame per frame.
   */
  function drawDetectedBlobs(blobs, analysisWidth, analysisHeight, windowRect) {
    if (!blobs || blobs.length === 0) return;

    ctx.fillStyle = 'rgba(239, 103, 10, 0.85)';
    for (const b of blobs) {
      const p = analysisPointToWindowCanvas(b.centerX, b.centerY, analysisWidth, analysisHeight, windowRect);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, canvas.width * 0.004), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * PLAYHEAD del sequencer: riempie di arancione pieno la cella dello step
   * attualmente in riproduzione. Si muove sui 18 step a tempo (clock audio),
   * si accende quando la lettura è attiva e si spegne quando finisce —
   * esattamente come il cursore di uno step sequencer.
   */
  function drawPlayhead(stepIndex, windowRect) {
    if (stepIndex == null || stepIndex < 0) return;

    const cellWidth = windowRect.width / 18;
    const x = windowRect.x + stepIndex * cellWidth;

    ctx.fillStyle = PLAYHEAD_COLOR;
    ctx.fillRect(x, windowRect.y, cellWidth, windowRect.height);
  }

  function updateStatusLabel(text) {
    if (!statusLabelEl) return;
    statusLabelEl.textContent = text;
    // Con testo vuoto la pillola sparisce del tutto (non un contenitore vuoto).
    statusLabelEl.style.display = text ? '' : 'none';
  }

  /**
   * Disegna un frame completo di overlay.
   * `frame`: { videoEl, gridResult, pixelDetectorResult }
   */
  function render(frame) {
    if (!canvas || !ctx) return;
    const { videoEl, gridResult, pixelDetectorResult } = frame;

    if (!videoEl.videoWidth || !videoEl.videoHeight) return;

    const { coverScale, offsetX, offsetY } = computeCoverFit(videoEl.videoWidth, videoEl.videoHeight);
    const windowRect = getScanWindowCanvasRect();
    if (!windowRect) return;

    // 1. Feed camera intero, cover-fit su tutto lo schermo.
    const drawnWidth = videoEl.videoWidth * coverScale;
    const drawnHeight = videoEl.videoHeight * coverScale;
    ctx.drawImage(videoEl, offsetX, offsetY, drawnWidth, drawnHeight);

    // 2. Maschera scura su tutto lo schermo.
    ctx.fillStyle = MASK_COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 3. "Ritaglio" trasparente: ridisegna il contenuto video SOLO nella
    // finestra di lettura, che risulta quindi nitida mentre il resto resta
    // coperto dalla maschera — esattamente ciò che il dispositivo legge.
    const videoWindowRect = getVideoScanWindowRect(videoEl.videoWidth, videoEl.videoHeight);
    if (videoWindowRect && videoWindowRect.width > 0 && videoWindowRect.height > 0) {
      ctx.drawImage(
        videoEl,
        videoWindowRect.x, videoWindowRect.y, videoWindowRect.width, videoWindowRect.height,
        windowRect.x, windowRect.y, windowRect.width, windowRect.height
      );
    }

    // 4. Bordo della finestra.
    ctx.strokeStyle = WINDOW_BORDER_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(windowRect.x, windowRect.y, windowRect.width, windowRect.height);

    // 5. Segmenti e pallini di rilevamento: SOLO quando agganciato
    // (frame.showDetection). In stato di ricerca la finestra resta pulita,
    // senza indicatori che suggerirebbero falsamente una lettura in corso.
    if (frame.showDetection && gridResult && gridResult.analysisWidth && gridResult.analysisHeight) {
      drawSegments(pixelDetectorResult, gridResult.analysisWidth, gridResult.analysisHeight, windowRect);
      drawDetectedBlobs(gridResult.allBlobs, gridResult.analysisWidth, gridResult.analysisHeight, windowRect);
    }

    // 6. Playhead del sequencer: la cella che sta suonando ORA, piena in
    // arancione, sopra tutto il resto. frame.playheadStep è -1/null quando
    // la lettura non è attiva: il cursore si accende e spegne con essa.
    drawPlayhead(frame.playheadStep, windowRect);
  }

  window.Overlay = {
    init,
    render,
    updateStatusLabel,
    getVideoScanWindowRect,
    getScanWindowCanvasRect,
  };
})();
