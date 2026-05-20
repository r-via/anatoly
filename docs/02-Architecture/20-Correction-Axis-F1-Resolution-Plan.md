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

### 4.A'' Domain sanity-check on formulas (extension of rule 12)

Surfaced after v37bis-exp-4.BD's null result (correction f1 0.667
identical to v36-4.0a, all 3 INV misses unchanged). Inspecting the
actual prompt sent to pass 1 on `src/wild.ts` revealed the real
mechanism behind the 3 misses:

The user message contains a section headed
`## REFERENCE DOCUMENTATION (AUTHORITATIVE — human-authored or
human-validated)` containing the project's internal docs. For
slot-engine, that section describes the BUGGY formulas as the
project's canonical mechanics:

```
## Wild Multiplier
… the base payout for that line is scaled by `(1 + wildCount) × 2^wildCount`.
```

The code does exactly `basePayout * (1 + wildCount) * 2 ** wildCount`,
matches the AUTHORITATIVE doc, no contradiction → pass 1 emits OK with
high confidence. Same pattern for INV-JACKPOT (threshold ≥4 diamonds)
and INV-FREESPIN (retrigger-without-decrement): the docs describe the
buggy behaviors as canonical.

Rule 11 (industry-specific) covers casino/RNG but does not list
"wild compounding multiplier" as a known anti-pattern. Rule 12
(numerical-claim) requires an explicit TARGET number in the doc to
trigger — `applyWildBonus` has no target, just a formula.

**Variable.** Add a new rule (rule 13) to `correction.system.md`:
"Sanity-check every computation against domain plausibility".
Generic, not slot-machine-specific. Triggers on ANY symbol that
computes a value, returns a threshold decision, or mutates state.
Procedure: identify the symbol's inferred domain (per rule 11), plug
plausible boundary inputs, compute output by mental execution,
compare the output against what the domain would consider reasonable.
Crucially: **documentation agreement with a formula does NOT immunize
it**. Docs describe what the code does, they do not certify the result
is industrially / mathematically / contractually correct.

**Hypothesis.** The 3 INV misses all share the same mechanism:
reference doc legitimizes the buggy formula. Adding rule 13 forces
the model to mentally execute `applyWildBonus(100, 5) = 100*6*32 =
19,200` and recognize a 192x line multiplier is industrially extreme
for an RTP-95% target. INV-JACKPOT: `isJackpotHit` with threshold 4
on a 15-cell grid + P(DIAMOND/cell) ≈ 0.25 → P(jackpot) > ~10% per
spin, industrially absurd. INV-FREESPIN: retrigger-without-decrement
→ unbounded loop, structural domain absurdity.

**Risk.** New FPs from over-aggressive sanity-checking. Mitigation:
the rule requires CONFIDENT domain inference (per rule 11) AND
order-of-magnitude reasoning. Discipline: "Silence beats speculation"
clause. The flagged finding must cite the concrete input plugged in
and the computed output, so the chain is auditable.

**Acceptance.** Per §3.2 lighter criteria: ship if correction f1 ≥
0.700 AND at least 1 of the 3 INV recovered AND no axis drops > 0.10.
Single run by user decision (we've alleged single-run on 4.0a and
4.BD; same here).

**Implementation cost.** ~30 lines added to `correction.system.md`
(new rule 13 + Discipline subsection). Zero code change.

**Note vs §4.A.** §4.A was "drop the scaffold from correction
context". §4.A'' keeps the scaffold (information is preserved) but
adds a rule that licenses the model to override doc-described
formulas when their consequences are domain-absurd. More surgical,
preserves the legitimate uses of the scaffold (e.g. for
best-practices and overengineering axes where the doc DOES provide
useful intent). §4.A is preserved below as an alternative path if
§4.A'' is null.

---

### 4.A''' Re-frame the reference-docs header (chirurgical)

