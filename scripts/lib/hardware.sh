#!/usr/bin/env bash
# hardware.sh — GPU, VRAM, Docker, and NVIDIA toolkit detection.
#
# Requires: logging.sh sourced first.

set -euo pipefail

# ---------------------------------------------------------------------------
# GPU detection
# ---------------------------------------------------------------------------
detect_gpu() {
  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
    echo "cuda"
  elif [[ "$(uname)" == "Darwin" ]] && sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -q "Apple"; then
    echo "metal"
  elif command -v rocm-smi &>/dev/null && rocm-smi &>/dev/null; then
    echo "rocm"
  else
    echo "none"
  fi
}

# Total VRAM in GB (NVIDIA only, returns 0 otherwise)
detect_vram_gb() {
  if ! command -v nvidia-smi &>/dev/null; then
    echo "0"
    return
  fi
  local mib
  mib=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  if [[ -z "$mib" || ! "$mib" =~ ^[0-9]+$ || "$mib" == "0" ]]; then
    echo "0"
    return
  fi
  echo $(( mib / 1024 ))
}

# Current VRAM usage in MiB (NVIDIA only)
detect_vram_used_mib() {
  command -v nvidia-smi &>/dev/null || { echo "0"; return; }
  nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "0"
}

# ---------------------------------------------------------------------------
# Docker detection
# ---------------------------------------------------------------------------
has_docker() {
  command -v docker &>/dev/null && docker info &>/dev/null 2>&1
}

has_nvidia_container_toolkit() {
  if command -v nvidia-container-cli &>/dev/null; then
    return 0
  fi
  if docker info 2>/dev/null | grep -q "nvidia"; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Tier selection
# ---------------------------------------------------------------------------
# Returns: "lite" or "advanced-gguf"
select_tier() {
  local gpu="$1"
  local vram_gb="$2"
  local docker_ok="$3"
  local toolkit_ok="$4"

  if [[ "$gpu" == "none" ]]; then
    echo "lite"
    return
  fi

  if ! [[ "$vram_gb" =~ ^[0-9]+$ ]]; then
    echo "lite"
    return
  fi

  if [[ "$docker_ok" == "true" && "$toolkit_ok" == "true" && "$vram_gb" -ge 12 ]]; then
    echo "advanced-gguf"
    return
  fi

  echo "lite"
}

# ---------------------------------------------------------------------------
# Dependency check / install
# ---------------------------------------------------------------------------
ensure_jq() {
  if command -v jq &>/dev/null; then
    return 0
  fi
  log warn "jq not found — required for JSON processing"
  if command -v apt-get &>/dev/null; then
    log info "Installing jq via apt-get..."
    sudo apt-get update -qq && sudo apt-get install -y -qq jq
    log ok "jq installed"
  elif command -v brew &>/dev/null; then
    log info "Installing jq via brew..."
    brew install jq
    log ok "jq installed"
  else
    log error "Cannot install jq automatically. Please install it manually."
    return 1
  fi
}

ensure_curl() {
  if command -v curl &>/dev/null; then
    return 0
  fi
  log error "curl is required but not found. Please install it."
  return 1
}
