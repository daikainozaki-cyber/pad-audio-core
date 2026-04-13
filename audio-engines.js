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
  // Sync TREM implementation (always Vactrol now, kept for consistency)
  var trmSlider = document.getElementById('snd-tremolo');
  if (trmSlider) trmSlider.dispatchEvent(new Event('input'));
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
  var sec = document.getElementById('ep-mixer-section');
  if (!sec) return;
  var isEpiano = !!(AudioState.instrument && AudioState.instrument.epiano);
  sec.style.display = isEpiano ? '' : 'none';
  var epPreset = isEpiano ? EP_AMP_PRESETS[AudioState.instrument.epiano] : null;
  var hasSpring = !!(epPreset && epPreset.useSpringReverb);
  var isSuitcase = !!(epPreset && epPreset.powerampType === 'GeTr');
  // REVERB section: show when preset has spring reverb
  var revSec = document.getElementById('ep-reverb-section');
  if (revSec) revSec.style.display = hasSpring ? '' : 'none';
  // BASS/TREBLE: show for Suitcase (Baxandall EQ)
  var bassLabel = document.getElementById('ep-eq-bass-label');
  var trebleLabel = document.getElementById('ep-eq-treble-label');
  if (bassLabel) bassLabel.style.display = isSuitcase ? '' : 'none';
  if (trebleLabel) trebleLabel.style.display = isSuitcase ? '' : 'none';
}

function _applyPresetEpMixerDefaults() {
  var inst = AudioState.instrument;
  if (!inst || !inst.epMixerDefaults) return;
  if (inst.epMixerDefaults.springReverbMix !== undefined) EpState.springReverbMix = inst.epMixerDefaults.springReverbMix;
  if (inst.epMixerDefaults.springDwell !== undefined) EpState.springDwell = inst.epMixerDefaults.springDwell;
  if (inst.epMixerDefaults.springFeedbackScale !== undefined) EpState.springFeedbackScale = inst.epMixerDefaults.springFeedbackScale;
  if (inst.epMixerDefaults.springStereoEnabled !== undefined) EpState.springStereoEnabled = inst.epMixerDefaults.springStereoEnabled;
  var rev = document.getElementById('ep-rev');
  var revVal = document.getElementById('ep-rev-val');
  var revKnob = EpState.springReverbMix / 1.4 * 9 + 1; // internal → 1-10
  if (rev) rev.value = revKnob;
  if (revVal) revVal.textContent = revKnob.toFixed(1);
  var dwell = document.getElementById('ep-dwell');
  var dwellVal = document.getElementById('ep-dwell-val');
  if (dwell) dwell.value = EpState.springDwell;
  if (dwellVal) dwellVal.textContent = EpState.springDwell.toFixed(1);
  var decay = document.getElementById('ep-decay');
  var decayVal = document.getElementById('ep-decay-val');
  var decayKnob = (EpState.springFeedbackScale - 0.3) / 0.69 * 9 + 1; // internal → 1-10
  if (decay) decay.value = decayKnob;
  if (decayVal) decayVal.textContent = decayKnob.toFixed(1);
  var stereo = document.getElementById('ep-stereo');
  var stereoVal = document.getElementById('ep-stereo-val');
  if (stereo) stereo.checked = !!EpState.springStereoEnabled;
  if (stereoVal) stereoVal.textContent = EpState.springStereoEnabled ? 'ON' : 'OFF';
  if (_useEpianoWorklet && typeof epianoWorkletUpdateParams === 'function') {
    epianoWorkletUpdateParams({
      springReverbMix: EpState.springReverbMix,
      springDwell: EpState.springDwell,
      springFeedbackScale: EpState.springFeedbackScale,
      springStereoEnabled: EpState.springStereoEnabled,
    });
  }
}
