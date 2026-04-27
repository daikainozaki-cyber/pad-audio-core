// ========================================
// AUDIO EFFECTS CHAIN
// ========================================
// Split from audio.js (Phase 0.1 / 2026-04-13). Auto Filter / Phaser /
// Flanger / Lo-Cut / Hi-Cut live here and form the signal chain:
//   masterGain → tremoloNode → autoFilter → autoFilter2 → autoFilterWetGain ─┐
//                            → autoFilterDryGain ─────────────────────────────┴→ autoFilterMix
//              → phaserFilters[0..3] → phaserWet → phaserMix
//              → flangerDelay → flangerWet → flangerMix
//              → (optional loCut) → (optional hiCut) → masterBus
// Depends on audio-master.js (audioCtx / masterGain / tremoloNode / masterBus).
// ========================================

// --- Auto Filter (Envelope Filter / Auto-Wah) ---
const autoFilter = audioCtx.createBiquadFilter();
autoFilter.type = 'lowpass';
autoFilter.frequency.setValueAtTime(20000, 0); // fully open when off
autoFilter.Q.setValueAtTime(4, 0); // resonance for wah character
const autoFilter2 = audioCtx.createBiquadFilter(); // 2nd stage for 4-pole
autoFilter2.type = 'lowpass';
autoFilter2.frequency.setValueAtTime(20000, 0);
autoFilter2.Q.setValueAtTime(4, 0);
let autoFilterEnabled = false;
let autoFilterDepth = 0.7;  // 0-1: sweep range
let autoFilterSpeed = 0.15; // decay time in seconds
let autoFilterType = 'lowpass';  // 'lowpass' or 'bandpass'
let autoFilterPoles = 2;         // 2 or 4
let autoFilterQ = 2;             // resonance: 1=fat, 10=narrow/vocal

// 2026-04-27 urinami: AUTO FILTER WET / DRY mix。WET=0 で完全 bypass
// (Envelope Filter 無効と同等)、WET=1 で従来 series 通り。Q (resonance) を
// 上げると peak で歪むので WET を下げて dry を混ぜる用。signal chain:
//   tremoloNode → autoFilter → autoFilter2 → autoFilterWetGain ─┐
//   tremoloNode ─────────────────────────→ autoFilterDryGain  ─┴→ autoFilterMix → phaser/dry mix
let autoFilterWet = 1.0;
const autoFilterWetGain = audioCtx.createGain();
autoFilterWetGain.gain.setValueAtTime(1.0, 0);
const autoFilterDryGain = audioCtx.createGain();
autoFilterDryGain.gain.setValueAtTime(0.0, 0);
const autoFilterMix = audioCtx.createGain();

function setAutoFilterWet(v) {
  autoFilterWet = Math.max(0, Math.min(1, v));
  const now = audioCtx.currentTime;
  autoFilterWetGain.gain.setValueAtTime(autoFilterWet, now);
  autoFilterDryGain.gain.setValueAtTime(1 - autoFilterWet, now);
}

function triggerAutoFilter() {
  if (!autoFilterEnabled) return;
  const now = audioCtx.currentTime;
  var isBP = autoFilterType === 'bandpass';
  // LP: Mu-Tron LP style — sweep 800-8kHz, Q=4 (resonant peak)
  // BP: Cry Baby / Mu-Tron BP — sweep 450-2500Hz, Q=5 (focused wah)
  //     Depth slider = center freq bias (low=bassy, high=bright)
  var hiFreq, loFreq;
  if (isBP) {
    // Cry Baby / Mu-Tron BP: 800-3500Hz sweep
    hiFreq = 800 + autoFilterDepth * 2700;
    loFreq = 350 + autoFilterDepth * 250;
  } else {
    // Mu-Tron LP: 800-8000Hz sweep
    hiFreq = 800 + autoFilterDepth * 7200;
    loFreq = 200 + (1 - autoFilterDepth) * 600;
  }
  autoFilter.Q.setValueAtTime(autoFilterQ, now);
  autoFilter2.Q.setValueAtTime(autoFilterQ, now);
  autoFilter.frequency.cancelScheduledValues(now);
  autoFilter.frequency.setValueAtTime(hiFreq, now);
  autoFilter.frequency.exponentialRampToValueAtTime(loFreq, now + autoFilterSpeed);
  if (autoFilterPoles === 4) {
    autoFilter2.frequency.cancelScheduledValues(now);
    autoFilter2.frequency.setValueAtTime(hiFreq, now);
    autoFilter2.frequency.exponentialRampToValueAtTime(loFreq, now + autoFilterSpeed);
  }
}

