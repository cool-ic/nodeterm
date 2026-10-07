#!/bin/sh
# Install / uninstall the nodeterm canvas communication protocol pointers across agent CLIs.
#
# The protocol text is versioned with the product: docs/canvas-protocol.md in this repository is
# the single authority. Installing copies it to $HOME/.nodeterm/canvas-protocol.md (the machine-
# level location every agent reads) and drops a POINTER to that file into each CLI's instruction
# surface.
#
# Why a pointer and not the text: the discovery surfaces differ per CLI and none of them is a
# reliable full-text reader. One copy of the text plus N short pointers means only the pointers can
# drift, and a pointer that goes stale still lands the reader on the file.
#
# Idempotent: re-running rewrites the same bytes. Marker-wrapped: the pointer blocks in shared
# files are fenced between NODETERM:CANVAS-PROTOCOL markers and nothing outside them is touched.
# Uninstallable: --uninstall removes every block and the Claude skill pointer directory.
#
# Usage: scripts/install-canvas-protocol.sh [install|uninstall|status]
set -eu

BEGIN='<!-- NODETERM:CANVAS-PROTOCOL:v1 BEGIN -->'
END='<!-- NODETERM:CANVAS-PROTOCOL:v1 END -->'

# Resolve this script's own directory so the repo copy is found wherever the clone lives.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_COPY="$SCRIPT_DIR/../docs/canvas-protocol.md"

PROTOCOL="$HOME/.nodeterm/canvas-protocol.md"
SKILL_DIR="$HOME/.claude/skills/canvas-communication-protocol"

POINTER="### Canvas communication protocol (nodeterm)

Agents on a nodeterm canvas talk ONLY through the canvas: envelopes into
panes, turn-boundary status, report-outcome as the done signal. The protocol
covers handshake/addressing (UNCONFIRMED blind window, the ownership ledger,
opener wake), dispatch (first prompt rides the launch command; work-order
shape; queue semantics), feedback (report-outcome semantics, station notices,
queued != delivered), orchestration (--after / --after-success), and
post-restart recovery.

Read it BEFORE opening nodes, dispatching work, waiting on another agent, or
reporting your own task: $PROTOCOL
Verb/flag syntax: the manage-nodeterm-canvas skill (Claude) or the canvas
control shim help."

# ---------------------------------------------------------------- helpers ---

strip_block() { # $1 = file; removes a previously installed block in place
  # The blank separator line the append adds is removed with the block, otherwise every re-run
  # leaves one more blank line behind and the "idempotent" claim is false (it grew by a line per
  # install until this buffered rewrite).
  awk -v b="$BEGIN" -v e="$END" '
    function flush() { if (hasHold) print hold; hasHold = 0 }
    index($0, b) == 1 {
      if (hasHold && hold ~ /^[[:space:]]*$/) hasHold = 0; else flush()
      inblock = 1
      next
    }
    inblock && index($0, e) == 1 { inblock = 0; next }
    inblock { next }
    { flush(); hold = $0; hasHold = 1 }
    END { flush() }
  ' "$1"
}

upsert_block() { # $1 = file
  f="$1"
  [ -f "$f" ] || : > "$f"
  tmp="$(mktemp)"
  strip_block "$f" > "$tmp"
  { cat "$tmp"; printf '\n%s\n%s\n%s\n' "$BEGIN" "$POINTER" "$END"; } > "$f"
  rm -f "$tmp"
}

remove_block() { # $1 = file; also deletes the file if only whitespace remains
  [ -f "$1" ] || return 0
  tmp="$(mktemp)"
  strip_block "$1" > "$tmp"
  if [ -s "$tmp" ] && [ "$(tr -d '[:space:]' < "$tmp" | wc -c)" -gt 0 ]; then
    mv "$tmp" "$1"
  else
    rm -f "$tmp" "$1"
  fi
}

