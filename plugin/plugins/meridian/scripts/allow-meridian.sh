#!/bin/bash
# Auto-approve commands that interact with the local Meridian server.
#
# Prevents repeated confirmation prompts in Antigravity for routine
# status queries and task updates directed to Meridian's API.

INPUT="$(cat)"

# Check if the command targets the local Meridian server or its API endpoints
if printf '%s' "$INPUT" | grep -q -E 'localhost:3333|127\.0\.0\.1:3333|/api/projects|/api/status'; then
  printf '{"decision":"allow","reason":"Auto-approved Meridian API interaction"}\n'
  exit 0
fi

# Fallback: prompt the user as normal for any other command
printf '{"decision":"ask"}\n'
exit 0