// --- Phaser: 4-stage allpass ---
const phaserFilters = [];
for (let i = 0; i < 4; i++) {
  const f = audioCtx.createBiquadFilter();
  f.type = 'allpass';
  f.frequency.setValueAtTime(1500, 0);
  f.Q.setValueAtTime(0.7, 0);
  phaserFilters.push(f);
}
for (let i = 0; i < 3; i++) phaserFilters[i].connect(phaserFilters[i + 1]);
const phaserLFO = audioCtx.createOscillator();
phaserLFO.type = 'sine';
phaserLFO.frequency.setValueAtTime(0.4, 0);
const phaserDepth = audioCtx.createGain();
phaserDepth.gain.setValueAtTime(0, 0);
phaserLFO.connect(phaserDepth);
phaserFilters.forEach(f => phaserDepth.connect(f.frequency));
phaserLFO.start(0);
const phaserWet = audioCtx.createGain();
phaserWet.gain.setValueAtTime(0, 0);
const phaserMix = audioCtx.createGain();
masterGain.connect(tremoloNode);
tremoloNode.connect(autoFilter);
autoFilter.connect(autoFilter2);
autoFilter2.connect(autoFilterWetGain);
autoFilterWetGain.connect(autoFilterMix);
tremoloNode.connect(autoFilterDryGain);
autoFilterDryGain.connect(autoFilterMix);
autoFilterMix.connect(phaserFilters[0]);
phaserFilters[3].connect(phaserWet);
phaserWet.connect(phaserMix);
autoFilterMix.connect(phaserMix);

// --- Flanger: modulated short delay ---
const flangerDelay = audioCtx.createDelay(0.02);
flangerDelay.delayTime.setValueAtTime(0.003, 0);
const flangerFeedback = audioCtx.createGain();
flangerFeedback.gain.setValueAtTime(0.4, 0);
flangerDelay.connect(flangerFeedback);
flangerFeedback.connect(flangerDelay);
const flangerLFO = audioCtx.createOscillator();
flangerLFO.type = 'sine';
flangerLFO.frequency.setValueAtTime(0.25, 0);
const flangerLFODepth = audioCtx.createGain();
flangerLFODepth.gain.setValueAtTime(0, 0);
flangerLFO.connect(flangerLFODepth);
flangerLFODepth.connect(flangerDelay.delayTime);
flangerLFO.start(0);
const flangerWet = audioCtx.createGain();
flangerWet.gain.setValueAtTime(0, 0);
const flangerMix = audioCtx.createGain();
phaserMix.connect(flangerDelay);
flangerDelay.connect(flangerWet);
flangerWet.connect(flangerMix);
phaserMix.connect(flangerMix);

// --- Lo Cut (Highpass) & Hi Cut (Lowpass) filters ---
const loCutFilter = audioCtx.createBiquadFilter();
loCutFilter.type = 'highpass';
loCutFilter.frequency.value = 80;
loCutFilter.Q.value = 0.707;
let loCutEnabled = false;

const hiCutFilter = audioCtx.createBiquadFilter();
hiCutFilter.type = 'lowpass';
hiCutFilter.frequency.value = 10000;
hiCutFilter.Q.value = 0.707;
let hiCutEnabled = false;

// Lo-Cut / Hi-Cut sit AFTER the master bus so every path
// (DI chain, Suitcase amp out, Plate reverb return) passes through them,
// matching how a real console's final EQ is placed before the output.
// Chain: masterBus → (loCut) → (hiCut) → (MasterTail | destination)
// When both filters are disabled the default masterBus→destination
// connection from audio-master.js is used as-is.
//
// 2026-04-27: host が window.MasterTail を提供すれば、chain 終端を
// MasterTail.input (例: bassFilter) に向ける。MasterTail は内部で
// bass → treble → masterTrim(+3dB) → destination を組み立てる責務を持つ。
// MasterTail 未提供の consumer (legacy / smoke test) では destination 直結で
// 後方互換。MasterTail を後付けで attach した場合は host から
// rebuildFilterChain() を 1 回呼べば chain 終端が tail に切り替わる。
function rebuildFilterChain() {
  masterBus.disconnect();
  loCutFilter.disconnect();
  hiCutFilter.disconnect();

  let chain = masterBus;

  if (loCutEnabled) {
    chain.connect(loCutFilter);
    chain = loCutFilter;
  }

  if (hiCutEnabled) {
    chain.connect(hiCutFilter);
    chain = hiCutFilter;
  }

  let tail = null;
  if (typeof window !== 'undefined' && window.MasterTail
      && window.MasterTail.input) {
    tail = window.MasterTail.input;
  }
  chain.connect(tail || audioCtx.destination);
}

// host が MasterTail を後から init した時に、chain を再構築するための
// 呼出口を expose。host は MasterTail.init 完了直後にこれを 1 回呼ぶ。
if (typeof window !== 'undefined') {
  window.rebuildFilterChain = rebuildFilterChain;
}

// DI chain terminates at _epOutputCompensate (preset 間音量揃え、
// 2026-04-22 urinami 音量標準化)。
// _epOutputCompensate は audio-master.js で定義され masterBus へ接続される。
flangerMix.connect(_epOutputCompensate);
