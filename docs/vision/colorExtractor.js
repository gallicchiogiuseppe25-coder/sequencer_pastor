/**
 * vision/colorExtractor.js
 *
 * Responsabilità:
 * - Campionare, per ciascuna delle 18 celle geometriche prodotte da
 *   PixelDetector, il colore medio direttamente dai dati grezzi del frame
 *   (lo stesso imageData già catturato da GridDetector, per coerenza di
 *   coordinate e per evitare una seconda cattura costosa)
 * - Campionare solo la porzione centrale di ciascuna cella (inset), per
 *   evitare di includere il bordo bianco di fondo o l'antialiasing tra
 *   un pixel fisico e l'altro nella media
 * - Funzionare correttamente anche per celle "interpolate" senza un blob
 *   direttamente rilevato: si campiona comunque l'area attesa, perché la
 *   posizione geometrica resta nota anche se la detection del blob è fallita
 *
 * Espone: window.ColorExtractor
 */

(function () {
  'use strict';

  // Frazione di larghezza/altezza della cella esclusa dal campionamento su
  // ciascun lato, per restare nella porzione "piena" del pixel fisico.
  const INSET_RATIO = 0.25;

  function sampleCellColor(imageData, width, height, cell) {
    const insetX = cell.width * INSET_RATIO;
    const insetY = cell.height * INSET_RATIO;

    let x0 = Math.max(0, Math.round(cell.left + insetX));
    let x1 = Math.min(width - 1, Math.round(cell.right - insetX));
    let y0 = Math.max(0, Math.round(cell.top + insetY));
    let y1 = Math.min(height - 1, Math.round(cell.bottom - insetY));

    // Se la cella è troppo piccola per reggere l'inset, ripiega sull'area piena.
    if (x1 <= x0) {
      x0 = Math.max(0, Math.round(cell.left));
      x1 = Math.min(width - 1, Math.round(cell.right));
    }
    if (y1 <= y0) {
      y0 = Math.max(0, Math.round(cell.top));
      y1 = Math.min(height - 1, Math.round(cell.bottom));
    }

    if (x1 <= x0 || y1 <= y0) return null;

    const data = imageData.data;
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

    if (count === 0) return null;

    return {
      r: Math.round(sumR / count),
      g: Math.round(sumG / count),
      b: Math.round(sumB / count),
    };
  }

  /**
   * Estrae i colori per tutte le celle prodotte da PixelDetector.buildCells().
   * Ritorna un array di 18 elementi { index, color: {r,g,b}, hasDirectBlobMatch,
   * matchConfidence }, oppure null se non c'è imageData o pixelDetectorResult validi.
   *
   * Il colore di fallback per una cella non campionabile è bianco (255,255,255):
   * coerente con lo sfondo, così una cella illeggibile non introduce un colore
   * arbitrario/rumoroso nella sonificazione.
   */
  function extractRowColors(imageData, width, height, pixelDetectorResult) {
    if (!imageData || !pixelDetectorResult) return null;

    return pixelDetectorResult.cells.map((cell) => {
      const sampled = sampleCellColor(imageData, width, height, cell);
      const color = sampled || { r: 255, g: 255, b: 255 };
      return {
        index: cell.index,
        color,
        hasDirectBlobMatch: cell.hasDirectBlobMatch,
        matchConfidence: cell.matchConfidence,
      };
    });
  }

  window.ColorExtractor = {
    extractRowColors,
  };
})();
