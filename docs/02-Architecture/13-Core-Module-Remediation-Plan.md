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
3. **The grep gate.** After each PR, two scans must come back clean. (a)
   Import paths: `grep -rn "from '[^']*core/<m>\.js'" src --include=*.ts`
   (plus the `import('...')` dynamic and inline forms) matches only the new
   home, never the old flat path. (b) Hardcoded source-path reads in guard
   tests: scan the **bare quoted filename token** `'<m>.ts'`, not just import
   strings, because the path is often assembled from segments
   (`readFileSync(join(process.cwd(), 'src', 'core', '<m>.ts'))`) which a
   `from '...'` or `[^)]*<m>` regex silently misses (PR 2 hit exactly this in
   `doc-stale-reference.test.ts:205`). Exclude the path-agnostic sandbox
   fixtures (`usage-graph.test.ts`, `doc-pipeline.test.ts`,
   `axes/utility.test.ts`) which use such strings as fabricated data under
   `tmpdir()`, not as references to the real file. Zero stale paths is a hard
   gate; the full suite is what actually catches a missed segment-form read.

The prerequisite here is not building a net, it is **doc 12 being ratified**:
the barrel convention and the §4 split shape every PR, so the contract lands
first (this pair of docs), then PR 1.

## 4. The move recipe (every PR follows it verbatim)

1. `git mv src/core/<m>.ts src/core/<context>/<m>.ts` and the same for
   `<m>.test.ts` (the colocated test moves with its module, always). **Only
   the canonical `<m>.test.ts` moves.** Supplementary and integration test
   files (`<m>-foo.test.ts`, `*-foreground.test.ts`, `*.integration.test.ts`)
   are **external importers**, not colocated tests: they stay where they are
   and repoint to the barrel (step 3). This keeps the move deterministic (no
   per-file judgement about which tests "belong"). PR 4 set this rule
   (`run-status-foreground.test.ts`, the prompt-invalidation / shared-cache
   integration tests stayed put and went through the barrel).
2. Rewrite relative depth **inside** the moved files by the nesting delta.
   Not only `import ... from '../foo.js'`: a moved test that resolves a
   **filesystem path relative to its own location**
   (`resolve(import.meta.dirname, '../prompts')`, `__dirname`,
   `import.meta.url`) shifts by the same delta and breaks silently (tsc does
   not type-check path strings). PR 3: `prompt-resolver.test.ts` globbed
   `../prompts`, found zero `.system.md` files, and failed registry
   coherence until corrected to `../../prompts`; a sibling `existsSync`
   "old dir is gone" assertion was repointed `./axes/prompts` ->
   `../axes/prompts` to keep its original absolute target (move-only: same
   assertion, same real path). Scan the **entire** moved file, not just the
   header import block: an inline `import('../x.js').T` type annotation
   mid-file (PR 4: `estimator.test.ts:225`) shifts by the same delta and only
   `tsc` catches it (gate 1). **Never `replace_all` an import string when
   depth-fixing a moved test**: the same text frequently appears inside
   sandbox-fixture string literals (`createFile('src/core/x.ts', "import ...
   from '../schemas/..'")`, template bodies) that simulate a file at the
   *original* location and must keep their original relative depth. PR 5:
   a `replace_all` on `usage-graph.test.ts`'s real `Task` import also
   rewrote the fixture string at line 219, so the simulated importer
   resolved wrong and `buildUsageGraph` returned `[]` (tsc and grep clean;
   only the full suite caught it). Use line-targeted replacements; the
   fixture strings are the doc 13 §3 path-agnostic exclusion, inviolate even
   during the moved file's own depth fix.
3. Rewrite every importer's path: intra-context importers to the new relative
   path, every out-of-context importer to the context barrel
   `<context>/index.js` (or `evaluation/contract.js` for the §4 seam). This
   includes static imports, dynamic `await import('...')`, inline
   `import('...').T` type imports, **and hardcoded source-path string readers
   in guard tests** (PR 2 surfaced `migration/deprecated-cleanup-56-9.test.ts`
   doing `read('src/core/<m>.ts')`: repoint it to the new path). PR 3
   surfaced a third form: **vitest module-mock paths** (`vi.mock('...')`,
   `vi.doMock`, `vi.importActual`, `requireActual`). Repoint these to the
   **leaf** module inside the context (`<context>/<m>.js`), never the
   barrel: the consumer imports the barrel, the barrel re-exports the leaf,
   so mocking the leaf transparently yields the mock, whereas mocking the
   barrel replaces every context export and silently changes the test (a
   move-only breach). It does
   **not** include path-agnostic sandbox fixtures: `usage-graph.test.ts` and
   `doc-pipeline.test.ts` fabricate files or `Task`s at arbitrary path
   strings under `tmpdir()` to exercise path handling generically; those are
   test data, not references to the moved module, and editing them would
   breach move-only.
4. Create or extend `<context>/index.ts` to re-export the context's public
   surface (the symbols its current external importers use, no more: no
   speculative exports). A colocated test moves with its module and imports it
   relatively, so it is **not** an external importer; a test in another
   directory that imports the module **is**, and its symbols are part of the
   surface.
5. **Stage deliberately (PR 1 trap).** `git mv` stages the rename against the
   *pre-edit* content; the step 2 / 3 edits to the moved files are left
   unstaged. `git add` every moved-and-edited file explicitly, then verify
   `git diff --cached -- <moved>` shows the import delta. A moved file that
   appears as a pure `R100` rename means its edits were missed and the commit
   would land stale, broken content. PR 1 hit this and was repaired with
   `git commit --amend` **before any push**; never amend a pushed commit.
