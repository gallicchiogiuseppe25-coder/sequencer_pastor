/**
 * audio/soundEngine.js
 *
 * Responsabilità:
 * - Costruire un grafo Web Audio PERSISTENTE all'avvio (init(), chiamato
 *   dentro il gesture utente iniziale insieme alla camera) e non toccarlo
 *   più strutturalmente: nessun oscillatore o buffer source viene mai
 *   creato o fermato dopo l'inizializzazione
 * - Esporre alle synth mode (harmonicField, spectralTranslation,
 *   rhythmicEmission, colorSynthesis) solo funzioni di modifica PARAMETRI,
 *   sempre tramite setTargetAtTime (rampe esponenziali), mai
 *   setValueAtTime istantaneo, per garantire l'assenza di click
 * - Fornire un banco di 18 "voci oscillatore" (oscillator -> filter -> gain
 *   -> panner) e un banco di 18 "voci rumore" che condividono un'unica
 *   sorgente di rumore bianco persistente (per i trigger percussivi della
 *   modalità Rhythmic Emission, senza mai fare start/stop del buffer)
 * - Gestire il master gain separatamente: controllato da
 *   ConfidenceState.activityLevel con una costante di tempo più lenta e
 *   deliberata, distinta dallo smoothing rapido dei parametri timbrici
 * - Applicare un limiter finale (DynamicsCompressorNode configurato in
 *   modo aggressivo) prima della destinazione, come rete di sicurezza
 *   quando più voci si sommano
 *
 * Espone: window.SoundEngine
 */

