/**
 * audio/synthModes/sequencer.js
 *
 * SEQUENCER — la riga di 18 pixel come step sequencer
 *
 * Modello (da specifica utente):
 * - pixel colorato = battuta, pixel vuoto = niente battuta
 * - tempo interno FISSO a 120 BPM: la riga inquadrata viene suonata in loop
 *   finché non si passa alla successiva
 * - suono percussivo UNICO, uguale per tutti gli step
 *
 * Architettura del timing:
 * - Il pattern (quali dei 18 step sono attivi) viene aggiornato dal loop di
 *   vision (~30fps) in update(), ma il TIMING dei colpi NON dipende dal loop
 *   video: uno scheduler con lookahead programma i colpi in anticipo sul
 *   clock dell'AudioContext (triggerNoiseHitAt), quindi il BPM è stabile e
 *   campione-preciso anche se il framerate video oscilla.
 * - Lo scheduler legge il pattern corrente al momento di schedulare ogni
 *   step: cambiare riga a metà loop aggiorna il ritmo dallo step successivo,
 *   senza riavviare il loop né produrre discontinuità.
 *
 * Suddivisione: ogni step è un sedicesimo a 120 BPM = 125ms.
 * Un giro completo di 18 step dura 2.25 secondi.
 *
 * Contratto comune a tutte le synth mode: { activate(), deactivate(), update(sampledRow) }
 */

(function () {
  'use strict';

  const NUM_STEPS = 18;

  const BPM = 120;
  const STEP_SECONDS = 60 / BPM / 4; // sedicesimi: 125ms a 120 BPM

  // Scheduler con lookahead: ogni SCHEDULER_INTERVAL_MS controlliamo se ci
  // sono step da programmare entro i prossimi LOOKAHEAD_SECONDS.
  const SCHEDULER_INTERVAL_MS = 25;
  const LOOKAHEAD_SECONDS = 0.12;

  // Carattere del colpo: BEEP DA TELEGRAFO.
  // Una nota singola e pura — un La (880 Hz, A5: il registro acuto è quello
  // del segnalatore telegrafico; per un La più grave, 440 = A4) — secca,
  // senza riverbero né coda: attacco quasi istantaneo, brevissimo corpo,
  // rilascio rapido. Il pitch NON si muove (startFreq = endFreq): è il
  // contrario del kick, dove era proprio la discesa di pitch a fare il colpo.
  const HIT_PEAK_GAIN = 1.0;
  const BEEP_OPTIONS = {
    startFreq: 880,
    endFreq: 880,
    pitchDecay: 0.001,  // irrilevante con pitch fisso
    ampRelease: 0.035,  // coda cortissima: "dot" secco, niente strascico
  };

  // NOTA: niente umanizzazione qui — il telegrafo è meccanico e regolare,
  // la precisione rigida del clock audio È il carattere giusto. E niente
  // transiente di rumore sovrapposto: il beep è tono puro.

  // Uno step è "attivo" se la cella ha un match diretto con un blob
  // sufficientemente affidabile.
  const STEP_ACTIVE_CONFIDENCE_THRESHOLD = 0.25;

  // --- Stato interno --------------------------------------------------------

  let pattern = new Array(NUM_STEPS).fill(false);
  let schedulerTimer = null;
  let nextStepTime = 0;   // tempo audio (secondi) del prossimo step da programmare
  let nextStepIndex = 0;  // indice 0..17 del prossimo step
  let loopAnchorTime = 0; // tempo audio a cui è (o sarà) suonato lo step 0:
                           // riferimento per calcolare lo step in riproduzione

  function indexToPan(index) {
    return (index / (NUM_STEPS - 1)) * 2 - 1;
  }

  /**
   * Indice (0..17) dello step ATTUALMENTE in riproduzione, calcolato dal
   * clock audio — non dal loop video. È il "playhead" del sequencer, usato
   * dall'overlay per illuminare la cella che sta suonando in questo momento.
   * Ritorna -1 se il loop non è ancora partito o il sequencer è spento.
   */
  function getCurrentStep() {
    const ctx = window.SoundEngine.getAudioContext();
    if (!ctx || schedulerTimer === null) return -1;
    const elapsed = ctx.currentTime - loopAnchorTime;
    if (elapsed < 0) return -1;
    return Math.floor(elapsed / STEP_SECONDS) % NUM_STEPS;
  }

  function schedulerTick() {
    const ctx = window.SoundEngine.getAudioContext();
    if (!ctx) return;

    // Programma tutti gli step che cadono dentro la finestra di lookahead.
    while (nextStepTime < ctx.currentTime + LOOKAHEAD_SECONDS) {
      // Il pattern viene letto QUI, al momento della schedulazione: se la
      // vision ha appena aggiornato la riga, lo step riflette già il nuovo
      // pattern, senza riavvii né attese.
      if (pattern[nextStepIndex]) {
        // Beep da telegrafo: tono puro, esattamente sul tempo (nessuna
        // umanizzazione — la regolarità meccanica è il carattere voluto),
        // nessun transiente di rumore sovrapposto.
        window.SoundEngine.triggerKickAt(
          nextStepIndex,
          nextStepTime,
          HIT_PEAK_GAIN,
          BEEP_OPTIONS
        );
      }

      nextStepTime += STEP_SECONDS;
      nextStepIndex = (nextStepIndex + 1) % NUM_STEPS;
    }
  }

  function activate() {
    const ctx = window.SoundEngine.getAudioContext();

    pattern.fill(false);
    nextStepIndex = 0;
    nextStepTime = ctx ? ctx.currentTime + 0.1 : 0;
    loopAnchorTime = nextStepTime; // lo step 0 suonerà esattamente qui

    // Pan fisso per posizione: lo step 1 a sinistra, lo step 18 a destra —
    // il loop "attraversa" lo spazio stereo seguendo la riga fisica.
    // Pan contenuto (±0.7) per non svuotare il centro: un kick profondo
    // perde corpo se completamente sbilanciato su un solo canale.
    for (let i = 0; i < NUM_STEPS; i++) {
      window.SoundEngine.setKickVoicePan(i, indexToPan(i) * 0.7, 0.001);
      window.SoundEngine.setNoiseVoicePan(i, indexToPan(i) * 0.7, 0.001);
    }

    if (schedulerTimer === null) {
      schedulerTimer = setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
    }
  }

  function deactivate() {
    if (schedulerTimer !== null) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    pattern.fill(false);
    for (let i = 0; i < NUM_STEPS; i++) {
      window.SoundEngine.setNoiseVoiceGain(i, 0);
    }
  }

  /**
   * Aggiorna il pattern dagli ultimi dati di vision. Non tocca il timing:
   * il loop continua imperturbato, gli step futuri leggeranno il nuovo pattern.
   */
  function update(sampledRow) {
    if (!sampledRow) return;

    for (const pixel of sampledRow) {
      pattern[pixel.index] = pixel.confidence > STEP_ACTIVE_CONFIDENCE_THRESHOLD;
    }
  }

  window.SynthModes = window.SynthModes || {};
  window.SynthModes.sequencer = { activate, deactivate, update, getCurrentStep };
})();
