# Core Module Remediation Plan (execution contract)

> Status: this document is the **execution contract** for closing the gap that
> [12-Core-Module-Map.md](./12-Core-Module-Map.md) documents. Doc 12 decides
> the target partition; this document decides **how it is reached and in what
> order**. It is binding: once a PR below lands, the corresponding line in doc
> 12 §7 must be updated in the same PR, never after. It is the structural twin
> of [11-Orchestration-Remediation-Plan.md](./11-Orchestration-Remediation-Plan.md)
> and follows its proven shape (grounded diagnosis, ascending-risk PR
> sequence, per-PR gate, testable acceptance invariants).
>
> Constraint set by the owner, verbatim in intent: *no debt is acceptable*.
> Every step here is behavior-preserving by construction and test-gated, or it
> does not ship.

## 1. The decision

Two paths were on the table.

- **Big-bang.** One PR moves all 60 modules, rewrites every import, adds every
  barrel. Smallest total churn, but it is one unreviewable diff with no
  intermediate green state. Under a zero-debt constraint this is the wrong
  trade: a single irreversible step with no bisection point.
- **Incremental, one bounded context per PR, by ascending blast radius.** Each
  PR is independently revertible with one `git revert`, ends green, and proves
  the mechanical recipe on a low-risk context before it is applied to the
  high-fan-in ones.

**Incremental is chosen**, mirroring doc 11's per-phase sequence. The recipe
is validated on `worktree/` (max fan-in 1) before it touches `language-detect`
(fan-in 12) or the `axis-evaluator` split.

## 2. Diagnosis (grounded)

Verified at HEAD `1c35d41`, branch `anatoly-self-audit`.

| Fact | Measure |
|---|---|
| Source modules at `src/core` root | 60 |
| Bounded contexts to carve | 7 (doc 12 §3), plus the §4 contract split |
| `tsconfig` path aliases | none: every import is a relative `./x.js`, so a move rewrites the moved file **and** every importer |
| Outside-core importers of `core/*` (non-test) | 30 files (16 `commands`, 5 `rag`, 4 `utils`, 4 `cli`, 1 `schemas`) |
| Composition-layer edges (`orchestration/` -> core root modules) | 13 direct imports, become barrel imports post-remediation |
| Docs hardcoding `src/core/<module>` paths | 18 files (§7) |

In one sentence: the partition in doc 12 is mechanically simple (move +
rewrite + barrel) but wide (no aliases means the blast radius is every
importer), so the only real risk is a silent logic edit smuggled into a move,
and the entire plan is built to make that impossible to hide.

## 3. The safety net

Doc 11's blocking prerequisite was that the net did not exist (no orchestration
golden). Here it is the opposite: a pure relocation cannot change behavior, so
the net is already complete and consists of three independent gates:

1. **TypeScript.** `tsc --noEmit` resolves every relative import. A missed or
   wrong path rewrite fails the build. This catches the entire class of
   move-mechanics errors.
2. **The existing test suite.** Full `vitest` green. A module move that altered
   behavior (it cannot, if the diff is move-only) would fail a colocated or
   integration test. The 6 untested modules (doc 12 §7) are out of scope and
   are moved, not modified, so their lack of a test does not weaken the gate.
3. **The grep gate.** After each PR,
   `grep -rn "from '[^']*core/<moved-module>\.js'" src --include=*.ts`
   returns matches only at the module's new home's importers (all rewritten),
   never the old flat path. Zero stale paths is a hard gate.

The prerequisite here is not building a net, it is **doc 12 being ratified**:
the barrel convention and the §4 split shape every PR, so the contract lands
first (this pair of docs), then PR 1.

## 4. The move recipe (every PR follows it verbatim)

1. `git mv src/core/<m>.ts src/core/<context>/<m>.ts` and the same for
   `<m>.test.ts` (the colocated test moves with its module, always).
2. Rewrite relative import depth **inside** the moved files (`../foo.js`
   depth changes by the nesting delta).
3. Rewrite every importer's path: intra-context importers to the new relative
   path, every out-of-context importer to the context barrel
   `<context>/index.js` (or `evaluation/contract.js` for the §4 seam).
4. Create or extend `<context>/index.ts` to re-export the context's public
   surface (the symbols its current external importers use, no more: no
   speculative exports).
