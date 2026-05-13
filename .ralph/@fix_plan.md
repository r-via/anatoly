# Ralph Fix Plan

## Stories to Implement

### Documentation Axis — Audit de la couverture documentaire

- [x] Story 26.1: Prerequisites (schema + resolver + prompt)
- [x] Story 26.2: Core Integration (evaluator + merger + orchestrator + registry)
- [x] Story 26.3: Documentation Meta (update project docs)
### Doc Scaffolding — Génération automatique de `/docs/`

- [x] Story 29.1: Project Type Detection
- [x] Story 29.2: Documentation Structure Scaffolder
- [x] Story 29.3: Scaffolding Hints in Generated Pages
- [x] Story 29.4: Module Granularity Resolution
- [x] Story 29.5: Code → Documentation Mapping with Fallback
- [x] Story 29.6: Guard Test — Anatoly Never Writes to docs/
- [x] Story 29.7: Source Code Analysis for Documentation
- [x] Story 29.8: LLM Page Content Generation
- [x] Story 29.9: Incremental Cache (SHA-256 per Page)
- [x] Story 29.10: Documentation Scoring Integration
- [x] Story 29.11: Documentation Reference Section in Report
- [x] Story 29.12: User Documentation Plan Resolver
- [x] Story 29.13: Dual-Output Recommendations
- [x] Story 29.14: Ralph Documentation Sync Mode
- [x] Story 29.15: Pipeline Integration — Wire Doc Scaffolding into Anatoly Run
### Multi-Language — Support multi-langage

- [x] Story 31.1: Language Detection by Extension Distribution
- [x] Story 31.2: Framework Detection by Project Markers
- [x] Story 31.3: Project Info Display — Languages & Frameworks
- [x] Story 31.4: Auto-Detect File Discovery
- [x] Story 31.5: Dynamic Grammar Manager
- [x] Story 31.6: Language Adapter Interface & TypeScript Refactor
- [x] Story 31.7: Bash/Shell Language Adapter
- [x] Story 31.8: Python Language Adapter
- [x] Story 31.9: Rust Language Adapter
- [x] Story 31.10: Go Language Adapter
- [x] Story 31.11: Java, C#, SQL, YAML, JSON Language Adapters
- [x] Story 31.12: Heuristic Fallback Parser
- [x] Story 31.13: Usage-Graph Multi-Language Extension
- [x] Story 31.14: Prompt Resolution Cascade
- [x] Story 31.15: Best Practices Prompts — Shell, Python, Rust, Go
- [x] Story 31.16: Best Practices Prompts — Java, C#, SQL, YAML, JSON
- [x] Story 31.17: Documentation Prompts per Language
- [x] Story 31.18: Framework-Specific Prompts — React & Next.js
- [x] Story 31.19: Axis Language & Framework Injection
- [x] Story 31.20: Pipeline Integration & End-to-End Validation
### Adversarial Review — Process de review adversariale automatisée

- [x] Story 32.1: Adversarial Review — Epic 28 Stories 28.1–28.3
- [x] Story 32.2: Adversarial Review — Epic 28 Stories 28.4–28.6
- [x] Story 32.3: Adversarial Review — Epic 29 Stories 29.1–29.6
- [x] Story 32.4: Adversarial Review — Epic 29 Stories 29.7–29.11
- [x] Story 32.5: Adversarial Review — Epic 29 Stories 29.12–29.17
- [x] Story 32.6: Adversarial Review — Epic 29 Stories 29.18–29.21
- [x] Story 32.7: Adversarial Review — Story 30.1 SDK Semaphore
- [x] Story 32.8: Adversarial Review — Epic 31 Stories 31.1–31.5
- [x] Story 32.9: Adversarial Review — Epic 31 Stories 31.6–31.11
- [x] Story 32.10: Adversarial Review — Epic 31 Stories 31.12–31.14
- [x] Story 32.11: Adversarial Review — Epic 31 Stories 31.15–31.18
- [x] Story 32.12: Adversarial Review — Epic 31 Stories 31.19–31.20
### Gemini Provider Foundation
> Goal: Users can enable Gemini in `.anatoly.yml`, verify connectivity via `anatoly providers`, and confirm their Google auth works. The transport abstraction is in place, both providers are wired, but no axes are routed yet.

- [x] Story 37.1: Create LlmTransport interface and TransportRouter
- [x] Story 37.2: Create AnthropicTransport wrapping existing execQuery()
- [x] Story 37.3: Create GeminiTransport
- [x] Story 37.4: Add GeminiConfigSchema to .anatoly.yml
- [x] Story 37.5: Gemini auth check and graceful fallback
- [x] Story 37.6: Create `anatoly providers` command
### Review Axes on Gemini Flash
> Goal: Utility, duplication, and overengineering axes run on Gemini Flash — faster results, no Claude rate limit stalls. Circuit breaker ensures Gemini outages fall back to Claude transparently.

- [x] Story 38.1: Route review axes to Gemini via defaultGeminiMode
- [x] Story 38.2: Separate concurrency semaphores for Claude and Gemini
- [x] Story 38.3: Implement circuit breaker for Gemini fallback
### RAG NLP on Gemini + Observability
> Goal: NLP summarization runs on Gemini ($0 vs $2+/run). Run metrics and CLI output show provider breakdown for full cost/quota visibility.

