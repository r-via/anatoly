# 23. User-Flow Modeling (Application Finality Substrate)

Status: design, not implemented. Spec-first. v1 is DESCRIPTIVE only. The evaluative conformance check is deferred, but section 6 shows it now falls out of the existing code-vs-doc machinery instead of needing a new axis.

## 0. Origin

To refine Anatoly we need a representation of what an application is FOR, not only judgments of its parts. The seven axes and the invariants phase all reason bottom-up: they look at a symbol or a symbol pair and judge it locally. None of them models the parcours: how an external actor enters the system, what path the code takes, and what the run is meant to accomplish. That higher-level object, the user flow, is the substrate on which a human can arbitrate the finality (finalite) of the code, and later check it against business expectations.

This doc specs the FIRST, descriptive half only: extract the as-implemented user flows from the code and present them as a generated documentation page. It deliberately stops before any conformance judgment, because the tool may not invent intent it cannot read from the code.

### 0.1 Why descriptive-first (the founding constraint applies)

Doc 22 section 0.2 establishes that orphaned-vs-cruft is structurally undecidable by the tool because intent is not in the code. The same holds for finality: what an application is supposed to do lives in business expectations, an external artifact, not in the source. So a flow check that judged business alignment with no supplied expectation would be the highest false-positive surface in the whole tool. v1 therefore produces no findings. It extracts and presents. A human reads the flow page and arbitrates; the tool qualifies and surfaces, it does not decide (doc 22 section 7).

### 0.2 Lineage: this is the next inter-representation step

The invariants phase already checks inter-representation consistency: code-vs-code (same quantity, divergent literal) and code-vs-doc-numeric (`src/core/orchestration/phases/invariants.ts`). The doc-conflict pipeline (doc 16) checks code-vs-reference-doc. The user flow is the substrate for the next pair, code-vs-business-intent, the most semantic one. v1 builds the substrate (a flow page). The conformance pair is not a new axis: once the page is ratified by a human it becomes an internal doc, and the existing code-vs-doc machinery already checks code against it (section 6).

## 1. What a user flow is (the model)

A user flow is a named path from an entry point through the code to its terminal effects, plus the finality (what the path accomplishes) inferred from the code. It exists in two representations:

- a structured skeleton (machine-readable, for the dead-intent router and the future conformance matcher), and
- a generated documentation page (human-readable, ratifiable, the primary deliverable).

```
UserFlow := {
  id, name,                         // stable id + a human label ("Place a bet and settle payout")
  finality,                         // one sentence: what the path accomplishes, inferred from code
  entry:   { file, symbol, kind },  // where an external actor enters (route, handler, CLI cmd, public API, UI action)
  steps:   [{ file, symbol, role }],// the ordered path (call/data edges) through project symbols
  effects: [{ file, symbol, kind }],// terminal side effects (persistence, response, emitted event, state mutation)
  confidence,                       // how cleanly the skeleton resolved (deterministic), NOT a verdict
  unwired                           // entry resolved but the path dead-ends with no effect (dead-intent signal)
}
```

The model is descriptive. `finality` is a narration of the code, not a claim about what the code SHOULD do. There is no verdict field and no expectation field in v1.

## 2. The raw material already exists

Almost all of the skeleton is derivable from data Anatoly already indexes; no new scan pass is needed.

Cross-file reference graph (the edges of every flow):

- forward edges: `FunctionCard.referencedImports` (`src/rag/types.ts:52`) records, per symbol, the OTHER-file project symbols it imports and references in its body.
- same-file edges: `FunctionCard.calledInternals` (`src/rag/types.ts:42`).
- reverse edges (importers): `UsageGraph.usages` (`src/core/scanning/usage-graph.ts:17-19`), with barrel-aware transitive resolution via `getTransitiveImporters` (`src/core/scanning/usage-graph.ts:750`).

Together these give a complete bidirectional cross-file symbol graph, already in memory after the RAG and scan phases.

Entry-point signal (roots of the flow):

- an exported symbol that is a ROOT of the reference graph (few or zero project importers) is where an external actor, not another project symbol, calls in. The usage graph already knows importer counts.
- `behavioralProfile` (`src/rag/types.ts:14-21,40`): an entry that is `sideEffectful` or `async` is the classic request/command boundary.
- kind / name conventions: route handlers, CLI command symbols, exported public API, event subscribers.

Terminal effects (the leaves):

- `behavioralProfile` `sideEffectful` (I/O, external mutation) and `stateful` cards are the persistence / emit / response leaves of a path.

Semantic vocabulary (for naming the flow):

- `FunctionCard.summary` (`src/rag/types.ts:37`, the LLM behavioral summary) and `keyConcepts` (`src/rag/types.ts:39`) already carry the domain words. The flow name and finality reuse them, so the narration starts from indexed context, it does not re-read the world.

This is the same deterministic-context-then-LLM-validates shape every axis uses: build a grounded skeleton mechanically, let the LLM narrate, never guess.

## 3. Delivery: through the existing doc scaffold, not a bespoke phase

