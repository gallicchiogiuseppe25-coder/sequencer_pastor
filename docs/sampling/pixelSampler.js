/**
 * sampling/pixelSampler.js
 *
 * Responsabilità:
 * - Convertire i 18 colori RGB grezzi (da ColorExtractor) in un formato
 *   normalizzato condiviso: { hue, saturation, luminosity } in 0..1,
 *   usato da TUTTE e 4 le modalità sonore, così la pipeline di vision
 *   resta completamente disaccoppiata dalla scelta di synth mode
 * - Applicare smoothing temporale (EMA) per-indice-pixel, per assorbire il
 *   jitter frame-a-frame della detection PRIMA che i valori raggiungano il
 *   motore audio — è il "buffering percettivo" richiesto per la stabilità
 * - Pesare la velocità dello smoothing in base alla matchConfidence di ogni
 *   cella: una cella con match diretto affidabile può aggiornarsi più
 *   rapidamente, una cella interpolata/incerta si muove più lentamente
 *   verso il nuovo valore, evitando che rumore di detection produca
 *   variazioni timbriche percepibili
 * - Gestire correttamente la natura circolare della hue (0 e 1 sono adiacenti,
 *   non agli estremi opposti): una media esponenziale ingenua produrrebbe
 *   salti errati attraversando il rosso (hue ≈ 0 / 1)
 *
 * Espone: window.PixelSampler
 */

(function () {
  'use strict';

  const EXPECTED_PIXEL_COUNT = 18;

  // Costante di smoothing base (EMA). Valori più bassi = più stabile ma più
  // lento a rispondere; più alti = più reattivo ma più sensibile al rumore.
  const BASE_SMOOTHING_ALPHA = 0.25;

  // Anche a confidenza zero, lasciamo una quota minima di reattività:
  // altrimenti una cella sempre interpolata (mai un match diretto) non
  // aggiornerebbe mai il proprio valore anche se il colore reale è cambiato.
  const MIN_CONFIDENCE_WEIGHT = 0.3;

  // Stato di smoothing persistente per ciascuno dei 18 indici.
  let smoothedState = null; // array di { hue, saturation, luminosity } | null

  function reset() {
    smoothedState = null;
  }

  function rgbToHsl(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;

    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const luminosity = (max + min) / 2;

    let hue = 0;
    let saturation = 0;

    if (max !== min) {
      const delta = max - min;
      saturation = luminosity > 0.5 ? delta / (2 - max - min) : delta / (max + min);

      switch (max) {
        case rn:
          hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
          break;
        case gn:
          hue = (bn - rn) / delta + 2;
          break;
        case bn:
          hue = (rn - gn) / delta + 4;
          break;
      }
      hue /= 6;
    }

    return { hue, saturation, luminosity };
  }

  /**
   * Interpola la hue rispettando la sua natura circolare: sceglie sempre il
   * percorso più breve tra il valore precedente e quello nuovo (es. da 0.95
   * a 0.02 il percorso corretto è "in avanti" di 0.07, non "indietro" di 0.93).
   */
  function blendHue(previousHue, newHue, alpha) {
    let delta = newHue - previousHue;
    // Riporta delta nell'intervallo [-0.5, 0.5], cioè il percorso più breve sul cerchio.
    delta = delta - Math.round(delta);
    let blended = previousHue + alpha * delta;
    // Normalizza in [0, 1)
    blended = blended - Math.floor(blended);
    return blended;
  }

  /**
   * Normalizza e smussa i 18 colori grezzi prodotti da ColorExtractor.
   * Ritorna un array di 18 { index, hue, saturation, luminosity, confidence }.
   */
  function sampleRow(rawColors) {
    if (!rawColors || rawColors.length !== EXPECTED_PIXEL_COUNT) return null;

    if (!smoothedState) {
      // Bootstrap: prima riga mai vista, nessun valore precedente da smussare.
      smoothedState = rawColors.map((entry) => rgbToHsl(entry.color.r, entry.color.g, entry.color.b));
    }

    const output = new Array(EXPECTED_PIXEL_COUNT);

    for (let i = 0; i < EXPECTED_PIXEL_COUNT; i++) {
      const entry = rawColors[i];
      const target = rgbToHsl(entry.color.r, entry.color.g, entry.color.b);
      const previous = smoothedState[i];

      const confidenceWeight = MIN_CONFIDENCE_WEIGHT + (1 - MIN_CONFIDENCE_WEIGHT) * entry.matchConfidence;
      const alpha = BASE_SMOOTHING_ALPHA * confidenceWeight;

      const blendedHue = blendHue(previous.hue, target.hue, alpha);
      const blendedSaturation = previous.saturation + alpha * (target.saturation - previous.saturation);
      const blendedLuminosity = previous.luminosity + alpha * (target.luminosity - previous.luminosity);

      smoothedState[i] = {
        hue: blendedHue,
        saturation: blendedSaturation,
        luminosity: blendedLuminosity,
      };

      output[i] = {
        index: i,
        hue: blendedHue,
        saturation: blendedSaturation,
        luminosity: blendedLuminosity,
        confidence: entry.matchConfidence,
      };
    }

    return output;
  }

  window.PixelSampler = {
    sampleRow,
    reset,
    EXPECTED_PIXEL_COUNT,
  };
})();
