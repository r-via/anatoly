# 21. Scope Reconfiguration Phase (`init --phases scope`)

> Status: PR 1 (deterministic core), PR 2 (model suggestion), PR 3
> (run-side hint) and the tier1 band-aid removal all landed. Scope: give
> an already-initialized project a deterministic, human-confirmed write
> path for the audit perimeter (`scan.exclude` / `scan.include`), and
> make fixture directories excluded by default at the scan layer instead
> of patched per-axis or post-review. Supersedes the tier1
> `FIXTURE_PATTERNS` band-aid (removed, see section 7). Implemented in
> [init.ts](../../src/commands/init.ts) (the `scope` phase +
> `mergeScanIntoYaml`), [scan-autodetect.ts](../../src/core/scanning/scan-autodetect.ts)
> (bootstrap default), [propose-excludes.ts](../../src/core/scanning/propose-excludes.ts)
> (the model suggestion) and [hint-detector.ts](../../src/cli/hint-detector.ts)
> (the run-side nudge). Decision context: project memory
> `project_scope_phase_exclusions`.

## 1. The decision

> **The audit scope (which files are reviewed) is deterministic and
> user-owned. An LLM may propose exclusions; it never decides them live.
> Scope is written at exactly two human-driven moments (bootstrap init,
> and an explicit `init --phases scope` re-run), never as a side effect
> of `run`.**

Two layers exist in an audit tool:

1. Which files enter review (the perimeter / triage).
2. Which findings come out per file (the seven axes).

The LLM is legitimate in layer 2. In layer 1 a live LLM decision is
harmful for three reasons: a wrong exclusion of real code is a silent
correctness hole (the worst failure mode for an audit tool, invisible to
the user), a re-decided perimeter makes the bench F1 denominator
non-deterministic, and it costs a model call on every run for a value
that changes slowly. So the perimeter stays programmatic and frozen in
`.anatoly.yml`; an LLM is allowed only to suggest entries that a human
reviews and confirms.

## 2. Why now

Anatoly auditing its own repo surfaced the gap. The per-axis training
fixtures under `src/prompts/__gold-set__/` and `src/__fixtures__/` are
intentionally bad, dead, or undocumented code. When they enter review
they pollute every axis with false positives (the utility axis alone
emitted dead-code actions for all 14 fixture files in run
`2026-05-30_164218`).

Three things were wrong:

1. **Fixtures were excluded per axis, not once.** `.anatoly.yml` had
   `skip:` blocks only under the `tests` and `documentation` axes. The
   other five axes (utility, correction, duplication, overengineering,
   best_practices) had no skip, so they leaked fixtures. Adding a skip
   under each axis is a DRY trap: you must remember all seven, and the
   maintainer had added two.
2. **`__fixtures__` was excluded nowhere** (only `__gold-set__`), so
   `src/__fixtures__/orchestration-handoff/src/dead.ts` reached every
   axis.
3. **The engine had a post-review band-aid** in tier1 (section 7) that
   flips the verdict but does not purge the synthesized action, leaves a
   stale `[DEAD]` detail, and still pays the LLM review cost.

