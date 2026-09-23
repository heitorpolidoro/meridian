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
# Both harnesses are answered, because the reply formats differ and a hook
# that speaks the wrong dialect is silently ignored:
#   Claude Code : {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
#                  "permissionDecision":"allow"}}
#   Antigravity : {"decision":"allow"}
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
        printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow"}}\n'
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

        # Any shell composition disqualifies the command outright — chaining,
        # piping, substitution, redirection, newlines. What remains can only
        # be the single call it appears to be.
        case "$CMD" in
            *'&&'*|*'||'*|*';'*|*'|'*|*'&'*|*'$('*|*'`'*|*'>'*|*'<'*|*$'\n'*) exit 0 ;;
        esac

        # The command itself, after the RTK wrapper the machine may prepend.
        BARE="${CMD#rtk }"
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