6. Gate (§6). The diff is git-mv + import-path rewrites (static, dynamic,
   inline, and guard-path) + barrel only. Reviewer attests no logic delta;
   the three §3 gates enforce it mechanically.

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
| `src/integration/cache-meta-overhead.test.ts` (a `performance.now()` microbenchmark, threshold 50%) fails spuriously when the suite runs under machine load | Pre-existing, orthogonal to this refactor: every PR's staged set provably excludes `cache-meta`/`utils/cache`, it passes isolated every time (~26 ms), and a no-load full-suite re-run clears it (observed PRs 3 to 6b). Gate resolution is a no-load re-run, never a code change. Not a remediation regression |
| A `replace_all` depth-fix on a moved test also rewrites identical import text inside sandbox-fixture string literals (`createFile(..., "import ... from '../schemas/..'")`), corrupting fixtures that simulate a file at the original location | §4 step 2: line-targeted replacements only when depth-fixing a moved test; fixture strings are the §3 path-agnostic exclusion. PR 5: `usage-graph.test.ts:219` (tsc + grep clean; only the full suite caught `buildUsageGraph` returning `[]`) |
| A guard test reads a moved module's source by hardcoded path; recon and the import-grep miss the `join(...,'core','<m>.ts')` segment form | §3 gate 3 scans the bare quoted `'<m>.ts'` token, not just import strings. PR 2 surfaced two such tests (`migration/deprecated-cleanup-56-9.test.ts` string form, `doc-stale-reference.test.ts:205` segment form); the full-suite gate caught the missed one, the detector was then broadened. Future exposure inventoried: `axis-evaluator.ts` (PR 7), `correction-memory.ts` (PR 3), `doc-llm-executor.ts` / `doc-gap-detection.ts` (PR 6) |
| `git mv` then edit leaves the content edits unstaged; the commit lands a stale `R100` rename | §4 step 5: `git add` every moved-and-edited file explicitly, verify `git diff --cached -- <moved>` shows the import delta. PR 1 hit this, repaired via `git commit --amend` pre-push |
| A vitest module-mock path (`vi.mock('...')`) still targets the old flat path; recon, the import-grep and tsc all miss it (mock paths are strings, not type-checked) | §3 gate 3 / §4 step 3 scan `vi.mock`/`vi.doMock`/`importActual`/`requireActual`. PR 3 surfaced `rag/orchestrator.test.ts:94`; repointed to the leaf `platform/worker-pool.js` so the barrel re-export transparently yields the spy. The full-suite gate is the backstop (a dead mock path makes the spy assertions fail) |
| Repointing a peer-context importer at a barrel closes an import cycle: the barrel re-exports a module carrying a *transitional* cross-context back-edge, and the importer runs during another context's eager module-init | tsc and the grep gate pass (no type or path error); only the full suite catches it (a re-entrant eager-init throws "X is not a constructor"). PR 4: `axes/internal-docs-context -> run/index.js` re-entered `axes/index.ts` via `estimator -> ../axes/index.js`. Fix: that edge points at the **leaf** (`run/run-config.js`), not the barrel. PR 7 reinforced this at its largest instance: the `evaluation/` barrel eagerly constructs every axis evaluator at load, so the §4/§5 consumers (`docs-resolver`, `reporter`, `run-config`, `estimator`) point at the `evaluation/axis-evaluator` leaf, not the barrel (`file-evaluator -> documentation/index.js -> docs-resolver -> evaluation barrel` re-entered mid-init: `ALL_AXIS_IDS` undefined; only the full suite caught it). Resolved at **PR 7b**, when the leaf is split and these point at `evaluation/contract.js`. Recorded as the doc 12 §5 barrel-cycle exception |

## 10. Plan acceptance invariants

Testable assertions, written (doc 11 §10 style) so they fail today and pass
only when the plan holds.

> **Status: all five invariants satisfied (PRs 1 to 7b landed). The
> remediation is complete.** Every one of the 60 modules is in a bounded
> context: `worktree/`, `reporting/`, `platform/`, `run/`, `scanning/`,
> the 4-sub-folder `documentation/`, and `evaluation/` (`axes/`+
> `refinement/` nested, one barrel). The flat `src/core` root holds zero
> `.ts` modules. Each PR passed the §3 grep gate, `tsc --noEmit`, and the
> full vitest suite (185 files, `spine-golden` included); PR 7b
> additionally passed the §6 split gate (public-API snapshot name-and-type
> identical to the pre-split exports, byte-identical symbol bodies). The
> §4 recipe was hardened across PRs 2 to 7 against seven trap classes
> (git-mv staging; segment- and string-form guard-path reads; vitest
> module-mock paths; mid-file inline `import()`;
> supplementary-tests-as-external; the barrel-cycle exception, reinforced
> at its largest instance by PR 7's eager evaluation barrel; `replace_all`
> over-reach into sandbox-fixture strings) plus the recurring cache-meta
> environmental flake documented as orthogonal (§9). Invariants 1 to 3
> held every PR; invariants 4 and 5 (the `axis-evaluator` contract/impl
> split, and "no peer-context import of an implementation path") were
> closed by **PR 7b**: `axis-evaluator.ts` no longer exists,
> `evaluation/contract.ts` + `evaluation/evaluator.ts` do, the
> re-exported symbols are name-and-type identical to the pre-split
> exports, and every §5 consumer imports `evaluation/contract.js`.

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
