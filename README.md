# pad-audio-core

**Audio engine SSOT for Pad Sensei** (ePiano physical model + effects + worklets).

Shared across:
- `64-pad-visualizer` (Web + Desktop wrapper)
- `master-rhythm-chart`
- future VST/AU plugins, standalone apps, etc.

This repository exists so the audio layer has a single place to live. Host
applications consume it as a git submodule (mounted at `audio-core/`) and
load every file via `<script src="audio-core/...">` + AudioWorklet
`addModule('audio-core/...')` calls.

## Status (2026-04-14)

**Phase 1.0 — proof of concept.** Only `spring-reverb-processor.js` has been
moved here so far. It is used by the Web Audio fallback path in
`epiano-engine.js` (activated via the `?node=1` URL query) and exists
primarily so that the submodule plumbing — `addModule` path, PWA cache,
pre-commit asset check, Desktop `sync-webui.sh` — can be validated on a
low-risk file before the rest of the audio layer is moved.

Once the PoC path is shown to work end-to-end (local dev → production PWA
→ Desktop WebUI sync), the rest of the audio layer will be migrated in
three batches as laid out in the roadmap (`humming-wibbling-tarjan.md`,
Phase 1.1).

## Contents

| File | Purpose |
|------|---------|
| `spring-reverb-processor.js` | Standalone spring reverb AudioWorkletProcessor (Abel waveguide, Accutronics-style 2-spring structure). Used by the `?node=1` Web Audio fallback in the host app. |

## Submodule usage

```bash
# Clone the host app with this submodule included
git clone --recursive https://github.com/daikainozaki-cyber/64-pad-visualizer.git

# Or initialise after a plain clone
git submodule update --init --recursive
```

Inside the host app, reference files via `audio-core/...`:

```html
<!-- Web -->
<script src="audio-core/spring-reverb-processor.js?v=..."></script>
```

```javascript
// AudioWorklet
ctx.audioWorklet.addModule('audio-core/spring-reverb-processor.js?v=...');
```

## License

(TBD — same policy as `pad-core`: permissive for library use, credit line
"うりなみ" on derived products.)
