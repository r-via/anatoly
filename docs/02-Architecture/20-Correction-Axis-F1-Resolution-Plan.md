# 20. Correction-Axis F1 Resolution Plan

> Status: open. Scope: close the F1 gap on the correction axis. Three
> consecutive benches (v33, v34, v35 on slot-engine, HEAD `8b87079`)
> reported correction f1 `0.615` (`4tp/2fp/3fn`) with the same three
> misses: `applyWildBonus` (INV-WILD), `handleFreeSpins` (INV-FREESPIN),
> `isJackpotHit` (INV-JACKPOT). Reproducible, structural, the only
> remaining proven F1 lever once doc 16/18/19 landed.

## 1. The decision

> **The correction axis must be redesigned via single-variable bench-gated
> A/B experiments. Each PR changes exactly one input to pass 1 or pass 2,
> measures correction F1 against a 3-sample baseline on slot-engine, and
> ships only if the delta is positive and other axes stay in-band.**

We stop arguing prompt theory. We have a stable baseline (correction
0.615, identical across v33/v34/v35) and a precise list of misses. We
change one variable at a time, re-bench, decide.

## 2. Diagnosis (grounded, three vectors)

The under-detection is no longer "one prompt fix away". It has three
distinct mechanical causes, each visible in code today:

### 2.A Scaffold influence is uncertain (initial diagnosis revised)

The first draft of this plan claimed the scaffold is injected as
ground truth and poisons correction. That is **not what the code does
today**. Honest restatement:

