#!/usr/bin/env python3
"""
A/B test: compare embedding quality between sentence-transformers (bf16)
and llama-cpp-python (GGUF quantized).

Usage:
    python scripts/embedding-ab-test.py [--code-model MODEL] [--nlp-model MODEL]
                                        [--code-gguf PATH] [--nlp-gguf PATH]
"""

import argparse
import gc
import json
import logging
import os
import re
import subprocess
import sys
import time
import warnings

warnings.filterwarnings("ignore")
os.environ["HF_HUB_VERBOSITY"] = "error"
os.environ["TRANSFORMERS_NO_ADVISORY_WARNINGS"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import numpy as np
import torch

# Suppress noisy tokenizer warnings
logging.getLogger("transformers.tokenization_utils_base").setLevel(logging.ERROR)
logging.getLogger("transformers.convert_slow_tokenizer").setLevel(logging.ERROR)

# ---------------------------------------------------------------------------
# CLI colors + icons
# ---------------------------------------------------------------------------
CYAN = "\033[0;36m"
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
RED = "\033[0;31m"
DIM = "\033[2m"
BOLD = "\033[1m"
NC = "\033[0m"


def info(msg: str):
    print(f"{CYAN}[info]{NC}  {msg}", flush=True)

def ok(msg: str):
    print(f"{GREEN}[ok]{NC}    {msg}", flush=True)

def warn(msg: str):
    print(f"{YELLOW}[warn]{NC}  {msg}", flush=True)

def err(msg: str):
    print(f"{RED}[error]{NC} {msg}", flush=True)

def step(msg: str):
    print(f"\n{BOLD}{msg}{NC}", flush=True)

def detail(msg: str):
    print(f"        {msg}", flush=True)

def result_line(idx: int, total: int, duration_s: float, label: str, passed: bool = True):
    icon = f"{GREEN}✓{NC}" if passed else f"{RED}✗{NC}"
    dur = f"{duration_s:.2f}s" if duration_s >= 1 else f"{int(duration_s * 1000)}ms"
    print(f"    [{idx:>2}/{total}] {dur:<8} {label}  {icon}", flush=True)

def metric(label: str, value: str, passed: bool | None = None):
    if passed is None:
        tag = ""
    elif passed:
        tag = f"  {GREEN}PASS{NC}"
    else:
        tag = f"  {RED}FAIL{NC}"
    print(f"    {label:<18} {value}{tag}", flush=True)

def separator():
    print(f"\n{CYAN}  {'═' * 55}{NC}", flush=True)


# ---------------------------------------------------------------------------
# Logging: console (colored) + file (plain)
# ---------------------------------------------------------------------------
LOG_PATH = os.path.join(os.environ.get("ANATOLY_DIR", ".anatoly"), "embeddings.log")
os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)

logger = logging.getLogger("ab-test")
logger.setLevel(logging.DEBUG)

fh = logging.FileHandler(LOG_PATH, mode="a")
fh.setLevel(logging.DEBUG)
fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
logger.addHandler(fh)

ANSI_RE = re.compile(r"\033\[[0-9;]*m")


class TeeOutput:
    def __init__(self, original, log_fn):
        self.original = original
        self.log_fn = log_fn

    def write(self, msg):
        self.original.write(msg)
        clean = ANSI_RE.sub("", msg)
        if clean.strip():
            self.log_fn(clean.rstrip())

    def flush(self):
        self.original.flush()


sys.stdout = TeeOutput(sys.__stdout__, lambda m: logger.info(m))
sys.stderr = TeeOutput(sys.__stderr__, lambda m: logger.warning(m))


