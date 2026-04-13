// ========================================
// AUDIO OVERLAY / FIRST-RUN HINTS
// ========================================
// Split from audio.js (Phase 0.1.f / 2026-04-13). Handles the tap-to-start
// overlay (browser requires a user gesture to unlock AudioContext) and the
// pad/preset hints shown to first-time visitors.
//
// Depends on audio-master.js (audioCtx / _useEpianoWorklet / _soundMuted),
// audio-engines.js (setEngine), audio-reverb.js (epianoDirectOut / masterBus),
// and audio.js (saveSoundSettings / ensureAudioResumed / _updateMuteBtn).
// ========================================

function _showFirstTimeHint() {
  var header = document.getElementById('sound-header');
  if (!header) return;
  var hint = document.createElement('div');
  hint.id = 'sound-first-hint';
  hint.textContent = typeof t === 'function' ? t('ui.sound_hint') : 'Select a preset to enable sound';
  hint.style.cssText = 'font-size:0.65rem;color:#a0a0a0;text-align:center;padding:2px 0;animation:hint-pulse 2s ease-in-out infinite';
  header.parentNode.insertBefore(hint, header);
}

function _hideFirstTimeHint() {
  var hint = document.getElementById('sound-first-hint');
  if (hint) hint.remove();
}

function _showAudioOverlay() {
  var overlay = document.getElementById('audio-start-overlay');
  if (overlay) overlay.classList.add('active');
}

function dismissAudioOverlay() {
  var overlay = document.getElementById('audio-start-overlay');
  if (overlay) overlay.classList.remove('active');
  ensureAudioResumed();
  // Pre-initialize e-piano worklet so first noteOn isn't silent
  if (_useEpianoWorklet && typeof epianoWorkletInit === 'function') {
    var epDest = epianoDirectOut || masterBus;
    epianoWorkletInit(audioCtx, epDest);
  }
  // Auto-select engine if muted (legacy path)
  if (_soundMuted) {
    setEngine('epiano');
    if (typeof soundExpanded !== 'undefined' && !soundExpanded && typeof toggleSoundExpand === 'function') {
      toggleSoundExpand();
    }
  }
  // Persist settings (ensures first-time users get localStorage entry)
  saveSoundSettings();
  // Pad hint only for first-time users (returning users already know)
  if (!localStorage.getItem('64pad-overlay-seen')) {
    localStorage.setItem('64pad-overlay-seen', '1');
    _showPadHint();
  }
}

function _showPadHint() {
  var grid = document.getElementById('pad-grid');
  if (!grid) return;
  // Add pulse animation to pads
  grid.classList.add('pad-hint-pulse');
  // Show floating hint text
  var hint = document.createElement('div');
  hint.id = 'pad-play-hint';
  hint.textContent = typeof t === 'function' ? t('ui.tap_pads') : 'Tap any pad to play!';
  grid.parentNode.insertBefore(hint, grid);
  // Auto-dismiss after 6 seconds if user hasn't tapped
  setTimeout(_hidePadHint, 6000);
}

function _hidePadHint() {
  var hint = document.getElementById('pad-play-hint');
  if (hint) hint.remove();
  var grid = document.getElementById('pad-grid');
  if (grid) grid.classList.remove('pad-hint-pulse');
}
