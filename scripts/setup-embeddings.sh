#!/usr/bin/env bash
#
# setup-embeddings.sh — Install and configure embedding backends for Anatoly.
#
# Docker-only. Zero Python dependency.
#
# Backends (tiered):
#   lite          — ONNX in-process (Jina 768d, CPU, always available)
#   advanced-gguf — Docker llama.cpp server-cuda (GGUF Q5_K_M on GPU)
#
# Usage:
#   ./scripts/setup-embeddings.sh           # Full setup
#   ./scripts/setup-embeddings.sh --check   # Check status only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${ANATOLY_PROJECT_ROOT:-$(pwd)}"
MODELS_DIR="${HOME}/.anatoly/models"
READY_FILE="${PROJECT_ROOT}/.anatoly/embeddings-ready.json"
LOG_FILE="${PROJECT_ROOT}/.anatoly/setup.log"
SAMPLES_FILE="${SCRIPT_DIR}/check-samples.json"

# Model config
CODE_MODEL_ID="nomic-ai/nomic-embed-code"
NLP_MODEL_ID="Qwen/Qwen3-Embedding-8B"
GGUF_CODE_MODEL_FILE="nomic-embed-code.Q5_K_M.gguf"
GGUF_NLP_MODEL_FILE="Qwen3-Embedding-8B-Q5_K_M.gguf"

# Expected SHA256 checksums (from official HuggingFace repos)
GGUF_CODE_SHA256="f234c58a5be4c5e89f71e3b7131150a568b9618d32a34ebb625e9c0f6e0be9fb"
GGUF_NLP_SHA256="022d33b4e2d97ef09a74feb13ef368cb7ca3a610ea2fb3e107199fa72c226e78"
GGUF_CODE_HF_REPO="nomic-ai/nomic-embed-code-GGUF"
GGUF_NLP_HF_REPO="Qwen/Qwen3-Embedding-8B-GGUF"
GGUF_MIN_VRAM_GB=12


# ---------------------------------------------------------------------------
# Source shared libraries
# ---------------------------------------------------------------------------
# shellcheck source=lib/logging.sh
source "${SCRIPT_DIR}/lib/logging.sh"
# shellcheck source=lib/hardware.sh
source "${SCRIPT_DIR}/lib/hardware.sh"
# shellcheck source=lib/docker-helpers.sh
source "${SCRIPT_DIR}/lib/docker-helpers.sh"
# shellcheck source=lib/json-helpers.sh
source "${SCRIPT_DIR}/lib/json-helpers.sh"

log_init "$LOG_FILE"

