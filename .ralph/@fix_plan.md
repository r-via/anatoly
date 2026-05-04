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
  > As a utilisateur
  > I want à la fin du setup phase pouvoir relire ma config avant de lancer un audit qui coûte du LLM
  > So that je peux corriger une typo ou changer d'avis sans frais.
  > AC: Given le setup phase est terminé (scan/estimate/triage done), And `process.stdin.isTTY === true`, And `--defaults-settings` n'est pas set, When le `waitForEnter()` actuel serait appelé, Then à la place, un `p.select` est affiché avec 3 options :, "Proceed with audit" (pré-sélectionné), "Open `.anatoly.yml`", "Quit"
  > AC: Given "Proceed with audit" est choisi, When la wizard termine, Then le run continue normalement (review phase démarre)
  > AC: Given "Open `.anatoly.yml`" est choisi, When la wizard termine, Then `openFile(resolve(projectRoot, '.anatoly.yml'))` est appelé (utilitaire existant [src/utils/open.ts](src/utils/open.ts)), And si `openFile()` réussit, un message `"Opened in editor — run anatoly run again when ready"` est affiché, And si `openFile()` échoue (pas d'éditeur configuré, env headless), le path est imprimé + le contenu du YAML cat à stdout, And le process exit 0
  > AC: Given "Quit" est choisi, When la wizard termine, Then un message `"Configuration saved to .anatoly.yml — run anatoly run when ready"` est affiché, And le process exit 0
  > AC: Given `--defaults-settings` est set OU non-TTY, When le setup phase est terminé, Then le prompt n'est pas affiché, And le run continue directement vers review (auto-proceed)
  > AC: Given `Ctrl+C` est appuyé sur le prompt, When `p.isCancel(choice)` retourne `true`, Then le process exit 0 (équivalent Quit)
  > Spec: specs/planning-artifacts/epic-48-first-run-unified-onboarding.md#story-48-6
- [ ] Story 48.7: `--defaults-settings` flag + cleanup hint detector
  > As a utilisateur en CI ou en script
  > I want pouvoir lancer `anatoly run` sans aucun prompt
  > So that mon pipeline ne bloque pas en attente d'input.
  > AC: Given `--defaults-settings` est passé à `anatoly run`, When le run démarre, Then `runFirstRunWizard()` skip le prompt tier (auto-pick lite), And `runEndOfSetupPrompt()` skip le 3-choice (auto-proceed), And un log info `"running with default settings (no prompts)"` est émis
  > AC: Given `process.stdin.isTTY === false`, When le run démarre, Then le comportement est identique à `--defaults-settings` (implicit)
  > AC: Given la nouvelle wizard est en place, When le hint detector est appelé ([src/cli/hint-detector.ts:79-88](src/cli/hint-detector.ts#L79-L88)), Then la condition `no-init` est retirée, And les tests associés dans [src/cli/hint-detector.test.ts](src/cli/hint-detector.test.ts) sont supprimés ou adaptés
  > AC: Given un `.anatoly/hints-dismissed.json` contient `"no-init"` (legacy), When le hint detector charge les dismissals, Then l'entrée est ignorée silencieusement (pas d'erreur, pas de migration)
  > Spec: specs/planning-artifacts/epic-48-first-run-unified-onboarding.md#story-48-7
- [ ] Story 48.8: Quick Win runtime filter + summary suggestion
  > As a utilisateur ayant choisi Quick Win
  > I want que mon premier audit soit rapide en limitant les axes et en sautant la bootstrap doc
  > So that je vois un premier résultat en moins d'une minute et je décide ensuite si je veux le full run.
  > AC: Given `runFirstRunWizard()` retourne `{ mode: 'quick-win' }` (story 48.1), When la phase setup termine et le run continue vers review, Then `ctx.axesFilter` est forcé à `['utility', 'duplication', 'correction']` (override l'éventuel `--axes` CLI), And `ctx.skipDocBootstrap = true` (champ ajouté à `RunContext`)
  > AC: Given `ctx.skipDocBootstrap === true`, When le code consomme `needsBootstrap(srcRoot)` ([src/commands/run.ts:490](src/commands/run.ts#L490)), Then la bootstrap doc phase est court-circuitée (treated as if `needsBootstrap` returned false), And la pipeline row `internal docs` affiche `'skipped (quick-win mode)'`
  > AC: Given un run Quick Win se termine avec succès, When la summary CLI est rendue ([src/commands/run.ts:2182](src/commands/run.ts#L2182)), Then une ligne supplémentaire est imprimée :, ```, 💡 Ran in quick-win mode (3 axes, no docs)., Run `anatoly run` again for the full audit (7 axes + doc analysis)., ```, And la ligne est en couleur dim (chalk.dim)
  > AC: Given `--quick-win` est passé en CLI sur un projet déjà configuré (avec `.anatoly.yml`), When le run démarre, Then la wizard est skippée (déjà configuré), And `ctx.axesFilter` et `ctx.skipDocBootstrap` sont forcés comme en first-run quick-win, And la summary suggestion s'affiche également
  > AC: Given le mode est `'full-run'`, When le run continue, Then aucun override n'est appliqué (`ctx.axesFilter` respecte le CLI / config, `ctx.skipDocBootstrap = false`), And la summary ne contient pas la suggestion quick→full
  > AC: Given un run Quick Win échoue (interrupt, crash), When la summary serait affichée, Then la suggestion quick→full n'est pas affichée (réservée aux runs réussis pour ne pas bruiter la trace d'erreur)
  > AC: Given la combinaison `--quick-win --no-triage`, When le run démarre, Then la combinaison est tolérée (les deux flags s'appliquent indépendamment)
  > Spec: specs/planning-artifacts/epic-48-first-run-unified-onboarding.md#story-48-8
### First-run Polish

- [ ] Story 49.1: Recovery messages actionnables pour failures de download
  > As a utilisateur dont le download échoue
  > I want comprendre **pourquoi** ça a échoué et avoir une voie de sortie immédiate
  > So that je ne suis pas bloqué avec un stack trace cryptique.
  > AC: Given un download (lite ou GGUF) échoue avec une erreur classée comme "network", When le handler de recovery est invoqué, Then un `p.note` affiche : `"Network unreachable. Anatoly couldn't download embedding models."`, And un `p.select` propose : `"Retry download"` / `"Continue in lite mode (skip advanced)"` / `"Quit"`
  > AC: Given une erreur ENOSPC (disk full) est détectée, When le handler de recovery est invoqué, Then le message indique l'espace nécessaire vs disponible (`"Need ~15 GB in ~/.anatoly/models — currently 3 GB free"`), And les choix sont : `"I freed space — retry"` / `"Continue in lite mode"` / `"Quit"`
  > AC: Given Docker est installé mais le daemon ne répond pas (subprocess setup-embeddings advanced), When le handler détecte l'erreur Docker, Then le message propose : `"Docker daemon not running. Try: sudo systemctl start docker"`, And les choix sont : `"Retry"` / `"Continue in lite mode"` / `"Quit"`
  > AC: Given un SHA256 mismatch est détecté après download, When le handler de recovery est invoqué, Then le fichier corrompu est supprimé automatiquement, And un `p.confirm` propose : `"File corrupt. Re-download?"`
  > AC: Given le user choisit "Continue in lite mode" sur n'importe quel scenario, When la wizard reprend la main, Then `tier` est forcé à `'lite'`, And `prefetchLiteModels()` est tenté (si pas déjà fait), And le run continue
  > AC: Given `--defaults-settings` est set, When un download échoue, Then aucun prompt n'est affiché, And le fallback automatique vers lite est appliqué (avec warn loggé)
  > Spec: specs/planning-artifacts/epic-49-first-run-polish.md#story-49-1
- [ ] Story 49.2: Cross-project preferences via `~/.anatoly/preferences.yml`
  > As a user qui audite plusieurs projets
  > I want que mon choix lite/advanced soit mémorisé entre projets
  > So that je ne ré-réponde pas la même question à chaque nouveau repo.
  > AC: Given un user choisit "Advanced" pour la première fois, When la story 48.1 termine avec succès (downloads + setup OK), Then `~/.anatoly/preferences.yml` est écrit avec `embeddings: { prefer: 'advanced' }`
  > AC: Given `~/.anatoly/preferences.yml` contient `embeddings.prefer: 'advanced'`, And le hardware actuel a un GPU CUDA + ≥ 12 GB VRAM, When un nouveau first-run démarre dans un autre projet, Then le prompt tier est skippé, And un log info `"Using saved preference: advanced (override with --rag-lite)"` est émis, And le tier `advanced` est appliqué silencieusement
  > AC: Given la préférence est `'advanced'`, And le hardware actuel n'a pas de GPU CUDA (ou < 12 GB VRAM), When un new first-run démarre, Then le prompt tier est ré-affiché, And une note explique : `"Your saved preference (advanced) isn't supported here — falling back to default."`
  > AC: Given `--rag-lite` ou `--rag-advanced` est passé en CLI, When un first-run démarre, Then la préférence est ignorée pour ce run (le flag prime), And la préférence n'est pas ré-écrite (elle reste celle du choix initial)
  > AC: Given `~/.anatoly/preferences.yml` est corrompu (YAML invalide), When la wizard tente de le lire, Then un warn est loggé, And le fichier est ignoré (le prompt tier est ré-affiché)
  > AC: Given la wizard veut écrire la préférence, When `mkdirSync(homedir() + '/.anatoly', { recursive: true })` échoue, Then un warn est loggé (`"Could not save preference"`), And le run continue normalement (best-effort)
  > Spec: specs/planning-artifacts/epic-49-first-run-polish.md#story-49-2
- [ ] Story 49.3: Transition visuelle setup → audit
  > As a utilisateur qui passe du setup à l'audit
  > I want voir une démarcation claire entre les deux phases
  > So that je sais que l'onboarding est terminé et que les LLM calls vont démarrer.
  > AC: Given le user choisit "Proceed with audit" dans le 3-choice, When la wizard termine, Then un séparateur visuel est imprimé (`────────────────────────────`), And sur la ligne suivante, un banner court est affiché : `"The weight is good !  Starting audit..."`, And une ligne vide est ajoutée avant le démarrage de la review phase
  > AC: Given `--defaults-settings` est set, When le setup termine et le run continue, Then la transition visuelle est tout de même affichée (sauf si `--plain`, voir Story 49.6)
  > AC: Given `--plain` est set, When la transition serait affichée, Then un simple `"--- starting audit ---"` est imprimé à la place du séparateur graphique
  > AC: Given la fonction `printBanner('The weight is good !')` existe déjà ([src/utils/banner.ts](src/utils/banner.ts)), When la transition est implémentée, Then elle réutilise `printBanner` pour cohérence visuelle (pas de duplication de l'ASCII art)
  > Spec: specs/planning-artifacts/epic-49-first-run-polish.md#story-49-3
- [ ] Story 49.4: Post-audit progressive education hint
  > As a user qui vient de finir son premier audit en mode lite sur du hardware capable d'advanced
  > I want apprendre que je peux faire mieux la prochaine fois
  > So that je découvre l'option advanced **après** avoir vu la valeur d'un audit complet, pas avant.
  > AC: Given un audit s'est terminé avec succès (pas d'interrupt, pas de crash), And `ctx.resolvedRagMode === 'lite'`, And le hardware a un GPU CUDA + ≥ 12 GB VRAM, And le hint `lite-rag-can-upgrade-post-audit` n'est pas dans `.anatoly/hints-dismissed.json`, When `generateReport()` termine, Then un `p.note` est affiché juste avant le summary CLI :, ```, 💡 Your hardware could run advanced embeddings (~30% better recall, ~15 GB disk)., Run `anatoly setup-embeddings` when you want to try it., ```, And le hint est marqué dismissed dans `hints-dismissed.json`
  > AC: Given l'audit a crashé ou a été interrupt, When le post-audit handler tourne, Then le hint d'éducation n'est pas affiché
  > AC: Given le user a déjà vu le hint une fois (dismissed.json contient l'entrée), When un nouvel audit termine, Then le hint n'est pas re-affiché
  > AC: Given `--defaults-settings` ou `--plain`, When l'audit termine, Then le hint est affiché en log info (pas de `p.note`)
  > Spec: specs/planning-artifacts/epic-49-first-run-polish.md#story-49-4
- [ ] Story 49.5: Privacy/transparency notice dans le prompt tier
  > As a user privacy-conscious
  > I want savoir où vont mes données avant de cliquer sur "Default"
  > So that je peux décider en connaissance de cause sans aller fouiller la doc.
  > AC: Given la story 48.1 affiche le prompt tier, When le rendu est construit, Then une ligne de transparence est ajoutée juste au-dessus du `p.select` :, ```, ℹ Anatoly sends code chunks to your configured LLM provider only. No telemetry., ```, And la ligne est en couleur dim (gris discret, pas dominant)
  > AC: Given la ligne de transparence est affichée, When un test snapshot est lancé sur le rendu du prompt, Then le snapshot contient la ligne textuelle (pas de regression silencieuse)
  > AC: Given `--plain` ou `NO_COLOR`, When le prompt est rendu, Then la ligne reste affichée (sans `chalk.dim`)
  > Spec: specs/planning-artifacts/epic-49-first-run-polish.md#story-49-5
- [ ] Story 49.6: Plain-mode parity pour le tableau comparatif tier
  > As a CI ou un user en environnement headless / piped
  > I want que la sortie reste lisible quand box-drawing chars et ANSI sont indésirables
  > So that mes logs CI sont copy-pasteables et mon screen reader fonctionne.
  > AC: Given `--plain` est set OU `NO_COLOR` est dans l'env OU `process.stdout.isTTY === false`, When le tableau comparatif tier est rendu, Then le tableau utilise du texte simple sans box-drawing :, ```, Embeddings setup:, default   ONNX CPU       150 MB    instant   good recall, advanced  GGUF GPU       15 GB     2-5 min   best recall (recommended for this hardware), ```, And aucun caractère Unicode autre que ASCII n'est utilisé, And aucun escape ANSI n'est émis
  > AC: Given le mode TTY-color normal, When le tableau est rendu, Then le tableau Unicode existant (avec box chars + couleurs) est utilisé (comportement Story 48.1 inchangé)
  > AC: Given un test pipe la sortie : `anatoly run | cat`, When le snapshot est comparé, Then la sortie reste lisible et structurée (pas de chars cassés, pas de séquences ANSI résiduelles)
  > AC: Given un screen reader est utilisé, When le tableau plain est lu, Then chaque ligne est interprétable indépendamment (clé/valeurs séparées par espaces, pas de chars décoratifs)
  > Spec: specs/planning-artifacts/epic-49-first-run-polish.md#story-49-6

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