Surfaced after v38-exp-4.A'' null result. Rule 13 (domain sanity-
check) is now in the correction system prompt and DOES fire on
numerical chains (PAY_TABLE, RTP derivation), but it does NOT fire
on the 3 INV misses. Inspection of the prompts for those 3 confirmed
the binder: every one has an AUTHORITATIVE reference doc section
that literally describes the buggy formula / threshold / state
transitions AS the project spec (e.g. `isJackpotHit` doc says "the
threshold is hardcoded at 4"). The header
`## REFERENCE DOCUMENTATION (AUTHORITATIVE — human-authored or
human-validated)` and its sub-instruction "Use the following as
ground truth" sit in the user message, *closer* to the code data
than rule 13 in the system prompt, and override rule 13 in
practice.

**Variable.** Re-frame the reference-docs header to align the
user-message instruction with rule 13:

- Old: `## REFERENCE DOCUMENTATION (AUTHORITATIVE — human-authored
  or human-validated)` + "Use the following as ground truth …".
- New: `## PROJECT DOCUMENTATION (informational context — NOT a
  correctness oracle)` + explicit instruction that some material
  is auto-generated from code and may faithfully describe buggy
  behavior + "Doc agreement does not immunize" + scope `doc_divergence`
  to explicit human-authored invariants (numerical targets, stated
  non-goals, contract clauses).

The arbitrated-intents subsection (Story 55.7, doc 16 doc-wins) is
preserved with its stronger framing because it is post-arbitration
human-validated content. Only the top REFERENCE DOCUMENTATION block
loses its oracle status.

**Scope.** `renderReferenceDocsContext` is used by 3 axes:
correction, best-practices, overengineering. This change affects
all three — best-practices and overengineering may have relied on
the AUTHORITATIVE framing for "non-goal: networking" type
disambiguation. Per §3.1 "one variable per experiment" we accept
that and measure cross-axis impact in the bench.

**Hypothesis.** The user-message AUTHORITATIVE framing is what
overrides rule 13 on the 3 INV misses. Re-framing the user message
to match rule 13's posture ("doubt the doc, sanity-check by domain
inputs") should let rule 13 actually fire on `applyWildBonus`,
`isJackpotHit`, `handleFreeSpins`.

**Risk.**
- Best-practices/overengineering may lose precision when the doc
  legitimately disambiguates (e.g. doc says "no networking", which
  today licenses overengineering to flag HTTP retry frameworks as
  OVER). With the new framing, the model might still apply that
  signal but with lower confidence. Track in the bench.
- doc_divergence emission rate may drop. The current path for
  README explicit-target contradictions (INV-RTP via `computePayout`)
  still works because the README target IS an explicit human-
  authored claim — exactly what the new framing still flags as
  divergence-worthy.

**Acceptance.** Per §3.2 lighter: ship if correction f1 ≥ 0.700
AND ≥ 1 of 3 INV recovered AND no axis drops > 0.10 from its
three-run mean.

**Implementation cost.** ~10 lines in `reference-docs-context.ts`
header + instruction text, ~5 lines in the test for the new
strings. The arbitrated-intents subsection is untouched.

**Note vs §4.A''.** §4.A'' (rule 13) gave the model a tool to
sanity-check; §4.A''' (this) removes the framing barrier that
prevented the model from using the tool on doc-described formulas.
They compose.

**Note vs §4.A.** §4.A would drop the entire reference-doc section
for correction. §4.A''' keeps the content but re-frames it. If
§4.A''' is null, §4.A becomes the next test.

---

### 4.A. Drop scaffold from correction context — alternative to §4.A''

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

### 4.BD. Bundle — symmetrize pass 2 + drop OK confidence floor (chosen)

In-conversation reframing of §4.B and §4.D into a single bundle, on
the rationale that they are two halves of the same mechanism (pass 1
too confident in OK + pass 2 cannot challenge OK). Bundling violates
the "one variable per experiment" rule of §3.1 in spirit, but the two
edits are mechanically inseparable: dropping the floor without OK
challenge produces uncalibrated OK noise; adding OK challenge without
dropping the floor leaves the model unable to emit the low-conf OK
the challenge depends on.

**Variables (both, in one PR):**

1. `correction.system.md` rule 1: remove the `(confidence: 90+)` floor.
   Replace with "Confidence reflects conviction. Emit low confidence
   when uncertain instead of guessing NEEDS_FIX." Pass 1 can now emit
   `OK with confidence < 70` as an implicit SUSPECT (see §9.2 for the
   parked explicit-state version).
2. `correction.ts buildVerificationUserMessage`: include OK symbols
   with `confidence < 70` in the pass-2 prompt, capped per file.
3. `correction.verification.system.md`: add an "OK challenge" section.
   For each low-conf OK passed, if a concrete counterexample exists,
   flip to NEEDS_FIX with the counterexample in `detail`. Otherwise
   keep OK. **The flip requires `counterexample` non-empty** —
   precision-safe.
4. `VerificationResponseSchema`: add optional `counterexample` field;
   `original_correction` extended to also accept `OK`.
5. `applyVerification`: enforce the OK→NEEDS_FIX-requires-counterexample
   rule programmatically; ignore flips without it (defensive against
   model dropping the field).

**Piggyback:** no new LLM calls. Pass-2 fires on the same gate (file
has deps + ≥1 pass-1 NEEDS_FIX/ERROR). OK challenge rides the same
call with a larger prompt.

**Hypothesis.** The 3 misses (INV-WILD / INV-FREESPIN / INV-JACKPOT)
are all silent OK in pass 1 with no recourse downstream. Allowing
pass 1 to flag them as low-conf OK + giving pass 2 a counterexample-
gated promotion path is the smallest mechanical change that can
recover any of them.

**Risk.**
- Pass 1 OK noise: dropping the floor may produce more lukewarm OK
  across files that genuinely have nothing wrong. Mitigation: the
  counterexample-gated flip in pass 2 stays strict.
- New FPs from OK→NEEDS_FIX flips. Mitigation: schema requires
  `counterexample`; `applyVerification` ignores empty ones.
- Cross-axis: dropping the OK floor in `correction.system.md` does
  not affect other axes' prompts (each has its own system prompt).

**Acceptance.** Lighter than §3.2: ship if correction f1 ≥ 0.700
AND at least 1 of the 3 named INV recovered AND no axis drops > 0.10
from the v33-v35 mean. Single-run by user decision (we've "alleged"
the §4.0a result on a single run too — see ordering note in §5).

**Implementation cost.** ~80 lines (prompt + schema + builder +
merge + 1 hermetic test of the counterexample-gating).

**Note.** The remainder of this section preserves the original §4.B
and §4.D as separate experiments for the historical record. They are
no longer executed independently.

---

### 4.B. Symmetrize pass 2 (challenge OK verdicts) — superseded by §4.BD

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

## 9. Follow-ups (parked, out of scope for the F1 lever)

These were surfaced during the F1-resolution work but are NOT what is
blocking the bench result. Logged here so they are not lost.

### 9.1 Pass-2 (correction.verification) vs tier-3 (refinement) partial overlap

`correction.ts:230-394` runs a pass-2 verification on any file with
deps + ≥1 pass-1 NEEDS_FIX/ERROR. `refinement/tier3.ts` runs an
agentic deliberation on findings escalated by tier 2 (ERROR always;
NEEDS_FIX with confidence < 75 isolated; behavioral/config changes).

These are NOT duplicates: pass 2 confronts findings against
**library README docs** in a deterministic single-turn call, tier 3
confronts findings against the **actual source code** via an
agentic Read+grep subprocess. Different contexts, different
machinery, complementary precision filters.

But they overlap on the sub-population `correction:NEEDS_FIX with
confidence < 75 and behavioral`: those findings get filtered twice.
Worth investigating whether:

- tier 2 should skip findings that already passed (or failed) pass 2,
- or pass 2 should be folded into tier 3 as a deterministic pre-step,
- or both should stay and the cost is acceptable.

**Why parked:** the overlap is a precision-cost question, not a
recall lever. The F1 gap on slot-engine (INV-WILD/FREESPIN/JACKPOT)
is recall-bound and lives upstream of either filter — they only see
findings pass 1 has already raised. Solve the recall lever first
(§4.B), then revisit this for cost/clarity.

**When to revisit:** after §4.B ships (or is rejected), or whenever
a refacto touches `correction.ts` pass-2 or `refinement/` tier 2/3.

### 9.2 Explicit SUSPECT verdict (tri-state OK / SUSPECT / NEEDS_FIX)

Surfaced while scoping §4.B + §4.D. The current OK/NEEDS_FIX binary
combined with the "OK = confidence 90+" floor in
`correction.system.md` rule 1 creates a recall trap: pass 1 has no
way to express doubt without committing to NEEDS_FIX, so it defaults
to confident-OK on anything ambiguous.

**Cheaper alternative chosen for the bench (the 4.BD bundle below):**
drop the confidence floor and use `OK with confidence < 70` as an
implicit SUSPECT marker that pass-2 challenges. No schema change, no
bench-scorer change, captures the tri-state semantics for free.

**The explicit version (parked here):** add a `SUSPECT` value to
`AxisVerdictSchema` in `src/schemas/review.ts`, surface it as a
first-class verdict through `deliberation.ts`, `reporter.ts`, tier-2
escalation criteria, and the report rendering. Pass 1 emits SUSPECT
when it has a hypothesis but no proven counterexample; pass 2 (or a
new agentic step) promotes SUSPECT → NEEDS_FIX with counterexample or
demotes → OK.

**Why parked:**

- Schema change cascades through every axis-aware module (verdict
  enums, reporter sections, tier 2 escalation gates, deliberation
  merge logic).
- **Bench scorer contract** (sibling repo `anatoly-bench`) does not
  know SUSPECT — needs explicit mapping (TP? FP? new category?). This
  is the same cross-repo trap doc 16 hit with `doc_conflict` findings.
- Risk that the model dumps all uncertainty into SUSPECT and the
  middle category becomes a noise bin (no clearer signal than the
  binary it replaces).

**When to revisit:** if the 4.BD bundle ships a recall lift and the
report becomes harder to read because "OK with low confidence" is
visually indistinguishable from "OK with high confidence" — i.e. when
the implicit SUSPECT marker has earned its first-class promotion.
Coordinate the schema change with the `anatoly-bench` scorer at the
same time.

## 10. Empirical findings + closure (2026-05-20)

Five experiments executed on the slot-engine fixture against the
v33/v34/v35 baseline (correction f1 0.615). Summary of runs (cost
totals approximate, all on the bench VM with `--no-cache`):

| Run | Variable | correction f1 | INV recovered | Decision |
|---|---|---|---|---|
| v33-35 | baseline | 0.615 (4tp/2fp/3fn) | — | reference |
| v36-exp-4.0a | remove phantom rule 10 | 0.667 (4tp/1fp/3fn) | 0 (precision lift only) | **KEEPER** |
| v37-exp-4.BD | + OK-challenge + drop OK conf floor | 0.667 (run-1 SDK socket noise, see transport fix) | 0 | reject |
| v37bis-exp-4.BD | same, after transport fix | 0.667 (4tp/1fp/3fn) | 0 | reject (= 4.0a, no incremental value) |
| v38-exp-4.A'' | add rule 13 (domain sanity-check) | 0.615 (4tp/2fp/3fn) | 0 | reject (rule 13 fired on non-catalog symbols) |
| v39-exp-4.A''' | re-frame REFERENCE DOCS header AUTHORITATIVE → informational | 0.533 (4tp/4fp/3fn) | 0 | reject (more noise, no recall move) |
| v40-exp-opus | swap correction model Sonnet 4.6 → Opus 4.6 (off-plan exploration, §8 non-goal) | 0.429 (3tp/4fp/4fn) | 0 catalogued, 1 mechanically | diagnostic — see below |

### 10.1 The Opus diagnostic (v40)

Opus on correction did NOT score higher (0.429 vs 0.667), but it
demonstrated something Sonnet never did across the five preceding
experiments:

> `evaluateLine` (engine.ts:86) — "Formula `basePayout * (1 + wildCount)
> * 2 ** wildCount` yields: 1 wild → 4×, 2 wilds → 12×, 3 wilds → 32×.
> For DIAMOND 5-of-a-kind with 3 wilds: 1000 × lineBet × 32 = 3200×
> total bet from a single line..."

This IS rule 13 executing as designed: plausible input plugged, output
mentally computed, compared to domain norm, conclusion absurd. Opus
did the same on `weightedPick` (`Math.random()` + RTP justification).
**Sonnet 4.6 never deployed rule 13 this way across 4 experiments.**

Why it still scored worse:
- Opus flagged the wild bug at the **consumer** (`evaluateLine`) rather
  than the **source** (`applyWildBonus`) — violating rule 10
  (renumbered after §4.0a). Scorer can't credit INV-WILD when the
  file address is wrong.
- Opus lost INV-WEIGHTS that Sonnet catches in baseline (regression).
- INV-JACKPOT and INV-FREESPIN still invisible to Opus too — those
  bugs do not surface via numerical derivation; they require
  behavioral reasoning the model does not deploy from the prompt as
  written.

### 10.2 What we have empirically established

1. **The recall ceiling on INV-WILD/JACKPOT/FREESPIN is not a prompt
   bug on the Sonnet path.** Five prompt-side experiments (4.0a /
   4.BD / 4.A'' / 4.A''' / Opus model swap) failed to move recall.
2. **Rule 13 (domain sanity-check) is mechanically correct but
   model-bound.** Opus deploys it as designed; Sonnet 4.6 does not.
   The prompt is not the binder for the Sonnet ceiling.
3. **Rule 10 (flag source, not consumer) is the next mechanical
   layer**, surfaced by Opus violating it. Worth a future experiment
   if anyone benches with Opus on a sustained basis.
4. **INV-JACKPOT and INV-FREESPIN are categorically different**
   from INV-WILD: not numerical, behavioral. They require either
   industry-norm injection (which would be prompt-tuning to fixture)
   or a model that deploys behavioral reasoning from "function name +
   state mutation pattern". Both out of scope here.
5. **The 4.0a precision lift is real and stable.** Two runs (v36,
   v37bis) at correction f1 0.667 with no regression elsewhere. Net
   +0.052 vs baseline, zero downside.
6. **The transport socket-retry fix is an independent real bug**
   surfaced by v37 — keepers it regardless of the F1 work.

### 10.3 Capitalization

Branch `exp/correction-4.0a` carries 6 commits. Of those:

- **Keepers (to be merged to main):**
  - `720c38d` — `exp(correction): doc 20 §4.0a` (remove phantom rule
    10 from 3 axis prompts). Stable precision lift.
  - `b90302b` — `fix(transport): retry transient socket/network
    errors with backoff`. Independent real bug.
  - `3d2e858` — `docs(doc 20): §9 follow-ups - log pass-2 vs tier-3
    partial overlap`. Documentation-only follow-up.

- **Rejected experiments (preserved on the branch as historical
  record, do NOT merge to main):**
  - `5c37f4f` (§4.BD), `8db1095` (§4.A''), `ea0d628` (§4.A''') —
    null/negative on the named misses.

### 10.4 Closed risks + non-goals confirmed

- §7 risk #1 ("Slot-engine is the only fixture; a win on
  INV-WILD/FREESPIN/JACKPOT may be slot-engine-specific") is partially
  resolved by §10.1: the bugs are not even reachable on the only
  fixture with Sonnet, so the question of generalization across
  fixtures is moot until either the model or the fixture changes.
- §8 non-goal "No model swap" is empirically validated as the right
  call: v40 showed model swap is a separate axis of variance with its
  own trade-offs (Opus catches the wild formula mechanically but
  loses INV-WEIGHTS and violates rule 10). A clean model-swap study
  would need its own plan.

### 10.5 Follow-ups not consumed here (carried forward)

- **§9.1** (pass-2 vs tier-3 partial overlap) — still parked.
- **§9.2** (explicit SUSPECT verdict) — still parked.
- **Rule 10 enforcement on Opus**: surfaced in §10.1. Worth its own
  plan if Opus becomes a sustained correction model.
- **INV-JACKPOT / INV-FREESPIN nature**: behavioral, not numerical.
  Open question whether any prompt-side experiment can recover them
  without injecting fixture-specific industry norms.

## 11. Status: closed

This plan is closed for slot-engine correction recall. The keepers
identified in §10.3 are the deliverables. The remaining INV misses
are documented as structurally beyond the prompt-tuning lever on this
model/fixture combination.
