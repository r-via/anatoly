# Installation

## Prerequisites

- **Node.js >= 20.19** -- Anatoly uses modern Node.js APIs (ES modules, native fetch). Check your version with `node --version`.
- **Windows users**: install and run Anatoly **only inside WSL** (Ubuntu / Debian). Anatoly depends on native modules (ONNX Runtime, tree-sitter, LanceDB) and on POSIX shell semantics for its bash tool, which the Windows-native Node runtime does not provide. Do **not** install Node.js on the Windows side: a Windows install ends up on the WSL `$PATH` (typically via `nvm-for-windows` or the Node MSI) and silently shadows your WSL Node, leading to confusing crashes. Use [`nvm`](https://github.com/nvm-sh/nvm) inside WSL to manage Node, and ensure `which node` resolves to a Linux path (`/home/<you>/.nvm/...`), never to `/mnt/c/...`.
- **An LLM auth path** -- Anatoly is multi-provider and supports four modes. Pick one:

  | Mode | Setup | Cost | When to pick |
  |------|-------|------|--------------|
  | **Subscription** *(default)* | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed + logged in | Your Claude.ai (Pro / Max) subscription | Most users — **no API key needed** |
  | **Subscription (Google)** | Google OAuth via [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Your Code Assist subscription, $0/token | Cost-optimize lightweight axes |
  | **BYOK API** | Set `ANTHROPIC_API_KEY` *(or `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.)* | Per-token billing | No subscription, or pay-as-you-go preferred |
  | **Local** | Run Ollama / LM Studio / vLLM | Free | Code that cannot leave your network |

By default Anatoly assumes **subscription mode** for `anthropic` and `google` providers — the configured `.anatoly.yml` lists these as `mode: subscription`. If you prefer API mode, set the relevant env var and switch the provider's `mode` to `api`:

```bash
# Only needed for BYOK API mode
export ANTHROPIC_API_KEY="sk-ant-..."
```

See [Configuration → providers](./02-Configuration.md#providers-v2) for the full provider config and [Recommended LLM Setup](./03-Recommended-LLM-Setup.md) for tuning per axis.

## Install

### Run without installing

The fastest way to try Anatoly:

```bash
npx @r-via/anatoly run
```

### Install globally (npm)

```bash
npm install -g @r-via/anatoly
anatoly run
```

### Install globally (pnpm)

```bash
pnpm add -g @r-via/anatoly
anatoly run
```

### Install as a dev dependency

```bash
npm install -D @r-via/anatoly
npx anatoly run
```

The first time `anatoly run` indexes a project, the default embedding model (Jina Embeddings V2 Base Code, ONNX, ~150 MB) is downloaded from HuggingFace and cached under `~/.cache/huggingface/`. Progress is reported in the run log. Subsequent runs reuse the cached model.

To pre-download the model out of band (e.g. CI image build), run the bundled script:

```bash
node ./node_modules/@r-via/anatoly/scripts/download-model.js
```

### Install from source (debug unpublished commits)

To test changes from a branch or unpublished commit, **do not use** `npm install -g github:r-via/anatoly` — it hits two reproducible npm/WSL bugs (NPM_CONFIG_GLOBAL inheritance breaks devDeps install in pacote, and ext4 races on tarball extract during the outer global install). Use the bundled `Makefile` instead:

```bash
# prerequisite: GNU make (usually preinstalled; on minimal distros: sudo apt install -y make)
git clone https://github.com/r-via/anatoly      # or -b <branch>
cd anatoly
make install                                     # deps + build + global symlink
make doctor                                      # verify environment
anatoly --version                                # confirm
```

`make help` lists every target. To remove later: `make uninstall`.

### WSL2 users

If `anatoly run` exits with an error like:

```
/mnt/c/nvm4w/nodejs/anatoly: 15: exec: node: Permission denied
```

…your Node.js is installed on the **Windows side** (typically nvm-windows / `nvm4w`) and is being picked up from the WSL `PATH`. Linux can't execute the Windows `node.exe` from a WSL shim. Install Node.js *inside* the distribution and re-install Anatoly:

```bash
# 1. Install nvm into the WSL distribution
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# 2. Load nvm into the *current* shell (DO NOT use `exec $SHELL` here —
#    it replaces the process and discards any commands queued after it)
. "$HOME/.nvm/nvm.sh"

# 3. Install Node and re-install anatoly
nvm install 20.19
nvm use 20.19
which node                          # must NOT be under /mnt/c/...
npm install -g @r-via/anatoly
```

Anatoly also fails fast at startup if it detects it is running under a Windows-installed Node from inside WSL (via `binfmt_misc`), so you should never end up with cross-OS path semantics silently degrading the run.

### Optional: GPU-accelerated embeddings

If you have an NVIDIA GPU with >= 12 GB VRAM and Docker installed, you can use GGUF-quantized models in Docker llama.cpp containers for higher-quality embeddings:

```bash
npx anatoly local-embeddings upgrade   # Pulls Docker images, downloads GGUF models (SHA256-verified)
npx anatoly local-embeddings status    # Inspect current install without making changes
```

Containers start automatically with `anatoly run` when setup is detected. No Python dependency -- Docker is the only runtime requirement for GPU mode.

## First run walkthrough

From your project root (the directory containing `package.json` and your `src/` folder):

```bash
npx anatoly run
```

This single command executes the full pipeline:

```
scan --> estimate --> triage --> usage graph --> index --> review --> deliberate --> report
```

### What happens step by step

1. **Config** -- Anatoly looks for `.anatoly.yml` in the project root. If none exists, it uses sensible defaults (scans `src/**/*.ts` and `src/**/*.tsx`).

2. **Scan** -- The AST scanner (web-tree-sitter) parses every matched file and extracts symbols: functions, classes, types, enums, hooks, constants. It records line ranges, export status, and computes SHA-256 hashes for caching.

3. **Estimate** -- A local token estimation pass (no API calls) counts symbols and predicts cost and duration.

4. **Triage** -- Files are classified into `skip` or `evaluate` tiers. Barrel exports (`index.ts` that only re-exports), type-only files, and trivial files skip review at zero API cost.

5. **Usage graph** -- A one-pass import resolution builds a project-wide usage graph, so the agent knows which symbols are imported where without making redundant tool calls.

6. **RAG index** -- Local code embeddings (768-dim vectors) are computed with Jina Embeddings V2 Base Code and stored in LanceDB. This enables semantic duplication detection across files. Zero API cost.

7. **Review** -- Each file in the `evaluate` tier is reviewed by Claude agents running all seven axes in parallel (correction, overengineering, utility, duplication, tests, best practices, documentation). The agent can grep the project, read other files, and query the RAG index. Findings must include evidence.

8. **Report** -- Reviews are aggregated into a Markdown report with a per-file summary, severity-sorted findings, and a global verdict.

### What gets created

After the first run, your project will contain:

```
.anatoly/
  cache/
    progress.json    # Per-file review status (PENDING/DONE/CACHED/ERROR)
  tasks/
    <filename>.task.json  # Per-file review task files
  rag/               # LanceDB vector index + embeddings cache
  runs/
    2026-03-15_143022/
      report.md      # The audit report
      reviews/       # Per-file review JSON
      logs/          # Per-file agent transcripts
      anatoly.ndjson # Structured run log
      run-metrics.json # Timing, cost, and stats
```

The `.anatoly/` directory is fully local and safe to `.gitignore`. On subsequent runs, unchanged files (same SHA-256 hash) are skipped automatically.

### Subsequent runs

`anatoly run` is **always incremental** — only files whose content has changed since the previous run get re-reviewed. Use `--no-cache` to force a full re-review of the entire codebase.

```bash
anatoly run                       # Always incremental — only changed files
anatoly run --no-cache            # Force a full re-review of every file
anatoly run --file "src/core/**"  # Review only matching files
anatoly run --run-id v1.2         # Custom run ID instead of timestamp
```

## Verify it works

After the run completes, you will see output like:

```
review complete -- 42 files | 7 findings | 35 clean (12 skipped . 30 evaluated) | 4m 23s

  run          2026-03-15_143022
  report       .anatoly/runs/2026-03-15_143022/report.md
  reviews      .anatoly/runs/2026-03-15_143022/reviews/
  transcripts  .anatoly/runs/2026-03-15_143022/logs/
  log          .anatoly/runs/2026-03-15_143022/anatoly.ndjson
```

Open the report to see findings:

```bash
anatoly run --open    # Opens report in default app after generation
# or
cat .anatoly/runs/<run-id>/report.md
```

Exit codes:
- `0` -- All files are CLEAN
- `1` -- One or more findings reported
- `2` -- Fatal error (invalid configuration or runtime error)
