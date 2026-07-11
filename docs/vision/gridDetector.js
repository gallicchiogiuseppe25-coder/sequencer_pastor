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

  // Uniformità della PARTE SCURA della cella: perché una cella conti come
  // pixel STAMPATO, i suoi pixel scuri devono essere un colore piatto
  // (deviazione standard bassa TRA I SOLI PIXEL SCURI). Questo distingue:
  // - cella piena di stampa: pixel scuri tutti uguali -> valida
  // - cella di BORDO (mezzo pixel, mezzo bianco): la parte scura è comunque
  //   stampa solida e uniforme -> valida (non viene persa!)
  // - texture caotica (legno, tessuto, oggetti): pixel scuri che variano
  //   selvaggiamente -> clutter, mai suono
  const DARK_REGION_MAX_STD = 0.075;
  const DARK_FRACTION_MIN = 0.3; // sotto questa frazione di pixel scuri la cella è bianca

  // Gate assoluto sulla carta: sotto questa luminosità del bianco di
  // riferimento la scena non è la stampa (esclude muri grigi, superfici
  // scure). La carta reale, anche in luce calda da interni, resta sopra.
  const PAPER_MIN_WHITE_REF = 0.58;

  // STRATEGIA B — contesto verticale: frazione minima di bianco richiesta
  // in ALMENO UNA delle due bande sopra/sotto la finestra. Le righe adiacenti
  // della stampa sono sparse (prevalentemente carta); un oggetto solido più
  // alto di una riga riempie di scuro entrambe le bande e viene rifiutato.
  const CONTEXT_MIN_WHITE_FRACTION = 0.45;

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
    analysisCanvas.height = ANALYSIS_HEIGHT * 3; // contesto sopra + riga + contesto sotto
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
      let sumVal = 0, sumValSq = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const idx = (y * width + x) * 4;
          const pr = data[idx], pg = data[idx + 1], pb = data[idx + 2];
          sumR += pr;
          sumG += pg;
          sumB += pb;
          const pv = Math.max(pr, pg, pb) / 255;
          sumVal += pv;
          sumValSq += pv * pv;
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

      // Uniformità interna: deviazione standard della luminosità DENTRO la
      // cella. Un pixel stampato è un colore pieno e uniforme (std bassa);
      // mani, oggetti, bordi e texture producono variazione interna alta.
      const meanVal = count ? sumVal / count : 1;
      const variance = count ? Math.max(0, sumValSq / count - meanVal * meanVal) : 0;
      const innerStd = Math.sqrt(variance);

      cells.push({
        index: c,
        centerX: (c + 0.5) * pitch,
        meanColor: { r: Math.round(r), g: Math.round(g), b: Math.round(b) },
        value,
        saturation,
        innerStd,
        bounds: { x0, x1, y0, y1 }, // per il secondo passaggio (analisi zona scura)
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
   * Secondo passaggio su una cella: statistiche dei pixel scuri.
   * La deviazione standard è calcolata solo sul NUCLEO della zona scura —
   * i valori vicini al minimo della cella — escludendo la banda di
   * transizione verso il bianco creata dalla sfocatura (fuoco imperfetto,
   * motion blur): in una cella di bordo sfocata la transizione gonfierebbe
   * la std facendo scartare un pixel legittimo. Le texture caotiche invece
   * hanno valori che spaziano OVUNQUE anche dentro il nucleo, quindi
   * restano rilevabili come clutter.
   */
  function analyzeDarkRegion(imageData, cell, whiteRef) {
    const data = imageData.data;
    const width = ANALYSIS_WIDTH;
    const darkThreshold = whiteRef * COLORED_VALUE_RATIO;
    const { x0, x1, y0, y1 } = cell.bounds;

    // Passo 1: raccoglie i valori scuri e trova il minimo.
    const darkValues = [];
    let total = 0;
    let minDark = 1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const idx = (y * width + x) * 4;
        const v = Math.max(data[idx], data[idx + 1], data[idx + 2]) / 255;
        total++;
        if (v < darkThreshold) {
          darkValues.push(v);
          if (v < minDark) minDark = v;
        }
      }
    }

    const darkFraction = total ? darkValues.length / total : 0;
    if (darkValues.length <= 1) return { darkFraction, darkStd: 0 };

    // Passo 2: std solo sul nucleo — valori entro il 60% della distanza
    // tra il minimo della cella e la soglia (esclude la coda di transizione).
    const coreCeiling = minDark + 0.6 * (darkThreshold - minDark);
    let sum = 0, sumSq = 0, count = 0;
    for (const v of darkValues) {
      if (v <= coreCeiling) {
        sum += v;
        sumSq += v * v;
        count++;
      }
    }

    let darkStd = 0;
    if (count > 1) {
      const mean = sum / count;
      darkStd = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    }
    return { darkFraction, darkStd };
  }

  /**
   * Classifica ogni cella in TRE stati:
   * - bianca (carta/luce)
   * - colorata (pixel stampato: abbastanza pixel scuri, e la parte scura è
   *   un colore PIATTO — anche le celle di bordo mezzo-piene restano valide,
   *   perché la loro parte scura è comunque stampa solida)
   * - clutter (zona scura presente ma internamente caotica: mani, oggetti,
   *   texture — tutto ciò che non è un colore pieno di stampa). Mai suono,
   *   e pesa negativamente sulla confidenza.
   */
  function classifyCells(cells, whiteRef, imageData) {
    return cells.map((cell) => {
      const relativeValue = whiteRef > 0 ? cell.value / whiteRef : 1;
      const byDarkness = relativeValue < COLORED_VALUE_RATIO;
      const bySaturation = cell.saturation > COLORED_SATURATION_MIN;
      const looksNonWhite = byDarkness || bySaturation;

      let isColored = false;
      let isClutter = false;

      if (looksNonWhite) {
        const { darkFraction, darkStd } = analyzeDarkRegion(imageData, cell, whiteRef);
        const darkPartIsSolid = darkStd <= DARK_REGION_MAX_STD;
        const enoughDark = darkFraction >= DARK_FRACTION_MIN;
        isColored = enoughDark && darkPartIsSolid;
        isClutter = !isColored;
      }

      // Contrasto: quanto la cella si allontana dalla soglia, normalizzato.
      const darknessContrast = Math.max(0, (COLORED_VALUE_RATIO - relativeValue) / COLORED_VALUE_RATIO);
      const saturationContrast = Math.max(0, (cell.saturation - COLORED_SATURATION_MIN) / (1 - COLORED_SATURATION_MIN));
      const contrast = Math.min(1, Math.max(darknessContrast * 2.2, saturationContrast * 1.6));

      return {
        ...cell,
        isColored,
        isClutter,
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
    const whiteCells = classified.filter((c) => !c.isColored && !c.isClutter);
    const coloredCells = classified.filter((c) => c.isColored);
    const clutterCells = classified.filter((c) => c.isClutter);

    // GATE DURI — condizioni SENZA le quali la scena non può essere la
    // stampa, indipendentemente da tutto il resto:
    // a) la carta deve esistere ed essere chiara in senso assoluto
    if (whiteRef < PAPER_MIN_WHITE_REF) return 0;
    // b) il contesto della stampa è la carta bianca: se meno di 4 celle su
    //    18 sono bianche, la finestra sta inquadrando qualcos'altro (mano,
    //    tavolo, sfondo). Nessuna riga reale è quasi tutta piena.
    if (whiteCells.length < 4) return 0;

    // 1) Chiarezza della carta.
    const brightnessScore = Math.min(1, Math.max(0, (whiteRef - 0.45) / 0.3));

    // 2) Omogeneità delle celle bianche tra loro: la carta è uniforme,
    //    una scena qualunque no.
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

    let score = 0.4 * brightnessScore + 0.35 * uniformityScore + 0.25 * contrastScore;

    // PENALITÀ CLUTTER: celle scure ma internamente disordinate (mani,
    // oggetti, bordi) sono la firma di una scena che non è la stampa.
    // Ogni cella clutter riduce la confidenza; da 4 in su la azzera quasi.
    score *= Math.max(0, 1 - clutterCells.length / 4);

    return score;
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

    // --- Ritaglio ESPANSO: finestra + una banda di contesto sopra e una
    // sotto, ciascuna alta quanto la finestra stessa (STRATEGIA B).
    // La riga vera vive dentro la carta: sopra e sotto c'è quasi sempre
    // bianco (o pixel sparsi di altre righe). Un oggetto solido "spesso"
    // (ciabatta, laptop, scatola) riempie anche le bande di contesto:
    // è la firma che lo smaschera, indipendentemente dal suo colore —
    // funziona anche con oggetti neri/grigi, che a livello di cella
    // sarebbero indistinguibili da un pixel stampato scuro.
    // Il canvas viene prima riempito di bianco: se la banda esce dal frame
    // video (bordo dell'inquadratura) resta bianca = permissivo.
    analysisCtx.fillStyle = '#ffffff';
    analysisCtx.fillRect(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT * 3);

    const srcYDesired = windowRect.y - windowRect.height;
    const srcHDesired = windowRect.height * 3;
    // Clamp del rettangolo sorgente dentro il video, con mappatura
    // proporzionale sulla destinazione (evita distorsioni ai bordi).
    const srcY0 = Math.max(0, srcYDesired);
    const srcY1 = Math.min(videoHeight, srcYDesired + srcHDesired);
    if (srcY1 > srcY0) {
      const destY = ((srcY0 - srcYDesired) / srcHDesired) * ANALYSIS_HEIGHT * 3;
      const destH = ((srcY1 - srcY0) / srcHDesired) * ANALYSIS_HEIGHT * 3;
      analysisCtx.drawImage(
        videoEl,
        windowRect.x, srcY0, windowRect.width, srcY1 - srcY0,
        0, destY, ANALYSIS_WIDTH, destH
      );
    }

    // Tre bande: sopra (contesto), centro (la riga da leggere), sotto (contesto).
    const topBand = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    const imageData = analysisCtx.getImageData(0, ANALYSIS_HEIGHT, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    const bottomBand = analysisCtx.getImageData(0, ANALYSIS_HEIGHT * 2, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);

    const result = analyzeImageData(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);

    // GATE DI CONTESTO (strategia B): almeno una delle due bande deve essere
    // prevalentemente bianca rispetto alla stessa carta di riferimento della
    // riga. "Almeno una" e non entrambe: scansionando la prima/ultima riga
    // della fascia, da un lato potrebbe esserci il tavolo — ma mai da
    // entrambi i lati contemporaneamente, mentre un oggetto solido è scuro
    // da entrambi i lati.
    let rawConfidence = result.rawConfidence;
    if (rawConfidence > 0 && result.whiteRef > 0) {
      const topWhite = bandWhiteFraction(topBand, result.whiteRef);
      const bottomWhite = bandWhiteFraction(bottomBand, result.whiteRef);
      if (Math.max(topWhite, bottomWhite) < CONTEXT_MIN_WHITE_FRACTION) {
        rawConfidence = 0;
      }
    }

    smoothedConfidence =
      smoothedConfidence * (1 - CONFIDENCE_EMA_ALPHA) + rawConfidence * CONFIDENCE_EMA_ALPHA;

    return {
      timestamp: performance.now(),
      analysisWidth: ANALYSIS_WIDTH,
      analysisHeight: ANALYSIS_HEIGHT,
      imageData,
      allBlobs: result.syntheticBlobs,
      cellStates: result.classified, // diagnostica/overlay: stato per cella
      whiteReference: result.whiteRef,
      bestRowBand: result.bestRowBand,
      rawConfidence,
      smoothedConfidence,
    };
  }

  /**
   * Frazione di pixel "bianchi" (relativi alla carta di riferimento) in una
   * banda di contesto. Pura e testabile in Node.
   */
  function bandWhiteFraction(bandImageData, whiteRef) {
    const data = bandImageData.data;
    const threshold = whiteRef * COLORED_VALUE_RATIO;
    let white = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
      total++;
      if (v >= threshold) white++;
    }
    return total ? white / total : 1;
  }

  /**
   * Nucleo dell'analisi, separato da analyzeFrame per essere testabile
   * anche fuori dal browser (Node) su dati immagine sintetici o reali.
   */
  function analyzeImageData(imageData, width, height) {
    const cells = sampleCells(imageData, width, height);
    const whiteRef = estimateWhiteReference(cells);
    const classified = classifyCells(cells, whiteRef, imageData);
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
