# 23. User-Flow Modeling (Application Finality Substrate)

Status: design, not implemented. Spec-first. v1 is DESCRIPTIVE only. The evaluative conformance check is deferred, but section 6 shows it now falls out of the existing code-vs-doc machinery instead of needing a new axis.

## 0. Origin

To refine Anatoly we need a representation of what an application is FOR, not only judgments of its parts. The seven axes and the invariants phase all reason bottom-up: they look at a symbol or a symbol pair and judge it locally. None of them models the parcours: how an external actor enters the system, what path the code takes, and what the run is meant to accomplish. That higher-level object, the user flow, is the substrate on which a human can arbitrate the finality (finalite) of the code, and later check it against business expectations.

This doc specs the FIRST, descriptive half only: extract the as-implemented user flows from the code and present them as a generated documentation page. It deliberately stops before any conformance judgment, because the tool may not invent intent it cannot read from the code.

### 0.1 Why descriptive-first (the founding constraint applies)

Doc 22 section 0.2 establishes that orphaned-vs-cruft is structurally undecidable by the tool because intent is not in the code. The same holds for finality: what an application is supposed to do lives in business expectations, an external artifact, not in the source. So a flow check that judged business alignment with no supplied expectation would be the highest false-positive surface in the whole tool. v1 therefore produces no findings. It extracts and presents. A human reads the flow page and arbitrates; the tool qualifies and surfaces, it does not decide (doc 22 section 7).

### 0.2 Lineage: this is the next inter-representation step

The invariants phase already checks inter-representation consistency: code-vs-code (same quantity, divergent literal) and code-vs-doc-numeric (`src/core/orchestration/phases/invariants.ts`). The doc-conflict pipeline (doc 16) checks code-vs-reference-doc. The user flow is the substrate for the next pair, code-vs-business-intent, the most semantic one. v1 builds the substrate (a flow page). The conformance pair is not a new axis: once the page is ratified by a human it becomes a ratified flow doc (a peer doc-source, section 3), and the existing code-vs-doc machinery already checks code against it (section 6).

## 1. What a user flow is (the model)

A user flow is a named path from an entry point through the code to its terminal effects, plus the finality (what the path accomplishes) inferred from the code. It exists in two representations, with the same source-of-truth relationship findings already use (a structured JSON artifact is canonical, the markdown is a rendered view, see section 3.3):

- the structured flow artifact (machine-readable JSON): the canonical source-of-truth, consumed by the dead-intent router, the future conformance matcher, a future web UI, and any external runtime tool (section 11), and
- a human-readable page: derived from that artifact, ratifiable, the primary human deliverable.

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

## 3. Delivery: a dedicated flows phase for the artifact, the doc pipeline for the page

The flow model has two representations (section 1), produced by two different mechanisms on purpose. The structured artifact (the source-of-truth, section 3.3) is produced by a dedicated `flows` phase in `anatoly run`: re-derived every run, gated by its own config toggle so flow modeling enables or disables independently of the rest of the run, and additionally a no-op when RAG is off. It runs right after the RAG phase, the earliest point where the function cards and the usage graph are co-resident, and it adds no scan pass (it consumes data already in memory). The narration PAGE is produced by the machinery that already writes application descriptions: the doc pipeline (`runDocGeneration` then `commitDocPage`, see `src/core/orchestration/phases/doc.ts:42`), pointed at the flows area and grounded by the artifact (Stage 2, section 3.2).

The earlier draft proposed a single new phase that also owned a bespoke `flows.json` and a bespoke report section. The report section stays rejected: a flow is a substrate, not a scored finding, so it gets no section in `report.md`. What is kept is the phase (now scoped to producing the structured artifact) and the artifact itself, promoted from a throwaway sink to the typed source-of-truth of section 3.3.

But flows do NOT share the sink with the curated module docs. The full-mode scaffold writes per-module reference pages under `.anatoly/state/internal-docs/` (`src/utils/anatoly-paths.ts:45,245`). A flow page is a different genre: a parcours description, partly a machine render of the structured artifact (section 3.3), re-derived from the code graph. Co-mingling it with the hand-curated module set is a genre smell and couples two things that should evolve independently. So flows get their own typed area, `.anatoly/state/internal-flows/`, holding both the structured artifact and the narrated page (section 4).

A separate directory must not forfeit the inheritance that made the doc-scaffold the right pipeline in the first place. The fix is to make `internal-flows` a first-class PEER doc-source, not a silo: the doc-section source enum (`DocSectionEntry.source`, `src/rag/types.ts:86`, today `'internal' | 'project'`) gains a `'flow'` value, and the consumers are pointed at the area. Then a flow page inherits, exactly as a curated internal doc would, the mechanisms a bespoke artifact would have to reinvent:

