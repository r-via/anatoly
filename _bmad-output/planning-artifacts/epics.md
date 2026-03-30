---
stepsCompleted: [1, 2, 3, 4]
status: 'complete'
completedAt: '2026-02-23'
updatedAt: '2026-03-30'
updateReason: 'Epic 34 — Prompt Reinforcement (audit, edge cases, guard rails, schema injection, gold-set testing)'
inputDocuments:
  - _bmad-output/planning-artifacts/PRD.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
---

# anatoly - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for anatoly, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: CLI avec sous-commandes : `run`, `scan`, `estimate`, `review`, `report`, `watch`, `status`, `clean-logs`, `reset`
FR2: Pipeline orchestré par `run` : scan → estimate → review → report, sans intervention utilisateur
FR3: Parsing AST complet via tree-sitter-typescript (TS + TSX) — extraction des symboles exportés (nom, kind, lignes, exported)
FR4: Hash SHA-256 par fichier pour cache déterministe — 0$ sur fichiers inchangés
FR5: Intégration coverage Istanbul/Vitest/Jest (format JSON natif)
FR6: Détection automatique de monorepo (workspaces Yarn/PNPM/Nx/Turbo, multiples tsconfig)
FR7: Génération de fichiers `.task.json` par fichier (AST + hash + metadata coverage) + mise à jour `progress.json`
FR8: Estimation de scope via tiktoken — tokens input/output + temps estimé, zéro appel LLM
FR9: Agent Claude (Agent SDK) avec accès outils filesystem (grep, read_file, search) pour chaque fichier audité
FR10: 6 axes d'analyse : utility, duplication, correction, overengineering, tests, best_practices + confidence score (0-100) par symbole. Chaque axe activable/désactivable individuellement via config.
FR11: Validation Zod stricte du résultat de review avec retry automatique (max 3) et feedback ZodError
FR12: Dual output par fichier : `.rev.json` (machine) + `.rev.md` (humain)
FR13: Transcripts complets du raisonnement de l'agent sauvegardés en Markdown (stream temps réel, append incrémental)
FR14: Rapport agrégé `report.md` : résumé exécutif, tableaux triés par sévérité, dead code list, duplications groupées, actions priorisées
FR15: Mode watch via chokidar : re-scan + re-review incrémental des fichiers modifiés uniquement
FR16: Configuration via `.anatoly.yml` (include, exclude, coverage, llm, timeout)
FR17: Options CLI globales : `--config`, `--verbose`, `--no-cache`, `--file <glob>`, `--plain`, `--no-color`
FR18: Commande `status` : afficher l'état courant du pipeline (progress.json)
FR19: Commande `clean-logs` : nettoyer les transcripts
FR20: Commande `reset` : réinitialiser le cache et les reviews

### NonFunctional Requirements

NFR1: Philosophie zéro faux positif — confidence score obligatoire sur chaque finding
NFR2: Faux positifs DEAD < 3%
NFR3: Validation Zod première passe > 97%
NFR4: Deuxième run sur codebase inchangée < 4s et 0$
NFR5: Temps moyen premier rapport < 45 min
NFR6: Timeout par fichier : 180 secondes max
NFR7: Distribution npx (zéro install)
NFR8: Ne jamais toucher au code source (lecture seule absolue)
NFR9: Zéro interruption — `npx anatoly run` tourne de bout en bout sans confirmation

### Additional Requirements

**Architecture :**
- Starter template : From scratch avec Commander.js + @commander-js/extra-typings
- Build avec tsup (esbuild), dev runner tsx, tests Vitest, lint ESLint
- AST Parser : web-tree-sitter (WASM) — zéro compilation native, npx sans friction
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) pour interaction LLM
- Stratégie séquentielle v1 (un fichier à la fois)
- `progress.json` pour état du pipeline avec statuts PENDING/IN_PROGRESS/DONE/TIMEOUT/ERROR/CACHED
- Lock file (`.anatoly/lock` avec PID + timestamp) pour protection double instance
- Écriture atomique (tmp + rename) pour `progress.json`
- Exit codes : 0 (clean), 1 (findings), 2 (erreur technique)
- Gestion SIGINT (Ctrl+C) : arrêt propre + résumé partiel + reviews intactes + cache reprise
- AnatolyError class + codes standardisés (CONFIG_INVALID, LLM_TIMEOUT, ZOD_VALIDATION_FAILED, etc.)
- Convention nommage fichiers output : slashes → tirets, extension retirée
- Hiérarchie de dépendance : schemas → utils → core → commands
- Tests co-located, exports nommés uniquement, kebab-case fichiers

**UX Design :**
- Rendu terminal deux zones : zone fixe (log-update, ré-écrite en place) + zone flux (append-only, scroll linéaire)
- Progression temps réel : spinner ora + barre de progression Unicode + compteurs de findings
- Verdicts colorés : vert (CLEAN), jaune (DEAD/DUP/OVER), rouge (CRITICAL/ERR)
- Message de complétion sobre : 3 lignes avec chemins alignés (report, reviews, transcripts)
- Estimation affichée en tokens et temps, pas en prix
- Reviews `.rev.md` consultables en temps réel pendant que le scan continue
- Rapport final non affiché dans le terminal — juste les chemins
- Zéro config au premier lancement — détection automatique du projet
- Détection auto du mode plain (pipe/CI via `process.stdout.isTTY`)
- Accessibilité : `--no-color`, `--plain`, fallback Unicode → ASCII

### FR Coverage Map

| FR | Epic | Description |
|----|------|-------------|
| FR1 | Epics 1-7 | Structure CLI répartie sur tous les epics (chaque commande dans son epic) |
| FR2 | Epic 5 | Pipeline orchestré par `run` |
| FR3 | Epic 1 | Parsing AST tree-sitter |
| FR4 | Epic 1 | Hash SHA-256 + cache |
| FR5 | Epic 1 | Intégration coverage |
| FR6 | Epic 1 | Détection monorepo |
| FR7 | Epic 1 | Génération .task.json + progress.json |
| FR8 | Epic 2 | Estimation tiktoken |
| FR9 | Epic 3 | Agent Claude SDK |
| FR10 | Epic 3 | 5 axes d'analyse + confidence |
| FR11 | Epic 3 | Validation Zod + retry |
| FR12 | Epic 3 | Dual output .rev.json + .rev.md |
| FR13 | Epic 3 | Transcripts Markdown |
| FR14 | Epic 4 | Rapport agrégé report.md |
| FR15 | Epic 7 | Mode watch chokidar |
| FR9, FR11 | Epic 8 | RAG sémantique cross-file (corrections + pre-resolved) |
| FR2, FR9 | Epic 10 | Parallélisation des reviews (concurrency pool) |
| FR16 | Epic 1 | Configuration .anatoly.yml |
| FR17 | Epic 5 | Flags CLI globaux |
| FR18 | Epic 6 | Commande status |
| FR19 | Epic 6 | Commande clean-logs |
| FR20 | Epic 6 | Commande reset |
| FR9, FR10, FR16 | Epic 11 | Boucle d'autocorrection Claude Code (review background + hook Stop) |
| FR2, FR9 | Epic 12 | Parallélisation de l'indexation RAG (concurrence Haiku) |
| FR2, FR17 | Epic 15 | Migration renderer CLI vers listr2 (remplace renderer custom) |
| FR10, FR11 | Epic 21 | Opus Deliberation Pass — validation post-merge inter-axes |
| FR10, FR11 | Epic 34 | Prompt Reinforcement — audit, guard rails, calibration, schema injection |

## Epic List

> **Status as of v0.9.1 (March 2026):** Epics 1-34, 37-43 are **Done**. Epics 1-7 shipped in v0.1.0, Epic 8 in v0.2.0, Epics 9-13/15-20 in v0.3.0, Epics 14/21-23 in v0.4.0, Epic 24 in v0.5.0, Epic 25 in v0.6.0, Epics 26-34 in v0.7.0-v0.8.x, Epics 37-43 (Gemini transport, multi-provider) in v0.9.x. **Draft:** Epic 27 (RAG Dual-Vector Docs), Epic 28 (Tiered Embedding), Epic 44 (User Instructions), Epic 45 (Telegram Notifications), Epic 46 (Transport-Level Resilience).

### Epic 1 : Fondation du projet et scan du codebase — **Done** (v0.1.0)
### Epic 2 : Estimation du scope d'audit — **Done** (v0.1.0)
### Epic 3 : Review agentique fichier par fichier — **Done** (v0.1.0)
### Epic 4 : Rapport agrégé et actionnable — **Done** (v0.1.0)
### Epic 5 : Pipeline complet et expérience CLI — **Done** (v0.1.0)
### Epic 6 : Commandes utilitaires — **Done** (v0.1.0)
### Epic 7 : Mode watch (surveillance continue) — **Done** (v0.1.0)
### Epic 8 : RAG sémantique cross-file — **Done** (v0.2.0)
### Epic 9 : Améliorations UX/DX post-v0.2.0 — **Done** (v0.3.0)
### Epic 10 : Parallélisation des reviews — **Done** (v0.3.0)
### Epic 11 : Boucle d'autocorrection Claude Code — **Done** (v0.3.0)
### Epic 12 : Parallélisation de l'indexation RAG — **Done** (v0.3.0)
### Epic 13 : Audit complet de conformité — **Done** (v0.3.0)
### Epic 14 : Codebase Hygiene — **Done** (v0.4.0)
### Epic 15 : Migration du renderer CLI vers listr2 — **Done** (v0.3.0)
### Epic 16 : Intelligence pré-review — Triage & Graphe d'usage — **Done** (v0.3.0)
### Epic 17 : Fast review sans tools — **Done** (v0.3.0)
### Epic 18 : Report shardé avec index à checkboxes — **Done** (v0.3.0)
### Epic 19 : Contexte structurel — Arborescence projet — **Done** (v0.3.0)
### Epic 20 : Extraction des prompts en Markdown — **Done** (v0.3.0)
### Epic 21 : Opus Deliberation Pass — **Done** (v0.4.0)
### Epic 22 : README Badge Injection — **Done** (v0.4.0)
### Epic 23 : Observabilité & Logging structuré — **Done** (v0.4.0)
### Epic 24 : Code Embedding — Modèles d'embedding locaux — **Done** (v0.5.0)
### Epic 25 : Ralph Integration — Automated Audit Remediation — **Done** (v0.6.0)
### Epic 26 : Documentation Axis — **Done** (v0.7.0)
### Epic 27 : RAG Dual-Vector for Documentation — **Draft**
### Epic 28 : Tiered Embedding Backend — GGUF/Docker acceleration — **Draft**
### Epic 29 : Doc Scaffolding — Génération automatique de `/docs/` — **Done** (v0.8.0)
### Epic 30 : SDK Semaphore — Concurrence bornée des appels API — **Done** (v0.8.0)
### Epic 31 : Multi-Language — Support multi-langage (Go, Python, Rust, etc.) — **Done** (v0.8.0)
### Epic 32 : Adversarial Review — Process de review adversariale automatisée — **Done** (v0.8.0)
### Epic 33 : Prompt Fixes — Corrections adversariales des prompts — **Done** (v0.8.1)
### Epic 34 : Prompt Reinforcement — Guard rails, calibration, gold-set testing — **Done** (v0.8.1)
### Epic 37 : LLM Transport — Interface `LlmTransport`, `AnthropicTransport`, `GeminiTransport` — **Done** (v0.9.0)
### Epic 38 : Gemini Routing — Router axes mécaniques vers Gemini Flash — **Done** (v0.9.0)
### Epic 39 : Gemini NLP — Router summarization NLP vers Gemini — **Done** (v0.9.0)
### Epic 40 : Gemini GenAI SDK — Transport API key via `@google/genai` — **Done** (v0.9.0)
### Epic 41 : Refinement 3-Tier — Pipeline de délibération post-run — **Done** (v0.9.1)
### Epic 42 : Config Restructuring — Séparation providers/models/agents/axes/runtime — **Done** (v0.9.1)
### Epic 43 : Multi-Provider Migration — Vercel AI SDK, prefixes provider, TransportRouter mode-aware — **Done** (v0.9.1)
### Epic 44 : User Instructions — Calibration personnalisée via `ANATOLY.md` — **Draft**
### Epic 45 : Telegram Notifications — Alertes post-run — **Draft**
### Epic 46 : Transport-Level Resilience — Semaphores & circuit breakers dans le router — **Draft** (ADR dans architecture.md)

---

## Epic 1 : Fondation du projet et scan du codebase
**Status: Done** (v0.1.0)

Le développeur peut scanner son projet TypeScript et obtenir une cartographie complète de ses fichiers (AST, symboles, hashes, coverage).

### Story 1.1 : Initialisation du projet et structure CLI

As a développeur,
I want installer Anatoly via npx et voir les commandes disponibles,
So that je puisse commencer à utiliser l'outil sur mon projet.

**Acceptance Criteria:**

**Given** un projet Node.js avec un `package.json`
**When** je lance `npx anatoly --help`
**Then** la liste des sous-commandes disponibles (scan, estimate, review, report, run, watch, status, clean-logs, reset) est affichée
**And** les options globales (--config, --verbose, --no-cache, --file, --plain, --no-color) sont listées

**Given** le projet anatoly est initialisé
**When** je consulte la structure du projet
**Then** les dossiers `src/commands/`, `src/core/`, `src/schemas/`, `src/utils/` existent avec leurs barrel exports
**And** tsup, vitest, eslint et typescript sont configurés
**And** le `package.json` contient `"bin": { "anatoly": "./dist/index.js" }` et `"type": "module"`

### Story 1.2 : Schémas Zod et gestion d'erreurs

As a développeur d'Anatoly,
I want des schémas Zod comme source de vérité et un système d'erreurs standardisé,
So that tous les composants partagent un contrat de données strict et des erreurs cohérentes.

**Acceptance Criteria:**

**Given** les fichiers de schémas dans `src/schemas/`
**When** je consulte `review.ts`, `task.ts`, `config.ts`, `progress.ts`
**Then** les schémas Zod sont définis conformément au PRD (ReviewFileSchema, TaskSchema, ConfigSchema, ProgressSchema)
**And** les types TypeScript sont inférés via `z.infer<>`

**Given** le fichier `src/utils/errors.ts`
**When** une erreur survient dans le système
**Then** une `AnatolyError` est lancée avec un code standardisé (CONFIG_INVALID, LLM_TIMEOUT, ZOD_VALIDATION_FAILED, etc.) et un flag `recoverable`

**Given** les schémas et erreurs
**When** les tests unitaires co-located sont exécutés
**Then** tous les tests passent

### Story 1.3 : Chargement de configuration

As a développeur,
I want qu'Anatoly charge ma configuration `.anatoly.yml` ou utilise des défauts sensés,
So that je puisse configurer le scope du scan ou lancer sans config au premier usage.

**Acceptance Criteria:**

**Given** un projet avec un fichier `.anatoly.yml` valide
**When** Anatoly charge la configuration
**Then** les valeurs include, exclude, coverage, llm et timeout sont parsées et validées par ConfigSchema

**Given** un projet sans `.anatoly.yml`
**When** Anatoly charge la configuration
**Then** des défauts automatiques sont appliqués (include `src/**/*.ts`, `src/**/*.tsx`, exclude `node_modules/**`, `dist/**`, `**/*.test.ts`, `**/*.spec.ts`)

**Given** un fichier `.anatoly.yml` malformé
**When** Anatoly tente de charger la configuration
**Then** une `AnatolyError` avec code `CONFIG_INVALID` est lancée avec un message clair

### Story 1.4 : Scanner AST et hash SHA-256

As a développeur,
I want scanner mon projet pour extraire l'AST de chaque fichier TypeScript et calculer un hash SHA-256,
So that Anatoly puisse identifier les symboles exportés et détecter les fichiers modifiés.

**Acceptance Criteria:**

**Given** un projet TypeScript avec des fichiers `.ts` et `.tsx`
**When** je lance `npx anatoly scan`
**Then** chaque fichier est parsé via web-tree-sitter (WASM) pour extraire les symboles (nom, kind, line_start, line_end, exported)
**And** un hash SHA-256 est calculé pour chaque fichier
**And** un fichier `.task.json` est généré par fichier dans `.anatoly/tasks/`
**And** `progress.json` est créé/mis à jour dans `.anatoly/cache/` avec le statut PENDING pour chaque fichier

**Given** un fichier déjà scanné dont le hash SHA-256 n'a pas changé
**When** un re-scan est lancé
**Then** le fichier est marqué CACHED et son `.task.json` n'est pas régénéré

**Given** la convention de nommage
**When** un fichier `src/utils/format.ts` est scanné
**Then** le `.task.json` est nommé `src-utils-format.task.json`

### Story 1.5 : Intégration coverage et détection monorepo

As a développeur,
I want qu'Anatoly intègre mes données de coverage et détecte mon monorepo,
So that le scan inclue les informations de couverture par fichier et gère correctement les workspaces.

**Acceptance Criteria:**

**Given** un projet avec un fichier `coverage-final.json` (Istanbul/Vitest/Jest)
**When** le scan est lancé avec coverage activée dans la config
**Then** les données de coverage par fichier sont incluses dans le `.task.json` correspondant

**Given** un projet sans coverage ou avec coverage désactivée
**When** le scan est lancé
**Then** le champ coverage est absent ou vide dans le `.task.json`, sans erreur

**Given** un monorepo (Yarn/PNPM/Nx/Turbo workspaces)
**When** le scan est lancé
**Then** Anatoly détecte les workspaces via `package.json` workspaces ou config Nx/Turbo
**And** les fichiers de chaque workspace sont scannés avec le bon tsconfig

**Given** un projet simple (non monorepo)
**When** le scan est lancé
**Then** le scan fonctionne normalement avec un seul tsconfig

## Epic 2 : Estimation du scope d'audit
**Status: Done** (v0.1.0)

Le développeur peut estimer le volume de travail (tokens, temps) avant de lancer un audit complet.

### Story 2.1 : Estimation de scope via tiktoken

As a développeur,
I want estimer le nombre de tokens et le temps nécessaire pour un audit complet,
So that je puisse décider si je lance l'audit maintenant ou si j'ajuste le scope.

**Acceptance Criteria:**

**Given** un projet scanné avec des `.task.json` dans `.anatoly/tasks/`
**When** je lance `npx anatoly estimate`
**Then** tiktoken calcule localement les tokens estimés (input et output) pour l'ensemble des fichiers
**And** un temps estimé est affiché basé sur le traitement séquentiel
**And** le nombre de fichiers et de symboles est affiché
**And** aucun appel LLM n'est effectué

**Given** l'affichage de l'estimation
**When** je consulte le résultat
**Then** le format est sobre et aligné :
```
anatoly — estimate
  files        142
  symbols      847
  est. tokens  ~1.2M input / ~340K output
  est. time    ~25 min (sequential)
```
**And** aucun prix n'est affiché (utilisateurs forfaitaires)

**Given** un projet non scanné
**When** je lance `npx anatoly estimate`
**Then** le scan est exécuté automatiquement avant l'estimation

## Epic 3 : Review agentique fichier par fichier
**Status: Done** (v0.1.0)

Le développeur reçoit un audit intelligent de chaque fichier avec les 5 axes d'analyse, un score de confiance, le dual output JSON+MD et le transcript complet du raisonnement.

### Story 3.1 : Construction du prompt et appel Agent SDK

As a développeur,
I want qu'Anatoly envoie chaque fichier à un agent Claude avec le bon prompt et les outils filesystem,
So that l'agent puisse enquêter rigoureusement sur chaque symbole du fichier.

**Acceptance Criteria:**

**Given** un fichier avec son `.task.json` (AST + hash + coverage)
**When** la review est lancée pour ce fichier
**Then** `prompt-builder.ts` construit un system prompt incluant le chemin du fichier, les symboles extraits, les règles d'enquête (grep obligatoire pour DEAD, lecture obligatoire pour DUPLICATE), et les few-shots
**And** l'agent Claude est invoqué via `@anthropic-ai/claude-agent-sdk` avec `query()` en async generator
**And** l'agent a accès aux outils filesystem (grep, read_file, search)

**Given** la configuration `.anatoly.yml`
**When** le modèle LLM est spécifié
**Then** le modèle configuré est utilisé pour la review (défaut : Claude Sonnet)

### Story 3.2 : Validation Zod et retry automatique

As a développeur,
I want que chaque réponse de l'agent soit validée par Zod avec retry automatique,
So that les reviews soient toujours conformes au schéma et exploitables.

**Acceptance Criteria:**

**Given** la réponse brute de l'agent Claude
**When** la réponse est parsée
**Then** elle est validée contre `ReviewFileSchema` (Zod)

**Given** une réponse invalide (échec Zod)
**When** la validation échoue
**Then** le message d'erreur `ZodError.format()` est renvoyé à l'agent comme feedback
**And** l'agent est relancé avec ce feedback (max 3 tentatives)

**Given** 3 tentatives échouées
**When** la validation échoue encore
**Then** le fichier est marqué ERROR dans `progress.json`
**And** une `AnatolyError` avec code `ZOD_VALIDATION_FAILED` est loggée
**And** le pipeline continue avec le fichier suivant

### Story 3.3 : Lock file et gestion de progress

As a développeur,
I want qu'Anatoly protège contre les doubles instances et suive la progression,
So that je puisse relancer l'outil en toute sécurité après un crash ou une interruption.

**Acceptance Criteria:**

**Given** aucune instance d'Anatoly en cours
**When** je lance `npx anatoly review`
**Then** un lock file `.anatoly/lock` est créé avec PID + timestamp
**And** `progress.json` est lu et les fichiers DONE/CACHED sont ignorés
**And** les fichiers PENDING/IN_PROGRESS/TIMEOUT/ERROR sont traités

**Given** une instance déjà en cours (lock file existant avec PID actif)
**When** je lance une seconde instance
**Then** une `AnatolyError` avec code `LOCK_EXISTS` est lancée avec un message clair

**Given** un crash précédent (lock file avec PID inactif)
**When** je relance Anatoly
**Then** le lock file orphelin est nettoyé et l'exécution reprend normalement

**Given** l'écriture de `progress.json`
**When** une mise à jour est effectuée
**Then** l'écriture est atomique (tmp + rename) pour garantir l'intégrité

### Story 3.4 : Dual output et transcripts

As a développeur,
I want recevoir deux fichiers par review (JSON machine + MD humain) et un transcript complet,
So that je puisse exploiter les résultats programmatiquement et les lire facilement.

**Acceptance Criteria:**

**Given** une review terminée et validée par Zod pour un fichier
**When** les résultats sont sauvegardés
**Then** un `.rev.json` est écrit dans `.anatoly/reviews/` contenant le ReviewFileSchema complet
**And** un `.rev.md` est écrit dans `.anatoly/reviews/` avec le verdict, les symboles analysés, les actions recommandées et un lien vers le transcript

**Given** le streaming de l'agent pendant la review
**When** l'agent raisonne et utilise des outils
**Then** chaque pensée et tool call est appendée en temps réel dans `.anatoly/logs/{file}.transcript.md` avec timestamp

**Given** la convention de nommage
**When** le fichier `src/utils/format.ts` est reviewé
**Then** les fichiers sont nommés `src-utils-format.rev.json`, `src-utils-format.rev.md`, `src-utils-format.transcript.md`

**Given** un fichier avec des imports inutilisés
**When** la review est terminée et le `.rev.json` est écrit
**Then** le champ `file_level.unused_imports` contient la liste des imports non utilisés détectés par l'agent

**Given** un fichier impliqué dans une dépendance circulaire
**When** la review est terminée et le `.rev.json` est écrit
**Then** le champ `file_level.circular_dependencies` contient les chemins des fichiers formant le cycle

### Story 3.5 : Commande review et orchestration séquentielle

As a développeur,
I want lancer `npx anatoly review` pour auditer tous les fichiers séquentiellement,
So that chaque fichier soit audité un par un avec gestion du timeout et de la reprise.

**Acceptance Criteria:**

**Given** un projet scanné avec des fichiers PENDING dans `progress.json`
**When** je lance `npx anatoly review`
**Then** chaque fichier est traité séquentiellement (un à la fois)
**And** le statut passe de PENDING → IN_PROGRESS → DONE (ou ERROR/TIMEOUT)
**And** le lock file est relâché à la fin

**Given** un fichier dont la review dépasse 180 secondes
**When** le timeout est atteint
**Then** le fichier est marqué TIMEOUT dans `progress.json`
**And** le pipeline continue avec le fichier suivant

**Given** un projet déjà partiellement reviewé
**When** je relance `npx anatoly review`
**Then** seuls les fichiers non-DONE/non-CACHED sont traités

