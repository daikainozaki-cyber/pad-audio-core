// ========================================
// AUDIO ENGINES / PRESET CONTROL
// ========================================
// Split from audio.js (Phase 0.1.e / 2026-04-13). Holds:
//   - ENGINES registry (Pad Sensei MK1 DI + Suitcase presets)
//   - AudioState (the single source of truth for "what is currently selected")
//   - setEngine / selectSound / setPreset (user-facing preset switching)
//   - _updateEpMixerVisibility (UI show/hide per preset)
//   - _applyPresetEpMixerDefaults (Spring reverb defaults when selecting a preset)
//
// Depends on audio-master.js (audioCtx / _useEpianoWorklet) and on several
// functions that still live in audio.js and friends: noteOffAll, _updateMuteBtn,
// _hideFirstTimeHint, renderSoundControls, saveSoundSettings, _decodeSamplerZones,
// _ensureWafPlayer, wafPlayer, epianoWorkletUpdateParams, EpState, EP_AMP_PRESETS.
// Those are resolved at call-time via global scope (classic script loading).
// ========================================

// ======== SOUND ENGINES ========
const ENGINES = {
  epiano: {
    name: 'E.PIANO',
    presets: {
      'Rhodes DI':             { epiano: 'Rhodes DI',             label: 'Pad Sensei MK1' },
      'Rhodes Suitcase':       { epiano: 'Rhodes Suitcase',       label: 'Pad Sensei MK1 Suitcase' },
    },
    defaultPreset: 'Rhodes DI',  // internal key unchanged (EP_AMP_PRESETS reference)
  },
};

const AudioState = {
  engineKey: 'epiano',
  engine: ENGINES['epiano'],
  presetKey: 'Rhodes DI',
  instrument: ENGINES['epiano'].presets['Rhodes DI'],
};

function setEngine(key) {
  if (!ENGINES[key]) return;
  if (_soundMuted) { _soundMuted = false; _updateMuteBtn(); }
  _hideFirstTimeHint();
  noteOffAll();
  AudioState.engineKey = key;
  AudioState.engine = ENGINES[key];
  AudioState.presetKey = AudioState.engine.defaultPreset;
  AudioState.instrument = AudioState.engine.presets[AudioState.presetKey];
  Object.values(AudioState.engine.presets).forEach(p => {
    if (p.sampler) {
      _decodeSamplerZones(p.sampler);
    } else if (p.data) {
      if (_ensureWafPlayer()) wafPlayer.loader.decodeAfterLoading(audioCtx, p.data);
    }
  });
  renderSoundControls();
  saveSoundSettings();
  _updateEpMixerVisibility();
}

function selectSound(combinedValue) {
  var parts = combinedValue.split(':');
  var engKey = parts[0], presetKey = parts.slice(1).join(':');
  if (!ENGINES[engKey] || !ENGINES[engKey].presets[presetKey]) return;
  if (_soundMuted) { _soundMuted = false; _updateMuteBtn(); }
  _hideFirstTimeHint();
  noteOffAll();
  if (engKey !== AudioState.engineKey) {
    AudioState.engineKey = engKey;
    AudioState.engine = ENGINES[engKey];
    Object.values(AudioState.engine.presets).forEach(p => {
      if (p.sampler) _decodeSamplerZones(p.sampler);
      else if (p.data && _ensureWafPlayer()) wafPlayer.loader.decodeAfterLoading(audioCtx, p.data);
    });
  }
  AudioState.presetKey = presetKey;
  AudioState.instrument = AudioState.engine.presets[presetKey];
  _applyPresetEpMixerDefaults();
  saveSoundSettings();
  _updateEpMixerVisibility();
  // Phase 3.0.c2: tremolo redispatch via audioCoreConfig.mixer bridge.
  // Sync TREM implementation (always Vactrol now, kept for consistency).
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.mixer : null;
  if (b && b.redispatchTremolo) b.redispatchTremolo();
}

function setPreset(name) {
  if (!AudioState.engine.presets[name]) return;
  AudioState.presetKey = name;
  AudioState.instrument = AudioState.engine.presets[name];
  const sel = document.getElementById('organ-preset');
  if (sel) sel.value = AudioState.engineKey + ':' + name;
  saveSoundSettings();
  _updateEpMixerVisibility();
}

function _updateEpMixerVisibility() {
  // Phase 3.0.c2: state computation stays in audio-core (uses AudioState +
  // EP_AMP_PRESETS internal knowledge). DOM application delegated to
  // audioCoreConfig.mixer.updateVisibility (host owns ep-*-section ids).
  var isEpiano = !!(AudioState.instrument && AudioState.instrument.epiano);
  var epPreset = isEpiano ? EP_AMP_PRESETS[AudioState.instrument.epiano] : null;
  var hasSpring = !!(epPreset && epPreset.useSpringReverb);
  var isSuitcase = !!(epPreset && epPreset.powerampType === 'GeTr');
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.mixer : null;
  if (b && b.updateVisibility) {
    b.updateVisibility({ isEpiano: isEpiano, hasSpring: hasSpring, isSuitcase: isSuitcase });
  }
}

function _applyPresetEpMixerDefaults() {
  var inst = AudioState.instrument;
  if (!inst || !inst.epMixerDefaults) return;
  if (inst.epMixerDefaults.springReverbMix !== undefined) EpState.springReverbMix = inst.epMixerDefaults.springReverbMix;
  if (inst.epMixerDefaults.springDwell !== undefined) EpState.springDwell = inst.epMixerDefaults.springDwell;
  if (inst.epMixerDefaults.springFeedbackScale !== undefined) EpState.springFeedbackScale = inst.epMixerDefaults.springFeedbackScale;
  if (inst.epMixerDefaults.springStereoEnabled !== undefined) EpState.springStereoEnabled = inst.epMixerDefaults.springStereoEnabled;
  // Phase 3.0.c2: knob scaling formulas computed here (internal → 1-10),
  // DOM writes delegated to audioCoreConfig.mixer bridge.
  var revKnob = EpState.springReverbMix / 1.4 * 9 + 1;
  var decayKnob = (EpState.springFeedbackScale - 0.3) / 0.69 * 9 + 1;
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.mixer : null;
  if (b) {
    if (b.syncSliders) b.syncSliders({
      'ep-rev': revKnob,
      'ep-dwell': EpState.springDwell,
      'ep-decay': decayKnob,
      'ep-stereo': EpState.springStereoEnabled
    });
    if (b.syncValueLabels) b.syncValueLabels({
      'ep-rev-val': revKnob.toFixed(1),
      'ep-dwell-val': EpState.springDwell.toFixed(1),
      'ep-decay-val': decayKnob.toFixed(1),
      'ep-stereo-val': EpState.springStereoEnabled ? 'ON' : 'OFF'
    });
  }
  if (_useEpianoWorklet && typeof epianoWorkletUpdateParams === 'function') {
    epianoWorkletUpdateParams({
      springReverbMix: EpState.springReverbMix,
      springDwell: EpState.springDwell,
      springFeedbackScale: EpState.springFeedbackScale,
      springStereoEnabled: EpState.springStereoEnabled,
    });
  }
}
