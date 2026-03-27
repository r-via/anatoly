#!/usr/bin/env bash
# logging.sh — Professional logging for Anatoly setup scripts.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/logging.sh"
#   log_init "/path/to/.anatoly/setup.log"
#   log info  "Starting setup..."
#   log ok    "Done"
#   log warn  "Something is off"
#   log error "Fatal error"
#   log debug "Verbose detail"  # only shown if LOG_LEVEL=debug

set -euo pipefail

# ---------------------------------------------------------------------------
# Colors (disabled if stdout is not a terminal)
# ---------------------------------------------------------------------------
if [[ -t 2 ]]; then
  _RED='\033[0;31m'
  _GREEN='\033[0;32m'
  _YELLOW='\033[1;33m'
  _CYAN='\033[0;36m'
  _DIM='\033[2m'
  _NC='\033[0m'
else
  _RED='' _GREEN='' _YELLOW='' _CYAN='' _DIM='' _NC=''
fi

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
_LOG_FILE=""
LOG_LEVEL="${LOG_LEVEL:-info}"

# ---------------------------------------------------------------------------
# Initialise log file (call once at script start)
# ---------------------------------------------------------------------------
log_init() {
  _LOG_FILE="$1"
  mkdir -p "$(dirname "$_LOG_FILE")"
  : >> "$_LOG_FILE"   # touch
}

# ---------------------------------------------------------------------------
# Core log function
# ---------------------------------------------------------------------------
log() {
  local level="$1"; shift
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Filter by log level
  case "$LOG_LEVEL" in
    debug) ;;
    info)  [[ "$level" == "debug" ]] && return 0 ;;
    warn)  [[ "$level" == "debug" || "$level" == "info" || "$level" == "ok" ]] && return 0 ;;
    error) [[ "$level" != "error" ]] && return 0 ;;
    *)     return 0 ;;  # unrecognised LOG_LEVEL — suppress all output
  esac

  # Color mapping
  local color="$_NC"
  local label
  case "$level" in
    debug) color="$_DIM";    label="debug" ;;
    info)  color="$_CYAN";   label="info " ;;
    ok)    color="$_GREEN";  label=" ok  " ;;
    warn)  color="$_YELLOW"; label="warn " ;;
    error) color="$_RED";    label="error" ;;
    *)     label="$level" ;;
  esac

  # Console output (colored, to stderr so it doesn't pollute stdout captures)
  printf "${color}[%s]${_NC} %s\n" "$label" "$*" >&2

  # File output (plain, with timestamp)
  if [[ -n "$_LOG_FILE" ]]; then
    printf "[%s] [%s] %s\n" "$timestamp" "$label" "$*" >> "$_LOG_FILE"
  fi
}

# ---------------------------------------------------------------------------
# Section separator (visual only)
# ---------------------------------------------------------------------------
log_section() {
  # Only emit blank lines when info-level output is visible
  if [[ "$LOG_LEVEL" == "debug" || "$LOG_LEVEL" == "info" ]]; then
    printf "\n" >&2
  fi
  log info "═══════════════════════════════════════════════"
  log info "  $*"
  log info "═══════════════════════════════════════════════"
  if [[ "$LOG_LEVEL" == "debug" || "$LOG_LEVEL" == "info" ]]; then
    printf "\n" >&2
  fi
}

log_separator() {
  # Treat separator as info-level visual output
  if [[ "$LOG_LEVEL" == "debug" || "$LOG_LEVEL" == "info" ]]; then
    printf "  ─────────────────────────────────────────────\n" >&2
  fi
}