5. Gate (§6). The diff is git-mv + import-path rewrites + barrel only.
   Reviewer attests no logic delta; the three §3 gates enforce it mechanically.

No logic change, no rename, no signature change, no behavior change is
permitted inside a move PR. That is the entire contract.

## 5. PR sequence (ascending blast radius)

Order chosen so the recipe is proven on the smallest, edge-free context first
and the shared kernel is last, exactly as doc 11 extracted the hot path last.

| PR | Context | Modules | Max fan-in | Why this slot |
|----|---------|---------|-----------|---------------|
| 1 | `worktree/` | 3 | 1 | leaf, zero cross-context edges: proves the recipe |
| 2 | `reporting/` | 3 | 7 (`reporter`) | first context with cross-context out-edges (to evaluation §4, documentation): proves rule 2 / barrel imports on a 3-module surface |
| 3 | `platform/` | 7 | 7 (`prompt-resolver`) | pure leaf primitives, no out-edges, but high fan-in: proves a wide rewrite at near-zero logic risk |
| 4 | `run/` | 7 | 6 (`estimator`) | one out-edge (`run-config` -> evaluation contract) |
| 5 | `scanning/` | 10 | 12 (`language-detect`) | highest rewrite count, still a pure sink (no out-edges): logic risk stays low while blast radius peaks |
| 6a | `documentation/generation/` | 6 | moderate | `doc-pipeline` -> scanning barrel (now exists, PR 5) |
| 6b | `documentation/conflict/` | 5 | moderate | internal-heavy, isolated |
| 6c | `documentation/reporting/` | 7 | moderate | internal-heavy, isolated |
| 6d | `documentation/resolution/` | 6 | moderate | last in the context: carries the two out-edges (`docs-resolver` -> evaluation contract, `reference-docs-resolver` -> scanning) |
| 7 | `evaluation/` move-only | 6 + nest `axes/`, `refinement/` | 12 (`axis-evaluator`) | the shared kernel: every other context's barrel exists by now |
| 7b | `axis-evaluator` contract / impl split | 1 -> 2 files | 12 | the single non-move-only change, gated separately (see §6) |

Rationale for 6a to 6d before 7: `documentation` imports the evaluation
**contract** (§4), which only exists after 7b. To keep every PR green,
`documentation`'s out-edge to evaluation targets the pre-split
`evaluation/index.ts` re-export during 6d, then is repointed to
`evaluation/contract.js` as the final step of 7b (a one-line import change,
golden-gated like the rest).

## 6. Acceptance gate

**Per move PR (1 to 7):** `tsc --noEmit` clean; full `vitest` suite green; the
§3 grep gate returns zero stale paths for every module the PR moved; the diff
contains no hunk that is not a `git mv`, an import-path rewrite, or a barrel
re-export (reviewer-attested, mechanically consistent with the three gates);
doc 12 §7 updated in the same PR for the rows the PR closes.

**PR 7b (the only non-move-only change):** gated like doc 11 PR 8c. In
addition to the above: a public-API assertion that the symbols re-exported
from `evaluation/index.ts` and `evaluation/contract.ts` are identical in name
and type to the pre-split `axis-evaluator` exports (a typecheck-level snapshot,
not a behavior test, because there is no behavior to test: the split is
file-level only). Reviewer attests the `.ts` body of every moved symbol is
byte-identical across the split.

## 7. Effect on docs (lockstep)

Strategy mirrors doc 11 §7: each PR updates docs in lockstep, never after.

- **Doc 12 §7 scorecard.** Each PR flips its rows from ❌ to ✅ with the PR
  reference.
- **18 docs hardcode `src/core/<module>` paths** and must be updated in the PR
  that moves the referenced module: `docs/01-Getting-Started/02-Configuration.md`,
  `docs/02-Architecture/03-Data-Flow.md`, `docs/02-Architecture/04-Usage-Graph.md`,
  `docs/02-Architecture/10-Orchestration-Runtime.md`,
  `docs/03-CLI-Reference/01-Commands.md`, `docs/03-CLI-Reference/03-Output-Formats.md`,
  `docs/03-Guides/02-Advanced-Configuration.md`,
  `docs/04-Core-Modules/01-Scanner.md` through `06-Worker-Pool.md`,
  `docs/05-Integration/03-Watch-Mode.md`, `docs/06-Development/01-Contributing.md`,
  `docs/06-Development/02-Testing.md`,
  `docs/07-Design-Decisions/02-Evidence-Based-Approach.md`,
  `docs/07-Design-Decisions/03-Cost-Optimization.md`. The
  `docs/04-Core-Modules/` set is the densest: Scanner (PR 5), Estimator (PR 4),
  Triage (PR 7), Axis-Evaluators (PR 7 / 7b), Reporter (PR 2), Worker-Pool
  (PR 3).