**Given** la commande review en cours d'exécution
**When** un fichier est traité ou terminé
**Then** la progression est affichée via le module `renderer.ts` (version minimale `console.log` — le renderer enrichi avec zone fixe/flux est implémenté dans l'Epic 5)

## Epic 4 : Rapport agrégé et actionnable
**Status: Done** (v0.1.0)

Le développeur consulte un rapport d'ensemble qui synthétise tous les findings, triés par sévérité, avec un résumé exécutif immédiatement lisible et passable à un LLM.

### Story 4.1 : Agrégation des reviews et génération du rapport

As a développeur,
I want qu'Anatoly agrège tous les `.rev.json` en un rapport Markdown structuré,
So that je puisse voir l'état de santé global de mon codebase en un coup d'oeil.

**Acceptance Criteria:**

**Given** des fichiers `.rev.json` dans `.anatoly/reviews/`
**When** je lance `npx anatoly report`
**Then** un fichier `report.md` est généré dans `.anatoly/` contenant :
1. Résumé exécutif (compteurs de verdicts + verdict global CLEAN/NEEDS_REFACTOR/CRITICAL)
2. Tableau des findings triés par sévérité (high → medium → low) avec fichier, verdict, axes, confidence
3. Liste des fichiers propres (CLEAN)
4. Fichiers en erreur (TIMEOUT/ERROR) si applicable
5. Métadonnées (date, version, durée, tokens consommés)

**Given** le verdict global
**When** tous les fichiers sont CLEAN
**Then** le verdict global est CLEAN

**Given** le verdict global
**When** des findings non critiques existent (DEAD, DUP, OVER)
**Then** le verdict global est NEEDS_REFACTOR

**Given** le verdict global
**When** des findings high severity ou des erreurs de correction existent
**Then** le verdict global est CRITICAL

### Story 4.2 : Format Markdown actionnable pour LLM

As a développeur,
I want que le rapport soit structuré pour être passé directement à un LLM,
So that je puisse utiliser Claude ou Cursor pour nettoyer automatiquement les findings.

**Acceptance Criteria:**

**Given** le fichier `report.md` généré
**When** je consulte sa structure
**Then** il utilise des headers structurés (h1/h2/h3) pour la navigation
**And** les données tabulaires utilisent des tableaux Markdown (cli-table3)
**And** les chemins de fichiers sont en code blocks
**And** des liens relatifs pointent vers les `.rev.md` individuels

**Given** un finding dans le rapport
**When** je consulte ses détails
**Then** le symbole concerné, ses lignes, le verdict par axe, le score de confiance et le lien vers le transcript sont présents

## Epic 5 : Pipeline complet et expérience CLI
**Status: Done** (v0.1.0)

Le développeur lance `npx anatoly run` et obtient l'audit complet de bout en bout avec progression temps réel, gestion SIGINT, exit codes, et les flags CLI globaux.

### Story 5.1 : Renderer terminal enrichi (zone fixe + zone flux)

As a développeur,
I want voir la progression en temps réel pendant l'audit avec un affichage structuré (zone fixe + zone de flux),
So that je puisse suivre l'avancement et les findings pendant que l'outil travaille.

**Note :** Un renderer minimal (`console.log`) est implémenté dès l'Epic 3 (Story 3.5) pour permettre l'affichage basique de la progression. Cette story enrichit le renderer avec `log-update` (zone fixe ré-écrite en place), `ora` (spinner), et la barre de progression Unicode.

**Acceptance Criteria:**

**Given** une review en cours
**When** le renderer est en mode TTY (interactif)
**Then** une zone fixe est affichée en haut via log-update contenant :
- Header `anatoly v{version}`
- Spinner ora avec le fichier en cours (`⠋ reviewing src/utils/format.ts`)
- Barre de progression (`progress ████████░░░░  47/142`)
- Compteurs de findings (`dead 8  dup 3  over 2  err 1`)
**And** une zone de flux en dessous affiche les fichiers terminés (`✓ src-utils-format.rev.md  CLEAN`)

**Given** un environnement pipe/CI (pas de TTY)
**When** le renderer est en mode plain
**Then** l'output est linéaire séquentiel sans réécriture en place
**And** les verdicts restent en MAJUSCULES pour rester distincts sans couleurs

**Given** le flag `--no-color` ou la variable `$NO_COLOR`
**When** le renderer est initialisé
**Then** chalk est désactivé et l'output reste structuré sans couleurs

### Story 5.2 : Commande run et orchestration du pipeline

As a développeur,
I want lancer `npx anatoly run` pour exécuter l'audit complet de bout en bout,
So that je n'aie pas à orchestrer les sous-commandes manuellement.

**Acceptance Criteria:**

**Given** un projet TypeScript valide
**When** je lance `npx anatoly run`
**Then** le pipeline s'exécute séquentiellement : scan → estimate → review → report
**And** aucune confirmation intermédiaire n'est demandée (NFR9)
**And** la progression est affichée en temps réel via le renderer

**Given** l'audit terminé sans findings
**When** le pipeline se termine
**Then** l'exit code est 0
**And** le message de complétion affiche :
```
review complete — 142 files | 0 findings | 142 clean
  report       .anatoly/report.md
  reviews      .anatoly/reviews/
  transcripts  .anatoly/logs/
```

**Given** l'audit terminé avec des findings
**When** le pipeline se termine
**Then** l'exit code est 1

**Given** une erreur technique bloquante (pas de tsconfig, erreur API globale)
**When** le pipeline ne peut pas se compléter
**Then** l'exit code est 2 avec un message d'erreur clair

### Story 5.3 : Gestion SIGINT et flags CLI globaux

As a développeur,
I want pouvoir interrompre l'audit proprement et personnaliser le comportement via des flags,
So that je garde le contrôle sur l'exécution et que les reviews déjà faites soient préservées.

**Acceptance Criteria:**

**Given** un audit en cours
**When** je presse Ctrl+C (SIGINT)
**Then** le fichier en cours est abandonné
**And** un résumé partiel est affiché : `interrupted — 47/142 files reviewed | 8 findings`
**And** les reviews déjà sauvegardées restent intactes dans `.anatoly/reviews/`
**And** le lock file est relâché
**And** je peux relancer `anatoly run` et le cache reprend là où il en était

**Given** le flag `--no-cache`
**When** je lance `npx anatoly run --no-cache`
**Then** le cache SHA-256 est ignoré et tous les fichiers sont re-reviewés

**Given** le flag `--file <glob>`
**When** je lance `npx anatoly run --file "src/utils/**"`
**Then** seuls les fichiers correspondant au pattern glob sont traités

**Given** le flag `--verbose`
**When** je lance `npx anatoly run --verbose`
**Then** les détails d'opérations (hashes, tool calls, etc.) sont affichés avec préfixe `[anatoly]` + timestamp

**Given** le flag `--plain`
**When** je lance `npx anatoly run --plain`
**Then** log-update est désactivé et l'output est linéaire séquentiel

## Epic 6 : Commandes utilitaires
**Status: Done** (v0.1.0)

Le développeur gère l'état de son audit : consulter le statut, nettoyer les logs, réinitialiser le cache.

### Story 6.1 : Commande status

As a développeur,
I want consulter l'état courant de l'audit via `npx anatoly status`,
So that je puisse voir la progression et les résultats sans relancer un audit.

**Acceptance Criteria:**

**Given** un `progress.json` existant dans `.anatoly/cache/`
**When** je lance `npx anatoly status`
**Then** un résumé est affiché avec le nombre de fichiers par statut (PENDING, DONE, CACHED, ERROR, TIMEOUT)
**And** le nombre de findings trouvés est affiché
**And** le chemin vers le rapport est indiqué s'il existe

**Given** aucun audit précédent (pas de `.anatoly/`)
**When** je lance `npx anatoly status`
**Then** un message clair indique qu'aucun audit n'a été lancé

### Story 6.2 : Commandes clean-logs et reset

As a développeur,
I want nettoyer les transcripts ou réinitialiser complètement l'audit,
So that je puisse libérer de l'espace disque ou repartir de zéro.

**Acceptance Criteria:**

**Given** des transcripts dans `.anatoly/logs/`
**When** je lance `npx anatoly clean-logs`
**Then** tous les fichiers `.transcript.md` dans `.anatoly/logs/` sont supprimés
**And** un message de confirmation indique le nombre de fichiers supprimés

**Given** un dossier `.anatoly/` avec cache, reviews, logs et rapport
**When** je lance `npx anatoly reset`
**Then** les dossiers `.anatoly/cache/`, `.anatoly/reviews/`, `.anatoly/logs/`, `.anatoly/tasks/` sont vidés
**And** le fichier `.anatoly/report.md` est supprimé
**And** un message de confirmation indique que l'audit a été réinitialisé

**Given** aucun dossier `.anatoly/`
**When** je lance `npx anatoly clean-logs` ou `npx anatoly reset`
**Then** un message indique qu'il n'y a rien à nettoyer

## Epic 7 : Mode watch (surveillance continue)
**Status: Done** (v0.1.0)

Le développeur lance un mode daemon qui re-scanne et re-review automatiquement les fichiers modifiés.

### Story 7.1 : Mode watch avec re-scan incrémental

As a développeur,
I want lancer `npx anatoly watch` pour surveiller mon codebase en continu,
So that les fichiers modifiés soient automatiquement re-scannés et re-reviewés.

**Acceptance Criteria:**

**Given** un projet TypeScript valide
**When** je lance `npx anatoly watch`
**Then** chokidar surveille les fichiers correspondant aux patterns include/exclude de la config
**And** un scan initial est effectué si nécessaire

**Given** le mode watch actif
**When** un fichier `.ts` ou `.tsx` est modifié
**Then** son hash SHA-256 est recalculé
**And** s'il a changé, un re-scan AST est effectué
**And** une re-review est lancée automatiquement pour ce fichier
**And** le `.rev.json`, `.rev.md` et transcript sont mis à jour
**And** le `report.md` est régénéré

**Given** le mode watch actif
**When** un fichier est créé ou supprimé
**Then** `progress.json` est mis à jour en conséquence
**And** les fichiers output orphelins sont nettoyés pour les fichiers supprimés

**Given** le mode watch actif
**When** je presse Ctrl+C
**Then** le watcher s'arrête proprement et le lock file est relâché

---

## Epic 8 : RAG sémantique cross-file
**Status: Done** (v0.2.0)

Le développeur bénéficie d'une détection de duplication sémantique cross-file fiable : corrections de sécurité et de justesse du RAG v0.2.0, puis migration vers un modèle pre-resolved (résultats injectés dans le prompt au lieu d'un outil MCP).

### Story 8.1 : Corrections RAG v0.2.0 — Issues identifiées lors du code review

As a developer using Anatoly with `--enable-rag`,
I want the RAG system to be secure, correct and fully wired,
So that semantic duplication detection works reliably without security risks or silent bugs.

**Acceptance Criteria:**

**Given** un `functionId` contenant des caractères spéciaux ou une tentative d'injection SQL
**When** le vector store exécute une query avec cet ID
**Then** l'input est validé/sanitisé et aucune injection n'est possible

**Given** un fichier contenant des `else if`
**When** `computeComplexity` calcule le score cyclomatique
**Then** chaque `else if` est compté exactement une fois (pas double-compté)

**Given** le flag `--enable-rag` est actif et l'index contient des données
**When** l'agent Claude review un fichier avec des fonctions
**Then** le tool `findSimilarFunctions` est enregistré dans le Claude Agent SDK et l'agent peut l'appeler

**Given** un `postinstall` qui télécharge le modèle ONNX
**When** la variable d'environnement `ANATOLY_SKIP_DOWNLOAD=1` est définie
**Then** le script skip le téléchargement sans erreur

**Given** le vector store utilise `_distance` de LanceDB
**When** des résultats de recherche sont retournés
**Then** la conversion distance → score cosine est documentée et correcte

**Given** un index RAG avec plus de 10 000 cards
**When** `stats()` est appelé
**Then** le count est obtenu sans charger toutes les rows en mémoire

**Given** le `package.json` contient une version
**When** le renderer affiche la version
**Then** la version est lue depuis `package.json` (pas hardcodée)

### Story 8.2 : RAG pre-resolved dans le prompt — supprimer l'outil MCP

As a developer running Anatoly reviews,
I want the RAG similarity results to be pre-resolved and injected directly into the system prompt,
So that duplication detection is deterministic, faster, and cheaper — without relying on the LLM's compliance to call an MCP tool.

**Acceptance Criteria:**

**Given** RAG is enabled and the vector store contains indexed functions
**When** a review is launched for a file containing 3 functions
**Then** the system calls `VectorStore.searchById()` for each function BEFORE sending the prompt to the LLM
**And** the results are injected as a static section in the system prompt
**And** no MCP tool is registered for the review session

**Given** RAG is enabled and a function has 2 similar matches (scores 0.92 and 0.81)
**When** the pre-resolved results are injected into the prompt
**Then** the prompt section includes both matches with their scores, file paths, names, summaries, and behavioral profiles

**Given** RAG is enabled and a function has no similar matches (all scores < 0.78)
**When** the pre-resolved results are injected into the prompt
**Then** the prompt section for that function states "No similar functions found"

**Given** RAG is disabled (via `--no-rag` or config)
**When** the review prompt is built
**Then** no RAG section is appended to the prompt and no MCP server is created

**Given** all existing tests
**When** the refactoring is complete
**Then** `npm run typecheck`, `npm run test`, `npm run build`, and `npm run lint` all pass

---

## Epic 9 : Améliorations UX/DX post-v0.2.0
**Status: Done** (v0.3.0)

Le développeur bénéficie d'une expérience CLI plus polie : confirmations sur les opérations destructives, messages d'erreur actionnables, respect des standards d'accessibilité terminal, et ouverture automatique du rapport.

### Story 9.1 : Confirmation prompts sur opérations destructives

As a développeur,
I want que `reset` et `clean-logs --keep 0` me demandent confirmation avant de supprimer mes données,
So that je ne perde pas accidentellement mes reviews et mon cache.

**Acceptance Criteria:**

**Given** des reviews et du cache existants dans `.anatoly/`
**When** je lance `npx anatoly reset`
**Then** un résumé de ce qui sera supprimé est affiché (nombre de reviews, taille du cache, nombre de transcripts)
**And** une confirmation interactive est demandée (`Are you sure? (y/n)`)
**And** la suppression ne s'exécute que si je confirme avec `y`

**Given** des runs existants dans `.anatoly/runs/`
**When** je lance `npx anatoly clean-logs --keep 0`
**Then** un message indique le nombre de runs qui seront supprimés
**And** une confirmation interactive est demandée
**And** la suppression ne s'exécute que si je confirme

**Given** le flag `--yes` ou `-y`
**When** je lance `npx anatoly reset --yes`
**Then** la confirmation est skipée et la suppression s'exécute directement (pour CI/scripts)

**Given** un environnement non-TTY (pipe, CI)
**When** je lance `npx anatoly reset` sans `--yes`
**Then** l'opération est refusée avec un message indiquant d'utiliser `--yes` pour les environnements non-interactifs

### Story 9.2 : Messages d'erreur avec recovery steps

As a développeur,
I want que chaque message d'erreur d'Anatoly m'indique clairement quoi faire pour résoudre le problème,
So that je ne sois jamais bloqué sans savoir comment corriger la situation.

**Acceptance Criteria:**

**Given** une erreur `LOCK_EXISTS` (une autre instance est en cours)
**When** le message d'erreur est affiché
**Then** il inclut : `Another instance is running (PID: XXXX). Wait for it to finish or run 'anatoly reset' to force clear.`

**Given** une erreur `ZOD_VALIDATION_FAILED` (réponse LLM invalide)
**When** le message d'erreur est affiché dans le terminal (pas dans le transcript)
**Then** il est résumé de manière lisible : `Review validation failed for src/utils/format.ts after 3 retries. Run with --verbose for details.`

**Given** une erreur `CONFIG_INVALID` (fichier `.anatoly.yml` malformé)
**When** le message d'erreur est affiché
**Then** il inclut le chemin du fichier, la ligne/clé problématique si disponible, et un exemple de configuration valide

**Given** une erreur `FILE_NOT_FOUND` (tsconfig introuvable)
**When** le message d'erreur est affiché
**Then** il inclut : `No tsconfig.json found in current directory. Make sure you're running Anatoly from your project root.`

**Given** n'importe quelle erreur AnatolyError
**When** le message est affiché
**Then** il suit le format : `error: <message clair>\n  → <action de recovery suggérée>`

### Story 9.3 : Support NO_COLOR et flag --open

As a développeur,
I want qu'Anatoly respecte la variable d'environnement `NO_COLOR` et me permette d'ouvrir le rapport automatiquement,
So that l'outil s'intègre aux standards d'accessibilité terminal et que je gagne du temps après chaque audit.

**Acceptance Criteria:**

**Given** la variable d'environnement `NO_COLOR` est définie (quelle que soit sa valeur, même vide)
**When** Anatoly s'initialise
**Then** chalk est désactivé automatiquement (équivalent à `--no-color`)
**And** le comportement est identique à `--no-color`

**Given** `NO_COLOR` est définie ET `--no-color` est passé
**When** Anatoly s'initialise
**Then** les deux sont compatibles, pas de conflit ni de warning

**Given** un audit terminé avec `npx anatoly run --open`
**When** le rapport est généré
**Then** le fichier `report.md` est ouvert automatiquement via la commande système appropriée (`xdg-open` sur Linux, `open` sur macOS, `start` sur Windows)

