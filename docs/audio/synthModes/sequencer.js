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

  // Carattere del colpo: kick caldo e profondo, ma udibile anche sugli
  // speaker integrati di un laptop (che riproducono pochissimo sotto ~80Hz):
  // - endFreq a 65Hz invece di 45Hz: mantiene il carattere profondo ma
  //   resta dentro la banda che uno speaker piccolo riesce a riprodurre
  // - pitchDecay leggermente più lungo: più "corpo" udibile nelle medie
  // - gain di picco al massimo: il limiter a valle protegge dal clipping
  const HIT_PEAK_GAIN = 1.0;
  const ATTACK_CLICK_GAIN = 0.35; // transiente di rumore sovrapposto: presenza su speaker piccoli
  const KICK_OPTIONS = {
    startFreq: 160,
    endFreq: 65,
    pitchDecay: 0.045,
    ampRelease: 0.16,
  };

  // Uno step è "attivo" se la cella ha un match diretto con un blob
  // sufficientemente affidabile.
  const STEP_ACTIVE_CONFIDENCE_THRESHOLD = 0.25;

  // --- Stato interno --------------------------------------------------------

  let pattern = new Array(NUM_STEPS).fill(false);
  let schedulerTimer = null;
  let nextStepTime = 0;   // tempo audio (secondi) del prossimo step da programmare
  let nextStepIndex = 0;  // indice 0..17 del prossimo step

  function indexToPan(index) {
    return (index / (NUM_STEPS - 1)) * 2 - 1;
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
        window.SoundEngine.triggerKickAt(
          nextStepIndex,
          nextStepTime,
          HIT_PEAK_GAIN,
          KICK_OPTIONS
        );
        // Transiente di attacco: brevissimo click di rumore (~3ms di corpo)
        // sovrapposto al kick. Su speaker piccoli (laptop/telefono) è il
        // transiente ad alta frequenza a rendere percepibile il colpo, dato
        // che le basse vengono riprodotte pochissimo. Il rilascio cortissimo
        // evita qualunque carattere "metallico" prolungato.
        window.SoundEngine.triggerNoiseHitAt(
          nextStepIndex,
          nextStepTime,
          ATTACK_CLICK_GAIN,
          0.001,
          0.008
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
  window.SynthModes.sequencer = { activate, deactivate, update };
})();
