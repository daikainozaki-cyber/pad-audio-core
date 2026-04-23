// ========================================
// E-PIANO AudioWorklet PROCESSOR
// ========================================
// All DSP runs sample-by-sample inside process(). No Web Audio nodes.
// Modal synthesis (tine) → PU nonlinear (LUT) → coupling HPF
// → [amp: harp LCR (5700Hz) → preamp → tonestack → V2B → V4B → poweramp → cabinet]
// → [DI: transparent output (no cable LCR)]
//
// 3 axioms: ①process() self-contained ②Float32Array for-loops only ③GC zero
//
// Design: urinami-san — "tines are near-pure sine waves; harmonics come from pickup and amp saturation"
// Architecture: PAD DAW Phase 1-4 SoA pattern (GC zero, no new/filter/forEach in process())

// --- Constants ---
var MAX_VOICES = 16;
var LUT_SIZE = 1024;
var LUT_MASK = LUT_SIZE - 1;
var TWO_PI = 2 * Math.PI;

// --- PU EMF Physics (Falaize 2017, eq 21-27) ---
// EMF = N × [physical constants] × g'(q) × dq/dt
// Our LUT already computes g'(q) (the bracket in eq 25-27).
// The velocity dq/dt is computed analytically from oscillator cos(phase) × omega.
// PU_EMF_SCALE absorbs: N_coil, 2×a_b²×U₀×ΔU×Rp, H_p^mag, unit conversions.
//
// Calibration target: Rob Robinette AB763 measurement — 74mV RMS at amp input
// for typical Rhodes chord playing (= cable signal before input jack divider).
// Single PU forte ≈ 50-100mV peak → harp ÷3 → ~25mV per note at output.
//
// Note: omega in process() is radians/SAMPLE (not radians/sec).
// Physical velocity = tineVelocity × sampleRate. Absorbed into PU_EMF_SCALE.
// --- PU EMF physical constants (Falaize 2017, Table 6 + EP Forum) ---
// EMF = N × 2 × a_b² × U₀ × ΔU × Rp × g'(q) × dq/dt × H_p^mag
//
// Falaize parameters:
//   a_b = 1e-3 m (tine radius)
//   U₀ = 4π×10⁻⁷ H/m (vacuum permeability)
//   U_steel = 5e-3 H/m → U_rel = U_steel/U₀ ≈ 3979 → ΔU = (U_rel-1)/(U_rel+1) ≈ 0.9995
//   Rp = 5e-3 m (pole radius)
//   N = 2900 (EP Forum rewinding: 2900 turns, 38 AWG, 190Ω)
//   B_p^mag ≈ 0.3 T (AlNiCo 5 surface field estimate)
//   H_p^mag = B_p / U₀ ≈ 238,732 A/m
//
// K = N × 2 × a_b² × U₀ × ΔU × Rp × H_p^mag
//   = 2900 × 2 × 1e-6 × 1.257e-6 × 0.9995 × 5e-3 × 238732
//   = 2900 × 2 × 1e-6 × 0.9995 × 5e-3 × 0.3  (U₀ cancels with H_p^mag = B_p/U₀)
//   = 2900 × 2 × 1e-6 × 5e-3 × 0.3 × 0.9995
//   = 2900 × 3.0e-9 × 0.9995
//   = 8.70e-6
//
// But our LUT uses normalized (dimensionless) coordinates, not physical meters.
// The LUT's g'(q) has arbitrary magnitude from the normalization (0.7/refPeak).
// So we can't use the raw physical constant directly.
//
// Instead: calibrate against Rob Robinette AB763 measurement.
// Target: Rhodes chord (4 notes) at forte → amp input = 74mV RMS ≈ 0.074 normalized.
// Per-note contribution after harp ÷3: ~0.074/4×3 = 0.056 per voice.
//
// With tineAmp=0.06 (physical: 1.5mm/25mm), omega~0.03, tipFactor~1.0, gPrime~0.3:
//   puOut = 0.06 × (0.3 × 0.03) × 1.0 × puEmfScale = 0.00054 × puEmfScale
//   Need 0.056 → puEmfScale ≈ 104 → PU_EMF_SCALE = 104/fs ≈ 0.0022
//
// Recalibrated from 0.00044: tineAmp target changed 0.3 → 0.06 (physical displacement).
// Linear gain increase (0.3/0.06 = 5×) compensates. Does not affect harmonic structure.
// 2026-03-25: halved from 0.0022 → 0.0011 (tineAmp doubled 0.06→0.12).
// Linear gain adjustment only — does not affect harmonic structure.
var PU_EMF_SCALE = 0.0011; // Design target (Rhodes 74mV RMS). Monitor [CLIP] logs.

// --- Harp wiring (Rhodes 73-key: groups of 3 parallel, 24 groups in series) ---
// Single note: only 1 PU active in its parallel group of 3.
// Other 2 PUs act as parallel resistance → voltage divider = V_pu / 3.
// Into high-impedance load (1MΩ amp grid), series impedance negligible.
var HARP_PARALLEL_DIV = 3.0;

// --- Q-value table (Shear 2011, 1974 Mark I) ---
var Q_TABLE_MIDI = [39,51,59,60,61,62,64,75,87];
var Q_TABLE_VAL  = [949,731,1101,1238,1040,1156,1520,2175,1761];

// --- Euler-Bernoulli cantilever constants (uniform beam fallback) ---
var BETAL = [1.8751, 4.6941, 7.8548, 10.9955, 14.1372, 17.2788, 20.4204, 23.5620];
var SIGMA = [0.7341, 1.0185, 0.9992, 1.0000, 1.0000, 1.0000, 1.0000, 1.0000];

// --- Beam mode frequency ratios (spring-corrected) ---
// Modes 1-2: Gabrielli 2020 SLDV measurement (F1, 43.65Hz)
// Modes 3-7: FEM bare mean × spring correction (mean of modes 1-2: 1.289)
// These are ESTIMATES for modes 3+. No per-key variation (spring data insufficient).
var BEAM_FREQ_RATIOS = [7.11, 20.25, 37.4, 60.9, 90.1, 125.0, 165.6];
var N_BEAM_MODES = 7;
var MAX_MODES = 10; // fund + tonebar + up to 8 beam modes (Nyquist-limited)

// --- Beam attack decay (Munster 2014: beam modes converge in ~14ms) ---
// Real Rhodes: beam modes at -15dB during attack, settling to -25dB.
// Physics: hammer broadband impulse excites all modes; radiation damps beam modes fast.
// Perception: <14ms is pre-pitch-perception → louder beam modes = "コリッ" without chord issues.
var BEAM_ATTACK_CLAMP = 0.25;    // -12dB re fundamental (more metallic attack)
var BEAM_SUSTAIN_CLAMP = 0.12;   // -18dB re fundamental (透明感: beam modes must be audible)
var BEAM_ATTACK_MS = 14;         // Convergence time in ms (Munster 2014)

// --- Mechanical noise (attack + release) ---
// Physics: hammer neoprene tip hitting steel tine creates broadband mechanical vibrations.
// These vibrations are NOT captured by the smooth half-sine onset envelope.
// The noise represents the "click/thud" that gives Rhodes its tactile attack character.
// Added to tineVelocity (not position) → PU EMF picks it up via g'(q) × dq/dt.
// Must bypass onset envelope (which is zero at impact moment).
//
// Release: damper felt pressing against vibrating tine creates rapid decay.
// PU detects the velocity transient as EMF spike. DIでも拾える (electromagnetic).
// --- Mechanical noise parameters (calibrated against Keyscape spectral data) ---
// Keyscape analysis: centroid 590-740Hz, peak 333-467Hz, duration 20-30ms, no key tracking.
// Real Rhodes mechanical noise = multi-layer composite:
//   Layer 1: Low thud (damper felt / hammer body, 300-600Hz)
//   Layer 2: Mid-band mechanism (springs, pivots, 800-2000Hz)
//   Layer 3: Metallic ring (beam mode re-excitation at release, 2-4kHz)

// Scales are LOW because this path bypasses PU → amp chain (no gain staging).
// Old path: noise → tineVelocity → PU(×50) → harp(÷3) → amp → out (heavy processing)
// New path: noise → mainOut directly (no amplification)
// Target: -25 to -35dB relative to tonal signal (audible but not dominant)

// Attack thud: half-sine pulse (Hertz contact model = physically correct)
// Soft mallet on mass: smooth rounded impulse, no ringing, no HF.
// Duration = hammer contact time Tc (already computed per-key per-velocity).
// "コツッ" = mass hitting something. Not hard click, not sine ring.
var ATTACK_THUD_SCALE = 6.0;
// Release Layer 1: damper thud — harder than attack (keys/metal hitting)
// "鍵とか金属が当たってるような音" — not a soft low thud but a harder click
var RELEASE_THUD_SCALE = 1.2;
var RELEASE_THUD_DECAY_MS = 2;    // muted bass drum — short, round
var RELEASE_THUD_FREQ = 60;       // もっと低く太く
// Release Layer 2: mid mechanism (disabled — TINE handles high content)
var RELEASE_MID_SCALE = 0.0;
var RELEASE_MID_DECAY_MS = 8;
var RELEASE_MID_FREQ = 400;
var RELEASE_MID_Q = 0.5;
// Release Layer 3: metallic ring (disabled — TINE handles metallic content)
var RELEASE_RING_SCALE = 0.0;
var RELEASE_RING_DECAY_MS = 6;    // longer = more jangle

// =================================================================
// FEM tapered beam mode data — generated by compute_tapered_modes.py
// Third Stage taper: 2.54mm → 1.52mm, zone 12.7mm
// 8 modes: fundamental + 7 beam modes
// Tine lengths: SM Fig 6-2 piecewise model (keys 1-7 = 157mm constant)
// Bare beam (no spring). Spring affects freq ratios, not mode shapes.
// =================================================================

// Per-key tine lengths (mm) — SM Figure 6-2 piecewise model
// Zone 1: keys 1-7 = 157mm (SM label "0-(1-7)")
// Zone 2: keys 8-40 = Gemini pixel measurement from SM bar chart
// Zone 3: keys 41-88 = exponential fit (56mm@key40 → 18mm@key88)
// Index: midi - 21
var TINE_LENGTH_TABLE = new Float32Array([
  157.0, 157.0, 157.0, 157.0, 157.0, 157.0, 157.0, 153.8,
  150.6, 147.4, 144.2, 141.0, 137.9, 134.7, 131.5, 128.3,
  125.1, 121.9, 118.7, 115.5, 112.4, 109.2, 106.0, 102.8,
  99.6, 96.4, 93.2, 90.1, 86.9, 83.7, 80.5, 77.3,
  74.1, 71.0, 67.8, 65.4, 63.0, 60.6, 58.3, 56.0,
  54.7, 53.4, 52.2, 50.9, 49.8, 48.6, 47.5, 46.3,
  45.3, 44.2, 43.2, 42.2, 41.2, 40.2, 39.3, 38.4,
  37.5, 36.6, 35.7, 34.9, 34.1, 33.3, 32.5, 31.7,
  31.0, 30.3, 29.6, 28.9, 28.2, 27.5, 26.9, 26.3,
  25.7, 25.1, 24.5, 23.9, 23.3, 22.8, 22.3, 21.7,
  21.2, 20.7, 20.3, 19.8, 19.3, 18.9, 18.4, 18.0
]);

// Per-key spatial ratios at striking position [beam1/fund .. beam7/fund]
// Index: (midi - 21) * BEAM_N_RATIOS
var BEAM_SPATIAL_RATIO = new Float32Array([
  -2.934255, 2.638158, 0.397779,-2.503129, 1.539326, 0.992622,-2.121241, // key  1
  -2.967374, 2.745259, 0.277907,-2.508763, 1.700385, 0.837271,-2.156745, // key  2
  -3.000507, 2.853744, 0.152407,-2.505813, 1.859299, 0.669711,-2.173726, // key  3
  -3.033414, 2.962834, 0.022065,-2.493823, 2.014103, 0.491520,-2.170914, // key  4
  -3.066942, 3.075309,-0.116472,-2.472107, 2.167732, 0.299073,-2.147398, // key  5
  -3.099840, 3.186997,-0.258185,-2.441036, 2.313805, 0.099794,-2.103161, // key  6
  -3.132924, 3.300619,-0.406490,-2.399630, 2.454939,-0.109933,-2.036930, // key  7
  -3.100156, 3.197636,-0.284969,-2.417715, 2.324678, 0.053085,-2.065944, // key  8
  -3.065397, 3.090317,-0.162304,-2.429232, 2.186254, 0.214736,-2.083476, // key  9
  -3.029017, 2.978766,-0.037828,-2.434452, 2.038552, 0.376104,-2.087934, // key 10
  -2.994215, 2.874267, 0.073834,-2.430261, 1.897306, 0.516114,-2.075763, // key 11
  -2.956883, 2.763853, 0.187750,-2.418525, 1.746358, 0.654496,-2.050315, // key 12
  -2.920477, 2.657124, 0.295083,-2.401907, 1.598870, 0.781806,-2.016428, // key 13
  -2.880140, 2.541256, 0.406008,-2.374474, 1.437935, 0.906161,-1.963973, // key 14
  -2.834438, 2.410960, 0.526126,-2.334150, 1.253435, 1.034448,-1.885536, // key 15
  -2.784736, 2.271097, 0.650586,-2.284149, 1.056502, 1.161090,-1.791554, // key 16
  -2.745721, 2.167516, 0.730645,-2.229903, 0.913934, 1.225859,-1.699470, // key 17
  -2.695542, 2.032605, 0.836867,-2.161841, 0.727922, 1.315124,-1.581176, // key 18
  -2.645270, 1.900767, 0.933044,-2.084903, 0.549198, 1.384361,-1.451375, // key 19
  -2.591328, 1.762711, 1.026058,-1.994508, 0.365837, 1.439617,-1.301814, // key 20
  -2.538578, 1.631736, 1.104979,-1.897430, 0.198008, 1.470007,-1.146258, // key 21
  -2.478950, 1.487277, 1.183905,-1.781369, 0.018577, 1.486003,-0.962350, // key 22
  -2.418690, 1.346349, 1.250598,-1.658440,-0.146963, 1.480923,-0.774469, // key 23
  -2.349175, 1.187688, 1.315717,-1.509744,-0.325075, 1.451307,-0.548240, // key 24
  -2.281793, 1.040769, 1.363258,-1.362963,-0.476059, 1.401947,-0.335211, // key 25
  -2.208779, 0.888463, 1.398628,-1.200585,-0.617796, 1.323177,-0.108045, // key 26
  -2.130112, 0.730571, 1.423618,-1.025733,-0.751698, 1.220481, 0.129752, // key 27
  -2.052000, 0.583374, 1.429114,-0.853405,-0.854900, 1.093476, 0.344493, // key 28
  -1.964072, 0.426089, 1.419928,-0.663141,-0.946480, 0.930788, 0.562858, // key 29
  -1.869645, 0.268494, 1.391094,-0.465998,-1.012244, 0.735198, 0.755622, // key 30
  -1.758768, 0.103091, 1.324154,-0.248644,-1.022512, 0.476504, 0.870122, // key 31
  -1.668160,-0.020673, 1.263663,-0.091522,-1.025174, 0.283604, 0.945018, // key 32
  -1.550816,-0.167347, 1.166307, 0.100903,-0.980791, 0.020542, 0.942619, // key 33
  -1.438898,-0.289479, 1.061094, 0.259357,-0.908622,-0.207914, 0.870223, // key 34
  -1.310490,-0.410262, 0.926820, 0.415725,-0.783800,-0.438077, 0.699602, // key 35
  -1.227603,-0.472477, 0.835677, 0.493965,-0.688046,-0.551976, 0.556997, // key 36
  -1.139311,-0.528274, 0.735318, 0.562075,-0.569281,-0.639186, 0.382831, // key 37
  -1.047798,-0.577332, 0.631714, 0.621630,-0.437384,-0.701079, 0.199531, // key 38
  -0.956918,-0.614321, 0.527654, 0.662010,-0.295382,-0.716087, 0.019725, // key 39
  -0.861788,-0.643198, 0.419566, 0.688514,-0.142599,-0.692862,-0.151669, // key 40
  -0.833026,-0.631118, 0.390759, 0.659368,-0.111476,-0.620777,-0.152430, // key 41
  -0.807194,-0.628696, 0.368647, 0.656509,-0.081813,-0.598785,-0.175543, // key 42
  -0.783820,-0.625104, 0.350729, 0.653237,-0.058907,-0.578928,-0.189148, // key 43
  -0.765338,-0.619949, 0.339670, 0.650292,-0.045131,-0.564159,-0.194752, // key 44
  -0.745498,-0.615148, 0.326252, 0.646460,-0.026930,-0.544616,-0.204325, // key 45
  -0.733071,-0.608048, 0.323796, 0.643160,-0.025809,-0.536473,-0.197667, // key 46
  -0.700876,-0.607479, 0.293386, 0.638454, 0.015313,-0.506590,-0.228634, // key 47
  -0.697073,-0.597575, 0.300321, 0.633179, 0.007356,-0.499546,-0.219826, // key 48
  -0.687877,-0.588784, 0.301174, 0.624935, 0.002233,-0.487773,-0.205006, // key 49
  -0.679435,-0.581206, 0.302098, 0.618457,-0.000588,-0.477028,-0.195116, // key 50
  -0.662880,-0.556190, 0.287093, 0.557446,-0.005182,-0.381745,-0.136800, // key 51
  -0.655613,-0.547826, 0.287610, 0.545867,-0.008914,-0.365567,-0.124251, // key 52
  -0.653086,-0.538805, 0.293646, 0.535234,-0.017873,-0.353971,-0.110752, // key 53
  -0.652243,-0.529691, 0.301890, 0.524622,-0.030274,-0.345651,-0.094843, // key 54
  -0.651542,-0.520231, 0.308359, 0.510726,-0.039215,-0.328988,-0.080487, // key 55
  -0.654869,-0.509804, 0.319850, 0.496361,-0.054135,-0.313642,-0.060617, // key 56
  -0.657642,-0.503067, 0.329558, 0.490975,-0.060076,-0.311646,-0.064950, // key 57
  -0.671836,-0.487044, 0.354793, 0.471093,-0.092535,-0.297701,-0.030084, // key 58
  -0.679455,-0.473145, 0.367723, 0.448354,-0.107083,-0.270162,-0.012342, // key 59
  -0.692513,-0.457877, 0.387455, 0.429123,-0.126669,-0.256031,-0.000734, // key 60
  -0.708852,-0.440460, 0.410929, 0.406513,-0.150678,-0.236310, 0.016526, // key 61
  -0.725648,-0.421593, 0.432177, 0.381408,-0.169822,-0.213689, 0.027122, // key 62
  -0.746865,-0.399272, 0.456896, 0.353658,-0.189756,-0.191100, 0.032803, // key 63
  -0.771912,-0.372133, 0.484083, 0.319395,-0.212256,-0.162907, 0.042456, // key 64
  -0.796993,-0.343896, 0.508300, 0.285390,-0.228485,-0.138794, 0.042424, // key 65
  -0.830448,-0.306027, 0.538473, 0.240392,-0.247984,-0.106361, 0.042977, // key 66
  -0.859583,-0.270095, 0.560180, 0.198492,-0.257242,-0.079340, 0.036498, // key 67
  -0.896177,-0.222866, 0.583742, 0.145495,-0.265990,-0.049146, 0.030645, // key 68
  -0.934762,-0.166868, 0.596975, 0.082835,-0.252639,-0.012442,-0.000239, // key 69
  -0.983644,-0.103556, 0.624567, 0.023494,-0.263755, 0.003602, 0.001825, // key 70
  -1.024323,-0.036681, 0.622142,-0.037329,-0.234917, 0.020526,-0.019816, // key 71
  -1.075562, 0.045728, 0.624226,-0.109394,-0.212902, 0.038171,-0.032836, // key 72
  -1.127090, 0.133643, 0.612931,-0.172219,-0.181748, 0.037073,-0.034914, // key 73
  -1.185045, 0.239402, 0.587071,-0.238168,-0.141211, 0.028251,-0.024226, // key 74
  -1.247187, 0.359119, 0.546683,-0.306565,-0.089489, 0.027600,-0.023662, // key 75
  -1.313920, 0.492530, 0.488792,-0.358636,-0.046549, 0.012668, 0.012130, // key 76
  -1.382966, 0.639109, 0.404299,-0.390879, 0.001083,-0.013266, 0.055055, // key 77
  -1.453557, 0.795570, 0.296630,-0.401541, 0.042875,-0.033363, 0.085207, // key 78
  -1.524284, 0.957613, 0.168899,-0.388102, 0.065099,-0.035823, 0.128832, // key 79
  -1.614675, 1.173404,-0.013200,-0.361312, 0.086108, 0.001948, 0.114231, // key 80
  -1.700291, 1.384645,-0.223932,-0.278794, 0.077266, 0.022583, 0.112015, // key 81
  -1.787654, 1.603454,-0.460734,-0.161296, 0.028916, 0.096486, 0.054911, // key 82
  -1.886462, 1.861856,-0.766414, 0.004973,-0.015527, 0.150529,-0.020867, // key 83
  -1.981368, 2.108288,-1.074272, 0.195256,-0.099275, 0.264056,-0.180154, // key 84
  -2.082745, 2.381185,-1.450607, 0.475216,-0.239093, 0.380919,-0.330716, // key 85
  -2.188803, 2.668683,-1.859811, 0.788277,-0.378609, 0.473690,-0.482330, // key 86
  -2.302289, 2.983351,-2.327622, 1.168496,-0.539041, 0.539475,-0.627440, // key 87
  -2.417347, 3.312546,-2.864653, 1.708541,-0.901569, 0.765315,-0.868906  // key 88
]);
var BEAM_N_RATIOS = 7;

// Fundamental mode shape at striking position (tip-normalized)
// Index: midi - 21
var BEAM_PHI_STRIKE = new Float32Array([
  0.196392, 0.192532, 0.188700, 0.184921, 0.181101, 0.177380,
  0.173666, 0.176634, 0.179777, 0.183140, 0.186324, 0.189767,
  0.193193, 0.196992, 0.201425, 0.206396, 0.210002, 0.215055,
  0.220153, 0.225701, 0.231148, 0.237439, 0.243851, 0.251517,
  0.258995, 0.267226, 0.276399, 0.285565, 0.296220, 0.307966,
  0.321867, 0.333531, 0.349418, 0.365043, 0.383778, 0.395867,
  0.409090, 0.423366, 0.437921, 0.453789, 0.457030, 0.460607,
  0.463779, 0.466044, 0.468599, 0.469710, 0.474928, 0.474190,
  0.474582, 0.474904, 0.475147, 0.475109, 0.474075, 0.472698,
  0.471195, 0.468827, 0.466816, 0.461896, 0.458299, 0.453564,
  0.448114, 0.442429, 0.435706, 0.428013, 0.420302, 0.410602,
  0.401926, 0.391362, 0.379964, 0.367225, 0.355215, 0.341452,
  0.327562, 0.312185, 0.296244, 0.279482, 0.262275, 0.244954,
  0.228126, 0.207840, 0.188949, 0.170314, 0.150948, 0.132669,
  0.114585, 0.099107, 0.085638, 0.073460
]);

// --- Pre-compute cantilever tip values ---
function cantileverPhi(xi, m) {
  var bx = BETAL[m] * xi;
  return Math.cosh(bx) - Math.cos(bx) - SIGMA[m] * (Math.sinh(bx) - Math.sin(bx));
}
var PHI_TIP = [cantileverPhi(1.0, 0), cantileverPhi(1.0, 1), cantileverPhi(1.0, 2)];

function modeExcitation(xi, m) {
  return cantileverPhi(xi, m) / PHI_TIP[m];
}

