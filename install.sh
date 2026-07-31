#!/usr/bin/env bash
# ==============================================================================
# benwiththelens/agent-skills — Installer
# ==============================================================================
# Links (or copies) the agent-skills collection into your agent runtime's
# skills directory.
#
# Targets (first match wins, or override with --target):
#   1. ~/.openclaw/workspace/skills/benwiththelens   (OpenClaw)
#   2. ~/.claude/skills/benwiththelens               (Claude Code)
#
# Usage:
#   ./install.sh                # symlink into detected target
#   ./install.sh --copy         # copy instead of symlink
#   ./install.sh --target DIR   # install into explicit directory
#   ./install.sh --uninstall    # remove installed link/copy
# ==============================================================================

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_NAME="benwiththelens"
MODE="link"
TARGET=""
UNINSTALL=0

log()  { printf '[agent-skills] %s\n' "$*"; }
fail() { printf '[agent-skills] ERROR: %s\n' "$*" >&2; exit 1; }

# --- Argument parsing ---------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy)      MODE="copy"; shift ;;
    --link)      MODE="link"; shift ;;
    --target)    TARGET="${2:?--target requires a directory}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "Unknown argument: $1 (use --help)" ;;
  esac
done

# --- Target detection ---------------------------------------------------------
if [[ -z "$TARGET" ]]; then
  if [[ -d "$HOME/.openclaw/workspace/skills" ]]; then
    TARGET="$HOME/.openclaw/workspace/skills"
  elif [[ -d "$HOME/.claude/skills" ]]; then
    TARGET="$HOME/.claude/skills"
  else
    # Neither runtime found — default to OpenClaw layout and create it.
    TARGET="$HOME/.openclaw/workspace/skills"
    log "No existing skills directory detected; defaulting to $TARGET"
  fi
fi

DEST="$TARGET/$INSTALL_NAME"

# --- Uninstall ----------------------------------------------------------------
if [[ "$UNINSTALL" -eq 1 ]]; then
  if [[ -L "$DEST" ]]; then
    rm "$DEST"
    log "Removed symlink: $DEST"
  elif [[ -d "$DEST" ]]; then
    rm -rf "$DEST"
    log "Removed directory: $DEST"
  else
    log "Nothing installed at $DEST"
  fi
  exit 0
fi

# --- Install ------------------------------------------------------------------
mkdir -p "$TARGET"

if [[ -e "$DEST" || -L "$DEST" ]]; then
  fail "Already exists: $DEST (run with --uninstall first, or remove it manually)"
fi

case "$MODE" in
  link)
    ln -s "$REPO_DIR" "$DEST"
    log "Symlinked $DEST -> $REPO_DIR"
    ;;
  copy)
    cp -R "$REPO_DIR" "$DEST"
    # Don't ship the installer artifacts inside the installed copy's VCS dirs.
    rm -rf "$DEST/.git"
    log "Copied $REPO_DIR -> $DEST"
    ;;
esac

log "Done. Skills available under:"
log "  original/  - benwiththelens original skills (jules-dispatch, server-ops, catalyst-ingest)"
log "  curated/   - curated community skills (papercuts, voice-builder, self-improving-agent, obsidian-skills)"
log "Restart your agent runtime (or re-scan skills) to pick them up."
