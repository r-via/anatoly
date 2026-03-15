# CI/CD Integration

Anatoly is designed to run in automated pipelines. It supports non-interactive execution, deterministic exit codes, and plain-text output for log-friendly environments.

## Table of Contents

- [Quick Start](#quick-start)
- [Exit Codes](#exit-codes)
- [CLI Flags for CI](#cli-flags-for-ci)
- [GitHub Actions Example](#github-actions-example)
- [Parsing Reports](#parsing-reports)
- [Recommended Configuration](#recommended-configuration)
- [Caching Between Runs](#caching-between-runs)
- [Cost Control](#cost-control)

---

## Quick Start

```bash
npx anatoly run --plain
```

The `--plain` flag suppresses color codes and spinners for clean log output.

## Exit Codes

Anatoly uses structured exit codes so your CI pipeline can distinguish between outcomes:

| Exit Code | Meaning | CI Action |
|-----------|---------|-----------|
| `0` | Audit completed, no significant findings | Pass the build |
| `1` | Audit completed, findings detected | Fail the build or flag for review |
| `2` | Runtime error (config issue, API failure, etc.) | Investigate and retry |

Use these codes in your pipeline logic:

```bash
npx anatoly run --plain
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "Audit passed"
elif [ $EXIT_CODE -eq 1 ]; then
  echo "Audit found issues -- see report"
  # Optionally: post comment, upload artifact, etc.
elif [ $EXIT_CODE -eq 2 ]; then
  echo "Audit failed to run"
  exit 1
fi
```

## CLI Flags for CI

| Flag | Description |
|------|-------------|
| `--plain` | Disable colors and animated spinners |
| `--config <path>` | Specify a custom `.anatoly.yml` path |
| `--run-id <id>` | Set a deterministic run ID (default: timestamp-based) |
| `--no-rag` | Skip RAG indexing to reduce runtime and resource usage |
| `--file <path>` | Review a single file instead of the full project |

## GitHub Actions Example

```yaml
name: Anatoly Audit

on:
  pull_request:
    branches: [main]
    paths:
      - 'src/**/*.ts'
      - 'src/**/*.tsx'

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - run: npm ci

      - name: Run Anatoly audit
        run: npx anatoly run --plain
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: anatoly-report
          path: .anatoly/runs/*/report.md
```

**Notes:**

- The `ANTHROPIC_API_KEY` environment variable must be set. Store it as a repository secret.
- The `paths` filter ensures the workflow only runs when TypeScript source files change.
- The `timeout-minutes` value depends on project size. A 100-file project typically completes in 10--15 minutes.
- The report is uploaded as an artifact regardless of exit code (`if: always()`), so you can inspect findings even if the job fails.

### Posting Findings as PR Comments

You can extend the workflow to post a summary as a PR comment:

```yaml
      - name: Post findings comment
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = fs.readFileSync('.anatoly/report.md', 'utf-8');
            // Truncate to fit GitHub comment limits
            const body = report.length > 60000
              ? report.slice(0, 60000) + '\n\n... (truncated)'
              : report;
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `## Anatoly Audit Report\n\n${body}`
            });
```

## Parsing Reports

Anatoly writes structured output to the `.anatoly/` directory:

| Path | Format | Description |
|------|--------|-------------|
| `.anatoly/report.md` | Markdown | Human-readable summary with tables and action items |
| `.anatoly/reviews/<file>.rev.json` | JSON | Per-file review with symbol-level findings |
| `.anatoly/cache/progress.json` | JSON | Progress tracker with per-file status |

The `.rev.json` files contain machine-readable data suitable for custom tooling:

```json
{
  "file": "src/utils/cache.ts",
  "verdict": "NEEDS_REFACTOR",
  "symbols": [
    {
      "name": "computeFileHash",
      "line_start": 12,
      "line_end": 18,
      "correction": "OK",
      "utility": "USED",
      "duplication": "UNIQUE",
      "overengineering": "OK",
      "confidence": 85,
      "detail": "..."
    }
  ]
}
```

You can use `jq` to extract findings programmatically:

```bash
# List all files with NEEDS_WORK verdict
jq -r 'select(.verdict == "NEEDS_REFACTOR") | .file' .anatoly/reviews/*.rev.json

# Count findings above 80% confidence
jq '[.symbols[] | select(.confidence >= 80 and .correction != "OK")] | length' .anatoly/reviews/*.rev.json
```

## Recommended Configuration

Create a `.anatoly.yml` tuned for CI:

```yaml
llm:
  min_confidence: 80       # Higher threshold reduces noise in CI
  concurrency: 4           # Match available CPU cores
  max_retries: 3           # Retry on transient API errors
  deliberation: false      # Disable Opus deliberation pass to save cost/time

scan:
  include:
    - 'src/**/*.ts'
    - 'src/**/*.tsx'
  exclude:
    - 'node_modules/**'
    - 'dist/**'
    - '**/*.test.ts'
    - '**/*.spec.ts'
```

For pull request workflows, consider raising `min_confidence` to 80 or higher to reduce noise and focus on high-certainty findings.

## Caching Between Runs

Anatoly uses SHA-256 hashes to skip files that have not changed since their last review. To take advantage of this across CI runs, cache the `.anatoly/` directory:

```yaml
      - uses: actions/cache@v4
        with:
          path: .anatoly
          key: anatoly-${{ runner.os }}-${{ hashFiles('src/**/*.ts', 'src/**/*.tsx') }}
          restore-keys: |
            anatoly-${{ runner.os }}-
```

This can significantly reduce runtime and API costs on incremental changes.

## Cost Control

Every review file sends symbols to the Claude API, so large projects can incur meaningful costs. Strategies to manage this in CI:

- **Run `anatoly estimate` first** to preview token usage without making API calls.
- **Use `--no-rag`** to skip the RAG indexing step if semantic duplication detection is not needed.
- **Raise `min_confidence`** to filter low-certainty findings and reduce the number of review cycles.
- **Cache aggressively** so only changed files are re-reviewed on each CI run.
- **Limit scope with `--file`** to review only files changed in the current PR (combine with `git diff --name-only`).

```bash
# Review only files changed in the PR
git diff --name-only origin/main...HEAD -- '*.ts' '*.tsx' | while read f; do
  npx anatoly review --file "$f" --no-cache
done
npx anatoly report --plain
```