The earlier draft of this doc proposed a new phase in `anatoly run` plus a bespoke `flows.json` plus a new report section. That is the wrong sink. A user flow is a description of the application, so it belongs where descriptions of the application already live: the `.anatoly/docs/` documentation set, written by the existing `anatoly docs` pipeline (`runDocScaffold` then `runDocGeneration` then `commitDocPage`, see `src/core/orchestration/phases/doc.ts:42`).

Delivering the flow model as a generated doc page is strictly better, because an internal doc page inherits, for free, four mechanisms a bespoke artifact would have to reinvent:

- the documentation axis judges the code against it,
- the doc-conflict pipeline (doc 16, code-vs-reference-doc) detects when code and the page diverge,
- RAG indexing makes it a retrievable doc section,
- `anatoly docs arbitrate` gives it a human ratification path.

The flow page is added to the scaffold as one more `PageDef` (`src/core/documentation/generation/doc-scaffolder.ts:26-32`), most naturally an Architecture page (for example `02-Architecture/06-User-Flows.md`), optionally type-gated through `TYPE_PAGES` for CLI / Backend API / Frontend projects. The scaffold never overwrites an existing page (`doc-scaffolder.ts:154-157`), so once a human edits a flow page the regeneration leaves it intact: ratification is preserved automatically.

### 3.1 Stage 1: deterministic skeleton, as grounding (no LLM)

The skeleton walk survives unchanged as the extraction step, but its role becomes grounding the page generation rather than producing a standalone artifact.

- enumerate entry-point candidates from the reference-graph roots plus `behavioralProfile` plus conventions.
- for each entry, walk the forward edges (`referencedImports` / `calledInternals`) to a bounded depth, collecting steps and terminal effects; stop at leaves or a depth cap (FP and cost bound, mirrors the invariants caps `invariants.ts:79-96`).
- mark `unwired` when an entry resolves but its path reaches no effect (a candidate dead-intent flow).

The resulting skeletons are injected into the flow page's generation prompt the same way the doc writer is already grounded: the writer receives a `codeSurface` summary (`src/core/documentation/generation/doc-llm-executor.ts:679`) and type-specific context sections (`src/core/documentation/generation/doc-type-context.ts`). The flow skeletons are one more grounding block (a dedicated context provider, or a `sourceHints` entry for the flow page). This is what keeps the LLM in the narrate role: without the deterministic skeleton, a free-running doc writer would hallucinate entries and paths from reading files, violating I2 and I3.

### 3.2 Stage 2: the doc pipeline narrates the page

The existing `runDocGeneration` writes the flow page from the injected skeleton plus the cards' `summary` and `keyConcepts`. The page lists each flow's name, finality, entry, ordered steps, and terminal effects, with unwired flows called out as "entry without terminal effect: candidate dead intent (decide: wire up or remove)". The writer is told explicitly NOT to assert what the code should do (no expectation exists in v1). Default behavior on an unclear skeleton is a terse literal name, never an invented purpose. No new LLM transport is introduced: it is the same agentic Read-only doc writer (`doc.ts:97-108`).

### 3.3 A thin structured sink for the router

A doc page is prose, lossy against the structured graph. The one consumer that needs the structure, not the prose, is the dead-intent router (section 5): it consumes the `unwired` boolean per flow, which a paragraph cannot feed. So Stage 1 also emits a small machine-readable artifact (the `UserFlow` skeletons, written under the doc 19 run-artifact layout) carrying at least `id`, `entry`, `unwired`, and `confidence`. This is a thin internal artifact for the router and the future conformance matcher, not the human deliverable, and it is not surfaced as a finding.

## 4. Output: a generated page plus a thin artifact

Two sinks, both additive and bench-neutral:

1. The generated `.anatoly/docs/` flow page (the primary, human-readable, ratifiable deliverable), produced by the existing doc pipeline. It is an internal doc, so it is automatically indexed, judged by the documentation axis, and watched by doc-conflict.

2. The thin structured artifact (section 3.3): the `UserFlow` skeletons for the dead-intent router and the future conformance input.

No symbol verdict changes, no scored finding is emitted in v1. The flow page is the descriptive analogue of the doc-22 "Decisions" zone: it shows the reader the shape of the app and where intent is unresolved, and asks a human to conclude.

## 5. Synergy: this makes dead-intent decidable

Doc 22 section 0.2 says the tool cannot separate an orphaned subsystem (finished, forgot to wire) from cruft (abandoned) because intent is not in the code. The flow skeleton is exactly where intent starts to be captured:

- a dead exported symbol (utility `DEAD`) that the skeleton shows as the unwired entry of an otherwise-coherent flow is orphaned: the path exists, only the entry wiring is missing. That is the doc-22 "rich orphan, decision action" case (doc 22 section 2.2), now backed by structural evidence instead of a per-symbol heuristic.
- a dead symbol that participates in no flow at all leans cruft.

