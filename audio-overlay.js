// ========================================
// AUDIO OVERLAY / FIRST-RUN HINTS
// ========================================
// Split from audio.js (Phase 0.1.f / 2026-04-13). Handles the tap-to-start
// overlay (browser requires a user gesture to unlock AudioContext) and the
// pad/preset hints shown to first-time visitors.
//
// Phase 3.0.e (2026-04-15): all DOM/i18n/first-run-localStorage ops moved
// to host via audioCoreConfig.overlay bridge. audio-core retains only
// the audio-related orchestration (worklet init, setEngine, persistence).
// If host doesn't provide overlay bridge or sets enabled=false, all
// hint/overlay UI is silently no-op.
// ========================================

function _overlayBridge() {
  return (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.overlay : null;
}

function _showFirstTimeHint() {
  var b = _overlayBridge();
  if (b && b.enabled !== false && b.showFirstTimeHint) b.showFirstTimeHint();
}

function _hideFirstTimeHint() {
  var b = _overlayBridge();
  if (b && b.enabled !== false && b.hideFirstTimeHint) b.hideFirstTimeHint();
}

function _showAudioOverlay() {
  var b = _overlayBridge();
  if (b && b.enabled !== false && b.showAudioOverlay) b.showAudioOverlay();
}

function dismissAudioOverlay() {
  var b = _overlayBridge();
  // Hide overlay DOM + check first-run via bridge (returns {firstTime: bool})
  var dismissResult = (b && b.enabled !== false && b.dismissOverlay)
    ? b.dismissOverlay() : { firstTime: false };

  ensureAudioResumed();
  // Pre-initialize e-piano worklet so first noteOn isn't silent
  if (_useEpianoWorklet && typeof epianoWorkletInit === 'function') {
    var epDest = epianoDirectOut || masterBus;
    epianoWorkletInit(audioCtx, epDest);
    // 2026-04-27 urinami: 永続化された reverbType / tonestackBass / tonestackTreble
    // を worklet init 直後に再送 (Codex 監査 P2 fix: _loadEpMixer は worklet
    // init 前に走るため、その時点の epianoWorkletUpdateParams は no-op)。
    if (typeof EpState !== 'undefined' && typeof epianoWorkletUpdateParams === 'function') {
      var msg = {};
      if (EpState.reverbType !== undefined) {
        msg.useSpringReverb = (EpState.reverbType === 'spring');
      }
      if (EpState.tonestackBass !== undefined)   msg.tonestackBass = EpState.tonestackBass;
      if (EpState.tonestackTreble !== undefined) msg.tonestackTreble = EpState.tonestackTreble;
      if (Object.keys(msg).length > 0) {
        epianoWorkletUpdateParams(msg);
      }
    }
  }
  // Auto-select engine if muted (legacy path)
  if (_soundMuted) {
    setEngine('epiano');
    if (b && b.onMutedAutoSelect) b.onMutedAutoSelect();
  }
  // Persist settings (ensures first-time users get localStorage entry)
  saveSoundSettings();
  // Pad hint only for first-time users (returning users already know)
  if (dismissResult && dismissResult.firstTime) {
    _showPadHint();
  }
}

function _showPadHint() {
  var b = _overlayBridge();
  if (b && b.enabled !== false && b.showPadHint) b.showPadHint();
}

function _hidePadHint() {
  var b = _overlayBridge();
  if (b && b.enabled !== false && b.hidePadHint) b.hidePadHint();
}