- [x] Story 39.1: Route NLP summarization to Gemini Flash
- [x] Story 39.2: Add provider field to logs and run metrics
### Quality Validation
> Goal: Developers validate that Gemini routing produces equivalent quality via gold-set comparison against Claude reference results.

- [x] Story 40.1: Gold-set validation — Gemini vs Claude comparison
### Refinement 3-Tier
> Goal: L'utilisateur obtient des reviews de meilleure qualité à moindre coût grâce à un pipeline de refinement qui élimine les faux positifs mécaniques (tier 1), les contradictions logiques (tier 2), et vérifie empiriquement les findings ambigus (tier 3).

- [x] Story 41.1: Retirer la délibération per-file et écrire les ReviewFiles bruts
- [x] Story 41.2: Tier 1 — Auto-resolve déterministe
- [x] Story 41.3: Tier 2 — Cohérence inter-axes via Flash Lite
- [x] Story 41.4: Tier 3 — Investigation agentic Opus
- [x] Story 41.5: Intégration pipeline et UI
- [x] Story 41.6: Validation qualité — Comparaison old vs new
- [x] Story 41.7: Adversarial review — Audit de chaque story complétée
### Config Restructuring — Séparation providers/models/agents/axes/runtime

- [x] Story 42.1: Schema Zod — Nouvelles sections config
- [x] Story 42.2: Migration backward compat — `migrateConfigV0toV1`
- [x] Story 42.3: Résolution modèles — Nouvelles fonctions resolve* et suppression defaultGeminiMode
- [x] Story 42.4: Migration des consommateurs — Tous les chemins `config.llm.*`
- [x] Story 42.5: Validation gold-set et .anatoly.yml v1.0
### Multi-Provider Migration — Vercel AI SDK, prefixes provider, TransportRouter mode-aware

- [x] Story 43.1: Schema Zod — mode sur providers, providers génériques
- [x] Story 43.2: Registre des providers connus
- [x] Story 43.3: Model prefixes + migration `migrateConfigV1toV2`
- [x] Story 43.4: Transport Vercel AI SDK + suppression @google/genai + cost calculator
- [x] Story 43.5: Transport router refactoré — mode-aware + nettoyage globals
- [x] Story 43.6: Agents Vercel AI SDK + bash-tool + web search
- [x] Story 43.7: Onboarding `anatoly init` — configuration interactive multi-provider
- [x] Story 43.8: Validation gold-set + migration `.anatoly.yml` v2.0
### User Instructions — Calibration personnalisée
> Goal: L'utilisateur obtient des reviews calibrées à ses conventions projet grâce à un fichier `ANATOLY.md` dont le contenu est injecté dans les prompts d'évaluation pour permettre au LLM de distinguer les choix délibérés des manquements réels.

- [x] Story 44.1: Loader et parser `ANATOLY.md`
- [x] Story 44.2: Injection dans les prompts d'axes
- [x] Story 44.3: Intégration dans le pipeline `run`
- [x] Story 44.4: Documentation utilisateur
### Telegram Notifications — Alertes post-run

- [x] Story 45.1: Schema Zod — Section `notifications.telegram`
- [x] Story 45.2: NotificationChannel + TelegramNotifier
- [x] Story 45.3: Intégration pipeline + tests
### Transport-Level Resilience — Semaphores & circuit breakers dans le router

- [x] Story 46.1: TransportRouter — semaphores et breakers par provider
- [x] Story 46.2: API acquire / acquireSlot / release
- [x] Story 46.3: Renommage GeminiCircuitBreaker → CircuitBreaker
- [x] Story 46.4: Nettoyage interfaces — suppression semaphore/breaker manuels
- [x] Story 46.5: Migration appels agentic vers acquireSlot
- [x] Story 46.6: Tests d'intégration et validation
### Background Worktree Review — Review en arrière-plan via Git Worktree
> Goal: ---

- [x] Story 47.1: Gestion des Git Worktrees
- [x] Story 47.2: Resolution de chemins relative au worktree
- [x] Story 47.3: Lancement en arriere-plan (fork de processus)
- [x] Story 47.4: Commande `anatoly status`
- [x] Story 47.5: Notification de fin de review
- [x] Story 47.6: Support du lock multi-run
- [x] Story 47.7: Nettoyage et robustesse
### First-run Unified Onboarding

- [x] Story 48.1: Hardware-aware tier prompt + mode (Quick Win / Full Run) prompt
- [x] Story 48.2: Inline lite ONNX prefetch avec progress bar
- [x] Story 48.3: Inline GGUF download (advanced) avec SHA verify
- [x] Story 48.4: Subprocess `setup-embeddings` + reload de l'état
- [x] Story 48.5: Always-write `.anatoly.yml` avec defaults sains
- [x] Story 48.6: End-of-setup 3-choice prompt
- [x] Story 48.7: `--defaults-settings` flag + cleanup hint detector
- [x] Story 48.8: Quick Win runtime filter + summary suggestion
### First-run Polish