- **Doc 10 / 11 cross-reference.** When PR 1 lands, add a one-line "See also"
  from doc 10 and doc 11 to doc 12 / 13 (the reciprocal of the links those
  docs already receive here). This is the only edit this plan makes to the
  binding orchestration docs, and it is additive.

## 8. Non-goals

Zero debt means no behavior change smuggled into a structural move, and no
scope creep.

- **No logic change of any kind** inside a move PR. Phase order, gates, models,
  costs, outputs, signatures, behavior: untouched. PR 7b is file-level split
  only, with byte-identical symbol bodies.
- **`src/utils` (61 flat), `src/commands` (37), `src/rag` (33) are out of
  scope.** The owner scoped this to `src/core`. They are noted, not planned.
- **No barrel beyond the public surface.** `index.ts` re-exports exactly the
  symbols current external importers use. No speculative API.
- **No fix for the 6 untested modules** (doc 12 §7). They are moved as-is;
  adding tests is a separate, post-remediation effort.
- **`transports/`, `providers/`, `agents/`, `tools/`, `notifications/` are not
  renested.** They are already bounded (doc 12 §3.8).

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| No path aliases: a rewrite misses an importer | `tsc --noEmit` fails on any unresolved import; the §3 grep gate fails on any surviving old path. Both are hard gates, not review-dependent |
| A logic edit hides in a large move diff (`scanning/` PR 5 touches the most files) | Move-only constraint, reviewer attestation, and the full suite green. A behavior change in a moved module fails its colocated or an integration test |
| `documentation` -> evaluation out-edge has no contract to point at until 7b | §5 sequencing: 6d targets the pre-split `evaluation/index.ts` re-export, repointed to `contract.js` as the last step of 7b (one-line, gated) |
| The §4 split silently drops or retypes an exported symbol | PR 7b public-API typecheck snapshot: re-exported symbols identical in name and type to pre-split; byte-identical bodies, reviewer-attested |
| A revert is needed mid-sequence | Every PR is one `git mv` set plus rewrites, independently `git revert`-able, each ending green. No data or schema migration in any PR |

## 10. Plan acceptance invariants

Testable assertions, written (doc 11 §10 style) so they fail today and pass
only when the plan holds.

1. After PR 1: `find src/core -maxdepth 1 -name 'worktree-*.ts'` returns
   nothing; `src/core/worktree/` exists with the 3 modules and their tests;
   full suite green.
2. For every PR 1 to 7:
   `grep -rn "from '[^']*core/<moved>\.js'" src --include=*.ts` returns no
   match at the old flat path for any module that PR moved; `tsc --noEmit`
   and the full suite are green.
3. For every move PR: the diff contains only `git mv` renames, import-path
   rewrites, and barrel re-exports (no other hunk), and doc 12 §7 is updated
   in the same PR.
4. After PR 7b: `src/core/axis-evaluator.ts` does not exist;
   `evaluation/contract.ts` and `evaluation/evaluator.ts` do; the symbols
   re-exported from `evaluation/index.ts` are name-and-type identical to the
   pre-split `axis-evaluator` exports; no peer context imports an evaluation
   implementation path (only `evaluation/contract.js` or
   `evaluation/index.js`).
5. After the final PR:
   `find src/core -maxdepth 1 -name '*.ts' -not -name '*.test.ts' | wc -l`
   is 0 (every root module now lives in a bounded context), and doc 12 §7 has
   no ❌ row except the explicitly out-of-scope untested-modules row.

## See also

- [12-Core-Module-Map.md](./12-Core-Module-Map.md): the contract this plan
  closes. Read its §4 (shared kernel) and §7 (scorecard) alongside this
  document's §5 and §10.
- [11-Orchestration-Remediation-Plan.md](./11-Orchestration-Remediation-Plan.md):
  the precedent. This plan reuses its shape: grounded diagnosis,
  ascending-risk sequence, per-PR gate, fail-today acceptance invariants.