`correction.ts` does inject the internal-docs context
([correction.ts:95-97](../../src/core/evaluation/axes/correction.ts#L95))
via `renderInternalDocsContext`. But the section that actually appears
in the user message is explicitly framed as weak
([internal-docs-context.ts:37-44](../../src/core/evaluation/axes/internal-docs-context.ts#L37)):

> ```
> ## INTERNAL DOCUMENTATION (DERIVED FROM CODE — context only, not ground truth)
>
> Do NOT use this section to flag code. If it contradicts the reference
> docs above, the reference wins. Treat this strictly as weak
> supplementary context.
> ```

The design intent is therefore to NOT poison correction. The injection
itself states "not ground truth", "weak supplementary", and "do not use
this section to flag code". The system prompt's rule 10 in
[correction.system.md:25-33](../../src/prompts/axes/correction.system.md#L25)
says the opposite ("ground truth"), but it references a different
header that is never written (see §2.A' below). So the literal
mechanism of "scaffold framed as authoritative" is absent.

That does NOT prove the scaffold has zero effect. Three plausible
residual mechanisms remain, all unverified:

1. Even with a "weak" framing, an LLM may still anchor to the
   scaffold's description of buggy behavior because it is the only
   text in the prompt that names the symbol's invariant. A caveat is
   not always a mechanical exclusion.
2. The model may match "Internal" loosely between rule 10's phantom
   header and the actual injection header, applying contradictory
   framings and silently resolving toward "trust the doc".
3. The scaffold may have no effect, and the under-detection comes
   entirely from vectors 2.B and 2.C below.

INV-RTP remains illuminating but no longer fits the "scaffold poisons"
story cleanly. The README anchors INV-RTP, the scaffold disagrees with
the buggy code (detected as the only pending conflict), and correction
caught `computePayout` natively. The pattern is consistent with "external
reference is what correction actually leans on", not with "scaffold
poisons except where overridden".

**Status of vector 2.A: empirically untested.** The plan still proposes
an A/B that removes the scaffold (§4.A), but the prediction is now
"unknown sign and magnitude", not "expected strong lift". A null result
from 4.A is informative.

### 2.A' Phantom rule 10 (header mismatch across three axes)

Three axis prompts carry a rule 10 (or rule 8 in
[overengineering.system.md:18](../../src/prompts/axes/overengineering.system.md#L18))
that all reference the same header string:

> "A section `## Internal Reference Documentation (project-level
> ground truth)` may appear in the user message."

This header is **never written**. Greppable references:

- referenced (3 sites):
  [correction.system.md:25-26](../../src/prompts/axes/correction.system.md#L25),
  [best-practices.system.md:42](../../src/prompts/axes/best-practices.system.md#L42),
  [overengineering.system.md:18](../../src/prompts/axes/overengineering.system.md#L18)
- actually written by code (different headers, different framings):
  [internal-docs-context.ts:37](../../src/core/evaluation/axes/internal-docs-context.ts#L37)
  produces `## INTERNAL DOCUMENTATION (DERIVED FROM CODE — context
  only, not ground truth)` for correction / best-practices /
  overengineering;
  [documentation.ts:111](../../src/core/evaluation/axes/documentation.ts#L111)
  produces `## Internal Reference Documentation (from .anatoly/docs/ —
  DO NOT use for scoring)` for the documentation axis. Both differ
  from the rule-10 referenced header.

Possible interpretations:

- **Dead rule.** The model never sees the header rule 10 mentions, so
  rule 10 fires on nothing. Net effect: harmless, but ~9 lines of
  authoritative-sounding instruction in every prompt that the model
  has to parse and reconcile against the actually-written weak section.
- **Loose match.** The model matches "Internal" / "Internal Reference"
  loosely between rule 10 (ground truth) and the actually-injected
  section (weak supplementary), applies the stronger framing because
  rule 10 is stated more authoritatively, and silently trusts the
  scaffold.
- **Active confusion.** Two contradictory framings in the same prompt
  for the same data source lowers the model's confidence in any
  framing, producing the "default to OK / low risk" behavior we see.

This is independent of whether the scaffold actually helps. It is a
**latent prompt-engineering bug** in three axes, and it interacts
unpredictably with vectors 2.A / 2.C. The cheapest experiment in §4 is
to reconcile this mismatch first (§4.0).

### 2.B Pass-2 verification is asymmetric

`correction.ts` runs a two-pass strategy
([correction.ts:117-365](../../src/core/evaluation/axes/correction.ts#L117)).
Pass 2 (`correction.verification.system.md`) only ever fires when pass 1
produced a `NEEDS_FIX` or `ERROR`:

```ts
function findingsNeedVerification(findings, ctx): boolean {
  if (!ctx.fileDeps || ctx.fileDeps.deps.length === 0) return false;
  return findings.symbols.some((s) =>
    s.correction === 'NEEDS_FIX' || s.correction === 'ERROR');
}
```

([correction.ts:230-238](../../src/core/evaluation/axes/correction.ts#L230)).

The pass-2 prompt itself explicitly scopes to flagged findings:

> "A previous pass flagged certain symbols as NEEDS_FIX or ERROR. […]
> For EACH flagged symbol, verify […]. If the library handles this case
> natively → change to OK."
> ([correction.verification.system.md:23-32](../../src/prompts/axes/correction.verification.system.md#L23))

Pass 2 is a precision-improver: it can **only flip NEEDS_FIX → OK**, never
the inverse. The system has zero machinery to challenge pass-1 OK
verdicts. Every under-detection in pass 1 is permanent.

### 2.C Prompt bias toward OK

A weaker, harder-to-isolate effect. `correction.system.md` is 182 lines
of rules + schema before the file content. Rule 1 sets:

> "OK = no bugs or correctness issues found (confidence: 90+)."
> ([correction.system.md:9](../../src/prompts/axes/correction.system.md#L9))

The OK verdict gets the highest confidence floor. The schema example
shows `"correction": "OK"` as the default shape. Combined with the
preamble length (182 lines of rules before the code), the model has a
documented bias toward OK-with-confidence as the path of least
resistance. This is the legacy hypothesis from
[[project_correction_axis_underdetection]] but it is now the **third**
suspect, not the first, after 2.A and 2.B are mechanically visible.

## 3. Bench-loop methodology

The correction axis is the most volatile axis in the bench (historical
range `0.333` to `0.615`; current stable `0.615` over three runs). Any
experiment must distinguish a real effect from noise.

### 3.1 Lock the conditions

For every experiment in §4:

- Same fixture: `anatoly-bench/catalog/slot-engine`.
- Same SDK: `@anthropic-ai/claude-agent-sdk` 0.3.144.
- Same VM, same models, same `--no-cache`, same cleanup
  (`rm -rf runs cache tasks anatoly.lock deliberation-memory.json`),
  same warm/cold posture (here: always cold full bootstrap because the
  bench procedure's `rm -rf cache` wipes the skip-bootstrap signature).
- The doc-conflicts store left intact between runs (the fold-gate is
  fresh-this-run, so stale entries do not perturb the experiment;
  invariant from doc 16 / b940256).
- One variable changes per experiment. Nothing else.

### 3.2 Sample size and decision rule

- Baseline: `v33/v34/v35` = correction `0.615` three runs (identical
  4tp/2fp/3fn).
- Per experiment: **two confirmatory runs (N=2)** under the changed
  condition.
- Ship criteria:
  - correction f1 mean of the two runs is ≥ `0.700` AND every individual
    run is ≥ `0.650` (i.e. a real, repeatable lift, not one lucky run),
  - AND the **set of misses shrinks** (`fn` drops by ≥ 1 and the named
    miss is one of the three target invariants),
  - AND no other scored axis drops by more than `0.10` f1 from its
    three-run mean (`utility ~0.857`, `duplication ~0.611`,
    `overengineering ~0.522`, `best-practices ~0.605`).
- Reject criteria: either confirmatory run drops correction below
  `0.500`, OR the miss-set is unchanged after two runs, OR another axis
  drops > `0.10`. Revert the change.
- Inconclusive: one run good, one run flat. Run a third. If still
  inconclusive, treat as null and move on.

Two-run N is small but proportionate: each run is ~20 min and ~$6,
slot-engine is the only fixture, and we expect effects of order +0.10 to
+0.20 if real. A null effect at N=2 with no miss-set change is a strong
signal the variable is not binding.

### 3.3 Capture and persistence

Each experiment commits a baseline pair under
`anatoly-bench/baselines/<date>_slot-engine-<vNN>.{json,md}`, named
after the PR that produced it (e.g. `v36-exp-A1`, `v37-exp-A1-2`). The
PR description records the bench IDs, the deltas, and the decision.

## 4. Experiments

Five single-variable changes. The first three attack the **mechanical**
vectors (2.A, 2.B); the last two attack the **prompt-bias** vector
(2.C). Mechanical first because they are easier to attribute.

### 4.0. Reconcile the phantom rule 10 / header mismatch

The cheapest experiment, and the one that disambiguates §2.A from
§2.A'. Two variants, run in order.

**4.0a. Delete rule 10 from the three prompts that carry it.**

Edit
[correction.system.md:25-33](../../src/prompts/axes/correction.system.md#L25),
[best-practices.system.md:42](../../src/prompts/axes/best-practices.system.md#L42),
[overengineering.system.md:18](../../src/prompts/axes/overengineering.system.md#L18)
to remove the rule entirely. The scaffold injection itself is
unchanged (still framed as weak by
[internal-docs-context.ts:37](../../src/core/evaluation/axes/internal-docs-context.ts#L37)).

**Hypothesis.** If rule 10 was dead (header never matched), this is a
no-op: correction stays at `0.615`. If rule 10 was being loosely
applied to the actual scaffold (vector 2.A' interpretation 2 or 3),
removing the contradictory framing should lift correction by reducing
the model's tendency to trust scaffold-as-truth on bug-confirming
descriptions. Lift on best-practices / overengineering is also
possible since they carry the same dead rule.

**Risk.** Negligible. Removing dead-code prompt rules in three places.
If 4.0a triggers a drop on best-practices or overengineering, that
itself is evidence rule 10 was doing real work for those axes and we
revert.

**Acceptance.** Per §3.2. Pre-registered null hypothesis: 4.0a is a
no-op on correction. A positive lift is informative; a null result
demotes vector 2.A' as a binding factor for correction.

**Implementation cost.** ~10 lines, three files, one PR.

**4.0b. Align the actual injection header with rule 10's framing
choice.**

Run only if 4.0a is null. Decide one of:

- Rewrite
  [internal-docs-context.ts:37](../../src/core/evaluation/axes/internal-docs-context.ts#L37)
  to write the literal header rule 10 references
  (`## Internal Reference Documentation (project-level ground truth)`)
  AND change rule 10 to say "**weak supplementary, code is
  authoritative**" (i.e. keep one framing, remove the contradiction).
  This is the conservative-and-honest version: the scaffold is what it
  is (auto-generated from code), and we tell the model so.
- Or, stronger: leave the weak framing in `internal-docs-context.ts`
  but make it explicit and impossible to misread, e.g. prepend `THIS
  IS AUTO-GENERATED FROM THE CODE BEING AUDITED. IT WILL AGREE WITH
  BUGS. IGNORE IT FOR CORRECTNESS.` This is the loud-warning version.

**Hypothesis.** Resolves any residual loose-matching ambiguity. Should
nudge correction toward judging code on its own merits when the
scaffold and the code agree on a bug.

**Risk.** The loud-warning version (option 2) may also reduce LEGITIMATE
scaffold influence in other axes (best-practices' "non-goal:
networking" example). Track cross-axis impact per §6.

**Acceptance.** Per §3.2.

**Implementation cost.** ~30 lines (one prompt section + one TS file +
test golden update).

### 4.A. Drop scaffold from correction context

**Variable.** Remove the internal-docs injection from
`buildCorrectionUserMessage` for the correction axis only
([correction.ts:95-97](../../src/core/evaluation/axes/correction.ts#L95)).
Keep it for the other axes (best-practices, overengineering,
documentation) that genuinely use it.

**Hypothesis (revised after §2.A correction).** This tests whether the
"weak supplementary" framing of the actual injection is in fact
honored by the model, or whether the scaffold still influences
correction despite the caveat. Prediction is **unknown sign**:

- If §2.A residual mechanism 1 or 2 (model anchors anyway, loose
  matching with phantom rule 10) is binding, correction lifts.
- If §2.A residual mechanism 3 is the truth (scaffold has no effect
  because framing is honored), 4.A is a no-op and the under-detection
  is fully attributable to vectors 2.B / 2.C.

Either outcome is informative. Run only after 4.0 to know whether the
phantom rule 10 was the confounding factor.

**Risk.** Strips a possibly-real signal where the scaffold IS correct.
Mitigation: if 4.0a / 4.0b lifted correction (rule 10 was the leak),
4.A becomes redundant and is skipped.

**Acceptance.** Per §3.2.

**Implementation cost.** ~20 lines, one PR.

### 4.B. Symmetrize pass 2 (challenge OK verdicts)

**Variable.** Extend `correction.verification.system.md` and
`buildVerificationUserMessage` to also pass through OK symbols whose
body is non-trivial (size > N lines, has loops/conditionals, exported
public API). Pass-2 prompt becomes: "For each symbol below, classify
whether the previous OK verdict is robust against documented and
implicit invariants. If you can name a concrete input that causes
incorrect output, flip to NEEDS_FIX with that input as the detail."

**Hypothesis.** Vector 2.B is binding. Pass 1 misses INV-WILD/FREESPIN/
JACKPOT because the rule load + the scaffold-as-truth biases the first
look toward OK; a focused second look constrained to "find ONE concrete
counterexample" is more likely to surface the bug.

**Risk.** New FPs from pass 2 (asymmetry was a precision feature).
Mitigation: require pass 2 to cite a **concrete counterexample input**
to flip OK → NEEDS_FIX (raises the bar). Track precision separately;
revert if `fp` rises by more than the `fn` reduction.

**Acceptance.** Per §3.2 plus: pass-2 flip rate (OK → NEEDS_FIX) per
file is logged for the post-mortem.

**Implementation cost.** ~50 lines (prompt + user-message builder +
schema change to carry OK symbols + apply-verification merge logic).
`findingsNeedVerification` gate widens to "always if there are deps".

### 4.C. Per-symbol invariant checklist when invariants exist

**Variable.** When the run carries any arbitrated/scaffold invariants
for a file, append a checklist to the correction user message: "For
each exported symbol, state whether each of the following invariants
holds in the implementation, then emit the verdict. Invariants: [list,
extracted from internal docs and/or `doc-conflicts.yaml`
resolved/pending entries]." Forces explicit per-symbol consideration of
each invariant.

**Hypothesis.** A hybrid of 2.A + 2.C. Even with scaffold present, the
checklist structure forces the model to evaluate each invariant
separately, which is harder to satisfy with a default OK. May also
surface conflicts that doc 16 missed.

**Risk.** Token cost up; risk of model "going through the motions" and
emitting OK-OK-OK for the checklist. Mitigation: schema requires a
one-sentence justification per checklist item.

**Acceptance.** Per §3.2.

**Implementation cost.** ~80 lines (checklist extractor from internal
docs / doc-conflicts; schema; merge into user message). Bigger than
A/B; defer until A and B are decided.

### 4.D. Remove the OK confidence floor and the OK schema example

**Variable.** Edit `correction.system.md`: drop the explicit "OK
confidence 90+" floor (rule 1); change the schema example to use a
non-OK verdict or a placeholder (`"<OK|NEEDS_FIX|ERROR>"`); leave every
other rule intact.

**Hypothesis.** Vector 2.C is binding. Removing the OK-as-default prime
shifts the model's prior away from OK.

**Risk.** Weak prior on confidence calibration may produce OK at lower
confidence, polluting the deliberation pass that uses confidence as a
tie-breaker. Mitigation: keep a "OK requires identifying nothing wrong
after exhaustive check" qualitative rule, just drop the numeric floor.

**Acceptance.** Per §3.2. Skeptical prior: this lifts correction by < 0.05
because A and B carry most of the under-detection signal.

**Implementation cost.** ~10 lines.

### 4.E. Code-first ordering

**Variable.** Reorganize the correction system prompt: file content
(code) appears immediately after the role line, with a minimal
preamble. All other rules are moved to AFTER the code in the system
prompt. Rule count unchanged; ordering changed.

**Hypothesis.** Long preamble dilutes the signal. Putting the code
first reduces the "rule overload" effect.

**Risk.** Schema/rules less salient; possibly more malformed JSON. The
existing schema validation in `runSingleTurnQuery` catches this; revert
if rejection rate rises.

**Acceptance.** Per §3.2. Lowest expected effect.

**Implementation cost.** ~20 lines (prompt reorg only).

## 5. Ordering

Run in order: **4.0a → 4.0b → 4.B → 4.A → 4.C → 4.D → 4.E**.

- **4.0a first** because it is the cheapest possible diagnostic (~10
  lines, three files) and disambiguates §2.A from §2.A'. A positive lift
  proves the phantom rule 10 was being loosely applied; a null result
  demotes vector 2.A' and lets 4.A be a clean test of the residual
  scaffold influence.
- **4.0b** only if 4.0a is null. Reconciles the framing one more time
  before more expensive experiments.
- **4.B next** because pass-2 asymmetry (§2.B) is now the most
  mechanically visible and verifiable defect, independent of any
  scaffold question. It is also the experiment most likely to lift
  recall on the three named misses regardless of what 4.0 / 4.A find.
- **4.A** runs after 4.0 has cleaned the framing confusion, so its
  signal is interpretable. If 4.0a or 4.0b already lifted correction
  via the phantom-rule fix, 4.A may become redundant and is skipped.
- **4.C, 4.D, 4.E** target prompt structure / bias and are last
  because the prompt-bias vector is the most contested.

Each PR is independently shippable. If 4.0a or 4.B wins decisively
(correction ≥ `0.800` with all three target misses recovered), stop and
consolidate; later experiments only proceed if earlier ones are null or
partial.

## 6. Cross-axis regression budget

The other six axes must not be silently degraded by a correction-axis
fix. Per §3.2: any axis dropping more than `0.10` f1 from its three-run
mean is a revert trigger. Three-run means (v33/v34/v35):

| axis | 3-run mean f1 | revert if drops below |
|---|---|---|
| utility | 0.857 (0.857 / 0.857 / 0.857) | 0.757 |
| duplication | 0.611 (0.667 / 0.667 / 0.500) | 0.511 |
| overengineering | 0.522 (0.400 / 0.667 / 0.500) | 0.422 |
| best-practices | 0.605 (0.333 / 0.769 / 0.714) | 0.505 |
| documentation | not scored on this fixture | n/a |
| tests | not scored on this fixture | n/a |

Three-axis means are noisy at N=3 (especially `best-practices`); the
revert trigger uses the actual three-sample mean computed at experiment
time, not the table above (which is recorded for orientation only).

## 7. Risks

- **Slot-engine is the only fixture.** A win on INV-WILD/FREESPIN/JACKPOT
  may be slot-engine-specific (the buggy patterns are stylized: `*1.05`,
  `2**wildCount`, `>=4 diamonds anywhere`). The hypothesis is that
  *scaffold-as-truth* poisoning is a general mechanism, not specific to
  these patterns, so a win on slot-engine should generalize. But it is
  unproven on other fixtures because there are none.
- **Prompt over-fit.** Aggressively tuning the prompt against three
  named misses risks fragile gains that regress on different bug
  shapes. Mitigation: experiment A (drop scaffold) is structural, not
  prompt-tuned to the specific symbols.
- **OK/recall trade.** Lifting recall always risks precision (`fp` up).
  The cross-axis budget plus the precision tracking in B catch this;
  revert if precision drops more than the recall gain.
- **The scaffold-removal undoes a doc 16 outcome.** Doc 16's whole
  point was to make the scaffold non-poisoning via ratification (PR 3b
  de-poison). PR 3b was deferred (#2 decisions) because INV-RTP was
  caught natively. Experiment 4.A is functionally the same de-poisoning
  for the correction axis, applied unilaterally. **If 4.A wins, PR 3b
  is implicitly re-opened** and the doc-16 design discussion in §2 of
  this conversation comes back: do we de-poison only correction (a
  per-axis lever) or globally (the original doc-16 PR 3b)? Decide on
  the bench evidence, not in advance.

## 8. Non-goals

- **No new bench fixture in this plan.** Slot-engine remains the only
  testbed. A second fixture is a separate, much larger project (curate
  catalogue, seed defects, baseline). Out of scope.
- **No model swap.** Same correction model (`anthropic/claude-sonnet-4-6`)
  throughout. A model-swap study is a separate axis of variance and
  would confound the prompt/pipeline variables here.
- **No deliberation-pass tuning.** Deliberation (pass-3 across axes)
  is downstream of correction; tuning it here would confound the
  per-axis signal. Out of scope.
- **No reach for INV-WILD via code↔internal pairing.** Closed in
  conversation as structurally unreachable (the scaffold is generated
  from the buggy code; comparing them detects nothing). Correction
  reading the code directly is the only path.
