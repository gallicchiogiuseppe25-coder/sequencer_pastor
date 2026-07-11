/**
 * ui/transition.js
 *
 * TRANSIZIONE A PIXEL — coerente col tema dell'opera.
 *
 * Anatomia: una griglia di quadrati arancioni a 18 COLONNE (le stesse 18
 * posizioni della stampa fisica).
 *   Fase 1 (copertura): i quadrati si accendono riga per riga DAL BASSO
 *     VERSO L'ALTO, con un leggero jitter casuale per quadrato — lo schermo
 *     diventa progressivamente arancione, con bordo di avanzamento
 *     "pixelato", non una tendina liscia.
 *   Fase 2 (scambio): a schermo interamente coperto viene invocata la
 *     callback che cambia schermata sotto la copertura.
 *   Fase 3 (dissoluzione): i quadrati si spengono in ordine casuale,
 *     dissolvendosi e rivelando la nuova pagina.
 *
 * Rispetta prefers-reduced-motion: in quel caso lo scambio è immediato,
 * senza animazione.
 *
 * Espone: window.PixelTransition.play(onCovered) -> Promise che si risolve
 * a transizione conclusa. onCovered viene chiamata quando lo schermo è
 * completamente coperto (è il momento di cambiare schermata).
 */

(function () {
  'use strict';

  const COLUMNS = 18; // come le 18 posizioni della stampa

  const COVER_TOTAL_MS = 300;        // durata della salita, FISSA su ogni schermo:
                                      // il ritardo per riga è derivato dal numero di righe
  const COVER_JITTER_MS = 28;        // jitter casuale per quadrato in copertura
  const SQUARE_FADE_IN_MS = 85;
  const HOLD_MS = 60;                // pausa a schermo pieno prima della dissoluzione
  const DISSOLVE_TOTAL_MS = 300;     // durata dello sgretolamento (dal basso verso l'alto)
  const DISSOLVE_JITTER_MS = 45;     // jitter per quadrato: bordo di sgretolamento irregolare
  const SQUARE_FADE_OUT_MS = 150;

  const PIXEL_COLOR = '#EF670A';

  let containerEl = null;
  let isPlaying = false;

  function ensureContainer() {
    if (containerEl) return containerEl;
    containerEl = document.createElement('div');
    containerEl.style.cssText =
      'position:fixed;inset:0;z-index:999;display:none;pointer-events:none;';
    document.body.appendChild(containerEl);
    return containerEl;
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * Esegue la transizione. onCovered viene chiamata a schermo interamente
   * coperto. Ritorna una Promise risolta a transizione finita.
   */
  function play(onCovered) {
    if (isPlaying) {
      // Transizione già in corso: esegui comunque lo scambio, senza doppia animazione.
      if (typeof onCovered === 'function') onCovered();
      return Promise.resolve();
    }

    if (prefersReducedMotion()) {
      if (typeof onCovered === 'function') onCovered();
      return Promise.resolve();
    }

    isPlaying = true;
    const container = ensureContainer();

    // Griglia calcolata sulle dimensioni correnti dello schermo:
    // 18 colonne, righe quante servono per coprire l'altezza con quadrati.
    const cellSize = window.innerWidth / COLUMNS;
    const rows = Math.ceil(window.innerHeight / cellSize);

    container.innerHTML = '';
    container.style.display = 'grid';
    container.style.gridTemplateColumns = `repeat(${COLUMNS}, 1fr)`;
    container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    container.style.pointerEvents = 'all'; // blocca i tap durante la transizione

    const squares = [];
    const rowStaggerMs = rows > 1 ? COVER_TOTAL_MS / (rows - 1) : 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < COLUMNS; col++) {
        const sq = document.createElement('div');
        const rowsFromBottom = rows - 1 - row;
        const coverDelay = rowsFromBottom * rowStaggerMs + Math.random() * COVER_JITTER_MS;
        sq.style.cssText =
          `background:${PIXEL_COLOR};opacity:0;` +
          `transition:opacity ${SQUARE_FADE_IN_MS}ms ease ${coverDelay}ms;`;
        container.appendChild(sq);
        squares.push(sq);
      }
    }

    // Avvia la fase di copertura al frame successivo (le transizioni CSS
    // richiedono che lo stato iniziale sia stato dipinto).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const sq of squares) sq.style.opacity = '1';
      });
    });

    const coverTotalMs = COVER_TOTAL_MS + COVER_JITTER_MS + SQUARE_FADE_IN_MS;

    return new Promise((resolve) => {
      setTimeout(() => {
        // Schermo interamente coperto: scambio di schermata sotto la copertura.
        if (typeof onCovered === 'function') onCovered();

        setTimeout(() => {
          // Dissoluzione A SCORRIMENTO: il muro arancione si sgretola riga
          // per riga DAL BASSO VERSO L'ALTO, continuando il movimento della
          // salita — non un fade casuale uniforme. Il jitter per quadrato
          // mantiene il bordo di sgretolamento "pixelato" e irregolare.
          const dissolveRowStagger = rows > 1 ? DISSOLVE_TOTAL_MS / (rows - 1) : 0;
          squares.forEach((sq, i) => {
            const row = Math.floor(i / COLUMNS);
            const rowsFromBottom = rows - 1 - row;
            const dissolveDelay = rowsFromBottom * dissolveRowStagger + Math.random() * DISSOLVE_JITTER_MS;
            sq.style.transition = `opacity ${SQUARE_FADE_OUT_MS}ms ease ${dissolveDelay}ms`;
            sq.style.opacity = '0';
          });

          setTimeout(() => {
            container.style.display = 'none';
            container.style.pointerEvents = 'none';
            container.innerHTML = '';
            isPlaying = false;
            resolve();
          }, DISSOLVE_TOTAL_MS + DISSOLVE_JITTER_MS + SQUARE_FADE_OUT_MS + 30);
        }, HOLD_MS);
      }, coverTotalMs);
    });
  }

  window.PixelTransition = { play };
})();
