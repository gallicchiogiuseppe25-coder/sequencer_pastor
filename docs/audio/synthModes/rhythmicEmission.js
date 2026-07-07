/**
 * audio/synthModes/rhythmicEmission.js
 *
 * RHYTHMIC EMISSION
 * pixel attivi -> trigger percussivo | posizione -> stereo field
 *
 * Design:
 * - "Pixel attivo" = intensità (saturazione pesata da luminosità) sopra
 *   soglia. Ma il trigger scatta SOLO sul fronte di salita (transizione
 *   inattivo -> attivo), non ad ogni frame in cui il pixel resta colorato:
 *   altrimenti, dato che una singola riga fisica resta sotto la stessa
 *   posizione dell'inquadratura per più frame consecutivi mentre l'utente
 *   scorre lentamente, si otterrebbe uno sfarfallio innaturale invece di
 *   un evento ritmico discreto. Il carattere percussivo nasce quindi dal
 *   susseguirsi di pixel fisici diversi (colorato/non colorato) che passano
 *   sotto una data posizione orizzontale mentre la stampa scorre.
 * - Il trigger stesso (triggerNoiseHit in SoundEngine) non fa mai
 *   start/stop del nodo sorgente di rumore: è solo un inviluppo di gain su
 *   una voce già persistente, quindi resta coerente con la regola di
 *   continuità assoluta anche per questa modalità "discreta".
 * - Il pan segue la posizione del pixel lungo la riga (sinistra->destra),
 *   come richiesto esplicitamente dalla specifica per questa modalità.
 *
 * Contratto comune a tutte le synth mode: { activate(), deactivate(), update(sampledRow) }
 */

(function () {
  'use strict';

  const NUM_VOICES = window.SoundEngine.NUM_VOICES;

  const ACTIVITY_THRESHOLD = 0.22; // soglia di intensità oltre la quale un pixel è "attivo"
  const HIT_ATTACK_SECONDS = 0.004;
  const HIT_RELEASE_TIME_CONSTANT = 0.09;
  const PEAK_GAIN_MAX = 0.35;

  // Stato per-indice: tiene traccia se il pixel era già attivo al frame
  // precedente, per rilevare il fronte di salita.
  let previousActive = new Array(NUM_VOICES).fill(false);

  function indexToPan(index) {
    return (index / (NUM_VOICES - 1)) * 2 - 1;
  }

  function activate() {
    previousActive.fill(false);
    for (let i = 0; i < NUM_VOICES; i++) {
      window.SoundEngine.setNoiseVoicePan(i, indexToPan(i), 0.001);
    }
  }

  function deactivate() {
    for (let i = 0; i < NUM_VOICES; i++) {
      window.SoundEngine.setNoiseVoiceGain(i, 0);
    }
    previousActive.fill(false);
  }

  function update(sampledRow) {
    if (!sampledRow) return;

    for (const pixel of sampledRow) {
      const { index, saturation, luminosity, confidence } = pixel;

      const intensity = saturation * (0.5 + 0.5 * luminosity);
      const isActive = intensity > ACTIVITY_THRESHOLD;

      window.SoundEngine.setNoiseVoicePan(index, indexToPan(index));

      if (isActive && !previousActive[index]) {
        const peakGain = PEAK_GAIN_MAX * intensity * (0.5 + 0.5 * confidence);
        window.SoundEngine.triggerNoiseHit(
          index,
          peakGain,
          HIT_ATTACK_SECONDS,
          HIT_RELEASE_TIME_CONSTANT
        );
      }

      previousActive[index] = isActive;
    }
  }

  window.SynthModes = window.SynthModes || {};
  window.SynthModes.rhythmicEmission = { activate, deactivate, update };
})();
