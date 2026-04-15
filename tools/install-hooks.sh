#!/bin/bash
# Install audio-core git hooks into this clone.
# Plan C 2026-04-16.
#
# Hooks provided:
#   - pre-commit: require CHANGELOG.md entry when *.js or INTERFACE.md change
#
# Run this once after `git clone` or `git submodule update --init`.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-dir)"

# Handle submodule case: .git is a file pointing to the real gitdir
if [ -f "$REPO_ROOT/.git" ]; then
  GIT_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir)"
fi

HOOKS_DIR="$GIT_DIR/hooks"
mkdir -p "$HOOKS_DIR"

# Install pre-commit
install -m 0755 "$SCRIPT_DIR/pre-commit.sh" "$HOOKS_DIR/pre-commit"
echo "[install-hooks] installed $HOOKS_DIR/pre-commit"

echo ""
echo "Hooks installed. They run on every commit in this clone."
echo "To bypass temporarily (e.g. typo-only commit): SKIP_CHANGELOG=1 git commit ..."
