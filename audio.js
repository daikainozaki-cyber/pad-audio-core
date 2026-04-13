// ========================================
// AUDIO ENGINE
// ========================================
// Master graph (audioCtx / masterBus / masterGain / tremoloNode) lives in
// audio-master.js. Effect chain (Auto Filter / Phaser / Flanger / Lo-Cut /
// Hi-Cut) lives in audio-effects.js. E-piano routing (direct/amp out,
// plate reverb, drive waveshaper, tremolo LFO) lives in audio-reverb.js.
// This file assumes those globals are already defined.
// ========================================

let _audioDecoded = false;
function ensureAudioResumed() {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  // Decode SoundFont samples after AudioContext is running
  if (!_audioDecoded) {
    _audioDecoded = true;
    // Decode ALL engines' presets upfront to avoid delay on switch
    Object.values(ENGINES).forEach(eng => {
      Object.values(eng.presets).forEach(inst => {
        if (inst.sampler) {
          _decodeSamplerZones(inst.sampler);
        } else if (inst.data) {
          if (_ensureWafPlayer()) wafPlayer.loader.decodeAfterLoading(audioCtx, inst.data);
        }
      });
    });
    // Pre-initialize e-piano worklet so first noteOn plays immediately
    if (_useEpianoWorklet && typeof epianoWorkletInit === 'function') {
      epianoWorkletInit(audioCtx, epianoDirectOut || masterBus);
    }
  }
}
document.addEventListener('mousedown', ensureAudioResumed, { once: true });
document.addEventListener('touchstart', ensureAudioResumed, { once: true });

function getAudioCtx() { ensureAudioResumed(); return audioCtx; }

// --- WebAudioFont player (lazy — may not be loaded yet if CDN async) ---
var wafPlayer = (typeof WebAudioFontPlayer !== 'undefined') ? new WebAudioFontPlayer() : null;
function _ensureWafPlayer() {
  if (!wafPlayer && typeof WebAudioFontPlayer !== 'undefined') wafPlayer = new WebAudioFontPlayer();
  return wafPlayer;
}

// Sampler engine (velocity-layer-aware) lives in audio-sampler.js.

// ENGINES registry + AudioState + preset control (setEngine / selectSound /
// setPreset / _updateEpMixerVisibility / _applyPresetEpMixerDefaults) now
// live in audio-engines.js (Phase 0.1.e).

// 2026-04-07: jRhodes3c sampler REMOVED.
// Physical model (Pad Sensei MK1) surpassed sampler — urinami-san confirmed.
// Saves 35MB lazy-load. Sampler engine code moved to audio-sampler.js
// (Phase 0.1.d, 2026-04-13) for MRC / PAD DAW reuse.

// Voice management (noteOn/Off, saturation, mute UI, velocity curve,
// held-note tracking, playMidiNotes) moved to audio-voice.js (Phase 0.1.g).
// localStorage save/load + renderSoundControls moved to audio-persistence.js
// First-run hints + audio overlay moved to audio-overlay.js (Phase 0.1.f).