// --- Physical data functions ---
function interpolateQ(midi) {
  if (midi <= Q_TABLE_MIDI[0]) return Q_TABLE_VAL[0];
  if (midi >= Q_TABLE_MIDI[Q_TABLE_MIDI.length - 1]) return Q_TABLE_VAL[Q_TABLE_VAL.length - 1];
  for (var i = 0; i < Q_TABLE_MIDI.length - 1; i++) {
    if (midi >= Q_TABLE_MIDI[i] && midi <= Q_TABLE_MIDI[i + 1]) {
      var frac = (midi - Q_TABLE_MIDI[i]) / (Q_TABLE_MIDI[i + 1] - Q_TABLE_MIDI[i]);
      return Q_TABLE_VAL[i] + frac * (Q_TABLE_VAL[i + 1] - Q_TABLE_VAL[i]);
    }
  }
  return 1200;
}

function tineLength(midi) {
  var idx = midi - 21;
  if (idx >= 0 && idx < 88) return TINE_LENGTH_TABLE[idx];
  // Fallback for out-of-range MIDI
  var key = midi - 20;
  if (key < 1) key = 1; if (key > 88) key = 88;
  return 157 * Math.exp(-0.0249 * (key - 1));
}

function strikingLine(midi) {
  var key = midi - 20;
  if (key < 1) key = 1; if (key > 88) key = 88;
  var t = (key - 1) / 87;
  return 57.15 * (1 - t) + 3.175 * t;
}

// --- Hammer tip height (Service Manual, per register) ---
// Used as contact band width along tine axis.
function hammerTipWidth(midi) {
  var key = midi - 20;
  if (key < 1) key = 1; if (key > 88) key = 88;
  if (key <= 30) return 6.35;   // Shore A 30, neoprene/black
  if (key <= 40) return 7.94;   // Shore A 50, neoprene/red
  if (key <= 50) return 9.53;   // Shore A 70, neoprene/yellow
  if (key <= 64) return 11.11;  // Shore A 90, neoprene/black
  return 11.11;                  // Maple wood core + tube
}

// --- Hammer impulse spectral envelope (Hunt-Crossley viscoelastic model) ---
// Pure Hertz: F(t) = F₀ sin(πt/Tc) → envelope 1/(2fTc)² for 2fTc > 1.
// Real neoprene: Hunt-Crossley adds viscous damping F ∝ α^n(1 + λ·dα/dt).
// Effect: asymmetric pulse (sharp attack, slow rebound) → steeper spectral rolloff.
// beta = 0: pure Hertz (half-sine). beta > 0: viscoelastic (neoprene).
// Physics: low COR → more energy absorbed → softer rebound → less HF → growl.
//          high COR → elastic → symmetric → more HF → bell/chime.
function halfSineEnvelope(f, Tc, beta) {
  var u = 2 * f * Tc;
  if (u <= 1) return 1;
  // beta=0: 1/u² (Hertz). beta>0: 1/u^(2+β) (Hunt-Crossley asymmetric).
  // Math.pow only called at noteOn (not per-sample), GC-zero safe.
  if (!beta || beta <= 0.001) return 1 / (u * u);
  return 1 / Math.pow(u, 2 + beta);
}

// --- Contact band mode excitation (replaces point modeExcitation for striking) ---
// Integrates mode shape over hammer contact band with raised-cosine (Hertz) weighting.
// bandNorm = contact width / tine length (dimensionless).
// For narrow bands, converges to point excitation.
function bandModeExcitation(xi_center, bandNorm, m) {
  if (bandNorm < 0.02) return cantileverPhi(xi_center, m) / PHI_TIP[m];
  var hw = bandNorm / 2;
  var xi_lo = xi_center - hw;
  if (xi_lo < 0.001) xi_lo = 0.001;
  var xi_hi = xi_center + hw;
  if (xi_hi > 0.999) xi_hi = 0.999;
  var N = 20;
  var sumW = 0, sumF = 0;
  for (var i = 0; i <= N; i++) {
    var xi = xi_lo + (i / N) * (xi_hi - xi_lo);
    var d = (xi - xi_center) / hw;
    var w = Math.cos(d * 1.5707963); // cos(π/2 × d)
    if (w < 0) w = 0;
    sumW += w;
    sumF += w * cantileverPhi(xi, m) / PHI_TIP[m];
  }
  return sumW > 0 ? sumF / sumW : cantileverPhi(xi_center, m) / PHI_TIP[m];
}

function puGapMm(midi) {
  // 2026-04-07: gradual curve instead of step function.
  //
  // 履歴:
  //   Old: step bass/treble=1.588, mid=0.794 (2x step → LUT too shallow for bass).
  //   v1 unified 0.794: bass output exploded → D2以下 silence (PU too close, g'(q) overflow).
  //   v2 gradual: smooth taper bass (1.1mm) → mid (0.794mm) → treble (1.1mm).
  //
  // 2026-04-23 A-2 試行 (0.9/0.85/0.80/0.60mm 測定): 音量逆U字に影響なし (±0.3 dB)。
  //   LUT 0.7/refPeak normalize が gap 効果を相殺。v2 (1.1mm) に revert。
  //   詳細: notes/permanent/2026/Rhodes物理モデリングの音量逆U字は...
  //
  // Physics: SM voicing range is 1/16"-1/8" (1.588-3.175mm) adjustable.
  // Well-voiced Rhodes sits closer than SM max. Bass slightly wider for clearance.
  var key = midi - 20;
  if (key < 1) key = 1; if (key > 88) key = 88;
  if (key <= 30) {
    // Bass: taper from 1.1mm (key 1) to 0.794mm (key 30)
    var t = (key - 1) / 29;
    return 1.1 * (1 - t) + 0.794 * t;
  }
  if (key <= 65) return 0.794;
  // Treble: taper from 0.794mm (key 65) to 1.1mm (key 88)
  var t2 = (key - 65) / 23;
  return 0.794 * (1 - t2) + 1.1 * t2;
}

// --- Escapement distance (SM Figure 4-2) ---
// Gap between hammer tip and tine at rest. Controls maximum tine displacement
// and effective dynamic range per register.
// Bass: 6.35-9.53mm (avg 7.94), Treble: 0.79-2.38mm (avg 1.59).
// 8× variation across keyboard.
function escapementMm(midi) {
  var key = midi - 20;
  if (key < 1) key = 1; if (key > 88) key = 88;
  var t = (key - 1) / 87; // 0=bass, 1=treble
  return 7.94 * (1 - t) + 1.59 * t;
}

// --- Hertz contact stiffness per hammer zone ---
// K_H = (4/3) × E* × √R_tip
// E* ≈ E_neoprene / (1-ν²) (steel is infinitely stiff by comparison)
// R_tip ≈ 4mm hemisphere (SM hammer tip geometry)
// Shore A → Young's modulus (MPa): 30→1, 50→3, 70→7, 90→15, wood→10000
var HAMMER_KH = [
  112000,   // Shore 30: (4/3) × 1.33e6 × √0.004
  337000,   // Shore 50: (4/3) × 4.00e6 × √0.004
  785000,   // Shore 70: (4/3) × 9.33e6 × √0.004
  1680000,  // Shore 90: (4/3) × 20.0e6 × √0.004
  1.12e9    // Wood/maple: E ≈ 10 GPa
];
var HAMMER_RELMASS = [0.67, 0.83, 1.00, 1.17, 0.67];

// --- Coefficient of Restitution per hammer zone (Hunt-Crossley model) ---
// COR = rebound velocity / impact velocity. Neoprene is viscoelastic:
//   Shore 30 (bass): very soft, absorbs ~65% of kinetic energy → mushy, growl
//   Shore 90 (upper): fairly elastic, ~20% loss → snappy, bell character
//   Wood (treble): nearly elastic → sharp attack, maximum HF excitation
// Source: typical neoprene values (Stronge 2000, Sonderboe 2024 approach)
var HAMMER_COR = [
  0.35,   // Shore 30: low COR, high dissipation
  0.50,   // Shore 50: moderate
  0.65,   // Shore 70: moderate-high
  0.80,   // Shore 90: fairly elastic
  0.92    // Wood/maple: nearly elastic
];

function getHammerParams(midi, velocity) {
  var key = midi - 20;
  var zone;
  if (key <= 30)      zone = 0;  // Shore 30
  else if (key <= 40) zone = 1;  // Shore 50
  else if (key <= 50) zone = 2;  // Shore 70
  else if (key <= 64) zone = 3;  // Shore 90
  else                zone = 4;  // Wood

  var relMass = HAMMER_RELMASS[zone];
  var K_H = HAMMER_KH[zone];
  var cor = HAMMER_COR[zone];

  // --- Velocity-dependent COR (strain-rate stiffening) ---
  // Neoprene stiffens at higher strain rates → COR increases with velocity.
  // Effect: forte is slightly more elastic → slightly more HF → preserves bell.
  // Empirical: ~10-15% COR increase from pp to ff for neoprene (Stronge 2000).
  var velNorm = Math.max(velocity, 0.1);
  var cor_v = cor + (1 - cor) * 0.12 * Math.max(velNorm - 0.3, 0);
  if (cor_v > 0.98) cor_v = 0.98;

  // --- Hertz contact time (per-key, from physics) ---
  // Tc = 2.94 × α_max / v₀,  α_max = (5 m_eff v₀² / (4 K_H))^(2/5)
  //
  // Critical physics: m_eff = tine modal mass, NOT hammer mass.
  // m_hammer (30g) >> m_tine (0.3-3g) → reduced mass ≈ m_tine.
  // Result: Rhodes contact is SHORT (light tine bounces off heavy hammer).
  // Each key has different Tc because tine length (= modal mass) varies.
  var L_m = tineLength(midi) * 1e-3;
  var m_eff = 0.24 * TINE_RHO * TINE_A * L_m; // cantilever modal mass

  var v0 = Math.max(velNorm, 0.1);
  var alpha_max = Math.pow(5 * m_eff * v0 * v0 / (4 * K_H), 0.4);
  var Tc_hertz = 2.94 * alpha_max / v0;

  // --- Hunt-Crossley: viscoelastic contact time extension ---
  // Soft neoprene absorbs energy → rebound is slower → total contact longer.
  // Marhefka & Orin (2006): Tc_HC ≈ Tc_Hertz × (1 + 0.5×(1-COR)).
  // Shore 30 (COR=0.35): ×1.33. Shore 70: ×1.18. Wood: ×1.04.
  var Tc = Tc_hertz * (1 + 0.5 * (1 - cor_v));

  if (Tc < 0.00002) Tc = 0.00002; // min 0.02ms
  if (Tc > 0.005) Tc = 0.005;     // max 5ms

  // --- Hunt-Crossley spectral asymmetry ---
  // Viscoelastic pulse is asymmetric (sharp attack, slow rebound).
  // Spectral envelope rolls off steeper than Hertz 1/f²:
  //   1/(2fTc)^(2+β) where β ∝ (1-COR).
  // Low COR → high β → steep rolloff → less beam mode excitation → growl.
  // High COR → β≈0 → standard half-sine → full beam excitation → bell.
  // Physics: asymmetric Hunt-Crossley pulse → steeper spectral rolloff than half-sine.
  // Coefficient 0.6 is an estimate. Proper derivation: Fourier analysis of
  // F(t) = K·α^1.5·(1 + λ·dα/dt) for each COR value. TODO: derive analytically.
  var spectralBeta = 0.6 * (1 - cor_v);

  // 2026-04-06: expose alpha_max for displacement coupling.
  // Codex audit: K_H varies 10-15x across keyboard but was NOT feeding into
  // computeTineAmplitude(). Soft bass hammers (Shore 30, K_H low) produce
  // larger alpha_max → more physical displacement → more PU drive.
  return { Tc: Tc, relMass: relMass, cor: cor_v, spectralBeta: spectralBeta, alphaMax: alpha_max };
}

// --- Per-key PU vertical offset (Lver) ---
// A well-voiced Rhodes has per-key PU adjustment via the voicing screw.
// Physical basis:
//   - Bass (large displacement): Lver small → tine stays centered in PU field
//     → cleaner fundamental, avoids asymmetric clipping
//   - Mid: moderate Lver → standard Rhodes character (even harmonics from asymmetry)
//   - Treble (small displacement): larger Lver → even small oscillations
//     produce asymmetry in g'(q) → maintains bell character
//
// Default PU Lver from data: 1mm (normalized: 0.04). The global pickupSymmetry
// slider is additive on top of this per-key curve.
// Returns an additive offset to Lver (in normalized PU coordinates).
function perKeyLverOffset(midi) {
  var key = midi - 20;
  if (key < 1) key = 1; if (key > 88) key = 88;
  var t = (key - 1) / 87; // 0 = lowest, 1 = highest
  // Smooth curve: bass=−0.02, mid=0 (neutral), treble=+0.03
  // Uses physics: bass needs centered (less asymmetry for large displacement),
  // treble benefits from offset (more asymmetry for small displacement)
  return -0.02 + t * 0.05;
}

function hasTonebar(midi) { return midi > 27; }

function tonebarPhase(midi) {
  if (midi <= 52) return -1;
  if (midi <= 71) return 1;
  if (midi <= 81) return -1;
  return 1;
}

// --- Tonebar eigenfrequency and enslaving (Münster 2014, ISMA Table 1) ---
// Physics: tonebar has its OWN natural frequency (much lower than tine).
// At note onset, tonebar vibrates at its eigenfrequency for ~10-14ms,
// then is "enslaved" by the tine and locks to the tine frequency.
// During the transition: two frequencies coexist → FM sidebands → metallic "click".
// After enslaving: tonebar tracks tine exactly → no beat, steady state.
//
// Münster Table 1: measured eigenfrequencies of 9 tonebars (Bar 12-68).
// TB_EIGEN_MIDI: MIDI note numbers for measurement points.
// TB_EIGEN_HZ: tonebar natural frequencies in Hz.
// TB_RATIO_VAL: f_tb / f_tine (for backwards compat with tonebarDetuning).
var TB_EIGEN_MIDI = [39, 42, 49, 52, 59, 62, 69, 76, 83]; // bar 12-68 mapped to MIDI
var TB_EIGEN_HZ   = [51, 69, 79, 105, 138, 183, 140, 145, 222]; // tonebar eigenfrequencies
var TB_RATIO_MIDI = TB_EIGEN_MIDI;
var TB_RATIO_VAL  = [0.65, 0.58, 0.45, 0.40, 0.35, 0.31, 0.16, 0.11, 0.11];

// Enslaving time constant (Münster: visible transition ~10-14ms).
// τ ≈ 5ms gives 63% convergence at 5ms, ~95% at 15ms → matches observed window.
var TB_ENSLAVE_TAU = 0.005; // seconds

// Interpolate tonebar eigenfrequency for any MIDI note.
function tonebarEigenFreq(midi) {
  if (!hasTonebar(midi)) return 0;
  if (midi <= TB_EIGEN_MIDI[0]) return TB_EIGEN_HZ[0];
  if (midi >= TB_EIGEN_MIDI[TB_EIGEN_MIDI.length - 1]) return TB_EIGEN_HZ[TB_EIGEN_HZ.length - 1];
  for (var i = 0; i < TB_EIGEN_MIDI.length - 1; i++) {
    if (midi >= TB_EIGEN_MIDI[i] && midi <= TB_EIGEN_MIDI[i + 1]) {
      var frac = (midi - TB_EIGEN_MIDI[i]) / (TB_EIGEN_MIDI[i + 1] - TB_EIGEN_MIDI[i]);
      return TB_EIGEN_HZ[i] + frac * (TB_EIGEN_HZ[i + 1] - TB_EIGEN_HZ[i]);
    }
  }
  return TB_EIGEN_HZ[0];
}

// Old detuning function (kept for reference — now replaced by enslaving model).
function tonebarDetuning(midi) {
  // After enslaving, tonebar tracks tine at exactly f0.
  // No steady-state detuning.
  return 0;
}

// --- Tip displacement factor (relative to reference key B3/MIDI 59) ---
var TIP_REF = 0; // computed once

function tipDisplacementFactor(midi) {
  var L = tineLength(midi);
  var keyIdx = midi - 21;
  var phi;
  if (keyIdx >= 0 && keyIdx < 88) {
    phi = BEAM_PHI_STRIKE[keyIdx]; // FEM tapered beam
  } else {
    var xs = strikingLine(midi);
    var xi = Math.min(xs / L, 0.95);
    phi = modeExcitation(xi, 0); // Fallback: uniform E-B
  }
  var hammer = getHammerParams(midi, 0.5);
  var massScale = Math.sqrt(hammer.relMass);
  if (TIP_REF === 0) {
    // Reference key B3 (MIDI 59) — keyIdx = 38
    var phir = (38 < 88) ? BEAM_PHI_STRIKE[38] : modeExcitation(0.95, 0);
    var Lr = tineLength(59);
    var hr = getHammerParams(59, 0.5);
    TIP_REF = Math.sqrt(hr.relMass) * Math.pow(Lr, 1.5) * phir;
  }
  return massScale * Math.pow(L, 1.5) * phi / TIP_REF;
}

// --- Per-key tine vibration amplitude (Euler-Bernoulli cantilever beam) ---
// NOT a scale factor. Each key's amplitude is computed from its own physics:
//   A_tip = v_hammer × √(m_hammer / k_eff) × mode_shape_at_striking_point
//   k_eff = 3EI / L³  (cantilever tip stiffness)
//
// Material (ASTM A228 spring steel): E = 180 GPa, r = 1mm (Falaize Table 4)
// Calibration: A4 (Falaize, Fig 10a) → ~1.0mm displacement at forte (500N, 30g hammer)
//
// Hammer velocity: v_hammer = VELOCITY_SCALE × √(MIDI_velocity)
// (sqrt models the mechanical advantage of the key mechanism)

// --- Per-key tine vibration amplitude (Euler-Bernoulli cantilever beam) ---
// NOT a scale factor. Each key computed from its OWN physical parameters:
//   k_eff(midi) = 3EI / L(midi)³   (beam stiffness — different for every key)
//   m_hammer(midi) = zone-dependent  (5 zones: Shore 30→wood)
//   phi(midi) = mode shape at striking point (varies with L and xs)
//   A(midi) = √(m_hammer / k_eff) × √(velocity) × phi
//
// Returns dimensionless amplitude in LUT coordinates (A4 forte ≈ 0.3).
// This is NOT linear scaling — each key's stiffness, mass, and geometry
// are computed independently from the beam equation.
//
// Material: ASTM A228 spring steel (Falaize Table 4)
var TINE_EI = 180e9 * Math.PI * Math.pow(1e-3, 4) / 4; // 1.414e-4 N⋅m²
var TINE_A4_RAW = 0; // cached: A4 raw amplitude for normalization to LUT coordinates
var TINE_A4_ALPHA = 0; // cached: A4 alphaMax for hammer compliance normalization

// --- Hall (1986) correction: DISABLED ---
// Hall (1986) "Piano string excitation in the case of small hammer mass" assumes
// light hammer / heavy string (piano). Rhodes is the OPPOSITE: heavy hammer (30g)
// / light tine (0.3g). n_max = 0.0073 → suppresses ALL beam modes to <3%.
// Real Rhodes has audible beam modes. Hall correction is inapplicable.
// Beam mode amplitudes now determined purely by physics:
//   spatial ratio (FEM mode shape) × halfSineEnvelope (hammer spectrum)
// The hammer spectrum envelope already provides the correct high-freq rolloff.
var TINE_RHO = 7850;   // kg/m³ (ASTM A228 spring steel)
var TINE_D = 0.001905;  // m (tine diameter, uniform for Original stage)
var TINE_A = Math.PI * (TINE_D / 2) * (TINE_D / 2); // cross-section area

function hallMassCorrection(midi, freqRatio) {
  // Disabled: returns 1.0 for all modes.
  // Physics justification: Rhodes hammer >> tine mass. Hall's piano model
  // (m << M) gives n_max ≈ 0.007, killing all partials. This contradicts
  // measured Rhodes spectra (Gabrielli 2020, Shear 2011) which show
  // audible beam modes at -15 to -25 dB.
  return 1.0;
}

function computeTineAmplitude(midi, velocity) {
  var L_m = tineLength(midi) * 1e-3; // mm → m
  var hammer = getHammerParams(midi, velocity);

  // Per-key stiffness (Euler-Bernoulli cantilever tip)
  var L3 = L_m * L_m * L_m;
  var k_eff = 3 * TINE_EI / L3;

  // Per-zone hammer mass (absolute): relMass × 30g reference (Falaize Table 2)
  var m_hammer = hammer.relMass * 0.030; // kg

  // Per-key mode excitation at striking point
  var xs_m = strikingLine(midi) * 1e-3;
  var xi = Math.min(xs_m / L_m, 0.95);
  var phi = modeExcitation(xi, 0);

  // --- Escapement dynamic range scaling (SM Fig 4-2) ---
  // Smaller escapement (treble) = less room for hammer acceleration = less velocity sensitivity.
  // Bass (7.94mm): full velocity range. Treble (1.59mm): compressed dynamic range.
  // Physics: hammer travel distance limits kinetic energy transfer.
  var escMm = escapementMm(midi);
  var escDynamic = escMm / 7.94; // 1.0 at bass, 0.2 at treble
  var velScaled = Math.pow(velocity, 1.0 / (0.5 + 0.5 * escDynamic));

  // Raw amplitude: √(m / k) × √(velScaled) × φ — different for every key
  var A_raw = Math.sqrt(m_hammer / k_eff) * Math.sqrt(velScaled) * phi;

  // 2026-04-06: couple hammer compliance (alphaMax) into displacement.
  // Codex audit: K_H varies 10-15x (Shore 30→wood) but was NOT in this path.
  // Physics: soft bass hammer (low K_H) → larger Hertz deformation (alphaMax) →
  //   tine receives more impulse → more physical displacement.
  // alphaMax = (5 m_eff v² / (4 K_H))^0.4 — already computed in getHammerParams.
  // IMPORTANT: use fixed velocity (0.5) for compliance comparison only.
  //   alphaMax depends on v0^0.8 — velocity is already in velScaled.
  //   We only want the K_H and m_eff variation across the keyboard.
  var hammerRef = getHammerParams(midi, 0.5); // fixed vel for compliance ratio
  var alphaScale = hammerRef.alphaMax;

  // Compute A4 reference (once) for LUT coordinate normalization
  if (TINE_A4_RAW === 0) {
    var Lr = tineLength(69) * 1e-3; // A4 = MIDI 69
    var Lr3 = Lr * Lr * Lr;
    var k_ref = 3 * TINE_EI / Lr3;
    var hr = getHammerParams(69, 1.0);
    var m_ref = hr.relMass * 0.030;
    var xsr = strikingLine(69) * 1e-3;
    var xir = Math.min(xsr / Lr, 0.95);
    var phir = modeExcitation(xir, 0);
    TINE_A4_RAW = Math.sqrt(m_ref / k_ref) * 1.0 * phir;
    // Store A4 alphaMax for normalization (fixed vel=0.5, same as per-key)
    var hrAlpha = getHammerParams(69, 0.5);
    TINE_A4_ALPHA = hrAlpha.alphaMax;
  }
  // 2026-04-10: alphaNorm REMOVED (was physically backwards).
  //   Previous (2026-04-06) coupled alpha_max (Hertz contact deformation) as a
  //   multiplier on tine amplitude. This was wrong:
  //     - alpha_max is hammer-tine compression distance during contact
  //     - Tine release amplitude depends on MOMENTUM transferred = m*v*(1+COR)
  //     - For elastic collision (m_hammer >> m_tine): v_tine' ≈ v_hammer*(1+COR)
  //     - Wood hammer COR=0.92 → MORE tine velocity than A4 COR=0.65
  //   But alpha_max gave OPPOSITE: wood K_H=1.12e9 → alpha_max=3% of A4 → wood
  //   treble became inaudible. urinami-san reported C5+ barely audible.
  //   A_raw already contains per-key sqrt(m/k) cantilever physics. Per-zone
  //   COR/COR_A4 would be a more physical coupling (~1.16 for wood), but the
  //   existing A_raw + PU nonlinearity already balances well without alphaNorm.

  // Map to PU physical coordinates (25mm normalization):
  // A4 forte tip displacement ≈ 1.5mm (Falaize 2017 Fig 10a) → 1.5/25 = 0.06.
  // 2026-03-25: increased to 0.12 to match Gabrielli H2/H3 spectrum.
  //
  // 2026-04-23 A-4 試行 (tineScale 0.12→0.18 per-key curve): 音量逆U字への効果限定的
  //   (両端 +0.8-1.0 dB、中間不変)。peak 上昇副作用あり。0.12 固定に revert。
  //   詳細: notes/permanent/2026/Rhodes物理モデリングの音量逆U字は...
  var result = (A_raw / TINE_A4_RAW) * 0.12;

  // --- Bass amplitude rolloff DISABLED (2026-03-30) ---
  // Was: 40-100% taper below E3 for DI mode (bass too boomy).
  // Removed: amp chain (V4B + cabinet HPF 180Hz) handles bass naturally.
  // The cabinet's open-back cancellation below 180Hz is the physical bass control.
  // DI mode may need a separate bass compensation if re-enabled later.

  // --- Escapement hard clamp DISABLED (2026-04-07) ---
  // Was: cap tineAmp at escMm/25. But escapement limits HAMMER travel,
  // not tine displacement. Tine amplitude is set by tine stiffness + hammer energy.
  // L644 velScaled already applies escapement to input energy (correct side).
  // This output-side clamp was double-counting AND killing bass dynamic range:
  //   bass escNorm=0.318, but tineAmp with alphaNorm wants ~0.9 → clamped to 0.318.
  // Codex audit 2026-04-07: "escapement clamp on wrong side of model."
  // var escNorm = escMm / 25.0;
  // if (result > escNorm) result = escNorm;

  return result;
}

