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
# A/B testing uses HuggingFace TEI (Text Embeddings Inference) as the fp16
# reference to validate GGUF quality. TEI is only used during setup, never
# at runtime — GGUF is always the runtime backend when GPU is available.
#
# Usage:
#   ./scripts/setup-embeddings.sh           # Full setup + A/B test
#   ./scripts/setup-embeddings.sh --check   # Check status only
#   ./scripts/setup-embeddings.sh --ab-test # Run A/B test only (models must exist)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODELS_DIR="${PROJECT_ROOT}/.anatoly/models"
AB_RESULT_FILE="${PROJECT_ROOT}/.anatoly/embedding-ab-results.json"
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

# A/B test thresholds
MIN_COSINE_SIM=0.995

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
  stop_tei_containers 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Purge stale embedding configs (clean slate for setup)
# ---------------------------------------------------------------------------
purge_embedding_configs() {
  local purged=false
  for f in \
    "${READY_FILE}" \
    "${AB_RESULT_FILE}" \
    "${PROJECT_ROOT}/.anatoly/ab-gguf-cache.json" \
    "${PROJECT_ROOT}/.anatoly/ab-bf16-cache.json" \
    "${PROJECT_ROOT}/.anatoly/ab-test-results.json"
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
# A/B test function (GGUF vs TEI)
# ═══════════════════════════════════════════════════════════════════════════
run_ab_test() {
  log_section "A/B Test — GGUF vs TEI (fp16 reference)"

  if [[ ! -f "$SAMPLES_FILE" ]]; then
    log error "check-samples.json not found at ${SAMPLES_FILE}"
    return 1
  fi

  local CODE_COUNT NLP_COUNT
  CODE_COUNT=$(json_count_samples ".code" "$SAMPLES_FILE")
  NLP_COUNT=$(json_count_samples ".nlp" "$SAMPLES_FILE")
  log info "Samples: ${CODE_COUNT} code + ${NLP_COUNT} NLP"

  # Temp directory for vector files (avoids ARG_MAX with large embeddings)
  local AB_TMP="${PROJECT_ROOT}/.anatoly/ab-tmp"
  mkdir -p "$AB_TMP"

  # --- Phase 0: Clean slate ---
  log info "Cleaning up existing containers and ports..."
  docker_cleanup_all
  free_all_ports
  flush_gpu_memory

  local VRAM_BASELINE
  VRAM_BASELINE=$(detect_vram_used_mib)
  log info "VRAM baseline: ${VRAM_BASELINE} MiB"

  # --- Phase A: GGUF embeddings (sequential — one model at a time) ---
  log_separator
  log info "Phase A: GGUF embeddings"

  # --- Phase A.1: GGUF code ---
  local code_name="${CONTAINER_PREFIX}-gguf-code"
  log info "Starting GGUF code container (${GGUF_CODE_PORT})..."
  local GGUF_CODE_LOAD_START
  GGUF_CODE_LOAD_START=$(date +%s)
  start_gguf_container "$code_name" "$MODELS_DIR" "$GGUF_CODE_MODEL_FILE" "$GGUF_CODE_PORT"
  if ! wait_for_health "http://127.0.0.1:${GGUF_CODE_PORT}/health" 180; then
    log error "GGUF code container failed — aborting A/B test"
    docker_rm "$code_name"
    rm -rf "$AB_TMP"
    return 1
  fi
  local GGUF_CODE_LOAD_MS=$(( ($(date +%s) - GGUF_CODE_LOAD_START) * 1000 ))
  log ok "GGUF code container ready (${GGUF_CODE_LOAD_MS}ms)"

  local VRAM_GGUF_CODE
  VRAM_GGUF_CODE=$(detect_vram_used_mib)
  log info "GGUF code VRAM: $(( VRAM_GGUF_CODE - VRAM_BASELINE )) MiB"

  log info "Getting GGUF code embeddings..."
  : > "${AB_TMP}/gguf_code_vecs.jsonl"
  local GGUF_CODE_LATENCIES="[]"
  local GGUF_CODE_DIM=0
  for i in $(seq 0 $((CODE_COUNT - 1))); do
    local SAMPLE
    SAMPLE=$(json_get_sample_raw ".code[$i]" "$SAMPLES_FILE")
    local T0 T1 DT
    T0=$(date +%s%N)
    local RESP
    RESP=$(embed_gguf "$SAMPLE" "$GGUF_CODE_PORT" 2>/dev/null || echo "")
    T1=$(date +%s%N)
    DT=$(( (T1 - T0) / 1000000 ))

    local VEC
    VEC=$(extract_gguf_embedding "$RESP" 2>/dev/null || echo "[]")
    GGUF_CODE_DIM=$(embedding_dim "$VEC")
    echo "$VEC" >> "${AB_TMP}/gguf_code_vecs.jsonl"
    GGUF_CODE_LATENCIES=$(echo "$GGUF_CODE_LATENCIES" | jq --argjson v "$DT" '. + [$v]')
    printf "    [%2d/%d] %5dms (%sd)\n" "$((i+1))" "$CODE_COUNT" "$DT" "$GGUF_CODE_DIM" >&2
  done

  docker_rm "$code_name"
  sleep 5
  free_all_ports

  # --- Phase A.2: GGUF NLP ---
  local nlp_name="${CONTAINER_PREFIX}-gguf-nlp"
  log info "Starting GGUF NLP container (${GGUF_NLP_PORT})..."
  local GGUF_NLP_LOAD_START
  GGUF_NLP_LOAD_START=$(date +%s)
  start_gguf_container "$nlp_name" "$MODELS_DIR" "$GGUF_NLP_MODEL_FILE" "$GGUF_NLP_PORT"
  if ! wait_for_health "http://127.0.0.1:${GGUF_NLP_PORT}/health" 180; then
    log error "GGUF NLP container failed — aborting A/B test"
    docker_rm "$nlp_name"
    rm -rf "$AB_TMP"
    return 1
  fi
  local GGUF_NLP_LOAD_MS=$(( ($(date +%s) - GGUF_NLP_LOAD_START) * 1000 ))
  log ok "GGUF NLP container ready (${GGUF_NLP_LOAD_MS}ms)"

  local VRAM_GGUF_NLP
  VRAM_GGUF_NLP=$(detect_vram_used_mib)
  log info "GGUF NLP VRAM: $(( VRAM_GGUF_NLP - VRAM_BASELINE )) MiB"

  log info "Getting GGUF NLP embeddings..."
  : > "${AB_TMP}/gguf_nlp_vecs.jsonl"
  local GGUF_NLP_LATENCIES="[]"
  local GGUF_NLP_DIM=0
  for i in $(seq 0 $((NLP_COUNT - 1))); do
    local SAMPLE
    SAMPLE=$(json_get_sample_raw ".nlp[$i]" "$SAMPLES_FILE")
    local T0 T1 DT
    T0=$(date +%s%N)
    local RESP
    RESP=$(embed_gguf "$SAMPLE" "$GGUF_NLP_PORT" 2>/dev/null || echo "")
    T1=$(date +%s%N)
    DT=$(( (T1 - T0) / 1000000 ))

    local VEC
    VEC=$(extract_gguf_embedding "$RESP" 2>/dev/null || echo "[]")
    GGUF_NLP_DIM=$(embedding_dim "$VEC")
    echo "$VEC" >> "${AB_TMP}/gguf_nlp_vecs.jsonl"
    GGUF_NLP_LATENCIES=$(echo "$GGUF_NLP_LATENCIES" | jq --argjson v "$DT" '. + [$v]')
    printf "    [%2d/%d] %5dms (%sd)\n" "$((i+1))" "$NLP_COUNT" "$DT" "$GGUF_NLP_DIM" >&2
  done

  # Sanity probes: embed similar + dissimilar pairs while NLP container is still up
  local SANITY_SIMILAR="The cat sat on the mat"
  local SANITY_DISSIMILAR="function fibonacci(n) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }"
  local SANITY_PARAPHRASE="A cat was sitting on a mat"

  log info "GGUF NLP sanity check..."
  local GGUF_SIM_VEC GGUF_DIS_VEC GGUF_PAR_VEC
  GGUF_SIM_VEC=$(embed_gguf "$SANITY_SIMILAR" "$GGUF_NLP_PORT" 2>/dev/null | jq -c "$(cat <<'JQ'
    if type == "array" then .[0].embedding[0]
    elif .results then .results[0].embedding[0]
    elif .embedding then .embedding[0]
    else empty end
JQ
  )" || echo "[]")
  GGUF_DIS_VEC=$(embed_gguf "$SANITY_DISSIMILAR" "$GGUF_NLP_PORT" 2>/dev/null | jq -c "$(cat <<'JQ'
    if type == "array" then .[0].embedding[0]
    elif .results then .results[0].embedding[0]
    elif .embedding then .embedding[0]
    else empty end
JQ
  )" || echo "[]")
  GGUF_PAR_VEC=$(embed_gguf "$SANITY_PARAPHRASE" "$GGUF_NLP_PORT" 2>/dev/null | jq -c "$(cat <<'JQ'
    if type == "array" then .[0].embedding[0]
    elif .results then .results[0].embedding[0]
    elif .embedding then .embedding[0]
    else empty end
JQ
  )" || echo "[]")

  # Write sanity vectors to temp files to avoid ARG_MAX
  echo "$GGUF_SIM_VEC" > "${AB_TMP}/sanity_gguf_sim.json"
  echo "$GGUF_DIS_VEC" > "${AB_TMP}/sanity_gguf_dis.json"
  echo "$GGUF_PAR_VEC" > "${AB_TMP}/sanity_gguf_par.json"

  local GGUF_SANITY_SIM GGUF_SANITY_DIS GGUF_SANITY_SEP
  GGUF_SANITY_SIM=$(jq -n --slurpfile a "${AB_TMP}/sanity_gguf_sim.json" --slurpfile b "${AB_TMP}/sanity_gguf_par.json" \
    '$a[0] as $x | $b[0] as $y | ([range($x|length)] | map($x[.] * $y[.]) | add) / (([range($x|length)] | map($x[.] * $x[.]) | add | sqrt) * ([range($y|length)] | map($y[.] * $y[.]) | add | sqrt))')
  GGUF_SANITY_DIS=$(jq -n --slurpfile a "${AB_TMP}/sanity_gguf_sim.json" --slurpfile b "${AB_TMP}/sanity_gguf_dis.json" \
    '$a[0] as $x | $b[0] as $y | ([range($x|length)] | map($x[.] * $y[.]) | add) / (([range($x|length)] | map($x[.] * $x[.]) | add | sqrt) * ([range($y|length)] | map($y[.] * $y[.]) | add | sqrt))')
  GGUF_SANITY_SEP=$(jq -n --argjson s "$GGUF_SANITY_SIM" --argjson d "$GGUF_SANITY_DIS" '$s - $d')
  log info "GGUF NLP: similar=${GGUF_SANITY_SIM} dissimilar=${GGUF_SANITY_DIS} separation=${GGUF_SANITY_SEP}"

  docker_rm "$nlp_name"
  log info "Cooling down (releasing VRAM)..."
  flush_gpu_memory
  free_all_ports

  # --- Phase B: TEI embeddings (fp16 reference) ---
  log_separator
  log info "Phase B: TEI fp16 embeddings (reference)"

  # Pull TEI image if not present
  if ! docker image inspect "$TEI_DOCKER_IMAGE" &>/dev/null; then
    log info "Pulling TEI image: ${TEI_DOCKER_IMAGE}..."
    if docker pull "$TEI_DOCKER_IMAGE" >&2; then
      log ok "TEI image pulled"
    else
      log error "Failed to pull TEI image"
      stop_tei_containers
      rm -rf "$AB_TMP"
      return 1
    fi
  fi

  # TEI code model
  log info "Starting TEI code container (${CODE_MODEL_ID})..."
  local TEI_CODE_LOAD_START
  TEI_CODE_LOAD_START=$(date +%s)
  start_tei_container "${CONTAINER_PREFIX}-tei-code" "$CODE_MODEL_ID" "$TEI_CODE_PORT"
  if ! wait_for_tei "$TEI_CODE_PORT" "code" 600; then
    log error "TEI code container failed — aborting A/B test"
    stop_tei_containers
    rm -rf "$AB_TMP"
    return 1
  fi
  local TEI_CODE_LOAD_MS=$(( ($(date +%s) - TEI_CODE_LOAD_START) * 1000 ))
  log info "TEI code load time: ${TEI_CODE_LOAD_MS}ms"

  local VRAM_TEI
  VRAM_TEI=$(detect_vram_used_mib)
  log info "TEI code VRAM: $(( VRAM_TEI - VRAM_BASELINE )) MiB"

  log info "Getting TEI code embeddings..."
  : > "${AB_TMP}/tei_code_vecs.jsonl"
  local TEI_CODE_LATENCIES="[]"
  local TEI_CODE_DIM=0
  for i in $(seq 0 $((CODE_COUNT - 1))); do
    local SAMPLE
    SAMPLE=$(json_get_sample_raw ".code[$i]" "$SAMPLES_FILE")
    local T0 T1 DT
    T0=$(date +%s%N)
    local RESP
    RESP=$(embed_tei "$SAMPLE" "$TEI_CODE_PORT" 2>/dev/null || echo "")
    T1=$(date +%s%N)
    DT=$(( (T1 - T0) / 1000000 ))

    local VEC
    VEC=$(extract_tei_embedding "$RESP" 2>/dev/null || echo "[]")
    TEI_CODE_DIM=$(embedding_dim "$VEC")
    echo "$VEC" >> "${AB_TMP}/tei_code_vecs.jsonl"
    TEI_CODE_LATENCIES=$(echo "$TEI_CODE_LATENCIES" | jq --argjson v "$DT" '. + [$v]')
    printf "    [%2d/%d] %5dms (%sd)\n" "$((i+1))" "$CODE_COUNT" "$DT" "$TEI_CODE_DIM" >&2
  done

  # Stop code container, start NLP
  stop_tei_containers
  log info "Cooling down (releasing VRAM)..."
  sleep 10
  free_all_ports

  log info "Starting TEI NLP container (${NLP_MODEL_ID})..."
  local TEI_NLP_LOAD_START
  TEI_NLP_LOAD_START=$(date +%s)
  start_tei_container "${CONTAINER_PREFIX}-tei-nlp" "$NLP_MODEL_ID" "$TEI_NLP_PORT"
  if ! wait_for_tei "$TEI_NLP_PORT" "NLP" 600; then
    log error "TEI NLP container failed — aborting A/B test"
    stop_tei_containers
    rm -rf "$AB_TMP"
    return 1
  fi
  local TEI_NLP_LOAD_MS=$(( ($(date +%s) - TEI_NLP_LOAD_START) * 1000 ))
  log info "TEI NLP load time: ${TEI_NLP_LOAD_MS}ms"

  log info "Getting TEI NLP embeddings..."
  : > "${AB_TMP}/tei_nlp_vecs.jsonl"
  local TEI_NLP_LATENCIES="[]"
  local TEI_NLP_DIM=0
  for i in $(seq 0 $((NLP_COUNT - 1))); do
    local SAMPLE
    SAMPLE=$(json_get_sample_raw ".nlp[$i]" "$SAMPLES_FILE")
    local T0 T1 DT
    T0=$(date +%s%N)
    local RESP
    RESP=$(embed_tei "$SAMPLE" "$TEI_NLP_PORT" 2>/dev/null || echo "")
    T1=$(date +%s%N)
    DT=$(( (T1 - T0) / 1000000 ))

    local VEC
    VEC=$(extract_tei_embedding "$RESP" 2>/dev/null || echo "[]")
    TEI_NLP_DIM=$(embedding_dim "$VEC")
    echo "$VEC" >> "${AB_TMP}/tei_nlp_vecs.jsonl"
    TEI_NLP_LATENCIES=$(echo "$TEI_NLP_LATENCIES" | jq --argjson v "$DT" '. + [$v]')
    printf "    [%2d/%d] %5dms (%sd)\n" "$((i+1))" "$NLP_COUNT" "$DT" "$TEI_NLP_DIM" >&2
  done

  # TEI NLP sanity check (same probes as GGUF)
  log info "TEI NLP sanity check..."
  local TEI_SIM_VEC TEI_DIS_VEC TEI_PAR_VEC
  TEI_SIM_VEC=$(embed_tei "$SANITY_SIMILAR" "$TEI_NLP_PORT" 2>/dev/null | jq -c '.[0]' || echo "[]")
  TEI_DIS_VEC=$(embed_tei "$SANITY_DISSIMILAR" "$TEI_NLP_PORT" 2>/dev/null | jq -c '.[0]' || echo "[]")
  TEI_PAR_VEC=$(embed_tei "$SANITY_PARAPHRASE" "$TEI_NLP_PORT" 2>/dev/null | jq -c '.[0]' || echo "[]")

  echo "$TEI_SIM_VEC" > "${AB_TMP}/sanity_tei_sim.json"
  echo "$TEI_DIS_VEC" > "${AB_TMP}/sanity_tei_dis.json"
  echo "$TEI_PAR_VEC" > "${AB_TMP}/sanity_tei_par.json"

  local TEI_SANITY_SIM TEI_SANITY_DIS TEI_SANITY_SEP
  TEI_SANITY_SIM=$(jq -n --slurpfile a "${AB_TMP}/sanity_tei_sim.json" --slurpfile b "${AB_TMP}/sanity_tei_par.json" \
    '$a[0] as $x | $b[0] as $y | ([range($x|length)] | map($x[.] * $y[.]) | add) / (([range($x|length)] | map($x[.] * $x[.]) | add | sqrt) * ([range($y|length)] | map($y[.] * $y[.]) | add | sqrt))')
  TEI_SANITY_DIS=$(jq -n --slurpfile a "${AB_TMP}/sanity_tei_sim.json" --slurpfile b "${AB_TMP}/sanity_tei_dis.json" \
    '$a[0] as $x | $b[0] as $y | ([range($x|length)] | map($x[.] * $y[.]) | add) / (([range($x|length)] | map($x[.] * $x[.]) | add | sqrt) * ([range($y|length)] | map($y[.] * $y[.]) | add | sqrt))')
  TEI_SANITY_SEP=$(jq -n --argjson s "$TEI_SANITY_SIM" --argjson d "$TEI_SANITY_DIS" '$s - $d')
  log info "TEI  NLP: similar=${TEI_SANITY_SIM} dissimilar=${TEI_SANITY_DIS} separation=${TEI_SANITY_SEP}"

  stop_tei_containers

  # --- Phase C: Comparison ---
  log_separator
  log info "Phase C: Comparing GGUF vs TEI embeddings"

  # Compute cosine similarities — read vectors from files to avoid ARG_MAX
  local CODE_SIMS NLP_SIMS
  log info "Computing code cosine similarities..."
  CODE_SIMS=$(jq -n \
    --slurpfile gguf "${AB_TMP}/gguf_code_vecs.jsonl" \
    --slurpfile tei "${AB_TMP}/tei_code_vecs.jsonl" '
    [range($gguf | length) | . as $i |
      $gguf[$i] as $a | $tei[$i] as $b |
      ([range($a|length)] | map($a[.] * $b[.]) | add) /
      (([range($a|length)] | map($a[.] * $a[.]) | add | sqrt) *
       ([range($b|length)] | map($b[.] * $b[.]) | add | sqrt))
    ]
  ')
  echo "$CODE_SIMS" | jq -r 'length as $n | to_entries[] | "    [\((.key+1) | tostring | if length < 2 then " "+. else . end)/\($n)] sim=\(.value | tostring | .[:8])"' >&2

  log info "Computing NLP cosine similarities..."
  NLP_SIMS=$(jq -n \
    --slurpfile gguf "${AB_TMP}/gguf_nlp_vecs.jsonl" \
    --slurpfile tei "${AB_TMP}/tei_nlp_vecs.jsonl" '
    [range($gguf | length) | . as $i |
      $gguf[$i] as $a | $tei[$i] as $b |
      ([range($a|length)] | map($a[.] * $b[.]) | add) /
      (([range($a|length)] | map($a[.] * $a[.]) | add | sqrt) *
       ([range($b|length)] | map($b[.] * $b[.]) | add | sqrt))
    ]
  ')
  echo "$NLP_SIMS" | jq -r 'length as $n | to_entries[] | "    [\((.key+1) | tostring | if length < 2 then " "+. else . end)/\($n)] sim=\(.value | tostring | .[:8])"' >&2

  # Compute averages and ranking preservation
  local AVG_CODE_SIM AVG_NLP_SIM
  AVG_CODE_SIM=$(echo "$CODE_SIMS" | jq '[.[] | select(. >= 0)] | if length > 0 then add / length else 0 end')
  AVG_NLP_SIM=$(echo "$NLP_SIMS" | jq '[.[] | select(. >= 0)] | if length > 0 then add / length else 0 end')

  local CODE_DIM_MATCH NLP_DIM_MATCH
  CODE_DIM_MATCH=$([[ "$GGUF_CODE_DIM" == "$TEI_CODE_DIM" ]] && echo "true" || echo "false")
  NLP_DIM_MATCH=$([[ "$GGUF_NLP_DIM" == "$TEI_NLP_DIM" ]] && echo "true" || echo "false")

  # Ranking preservation: check top-3 for code samples (read from files)
  log info "Checking ranking preservation..."
  local RANKING_PRESERVED RANKING_TOTAL
  RANKING_TOTAL="$CODE_COUNT"
  RANKING_PRESERVED=$(jq -n \
    --slurpfile gguf "${AB_TMP}/gguf_code_vecs.jsonl" \
    --slurpfile tei "${AB_TMP}/tei_code_vecs.jsonl" '
    def cosine(a;b):
      ([range(a|length)] | map(a[.] * b[.]) | add) /
      (([range(a|length)] | map(a[.] * a[.]) | add | sqrt) *
       ([range(b|length)] | map(b[.] * b[.]) | add | sqrt));
    def top3(vecs; idx):
      [range(vecs|length)] | map(select(. != idx)) |
      map({idx: ., sim: cosine(vecs[idx]; vecs[.])}) |
      sort_by(-.sim) | .[0:3] | map(.idx);
    [range($gguf|length)] | map(select(top3($gguf; .) == top3($tei; .))) | length
  ')
  log info "Ranking preserved: ${RANKING_PRESERVED}/${RANKING_TOTAL}"

  # Recommendation logic
  local RECOMMENDATION REASON
  if [[ "$CODE_DIM_MATCH" == "false" || "$NLP_DIM_MATCH" == "false" ]]; then
    RECOMMENDATION="lite"
    REASON="Dimension mismatch (GGUF code: ${GGUF_CODE_DIM}, TEI code: ${TEI_CODE_DIM}, GGUF NLP: ${GGUF_NLP_DIM}, TEI NLP: ${TEI_NLP_DIM})"
  elif jq -e ". < ${MIN_COSINE_SIM}" <<< "$AVG_CODE_SIM" &>/dev/null; then
    RECOMMENDATION="lite"
    REASON="Code cosine similarity ${AVG_CODE_SIM} below threshold ${MIN_COSINE_SIM}"
  elif jq -e ". < ${MIN_COSINE_SIM}" <<< "$AVG_NLP_SIM" &>/dev/null; then
    RECOMMENDATION="lite"
    REASON="NLP cosine similarity ${AVG_NLP_SIM} below threshold ${MIN_COSINE_SIM}"
  elif [[ "$RANKING_PRESERVED" -lt "$RANKING_TOTAL" ]]; then
    # Partial ranking change — still OK if similarity is very high
    if jq -e ". >= 0.997" <<< "$AVG_CODE_SIM" &>/dev/null; then
      RECOMMENDATION="advanced-gguf"
      REASON="Similarity ${AVG_CODE_SIM} >= 0.997 despite partial ranking change (${RANKING_PRESERVED}/${RANKING_TOTAL})"
    else
      RECOMMENDATION="lite"
      REASON="Ranking not preserved (${RANKING_PRESERVED}/${RANKING_TOTAL}) with similarity ${AVG_CODE_SIM}"
    fi
  else
    RECOMMENDATION="advanced-gguf"
    REASON="Similarity ${AVG_CODE_SIM} >= ${MIN_COSINE_SIM}, ranking preserved (${RANKING_PRESERVED}/${RANKING_TOTAL})"
  fi

  # Compute average latencies
  local AVG_GGUF_CODE_LAT AVG_GGUF_NLP_LAT AVG_TEI_CODE_LAT AVG_TEI_NLP_LAT
  AVG_GGUF_CODE_LAT=$(echo "$GGUF_CODE_LATENCIES" | jq 'add / length | round')
  AVG_GGUF_NLP_LAT=$(echo "$GGUF_NLP_LATENCIES" | jq 'add / length | round')
  AVG_TEI_CODE_LAT=$(echo "$TEI_CODE_LATENCIES" | jq 'add / length | round')
  AVG_TEI_NLP_LAT=$(echo "$TEI_NLP_LATENCIES" | jq 'add / length | round')

  # Write results — read vectors from files to avoid ARG_MAX
  jq -n \
    --arg test_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg gpu "$(detect_gpu)" \
    --argjson vram_gb "$(detect_vram_gb)" \
    --argjson vram_baseline_mib "$VRAM_BASELINE" \
    --argjson vram_gguf_mib "$(( VRAM_GGUF_CODE > VRAM_GGUF_NLP ? VRAM_GGUF_CODE : VRAM_GGUF_NLP ))" \
    --argjson vram_tei_mib "$VRAM_TEI" \
    --argjson gguf_code_dim "$GGUF_CODE_DIM" \
    --argjson gguf_nlp_dim "$GGUF_NLP_DIM" \
    --argjson tei_code_dim "$TEI_CODE_DIM" \
    --argjson tei_nlp_dim "$TEI_NLP_DIM" \
    --argjson code_dim_match "$CODE_DIM_MATCH" \
    --argjson nlp_dim_match "$NLP_DIM_MATCH" \
    --argjson avg_code_cosine_sim "$AVG_CODE_SIM" \
    --argjson avg_nlp_cosine_sim "$AVG_NLP_SIM" \
    --argjson code_sims "$CODE_SIMS" \
    --argjson nlp_sims "$NLP_SIMS" \
    --argjson ranking_preserved "$RANKING_PRESERVED" \
    --argjson ranking_total "$RANKING_TOTAL" \
    --argjson gguf_code_latencies "$GGUF_CODE_LATENCIES" \
    --argjson gguf_nlp_latencies "$GGUF_NLP_LATENCIES" \
    --argjson tei_code_latencies "$TEI_CODE_LATENCIES" \
    --argjson tei_nlp_latencies "$TEI_NLP_LATENCIES" \
    --argjson avg_gguf_code_latency_ms "$AVG_GGUF_CODE_LAT" \
    --argjson avg_gguf_nlp_latency_ms "$AVG_GGUF_NLP_LAT" \
    --argjson avg_tei_code_latency_ms "$AVG_TEI_CODE_LAT" \
    --argjson avg_tei_nlp_latency_ms "$AVG_TEI_NLP_LAT" \
    --arg recommendation "$RECOMMENDATION" \
    --arg reason "$REASON" \
    --argjson gguf_code_load_ms "$GGUF_CODE_LOAD_MS" \
    --argjson gguf_nlp_load_ms "$GGUF_NLP_LOAD_MS" \
    --argjson tei_code_load_ms "$TEI_CODE_LOAD_MS" \
    --argjson tei_nlp_load_ms "$TEI_NLP_LOAD_MS" \
    --argjson gguf_sanity_sim "$GGUF_SANITY_SIM" \
    --argjson gguf_sanity_dis "$GGUF_SANITY_DIS" \
    --argjson gguf_sanity_sep "$GGUF_SANITY_SEP" \
    --argjson tei_sanity_sim "$TEI_SANITY_SIM" \
    --argjson tei_sanity_dis "$TEI_SANITY_DIS" \
    --argjson tei_sanity_sep "$TEI_SANITY_SEP" \
    '{
      test_date: $test_date,
      hardware: {gpu: $gpu, vram_gb: $vram_gb, vram_baseline_mib: $vram_baseline_mib},
      gguf: {
        code_dim: $gguf_code_dim, nlp_dim: $gguf_nlp_dim,
        avg_code_latency_ms: $avg_gguf_code_latency_ms,
        avg_nlp_latency_ms: $avg_gguf_nlp_latency_ms,
        vram_mib: $vram_gguf_mib,
        code_latencies_ms: $gguf_code_latencies,
        nlp_latencies_ms: $gguf_nlp_latencies,
        code_load_ms: $gguf_code_load_ms,
        nlp_load_ms: $gguf_nlp_load_ms,
        sanity: {similar: $gguf_sanity_sim, dissimilar: $gguf_sanity_dis, separation: $gguf_sanity_sep}
      },
      tei: {
        code_dim: $tei_code_dim, nlp_dim: $tei_nlp_dim,
        avg_code_latency_ms: $avg_tei_code_latency_ms,
        avg_nlp_latency_ms: $avg_tei_nlp_latency_ms,
        vram_mib: $vram_tei_mib,
        code_latencies_ms: $tei_code_latencies,
        nlp_latencies_ms: $tei_nlp_latencies,
        code_load_ms: $tei_code_load_ms,
        nlp_load_ms: $tei_nlp_load_ms,
        sanity: {similar: $tei_sanity_sim, dissimilar: $tei_sanity_dis, separation: $tei_sanity_sep}
      },
      comparison: {
        avg_code_cosine_sim: $avg_code_cosine_sim,
        avg_nlp_cosine_sim: $avg_nlp_cosine_sim,
        code_sims: $code_sims,
        nlp_sims: $nlp_sims,
        ranking_preserved: "\($ranking_preserved)/\($ranking_total)",
        recommendation: $recommendation,
        reason: $reason
      }
    }' > "$AB_RESULT_FILE"

  log ok "A/B test results written to .anatoly/embedding-ab-results.json"

  # Clean up temp files
  rm -rf "$AB_TMP"

  # Display summary
  log_separator
  if [[ "$RECOMMENDATION" == "advanced-gguf" ]]; then
    log ok "Recommendation: advanced-gguf"
  else
    log warn "Recommendation: ${RECOMMENDATION}"
  fi
  log info "Reason: ${REASON}"
  log info "Avg code similarity: ${AVG_CODE_SIM}"
  log info "Avg NLP similarity: ${AVG_NLP_SIM}"
  log info "GGUF latency: code ${AVG_GGUF_CODE_LAT}ms, NLP ${AVG_GGUF_NLP_LAT}ms"
  log info "TEI latency:  code ${AVG_TEI_CODE_LAT}ms, NLP ${AVG_TEI_NLP_LAT}ms"
  log info "GGUF load:    code $(( GGUF_CODE_LOAD_MS / 1000 ))s, NLP $(( GGUF_NLP_LOAD_MS / 1000 ))s"
  log info "TEI load:     code $(( TEI_CODE_LOAD_MS / 1000 ))s, NLP $(( TEI_NLP_LOAD_MS / 1000 ))s"
  log info "Sanity GGUF:  sim=${GGUF_SANITY_SIM} dis=${GGUF_SANITY_DIS} sep=${GGUF_SANITY_SEP}"
  log info "Sanity TEI:   sim=${TEI_SANITY_SIM} dis=${TEI_SANITY_DIS} sep=${TEI_SANITY_SEP}"

  echo "$RECOMMENDATION"
}

# ═══════════════════════════════════════════════════════════════════════════
# --ab-test mode (standalone)
# ═══════════════════════════════════════════════════════════════════════════
if [[ "${1:-}" == "--ab-test" ]]; then
  ensure_jq
  ensure_curl

  # Verify prerequisites
  if [[ ! -f "${MODELS_DIR}/${GGUF_CODE_MODEL_FILE}" ]]; then
    log error "GGUF code model not found — run setup first"
    exit 1
  fi
  if [[ ! -f "${MODELS_DIR}/${GGUF_NLP_MODEL_FILE}" ]]; then
    log error "GGUF NLP model not found — run setup first"
    exit 1
  fi
  if ! has_docker; then
    log error "Docker not available"
    exit 1
  fi

  # Detect hardware (not done in main setup flow for --ab-test)
  GPU=$(detect_gpu)
  VRAM_GB=$(detect_vram_gb)

  # Check VRAM — A/B test loads TEI fp16 models sequentially; shared RAM helps
  if [[ "$VRAM_GB" -lt 23 ]]; then
    log error "A/B test requires >= 23 GB VRAM (detected: ${VRAM_GB} GB)"
    log info "The TEI fp16 reference models need significant VRAM (shared RAM helps)."
    exit 1
  fi

  # Purge stale A/B results before re-running
  rm -f "${AB_RESULT_FILE}"
  log info "Purged stale A/B test results"

  RESULT=$(run_ab_test)
  log info "Backend recommendation: ${RESULT}"

  # Rewrite embeddings-ready.json with correct config for the chosen backend
  if [[ "$RESULT" == "advanced-gguf" ]]; then
    write_embeddings_ready "$READY_FILE" \
      --arg backend "$RESULT" \
      --arg code_model "$CODE_MODEL_ID" \
      --arg nlp_model "$NLP_MODEL_ID" \
      --argjson dim_code "${CODE_DIM:-3584}" \
      --argjson dim_nlp "${NLP_DIM:-4096}" \
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
  else
    write_embeddings_ready "$READY_FILE" \
      --arg backend "lite" \
      --arg device "$GPU" \
      --argjson vram_gb "$VRAM_GB" \
      --arg setup_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{backend: $backend, device: $device, vram_gb: $vram_gb, dim_code: 768, dim_nlp: 384, setup_at: $setup_at}'
  fi

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

log info "Pulling GGUF image: ${GGUF_DOCKER_IMAGE}..."
if docker pull "$GGUF_DOCKER_IMAGE"; then
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

log info "Pulling TEI image: ${TEI_DOCKER_IMAGE}..."
if docker pull "$TEI_DOCKER_IMAGE"; then
  log ok "TEI Docker image ready"
  TEI_AVAILABLE=true
else
  log warn "Failed to pull TEI image — skipping A/B test"
  TEI_AVAILABLE=false
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
    docker_rm "$CODE_CONTAINER"
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

# Step 7: A/B test (if TEI is available AND enough VRAM)
# A/B test loads TEI fp16 models sequentially; shared RAM helps fit larger models
AB_TEST_MIN_VRAM_GB=23
BACKEND="advanced-gguf"
NLP_DIM=4096
CODE_DIM="${CODE_DIM:-3584}"

if [[ "$TEI_AVAILABLE" == "true" ]]; then
  if [[ "$VRAM_GB" -ge "$AB_TEST_MIN_VRAM_GB" ]]; then
    AB_RESULT=$(run_ab_test) || true
    if [[ -n "$AB_RESULT" ]]; then
      BACKEND="$AB_RESULT"
      log info "A/B test selected backend: ${BACKEND}"
    fi
  else
    log warn "Skipping A/B test — requires >= ${AB_TEST_MIN_VRAM_GB} GB VRAM (detected: ${VRAM_GB} GB)"
    log info "Using GGUF backend directly (validated by smoke test)"
  fi
fi

# Step 8: Write final config
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

# Step 9: Summary
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
