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

## [2026-04-23] 58a268b — Voicing Lab 配線: worklet param 口 + debug hook

### Feature
- `this.suitcasePreFxTrim` state を worklet constructor に追加（default 0.42）
  - 旧: `ampSig = drySum * this.rhodesLevel * 0.42`（hard-coded 定数）
  - 新: `ampSig = drySum * this.rhodesLevel * this.suitcasePreFxTrim`（可変）
- `_updateParams` に Voicing Lab 3 パラメータ受け口を追加:
  - `msg.gePreampDrive`（clamp ≥ 0.1）
  - `msg.gePreampGain`（clamp ≥ 0.01）
  - `msg.suitcasePreFxTrim`（clamp ≥ 0.01）
- `_onMessage` に `_debugDumpVoicing` hook 追加 — worklet 内の実 voicing 値を main thread に返す（検証・パイプライン診断用）
- `_epwSendVoicingLabParams(params)` を main thread 側 (epiano-worklet-engine.js) に新設、`window._epwSendVoicingLabParams` で expose
- `_epwSendParams` が呼ばれる度に `window.EpVoicingLab` の値を worklet に同梱送信（preset 切替等で reset されない）

### Consumer 対応
- Voicing Lab は keys 検証ツール限定。64PE / MRC / Plugin は `window.EpVoicingLab` を設定しなければ worklet default (2.5 / 1.5 / 0.42) で動作
- API 追加のみで既存 consumer への影響なし

### 背景
urinami 2026-04-22「makeup gain 下げて歪ませる = saturator 的に drive を増やす」仮説を耳で A/B 検証するため。Phase 1 Si 2N3392 LUT の voicing 3 値をコード定数から外し、実時間 UI 調整を可能化。

---

## [2026-04-22] ff8eb6c — Phase 1: Peterson Suitcase preamp Si 2N3392 2-stage topology 訂正

### Feature
- `computePreampLUT_Si2N3392_2stage()` 追加（engine + worklet 両方）— Peterson 80W schematic fig11-8 精読結果を反映した Si NPN 2 段 CE カスケード
- 関数形: `y = x / (1 + |x|^n)^(1/n)` smooth saturator、`nPos=2`（positive soft knee = Vce_sat 方向飽和）、`nNeg=3`（negative hard knee = cutoff 方向）、2 段カスケードで小信号 linear + 大信号で累乗的圧縮
- `preampType === 'Si2N3392_2stage'` を engine 側 preamp LUT dispatch に追加
- Worklet に test hook: `_debugDumpPreampLUT` message → `_debugPreampLUT` で内部 LUT を main thread に dump（Playwright contract test 用）
- Phase 1 E2E 測定 spec `tests/e2e/phase1-preamp-thd.spec.js` 新設（5 test all PASS、M1-M6 測定プロトコル準拠）

### Fix (topology 訂正)
- Peterson 80W Suitcase Preamp: 旧 `'NE5534'`（op-amp 単段モデル）を `'Si2N3392_2stage'` に置換。schematic fig11-8 Q1/Q2 は 037118 selected 2N3392 Si NPN 2 段 CE であり、NE5534 は誤認だった
- Worklet 側 `this.gePreampLUT` 初期化を `computePreampLUT_Ge()` → `computePreampLUT_Si2N3392_2stage()` に訂正。Peterson は Germanium ではなく Silicon（永続ノート参照）
- AB763 Hi input `-6dB` divider（68k/68k voltage divider）を `preampType === '12AX7'` 限定に絞った。Peterson fig11-8 にこの divider は存在しない（Codex 監査 round 2 指摘）

### Voicing 残件（urinami 聴感 A/B 調整領域、Phase 1 topology 範囲外）
- Worklet chain 側 `drySum * rhodesLevel * 0.42 * gePreampDrive(2.5) * gePreampGain(1.5)` の voicing 係数
- Fallback engine 側 `preampMakeup = 1.0` の Si 化補正

### Consumer 対応
- 変数名 `gePreampLUT` は互換維持（Phase 5 で poweramp 訂正と同時に `ge*` → `si*` rename 予定）
- Phase 1 は preamp のみ。Poweramp は引き続き `computePowerampLUT_Ge()`（Phase 5 で 2N0725 Si push-pull direct-coupled OCL に訂正予定）
- Consumer（64PE / Keys / MRC / Desktop）は submodule pointer を bump すれば自動反映

