// ========================================
// AUDIO E-PIANO ROUTING + REVERB
// ========================================
// Split from audio.js (Phase 0.1 / 2026-04-13). This file owns:
//   - E-piano output buses (epianoDirectOut / epianoAmpOut)
//   - Plate reverb (convolver + HPF + send/return + IR builder + routing)
//   - E-piano drive WaveShaper (post-PU, pre-effects)
//   - Master tremolo LFO that modulates tremoloNode
//
// Signal flow:
//   epiano worklet → epianoDirectOut → epianoDriveWS → epianoDriveMakeup
//                                    → tremoloNode (audio-effects.js)
//   epiano worklet amp out → epianoAmpOut → masterBus (bypass FX chain)
//   [epianoDirectOut + epianoAmpOut] → ePlateSend → convolver → HPF → ePlateReturn → masterBus
//
// Depends on audio-master.js (audioCtx / masterBus / tremoloNode) and
// audio-effects.js (tremoloNode is modulated through the effect chain).
// ========================================

// E-piano output buses. Suitcase spring reverb is handled inside
// epiano-worklet-processor.js now (tank wet merges with dry before the Ge
// preamp so wet/dry share the amp + cabinet). No Web-Audio reverb send here.
const epianoDirectOut = audioCtx.createGain();
// 2026-04-22 音量底上げ: 旧 0.49 は slider 初期値のミラー (歴史的残骸)。
// マスター VOL は masterBus で制御するのでここは 1.0 固定にして、preset 間
// の補正は _epOutputCompensate (audio-master.js) で行う。
epianoDirectOut.gain.setValueAtTime(1.0, 0);
// Amp output: worklet (with internal amp chain + spring reverb) bypasses
// DI effects chain → _epOutputCompensate → masterBus.
// 2026-04-22: preset 間の音量揃えを _epOutputCompensate で吸収するため、
// masterBus 直前に compensate gain 段を挟む (urinami 音量標準化方針)。
const epianoAmpOut = audioCtx.createGain();
// 2026-04-22: epianoDirectOut と同じく 1.0 固定。
epianoAmpOut.gain.setValueAtTime(1.0, 0);
epianoAmpOut.connect(_epOutputCompensate);
// Plate reverb (post-tremolo, external studio effect)
function _buildPlateImpulseResponse(seconds, decay, hpfHz) {
  const sr = audioCtx.sampleRate;
  const length = Math.max(1, Math.floor(sr * seconds));
  const ir = audioCtx.createBuffer(2, length, sr);
  const rc = 1 / (2 * Math.PI * hpfHz);
  const dt = 1 / sr;
  const alpha = rc / (rc + dt);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    let hpX = 0, hpY = 0;
    for (let i = 0; i < length; i++) {
      const env = Math.pow(1 - i / length, decay);
      const white = (Math.random() * 2 - 1) * env;
      const hp = alpha * (hpY + white - hpX);
      hpX = white; hpY = hp;
      data[i] = hp * (ch === 0 ? 1.0 : 0.92);
    }
  }
  return ir;
}
const epianoPlateConvolver = audioCtx.createConvolver();
epianoPlateConvolver.buffer = _buildPlateImpulseResponse(1.8, 2.4, 220);
const ePlateSend = audioCtx.createGain();
ePlateSend.gain.setValueAtTime(0, 0);
const ePlateReturn = audioCtx.createGain();
ePlateReturn.gain.setValueAtTime(0, 0);
const ePlateHPF = audioCtx.createBiquadFilter();
ePlateHPF.type = 'highpass';
ePlateHPF.frequency.setValueAtTime(120, 0);
ePlateHPF.Q.setValueAtTime(0.707, 0);
epianoAmpOut.connect(ePlateSend);
epianoDirectOut.connect(ePlateSend);
ePlateSend.connect(epianoPlateConvolver);
epianoPlateConvolver.connect(ePlateHPF);
ePlateHPF.connect(ePlateReturn);
// 2026-04-22: plate reverb return も compensate 段を経由 (urinami 音量標準化)
ePlateReturn.connect(_epOutputCompensate);

function _updatePlateRouting() {
  var plateOn = EpState.reverbType === 'plate';
  var amount = EpState.springReverbMix || 0;
  ePlateSend.gain.setValueAtTime(plateOn ? 1.0 : 0, audioCtx.currentTime);
  ePlateReturn.gain.setValueAtTime(plateOn ? amount * 1.5 : 0, audioCtx.currentTime);
}
// Master drive WaveShaper for e-piano (post-PU, pre-effects).
// Per-voice saturation doesn't work for worklet (single output node).
// This WaveShaper adds nonlinearity → shifts spectral centroid → bell character.
const epianoDriveWS = audioCtx.createWaveShaper();
epianoDriveWS.oversample = '2x';
epianoDriveWS.curve = (function() { var n=256, c=new Float32Array(n); for(var i=0;i<n;i++) c[i]=(i*2/n-1); return c; })(); // linear (no drive)
const epianoDriveMakeup = audioCtx.createGain();
epianoDriveMakeup.gain.setValueAtTime(1.0, 0);
epianoDirectOut.connect(epianoDriveWS);
epianoDriveWS.connect(epianoDriveMakeup);
function _updateEpianoDriveCurve(drive) {
  var n = 256, curve = new Float32Array(n);
  if (drive <= 0) {
    // Linear passthrough
    for (var i = 0; i < n; i++) curve[i] = (i * 2 / n - 1);
  } else {
    // Soft clipping: tanh(x * driveAmount) / tanh(driveAmount)
    // drive 0→1 maps to gain 1→20 (same scale as per-voice saturation)
    var d = 1 + drive * 19;
    var tanhD = Math.tanh(d);
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = Math.tanh(x * d) / tanhD;
    }
  }
  epianoDriveWS.curve = curve;
  // Makeup gain: soft clip reduces peak, compensate
  epianoDriveMakeup.gain.setValueAtTime(drive > 0 ? 1 + drive * 0.5 : 1.0, 0);
}
// Route through master effects chain (tremolo→autoFilter→phaser→flanger→filters→comp+reverb).
epianoDriveMakeup.connect(tremoloNode);
// Keep epianoReverbSend as no-op for API compatibility (noteOn still references it).
const epianoReverbSend = audioCtx.createGain();
epianoReverbSend.gain.setValueAtTime(0, 0); // reverb now handled by effects chain

// Rotary speaker / tremolo LFO (tremoloNode created in audio-master.js)
const tremoloLFO = audioCtx.createOscillator();
tremoloLFO.type = 'sine';
tremoloLFO.frequency.setValueAtTime(4.5, 0);
const tremoloGain = audioCtx.createGain();
tremoloGain.gain.setValueAtTime(0, 0);
tremoloLFO.connect(tremoloGain);
tremoloGain.connect(tremoloNode.gain); // modulate tremoloNode, not masterGain
tremoloLFO.start(0);
