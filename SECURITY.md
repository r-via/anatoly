# Security Policy

Anatoly is an audit agent that reads source code and queries LLMs. This document
inventories every side effect Anatoly can produce, the conditions under which
each is triggered, and how to disable it. Nothing here runs implicitly: the
default `anatoly run` invocation never installs hooks, never starts a Docker
container, and never opens a network connection that is not listed below.

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Anatoly, please email
**remi.viau@gmail.com** with the subject `[anatoly-security]`. Do not open a
public GitHub issue. We aim to acknowledge reports within 72 hours and to
publish a fix or mitigation within 14 days for confirmed issues.

When reporting, include:

- The Anatoly version (`npx anatoly --version` or check `package.json`).
- A minimal reproduction or proof of concept.
- Your assessment of impact (confidentiality, integrity, availability).

## Outbound Network Endpoints

Anatoly never contacts an endpoint that is not listed below. Each row states
the trigger (when the call is made), whether it is mandatory for core
functionality, and how to disable it.

| Endpoint | Source file | Trigger | Mandatory? | How to disable |
|---|---|---|---|---|
| `api.anthropic.com` (and other LLM provider APIs via the AI SDK) | `src/core/providers/` | Every audit run that uses an Anthropic / OpenAI / Google model | Yes (this *is* the product) | Do not run `anatoly run` |
| `api.telegram.org/bot<TOKEN>/...` | `src/core/notifications/telegram.ts` | Notifications enabled in `.anatoly.yml` *and* `ANATOLY_TELEGRAM_BOT_TOKEN` set | No | Remove `notifications.telegram` block from `.anatoly.yml` or unset the env var |
| `api.exa.ai/search` | `src/core/tools/web-search.ts` | Web-search tool invoked by an axis prompt *and* `EXA_API_KEY` set | No | Do not set `EXA_API_KEY`; the web-search tool short-circuits when the key is absent |
| `huggingface.co` | `src/rag/gguf-prefetch.ts` | First run of `anatoly local-embeddings` (model download) | Only if local embeddings mode is selected | Stay on the default cloud-embeddings path |
| `raw.githubusercontent.com/BerriAI/litellm/.../model_prices_and_context_window.json` | `src/utils/pricing-cache.ts` | Pricing cache miss / refresh during `estimate` and `run` | No (cached after first fetch) | Pre-populate `~/.cache/anatoly/pricing.json` or run offline (Anatoly falls back to cached data) |
| `openrouter.ai/api/v1/models`, `openrouter.ai/api/v1/embeddings/models` | `src/utils/pricing-cache.ts` | Same as above | No | Same as above |

LLM provider endpoints depend on which provider the user configures. The list
above covers every direct `fetch(...)` call in the codebase outside of the AI
SDK packages. No analytics, no telemetry, no error reporter calls home.

### What is sent over the wire?

- **LLM APIs**: source-file content for files in scope of the audit, the axis
  prompts, and the agent's tool-call history. This is the same data flow as any
  other agentic coding tool.
- **Telegram**: only the audit summary that the user explicitly opted into. No
  source code is sent to Telegram.
- **Exa**: the search query string composed by the agent. No source code.
- **HuggingFace / pricing oracles**: read-only fetches of public files. Nothing
  about the user's repo is sent.

## Local Side Effects

| Path | Created by | Purpose | How to remove |
|---|---|---|---|
| `.anatoly/` | every `anatoly run` | Reviews, run logs, refinement cache, SHA cache, lock file | `rm -rf .anatoly/` |
| `.claude/settings.json` (anatoly hook block only) | `anatoly hook init` (explicit, opt-in) | PostToolUse / Stop hook registration | Remove the `anatoly` block from `.claude/settings.json` |
| Local embedding model cache | `anatoly local-embeddings upgrade` (opt-in) | GGUF / TEI model files | `rm -rf` the cache directory printed at install time |
| Docker containers prefixed `anatoly-` | GGUF / TEI Docker mode (opt-in) | Embedding inference | `docker rm -f $(docker ps -aq -f name=^anatoly-)` |

