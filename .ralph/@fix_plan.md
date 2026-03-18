# Ralph Fix Plan

## Stories to Implement

### Epic 1 : Fondation du projet et scan du codebase
> Goal: Le développeur peut scanner son projet TypeScript et obtenir une cartographie complète de ses fichiers (AST, symboles, hashes, coverage).

- [x] Story 1.1: Initialisation du projet et structure CLI
  > Installer Anatoly via npx et voir les commandes disponibles.
  > AC: Given un projet Node.js, When `npx anatoly --help`, Then liste des sous-commandes et options globales affichée.
  > AC: Given le projet initialisé, When on consulte la structure, Then `src/commands/`, `src/core/`, `src/schemas/`, `src/utils/` existent avec barrel exports, tsup/vitest/eslint/typescript configurés, package.json contient bin et type module.

- [x] Story 1.2: Schémas Zod et gestion d'erreurs
  > Schémas Zod comme source de vérité et système d'erreurs standardisé.
  > AC: Given les fichiers de schémas dans `src/schemas/`, When on consulte `review.ts`, `task.ts`, `config.ts`, `progress.ts`, Then les schémas Zod sont définis conformément au PRD.
  > AC: Given `src/utils/errors.ts`, When une erreur survient, Then une AnatolyError est lancée avec un code standardisé et un flag recoverable.

- [x] Story 1.3: Chargement de configuration
  > Charger la configuration `.anatoly.yml` ou utiliser des défauts sensés.
  > AC: Given un projet avec `.anatoly.yml` valide, When Anatoly charge la config, Then les valeurs sont parsées et validées par ConfigSchema.
  > AC: Given un projet sans `.anatoly.yml`, When Anatoly charge la config, Then des défauts automatiques sont appliqués.
  > AC: Given un `.anatoly.yml` malformé, When Anatoly tente de charger, Then une AnatolyError CONFIG_INVALID est lancée.

- [x] Story 1.4: Scanner AST et hash SHA-256
  > Scanner le projet pour extraire l'AST de chaque fichier TypeScript et calculer un hash SHA-256.
  > AC: Given un projet TS, When `npx anatoly scan`, Then chaque fichier est parsé via web-tree-sitter, hash SHA-256 calculé, `.task.json` généré, `progress.json` créé avec statut PENDING.
  > AC: Given un fichier déjà scanné dont le hash n'a pas changé, When re-scan, Then le fichier est marqué CACHED.

- [x] Story 1.5: Intégration coverage et détection monorepo
  > Intégrer les données de coverage et détecter le monorepo.
  > AC: Given un projet avec `coverage-final.json`, When scan lancé avec coverage activée, Then les données de coverage sont incluses dans le `.task.json`.
  > AC: Given un monorepo, When scan lancé, Then Anatoly détecte les workspaces et scanne avec le bon tsconfig.

### Epic 2 : Estimation du scope d'audit
> Goal: Le développeur peut estimer le volume de travail (tokens, temps) avant de lancer un audit complet.

- [x] Story 2.1: Estimation de scope via tiktoken
  > Estimer le nombre de tokens et le temps nécessaire pour un audit complet.
  > AC: Given un projet scanné, When `npx anatoly estimate`, Then tiktoken calcule les tokens estimés, un temps estimé est affiché, aucun appel LLM.

### Epic 3 : Review agentique fichier par fichier
> Goal: Le développeur reçoit un audit intelligent de chaque fichier avec les 5 axes d'analyse, un score de confiance, le dual output et le transcript complet.

- [x] Story 3.1: Construction du prompt et appel Agent SDK
  > Envoyer chaque fichier à un agent Claude avec le bon prompt et les outils filesystem.
  > AC: Given un fichier avec son `.task.json`, When la review est lancée, Then prompt-builder.ts construit le system prompt, l'agent Claude est invoqué via @anthropic-ai/claude-agent-sdk.

- [x] Story 3.2: Validation Zod et retry automatique
  > Chaque réponse de l'agent validée par Zod avec retry automatique.
  > AC: Given la réponse brute de l'agent, When parsée, Then validée contre ReviewFileSchema. Si invalide, ZodError.format() renvoyé comme feedback, max 3 tentatives.

- [x] Story 3.3: Lock file et gestion de progress
  > Protéger contre les doubles instances et suivre la progression.
  > AC: Given aucune instance en cours, When `npx anatoly review`, Then lock file créé, progress.json lu, fichiers DONE/CACHED ignorés. Écriture atomique (tmp + rename).

- [x] Story 3.4: Dual output et transcripts
  > Recevoir deux fichiers par review (JSON + MD) et un transcript complet.
  > AC: Given une review terminée, When résultats sauvegardés, Then `.rev.json` et `.rev.md` écrits, transcript appendé en temps réel.

- [x] Story 3.5: Commande review et orchestration séquentielle
  > Lancer `npx anatoly review` pour auditer tous les fichiers séquentiellement.
  > AC: Given un projet scanné avec fichiers PENDING, When `npx anatoly review`, Then chaque fichier traité séquentiellement, statut PENDING → IN_PROGRESS → DONE.

### Epic 4 : Rapport agrégé et actionnable
> Goal: Le développeur consulte un rapport d'ensemble synthétisant tous les findings.

- [x] Story 4.1: Agrégation des reviews et génération du rapport
  > Agréger tous les `.rev.json` en un rapport Markdown structuré.
  > AC: Given des `.rev.json`, When `npx anatoly report`, Then `report.md` généré avec résumé exécutif, tableaux triés par sévérité, liste clean, fichiers en erreur.

- [x] Story 4.2: Format Markdown actionnable pour LLM
  > Rapport structuré pour être passé directement à un LLM.
  > AC: Given `report.md`, When consulté, Then headers structurés h1/h2/h3, tableaux Markdown, code blocks, liens relatifs vers `.rev.md`.

### Epic 5 : Pipeline complet et expérience CLI
> Goal: Le développeur lance `npx anatoly run` et obtient l'audit complet de bout en bout.

- [x] Story 5.1: Renderer terminal enrichi (zone fixe + zone flux)
  > Progression en temps réel avec affichage structuré.
  > AC: Given une review en cours en mode TTY, Then zone fixe avec spinner ora, barre de progression Unicode, compteurs de findings. Zone de flux avec fichiers terminés.

- [x] Story 5.2: Commande run et orchestration du pipeline
  > Lancer `npx anatoly run` pour l'audit complet de bout en bout.
  > AC: Given un projet TS valide, When `npx anatoly run`, Then pipeline scan → estimate → review → report, zéro confirmation, exit codes 0/1/2.

- [x] Story 5.3: Gestion SIGINT et flags CLI globaux
  > Interrompre proprement et personnaliser via flags.
  > AC: Given un audit en cours, When Ctrl+C, Then arrêt propre, résumé partiel, reviews intactes, lock relâché, cache reprise au re-run.

### Epic 6 : Commandes utilitaires
> Goal: Le développeur gère l'état de son audit : statut, nettoyage, reset.

- [x] Story 6.1: Commande status
  > Consulter l'état courant via `npx anatoly status`.
  > AC: Given un `progress.json` existant, When `npx anatoly status`, Then résumé par statut (PENDING, DONE, CACHED, ERROR, TIMEOUT), findings, chemin rapport.

- [x] Story 6.2: Commandes clean-logs et reset
  > Nettoyer les transcripts ou réinitialiser complètement.
  > AC: Given des transcripts, When `npx anatoly clean-logs`, Then tous les `.transcript.md` supprimés.
  > AC: Given un dossier `.anatoly/`, When `npx anatoly reset`, Then cache/reviews/logs/tasks vidés, report.md supprimé.

### Epic 7 : Mode watch (surveillance continue)
> Goal: Le développeur lance un mode daemon qui re-scanne et re-review automatiquement les fichiers modifiés.

- [x] Story 7.1: Mode watch avec re-scan incrémental
  > Lancer `npx anatoly watch` pour surveiller en continu.
  > AC: Given un projet TS valide, When `npx anatoly watch`, Then chokidar surveille, fichiers modifiés re-scannés et re-reviewés automatiquement.

### Epic 9 : Améliorations UX/DX post-v0.2.0
> Goal: Le développeur bénéficie d'une expérience CLI plus polie : confirmations sur les opérations destructives, messages d'erreur actionnables, respect des standards d'accessibilité terminal, et ouverture automatique du rapport.

- [x] Story 9.1: Confirmation prompts sur opérations destructives
  > `reset` et `clean-logs --keep 0` demandent confirmation avant de supprimer.
  > AC: Given des reviews/cache existants, When `npx anatoly reset`, Then résumé affiché + confirmation interactive (y/n).
  > AC: Given le flag `--yes`, When `npx anatoly reset --yes`, Then confirmation skipée (CI/scripts).
  > AC: Given un environnement non-TTY sans `--yes`, Then opération refusée avec message.

- [x] Story 9.2: Messages d'erreur avec recovery steps
  > Chaque erreur AnatolyError inclut un next step actionnable.
  > AC: Given LOCK_EXISTS, Then message inclut PID + suggestion `anatoly reset`.
  > AC: Given ZOD_VALIDATION_FAILED, Then résumé lisible + suggestion `--verbose`.
  > AC: Given CONFIG_INVALID, Then chemin fichier + clé problématique + exemple valide.
  > AC: Given toute AnatolyError, Then format `error: <message>\n  → <recovery step>`.

- [x] Story 9.3: Support NO_COLOR et flag --open
  > Respecter `NO_COLOR` env var (no-color.org) + ajouter `--open` pour ouvrir le rapport.
  > AC: Given `NO_COLOR` définie, When Anatoly s'initialise, Then chalk désactivé automatiquement.
  > AC: Given `npx anatoly run --open`, When rapport généré, Then ouvert via `xdg-open`/`open`/`start`.

- [x] Story 9.4: Enrichissement du status et verbose mode
  > `status` avec barre de progression visuelle, `--verbose` avec tokens/fichier et cache hits.
  > AC: Given audit partiel, When `npx anatoly status`, Then barre visuelle + pourcentage + compteurs findings.
  > AC: Given `--verbose`, When review, Then tokens input/output par fichier, cache hit/miss, temps par fichier.

### Epic 10 : Parallélisation des reviews
> Goal: Le développeur peut lancer un audit parallèle (`--concurrency N`) qui divise le temps d'exécution par un facteur proche de N, tout en respectant les rate limits API, en maintenant l'intégrité du `progress.json`, et en offrant un affichage temps réel multi-fichier.

- [x] Story 10.1: Pool de workers et sémaphore de concurrence
  > Lancer `npx anatoly run --concurrency 3` pour auditer jusqu'à 3 fichiers en parallèle.
  > AC: Given un projet avec 60 fichiers PENDING, When `npx anatoly run --concurrency 3`, Then jusqu'à 3 fichiers reviewés simultanément via un pool de workers, slot libéré = fichier suivant démarre, défaut reste séquentiel (`--concurrency 1`).
  > AC: Given `--concurrency` invalide (0, -1, >10), Then erreur `error: --concurrency must be between 1 and 10`.
  > AC: Given `.anatoly.yml` avec `llm.concurrency`, Then valeur utilisée comme défaut (CLI prend la priorité).

