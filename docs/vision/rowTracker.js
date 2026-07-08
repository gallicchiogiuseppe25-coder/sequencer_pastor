/**
 * vision/rowTracker.js
 *
 * Responsabilità:
 * - Ricevere ad ogni frame il bestRowBand candidato da GridDetector
 * - Mantenere una "riga tracciata" stabile nel tempo, invece di seguire
 *   ciecamente ogni nuova detection frame-per-frame (che è rumorosa)
 * - Stimare la velocità di spostamento verticale della banda riconosciuta
 *   e usarla per predire dove dovrebbe trovarsi al frame successivo
 * - Rifiutare (o richiedere conferma multi-frame per) salti che non sono
 *   coerenti con la velocità stimata, distinguendo jitter di detection da
 *   un reale cambio di riga
 * - Fare da "memoria a breve termine": se per pochi frame consecutivi non
 *   arriva nessuna detection valida (mano che copre, riflesso, motion blur
 *   estremo), continuare a esporre l'ultima riga nota invece di azzerare
 *   tutto, cosa che nel motore audio si tradurrebbe in un click
 * - Esporre uno stato di tracking (TRACKING / TRACKING_LOST) distinto e
 *   complementare a quello di ConfidenceState (che riguarda il lock iniziale
 *   sull'intera griglia, non la continuità della singola riga)
 *
 * Espone: window.RowTracker
 */

(function () {
  'use strict';

  // Quanti frame senza detection valida prima di considerare la riga "persa"
  // a livello di tracking (ma continuiamo comunque a esporre l'ultimo dato
  // noto per la finestra di grazia sottostante).
  const FALLBACK_GRACE_FRAMES = 5;

  // Oltre questo numero di frame senza detection valida, lo stato passa a
  // TRACKING_LOST esplicitamente (il chiamante può decidere di far sfumare
  // l'audio invece di continuare a suonare dati vecchi indefinitamente).
  const TRACKING_LOST_AFTER_FRAMES = 15;

  // Tolleranza per accettare una nuova detection come continuazione della
  // riga tracciata, espressa come multiplo dell'altezza media dei blob.
  const JUMP_TOLERANCE_FACTOR = 1.8;

  // Se una detection cade fuori tolleranza, richiediamo che si ripeta in
  // posizione coerente per N frame consecutivi prima di accettarla come
  // "nuova riga reale" (evita di inseguire un singolo falso positivo).
  const CONFIRMATION_FRAMES_FOR_JUMP = 4;
  const PENDING_POSITION_TOLERANCE_FACTOR = 0.6;

  const VELOCITY_EMA_ALPHA = 0.35;

  const STATUS = {
    TRACKING: 'TRACKING',
    TRACKING_LOST: 'TRACKING_LOST',
  };

  // --- Stato interno ---------------------------------------------------

  let trackedBand = null;       // ultima riga accettata (con blobs, yCenter, ecc.)
  let velocityYPerSec = 0;      // stima di velocità verticale della banda nel frame
  let lastAcceptedTimestamp = null;

  let framesSinceGoodDetection = 0;

  let pendingCandidate = null;  // candidato in attesa di conferma per un salto
  let pendingConfirmCount = 0;

  function reset() {
    trackedBand = null;
    velocityYPerSec = 0;
    lastAcceptedTimestamp = null;
    framesSinceGoodDetection = 0;
    pendingCandidate = null;
    pendingConfirmCount = 0;
  }

  function averageBlobHeight(band) {
    const heights = band.blobs.map((b) => b.height);
    return heights.reduce((s, h) => s + h, 0) / heights.length;
  }

  /**
   * Da chiamare una volta per frame con l'output di GridDetector.analyzeFrame().
   * Ritorna { row, status, framesSinceGoodDetection }, dove `row` è la banda
   * più affidabile disponibile in questo momento (tracciata o di fallback),
   * oppure null se non è mai stata vista alcuna riga.
   */
  function update(gridResult, timestamp) {
    const ts = timestamp || performance.now();
    const candidate = gridResult.bestRowBand;

    if (!candidate) {
      framesSinceGoodDetection++;
      return buildOutput();
    }

    if (!trackedBand) {
      // Bootstrap: prima riga mai vista, accettiamo direttamente.
      acceptCandidate(candidate, ts);
      return buildOutput();
    }

    const dt = lastAcceptedTimestamp !== null ? (ts - lastAcceptedTimestamp) / 1000 : 0;
    const predictedY = trackedBand.yCenter + velocityYPerSec * dt;
    const deviation = Math.abs(candidate.yCenter - predictedY);

    const avgHeight = averageBlobHeight(candidate);
    const tolerance = avgHeight * JUMP_TOLERANCE_FACTOR;

    if (deviation <= tolerance) {
      // Coerente con la traiettoria attesa: accettiamo come continuazione naturale.
      acceptCandidate(candidate, ts);
      pendingCandidate = null;
      pendingConfirmCount = 0;
    } else {
      // Possibile salto: non accettiamo subito, verifichiamo che si ripeta
      // in posizione coerente per qualche frame prima di considerarlo reale.
      const pendingTolerance = avgHeight * PENDING_POSITION_TOLERANCE_FACTOR;

      if (pendingCandidate && Math.abs(candidate.yCenter - pendingCandidate.yCenter) <= pendingTolerance) {
        pendingConfirmCount++;
      } else {
        pendingCandidate = candidate;
        pendingConfirmCount = 1;
      }

      if (pendingConfirmCount >= CONFIRMATION_FRAMES_FOR_JUMP) {
        // Confermato: è un vero cambio di riga (es. l'utente ha scorso
        // rapidamente lungo la stampa). Accettiamo e resettiamo la velocità
        // stimata, perché il salto rompe la continuità della predizione.
        acceptCandidate(candidate, ts);
        velocityYPerSec = 0;
        pendingCandidate = null;
        pendingConfirmCount = 0;
      } else {
        // Non ancora confermato: continuiamo a considerare "buona" la
        // detection di questo frame (non è rumore casuale, è una banda
        // valida secondo GridDetector) ma non sostituiamo trackedBand.
        framesSinceGoodDetection++;
      }
    }

    return buildOutput();
  }

  function acceptCandidate(candidate, ts) {
    if (trackedBand && lastAcceptedTimestamp !== null) {
      const dt = (ts - lastAcceptedTimestamp) / 1000;
      if (dt > 0) {
        const instantVelocity = (candidate.yCenter - trackedBand.yCenter) / dt;
        velocityYPerSec =
          velocityYPerSec * (1 - VELOCITY_EMA_ALPHA) + instantVelocity * VELOCITY_EMA_ALPHA;
      }
    }

    trackedBand = candidate;
    lastAcceptedTimestamp = ts;
    framesSinceGoodDetection = 0;
  }

  function buildOutput() {
    const status =
      framesSinceGoodDetection >= TRACKING_LOST_AFTER_FRAMES
        ? STATUS.TRACKING_LOST
        : STATUS.TRACKING;

    // Esponiamo sempre l'ultima riga nota (trackedBand), anche oltre la
    // finestra di grazia: è `status` a segnalare l'affidabilità del dato.
    // Sarà soundEngine.js, tramite ConfidenceState.activityLevel, a decidere
    // quanto far sfumare l'audio quando lo status è TRACKING_LOST — qui non
    // azzeriamo mai bruscamente il dato esposto.
    return {
      row: trackedBand,
      status,
      framesSinceGoodDetection,
      isUsingFallback: framesSinceGoodDetection > 0,
    };
  }

  window.RowTracker = {
    STATUS,
    update,
    reset,
  };
})();