# ---------------------------------------------------------------------------
# Test samples
# ---------------------------------------------------------------------------
CODE_SAMPLES = [
    """export async function evaluateFile(
  task: ReviewTask, axes: AxisEvaluator[], ctx: EvalContext,
): Promise<ReviewFile> {
  const results: AxisResult[] = [];
  for (const axis of axes) {
    try {
      const result = await retryWithBackoff(() => axis.evaluate(task, ctx), {
        maxRetries: 2, baseDelayMs: 1000,
      });
      results.push(result);
    } catch (err) {
      ctx.logger.warn({ axis: axis.id, file: task.file, err }, 'axis evaluation failed');
      results.push({ axisId: axis.id, symbols: [], error: String(err) });
    }
  }
  return mergeAxisResults(task, results, ctx.usageGraph);
}""",
    """export class ProgressManager {
  private progress: ProgressData;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private progressPath: string) {
    this.progress = existsSync(progressPath)
      ? JSON.parse(readFileSync(progressPath, 'utf-8'))
      : { version: 1, files: {}, startedAt: new Date().toISOString() };
  }
  updateFileStatus(file: string, status: FileStatus, verdict?: Verdict): void {
    this.progress.files[file] = { status, verdict, updatedAt: new Date().toISOString() };
    this.writeQueue = this.writeQueue.then(() =>
      atomicWriteJson(this.progressPath, this.progress));
  }
  async flush(): Promise<void> { await this.writeQueue; }
}""",
    """export function mergeSymbol(
  symbolName: string, axisResults: Map<AxisId, AxisSymbolResult>,
  usageGraph: UsageGraph,
): MergedSymbol {
  const correction = axisResults.get('correction')?.correction ?? '-';
  const utility = axisResults.get('utility')?.utility ?? '-';
  const duplication = axisResults.get('duplication')?.duplication ?? '-';
  const overengineering = axisResults.get('overengineering')?.overengineering ?? '-';
  const tests = axisResults.get('tests')?.tests ?? '-';
  const adjustedTests = utility === 'DEAD' ? 'NONE' : tests;
  const adjustedOE = correction === 'ERROR' ? 'ACCEPTABLE' : overengineering;
  const confidence = Math.min(
    ...Array.from(axisResults.values()).map(r => r.confidence).filter(c => c > 0));
  return {
    name: symbolName, correction, utility, duplication,
    overengineering: adjustedOE, tests: adjustedTests, confidence,
    detail: buildMergedDetail(axisResults),
  };
}""",
    """export function loadConfig(projectRoot: string): Config {
  const configPath = resolve(projectRoot, 'anatoly.config.yaml');
  if (!existsSync(configPath)) return getDefaultConfig();
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = yaml.parse(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid config:\\n${issues.join('\\n')}`);
  }
  const config = result.data;
  if (process.env.ANATOLY_CONCURRENCY) {
    config.concurrency = parseInt(process.env.ANATOLY_CONCURRENCY, 10);
  }
  return config;
}""",
    """export function parseFile(filePath: string, content: string): ParsedFile {
  const lang = detectLanguage(filePath);
  const parser = getParser(lang);
  const tree = parser.parse(content);
  const symbols: Symbol[] = [];
  const cursor = tree.walk();
  let reachedRoot = false;
  while (!reachedRoot) {
    const node = cursor.currentNode;
    if (isExportedDeclaration(node) || isFunctionDeclaration(node)) {
      symbols.push({
        name: extractName(node), kind: classifyKind(node),
        exported: isExported(node),
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
      });
    }
    if (cursor.gotoFirstChild()) continue;
    if (cursor.gotoNextSibling()) continue;
    while (true) {
      if (!cursor.gotoParent()) { reachedRoot = true; break; }
      if (cursor.gotoNextSibling()) break;
    }
  }
  return { filePath, symbols, lineCount: content.split('\\n').length };
}""",
    """export async function searchByIdHybrid(
  store: VectorStore, functionId: string, k: number = 5, codeWeight: number = 0.6,
): Promise<SearchResult[]> {
  const card = await store.getById(functionId);
  if (!card) return [];
  const codeResults = await store.searchByVector(card.vector, k * 2, 'function');
  const nlpResults = card.nlp_vector
    ? await store.searchByNlpVector(card.nlp_vector, k * 2, 'function') : [];
  const scoreMap = new Map<string, { code: number; nlp: number }>();
  for (const r of codeResults) {
    if (r.id === functionId) continue;
    scoreMap.set(r.id, { code: r.score, nlp: 0 });
  }
  for (const r of nlpResults) {
    if (r.id === functionId) continue;
    const existing = scoreMap.get(r.id) ?? { code: 0, nlp: 0 };
    existing.nlp = r.score;
    scoreMap.set(r.id, existing);
  }
  return Array.from(scoreMap.entries())
    .map(([id, s]) => ({ id, score: codeWeight * s.code + (1 - codeWeight) * s.nlp }))
    .sort((a, b) => b.score - a.score).slice(0, k);
}""",
    """export function generateReport(
  projectRoot: string, errorFiles: string[], runDir?: string,
): { reportPath: string; data: ReportData } {
  const reviewsDir = runDir ? resolve(runDir, 'reviews') : resolve(projectRoot, '.anatoly', 'reviews');
  const reviews = loadReviews(reviewsDir);
  const globalVerdict = computeGlobalVerdict(reviews);
  const findingFiles = reviews.filter(r => r.verdict !== 'CLEAN');
  const cleanFiles = reviews.filter(r => r.verdict === 'CLEAN');
  const data: ReportData = {
    totalFiles: reviews.length, findingFiles, cleanFiles, errorFiles, globalVerdict,
    generatedAt: new Date().toISOString(),
  };
  const markdown = renderIndex(data);
  const reportPath = runDir ? resolve(runDir, 'report.md') : resolve(projectRoot, '.anatoly', 'report.md');
  writeFileSync(reportPath, markdown, 'utf-8');
  return { reportPath, data };
}""",
    """async function runWorkerPool<T>(
  tasks: T[], concurrency: number,
  worker: (task: T, index: number) => Promise<void>,
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  let nextIndex = 0; let completed = 0;
  const total = tasks.length;
  const errors: Error[] = [];
  async function runNext(): Promise<void> {
    while (nextIndex < total) {
      const idx = nextIndex++;
      try { await worker(tasks[idx], idx); }
      catch (err) { errors.push(err instanceof Error ? err : new Error(String(err))); }
      completed++;
      onProgress?.(completed, total);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, total) }, () => runNext());
  await Promise.all(workers);
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length}/${total} tasks failed`);
}""",
    """export function applyDeliberation(
  review: ReviewFile, deliberation: DeliberationResponse,
): { symbols: ReviewSymbol[]; verdict: Verdict; reclassified: number } {
  const symbols = review.symbols.map(sym => {
    const delib = deliberation.symbols.find(d => d.name === sym.name);
    if (!delib) return sym;
    const updated = { ...sym, confidence: delib.deliberated.confidence ?? sym.confidence };
    const AXES = ['correction', 'utility', 'duplication', 'overengineering', 'tests'] as const;
    for (const axis of AXES) {
      const orig = delib.original[axis];
      const deliberated = delib.deliberated[axis];
      if (!orig || !deliberated || orig === deliberated) continue;
      (updated as Record<string, unknown>)[axis] = deliberated;
    }
    return updated;
  });
  const verdict = recomputeVerdict(symbols, deliberation.verdict);
  return { symbols, verdict, reclassified: 0 };
}""",
    """const NAMED_IMPORT_RE = /import\\s*\\{([^}]+)\\}\\s*from\\s*['\"]([^'\"]+)['\"]/g;
const DEFAULT_IMPORT_RE = /import\\s+(\\w+)\\s+from\\s*['\"]([^'\"]+)['\"]/g;
const STAR_REEXPORT_RE = /export\\s+\\*\\s+from\\s*['\"]([^'\"]+)['\"]/g;
export function extractImports(content: string, filePath: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const dir = dirname(filePath);
  for (const re of [NAMED_IMPORT_RE, DEFAULT_IMPORT_RE]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const specifier = match[match.length - 1];
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(dir, specifier);
        edges.push({ from: filePath, to: resolved, symbols: ['*'], isTypeOnly: false });
      }
    }
  }
  return edges;
}""",
]