// --- Per-key variation (deterministic pseudo-random) ---
var KEY_VARIATION = new Float32Array(128 * 3); // [lverOffset, lhorOffset, decayScale] × 128
(function() {
  function hash(s) {
    s = ((s >>> 16) ^ s) * 0x45d9f3b;
    s = ((s >>> 16) ^ s) * 0x45d9f3b;
    return ((s >>> 16) ^ s) / 4294967296;
  }
  for (var k = 0; k < 128; k++) {
    var seed = k * 2654435761;
    KEY_VARIATION[k * 3 + 0] = (hash(seed) - 0.5) * 0.02;     // lverOffset (scaled for new Lver range)
    KEY_VARIATION[k * 3 + 1] = (hash(seed + 1) - 0.5) * 0.04; // lhorOffset
    KEY_VARIATION[k * 3 + 2] = 0.92 + hash(seed + 3) * 0.16;  // decayScale
  }
})();

// --- LUT lookup (linear interpolation, no branching in hot path) ---
function lutLookup(lut, x) {
  // x in [-1, 1] → index in [0, LUT_SIZE-1]
  var pos = (x * 0.5 + 0.5) * LUT_MASK;
  if (pos < 0) pos = 0;
  if (pos > LUT_MASK) pos = LUT_MASK;
  var idx = pos | 0; // floor
  var frac = pos - idx;
  if (idx >= LUT_MASK) return lut[LUT_MASK];
  return lut[idx] + frac * (lut[idx + 1] - lut[idx]);
}

// --- 2x oversampled LUT lookup (matches WaveShaperNode oversample='2x') ---
// Reduces aliasing from nonlinear stages (preamp, poweramp).
// Method: linear-interpolate upsample → 2x LUT → 3-tap halfband downsample.
// Per-voice state: previous input sample (for interpolation).
var _os2x_prev = new Float32Array(MAX_VOICES * 2); // [preamp_prev, poweramp_prev] per voice
var _OS2X_PREAMP = 0;
var _OS2X_POWER = 1;

function lutLookup2x(lut, x, voiceIdx, stageIdx) {
  var prevIdx = voiceIdx * 2 + stageIdx;
  var prev = _os2x_prev[prevIdx];
  _os2x_prev[prevIdx] = x;
  // 2 interpolated samples at 2x rate
  var mid = (prev + x) * 0.5; // midpoint between previous and current
  // LUT at both points
  var y0 = lutLookup(lut, mid);
  var y1 = lutLookup(lut, x);
  // Halfband downsample: weighted average (simple but effective)
  return y0 * 0.25 + y1 * 0.75;
}

// --- Biquad filter state (IIR, direct form II transposed) ---
// coefficients: [b0, b1, b2, a1, a2] (a0 normalized to 1)
// state: [z1, z2]

function biquadProcess(coeff, state, x) {
  var b0 = coeff[0], b1 = coeff[1], b2 = coeff[2], a1 = coeff[3], a2 = coeff[4];
  var y = b0 * x + state[0];
  state[0] = b1 * x - a1 * y + state[1];
  state[1] = b2 * x - a2 * y;
  return y;
}

// --- Biquad coefficient builders (from AudioParam equivalents) ---
function biquadLowpass(freq, Q, fs) {
  var w0 = TWO_PI * freq / fs;
  var cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  var alpha = sinw0 / (2 * Q);
  var a0 = 1 + alpha;
  return [
    ((1 - cosw0) / 2) / a0,
    (1 - cosw0) / a0,
    ((1 - cosw0) / 2) / a0,
    (-2 * cosw0) / a0,
    (1 - alpha) / a0
  ];
}

function biquadHighpass(freq, Q, fs) {
  var w0 = TWO_PI * freq / fs;
  var cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  var alpha = sinw0 / (2 * Q);
  var a0 = 1 + alpha;
  return [
    ((1 + cosw0) / 2) / a0,
    (-(1 + cosw0)) / a0,
    ((1 + cosw0) / 2) / a0,
    (-2 * cosw0) / a0,
    (1 - alpha) / a0
  ];
}

function biquadPeaking(freq, Q, gainDB, fs) {
  var A = Math.pow(10, gainDB / 40);
  var w0 = TWO_PI * freq / fs;
  var cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  var alpha = sinw0 / (2 * Q);
  var a0 = 1 + alpha / A;
  return [
    (1 + alpha * A) / a0,
    (-2 * cosw0) / a0,
    (1 - alpha * A) / a0,
    (-2 * cosw0) / a0,
    (1 - alpha / A) / a0
  ];
}

function biquadBandpass(freq, Q, fs) {
  var w0 = TWO_PI * freq / fs;
  var cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  var alpha = sinw0 / (2 * Q);
  var a0 = 1 + alpha;
  return [
    alpha / a0,
    0,
    -alpha / a0,
    (-2 * cosw0) / a0,
    (1 - alpha) / a0
  ];
}

function biquadLowShelf(freq, gainDB, fs) {
  var A = Math.pow(10, gainDB / 40);
  var w0 = TWO_PI * freq / fs;
  var cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  var alpha = sinw0 / 2 * Math.sqrt(2); // S=1 (slope)
  var sqA = Math.sqrt(A);
  var a0 = (A + 1) + (A - 1) * cosw0 + 2 * sqA * alpha;
  return [
    (A * ((A + 1) - (A - 1) * cosw0 + 2 * sqA * alpha)) / a0,
    (2 * A * ((A - 1) - (A + 1) * cosw0)) / a0,
    (A * ((A + 1) - (A - 1) * cosw0 - 2 * sqA * alpha)) / a0,
    (-2 * ((A - 1) + (A + 1) * cosw0)) / a0,
    ((A + 1) + (A - 1) * cosw0 - 2 * sqA * alpha) / a0
  ];
}

function biquadHighShelf(freq, gainDB, fs) {
  var A = Math.pow(10, gainDB / 40);
  var w0 = TWO_PI * freq / fs;
  var cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  var alpha = sinw0 / 2 * Math.sqrt(2);
  var sqA = Math.sqrt(A);
  var a0 = (A + 1) - (A - 1) * cosw0 + 2 * sqA * alpha;
  return [
    (A * ((A + 1) + (A - 1) * cosw0 + 2 * sqA * alpha)) / a0,
    (-2 * A * ((A - 1) + (A + 1) * cosw0)) / a0,
    (A * ((A + 1) + (A - 1) * cosw0 - 2 * sqA * alpha)) / a0,
    (2 * ((A - 1) - (A + 1) * cosw0)) / a0,
    ((A + 1) - (A - 1) * cosw0 - 2 * sqA * alpha) / a0
  ];
}

// ========================================
// LUT COMPUTATION
// ========================================

// --- B_z from uniformly magnetized cylinder (radius a, height h) at point (rho, z) ---
// On-axis exact formula: B_z(0,z) = (M/2)[z/√(z²+a²) - (z+h)/√((z+h)²+a²)]
// Off-axis extension: replace a² with (a²+ρ²) — "equivalent solenoid" approximation.
//   Exact on-axis (ρ=0), correct far-field, singularity-free.
//   Captures key physics: near-field gradient is steeper than dipole (1/r³).
// z = distance above top face (positive). h = magnet height. a = pole radius.
// Constant prefactor absorbed into reference normalization.
function cylinderBz(rho, z, a, h) {
  var a2rho2 = a * a + rho * rho;
  var rt = Math.sqrt(z * z + a2rho2);
  var zb = z + h;
  var rb = Math.sqrt(zb * zb + a2rho2);
  return z / rt - zb / rb;
}

// --- Shared LUT parameter extraction (used by both dipole and cylinder) ---
// Physical PU dimensions (2026-03-25: corrected from abstract coords to SM values):
//   Lhor: tine-to-pole radial distance ≈ gap + tine radius.
//     SM gap: 0.794mm (mid), 1.588mm (bass/treble). Tine radius: ~1mm.
//     Old: 0.225 (5.6mm) — 7× too far → PU too linear → no H3.
//     New: ~0.06 (1.5mm) at default → matches Gabrielli H2/H3 spectrum.
//   Lver: voicing offset (tine axis vs pole axis).
//     SM: ~1mm typical. Old: 0.088 (2.2mm). New: ~0.03 (0.8mm).
function puLutParams(symmetry, distance, gapMm, qRange, lverOffset, lhorOffset) {
  var sym = symmetry < 0 ? 0 : (symmetry > 1 ? 1 : symmetry);
  // Lver: voicing screw offset. sym=0 → on-axis, sym=1 → max offset ~5mm.
  // 2026-03-27: increased from 0.086 (2.15mm) to 0.2 (5mm).
  // With corrected Lhor=0.06 (1.5mm), old range was inaudible in bass register
  // (large tine displacement makes LUT shift relatively small).
  // Real voicing screw range: ~3-5mm physical travel.
  var Lver = sym * 0.2 + ((lverOffset !== undefined) ? lverOffset : 0);
  // Lhor: physical gap + tine radius. Gap varies per register.
  // 2026-04-23: lhorOffset per-key feed を追加 (Codex 2026-04-07 指摘の sync miss 解消)。
  // KEY_VARIATION[midi*3+1] が ±0.02 range で per-key random variation を提供するが、
  // これまで LUT に渡されず、per-key 個体差 (PU screw voicing の揺らぎ) が消えていた。
  var gap_norm = ((gapMm !== undefined) ? gapMm : 0.794) / 25.0; // mm → normalized
  var tine_radius = 0.04; // ~1mm / 25mm
  var lhorOff = (lhorOffset !== undefined) ? lhorOffset : 0;
  var Lhor = gap_norm + tine_radius + distance * 0.04 + lhorOff; // + per-key PU screw variation
  var qr = (qRange !== undefined && qRange > 0) ? qRange : 1.0;
  return { Lver: Lver, Lhor: Lhor, qr: qr };
}

// --- Dipole PU model (legacy, kept for A/B comparison) ---
function computePickupLUT_dipole(symmetry, distance, gapMm, qRange, lverOffset, lhorOffset) {
  var lut = new Float32Array(LUT_SIZE);
  var p = puLutParams(symmetry, distance, gapMm, qRange, lverOffset, lhorOffset);
  var Lhor2 = p.Lhor * p.Lhor;
  var Rp = 0.2;
  var Rp2 = Rp * Rp;

  for (var i = 0; i < LUT_SIZE; i++) {
    var q = ((i / (LUT_SIZE - 1)) * 2 - 1) * p.qr;
    var d = p.Lver + q;
    var r2 = Lhor2 + d * d + Rp2;
    var r5 = r2 * r2 * Math.sqrt(r2);
    lut[i] = -3.0 * d / r5;
  }
  // 2026-04-23 B-1 試行 revert: per-key normalize は逆効果 (低音 -3〜-4 dB 悪化)。
  // 固定 refPeak は逆に低音 LUT を part boost していた側で、外すと赤字露呈。
  // 詳細: notes/permanent/2026/Rhodes物理モデリングの音量逆U字は...
  var refLver = 0.15, refLhor = 0.25;
  var refR2 = refLhor * refLhor + refLver * refLver + Rp2;
  var refR5 = refR2 * refR2 * Math.sqrt(refR2);
  var refPeak = Math.abs(-3.0 * refLver / refR5);
  if (refPeak > 0) {
    var scale = 0.7 / refPeak;
    for (var i = 0; i < LUT_SIZE; i++) lut[i] *= scale;
  }
  return lut;
}

// --- Cylinder PU model (finite pole piece, physically accurate near-field) ---
// Physics: uniformly magnetized AlNiCo 5 cylinder.
//   a = 5mm (pole radius), h = 12.7mm (magnet height, 1/2 inch).
//   Near-field gradient is much steeper than dipole → stronger nonlinearity
//   at the same tine displacement → bell character.
// LUT stores g'(q) = dBz/dq (axial gradient), computed by numerical differentiation.
// Rhodes PU: AlNiCo 5 (1/2" dia) with pole screw concentrator.
// Effective pole radius = screw tip, not magnet diameter.
// SM Chapter 10: pole screw tip ≈ 3.5mm diameter → radius 1.75mm.
// In normalized coords (÷25mm): 1.75/25 ≈ 0.07. Using 0.14 (3.5mm radius)
// as conservative estimate (field spreads slightly beyond screw tip).
var CYL_A = 0.14;    // effective pole radius in normalized coords (3.5mm / 25mm)
var CYL_H = 0.508;   // magnet height in normalized coords (12.7mm / 25mm)

function computePickupLUT(symmetry, distance, gapMm, qRange, lverOffset, lhorOffset) {
  var lut = new Float32Array(LUT_SIZE);
  var p = puLutParams(symmetry, distance, gapMm, qRange, lverOffset, lhorOffset);
  var dq = 2 * p.qr / (LUT_SIZE - 1);

  // Compute Bz at each sample point
  var Bz = new Float32Array(LUT_SIZE);
  for (var i = 0; i < LUT_SIZE; i++) {
    var q = ((i / (LUT_SIZE - 1)) * 2 - 1) * p.qr;
    Bz[i] = cylinderBz(p.Lhor, p.Lver + q, CYL_A, CYL_H);
  }

  // Numerical derivative: g'(q) = dBz/dq (central difference)
  for (var i = 1; i < LUT_SIZE - 1; i++) {
    lut[i] = (Bz[i + 1] - Bz[i - 1]) / (2 * dq);
  }
  lut[0] = (Bz[1] - Bz[0]) / dq;
  lut[LUT_SIZE - 1] = (Bz[LUT_SIZE - 1] - Bz[LUT_SIZE - 2]) / dq;

  // 2026-04-23 B-1 試行 revert: per-key normalize は逆効果。固定 refPeak に戻す。
  var refBzP = cylinderBz(0.25, 0.15 + dq * 0.5, CYL_A, CYL_H);
  var refBzM = cylinderBz(0.25, 0.15 - dq * 0.5, CYL_A, CYL_H);
  var refPeak = Math.abs((refBzP - refBzM) / dq);
  if (refPeak > 0) {
    var scale = 0.7 / refPeak;
    for (var i = 0; i < LUT_SIZE; i++) lut[i] *= scale;
  }
  return lut;
}

// --- Horizontal (radial) gradient LUT for 2D whirling ---
// Computes g'_h(q) = dBz/dρ at (ρ=Lhor, z=Lver+q).
// The tine's horizontal motion across the pole face creates EMF via this gradient.
function computePickupLUT_horizontal(symmetry, distance, gapMm, qRange, lverOffset, lhorOffset) {
  var lut = new Float32Array(LUT_SIZE);
  var p = puLutParams(symmetry, distance, gapMm, qRange, lverOffset, lhorOffset);
  var drho = p.Lhor * 0.001;  // small perturbation for numerical derivative
  if (drho < 1e-6) drho = 1e-6;

  for (var i = 0; i < LUT_SIZE; i++) {
    var q = ((i / (LUT_SIZE - 1)) * 2 - 1) * p.qr;
    var z_pos = p.Lver + q;
    var BzP = cylinderBz(p.Lhor + drho, z_pos, CYL_A, CYL_H);
    var BzM = cylinderBz(p.Lhor - drho, z_pos, CYL_A, CYL_H);
    lut[i] = (BzP - BzM) / (2 * drho);
  }

  // 2026-04-23 B-1 試行 revert: per-key normalize は逆効果。固定 refPeak に戻す。
  var dq = 2 * p.qr / (LUT_SIZE - 1);
  var refBzP = cylinderBz(0.25, 0.15 + dq * 0.5, CYL_A, CYL_H);
  var refBzM = cylinderBz(0.25, 0.15 - dq * 0.5, CYL_A, CYL_H);
  var refPeak = Math.abs((refBzP - refBzM) / dq);
  if (refPeak > 0) {
    var scale = 0.7 / refPeak;
    for (var i = 0; i < LUT_SIZE; i++) lut[i] *= scale;
  }
  return lut;
}

// computePreampLUT (12AX7 Koren, Twin V1A) removed 2026-04-14 — Twin DSP deleted.

// Exact copy of epiano-engine.js computePickupLUT_Wurlitzer()
function computePickupLUT_Wurlitzer(distance) {
  var lut = new Float32Array(LUT_SIZE);
  var d0 = distance * 0.5 + 0.2;
  for (var i = 0; i < LUT_SIZE; i++) {
    var x = (i / (LUT_SIZE - 1)) * 2 - 1;
    var displacement = x * 0.8;
    lut[i] = 1.0 / (d0 + displacement) - 1.0 / d0;
  }
  var maxVal = 0;
  for (var i = 0; i < LUT_SIZE; i++) {
    if (Math.abs(lut[i]) > maxVal) maxVal = Math.abs(lut[i]);
  }
  if (maxVal > 0) {
    for (var i = 0; i < LUT_SIZE; i++) lut[i] /= maxVal;
  }
  return lut;
}

// computePreampLUT_NE5534 / computePreampLUT_BJT removed 2026-04-14 — only
// Suitcase is left, and it uses the Ge LUT below.

function computePreampLUT_Ge() {
  // Germanium transistor preamp: Shockley-derived soft knee with bias asymmetry
  // Physics: I = Is × (exp(V/nVt) - 1), Ge n≈1.2, Vf≈0.3V
  // Characteristics: earlier compression than Si/tubes, soft/round clipping,
  // asymmetric (negative clips first → 2nd harmonic → warmth)
  // Implementation: bias-shifted tanh. Asymmetry emerges from DC offset,
  // not separate k values (Codex recommendation, matches BJT LUT pattern L1086).
  //
  // 2026-04-22: Peterson 80W Suitcase schematic (fig11-8/11-9) を精読した結果、
  // Suitcase の preamp は 2N3392 Si NPN 2 段 (Germanium ではない)、poweramp は
  // 2N0725 Si BJT push-pull OCL (output transformer なし) であることが判明。
  // Phase 1 では preamp を computePreampLUT_Si2N3392_2stage() に切替。
  // poweramp / output の Ge→Si 訂正は Phase 5 で実施。
  var lut = new Float32Array(LUT_SIZE);
  var bias = 0.08;  // DC bias: negative half compresses earlier → even harmonics
  var k = 1.6;      // Softer knee than BJT (k=2.0) or 12AX7. Ge = round/warm
  for (var i = 0; i < LUT_SIZE; i++) {
    var x = (i / (LUT_SIZE - 1)) * 2 - 1;
    lut[i] = Math.tanh((x + bias) * k);
  }
  // Remove DC offset from bias, then unity-gain normalize
  var centerVal = lut[LUT_SIZE >> 1];
  for (var i = 0; i < LUT_SIZE; i++) lut[i] -= centerVal;
  var maxVal = 0;
  for (var i = 0; i < LUT_SIZE; i++) {
    if (Math.abs(lut[i]) > maxVal) maxVal = Math.abs(lut[i]);
  }
  if (maxVal > 0) {
    for (var i = 0; i < LUT_SIZE; i++) lut[i] /= maxVal;
  }
  return lut;
}

function computePreampLUT_Si2N3392_2stage() {
  // Peterson 80W Suitcase Preamp (fig11-8 Q1, Q2 = selected 2N3392)
  // 2 段 Si NPN common-emitter カスケード。epiano-engine.js の同名関数と同一実装。
  //
  // 物理根拠:
  //   - Si NPN の入出力特性は bias 点周辺で線形 (Vbe 自己 bias)。
  //   - positive swing (Vce → 0) は soft 飽和 (Vbe fully-on)。
  //   - negative swing (Vce → Vcc) は少し硬い knee (cutoff 領域)。
  //   - 2 段カスケード: 小振幅では両段とも線形、大振幅で 1 段目が knee、
  //     2 段目でさらに圧縮 → THD は amplitude で急上昇。
  //
  // 関数形: y = x / (1 + |x|^n)^(1/n)  (smooth saturator)
  //   - 大 n: 線形領域が長く伸び、knee は硬い (cutoff 型)
  //   - 小 n: 早く曲がり、knee は滑らか (saturation 型)
  //
  // 2N3392 CE output 方向との対応:
  //   positive (Vce → Vce_sat, 飽和) = soft = nPos=2
  //   negative (Vce → Vcc, cutoff)  = hard = nNeg=3
  //
  // Phase 1 完了条件 (voicing):
  //   1kHz @ out RMS -40 dBFS: THD < -50 dB (実測 -83 dB)
  //   1kHz @ out RMS -10 dBFS: THD > -34 dB (実測 -26.5 dB)
  //   8kHz vs 1kHz gain 差: < 3 dB (実測 0 dB)
  //
  // Ref: Peterson Stage conversion 80W Service Manual fig11-8
  //      永続ノート Peterson 80W Suitcase の Power Module は Si BJT push-pull
  var lut = new Float32Array(LUT_SIZE);
  var nPos = 2;  // positive soft knee (saturation)
  var nNeg = 3;  // negative hard knee (cutoff)

  function stage(x) {
    var n = x >= 0 ? nPos : nNeg;
    var ax = Math.abs(x);
    return x / Math.pow(1 + Math.pow(ax, n), 1 / n);
  }

  for (var i = 0; i < LUT_SIZE; i++) {
    var x = (i / (LUT_SIZE - 1)) * 2 - 1;
    lut[i] = stage(stage(x));
  }
  return lut;
}

// computePowerampLUT (6L6 push-pull) removed 2026-04-14 — Twin-only.

function computePowerampLUT_Ge() {
  // Germanium push-pull Class AB (Peterson FR7054, 2×40W)
  // Shockley soft knee: n≈1.2, Vf≈0.3V (rounder than Si or vacuum tube)
  // Push-pull cancels even harmonics; crossover notch generates low-level odd harmonics
  var lut = new Float32Array(LUT_SIZE);
  var k = 1.3;            // Ge soft knee (softer than 6L6's 1.5)
  var bias = 0.03;        // Slight asymmetry from Ge matching tolerance
  var notchD = 0.08;      // Class AB crossover notch depth
  var notchW = 0.04;      // Crossover notch width
  for (var i = 0; i < LUT_SIZE; i++) {
    var x = (i / LUT_MASK) * 2 - 1;
    var a = Math.tanh((x + bias) * k);
    var b = Math.tanh((-x + bias) * k);
    var notch = 1.0 - notchD * Math.exp(-x * x / (notchW * notchW));
    lut[i] = (a - b) * 0.5 * notch;
  }
  return normalizeLUTUnityGain(lut);
}

