/**
 * vision/gridDetector.js
 *
 * MODELLO: CAMPIONAMENTO DIRETTO PER CELLA (v3)
 *
 * Perché non più blob detection: nella stampa reale i pixel colorati
 * ADIACENTI si fondono in forme continue (run di 2-4 celle, forme "tetris"
 * anche tra righe diverse), senza bianco in mezzo. Un rilevatore a
 * componenti connesse vede quelle forme come un unico blob di dimensioni
 * "sbagliate" e le scarta o le confonde. Verificato sui file reali:
 * pixel logici ~33px, run osservati da 66/100/133px (2-4 celle fuse).
 *
 * Il modello corretto sfrutta ciò che è già noto e fisso:
 * - la finestra di lettura contiene esattamente 18 celle (pitch = W/18)
 * - per OGNI cella si campiona la sua zona centrale (inset per evitare i
 *   bordi tra celle) e si decide: bianco (carta/luce) o colorato (ombra)
 * - il bianco di riferimento è stimato dal frame stesso (percentile alto
 *   delle celle più chiare), quindi robusto a luce calda o carta non
 *   perfettamente bianca
 *
 * Vantaggi diretti sui sintomi osservati:
 * - pixel adiacenti fusi: irrilevante, ogni cella si legge da sola
 * - righe adiacenti fuse verticalmente: la finestra è alta ~1 cella e
 *   ogni cella campiona solo il proprio centro
 * - capelli/muro: la classificazione richiede carta bianca come contesto
 *   (whiteFraction) e colori pieni uniformi nelle celle occupate
 *
 * Output compatibile con la pipeline esistente: le celle occupate vengono
 * esposte come "blob sintetici" centrati sulle celle, così RowTracker,
 * PixelDetector, ColorExtractor e PixelSampler continuano a funzionare
 * senza modifiche.
 *
 * Espone: window.GridDetector
 */