NLP_SAMPLES = [
    "The Anatoly pipeline processes TypeScript projects through six sequential phases: scan, estimate, triage, RAG index, review, and report. Each phase is crash-isolated so that a failure in one axis does not prevent the others from producing results.",
    "The deliberation pass is the quality gate that separates Anatoly from simple linters. After all six axes have independently evaluated a file, their results are merged into a single ReviewFile. If findings exist, the file is sent to a deliberation agent powered by Claude Opus.",
    "The RAG engine provides semantic search capabilities for the duplication and documentation axes. It maintains a LanceDB vector database with two types of entries: function cards and documentation sections.",
    "The correction axis uses a two-pass approach to minimize false positives. In Pass 1, a Sonnet model evaluates each symbol for bugs. If Pass 1 flags issues and the file imports external dependencies, Pass 2 verifies against library README documentation.",
    "The usage graph is a directed graph tracking import relationships between TypeScript files. It enables the utility axis to determine whether exported symbols are actually imported by other files.",
    "The test axis evaluates the quality of existing test coverage, not just its presence. It checks whether test files exist, analyzes content for quality signals like behavioral testing and edge case coverage.",
    "The best practices axis evaluates files against 17 TypeScript-specific rules organized by severity. Critical rules include no any type and security checks for injection vulnerabilities.",
    "Reports are split into shards of 10 files each to keep each document focused and actionable. Each shard contains a findings table, actions categorized as quickwin or refactor, and checkbox items for tests.",
    "Anatoly maintains a calibration file that records per-axis median durations from previous runs. This data drives the dry-run cost and time estimates shown before a full run begins.",
    "Configuration is defined in anatoly.config.yaml, validated against a Zod schema at load time. It controls which axes are enabled, model selection per axis, concurrency limits, and RAG mode selection.",
]

