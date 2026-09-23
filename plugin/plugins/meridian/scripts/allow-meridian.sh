#!/bin/bash
# Auto-approves the two things every Meridian skill must do before it can do
# anything else: talk to the local Meridian server, and read the plugin's own
# reference documents.
#
# Without this, a headless dispatch cannot run at all. The skills drive the
# board entirely through the HTTP API, and no allowlist anywhere grants an
# HTTP call — not the project's, not the user's, not the one Meridian itself
# generates. A real run died in its preamble with seven identical denials
# while another survived only because that model improvised `python3 -c
# "import urllib.request"` instead of curl. The references are worse: they
# live in the plugin directory, outside the project, so reading them is
# denied too — the skill could not read its own instructions.
#
# It runs as PreToolUse, NOT PermissionRequest. That was measured, not
# assumed: an instrumented copy of this script recorded zero invocations
# under `claude -p`. A headless run never REQUESTS permission — with no one
# to ask, the CLI refuses straight from the allowlist — so a
# PermissionRequest hook is dead exactly where dispatch lives. PreToolUse
# fires on every tool call in both modes.
#
# Both harnesses are answered, because the reply formats differ and a hook
# that speaks the wrong dialect is silently ignored:
#   Claude Code : {"hookSpecificOutput":{"hookEventName":"<the event>",
#                  "permissionDecision":"allow"}}
#   Antigravity : {"decision":"allow"}
# The event name is echoed back from the input rather than hard-coded, so
# the same script is correct wherever it is registered.
# Anything not matched prints nothing and exits 0, which leaves the normal
# permission flow exactly as it was. Saying "ask" is not this hook's job.
#
# WHAT IT WILL NOT APPROVE, deliberately: a command that merely CONTAINS the
# server address. Matching a substring would approve
# `curl localhost:3333/api/status && rm -rf ~` on the strength of its first
# half. A command is approved only when the whole of it is one plain call to
# the Meridian API with no shell composition in it at all.

INPUT="$(cat)"

is_antigravity() { printf '%s' "$INPUT" | grep -q '"conversationId"'; }

approve() {
    if is_antigravity; then
        printf '{"decision":"allow","reason":"Meridian API or reference access"}\n'
    else
        local event
        event="$(field hook_event_name)"
        [ -n "$event" ] || event="PreToolUse"
        printf '{"hookSpecificOutput":{"hookEventName":"%s","permissionDecision":"allow","permissionDecisionReason":"Meridian API or reference access"}}\n' "$event"
    fi
    exit 0
}

# Extracted with grep rather than jq: this runs on every permission request in
# every session, and a jq dependency is not worth it for two fields.
field() {  # $1 = field name -> its string value, or empty
    printf '%s' "$INPUT" \
        | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"\(\\\\.\|[^\"\\\\]\)*\"" \
        | head -1 | sed "s/^\"$1\"[[:space:]]*:[[:space:]]*\"//; s/\"$//"
}

TOOL="$(field tool_name)"
[ -n "$TOOL" ] || TOOL="$(field toolName)"

case "$TOOL" in
    Read)
        # One of the four shared reference documents, inside a directory
        # belonging to a Meridian install. Both the directory and the file
        # name are pinned, so this grants no access to the project, the home
        # directory, or even to the plugin's own scripts.
        #
        # The four names are listed rather than globbed because the install
        # layouts differ enough that the directory alone is a loose match:
        #   <repo>/plugin/plugins/meridian/references/
        #   ~/.claude/plugins/cache/meridian/meridian/<version>/references/
        #   ~/.gemini/config/plugins/meridian/references/
        FILE="$(field file_path)"
        [ -n "$FILE" ] || FILE="$(field path)"
        case "$FILE" in
            *meridian*/references/preamble.md|*meridian*/references/pipeline.md|\
            *meridian*/references/stages.md|*meridian*/references/schema.md) approve ;;
        esac
        ;;
    Bash|run_terminal_command)
        CMD="$(field command)"
        [ -n "$CMD" ] || exit 0

        # Two spellings are normalised away first, because neither composes
        # anything and both appear in every documented example: a backslash
        # line continuation, which is one command written over several lines,
        # and a discard redirect, which writes nowhere. Everything left is
        # judged as-is.
        # The command arrives as it was written in the JSON, so a newline is
        # the two characters \n, never a real one, and a backslash line
        # continuation is \\ followed by \n. Continuations are joined, because
        # one command written over several lines composes nothing. A bare \n
        # separates two commands: joining those would turn
        #   curl <api>
        #   rm -rf ~
        # into one approved line, which an earlier version of this did.
        PROBE="$(printf '%s' "$CMD" | sed 's/\\\\\\n/ /g')"
        case "$PROBE" in *'\n'*)
            # One exception to "a newline means two commands": a leading
            # variable assignment. Every documented block opens with
            #   BASE="${MERIDIAN_URL:-http://localhost:3333}"
            # because blocks share no shell state, and an assignment composes
            # nothing. It is dropped only when it is the FIRST line, assigns a
            # plain value, and carries no substitution of its own — and what
            # follows still has to pass every check below on its own.
            HEAD="${PROBE%%\\n*}"
            REST="${PROBE#*\\n}"
            case "$HEAD" in
                [A-Za-z_]*=*)
                    case "$HEAD" in
                        *'$('*|*'`'*|*'&'*|*';'*|*'|'*) exit 0 ;;
                    esac
                    PROBE="$REST"
                    ;;
                *) exit 0 ;;
            esac
            # Only one assignment line is forgiven; anything still multi-line
            # is two commands.
            case "$PROBE" in *'\n'*) exit 0 ;; esac
            ;;
        esac

        # A discard redirect writes nowhere and appears in every documented
        # example; it is removed before the composition check below so that
        # check can stay absolute about every other redirect.
        PROBE="$(printf '%s' "$PROBE" | sed 's|> *\/dev\/null||g')"

        # Any real shell composition disqualifies the command outright —
        # chaining, piping, substitution, any other redirection. What remains
        # can only be the single call it appears to be.
        case "$PROBE" in
            *'&&'*|*'||'*|*';'*|*'|'*|*'&'*|*'$('*|*'`'*|*'>'*|*'<'*) exit 0 ;;
        esac

        # The command itself, after the RTK wrapper the machine may prepend.
        BARE="${PROBE#rtk }"
        case "$BARE" in curl\ *) ;; *) exit 0 ;; esac

        # And it must address the Meridian server. MERIDIAN_URL is honoured so
        # a server on another port is still matched; localhost:3333 is the
        # documented default.
        BASE="${MERIDIAN_URL:-http://localhost:3333}"
        case "$BARE" in
            *"$BASE"*|*localhost:3333*|*127.0.0.1:3333*|*'${MERIDIAN_URL'*|*'$BASE'*) approve ;;
        esac
        ;;
esac

exit 0