- [x] Story 49.1: Recovery messages actionnables pour failures de download
- [x] Story 49.2: Cross-project preferences via `~/.anatoly/preferences.yml`
- [x] Story 49.3: Transition visuelle setup → audit
- [x] Story 49.4: Post-audit progressive education hint
- [x] Story 49.5: Privacy/transparency notice dans le prompt tier
- [x] Story 49.6: Plain-mode parity pour le tableau comparatif tier
### Embedding Provider Abstraction — Vercel AI SDK transport unifié pour les embeddings, mode External pour cloud + on-prem custom

- [x] Story 50.1: Schema Zod section `embedding` + backward-compat resolver
- [x] Story 50.2: Registre `KNOWN_EMBEDDING_PROVIDERS` + entrée `anatoly-local` avec hook ensureModel
- [x] Story 50.3: Factory `getVercelEmbeddingModel` + probe dim runtime + cache signature
- [x] Story 50.4: Refacto `embeddings.ts` runtime `'sdk'` + suppression code legacy GGUF + parsing 3-formats
- [x] Story 50.5: `resolveEmbeddingModels` enrichi + `EmbeddingBackend` `'external'` + mapping legacy
- [x] Story 50.6: Wizard tier 3 options + sous-prompt external + writeFirstRunConfig étendu
- [x] Story 50.7: Tests d'intégration parité advanced + wiring openai live + bench latence SDK
- [x] Story 50.8: Validation gold-set anatoly-bench + documentation utilisateur embedding providers
### Compress Flag — opt-in output compression with progressive per-axis migration