- RAG indexing makes it a retrievable doc section (indexed under `source: 'flow'`),
- the doc-conflict pipeline (doc 16, code-vs-reference-doc) detects when code and the page diverge (the conformance channel of section 6),
- the documentation axis can retrieve a symbol's flow context when judging it,
- `anatoly docs arbitrate` gives the page a human ratification path.

The flow page is added to the scaffold as one more `PageDef` (`src/core/documentation/generation/doc-scaffolder.ts:26-32`) whose output is routed to `internal-flows`, optionally type-gated through `TYPE_PAGES` for CLI / Backend API / Frontend projects. The scaffold's never-overwrite property (`doc-scaffolder.ts:154-157`) carries over, so once a human edits a flow page the regeneration leaves it intact: ratification is preserved. The full-mode `sync_to_repo` opt-in (`src/schemas/config.ts:247-249`) applies to the area the same way.

### 3.1 Stage 1: deterministic skeleton, as grounding (no LLM)

The skeleton walk is the extraction step, and it runs in the dedicated `flows` phase (section 3). It has two outputs: it writes the structured source-of-truth artifact (section 3.3), and it grounds the page generation (Stage 2). Both roles matter: the artifact is what the dead-intent router and future consumers read, and the same skeletons injected into the doc writer's prompt are what keep the LLM in the narrate role.

- enumerate entry-point candidates from the reference-graph roots plus `behavioralProfile` plus conventions.
- for each entry, walk the forward edges (`referencedImports` / `calledInternals`) to a bounded depth, collecting steps and terminal effects; stop at leaves or a depth cap (FP and cost bound, mirrors the invariants caps `invariants.ts:79-96`).
- mark `unwired` when an entry resolves but its path reaches no effect (a candidate dead-intent flow).

The resulting skeletons are injected into the flow page's generation prompt the same way the doc writer is already grounded: the writer receives a `codeSurface` summary (`src/core/documentation/generation/doc-llm-executor.ts:679`) and type-specific context sections (`src/core/documentation/generation/doc-type-context.ts`). The flow skeletons are one more grounding block (a dedicated context provider, or a `sourceHints` entry for the flow page). This is what keeps the LLM in the narrate role: without the deterministic skeleton, a free-running doc writer would hallucinate entries and paths from reading files, violating I2 and I3.

### 3.2 Stage 2: the doc pipeline narrates the page

The existing `runDocGeneration` writes the flow page from the injected skeleton plus the cards' `summary` and `keyConcepts`. The page lists each flow's name, finality, entry, ordered steps, and terminal effects, with unwired flows called out as "entry without terminal effect: candidate dead intent (decide: wire up or remove)". The writer is told explicitly NOT to assert what the code should do (no expectation exists in v1). Default behavior on an unclear skeleton is a terse literal name, never an invented purpose. No new LLM transport is introduced: it is the same agentic Read-only doc writer (`doc.ts:97-108`).

### 3.3 The structured flow artifact is the source-of-truth; markdown is a rendered view

This reuses the discipline findings already follow. A finding is canonical as a structured JSON artifact (the per-file `ReviewFile`, schema in `src/schemas/review.ts`, written as `.rev.json` by `writeReviewOutput`, `src/core/reporting/review-writer.ts`, under `.anatoly/runs/<runId>/reviews/`). The human-readable markdown (`report.md`, the per-axis `axes/<axis>/shard.N.md`) is RENDERED from the aggregated JSON by `generateReport` (`src/core/reporting/reporter.ts`) and is never read back. JSON is the source-of-truth; markdown is a one-way rendered view, so local dev gets a readable report with no interface.

The flow model adopts the same split:

- the structured flow artifact (the `UserFlow` skeletons as JSON, in the dedicated `.anatoly/state/internal-flows/` area, section 3) is the canonical source-of-truth. It carries the full structure (id, name, finality, entry, ordered steps, effects, confidence, unwired), not a thin subset. It is what the dead-intent router consumes (a paragraph cannot feed a boolean), what the future conformance matcher reads, what a future web UI renders interactively, and what an external runtime tool can ingest (section 11, produce-only).
- a markdown view can be rendered from it for local dev without an interface, exactly as findings render to `shard.N.md`: deterministic, one-way, never parsed back.

This is the artifact strategy for the future web version: one structured source-of-truth, many consumers (router, conformance matcher, web UI, external tools), and a rendered markdown view for the CLI. Presentation stays out of the artifact; it holds data and stable anchors only.

