/**
 * audio/synthModes/harmonicField.js
 *
 * HARMONIC FIELD
 * pixel -> nota musicale | luminosità -> pitch | colore -> timbro
 *
 * Design:
 * - La luminosità non è mappata a una frequenza continua arbitraria, ma
 *   quantizzata su una scala pentatonica maggiore: evita dissonanze casuali
 *   quando i colori cambiano rapidamente durante lo scorrimento, mantenendo
 *   il risultato musicalmente coerente anche a velocità di scansione elevate.
 * - Il timbro (hue) è espresso su due livelli: forma d'onda discreta (4
 *   bucket) + apertura del filtro continua guidata dalla saturazione, per
 *   avere sia varietà timbrica sia una componente di modulazione fluida.
 * - Pan per indice (sinistra->destra) per dare chiarezza spaziale alle 18
 *   voci simultanee, evitando un accordo "mono" indistinto.
 *
 * Contratto comune a tutte le synth mode: { activate(), deactivate(), update(sampledRow) }
 */

(function () {
  'use strict';

  const NUM_VOICES = window.SoundEngine.NUM_VOICES;

  // Scala pentatonica maggiore (semitoni relativi alla tonica).
  const SCALE_SEMITONES = [0, 2, 4, 7, 9];
  const BASE_FREQUENCY_HZ = 130.81; // C3
  const OCTAVE_RANGE = 3;

  const WAVEFORM_BY_HUE_BUCKET = ['sine', 'triangle', 'sawtooth', 'square'];

  const VOICE_GAIN_BASE = 0.06; // per voce, con fino a 18 voci simultanee
  const FILTER_MIN_HZ = 500;
  const FILTER_MAX_HZ = 8000;

  function luminosityToFrequency(luminosity) {
    const totalSteps = SCALE_SEMITONES.length * OCTAVE_RANGE;
    const stepIndex = Math.min(totalSteps - 1, Math.floor(luminosity * totalSteps));
    const octave = Math.floor(stepIndex / SCALE_SEMITONES.length);
    const semitone = SCALE_SEMITONES[stepIndex % SCALE_SEMITONES.length];
    const totalSemitones = octave * 12 + semitone;
    return BASE_FREQUENCY_HZ * Math.pow(2, totalSemitones / 12);
  }

  function hueToWaveform(hue) {
    const bucketIndex = Math.min(
      WAVEFORM_BY_HUE_BUCKET.length - 1,
      Math.floor(hue * WAVEFORM_BY_HUE_BUCKET.length)
    );
    return WAVEFORM_BY_HUE_BUCKET[bucketIndex];
  }

  function saturationToFilterFrequency(saturation) {
    return FILTER_MIN_HZ + saturation * (FILTER_MAX_HZ - FILTER_MIN_HZ);
  }

  function indexToPan(index) {
    return (index / (NUM_VOICES - 1)) * 2 - 1;
  }

  function activate() {
    // Le voci oscillatore sono già persistenti in SoundEngine; non serve
    // nessuna preparazione strutturale, solo iniziare ad alzarne il gain
    // nella prima update().
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

      const freq = luminosityToFrequency(luminosity);
      const waveform = hueToWaveform(hue);
      const filterFreq = saturationToFilterFrequency(saturation);
      const pan = indexToPan(index);

      // Le celle a bassa confidenza (interpolate, senza match diretto) sono
      // leggermente attenuate: ammorbidisce l'incertezza di detection invece
      // di farla sentire come un pixel "sbagliato" a piena intensità.
      const gain = VOICE_GAIN_BASE * (0.6 + 0.4 * confidence);

      window.SoundEngine.setVoiceFrequency(index, freq);
      window.SoundEngine.setVoiceWaveform(index, waveform);
      window.SoundEngine.setVoiceFilterFrequency(index, filterFreq);
      window.SoundEngine.setVoiceGain(index, gain);
      window.SoundEngine.setVoicePan(index, pan);
    }
  }

  window.SynthModes = window.SynthModes || {};
  window.SynthModes.harmonicField = { activate, deactivate, update };
})();
