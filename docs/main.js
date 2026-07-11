/**
 * main.js
 *
 * Orchestratore dell'intera applicazione. Responsabilità:
 * - Avviare camera e AudioContext nello STESSO gesture utente (tap su
 *   #startButton): requisito non negoziabile per le autoplay policy di
 *   iOS Safari / Android Chrome
 * - Collegare il frame-loop di CameraModule alla pipeline completa:
 *   GridDetector -> ConfidenceState -> PixelDetector ->
 *   ColorExtractor -> PixelSampler -> synth mode attiva -> SoundEngine
 * - Gestire il cambio (se mai richiesto in futuro) tra le 4 synth mode
 *   tramite un'unica costante di configurazione, senza controlli UI
 *   runtime (per rispettare il vincolo "nessun pulsante, attivazione
 *   automatica" della specifica)
 * - Aggiornare l'overlay visivo e l'etichetta di stato ad ogni frame
 * - Gestire gli errori di permesso/avvio in modo esplicito e leggibile
 */

(function () {
  'use strict';

  // Modalità sonora attiva di default. Non esiste un controllo UI visibile
  // nell'esperienza finale (in linea con "nessun pulsante, attivazione
  // automatica"), ma durante lo sviluppo puoi scegliere la modalità anche
  // tramite l'URL, per confrontarle a caldo senza modificare il codice:
  //   index.html?mode=harmonicField
  //   index.html?mode=spectralTranslation
  //   index.html?mode=rhythmicEmission
  //   index.html?mode=colorSynthesis
  //   index.html?mode=lightShadow
  //   index.html?mode=sequencer
  const DEFAULT_SYNTH_MODE = 'sequencer';

  function resolveActiveSynthMode() {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('mode');
    if (requested && window.SynthModes[requested]) return requested;
    if (requested) {
      console.warn('Modalità richiesta via URL sconosciuta, uso il default:', requested);
    }
    return DEFAULT_SYNTH_MODE;
  }

  const videoEl = document.getElementById('cameraVideo');
  const canvasEl = document.getElementById('viewCanvas');
  const startOverlayEl = document.getElementById('startOverlay');
  const startButtonEl = document.getElementById('startButton');
  const startMessageEl = document.getElementById('startError');
  

  let currentMode = null;
  let currentModeName = null;
  let started = false;

  function activateMode(modeName) {
    const mode = window.SynthModes[modeName];
    if (!mode) {
      console.error('Modalità sonora sconosciuta:', modeName);
      return;
    }
    if (currentMode && currentMode.deactivate) currentMode.deactivate();
    currentMode = mode;
    currentModeName = modeName;
    if (currentMode.activate) currentMode.activate();
  }

  /**
   * Pipeline eseguita ad ogni frame utile fornito da CameraModule
   * (già throttlato a un massimo di 30 FPS).
   * NOTA: RowTracker non è più nel flusso — con la finestra di lettura fissa
   * la geometria è nota a priori e non c'è nessuna "riga da inseguire":
   * gridResult.bestRowBand è già la lettura corrente della finestra.
   */
  function onFrame(videoElement, timestamp) {
    const gridResult = window.GridDetector.analyzeFrame(videoElement);
    const confidenceResult = window.ConfidenceState.update(gridResult.smoothedConfidence, timestamp);

    let pixelDetectorResult = null;
    let sampledRow = null;

    // Le celle si costruiscono anche SENZA celle colorate: una riga tutta
    // bianca è "luce" e deve legittimamente suonare come silenzio ritmico
    // (nessuna battuta), non interrompere la lettura.
    if (confidenceResult.state !== window.ConfidenceState.STATES.SEARCHING && gridResult.imageData) {
      pixelDetectorResult = window.PixelDetector.buildCells(
        gridResult.bestRowBand,
        gridResult.analysisWidth,
        gridResult.analysisHeight
      );

      if (pixelDetectorResult) {
        const rawColors = window.ColorExtractor.extractRowColors(
          gridResult.imageData,
          gridResult.analysisWidth,
          gridResult.analysisHeight,
          pixelDetectorResult
        );
        sampledRow = window.PixelSampler.sampleRow(rawColors);
      }
    }

    if (sampledRow && currentMode && confidenceResult.state === window.ConfidenceState.STATES.LOCKED) {
      // Il pattern sonoro si aggiorna SOLO in stato LOCKED: in LOST i dati
      // sono transitori e inaffidabili (mano che passa, finestra fuori dalla
      // stampa) e non devono entrare nel ritmo.
      currentMode.update(sampledRow);
    }

    // Il gain master segue sempre l'activityLevel continuo, indipendentemente
    // da quale ramo sopra è stato eseguito: è questo (non uno stop/start di
    // sampledRow) a garantire i fade morbidi richiesti dal sound design.
    window.SoundEngine.setMasterActivityLevel(confidenceResult.activityLevel);

    // Playhead del sequencer: visibile solo mentre la lettura è attiva, e
    // SOLO quando lo step corrente cade su una cella con un pixel rilevato —
    // come le luci di una drum machine, che lampeggiano solo dove c'è un
    // colpo. Sulle celle vuote (silenzio) il cursore resta invisibile.
    const readingActive =
      confidenceResult.state !== window.ConfidenceState.STATES.SEARCHING && sampledRow !== null;
    let playheadStep = -1;
    if (readingActive && currentMode && typeof currentMode.getCurrentStep === 'function') {
      const step = currentMode.getCurrentStep();
      const stepCell =
        step >= 0 && pixelDetectorResult && pixelDetectorResult.cells[step]
          ? pixelDetectorResult.cells[step]
          : null;
      if (stepCell && stepCell.hasDirectBlobMatch) {
        playheadStep = step;
      }
    }

    window.Overlay.render({
      videoEl: videoElement,
      gridResult,
      pixelDetectorResult,
      playheadStep,
      // Strategia C: gli indicatori di rilevamento (pallini, segmenti)
      // appaiono SOLO quando il sistema è agganciato — mai in ricerca,
      // dove darebbero l'impressione ingannevole di una lettura in corso.
      showDetection: confidenceResult.state === window.ConfidenceState.STATES.LOCKED,
    });
  }

  function resetPipelineState() {
    window.GridDetector.reset();
    window.ConfidenceState.reset();

    window.PixelSampler.reset();
  }

  const ERROR_MESSAGES = {
    CAMERA_PERMISSION_DENIED:
      "Permesso camera negato. Abilita l'accesso alla camera nelle impostazioni del browser e riprova.",
    CAMERA_NOT_FOUND: 'Nessuna camera trovata su questo dispositivo.',
    CAMERA_NOT_SUPPORTED: "Questo browser non supporta l'accesso alla camera richiesto.",
    CAMERA_UNKNOWN_ERROR: "Errore nell'avvio della camera. Riprova.",
  };

  function showStartError(err) {
    const key = (err && err.message) || 'CAMERA_UNKNOWN_ERROR';
    if (startMessageEl) {
      startMessageEl.textContent = ERROR_MESSAGES[key] || ERROR_MESSAGES.CAMERA_UNKNOWN_ERROR;
    }
  }

  // --- UI della pagina di lettura -------------------------------------------

  const readingCloseButtonEl = document.getElementById('readingCloseButton');
  const instructionsBoxEl = document.getElementById('instructionsBox');
  const instructionsButtonEl = document.getElementById('instructionsButton');
  const instructionsCloseButtonEl = document.getElementById('instructionsCloseButton');

  // Wake Lock: durante la lettura (che su 5 metri di fascia dura minuti,
  // senza mai toccare lo schermo) impedisce al telefono di andare in
  // standby. API non ovunque disponibile: fallback silenzioso.
  let wakeLock = null;

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) { /* non critico */ }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // iOS/Android rilasciano il wake lock quando la pagina va in background:
  // al ritorno, se la lettura è ancora attiva, va richiesto di nuovo.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && started) acquireWakeLock();
  });

  function enterReadingUI() {
    readingCloseButtonEl.hidden = false;
    instructionsButtonEl.hidden = false;
    // Il box istruzioni si apre automaticamente all'ingresso in lettura
    // (nessuna animazione di transizione: appare e basta, come richiesto).
    instructionsBoxEl.hidden = false;
  }

  function exitReadingUI() {
    readingCloseButtonEl.hidden = true;
    instructionsButtonEl.hidden = true;
    instructionsBoxEl.hidden = true;
  }

  async function handleStart() {
    if (started) return;
    started = true;
    startButtonEl.disabled = true;
    startButtonEl.textContent = 'Avvio…';

    try {
      // ORDINE CRITICO: SoundEngine.init() viene chiamato per primo e in
      // modo sincrono, nello stesso gesture del tap, prima di qualunque
      // `await`. È il requisito che permette all'AudioContext di partire
      // correttamente su iOS Safari (che nega silenziosamente l'audio se
      // creato/ripreso fuori da un gesture diretto).
      const audioContext = window.SoundEngine.init();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      await window.CameraModule.start(videoEl);

      window.Overlay.init(canvasEl, null);
      resetPipelineState();
      activateMode(resolveActiveSynthMode());

      window.CameraModule.onFrame(onFrame);
      acquireWakeLock();

      // Transizione a pixel verso la lettura. Parte solo ORA, a camera già
      // avviata: se fosse partita prima, avrebbe coperto il dialog di
      // sistema dei permessi camera. Lo scambio (nascondere la home)
      // avviene sotto la copertura arancione.
      await window.PixelTransition.play(() => {
        startOverlayEl.style.display = 'none';
        enterReadingUI();
      });

      startButtonEl.disabled = false;
      startButtonEl.textContent = 'Inizia la lettura';
    } catch (err) {
      started = false;
      startButtonEl.disabled = false;
      startButtonEl.textContent = 'Riprova';
      showStartError(err);
    }
  }

  /**
   * Chiude la lettura e torna alla home. Tutto è riavviabile: un nuovo tap
   * su "Inizia la lettura" ripercorre handleStart (l'AudioContext resta
   * inizializzato, la camera viene riacquisita da zero).
   */
  function handleReadingClose() {
    if (!started) return;
    window.PixelTransition.play(() => {
      window.CameraModule.stop();
      if (currentMode && currentMode.deactivate) currentMode.deactivate();
      window.SoundEngine.setMasterActivityLevel(0);
      releaseWakeLock();
      exitReadingUI();
      startOverlayEl.style.display = '';
      started = false;
    });
  }

  startButtonEl.addEventListener('click', handleStart);
  readingCloseButtonEl.addEventListener('click', handleReadingClose);

  // Apertura/chiusura del box istruzioni: nessuna animazione di transizione,
  // semplice mostra/nascondi, come da specifica.
  instructionsButtonEl.addEventListener('click', () => {
    instructionsBoxEl.hidden = false;
  });
  instructionsCloseButtonEl.addEventListener('click', () => {
    instructionsBoxEl.hidden = true;
  });

  // --- Schermata "cenni teorici" -------------------------------------------
  // Puro toggle di visibilità: nessuna interazione con camera/audio, la
  // schermata si sovrappone alla home e si chiude tornando esattamente lì.
  const theoryButtonEl = document.getElementById('theoryButton');
  const theoryOverlayEl = document.getElementById('theoryOverlay');
  const theoryBackButtonEl = document.getElementById('theoryBackButton');

  if (theoryButtonEl && theoryOverlayEl && theoryBackButtonEl) {
    theoryButtonEl.addEventListener('click', () => {
      window.PixelTransition.play(() => {
        theoryOverlayEl.classList.add('visible');
      });
    });
    theoryBackButtonEl.addEventListener('click', () => {
      window.PixelTransition.play(() => {
        theoryOverlayEl.classList.remove('visible');
      });
    });
  }
})();
