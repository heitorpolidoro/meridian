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
is_antigravity() {
  printf '%s' "$INPUT" | grep -q '"conversationId"'
}

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

# BSD `stat` (macOS) vs GNU `stat` (Linux CI) — mtime in epoch seconds, or
# empty when the path does not exist.
mtime_of() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null; }

# Claude Code sends transcript_path; absent under Antigravity, which is the
# primary "skip silently" case for token capture.
transcript_path() {
  printf '%s' "$INPUT" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 | sed 's/^"transcript_path"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

# Best-effort extractor for the agent name, so the posted event can carry it.
agent_type() {
  printf '%s' "$INPUT" | grep -o '"subagent_type"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

capture_tokens() { # $1=task id  $2=cwd JSON string  $3=ledger mtime (epoch secs, may be empty)
  local id="$1" cwdj="$2" since="$3"
  local tpath sid tdir subdir
  tpath="$(transcript_path)"; [ -n "$tpath" ] || return 0
  sid="$(session_id)"; [ -n "$sid" ] || return 0
  tdir="$(dirname "$tpath")"
  subdir="$tdir/$sid/subagents"
  [ -d "$subdir" ] || return 0

  # Newest agent-*.jsonl modified after the pre-dispatch ledger timestamp is
  # the transcript for the dispatch that just returned. `since` empty (no
  # ledger mtime available) degrades to "newest file, unconditionally" —
  # acceptable for this best-effort path.
  local newest="" newest_mtime=0 f mtime
  for f in "$subdir"/agent-*.jsonl; do
    [ -e "$f" ] || continue
    mtime="$(mtime_of "$f")"; [ -n "$mtime" ] || continue
    if [ -n "$since" ] && [ "$mtime" -le "$since" ]; then continue; fi
    if [ "$mtime" -gt "$newest_mtime" ]; then newest_mtime="$mtime"; newest="$f"; fi
  done
  [ -n "$newest" ] || return 0

  local tokens out_tokens ctx_tokens
  tokens="$(python3 - "$newest" <<'PYEOF'
import json, sys

path = sys.argv[1]
output_tokens = 0
last_usage = None
try:
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            usage = entry.get('usage')
            if not isinstance(usage, dict):
                msg = entry.get('message')
                usage = msg.get('usage') if isinstance(msg, dict) else None
            if isinstance(usage, dict):
                output_tokens += usage.get('output_tokens', 0) or 0
                last_usage = usage
except OSError:
    pass

if last_usage is None:
    print('0 0')
else:
    ctx = (last_usage.get('input_tokens', 0) or 0) \
        + (last_usage.get('cache_read_input_tokens', 0) or 0) \
        + (last_usage.get('cache_creation_input_tokens', 0) or 0)
    print(f'{output_tokens} {ctx}')
PYEOF
)"
  out_tokens="${tokens%% *}"
  ctx_tokens="${tokens##* }"
  [ -n "$out_tokens" ] || return 0

  local agent agent_json payload
  agent="$(agent_type)"
  agent_json=""
  [ -n "$agent" ] && agent_json="\"agent\":\"$agent\","
  payload=$(printf '{"projectPath":%s,"task":"%s","type":"dispatch_tokens",%s"output_tokens":%s,"context_tokens":%s}' \
    "$cwdj" "$id" "$agent_json" "$out_tokens" "$ctx_tokens")
  curl -sS -m 2 -X POST "$BASE/api/projects/events" \
    -H 'Content-Type: application/json' \
    -d "$payload" >/dev/null 2>&1 || true
}

# $4, the session id, is what lets the board tell an orphaned flag from a
# live one later: Meridian asks whether THIS session is still in
# `claude agents --json` instead of guessing from whatever else is running in
# the directory (see lib/stale-running.js). Optional on purpose — a harness
# that reports no session id still sets the flag, and the board falls back to
# its heuristic. Restricted to id-shaped characters so it cannot break out of
# the JSON string it is spliced into.
#
# The harness is sent with it, and is not decoration. That list is Claude
# Code's alone: an Antigravity conversation id can never appear in it, so
# checking one against it answers "gone" for work that is very much alive —
# which is exactly what happened to a task Antigravity was working. Naming
# the owner is what lets the board decline to judge what it cannot see.
put_running() { # $1 = task id, $2 = cwd as JSON string, $3 = true|false, $4 = session id (optional)
  local extra=""
  local sid
  sid=$(printf '%s' "$4" | tr -cd 'A-Za-z0-9._-')
  if [ -n "$sid" ]; then
    local agent="claude"
    is_antigravity && agent="agy"
    extra=",\"running_session\":\"$sid\",\"running_agent\":\"$agent\""
  fi
  curl -sS -m 2 -X PUT "$BASE/api/projects/tasks/$1" \
    -H 'Content-Type: application/json' \
    -d "{\"projectPath\":$2,\"running\":$3$extra}" >/dev/null 2>&1 || true
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
      put_running "$ID" "$CWD" true "$(session_id)"
      printf '%s\t%s\n' "$ID" "$CWD" >> "$LEDGER"
    else
      if is_antigravity; then
        # In Antigravity, invoke_subagent launches the specialist in the background.
        # The tool dispatch returns immediately while the specialist continues working.
        # Do not clear running:false here — the orchestrator agent clears it when the specialist returns.
        exit 0
      fi
      LEDGER_MTIME=""
      [ -f "$LEDGER" ] && LEDGER_MTIME="$(mtime_of "$LEDGER")"
      put_running "$ID" "$CWD" false
      if [ -f "$LEDGER" ]; then
        grep -v "^$ID	" "$LEDGER" > "$LEDGER.new" 2>/dev/null || true
        mv "$LEDGER.new" "$LEDGER" 2>/dev/null || true
      fi
      capture_tokens "$ID" "$CWD" "$LEDGER_MTIME"
    fi
    ;;
  stop)
    # Fast path: nothing recorded, nothing dangling. The common case for every
    # turn of every session that never dispatched a Meridian specialist.
    [ -s "$LEDGER" ] || { rm -f "$LEDGER"; exit 0; }

    if is_antigravity; then
      # In Antigravity, 'Stop' fires at the end of every conversation turn.
      # If background tasks are running (fullyIdle is false) or the model simply stopped
      # generating to await subagent response/user input (model_stop), do not treat as an interruption.
      if printf '%s' "$INPUT" | grep -q '"fullyIdle"[[:space:]]*:[[:space:]]*false'; then
        exit 0
      fi
      reason=$(printf '%s' "$INPUT" | grep -o '"terminationReason"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
      if [ "$reason" = "model_stop" ] || [ -z "$reason" ]; then
        exit 0
      fi
    fi

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
