#!/usr/bin/env bash
#
# setup-ollama.sh — Install Ollama and pull nomic-embed-code for Anatoly.
#
# Usage:
#   ./scripts/setup-ollama.sh           # Install Ollama + pull model
#   ./scripts/setup-ollama.sh --check   # Check status only (no install)
#
# What it does:
#   1. Checks for CUDA/Metal/ROCm GPU availability
#   2. Installs Ollama if not present (Linux/macOS)
#   3. Ensures the Ollama server is running
#   4. Pulls the nomic-embed-code model (~4.7 GB)
#
set -euo pipefail

MODEL="manutic/nomic-embed-code"
OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

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
# Ollama detection
# ---------------------------------------------------------------------------
ollama_installed() {
  command -v ollama &>/dev/null
}

ollama_running() {
  curl -sf --max-time 3 "${OLLAMA_HOST}/api/tags" &>/dev/null
}

model_available() {
  curl -sf --max-time 3 "${OLLAMA_HOST}/api/tags" 2>/dev/null | grep -q "$(echo "$MODEL" | sed 's/\//\\\//g')"
}

# ---------------------------------------------------------------------------
# --check mode: report status and exit
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--check" ]]; then
  echo ""
  info "Anatoly Ollama Status"
  echo "  ─────────────────────────────────"

  GPU=$(detect_gpu)
  if [[ "$GPU" == "none" ]]; then
    warn "GPU: not detected — nomic-embed-code requires a GPU"
  else
    ok   "GPU: $GPU"
  fi

  if ollama_installed; then
    ok   "Ollama: installed ($(ollama --version 2>/dev/null || echo 'unknown version'))"

    if ollama_running; then
      ok   "Ollama server: running at ${OLLAMA_HOST}"
      if model_available; then
        ok   "Model: ${MODEL} ready"
      else
        warn "Model: ${MODEL} not pulled"
      fi
    else
      warn "Ollama server: not running"
      warn "Model: cannot check (server not running)"
    fi
  else
    warn "Ollama: not installed"
    warn "Run ./scripts/setup-ollama.sh to install"
  fi

  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# Main install flow
# ---------------------------------------------------------------------------
echo ""
info "═══════════════════════════════════════════════"
info "  Anatoly — Ollama + nomic-embed-code Setup"
info "═══════════════════════════════════════════════"
echo ""

# Step 1: GPU check
GPU=$(detect_gpu)
if [[ "$GPU" == "none" ]]; then
  err  "No GPU detected (checked CUDA, Metal, ROCm)."
  err  "nomic-embed-code (7B) requires GPU acceleration."
  warn "Anatoly will use the default Jina/ONNX embedding (no GPU needed)."
  echo ""
  exit 1
fi
ok "GPU detected: ${GPU}"

# Step 2: Install Ollama
if ollama_installed; then
  ok "Ollama already installed: $(ollama --version 2>/dev/null || echo 'unknown')"
else
  info "Installing Ollama..."
  case "$(uname)" in
    Linux)
      curl -fsSL https://ollama.com/install.sh | sh
      ;;
    Darwin)
      if command -v brew &>/dev/null; then
        brew install ollama
      else
        err  "Homebrew not found. Install Ollama manually: https://ollama.com/download"
        exit 1
      fi
      ;;
    *)
      err "Unsupported OS: $(uname). Install Ollama manually: https://ollama.com/download"
      exit 1
      ;;
  esac

  if ollama_installed; then
    ok "Ollama installed successfully"
  else
    err "Ollama installation failed"
    exit 1
  fi
fi

# Step 3: Ensure Ollama server is running
if ollama_running; then
  ok "Ollama server already running"
else
  info "Starting Ollama server..."
  ollama serve &>/dev/null &
  OLLAMA_PID=$!

  # Wait up to 15 seconds for server to be ready
  for i in $(seq 1 15); do
    if ollama_running; then
      break
    fi
    sleep 1
  done

  if ollama_running; then
    ok "Ollama server started (PID: ${OLLAMA_PID})"
  else
    err "Ollama server failed to start within 15s"
    err "Try running 'ollama serve' manually and re-run this script"
    exit 1
  fi
fi

# Step 4: Pull the model
if model_available; then
  ok "Model ${MODEL} already available"
else
  info "Pulling ${MODEL} (~4.7 GB, this may take a few minutes)..."
  echo ""
  ollama pull "${MODEL}"
  echo ""

  if model_available; then
    ok "Model ${MODEL} pulled successfully"
  else
    err "Failed to pull ${MODEL}"
    exit 1
  fi
fi

# Step 5: Quick sanity check — generate one embedding
info "Running embedding sanity check..."
RESPONSE=$(curl -sf "${OLLAMA_HOST}/api/embed" \
  -d "{\"model\": \"${MODEL}\", \"input\": \"function hello() { return 'world'; }\"}" \
  2>/dev/null)

if echo "$RESPONSE" | grep -q '"embeddings"'; then
  ok "Embedding sanity check passed"
else
  err "Embedding sanity check failed — model loaded but /api/embed returned unexpected response"
  exit 1
fi

echo ""
ok "═══════════════════════════════════════════════"
ok "  Setup complete! Anatoly will use nomic-embed-code"
ok "  for code embeddings via Ollama."
ok "═══════════════════════════════════════════════"
echo ""
info "Make sure Ollama is running before launching Anatoly:"
info "  ollama serve  (if not already running)"
info "  npx anatoly run"
echo ""
