#!/usr/bin/env bash
# run-goal.sh — drive the GOAL.md build headlessly, auto-resuming across
# usage-limit windows until Claude reports the goal complete.
#
# Usage:   ./run-goal.sh
# Better:  caffeinate -i ./run-goal.sh        (keeps the Mac awake)
# Or:      nohup ./run-goal.sh >/dev/null 2>&1 &   then: tail -f goal-run.log
#
# Stop it anytime with Ctrl-C (or kill); rerunning resumes the same
# conversation via the session id saved in .goal-session.

set -u
cd "$(dirname "$0")"

LOG="goal-run.log"
SESSION_FILE=".goal-session"
MAX_ITER=100
DONE_MARKER="GOAL_COMPLETE"

PROMPT_FIRST="Read GOAL.md in this repository and implement the application it
describes, end to end. Make your own technology choices as the document allows.
Work autonomously: plan, implement, run and verify the app, and commit logical
chunks of work as you go with clear messages. Do not ask questions.
When — and only when — everything in GOAL.md is implemented and verified
working, print a line containing exactly ${DONE_MARKER}. If you stop for any
other reason, briefly state what remains to be done instead."

PROMPT_CONTINUE="Continue implementing GOAL.md from where you left off. Review
the repository state first to reorient. Same rules as before: work
autonomously, verify, commit as you go, and print ${DONE_MARKER} only when
everything in GOAL.md is fully implemented and verified."

SESSION_ID=""
[[ -f "$SESSION_FILE" ]] && SESSION_ID="$(cat "$SESSION_FILE")"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

iter=0
while (( iter < MAX_ITER )); do
  iter=$((iter + 1))
  log "--- iteration $iter (session: ${SESSION_ID:-new}) ---"

  if [[ -z "$SESSION_ID" ]]; then
    OUT=$(claude -p "$PROMPT_FIRST" --output-format json \
          --dangerously-skip-permissions 2>&1)
  else
    OUT=$(claude -p "$PROMPT_CONTINUE" --resume "$SESSION_ID" \
          --output-format json --dangerously-skip-permissions 2>&1)
  fi
  STATUS=$?
  printf '%s\n' "$OUT" >> "$LOG"

  # Each resume can mint a new session id — always track the latest one.
  NEW_SID=$(printf '%s' "$OUT" \
    | sed -n 's/.*"session_id"[^"]*"\([0-9a-fA-F-]\{36\}\)".*/\1/p' | head -1)
  if [[ -n "$NEW_SID" ]]; then
    SESSION_ID="$NEW_SID"
    printf '%s' "$SESSION_ID" > "$SESSION_FILE"
  fi

  if printf '%s' "$OUT" | grep -q "$DONE_MARKER"; then
    log "Goal reported complete after $iter iteration(s). Exiting."
    exit 0
  fi

  if printf '%s' "$OUT" | grep -qiE "usage limit|hit your [a-z ]*limit"; then
    # Older/API format carries an epoch: "...usage limit reached|1751600000"
    EPOCH=$(printf '%s' "$OUT" | grep -oE '\|[0-9]{10}' | tr -d '|' | head -1)
    NOW=$(date +%s)
    if [[ -n "${EPOCH:-}" ]] && (( EPOCH > NOW )); then
      WAIT=$(( EPOCH - NOW + 120 ))   # 2 min of slack past the reset
      log "Usage limit hit. Sleeping $(( WAIT / 60 )) min until reset."
      sleep "$WAIT"
    else
      log "Usage limit hit; reset time not parseable. Polling again in 15 min."
      sleep 900
    fi
    continue
  fi

  if (( STATUS != 0 )); then
    log "claude exited with status $STATUS (not a usage limit). Retrying in 5 min."
    sleep 300
    continue
  fi

  log "Turn finished without $DONE_MARKER — continuing."
  sleep 10
done

log "Reached MAX_ITER=$MAX_ITER without completion. Stopping; rerun to continue."
exit 1