**Given** le flag `--open` sans rapport généré (erreur pendant le run)
**When** le pipeline échoue avant la génération du rapport
**Then** le flag est ignoré silencieusement (pas d'erreur supplémentaire)

### Story 9.4 : Enrichissement du status et verbose mode

As a développeur,
I want que la commande `status` affiche une vue enrichie avec barre de progression et que le mode `--verbose` montre les détails d'exécution,
So that je puisse visualiser l'avancement d'un coup d'oeil et diagnostiquer les problèmes.

**Acceptance Criteria:**

**Given** un audit partiellement complété (18/60 fichiers done)
**When** je lance `npx anatoly status`
**Then** l'affichage inclut une barre de progression visuelle : `████████░░░░░░░░  18/60 files reviewed (30%)`
**And** les compteurs de findings sont affichés : `dead 8  dup 12  over 3  err 1`
**And** le chemin vers le dernier rapport est indiqué s'il existe

**Given** un audit en cours avec `--verbose`
**When** je lance `npx anatoly run --verbose`
**Then** pour chaque fichier reviewé, les tokens consommés (input/output) sont affichés
**And** les cache hits/misses sont indiqués (`cached` vs `reviewed`)
**And** le temps par fichier est affiché

---

## Epic 10 : Parallélisation des reviews
**Status: Done** (v0.3.0)

Le développeur peut lancer un audit parallèle (`--concurrency N`) qui divise le temps d'exécution par un facteur proche de N, tout en respectant les rate limits API, en maintenant l'intégrité du `progress.json`, et en offrant un affichage temps réel multi-fichier.

**FRs couvertes :** FR2 (évolution pipeline), FR9 (review agent — exécution concurrente)
**NFRs impactées :** NFR5 (temps moyen premier rapport — amélioration directe), NFR9 (zéro interruption — préservation)

**Dépendances :** Epic 3 (review agentique), Epic 5 (pipeline run + renderer)

**Risques techniques identifiés :**
- Rate limits API Anthropic (RPM/TPM) → nécessité d'un mécanisme de backoff
- Écriture concurrente dans `progress.json` → atomicWriteJson + sérialization des écritures
- Affichage terminal multi-fichier → refonte du renderer pour N slots simultanés
- Gestion SIGINT avec N reviews en vol → abort de tous les AbortControllers actifs
- Coût API : N requêtes en parallèle = même coût total, mais pics de consommation plus élevés

### Story 10.1 : Pool de workers et sémaphore de concurrence

As a développeur,
I want lancer `npx anatoly run --concurrency 3` pour auditer jusqu'à 3 fichiers en parallèle,
So that le temps d'audit total soit divisé par ~3 sur les projets avec beaucoup de fichiers.

**Acceptance Criteria:**

**Given** un projet avec 60 fichiers PENDING
**When** je lance `npx anatoly run --concurrency 3`
**Then** jusqu'à 3 fichiers sont reviewés simultanément via un pool de workers
**And** dès qu'un slot se libère (review terminée), le fichier suivant démarre immédiatement
**And** le comportement par défaut reste séquentiel (`--concurrency 1`)

**Given** le flag `--concurrency` avec une valeur invalide (0, -1, ou > 10)
**When** je lance `npx anatoly run --concurrency 0`
**Then** une erreur claire est affichée : `error: --concurrency must be between 1 and 10`

**Given** un pool de workers actif
**When** tous les fichiers PENDING ont été assignés à un worker
**Then** le pool attend la fin de tous les workers avant de passer à la phase report
**And** aucun fichier n'est traité deux fois

**Given** la configuration `.anatoly.yml`
**When** un champ `llm.concurrency` est présent
**Then** la valeur est utilisée comme défaut (le flag CLI `--concurrency` prend la priorité)

### Story 10.2 : ProgressManager thread-safe

As a développeur d'Anatoly,
I want que le `ProgressManager` supporte les mises à jour concurrentes sans corruption,
So that plusieurs reviews en parallèle puissent mettre à jour `progress.json` de manière fiable.

**Acceptance Criteria:**

**Given** 3 reviews en cours simultanément
**When** chacune appelle `pm.updateFileStatus()` en parallèle
**Then** les écritures dans `progress.json` sont sérialisées (file d'attente interne)
**And** aucune écriture n'est perdue ou corrompue
**And** `atomicWriteJson()` (tmp + rename) est toujours utilisé

**Given** un crash pendant une écriture concurrente
**When** je relance `npx anatoly run`
**Then** les fichiers IN_PROGRESS sont correctement détectés comme PENDING (crash recovery inchangé)

**Given** la méthode `getPendingFiles()`
**When** un worker la consulte pendant qu'un autre worker termine un fichier
**Then** les fichiers déjà assignés à un worker ne sont pas retournés (le pool gère l'assignation, pas le ProgressManager)

### Story 10.3 : Rate limiting et backoff exponentiel

As a développeur,
I want qu'Anatoly respecte automatiquement les rate limits de l'API Anthropic,
So that les reviews parallèles ne provoquent pas de rejets 429 en cascade.

**Acceptance Criteria:**

**Given** un pool de workers avec concurrency 3
**When** l'API retourne une erreur 429 (rate limit)
**Then** le worker concerné attend avec un backoff exponentiel (base 5s, max 120s, jitter +-20%)
**And** les autres workers continuent normalement
**And** un message est affiché : `rate limited — retrying in Xs`

**Given** 5 erreurs 429 consécutives sur un même fichier
**When** le backoff max est atteint
**Then** le fichier est marqué ERROR avec message `Rate limit exceeded after 5 retries`
**And** le pipeline continue avec les fichiers restants

**Given** le mode `--verbose`
**When** un backoff est actif
**Then** les détails du rate limit sont affichés (retry count, wait time, header `retry-after` si présent)

### Story 10.4 : Renderer multi-fichier

As a développeur,
I want voir la progression de chaque review en cours simultanément,
So that je puisse suivre l'avancement du pool de workers en temps réel.

**Acceptance Criteria:**

**Given** un audit parallèle avec `--concurrency 3`
**When** 3 reviews sont en cours simultanément
**Then** la zone fixe du renderer affiche un slot par worker actif :
```
anatoly v0.3.0

  [1] reviewing src/core/scanner.ts
  [2] reviewing src/utils/cache.ts
  [3] reviewing src/rag/indexer.ts
  progress ████████░░░░  18/60
  dead 3  dup 1  over 0  err 0
```

**Given** un audit parallèle en mode `--plain`
**When** 3 reviews sont en cours
**Then** l'affichage reste linéaire séquentiel (un `reviewing...` / `OK...` par fichier terminé, dans l'ordre de complétion)

**Given** un worker qui termine sa review
**When** le résultat est ajouté à la zone flux
**Then** les résultats apparaissent dans l'ordre de complétion (pas dans l'ordre de démarrage)
**And** la zone fixe met à jour le slot libéré avec le fichier suivant

### Story 10.5 : Gestion SIGINT avec reviews en vol

As a développeur,
I want pouvoir interrompre proprement un audit parallèle avec Ctrl+C,
So that toutes les reviews en cours soient abandonnées et les reviews terminées soient préservées.

**Acceptance Criteria:**

**Given** un audit parallèle avec 3 reviews en vol
**When** je presse Ctrl+C (SIGINT)
**Then** tous les AbortControllers actifs sont abortés simultanément
**And** les reviews déjà sauvegardées sur disque restent intactes
**And** les fichiers en cours sont marqués IN_PROGRESS (reprise au prochain run)
**And** un résumé partiel est affiché : `interrupted — 18/60 files reviewed | 5 findings (3 in-flight aborted)`

**Given** un second Ctrl+C (force exit)
**When** l'arrêt gracieux est déjà en cours
**Then** le processus se termine immédiatement (force exit)
**And** le lock file est relâché

**Given** une review qui se termine juste après le SIGINT
**When** la réponse arrive pendant l'arrêt gracieux
**Then** la review est sauvegardée normalement (on ne gaspille pas le travail déjà payé)

---

## Epic 11 : Boucle d'autocorrection Claude Code
**Status: Done** (v0.3.0)

Le développeur bénéficie d'un feedback automatique d'Anatoly intégré à Claude Code : chaque modification de fichier déclenche une **review complète** en background (même pipeline que `anatoly review`), et quand Claude Code finit sa tâche, les findings accumulés sont injectés dans le contexte pour autocorrection avant de rendre la main.

**FRs couvertes :** FR9 (review agentique — intégration hook), FR10 (5 axes d'analyse — review complète, pas de mode dégradé), FR16 (configuration)
**NFRs impactées :** NFR1 (zéro faux positif — même pipeline de review, pas de compromis), NFR8 (lecture seule — préservé)

**Dépendances :** Epic 3 (review agentique — reviewer.ts, prompt-builder.ts), Epic 1 (scanner AST, config loader)

**Principe fondamental :**
Pas de mode dégradé. Le hook utilise exactement le même pipeline de review que `anatoly review` — mêmes outils filesystem (grep, read, glob), même modèle (configurable), mêmes 5 axes, même validation Zod. Toute divergence entre un "lint léger" et une "review complète" créerait un diff de confiance inacceptable.

**Concept clé :**
Claude Code supporte des hooks à deux moments :
- `PostToolUse` (async) — se déclenche après chaque `Edit`/`Write`, peut lancer un process en background sans bloquer Claude Code
- `Stop` (sync) — se déclenche quand Claude Code finit sa tâche, peut injecter du feedback via `additionalContext` pour que Claude Code reprenne et corrige

**Architecture du flux :**
```
Claude Code fait un Edit/Write sur fichier.ts
  → Hook PostToolUse (async: true) se déclenche
    → Commande bridge lit stdin, extrait file_path
    → Lance: anatoly review --file <path> --no-cache en background
      → Scan AST + hash
      → Review complète (Sonnet, 5 axes, outils filesystem, RAG si activé)
      → Écrit .rev.json dans .anatoly/reviews/
    → Claude Code continue de travailler pendant ce temps
  ...
  ... Claude Code fait d'autres edits (chacun lance une review background)
  ...
Claude Code estime avoir terminé sa tâche
  → Hook Stop (sync) se déclenche
    → Commande bridge attend la fin des reviews background en cours
    → Lit les .rev.json des fichiers modifiés pendant la session
    → Si findings avec confidence >= seuil :
      → Retourne JSON avec additionalContext contenant les findings formatés
      → Claude Code reprend et corrige
    → Si tout est CLEAN :
      → Exit 0 silencieux, Claude Code rend la main
  ...
Claude Code re-finit après corrections
  → Hook Stop se re-déclenche
    → Re-vérifie les .rev.json (les fichiers corrigés ont été re-reviewés par PostToolUse)
    → Cycle jusqu'à CLEAN ou max_attempts atteint
```

**Risques techniques identifiés :**
- Latence des reviews background (Sonnet + outils = 30-180s par fichier) → les reviews tournent en parallèle pendant que Claude Code travaille ; le coût en temps est absorbé par le travail de Claude Code
- Coût API (chaque edit = 1 appel Sonnet) → debounce par fichier (si le même fichier est modifié plusieurs fois, seule la dernière review compte) + cache SHA-256 (un re-edit identique ne relance pas la review)
- Reviews pas terminées au moment du Stop → le hook Stop attend les reviews en cours avec un timeout configurable
- Boucle infinie (stop → correction → stop → correction) → compteur max d'itérations Stop par session (défaut 3)
- Concurrence avec `anatoly run` → le hook utilise le même lock file ; si un `run` est en cours, le hook skip silencieusement

### Story 11.1 : Commande `anatoly hook` avec sous-commandes

As a développeur,
I want une commande `anatoly hook` qui expose les handlers pour les hooks Claude Code,
So that les hooks puissent être configurés avec `npx anatoly hook post-edit` et `npx anatoly hook stop` sans scripts shell externes.

**Acceptance Criteria:**

**Given** un hook `PostToolUse` déclenché par Claude Code
**When** `npx anatoly hook post-edit` est invoqué
**Then** la commande :
1. Lit le JSON stdin de Claude Code (contient `tool_name`, `tool_input.file_path`)
2. Vérifie que `tool_name` est `Edit` ou `Write`
3. Vérifie que le fichier correspond aux patterns `scan.include` de la config (skip les fichiers hors scope et non-TS)
4. Lance `anatoly review --file <path> --no-cache` en child process détaché (background)
5. Enregistre le PID et le fichier dans `.anatoly/cache/hook-state.json`
6. Exit 0 immédiatement (ne bloque pas Claude Code)

**Given** un hook `Stop` déclenché par Claude Code
**When** `npx anatoly hook stop` est invoqué
**Then** la commande :
1. Lit `.anatoly/cache/hook-state.json` pour connaître les reviews en cours
2. Attend la fin de toutes les reviews background (timeout configurable, défaut 120s)
3. Lit les `.rev.json` des fichiers modifiés pendant la session
4. Filtre les findings avec confidence >= `config.llm.min_confidence` (défaut 70, nouveau champ optionnel)
5. Si findings : retourne un JSON avec `additionalContext` contenant les findings formatés
6. Si tout CLEAN : exit 0 silencieux

**Given** un fichier non-TypeScript (`.json`, `.md`, `.yml`)
**When** le hook `post-edit` se déclenche
**Then** la commande exit 0 silencieusement (pas de review)

**Given** la commande `hook`
**When** elle est enregistrée dans Commander
**Then** elle est une commande cachée (non listée dans `--help` standard) car destinée aux hooks, pas à l'usage direct

### Story 11.2 : Debounce et gestion d'état des reviews background

As a développeur d'Anatoly,
I want que les reviews background soient dédupliquées et tracées dans un fichier d'état,
So that le même fichier modifié 5 fois en 30 secondes ne lance pas 5 reviews Sonnet.

**Acceptance Criteria:**

**Given** un fichier modifié 3 fois en 10 secondes
**When** le hook `post-edit` se déclenche à chaque modification
**Then** la première review est lancée en background
**And** les modifications suivantes du même fichier annulent la review en cours (kill du child process) et relancent une nouvelle review
**And** seule la dernière review produit un `.rev.json`

**Given** le fichier d'état `.anatoly/cache/hook-state.json`
**When** il est lu/écrit
**Then** il contient :
```json
{
  "session_id": "abc123",
  "reviews": {
    "src/utils/cache.ts": {
      "pid": 12345,
      "started_at": "2026-02-24T10:30:00Z",
      "status": "running"
    },
    "src/core/scanner.ts": {
      "pid": 0,
      "started_at": "2026-02-24T10:29:00Z",
      "status": "done",
      "rev_path": ".anatoly/reviews/src-core-scanner.rev.json"
    }
  },
  "stop_count": 0
}
```
**And** les écritures sont atomiques (tmp + rename)

**Given** un crash du child process de review
**When** le hook `stop` lit le state
**Then** les reviews avec status `running` dont le PID n'est plus actif sont marquées `error`
**And** les fichiers sans `.rev.json` sont signalés en avertissement (pas en erreur bloquante)

### Story 11.3 : Hook Stop — gate de qualité et injection de feedback

As a développeur,
I want que le hook Stop vérifie les reviews et injecte le feedback dans Claude Code,
So that Claude Code se corrige automatiquement avant de rendre la main.

**Acceptance Criteria:**

**Given** des reviews terminées avec findings
**When** le hook `stop` se déclenche
**Then** le JSON retourné contient `additionalContext` avec un résumé formaté :
```
Anatoly review findings — 2 files with issues:

src/utils/cache.ts (NEEDS_REFACTOR):
  - [NEEDS_FIX] computeHash (L12-L25): Missing null check on input parameter (confidence: 85%)
  - [DEAD] oldHelper (L45-L60): No import/usage found across the project (confidence: 92%)

src/core/scanner.ts (NEEDS_REFACTOR):
  - [OVER] parseWithFallback (L30-L80): Excessive abstraction for a single use case (confidence: 78%)

Please fix these issues before completing.
```

**Given** toutes les reviews sont CLEAN
**When** le hook `stop` se déclenche
**Then** exit 0 silencieux — Claude Code rend la main normalement

**Given** des reviews encore en cours au moment du Stop
**When** le hook `stop` se déclenche
**Then** il attend la fin des reviews avec un timeout de 120s
**And** si le timeout est dépassé, les reviews non terminées sont ignorées (best-effort)
**And** un warning est ajouté au feedback : `Note: review of src/foo.ts timed out and was skipped.`

**Given** le hook Stop a déjà été déclenché `max_stop_iterations` fois (défaut 3) dans la même session
**When** le hook Stop se re-déclenche
**Then** il exit 0 silencieusement (coupe la boucle)
**And** un message stderr : `anatoly hook: max stop iterations reached (3), letting Claude Code finish`

### Story 11.4 : Configuration min_confidence dans le schéma

As a développeur,
I want configurer un seuil de confiance minimum pour les findings remontés par les hooks,
So that seuls les findings fiables déclenchent l'autocorrection.

**Acceptance Criteria:**

**Given** le fichier `.anatoly.yml`
**When** un champ `llm.min_confidence` est présent
**Then** il est validé comme un entier entre 0 et 100
**And** les findings avec `confidence` inférieur à ce seuil sont exclus du feedback hook

**Given** un fichier `.anatoly.yml` sans `llm.min_confidence`
**When** Anatoly charge la configuration
**Then** le défaut est `70`

**Given** le schéma `LlmConfigSchema` dans `src/schemas/config.ts`
**When** le champ est ajouté
**Then** il est défini comme `min_confidence: z.int().min(0).max(100).default(70)`

### Story 11.5 : Template de configuration Claude Code

As a développeur,
I want un template `.claude/settings.json` prêt à l'emploi pour activer la boucle d'autocorrection,
So that je puisse mettre en place l'intégration en une minute.

**Acceptance Criteria:**

**Given** le template de configuration
**When** je le consulte
**Then** il contient la configuration des deux hooks :
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx anatoly hook post-edit",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx anatoly hook stop",
            "timeout": 180,
            "statusMessage": "Anatoly reviewing changes..."
          }
        ]
      }
    ]
  }
}
```

**Given** la documentation
**When** le développeur consulte `anatoly --help` ou le README
**Then** une section "Claude Code Integration" explique :
1. Comment activer les hooks (copier le template dans `.claude/settings.json`)
2. Ce que fait chaque hook (PostToolUse = review background, Stop = gate de qualité)
3. Comment configurer le seuil de confiance (`llm.min_confidence`)
4. Comment désactiver temporairement (supprimer la section hooks)

### Story 11.6 : Protection contre les boucles et conflits

As a développeur,
I want que le système de hooks gère les cas limites (boucles, conflits avec `anatoly run`, timeouts),
So that la boucle d'autocorrection soit robuste en production.

**Acceptance Criteria:**

**Given** le hook Stop a injecté du feedback et Claude Code corrige
**When** les corrections déclenchent de nouveaux hooks PostToolUse
**Then** de nouvelles reviews background sont lancées pour les fichiers corrigés
**And** le compteur `stop_count` dans `hook-state.json` est incrémenté à chaque Stop

**Given** `stop_count` atteint `max_stop_iterations` (défaut 3)
**When** le hook Stop se re-déclenche
**Then** il exit 0 silencieusement et laisse Claude Code finir
**And** les findings restants sont loggés sur stderr pour information

**Given** un `anatoly run` est en cours (lock file actif)
**When** le hook `post-edit` se déclenche
**Then** le hook exit 0 silencieusement (pas de review background)
**And** le hook `stop` vérifie les `.rev.json` produits par le `run` en cours (s'ils existent)

**Given** un fichier `.anatoly/cache/hook-state.json` orphelin (session précédente)
**When** une nouvelle session Claude Code démarre et le premier hook se déclenche
**Then** le state est réinitialisé (session_id différent)

**Given** le hook `post-edit` détecte que le hash SHA-256 du fichier n'a pas changé
**When** une review existe déjà pour ce hash
**Then** la review n'est pas relancée (réutilisation du cache existant)

---

## Epic 12 : Parallélisation de l'indexation RAG
**Status: Done** (v0.3.0)

Le développeur bénéficie d'une phase d'indexation RAG (Phase 3) parallélisée, divisant le temps de pré-indexation Haiku par un facteur proche de N. Les appels Haiku pour la génération de function cards sont distribués sur un pool de workers réutilisant l'infrastructure de concurrence de l'Epic 10, tandis que les écritures LanceDB et cache sont sérialisées en batch post-pool.

**FRs couvertes :** FR2 (évolution pipeline — phase index), FR9 (interaction LLM — concurrence Haiku)
**NFRs impactées :** NFR5 (temps moyen premier rapport — amélioration directe), NFR9 (zéro interruption — préservation)

**Dépendances :** Epic 10 (worker pool, rate limiter), Epic 5 (pipeline run)

**Risques techniques identifiés :**
- **VectorStore (LanceDB) concurrence** — L'upsert fait `delete` + `add` non-atomique. Deux workers concurrents corrompraient la table → solution : accumuler les résultats en mémoire, batch upsert séquentiel post-pool
- **RAG cache (cache.json) concurrence** — `loadRagCache` + `atomicWriteJson` ne sont pas thread-safe → solution : pre-load du cache avant le pool, écriture unique post-pool
- **Rate limits Haiku** — Les limites RPM/TPM de Haiku sont plus hautes que Sonnet, mais avec concurrence élevée (4-10 workers), des 429 restent possibles → réutilisation de `retryWithBackoff` existant
- **Singleton embedding model** — `getEmbedder()` est un singleton lazy. Plusieurs workers appelant `embed()` simultanément pourraient déclencher des initialisations concurrentes → solution : pre-warm le modèle avant le pool, ensuite l'inférence séquentielle interne de `@xenova/transformers` est `await`-safe
- **Compteurs partagés** — `cardsIndexed` / `filesIndexed` sont des incréments simples entre `await` points, safe en JS single-thread

### Story 12.1 : Refactoring de l'orchestrateur pour accumulation découplée

As a développeur d'Anatoly,
I want que la phase d'index sépare le travail par fichier (Haiku + embed) de l'écriture en base (upsert + cache),
So that le travail par fichier puisse être distribué sur un pool de workers sans race condition.

**Acceptance Criteria:**

**Given** la fonction `indexProject()` dans `src/rag/orchestrator.ts`
**When** elle est refactorée
**Then** le traitement d'un fichier (appel Haiku + buildFunctionCards + embed) est extrait dans une fonction pure `processFileForIndex(projectRoot, task, cache): Promise<IndexedFileResult | null>` qui retourne les cards et leurs embeddings sans toucher au VectorStore ni au cache
**And** `IndexedFileResult` contient `{ task: Task, cards: FunctionCard[], embeddings: number[][] }`

**Given** la fonction `indexCards()` dans `src/rag/indexer.ts`
**When** elle est refactorée
**Then** la logique de vérification du cache (est-ce que le fichier a changé ?) est extraite dans une fonction pure `needsReindex(cache, cards, fileHash): FunctionCard[]` qui retourne les cards à réindexer
**And** la logique d'upsert + écriture cache reste dans `indexCards()` mais accepte les embeddings pré-calculés

**Given** la fonction `embed()` dans `src/rag/embeddings.ts`
**When** le pool s'apprête à démarrer
**Then** le modèle d'embedding est pré-chargé via un appel `await embed('')` avant de lancer les workers, pour éviter les initialisations concurrentes du singleton

**Given** les tests unitaires existants pour `buildFunctionCards` et `indexCards`
**When** le refactoring est terminé
**Then** tous les tests existants passent sans modification

### Story 12.2 : Pool de workers pour l'indexation Haiku

As a développeur,
I want que les appels Haiku de la phase d'index soient distribués sur un pool de workers concurrent,
So that le temps d'indexation soit divisé par ~N pour les projets avec beaucoup de fichiers.

**Acceptance Criteria:**

**Given** un projet avec 60 fichiers contenant des fonctions
**When** je lance `npx anatoly run` (avec concurrency configurée à 4)
**Then** la phase d'index lance jusqu'à 4 appels Haiku simultanément via `runWorkerPool`
**And** les résultats (`IndexedFileResult[]`) sont accumulés dans un tableau partagé
**And** dès que tous les workers ont terminé, un batch upsert séquentiel écrit tous les résultats dans LanceDB
**And** le cache est mis à jour en une seule écriture atomique

**Given** la concurrence de l'index
**When** elle n'est pas configurée séparément
**Then** elle réutilise la valeur `config.llm.concurrency` (même paramètre que les reviews, défaut 4)

**Given** la phase d'index en cours
**When** un worker échoue sur un fichier (erreur Haiku, JSON invalide, etc.)
**Then** l'erreur est swallowed (comme aujourd'hui) et le worker passe au fichier suivant
**And** les fichiers en erreur ne produisent pas de cards (comportement inchangé)

**Given** le flag `--concurrency 1`
**When** la phase d'index s'exécute
**Then** le comportement est identique à la version séquentielle actuelle (un seul worker)

### Story 12.3 : Rate limiting Haiku avec backoff

As a développeur,
I want que les appels Haiku concurrents respectent les rate limits de l'API,
So that la parallélisation ne provoque pas de rejets 429 en cascade.

**Acceptance Criteria:**

**Given** un pool de workers d'indexation avec concurrency 4
**When** l'API retourne une erreur 429 sur un appel Haiku
**Then** le worker concerné retry avec `retryWithBackoff` (base 2s, max 30s, jitter ±20%)
**And** les autres workers continuent normalement
**And** un message est affiché : `  rate limited — retrying {file} in Xs (attempt N/5)`

**Given** les paramètres de backoff pour Haiku
**When** ils sont comparés à ceux des reviews Sonnet
**Then** le base delay est plus court (2s vs 5s) et le max delay plus bas (30s vs 120s) car Haiku a des limites plus hautes et des appels plus courts

**Given** 5 erreurs 429 consécutives sur un même fichier
**When** le backoff est épuisé
**Then** le fichier est skippé silencieusement (pas de card générée, même comportement que le `catch` actuel)
**And** le pipeline continue avec les fichiers restants

### Story 12.4 : Affichage de la progression d'indexation

As a développeur,
I want voir la progression de la phase d'index avec le même niveau de détail que la phase review,
So that je puisse suivre l'avancement de l'indexation RAG en temps réel.

**Acceptance Criteria:**

**Given** la phase d'index en mode parallèle
**When** l'indexation est en cours avec concurrency 4
**Then** l'affichage console montre la progression :
```
anatoly — rag index (haiku)
  [1/60] src/core/scanner.ts
  [2/60] src/utils/cache.ts
  [3/60] src/rag/indexer.ts
  [4/60] src/commands/run.ts
```
**And** les compteurs de progression se mettent à jour au fur et à mesure des complétions

**Given** la phase d'index terminée
**When** les stats sont affichées
**Then** le format reste identique à l'actuel :
```
  cards indexed  42 new / 128 total
  files          18 new / 60 total
```

**Given** la phase d'index en mode `--plain`
**When** l'indexation est en cours
**Then** l'affichage est linéaire : un log par fichier complété, dans l'ordre de complétion

### Story 12.5 : Gestion SIGINT pendant l'indexation parallèle

As a développeur,
I want pouvoir interrompre proprement l'indexation parallèle avec Ctrl+C,
So that les cards déjà calculées soient persistées et que la reprise incrémentale fonctionne.

**Acceptance Criteria:**

**Given** une indexation parallèle avec 4 workers en vol
**When** je presse Ctrl+C (SIGINT)
**Then** le flag `isInterrupted()` est mis à `true`
**And** le pool arrête de dispatcher de nouveaux fichiers
**And** les workers en cours terminent leur fichier courant (pas d'abort — les appels Haiku sont courts, ~2-5s)
**And** les résultats accumulés avant l'interruption sont batch-upsertés dans LanceDB
**And** le cache est mis à jour pour les fichiers complétés

**Given** une indexation interrompue à 30/60 fichiers
**When** je relance `npx anatoly run`
**Then** le cache incrémental détecte les 30 fichiers déjà indexés
**And** seuls les 30 fichiers restants sont traités
**And** le temps de reprise est proportionnel aux fichiers manquants

**Given** un second Ctrl+C pendant le flush post-interruption
**When** le batch upsert est en cours
**Then** le force exit tue le processus immédiatement (comportement existant du handler SIGINT)

---

## Epic 13 : Audit complet de conformité — Full Review
**Status: Done** (v0.3.0)

Vérification systématique que chaque story implémentée (Epics 1-12) respecte ses acceptance criteria originales. Chaque story de review reprend les AC mot pour mot et les transforme en checklist vérifiable par un run bmalph automatisé.

**Objectif :** Valider la conformité du codebase avec les spécifications avant la v1.0.
**Dépendances :** Toutes les stories des Epics 1-12 marquées done/review.
**Détail :** Voir `_bmad-output/planning-artifacts/epic-13-conformity-report.md`

**Stories (41 stories de review) :**
- Story 13.1 : Review — 1.1 Initialisation du projet et structure CLI
- Story 13.2 : Review — 1.2 Schémas Zod et gestion d'erreurs
- Story 13.3 : Review — 1.3 Chargement de configuration
- Story 13.4 : Review — 1.4 Scanner AST et hash SHA-256
- Story 13.5 : Review — 1.5 Intégration coverage et détection monorepo
- Story 13.6 : Review — 2.1 Estimation de scope via tiktoken
- Story 13.7 : Review — 3.1 Construction du prompt et appel Agent SDK
- Story 13.8 : Review — 3.2 Validation Zod et retry automatique
- Story 13.9 : Review — 3.3 Lock file et gestion de progress
- Story 13.10 : Review — 3.4 Dual output et transcripts
- Story 13.11 : Review — 3.5 Commande review et orchestration séquentielle
- Story 13.12 : Review — 4.1 Agrégation des reviews et génération du rapport
- Story 13.13 : Review — 4.2 Format Markdown actionnable pour LLM
- Story 13.14 : Review — 5.1 Renderer terminal enrichi
- Story 13.15 : Review — 5.2 Commande run et orchestration du pipeline
- Story 13.16 : Review — 5.3 Gestion SIGINT et flags CLI globaux
- Story 13.17 : Review — 6.1 Commande status
- Story 13.18 : Review — 6.2 Commandes clean-logs et reset
- Story 13.19 : Review — 7.1 Mode watch avec re-scan incrémental
- Story 13.20 : Review — 9.1 Confirmation prompts sur opérations destructives
- Story 13.21 : Review — 9.2 Messages d'erreur avec recovery steps
- Story 13.22 : Review — 9.3 Support NO_COLOR et flag --open
- Story 13.23 : Review — 9.4 Enrichissement du status et verbose mode
- Story 13.24 : Review — 10.1 Pool de workers et sémaphore de concurrence
- Story 13.25 : Review — 10.2 ProgressManager thread-safe
- Story 13.26 : Review — 10.3 Rate limiting et backoff exponentiel
- Story 13.27 : Review — 10.4 Renderer multi-fichier
- Story 13.28 : Review — 10.5 Gestion SIGINT avec reviews en vol
- Story 13.29 : Review — 11.1 Commande `anatoly hook` avec sous-commandes
- Story 13.30 : Review — 11.2 Debounce et gestion d'état
- Story 13.31 : Review — 11.3 Hook Stop — gate de qualité
- Story 13.32 : Review — 11.4 Configuration min_confidence
- Story 13.33 : Review — 11.5 Template de configuration Claude Code
- Story 13.34 : Review — 11.6 Protection contre les boucles et conflits
- Story 13.35 : Review — 12.1 Refactoring orchestrateur
- Story 13.36 : Review — 12.2 Pool de workers indexation Haiku
- Story 13.37 : Review — 12.3 Rate limiting Haiku avec backoff
- Story 13.38 : Review — 12.4 Affichage progression indexation
- Story 13.39 : Review — 12.5 Gestion SIGINT indexation parallèle
- Story 13.40 : Review — 8.1 Corrections RAG v0.2.0 code review
- Story 13.41 : Review — 8.2 RAG pre-resolved in prompt

---

## Epic 14 : Codebase Hygiene — Audit-Driven Cleanup
**Status: Done** (v0.4.0)

Résoudre tous les constats identifiés par les runs d'auto-audit Anatoly pour atteindre le verdict CLEAN. Éliminer les bugs runtime, le dead code, les duplications et la complexité structurelle.

**Objectif :** Atteindre CLEAN sur l'ensemble de la codebase avant de développer de nouvelles features.
**Source :** 4 runs d'audit Anatoly du 2026-02-24 (60 file reviews au total)
**Détail :** Voir `_bmad/bmm/docs/epics/epic-14-codebase-hygiene.md`

**Stories (5 stories) :**
- Story 14.1 : Fix Bugs & Correction Errors — extractJson, rowToCard JSON.parse, ConfigSchema defaults
- Story 14.2 : Remove Dead Code — barrel exports, computeHash, detectMonorepo, parseReviewResponse, unused Zod schemas
- Story 14.3 : Consolidate Duplications — pkgVersion, isProcessRunning, loadLanguage, FunctionCard/VectorRow
- Story 14.4 : Structural Refactoring — registerRunCommand decomposition, reviewFile decomposition, matchGlob→picomatch
- Story 14.5 : Clean Up Module Exports — internalize formatCounterRow, formatResultLine, truncatePath

---

## Epic 15 : Migration du renderer CLI vers listr2
**Status: Done** (v0.3.0)

Le développeur bénéficie d'un feedback CLI propre et professionnel grâce à listr2 : task trees avec spinners natifs, progress concurrent multi-workers, fallback CI/non-TTY automatique — remplaçant les 400 lignes de code ANSI manual du renderer custom.

**Motivation :** Le renderer actuel (`src/utils/renderer.ts`) gère manuellement les scroll regions ANSI, le cursor save/restore, et le synchronized output. C'est fragile, difficile à maintenir, et mal géré sur certains terminaux. `ora` et `log-update` sont dans les deps mais inutilisés. listr2 v10 gère tout cela nativement avec un rendu professionnel.

**FRs impactées :** FR2 (pipeline run — affichage), FR17 (flags CLI `--plain`, `--no-color`)
**NFRs impactées :** NFR9 (zéro interruption — préservation du SIGINT), accessibilité terminale (NO_COLOR, fallback non-TTY)

**Dépendances :** Epic 5 (renderer original), Epic 10 (renderer multi-fichier), Epic 12 (affichage index RAG)

**Stories impactées existantes :** 5.1 (renderer enrichi), 5.2 (run pipeline), 10.4 (renderer multi-fichier), 12.4 (progression indexation)

**Décisions architecturales :**
- Scope limité aux consumers du Renderer (`run.ts`, `review.ts`) — les autres commandes restent en `console.log`
- L'interface `Renderer` est supprimée — listr2 gère nativement le fallback TTY/non-TTY
- `worker-pool.ts` est gardé (utilisé par RAG) mais la phase review inline la concurrence dans les subtasks listr2
- Les utilitaires format (`verdictColor`, `truncatePath`, etc.) sont extraits dans `src/utils/format.ts`

### Story 15.1 : Extraction des utilitaires de formatage

As a développeur d'Anatoly,
I want que les fonctions de formatage terminal soient découplées du renderer,
So that elles puissent être réutilisées par les commandes status/report et par les titres listr2.

**Acceptance Criteria:**

**Given** les fonctions `verdictColor()`, `truncatePath()`, `buildProgressBar()`, `formatCounterRow()`, `formatResultLine()` et le type `Counters` dans `src/utils/renderer.ts`
**When** l'extraction est terminée
**Then** ces fonctions sont dans un nouveau fichier `src/utils/format.ts`
**And** les tests correspondants sont dans `src/utils/format.test.ts` (déplacés depuis `renderer.test.ts`)
**And** les tests des fonctions pures passent tous sans modification

**Given** `src/commands/status.ts` qui importe `buildProgressBar` et `verdictColor` depuis `renderer.js`
**When** les imports sont mis à jour
**Then** l'import pointe vers `../utils/format.js`
**And** le comportement est identique

**Given** `src/commands/report.ts` qui importe `verdictColor` depuis `renderer.js`
**When** l'import est mis à jour
**Then** l'import pointe vers `../utils/format.js`
**And** le comportement est identique

**Given** `src/utils/index.ts` qui re-exporte depuis `renderer.js`
**When** les exports sont mis à jour
**Then** les fonctions de formatage sont re-exportées depuis `format.js`
**And** les exports `createRenderer`, `Renderer`, `RendererOptions` sont supprimés

**Given** le projet après l'extraction
**When** `npm run test && npm run typecheck` est lancé
**Then** tout passe sans erreur

### Story 15.2 : Installation de listr2 et nettoyage des dépendances

As a développeur d'Anatoly,
I want que listr2 soit installé et que les dépendances inutilisées soient retirées,
So that le bundle soit plus léger et que les outils disponibles correspondent à ce qui est réellement utilisé.

**Acceptance Criteria:**

**Given** le `package.json` actuel
**When** les dépendances sont mises à jour
**Then** `listr2` (v10+) est ajouté aux dependencies
**And** `ora` est supprimé (importé nulle part dans le code)
**And** `log-update` est supprimé (importé nulle part dans le code)
**And** `ansi-escapes` est supprimé (utilisé uniquement par le renderer supprimé)

**Given** le projet après la mise à jour des dépendances
**When** `npm run build` est lancé
**Then** la build réussit sans erreur

### Story 15.3 : Réécriture de review.ts avec listr2

As a développeur,
I want que la commande `anatoly review` utilise listr2 pour afficher la progression,
So that le feedback soit propre avec spinners natifs et fallback CI automatique.

**Acceptance Criteria:**

**Given** un projet scanné avec des fichiers PENDING
**When** je lance `npx anatoly review`
**Then** un task tree listr2 affiche la progression :
```
✔ Scan — 42 files
⠋ [3/12] reviewing src/core/scanner.ts
```
**And** chaque fichier terminé affiche son verdict en output persistant (ex: `✓ src-core-scanner.rev.md  CLEAN`)

**Given** un environnement non-TTY (pipe, CI)
**When** je lance `npx anatoly review | cat`
**Then** listr2 utilise automatiquement le SimpleRenderer (output linéaire)

**Given** le flag `--plain`
**When** je lance `npx anatoly review --plain`
**Then** le renderer est forcé en mode `simple`

**Given** la commande review terminée
**When** tous les fichiers sont reviewés
**Then** un résumé est affiché via `console.log` après le task tree :
```
review complete — 12 files | 3 findings | 9 clean
  reviews      .anatoly/reviews/
  transcripts  .anatoly/logs/
```

**Given** un audit en cours
**When** je presse Ctrl+C
**Then** le flag `interrupted` est mis à true, l'AbortController est aborté
**And** le task en cours se termine et le résumé partiel est affiché

**Given** l'import `createRenderer` dans review.ts
**When** la réécriture est terminée
**Then** `createRenderer` n'est plus importé — remplacé par `new Listr()`
**And** `import { Listr } from 'listr2'` est utilisé
**And** `npm run typecheck` passe

### Story 15.4 : Réécriture de run.ts avec listr2 et worker slots

As a développeur,
I want que la commande `anatoly run` utilise listr2 pour le pipeline complet avec worker slots concurrents,
So that je voie chaque phase du pipeline progresser et les reviews parallèles s'afficher en temps réel.

**Acceptance Criteria:**

**Given** un projet TypeScript valide
**When** je lance `npx anatoly run`
**Then** un task tree listr2 affiche le pipeline séquentiellement :
```
✔ Scan — 60 files
✔ Estimate — 60 files, ~1.2M tokens
✔ RAG index — 42 new / 128 total cards
⠋ Reviewing [18/60]
  ⠋ [1] src/core/scanner.ts
  ⠋ [2] src/utils/cache.ts
  ⠋ [3] src/rag/indexer.ts
  ✔ [4] done
