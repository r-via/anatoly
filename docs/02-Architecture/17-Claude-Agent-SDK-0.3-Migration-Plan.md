# 17. Claude Agent SDK 0.2 to 0.3 Migration Plan

Status: PREP DONE, BENCH PENDING. Gating decisions made (section 7).
Mechanical bump + revalidation complete on `orchestration-sink-convention`
(uncommitted). doc-16 re-bench is the only remaining owner-triggered gate
before merge.

Prep results:
- `package.json` -> `^0.3.144`; installed `0.3.144`; lockfile updated.
- Native per-platform binary resolved:
  `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`
  (matches the linux x64 / WSL bench VM target).
- Peer deps auto-installed: `@anthropic-ai/sdk@0.97.0`,
  `@modelcontextprotocol/sdk@1.29.0`. No explicit devDep add needed
  (typecheck clean without it; transport shields `usage` via `as unknown`).
- One source change forced by SDK type tightening: assistant content cast
  in `anthropic-transport.ts:36` now `as unknown as
  Array<Record<string, unknown>>` (matches the file's existing
  `usage` cast idiom). No other API surface change.
- typecheck clean; full suite 3078 pass / 0 fail; migration file
  lint-clean. (A pre-existing lint error in `calibrate-threshold.ts` is
  unrelated and out of scope.)

Decisions:
1. Pin: caret `^0.3.144` (keep existing convention).
2. `startup()`: out of scope here; separate follow-up. This migration is a
   pure version bump + revalidation.
3. Branch: stacked on `orchestration-sink-convention` (rides with the
   unpushed doc-16 commits).

## 1. Scope and goal

Move `@anthropic-ai/claude-agent-sdk` from `0.2.52` (pinned `^0.2.52`,
installed `0.2.52`) to the latest `0.3.144`. This is a deliberately scoped
project on its own branch with a full bench gate, per the standing rule that
the SDK is on the critical path of every LLM call and must not be bumped
unilaterally.

The jump spans ~90 published releases, but the vast majority are
"Updated to parity with Claude Code vX" patch bumps with no API surface
change. The actual review below is against anatoly's concrete usage, not the
raw release count.

## 2. anatoly's SDK usage surface (the only thing that can break)

Four non-test call sites, all using the same narrow surface:

| Site | Use |
|------|-----|
| `src/core/transports/anthropic-transport.ts` | primary: `query()`, message loop, cost/usage extraction |
| `src/commands/providers.ts` | provider reachability probe + `transport.query()` |
| `src/cli/pipeline-runner.ts` | `query()` with `allowedTools: []` |
| `src/core/documentation/generation/doc-llm-executor.ts` | `query()` with `allowedTools: ['Read','Write']` / `['Write']` |

Surface consumed:

- Function: `query({ prompt, options })`.
- Options: `systemPrompt`, `model`, `cwd`, `allowedTools`, `maxTurns`,
  `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions`,
  `abortController`, `persistSession`, `env`, `resume`.
- Types: `SDKMessage`, `SDKResultSuccess`, `SDKResultError`,
  `SDKAssistantMessage`, `SDKUserMessage`, `SDKSystemMessage`.
- Message iteration over `'assistant' | 'user' | 'system' | 'result' |
  'rate_limit_event'`; result subtypes `'success'` plus error subtypes;
  success fields `result`, `duration_ms`, `session_id`, `usage` (snake_case),
  `total_cost_usd`.

None of the above is removed, renamed, or signature-changed anywhere in
`0.2.53` through `0.3.144`.

## 3. Breaking changes reviewed against actual usage

| Release | Breaking change | Impact on anatoly |
|---------|-----------------|-------------------|
| 0.3.142 | v2 session API removed (`unstable_v2_*`, `SDKSession`) | None. anatoly uses `query()` only; no v2 API anywhere. |
| 0.3.142 | MCP servers connect in background by default | None. anatoly passes no `mcpServers` to `query()`. |
| 0.3.142 | Headless/SDK use Task tools instead of `TodoWrite` | None. anatoly never lists `TodoWrite` or `Skill` in `allowedTools`; single-turn passes `[]`, agentic passes small explicit lists (`Read/Grep/Glob/Bash/WebFetch/Write`). It does not consume a TodoWrite snapshot. |
| 0.3.143 | `@anthropic-ai/sdk` + `@modelcontextprotocol/sdk` moved to `peerDependencies` | Low. anatoly does not declare or import either directly (only `claude-agent-sdk` + `zod`). Bundled at runtime; npm 7+ auto-installs peers. See section 5 mitigation. |
| 0.2.113 | `options.env` replaces `process.env` (not overlay) | None. transport already spreads `...process.env` (anthropic-transport.ts:164). Already correct. |
| 0.2.113 | SDK spawns a native per-platform binary instead of bundled JS | HIGH RELEVANCE. See section 4 (doc-16 interaction). Not a code break, but changes packaging and the doc-16 abort fix surface. |
| 0.2.91 | `sandbox` defaults `failIfUnavailable: true` | None. anatoly passes no `sandbox` option. |