(function () {
  'use strict';

  const NUM_VOICES = 18;

  // Costante di tempo di default per rampe di parametri timbrici (rapida).
  const DEFAULT_TIME_CONSTANT = 0.08;

  // Costante di tempo per il fade del gain master (più lenta e deliberata:
  // è la transizione percettiva di "il sistema si sta attivando/disattivando").
  const MASTER_RAMP_TIME_CONSTANT = 0.25;

  let audioContext = null;
  let masterGainNode = null;
  let limiterNode = null;

  let voices = [];       // array di { oscillator, filter, gain, panner }
  let noiseSource = null;
  let noiseVoices = [];  // array di { gain, panner }, condividono noiseSource
  let kickVoices = [];   // array di { oscillator, gain, panner } per il kick sinusoidale

  let initialized = false;

  function createNoiseBuffer(context, durationSeconds) {
    const sampleRate = context.sampleRate;
    const length = Math.floor(sampleRate * durationSeconds);
    const buffer = context.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  function buildOscillatorVoice(context, destination) {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 220;

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 4000;
    filter.Q.value = 0.7;

    const gain = context.createGain();
    gain.gain.value = 0; // silenziosa finché una synth mode non la alza esplicitamente

    const panner = context.createStereoPanner();
    panner.pan.value = 0;

    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(destination);

    oscillator.start(); // avviato una sola volta: non verrà mai fermato o ricreato

    return { oscillator, filter, gain, panner };
  }

  function buildNoiseVoice(context, sharedNoiseSource, destination) {
    const gain = context.createGain();
    gain.gain.value = 0;

    const panner = context.createStereoPanner();
    panner.pan.value = 0;

    sharedNoiseSource.connect(gain);
    gain.connect(panner);
    panner.connect(destination);

    return { gain, panner };
  }

  /**
   * Voce kick: oscillatore sinusoidale persistente + gain + panner.
   * Il carattere "caldo e profondo" (stile 808) nasce da un inviluppo di
   * PITCH (parte alto ~150Hz e scende rapidamente verso ~45Hz) combinato
   * con un inviluppo di ampiezza — entrambi schedulati sul clock audio,
   * senza mai fare start/stop dell'oscillatore.
   */
  function buildKickVoice(context, destination) {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = 45;

    const gain = context.createGain();
    gain.gain.value = 0;

    const panner = context.createStereoPanner();
    panner.pan.value = 0;

    oscillator.connect(gain);
    gain.connect(panner);
    panner.connect(destination);

    oscillator.start(); // una sola volta, mai fermato

    return { oscillator, gain, panner };
  }

  /**
   * Inizializza il grafo audio persistente. DEVE essere chiamata dentro lo
   * stesso gesture utente (tap su #startButton) che avvia anche la camera,
   * per rispettare le autoplay policy di iOS Safari / Android Chrome.
   * Chiamare più volte non ha effetto dopo la prima.
   */
  function init() {
    if (initialized) return audioContext;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();

    masterGainNode = audioContext.createGain();
    masterGainNode.gain.value = 0; // si parte in silenzio; l'attivazione arriva via setMasterActivityLevel

    limiterNode = audioContext.createDynamicsCompressor();
    // Configurazione da limiter di sicurezza (non compressione "musicale"):
    // soglia alta (interviene solo sui veri picchi), ratio alto, attacco
    // quasi istantaneo. Con -2dB il segnale viaggia quasi a piena scala e
    // il limiter fa solo da rete di protezione contro il clipping.
    limiterNode.threshold.value = -2;
    limiterNode.knee.value = 0;
    limiterNode.ratio.value = 20;
    limiterNode.attack.value = 0.003;
    limiterNode.release.value = 0.15;

    masterGainNode.connect(limiterNode);
    limiterNode.connect(audioContext.destination);

    voices = [];
    for (let i = 0; i < NUM_VOICES; i++) {
      voices.push(buildOscillatorVoice(audioContext, masterGainNode));
    }

    const noiseBuffer = createNoiseBuffer(audioContext, 2.0);
    noiseSource = audioContext.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;
    noiseSource.start(); // avviata una sola volta: i "trigger" percussivi sono
                         // solo inviluppi di gain, mai start/stop del nodo sorgente

    noiseVoices = [];
    for (let i = 0; i < NUM_VOICES; i++) {
      noiseVoices.push(buildNoiseVoice(audioContext, noiseSource, masterGainNode));
    }

    kickVoices = [];
    for (let i = 0; i < NUM_VOICES; i++) {
      kickVoices.push(buildKickVoice(audioContext, masterGainNode));
    }

    initialized = true;
    return audioContext;
  }

  function ensureReady() {
    if (!initialized) {
      throw new Error(
        'SoundEngine non inizializzato: chiamare SoundEngine.init() dentro un gesture utente prima di usare altri metodi.'
      );
    }
  }

  function rampTo(audioParam, value, timeConstant) {
    audioParam.setTargetAtTime(
      value,
      audioContext.currentTime,
      timeConstant != null ? timeConstant : DEFAULT_TIME_CONSTANT
    );
  }

  // --- API per le synth mode: voci oscillatore ----------------------------

  function setVoiceFrequency(index, freqHz, timeConstant) {
    ensureReady();
    rampTo(voices[index].oscillator.frequency, freqHz, timeConstant);
  }

  function setVoiceWaveform(index, type) {
    ensureReady();
    // Cambio di forma d'onda: operazione discreta, il Web Audio API non
    // supporta una rampa per questo parametro. Non introduce click perché
    // non è un salto di ampiezza o fase, solo di forma dello spettro.
    voices[index].oscillator.type = type;
  }

  function setVoiceFilterFrequency(index, freqHz, timeConstant) {
    ensureReady();
    rampTo(voices[index].filter.frequency, freqHz, timeConstant);
  }

  function setVoiceFilterQ(index, q, timeConstant) {
    ensureReady();
    rampTo(voices[index].filter.Q, q, timeConstant);
  }

  function setVoiceGain(index, gainValue, timeConstant) {
    ensureReady();
    rampTo(voices[index].gain.gain, gainValue, timeConstant);
  }

  function setVoicePan(index, panValue, timeConstant) {
    ensureReady();
    rampTo(voices[index].panner.pan, panValue, timeConstant);
  }

  // --- API per le synth mode: voci di rumore (percussive) -----------------

  function setNoiseVoiceGain(index, gainValue, timeConstant) {
    ensureReady();
    rampTo(noiseVoices[index].gain.gain, gainValue, timeConstant);
  }

  function setNoiseVoicePan(index, panValue, timeConstant) {
    ensureReady();
    rampTo(noiseVoices[index].panner.pan, panValue, timeConstant);
  }

  /**
   * Trigger percussivo per l'indice dato: sale rapidamente al picco e poi
   * torna a zero con rilascio esponenziale, interamente tramite
   * setTargetAtTime (mai un valore istantaneo), per evitare click anche
   * sui trigger ritmici.
   */
  function triggerNoiseHit(index, peakGain, attackTime, releaseTimeConstant) {
    ensureReady();
    triggerNoiseHitAt(index, audioContext.currentTime, peakGain, attackTime, releaseTimeConstant);
  }

  /**
   * Come triggerNoiseHit, ma schedulato a un tempo audio preciso (clock
   * dell'AudioContext). Essenziale per il sequencer a BPM fisso: i colpi
   * vengono programmati in anticipo sul clock audio, quindi il timing è
   * campione-preciso e indipendente dal jitter del loop video/JS.
   */
  function triggerNoiseHitAt(index, when, peakGain, attackTime, releaseTimeConstant) {
    ensureReady();
    const gainParam = noiseVoices[index].gain.gain;
    gainParam.cancelScheduledValues(when);
    gainParam.setTargetAtTime(peakGain, when, Math.max(0.001, attackTime));
    gainParam.setTargetAtTime(0, when + attackTime, releaseTimeConstant);
  }

  /**
   * Kick caldo e profondo, schedulato a tempo audio preciso.
   * Anatomia del colpo (stile 808):
   * - pitch: parte da startFreq (~150Hz, il "punch" dell'attacco) e scende
   *   esponenzialmente a endFreq (~45Hz, il corpo profondo) in pitchDecay
   * - ampiezza: attacco quasi istantaneo, rilascio esponenziale morbido
   * Nessuno start/stop di nodi: solo inviluppi su oscillatore persistente.
   */
  function triggerKickAt(index, when, peakGain, options) {
    ensureReady();
    const opts = options || {};
    const startFreq = opts.startFreq != null ? opts.startFreq : 150;
    const endFreq = opts.endFreq != null ? opts.endFreq : 45;
    const pitchDecay = opts.pitchDecay != null ? opts.pitchDecay : 0.03;
    const ampRelease = opts.ampRelease != null ? opts.ampRelease : 0.12;

    const voice = kickVoices[index];

    const freqParam = voice.oscillator.frequency;
    freqParam.cancelScheduledValues(when);
    freqParam.setValueAtTime(startFreq, when);
    freqParam.setTargetAtTime(endFreq, when, pitchDecay);

    const gainParam = voice.gain.gain;
    gainParam.cancelScheduledValues(when);
    gainParam.setTargetAtTime(peakGain, when, 0.002);
    gainParam.setTargetAtTime(0, when + 0.015, ampRelease);
  }

  function setKickVoicePan(index, panValue, timeConstant) {
    ensureReady();
    rampTo(kickVoices[index].panner.pan, panValue, timeConstant);
  }

  // --- Master ----------------------------------------------------------------

  // Gain del master a piena attività. Sopra 1.0 spinge il segnale verso il
  // limiter, che a sua volta protegge dal clipping: è il modo corretto di
  // guadagnare loudness percepita senza distorsione, utile per speaker
  // integrati di laptop/telefoni che riproducono a basso volume.
  const MASTER_FULL_LEVEL = 1.6;

  /**
   * Da chiamare ad ogni frame con ConfidenceState.getActivityLevel() (0..1).
   * Usa una costante di tempo più lenta rispetto ai parametri timbrici:
   * l'attivazione/disattivazione del sistema deve sembrare un fade
   * deliberato, non un ulteriore parametro che "vibra" al ritmo dei frame.
   */
  function setMasterActivityLevel(level) {
    ensureReady();
    rampTo(masterGainNode.gain, level * MASTER_FULL_LEVEL, MASTER_RAMP_TIME_CONSTANT);
  }

  function getAudioContext() {
    return audioContext;
  }

  function isInitialized() {
    return initialized;
  }

  window.SoundEngine = {
    init,
    isInitialized,
    getAudioContext,
    setVoiceFrequency,
    setVoiceWaveform,
    setVoiceFilterFrequency,
    setVoiceFilterQ,
    setVoiceGain,
    setVoicePan,
    setNoiseVoiceGain,
    setNoiseVoicePan,
    triggerNoiseHit,
    triggerNoiseHitAt,
    triggerKickAt,
    setKickVoicePan,
    setMasterActivityLevel,
    NUM_VOICES,
  };
})();
