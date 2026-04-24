// ========================================
// AUDIO PERSISTENCE (localStorage save/load)
// ========================================
// Split from audio.js (Phase 0.1.f / 2026-04-13). Handles persistence of:
//   - ep-mixer parameters ('64pad-ep-mixer-v2'): Spring reverb, mechanical noise
//   - general sound settings ('64pad-sound'): engine/preset, effect sliders,
//     toggles, mute state
//   - rendering of the preset dropdown (honours the ?hps HPS gate)
//
// Depends on audio-master.js (_soundMuted / _useEpianoWorklet / audioCtx),
// audio-effects.js (autoFilter* / autoFilter2), audio-engines.js
// (ENGINES / AudioState / setEngine / setPreset), epiano-engine.js
// (EP_AMP_PRESETS / EpState), and audio.js (_updateMuteBtn).
// ========================================

function _saveEpMixer() {
  // Phase 3.0.d: localStorage I/O delegated to audioCoreConfig.persistence.saveEpMixer
  var p = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.persistence : null;
  if (!p || !p.saveEpMixer) return;
  p.saveEpMixer({
    pickupSymmetry: EpState.pickupSymmetry,
    springReverbMix: EpState.springReverbMix,
    springDwell: EpState.springDwell,
    springFeedbackScale: EpState.springFeedbackScale,
    springStereoEnabled: EpState.springStereoEnabled,
    attackNoise: EpState.attackNoise,
  });
}

function _loadEpMixer() {
  var p = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.persistence : null;
  if (!p) return;
  // Phase 3.0.d: ?reset=ep URL detection delegated to host (parseUrlOverrides
  // returns {resetEp: true} after clearing localStorage as side effect).
  var overrides = p.parseUrlOverrides ? p.parseUrlOverrides() : {};
  if (overrides && overrides.resetEp) return;
  try {
    var s = p.loadEpMixer ? p.loadEpMixer() : null;
    if (!s) return;
    // pickupSymmetry: always use HTML default (physics-calibrated).
    // Old localStorage may have stale values from before PU model changes.
    ['springReverbMix','springDwell','springFeedbackScale','springStereoEnabled','attackNoise'].forEach(function(key) {
      if (s[key] !== undefined) EpState[key] = s[key];
    });
    // MECHANICAL knob controls all 3 noise params equally
    if (s.attackNoise !== undefined) {
      EpState.releaseNoise = s.attackNoise;
      EpState.releaseRing = s.attackNoise;
    }
    // Clear stale pickupSymmetry from storage so it doesn't persist
    if (s.pickupSymmetry !== undefined) {
      delete s.pickupSymmetry;
      if (p.saveEpMixer) p.saveEpMixer(s);
    }
    // Phase 3.0.c2 + 2026-04-15 fix: 6 slider full sync via mixer bridge.
    // ep-rev (1-10 slider) = springReverbMix (raw 0-1.4) / 1.4 * 9 + 1
    // ep-decay (1-10 slider) = (springFeedbackScale (raw 0.3-0.99) - 0.3) / 0.69 * 9 + 1
    // ep-stereo (checkbox) = springStereoEnabled (bool)
    // ep-pu-sym / ep-mechanical / ep-dwell: raw value matches slider range directly
    var b = (typeof window !== 'undefined' && window.audioCoreConfig)
      ? window.audioCoreConfig.mixer : null;
    if (b) {
      var values = {};
      var labels = {};
      if (EpState.pickupSymmetry !== undefined) {
        values['ep-pu-sym'] = EpState.pickupSymmetry;
        labels['ep-pu-sym-val'] = EpState.pickupSymmetry.toFixed(2);
      }
      if (EpState.springReverbMix !== undefined) {
        var revKnob = EpState.springReverbMix / 1.4 * 9 + 1;
        values['ep-rev'] = revKnob;
        labels['ep-rev-val'] = revKnob.toFixed(1);
      }
      if (EpState.springDwell !== undefined) {
        values['ep-dwell'] = EpState.springDwell;
        labels['ep-dwell-val'] = EpState.springDwell.toFixed(1);
      }
      if (EpState.springFeedbackScale !== undefined) {
        var decayKnob = (EpState.springFeedbackScale - 0.3) / 0.69 * 9 + 1;
        values['ep-decay'] = decayKnob;
        labels['ep-decay-val'] = decayKnob.toFixed(1);
      }
      if (EpState.springStereoEnabled !== undefined) {
        values['ep-stereo'] = EpState.springStereoEnabled;
        labels['ep-stereo-val'] = EpState.springStereoEnabled ? 'ON' : 'OFF';
      }
      if (EpState.attackNoise !== undefined) {
        values['ep-mechanical'] = EpState.attackNoise;
        labels['ep-mechanical-val'] = EpState.attackNoise.toFixed(2);
      }
      if (b.syncSliders) b.syncSliders(values);
      if (b.syncValueLabels) b.syncValueLabels(labels);
    }
  } catch(_) {}
}