(function () {
  'use strict';

  const EXPECTED_PIXEL_COUNT = 18;
  const EXPECTED_ROW_ASPECT_RATIO = EXPECTED_PIXEL_COUNT;

  // Risoluzione di analisi del ritaglio-finestra.
  const ANALYSIS_WIDTH = 360;
  const ANALYSIS_HEIGHT = Math.max(4, Math.round(ANALYSIS_WIDTH / EXPECTED_ROW_ASPECT_RATIO));

  // Frazione della cella esclusa dal campionamento su ciascun lato:
  // evita i bordi tra celle (antialiasing, contorni) e resta nel "pieno".
  const CELL_INSET_RATIO = 0.28;

  // Classificazione bianco/colorato per cella, relativa alla carta:
  // una cella è COLORATA se la sua luminosità scende sotto questa frazione
  // del bianco di riferimento, oppure se la sua saturazione supera la
  // soglia (gestisce colori chiari ma saturi).
  const COLORED_VALUE_RATIO = 0.82;
  const COLORED_SATURATION_MIN = 0.18;

  // Il bianco di riferimento è il percentile alto delle luminosità di cella:
  // in una riga tipica la maggioranza delle celle è carta bianca.
  const WHITE_REFERENCE_PERCENTILE = 0.85;

  // Smoothing confidenza
  const CONFIDENCE_EMA_ALPHA = 0.25;

  // --- Stato interno --------------------------------------------------------

  let analysisCanvas = null;
  let analysisCtx = null;
  let smoothedConfidence = 0;

  function ensureAnalysisCanvas() {
    if (analysisCanvas) return;
    analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = ANALYSIS_WIDTH;
    analysisCanvas.height = ANALYSIS_HEIGHT;
    analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });
  }

  // --- Campionamento per cella ----------------------------------------------

  /**
   * Campiona la zona centrale di ogni cella: media RGB, luminosità (value,
   * max canale 0..1) e saturazione. Ritorna un array di 18 campioni.
   */
  function sampleCells(imageData, width, height) {
    const data = imageData.data;
    const pitch = width / EXPECTED_PIXEL_COUNT;
    const insetX = pitch * CELL_INSET_RATIO;
    const insetY = height * CELL_INSET_RATIO;

    const cells = [];

    for (let c = 0; c < EXPECTED_PIXEL_COUNT; c++) {
      const x0 = Math.max(0, Math.round(c * pitch + insetX));
      const x1 = Math.min(width - 1, Math.round((c + 1) * pitch - insetX));
      const y0 = Math.max(0, Math.round(insetY));
      const y1 = Math.min(height - 1, Math.round(height - insetY));

      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const idx = (y * width + x) * 4;
          sumR += data[idx];
          sumG += data[idx + 1];
          sumB += data[idx + 2];
          count++;
        }
      }

      const r = count ? sumR / count : 255;
      const g = count ? sumG / count : 255;
      const b = count ? sumB / count : 255;

      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const value = max;
      const saturation = max === 0 ? 0 : (max - min) / max;

      cells.push({
        index: c,
        centerX: (c + 0.5) * pitch,
        meanColor: { r: Math.round(r), g: Math.round(g), b: Math.round(b) },
        value,
        saturation,
      });
    }

    return cells;
  }

  /**
   * Bianco di riferimento: percentile alto delle luminosità di cella.
   * In una riga tipica la maggioranza delle celle è carta; il percentile
   * evita che un riflesso isolato o una cella colorata distorcano la stima.
   */
  function estimateWhiteReference(cells) {
    const values = cells.map((c) => c.value).sort((a, b) => a - b);
    const idx = Math.min(values.length - 1, Math.floor(values.length * WHITE_REFERENCE_PERCENTILE));
    return values[idx];
  }

  /**
   * Classifica ogni cella come colorata (ombra) o bianca (luce), e calcola
   * per ciascuna una misura di contrasto 0..1 (quanto nettamente si stacca
   * dalla carta) usata a valle come confidenza per-cella.
   */
  function classifyCells(cells, whiteRef) {
    return cells.map((cell) => {
      const relativeValue = whiteRef > 0 ? cell.value / whiteRef : 1;
      const byDarkness = relativeValue < COLORED_VALUE_RATIO;
      const bySaturation = cell.saturation > COLORED_SATURATION_MIN;
      const isColored = byDarkness || bySaturation;

      // Contrasto: quanto la cella si allontana dalla soglia, normalizzato.
      const darknessContrast = Math.max(0, (COLORED_VALUE_RATIO - relativeValue) / COLORED_VALUE_RATIO);
      const saturationContrast = Math.max(0, (cell.saturation - COLORED_SATURATION_MIN) / (1 - COLORED_SATURATION_MIN));
      const contrast = Math.min(1, Math.max(darknessContrast * 2.2, saturationContrast * 1.6));

      return {
        ...cell,
        isColored,
        contrast: isColored ? Math.max(0.3, contrast) : 0,
      };
    });
  }

  // --- Confidenza -------------------------------------------------------------

  /**
   * La confidenza risponde a: "quello che vedo nella finestra è plausibilmente
   * una riga della stampa?" Criteri:
   * - il bianco di riferimento deve essere davvero chiaro (siamo su carta,
   *   non su un muro grigio o capelli)
   * - le celle bianche devono essere OMOGENEE tra loro (la carta è uniforme;
   *   una scena qualunque no)
   * - le celle colorate, se presenti, devono avere contrasto netto
   */
  function computeConfidence(classified, whiteRef) {
    const whiteCells = classified.filter((c) => !c.isColored);
    const coloredCells = classified.filter((c) => c.isColored);

    // 1) La carta deve essere chiara in assoluto (0.55 = molto permissivo
    //    per interni; un muro grigio scuro o capelli non arrivano qui).
    const brightnessScore = Math.min(1, Math.max(0, (whiteRef - 0.45) / 0.3));

    // 2) Omogeneità delle celle bianche: deviazione standard bassa.
    let uniformityScore = 0;
    if (whiteCells.length >= 3) {
      const mean = whiteCells.reduce((s, c) => s + c.value, 0) / whiteCells.length;
      const variance = whiteCells.reduce((s, c) => s + (c.value - mean) ** 2, 0) / whiteCells.length;
      const std = Math.sqrt(variance);
      uniformityScore = Math.max(0, 1 - std / 0.12);
    }

    // 3) Contrasto medio delle celle colorate (se ce ne sono).
    const contrastScore = coloredCells.length > 0
      ? coloredCells.reduce((s, c) => s + c.contrast, 0) / coloredCells.length
      : 0.6; // riga vuota: neutrale, decidono carta+omogeneità

    return 0.4 * brightnessScore + 0.35 * uniformityScore + 0.25 * contrastScore;
  }

  // --- API pubblica ------------------------------------------------------------

  function analyzeFrame(videoEl) {
    const videoWidth = videoEl.videoWidth;
    const videoHeight = videoEl.videoHeight;

    if (!videoWidth || !videoHeight) return emptyResult();
    if (!window.Overlay || typeof window.Overlay.getVideoScanWindowRect !== 'function') {
      return emptyResult();
    }

    const windowRect = window.Overlay.getVideoScanWindowRect(videoWidth, videoHeight);
    if (!windowRect || windowRect.width <= 0 || windowRect.height <= 0) return emptyResult();

    ensureAnalysisCanvas();

    analysisCtx.drawImage(
      videoEl,
      windowRect.x, windowRect.y, windowRect.width, windowRect.height,
      0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT
    );
    const imageData = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);

    const result = analyzeImageData(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);

    smoothedConfidence =
      smoothedConfidence * (1 - CONFIDENCE_EMA_ALPHA) + result.rawConfidence * CONFIDENCE_EMA_ALPHA;

    return {
      timestamp: performance.now(),
      analysisWidth: ANALYSIS_WIDTH,
      analysisHeight: ANALYSIS_HEIGHT,
      imageData,
      allBlobs: result.syntheticBlobs,
      cellStates: result.classified, // diagnostica/overlay: stato per cella
      whiteReference: result.whiteRef,
      bestRowBand: result.bestRowBand,
      rawConfidence: result.rawConfidence,
      smoothedConfidence,
    };
  }

  /**
   * Nucleo dell'analisi, separato da analyzeFrame per essere testabile
   * anche fuori dal browser (Node) su dati immagine sintetici o reali.
   */
  function analyzeImageData(imageData, width, height) {
    const cells = sampleCells(imageData, width, height);
    const whiteRef = estimateWhiteReference(cells);
    const classified = classifyCells(cells, whiteRef);
    const rawConfidence = computeConfidence(classified, whiteRef);

    // Blob sintetici per compatibilità con la pipeline a valle: una cella
    // colorata = un blob centrato sulla cella, grande quanto la cella.
    const pitch = width / EXPECTED_PIXEL_COUNT;
    const syntheticBlobs = classified
      .filter((c) => c.isColored)
      .map((c) => ({
        x: c.centerX - pitch / 2,
        y: 0,
        width: pitch,
        height: height,
        area: pitch * height,
        centerX: c.centerX,
        centerY: height / 2,
        meanColor: c.meanColor,
        contrast: c.contrast,
      }));

    const bestRowBand = {
      blobs: syntheticBlobs,
      score: rawConfidence,
      yTop: 0,
      yBottom: height,
      yCenter: height / 2,
      occupiedCount: syntheticBlobs.length,
    };

    return { cells, whiteRef, classified, rawConfidence, syntheticBlobs, bestRowBand };
  }

  function emptyResult() {
    return {
      timestamp: performance.now(),
      analysisWidth: ANALYSIS_WIDTH,
      analysisHeight: ANALYSIS_HEIGHT,
      imageData: null,
      allBlobs: [],
      cellStates: null,
      whiteReference: 0,
      bestRowBand: null,
      rawConfidence: 0,
      smoothedConfidence,
    };
  }

  function reset() {
    smoothedConfidence = 0;
  }

  window.GridDetector = {
    analyzeFrame,
    analyzeImageData, // esposto per testabilità
    reset,
    EXPECTED_PIXEL_COUNT,
    EXPECTED_ROW_ASPECT_RATIO,
  };
})();
