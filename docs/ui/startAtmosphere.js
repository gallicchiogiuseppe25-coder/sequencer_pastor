/**
 * ui/startAtmosphere.js
 *
 * Firma visiva della schermata iniziale: un campo di punti che respirano
 * dolcemente, a evocare la nuvola di punti da cui la stampa fisica è stata
 * generata (scansione della parete materica). Puramente atmosferico — nessun
 * ruolo funzionale, nessuna interferenza con la pipeline camera/audio.
 *
 * Si ferma automaticamente quando #startOverlay passa a display:none (i
 * browser sospendono animazioni CSS su elementi non visualizzati), quindi
 * non consuma risorse durante la lettura vera e propria.
 *
 * Rispetta prefers-reduced-motion: se richiesto, i punti restano statici.
 */
(function () {
  'use strict';

  const DOT_COUNT = 46;

  function init(containerEl) {
    if (!containerEl) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    for (let i = 0; i < DOT_COUNT; i++) {
      const dot = document.createElement('div');
      dot.className = 'atmosphere-dot';

      const x = Math.random() * 100;
      const y = Math.random() * 100;
      const size = 1 + Math.random() * 2.5;
      const delay = Math.random() * 6;
      const duration = 4 + Math.random() * 5;

      dot.style.left = x + '%';
      dot.style.top = y + '%';
      dot.style.width = size + 'px';
      dot.style.height = size + 'px';

      if (!reducedMotion) {
        dot.style.animationDelay = delay + 's';
        dot.style.animationDuration = duration + 's';
      } else {
        dot.style.opacity = '0.18';
      }

      containerEl.appendChild(dot);
    }
  }

  window.StartAtmosphere = { init };
})();
