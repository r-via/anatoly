#!/usr/bin/env bash
# hardware.sh — GPU, VRAM, Docker, and NVIDIA toolkit detection.
#
# Requires: logging.sh sourced first.

set -euo pipefail

# ---------------------------------------------------------------------------
# GPU detection
# ---------------------------------------------------------------------------

# detect_gpu — Probe available GPU hardware and echo the backend type.
#
# Checks nvidia-smi, Apple Silicon sysctl, and rocm-smi in that order.
# Returns (stdout): "cuda" | "metal" | "rocm" | "none"
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

# detect_vram_gb — Query total GPU VRAM in GB (NVIDIA only).
#
# Uses nvidia-smi --query-gpu=memory.total. Returns "0" when nvidia-smi
# is absent, the query fails, or the value is non-numeric.
# Returns (stdout): integer GB string (e.g. "8", "24") or "0"
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

# detect_vram_used_mib — Query current VRAM usage in MiB (NVIDIA only).
#
# Uses nvidia-smi --query-gpu=memory.used. Returns "0" when nvidia-smi
# is absent or the query fails.
# Returns (stdout): integer MiB string (e.g. "512") or "0"
detect_vram_used_mib() {
  command -v nvidia-smi &>/dev/null || { echo "0"; return; }
  nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "0"
}

# ---------------------------------------------------------------------------
# Docker detection
# ---------------------------------------------------------------------------

# has_docker — Check whether Docker is installed and the daemon is reachable.
#
# Returns: exit 0 if docker CLI exists and `docker info` succeeds, exit 1 otherwise.
has_docker() {
  command -v docker &>/dev/null && docker info &>/dev/null 2>&1
}

# has_nvidia_container_toolkit — Detect the NVIDIA Container Toolkit.
#
# Probes two paths: (1) nvidia-container-cli binary, (2) "nvidia" in `docker info`.
# Returns: exit 0 if either probe succeeds, exit 1 otherwise.
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

# select_tier GPU VRAM_GB DOCKER_OK TOOLKIT_OK
#
# Choose an embedding tier based on hardware and Docker capabilities.
#   GPU        — output of detect_gpu (cuda|metal|rocm|none)
#   VRAM_GB    — integer GB from detect_vram_gb
#   DOCKER_OK  — "true"|"false" from has_docker
#   TOOLKIT_OK — "true"|"false" from has_nvidia_container_toolkit
#
# Returns (stdout): "advanced-gguf" when GPU is present, Docker + toolkit are
# available, and VRAM >= 12 GB; "lite" otherwise.
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

# ensure_jq — Ensure jq is available, auto-installing via apt-get or brew if needed.
#
# Returns: exit 0 on success, exit 1 if jq cannot be installed automatically.
# Side effects: may run sudo apt-get install or brew install.
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

# ensure_curl — Verify that curl is available (no auto-install).
#
# Returns: exit 0 if curl is on PATH, exit 1 with an error message otherwise.
ensure_curl() {
  if command -v curl &>/dev/null; then
    return 0
  fi
  log error "curl is required but not found. Please install it."
  return 1
}
