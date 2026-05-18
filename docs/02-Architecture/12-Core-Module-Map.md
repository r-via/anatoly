# Core Module Map (canonical reference)

> Status: this document is the **contract** for how `src/core` is partitioned
> into bounded contexts. Sections marked CONTRACT describe the intended
> invariant; sections marked REALITY describe what the tree looks like today
> (verified against source at HEAD `1c35d41`, branch `anatoly-self-audit`).
> Where they diverge, that divergence is the remediation backlog closed by
> [13-Core-Module-Remediation-Plan.md](./13-Core-Module-Remediation-Plan.md).
>
> **Remediation status (updated in lockstep).** PRs 1 to 7b plus the PR 8
> cleanup have landed. **The remediation is complete.**
> **The flat `src/core` root holds zero loose files** (PR 8 relocated the
> 10 supplementary/integration tests into the contexts they exercise; the
> root is now purely directories): all 60 modules are in a
> bounded context (`worktree/`, `reporting/`, `platform/`, `run/`,
> `scanning/`, the 4-sub-folder `documentation/`, and `evaluation/` with
> `axes/`+`refinement/` nested behind one barrel). Each landed with the
> grep gate, `tsc --noEmit`, and the full vitest suite (185 files, the
> doc 11 `spine-golden` included) green. PR 7b then split
> `axis-evaluator.ts` into `evaluation/contract.ts` (the published
> language: 10 types) + `evaluation/evaluator.ts` (impl: 9 functions),
> byte-identical bodies, and repointed the §4/§5 consumers
> (`docs-resolver`, `reporter`, `run-config`) at `evaluation/contract.js`:
> no peer context imports an evaluation implementation path. Seven trap
> classes surfaced across the sequence (git-mv staging, guard-path reads,
> vitest mock paths, mid-file inline `import()`,
> supplementary-tests-are-external, the barrel-cycle exception,
> `replace_all` over-reach into sandbox-fixture strings); all fixed in
> lockstep and the recipe / grep gate hardened (doc 13 §3 / §4 / §9).
>
> It is the structural sibling of [10-Orchestration-Runtime.md](./10-Orchestration-Runtime.md):
> doc 10 is the contract for the orchestration spine, this doc is the contract
> for the modules the spine composes. The orchestration reorg (doc 10 / 11) is
> the precedent this doc extends to the rest of `src/core`.
>
> Constraint set by the owner, verbatim in intent: *no debt is acceptable*.
> Every move that closes the gap below is behavior-preserving and test-gated,
> or it does not ship (see doc 13).

## 1. The decision

The domain **is** the pipeline. [01-Pipeline-Overview.md](./01-Pipeline-Overview.md)
defines the phase sequence (Scan, Triage, Usage Graph, Index, Review +
Deliberation, Internal Docs, Report, Badge). Every module under `src/core`
serves exactly one of those phases or is a primitive the phases share. The
bounded contexts below are those phases, named as directories. This is not a
new taxonomy invented for a refactor: it is the taxonomy the running pipeline
already follows, made explicit in the tree.

Three rules make the partition a contract rather than a folder convention:

1. **A directory is a bounded context.** Its public surface is its `index.ts`
   barrel. Intra-context modules import each other relatively; everything
   outside the context imports the barrel, never a module path inside it.
   (Existing precedent: `transports/index.ts`, `axes/index.ts`,
   `notifications/index.ts` already do exactly this.)
2. **Cross-context dependencies point at a contract, not an implementation.**
   The seam types live in a module the consumer can import without dragging in
   the producer's implementation. The primary application of this rule is the
   `axis-evaluator` split in §4.
3. **`orchestration/` is the only composition layer.** It may import any
   context barrel. No context barrel imports `orchestration/`. Dependencies
   flow phases -> contexts -> shared primitives, never sideways between peer
   contexts except through a §4 contract.

## 2. Diagnosis (grounded)

Verified at HEAD `1c35d41`, branch `anatoly-self-audit`.

| Fact | Measure |
|---|---|
| Source modules at `src/core` root | **60** (flat, one directory) |
| Colocated and cross-cutting test files at root | 64 |
| Subdirectories under `src/core` | 8 (`orchestration`, `axes`, `refinement`, `transports`, `providers`, `agents`, `tools`, `notifications`) |
| Subdirectories that follow the phase domain | 1 (`orchestration/`, landed doc 10 / 11) |
| Distinct bounded contexts living undifferentiated in the 60 flat modules | 7 |
| Highest fan-in flat module | `axis-evaluator` (6 core importers + 6 outside-core) and `language-detect` (7 + 5) |
| Path aliases in `tsconfig` | none (every import is a relative `./x.js`) |