function computeV3DriverLUT() {
  // Exact copy of epiano-engine.js computeV3DriverLUT_12AT7()
  // 12AT7 reverb driver — Koren model, both triode sections paralleled
  // AB763: V3 drives reverb output transformer (Hammond 1750A, 22.8kΩ primary)
  // Transformer-coupled: Vp stays near B+ (no resistive load line)
  var lut = new Float32Array(LUT_SIZE);
  var mu = 60, ex = 1.35, kG1 = 460, kP = 300, kVB = 300;
  var Vgk_bias = -8.2;
  var gridSwing = 10.0;
  var rawOut = new Float32Array(LUT_SIZE);
  for (var i = 0; i < LUT_SIZE; i++) {
    var x = (i / (LUT_SIZE - 1)) * 2 - 1;
    var Vgk = Vgk_bias + x * gridSwing;
    if (Vgk > 0.3) Vgk = 0.3 + (Vgk - 0.3) * 0.02;
    var Vp = 450; // transformer-coupled: plate stays near B+
    var E1 = Math.log(1 + Math.exp(kP * (1 / mu + Vgk / Math.sqrt(kVB + Vp * Vp)))) / kP;
    var Ip = Math.pow(Math.max(E1, 0), ex) / kG1;
    rawOut[i] = Ip * 2; // parallel sections double the current
  }
  var Ip_rest = rawOut[LUT_SIZE >> 1];
  var maxSwing = 0;
  for (var i = 0; i < LUT_SIZE; i++) {
    lut[i] = rawOut[i] - Ip_rest;
    if (Math.abs(lut[i]) > maxSwing) maxSwing = Math.abs(lut[i]);
  }
  if (maxSwing > 0) {
    for (var i = 0; i < LUT_SIZE; i++) lut[i] /= maxSwing;
  }
  return lut;
}

// Normalize LUT to unity center gain
function normalizeLUTUnityGain(lut) {
  var center = LUT_SIZE >> 1;
  var dx = 2.0 / LUT_SIZE;
  var slope = (lut[center + 1] - lut[center - 1]) / (2 * dx);
  if (slope > 1.0) {
    for (var i = 0; i < LUT_SIZE; i++) lut[i] /= slope;
  }
  return lut;
}

// computeTonestackBiquads (Twin tonestack) removed 2026-04-14 — Suitcase
// uses its own Baxandall EQ (biquadLowShelf / biquadHighShelf directly).

// ========================================
// PROCESSOR CLASS
// ========================================

class EpianoWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    console.log('[EP-Worklet] ★ Two-component TB model loaded (ba3ec66)');

    var fs = sampleRate;
    this.fs = fs;
    this.invFs = 1.0 / fs;

    // PU EMF scale: PU_EMF_SCALE × sampleRate converts to physical velocity.
    // With velocity-based amps, the per-voice vVelScale restores the ω-dependent
    // cross-keyboard balance that was implicit in the old displacement×ω scheme.
    this.puEmfScale = PU_EMF_SCALE * fs;

    // --- Voice SoA (Structure of Arrays) ---
    this.vActive       = new Uint8Array(MAX_VOICES);      // 0=free, 1=attack, 2=sustain, 3=releasing
    this.vMidi         = new Uint8Array(MAX_VOICES);
    this.vAge          = new Float64Array(MAX_VOICES);     // samples since noteOn

    // Modal synthesis: up to MAX_MODES per voice (fund, tonebar, beam1..beam7+)
    // Phase accumulators (radians per sample)
    this.vOmega        = new Float64Array(MAX_VOICES * MAX_MODES); // angular frequency / fs
    this.vPhase        = new Float64Array(MAX_VOICES * MAX_MODES); // current phase
    this.vAmp          = new Float32Array(MAX_VOICES * MAX_MODES); // amplitude
    this.vDecayAlpha   = new Float32Array(MAX_VOICES * MAX_MODES); // exp decay per sample: e^(-1/(tau*fs))

    // (No attack buffer needed — all modes are live oscillators with per-sample phase coherence)

    // Tine amplitude (velocity-derived)
    this.vTineAmp      = new Float32Array(MAX_VOICES);

    // Per-voice tip displacement factor (register-dependent physical amplitude scaling).
    this.vTipFactor    = new Float32Array(MAX_VOICES);

    // Per-voice velocity→physical scale: restores ω-dependent cross-keyboard balance.
    // With velocity-based amps, the old implicit ×ω is gone. This per-voice factor
    // = ω₀_fund / vA_fund converts energy-normalized velocity back to physical EMF scale.
    this.vVelScale     = new Float32Array(MAX_VOICES);

    // EM damping (Lenz's law): starts at 1.0, converges to emDampRatio over ~75ms.
    // One-pole smoother: gain = gain * alpha + target * (1 - alpha). No exp() in process().
    this.vEmDampGain   = new Float32Array(MAX_VOICES);  // current gain (starts 1.0)
    this.vEmDampTarget = new Float32Array(MAX_VOICES);  // converges to emDampRatio
    this.vEmDampCoeff  = new Float32Array(MAX_VOICES);  // pre-computed alpha = e^(-1/(0.025*fs))

    // Mechanical decay holdoff: matches old engine where decay starts AFTER EM damp phase (75ms).
    // During holdoff, vAmp stays at initial value. Beam modes ring at full amplitude = bell character.
    this.vDecayHoldoff = new Uint32Array(MAX_VOICES);   // samples to wait before applying decayAlpha

    // Beam attack decay: beam modes start louder (-15dB) and converge to -25dB in 14ms.
    // Per-voice (not per-mode): all beam modes share the same convergence time.
    this.vBeamAttackCount = new Uint32Array(MAX_VOICES);  // countdown (samples remaining)
    this.vBeamAttackAlpha = new Float32Array(MAX_VOICES);  // per-sample extra decay coefficient

    // Hammer contact envelope (Hertz model: half-sine force pulse).
    // During hammer-tine contact (duration Tc), tine accelerates from rest.
    // Tine displacement ∝ ∫∫F(t)dt ≈ (1 - cos(πt/Tc))/2 for half-sine force.
    // After contact (t > Tc), tine vibrates freely at full amplitude.
    // This prevents the unphysical instant-max-velocity at t=0.
    this.vOnsetLen     = new Uint32Array(MAX_VOICES);   // Tc in samples
    this.vOnsetPhase   = new Float32Array(MAX_VOICES);  // π / onsetLen (pre-computed increment)

    // Release envelope
    this.vReleaseAlpha = new Float32Array(MAX_VOICES);     // per-sample release decay
    this.vReleaseGain  = new Float32Array(MAX_VOICES);     // current release multiplier

    // Per-voice PU LUT (each voice gets its own based on register)
    this.vPuLUT        = new Array(MAX_VOICES);
    this.vQRange       = new Float32Array(MAX_VOICES); // LUT physical range per voice
    this.vPosScale     = new Float32Array(MAX_VOICES); // velocity-based position → old displacement scale
    for (var i = 0; i < MAX_VOICES; i++) this.vPuLUT[i] = null;

    // --- 2D Whirling: horizontal fundamental oscillator per voice ---
    // Physics: tine cross-section ≈ circular → 2 axes of similar stiffness.
    // Tuning spring mass breaks symmetry → elliptical orbit.
    // f_h ≈ f₀(1+Δf), A_h = whirlRatio × A_v, phase₀ = π/2.
    this.vOmegaH       = new Float64Array(MAX_VOICES); // horizontal angular freq (rad/sample)
    this.vPhaseH        = new Float64Array(MAX_VOICES); // horizontal phase accumulator
    this.vAmpH          = new Float32Array(MAX_VOICES); // horizontal velocity amplitude
    this.vDecayH        = new Float32Array(MAX_VOICES); // horizontal per-sample decay
    this.vPuLUT_h       = new Array(MAX_VOICES);        // radial gradient LUT per voice
    for (var i = 0; i < MAX_VOICES; i++) this.vPuLUT_h[i] = null;

    // --- Tonebar two-component model (Münster 2014) ---
    // Component A: transient at TB eigenfreq (decaying, "click" attack)
    // Component B: enslaved at tine f0 (ramping up, steady-state 30%)
    // Both are phase accumulators with amplitude envelopes. No ODE needed.
    this.vTbOmegaA     = new Float64Array(MAX_VOICES);  // TB eigenfreq ω (rad/sample)
    this.vTbPhaseA     = new Float64Array(MAX_VOICES);  // transient phase
    this.vTbAmpA       = new Float32Array(MAX_VOICES);  // transient amplitude (30% → 0)
    this.vTbDecayA     = new Float32Array(MAX_VOICES);  // per-sample decay: e^(-1/(τ×fs))
    this.vTbOmegaB     = new Float64Array(MAX_VOICES);  // tine f0 ω (rad/sample)
    this.vTbPhaseB     = new Float64Array(MAX_VOICES);  // enslaved phase
    this.vTbAmpB       = new Float32Array(MAX_VOICES);  // enslaved amplitude (0 → 30%)
    this.vTbTargetB    = new Float32Array(MAX_VOICES);  // target amplitude (30%)
    this.vTbRampB      = new Float32Array(MAX_VOICES);  // per-sample ramp: e^(-1/(τ×fs))
    this.vTbSign       = new Float32Array(MAX_VOICES);  // phase sign (+1/-1, Münster)
    this.coupledTonebar = false; // TB off default (2026-03-27: no perceptual difference confirmed)
    // Per-mode decay multiplier (R). Scales beam mode decay rate relative to current model.
    // Higher = faster beam decay = more transparent. Calibrated by ear.
    // Per-key: linear interpolation from 2 calibration points (2026-03-27 urinami-san).
    //   E2 (MIDI 40) = 2.1, C4 (MIDI 60) = 4.7
    //   Below 40: 2.1 fixed. Above 60: 4.7 fixed.
    //   Perception: bass needs less R (equal-loudness → HF beam modes less audible).
    //   Physics prediction was opposite (bass R larger) — ear includes psychoacoustic filter.
    this.beamDecayR = 0; // 0 = per-key curve (default). >0 = global override (UI slider).

    // --- Mechanical noise state (attack + release) ---
    this.vNoiseSeed        = new Uint32Array(MAX_VOICES);      // LCG PRNG per voice
    // Attack thud (half-sine pulse — uses onset envelope length Tc)
    this.vAttackThudAmp   = new Float32Array(MAX_VOICES);
    // Tine acoustic radiation HPF state (1-pole, per-voice)
    this.vTineRadPrev     = new Float32Array(MAX_VOICES); // x[n-1]
    this.vTineRadState    = new Float32Array(MAX_VOICES); // y[n-1]
    // Mic distance delay for tine radiation (~2ms = air propagation)
    var micDelaySamples = Math.ceil(0.002 * fs); // 2ms ≈ 0.7m mic distance
    this.trDelayLen       = micDelaySamples;
    this.trDelayBuf       = new Float32Array(micDelaySamples + 1);
    this.trDelayWr        = 0;

    // Microphone transfer function (SM58-like dynamic mic)
    // "マイクってPUじゃん" — mic = electromagnetic transducer with its own freq response.
    // Applied to ALL mechanical noise (tine radiation + thud + everything acoustic).
    // SM58 frequency response (calibrated from Shure published data):
    // 50Hz=-7dB, 80Hz=-3dB, 100Hz=-1dB, 200Hz=0dB, 5kHz=+5dB, 10kHz=+3dB, 12kHz=-3dB
    this.micHPFCoeff  = biquadHighpass(100, 0.707, fs);     // -7dB@50Hz, -3dB@80Hz, -1dB@100Hz
    this.micHPFState  = new Float32Array(2);
    this.micProxCoeff = biquadLowShelf(200, 6, fs);       // proximity effect: +6dB below 200Hz (close mic)
    this.micProxState = new Float32Array(2);
    this.micPeakCoeff = biquadPeaking(5000, 0.9, 5, fs);   // presence plateau +5dB (4-7kHz)
    this.micPeakState = new Float32Array(2);
    this.micBrilCoeff = biquadPeaking(10000, 1.5, 3, fs);  // brilliance +3dB @10kHz
    this.micBrilState = new Float32Array(2);
    this.micLPFCoeff  = biquadLowpass(12000, 0.707, fs);   // steep roll-off above 12kHz
    this.micLPFState  = new Float32Array(2);

    // Attack metallic ring (damped sine at beam mode frequency)
    this.vAttackRingOmega  = new Float32Array(MAX_VOICES);     // beam mode angular freq (rad/sample)
    this.vAttackRingOmega2 = new Float32Array(MAX_VOICES);     // 2nd beam mode (for richness)
    this.vAttackRingPhase  = new Float32Array(MAX_VOICES);     // current phase
    this.vAttackRingPhase2 = new Float32Array(MAX_VOICES);
    this.vAttackRingAmp    = new Float32Array(MAX_VOICES);     // current amplitude
    this.vAttackRingDecay  = new Float32Array(MAX_VOICES);     // per-sample decay
    this.vAttackRingLen    = new Uint32Array(MAX_VOICES);
    // Release noise (3 layers: low thud sine + mid mechanism + metallic ring)
    this.vReleaseNoiseLen   = new Uint32Array(MAX_VOICES);
    this.vReleaseThudAmp    = new Float32Array(MAX_VOICES);    // Layer 1: damped sine thud
    this.vReleaseThudDecay  = new Float32Array(MAX_VOICES);
    this.vReleaseThudOmega  = new Float32Array(MAX_VOICES);    // thud angular freq (rad/sample)
    this.vReleaseNoiseAge   = new Uint32Array(MAX_VOICES);
    this.vReleaseMidAmp     = new Float32Array(MAX_VOICES);    // Layer 2: mid mechanism
    this.vReleaseMidDecay   = new Float32Array(MAX_VOICES);
    this.vReleaseMidBPF     = new Float32Array(MAX_VOICES * 5);
    this.vReleaseMidBPFState = new Float32Array(MAX_VOICES * 2);
    // Release metallic ring (Layer 3)
    this.vReleaseRingAmp   = new Float32Array(MAX_VOICES);
    this.vReleaseRingDecay = new Float32Array(MAX_VOICES);
    for (var nn = 0; nn < MAX_VOICES; nn++) this.vReleaseNoiseAge[nn] = 0xFFFFFFFF;

    // Per-voice biquad filter states (coupling HPF)
    // [z1, z2] per voice
    this.vCouplingState = new Float32Array(MAX_VOICES * 2);

    // Twin per-voice tonestack/harp-LCR states removed 2026-04-14 (Phase 0
    // 残クリーン) — they only fed the deleted Twin PU chain.
    // --- Shared chain state ---

    // Reverb send HPF (318Hz, shared)
    this.springSendHPFHz = 318;
    this.springTiltDb = -6;
    this.springSendLPFHz = 5000;
    this.springOutHPFHz = 530;
    this.sendHPFCoeff  = biquadHighpass(this.springSendHPFHz, 0.707, fs);
    this.sendHPFState  = new Float32Array(2);

    // Reverb send bandwidth limiting: highshelf + 2× LPF
    this.sendTiltCoeff = biquadHighShelf(3000, this.springTiltDb, fs);
    this.sendTiltState = new Float32Array(2);
    this.sendLPF1Coeff = biquadLowpass(this.springSendLPFHz, 0.707, fs);
    this.sendLPF1State = new Float32Array(2);
    this.sendLPF2Coeff = biquadLowpass(this.springSendLPFHz, 0.707, fs);
    this.sendLPF2State = new Float32Array(2);

    // === SPRING REVERB — Abel waveguide bank (inline, zero-latency) ===
    // 4AB3C1B-style 2-spring structure: different Td values break the single
    // dominant ringing mode that kept surviving in the mono core.
    this.sr_springs = [
      this._createInlineSpringState(0.066, 0.60, 48271),
      this._createInlineSpringState(0.082, 0.58, 69621)
    ];

    // --- Shared LUTs (all presets pre-computed) ---
    // Twin/Wurlitzer preamp LUTs (12AX7 / NE5534 / BJT / v4bLUT / powerampLUT)
    // removed 2026-04-14 (Phase 0 残クリーン) — they only fed the deleted Twin
    // amp chain. Suitcase keeps its own gePreampLUT + gePowerampLUT below.
    this.v3LUT       = computeV3DriverLUT();
    // Suitcase preamp LUT (Phase 1, 2026-04-22):
    // schematic fig11-8 精読の結果、Peterson 80W は Ge ではなく Si NPN 2N3392
    // 2 段 (selected part 037118)。LUT を Si2N3392_2stage に訂正。
    // 変数名 gePreampLUT は互換維持のため据え置き (Phase 5 で Ge→Si 一括 rename 予定)。
    //
    // Topology/Voicing SSOT 分離ルール (Suitcase_amp_modeling_plan_2026-04-22.md §運用):
    //   - Topology (schematic 由来) = この LUT 関数定義。ここで確定。
    //   - Voicing (drive/gain/trim) = 下記 gePreampDrive / gePreampGain、
    //     および chain 側 `drySum * rhodesLevel * 0.42` 係数。
    //     Voicing 値は urinami さん聴感 A/B で調整する領域で、Phase 1 の
    //     topology 訂正では変更しない。Si LUT は既に知覚可能な非線形を
    //     生成する voicing 範囲 (peak 1.05 → 知覚的に saturation 発生) にある。
    this.gePreampLUT = normalizeLUTUnityGain(computePreampLUT_Si2N3392_2stage());
    this.gePreampDrive = 2.5;  // voicing: Voicing Lab UI で調整 (keys 検証ツール)
    this.gePreampGain = 1.5;   // voicing: Voicing Lab UI で調整 (keys 検証ツール)
    this.suitcasePreFxTrim = 0.42; // voicing: pre-preamp trim, Voicing Lab UI 対応
    this.gePreampPrevSample = 0; // 2x oversampling state
    // Interstage transformer: simplified J-A hysteresis model
    // Physics: B = µ₀(H + M), M tracks magnetization with memory (hysteresis)
    // Anhysteretic: Man = Ms × L(He/a) where L = Langevin function
    // State: M (magnetization), H_prev (previous field for delta detection)
    // Peterson interstage: small transformer, saturates earlier than output transformer
    this.jaMs = 1.0;       // Normalized saturation magnetization
    this.jaA = 1.5;        // Langevin shape (higher = wider/softer knee)
    this.jaK = 0.5;        // Coercivity (hysteresis width)
    this.jaC = 0.4;        // Reversibility (higher = more reversible = less hysteresis)
    this.jaAlpha = 0.001;  // Domain coupling
    this.jaM = 0;          // Magnetization state (HAS MEMORY — this is the hysteresis)
    this.jaHprev = 0;      // Previous H for delta detection
    this.jaHscale = 0.5;   // Input→H scaling (very subtle — Suitcase transformer is small)
    // Phase 4 (2026-04-23): wet/dry blend for gradual bypass->active transition
    // jaWetMix=0: complete bypass (identical to target 2026-04-23 state)
    // jaWetMix=1: full J-A (hysteresis + pre/de-emph)
    // Voicing Lab UI から調整して split 歪みバグの再現と回避を耳検証する
    this.jaWetMix = 0;
    // Pre/de-emphasis: boost lows before J-A, cut after → frequency-dependent saturation
    // Low shelf +6dB at 200Hz before J-A, -6dB after. Stable alternative to integrate/differentiate.
    this.jaPreEmphCoeff = biquadLowShelf(200, 6, fs);
    this.jaPreEmphState = new Float32Array(2);
    this.jaDeEmphCoeff = biquadLowShelf(200, -6, fs);
    this.jaDeEmphState = new Float32Array(2);
    // Germanium power amp (Peterson 2×40W push-pull, coupled to transformer)
    this.gePowerampLUT = computePowerampLUT_Ge();
    this.gePaPrevSample = 0;          // 2x oversampling state
    this.couplingSmooth = 0;          // Smoothed |M|/Ms for drive modulation
    this.couplingAlpha = 0.001;       // ~3.3ms smoothing at 48kHz
    this.couplingDepth = 0.25;        // M→drive modulation depth (0.35→0.25: 透明感)
    this.gePaDrive = 1.6;             // Base power amp drive (1.8→1.6: urinami-san "ほんのちょっと歪まなくていい")
    this.gePaGain = 1.2;              // Post-LUT output gain (level-matched to Pad Sensei MK1 DI)
    this.gePaCompLPFCoeff = biquadLowpass(300, 0.707, fs);  // Band-split for freq-dep compression
    this.gePaCompLPFState = new Float32Array(2);
    // Vactrol stereo tremolo (Peterson incandescent bulb + CdS photocell)
    // Three-stage: LFO → filament thermal LPF → CdS asymmetric response
    this.tremoloOn = false;
    this.tremoloPhase = 0;
    this.tremoloFreq = 4.5;         // Hz (Speed knob, 1-8Hz)
    this.tremoloDepth = 0;          // 0-1 (Intensity knob)
    this.tremoloShape = 5.0;        // tanh shaping (1=sine, 10=square-ish)
    this.filamentTempL = 0;         // Filament temperature state (L)
    this.filamentTempR = 0;         // Filament temperature state (R)
    this.filamentTau = 0.0008;      // 1-pole alpha: τ≈25ms (incandescent pilot lamp thermal)
    this.cdsStateL = 0;             // CdS photocell state (L)
    this.cdsStateR = 0;             // CdS photocell state (R)
    this.cdsAttack = 0.9965;        // ~6ms (light → low resistance, fast CdS attack)
    this.cdsRelease = 0.9985;       // ~13ms (dark → high resistance, asymmetric trailing)
    // Suitcase Baxandall EQ (Peterson FR7054 preamp, NE5534, ±15V)
    // Bass shelf ~200Hz, Treble shelf ~2kHz. Flat at center (tsBass/tsTreble=0.5)
    // Range: ±12dB. Uses same tsBass/tsTreble params as Twin tonestack.
    this.suitcaseBaxBassCoeff   = biquadLowShelf(200, 0, fs);   // 0dB at center
    this.suitcaseBaxTrebleCoeff = biquadHighShelf(2000, 0, fs); // 0dB at center
    this.vBaxState = new Float32Array(MAX_VOICES * 4);          // 2 biquads × 2 states per voice
    // Poweramp 2x oversampling state (shared, post-voice-sum)
    this.paPrevSample = 0;

    // Twin Jensen C12N cabinet biquad state removed 2026-04-13 (Phase 0.3c)
    // — was only fed by the deleted ampType==='twin' shared chain.

    // Suitcase cabinet: Eminence Legend 1258 12"×4 (2 front + 2 rear), near-sealed
    // Source: Eminence T-S params (Fs=94Hz, QTS=0.99, QES=1.18, QMS=6.15)
    // Character: "tight lows, warm smooth mids, upper mid emphasis", 80Hz-4kHz range
    this.suitcaseCabHPFCoeff  = biquadHighpass(90, 0.707, fs);
    this.suitcaseCabResCoeff  = biquadPeaking(94, 1.0, 2.0, fs);    // Fs=94Hz, tight (+2dB, "tight lows")
    this.suitcaseCabPeakCoeff = biquadPeaking(1800, 1.5, 6.0, fs);  // Upper mid emphasis, warm
    this.suitcaseCabLPFCoeff  = biquadLowpass(5500, 0.707, fs);      // Eminence Legend 1258 sealed-cabinet -6dB point ≈5.5kHz (urinami 2026-04-22 実機合わせ)
    // Separate biquad states for Suitcase (no cross-contamination on amp type switch)
    this.suitcaseCabHPFState  = new Float32Array(2);
    this.suitcaseCabResState  = new Float32Array(2);
    this.suitcaseCabPeakState = new Float32Array(2);
    this.suitcaseCabLPFState  = new Float32Array(2);

    this.pickupType  = 'rhodes'; // 'rhodes' or 'wurlitzer'
    this.puModel     = 'cylinder'; // 'cylinder' (default) or 'dipole' (A/B comparison)
    this.whirlEnabled = false;      // OFF: pitch clash investigation (2026-03-29)

    // Per-voice coupling HPF coefficients (3.4Hz, subsonic)
    this.couplingCoeff = biquadHighpass(3.4, 0.707, fs);

    // Twin tonestack coefficients (tsCoeffs) removed 2026-04-14 — Suitcase
    // uses its own Baxandall (suitcaseBaxBassCoeff / suitcaseBaxTrebleCoeff).

    // --- Parameters (updated via MessagePort) ---
    // Voicing screw offset. 0=on-axis, 1=max offset.
    // pickupSymmetry → Lver = sym × 0.25 (normalized PU coordinates).
    // SM data: ~1mm typical voicing offset = Lver ≈ 0.04.
    // Lver affects fundamental H2/H3 (asymmetry) but NOT beam mode intermodulation
    // (beam modes are ÷ω in position → invisible to g'(q)). Confirmed by ear test.
    // H2 target: Gabrielli 2020 measured -12dB (re fundamental).
    // 0.3 → H2 ≈ -15dB. 0.35 → H2 ≈ -12dB (estimated +3dB from increased asymmetry).
    // TODO: verify with compare_spectra.py against Gabrielli companion files.
    this.pickupSymmetry = 0.50; // urinami-san default: bell sweet spot
    this.pickupDistance  = 0.5;
    this.preampGain     = 1.0;
    // tsBass / tsTreble are reused by Suitcase Baxandall EQ (see
    // suitcaseBaxBassCoeff recompute in param handler). tsMid / brightSwitch
    // were Twin-only and were removed 2026-04-14.
    this.tsBass         = 0.5;
    this.tsTreble       = 0.5;
    this.volumePot      = 0.5;
    this.springReverbMix = 0.12;
    this.springDwell    = 6.0;
    this.use2ndPreamp   = true;
    this.useTonestack   = true;
    this.useCabinet     = true;
    this.useSpringReverb = false; // OFF until Nyquist aliasing fixed
    this.springPlacement = 'post_tremolo'; // 'post_tremolo' | 'pre_tremolo'
    this.springInputTrim = 1.0;
    this.springReturnGain = 1.0;
    this.springDriveMix = 1.0;
    this.springExciterMix = 1.0;
    this.springCoreMode = 'full'; // 'full' | 'linear' | 'dispersion_only' | 'dispersion_hf' | 'dispersion_resonator'
    this.springDiagMuteNoteOff = false;
    this.springResonatorMix = 1.0;
    this.springModDepth = 8.0;
    this.springHfMix = 0.0010;
    this.springFeedbackScale = 1.0;
    this.springExciterLp = 0.0;
    this.springExciterCoeff = Math.exp(-1 / (0.004 * fs));
    this.springExciterEnv = 0.0;
    this.springExciterEnvCoeff = Math.exp(-1 / (0.002 * fs));
    this.springAttackEnv = 0.0;
    this.springAttackDecay = Math.exp(-1 / (0.006 * fs));
    // 2026-04-12 Stereo spring wet accumulators (うりなみさん: 空間的な広がりがない).
    // spring tank [0] → L, spring tank [1] → R (Accutronics 4AB3C1B dual spring).
    // Written by _processInlineSpringSample, consumed by the stereo output stage
    // AFTER tremolo (spring is parallel to tremolo in real hardware).
    this._springWetL = 0.0;
    this._springWetR = 0.0;
    // STEREO toggle (UI). true: tank0→L / tank1→R decorrelation,
    // false: mono mix sent to both channels.
    this.springStereoEnabled = true;
    this.ampType        = 'di'; // 'suitcase' | 'di' (Twin removed 2026-04-13, Phase 0.3c)

    // Mechanical noise parameters (0-1 knobs, scale internal constants)
    // Separate signal path: bypasses PU → amp chain (acoustic, not electromagnetic)
    this.attackNoise   = 0;    // Attack thud (set by MECHANICAL slider via params)
    this.releaseNoise  = 0;    // Release thud (set by MECHANICAL slider via params)
    this.releaseRing   = 0;    // Release metallic ring (set by MECHANICAL slider via params)
    this.tineRadiation = 0.0;  // Acoustic tine radiation (-40 to -50dB, glockenspiel-like)
    this.rhodesLevel   = 1.0;  // PU signal level (0=mute PU, hear only mechanical)

    // === Gain staging ===
    // Twin AB763 stage gains (inputAtten / v1aGain / cfGain / tsInsertionLoss /
    // v2bGain / v4bGain / powerGain) removed 2026-04-13 (Phase 0.3c) — those
    // were only used by the deleted Twin DSP. Suitcase has its own Ge chain
    // gains (gePreampDrive / gePreampGain / gePaDrive / gePaGain) declared
    // earlier in this constructor.
    this.dryBusGain     = 0.7;    // Shared dry bus normalization (DI + Suitcase)
    this.cabinetGain    = 3.0;    // Final output scaling (used by Suitcase amp path)
    this.v4aGain        = 5.0;    // reverb recovery (shared spring reverb send chain)
    this.reverbPot      = 0.12;   // shared spring reverb wet level

    // Voice allocation round-robin
    this.nextVoice = 0;

    // --- Sustain pedal state ---
    this.sustainOn = false;
    this.sustainPending = new Uint8Array(128);  // per-MIDI pending release flags

    // --- MessagePort handler ---
    this.port.onmessage = this._onMessage.bind(this);
  }

  _createInlineSpringState(td, ah, seed) {
    var fs = this.fs;
    var fc = 4300;
    var K = fs / (2 * fc);
    var K1 = Math.floor(K);
    if (K1 < 1) K1 = 1;
    var d = K - K1;

    var sp = {
      K1: K1,
      a1: (1 - d) / (1 + d),
      a2: 0.75,
      gRipple: 0.1,
      gEcho: 0.1,
      gMod: 8,
      noiseAint: 0.93,
      noisePrev: 0,
      noiseSeed: seed,
      c1: 0.1,
      hfPrev: 0,
      hfFeedback: 0,
      lfFeedback: 0,
      ah: ah
    };

    var adc = Math.tan(Math.PI / 4 - Math.PI * 40 / fs);
    sp.dcGain = 0.5 * (1 + adc);
    sp.dcA = adc;
    sp.dcPrevX = 0;
    sp.dcPrevY = 0;

    sp.baseDelay = Math.round(td * fs);
    sp.lRipple = Math.round(2 * K * 0.5);

    var dlSize = 256;
    while (dlSize < sp.baseDelay + 128) dlSize *= 2;
    sp.dlLf = new Float32Array(dlSize);
    sp.dlLfMask = dlSize - 1;
    sp.dlLfWr = 0;

    var gDC = Math.pow(10, -3 * sp.baseDelay / (3.0 * fs));
    var gNyq = Math.pow(10, -3 * sp.baseDelay / (0.5 * fs));
    var p = (1 - gNyq / gDC) / (1 + gNyq / gDC);
    sp.lossFiltB = gDC * (1 - p);
    sp.lossFiltA = -p;
    sp.lossFiltPrevY = 0;

    sp.Md = 20;
    var SL = 8;
    while (SL < K1 + 2) SL *= 2;
    sp.SL = SL;
    sp.SM = SL - 1;
    sp.apX = new Float32Array(sp.Md * SL);
    sp.apY = new Float32Array(sp.Md * SL);
    sp.apPtr = new Int32Array(sp.Md);

    sp.Keq = Math.floor(K);
    if (sp.Keq < 1) sp.Keq = 1;
    var R = 1 - (Math.PI * 800 * sp.Keq) / fs;
    if (R < 0) R = 0.01;
    var pCos0 = ((1 + R * R) / (2 * R)) * Math.cos((2 * Math.PI * 1000 * sp.Keq) / fs);
    sp.resA0half = (1 - R * R) / 2 / (1 + R);
    sp.resA1 = -2 * R * pCos0;
    sp.resA2 = R * R;

    var resBufSize = 4;
    while (resBufSize < 2 * sp.Keq + 4) resBufSize *= 2;
    sp.resIn = new Float32Array(resBufSize);
    sp.resOut = new Float32Array(resBufSize);
    sp.resMask = resBufSize - 1;
    sp.resWr = 0;

    var qs = [0.5176, 0.7071, 1.9319];
    sp.lpfCoeff = [];
    sp.lpfState = [];
    for (var qi = 0; qi < 3; qi++) {
      sp.lpfCoeff.push(biquadLowpass(4750, qs[qi], fs));
      sp.lpfState.push(new Float32Array(2));
    }

    var wcOut = Math.tan(Math.PI * this.springOutHPFHz / fs);
    sp.outHpfGain = 1 / (1 + wcOut);
    sp.outHpfA1 = (1 - wcOut) / (1 + wcOut);
    sp.outHpfPrevX = 0;
    sp.outHpfPrevY = 0;

    sp.preDelay = Math.round(td * fs / 2);
    var pdSize = 256;
    while (pdSize < sp.preDelay + 16) pdSize *= 2;
    sp.preDl = new Float32Array(pdSize);
    sp.preDlMask = pdSize - 1;
    sp.preDlWr = 0;

    sp.Mh = 30;
    sp.apHfPrevX = new Float32Array(sp.Mh);
    sp.apHfPrevY = new Float32Array(sp.Mh);
    sp.hfBaseDelay = Math.round(sp.baseDelay / 2.3);
    var dlHfSize = 256;
    while (dlHfSize < sp.hfBaseDelay + 128) dlHfSize *= 2;
    sp.dlHf = new Float32Array(dlHfSize);
    sp.dlHfMask = dlHfSize - 1;
    sp.dlHfWr = 0;

    var gDChf = Math.pow(10, -3 * sp.hfBaseDelay / (2.0 * fs));
    var gNyqhf = Math.pow(10, -3 * sp.hfBaseDelay / (0.3 * fs));
    var phf = (1 - gNyqhf / gDChf) / (1 + gNyqhf / gDChf);
    sp.hfLossB = gDChf * (1 - phf);
    sp.hfLossA = -phf;
    sp.hfLossPrevY = 0;

    return sp;
  }

  _recomputeSpringVoicing() {
    this.sendHPFCoeff = biquadHighpass(this.springSendHPFHz, 0.707, this.fs);
    this.sendTiltCoeff = biquadHighShelf(3000, this.springTiltDb, this.fs);
    this.sendLPF1Coeff = biquadLowpass(this.springSendLPFHz, 0.707, this.fs);
    this.sendLPF2Coeff = biquadLowpass(this.springSendLPFHz, 0.707, this.fs);
    var srWcOut = Math.tan(Math.PI * this.springOutHPFHz / this.fs);
    var outGain = 1 / (1 + srWcOut);
    var outA1 = (1 - srWcOut) / (1 + srWcOut);
    if (this.sr_springs) {
      for (var i = 0; i < this.sr_springs.length; i++) {
        this.sr_springs[i].outHpfGain = outGain;
        this.sr_springs[i].outHpfA1 = outA1;
      }
    }
  }

  _extractSpringExcitation(inputSample) {
    // Weight the spring feed by onset energy, not by injecting a separate
    // signed waveform. This keeps the tank excitation tied to the instrument
    // bus and avoids the "second pitched sound" caused by over-driving the
    // spring with an artificial post-attack component.
    this.springExciterLp = this.springExciterCoeff * this.springExciterLp + (1 - this.springExciterCoeff) * inputSample;
    var transient = inputSample - this.springExciterLp;
    var mag = Math.abs(inputSample);
    this.springExciterEnv = this.springExciterEnvCoeff * this.springExciterEnv + (1 - this.springExciterEnvCoeff) * mag;
    var attackDelta = mag - this.springExciterEnv;
    if (attackDelta < 0) attackDelta = 0;
    if (attackDelta > this.springAttackEnv) this.springAttackEnv = attackDelta;
    else this.springAttackEnv *= this.springAttackDecay;
    var attackBoost = 1.0 + attackDelta * 2.2;
    if (attackBoost > 1.8) attackBoost = 1.8;
    var excited = inputSample * (0.12 * attackBoost) + transient * 0.10;
    return inputSample * (1 - this.springExciterMix) + excited * this.springExciterMix;
  }

  _processInlineSpringTank(inputSample, sp, ch) {
    var dcOut = sp.dcGain * inputSample - sp.dcGain * sp.dcPrevX + sp.dcA * sp.dcPrevY;
    sp.dcPrevX = inputSample;
    sp.dcPrevY = dcOut;

    var lfIn = dcOut + sp.lfFeedback + sp.c1 * sp.hfPrev;
    var hfIn = dcOut + sp.hfFeedback;

    var dlMask = sp.dlLfMask;
    var dlWr = sp.dlLfWr;
    sp.dlLf[dlWr] = lfIn;

    sp.noiseSeed = (sp.noiseSeed * 16807) % 2147483647;
    var noiseRaw = sp.noiseSeed / 2147483647;
    var noiseFilt = (1 - sp.noiseAint) * noiseRaw + sp.noiseAint * sp.noisePrev;
    sp.noisePrev = noiseFilt;

    var L = sp.baseDelay + Math.round(this.springModDepth * noiseFilt);
    if (L < 4) L = 4;
    var lEcho = Math.round(L / 5);
    var lRipple = sp.lRipple;
    var l0 = L - lEcho - lRipple;
    if (l0 < 1) l0 = 1;

    var tap0 = sp.dlLf[(dlWr - l0                     + dlMask + 1) & dlMask];
    var tap1 = sp.dlLf[(dlWr - l0 - lRipple           + dlMask + 1) & dlMask];
    var tap2 = sp.dlLf[(dlWr - l0 - lEcho             + dlMask + 1) & dlMask];
    var tap3 = sp.dlLf[(dlWr - l0 - lEcho - lRipple   + dlMask + 1) & dlMask];
    var rawFb = (sp.gEcho * sp.gRipple * tap0 + sp.gEcho * tap1 + sp.gRipple * tap2 + tap3) * 0.826;

    var lossOut = sp.lossFiltB * rawFb - sp.lossFiltA * sp.lossFiltPrevY;
    sp.lossFiltPrevY = lossOut;
    // 2026-04-11 removed dispersion_resonator lateTailScale attack-gate.
    // The gate attenuated feedback during sustain/release, contradicting
    // Abel waveguide's T60 self-decay design and killing the late tail.
    // Let the loop decay by T60 alone (うりなみさん判断: ディケイ優先)。
    sp.lfFeedback = lossOut * this.springFeedbackScale;
    sp.dlLfWr = (dlWr + 1) & dlMask;

    if (this.springCoreMode === 'linear') {
      var linearPdMask = sp.preDlMask;
      var linearPdWr = sp.preDlWr;
      sp.preDl[linearPdWr] = rawFb;
      var linearWet = sp.preDl[(linearPdWr - sp.preDelay + linearPdMask + 1) & linearPdMask];
      sp.preDlWr = (linearPdWr + 1) & linearPdMask;
      return linearWet;
    }

    var apIn = rawFb;
    var a1 = sp.a1;
    var a2 = sp.a2;
    var a1a2 = a1 * a2;
    for (var s = 0; s < sp.Md; s++) {
      var base = s * sp.SL;
      var wr = sp.apPtr[s];
      sp.apX[base + wr] = apIn;
      var xn1 = sp.apX[base + ((wr - 1 + sp.SL) & sp.SM)];
      var xnK = sp.apX[base + ((wr - sp.K1 + sp.SL) & sp.SM)];
      var xnK1 = sp.apX[base + ((wr - sp.K1 - 1 + sp.SL) & sp.SM)];
      var yn1 = sp.apY[base + ((wr - 1 + sp.SL) & sp.SM)];
      var ynK = sp.apY[base + ((wr - sp.K1 + sp.SL) & sp.SM)];
      var ynK1 = sp.apY[base + ((wr - sp.K1 - 1 + sp.SL) & sp.SM)];
      var apOut = a1 * apIn + a1a2 * xn1 + a2 * xnK + xnK1
                - a2 * yn1 - a1a2 * ynK - a1 * ynK1;
      sp.apY[base + wr] = apOut;
      sp.apPtr[s] = (wr + 1) & sp.SM;
      apIn = apOut;
    }

    var resMixed;
    if (this.springCoreMode === 'dispersion_only' || this.springCoreMode === 'dispersion_hf') {
      resMixed = apIn;
    } else {
      var rMask = sp.resMask;
      var rWr = sp.resWr;
      sp.resIn[rWr] = apIn;
      var resIn2K = sp.resIn[(rWr - 2 * sp.Keq + rMask + 1) & rMask];
      var resOutK = sp.resOut[(rWr - sp.Keq + rMask + 1) & rMask];
      var resOut2K = sp.resOut[(rWr - 2 * sp.Keq + rMask + 1) & rMask];
      var resResult = sp.resA0half * (apIn - resIn2K) - sp.resA1 * resOutK - sp.resA2 * resOut2K;
      // 2026-04-11 removed dispersion_resonator attack-gate on resonator state
      // and mix. The gate collapsed the resonator during sustain/release,
      // eliminating the drip/bloom that gives spring its late-tail character.
      // Let the resonator run freely and decay by its own pole radius R.
      sp.resOut[rWr] = resResult;
      sp.resWr = (rWr + 1) & rMask;
      var resonMix = this.springResonatorMix;
      resMixed = apIn * (1 - resonMix) + resResult * resonMix;
    }

    var hfInput = 0;
    if (this.springCoreMode !== 'dispersion_only' && this.springCoreMode !== 'dispersion_resonator') {
      var hfDlMask = sp.dlHfMask;
      var hfDlWr = sp.dlHfWr;
      sp.dlHf[hfDlWr] = hfIn;
      var Lh = sp.hfBaseDelay + Math.round(this.springModDepth * noiseFilt * 0.4);
      if (Lh < 1) Lh = 1;
      var hfDelayed = sp.dlHf[(hfDlWr - Lh + hfDlMask + 1) & hfDlMask];
      var hfLoss = sp.hfLossB * hfDelayed - sp.hfLossA * sp.hfLossPrevY;
      sp.hfLossPrevY = hfLoss;
      sp.hfFeedback = hfLoss * this.springFeedbackScale;
      sp.dlHfWr = (hfDlWr + 1) & hfDlMask;

      hfInput = hfDelayed;
      for (var hs = 0; hs < sp.Mh; hs++) {
        var hpX = sp.apHfPrevX[hs];
        var hpY = sp.apHfPrevY[hs];
        var ho = sp.ah * hfInput + hpX - sp.ah * hpY;
        sp.apHfPrevX[hs] = hfInput;
        sp.apHfPrevY[hs] = ho;
        hfInput = ho;
      }
      sp.hfPrev = hfInput;
    } else {
      sp.hfFeedback = 0;
      sp.hfPrev = 0;
    }

    var lpfIn = resMixed;
    for (var li = 0; li < 3; li++) lpfIn = biquadProcess(sp.lpfCoeff[li], sp.lpfState[li], lpfIn);

    var outHpf = sp.outHpfGain * (lpfIn - sp.outHpfPrevX) + sp.outHpfA1 * sp.outHpfPrevY;
    sp.outHpfPrevX = lpfIn;
    sp.outHpfPrevY = outHpf;

    var wetRaw = outHpf + hfInput * this.springHfMix;
    var pdMask = sp.preDlMask;
    var pdWr = sp.preDlWr;
    sp.preDl[pdWr] = wetRaw;
    var wetDelayed = sp.preDl[(pdWr - sp.preDelay + pdMask + 1) & pdMask];
    sp.preDlWr = (pdWr + 1) & pdMask;

    return wetDelayed;
  }

  _onMessage(e) {
    var msg = e.data;
    if (!msg) return;

    if (msg.type === 'noteOn') {
      this._noteOn(msg.midi, msg.velocity);
    } else if (msg.type === 'noteOff') {
      this._noteOff(msg.midi);
    } else if (msg.type === 'sustain') {
      this._setSustain(!!msg.on);
    } else if (msg.type === 'params') {
      this._updateParams(msg);
    } else if (msg.type === 'allNotesOff') {
      for (var i = 0; i < MAX_VOICES; i++) this.vActive[i] = 0;
    } else if (msg.type === '_debugDumpPreampLUT') {
      // Phase 1 test hook: worklet 内の実 LUT を main thread から取得する。
      // numeric 比較で worklet と fallback が同一 LUT を使っているか検証する用途。
      // プロダクションではテストからしか呼ばれない。
      var lutCopy = new Float32Array(this.gePreampLUT.length);
      for (var i = 0; i < this.gePreampLUT.length; i++) lutCopy[i] = this.gePreampLUT[i];
      this.port.postMessage({ type: '_debugPreampLUT', lut: lutCopy }, [lutCopy.buffer]);
    } else if (msg.type === '_debugDumpVoicing') {
      // Voicing Lab 確認: worklet 内の実 voicing 値 (drive / gain / pre-fx trim)
      // を main thread に返す。postMessage パイプが届いているか検証する用途。
      this.port.postMessage({
        type: '_debugVoicing',
        gePreampDrive: this.gePreampDrive,
        gePreampGain: this.gePreampGain,
        suitcasePreFxTrim: this.suitcasePreFxTrim,
        ampType: this.ampType,
        useCabinet: this.useCabinet,
      });
    }
  }

  _updateParams(msg) {
    if (msg.pickupSymmetry !== undefined) this.pickupSymmetry = msg.pickupSymmetry;
    if (msg.pickupDistance !== undefined) this.pickupDistance = msg.pickupDistance;
    if (msg.preampGain !== undefined) this.preampGain = msg.preampGain;
    // msg.powerampDrive removed 2026-04-13 — Twin-only param.
    if (msg.volumePot !== undefined) this.volumePot = msg.volumePot;
    // Voicing Lab (keys 検証ツール、2026-04-22) — Phase 1 Si 2N3392 voicing A/B
    if (msg.gePreampDrive !== undefined)   this.gePreampDrive   = Math.max(0.1, +msg.gePreampDrive || 2.5);
    if (msg.gePreampGain !== undefined)    this.gePreampGain    = Math.max(0.01, +msg.gePreampGain || 1.5);
    if (msg.suitcasePreFxTrim !== undefined) this.suitcasePreFxTrim = Math.max(0.01, +msg.suitcasePreFxTrim || 0.42);
    // Phase 4 J-A wet/dry blend (2026-04-23)
    if (msg.jaWetMix !== undefined) this.jaWetMix = Math.max(0, Math.min(1, +msg.jaWetMix || 0));
    if (msg.springReverbMix !== undefined) {
      this.springReverbMix = msg.springReverbMix;
      this.reverbPot = msg.springReverbMix;
    }
    if (msg.springDwell !== undefined) this.springDwell = Math.max(msg.springDwell, 0.5);
    if (msg.use2ndPreamp !== undefined) this.use2ndPreamp = msg.use2ndPreamp;
    // msg.brightSwitch removed 2026-04-14 — Twin-only param.
    if (msg.useTonestack !== undefined) this.useTonestack = msg.useTonestack;
    if (msg.useCabinet !== undefined) this.useCabinet = msg.useCabinet;
    if (msg.useSpringReverb !== undefined) this.useSpringReverb = msg.useSpringReverb;
    if (msg.springPlacement !== undefined) this.springPlacement = msg.springPlacement || 'post_tremolo';
    if (msg.springInputTrim !== undefined) this.springInputTrim = msg.springInputTrim;
    if (msg.springReturnGain !== undefined) this.springReturnGain = msg.springReturnGain;
    if (msg.springDriveMix !== undefined) this.springDriveMix = msg.springDriveMix;
    if (msg.springExciterMix !== undefined) this.springExciterMix = msg.springExciterMix;
    if (msg.springCoreMode !== undefined) this.springCoreMode = msg.springCoreMode || 'full';
    if (msg.springCoreLinear !== undefined) this.springCoreMode = msg.springCoreLinear ? 'linear' : 'full';
    if (msg.springDiagMuteNoteOff !== undefined) this.springDiagMuteNoteOff = !!msg.springDiagMuteNoteOff;
    if (msg.springResonatorMix !== undefined) this.springResonatorMix = msg.springResonatorMix;
    if (msg.springModDepth !== undefined) this.springModDepth = msg.springModDepth;
    if (msg.springHfMix !== undefined) this.springHfMix = msg.springHfMix;
    if (msg.springFeedbackScale !== undefined) this.springFeedbackScale = msg.springFeedbackScale;
    if (msg.springStereoEnabled !== undefined) this.springStereoEnabled = !!msg.springStereoEnabled;
    var springVoicingChanged = false;
    if (msg.springSendHPFHz !== undefined) { this.springSendHPFHz = msg.springSendHPFHz; springVoicingChanged = true; }
    if (msg.springTiltDb !== undefined) { this.springTiltDb = msg.springTiltDb; springVoicingChanged = true; }
    if (msg.springSendLPFHz !== undefined) { this.springSendLPFHz = msg.springSendLPFHz; springVoicingChanged = true; }
    if (msg.springOutHPFHz !== undefined) { this.springOutHPFHz = msg.springOutHPFHz; springVoicingChanged = true; }
    if (springVoicingChanged) this._recomputeSpringVoicing();
    if (msg.ampType !== undefined) this.ampType = msg.ampType;
    if (msg.tremoloOn !== undefined) this.tremoloOn = msg.tremoloOn;
    if (msg.tremoloFreq !== undefined) this.tremoloFreq = msg.tremoloFreq;
    if (msg.tremoloDepth !== undefined) this.tremoloDepth = msg.tremoloDepth;
    if (msg.coupledTonebar !== undefined) this.coupledTonebar = msg.coupledTonebar;
    if (msg.beamDecayR !== undefined) this.beamDecayR = msg.beamDecayR;
    if (msg.attackNoise !== undefined) this.attackNoise = msg.attackNoise;
    if (msg.releaseNoise !== undefined) this.releaseNoise = msg.releaseNoise;
    if (msg.releaseRing !== undefined) this.releaseRing = msg.releaseRing;
    if (msg.tineRadiation !== undefined) this.tineRadiation = msg.tineRadiation;
    if (msg.rhodesLevel !== undefined) this.rhodesLevel = msg.rhodesLevel;

    // Amp chain params (dev sliders)
    // msg.v1aGain / v2bGain / v4bGain / powerGain removed 2026-04-13 —
    // Twin AB763 stage gains, no longer applied anywhere.
    if (msg.cabinetGain !== undefined) this.cabinetGain = msg.cabinetGain;
    // Twin Jensen cabinet filter inputs (msg.cabHPFFreq / cabPeakFreq /
    // cabLPFFreq) removed 2026-04-13 (Phase 0.3c) — the cab*Coeff/State
    // arrays they recomputed are gone too.

    // Recompute Suitcase Baxandall EQ (tsBass / tsTreble were formerly shared
    // with Twin tonestack knobs — Twin DSP removed 2026-04-13, the knobs now
    // drive only the Baxandall low-shelf / high-shelf pair).
    if (msg.tsBass !== undefined || msg.tsTreble !== undefined) {
      if (msg.tsBass !== undefined) this.tsBass = msg.tsBass;
      if (msg.tsTreble !== undefined) this.tsTreble = msg.tsTreble;
      var baxBassDB = (this.tsBass - 0.5) * 24;     // ±12dB
      var baxTrebleDB = (this.tsTreble - 0.5) * 24;  // ±12dB
      this.suitcaseBaxBassCoeff = biquadLowShelf(200, baxBassDB, this.fs);
      this.suitcaseBaxTrebleCoeff = biquadHighShelf(2000, baxTrebleDB, this.fs);
    }

    // msg.preampType removed 2026-04-14 — Twin/Wurlitzer preamp LUT selector,
    // no longer applied since the Twin chain is gone. Suitcase uses gePreampLUT.
    if (msg.pickupType !== undefined) {
      this.pickupType = msg.pickupType || 'rhodes';
    }
    if (msg.puModel !== undefined) {
      this.puModel = msg.puModel || 'cylinder';
    }
    if (msg.whirlEnabled !== undefined) {
      this.whirlEnabled = !!msg.whirlEnabled;
    }
  }

  _noteOn(midi, velocity) {
    var fs = this.fs;

    // Find free voice or steal oldest
    var vi = -1;
    for (var i = 0; i < MAX_VOICES; i++) {
      var idx = (this.nextVoice + i) % MAX_VOICES;
      if (this.vActive[idx] === 0) { vi = idx; break; }
    }
    if (vi < 0) {
      // Steal oldest voice
      var oldest = 0;
      var oldestAge = 0;
      for (var i = 0; i < MAX_VOICES; i++) {
        if (this.vAge[i] > oldestAge) { oldestAge = this.vAge[i]; oldest = i; }
      }
      vi = oldest;
    }
    this.nextVoice = (vi + 1) % MAX_VOICES;

    // --- Compute mode parameters ---
    var kvi = midi * 3;
    var decayScale = (midi >= 0 && midi < 128) ? KEY_VARIATION[kvi + 2] : 1.0;

    var f0 = 440 * Math.pow(2, (midi - 69) / 12);
    var Q = interpolateQ(midi);
    var tau = Q / (Math.PI * f0);
    var hammer = getHammerParams(midi, velocity);
    var massScale = Math.sqrt(hammer.relMass);
    // Velocity-dependent beam decay: disabled for A/B testing.
    // Old: 1.0 - velocity * 0.4 → forte kills beam modes 40% faster → "string-like".
    // Physics: higher amplitude = slightly more air damping, but 40% is not physical.
    // Real Rhodes beam modes persist at all velocities (bell ≠ velocity dependent).
    var velDecayScale = 1.0;

    // Spatial excitation from FEM tapered beam mode shapes (7 beam modes)
    // Pre-computed by tools/compute_tapered_modes.py (Third Stage taper)
    var L_mm = tineLength(midi);
    var keyIdx = midi - 21;
    var nyquist = fs * 0.5;

    // === VELOCITY-BASED MODAL AMPLITUDE (energy conservation) ===
    // Hammer impulse excites each mode with velocity ∝ φ_n(xs) × H(f_n) × Hall.
    // Energy: E_n ∝ V_n². Normalize Σ V_n² = 1 (finite hammer KE).
    var H_fund = halfSineEnvelope(f0, hammer.Tc, hammer.spectralBeta);
    var vW_fund = 1.0;
    var totalE = vW_fund * vW_fund;

    // Compute beam mode weights (skip modes above Nyquist)
    // GC-zero: use pre-allocated scratch arrays (avoid [] allocation)
    var nActive = 2; // slots 0=fundamental, 1=tonebar, 2+=beam modes
    // Scratch: reuse vOmega/vAmp arrays temporarily (they'll be overwritten below)
    // Instead, compute inline and store directly.

    // --- Tonebar two-component model (Münster 2014) ---
    // Physics: forced damped oscillator = transient at ω₂ + steady-state at ω₁.
    // Instead of integrating the ODE (discretization issues at high damping),
    // decompose into two components with crossfading envelopes:
    //   Component A (transient): oscillates at TB eigenfreq, amplitude 30% → 0 (τ=5ms)
    //   Component B (enslaved): oscillates at tine f0, amplitude 0 → 30% (τ=5ms)
    //   Total always ≈ 30%. Frequency content changes over 10-14ms. FM sidebands natural.
    var hasTB = hasTonebar(midi);
    var tbEigenHz = hasTB ? tonebarEigenFreq(midi) : 0;

    // Pre-compute beam mode data: freq, spatial ratio, velocity weight
    // Store in SoA slots directly. Slots: 0=fund, 1=tonebar, 2..2+N_BEAM_MODES-1=beams
    var base = vi * MAX_MODES;
    var omega0 = TWO_PI * f0 * this.invFs;

    // Slot 0: fundamental
    this.vOmega[base] = omega0;
    this.vPhase[base] = 0;
    this.vDecayAlpha[base] = Math.exp(-this.invFs / Math.max(tau * decayScale, 0.001));
    // vAmp[base] set after energy normalization

    // Slot 1: tonebar — forced damped oscillator OR old enslaving model
    if (this.coupledTonebar && hasTB) {
      // --- Two-component tonebar model (new) ---
      // A = transient at TB eigenfreq, B = enslaved at tine f0
      var tbOmega = TWO_PI * tbEigenHz * this.invFs;
      var tbTau = 0.005; // 5ms crossfade (Münster: 10-14ms visible, 5ms = 63%)
      var tbDecay = Math.exp(-this.invFs / tbTau);
      var tbAmpTarget = 0.30; // Münster: 30% of tine amplitude

      // Component A: transient (starts at 30%, decays to 0)
      this.vTbOmegaA[vi] = tbOmega;
      this.vTbPhaseA[vi] = 0;
      this.vTbAmpA[vi] = tbAmpTarget;
      this.vTbDecayA[vi] = tbDecay;

      // Component B: enslaved (starts at 0, ramps to 30%)
      this.vTbOmegaB[vi] = omega0;
      this.vTbPhaseB[vi] = 0;
      this.vTbAmpB[vi] = 0;
      this.vTbTargetB[vi] = tbAmpTarget;
      this.vTbRampB[vi] = tbDecay;

      this.vTbSign[vi] = tonebarPhase(midi);

      // Disable slot 1 phase accumulator (replaced by two-component)
      this.vOmega[base + 1] = 0;
      this.vPhase[base + 1] = 0;
      this.vAmp[base + 1] = 0;
      this.vDecayAlpha[base + 1] = 0;
    } else if (hasTB) {
      // --- Old slot 1 model DISABLED (2026-03-29) ---
      // TB eigenfreq (e.g. 164Hz at F4) is BELOW fundamental (349Hz) → sounds like
      // a separate low sine wave, creates "muddy cylinder" perception.
      // TB off until coupled model or correct parameters are implemented.
      this.vOmega[base + 1] = 0;
      this.vPhase[base + 1] = 0;
      this.vAmp[base + 1] = 0;
      this.vDecayAlpha[base + 1] = 0;
      this.vTbOmegaA[vi] = 0; this.vTbAmpA[vi] = 0;
      this.vTbOmegaB[vi] = 0; this.vTbAmpB[vi] = 0;
      this.vTbSign[vi] = 0;
    } else {
      // No tonebar
      this.vOmega[base + 1] = 0; this.vPhase[base + 1] = 0;
      this.vAmp[base + 1] = 0; this.vDecayAlpha[base + 1] = 0;
      this.vTbOmegaA[vi] = 0; this.vTbAmpA[vi] = 0;
      this.vTbOmegaB[vi] = 0; this.vTbAmpB[vi] = 0;
      this.vTbSign[vi] = 0;
    }

    // Beam modes: slots 2..2+N_BEAM_MODES-1
    // Velocity weights for beam modes (pre-energy-normalization)
    for (var b = 0; b < N_BEAM_MODES; b++) {
      var beamFreq = f0 * BEAM_FREQ_RATIOS[b];
      if (beamFreq >= nyquist) {
        // Above Nyquist: zero out this and all higher modes
        for (var z = b; z < N_BEAM_MODES; z++) {
          this.vOmega[base + 2 + z] = 0;
          this.vPhase[base + 2 + z] = 0;
          this.vAmp[base + 2 + z] = 0;
          this.vDecayAlpha[base + 2 + z] = 0;
        }
        break;
      }

      // Spatial ratio from FEM table (or fallback)
      var sr;
      if (keyIdx >= 0 && keyIdx < 88 && b < BEAM_N_RATIOS) {
        sr = BEAM_SPATIAL_RATIO[keyIdx * BEAM_N_RATIOS + b];
      } else {
        // Fallback: uniform E-B (only for modes 0-2, higher = 0)
        if (b < 3) {
          var xs_mm = strikingLine(midi);
          var xi = Math.min(xs_mm / L_mm, 0.95);
          var tipW = hammerTipWidth(midi);
          var bandNorm = tipW / L_mm;
          var sFund = bandModeExcitation(xi, bandNorm, 0);
          var sBeam = bandModeExcitation(xi, bandNorm, b + 1);
          sr = sBeam / Math.max(Math.abs(sFund), 0.001);
        } else {
          sr = 0;
        }
      }

      // Beam mode velocity weight = spatial ratio × hammer spectrum.
      // halfSineEnvelope: Hunt-Crossley viscoelastic force spectrum.
      //
      // Physics: FEM spatial ratios + half-sine envelope underestimate beam coupling.
      // Two known sources not yet modeled:
      //   (1) Tuning spring mass (α≈0.6-0.8) near beam mode antinodes → coupling ×1.5-2
      //   (2) Hertz F∝α^1.5 has sharper peak than half-sine → more HF energy ≈ ×1.5
      // Base coefficient 3.0 is an estimate. TODO: derive from #1594 per-key spring data.
      //
      // Low-bass scaling fix (2026-03-24):
      // Problem: long Tc (bass) → halfSineEnvelope passes all freqs → H_beam/H_fund ≈ 1.0
      //   → beam mode amplitude = sr × 1.0 × 3.0 ≈ fundamental level (way too loud).
      // Physics: neoprene is softer in bass → absorbs HF → beam modes should be WEAKER.
      // Fix: scale beam boost by how much the hammer spectrum actually filters.
      //   When H_ratio → 1.0 (no filtering, bass): boost → baseBoost × 0.3
      //   When H_ratio → 0.0 (strong filtering, treble): boost → baseBoost × 1.0
      //   beamBoost = baseBoost × (1.0 - 0.7 × H_ratio)
      var H_beam = halfSineEnvelope(beamFreq, hammer.Tc, hammer.spectralBeta);
      var H_ratio = H_beam / Math.max(H_fund, 0.001);
      if (H_ratio > 1.0) H_ratio = 1.0;
      // Beam boost: compensates for FEM+halfSine underestimation of beam coupling.
      // Base 3.0 (spring + Hertz), scaled by hammer filtering.
      // Cap: beam mode velocity weight must not exceed 0.3 (≈ -10dB re fundamental).
      // Real Rhodes beam modes: -15 to -25dB (Gabrielli 2020).
      // Without cap: bass beam1 reaches 0dB → chord intermod → pitch confusion.
      var beamBoost = 3.0 * (1.0 - 0.7 * H_ratio);
      var vW = sr * H_ratio * beamBoost;
      // Beam attack decay (2026-03-27): beam modes start at -15dB (attack),
      // fast-decay to -25dB (sustain) in 14ms. This produces the "コリッ" metallic
      // transient during attack without sustained chord pitch confusion.
      // Previous -25dB hard clamp killed all attack character (3/25 failure).
      if (vW > BEAM_ATTACK_CLAMP) vW = BEAM_ATTACK_CLAMP;
      if (vW < -BEAM_ATTACK_CLAMP) vW = -BEAM_ATTACK_CLAMP;

      // Energy normalization uses SUSTAIN clamp to preserve fundamental amplitude.
      // Beam modes are "over-budget" only during the 14ms attack window.
      var vW_energy = Math.abs(vW);
      if (vW_energy > BEAM_SUSTAIN_CLAMP) vW_energy = BEAM_SUSTAIN_CLAMP;

      // Store beam mode in SoA
      var slot = base + 2 + b;
      this.vOmega[slot] = TWO_PI * beamFreq * this.invFs;
      this.vPhase[slot] = 0;
      // Per-key R: piecewise linear interpolation from 5 ear-calibration points.
      // R < 1: beam mode persists longer (bass). R > 1: beam mode decays faster (treble).
      // R < 0: beam mode amplitude actively suppressed (init amplitude reduced).
      // 2026-03-29: R values halved from 3/28 to extend beam mode sustain (透明感).
      // Old: C1=-0.9, E1=0.1, E2=2.1, C4=4.7, C6=8.0 → beam modes vanish too fast.
      // New: flatter curve. Beam modes persist longer → richer spectrum → transparency.
      // UI slider overrides when > 0 (for calibration). 0 = use per-key curve.
      var R;
      if (this.beamDecayR > 0) {
        R = this.beamDecayR;
      } else {
        if (midi <= 21) R = 0.08;
        else if (midi <= 28) R = 0.08 + (0.12 - 0.08) * (midi - 21) / (28 - 21);
        else if (midi <= 40) R = 0.12 + (0.5 - 0.12) * (midi - 28) / (40 - 28);
        else if (midi <= 60) R = 0.5 + (1.5 - 0.5) * (midi - 40) / (60 - 40);
        else if (midi <= 84) R = 2.0 + (3.5 - 2.0) * (midi - 60) / (84 - 60);
        else R = 3.5;
      }
      // R < 0: suppress beam mode initial amplitude (not decay rate).
      // R = -1 → beam amplitude × 0. R = -0.5 → beam amplitude × 0.5.
      var beamAmpScale = 1.0;
      var Reff = R;
      if (R < 0) {
        beamAmpScale = Math.max(0, 1.0 + R); // R=-0.5 → 0.5, R=-1 → 0
        Reff = 0.1; // use minimal positive R for decay calc
      }
      var beamTau = tau / (BEAM_FREQ_RATIOS[b] * Reff);
      this.vDecayAlpha[slot] = Math.exp(-this.invFs / Math.max(beamTau * decayScale * velDecayScale, 0.001));
      // Store raw weight temporarily in vAmp (will be overwritten after normalization)
      this.vAmp[slot] = vW * beamAmpScale;
      totalE += (vW_energy * beamAmpScale) * (vW_energy * beamAmpScale);
      nActive = 2 + b + 1;
    }

    // Zero out unused slots beyond active beam modes
    for (var z = nActive; z < MAX_MODES; z++) {
      this.vOmega[base + z] = 0;
      this.vPhase[base + z] = 0;
      this.vAmp[base + z] = 0;
      this.vDecayAlpha[base + z] = 0;
    }

    // Energy normalization: Σ V_n² = 1
    var eNorm = 1.0 / Math.sqrt(Math.max(totalE, 0.01));
    var vA_fund = vW_fund * eNorm;

    // Write normalized amplitudes
    this.vAmp[base] = vA_fund * massScale; // fundamental
    // Slot 1 amplitude: set in noteOn tonebar branch (0 for coupled model, tonebarAmp for old)
    // Only overwrite if old model is active (coupledTonebar already set vAmp[base+1] = 0)
    if (!this.coupledTonebar || !hasTB) {
      this.vAmp[base + 1] = (this.vAmp[base + 1] || 0) * massScale;
    }
    for (var b = 0; b < N_BEAM_MODES; b++) {
      var slot = base + 2 + b;
      if (this.vOmega[slot] > 0) {
        this.vAmp[slot] = this.vAmp[slot] * eNorm * massScale; // was raw weight, now normalized
      }
    }

    // Beam attack decay: converge from ATTACK_CLAMP to SUSTAIN_CLAMP in 14ms.
    // After this window, beam modes are at chord-safe level. Normal sustain decay continues.
    var beamAttackSamples = Math.ceil(BEAM_ATTACK_MS * 0.001 * fs);
    this.vBeamAttackCount[vi] = beamAttackSamples;
    this.vBeamAttackAlpha[vi] = Math.exp(
      Math.log(BEAM_SUSTAIN_CLAMP / BEAM_ATTACK_CLAMP) / beamAttackSamples
    );

    // EM damping (Lenz's law): per-key physics.
    var massRatio = L_mm / 43.0;
    var puCoupling = 1.1 - this.pickupDistance;
    if (puCoupling < 0) puCoupling = 0;
    var puDampStrength = velocity * puCoupling / Math.max(massRatio, 0.3);
    if (puDampStrength > 1) puDampStrength = 1;
    var emDampRatio = 1.0 - puDampStrength * 0.4;
    this.vEmDampGain[vi]   = 1.0;
    this.vEmDampTarget[vi] = emDampRatio;
    var emTau = 0.025 * Math.sqrt(massRatio);
    this.vEmDampCoeff[vi]  = Math.exp(-this.invFs / emTau);

    this.vTineAmp[vi] = computeTineAmplitude(midi, velocity);

    var onsetSamples = Math.max(Math.ceil(hammer.Tc * fs), 2);
    this.vOnsetLen[vi] = onsetSamples;
    this.vOnsetPhase[vi] = Math.PI / onsetSamples;

    this.vDecayHoldoff[vi] = Math.ceil(0.15 * fs);

    // Per-voice physical parameters
    var tipFactor = tipDisplacementFactor(midi);
    this.vTipFactor[vi] = tipFactor;

    // Velocity→physical scale: converts energy-normalized velocity to old EMF scale.
    // Old scheme: EMF ∝ (disp × ω₀) × tipFactor × puEmfScale → ω₀ was implicit.
    // New scheme: EMF ∝ vAmp × vVelScale × tipFactor × puEmfScale.
    // Match condition: vA_fund × vVelScale = 1.0 × ω₀ → vVelScale = ω₀ / vA_fund.
    this.vVelScale[vi] = omega0 / Math.max(vA_fund, 0.01);

    var gapMm = puGapMm(midi);
    // qRange: LUT covers [-qRange, +qRange] of physical PU field.
    // Magnetic dipole (1/r³) field decays steeply → effective nonlinear region is narrow.
    //
    // 2026-04-06 fix (Codex audit + signal path trace):
    // Old: qRange = tipFactor × 0.4. Bass tipFactor ~5 → qRange 0.8 (capped).
    //   Result: puPos_max ≈ sin/0.8 = 1.25 → barely reaches PU nonlinear region.
    //   A4:     puPos_max ≈ sin/0.4 = 2.5  → deep into nonlinear → rich H2/H3.
    //   Root cause of thin bass: 3× less PU nonlinearity than treble.
    //
    // Physics: PU nonlinear region width is set by AlNiCo pole radius (Rp≈6.35mm),
    //   NOT by tine displacement. Longer tines move more, but the "interesting"
    //   g'(q) nonlinear zone is the same physical width for every key.
    //   → qRange should NOT scale linearly with tipFactor.
    //
    // Fix: compress tipFactor influence with pow(0.15).
    //   v1 pow(0.3): Bass puPos +22-62%.
    //   v2 pow(0.15): urinami-san confirmed "ローズになった".
    //   v3 fixed 0.35: too much distortion — reverted.
    //   urinami-san: 歪んじゃダメ。DI is clean. Body without distortion.
    //   v4: 0.5 — still too much distortion.
    //   v5: 0.65 — "歪むちょっと前" = just before distortion onset.
    //   DI should be clean so amp adds distortion only on accents.
    // 2026-04-23 A-3 試行 (pow 0.8): 音量逆U字に部分効果 (両端 +0.7-0.9 dB)
    //   だが逆U字構造は残存。LUT normalize 相殺が支配。v2 (pow 0.15) に revert。
    //   詳細: notes/permanent/2026/Rhodes物理モデリングの音量逆U字は...
    var qRange = Math.pow(tipFactor, 0.15) * 0.65;
    if (qRange < 0.12) qRange = 0.12;
    if (qRange > 0.8) qRange = 0.8;
    // Position scale factor: converts velocity-based position to old displacement scale.
    // Old: tinePosition = 1.0 × sin × envScale (displacement domain)
    // New: tinePosition = (vA_fund/ω₀) × sin × envScale (velocity/ω domain)
    // → scale down by ω₀/vA_fund to match old LUT input range.
    this.vQRange[vi] = qRange;
    this.vPosScale[vi] = omega0 / Math.max(vA_fund, 0.01);
    var lverOff = (midi >= 0 && midi < 128) ? KEY_VARIATION[midi * 3] : 0;
    var lhorOff = (midi >= 0 && midi < 128) ? KEY_VARIATION[midi * 3 + 1] : 0;
    if (this.pickupType === 'wurlitzer') {
      this.vPuLUT[vi] = computePickupLUT_Wurlitzer(this.pickupDistance);
      this.vPuLUT_h[vi] = null; // no whirling for Wurlitzer (electrostatic, symmetric)
    } else if (this.puModel === 'dipole') {
      this.vPuLUT[vi] = computePickupLUT_dipole(this.pickupSymmetry, this.pickupDistance, gapMm, qRange, lverOff, lhorOff);
      this.vPuLUT_h[vi] = null; // dipole has no horizontal LUT
    } else {
      this.vPuLUT[vi] = computePickupLUT(this.pickupSymmetry, this.pickupDistance, gapMm, qRange, lverOff, lhorOff);
      this.vPuLUT_h[vi] = computePickupLUT_horizontal(this.pickupSymmetry, this.pickupDistance, gapMm, qRange, lverOff, lhorOff);
    }

    // --- 2D Whirling: horizontal fundamental oscillator ---
    // Physics: tine cantilever with ~circular cross-section + spring mass asymmetry.
    // keyNorm: 0 (bass) to 1 (treble). Bass has more spring effect → more whirl.
    var keyNorm = Math.max(0, Math.min(1, (midi - 21) / 87));
    // Detuning: 0.5-1.5% (bass has larger spring → more asymmetry → larger Δf)
    var whirlDetuning = 0.005 + 0.01 * (1 - keyNorm);
    // Amplitude ratio: 15-25% of vertical (spring mass creates substantial elliptical orbit)
    var whirlRatio = 0.15 + 0.1 * (1 - keyNorm);

    if (this.pickupType !== 'wurlitzer' && this.puModel !== 'dipole' && this.whirlEnabled) {
      this.vOmegaH[vi] = omega0 * (1 + whirlDetuning);
      this.vPhaseH[vi] = Math.PI * 0.5; // 90° offset → elliptical orbit
      this.vAmpH[vi] = this.vAmp[base] * whirlRatio; // fraction of vertical fundamental
      this.vDecayH[vi] = this.vDecayAlpha[base]; // same decay as vertical fundamental
    } else {
      this.vOmegaH[vi] = 0;
      this.vPhaseH[vi] = 0;
      this.vAmpH[vi] = 0;
      this.vDecayH[vi] = 0;
    }

    // Reset filter states
    this.vCouplingState[vi * 2] = 0;
    this.vCouplingState[vi * 2 + 1] = 0;
    // vTsState / vHarpLCRState resets removed 2026-04-14 — Twin per-voice
    // tonestack + harp LCR states are gone with the Twin PU chain.
    _os2x_prev[vi * 2 + _OS2X_PREAMP] = 0;
    _os2x_prev[vi * 2 + _OS2X_POWER] = 0;

    // Reset release
    this.vReleaseGain[vi] = 1.0;
    this.vReleaseAlpha[vi] = 1.0; // no release yet

    // --- Mechanical noise initialization ---
    // Attack noise: BPF-filtered white noise burst at hammer impact.
    // Added to tineVelocity → bypasses onset envelope → PU EMF picks it up.
    // Attack thud: half-sine pulse during hammer contact (0 to Tc).
    // Same shape as onset envelope but on the ACOUSTIC path (bypasses PU).
    // Duration = Tc (already in vOnsetLen). No extra state needed.
    this.vAttackThudAmp[vi] = ATTACK_THUD_SCALE * this.vTineAmp[vi];
    this.vNoiseSeed[vi] = (midi * 7919 + 1) | 0;
    // Reset tine radiation HPF state (prevents click from stale state)
    this.vTineRadPrev[vi] = 0;
    this.vTineRadState[vi] = 0;
    // Release ring: beam mode frequencies for metallic character
    var omega0PerSample = omega0 / fs;
    var ringOmega1 = omega0PerSample * BEAM_FREQ_RATIOS[0]; // 7.11× f₀
    var ringOmega2 = omega0PerSample * BEAM_FREQ_RATIOS[1]; // 20.25× f₀
    if (ringOmega1 > Math.PI) ringOmega1 = 0;
    if (ringOmega2 > Math.PI) ringOmega2 = 0;
    this.vAttackRingOmega[vi] = ringOmega1;
    this.vAttackRingOmega2[vi] = ringOmega2;
    var relRingTau = RELEASE_RING_DECAY_MS * 0.001;
    this.vReleaseRingDecay[vi] = Math.exp(-this.invFs / relRingTau);
    this.vReleaseRingAmp[vi] = 0; // set at noteOff
    // Release Layer 1: low thud (damped sine — "ドン")
    var relThudTau = RELEASE_THUD_DECAY_MS * 0.001;
    var relNoiseTotal = Math.max(relThudTau * 5, RELEASE_MID_DECAY_MS * 0.005, RELEASE_RING_DECAY_MS * 0.005);
    this.vReleaseNoiseLen[vi] = Math.ceil(relNoiseTotal * fs);
    this.vReleaseThudAmp[vi] = RELEASE_THUD_SCALE * this.vTineAmp[vi];
    this.vReleaseThudDecay[vi] = Math.exp(-this.invFs / relThudTau);
    this.vReleaseThudOmega[vi] = TWO_PI * RELEASE_THUD_FREQ / fs;
    this.vReleaseNoiseAge[vi] = 0xFFFFFFFF;
    // Release Layer 2: mid mechanism
    var relMidTau = RELEASE_MID_DECAY_MS * 0.001;
    this.vReleaseMidAmp[vi] = RELEASE_MID_SCALE * this.vTineAmp[vi];
    this.vReleaseMidDecay[vi] = Math.exp(-this.invFs / relMidTau);
    var midBPF = biquadBandpass(RELEASE_MID_FREQ, RELEASE_MID_Q, fs);
    for (var nc3 = 0; nc3 < 5; nc3++) this.vReleaseMidBPF[vi * 5 + nc3] = midBPF[nc3];
    this.vReleaseMidBPFState[vi * 2] = 0;
    this.vReleaseMidBPFState[vi * 2 + 1] = 0;

    // Activate
    this.vActive[vi] = 1;
    this.vMidi[vi] = midi;
    this.vAge[vi] = 0;
  }

  _setSustain(on) {
    if (on) {
      this.sustainOn = true;
    } else {
      // Pedal released: clear sustainOn FIRST, then release all pending notes
      this.sustainOn = false;
      for (var m = 0; m < 128; m++) {
        if (this.sustainPending[m]) {
          this.sustainPending[m] = 0;
          this._noteOff(m);  // safe: sustainOn is false, normal release fires
        }
      }
    }
  }

  _noteOff(midi) {
    // Sustain pedal gate: if pedal is down, queue the release for later
    if (this.sustainOn) {
      this.sustainPending[midi & 0x7f] = 1;
      return;
    }
    // Release all voices with this MIDI note
    for (var i = 0; i < MAX_VOICES; i++) {
      if (this.vActive[i] > 0 && this.vMidi[i] === midi && this.vActive[i] !== 3) {
        if (this.springDiagMuteNoteOff && this.useSpringReverb && this.springPlacement === 'pre_tremolo') {
          this.vActive[i] = 0;
          this.vReleaseNoiseAge[i] = 0xFFFFFFFF;
          continue;
        }
        this.vActive[i] = 3; // releasing
        this.vReleaseAlpha[i] = Math.exp(-this.invFs / 0.015); // 15ms release
        // Do NOT clear biquad states here — causes click from sudden state reset
        // while PU signal is still decaying through the amp chain.
        // Trigger release noise: damper felt contacts vibrating tine → EMF spike.
        // Amplitude scales with CURRENT tine amplitude (not initial).
        // Staccato → tine still vibrating hard → louder release noise.
        // Long sustain → tine decayed → quieter release noise.
        // Physics: damper impact energy ∝ tine velocity at contact moment.
        var currentAmp = this.vTineAmp[i] * this.vEmDampGain[i] * this.vReleaseGain[i];
        // All 3 release layers scale with current tine amplitude
        this.vReleaseThudAmp[i] = RELEASE_THUD_SCALE * currentAmp;
        this.vReleaseMidAmp[i] = RELEASE_MID_SCALE * currentAmp;
        this.vReleaseRingAmp[i] = RELEASE_RING_SCALE * currentAmp;
        this.vReleaseNoiseAge[i] = 0;
        this.vReleaseMidBPFState[i * 2] = 0;
        this.vReleaseMidBPFState[i * 2 + 1] = 0;
      }
    }
  }


  _processInlineSpringSample(inputSample) {
    var sendSum = inputSample * this.springInputTrim;
    // 2026-04-11 INPUT attack-gate kept (preserves うりなみさん認定のアタック感).
    // Only transients excite the spring — sustain/release doesn't re-drive it.
    // The late tail is produced by the feedback loop's own T60 decay, which is
    // why we removed the attack-gate on feedback/resonator inside _processInlineSpringTank.
    if (this.springCoreMode === 'dispersion_resonator') {
      sendSum *= Math.min(1.0, this.springAttackEnv * 36.0);
    }

    // HPF 318Hz
    {
      var sc = this.sendHPFCoeff;
      var sz1 = this.sendHPFState[0], sz2 = this.sendHPFState[1];
      var sOut = sc[0] * sendSum + sz1;
      this.sendHPFState[0] = sc[1] * sendSum - sc[3] * sOut + sz2;
      this.sendHPFState[1] = sc[2] * sendSum - sc[4] * sOut;
      sendSum = sOut;
    }
    // V3 drive + nonlinearity
    sendSum *= this.springDwell;
    var v3Out = lutLookup(this.v3LUT, sendSum);
    sendSum = sendSum * (1 - this.springDriveMix) + v3Out * this.springDriveMix;
    // Highshelf tilt
    {
      var tc = this.sendTiltCoeff;
      var tz1 = this.sendTiltState[0], tz2 = this.sendTiltState[1];
      var tOut = tc[0] * sendSum + tz1;
      this.sendTiltState[0] = tc[1] * sendSum - tc[3] * tOut + tz2;
      this.sendTiltState[1] = tc[2] * sendSum - tc[4] * tOut;
      sendSum = tOut;
    }
    // LPF 5kHz × 2
    {
      var lc = this.sendLPF1Coeff;
      var lz1 = this.sendLPF1State[0], lz2 = this.sendLPF1State[1];
      var lOut = lc[0] * sendSum + lz1;
      this.sendLPF1State[0] = lc[1] * sendSum - lc[3] * lOut + lz2;
      this.sendLPF1State[1] = lc[2] * sendSum - lc[4] * lOut;
      sendSum = lOut;
    }
    {
      var lc2 = this.sendLPF2Coeff;
      var lz1b = this.sendLPF2State[0], lz2b = this.sendLPF2State[1];
      var lOut2 = lc2[0] * sendSum + lz1b;
      this.sendLPF2State[0] = lc2[1] * sendSum - lc2[3] * lOut2 + lz2b;
      this.sendLPF2State[1] = lc2[2] * sendSum - lc2[4] * lOut2;
      sendSum = lOut2;
    }

    var wetSum = 0;
    var wetTap0 = 0, wetTap1 = 0;
    var springCount = this.sr_springs ? this.sr_springs.length : 0;
    for (var si = 0; si < springCount; si++) {
      var wTank = this._processInlineSpringTank(sendSum, this.sr_springs[si], si);
      wetSum += wTank;
      if (si === 0) wetTap0 = wTank;
      else if (si === 1) wetTap1 = wTank;
    }
    if (springCount > 1) wetSum /= springCount;
    var gainFinal = this.v4aGain * this.reverbPot * this.springReturnGain;
    // 2026-04-12 Stereo tap: Accutronics 4AB3C1B dual spring natural L/R
    // decorrelation. Consumed by stereo output stage after tremolo.
    // STEREO toggle: when disabled, both channels receive the mono sum.
    if (springCount >= 2 && this.springStereoEnabled) {
      this._springWetL = wetTap0 * gainFinal;
      this._springWetR = wetTap1 * gainFinal;
    } else {
      var monoWet = wetSum * gainFinal;
      this._springWetL = monoWet;
      this._springWetR = monoWet;
    }
    return wetSum * gainFinal;
  }

  _getSuitcaseSpringInput(inputSample) {
    // Suitcase external reverb should follow the sustained musical line.
    // The attack-emphasized exciter used for Twin diagnostics makes single
    // notes feel almost dry while chords over-trigger the spring.
    return inputSample;
  }

  process(inputs, outputs, parameters) {
    var output = outputs[0];
    if (!output || !output[0]) return true;

    var outL = output[0];
    var outR = output.length > 1 ? output[1] : outL;
    var blockSize = outL.length;

    // Check if any voice is active (skip processing if silent)
    var anyActive = 0;
    for (var v = 0; v < MAX_VOICES; v++) {
      if (this.vActive[v] > 0) { anyActive = 1; break; }
    }
    if (!anyActive) {
      // 2026-04-12 うりなみさん判定: リリースが超不自然（ブチッと切れる）
      // Root cause: early return cut the spring reverb feedback loop before
      // the tail could self-decay. Now we keep processing while the spring
      // state is still above a tiny threshold, then early-return when silent.
      var tailAlive = false;
      if (this.useSpringReverb && this.sr_springs) {
        for (var ti = 0; ti < this.sr_springs.length; ti++) {
          var spTail = this.sr_springs[ti];
          if (Math.abs(spTail.lfFeedback) > 1e-6 ||
              Math.abs(spTail.lossFiltPrevY) > 1e-6) {
            tailAlive = true;
            break;
          }
        }
      }
      if (!tailAlive) {
        for (var i = 0; i < blockSize; i++) { outL[i] = 0; outR[i] = 0; }
        return true;
      }
      // Fall through: voice loop skips all inactive voices (no work), but
      // the spring feedback loop continues self-decaying via
      // _processInlineSpringSample inside the sample loop below.
    }

    var fs = this.fs;
    var invFs = this.invFs;

    // Temp buffers (per-block, reused — allocated once in constructor would be better
    // but blockSize is typically 128 and this is acceptable)
    // Actually, we process sample-by-sample, so we just need per-sample accumulators.

    for (var i = 0; i < blockSize; i++) {
      // --- Per-voice synthesis → sum to dry/DI bus ---
      var drySum = 0;
      var diSum = 0;  // DI path: per-voice harp LPF then direct output
      var sendSum = 0; // reverb send (post-tonestack, pre-V2B)
      var suitcasePreFxSum = 0; // Suitcase: post-Baxandall/Volume, pre-Ge-preamp (reverb send domain)
      var mechanicalNoiseSum = 0; // acoustic noise: bypasses PU → amp chain entirely
      var tineRadSum = 0; // tine radiation accumulator (delayed separately)

      for (var v = 0; v < MAX_VOICES; v++) {
        if (this.vActive[v] === 0) continue;

        var age = this.vAge[v];
        var base = v * MAX_MODES;

        // --- 0. Tonebar two-component model (Münster 2014) ---
        // A = transient at TB eigenfreq (30% → 0, τ=5ms)
        // B = enslaved at tine f0 (0 → 30%, τ=5ms)
        // Both contribute to tinePosition/tineVelocity.
        // FM sidebands arise naturally from A+B superposition through PU nonlinearity.
        var tbContribPos = 0;
        var tbContribVel = 0;
        {
          var tbOmegaA = this.vTbOmegaA[v];
          if (tbOmegaA > 0) {
            var tbSign = this.vTbSign[v];

            // Component A: transient at TB eigenfreq (decaying)
            var ampA = this.vTbAmpA[v];
            if (ampA > 0.0001) {
              var phaseA = this.vTbPhaseA[v];
              tbContribPos += (ampA / tbOmegaA) * Math.sin(phaseA) * tbSign;
              tbContribVel += ampA * Math.cos(phaseA) * tbSign;
              this.vTbAmpA[v] = ampA * this.vTbDecayA[v];
              this.vTbPhaseA[v] = phaseA + tbOmegaA;
              if (this.vTbPhaseA[v] > TWO_PI) this.vTbPhaseA[v] -= TWO_PI;
            }

            // Component B: enslaved at tine f0 (ramping up, then decaying with tine)
            var tbOmegaB = this.vTbOmegaB[v];
            var ampB = this.vTbAmpB[v];
            var targetB = this.vTbTargetB[v];
            // One-pole ramp: ampB → targetB
            ampB = ampB * this.vTbRampB[v] + targetB * (1.0 - this.vTbRampB[v]);
            // Decay target along with tine fundamental (same mechanical system)
            this.vTbTargetB[v] = targetB * this.vDecayAlpha[base]; // fund decay
            this.vTbAmpB[v] = ampB;
            if (ampB > 0.0001) {
              var phaseB = this.vTbPhaseB[v];
              tbContribPos += (ampB / tbOmegaB) * Math.sin(phaseB) * tbSign;
              tbContribVel += ampB * Math.cos(phaseB) * tbSign;
              this.vTbPhaseB[v] = phaseB + tbOmegaB;
              if (this.vTbPhaseB[v] > TWO_PI) this.vTbPhaseB[v] -= TWO_PI;
            }
          }
        }

        // --- 1. Modal synthesis (sample-by-sample, phase-coherent) ---
        // Compute BOTH tine position and velocity.
        // Position q(t) = Σ(amp × sin(phase)) — drives PU LUT (= g'(q), Falaize eq 25-27)
        // Velocity dq/dt = Σ(amp × ω × cos(phase)) — EMF ∝ g'(q) × dq/dt (Faraday)
        // Velocity is computed analytically (no digital differentiation → no harmonic boost artifacts).
        var tinePosition = 0;
        var tineVelocity = 0;

        // Beam attack decay: hoist per-voice values outside mode loop (GC zero)
        var beamAttackRemaining = this.vBeamAttackCount[v];
        var beamAttackAlpha = this.vBeamAttackAlpha[v];

        for (var m = 0; m < MAX_MODES; m++) {
          var omega = this.vOmega[base + m];
          if (omega === 0) continue;

          var amp = this.vAmp[base + m];
          if (Math.abs(amp) < 0.0001) continue;

          var phase = this.vPhase[base + m];

          // Mechanical decay starts immediately (no holdoff).
          var env = amp;
          this.vAmp[base + m] *= this.vDecayAlpha[base + m];

          // Beam attack decay: extra fast decay for beam modes (m >= 2) during first 14ms.
          // Converges beam modes from -15dB (attack) to -25dB (sustain, chord-safe).
          // After counter expires, beam modes continue with normal sustain decay only.
          if (m >= 2 && beamAttackRemaining > 0) {
            this.vAmp[base + m] *= beamAttackAlpha;
          }

          // Velocity-based: vAmp is velocity amplitude.
          // Position = (V/ω) × sin(phase) — ÷ω suppresses high-freq displacement.
          // Velocity = V × cos(phase) — direct from stored amplitude.
          tinePosition += (env / omega) * Math.sin(phase);
          tineVelocity += env * Math.cos(phase);

          // Advance phase
          this.vPhase[base + m] = phase + omega;
          if (this.vPhase[base + m] > TWO_PI) {
            this.vPhase[base + m] -= TWO_PI;
          }
        }

        // Decrement beam attack counter (once per voice, outside mode loop)
        if (beamAttackRemaining > 0) {
          this.vBeamAttackCount[v] = beamAttackRemaining - 1;
        }

        // Add tonebar forced oscillator contribution (before envScale)
        tinePosition += tbContribPos;
        tineVelocity += tbContribVel;

        // Apply EM damping (Lenz's law): one-pole smoother, 1.0 → emDampRatio over ~75ms.
        {
          var emAlpha = this.vEmDampCoeff[v];
          var emTarget = this.vEmDampTarget[v];
          this.vEmDampGain[v] = this.vEmDampGain[v] * emAlpha + emTarget * (1.0 - emAlpha);
        }

        // Hammer contact envelope: during Tc, tine accelerates from rest.
        // Hammer contact envelope: half-sine onset over Tc (Hertz model).
        // During contact, tine accelerates from rest → displacement and velocity
        // both ramp from zero. This is physically correct: no instant full-amplitude.
        // With master compressor removed, this no longer creates "slow attack" illusion.
        var onsetGain = 1.0;
        if (age < this.vOnsetLen[v]) {
          onsetGain = (1.0 - Math.cos(age * this.vOnsetPhase[v])) * 0.5;
        }
        var envScale = this.vTineAmp[v] * this.vEmDampGain[v] * onsetGain;
        tinePosition *= envScale;
        tineVelocity *= envScale;

        // Apply release envelope
        if (this.vActive[v] === 3) {
          this.vReleaseGain[v] *= this.vReleaseAlpha[v];
          var relGain = this.vReleaseGain[v];
          tinePosition *= relGain;
          tineVelocity *= relGain;
          if (relGain < 0.0001) {
            this.vActive[v] = 0; // voice done
            this.vTineRadPrev[v] = 0; // clear HPF to prevent click on next note
            this.vTineRadState[v] = 0;
            continue;
          }
        }

        // --- 1a. Mechanical noise (SEPARATE SIGNAL PATH) ---
        // Acoustic mechanical noise bypasses PU → amp chain entirely.
        // In real recordings, microphones pick up both:
        //   (a) PU → amp → speaker → mic (electrical path)
        //   (b) Instrument body → air → mic (acoustic path)
        // AAS/Pianoteq/every sample library includes this acoustic layer.
        // Without it: correct spectrum but no "realness" (実機感 ≠ 楽器同定).
        //
        // Attack: low-freq thud at hammer separation (neoprene is soft → no HF)
        // Release: metallic "damper kiss" — damper bounces on vibrating tine
        //          + broadband damper felt thud

        // Acoustic tine radiation: raw tine vibration heard through air.
        // Glockenspiel-like, thin, bright, no PU coloring. -40 to -50dB.
        // tineVelocity already includes envScale (onset + release envelopes).
        // Acoustic tine radiation: brief metallic shimmer at attack only.
        // Very thin (HPF ~2kHz), very short (15ms decay), very quiet.
        // Acoustic tine radiation: raw signal, no HPF (HPF caused residual noise).
        // Delay (2ms) alone creates phase difference → spatial thickness.
        // Acoustic tine radiation: physics-based.
        // Radiation efficiency η ∝ f² (thin rod, diameter << wavelength).
        // Implementation: differentiation (sample[n] - sample[n-1]) ≈ ×jω.
        // FIR — no feedback, no state accumulation, no residual noise.
        // Naturally boosts beam modes, suppresses fundamental. Physics, not workaround.
        if (this.attackNoise > 0) {
          var acousticVel = tineVelocity * this.vVelScale[v] * this.vTipFactor[v] * this.puEmfScale;
          var trDiff = acousticVel - this.vTineRadPrev[v]; // ≈ d/dt ∝ ω → radiation ∝ f
          this.vTineRadPrev[v] = acousticVel;
          // Tine radiation follows MECHANICAL knob (fixed ratio: tine is dominant)
          tineRadSum += trDiff * this.attackNoise * 1.15;
        }

        // Attack thud: single half-sine lobe (no oscillation, no pitch, no burst).
        // sin(π×t/T): rises from 0, peaks, returns to 0. Completely smooth.
        // "丸い" — like pressing a palm against a drum head.
        var noiseAge = age - this.vOnsetLen[v]; // 0 at separation moment
        var atkThudLen = Math.ceil(0.015 * this.fs); // 15ms — slow, round
        if (noiseAge >= 0 && noiseAge < atkThudLen) {
          var thudEnv = Math.sin(Math.PI * noiseAge / atkThudLen);
          mechanicalNoiseSum += thudEnv * this.vAttackThudAmp[v] * this.attackNoise * 2.0;
        }

        // Release: "Damper Kiss" — damper bounces on vibrating tine (EP Forum: Ben Bove)
        // Metallic ring (beam mode re-excitation) + broadband thud (felt impact)
        var relAge = this.vReleaseNoiseAge[v];
        if (relAge < this.vReleaseNoiseLen[v]) {
          var rSeed = this.vNoiseSeed[v];
          rSeed = (rSeed * 16807) % 2147483647;
          if (rSeed === 0) rSeed = 1;
          this.vNoiseSeed[v] = rSeed;
          var relWhite = (rSeed / 1073741823.5) - 1.0;

          // Layer 1: Low thud — damped sine with soft onset (avoids click)
          var thudAmp = this.vReleaseThudAmp[v];
          if (thudAmp > 0.00001) {
            // Fade-in over first 96 samples (~2ms) — gentler, less harsh
            var fadein = relAge < 96 ? relAge / 96.0 : 1.0;
            mechanicalNoiseSum += Math.sin(relAge * this.vReleaseThudOmega[v]) * thudAmp * fadein * this.releaseNoise * 2.0;
            this.vReleaseThudAmp[v] = thudAmp * this.vReleaseThudDecay[v];
          }

          // Layer 2: Mid mechanism (springs, damper arm, 1400Hz)
          var mOff = v * 5;
          var mb0 = this.vReleaseMidBPF[mOff], mb1 = this.vReleaseMidBPF[mOff+1], mb2 = this.vReleaseMidBPF[mOff+2];
          var ma1 = this.vReleaseMidBPF[mOff+3], ma2 = this.vReleaseMidBPF[mOff+4];
          var msOff = v * 2;
          var mz1 = this.vReleaseMidBPFState[msOff], mz2 = this.vReleaseMidBPFState[msOff+1];
          var mFiltered = mb0 * relWhite + mz1;
          this.vReleaseMidBPFState[msOff]   = mb1 * relWhite - ma1 * mFiltered + mz2;
          this.vReleaseMidBPFState[msOff+1] = mb2 * relWhite - ma2 * mFiltered;

          var mAmp = this.vReleaseMidAmp[v];
          mechanicalNoiseSum += mFiltered * mAmp * this.releaseNoise * 2.0;
          this.vReleaseMidAmp[v] = mAmp * this.vReleaseMidDecay[v];

          // Metallic ring: damper bounce re-excites beam modes (with fade-in)
          var relRingAmp = this.vReleaseRingAmp[v];
          var ringScale = this.releaseRing * 2.0;
          if (relRingAmp > 0.00001 && ringScale > 0) {
            var ringFade = relAge < 24 ? relAge / 24.0 : 1.0; // 0.5ms fade-in
            var relRingOm = this.vAttackRingOmega[v];
            if (relRingOm > 0) {
              mechanicalNoiseSum += Math.sin(relAge * relRingOm) * relRingAmp * ringScale * ringFade;
            }
            var relRingOm2 = this.vAttackRingOmega2[v];
            if (relRingOm2 > 0) {
              mechanicalNoiseSum += Math.sin(relAge * relRingOm2) * relRingAmp * ringScale * ringFade * 0.3;
            }
            this.vReleaseRingAmp[v] = relRingAmp * this.vReleaseRingDecay[v];
          }

          this.vReleaseNoiseAge[v] = relAge + 1;
        }

        // --- 1b. Horizontal fundamental (2D whirling) ---
        // Physics: tine whirls in elliptical orbit. Horizontal oscillator is slightly
        // detuned from vertical → creates slow amplitude modulation (shimmer).
        // Only fundamental whirls; beam modes have nodes that suppress horizontal motion.
        var tineHVelocity = 0;
        var omegaH = this.vOmegaH[v];
        if (omegaH > 0) {
          var ampH = this.vAmpH[v];
          if (Math.abs(ampH) > 0.0001) {
            var phaseH = this.vPhaseH[v];
            tineHVelocity = ampH * Math.cos(phaseH) * envScale;
            // Apply release envelope to horizontal too
            if (this.vActive[v] === 3) tineHVelocity *= this.vReleaseGain[v];
            // Decay and phase advance
            this.vAmpH[v] = ampH * this.vDecayH[v];
            this.vPhaseH[v] = phaseH + omegaH;
            if (this.vPhaseH[v] > TWO_PI) this.vPhaseH[v] -= TWO_PI;
          }
        }

        // --- 2. PU EMF (2D: vertical + horizontal) ---
        // Vertical: g'_v(q_v) × dq_v/dt (axial field gradient × vertical velocity)
        // Horizontal: g'_h(q_v) × dq_h/dt (radial gradient at current vertical pos × horizontal velocity)
        var puOut;
        if (this.vPuLUT[v]) {
          var puPos = tinePosition * this.vPosScale[v] / this.vQRange[v];
          // (debug removed)
          var gPrimeV = lutLookup(this.vPuLUT[v], puPos);
          puOut = gPrimeV * tineVelocity * this.vVelScale[v] * this.vTipFactor[v] * this.puEmfScale;
          // Horizontal contribution (2D whirling)
          if (this.vPuLUT_h[v] && tineHVelocity !== 0) {
            var gPrimeH = lutLookup(this.vPuLUT_h[v], puPos);
            puOut += gPrimeH * tineHVelocity * this.vVelScale[v] * this.vTipFactor[v] * this.puEmfScale;
          }
        } else {
          puOut = tinePosition; // fallback: no LUT
        }

        // --- 3. Coupling HPF (3.4Hz, removes DC) --- inline biquad (no array alloc)
        var stateOff = v * 2;
        var couplingOut;
        {
          var b0 = this.couplingCoeff[0], b1 = this.couplingCoeff[1], b2 = this.couplingCoeff[2];
          var a1 = this.couplingCoeff[3], a2 = this.couplingCoeff[4];
          var z1 = this.vCouplingState[stateOff], z2 = this.vCouplingState[stateOff + 1];
          couplingOut = b0 * puOut + z1;
          this.vCouplingState[stateOff] = b1 * puOut - a1 * couplingOut + z2;
          this.vCouplingState[stateOff + 1] = b2 * puOut - a2 * couplingOut;
        }

        var sig = couplingOut;

        if (this.useCabinet) {

          if (this.ampType === 'suitcase') {
            // === SUITCASE PATH (Peterson FR7054) ===
            // Self-contained amp: no external cable → no harp LCR (internal C≈50-100pF → transparent)
            // Signal path: DI → Baxandall EQ → Volume → [shared: Ge Preamp → Tremolo → Transformer → Power → Cabinet]
            // Phase D: Interstage phase inverter transformer (J-A hysteresis)

            // --- Baxandall Bass/Treble EQ (NE5534 preamp, ±15V) ---
            // Peterson FR7054: 2-band Baxandall with Bass/Treble knobs
            // Bass shelf ~200Hz, Treble shelf ~2kHz
            // Flat at center (0dB), ±12dB range. Using tsBass/tsTreble knobs (0..1)
            {
              var baxBase = v * 4;  // 2 biquads × 2 states each = 4 per voice
              // Bass shelf
              var bc = this.suitcaseBaxBassCoeff;
              var bz1 = this.vBaxState[baxBase], bz2 = this.vBaxState[baxBase + 1];
              var bOut = bc[0] * sig + bz1;
              this.vBaxState[baxBase]     = bc[1] * sig - bc[3] * bOut + bz2;
              this.vBaxState[baxBase + 1] = bc[2] * sig - bc[4] * bOut;
              sig = bOut;
              // Treble shelf
              var tc = this.suitcaseBaxTrebleCoeff;
              var tz1 = this.vBaxState[baxBase + 2], tz2 = this.vBaxState[baxBase + 3];
              var tOut = tc[0] * sig + tz1;
              this.vBaxState[baxBase + 2] = tc[1] * sig - tc[3] * tOut + tz2;
              this.vBaxState[baxBase + 3] = tc[2] * sig - tc[4] * tOut;
              sig = tOut;
            }

            // Volume control (Suitcase has its own volume pot)
            sig *= this.volumePot;

            suitcasePreFxSum += sig; // Acc1/2 external reverb taps here (pre-Ge-preamp)
            drySum += sig;
          }
          // Twin PU chain (per-voice V1A/V2A/Tonestack/V2B) removed 2026-04-13
          // (Phase 0.3c). Suitcase is the only remaining amp preset.

        } else {
          // === DI PATH (no amp chain) ===
          // DI = no cable → no LCR. Internal C≈50-100pF → f₀>14kHz → transparent.
          // (debug removed)
          diSum += sig;
        }
        this.vAge[v]++;
      }

      // === SHARED CHAIN (post-voice sum) ===

      // --- Reverb send chain: HPF → V3 → tilt → LPF × 2 ---
      var wetSignal = 0;
      if (this.useSpringReverb && this.springPlacement === 'post_tremolo' && Math.abs(sendSum) > 0.00001) {
        wetSignal = this._processInlineSpringSample(sendSum);
      }

      // --- Output routing ---
      var mainOut;
      var finalOutputGain = 1.0;

      if (this.useCabinet) {
        var ampSig;

        if (this.ampType === 'suitcase') {
          // === SUITCASE SHARED: Peterson FR7054 germanium 80W ===
          // Real Suitcase external reverb chain:
          //   PU → Baxandall EQ → Volume → [Acc1 send → reverb → Acc2 return] → Ge preamp → tremolo → power → cab
          // Spring input must tap from pre-Ge-preamp domain (suitcasePreFxSum).
          // Routing baseline to compare against MK1 Spring EXP:
          //   MK1 Spring EXP:
          //     mainOut -> _extractSpringExcitation(...) -> spring -> mainOut += wet -> tremolo
          //   Suitcase:
          //     suitcasePreFxSum -> _getSuitcaseSpringInput(...) -> spring -> drySum += wet
          //       -> Ge preamp -> tremolo -> power -> cab
          // Keep this distinction explicit. Do not fold Suitcase back into the
          // generic DI/Twin pre_tremolo helper.
          drySum = (drySum / HARP_PARALLEL_DIV) * this.dryBusGain;
          // --- Spring reverb: Acc1/2 external effect loop (pre-Ge-preamp) ---
          // Real routing: Acc2 return → Ge preamp. Dry+wet go through amp together.
          if (this.useSpringReverb && this.springPlacement === 'pre_tremolo') {
            var scSpringInput = (suitcasePreFxSum / HARP_PARALLEL_DIV) * this.dryBusGain;
            var scSpringWet = this._processInlineSpringSample(this._getSuitcaseSpringInput(scSpringInput));
            // Suitcase keeps its own legacy Acc1/2-style serial merge path.
            // Do not route this through the generic pre_tremolo helper; that path
            // was the source of multiple routing regressions.
            drySum += scSpringWet;
          }
          ampSig = drySum * this.rhodesLevel * this.suitcasePreFxTrim; // Suitcase pre-preamp trim (voicing, adjustable via Voicing Lab UI)

          // --- Germanium preamp (Shockley soft knee, shared chain) ---
          ampSig *= this.gePreampDrive;
          // 2x oversampled LUT (anti-aliasing for nonlinear waveshaper)
          var geHalf = (ampSig + this.gePreampPrevSample) * 0.5;
          geHalf = lutLookup(this.gePreampLUT, geHalf);
          this.gePreampPrevSample = ampSig;
          ampSig = lutLookup(this.gePreampLUT, ampSig);
          ampSig = (ampSig + geHalf) * 0.5;
          // Post-LUT real gain (unity-gain LUT × stage gain)
          ampSig *= this.gePreampGain;

          // --- J-A interstage transformer (Phase 4, 2026-04-23) ---
          // 旧: `if (false)` で完全 bypass (split 歪み問題で封印)
          // 新: wet/dry blend で gradual 制御、Voicing Lab UI の J-A MIX slider で
          //     urinami さんが耳検証しながら徐々に有効化する。jaWetMix=0 で完全
          //     bypass (target 2026-04-23 状態と一致)、1 で full J-A。
          //
          // 目的: Codex 外部監査 Q2 YES「低音特異の圧縮 (B∝1/f) は T1 J-A が本体」
          // を段階的に検証。split 歪みバグ (clean + distorted 分離) が再現したら
          // その jaWetMix 値で止めて原因特定する。
          if (this.jaWetMix > 0.001) {
            var dryForJA = ampSig;
            // 1. Pre-emphasis: boost lows before J-A
            var preJA = biquadProcess(this.jaPreEmphCoeff, this.jaPreEmphState, ampSig);
            var H = preJA * this.jaHscale;
            var He = H + this.jaAlpha * this.jaM;
            // Langevin function: L(x) = coth(x) - 1/x ≈ x/3 for small x
            var hea = He / this.jaA;
            var Man;
            if (Math.abs(hea) < 0.001) {
              Man = this.jaMs * hea / 3;
            } else {
              Man = this.jaMs * (1 / Math.tanh(hea) - 1 / hea);
            }
            var dH = H - this.jaHprev;
            var delta = dH >= 0 ? 1 : -1;
            var denom = this.jaK * delta - this.jaAlpha * (Man - this.jaM);
            if (Math.abs(denom) < 1e-10) denom = 1e-10 * delta;
            var dMirr = (Man - this.jaM) / denom;
            // dMan/dH for reversible component
            var dManDH;
            if (Math.abs(hea) < 0.001) {
              dManDH = this.jaMs / (3 * this.jaA);
            } else {
              var sh = 1 / Math.tanh(hea);
              dManDH = this.jaMs * (-sh * sh + 1 / (hea * hea)) / this.jaA;
            }
            var dMdH = (1 - this.jaC) * dMirr + this.jaC * dManDH;
            // Clamp dM to prevent instability
            var dM = dMdH * dH;
            if (dM > 0.1) dM = 0.1;
            if (dM < -0.1) dM = -0.1;
            this.jaM += dM;
            // Clamp M to ±Ms
            if (this.jaM > this.jaMs) this.jaM = this.jaMs;
            if (this.jaM < -this.jaMs) this.jaM = -this.jaMs;
            this.jaHprev = H;
            // Coupling: extract transformer saturation for power amp drive modulation
            var mNorm = Math.abs(this.jaM) / this.jaMs;  // 0..1 saturation ratio
            this.couplingSmooth += this.couplingAlpha * (mNorm - this.couplingSmooth);
            // Output: B ∝ H + M, normalized
            var wetJA = (H + this.jaM) / (1 + this.jaMs) / this.jaHscale;
            // 2. De-emphasis: cut lows back to restore balance
            wetJA = biquadProcess(this.jaDeEmphCoeff, this.jaDeEmphState, wetJA);
            // Blend dry (target 状態) と wet (J-A 通過) を jaWetMix で合成
            ampSig = dryForJA * (1 - this.jaWetMix) + wetJA * this.jaWetMix;
          }

          // --- Germanium Power Amp (Peterson 2×40W push-pull, coupled to transformer) ---
          // Coupling: transformer saturation (couplingSmooth) → power amp drive modulation
          // Physics: core saturation → L(M) drops → source impedance changes
          //   → power amp sees different signal → operating point shifts
          // As transformer saturates (mNorm→1): drive increases, lows compress more
          var cDrive = this.gePaDrive * (1.0 + this.couplingDepth * this.couplingSmooth);
          // Frequency-dependent compression: lows saturate transformer first (B ∝ 1/f)
          var lfC = biquadProcess(this.gePaCompLPFCoeff, this.gePaCompLPFState, ampSig);
          var hfC = ampSig - lfC;
          lfC *= cDrive * (1.0 + 0.15 * this.couplingSmooth);  // Extra drive for lows (0.3→0.15: 透明感)
          hfC *= cDrive;
          var paIn = lfC + hfC;
          // 2x oversampled Ge push-pull LUT (anti-aliasing)
          var paH = (paIn + this.gePaPrevSample) * 0.5;
          paH = lutLookup(this.gePowerampLUT, paH);
          this.gePaPrevSample = paIn;
          paIn = lutLookup(this.gePowerampLUT, paIn);
          ampSig = (paIn + paH) * 0.5;
          ampSig *= this.gePaGain;

          // Cabinet: Eminence Legend 1258 12"×4, near-sealed Suitcase enclosure
          // Eminence T-S: Fs=94Hz, QTS=0.99, 80Hz-4kHz, "tight lows, warm smooth mids"
          if (Math.abs(ampSig) > 1e-7) {
            ampSig = biquadProcess(this.suitcaseCabHPFCoeff, this.suitcaseCabHPFState, ampSig);
            ampSig = biquadProcess(this.suitcaseCabResCoeff, this.suitcaseCabResState, ampSig);
            ampSig = biquadProcess(this.suitcaseCabPeakCoeff, this.suitcaseCabPeakState, ampSig);
            ampSig = biquadProcess(this.suitcaseCabLPFCoeff, this.suitcaseCabLPFState, ampSig);
          } else {
            this.suitcaseCabHPFState[0] = 0; this.suitcaseCabHPFState[1] = 0;
            this.suitcaseCabResState[0] = 0; this.suitcaseCabResState[1] = 0;
            this.suitcaseCabPeakState[0] = 0; this.suitcaseCabPeakState[1] = 0;
            this.suitcaseCabLPFState[0] = 0; this.suitcaseCabLPFState[1] = 0;
            ampSig = 0;
          }

        } else {
          // No amp path remaining once the Twin shared chain was removed
          // 2026-04-13 (Phase 0.3c). Suitcase is handled above; any other
          // ampType reaching useCabinet=true is treated as silent to avoid
          // uninitialised ampSig downstream.
          ampSig = 0;
        }

        mainOut = ampSig * this.cabinetGain;
      } else {
        // === DI PATH: no cable LCR, transparent output ===
        // Keep the effect bus pre-level-match. DI loudness compensation should
        // not overdrive the spring send/return path.
        mainOut = (diSum / HARP_PARALLEL_DIV);
        finalOutputGain = 2.25; // level-match to Pad Sensei MK1 Suitcase
      }

      // Tine radiation: delayed by mic distance (2ms) for natural phase relationship
      // Without delay: same-phase cancellation = thin. With delay: spatial thickness.
      {
        var trDl = this.trDelayBuf;
        var trWr = this.trDelayWr;
        trDl[trWr] = tineRadSum;
        var trRd = trWr - this.trDelayLen;
        if (trRd < 0) trRd += trDl.length;
        var delayedTine = trDl[trRd];
        this.trDelayWr = (trWr + 1) % trDl.length;
        mechanicalNoiseSum += delayedTine;
      }

      // Microphone transfer function on all acoustic noise.
      // HPF 200Hz (transformer) → presence +4dB @5kHz → LPF 12kHz.
      // Skip when no acoustic signal (prevents biquad state residual → amp chain noise)
      if (Math.abs(mechanicalNoiseSum) > 1e-10) {
        var mhc = this.micHPFCoeff, mhs = this.micHPFState;
        var mhOut = mhc[0] * mechanicalNoiseSum + mhs[0];
        mhs[0] = mhc[1] * mechanicalNoiseSum - mhc[3] * mhOut + mhs[1];
        mhs[1] = mhc[2] * mechanicalNoiseSum - mhc[4] * mhOut;
        // Proximity effect: close-mic low shelf boost +6dB@200Hz
        var mxc = this.micProxCoeff, mxs = this.micProxState;
        var mxOut = mxc[0] * mhOut + mxs[0];
        mxs[0] = mxc[1] * mhOut - mxc[3] * mxOut + mxs[1];
        mxs[1] = mxc[2] * mhOut - mxc[4] * mxOut;
        mhOut = mxOut; // HPF then proximity boost
        var mpc = this.micPeakCoeff, mps = this.micPeakState;
        var mpOut = mpc[0] * mhOut + mps[0];
        mps[0] = mpc[1] * mhOut - mpc[3] * mpOut + mps[1];
        mps[1] = mpc[2] * mhOut - mpc[4] * mpOut;
        // Brilliance peak +3dB @10kHz
        var mbc = this.micBrilCoeff, mbs = this.micBrilState;
        var mbOut = mbc[0] * mpOut + mbs[0];
        mbs[0] = mbc[1] * mpOut - mbc[3] * mbOut + mbs[1];
        mbs[1] = mbc[2] * mpOut - mbc[4] * mbOut;
        var mlc = this.micLPFCoeff, mls = this.micLPFState;
        var mlOut = mlc[0] * mbOut + mls[0];
        mls[0] = mlc[1] * mbOut - mlc[3] * mlOut + mls[1];
        mls[1] = mlc[2] * mbOut - mlc[4] * mlOut;
        mechanicalNoiseSum = mlOut;
      }
      if (this.useSpringReverb && this.springPlacement === 'pre_tremolo' && this.ampType !== 'suitcase') {
        // DI / Twin pre_tremolo path (Suitcase is handled above in its own shared chain).
        // Mix the (mono) spring wet into mainOut before tremolo so tremolo modulates dry+wet.
        mainOut += this._processInlineSpringSample(this._extractSpringExcitation(mainOut));
      }
      this._springWetL = 0;
      this._springWetR = 0;

      // Current mechanical-noise path is an acoustic mic layer, not the DI/pickup path.
      // Keep it out of the spring input bus until a true pre-FX shared-noise model exists.
      mainOut += mechanicalNoiseSum;
      mainOut *= this.rhodesLevel;
      // --- Stereo output: Peterson Vactrol Stereo Tremolo (incandescent + CdS) ---
      // Shared across DI and Suitcase: the Vactrol physics model is superior
      // to the legacy Web Audio sine tremolo. One engine, two modes.
      var outSampleL;
      var outSampleR;
      if (this.tremoloDepth > 0) {
        // Physical chain (Peterson FR7054, 1969+ stereo):
        //   Square-wave LFO → Filament I²R heating (τ≈25ms)
        //     → Light output L ∝ T² (Stefan-Boltzmann approx)
        //       → CdS photocell asymmetric response (att 6ms, rel 13ms)
        //         → Resistance → gain attenuation
        // This chain creates the "cat's eye" waveform shape.
        this.tremoloPhase += 6.283185 * this.tremoloFreq / this.fs;
        if (this.tremoloPhase >= 6.283185) this.tremoloPhase -= 6.283185;
        // 1. Square wave LFO drives filament current (0 or 1)
        var squareSign = this.tremoloPhase < 3.14159 ? 1.0 : 0.0;
        var currentL = squareSign;
        var currentR = 1.0 - squareSign;
        // 2. Filament thermal inertia (1-pole LPF, τ≈25ms)
        this.filamentTempL += this.filamentTau * (currentL - this.filamentTempL);
        this.filamentTempR += this.filamentTau * (currentR - this.filamentTempR);
        // 3. Stefan-Boltzmann: light output L ∝ T² (approximation)
        var lightL = this.filamentTempL * this.filamentTempL;
        var lightR = this.filamentTempR * this.filamentTempR;
        // 4. CdS asymmetric response (attack fast, release slow)
        var alphaL = lightL > this.cdsStateL ? this.cdsAttack : this.cdsRelease;
        var alphaR = lightR > this.cdsStateR ? this.cdsAttack : this.cdsRelease;
        this.cdsStateL += (1 - alphaL) * (lightL - this.cdsStateL);
        this.cdsStateR += (1 - alphaR) * (lightR - this.cdsStateR);
        // 5. Depth curve: cubic ease-out makes mid-slider already dramatic
        //    slider=0.4 → effective=0.78 (≈10dB swing)
        //    slider=1.0 → effective=1.0 (full swing, one channel silent)
        var oneMinusD = 1.0 - this.tremoloDepth;
        var effectiveD = 1.0 - oneMinusD * oneMinusD * oneMinusD;
        var oneMinusE = 1.0 - effectiveD;
        var gainL = oneMinusE + effectiveD * this.cdsStateL;
        var gainR = oneMinusE + effectiveD * this.cdsStateR;
        outSampleL = mainOut * gainL;
        outSampleR = mainOut * gainR;
      } else {
        outSampleL = mainOut;
        outSampleR = mainOut;
      }

      // 2026-04-12 Spring reverb wet — stereo, parallel to tremolo/amp chain.
      // Accutronics 4AB3C1B dual-spring: tank[0] → L, tank[1] → R natural
      // decorrelation. うりなみさん: 「もっとふわっと広がる感じ」実装の第一歩。
      outSampleL += this._springWetL;
      outSampleR += this._springWetR;

      outSampleL *= finalOutputGain;
      outSampleR *= finalOutputGain;

      if (outSampleL > 1.0 || outSampleL < -1.0 || outSampleR > 1.0 || outSampleR < -1.0) {
        if (this._clipCount === undefined) this._clipCount = 0;
        this._clipCount++;
        if (this._clipCount < 5) {
          console.log('[CLIP] outL=' + outSampleL.toFixed(4) + ' outR=' + outSampleR.toFixed(4) + ' diSum=' + diSum.toFixed(4) + ' drySum=' + drySum.toFixed(4));
        }
      }
      if (outSampleL > 0.95) outSampleL = 0.95;
      if (outSampleL < -0.95) outSampleL = -0.95;
      if (outSampleR > 0.95) outSampleR = 0.95;
      if (outSampleR < -0.95) outSampleR = -0.95;

      outL[i] = outSampleL;
      if (outR !== outL) outR[i] = outSampleR; else outL[i] = outSampleL;
    }

    return true;
  }
}

registerProcessor('epiano-worklet-processor', EpianoWorkletProcessor);
