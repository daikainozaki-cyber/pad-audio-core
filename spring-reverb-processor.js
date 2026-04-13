// ========================================
// SPRING REVERB AudioWorklet PROCESSOR — Abel Waveguide
// ========================================
// Abel & Berners US8391504B1 waveguide spring reverb model.
// Key structural change from Välimäki: allpass dispersion is OUTSIDE the
// feedback loop.  Loop interior contains ONLY delay + loss filter.
// This fixes the tail-killing dispersion accumulation of the Välimäki model.
//
// Optional V3 tube nonlinearity (12AT7 at +410V, Koren-inspired):
//   Drive=1.0 (default) = near-linear (transparent when V3 is external).
//   Drive>1.0 = pushed blackface "grit" for standalone use.
//
// Signal chain models AB763 Twin Reverb reverb circuit:
//   HPF 318Hz → [V3 12AT7] → spring tank → LPF → output
//   V4B bloom (wet/dry nonlinear mixing) is handled outside this processor.
//
// Accutronics 4AB3C1B: 2 springs, different Td → natural stereo decorrelation.
//
// References:
//   [1] Välimäki, Parker & Abel (2010) JAES Vol.58 No.7/8
//   [2] Parker (2011) EURASIP, efficient dispersion structures
//   [3] Abel & Berners (2013) US8391504B1 waveguide patent
//   [4] Koren (1996) Improved vacuum tube models for SPICE
//   [5] Rob Robinette AB763 circuit analysis (robrobinette.com)
//   [6] Accutronics 4AB3C1B tank specifications

class SpringReverbProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    var fs = sampleRate;

    // --- Spring configurations (2 springs for stereo) ---
    // Accutronics 4AB3C1B: 2 springs with different Td for natural stereo
    // T60: ~3.0s @500Hz, ~0.5s @5kHz (Long decay tank)
    var configs = [
      { Td: 0.066, ah: 0.60 }, // L: shorter spring
      { Td: 0.082, ah: 0.58 }, // R: longer spring
    ];

    this._springs = new Array(2);

    for (var c = 0; c < 2; c++) {
      var cfg = configs[c];
      var sp = {};

      // --- Stretching factor (chirp rate control) ---
      // fc = max chirp frequency from spring geometry (~4.3kHz for 4AB3C1B)
      var fc = 4300;
      var K = fs / (2 * fc);
      var K1 = Math.floor(K);
      if (K1 < 1) K1 = 1;
      var d = K - K1;
      var a1 = (1 - d) / (1 + d); // fractional delay AP coefficient

      sp.K1 = K1;
      sp.a1 = a1;

      // --- Input HPF 318Hz ---
      // AB763 circuit: 500pF coupling cap + 1MΩ V3 grid leak resistor.
      // Physics: spring tank input impedance ∝ frequency.
      // Low freq → overcurrent → muddy. This HPF is essential.
      // 1st-order bilinear HPF: y = gain*(x - x[-1]) + a1*y[-1]
      var wc = Math.tan(Math.PI * 318 / fs);
      sp.hpfGain = 1 / (1 + wc);
      sp.hpfA1 = (1 - wc) / (1 + wc);
      sp.hpfPrevX = 0;
      sp.hpfPrevY = 0;

      // DC blocking filter (HPF ~40Hz, safety net post-tube)
      sp.adc = Math.tan(Math.PI / 4 - Math.PI * 40 / fs);
      sp.dcGain = 0.5 * (1 + sp.adc);
      sp.dcPrevX = 0;
      sp.dcPrevY = 0;

      // ===========================================
      // FEEDBACK LOOP — Abel: delay + loss only
      // No allpass inside loop → proper tail decay
      // ===========================================

      // Round-trip delay.
      // Abel: full baseDelay (no AP group delay subtraction — AP is outside)
      var baseDelaySamples = Math.round(cfg.Td * fs);
      sp.baseDelay = baseDelaySamples;

      // Multitap parameters (models reflection irregularities at spring ends)
      sp.gRipple = 0.1;
      sp.gEcho = 0.1;
      sp.nRipple = 0.5;
      sp.lRipple = Math.round(2 * K * sp.nRipple);

      // Delay buffer (power of 2 for bitmask access)
      var maxDelay = baseDelaySamples + 128;
      var dlLfSize = 256;
      while (dlLfSize < maxDelay) dlLfSize *= 2;
      sp.dlLf = new Float32Array(dlLfSize);
      sp.dlLfMask = dlLfSize - 1;
      sp.dlLfWr = 0;

      // Delay modulation (correlated noise → slow pitch drift from tension variation)
      sp.gMod = 8;
      sp.noiseAint = 0.93;
      sp.noisePrev = 0;

      // --- Loss filter A(z) per round trip ---
      // G(f) = 10^(-3*D/(T60(f)*fs))  [Abel US8391504B1]
      // Accutronics 4AB3C1B: T60 @500Hz ≈ 3.0s, @5kHz ≈ 0.5s
      // 1-pole: H(z) = b/(1 - a*z^-1) fitted to G(DC) and G(Nyquist)
      var D = baseDelaySamples;
      var t60Low = 3.0;
      var t60High = 0.5;
      var gDC  = Math.pow(10, -3 * D / (t60Low * fs));
      var gNyq = Math.pow(10, -3 * D / (t60High * fs));
      var p = (1 - gNyq / gDC) / (1 + gNyq / gDC);
      sp.lossFiltB = gDC * (1 - p);
      sp.lossFiltA = -p;
      sp.lossFiltPrevY = 0;

      sp.lfFeedback = 0;

      // ===========================================
      // DISPERSION D(z) — OUTSIDE the feedback loop
      // ===========================================
      // Abel key insight: dispersion applied once to output,
      // not compounded per round trip (which killed tails in Välimäki).
      // Physical basis: real dispersion is cumulative along the spring,
      // but the OUTPUT transducer samples the wave at one point.
      // ~20 stretched allpass stages (vs 100 inside loop in Välimäki)
      var Md = 20;
      sp.Md = Md;
      sp.a2 = 0.75; // spring allpass coefficient

      var SL = 8;
      while (SL < K1 + 2) SL *= 2;
      sp.SL = SL;
      sp.SM = SL - 1;

      sp.apX = new Float32Array(Md * SL);
      sp.apY = new Float32Array(Md * SL);
      sp.apPtr = new Int32Array(Md);

      // --- Spectral resonator (drip emphasis) ---
      // Concentrates dispersed energy into spring's characteristic band.
      // Without it, allpass spreads energy too thin → inaudible tail.
      // Peak at 1kHz (spring "drip" region), BW 800Hz.
      // Eq. 3 in Välimäki (2010), unity-normalized to prevent instability.
      var fPeak = 1000;
      var B = 800;
      var Keq = Math.floor(K);
      if (Keq < 1) Keq = 1;
      var R = 1 - (Math.PI * B * Keq) / fs;
      if (R < 0) R = 0.01;
      var pCos0 = ((1 + R * R) / (2 * R)) * Math.cos((2 * Math.PI * fPeak * Keq) / fs);
      sp.resA0half = (1 - R * R) / 2 / (1 + R); // unity peak gain normalization
      sp.resA1 = -2 * R * pCos0;
      sp.resA2 = R * R;
      sp.Keq = Keq;

      var resBufSize = 4;
      while (resBufSize < 2 * Keq + 4) resBufSize *= 2;
      sp.resIn = new Float32Array(resBufSize);
      sp.resOut = new Float32Array(resBufSize);
      sp.resMask = resBufSize - 1;
      sp.resWr = 0;

      // --- LPF: 6th-order Butterworth ~4750Hz ---
      // Models bandwidth limit of spring tank + recovery circuit.
      // 3 cascaded 2nd-order sections: Q = 0.5176, 0.7071, 1.9319
      var qs = [0.5176, 0.7071, 1.9319];
      sp.lpfB0 = new Float32Array(3);
      sp.lpfB1 = new Float32Array(3);
      sp.lpfB2 = new Float32Array(3);
      sp.lpfA1 = new Float32Array(3);
      sp.lpfA2 = new Float32Array(3);
      sp.lpfX1 = new Float32Array(3);
      sp.lpfX2 = new Float32Array(3);
      sp.lpfY1 = new Float32Array(3);
      sp.lpfY2 = new Float32Array(3);

      var omegaC = 2 * Math.PI * 4750 / fs;
      var tanHalf = Math.tan(omegaC / 2);
      var tanSq = tanHalf * tanHalf;
      for (var s = 0; s < 3; s++) {
        var norm = 1 / (1 + tanHalf / qs[s] + tanSq);
        sp.lpfB0[s] = tanSq * norm;
        sp.lpfB1[s] = 2 * tanSq * norm;
        sp.lpfB2[s] = tanSq * norm;
        sp.lpfA1[s] = 2 * (tanSq - 1) * norm;
        sp.lpfA2[s] = (1 - tanHalf / qs[s] + tanSq) * norm;
      }

      // --- Output HPF 530Hz (AB763 return side) ---
      // .003µF + 100kΩ (Reverb Level pot) = 530Hz HPF.
      // This is the 2nd stage of AB763's 2-stage HPF cascade.
      // Without it, low-freq energy from the tank muddies the output.
      // 1st-order bilinear HPF (same design as input HPF)
      var wcOut = Math.tan(Math.PI * 530 / fs);
      sp.outHpfGain = 1 / (1 + wcOut);
      sp.outHpfA1 = (1 - wcOut) / (1 + wcOut);
      sp.outHpfPrevX = 0;
      sp.outHpfPrevY = 0;

      // --- Output pre-delay (one-way spring travel time) ---
      // Real spring: input at one end, output at other end.
      // Minimum latency = Td/2 ≈ 33-41ms.
      // Without this, wet arrives with dry → phase effect, not reverb.
      var preDelaySamples = Math.round(cfg.Td * fs / 2);
      var preDlSize = 256;
      while (preDlSize < preDelaySamples + 16) preDlSize *= 2;
      sp.preDl = new Float32Array(preDlSize);
      sp.preDlMask = preDlSize - 1;
      sp.preDlWr = 0;
      sp.preDelay = preDelaySamples;

      // === HIGH CHIRPS BLOCK (Abel: AP outside loop) ===
      // Models high-frequency chirps from standard (non-stretched) allpass.
      // Stages reduced: 30 outside loop (vs 200 inside loop in Välimäki).
      var Mh = 30;
      sp.Mh = Mh;
      sp.ah = cfg.ah;
      sp.apHfPrevX = new Float32Array(Mh);
      sp.apHfPrevY = new Float32Array(Mh);

      var hfBaseDelay = Math.round(baseDelaySamples / 2.3);
      sp.hfBaseDelay = hfBaseDelay;
      var maxDelayHf = hfBaseDelay + 128;
      var dlHfSize = 256;
      while (dlHfSize < maxDelayHf) dlHfSize *= 2;
      sp.dlHf = new Float32Array(dlHfSize);
      sp.dlHfMask = dlHfSize - 1;
      sp.dlHfWr = 0;
      sp.hfFeedback = 0;

      // HF loss filter (frequency-dependent, replaces flat g_hf)
      // HF decays faster: T60 @low ≈ 2.0s, @high ≈ 0.3s
      var gDChf  = Math.pow(10, -3 * hfBaseDelay / (2.0 * fs));
      var gNyqhf = Math.pow(10, -3 * hfBaseDelay / (0.3 * fs));
      var phf = (1 - gNyqhf / gDChf) / (1 + gNyqhf / gDChf);
      sp.hfLossB = gDChf * (1 - phf);
      sp.hfLossA = -phf;
      sp.hfLossPrevY = 0;

      // Cross-coupling (high chirps → low chirps energy leakage)
      sp.c1 = 0.1;

      this._springs[c] = sp;
    }

    this._hfPrev = new Float32Array(2);
    this._noiseSeed = 48271;

    // --- V3 tube nonlinearity (optional, for standalone use) ---
    // When used inside epiano chain, V3 is external → keep drive at 1.0.
    // For standalone: send 'setDrive' message to enable grit.
    // Physics: 12AT7 at +410V (rated 300V). Clean at normal levels,
    // asymmetric soft clip when pushed. Bias creates even harmonics.
    this._tubeDrive = 1.0;
    this._tubeBias = 0.05;

    this.port.onmessage = function(e) {
      var d = e.data;
      if (d.type === 'setDecay') {
        // Map 0..1 → T60: low 1.5..4.5s, high 0.3..0.8s
        var t60L = 1.5 + d.value * 3.0;
        var t60H = 0.3 + d.value * 0.5;
        for (var c = 0; c < 2; c++) {
          var sp = this._springs[c];
          var D = sp.baseDelay;
          var gDC  = Math.pow(10, -3 * D / (t60L * sampleRate));
          var gNyq = Math.pow(10, -3 * D / (t60H * sampleRate));
          var p = (1 - gNyq / gDC) / (1 + gNyq / gDC);
          sp.lossFiltB = gDC * (1 - p);
          sp.lossFiltA = -p;
        }
      } else if (d.type === 'setDrive') {
        // V3 tube drive: 0..1 → 0.5..3.0
        this._tubeDrive = 0.5 + d.value * 2.5;
      }
    }.bind(this);
  }

  // LCG pseudo-random [0, 1) — deterministic, GC-free
  _rand() {
    this._noiseSeed = (this._noiseSeed * 16807) % 2147483647;
    return this._noiseSeed / 2147483647;
  }

  /**
   * V3 12AT7 tube soft clipper.
   * Physics: triode at +410V plate (rated 300V).
   *   Low input → near-linear (clean reverb).
   *   High input → asymmetric soft clip (pushed blackface "grit").
   *   Bias offset creates even harmonics (tube warmth).
   * tanh(x+bias) - tanh(bias) is DC-free and naturally asymmetric:
   *   positive clips at 1-tanh(bias), negative at -1-tanh(bias).
   * Reference: Koren (1996) simplified. Full model in epiano-engine.js.
   */
  _tubeNonlin(x) {
    var d = x * this._tubeDrive;
    var bias = this._tubeBias;
    return Math.tanh(d + bias) - Math.tanh(bias);
  }

  process(inputs, outputs) {
    var input = inputs[0];
    var output = outputs[0];
    if (!input || !input[0] || !output[0]) return true;

    var inMono = input[0];
    var outL = output[0];
    var outR = output[1] || output[0];
    var N = inMono.length;

    var sp0 = this._springs[0];
    var sp1 = this._springs[1];

    for (var i = 0; i < N; i++) {
      var x = inMono[i];
      outL[i] = this._processSingle(x, sp0, 0);
      outR[i] = this._processSingle(x, sp1, 1);
    }

    return true;
  }

  _processSingle(x, sp, ch) {
    // --- 1. Input HPF 318Hz (AB763: 500pF + 1MΩ) ---
    // Prevents low-freq overload of spring transducer
    var hpfOut = sp.hpfGain * (x - sp.hpfPrevX) + sp.hpfA1 * sp.hpfPrevY;
    sp.hpfPrevX = x;
    sp.hpfPrevY = hpfOut;

    // --- 2. V3 tube nonlinearity ("grit") ---
    // At drive=1.0: near-linear (transparent for external V3 chain)
    // At drive>1.0: pushed blackface character
    var tubeOut = this._tubeNonlin(hpfOut);

    // --- 3. DC block (HPF ~40Hz, safety net post-tube) ---
    var dcOut = sp.dcGain * tubeOut - sp.dcGain * sp.dcPrevX + sp.adc * sp.dcPrevY;
    sp.dcPrevX = tubeOut;
    sp.dcPrevY = dcOut;

    // --- 4. Feedback injection + cross-coupling ---
    var lfIn = dcOut + sp.lfFeedback + sp.c1 * this._hfPrev[ch];
    var hfIn = dcOut + sp.hfFeedback;

    // ========================================
    // LOW CHIRPS — FEEDBACK LOOP
    // Abel waveguide: loop = delay + loss filter ONLY
    // ========================================

    // --- 5. Write to delay line ---
    var dlMask = sp.dlLfMask;
    var dlWr = sp.dlLfWr;
    sp.dlLf[dlWr] = lfIn;

    // --- 6. Delay modulation (correlated noise) ---
    var noiseRaw = this._rand();
    var noiseFilt = (1 - sp.noiseAint) * noiseRaw + sp.noiseAint * sp.noisePrev;
    sp.noisePrev = noiseFilt;

    // Full round-trip delay (Abel: no AP group delay subtraction)
    var L = sp.baseDelay + Math.round(sp.gMod * noiseFilt);
    if (L < 4) L = 4;

    var lEcho = Math.round(L / 5);
    var lRipple = sp.lRipple;
    var l0 = L - lEcho - lRipple;
    if (l0 < 1) l0 = 1;

    // --- 7. Multitap delay read (4 taps for reflection structure) ---
    var tap0 = sp.dlLf[(dlWr - l0                   + dlMask + 1) & dlMask];
    var tap1 = sp.dlLf[(dlWr - l0 - lRipple         + dlMask + 1) & dlMask];
    var tap2 = sp.dlLf[(dlWr - l0 - lEcho           + dlMask + 1) & dlMask];
    var tap3 = sp.dlLf[(dlWr - l0 - lEcho - lRipple + dlMask + 1) & dlMask];

    // Multitap sum normalized to 1.0 (raw weights 1.21 → ×0.826)
    var rawFeedback = (sp.gEcho * sp.gRipple * tap0
                    + sp.gEcho * tap1
                    + sp.gRipple * tap2
                    + tap3) * 0.826;

    // --- 8. Loss filter A(z) → feedback ---
    // T60-based frequency-dependent attenuation per round trip.
    // This is the ONLY gain element in the loop. No separate g_lf.
    var lossOut = sp.lossFiltB * rawFeedback - sp.lossFiltA * sp.lossFiltPrevY;
    sp.lossFiltPrevY = lossOut;
    sp.lfFeedback = lossOut;

    sp.dlLfWr = (dlWr + 1) & dlMask;

    // ========================================
    // LOW CHIRPS — DISPERSION (outside loop)
    // Abel key insight: no tail-killing accumulation
    // ========================================

    // --- 9. Stretched allpass cascade D(z), 20 stages ---
    // Applied once to output tap, not per round trip.
    // Generates the characteristic chirp/drip pattern.
    var apIn = rawFeedback;
    var Md = sp.Md;
    var K1 = sp.K1;
    var a1 = sp.a1;
    var a2 = sp.a2;
    var a1a2 = a1 * a2;
    var SL = sp.SL;
    var SM = sp.SM;

    for (var s = 0; s < Md; s++) {
      var base = s * SL;
      var wr = sp.apPtr[s];

      sp.apX[base + wr] = apIn;

      var xn1  = sp.apX[base + ((wr - 1      + SL) & SM)];
      var xnK  = sp.apX[base + ((wr - K1     + SL) & SM)];
      var xnK1 = sp.apX[base + ((wr - K1 - 1 + SL) & SM)];

      var yn1  = sp.apY[base + ((wr - 1      + SL) & SM)];
      var ynK  = sp.apY[base + ((wr - K1     + SL) & SM)];
      var ynK1 = sp.apY[base + ((wr - K1 - 1 + SL) & SM)];

      // Stretched allpass: Eq. 1 in Välimäki (2010)
      var apOut = a1 * apIn + a1a2 * xn1 + a2 * xnK + xnK1
                - a2 * yn1 - a1a2 * ynK - a1 * ynK1;

      sp.apY[base + wr] = apOut;
      sp.apPtr[s] = (wr + 1) & SM;
      apIn = apOut;
    }

    var dispersedLf = apIn;

    // --- 10. Spectral resonator (drip emphasis) ---
    var Keq = sp.Keq;
    var rMask = sp.resMask;
    var rWr = sp.resWr;

    sp.resIn[rWr] = dispersedLf;
    var resIn2K  = sp.resIn[(rWr - 2 * Keq + rMask + 1) & rMask];
    var resOutK  = sp.resOut[(rWr - Keq     + rMask + 1) & rMask];
    var resOut2K = sp.resOut[(rWr - 2 * Keq + rMask + 1) & rMask];

    var resResult = sp.resA0half * (dispersedLf - resIn2K)
                  - sp.resA1 * resOutK - sp.resA2 * resOut2K;
    sp.resOut[rWr] = resResult;
    sp.resWr = (rWr + 1) & rMask;

    var lfOutput = resResult;

    // ========================================
    // HIGH CHIRPS — Abel waveguide
    // ========================================

    // --- 11. HF delay line (loop: delay + loss only) ---
    var hfDlMask = sp.dlHfMask;
    var hfDlWr = sp.dlHfWr;
    sp.dlHf[hfDlWr] = hfIn;

    var Lh = sp.hfBaseDelay + Math.round(sp.gMod * noiseFilt * 0.4);
    if (Lh < 1) Lh = 1;

    var hfDelayed = sp.dlHf[(hfDlWr - Lh + hfDlMask + 1) & hfDlMask];

    // HF loss filter (frequency-dependent decay)
    var hfLossOut = sp.hfLossB * hfDelayed - sp.hfLossA * sp.hfLossPrevY;
    sp.hfLossPrevY = hfLossOut;
    sp.hfFeedback = hfLossOut;

    sp.dlHfWr = (hfDlWr + 1) & hfDlMask;

    // --- 12. HF dispersion allpass (outside loop), 30 stages ---
    var hfInput = hfDelayed;
    var Mh = sp.Mh;
    var ah = sp.ah;

    for (var s = 0; s < Mh; s++) {
      var prevX = sp.apHfPrevX[s];
      var prevY = sp.apHfPrevY[s];
      // Standard 1st-order allpass: y = a*x + x[-1] - a*y[-1]
      var hfOut = ah * hfInput + prevX - ah * prevY;
      sp.apHfPrevX[s] = hfInput;
      sp.apHfPrevY[s] = hfOut;
      hfInput = hfOut;
    }

    this._hfPrev[ch] = hfInput;

    // ========================================
    // OUTPUT
    // ========================================

    // --- 13. LPF 6th-order Butterworth ~4750Hz ---
    // Models spring tank + recovery circuit bandwidth limitation
    var lpfIn = lfOutput;
    for (var s = 0; s < 3; s++) {
      var lpfOut = sp.lpfB0[s] * lpfIn + sp.lpfB1[s] * sp.lpfX1[s]
                 + sp.lpfB2[s] * sp.lpfX2[s]
                 - sp.lpfA1[s] * sp.lpfY1[s] - sp.lpfA2[s] * sp.lpfY2[s];
      sp.lpfX2[s] = sp.lpfX1[s];
      sp.lpfX1[s] = lpfIn;
      sp.lpfY2[s] = sp.lpfY1[s];
      sp.lpfY1[s] = lpfOut;
      lpfIn = lpfOut;
    }

    // --- 14. Output HPF 530Hz (AB763 return: .003µF + 100kΩ) ---
    // Removes low-freq mud from tank output before mixing with dry
    var outHpf = sp.outHpfGain * (lpfIn - sp.outHpfPrevX) + sp.outHpfA1 * sp.outHpfPrevY;
    sp.outHpfPrevX = lpfIn;
    sp.outHpfPrevY = outHpf;

    // --- 15. Combine LF (filtered) + HF (texture) + pre-delay ---
    var wetRaw = outHpf + hfInput * 0.001;

    var pdMask = sp.preDlMask;
    var pdWr = sp.preDlWr;
    sp.preDl[pdWr] = wetRaw;
    var wetDelayed = sp.preDl[(pdWr - sp.preDelay + pdMask + 1) & pdMask];
    sp.preDlWr = (pdWr + 1) & pdMask;

    return wetDelayed;
  }
}

registerProcessor('spring-reverb-processor', SpringReverbProcessor);
