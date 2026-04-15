# audio-core interface contract — `window.audioCoreConfig`

**目的**: audio-core submodule と consumer (64PE / Keys / Effects / MRC / Desktop / 各 VST/AU wrap) の間の契約を **runtime で機械的に強制**する。

**作成**: 2026-04-15（Plan A、Codex BLOCKER 3 closure）

---

## 必須グローバル

audio-core の最初の script (`audio-master.js`) が load される**前に**、host は以下を set すること:

```js
window.AUDIO_CORE_BASE = './audio-core/';   // asset の base path
window.audioCoreConfig = {
  schemaVersion: 1,                          // major.minor 形式（後述）
  // ... 7 sub-interface（後述）
};
```

未設定の場合、audio-master.js が起動時に `throw` する。

---

## schemaVersion 運用

**形式**: `major.minor`（例: `1`, `1.2`）

| 状態 | 検出 | 結果 |
|---|---|---|
| `undefined` / `null` | missing | **throw**（"is required"） |
| string / boolean / NaN | non-number | **throw**（"must be a finite number"） |
| `Math.floor(v) !== REQUIRED_MAJOR` | major mismatch | **throw**（"major mismatch"） |
| minor 違い | minor mismatch | `console.warn`（機能差異を通知、動作継続） |

**検証実装**: `audio-master.js` の冒頭で `validateAudioCoreConfig()` を呼ぶ（AudioContext 作成前）。

**現在の schema バージョン**: `1.0`（Plan A baseline、2026-04-15）

**minor の range 制限**: 数値表現 (`1.0`, `1.1`, ..., `1.9`) を仮定。minor ≥ 10 になったら representation を `"1.10"` 文字列 or `{major: 1, minor: 10}` object に変更する必要あり。Plan C (2026-04-16) での妥協事項。

---

## 7 sub-interface 一覧

詳細スキーマは `~/.claude/plans/phase3-standalone-platform.md` v5 §Interface 1.1-1.7 参照。要約:

| # | sub-interface | 役割 |
|---|---|---|
| 1.1 | `velocity` | velocity curve params + canvas 描画 |
| 1.2 | `midiBridge` | linkMode / midiActiveNotes / scheduleMidiUpdate |
| 1.3 | `presetDropdown` | render / sync / filter（HPS gate 等） |
| 1.4 | `persistence` | loadSound / saveSound / loadEpMixer / saveEpMixer / parseUrlOverrides |
| 1.5 | `muteUI` | updateMuteBtn / updatePresetOpacity / applyMute |
| 1.6 | `mixer` | syncSliders / syncValueLabels / updateVisibility / redispatchTremolo |
| 1.7 | `overlay` | enabled / t / firstRunKey / showFirstTimeHint / showAudioOverlay / dismissOverlay / showPadHint / hidePadHint / onMutedAutoSelect |

各 sub-interface は **per-key defensive merge** を host 側で行う（host-adapter.js の `mergeDefaults()` パターン参照）。audio-core 側は default 値を持たない（host 側で no-op default を充填する設計）。

---

## 変更時の手順（schema migration）

1. **影響判定**:
   - signature 変更 / sub-interface 追加削除 / required field 追加 → **major bump**
   - optional field 追加 / default 値変更 → **minor bump**
2. INTERFACE.md の「現在の schema バージョン」を更新
3. `audio-master.js` の `REQUIRED_SCHEMA_MAJOR`（major bump 時）/ `REQUIRED_SCHEMA_MINOR`（minor bump 時）を更新。現在値は v1.0 (major=1, minor=0)
4. `CHANGELOG.md` に **BREAKING** または **Feature** entry 追記
5. **major bump の場合は全 consumer の adapter を同 PR で更新**（64PE host-adapter.js / Keys app.js / 将来 Effects / Desktop sync-webui.sh 経由）

---

## Consumer 実装例

### 64PE（host-adapter.js、defensive merge pattern）
```js
if (typeof window.audioCoreConfig === 'undefined') {
  window.audioCoreConfig = {};
}
(function() {
  var cfg = window.audioCoreConfig;
  if (typeof cfg.schemaVersion === 'undefined') {
    cfg.schemaVersion = 1;
  }
  // ... per-key mergeDefaults for each sub-interface
})();
```

### Keys（app.js、object literal）
```js
window.audioCoreConfig = {
  schemaVersion: 1,
  velocity: { ... },
  // ... 6 other sub-interface
};
```

---

## Related

- `~/64-pad-visualizer/audio-core/CHANGELOG.md` — 変更履歴 + bump workflow
- `~/64-pad-visualizer/audio-core/audio-master.js` — `validateAudioCoreConfig()` 実装本体
- `~/.claude/plans/phase3-standalone-platform.md` v5 §Interface 1.1-1.7 — 7 sub-interface の詳細スキーマ
- `~/pad-sensei/SSOT.md` §SSOT 責務 — DSP / voicing / UI / host-adapter の責務マップ