### Measured
- 1kHz @ out RMS -40 dBFS: THD = -90 dB（criterion <-50dB、margin 40dB ✓）
- 1kHz @ out RMS -10 dBFS: THD = -32 dB（criterion >-34dB、margin 2dB ✓）
- 8kHz vs 1kHz gain diff: 0 dB（criterion <3dB ✓）
- Worklet ↔ fallback LUT numeric match: maxDiffNorm = 6.6e-8（両 path 同一 shape ✓）

### Ref
- 永続ノート: [[Peterson 80W Suitcase の Power Module は Si BJT push-pull direct-coupled OCL 構造で Germanium でも output transformer でもなく interstage transformer T1 のみを持つ]]
- Plan: `デジタル百姓総本部/プロジェクト/PAD DAW/Suitcase_amp_modeling_plan_2026-04-22.md` v9 §Phase 1
- Codex 監査 5 ラウンド通過

---

## [2026-04-22] a5fff53 — preset output compensate + Suitcase cab LPF 5.5kHz + gain chain simplify

### Feature
- `EP_AMP_PRESETS[*].outputGainDb` metadata 追加（DI=+6dB, Suitcase=0dB）
- `audio-master.js` に `_epOutputCompensate` GainNode 新設（masterBus 直前に挿入）
- `audio-engines.js` `_applyPresetOutputGain()` 追加 — preset 切替時に dB→linear で compensate gain を `setTargetAtTime(30ms)` 適用
- Debug hook: `window._DEBUG._epOutputCompensate` / `window._DEBUG.masterBus`（Playwright 実測用）

### Fix
- Suitcase cabinet LPF cutoff `4000 → 5500 Hz`（Eminence Legend 1258 sealed-box -6dB point 実測値に合わせ、urinami 2026-04-22「上が出なさすぎる」修正）
- `epianoDirectOut` / `epianoAmpOut` 初期 gain `0.49 → 1.0`（slider 初期値の歴史的残骸を除去、マスター VOL は `masterBus` が単独制御）

### Routing
- DI chain (`flangerMix`) / Suitcase amp out (`epianoAmpOut`) / Plate reverb return (`ePlateReturn`) が **masterBus 直結から _epOutputCompensate 経由に変更**
- 目的: 物理モデル内部挙動を変えずに preset 間音量揃えを最終段でのみ補正（urinami 2026-04-22 設計方針）

### Consumer 対応
- 64PE / Keys / MRC など consumer は、新 GainNode `_epOutputCompensate` を参照する必要はない（既存の masterBus 連携はそのまま動作）
- preset 切替時の音量補正挙動は自動有効化。Opt-out 不要

---

## [2026-04-16] 3acbd6c — schemaVersion minor warn + CHANGELOG-enforcing hook（Plan C）

### Feature
- `validateAudioCoreConfig()` に minor mismatch 検出を追加
  - host `schemaVersion` の minor 部分が `REQUIRED_SCHEMA_MINOR` と違えば `console.warn`（throw せず動作継続）
  - 例: host=`1.1`、required=`1.0` → warn だけ出て機能差異を通知
- `tools/pre-commit.sh` + `tools/install-hooks.sh` 新規 — *.js / INTERFACE.md 変更時に CHANGELOG entry 必須を機械化
  - Scope: `*.js` + `INTERFACE.md`（README.md / typo はノイズ源なので除外）
  - Bypass: `SKIP_CHANGELOG=1 git commit ...`
  - Install: `./tools/install-hooks.sh`（clone 直後に 1 回、各 clone で別途）

### 動機
Codex Plan A Final audit (reports/20260415-221118-design.md) CONFIRM 2 (minor mismatch warn 未実装) + MINOR 1 (CHANGELOG hook 未実装) の吸収。urinami 原則「構造で記憶を外化」に従い、contract の doc-only 管理から runtime + git hook の二重防御へ。

---

## [2026-04-15] 0fb3e7b — schemaVersion strict gate + INTERFACE.md（Plan A、Codex BLOCKER 3）

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