◼ Generating report
```

**Given** `--concurrency 4` avec 60 fichiers PENDING
**When** la phase review démarre
**Then** 4 subtasks concurrentes sont créées (worker slots)
**And** chaque slot affiche le fichier en cours via `slot.title`
**And** chaque fichier terminé affiche le verdict via `slot.output` avec `persistentOutput: true`
**And** le parent task affiche le compteur `Reviewing [N/60]`

**Given** la phase review avec concurrence
**When** un worker termine un fichier et le slot se libère
**Then** le fichier suivant dans la queue est immédiatement pris par le même slot
**And** aucun fichier n'est traité deux fois (compteur atomique partagé `nextIndex++`)

**Given** la phase RAG index (si activée)
**When** l'indexation est en cours
**Then** les messages de log sont affichés via `task.output`
**And** la progression est reflétée dans le titre de la tâche

**Given** les launch params (model, concurrency, run-id, etc.)
**When** le pipeline démarre
**Then** les params sont affichés via `console.log` **avant** `tasks.run()`

**Given** le pipeline terminé
**When** le report est généré
**Then** le résumé de complétion est affiché via `console.log` **après** `tasks.run()` :
```
review complete — 60 files | 12 findings | 48 clean
  run       2026-02-24-abc
  report    .anatoly/runs/2026-02-24-abc/report.md
  reviews   .anatoly/runs/2026-02-24-abc/reviews/
  transcripts .anatoly/runs/2026-02-24-abc/logs/
```

**Given** un audit en cours avec 3 reviews en vol
**When** je presse Ctrl+C
**Then** tous les AbortControllers actifs sont abortés
**And** le flag `interrupted` est mis à true
**And** les worker slots terminent leur boucle et le résumé partiel est affiché

**Given** un rate limit 429 pendant une review
**When** le backoff est activé
**Then** le message de retry est affiché via `slot.output` : `rate limited — retrying in Xs (attempt N/5)`

**Given** le mode `--verbose`
**When** un fichier est terminé
**Then** le temps, le coût et les retries sont affichés via `slot.output`

### Story 15.5 : Suppression du renderer custom et nettoyage final

As a développeur d'Anatoly,
I want que le renderer custom et les deps associées soient entièrement supprimés,
So that le codebase soit propre et ne contienne plus de code mort.

**Acceptance Criteria:**

**Given** la réécriture de `run.ts` et `review.ts` terminée
**When** le nettoyage est effectué
**Then** `src/utils/renderer.ts` est supprimé entièrement
**And** `src/utils/renderer.test.ts` est supprimé entièrement
**And** aucun fichier du projet n'importe depuis `renderer.js`

**Given** le `package.json` après nettoyage
**When** les dépendances sont vérifiées
**Then** `ansi-escapes`, `ora`, `log-update` ne sont plus présents
**And** `chalk` est toujours présent (utilisé dans tout le projet)
**And** `listr2` est présent

**Given** le projet nettoyé
**When** `npm run test && npm run build && npm run typecheck` est lancé
**Then** tout passe sans erreur

**Given** le pipeline complet
**When** les tests E2E suivants sont exécutés manuellement :
- `anatoly run` — pipeline complet avec rendu listr2
- `anatoly run --concurrency 4` — worker slots concurrents
- `anatoly run | cat` — fallback SimpleRenderer
- `NO_COLOR=1 anatoly run` — sans couleurs
- `anatoly run --plain` — forcer SimpleRenderer
- Ctrl+C pendant review — graceful shutdown
- `anatoly review` — mode séquentiel
- `anatoly status` / `anatoly report` — pas de régression
**Then** chaque scénario fonctionne correctement

---

## Epic 16 : Intelligence pré-review — Triage & Graphe d'usage
**Status: Done** (v0.3.0)

Le développeur bénéficie d'un triage automatique des fichiers en 3 tiers (skip/fast/deep) et d'un graphe d'imports pré-calculé en une seule passe locale (< 1s). Ces deux pré-calculs éliminent les reviews inutiles sur les fichiers triviaux et suppriment les ~90 greps redondants que l'agent exécutait pour vérifier l'usage des exports.

**Version cible :** v0.4.0
**NFRs impactées :** NFR5 (temps moyen premier rapport — amélioration majeure)
**Dépendances :** Epic 1 (scanner AST, tasks), Epic 3 (reviewer, prompt-builder), Epic 10 (pipeline parallèle)
**Spec source :** `_bmad-output/planning-artifacts/scaling+agentic-ready.md` — Axes 1 & 2

**Risques techniques identifiés :**
- Faux négatifs du triage : un fichier classé `skip` ou `fast` qui aurait eu des findings en `deep` → flag `--no-triage` pour comparaison et debug
- Résolution des chemins d'import (ESM .js→.ts, /index.ts, path aliases) → couvrir les cas TS standards, ignorer les edge cases exotiques
- Namespace imports (`import * as X`) comptent comme usage de tous les exports → approximation acceptable, évite les faux DEAD

### Story 16.1 : Module triage — classification skip/fast/deep

As a développeur,
I want qu'Anatoly classe automatiquement chaque fichier en tier skip/fast/deep avant la review,
So that les fichiers triviaux (barrels, types purs, constantes) ne lancent jamais d'agent LLM et que les fichiers simples utilisent une review allégée.

**Acceptance Criteria:**

**Given** un fichier barrel export (0 symboles, uniquement des `export {} from`)
**When** `triageFile(task, source)` est appelé
**Then** le résultat est `{ tier: 'skip', reason: 'barrel-export' }`

**Given** un fichier < 10 lignes avec 0-1 symbole
**When** `triageFile(task, source)` est appelé
**Then** le résultat est `{ tier: 'skip', reason: 'trivial' }`

**Given** un fichier type-only (tous les symboles sont `type` ou `enum`)
**When** `triageFile(task, source)` est appelé
**Then** le résultat est `{ tier: 'skip', reason: 'type-only' }`

**Given** un fichier de constantes pures (tous les symboles sont `constant`)
**When** `triageFile(task, source)` est appelé
**Then** le résultat est `{ tier: 'skip', reason: 'constants-only' }`

**Given** un fichier < 50 lignes avec < 3 symboles
**When** `triageFile(task, source)` est appelé
**Then** le résultat est `{ tier: 'fast', reason: 'simple' }`

**Given** un fichier sans aucun export (tous les symboles `exported: false`)
**When** `triageFile(task, source)` est appelé
**Then** le résultat est `{ tier: 'fast', reason: 'internal' }`

**Given** un fichier complexe (≥ 50 lignes ou ≥ 3 symboles avec exports)
**When** `triageFile(task, source)` est appelé
**Then** le résultat est `{ tier: 'deep', reason: 'complex' }`

**Given** un fichier classé `skip`
**When** `generateSkipReview(task, reason)` est appelé
**Then** un `ReviewFile` valide est retourné avec :
- `verdict: 'CLEAN'`, `is_generated: true`, `skip_reason: reason`
- Chaque symbole : `OK / LEAN / USED / UNIQUE / NONE`, confidence 100
- `actions: []`, `file_level: { unused_imports: [], circular_dependencies: [], general_notes: '' }`
**And** aucun appel API n'est effectué

**Given** le module triage
**When** les tests unitaires sont exécutés (`npm run test -- src/core/triage.test.ts`)
**Then** tous les tests passent couvrant chaque tier et chaque reason

### Story 16.2 : Graphe d'usage pré-calculé

As a développeur,
I want qu'Anatoly scanne tous les imports du projet en une passe locale avant les reviews,
So that l'agent n'ait plus besoin de grep pour vérifier si un export est USED ou DEAD.

**Acceptance Criteria:**

**Given** un projet TypeScript avec des imports `import { A, B as C } from './path'`
**When** `buildUsageGraph(projectRoot, tasks)` est appelé
**Then** la map `usages` contient les entrées `A::resolvedPath` et `B::resolvedPath` avec les fichiers importeurs

**Given** un import default (`import Default from './path'`)
**When** le graphe est construit
**Then** le symbole `default` est tracké avec le fichier importeur

**Given** un namespace import (`import * as X from './path'`)
**When** le graphe est construit
**Then** tous les exports du fichier source sont comptés comme utilisés

**Given** un import relatif `'./utils/cache'`
**When** la résolution de chemin est effectuée
**Then** le chemin est résolu vers `src/utils/cache.ts` ou `src/utils/cache/index.ts`
**And** les extensions `.js` (ESM) sont strippées et remappées vers `.ts`

**Given** un import de node_modules (`import chalk from 'chalk'`)
**When** le graphe est construit
**Then** l'import est ignoré (pas de résolution)

**Given** `getSymbolUsage(graph, 'myFunction', 'src/core/utils.ts')`
**When** `myFunction` est importé par 3 fichiers
**Then** la fonction retourne `['src/commands/run.ts', 'src/commands/watch.ts', 'src/core/reviewer.ts']`

**Given** le graphe d'usage construit sur un projet de 500 fichiers
**When** le temps d'exécution est mesuré
**Then** la construction prend < 2s (scan purement local, pas d'appel LLM)

**Given** le module usage-graph
**When** les tests unitaires sont exécutés (`npm run test -- src/core/usage-graph.test.ts`)
**Then** tous les tests passent couvrant les imports nommés, default, namespace, résolution de chemin, et node_modules ignorés

### Story 16.3 : Injection du graphe d'usage dans le prompt agent

As a développeur,
I want que les données d'usage pré-calculées soient injectées dans le prompt des reviews deep,
So that l'agent n'utilise plus Grep pour vérifier l'usage des exports et économise ~5-10 turns par review.

**Acceptance Criteria:**

**Given** le prompt builder avec un `usageGraph` dans `PromptOptions`
**When** `buildSystemPrompt(task, options)` est appelé avec un graphe renseigné
**Then** une section `## Pre-computed Import Analysis` est ajoutée au system prompt, avant les rules
**And** chaque symbole exporté affiche son nombre d'importeurs et les fichiers :
```
- functionA (exported): imported by 3 files: src/commands/run.ts, src/commands/watch.ts, src/core/reviewer.ts
- helperB (exported): imported by 0 files ⚠️ LIKELY DEAD
- internalFn (not exported): internal only — check for local usage within this file
```

**Given** les rules du prompt agent
**When** le graphe d'usage est disponible
**Then** une règle supplémentaire est ajoutée :
```
For **utility** axis on exported symbols: use the Pre-computed Import Analysis above.
Do NOT grep for imports — this data is exhaustive.
If a symbol shows 0 importers, mark as utility: "DEAD" (confidence: 95).
If a symbol shows 1+ importers, mark as utility: "USED".
For non-exported symbols, verify local usage by reading the file only.
```

**Given** `PromptOptions`
**When** `usageGraph` n'est pas fourni (undefined)
**Then** la section et la règle ne sont pas ajoutées (backward compatible)

**Given** le prompt builder
**When** `npm run typecheck` est lancé
**Then** le nouveau champ `usageGraph?: UsageGraph` dans `PromptOptions` est optionnel et ne casse rien

### Story 16.4 : Intégration triage et usage graph dans le pipeline

As a développeur,
I want que le pipeline `run` intègre le triage et le graphe d'usage comme étapes automatiques,
So that chaque `npx anatoly run` bénéficie de l'accélération sans configuration.

**Acceptance Criteria:**

**Given** un projet avec 40 fichiers PENDING
**When** je lance `npx anatoly run`
**Then** après le scan et l'estimate, une étape triage est exécutée
**And** l'affichage indique la distribution : `triage — 40 files: 8 skip · 14 fast · 18 deep`
**And** le graphe d'usage est construit (< 1s)

**Given** des fichiers classés `skip` par le triage
**When** la phase review démarre
**Then** les fichiers skip sont traités par `generateSkipReview()` + `writeReviewOutput()` + `pm.updateFileStatus(file, 'DONE')`
**And** ils apparaissent immédiatement comme terminés dans le renderer avec indication `CLEAN (skipped)`
**And** aucun appel API n'est effectué pour ces fichiers

**Given** des fichiers classés `deep` par le triage
**When** la phase review les traite
**Then** le comportement est identique à l'actuel, mais avec le graphe d'usage injecté dans le prompt via `promptOptions.usageGraph`

**Given** le flag `--no-triage`
**When** je lance `npx anatoly run --no-triage`
**Then** tous les fichiers sont traités comme tier `deep`
**And** l'étape triage affiche `triage — disabled (--no-triage)`

**Given** l'estimateur dans `estimator.ts`
**When** le triage est actif
**Then** l'estimation utilise des durées par tier : skip=0s, fast=5s, deep=45s
**And** l'estimation totale reflète la distribution réelle

**Given** le CLI dans `cli.ts`
**When** le flag `--no-triage` est ajouté
**Then** il est disponible comme option globale du programme
**And** la valeur est propagée via `parentOpts.triage === false` dans `run.ts`

**Given** les fichiers classés `fast` par le triage
**When** la phase review les rencontre
**Then** ils sont traités comme `deep` (fallback temporaire jusqu'à l'Epic 17)
**And** un commentaire `// TODO: Epic 17 — dispatch to fastReviewFile()` marque le point d'intégration

---

## Epic 17 : Fast review sans tools
**Status: Done** (v0.3.0)

Le développeur bénéficie d'un mode de review allégé pour les fichiers simples (tier `fast` du triage) : un appel `query()` single-turn sans tools, avec le contenu complet du fichier et les données d'usage dans le prompt. Divise par ~6 le temps et le coût de review de ces fichiers (3-8s vs 45s).

**Version cible :** v0.4.0
**NFRs impactées :** NFR5 (temps moyen premier rapport — amélioration directe)
**Dépendances :** Epic 16 (triage classification, usage graph, prompt-builder)
**Spec source :** `_bmad-output/planning-artifacts/scaling+agentic-ready.md` — Axe 3

**Risques techniques identifiés :**
- Qualité du JSON en single-turn : pas de conversation multi-turn pour corriger → retry avec feedback Zod + fallback deep
- Fichiers edge case mal classés `fast` qui nécessitent des tools → le fallback deep absorbe ces cas
- Coût du prompt : le contenu du fichier est inclus dans le prompt → acceptable car < 50 lignes par définition du tier fast

### Story 17.1 : Prompt simplifié et module fast-reviewer

As a développeur,
I want qu'un prompt dédié et un module fast-reviewer permettent de review les fichiers simples en single-turn sans tools,
So that les fichiers tier `fast` soient reviewés en 3-8s au lieu de 45s avec la même qualité d'analyse.

**Acceptance Criteria:**

**Given** le prompt builder
**When** `buildFastSystemPrompt(task, options)` est appelé
**Then** un system prompt simplifié est généré :
- Sans instructions sur les tools (Read/Grep/Glob) puisqu'il n'y en a pas
- L'axe `utility` se base uniquement sur les données d'usage pré-calculées (graphe)
- L'axe `duplication` se base uniquement sur le RAG pré-résolu
- Pas d'exemples d'investigation — le contexte est complet dans le prompt
- Le prompt insiste : "All context is provided. Output ONLY the JSON."

**Given** le user message du fast reviewer
**When** il est construit pour un fichier
**Then** il inclut directement :
- Le contenu complet du fichier (inline dans le prompt)
- La liste des symboles extraits par le scanner
- Les données d'usage pré-calculées
- Les résultats RAG pré-résolus (si disponibles)
- Les données de coverage (si disponibles)

**Given** un fichier tier `fast`
**When** `fastReviewFile(task, fileContent, config, promptOptions)` est appelé
**Then** un `query()` est lancé avec `maxTurns: 1`, aucun tool, `permissionMode: 'bypassPermissions'`
**And** le pattern est identique à celui de `card-generator.ts` (L60-69)
**And** la réponse JSON est parsée et validée via `tryParseReview`

**Given** une réponse JSON invalide (échec Zod)
**When** le premier `query()` échoue la validation
**Then** un second `query()` est lancé avec le feedback Zod (via `formatRetryFeedback`), toujours `maxTurns: 1`
**And** si le retry réussit, la review est retournée normalement

**Given** deux échecs Zod consécutifs (premier appel + retry)
**When** le fast reviewer ne parvient pas à produire un JSON valide
**Then** le fichier est promu en `deep` et relancé avec `reviewFile()` (agent complet)
**And** un warning est loggé : `fast review failed for {file} — promoting to deep review`

**Given** un `.transcript.md` pour la fast review
**When** la review est terminée
**Then** un transcript simplifié est écrit dans le run dir (prompt + réponse, pas de tool calls)

**Given** le module fast-reviewer
**When** les tests unitaires sont exécutés (`npm run test -- src/core/fast-reviewer.test.ts`)
**Then** tous les tests passent couvrant : succès premier appel, succès retry, fallback deep, transcript

### Story 17.2 : Configuration fast_model et intégration pipeline

As a développeur,
I want que les fichiers tier `fast` soient dispatchés au fast-reviewer dans le pipeline et que je puisse optionnellement utiliser un modèle moins cher,
So that le gain de performance soit effectif de bout en bout et le coût soit optimisable.

**Acceptance Criteria:**

**Given** la configuration `.anatoly.yml`
**When** un champ `llm.fast_model` est présent (ex: `claude-haiku-4-5-20251001`)
**Then** le fast reviewer utilise ce modèle au lieu du modèle principal
**And** la valeur est optionnelle — si absente, le modèle principal est utilisé

**Given** le schema `LlmConfigSchema` dans `config.ts`
**When** le champ `fast_model` est ajouté
**Then** il est de type `z.string().optional()` avec default = undefined (fallback au modèle principal)

**Given** le pipeline `run.ts` avec le triage actif (Epic 16)
**When** des fichiers sont classés tier `fast`
**Then** ils sont dispatchés à `fastReviewFile()` au lieu de `reviewFile()`
**And** le TODO commentaire de l'Epic 16 est remplacé par l'appel réel

**Given** le pool de concurrence existant
**When** les fichiers `fast` et `deep` sont reviewés en parallèle
**Then** ils partagent le même sémaphore de concurrence
**And** le même rate limiter et backoff s'appliquent
**And** la même gestion d'erreur et le même flow Listr s'appliquent

**Given** un fichier `fast` promu en `deep` (fallback après 2 échecs Zod)
**When** la promotion a lieu pendant la phase review
**Then** le fichier est re-dispatché à `reviewFile()` dans le même slot worker
**And** le compteur de progression reflète toujours le bon total

**Given** le résumé de fin de pipeline
**When** le triage était actif
**Then** les compteurs distinguent les types de review : `8 skipped · 14 fast · 18 deep`

---

## Epic 18 : Report shardé avec index à checkboxes
**Status: Done** (v0.3.0)

Le développeur consulte un rapport découpé en un index court (~100 lignes) et des shards de 10 fichiers maximum, triés par sévérité décroissante. Le format checkbox Markdown prépare le pilotage par un futur agent de correction automatique.

**Version cible :** v0.4.0
**FRs couvertes :** FR14 (rapport agrégé — évolution shardée)
**Dépendances :** Epic 4 (reporter original)
**Spec source :** `_bmad-output/planning-artifacts/scaling+agentic-ready.md` — Axe 4

**Risques techniques identifiés :**
- Backward compatibility : `report.md` doit rester le point d'entrée principal (`--open`, terminal summary)
- Tri par sévérité : la fonction `computeFileVerdict` et `symbolSeverity` doivent être cohérentes avec les verdicts existants
- Cas limites : 0 findings, ≤ 10 findings, fichiers en erreur — chacun doit être géré proprement

### Story 18.1 : Refonte reporter — index + shards triés par sévérité

As a développeur,
I want que le rapport soit découpé en un index et des shards de 10 fichiers,
So that le rapport reste lisible à grande échelle et qu'un agent puisse traiter les findings shard par shard.

**Acceptance Criteria:**

**Given** un audit avec 62 fichiers ayant des findings
**When** `generateReport()` est appelé
**Then** les fichiers de sortie sont :
- `report.md` — index avec résumé exécutif, tableau de sévérités, liens vers shards avec checkboxes
- `report.1.md` — shard 1, 10 fichiers les plus sévères
- `report.2.md` à `report.7.md` — shards suivants de 10 fichiers chacun
**And** les fichiers CLEAN n'apparaissent dans aucun shard (juste comptés dans le sommaire)

**Given** l'index `report.md`
**When** il est généré
**Then** il contient :
- Un résumé exécutif (files reviewed, global verdict, tableau par catégorie/sévérité)
- Compteurs : files with findings, clean files, files in error
- Une liste de shards avec checkboxes Markdown `- [ ]` et lien relatif
- Chaque ligne de shard indique la composition : `10 files (3 CRITICAL, 7 NEEDS_REFACTOR)`
- Section Metadata allégée
**And** l'index fait toujours < ~100 lignes quelle que soit la taille de la codebase

**Given** chaque shard `report.{n}.md`
**When** il est généré
**Then** il contient au maximum 10 fichiers avec findings
**And** les sections Findings (tableau), Quick Wins, Refactors, Hygiene sont présentes
**And** le tri Quick Wins → Refactors → Hygiene est conservé à l'intérieur du shard
**And** les actions ne concernent que les fichiers couverts par ce shard

