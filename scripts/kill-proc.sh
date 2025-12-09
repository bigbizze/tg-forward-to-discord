#!/usr/bin/env bash
# Kill processes matching the given patterns

# Get our own process group to exclude our entire process tree
script_pgid=$(ps -o pgid= -p $$)

# Patterns to exclude from killing (e.g., log-dashboard processes)
EXCLUDE_PATTERNS="log-dashboard"

for proc_name in "$@"; do
  # Skip the -- separator that pnpm/npm adds
  if [ "$proc_name" = "--" ]; then
    continue
  fi

  # Find PIDs matching the pattern
  # Exclude any process in our own process group
  # Exclude processes matching EXCLUDE_PATTERNS (check both command and cwd)
  matching_pids=$(pgrep -f "$proc_name" | while read pid; do
    pid_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null)
    if [ "$pid_pgid" != "$script_pgid" ]; then
      # Check if this process matches any exclude pattern
      cmd=$(ps -o args= -p "$pid" 2>/dev/null)
      cwd=$(readlink -f /proc/"$pid"/cwd 2>/dev/null)
      should_exclude=false
      for exclude in $EXCLUDE_PATTERNS; do
        if echo "$cmd" | grep -q "$exclude"; then
          should_exclude=true
          break
        fi
        if echo "$cwd" | grep -q "$exclude"; then
          should_exclude=true
          break
        fi
      done
      if [ "$should_exclude" = "false" ]; then
        echo "$pid"
      fi
    fi
  done)

  if [ -n "$matching_pids" ]; then
    # Kill each matching PID, ignoring errors if process already died
    echo "$matching_pids" | xargs -r kill -9 2>/dev/null
    echo "✓ Killed processes matching: $proc_name"
  fi
done