# Contributing to Anatoly

Thanks for considering a contribution. This document covers the practical
workflow; see [CLA.md](CLA.md) for the legal terms and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for behavioral expectations.

If you are reporting a security issue, please email **remi.viau@gmail.com**
with the subject `[anatoly-security]` rather than opening a public issue.

## Before You Start

- **Open an issue first** for non-trivial changes (new axis, new provider, new
  command, refactors that touch multiple modules). A short discussion saves
  rework.
- **Small, focused PRs land faster.** Prefer one PR per logical change over a
  bundle.
- **Anatoly is dual-licensed (AGPL-3.0 + commercial).** All contributors must
  agree to the [CLA](CLA.md). Opening a PR is the implicit agreement; we may
  ask you to confirm in a comment if the contribution is substantial.

## Local Setup

Requirements: Node `>=20.19`, npm 10+.

```bash
git clone https://github.com/r-via/anatoly.git
cd anatoly
npm ci
npm run build      # compiles TypeScript to dist/ via tsup
npm test           # runs vitest (~129 test files)
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

For day-to-day development, `npm run dev -- run` runs Anatoly directly from
`src/` via tsx, with no rebuild step.

## Branching and Commits

- Branch from `main`. Use a descriptive prefix:
  `feat/...`, `fix/...`, `chore/...`, `docs/...`, `refactor/...`, `test/...`.
- Keep commits scoped. A reviewer should be able to read the commit log and
  follow the reasoning.
- Commit messages follow the existing repo style: imperative subject, optional
  scope in parentheses, e.g. `feat(estimate): add --no-cache flag`. The
  `git log` of `main` is the authoritative reference.
- Do **not** add `Co-Authored-By` trailers for AI tooling; the commit log
  should reflect human authorship of the change.

## What Every PR Must Pass

Before requesting review, run locally and confirm green:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The CI workflow (`.github/workflows/ci.yml`) runs the same set on Node 20 and
22. PRs that fail CI will not be reviewed until they are green.

## Tests

- New behavior needs a test. Bug fixes need a regression test that fails
  against `main` and passes with the fix applied.
- Tests live next to the code (`*.test.ts`). vitest config is at
  [vitest.config.ts](vitest.config.ts).
- Avoid mocking the file system unless the test specifically targets a
  filesystem edge case; prefer fixtures under `tests/fixtures/` when
  available.
- Network calls in tests must be mocked. Anatoly tests never hit a real LLM
  endpoint.

## Code Style

- Strict TypeScript (`tsconfig.json`). No `any` without justification.
- ESLint config at [eslint.config.js](eslint.config.js). Fix lint errors;
  don't disable rules without an inline comment explaining why.
- Source files start with the SPDX header used elsewhere in the repo:
  `// SPDX-License-Identifier: AGPL-3.0-only`.
- Prefer pure functions in `src/utils/` and `src/core/`. Side effects belong
  in `src/commands/` and `src/cli/`.

## Architecture Cheatsheet

| Directory | Role |
|---|---|
| `src/cli/` | Top-level entry, prompts, pipeline runner |
| `src/commands/` | One file per `anatoly <command>` |
| `src/core/agents/` | Per-axis agent definitions |
| `src/core/axes/` | Axis schema and orchestration |
| `src/core/providers/` | Provider attribution and known-providers list |
| `src/core/refinement/` | Three-tier refinement loop |
| `src/core/notifications/` | Telegram (and future channels) |
| `src/core/tools/` | Web search and other agent tools |
| `src/core/transports/` | Wire transports for the agent |
| `src/prompts/` | Axis prompts and shared prompt fragments |
| `src/rag/` | LanceDB index, embeddings, hardware detection |
| `src/schemas/` | Zod schemas for config, state, reports |
| `src/utils/` | Generic helpers (no Anatoly-specific logic) |

When adding a new axis, follow the pattern of an existing one (e.g.
`correction`): prompt under `src/prompts/axes/`, agent definition under
`src/core/agents/`, schema entry in `src/schemas/`, and tests next to the
files you add.

## Security-Sensitive Changes

If your PR touches network calls, shell execution, hook installation, or
filesystem writes outside `.anatoly/`, call it out explicitly in the PR
description and tag a maintainer for review. Reviewers will block any PR
that adds an undocumented side effect.

## Reviewing Your Own PR

Before requesting review, scan the diff and ask:

- Does this introduce a new outbound network call, a new shell command, or a
  new filesystem write? If yes, document it in the PR description.
- Does it add a new dependency? If yes, justify it in the PR description.
- Does it change a default? If yes, call it out in the PR description.
- Does it touch the `.claude/settings.json` hook flow? If yes, manually verify
  the refusal-to-overwrite path still works.

## Releasing

Releases are cut by maintainers only. The flow is:

1. Bump `version` in `package.json`.
2. `npm run build && npm test && npm run lint && npm run typecheck`.
3. Tag (`git tag v0.x.y && git push --tags`) and publish.

Contributors do not need to bump versions in PRs.