Flows borrow the findings RENDER discipline (structured JSON is source-of-truth, markdown is a one-way view) but follow the internal-docs PERSISTENCE model, not the findings one. Findings are a per-run snapshot under `.anatoly/runs/<runId>/reviews/`; a parcours model is a stable, ratifiable substrate, so it lives persistently in `.anatoly/state/internal-flows/`, re-derived and overwritten in place on each regeneration (like the curated docs), never a per-run copy buried under the latest run. That gives the dead-intent router, the web UI, and any external consumer a single well-known path to read.

One nuance separates flows from findings. A finding's markdown is purely an output, but the flow has a second, human-authored surface: ratification (section 6). Encoding a business expectation is intent, which the tool cannot render from the artifact, so the ratifiable surface stays the LLM-narrated doc-scaffold page of section 3 (prose the human edits, inherited by the documentation axis and doc-conflict). The human's expectation lives natively in that markdown; it is not round-tripped back into the structured artifact. The direction stays clean: artifact to descriptive view is one-way and machine-derived, while the ratified expectation is a separate, prose-native, human-authored layer carried only by the scaffold page.

## 4. Output: a source-of-truth artifact and its rendered views

One canonical output plus views derived from it, all additive and bench-neutral:

1. The structured flow artifact (section 3.3): the `UserFlow` skeletons as JSON in `.anatoly/state/internal-flows/`, the source-of-truth, consumed by the dead-intent router, the future conformance matcher, a future web UI, and any external runtime tool (section 11).

2. The generated flow page under `.anatoly/state/internal-flows/` (the primary human-readable, ratifiable deliverable), narrated by the existing doc pipeline and grounded by the artifact. Because `internal-flows` is a registered peer doc-source (section 3), the page is automatically indexed (`source: 'flow'`), available to the documentation axis as context, and watched by doc-conflict, exactly as a curated internal doc is. A deterministic findings-style render of the artifact is the natural local-dev and web-fallback view, following the established render seam (`generateReport`).

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
3. the page is now a ratified flow doc that asserts intent. Because `internal-flows` is a registered peer doc-source (section 3), the existing code-vs-doc machinery (the documentation axis and the doc-conflict pipeline, doc 16) checks the code against it exactly as it does the curated internal docs. Divergence between the ratified flow page and the code IS the conformance finding, surfaced through the channel doc 16 / doc-22 already use.

So conformance is not a new build; it is the existing code-vs-doc pair applied to a human-ratified flow page. v1 only has to make the descriptive page reliable and ratifiable. The scaffold's never-overwrite property (section 3) is what makes the ratified page survive regeneration.

## 7. Evaluating flows: a dedicated structural-quality axis (post-substrate)

Section 6 covers one evaluative direction, code-vs-business-intent, and shows it needs no new axis: it falls out of code-vs-doc once a human ratifies a page. There is a second evaluative direction that is NOT intent and so cannot ride that channel: the structural quality of a parcours, judged from code alone. This one is a dedicated new axis (an eighth axis), not a reuse of an existing pair and not a lens folded into the current seven.

Why a dedicated axis, not a lens over the existing seven. The seven axes and the invariants phase all reason bottom-up: a symbol, or a symbol pair, judged locally. A flow is the first top-down unit, and a whole class of defects lives only at that granularity, invisible to a per-symbol pass. The unit (a parcours) and the anchor (a flow id, plus the participating symbols for the report) differ enough from a per-symbol axis that folding flow judgments into duplication or correction would distort those axes. So flows get their own axis, with its own finding shape, anchored on a flow id.

What it may find (all code-truth, no intent):

- redundant flows: two entries reach the same terminal effect by different paths (duplication at parcours granularity, which the symbol-level duplication axis cannot see).
- inconsistent sibling flows: one flow guards or authorizes an effect that a sibling reaching the same effect does not (a correctness or security smell visible only across flows).
- over-indirect parcours: a long chain of hops for a trivial effect (overengineering at path granularity).
- effect asymmetry: a create-shaped flow with no corresponding error or rollback path.
- unwired flows: an entry that dead-ends with no effect (the dead-intent signal of section 5, now a scored structural finding rather than only a router hint).

The hard boundary that keeps it FP-safe. Every finding must be a structural FACT ("these two flows reach the same effect", "this flow lacks the auth step its siblings have"), never an opinion about what the flow should accomplish ("this flow should be faster", "this parcours is missing a feature"). The moment a judgment needs to know what the business wants, it is intent, and intent is out of bounds for this axis: it stays the ratification and conformance path of section 6. The founding constraint of section 0.1 still binds: the tool may not invent intent it cannot read from the code. This axis only formalizes structural facts the code already proves.