- [x] Story 10.2: ProgressManager thread-safe
  > `ProgressManager` supporte les mises à jour concurrentes sans corruption.
  > AC: Given 3 reviews simultanées, When chacune appelle `pm.updateFileStatus()`, Then écritures sérialisées (file d'attente interne), aucune perte, `atomicWriteJson()` toujours utilisé.
  > AC: Given un crash pendant écriture concurrente, When relance, Then fichiers IN_PROGRESS détectés comme PENDING (crash recovery inchangé).

- [x] Story 10.3: Rate limiting et backoff exponentiel
  > Anatoly respecte les rate limits API Anthropic automatiquement.
  > AC: Given concurrency 3, When API retourne 429, Then backoff exponentiel (base 5s, max 120s, jitter +-20%), autres workers continuent, message `rate limited — retrying in Xs`.
  > AC: Given 5 erreurs 429 consécutives, Then fichier marqué ERROR `Rate limit exceeded after 5 retries`, pipeline continue.

- [x] Story 10.4: Renderer multi-fichier
  > Voir la progression de chaque review en cours simultanément.
  > AC: Given `--concurrency 3`, When 3 reviews en cours, Then zone fixe affiche `[1] reviewing...`, `[2] reviewing...`, `[3] reviewing...` + barre + compteurs.
  > AC: Given mode `--plain`, Then affichage linéaire séquentiel (fichier terminé = une ligne, ordre de complétion).
  > AC: Given un worker qui termine, Then résultat dans zone flux par ordre de complétion, slot mis à jour.

- [x] Story 10.5: Gestion SIGINT avec reviews en vol
  > Interrompre proprement un audit parallèle avec Ctrl+C.
  > AC: Given 3 reviews en vol, When Ctrl+C, Then tous AbortControllers abortés, reviews sauvegardées intactes, fichiers en cours marqués IN_PROGRESS, résumé `interrupted — 18/60 files reviewed | 5 findings (3 in-flight aborted)`.
  > AC: Given second Ctrl+C, Then force exit + lock relâché.
  > AC: Given review qui termine juste après SIGINT, Then review sauvegardée normalement.

### Epic 11 : Boucle d'autocorrection Claude Code
> Goal: Le développeur bénéficie d'un feedback automatique d'Anatoly intégré à Claude Code : chaque modification de fichier déclenche une review complète en background, et quand Claude Code finit sa tâche, les findings sont injectés pour autocorrection avant de rendre la main.

- [x] Story 11.1: Commande `anatoly hook` avec sous-commandes
  > Commande cachée exposant les handlers pour les hooks Claude Code (`hook post-edit` et `hook stop`).
  > AC: Given un hook PostToolUse, When `npx anatoly hook post-edit`, Then lit stdin JSON, extrait file_path, lance `anatoly review --file <path> --no-cache` en child process détaché, enregistre PID dans `hook-state.json`, exit 0 immédiatement.
  > AC: Given un hook Stop, When `npx anatoly hook stop`, Then lit hook-state.json, attend les reviews background (timeout 120s), lit les .rev.json, filtre par min_confidence, retourne additionalContext si findings, exit 0 si CLEAN.
  > AC: Given un fichier non-TS, When hook post-edit, Then exit 0 silencieux.

- [x] Story 11.2: Debounce et gestion d'état des reviews background
  > Les reviews background sont dédupliquées et tracées dans hook-state.json.
  > AC: Given un fichier modifié 3 fois en 10s, When hook post-edit se déclenche, Then première review lancée, modifications suivantes kill + relancent, seule la dernière review produit un .rev.json.
  > AC: Given hook-state.json, When lu/écrit, Then contient session_id, reviews map (pid, status, rev_path), stop_count. Écritures atomiques.
  > AC: Given un crash du child process, When hook stop lit le state, Then reviews running avec PID inactif marquées error.

- [x] Story 11.3: Hook Stop — gate de qualité et injection de feedback
  > Le hook Stop vérifie les reviews et injecte le feedback dans Claude Code.
  > AC: Given reviews terminées avec findings, When hook stop, Then retourne additionalContext avec résumé formaté par fichier (symbol, line, axis, value, confidence, detail).
  > AC: Given toutes reviews CLEAN, When hook stop, Then exit 0 silencieux.
  > AC: Given reviews encore en cours, When hook stop, Then attend avec timeout 120s, reviews non terminées ignorées avec warning.
  > AC: Given stop_count >= max_stop_iterations (défaut 3), When hook stop se re-déclenche, Then exit 0 silencieux + stderr message.

- [x] Story 11.4: Configuration min_confidence dans le schéma
  > Seuil de confiance minimum pour les findings remontés par les hooks.
  > AC: Given `.anatoly.yml` avec `llm.min_confidence: 80`, When reviews filtrées, Then seuls les findings avec confidence >= 80 sont inclus dans le feedback hook.
  > AC: Given pas de `llm.min_confidence`, When config chargée, Then défaut 70.
  > AC: Given LlmConfigSchema, When champ ajouté, Then `min_confidence: z.int().min(0).max(100).default(70)`.

- [x] Story 11.5: Template de configuration Claude Code
  > Template `.claude/settings.json` prêt à l'emploi pour activer la boucle d'autocorrection.
  > AC: Given template, When consulté, Then contient PostToolUse (async, matcher Edit|Write, `npx anatoly hook post-edit`) + Stop (sync, `npx anatoly hook stop`, timeout 180s).
  > AC: Given documentation, When consultée, Then section "Claude Code Integration" explique activation, hooks, min_confidence, désactivation.

- [x] Story 11.6: Protection contre les boucles et conflits
  > Le système de hooks gère les boucles, conflits avec `anatoly run`, et timeouts.
  > AC: Given stop_count atteint max_stop_iterations (3), When hook stop, Then exit 0 silencieux, findings loggés sur stderr.
  > AC: Given `anatoly run` en cours (lock actif), When hook post-edit, Then exit 0 silencieux.
  > AC: Given hook-state.json orphelin (session précédente), When nouveau hook, Then state réinitialisé.
  > AC: Given hash SHA-256 inchangé, When hook post-edit, Then review non relancée (cache existant).

### Epic 12 : Parallélisation de l'indexation RAG
> Goal: Le développeur bénéficie d'une phase d'indexation RAG (Phase 3) parallélisée, divisant le temps de pré-indexation Haiku par un facteur proche de N en réutilisant l'infrastructure de concurrence de l'Epic 10.

- [x] Story 12.1: Refactoring de l'orchestrateur pour accumulation découplée
  > Séparer le travail par fichier (Haiku + embed) de l'écriture en base (upsert + cache).
  > AC: Given `indexProject()`, When refactorée, Then `processFileForIndex()` retourne cards+embeddings sans toucher VectorStore/cache. `IndexedFileResult` = `{ task, cards, embeddings }`.
  > AC: Given `indexCards()`, When refactorée, Then `needsReindex(cache, cards, fileHash)` extrait en fonction pure. Upsert accepte embeddings pré-calculés.
  > AC: Given `embed()`, When pool démarre, Then modèle pré-chargé via `await embed('')` avant workers.
  > AC: Given tests existants, When refactoring terminé, Then tous les tests passent sans modification.

- [x] Story 12.2: Pool de workers pour l'indexation Haiku
  > Distribuer les appels Haiku sur un pool de workers concurrent.
  > AC: Given 60 fichiers, When `npx anatoly run` (concurrency 4), Then 4 appels Haiku simultanés via `runWorkerPool`, résultats accumulés, batch upsert séquentiel post-pool, cache mis à jour en une seule écriture atomique.
  > AC: Given concurrence index, When pas configurée séparément, Then réutilise `config.llm.concurrency` (défaut 4).
  > AC: Given worker échoue, Then erreur swallowed, worker passe au suivant (comportement inchangé).
  > AC: Given `--concurrency 1`, Then comportement identique à la version séquentielle.

- [x] Story 12.3: Rate limiting Haiku avec backoff
  > Les appels Haiku concurrents respectent les rate limits API.
  > AC: Given concurrency 4, When 429, Then `retryWithBackoff` (base 2s, max 30s, jitter ±20%), autres workers continuent, message affiché.
  > AC: Given 5 erreurs 429 consécutives, Then fichier skippé silencieusement, pipeline continue.

- [x] Story 12.4: Affichage de la progression d'indexation
  > Progression de la phase d'index avec compteurs en temps réel.
  > AC: Given indexation concurrency 4, Then affichage `[N/total] file` pour chaque fichier traité.
  > AC: Given indexation terminée, Then stats identiques : `cards indexed N new / M total`, `files N new / M total`.
  > AC: Given mode `--plain`, Then un log par fichier complété, ordre de complétion.

- [x] Story 12.5: Gestion SIGINT pendant l'indexation parallèle
  > Interrompre proprement l'indexation parallèle, persister les cards déjà calculées.
  > AC: Given 4 workers en vol, When Ctrl+C, Then `isInterrupted()` = true, pool arrête dispatch, workers finissent fichier courant, résultats accumulés batch-upsertés, cache mis à jour.
  > AC: Given indexation interrompue à 30/60, When relance, Then cache détecte les 30 indexés, seuls 30 restants traités.
  > AC: Given second Ctrl+C pendant flush, Then force exit immédiat.

### Epic 27 : RAG Dual-Vector for Documentation — Matching sémantique docs ↔ code
> Goal: Replace fragile convention-based docs-resolver with semantic NLP matching. Function summaries (Haiku) + doc sections embedded with nomic-text/MiniLM. Documentation axis gets the right doc pages by concept similarity.

- [x] Story 27.1: Haiku summary generation in RAG indexer
  > Generate 1-sentence semantic summary per function card via Haiku batch calls, cached by content hash.
  > AC: Given 300 functions, When RAG index runs, Then all have non-empty summary. And re-run with no changes generates 0 new summaries. And modifying one function regenerates only that summary.

- [ ] Story 27.2: Doc section extraction and indexing
  > Parse /docs/ into H2 sections, embed prose-only text via NLP model, store as type='doc_section' cards in LanceDB.
  > AC: Given /docs/ with 20 files ~80 H2 sections, When RAG index runs, Then ~80 doc section cards indexed with NLP vectors. And duplication axis still returns only function cards.

- [ ] Story 27.3: Advanced mode — nomic-embed-text in sidecar
  > Sequential GPU model swap: nomic-code for code, then nomic-text for summaries+docs. Update setup-embeddings to download both models.
  > AC: Given advanced mode with GPU, When RAG index runs, Then code vectors = nomic-code (3584d), NLP vectors = nomic-text (768d). And sidecar swaps without OOM. And setup-embeddings downloads both models.

- [ ] Story 27.4: Documentation axis — semantic doc matching
  > Replace docs-resolver with RAG NLP search. Match function summaries against doc sections. MAX_SECTIONS=5, MAX_LINES_PER_SECTION=100, MAX_DOC_TOKENS=4000.
  > AC: Given src/core/reporter.ts evaluated, When documentation axis runs, Then NLP search matches 05-Reporter.md (not Scanner/Estimator/Triage). And docs_coverage.matched_doc_pages contains 05-Reporter.md.

- [ ] Story 27.5: Deliberation memory for documentation reclassifications
  > Persist doc reclassifications in deliberation-memory.json. Inject into documentation axis prompt to avoid re-flagging.
  > AC: Given symbol reclassified UNDOCUMENTED→DOCUMENTED by deliberation, When next run evaluates same file, Then symbol is not re-flagged.

- [ ] Story 27.6: rag-status shows doc sections and NLP stats
  > Show doc section count, NLP model info, and summary coverage in rag-status output.
  > AC: Given fully indexed project, When rag-status runs, Then shows function cards AND doc section stats. And --docs lists all indexed doc sections.

- [ ] Story 27.7: Adversarial Code Review — Validation complète de l'Epic 27
  > Review adversariale BMAD : vérifier file lists, tâches [x], ACs, non-régressions, intégration RAG dual-vector. Min 3 issues, fix HIGH/MEDIUM.
  > AC: Given stories 27.1-27.6 complètes, When chaque claim vérifié contre git + code, Then aucune tâche [x] non implémentée, aucun AC manquant.
  > AC: Given npm run typecheck && build && test, Then tout passe.
  > AC: Given run --axes documentation, Then summaries non vides, doc sections indexées, matching sémantique correct.
  > AC: Given run --axes duplication, Then aucune doc section dans les candidats — non-régression.

## Completed

- [x] Story 1.1: Initialisation du projet et structure CLI (2026-02-23)
  - package.json with type:module, bin, engines >=20.19
  - All production & dev deps installed (commander, zod v4, chalk, ora, etc.)
  - tsconfig.json (NodeNext, ES2022, strict)
  - tsup.config.ts (ESM, node20, shebang, external deps)
  - vitest.config.ts (globals, co-located tests)
  - eslint.config.js (typescript-eslint, no-default-export in core, no-console in core)
  - Folder structure: src/commands/, src/core/, src/schemas/, src/utils/ with barrel exports
  - CLI entry with Commander: 9 stub commands + 6 global options
  - 4 passing tests, lint clean, typecheck clean, build succeeds
  - Key learning: @commander-js/extra-typings is CJS-only, use `commander` for runtime imports

- [x] Story 1.2: Schémas Zod et gestion d'erreurs (2026-02-23)
  - ReviewFileSchema: 5 axes (correction, overengineering, utility, duplication, tests) + confidence 0-100
  - TaskSchema: file, hash, symbols (AST), optional coverage data
  - ConfigSchema: project, scan, coverage, llm sections with full defaults
  - ProgressSchema: file statuses (PENDING/IN_PROGRESS/DONE/TIMEOUT/ERROR/CACHED)
  - AnatolyError class: 9 error codes, recoverable flag
  - 21 passing tests (17 new), lint clean, typecheck clean
  - Key learning: Zod v4 `.default({})` on objects requires full default values, not empty object

- [x] Story 1.3: Chargement de configuration (2026-02-23)
  - `src/utils/config-loader.ts`: loadConfig(projectRoot, configPath?) → Config
  - YAML parsing via js-yaml, validation via ConfigSchema
  - Falls back to defaults when no file exists or file is empty
  - Throws AnatolyError CONFIG_INVALID for malformed YAML or invalid values
  - 28 passing tests (7 new), lint clean, typecheck clean

- [x] Story 1.4: Scanner AST et hash SHA-256 (2026-02-23)
  - `src/utils/cache.ts`: computeFileHash, computeHash (SHA-256), toOutputName, atomicWriteJson, readProgress
  - `src/core/scanner.ts`: parseFile (web-tree-sitter WASM), collectFiles (glob), scanProject (full pipeline)
  - Symbol extraction: function, class, type, interface, enum, hook (useXxx), constant (UPPER_SNAKE_CASE), arrow functions
  - Generates `.task.json` per file + `progress.json` with PENDING/CACHED statuses
  - Cache invalidation via SHA-256 hash comparison — unchanged files marked CACHED
  - `src/commands/scan.ts` wired up with real scanner logic
  - 47 passing tests (19 new), lint clean, typecheck clean, build succeeds
  - Smoke test: `node dist/index.js scan` successfully scanned 23 files on Anatoly's own codebase
  - Key learnings: web-tree-sitter uses named exports `{ Parser, Language }`; `require.resolve()` unavailable in ESM — use `createRequire(import.meta.url)`

- [x] Story 1.5: Intégration coverage et détection monorepo (2026-02-23)
  - `loadCoverage()` in `src/core/scanner.ts`: parses Istanbul `coverage-final.json` format
  - Extracts per-file metrics: statements, branches, functions, lines (total + covered)
  - Normalizes absolute paths to relative, graceful null for missing/disabled/invalid coverage
  - Coverage injected into `.task.json` during `scanProject()` when available
  - `src/utils/monorepo.ts`: `detectMonorepo(projectRoot)` → `MonorepoInfo`
  - Detects pnpm-workspace.yaml, package.json workspaces (array + object format), nx.json, turbo.json
  - Priority: pnpm > yarn/npm > nx > turbo
  - 62 passing tests (15 new), lint clean, typecheck clean

- [x] Story 2.1: Estimation de scope via tiktoken (2026-02-23)
  - `src/core/estimator.ts`: loadTasks, countTokens (tiktoken cl100k_base), estimateProject, formatTokenCount
  - Reads all `.task.json` files, counts tokens from actual source files via tiktoken
  - Estimates input tokens (system prompt + file content + overhead) and output tokens (per-symbol review)
  - Time estimate based on ~45s per file sequential processing
  - `src/commands/estimate.ts` wired up: auto-scans if no tasks, displays aligned output
  - Smoke test: `npx anatoly estimate` → 24 files, 81 symbols, ~23K input / ~19K output, ~18 min
  - 72 passing tests (10 new), lint clean, typecheck clean

- [x] Story 3.1: Construction du prompt et appel Agent SDK (2026-02-23)
  - `src/utils/prompt-builder.ts`: buildSystemPrompt(task) → structured system prompt with 5 axes, investigation rules, few-shot examples, JSON output schema
  - `src/core/reviewer.ts`: reviewFile(projectRoot, task, config) → invokes Claude Agent SDK via query()
  - Agent gets Read/Grep/Glob tools with bypassPermissions for autonomous investigation
  - Streaming transcript appended to `.anatoly/logs/{file}.transcript.md` in real-time
  - Timeout via AbortController (default 180s from config)
  - parseReviewResponse(): extracts JSON from markdown fences or surrounding text, validates against ReviewFileSchema
  - Error handling: AnatolyError for timeouts (LLM_TIMEOUT), API errors (LLM_API_ERROR), validation failures (ZOD_VALIDATION_FAILED)
  - 86 passing tests (14 new), lint clean, typecheck clean

- [x] Story 3.2: Validation Zod et retry automatique (2026-02-23)
  - Refactored `reviewFile()` with retry loop: validates response → sends Zod error feedback → agent retries, up to `config.llm.max_retries` (default 3)
  - `tryParseReview()`: non-throwing validation that returns `{ success, data/error }`
  - `formatRetryFeedback()`: formats Zod issues into a structured retry prompt for the agent
  - Retry uses Agent SDK `resume` option to continue the conversation with error context
  - `ReviewResult` now includes `retries` count for tracking
  - 93 passing tests (7 new for retry logic), lint clean, typecheck clean

- [x] Story 3.3: Lock file et gestion de progress (2026-02-23)
  - `src/utils/lock.ts`: acquireLock/releaseLock with PID-based stale lock detection
  - Throws LOCK_EXISTS if another running Anatoly instance holds the lock
  - Auto-cleans stale locks (process no longer running) and corrupted lock files
  - `src/core/progress-manager.ts`: ProgressManager class for review progress tracking
  - getPendingFiles() returns PENDING + ERROR files (skips DONE/CACHED/IN_PROGRESS/TIMEOUT)
  - updateFileStatus() writes atomically (tmp + rename) via atomicWriteJson
  - getSummary() returns counts by status, hasWork()/totalFiles() convenience methods
  - 104 passing tests (11 new), lint clean, typecheck clean

- [x] Story 3.4: Dual output et transcripts (2026-02-23)
  - `src/core/review-writer.ts`: writeReviewOutput() → writes both `.rev.json` and `.rev.md`
  - JSON output via atomicWriteJson (crash-safe tmp + rename)
  - `renderReviewMarkdown()`: structured Markdown with verdict, symbols table, per-symbol details, actions, file-level notes
  - Duplicate targets rendered with file:symbol reference and similarity
  - Transcript already handled in reviewer.ts (real-time appendFileSync to `.anatoly/logs/`)
  - 113 passing tests (9 new), lint clean, typecheck clean

- [x] Story 3.5: Commande review et orchestration séquentielle (2026-02-23)
  - `src/commands/review.ts`: full review orchestration pipeline
  - acquireLock → auto-scan if no tasks → ProgressManager.getPendingFiles() → sequential reviewFile() loop
  - Each file: PENDING → IN_PROGRESS → reviewFile() → writeReviewOutput() → DONE (or ERROR/TIMEOUT)
  - Error handling: LLM_TIMEOUT → TIMEOUT status, other errors → ERROR status with message
  - Summary output: reviewed count, errors count, done/cached counts from ProgressManager
  - Lock released in finally block for crash safety
  - 113 passing tests (no new tests — command orchestration tested via integration), lint clean, typecheck clean, build succeeds (40.19 KB)

- [x] Story 4.1 + 4.2: Report aggregation and LLM-friendly Markdown format (2026-02-23)
  - `src/core/reporter.ts`: loadReviews, computeGlobalVerdict, aggregateReviews, renderReport, generateReport
  - Loads all `.rev.json` from `.anatoly/reviews/`, validates with ReviewFileSchema, skips malformed
  - Severity classification: correction errors + high-confidence dead/dup → high; mid-confidence → medium; low-value/weak tests → low
  - Global verdict: all CLEAN → CLEAN, any CRITICAL → CRITICAL, else → NEEDS_REFACTOR
  - Markdown output with h1/h2/h3 headers, tables, code blocks, relative links to `.rev.md` files
  - Sections: Executive Summary (with severity breakdown table), Findings (sorted CRITICAL→REFACTOR, by confidence), Recommended Actions, Clean Files, Files in Error, Metadata
  - `src/commands/report.ts`: wired with chalk-colored terminal output, reads progress.json for error/timeout files
  - 131 passing tests (18 new), lint clean, typecheck clean, build succeeds (49.70 KB)

- [x] Story 5.1: Renderer terminal enrichi (zone fixe + zone flux) (2026-02-23)
  - `src/utils/renderer.ts`: createRenderer() factory with Renderer interface
  - Interactive mode (TTY): fixed zone with ora spinner + Unicode progress bar (█/░) + live counters via log-update
  - Plain mode (pipe/CI): linear sequential output, no ANSI escape codes
  - Auto-detects TTY via `process.stdout.isTTY`, honors `--plain` flag
  - buildProgressBar(): configurable width Unicode bar
  - formatCounterRow(): dead/dup/over/err with color coding
  - formatResultLine(): ✓ filename VERDICT with color-coded verdicts
  - truncatePath(): ellipsis for long paths
  - showCompletion(): final summary with aligned paths
  - 142 passing tests (11 new), lint clean, typecheck clean, build succeeds (49.70 KB)

- [x] Story 5.2: Commande run et orchestration du pipeline (2026-02-23)
  - `src/commands/run.ts`: full 4-phase pipeline: scan → estimate → review → report
  - Phase 1 (scan): scanProject() → displays file count
  - Phase 2 (estimate): estimateProject() → displays tokens/time (no confirmation)
  - Phase 3 (review): sequential loop with renderer (updateProgress, addResult, incrementCounter)
  - Phase 4 (report): generateReport() → renderer.showCompletion() with aligned paths
  - Exit codes: 0 = CLEAN, 1 = findings detected, 2 = technical error
  - Lock file acquired for review phase, released in finally
  - Error handling: per-file (TIMEOUT/ERROR) and global (exit code 2)
  - 142 passing tests (no new tests — pipeline tested via integration), typecheck clean, build succeeds (59.13 KB)

- [x] Story 5.3: Gestion SIGINT et flags CLI globaux (2026-02-23)
  - SIGINT handler in both `run.ts` and `review.ts`: sets `interrupted` flag, breaks review loop gracefully
  - Partial summary on interrupt: `interrupted — 47/142 files reviewed | 8 findings`
  - Lock file released in finally block, reviews intact, progress preserved for resume
  - `--file <glob>`: filters pending files via custom `matchGlob()` (supports *, **, ?, {a,b})
  - `--no-cache`: resets CACHED files to PENDING in progress.json for full re-review
  - `--plain`: already wired (auto-detect via `process.stdout.isTTY`)
  - `--no-color`: handled by chalk auto-detection (`$NO_COLOR` env or `--no-color` flag)
  - SIGINT listener properly cleaned up via `process.removeListener` in finally
  - 148 passing tests (6 new for matchGlob), typecheck clean, build succeeds (61.63 KB)

- [x] Story 6.1: Commande status (2026-02-23)
  - `src/commands/status.ts`: reads progress.json, displays summary by status (PENDING/DONE/CACHED/ERROR/TIMEOUT)
  - Loads reviews from .rev.json to compute findings breakdown (dead/dup/over/errors) and global verdict
  - Shows report path if report.md exists
  - Graceful "no audit" message when no progress.json found

- [x] Story 6.2: Commandes clean-logs et reset (2026-02-23)
  - `src/commands/clean-logs.ts`: deletes all `.transcript.md` files from `.anatoly/logs/`, preserves other files
  - `src/commands/reset.ts`: removes tasks/, reviews/, logs/, cache/ dirs + progress.json + report.md + lock file
  - Both show count of cleaned items
  - 153 passing tests (5 new), typecheck clean, build succeeds (66.01 KB)

- [x] Story 7.1: Mode watch avec re-scan incrémental (2026-02-23)
  - `src/commands/watch.ts`: chokidar v5 watcher with incremental re-scan and auto-review
  - Watches config.scan.include patterns, ignores config.scan.exclude
  - On file change/add: re-hash → re-parse AST → write .task.json → update progress → auto-review
  - Queue-based processing: deduplicates rapid changes, processes sequentially
  - awaitWriteFinish (200ms stability threshold) prevents partial-write triggers
  - Progress atomically updated through PENDING → IN_PROGRESS → DONE (or ERROR)
  - Graceful shutdown on SIGINT with watcher.close()
  - 153 passing tests (no new tests — daemon tested via integration), typecheck clean, build succeeds (70.18 KB)

- [x] Story 9.1: Confirmation prompts sur opérations destructives (2026-02-24)
  - `src/utils/confirm.ts`: `confirm(message)` async readline prompt + `isInteractive()` TTY check
  - `src/commands/reset.ts`: shows summary of items to delete, `--yes` flag skips confirmation, non-TTY without `--yes` refused
  - `src/commands/clean-logs.ts`: confirms when deleting all runs (--keep 0 or no --keep), `--yes` flag
  - 206 passing tests (6 new: confirm utilities + errors), typecheck clean, build succeeds

- [x] Story 9.2: Messages d'erreur avec recovery steps (2026-02-24)
  - `AnatolyError` now has `hint` field with default hints per error code + `formatForDisplay()` method
  - DEFAULT_HINTS map: context-specific recovery steps for all 9 error codes
  - Custom hints on LOCK_EXISTS (PID + reset command), CONFIG_INVALID (YAML syntax, key path)
  - Error display format: `error: <message>\n  → <recovery step>` in run.ts, review.ts, watch.ts
  - Backward compatible: 4th constructor arg optional, falls back to default hints

- [x] Story 9.3: Support NO_COLOR et flag --open (2026-02-24)
  - chalk v5 already respects `NO_COLOR` env var automatically (built-in)
  - `src/utils/open.ts`: `openFile(path)` using xdg-open/open/start per platform
  - `--open` global flag added to CLI, wired in `run.ts` and `report.ts`
  - Report auto-opened after generation when `--open` is set

- [x] Story 9.4: Enrichissement du status et verbose mode (2026-02-24)
  - `src/commands/status.ts`: visual progress bar (30 chars, Unicode █/░) + percentage + completed/total
  - Colored error/timeout counts, latest run info, run-scoped review paths
  - `--verbose` in `run.ts`: scan shows new/cached counts; review shows time, cost, retries per file
  - 206 passing tests, typecheck clean, build succeeds (112.75 KB)

- [x] Story 10.3: Rate limiting et backoff exponentiel (2026-02-24)
  - `src/utils/rate-limiter.ts`: `retryWithBackoff()` with exponential backoff + jitter (+-20%)
  - `isRateLimitError()` detects 429/rate_limit in error messages from Agent SDK
  - `calculateBackoff()`: base 5s, max 120s, exponential (5s → 10s → 20s → 40s → 80s)
  - Wraps `reviewFile()` in `run.ts` — other workers continue normally during backoff
  - After 5 consecutive 429s: file marked ERROR with hint "reduce --concurrency or try again later"
  - `rate limited — retrying X in Ys (attempt N/5)` message on each retry
  - 14 tests for rate limiter (isRateLimitError, calculateBackoff, retryWithBackoff)
  - 239 passing tests, typecheck clean, build succeeds (117.92 KB)

- [x] Story 10.4: Renderer multi-fichier (2026-02-24)
  - `src/utils/renderer.ts`: added `updateWorkerSlot(workerIndex, filePath)` and `clearWorkerSlot(workerIndex)` to Renderer interface
  - Interactive mode: displays `[1] reviewing src/...`, `[2] reviewing src/...` in fixed zone
  - Worker slots stored in Map<number, string>, sorted by index for stable display
  - Falls back to single-file `⠋ reviewing ...` when no worker slots are set
  - Plain mode: no-op methods (linear sequential output unchanged)
  - Wired in run.ts: slot set at handler start, cleared in finally block
  - 239 passing tests (+1 new), typecheck clean, build succeeds (118.55 KB)

- [x] Story 10.5: Gestion SIGINT avec reviews en vol (2026-02-24)
  - Already covered by Stories 10.1/10.2 implementation:
  - SIGINT handler iterates `activeAborts` Set and aborts all in-flight reviews simultaneously
  - Pool stops dispatching new items via `isInterrupted()` check
  - Second Ctrl+C → `process.exit(1)` with lock released
  - In-flight count shown in interrupt summary: `(N in-flight aborted)`
  - Reviews completing just after SIGINT saved normally (writeReviewOutput runs before cleanup)
  - Files that were IN_PROGRESS when aborted stay IN_PROGRESS (detected as PENDING on restart)
  - No additional code changes needed

- [x] Story 10.1 + 10.2: Worker pool + thread-safe ProgressManager (2026-02-24)
  - `src/core/worker-pool.ts`: `runWorkerPool()` — concurrency-limited pool with interrupt support
  - Items processed via N parallel workers, slot freed = next item starts immediately
  - `src/schemas/config.ts`: added `llm.concurrency` (z.int().min(1).max(10).default(1))
  - `src/cli.ts`: added `--concurrency <n>` global flag (CLI > config > default 1)
  - Validation: `error: --concurrency must be between 1 and 10` for invalid values
  - `src/core/progress-manager.ts`: added serialized write queue (`writeQueue: Promise<void>`)
  - In-memory updates are synchronous (single-threaded JS), disk writes are serialized via promise chain
  - Added `flush()` method to await all queued writes (called before report phase)
  - Crash recovery unchanged: IN_PROGRESS files detected as PENDING on restart
  - `src/commands/run.ts`: refactored review loop to use `runWorkerPool()`
  - Pre-loads all tasks into Map for O(1) lookup (no repeated `loadTasks()` per file)
  - Tracks all active AbortControllers in a Set for SIGINT mass-abort
  - Estimate time display adapts: `~X min (×N)` for concurrency > 1
  - Interrupt summary includes in-flight count: `(N in-flight aborted)`
  - `src/core/worker-pool.test.ts`: 8 tests covering concurrency limits, interruption, error handling, slot reuse
  - 224 passing tests (8 new), typecheck clean, build succeeds (115.41 KB)

- [x] Story 11.1: Commande `anatoly hook` avec sous-commandes (2026-02-24)
  - `src/commands/hook.ts`: `registerHookCommand()` with `post-edit` and `stop` subcommands
  - `hook post-edit`: reads stdin JSON, extracts file_path, skips non-TS/deleted/unchanged/locked files, spawns detached `anatoly review --file <path> --no-cache`, registers PID in hook-state.json, exits 0 immediately
  - `hook stop`: loads hook-state.json, increments stop_count (anti-loop, max 3), waits for running reviews (timeout 120s), reads .rev.json, filters by min_confidence, outputs `additionalContext` JSON if findings, exits 0 if clean
  - `src/utils/hook-state.ts`: `HookState`/`HookReview` types, `loadHookState()` (orphan PID detection), `saveHookState()` (atomic), `initHookState()`, `isProcessRunning()`
  - `src/utils/lock.ts`: added `isLockActive()` — read-only lock check for hook coordination (excludes own PID)
  - Debounce: kill previous running review for same file before spawning new one
  - SHA-256 cache check: skip review if file hash unchanged from existing task
  - `ANATOLY_HOOK_MODE=1` env var set on child process for future detection
  - 268 passing tests (16 new: 12 hook-state, 3 hook command, 4 lock isLockActive), typecheck clean, build succeeds (129.65 KB)

- [x] Stories 11.2 + 11.3 + 11.6: Debounce, Stop gate, Loop protection (2026-02-24)
  - All ACs already covered by Story 11.1 implementation:
  - 11.2: Debounce (kill+relaunch in hook.ts:111-119), hook-state.json structure (session_id, reviews, stop_count), atomic writes, orphan PID detection
  - 11.3: additionalContext output (hook.ts:239-267), timeout 120s wait (hook.ts:170-197), stop_count anti-loop (hook.ts:159-168)
  - 11.6: Lock coordination via isLockActive() (hook.ts:83-86), orphan state reset (hook-state.ts:62-66), SHA-256 hash check (hook.ts:88-106)

- [x] Story 11.4: Configuration min_confidence dans le schéma (2026-02-24)
  - `src/schemas/config.ts`: added `min_confidence: z.int().min(0).max(100).default(70)` to LlmConfigSchema
  - `src/commands/hook.ts`: replaced unsafe cast with typed `config.llm.min_confidence`
  - Default: 70 (configurable via `.anatoly.yml` → `llm.min_confidence`)
  - 4 new tests: default value, custom value, reject < 0, reject > 100
  - 272 passing tests, typecheck clean

- [x] Story 11.5: Template de configuration Claude Code (2026-02-24)
  - `src/commands/hook.ts`: added `hook init` subcommand
  - Generates `.claude/settings.json` with PostToolUse (async, matcher Edit|Write) + Stop (sync, timeout 180s)
  - Merges into existing settings.json if present (without overwriting existing hooks)
  - Prints usage instructions: how it works, min_confidence config, how to disable
  - 274 passing tests, typecheck clean, build succeeds (132.30 KB)

- [x] Story 12.1: Refactoring de l'orchestrateur pour accumulation découplée (2026-02-24)
  - `src/rag/indexer.ts`: exported `RagCache` type, extracted `needsReindex()` as pure function, added `embedCards()`, `loadRagCache()`, `saveRagCache()`
  - `indexCards()` now accepts optional `preComputedEmbeddings` parameter (backward compatible)
  - `src/rag/orchestrator.ts`: added `processFileForIndex()` returning `IndexedFileResult = { task, cards, embeddings }` without touching VectorStore/cache
  - `indexProject()` refactored: pre-warms embedding model (`await embed('')`), pre-loads cache, accumulates `IndexedFileResult[]`, batch upserts sequentially, single atomic cache write
  - `src/rag/index.ts`: exports new functions and types
  - 3 new tests for `needsReindex()` (not in cache, hash changed, hash matches)
  - All 277 tests pass (including all existing tests unchanged), typecheck clean, build succeeds (132.88 KB)

- [x] Stories 12.2 + 12.3 + 12.4 + 12.5: Worker pool + rate limiting + progress + SIGINT (2026-02-24)
  - All ACs covered by Story 12.1 refactoring — `indexProject()` already uses full parallel architecture:
  - 12.2: `runWorkerPool()` with `concurrency` param (orchestrator.ts:104-131), results accumulated in `IndexedFileResult[]`, batch upsert sequential post-pool (orchestrator.ts:137-146), single atomic `saveRagCache()` (orchestrator.ts:149-151), reuses `config.llm.concurrency` via passthrough from run.ts
  - 12.3: `retryWithBackoff()` wraps `processFileForIndex()` (orchestrator.ts:112-126) with Haiku-tuned params (base 2s, max 30s, jitter ±20%), `isInterrupted` propagated for SIGINT-aware retries, errors swallowed (worker continues)
  - 12.4: Progress logging via `onLog(\`[\${idx}/\${total}] \${file}\`)` (orchestrator.ts:110), stats output unchanged in run.ts
  - 12.5: `isInterrupted` passed to `runWorkerPool` (orchestrator.ts:107), pool stops dispatching, in-flight workers finish, accumulated results batch-upserted post-pool, cache written atomically
  - `src/rag/card-generator.ts`: `generateFunctionCards()` now accepts `model` param (decoupled from hardcoded `CARD_MODEL`)
  - `src/schemas/config.ts`: added `index_model` to `LlmConfigSchema` (default `claude-haiku-4-5-20251001`)
  - `src/commands/run.ts`: passes `concurrency` and `indexModel: config.llm.index_model` to `indexProject()`, displays `index model` in launch banner
  - `src/utils/rate-limiter.ts`: added `isInterrupted` to `RetryWithBackoffOptions`, polling `sleep()` (250ms intervals) for fast Ctrl+C detection during backoff waits
  - `src/utils/renderer.ts`: added `log()` method to Renderer interface for non-breaking log output during interactive mode
  - 283 passing tests, typecheck clean, build succeeds

### Epic 13 : Audit complet de conformité — Full Review
> Goal: Valider la conformité du codebase avec les spécifications avant de passer à la v1.0. Chaque story vérifie les AC d'une story passée et appende les résultats dans un rapport unique.
> Output: `_bmad-output/planning-artifacts/epic-13-conformity-report.md`
> Mode: READ-ONLY — aucune modification de code source autorisée.

- [x] Story 13.1: Review — 1.1 Initialisation du projet et structure CLI
  > Vérifier CLI commands, structure projet, package.json, barrel exports
  > AC: help affiche toutes les commandes (scan, estimate, review, report, run, watch, status, clean-runs, reset, hook)
  > AC: src/commands/, src/core/, src/schemas/, src/utils/ existent avec barrel exports, tsup/vitest/eslint/typescript configurés

- [x] Story 13.2: Review — 1.2 Schémas Zod et gestion d'erreurs
  > Vérifier ReviewFileSchema, TaskSchema, ConfigSchema, ProgressSchema + AnatolyError
  > AC: Schémas Zod définis conformément au PRD, types inférés via z.infer<>
  > AC: AnatolyError avec codes standardisés et flag recoverable

- [x] Story 13.3: Review — 1.3 Chargement de configuration
  > Vérifier loadConfig avec fichier valide, absent, malformé
  > AC: .anatoly.yml valide → parsé et validé, absent → défauts, malformé → CONFIG_INVALID

- [x] Story 13.4: Review — 1.4 Scanner AST et hash SHA-256
  > Vérifier web-tree-sitter, SHA-256, .task.json, progress.json, cache
  > AC: scan → AST + hash + .task.json + progress.json PENDING, re-scan inchangé → CACHED

- [x] Story 13.5: Review — 1.5 Intégration coverage et détection monorepo
  > Vérifier coverage-final.json + détection monorepo
  > AC: coverage incluse dans .task.json, monorepo détecté (pnpm/yarn/nx/turbo)

- [x] Story 13.6: Review — 2.1 Estimation de scope via tiktoken
  > Vérifier tiktoken, temps estimé, auto-scan
  > AC: estimate → tokens + temps + fichiers/symboles, aucun appel LLM

- [x] Story 13.7: Review — 3.1 Construction du prompt et appel Agent SDK
  > Vérifier prompt-builder.ts + Agent SDK query() + outils filesystem + RAG pre-resolved
  > AC: prompt structuré avec 5 axes, agent invoqué, Read/Grep/Glob tools, RAG pré-résolu

- [x] Story 13.8: Review — 3.2 Validation Zod et retry automatique
  > Vérifier validation ReviewFileSchema + retry loop + max 3 tentatives
  > AC: réponse validée, invalide → feedback + retry, 3 échecs → ERROR

- [x] Story 13.9: Review — 3.3 Lock file et gestion de progress
  > Vérifier .anatoly/anatoly.lock + PID + crash recovery + écriture atomique
  > AC: lock créé, double instance → LOCK_EXISTS, crash → auto-clean, tmp+rename

- [x] Story 13.10: Review — 3.4 Dual output et transcripts
  > Vérifier .rev.json + .rev.md + transcript en temps réel
  > AC: dual output écrit, transcript appendé, nommage cohérent

- [x] Story 13.11: Review — 3.5 Commande review et orchestration séquentielle
  > Vérifier review séquentielle, timeout 180s, reprise partielle
  > AC: PENDING → IN_PROGRESS → DONE, timeout → TIMEOUT, reprise skip DONE/CACHED

- [x] Story 13.12: Review — 4.1 Agrégation des reviews et génération du rapport
  > Vérifier report.md, verdict global, sévérités
  > AC: report avec résumé + findings triés + verdict CLEAN/NEEDS_REFACTOR/CRITICAL

- [x] Story 13.13: Review — 4.2 Format Markdown actionnable pour LLM
  > Vérifier headers structurés, tableaux Markdown natifs, liens relatifs
  > AC: h1/h2/h3 + tableaux pipe-delimited + code blocks + liens .rev.md

- [x] Story 13.14: Review — 5.1 Renderer terminal enrichi
  > Vérifier zone fixe (ora + progress bar) + zone flux + mode plain
  > AC: TTY → spinner + barre Unicode + compteurs, pipe → linéaire, NO_COLOR respecté

- [x] Story 13.15: Review — 5.2 Commande run et orchestration du pipeline
  > Vérifier pipeline scan → estimate → review → report, exit codes
  > AC: pipeline complet, 0=CLEAN, 1=findings, 2=erreur technique

- [x] Story 13.16: Review — 5.3 Gestion SIGINT et flags CLI globaux
  > Vérifier Ctrl+C, --no-cache, --file, --verbose, --plain
  > AC: SIGINT → arrêt propre + résumé, flags fonctionnels

- [x] Story 13.17: Review — 6.1 Commande status
  > Vérifier status avec progress.json, findings, rapport path
  > AC: résumé par statut + findings + rapport path, pas d'audit → message clair

- [x] Story 13.18: Review — 6.2 Commandes clean-runs et reset
  > Vérifier clean-runs (ex clean-logs) + reset + alias legacy
  > AC: clean-runs supprime .anatoly/runs/, reset nettoie tout, alias clean-logs caché

- [x] Story 13.19: Review — 7.1 Mode watch avec re-scan incrémental
  > Vérifier chokidar, re-hash, re-scan, auto-review, SIGINT
  > AC: watch → surveille + re-review auto, Ctrl+C → arrêt propre

- [x] Story 13.20: Review — 9.1 Confirmation prompts opérations destructives
  > Vérifier confirmation reset, clean-runs --keep 0, --yes, non-TTY
  > AC: résumé + confirmation y/n, --yes skip, non-TTY refuse

- [x] Story 13.21: Review — 9.2 Messages d'erreur avec recovery steps
  > Vérifier hints par code erreur, format error + recovery step
  > AC: LOCK_EXISTS → PID, CONFIG_INVALID → clé + exemple, format standardisé

- [x] Story 13.22: Review — 9.3 Support NO_COLOR et flag --open
  > Vérifier NO_COLOR, --open avec xdg-open/open/start
  > AC: NO_COLOR → chalk désactivé, --open → rapport ouvert

- [x] Story 13.23: Review — 9.4 Enrichissement status et verbose mode
  > Vérifier barre de progression visuelle, --verbose tokens/cache/temps
  > AC: status → barre + compteurs, --verbose → tokens + cache + temps par fichier

- [x] Story 13.24: Review — 10.1 Pool de workers et sémaphore de concurrence
  > Vérifier worker pool, --concurrency, défaut 4, validation
  > AC: concurrency N workers, défaut 4, invalide → erreur, config.llm.concurrency

- [x] Story 13.25: Review — 10.2 ProgressManager thread-safe
  > Vérifier écritures sérialisées, crash recovery, pas de double traitement
  > AC: updateFileStatus sérialisé, crash → IN_PROGRESS → PENDING, pas de doublon

- [x] Story 13.26: Review — 10.3 Rate limiting et backoff exponentiel
  > Vérifier backoff 429, base 5s, max 120s, jitter ±20%, 5 retries max
  > AC: 429 → backoff, autres workers continuent, 5 échecs → ERROR

- [x] Story 13.27: Review — 10.4 Renderer multi-fichier
  > Vérifier slots par worker, mode plain, ordre de complétion
  > AC: [1] reviewing... [2] reviewing..., plain → linéaire, résultat → zone flux

- [x] Story 13.28: Review — 10.5 Gestion SIGINT avec reviews en vol
  > Vérifier abort simultané, résumé partiel, double Ctrl+C
  > AC: SIGINT → abort all, reviews intactes, 2nd Ctrl+C → force exit

- [x] Story 13.29: Review — 11.1 Commande anatoly hook avec sous-commandes
  > Vérifier post-edit, stop, init, fichier non-TS, commande visible
  > AC: post-edit → review background, stop → wait + feedback, non-TS → skip

- [x] Story 13.30: Review — 11.2 Debounce et gestion d'état
  > Vérifier kill+relaunch, hook-state.json, orphan PID detection
  > AC: debounce 3 modifs → seule dernière review, state atomique, crash → error

- [x] Story 13.31: Review — 11.3 Hook Stop gate de qualité
  > Vérifier additionalContext, timeout 120s, max_stop_iterations
  > AC: findings → additionalContext, CLEAN → exit 0, timeout → warning, max → silent exit

- [x] Story 13.32: Review — 11.4 Configuration min_confidence
  > Vérifier llm.min_confidence dans schema, défaut 70, validation 0-100
  > AC: champ validé, défaut 70, < 0 ou > 100 → rejeté

- [x] Story 13.33: Review — 11.5 Template configuration Claude Code
  > Vérifier hook init, .claude/settings.json, documentation
  > AC: template PostToolUse + Stop, merge si existant, instructions

- [x] Story 13.34: Review — 11.6 Protection boucles et conflits
  > Vérifier stop_count, lock coordination, orphan state, hash check
  > AC: max iterations → silent, lock actif → skip, orphan → reset, hash inchangé → skip

- [x] Story 13.35: Review — 12.1 Refactoring orchestrateur
  > Vérifier processFileForIndex(), needsReindex(), pre-warm embed, tests passent
  > AC: fonction pure, cache extrait, embed pré-chargé, tests inchangés

- [x] Story 13.36: Review — 12.2 Pool de workers indexation Haiku
  > Vérifier runWorkerPool, batch upsert, cache atomique, erreur swallowed
  > AC: N workers Haiku, batch upsert post-pool, cache unique, erreur → next

- [x] Story 13.37: Review — 12.3 Rate limiting Haiku avec backoff
  > Vérifier retryWithBackoff Haiku (base 2s, max 30s), 5 retries
  > AC: 429 → backoff 2s/30s, autres continuent, 5 échecs → skip

- [x] Story 13.38: Review — 12.4 Affichage progression indexation
  > Vérifier [N/total] file, stats cards/files, mode plain
  > AC: progression par worker, stats identiques, plain → log par fichier

- [x] Story 13.39: Review — 12.5 Gestion SIGINT indexation parallèle
  > Vérifier isInterrupted, batch upsert partiel, cache, 2nd Ctrl+C
  > AC: SIGINT → stop dispatch + finish current + upsert + cache, reprise incrémentale

- [x] Story 13.40: Review — 8.1 Corrections RAG v0.2.0 code review
  > Vérifier sanitizeId, complexité else-if, postinstall skip, distance→cosine, countRows, version dynamique
  > AC: injection sanitisée, else-if correct, SKIP_DOWNLOAD, distance→cosine, countRows, version package.json

- [x] Story 13.41: Review — 8.2 RAG pre-resolved in prompt
  > Vérifier searchById avant prompt, buildRagPromptSection, pas de MCP tool, tools.ts supprimé
  > AC: pre-resolved injection, matches avec scores, no matches → message, --no-rag → skip, tools.ts absent

### Epic 14 : Codebase Hygiene — Audit-Driven Cleanup
> Goal: Resolve all findings from Anatoly self-audit to reach CLEAN verdict. Eliminate runtime bugs, dead code, duplications, and structural complexity.
> Source: 4 Anatoly audit runs from 2026-02-24 (60 file reviews total)
> Spec: `_bmad/bmm/docs/epics/epic-14-codebase-hygiene.md`

- [x] Story 14.1: Fix Bugs & Correction Errors
  > Fix 2 confirmed bugs (14.1.3 was a false positive — Zod v4 does NOT propagate sub-schema defaults with `.default({})`, explicit defaults are required).
  > AC: Given `extractJson()` with nested braces, When called with `{"a": {"b": 1}}`, Then the full valid JSON is extracted correctly (not truncated at first closing brace). ✓ Fixed: brace-counting parser replaces indexOf/lastIndexOf approach.
  > AC: Given `rowToCard()` with malformed JSON in vector store, When converting row to card, Then no runtime crash — malformed rows are skipped gracefully. ✓ Fixed: `safeParseJsonArray()` wraps JSON.parse with try-catch.
  > AC: ConfigSchema 14.1.3 — N/A: Zod v4 `.default({})` does NOT apply sub-field defaults. Current explicit defaults are correct and required.
  > AC: All 288 tests pass, `npm run build` succeeds.

- [x] Story 14.2: Remove Dead Code
  > Removed dead symbols, barrel exports, and dead modules. 275 tests pass, build succeeds.
  > ✓ Deleted 3 barrel exports (schemas/index, utils/index, core/index)
  > ✓ Removed computeHash, detectMonorepo/MonorepoInfo (entire file), parseReviewResponse, BehavioralProfile type
  > ✓ Internalized 4 Zod schemas in task.ts (removed export, kept definitions)
  > ✓ 14.2.4 truncatePath: skipped — still used internally in renderer.ts

- [x] Story 14.3: Consolidate Duplications
  > ✓ pkgVersion → src/utils/version.ts (shared by cli.ts + run.ts)
  > ✓ isProcessRunning → src/utils/process.ts (shared by hook-state.ts + lock.ts)
  > ✓ loadLanguage() generic factory in scanner.ts (replaces getTsLanguage/getTsxLanguage duplication)
  > ✓ FunctionCardSchema/VectorRow: intentionally separate (logical vs physical schema, type mismatches from JSON serialization)

- [x] Story 14.4: Structural Refactoring
  > ✓ registerRunCommand → 6 phase functions + RunContext (printBanner, runScanPhase, runEstimatePhase, runRagPhase, runReviewPhase, runReportPhase)
  > ✓ reviewFile → extracted preResolveRag() as separate function
  > ✓ matchGlob replaced with picomatch library
  > ✓ 14.4.3 (shared CLI scaffolding): deferred — run.ts/review.ts have sufficiently different flows

- [x] Story 14.5: Clean Up Module Exports
  > ✓ Internalized formatCounterRow, formatResultLine, truncatePath in renderer.ts
  > ✓ 14.5.2 skipped as N/A (barrel exports deleted in 14.2)

### Epic 15 : Migration du renderer CLI vers listr2
> Goal: Le développeur bénéficie d'un feedback CLI propre et professionnel grâce à listr2 v10 : task trees avec spinners natifs, progress concurrent multi-workers, fallback CI/non-TTY automatique — remplaçant les 400 lignes de renderer custom ANSI.
> Plan technique: `.claude/plans/hazy-floating-fiddle.md`

- [x] Story 15.1: Extraction des utilitaires de formatage
  > Découpler les fonctions de formatage du renderer pour réutilisation.
  > AC: Given `verdictColor()`, `truncatePath()`, `buildProgressBar()`, `formatCounterRow()`, `formatResultLine()`, `Counters` dans `renderer.ts`, When extraction terminée, Then dans `src/utils/format.ts` + tests dans `format.test.ts`.
  > AC: Given `status.ts` et `report.ts`, When imports mis à jour, Then pointent vers `../utils/format.js`.
  > AC: Given `npm run test && npm run typecheck`, Then tout passe.

- [x] Story 15.2: Installation de listr2 et nettoyage des dépendances
  > Ajouter listr2, supprimer ora/log-update/ansi-escapes.
  > AC: Given `package.json`, When deps mises à jour, Then `listr2` v10+ ajouté, `ora`/`log-update`/`ansi-escapes` supprimés.
  > AC: Given `npm run build`, Then build réussit.

- [x] Story 15.3: Réécriture de review.ts avec listr2
  > Remplacer le renderer custom par listr2 dans la commande review (séquentiel).
  > AC: Given fichiers PENDING, When `anatoly review`, Then task tree listr2 avec progression par fichier et verdicts persistants.
  > AC: Given non-TTY ou `--plain`, Then SimpleRenderer automatique.
  > AC: Given Ctrl+C, Then arrêt propre avec résumé partiel.
  > AC: Given `createRenderer` supprimé de review.ts, Then `npm run typecheck` passe.

- [x] Story 15.4: Réécriture de run.ts avec listr2 et worker slots
  > Remplacer le renderer custom par listr2 dans le pipeline run avec worker slots concurrents.
  > AC: Given `anatoly run`, Then task tree : Scan → Estimate → RAG → Reviewing [N/total] → Report.
  > AC: Given `--concurrency 4`, Then 4 subtasks concurrentes comme worker slots, compteur atomique partagé.
  > AC: Given Ctrl+C, Then tous AbortControllers abortés, résumé partiel affiché.
  > AC: Given rate limit 429, Then message retry via `slot.output`.

- [x] Story 15.5: Suppression du renderer custom et nettoyage final
  > Supprimer renderer.ts et valider le projet entier.
  > AC: Given réécriture terminée, Then `src/utils/renderer.ts` et `renderer.test.ts` supprimés.
  > AC: Given aucun import depuis `renderer.js` dans le projet.
  > AC: Given `npm run test && npm run build && npm run typecheck`, Then tout passe.
  > AC: Given tests E2E manuels (run, run --concurrency 4, run | cat, NO_COLOR, --plain, Ctrl+C, review, status, report), Then tout fonctionne.

### Epic 16 : Intelligence pré-review — Triage & Graphe d'usage (v0.4.0)
> Goal: Le développeur bénéficie d'un triage automatique (skip/fast/deep) et d'un graphe d'imports pré-calculé qui élimine les greps redondants pendant les reviews.

- [x] Story 16.1: Module triage — classification skip/fast/deep
  > Classifier chaque fichier en tier skip/fast/deep avant review. Générer auto-CLEAN pour les fichiers triviaux.
  > AC: Given barrel export, When triageFile(), Then tier='skip', reason='barrel-export'.
  > AC: Given fichier < 10 lignes avec 0-1 symbole, When triageFile(), Then tier='skip', reason='trivial'.
  > AC: Given fichier type-only (tous symboles type/enum), When triageFile(), Then tier='skip', reason='type-only'.
  > AC: Given fichier constantes pures, When triageFile(), Then tier='skip', reason='constants-only'.
  > AC: Given fichier < 50 lignes avec < 3 symboles, When triageFile(), Then tier='fast', reason='simple'.
  > AC: Given fichier sans exports, When triageFile(), Then tier='fast', reason='internal'.
  > AC: Given fichier complexe, When triageFile(), Then tier='deep', reason='complex'.
  > AC: Given fichier skip, When generateSkipReview(), Then ReviewFile valide CLEAN, is_generated=true, 0 appel API.
  > AC: Given tests, When `npm run test -- src/core/triage.test.ts`, Then tous passent.

- [x] Story 16.2: Graphe d'usage pré-calculé
  > Scanner tous les imports du projet en une passe locale (< 2s) pour déterminer quels exports sont USED/DEAD.
  > AC: Given imports nommés `import { A, B } from './path'`, When buildUsageGraph(), Then A et B trackés avec importeurs.
  > AC: Given import default, When buildUsageGraph(), Then symbole 'default' tracké.
  > AC: Given namespace import `import * as X`, When buildUsageGraph(), Then tous les exports du source comptés USED.
  > AC: Given import relatif './utils/cache', When résolution, Then résolu vers .ts ou /index.ts, .js strippé.
  > AC: Given import node_modules, When buildUsageGraph(), Then ignoré.
  > AC: Given getSymbolUsage() avec symbole importé par 3 fichiers, Then retourne les 3 fichiers.
  > AC: Given 500 fichiers, When buildUsageGraph(), Then < 2s.
  > AC: Given tests, When `npm run test -- src/core/usage-graph.test.ts`, Then tous passent.

- [x] Story 16.3: Injection du graphe d'usage dans le prompt agent
  > Injecter les données d'usage dans le system prompt des reviews deep pour éliminer les greps.
  > AC: Given usageGraph dans PromptOptions, When buildSystemPrompt(), Then section "Pre-computed Import Analysis" ajoutée.
  > AC: Given symbole 0 importeurs, Then affiché "⚠️ LIKELY DEAD".
  > AC: Given symbole non-exporté, Then affiché "internal only".
  > AC: Given règle supplémentaire ajoutée, Then "Do NOT grep for imports — this data is exhaustive."
  > AC: Given usageGraph absent (undefined), Then section et règle non ajoutées (backward compatible).
  > AC: Given `npm run typecheck`, Then passe.

- [x] Story 16.4: Intégration triage et usage graph dans le pipeline
  > Intégrer triage + usage graph dans run.ts comme étapes automatiques du pipeline.
  > AC: Given 40 fichiers PENDING, When `npx anatoly run`, Then étape triage affiche distribution: "8 skip · 14 fast · 18 deep".
  > AC: Given fichiers skip, When phase review, Then generateSkipReview() + writeReviewOutput() + DONE, 0 appel API, affichés "CLEAN (skipped)".
  > AC: Given fichiers deep, When phase review, Then comportement actuel + usageGraph injecté dans promptOptions.
  > AC: Given `--no-triage`, When run, Then tous fichiers traités deep, affiche "triage — disabled (--no-triage)".
  > AC: Given estimator.ts, When triage actif, Then estimation par tier: skip=0s, fast=5s, deep=45s.
  > AC: Given fichiers fast, When phase review, Then traités comme deep (fallback temporaire, TODO Epic 17).

### Epic 17 : Fast review sans tools (v0.4.0)
> Goal: Review allégée single-turn sans tools pour les fichiers simples, divisant par ~6 le temps et le coût de ces reviews.

- [x] Story 17.1: Prompt simplifié et module fast-reviewer
  > Créer un prompt dédié et un module fast-reviewer pour les fichiers tier fast en single-turn.
  > AC: Given buildFastSystemPrompt(), Then prompt sans instructions tools, utility basé sur graphe, duplication basé sur RAG, insiste "All context is provided. Output ONLY the JSON."
  > AC: Given user message, Then inclut contenu fichier inline, symboles, données usage, RAG, coverage.
  > AC: Given fichier fast, When fastReviewFile(), Then query() avec maxTurns:1, aucun tool, bypassPermissions.
  > AC: Given réponse JSON invalide, When premier appel échoue Zod, Then retry avec feedback Zod, maxTurns:1.
  > AC: Given 2 échecs Zod consécutifs, When fast review échoue, Then fichier promu deep, warning loggé.
  > AC: Given fast review terminée, Then transcript simplifié écrit (prompt + réponse).
  > AC: Given tests, When `npm run test -- src/core/fast-reviewer.test.ts`, Then tous passent.

- [x] Story 17.2: Configuration fast_model et intégration pipeline
  > Dispatcher les fichiers fast au fast-reviewer dans le pipeline et supporter un modèle optionnel moins cher.
  > AC: Given `llm.fast_model` dans .anatoly.yml, Then fast reviewer utilise ce modèle. Si absent, fallback au modèle principal.
  > AC: Given LlmConfigSchema, When fast_model ajouté, Then z.string().optional().
  > AC: Given fichiers tier fast dans run.ts, When dispatch, Then fastReviewFile() appelé (remplace le TODO Epic 16).
  > AC: Given pool concurrence, When fast et deep en parallèle, Then même sémaphore, rate limiter, backoff.
  > AC: Given fichier fast promu deep (fallback), Then re-dispatché à reviewFile() dans le même slot.
  > AC: Given résumé fin de pipeline, Then compteurs distinguent "N skipped · N fast · N deep".

### Epic 18 : Report shardé avec index à checkboxes (v0.4.0)
> Goal: Rapport découpé en index + shards de 10 fichiers triés par sévérité, avec checkboxes pour pilotage par agent.

- [x] Story 18.1: Refonte reporter — index + shards triés par sévérité
  > Découper le rapport en index court + shards de max 10 fichiers.
  > AC: Given 62 fichiers avec findings, When generateReport(), Then report.md (index) + report.1.md à report.7.md (shards).
  > AC: Given index, Then contient résumé exécutif, tableau sévérités, checkboxes `- [ ]` par shard avec lien et composition.
  > AC: Given index, Then toujours < ~100 lignes.
  > AC: Given shards, Then max 10 fichiers, sections Findings/Quick Wins/Refactors/Hygiene, actions limitées au shard.
  > AC: Given tri sharding, Then CRITICAL d'abord, puis NEEDS_REFACTOR, puis high count, puis confidence max.
  > AC: Given 0 findings, Then aucun shard, index affiche "All files clean".
  > AC: Given ≤ 10 findings, Then un seul shard report.1.md.
  > AC: Given generateReport() return path, Then toujours report.md (index). --open ouvre report.md.
  > AC: Given .rev.json et .rev.md, Then inchangés.

- [x] Story 18.2: Section Performance & Triage dans le rapport
  > Ajouter les stats de triage dans l'index quand le triage est actif.
  > AC: Given triage actif + triageStats renseigné, When rapport généré, Then section "⚡ Performance & Triage" avec skip/fast/deep counts + % + estimated time saved.
  > AC: Given TriageStats type, Then { total, skip, fast, deep, estimatedTimeSaved }.
  > AC: Given --no-triage (pas de triageStats), Then section Performance & Triage absente.
  > AC: Given triageStats optionnel dans generateReport(), Then backward compatible, typecheck passe.

### Epic 19 : Contexte structurel — Arborescence projet dans le pipeline d'évaluation
> Goal: Le développeur obtient des évaluations best-practices et overengineering plus précises grâce à l'injection du contexte structurel du projet (arborescence compacte des fichiers/dossiers) dans les prompts des évaluateurs.

- [x] Story 19.1: Génération de l'arborescence projet depuis les fichiers scannés
  > Générer une arborescence ASCII compacte du projet à partir des fichiers scannés.
  > AC: Given scan complété avec N fichiers dans `.anatoly/tasks/`, When `buildProjectTree(taskFiles)` appelée, Then retourne string ASCII avec `├──` / `└──` / `│`, seuls fichiers scannés inclus.
  > AC: Given projet 500+ fichiers, When arborescence générée, Then < 300 tokens (cl100k_base), dossiers profonds condensés si > 4 niveaux.
  > AC: Given arborescence générée, When inspectée, Then dossiers triés avant fichiers, format lisible humain + LLM.

- [x] Story 19.2: Injection de l'arborescence dans l'axe best-practices
  > L'évaluateur best-practices reçoit l'arborescence pour détecter les incohérences de placement.
  > AC: Given `AxisContext` avec `projectTree`, When évaluateur BP exécuté, Then prompt inclut section `## Project Structure` avec arborescence ASCII + règle évaluation placement fichier.
  > AC: Given fichier mal placé `src/commands/string-utils.ts`, When BP review avec arborescence, Then finding WARN avec suggestion actionnable.
  > AC: Given fichier bien placé `src/core/scanner.ts`, When BP review, Then aucun finding structurel.
  > AC: Given `projectTree` absent, When BP exécuté, Then fonctionne normalement (graceful degradation).

- [x] Story 19.3: Injection de l'arborescence dans l'axe overengineering
  > L'évaluateur overengineering reçoit l'arborescence pour détecter la fragmentation excessive.
  > AC: Given `AxisContext` avec `projectTree`, When évaluateur OE exécuté, Then prompt inclut arborescence + heuristiques (dossier 1 fichier → fragmentation, > 5 niveaux → complexité, factories/adapters ≤ 2 fichiers → over-engineering).
  > AC: Given fichier dans `src/factories/` avec 1 seul fichier, When OE review, Then signale fragmentation, rating peut passer LEAN → OVER.
  > AC: Given `projectTree` absent, When OE exécuté, Then fonctionne normalement (graceful degradation).

### Epic 20 : Extraction des prompts d'évaluation dans des fichiers Markdown dédiés
> Goal: Extraire les system prompts hardcodés de chaque axe dans des fichiers Markdown dédiés (`src/core/axes/prompts/*.system.md`), chargés au build-time via esbuild — zéro I/O runtime, zéro changement fonctionnel.

- [x] Story 20.1: Infrastructure d'import Markdown (build-time)
  > Configurer tsup (esbuild) et vitest pour importer des `.md` comme des strings au build-time.
  > AC: Given `src/types/md.d.ts` avec `declare module '*.md'`, When `import content from './foo.md'`, Then TypeScript accepte sans erreur, `content` typé `string`.
  > AC: Given tsup avec `.md` → `text` loader, When `npm run build`, Then contenu `.md` inliné comme string dans le bundle.
  > AC: Given vitest avec plugin raw-md, When `npm run test`, Then imports `.md` résolus correctement, tous tests passent.

- [x] Story 20.2: Extraction des 6 prompts système dans des fichiers Markdown
  > Créer 6 fichiers `.system.md` dans `src/core/axes/prompts/` avec le contenu exact des template literals.
  > AC: Given 6 fichiers `.system.md`, When comparés aux template literals originaux, Then texte strictement identique (backticks dé-échappés, pas de `${}`).
  > AC: Given `best-practices.system.md`, When inspecté, Then contient la table complète des 17 règles TypeGuard v2 inline (aucune interpolation).
  > AC: Given un `.system.md` ouvert dans un éditeur, Then syntax highlighting Markdown natif, backticks non échappés.

- [x] Story 20.3: Refactoring des builders TypeScript pour utiliser les imports .md
  > Modifier les `buildXxxSystemPrompt()` pour importer le contenu depuis les fichiers `.md`.
  > AC: Given chaque fichier d'axe (utility, duplication, correction, overengineering, tests, best-practices), When `buildXxxSystemPrompt()` appelée, Then retourne contenu du `.md` via import + `.trimEnd()`.
  > AC: Given `RULES_TABLE` dans best-practices.ts, When refactoring terminé, Then constante supprimée, contenu dans `.md`.
  > AC: Given les 6 fichiers de test, When `npm run test`, Then tous passent sans modification, assertions `toContain()` réussissent.
  > AC: Given build final, When `npm run typecheck && npm run build && npm run test`, Then les 3 réussissent, taille bundle quasi identique.

### Epic 21 : Opus Deliberation Pass — Validation post-merge inter-axes
> Goal: Le développeur bénéficie d'une validation intelligente des findings par Opus après la fusion des 6 axes. Le "juge de délibération" vérifie la cohérence inter-axes, filtre les faux positifs résiduels, ajuste les confidences et recalcule le verdict final. Activé via `--deliberation` ou `llm.deliberation: true`.

- [x] Story 21.1: Configuration et flags CLI pour la délibération
  > Configurer la passe de délibération Opus via `.anatoly.yml` et/ou flags CLI.
  > AC: Given `LlmConfigSchema`, When inspecté, Then contient `deliberation: z.boolean().default(false)` et `deliberation_model: z.string().default('claude-opus-4-6')`.
  > AC: Given `anatoly run --deliberation`, When exécuté, Then `config.llm.deliberation` mis à `true` (override YAML).
  > AC: Given `anatoly run --no-deliberation` avec config YAML `deliberation: true`, Then délibération désactivée (CLI prioritaire).
  > AC: Given `resolveAxisModel()`, When composant demande modèle délibération, Then `resolveDeliberationModel(config)` retourne `config.llm.deliberation_model`.

- [x] Story 21.2: Module deliberation.ts — Schéma Zod et prompt builder
  > Créer le module avec schéma Zod de réponse et prompts dédiés pour le juge Opus.
  > AC: Given `src/core/deliberation.ts`, When inspecté, Then exporte `DeliberationResponseSchema` (verdict, symbols avec original/deliberated correction+confidence+reasoning, removed_actions, reasoning global).
  > AC: Given `buildDeliberationSystemPrompt()`, Then retourne prompt définissant rôle juge post-merge, interdisant ajout findings, protégeant ERROR confirmés, exigeant raisonnement et confidence ≥ 85.
  > AC: Given `buildDeliberationUserMessage(review, fileContent)`, Then retourne ReviewFile JSON + code source + instructions délibération.

- [x] Story 21.3: Logique needsDeliberation et applyDeliberation
  > Décider si un fichier nécessite délibération et appliquer le résultat Opus.
  > AC: Given `needsDeliberation(review)` avec fichier CLEAN confidence ≥ 95, Then retourne `false`.
  > AC: Given `needsDeliberation(review)` avec symbole NEEDS_FIX/ERROR/DEAD/DUPLICATE/OVER, Then retourne `true`.
  > AC: Given `needsDeliberation(review)` avec fichier CLEAN mais confidence < 70, Then retourne `true`.
  > AC: Given `applyDeliberation(review, deliberation)`, Then retourne ReviewFile avec corrections reclassifiées, confidences ajustées, actions supprimées, verdict recalculé, detail enrichi `(deliberated: <reason>)`.
  > AC: Given Opus tente rétrograder ERROR → OK, Then appliqué seulement si confidence Opus ≥ 95.

- [x] Story 21.4: Intégration dans file-evaluator.ts
  > Intégrer la passe de délibération dans le pipeline après le merge des 6 axes.
  > AC: Given `config.llm.deliberation === true` et `needsDeliberation()` retourne `true`, When merge terminé, Then appel `runSingleTurnQuery()` Opus + `applyDeliberation()` + coût/durée ajoutés + transcript sous `## Deliberation Pass`.
  > AC: Given `config.llm.deliberation === false`, Then aucun appel Opus.
  > AC: Given `needsDeliberation()` retourne `false`, Then skippé avec transcript `## Deliberation Pass — SKIPPED`.
  > AC: Given appel Opus échoue (timeout, API, Zod), Then ReviewFile brut conservé + transcript `## Deliberation Pass — FAILED` + warning stderr.

- [x] Story 21.5: Tests unitaires et d'intégration
  > Tests complets pour le module de délibération.
  > AC: Given `src/core/deliberation.test.ts`, Then couvre: needsDeliberation false/true (CLEAN 95%, NEEDS_FIX, CLEAN <70), applyDeliberation reclassification/suppression actions/verdict recalcul/refus ERROR→OK <95/enrichissement detail, schemas valide/invalide.
  > AC: Given `src/core/file-evaluator.test.ts`, Then couvre: délibération appelée quand activée + non-CLEAN, skippée quand CLEAN 95%, graceful failure.
  > AC: Given `npm run typecheck && npm run build && npm run test`, Then les 3 réussissent.

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
- Architecture doc: `_bmad-output/planning-artifacts/architecture.md`
- UX spec: `_bmad-output/planning-artifacts/ux-design-specification.md`
- Epic 13 spec: `_bmad-output/planning-artifacts/epic-13-full-review.md`
- Epic 14 spec: `_bmad/bmm/docs/epics/epic-14-codebase-hygiene.md`
- Scaling spec (v0.4.0): `_bmad-output/planning-artifacts/scaling+agentic-ready.md`
- ESM-only project (`"type": "module"`) — several deps are ESM-only
- Node >= 20.19 minimum
- Zod v4 required (peer dep of @anthropic-ai/claude-agent-sdk)
- Named exports only — `export default` forbidden
- kebab-case filenames, co-located tests
- **Story dependency order:** 14.1 → 14.2 → 14.3 → 14.4 → 14.5 (14.2 must precede 14.5)
- Epic 15 plan: `.claude/plans/hazy-floating-fiddle.md`
- **Story dependency order:** 15.1 → 15.2 → 15.3 → 15.4 → 15.5 (strict sequential)
- **Story dependency order:** 16.1 → 16.2 → 16.3 → 16.4 → 17.1 → 17.2 (16 before 17, strict)
- **Epic 18 is independent** of 16/17 — can be implemented in parallel or after
- **Story dependency order:** 19.1 → 19.2 → 19.3 (19.1 must precede 19.2 and 19.3)
- **Epic 19** depends on Epic 1 (scanner) and Epic 16 (usage-graph) — both completed
- **Story dependency order:** 20.1 → 20.2 → 20.3 (strict sequential — infra before extraction before refactoring)
- **Epic 20** depends on Epic 19 (axis pipeline) — completed
- **Story dependency order:** 21.1 → 21.2 → 21.3 → 21.4 → 21.5 (strict sequential)
- **Epic 21** depends on Epic 16 (axis merger + file evaluator) and Epic 3 (axis-evaluator) — both completed
- **Epics 20 and 21 are independent** — can be implemented in either order or in parallel

### Completed (Epic 18)

- [x] Story 18.1: Refonte reporter — index + shards triés par sévérité (2026-02-25)
  - `src/core/reporter.ts`: added `sortFindingFiles()`, `buildShards()`, `renderIndex()`, `renderShard()`, `ShardInfo` interface
  - Index (<100 lines): executive summary + severity table + checkbox shard links with CRITICAL/NEEDS_REFACTOR composition
  - Shards: max 10 files each, findings table + actions (Quick Wins/Refactors/Hygiene) scoped to shard
  - Sort order: CRITICAL → NEEDS_REFACTOR → finding count desc → confidence desc
  - 0 findings → "All files clean", ≤10 → single shard, generateReport() always returns report.md
  - Existing `renderReport()` kept for backward compatibility
  - 349 tests (24 new), typecheck clean, build succeeds

- [x] Story 18.2: Section Performance & Triage dans le rapport (2026-02-25)
  - `src/core/reporter.ts`: added `TriageStats` type, optional `triageStats` param on `generateReport()` and `renderIndex()`
  - Renders "Performance & Triage" section with tier breakdown table (skip/fast/deep counts + %) and estimated time saved
  - Absent when `--no-triage` or triage not active (backward compatible)
  - `src/commands/run.ts`: builds TriageStats from reviewCounts + SECONDS_PER_TIER, passes to generateReport()
  - 352 tests (3 new), typecheck clean, build succeeds

### Epic 19 : Axis-Based Evaluation Pipeline
> Goal: Remplacer le prompt monolithique (1 appel LLM = 5 axes) par un pipeline d'evaluateurs par axe. Ajouter un 6eme axe "Best Practices" (TypeGuard v2). Afficher la progression par axe dans la CLI avec des checkboxes.
> Architecture: `_bmad/bmm/docs/architecture-axis-pipeline.md`
> Epic detail: `_bmad/bmm/docs/epics/epic-19-axis-pipeline.md`

- [x] Story 19.1: Interface et types de base
  > Creer l'interface AxisEvaluator, les types AxisId/AxisContext/AxisResult, et la fonction partagee runSingleTurnQuery().
  > AC: Given `src/core/axis-evaluator.ts`, When typecheck, Then AxisEvaluator interface et runSingleTurnQuery() sont exportes, `npm run typecheck` et `npm run build` passent.
  > Files: `src/core/axis-evaluator.ts`, `src/core/axes/index.ts`

- [x] Story 19.2: Schemas v2
  > Bump ReviewFileSchema a version 2 avec BestPracticesSchema, axis_meta, et AxisConfigSchema dans config.
  > AC: Given schemas modifies, When tests, Then review.test.ts et config.test.ts passent, champs optionnels backwards-compatible.
  > Files: `src/schemas/review.ts`, `src/schemas/config.ts`, `src/schemas/review.test.ts`, `src/schemas/config.test.ts`

- [x] Story 19.3: Evaluateurs pre-calcules (utility + duplication)
  > Creer les evaluateurs utility (usage graph) et duplication (RAG). Single-turn, haiku, prompts focalises.
  > AC: Given evaluateurs, When appel avec mock SDK, Then resultats conformes au schema Zod partiel, prompts < 50 lignes.
  > Files: `src/core/axes/utility.ts`, `src/core/axes/duplication.ts`, tests

- [x] Story 19.4: Evaluateurs a raisonnement (correction + overengineering + tests)
  > Creer les evaluateurs correction (sonnet), overengineering (haiku), tests (haiku).
  > AC: Given evaluateurs, When appel avec mock SDK, Then resultats conformes, chaque prompt focalise sur 1 seul axe.
  > Files: `src/core/axes/correction.ts`, `src/core/axes/overengineering.ts`, `src/core/axes/tests.ts`, tests

- [x] Story 19.5: Evaluateur Best Practices (nouvel axe)
  > Creer l'evaluateur best_practices avec les 17 regles TypeGuard v2 (score /10 + checklist PASS/WARN/FAIL).
  > AC: Given evaluateur, When appel, Then 17 regles evaluees, score pondere, detection de contexte fichier.
  > Files: `src/core/axes/best-practices.ts`, tests

- [x] Story 19.6: Merger + Orchestrateur + CLI
  > Creer axis-merger.ts, file-evaluator.ts, mise a jour run.ts avec sub-tasks Listr2, simplification triage, suppression anciens fichiers.
  > AC: Given `anatoly run`, When execution, Then checkboxes par axe affichees, 1 axe en echec ne bloque pas les autres, anciens fichiers supprimes.
  > Files: `src/core/axis-merger.ts`, `src/core/file-evaluator.ts`, `src/commands/run.ts`, `src/core/triage.ts`, supprimer reviewer.ts/fast-reviewer.ts/prompt-builder.ts

- [x] Story 19.7: Estimateur + Rapports
  > Mise a jour estimator (6 axes, haiku vs sonnet) et reporter (colonne best_practices, score /10, methodology).
  > AC: Given nouveau pipeline, When estimation et rapport, Then refletent le pipeline par axe avec best_practices.
  > Files: `src/core/estimator.ts`, `src/core/reporter.ts`, tests

### Completed (Epic 19)

- [x] Story 19.1: Interface et types de base (2026-02-25)
  - `src/core/axis-evaluator.ts`: AxisId, AxisContext, AxisSymbolResult, AxisResult, AxisEvaluator interface
  - `runSingleTurnQuery()`: shared single-turn LLM query utility with generic Zod validation + 1 retry
  - Encapsulates Claude Agent SDK `query()` (maxTurns:1, no tools, bypassPermissions)
  - Internal helpers: `execQuery()`, `tryValidate()`, `formatMessage()` for transcript
  - `src/core/axes/index.ts`: `getEnabledEvaluators(config)`, `resolveAxisModel()`, `ALL_AXIS_IDS`
  - 360 tests pass, typecheck clean, build succeeds (210.65 KB)

- [x] Story 19.2: Schemas v2 (2026-02-25)
  - `src/schemas/review.ts`: BestPracticesRuleSchema (rule_id 1-17, PASS/WARN/FAIL, CRITIQUE/HAUTE/MOYENNE), BestPracticesSchema (score 0-10, rules, suggestions), AxisIdSchema, AxisMetaEntrySchema
  - ReviewFileSchema: version accepts 1 or 2 (backward compatible), optional best_practices and axis_meta
  - `src/schemas/config.ts`: AxisConfigSchema (enabled, model override), AxesConfigSchema (6 axes, all default enabled), integrated into LlmConfigSchema
  - Key learning: Zod v4 `z.record(enumSchema, valueSchema)` requires ALL enum keys — use `z.record(z.string(), valueSchema)` for partial records
  - 360 tests (8 new: 4 review, 4 config), typecheck clean, build succeeds

- [x] Story 19.3: Evaluateurs pre-calcules — utility + duplication (2026-02-25)
  - `src/core/axes/utility.ts`: UtilityEvaluator (haiku), focused prompt, usage graph injection, UtilityResponseSchema (USED/DEAD/LOW_VALUE)
  - `src/core/axes/duplication.ts`: DuplicationEvaluator (haiku), focused prompt, RAG injection, DuplicationResponseSchema (UNIQUE/DUPLICATE + duplicate_target)
  - `src/core/axes/utility.test.ts`: 5 tests (prompt focus, user message, usage graph, internal symbols)
  - `src/core/axes/duplication.test.ts`: 7 tests (prompt focus, user message, RAG, null results, empty RAG)
  - Fixed circular dependency: moved `resolveAxisModel()` from `axes/index.ts` to `axis-evaluator.ts`
  - `src/core/axes/index.ts`: removed duplicate `resolveAxisModel()`, imports from `axis-evaluator.js`
  - 372 tests, typecheck clean, build succeeds

- [x] Story 19.4: Evaluateurs a raisonnement — correction + overengineering + tests (2026-02-25)
  - `src/core/axes/correction.ts`: CorrectionEvaluator (sonnet), OK/NEEDS_FIX/ERROR + actions with severity mapping
  - `src/core/axes/overengineering.ts`: OverengineeringEvaluator (haiku), LEAN/OVER/ACCEPTABLE
  - `src/core/axes/tests.ts`: TestsEvaluator (haiku), GOOD/WEAK/NONE + coverage data table injection
  - Tests: 3 + 3 + 4 new tests per evaluator (prompt focus, user message, coverage/symbols)
  - Coverage data uses flat fields (statements_total, etc.) not nested objects

- [x] Story 19.5: Evaluateur Best Practices — 17 TypeGuard v2 rules (2026-02-25)
  - `src/core/axes/best-practices.ts`: BestPracticesEvaluator (sonnet), file-level evaluation
  - 17 rules with severity-based penalties (CRITIQUE -3/-4pts, HAUTE -1pt, MOYENNE -0.5pt), score 0-10
  - `detectFileContext()`: detects react-component/api-handler/utility/test/config/general for rule adaptation
  - Rules table embedded in system prompt, file stats in user message
  - `_bestPractices` extra property on AxisResult for merger consumption
  - 13 new tests: detectFileContext (6), prompt (3), user message (3), rule coverage (1)
  - All 6 evaluators registered in `axes/index.ts`
  - 394 tests total, typecheck clean, build succeeds (210.65 KB)

- [x] Story 19.6: Merger + Orchestrateur + CLI (2026-02-25)
  - `src/core/axis-merger.ts`: mergeAxisResults(task, results[], bestPractices?) → ReviewFile v2
  - Combines per-symbol results from each axis, applies coherence rules (DEAD → tests:NONE, ERROR → ACCEPTABLE)
  - Computes verdict (ERROR/NEEDS_FIX → CRITICAL, DEAD/DUPLICATE/OVER → NEEDS_REFACTOR, else CLEAN)
  - Merges actions with sequential IDs, deduplicates file-level results, builds axis_meta
  - `src/core/file-evaluator.ts`: evaluateFile() orchestrates all axes via Promise.allSettled
  - Reads file once, pre-resolves RAG, extracts _bestPractices, reports per-axis completion
  - `src/core/triage.ts`: simplified to skip/evaluate (no fast/deep distinction in axis pipeline)
  - `src/commands/run.ts`: rewritten to use evaluateFile + getEnabledEvaluators
  - `src/commands/review.ts` + `src/commands/watch.ts`: updated to use evaluateFile
  - Deleted: reviewer.ts, fast-reviewer.ts, prompt-builder.ts + all their tests
  - Moved PreResolvedRag types to axis-evaluator.ts
  - 15 axis-merger tests, 8 file-evaluator tests (mocked evaluators + Promise.allSettled fault tolerance)
  - 373 tests total, typecheck clean, build succeeds

- [x] Story 19.7: Estimateur + Rapports (2026-02-25)
  - `src/core/estimator.ts`: SECONDS_PER_TIER updated to skip/evaluate (no fast/deep), SECONDS_PER_FILE=8 (parallel axes)
  - Added AXIS_COUNT=6, HAIKU_AXES=4, SONNET_AXES=2 constants
  - EstimateResult now includes estimatedCalls (6 per file)
  - TieredEstimateOptions simplified to { skip, evaluate }
  - `src/core/reporter.ts`: TriageStats simplified to { total, skip, evaluate, estimatedTimeSaved }
  - Shard findings table: added "BP Score" column (score/10 or dash)
  - Added "Methodology" section to index: 6-axis pipeline table with model assignments
  - Performance & Triage section: uses skip/evaluate instead of skip/fast/deep
  - `src/commands/run.ts`: updated TriageStats construction for new shape
  - 7 new tests (methodology, BP score, estimateTriagedMinutes, SECONDS_PER_TIER)
  - 380 tests total, typecheck clean, build succeeds (214.52 KB)

### Completed (Epic 19 — Structural Context: Project Tree)

- [x] Stories 19.1 + 19.2 + 19.3: Project tree generation + injection into BP & OE axes (2026-02-27)
  - `src/core/project-tree.ts`: `buildProjectTree(filePaths, maxDepth=4)` — ASCII tree with `├──`/`└──`/`│`
  - Directories sorted before files, both alphabetically
  - Deep paths (> maxDepth) condensed by collapsing single-child directory chains
  - `src/core/axis-evaluator.ts`: added optional `projectTree` to `AxisContext`
  - `src/core/axes/best-practices.ts`: injects `## Project Structure` section for file placement evaluation (rule 11)
  - `src/core/axes/overengineering.ts`: injects tree + fragmentation heuristics (1-file dirs, >5 levels, factory dirs)
  - `src/core/file-evaluator.ts`: passes `projectTree` from options to axis context
  - `src/commands/run.ts`: builds tree from task file paths during setup phase, passes through to review
  - Graceful degradation: `review.ts` and `watch.ts` don't provide tree — axes work normally without it
  - 11 new tests (project-tree.test.ts), 444 tests total, typecheck clean, build succeeds (250.45 KB)

### Completed (Epic 20 — Prompt Extraction to Markdown)

- [x] Stories 20.1 + 20.2 + 20.3: Build-time .md imports + 6 prompt files + axis refactoring (2026-02-27)
  - `src/types/md.d.ts`: `declare module '*.md'` ambient type declaration
  - `tsup.config.ts`: added `esbuildOptions` with `.md` → `text` loader
  - `vitest.config.ts`: added `raw-md` vite plugin (readFileSync → export default)
  - 6 files in `src/core/axes/prompts/`: utility.system.md, duplication.system.md, correction.system.md, overengineering.system.md, tests.system.md, best-practices.system.md
  - All 6 axis files refactored: `buildXxxSystemPrompt()` now returns `import ... from './prompts/xxx.system.md'` + `.trimEnd()`
  - `RULES_TABLE` constant removed from best-practices.ts (now inline in .md)
  - Zero functional change: all 444 tests pass without modification, `toContain()` assertions still work
  - Bundle size: 251.43 KB (was 250.45 KB — +0.98 KB from import boilerplate)

### Epic 22 : README Badge Injection — Backlink organique post-audit
> Goal: Après un audit Anatoly réussi, un badge "Checked by Anatoly" est injecté de manière idempotente dans le README.md du projet cible, créant des backlinks organiques pour la découvrabilité et le SEO.

- [x] Story 22.1: Module badge.ts — Injection idempotente et configuration (2026-02-27)
  - `src/core/badge.ts`: `injectBadge()` + `buildBadgeMarkdown()`, idempotent via `<!-- checked-by-anatoly -->` markers
  - `src/schemas/config.ts`: `BadgeConfigSchema` with `enabled`, `verdict`, `link` fields added to `ConfigSchema`
  - `src/cli.ts`: `--no-badge` and `--badge-verdict` global flags registered
  - `src/commands/run.ts`: `injectBadge()` called post-report, respects CLI/config precedence
  - First-run hint: `badge added in README.md (disable with --no-badge)`, hidden on update
  - Edge cases: missing README (silent skip), read-only README (warn stderr), empty README, trailing newlines
  - `src/core/badge.test.ts`: 17 tests covering injection, update, skip, empty, newlines, read-only, custom link, idempotency
  - 479 tests total, typecheck clean, build succeeds (271.43 KB)

- [x] Story 22.2: Badges dynamiques selon le verdict d'audit (2026-02-27)
  - `buildBadgeMarkdown(verdict, includeVerdict, link)` supports 3 verdict colors: CLEAN=brightgreen, NEEDS_REFACTOR=yellow, CRITICAL=red
  - Config `badge.verdict: true` or CLI `--badge-verdict` enables verdict-aware badges
  - Fallback to static blue badge when `includeVerdict` is false or verdict is undefined
  - 7 verdict-specific tests in badge.test.ts (3 colors, 2 fallbacks, custom link, undefined verdict)
  - 479 tests total, typecheck clean, build succeeds (271.43 KB)

### Epic 23 : Observabilité & Logging structuré — Diagnostic à tout moment (v0.6.0)
> Goal: Remplacer l'infrastructure de logging ad-hoc (console.log, verboseLog, stderr writes) par un système centralisé avec pino, AsyncLocalStorage, niveaux granulaires, et logs JSON rotatifs. Le développeur peut diagnostiquer n'importe quel problème à tout moment.

- [x] Story 23.1: Logger centralisé — Module logger.ts et configuration (2026-02-27)
  - `src/utils/logger.ts`: pino v10.3.1, `createLogger()`, `initLogger()`, `getLogger()`, `resolveLogLevel()`, `createFileLogger()`
  - `src/schemas/config.ts`: `LoggingConfigSchema` with level/file/pretty fields
  - `src/cli.ts`: `--log-level <level>`, `--log-file <path>` global options with validation in preAction hook
  - Priority order: --log-level > --verbose > ANATOLY_LOG_LEVEL env > default warn
  - pino-pretty v13.1.3 (devDep) for TTY formatting
  - 15 tests in logger.test.ts

- [x] Story 23.2: Contexte automatique — AsyncLocalStorage et corrélation (2026-02-27)
  - `src/utils/log-context.ts`: AsyncLocalStorage, `runWithContext()`, `getLogContext()`, `contextLogger()`
  - Nested context merging (run > file > axis), concurrent worker isolation
  - 10 tests in log-context.test.ts

- [x] Story 23.3: Migration des commandes CLI — Remplacement de console.log/error (2026-02-27)
  - Replaced verboseLog() calls with getLogger().debug() in run.ts
  - Replaced process.stderr warnings with getLogger().warn() in file-evaluator.ts, badge.ts, hook.ts
  - verboseLog() marked @deprecated in format.ts (kept for backward compat)
  - CLI structural output (tables, summaries) intentionally kept as console.log

- [x] Story 23.4: Instrumentation du pipeline — Logging des phases et métriques (2026-02-27)
  - Info-level phase logs (scan, estimate, rag-index, review, report) with durationMs
  - RunContext tracks phaseDurations, totalCostUsd, errorCount, errorsByCode
  - run-metrics.json written to .anatoly/runs/<runId>/ with full metrics

- [x] Story 23.5: Instrumentation des modules core (2026-02-27)
  - Debug logs in scanner.ts, triage.ts, usage-graph.ts, axis-merger.ts, deliberation.ts, rag/orchestrator.ts
  - Trace-level LLM metrics in axis-evaluator.ts (model, tokens, cacheHitRate, costUsd, durationMs)

- [x] Story 23.6: Error boundary — Agrégation et rapport structuré (2026-02-27)
  - AnatolyError.toLogObject() for structured pino fields
  - Enhanced error logging in file-evaluator.ts with toLogObject()
  - Debug/warn retry logging in rate-limiter.ts (14 getLogger() uses)
  - End-of-run error summary aggregated by error code

- [x] Story 23.7: Log file routing — Persistance automatique sur disque (2026-02-27)
  - Per-run .anatoly/runs/<runId>/anatoly.ndjson at debug level via createFileLogger()
  - Log file path displayed in CLI completion summary

- [x] Story 23.8: Documentation et guide de diagnostic (2026-02-27)
  - README "Diagnostic Logging" section with levels table, usage examples, env var, per-run log file docs
  - Priority order documented

### Epic 24 : Embedding code direct & comparaison source-à-source (v0.7.0)
> Goal: Remplacer l'embedding texte (résumé Haiku + MiniLM) par un embedding code direct (nomic/jina + code source), supprimer l'appel LLM à l'indexation, et faire comparer du code contre du code dans le DuplicationEvaluator.

- [x] Story 24.1: Validation et intégration du modèle d'embedding code (2026-02-27)
  - nomic-embed-code-v1 non disponible en ONNX pour @xenova/transformers → fallback jinaai/jina-embeddings-v2-base-code (768-dim)
  - postinstall script mis à jour (scripts/download-model.js)

- [x] Story 24.2: Refonte du module d'embedding — code source direct (2026-02-27)
  - EMBEDDING_MODEL = jinaai/jina-embeddings-v2-base-code, EMBEDDING_DIM = 768
  - buildEmbedCode(name, signature, sourceBody) remplace buildEmbedText(card), truncation 1500 chars

- [x] Story 24.3: Simplification du schéma FunctionCard et de l'indexer (2026-02-27)
  - summary/keyConcepts/behavioralProfile → .optional() dans FunctionCardSchema
  - buildFunctionCards(task, source) sans llmCards, nouvelle extractFunctionBody()
  - embedCards(cards, source, symbols) embed le code source directement

- [x] Story 24.4: Suppression de l'appel Haiku à l'indexation (2026-02-27)
  - card-generator.ts supprimé (92 lignes), plus d'appel generateFunctionCards()
  - orchestrator.ts simplifié, indexModel deprecated, retryWithBackoff retiré

- [x] Story 24.5: Auto-migration de l'index vectoriel (2026-02-27)
  - VectorStore.init() détecte dimension mismatch via sample query, rebuild auto + vidage cache.json
  - Constructeur accepte onLog pour feedback utilisateur

- [x] Story 24.6: Injection du code source candidat dans le DuplicationEvaluator (2026-02-27)
  - readCandidateSource() lit ~50 lignes du candidat depuis le disque, fallback gracieux si fichier manquant
  - User message inclut signature + complexité + calledInternals + code source
  - duplication.system.md mis à jour pour comparaison code-à-code (règle 6)

- [x] Story 24.7: Calibration du seuil de similarité et tests de non-régression (2026-02-27)
  - minScore: 0.78 → 0.75, DUPLICATE threshold: 0.85 → 0.82, similarity-note: 0.75 → 0.68
  - scripts/calibrate-threshold.ts créé (206 lignes) pour benchmarks futurs

### Epic 25 : Clean — Ralph Integration for Automated Audit Remediation
> Goal: Ajouter `anatoly clean <report-file>` pour transformer un shard en artefacts Ralph, avec sync bidirectionnelle des checkboxes. Boucle fermée audit → clean → re-audit.
> Note: Implémenté sous les noms `clean`, `clean-sync`, `clean-run` (au lieu de `fix`, `fix-sync`).

- [x] Story 25.1: Checkboxes dans le rendu des rapports (2026-03-16)
  > Implémenté dans reporter.ts : `generateActionId()`, `- [ ] <!-- ACT-... -->` dans shards et checklist agrégée.

- [x] Story 25.2: Commande `anatoly clean <report-file>` (2026-03-16)
  > Implémenté dans clean.ts : parsing checkboxes, génération prd.json + CLAUDE.md + progress.txt dans `.anatoly/clean/<shard>/`.
  > Bonus: adaptive PRD (reprioritize, discovered stories, skip), anti-placeholder rules, codebase patterns section.

- [x] Story 25.3: Commande `anatoly clean-sync <report-file>` (2026-03-16)
  > Implémenté dans clean-sync.ts : sync prd.json → checkboxes shard + checkbox shard dans report.md.

- [x] Story 25.4: Sync de la Checklist agrégée dans report.md (2026-03-16)
  > Intégré dans clean-sync.ts : sync actions dans la section Checklist de report.md par matching `<!-- ACT-xxx-N -->`.

- [x] Story 25.5: Tests et documentation (2026-03-16)
  > Tests dans clean-sync.test.ts, clean-run.test.ts, clean-runs.test.ts. Commandes clean, clean-sync, clean-run listées dans --help.
  > Bonus: clean-run.ts intègre la boucle Ralph en TypeScript avec circuit breaker, rollback git, et 15min timeout par itération.

### Epic 25b : Sélection d'axes au runtime via `anatoly run` (ad-hoc, pas d'epic BMAD formel)
> Goal: Permettre de cibler un sous-ensemble d'axes d'évaluation via `--axes` sur `run`, `review` et `watch`. Par défaut, tous les axes activés dans la config sont exécutés.

- [x] Story 25b.1: Option `--axes` sur la commande `run` (2026-03-15)
  > Ajouter `--axes <list>` (comma-separated) à `run`, valider contre ALL_AXIS_IDS, filtrer les évaluateurs.

- [x] Story 25b.2: Propager `--axes` aux commandes `review` et `watch` (2026-03-15)
  > Même option sur `review` et `watch`, logique extraite dans un helper partagé `parseAxesFilter()`.

- [x] Story 25b.3: Tests parseAxesFilter et intégration (2026-03-15)
  > Tests unitaires pour parseAxesFilter + intégration getEnabledEvaluators avec filtre.

### Epic 26 : Documentation Axis — Audit de la couverture documentaire
> Goal: 7ème axe d'analyse qui détecte les lacunes et désynchronisations entre le code et la documentation. Deux niveaux : JSDoc inline (per-symbol) et couverture /docs/ (per-concept). Ralph traite les corrections via sa boucle standard.

- [x] Story 26.1: Fondations — Schemas, docs-resolver et system prompt
  > Étendre AxisId, AxisContext, SymbolReviewSchema, AxesConfigSchema, ConfigSchema. Créer docs-resolver.ts et documentation.system.md.
  > AC: Given `src/core/axis-evaluator.ts`, When AxisId inspecté, Then contient 'documentation'.
  > AC: Given `src/schemas/review.ts`, When SymbolReviewSchema inspecté, Then contient `documentation: z.enum(['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED', '-'])`.
  > AC: Given `src/core/docs-resolver.ts`, When `buildDocsTree()` appelé sur projet sans /docs/, Then retourne null.
  > AC: Given `src/core/docs-resolver.ts`, When `resolveRelevantDocs()` appelé, Then résout via config mapping (prioritaire) puis convention (fallback), max 3 pages × 300 lignes.
  > AC: Given `npm run typecheck && npm run build && npm run test`, Then tout passe.
  > Spec: _bmad-output/implementation-artifacts/26-1-fondations-schemas-resolver-prompt.md

- [x] Story 26.2: Core Integration — Evaluateur, merger, orchestrateur, registre, reporter
  > DocumentationEvaluator (Haiku), merger coherence + actions, docsTree via EvaluateFileOptions, registry, reporter `doc` column + Documentation Coverage section.
  > AC: Given un fichier avec symboles exportés sans JSDoc, When l'axe documentation s'exécute, Then findings UNDOCUMENTED avec actions générées.
  > AC: Given `utility=DEAD` sur un symbole, When coherence rules appliquées, Then `documentation=UNDOCUMENTED`.
  > AC: Given le report généré, When inspecté, Then contient colonne `doc` et section "Documentation Coverage" avec score %.
  > AC: Given `npm run typecheck && npm run build && npm run test`, Then tout passe.
  > Spec: _bmad-output/implementation-artifacts/26-2-core-integration-evaluator-merger-reporter.md

- [x] Story 26.3: Documentation Meta — L'axe se documente lui-même
  > Renommer Six-Axis → Seven-Axis dans /docs/, ajouter DocumentationEvaluator section, mettre à jour PRD et config docs.
  > AC: Given `docs/02-Architecture/`, When inspecté, Then contient `02-Seven-Axis-System.md` avec section documentation.
  > AC: Given PRD Section 6.1, When inspecté, Then contient 7 axes incluant documentation.
  > Spec: _bmad-output/implementation-artifacts/26-3-documentation-meta.md

- [x] Story 26.4: Adversarial Code Review — Validation complète de l'Epic 26
  > Review adversariale BMAD : challenger chaque [x], vérifier chaque AC contre le code, trouver 3-10 issues, fixer HIGH/MEDIUM.
  > AC: Given les 3 stories complètes, When chaque claim vérifié contre git + code, Then aucune tâche [x] non implémentée, aucun AC manquant.
  > AC: Given `npm run typecheck && npm run build && npm run test`, Then tout passe après fixes.
  > AC: Given un run anatoly sur un scope de test, Then 6 axes existants OK + documentation axis produit des findings.
  > Spec: _bmad-output/implementation-artifacts/26-4-adversarial-code-review.md

## Notes
- **Epic 25b DONE:** axes-filter.ts created, parseAxesOption + warnDisabledAxes exported, --axes option on run/review/watch
- **Epic 26 dependency order:** 27.1 → 27.2 → 27.3 (27.3 can start in parallel with 27.2 for doc-only tasks)
- **Epic 26 files impacted:** ~15 files (3 new: documentation.ts, docs-resolver.ts, documentation.system.md; 12 modified: axis-evaluator.ts, review.ts, config.ts, axis-merger.ts, file-evaluator.ts, run.ts, axes/index.ts, reporter.ts, plus 4 docs files)
- **Epic 26 model:** Haiku for documentation axis (cost ~$0.001/file, <5% increase)
- **Epic 26 key patterns:** Follow utility.ts for simple evaluator, best-practices.ts for _bestPractices custom field pattern, tests.ts for enriched context injection
- **Epic 25 DONE:** Renamed fix→clean. Files: clean.ts, clean-sync.ts, clean-run.ts, reporter.ts. Bonus: clean-run.ts = boucle Ralph native TypeScript avec circuit breaker + rollback git + adaptive PRD.
- **Epic 19 dependency order:** 19.1 + 19.2 (parallel) → 19.3 + 19.4 + 19.5 (parallel) → 19.6 → 19.7
- **No coexistence** with old pipeline — direct replacement (not in production)
- **All axes are single-turn, no Agent SDK tools** — data pre-computed (usage graph, RAG)
- **Model differentiation:** haiku for utility/duplication/overengineering/tests, sonnet for correction/best_practices
- **Epic 22:** Standalone module, zero deps on pipeline internals. Integration point = post-report in run.ts. Files: badge.ts (create), badge.test.ts (create), config.ts (modify), cli.ts (modify), run.ts (modify)
- **Epic 23 dependency order:** 23.1 → 23.2 → 23.3 + 23.4 + 23.5 + 23.6 (parallel) → 23.7 → 23.8
- **Epic 23 deps:** pino (runtime), pino-pretty (devDep). ~25-30 files impacted. Zero breaking changes (--verbose preserved).
- **Epic 23 tech choices:** pino (fastest Node.js logger), AsyncLocalStorage (native Node.js), pino/file (non-blocking), pino-pretty (dev TTY)
- **Epic 24 dependency order:** 24.1 → 24.2 → 24.3 → 24.4 → 24.5, and 24.3 → 24.6 → 24.7
- **Epic 24 model choice:** jinaai/jina-embeddings-v2-base-code (768-dim). nomic-embed-code-v1 not available as ONNX for @xenova/transformers — fallback used as planned.
- **Epic 24 key insight:** Current DuplicationEvaluator only sees candidate `summary` text, NOT actual code. Story 24.6 fixes this by reading candidate source from disk.
- **Epic 24 migration:** Auto-rebuild if dim mismatch detected in VectorStore.init(). First run after upgrade will be slower (full reindex), subsequent runs use cache normally.
- **Epic 24 deps:** No new npm deps — @xenova/transformers already present, only ONNX model changes. card-generator.ts deleted.
- **Epic 24 threshold:** Current 0.78 calibrated for MiniLM on text. Code models produce different score distributions — start at 0.75, calibrate in 24.7.
