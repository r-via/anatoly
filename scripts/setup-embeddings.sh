#!/usr/bin/env bash
#
# setup-embeddings.sh — Install embedding backends for Anatoly.
#
# Backends (tiered):
#   lite          — ONNX in-process (Jina 768d, CPU, always available)
#   advanced-fp16 — Python sidecar (sentence-transformers bf16 on GPU)
#   advanced-gguf — Docker llama.cpp server-cuda (GGUF Q5_K_M on GPU)
#
# Usage:
#   ./scripts/setup-embeddings.sh           # Install deps + download models + detect tier
#   ./scripts/setup-embeddings.sh --check   # Check status only (no install)
#   ./scripts/setup-embeddings.sh --ab-test # Run A/B test (bf16 vs GGUF)
#
# Venv strategy:
#   - If VIRTUAL_ENV is set (venv already active), uses it as-is
#   - Otherwise, creates/reuses .anatoly/.venv/ (isolated from project venv)
#   - The embed-server.py sidecar always runs from this venv
#
set -euo pipefail

# Suppress HuggingFace warnings
export HF_HUB_DISABLE_TELEMETRY=1
export TRANSFORMERS_NO_ADVISORY_WARNINGS=1
export HF_HUB_DISABLE_IMPLICIT_TOKEN=1
export HF_HUB_VERBOSITY=error

MODEL="nomic-ai/nomic-embed-code"
NLP_MODEL="Qwen/Qwen3-Embedding-8B"
SIDECAR_PORT="${ANATOLY_EMBED_PORT:-11435}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SIDECAR_SCRIPT="${SCRIPT_DIR}/embed-server.py"
VENV_DIR="${PROJECT_ROOT}/.anatoly/.venv"
MODELS_DIR="${PROJECT_ROOT}/.anatoly/models"

# GGUF Docker backend constants
GGUF_DOCKER_IMAGE="ghcr.io/ggml-org/llama.cpp:server-cuda"
GGUF_CODE_MODEL_FILE="nomic-embed-code.Q5_K_M.gguf"
GGUF_NLP_MODEL_FILE="Qwen3-Embedding-8B-Q5_K_M.gguf"
GGUF_CODE_HF_REPO="nomic-ai/nomic-embed-code-GGUF"
GGUF_NLP_HF_REPO="Qwen/Qwen3-Embedding-8B-GGUF"
GGUF_MIN_VRAM_GB=12

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()   { echo -e "${RED}[error]${NC} $*"; }

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

# Detect total VRAM in GB (NVIDIA only, returns 0 for non-NVIDIA)
detect_vram_gb() {
  if ! command -v nvidia-smi &>/dev/null; then
    echo "0"
    return
  fi
  local mib
  mib=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  if [[ -z "$mib" ]] || [[ "$mib" == "0" ]]; then
    echo "0"
    return
  fi
  echo $(( mib / 1024 ))
}

# ---------------------------------------------------------------------------
# Docker / NVIDIA Container Toolkit detection
# ---------------------------------------------------------------------------
has_docker() {
  command -v docker &>/dev/null && docker info &>/dev/null 2>&1
}

