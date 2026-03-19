#!/usr/bin/env bash
#
# embedding-ab-test.sh — Compare bf16 (sentence-transformers) vs GGUF (Docker llama.cpp) embeddings.
#
# Tests 10 code samples + 10 NLP samples. Measures cosine similarity between
# bf16 and GGUF embeddings, checks ranking preservation, reports VRAM and latency.
#
# Writes recommendation to .anatoly/embeddings-ready.json backend field.
#
# Usage:
#   ./scripts/embedding-ab-test.sh [--models-dir DIR]
#
# Requirements:
#   - Python 3.9+ with sentence-transformers (bf16 backend)
#   - Docker with NVIDIA Container Toolkit (GGUF backend)
#   - GGUF models in .anatoly/models/
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODELS_DIR="${PROJECT_ROOT}/.anatoly/models"
VENV_DIR="${PROJECT_ROOT}/.anatoly/.venv"

# Docker / model config
GGUF_DOCKER_IMAGE="ghcr.io/ggerganov/llama.cpp:server-cuda"
GGUF_CODE_MODEL="nomic-embed-code.Q5_K_M.gguf"
GGUF_NLP_MODEL="Qwen3-Embedding-8B-Q5_K_M.gguf"
GGUF_CODE_PORT=11437  # Use non-default ports to avoid conflicts
GGUF_NLP_PORT=11438
SIDECAR_PORT="${ANATOLY_EMBED_PORT:-11435}"
SIDECAR_SCRIPT="${SCRIPT_DIR}/embed-server.py"

# Thresholds
MIN_COSINE_SIM=0.99
AB_RESULT_FILE="${PROJECT_ROOT}/.anatoly/ab-test-results.json"

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
# Cleanup handler
# ---------------------------------------------------------------------------
GGUF_CODE_CONTAINER=""
GGUF_NLP_CONTAINER=""
SIDECAR_PID=""

