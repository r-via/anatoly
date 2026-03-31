# Transport Architecture

The transport layer routes all LLM calls (single-turn and agentic) to the appropriate backend based on provider and mode configuration. It owns concurrency control, circuit breaking, retry/backoff, and conversation dumping.

## Backends

Anatoly has four LLM backends, each implemented as a transport class:

| Backend | Class | SDK / Runtime | Use case |
|---------|-------|--------------|----------|
| **Anthropic Agent** | `AnthropicTransport` | `@anthropic-ai/claude-agent-sdk` (Claude Code subprocess) | Subscription-mode Anthropic calls |
| **Gemini Agent** | `GeminiTransport` | `@google/gemini-cli-core` (Gemini CLI stream) | Subscription-mode Google calls |
| **Vercel API via SDK** | `VercelSdkTransport` | Vercel AI SDK `generateText()` (HTTP API) | API-mode single-turn calls (any provider) |
| **Vercel Agent via SDK** | `VercelSdkTransport` | Vercel AI SDK `generateText()` + tools | API-mode agentic calls (any provider) |

`VercelSdkTransport` serves both API roles (single-turn and agentic) through separate methods.

## Dispatch Matrix

The `TransportRouter` dispatches every call based on two dimensions: **provider mode** (subscription vs api) and **task type** (single-turn vs agentic).

| Mode | Task | Provider | Backend | Method |
|------|------|----------|---------|--------|
| subscription | single-turn | anthropic | Anthropic Agent | `AnthropicTransport.query()` |
| subscription | agentic | anthropic | Anthropic Agent | `AnthropicTransport.agenticQuery()` |
| subscription | single-turn | google | Gemini Agent | `GeminiTransport.query()` |
| subscription | agentic | google | Gemini Agent | `GeminiTransport.agenticQuery()` |
| api | single-turn | *any* | Vercel API via SDK | `VercelSdkTransport.query()` |
| api | agentic | *any* | Vercel Agent via SDK | `VercelSdkTransport.agenticQuery()` |

### Mode Resolution

Provider mode is configured in `.anatoly.yml` with optional per-task overrides:

```yaml
providers:
  anthropic:
    mode: subscription        # base mode
    single_turn: subscription # override for axis evaluation (optional)
    agents: subscription      # override for agentic calls (optional)
  google:
    mode: api
```

Resolution order: `providers.<id>.agents` (for agentic) or `providers.<id>.single_turn` (for single-turn) > `providers.<id>.mode` > default `api`.

## Transport Interface

All transports implement `LlmTransport`:

```typescript
interface LlmTransport {
  readonly provider: string;
  supports(model: string): boolean;
  query(params: LlmRequest): Promise<LlmResponse>;
  agenticQuery?(params: AgenticRequest): Promise<LlmResponse>;
}
```

`agenticQuery` is optional — the router throws if a resolved transport doesn't support it.

`AgenticRequest` extends `LlmRequest` with:

```typescript
interface AgenticRequest extends LlmRequest {
  allowedTools: string[];     // e.g. ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch']
  maxTurns?: number;          // defaults to config.agents.max_turns (default: 30)
  config: Config;             // needed for model resolution and tool configuration
}
```

## Internal Conventions

Each transport follows the same internal pattern:

| Method | Role |
|--------|------|
| `query(params)` | Public single-turn entry point |
| `agenticQuery(params)` | Public agentic entry point |
| `_execute(params, opts)` | Private shared logic (SDK call, streaming, token counting, logging) |

- `AnthropicTransport._execute()` — wraps Claude SDK `query()` with configurable `allowedTools` and `maxTurns`
- `GeminiTransport._execute()` — wraps Gemini CLI `sendMessageStream()` (tools are future work, currently delegates to single-turn)
- `VercelSdkTransport` — `query()` uses `generateText()` directly; `agenticQuery()` delegates to `runVercelAgent()` which adds tool use