write_skill() {
  mkdir -p "$SKILL_DIR"
  tmp="$(mktemp)"
  {
    printf -- '---\nname: canvas-communication-protocol\n'
    printf -- 'description: nodeterm canvas protocol pointer — how agents address each other, dispatch work, report done, wait on upstream, recover after a restart. Use before opening nodes, dispatching, waiting on output, or reporting your own task. Terms live in the canonical protocol file; this skill is a passive fallback only.\n---\n\n'
    printf -- '# Canvas communication protocol (pointer)\n\n'
    printf -- 'The single authority is:\n\n    %s\n\n' "$PROTOCOL"
    printf -- 'This skill holds no clauses. Verb/flag syntax: the manage-nodeterm-canvas skill.\n'
  } > "$tmp"
  if [ -f "$SKILL_DIR/SKILL.md" ] && cmp -s "$tmp" "$SKILL_DIR/SKILL.md"; then
    rm -f "$tmp"
  else
    mv "$tmp" "$SKILL_DIR/SKILL.md"
  fi
}

# Copilot reads $COPILOT_HOME (default ~/.copilot)/copilot-instructions.md — the same path
# nodeterm's own installer uses (src/main/canvas-control.ts installAgentInstructions via
# copilotHomeDir()). ~/.github/copilot-instructions.md is a per-REPO convention; at home level
# nothing reads it, so it is on the CLEANUP list, not the install list.
COPILOT_DIR="${COPILOT_HOME:-$HOME/.copilot}"

TARGETS="
$HOME/.codex/AGENTS.md
$HOME/.gemini/GEMINI.md
$COPILOT_DIR/copilot-instructions.md
"

# Blocks installed by earlier script versions to surfaces that turned out to be wrong.
CLEANUP="
$HOME/.github/copilot-instructions.md
"

# ------------------------------------------------------------------ verbs ---

sync_text() { # repo copy → the machine-level file every pointer names
  if [ -f "$REPO_COPY" ]; then
    mkdir -p "$(dirname "$PROTOCOL")"
    if [ -f "$PROTOCOL" ] && cmp -s "$REPO_COPY" "$PROTOCOL"; then
      :
    else
      cp "$REPO_COPY" "$PROTOCOL"
      echo "protocol text: updated from $REPO_COPY"
    fi
    return 0
  fi
  # No repo copy (installed from a bare checkout, or the script was copied out of the tree):
  # an existing machine-level file is still usable; only a missing one is fatal.
  [ -f "$PROTOCOL" ] || {
    echo "no protocol text: neither $REPO_COPY nor $PROTOCOL exists" >&2
    return 1
  }
}

do_install() {
  sync_text || exit 1
  write_skill
  printf '%s\n' "$TARGETS" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    mkdir -p "$(dirname "$f")"
    upsert_block "$f"
  done
  printf '%s\n' "$CLEANUP" | while IFS= read -r f; do
    if [ -n "$f" ] && [ -f "$f" ]; then remove_block "$f"; fi
  done
  echo "installed: skill pointer + $(printf '%s\n' "$TARGETS" | grep -c . ) marker blocks"
}

do_uninstall() {
  rm -rf "$SKILL_DIR"
  printf '%s\n' "$TARGETS" "$CLEANUP" | while IFS= read -r f; do
    [ -n "$f" ] && remove_block "$f"
  done
  echo "uninstalled (the machine-level protocol file is left in place: $PROTOCOL)"
}

do_status() {
  echo "repo copy: $( [ -f "$REPO_COPY" ] && echo present || echo absent )  ($REPO_COPY)"
  echo "canonical: $( [ -f "$PROTOCOL" ] && echo present || echo MISSING )  ($PROTOCOL)"
  if [ -f "$REPO_COPY" ] && [ -f "$PROTOCOL" ]; then
    cmp -s "$REPO_COPY" "$PROTOCOL" && echo "in sync:   yes" || echo "in sync:   NO (run install to update)"
  fi
  echo "skill:     $( [ -f "$SKILL_DIR/SKILL.md" ] && echo present || echo absent )  ($SKILL_DIR/SKILL.md)"
  printf '%s\n' "$TARGETS" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -f "$f" ] && grep -q "NODETERM:CANVAS-PROTOCOL" "$f"; then
      echo "block:     present  ($f)"
    else
      echo "block:     absent   ($f)"
    fi
  done
}

case "${1:-install}" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  status)    do_status ;;
  *) echo "usage: $0 [install|uninstall|status]" >&2; exit 1 ;;
esac