Net: zero source changes are forced by the API. zod is already `^4.3.6`,
satisfying the SDK's zod `^4` peer (since 0.1.71).

## 4. The doc-16 interaction (the real risk and the real opportunity)

The doc-16 work diagnosed the run's first SDK `query()` cold-stalling for
120s because the bundled `claude` CLI git-clones the official plugin
marketplace. Two mitigations are in tree:

1. transport `query()` sets `env: { ...process.env,
   CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }`.
2. VM-side git config (`url.insteadOf` https rewrite + `core.sshCommand`
   ConnectTimeout) defanging the clone regardless of env.

`0.2.113` changes the SDK to spawn a **native per-platform binary** (via a
platform optional dependency) rather than the bundled `cli.js`. Consequences
to validate in this migration, not assume:

- The env knobs are passed through the SDK `env` option, which still exists
  and still replaces `process.env`. They should still reach the subprocess,
  but the native binary's handling of
  `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` must be re-confirmed
  on the actual installed `0.3.144` build (read the resolved binary / docs),
  not inferred from the old `cli.js`.
- A platform optional dependency
  (`@anthropic-ai/claude-agent-sdk-<platform>`) must install on the bench
  VM and in CI. Any `npm ci --omit=optional` (or air-gapped install) would
  leave the SDK with no executable. Add an explicit post-install assertion.
- The 120s abort must be **re-benched**, not assumed fixed or broken. The
  packaging change could remove the bundled-JS clone path entirely or move
  it; only a clean-VM `anatoly run` proves behavior.

Opportunity: `0.2.89` adds `startup()` to pre-warm the CLI subprocess,
making the first `query()` ~20x faster. This is a structural fix for the
doc-16 cold-start (the first call wearing the bootstrap cost), independent
of the marketplace clone. Whether to fold `startup()` into this migration or
keep it as a separate change is an owner decision (section 7).

## 5. Migration steps (once gating decisions are made)

1. New branch off `main` (not off `orchestration-sink-convention`, which
   carries unpushed doc-16 work; keep the SDK bump isolated for a clean
   bench attribution).
2. `package.json`: bump `@anthropic-ai/claude-agent-sdk` to the chosen
   target (see 7.1). Run `npm install`, commit the lockfile.
3. Verify the platform optional dependency resolved
   (`npm ls @anthropic-ai/claude-agent-sdk` and confirm a
   `claude-agent-sdk-<platform>` entry / the resolved executable exists).
   Add a startup assertion or doctor check if absent.
4. Optional peer-dep hardening: if `tsc` resolves SDK-reexported types to
   `any`, add `@anthropic-ai/sdk` + `@modelcontextprotocol/sdk` as explicit
   `devDependencies` at the SDK's required ranges. The transport already
   casts `usage` via `as unknown`, so type erosion is largely shielded;
   confirm before adding.
5. `npm run typecheck` + `npm run lint` clean.
6. Full suite green (target parity with the doc-16 gate baseline,
   ~3070+ pass / 0 fail, goldens included). No real LLM calls in tests.
7. doc-16 re-bench on a clean bench VM: confirm `doc-conflict-update` does
   not 120s-abort and the run completes; capture F1 to confirm no
   regression versus the last recorded baseline.
8. If `startup()` is in scope (7.2): add a single pre-warm call before the
   first transport `query()` of a run, behind the existing transport, and
   re-bench cold-start latency.

## 6. Rollback

Single-commit bump + lockfile. Rollback = revert the branch / restore
`^0.2.52` and `npm install`. No data migration, no schema change, no
on-disk state format change. The risk is entirely runtime-behavioral
(subprocess spawn + cold-start), caught by the bench gate before merge.

## 7. Gating decisions for the owner

1. **Target pin.** anatoly currently uses a caret (`^0.2.52`). Options:
   pin exact `0.3.144` (reproducible bench, manual future bumps) versus
   `^0.3.144` (picks up parity patches automatically, less reproducible).
2. **`startup()` scope.** Fold the cold-start pre-warm into this migration
   (bigger but fixes doc-16's structural cold-stall properly) versus keep
   this migration a pure version bump and treat `startup()` as a separate
   follow-up.
3. **Branch base.** Confirm a fresh branch off `main` rather than stacking
   on `orchestration-sink-convention`.

No code is changed until these are answered.
