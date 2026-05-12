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
  > **As an** Anatoly developer **I want** une fonction unique `resolveDocMode(config): 'off' | 'lite' | 'full'` **So that** les comportements mode-dependent de l'epic 55 ne dupliquent pas les checks ad-hoc actuellement disséminés dans le code.
  > AC: Given [src/core/run-config.ts](src/core/run-config.ts) sans utilitaire centralisé de résolution du mode doc, When `resolveDocMode(config)` est implémenté et exporté, Then la fonction retourne le type union strict `'off' | 'lite' | 'full'` (pas d'`undefined`, pas de `string`)
  > AC: Given les call-sites inline actuels (`internal-docs-context.ts:24`, `run.ts:977-988`, `run.ts:1149-1156`, autres trouvés au grep), When le refactor remplace chaque check `config.documentation?.internal?.mode === '…'` par `resolveDocMode(config)`, Then aucun check inline ne subsiste dans le codebase (vérifié par grep CI)
  > AC: Given la suite de tests `src/core/run-config.test.ts`, When elle est exécutée après refactor, Then elle couvre les 3 valeurs valides retournées et la levée d'erreur Zod si `documentation.internal.mode` est absent (cohérent avec le "no-magic" de epic 54)
  > AC: Given un run complet avant et après refactor sur un projet fixture, When les outputs sont comparés, Then aucun changement comportemental observable (pur refactor)
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-1
- [ ] Story 55.2: Déplacement de `runDocUpdate` en pré-review
  > **As an** architecte pipeline **I want** que la mise à jour de la doc interne se fasse avant la phase review **So that** les arbitrages humains appliqués par le `doc-conflict-detector` puissent informer la review du run courant, pas seulement du run suivant.
  > AC: Given le pipeline actuel où `runDocUpdate` est appelé en post-review ([run.ts:1146-1176](src/commands/run.ts#L1146-L1176)), When le déplacement en pré-review est effectué, Then `runDocUpdate` est appelé entre la phase scan/triage et la phase RAG indexing, et le bloc actuel `run.ts:1146-1176` est supprimé
  > AC: Given l'ancien gate de skip `filesReviewed > 0` (incompatible avec pré-review), When le déplacement est effectué, Then le gate devient `triage.tier === 'evaluate'` vide (pas de fichier code modifié = pas de régénération)
  > AC: Given `pipelineState.addTask('internal-docs', ...)` actuellement positionné après refinement, When la phase est déplacée, Then la task `internal-docs` est repositionnée dans le pipeline display pour refléter le nouvel ordre pré-review
  > AC: Given un projet fixture où la doc interne a été générée avec succès, When un nouveau run est lancé après le déplacement, Then `writeScaffoldStatus(... mode: 'update' ...)` est appelé au même moment fonctionnel (après update réussie) avec son nouveau timing pré-review
  > AC: Given un fixture stable et un même état de code entre 2 runs, When un run avant déplacement et un run après déplacement produisent leur output, Then les fragments doc internes générés sont identiques (test d'invariance) et la phase `internal-docs` dans `run-metrics.json` apparaît avant la phase `review`
  > AC: Given un grep exhaustif du codebase pour les consommateurs internes de la phase `internal-docs`, When le déplacement est effectué, Then aucun consumer ne casse (aucun code ne dépendait du timing post-review)
  > AC: Given un cas où `runDocUpdate` échoue en pré-review (LLM down, fichier corrompu, etc.), When l'erreur survient, Then le run abort immédiatement (exit code 2, statut `failed`) avec un message d'erreur clair, plutôt que de continuer la review avec une doc potentiellement stale ou des arbitrages obsolètes
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-2
- [ ] Story 55.3: Schéma `DocConflictSchema` + YAML I/O + hash anchoring
  > **As an** Anatoly developer **I want** un schéma Zod strict pour la persistance des conflits doc/code **So that** chaque lecture du fichier soit validée et toute corruption détectée immédiatement avec un message actionnable.
  > AC: Given l'absence d'un schéma persistant pour les conflits doc/code, When `src/schemas/doc-conflict.ts` est implémenté selon FR2/FR3, Then il exporte `DocConflictSchema`, `DocConflictsLockSchema`, `DocConflictVerdict`, `DocConflictStatus` avec tous les champs requis (id, anchor avec code_hash, reference_excerpt, code_summary, signals, verdict, status)
  > AC: Given le besoin de lire/écrire `doc-conflicts.yaml` de manière fiable, When `src/core/doc-conflict-store.ts` est implémenté, Then les helpers `loadDocConflicts(projectRoot)` et `saveDocConflicts(projectRoot, lock)` font de l'I/O YAML atomique (NFR1 — temp + rename), valident strictement via Zod, et écrivent des commentaires YAML auto-générés sur les champs `signals`
  > AC: Given le besoin d'ancrer un conflit à un fragment de code précis, When `hashCodeAnchor(filePath, symbol?, lineRange?, fileContent)` est implémenté, Then il retourne un SHA-256 du contenu normalisé (NFR2 — sans espaces de tête/fin, sans CRLF), au grain symbole quand `LanguageAdapter.extractSymbolBody` est disponible, fallback au grain `lineRange` de la déclaration
  > AC: Given un DocConflict existant et le contenu courant d'un fichier code, When `verifyAnchorHash(entry, currentFileContent)` est appelé, Then il retourne `'valid'` si le hash courant matche le `code_hash` stocké, `'stale'` sinon
  > AC: Given la suite de tests `src/schemas/doc-conflict.test.ts` et `src/core/doc-conflict-store.test.ts`, When elle est exécutée, Then le round-trip YAML→Zod→YAML conserve les entrées, la validation rejette un fichier malformé avec ligne fautive, et le hash reste stable à reformatage cosmétique (espaces, CRLF)
  > AC: Given un fichier `doc-conflicts.yaml` avec `version: 2`, When `loadDocConflicts` est appelé, Then la validation rejette avec un message clair "unsupported version, run anatoly docs upgrade-conflicts" (NFR7), aucun crash silencieux
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-3
- [ ] Story 55.4: Agent `doc-conflict-detector` + branchement pipeline
  > **As an** auditeur Anatoly **I want** que chaque run détecte les divergences entre la doc interne (machine) et la doc humaine, et applique les arbitrages que j'ai rendus depuis le run précédent **So that** mes décisions humaines de promotion d'autorité prennent effet sans intervention manuelle au moment du run.
  > AC: Given l'absence d'agent dédié à la détection de conflits doc/code, When `src/core/doc-conflict-detector.ts` est implémenté selon FR4, Then il exporte `runDocConflictDetection(ctx, opts)` qui charge le lock, vérifie les hashes, applique les arbitrages résolus, détecte les nouveaux conflits, et réécrit `doc-conflicts.yaml`
  > AC: Given les helpers existants `buildCodeSurfaceSummary` et `buildCoherenceUserMessage` de [src/core/doc-coherence-3way.ts](src/core/doc-coherence-3way.ts), When le détecteur construit son prompt 3-way (code ↔ internal ↔ reference), Then il réutilise ces helpers sans dupliquer la logique de construction de prompt
  > AC: Given une nouvelle divergence détectée entre internal et reference, When les signaux d'arbitrage sont calculés, Then `doc_last_touched` et `code_last_touched` sont extraits via `git log -1 --format=%cI -- <file>`, `test_covers_current_behavior` est calculé par grep heuristique du symbole dans `/*.test.*`/`/*_test.*`, et la `presumption` est dérivée selon une règle documentée dans le code
  > AC: Given un verdict humain `doc-wins, status: applied` pour un conflit donné, When le détecteur applique ce verdict, Then le fragment internal-doc concerné est réécrit pour figer l'intention humaine (mutation contrôlée), sans backup local — l'audit canonique reste dans `doc-conflicts.yaml` (verdict + verdict_note + verdict_set_at + code_hash), et un rollback via `--review` régénère le fragment from scratch au run suivant
  > AC: Given la fin de `runDocBootstrap` (premier run) et la fin de `runDocUpdate` (chaque run) dans [run.ts](src/commands/run.ts), When le détecteur est branché selon FR5, Then il est invoqué exactement à ces deux points, jamais en mode `off`
  > AC: Given un projet configuré en mode `lite`, When le pipeline doc tourne, Then le détecteur est court-circuité (no-op explicite avec log info), aucune entrée n'est créée dans `doc-conflicts.yaml`
  > AC: Given un appel au détecteur qui consomme du LLM, When le run se termine, Then `recordLlmCost(ctx, {provider, phase: 'doc-conflict-detection', costUsd, durationMs, inputTokens, outputTokens, ...})` est émis selon FR15 et apparaît dans `run-metrics.json`
  > AC: Given un fixture où code et reference divergent sur un symbole exporté, When un premier run est lancé, Then une entrée `verdict: pending` est créée avec signaux correctement calculés ; puis après édition manuelle de `doc-conflicts.yaml` pour mettre `verdict: doc-wins`, le run suivant applique, le fragment internal-doc concerné est réécrit, et son frontmatter passe à `status: evaluated`
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-4
- [ ] Story 55.5: Mode `lite` digest marqué `evaluated`
  > **As an** utilisateur en mode `lite` **I want** que le digest de la reference produit en mode lite soit consommable par l'axe correction comme reference supplémentaire (compacte) **So that** je bénéficie de l'économie de tokens du mode lite sans perdre la traçabilité documentaire.
  > AC: Given `buildInternalDocsDigest` actuel ([internal-docs-digest.ts](src/core/internal-docs-digest.ts)) qui produit un digest sans frontmatter, When la fonction est étendue pour mode `lite`, Then le digest produit porte un frontmatter explicite `status: evaluated, source: reference-digest` (autoritaire par construction puisque dérivé du contenu humain)
  > AC: Given le digest mode lite marqué `status: evaluated`, When `renderReferenceDocsContext` est appelé par l'axe correction (et homologues best_practices, overengineering), Then ce digest est reconnu et injecté dans la section "Reference docs", pas dans la section "Internal docs (context only)"
  > AC: Given un projet fixture configuré en mode `lite` avec une reference humaine non-triviale, When un run complet est lancé, Then le digest est produit, l'axe correction le voit comme reference autoritaire, et aucune entrée n'apparaît dans `doc-conflicts.yaml` (le fichier reste absent ou vide — court-circuit du détecteur défini dans Story 55.4 AC6)
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-5
- [ ] Story 55.6: Commande `anatoly docs arbitrate` (wizard)
  > **As an** utilisateur Anatoly **I want** un wizard CLI pour arbitrer les conflits doc/code détectés **So that** je n'aie pas à éditer manuellement un fichier YAML pour rendre mes décisions.
  > AC: Given un `doc-conflicts.yaml` contenant au moins une entrée `verdict: pending`, When l'utilisateur lance `anatoly docs arbitrate` sans argument, Then un wizard `@clack/prompts` s'ouvre et itère sur les entrées `pending`
  > AC: Given une entrée pending affichée dans le wizard, When l'utilisateur la consulte, Then l'affichage présente l'ancre (file, symbol, line range), le `reference_excerpt`, le `code_summary`, les `signals` (avec présomption mise en avant), et propose les choix `doc-wins`, `code-wins`, `skip`, `defer` plus une note optionnelle multi-ligne
  > AC: Given un wizard en cours d'arbitrage, When l'utilisateur rend chaque verdict, Then `doc-conflicts.yaml` est sauvegardé de manière incrémentale après chaque réponse (NFR8), et un Ctrl+C préserve les arbitrages déjà rendus
  > AC: Given un `doc-conflicts.yaml` avec des entrées `status: applied`, When l'utilisateur lance `anatoly docs arbitrate --review`, Then le wizard itère aussi sur les entrées appliquées et propose de re-basculer en `pending` (pour reconsidérer un ancien arbitrage)
  > AC: Given un `doc-conflicts.yaml` contenant N entrées, When l'utilisateur lance `anatoly docs arbitrate --list`, Then un tableau récap (id, file, symbol, verdict, status) est affiché sans wizard
  > AC: Given un projet sans `doc-conflicts.yaml` (ou avec un fichier vide), When l'utilisateur lance `anatoly docs arbitrate`, Then un message clair "No conflicts to arbitrate. Run `anatoly run` first to generate conflicts." est affiché et la commande quitte sans erreur
  > AC: Given un `doc-conflicts.yaml` malformé (YAML invalide ou schéma Zod non respecté), When la commande tente de le charger, Then une erreur claire avec ligne fautive est affichée, et la commande quitte en exit code non-zéro
  > AC: Given la suite de tests E2E avec injection clack, When un parcours complet de 3 entrées simulé est exécuté, Then le fichier YAML écrit en sortie est correct, valide Zod, et reflète les 3 verdicts simulés
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-6
- [ ] Story 55.7: Axe correction consomme les arbitrages `doc-wins`
  > **As an** axe correction **I want** consommer les fragments internal-doc marqués `status: evaluated` comme reference supplémentaire **So that** un arbitrage humain `doc-wins` se traduise par des findings correction quand le code contredit l'intention validée.
  > AC: Given `renderReferenceDocsContext` actuel ([src/core/axes/reference-docs-context.ts:17](src/core/axes/reference-docs-context.ts#L17)) — utilisé par les axes correction, best_practices, overengineering, When la fonction est étendue pour reconnaître les fragments internal-doc marqués `status: evaluated`, Then elle les injecte en section "Arbitrated internal docs (human-validated)" dans le prompt, et l'extension prend effet automatiquement sur les 3 axes sans modification spécifique
  > AC: Given des fragments internal-doc avec `status: unevaluated` (cas par défaut hors arbitrage), When les axes consomment leur contexte, Then ces fragments restent injectés via `renderInternalDocsContext` (contexte faible, sans autorité), comportement epic 54 inchangé
  > AC: Given la suite de tests de prompt pour les 3 axes consommateurs, When elle est exécutée avec un mix de fragments `evaluated` et `unevaluated`, Then les deux sections coexistent sans collision et leurs marquages d'autorité sont visiblement distincts dans le texte produit
  > AC: Given un fixture anatoly-bench avec une divergence arbitrée `doc-wins, applied`, When un run est lancé après extension, Then l'axe correction produit une finding qui pointe le code contredisant l'intention validée, et le delta F1 mesuré est positif ou neutre par rapport à la baseline pré-epic-55
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-7
- [ ] Story 55.8: Axe documentation rapporte les `code-wins` comme "reference stale"
  > **As an** axe documentation **I want** rapporter les portions de doc humaine que l'utilisateur a explicitement marquées obsolètes via `verdict: code-wins` **So that** la dette documentaire identifiée par arbitrage humain devienne visible dans le rapport et scorée comme une finding axe documentation.
  > AC: Given le schéma de findings axe documentation actuel, When il est étendu pour epic 55, Then un nouveau kind `doc_stale_reference` est ajouté avec les champs `reference_path`, `reference_line_range?`, `arbitrated_at`, `arbitration_note?`
  > AC: Given un `doc-conflicts.yaml` contenant des entrées `verdict: code-wins, status: applied`, When l'axe documentation build son contexte au run suivant, Then il lit le fichier, filtre ces entrées, et émet une finding `doc_stale_reference` par entrée pointant la portion de reference concernée
  > AC: Given des findings `doc_stale_reference` produites par l'axe documentation, When le scoring du rapport est calculé, Then elles sont scorées au même titre que les findings de gap actuelles et impactent la F1 globale de l'axe documentation
  > AC: Given un fixture avec un arbitrage `code-wins, applied` pré-existant, When un run est lancé, Then une finding `doc_stale_reference` apparaît dans le rapport pointant la portion de reference que l'humain a explicitement marquée obsolète
  > AC: Given le repo sibling `../anatoly-bench` qui maintient le catalogue de scoring, When epic 55 est mergé, Then le nouveau kind `doc_stale_reference` est ajouté au catalogue (PR jumelle dans anatoly-bench) pour les fixtures qui le testent
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-8
- [ ] Story 55.9: Intégration `estimate` + run-metrics + hints démarrage/fin
  > **As an** utilisateur Anatoly **I want** que `anatoly estimate` reflète fidèlement le coût de chaque run avec epic 55 activé **So that** je ne sois pas surpris en aval par un coût LLM caché.
  > AC: Given `forecastRun` dans [src/commands/estimate.ts](src/commands/estimate.ts) qui aujourd'hui ne forecaste pas le doc-conflict-detector, When epic 55 est implémenté, Then une ligne dédiée au `doc-conflict-detector` est ajoutée à la prévision (1 appel par run en mode `full`, 0 en lite/off)
  > AC: Given la dette pré-existante : `runDocCoherenceReview` non intégré à estimate, When epic 55 rattrape cette dette, Then son coût est aussi inclus dans `forecastRun`, de sorte qu'aucun agent doc-pipeline ne reste invisible au forecasting
  > AC: Given le breakdown final d'estimate affiché à l'utilisateur, When un run en mode `full` est forecasté, Then les coûts doc-pipeline (`scaffold`, `generation`, `coherence-review`, `conflict-detection`) apparaissent clairement séparés des coûts review
  > AC: Given un run en mode `full` qui invoque le doc-conflict-detector, When le run se termine, Then `run-metrics.json` inclut une entrée `phase: 'doc-conflict-detection'` avec input/output tokens, cost USD, duration au format standard
  > AC: Given un `doc-conflicts.yaml` contenant au moins une entrée pending au démarrage du run, When le run est lancé hors mode `--plain`, Then `p.note()` clack affiche un encart visible avec le nombre d'entrées pending et la commande `anatoly docs arbitrate` (FR16)
  > AC: Given le même scénario en mode `--plain`, When le run est lancé, Then une ligne stderr équivalente est émise (compatible scripting)
  > AC: Given un run qui se termine avec des entrées `pending` restantes (anciennes non résolues + nouvelles détectées), When le summary final est imprimé, Then il inclut "X doc conflicts pending — run `anatoly docs arbitrate`" (FR17)
  > AC: Given une suite de tests d'intégration avec 3 conflits pending pré-existants, When elle est exécutée, Then le hint au démarrage et le rappel en fin de run apparaissent tous les deux dans la sortie capturée
  > Spec: specs/planning-artifacts/epic-55-doc-conflicts-arbitration.md#story-55-9

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