## TransportRouter

The router is a **dispatcher with built-in resilience**. It resolves the transport, manages concurrency, and delegates execution to the transport.

### Responsibilities

1. **Mode resolution** — `resolve(model, taskType)` returns the correct transport
2. **Concurrency** — per-provider `Semaphore` (configurable via `providers.<id>.concurrency`)
3. **Circuit breaking** — per-provider `CircuitBreaker` (trips after consecutive failures, auto-resets)
4. **Retry/backoff (agentic only)** — `agenticQuery()` wraps calls in `retryWithBackoff` (3 retries, 5s base, 60s max, jitter 0.2). Single-turn retry is managed by the caller (axis evaluator).

> **Retry contract:** `agenticQuery()` manages retry internally — callers MUST NOT add their own retry wrapper. For single-turn calls via `acquire()`, the caller is responsible for retry.

### Key Methods

```typescript
// Single-turn: caller manages slot
const { transport, release } = await router.acquire(model, 'single_turn');
try {
  const response = await transport.query(params);
  release({ success: true });
} catch {
  release({ success: false });
}

// Agentic: router manages slot + retry internally
const response = await router.agenticQuery(params);
```

`agenticQuery()` handles slot acquisition and release internally (including on retry) so callers don't need to manage it.

## Conversation Dumps

Every transport writes conversation transcripts to `<runDir>/conversations/` using shared helpers from `conversation-dump.ts`:

- `initConvDump()` — creates the file with header (model, provider, timestamp, system prompt, user message)
- `appendAssistant()` — appends assistant responses (streamed in real-time for Anthropic, post-hoc for Vercel)
- `appendResult()` — appends final metrics table (duration, cost, tokens, cache hit rate)
- `appendError()` — appends error details on failure

All three transports produce dumps in the same format. The only difference is granularity: Anthropic streams message-by-message; Gemini and Vercel write the complete response after it finishes.

## Configuration Reference

```yaml
providers:
  anthropic:
    mode: subscription         # 'subscription' | 'api'
    concurrency: 24            # max concurrent calls
    single_turn: subscription  # optional per-task override
    agents: subscription       # optional per-task override
  google:
    mode: api
    concurrency: 10

agents:
  enabled: true
  max_turns: 30                # max agentic turns (all providers)
```

## Who Uses What

| Caller | Task type | Tools |
|--------|-----------|-------|
| 7 axis evaluators | single-turn | none |
| Tier 3 refinement | agentic | Read, Grep, Glob, Bash, WebFetch |
| Doc generation | agentic | Read (via Claude SDK) |
| NLP summarization | single-turn | none |

## Source Files

| File | Role |
|------|------|
| `src/core/transports/index.ts` | `TransportRouter`, `LlmTransport`, `AgenticRequest` |
| `src/core/transports/anthropic-transport.ts` | Anthropic Agent (Claude SDK subprocess) |
| `src/core/transports/gemini-transport.ts` | Gemini Agent (gemini-cli-core) |
| `src/core/transports/vercel-sdk-transport.ts` | Vercel API + Vercel Agent (Vercel AI SDK) |
| `src/core/transports/conversation-dump.ts` | Shared conversation dump helpers |
| `src/core/agents/vercel-agent.ts` | `runVercelAgent()` — Vercel AI SDK with tools |
| `src/core/tools/bash-tool.ts` | Bash tool for Vercel agent |
| `src/core/tools/web-search.ts` | Web search tool for Vercel agent |

## Future Work

- **Gemini agentic tools** — `GeminiTransport.agenticQuery()` currently delegates to single-turn. When gemini-cli-core adds tool support, wire it in.
- **Custom Vercel tools** — Read, Grep, Glob as native Vercel AI SDK tools (currently available through bash equivalents). See `src/core/tools/`.
- **Sandboxed Bash** — allowlist mechanism for tier 3 to safely execute commands on audited projects.