`anatoly hook init` refuses to overwrite an existing `.claude/settings.json`
hooks block: if one is present, the command prints the JSON snippet to stdout
for manual merge and exits without modifying the file (see
`src/commands/hook.ts`).

## Shell Execution

Anatoly invokes a small set of external binaries:

- **Read-only probes** (no state mutation): `docker info`, `nvidia-smi`,
  `rocm-smi`, `sysctl -n machdep.cpu.brand_string`. All gated by `timeout` and
  failure-tolerant.
- **Git read calls** (in `clean-run` and related commands): `git status`,
  `git rev-parse`, `git diff --name-only`, `git branch --show-current`.
- **Git write calls** (only in `anatoly clean run`, which is explicit and
  documented as a refactoring loop): `git stash`, `git checkout`,
  `git reset --hard <sha>` against branches Anatoly itself created. This
  command requires explicit invocation; it is never triggered by `run`.
- **Container management** (only in opt-in Docker embedding modes):
  `docker rm -f` scoped to containers Anatoly itself spawned (`anatoly-` name
  prefix), and `docker run` for those same containers.
- **Child `anatoly` processes**: spawned via `process.execPath` with
  `child.unref()` and a scoped env. Used for the hook integration and watch
  mode.

Anatoly never executes user-supplied code, never `eval`s LLM output, and never
runs build/test commands as part of an audit.

## Environment Variables

| Variable | Purpose | Required? |
|---|---|---|
| `ANTHROPIC_API_KEY` | Default LLM provider | Required for default config |
| `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY` | Gemini provider | Only if Gemini selected |
| `OPENAI_API_KEY` | OpenAI provider | Only if OpenAI selected |
| `EXA_API_KEY` | Web-search tool | Only if web-search axis enabled |
| `ANATOLY_TELEGRAM_BOT_TOKEN` | Telegram notifications | Only if notifications enabled |
| `ANATOLY_LOG_LEVEL` | Pino log level | No |
| `ANATOLY_PROJECT_ROOT` | Override project root for child processes | Set internally |
| `ANATOLY_HOOK_MODE` | Marks a child process as running inside a Claude Code hook | Set internally |
| `ANATOLY_BACKGROUND_MODE` | Marks a child process as the background half of a `run` | Set internally |

API keys are read from `process.env` only. Anatoly's config schema stores the
*name* of the env var (`bot_token_env: 'ANATOLY_TELEGRAM_BOT_TOKEN'`), not the
secret value. `.env`, `.anatoly.yml`, and `.anatoly*.yml` are gitignored by
default.

## Threat Model

In scope:

- A user runs Anatoly against a trusted local repo and untrusted dependencies.
- Anatoly should not exfiltrate code to endpoints not listed above.
- Anatoly should not modify the repo without explicit user action
  (`anatoly hook init`, `anatoly clean run`).

Out of scope:

- Malicious LLM provider returning crafted responses to escape Anatoly's tool
  sandbox. Anatoly does not execute tool calls beyond the read-only set
  documented above; LLM output is treated as data, never as code.
- Compromised npm registry serving a tampered Anatoly package. Anatoly users
  can mitigate by pinning the version (`npx @r-via/anatoly@<exact-version>`)
  rather than using the implicit `@latest`.
- Compromised LLM provider API keys. Anatoly does not handle key rotation; use
  short-lived keys or a secret manager where available.

## Disabling Anatoly Entirely

```bash
# 1. Remove all local state
rm -rf .anatoly/

# 2. Remove the hook block (if previously installed)
#    Edit .claude/settings.json and delete the "anatoly" entry under "hooks"

# 3. Uninstall the package (only if installed globally)
npm un -g @r-via/anatoly

# 4. Stop and remove any anatoly-* Docker containers
docker rm -f $(docker ps -aq -f name=^anatoly-) 2>/dev/null || true
```