- [x] Story 51.1: Restauration dual-mode dans l'axe `utility`
- [x] Story 51.2: `FeaturesSchema` dans `ConfigV3Schema` + adapter v3→v2
- [x] Story 51.3: Plomberie CLI `--compress` / `--no-compress` + résolution précédence
- [x] Story 51.4: Propagation `compressionEnabled` `RunContext` → `AxisContext` + log non-migré
- [x] Story 51.5: Migration axe `overengineering` (dual-mode, galop d'essai)
- [x] Story 51.6: Migration axe `best_practices` (dual-mode, compression partielle)
- [x] Story 51.7: Validation A/B benchmark slot-engine + critères pass/fail
- [x] Story 51.8: Documentation utilisateur + report header + tracker updates
### Cache Layout Overhaul — single `.anatoly/` root, content-hash mutualization, cloud-ready foundation

- [x] Story 52.1: Module `anatoly-paths.ts` + bootstrap idempotent
- [x] Story 52.2: `_meta` headers + `prompt_hash` discipline + module `cache-meta.ts`
- [x] Story 52.3: Migration project-only (state, cache, runtime, setup) + `--no-cache` scope
- [x] Story 52.4: Migration `cache/` content-addressable (reviews, refinements, NLP) avec sharding + manifests
- [x] Story 52.5: Migration `shared/` artefacts (pricing, grammars, models GGUF + HF redirect)
- [x] Story 52.6: Détection ancien layout + commande `clean --shared` + ban env vars + ban `~/.cache/`
- [x] Story 52.7: Tests intégration cross-projet (mutualisation, isolation, idempotence, invalidation prompt)
- [x] Story 52.8: Documentation `cache-layout.md` + ADR + CHANGELOG + tracker updates
### In-flight run visibility — status detection fix + read-only attach

- [x] Story 53.1: Écriture initiale `run-status.json` côté foreground
- [x] Story 53.2: Correction du chemin `progress.json` dans `anatoly status`
- [x] Story 53.3: Enrichissement `anatoly status` pour run actif (progress + findings + tri)
- [x] Story 53.4: Nouvelle sous-commande `anatoly attach [runId]`
- [x] Story 53.5: Tail ndjson + rendu TUI live + `--from-start`
- [x] Story 53.6: Terminaison propre + détection crashed depuis attach
- [x] Story 53.7: Documentation utilisateur + help text + tracker updates
### Reference-First Documentation

- [x] Story 54.1: Schema config étendu + suppression `docs_path` + erreur de validation actionnable
- [x] Story 54.2: Wizard interactif doc + `init --reconfigure-docs`
- [x] Story 54.3: `LanguageAdapter.extractDocComments` + implémentations
- [x] Story 54.4: `reference-docs-resolver` — collecte unifiée des sources humaines
- [x] Story 54.5: Split contexte axes — `renderReferenceDocsContext` vs `renderInternalDocsContext`
- [x] Story 54.6: Mode `lite` — digest interne déterministe + cache fingerprint
- [x] Story 54.7: Mode `off` gracieux + suppression sèche du sync `.anatoly/docs/ → docs/`
- [x] Story 54.8: Coherence 3-way en mode `full` (reference ↔ internal ↔ surface code)
- [x] Story 54.9: Findings `doc_divergence` transversaux + agrégation sous axe doc + mode doc dans rapport
### Doc Conflicts Arbitration — boucle d'arbitrage humain pour promouvoir la doc interne au rang d'autorité

- [x] Story 55.1: Utilitaire `resolveDocMode` et refactor des call-sites inline
- [x] Story 55.2: Déplacement de `runDocUpdate` en pré-review
- [x] Story 55.3: Schéma `DocConflictSchema` + YAML I/O + hash anchoring
- [x] Story 55.4: Agent `doc-conflict-detector` + branchement pipeline
- [x] Story 55.5: Mode `lite` digest marqué `evaluated`
- [x] Story 55.6: Commande `anatoly docs arbitrate` (wizard)
- [x] Story 55.7: Axe correction consomme les arbitrages `doc-wins`
- [x] Story 55.8: Axe documentation rapporte les `code-wins` comme "reference stale"
- [x] Story 55.9: Intégration `estimate` + run-metrics + hints démarrage/fin
- [x] Story 55.10: Détection LLM des nouveaux conflits internal↔reference
### Unified Phase & Resource Orchestration Runtime — contrat unique pour phases, primitives LLM/agent et dataplane à 4 plans

- [x] Story 56.1: `runPhase` helper + AsyncLocalStorage scope
- [x] Story 56.2: Primitive Registry — schema + 18 entries with four-block contract
- [x] Story 56.3: Composer Registry + DAG Executor
  > **As an** Anatoly developer **I want** named composers with declarative DAG plans that orchestrate primitives **So that** multi-step axes (like `axes.correction` pass1+verify) and pipelines (like `review` fan-out) become inspectable, dry-runnable, and uniform.
  > AC: Given the absence of a composer registry, When `src/core/orchestration/registry/composers/types.ts` is implemented, Then it exports `ComposerEntry`, `ExecutionPlan`, `ExecutionStep` interfaces per FR4
  > AC: Given the registry root file, When `src/core/orchestration/registry/composers/index.ts` is implemented, Then it exports `COMPOSERS: Map<string, ComposerEntry>` populated by importing each composer module
  > AC: Given the 7 axis composers (each axis becomes a composer even if 1-step), When the registry is inspected, Then it contains: `axes.utility`, `axes.duplication`, `axes.correction`, `axes.overengineering`, `axes.tests`, `axes.best-practices`, `axes.documentation`. `axes.correction` declares a 2-step plan: `[{id: 'pass1', primitive: 'axes.correction-pass1'}, {id: 'verify', primitive: 'axes.correction-verify', readsFrom: ['pass1'], condition: (ex) => ex.read('pass1', CorrectionPass1OutputSchema).findings.length > 3, onFailure: 'continue'}]`
  > AC: Given the higher-level pipeline composers, When the registry is inspected, Then it contains: `review-pipeline` (fan-out 7 axis composers in parallel + axis-merger step), `doc-conflict-pipeline` (batches detection + aggregation), `doc-update-pipeline` (internal-docs regen pipeline), `refinement-pipeline` (tier-3 deliberation pipeline)
  > AC: Given the executor, When `src/core/orchestration/executor.ts` is implemented per FR5, Then it exports `executeComposer<I, O>(composer: ComposerEntry, input: I, exchange: CentralExchange, gateway: ResourceGateway): Promise<O>`
  > AC: Given an `ExecutionPlan` with steps `[A, B (readsFrom: A), C (readsFrom: [A, B])]`, When `executeComposer` runs, Then it walks topologically: A runs first ; once A completes and writes to exchange, B runs reading A ; C runs reading both. A failure with `onFailure: 'abort'` halts the composer ; `'continue'` logs warning and continues.
  > AC: Given a step with a `condition?` predicate, When the executor reaches that step, Then if `condition(exchange)` returns false, the step is skipped, an event `step_skipped` is emitted to D.3 with `composer`, `stepId`, `reason: 'condition_false'`, and the executor proceeds to downstream steps that don't `readsFrom` the skipped step (downstream steps that depend on it are also skipped with `reason: 'upstream_skipped'`)
  > AC: Given an `inputMapper` returning the input for a primitive, When the executor invokes the primitive via the gateway, Then the primitive's response is validated against its `response.schema`, then the `outputSchema` is used to write to `exchange.write(stepId, transformedOutput, outputSchema)`
  > AC: Given the test suite `src/core/orchestration/executor.test.ts`, When it runs, Then it covers: linear DAG (A → B → C) executes in order ; parallel branches (`review-pipeline` 7 axes) execute concurrently ; conditional skip propagates downstream ; `onFailure: 'abort'` stops execution and rethrows ; `onFailure: 'continue'` logs and continues ; `executeComposer` returns the typed final output matching `composer.outputSchema`
  > Spec: specs/planning-artifacts/epic-56-unified-orchestration-runtime.md#story-56-3
- [ ] Story 56.4: Central Exchange — Zod-strict typed blackboard
  > **As an** Anatoly developer **I want** a central exchange that carries only Zod-validated typed responses between primitives within a composer execution **So that** intermediate handoffs are typed, replayable, and never carry prompts or logs.
  > AC: Given the absence of an exchange module, When `src/core/orchestration/exchange.ts` is implemented per FR6, Then it exports `createExchange(): CentralExchange` and the interface `{write<T>, read<T>, snapshot}`
  > AC: Given `exchange.write('step1', output, MyOutputSchema)`, When the output does not match the schema, Then Zod throws a `ZodError` with the field-level diff, and the error is wrapped in `ExchangeWriteError('step "step1" output failed validation: …')` for clarity
  > AC: Given `exchange.read('step1', ExpectedSchema)`, When `step1` has not been written yet, Then the function throws `ExchangeReadError('step "step1" has not produced output yet')`
  > AC: Given `exchange.read('step1', ExpectedSchema)` where `step1` was written with `WrittenSchema`, When the schemas don't match, Then the read succeeds only if `ExpectedSchema` accepts the value. If not (e.g. expects a field that wasn't written), it throws `ExchangeSchemaMismatchError` with the missing field path.
  > AC: Given a composer execution that completes, When the executor finishes the last step, Then `exchange.snapshot()` is called, returning the full state as `Record<string, unknown>`, then written to `{runDir}/conversations/{phase}__{composer}__exchange__{callId}.json` per FR6, and an event `exchange_snapshot_written` is emitted to D.3
  > AC: Given the test suite `src/core/orchestration/exchange.test.ts`, When it runs, Then it covers: write with valid Zod passes ; write with invalid Zod throws ; read of missing step throws ; read with mismatched schema throws ; snapshot returns deep copy (mutation post-snapshot doesn't affect the snapshot) ; multiple composer executions get isolated exchanges (no cross-contamination)
  > Spec: specs/planning-artifacts/epic-56-unified-orchestration-runtime.md#story-56-4
- [ ] Story 56.5: Cost Plane — `llm-calls-sink` v2 + estimate writer + summary/variance writer
  > **As an** Anatoly maintainer **I want** the existing `llm-calls-sink.ts` extended in-place to schema v2 with pre-flight estimates, summary, and variance **So that** the Cost Plane (D.4) is delivered with minimal disruption — same module, same atomic dual-write architecture, same transport wiring, just an enriched schema and run-end writers.
  > AC: Given the existing `src/utils/llm-calls-sink.ts` with `LLM_CALLS_SCHEMA_VERSION = 1`, When the schema is bumped to v2 per FR7, Then the constant becomes `LLM_CALLS_SCHEMA_VERSION = 2`, the `LlmCallEvent` interface adds the 6 new fields, the `axis` field is removed, and `costUsd` becomes `number | null`
  > AC: Given the on-disk location `{runDir}/llm-calls.ndjson` (currently used by `run.ts:980`), When FR8 is applied, Then the call becomes `enterLlmCallSink(join(ctx.runDir, 'costs', 'ledger.ndjson'))`, the parent dir `costs/` is created automatically by `mkdirSync(dirname(filePath), {recursive: true})`, and the historical `{runDir}/llm-calls.ndjson` path is no longer used by new runs
  > AC: Given the new pre-flight estimate writer per FR9, When `recordPlanEstimate(estimate: PlanEstimateInput)` is called by the executor before a phase starts, Then a record is appended to the ledger with `planId: 'plan-{phase}-{composer}-{stepId}'`, `costSource: 'estimated'`, `callId` undefined, all relevant fields populated from `primitive.estimateCost(input)` plus the primitive's `pricingModel` and `provider`/`model` resolved at plan time
  > AC: Given the actual call site, When a primitive completes and `recordLlmCall(event)` is called by the transport, Then the gateway populates `callId` (UUID short), `composer` (from ALS scope), `primitive` (from ALS scope), `costSource: 'actual'`, `pricingModel` (from the primitive registry), and `estimatedUsd` (resolved by lookup against the matching `planId` record in-memory)
  > AC: Given the run is about to end, When the writer `writeCostSummary(runDir)` is called per FR10, Then it reads the ledger NDJSON, computes aggregations grouped by phase × composer × primitive × provider × model, and writes `{runDir}/costs/summary.json` with schema `{byPhase, byComposer, byPrimitive, byProvider, byModel}` each carrying `{totalUsd, totalInputTokens, totalOutputTokens, totalCacheReadTokens, callCount}`
  > AC: Given the same run end, When the writer `writeCostVariance(runDir)` is called per FR10, Then it reads the ledger, joins actuals (`callId`) against estimates (`planId` of the same primitive in the same composer), computes deviation per composer + per phase, and writes `{runDir}/costs/variance.json` with schema `{byComposer: {[name]: {estimatedUsd, actualUsd, deviationPct}}, byPhase: {[name]: {estimatedUsd, actualUsd, deviationPct}}}`
  > AC: Given the `recordLlmCost` helper at `run.ts:261-318`, When FR12 refactors it into a derived view, Then the public API (`ctx.totalCostUsd`, `ctx.providerStats`, `ctx.composerStats`) continues to return correct values during the run, but the underlying source is `getActiveSinkTotals()` reading from the same ALS sink rather than independent writes from transports. The transports stop calling the run.ts helper directly; they only call `recordLlmCall`. The helper becomes a getter, not a setter.
  > AC: Given the test suite `src/utils/llm-calls-sink.test.ts` (existing, extended), When it runs, Then it covers schema v2: `callId`/`planId` populated, `composer` replaces `axis`, `costSource` enforced, `pricingModel` provenance recorded, `costUsd: null` for subscription, `recordPlanEstimate` writes correctly, `writeCostSummary` aggregates correctly, `writeCostVariance` joins estimates/actuals correctly
  > Spec: specs/planning-artifacts/epic-56-unified-orchestration-runtime.md#story-56-5
- [ ] Story 56.6: Conversation dump phase prefix injection (D.2)
  > **As an** Anatoly maintainer **I want** every conversation dump filename to carry the `{phase}__{composer}__{primitive}__{callId}.{ext}` prefix **So that** `jq`-style filtering and human navigation by phase / composer become trivial.
  > AC: Given the existing `src/core/transports/conversation-dump.ts` with filename pattern `${prefix}__${attempt}.md` (line 29-33), When the runtime invokes a transport, Then the `prefix` argument is constructed by the runtime (gateway layer) by joining `{phase}` (from `getLogContext().phase`), `{composer}` (from ALS composer scope), `{primitive}` (from ALS primitive scope), `{callId}` (allocated at gateway entry) with `__` separators
  > AC: Given an AsyncLocalStorage scope chain runPhase → composer → primitive, When the composer executor enters a step, Then it opens a sub-scope via `runWithContext({composer: name}, fn)` (extends `LogContext` interface in `src/utils/log-context.ts` to add `composer` and `primitive` and `callId` optional fields)
  > AC: Given the gateway resolves a primitive invocation, When the primitive's transport is called, Then the transport receives a `slug` parameter pre-computed as `{phase}__{composer}__{primitive}__{callId}` and uses it as the prefix in the dump filename
  > AC: Given a real `axes.correction` execution, When the dumps are written, Then the files exist at `{runDir}/conversations/review__axes.correction__axes.correction-pass1__c4f8a2.md` and `{runDir}/conversations/review__axes.correction__axes.correction-verify__d8e1b5.md` (4-segment naming, no fallback to legacy patterns)
  > AC: Given the test `src/core/transports/conversation-dump.test.ts`, When it runs, Then it covers: filename uses 4-segment naming ; ALS scope absent (test ad-hoc invocation) raises a clear error (the runtime always opens the scope) ; multiple concurrent composer executions get distinct callIds without collision
  > Spec: specs/planning-artifacts/epic-56-unified-orchestration-runtime.md#story-56-6
- [ ] Story 56.7: Transport refactor — subscription `costUsd: null` + D.3 event vocabulary v1
  > **As an** Anatoly maintainer **I want** the 4 transports to emit `costUsd: null` + `costSource: 'unknown'` for subscription-mode calls instead of the current silent `costUsd: 0`, plus the D.3 event vocabulary standardized **So that** the ledger is honest about provider-side cost availability, and `jq` queries on the execution log have a stable event schema.
  > AC: Given `src/core/transports/anthropic-transport.ts` lines 282 and 335 (current `recordLlmCall` sites with `costUsd: 0` for subscription mode), When FR11 is applied, Then when the resolved mode for `anthropic` is `subscription`, the call passes `costUsd: null` + `costSource: 'unknown'` + `pricingModel: 'subscription-claude-code-sdk'`. Tokens (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`) remain captured from the SDK response.
  > AC: Given `src/core/transports/gemini-transport.ts` lines 142 and 263, When FR11 is applied, Then subscription mode produces `costUsd: null` + `costSource: 'unknown'` + `pricingModel: 'subscription-gemini-cli-core'`
  > AC: Given `src/core/transports/vercel-sdk-transport.ts` lines 151, 202, 285, 336, When FR11 is applied, Then API mode (the only mode for Vercel SDK transport) produces `costUsd: <computed>` + `costSource: 'actual'` + `pricingModel: 'vercel-sdk-{provider}-{date}'`. The Vercel SDK transport never produces `'unknown'`.
  > AC: Given `src/core/doc-llm-executor.ts:863`, When FR11 is applied, Then the agentic doc-generation call routes through the same logic — subscription mode for the resolved provider produces `'unknown'`, API mode produces `'actual'`.
  > AC: Given the D.3 event vocabulary v1 per FR17, When `src/schemas/execution-events.ts` is created, Then it exports Zod schemas for the 16 event types: `phase_start`, `phase_end`, `composer_start`, `composer_end`, `resource_call_start`, `resource_call_end`, `resource_call_error`, `cache_hit`, `cache_miss`, `validation_fail`, `retry_attempt`, `exchange_write`, `exchange_read`, `step_skipped`, `plan_emitted`, `actuals_emitted`. Each carries `event_version: 'v1'` and `callId`/`phase`/`composer`/`primitive`/`runId` as applicable.
  > AC: Given the lint rule for D.3 events per NFR6, When any pino `info`/`warn`/`error` call with an `event` field is inspected, Then the rule rejects: `prompt`, `system`, `userMessage`, `toolTurns`, `assistantResponse`, `cacheReadTokens`, `cacheCreationTokens`, `costSource`, `pricingModel`, `estimatedUsd` in the event object. Headline cost stats (`costUsd`, `inputTokens`, `outputTokens`, `cacheHit` boolean) ARE allowed.
  > AC: Given the test suite `src/core/transports/transport-cost-source.test.ts` (new), When it runs, Then it covers: 4 transports × subscription mode → `'unknown'` ; 4 transports × API mode → `'actual'` ; tokens always captured even when `costUsd: null` ; cache hit case `costUsd: 0` + `costSource: 'actual'` + `cacheHit: true` (distinct from subscription `null`/`unknown`)
  > Spec: specs/planning-artifacts/epic-56-unified-orchestration-runtime.md#story-56-7
- [ ] Story 56.8: Big-bang migration — 10 phases + axes.correction split + doc-conflict split
  > **As an** Anatoly maintainer **I want** all 10 phases in `run.ts` migrated through `runPhase`, all 18 call sites going through the registry, `doc-conflict-detection` split into 2 named phases, and `axes.correction` split into pass1+verify primitives **So that** the registry/runtime is exhaustively wired and the legacy inline orchestration disappears in a single PR.
  > AC: Given the 6 inline phase functions in `src/commands/run.ts` (`runSetupPhase`, `runRagPhase`, bootstrap-doc+doc-conflict inline block, internal-docs+doc-conflict inline block, `runReviewPhase`, refinement inline block, `runReportPhase`), When FR15 is applied, Then each is refactored to use `await runPhase(ctx, '<phase-name>', async () => {…})`. The ~25 manual `ctx.timeline.push({event:'phase_start',…})` calls and 7 manual `ctx.phaseDurations[X] = …` are removed. The phase plumbing LOC in `run.ts` drops from ~300 to ≤ 30.
  > AC: Given the `doc-conflict-detection` phase currently invoked at `run.ts:1052-1068` (post-bootstrap) and `run.ts:1111-1127` (post-update), When FR14 is applied, Then the first becomes `runPhase(ctx, 'doc-conflict-bootstrap', async () => runDocConflictDetection({…}))` and the second becomes `runPhase(ctx, 'doc-conflict-update', async () => runDocConflictDetection({…}))`. The internal logic of `runDocConflictDetection` is unchanged. `ctx.phaseDurations` now has two distinct keys.
  > AC: Given `src/core/axes/correction.ts` with inline pass1+verify 2-pass logic, When FR13 is applied, Then the file is reduced to a thin shell that registers no logic (the composer registry holds the orchestration). Two new primitive files are created: `src/core/orchestration/registry/primitives/axes/correction-pass1.ts` and `src/core/orchestration/registry/primitives/axes/correction-verify.ts`. The composer `axes.correction` (Story 56.3 FR4) orchestrates them via the DAG plan.
  > AC: Given the review phase composer, When it executes, Then the 7 axis composers (utility, duplication, correction, overengineering, tests, best-practices, documentation) fan out in parallel via `Promise.allSettled` (preserving the existing parallel semantic) and their results merge through the `axis-merger` step (preserving the existing merger logic, just integrated into the DAG)
  > AC: Given a real run on a representative fixture, When it completes, Then `run-metrics.json.phaseDurations` contains 11 keys post-split (no `doc-conflict-detection`, instead `doc-conflict-bootstrap` and `doc-conflict-update`). `phaseStats[name].providerStats[provider]` is populated for every phase that performed at least one LLM call. `primitiveStats[name]` and `composerStats[name]` are populated.
  > AC: Given the test `src/commands/run.test.ts`, When it runs, Then it asserts: every CANONICAL_PHASES item produces an entry in `phaseDurations` ; `phaseDurations['doc-conflict-bootstrap']` and `phaseDurations['doc-conflict-update']` are distinct values, never accumulated ; `phaseDurations` keys form exactly the canonical set, no extra, no missing
  > Spec: specs/planning-artifacts/epic-56-unified-orchestration-runtime.md#story-56-8
- [ ] Story 56.9: `@deprecated` cleanup — 9 items absorbed in big-bang PR
  > **As an** Anatoly maintainer **I want** 9 legacy items absorbed in the same big-bang PR as the orchestration refactor **So that** the drift surface shrinks visibly alongside the new contract, without leaving deprecated artifacts that confuse future contributors.
  > AC: Given `src/utils/format.ts` `verboseLog()` function, When FR21 is applied, Then the function is deleted and its ~5 callers replaced with `getLogger().debug(…)` direct
  > AC: Given `src/core/correction-memory.ts` with `FalsePositiveEntry`, `loadCorrectionMemory()`, `saveCorrectionMemory()`, and the legacy `correction-memory.json` read path, When FR22 is applied, Then these exports and the legacy file-read code are deleted. Any internal call sites are migrated to the `DeliberationMemory` API (verified by grep returning zero).
  > AC: Given the `EmbeddingsReadyFlag.python` field at `src/rag/hardware-detect.ts:159`, When FR23 is applied, Then the field is removed from the type, removed from any flag-writing code, and consumers reading the flag (none expected since `@deprecated`) are checked via grep
  > AC: Given the `renderShard()` legacy function at `src/core/reporter.ts:2164`, When FR24 is applied, Then the function is deleted. Clean-run consumers already migrated to `renderAxisShard()` (verified by grep).
  > AC: Given the `DocPrompt` type alias at `src/core/doc-llm-executor.ts:30`, When FR25 is applied, Then the alias is deleted. All imports replaced with direct `PagePrompt` from `doc-generator.ts`.
  > AC: Given the `resolveNlpModel()` alias at `src/core/axis-evaluator.ts:257`, When FR26 is applied, Then the alias is deleted. Callers (none direct expected) are migrated to `resolveCodeSummaryModel()`.
  > AC: Given `detectDocGaps()` and `formatGapReport()` v1 API at `src/core/doc-gap-detection.ts:525,544`, When FR27 is applied, Then both v1 functions are deleted. Internal delegation to v2 is folded into the v2 API directly. No external callers.
  > AC: Given the NLP cache migration one-shot logic at `src/rag/indexer.ts:341-398`, When FR28 is applied, Then the migration-detection block is deleted. The merged-cache format is now the only format. Documented in changelog as "users on releases older than v0.X must run their first post-upgrade run, which will regenerate the unified cache".
  > AC: Given `npm run typecheck && npm run build`, When executed after all cleanup, Then both succeed with zero warnings. The diff stats show a net reduction in LOC roughly equivalent to the inlined plumbing eliminated by Story 56.8.
  > Spec: specs/planning-artifacts/epic-56-unified-orchestration-runtime.md#story-56-9
- [ ] Story 56.10: Regression test suite — 6 test files covering 7 KPIs
  > **As an** Anatoly maintainer **I want** an automated regression suite that enforces the orchestration contract continuously **So that** any future PR that drifts from the contract (e.g.
  > adds a phase without `runPhase`, leaks a prompt into D.3, fails to attribute a call) fails CI before merge.
  > AC: Given the absence of a coverage regression test, When `src/core/orchestration/coverage.test.ts` is implemented (KPI 1), Then it enumerates `CANONICAL_PHASES` ; for each, asserts (a) the phase emits all 8 effects via a recorded synthetic run, (b) it routes through `runPhase` (grep `src/commands/run.ts` for `runPhase(ctx, '${phase}'`), (c) every LLM/agent call site in the recorded run carries a registered primitive name. Asserts every axis in the axis evaluator list has a matching composer in the registry.
  > AC: Given the run-metrics schema v2 validation (KPI 2), When `src/schemas/run-metrics.test.ts` is implemented or extended, Then it loads a fixture `run-metrics.json` produced by a real run, validates it against a schema requiring `phaseDurations` per canonical phase, `phaseStats[phase].providerStats[provider]` per (phase, provider) executed, `primitiveStats[name]` per primitive invoked, `composerStats[name]` per composer invoked. Zero missing keys, zero unknown keys.
  > AC: Given the plan-fidelity test (KPI 3), When `src/core/orchestration/plan-fidelity.test.ts` is implemented, Then it runs a fixture pipeline end-to-end, reads `{runDir}/costs/variance.json`, asserts every `byComposer[name].deviationPct` is within ±20 %. A deviation outside the bound = test failure = pricing model or estimator out of calibration.
  > AC: Given the exchange Zod-strict test (KPI 5), When `src/core/orchestration/exchange.test.ts` exists from Story 56.4, Then it also verifies (added in 56.10) that no composer in the registry contains a step that mutates intermediate variables outside `exchange.write()`/`exchange.read()`. Lint rule + AST inspection. Direct property mutation banned.
  > AC: Given the four-artefact separation test (KPI 6), When `src/core/orchestration/artefact-separation.test.ts` is implemented, Then it runs a synthetic primitive invocation through the gateway, captures the 4 artefacts produced, and asserts: D.1 (exchange entry) contains no `prompt`/`system`/`durationMs`/`costUsd` ; D.2 (dump file) contains no NDJSON event blocks ; D.3 (log event) contains no full prompt/response and no `cacheReadTokens`/`pricingModel`/`estimatedUsd` ; D.4 (ledger record) contains no `event` field nor `prompt`/`assistantResponse`. Combined with ESLint custom rules for static checking.
  > AC: Given the cost integrity test (KPI 7), When `src/core/orchestration/cost-integrity.test.ts` is implemented, Then it runs a synthetic pipeline and asserts: for every `resource_call_end` event in `{runDir}/logs/anatoly.ndjson`, exactly one D.4 ledger record exists in `{runDir}/costs/ledger.ndjson` with the same `callId` ; for every `plans/{phase}.json` step entry, a `planId` record exists in the ledger ; zero `costUsd: 0` records from subscription transports (subscription = `null` + `'unknown'`, cache hit = `0` + `'actual'` distinct).
  > AC: Given the anatoly-bench coordination (NFR10), When Story 56.8 lands the `axes.correction` split, Then a coordinated PR in the sibling repo `../anatoly-bench` updates fixtures and the catalog if necessary, and the F1 score for `axes.correction` is non-negative compared to baseline pre-epic-56. Documented in the PR as a benchmark verification before merge.
  > AC: Given `npm run test` after all stories, When executed on the branch, Then all 6 new test files pass green, existing tests pass, and the diff in `run-metrics.json` output between baseline and branch shows no functional regression (just the expected schema v2 enrichment).
  > Spec: specs/planning-artifacts/epic-56-unified-orchestration-runtime.md#story-56-10

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