CODE_SIMILAR_PAIRS = [
    (0, 7),  # evaluateFile vs runWorkerPool — async task orchestration
    (2, 8),  # mergeSymbol vs applyDeliberation — merge/transform axis results
    (4, 9),  # parseFile vs extractImports — AST/regex parsing
]

NLP_SIMILAR_PAIRS = [
    (1, 3),  # deliberation vs correction two-pass — verification/accuracy
    (4, 5),  # usage graph vs test axis — cross-file analysis
    (7, 8),  # shard system vs calibration — output pipeline
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def sample_label(sample: str, max_len: int = 50) -> str:
    for prefix in ["export function ", "export async function ", "function ", "async function ",
                    "export class ", "class ", "const ", "export const "]:
        if prefix in sample:
            rest = sample.split(prefix, 1)[1]
            name = rest.split("(")[0].split(" ")[0].split("=")[0].strip()
            if name:
                return name[:max_len]
    first_line = sample.strip().split("\n")[0]
    return first_line[:max_len] + ("..." if len(first_line) > max_len else "")


def cooldown(label: str = ""):
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
    time.sleep(3)
    try:
        subprocess.run(["sudo", "-n", "sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"],
                       capture_output=True, timeout=5)
    except Exception:
        pass
    time.sleep(2)
    if torch.cuda.is_available():
        vram_used = torch.cuda.memory_allocated() // (1024 * 1024)
        vram_total = torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)
        tag = f" ({label})" if label else ""
        info(f"Cooldown{tag}: {vram_total - vram_used} MiB VRAM free")


def get_vram_nvidia_smi() -> int:
    """Get VRAM used via nvidia-smi (more accurate than torch for gguf)."""
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=5)
        return int(r.stdout.strip())
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Embedding backends
# ---------------------------------------------------------------------------
def embed_bf16(model, samples: list[str]) -> np.ndarray:
    """Embed samples using sentence-transformers (bf16)."""
    vecs = []
    for i, sample in enumerate(samples):
        t0 = time.time()
        vec = model.encode(sample, normalize_embeddings=True)
        dt = time.time() - t0
        result_line(i + 1, len(samples), dt, sample_label(sample))
        logger.debug(f"bf16 embed [{i + 1}/{len(samples)}] {dt:.3f}s dim={len(vec)}")
        vecs.append(vec)
    return np.array(vecs)


def embed_gguf(model, samples: list[str]) -> np.ndarray:
    """Embed samples using llama-cpp-python (GGUF)."""
    vecs = []
    for i, sample in enumerate(samples):
        t0 = time.time()
        raw = model.embed(sample)
        # llama.cpp returns list of lists for single input
        vec = np.array(raw[0] if isinstance(raw[0], list) else raw, dtype=np.float32)
        # Normalize
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        dt = time.time() - t0
        result_line(i + 1, len(samples), dt, sample_label(sample))
        logger.debug(f"gguf embed [{i + 1}/{len(samples)}] {dt:.3f}s dim={len(vec)}")
        vecs.append(vec)
    return np.array(vecs)


