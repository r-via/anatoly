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
  > As a développeur du pipeline
  > I want que le TransportRouter gère les semaphores et breakers par provider
  > So that la concurrence et la résilience ne soient plus propagées manuellement dans toute la stack.
  > AC: Given `TransportRouter` est instancié avec `config`, When `config.providers` contient `anthropic: { concurrency: 24 }` et `google: { concurrency: 10 }`, Then `router.semaphores` contient `Map { "anthropic" → Semaphore(24), "google" → Semaphore(10) }`
  > AC: Given un provider n'a pas de `concurrency` dans la config, When le router est construit, Then le semaphore est créé avec `concurrency: 10` (default)
  > AC: Given `TransportRouter` est instancié, When `config.providers` contient des providers, Then un `CircuitBreaker` est créé pour chaque provider
  > AC: Given `router.getSemaphoreStats()` est appelé, When 3 slots sont acquis sur "anthropic", Then il retourne `Map { "anthropic" → { active: 3, total: 24 }, "google" → { active: 0, total: 10 } }`
  > AC: Given `router.getBreakerState("google")` est appelé, When le breaker Google est fermé, Then il retourne `'closed'`
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-1
- [x] Story 46.2: API acquire / acquireSlot / release
  > As a développeur du pipeline
  > I want une API unifiée pour acquérir un slot de concurrence avec gestion du breaker
  > So that l'appelant n'ait qu'un seul point d'entrée et que le cleanup soit garanti.
  > AC: Given `router.acquire("google/gemini-2.5-flash")` est appelé, When le breaker Google est fermé et un slot est disponible, Then il retourne `{ transport: LlmTransport, release: Function }`, And le semaphore Google a un slot de moins
  > AC: Given `router.acquire("google/gemini-2.5-flash")` est appelé, When le breaker Google est ouvert, Then il throw `Error("Provider 'google' circuit breaker is open")`, And aucun slot de semaphore n'est consommé
  > AC: Given `router.acquireSlot("anthropic/claude-opus-4-6")` est appelé, When le breaker Anthropic est fermé, Then il retourne `{ release: Function }`, And le semaphore Anthropic a un slot de moins
  > AC: Given `release({ success: true })` est appelé, When après un appel réussi, Then le semaphore est libéré, And `circuitBreaker.recordSuccess()` est appelé
  > AC: Given `release({ success: false, error })` est appelé, When après un appel en échec, Then le semaphore est libéré, And `circuitBreaker.recordFailure()` est appelé
  > AC: Given `release()` est appelé sans argument, When en mode implicite, Then le comportement est identique à `release({ success: true })`
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-2
- [x] Story 46.3: Renommage GeminiCircuitBreaker → CircuitBreaker
  > As a développeur
  > I want que le circuit breaker soit provider-agnostique
  > So that tout provider puisse en bénéficier.
  > AC: Given `src/core/circuit-breaker.ts` exporte `GeminiCircuitBreaker`, When il est renommé en `CircuitBreaker`, Then toutes les importations sont mises à jour, And les commentaires/JSDoc ne mentionnent plus "Gemini" spécifiquement, And les tests dans `circuit-breaker.test.ts` sont mis à jour
  > AC: Given `CircuitBreaker` est utilisé, When il est instancié par le `TransportRouter`, Then la logique closed/open/half-open est inchangée
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-3
- [x] Story 46.4: Nettoyage interfaces — suppression semaphore/breaker manuels
  > As a développeur du pipeline
  > I want que les interfaces ne contiennent plus de champs semaphore/breaker, So que la résilience soit entièrement encapsulée dans le router.
  > AC: Given `AxisContext` dans `axis-evaluator.ts`, When les champs `semaphore`, `geminiSemaphore`, `circuitBreaker` sont supprimés, Then seul `router: TransportRouter` reste comme point d'accès au transport
  > AC: Given `SingleTurnQueryParams` dans `axis-evaluator.ts`, When les champs `semaphore`, `geminiSemaphore`, `circuitBreaker`, `transport` sont supprimés, Then seul `router: TransportRouter` reste, And `runSingleTurnQuery` utilise `router.acquire(model)` en interne
  > AC: Given `EvaluateFileOptions` dans `file-evaluator.ts`, When `geminiSemaphore` et `circuitBreaker` sont supprimés, Then le fichier propage uniquement le `router`
  > AC: Given `RunContext` / `PipelineState`, When `sdkSemaphore`, `geminiSemaphore`, `circuitBreaker` sont supprimés, Then seul le `router` est conservé
  > AC: Given les 7 axes dans `src/core/axes/*.ts`, When les spreads `geminiSemaphore: ctx.geminiSemaphore` et `circuitBreaker: ctx.circuitBreaker` sont supprimés, Then seul `router: ctx.router` est propagé
  > AC: Given `resolveSemaphore()` dans `axis-evaluator.ts`, When il est supprimé, Then aucun code ne le référence
  > AC: Given les params dans `rag/orchestrator.ts`, `rag/nlp-summarizer.ts`, `rag/standalone.ts`, When `geminiSemaphore` est supprimé des signatures, Then seul le `router` est passé
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-4
- [x] Story 46.5: Migration appels agentic vers acquireSlot
  > As a développeur du pipeline
  > I want que les appels agentic (Tier 3, doc gen, Vercel Agent) utilisent `acquireSlot()`, So que la concurrence et le breaker couvrent tous les chemins LLM.
  > AC: Given Tier 3 correction dans `run.ts` (direct `query()` Claude SDK), When `ctx.sdkSemaphore.acquire()` est remplacé par `router.acquireSlot(model)`, Then le semaphore est géré par le router, And `release({ success })` est appelé en finally, And le breaker est vérifié avant l'appel
  > AC: Given Doc gen Sonnet coherence dans `doc-llm-executor.ts`, When `if (semaphore) await semaphore.acquire()` est remplacé par `router.acquireSlot(model)`, Then le router est injecté dans `doc-llm-executor`, And `release({ success })` est appelé en finally
  > AC: Given Doc gen Opus review dans `doc-llm-executor.ts`, When le semaphore manuel est remplacé par `router.acquireSlot(model)`, Then même pattern que Sonnet coherence
  > AC: Given Doc gen pages dans `run.ts`, When il n'a actuellement ni semaphore ni breaker, Then `router.acquireSlot(model)` est ajouté avec `release({ success })` en finally
  > AC: Given `vercel-agent.ts`, When il n'a actuellement ni semaphore ni breaker, Then le router est injecté et `acquireSlot(model)` est ajouté avec `release({ success })` en finally
  > AC: Given `screen-renderer.ts` affiche les stats semaphore, When il accédait directement aux semaphores, Then il utilise `router.getSemaphoreStats()`
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-5
- [x] Story 46.6: Tests d'intégration et validation
  > As a mainteneur d'anatoly
  > I want valider que la migration n'a introduit aucune régression
  > So that les appels LLM fonctionnent identiquement avec le nouveau router.
  > AC: Given les tests existants du circuit breaker, When ils sont exécutés avec `CircuitBreaker` (renommé), Then tous passent sans modification de logique
  > AC: Given les tests existants de `runSingleTurnQuery`, When ils sont adaptés pour mocker `router.acquire()` au lieu de semaphores séparés, Then le comportement est identique
  > AC: Given un test d'intégration du router, When `acquire()` est appelé N+1 fois (N = concurrency), Then le N+1ème appel attend jusqu'à ce qu'un `release()` libère un slot
  > AC: Given un test breaker + acquire, When 3 `release({ success: false })` consécutifs sont appelés, Then le prochain `acquire()` throw immédiatement (breaker ouvert)
  > AC: Given un test acquireSlot + release, When `acquireSlot()` est appelé et `release({ success: true })` en finally, Then le semaphore est libéré et le breaker reçoit le success
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-6

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
