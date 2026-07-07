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
  const statusLabelEl = document.getElementById('statusLabel');

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

  function stateLabelText(confidenceState, gridResult) {
    const STATES = window.ConfidenceState.STATES;
    // Readout diagnostico per il modello per-cella: confidenza, numero di
    // celle rilevate come colorate (su 18), luminosità del bianco di
    // riferimento stimato (0-100). Se "px" resta a 0 davanti a pixel veri
    // il problema è la classificazione; se "carta" è basso il problema è
    // l'illuminazione o l'inquadratura.
    const coloredCount = gridResult.allBlobs ? gridResult.allBlobs.length : 0;
    const paperPct = Math.round((gridResult.whiteReference || 0) * 100);
    const readout = ` (conf ${gridResult.smoothedConfidence.toFixed(2)} · px ${coloredCount}/18 · carta ${paperPct})`;
    const modePrefix = currentModeName ? `[${currentModeName}] ` : '';

    if (confidenceState === STATES.SEARCHING) return modePrefix + 'ricerca griglia…' + readout;
    if (confidenceState === STATES.LOST) return modePrefix + 'riga persa, in attesa…' + readout;
    return modePrefix + 'agganciato — lettura in corso' + readout;
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

    if (sampledRow && currentMode) {
      currentMode.update(sampledRow);
    }

    // Il gain master segue sempre l'activityLevel continuo, indipendentemente
    // da quale ramo sopra è stato eseguito: è questo (non uno stop/start di
    // sampledRow) a garantire i fade morbidi richiesti dal sound design.
    window.SoundEngine.setMasterActivityLevel(confidenceResult.activityLevel);

    window.Overlay.render({
      videoEl: videoElement,
      gridResult,
      pixelDetectorResult,
    });

    window.Overlay.updateStatusLabel(
      stateLabelText(confidenceResult.state, gridResult)
    );
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

      window.Overlay.init(canvasEl, statusLabelEl);
      resetPipelineState();
      activateMode(resolveActiveSynthMode());

      window.CameraModule.onFrame(onFrame);

      startOverlayEl.style.display = 'none';
    } catch (err) {
      started = false;
      startButtonEl.disabled = false;
      startButtonEl.textContent = 'Riprova';
      showStartError(err);
    }
  }

  startButtonEl.addEventListener('click', handleStart);
})();