cleanup() {
  info "Cleaning up..."
  if [[ -n "$GGUF_CODE_CONTAINER" ]]; then
    docker stop "$GGUF_CODE_CONTAINER" 2>/dev/null || true
    docker rm "$GGUF_CODE_CONTAINER" 2>/dev/null || true
  fi
  if [[ -n "$GGUF_NLP_CONTAINER" ]]; then
    docker stop "$GGUF_NLP_CONTAINER" 2>/dev/null || true
    docker rm "$GGUF_NLP_CONTAINER" 2>/dev/null || true
  fi
  if [[ -n "$SIDECAR_PID" ]]; then
    kill "$SIDECAR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
get_python() {
  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    echo "${VIRTUAL_ENV}/bin/python"
  elif [[ -f "${VENV_DIR}/bin/python" ]]; then
    echo "${VENV_DIR}/bin/python"
  else
    echo "python3"
  fi
}

wait_for_endpoint() {
  local url="$1"
  local timeout="${2:-120}"
  local start
  start=$(date +%s)

  while true; do
    if curl -sf --max-time 2 "$url" &>/dev/null; then
      return 0
    fi
    local elapsed=$(( $(date +%s) - start ))
    if [[ "$elapsed" -ge "$timeout" ]]; then
      return 1
    fi
    sleep 2
  done
}

get_vram_usage_mb() {
  nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "0"
}

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
echo ""
info "═══════════════════════════════════════════════"
info "  Anatoly — Embedding A/B Test (bf16 vs GGUF)"
info "═══════════════════════════════════════════════"
echo ""

# Check GGUF models
if [[ ! -f "${MODELS_DIR}/${GGUF_CODE_MODEL}" ]]; then
  err "GGUF code model not found: ${MODELS_DIR}/${GGUF_CODE_MODEL}"
  err "Run: npx anatoly setup-embeddings"
  exit 1
fi
if [[ ! -f "${MODELS_DIR}/${GGUF_NLP_MODEL}" ]]; then
  err "GGUF NLP model not found: ${MODELS_DIR}/${GGUF_NLP_MODEL}"
  exit 1
fi

# Check Docker
if ! command -v docker &>/dev/null || ! docker info &>/dev/null 2>&1; then
  err "Docker not available — required for GGUF backend"
  exit 1
fi
ok "Docker available"

# Check Python/sidecar
PYTHON=$(get_python)
if ! "$PYTHON" -c "import sentence_transformers" &>/dev/null; then
  err "sentence-transformers not installed in Python"
  exit 1
fi
ok "Python sidecar available"

# Record baseline VRAM
VRAM_BASELINE=$(get_vram_usage_mb)
info "Baseline VRAM: ${VRAM_BASELINE} MiB"

# ---------------------------------------------------------------------------
# Step 1: Start GGUF Docker containers
# ---------------------------------------------------------------------------
echo ""
info "Starting GGUF Docker containers..."

GGUF_CODE_CONTAINER="anatoly-ab-code-$$"
GGUF_NLP_CONTAINER="anatoly-ab-nlp-$$"

docker run -d --rm --gpus all \
  --name "$GGUF_CODE_CONTAINER" \
  -v "${MODELS_DIR}:/models:ro" \
  -p "${GGUF_CODE_PORT}:8080" \
  "$GGUF_DOCKER_IMAGE" \
  --model "/models/${GGUF_CODE_MODEL}" \
  --embedding \
  --port 8080 \
  -ngl 999 >/dev/null

docker run -d --rm --gpus all \
  --name "$GGUF_NLP_CONTAINER" \
  -v "${MODELS_DIR}:/models:ro" \
  -p "${GGUF_NLP_PORT}:8080" \
  "$GGUF_DOCKER_IMAGE" \
  --model "/models/${GGUF_NLP_MODEL}" \
  --embedding \
  --port 8080 \
  -ngl 999 >/dev/null

info "Waiting for GGUF code container (port ${GGUF_CODE_PORT})..."
if ! wait_for_endpoint "http://127.0.0.1:${GGUF_CODE_PORT}/health" 180; then
  err "GGUF code container failed to start"
  exit 1
fi
ok "GGUF code container ready"

info "Waiting for GGUF NLP container (port ${GGUF_NLP_PORT})..."
if ! wait_for_endpoint "http://127.0.0.1:${GGUF_NLP_PORT}/health" 180; then
  err "GGUF NLP container failed to start"
  exit 1
fi
ok "GGUF NLP container ready"

VRAM_GGUF=$(get_vram_usage_mb)
VRAM_GGUF_USED=$(( VRAM_GGUF - VRAM_BASELINE ))
info "GGUF VRAM usage: ${VRAM_GGUF_USED} MiB (total: ${VRAM_GGUF} MiB)"

# ---------------------------------------------------------------------------
# Step 2: Start bf16 sidecar
# ---------------------------------------------------------------------------
echo ""
info "Starting bf16 sidecar..."

# Stop GGUF containers temporarily to free VRAM for bf16
docker stop "$GGUF_CODE_CONTAINER" 2>/dev/null || true
docker stop "$GGUF_NLP_CONTAINER" 2>/dev/null || true
GGUF_CODE_CONTAINER=""
GGUF_NLP_CONTAINER=""

"$PYTHON" -W ignore "$SIDECAR_SCRIPT" --port "$SIDECAR_PORT" &
SIDECAR_PID=$!

info "Waiting for bf16 sidecar (port ${SIDECAR_PORT})..."
if ! wait_for_endpoint "http://127.0.0.1:${SIDECAR_PORT}/health" 180; then
  err "bf16 sidecar failed to start"
  exit 1
fi
ok "bf16 sidecar ready"

# ---------------------------------------------------------------------------
# Step 3: Run comparison via Python
# ---------------------------------------------------------------------------
echo ""
info "Running embedding comparison..."

"$PYTHON" -W ignore -c "
import json, time, sys, os
os.environ['HF_HUB_VERBOSITY'] = 'error'

import numpy as np
import requests

SIDECAR_URL = 'http://127.0.0.1:${SIDECAR_PORT}'
GGUF_CODE_PORT = ${GGUF_CODE_PORT}
GGUF_NLP_PORT = ${GGUF_NLP_PORT}

# Test samples: 10 code + 10 NLP
CODE_SAMPLES = [
    'function add(a: number, b: number): number { return a + b; }',
    'async function fetchUser(id: string): Promise<User> { const res = await fetch(\"/api/users/\" + id); return res.json(); }',
    'const memoize = <T>(fn: (...args: any[]) => T): ((...args: any[]) => T) => { const cache = new Map(); return (...args) => { const key = JSON.stringify(args); if (cache.has(key)) return cache.get(key); const result = fn(...args); cache.set(key, result); return result; }; };',
    'class EventEmitter { private listeners = new Map<string, Function[]>(); on(event: string, fn: Function) { if (!this.listeners.has(event)) this.listeners.set(event, []); this.listeners.get(event)!.push(fn); } emit(event: string, ...args: any[]) { for (const fn of this.listeners.get(event) ?? []) fn(...args); } }',
    'export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T { let timer: NodeJS.Timeout; return ((...args: any[]) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }) as T; }',
    'function quickSort(arr: number[]): number[] { if (arr.length <= 1) return arr; const pivot = arr[0]; const left = arr.slice(1).filter(x => x <= pivot); const right = arr.slice(1).filter(x => x > pivot); return [...quickSort(left), pivot, ...quickSort(right)]; }',
    'interface Repository<T> { findById(id: string): Promise<T | null>; findAll(): Promise<T[]>; save(entity: T): Promise<void>; delete(id: string): Promise<void>; }',
    'const pipe = <T>(...fns: ((arg: T) => T)[]): ((arg: T) => T) => (arg: T) => fns.reduce((acc, fn) => fn(acc), arg);',
    'async function retry<T>(fn: () => Promise<T>, maxRetries: number, delay: number): Promise<T> { for (let i = 0; i < maxRetries; i++) { try { return await fn(); } catch (e) { if (i === maxRetries - 1) throw e; await new Promise(r => setTimeout(r, delay * (2 ** i))); } } throw new Error(\"unreachable\"); }',
    'function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T { const result = { ...target }; for (const key of Object.keys(source)) { if (source[key] && typeof source[key] === \"object\" && !Array.isArray(source[key])) { result[key as keyof T] = deepMerge(target[key as keyof T] as any, source[key] as any); } else { result[key as keyof T] = source[key] as any; } } return result; }',
]

NLP_SAMPLES = [
    'Function: add. Purpose: Adds two numbers together and returns the sum.',
    'Function: fetchUser. Purpose: Fetches a user from the API by ID, returns a Promise of User.',
    'Function: memoize. Purpose: Higher-order function that caches results of expensive function calls.',
    'Class: EventEmitter. Purpose: Pub/sub event system with typed event names and listener management.',
    'Function: debounce. Purpose: Rate-limits function calls by delaying execution until a pause in invocations.',
    'Function: quickSort. Purpose: Recursive divide-and-conquer sorting algorithm with O(n log n) average case.',
    'Interface: Repository. Purpose: Generic CRUD repository pattern for data access abstraction.',
    'Function: pipe. Purpose: Composes multiple unary functions into a single pipeline from left to right.',
    'Function: retry. Purpose: Retries an async function with exponential backoff on failure.',
    'Function: deepMerge. Purpose: Recursively merges two objects, handling nested object properties.',
]

def cosine_sim(a, b):
    a, b = np.array(a), np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

def embed_sidecar(text):
    r = requests.post(f'{SIDECAR_URL}/embed', json={'input': text}, timeout=30)
    r.raise_for_status()
    return r.json()['embedding']

results = {
    'code_samples': len(CODE_SAMPLES),
    'nlp_samples': len(NLP_SAMPLES),
    'code_sims': [],
    'nlp_sims': [],
    'bf16_code_latency_ms': [],
    'bf16_nlp_latency_ms': [],
}

# Get bf16 embeddings for all samples
print('[info]  Getting bf16 code embeddings...')
bf16_code = []
for sample in CODE_SAMPLES:
    t0 = time.time()
    vec = embed_sidecar(sample)
    results['bf16_code_latency_ms'].append(round((time.time() - t0) * 1000))
    bf16_code.append(vec)

# Swap to NLP model
print('[info]  Swapping sidecar to NLP model...')
r = requests.post(f'{SIDECAR_URL}/load', json={'model': 'Qwen/Qwen3-Embedding-8B', 'quantize': False}, timeout=300)
r.raise_for_status()

print('[info]  Getting bf16 NLP embeddings...')
bf16_nlp = []
for sample in NLP_SAMPLES:
    t0 = time.time()
    vec = embed_sidecar(sample)
    results['bf16_nlp_latency_ms'].append(round((time.time() - t0) * 1000))
    bf16_nlp.append(vec)

# Shutdown sidecar to free VRAM
print('[info]  Stopping bf16 sidecar...')
try:
    requests.post(f'{SIDECAR_URL}/shutdown', timeout=5)
except:
    pass
import time as _time; _time.sleep(3)

# Save bf16 embeddings for comparison after GGUF containers start
bf16_data = {'code': bf16_code, 'nlp': bf16_nlp}
with open('${PROJECT_ROOT}/.anatoly/ab-bf16-cache.json', 'w') as f:
    json.dump(bf16_data, f)

print(json.dumps(results))
" 2>&1 | tee /tmp/ab-step1.log

# Kill sidecar to free VRAM
kill "$SIDECAR_PID" 2>/dev/null || true
wait "$SIDECAR_PID" 2>/dev/null || true
SIDECAR_PID=""
sleep 3

# Restart GGUF containers for comparison
info "Restarting GGUF Docker containers for comparison..."

GGUF_CODE_CONTAINER="anatoly-ab-code-$$"
GGUF_NLP_CONTAINER="anatoly-ab-nlp-$$"

docker run -d --rm --gpus all \
  --name "$GGUF_CODE_CONTAINER" \
  -v "${MODELS_DIR}:/models:ro" \
  -p "${GGUF_CODE_PORT}:8080" \
  "$GGUF_DOCKER_IMAGE" \
  --model "/models/${GGUF_CODE_MODEL}" \
  --embedding \
  --port 8080 \
  -ngl 999 >/dev/null

docker run -d --rm --gpus all \
  --name "$GGUF_NLP_CONTAINER" \
  -v "${MODELS_DIR}:/models:ro" \
  -p "${GGUF_NLP_PORT}:8080" \
  "$GGUF_DOCKER_IMAGE" \
  --model "/models/${GGUF_NLP_MODEL}" \
  --embedding \
  --port 8080 \
  -ngl 999 >/dev/null

info "Waiting for GGUF containers..."
wait_for_endpoint "http://127.0.0.1:${GGUF_CODE_PORT}/health" 180
wait_for_endpoint "http://127.0.0.1:${GGUF_NLP_PORT}/health" 180
ok "GGUF containers ready"

# ---------------------------------------------------------------------------
# Step 4: Get GGUF embeddings and compare
# ---------------------------------------------------------------------------
info "Getting GGUF embeddings and comparing..."

"$PYTHON" -W ignore -c "
import json, time, sys, os
import numpy as np
import requests

GGUF_CODE_PORT = ${GGUF_CODE_PORT}
GGUF_NLP_PORT = ${GGUF_NLP_PORT}

CODE_SAMPLES = [
    'function add(a: number, b: number): number { return a + b; }',
    'async function fetchUser(id: string): Promise<User> { const res = await fetch(\"/api/users/\" + id); return res.json(); }',
    'const memoize = <T>(fn: (...args: any[]) => T): ((...args: any[]) => T) => { const cache = new Map(); return (...args) => { const key = JSON.stringify(args); if (cache.has(key)) return cache.get(key); const result = fn(...args); cache.set(key, result); return result; }; };',
    'class EventEmitter { private listeners = new Map<string, Function[]>(); on(event: string, fn: Function) { if (!this.listeners.has(event)) this.listeners.set(event, []); this.listeners.get(event)!.push(fn); } emit(event: string, ...args: any[]) { for (const fn of this.listeners.get(event) ?? []) fn(...args); } }',
    'export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T { let timer: NodeJS.Timeout; return ((...args: any[]) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }) as T; }',
    'function quickSort(arr: number[]): number[] { if (arr.length <= 1) return arr; const pivot = arr[0]; const left = arr.slice(1).filter(x => x <= pivot); const right = arr.slice(1).filter(x => x > pivot); return [...quickSort(left), pivot, ...quickSort(right)]; }',
    'interface Repository<T> { findById(id: string): Promise<T | null>; findAll(): Promise<T[]>; save(entity: T): Promise<void>; delete(id: string): Promise<void>; }',
    'const pipe = <T>(...fns: ((arg: T) => T)[]): ((arg: T) => T) => (arg: T) => fns.reduce((acc, fn) => fn(acc), arg);',
    'async function retry<T>(fn: () => Promise<T>, maxRetries: number, delay: number): Promise<T> { for (let i = 0; i < maxRetries; i++) { try { return await fn(); } catch (e) { if (i === maxRetries - 1) throw e; await new Promise(r => setTimeout(r, delay * (2 ** i))); } } throw new Error(\"unreachable\"); }',
    'function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T { const result = { ...target }; for (const key of Object.keys(source)) { if (source[key] && typeof source[key] === \"object\" && !Array.isArray(source[key])) { result[key as keyof T] = deepMerge(target[key as keyof T] as any, source[key] as any); } else { result[key as keyof T] = source[key] as any; } } return result; }',
]

NLP_SAMPLES = [
    'Function: add. Purpose: Adds two numbers together and returns the sum.',
    'Function: fetchUser. Purpose: Fetches a user from the API by ID, returns a Promise of User.',
    'Function: memoize. Purpose: Higher-order function that caches results of expensive function calls.',
    'Class: EventEmitter. Purpose: Pub/sub event system with typed event names and listener management.',
    'Function: debounce. Purpose: Rate-limits function calls by delaying execution until a pause in invocations.',
    'Function: quickSort. Purpose: Recursive divide-and-conquer sorting algorithm with O(n log n) average case.',
    'Interface: Repository. Purpose: Generic CRUD repository pattern for data access abstraction.',
    'Function: pipe. Purpose: Composes multiple unary functions into a single pipeline from left to right.',
    'Function: retry. Purpose: Retries an async function with exponential backoff on failure.',
    'Function: deepMerge. Purpose: Recursively merges two objects, handling nested object properties.',
]

def cosine_sim(a, b):
    a, b = np.array(a), np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

def embed_gguf(text, port):
    r = requests.post(f'http://127.0.0.1:{port}/embedding',
                      json={'input': text}, timeout=30)
    r.raise_for_status()
    data = r.json()
    # llama.cpp server returns { results: [{ embedding: [...] }] }
    if 'results' in data and len(data['results']) > 0:
        return data['results'][0]['embedding']
    if 'embedding' in data:
        return data['embedding']
    raise ValueError(f'Unexpected response format: {list(data.keys())}')

# Load bf16 embeddings from cache
with open('${PROJECT_ROOT}/.anatoly/ab-bf16-cache.json') as f:
    bf16_data = json.load(f)
bf16_code = bf16_data['code']
bf16_nlp = bf16_data['nlp']

# Get GGUF code embeddings
print('[info]  Getting GGUF code embeddings...')
gguf_code = []
gguf_code_latency = []
for sample in CODE_SAMPLES:
    t0 = time.time()
    vec = embed_gguf(sample, GGUF_CODE_PORT)
    gguf_code_latency.append(round((time.time() - t0) * 1000))
    gguf_code.append(vec)

# Get GGUF NLP embeddings
print('[info]  Getting GGUF NLP embeddings...')
gguf_nlp = []
gguf_nlp_latency = []
for sample in NLP_SAMPLES:
    t0 = time.time()
    vec = embed_gguf(sample, GGUF_NLP_PORT)
    gguf_nlp_latency.append(round((time.time() - t0) * 1000))
    gguf_nlp.append(vec)

# Compare: cosine similarity between bf16 and GGUF for each sample
code_sims = []
for bf16_vec, gguf_vec in zip(bf16_code, gguf_code):
    # Dimensions may differ (bf16=3584, gguf=3584 for nomic), but if they match:
    if len(bf16_vec) == len(gguf_vec):
        code_sims.append(cosine_sim(bf16_vec, gguf_vec))
    else:
        # Different dimensions — can't directly compare, mark as N/A
        code_sims.append(-1)

nlp_sims = []
for bf16_vec, gguf_vec in zip(bf16_nlp, gguf_nlp):
    if len(bf16_vec) == len(gguf_vec):
        nlp_sims.append(cosine_sim(bf16_vec, gguf_vec))
    else:
        nlp_sims.append(-1)

# Ranking preservation test:
# For each sample, rank all other samples by cosine sim in both backends
# Check if top-3 ranking is preserved
def get_rankings(embeddings, idx):
    \"\"\"Get indices of most similar samples to idx, sorted by similarity.\"\"\"
    sims = []
    for j, vec in enumerate(embeddings):
        if j == idx:
            continue
        sims.append((j, cosine_sim(embeddings[idx], vec)))
    sims.sort(key=lambda x: -x[1])
    return [s[0] for s in sims]

ranking_preserved = 0
ranking_total = 0
for i in range(len(CODE_SAMPLES)):
    if code_sims[i] < 0:
        continue
    bf16_rank = get_rankings(bf16_code, i)[:3]
    gguf_rank = get_rankings(gguf_code, i)[:3]
    ranking_total += 1
    if bf16_rank == gguf_rank:
        ranking_preserved += 1

# Build results
avg_code_sim = np.mean([s for s in code_sims if s >= 0]) if any(s >= 0 for s in code_sims) else 0
avg_nlp_sim = np.mean([s for s in nlp_sims if s >= 0]) if any(s >= 0 for s in nlp_sims) else 0
code_dim_match = len(bf16_code[0]) == len(gguf_code[0]) if bf16_code and gguf_code else False
nlp_dim_match = len(bf16_nlp[0]) == len(gguf_nlp[0]) if bf16_nlp and gguf_nlp else False

results = {
    'code_samples': len(CODE_SAMPLES),
    'nlp_samples': len(NLP_SAMPLES),
    'bf16_code_dim': len(bf16_code[0]) if bf16_code else 0,
    'gguf_code_dim': len(gguf_code[0]) if gguf_code else 0,
    'bf16_nlp_dim': len(bf16_nlp[0]) if bf16_nlp else 0,
    'gguf_nlp_dim': len(gguf_nlp[0]) if gguf_nlp else 0,
    'code_dim_match': code_dim_match,
    'nlp_dim_match': nlp_dim_match,
    'avg_code_cosine_sim': round(avg_code_sim, 6),
    'avg_nlp_cosine_sim': round(avg_nlp_sim, 6),
    'code_sims': [round(s, 6) for s in code_sims],
    'nlp_sims': [round(s, 6) for s in nlp_sims],
    'ranking_preserved': ranking_preserved,
    'ranking_total': ranking_total,
    'gguf_code_latency_ms': gguf_code_latency,
    'gguf_nlp_latency_ms': gguf_nlp_latency,
    'avg_gguf_code_latency_ms': round(np.mean(gguf_code_latency)),
    'avg_gguf_nlp_latency_ms': round(np.mean(gguf_nlp_latency)),
}

# Recommendation
recommend_gguf = True
if not code_dim_match or not nlp_dim_match:
    results['recommendation'] = 'advanced-fp16'
    results['reason'] = f'Dimension mismatch (code: {len(bf16_code[0])} vs {len(gguf_code[0])}, nlp: {len(bf16_nlp[0])} vs {len(gguf_nlp[0])})'
    recommend_gguf = False
elif avg_code_sim < ${MIN_COSINE_SIM}:
    results['recommendation'] = 'advanced-fp16'
    results['reason'] = f'Code cosine similarity {avg_code_sim:.4f} below threshold ${MIN_COSINE_SIM}'
    recommend_gguf = False
elif ranking_total > 0 and ranking_preserved < ranking_total:
    # Ranking not fully preserved — still recommend GGUF if similarity is very high
    if avg_code_sim >= 0.995:
        results['recommendation'] = 'advanced-gguf'
        results['reason'] = f'Similarity {avg_code_sim:.4f} >= 0.995 despite partial ranking change ({ranking_preserved}/{ranking_total})'
    else:
        results['recommendation'] = 'advanced-fp16'
        results['reason'] = f'Ranking not preserved ({ranking_preserved}/{ranking_total}) with similarity {avg_code_sim:.4f}'
        recommend_gguf = False
else:
    results['recommendation'] = 'advanced-gguf'
    results['reason'] = f'Similarity {avg_code_sim:.4f} >= ${MIN_COSINE_SIM}, ranking preserved ({ranking_preserved}/{ranking_total})'

with open('${AB_RESULT_FILE}', 'w') as f:
    json.dump(results, f, indent=2)

print(json.dumps(results, indent=2))
"

# Clean up cached bf16 data
rm -f "${PROJECT_ROOT}/.anatoly/ab-bf16-cache.json"

# ---------------------------------------------------------------------------
# Step 5: Read results and update embeddings-ready.json
# ---------------------------------------------------------------------------
if [[ -f "$AB_RESULT_FILE" ]]; then
  RECOMMENDATION=$("$PYTHON" -c "import json; print(json.load(open('${AB_RESULT_FILE}'))['recommendation'])" 2>/dev/null || echo "advanced-fp16")
  REASON=$("$PYTHON" -c "import json; print(json.load(open('${AB_RESULT_FILE}'))['reason'])" 2>/dev/null || echo "unknown")
  AVG_CODE_SIM=$("$PYTHON" -c "import json; print(json.load(open('${AB_RESULT_FILE}'))['avg_code_cosine_sim'])" 2>/dev/null || echo "0")

  echo ""
  echo "  ═══════════════════════════════════════════════"
  echo ""
  if [[ "$RECOMMENDATION" == "advanced-gguf" ]]; then
    ok "Recommendation: advanced-gguf"
  else
    warn "Recommendation: ${RECOMMENDATION}"
  fi
  echo "  Reason: ${REASON}"
  echo "  Avg code similarity: ${AVG_CODE_SIM}"
  echo ""

  # Update embeddings-ready.json with backend recommendation
  FLAG_FILE="${PROJECT_ROOT}/.anatoly/embeddings-ready.json"
  if [[ -f "$FLAG_FILE" ]]; then
    "$PYTHON" -c "
import json
with open('${FLAG_FILE}') as f:
    flag = json.load(f)
flag['backend'] = '${RECOMMENDATION}'
flag['ab_test_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('${FLAG_FILE}', 'w') as f:
    json.dump(flag, f, indent=2)
print('[ok]    embeddings-ready.json updated with backend=${RECOMMENDATION}')
"
  fi
  echo "  Results:  .anatoly/ab-test-results.json"
  echo ""
else
  err "A/B test results not found"
  exit 1
fi
