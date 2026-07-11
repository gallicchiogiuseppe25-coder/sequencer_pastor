/**
 * state/confidenceState.js
 *
 * Responsabilità:
 * - Trasformare la confidenza smussata prodotta da GridDetector (0..1 continuo,
 *   rumoroso frame-per-frame) in una decisione discreta e STABILE di stato
 *   applicativo: SEARCHING -> LOCKED -> LOST -> (torna LOCKED oppure SEARCHING)
 * - Applicare isteresi: la soglia per agganciarsi (LOCK) è più alta di quella
 *   per considerarsi "persi" (LOST), così il sistema non oscilla freneticamente
 *   attorno a un valore di confidenza borderline
 * - Richiedere N frame consecutivi sopra soglia prima di dichiarare LOCKED,
 *   per evitare falsi agganci su un singolo frame fortunato
 * - Tollerare perdite momentanee (mano che copre, riflesso) con una finestra
 *   di grazia prima di considerarle una perdita vera
 * - Esporre un "activityLevel" continuo (0..1), NON binario, che rampa
 *   morbidamente verso il target: è questo (non lo stato discreto) che
 *   soundEngine.js userà per i fade, garantendo continuità assoluta del suono
 *
 * Espone: window.ConfidenceState
 */

(function () {
  'use strict';

  const STATES = {
    SEARCHING: 'SEARCHING',
    LOCKED: 'LOCKED',
    LOST: 'LOST',
  };

  // --- Soglie con isteresi -------------------------------------------------

  const LOCK_THRESHOLD = 0.45;              // soglia per agganciarsi
  const LOCK_REQUIRED_CONSECUTIVE_FRAMES = 6; // stabilità richiesta prima del lock

  const LOST_THRESHOLD = 0.24;              // soglia per considerarsi persi (bassa, isteresi)
  const LOST_GRACE_MS = 900;                // tolleranza prima di dichiarare LOST: assorbe
                                             // cali momentanei da riflessi/flicker di schermi

  const SEARCHING_TIMEOUT_MS = 3000;        // dopo quanto tempo in LOST si torna a SEARCHING

  // --- Rampa dell'activityLevel (per fade audio morbidi) -------------------

  const ACTIVITY_RAMP_UP_PER_SEC = 2.0;     // velocità di salita verso 1 (LOCKED)
  const ACTIVITY_RAMP_DOWN_PER_SEC = 1.0;   // velocità di discesa verso 0 (SEARCHING)
  const LOST_RESIDUAL_ACTIVITY = 0.15;      // in LOST non si scende a zero di scatto:
                                             // un residuo basso permette al soundEngine
                                             // di fare un fade percepibile invece di un taglio

  // --- Stato interno --------------------------------------------------------

  let state = STATES.SEARCHING;
  let consecutiveHighConfidenceFrames = 0;
  let lowConfidenceSinceTimestamp = null;
  let lostSinceTimestamp = null;
  let lastTimestamp = null;
  let activityLevel = 0;

  function reset() {
    state = STATES.SEARCHING;
    consecutiveHighConfidenceFrames = 0;
    lowConfidenceSinceTimestamp = null;
    lostSinceTimestamp = null;
    lastTimestamp = null;
    activityLevel = 0;
  }

  /**
   * Da chiamare una volta per frame con la smoothedConfidence prodotta da
   * GridDetector.analyzeFrame(). Ritorna lo stato aggiornato.
   */
  function update(smoothedConfidence, timestamp) {
    const ts = timestamp || performance.now();
    const dt = lastTimestamp !== null ? (ts - lastTimestamp) / 1000 : 0;
    lastTimestamp = ts;

    switch (state) {
      case STATES.SEARCHING: {
        if (smoothedConfidence >= LOCK_THRESHOLD) {
          consecutiveHighConfidenceFrames++;
          if (consecutiveHighConfidenceFrames >= LOCK_REQUIRED_CONSECUTIVE_FRAMES) {
            state = STATES.LOCKED;
            consecutiveHighConfidenceFrames = 0;
            lowConfidenceSinceTimestamp = null;
          }
        } else {
          consecutiveHighConfidenceFrames = 0;
        }
        break;
      }

      case STATES.LOCKED: {
        if (smoothedConfidence < LOST_THRESHOLD) {
          if (lowConfidenceSinceTimestamp === null) {
            lowConfidenceSinceTimestamp = ts;
          } else if (ts - lowConfidenceSinceTimestamp >= LOST_GRACE_MS) {
            state = STATES.LOST;
            lostSinceTimestamp = ts;
          }
        } else {
          // Confidenza recuperata prima della finestra di grazia: non era una perdita reale.
          lowConfidenceSinceTimestamp = null;
        }
        break;
      }

      case STATES.LOST: {
        if (smoothedConfidence >= LOCK_THRESHOLD) {
          state = STATES.LOCKED;
          lostSinceTimestamp = null;
          lowConfidenceSinceTimestamp = null;
        } else if (
          lostSinceTimestamp !== null &&
          ts - lostSinceTimestamp >= SEARCHING_TIMEOUT_MS
        ) {
          // Persa per troppo tempo: reset completo, si ricomincia da capo.
          state = STATES.SEARCHING;
          consecutiveHighConfidenceFrames = 0;
          lostSinceTimestamp = null;
        }
        break;
      }
    }

    // --- Rampa dell'activityLevel verso il target dello stato corrente ---

    const targetActivity =
      state === STATES.LOCKED ? 1 : state === STATES.LOST ? LOST_RESIDUAL_ACTIVITY : 0;

    const rampRate =
      targetActivity > activityLevel ? ACTIVITY_RAMP_UP_PER_SEC : ACTIVITY_RAMP_DOWN_PER_SEC;
    const maxDelta = rampRate * dt;

    if (Math.abs(targetActivity - activityLevel) <= maxDelta || dt === 0) {
      activityLevel = dt === 0 ? activityLevel : targetActivity;
    } else {
      activityLevel += Math.sign(targetActivity - activityLevel) * maxDelta;
    }

    return {
      state,
      activityLevel,
      smoothedConfidence,
    };
  }

  function getState() {
    return state;
  }

  function getActivityLevel() {
    return activityLevel;
  }

  window.ConfidenceState = {
    STATES,
    update,
    reset,
    getState,
    getActivityLevel,
  };
})();