So doc 23 v1 strengthens the doc 22 Fil #1 routing signal (specifically the internal-subsystem-cluster signal doc 22 section 2.4 left optional) with a real flow graph. The two docs land compatibly: the flow `unwired` flag (from the section 3.3 artifact) feeds the `dead_intent` routing.

## 6. The conformance bridge falls out of code-vs-doc

This is the payoff of delivering as a doc page rather than a bespoke artifact. The deferred evaluative half (code-vs-business-intent) does NOT require a new eighth axis. The sequence is:

1. v1 generates a descriptive flow page (as-implemented).
2. a human edits that page to encode the real business expectation (the path that SHOULD exist, the finality the business wants). This is the ratification step, and it is the supplied expectation source that doc 22 and section 8 say cannot be invented by the tool. The human supplies it.
3. the page is now a ratified internal doc that asserts intent. The existing code-vs-doc machinery (the documentation axis and the doc-conflict pipeline, doc 16) already checks the code against internal docs. Divergence between the ratified flow page and the code IS the conformance finding, surfaced through the channel doc 16 / doc-22 already use.

So conformance is not a new build; it is the existing code-vs-doc pair applied to a human-ratified flow page. v1 only has to make the descriptive page reliable and ratifiable. The scaffold's never-overwrite property (section 3) is what makes the ratified page survive regeneration.

## 7. Invariants (FP-safety and bench-neutrality)

- I1. v1 emits zero scored findings and changes zero axis verdicts. F1 is unaffected by construction. A generated doc page and a thin structured artifact are invisible to the bench, exactly like the doc-22 descriptive surfaces. (Conformance findings, section 6, only appear once a human ratifies a page; that is opt-in and post-v1.)
- I2. The skeleton is deterministic: the same index plus the same source produce the same skeletons. No randomness, hermetically testable without an LLM (the walk is pure graph code; the page narration is replay or synthetic-fixture tested, per the no-real-LLM-in-tests rule).
- I3. The narration never asserts a finality the code does not support; on an unclear skeleton it falls back to a literal name. No invented business purpose.
- I4. RAG off, or no vector store: zero skeletons, no flow page content beyond the scaffold stub (accepted), same posture as the invariants no-op gate (`invariants.ts:247`).
- I5. All caps (entry count, walk depth, flows per page, grounding size) are conservative and explicit, mirroring the invariants tuning block (`invariants.ts:51-96`).
- I6. The flow page is generated by the existing doc pipeline; it introduces no new LLM transport and reuses the agentic Read-only doc writer (`doc.ts:97-108`).

## 8. Sequencing

1. Stage 1 skeleton walk plus the thin structured artifact (section 3.3), no LLM. Delivers the machine-readable model and the dead-intent `unwired` signal on its own.
2. The flow `PageDef` plus the skeleton-grounding context provider, so `anatoly docs` generates the human-readable flow page (Stage 2 narration through the existing pipeline).
3. Wire the `unwired` flag into the doc-22 Fil #1 `dead_intent` routing (compatibility, not a new finding).
4. (Post-v1, no new code) Document the ratification workflow of section 6, so a human can turn a descriptive flow page into a ratified expectation that the existing code-vs-doc machinery checks.

## 9. Non-goals

- v1 does NOT check flows against business expectations automatically. There is no auto-supplied expectation source; the expectation is supplied only by a human ratifying the page (section 6). Until a page is ratified, v1 is purely descriptive.
- v1 does NOT decide orphaned vs cruft. It supplies the structural evidence (the flow skeleton) that lets a human, and the doc-22 router, decide better.
- v1 adds no new scan pass. If the existing reference graph proves insufficient for entry-point detection in some stack, extending the indexer is tracked separately.
- v1 introduces no new run phase. Flow pages are generated by `anatoly docs` (scaffold then generation), and the audit run consumes them through the existing documentation axis and doc-conflict pipeline. This is a cleaner split than a flow phase inside `anatoly run`.
- No cross-repo bench change in v1. Should a future iteration score ratified-flow conformance findings, those flow through the existing axis/divergence channels; any bench scoring of them is additive work in `anatoly-bench`.

## 10. Open items (per-stage detailing)

- Stage 1: the exact entry-point predicate (root-of-graph plus `behavioralProfile` plus which name/kind conventions per language), and the walk depth cap.
- Stage 1: how to group a coherent cluster (the doc-22 section 2.4 internal-subsystem signal) so a flow is one parcours, not one symbol.
- Stage 1: the exact shape and location of the thin structured artifact (section 3.3) under the doc 19 layout, and its Zod schema.
- Delivery: which `PageDef` slot and section the flow page occupies, and whether it is base or type-gated (`doc-scaffolder.ts:35-111`).
- Delivery: the grounding seam for the skeleton (a dedicated context provider in `doc-type-context.ts` versus a `sourceHints` entry), and the grounding size cap.
- Stage 2: the page template (the headings and per-flow layout) and the fallback wording when finality is unclear.
- Section 6: the ratification workflow doc (how a human marks a flow page as a ratified expectation, and how doc-conflict treats it).
