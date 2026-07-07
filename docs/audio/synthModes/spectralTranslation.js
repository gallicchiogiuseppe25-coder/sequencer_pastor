/**
 * audio/synthModes/spectralTranslation.js
 *
 * SPECTRAL TRANSLATION
 * 18 pixel = spettro audio | intensità = ampiezza frequenze
 *
 * Design:
 * - Ogni voce è agganciata a una banda di frequenza FISSA (impostata una
 *   sola volta in activate(), log-spaziata da 100Hz a 5000Hz, come un
 *   piccolo banco additivo/vocoder): la riga fisica diventa uno spettro
 *   la cui forma cambia nel tempo, invece di 18 note indipendenti.
 * - L'ampiezza di ciascuna banda è guidata dall'"intensità" del pixel,
 *   definita come luminosità pesata dalla saturazione: uno sfondo bianco
 *   (saturazione quasi nulla) produce ampiezza quasi nulla anche se molto
 *   luminoso. Questo rinforza percettivamente "assenza di pixel colorato =
 *   quasi silenzio in quella banda" senza bisogno di una soglia arbitraria
 *   separata, mantenendo continuità.
 * - Forma d'onda sinusoidale pura per tutte le bande: mantiene la natura
 *   "spettrale" pulita, senza armoniche aggiuntive che confonderebbero la
 *   lettura additiva dello spettro.
 *
 * Contratto comune a tutte le synth mode: { activate(), deactivate(), update(sampledRow) }
 */

(function () {
  'use strict';

  const NUM_VOICES = window.SoundEngine.NUM_VOICES;

  const FREQ_MIN_HZ = 100;
  const FREQ_MAX_HZ = 5000;

  const VOICE_GAIN_MAX = 0.09; // per singola banda, a piena intensità

  function bandFrequency(index) {
    const ratio = FREQ_MAX_HZ / FREQ_MIN_HZ;
    return FREQ_MIN_HZ * Math.pow(ratio, index / (NUM_VOICES - 1));
  }

  function indexToPan(index) {
    return (index / (NUM_VOICES - 1)) * 2 - 1;
  }

  function activate() {
    // Le frequenze delle bande sono fisse per indice: le impostiamo una
    // volta sola qui, invece di ricalcolarle ad ogni frame di update().
    for (let i = 0; i < NUM_VOICES; i++) {
      window.SoundEngine.setVoiceWaveform(i, 'sine');
      window.SoundEngine.setVoiceFrequency(i, bandFrequency(i), 0.001);
      window.SoundEngine.setVoicePan(i, indexToPan(i), 0.001);
      // Filtro completamente aperto: qui il timbro è nel banco additivo
      // stesso (posizione + ampiezza delle bande), non nel filtraggio.
      window.SoundEngine.setVoiceFilterFrequency(i, 18000, 0.001);
    }
  }

  function deactivate() {
    for (let i = 0; i < NUM_VOICES; i++) {
      window.SoundEngine.setVoiceGain(i, 0);
    }
  }

  function update(sampledRow) {
    if (!sampledRow) return;

    for (const pixel of sampledRow) {
      const { index, saturation, luminosity, confidence } = pixel;

      const intensity = luminosity * (0.35 + 0.65 * saturation);
      const gain = VOICE_GAIN_MAX * intensity * (0.5 + 0.5 * confidence);

      window.SoundEngine.setVoiceGain(index, gain);
    }
  }

  window.SynthModes = window.SynthModes || {};
  window.SynthModes.spectralTranslation = { activate, deactivate, update };
})();
