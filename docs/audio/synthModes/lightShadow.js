/**
 * audio/synthModes/lightShadow.js
 *
 * LIGHT / SHADOW — modalità dedicata al concetto specifico dell'installazione
 *
 * Contesto: la griglia deriva da una scansione a nuvola di punti di una
 * parete materica. Solo i pixel "in ombra" sono stati estratti: il bianco è
 * luce (assenza), il colore è ombra, e più il colore è scuro (luminosità
 * bassa) più l'ombra era profonda. Il suono deve accompagnare la lettura
 * comunicando esperienzialmente un passaggio tra luce e ombra.
 *
 * Mappatura (in ordine di importanza percettiva):
 *
 * 1. LUMINOSITÀ — asse primario, mappato su TRE parametri ridondanti per
 *    massima leggibilità (lo stesso segnale letto in tre modi rinforza la
 *    percezione invece di confonderla):
 *      - pitch: ombra profonda (luminosità bassa) = grave; verso la luce
 *        (luminosità alta) = acuto. Quantizzato su scala pentatonica minore
 *        (carattere ambient/musicale, non dissonanza casuale).
 *      - apertura del filtro: ombra profonda = suono ovattato/chiuso;
 *        verso la luce = suono aperto/luminoso timbricamente.
 *      - volume: ombra profonda = presente, quasi "pesante"; avvicinandosi
 *        al bianco il volume sfuma verso il silenzio — la luce, letteralmente,
 *        non genera suono. Le celle bianche/interpolate (senza match, colore
 *        di fallback bianco) hanno di conseguenza gain quasi nullo.
 *
 * 2. HUE — identità timbrica fissa e riconoscibile: rosso/verde/blu come
 *    ancoraggi, sempre lo stesso carattere per lo stesso colore, anche con
 *    palette arbitraria e non nota in anticipo (requisito esplicito di
 *    leggibilità: "se vedo rosso mi aspetto di risentire quel timbro").
 *
 * 3. SATURAZIONE — grana/texture di rumore continua e sottile (non
 *    percussiva), sovrapposta al tono: evoca la materialità della parete
 *    scansionata. Usa il banco di rumore condiviso di SoundEngine, ma qui
 *    come texture continua invece che come trigger discreto.
 *
 * Contratto comune a tutte le synth mode: { activate(), deactivate(), update(sampledRow) }
 */