# ---------------------------------------------------------------------------
# Cleanup trap
# ---------------------------------------------------------------------------
cleanup() {
  stop_gguf_containers 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Purge stale embedding configs (clean slate for setup)
# ---------------------------------------------------------------------------
purge_embedding_configs() {
  local purged=false
  for f in \
    "${READY_FILE}"
  do
    if [[ -f "$f" ]]; then
      rm -f "$f"
      purged=true
    fi
  done
  if [[ "$purged" == "true" ]]; then
    log info "Purged stale embedding config files"
  fi
}

# ---------------------------------------------------------------------------
# GGUF model download (curl with resume support)
# ---------------------------------------------------------------------------
download_gguf_model() {
  local filename="$1"
  local hf_repo="$2"
  local expected_sha256="${3:-}"
  local target="${MODELS_DIR}/${filename}"

  # Verify integrity if file exists
  if [[ -f "$target" ]]; then
    if [[ -n "$expected_sha256" ]]; then
      local actual_sha256
      log info "Verifying integrity: ${filename}..."
      actual_sha256=$(sha256sum "$target" | cut -d' ' -f1)
      if [[ "$actual_sha256" == "$expected_sha256" ]]; then
        local size_mb
        size_mb=$(du -m "$target" | cut -f1)
        log ok "GGUF model verified: ${filename} (${size_mb} MB)"
        return 0
      else
        log warn "GGUF model checksum mismatch: ${filename}"
        log warn "  expected: ${expected_sha256}"
        log warn "  actual:   ${actual_sha256}"
        log info "Re-downloading..."
        rm -f "$target"
      fi
    else
      local size_mb
      size_mb=$(du -m "$target" | cut -f1)
      log ok "GGUF model present: ${filename} (${size_mb} MB)"
      return 0
    fi
  fi

  mkdir -p "${MODELS_DIR}"
  log info "Downloading GGUF model: ${filename} from ${hf_repo}..."

  if command -v huggingface-cli &>/dev/null; then
    huggingface-cli download "${hf_repo}" "${filename}" \
      --local-dir "${MODELS_DIR}" \
      --local-dir-use-symlinks False
  elif command -v curl &>/dev/null; then
    curl -L -C - -o "$target" \
      "https://huggingface.co/${hf_repo}/resolve/main/${filename}" \
      --progress-bar
  else
    log error "Neither huggingface-cli nor curl found — cannot download GGUF model"
    return 1
  fi

  if [[ ! -f "$target" ]]; then
    log error "GGUF download failed: ${filename}"
    return 1
  fi

  # Verify downloaded file
  if [[ -n "$expected_sha256" ]]; then
    local actual_sha256
    actual_sha256=$(sha256sum "$target" | cut -d' ' -f1)
    if [[ "$actual_sha256" != "$expected_sha256" ]]; then
      log error "Downloaded file checksum mismatch: ${filename}"
      log error "  expected: ${expected_sha256}"
      log error "  actual:   ${actual_sha256}"
      rm -f "$target"
      return 1
    fi
  fi

  local size_mb
  size_mb=$(du -m "$target" | cut -f1)
  log ok "GGUF model downloaded and verified: ${filename} (${size_mb} MB)"
}

# ---------------------------------------------------------------------------
# Docker installation (interactive, requires sudo)
# ---------------------------------------------------------------------------
install_docker() {
  log info "Installing Docker (official repository)..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  log ok "Docker installed"

  log info "Installing NVIDIA Container Toolkit..."
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
    sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update -qq
  sudo apt-get install -y -qq nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  log ok "NVIDIA Container Toolkit installed"
}

# ═══════════════════════════════════════════════════════════════════════════
# --check mode
# ═══════════════════════════════════════════════════════════════════════════
if [[ "${1:-}" == "--check" ]]; then
  log_section "Anatoly Embedding Status"

  GPU=$(detect_gpu)
  VRAM_GB=$(detect_vram_gb)
  if [[ "$GPU" == "none" ]]; then
    log warn "GPU: not detected"
  else
    log ok "GPU: ${GPU} (${VRAM_GB} GB VRAM)"
  fi

  DOCKER_OK="false"
  TOOLKIT_OK="false"
  if has_docker; then DOCKER_OK="true"; log ok "Docker: available"; else log warn "Docker: not available"; fi
  if has_docker && has_nvidia_container_toolkit; then TOOLKIT_OK="true"; log ok "NVIDIA Container Toolkit: available"; fi

  TIER=$(select_tier "$GPU" "$VRAM_GB" "$DOCKER_OK" "$TOOLKIT_OK")

  CURRENT_BACKEND=""
  if [[ -f "$READY_FILE" ]]; then
    CURRENT_BACKEND=$(json_read ".backend" "$READY_FILE")
  fi
  BACKEND="${CURRENT_BACKEND:-$TIER}"
  log info "Backend: ${BACKEND}$([ -n "$CURRENT_BACKEND" ] && echo " (configured)" || echo " (recommended)")"

  log_separator

  if [[ "$BACKEND" == "advanced-gguf" ]]; then
    PASS=true

    if docker image inspect "$GGUF_DOCKER_IMAGE" &>/dev/null; then
      log ok "Docker image: ${GGUF_DOCKER_IMAGE}"
    else
      log warn "Docker image not pulled — run: npx anatoly setup-embeddings"
      PASS=false
    fi

    if [[ -f "${MODELS_DIR}/${GGUF_CODE_MODEL_FILE}" ]]; then
      log ok "Code GGUF: ${GGUF_CODE_MODEL_FILE} ($(du -m "${MODELS_DIR}/${GGUF_CODE_MODEL_FILE}" | cut -f1) MB)"
    else
      log warn "Code GGUF: not downloaded"
      PASS=false
    fi

    if [[ -f "${MODELS_DIR}/${GGUF_NLP_MODEL_FILE}" ]]; then
      log ok "NLP GGUF: ${GGUF_NLP_MODEL_FILE} ($(du -m "${MODELS_DIR}/${GGUF_NLP_MODEL_FILE}" | cut -f1) MB)"
    else
      log warn "NLP GGUF: not downloaded"
      PASS=false
    fi

    # Live embedding test if everything is present
    if [[ "$PASS" == "true" && -f "$SAMPLES_FILE" ]]; then
      log_separator
      CODE_COUNT=$(json_count_samples ".code" "$SAMPLES_FILE")
      NLP_COUNT=$(json_count_samples ".nlp" "$SAMPLES_FILE")
      log info "Live embedding test (${CODE_COUNT} code + ${NLP_COUNT} NLP samples)"

      start_gguf_containers "$MODELS_DIR" "$GGUF_CODE_MODEL_FILE" "$GGUF_NLP_MODEL_FILE"
      if ! wait_for_gguf 180; then
        log error "GGUF containers failed to start"
        stop_gguf_containers
        exit 1
      fi

      CODE_PASS=0 CODE_FAIL=0
      for i in $(seq 0 $((CODE_COUNT - 1))); do
        SAMPLE=$(json_get_sample_raw ".code[$i]" "$SAMPLES_FILE")
        CHARS=${#SAMPLE}
        T0=$(date +%s%N)
        RESP=$(embed_gguf "$SAMPLE" "$GGUF_CODE_PORT" 2>/dev/null || echo "")
        T1=$(date +%s%N)
        DT=$(( (T1 - T0) / 1000000 ))

        if [[ -n "$RESP" ]]; then
          VEC=$(extract_gguf_embedding "$RESP" 2>/dev/null || echo "")
          if [[ -n "$VEC" && "$VEC" != "null" ]]; then
            DIM=$(embedding_dim "$VEC")
            printf "    [%2d/%d] ✓ %5dms  (%s chars → %sd)\n" "$((i+1))" "$CODE_COUNT" "$DT" "$CHARS" "$DIM" >&2
            CODE_PASS=$((CODE_PASS + 1))
            continue
          fi
        fi
        printf "    [%2d/%d] ✗ %5dms  (%s chars)\n" "$((i+1))" "$CODE_COUNT" "$DT" "$CHARS" >&2
        CODE_FAIL=$((CODE_FAIL + 1))
      done
      [[ $CODE_FAIL -eq 0 ]] && log ok "Code: ${CODE_PASS}/${CODE_COUNT} passed" || log error "Code: ${CODE_PASS}/${CODE_COUNT} passed"

      NLP_PASS=0 NLP_FAIL=0
      for i in $(seq 0 $((NLP_COUNT - 1))); do
        SAMPLE=$(json_get_sample_raw ".nlp[$i]" "$SAMPLES_FILE")
        CHARS=${#SAMPLE}
        T0=$(date +%s%N)
        RESP=$(embed_gguf "$SAMPLE" "$GGUF_NLP_PORT" 2>/dev/null || echo "")
        T1=$(date +%s%N)
        DT=$(( (T1 - T0) / 1000000 ))

        if [[ -n "$RESP" ]]; then
          VEC=$(extract_gguf_embedding "$RESP" 2>/dev/null || echo "")
          if [[ -n "$VEC" && "$VEC" != "null" ]]; then
            DIM=$(embedding_dim "$VEC")
            printf "    [%2d/%d] ✓ %5dms  (%s chars → %sd)\n" "$((i+1))" "$NLP_COUNT" "$DT" "$CHARS" "$DIM" >&2
            NLP_PASS=$((NLP_PASS + 1))
            continue
          fi
        fi
        printf "    [%2d/%d] ✗ %5dms  (%s chars)\n" "$((i+1))" "$NLP_COUNT" "$DT" "$CHARS" >&2
        NLP_FAIL=$((NLP_FAIL + 1))
      done
      [[ $NLP_FAIL -eq 0 ]] && log ok "NLP: ${NLP_PASS}/${NLP_COUNT} passed" || log error "NLP: ${NLP_PASS}/${NLP_COUNT} passed"

      stop_gguf_containers

      if [[ $CODE_FAIL -gt 0 || $NLP_FAIL -gt 0 ]]; then
        log error "Embedding check failed"
        exit 1
      fi
      log ok "All $((CODE_COUNT + NLP_COUNT)) embeddings verified"
    fi
  else
    log ok "ONNX runtime: bundled (no external dependencies)"
  fi

  echo ""
  exit 0
fi


# ═══════════════════════════════════════════════════════════════════════════
# Main setup flow
# ═══════════════════════════════════════════════════════════════════════════
log_section "Anatoly — Embedding Setup"

# Step 0: Purge stale embedding config (clean slate)
purge_embedding_configs

# Step 1: Prerequisites
log info "Checking prerequisites..."
ensure_jq
ensure_curl

GPU=$(detect_gpu)
VRAM_GB=$(detect_vram_gb)
DOCKER_OK="false"
TOOLKIT_OK="false"

if [[ "$GPU" == "none" ]]; then
  log warn "No GPU detected — embeddings will run on CPU (lite mode)"
else
  log ok "GPU detected: ${GPU} (${VRAM_GB} GB VRAM)"
fi

if has_docker; then
  DOCKER_OK="true"
  log ok "Docker: available"
  if [[ "$GPU" == "cuda" ]] && has_nvidia_container_toolkit; then
    TOOLKIT_OK="true"
    log ok "NVIDIA Container Toolkit: available"
  elif [[ "$GPU" == "cuda" ]]; then
    log warn "NVIDIA Container Toolkit: not found"
    log info "  Install: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
  fi
else
  if [[ "$GPU" == "cuda" && "$VRAM_GB" -ge "$GGUF_MIN_VRAM_GB" ]]; then
    log warn "Docker not found. Required for GPU embedding backend."
    echo ""
    log info "Docker enables GGUF quantized models (~10 GB VRAM for both models"
    log info "loaded simultaneously). Without Docker, only ONNX CPU is available."
    echo ""
    read -r -p "  Install Docker + NVIDIA Container Toolkit now? (requires sudo) [y/N] " INSTALL_DOCKER
    if [[ "${INSTALL_DOCKER,,}" == "y" ]]; then
      install_docker
      if has_docker; then
        DOCKER_OK="true"
        if has_nvidia_container_toolkit; then
          TOOLKIT_OK="true"
        fi
      else
        log warn "Docker installed but not available yet."
        log info "You may need to log out and log back in (for docker group), then re-run setup."
      fi
    else
      log info "Skipping Docker install. Using lite mode (ONNX CPU)."
    fi
  else
    log info "Docker: not available (needed for GPU backends)"
  fi
fi

# Step 2: Determine tier
TIER=$(select_tier "$GPU" "$VRAM_GB" "$DOCKER_OK" "$TOOLKIT_OK")
log info "Selected tier: ${TIER}"

# Step 3: If lite, write config and exit
if [[ "$TIER" == "lite" ]]; then
  write_embeddings_ready "$READY_FILE" \
    --arg backend "lite" \
    --arg device "$GPU" \
    --argjson vram_gb "$VRAM_GB" \
    --arg setup_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{backend: $backend, device: $device, vram_gb: $vram_gb, dim_code: 768, dim_nlp: 384, setup_at: $setup_at}'

  log_section "Setup complete — lite mode"
  log info "Using ONNX CPU embeddings (no GPU needed)."
  log info "To check status: npx anatoly setup-embeddings --check"
  exit 0
fi

# Step 4: Download GGUF models
log_separator
log info "Downloading GGUF models..."
download_gguf_model "$GGUF_CODE_MODEL_FILE" "$GGUF_CODE_HF_REPO" "$GGUF_CODE_SHA256"
download_gguf_model "$GGUF_NLP_MODEL_FILE" "$GGUF_NLP_HF_REPO" "$GGUF_NLP_SHA256"

# Step 5: Pull Docker images
log_separator
log info "Pulling Docker images..."

if docker image inspect "$GGUF_DOCKER_IMAGE" &>/dev/null; then
  log ok "GGUF Docker image already present — skipping pull"
elif docker pull "$GGUF_DOCKER_IMAGE"; then
  log ok "GGUF Docker image ready"
else
  log error "Failed to pull GGUF Docker image"
  log warn "Falling back to lite mode"
  write_embeddings_ready "$READY_FILE" \
    --arg backend "lite" \
    --arg device "$GPU" \
    --argjson vram_gb "$VRAM_GB" \
    --arg setup_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{backend: $backend, device: $device, vram_gb: $vram_gb, dim_code: 768, dim_nlp: 384, setup_at: $setup_at}'
  exit 0
fi

# Step 6: Quick GGUF smoke test
log_separator
log info "Testing GGUF containers..."

CODE_CONTAINER="${CONTAINER_PREFIX}-gguf-test-$$"
start_gguf_container "$CODE_CONTAINER" "$MODELS_DIR" "$GGUF_CODE_MODEL_FILE" "$GGUF_CODE_PORT"

if wait_for_health "http://127.0.0.1:${GGUF_CODE_PORT}/health" 120; then
  RESP=$(embed_gguf "function hello() { return world; }" "$GGUF_CODE_PORT" 2>/dev/null || echo "")
  VEC=$(extract_gguf_embedding "$RESP" 2>/dev/null || echo "")
  if [[ -n "$VEC" && "$VEC" != "null" ]]; then
    CODE_DIM=$(embedding_dim "$VEC")
    log ok "GGUF code embedding OK (${CODE_DIM}d)"
  else
    log error "GGUF code embedding failed"
    log warn "Falling back to lite mode"
    TIER="lite"
  fi
else
  log error "GGUF code container failed to start"
  TIER="lite"
fi
docker_rm "$CODE_CONTAINER"
sleep 2

if [[ "$TIER" == "lite" ]]; then
  write_embeddings_ready "$READY_FILE" \
    --arg backend "lite" \
    --arg device "$GPU" \
    --argjson vram_gb "$VRAM_GB" \
    --arg setup_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{backend: $backend, device: $device, vram_gb: $vram_gb, dim_code: 768, dim_nlp: 384, setup_at: $setup_at}'
  exit 0
fi

BACKEND="advanced-gguf"
NLP_DIM=4096
CODE_DIM="${CODE_DIM:-768}"

# Step 7: Write final config
write_embeddings_ready "$READY_FILE" \
  --arg backend "$BACKEND" \
  --arg code_model "$CODE_MODEL_ID" \
  --arg nlp_model "$NLP_MODEL_ID" \
  --argjson dim_code "${CODE_DIM}" \
  --argjson dim_nlp "${NLP_DIM}" \
  --arg device "$GPU" \
  --argjson vram_gb "$VRAM_GB" \
  --arg docker_image "$GGUF_DOCKER_IMAGE" \
  --arg gguf_code_model "${MODELS_DIR}/${GGUF_CODE_MODEL_FILE}" \
  --arg gguf_nlp_model "${MODELS_DIR}/${GGUF_NLP_MODEL_FILE}" \
  --arg setup_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    backend: $backend,
    code_model: $code_model,
    nlp_model: $nlp_model,
    dim_code: $dim_code,
    dim_nlp: $dim_nlp,
    device: $device,
    vram_gb: $vram_gb,
    docker_image: $docker_image,
    gguf_code_model: $gguf_code_model,
    gguf_nlp_model: $gguf_nlp_model,
    setup_at: $setup_at
  }'

# Step 8: Summary
log_section "Setup complete!"
log info "Backend:    ${BACKEND}"
log info "Device:     ${GPU} (${VRAM_GB} GB VRAM)"
log info "Code model: ${CODE_MODEL_ID} (${CODE_DIM}d)"
log info "NLP model:  ${NLP_MODEL_ID} (${NLP_DIM}d)"
if [[ "$BACKEND" == "advanced-gguf" ]]; then
  log info "GGUF code:  ${GGUF_CODE_MODEL_FILE}"
  log info "GGUF NLP:   ${GGUF_NLP_MODEL_FILE}"
  log info "Docker:     ${GGUF_DOCKER_IMAGE}"
fi
log info "Config:     .anatoly/embeddings-ready.json"
echo ""
if [[ "$BACKEND" == "advanced-gguf" ]]; then
  log info "Both GGUF models load simultaneously (~10 GB VRAM). No swap needed."
  log info "Containers start automatically with 'npx anatoly run'."
else
  log info "Using ONNX CPU embeddings."
fi
log info "To check status: npx anatoly setup-embeddings --check"
echo ""
