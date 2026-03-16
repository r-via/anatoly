#!/usr/bin/env bash
#
# setup-embeddings.sh — Install sentence-transformers + nomic-embed-code for Anatoly.
#
# Usage:
#   ./scripts/setup-embeddings.sh           # Install deps + download model
#   ./scripts/setup-embeddings.sh --check   # Check status only (no install)
#
# Venv strategy:
#   - If VIRTUAL_ENV is set (venv already active), uses it as-is
#   - Otherwise, creates/reuses .venv/ in the project root
#   - The embed-server.py sidecar always runs from this venv
#
set -euo pipefail

MODEL="nomic-ai/nomic-embed-code-v1.5"
SIDECAR_PORT="${ANATOLY_EMBED_PORT:-11435}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SIDECAR_SCRIPT="${SCRIPT_DIR}/embed-server.py"
VENV_DIR="${PROJECT_ROOT}/.venv"

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

# Ensure a venv exists and return its python
ensure_venv() {
  # If user already has an active venv, use it
  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    ok "Using active venv: ${VIRTUAL_ENV}"
    echo "${VIRTUAL_ENV}/bin/python"
    return 0
  fi

  # Create or reuse .venv/
  if [[ -f "${VENV_DIR}/bin/python" ]]; then
    ok "Using existing venv: ${VENV_DIR}"
  else
    local sys_python
    if ! sys_python=$(find_system_python); then
      return 1
    fi
    info "Creating venv at ${VENV_DIR}..."
    "$sys_python" -m venv "${VENV_DIR}"
    ok "Venv created"
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
  if [[ "$GPU" == "none" ]]; then
    warn "GPU: not detected — embeddings will run on CPU (slower)"
  else
    ok   "GPU: $GPU"
  fi

  if PYTHON=$(get_python); then
    PYVER=$("$PYTHON" --version 2>&1)
    VENV_LABEL=""
    if [[ -n "${VIRTUAL_ENV:-}" ]]; then
      VENV_LABEL=" (active venv)"
    elif [[ "$PYTHON" == "${VENV_DIR}/bin/python" ]]; then
      VENV_LABEL=" (.venv)"
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

    # Check if model is cached
    if check_package "$PYTHON" "sentence_transformers"; then
      MODEL_CACHED=$("$PYTHON" -c "
from sentence_transformers import SentenceTransformer
try:
    SentenceTransformer('${MODEL}', trust_remote_code=True)
    print('yes')
except:
    print('no')
" 2>/dev/null || echo "no")

      if [[ "$MODEL_CACHED" == "yes" ]]; then
        ok   "Model: ${MODEL} cached"
      else
        warn "Model: ${MODEL} not downloaded yet"
      fi
    fi
  else
    warn "Python: 3.9+ not found"
  fi

  if sidecar_running; then
    HEALTH=$(curl -sf "http://127.0.0.1:${SIDECAR_PORT}/health" 2>/dev/null)
    DEVICE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('device','?'))" 2>/dev/null || echo "?")
    ok   "Sidecar: running on port ${SIDECAR_PORT} (device: ${DEVICE})"
  else
    info "Sidecar: not running (auto-started by anatoly run)"
  fi

  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# Main install flow
# ---------------------------------------------------------------------------
echo ""
info "═══════════════════════════════════════════════"
info "  Anatoly — Embedding Setup"
info "  (sentence-transformers + ${MODEL})"
info "═══════════════════════════════════════════════"
echo ""

# Step 1: GPU check
GPU=$(detect_gpu)
if [[ "$GPU" == "none" ]]; then
  warn "No GPU detected — embeddings will run on CPU (slower but functional)"
else
  ok "GPU detected: ${GPU}"
fi

# Step 2: Python + venv
if ! PYTHON=$(ensure_venv); then
  err "Python 3.9+ required but not found."
  err "Install Python: https://www.python.org/downloads/"
  exit 1
fi
ok "Python: $("$PYTHON" --version 2>&1)"

# Step 3: Install torch (GPU-aware)
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

# Step 4: Install sentence-transformers
if check_package "$PYTHON" "sentence_transformers"; then
  STVER=$("$PYTHON" -c "import sentence_transformers; print(sentence_transformers.__version__)" 2>/dev/null)
  ok "sentence-transformers already installed: ${STVER}"
else
  info "Installing sentence-transformers..."
  "$PYTHON" -m pip install -q sentence-transformers
  ok "sentence-transformers installed"
fi

# Step 5: Download the model
info "Downloading ${MODEL} (first time only, ~1.5 GB)..."
"$PYTHON" -c "
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('${MODEL}', trust_remote_code=True)
print(f'Model loaded: {model.get_sentence_embedding_dimension()}d')
"
ok "Model ${MODEL} ready"

# Step 6: Sanity check via sidecar
info "Running embedding sanity check..."
"$PYTHON" "${SIDECAR_SCRIPT}" --port "${SIDECAR_PORT}" &
SIDECAR_PID=$!

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

echo ""
ok "═══════════════════════════════════════════════"
ok "  Setup complete! Anatoly will use ${MODEL}"
ok "  for GPU-accelerated code embeddings."
ok "═══════════════════════════════════════════════"
echo ""
info "The embed sidecar starts automatically with 'anatoly run'."
info "To start it manually:  $PYTHON scripts/embed-server.py"
info "To check status:       ./scripts/setup-embeddings.sh --check"
echo ""
