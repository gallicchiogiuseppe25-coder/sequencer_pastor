/**
 * vision/pixelDetector.js
 *
 * MODELLO A FINESTRA FISSA + GRIGLIA SPARSA:
 * la finestra di lettura è dimensionata per contenere esattamente 18 celle,
 * quindi la geometria delle celle è NOTA A PRIORI: pitch = larghezza / 18,
 * indipendentemente da quanti blob sono stati rilevati. I blob servono solo
 * a marcare QUALI celle sono occupate da un pixel-ombra (le altre sono
 * "luce" — bianche — ed è una condizione perfettamente legittima, non un
 * errore di detection).
 *
 * Questo sostituisce il vecchio modello che stimava il pitch dalla distanza
 * tra il primo e l'ultimo blob: fragile con pochi blob (2 blob vicini
 * davano un pitch assurdo) e concettualmente sbagliato per una stampa in
 * cui la maggior parte delle celle è vuota per design.
 *
 * Espone: window.PixelDetector
 */

(function () {
  'use strict';

  const EXPECTED_PIXEL_COUNT = 18;

  // Un blob viene associato a una cella solo se il suo centro cade entro
  // questa frazione di pitch dal centro della cella.
  const MAX_MATCH_DISTANCE_RATIO = 0.5;

  /**
   * Costruisce le 18 celle a geometria fissa sull'intera finestra di analisi.
   * Funziona anche con zero blob (riga tutta "luce"): tutte le celle
   * risultano semplicemente non occupate.
   *
   * @param row - il bestRowBand di GridDetector (può avere pochi blob), o null
   * @param analysisWidth/analysisHeight - dimensioni dello spazio di analisi
   */
  function buildCells(row, analysisWidth, analysisHeight) {
    if (!analysisWidth || !analysisHeight) return null;

    const pitch = analysisWidth / EXPECTED_PIXEL_COUNT;
    const blobs = row && row.blobs ? row.blobs : [];

    // La banda verticale delle celle: se ci sono blob usiamo la loro
    // estensione reale (più precisa), altrimenti l'intera altezza della
    // finestra (che è comunque alta ~1 pixel fisico per costruzione).
    const yTop = blobs.length > 0 ? Math.min(...blobs.map((b) => b.y)) : 0;
    const yBottom =
      blobs.length > 0 ? Math.max(...blobs.map((b) => b.y + b.height)) : analysisHeight;

    const slots = [];
    for (let i = 0; i < EXPECTED_PIXEL_COUNT; i++) {
      slots.push({
        index: i,
        centerX: (i + 0.5) * pitch,
        matchedBlob: null,
        matchDistance: Infinity,
      });
    }

    // Associa ogni blob alla cella (fissa) più vicina.
    for (const blob of blobs) {
      const cellIndex = Math.min(
        EXPECTED_PIXEL_COUNT - 1,
        Math.max(0, Math.floor(blob.centerX / pitch))
      );
      const slot = slots[cellIndex];
      const distance = Math.abs(blob.centerX - slot.centerX);
      if (distance < slot.matchDistance) {
        slot.matchedBlob = blob;
        slot.matchDistance = distance;
      }
    }

    const tolerance = pitch * MAX_MATCH_DISTANCE_RATIO;

    const cells = slots.map((slot) => {
      const hasGoodMatch = slot.matchedBlob !== null && slot.matchDistance <= tolerance;
      return {
        index: slot.index,
        centerX: slot.centerX,
        left: slot.centerX - pitch / 2,
        right: slot.centerX + pitch / 2,
        top: yTop,
        bottom: yBottom,
        width: pitch,
        height: Math.max(1, yBottom - yTop),
        hasDirectBlobMatch: hasGoodMatch,
        matchConfidence: hasGoodMatch ? Math.max(0, 1 - slot.matchDistance / tolerance) : 0,
      };
    });

    return {
      cells,
      pitch,
      yTop,
      yBottom,
      occupiedCount: cells.filter((c) => c.hasDirectBlobMatch).length,
    };
  }

  window.PixelDetector = {
    buildCells,
    EXPECTED_PIXEL_COUNT,
  };
})();