In one sentence: the orchestration spine was given a home, the 60 modules it
orchestrates were not. Seven phase-aligned bounded contexts are interleaved in
a single flat directory, and the flatness hides two structural facts the
partition forces into the open: a de-facto shared kernel (§4) and the
peer-context coupling at the documentation / evaluation / scanning seams (§5).

## 3. The bounded-context inventory (CONTRACT)

Every one of the 60 root modules maps to exactly one context. `fan-in` is
`(core importers) + (outside-core non-test importers)` measured at HEAD; it is
the rewrite blast radius that orders the PR sequence in doc 13.

> Post-doc-13 addition: `harness/` is a new shared-kernel context (not one of
> the original 60 modules) introduced by
> [14-Orchestration-Sink-Convention.md](./14-Orchestration-Sink-Convention.md)
> PR 3a: the execution-unit SPI + `runUnit`, depending on nothing in `core/`
> (fan-out zero, fan-in many). See doc 14 §4 for the cycle rationale.

### 3.1 `documentation/` (24 modules, four sub-contexts)

The largest context by far (40% of the flat root). It has real internal
structure, confirmed by the dependency graph, so it nests:

| Sub-context | Modules |
|---|---|
| `documentation/generation/` | `doc-bootstrap`, `doc-pipeline`, `doc-generator`, `doc-scaffolder`, `doc-llm-executor`, `doc-type-context` |
| `documentation/conflict/` | `doc-conflict-detector`, `doc-conflict-llm`, `doc-conflict-store`, `doc-coherence-3way`, `doc-stale-reference` |
| `documentation/reporting/` | `doc-report-aggregator`, `doc-report-section`, `doc-scoring`, `doc-recommendations`, `doc-sync`, `doc-gap-detection`, `user-doc-plan` |
| `documentation/resolution/` | `docs-resolver`, `reference-docs-resolver`, `doc-mapping`, `doc-cache`, `docs-guard`, `documentation-config` |

Cross-context out-edges (handled per rule 2 / §5): `docs-resolver` ->
evaluation contract, `reference-docs-resolver` -> scanning, `doc-pipeline` ->
scanning (`language-detect`).

### 3.2 `evaluation/` (6 modules + two nested existing sub-contexts)

The Review + Deliberation phase.

| Module | fan-in | Note |
|---|---|---|
| `axis-evaluator` | 6 + 6 | the shared kernel, split per §4 |
| `axis-merger` | 1 + 0 | |
| `file-evaluator` | 0 + 2 | per-file driver |
| `deliberation` | 0 + 0 | |
| `triage` | 0 + 1 | |
| `calibration` | 1 + 1 | no colocated test (§7) |

Existing cohesive subdirs `axes/` (7 outside importers) and `refinement/` (2)
are sub-domains of this context and nest as `evaluation/axes/` and
`evaluation/refinement/`.

### 3.3 `scanning/` (10 modules)

The Scan / Usage Graph phases: static project analysis, zero LLM cost. It is a
pure sink (no cross-context out-edges) but contains the two heaviest shared
nodes after `axis-evaluator`.

`scanner`, `scan-autodetect`, `language-detect` (fan-in 7 + 5),
`language-adapters`, `usage-graph`, `dependency-meta`, `module-granularity`,
`source-context`, `project-tree`, `project-version`.

### 3.4 `run/` (7 modules)

Run lifecycle, configuration, resumability state (distinct from
`orchestration/`, which sequences; this context holds the state being
sequenced).

`run-config`, `run-status`, `background-runner`, `progress-manager`,
`estimator`, `project-review-cache`, `ndjson-tail`. Cross-context out-edge:
`run-config` -> evaluation contract.

### 3.5 `reporting/` (3 modules)

The Report / Badge phases (audit output, distinct from `documentation/reporting`,
which scores docs).

`reporter` (fan-in 1 + 6), `review-writer`, `badge`. Cross-context out-edges:
`reporter` -> evaluation contract, `reporter` -> `documentation` (`doc-stale-reference`).

### 3.6 `worktree/` (3 modules)

Git worktree isolation. The smallest and most cohesive context, zero
cross-context coupling.

`worktree-manager`, `worktree-cleanup`, `worktree-path-resolution`.

### 3.7 `platform/` (7 modules)

Shared primitives the phases consume: concurrency / resilience and LLM-call
support. Pure leaf (no cross-context out-edges).

