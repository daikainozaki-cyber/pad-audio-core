// ========================================
// AUDIO SAMPLER (velocity-layer-aware)
// ========================================
// Split from audio.js (Phase 0.1 / 2026-04-13). Zone-based sampler used
// by ENGINES entries whose preset has a `sampler` field (currently unused
// by default since the V4.9 physical-model migration, but preserved for
// WebAudioFont fallback and future sample-based engines).
//
// Depends on audio-master.js (audioCtx).
// ========================================

// --- Sampler engine (velocity-layer-aware) ---
const _samplerBuffers = new Map(); // 'instrumentName:zoneIdx' → AudioBuffer
let _samplerDecoded = {};          // instrumentName → true

function _decodeSamplerZones(instrument) {
  if (!instrument || !instrument.zones) return;
  const name = instrument.name;
  if (_samplerDecoded[name]) return;
  _samplerDecoded[name] = true;
  // Deduplicate: some zones share the same base64 data
  const fileCache = new Map(); // base64 hash → Promise<AudioBuffer>
  instrument.zones.forEach((zone, idx) => {
    const key = name + ':' + idx;
    const b64 = zone.file.split(',')[1];
    // Cache key: DJB2 hash of full base64 (position-based sampling collides on baked loops)
    var h = 5381;
    for (var ci = 0; ci < b64.length; ci++) h = ((h << 5) + h + b64.charCodeAt(ci)) | 0;
    const cacheKey = b64.length + ':' + h;
    if (fileCache.has(cacheKey)) {
      fileCache.get(cacheKey).then(buf => { if (buf) _samplerBuffers.set(key, buf); });
      return;
    }
    const promise = new Promise(resolve => {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        audioCtx.decodeAudioData(bytes.buffer.slice(0)).then(buf => {
          _samplerBuffers.set(key, buf);
          resolve(buf);
        }).catch(() => resolve(null));
      } catch (_) { resolve(null); }
    });
    fileCache.set(cacheKey, promise);
  });
}

function _findSamplerZone(instrument, midi, velocity127) {
  const zones = instrument.zones;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (midi >= z.keyLow && midi <= z.keyHigh &&
        velocity127 >= z.velLow && velocity127 <= z.velHigh)
      return { zone: z, idx: i };
  }
  // Fallback: key match, nearest velocity
  let best = null, bestDist = Infinity;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (midi >= z.keyLow && midi <= z.keyHigh) {
      const d = Math.abs(velocity127 - (z.velLow + z.velHigh) / 2);
      if (d < bestDist) { bestDist = d; best = { zone: z, idx: i }; }
    }
  }
  return best;
}

function _dbgSampler(msg) {
  console.log('[sampler] ' + msg);
}

function _samplerNoteOn(instrument, midi, velocity, dest) {
  const vel127 = Math.round(velocity * 127);
  const match = _findSamplerZone(instrument, midi, vel127);
  if (!match) { _dbgSampler('NO ZONE m=' + midi + ' v=' + vel127); return null; }
  const { zone, idx } = match;
  const bufKey = instrument.name + ':' + idx;
  const buffer = _samplerBuffers.get(bufKey);
  if (!buffer) { _dbgSampler('NO BUF ' + bufKey + ' tot=' + _samplerBuffers.size); return null; }

  try {
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    // Use playbackRate for pitch (WebAudioFont style — detune is buggy in WKWebView)
    var semitones = midi - zone.pitchCenter;
    source.playbackRate.value = Math.pow(2, semitones / 12);

    const voiceGain = audioCtx.createGain();
    const vol = 0.15 + 0.35 * velocity; // polyphony-safe: 4 voices at full vel ≈ 2.0
    voiceGain.gain.setValueAtTime(vol, audioCtx.currentTime);

    // Held-note decay: 2-stage model (Weinreich KTH measurements)
    // "prompt sound" decays fast → "aftersound" sustains longer
    // T60 = time for 60dB decay, pitch-dependent (low=long, high=short)
    const T60 = 45 * Math.pow(2, -(midi - 21) / 18);
    const tauSlow = T60 / 6.91;  // 6.91 = ln(10^3) for 60dB
    const tauFast = tauSlow * 0.25;
    const sustainLevel = vol * Math.max(0.10, 0.80 - (midi - 21) * 0.002);
    voiceGain.gain.setTargetAtTime(sustainLevel, audioCtx.currentTime + 0.005, tauFast);

    // Damper LPF: wide open while held, closes on release (like real Rhodes damper)
    const damperLpf = audioCtx.createBiquadFilter();
    damperLpf.type = 'lowpass';
    damperLpf.frequency.value = 20000; // fully open
    damperLpf.Q.value = 0.707;

    source.connect(damperLpf);
    damperLpf.connect(voiceGain);
    voiceGain.connect(dest);
    source.start(audioCtx.currentTime, 0.01); // skip 10ms MP3 encoder padding

    _dbgSampler('OK m=' + midi + ' z=' + idx + ' st=' + semitones);

    // Release: SFZ ampeg_release (Rhodes damper feel, pitch-dependent fallback)
    const releaseTime = zone.ampRelease || 0.3;
    const releaseTau = releaseTime / 5.0; // ~5 time constants for full decay

    return {
      cancel: function() {
        const now = audioCtx.currentTime;
        voiceGain.gain.cancelScheduledValues(now);
        voiceGain.gain.setValueAtTime(voiceGain.gain.value, now);
        voiceGain.gain.setTargetAtTime(0, now, releaseTau);
        // Damper darkening: LPF closes faster than volume, absorbs high-freq noise
        damperLpf.frequency.setValueAtTime(damperLpf.frequency.value, now);
        damperLpf.frequency.setTargetAtTime(200, now, releaseTau * 0.4);
        source.stop(now + releaseTau * 6);
      }
    };
  } catch (e) {
    _dbgSampler('ERR: ' + e.message);
    return null;
  }
}