It consumes the source-of-truth artifact. The judgments above are computed from the structured flow artifact (section 3.3) plus cross-flow comparison, so the artifact elevation is this axis's shared prerequisite with the web version: one structured source-of-truth, several consumers. The LLM may narrate or rank the findings, grounded by the deterministic cross-flow facts, but it never invents intent (the same narrate-not-decide shape every axis uses).

Bench and FP posture. Like the rest of doc 23, this axis earns no measured F1 until anatoly-bench learns a flow-level anchor (a separate repo and a scoring-methodology decision: whether a flow-id finding satisfies a catalogued expectation, and at which anchor). Its value is real and human-visible regardless. It must hold the same FP discipline as the invariants phase (section 8): deterministic grounding, conservative caps, and no scored finding emitted until the axis is actually built.

Sequencing: strictly post-substrate. This axis is a layer on top of the descriptive flow model, and it must wait until that substrate is built AND trusted. Emitting structural judgments on an unreliable flow graph would manufacture false positives at the worst possible granularity, a whole parcours. So it is explicitly post-v1, after the descriptive page and the artifact are reliable.

## 8. Invariants (FP-safety and bench-neutrality)

- I1. v1 emits zero scored findings and changes zero axis verdicts. F1 is unaffected by construction. A generated doc page and the structured flow artifact are invisible to the bench, exactly like the doc-22 descriptive surfaces. The dedicated `flows` phase is independently gated and off by default during bring-up, so it cannot perturb existing runs. (Conformance findings, section 6, only appear once a human ratifies a page; that is opt-in and post-v1.)
- I2. The skeleton is deterministic: the same index plus the same source produce the same skeletons. No randomness, hermetically testable without an LLM (the walk is pure graph code; the page narration is replay or synthetic-fixture tested, per the no-real-LLM-in-tests rule).
- I3. The narration never asserts a finality the code does not support; on an unclear skeleton it falls back to a literal name. No invented business purpose.
- I4. RAG off, or no vector store: zero skeletons, no flow page content beyond the scaffold stub (accepted), same posture as the invariants no-op gate (`invariants.ts:247`).
- I5. All caps (entry count, walk depth, flows per page, grounding size) are conservative and explicit, mirroring the invariants tuning block (`invariants.ts:51-96`).
- I6. The flow page is generated by the existing doc pipeline; it introduces no new LLM transport and reuses the agentic Read-only doc writer (`doc.ts:97-108`).

## 9. Sequencing

1. Stage 1 skeleton walk plus the structured flow artifact (section 3.3) in `.anatoly/state/internal-flows/`, no LLM, produced by a dedicated `flows` phase (its own config toggle, gated on RAG-on, running right after the RAG phase). Delivers the machine-readable model and the dead-intent `unwired` signal on its own.
2. Register `internal-flows` as a peer doc-source: add `'flow'` to `DocSectionEntry.source` and point RAG indexing, doc-conflict, and `arbitrate` at the area (section 3). This is what lets the page inherit the doc machinery without living in the curated module set.
3. The flow `PageDef` (routed to `internal-flows`) plus the skeleton-grounding context provider, so `anatoly docs` generates the human-readable flow page (Stage 2 narration through the existing pipeline).
4. Wire the `unwired` flag into the doc-22 Fil #1 `dead_intent` routing (compatibility, not a new finding).
5. (Post-v1, no new code) Document the ratification workflow of section 6, so a human can turn a descriptive flow page into a ratified expectation that the existing code-vs-doc machinery checks.
6. (Post-v1) The dedicated flow-quality axis (section 7), once the descriptive substrate and the structured artifact are reliable.

## 10. Non-goals

- v1 does NOT check flows against business expectations automatically. There is no auto-supplied expectation source; the expectation is supplied only by a human ratifying the page (section 6). Until a page is ratified, v1 is purely descriptive.
- v1 does NOT decide orphaned vs cruft. It supplies the structural evidence (the flow skeleton) that lets a human, and the doc-22 router, decide better.
- v1 adds no new scan pass. If the existing reference graph proves insufficient for entry-point detection in some stack, extending the indexer is tracked separately.
- The structured flow artifact is produced by a dedicated `flows` phase in `anatoly run`, independently toggleable (off by default during Stage 1 bring-up) and gated on RAG-on. The phase adds no new scan pass: it consumes the in-memory reference graph and usage graph, emits zero scored findings (I1), and writes only the artifact. The narration PAGE is still generated by the doc pipeline (scaffold then generation) and consumed through the existing documentation axis and doc-conflict pipeline; it gets no bespoke report section.
- No cross-repo bench change in v1. Should a future iteration score ratified-flow conformance findings, those flow through the existing axis/divergence channels; any bench scoring of them is additive work in `anatoly-bench`.
- v1 does NOT boot or execute the application, and does NOT ingest any runtime-capture artifact. The dynamic, runtime-observed flow is a separate tool's job (section 11). Anatoly only PRODUCES its static flow model as a published typed artifact and consumes nothing external. It stays a static auditor that reads artifacts and never executes the subject.
- v1 does NOT build the flow-quality axis (section 7). That dedicated eighth axis is a post-substrate, post-v1 increment that evaluates parcours-level structure (code-truth only), and only after the descriptive flow model and its artifact are reliable.

