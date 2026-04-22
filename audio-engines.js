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
  // Phase 3.0.c3: organ-preset.value sync via audioCoreConfig.presetDropdown.sync
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.presetDropdown : null;
  if (b && b.sync) b.sync(AudioState.engineKey + ':' + name);
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

// Preset output gain compensate node (urinami 2026-04-22)。
// epianoDirectOut の直後に挿入して、preset ごとの outputGainDb 補正を適用する。
// 存在しなければ遅延作成。EP_AMP_PRESETS[preset].outputGainDb が SSOT。
function _applyPresetOutputGain() {
  if (typeof audioCtx === 'undefined' || typeof EP_AMP_PRESETS === 'undefined') return;
  var inst = AudioState && AudioState.instrument;
  if (!inst || !inst.epiano) return;
  var ampPreset = EP_AMP_PRESETS[inst.epiano];
  if (!ampPreset) return;
  var db = typeof ampPreset.outputGainDb === 'number' ? ampPreset.outputGainDb : 0;
  var linear = Math.pow(10, db / 20);
  // epianoOutputCompensate は audio-master / audio.js などで確保された GainNode
  if (typeof _epOutputCompensate !== 'undefined' && _epOutputCompensate) {
    // setTargetAtTime で滑らか変化 (timeConstant 0.03s) にして click/jitter 防止。
    // setValueAtTime は瞬時切替で signal discontinuity → urinami 2026-04-22 「ジッター」報告の原因。
    // Playwright の .value は収束途中の値を返すが、実音は正しく連続変化する (計測のみの差)。
    _epOutputCompensate.gain.setTargetAtTime(linear, audioCtx.currentTime, 0.03);
  }
}

function _applyPresetEpMixerDefaults() {
  var inst = AudioState.instrument;
  if (!inst || !inst.epMixerDefaults) { _applyPresetOutputGain(); return; }
  if (inst.epMixerDefaults.springReverbMix !== undefined) EpState.springReverbMix = inst.epMixerDefaults.springReverbMix;
  if (inst.epMixerDefaults.springDwell !== undefined) EpState.springDwell = inst.epMixerDefaults.springDwell;
  if (inst.epMixerDefaults.springFeedbackScale !== undefined) EpState.springFeedbackScale = inst.epMixerDefaults.springFeedbackScale;
  if (inst.epMixerDefaults.springStereoEnabled !== undefined) EpState.springStereoEnabled = inst.epMixerDefaults.springStereoEnabled;
  _applyPresetOutputGain();
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
