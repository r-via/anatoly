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
# GGUF repos (official, from model authors)
CODE_GGUF_REPO="nomic-ai/nomic-embed-code-GGUF"
CODE_GGUF_FILE="nomic-embed-code.Q5_K_M.gguf"
NLP_GGUF_REPO="Qwen/Qwen3-Embedding-8B-GGUF"
NLP_GGUF_FILE="Qwen3-Embedding-8B-Q5_K_M.gguf"
MODELS_DIR=".anatoly/models"
SIDECAR_PORT="${ANATOLY_EMBED_PORT:-11435}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SIDECAR_SCRIPT="${SCRIPT_DIR}/embed-server.py"
VENV_DIR="${PROJECT_ROOT}/.anatoly/.venv"

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
  if [[ -n "${VIRTUAL_ENV:-}" ]] && [[ -x "${VIRTUAL_ENV}/bin/python" ]]; then
    echo "${VIRTUAL_ENV}/bin/python"
  elif [[ -x "${VENV_DIR}/bin/python" ]]; then
    echo "${VENV_DIR}/bin/python"
  else
    find_system_python
  fi
}

# Ensure a venv exists and return its python path on stdout.
# All user-facing messages go to stderr so $(ensure_venv) captures only the path.
ensure_venv() {
  # If user already has an active venv, use it
  if [[ -n "${VIRTUAL_ENV:-}" ]] && [[ -x "${VIRTUAL_ENV}/bin/python" ]]; then
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
# ---------------------------------------------------------------------------
# --check mode (includes A/B test for quantization recommendation)
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
    VRAM_TOTAL=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
    VRAM_FREE=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -1)
    info "VRAM: ${VRAM_FREE} MiB free / ${VRAM_TOTAL} MiB total"
  fi

  if ! PYTHON=$(get_python); then
    warn "Python: 3.9+ not found"
    echo ""
    exit 1
  fi

  PYVER=$("$PYTHON" --version 2>&1)
  VENV_LABEL=""
  if [[ -n "${VIRTUAL_ENV:-}" ]] && [[ -x "${VIRTUAL_ENV}/bin/python" ]]; then
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
    echo ""
    exit 1
  fi

  if check_package "$PYTHON" "torch"; then
    TORCHVER=$("$PYTHON" -c "import torch; print(f'{torch.__version__} (CUDA: {torch.cuda.is_available()})')" 2>/dev/null)
    ok   "torch: $TORCHVER"
  else
    warn "torch: not installed"
    echo ""
    exit 1
  fi

  # Kill any existing sidecar (from anatoly run or previous check) for clean VRAM measurements
  PORT_PID=$(fuser "${SIDECAR_PORT}/tcp" 2>/dev/null | tr -d ' ' || true)
  if [[ -n "$PORT_PID" ]] || sidecar_running; then
    info "Stopping existing sidecar (PID ${PORT_PID:-?}) for clean test..."
    # Try graceful shutdown first
    curl -sf -X POST "http://127.0.0.1:${SIDECAR_PORT}/shutdown" &>/dev/null || true
    for i in $(seq 1 10); do
      PORT_PID=$(fuser "${SIDECAR_PORT}/tcp" 2>/dev/null | tr -d ' ' || true)
      if [[ -z "$PORT_PID" ]]; then break; fi
      sleep 1
    done
    # Force kill if still alive
    PORT_PID=$(fuser "${SIDECAR_PORT}/tcp" 2>/dev/null | tr -d ' ' || true)
    if [[ -n "$PORT_PID" ]]; then
      warn "Sidecar did not stop gracefully — force killing PID ${PORT_PID}..."
      kill -9 "$PORT_PID" 2>/dev/null || true
      sleep 2
    fi
    # Final check
    PORT_PID=$(fuser "${SIDECAR_PORT}/tcp" 2>/dev/null | tr -d ' ' || true)
    if [[ -n "$PORT_PID" ]]; then
      err "Cannot free port ${SIDECAR_PORT} — PID ${PORT_PID} still holding it"
      exit 1
    fi
    ok "Existing sidecar stopped"
    # Wait for GPU memory to be released
    sleep 3
  fi

  # Flush page cache for accurate memory readings
  echo ""
  info "Flushing kernel page cache for accurate memory measurements..."
  if [[ -w /proc/sys/vm/drop_caches ]]; then
    sync
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
    ok "Page cache flushed"
  elif sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null; then
    ok "Page cache flushed"
  else
    warn "Could not flush page cache — RAM readings may include disk cache"
  fi

  # Start sidecar with code model
  info "Starting sidecar with code model..."
  CODE_LOAD_START=$(date +%s%N)
  "$PYTHON" -W ignore "${SIDECAR_SCRIPT}" --port "${SIDECAR_PORT}" --idle-timeout 0 &
  SIDECAR_PID=$!
  trap 'kill "$SIDECAR_PID" 2>/dev/null || true; exit 1' INT TERM

  READY=false
  for i in $(seq 1 60); do
    if sidecar_running; then
      READY=true
      break
    fi
    sleep 1
  done

  if [[ "$READY" != "true" ]]; then
    err "Sidecar failed to start within 60s"
    kill "$SIDECAR_PID" 2>/dev/null || true
    exit 1
  fi

  CODE_LOAD_END=$(date +%s%N)
  CODE_LOAD_MS=$(( (CODE_LOAD_END - CODE_LOAD_START) / 1000000 ))
  CODE_LOAD_S=$(echo "scale=1; $CODE_LOAD_MS / 1000" | bc)

  HEALTH=$(curl -sf "http://127.0.0.1:${SIDECAR_PORT}/health" 2>/dev/null)
  CODE_DIM=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('dim','?'))" 2>/dev/null || echo "?")
  ok "Code model: ${MODEL} (${CODE_DIM}d, loaded in ${CODE_LOAD_S}s)"

  if [[ "$GPU" == "cuda" ]]; then
    VRAM_CODE=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
    info "VRAM with code model: ${VRAM_CODE} MiB / ${VRAM_TOTAL} MiB"
  fi

  # 10 code embedding requests
  CODE_PASS=0
  CODE_SAMPLES=(
    "function hello() { return world; }"
    "export function parseConfig(path: string): Config { return JSON.parse(readFileSync(path)); }"
    "async function fetchData(url: string): Promise<Response> { return await fetch(url); }"
    "class VectorStore { constructor(private db: LanceDB) {} async search(q: number[]) {} }"
    "const TIMEOUT = 30000; export const isExpired = (ts: number) => Date.now() - ts > TIMEOUT;"
    "import { z } from 'zod'; const Schema = z.object({ name: z.string(), score: z.int() });"
    "function merge(a: Result[], b: Result[]): Result[] { return [...a, ...b].sort(); }"
    "export interface EvalContext { file: string; symbols: Symbol[]; deps: DepMeta; }"
    "try { const d = await readFile(p); return JSON.parse(d); } catch { return null; }"
    "const router = express.Router(); router.get('/health', (_, res) => res.json({ ok: true }));"
  )
  CODE_IDX=0
  CODE_LABELS=("parseConfig" "fetchData" "VectorStore" "isExpired" "ZodSchema" "merge" "EvalContext" "readFile+parse" "express.Router" "buildPrompt")
  for sample in "${CODE_SAMPLES[@]}"; do
    T_START=$(date +%s%N)
    R=$(curl -sf "http://127.0.0.1:${SIDECAR_PORT}/embed" \
      -H "Content-Type: application/json" \
      -d "{\"input\": \"$sample\"}" 2>/dev/null)
    T_END=$(date +%s%N)
    T_MS=$(( (T_END - T_START) / 1000000 ))
    if echo "$R" | grep -q '"embedding"'; then
      CODE_PASS=$((CODE_PASS + 1))
      echo "    [$(( CODE_IDX + 1 ))/10] ${T_MS}ms  ${CODE_LABELS[$CODE_IDX]}  ✓"
    else
      echo "    [$(( CODE_IDX + 1 ))/10] ${T_MS}ms  ${CODE_LABELS[$CODE_IDX]}  ✗"
    fi
    CODE_IDX=$((CODE_IDX + 1))
  done
  ok "Code embeddings: ${CODE_PASS}/10 passed"

  # Swap to NLP model
  info "Swapping to NLP model: ${NLP_MODEL}..."
  if [[ "$GPU" == "cuda" ]]; then
    VRAM_PRE_SWAP=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
  fi

  NLP_LOAD_START=$(date +%s%N)
  SWAP_RESULT=$(curl -sf --max-time 180 "http://127.0.0.1:${SIDECAR_PORT}/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\": \"${NLP_MODEL}\"}" 2>/dev/null || echo '{"error":"swap timeout"}')
  NLP_LOAD_END=$(date +%s%N)
  NLP_LOAD_MS=$(( (NLP_LOAD_END - NLP_LOAD_START) / 1000000 ))
  NLP_LOAD_S=$(echo "scale=1; $NLP_LOAD_MS / 1000" | bc)

  if echo "$SWAP_RESULT" | grep -q '"ok"'; then
    NLP_DIM=$(echo "$SWAP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('dim','?'))" 2>/dev/null || echo "?")
    ok "NLP model: ${NLP_MODEL} (${NLP_DIM}d, swapped in ${NLP_LOAD_S}s)"

    if [[ "$GPU" == "cuda" ]]; then
      VRAM_NLP=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
      VRAM_FREE_NOW=$((VRAM_TOTAL - VRAM_NLP))
      info "VRAM with NLP model: ${VRAM_NLP} MiB / ${VRAM_TOTAL} MiB (${VRAM_FREE_NOW} MiB free)"

      if [[ "$VRAM_FREE_NOW" -lt 512 ]]; then
        warn "Low VRAM headroom (${VRAM_FREE_NOW} MiB) — swap may OOM during runs"
      else
        ok "VRAM headroom: ${VRAM_FREE_NOW} MiB free — swap is safe"
      fi
    fi

    # 10 NLP embedding requests
    NLP_PASS=0
    NLP_SAMPLES=(
      "This function generates audit reports from review data"
      "The scanner walks the project tree and extracts symbol metadata"
      "Deliberation verifies findings using a stronger model for accuracy"
      "RAG engine indexes function cards with dual code and text embeddings"
      "Configuration is loaded from anatoly.config.yaml with schema validation"
      "The triage phase filters trivial files to reduce unnecessary API calls"
      "Usage graph tracks import relationships between source files"
      "Best practices axis checks 17 TypeScript coding rules per file"
      "Correction memory persists known false positives across runs"
      "The worker pool limits concurrency to avoid API rate limits"
    )
    NLP_IDX=0
    NLP_LABELS=("report generation" "scanner/tree-sitter" "deliberation" "RAG engine" "config loading" "triage phase" "usage graph" "best practices" "correction memory" "worker pool")
    for sample in "${NLP_SAMPLES[@]}"; do
      T_START=$(date +%s%N)
      R=$(curl -sf "http://127.0.0.1:${SIDECAR_PORT}/embed" \
        -H "Content-Type: application/json" \
        -d "{\"input\": \"$sample\"}" 2>/dev/null)
      T_END=$(date +%s%N)
      T_MS=$(( (T_END - T_START) / 1000000 ))
      if echo "$R" | grep -q '"embedding"'; then
        NLP_PASS=$((NLP_PASS + 1))
        echo "    [$(( NLP_IDX + 1 ))/10] ${T_MS}ms  ${NLP_LABELS[$NLP_IDX]}  ✓"
      else
        echo "    [$(( NLP_IDX + 1 ))/10] ${T_MS}ms  ${NLP_LABELS[$NLP_IDX]}  ✗"
      fi
      NLP_IDX=$((NLP_IDX + 1))
    done
    ok "NLP embeddings: ${NLP_PASS}/10 passed"
  else
    SWAP_ERR=$(echo "$SWAP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "unknown")
    err "Model swap failed: ${SWAP_ERR}"
    NLP_DIM="0"
    NLP_LOAD_S="0"
    NLP_PASS=0
  fi

  # Shutdown test sidecar
  curl -sf -X POST "http://127.0.0.1:${SIDECAR_PORT}/shutdown" &>/dev/null || true
  wait "$SIDECAR_PID" 2>/dev/null || true

  # Update embeddings-ready.json with check metrics
  FLAG_FILE="${PROJECT_ROOT}/.anatoly/embeddings-ready.json"
  if [[ -f "$FLAG_FILE" ]]; then
    # Preserve existing config (quantize flags etc), update timing
    EXISTING=$(cat "$FLAG_FILE")
    python3 -c "
import json, sys
d = json.loads('''${EXISTING}''')
d.update({
  'code_load_s': ${CODE_LOAD_S}, 'nlp_swap_s': ${NLP_LOAD_S},
  'code_embed_pass': ${CODE_PASS}, 'nlp_embed_pass': ${NLP_PASS},
  'vram_code_mib': ${VRAM_CODE:-0}, 'vram_nlp_mib': ${VRAM_NLP:-0},
  'vram_total_mib': ${VRAM_TOTAL:-0},
  'checked_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
})
json.dump(d, open('${FLAG_FILE}', 'w'), indent=2)
" 2>/dev/null
    ok "Metrics updated in .anatoly/embeddings-ready.json"
  fi

  # Read quantize config if A/B test was run previously
  CODE_REC=$(python3 -c "import json; print(json.load(open('${FLAG_FILE}')).get('code_precision','bf16'))" 2>/dev/null || echo "bf16")
  NLP_REC=$(python3 -c "import json; print(json.load(open('${FLAG_FILE}')).get('nlp_precision','bf16'))" 2>/dev/null || echo "bf16")

  echo ""
  echo "  ═══════════════════════════════════════════════"
  echo "  Code:  ${MODEL} (${CODE_DIM}d) — ${CODE_PASS}/10 — ${CODE_LOAD_S}s — ${CODE_REC}"
  echo "  NLP:   ${NLP_MODEL} (${NLP_DIM}d) — ${NLP_PASS}/10 — ${NLP_LOAD_S}s — ${NLP_REC}"
  if [[ "$GPU" == "cuda" ]]; then
    echo "  VRAM:  code ${VRAM_CODE:-?} MiB / nlp ${VRAM_NLP:-?} MiB / total ${VRAM_TOTAL} MiB"
  fi
  echo "  ═══════════════════════════════════════════════"
  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# --ab-test mode: recalibrate quantization recommendation
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--ab-test" ]]; then
  if ! PYTHON=$(get_python); then
    err "Python 3.9+ required"
    exit 1
  fi

  # Ensure GGUF files are downloaded
  CODE_GGUF_PATH="${PROJECT_ROOT}/${MODELS_DIR}/${CODE_GGUF_FILE}"
  NLP_GGUF_PATH="${PROJECT_ROOT}/${MODELS_DIR}/${NLP_GGUF_FILE}"
  mkdir -p "${PROJECT_ROOT}/${MODELS_DIR}"

  if [[ ! -f "$CODE_GGUF_PATH" ]]; then
    info "Downloading ${CODE_GGUF_FILE} from ${CODE_GGUF_REPO}..."
    "$PYTHON" -W ignore -c "
from huggingface_hub import hf_hub_download
hf_hub_download('${CODE_GGUF_REPO}', '${CODE_GGUF_FILE}', local_dir='${PROJECT_ROOT}/${MODELS_DIR}')
" 2>&1 | grep -v "^Warning:"
    ok "Downloaded ${CODE_GGUF_FILE}"
  fi

  if [[ ! -f "$NLP_GGUF_PATH" ]]; then
    info "Downloading ${NLP_GGUF_FILE} from ${NLP_GGUF_REPO}..."
    "$PYTHON" -W ignore -c "
from huggingface_hub import hf_hub_download
hf_hub_download('${NLP_GGUF_REPO}', '${NLP_GGUF_FILE}', local_dir='${PROJECT_ROOT}/${MODELS_DIR}')
" 2>&1 | grep -v "^Warning:"
    ok "Downloaded ${NLP_GGUF_FILE}"
  fi

  if ! check_package "$PYTHON" "llama_cpp"; then
    err "llama-cpp-python not installed. Run: pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124"
    exit 1
  fi

  # Set LD_LIBRARY_PATH for NVIDIA libs bundled in the venv
  NVIDIA_LIBS=$(find "$(dirname "$PYTHON")/../lib" -path "*/nvidia/*/lib" -type d 2>/dev/null | tr '\n' ':')
  export LD_LIBRARY_PATH="${NVIDIA_LIBS}${LD_LIBRARY_PATH:-}"

  "$PYTHON" -W ignore "${SCRIPT_DIR}/embedding-ab-test.py" \
    --code-model "${MODEL}" \
    --nlp-model "${NLP_MODEL}" \
    --code-gguf "${CODE_GGUF_PATH}" \
    --nlp-gguf "${NLP_GGUF_PATH}" \
    --output "${PROJECT_ROOT}/.anatoly/embedding-ab-results.json" 2>&1 | grep -v "^Warning:"
  exit $?
fi

# ---------------------------------------------------------------------------
# Main install flow
# ---------------------------------------------------------------------------
echo ""
info "═══════════════════════════════════════════════"
info "  Anatoly — Embedding Setup"
info "  (sentence-transformers + ${MODEL} + ${NLP_MODEL})"
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

# Step 5: Download/verify the code model
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

# Step 5b: Download/verify the NLP model
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

# Step 6: Sanity check via sidecar
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
    ok "Code embedding sanity check passed (1/10)"
  else
    err "Sanity check failed — sidecar returned unexpected response"
    kill "$SIDECAR_PID" 2>/dev/null || true
    exit 1
  fi

  # Run 9 more code embedding requests
  CODE_SAMPLES=(
    "export function parseConfig(path: string): Config { return JSON.parse(readFileSync(path)); }"
    "async function fetchData(url: string): Promise<Response> { return await fetch(url); }"
    "class VectorStore { constructor(private db: LanceDB) {} async search(query: number[]) {} }"
    "const TIMEOUT_MS = 30000; export const isExpired = (ts: number) => Date.now() - ts > TIMEOUT_MS;"
    "import { z } from 'zod'; const Schema = z.object({ name: z.string(), score: z.int() });"
    "function mergeResults(a: Result[], b: Result[]): Result[] { return [...a, ...b].sort(); }"
    "export interface EvalContext { file: string; symbols: Symbol[]; deps: DepMeta; }"
    "try { const data = await readFile(path); return JSON.parse(data); } catch { return null; }"
    "const router = express.Router(); router.get('/health', (_, res) => res.json({ ok: true }));"
  )
  CODE_PASS=1
  for sample in "${CODE_SAMPLES[@]}"; do
    R=$(curl -sf "http://127.0.0.1:${SIDECAR_PORT}/embed" \
      -H "Content-Type: application/json" \
      -d "{\"input\": \"$sample\"}" 2>/dev/null)
    if echo "$R" | grep -q '"embedding"'; then
      CODE_PASS=$((CODE_PASS + 1))
    fi
  done
  ok "Code embedding: ${CODE_PASS}/10 passed"

  if [[ "$GPU" == "cuda" ]]; then
    VRAM_CODE=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
    VRAM_TOTAL=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
    info "VRAM after code embeddings: ${VRAM_CODE} MiB / ${VRAM_TOTAL} MiB"
  fi

  # Step 6b: Test model swap (code → NLP) with VRAM monitoring
  if [[ "$GPU" == "cuda" ]]; then
    VRAM_BEFORE=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
    VRAM_TOTAL=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
    info "VRAM before swap: ${VRAM_BEFORE} MiB / ${VRAM_TOTAL} MiB (code model loaded)"
  fi

  info "Testing model swap: ${MODEL} → ${NLP_MODEL}..."
  SWAP_RESULT=$(curl -sf --max-time 120 "http://127.0.0.1:${SIDECAR_PORT}/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\": \"${NLP_MODEL}\"}" 2>/dev/null || echo '{"error":"swap timeout"}')

  if echo "$SWAP_RESULT" | grep -q '"ok"'; then
    SWAP_DIM=$(echo "$SWAP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('dim','?'))" 2>/dev/null || echo "?")
    ok "Model swap succeeded: ${NLP_MODEL} (${SWAP_DIM}d)"

    if [[ "$GPU" == "cuda" ]]; then
      VRAM_AFTER=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
      info "VRAM after swap: ${VRAM_AFTER} MiB / ${VRAM_TOTAL} MiB (NLP model loaded)"

      VRAM_FREE=$((VRAM_TOTAL - VRAM_AFTER))
      if [[ "$VRAM_FREE" -lt 512 ]]; then
        warn "Only ${VRAM_FREE} MiB free after NLP model load — swap may OOM during runs"
        warn "Consider using --rag-lite or a smaller NLP model"
      else
        ok "VRAM headroom: ${VRAM_FREE} MiB free — swap is safe"
      fi
    fi

    # Run 10 NLP embedding requests
    NLP_SAMPLES=(
      "This function generates audit reports from review data"
      "The scanner walks the project tree and extracts symbol metadata"
      "Deliberation verifies findings using a stronger model for accuracy"
      "RAG engine indexes function cards with dual code and text embeddings"
      "Configuration is loaded from anatoly.config.yaml with schema validation"
      "The triage phase filters trivial files to reduce unnecessary API calls"
      "Usage graph tracks import relationships between source files"
      "Best practices axis checks 17 TypeScript coding rules per file"
      "Correction memory persists known false positives across runs"
      "The worker pool limits concurrency to avoid API rate limits"
    )
    NLP_PASS=0
    for sample in "${NLP_SAMPLES[@]}"; do
      R=$(curl -sf "http://127.0.0.1:${SIDECAR_PORT}/embed" \
        -H "Content-Type: application/json" \
        -d "{\"input\": \"$sample\"}" 2>/dev/null)
      if echo "$R" | grep -q '"embedding"'; then
        NLP_PASS=$((NLP_PASS + 1))
      fi
    done

    if [[ "$NLP_PASS" -eq 10 ]]; then
      ok "NLP embedding: ${NLP_PASS}/10 passed"
    elif [[ "$NLP_PASS" -gt 0 ]]; then
      warn "NLP embedding: ${NLP_PASS}/10 passed — some requests failed"
    else
      err "NLP embedding: 0/10 passed — model swap appears broken"
      kill "$SIDECAR_PID" 2>/dev/null || true
      exit 1
    fi
  else
    SWAP_ERR=$(echo "$SWAP_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "unknown")
    err "Model swap failed: ${SWAP_ERR}"
    if [[ "$GPU" == "cuda" ]]; then
      VRAM_PEAK=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1)
      err "VRAM at failure: ${VRAM_PEAK} MiB / ${VRAM_TOTAL} MiB"
      err "Both models may not fit in VRAM. Use --rag-lite or upgrade GPU."
    fi
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

# Step 7: Download GGUF models
echo ""
info "═══════════════════════════════════════════════"
info "  Downloading GGUF models (official, quantized)"
info "═══════════════════════════════════════════════"

mkdir -p "${PROJECT_ROOT}/${MODELS_DIR}"
CODE_GGUF_PATH="${PROJECT_ROOT}/${MODELS_DIR}/${CODE_GGUF_FILE}"
NLP_GGUF_PATH="${PROJECT_ROOT}/${MODELS_DIR}/${NLP_GGUF_FILE}"

if [[ -f "$CODE_GGUF_PATH" ]]; then
  ok "Code GGUF cached: ${CODE_GGUF_FILE}"
else
  info "Downloading ${CODE_GGUF_FILE} from ${CODE_GGUF_REPO} (~5 GB)..."
  "$PYTHON" -W ignore -c "
from huggingface_hub import hf_hub_download
hf_hub_download('${CODE_GGUF_REPO}', '${CODE_GGUF_FILE}', local_dir='${PROJECT_ROOT}/${MODELS_DIR}')
" 2>&1 | grep -v "^Warning:"
  ok "Downloaded ${CODE_GGUF_FILE}"
fi

if [[ -f "$NLP_GGUF_PATH" ]]; then
  ok "NLP GGUF cached: ${NLP_GGUF_FILE}"
else
  info "Downloading ${NLP_GGUF_FILE} from ${NLP_GGUF_REPO} (~5.5 GB)..."
  "$PYTHON" -W ignore -c "
from huggingface_hub import hf_hub_download
hf_hub_download('${NLP_GGUF_REPO}', '${NLP_GGUF_FILE}', local_dir='${PROJECT_ROOT}/${MODELS_DIR}')
" 2>&1 | grep -v "^Warning:"
  ok "Downloaded ${NLP_GGUF_FILE}"
fi

# Step 8: Install llama-cpp-python if needed
if ! check_package "$PYTHON" "llama_cpp"; then
  info "Installing llama-cpp-python (with CUDA)..."
  CMAKE_ARGS="-DGGML_CUDA=on" "$PYTHON" -m pip install -q llama-cpp-python --force-reinstall --no-cache-dir
  ok "llama-cpp-python installed"
fi

# Step 9: A/B test — bf16 vs GGUF
echo ""
info "═══════════════════════════════════════════════"
info "  A/B Test: bf16 (sentence-transformers) vs GGUF (llama.cpp)"
info "═══════════════════════════════════════════════"

AB_OUTPUT="${PROJECT_ROOT}/.anatoly/embedding-ab-results.json"
# Set LD_LIBRARY_PATH for NVIDIA libs bundled in the venv
NVIDIA_LIBS=$(find "$(dirname "$PYTHON")/../lib" -path "*/nvidia/*/lib" -type d 2>/dev/null | tr '\n' ':')
export LD_LIBRARY_PATH="${NVIDIA_LIBS}${LD_LIBRARY_PATH:-}"

"$PYTHON" -W ignore "${SCRIPT_DIR}/embedding-ab-test.py" \
  --code-model "${MODEL}" \
  --nlp-model "${NLP_MODEL}" \
  --code-gguf "${CODE_GGUF_PATH}" \
  --nlp-gguf "${NLP_GGUF_PATH}" \
  --output "${AB_OUTPUT}" 2>&1 | grep -v "^Warning:"

# Read recommendations from A/B results
CODE_REC="bf16"
NLP_REC="bf16"
if [[ -f "$AB_OUTPUT" ]]; then
  CODE_REC=$(python3 -c "import json; print(json.load(open('${AB_OUTPUT}'))['code']['recommendation'])" 2>/dev/null || echo "bf16")
  NLP_REC=$(python3 -c "import json; print(json.load(open('${AB_OUTPUT}'))['nlp']['recommendation'])" 2>/dev/null || echo "bf16")
fi

# Step 10: Write readiness flag
FLAG_FILE="${PROJECT_ROOT}/.anatoly/embeddings-ready.json"
mkdir -p "$(dirname "$FLAG_FILE")"

# embeddings-ready.json is updated by the A/B test script itself
# Just add setup metadata if not already there
if [[ -f "$FLAG_FILE" ]]; then
  python3 -c "
import json
d = json.load(open('${FLAG_FILE}'))
d['device'] = '${GPU}'
d['python'] = '${PYTHON}'
d['setup_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
d['code_gguf_path'] = '${CODE_GGUF_PATH}'
d['nlp_gguf_path'] = '${NLP_GGUF_PATH}'
json.dump(d, open('${FLAG_FILE}', 'w'), indent=2)
" 2>/dev/null
else
  cat > "$FLAG_FILE" <<ENDJSON
{
  "code_model": "${MODEL}",
  "nlp_model": "${NLP_MODEL}",
  "code_backend": "${CODE_REC}",
  "nlp_backend": "${NLP_REC}",
  "code_gguf_path": "${CODE_GGUF_PATH}",
  "nlp_gguf_path": "${NLP_GGUF_PATH}",
  "device": "${GPU}",
  "python": "${PYTHON}",
  "setup_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON
fi
ok "Config written to .anatoly/embeddings-ready.json"

echo ""
echo "  ═══════════════════════════════════════════════"
echo ""
ok "Setup complete!"
echo ""
echo "  Code:    ${MODEL} (${CODE_REC})"
echo "  NLP:     ${NLP_MODEL} (${NLP_REC})"
echo "  GGUF:    ${MODELS_DIR}/"
echo "  Device:  ${GPU}"
echo "  Config:  .anatoly/embeddings-ready.json"
echo ""
echo "  ═══════════════════════════════════════════════"
echo ""
info "The embed sidecar starts automatically with 'npx anatoly run'."
info "To check status:   npx anatoly setup-embeddings --check"
info "To recalibrate:    npx anatoly setup-embeddings --ab-test"
echo ""