The root cause is a missing write path. Config is written at exactly one
lifecycle point today: the bootstrap init. `run.ts` first-run path
([run.ts:289-327](../../src/commands/run.ts#L289)) calls
`writeFirstRunConfig`
([setup-prompts.ts](../../src/cli/setup-prompts.ts)), which calls
`detectScanGlobs` then `autoDetectScanGlobs(profile)` to compute
`scan.exclude`, writes `.anatoly.yml`, and reloads. After that, every
`run` only reads the frozen config. An already-initialized repo has no
mechanism to gain new exclusions short of hand-editing the yaml or a
destructive `init --force`. This phase closes that gap.

## 3. The contract

### 3.1 Surface

A new init phase `scope`, added to `VALID_PHASES`
([init.ts:460](../../src/commands/init.ts#L460)):

```
anatoly init --phases scope      # alias: anatoly init --scope
```

`scope` is the chosen label (not `scan`): `scan` already names a run
pipeline phase (the file-reading step), and the word describes the act
of reading, not the decision of perimeter. The phase writes into the
`scan:` section of the yaml; the label diverging from the section name
is accepted (renaming the `scan:` section would be a breaking config
change).

### 3.2 Flow (mirrors the `documentation` phase, [init.ts:484-492](../../src/commands/init.ts#L484))

1. Load the existing `.anatoly.yml`. Error out if absent, with the same
   message the other phases use ("no .anatoly.yml found; run
   `anatoly init` first to create one").
2. **Detect** candidate exclusions:
   - deterministic baseline: `autoDetectScanGlobs(profile)`;
   - interactive TTY only: an optional Opus pass over the project tree
     proposing categorized globs (see section 5).
3. **Merge** via `mergeScanIntoYaml` (section 4).
4. **Preview** (`p.note`) the resulting yaml, **confirm** (`p.confirm`),
   then `writeFileSync`. Non-interactive (no TTY): print the proposed
   additions and exit without writing, unless `--yes` is passed.

### 3.3 Merge contract: `mergeScanIntoYaml`

New pure function, string in / string out, hermetically testable (no
IO, no LLM):

```
mergeScanIntoYaml(existingYaml: string, excludes: string[]): string
```

Invariants:

1. **Touches only `scan.exclude`.** It never edits `scan.include`
   without an explicit caller opt-in, and never any other section.
2. **Union plus dedupe.** Each glob in `excludes` is guaranteed present
   in `scan.exclude` exactly once after the merge.
3. **Never deletes.** Entries the user added by hand are preserved. The
   merge only adds.
4. **Idempotent.** Re-running with the same inputs yields no diff.
5. **Preserves structure.** Existing ordering and comments are kept;
   new entries carry a dated trailing comment marking their origin.
6. This is a true surgical merge from day one, unlike the `rag` and
   `providers` phases which today warn and punt to `--advanced`
   ([init.ts:500-505](../../src/commands/init.ts#L500)). `scan.exclude`
   is a flat list, so a clean structural merge is tractable; the warn
   and punt fallback is not acceptable here.

## 4. Determinism and safety invariants

1. `run` is never a write site for config. It reads the frozen
   `.anatoly.yml`. At most it may emit a hint (via the existing
   [hint-detector](../../src/cli/hint-detector.ts) / notice system) when
   fixture-shaped files are still in scope, pointing at
   `anatoly init --phases scope`. A hint, not a mutation, not an LLM
   call.
2. The non-interactive bootstrap (`writeFirstRunConfig`, CI,
   `--defaults`) stays on `autoDetectScanGlobs` only. No LLM call decides
   scope in a headless path.
3. The Opus suggestion runs only behind a TTY, where the human reviews
   and confirms the diff before it is written. A wrong exclusion is
   therefore caught at confirm time and visible in the git diff, never
   applied silently.

## 5. The suggestion layer (built, [propose-excludes.ts](../../src/core/scanning/propose-excludes.ts))

The model pass sits behind a narrow seam so the phase ships deterministic
first and the model layer is added without reworking the flow, and so
tests never call a real model (project rule: no LLM in tests). The shipped
signature:

```
proposeExcludes(params: {
  projectRoot, config, router, files,
  alreadyExcluded?, abortController?,
  queryFn?,   // injectable seam; defaults to runSingleTurnQuery
}): Promise<Array<{
  glob: string;
  category: 'fixture' | 'generated' | 'example' | 'vendored';
  reason: string;
}>>
```

The phase composes `autoDetectScanGlobs` (always) with `proposeExcludes`
(TTY only), unions the globs, and feeds them to `mergeScanIntoYaml`. The
in-scope file list is rendered to a condensed tree via `buildProjectTree`
for the prompt; the model sees only the path tree (no file contents), so
it recognizes non-product code by naming and directory convention. The
prompt is told that a wrongly-excluded real file is a silently-missed bug
and to bias hard toward fewer, high-confidence exclusions, with one
carve-out: a short list of named, path-recognizable ecosystem conventions
that are high-confidence even under `src/`. Those named conventions are
Supabase generated database types (`**/supabase/types.ts`,
`**/database.types.ts`, and the `**/integrations/supabase/types.ts`
layout) under the `generated` category, and shadcn/ui primitives
(`**/components/ui/**`, scaffolded by `npx shadcn add`, false-positive
heavy) under the `vendored` category, alongside generic codegen output
(`**/__generated__/**`, `**/*.generated.ts`, `**/routeTree.gen.ts`). The
category and reason are shown in the confirm preview so the human judges
each entry. `queryFn` injection keeps it mockable; the
deterministic path needs no model, and `config.models.deliberation`
(Opus) drives the call.

## 6. Implementation plan

- **PR 1 (deterministic core). DONE.** Added the `scope` phase to
  `VALID_PHASES` and the `--scope` flag. `mergeScanIntoYaml` with hermetic
  string-to-string tests covering the six invariants. Phase wiring detects
  via `autoDetectScanGlobs`, merges, previews, confirms, writes. No LLM.
- **PR 2 (suggestion layer). DONE.** `proposeExcludes` behind the seam in
  section 5, gated on TTY, surfaced in the preview with category and
  reason, `queryFn`-mocked in tests. Shared router factory
  `createCliRouter` extracted to avoid a sixth duplicated `buildRouter`.
- **PR 3 (run-side hint). DONE.** The setup phase passes the in-scope file
  list to the hint detector, which emits a `fixtures-in-scope` hint
  pointing at `init --scope` when a fixture-shaped path survived
  `scan.exclude`. No write, no LLM.

## 7. What this supersedes

The tier1 `FIXTURE_PATTERNS` band-aid is removed once PR 1 lands.
Today [tier1.ts:60](../../src/core/evaluation/refinement/tier1.ts#L60)
defines `FIXTURE_PATTERNS` and
[tier1.ts:107-121](../../src/core/evaluation/refinement/tier1.ts#L107)
flips a fixture symbol's correction to OK and utility to USED after
review. It is the wrong layer (post-review), it is partial (it flips the
verdict but does not purge the already-synthesized dead-code action, and
leaves the stale `[DEAD]` detail and the finding row), and it still pays
the LLM review cost for files that should never have been reviewed.
Excluding fixtures at the scan layer makes all of that unnecessary: the
files never enter review, so there is no verdict to flip, no action to
purge, and no cost. PR removing the band-aid also drops its tests
([tier1.test.ts:447-470](../../src/core/evaluation/refinement/tier1.test.ts#L447))
and the now-redundant per-axis `skip:` blocks in `.anatoly.yml`.

The immediate fixture unblock is already in place ahead of this phase:
`src/prompts/__gold-set__/**` and `src/__fixtures__/**` are in the
top-level `scan.exclude` of this repo's `.anatoly.yml`, and
`autoDetectScanGlobs` now emits `**/__fixtures__/**` and `**/__mocks__/**`
unconditionally for new projects (the Anatoly-specific `__gold-set__`
name stays in the repo config, out of the universal engine default).

## 8. What this does NOT do

- It does not let the LLM decide scope at run time.
- It does not rename the `scan:` config section.
- It does not change `run` into a config write site.
- It does not address the seven non-fixture findings the self-audit
  surfaced (those are separate correction-axis and dedupe work).
