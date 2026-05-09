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

> **Note :** Epic expérimental intégré sur une branche séparée (`compression-rollout`). Toutes les stories sont marquées `[x]` ici pour que Ralph ne tente pas de les ré-implémenter sur la branche courante. Le suivi réel se fait sur la branche dédiée.

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
  > As a utilisateur d'anatoly
  > I want pouvoir m'attacher en lecture seule à un run en cours depuis n'importe quel terminal, So que je voie le déroulement live sans devoir rester scotché au terminal d'origine et sans risquer d'interférer avec le process actif.
  > AC: Given un nouveau fichier `src/commands/attach.ts` est créé, When il exporte `registerAttachCommand(program: Command)`, Then la commande déclarée est `attach [runId]` avec description `Attach a live read-only viewer to a running audit`, And elle accepte les options : `--from-start` (replay du ndjson depuis le début, par défaut tail-only) et `--no-color` (désactive couleurs pour piping), And elle est enregistrée dans le `cli.ts` (ou point d'entrée équivalent) au même endroit que `registerStatusCommand`
  > AC: Given la commande est invoquée sans `runId`, When le code de résolution s'exécute, Then il appelle `listRunStatuses(projectRoot)` puis filtre `s.status === 'running' && isProcessAlive(s.pid)`, And s'il y a exactement 1 match, ce run est sélectionné, And s'il y a 0 match, la commande affiche `No active run found. Use 'anatoly status' to list all runs.` et `process.exit(1)`, And s'il y a > 1 match, la commande affiche la liste des runs candidats et `Specify a run ID with: anatoly attach <runId>` puis `process.exit(1)`
  > AC: Given la commande est invoquée avec un `runId` (préfixe court ou complet), When la résolution s'exécute via `resolveRunDir(projectRoot, runId)` ([utils/run-id.ts](src/utils/run-id.ts)), Then si le runDir n'existe pas → `Run "<runId>" not found.` exit 1, And si le runDir existe mais `run-status.json` est absent ou status `done`/`failed`/`crashed` → message `Run "<runId>" is not active (status: <status>). Use 'anatoly status <runId>' for details.` exit 1, And si le runDir existe et status `running` mais `isProcessAlive(pid) === false` → ré-écrit le status en `crashed`, message `Run "<runId>" was running but PID <pid> is dead — marked as crashed.` exit 2, And si tout est OK → la commande continue vers le tail (Story 53.5)
  > AC: Given la résolution sélectionne un run actif, When la commande affiche son header initial, Then elle imprime :, run         <runId>, pid         <pid>, started     <startedAt humanisé, ex "32s ago">, branch      <branch>, commit      <commit>, background  <true|false>, log         .anatoly/runs/<runId>/anatoly.ndjson, attached at <ISO timestamp>, (Press Ctrl-C to detach — does not stop the run)
  > AC: Given un test unit `attach-resolve.test.ts`, When il prépare un répertoire `.anatoly/runs/` avec 3 runs (1 actif, 1 done, 1 crashed) et invoque la résolution, Then sans argument → l'actif est sélectionné, And avec un préfixe court qui matche le done → le done est sélectionné mais le message d'erreur "not active" est levé, And avec un préfixe ambigu (matche 2 runs) → le message d'ambiguïté est levé (réutiliser le comportement existant de `resolveRunDir` si déjà ambigu-aware, sinon documenter comme limitation)
  > AC: Given plusieurs `anatoly attach` simultanés sur le même run actif, When ils démarrent en parallèle, Then chacun lit son propre run-status.json + ouvre son propre tail sur le même ndjson, And aucun lock n'est pris (NFR4), And le test multi-attach vérifie que les 3 process voient la même séquence d'events (à un éventuel delay file-system près)
  > Spec: specs/planning-artifacts/epic-53-in-flight-run-visibility.md#story-53-4
- [ ] Story 53.5: Tail ndjson + rendu TUI live + `--from-start`
  > As a utilisateur d'anatoly attaché à un run
  > I want voir la même barre de progression et le même flux de findings que le terminal d'origine du run, So que l'attach soit réellement utile et pas juste un dump brut de logs JSON.
  > AC: Given un nouveau module `src/core/ndjson-tail.ts` est créé, When il exporte `tailNdjson(filePath, opts: { fromStart: boolean, onEvent: (event: any) => void, onError: (err: Error) => void }): { stop: () => void }`, Then la fonction :
  > AC: Given un test unit `ndjson-tail.test.ts`, When il prépare un fichier `test.ndjson`, démarre `tailNdjson({ fromStart: true })`, écrit 3 events puis attend 100ms, écrit 2 events de plus, attend 100ms, appelle `stop()`, Then `onEvent` a été appelé exactement 5 fois avec les events parsés dans l'ordre, And un test additionnel écrit une ligne sans `\n` final, attend, écrit le `\n` + une nouvelle ligne complète → vérifie que les 2 lignes sont émises dans l'ordre
  > AC: Given le `attach.ts` est complété, When l'attach est actif sur un run, Then un `tailNdjson(ndjsonPath, { fromStart: opts.fromStart, onEvent: handleEvent })` est démarré, And `handleEvent(event)` dispatch sur le champ `event.event` (event-type) :, `phase_start` → mise à jour du badge phase courante (rendu en bas du TUI), `phase_end` → reset du badge ou bascule à la phase suivante, `file_review_end` (ou équivalent existant côté run) → ajout d'une ligne au stream findings + incrément du compteur, autres events → ignorés ou loggés en mode `--verbose` si le flag est ajouté
  > AC: Given la barre de progression, When elle est rendue, Then elle est mise à jour à chaque event qui change le compteur (`file_review_end`, `file_cached`, etc.) OU via une re-lecture périodique de `.anatoly/cache/progress.json` toutes les 1 seconde — le choix entre event-driven et polling est documenté dans la PR avec justification (a priori : event-driven prioritaire, polling fallback si certains events sont manquants côté run)
  > AC: Given un test integration `attach-live-render.integration.test.ts`, When il simule un run via : (a) création de `.anatoly/runs/test-run/`, (b) écriture incrémentale de `run-status.json` running puis done, (c) écriture incrémentale de `anatoly.ndjson` avec 3 events de phase + 5 events file_review_end, (d) écriture incrémentale de `progress.json`, Then un `child_process.spawn` de `anatoly attach test-run` est démarré, And la sortie du child est capturée, And le test vérifie que (i) la barre passe de 0% à 100% au cours du run, (ii) les 5 findings sont listés dans l'ordre, (iii) la commande exit 0 quand le run-status passe à done
  > AC: Given un attach démarre `--from-start` sur un run avec 500 events historiques, When la commande tourne, Then le rendu initial complet (replay des 500 events + bascule en tail) est fait en < 500ms (NFR3), And un test perf assert ce seuil (en marge x2 pour la CI variable, soit < 1000ms)
  > AC: Given le rendu TUI, When il consomme les events ndjson, Then il réutilise les mêmes helpers `buildProgressBar` ([utils/format.ts](src/utils/format.ts)) et `verdictColor` que `status` et `run`, And si une factorisation est nécessaire (séparer la logique de rendu de celle de `run.ts`), un module `src/core/tui-renderer.ts` est créé pour partager les composants
  > Spec: specs/planning-artifacts/epic-53-in-flight-run-visibility.md#story-53-5
- [ ] Story 53.6: Terminaison propre + détection crashed depuis attach
  > As a utilisateur d'anatoly attaché
  > I want que ma commande `attach` se termine proprement et signale clairement la cause de la fin du run cible, So que je sache si le run est terminé avec succès, en échec, ou crashé, et que mon shell ait un exit code utilisable pour scripter.
  > AC: Given la boucle principale de `attach.ts`, When elle suit un run en cours, Then elle re-lit `.anatoly/runs/<runId>/run-status.json` toutes les 1 seconde (ou via `fs.watch` sur ce fichier — choix documenté), And dès que le contenu indique `status !== 'running'`, la boucle stop le tail et bascule en finalisation
  > AC: Given la finalisation détecte `status: 'done'`, When le rendu final est imprimé, Then il imprime un séparateur, puis le résumé final identique à celui qu'aurait imprimé `run` à la fin (verdict global, total findings, durée, chemin du report.md), And la lecture du verdict global se fait via `loadReviews` + `computeGlobalVerdict` ([src/core/reporter.ts](src/core/reporter.ts)) sur le runDir ciblé, And l'exit code est `0` si verdict `CLEAN`, `1` sinon (cohérent avec `run` à [run.ts:3011](src/commands/run.ts#L3011))
  > AC: Given la finalisation détecte `status: 'failed'`, When le rendu final est imprimé, Then il imprime "Run failed: <error>" en rouge avec le champ `error` du run-status, And exit code `1`
  > AC: Given la finalisation détecte `status: 'crashed'`, When le rendu final est imprimé, Then il imprime "Run crashed (PID was alive at start of attach but died during the run)", And exit code `2`
  > AC: Given un poll `isProcessAlive(pid)` toutes les 2 secondes en parallèle du suivi `run-status.json`, When le PID est détecté mort alors que `run-status.json` indique encore `running`, Then l'attach met à jour `run-status.json` via `writeRunStatus` avec `status: 'crashed'` et `completedAt: new Date().toISOString()` (réutilise le pattern de [status.ts:127-131](src/commands/status.ts#L127-L131)), And le rendu final "crashed" est imprimé, And exit code `2`
  > AC: Given l'utilisateur appuie Ctrl-C pendant un attach actif, When le handler SIGINT s'exécute, Then le tail est stoppé proprement (handle.stop), And un message "detached from run <runId>" est imprimé, And exit code `130` (convention shell pour SIGINT), And le run cible n'est pas affecté (vérifié par test : run continue à écrire dans son ndjson après le détachement)
  > AC: Given un test integration `attach-termination.integration.test.ts`, When il couvre les 4 chemins de fin (done / failed / crashed / SIGINT), Then chaque chemin a son scénario distinct avec exit code asserté, And le scénario "crashed" tue le process simulé via `child.kill('SIGKILL')` après 200ms et vérifie que `attach` détecte la mort dans les 3 secondes suivantes (poll 2s + marge)
  > AC: Given un test négatif "attach n'écrit jamais dans ndjson", When il fait tourner un attach pendant un run mock simulé, Then la taille et le hash du fichier `anatoly.ndjson` ne sont jamais modifiés par le process attach (seul le run cible y écrit), And la seule écriture autorisée par attach est la transition `running → crashed` dans `run-status.json` (NFR5)
  > Spec: specs/planning-artifacts/epic-53-in-flight-run-visibility.md#story-53-6
- [ ] Story 53.7: Documentation utilisateur + help text + tracker updates
  > As a utilisateur d'anatoly
  > I want comprendre comment utiliser `attach` et savoir qu'il existe, So que je découvre la fonctionnalité sans avoir à lire le code source ou tomber sur l'epic.
  > AC: Given un nouveau fichier ou une section ajoutée à `docs/04-CLI-Reference/` (path à confirmer selon la structure docs actuelle, fallback : créer `docs/04-CLI-Reference/attach.md`), When il est rédigé, Then il contient :
  > AC: Given la sortie de `anatoly --help`, When elle est imprimée, Then elle liste `attach` parmi les commandes disponibles (Commander gère ça automatiquement après registration de la story 53.4)
  > AC: Given la sortie de `anatoly attach --help`, When elle est imprimée, Then elle décrit les options `--from-start` et `--no-color`, And mentionne "Press Ctrl-C to detach — does not stop the run"
  > AC: Given le `README.md` du projet, When il est lu après cet epic, Then la section "Commands" (ou équivalente) mentionne brièvement `anatoly attach` avec un lien vers la doc complète, And la section démontrant un usage typique est mise à jour si elle évoque les runs background (la mention "use `anatoly status` to monitor" peut être enrichie en "use `anatoly status` for a snapshot or `anatoly attach` for a live view")
  > AC: Given `_bmad-output/planning-artifacts/epics.md` (master tracker, s'il existe), When il est mis à jour, Then une entrée Epic 53 est ajoutée avec lien vers ce doc, And les bugs résolus (status detection foreground + chemin progress.json) sont listés, And les nouvelles capacités (`anatoly attach`) sont listées
  > AC: Given `_bmad-output/implementation-artifacts/sprint-status.yaml`, When il est mis à jour, Then une section Epic 53 est présente avec les 7 stories en statut adéquat (`backlog` → `in-progress` → `review` → `complete`)
  > AC: Given un test de documentation lint markdown, When il est exécuté, Then les liens internes de la nouvelle doc attach sont valides
  > Spec: specs/planning-artifacts/epic-53-in-flight-run-visibility.md#story-53-7

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
