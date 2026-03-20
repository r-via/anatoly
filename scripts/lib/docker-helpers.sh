#!/usr/bin/env bash
# docker-helpers.sh — Docker container lifecycle helpers for embedding backends.
#
# Requires: logging.sh sourced first.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
GGUF_DOCKER_IMAGE="ghcr.io/ggml-org/llama.cpp:server-cuda"
TEI_DOCKER_IMAGE="ghcr.io/huggingface/text-embeddings-inference:cuda-cu124-1.7"

GGUF_CODE_PORT=11437
GGUF_NLP_PORT=11438
TEI_CODE_PORT=11435
TEI_NLP_PORT=11436

CONTAINER_PREFIX="anatoly"

# ---------------------------------------------------------------------------
# Container management
# ---------------------------------------------------------------------------

# Remove a container by name (running or stopped). No-op if absent.
docker_rm() {
  local name="$1"
  docker rm -f "$name" >/dev/null 2>&1 || true
}

# Stop and remove all Anatoly containers
docker_cleanup_all() {
  log info "Stopping all Anatoly containers..."
  local cids
  cids=$(docker ps -aq --filter "name=${CONTAINER_PREFIX}-" 2>/dev/null || true)
  if [[ -n "$cids" ]]; then
    # shellcheck disable=SC2086
    docker rm -f $cids >/dev/null 2>&1 || true
  fi
  log ok "All Anatoly containers stopped"
}

# ---------------------------------------------------------------------------
# GGUF containers (llama.cpp)
# ---------------------------------------------------------------------------

start_gguf_container() {
  local name="$1"
  local models_dir="$2"
  local model_file="$3"
  local host_port="$4"

  docker_rm "$name"

  docker run -d --gpus all \
    --name "$name" \
    -v "${models_dir}:/models:ro" \
    -p "${host_port}:8080" \
    "$GGUF_DOCKER_IMAGE" \
    --model "/models/${model_file}" \
    --embedding \
    --port 8080 \
    --host 0.0.0.0 \
    -ngl 999 >/dev/null

  log debug "Started GGUF container ${name} on port ${host_port}"
}

start_gguf_containers() {
  local models_dir="$1"
  local code_model="$2"
  local nlp_model="$3"
  local code_name="${CONTAINER_PREFIX}-gguf-code"
  local nlp_name="${CONTAINER_PREFIX}-gguf-nlp"

  log info "Starting GGUF containers (code: ${GGUF_CODE_PORT}, NLP: ${GGUF_NLP_PORT})..."
  start_gguf_container "$code_name" "$models_dir" "$code_model" "$GGUF_CODE_PORT"
  start_gguf_container "$nlp_name" "$models_dir" "$nlp_model" "$GGUF_NLP_PORT"
}

stop_gguf_containers() {
  docker_rm "${CONTAINER_PREFIX}-gguf-code"
  docker_rm "${CONTAINER_PREFIX}-gguf-nlp"
  log debug "GGUF containers stopped"
}

# ---------------------------------------------------------------------------
# TEI containers (Hugging Face Text Embeddings Inference)
# ---------------------------------------------------------------------------

start_tei_container() {
  local name="$1"
  local model_id="$2"
  local host_port="$3"
  local cache_dir="${4:-$HOME/.cache/huggingface}"

  docker_rm "$name"

  docker run -d --gpus all \
    --name "$name" \
    -p "${host_port}:80" \
    -v "${cache_dir}:/data" \
    "$TEI_DOCKER_IMAGE" \
    --model-id "$model_id" \
    --dtype float16 \
    --port 80 >/dev/null

  log debug "Started TEI container ${name} on port ${host_port}"
}

stop_tei_containers() {
  docker_rm "${CONTAINER_PREFIX}-tei-code"
  docker_rm "${CONTAINER_PREFIX}-tei-nlp"
  log debug "TEI containers stopped"
}

# ---------------------------------------------------------------------------
# Wait for health endpoint
# ---------------------------------------------------------------------------

# Wait for an HTTP endpoint to return 200.
# Usage: wait_for_health "http://127.0.0.1:11437/health" 180
wait_for_health() {
  local url="$1"
  local timeout="${2:-120}"
  local start elapsed

  start=$(date +%s)
  while true; do
    if curl -sf --max-time 2 "$url" &>/dev/null; then
      return 0
    fi
    elapsed=$(( $(date +%s) - start ))
    if [[ "$elapsed" -ge "$timeout" ]]; then
      return 1
    fi
    sleep 2
  done
}

# Wait for GGUF containers (both code + NLP)
wait_for_gguf() {
  local timeout="${1:-180}"
  log info "Waiting for GGUF containers to load models..."

  if ! wait_for_health "http://127.0.0.1:${GGUF_CODE_PORT}/health" "$timeout"; then
    log error "GGUF code container failed to start within ${timeout}s"
    return 1
  fi
  log ok "GGUF code container ready"

  if ! wait_for_health "http://127.0.0.1:${GGUF_NLP_PORT}/health" "$timeout"; then
    log error "GGUF NLP container failed to start within ${timeout}s"
    return 1
  fi
  log ok "GGUF NLP container ready"
}

# Wait for TEI container
wait_for_tei() {
  local port="$1"
  local label="$2"
  local timeout="${3:-180}"

  log info "Waiting for TEI ${label} container to load model..."
  if ! wait_for_health "http://127.0.0.1:${port}/health" "$timeout"; then
    log error "TEI ${label} container failed to start within ${timeout}s"
    return 1
  fi
  log ok "TEI ${label} container ready"
}

# ---------------------------------------------------------------------------
# Embedding requests
# ---------------------------------------------------------------------------

# Embed text via GGUF (llama.cpp).
# Usage: embed_gguf "text" 11437 → prints JSON array
embed_gguf() {
  local text="$1"
  local port="$2"
  local json_text

  json_text=$(jq -Rs '.' <<< "$text")
  curl -sf --max-time 120 "http://127.0.0.1:${port}/embedding" \
    -H "Content-Type: application/json" \
    -d "{\"input\": ${json_text}}"
}

# Embed text via TEI.
# Usage: embed_tei "text" 11435 → prints JSON array of arrays
embed_tei() {
  local text="$1"
  local port="$2"
  local json_text

  json_text=$(jq -Rs '.' <<< "$text")
  curl -sf --max-time 120 "http://127.0.0.1:${port}/embed" \
    -H "Content-Type: application/json" \
    -d "{\"inputs\": ${json_text}}"
}

# ---------------------------------------------------------------------------
# GPU memory flush
# ---------------------------------------------------------------------------

flush_gpu_memory() {
  # Wait for GPU processes to release memory after container stop.
  # NOTE: We intentionally avoid nvidia-smi --gpu-reset and cache flushing
  # as these are system-wide operations that can disrupt other workloads.
  sleep 5
  log debug "GPU memory flush wait complete"
}
