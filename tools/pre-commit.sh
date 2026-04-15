#!/bin/bash
# audio-core pre-commit hook
# Plan C 2026-04-16: require CHANGELOG entry when *.js or INTERFACE.md change
#
# Rationale: contract changes in DSP code or schema doc must be logged for
# consumers (64PE / Keys / Effects / MRC / Desktop). urinami 原則「構造で記憶を
# 外化」、CHANGELOG 漏れ防止を機械化。
#
# Scope: *.js + INTERFACE.md のみ対象（README.md / typo 修正はノイズ源なので除外）
# Bypass: `SKIP_CHANGELOG=1 git commit ...` で緊急時 escape
#
# Installation: `./tools/install-hooks.sh` を clone 直後に 1 回実行

set -eu

# Escape hatch (use sparingly)
if [ "${SKIP_CHANGELOG:-0}" = "1" ]; then
  echo "[pre-commit] SKIP_CHANGELOG=1 detected, skipping CHANGELOG check."
  exit 0
fi

# Files that require CHANGELOG sync (excluding CHANGELOG itself)
relevant=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '(\.js$|^INTERFACE\.md$)' \
  | grep -v '^CHANGELOG\.md$' \
  || true)

if [ -z "$relevant" ]; then
  exit 0  # Nothing requires changelog
fi

# Is CHANGELOG.md staged?
changelog_staged=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep '^CHANGELOG\.md$' \
  || true)

if [ -z "$changelog_staged" ]; then
  echo "[pre-commit] ERROR: Changes to the following files require a CHANGELOG.md entry:" >&2
  echo "$relevant" | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Add an entry under '## [YYYY-MM-DD]' to CHANGELOG.md, stage it, and retry." >&2
  echo "If truly unnecessary (e.g. typo-only), retry with: SKIP_CHANGELOG=1 git commit ..." >&2
  exit 1
fi

exit 0