Concurrency: `sdk-semaphore`, `worker-pool`, `circuit-breaker`.
LLM support: `prompt-resolver` (fan-in 4 + 3), `default-models`,
`grammar-manager`, `correction-memory`.

### 3.8 Unchanged existing subdirs

`transports/`, `providers/`, `agents/`, `tools/`, `notifications/` are already
non-flat, cohesive, and (the first three) barrel-fronted. They are already
bounded; renesting them is churn with no DDD gain, so the contract leaves them
at their current path. `orchestration/` is the composition layer (rule 3) and
is unchanged (doc 10 / 11).

## 4. The shared kernel: `axis-evaluator`

`axis-evaluator` has 6 core importers plus 6 outside-core importers spanning
four other contexts (`documentation` via `docs-resolver`, `run` via
`run-config`, `reporting` via `reporter`, `scanning` via `triage`). Flat, this
reads as one hot module. Partitioned, it is a **published language**: those
importers do not need the evaluator implementation, they need the contract
(`AxisId`, the `AxisEvaluator` interface, `AxisContext`).

LANDED (doc 13 PR 7b): `axis-evaluator.ts` was split into

- `evaluation/contract.ts`: types and the `AxisEvaluator` interface only. Any
  context may import this. It is the seam every cross-context edge in §5
  points at.
- `evaluation/evaluator.ts`: the implementation. Imported only inside
  `evaluation/` and re-exported from `evaluation/index.ts`.

This was the one change in the whole remediation that was not a pure move
(doc 13 gated it separately per §6: tsc + full suite + a public-API snapshot
proven name-and-type identical to the pre-split exports + byte-identical
symbol bodies, the way doc 11 PR 8c gated the handoff inversion). The flat
layout did not make this split optional, it made it invisible.

## 5. Peer-context coupling (CONTRACT)

These out-edges cross context boundaries. Each is legal **only** through a
contract or a barrel, never an implementation path:

| From | To | Resolved by |
|---|---|---|
| `documentation/resolution/docs-resolver` | evaluation | imports `evaluation/contract.ts` (§4) |
| `documentation/resolution/reference-docs-resolver` | scanning | imports `scanning/index.ts` |
| `documentation/generation/doc-pipeline` | scanning | imports `scanning/index.ts` |
| `reporting/reporter` | evaluation | imports `evaluation/contract.ts` (§4) |
| `reporting/reporter` | documentation | imports `documentation/index.ts` |
| `run/run-config` | evaluation | imports `evaluation/contract.ts` (§4) |
| `evaluation/file-evaluator` | documentation | imports `documentation/index.ts` |
| `evaluation/axes/internal-docs-context` | run | imports the `run/run-config.js` **leaf**, not the `run/` barrel (barrel-cycle exception, see below) |
| `documentation/resolution/docs-resolver`, `reporting/reporter`, `run/run-config` | evaluation | **Resolved (PR 7b):** import `evaluation/contract.js` (the §4 published language), never the implementation or the eager `evaluation/` barrel. History: PR 7 routed these at the `evaluation/axis-evaluator` leaf because the barrel eagerly constructs every axis evaluator at load and re-enters mid-init via `file-evaluator -> documentation/index.js -> docs-resolver` (`ALL_AXIS_IDS` undefined); PR 7b split the leaf into `contract.ts` (types) + `evaluator.ts` (impl) so the contract carries no runtime, dissolving the cycle. `run/estimator` separately imports `evaluation/axes/index.js` + `evaluation/calibration.js` (axis-list / calibration, not the axis-evaluator contract) |

`evaluation/file-evaluator -> documentation` and
`documentation -> evaluation/contract` is not an import cycle (the second edge
lands on the contract, not the evaluator), and §4 is precisely what keeps it
that way. The composition layer (`orchestration/`) already imports 13 of these
root modules directly; post-remediation it imports the owning context barrels
instead (doc 13 §7).

**Barrel-cycle exception.** A context barrel re-exports every module in the
context, so importing the barrel eagerly loads them all. When a barrel
re-exports a module that still carries a *transitional* cross-context
back-edge (a `<m> -> ../<other-context>` import that exists only until the
other context lands and the edge becomes `<m> -> contract`), a peer-context
module that imports that barrel **during eager module-initialization** can
close a real import cycle. PR 4 hit this: `run/index.ts` re-exports
`estimator`, which transitionally imports `../axes/index.js` for
`ALL_AXIS_IDS`; `axes/index.ts` eagerly constructs every evaluator at load,
and `axes/axes/...` evaluators import `internal-docs-context`, so
`internal-docs-context -> run/index.js` re-entered `axes/index.ts`
mid-construction (`CorrectionEvaluator is not a constructor`). The rule: such
an edge points at the **leaf module** inside the target context, not the
barrel, until the transitional back-edge is removed (here: PR 7, when
`estimator -> ../axes/index.js` becomes `estimator -> evaluation/contract`).
This is the same principle as rule 2 (cross-context edges target a contract,
not an implementation), applied to break an eager-init cycle.

