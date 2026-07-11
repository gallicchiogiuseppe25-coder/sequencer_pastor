/**
 * audio/synthModes/colorSynthesis.js
 *
 * COLOR SYNTHESIS
 * rosso -> saw | blu -> sine | verde -> filtro | saturazione -> modulazione
 *
 * Design:
 * - La forma d'onda è scelta in base alla vicinanza circolare dell'hue ai
 *   tre ancoraggi cromatici primari (rosso=0, verde=1/3, blu=2/3 sulla
 *   ruota HSL). Il verde non ha una forma d'onda propria nella specifica
 *   ("verde -> filtro"): usiamo triangle come timbro neutro di base per la
 *   zona verde, perché il suo carattere deve emergere dalla modulazione
 *   del filtro, non dalla forma d'onda in sé.
 * - La saturazione (richiesta come "modulazione") guida sia l'apertura sia
 *   la risonanza (Q) del filtro; la vicinanza al verde amplifica ulteriormente
 *   questo effetto, così "verde -> filtro" ha un peso maggiore proprio dove
 *   l'hue è più vicino al verde.
 * - La luminosità aggiunge una modesta escursione di pitch (110-440 Hz),
 *   per dare comunque materiale tonale senza sovrapporsi al ruolo primario
 *   del colore in questa modalità.
 *
 * Contratto comune a tutte le synth mode: { activate(), deactivate(), update(sampledRow) }
 */

(function () {
  'use strict';

  const NUM_VOICES = window.SoundEngine.NUM_VOICES;

  const RED_HUE = 0;
  const GREEN_HUE = 1 / 3;
  const BLUE_HUE = 2 / 3;

  const FILTER_BASE_HZ = 300;
  const FILTER_SATURATION_RANGE_HZ = 5000;
  const FILTER_Q_MIN = 0.5;
  const FILTER_Q_MAX = 12;

  const VOICE_GAIN_BASE = 0.07;

  function hueDistance(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, 1 - d); // distanza circolare minima su [0,1)
  }

  function hueToWaveform(hue) {
    const distToRed = hueDistance(hue, RED_HUE);
    const distToGreen = hueDistance(hue, GREEN_HUE);
    const distToBlue = hueDistance(hue, BLUE_HUE);

    const minDist = Math.min(distToRed, distToGreen, distToBlue);
    if (minDist === distToRed) return 'sawtooth';
    if (minDist === distToBlue) return 'sine';
    return 'triangle';
  }

  function greenInfluence(hue) {
    const distToGreen = hueDistance(hue, GREEN_HUE);
    return Math.max(0, 1 - distToGreen / 0.5); // 1 quando hue==verde, 0 all'estremo opposto
  }

  function indexToPan(index) {
    return (index / (NUM_VOICES - 1)) * 2 - 1;
  }

  function activate() {
    // Nessuna preparazione strutturale necessaria oltre a quanto già
    // persistente in SoundEngine.
  }

  function deactivate() {
    for (let i = 0; i < NUM_VOICES; i++) {
      window.SoundEngine.setVoiceGain(i, 0);
    }
  }

  function update(sampledRow) {
    if (!sampledRow) return;

    for (const pixel of sampledRow) {
      const { index, hue, saturation, luminosity, confidence } = pixel;

      const waveform = hueToWaveform(hue);
      const green = greenInfluence(hue);

      const filterOpenAmount = saturation * (0.5 + 0.5 * green);
      const filterFreq = FILTER_BASE_HZ + filterOpenAmount * FILTER_SATURATION_RANGE_HZ;
      const filterQ = FILTER_Q_MIN + saturation * green * (FILTER_Q_MAX - FILTER_Q_MIN);

      const freq = 110 * Math.pow(2, luminosity * 2); // ~110Hz .. ~440Hz

      const gain = VOICE_GAIN_BASE * (0.6 + 0.4 * confidence);

      window.SoundEngine.setVoiceWaveform(index, waveform);
      window.SoundEngine.setVoiceFrequency(index, freq);
      window.SoundEngine.setVoiceFilterFrequency(index, filterFreq);
      window.SoundEngine.setVoiceFilterQ(index, filterQ);
      window.SoundEngine.setVoiceGain(index, gain);
      window.SoundEngine.setVoicePan(index, indexToPan(index));
    }
  }

  window.SynthModes = window.SynthModes || {};
  window.SynthModes.colorSynthesis = { activate, deactivate, update };
})();