# ---------------------------------------------------------------------------
# A/B test per model
# ---------------------------------------------------------------------------
def test_model(name_hf: str, path_gguf: str, samples: list[str],
               similar_pairs: list[tuple], device: str):
    separator()
    step(f"  A/B Test: {os.path.basename(name_hf)}")
    detail(f"A: bf16 — sentence-transformers ({name_hf})")
    detail(f"B: GGUF — llama-cpp-python ({os.path.basename(path_gguf)})")

    # --- [A] bf16 via sentence-transformers ---
    step(f"  [A] bf16 (sentence-transformers)")
    info("Loading model...")
    vram_before_a = get_vram_nvidia_smi()
    t0 = time.time()
    from sentence_transformers import SentenceTransformer
    model_a = SentenceTransformer(name_hf, device=device, trust_remote_code=True)
    load_a = time.time() - t0
    vram_a = get_vram_nvidia_smi()
    dim_a = model_a.get_sentence_embedding_dimension()
    ok(f"Loaded in {load_a:.1f}s — {dim_a}d — VRAM {vram_a} MiB (+{vram_a - vram_before_a})")

    info(f"Embedding {len(samples)} samples...")
    t0 = time.time()
    emb_a = embed_bf16(model_a, samples)
    embed_time_a = time.time() - t0
    ok(f"Done in {embed_time_a:.2f}s")

    del model_a
    cooldown("after bf16")

    # --- [B] GGUF via llama-cpp-python ---
    step(f"  [B] GGUF (llama-cpp-python)")
    info("Loading model...")
    vram_before_b = get_vram_nvidia_smi()
    t0 = time.time()
    from llama_cpp import Llama
    model_b = Llama(
        model_path=path_gguf,
        embedding=True,
        n_gpu_layers=-1,  # all layers on GPU
        n_ctx=2048,
        verbose=False,
    )
    load_b = time.time() - t0
    vram_b = get_vram_nvidia_smi()
    # Get dim from a test embed
    test_vec = model_b.embed("test")
    dim_b = len(test_vec[0] if isinstance(test_vec[0], list) else test_vec)
    ok(f"Loaded in {load_b:.1f}s — {dim_b}d — VRAM {vram_b} MiB (+{vram_b - vram_before_b})")

    info(f"Embedding {len(samples)} samples...")
    t0 = time.time()
    emb_b = embed_gguf(model_b, samples)
    embed_time_b = time.time() - t0
    ok(f"Done in {embed_time_b:.2f}s")

    del model_b
    cooldown("after gguf")

    # --- Comparison ---
    step("  Comparison")

    per_sample_sims = [cosine_sim(emb_a[i], emb_b[i]) for i in range(len(samples))]
    mean_sim = np.mean(per_sample_sims)
    min_sim = np.min(per_sample_sims)
    info(f"bf16 ↔ GGUF cosine similarity: mean={mean_sim:.6f}  min={min_sim:.6f}")

    ranking_preserved = 0
    for i, j in similar_pairs:
        sim_a = cosine_sim(emb_a[i], emb_a[j])
        sim_b = cosine_sim(emb_b[i], emb_b[j])
        diff = abs(sim_a - sim_b)
        preserved = diff < 0.05
        ranking_preserved += int(preserved)
        icon = f"{GREEN}OK{NC}" if preserved else f"{RED}DRIFT{NC}"
        detail(f"Pair ({i},{j}): bf16={sim_a:.4f}  GGUF={sim_b:.4f}  Δ={diff:.4f}  [{icon}]")

    # Verdict
    vram_used_a = vram_a - vram_before_a
    vram_used_b = vram_b - vram_before_b
    vram_savings = vram_used_a - vram_used_b
    quality_ok = mean_sim > 0.99 and min_sim > 0.97
    ranking_ok = ranking_preserved == len(similar_pairs)
    vram_ok = vram_used_b <= vram_used_a
    speed_ok = embed_time_b <= embed_time_a * 2.0  # GGUF can be a bit slower, allow 2x
    load_ok = load_b <= load_a * 2.0

    step("  Results")
    metric("VRAM", f"{vram_used_a} → {vram_used_b} MiB ({vram_savings:+d})", vram_ok)
    metric("Load time", f"{load_a:.1f}s → {load_b:.1f}s", load_ok)
    metric("Embed time", f"{embed_time_a:.2f}s → {embed_time_b:.2f}s", speed_ok)
    metric("Quality", f"{mean_sim:.6f} mean, {min_sim:.6f} min", quality_ok)
    metric("Ranking", f"{ranking_preserved}/{len(similar_pairs)}", ranking_ok)

    all_pass = quality_ok and ranking_ok and vram_ok
    recommend = "gguf" if all_pass else "bf16"

    print()
    if all_pass:
        ok(f"Recommendation: {GREEN}{BOLD}GGUF{NC}")
        detail(f"VRAM saved: {vram_savings} MiB")
        if not speed_ok:
            detail(f"{DIM}Note: GGUF is slower but fits in less VRAM{NC}")
    else:
        reasons = []
        if not vram_ok: reasons.append(f"VRAM +{-vram_savings} MiB")
        if not quality_ok: reasons.append(f"quality {mean_sim:.4f} < 0.99")
        if not ranking_ok: reasons.append("ranking drift")
        ok(f"Recommendation: {BOLD}bf16{NC}")
        if reasons:
            detail(f"{DIM}GGUF rejected: {', '.join(reasons)}{NC}")

    return {
        "model": name_hf,
        "gguf_path": path_gguf,
        "bf16_vram_mib": vram_used_a,
        "gguf_vram_mib": vram_used_b,
        "bf16_load_s": round(load_a, 1),
        "gguf_load_s": round(load_b, 1),
        "bf16_embed_s": round(embed_time_a, 2),
        "gguf_embed_s": round(embed_time_b, 2),
        "bf16_dim": dim_a,
        "gguf_dim": dim_b,
        "mean_cosine_sim": round(float(mean_sim), 6),
        "min_cosine_sim": round(float(min_sim), 6),
        "ranking_preserved": f"{ranking_preserved}/{len(similar_pairs)}",
        "quality_pass": bool(quality_ok),
        "ranking_pass": bool(ranking_ok),
        "vram_pass": bool(vram_ok),
        "speed_pass": bool(speed_ok),
        "load_pass": bool(load_ok),
        "recommendation": recommend,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Embedding A/B test: bf16 vs GGUF")
    parser.add_argument("--code-model", default="nomic-ai/nomic-embed-code")
    parser.add_argument("--nlp-model", default="Qwen/Qwen3-Embedding-8B")
    parser.add_argument("--code-gguf", required=True, help="Path to code model GGUF file")
    parser.add_argument("--nlp-gguf", required=True, help="Path to NLP model GGUF file")
    parser.add_argument("--output", default=".anatoly/embedding-ab-results.json")
    args = parser.parse_args()

    logger.info("=" * 60)
    logger.info("A/B Test started (bf16 vs GGUF)")
    logger.info(f"Code: {args.code_model} vs {args.code_gguf}")
    logger.info(f"NLP: {args.nlp_model} vs {args.nlp_gguf}")
    logger.info(f"Log: {LOG_PATH}")

    separator()
    step("  Anatoly — Embedding A/B Test (bf16 vs GGUF)")
    separator()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print()
    ok(f"Device: {device}")
    if torch.cuda.is_available():
        total = torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)
        gpu_name = torch.cuda.get_device_name(0)
        info(f"GPU: {gpu_name} ({total} MiB)")
    info(f"Log: {LOG_PATH}")

    # Flush page cache
    print()
    info("Flushing kernel page cache...")
    r = subprocess.run(["sudo", "sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"], timeout=30)
    if r.returncode == 0:
        ok("Page cache flushed")
    else:
        warn("Could not flush page cache")

    # Verify GGUF files exist
    for label, path in [("Code GGUF", args.code_gguf), ("NLP GGUF", args.nlp_gguf)]:
        if not os.path.exists(path):
            err(f"{label} not found: {path}")
            sys.exit(1)
        size_gb = os.path.getsize(path) / (1024 ** 3)
        ok(f"{label}: {os.path.basename(path)} ({size_gb:.1f} GB)")

    cooldown("pre-test baseline")

    # Run tests
    results = {}
    results["code"] = test_model(args.code_model, args.code_gguf, CODE_SAMPLES, CODE_SIMILAR_PAIRS, device)
    cooldown("between code and NLP")
    results["nlp"] = test_model(args.nlp_model, args.nlp_gguf, NLP_SAMPLES, NLP_SIMILAR_PAIRS, device)

    # Summary
    separator()
    step("  Summary")
    separator()
    print()
    for key, label in [("code", "Code"), ("nlp", "NLP ")]:
        r = results[key]
        rec = r["recommendation"]
        rec_colored = f"{GREEN}{BOLD}{rec}{NC}" if rec == "gguf" else f"{BOLD}{rec}{NC}"
        print(f"  {label}  {rec_colored}  {os.path.basename(r['model'])}", flush=True)
        detail(f"sim={r['mean_cosine_sim']}  VRAM {r['bf16_vram_mib']} → {r['gguf_vram_mib']} MiB  "
               f"dim {r['bf16_dim']}→{r['gguf_dim']}")

    total_bf16 = results["code"]["bf16_vram_mib"] + results["nlp"]["bf16_vram_mib"]
    total_gguf = results["code"]["gguf_vram_mib"] + results["nlp"]["gguf_vram_mib"]
    print()
    metric("bf16 total VRAM", f"{total_bf16} MiB")
    metric("GGUF total VRAM", f"{total_gguf} MiB")
    metric("Savings", f"{total_bf16 - total_gguf} MiB ({(1 - total_gguf / max(total_bf16, 1)) * 100:.0f}%)")

    # Save results
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)
    print()
    ok(f"A/B results saved to {args.output}")

    # Update embeddings-ready.json
    ready_path = os.path.join(os.path.dirname(args.output), "embeddings-ready.json")
    ready = {}
    if os.path.exists(ready_path):
        with open(ready_path) as f:
            ready = json.load(f)

    code_rec = results["code"]["recommendation"]
    nlp_rec = results["nlp"]["recommendation"]

    ready.update({
        "code_model": results["code"]["model"],
        "nlp_model": results["nlp"]["model"],
        "code_backend": code_rec,
        "nlp_backend": nlp_rec,
        "code_gguf": results["code"]["gguf_path"] if code_rec == "gguf" else None,
        "nlp_gguf": results["nlp"]["gguf_path"] if nlp_rec == "gguf" else None,
        "code_precision": code_rec,
        "nlp_precision": nlp_rec,
        "ab_tested_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "code_quality": {
            "mean_sim": results["code"]["mean_cosine_sim"],
            "min_sim": results["code"]["min_cosine_sim"],
            "ranking": results["code"]["ranking_preserved"],
            "vram_bf16": results["code"]["bf16_vram_mib"],
            "vram_gguf": results["code"]["gguf_vram_mib"],
        },
        "nlp_quality": {
            "mean_sim": results["nlp"]["mean_cosine_sim"],
            "min_sim": results["nlp"]["min_cosine_sim"],
            "ranking": results["nlp"]["ranking_preserved"],
            "vram_bf16": results["nlp"]["bf16_vram_mib"],
            "vram_gguf": results["nlp"]["gguf_vram_mib"],
        },
    })

    with open(ready_path, "w") as f:
        json.dump(ready, f, indent=2)
    ok(f"Config updated in {ready_path}")
    detail(f"code: {code_rec} | nlp: {nlp_rec}")

    logger.info("=" * 60)
    logger.info("A/B Test completed")
    logger.info(f"Code: {code_rec} (sim={results['code']['mean_cosine_sim']})")
    logger.info(f"NLP: {nlp_rec} (sim={results['nlp']['mean_cosine_sim']})")
    logger.info("=" * 60)

    separator()
    print()


if __name__ == "__main__":
    main()