has_nvidia_container_toolkit() {
  # Check nvidia-container-cli first (fast)
  if command -v nvidia-container-cli &>/dev/null; then
    return 0
  fi
  # Fallback: check if nvidia runtime is registered in Docker
  if docker info 2>/dev/null | grep -q "nvidia"; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# GGUF model download helpers
# ---------------------------------------------------------------------------
download_gguf_model() {
  local filename="$1"
  local hf_repo="$2"
  local target="${MODELS_DIR}/${filename}"

  if [[ -f "$target" ]]; then
    local size_mb
    size_mb=$(du -m "$target" | cut -f1)
    ok "GGUF model present: ${filename} (${size_mb} MB)"
    return 0
  fi

  mkdir -p "${MODELS_DIR}"
  info "Downloading GGUF model: ${filename} from ${hf_repo}..."

  # Use huggingface-cli if available (supports resume), else curl
  if command -v huggingface-cli &>/dev/null; then
    huggingface-cli download "${hf_repo}" "${filename}" --local-dir "${MODELS_DIR}" --local-dir-use-symlinks False
  elif command -v curl &>/dev/null; then
    curl -L -o "$target" \
      "https://huggingface.co/${hf_repo}/resolve/main/${filename}" \
      --progress-bar
  else
    err "Neither huggingface-cli nor curl found — cannot download GGUF model"
    return 1
  fi

  if [[ -f "$target" ]]; then
    local size_mb
    size_mb=$(du -m "$target" | cut -f1)
    ok "GGUF model downloaded: ${filename} (${size_mb} MB)"
  else
    err "GGUF download failed: ${filename}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Tier selection logic
# ---------------------------------------------------------------------------
# Returns: "lite", "advanced-fp16", or "advanced-gguf"
select_tier() {
  local gpu="$1"
  local vram_gb="$2"
  local docker_ok="$3"
  local toolkit_ok="$4"

  # No GPU → lite
  if [[ "$gpu" == "none" ]]; then
    echo "lite"
    return
  fi

  # GPU + Docker + NVIDIA toolkit + enough VRAM → GGUF candidate
  if [[ "$docker_ok" == "true" ]] && [[ "$toolkit_ok" == "true" ]] && [[ "$vram_gb" -ge "$GGUF_MIN_VRAM_GB" ]]; then
    echo "advanced-gguf"
    return
  fi

  # GPU but no Docker or insufficient VRAM → fp16 sidecar
  echo "advanced-fp16"
}

# ---------------------------------------------------------------------------
# Python / venv helpers
# ---------------------------------------------------------------------------
find_system_python() {
  for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
      local ver
      ver=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)
      local major minor
      major=$(echo "$ver" | cut -d. -f1)
      minor=$(echo "$ver" | cut -d. -f2)
      if [[ "$major" -ge 3 ]] && [[ "$minor" -ge 9 ]]; then
        echo "$cmd"
        return 0
      fi
    fi
  done
  return 1
}

# Returns the python binary to use (from active venv or .venv/)
get_python() {
  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    echo "${VIRTUAL_ENV}/bin/python"
  elif [[ -f "${VENV_DIR}/bin/python" ]]; then
    echo "${VENV_DIR}/bin/python"
  else
    find_system_python
  fi
}

# Ensure a venv exists and return its python path on stdout.
# All user-facing messages go to stderr so $(ensure_venv) captures only the path.
ensure_venv() {
  # If user already has an active venv, use it
  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    ok "Using active venv: ${VIRTUAL_ENV}" >&2
    echo "${VIRTUAL_ENV}/bin/python"
    return 0
  fi

  # Create or reuse .venv/
  if [[ -f "${VENV_DIR}/bin/python" ]]; then
    ok "Using existing venv: ${VENV_DIR}" >&2
  else
    local sys_python
    if ! sys_python=$(find_system_python); then
      return 1
    fi
    info "Creating venv at ${VENV_DIR}..." >&2
    "$sys_python" -m venv "${VENV_DIR}"
    ok "Venv created" >&2
  fi
  echo "${VENV_DIR}/bin/python"
}

check_package() {
  local python="$1"
  local pkg="$2"
  "$python" -c "import $pkg" &>/dev/null
}

# ---------------------------------------------------------------------------
# Sidecar detection
# ---------------------------------------------------------------------------
sidecar_running() {
  curl -sf --max-time 2 "http://127.0.0.1:${SIDECAR_PORT}/health" &>/dev/null
}

# ---------------------------------------------------------------------------
# --check mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--check" ]]; then
  echo ""
  info "Anatoly Embedding Status"
  echo "  ─────────────────────────────────"

  GPU=$(detect_gpu)
  VRAM_GB=$(detect_vram_gb)
  if [[ "$GPU" == "none" ]]; then
    warn "GPU: not detected — embeddings will run on CPU (slower)"
  else
    ok   "GPU: $GPU (${VRAM_GB} GB VRAM)"
  fi

  # Docker / NVIDIA Container Toolkit status
  if has_docker; then
    ok   "Docker: available"
    if has_nvidia_container_toolkit; then
      ok   "NVIDIA Container Toolkit: available"
    else
      warn "NVIDIA Container Toolkit: not found (needed for GGUF backend)"
    fi
  else
    info "Docker: not available (needed for GGUF backend)"
  fi

  # GGUF models
  if [[ -f "${MODELS_DIR}/${GGUF_CODE_MODEL_FILE}" ]]; then
    ok   "GGUF code model: ${GGUF_CODE_MODEL_FILE} ($(du -m "${MODELS_DIR}/${GGUF_CODE_MODEL_FILE}" | cut -f1) MB)"
  else
    info "GGUF code model: not downloaded"
  fi
  if [[ -f "${MODELS_DIR}/${GGUF_NLP_MODEL_FILE}" ]]; then
    ok   "GGUF NLP model: ${GGUF_NLP_MODEL_FILE} ($(du -m "${MODELS_DIR}/${GGUF_NLP_MODEL_FILE}" | cut -f1) MB)"
  else
    info "GGUF NLP model: not downloaded"
  fi

  # Tier recommendation
  DOCKER_OK="false"
  TOOLKIT_OK="false"
  if has_docker; then DOCKER_OK="true"; fi
  if has_docker && has_nvidia_container_toolkit; then TOOLKIT_OK="true"; fi
  TIER=$(select_tier "$GPU" "$VRAM_GB" "$DOCKER_OK" "$TOOLKIT_OK")
  info "Recommended tier: ${TIER}"

  # Existing flag
  FLAG_FILE="${PROJECT_ROOT}/.anatoly/embeddings-ready.json"
  if [[ -f "$FLAG_FILE" ]]; then
    CURRENT_BACKEND=$(python3 -c "import json; print(json.load(open('$FLAG_FILE')).get('backend','(not set)'))" 2>/dev/null || echo "(unreadable)")
    ok   "Current backend: ${CURRENT_BACKEND} (from embeddings-ready.json)"
  fi

  if PYTHON=$(get_python); then
    PYVER=$("$PYTHON" --version 2>&1)
    VENV_LABEL=""
    if [[ -n "${VIRTUAL_ENV:-}" ]]; then
      VENV_LABEL=" (active venv)"
    elif [[ "$PYTHON" == "${VENV_DIR}/bin/python" ]]; then
      VENV_LABEL=" (.anatoly/.venv)"
    fi
    ok   "Python: ${PYVER}${VENV_LABEL}"

    if check_package "$PYTHON" "sentence_transformers"; then
      STVER=$("$PYTHON" -c "import sentence_transformers; print(sentence_transformers.__version__)" 2>/dev/null)
      ok   "sentence-transformers: $STVER"
    else
      warn "sentence-transformers: not installed"
    fi

    if check_package "$PYTHON" "torch"; then
      TORCHVER=$("$PYTHON" -c "import torch; print(f'{torch.__version__} (CUDA: {torch.cuda.is_available()})')" 2>/dev/null)
      ok   "torch: $TORCHVER"
    else
      warn "torch: not installed"
    fi

    # Backend-specific checks
    if [[ "$TIER" == "advanced-gguf" ]]; then
      info "Backend: advanced-gguf (Docker llama.cpp)"
      if docker image inspect "$GGUF_DOCKER_IMAGE" &>/dev/null; then
        ok   "Docker image: ${GGUF_DOCKER_IMAGE}"
      else
        warn "Docker image not pulled: ${GGUF_DOCKER_IMAGE}"
        info "  Run: npx anatoly setup-embeddings"
      fi
    elif [[ "$TIER" == "advanced-fp16" ]]; then
      info "Backend: advanced-fp16 (Python sidecar)"
      if check_package "$PYTHON" "sentence_transformers"; then
        ok   "sentence-transformers: ready"
        CODE_CACHED=$("$PYTHON" -W ignore -c "
import os; os.environ['HF_HUB_VERBOSITY'] = 'error'
from huggingface_hub import try_to_load_from_cache
r = try_to_load_from_cache('${MODEL}', 'config.json')
print('yes' if r and r != '' else 'no')
" 2>/dev/null || echo "no")
        NLP_CACHED=$("$PYTHON" -W ignore -c "
import os; os.environ['HF_HUB_VERBOSITY'] = 'error'
from huggingface_hub import try_to_load_from_cache
r = try_to_load_from_cache('${NLP_MODEL}', 'config.json')
print('yes' if r and r != '' else 'no')
" 2>/dev/null || echo "no")
        [[ "$CODE_CACHED" == "yes" ]] && ok "Code model: ${MODEL} (cached)" || warn "Code model: not downloaded"
        [[ "$NLP_CACHED" == "yes" ]] && ok "NLP model: ${NLP_MODEL} (cached)" || warn "NLP model: not downloaded"
      fi
      if sidecar_running; then
        HEALTH=$(curl -sf "http://127.0.0.1:${SIDECAR_PORT}/health" 2>/dev/null)
        DEVICE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('device','?'))" 2>/dev/null || echo "?")
        ok   "Sidecar: running on port ${SIDECAR_PORT} (device: ${DEVICE})"
      else
        info "Sidecar: not running (auto-started by anatoly run)"
      fi
    else
      info "Backend: lite (ONNX CPU, no GPU acceleration)"
    fi
  else
    warn "Python: 3.9+ not found"
  fi

  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# --ab-test mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--ab-test" ]]; then
  AB_SCRIPT="${SCRIPT_DIR}/embedding-ab-test.sh"
  if [[ ! -f "$AB_SCRIPT" ]]; then
    err "embedding-ab-test.sh not found at ${AB_SCRIPT}"
    exit 1
  fi
  exec bash "$AB_SCRIPT"
fi

# ---------------------------------------------------------------------------
# Main install flow
# ---------------------------------------------------------------------------
echo ""
info "═══════════════════════════════════════════════"
info "  Anatoly — Embedding Setup"
info "═══════════════════════════════════════════════"
echo ""

# Step 1: Hardware detection
GPU=$(detect_gpu)
VRAM_GB=$(detect_vram_gb)
DOCKER_OK="false"
TOOLKIT_OK="false"

if [[ "$GPU" == "none" ]]; then
  warn "No GPU detected — embeddings will run on CPU (slower but functional)"
else
  ok "GPU detected: ${GPU} (${VRAM_GB} GB VRAM)"
fi

if has_docker; then
  DOCKER_OK="true"
  ok "Docker: available"
  if [[ "$GPU" == "cuda" ]] && has_nvidia_container_toolkit; then
    TOOLKIT_OK="true"
    ok "NVIDIA Container Toolkit: available"
  elif [[ "$GPU" == "cuda" ]]; then
    warn "NVIDIA Container Toolkit: not found"
    info "  Install: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
  fi
else
  if [[ "$GPU" == "cuda" ]] && [[ "$VRAM_GB" -ge "$GGUF_MIN_VRAM_GB" ]]; then
    warn "Docker not found. Required for advanced-gguf backend (best performance)."
    echo ""
    info "Docker enables GGUF quantized models (~10 GB VRAM for both models"
    info "loaded simultaneously, instead of ~28 GB with bf16 swap)."
    echo ""
    read -r -p "  Install Docker + NVIDIA Container Toolkit now? (requires sudo) [y/N] " INSTALL_DOCKER
    if [[ "${INSTALL_DOCKER,,}" == "y" ]]; then
      info "Installing Docker (official repository)..."
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
      # Add current user to docker group (avoids sudo for docker commands)
      sudo usermod -aG docker "$USER"
      ok "Docker installed"

      info "Installing NVIDIA Container Toolkit..."
      curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
      curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
        sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
        sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
      sudo apt-get update -qq
      sudo apt-get install -y -qq nvidia-container-toolkit
      sudo nvidia-ctk runtime configure --runtime=docker
      sudo systemctl restart docker
      ok "NVIDIA Container Toolkit installed"

      # Re-check
      if has_docker; then
        DOCKER_OK="true"
        ok "Docker: available"
        if has_nvidia_container_toolkit; then
          TOOLKIT_OK="true"
          ok "NVIDIA Container Toolkit: verified"
        fi
      else
        warn "Docker installed but not available yet."
        info "You may need to log out and log back in (for docker group), then re-run setup."
      fi
    else
      info "Skipping Docker install. Falling back to advanced-fp16 (Python sidecar)."
    fi
  else
    info "Docker: not available (optional — needed for GGUF backend)"
  fi
fi

# Step 2: Determine tier
TIER=$(select_tier "$GPU" "$VRAM_GB" "$DOCKER_OK" "$TOOLKIT_OK")
echo ""
info "Selected tier: ${TIER}"
echo ""

# Step 3: Setup GGUF backend (Docker llama.cpp) if tier is advanced-gguf
if [[ "$TIER" == "advanced-gguf" ]]; then
  echo ""
  info "Setting up GGUF backend (Docker llama.cpp)..."

  # Download GGUF models if not already present
  mkdir -p "$MODELS_DIR"
  for GGUF_FILE in "$GGUF_CODE_MODEL_FILE" "$GGUF_NLP_MODEL_FILE"; do
    if [[ "$GGUF_FILE" == "$GGUF_CODE_MODEL_FILE" ]]; then
      GGUF_REPO="$GGUF_CODE_HF_REPO"
      GGUF_LABEL="Code"
    else
      GGUF_REPO="$GGUF_NLP_HF_REPO"
      GGUF_LABEL="NLP"
    fi
    GGUF_PATH="${MODELS_DIR}/${GGUF_FILE}"
    if [[ -f "$GGUF_PATH" ]]; then
      GGUF_SIZE=$(du -m "$GGUF_PATH" | cut -f1)
      ok "${GGUF_LABEL} GGUF cached: ${GGUF_FILE} (${GGUF_SIZE} MB)"
    else
      info "Downloading ${GGUF_FILE} from ${GGUF_REPO}..."
      if ! PYTHON_TMP=$(get_python 2>/dev/null); then
        PYTHON_TMP="python3"
      fi
      "$PYTHON_TMP" -W ignore -c "
import os; os.environ['HF_HUB_VERBOSITY'] = 'error'
from huggingface_hub import hf_hub_download
hf_hub_download('${GGUF_REPO}', '${GGUF_FILE}', local_dir='${MODELS_DIR}')
" 2>&1 | grep -v "^Warning:"
      ok "Downloaded ${GGUF_FILE}"
    fi
  done

  # Pull Docker image
  info "Pulling Docker image ${GGUF_DOCKER_IMAGE}..."
  if docker pull "$GGUF_DOCKER_IMAGE" 2>&1; then
    ok "Docker image ready"
  else
    err "Failed to pull Docker image"
    warn "Falling back to advanced-fp16"
    TIER="advanced-fp16"
  fi

  if [[ "$TIER" == "advanced-gguf" ]]; then
    # Test GGUF containers
    info "Testing GGUF code container..."
    CONTAINER_NAME="anatoly-gguf-test-$$"
    docker run -d --rm --name "$CONTAINER_NAME" \
      --gpus all \
      -v "${MODELS_DIR}:/models:ro" \
      -p 11435:8080 \
      "$GGUF_DOCKER_IMAGE" \
      --model "/models/${GGUF_CODE_MODEL_FILE}" \
      --embedding --port 8080 --host 0.0.0.0 2>/dev/null

    READY=false
    for i in $(seq 1 60); do
      if curl -sf "http://127.0.0.1:11435/health" &>/dev/null; then
        READY=true
        break
      fi
      sleep 2
    done

    if [[ "$READY" == "true" ]]; then
      RESPONSE=$(curl -sf "http://127.0.0.1:11435/embedding" \
        -H "Content-Type: application/json" \
        -d '{"input": "function hello() { return world; }"}' 2>/dev/null)
      if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); assert len(d[0]['embedding']) > 0" 2>/dev/null; then
        CODE_DIM=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d[0]['embedding']))" 2>/dev/null)
        ok "GGUF code embedding OK (${CODE_DIM}d)"
      else
        err "GGUF code embedding failed"
        TIER="advanced-fp16"
      fi
    else
      err "GGUF code container failed to start within 120s"
      TIER="advanced-fp16"
    fi
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    sleep 2

    if [[ "$TIER" == "advanced-gguf" ]]; then
      NLP_DIM="4096"
      CODE_DIM="${CODE_DIM:-3584}"

      # Write config and finish
      FLAG_FILE="${PROJECT_ROOT}/.anatoly/embeddings-ready.json"
      mkdir -p "$(dirname "$FLAG_FILE")"
      cat > "$FLAG_FILE" <<ENDJSON
{
  "backend": "advanced-gguf",
  "code_model": "${MODEL}",
  "nlp_model": "${NLP_MODEL}",
  "dim_code": ${CODE_DIM},
  "dim_nlp": ${NLP_DIM},
  "device": "${GPU}",
  "docker_image": "${GGUF_DOCKER_IMAGE}",
  "code_gguf": "${MODELS_DIR}/${GGUF_CODE_MODEL_FILE}",
  "nlp_gguf": "${MODELS_DIR}/${GGUF_NLP_MODEL_FILE}",
  "setup_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON
      ok "Config written to .anatoly/embeddings-ready.json"
      echo ""
      echo "  ═══════════════════════════════════════════════"
      echo ""
      ok "Setup complete! Backend: advanced-gguf"
      echo ""
      echo "  Code:    ${MODEL} → GGUF Q5_K_M (${CODE_DIM}d)"
      echo "  NLP:     ${NLP_MODEL} → GGUF Q5_K_M (${NLP_DIM}d)"
      echo "  Docker:  ${GGUF_DOCKER_IMAGE}"
      echo "  Models:  .anatoly/models/"
      echo "  Config:  .anatoly/embeddings-ready.json"
      echo ""
      echo "  ═══════════════════════════════════════════════"
      echo ""
      info "Both models load simultaneously (~10 GB VRAM). No swap needed."
      info "The containers start automatically with 'npx anatoly run'."
      echo ""
      exit 0
    fi
  fi
fi

# Step 4: Setup fp16 backend (Python sidecar — for advanced-fp16 or lite)
PYTHON=""
CODE_DIM="768"
NLP_DIM="384"

if [[ "$TIER" == "advanced-fp16" ]]; then
  # Python + venv
  if ! PYTHON=$(ensure_venv); then
    if [[ "$TIER" == "advanced-gguf" ]]; then
      warn "Python 3.9+ not found — fp16 fallback will not be available"
    else
      err "Python 3.9+ required but not found."
      err "Install Python: https://www.python.org/downloads/"
      exit 1
    fi
  fi

  if [[ -n "$PYTHON" ]]; then
    ok "Python: $("$PYTHON" --version 2>&1)"

    # Install torch (GPU-aware)
    if check_package "$PYTHON" "torch"; then
      TORCHVER=$("$PYTHON" -c "import torch; print(torch.__version__)" 2>/dev/null)
      ok "torch already installed: ${TORCHVER}"
    else
      info "Installing torch..."
      case "$GPU" in
        cuda)
          "$PYTHON" -m pip install -q torch --index-url https://download.pytorch.org/whl/cu124
          ;;
        rocm)
          "$PYTHON" -m pip install -q torch --index-url https://download.pytorch.org/whl/rocm6.2
          ;;
        *)
          "$PYTHON" -m pip install -q torch
          ;;
      esac
      ok "torch installed"
    fi

    # Install sentence-transformers
    if check_package "$PYTHON" "sentence_transformers"; then
      STVER=$("$PYTHON" -c "import sentence_transformers; print(sentence_transformers.__version__)" 2>/dev/null)
      ok "sentence-transformers already installed: ${STVER}"
    else
      info "Installing sentence-transformers..."
      "$PYTHON" -m pip install -q sentence-transformers
      ok "sentence-transformers installed"
    fi

    # Download/verify the code model
    CODE_CACHED=$("$PYTHON" -W ignore -c "
import os; os.environ['HF_HUB_VERBOSITY'] = 'error'
from huggingface_hub import try_to_load_from_cache
result = try_to_load_from_cache('${MODEL}', 'config.json')
print('yes' if result is not None and result != '' else 'no')
" 2>/dev/null || echo "no")

    if [[ "$CODE_CACHED" == "yes" ]]; then
      info "Loading ${MODEL} (cached)..."
    else
      info "Downloading ${MODEL} (~27 GB, first time only)..."
    fi
    "$PYTHON" -W ignore -c "
import os, warnings; warnings.filterwarnings('ignore'); os.environ['HF_HUB_VERBOSITY'] = 'error'
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('${MODEL}', trust_remote_code=True)
print(f'  {model.get_sentence_embedding_dimension()}d')
" 2>&1 | grep -v "^Warning:"
    ok "Code model ready: ${MODEL}"

    # Download/verify the NLP model
    NLP_CACHED=$("$PYTHON" -W ignore -c "
import os; os.environ['HF_HUB_VERBOSITY'] = 'error'
from huggingface_hub import try_to_load_from_cache
result = try_to_load_from_cache('${NLP_MODEL}', 'config.json')
print('yes' if result is not None and result != '' else 'no')
" 2>/dev/null || echo "no")

    if [[ "$NLP_CACHED" == "yes" ]]; then
      info "Loading ${NLP_MODEL} (cached)..."
    else
      info "Downloading ${NLP_MODEL} (~16 GB, first time only)..."
    fi
    "$PYTHON" -W ignore -c "
import os, warnings; warnings.filterwarnings('ignore'); os.environ['HF_HUB_VERBOSITY'] = 'error'
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('${NLP_MODEL}', trust_remote_code=True)
print(f'  {model.get_sentence_embedding_dimension()}d')
" 2>&1 | grep -v "^Warning:"
    ok "NLP model ready: ${NLP_MODEL}"

    # Sanity check via sidecar
    info "Running embedding sanity check..."
    "$PYTHON" -W ignore "${SIDECAR_SCRIPT}" --port "${SIDECAR_PORT}" &
    SIDECAR_PID=$!
    trap 'kill "$SIDECAR_PID" 2>/dev/null || true; exit 1' INT TERM

    # Wait for sidecar to be ready (model loading)
    READY=false
    for i in $(seq 1 30); do
      if sidecar_running; then
        READY=true
        break
      fi
      sleep 2
    done

    if [[ "$READY" == "true" ]]; then
      RESPONSE=$(curl -sf "http://127.0.0.1:${SIDECAR_PORT}/embed" \
        -H "Content-Type: application/json" \
        -d '{"input": "function hello() { return world; }"}' 2>/dev/null)

      if echo "$RESPONSE" | grep -q '"embedding"'; then
        ok "Embedding sanity check passed"
      else
        err "Sanity check failed — sidecar returned unexpected response"
        kill "$SIDECAR_PID" 2>/dev/null || true
        exit 1
      fi

      # Shut down the test sidecar
      curl -sf -X POST "http://127.0.0.1:${SIDECAR_PORT}/shutdown" &>/dev/null || true
      wait "$SIDECAR_PID" 2>/dev/null || true
    else
      err "Sidecar failed to start within 60s"
      kill "$SIDECAR_PID" 2>/dev/null || true
      exit 1
    fi

    # Get dimensions
    CODE_DIM=$("$PYTHON" -c "from sentence_transformers import SentenceTransformer; print(SentenceTransformer('${MODEL}', trust_remote_code=True).get_sentence_embedding_dimension())" 2>/dev/null || echo "3584")
    NLP_DIM=$("$PYTHON" -c "from sentence_transformers import SentenceTransformer; print(SentenceTransformer('${NLP_MODEL}', trust_remote_code=True).get_sentence_embedding_dimension())" 2>/dev/null || echo "4096")
  fi
fi

# Step 4: Setup GGUF backend (Docker llama.cpp — for advanced-gguf tier)
if [[ "$TIER" == "advanced-gguf" ]]; then
  echo ""
  info "Setting up GGUF Docker backend..."

  # Download GGUF models if not present
  download_gguf_model "$GGUF_CODE_MODEL_FILE" "$GGUF_CODE_HF_REPO"
  download_gguf_model "$GGUF_NLP_MODEL_FILE" "$GGUF_NLP_HF_REPO"

  # Pull Docker image
  info "Pulling Docker image: ${GGUF_DOCKER_IMAGE}..."
  if docker pull "$GGUF_DOCKER_IMAGE"; then
    ok "Docker image ready: ${GGUF_DOCKER_IMAGE}"
  else
    warn "Docker pull failed — falling back to advanced-fp16"
    TIER="advanced-fp16"
  fi
fi

# Step 5: Write readiness flag
FLAG_FILE="${PROJECT_ROOT}/.anatoly/embeddings-ready.json"
mkdir -p "$(dirname "$FLAG_FILE")"

# Build the JSON manually to handle optional fields cleanly
FLAG_JSON="{"
FLAG_JSON+="\"code_model\": \"${MODEL}\","
FLAG_JSON+="\"nlp_model\": \"${NLP_MODEL}\","
FLAG_JSON+="\"dim_code\": ${CODE_DIM:-768},"
FLAG_JSON+="\"dim_nlp\": ${NLP_DIM:-384},"
FLAG_JSON+="\"device\": \"${GPU}\","
FLAG_JSON+="\"python\": \"${PYTHON:-}\","
FLAG_JSON+="\"backend\": \"${TIER}\","
FLAG_JSON+="\"vram_gb\": ${VRAM_GB},"
FLAG_JSON+="\"setup_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""

if [[ "$TIER" == "advanced-gguf" ]]; then
  FLAG_JSON+=",\"gguf_code_model\": \"${MODELS_DIR}/${GGUF_CODE_MODEL_FILE}\""
  FLAG_JSON+=",\"gguf_nlp_model\": \"${MODELS_DIR}/${GGUF_NLP_MODEL_FILE}\""
fi

FLAG_JSON+="}"

# Pretty-print via python if available, else write raw
if command -v python3 &>/dev/null; then
  echo "$FLAG_JSON" | python3 -m json.tool > "$FLAG_FILE"
else
  echo "$FLAG_JSON" > "$FLAG_FILE"
fi

ok "Readiness flag written"

echo ""
echo "  ═══════════════════════════════════════════════"
echo ""
ok "Setup complete!"
echo ""
echo "  Backend   ${TIER}"
echo "  Device    ${GPU} (${VRAM_GB} GB VRAM)"
if [[ "$TIER" == "advanced-fp16" ]] || [[ "$TIER" == "advanced-gguf" ]]; then
  echo "  Code model  ${MODEL} (${CODE_DIM:-3584}d)"
  echo "  NLP model   ${NLP_MODEL} (${NLP_DIM:-4096}d)"
fi
if [[ "$TIER" == "advanced-gguf" ]]; then
  echo "  GGUF code   ${GGUF_CODE_MODEL_FILE}"
  echo "  GGUF NLP    ${GGUF_NLP_MODEL_FILE}"
  echo "  Docker      ${GGUF_DOCKER_IMAGE}"
fi
echo "  Config      .anatoly/embeddings-ready.json"
echo ""
echo "  ═══════════════════════════════════════════════"
echo ""
if [[ "$TIER" == "advanced-gguf" ]]; then
  info "GGUF Docker containers start automatically with 'npx anatoly run'."
  info "fp16 sidecar available as fallback if Docker is unavailable."
elif [[ "$TIER" == "advanced-fp16" ]]; then
  info "The embed sidecar starts automatically with 'npx anatoly run'."
else
  info "Using ONNX CPU embeddings (no GPU setup needed)."
fi
info "To check status:  npx anatoly setup-embeddings --check"
echo ""
