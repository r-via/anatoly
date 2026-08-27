# 22. Finding Family and Dead Intent

Status: design, not implemented. Spec-first. Three threads (Fil #1, #2, #3) sequenced below.

## 0. Origin

Two reflections from a real run (`audio-app`, v0.9.6, run `2026-06-13_131930`) motivate this doc.

**Reflection #1 (axis overlap).** The best-practices axis listed items that look like duplication or dead code. Is best-practices redundant with the duplication and utility axes?

**Reflection #2 (dead-code intent).** LLM-written code is often left unwired at the end. When the tool reports "dead code", it would be valuable to distinguish a final wiring omission (orphaned, intended to live) from genuinely abandoned code (cruft, intended to die).

The investigation produced two findings that reframe both reflections.

### 0.1 There is no instance-level redundancy

Cross-referencing the actual findings of the run showed zero overlap between what best-practices reports and what utility or duplication report:

- utility and duplication operate on whole top-level or exported symbols. utility reports a dead exported symbol via the usage graph (0 importers). duplication reports two whole symbols in different files that are semantically the same.
- best-practices uniquely catches sub-symbol structural hygiene: a dead import, a dead local variable, an intra-function duplicated block. None of these are a whole exported symbol, so they are structurally invisible to utility and duplication.

This matters more than it looks because the host project had `@typescript-eslint/no-unused-vars: off`. With that lint rule disabled, the best-practices axis is the only net that catches dead imports at all. So best-practices is not redundant; it is the only axis operating at sub-symbol granularity.

The real problem is not redundancy, it is **signal credibility**. best-practices mixes high-value structural findings (dead import, swallowed error, unhandled promise) with low-value style opinion (prefer `readonly`, prefer `satisfies`, JSDoc churn, import ordering). The good signal inherits the low credibility of the noise around it, so a reader discounts the whole axis.

### 0.2 The orphaned-vs-cruft distinction is structurally undecidable by the tool

Take `getBufferConfig` and `getEffectsConfig` from the run: a complete, coherent subsystem with no importer. Two opposite readings produce the exact same static signature:

- **Orphaned**: finished code, the dev forgot to wire the entry point. Correct action: wire it up.
- **Cruft**: abandoned code, superseded or left over from a refactor. Correct action: remove it.

Nothing in the usage graph, the confidence, or the symbol body separates the two. The static signature plus the usage graph is everything the tool has, and that input set is genuinely insufficient. So the tool cannot auto-arbitrate, and it must not blind-delete: deleting an orphan destroys finished work, while keeping cruft costs almost nothing.

But "undecidable" is relative to the tool's inputs, not absolute. The primary consumer of these findings is an agent that iterates over them and fixes the repo. That agent has inputs the static pass does not: git history (recently added and unwired leans orphan, long-unused leans cruft), repo-wide structure (a missing entry next to wired siblings in a router, registry, or barrel is a strong orphan signal), and the ability to search for a live replacement doing the same job (which makes this one cruft). The agent can therefore resolve most of these cases. The tool's job is not to decide for it; the job is to stop the reflex delete and hand the agent a procedure plus a safe default. This is the founding constraint of Fil #1, and it is detailed in 2.2.

## 1. The unifying model: finding_family

The seven axes answer "which lens produced this finding". They do not answer "what kind of problem is this". Those are different questions, and conflating them is the root of the perceived overlap.

Introduce a second, orthogonal dimension, the **finding family**, describing the nature of the problem independent of the axis that surfaced it:

| finding_family | meaning | axes that can produce it |
|----------------|---------|--------------------------|
| `dead-code` | code that is not reached or not wired | utility (whole symbol), best-practices (dead import, dead local) |
| `duplication` | the same logic in two places | duplication (cross-file symbol), best-practices (intra-symbol block) |
| `robustness` | a real defect or fragility (swallowed error, unhandled promise) | correction, best-practices |
| `style` | a stylistic or convention preference, no behavioral effect | best-practices |
| `security` | a security-relevant issue | best-practices, correction |

The family is the lens through which the reader filters. It says: a dead import (best-practices) and a dead exported symbol (utility) are *the same kind of problem at two granularities*, not two unrelated findings from two axes. The axis stays as provenance; the family is the new grouping key.

This model is the spine. The three threads below are concrete applications of it.

### 1.1 Bench-neutral invariant (applies to all three threads)

The sibling `anatoly-bench` scorer matches a finding by `axis`, `verdict`, and anchor (file, symbol or line). None of the three threads may change the `axis` or the `verdict` of a finding that the scorer already matches. They may only:

- add descriptive fields (`dead_intent`, `suggestions[].kind`, `finding_family`),
- change the **shape and routing** of synthesized actions (category, wording, section),
- change the prompt so best-practices emits the same structural finding under a clearer tier.

Concretely: utility keeps `verdict: DEAD` on every dead symbol it reports today. We never demote a DEAD verdict to make the orphaned case "softer". The decision-vs-quickwin distinction is an action-shape change, not a verdict change. F1 is therefore protected by construction.

## 2. Fil #1: Orphaned vs cruft, and the `decision` action

### 2.1 Where the logic lives

For exported dead symbols, the utility axis does **not** call the LLM. `autoResolveSymbol` (`src/core/evaluation/axes/utility.ts:131`) resolves exported 0-importer symbols deterministically to `DEAD` at high confidence. The DEAD action is then synthesized post-merge in `synthesizeActionsFromSymbols` (`src/core/evaluation/axis-merger.ts`, DEAD block around lines 326-337). That synthesis seam is where the orphaned-vs-cruft routing must live, because the LLM is never in the loop for these symbols.

### 2.2 The tool routes and equips, it does not decide

The classifier must not pretend to know intent. It does not emit `orphaned` vs `cruft` as if it had resolved the ambiguity. It emits a **disambiguation signal** and routes to one of two action shapes:

| Case | Signals | dead_intent | Action shape |
|------|---------|-------------|--------------|
| Rich orphan | kind is component or function, wide line span, default export, or a coherent cluster of internal helpers called only by each other | `undecided` | `category: 'decision'`, severity medium, wording "Decide: wire up or remove", carries a resolution protocol, never a trivial quickwin |
| Trivial cruft | kind is variable or const, short span, thin wrapper | `cruft` | `category: 'quickwin'`, wording "Remove dead code" (unchanged from today) |

The deterministic classifier only **routes**. On the rich case it refuses to guess intent and instead hands the consumer a procedure (2.2.1). On the trivial case the cost of a wrong delete is approximately zero, so we keep the assumed-removal quickwin.

This directly removes the trap of Reflection #2: the run currently emits "Remove dead code: SessionInspector" for a 94-line default-export component at confidence 70. Under Fil #1 that becomes a `decision` action ("wire up or remove"), not a delete quickwin.

#### 2.2.1 The decision action carries a resolution protocol

The primary consumer of a `decision` action is an agent iterating over findings, not only a human reading a report. "Wait for a human" is therefore not an adequate payload: the agent has to act, and it has inputs the tool lacks. So the `decision` action carries a `resolution_protocol`: an ordered, executable procedure plus a safe default. The procedure exploits exactly the inputs the static pass does not have:

1. **Git recency.** Inspect the symbol's history. Recently added and never wired leans orphan (wire it). Long-present and unused leans cruft (remove it).
2. **Wiring-site search.** Look for the place where siblings of the same kind are registered (router, registry, barrel, parent component). A missing entry next to wired siblings means orphan: add the entry.
3. **Replacement search.** Look for a live symbol doing the same job. If one exists and is wired, this symbol is cruft: remove it.
4. **Safe default.** If steps 1 to 3 do not resolve it, keep the symbol and leave a TODO or flag. Never delete under residual uncertainty.

Step 4 rests on an asymmetry of cost that governs all behavior under doubt: deleting a finished-but-unwired feature destroys real work, whereas keeping cruft costs a few dead lines. The non-destructive choice is therefore always the default when the signal is ambiguous. This is the precise reason the rich case must never be a blind delete quickwin.

For an agent workflow this also defines a third bucket distinct from the other two. A `decision` action is neither a quickwin to apply (do not delete) nor a residual false positive to discard (do not ignore): it is an item to investigate with the protocol, biased non-destructive. The genuinely irreducible case (no history signal, no wiring site, no replacement) is the only one that escalates to a human, and even there the safe move is keep-and-flag.

This keeps responsibilities cleanly split. The tool stays deterministic and cheap: it flags and equips. The context-heavy reasoning (history, repo-wide search) runs in the consumer agent, which already holds the repo and the budget for it.

### 2.3 The `decision` action category

Add `decision` to `CategorySchema` (`src/schemas/review.ts:110`, today `z.enum(['quickwin', 'refactor', 'hygiene'])`). The render layer buckets actions by category into report sections (`src/core/reporting/render-axis.ts`, the `byCategory` record near line 438 and the section rendering near lines 551-570, plus the TOC entries near lines 443-445). Adding the enum member forces the `Record<Category, ...>` to carry a `decision` bucket, which surfaces as a new report section, for example "## Decisions" with an icon, listing items that need investigation before action.

A `decision` action carries the resolution protocol of 2.2.1 in its detail text (the ordered steps and the non-destructive default), so any consumer, agent or human, has the procedure to resolve it rather than a bare "wire up or remove". The exact field shape (a free-text detail versus a structured `resolution_protocol` payload) is a Fil #1 detailing item; the content is fixed by 2.2.1.

The `decision` section is the action-list analogue of the existing "Divergences code-vs-reference" section: a dedicated zone that separates "the tool concluded" from "the consumer must resolve". A reader or agent scanning the report sees at a glance which items are settled and which need the protocol run.

### 2.4 Signals available at the seam

The symbol card carries `name`, `exported`, `is_default`, `line_start`, `line_end`, `kind`, `confidence`. Derived signals for routing:

- span = `line_end - line_start` (rich if above a threshold to be fixed in Fil #1 detailing),
- `kind in {component, function}` leans rich; `kind in {variable, const, type}` leans trivial,
- `is_default` leans rich (default exports are the classic unwired-component case and also the case where static analysis is least certain, which is why confidence is already reduced to 70 on them),
- a coherent internal subsystem (a set of non-exported helpers referenced only by each other, with one unwired entry point) leans rich. Detecting this cluster is the one signal that may need more than the per-symbol card; it is deferred to Fil #1 detailing and is optional for a first cut.

The exact thresholds (span cutoff, kind weighting) are the remaining open item for Fil #1 and are intentionally not frozen here.

## 3. Fil #3: Raise sub-symbol hygiene to first class (the pivot)

This is the pivot thread because it is what makes best-practices worth keeping and what closes the granularity gap identified in 0.1.

### 3.1 The problem

best-practices emits free-text `suggestions[]` shaped `{ description, before, after }` (untyped). Inside that untyped bag sit the only sub-symbol structural findings the whole pipeline produces: dead imports, dead locals, intra-symbol duplicated blocks. Because they are untyped free text, they cannot be promoted to quickwins, cannot be grouped under the `dead-code` or `duplication` family, and cannot be ranked above style chatter. They drown.

### 3.2 The change

Add a typed discriminator to suggestions: `suggestions[].kind`, an enum over the families plus a residual:

`dead-import | dead-local | dup-block | robustness | style`

The LLM already produces these as free text; the change asks it to tag each suggestion with its kind. Then the synthesis layer promotes the structural kinds:

| kind | family | promotion |
|------|--------|-----------|
| `dead-import` | dead-code | quickwin, "Remove unused import" |
| `dead-local` | dead-code | quickwin, "Remove unused local" |
| `dup-block` | duplication | refactor, "Deduplicate block" |
| `robustness` | robustness | keep as best-practices suggestion, but tag family for filtering |
| `style` | style | stays in the hygiene tier (see Fil #2) |

The structural kinds become first-class actions in the report, grouped by family, sitting next to the whole-symbol findings from utility and duplication. A reader filtering on the `dead-code` family now sees both "dead exported symbol" (utility) and "dead import" (best-practices) together, which is the correct mental grouping.

### 3.3 Why this is bench-neutral

The bench scores axis findings at the file or symbol or line anchor with an axis and a verdict. best-practices today does not produce a scored `verdict` per suggestion (it produces a file score and free-text suggestions), so promoting a suggestion to a typed quickwin does not move a verdict the scorer already matches. The promotion changes the report surface and the action list, not the axis verdicts. If a future bench iteration starts scoring dead-import findings, that is an additive scorer change in the sibling repo and is out of scope here.

## 4. Fil #2: De-noise best-practices

With the structural signal extracted by Fil #3, the residue of best-practices is style and convention opinion. Fil #2 makes that residue quiet by default so it stops discrediting the structural signal.

Four levers.

### 4.1 Lever A: tier the rules

The 17-rule checklist (`src/prompts/axes/best-practices.system.md`, table at lines 13-29) mixes structural rules with stylistic ones at similar penalties. Split into two tiers:

- **Structural tier** (stays prominent): 1 strict mode, 2 no `any`, 8 ESLint, 12 async and error handling, 13 security, 14 performance. These map to the `robustness` and `security` families and carry real behavioral weight.
- **Hygiene tier** (demoted, reported quietly): 3 discriminated unions, 4 utility types, 5 immutability (`readonly`, `as const`), 6 interface-vs-type, 9 JSDoc on public exports, 11 import organization (the import-ordering portion only; circular and side-effect imports stay structural), 16 TypeScript 5.5+ features (`satisfies`, const type params). These map to the `style` family.

The host run's own triage (`FAUX_POSITIFS_BEST_PRACTICES.md`) confirms the split: the kept-as-noise items were exactly readonly/satisfies/as const/JSDoc/import-order churn; the applied items were dead imports, swallowed errors, unhandled promises, real dedup.

### 4.2 Lever B: family tagging

Tag every best-practices suggestion with its `finding_family` (via the Fil #3 `kind`). The report can then group or filter by family, so a reader who wants only robustness and security can hide style entirely.

### 4.3 Lever C: vendored provenance

best-practices currently scores vendored or generated files (for example shadcn UI primitives) against the same rules as first-party code, producing penalties no one will act on. The pipeline already has a whole-file provenance notion: `propose-excludes.ts` `ExcludeCategory` (`'fixture' | 'generated' | 'example' | 'vendored'`, line 26) and the `is_generated` flag consumed in `review-writer.ts:118`. Lever C: when a file is vendored or generated, best-practices suppresses style-tier suggestions for it (structural and security tiers may still fire). This is whole-file granularity, which is sufficient for vendored UI kits.

### 4.4 Lever D: style tier is reported, never an action

Style-tier rule failures produce report notes, never synthesized actions. They inform the file score and appear in a quiet "style notes" view, but they do not generate a quickwin, refactor, or decision. This is the lever that most directly answers "the axis is noisy": the noise stays visible to anyone who wants it, and disappears from the action list everyone reads.

## 5. Sequencing

1. **Fil #1** first. Smallest, self-contained, adds the `decision` category and the orphaned routing. Delivers the Reflection #2 win (no more reckless delete of unwired components) on its own.
2. **Fil #3** second, the pivot. Adds `suggestions[].kind` and the structural promotions. This is what justifies keeping best-practices and what closes the granularity gap. Everything downstream depends on the typed kind existing.
3. **Fil #2** last. With structure extracted by Fil #3, de-noising is mostly demotion and suppression of what remains. Doing it before Fil #3 would risk demoting structural signal still trapped in the untyped bag.

## 6. Invariants

- I1. utility keeps `verdict: DEAD` on every symbol it reports DEAD today. Fil #1 never demotes a verdict.
- I2. A rich orphan produces exactly one `decision` action and zero `quickwin` delete actions for that symbol. The `decision` action carries the resolution protocol of 2.2.1 (the ordered steps and the non-destructive default), not a bare "wire up or remove".
- I3. A trivial cruft symbol produces the same `quickwin` "Remove dead code" action it produces today (no behavior change for the easy case).
- I4. A best-practices suggestion tagged `style` produces zero synthesized actions; tagged `dead-import` or `dead-local` it produces exactly one quickwin; tagged `dup-block` exactly one refactor.
- I5. A vendored or generated file produces zero style-tier actions.
- I6. No thread changes any `axis` value or any scored `verdict` that the bench already matches. F1 is unaffected by construction.
- I7. Every change is hermetically testable without a real LLM call: Fil #1 and the promotions are deterministic synthesis over symbol or suggestion cards; the prompt changes are validated by replay or synthetic fixtures.

## 7. Non-goals

- The tool never decides orphaned vs cruft on the rich case. It routes and equips: it flags the symbol as a `decision` and hands over the resolution protocol of 2.2.1. The decision itself is taken by the consumer (an agent running the protocol, a human on the irreducible residue), never by the tool.
- **No `anatoly utility arbitrate` command.** The docs subsystem has `anatoly docs arbitrate` because a doc-conflict resolution is a *remembered verdict the tool reconsumes*: choosing which side is authoritative changes context injection on later runs, and the doc and code coexist (picking a winner does not edit either), so the verdict must persist in `doc-conflicts.yaml`. The orphan decision is the opposite: both outcomes (wire, remove) are *code edits the consumer makes*, and the next run observes the new reality directly through the usage graph (a wired symbol gains importers and reads USED; a removed symbol is gone). There is no verdict to persist or reconsume, so no arbitration ledger and no arbitrate command. The de-poisoning that the doc-conflict gate needed is already covered here too: a `DEAD` verdict already silences correction, tests, documentation, and overengineering on that symbol through the existing cross-axis coherence rules (DEAD preserves only duplication), so no arbitration-driven context change exists to manage.
- The "intentionally pending, stop re-flagging it" orphan is out of scope for the first cut. That case wants state across runs, but it is a *suppression or acknowledgment* primitive (an ignore-list or an `anatoly utility ack <symbol>`, a single-sided "I know, leave it"), not an arbitration (there are no two sides to weigh). It is added only if recurring `decision` noise on a deliberately unwired symbol becomes a real annoyance, and it is tracked as an open item, not part of Fil #1.
- No cross-repo bench scorer change is in scope. If a future bench iteration scores dead-import or dup-block or doc-conflict findings, that is additive work in `anatoly-bench`, tracked separately.
- Intra-symbol block-duplication detection beyond what best-practices already emits as free text is out of scope. Fil #3 only types and promotes what the axis already finds; it does not add a new detector.
- The internal-subsystem cluster signal in 2.4 is optional for the first cut of Fil #1; per-symbol signals (span, kind, default-export) are sufficient to ship.

## 8. Open items (to fix in per-thread detailing)

- Fil #1: the exact span threshold and the kind weighting that route rich vs trivial. The internal-cluster detector, if built, and where it reads from.
- Fil #3: the residual `style` kind boundary (what counts as structural enough to promote vs what stays style).
- Fil #2: whether the style tier is suppressed entirely on vendored files or only demoted, and whether the file score still reflects style failures or ignores them.
- Suppression primitive (deferred): if a deliberately unwired orphan keeps re-surfacing as a `decision` every run, design a single-sided acknowledgment (ignore-list or `anatoly utility ack <symbol>`) to silence it across runs. Distinct from arbitration; only built on demonstrated need.
