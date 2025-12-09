#!/usr/bin/env bash
# Kill processes matching the given patterns

# Get our own process group to exclude our entire process tree
script_pgid=$(ps -o pgid= -p $$)

# This will hold all exclude patterns provided via --exclude flags
# We initialize it as empty, meaning no exclusions by default
EXCLUDE_PATTERNS=""
# For e.g.: EXCLUDE_PATTERNS="log-dashboard"

# Parse command-line arguments to extract --exclude flags
# We need to process all arguments before the process name patterns
args=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --exclude=*)
      # This handles --exclude='pattern' or --exclude=pattern format
      # The ${1#*=} syntax strips everything up to and including the first =
      # so --exclude=foo becomes just foo
      pattern="${1#*=}"
      # Add this pattern to our exclude list
      # We separate multiple patterns with spaces
      if [ -n "$EXCLUDE_PATTERNS" ]; then
        EXCLUDE_PATTERNS="$EXCLUDE_PATTERNS $pattern"
      else
        EXCLUDE_PATTERNS="$pattern"
      fi
      shift  # Move past this argument
      ;;
    --exclude)
      # This handles --exclude 'pattern' format (space-separated)
      # The pattern is in the next argument ($2)
      if [ -n "$2" ] && [[ ! "$2" =~ ^-- ]]; then
        pattern="$2"
        if [ -n "$EXCLUDE_PATTERNS" ]; then
          EXCLUDE_PATTERNS="$EXCLUDE_PATTERNS $pattern"
        else
          EXCLUDE_PATTERNS="$pattern"
        fi
        shift 2  # Move past both --exclude and its value
      else
        echo "Error: --exclude requires a pattern argument" >&2
        exit 1
      fi
      ;;
    *)
      # This is not a flag, so it must be a process name pattern
      # Save it for later processing
      args+=("$1")
      shift
      ;;
  esac
done

# Now process each process name pattern
for proc_name in "${args[@]}"; do
  # Skip the -- separator that pnpm/npm adds
  if [ "$proc_name" = "--" ]; then
    continue
  fi

  # Find PIDs matching the pattern
  # Exclude any process in our own process group
  # If EXCLUDE_PATTERNS is set, also exclude those patterns
  matching_pids=$(pgrep -f "$proc_name" | while read pid; do
    pid_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null)
    if [ "$pid_pgid" != "$script_pgid" ]; then
      # Check if this process matches any exclude pattern
      # Only do this check if EXCLUDE_PATTERNS is not empty
      if [ -n "$EXCLUDE_PATTERNS" ]; then
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
        # Only output the PID if we shouldn't exclude it
        if [ "$should_exclude" = "false" ]; then
          echo "$pid"
        fi
      else
        # No exclusion patterns provided, so include this PID
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