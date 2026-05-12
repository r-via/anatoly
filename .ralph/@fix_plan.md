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
- [x] Story 52.4: Migration `shared/` content-addressable (reviews, refinements, NLP) avec sharding + manifests
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

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
