#!/bin/bash
# Keeps the Meridian `running` flag honest, mechanically.
#
# The flag marks a task an agent is actively working. Prose asks the work skill
# to set and clear it around every dispatch — the least reliable rule in the
# system, because an interrupted session leaves running:true orphaned and
# nothing clears it until a human notices. This hook is the janitor:
#
#   pre   (PreToolUse, Task)  — a dispatch prompt carrying "MERIDIAN_TASK: <id>"
#                               sets running:true and records the id for this
#                               session.
#   post  (PostToolUse, Task) — the specialist returned; running:false, id
#                               forgotten.
#   stop  (Stop / SessionEnd) — clears running on every id this session set and
#                               never cleared: the dispatch was interrupted, or
#                               the session died. This is the case prose can
#                               never cover, and the reason the hook exists.
#
# It must cost nothing when irrelevant: it fires on every Task dispatch in every
# session of every project, so the no-marker path exits on a grep miss without
# parsing anything. No jq — the fields are extracted from the raw hook JSON.
# Failures are swallowed: a hook must never block a dispatch, and the API
# setting the same value twice is idempotent.

MODE="$1"
INPUT="$(cat)"

BASE="${MERIDIAN_URL:-http://localhost:3333}"

# Session-scoped ledger of ids this session set running. One "<id>\t<cwd>" per line.
# Field names differ by harness: Claude Code sends session_id, Antigravity sends
# conversationId. Same for the project path below. Try Claude's first, then
# Antigravity's — the marker grep that gates everything is field-agnostic.
session_id() {
  local sid
  sid=$(printf '%s' "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "$sid" ] || sid=$(printf '%s' "$INPUT" | grep -o '"conversationId"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  printf '%s' "$sid"
}
LEDGER="${TMPDIR:-/tmp}/meridian-running-$(session_id)"

# The cwd, as a ready-to-splice JSON string, quotes included. grep -o instead
# of sed: BSD sed has no \| alternation, and this must run on macOS. A path
# containing a literal double quote will not match — acceptable, since such a
# path breaks half the shell tooling on the machine anyway.
cwd_json() {
  local c
  c=$(printf '%s' "$INPUT" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"cwd"[[:space:]]*:[[:space:]]*//')
  # Antigravity: workspacePaths is an array; its first element is the project.
  [ -n "$c" ] || c=$(printf '%s' "$INPUT" | grep -o '"workspacePaths"[[:space:]]*:[[:space:]]*\[[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$')
  printf '%s' "$c"
}

put_running() { # $1 = task id, $2 = cwd as JSON string, $3 = true|false
  curl -sS -m 2 -X PUT "$BASE/api/projects/tasks/$1" \
    -H 'Content-Type: application/json' \
    -d "{\"projectPath\":$2,\"running\":$3}" >/dev/null 2>&1 || true
}

marker_id() {
  printf '%s' "$INPUT" | grep -o 'MERIDIAN_TASK:[[:space:]]*[A-Z0-9]\{1,10\}-[0-9]\{1,6\}' | head -1 | sed 's/MERIDIAN_TASK:[[:space:]]*//'
}

case "$MODE" in
  pre|post)
    # Fast path: no marker in the dispatch, nothing to do.
    case "$INPUT" in *MERIDIAN_TASK:*) ;; *) exit 0 ;; esac
    ID="$(marker_id)"; [ -n "$ID" ] || exit 0
    CWD="$(cwd_json)"; [ -n "$CWD" ] || exit 0
    if [ "$MODE" = "pre" ]; then
      put_running "$ID" "$CWD" true
      printf '%s\t%s\n' "$ID" "$CWD" >> "$LEDGER"
    else
      put_running "$ID" "$CWD" false
      if [ -f "$LEDGER" ]; then
        grep -v "^$ID	" "$LEDGER" > "$LEDGER.new" 2>/dev/null || true
        mv "$LEDGER.new" "$LEDGER" 2>/dev/null || true
      fi
    fi
    ;;
  stop)
    # Fast path: nothing recorded, nothing dangling. The common case for every
    # turn of every session that never dispatched a Meridian specialist.
    [ -s "$LEDGER" ] || { rm -f "$LEDGER"; exit 0; }
    while IFS="$(printf '\t')" read -r ID CWD; do
      [ -n "$ID" ] && [ -n "$CWD" ] || continue
      # Leave a resume note alongside the cleared flag. A shell hook cannot
      # summarise what the agent was doing, but it can point the resumer at
      # the evidence: when it stopped, the git state, the latest report file.
      # Only characters safe inside a JSON string are used.
      DIR=$(printf '%s' "$CWD" | sed 's/^"//; s/"$//')
      WHEN=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      GITBIT="git n/a"
      if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        BR=$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null | tr -cd 'A-Za-z0-9._/-')
        STAGED=$(git -C "$DIR" diff --cached --name-only 2>/dev/null | grep -c . || true)
        DIRTY=$(git -C "$DIR" diff --name-only 2>/dev/null | grep -c . || true)
        GITBIT="git $BR staged:$STAGED modified:$DIRTY"
      fi
      REPORT=$(ls -t "$DIR/.meridian/reports/$ID-"*.md 2>/dev/null | head -1)
      RPTBIT=""
      [ -n "$REPORT" ] && RPTBIT="; latest report .meridian/reports/$(basename "$REPORT" | tr -cd 'A-Za-z0-9._-')"
      CTX="Interrupted mid-dispatch $WHEN; $GITBIT$RPTBIT. Establish actual state with git status and git diff before writing anything."
      curl -sS -m 2 -X PUT "$BASE/api/projects/tasks/$ID" \
        -H 'Content-Type: application/json' \
        -d "{\"projectPath\":$CWD,\"running\":false,\"resume_context\":\"$CTX\"}" >/dev/null 2>&1 || true
    done < "$LEDGER"
    rm -f "$LEDGER"
    ;;
esac
exit 0