## 11. Runtime interop (the dynamic counterpart): produce, do not ingest

The user flow has a dynamic counterpart: a runtime-observed flow, captured by driving a live app and recording what it actually does. A sibling runtime-flow tool does exactly this, sealing each parcours as a replayable characterization test with its SQL footprint. The static flow model specced here and that runtime model are complementary by division of labor: the static map DISCOVERS the flows (cheap, complete, any stack, zero setup), the runtime model CONFIRMS and measures them (reachability, effect values, migration parity). Two architectural questions follow, and v1 answers both conservatively.

Does Anatoly capture runtime itself? No, and it must not. Booting an arbitrary app to observe it requires the whole DevOps surface of the target (runtime version, deps, env, secrets, external services, migrations, seed data), plus mocking of side-effecting dependencies, plus an execute-untrusted-code security posture. That cost is irreducible and per-project, and it is precisely the boundary that separates a static auditor from a dynamic one. Anatoly stays static: it reads artifacts, it never executes the subject. A narrower "observe the project's own existing e2e harness" path is conceivable, but it remains opt-in, per-stack, and out of v1.

Does Anatoly ingest a runtime artifact (a sarcophagus) to fold runtime drift onto its findings? Not in v1, and by deliberate choice. Producing is decoupled, consuming is coupled. If Anatoly only EMITS its static flow model as a clean typed artifact, it carries zero runtime dependency on any external tool: no ingestion code, no gated runtime phase that no-ops on most repos, no coupling to an external format or version, no boot or security surface. The flow artifact is a published output (like the report), justified entirely by Anatoly's own needs (this doc, the dead-intent router, the conformance bridge of section 6). The fact that a runtime tool can consume it to seed its own discovery, and so skip an expensive exploration swarm, is a free externality, not an integration Anatoly maintains.

The named tradeoff: produce-only means Anatoly gets no runtime confirmation back, so the reachability oracle and the runtime resolution of the doc-22 orphaned-vs-cruft case stay out of reach. This is accepted, because the static map's value is independent and large, and because the consuming direction can be added later, gated and opt-in, if a real need appears. It is not built speculatively.

This keeps the inter-representation lineage (section 0.2) clean: code-vs-runtime-observed is a real pair, but Anatoly's contribution to it is the static representation it already computes, exposed as a clean artifact. The runtime side belongs to whoever owns execution.

## 12. Open items (per-stage detailing)

- Stage 1: the exact entry-point predicate (root-of-graph plus `behavioralProfile` plus which name/kind conventions per language), and the walk depth cap.
- Stage 1: how to group a coherent cluster (the doc-22 section 2.4 internal-subsystem signal) so a flow is one parcours, not one symbol.
- Stage 1: the Zod schema of the structured flow artifact (the source-of-truth, section 3.3, located in `.anatoly/state/internal-flows/`), and whether v1 ships the deterministic findings-style markdown render or defers it.
- Delivery: the peer doc-source wiring (the `'flow'` value on `DocSectionEntry.source`, plus the exact touch points in the RAG doc-indexer, the doc-conflict pairing, and `arbitrate`) so `internal-flows` inherits the machinery without regressing the existing `internal` / `project` sources.
- Delivery: registering `state/internal-flows` as a typed `AnatolyArea` (`src/utils/anatoly-paths.ts:33-55`) and its clean / reset / sync handling alongside `state/internal-docs`.
- Delivery: which `PageDef` slot and section the flow page occupies, and whether it is base or type-gated (`doc-scaffolder.ts:35-111`).
- Delivery: the grounding seam for the skeleton (a dedicated context provider in `doc-type-context.ts` versus a `sourceHints` entry), and the grounding size cap.
- Stage 2: the page template (the headings and per-flow layout) and the fallback wording when finality is unclear.
- Section 6: the ratification workflow doc (how a human marks a flow page as a ratified expectation, and how doc-conflict treats it).
