#!/usr/bin/env bash
# docker-helpers.sh — Docker container lifecycle helpers for embedding backends.
#
# Requires: logging.sh sourced first.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
GGUF_DOCKER_IMAGE="ghcr.io/ggml-org/llama.cpp:server-cuda"

GGUF_CODE_PORT=11437
GGUF_NLP_PORT=11438

CONTAINER_PREFIX="anatoly"

# ---------------------------------------------------------------------------
# Container management
# ---------------------------------------------------------------------------

# Remove a container by name (running or stopped). No-op if absent.
docker_rm() {
  local name="$1"
  docker rm -f "$name" >/dev/null 2>&1 || true
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
    --pooling last \
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
  local start remaining
  start=$(date +%s)
  log info "Waiting for GGUF containers to load models..."

  if ! wait_for_health "http://127.0.0.1:${GGUF_CODE_PORT}/health" "$timeout"; then
    log error "GGUF code container failed to start within ${timeout}s"
    return 1
  fi
  log ok "GGUF code container ready"

  remaining=$(( timeout - ($(date +%s) - start) ))
  if [[ "$remaining" -le 0 ]]; then
    log error "GGUF NLP container failed to start within ${timeout}s (no time remaining)"
    return 1
  fi

  if ! wait_for_health "http://127.0.0.1:${GGUF_NLP_PORT}/health" "$remaining"; then
    log error "GGUF NLP container failed to start within ${timeout}s"
    return 1
  fi
  log ok "GGUF NLP container ready"
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