**Given** les fichiers avec findings
**When** le tri pour le sharding est effectué
**Then** les fichiers sont triés par :
1. Verdict (CRITICAL d'abord, puis NEEDS_REFACTOR)
2. Nombre de findings high severity (décroissant)
3. Confidence max (décroissante)
**And** shard 1 contient toujours les fichiers les plus urgents

**Given** un audit avec 0 findings
**When** `generateReport()` est appelé
**Then** aucun shard n'est créé
**And** l'index affiche "All files clean" dans la section shards

**Given** un audit avec ≤ 10 findings
**When** `generateReport()` est appelé
**Then** un seul shard `report.1.md` est créé
**And** l'index contient une seule ligne de shard

**Given** le path retourné par `generateReport()`
**When** il est consommé par le reste du pipeline
**Then** le path est toujours `report.md` (l'index)
**And** `--open` ouvre toujours `report.md`
**And** le terminal summary pointe toujours vers `report.md`

**Given** les `.rev.json` et `.rev.md` individuels
**When** le report shardé est généré
**Then** ces fichiers ne changent pas du tout

### Story 18.2 : Section Performance & Triage dans le rapport

As a développeur,
I want que le rapport inclue les statistiques de triage quand celui-ci est actif,
So that je puisse mesurer l'impact de l'optimisation et comparer avec/sans triage.

**Acceptance Criteria:**

**Given** un audit avec triage actif
**When** le rapport est généré avec `triageStats` renseigné
**Then** l'index contient une section `⚡ Performance & Triage` avec :
- Files analyzed, Skip (count + %), Fast review (count + %), Deep review (count + %)
- Estimated time saved

**Given** le type `TriageStats`
**When** il est défini
**Then** il contient : `{ total: number, skip: number, fast: number, deep: number, estimatedTimeSaved: number }`
**And** il est ajouté comme champ optionnel dans `ReportData`

**Given** un audit avec `--no-triage`
**When** le rapport est généré sans `triageStats`
**Then** la section `⚡ Performance & Triage` n'apparaît pas dans l'index

**Given** `generateReport()` dans `reporter.ts`
**When** le paramètre `triageStats` est ajouté
**Then** il est optionnel pour backward compatibility
**And** `npm run typecheck` passe sans erreur

## Epic 19 : Contexte structurel — Arborescence projet dans le pipeline d'évaluation
**Status: Done** (v0.3.0)

Le développeur obtient des évaluations best-practices et overengineering plus précises grâce à l'injection du contexte structurel du projet (arborescence compacte des fichiers/dossiers) dans les prompts des évaluateurs, permettant au LLM de juger le placement des fichiers et l'organisation du code.

**Version cible :** v0.5.0
**FRs couvertes :** FR10 (enrichissement des axes d'analyse)
**NFRs impactées :** NFR1 (zéro faux positif — meilleur contexte), NFR5 (impact minimal sur le temps)
**Dépendances :** Epic 1 (scanner), Epic 16 (usage-graph)

**Risques techniques identifiés :**
- Taille du prompt : l'arborescence doit rester compacte (~50-200 tokens) même sur des codebases de 1000+ fichiers
- L'arborescence doit être cohérente avec les fichiers réellement scannés (même filtrage)
- Ne pas dégrader les performances du pipeline (génération locale, zéro appel LLM)

### Story 19.1 : Génération de l'arborescence projet depuis les fichiers scannés

As a développeur,
I want qu'Anatoly génère automatiquement une arborescence ASCII compacte du projet à partir des fichiers scannés,
So that le pipeline dispose d'une représentation structurelle réutilisable par les évaluateurs.

**Acceptance Criteria:**

**Given** un scan complété avec N fichiers dans `.anatoly/tasks/`
**When** la fonction `buildProjectTree(taskFiles)` est appelée
**Then** elle retourne un string d'arborescence ASCII avec indentation `├──` / `└──` / `│`
**And** seuls les fichiers effectivement scannés apparaissent (cohérence avec le filtrage tinyglobby + git)

**Given** un projet avec 500+ fichiers
**When** l'arborescence est générée
**Then** le résultat fait < 300 tokens (mesuré tiktoken cl100k_base)
**And** les dossiers profonds (> 4 niveaux) sont condensés si nécessaire

**Given** l'arborescence générée
**When** elle est inspectée
**Then** les dossiers sont triés avant les fichiers
**And** le format est lisible par un humain et un LLM

### Story 19.2 : Injection de l'arborescence dans l'axe best-practices

As a développeur,
I want que l'évaluateur best-practices reçoive l'arborescence du projet dans son prompt,
So that il puisse détecter les incohérences de placement de fichiers et l'organisation structurelle.

**Acceptance Criteria:**

**Given** l'`AxisContext` passé à l'évaluateur best-practices
**When** `projectTree` est présent
**Then** le prompt système inclut une section `## Project Structure` avec l'arborescence ASCII
**And** les règles best-practices incluent une évaluation du placement du fichier courant dans la structure

**Given** un fichier `src/commands/string-utils.ts`
**When** l'évaluateur best-practices le review avec l'arborescence
**Then** il peut signaler que ce fichier serait mieux placé dans `src/utils/`
**And** le finding est de type `WARN` avec suggestion actionnable

**Given** un fichier correctement placé (`src/core/scanner.ts`)
**When** l'évaluateur best-practices le review avec l'arborescence
**Then** aucun finding structurel n'est émis

**Given** `projectTree` absent de l'`AxisContext` (ex: erreur de génération)
**When** l'évaluateur best-practices s'exécute
**Then** il fonctionne normalement sans la section structure (graceful degradation)

### Story 19.3 : Injection de l'arborescence dans l'axe overengineering

As a développeur,
I want que l'évaluateur overengineering reçoive l'arborescence du projet,
So that il puisse détecter la fragmentation excessive et les abstractions structurelles inutiles.

**Acceptance Criteria:**

**Given** l'`AxisContext` passé à l'évaluateur overengineering
**When** `projectTree` est présent
**Then** le prompt système inclut l'arborescence et des heuristiques structurelles :
- Dossier avec un seul fichier → fragmentation potentielle
- Arborescence > 5 niveaux de profondeur → complexité structurelle
- Dossier `factories/`, `adapters/`, `abstractions/` avec ≤ 2 fichiers → over-engineering probable

**Given** un fichier dans un dossier `src/factories/` contenant un seul fichier
**When** l'évaluateur overengineering le review
**Then** il peut signaler le dossier comme fragmentation excessive
**And** le rating peut passer de `LEAN` à `OVER` si justifié

**Given** `projectTree` absent de l'`AxisContext`
**When** l'évaluateur overengineering s'exécute
**Then** il fonctionne normalement sans contexte structurel (graceful degradation)

---

## Epic 20 : Extraction des prompts d'évaluation dans des fichiers Markdown dédiés
**Status: Done** (v0.3.0)

Extraire les system prompts hardcodés (template literals TypeScript) de chaque axe d'évaluation dans des fichiers Markdown dédiés (`src/core/axes/prompts/*.system.md`). Les prompts sont chargés au build-time via le loader `text` d'esbuild — zéro I/O runtime, zéro changement fonctionnel.

**Version cible :** v0.5.0
**FRs couvertes :** FR10 (axes d'analyse — maintenabilité des prompts)
**NFRs impactées :** NFR3 (validation Zod — prompts inchangés), NFR5 (zéro impact performance)
**Dépendances :** Epic 19 (axis pipeline — les fichiers d'axes existent déjà)

**Risques techniques identifiés :**
- Trailing newline dans les `.md` (géré par `.trimEnd()`)
- Loader esbuild `.md` → `text` doit être configuré pour tsup ET vitest
- Le prompt `best-practices` inclut une `RULES_TABLE` interpolée — doit être inlinée dans le `.md`

### Story 20.1 : Infrastructure d'import Markdown (build-time)

As a développeur d'Anatoly,
I want que le build pipeline (tsup) et le test runner (vitest) sachent importer des fichiers `.md` comme des strings,
So that les prompts puissent être externalisés dans des fichiers Markdown sans I/O runtime.

**Acceptance Criteria:**

**Given** un fichier `src/types/md.d.ts` avec la déclaration `declare module '*.md'`
**When** un fichier TypeScript fait `import content from './foo.md'`
**Then** TypeScript accepte l'import sans erreur de typage
**And** `content` est typé comme `string`

**Given** la config `tsup.config.ts` avec `esbuildOptions` configurant `.md` → `text`
**When** `npm run build` est exécuté
**Then** le contenu des fichiers `.md` importés est inliné comme string dans le bundle
**And** aucun fichier `.md` n'est nécessaire à l'exécution

**Given** la config `vitest.config.ts` avec un plugin Vite `raw-md`
**When** `npm run test` est exécuté
**Then** les imports `.md` sont résolus correctement dans l'environnement de test
**And** tous les tests existants passent

### Story 20.2 : Extraction des 6 prompts système dans des fichiers Markdown

As a développeur d'Anatoly,
I want que les system prompts des 6 axes d'évaluation soient dans des fichiers Markdown dédiés,
So that je puisse lire, modifier et reviewer les instructions LLM sans toucher au code TypeScript.

**Acceptance Criteria:**

**Given** le dossier `src/core/axes/prompts/` avec 6 fichiers `.system.md`
**When** le contenu de chaque `.md` est comparé au template literal original
**Then** le texte est strictement identique (backticks dé-échappés, pas de `${}`)

**Given** le fichier `best-practices.system.md`
**When** il est inspecté
**Then** il contient la table complète des 17 règles TypeGuard v2 (sévérités et pénalités) inline
**And** aucune interpolation `${RULES_TABLE}` n'est nécessaire

**Given** un fichier `.system.md` ouvert dans un éditeur
**When** le développeur le lit
**Then** le contenu bénéficie du syntax highlighting Markdown natif
**And** les backticks ne sont pas échappés (contrairement aux template literals)

### Story 20.3 : Refactoring des builders TypeScript pour utiliser les imports .md

As a développeur d'Anatoly,
I want que les fonctions `buildXxxSystemPrompt()` importent le contenu depuis les fichiers `.md` au lieu de template literals inline,
So that la logique métier (Zod, user messages, evaluators) soit séparée des instructions LLM.

**Acceptance Criteria:**

**Given** chaque fichier d'axe (`utility.ts`, `duplication.ts`, `correction.ts`, `overengineering.ts`, `tests.ts`, `best-practices.ts`)
**When** la fonction `buildXxxSystemPrompt()` est appelée
**Then** elle retourne le contenu du fichier `.md` correspondant (via import build-time)
**And** un `.trimEnd()` est appliqué pour garantir l'absence de trailing newline

**Given** la constante `RULES_TABLE` dans `best-practices.ts`
**When** le refactoring est terminé
**Then** la constante est supprimée
**And** son contenu est dans `best-practices.system.md`

**Given** les 6 fichiers de test existants (`*.test.ts`)
**When** `npm run test` est exécuté après le refactoring
**Then** tous les tests passent sans aucune modification
**And** les assertions `toContain()` validant le contenu des prompts réussissent

**Given** le build final
**When** `npm run typecheck && npm run build && npm run test` est exécuté
**Then** les 3 commandes réussissent
**And** la taille du bundle est quasi identique (les strings sont inlinées au build)

---

## Epic 21 : Opus Deliberation Pass — Validation post-merge inter-axes
**Status: Done** (v0.4.0)

Le développeur bénéficie d'une validation intelligente des findings par Opus après la fusion des 6 axes. Le "juge de délibération" reçoit le `ReviewFile` fusionné + le code source et arbitre la cohérence inter-axes : il peut ajuster les confidences, reclassifier des findings, filtrer les faux positifs résiduels, et recalculer le verdict final.

**Version cible :** v0.5.0
**FRs couvertes :** FR10 (axes d'analyse — cohérence), FR11 (validation Zod)
**NFRs impactées :** NFR1 (zéro faux positif — amélioration directe), NFR2 (faux positifs — arbitrage Opus)
**Dépendances :** Epic 16 (axis merger + file evaluator), Epic 3 (axis-evaluator framework)

**Risques techniques identifiés :**
- Coût Opus ~10× Sonnet → atténué par déclenchement conditionnel (~25% des fichiers)
- Latence +15-30s par fichier délibéré → impact total modéré car séquentiel post-merge
- Opus pourrait être trop conservateur et supprimer des findings légitimes → seuil de confidence minimal dans le prompt
- Timeout Opus plus long que Sonnet → timeout dédié dans la config

### Story 21.1 : Configuration et flags CLI pour la délibération

As a développeur,
I want configurer la passe de délibération Opus via `.anatoly.yml` et/ou flags CLI,
So that je puisse activer ou désactiver cette feature premium selon mes besoins.

**Acceptance Criteria:**

**Given** le fichier `src/schemas/config.ts`
**When** le `LlmConfigSchema` est inspecté
**Then** il contient `deliberation: z.boolean().default(false)` et `deliberation_model: z.string().default('claude-opus-4-6')`

**Given** la commande CLI `anatoly run`
**When** le flag `--deliberation` est passé
**Then** `config.llm.deliberation` est mis à `true` (override de la config YAML)

**Given** la commande CLI `anatoly run --no-deliberation`
**When** la config YAML contient `deliberation: true`
**Then** la délibération est désactivée (le flag CLI a priorité)

**Given** la fonction `resolveAxisModel()` dans `axis-evaluator.ts`
**When** un composant demande le modèle de délibération
**Then** une nouvelle fonction `resolveDeliberationModel(config)` retourne `config.llm.deliberation_model`

### Story 21.2 : Module deliberation.ts — Schéma Zod et prompt builder

As a développeur d'Anatoly,
I want un module `deliberation.ts` avec un schéma Zod de réponse et des prompts dédiés,
So that le juge Opus puisse arbitrer les findings de manière structurée et validée.

**Acceptance Criteria:**

**Given** le fichier `src/core/deliberation.ts`
**When** il est inspecté
**Then** il exporte un `DeliberationResponseSchema` Zod contenant :
- `verdict: z.enum(['CLEAN', 'NEEDS_REFACTOR', 'CRITICAL'])`
- `symbols: z.array(DeliberationSymbolSchema)` où chaque symbole contient : `name`, `original_correction`, `deliberated_correction`, `original_confidence`, `deliberated_confidence`, `reasoning`
- `removed_actions: z.array(z.number())` (IDs des actions à retirer)
- `reasoning: z.string().min(20)` (raisonnement global)

**Given** la fonction `buildDeliberationSystemPrompt()`
**When** elle est appelée
**Then** elle retourne un prompt système qui :
- Définit le rôle d'Opus comme "juge de délibération post-merge"
- Interdit l'ajout de nouveaux findings (uniquement reclassification)
- Interdit de rétrograder des findings ERROR confirmés par la correction two-pass
- Demande un raisonnement explicite pour chaque changement de classification
- Exige une confidence ≥ 85 pour toute reclassification

**Given** la fonction `buildDeliberationUserMessage(review, fileContent)`
**When** elle est appelée avec un `ReviewFile` fusionné et le code source
**Then** elle retourne un message utilisateur contenant :
- Le `ReviewFile` complet en JSON (symboles, actions, verdict, best_practices)
- Le code source du fichier
- Les instructions de délibération

### Story 21.3 : Logique needsDeliberation et applyDeliberation

As a développeur d'Anatoly,
I want des fonctions pour décider si un fichier nécessite une délibération et pour appliquer le résultat,
So that Opus ne soit invoqué que sur les cas ambigus et que ses ajustements soient correctement intégrés.

**Acceptance Criteria:**

**Given** la fonction `needsDeliberation(review: ReviewFile)`
**When** elle est appelée avec un fichier CLEAN et toutes les confidences ≥ 95
**Then** elle retourne `false`

**Given** la fonction `needsDeliberation(review: ReviewFile)`
**When** elle est appelée avec un fichier ayant au moins un symbole NEEDS_FIX, ERROR, DEAD, DUPLICATE, ou OVER
**Then** elle retourne `true`

**Given** la fonction `needsDeliberation(review: ReviewFile)`
**When** elle est appelée avec un fichier CLEAN mais au moins un symbole avec confidence < 70
**Then** elle retourne `true` (confidence basse → incertitude → délibération utile)

**Given** la fonction `applyDeliberation(review, deliberation)`
**When** elle est appelée avec un `ReviewFile` et une `DeliberationResponse`
**Then** elle retourne un nouveau `ReviewFile` avec :
- Les corrections reclassifiées par Opus (ex: NEEDS_FIX → OK)
- Les confidences ajustées
- Les actions supprimées si leur symbole a été reclassifié
- Le verdict recalculé
- Le `detail` de chaque symbole enrichi d'un suffixe `(deliberated: <reason>)` si modifié

**Given** la fonction `applyDeliberation`
**When** Opus tente de rétrograder un ERROR à OK
**Then** la rétrogradation n'est appliquée que si la confidence Opus est ≥ 95 (seuil de sécurité pour les erreurs critiques)

### Story 21.4 : Intégration dans file-evaluator.ts

As a développeur d'Anatoly,
I want que la passe de délibération soit intégrée dans le pipeline du file-evaluator après le merge,
So that chaque fichier évalué passe par le juge Opus quand la feature est activée.

**Acceptance Criteria:**

**Given** `config.llm.deliberation === true`
**When** `evaluateFile()` termine le merge des 6 axes et obtient un `ReviewFile`
**Then** si `needsDeliberation(review)` retourne `true` :
- Un appel `runSingleTurnQuery()` est effectué avec le modèle `deliberation_model` et le `DeliberationResponseSchema`
- Le résultat est appliqué via `applyDeliberation()`
- Le coût et la durée sont ajoutés aux totaux
- Le transcript de délibération est appendé au transcript global sous `## Deliberation Pass`
- `axis_meta.deliberation` est ajouté au `ReviewFile`

**Given** `config.llm.deliberation === false`
**When** `evaluateFile()` termine le merge des 6 axes
**Then** aucun appel Opus n'est effectué (pipeline identique à v0.4)

**Given** `config.llm.deliberation === true` et `needsDeliberation()` retourne `false`
**When** `evaluateFile()` termine le merge
**Then** aucun appel Opus n'est effectué (le fichier est CLEAN avec haute confidence)
**And** le transcript contient `## Deliberation Pass — SKIPPED (clean with high confidence)`

**Given** un appel Opus qui échoue (timeout, erreur API, validation Zod)
**When** `evaluateFile()` traite l'erreur
**Then** le `ReviewFile` brut (pré-délibération) est conservé sans modification
**And** le transcript contient `## Deliberation Pass — FAILED (keeping merged results)`
**And** un warning est émis sur stderr

### Story 21.5 : Tests unitaires et d'intégration

As a développeur d'Anatoly,
I want des tests complets pour le module de délibération,
So that les reclassifications soient fiables et les edge cases couverts.

**Acceptance Criteria:**

**Given** le fichier `src/core/deliberation.test.ts`
**When** les tests sont exécutés
**Then** les cas suivants sont couverts :
- `needsDeliberation` retourne `false` pour un fichier CLEAN 95%+ confidence
- `needsDeliberation` retourne `true` pour un fichier avec NEEDS_FIX
- `needsDeliberation` retourne `true` pour un fichier CLEAN avec confidence < 70
- `applyDeliberation` reclassifie correctement un symbole NEEDS_FIX → OK
- `applyDeliberation` supprime les actions liées à un symbole reclassifié
- `applyDeliberation` recalcule le verdict après reclassification
- `applyDeliberation` refuse de rétrograder ERROR → OK si confidence Opus < 95
- `applyDeliberation` enrichit le detail avec le suffixe `(deliberated: ...)`
- Le `DeliberationResponseSchema` valide correctement les réponses conformes
- Le `DeliberationResponseSchema` rejette les réponses malformées

**Given** le fichier `src/core/file-evaluator.test.ts` (si existant)
**When** les tests d'intégration sont exécutés
**Then** un test vérifie que la délibération est appelée quand `config.llm.deliberation === true` et que le fichier n'est pas CLEAN
**And** un test vérifie que la délibération est skippée quand le fichier est CLEAN 95%+
**And** un test vérifie le comportement graceful en cas d'échec de la délibération

**Given** `npm run typecheck && npm run build && npm run test`
**When** exécuté après l'implémentation complète
**Then** les 3 commandes réussissent sans erreur

## Epic 22 : README Badge Injection — Backlink organique post-audit
**Status: Done** (v0.4.0)

Après un audit Anatoly réussi, un badge "Checked by Anatoly" est automatiquement injecté en fin de `README.md` du projet cible. Le badge utilise le format shields.io, est entouré de markers HTML pour garantir l'idempotence, et crée des backlinks organiques pour la découvrabilité et le SEO. Le badge est activé par défaut et désactivable via `--no-badge` ou config `.anatoly.yml`. Un mode verdict optionnel colore le badge selon le résultat de l'audit (CLEAN/NEEDS_REFACTOR/CRITICAL).

**Version cible :** v0.5.0
**FRs couvertes :** FR14 (rapport agrégé — enrichissement post-report), FR16 (configuration `.anatoly.yml`), FR17 (options CLI globales)
**NFRs impactées :** NFR8 (lecture seule — exception documentée : README.md est de la documentation, pas du code source ; opt-out via `--no-badge` ou `badge.enabled: false`), NFR9 (zéro interruption — injection silencieuse, aucun prompt)
**Dépendances :** Epic 5 (pipeline complet — point d'intégration post-report dans `run.ts`)

**Risques techniques identifiés :**
- README.md read-only en environnement CI → atténué par catch EACCES + warn stderr sans crash
- Surprise utilisateur au premier run (badge non sollicité) → atténué par hint `(disable with --no-badge)` au premier ajout
- Concurrent badge injection si double instance → atténué par le lock file existant (Epic 5)

### Story 22.1 : Module badge.ts — Injection idempotente et configuration

As a développeur utilisant Anatoly,
I want qu'un badge "Checked by Anatoly" soit injecté automatiquement dans mon README.md après un audit réussi,
So that mon projet affiche un signal de qualité et contribue à la visibilité d'Anatoly via backlinks organiques.

**Acceptance Criteria:**

**Given** le fichier `src/core/badge.ts`
**When** il est inspecté
**Then** il exporte une fonction `injectBadge(options: BadgeOptions): { injected: boolean; updated: boolean }` et une fonction `buildBadgeMarkdown(verdict?, includeVerdict?, link?): string`

**Given** un projet avec un `README.md` existant sans badge Anatoly
**When** `injectBadge({ projectRoot })` est appelé
**Then** un bloc badge encadré par `<!-- checked-by-anatoly -->` et `<!-- /checked-by-anatoly -->` est appendé en fin de fichier
**And** le fichier se termine par exactement un newline après le bloc badge
**And** la fonction retourne `{ injected: true, updated: false }`

**Given** un projet avec un `README.md` contenant déjà les markers `<!-- checked-by-anatoly -->`
**When** `injectBadge({ projectRoot })` est appelé
**Then** le contenu entre les markers est remplacé in-place (position préservée)
**And** la fonction retourne `{ injected: true, updated: true }`

**Given** un projet sans `README.md`
**When** `injectBadge({ projectRoot })` est appelé
**Then** la fonction retourne `{ injected: false, updated: false }` sans erreur

**Given** un `README.md` en read-only (EACCES)
**When** `injectBadge({ projectRoot })` est appelé
**Then** un warning est émis sur stderr
**And** la fonction retourne `{ injected: false, updated: false }` sans throw

**Given** le fichier `src/schemas/config.ts`
**When** le `ConfigSchema` est inspecté
**Then** il contient un champ `badge` avec le schéma : `{ enabled: z.boolean().default(true), verdict: z.boolean().default(false), link: z.string().url().default('https://github.com/r-via/anatoly') }`

**Given** le fichier `src/cli.ts`
**When** la commande `run` est inspectée
**Then** les flags `--no-badge` (désactive l'injection) et `--badge-verdict` (inclut le verdict dans le badge) sont enregistrés

**Given** la commande CLI `anatoly run --no-badge`
**When** la config YAML contient `badge.enabled: true`
**Then** l'injection de badge est désactivée (le flag CLI a priorité)

**Given** le fichier `src/commands/run.ts`
**When** le pipeline `run` termine la phase report avec succès
**Then** `injectBadge()` est appelé si `badge !== false && config.badge.enabled`
**And** si le badge est injecté, une ligne `badge   added in README.md (disable with --no-badge)` est affichée dans le summary
**And** si le badge est mis à jour, une ligne `badge   updated in README.md` est affichée
**And** si `--no-badge` ou `badge.enabled: false`, aucune ligne badge n'est affichée

**Given** le hint `(disable with --no-badge)`
**When** le badge a déjà été injecté précédemment (markers présents)
**Then** le hint n'est plus affiché (uniquement lors du premier ajout)

**Given** le fichier `src/core/badge.test.ts`
**When** les tests sont exécutés
**Then** les cas suivants sont couverts :
- Badge injecté en fin de README avec markers
- Badge mis à jour in-place si markers existent
- Skip silencieux si pas de README
- README vide → badge injecté comme seul contenu
- Normalisation des trailing newlines multiples
- Badge statique (shields.io URL correcte, couleur blue)
- Custom link respecté
- README read-only → warn stderr, pas de throw

### Story 22.2 : Badges dynamiques selon le verdict d'audit

As a développeur utilisant Anatoly,
I want que le badge reflète optionnellement le verdict de l'audit (couleur + label),
So that le badge communique la qualité réelle du code en un coup d'œil.

**Acceptance Criteria:**

**Given** la commande `anatoly run --badge-verdict`
**When** l'audit termine avec verdict `CLEAN`
**Then** le badge est brightgreen avec label `checked by Anatoly — clean`

**Given** la commande `anatoly run --badge-verdict`
**When** l'audit termine avec verdict `NEEDS_REFACTOR`
**Then** le badge est yellow avec label `checked by Anatoly — needs refactor`

**Given** la commande `anatoly run --badge-verdict`
**When** l'audit termine avec verdict `CRITICAL`
**Then** le badge est red avec label `checked by Anatoly — critical`

**Given** la config `.anatoly.yml` avec `badge.verdict: true`
**When** `anatoly run` est exécuté sans flag `--badge-verdict`
**Then** le badge inclut le verdict (la config YAML active la feature)

**Given** la fonction `buildBadgeMarkdown(verdict, includeVerdict, link)`
**When** `includeVerdict` est `false` ou `undefined`
**Then** le badge statique bleu est généré (pas de verdict)

**Given** le fichier `src/core/badge.test.ts`
**When** les tests de verdict sont exécutés
**Then** les cas suivants sont couverts :
- Badge CLEAN → brightgreen + label "clean"
- Badge NEEDS_REFACTOR → yellow + label "needs refactor"
- Badge CRITICAL → red + label "critical"
- `includeVerdict: false` → badge statique bleu
- `includeVerdict: true` sans verdict → badge statique bleu (fallback)

**Given** `npm run typecheck && npm run build && npm run test`
**When** exécuté après l'implémentation complète
**Then** les 3 commandes réussissent sans erreur

## Epic 23 : Observabilité & Logging structuré — Diagnostic à tout moment
**Status: Done** (v0.4.0)

Remplacer l'infrastructure de logging ad-hoc (console.log épars, `verboseLog()` tout-ou-rien, writes stderr non structurés) par un système de logging centralisé, structuré et contextuel. Le développeur peut diagnostiquer n'importe quel problème à tout moment grâce à des niveaux de log granulaires, du contexte automatique (run-id, fichier en cours, axe), et des logs JSON rotatifs persistés sur disque.

**Version cible :** v0.6.0
**FRs couvertes :** FR2 (pipeline orchestré — traçabilité), FR17 (options CLI — `--log-level`, `--log-file`)
**NFRs impactées :** NFR5 (temps moyen premier rapport — overhead logging < 1%), NFR9 (zéro interruption — logging non-bloquant)
**Dépendances :** Epic 5 (pipeline complet — intégration dans `run.ts`), Epic 10 (parallélisation — contexte concurrent)

**Diagnostic actuel :**
| Aspect | État actuel |
|--------|-------------|
| Logger centralisé | Aucun — `console.log` ad-hoc dans 11 fichiers de commandes |
| Niveaux de log | Aucun — tout-ou-rien via `--verbose` flag |
| Logs structurés (JSON) | Aucun — texte libre uniquement |
| Contexte/corrélation | Aucun — pas de run-id, file-path, ou axis-name dans les logs |
| Agrégation d'erreurs | Aucune — 267 blocs try/catch indépendants |
| Rotation/rétention | Aucune — transcripts s'accumulent indéfiniment |
| Filtrage par composant | Aucun — impossible de cibler un module spécifique |

**Risques techniques identifiés :**
- Overhead de logging sur le hot path → atténué par pino (~30K logs/sec) et niveaux conditionnels
- Breaking change sur `--verbose` → atténué par mapping rétrocompatible (`--verbose` = `--log-level debug`)
- Complexité d'AsyncLocalStorage dans le worker pool → atténué par propagation explicite dans `runWorkerPool()`
- Bruit excessif au niveau DEBUG → atténué par filtrage par namespace et sampling configurable

**Choix technologiques :**
| Critère | Choix | Justification |
|---------|-------|---------------|
| Librairie de logging | **pino** | Logger Node.js le plus rapide, ndjson natif, zéro dépendance, API simple |
| Contexte async | **AsyncLocalStorage** | Node.js natif, zéro dépendance, API standard |
| Transport fichier | **pino/file** | Écriture non-bloquante, rotation par taille |
| Formatage humain | **pino-pretty** (devDep) | Formatage colorisé en TTY |

### Story 23.1 : Logger centralisé — Module `logger.ts` et configuration

As a développeur utilisant Anatoly,
I want un système de logging centralisé avec des niveaux granulaires,
So that je puisse contrôler la verbosité des logs selon mes besoins de diagnostic.

**Priority:** P0 — Blocker
**Effort:** ~3h

**Acceptance Criteria:**

**Given** le fichier `src/utils/logger.ts`
**When** il est inspecté
**Then** il exporte :
- `createLogger(options: LoggerOptions): Logger` — factory qui crée une instance pino configurée
- `getLogger(): Logger` — singleton accessor
- `initLogger(options: LoggerOptions): Logger` — initialise le singleton
- `LoggerOptions` type : `{ level?, logFile?, pretty?, namespace? }`
- `LogLevel` union type : `'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'`

**Given** un appel à `initLogger({ level: 'debug' })`
**When** le logger est utilisé
**Then** les messages de niveau `debug` et supérieur sont émis, `trace` supprimé

**Given** le flag `--log-level trace` en mode TTY
**Then** les logs sont formatés en mode lisible (pino-pretty) sur stderr avec couleurs par niveau

**Given** l'absence de flag `--log-level`
**Then** le niveau par défaut est `warn` (comportement actuel préservé)

**Given** le flag `--verbose` seul
**Then** il est équivalent à `--log-level debug` (rétrocompatibilité)

**Given** `ANATOLY_LOG_LEVEL` définie
**Then** elle est utilisée comme niveau par défaut, sauf si `--log-level` CLI est fourni

**Given** le `ConfigSchema` dans `src/schemas/config.ts`
**Then** il contient un champ `logging: { level, file, pretty }`

### Story 23.2 : Contexte automatique — AsyncLocalStorage et corrélation

As a développeur utilisant Anatoly,
I want que chaque log contienne automatiquement le contexte d'exécution,
So that je puisse filtrer et corréler les logs.

**Priority:** P0 — Blocker
**Effort:** ~2h

**Acceptance Criteria:**

**Given** le fichier `src/utils/log-context.ts`
**Then** il exporte : `LogContext`, `runWithContext(ctx, fn)`, `getLogContext()`

**Given** des contextes imbriqués (run > file > axis)
**When** un log est émis
**Then** le log contient tous les niveaux : `runId`, `file`, `axis`, `phase`, `worker`

**Given** le pipeline `run`
**Then** `runWithContext({ runId, phase })` englobe tout le pipeline

### Story 23.3 : Migration des commandes CLI — Remplacement de console.log/error

As a développeur utilisant Anatoly,
I want que toutes les sorties de diagnostic utilisent le logger centralisé,
So that je puisse contrôler et filtrer tous les messages avec `--log-level`.

**Priority:** P1 — Essentiel
**Effort:** ~4h

**Acceptance Criteria:**

**Given** les fichiers dans `src/commands/`
**Then** aucun `console.log/error/warn` pour du logging de diagnostic
**EXCEPTION :** sorties structurelles CLI (tableaux, résumés) restent en `console.log()`

**Given** `verboseLog()` dans `src/utils/format.ts`
**Then** supprimé, remplacé par `logger.debug()`

**Given** les writes stderr dans `file-evaluator.ts` et `badge.ts`
**Then** remplacés par des appels logger

### Story 23.4 : Instrumentation du pipeline — Logging des phases et métriques

As a développeur utilisant Anatoly,
I want que chaque phase loggue début, fin, durée et métriques clés,
So that je puisse identifier quelle phase est lente ou en échec.

**Priority:** P1 — Essentiel
**Effort:** ~3h

**Acceptance Criteria:**

**Given** `--log-level info`
**Then** chaque phase produit un log d'entrée et de sortie avec `durationMs` et métriques

**Given** `--log-level debug`
**Then** logs par fichier (tier, worker, durée, findings, verdict) et par axe (durée, coût)

**Given** `--log-level trace`
**Then** log par appel LLM (inputTokens, outputTokens, cacheReadTokens, cacheHitRate)

**Given** fin de run
**Then** log récapitulatif + `run-metrics.json` dans le répertoire du run

### Story 23.5 : Instrumentation des modules core

As a développeur utilisant Anatoly,
I want que les modules métier internes émettent des logs de diagnostic,
So that je puisse tracer le parcours d'un fichier à travers tout le pipeline.

**Priority:** P1 — Essentiel
**Effort:** ~3h

**Acceptance Criteria:**

**Given** `scanner.ts`, `triage.ts`, `usage-graph.ts`, `rag/orchestrator.ts`, `axis-merger.ts`, `deliberation.ts`
**When** exécutés avec `--log-level debug`
**Then** logs debug avec métriques pertinentes par module

### Story 23.6 : Error boundary — Agrégation et rapport structuré

As a développeur utilisant Anatoly,
I want que les erreurs soient loggées structurellement et agrégées en fin de run,
So that je puisse diagnostiquer les échecs sans relancer avec `--verbose`.

**Priority:** P1 — Essentiel
**Effort:** ~2h

**Acceptance Criteria:**

**Given** une `AnatolyError` catchée
**Then** log avec : `code`, `message`, `recoverable`, `hint`, `stack`

**Given** un run avec erreurs
**Then** résumé des erreurs en fin de run (errorCount, errorSummary par code)

**Given** `AnatolyError.toLogObject()`
**Then** retourne un objet structuré

### Story 23.7 : Log file routing — Persistance automatique sur disque

As a développeur utilisant Anatoly,
I want que les logs soient automatiquement persistés dans le répertoire du run,
So that je puisse analyser les logs après coup.

**Priority:** P2 — Important
**Effort:** ~2h

**Acceptance Criteria:**

**Given** `anatoly run`
**Then** `.anatoly/runs/<runId>/anatoly.ndjson` créé automatiquement au niveau debug

**Given** `purgeRuns()`
**Then** les fichiers `.ndjson` inclus dans la purge

### Story 23.8 : Documentation et guide de diagnostic

As a développeur utilisant Anatoly,
I want une documentation claire sur le logging,
So that je puisse résoudre mes problèmes efficacement.

**Priority:** P2 — Important
**Effort:** ~1h

**Acceptance Criteria:**

**Given** le README.md
**Then** section "Diagnostic & Logging" avec niveaux, exemples, patterns jq

**Given** `anatoly --help`
**Then** `--log-level` et `--log-file` documentées

---

**Dépendances entre stories :**
```
23.1 (Logger) → 23.2 (Contexte) → 23.3 (Migration) + 23.4 (Pipeline) + 23.5 (Core) + 23.6 (Errors) → 23.7 (Files) → 23.8 (Docs)
```

**Estimation totale :** ~20h (8 stories)
**Nouvelles dépendances :** `pino` (runtime), `pino-pretty` (devDependency)
**Fichiers impactés :** ~25-30 fichiers
**Breaking changes :** Aucun — `--verbose` reste fonctionnel

## Epic 26 : Documentation Axis — Audit de la couverture documentaire
**Status: Draft**

Le développeur bénéficie d'un 7ème axe d'analyse (`documentation`) qui détecte les lacunes et désynchronisations entre le code et la documentation. L'axe évalue deux niveaux : les JSDoc manquants/incomplets sur les symboles exportés (per-symbol), et la couverture des concepts majeurs dans `/docs/` (per-concept). Les findings sont traités par Ralph via sa boucle d'auto-correction standard : ajout de JSDoc inline et création/mise à jour de pages `/docs/`.

**Architecture de référence :** `_bmad-output/planning-artifacts/epic-documentation-axis.md` (12 Architecture Decisions)

**Version cible :** v0.6.0
**FRs couvertes :** FR10 (axes d'analyse — extension à 7 axes), FR14 (rapport — nouvelle section Documentation Coverage)
**NFRs impactées :** NFR1 (zéro faux positif — confidence obligatoire), NFR8 (lecture seule → clarification : JSDoc et /docs/ sont dans le périmètre Ralph)
**Dépendances :** Epic 3 (axis-evaluator framework), Epic 16 (axis merger + file evaluator), Epic 20 (prompts Markdown), Epic 25 (Ralph — pour le traitement des actions)

**Risques techniques identifiés :**
- Token bloat si les pages `/docs/` injectées sont trop volumineuses → cap à 3 pages × 300 lignes
- Faux OUTDATED si la doc utilise une terminologie différente du code → prompt calibré pour ne flagger que les contradictions de signatures/comportement
- Module mapping inadapté aux projets non-anatoly → config-driven en priorité, convention en fallback
- Ralph pourrait générer des JSDoc superficiels (restatement du nom de fonction) → la boucle d'auto-correction valide la qualité
- Projets sans `/docs/` → dégradation gracieuse : JSDoc-only mode

### Story 26.1 : Fondations — Schémas, docs-resolver et system prompt

As a développeur d'Anatoly,
I want les fondations du 7ème axe (types, résolveur de docs, prompt système),
So that l'évaluateur et le merger puissent être construits dessus.

**Priority:** P0 — Prerequisite
**Dépendances :** Aucune

**Acceptance Criteria:**

**Given** le fichier `src/core/axis-evaluator.ts`
**When** le type `AxisId` est inspecté
**Then** il contient `'documentation'` comme valeur additionnelle du type union

**Given** le fichier `src/core/axis-evaluator.ts`
**When** l'interface `AxisContext` est inspectée
**Then** elle contient deux nouveaux champs optionnels :
- `docsTree?: string` — arborescence de `/docs/` en texte
- `relevantDocs?: RelevantDoc[]` — contenu des pages `/docs/` pertinentes

**Given** le type `RelevantDoc`
**When** il est inspecté
**Then** il contient `path: string` (chemin relatif dans /docs/) et `content: string` (contenu de la page)

**Given** le fichier `src/schemas/review.ts`
**When** le `SymbolReviewSchema` est inspecté
**Then** il contient un nouveau champ `documentation: z.enum(['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED', '-'])`

**Given** le fichier `src/schemas/review.ts`
**When** le `AxisIdSchema` est inspecté
**Then** il contient `'documentation'` dans la liste des valeurs

**Given** le fichier `src/schemas/config.ts`
**When** le `AxesConfigSchema` est inspecté
**Then** il contient `documentation: AxisConfigSchema.default({ enabled: true })`

**Given** le fichier `src/schemas/config.ts`
**When** le `ConfigSchema` est inspecté
**Then** il contient une section `documentation` optionnelle avec :
- `docs_path: z.string().default('docs')`
- `module_mapping: z.record(z.string(), z.array(z.string())).optional()`

**Given** le nouveau fichier `src/core/docs-resolver.ts`
**When** la fonction `buildDocsTree(projectRoot, docsPath)` est appelée
**Then** elle retourne un `string | null` contenant l'arborescence récursive de `{docsPath}/**/*.md`
**And** retourne `null` si le répertoire n'existe pas ou est vide

**Given** la fonction `resolveRelevantDocs(filePath, docsTree, config, projectRoot)`
**When** elle est appelée avec un fichier source
**Then** elle :
1. Extrait le chemin module (e.g. `src/core/axes/tests.ts` → `src/core/axes`)
2. Cherche d'abord dans `config.documentation.module_mapping` (prioritaire)
3. Si pas de match, utilise le fallback par convention (noms de dossiers)
4. Charge max 3 pages, tronquées à 300 lignes chacune
5. Retourne un tableau de `RelevantDoc[]` (vide si aucun match)

**Given** un projet sans répertoire `/docs/`
**When** `buildDocsTree()` est appelée
**Then** elle retourne `null`
**And** `resolveRelevantDocs()` retourne `[]`

**Given** le nouveau fichier `src/core/axes/prompts/documentation.system.md`
**When** il est inspecté
**Then** il contient :
- Le rôle : évaluateur documentation exclusif
- Les critères JSDoc per-symbol (DOCUMENTED/PARTIAL/UNDOCUMENTED) avec règles de confidence
- Les critères /docs/ per-concept (COVERED/PARTIAL/MISSING/OUTDATED)
- L'instruction de ne pas halluciner de pages docs si `docsTree` est absent
- Le format JSON de sortie attendu (symbols + docs_coverage)
- La règle : types/interfaces/enums sans runtime → DOCUMENTED par défaut (confidence: 95)

**Given** `npm run typecheck && npm run build`
**When** exécuté après l'implémentation
**Then** les deux commandes réussissent sans erreur

**Tests requis :**
- `docs-resolver.test.ts` : buildDocsTree avec fixture (répertoire existant, vide, inexistant)
- `docs-resolver.test.ts` : resolveRelevantDocs avec config mapping, fallback convention, pas de match
- `docs-resolver.test.ts` : troncature à 300 lignes, cap à 3 pages
- Schémas : parsing des nouveaux champs AxisId, SymbolReview, Config

---

### Story 26.2 : Évaluateur, merger, orchestrateur et registre — Axe fonctionnel end-to-end

As a développeur d'Anatoly,
I want que l'axe documentation soit intégré dans le pipeline d'évaluation complet,
So that `anatoly run` produise des findings de documentation dans les reports.

**Priority:** P0 — Core
**Dépendances :** Story 26.1

**Acceptance Criteria:**

**--- Évaluateur (`src/core/axes/documentation.ts`) ---**

**Given** le nouveau fichier `src/core/axes/documentation.ts`
**When** la classe `DocumentationEvaluator` est inspectée
**Then** elle implémente `AxisEvaluator` avec :
- `readonly id = 'documentation' as const`
- `readonly defaultModel = 'haiku' as const`
- `async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult>`

**Given** la fonction `buildDocumentationUserMessage(ctx: AxisContext)`
**When** elle est appelée
**Then** elle construit un prompt contenant :
- Le code source du fichier
- La liste des symboles à évaluer
- Le `docsTree` (si disponible)
- Le contenu des `relevantDocs` (si disponible, tronqué)
- L'instruction "Evaluate documentation for each symbol and output the JSON"

**Given** le `DocumentationResponseSchema` Zod
**When** il est inspecté
**Then** il valide :
- `symbols: z.array(DocSymbolSchema)` avec `name`, `line_start`, `line_end`, `documentation` (DOCUMENTED|PARTIAL|UNDOCUMENTED), `confidence`, `detail`
- `docs_coverage: DocsCoverageSchema` avec `concepts` (name, status, doc_path, detail) et `readme_coverage`

**Given** un contexte sans `docsTree` (projet sans /docs/)
**When** l'évaluateur est appelé
**Then** le prompt indique "No /docs/ directory — evaluate JSDoc only"
**And** la réponse `docs_coverage.concepts` est un tableau vide

**--- Merger (`src/core/axis-merger.ts`) ---**

**Given** la constante `AXIS_DEFAULTS`
**When** elle est inspectée
**Then** elle contient `documentation: 'UNDOCUMENTED'`

**Given** la fonction `mergeSymbol()`
**When** elle traite un symbole avec un résultat de l'axe documentation
**Then** elle mappe `result.value` sur le champ `documentation` du `SymbolReview`

**Given** un symbole avec `utility=DEAD`
**When** les règles de cohérence sont appliquées
**Then** `documentation` est forcé à `UNDOCUMENTED` (pas de documentation pour du dead code)

**Given** un symbole `exported=true` avec `documentation=UNDOCUMENTED` et `confidence ≥ 60`
**When** la synthèse d'actions est exécutée
**Then** une action est générée : `"Add JSDoc: \`symbolName\` is exported but undocumented"` avec severity: medium, effort: trivial, category: hygiene, source: documentation

**Given** un symbole avec `documentation=PARTIAL`
**When** la synthèse d'actions est exécutée
**Then** une action est générée : `"Complete JSDoc: \`symbolName\` has incomplete documentation"` avec severity: low, effort: trivial

**Given** un concept `docs_coverage` avec status `MISSING`
**When** la synthèse d'actions est exécutée
**Then** une action est générée : `"Create docs page: concept \"conceptName\" has no documentation in /docs/"` avec severity: medium, effort: small, target_symbol: null

**Given** un concept `docs_coverage` avec status `OUTDATED`
**When** la synthèse d'actions est exécutée
**Then** une action est générée : `"Update docs: \"conceptName\" in doc_path is outdated"` avec severity: high, effort: small

**Given** la fonction `computeVerdict()`
**When** au moins un symbole exporté a `documentation=UNDOCUMENTED` avec confidence ≥ 60
**Then** le verdict est `NEEDS_REFACTOR`

**Given** la fonction `computeVerdict()`
**When** ≥ 3 symboles ont `documentation=PARTIAL` avec confidence ≥ 60
**Then** le verdict est `NEEDS_REFACTOR`

**--- Orchestrateur (`src/core/file-evaluator.ts`) ---**

**Given** `EvaluateFileOptions`
**When** l'interface est inspectée
**Then** elle contient un nouveau champ optionnel `docsTree?: string | null`

**Given** la fonction `evaluateFile()`
**When** `docsTree` est fourni dans les options
**Then** elle appelle `resolveRelevantDocs()` pour le fichier en cours
**And** injecte `docsTree` et `relevantDocs` dans le `AxisContext` passé aux évaluateurs

**Given** `docsTree` est `null`
**When** `evaluateFile()` construit le `AxisContext`
**Then** `docsTree` est `undefined` et `relevantDocs` est `undefined`

**--- Run command / reviewer.ts ---**

**Given** le démarrage d'un run
**When** le pipeline s'initialise
**Then** `buildDocsTree()` est appelé une seule fois
**And** le résultat est passé dans `EvaluateFileOptions.docsTree` pour chaque fichier

**--- Registre (`src/core/axes/index.ts`) ---**

**Given** la constante `ALL_EVALUATORS`
**When** elle est inspectée
**Then** elle contient `new DocumentationEvaluator()` après `BestPracticesEvaluator`

**Given** la constante `ALL_AXIS_IDS`
**When** elle est inspectée
**Then** elle contient `'documentation'` comme 7ème valeur

**--- Reporter ---**

**Given** le reporter markdown
**When** il génère le tableau des symboles
**Then** il inclut une colonne `doc` (3 caractères) après la colonne `tst`

**Given** le reporter
**When** un symbole a `documentation=OUTDATED` au niveau concept
**Then** il est affiché en rouge (même traitement visuel que NEEDS_FIX)

**Given** le reporter
**When** il génère le rapport
**Then** il inclut une section "Documentation Coverage" contenant :
1. Un score de couverture : `"Documentation: X% (Y/Z exported symbols)"`
2. La liste des symboles undocumented groupés par fichier
3. La liste des concepts OUTDATED avec le doc_path et la contradiction
4. La liste des concepts MISSING

**Given** `npm run typecheck && npm run build && npm run test`
**When** exécuté après l'implémentation complète
**Then** les 3 commandes réussissent sans erreur

**Tests requis :**
- `documentation.test.ts` : mock LLM, Zod validation, mapping response → AxisSymbolResult
- `documentation.test.ts` : contexte sans docsTree → JSDoc-only mode
- `axis-merger.test.ts` : DEAD → UNDOCUMENTED coherence rule
- `axis-merger.test.ts` : action synthesis pour UNDOCUMENTED, PARTIAL, MISSING, OUTDATED
- `axis-merger.test.ts` : verdict impact (UNDOCUMENTED → NEEDS_REFACTOR, 3× PARTIAL → NEEDS_REFACTOR)
- `file-evaluator.test.ts` : docsTree passé et relevantDocs injectés
- `reporter.test.ts` : colonne doc, section Documentation Coverage, score

---

### Story 26.3 : Documentation meta — L'axe se documente lui-même

As a développeur utilisant Anatoly,
I want que la documentation du projet reflète le 7ème axe,
So that les utilisateurs et contributeurs comprennent la feature.

**Priority:** P1 — Important
**Dépendances :** Story 26.2 (pour que la doc soit fidèle à l'implémentation)

**Acceptance Criteria:**

**Given** le fichier `docs/02-Architecture/02-Six-Axis-System.md`
**When** il est mis à jour
**Then** :
- Le titre est renommé en "Seven-Axis System" (ou "Système à sept axes")
- Une section "Documentation Axis" est ajoutée décrivant les verdicts (DOCUMENTED/PARTIAL/UNDOCUMENTED), le modèle (Haiku), et le fonctionnement à deux niveaux (JSDoc + /docs/)
- Le schéma récapitulatif des axes est mis à jour pour inclure le 7ème

**Given** le fichier `docs/04-Core-Modules/04-Axis-Evaluators.md`
**When** il est mis à jour
**Then** une section "DocumentationEvaluator" est ajoutée avec :
- Les verdicts et leurs critères
- Le contexte enrichi (docsTree, relevantDocs)
- La dégradation gracieuse (pas de /docs/)
- La configuration (documentation.docs_path, documentation.module_mapping)

**Given** le fichier `_bmad-output/planning-artifacts/PRD.md`
**When** il est mis à jour
**Then** :
- Principe 1 (section 4) est modifié : "Anatoly ne modifie jamais la logique du code source. Les annotations documentaires (JSDoc) et les fichiers de documentation (/docs/) sont dans le périmètre de correction de Ralph."
- Section 16 Non-goals : "Correcteur automatique" → "Correcteur automatique de logique métier"
- Section 6.1 : le tableau des axes inclut `documentation` avec ses valeurs (DOCUMENTED, PARTIAL, UNDOCUMENTED)
- Section 15 Roadmap : v0.6.0 inclut "Documentation Axis — 7ème axe d'audit de couverture documentaire"

**Given** le fichier `docs/01-Getting-Started/02-Configuration.md`
**When** il est mis à jour
**Then** la section configuration inclut les nouvelles options :
- `llm.axes.documentation.enabled` (default: true)
- `documentation.docs_path` (default: "docs")
- `documentation.module_mapping` (optionnel)

---

### Story 26.4 : Adversarial Code Review — Validation complète de l'Epic 26

As a tech lead,
I want une code review adversariale de l'implémentation complète,
So that chaque claim est validé contre la réalité et aucune régression, lacune ou raccourci ne passe.

**Priority:** P0 — Gate de qualité obligatoire
**Dépendances :** Stories 26.1 + 26.2 + 26.3 (toutes complètes)

**Acceptance Criteria:**

**Given** les File Lists des Stories 26.1, 26.2, 26.3
**When** comparées contre `git diff` et le filesystem réel
**Then** chaque fichier claimé existe, a été modifié, et les changements correspondent à la description. Aucun fichier fantôme.

**Given** chaque tâche marquée `[x]` dans les 3 stories
**When** vérifiée contre le code source
**Then** l'implémentation correspond réellement à la description de la tâche. Task `[x]` non implémentée = finding CRITICAL.

**Given** chaque AC des 3 stories
**When** vérifié contre l'implémentation
**Then** l'AC est IMPLEMENTED, PARTIAL ou MISSING. MISSING = finding HIGH.

**Given** tous les nouveaux fichiers de test
**When** `npm run test` exécuté
**Then** zéro failure, chaque test a des assertions réelles (pas de placeholders)

**Given** `npm run typecheck && npm run build && npm run test`
**When** exécuté après tous les fixes
**Then** les 3 commandes passent sans erreur

**Given** un `npx anatoly run --no-rag --no-deliberation` sur un scope de test
**When** exécuté
**Then** les 6 axes existants fonctionnent toujours, l'axe documentation produit des findings, le rapport contient la colonne `doc` et la section Documentation Coverage

**Protocole :** Review adversariale BMAD — minimum 3 issues spécifiques, fix automatique des HIGH/MEDIUM, re-vérification après fixes.

---

**Dépendances entre stories :**
```
26.1 (Fondations) → 26.2 (Core Integration) → 26.3 (Documentation Meta) → 26.4 (Adversarial Review)
```
Story 26.3 peut commencer en parallèle de 26.2 (pour les fichiers indépendants du code) mais doit se finaliser après 26.2. Story 26.4 ne peut commencer qu'après les 3 autres.

**Estimation totale :** 4 stories (3 implémentation + 1 review)
**Nouvelles dépendances :** Aucune (tout est interne)
**Fichiers impactés :** ~15 fichiers (3 nouveaux, 12 modifiés)
**Breaking changes :** Aucun — le champ `documentation` sur `SymbolReview` default à `'-'` pour les reviews existantes

## Epic 24 : Code Embedding — Modèles d'embedding locaux pour le RAG
**Status: Done** (v0.5.0)

Voir détails dans `_bmad-output/planning-artifacts/epic-24-code-embedding.md`.

## Epic 25 : Ralph Integration — Automated Audit Remediation
**Status: Done** (v0.6.0)

Voir détails dans `_bmad-output/planning-artifacts/epic-25-fix-ralph.md`.

## Epic 27 : RAG Dual-Vector for Documentation — Matching sémantique docs ↔ code
**Status: Draft**

Le RAG indexe les sections `/docs/` comme cartes NLP et utilise les résumés Haiku des fonctions pour matcher sémantiquement les pages docs pertinentes par fichier. Pipeline en 3 phases : code embedding (nomic-code/Jina), summary generation (Haiku), text embedding + doc sections (nomic-text/MiniLM). Remplace le docs-resolver par convention de nommage.

**Architecture de référence :** `_bmad-output/planning-artifacts/epic-rag-dual-vector-docs.md` (8 Architecture Decisions)

**Version cible :** v0.7.0
**FRs couvertes :** FR10 (documentation axis — précision), FR9 (RAG — extension NLP)
**Dépendances :** Epic 24 (embedding infra), Epic 26 (documentation axis)
**Estimation totale :** ~18h (20 tasks across 6 stories)
**Breaking changes :** LanceDB table schema adds `type` field — automatic migration on first run

### Architecture — RAG Index Pipeline

**Advanced Mode (3 sequential phases):**
1. **Code Embedding** — nomic-code on GPU: extract function cards from AST, embed code bodies → `vector` (3584d)
2. **Summary Generation** — Haiku API: generate 1-sentence semantic summary per function, batch 20-30 per call, cache by hash
3. **Text Embedding** — sidecar swaps to nomic-text: embed summaries → `nlp_vector` (768d), parse `/docs/` into H2 sections, embed sections → `nlp_vector` (768d)

**Lite Mode:** Same 3 phases — Jina ONNX (768d), Haiku API, MiniLM ONNX (384d). No swap needed.

**Technical Decisions:** AD-1 through AD-8, see `epic-rag-dual-vector-docs.md`.

### Story 27.1 : Haiku summary generation in RAG indexer

As Anatoly's RAG indexer,
I want to generate a one-sentence summary for each function card via Haiku,
So that the NLP vector captures the semantic meaning of the function, not its syntax.

**Priority:** P0 — Blocker (summaries needed for NLP embedding)
**Effort:** ~3h

**Tasks:**

- [ ] **27.1.1** Add `generateSummaries()` to `src/rag/indexer.ts`
  - Input: array of function cards (name, signature, body snippet)
  - Output: array of summaries (1 sentence each)
  - Batch Haiku call: group 20-30 functions per request to minimize API calls
  - Cache by function content hash — skip if summary already exists

- [ ] **27.1.2** Integrate summary generation into `indexProject()` pipeline
  - After function card extraction, before embedding
  - Only generate for cards where `summary` is empty or content hash changed
  - Write summaries to function card before embedding step

- [ ] **27.1.3** Update `cache_lite.json` and `cache_advanced.json` schema
  - Store summary alongside content hash so it persists across runs
  - Invalidate summary when function content changes

**Acceptance Criteria:**

**Given** a codebase with 300 functions
**When** RAG index runs for the first time
**Then** all 300 functions have a non-empty `summary` field
**And** subsequent runs with no code changes generate 0 new summaries (all cached)
**And** modifying one function regenerates only that function's summary

---

### Story 27.2 : Doc section extraction and indexing

As Anatoly's RAG indexer,
I want to parse `/docs/` into sections and index them as NLP cards,
So that the documentation axis can find relevant doc pages by semantic similarity.

**Priority:** P0 — Blocker (doc sections needed for matching)
**Effort:** ~2h

**Tasks:**

- [ ] **27.2.1** Create `src/rag/doc-section-parser.ts`
  - Scan `docs/` directory recursively for `.md` files
  - Split each file on `## ` (H2 headings)
  - Each section produces two versions:
    - `embed_text` — prose only: strip code fences, JSON/YAML blocks, markdown tables, shell examples, HTML tags. This is what gets embedded via NLP model.
    - `content` — full section text including code/tables. This is what gets injected into the LLM prompt at review time.
  - Each section becomes a card: `{ type: 'doc_section', heading, content, embed_text, doc_path, nlp_vector }`
  - Skip sections where `embed_text` < 50 chars after stripping (no prose = no embedding value)

- [ ] **27.2.2** Integrate doc section parsing into `indexProject()`
  - Run after function card indexing (same phase)
  - Cache by file content hash — only re-index changed doc files
  - Upsert doc sections into same LanceDB table with `type: 'doc_section'`

- [ ] **27.2.3** Add `type` field to LanceDB schema
  - Discriminator: `'function' | 'doc_section'`
  - Migrate existing cards to `type: 'function'` on first run
  - Filter by type in all existing search functions (duplication searches only `type: 'function'`)

**Acceptance Criteria:**

**Given** a `/docs/` directory with 20 markdown files containing ~80 H2 sections
**When** RAG index runs
**Then** ~80 doc section cards are indexed with NLP vectors
**And** each card has `type: 'doc_section'`, valid `heading`, `content`, and `doc_path`
**And** duplication axis searches still return only function cards

---

### Story 27.3 : Advanced mode — nomic-embed-text in sidecar

As Anatoly's embedding sidecar,
I want to support sequential loading of nomic-code and nomic-text models,
So that advanced mode gets high-quality NLP embeddings without MiniLM fallback.

**Priority:** P1 — Essential
**Effort:** ~5h

**Tasks:**

- [ ] **27.3.1** Update `npx anatoly setup-embeddings` command
  - Download nomic-embed-text alongside nomic-embed-code
  - Add `--text-only` and `--code-only` flags to download models selectively
  - Update `embeddings-ready.json` to include text model info (code_model, text_model, dim_code, dim_text, device)
  - Show download progress for both models
  - Verify both models load successfully before writing ready file

- [ ] **27.3.2** Update sidecar Python script to support `--mode code|text` startup parameter
  - Sidecar starts with one model at a time: `python embed.py --mode code` or `--mode text`
  - Add `/swap` endpoint to switch model at runtime without restarting the process
  - Unload current model from GPU memory before loading the new one
  - Return ready signal with model name and dimension when swap complete
  - Add `/info` endpoint returning current model name, dimension, and mode

- [ ] **27.3.3** Update `src/rag/embed-sidecar.ts` to orchestrate model swap
  - `ensureSidecar()` accepts `mode: 'code' | 'text'` parameter
  - After code embedding phase: call `/swap` to switch to nomic-text
  - Embed summaries + doc sections with nomic-text (768d)
  - Stop sidecar when all embedding done (no swap back needed)
  - Handle swap timeout (model loading can take 10-30s)

- [ ] **27.3.4** Update VectorStore to handle 768d NLP vectors in advanced mode
  - Currently expects 384d (MiniLM) — advanced mode uses 768d (nomic-text)
  - Dimension auto-detection: read from first vector or from `embeddings-ready.json`
  - Migration: if existing table has 384d nlp_vector and mode is advanced, rebuild NLP vectors

**Acceptance Criteria:**

**Given** advanced mode with GPU sidecar running
**When** RAG index runs
**Then** code vectors are embedded with nomic-code (3584d)
**And** NLP vectors are embedded with nomic-text (768d)
**And** sidecar swaps models without OOM or crash
**And** total GPU memory stays under 8GB peak

---

### Story 27.4 : Documentation axis — semantic doc matching

As Anatoly's documentation axis evaluator,
I want to find relevant doc pages by matching function summaries against doc sections via NLP vectors,
So that the LLM receives the correct documentation context instead of alphabetical fallback.

**Priority:** P0 — Blocker (core feature)
**Effort:** ~3h

**Tasks:**

- [ ] **27.4.1** Replace `docs-resolver.ts` convention-based matching with RAG NLP search
  - For each file: collect NLP vectors of its function cards
  - Search `type: 'doc_section'` cards by NLP similarity
  - Return top-K unique doc pages (deduplicate by `doc_path`)
  - Apply injection limits: MAX_SECTIONS=5, MAX_LINES_PER_SECTION=100
  - Total doc injection budget: MAX_DOC_TOKENS=4000 tokens per file evaluated
  - If budget exceeded: keep highest-scoring sections, truncate lowest
  - Limits identical in lite and advanced mode

- [ ] **27.4.2** Update `buildDocumentationUserMessage()` to use matched doc sections
  - Inject matched sections (heading + content) instead of full pages
  - Truncate each section to MAX_LINES_PER_SECTION (100 lines)
  - More precise: only the relevant sections, not the entire doc file
  - Include match score for transparency in logs
  - Log total injected tokens for calibration

- [ ] **27.4.3** Fallback when no match found
  - If NLP search returns 0 results (no docs exist for this module)
  - LLM evaluates whether docs are needed based on: exported API? core logic? internal util?
  - Verdict: UNDOCUMENTED (should have docs) or DOCUMENTED (no docs needed)

- [ ] **27.4.4** Update docs_coverage schema
  - Add `matched_doc_pages` field to review JSON
  - Record which pages were matched and with what score
  - Used by report to show documentation coverage map

**Acceptance Criteria:**

**Given** `src/core/reporter.ts` is being evaluated
**When** documentation axis runs
**Then** NLP search matches `05-Reporter.md` sections (not Scanner/Estimator/Triage)
**And** the LLM receives Reporter-specific doc content in its prompt
**And** `docs_coverage.matched_doc_pages` contains `05-Reporter.md`

---

### Story 27.5 : Deliberation memory for documentation reclassifications

As Anatoly's deliberation system,
I want to persist documentation reclassifications in deliberation memory,
So that the same false positive (e.g., "internal helper marked UNDOCUMENTED") is not re-flagged on every run.

**Priority:** P2 — Medium
**Effort:** ~2h

**Tasks:**

- [ ] **27.5.1** Extend deliberation memory to record documentation axis reclassifications
  - Pattern: `[deliberation] symbolName: UNDOCUMENTED -> DOCUMENTED`
  - Include reasoning: "internal helper, not part of public API"
  - File: `.anatoly/deliberation-memory.json`

- [ ] **27.5.2** Inject relevant reclassifications into documentation axis prompt
  - Filter by file/symbol match
  - Prompt instruction: "These symbols were previously flagged but overturned — do not re-flag without new evidence"

- [ ] **27.5.3** Test: verify reclassified symbol is not re-flagged
  - Run 1: symbol flagged UNDOCUMENTED, deliberation reclassifies to DOCUMENTED
  - Run 2: same symbol is not flagged again

**Acceptance Criteria:**

**Given** a symbol was reclassified from UNDOCUMENTED to DOCUMENTED by deliberation
**When** the next run evaluates the same file
**Then** the documentation axis does not re-flag the symbol
**And** deliberation memory contains the reclassification entry

---

### Story 27.6 : rag-status shows doc sections and NLP stats

As a developer using `npx anatoly rag-status`,
I want to see doc section stats alongside function card stats,
So that I can verify the documentation index is populated correctly.

**Priority:** P2 — Medium
**Effort:** ~1h

**Tasks:**

- [ ] **27.6.1** Update `rag-status` to show doc section count
  - `doc sections: 80 (from 20 files)`
  - `NLP model: MiniLM (384d)` or `nomic-text (768d)`

- [ ] **27.6.2** Add `--docs` filter to show doc section details
  - List all indexed doc sections with heading and source path
  - Show which doc pages are indexed vs missing

- [ ] **27.6.3** Add NLP coverage stat
  - `functions with summary: 279/279`
  - `functions without summary: 0` (flag if > 0)

**Acceptance Criteria:**

**Given** a fully indexed project with docs
**When** `npx anatoly rag-status` runs
**Then** output shows function cards AND doc section stats
**And** `--docs` flag lists all indexed doc sections

---

**Dépendances entre stories :**
```
27.1 (summaries) → 27.2 (doc sections) → 27.4 (semantic matching)
                                                │
27.3 (nomic-text sidecar) ────────────────────┘

27.5 (delib memory) — independent, can run in parallel
27.6 (rag-status) — after 27.2
```

**Risques techniques :**
- Haiku summary quality too generic → tune prompt for domain terms
- nomic-text GPU swap timeout → sequential loading, never both loaded
- Doc sections too granular/broad → start with H2, adjust
- NLP similarity threshold → configurable in `anatoly.json`

---

### Story 27.7 : Adversarial Code Review — Validation complète de l'Epic 27

As a tech lead,
I want une code review adversariale de l'implémentation complète de l'Epic 27,
So that chaque claim est validé contre la réalité et aucune régression, lacune ou raccourci ne passe.

**Priority:** P0 — Gate de qualité obligatoire
**Effort:** ~2h
**Dépendances :** Stories 27.1 + 27.2 + 27.3 + 27.4 + 27.5 + 27.6 (toutes complètes)

**Protocole :** Review adversariale BMAD — minimum 3 issues spécifiques, fix automatique des HIGH/MEDIUM, re-vérification après fixes.

**Tasks:**

- [ ] **27.7.1** Vérification des File Lists
  - Pour chaque story 27.1-27.6 : comparer les fichiers claimés vs `git diff` réel
  - Aucun fichier fantôme (claimé modifié mais inchangé)
  - Aucun fichier oublié (modifié mais non listé)

- [ ] **27.7.2** Vérification des tâches `[x]`
  - Pour chaque tâche marquée complète dans les stories 27.1-27.6
  - Ouvrir le fichier source et vérifier que l'implémentation correspond à la description
  - Tâche `[x]` non implémentée = finding CRITICAL

- [ ] **27.7.3** Vérification des Acceptance Criteria
  - Pour chaque AC des stories 27.1-27.6 : vérifier contre l'implémentation
  - AC IMPLEMENTED, PARTIAL ou MISSING — MISSING = finding HIGH

- [ ] **27.7.4** Tests de non-régression
  - `npm run typecheck && npm run build && npm run test` — zéro failure
  - Chaque test a des assertions réelles (pas de placeholders)

- [ ] **27.7.5** Test d'intégration RAG dual-vector
  - `npx anatoly run --axes documentation --no-cache` sur le codebase
  - Vérifier que les summaries sont générés (non vides dans LanceDB)
  - Vérifier que les doc sections sont indexées (type='doc_section' dans la table)
  - Vérifier que `reporter.ts` reçoit `05-Reporter.md` dans son prompt (pas Scanner.md)
  - Vérifier que `rag-status` affiche les stats doc sections

- [ ] **27.7.6** Test de non-régression axes existants
  - `npx anatoly run --axes duplication --no-cache` — duplication ne cherche que type='function'
  - Aucune doc section retournée dans les candidats duplication
  - Les 6 axes existants + documentation fonctionnent ensemble

- [ ] **27.7.7** Fix des issues trouvées
  - Corriger tous les findings HIGH et MEDIUM
  - Re-run `npm run typecheck && npm run build && npm run test`
  - Re-vérifier les AC impactés

**Acceptance Criteria:**

**Given** les stories 27.1-27.6 marquées complètes
**When** chaque claim vérifié contre `git diff` + code source
**Then** aucune tâche `[x]` non implémentée, aucun AC manquant

**Given** `npm run typecheck && npm run build && npm run test`
**When** exécuté après tous les fixes
**Then** les 3 commandes passent sans erreur

**Given** `npx anatoly run --axes documentation --no-cache`
**When** exécuté sur le codebase
**Then** les summaries Haiku sont non vides, les doc sections sont indexées, le matching sémantique retourne les bonnes pages, le rapport contient `matched_doc_pages`

---

## Epic 28 : Tiered Embedding Backend — GGUF/Docker acceleration

**Status: Draft**

Le mode RAG Advanced supporte 3 tiers d'embedding déterminés empiriquement au setup : lite (ONNX CPU), advanced-fp16 (sidecar Python GPU), advanced-gguf (Docker llama.cpp GPU, dual-model simultané). Le setup détecte la VRAM, exécute un A/B test, et écrit le backend optimal dans `embeddings-ready.json`. Le runtime route vers le bon backend sans logique de sélection.

**Architecture de référence :** ADR "RAG Embedding Backend — Tiered Architecture" dans `architecture.md`

**Version cible :** v0.7.0
**Dépendances :** Epic 24 (embedding infra), Epic 27 (RAG dual-vector)
**Breaking changes :** Aucun — les backends sont additifs, fallback automatique sur lite

**CRITICAL CONSTRAINT — DO NOT USE llama-cpp-python:**
The GGUF backend MUST use the official Docker container `ghcr.io/ggml-org/llama.cpp:server-cuda`.
DO NOT use llama-cpp-python, bitsandbytes, compressed-tensors, llmcompressor, or any Python quantization library.
The existing Python sidecar (embed-server.py) is ONLY for the advanced-fp16 backend (sentence-transformers).
The GGUF backend is a Docker container exposing an HTTP `/embedding` endpoint — TypeScript calls it via fetch().
GGUF models are pre-downloaded in `.anatoly/models/*.gguf` (official from nomic-ai and Qwen HuggingFace repos).

**Seuils VRAM :**
- ≥ 24 GB : A/B test fp16 vs gguf → garde le meilleur
- 12-23 GB : advanced-gguf (seule option GPU viable)
- < 12 GB : lite (pas assez de VRAM pour dual-model)
- Pas de GPU : lite

**Modèles GGUF (officiels) :**
- `nomic-ai/nomic-embed-code-GGUF` → `nomic-embed-code.Q5_K_M.gguf` (5.1 GB)
- `Qwen/Qwen3-Embedding-8B-GGUF` → `Qwen3-Embedding-8B-Q5_K_M.gguf` (5.4 GB)

---

### Story 28.1 : Setup — détection VRAM, download GGUF, pull Docker

As an Anatoly user running `setup-embeddings`,
I want the setup to detect my GPU capabilities, download the right models, and determine the optimal backend,
So that the embedding system is configured once and runs optimally on my hardware.

**Priority:** P0 — Blocker
**Effort:** ~4h

**Tasks:**

- [ ] **28.1.1** Preflight dependency check
  - Detect: `nvidia-smi` present → GPU available
  - Detect: `docker` present + `docker info` succeeds → Docker daemon running
  - Detect: NVIDIA Container Toolkit → `docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi` succeeds
  - Detect: Python 3.9+ in `.anatoly/.venv` or system
  - Detect: `sentence-transformers`, `torch` (for fp16 backend)
  - Detect: `huggingface_hub` (for GGUF download)
  - Display clear checklist with pass/fail per dependency:
    ```
    [ok]   GPU: NVIDIA RTX 3090 Ti (24564 MiB)
    [ok]   Docker: 27.5.1
    [ok]   NVIDIA Container Toolkit: OK
    [ok]   Python: 3.12.3 (.anatoly/.venv)
    [warn] sentence-transformers: not installed (fp16 backend unavailable)
    ```
  - If no GPU + no Docker → set lite immediately, skip remaining steps
  - If missing critical deps → offer to install (`pip install`, `docker pull`) or abort with instructions

- [ ] **28.1.2** VRAM detection and tier classification
  - Query `nvidia-smi` for VRAM total
  - Classify: ≥ 24 GB (full), 12-23 GB (gguf-only), < 12 GB (lite), no GPU (lite)
  - Cross-check with preflight: if VRAM ≥ 12 GB but no Docker → can only do fp16 if ≥ 24 GB, else lite
  - Log detected tier and reasoning clearly in CLI output

- [ ] **28.1.3** Download GGUF models from official HuggingFace repos
  - `huggingface_hub.hf_hub_download()` for each GGUF file
  - Store in `.anatoly/models/` — skip if already cached
  - Show download progress with file sizes (~5 GB each)
  - Only download if VRAM ≥ 12 GB (no point downloading GGUF for lite-only systems)

- [ ] **28.1.4** Pull Docker image `ghcr.io/ggml-org/llama.cpp:server-cuda`
  - `docker pull` with progress output
  - Verify NVIDIA Container Toolkit: `docker run --gpus all nvidia-smi`
  - If Docker not available: skip GGUF tier, log warning, fallback to fp16 or lite

- [ ] **28.1.5** Route to A/B test or direct tier selection
  - VRAM ≥ 24 GB + Docker OK → run A/B test (Story 28.2)
  - VRAM 12-23 GB + Docker OK → set advanced-gguf directly (no fp16 possible)
  - VRAM ≥ 24 GB + no Docker → set advanced-fp16 directly
  - Otherwise → set lite

- [ ] **28.1.6** Write `embeddings-ready.json` with selected backend
  - `{ "backend": "lite | advanced-fp16 | advanced-gguf", ... }`
  - Include model paths, dimensions, VRAM detected, A/B test results if run

**Acceptance Criteria:**

**Given** a machine with NVIDIA GPU (≥ 12 GB VRAM) and Docker installed
**When** `npx anatoly setup-embeddings` runs
**Then** GGUF models are downloaded, Docker image pulled, tier determined
**And** `embeddings-ready.json` contains `backend: "advanced-gguf"`

**Given** a machine with no GPU
**When** `npx anatoly setup-embeddings` runs
**Then** no GGUF download, no Docker pull
**And** `embeddings-ready.json` contains `backend: "lite"`

**Files:**
- `scripts/setup-embeddings.sh` — VRAM detection, download routing, Docker pull
- `src/commands/setup-embeddings.ts` — expose `--check` and `--ab-test` flags

---

### Story 28.2 : A/B test — bf16 vs GGUF quality comparison

As an Anatoly user with ≥ 24 GB VRAM,
I want an A/B test comparing bf16 (sentence-transformers) vs GGUF (Docker llama.cpp) embeddings,
So that the setup selects the backend with the best quality/performance trade-off on my hardware.

**Priority:** P0 — Required for ≥ 24 GB tier selection
**Effort:** ~4h

**Tasks:**

- [ ] **28.2.1** Refactor `embedding-ab-test.py` for bf16 vs GGUF comparison
  - [A] bf16: load via `sentence-transformers` on GPU, embed 10 code + 10 NLP samples
  - [B] GGUF: start Docker container with Q5_K_M model, embed same samples via `/embedding` endpoint
  - Compare: cosine similarity per sample, ranking preservation, VRAM usage, latency

- [ ] **28.2.2** Docker-based GGUF embedding in A/B test
  - Start container: `docker run -d --gpus all -v models:/models -p 11435:8080 ghcr.io/ggml-org/llama.cpp:server-cuda --model /models/<model>.gguf --embedding`
  - Wait for health endpoint ready
  - Embed via `POST http://127.0.0.1:11435/embedding`
  - Stop container after test
  - Run each model test (code then NLP) in separate container instances

- [ ] **28.2.3** Cooldown between tests
  - Kill all containers between tests
  - `torch.cuda.empty_cache()` + `gc.collect()` for bf16 cleanup
  - Wait 5s between model loads for stable VRAM measurements
  - Flush page cache if sudo available

- [ ] **28.2.4** Decision logic and output
  - Quality thresholds: mean cosine sim > 0.99, min > 0.97, ranking 100% preserved
  - If GGUF passes quality AND uses less VRAM → recommend `advanced-gguf`
  - If GGUF fails quality → recommend `advanced-fp16`
  - Write recommendation + metrics to `embeddings-ready.json`
  - Log full results to `.anatoly/embeddings.log`

- [ ] **28.2.5** Make `--ab-test` flag available standalone
  - `npx anatoly setup-embeddings --ab-test` reruns the test without full setup
  - Useful for recalibrating after GPU/driver change

**Acceptance Criteria:**

**Given** a machine with ≥ 24 GB VRAM, Docker, and both model types available
**When** `npx anatoly setup-embeddings --ab-test` runs
**Then** bf16 and GGUF embeddings are compared on 10 code + 10 NLP samples
**And** recommendation is written to `embeddings-ready.json`
**And** each sample embedding is displayed in real-time during the test

**Given** GGUF quality meets thresholds (sim > 0.99, ranking preserved)
**When** A/B test completes
**Then** `embeddings-ready.json` contains `backend: "advanced-gguf"`

**Files:**
- `scripts/embedding-ab-test.py` — full rewrite for Docker-based GGUF testing
- `scripts/setup-embeddings.sh` — `--ab-test` flag routing

---

### Story 28.3 : Runtime — routing backend selon embeddings-ready.json

As Anatoly's RAG pipeline,
I want to read `embeddings-ready.json` and route embedding requests to the correct backend,
So that `anatoly run` uses the optimal backend without any selection logic at runtime.

**Priority:** P0 — Blocker
**Effort:** ~4h

**Tasks:**

- [ ] **28.3.1** Add Docker backend to `embed-sidecar.ts`
  - Read `backend` from `embeddings-ready.json`
  - If `advanced-gguf`: `docker run` with both GGUF models loaded simultaneously
  - Container exposes `/embedding` on port 11435
  - Health check before first embedding request
  - Graceful shutdown: `docker stop` at end of run

- [ ] **28.3.2** Dual-model simultaneous loading in Docker
  - Single container loads both models: code (nomic) + NLP (Qwen3)
  - Use `--model` for code, expose second model via `--model-alias` or separate port
  - Alternative: two containers on different ports (11435 code, 11436 NLP)
  - Choose approach based on llama.cpp server capabilities

- [ ] **28.3.3** Embedding client abstraction in `embeddings.ts`
  - `getEmbedder(backend)` returns the right client interface
  - lite: ONNX in-process
  - advanced-fp16: HTTP to Python sidecar
  - advanced-gguf: HTTP to Docker container
  - Same return type: `{ embedCode(text): number[], embedNlp(text): number[] }`

- [ ] **28.3.4** Fallback chain
  - If Docker container fails to start → try advanced-fp16 (if sidecar available)
  - If sidecar fails → fall back to lite ONNX
  - Log each fallback step as warning
  - Never fail silently — user sees which backend is active

- [ ] **28.3.5** Integration tests
  - Test with `backend: "advanced-gguf"` in embeddings-ready.json
  - Verify Docker container starts, embeds correctly, shuts down
  - Test fallback: Docker unavailable → fp16 → lite
  - Test RAG index phase produces correct vectors for each backend

**Acceptance Criteria:**

**Given** `embeddings-ready.json` with `backend: "advanced-gguf"`
**When** `npx anatoly run` starts the RAG index phase
**Then** Docker container starts with both GGUF models loaded
**And** code and NLP embeddings are produced via `/embedding` endpoint
**And** container is stopped at end of run

**Given** Docker is unavailable at runtime but `backend: "advanced-gguf"` is set
**When** `npx anatoly run` starts
**Then** fallback to advanced-fp16 or lite with a warning log
**And** run completes successfully with degraded backend

**Files:**
- `src/rag/embed-sidecar.ts` — Docker lifecycle management
- `src/rag/embeddings.ts` — `getEmbedder()` routing abstraction
- `src/rag/embed-sidecar.test.ts` — Docker + fallback tests

---

**Dépendances entre stories :**
```
28.1 (setup) → 28.2 (A/B test) → 28.3 (runtime)
```

**Risques techniques :**
- llama.cpp server ne supporte pas 2 modèles simultanés → utiliser 2 containers séparés
- NVIDIA Container Toolkit pas installé → fallback clair avec instructions d'install
- Port conflict avec le sidecar Python → utiliser des ports distincts (11435 Docker, 11436 Python)
- GGUF Q5_K_M quality trop basse pour certains modèles → A/B test gate automatique

**Given** `npx anatoly run --axes duplication --no-cache`
**When** exécuté
**Then** aucune doc section dans les candidats de duplication — non-régression confirmée

---

### Story 28.4 : Adversarial Code Review — Validation complète de l'Epic 28

As a tech lead,
I want an adversarial code review of the complete Epic 28 implementation,
So that every claim is verified against reality and no regression, gap, or shortcut passes.

**Priority:** P0 — Mandatory quality gate
**Effort:** ~2h
**Dependencies:** Stories 28.1 + 28.2 + 28.3 (all complete)

**Protocol:** BMAD adversarial review — minimum 3 specific issues, auto-fix HIGH/MEDIUM, re-verify after fixes.

**Tasks:**

- [ ] **28.4.1** Preflight verification
  - Run `npx anatoly setup-embeddings --check` — all dependencies detected, no errors
  - Verify `embeddings-ready.json` contains valid `backend` field
  - Verify GGUF files exist in `.anatoly/models/` if backend is `advanced-gguf`

- [ ] **28.4.2** File list verification
  - For each story 28.1-28.3: compare claimed files vs `git diff` reality
  - No phantom files (claimed modified but unchanged)
  - No forgotten files (modified but not listed in story)

- [ ] **28.4.3** Task `[x]` verification
  - For each task marked complete in stories 28.1-28.3
  - Open source file and verify implementation matches task description
  - Task `[x]` not implemented = finding CRITICAL

- [ ] **28.4.4** Acceptance Criteria verification
  - For each AC in stories 28.1-28.3: verify against implementation
  - AC status: IMPLEMENTED, PARTIAL, or MISSING
  - MISSING = finding HIGH

- [ ] **28.4.5** Non-regression tests
  - `npm run typecheck && npm run build && npm run test` — zero failures
  - Each test has real assertions (no placeholders)
  - Existing RAG tests still pass (duplication, documentation axes)

- [ ] **28.4.6** Integration test — tier selection
  - Test preflight on current machine: GPU detected, Docker detected, tier classified correctly
  - Verify `embeddings-ready.json` matches actual hardware capabilities
  - Test with `ANATOLY_MOCK_VRAM=8192` env var → should select lite
  - Test with Docker stopped → should fallback from gguf to fp16 or lite

- [ ] **28.4.7** Integration test — A/B test
  - Run `npx anatoly setup-embeddings --ab-test`
  - Verify bf16 and GGUF both produce embeddings with correct dimensions
  - Verify cosine similarity metrics are computed and logged
  - Verify recommendation is written to `embeddings-ready.json`

- [ ] **28.4.8** Integration test — runtime routing
  - Set `backend: "advanced-gguf"` in `embeddings-ready.json`
  - Run `npx anatoly run --axes duplication --no-cache` → Docker container starts, embeds, stops
  - Set `backend: "advanced-fp16"` → Python sidecar starts, embeds, stops
  - Set `backend: "lite"` → ONNX in-process, no external process
  - Remove Docker while `backend: "advanced-gguf"` → verify fallback with warning

- [ ] **28.4.9** Auto-fix findings
  - Fix all HIGH and MEDIUM findings
  - Re-run `npm run typecheck && npm run build && npm run test`
  - Re-verify impacted ACs
  - Commit fixes with descriptive messages

- [ ] **28.4.10** Final validation
  - All findings resolved or documented as accepted LOW
  - All 3 backends tested end-to-end
  - `embeddings-ready.json` schema documented
  - No orphan processes (Docker containers, Python sidecars) after run completes

**Acceptance Criteria:**

**Given** stories 28.1-28.3 marked complete
**When** each claim verified against `git diff` + source code
**Then** no task `[x]` not implemented, no AC missing

**Given** `npm run typecheck && npm run build && npm run test`
**When** executed after all fixes
**Then** all 3 commands pass without error

**Given** each backend (lite, advanced-fp16, advanced-gguf) tested
**When** `npx anatoly run` completes
**Then** embeddings produced correctly, no orphan processes, fallback chain works

## Epic 34 : Prompt Reinforcement — Audit, edge cases et renforcement des 36 prompts

Audit systématique des 36 system prompts du registry, identification et correction de 14 edge cases classifiés (4 CRITICAL, 5 HIGH, 5 MEDIUM), injection de guard rails anti-hallucination partagés, calibration des scores best-practices et des niveaux de confidence, gestion des edge cases (code généré, fichiers vides, troncature), injection dynamique d'exemples de schema Zod pour réduire les retries, et validation par gold-set testing avec appels LLM réels.

**Référence architecturale :** `_bmad-output/planning-artifacts/architecture.md` sections 34.1–34.8

### Story 34.1 : Structural Fixes — Correction des contradictions et erreurs factuelles

As a développeur d'Anatoly,
I want que les prompts système ne contiennent aucune contradiction interne ni erreur factuelle,
So that le LLM reçoive des instructions cohérentes et produise des réponses conformes au format attendu.

**Priority:** P0 — Quick wins, zero risk
**Effort:** ~1h
**Dependencies:** Aucune

**Tasks:**

- [ ] **34.1.1** Retirer les fences ` ```json ` des sections "Output format" dans les 6 prompts qui montrent un exemple entouré de fences tout en disant "no markdown fences"
  - `src/prompts/axes/correction.system.md`
  - `src/prompts/axes/utility.system.md`
  - `src/prompts/axes/duplication.system.md`
  - `src/prompts/axes/overengineering.system.md`
  - `src/prompts/axes/tests.system.md`
  - `src/prompts/axes/documentation.system.md`
  - Remplacer `Output ONLY a JSON object (no markdown fences, no explanation):` + bloc ` ```json ` par `Output ONLY a raw JSON object (no markdown fences, no explanation):` + JSON sans fences

- [ ] **34.1.2** Corriger le compteur d'axes dans `src/prompts/deliberation/deliberation.system.md`
  - Changer "6 independent axis evaluators" → "7 independent axis evaluators"
  - Le 7ème axe (documentation) existe depuis Epic 26

- [ ] **34.1.3** Ajouter un commentaire HTML en tête de chaque prompt best-practices variant documentant le delta de règles par rapport au prompt TypeScript de base (17 règles)
  - `best-practices.bash.system.md` : 14 règles (ShellGuard)
  - `best-practices.python.system.md` : 15 règles (PyGuard)
  - `best-practices.rust.system.md` : compter et documenter
  - Idem pour go, java, csharp, sql, yaml, json, react, nextjs
  - Format : `<!-- ShellGuard: 14 rules (vs 17 TypeGuard). Delta: removed TS-specific rules 1,3,4,6,16; added shell-specific rules for quoting, eval, trap -->`

- [ ] **34.1.4** Mettre à jour les tests de prompts existants
  - `src/prompts/axes/best-practices-prompts.test.ts` : ajouter un test vérifiant qu'aucun prompt axes n'a de fences ` ```json ` dans sa section Output format
  - `src/core/prompt-resolver.test.ts` : ajouter un test vérifiant que le mot "7" (pas "6") apparaît dans le prompt deliberation

**Acceptance Criteria:**

**Given** les 6 prompts axes avec des fences JSON dans l'exemple
**When** la story est complétée
**Then** aucun prompt axes ne contient de fences ` ```json ` dans sa section Output format
**And** chaque prompt dit "raw JSON object" dans l'instruction

**Given** le prompt deliberation
**When** je lis son contenu
**Then** il mentionne "7 independent axis evaluators" et non "6"

**Given** chaque prompt best-practices variant
**When** je lis le fichier
**Then** un commentaire HTML en tête documente le nombre de règles et le delta vs TypeScript base

**Given** `npm run test`
**When** les tests de prompts sont exécutés
**Then** le test "no JSON fences in output format" passe pour les 7 prompts axes
**And** le test "deliberation mentions 7 axes" passe

---

### Story 34.2 : Guard Rails — Infrastructure anti-hallucination partagée

As a développeur d'Anatoly,
I want un fichier de règles partagé injecté automatiquement dans tous les prompts d'axes,
So that le LLM ne puisse pas halluciner des symboles, des lignes hors limites, ou des structures invalides.

**Priority:** P0 — Fondation pour les stories suivantes
**Effort:** ~2h
**Dependencies:** Story 34.1 (structural fixes)

**Tasks:**

- [ ] **34.2.1** Créer `src/prompts/_shared/guard-rails.system.md` avec le contenu suivant :
  ```
  ## Constraints
  - ONLY output symbols that exist in the provided source code. Do NOT invent symbols.
  - Every symbol name you output MUST match exactly a symbol name from the source.
  - line_start and line_end MUST fall within the actual file line range (1 to N).
  - If the file contains 0 symbols or is empty, return the minimal valid response with an empty symbols array. Do NOT fabricate content.
  - action.line (when applicable) MUST reference a line that exists in the source file.
  - If the source code appears truncated (ends abruptly), only evaluate the symbols visible in the provided content. State in detail when a symbol evaluation may be incomplete due to truncation.

  ## Confidence Guide
  - 95-100: Certain — unambiguous evidence in the code (e.g., symbol is clearly exported and has 0 importers → DEAD with 95)
  - 85-94: High confidence — strong evidence but minor ambiguity possible (e.g., pattern looks like a bug but could be intentional edge case handling)
  - 70-84: Moderate — the finding is likely correct but contextual information is incomplete (e.g., behavior depends on runtime config not visible in the code)
  - Below 70: Low — speculation. Use this when you are guessing. Never output confidence below 50 — if you are that unsure, classify as the more conservative option.
  ```

- [ ] **34.2.2** Enregistrer `_shared.guard-rails` dans le registry de `src/core/prompt-resolver.ts`
  - Ajouter l'import du fichier `.md`
  - Ajouter l'entrée dans `registerDefaults()`

- [ ] **34.2.3** Modifier `src/core/axis-evaluator.ts` pour prepend guard-rails dans la composition du system prompt
  - Composition actuelle : `json-evaluator-wrapper + rawSystemPrompt`
  - Composition renforcée : `json-evaluator-wrapper + guard-rails + rawSystemPrompt`
  - Ne s'applique qu'aux appels d'axes (pas doc-generation, pas RAG)

- [ ] **34.2.4** Mettre à jour `src/core/prompt-resolver.test.ts`
  - Mettre à jour le count du registry (36 → 37 entrées)
  - Ajouter un test vérifiant que `resolveSystemPrompt('_shared.guard-rails')` retourne un contenu non-vide contenant "Constraints" et "Confidence Guide"

- [ ] **34.2.5** Ajouter un test d'intégration vérifiant que le system prompt composé pour chaque axe contient les guard-rails
  - Pour chaque axe (utility, correction, duplication, overengineering, tests, best_practices, documentation) : vérifier que le prompt composé contient "ONLY output symbols that exist"

**Acceptance Criteria:**

**Given** le fichier `_shared/guard-rails.system.md` créé
**When** `resolveSystemPrompt('_shared.guard-rails')` est appelé
**Then** il retourne le contenu avec les sections Constraints et Confidence Guide

**Given** un appel à `runSingleTurnQuery()` pour n'importe quel axe
**When** le system prompt est composé
**Then** il contient dans l'ordre : json-evaluator-wrapper, guard-rails, prompt spécifique de l'axe

**Given** le prompt composé pour l'axe utility
**When** je lis le contenu
**Then** il contient "ONLY output symbols that exist in the provided source code"
**And** il contient "Never output confidence below 50"

**Given** `npm run test`
**When** les tests du prompt-resolver sont exécutés
**Then** le registry contient 37 entrées
**And** le test de composition guard-rails passe pour les 7 axes

---

### Story 34.3 : Score Calibration — Ancrage des scores best-practices par langage

As a développeur d'Anatoly,
I want que chaque prompt best-practices contienne des exemples calibrés de ce que signifie chaque niveau de score,
So that les scores soient mieux distribués et plus discriminants au lieu de se concentrer autour de 7-9.

**Priority:** P1 — Amélioration qualité
**Effort:** ~3h
**Dependencies:** Story 34.1 (structural fixes)

**Tasks:**

- [ ] **34.3.1** Ajouter une section "Score Calibration" dans `src/prompts/axes/best-practices.system.md` (TypeScript/default) :
  ```
  ## Score Calibration
  - 9-10: Exemplary — all rules satisfied, modern patterns, comprehensive types, readonly where appropriate
  - 7-8: Good — minor issues (missing readonly, slight file size excess), no security or type problems
  - 5-6: Adequate — several WARN, maybe one HIGH violation, but functional and safe
  - 3-4: Below standard — multiple HIGH violations, `any` types present, missing error handling
  - 1-2: Poor — CRITICAL violations (security issues, no strict mode, widespread `any`)
  - 0: Catastrophic — multiple CRITICAL violations combined (eval + secrets + any)
  ```

- [ ] **34.3.2** Adapter la section Score Calibration pour chaque prompt best-practices variant avec des exemples spécifiques au langage :
  - `best-practices.bash.system.md` : adapter pour ShellGuard (set -euo pipefail, quoting, eval, trap)
  - `best-practices.python.system.md` : adapter pour PyGuard (type hints, f-strings, exception handling)
  - `best-practices.rust.system.md` : adapter pour RustGuard (ownership, unsafe, error handling)
  - `best-practices.go.system.md` : adapter pour GoGuard (error returns, goroutine leaks, interface usage)
  - `best-practices.java.system.md` : adapter pour JavaGuard (null safety, streams, generics)
  - `best-practices.csharp.system.md` : adapter pour CSharpGuard (nullable refs, async/await, LINQ)
  - `best-practices.sql.system.md` : adapter pour SqlGuard (injection, indexing, normalization)
  - `best-practices.yaml.system.md` : adapter pour YamlGuard (anchors, quoting, schema)
  - `best-practices.json.system.md` : adapter pour JsonGuard (schema, nesting, naming)
  - `best-practices.react.system.md` : adapter pour ReactGuard (hooks, memo, key, effects)
  - `best-practices.nextjs.system.md` : adapter pour NextGuard (SSR, routing, data fetching)

- [ ] **34.3.3** Mettre à jour les tests dans `src/prompts/axes/best-practices-prompts.test.ts`
  - Ajouter un test vérifiant que TOUS les prompts best-practices (base + 11 variants) contiennent la section "Score Calibration"
  - Vérifier que chaque section contient les 6 niveaux (9-10, 7-8, 5-6, 3-4, 1-2, 0)

**Acceptance Criteria:**

**Given** le prompt best-practices TypeScript (default)
**When** je lis le contenu
**Then** il contient une section "Score Calibration" avec 6 niveaux de 0 à 9-10

**Given** le prompt best-practices.bash
**When** je lis la section Score Calibration
**Then** les exemples mentionnent des concepts Bash (set -euo pipefail, quoting, eval) et non TypeScript

**Given** chacun des 12 prompts best-practices (base + 11 variants)
**When** le test vérifie la présence de Score Calibration
**Then** tous les 12 prompts ont la section avec les 6 niveaux

**Given** un fichier Bash exemplaire évalué après renforcement
**When** le score est attribué
**Then** le score reflète mieux la qualité réelle (pas de clustering autour de 7-9)

---

### Story 34.4 : Edge Case Handling — Code généré, doc-generation et RAG

As a développeur d'Anatoly,
I want que les prompts gèrent explicitement les cas limites (code généré, doc-generation sous-spécifié, nlp-summarizer fragile),
So that les évaluations soient fiables même sur des fichiers atypiques.

**Priority:** P1 — Réduction des faux positifs sur code atypique
**Effort:** ~2h
**Dependencies:** Story 34.2 (guard-rails)

**Tasks:**

- [ ] **34.4.1** Ajouter une règle "Generated Code" dans les prompts `correction`, `best-practices`, et `overengineering` :
  ```
  - If the file contains a code generation marker (e.g. "DO NOT EDIT", "@generated",
    "auto-generated"), evaluate leniently: generated code follows its generator's conventions,
    not human coding standards. Lower confidence by 20 points for any finding.
  ```
  - `src/prompts/axes/correction.system.md` : ajouter dans la section Rules
  - `src/prompts/axes/best-practices.system.md` : ajouter dans la section "Rules for evaluation"
  - `src/prompts/axes/overengineering.system.md` : ajouter dans la section Rules

- [ ] **34.4.2** Renforcer `src/prompts/doc-generation/doc-writer.system.md` :
  ```
  - Maximum page length: 500 lines of Markdown. If the content exceeds this, split into
    logical sub-pages and reference them.
  - Tone: technical, precise, third-person. No marketing language, no superlatives.
  - When source code contradicts existing documentation, follow the source code and note
    the discrepancy explicitly.
  ```

- [ ] **34.4.3** Renforcer `src/prompts/rag/nlp-summarizer.system.md` :
  ```
  - If a function body exceeds 200 lines, focus the summary on the public interface
    (parameters, return type, side effects) rather than implementation details.
  - If you cannot determine the function's purpose, return summary: "Purpose unclear
    from code alone" — do NOT hallucinate intent.
  - keyConcepts must be lowercase, hyphenated, max 30 chars each.
  ```

- [ ] **34.4.4** Tests : ajouter des tests vérifiant la présence des nouvelles règles
  - Test : `correction.system.md` contient "code generation marker"
  - Test : `doc-writer.system.md` contient "500 lines"
  - Test : `nlp-summarizer.system.md` contient "Purpose unclear"

**Acceptance Criteria:**

**Given** un fichier avec un header `// @generated by protobuf-ts`
**When** évalué par l'axe correction
**Then** le prompt contient la règle de leniency pour le code généré
**And** les findings ont une confidence réduite de 20 points

**Given** le prompt doc-writer
**When** je lis son contenu
**Then** il contient les contraintes de longueur max (500 lignes), de ton (technique, troisième personne), et de gestion des conflits source/docs

**Given** le prompt nlp-summarizer
**When** une fonction de 300 lignes est résumée
**Then** le prompt guide le LLM à se concentrer sur l'interface publique
**And** si la purpose est incertaine, il retourne "Purpose unclear from code alone"

---

### Story 34.5 : Schema Example Injection — Génération dynamique depuis les schemas Zod

As a développeur d'Anatoly,
I want que chaque system prompt d'axe contienne un exemple JSON généré dynamiquement depuis le schema Zod,
So that l'exemple soit toujours synchronisé avec le schema réel et que le taux de retry Zod diminue significativement.

**Priority:** P0 — Réduction des coûts (chaque retry double le coût de l'appel)
**Effort:** ~4h
**Dependencies:** Story 34.2 (guard-rails — composition du system prompt)

**Tasks:**

- [ ] **34.5.1** Créer `src/utils/schema-example.ts` avec deux fonctions :
  - `generateSchemaExample(schema: z.ZodType): unknown` — parcourt récursivement le schema Zod et produit un objet avec des valeurs représentatives :
    - `ZodObject` → objet avec chaque clé récursive
    - `ZodArray` → tableau avec 1 élément exemple
    - `ZodEnum` → première valeur de l'enum (toutes les valeurs en commentaire)
    - `ZodNumber` avec `.min()/.max()` → valeur médiane
    - `ZodString` avec `.min(10)` → `"<explanation — min 10 chars>"`
    - `ZodOptional` → unwrap
    - `ZodDefault` → valeur par défaut
    - `ZodNullable` → unwrap
    - `ZodInt` (custom ou via checks) → entier
  - `formatSchemaExample(schema: z.ZodType): string` — formatte en JSON lisible avec commentaires inline pour les enums (ex: `"OK"  // OK | NEEDS_FIX | ERROR`)

- [ ] **34.5.2** Créer `src/utils/schema-example.test.ts` avec :
  - Test unitaire par type Zod supporté (object, array, enum, number, string, optional, default, nullable)
  - **Round-trip test critique :** pour chaque schema d'axe (UtilityResponseSchema, CorrectionResponseSchema, DuplicationResponseSchema, OverengineeringResponseSchema, TestsResponseSchema, BestPracticesResponseSchema, DocumentationResponseSchema, VerificationResponseSchema) :
    - Générer l'exemple via `generateSchemaExample(schema)`
    - Valider que `schema.safeParse(example).success === true`
  - Test de format : `formatSchemaExample()` produit un string contenant les commentaires `//` pour les enums
  - Test de budget tokens : chaque exemple formaté fait < 300 tokens (estimation par longueur de string)

- [ ] **34.5.3** Exporter les schemas depuis chaque évaluateur si pas déjà exporté
  - Vérifier que `UtilityResponseSchema`, `CorrectionResponseSchema`, `DuplicationResponseSchema`, `OverengineeringResponseSchema`, `TestsResponseSchema`, `BestPracticesResponseSchema`, `DocumentationResponseSchema` sont accessibles depuis `src/core/axes/*.ts`
  - Ajouter les exports manquants

- [ ] **34.5.4** Modifier `src/core/axis-evaluator.ts` pour injecter l'exemple de schema dans le system prompt
  - Composition finale : `json-evaluator-wrapper + guard-rails + rawSystemPrompt + schemaExample`
  - Section injectée :
    ```
    ## Expected output schema

    Your response MUST conform exactly to this structure:

    {formatSchemaExample(schema)}
    ```
  - L'exemple est le **dernier élément** du system prompt (recall effect)
  - Le schema est passé via le paramètre existant ou ajouté à l'interface `SingleTurnQueryParams`

- [ ] **34.5.5** Test d'intégration : vérifier que le system prompt composé pour chaque axe contient la section "Expected output schema"
  - Pour chaque axe : construire le prompt composé et vérifier la présence de "Expected output schema"
  - Vérifier que le JSON exemple dans le prompt est valide (parseable par JSON.parse après stripping des commentaires)

**Acceptance Criteria:**

**Given** `generateSchemaExample(CorrectionResponseSchema)`
**When** l'exemple est généré
**Then** il produit un objet avec `symbols: [{ name, line_start, line_end, correction, confidence, detail }]` et `actions: [{ description, severity, line }]`
**And** `CorrectionResponseSchema.safeParse(example).success === true`

**Given** `formatSchemaExample(UtilityResponseSchema)`
**When** le format est généré
**Then** le résultat contient `"USED"  // USED | DEAD | LOW_VALUE` comme commentaire inline pour l'enum utility

**Given** un appel `runSingleTurnQuery()` pour l'axe correction
**When** le system prompt est composé
**Then** le dernier bloc du system prompt est "Expected output schema" suivi de l'exemple JSON formaté

**Given** les 8 schemas d'axe (7 axes + verification)
**When** `generateSchemaExample()` est exécuté sur chacun
**Then** tous les 8 exemples passent le round-trip test `schema.safeParse()`

**Given** `npm run test`
**When** les tests schema-example sont exécutés
**Then** tous les tests unitaires, round-trip, format et budget tokens passent

---

### Story 34.6 : Gold-Set Testing — Validation par appels LLM réels

As a tech lead,
I want une suite de tests avec des fichiers gold-set représentant les edge cases, évalués par les vrais prompts via des appels LLM réels,
So that je puisse valider que les renforcements produisent les verdicts attendus et détecter les régressions.

**Priority:** P1 — Validation finale
**Effort:** ~4h
**Dependencies:** Stories 34.1-34.5 (toutes les modifications de prompts)

**Tasks:**

- [ ] **34.6.1** Créer le dossier `src/prompts/__gold-set__/` avec 8 fichiers de test :
  - `empty-file.ts` — fichier vide, 0 symboles
  - `generated-protobuf.ts` — fichier avec header `// @generated by protobuf-ts`, code typique généré
  - `monolith-500-lines.ts` — fichier long avec 8+ fonctions, multi-patterns
  - `mixed-lang-sql.ts` — TypeScript avec SQL inline via template literals
  - `perfect-10.ts` — code exemplaire (strict types, readonly, JSDoc, modern syntax, no any)
  - `terrible-1.ts` — code avec `any`, `eval`, hardcoded secrets, no error handling
  - `dead-code.ts` — exports jamais importés (avec usage-graph vide)
  - `false-duplicate.ts` — deux fonctions structurellement similaires mais sémantiquement différentes

- [ ] **34.6.2** Créer `src/prompts/__gold-set__/gold-set.test.ts` — suite de test avec appels LLM réels
  - Configuration : vitest avec tag `@gold-set`, exclu du `npm run test` normal
  - Exécution : `npx vitest run --project gold-set` (manuelle uniquement, pas en CI)
  - Modèle : Haiku (coût minimal, ~$0.02 par fichier × 7 axes)
  - Pour chaque fichier gold-set × chaque axe pertinent :
    - Construire le system prompt (avec guard-rails + schema example)
    - Appeler `runSingleTurnQuery()` avec le schema Zod correspondant
    - Asserter sur le verdict principal (pas sur le detail) :
      - `empty-file.ts` → `symbols: []` pour tous les axes
      - `perfect-10.ts` → best-practices score ≥ 9.0
      - `terrible-1.ts` → best-practices score ≤ 3.0
      - `dead-code.ts` → utility = DEAD pour les exports orphelins
      - `false-duplicate.ts` → duplication = UNIQUE
      - `generated-protobuf.ts` → confidence réduite sur tous les findings

- [ ] **34.6.3** Créer un snapshot de référence (baseline)
  - Exécuter la suite gold-set une première fois
  - Sauvegarder les résultats comme baseline dans `src/prompts/__gold-set__/baseline.json`
  - Les runs ultérieurs comparent contre le baseline pour détecter les régressions

- [ ] **34.6.4** Documenter le processus d'exécution
  - Ajouter un `README.md` dans `src/prompts/__gold-set__/` expliquant :
    - Quand exécuter (après chaque modification de prompt)
    - Comment exécuter (`npx vitest run --project gold-set`)
    - Coût estimé (~$1.12 par run complet)
    - Comment interpréter les résultats et mettre à jour le baseline

**Acceptance Criteria:**

**Given** le fichier `empty-file.ts` évalué par l'axe utility
**When** le LLM produit sa réponse
**Then** le résultat est `{ "symbols": [] }` — aucun symbole inventé

**Given** le fichier `perfect-10.ts` évalué par l'axe best-practices
**When** le score est attribué
**Then** le score est ≥ 9.0

**Given** le fichier `terrible-1.ts` évalué par l'axe best-practices
**When** le score est attribué
**Then** le score est ≤ 3.0 (prouvant que le score anchoring fonctionne)

**Given** le fichier `dead-code.ts` évalué par l'axe utility
**When** les symboles sont analysés
**Then** les exports sans importeurs sont classés DEAD avec confidence ≥ 90

**Given** le fichier `false-duplicate.ts` évalué par l'axe duplication
**When** les fonctions structurellement similaires sont analysées
**Then** elles sont classées UNIQUE (pas DUPLICATE)

**Given** un run gold-set complet (8 fichiers × 7 axes)
**When** la suite se termine
**Then** le coût total est < $2.00 et tous les verdicts critiques sont conformes au baseline

---

### Story 34.7 : Adversarial Code Review — Validation complète de l'Epic 34

As a tech lead,
I want an adversarial code review of the complete Epic 34 implementation,
So that every claim is verified against reality and no regression, gap, or shortcut passes.

**Priority:** P0 — Mandatory quality gate
**Effort:** ~2h
**Dependencies:** Stories 34.1-34.6 (all complete)

**Protocol:** BMAD adversarial review — minimum 3 specific issues, auto-fix HIGH/MEDIUM, re-verify after fixes.

**Tasks:**

- [ ] **34.7.1** Preflight verification
  - `npm run typecheck && npm run build && npm run test` — zero failures
  - Prompt registry count = 37 (36 original + 1 guard-rails)
  - All 36 prompt files exist on disk and match registry keys (bidirectional coherence)

- [ ] **34.7.2** File list verification
  - For each story 34.1-34.6: compare claimed files vs `git diff` reality
  - No phantom files (claimed modified but unchanged)
  - No forgotten files (modified but not listed in story)

- [ ] **34.7.3** Structural fixes verification (Story 34.1)
  - Grep all 7 axis prompts for ` ```json ` — zero matches expected
  - Grep deliberation prompt for "7 independent" — match expected
  - Each best-practices variant has an HTML comment documenting rule count delta

- [ ] **34.7.4** Guard rails verification (Story 34.2)
  - `resolveSystemPrompt('_shared.guard-rails')` returns non-empty content
  - Composed system prompt for each axis contains guard-rails content BETWEEN json-evaluator-wrapper and axis prompt
  - Guard-rails contains both "Constraints" and "Confidence Guide" sections

- [ ] **34.7.5** Score calibration verification (Story 34.3)
  - All 12 best-practices prompts contain "Score Calibration" section
  - Each calibration section has 6 levels (9-10, 7-8, 5-6, 3-4, 1-2, 0)
  - Language-specific terms present (e.g., bash prompt mentions "set -euo pipefail", not "strict mode")

- [ ] **34.7.6** Edge case rules verification (Story 34.4)
  - `correction.system.md` contains "code generation marker"
  - `doc-writer.system.md` contains "500 lines" and "third-person"
  - `nlp-summarizer.system.md` contains "Purpose unclear"

- [ ] **34.7.7** Schema example injection verification (Story 34.5)
  - `schema-example.ts` exists with `generateSchemaExample()` and `formatSchemaExample()`
  - Round-trip test: all 8 schemas produce valid examples
  - Composed system prompt for each axis ends with "Expected output schema" section
  - Schema example is the LAST element in the system prompt

- [ ] **34.7.8** Gold-set verification (Story 34.6)
  - 8 gold-set files exist in `src/prompts/__gold-set__/`
  - Test suite exists and is excluded from `npm run test`
  - Baseline JSON exists with expected verdicts

- [ ] **34.7.9** Non-regression tests
  - `npm run typecheck && npm run build && npm run test` — zero failures after all changes
  - No existing test broken by prompt modifications
  - Bidirectional coherence test passes (no orphan files, no orphan registry keys)

- [ ] **34.7.10** Auto-fix findings
  - Fix all HIGH and MEDIUM findings
  - Re-run typecheck + build + test
  - Re-verify impacted ACs
  - Commit fixes

**Acceptance Criteria:**

**Given** stories 34.1-34.6 marked complete
**When** each claim verified against `git diff` + source code
**Then** no task `[x]` not implemented, no AC missing

**Given** `npm run typecheck && npm run build && npm run test`
**When** executed after all fixes
**Then** all 3 commands pass without error

**Given** the prompt registry
**When** queried for count
**Then** it contains exactly 37 entries with bidirectional coherence

## Epic 41 : Refinement 3-Tier — Pipeline de délibération post-run par investigation

Remplacer la délibération Opus per-file ($63/run, 116 calls) par un pipeline de refinement post-merge en 3 tiers : auto-resolve déterministe (tier 1, $0), cohérence inter-axes Flash (tier 2, $0.02), investigation agentic Opus (tier 3, ~$15). -76% coût, +50% qualité FP detection.

**FRs covered:** FR1-FR10 (voir document dédié)
**Document détaillé:** [epic-41-refinement-3-tier.md](epic-41-refinement-3-tier.md)

### Stories

| # | Story | Scope |
|---|-------|-------|
| 41.1 | Retirer la délibération per-file | Supprimer Opus dans `file-evaluator.ts`, écrire ReviewFiles bruts |
| 41.2 | Tier 1 — Auto-resolve déterministe | `refinement/tier1.ts` : usage graph, AST, RAG, coverage |
| 41.3 | Tier 2 — Cohérence inter-axes Flash | `refinement/tier2.ts` : contradictions logiques, escalade |
| 41.4 | Tier 3 — Investigation agentic Opus | `refinement/tier3.ts` : agent + tools, shards, memory |
| 41.5 | Intégration pipeline et UI | `run.ts`, screen renderer, progression |
| 41.6 | Validation qualité | Comparaison old vs new sur run 192337 |
| 41.7 | Adversarial review | Audit cynique de chaque story avant merge |

## Epic 44 : User Instructions — Calibration personnalisée via `ANATOLY.md`

Fichier `ANATOLY.md` à la racine du projet permettant d'injecter des conventions et règles projet-spécifiques comme contexte de calibration dans les prompts des 7 axes d'évaluation. Le LLM distingue ainsi les choix délibérés du projet des manquements réels.

**FRs covered:** FR16 (extension configuration)
**Document détaillé:** [epic-44-user-instructions.md](epic-44-user-instructions.md)

### Stories

| # | Story | Scope |
|---|-------|-------|
| 44.1 | Loader et parser `ANATOLY.md` | `src/utils/user-instructions.ts` + tests |
| 44.2 | Injection dans les prompts d'axes | `composeAxisSystemPrompt()` dans `axis-evaluator.ts` |
| 44.3 | Intégration pipeline `run` | Propagation `UserInstructions` dans le contexte + tous les axes |
| 44.4 | Documentation utilisateur | `docs/01-Getting-Started/02-Configuration.md` |
