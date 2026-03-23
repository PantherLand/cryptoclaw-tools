#!/usr/bin/env bash
set -euo pipefail

SKILL_NAME="crypto-treasury-ops"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
TARGET_DIR="$CODEX_HOME_DIR/skills"
TARGET_PATH="$TARGET_DIR/$SKILL_NAME"

usage() {
  cat <<'EOF'
Install this repository as a local Codex skill.

Usage:
  scripts/install-codex-skill.sh [--force] [--copy]

Options:
  --force  Replace an existing install target.
  --copy   Copy files instead of creating a symlink.
EOF
}

force=0
copy_mode=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      force=1
      shift
      ;;
    --copy)
      copy_mode=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$TARGET_DIR"

if [[ -e "$TARGET_PATH" || -L "$TARGET_PATH" ]]; then
  if [[ "$force" -ne 1 ]]; then
    echo "Target already exists: $TARGET_PATH" >&2
    echo "Re-run with --force to replace it." >&2
    exit 1
  fi

  rm -rf "$TARGET_PATH"
fi

if [[ "$copy_mode" -eq 1 ]]; then
  cp -R "$REPO_ROOT" "$TARGET_PATH"
  echo "Copied skill to $TARGET_PATH"
else
  ln -s "$REPO_ROOT" "$TARGET_PATH"
  echo "Linked skill to $TARGET_PATH"
fi