(function () {
  'use strict';

  const NUM_VOICES = window.SoundEngine.NUM_VOICES;

  // --- Luminosità -> pitch (scala pentatonica minore, carattere ambient/musicale) ---
  const SCALE_SEMITONES = [0, 3, 5, 7, 10]; // pentatonica minore: più "ombrosa" della maggiore
  const BASE_FREQUENCY_HZ = 65.41; // C2: registro basso per l'ombra più profonda
  const OCTAVE_RANGE = 4; // escursione ampia: dal grave profondo all'acuto arioso

  // --- Luminosità -> apertura del filtro ---
  const FILTER_MIN_HZ = 300;  // ombra profonda: suono chiuso/ovattato
  const FILTER_MAX_HZ = 9000; // verso la luce: suono aperto/luminoso
  const FILTER_Q = 0.8;       // risonanza neutra: qui il filtro serve a "aprire/chiudere", non a colorare

  // --- Luminosità -> volume ---
  const VOICE_GAIN_MAX = 0.11; // gain a piena ombra (luminosità minima)
  // Curva non lineare (esponente) per far sfumare il volume più rapidamente
  // vicino al bianco, invece di un fade lineare che lascerebbe udibile un
  // "residuo" anche per colori quasi bianchi.
  const GAIN_CURVE_EXPONENT = 1.6;

  // --- Hue -> identità timbrica fissa ---
  const RED_HUE = 0;
  const GREEN_HUE = 1 / 3;
  const BLUE_HUE = 2 / 3;

  // --- Saturazione -> grana materica continua ---
  const GRAIN_GAIN_MAX = 0.05; // livello massimo della texture di rumore, volutamente sottile

  function hueDistance(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, 1 - d);
  }

  /**
   * Identità timbrica fissa per hue: stessa forma d'onda per lo stesso
   * colore, sempre — è il requisito di leggibilità richiesto esplicitamente.
   */
  function hueToWaveform(hue) {
    const distToRed = hueDistance(hue, RED_HUE);
    const distToGreen = hueDistance(hue, GREEN_HUE);
    const distToBlue = hueDistance(hue, BLUE_HUE);
    const minDist = Math.min(distToRed, distToGreen, distToBlue);
    if (minDist === distToRed) return 'sawtooth';
    if (minDist === distToBlue) return 'sine';
    return 'triangle'; // verde e tinte intermedie
  }

  function luminosityToFrequency(luminosity) {
    const totalSteps = SCALE_SEMITONES.length * OCTAVE_RANGE;
    const stepIndex = Math.min(totalSteps - 1, Math.max(0, Math.floor(luminosity * totalSteps)));
    const octave = Math.floor(stepIndex / SCALE_SEMITONES.length);
    const semitone = SCALE_SEMITONES[stepIndex % SCALE_SEMITONES.length];
    const totalSemitones = octave * 12 + semitone;
    return BASE_FREQUENCY_HZ * Math.pow(2, totalSemitones / 12);
  }

  function luminosityToFilterFrequency(luminosity) {
    return FILTER_MIN_HZ + luminosity * (FILTER_MAX_HZ - FILTER_MIN_HZ);
  }

  function luminosityToGain(luminosity, confidence) {
    // Ombra profonda (luminosity basso) -> gain alto; verso il bianco -> gain
    // verso zero, con curva non lineare per un fade più netto vicino alla luce.
    const shadowDepth = Math.max(0, 1 - luminosity);
    const shaped = Math.pow(shadowDepth, GAIN_CURVE_EXPONENT);
    return VOICE_GAIN_MAX * shaped * (0.6 + 0.4 * confidence);
  }

  function indexToPan(index) {
    return (index / (NUM_VOICES - 1)) * 2 - 1;
  }

  function activate() {
    for (let i = 0; i < NUM_VOICES; i++) {
      window.SoundEngine.setVoiceFilterQ(i, FILTER_Q, 0.001);
      window.SoundEngine.setVoicePan(i, indexToPan(i), 0.001);
      window.SoundEngine.setNoiseVoicePan(i, indexToPan(i), 0.001);
    }
  }

  function deactivate() {
    for (let i = 0; i < NUM_VOICES; i++) {
      window.SoundEngine.setVoiceGain(i, 0);
      window.SoundEngine.setNoiseVoiceGain(i, 0);
    }
  }

  function update(sampledRow) {
    if (!sampledRow) return;

    for (const pixel of sampledRow) {
      const { index, hue, saturation, luminosity, confidence } = pixel;

      const freq = luminosityToFrequency(luminosity);
      const waveform = hueToWaveform(hue);
      const filterFreq = luminosityToFilterFrequency(luminosity);
      const gain = luminosityToGain(luminosity, confidence);

      window.SoundEngine.setVoiceFrequency(index, freq);
      window.SoundEngine.setVoiceWaveform(index, waveform);
      window.SoundEngine.setVoiceFilterFrequency(index, filterFreq);
      window.SoundEngine.setVoiceGain(index, gain);

      // Grana materica continua: proporzionale alla saturazione, ma sempre
      // subordinata alla presenza di ombra (una cella quasi bianca non deve
      // produrre grana udibile anche se la sua saturazione residua non è
      // esattamente zero per rumore di campionamento).
      const shadowPresence = Math.max(0, 1 - luminosity);
      const grainGain = GRAIN_GAIN_MAX * saturation * shadowPresence * (0.5 + 0.5 * confidence);
      window.SoundEngine.setNoiseVoiceGain(index, grainGain);
    }
  }

  window.SynthModes = window.SynthModes || {};
  window.SynthModes.lightShadow = { activate, deactivate, update };
})();