## 6. Target tree (CONTRACT)

```
src/core/
  documentation/
    index.ts                 published surface
    generation/    { doc-bootstrap, doc-pipeline, doc-generator,
                     doc-scaffolder, doc-llm-executor, doc-type-context }
    conflict/      { doc-conflict-detector, doc-conflict-llm,
                     doc-conflict-store, doc-coherence-3way,
                     doc-stale-reference }
    reporting/     { doc-report-aggregator, doc-report-section, doc-scoring,
                     doc-recommendations, doc-sync, doc-gap-detection,
                     user-doc-plan }
    resolution/    { docs-resolver, reference-docs-resolver, doc-mapping,
                     doc-cache, docs-guard, documentation-config }
  evaluation/
    index.ts
    contract.ts              §4 published language (was axis-evaluator types)
    evaluator.ts             §4 implementation (was axis-evaluator impl)
    { axis-merger, file-evaluator, deliberation, triage, calibration }
    axes/                    (existing, nested here)
    refinement/              (existing, nested here)
  scanning/
    index.ts
    { scanner, scan-autodetect, language-detect, language-adapters,
      usage-graph, dependency-meta, module-granularity, source-context,
      project-tree, project-version }
  run/
    index.ts
    { run-config, run-status, background-runner, progress-manager,
      estimator, project-review-cache, ndjson-tail }
  reporting/
    index.ts
    { reporter, review-writer, badge }
  worktree/
    index.ts
    { worktree-manager, worktree-cleanup, worktree-path-resolution }
  platform/
    index.ts
    { sdk-semaphore, worker-pool, circuit-breaker, prompt-resolver,
      default-models, grammar-manager, correction-memory }
  orchestration/             composition layer (doc 10 / 11, unchanged)
  transports/  providers/  agents/  tools/  notifications/   (unchanged, already bounded)
```

## 7. Scorecard

Mirrors doc 10 §7. ✅ holds today, ❌ diverges, the gap is doc 13's backlog.

| Invariant | Status |
|---|---|
| Orchestration spine has a phase-aligned home | ✅ (doc 10 / 11) |
| The 60 modules it composes have phase-aligned homes | ✅ 60/60 (doc 13 PRs 1 to 7): the flat `src/core` root holds zero `.ts` modules; every one is in a bounded context. PR 7b is the contract/impl split, not a move |
| Every cross-context edge points at a barrel or §4 contract | ✅ all via barrels; the §5 evaluation consumers (`docs-resolver`, `reporter`, `run-config`) import `evaluation/contract.js` (doc 13 PR 7b) |
| `axis-evaluator` is split contract / impl | ✅ `evaluation/contract.ts` (types) + `evaluation/evaluator.ts` (impl), byte-identical bodies, public API identical (doc 13 PR 7b) |
| Each context exposes one `index.ts` barrel | ✅ every bounded context (`transports`, `axes`, `notifications`, `worktree`, `reporting`, `platform`, `run`, `scanning`, `documentation` [4 sub-folders, one barrel], `evaluation` [`axes/`+`refinement/` nested, one barrel]) |
| No peer-context import of an implementation path | ✅ closed by doc 13 PR 7b: the §5 evaluation consumers import `evaluation/contract.js`, never an implementation module |
| 60 modules each have a colocated test | ❌ 6 lack one: `calibration`, `default-models`, `correction-memory`, `doc-type-context`, `doc-gap-detection`, `documentation-config` (noted, not in scope for doc 13) |

## See also

- [13-Core-Module-Remediation-Plan.md](./13-Core-Module-Remediation-Plan.md):
  the execution contract that closes the §7 gap.
- [10-Orchestration-Runtime.md](./10-Orchestration-Runtime.md) and
  [11-Orchestration-Remediation-Plan.md](./11-Orchestration-Remediation-Plan.md):
  the precedent. This doc is to the composed modules what doc 10 is to the
  spine.
- [01-Pipeline-Overview.md](./01-Pipeline-Overview.md): the phase sequence the
  bounded contexts mirror.
