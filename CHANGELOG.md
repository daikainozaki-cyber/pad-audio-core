# audio-core CHANGELOG

**目的**: submodule に変更を加える consumer（64PE / Keys / Effects / MRC / Desktop）が、bump 時に「何が変わったか」を 1 箇所で把握するための記録。

**規律**: commit 時に必ずこのファイルに entry を追記する（urinami 2026-04-15 方針、記憶の外化）。

---

## Entry format

```markdown
## [YYYY-MM-DD] {commit-sha-short} — {short title}

### BREAKING
- interface 変更 / schema 互換切れ / signature 変更
- consumer 側の対応内容を明記

### Feature
- 新機能 / 新 API / 新 preset

### Fix
- bug 修正（API 不変）
```

カテゴリなしは書かない。BREAKING なければその section ごと省く。

---

## Consumer bump workflow

1. 該当 consumer repo で `git submodule update --remote audio-core`
2. この CHANGELOG 末尾から自分が最後に bump した時点までを読む
3. **BREAKING あり** → adapter 更新（audioCoreConfig 該当 sub-interface の実装修正）+ smoke test 全項目
4. **BREAKING なし** → smoke test S1-S3（first-note / preset / persistence）
5. consumer repo で `git add audio-core && git commit -m "chore: bump audio-core to {sha}"`

consumer が何を smoke test するかは各 consumer の `CLAUDE.md` を参照。

---

# 履歴

## [2026-04-15] {pending-sha} — schemaVersion strict gate + INTERFACE.md（Plan A、Codex BLOCKER 3）

### BREAKING
- `audioCoreConfig.schemaVersion` を **必須化**。`audio-master.js` 起動時に検証。
  - missing / NaN / non-number / major mismatch → **throw**
  - minor mismatch: 現時点は throw なし（minor 機能は将来 `REQUIRED_SCHEMA_MINOR` 導入時に warn、TODO 参照）
- 全 consumer は `audioCoreConfig.schemaVersion: 1` を設定すること。
  - 64PE: `host-adapter.js` で per-key defensive merge（既存 mergeDefaults pattern と同思想）
  - Keys: `app.js` の object literal に直接記述
  - 将来 Effects / Desktop / VST/AU wrap も同様

### Feature
- `audio-core/INTERFACE.md` 新規 — schema contract SSOT、変更時手順、consumer 実装例

### 動機
Codex 監査（2026-04-15、reports/20260415-171910-design.md）BLOCKER 3:「audioCoreConfig 契約は文書のみで機械的 gate なし」→ adapter 追加/削除時に Claude が no-op で起動して「動くが一部だけ壊れている」事故を見逃す。**urinami 原則「構造で記憶を外化する」**に従い、CHANGELOG 文書だけでなく runtime throw で強制。

---

## [2026-04-15] {baseline} — CHANGELOG 運用開始

### Feature
- host-decoupling refactor 完了（Phase 3.0.a-f、8 commits）
  - `window.audioCoreConfig` 7 sub-interface（velocity / midiBridge / presetDropdown / persistence / muteUI / mixer / overlay）
  - `audio-core/assets/` 配下に FDTD data と twin-cab-ir.wav を移設
  - `AUDIO_CORE_BASE` global で asset path 柔軟化
- Pad Sensei Keys standalone（`~/pad-sensei/keys/`、旧 `~/pad-sensei-mk1-standalone/`）を consumer として追加

### Fix
- Volume routing single merge point（masterBus 一点制御）— 旧: masterGain / epianoDirectOut / epianoAmpOut 分散制御で volume 0 でも音が出る bug
- `_loadEpMixer` の 6-slider 同期漏れ
- `_applyPresetEpMixerDefaults` の preset default 値反映漏れ

### 既知の consumer pointer 状態（2026-04-15 時点）
- 64PE Web: 最新を参照
- MRC: 旧 pointer（C 固定モード未対応）、bump 判断は plan v5 §Operational §3 参照
- Pad Sensei Keys: 最新を参照

### 今後の TODO
- ~~`audioCoreConfig.schemaVersion` field 未実装~~ → 2026-04-15 実装済（上記 Plan A entry 参照）
- cross-consumer CI（audio-core push → 64PE/Keys/MRC の test trigger）未実装
- `REQUIRED_SCHEMA_MINOR` 導入（minor mismatch → console.warn）— 将来必要になったら追加