function saveSoundSettings() {
  try {
    const s = {};
    s.engine = AudioState.engineKey;
    s.preset = AudioState.presetKey;
    ['snd-volume','snd-tremolo','snd-tremolo-spd','snd-phaser','snd-flanger','snd-locut','snd-hicut','snd-af-depth','snd-af-speed','snd-af-q','snd-drive'].forEach(id => {
      const el = document.getElementById(id);
      if (el) s[id] = el.value;
    });
    const lc = document.getElementById('snd-locut-toggle');
    const hc = document.getElementById('snd-hicut-toggle');
    if (lc) s.loCutEnabled = lc.checked;
    if (hc) s.hiCutEnabled = hc.checked;
    s.autoFilterEnabled = autoFilterEnabled;
    s.autoFilterType = autoFilterType;
    s.autoFilterPoles = autoFilterPoles;
    s.soundMuted = _soundMuted;
    // Phase 3.0.d: localStorage I/O delegated to bridge
    var p = (typeof window !== 'undefined' && window.audioCoreConfig)
      ? window.audioCoreConfig.persistence : null;
    if (p && p.saveSound) p.saveSound(s);
  } catch(_) {}
}

function loadSoundSettings() {
  try {
    // Phase 3.0.d: localStorage I/O delegated to bridge
    var p = (typeof window !== 'undefined' && window.audioCoreConfig)
      ? window.audioCoreConfig.persistence : null;
    if (!p || !p.loadSound) return;
    const s = p.loadSound();
    if (!s) return;
    // Migrate removed Spring EXP preset → Rhodes DI
    if (s.preset === 'Rhodes DI Spring EXP') s.preset = 'Rhodes DI';
    // D-8 (2026-04-25): 'Rhodes Suitcase' は 3 variant (Clean/Drive/Vintage) に
    // 分割された。旧 'Rhodes Suitcase' は Drive に相当するので migrate.
    if (s.preset === 'Rhodes Suitcase') s.preset = 'Rhodes Suitcase Drive';
    if (s.engine && ENGINES[s.engine]) {
      var wasMuted = _soundMuted;
      setEngine(s.engine);
      if (s.preset && AudioState.engine.presets[s.preset]) setPreset(s.preset);
      // Phase 3.0.c3 + d: organ-preset sync via presetDropdown bridge
      var pd = window.audioCoreConfig ? window.audioCoreConfig.presetDropdown : null;
      if (pd && pd.sync) pd.sync(AudioState.engineKey + ':' + AudioState.presetKey);
      // Restore muted state from saved settings (default: unmuted)
      _soundMuted = s.soundMuted !== undefined ? s.soundMuted : false;
      _updateMuteBtn();
    }
    ['snd-volume','snd-tremolo','snd-tremolo-spd','snd-phaser','snd-flanger','snd-locut','snd-hicut','snd-af-depth','snd-af-speed','snd-af-q','snd-drive'].forEach(id => {
      if (s[id] === undefined) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.value = s[id];
      el.dispatchEvent(new Event('input'));
    });
    const lc = document.getElementById('snd-locut-toggle');
    if (lc && s.loCutEnabled !== undefined && lc.checked !== s.loCutEnabled) {
      lc.checked = s.loCutEnabled;
      lc.dispatchEvent(new Event('change'));
    }
    const hc = document.getElementById('snd-hicut-toggle');
    if (hc && s.hiCutEnabled !== undefined && hc.checked !== s.hiCutEnabled) {
      hc.checked = s.hiCutEnabled;
      hc.dispatchEvent(new Event('change'));
    }
    // Restore type/poles BEFORE toggling, so change handler sees correct values
    if (s.autoFilterType) {
      autoFilterType = s.autoFilterType;
      var tb = document.getElementById('snd-af-type');
      if (tb) tb.textContent = autoFilterType === 'lowpass' ? 'LP' : 'BP';
    }
    const af = document.getElementById('snd-af-toggle');
    if (af && s.autoFilterEnabled !== undefined && af.checked !== s.autoFilterEnabled) {
      af.checked = s.autoFilterEnabled;
      af.dispatchEvent(new Event('change'));
    }
    if (s.autoFilterPoles) {
      autoFilterPoles = s.autoFilterPoles;
      var pb = document.getElementById('snd-af-poles');
      if (pb) pb.textContent = autoFilterPoles + 'P';
      if (autoFilterPoles === 2) autoFilter2.frequency.setValueAtTime(20000, audioCtx.currentTime);
    }
  } catch(_) {}
}

function renderSoundControls() {
  // Phase 3.0.c3: audio-core enumerates ENGINES + builds entries[] with
  // useCabinet meta. host's audioCoreConfig.presetDropdown bridges:
  //   - filter(entry) — HPS gate decision (host-owned)
  //   - render(entries) — DOM construction (host-owned)
  //   - sync(value) — organ-preset.value sync
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.presetDropdown : null;
  if (!b) return;
  var entries = [];
  Object.entries(ENGINES).forEach(function(entry) {
    var engineKey = entry[0], engine = entry[1];
    Object.entries(engine.presets).forEach(function(pe) {
      var presetKey = pe[0], presetData = pe[1];
      var epPreset = EP_AMP_PRESETS[presetData.epiano];
      var item = {
        value: engineKey + ':' + presetKey,
        label: presetData.label,
        engineKey: engineKey,
        presetKey: presetKey,
        useCabinet: !!(epPreset && epPreset.useCabinet)
      };
      if (b.filter && !b.filter(item)) return;
      entries.push(item);
    });
  });
  if (b.render) b.render(entries);
  // Fall back to a free preset if current selection was filtered out
  var currentValue = AudioState.engineKey + ':' + AudioState.presetKey;
  var hasCurrent = entries.some(function(e) { return e.value === currentValue; });
  if (!hasCurrent && entries.length > 0) {
    AudioState.presetKey = entries[0].presetKey;
    AudioState.instrument = AudioState.engine.presets[entries[0].presetKey];
  }
  if (b.sync) b.sync(AudioState.engineKey + ':' + AudioState.presetKey);
}
