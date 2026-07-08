/**
 * camera.js
 *
 * Responsabilità:
 * - Richiedere accesso alla camera posteriore (facingMode: 'environment')
 * - Dimensionare il canvas di lavoro in base al viewport e al devicePixelRatio
 * - Fornire un frame-loop throttled (max 30 FPS) a cui gli altri moduli si agganciano
 * - Gestire errori di permesso in modo esplicito
 *
 * Nessuna logica di computer vision qui: questo modulo espone solo frame grezzi.
 *
 * Espone: window.CameraModule
 */

(function () {
  'use strict';

  const TARGET_FPS = 30;
  const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

  // Risoluzione di acquisizione richiesta alla camera.
  // Non serve full-HD: la geometria che cerchiamo è a bassa frequenza spaziale,
  // e una risoluzione più bassa riduce drasticamente il costo di analisi per frame.
  const REQUESTED_CONSTRAINTS = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };

  let videoEl = null;
  let stream = null;
  let isRunning = false;
  let lastFrameTime = 0;
  let rafHandle = null;

  // Callback esterna registrata da main.js: viene invocata ad ogni frame
  // utile (già throttlata), con il videoEl pronto per essere disegnato/letto.
  let onFrameCallback = null;

  /**
   * Richiede l'accesso alla camera. Deve essere chiamato dentro un gesture
   * utente (es. tap su #startButton) per rispettare le autoplay policy iOS.
   * Ritorna una Promise che si risolve quando il video sta effettivamente
   * riproducendo frame (readyState sufficiente).
   */
  async function start(videoElement) {
    if (isRunning) return;

    videoEl = videoElement;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('CAMERA_NOT_SUPPORTED');
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia(REQUESTED_CONSTRAINTS);
    } catch (err) {
      // Distinguiamo i casi più comuni per permettere a main.js di mostrare
      // un messaggio utile invece di un errore generico.
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        throw new Error('CAMERA_PERMISSION_DENIED');
      }
      if (err.name === 'NotFoundError') {
        throw new Error('CAMERA_NOT_FOUND');
      }
      throw new Error('CAMERA_UNKNOWN_ERROR');
    }

    videoEl.srcObject = stream;

    // Necessario esplicitamente su iOS Safari anche con l'attributo HTML playsinline.
    videoEl.setAttribute('playsinline', 'true');
    videoEl.muted = true;

    await videoEl.play();

    // Attende che il video abbia dimensioni reali disponibili (metadata pronti).
    await waitForVideoReady(videoEl);

    isRunning = true;
    lastFrameTime = 0;
    rafHandle = requestAnimationFrame(frameLoop);
  }

  function waitForVideoReady(video) {
    return new Promise((resolve) => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve();
        return;
      }
      const check = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }

  /**
   * Loop principale, ma throttlato: anche se requestAnimationFrame gira a
   * 60fps su molti device, invochiamo la callback di analisi al massimo a
   * TARGET_FPS per contenere il carico CPU della pipeline di vision.
   */
  function frameLoop(timestamp) {
    if (!isRunning) return;

    rafHandle = requestAnimationFrame(frameLoop);

    const elapsed = timestamp - lastFrameTime;
    if (elapsed < FRAME_INTERVAL_MS) return;

    lastFrameTime = timestamp;

    if (typeof onFrameCallback === 'function') {
      onFrameCallback(videoEl, timestamp);
    }
  }

  /**
   * Registra la callback chiamata ad ogni frame utile.
   * Firma: callback(videoElement, timestampMs)
   */
  function onFrame(callback) {
    onFrameCallback = callback;
  }

  /**
   * Ritorna le dimensioni intrinseche correnti del video (utile per dimensionare
   * canvas di analisi off-screen a risoluzione ridotta).
   */
  function getVideoDimensions() {
    if (!videoEl) return { width: 0, height: 0 };
    return {
      width: videoEl.videoWidth,
      height: videoEl.videoHeight,
    };
  }

  function stop() {
    isRunning = false;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
  }

  window.CameraModule = {
    start,
    stop,
    onFrame,
    getVideoDimensions,
  };
})();
