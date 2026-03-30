---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - docs/prd.md
workflowType: 'architecture'
project_name: 'anatoly'
user_name: 'Rviau'
date: '2026-02-23'
lastStep: 8
status: 'complete'
completedAt: '2026-02-23'
updatedAt: '2026-03-30'
updateReason: 'Epic 46 — Transport-Level Resilience: semaphores & circuit breakers dans le router'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
- CLI avec 10 commandes principales : `run`, `scan`, `estimate`, `review`, `report`, `watch`, `status`, `rag-status`, `clean-runs`, `reset`
- Pipeline séquentiel scan → estimate → rag index (optionnel) → review → report avec commande `run` qui orchestre le tout
- Détection sémantique de duplications via RAG : pré-indexation des fonctions avec Haiku, embeddings locaux (Xenova/all-MiniLM-L6-v2), recherche vectorielle (LanceDB), outil MCP `findSimilarFunctions` exposé à l'agent reviewer
- Parsing AST complet via tree-sitter-typescript (TS + TSX)
- Hash SHA-256 par fichier pour cache déterministe
- Intégration coverage Istanbul/Vitest/Jest (format JSON)
- Agent Claude Code avec accès outils filesystem (grep, read_file, search) pour chaque fichier audité
- Validation Zod stricte des reviews avec retry automatique (max 3) et feedback d'erreur
- Zéro interruption : `npx anatoly run` tourne de bout en bout sans confirmation intermédiaire
- Dual output : `.rev.json` (machine-readable) + `.rev.md` (humain-readable)
- Transcripts complets du raisonnement de l'agent sauvegardés en Markdown
- Mode watch via chokidar : re-scan + re-review incrémental des fichiers modifiés
- Support monorepo (Yarn/PNPM/Nx/Turbo workspaces, multiples tsconfig)
- Estimation de scope pré-review via tiktoken (comptage local de tokens, zéro appel LLM)
- Rapport agrégé avec tableaux triés, dead code list, duplications groupées, actions priorisées

**Non-Functional Requirements:**
- Zéro faux positif comme philosophie centrale (confidence score 0-100 sur chaque finding)
- Faux positifs DEAD < 3%
- Validation Zod première passe > 97%
- Deuxième run sur codebase inchangée < 4s et 0$
- Temps moyen premier rapport < 45 min
- Timeout par fichier : 180 secondes max
- Distribution npx (zéro install)
- Ne jamais toucher au code source (lecture seule absolue)

**Scale & Complexity:**

- Domaine principal : CLI / pipeline de traitement backend Node.js
- Niveau de complexité : Moyen-Haut
- Composants architecturaux estimés : 8-10 (CLI parser, scanner AST, hasher/cache, coverage parser, estimateur, orchestrateur review, agent prompt builder, reporter, watcher)

### Technical Constraints & Dependencies

- Runtime : Node.js 20+ (contrainte npx)
- Dépendance externe critique : Claude Code CLI (mode agent) — disponibilité et API stable requises
- tree-sitter + tree-sitter-typescript : binding natif Node.js (compilation C++)
- chokidar : dépendance filesystem pour watch mode
- Zod : validation runtime, source de vérité des schémas
- Cibles : projets TypeScript/TSX de 20 à 1000+ fichiers

### Cross-Cutting Concerns Identified

- **Gestion d'état et reprise** : progress.json doit être cohérent à tout moment (crash recovery)
- **Concurrence** : potentiel de parallélisation des reviews par fichier vs coût API et rate limits
- **Cache invalidation** : SHA-256 + gestion des fichiers supprimés/renommés
- **Configuration monorepo** : résolution correcte des paths, tsconfig inheritance, workspace boundaries
- **Error handling LLM** : timeout, réponses malformées, retry avec Zod feedback, coûts imprévus
- **Formats de sortie** : cohérence entre JSON et Markdown, aggregation cross-fichiers pour le rapport

## Starter Template Evaluation

### Primary Technology Domain

CLI tool / Pipeline de traitement backend Node.js — outil en ligne de commande avec sous-commandes, zéro frontend.

### Starter Options Considered

| Option | Évaluation | Décision |
|--------|-----------|----------|
| oclif | Framework complet avec plugins, scaffolding, testing intégré | Rejeté — over-engineered pour Anatoly (pas de besoin de plugins) |
| citty (UnJS) | Élégant, TypeScript natif, léger | Rejeté — v0.2.0, immature pour un outil de production |
| yargs | Puissant, feature-rich | Rejeté — API verbeuse, types boulonnés |
| Commander.js | Standard de facto, léger, TypeScript via extra-typings | Sélectionné |
| Starter templates (cli-typescript-starter, etc.) | Templates pré-configurés | Rejeté — ajoutent des opinions non pertinentes |

### Selected Approach: From Scratch avec Commander.js

**Rationale :**
Anatoly est un outil CLI ciblé avec 7-8 sous-commandes simples. Pas de besoin de système de plugins, de scaffolding, ou de conventions imposées par un framework lourd. Commander.js (238M downloads/semaine) est le standard éprouvé et offre exactement ce qu'il faut : parsing d'arguments, sous-commandes, aide auto-générée, avec un typage TypeScript renforcé.

**Stack de développement :**

| Composant | Choix | Justification |
|-----------|-------|---------------|
| CLI Framework | Commander.js + @commander-js/extra-typings | Standard, léger, TypeScript typé |
| Build | tsup (esbuild) | Zero-config, rapide, ESM+CJS, .d.ts |
| Dev runner | tsx | Exécution directe TS sans compilation |
| Tests | Vitest | Rapide, ESM natif, API Jest-compatible |
| Linting | ESLint | Standard de l'écosystème |
| Package manager | npm | Standard, compatibilité npx native |
| Validation runtime | Zod | Défini dans le PRD — source de vérité des schémas |
| AST Parser | web-tree-sitter (WASM) + tree-sitter-typescript | WASM = zéro compilation native, npx sans friction |
| Estimation tokens | tiktoken | Comptage local de tokens, zéro appel LLM |
| Spinner progression | ora | Léger, async-friendly, indicateur de fichier en cours |
| Zone fixe terminal | log-update | Réécriture en place (ANSI cursor) pour dashboard live |
| Tableaux rapport | cli-table3 | Tableaux formatés alignés dans le rapport Markdown |
| Embeddings locaux | @xenova/transformers (all-MiniLM-L6-v2) | 384 dimensions, runs local dans Node.js, zéro appel API |
| Vector store | @lancedb/lancedb | Base vectorielle colonnaire, upserts efficaces, recherche L2 |

**Initialisation :**

```bash
npm init -y
npm install commander zod chalk ora log-update cli-table3 tiktoken
npm install -D typescript tsup tsx vitest eslint @commander-js/extra-typings @types/node
```

**Structure projet :**

```
anatoly/
├── src/
│   ├── index.ts              # Entry point CLI (Commander)
│   ├── commands/             # Sous-commandes (scan, review, report...)
│   ├── core/                 # Logique métier (scanner, reviewer, reporter)
│   ├── schemas/              # Schémas Zod
│   └── utils/                # Utilitaires (cache, hash, config, renderer)
├── tests/
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
└── package.json              # bin: { "anatoly": "./dist/index.js" }
```

**Note :** L'initialisation du projet avec cette configuration devrait être la première story d'implémentation.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Bloquent l'implémentation) :**
- Interaction LLM : Claude Agent SDK
- Format de configuration : YAML
- Stratégie de cache et état : SHA-256 + progress.json + lock file
- Gestion des erreurs LLM : retry Zod avec feedback, timeout, crash recovery

**Important Decisions (Façonnent l'architecture) :**
- Concurrence : séquentiel v1
- Format des transcripts : stream temps réel, 1 fichier/fichier audité

**Deferred Decisions (Post-MVP) :**
- Parallélisation des reviews (v1.1+)
- Cache partagé mode équipe (v2.0)
- Multi-langage (v2.0)

### Interaction LLM — Architecture Multi-Axes

**Historique :** La v0.1–v0.3 utilisait un agent monolithique (un seul query par fichier, toutes dimensions évaluées ensemble). La v0.4 a introduit l'architecture multi-axes : 6 évaluateurs indépendants exécutés en parallèle par fichier.

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| SDK | `@anthropic-ai/claude-agent-sdk` | API programmatique TypeScript, in-process, `query()` single-turn (maxTurns: 1, no tools) |
| Pattern d'évaluation | Multi-axes parallèles (6 axes) | Chaque axe est un évaluateur indépendant focalisé sur une seule dimension — modularité, testabilité, isolation des erreurs |
| Exécution | `Promise.allSettled()` | Les 6 axes s'exécutent simultanément par fichier — même coût, 3-4× plus rapide qu'un agent monolithique |
| Modèle par axe | Configurable via `axes.[axis].model` | Axes simples (utility, tests) sur Haiku, axes complexes (correction, duplication, overengineering, best_practices) sur Sonnet |
| Estimation tokens | tiktoken (local) | Comptage de tokens local via tiktoken, zéro appel LLM |
| Retry | Zod feedback (max 2 tentatives par axe) | `runSingleTurnQuery()` valide avec Zod, renvoie l'erreur au modèle si échec |

**Pourquoi multi-axes vs agent monolithique :**
- **Modularité** — chaque axe indépendant, testable unitairement
- **Parallélisme** — 6 queries concurrentes (même coût API, latence réduite)
- **Configurabilité** — activer/désactiver chaque axe via `axes.[axis].enabled`
- **Économie** — modèles moins chers (Haiku) pour les axes simples
- **Isolation des erreurs** — un axe en échec ne bloque pas les autres
- **Extensibilité** — ajouter un nouvel axe sans toucher aux autres

### Les 6 Axes d'Évaluation

| Axe | ID | Modèle par défaut | Valeurs | Description |
|-----|----|--------------------|---------|-------------|
| Utility | `utility` | haiku | USED / DEAD / LOW_VALUE | Détection de code mort via usage-graph pré-calculé |
| Duplication | `duplication` | sonnet | UNIQUE / DUPLICATE | Détection sémantique (RAG pré-résolu si disponible) |
| Correction | `correction` | sonnet | OK / NEEDS_FIX / ERROR | Bugs, erreurs logiques, problèmes de sécurité |
| Over-engineering | `overengineering` | sonnet | LEAN / ACCEPTABLE / OVER | Complexité disproportionnée par rapport au besoin |
| Tests | `tests` | haiku | GOOD / WEAK / NONE | Qualité de la couverture de tests |
| Best Practices | `best_practices` | sonnet | Score 0-10 + 17 règles | Scoring qualitatif avec règles catégorisées (CRITIQUE/HAUTE/MOYENNE) |

**Interface commune (`AxisEvaluator`) :**

```ts
interface AxisEvaluator {
  readonly id: AxisId;
  readonly defaultModel: 'sonnet' | 'haiku';
  evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult>;
}
```

**Contexte partagé (`AxisContext`) :**

```ts
interface AxisContext {
  task: Task;              // AST + hash + metadata
  fileContent: string;     // Contenu du fichier (lu une seule fois)
  config: Config;          // Configuration globale
  usageGraph?: UsageGraph; // Graphe d'imports pré-calculé (pour utility)
  preResolvedRag?: PreResolvedRag; // Résultats RAG pré-résolus (pour duplication)
  fileDeps?: FileDependencyContext; // Dépendances npm du fichier
}
```

**Résultat par axe (`AxisResult`) :**

```ts
interface AxisResult {
  axisId: AxisId;
  symbols: AxisSymbolResult[];        // Résultats par symbole
  fileLevel?: { unused_imports, circular_dependencies, general_notes };
  actions: Action[];                  // Actions recommandées
  costUsd: number;
  durationMs: number;
  transcript: string;
}
```

### Orchestration par Fichier (`file-evaluator.ts`)

Le `file-evaluator.ts` orchestre l'évaluation complète d'un fichier :

1. Lecture du fichier source (une seule fois)
2. Pré-résolution RAG (si activé) — recherche vectorielle des symboles
3. Extraction du contexte de dépendances npm
4. Exécution parallèle de tous les évaluateurs via `Promise.allSettled()`
5. Collecte des résultats (succès et erreurs loggées)
6. Extraction des données best_practices
7. Fusion via `axis-merger.ts` → `ReviewFile` v2
8. **(v0.5.0)** Si délibération activée et `needsDeliberation(review)` : Opus Deliberation Pass → `ReviewFile` ajusté

### Fusion des Résultats (`axis-merger.ts`)

Le `axis-merger.ts` combine les résultats de 6 axes indépendants en un seul `ReviewFile` v2 :

**Fusion par symbole :**
- Chaque axe produit un `AxisSymbolResult` (value + confidence + detail) par symbole
- Le merger assemble les 5 valeurs d'axes en un `SymbolReview` complet
- Les axes absents reçoivent des valeurs par défaut (USED, UNIQUE, OK, LEAN, NONE)

**Règles de cohérence inter-axes :**
- Si `utility=DEAD` → force `tests=NONE` (pas de point à tester du code mort)
- Si `correction=ERROR` → force `overengineering=ACCEPTABLE` (la complexité est secondaire face à une erreur)

**Fusion du detail :**
- Format pipe-délimité : `[USED] explanation | [UNIQUE] explanation | ...`
- Parsé par `parseDetailSegments()` dans le markdown renderer

**Fusion des actions :**
- Toutes les actions de tous les axes sont concaténées
- Re-indexées séquentiellement (IDs 1, 2, 3...)
- Champ `source` : identifie l'axe d'origine de chaque action

**Calcul du verdict :**
- `CRITICAL` : au moins un symbole avec `correction=ERROR`
- `NEEDS_REFACTOR` : au moins un `NEEDS_FIX`, `DEAD`, `DUPLICATE`, ou `OVER`
- `CLEAN` : aucun finding

**Métadonnées par axe (`axis_meta`) :**

```json
{
  "utility": { "model": "claude-haiku-4-5", "cost_usd": 0.0012, "duration_ms": 1234 },
  "correction": { "model": "claude-sonnet-4-6", "cost_usd": 0.0045, "duration_ms": 2456 }
}
```

### Opus Deliberation Pass (v0.5.0)

**Problème observé :** Le self-audit d'Anatoly (v0.4.2) a révélé que le merger mécanique produit des verdicts incorrects quand les axes se contredisent (ex: correction=NEEDS_FIX sur async vs best_practices Rule 12=PASS). Les règles de cohérence codées en dur (`applyCoherenceRules`, `detectContradictions`) ne couvrent que des cas spécifiques. Il manque un arbitre généraliste.

**Solution :** Un "juge de délibération" Opus post-merge qui voit le tableau complet des 6 axes fusionnées et arbitre la cohérence.

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Position dans le pipeline | Post-merge, pré-écriture (dans `file-evaluator.ts`, après `mergeAxisResults()`) | Seul point où toutes les données inter-axes sont disponibles simultanément |
| Modèle | Opus (`claude-opus-4-6`) configurable via `llm.deliberation_model` | Meilleure capacité de jugement nuancé — il ne génère pas les findings, il les arbitre |
| Déclenchement | Conditionnel : `needsDeliberation(review)` → au moins un finding non-CLEAN OU verdict != CLEAN | Les fichiers CLEAN 95%+ passent directement — concentre Opus sur les ~25% de cas ambigus |
| Activation | Opt-in via `llm.deliberation: true` dans `.anatoly.yml` ou `--deliberation` CLI | Feature premium, coût élevé — l'utilisateur décide explicitement |
| Input | `ReviewFile` fusionné + code source du fichier + `best_practices` (si disponible) | Tout le contexte nécessaire pour arbitrer sans réévaluer |
| Output | `ReviewFile` modifié — mêmes types, même schéma Zod v2 | Pas de nouveau schéma — confidences ajustées, findings reclassifiés, verdict recalculé |
| Schéma LLM | Zod schema dédié `DeliberationResponseSchema` : verdict, symboles reclassifiés avec raisons, actions filtrées | Validation stricte comme les axes — retry Zod si malformé |
| Failure handling | Graceful — si Opus échoue, on garde le merge brut (même pattern que verification pass de correction) | La délibération améliore mais ne bloque jamais |
| Coût tracking | `axis_meta.deliberation: { model, cost_usd, duration_ms }` dans le `.rev.json` | Traçabilité du surcoût Opus par fichier |
| Transcript | Appendé au `.log` existant sous un header `## Deliberation Pass` | Transparence totale (principe #6 du PRD) |

**Pourquoi post-merge et pas comme 7ème axe :**
Un 7ème axe parallèle ne verrait que le code source — il n'aurait aucune connaissance des verdicts des autres axes. La valeur d'Opus est de *croiser* les findings et de juger leur cohérence collective. Il doit être en aval du merge.

**Pourquoi Opus et pas Sonnet :**
Les faux positifs résiduels post-merge sont des cas nuancés qui requièrent un raisonnement de niveau supérieur. Sonnet les a déjà évalués en pass 1 — re-soumettre le même modèle ne ferait que confirmer ses propres biais. Opus apporte un regard neuf et plus puissant.

**Impact coût :** ~10× Sonnet par requête × ~25% des fichiers = surcoût moyen de ~2.5× le coût d'un axe Sonnet par run complet.

**Impact latence :** +15-30s par fichier délibéré, exécuté séquentiellement post-merge (dans le worker du file-evaluator).

**Orchestration dans `file-evaluator.ts` :**

```
1. Lecture fichier (une fois)
2. Pré-résolution RAG
3. Extraction deps npm
4. Exécution 6 axes en parallèle (Promise.allSettled)
5. Collecte résultats + erreurs
6. Fusion via axis-merger → ReviewFile brut
7. [NEW] Si deliberation activé ET needsDeliberation(review):
   → deliberate(review, fileContent, ctx) → ReviewFile ajusté
8. Écriture .rev.json + .rev.md + .log
```

**Fichier d'implémentation :** `src/core/deliberation.ts` (nouveau module — pas dans `axes/` car ce n'est pas un axe indépendant)

### RAG — Détection Sémantique de Duplications

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Activation | Opt-in via `--enable-rag` ou `rag.enabled: true` dans `.anatoly.yml` | Feature expérimentale, coût additionnel (Haiku) |
| Pré-indexation | Haiku (`claude-haiku-4-5-20251001`) génère les FunctionCards avant les reviews | Rapide, pas cher, index complet dès le début |
| Embeddings | `@xenova/transformers` (all-MiniLM-L6-v2, 384D) | Local, zéro appel API, modèle léger |
| Vector store | LanceDB (colonnaire, L2 distance) | Efficace pour upserts et recherche vectorielle |
| Consommation | Pré-résolution dans `file-evaluator.ts` → injecté dans `AxisContext.preResolvedRag` | Plus de MCP server — résultats RAG pré-résolus avant l'évaluation |
| Cache | `.anatoly/rag/cache.json` — map `functionId → fileHash` | Incrémental : seuls les fichiers modifiés sont ré-embedés |
| Seuils similarité | >= 0.85 → DUPLICATE, 0.78–0.85 → mention dans detail, < 0.78 → UNIQUE | Équilibre entre détection et faux positifs |
| Conversion distance | `cosine_similarity = 1 - L2² / 2` (vecteurs normalisés) | LanceDB retourne L2² par défaut |

**FunctionCard (schéma interne au module RAG) :**
- `id` : SHA-256 tronqué 16 chars de `filepath:lineStart-lineEnd`
- `summary` : résumé conceptuel 1-2 phrases (max 400 chars, par Haiku)
- `keyConcepts` : 3-6 mots-clés (par Haiku)
- `behavioralProfile` : pure | sideEffectful | async | memoized | stateful | utility
- `complexityScore` : 1-5 (cyclomatic, calculé par AST)
- `signature`, `calledInternals` : extraits par AST

### Time Estimation Model

**Problem:** The current estimator uses a flat `SECONDS_PER_FILE = 8` constant for all files, regardless of size, symbol count, or model latency. Combined with a naive `÷ concurrency` division, estimates are systematically inaccurate — too optimistic for large files with many symbols, too pessimistic for small files.

**Root causes identified:**

1. **Flat constant ignores file variance** — A 10-line file with 1 symbol and a 500-line file with 30 symbols both cost "8 seconds"
2. **Concurrency scaling is linear** — Dividing by concurrency ignores tail effects (last workers finish alone), rate limiting backoff, and API contention
3. **Estimate and triage are disconnected** — The `estimate` step displays time before triage runs, so the user sees the pre-triage (worst-case) number first
4. **No calibration feedback loop** — Actual per-file `durationMs` is captured in `EvaluateFileResult` but never persisted or used to refine future estimates

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Per-file time model | Weighted formula: `BASE_SECONDS + (symbolCount × SECONDS_PER_SYMBOL)` | Accounts for the dominant variable — symbol count drives LLM output tokens and thus latency. Base covers the fixed overhead (file read, prompt assembly, RAG pre-resolution) |
| Constants (initial) | `BASE_SECONDS = 4`, `SECONDS_PER_SYMBOL = 0.8` | Empirical starting point: a file with 5 symbols ≈ 8s (matches current constant), a file with 20 symbols ≈ 20s. To be refined via calibration |
| Concurrency factor | `effectiveTime = totalSequentialTime / (concurrency × CONCURRENCY_EFFICIENCY)` where `CONCURRENCY_EFFICIENCY = 0.75` | 25% overhead accounts for rate limits, API contention, and tail effects. Better than the current naive `÷ concurrency` |
| Triage-aware estimate | Merge triage into the estimate step — run triage first, then compute time only for `evaluate` tier files | Eliminates the "two different numbers" confusion. The user sees one realistic estimate |
| Calibration logging | Persist `{ file, symbolCount, durationMs }` in run metadata after each run | Creates a dataset for future constant refinement. No runtime cost — just append to existing run output |
| Display format | `~N min` (rounded up to nearest minute) with `±30%` accuracy target | Users need a ballpark, not false precision. The `~` prefix signals approximation |

**Formula summary:**

```
sequentialSeconds = Σ (BASE_SECONDS + symbolCount_i × SECONDS_PER_SYMBOL) for each evaluate-tier file
estimatedMinutes = ceil(sequentialSeconds / (concurrency × 0.75) / 60)
```

**Implementation scope:**
- `estimator.ts` — Replace `SECONDS_PER_FILE` constant with weighted formula, add `estimateTriagedProject()` that takes triage results
- `run.ts` — Reorder: run triage before estimate display, pass triage map to estimator
- `estimate.ts` — Standalone command keeps the pre-triage estimate (no triage data available), but uses the weighted formula
- `reporter.ts` — `estimatedTimeSaved` uses the same weighted formula for consistency

**Calibration roadmap (post-implementation):**
- Phase 1: Ship weighted formula with empirical constants
- Phase 2: After 5+ real runs, compare estimated vs actual per-file durations from calibration logs
- Phase 3: Adjust `BASE_SECONDS` and `SECONDS_PER_SYMBOL` based on observed P50 latencies

### Triage (`core/triage.ts`)

**Objectif :** Classifier les fichiers en `skip` ou `evaluate` avant d'appeler les axes LLM, pour éviter les appels API inutiles sur les fichiers triviaux.

| Tier | Raison | Condition | Résultat |
|------|--------|-----------|----------|
| `skip` | `barrel-export` | 0 symboles + toutes les lignes sont des `export` | ReviewFile synthétique CLEAN (`is_generated: true`) |
| `skip` | `trivial` | < 10 lignes + ≤ 1 symbole | ReviewFile synthétique CLEAN |
| `skip` | `type-only` | Tous les symboles sont `type` ou `enum` | ReviewFile synthétique CLEAN |
| `skip` | `constants-only` | Tous les symboles sont `constant` | ReviewFile synthétique CLEAN |
| `evaluate` | `internal` | Symboles présents mais aucun exporté | Évaluation complète (6 axes) |
| `evaluate` | `simple` | < 3 symboles | Évaluation complète |
| `evaluate` | `complex` | ≥ 3 symboles | Évaluation complète |

**ReviewFile synthétique :**
- `version: 2`, `is_generated: true`, `skip_reason: "<raison>"`
- Tous les symboles avec valeurs par défaut (OK, LEAN, USED, UNIQUE, NONE, confidence 100)
- Zéro appel API — coût $0.00

**Impact :** Réduit ~30% des appels API en skippant les fichiers triviaux (barrel exports, types, constantes).

### Usage Graph (`core/usage-graph.ts`)

**Objectif :** Pré-calculer le graphe d'imports du projet (une seule passe locale, zéro API) pour fournir au utility evaluator des données déterministes sur l'utilisation de chaque symbole.

**Structure :**

```ts
interface UsageGraph {
  usages: Map<string, Set<string>>;          // "symbolName::filePath" → importers (runtime)
  typeOnlyUsages: Map<string, Set<string>>;  // "symbolName::filePath" → importers (type-only)
}
```

**Algorithme :**
1. Construction d'une carte d'exports à partir des tasks (AST)
2. Pour chaque fichier du projet : extraction des imports via regex (named, default, namespace, re-exports, star re-exports, type-only)
3. Résolution des chemins d'import (`.js` → `.ts`, bare → `/index.ts`)
4. Peuplement des maps `usages` et `typeOnlyUsages`

**Consommation :** Injecté dans `AxisContext.usageGraph` pour le utility evaluator.

### Dependency Metadata (`core/dependency-meta.ts`)

**Objectif :** Extraire les versions des dépendances npm utilisées par chaque fichier pour enrichir le contexte des évaluateurs (détection de patterns obsolètes, API dépréciées).

**Interface :**

```ts
interface DependencyMeta {
  dependencies: Map<string, string>;  // nom → version
  engines?: Record<string, string>;   // { node: '>=20.19' }
}

interface FileDependencyContext {
  deps: Array<{ name: string; version: string }>;  // Subset pour ce fichier
  nodeEngine?: string;
}
```

**Fonctionnement :**
1. `loadDependencyMeta(projectRoot)` : lecture du `package.json` (dependencies + devDependencies + engines)
2. `extractFileDeps(fileContent, meta)` : détection des imports bare (non relatifs, non `node:`) → filtrage par les dépendances connues

**Consommation :** Injecté dans `AxisContext.fileDeps` pour les évaluateurs (best_practices, correction).

### Data Architecture (Fichiers Locaux)

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Configuration | YAML (`.anatoly.yml`) via `js-yaml` | Standard CLI, lisible, familier aux devs TS |
| État du pipeline | `progress.json` dans `.anatoly/cache/` | Source de vérité pour reprise et statut |
| Lock file | `.anatoly/lock` (PID + timestamp) | Protection contre double instance |
| Cache | SHA-256 par fichier dans `progress.json` | Déterministe, zéro coût sur fichiers inchangés |
| Tasks | `.task.json` par fichier dans `.anatoly/tasks/` | AST extrait + hash + metadata coverage |
| Reviews | `.rev.json` + `.rev.md` dans `.anatoly/runs/<id>/reviews/` | Dual output machine + humain, scopé par run |
| Transcripts | `.transcript.md` par fichier dans `.anatoly/runs/<id>/logs/` | Stream temps réel, scopé par run |
| Rapport | `report.md` dans `.anatoly/runs/<id>/` | Index agrégé de tous les findings, scopé par run |
| RAG cache | `cache.json` dans `.anatoly/rag/` | Map `functionId → fileHash` pour indexation incrémentale |
| RAG vector store | LanceDB dans `.anatoly/rag/lancedb/` | FunctionCards + embeddings 384D |

**Gestion des runs :**
- Chaque exécution de `anatoly run` crée un dossier `.anatoly/runs/<id>/` contenant reviews, logs et rapport
- L'identifiant est auto-généré (timestamp) ou fourni via `--run-id <id>`
- Le paramètre `output.max_runs` dans `.anatoly.yml` permet l'auto-purge des anciens runs
- La commande `clean-runs` supprime les runs avec option `--keep <n>` pour conserver les N derniers

**Convention de nommage des fichiers output :**
- Transformation des chemins sources : `src/utils/format.ts` → `src-utils-format` (slashes → tirets, extension retirée)
- Exemples :
  - `runs/<id>/reviews/src-utils-format.rev.json`
  - `runs/<id>/reviews/src-utils-format.rev.md`
  - `runs/<id>/logs/src-utils-format.transcript.md`
  - `tasks/src-utils-format.task.json`

**Structure du `report.md` :**
1. Résumé exécutif (compteurs + verdict global)
2. Tableau des findings triés par sévérité (high → medium → low)
3. Liste des fichiers propres (collapsed ou en fin de document)
4. Fichiers en erreur (si applicable)
5. Métadonnées (date, version, durée, tokens consommés)

**Structure du `.rev.md` (v2) :**
1. Header avec chemin du fichier, verdict, et mention `is_generated` si triage skip
2. Tableau des symboles (8 colonnes : Correction, Over-eng., Utility, Duplication, Tests, Confidence)
3. Détails par symbole — breakdown per-axe structuré : `**Utility [USED]**: explanation`
4. Section Best Practices — score /10, tableau des règles WARN/FAIL, suggestions before/after
5. Actions groupées par catégorie (Quick Wins / Refactors / Hygiene) avec tag **[source · severity · effort]**
6. Notes file-level (unused imports, circular dependencies, general notes)

**Structure du `.rev.json` (v2) :**

```json
{
  "version": 2,
  "file": "src/core/scanner.ts",
  "is_generated": false,
  "verdict": "NEEDS_REFACTOR",
  "symbols": [
    {
      "name": "scanFile",
      "kind": "function",
      "exported": true,
      "line_start": 42,
      "line_end": 108,
      "correction": "OK",
      "overengineering": "LEAN",
      "utility": "USED",
      "duplication": "UNIQUE",
      "tests": "WEAK",
      "confidence": 85,
      "detail": "[USED] exported... | [UNIQUE] no duplication... | [OK] no issues | [LEAN] appropriate | [WEAK] no test file"
    }
  ],
  "actions": [
    {
      "id": 1,
      "description": "Add unit tests for edge cases",
      "severity": "medium",
      "effort": "small",
      "category": "hygiene",
      "source": "correction",
      "target_symbol": "scanFile",
      "target_lines": "L42-L108"
    }
  ],
  "best_practices": {
    "score": 7.5,
    "rules": [{ "rule_id": 2, "rule_name": "No any", "status": "FAIL", "severity": "CRITIQUE" }],
    "suggestions": [{ "description": "Replace any with unknown", "before": "data: any", "after": "data: unknown" }]
  },
  "axis_meta": {
    "utility": { "model": "claude-haiku-4-5", "cost_usd": 0.0012, "duration_ms": 1234 },
    "correction": { "model": "claude-sonnet-4-6", "cost_usd": 0.0045, "duration_ms": 2456 }
  },
  "file_level": {
    "unused_imports": [],
    "circular_dependencies": [],
    "general_notes": ""
  }
}
```

### Error Handling & Résilience

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Retry Zod | `ZodError.format()` renvoyé comme message à Claude, max 3 tentatives | Auto-correction quasi systématique au 2e essai |
| Timeout | 180s par fichier → statut `TIMEOUT` dans progress.json → fichier suivant | Pas de blocage, résilience |
| Crash recovery | `anatoly review` lit progress.json au démarrage, skip `DONE`, re-tente `IN_PROGRESS`/`TIMEOUT`/`ERROR` | Zéro travail perdu |
| Fichier corrompu | Écriture atomique (tmp + rename) pour progress.json | Intégrité garantie même en cas de kill |

**Statuts possibles dans progress.json :**

| Statut | Signification |
|--------|--------------|
| `PENDING` | Fichier scanné, en attente de review |
| `IN_PROGRESS` | Review en cours |
| `DONE` | Review terminée avec succès |
| `TIMEOUT` | Timeout 180s atteint |
| `ERROR` | Échec après 3 retries Zod |
| `CACHED` | Hash SHA-256 inchangé, skip |

### Concurrence

**Historique :** La v0.1 était séquentielle (1 fichier à la fois). La v0.4 a introduit deux niveaux de parallélisme.

| Niveau | Mécanisme | Détail |
|--------|-----------|--------|
| **Intra-fichier** | `Promise.allSettled()` dans `file-evaluator.ts` | Les 6 axes s'exécutent en parallèle pour chaque fichier — latence divisée par ~4 |
| **Inter-fichier** | `worker-pool.ts` avec `concurrency` configurable | Pool de workers concurrence-limitée, dispatching immédiat quand un worker se libère |

**Worker Pool (`core/worker-pool.ts`) :**

```ts
interface WorkerPoolOptions<T> {
  items: T[];
  concurrency: number;           // Max workers simultanés (default: 4, configurable via llm.concurrency)
  handler: (item: T, workerIndex: number) => Promise<void>;
  isInterrupted?: () => boolean; // Support SIGINT
}
```

- Lance `min(concurrency, items.length)` workers en parallèle
- Chaque worker traite les items séquentiellement jusqu'à épuisement
- Gestion SIGINT : arrête le dispatching, attend les workers actifs
- Erreurs swallowed par le pool (le handler gère ses propres erreurs)
- Retourne `{ completed, errored, skipped }`

**Configuration :** `llm.concurrency` dans `.anatoly.yml` (default: 4, max: 10)

**Concurrency effective totale :** `concurrency × 6 axes` = jusqu'à 24 requêtes LLM simultanées avec concurrency=4

### ActionSchema — Traçabilité de l'Axe Source

**Problème (v0.4.2) :** Les actions dans les rapports `.rev.md` affichent `**[medium · small]**` mais ne montrent pas quel axe a produit l'action. L'utilisateur ne sait pas si c'est `correction`, `utility`, `duplication`, `overengineering`, ou `tests` qui a déclenché le finding.

**Cause racine :** Le `ActionSchema` ne contient pas de champ `source`. Lors du merge dans `axis-merger.ts`, l'information `axisId` de l'`AxisResult` parent est perdue.

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Champ | `source: AxisIdSchema.optional()` dans `ActionSchema` | Identifie l'axe d'origine de chaque action |
| Backward compat | `.optional()` — absents dans les reviews v1 | Les anciens `.rev.json` restent valides |
| Tagging | Dans `mergeActions()` de `axis-merger.ts` | `r.actions.map(a => ({ ...a, source: r.axisId }))` |
| Rendu `.rev.md` | `**[correction · medium · small]**` | L'axe source apparaît en premier dans le tag |
| Rendu `report.md` | Idem dans `renderAction()` de `reporter.ts` | Cohérence entre les deux rendus |

**Fichiers impactés :**
- `schemas/review.ts` — Ajout `source: AxisIdSchema.optional()` dans `ActionSchema`
- `core/axis-merger.ts` — `mergeActions()` tague `source: r.axisId`
- `core/review-writer.ts` — `renderFileAction()` affiche `[${a.source} · ${a.severity} · ${effort}]`
- `core/reporter.ts` — `renderAction()` même pattern

### Infrastructure & Deployment

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Distribution | npm + npx | Zéro install, standard Node.js |
| CI/CD | GitHub Actions | Standard open source |
| Versioning | Semantic versioning (semver) | Standard npm |
| Environnement | Variable `ANTHROPIC_API_KEY` requise | Standard Anthropic, pas de gestion custom |

### Flags CLI Globaux

| Flag | Effet | Cas d'usage |
|------|-------|-------------|
| `--plain` | Désactive log-update, output linéaire séquentiel | CI/CD, pipes, logs |
| `--no-cache` | Ignore le cache SHA-256, re-review tous les fichiers | Après changement de prompt/config |
| `--file <glob>` | Restreint le scope à un pattern de fichiers | Review ciblée |
| `--no-color` | Désactive chalk (supporté aussi via `$NO_COLOR`) | Environnements sans support ANSI |
| `--verbose` | Affiche les détails d'opérations (hashes, tool calls) | Debug, curiosité |
| `--enable-rag` | Active l'indexation RAG et l'outil `findSimilarFunctions` | Détection sémantique de duplications |
| `--rebuild-rag` | Force la reconstruction complète de l'index vectoriel | Après changement de modèle ou corruption |
| `--run-id <id>` | Identifiant de run personnalisé (alphanumérique, tirets, underscores) | Runs nommés, reproductibilité |

**Priorité de configuration :** Flag CLI > `.anatoly.yml` > défaut automatique

**Détection automatique :** Si `stdout` n'est pas un TTY (pipe/CI), le mode `--plain` est activé automatiquement.

### Exit Codes

| Code | Signification | Usage |
|------|--------------|-------|
| `0` | Codebase propre — aucun finding | Scripts CI : `anatoly run && echo "clean"` |
| `1` | Findings détectés — audit terminé avec résultats | Le dev consulte le rapport |
| `2` | Erreur technique — impossible de compléter l'audit | Pas de tsconfig, erreur LLM globale |

### Gestion SIGINT (Ctrl+C)

- Arrêt propre : le fichier en cours est abandonné
- Affichage d'un résumé partiel : `interrupted — 47/142 files reviewed | 8 findings`
- Les reviews déjà sauvegardées restent intactes dans `.anatoly/reviews/`
- Le dev peut relancer `anatoly run` — le cache reprend là où il en était

### Vocabulaire des Verdicts

**Verdicts par fichier :**

| Verdict | Couleur | Signification |
|---------|---------|---------------|
| `CLEAN` | `chalk.green` | Aucun finding |
| `DEAD` | `chalk.yellow` | Symbole sans référence confirmée |
| `DUP` | `chalk.yellow` | Logique sémantiquement dupliquée |
| `OVER` | `chalk.yellow` | Complexité disproportionnée |
| `ERR` | `chalk.red` | Échec de la review (timeout, Zod) |

**Verdict global du codebase :**

| Verdict | Couleur | Signification |
|---------|---------|---------------|
| `CLEAN` | `chalk.green` | Codebase sans findings |
| `NEEDS_REFACTOR` | `chalk.yellow` | Findings non critiques présents |
| `CRITICAL` | `chalk.red` | Erreurs ou findings high severity |

**Règles de ton :** Toujours factuel, jamais moralisateur. Les verdicts sont le seul élément en MAJUSCULES dans le terminal. Le rouge est rare — réservé aux erreurs techniques, pas aux findings de code.

### Decision Impact Analysis

**Séquence d'implémentation (historique + v0.4 + v0.5) :**
1. Setup projet (Commander + tsup + Vitest + ESLint)
2. Schémas Zod (contrat de données central)
3. Config loader (YAML → typed config + AxesConfigSchema)
4. Scanner AST (tree-sitter + hash SHA-256)
5. Cache manager (progress.json + lock file)
6. Triage (classification skip/evaluate)
7. Usage Graph (pré-calcul imports)
8. Dependency Metadata (extraction npm deps)
9. Axis Evaluator framework (interface + runSingleTurnQuery)
10. 6 Axis Evaluators (utility, duplication, correction, overengineering, tests, best-practices)
11. Axis Merger (fusion + cohérence inter-axes + detectContradictions)
12. File Evaluator (orchestration per-file parallèle)
13. Worker Pool (concurrence inter-fichiers)
14. Review Writer (.rev.json + .rev.md + transcripts)
15. Reporter (aggregation → report.md)
16. CLI commands (scan, estimate, review, report, run, status, clean-runs, reset, hook) + flags globaux
17. Watch mode (chokidar + re-scan incrémental)
18. Module RAG (types → embeddings → vector-store → indexer → card-generator → orchestrator)
19. **(v0.5.0)** Opus Deliberation Pass (deliberation.ts + intégration file-evaluator + config + CLI flag)

**Dépendances cross-composants :**
- Le file-evaluator dépend du scanner (tasks), des axes, du merger, du RAG (pré-résolution), et de la délibération (v0.5.0)
- Le worker-pool orchestre les file-evaluators en parallèle
- Le reporter dépend des reviews (.rev.json)
- Le watch mode dépend du scanner et du file-evaluator
- La commande `run` orchestre scan → estimate → triage → usage-graph → dep-meta → rag index → review (worker-pool) → report
- La commande `run` délègue la phase RAG à `rag/orchestrator.ts` via `indexProject()`
- Tous les composants dépendent des schémas Zod comme contrat partagé
- Le module `rag/` est auto-contenu : ses types (`FunctionCard`, etc.) vivent dans `rag/types.ts`, pas dans `schemas/`
- Les axes ne dépendent pas les uns des autres — isolation complète
- **(v0.5.0)** Le module `deliberation.ts` dépend du merger (ReviewFile), de `axis-evaluator.ts` (runSingleTurnQuery), et du config (deliberation_model)

## Implementation Patterns & Consistency Rules

### Points de conflit identifiés

6 catégories de patterns où un agent IA pourrait faire des choix divergents sans règles explicites.

### Naming Patterns

**Fichiers & dossiers :**
- `kebab-case.ts` pour tous les fichiers source (ex: `ast-scanner.ts`, `review-runner.ts`, `progress-manager.ts`)
- Dossiers en `kebab-case` (ex: `commands/`, `core/`, `schemas/`)

**Code TypeScript :**
- Fonctions / variables : `camelCase` (ex: `scanFile()`, `computeHash()`, `reviewResult`)
- Types / Interfaces : `PascalCase` (ex: `ReviewFile`, `TaskResult`, `AnatolyConfig`)
- Constantes : `UPPER_SNAKE_CASE` (ex: `MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- Schémas Zod : `PascalCase` + suffixe `Schema` (ex: `ReviewFileSchema`, `TaskSchema`, `ActionSchema`)

**Données JSON (.task.json, .rev.json, progress.json) :**
- `snake_case` — conforme au schéma Zod du PRD (`line_start`, `line_end`, `target_symbol`, `duplicate_target`)
- Le schéma Zod du PRD est le contrat public, on ne dévie pas

### Structure Patterns

**Organisation des tests :**
- Co-located : le test est à côté du fichier source
- `src/core/scanner.ts` → `src/core/scanner.test.ts`
- `src/utils/hash.ts` → `src/utils/hash.test.ts`
- Convention Vitest standard, un agent IA crée toujours le test au même endroit

**Organisation des modules (v0.4.2) :**

```
src/
├── index.ts              # Entry point CLI uniquement (Commander setup)
├── cli.ts                # Commander program + registration des commandes + flags globaux
├── commands/             # Handlers de sous-commandes (1 fichier = 1 commande)
│   ├── index.ts          # Barrel export
│   ├── scan.ts
│   ├── estimate.ts
│   ├── review.ts         # Utilise file-evaluator + getEnabledEvaluators
│   ├── report.ts
│   ├── run.ts            # Pipeline : scan → estimate → triage → usage-graph → rag → review → report
│   ├── watch.ts
│   ├── status.ts
│   ├── hook.ts           # Hook system
│   ├── rag-status.ts
│   ├── clean-runs.ts     # (anciennement clean-logs.ts)
│   └── reset.ts
├── core/                 # Logique métier pure (pas de CLI concerns)
│   ├── axes/             # [NEW v0.4] Évaluateurs par axe
│   │   ├── index.ts      # Registry + getEnabledEvaluators()
│   │   ├── utility.ts    # UtilityEvaluator (USED/DEAD/LOW_VALUE) — haiku
│   │   ├── duplication.ts # DuplicationEvaluator (UNIQUE/DUPLICATE) — sonnet
│   │   ├── correction.ts # CorrectionEvaluator (OK/NEEDS_FIX/ERROR) — sonnet
│   │   ├── overengineering.ts # OverengineeringEvaluator (LEAN/OVER/ACCEPTABLE) — sonnet
│   │   ├── tests.ts      # TestsEvaluator (GOOD/WEAK/NONE) — haiku
│   │   └── best-practices.ts # BestPracticesEvaluator (score 0-10 + 17 rules) — sonnet
│   ├── axis-evaluator.ts # [NEW v0.4] Interface AxisEvaluator + runSingleTurnQuery() + types
│   ├── axis-merger.ts    # [NEW v0.4] Fusion 6 axes → ReviewFile v2 + cohérence inter-axes
│   ├── deliberation.ts   # [NEW v0.5] Opus Deliberation Pass — validation post-merge inter-axes
│   ├── correction-memory.ts # [NEW v0.5] Mémoire des faux positifs vérifiés (correction axis)
│   ├── file-evaluator.ts # [NEW v0.4] Orchestration per-file (parallèle + merge + délibération)
│   ├── triage.ts         # [NEW v0.4] Classification skip/evaluate + ReviewFile synthétique
│   ├── usage-graph.ts    # [NEW v0.4] Graphe d'imports pré-calculé (zéro API)
│   ├── dependency-meta.ts # [NEW v0.4] Extraction dépendances npm par fichier
│   ├── worker-pool.ts    # [NEW v0.4] Pool de concurrence (workers parallèles inter-fichiers)
│   ├── scanner.ts        # AST parsing + hash + coverage
│   ├── estimator.ts      # Estimation scope via tiktoken (comptage local)
│   ├── review-writer.ts  # Écriture .rev.json + .rev.md + transcripts
│   ├── progress-manager.ts # Gestion atomique de progress.json
│   └── reporter.ts       # Aggregation reviews → report.md
├── rag/                  # Détection sémantique de duplications (opt-in)
│   ├── index.ts          # Barrel export
│   ├── types.ts          # FunctionCard, SimilarityResult, RagStats (schémas Zod internes)
│   ├── embeddings.ts     # Xenova/all-MiniLM-L6-v2 pipeline (embed, buildEmbedText)
│   ├── vector-store.ts   # LanceDB wrapper (upsert, search, searchById, stats)
│   ├── indexer.ts        # Construction FunctionCards + indexation incrémentale
│   ├── card-generator.ts # Génération des summaries via Haiku
│   └── orchestrator.ts   # indexProject() — orchestre la phase RAG complète
├── schemas/              # Schémas Zod — source de vérité
│   ├── review.ts         # ReviewFileSchema v2 (contrat PRD + axis_meta + best_practices)
│   ├── task.ts           # TaskSchema
│   ├── config.ts         # ConfigSchema + AxesConfigSchema + RagConfigSchema + OutputConfigSchema
│   └── progress.ts       # ProgressSchema
└── utils/                # Utilitaires transverses
    ├── cache.ts          # SHA-256 hashing + cache logic
    ├── config-loader.ts  # YAML → typed config
    ├── confirm.ts        # Confirmation interactive utilisateur
    ├── errors.ts         # AnatolyError class + codes standardisés
    ├── extract-json.ts   # Extraction JSON depuis réponses LLM (shared)
    ├── format.ts         # Formatage temps, nombres, etc.
    ├── git.ts            # Gitignore pattern matching
    ├── hook-state.ts     # Gestion d'état des hooks
    ├── lock.ts           # Lock file management
    ├── open.ts           # Ouverture de fichiers (OS)
    ├── process.ts        # Utilitaires process (isCI, isTTY)
    ├── rate-limiter.ts   # Rate limiter pour API Anthropic
    ├── run-id.ts         # Génération d'identifiants de run + gestion répertoires + purge
    └── version.ts        # Version du package
```

**Fichiers supprimés (v0.4) :**
- `core/reviewer.ts` — remplacé par `file-evaluator.ts` + `axis-evaluator.ts` + `axes/*`
- `core/watcher.ts` — logique déplacée dans `commands/watch.ts`
- `utils/prompt-builder.ts` — prompts distribués dans chaque axe évaluateur
- `utils/monorepo.ts` — simplifié, intégré dans config-loader
- `utils/renderer.ts` — refactoré, rendu terminal simplifié
- `rag/tools.ts` — supprimé (RAG pré-résolu dans file-evaluator, plus besoin de MCP server)

**Fichiers ajoutés (v0.4) :**
- `utils/confirm.ts`, `utils/format.ts`, `utils/hook-state.ts`, `utils/open.ts`, `utils/process.ts`, `utils/rate-limiter.ts`, `utils/version.ts`
- `commands/hook.ts`

**Barrel files (`index.ts`) :**
- Uniquement à la racine de chaque dossier majeur
- Exports nommés exclusivement — jamais de `export default`

### Import/Export Patterns

**Règles strictes :**
- `export default` interdit — toujours des exports nommés
- Imports avec chemin relatif dans le même module
- Imports via barrel (`from '../core'`) entre modules différents
- Pas d'import circulaire — les schémas sont la base, le core dépend des schémas, les commands dépendent du core

**Hiérarchie de dépendance :**
```
schemas/ ← ne dépend de rien
utils/   ← dépend de schemas/
rag/     ← dépend de schemas/ et utils/ (types internes dans rag/types.ts)
core/    ← dépend de schemas/, utils/, et rag/
  core/axes/ ← dépend de core/axis-evaluator.ts et schemas/
  core/axis-merger.ts ← dépend de core/axis-evaluator.ts et schemas/
  core/file-evaluator.ts ← dépend de core/axes/, core/axis-merger, rag/
commands/ ← dépend de core/, rag/, schemas/, utils/
index.ts ← dépend de commands/
```

**Note :** Le module `rag/` définit ses propres types (`FunctionCard`, `SimilarityResult`) dans `rag/types.ts` car ce sont des concepts internes au RAG, pas des contrats publics du PRD. `schemas/review.ts` ne dépend PAS de `rag/`.

**Note v0.4 :** Les axes (`core/axes/`) n'importent pas entre eux. Leur seule dépendance commune est `core/axis-evaluator.ts` (interface + utilitaire `runSingleTurnQuery`). Cela garantit l'isolation : un axe peut être modifié, supprimé ou ajouté sans impact sur les autres.

### Error Handling Patterns

**Classe d'erreur custom :**

```ts
export class AnatolyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean
  ) {
    super(message);
    this.name = 'AnatolyError';
  }
}
```

**Codes d'erreur standardisés :**

| Code | Catégorie | Exemple |
|------|-----------|---------|
| `CONFIG_INVALID` | Utilisateur | YAML malformé ou champ manquant |
| `CONFIG_NOT_FOUND` | Utilisateur | `.anatoly.yml` introuvable |
| `FILE_NOT_FOUND` | Utilisateur | Fichier source introuvable |
| `LOCK_EXISTS` | Utilisateur | Une autre instance tourne déjà |
| `LLM_TIMEOUT` | LLM | Timeout 180s atteint |
| `LLM_API_ERROR` | LLM | Erreur API Anthropic |
| `ZOD_VALIDATION_FAILED` | LLM | Réponse LLM invalide après 3 retries |
| `TREE_SITTER_PARSE_ERROR` | Interne | Échec parsing AST |
| `WRITE_ERROR` | Interne | Impossible d'écrire un fichier output |

**Comportement par catégorie :**
- **Utilisateur** : message clair en français/anglais, exit code 1, pas de stack trace
- **LLM** : loggé dans transcript, statut dans progress.json, fichier suivant
- **Interne** : stack trace en `--verbose`, message simplifié sinon

### Logging & Output Patterns

**Rendu terminal :**
- Listr2 pour la progression multi-fichiers avec sous-tâches par axe
- `chalk` pour les couleurs terminal (verdicts, statuts, progression)
- Détection automatique du mode : TTY → streaming enrichi, pipe/CI → mode `--plain` linéaire (`utils/process.ts`)
- Affichage compact : progression des axes par fichier (spinner par axe en cours)
- Pas de dépendance logging lourde (pas de winston/pino)

**Verbose mode (`--verbose`) :**
- Logger interne activé par le flag global
- Préfixé par `[anatoly]` + timestamp
- Détails des opérations : fichiers scannés, hashes, tool calls, etc.

**Transcripts (fichiers) :**
- Un fichier par fichier audité : `logs/{path-avec-tirets}.transcript.md`
- Stream temps réel (append incrémental)
- Chaque tool call et réponse loggée avec timestamp

### Enforcement Guidelines

**Tout agent IA DOIT :**
- Utiliser `kebab-case` pour les noms de fichiers
- Créer le test co-located avec chaque nouveau fichier
- Utiliser uniquement des exports nommés
- Respecter la hiérarchie de dépendance (schemas → utils → rag → core → commands)
- Lancer `AnatolyError` avec un code standardisé pour toute erreur
- Suivre le schéma Zod du PRD en `snake_case` pour les données JSON

**Anti-patterns interdits :**
- `export default` dans n'importe quel fichier
- Import circulaire entre modules
- `console.log` dans `core/` ou `rag/` (utiliser le logger, le renderer, ou un callback)
- Dépendances directes entre axes (`core/axes/utility.ts` ne doit PAS importer `core/axes/correction.ts`)
- Logique inter-axes dans un évaluateur (la cohérence inter-axes est dans `axis-merger.ts` uniquement)
- Dépendances directes de `commands/` vers `utils/` sans passer par `core/` quand la logique est métier
- Fichiers de test dans un dossier `tests/` séparé
- Actions sans champ `source` — toute action doit tracer son axe d'origine

## Project Structure & Boundaries

### Complete Project Directory Structure (v0.4.2)

```
anatoly/
├── .github/
│   └── workflows/
│       └── ci.yml                    # GitHub Actions : lint + test + build
├── .gitignore
├── .npmignore                        # Exclure src/, tests, configs dev du package npm
├── package.json                      # bin: { "anatoly": "./dist/index.js" }, type: "module"
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── eslint.config.js                  # ESLint flat config
├── README.md
├── LICENSE
├── scripts/
│   └── download-model.js             # Téléchargement du modèle Xenova/MiniLM
├── dist/                             # Output tsup (gitignored)
│   └── index.js                      # Entry point CLI compilé
├── src/
│   ├── index.ts                      # Entry point : program.parse()
│   ├── cli.ts                        # Commander program + registration commandes + flags globaux
│   ├── commands/
│   │   ├── index.ts                  # Barrel export
│   │   ├── scan.ts                   # anatoly scan
│   │   ├── estimate.ts               # anatoly estimate
│   │   ├── review.ts                 # anatoly review (utilise file-evaluator)
│   │   ├── report.ts                 # anatoly report
│   │   ├── run.ts                    # anatoly run (pipeline complet avec triage + usage-graph)
│   │   ├── watch.ts                  # anatoly watch (chokidar intégré)
│   │   ├── status.ts                 # anatoly status
│   │   ├── hook.ts                   # Hook system
│   │   ├── rag-status.ts             # anatoly rag-status (inspection index RAG)
│   │   ├── clean-runs.ts             # anatoly clean-runs
│   │   └── reset.ts                  # anatoly reset
│   ├── core/
│   │   ├── axes/                     # [v0.4] Évaluateurs par axe
│   │   │   ├── index.ts              # Registry + getEnabledEvaluators()
│   │   │   ├── utility.ts            # UtilityEvaluator (haiku)
│   │   │   ├── duplication.ts        # DuplicationEvaluator (sonnet)
│   │   │   ├── correction.ts         # CorrectionEvaluator (sonnet)
│   │   │   ├── overengineering.ts    # OverengineeringEvaluator (sonnet)
│   │   │   ├── tests.ts              # TestsEvaluator (haiku)
│   │   │   └── best-practices.ts     # BestPracticesEvaluator (sonnet, 17 rules)
│   │   ├── axis-evaluator.ts         # [v0.4] Interface + runSingleTurnQuery()
│   │   ├── axis-merger.ts            # [v0.4] Fusion 6 axes → ReviewFile v2
│   │   ├── file-evaluator.ts         # [v0.4] Orchestration per-file parallèle
│   │   ├── triage.ts                 # [v0.4] Classification skip/evaluate
│   │   ├── usage-graph.ts            # [v0.4] Graphe d'imports pré-calculé
│   │   ├── dependency-meta.ts        # [v0.4] Extraction dépendances npm
│   │   ├── worker-pool.ts            # [v0.4] Pool de concurrence inter-fichiers
│   │   ├── scanner.ts                # tree-sitter AST parsing + SHA-256 hash + coverage
│   │   ├── estimator.ts              # Estimation scope via tiktoken (comptage local)
│   │   ├── review-writer.ts          # Écriture .rev.json + .rev.md + transcripts
│   │   ├── progress-manager.ts       # Gestion atomique de progress.json
│   │   └── reporter.ts               # Aggregation .rev.json → report.md
│   ├── rag/
│   │   ├── index.ts                  # Barrel export
│   │   ├── types.ts                  # FunctionCard, SimilarityResult, RagStats (Zod)
│   │   ├── embeddings.ts             # Xenova/all-MiniLM-L6-v2 (embed, buildEmbedText)
│   │   ├── vector-store.ts           # LanceDB wrapper (upsert, search, searchById)
│   │   ├── indexer.ts                # Construction FunctionCards + indexation incrémentale
│   │   ├── card-generator.ts         # Génération summaries via Haiku
│   │   └── orchestrator.ts           # indexProject() — phase RAG complète
│   ├── schemas/
│   │   ├── review.ts                 # ReviewFileSchema v2 + ActionSchema + BestPracticesSchema + AxisIdSchema
│   │   ├── task.ts                   # TaskSchema (AST + hash + coverage)
│   │   ├── config.ts                 # ConfigSchema + AxesConfigSchema + RagConfigSchema
│   │   └── progress.ts               # ProgressSchema (état pipeline)
│   └── utils/
│       ├── cache.ts                  # SHA-256 hashing + comparaison + invalidation
│       ├── config-loader.ts          # YAML → ConfigSchema validé
│       ├── confirm.ts                # Confirmation interactive utilisateur
│       ├── errors.ts                 # AnatolyError + codes standardisés
│       ├── extract-json.ts           # Extraction JSON depuis réponses LLM
│       ├── format.ts                 # Formatage temps, nombres
│       ├── git.ts                    # Gitignore pattern matching
│       ├── hook-state.ts             # Gestion d'état des hooks
│       ├── lock.ts                   # Lock file acquire/release (PID + timestamp)
│       ├── open.ts                   # Ouverture fichiers (OS)
│       ├── process.ts                # Utilitaires process (isCI, isTTY)
│       ├── rate-limiter.ts           # Rate limiter API Anthropic
│       ├── run-id.ts                 # Génération d'identifiants de run + gestion répertoires + purge
│       └── version.ts                # Version du package
```

### Architectural Boundaries

**Frontière CLI ↔ Core :**
- Les `commands/` ne contiennent aucune logique métier — seulement le parsing des options Commander et l'appel aux fonctions `core/`
- Toute la logique réside dans `core/`
- Un handler de commande = ~10-20 lignes max

**Frontière Core ↔ Schemas :**
- Les schémas Zod sont la source de vérité absolue
- `core/` importe les types inférés (`z.infer<typeof ReviewFileSchema>`)
- Toute donnée entrante/sortante est validée par Zod

**Frontière Core ↔ Utils :**
- `utils/` = fonctions pures et utilitaires transverses (pas de logique métier)
- `core/` orchestre les utils pour produire le résultat final

**Frontière Core ↔ RAG :**
- `rag/` est un module opt-in — le système fonctionne sans lui
- `core/file-evaluator.ts` pré-résout les résultats RAG via `vectorStore.searchById()` (si RAG actif)
- Les résultats pré-résolus sont injectés dans `AxisContext.preResolvedRag` pour le duplication evaluator
- `commands/run.ts` appelle `rag/orchestrator.ts:indexProject()` pour la phase d'indexation
- Les types RAG (`FunctionCard`, etc.) restent dans `rag/types.ts`, pas dans `schemas/`

**Frontière interne ↔ externe (Claude Agent SDK) :**
- `core/axis-evaluator.ts` (`runSingleTurnQuery`) : point d'entrée unique vers l'API Claude pour tous les axes (single-turn, no tools)
- `rag/card-generator.ts` communique avec l'API Claude pour la pré-indexation (Haiku)
- `estimator.ts` utilise tiktoken en local
- Le reste du système est découplé du LLM

**Frontière Axes ↔ Core :**
- Chaque axe dans `core/axes/` est un module indépendant implémentant `AxisEvaluator`
- Les axes ne se connaissent pas entre eux — l'inter-axe coherence est gérée par `axis-merger.ts`
- `core/axes/index.ts` est le registry — ajouter un nouvel axe = 1 import + 1 ligne dans `ALL_EVALUATORS`

### Data Flow

```
.anatoly.yml (config)
      ↓ config-loader.ts (YAML → ConfigSchema)
      ↓
[Phase 1 — scan] scanner.ts
      ├── tree-sitter → AST (symboles exportés, lignes, kind)
      ├── crypto.createHash('sha256') → hash fichier
      ├── coverage JSON → données par fichier
      └── → .anatoly/tasks/{file}.task.json (TaskSchema)
      └── → .anatoly/cache/progress.json (PENDING)
      ↓
[Phase 2 — estimate] estimator.ts
      ├── Lecture des .task.json
      ├── tiktoken → comptage tokens local (input/output)
      └── → Affichage : fichiers / symboles / tokens estimés / temps estimé
      ↓
[Phase 3 — triage] triage.ts  ← [NEW v0.4]
      ├── Pour chaque fichier scanné :
      │   ├── triageFile(task, source) → { tier: 'skip'|'evaluate', reason }
      │   ├── Si skip : generateSkipReview() → ReviewFile synthétique CLEAN
      │   └── Si evaluate : ajouté à la file d'évaluation
      └── → Map<file, TriageResult>
      ↓
[Phase 3b — usage graph] usage-graph.ts  ← [NEW v0.4]
      ├── Scan local de tous les imports (regex, zéro API)
      ├── Résolution des chemins (.js→.ts, bare→/index.ts)
      └── → UsageGraph { usages, typeOnlyUsages }
      ↓
[Phase 3c — dependency meta] dependency-meta.ts  ← [NEW v0.4]
      ├── Lecture package.json (dependencies + devDependencies + engines)
      └── → DependencyMeta { dependencies, engines }
      ↓
[Phase 4 — rag index] orchestrator.ts (optionnel, si rag.enabled)
      ├── Pour chaque fichier avec fonctions/méthodes/hooks :
      │   ├── card-generator.ts → Haiku génère summaries + keyConcepts + behavioralProfile
      │   ├── indexer.ts → merge LLM output + AST data → FunctionCard[]
      │   ├── embeddings.ts → Xenova embed(buildEmbedText(card)) → vector 384D
      │   ├── vector-store.ts → upsert dans LanceDB
      │   └── cache.json → map functionId → fileHash (incrémental)
      └── → .anatoly/rag/lancedb/ (index vectoriel prêt)
      ↓
[Phase 5 — review] worker-pool.ts + file-evaluator.ts  ← [NEW v0.4]
      ├── Lecture progress.json (skip DONE/CACHED)
      ├── Vérification lock file
      ├── Worker pool (concurrency configurable, default: 4)
      ├── Pour chaque fichier PENDING (en parallèle) :
      │   ├── progress.json → IN_PROGRESS
      │   ├── file-evaluator.ts :
      │   │   ├── Lecture du fichier source (une seule fois)
      │   │   ├── Pré-résolution RAG (si activé) — vectorStore.searchById()
      │   │   ├── Extraction dépendances npm (extractFileDeps)
      │   │   ├── Exécution parallèle de 6 axes via Promise.allSettled() :
      │   │   │   ├── utility.ts     → AxisResult { USED/DEAD/LOW_VALUE }
      │   │   │   ├── duplication.ts  → AxisResult { UNIQUE/DUPLICATE }
      │   │   │   ├── correction.ts   → AxisResult { OK/NEEDS_FIX/ERROR + actions[] }
      │   │   │   ├── overengineering.ts → AxisResult { LEAN/OVER/ACCEPTABLE }
      │   │   │   ├── tests.ts        → AxisResult { GOOD/WEAK/NONE }
      │   │   │   └── best-practices.ts → AxisResult { score + rules + suggestions }
      │   │   ├── axis-merger.ts → fusion 6 résultats + cohérence inter-axes
      │   │   └── → ReviewFile v2 (with axis_meta)
      │   ├── review-writer.ts → .rev.json + .rev.md + transcript.log
      │   └── progress.json → DONE | ERROR | TIMEOUT
      └── Release lock file
      ↓
[Phase 6 — report] reporter.ts
      ├── Lecture de tous les .rev.json (evaluate + skip)
      ├── Aggregation : verdicts, dead code, duplications, actions (avec source)
      ├── Tri par sévérité
      └── → .anatoly/runs/<id>/report.md (résumé exécutif)
```

### Requirements to Structure Mapping

| Fonctionnalité PRD | Fichiers concernés |
|--------------------|--------------------|
| Parse AST + exports | `core/scanner.ts`, `schemas/task.ts` |
| Hash SHA-256 + cache | `utils/cache.ts`, `schemas/progress.ts` |
| Coverage Istanbul/Vitest/Jest | `core/scanner.ts` |
| Détection monorepo | `utils/config-loader.ts`, `core/scanner.ts` |
| Estimation scope (tokens) | `core/estimator.ts` |
| Triage fichiers (skip/evaluate) | `core/triage.ts` |
| Usage graph (détection dead code) | `core/usage-graph.ts` |
| Dependency metadata | `core/dependency-meta.ts` |
| Évaluation multi-axes (6 axes) | `core/axis-evaluator.ts`, `core/axes/*`, `core/file-evaluator.ts` |
| Fusion des résultats | `core/axis-merger.ts` |
| Validation Zod + retry | `core/axis-evaluator.ts` (`runSingleTurnQuery`), `schemas/review.ts` |
| Dual output JSON+MD | `core/review-writer.ts`, `core/reporter.ts` |
| Transcripts | `core/review-writer.ts` (`writeTranscript`) |
| Rapport agrégé | `core/reporter.ts` |
| Concurrence inter-fichiers | `core/worker-pool.ts` |
| Watch mode | `commands/watch.ts` |
| Lock file | `utils/lock.ts` |
| Config YAML + axes config | `utils/config-loader.ts`, `schemas/config.ts` (`AxesConfigSchema`) |
| Flags CLI | `commands/*.ts`, `utils/process.ts` |
| Exit codes (0/1/2) | `commands/run.ts` |
| Gestion SIGINT | `commands/run.ts`, `core/worker-pool.ts` |
| Détection sémantique duplications (RAG) | `rag/orchestrator.ts`, `rag/card-generator.ts`, `rag/embeddings.ts`, `rag/vector-store.ts`, `rag/indexer.ts` |
| RAG pré-résolu dans évaluateur | `core/file-evaluator.ts` (`preResolveRag`) |
| Extraction JSON réponses LLM | `utils/extract-json.ts` |
| Gitignore pattern matching | `utils/git.ts` |
| Inspection index RAG | `commands/rag-status.ts`, `rag/vector-store.ts` |
| Gestion des runs (scopés, purge) | `utils/run-id.ts`, `commands/clean-runs.ts`, `schemas/config.ts` (OutputConfigSchema) |
| Rate limiting API | `utils/rate-limiter.ts` |
| Best practices (17 règles) | `core/axes/best-practices.ts`, `schemas/review.ts` (`BestPracticesSchema`) |

### External Integration Points

| Intégration | Point d'entrée | Protocole |
|-------------|---------------|-----------|
| Claude Agent SDK (axes) | `core/axis-evaluator.ts` | `query()` single-turn (maxTurns: 1, no tools, persistSession) |
| Claude Agent SDK (RAG) | `rag/card-generator.ts` | `query()` single-turn pour FunctionCards (Haiku) |
| tiktoken | `core/estimator.ts` | Comptage local de tokens, zéro appel API |
| web-tree-sitter | `core/scanner.ts` | WASM — zéro compilation native |
| chokidar | `commands/watch.ts` | API événementielle filesystem |
| js-yaml | `utils/config-loader.ts` | Parsing YAML → objet JS |
| Istanbul/Vitest/Jest coverage | `core/scanner.ts` | Lecture JSON `coverage-final.json` |
| @xenova/transformers | `rag/embeddings.ts` | Embeddings locaux 384D (all-MiniLM-L6-v2) |
| @lancedb/lancedb | `rag/vector-store.ts` | Base vectorielle pour recherche de similarité |

### Development Workflow

**Dev :**
```bash
npx tsx src/index.ts scan          # Exécution directe TS
npx vitest                         # Tests en watch mode
npx eslint src/                    # Lint
```

**Build :**
```bash
npx tsup                           # Compile → dist/index.js
```

**Distribution :**
```bash
npm publish                         # Publie sur npm
npx anatoly run                     # Utilisateur final
```

## Architecture Validation Results

### Coherence Validation ✅

**Compatibilité des décisions :**
- Toutes les technologies sont compatibles entre elles
- `web-tree-sitter` (WASM) résout le conflit bindings C++ vs npx zéro friction
- Les patterns d'implémentation sont cohérents avec la stack
- La structure projet supporte toutes les décisions
- Aucune contradiction détectée

**Cohérence des patterns :**
- Naming conventions cohérentes (kebab-case fichiers, camelCase code, snake_case JSON)
- Hiérarchie de dépendance claire et sans cycles
- Error handling unifié via AnatolyError + codes standardisés

### Requirements Coverage ✅

**Functional Requirements : 15/15 couverts**

| FR du PRD | Couvert par | Statut |
|-----------|------------|--------|
| CLI avec sous-commandes | Commander.js + `commands/` | ✅ |
| Parse AST TS/TSX | `core/scanner.ts` + web-tree-sitter | ✅ |
| Hash SHA-256 + cache | `utils/cache.ts` + `schemas/progress.ts` | ✅ |
| Coverage Istanbul/Vitest/Jest | `core/scanner.ts` | ✅ |
| Évaluation multi-axes (6 axes parallèles) | `core/axis-evaluator.ts` + `core/axes/*` + `core/file-evaluator.ts` + `core/axis-merger.ts` | ✅ |
| Triage fichiers (skip/evaluate) | `core/triage.ts` | ✅ |
| Usage graph (dead code déterministe) | `core/usage-graph.ts` | ✅ |
| Concurrence inter-fichiers | `core/worker-pool.ts` | ✅ |
| Validation Zod + retry | `core/axis-evaluator.ts` (`runSingleTurnQuery`) + `schemas/review.ts` | ✅ |
| Dual output .rev.json + .rev.md | `core/review-writer.ts` | ✅ |
| Transcripts MD | `core/review-writer.ts` (`writeTranscript`) | ✅ |
| Watch mode | `commands/watch.ts` + chokidar | ✅ |
| Support monorepo | `utils/config-loader.ts` + `core/scanner.ts` | ✅ |
| Estimation scope (tokens) | `core/estimator.ts` + tiktoken (local) | ✅ |
| Rapport agrégé | `core/reporter.ts` | ✅ |
| Config .anatoly.yml + axes config | `utils/config-loader.ts` + `schemas/config.ts` (`AxesConfigSchema`) | ✅ |
| Flags CLI | Commander.js global options | ✅ |
| Détection sémantique duplications (RAG) | `rag/*` (card-generator, embeddings, vector-store, indexer, orchestrator) | ✅ |
| Best practices (17 règles) | `core/axes/best-practices.ts` + `schemas/review.ts` | ✅ |
| Inspection index RAG | `commands/rag-status.ts` | ✅ |

**Non-Functional Requirements : 11/11 couverts**

| NFR du PRD | Solution architecturale | Statut |
|-----------|------------------------|--------|
| Faux positifs DEAD < 3% | Agent avec grep obligatoire + confidence score | ✅ |
| Validation Zod 1ère passe > 97% | Few-shots dans le prompt + feedback retry | ✅ |
| 2e run inchangé < 4s et 0$ | SHA-256 cache → statut CACHED | ✅ |
| Timeout 180s/fichier | Timeout + statut TIMEOUT + fichier suivant | ✅ |
| Distribution npx | npm publish + bin field + web-tree-sitter WASM | ✅ |
| Lecture seule | Aucune opération d'écriture sur le code source | ✅ |
| Temps moyen premier rapport < 45 min | Pipeline séquentiel optimisé | ✅ |
| Transparence totale | Transcripts MD complets avec timestamps | ✅ |
| Zéro interruption | `npx anatoly run` de bout en bout sans confirmation | ✅ |
| Exit codes CI-friendly | 0 (clean), 1 (findings), 2 (erreur technique) | ✅ |
| Arrêt gracieux SIGINT | Résumé partiel + reviews intactes + cache reprise | ✅ |
| Historique des runs | Outputs scopés par run + auto-purge `max_runs` | ✅ |

### Implementation Readiness ✅

- Toutes les décisions critiques documentées avec rationale
- Structure fichier complète et spécifique
- Patterns de nommage, import, erreurs et logging définis
- Hiérarchie de dépendance sans ambiguïté
- Flux de données complet du scan au rapport
- Séquence d'implémentation ordonnée avec dépendances

### Gaps résiduels

| Gap | Priorité | Note |
|-----|----------|------|
| ActionSchema `source` field | **À implémenter** | Décision documentée ci-dessus, code à écrire (4 fichiers) |
| Format exact des prompts par axe | Mineur | Chaque axe contient son propre system prompt dans son fichier source |
| Gestion fichiers renommés/supprimés | Mineur | Le scan détecte et purge progress.json |

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Contexte projet analysé en profondeur
- [x] Complexité et échelle évaluées (moyen-haut)
- [x] Contraintes techniques identifiées
- [x] Préoccupations transversales mappées

**✅ Architectural Decisions**
- [x] Stack complète spécifiée avec rationale
- [x] Architecture multi-axes (6 axes parallèles) documentée avec interface, contexte, résultat
- [x] Fusion inter-axes avec règles de cohérence documentées
- [x] Orchestration per-file (file-evaluator) documentée
- [x] Triage système (skip/evaluate) documenté
- [x] Usage graph (pré-calcul imports) documenté
- [x] Dependency metadata documenté
- [x] Worker pool (concurrence inter-fichiers) documenté
- [x] Data architecture définie (YAML, progress.json, lock, SHA-256)
- [x] Error handling complet (retry Zod par axe, timeout, crash recovery, isolation erreurs)
- [x] AST parser décidé (web-tree-sitter WASM)
- [x] Estimation locale via tiktoken (pas d'appel LLM)
- [x] Flags CLI globaux définis
- [x] Exit codes standardisés (0/1/2)
- [x] Outputs scopés par run (`.anatoly/runs/<id>/`) + auto-purge `max_runs`
- [x] Gestion SIGINT documentée (arrêt gracieux)
- [x] Vocabulaire des verdicts formalisé (CLEAN, DEAD, DUP, OVER, ERR, NEEDS_REFACTOR, CRITICAL)
- [x] ActionSchema `source` field — traçabilité axe d'origine dans les rapports
- [x] ReviewFile v2 avec axis_meta et best_practices documenté
- [x] Configuration par axe (enabled, model) via AxesConfigSchema

**✅ Implementation Patterns**
- [x] Naming conventions établies (fichiers, code, JSON, output)
- [x] Convention nommage fichiers output (slashes → tirets, extension retirée, scopé par run)
- [x] Structure et organisation (co-located tests, barrels, hiérarchie)
- [x] Import/export (named only, pas de circulaire)
- [x] Error handling (AnatolyError + codes)
- [x] Rendu terminal (Listr2 + chalk + détection TTY)

**✅ Project Structure**
- [x] Arborescence complète définie
- [x] Frontières architecturales établies
- [x] Points d'intégration mappés
- [x] Mapping requirements → fichiers complet
- [x] Workflow dev/build/distribution documenté
- [x] Commande `rag-status` documentée et mappée
- [x] Gestion des runs (run-id, purge, clean-runs) documentée

### Architecture Readiness Assessment

**Statut : PRÊT POUR IMPLÉMENTATION**

**Niveau de confiance : ÉLEVÉ**

**Forces clés :**
- Architecture multi-axes modulaire — chaque axe indépendant, testable, extensible
- Découplage clair entre CLI, core, core/axes, schemas et utils
- Schémas Zod comme contrat unique entre tous les composants
- Résilience intégrée (cache, lock, retry, crash recovery, isolation des erreurs par axe)
- Parallélisme à deux niveaux (inter-fichiers + intra-fichier) pour performance optimale
- Triage intelligent (skip des fichiers triviaux → ~30% économie API)
- Usage graph pré-calculé (dead code déterministe, zéro faux positif)
- web-tree-sitter WASM garantit npx sans friction

### Sous-système Clean — Isolation de branche

**Contexte :**
La commande `clean-run` lance une boucle Ralph autonome qui modifie le code source, exécute des commits, et dispose d'un circuit breaker avec `git reset --hard`. Sans garantie au niveau TypeScript, tous ces effets de bord git peuvent s'exécuter sur `main`.

**Options considérées :**

| Option | Description | Avantages | Inconvénients |
|--------|-------------|-----------|---------------|
| A. Enforcement pré-boucle | `clean-run.ts` crée/checkout la branche avant la boucle + validation | Garantie hard, simple, ~15 lignes | Ne protège pas si l'agent fait un `git checkout` sauvage |
| B. Git worktree | Boucle dans un worktree isolé | Isolation totale, parallélisme possible | Complexité lifecycle, cleanup, paths relatifs cassés |
| C. Statu quo (prompt only) | Laisser l'instruction CLAUDE.md comme seul mécanisme | Zéro changement | Aucune garantie — risque sur `main` |

**Décision : Option A — Enforcement pré-boucle dans `clean-run.ts`**

**Rationale :**
- Garantie au niveau TypeScript, pas au niveau prompt LLM
- Surface de changement minimale (~15 lignes dans `clean-run.ts`)
- L'instruction CLAUDE.md reste en défense en profondeur
- Couvre le scénario critique : le circuit breaker `git reset --hard` ne touche jamais `main`

**Implémentation :**
1. Après génération des artefacts, lire `branchName` depuis `prd.json`
2. Si la branche n'existe pas : `git checkout -b <branch>` depuis `main`
3. Si elle existe : `git checkout <branch>`
4. Valider via `git branch --show-current` avant d'entrer dans la boucle
5. Si la validation échoue : exit avec erreur, ne jamais démarrer la boucle

**Garde-fou supplémentaire :**
- Avant chaque itération, vérifier que `HEAD` n'est pas sur `main`/`master`
- Si détecté : circuit breaker immédiat, aucun rollback (on ne touche pas à main)

**Composants impactés :**
- `src/commands/clean-run.ts` — ajout du checkout + validation pré-boucle + garde par itération
- `src/commands/clean.ts` — aucun changement (le `branchName` est déjà dans le PRD)

**Évolutions futures planifiées :**
- ~~v1.1 : Parallélisation configurable des reviews~~ → **implémenté en v0.4** (worker-pool + axes parallèles)
- ~~v1.1 : RAG léger pour la détection de duplications sémantiques~~ → **implémenté en v0.2.0** (module `rag/`)
- v1.0 : Export Ralph / Aider / Cursor / Windsurf
- v1.0 : Règles React hooks spécifiques (axe best-practices)
- v1.0 : ActionSchema `source` field (traçabilité axe d'origine)
- v2.0 : Multi-langage via grammaires web-tree-sitter additionnelles
- v2.0 : Rapport HTML interactif + historique
- v2.0 : Cache partagé pour mode équipe
- v2.0 : Axes custom (plugins utilisateur)

### RAG Embedding Backend — Tiered Architecture (lite / advanced-fp16 / advanced-gguf)

**Contexte :**
Le mode RAG Advanced repose sur un sidecar Python (`embed-server.py`) avec `sentence-transformers` en bf16. Deux modèles 7B+ (~14 GB chacun) imposent un swap séquentiel coûteux (~30s). Les tentatives de quantisation runtime (bitsandbytes INT8, FP8 via compressed-tensors) sont contre-productives sur Ampere (RTX 3090 Ti) : VRAM identique ou supérieure, inférence 2-4× plus lente, car le hardware ne supporte pas le compute FP8 natif (nécessite Hopper/Ada).

**Solution : architecture à 3 tiers déterminée empiriquement au setup.**

| Tier | Backend | Modèles | VRAM requise | Prérequis |
|------|---------|---------|-------------|-----------|
| **lite** | ONNX (CPU) | Jina v2 code (768d) + MiniLM NLP (384d) | Aucune | Rien (bundled) |
| **advanced-fp16** | Sidecar Python (GPU) | nomic-embed-code bf16 (3584d) + Qwen3-Embedding-8B bf16 (4096d) | ≥ 24 GB (swap séquentiel) | venv, sentence-transformers, torch CUDA |
| **advanced-gguf** | Docker llama.cpp (GPU) | nomic-embed-code Q5_K_M (3584d) + Qwen3-Embedding-8B Q5_K_M (4096d) | ≥ 12 GB (dual simultané) | Docker, NVIDIA Container Toolkit |

**Modèles GGUF (officiels, publiés par les auteurs) :**
- `nomic-ai/nomic-embed-code-GGUF` → `nomic-embed-code.Q5_K_M.gguf` (5.1 GB)
- `Qwen/Qwen3-Embedding-8B-GGUF` → `Qwen3-Embedding-8B-Q5_K_M.gguf` (5.4 GB)
- Total dual simultané : ~10.5 GB VRAM

**Seuil GPU minimum : 12 GB VRAM** — en dessous, les deux modèles GGUF ne tiennent pas en mémoire simultanément. Pas d'accélération GPU possible, fallback automatique sur lite.

**Sélection automatique au setup :**

```
npx anatoly setup-embeddings
  │
  ├─ GPU + VRAM ≥ 24 GB → A/B test fp16 vs gguf → garde le meilleur
  ├─ GPU + VRAM 12-23 GB → advanced-gguf (seule option GPU viable)
  ├─ GPU + VRAM < 12 GB  → lite (VRAM insuffisante pour dual-model)
  ├─ Pas de GPU           → lite
  └─ Tout échoue          → lite (filet de sécurité)
```

**A/B test :**
- Compare les backends applicables sur le hardware réel de l'utilisateur
- Mesure : cosine similarity bf16↔gguf, VRAM, latence par sample, ranking preservation
- Seuils : mean sim > 0.99, min sim > 0.97, ranking 100% preservé
- Résultat sauvé dans `.anatoly/embeddings-ready.json` → le runtime lit `backend` et exécute

**`embeddings-ready.json` :**
```json
{
  "backend": "lite | advanced-fp16 | advanced-gguf",
  "code_model": "nomic-ai/nomic-embed-code",
  "nlp_model": "Qwen/Qwen3-Embedding-8B",
  "dim_code": 3584,
  "dim_nlp": 4096,
  "device": "cuda | cpu",
  "code_gguf_path": ".anatoly/models/nomic-embed-code.Q5_K_M.gguf",
  "nlp_gguf_path": ".anatoly/models/Qwen3-Embedding-8B-Q5_K_M.gguf",
  "ab_tested_at": "2026-03-19T...",
  "ab_quality": { "mean_sim": 0.9994, "ranking": "3/3" }
}
```

**Runtime (`embed-sidecar.ts`) :**

| Backend | Démarrage | Embedding | Arrêt |
|---------|-----------|-----------|-------|
| lite | Import ONNX runtime (in-process) | `model.embed()` | GC |
| advanced-fp16 | Spawn `embed-server.py` → `POST /embed` | `fetch("http://127.0.0.1:11435/embed")` | `POST /shutdown` |
| advanced-gguf | `docker run ghcr.io/ggml-org/llama.cpp:server-cuda` | `fetch("http://127.0.0.1:11435/embedding")` | `docker stop` |

**Avantage clé du tier advanced-gguf :**
- Deux modèles chargés simultanément (~10.5 GB) → **zéro swap**, embedding code et NLP disponibles en permanence
- Container pré-compilé CUDA → zéro compilation, zéro `LD_LIBRARY_PATH`, zéro venv Python pour l'embedding
- Modèles officiels Q5_K_M → perte de qualité <1% vs bf16 (vérifié par A/B test)

**Composants impactés :**
- `scripts/setup-embeddings.sh` — détection VRAM, download GGUF, pull Docker image, A/B test routing
- `scripts/embedding-ab-test.py` — ajout backend GGUF (via Docker ou llama-cpp-python)
- `src/rag/embed-sidecar.ts` — routing backend selon `embeddings-ready.json`
- `src/rag/embeddings.ts` — abstraction : `getEmbedder(backend)` retourne le bon client
- `scripts/embed-server.py` — conservé (backend advanced-fp16)

### Multi-Language Support — Extension Scanner & Pipeline (v0.6.0)

**Problème observé :** Anatoly est architecturé comme un analyseur TypeScript-only. Les fichiers d'infrastructure (scripts shell, configs YAML, scripts Python) sont invisibles au pipeline — jamais découverts, jamais parsés, jamais évalués. Pour un projet comme Anatoly qui possède 5 scripts shell critiques (`scripts/setup-embeddings.sh`, `scripts/lib/docker-helpers.sh`, etc.) représentant de la logique métier d'orchestration, c'est un angle mort.

**Objectif :** Étendre le pipeline pour capturer et analyser tout fichier participant à l'écosystème opérationnel d'un projet, en appliquant les 7 mêmes axes d'évaluation.

---

#### Tiers de Langages Supportés

| Tier | Langages | Grammar tree-sitter | Priorité |
|------|----------|---------------------|----------|
| **Tier 0** | TypeScript, TSX | `tree-sitter-typescript` (existant) | Déjà implémenté |
| **Tier 1 — Langages de base** | Bash/Shell, Python, Rust, Go, Java, C#, SQL, YAML, JSON | `tree-sitter-bash`, `tree-sitter-python`, `tree-sitter-rust`, `tree-sitter-go`, `tree-sitter-java`, `tree-sitter-c-sharp`, `tree-sitter-sql`, `tree-sitter-yaml`, `tree-sitter-json` | P0 — v0.6.0 |
| **Tier 2** | Dockerfile, Makefile, TOML, CSS/SCSS, HTML | `tree-sitter-dockerfile`, `tree-sitter-make`, `tree-sitter-toml`, `tree-sitter-css`, `tree-sitter-html` | P1 — post-v0.6.0 |
| **Heuristique** | Tout fichier texte sans grammaire | Regex + line-count fallback | P0 — v0.6.0 |

---

#### Auto-Detect — Découverte Automatique des Fichiers

**Problème actuel :** `scan.include` par défaut ne contient que `['src/**/*.ts', 'src/**/*.tsx']`. Les fichiers d'infrastructure ne sont jamais découverts.

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Mécanisme | `scan.auto_detect: true` (default) | Détection automatique sans configuration manuelle |
| Comportement | Scanne le projet pour des patterns connus et ajoute les globs correspondants aux `scan.include` du runtime | Zéro config pour le cas commun, override possible |
| Override | `scan.auto_detect: false` + `scan.include` explicite | L'utilisateur reprend le contrôle total |
| Fusion | Les globs auto-détectés s'ajoutent aux `scan.include` configurés (union) | Ne casse pas les configs existantes |

**Patterns auto-détectés :**

| Pattern détecté | Glob ajouté | Condition d'activation |
|----------------|-------------|----------------------|
| Scripts shell | `scripts/**/*.sh`, `**/*.bash` | Existence d'au moins un `.sh` ou `.bash` |
| Python | `**/*.py` (hors venv) | Existence d'au moins un `.py` hors `venv/`, `.venv/` |
| Rust | `**/*.rs` | Existence d'au moins un `.rs` |
| Go | `**/*.go` | Existence d'au moins un `.go` |
| Java | `**/*.java` | Existence d'au moins un `.java` |
| C# | `**/*.cs` | Existence d'au moins un `.cs` |
| SQL | `**/*.sql` | Existence d'au moins un `.sql` |
| YAML | `**/*.yml`, `**/*.yaml` | Existence d'au moins un `.yml` ou `.yaml` |
| JSON | `**/*.json` (hors package-lock, node_modules) | Existence d'au moins un `.json` |
| GitHub Actions | `.github/workflows/**/*.yml` | Existence du dossier `.github/workflows/` |
| Docker Compose | `docker-compose*.yml`, `compose*.yml` | Existence du fichier |
| Dockerfile | `Dockerfile`, `*.dockerfile`, `docker/**` | Existence du fichier |
| Makefile | `Makefile`, `makefile`, `*.mk` | Existence du fichier |
| TOML configs | `pyproject.toml`, `Cargo.toml` | Existence du fichier |

**Excludes additionnels auto-ajoutés :**

```
venv/**
.venv/**
__pycache__/**
*.pyc
target/**          # Rust build
bin/**             # Go/Java/C# build
obj/**             # C# build
*.class            # Java compiled
package-lock.json
```

---

#### Language Detection — Répartition par Extension

**Approche :** Un glob général `**/*` (filtré par `.gitignore` et `scan.exclude`) récupère tous les fichiers du projet. On compte les extensions, on calcule le ratio, et on en déduit les langages par répartition. Simple, exhaustif, zéro heuristique.

**Implémentation :** Nouveau module `src/core/language-detect.ts`

```ts
interface LanguageDistribution {
  /** Langages détectés avec leur pourcentage, triés par ratio décroissant */
  languages: Array<{ name: string; percentage: number; fileCount: number }>;
  /** Total de fichiers analysés */
  totalFiles: number;
}

/** Mapping extension → nom de langage */
const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.sh': 'Shell', '.bash': 'Shell',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.cs': 'C#',
  '.sql': 'SQL',
  '.yml': 'YAML', '.yaml': 'YAML',
  '.json': 'JSON',
  '.toml': 'TOML',
  '.md': 'Markdown',
};

/** Fichiers sans extension détectés par nom */
const FILENAME_MAP: Record<string, string> = {
  'Dockerfile': 'Dockerfile',
  'Makefile': 'Makefile',
  'makefile': 'Makefile',
};

export async function detectLanguages(projectRoot: string, excludes: string[]): Promise<LanguageDistribution>;
```

**Algorithme :**

```
1. Glob **/* (filtré par .gitignore + excludes standards)
2. Pour chaque fichier : extraire l'extension → lookup EXTENSION_MAP, ou nom → FILENAME_MAP
3. Compter les occurrences par langage
4. Calculer les pourcentages (arrondi à l'entier)
5. Trier par pourcentage décroissant
6. Filtrer les langages < 1% (bruit)
```

**Affichage dans le Setup Table :**

Les langages détectés sont affichés dans la section **Project Info** (propriété du projet, pas de la config) :

```
  ┌ Project Info ──────────────────────────────────────────┐
  │                                                        │
  │   name              anatoly                            │
  │   version           0.6.0                              │
  │   languages         TypeScript 85% · Shell 10% · Python 3% · YAML 2% │
  │                                                        │
  ├ Configuration ─────────────────────────────────────────┤
  │                                                        │
  │   concurrency       4 files · 8 SDK slots              │
  │   rag               lite — code: jina-v2 / nlp: MiniLM │
  │   cache             on                                 │
  │   run               run-2026-03-21-143022              │
  │                                                        │
```

- `languages` — répartition des langages par pourcentage de fichiers, triés par ratio décroissant, séparés par ` · `. Seuls les langages ≥ 1% apparaissent.
- La répartition détermine aussi **quelles grammaires tree-sitter charger** : si un langage Tier 1 apparaît dans la distribution et qu'un `LanguageAdapter` existe, la grammaire est chargée. Sinon, fallback heuristique.
- Si `scan.auto_detect: false`, la détection de langages se fait uniquement sur les fichiers matchés par `scan.include` (pas de glob général).

**Impact sur `run.ts` :**

```ts
// Exécuter la détection avant le render du setup table
const langDist = await detectLanguages(ctx.projectRoot, ctx.config.scan.exclude);

projectInfo = {
  name: pkg.name,
  version: pkg.version,
  languages: langDist.languages,
};

// Rendu : "TypeScript 85% · Shell 10% · Python 3% · YAML 2%"
const langLabel = langDist.languages
  .map(l => `${l.name} ${l.percentage}%`)
  .join(' · ');
```

**Séquence dans le pipeline :** config → language-detect → framework-detect → auto-detect → render setup table → scan → triage → ...

---

#### Framework Detection — Détection de Frameworks par Analyse du Projet

**Problème :** Le langage seul ne suffit pas pour les prompts best_practices et documentation. Un fichier `.tsx` React et un fichier `.tsx` vanilla TypeScript n'ont pas les mêmes bonnes pratiques. Next.js impose des conventions (server/client components, App Router) que React pur n'a pas.

**Approche :** Après la détection des langages (passe 1 — extensions), une passe 2 analyse les marqueurs du projet pour détecter les frameworks.

**Implémentation :** Intégré dans `src/core/language-detect.ts`

```ts
interface FrameworkInfo {
  id: string;         // 'react' | 'nextjs' | 'nestjs' | 'express' | 'django' | 'flask' | 'spring' | 'dotnet' | 'rails' | ...
  name: string;       // 'React' | 'Next.js' | ...
  language: string;   // langage parent ('typescript', 'python', ...)
}

interface ProjectProfile {
  languages: LanguageDistribution;
  frameworks: FrameworkInfo[];
}

export async function detectProjectProfile(projectRoot: string, excludes: string[]): Promise<ProjectProfile>;
```

**Marqueurs de détection :**

| Framework | Marqueur | Langage parent |
|-----------|---------|----------------|
| **React** | `react` dans dependencies (package.json) | TypeScript/JavaScript |
| **Next.js** | `next` dans dependencies OU existence de `next.config.*` | TypeScript/JavaScript |
| **NestJS** | `@nestjs/core` dans dependencies | TypeScript |
| **Express** | `express` dans dependencies | TypeScript/JavaScript |
| **Fastify** | `fastify` dans dependencies | TypeScript/JavaScript |
| **Vue** | `vue` dans dependencies | TypeScript/JavaScript |
| **Angular** | `@angular/core` dans dependencies | TypeScript |
| **Svelte** | `svelte` dans dependencies | TypeScript/JavaScript |
| **Django** | `django` dans `requirements.txt`/`pyproject.toml` OU existence de `manage.py` | Python |
| **Flask** | `flask` dans `requirements.txt`/`pyproject.toml` | Python |
| **FastAPI** | `fastapi` dans `requirements.txt`/`pyproject.toml` | Python |
| **Spring** | `org.springframework` dans `pom.xml`/`build.gradle` | Java |
| **ASP.NET** | `Microsoft.AspNetCore` dans `*.csproj` | C# |
| **Rails** | `rails` dans `Gemfile` | Ruby (Tier 2) |
| **Actix/Axum** | `actix-web`/`axum` dans `Cargo.toml` | Rust |
| **Gin/Echo** | `gin-gonic/gin`/`labstack/echo` dans `go.mod` | Go |

**Algorithme :**

```
1. Lire package.json → extraire dependencies + devDependencies
2. Lire requirements.txt / pyproject.toml si Python détecté
3. Lire Cargo.toml si Rust détecté
4. Lire go.mod si Go détecté
5. Lire *.csproj si C# détecté
6. Lire pom.xml / build.gradle si Java détecté
7. Matcher les marqueurs → FrameworkInfo[]
8. Plusieurs frameworks possibles simultanément (ex: Next.js + Prisma)
```

**Affichage dans le Setup Table :**

```
  ┌ Project Info ──────────────────────────────────────────┐
  │                                                        │
  │   name              my-saas-app                        │
  │   version           1.2.0                              │
  │   languages         TypeScript 78% · Python 12% · SQL 6% · YAML 4% │
  │   frameworks        Next.js · Prisma · FastAPI         │
  │                                                        │
```

La ligne `frameworks` n'apparaît que si au moins un framework est détecté.

**Impact sur la résolution des prompts :**

La résolution de prompt devient une cascade à 3 niveaux :

```ts
function resolveSystemPrompt(axisId: string, language: string, framework?: string): string {
  // 1. Chercher le prompt framework-spécifique : best-practices.nextjs.system.md
  // 2. Si absent → chercher le prompt langage-spécifique : best-practices.typescript.system.md
  // 3. Si absent → fallback sur le default : best-practices.system.md
}
```

**Convention de nommage :**

```
{axis-id}.system.md                    ← default (TypeScript)
{axis-id}.{language}.system.md         ← override par langage
{axis-id}.{framework}.system.md        ← override par framework (priorité max)
```

**Prompts framework-spécifiques à créer (v0.6.0) :**

| Prompt | Contenu clé |
|--------|------------|
| `best-practices.react.system.md` | Hooks rules (exhaustive deps, no conditional hooks), component patterns, memo/useMemo/useCallback, key prop, accessibility (a11y), prop-types/TypeScript props |
| `best-practices.nextjs.system.md` | Server vs Client components (`'use client'`), App Router conventions, `generateMetadata`, data fetching (server components, Route Handlers), ISR/SSG/SSR, `next/image`, `next/link` |
| `documentation.react.system.md` | Props documentation (TypeScript interface = doc), Storybook stories as doc, component usage examples |
| `documentation.nextjs.system.md` | Route documentation, API Route documentation, middleware doc |

**Extension du TaskSchema :**

```ts
export const TaskSchema = z.object({
  // ... existing fields ...
  language: z.string().optional(),
  parse_method: z.enum(['ast', 'heuristic']).optional(),
  framework: z.string().optional(),  // NEW — 'react' | 'nextjs' | 'nestjs' | ...
});
```

Le `framework` est assigné par fichier dans le scanner en se basant sur le profil projet + le contexte du fichier (ex: un `.tsx` dans un projet Next.js → `framework: 'nextjs'`, un `.py` dans un projet Django → `framework: 'django'`).

---

#### Extension AST — Grammaires Multi-Langage

**Architecture actuelle :** `parseFile()` dans `scanner.ts` charge une grammaire TS ou TSX basée sur l'extension du fichier. La fonction `extractSymbols()` parcourt les `namedChildren` du `rootNode` en cherchant des nœuds TypeScript spécifiques.

**Décision :** Introduire une abstraction `LanguageAdapter` qui encapsule la sélection de grammaire et le mapping de nœuds AST vers `SymbolInfo[]`.

```ts
interface LanguageAdapter {
  /** Extensions de fichier supportées (ex: ['.ts', '.tsx']) */
  readonly extensions: readonly string[];
  /** Identifiant de langage pour logging et config */
  readonly languageId: string;
  /** Chemin du module WASM tree-sitter */
  readonly wasmModule: string;
  /** Extraire les symboles depuis le rootNode AST */
  extractSymbols(rootNode: TSNode): SymbolInfo[];
  /** Extraire les imports/sources pour le usage-graph */
  extractImports(source: string): ImportRef[];
}
```

**Nouveau fichier :** `src/core/language-adapters.ts`

**Adapters Tier 0 (existant, refactoré) :**

| Adapter | Extensions | Symboles | Imports |
|---------|-----------|----------|---------|
| `TypeScriptAdapter` | `.ts` | `function_declaration`, `class_declaration`, `type_alias_declaration`, `enum_declaration`, `lexical_declaration` | Regex existant dans `usage-graph.ts` |
| `TsxAdapter` | `.tsx` | Idem TypeScript | Idem |

**Adapters Tier 1 (nouveaux) :**

| Adapter | Extensions | Nœuds AST principaux → SymbolKind | Imports |
|---------|-----------|----------------------------------|---------|
| `BashAdapter` | `.sh`, `.bash` | `function_definition` → `function`, `variable_assignment` (UPPER_SNAKE) → `constant` | `source`/`.` → ImportRef |
| `PythonAdapter` | `.py` | `function_definition` → `function`, `class_definition` → `class`, `assignment` (UPPER_SNAKE) → `constant`, `decorated_definition` → selon décorateur | `import`/`from...import` → ImportRef |
| `RustAdapter` | `.rs` | `function_item` → `function`, `struct_item` → `class`, `enum_item` → `enum`, `type_item` → `type`, `impl_item` → `class`, `const_item` → `constant`, `static_item` → `constant`, `trait_item` → `type` | `use` → ImportRef |
| `GoAdapter` | `.go` | `function_declaration` → `function`, `method_declaration` → `method`, `type_declaration` (struct) → `class`, `type_declaration` (interface) → `type`, `const_declaration` → `constant`, `var_declaration` → `variable` | `import` → ImportRef |
| `JavaAdapter` | `.java` | `class_declaration` → `class`, `interface_declaration` → `type`, `method_declaration` → `method`, `enum_declaration` → `enum`, `field_declaration` (static final UPPER) → `constant` | `import` → ImportRef |
| `CSharpAdapter` | `.cs` | `class_declaration` → `class`, `interface_declaration` → `type`, `method_declaration` → `method`, `enum_declaration` → `enum`, `field_declaration` (const/static readonly UPPER) → `constant` | `using` → ImportRef |
| `SqlAdapter` | `.sql` | `create_table` → `class`, `create_function`/`create_procedure` → `function`, `create_view` → `variable`, `create_index` → `variable` | N/A (fichiers auto-contenus) |
| `YamlAdapter` | `.yml`, `.yaml` | `block_mapping_pair` (clés top-level) → `variable`, services Docker Compose → `constant` | N/A |
| `JsonAdapter` | `.json` | Clés top-level → `variable` (analyse structurelle légère) | N/A |

**Mapping détaillé — exemples par langage :**

| Langage | Nœud AST | SymbolKind | Exemple |
|---------|----------|------------|---------|
| Bash | `function_definition` | `function` | `function setup_gpu() { ... }` |
| Bash | `variable_assignment` (UPPER_SNAKE) | `constant` | `DOCKER_IMAGE="ghcr.io/..."` |
| Python | `function_definition` (top-level) | `function` | `def process_data():` |
| Python | `class_definition` | `class` | `class DataPipeline:` |
| Rust | `function_item` (`pub`) | `function` | `pub fn parse(input: &str) -> Result<...>` |
| Rust | `struct_item` | `class` | `pub struct Config { ... }` |
| Rust | `trait_item` | `type` | `pub trait Parser { ... }` |
| Go | `function_declaration` (majuscule) | `function` | `func ParseFile(path string) error` |
| Go | `type_declaration` (struct) | `class` | `type Scanner struct { ... }` |
| Java | `class_declaration` | `class` | `public class UserService { ... }` |
| Java | `method_declaration` | `method` | `public void processOrder(...)` |
| C# | `class_declaration` | `class` | `public class OrderProcessor { ... }` |
| C# | `method_declaration` | `method` | `public async Task<Result> Execute(...)` |
| SQL | `create_table` | `class` | `CREATE TABLE users (...)` |
| SQL | `create_function` | `function` | `CREATE FUNCTION get_user(...)` |

**Export semantics :** Pour les langages non-TS, la notion d'`exported` est mappée ainsi :

| Langage | `exported = true` | `exported = false` |
|---------|-------------------|---------------------|
| Bash | Fonctions non préfixées `_` | Fonctions préfixées `_` (convention privé) |
| Python | Symboles non préfixés `_` | Symboles préfixés `_` (`__all__` override si présent) |
| Rust | `pub` / `pub(crate)` | Pas de visibilité explicite |
| Go | Nom commence par majuscule | Nom commence par minuscule |
| Java | `public` / `protected` | `private` / package-private |
| C# | `public` / `protected` / `internal` | `private` |
| SQL | Toujours `true` | N/A |
| YAML | Toujours `true` | N/A |
| JSON | Toujours `true` | N/A |

---

#### Fallback Heuristique — Fichiers Sans Grammaire

Pour les fichiers découverts par auto-detect mais sans `LanguageAdapter` disponible (ex: Makefile avant Tier 2, fichiers de config custom), un fallback heuristique génère des `SymbolInfo[]` approximatifs.

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Activation | Automatique quand aucun adapter ne match l'extension | Aucun fichier découvert ne reste sans analyse |
| Extraction | Regex-based : fonctions, assignments, sections | Couvre les patterns les plus communs sans grammaire |
| Qualité | Metadata `task.parse_method: 'heuristic'` (vs `'ast'`) | Permet aux axes de pondérer la confiance |
| Seuil de pertinence | Skip si < 5 lignes non-vides et non-commentaire | Évite le bruit sur les fichiers triviaux |

**Regex heuristiques universels :**

```ts
const HEURISTIC_PATTERNS = {
  // Bash/Shell functions (fallback si grammaire non chargée)
  shellFunction: /^(?:function\s+)?(\w+)\s*\(\)\s*\{/gm,
  // Makefile targets
  makeTarget: /^([a-zA-Z_][\w-]*)\s*:/gm,
  // Dockerfile stages
  dockerStage: /^FROM\s+\S+\s+AS\s+(\w+)/gim,
  // Generic assignments (UPPER_SNAKE = ...)
  constantAssignment: /^([A-Z_][A-Z0-9_]*)\s*[:=]/gm,
};
```

**Nouveau fichier :** `src/core/heuristic-parser.ts`

```ts
interface HeuristicResult {
  symbols: SymbolInfo[];
  parseMethod: 'heuristic';
}

export function heuristicParse(filePath: string, source: string): HeuristicResult;
```

---

#### Extension du TaskSchema

Le `TaskSchema` actuel n'a pas de champ pour identifier le langage ou la méthode de parsing. Ajouts nécessaires :

```ts
export const TaskSchema = z.object({
  version: z.literal(1),
  file: z.string(),
  hash: z.string(),
  symbols: z.array(SymbolInfoSchema),
  coverage: CoverageDataSchema.optional(),
  scanned_at: z.string(),
  // --- NEW v0.6.0 ---
  language: z.string().optional(),          // 'typescript' | 'bash' | 'python' | 'rust' | 'go' | 'java' | 'csharp' | 'sql' | 'yaml' | 'json' | 'unknown'
  parse_method: z.enum(['ast', 'heuristic']).optional(),  // default 'ast' pour backward compat
});
```

**Backward compatibility :** Les deux champs sont `.optional()`. Les tasks existantes (sans ces champs) sont implicitement `language: 'typescript'`, `parse_method: 'ast'`.

---

#### Extension du SymbolKind

Pas de changement — les `SymbolKind` existants (`function`, `class`, `method`, `type`, `constant`, `variable`, `enum`, `hook`) couvrent les besoins de tous les langages Tier 1. Les mappings sont dans chaque `LanguageAdapter`.

---

#### Extension du Usage-Graph

Le usage-graph actuel utilise des regex TypeScript-only pour extraire les imports. Avec les `LanguageAdapter`, chaque adapter fournit sa propre méthode `extractImports()`.

| Langage | Pattern d'import | Résolution |
|---------|-----------------|------------|
| TypeScript | `import { X } from './path'` | Existant (inchangé) |
| Bash | `source ./lib/helpers.sh` ou `. ./lib/helpers.sh` | Résolution relative depuis le fichier source |
| Python | `from module import X` ou `import module` | Résolution relative (`from .utils import X`) ou absolue |
| YAML | N/A | Pas de mécanisme d'import — fichiers isolés |

**Impact sur `usage-graph.ts` :**

```ts
// Nouvelle signature
export function buildUsageGraph(
  tasks: Task[],
  projectRoot: string,
  adapters: Map<string, LanguageAdapter>,  // extension → adapter
): UsageGraph;
```

Le graphe reste unifié — un script Bash qui `source` un autre script Bash apparaît dans le même graphe qu'un fichier TS qui importe un module. Les symboles cross-langage ne sont pas liés (un `source` bash n'importe pas des symboles TS).

---

#### Architecture des Prompts Multi-Langage

**Problème :** Les system prompts actuels sont hardcodés TypeScript — 17 règles TypeGuard, JSDoc/TSDoc, React/API context detection, etc. Un fichier Bash évalué avec le prompt `best-practices.system.md` actuel recevrait des violations absurdes ("No `any`", "Missing JSDoc").

**Décision :** Prompts par langage avec convention de nommage et résolution automatique avec fallback.

**Convention de nommage :**

```
src/core/axes/prompts/
├── {axis-id}.system.md                ← default (TypeScript)
├── {axis-id}.{language}.system.md     ← override par langage (optionnel)
```

**Résolution dynamique :**

```ts
function resolveSystemPrompt(axisId: string, language: string): string {
  // 1. Chercher le prompt spécifique : best-practices.bash.system.md
  // 2. Si absent → fallback sur le default : best-practices.system.md
  //    + injection du hint "Language: {language}" dans le user message
  // Le fallback est fonctionnel (le LLM sait évaluer du Python même
  // avec un prompt TS) mais dégradé (règles non adaptées).
}
```

**Avantage :** Pour ajouter un nouveau langage (ex: Rust), il suffit de déposer `best-practices.rust.system.md` et `documentation.rust.system.md` dans `prompts/`. Pas de code à modifier. Si le fichier n'existe pas, le prompt default + language hint fonctionne en mode dégradé.

**Catégorisation des axes :**

| Catégorie | Axes | Stratégie prompt |
|-----------|------|-----------------|
| **Langage-spécifique** | `best_practices`, `documentation` | Prompt `.md` dédié par langage — les règles, critères et conventions varient fondamentalement |
| **Langage-agnostique** | `utility`, `duplication`, `correction`, `overengineering`, `tests` | Prompt unique + hint `Language: {lang}` dans le user message — le LLM évalue correctement sans prompt spécifique |

**Prompts spécifiques à créer (v0.6.0 — Tier 1) :**

```
src/core/axes/prompts/
├── best-practices.system.md           ← existant (TypeScript — 17 TypeGuard rules)
├── best-practices.bash.system.md      ← nouveau
├── best-practices.python.system.md    ← nouveau
├── best-practices.yaml.system.md      ← nouveau
├── documentation.system.md            ← existant (TypeScript — JSDoc/TSDoc)
├── documentation.bash.system.md       ← nouveau
├── documentation.python.system.md     ← nouveau
├── documentation.yaml.system.md       ← nouveau
├── correction.system.md               ← inchangé (+ language hint)
├── duplication.system.md              ← inchangé
├── overengineering.system.md          ← inchangé (+ language hint)
├── tests.system.md                    ← inchangé (+ language hint)
├── utility.system.md                  ← inchangé
```

---

##### Prompt best_practices par langage

Chaque prompt langage-spécifique définit son propre jeu de règles, adapté aux conventions et outils du langage.

**Bash (`best-practices.bash.system.md`) — Règles ShellGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | `set -euo pipefail` (ou équivalent strict mode) | CRITICAL | -3 pts |
| 2 | Variables entre guillemets (`"$var"`, pas `$var`) | CRITICAL | -3 pts |
| 3 | Pas de `eval` ni `source` dynamique | HIGH | -1 pt |
| 4 | Pas de `cd` sans vérification (`cd dir \|\| exit 1`) | HIGH | -1 pt |
| 5 | Fonctions documentées (commentaire header) | MEDIUM | -0.5 pt |
| 6 | Pas de variables globales mutables (préférer `local`) | MEDIUM | -0.5 pt |
| 7 | Utilisation de `[[ ]]` au lieu de `[ ]` | MEDIUM | -0.5 pt |
| 8 | Gestion des signaux (trap pour cleanup) | MEDIUM | -0.5 pt |
| 9 | Pas de parsing de `ls` (utiliser globs) | MEDIUM | -0.5 pt |
| 10 | Pas de chemins hardcodés (utiliser des variables/paramètres) | HIGH | -1 pt |
| 11 | Security (pas de secrets hardcodés, pas d'injection de commande) | CRITICAL | -4 pts |
| 12 | Taille de fichier (< 300 lignes) | HIGH | -1 pt |

**Python (`best-practices.python.system.md`) — Règles PyGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Type hints sur fonctions publiques (paramètres + retour) | HIGH | -1 pt |
| 2 | Docstrings Google/NumPy sur fonctions publiques | MEDIUM | -0.5 pt |
| 3 | Pas de `import *` | HIGH | -1 pt |
| 4 | Pas de `bare except` (except sans type) | CRITICAL | -3 pts |
| 5 | f-strings vs `.format()` / `%` (préférer f-strings) | MEDIUM | -0.5 pt |
| 6 | Pas de variables globales mutables | MEDIUM | -0.5 pt |
| 7 | Context managers pour les ressources (`with open(...)`) | HIGH | -1 pt |
| 8 | Pas de `eval()` / `exec()` | CRITICAL | -4 pts |
| 9 | Taille de fichier (< 300 lignes) | HIGH | -1 pt |
| 10 | Import organization (stdlib, third-party, local — groupés) | MEDIUM | -0.5 pt |
| 11 | Security (pas de secrets hardcodés, pas d'injection) | CRITICAL | -4 pts |
| 12 | Pas d'assertions en code de production (sauf tests) | MEDIUM | -0.5 pt |
| 13 | Pathlib au lieu de string concatenation pour les chemins | MEDIUM | -0.5 pt |

**YAML (`best-practices.yaml.system.md`) — Règles YamlGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Strings entre guillemets quand ambiguës (`"yes"`, `"true"`, `"on"`) | HIGH | -1 pt |
| 2 | Pas de `yes`/`no`/`on`/`off` non quotés comme valeurs | CRITICAL | -3 pts |
| 3 | Indentation cohérente (2 espaces standard) | MEDIUM | -0.5 pt |
| 4 | Ancres `&` et aliases `*` pour DRY (quand applicable) | MEDIUM | -0.5 pt |
| 5 | Pas de clés dupliquées | CRITICAL | -3 pts |
| 6 | Structure plate quand possible (< 5 niveaux d'imbrication) | HIGH | -1 pt |
| 7 | Commentaires sur les sections non évidentes | MEDIUM | -0.5 pt |
| 8 | Security (pas de secrets en clair, pas de tokens) | CRITICAL | -4 pts |

**Rust (`best-practices.rust.system.md`) — Règles RustGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Ownership & borrowing correct (pas de `clone()` inutile) | HIGH | -1 pt |
| 2 | Error handling (`Result`/`Option`, pas de `.unwrap()` en production) | CRITICAL | -3 pts |
| 3 | Lifetimes explicites quand nécessaire | MEDIUM | -0.5 pt |
| 4 | Pas de `unsafe` sans justification | CRITICAL | -4 pts |
| 5 | Documentation (`///` doc comments sur pub items) | MEDIUM | -0.5 pt |
| 6 | Clippy compliance (pas de warnings évidents) | HIGH | -1 pt |
| 7 | Taille de fichier (< 500 lignes) | HIGH | -1 pt |
| 8 | Traits idiomatiques (`Display`, `From`, `Default`) | MEDIUM | -0.5 pt |
| 9 | Security (pas de secrets, pas de commandes injectées) | CRITICAL | -4 pts |
| 10 | Concurrence safe (`Send`/`Sync`, pas de data races) | HIGH | -1 pt |

**Go (`best-practices.go.system.md`) — Règles GoGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Error handling (pas de `_` pour ignorer les erreurs) | CRITICAL | -3 pts |
| 2 | Naming conventions (camelCase, majuscule = exported) | HIGH | -1 pt |
| 3 | Godoc sur les fonctions/types exportés | MEDIUM | -0.5 pt |
| 4 | Pas de `panic()` en code de production | CRITICAL | -3 pts |
| 5 | Context propagation (`context.Context` en premier param) | HIGH | -1 pt |
| 6 | Pas de goroutines sans lifecycle management | HIGH | -1 pt |
| 7 | Interfaces petites (1-3 méthodes) | MEDIUM | -0.5 pt |
| 8 | `defer` pour cleanup des ressources | MEDIUM | -0.5 pt |
| 9 | Security (pas de secrets, pas d'injection) | CRITICAL | -4 pts |
| 10 | Taille de fichier (< 500 lignes) | HIGH | -1 pt |

**Java (`best-practices.java.system.md`) — Règles JavaGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Pas de `null` return (préférer `Optional`) | HIGH | -1 pt |
| 2 | Javadoc sur public API | MEDIUM | -0.5 pt |
| 3 | Exceptions checked vs unchecked (pas de `catch (Exception e)`) | HIGH | -1 pt |
| 4 | Immutabilité (final fields, Collections.unmodifiable) | MEDIUM | -0.5 pt |
| 5 | Naming conventions (PascalCase classes, camelCase methods) | HIGH | -1 pt |
| 6 | Pas de raw types (utiliser generics) | CRITICAL | -3 pts |
| 7 | Ressources avec try-with-resources | HIGH | -1 pt |
| 8 | Security (pas de secrets, SQL paramétré, pas de `Runtime.exec()` brut) | CRITICAL | -4 pts |
| 9 | Taille de fichier (< 300 lignes) | HIGH | -1 pt |
| 10 | Stream API et lambdas quand approprié (Java 8+) | MEDIUM | -0.5 pt |

**C# (`best-practices.csharp.system.md`) — Règles CSharpGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Nullable reference types (enable `#nullable`) | HIGH | -1 pt |
| 2 | XML doc comments sur public API (`///`) | MEDIUM | -0.5 pt |
| 3 | `async`/`await` correct (pas de `.Result` ou `.Wait()` blocking) | CRITICAL | -3 pts |
| 4 | `IDisposable` avec `using` statement | HIGH | -1 pt |
| 5 | Naming conventions (PascalCase, `I` prefix interfaces) | HIGH | -1 pt |
| 6 | Immutabilité (readonly, init-only, records) | MEDIUM | -0.5 pt |
| 7 | LINQ quand approprié (pas de boucles manuelles évidentes) | MEDIUM | -0.5 pt |
| 8 | Security (pas de secrets, SQL paramétré, pas de `Process.Start` brut) | CRITICAL | -4 pts |
| 9 | Taille de fichier (< 300 lignes) | HIGH | -1 pt |
| 10 | Pattern matching (C# 9+) | MEDIUM | -0.5 pt |

**SQL (`best-practices.sql.system.md`) — Règles SqlGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Parameterized queries (pas de concaténation de valeurs) | CRITICAL | -4 pts |
| 2 | Indexes sur les colonnes de WHERE/JOIN | HIGH | -1 pt |
| 3 | Constraints (NOT NULL, FOREIGN KEY, CHECK) | HIGH | -1 pt |
| 4 | Naming conventions (snake_case tables/colonnes) | MEDIUM | -0.5 pt |
| 5 | Pas de `SELECT *` en production | HIGH | -1 pt |
| 6 | Transactions explicites pour les opérations multi-tables | HIGH | -1 pt |
| 7 | Commentaires sur les requêtes complexes | MEDIUM | -0.5 pt |
| 8 | Security (pas de secrets, permissions appropriées) | CRITICAL | -4 pts |

**JSON (`best-practices.json.system.md`) — Règles JsonGuard :**

| # | Rule | Severity | Penalty |
|---|------|----------|---------|
| 1 | Structure valide (pas de trailing commas, pas de commentaires) | CRITICAL | -3 pts |
| 2 | Naming conventions cohérentes (camelCase ou snake_case, pas de mélange) | HIGH | -1 pt |
| 3 | Pas de secrets ou tokens en clair | CRITICAL | -4 pts |
| 4 | Pas de valeurs dupliquées (clés uniques) | HIGH | -1 pt |
| 5 | Taille raisonnable (< 500 lignes) | MEDIUM | -0.5 pt |

---

##### Prompt documentation par langage

| Langage | Critères de documentation | Statuts |
|---------|--------------------------|---------|
| **TypeScript** (existant) | JSDoc/TSDoc, `@param`, `@returns`, types auto-documentés | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **Bash** | Commentaire header de fonction (`# @description`, `## Usage:`), variables commentées inline | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **Python** | Docstrings (Google/NumPy/Sphinx), `Args:`, `Returns:`, module docstring | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **Rust** | Doc comments (`///`, `//!`), `# Examples`, `# Errors`, `# Panics` | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **Go** | Godoc (`// FuncName ...`), package comment, examples | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **Java** | Javadoc (`/** */`), `@param`, `@return`, `@throws` | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **C#** | XML doc comments (`///`), `<summary>`, `<param>`, `<returns>` | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **SQL** | Commentaires `--` sur tables/colonnes, header de fichier | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **YAML** | Commentaires `#` sur les clés non évidentes, header de fichier | DOCUMENTED / PARTIAL / UNDOCUMENTED |
| **JSON** | N/A — JSON n'a pas de commentaires. Documentation = axe toujours DOCUMENTED (skip) | DOCUMENTED |

---

##### Injection du langage dans les axes agnostiques

Pour les 5 axes langage-agnostiques, le `buildUserMessage()` injecte le langage et la méthode de parsing :

```ts
// Ajouté au début du user message de chaque axe agnostique
parts.push(`## Language: ${ctx.task.language ?? 'typescript'}`);
parts.push(`## Parse method: ${ctx.task.parse_method ?? 'ast'}`);
```

Le code block utilise le bon langage pour la coloration syntaxique :

```ts
// Avant (hardcodé) :
parts.push('```typescript');

// Après (dynamique) :
const langHint = LANGUAGE_TO_FENCE[ctx.task.language ?? 'typescript'] ?? '';
parts.push(`\`\`\`${langHint}`);

const LANGUAGE_TO_FENCE: Record<string, string> = {
  typescript: 'typescript',
  bash: 'bash',
  python: 'python',
  rust: 'rust',
  go: 'go',
  java: 'java',
  csharp: 'csharp',
  sql: 'sql',
  yaml: 'yaml',
  json: 'json',
};
```

---

##### Impact sur les 7 Axes d'Évaluation

| Axe | Stratégie prompt | Adaptations spécifiques |
|-----|-----------------|------------------------|
| **utility** | Agnostique + language hint | Usage-graph étendu (`source`/`.` bash, `import` Python). Fonctions bash sans `source` = candidates DEAD. |
| **duplication** | Agnostique (inchangé) | RAG sur FunctionCards — summaries Haiku fonctionnent indépendamment du langage. Détection cross-langage (bash ↔ TS). |
| **correction** | Agnostique + language hint | Le LLM connaît les bugs communs de chaque langage. Prompt inchangé. |
| **overengineering** | Agnostique + language hint | Complexité disproportionnée évaluable dans tout langage. Prompt inchangé. |
| **tests** | Agnostique + language hint | Bash : détection Bats (`.bats`) / shunit2. Python : pytest/unittest. Coverage Istanbul = `undefined` pour non-TS. |
| **best_practices** | **Prompt dédié par langage** | TypeGuard (TS), ShellGuard (Bash), PyGuard (Python), RustGuard (Rust), GoGuard (Go), JavaGuard (Java), CSharpGuard (C#), SqlGuard (SQL), YamlGuard (YAML), JsonGuard (JSON). Résolution automatique par convention de nommage. |
| **documentation** | **Prompt dédié par langage** | JSDoc (TS), commentaires header (Bash), docstrings (Python), doc comments (Rust), Godoc (Go), Javadoc (Java), XML doc (C#), commentaires SQL, commentaires YAML. JSON = toujours DOCUMENTED (skip). |

---

#### Modifications par Fichier

| Fichier | Nature du changement |
|---------|---------------------|
| `schemas/config.ts` | Ajout `scan.auto_detect: z.boolean().default(true)` |
| `schemas/task.ts` | Ajout `language`, `parse_method`, `framework` optionnels |
| **`src/core/auto-detect.ts`** (nouveau) | Module de détection automatique de fichiers par pattern |
| **`src/core/language-detect.ts`** (nouveau) | Détection de langages par répartition d'extensions |
| **`src/core/language-adapters.ts`** (nouveau) | Interface `LanguageAdapter` + adapters : TS, Bash, Python, Rust, Go, Java, C#, SQL, YAML, JSON |
| **`src/core/grammar-manager.ts`** (nouveau) | Téléchargement et cache des WASM tree-sitter à la demande |
| **`src/core/heuristic-parser.ts`** (nouveau) | Fallback regex pour fichiers sans grammaire |
| `src/core/scanner.ts` | Refactor `parseFile()` pour utiliser `LanguageAdapter` + `GrammarManager`, intégrer auto-detect dans `collectFiles()` |
| `src/core/usage-graph.ts` | Accepter les `ImportRef` multi-langage via les adapters |
| `src/core/axis-evaluator.ts` | `resolveSystemPrompt(axisId, language)` — résolution dynamique avec fallback |
| `src/core/axes/best-practices.ts` | Utiliser `resolveSystemPrompt()` au lieu d'import statique, adapter `buildUserMessage()` (fence dynamique) |
| `src/core/axes/documentation.ts` | Idem — `resolveSystemPrompt()` + fence dynamique |
| `src/core/axes/correction.ts` | Injection `Language:` + `Parse method:` dans le user message |
| `src/core/axes/overengineering.ts` | Idem |
| `src/core/axes/tests.ts` | Idem + détection frameworks de test par langage |
| `src/core/axes/utility.ts` | Injection `Language:` dans le user message |
| **`src/core/axes/prompts/best-practices.bash.system.md`** (nouveau) | ShellGuard — 12 règles |
| **`src/core/axes/prompts/best-practices.python.system.md`** (nouveau) | PyGuard — 13 règles |
| **`src/core/axes/prompts/best-practices.rust.system.md`** (nouveau) | RustGuard — 10 règles |
| **`src/core/axes/prompts/best-practices.go.system.md`** (nouveau) | GoGuard — 10 règles |
| **`src/core/axes/prompts/best-practices.java.system.md`** (nouveau) | JavaGuard — 10 règles |
| **`src/core/axes/prompts/best-practices.csharp.system.md`** (nouveau) | CSharpGuard — 10 règles |
| **`src/core/axes/prompts/best-practices.sql.system.md`** (nouveau) | SqlGuard — 8 règles |
| **`src/core/axes/prompts/best-practices.yaml.system.md`** (nouveau) | YamlGuard — 8 règles |
| **`src/core/axes/prompts/best-practices.json.system.md`** (nouveau) | JsonGuard — 5 règles |
| **`src/core/axes/prompts/documentation.bash.system.md`** (nouveau) | Critères doc Bash |
| **`src/core/axes/prompts/documentation.python.system.md`** (nouveau) | Critères doc Python |
| **`src/core/axes/prompts/documentation.rust.system.md`** (nouveau) | Critères doc Rust |
| **`src/core/axes/prompts/documentation.go.system.md`** (nouveau) | Critères doc Go |
| **`src/core/axes/prompts/documentation.java.system.md`** (nouveau) | Critères doc Java |
| **`src/core/axes/prompts/documentation.csharp.system.md`** (nouveau) | Critères doc C# |
| **`src/core/axes/prompts/documentation.sql.system.md`** (nouveau) | Critères doc SQL |
| **`src/core/axes/prompts/documentation.yaml.system.md`** (nouveau) | Critères doc YAML |
| **`src/core/axes/prompts/best-practices.react.system.md`** (nouveau) | Hooks rules, component patterns, memo, a11y |
| **`src/core/axes/prompts/best-practices.nextjs.system.md`** (nouveau) | Server/Client components, App Router, data fetching |
| **`src/core/axes/prompts/documentation.react.system.md`** (nouveau) | Props doc, component examples, Storybook |
| **`src/core/axes/prompts/documentation.nextjs.system.md`** (nouveau) | Route doc, API Route doc, middleware |
| `package.json` | Seule dépendance ajoutée : aucune (grammaires téléchargées dynamiquement) |

---

#### Installation Dynamique des Grammaires Tree-Sitter

**Problème :** Bundler 9+ fichiers WASM dans le package npm alourdirait le bundle inutilement. Un projet 100% TypeScript n'a pas besoin de `tree-sitter-rust.wasm`.

**Décision :** Seul `tree-sitter-typescript` reste bundlé (Tier 0, toujours nécessaire). Toutes les autres grammaires sont **téléchargées à la demande** au premier scan qui détecte le langage.

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Stockage | `.anatoly/grammars/{lang}.wasm` | Isolé dans `.anatoly/`, ne touche jamais au projet |
| Source | WASM pré-compilés depuis npm registry (download direct du `.wasm`) | Pas de `npm install` dans le projet de l'utilisateur |
| Cache | One-shot — téléchargé une fois, réutilisé indéfiniment | Chaque WASM fait 150-400 KB, download en <1s |
| Versioning | Fichier `.anatoly/grammars/manifest.json` : `{ "bash": { "version": "0.23.3", "sha256": "..." } }` | Permet de détecter les mises à jour |
| Offline | Si le WASM est absent et le réseau indisponible → fallback heuristique pour ce langage | Le pipeline ne bloque jamais |
| Affichage | Phase `grammars` dans Pipeline Summary : `✔ grammars  2 cached · 1 downloaded (tree-sitter-rust)` | Feedback à l'utilisateur |

**Implémentation :** Nouveau module `src/core/grammar-manager.ts`

```ts
interface GrammarManager {
  /** Résoudre le chemin WASM pour un langage — download si nécessaire */
  resolve(language: string): Promise<string | null>;
  /** Vérifier si une grammaire est disponible (sans download) */
  has(language: string): boolean;
}

/** Registry des grammaires disponibles */
const GRAMMAR_REGISTRY: Record<string, { npmPackage: string; wasmFile: string }> = {
  typescript: { npmPackage: 'tree-sitter-typescript', wasmFile: 'tree-sitter-typescript.wasm' },  // bundlé
  tsx:        { npmPackage: 'tree-sitter-typescript', wasmFile: 'tree-sitter-tsx.wasm' },           // bundlé
  bash:       { npmPackage: 'tree-sitter-bash',       wasmFile: 'tree-sitter-bash.wasm' },
  python:     { npmPackage: 'tree-sitter-python',     wasmFile: 'tree-sitter-python.wasm' },
  rust:       { npmPackage: 'tree-sitter-rust',       wasmFile: 'tree-sitter-rust.wasm' },
  go:         { npmPackage: 'tree-sitter-go',         wasmFile: 'tree-sitter-go.wasm' },
  java:       { npmPackage: 'tree-sitter-java',       wasmFile: 'tree-sitter-java.wasm' },
  csharp:     { npmPackage: 'tree-sitter-c-sharp',    wasmFile: 'tree-sitter-c-sharp.wasm' },
  sql:        { npmPackage: 'tree-sitter-sql',        wasmFile: 'tree-sitter-sql.wasm' },
  yaml:       { npmPackage: 'tree-sitter-yaml',       wasmFile: 'tree-sitter-yaml.wasm' },
  json:       { npmPackage: 'tree-sitter-json',       wasmFile: 'tree-sitter-json.wasm' },
};

export function createGrammarManager(projectRoot: string): GrammarManager;
```

**Flow dans le pipeline :**

```
1. language-detect → détecte les langages présents (ex: TypeScript 85%, Rust 10%, YAML 5%)
2. grammar-manager.resolve() pour chaque langage détecté
   → TypeScript : bundlé, résolution immédiate
   → Rust : vérifie .anatoly/grammars/tree-sitter-rust.wasm
     → si présent : résolution immédiate
     → si absent : download depuis npm → cache dans .anatoly/grammars/
     → si download échoue : fallback heuristique, log warning
3. scanner.parseFile() utilise le WASM résolu par le grammar-manager
```

**Grammaires disponibles (Tier 1) :**

| Langage | npm Package | Taille WASM | Bundlé |
|---------|------------|-------------|--------|
| TypeScript | `tree-sitter-typescript` | ~250 KB | Oui (Tier 0) |
| TSX | `tree-sitter-typescript` | ~280 KB | Oui (Tier 0) |
| Bash/Shell | `tree-sitter-bash` | ~200 KB | Non — download |
| Python | `tree-sitter-python` | ~300 KB | Non — download |
| Rust | `tree-sitter-rust` | ~350 KB | Non — download |
| Go | `tree-sitter-go` | ~250 KB | Non — download |
| Java | `tree-sitter-java` | ~300 KB | Non — download |
| C# | `tree-sitter-c-sharp` | ~350 KB | Non — download |
| SQL | `tree-sitter-sql` | ~200 KB | Non — download |
| YAML | `tree-sitter-yaml` | ~150 KB | Non — download |
| JSON | `tree-sitter-json` | ~100 KB | Non — download |

**Impact bundle npm :** Zéro — seul tree-sitter-typescript reste dans les dépendances. Les autres sont téléchargés on-demand.

---

#### Séquence d'Implémentation

1. `schemas/task.ts` — ajout `language`, `parse_method`, `framework`
2. `schemas/config.ts` — ajout `scan.auto_detect`
3. `src/core/language-detect.ts` — détection langages (passe 1 : extensions) + frameworks (passe 2 : marqueurs projet)
4. `src/core/grammar-manager.ts` — téléchargement et cache des WASM à la demande
5. `src/core/language-adapters.ts` — interface `LanguageAdapter` + TypeScriptAdapter (refactor de l'existant)
6. `src/core/language-adapters.ts` — adapters Tier 1 : Bash, Python, Rust, Go, Java, C#, SQL, YAML, JSON
7. `src/core/heuristic-parser.ts` — fallback regex
8. `src/core/auto-detect.ts` — détection automatique de fichiers
9. `src/core/scanner.ts` — refactor `parseFile()` + `collectFiles()` pour utiliser adapters + grammar-manager + auto-detect + framework tagging
10. `src/core/usage-graph.ts` — accepter imports multi-langage
11. `src/core/axis-evaluator.ts` — `resolveSystemPrompt(axisId, language, framework?)` avec cascade 3 niveaux
12. Prompts best_practices par langage : 9 fichiers `.system.md` (ShellGuard, PyGuard, RustGuard, GoGuard, JavaGuard, CSharpGuard, SqlGuard, YamlGuard, JsonGuard)
13. Prompts documentation par langage : 8 fichiers `.system.md` (Bash, Python, Rust, Go, Java, C#, SQL, YAML)
14. Prompts framework-spécifiques : `best-practices.react.system.md`, `best-practices.nextjs.system.md`, `documentation.react.system.md`, `documentation.nextjs.system.md`
15. Axes agnostiques : injection `Language:` + `Framework:` + fence dynamique dans `buildUserMessage()`
16. Axes spécifiques : `best-practices.ts` + `documentation.ts` → `resolveSystemPrompt()` avec cascade
17. `run.ts` — language-detect + framework-detect dans Project Info, grammar download dans Pipeline Summary
18. Tests unitaires pour chaque adapter, grammar-manager, auto-detect, heuristic-parser, resolveSystemPrompt, framework detection

---

### Implementation Handoff

**Tout agent IA implémentant ce projet DOIT :**
- Suivre toutes les décisions architecturales exactement comme documentées
- Utiliser les patterns d'implémentation de manière cohérente
- Respecter la structure projet et les frontières architecturales
- Se référer à ce document pour toute question architecturale

**Prochaine priorité d'implémentation :**
Multi-language support v0.6.0 : `LanguageAdapter` interface, language-detect + framework-detect, grammar-manager (download dynamique), auto-detect, 9 adapters Tier 1, heuristic fallback, 9 prompts best_practices + 8 prompts documentation par langage, prompts framework (React, Next.js), `resolveSystemPrompt()` avec cascade 3 niveaux (framework → language → default).

**Pour ajouter un nouvel axe d'évaluation :**
1. Créer `core/axes/my-axis.ts` implémentant `AxisEvaluator`
2. Ajouter l'ID dans `AxisIdSchema` (`schemas/review.ts`)
3. Ajouter dans `ALL_EVALUATORS` (`core/axes/index.ts`)
4. Ajouter la config dans `AxesConfigSchema` (`schemas/config.ts`)
5. Ajouter le default dans `AXIS_DEFAULTS` (`core/axis-merger.ts`) si applicable

**Pour ajouter un nouveau langage :**
1. Ajouter l'extension dans `EXTENSION_MAP` (`core/language-detect.ts`)
2. Créer un `LanguageAdapter` dans `core/language-adapters.ts`
3. Ajouter le WASM dans `GRAMMAR_REGISTRY` (`core/grammar-manager.ts`) — téléchargé dynamiquement
4. Enregistrer l'adapter dans le registry (Map extension → adapter)
5. Ajouter les patterns auto-detect dans `core/auto-detect.ts`
6. Ajouter les patterns d'import dans l'adapter pour le usage-graph
7. **(Optionnel)** Déposer `best-practices.{lang}.system.md` et `documentation.{lang}.system.md` dans `prompts/` — si absents, le prompt default + language hint fonctionne en mode dégradé

**Pour ajouter un nouveau framework :**
1. Ajouter les marqueurs de détection dans `detectProjectProfile()` (`core/language-detect.ts`)
2. **(Optionnel)** Déposer `best-practices.{framework}.system.md` et/ou `documentation.{framework}.system.md` dans `prompts/` — résolution automatique par cascade

---

### Epic 34 — Prompt Reinforcement: Architecture Addendum

**Date :** 2026-03-22
**Scope :** Audit, edge case evaluation, and reinforcement of all 36 system prompts across 6 domains.

#### 34.1 — Prompt Inventory & Domain Map

Le système contient **36 prompts** répartis en 6 domaines :

| Domaine | Prompts | Fichiers |
|---------|---------|----------|
| Axes (base) | 7 | `utility`, `correction`, `duplication`, `overengineering`, `tests`, `best-practices`, `documentation` |
| Axes (language variants) | 17 | `best-practices.{bash,python,rust,go,java,csharp,sql,yaml,json}`, `documentation.{bash,python,rust,go,java,csharp,sql,yaml}` |
| Axes (framework variants) | 4 | `best-practices.{react,nextjs}`, `documentation.{react,nextjs}` |
| Axes (spécialisé) | 1 | `correction.verification` |
| Délibération | 1 | `deliberation` |
| Doc-generation | 3 | `doc-writer`, `doc-writer.architecture`, `doc-writer.api-reference` |
| RAG | 2 | `nlp-summarizer`, `section-refiner` |
| Shared | 1 | `_shared.json-evaluator-wrapper` |

**Résolution cascade :** `framework → language → default` via `resolveSystemPrompt(axisId, language?, framework?)`.

**Composition :** Chaque appel LLM = `json-evaluator-wrapper` + `systemPrompt` (résolu par cascade) + `userMessage` (construit par l'évaluateur).

#### 34.2 — Edge Case Taxonomy

Audit complet des edge cases identifiés, classés par criticité d'impact :

##### CRITICAL — Peuvent causer des résultats incorrects

| ID | Edge Case | Prompts Affectés | Risque |
|----|-----------|------------------|--------|
| EC-01 | **Hallucination de symboles** — Le LLM peut inventer des symboles absents du code source | Tous les 7 axes | Faux positifs non traçables, actions sur des lignes inexistantes |
| EC-02 | **Actions hors limites** — `action.line` peut pointer vers une ligne inexistante dans le fichier | `correction` | Action non applicable, confusion utilisateur |
| EC-03 | **Erreur factuelle deliberation** — Le prompt dit "6 independent axis evaluators" mais il y en a 7 | `deliberation` | Le judge pourrait ignorer un axe |
| EC-04 | **Contradiction JSON fences** — Les exemples montrent ```json fences tout en disant "no markdown fences" | `correction`, `utility`, `duplication`, `overengineering`, `tests`, `documentation` | Le LLM peut entourer sa réponse de fences → échec du parsing JSON |

##### HIGH — Peuvent causer des évaluations biaisées

| ID | Edge Case | Prompts Affectés | Risque |
|----|-----------|------------------|--------|
| EC-05 | **Fichiers vides / 0 symboles** — Aucune guidance sur le comportement attendu | Tous les 7 axes | Réponse imprévisible (JSON vide ? erreur ? symbole inventé ?) |
| EC-06 | **Code généré (protobuf, codegen, migrations)** — Évalué comme du code humain | `correction`, `best-practices`, `overengineering` | Faux positifs massifs sur du code auto-généré |
| EC-07 | **Score anchoring** — Pas d'exemples concrets de ce qu'est un 3/10 vs 8/10 | `best-practices` + variants | Clustering des scores autour de 7-9, discrimination faible |
| EC-08 | **Confidence calibration** — Aucun exemple négatif de ce que signifie confidence 72 vs 95 | Tous les 7 axes | Sur-confidence systématique |
| EC-09 | **Fichiers monolithes (>1000 lignes)** — Risque de dépassement du budget tokens | Tous les axes | Troncature silencieuse, symboles manqués en fin de fichier |

##### MEDIUM — Peuvent causer des incohérences mineures

| ID | Edge Case | Prompts Affectés | Risque |
|----|-----------|------------------|--------|
| EC-10 | **Contenu multi-langage** — SQL inline dans TS, bash dans JS | `correction`, `best-practices` | Évaluation du code embarqué avec les règles du langage hôte |
| EC-11 | **Chevauchement ACCEPTABLE/LEAN** — Frontière subjective | `overengineering` | Incohérence entre évaluations de fichiers similaires |
| EC-12 | **doc-generation sous-spécifié** — Pas de max length, pas de tone, pas de gestion des conflits source/docs | `doc-writer` + variants | Documentation trop longue ou inconsistante |
| EC-13 | **RAG nlp-summarizer sans garde-fou** — Pas de fallback, pas de max tokens, pas de guidance d'erreur | `rag.nlp-summarizer` | Résumés tronqués ou incohérents sur des fonctions longues |
| EC-14 | **Inconsistance rule count entre variants** — Base=17 rules, Bash=14, Python=15... intentionnel mais non documenté | `best-practices` variants | Confusion lors de la maintenance des prompts |

#### 34.3 — Reinforcement Strategy: 4 Pillars

##### Pillar 1 — Guard Rails (anti-hallucination, contraintes de limites)

**Objectif :** Empêcher le LLM de produire des données qui ne correspondent pas au code source.

**Règles à injecter dans TOUS les axis prompts :**

```
## Constraints
- ONLY output symbols that exist in the provided source code. Do NOT invent symbols.
- Every symbol name you output MUST match exactly a symbol name from the source.
- line_start and line_end MUST fall within the actual file line range (1 to N).
- If the file contains 0 symbols, return { "symbols": [] } with no additional fields.
- action.line (when applicable) MUST reference a line that exists in the source file.
```

**Décision architecturale :** Ces règles seront ajoutées dans un **nouveau fichier shared** `_shared/guard-rails.system.md` et **prepended automatiquement** comme le `json-evaluator-wrapper`, pour éviter la duplication dans 7+ prompts.

**Impact code :** Modifier `axis-evaluator.ts` pour prepend `guard-rails` avant le system prompt (après `json-evaluator-wrapper`).

```typescript
// axis-evaluator.ts — composition actuelle
const systemPrompt = `${resolveSystemPrompt('_shared.json-evaluator-wrapper')}\n\n${rawSystemPrompt}`;

// axis-evaluator.ts — composition renforcée
const systemPrompt = [
  resolveSystemPrompt('_shared.json-evaluator-wrapper'),
  resolveSystemPrompt('_shared.guard-rails'),
  rawSystemPrompt,
].join('\n\n');
```

##### Pillar 2 — Edge Case Handling (fichiers spéciaux)

**Objectif :** Guider explicitement le comportement sur les cas limites.

**2a. Fichiers vides / 0 symboles** — Ajouter dans guard-rails :
```
- If no symbols are provided or the source file is empty, return the minimal valid response
  with an empty symbols array. Do NOT fabricate content.
```

**2b. Code généré** — Ajouter dans les prompts `correction`, `best-practices`, `overengineering` :
```
- If the file contains a code generation marker (e.g. "DO NOT EDIT", "@generated",
  "auto-generated"), evaluate leniently: generated code follows its generator's conventions,
  not human coding standards. Lower confidence by 20 points for any finding.
```

**Décision architecturale :** La détection de fichiers générés sera côté **user message** (dans le `buildUserMessage()` de chaque évaluateur) car c'est un signal contextuel, pas une règle système. L'évaluateur ajoutera un hint `## Generated Code: true/false` dans le user message. La règle dans le prompt system explique comment interpréter ce hint.

**2c. Fichiers monolithes** — Pas d'action au niveau prompt. C'est un problème de pipeline : `file-evaluator.ts` doit déjà tronquer ou segmenter. Documenter la limite dans le guard-rails :
```
- If the source code appears truncated (ends abruptly), only evaluate the symbols visible
  in the provided content. State in detail when a symbol evaluation may be incomplete
  due to truncation.
```

##### Pillar 3 — Calibration (scoring & confidence)

**Objectif :** Réduire le clustering des scores et améliorer la discrimination de confiance.

**3a. Score anchoring pour best-practices** — Ajouter des exemples calibrés dans CHAQUE prompt best-practices :

```
## Score Calibration
- 9-10: Exemplary code — all rules satisfied, modern patterns, comprehensive types
- 7-8: Good code — minor issues (missing readonly, slight file size), no security/type problems
- 5-6: Adequate code — several WARN, maybe one HIGH violation, but functional
- 3-4: Below standard — multiple HIGH violations, `any` types, missing error handling
- 1-2: Poor — CRITICAL violations (security issues, no strict mode, widespread `any`)
- 0: Catastrophic — multiple CRITICAL violations combined
```

**Décision architecturale :** La calibration est **spécifique à chaque domaine** (les anchors pour TypeScript ≠ Bash ≠ Python). Chaque prompt best-practices variant doit avoir sa propre section calibration adaptée au langage. Pas de factorisation possible ici — la spécificité prime.

**3b. Confidence calibration** — Ajouter dans guard-rails (applicable à tous les axes) :

```
## Confidence Guide
- 95-100: Certain — unambiguous evidence in the code (e.g., symbol is clearly exported
  and has 0 importers → DEAD with 95)
- 85-94: High confidence — strong evidence but minor ambiguity possible (e.g., pattern looks
  like a bug but could be intentional edge case handling)
- 70-84: Moderate — the finding is likely correct but contextual information is incomplete
  (e.g., behavior depends on runtime config not visible in the code)
- Below 70: Low — speculation. Use this when you are guessing. Never output confidence
  below 50 — if you are that unsure, classify as the more conservative option.
```

##### Pillar 4 — Structural Consistency (normalisation)

**Objectif :** Éliminer les contradictions et aligner les variants.

**4a. Fix JSON fence contradiction (EC-04)** — Retirer les ```json fences des exemples dans les 6 prompts affectés. Le format de sortie montre déjà un objet JSON raw. La contradiction actuelle envoie un signal mixte au LLM.

**Prompts à corriger :** `correction`, `utility`, `duplication`, `overengineering`, `tests`, `documentation`.

**Action :** Remplacer les blocs :
```
Output ONLY a JSON object (no markdown fences, no explanation):

\`\`\`json
{...}
\`\`\`
```
Par :
```
Output ONLY a raw JSON object (no markdown fences, no explanation):

{...}
```

**4b. Fix deliberation axis count (EC-03)** — Changer "6 independent axis evaluators" → "7 independent axis evaluators" dans `deliberation.system.md`.

**4c. Document rule count variance (EC-14)** — Ajouter un commentaire en tête de chaque prompt best-practices variant expliquant pourquoi le nombre de règles diffère :
```
<!-- This language has {N} rules (vs 17 for TypeScript) because:
     - Rules X, Y are TypeScript-specific and replaced by language-native equivalents
     - Rules A, B are added for language-specific concerns -->
```

**4d. Renforcer doc-generation** — Ajouter dans `doc-writer.system.md` :
```
- Maximum page length: 500 lines of Markdown. If the content exceeds this, split into
  logical sub-pages and reference them.
- Tone: technical, precise, third-person. No marketing language, no superlatives.
- When source code contradicts existing documentation, follow the source code and note
  the discrepancy explicitly.
```

**4e. Renforcer nlp-summarizer** — Ajouter dans `rag/nlp-summarizer.system.md` :
```
- If a function body exceeds 200 lines, focus the summary on the public interface
  (parameters, return type, side effects) rather than implementation details.
- If you cannot determine the function's purpose, return summary: "Purpose unclear
  from code alone" — do NOT hallucinate intent.
- keyConcepts must be lowercase, hyphenated, max 30 chars each.
```

#### 34.4 — Testing Strategy

##### Prompt-Level Tests (unitaires)

Étendre les tests existants dans `src/prompts/axes/*.test.ts` :

| Test | Validation |
|------|------------|
| Guard-rails presence | Tous les system prompts composés contiennent les règles guard-rails |
| No JSON fences in examples | Regex vérifie qu'aucun prompt n'a de ```json dans la section Output format |
| Score calibration presence | Tous les best-practices prompts contiennent la section "Score Calibration" |
| Confidence guide presence | Guard-rails contient la section "Confidence Guide" |
| Axis count in deliberation | Le mot "7" (pas "6") apparaît dans deliberation.system.md |
| Rule count documented | Chaque best-practices variant a un commentaire HTML documentant le delta vs base |

##### Integration Tests (évaluation gold-set)

Créer un **gold-set** de fichiers de test représentant les edge cases :

| Fichier Gold-Set | Edge Case Testé | Verdicts Attendus |
|------------------|-----------------|-------------------|
| `gold/empty-file.ts` | Fichier vide, 0 symboles | `{ "symbols": [] }` pour tous les axes |
| `gold/generated-protobuf.ts` | Code avec `@generated` header | Scores leniants, confidence -20pts |
| `gold/monolith-500-lines.ts` | Fichier long, multi-fonction | Tous les symboles couverts, pas de troncature |
| `gold/mixed-lang-sql.ts` | SQL inline via template literals | SQL non évalué comme TypeScript |
| `gold/perfect-10.ts` | Code exemplaire | best-practices score ≥ 9.5 |
| `gold/terrible-1.ts` | Code avec `any`, `eval`, secrets | best-practices score ≤ 2.0 |
| `gold/dead-code.ts` | Exports jamais importés | utility = DEAD pour les exports orphelins |
| `gold/false-duplicate.ts` | Fonctions structurellement similaires mais sémantiquement différentes | duplication = UNIQUE |

**Mécanisme :** Ces tests utilisent les vrais prompts via `runSingleTurnQuery()` avec Haiku (coût minimal). Assertion sur le verdict, pas sur le detail. Exécutés dans une suite séparée (`vitest --project gold-set`) car ils font des appels LLM réels.

**Budget :** ~$0.02 par fichier gold × 8 fichiers × 7 axes = ~$1.12 par run complet. Exécution manuelle uniquement (pas en CI).

##### Regression Tests (snapshot-based)

Pour chaque prompt modifié, capturer un snapshot avant/après sur 3 fichiers du projet :
1. Un fichier "propre" (attendu CLEAN)
2. Un fichier avec des problèmes connus (attendu NEEDS_REFACTOR)
3. Un fichier edge case pertinent

Vérifier que les verdicts ne régressent pas (pas de nouveau faux positif sur les fichiers propres).

#### 34.5 — Impact sur le Code Existant

| Fichier | Modification | Effort |
|---------|-------------|--------|
| `src/prompts/_shared/guard-rails.system.md` | **NOUVEAU** — Guard rails partagés | Création |
| `src/core/prompt-resolver.ts` | Enregistrer `_shared.guard-rails` dans le registry | ~5 lignes |
| `src/core/axis-evaluator.ts` | Prepend guard-rails dans la composition du system prompt | ~3 lignes |
| `src/prompts/axes/correction.system.md` | Retirer JSON fences, ajouter generated-code rule | Édition |
| `src/prompts/axes/utility.system.md` | Retirer JSON fences | Édition |
| `src/prompts/axes/duplication.system.md` | Retirer JSON fences | Édition |
| `src/prompts/axes/overengineering.system.md` | Retirer JSON fences | Édition |
| `src/prompts/axes/tests.system.md` | Retirer JSON fences | Édition |
| `src/prompts/axes/documentation.system.md` | Retirer JSON fences | Édition |
| `src/prompts/axes/best-practices.system.md` | Retirer JSON fences (déjà absent), ajouter score calibration | Édition |
| `src/prompts/axes/best-practices.*.system.md` | Ajouter score calibration par langage (×11 variants) | Édition |
| `src/prompts/deliberation/deliberation.system.md` | Fix "6" → "7" axes | 1 ligne |
| `src/prompts/doc-generation/doc-writer.system.md` | Ajouter contraintes de longueur, ton, conflits | Édition |
| `src/prompts/rag/nlp-summarizer.system.md` | Ajouter contraintes de longueur, fallback | Édition |
| `src/prompts/rag/section-refiner.system.md` | Review — actuellement adéquat | Aucune |
| `src/prompts/_shared/json-evaluator-wrapper.system.md` | Review — actuellement adéquat | Aucune |
| `src/core/prompt-resolver.test.ts` | Mettre à jour le count registry (36 → 37) | ~1 ligne |
| Tests gold-set | **NOUVEAU** — Suite de tests LLM sur edge cases | Création |

#### 34.6 — Impact sur les Zod Schemas

**Aucun changement de schema requis.** Les reinforcements sont au niveau des prompts (instructions au LLM), pas au niveau de la structure de sortie. Les Zod schemas existants restent valides :
- `UtilityResponseSchema` — accepte déjà `{ "symbols": [] }`
- `CorrectionResponseSchema` — accepte déjà `{ "symbols": [], "actions": [] }`
- `BestPracticesResponseSchema` — le champ `score` est déjà `z.number().min(0).max(10)`

**Exception potentielle :** Si le gold-set révèle que les LLM retournent des champs additionnels suite aux nouvelles instructions, il faudra ajouter `.passthrough()` ou `.strict()` selon la stratégie. Recommandation : garder `.strict()` pour rejeter les champs inattendus.

#### 34.7 — Ordre d'Implémentation Recommandé

1. **Phase 1 — Structural fixes (quick wins, zero risk)**
   - Fix JSON fence contradiction dans 6 prompts
   - Fix "6" → "7" dans deliberation
   - Documenter les rule count deltas dans les variants

2. **Phase 2 — Guard rails (shared infrastructure)**
   - Créer `_shared/guard-rails.system.md`
   - Modifier `prompt-resolver.ts` pour l'enregistrer
   - Modifier `axis-evaluator.ts` pour le prepend
   - Mettre à jour les tests unitaires

3. **Phase 3 — Calibration (per-prompt enrichment)**
   - Ajouter score calibration dans les 12 prompts best-practices
   - Confidence guide dans guard-rails (fait en Phase 2)

4. **Phase 4 — Edge case rules (per-prompt enrichment)**
   - Generated code handling dans correction, best-practices, overengineering
   - Truncation handling dans guard-rails
   - Renforcer doc-generation et nlp-summarizer

5. **Phase 5 — Schema example injection (réduction des retries)**
   - Créer `generateSchemaExample()` utilitaire
   - Intégrer dans la composition du system prompt
   - Valider la réduction du taux de retry

6. **Phase 6 — Gold-set testing (validation)**
   - Créer les 8 fichiers gold-set
   - Créer la suite de test
   - Valider les verdicts sur chaque phase
   - Snapshot regression baselines

#### 34.8 — Schema Example Injection (réduction des retries Zod)

##### Problème

Le mécanisme actuel de `runSingleTurnQuery()` fonctionne en **2 tentatives** :
1. Tentative initiale → validation Zod → si échec, feedback d'erreur au LLM
2. Retry avec le message d'erreur Zod → re-validation → si échec, `ZOD_VALIDATION_FAILED`

Chaque retry **double le coût** de l'appel LLM (tokens + latence). Les causes fréquentes de retry :
- Le LLM omet un champ requis (`line_start`, `line_end`)
- Le LLM utilise un mauvais type (`confidence: "95"` string au lieu de `95` number)
- Le LLM invente un enum invalide (`correction: "WARNING"` au lieu de `NEEDS_FIX`)
- Le LLM oublie le champ `detail` ou le rend trop court (< 10 chars)
- Le LLM ajoute des champs non prévus par le schema

Or, **les prompts actuels montrent un exemple JSON statique** dans la section "Output format", mais cet exemple peut diverger du Zod schema réel (si le schema évolue et que le prompt n'est pas mis à jour). De plus, **aucun `.describe()` n'est utilisé** sur les schemas Zod existants — le LLM ne reçoit aucune metadata sémantique sur les contraintes.

##### Solution — Génération dynamique d'exemples depuis le schema Zod

Créer un utilitaire `generateSchemaExample(schema: z.ZodType): string` qui, à partir d'un schema Zod, produit un **exemple JSON valide commenté** injecté dans le system prompt. L'exemple est **toujours synchronisé** avec le schema car il est généré au runtime.

##### Approche technique

**Nouveau fichier :** `src/utils/schema-example.ts`

```typescript
import { z } from 'zod';

/**
 * Génère un exemple JSON valide à partir d'un schema Zod.
 * Parcourt récursivement le schema et produit des valeurs représentatives.
 */
export function generateSchemaExample(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape)) {
      result[key] = generateSchemaExample(value as z.ZodType);
    }
    return result;
  }

  if (schema instanceof z.ZodArray) {
    return [generateSchemaExample(schema.element)];
  }

  if (schema instanceof z.ZodEnum) {
    // Retourne TOUTES les valeurs possibles sous forme de commentaire inline
    const values = schema.options as string[];
    return values.join(' | ');  // sera post-traité en commentaire
  }

  if (schema instanceof z.ZodNumber) {
    const checks = (schema as any)._def.checks ?? [];
    const min = checks.find((c: any) => c.kind === 'min')?.value ?? 0;
    const max = checks.find((c: any) => c.kind === 'max')?.value ?? 100;
    // Retourne une valeur médiane réaliste
    return Math.round((min + max) / 2);
  }

  if (schema instanceof z.ZodString) {
    const checks = (schema as any)._def.checks ?? [];
    const minLen = checks.find((c: any) => c.kind === 'min')?.value ?? 0;
    if (minLen >= 10) return '<explanation — min 10 chars>';
    return '<string>';
  }

  if (schema instanceof z.ZodOptional) {
    return generateSchemaExample(schema.unwrap());
  }

  if (schema instanceof z.ZodDefault) {
    return (schema as any)._def.defaultValue();
  }

  if (schema instanceof z.ZodNullable) {
    return generateSchemaExample(schema.unwrap());
  }

  if (schema instanceof z.ZodLiteral) {
    return schema.value;
  }

  return '<unknown>';
}

/**
 * Formatte l'exemple en JSON lisible avec commentaires inline pour les enums.
 */
export function formatSchemaExample(schema: z.ZodType): string {
  const raw = generateSchemaExample(schema);
  return JSON.stringify(raw, null, 2)
    .replace(/"([\w_]+) \| ([\w_ |]+)"/g, '"$1"  // $1 | $2');
}
```

**Exemple de sortie pour `CorrectionResponseSchema` :**

```json
{
  "symbols": [
    {
      "name": "<string>",
      "line_start": 1,
      "line_end": 1,
      "correction": "OK",  // OK | NEEDS_FIX | ERROR
      "confidence": 50,
      "detail": "<explanation — min 10 chars>"
    }
  ],
  "actions": [
    {
      "description": "<string>",
      "severity": "CRITICAL",  // CRITICAL | MAJOR | MINOR
      "line": 1
    }
  ]
}
```

##### Intégration dans la pipeline

**Modification de `axis-evaluator.ts`** — Chaque évaluateur expose déjà son schema. La composition du system prompt devient :

```typescript
// axis-evaluator.ts — composition renforcée (Phase 5)
const schemaExample = formatSchemaExample(schema);

const systemPrompt = [
  resolveSystemPrompt('_shared.json-evaluator-wrapper'),
  resolveSystemPrompt('_shared.guard-rails'),
  rawSystemPrompt,
  `## Expected output schema\n\nYour response MUST conform exactly to this structure:\n\n${schemaExample}`,
].join('\n\n');
```

**Pourquoi en dernier dans la composition :** Le schema example est le **dernier élément** du system prompt car il agit comme un "recall" final — le LLM voit la structure attendue juste avant de produire sa réponse, maximisant l'adhérence au format.

##### Interaction avec les exemples statiques existants

Les sections "Output format" dans chaque `.system.md` contiennent actuellement un exemple JSON **statique**. Avec l'injection dynamique, deux options :

| Option | Avantage | Inconvénient |
|--------|----------|--------------|
| **A. Garder les deux** (statique dans le prompt + dynamique injecté) | Redondance = renforcement. L'exemple statique donne le contexte sémantique (noms réalistes), le dynamique donne la structure exacte | Augmente le budget tokens (~200 tokens de plus par appel) |
| **B. Retirer les exemples statiques** des `.system.md` et ne garder que le dynamique | Élimine la source de drift. Réduit les tokens | Perd les noms de champs sémantiquement réalistes (ex: `"symbolName"`) |
| **C. Garder un exemple statique réduit** (juste les valeurs sémantiques, sans structure complète) + dynamique pour la structure | Meilleur des deux mondes | Plus complexe à maintenir |

**Décision architecturale : Option A** — garder les deux dans un premier temps. L'exemple statique dans le prompt est un guide sémantique ("voici ce que je m'attends à voir"), le dynamique est un contrat structurel ("voici le schema exact"). Si les métriques montrent que le taux de retry tombe sous 2%, on pourra évaluer le passage à l'option B pour économiser des tokens.

##### Bénéfices attendus

| Métrique | Avant | Après (estimé) |
|----------|-------|-----------------|
| Taux de retry Zod | ~10-15% (estimé) | < 3% |
| Coût moyen par fichier | 1.1x base (10% de doubles appels) | ~1.02x base |
| Sources de drift schema/prompt | Manuel — risque de divergence | Zéro — toujours synchronisé |

##### Tests

| Test | Validation |
|------|------------|
| `formatSchemaExample()` unit tests | Chaque schema axis produit un JSON valide qui passe `schema.safeParse()` |
| Round-trip test | `schema.safeParse(JSON.parse(formatSchemaExample(schema)))` réussit pour les 8 schemas |
| Integration test | Le system prompt composé contient la section "Expected output schema" |
| Token budget test | L'ajout de l'exemple ne dépasse pas +300 tokens par prompt |

##### Impact sur les fichiers existants

| Fichier | Modification |
|---------|-------------|
| `src/utils/schema-example.ts` | **NOUVEAU** — Utilitaire de génération d'exemple |
| `src/utils/schema-example.test.ts` | **NOUVEAU** — Tests unitaires + round-trip |
| `src/core/axis-evaluator.ts` | Injecter `formatSchemaExample(schema)` dans la composition du system prompt (~5 lignes) |
| `src/core/axes/*.ts` | Exporter le schema (si pas déjà exporté) pour accès depuis `axis-evaluator.ts` |

##### Contraintes

- L'utilitaire `generateSchemaExample()` doit supporter **tous les types Zod** utilisés dans les schemas existants : `ZodObject`, `ZodArray`, `ZodEnum`, `ZodNumber` (avec `.min()/.max()`), `ZodString` (avec `.min()`), `ZodOptional`, `ZodDefault`, `ZodNullable`, `ZodInt` (custom ou via coerce)
- Le JSON généré doit être **parseable** par `JSON.parse()` (les commentaires `//` sont dans la version formatée pour le prompt, pas dans le JSON brut de validation)
- La version injectée dans le prompt utilise les commentaires inline pour les enums, ce qui n'est pas du JSON valide — c'est intentionnel car le LLM comprend cette notation et ça lui montre toutes les options possibles

---

### Doc Identity Detection — Skip Double Chunking on Identical Trees

**Date :** 2026-03-26
**Scope :** RAG doc indexing optimization — avoid chunking `docs/` when it is byte-identical to `.anatoly/docs/`.

#### Problème

L'orchestrateur RAG ([orchestrator.ts:458-508](src/rag/orchestrator.ts#L458-L508)) indexe **deux hiérarchies de documentation séparément** :

1. **Phase `doc-project`** : `docs/` → `source: 'project'`
2. **Phase `doc-internal`** : `.anatoly/docs/` → `source: 'internal'`

Chaque phase exécute indépendamment : découverte des fichiers `.md`, calcul SHA-256, chunking Haiku sémantique (coûteux en tokens LLM), embedding NLP, upsert dans LanceDB.

**Scénario gaspillé** : après un premier run, l'utilisateur fait `docs sync` ou copie manuellement `.anatoly/docs/` → `docs/`. Les deux arbres sont 100% identiques. Le pipeline chunk et embed les mêmes contenus **deux fois** — double coût Haiku, double coût embedding, double temps.

**Cas typique** : l'utilisateur sans doc existante qui, en fin de premier run, accepte de copier la doc interne vers `docs/`. Au run suivant, les deux arbres sont byte-identical.

#### Décision

| Aspect | Décision | Rationale |
|--------|----------|-----------|
| Détection | Nouvelle fonction `areDocTreesIdentical(projectRoot, projectDocsDir, internalDocsDir)` | Compare SHA-256 par fichier entre les deux arbres. Coût : ~1ms pour 50 fichiers (I/O pur, zéro LLM) |
| Granularité | Comparaison **arbre complet** (all-or-nothing) | Simplité maximale. Pas de partial-match qui compliquerait le cache et l'alias. Si un seul fichier diffère → double indexation normale |
| Quand | Avant les phases `doc-project` / `doc-internal` dans l'orchestrateur | Intercepte le double-travail au plus tôt |
| Si identique | Skip `doc-project`, indexer uniquement `doc-internal`, puis alias `source: 'project'` dans le vector store | Un seul chunking Haiku, un seul embedding, puis duplication logique des entrées |
| Si différent | Comportement actuel inchangé (double indexation) | Zéro régression sur les projets avec docs divergentes |
| Cache | Un seul set de cache files (`cache_{suffix}-internal` + `doc_chunk_cache_{suffix}-internal`) | Pas de cache projet redondant quand identique |

#### Algorithme `areDocTreesIdentical()`

```
function areDocTreesIdentical(projectRoot, projectDocsDir, internalDocsDir):
  internalFiles = glob('**/*.md', internalDocsDir)  // relatifs à internalDocsDir
  projectFiles  = glob('**/*.md', projectDocsDir)   // relatifs à projectDocsDir

  // Même ensemble de fichiers (par chemin relatif) ?
  if (Set(internalFiles) ≠ Set(projectFiles)) return false

  // Même contenu par fichier ?
  for each relPath in internalFiles:
    shaInternal = SHA-256(read(internalDocsDir / relPath))
    shaProject  = SHA-256(read(projectDocsDir / relPath))
    if (shaInternal ≠ shaProject) return false

  return true
```

**Optimisation** : on compare d'abord les tailles de fichiers avant de hasher (court-circuit rapide sur les différences évidentes).

#### Alias Vector Store

Quand les arbres sont identiques :

1. Indexer `.anatoly/docs/` normalement (`source: 'internal'`)
2. Supprimer toutes les entrées existantes `source: 'project'` du vector store
3. Pour chaque section indexée avec `source: 'internal'`, insérer une copie avec :
   - `source: 'project'`
   - `id` : re-calculé avec le path `docs/` (via `buildDocSectionId()` existant)
   - Même `doc_vector`, `content`, `embedText`, `name`, `summary`

**Pourquoi dupliquer plutôt que pointer ?** Le code existant filtre systématiquement par `source` dans les requêtes vectorielles. Changer ce contrat impacterait toute la chaîne de review et de gap-detection. La duplication logique (même embedding, zéro recalcul) est le chemin le plus sûr.

#### Flow Modifié dans l'Orchestrateur

```
// orchestrator.ts — avant les phases doc

const identical = areDocTreesIdentical(projectRoot, options.docsDir, join('.anatoly', 'docs'));

if (identical) {
  onLog('rag: docs/ identical to .anatoly/docs/ — indexing internal only, aliasing project');

  // Phase unique : index internal
  onPhase?.('doc-internal');
  const intResult = await indexDocSections({ ..., docSource: 'internal' });

  // Alias : copier les entrées internal → project dans le vector store
  await store.aliasDocSource('internal', 'project', options.docsDir);

  // Stats
  internalDocSections = intResult.sections;
  projectDocSections = intResult.sections;  // même nombre (aliasé)
  projectDocsCached = intResult.cached;
  internalDocsCached = intResult.cached;

} else {
  // Comportement actuel inchangé
  onPhase?.('doc-project');
  // ... indexDocSections project ...
  onPhase?.('doc-internal');
  // ... indexDocSections internal ...
}
```

#### Nouvelle Méthode `VectorStore.aliasDocSource()`

```typescript
async aliasDocSource(
  fromSource: 'internal' | 'project',
  toSource: 'internal' | 'project',
  targetDocsDir: string,
): Promise<void> {
  // 1. Delete existing entries with toSource
  await this.deleteBySource(toSource);

  // 2. Read all entries with fromSource
  const entries = await this.getDocSectionsBySource(fromSource);

  // 3. Re-map: change source, recompute ID with target path
  const aliased = entries.map(entry => ({
    ...entry,
    source: toSource,
    id: buildDocSectionId(remapPath(entry.filePath, targetDocsDir)),
  }));

  // 4. Upsert aliased entries (same vectors, zero recalculation)
  await this.upsertDocSections(aliased);
}
```

#### Invalidation

| Événement | Détection | Action |
|-----------|-----------|--------|
| Utilisateur modifie un fichier dans `docs/` | `areDocTreesIdentical()` retourne `false` au run suivant | Retour au double indexation normal |
| `docs sync` écrase `docs/` avec `.anatoly/docs/` | `areDocTreesIdentical()` retourne `true` | Alias mode |
| Fichier ajouté/supprimé dans un seul arbre | Set de fichiers diffère → `false` | Double indexation |
| `.anatoly/docs/` régénéré (scaffold/generate) | SHA internes changent, potentiellement ≠ `docs/` | Détection automatique |

#### Fichiers Impactés

| Fichier | Modification |
|---------|-------------|
| `src/rag/orchestrator.ts` | Appel `areDocTreesIdentical()` avant les phases doc, branchement conditionnel |
| `src/rag/doc-indexer.ts` | **Export** `areDocTreesIdentical()` — nouvelle fonction (~30 lignes) |
| `src/rag/vector-store.ts` | **Nouvelle méthode** `aliasDocSource()` + helpers `deleteBySource()`, `getDocSectionsBySource()` |
| `src/rag/types.ts` | Aucun changement (le champ `source` existe déjà) |

#### Économie Estimée

| Métrique | Sans optimisation | Avec optimisation (arbres identiques) |
|----------|-------------------|---------------------------------------|
| Appels Haiku (chunking) | 2N (N = fichiers doc changés) | N |
| Appels embedding NLP | 2S (S = sections) | S |
| Temps phase doc | T_project + T_internal | T_internal + ~50ms (alias) |
| Tokens Haiku consommés | 2× | 1× |

Pour un projet typique avec 30 fichiers doc et 120 sections, l'économie sur un premier indexing post-sync est de **~50% des tokens Haiku doc** et **~50% du temps d'embedding doc**.

#### Tests

| Test | Validation |
|------|------------|
| `areDocTreesIdentical()` unit test — arbres identiques | Retourne `true`, hash comparés |
| `areDocTreesIdentical()` unit test — un fichier diffère | Retourne `false` |
| `areDocTreesIdentical()` unit test — fichier manquant d'un côté | Retourne `false` |
| `areDocTreesIdentical()` unit test — arbre vide des deux côtés | Retourne `true` (pas de docs = identique) |
| `aliasDocSource()` integration test | Après alias, query par `source: 'project'` retourne les mêmes sections que `source: 'internal'` |
| Orchestrator E2E — docs identiques | Un seul chunking, stats correctes, vector store contient les deux sources |
| Orchestrator E2E — docs divergentes | Double indexation normale, pas d'alias |

## Multi-Provider LLM Transport (Intégration Gemini)

### Contexte et Motivation

Sur un projet de 200 fichiers, Anatoly consomme ~860 requêtes Claude Code Max par run (7 axes × ~100 fichiers évalués + ~60 délibérations Opus). Le quota horaire est atteint à mi-run, déclenchant des `RateLimitStandbyError` de 5-10 min.

**Solution :** Introduire un second transport LLM basé sur `@google/gemini-cli-core`, authentifié via le compte Google de l'utilisateur (abonnement Gemini Code Assist). Les axes mécaniques sont routés vers Gemini Flash, les axes qualitatifs vers Gemini Pro. La délibération Opus reste exclusivement sur Claude.

**Résultat attendu : −58% quota Claude Code Max par run.**

### Choix du package : `@google/gemini-cli-core`

**Contexte :** `@google/gemini-cli-sdk` offrirait une API plus propre (`GeminiCliAgent` → `session()` → `sendStream()`), mais il **n'est pas publié sur npm** (version `0.36.0-nightly` uniquement dans le monorepo). `@google/gemini-cli-core` est le seul package publié et installable.

**Spike validé (2026-03-27) :** L'API `GeminiClient.sendMessageStream()` de core fonctionne pour notre use case single-turn.

| Aspect | Décision | Rationale |
|---|---|---|
| Package | `@google/gemini-cli-core` | Seul package publié sur npm — le SDK n'est pas encore disponible |
| API | `Config` → `geminiClient` → `sendMessageStream()` | Validé par spike — fonctionne en single-turn sans agent loop |
| Auth | `Config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE)` | OAuth cached du `gemini` CLI, billing Gemini Code Assist |
| Migration future | Si `@google/gemini-cli-sdk` est publié → migrer `gemini-transport.ts` uniquement | Wrapper isolé = un seul fichier à changer |

**API effective pour Anatoly (validée par spike) :**

```ts
import { Config, AuthType, getAuthTypeFromEnv, createSessionId } from '@google/gemini-cli-core';

// Init (une fois au démarrage du run)
const config = new Config({
  sessionId: createSessionId(),
  targetDir: projectRoot,
  cwd: projectRoot,
  debugMode: false,
  model: 'gemini-2.5-flash',
  userMemory: '',
  enableHooks: false,
  mcpEnabled: false,
  extensionsEnabled: false,
  skillsSupport: false,
  adminSkillsEnabled: false,
});
const authType = getAuthTypeFromEnv() || AuthType.LOGIN_WITH_GOOGLE;
await config.refreshAuth(authType);
await config.initialize();

// Query (par appel)
const client = config.geminiClient;
client.resetChat();                        // isolation — pas d'historique
client.getChat().setSystemInstruction(systemPrompt);

const stream = await client.sendMessageStream(
  [{ text: userMessage }],
  abortController.signal,
  createSessionId(),
);

let text = '';
let usageMetadata = null;
for await (const event of stream) {
  if (event.type === 'content') text += typeof event.value === 'string' ? event.value : '';
  if (event.type === 'finished') usageMetadata = event.value?.usageMetadata;
}
```

**Stream event types (validés par spike) :**

| Event type | Contenu | Usage Anatoly |
|---|---|---|
| `model_info` | Nom du modèle réellement utilisé (string) | Log diagnostique |
| `thought` | Traces de raisonnement (thinking) | Ignoré — pas utile pour single-turn |
| `content` | Texte de la réponse (string) | Assemblé dans `text` |
| `finished` | `{ reason, usageMetadata }` | Token counts extraits ici |

**`usageMetadata` (validé par spike) :**

```ts
{
  promptTokenCount: number;       // → LlmResponse.inputTokens
  candidatesTokenCount: number;   // → LlmResponse.outputTokens
  totalTokenCount: number;        // somme incluant thoughts
  thoughtsTokenCount: number;     // tokens de raisonnement (non facturés)
  trafficType: string;            // 'ON_DEMAND' = billing subscription
  promptTokensDetails: Array<{ modality: string; tokenCount: number }>;
  candidatesTokensDetails: Array<{ modality: string; tokenCount: number }>;
}
```

**Caveat spike — ~4800 tokens de prompt overhead :** Le `Config` injecte automatiquement le contexte projet (GEMINI.md, structure de fichiers) dans chaque appel. Pour un prompt trivial ("Say OK"), le `promptTokenCount` est ~4800. Ce overhead est constant et acceptable pour nos prompts d'axes (qui font déjà 2000-5000 tokens de system prompt).

### Allocation cible par axe

| Axe | Provider actuel | Nouveau provider | Modèle Gemini | Justification |
|---|---|---|---|---|
| `utility` | Haiku | **Gemini** | Flash | Décision binaire USED/DEAD, usage graph pré-injecté |
| `duplication` | Haiku | **Gemini** | Flash | RAG pré-résolu, comparaison de similarité mécanique |
| `overengineering` | Sonnet | **Gemini** | Flash | Jugement binaire, délibération rattrape en aval |
| `tests` | Sonnet | **Gemini** | Pro | Analyse qualitative, Pro comparable à Sonnet |
| `documentation` | Sonnet | **Gemini** | Pro | Sémantique JSDoc, Pro tient la qualité |
| `best_practices` | Sonnet | **Claude** | — | 17 règles framework-aware, risque trop élevé |
| `correction` | Sonnet | **Claude** | — | ERRORs à 95%, hallucination Pro ~85% incompatible |
| `deliberation` | Opus | **Claude** | — | Jamais — protection ERRORs non-négociable |
| `doc_generation` | Sonnet | **Claude** | — | Mode agent avec file tools, incompatible transport single-turn |
| `doc_coherence` | Sonnet | **Claude** | — | Jugement structurel global |
| `doc_content` | Opus | **Claude** | — | Qualité maximale requise |

> **Note :** `semantic_chunking` (doc) n'apparaît pas dans cette table. Le chunking des docs est désormais assuré par `smartChunkDoc()` — un chunker purement programmatique (H2/H3 + split paragraphes), zéro appel LLM. L'ancien `chunkDocWithHaiku()` n'est plus qu'un fallback rare (cache miss + `chunkModel` explicitement configuré). Le routing Gemini ne s'applique pas ici.

### Abstraction du transport

| Aspect | Décision | Rationale |
|---|---|---|
| Interface | `LlmTransport` — `supports(model) + query(params)` | Abstraction minimale, un seul point d'extension par provider |
| Couche transport | I/O pur — envoie un prompt, reçoit du texte | La validation Zod, l'extraction JSON, et le retry restent dans `runSingleTurnQuery()` |
| Résolution provider | `TransportRouter.resolve(model)` — le nom du modèle détermine le transport | Pas de champ `provider` explicite — `gemini-*` → Gemini, sinon → Anthropic |
| `resolveAxisModel()` | Retourne toujours `string` (ex: `'gemini-2.5-flash'`) | Le router infère le provider du nom. Zéro breaking change sur la signature existante |
| Transcript | Chaque transport produit un `transcript: string` | Nécessaire pour les conversation dumps (`.transcript.md`) |

**Interface `LlmTransport` :**

```ts
export interface LlmRequest {
  systemPrompt: string;
  userMessage: string;
  model: string;
  projectRoot: string;
  abortController: AbortController;
  conversationDir?: string;
  conversationPrefix?: string;
  semaphore?: Semaphore;        // Semaphore du provider (pas partagé)
}

export interface LlmResponse {
  text: string;
  costUsd: number;              // 0 pour Gemini (subscription)
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  transcript: string;           // Conversation dump (prompt + response)
  sessionId: string;
}

export interface LlmTransport {
  readonly provider: 'anthropic' | 'gemini';
  supports(model: string): boolean;
  query(params: LlmRequest): Promise<LlmResponse>;
}
```

**Modification de `runSingleTurnQuery()` :**

```ts
export async function runSingleTurnQuery<T>(
  params: SingleTurnQueryParams,
  schema: z.ZodType<T>,
  transport?: LlmTransport,     // ← nouveau paramètre optionnel
): Promise<SingleTurnQueryResult<T>> {
  // 1. Acquérir le semaphore du transport (pas le global)
  // 2. Appeler transport.query() ou execQuery() existant si pas de transport
  // 3. Extraire JSON + valider Zod + retry si échec (logique existante inchangée)
}
```

### Transport Anthropic (`anthropic-transport.ts`)

Wrap du code existant dans `execQuery()`. Aucun changement fonctionnel — extraction pure vers la nouvelle interface.

### Transport Gemini (`gemini-transport.ts`)

| Aspect | Décision | Rationale |
|---|---|---|
| Package | `@google/gemini-cli-core` (version épinglée) | Seul package publié sur npm. Auth Google OAuth + billing Gemini Code Assist, zéro API key |
| API | `Config` → `geminiClient` → `sendMessageStream()` | Validé par spike 2026-03-27 |
| Isolation | Tout le code Gemini dans `src/core/transports/gemini-transport.ts` | Breaking changes du package = un seul fichier à modifier |
| Auth | `Config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE)` via `getAuthTypeFromEnv()` | Réutilise les credentials cached du `gemini` CLI |
| Token counts | `usageMetadata` sur l'event `finished` : `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount` | Validé par spike — données complètes et fiables |
| Cache tokens | `cacheReadTokens: 0, cacheCreationTokens: 0` (Phase 1) | Gemini context caching fonctionne différemment — optimisation Phase 2 |
| Coût | `costUsd: 0` (subscription Gemini Code Assist) | `trafficType: 'ON_DEMAND'` confirmé par spike |
| Instanciation | Un `Config` par modèle au démarrage, `resetChat()` entre chaque appel | Évite l'accumulation d'historique (validé par spike : ratio tokens 1.00) |

**Implémentation cible (basée sur le spike validé) :**

```ts
import { Config, AuthType, getAuthTypeFromEnv, createSessionId } from '@google/gemini-cli-core';

export class GeminiTransport implements LlmTransport {
  readonly provider = 'gemini';
  private config: InstanceType<typeof Config> | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(private projectRoot: string, private model: string) {}

  supports(model: string): boolean {
    return model.startsWith('gemini-');
  }

  private async ensureInit(): Promise<InstanceType<typeof Config>> {
    if (this.config) return this.config;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.config = new Config({
          sessionId: createSessionId(),
          targetDir: this.projectRoot,
          cwd: this.projectRoot,
          debugMode: false,
          model: this.model,
          userMemory: '',
          enableHooks: false,
          mcpEnabled: false,
          extensionsEnabled: false,
          skillsSupport: false,
          adminSkillsEnabled: false,
        });
        const authType = getAuthTypeFromEnv() || AuthType.LOGIN_WITH_GOOGLE;
        await this.config.refreshAuth(authType);
        await this.config.initialize();
      })();
    }
    await this.initPromise;
    return this.config!;
  }

  async query(params: LlmRequest): Promise<LlmResponse> {
    const config = await this.ensureInit();
    const client = config.geminiClient;
    const start = Date.now();

    // Isolation : reset chat pour éviter l'accumulation d'historique
    client.resetChat();
    client.getChat().setSystemInstruction(params.systemPrompt);

    const stream = await client.sendMessageStream(
      [{ text: params.userMessage }],
      params.abortController.signal,
      createSessionId(),
    );

    let text = '';
    let usageMetadata: Record<string, unknown> | null = null;

    for await (const event of stream) {
      if (event.type === 'content') {
        text += typeof event.value === 'string' ? event.value : '';
      }
      if (event.type === 'finished') {
        usageMetadata = event.value?.usageMetadata ?? null;
      }
    }

    return {
      text,
      costUsd: 0,
      durationMs: Date.now() - start,
      inputTokens: (usageMetadata?.promptTokenCount as number) ?? 0,
      outputTokens: (usageMetadata?.candidatesTokenCount as number) ?? 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      transcript: `## System\n${params.systemPrompt}\n\n## User\n${params.userMessage}\n\n## Response\n${text}`,
      sessionId: '',
    };
  }
}
```

**Risque principal :** `@google/gemini-cli-core` est un package interne du monorepo Gemini CLI. L'API peut évoluer. Mitigation : version épinglée + wrapper isolé dans 1 fichier + test d'intégration.

### Router de transport (`transport-router.ts`)

```ts
export class TransportRouter {
  private transports: LlmTransport[];

  constructor(transports: LlmTransport[]) {
    this.transports = transports;
  }

  resolve(model: string): LlmTransport {
    const transport = this.transports.find(t => t.supports(model));
    if (!transport) throw new Error(`No transport for model: ${model}`);
    return transport;
  }
}
```

Le router est instancié une fois au démarrage du pipeline et passé aux évaluateurs.

### Concurrence — Semaphores séparés

| Aspect | Décision | Rationale |
|---|---|---|
| Semaphore Claude | `sdk_concurrency` existant (default: 24) | Inchangé |
| Semaphore Gemini | Nouveau `gemini_sdk_concurrency` (default: 12) | Gemini et Claude ont des limites de concurrence différentes |
| Isolation | Chaque transport a son propre semaphore | Évite qu'un rate limit Claude throttle les appels Gemini et vice-versa |

### Circuit Breaker (pas fallback par appel)

| Aspect | Décision | Rationale |
|---|---|---|
| Pattern | Circuit breaker avec seuil de 3 échecs consécutifs | Évite de tenter 498 appels Gemini après un premier 429 |
| Cooldown | 5 minutes après trip du circuit breaker | Laisse le temps au quota de se rafraîchir |
| Fallback | Bascule automatique vers Claude pour les axes Gemini restants | Le run continue sans interruption |
| Notification | Warning CLI unique : `⚠ Gemini quota exhausted — falling back to Claude` | L'utilisateur sait que son quota Claude est consommé |
| Retry existant | `retryWithBackoff()` wraps le `transport.query()` | Pas de système de retry parallèle — réutilise l'existant |

### Routing par axe — `defaultGeminiMode` sur l'évaluateur

Le routing est défini dans l'évaluateur lui-même via un nouveau champ optionnel :

```ts
interface AxisEvaluator {
  readonly id: AxisId;
  readonly defaultModel: 'sonnet' | 'haiku';
  readonly defaultGeminiMode?: 'flash' | 'pro';  // ← nouveau champ
  evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult>;
}
```

- `defaultGeminiMode: 'flash'` → utility, duplication, overengineering
- `defaultGeminiMode: 'pro'` → tests, documentation
- `defaultGeminiMode: undefined` → correction, best_practices (toujours Claude)

**Avantage :** Ajouter un nouvel axe est self-contained — le routing Gemini est déclaré dans l'évaluateur, pas dans le config schema. Pas de `GeminiAxesConfigSchema` avec axes hardcodés.

**Modification de `resolveAxisModel()` :**

```ts
export function resolveAxisModel(evaluator: AxisEvaluator, config: Config): string {
  // 1. Override explicite par axe (config.llm.axes[axis].model) → retourner tel quel
  const axisOverride = config.llm.axes?.[evaluator.id]?.model;
  if (axisOverride) return axisOverride;

  // 2. Si gemini.enabled ET defaultGeminiMode défini :
  const geminiCfg = config.llm.gemini;
  if (geminiCfg?.enabled && evaluator.defaultGeminiMode) {
    if (evaluator.defaultGeminiMode === 'flash') return geminiCfg.flash_model;
    if (evaluator.defaultGeminiMode === 'pro') return geminiCfg.pro_model;
  }

  // 3. Comportement actuel (haiku → fast_model/index_model, sinon → model)
  return evaluator.defaultModel === 'haiku'
    ? (config.llm.fast_model ?? config.llm.index_model)
    : config.llm.model;
}
```

### Configuration `.anatoly.yml`

```yaml
llm:
  # Config existante inchangée
  model: claude-sonnet-4-6
  index_model: claude-haiku-4-5
  deliberation_model: claude-opus-4-6

  # Nouveau bloc Gemini
  gemini:
    enabled: false                    # opt-in explicite
    flash_model: gemini-2.5-flash
    pro_model: gemini-2.5-pro
    sdk_concurrency: 12              # semaphore dédié Gemini
```

**Schema Zod — `src/schemas/config.ts` :**

```ts
const GeminiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  flash_model: z.string().default('gemini-2.5-flash'),
  pro_model: z.string().default('gemini-2.5-pro'),
  sdk_concurrency: z.int().min(1).max(32).default(12),
}).optional();

// Dans LlmConfigSchema existant :
// gemini: GeminiConfigSchema,
```

### Auth et Initialisation

| Aspect | Décision | Rationale |
|---|---|---|
| Vérification | Au démarrage si `gemini.enabled: true`, tenter une initialisation SDK | Fail-fast si auth absente |
| Échec auth | Warning non-bloquant + désactivation Gemini pour le run | Le run continue sur Claude uniquement |
| Message | `⚠ Gemini activé mais auth Google introuvable. Exécutez gemini une fois. Fallback Claude.` | Actionnable |
| CI | `gemini.enabled: false` par défaut | Pas de dépendance auth en CI |

```ts
// src/utils/gemini-auth.ts
export async function checkGeminiAuth(projectRoot: string): Promise<boolean> {
  try {
    const { Config, AuthType, getAuthTypeFromEnv, createSessionId } = await import('@google/gemini-cli-core');
    const config = new Config({
      sessionId: createSessionId(),
      targetDir: projectRoot,
      cwd: projectRoot,
      debugMode: false,
      model: 'gemini-2.5-flash',
      userMemory: '',
      enableHooks: false,
      mcpEnabled: false,
      extensionsEnabled: false,
      skillsSupport: false,
      adminSkillsEnabled: false,
    });
    const authType = getAuthTypeFromEnv() || AuthType.LOGIN_WITH_GOOGLE;
    await config.refreshAuth(authType);
    await config.initialize();
    return true;
  } catch {
    return false;
  }
}
```

### Semantic Chunking (doc-indexer) — Hors périmètre

Le chunking des docs est désormais assuré par `smartChunkDoc()` — un chunker purement programmatique (H2/H3 + split paragraphes sur `SMART_SPLIT_THRESHOLD`), zéro appel LLM. Le flow dans `run.ts` :

1. **`smartChunkAndCache()`** — pré-chunk synchrone, résultats en cache (gratuit)
2. **`indexDocSections()`** — réutilise le chunk cache ; `chunkDocWithHaiku()` n'est appelé qu'en fallback rare (cache miss + `chunkModel` explicitement configuré)

**Pas de routing Gemini nécessaire pour le chunking.** Le coût LLM du chunking doc est déjà quasi-nul.

### Commande `anatoly providers`

Nouvelle commande CLI pour vérifier la connectivité et l'état de chaque provider configuré.

| Aspect | Décision | Rationale |
|---|---|---|
| Nom | `anatoly providers` | Cohérent avec `anatoly status`, `anatoly rag-status` |
| Fonctionnement | Envoie un ping minimal (prompt trivial `"Respond OK"`) à chaque provider/modèle actif | Confirme auth + connectivité + modèle disponible |
| Output | Tableau : provider, modèle, statut (✓/✗), latence, auth method | Diagnostic rapide |
| Provider Claude | Test via `AnthropicTransport.query()` sur chaque modèle configuré | Vérifie API key + connectivité |
| Provider Gemini | Test via `GeminiTransport.query()` sur `flash_model` et `pro_model` | Vérifie auth Google + billing |
| Flag `--json` | Output JSON pour scripting/CI | Cohérent avec les autres commandes |
| Erreur partielle | Un provider en échec n'empêche pas le test des autres | Diagnostic complet même si un provider est down |

**Output exemple :**

```
  Providers

  Provider   Model               Status   Latency   Auth
  Claude     claude-haiku-4-5    ✓        1.2s      API Key (ANTHROPIC_API_KEY)
  Claude     claude-sonnet-4-6   ✓        2.1s      API Key
  Claude     claude-opus-4-6     ✓        3.4s      API Key
  Gemini     gemini-2.5-flash    ✓        0.8s      Google OAuth
  Gemini     gemini-2.5-pro      ✓        1.9s      Google OAuth
```

**Output JSON (`--json`) :**

```json
{
  "providers": [
    { "provider": "anthropic", "model": "claude-haiku-4-5", "status": "ok", "latencyMs": 1234, "auth": "api_key" },
    { "provider": "gemini", "model": "gemini-2.5-flash", "status": "ok", "latencyMs": 812, "auth": "google_oauth" },
    { "provider": "gemini", "model": "gemini-2.5-pro", "status": "error", "error": "RESOURCE_EXHAUSTED", "auth": "google_oauth" }
  ]
}
```

**Fichier :** `src/commands/providers.ts` + registration dans `src/cli.ts`

### Observabilité

**Logs structurés :** Étendre les événements `llm_call` existants avec le champ `provider` :

```ts
contextLogger().info({
  event: 'llm_call',
  provider: 'gemini',          // nouveau champ
  model: params.model,
  axis: axisId,
  costUsd: 0,
  durationMs,
  inputTokens,
  outputTokens,
  success: true,
}, 'LLM call complete');
```

**`run-metrics.json` :** Ajouter la ventilation par provider :

```json
{
  "providers": {
    "anthropic": { "calls": 362, "axes": ["correction", "best_practices", "deliberation"] },
    "gemini":    { "calls": 498, "axes": ["utility", "duplication", "overengineering", "tests", "documentation"] }
  },
  "claude_quota_saved_pct": 58
}
```

**Affichage CLI fin de run :**

```
  Cost:    $0.42 in API calls (Claude) · $0.00 with Gemini Code Assist
  Quota:   362 Claude Code calls · 498 Gemini calls (−58% Claude quota)
```

### Plan d'Implémentation

| Phase | Scope | Détail |
|---|---|---|
| **0 — Spike** | ~~Valider l'API~~ **DONE** | Spike exécuté 2026-03-27. `GeminiClient.sendMessageStream()` validé : event types (`content`, `finished`), `usageMetadata` OK, `resetChat()` pour isolation, ~4800 tokens overhead Config. `@google/gemini-cli-core` installé (SDK non publié sur npm). |
| **1 — Interface** | `LlmTransport` + `AnthropicTransport` | Zéro changement fonctionnel — extraction pure du code existant dans `execQuery()` vers la nouvelle interface |
| **2 — Plumbing** | `TransportRouter` + config schema + `resolveAxisModel()` | Toujours pas d'appels Gemini — juste le routing et la config |
| **3 — Gemini** | `GeminiTransport` + auth check + circuit breaker + semaphore dédié | Premiers vrais appels Gemini |
| **4 — Providers** | Commande `anatoly providers` | Diagnostic de connectivité multi-provider |
| **5 — Observabilité** | Logs `provider`, metrics breakdown, affichage CLI | Ventilation par provider dans les métriques |
| **6 — Validation** | Gold-set Gemini vs Claude + test fallback | Gate pour production — comparer les résultats sur un échantillon |

### Impact sur la Structure Projet

```
src/
├── core/
│   ├── transports/              # [NOUVEAU]
│   │   ├── index.ts             # LlmTransport, LlmRequest, LlmResponse, TransportRouter
│   │   ├── anthropic-transport.ts  # Wrap de execQuery() existant
│   │   └── gemini-transport.ts  # Wrap de Config.geminiClient.sendMessageStream()
│   ├── axis-evaluator.ts        # [MODIFIÉ] transport optionnel dans runSingleTurnQuery
│   ├── file-evaluator.ts        # [MODIFIÉ] instancie et passe les transports
│   └── circuit-breaker.ts       # [NOUVEAU] GeminiCircuitBreaker
├── commands/
│   ├── providers.ts             # [NOUVEAU] anatoly providers
│   └── run.ts                   # [MODIFIÉ] metrics breakdown par provider
├── schemas/
│   └── config.ts                # [MODIFIÉ] GeminiConfigSchema ajouté à LlmConfigSchema
└── utils/
    └── gemini-auth.ts           # [NOUVEAU] checkGeminiAuth()
```

**Hiérarchie de dépendance mise à jour :**

```
schemas/          ← ne dépend de rien
utils/            ← dépend de schemas/
rag/              ← dépend de schemas/ et utils/
core/transports/  ← dépend de utils/ (semaphore, rate-limiter)
core/             ← dépend de schemas/, utils/, rag/, core/transports/
commands/         ← dépend de core/, rag/, schemas/, utils/
```

### Dépendances npm

```json
{
  "devDependencies": {
    "@google/gemini-cli-core": "0.36.x"
  }
}
```

> **Note :** `@google/gemini-cli-core` est un package interne du monorepo Gemini CLI. L'API n'est pas garantie stable. Épingler la version exacte et auditer les breaking changes à chaque mise à jour. Si `@google/gemini-cli-sdk` est publié sur npm à l'avenir, migrer vers celui-ci — le wrapper isolé dans `gemini-transport.ts` rend la migration triviale.

### Non-périmètre

- **`correction` et `best_practices`** : exclus du routing Gemini — taux d'hallucination incompatible avec les seuils de qualité requis
- **`deliberation`** : toujours Opus Anthropic — contrainte non-négociable
- **`doc_generation`** : mode agent avec file tools, incompatible avec le transport single-turn
- **`semantic_chunking`** : hors périmètre — `smartChunkDoc()` est purement programmatique, zéro LLM
- **`@google/genai` (API key)** : explicitement exclu — objectif billing abonnement uniquement, zéro API key
- **Gemini context caching** : Phase 2, pas dans le scope initial
- **Ralph auto-clean** : nécessiterait un SDK agent Gemini stable

### Risques et Mitigations

| Risque | Probabilité | Mitigation |
|---|---|---|
| API `@google/gemini-cli-core` évolue (breaking) | Haute | Version épinglée, wrapper isolé dans 1 fichier, migration vers SDK quand publié |
| Auth Google non disponible en CI | Haute | `gemini.enabled: false` par défaut, opt-in explicite |
| Taux hallucination Gemini sur `tests`/`documentation` | Moyen | Délibération Opus rattrape en aval ; gold-set de validation en Phase 6 |
| Quota Gemini Code Assist insuffisant | Faible | Circuit breaker + fallback automatique vers Claude |
| Token counts non extractibles depuis `StreamEvent` | **Résolu** | Spike validé : `usageMetadata` disponible sur event `finished` |
| `sendStream()` boucle sur des tool calls internes | Faible | SDK configuré sans tools (`tools: []` omis = pas de tools) |

## 3-Tier Deliberation Refinement

### Context & Problem Statement

The current deliberation model runs Opus single-turn JSON per file (116 calls/run, $63/run, 178 min serial). Analysis of run `2026-03-27_192337` revealed:

- **86% of reclassifications are trivially deterministic** (DEAD→USED when usage graph says USED, UNDOCUMENTED→DOCUMENTED when JSDoc exists)
- **Opus cannot verify claims** — single-turn with no tools means it reasons in a vacuum (incident: FIX-017 CODE_DIM 3584→768 applied without verifying GGUF output)
- **No cross-file visibility** — same false positive pattern reclassified 15+ times independently
- **$40.74/run in output tokens** — Opus generates ~4.7K tokens per file, 80% confirming obvious verdicts

### Decision: Replace per-file Opus deliberation with 3-tier post-merge refinement

The review phase writes raw `ReviewFile` JSON/MD per file **without deliberation**. A new **Refinement phase** processes all files after the review phase completes.

### Architecture

```
Review phase (unchanged)
  7 axes per file → merge → write review JSON + MD (no deliberation)
  ↓
Refinement phase (NEW)
  Tier 1: Deterministic auto-resolve     → update JSON/MD in place
  Tier 2: Inter-axis coherence (Flash)   → update JSON/MD in place
  Tier 3: Agentic investigation (Opus)   → update JSON/MD + deliberation-memory.json
  ↓
Report phase (unchanged)
  Read final JSONs → generate report
```

### Tier 1 — Deterministic auto-resolve (code, 0 tokens, 0 cost)

Resolve findings using structured data already available (usage graph, AST, RAG index, coverage report). No LLM involved.

| Axis | Finding | Resolution | Data source |
|------|---------|-----------|-------------|
| utility | DEAD (exported + importers > 0) | → USED | usage graph |
| utility | DEAD (exported + type-only importers > 0) | → USED | usage graph |
| utility | DEAD (exported + transitive usage) | → USED | usage graph |
| utility | DEAD (z.infer / type alias of used parent) | → USED | AST |
| utility | any finding on gold-set/fixture file | → skip | path pattern |
| duplication | DUPLICATE (no RAG candidates) | → UNIQUE | RAG index |
| duplication | DUPLICATE (function ≤ 2 lines) | → UNIQUE | AST |
| overengineering | OVER (function ≤ 5 lines) | → LEAN | AST |
| overengineering | OVER (kind = interface/type/enum) | → LEAN | AST (symbol kind) |
| tests | GOOD (coverage ≥ 80% on symbol lines) | → GOOD | coverage JSON |
| tests | NONE (no test file exists) | → NONE (confirmed) | file system |
| documentation | DOCUMENTED (JSDoc block exists, > 20 chars) | → DOCUMENTED | AST |
| documentation | UNDOCUMENTED (no JSDoc block, exported) | → UNDOCUMENTED (confirmed) | AST |
| documentation | DOCUMENTED (type/interface/enum, ≤ 5 fields, self-descriptive) | → DOCUMENTED | AST |

**Estimated coverage:** 40-50% of all findings resolved.

**Implementation:** Pure TypeScript function `applyTier1(review: ReviewFile, ctx: Tier1Context): ReviewFile` where `Tier1Context` provides usage graph, AST metadata, coverage data, and RAG index.

### Tier 2 — Inter-axis coherence check (Flash Lite, ~$0.02/run)

Single-turn Gemini Flash Lite call per file. Receives **only the ReviewFile JSON** (no source code). Detects logical contradictions between axes.

| Pattern | Resolution | Reasoning |
|---------|-----------|-----------|
| DEAD + NEEDS_FIX | correction → skip | No point fixing dead code |
| DEAD + OVER | overengineering → skip | No point evaluating complexity of dead code |
| DEAD + DUPLICATE | duplication → skip | No point deduplicating dead code |
| DEAD + tests WEAK/NONE | tests → skip | No tests needed for dead code |
| DEAD + doc UNDOCUMENTED | documentation → skip | No docs needed for dead code |
| OVER on interface/type/enum | → LEAN | Types cannot be over-engineered |
| tests NONE + non-exported + < 10 lines | → skip | Trivial helper, transitive coverage |
| doc UNDOCUMENTED + non-exported + < 5 lines | → skip | Private trivial helper |
| NEEDS_FIX confidence < 75 + no other findings | → skip | Weak isolated finding |

**Input:** ReviewFile JSON (~500 tokens/file)
**Output:** Resolutions + escalations to tier 3 (~100 tokens/file)
**Cost:** 120 files × 600 tokens × Flash Lite pricing = ~$0.02/run

**What tier 2 does NOT do:**
- Read source code
- Verify factual correctness of findings
- Reclassify high-confidence findings
- Touch correction ERROR findings (always → tier 3)

### Tier 3 — Agentic investigation (Opus, ~$10-15/run)

Full-agentic Opus agent via Claude Code SDK with tool access. Receives **only the list of unresolved findings** — no source code, no prompting. Must investigate each claim independently.

**Tools available:** `Read`, `Grep`, `Glob`, `Bash` (read-only)
**Tools forbidden:** `Write`, `Edit` (investigation only, no modifications)
**Max turns:** 100 (bounded to prevent runaway)

**Input:** Findings grouped by shard (10-20 files per shard, grouped by module/directory)

```json
{
  "shard": "src/core/",
  "findings": [
    { "file": "scanner.ts", "symbol": "scanDir", "axis": "correction", "verdict": "NEEDS_FIX", "confidence": 72, "detail": "readdirSync not wrapped in try-catch" },
    { "file": "circuit-breaker.ts", "symbol": "resolveModel", "axis": "correction", "verdict": "NEEDS_FIX", "confidence": 85, "detail": "..." }
  ]
}
```

The agent must:
1. Read the actual source file to verify each claim
2. Grep for usages when checking DEAD/DUPLICATE claims
3. Check configs, schemas, runtime values when claims involve constants
4. Produce a structured deliberation output per shard

**Output:** Updated verdicts + reasoning + deliberation-memory entries

**Key principle:** The agent cannot rubber-stamp. It receives claims, not evidence. It must do the investigation work itself.

**What triggers tier 3:**
- correction NEEDS_FIX (any confidence)
- correction ERROR (always)
- Findings explicitly escalated by tier 2
- Cross-file patterns detected by tier 2 (e.g., "15 DEAD symbols in same module")

**Estimated volume:** 20-40 findings per run (after tier 1+2 filtering)
**Estimated cost:** 20-40 findings × 5 turns × ~$0.15/turn = $10-15/run

### Deliberation Memory

`deliberation-memory.json` is updated **only by tier 3**. Tiers 1 and 2 correct mechanical errors, not judgment calls worth memorizing.

Tier 3 writes reclassification entries that persist across runs, preventing the same false positive from being re-investigated.

### Cost & Performance Comparison

| Metric | Current (per-file Opus) | Proposed (3-tier) | Delta |
|--------|------------------------|-------------------|-------|
| Cost | $62.96/run | ~$15/run | **-$48 (-76%)** |
| Wall-clock | ~44 min (parallel) | ~18 min (tier 3 sequential) | **-26 min** |
| Serial time | 178 min | 18 min | **-160 min** |
| FP detection rate | ~30% (reasoning only) | ~80%+ (investigation) | **+++** |
| Output tokens | 543K (Opus) | ~90K (tier 3 only) | **-83%** |

### Data Flow

```
ReviewFile JSON (post-merge, pre-refinement)
  ↓
tier1_refine(review, usageGraph, ast, coverage, ragIndex)
  → ReviewFile with mechanical corrections
  ↓
tier2_coherence(review)  // Flash Lite single-turn
  → ReviewFile with contradiction resolutions
  → List<EscalatedFinding> for tier 3
  ↓
tier3_investigate(shardFindings)  // Opus agentic
  → ReviewFile updates
  → deliberation-memory.json entries
  ↓
ReviewFile JSON (final, used by report phase)
```

### Impact on Existing Components

| Component | Change |
|-----------|--------|
| `file-evaluator.ts` | Remove deliberation call from `evaluateFile()`. Return raw merged review. |
| `deliberation.ts` | Deprecate `buildDeliberationUserMessage`, `needsDeliberation`. Keep `applyDeliberation` for tier 3 output application. |
| `run.ts` | Add refinement phase between review and report phases. Wire tier 1/2/3. |
| `correction-memory.ts` | `recordReclassification` called only from tier 3 agent output parser. |
| `pipeline-state.ts` | Add refinement phase tasks (tier-1, tier-2, tier-3). |
| `screen-renderer.ts` | Display refinement progress. |

**New files:**

| File | Purpose |
|------|---------|
| `src/core/refinement/tier1.ts` | Deterministic auto-resolve logic |
| `src/core/refinement/tier2.ts` | Flash coherence check (prompt + schema) |
| `src/core/refinement/tier3.ts` | Opus agentic investigation orchestrator |
| `src/core/refinement/index.ts` | `runRefinement(reviews, ctx)` entry point |
| `src/prompts/refinement/tier2-coherence.system.md` | Tier 2 system prompt |
| `src/prompts/refinement/tier3-investigation.system.md` | Tier 3 system prompt |

### Risks & Mitigations

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Tier 3 agent runs away (too many tool calls) | Medium | `maxTurns: 100`, cost cap per shard, abort on budget exceeded |
| Tier 2 Flash misses subtle contradiction | Low | Only handles explicit logical patterns; ambiguous cases escalated to tier 3 |
| Tier 1 auto-resolve is wrong (e.g., transitive type inference) | Low | Conservative rules — only resolve when evidence is unambiguous |
| Tier 3 cost higher than expected | Medium | Monitor first 3 runs; adjust shard size and max turns |
| Loss of per-file deliberation latency hiding | Accepted | Tier 3 adds ~18 min post-run, but total run is shorter and cheaper |

### Non-scope

- **Tier 3 writing code** — investigation only, no file modifications
- **Tier 3 on correction ERROR** — always escalated, never auto-resolved
- **Deliberation memory from tier 1/2** — mechanical corrections are not judgment calls
- **Grouping by axes** — shards are grouped by module/directory for cross-file coherence

### Implementation Plan

| Phase | Scope | Detail |
|-------|-------|--------|
| **0 — Tier 1** | `src/core/refinement/tier1.ts` | Deterministic auto-resolve. Can be tested independently against run 192337 reviews. |
| **1 — Wiring** | `file-evaluator.ts`, `run.ts` | Remove per-file deliberation, add refinement phase call. |
| **2 — Tier 2** | `src/core/refinement/tier2.ts` + prompt | Flash coherence check. Test against same run. |
| **3 — Tier 3** | `src/core/refinement/tier3.ts` + prompt | Opus agentic investigation. Start with 1-2 shards manually. |
| **4 — Integration** | Pipeline UI, memory, report | End-to-end flow with progress display. |
| **5 — Validation** | Compare reclassification quality | Run both old and new deliberation on same reviews, compare outcomes. |

## Epic 42 — Config Restructuring

### Contexte et Motivation

La section `llm` du schema de configuration mélange 5 responsabilités distinctes dans un seul namespace plat :

1. **Sélection de modèles** — `model`, `index_model`, `fast_model`, `deliberation_model`
2. **Configuration provider** — `sdk_concurrency`, `gemini.*`
3. **Paramètres runtime** — `timeout_per_file`, `max_retries`, `concurrency`, `min_confidence`, `max_stop_iterations`
4. **Feature flags** — `deliberation`, `agentic_tools`
5. **Overrides par axe** — `axes.*`

Les providers sont gérés de façon asymétrique : Anthropic est implicite (aucune section), Gemini est explicite (`llm.gemini.*`). La logique de résolution de modèle est encodée dans le code source (`defaultModel`, `defaultGeminiMode`), invisible depuis la config.

**Objectif :** Restructurer le schema en sections orthogonales `providers`, `models`, `agents`, `axes`, `runtime`. Aucune fonctionnalité ne change. Refactoring pur, validé par le gold-set.

### Décisions architecturales

#### ADR 42.1 — Séparation en 5 sections top-level

| Aspect | Décision | Rationale |
|---|---|---|
| Structure | `providers.*`, `models.*`, `agents.*`, `axes.*`, `runtime.*` | Chaque section a une seule responsabilité. Un utilisateur sait où chercher |
| `llm` | Supprimé entièrement | Remplacé par les 5 sections. Migration backward compat assurée |
| Backward compat | `migrateConfigV0toV1()` dans config-loader.ts | Détecte `llm` présent + `models` absent → transforme automatiquement |

#### ADR 42.2 — Providers : transport uniquement, jamais de modèles

```yaml
providers:
  anthropic:             # Requis — toujours présent avec defaults
    concurrency: 24
  google:                # Optionnel — présence = activé
    mode: subscription   # subscription (cli-core OAuth) | api (genai SDK + API key)
    concurrency: 10
```

| Aspect | Décision | Rationale |
|---|---|---|
| `anthropic` requis | Toujours présent avec defaults (`concurrency: 24`) | Anatoly ne fonctionne pas sans Claude. Évite `?.concurrency ?? 24` partout |
| `google` optionnel | Présence = activé (remplace `llm.gemini.enabled: true/false`) | Plus explicite — pas de section fantôme avec `enabled: false` |
| `mode` | `subscription` (ex `cli-core`) / `api` (ex `genai`) | Noms plus clairs pour l'utilisateur |
| Pas de modèles ici | Les noms de modèles sont dans `models.*` ou `axes.*.model` | Séparation transport vs. sélection de modèle |

**Mapping ancien → nouveau :**

| Ancien | Nouveau |
|---|---|
| `llm.sdk_concurrency` | `providers.anthropic.concurrency` |
| `llm.gemini.enabled` | `providers.google` présent/absent |
| `llm.gemini.type: cli-core` | `providers.google.mode: subscription` |
| `llm.gemini.type: genai` | `providers.google.mode: api` |
| `llm.gemini.sdk_concurrency` | `providers.google.concurrency` |

#### ADR 42.3 — Models : source unique de vérité pour les rôles

```yaml
models:
  quality: claude-sonnet-4-6          # axes qualitatifs par défaut
  fast: claude-haiku-4-5-20251001     # axes mécaniques + fallback
  deliberation: claude-opus-4-6       # délibération finale
  code_summary: gemini-2.5-flash-lite # résumé code RAG (optionnel, hérite fast)
```

| Aspect | Décision | Rationale |
|---|---|---|
| `quality` | Remplace `llm.model` | Nom explicite du rôle |
| `fast` | Fusionne `llm.index_model` + `llm.fast_model` | `fast_model` était un override redondant de `index_model` pour les axes — la distinction n'a plus de raison d'être |
| `deliberation` | Sorti de `llm` | Propre section, pas mélangé avec les modèles d'axes |
| `code_summary` | Ex `llm.gemini.nlp_model` | Renommé pour clarté — c'est le LLM de résumé de code pendant l'indexation RAG. **Ne pas confondre avec `rag.nlp_model`** qui est le modèle d'embedding local ONNX/GGUF |
| Noms bare | Pas de préfixe provider (ex: `gemini-2.5-flash`, pas `google:gemini-2.5-flash`) | Le `TransportRouter` infère le provider du nom (`gemini-*` → Google, sinon → Anthropic). Les préfixes seront introduits en Epic 43 si nécessaire |

#### ADR 42.4 — Agents : feature flags des phases agentiques

```yaml
agents:
  enabled: true
  # scaffolding: claude-sonnet-4-6  (hérite models.quality si absent)
  # review: claude-sonnet-4-6       (hérite models.quality si absent)
  # deliberation: claude-opus-4-6   (hérite models.deliberation si absent)
```

| Aspect | Décision | Rationale |
|---|---|---|
| `agents.enabled` | Remplace `llm.deliberation` | Contrôle toutes les phases agentiques, pas seulement la délibération |
| `agentic_tools` | **Supprimé** | Était déclaré dans `LlmConfigSchema` mais jamais lu dans le code applicatif. Redondant avec `agents.enabled` |
| Modèles optionnels | Héritage par défaut depuis `models.*` | L'utilisateur ne surcharge que s'il veut un modèle différent par phase |

#### ADR 42.5 — Axes : overrides directs, suppression de `defaultGeminiMode`

```yaml
axes:
  utility:         { enabled: true, model: gemini-2.5-flash-lite }
  duplication:     { enabled: true, model: gemini-2.5-flash-lite }
  overengineering: { enabled: true, model: gemini-2.5-flash-lite }
  correction:      { enabled: true }   # → hérite models.quality
  tests:           { enabled: true }
  best_practices:  { enabled: true }
  documentation:   { enabled: true }
```

| Aspect | Décision | Rationale |
|---|---|---|
| `axes` top-level | Sorti de `llm.axes` | Cohérent avec la séparation — les axes ne sont pas une sous-config du LLM |
| `defaultGeminiMode` | **Supprimé de l'interface `AxisEvaluator`** et des 3 implémentations (`utility`, `duplication`, `overengineering`) | Le routage Gemini était un détail d'implémentation encodé dans le code. Avec la nouvelle config, le modèle est explicite dans `axes.*.model` ou hérité via `models.fast`/`models.quality`. Plus besoin d'un flag sur l'évaluateur |
| `defaultModel` | **Conservé** sur l'interface (`'sonnet' \| 'haiku'`) | Sert toujours de discriminant pour le fallback : `haiku` → `models.fast`, `sonnet` → `models.quality`. C'est un contrat sémantique de l'axe, pas un détail provider |

**Nouvelle logique `resolveAxisModel` :**

```ts
export function resolveAxisModel(evaluator: AxisEvaluator, config: Config): string {
  const axisConfig = config.axes?.[evaluator.id];
  if (axisConfig?.model) return axisConfig.model;
  return evaluator.defaultModel === 'haiku'
    ? config.models.fast
    : config.models.quality;
}
```

Plus de branche Gemini — le routage est déterminé par le nom du modèle au niveau du `TransportRouter`, pas dans la résolution d'axe.

#### ADR 42.6 — Runtime : paramètres d'exécution isolés

```yaml
runtime:
  timeout_per_file: 600
  max_retries: 3
  concurrency: 8
  min_confidence: 70
  max_stop_iterations: 3
```

Tous les champs extraits de `llm.*` sans changement de sémantique.

### Schema Zod — `src/schemas/config.ts`

```ts
// ─── Providers ───────────────────────────────────────────────────

export const AnthropicProviderConfigSchema = z.object({
  concurrency: z.int().min(1).max(32).default(24),
});

export const GoogleProviderConfigSchema = z.object({
  mode:        z.enum(['subscription', 'api']).default('subscription'),
  concurrency: z.int().min(1).max(32).default(10),
});

export const ProvidersConfigSchema = z.object({
  anthropic: AnthropicProviderConfigSchema.default({ concurrency: 24 }),
  google:    GoogleProviderConfigSchema.optional(),
});

// ─── Modèles ─────────────────────────────────────────────────────

export const ModelsConfigSchema = z.object({
  quality:      z.string().default('claude-sonnet-4-6'),
  fast:         z.string().default('claude-haiku-4-5-20251001'),
  deliberation: z.string().default('claude-opus-4-6'),
  /** LLM de résumé de code pendant l'indexation RAG.
   *  Distinct de rag.nlp_model (modèle d'embedding local ONNX/GGUF).
   *  Si absent, hérite de fast. */
  code_summary: z.string().optional(),
});

// ─── Agents ──────────────────────────────────────────────────────

export const AgentsConfigSchema = z.object({
  enabled:      z.boolean().default(true),
  scaffolding:  z.string().optional(),
  review:       z.string().optional(),
  deliberation: z.string().optional(),
});

// ─── Runtime ─────────────────────────────────────────────────────

export const RuntimeConfigSchema = z.object({
  timeout_per_file:    z.int().min(1).default(600),
  max_retries:         z.int().min(1).max(10).default(3),
  concurrency:         z.int().min(1).max(10).default(8),
  min_confidence:      z.int().min(0).max(100).default(70),
  max_stop_iterations: z.int().min(1).max(10).default(3),
});

// ─── Schema racine ───────────────────────────────────────────────

export const ConfigSchema = z.object({
  project:       ProjectConfigSchema.default({ monorepo: false }),
  scan:          ScanConfigSchema.default({ /* ... */ }),
  coverage:      CoverageConfigSchema.default({ /* ... */ }),
  providers:     ProvidersConfigSchema.default({
    anthropic: { concurrency: 24 },
  }),
  models:        ModelsConfigSchema.default({
    quality: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5-20251001',
    deliberation: 'claude-opus-4-6',
  }),
  agents:        AgentsConfigSchema.default({ enabled: true }),
  axes:          AxesConfigSchema.default({ /* tous enabled: true */ }),
  runtime:       RuntimeConfigSchema.default({
    timeout_per_file: 600, max_retries: 3, concurrency: 8,
    min_confidence: 70, max_stop_iterations: 3,
  }),
  rag:           RagConfigSchema.default({ /* ... */ }),
  logging:       LoggingConfigSchema.default({ level: 'warn', pretty: true }),
  output:        OutputConfigSchema.default({}),
  badge:         BadgeConfigSchema.default({ /* ... */ }),
  documentation: DocumentationConfigSchema.default({ docs_path: 'docs' }),
});
```

**Différences avec le brouillon :** `providers.anthropic` est **requis** (pas optionnel) — Anatoly ne fonctionne pas sans Claude, et ça évite les null-checks partout.

**Types exportés :**

```ts
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfigSchema>;
export type GoogleProviderConfig    = z.infer<typeof GoogleProviderConfigSchema>;
export type ProvidersConfig         = z.infer<typeof ProvidersConfigSchema>;
export type ModelsConfig            = z.infer<typeof ModelsConfigSchema>;
export type AgentsConfig            = z.infer<typeof AgentsConfigSchema>;
export type RuntimeConfig           = z.infer<typeof RuntimeConfigSchema>;
export type AxisConfig              = z.infer<typeof AxisConfigSchema>;
export type Config                  = z.infer<typeof ConfigSchema>;
```

### Fonctions de résolution — `src/core/axis-evaluator.ts`

```ts
/** Resolve le modèle effectif pour un axe.
 *  Priorité : axes.[axe].model → (haiku ? models.fast : models.quality) */
export function resolveAxisModel(evaluator: AxisEvaluator, config: Config): string {
  const axisConfig = config.axes?.[evaluator.id];
  if (axisConfig?.model) return axisConfig.model;
  return evaluator.defaultModel === 'haiku'
    ? config.models.fast
    : config.models.quality;
}

/** Resolve le modèle LLM pour le résumé de code RAG.
 *  Ne pas confondre avec rag.nlp_model (embedding local). */
export function resolveCodeSummaryModel(config: Config): string {
  return config.models.code_summary ?? config.models.fast;
}

/** Resolve le modèle pour la délibération. */
export function resolveDeliberationModel(config: Config): string {
  return config.agents.deliberation ?? config.models.deliberation;
}

/** Resolve le modèle pour une phase agentique (scaffolding ou review). */
export function resolveAgentModel(phase: 'scaffolding' | 'review', config: Config): string {
  return config.agents[phase] ?? config.models.quality;
}
```

### Héritage des modèles (règles complètes)

```
axes.[axe].model défini
  → utilise ce modèle

axes.[axe].model absent, axe mécanique (utility, duplication, overengineering)
  → evaluator.defaultModel === 'haiku' → models.fast

axes.[axe].model absent, axe qualitatif (correction, tests, best_practices, documentation)
  → evaluator.defaultModel === 'sonnet' → models.quality

agents.scaffolding / agents.review
  → défini : utilise ce modèle
  → absent : models.quality

agents.deliberation
  → défini : utilise ce modèle
  → absent : models.deliberation

models.code_summary (résumé code RAG)
  → défini : utilise ce modèle
  → absent : models.fast
```

### Suppression de `defaultGeminiMode` sur l'interface `AxisEvaluator`

**Avant :**

```ts
export interface AxisEvaluator {
  readonly id: AxisId;
  readonly defaultModel: 'sonnet' | 'haiku';
  readonly defaultGeminiMode?: 'flash';        // ← supprimé
  evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult>;
}
```

**Après :**

```ts
export interface AxisEvaluator {
  readonly id: AxisId;
  readonly defaultModel: 'sonnet' | 'haiku';
  evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult>;
}
```

**Fichiers impactés :**
- `src/core/axis-evaluator.ts` — interface + `resolveAxisModel`
- `src/core/axes/utility.ts` — supprimer `readonly defaultGeminiMode = 'flash' as const`
- `src/core/axes/duplication.ts` — idem
- `src/core/axes/overengineering.ts` — idem
- `src/core/axis-evaluator.test.ts` — supprimer les tests `defaultGeminiMode`
- `src/core/file-evaluator.test.ts` — supprimer `defaultGeminiMode` des mocks

### Migration backward compat — `migrateConfigV0toV1`

```ts
export function migrateConfigV0toV1(raw: Record<string, unknown>): Record<string, unknown> {
  if (!raw.llm || raw.models) return raw; // déjà migré ou pas de legacy

  const llm    = raw.llm as Record<string, unknown>;
  const gemini = (llm.gemini ?? {}) as Record<string, unknown>;
  const oldAxes = (llm.axes ?? {}) as Record<string, unknown>;

  // --- providers ---
  const providers: Record<string, unknown> = {
    anthropic: { concurrency: llm.sdk_concurrency ?? 24 },
  };
  if (gemini.enabled) {
    providers.google = {
      mode:        gemini.type === 'genai' ? 'api' : 'subscription',
      concurrency: gemini.sdk_concurrency ?? 10,
    };
  }

  // --- axes : migrer flash_model Gemini vers des overrides explicites ---
  const axes = { ...oldAxes };
  if (gemini.enabled && gemini.flash_model) {
    for (const axe of ['utility', 'duplication', 'overengineering']) {
      const existing = (axes[axe] as Record<string, unknown>) ?? {};
      if (!existing.model) {
        axes[axe] = { ...existing, model: gemini.flash_model };
      }
    }
  }

  // --- models ---
  const models: Record<string, unknown> = {
    quality:      llm.model              ?? 'claude-sonnet-4-6',
    fast:         llm.fast_model ?? llm.index_model ?? 'claude-haiku-4-5-20251001',
    deliberation: llm.deliberation_model ?? 'claude-opus-4-6',
  };
  if (gemini.enabled && gemini.nlp_model) {
    models.code_summary = gemini.nlp_model;
  }

  // --- result ---
  const { llm: _removed, ...rest } = raw;
  return {
    ...rest,
    providers,
    models,
    agents:  { enabled: llm.deliberation ?? true },
    axes,
    runtime: {
      timeout_per_file:    llm.timeout_per_file    ?? 600,
      max_retries:         llm.max_retries         ?? 3,
      concurrency:         llm.concurrency         ?? 8,
      min_confidence:      llm.min_confidence      ?? 70,
      max_stop_iterations: llm.max_stop_iterations ?? 3,
    },
  };
}
```

**Corrections par rapport au brouillon :**
1. **Bug de type assertion corrigé** — `axes[axe] = { ...existing, model }` au lieu de `(axes[axe] as ...) = ...`
2. **Suppression propre de `llm`** — destructuring `const { llm: _removed, ...rest }` au lieu de `llm: undefined`
3. **Clone des axes** — `{ ...oldAxes }` pour ne pas muter l'objet input

**Intégration dans `config-loader.ts` :**

```ts
export function loadConfig(projectRoot: string, configPath?: string): Config {
  // ... lecture YAML existante ...

  // Migration v0 → v1
  if (typeof parsed === 'object' && parsed !== null) {
    const raw = parsed as Record<string, unknown>;
    if (raw.llm && !raw.models) {
      console.warn(
        '⚠ .anatoly.yml uses the legacy `llm` section (pre-v1.0).\n' +
        '  Run `anatoly migrate-config` to update your config file.\n' +
        '  Legacy format supported until v2.0.'
      );
      parsed = migrateConfigV0toV1(raw);
    }
  }

  const result = ConfigSchema.safeParse(parsed);
  // ... suite inchangée ...
}
```

### Fichiers impactés (liste complète)

| Fichier | Changements | Complexité |
|---|---|---|
| `src/schemas/config.ts` | Supprimer `LlmConfigSchema` + `GeminiConfigSchema`. Ajouter `ProvidersConfigSchema`, `ModelsConfigSchema`, `AgentsConfigSchema`, `RuntimeConfigSchema`. Réécrire `ConfigSchema`. Nouveaux types exportés | Élevée |
| `src/core/axis-evaluator.ts` | Réécrire `resolveAxisModel` (supprimer branche Gemini). Renommer `resolveNlpModel` → `resolveCodeSummaryModel`. Réécrire `resolveDeliberationModel`. Ajouter `resolveAgentModel`. Supprimer `defaultGeminiMode` de l'interface. Mettre à jour `resolveSemaphore` paths | Élevée |
| `src/utils/config-loader.ts` | Ajouter `migrateConfigV0toV1`. Brancher le warning + migration dans `loadConfig` | Moyenne |
| `src/commands/run.ts` | ~40 réf. `config.llm.*` à migrer : `.concurrency` → `.runtime.concurrency`, `.sdk_concurrency` → `.providers.anthropic.concurrency`, `.gemini.*` → `.providers.google.*`, `.model` → `.models.quality`, `.deliberation_model` → `.models.deliberation`, `.deliberation` → `.agents.enabled`, `.gemini.enabled` → `!!config.providers.google`. Dump `run-config.json` : remplacer `config.llm` par sections séparées | Élevée |
| `src/commands/providers.ts` | Réécriture lourde — tous les chemins `config.llm.model/index_model/deliberation_model` → `config.models.*`, `config.llm.gemini.*` → `config.providers.google.*` | Élevée |
| `src/commands/estimate.ts` | `config.llm.concurrency` → `config.runtime.concurrency`, `config.llm.sdk_concurrency` → `config.providers.anthropic.concurrency`, `config.llm.gemini.*` → `config.providers.google.*` + `resolveCodeSummaryModel` | Faible |
| `src/commands/review.ts` | `config.llm.sdk_concurrency` → `config.providers.anthropic.concurrency` | Faible |
| `src/commands/watch.ts` | Idem review.ts | Faible |
| `src/commands/hook.ts` | `config.llm.min_confidence` → `config.runtime.min_confidence`, `config.llm.max_stop_iterations` → `config.runtime.max_stop_iterations` | Faible |
| `src/core/file-evaluator.ts` | `config.llm.model` → `config.models.quality` | Faible |
| `src/rag/standalone.ts` | `config.llm.concurrency` → `config.runtime.concurrency`, `config.llm.index_model` → `config.models.fast` | Faible |
| `src/core/axes/utility.ts` | Supprimer `readonly defaultGeminiMode = 'flash' as const` | Triviale |
| `src/core/axes/duplication.ts` | Idem | Triviale |
| `src/core/axes/overengineering.ts` | Idem | Triviale |
| `src/core/axes/index.ts` | `config.llm.axes` → `config.axes` | Triviale |
| `src/schemas/config.test.ts` | Réécrire tous les tests de parsing/defaults | Élevée |
| `src/core/axis-evaluator.test.ts` | Réécrire tests `resolveAxisModel`, `resolveNlpModel` → `resolveCodeSummaryModel`, supprimer tests `defaultGeminiMode` | Moyenne |
| `src/core/file-evaluator.test.ts` | Supprimer `defaultGeminiMode` des mocks | Triviale |

### Plan d'exécution

| Étape | Scope | Fichiers | Validation |
|---|---|---|---|
| **1 — Schema** | Nouveau schema Zod + types | `config.ts`, `config.test.ts` | `vitest run src/schemas/config.test.ts` — parsing, defaults, edge cases |
| **2 — Migration** | `migrateConfigV0toV1` + warning + `anatoly migrate-config` | `config-loader.ts` + tests | Ancien format → nouveau format → Zod parse OK |
| **3 — Résolution** | Nouvelles fonctions resolve*, suppression `defaultGeminiMode` | `axis-evaluator.ts`, `axes/*.ts`, `axes/index.ts` + tests | `vitest run src/core/axis-evaluator.test.ts` |
| **4 — Consommateurs** | Migration de tous les chemins `config.llm.*` | `run.ts`, `providers.ts`, `estimate.ts`, `review.ts`, `watch.ts`, `hook.ts`, `file-evaluator.ts`, `standalone.ts` | `vitest run` — zéro erreur TS |
| **5 — Gold-set** | Validation complète zéro régression | — | `vitest run src/prompts/__gold-set__/gold-set.test.ts` + diff baseline |

### Non-périmètre

- `providers.anthropic.mode` — ajouté en Epic 43
- Préfixes provider dans les model strings (`google/gemini-2.5-flash`) — Epic 43
- Nouveaux providers (OpenAI, Qwen) — Epic 43
- Vercel AI SDK — Epic 43
- OpenClaw — Epic 46

## Epic 43 — Migration Architecture Multi-Provider LLM-Agnostique

### Contexte et Motivation

Anatoly est actuellement verrouillé sur deux transports propriétaires : Claude Code SDK (abonnement Max) et `@google/gemini-cli-core` (abonnement Gemini Code Assist). En mode `api` (clé API personnelle), seul `@google/genai` est supporté — un SDK unique à Google.

**Problèmes :**
1. **Lock-in provider** — impossible d'utiliser OpenAI, Qwen, Groq, DeepSeek, Mistral, Ollama
2. **Deux SDK API distincts** — `@google/genai` et le futur `@anthropic-ai/sdk` auraient chacun leur transport
3. **Pas d'agents en mode API** — les agents Tier 3 (refinement) et doc-generation nécessitent Claude Code SDK, donc un abonnement Max
4. **Pas de calcul de coût en mode subscription** — le budget est invisible

**Solution :** Introduire Vercel AI SDK comme transport unifié pour tout appel en mode `api`. Les transports subscription (Claude Code SDK, Gemini CLI Core) sont conservés intacts. Le routage est déterminé par le mode du provider (`subscription` → SDK natif, `api` → Vercel AI SDK).

**Prérequis :** Epic 42 complété — `providers.*`, `models.*`, `agents.*`, `axes.*`, `runtime.*` opérationnels.

### Décisions architecturales

#### ADR 43.1 — Trois modes de transport coexistants

| Mode | Déclencheur | Transport | Auth | Usage |
|---|---|---|---|---|
| Claude Code SDK | `providers.anthropic.mode: subscription` | Inchangé | Abonnement Claude Code Max | Single-turn + agents natifs |
| Gemini CLI Core | `providers.google.mode: subscription` | Inchangé | Abonnement Google AI Pro | Single-turn uniquement |
| Vercel AI SDK | `providers.*.mode: api` | **Nouveau** | Clé API env var | Single-turn + agents bash-tool |

| Aspect | Décision | Rationale |
|---|---|---|
| Claude Code SDK | Conservé intact | Zéro risque de régression, billing illimité pour les abonnés Max |
| Gemini CLI Core | Conservé intact | OAuth cached, zéro clé API, billing subscription |
| `@google/genai` | **Supprimé** — remplacé par `@ai-sdk/google` | Un seul SDK API au lieu de deux. Vercel AI SDK unifie l'interface |
| Vercel AI SDK | Transport unifié pour tout mode `api` | Interface commune pour Anthropic API, Google API, OpenAI, et tous les OpenAI-compatibles |

#### ADR 43.2 — Prefixes provider dans les model strings

**Epic 42 :** noms bare (`claude-sonnet-4-6`, `gemini-2.5-flash`)
**Epic 43 :** noms préfixés (`anthropic/claude-sonnet-4-6`, `google/gemini-2.5-flash`)

| Aspect | Décision | Rationale |
|---|---|---|
| Format | `{provider}/{model}` — séparateur `/` | Convention Vercel AI SDK, familier aux utilisateurs |
| Extraction provider | `modelId.split('/')[0]` | Déterministe, pas de table de mapping à maintenir |
| Backward compat | Noms bare encore supportés — inférés par préfixe (`gemini-*` → `google/`, sinon → `anthropic/`) | Migration douce, pas de breaking change |
| Migration config | `migrateConfigV1toV2()` ajoute les préfixes automatiquement | Warning + `anatoly migrate-config` comme Epic 42 |

**Impact sur le `TransportRouter` :** Le routage ne dépend plus de `model.startsWith('gemini-')`. Il extrait le provider du préfixe, consulte `config.providers[provider].mode`, et sélectionne le transport.

#### ADR 43.3 — Champ `mode` sur tous les providers

```yaml
providers:
  anthropic:
    mode: subscription     # subscription → Claude Code SDK
    # mode: api            # api → Vercel AI SDK + ANTHROPIC_API_KEY
    concurrency: 24
  google:
    mode: subscription     # subscription → gemini-cli-core
    # mode: api            # api → Vercel AI SDK + GOOGLE_API_KEY
    concurrency: 10
```

| Aspect | Décision | Rationale |
|---|---|---|
| `mode` sur `anthropic` | Ajouté (default: `subscription`) | Permet l'usage via API key en CI/CD sans binary Claude |
| `mode` par défaut | `subscription` pour anthropic/google, `api` pour les autres | Comportement Epic 42 inchangé par défaut |
| `providers.anthropic` | Passe de **requis** (Epic 42) à **optionnel** (Epic 43) | En mode pure API, on peut tourner sans Anthropic (`qwen` + `google` suffit) |
| Split `single_turn`/`agents` | Champs optionnels qui priment sur `mode` | Power users qui veulent subscription pour les axes et API pour les agents en CI |

#### ADR 43.4 — Providers génériques via `.catchall()`

```ts
export const ProvidersConfigSchema = z.object({
  anthropic: AnthropicProviderConfigSchema.optional(),
  google:    GoogleProviderConfigSchema.optional(),
}).catchall(GenericProviderConfigSchema);
```

| Aspect | Décision | Rationale |
|---|---|---|
| Registre connu | `KNOWN_PROVIDERS` — table statique avec `base_url`, `env_key`, `type` | Auto-complétion pour Qwen, Groq, DeepSeek, Mistral, OpenRouter, Ollama |
| Override user | `base_url` et `env_key` dans la config YAML priment sur le registre | Flexibilité totale |
| Provider inconnu | Accepté si `base_url` fourni | Pas de whitelist — tout OpenAI-compatible fonctionne |
| Type `native` vs `openai-compatible` | `anthropic`, `google`, `openai` → SDK natif Vercel ; les autres → `createOpenAICompatible` | Meilleure qualité d'intégration pour les 3 grands |

#### ADR 43.5 — Transport router refactoré (mode-aware)

**Avant (Epic 42) :** `model.startsWith('gemini-')` → Gemini, sinon → Anthropic.

**Après (Epic 43) :**

```ts
export function resolveTransportMode(
  modelId: string,
  task: 'single_turn' | 'agents',
  config: Config,
): 'claude-code' | 'gemini-cli' | 'vercel-sdk' {
  const provider = extractProvider(modelId);   // 'anthropic', 'google', 'qwen', ...
  const p = config.providers?.[provider];
  if (!p) throw new Error(`Provider "${provider}" not configured`);

  // Résolution mode : split single_turn/agents prime sur mode global
  const mode = (task === 'single_turn' && p.single_turn)
    ? p.single_turn
    : (task === 'agents' && p.agents)
      ? p.agents
      : p.mode ?? 'api';

  if (mode === 'subscription') {
    if (provider === 'anthropic') return 'claude-code';
    if (provider === 'google')    return 'gemini-cli';
    throw new Error(`No subscription SDK for provider "${provider}"`);
  }
  return 'vercel-sdk';
}
```

| Aspect | Décision | Rationale |
|---|---|---|
| `extractProvider()` | Bare names → inférence (`gemini-*` → google, sinon → anthropic). Prefixed → `split('/')` | Backward compat avec Epic 42 |
| Circuit breaker | Conservé — redirige Gemini vers Claude en cas de rate limit | Inchangé, fonctionne avec les deux modes |
| Semaphores | Un par provider, résolu par le préfixe du modèle | Extension naturelle de l'existant |
| `setGeminiTransportType()` | **Supprimé** — le mode est dans la config, plus besoin de global mutable | Simplification |
| `geminiTransportCache` | **Supprimé** — le transport est résolu par le router, pas caché par modèle | Le `TransportRouter` gère le lifecycle |

#### ADR 43.6 — Agents Vercel AI SDK avec bash-tool

| Aspect | Décision | Rationale |
|---|---|---|
| Activation | Uniquement si le provider du modèle agent est en mode `api` | Les agents subscription (Claude Code SDK) restent inchangés |
| Tools | `bash-tool` (read-only par défaut) + web search optionnel | Tier 3 a besoin de Read, Grep, Glob — le bash-tool les couvre |
| `allowWrite` | `false` par défaut, `true` uniquement pour doc-generation | Principe du moindre privilège |
| Web search | Exa MCP (gratuit, fallback) ou Brave Search (pro, `BRAVE_API_KEY`) | Investigation tier 3 peut bénéficier de recherche technique |
| maxSteps | 20 par défaut, configurable par phase | Borne le coût d'un agent agentic en mode API |

#### ADR 43.7 — Calcul de coût pour le mode API

```ts
// src/utils/cost-calculator.ts
const PRICING: Record<string, { input: number; output: number }> = {
  'anthropic/claude-sonnet-4-6':   { input: 3,    output: 15   },
  'anthropic/claude-opus-4-6':     { input: 5,    output: 25   },
  'anthropic/claude-haiku-4-5':    { input: 0.25, output: 1.25 },
  'google/gemini-2.5-flash':       { input: 0.15, output: 0.60 },
  'google/gemini-2.5-flash-lite':  { input: 0.075, output: 0.30 },
  // ... extensible
};
```

| Aspect | Décision | Rationale |
|---|---|---|
| Table statique | Hardcodée dans le code, pas dans la config | Simple, versionné, mis à jour avec les releases |
| Modèle inconnu | `costUsd: 0` | Pas de crash — le coût est informatif, pas bloquant |
| Mode subscription | `costUsd: 0` comme aujourd'hui | Le billing est sur l'abonnement, pas par token |
| Gemini genai existant | Déjà dans `gemini-genai-transport.ts` → migré vers le cost calculator centralisé | Source unique de vérité pour les prix |

### Refactoring du transport pipeline

**Avant (Epic 42) :**

```
axis-evaluator.ts
  └─ runSingleTurnQuery()
       ├─ model.startsWith('gemini-') → getOrCreateGeminiTransport()
       │   ├─ _geminiTransportType === 'genai' → GeminiGenaiTransport
       │   └─ _geminiTransportType === 'cli-core' → GeminiTransport
       └─ sinon → AnthropicTransport
```

**Après (Epic 43) :**

```
axis-evaluator.ts
  └─ runSingleTurnQuery()
       └─ transportRouter.resolve(model, 'single_turn')
            ├─ mode === 'subscription' + anthropic → AnthropicTransport (inchangé)
            ├─ mode === 'subscription' + google → GeminiTransport (inchangé)
            └─ mode === 'api' → VercelSdkTransport (nouveau, unifié)
```

**Changements clés dans `runSingleTurnQuery` :**
- Suppression du `getOrCreateGeminiTransport()` et du cache
- Suppression de `setGeminiTransportType()` global mutable
- Le `TransportRouter` est injecté via `SingleTurnQueryParams` (ou via le contexte du run)
- Le circuit breaker continue de fonctionner — il redirige le modèle, le router résout le transport du nouveau modèle

### Fichiers impactés

| Fichier | Action | Complexité |
|---|---|---|
| `src/schemas/config.ts` | Ajout `mode` sur Anthropic, `anthropic` → optionnel, `GenericProviderConfigSchema`, `.catchall()`, model prefixes | Moyenne |
| `src/core/providers/known-providers.ts` | **Nouveau** — registre des providers connus | Faible |
| `src/core/transports/vercel-sdk-transport.ts` | **Nouveau** — transport Vercel AI SDK | Moyenne |
| `src/core/transports/index.ts` | Refactor `TransportRouter` — mode-aware, extraction provider | Élevée |
| `src/core/transports/gemini-genai-transport.ts` | **Supprimé** — remplacé par `vercel-sdk-transport.ts` | — |
| `src/core/axis-evaluator.ts` | Supprimer `setGeminiTransportType`, `geminiTransportCache`, `getOrCreateGeminiTransport`. Injecter router dans `runSingleTurnQuery` | Élevée |
| `src/core/agents/vercel-agent.ts` | **Nouveau** — agents via Vercel AI SDK + bash-tool | Moyenne |
| `src/core/tools/web-search.ts` | **Nouveau** — Exa + Brave search tools | Faible |
| `src/utils/cost-calculator.ts` | **Nouveau** — pricing centralisé | Faible |
| `src/utils/config-loader.ts` | `migrateConfigV1toV2()` — ajout préfixes model strings | Faible |
| `src/commands/run.ts` | Supprimer `setGeminiTransportType` call, passer le router, refactor Gemini auth check | Moyenne |
| `src/commands/providers.ts` | Afficher mode par provider, tester Vercel SDK | Moyenne |
| `src/commands/init.ts` | **Nouveau** — onboarding interactif multi-provider | Élevée |

### Non-périmètre

- **Cache web search** — évaluer si facture Brave > 50€/mois
- **Context caching Vercel AI SDK** — optimisation Phase 2
- **Streaming** — pas nécessaire pour single-turn JSON
- **OpenClaw** — Epic 46
- **MCP tools** — les agents utilisent bash-tool, pas MCP

## Epic 46 — Transport-Level Resilience : Semaphores & Circuit Breaker dans le Router

### Contexte et Motivation

Les Epics 42 et 43 ont introduit le multi-provider avec un `TransportRouter` mode-aware qui résout le bon transport pour chaque modèle. Cependant, deux mécanismes de résilience restent hardcodés et propagés manuellement dans toute la stack :

1. **Semaphores** — `semaphore` (Anthropic, 24 slots) + `geminiSemaphore` (Google, 10 slots), deux champs distincts propagés dans 6 interfaces et ~15 fichiers
2. **Circuit breaker** — `GeminiCircuitBreaker`, spécifique à Google, propagé dans les mêmes interfaces

**Problèmes :**
- **Ne scale pas** — ajouter un 3e provider nécessiterait `groqSemaphore`, `groqCircuitBreaker`, etc.
- **Violation de responsabilité** — les évaluateurs d'axes ne devraient pas connaître les contraintes de concurrence des providers
- **40+ occurrences** de `geminiSemaphore` propagées mécaniquement dans le code
- **Asymétrie** — Google a un breaker et un semaphore dédié, les autres providers n'en ont aucun
- **5 chemins sur 8 bypassen le router** — les appels agentic (Tier 3, doc gen, Vercel Agent) utilisent directement les SDKs sans routing ni concurrence unifiée

### Inventaire des chemins d'appel LLM

| # | Chemin | Fichier principal | Mécanisme | Router | Semaphore | Breaker | Catégorie |
|---|---|---|---|---|---|---|---|
| 1 | Axes (×7) | `axis-evaluator.ts` | `runSingleTurnQuery()` | oui | oui (dual) | oui | single-turn |
| 2 | RAG NLP summarizer | `rag/nlp-summarizer.ts` | `runSingleTurnQuery()` | oui | oui | oui | single-turn |
| 3 | RAG doc indexer | `rag/doc-indexer.ts` | `runSingleTurnQuery()` | oui | oui | oui | single-turn |
| 4 | Tier 3 correction | `commands/run.ts:511` | direct `query()` Claude SDK | **non** | sdkSemaphore | non | agentic |
| 5 | Doc gen — pages | `commands/run.ts:1041` | direct `query()` Claude SDK | **non** | non | non | agentic |
| 6 | Doc gen — Sonnet coherence | `doc-llm-executor.ts:740` | direct `query()` Claude SDK | **non** | optionnel | non | agentic |
| 7 | Doc gen — Opus review | `doc-llm-executor.ts:887` | direct `query()` Claude SDK | **non** | optionnel | non | agentic |
| 8 | Vercel Agent | `agents/vercel-agent.ts:83` | direct `generateText()` | **non** | non | non | agentic |
| 9 | Providers check | `commands/providers.ts:131` | direct `query()` Claude SDK | **non** | non | non | diagnostic |

**Constat :** Les appels single-turn (1-3) passent par `runSingleTurnQuery` et donc par le router. Les appels agentic (4-8) utilisent directement le SDK car le SDK gère sa propre boucle multi-turn avec tools — on ne peut pas intercepter les appels LLM individuels à l'intérieur de la boucle agent. Le chemin 9 (diagnostic) est hors périmètre.

**Principe directeur :** Deux niveaux de contrôle. Pour les appels **single-turn**, le router gère transport + semaphore + breaker. Pour les appels **agentic**, le router fournit uniquement le slot de concurrence — le SDK gère le reste.

### Décisions architecturales

#### ADR 46.1 — Deux catégories d'appels LLM, même breaker

| Catégorie | Appels | Contrôle | API router |
|---|---|---|---|
| **Single-turn** | Axes, RAG NLP, RAG doc indexer | Transport + semaphore + breaker (avant + après) | `router.acquire(model)` |
| **Agentic** | Tier 3, doc gen (Sonnet/Opus), Vercel Agent | Semaphore + breaker (avant + après l'appel agent complet) | `router.acquireSlot(model)` |

| Aspect | Décision | Rationale |
|---|---|---|
| Pas de `router.query()` englobant | Le router ne fait pas l'appel LLM lui-même | Les transports ont des signatures différentes, les agents gèrent leur boucle |
| Breaker sur les deux | Le breaker check se fait **avant** l'appel, le record **après**. Pour les agents, c'est l'appel complet (pas les steps individuels) qui est mesuré | Si 3 agents Opus échouent consécutivement sur un provider, le provider est mort — autant fail fast |
| Semaphore sur les deux | La concurrence doit être bornée quel que soit le type d'appel | Un agent Opus consomme un slot pendant toute sa durée |
| `acquireSlot` inclut le breaker check | Vérification du breaker avant d'acquire le semaphore | Pas de slot consommé inutilement si le provider est down |
| record via le release | `release({ success: true })` ou `release({ success: false, error })` pour alimenter le breaker | L'appelant n'a pas besoin d'appeler `recordSuccess/Failure` séparément |

#### ADR 46.2 — Semaphores par provider dans le TransportRouter

**Avant :**
```
RunContext
  ├─ sdkSemaphore: Semaphore(24)       → Anthropic
  └─ geminiSemaphore: Semaphore(10)    → Google
       ↓ propagé dans AxisContext, SingleTurnQueryParams,
         EvaluateFileOptions, PipelineState, RagOptions...
```

**Après :**
```
TransportRouter
  └─ semaphores: Map<string, Semaphore>
       ├─ "anthropic" → Semaphore(config.providers.anthropic.concurrency)
       ├─ "google"    → Semaphore(config.providers.google.concurrency)
       └─ "groq"      → Semaphore(config.providers.groq.concurrency)  // extensible
```

| Aspect | Décision | Rationale |
|---|---|---|
| Ownership | `TransportRouter` crée et détient les semaphores | Responsabilité unique — le router connaît les providers et leurs limites |
| Construction | `new TransportRouter(config)` lit `config.providers[id].concurrency` | Plus besoin de construire les semaphores à l'extérieur |
| Default | `concurrency: 10` si non spécifié | Valeur safe pour les providers API |

#### ADR 46.3 — Circuit breakers par provider dans le TransportRouter

**Avant :**
```
RunContext
  └─ circuitBreaker: GeminiCircuitBreaker   → Google uniquement
```

**Après :**
```
TransportRouter
  └─ breakers: Map<string, CircuitBreaker>
       ├─ "google"    → CircuitBreaker({ threshold: 3 })
       └─ "groq"      → CircuitBreaker({ threshold: 5 })  // extensible
```

| Aspect | Décision | Rationale |
|---|---|---|
| Classe | `CircuitBreaker` (renommé de `GeminiCircuitBreaker`) | Provider-agnostique, même logique closed/open/half-open |
| Scope | Single-turn **et** agentic | Pour les agents, le breaker s'applique autour de l'appel complet — 3 agents qui crash = provider down |
| Granularité agentic | Un appel agent entier = 1 success/failure | Pas les steps individuels (inaccessibles dans les SDKs) |
| Pas de fallback | Breaker ouvert → `throw Error` | Pas de substitution silencieuse de provider |
| Config optionnelle | `providers.*.circuit_breaker: { threshold: 5, half_open_delay_ms: 300000 }` | Extensible mais optionnel |

#### ADR 46.4 — Nouvelle API du TransportRouter

```ts
/** Result passed to release() to feed the circuit breaker. */
interface ReleaseOptions {
  success: boolean;
  error?: Error;
}

class TransportRouter {
  // Existant — lecture seule, pas de semaphore/breaker
  resolve(model: string, task?: TaskType): LlmTransport;

  // Single-turn : breaker check → semaphore acquire → resolve transport
  acquire(model: string, task?: TaskType): Promise<{
    transport: LlmTransport;
    release: (result?: ReleaseOptions) => void;
  }>;

  // Agentic : breaker check → semaphore acquire (pas de transport)
  acquireSlot(model: string): Promise<{
    release: (result?: ReleaseOptions) => void;
  }>;

  // Introspection (pour screen-renderer, logging)
  getSemaphoreStats(): Map<string, { active: number; total: number }>;
  getBreakerState(providerId: string): CircuitState | undefined;
}
```

| Méthode | Usage | Détail |
|---|---|---|
| `acquire(model)` | `runSingleTurnQuery()` | Breaker check → semaphore acquire → resolve transport. `release({ success })` libère le semaphore et alimente le breaker |
| `acquireSlot(model)` | Tier 3, doc gen, Vercel Agent | Breaker check → semaphore acquire. L'appelant gère le SDK et appelle `release({ success })` en finally |
| `release(result?)` | Retourné par acquire/acquireSlot | Sans argument = success. Avec `{ success: false }` = recordFailure sur le breaker. Libère toujours le semaphore |
| `resolve(model)` | Conservé | Lecture seule, pas de semaphore/breaker — pour estimate, tests, providers check |
| `getSemaphoreStats()` | `screen-renderer.ts` | Remplace l'accès direct aux semaphores pour l'affichage live |

**Pattern d'usage agentic :**
```ts
// Tier 3 correction, doc generation, Vercel Agent
const { release } = await router.acquireSlot(model);
try {
  const result = await sdkQuery({ model, ... }); // Claude SDK, Vercel generateText, etc.
  release({ success: true });
  return result;
} catch (err) {
  release({ success: false, error: err as Error });
  throw err;
}
```

**Pattern d'usage single-turn :**
```ts
// runSingleTurnQuery
const { transport, release } = await router.acquire(model);
try {
  const result = await transport.query(request);
  release({ success: true });
  return result;
} catch (err) {
  release({ success: false, error: err as Error });
  throw err;
}
```

#### ADR 46.5 — Simplification des interfaces

**SingleTurnQueryParams — avant (15 champs) :**
```ts
interface SingleTurnQueryParams {
  systemPrompt, userMessage, model, projectRoot, abortController,
  conversationDir, conversationPrefix,
  semaphore,              // ← supprimé
  geminiSemaphore,        // ← supprimé
  circuitBreaker,         // ← supprimé
  transport,              // ← supprimé
  router
}
```

**SingleTurnQueryParams — après (11 champs) :**
```ts
interface SingleTurnQueryParams {
  systemPrompt, userMessage, model, projectRoot, abortController,
  conversationDir, conversationPrefix,
  router                  // ← seul point d'accès
}
```

**Interfaces nettoyées (suppression de `semaphore`, `geminiSemaphore`, `circuitBreaker`) :**
- `AxisContext` (axis-evaluator.ts)
- `SingleTurnQueryParams` (axis-evaluator.ts)
- `EvaluateFileOptions` (file-evaluator.ts)
- `RunContext` / `PipelineState` (run.ts, pipeline-state.ts)
- `RagOptions` / `NlpSummarizerParams` (rag/orchestrator.ts, rag/nlp-summarizer.ts)

**Fonctions supprimées :**
- `resolveSemaphore()` — logique absorbée par `router.acquire()`
- `recordSuccess()` / `recordFailure()` de `runSingleTurnQuery` — absorbé par `release({ success })`

#### ADR 46.6 — Migration des appels agentic vers `acquireSlot()`

Chaque appel agentic qui construit manuellement un semaphore doit migrer vers `router.acquireSlot()` :

| Appelant | Avant | Après |
|---|---|---|
| Tier 3 (`run.ts:509`) | `ctx.sdkSemaphore.acquire()` | `const { release } = await router.acquireSlot(model)` + `release({ success })` en finally |
| Doc gen Sonnet (`doc-llm-executor.ts:733`) | `if (semaphore) await semaphore.acquire()` | `const { release } = await router.acquireSlot(model)` + `release({ success })` en finally |
| Doc gen Opus (`doc-llm-executor.ts:883`) | `if (semaphore) await semaphore.acquire()` | `const { release } = await router.acquireSlot(model)` + `release({ success })` en finally |
| Doc gen pages (`run.ts:1041`) | aucun semaphore ni breaker | `const { release } = await router.acquireSlot(model)` + `release({ success })` en finally |
| Vercel Agent (`vercel-agent.ts:83`) | aucun semaphore ni breaker | `const { release } = await router.acquireSlot(model)` + `release({ success })` en finally |

**Le router doit être injectable** dans `doc-llm-executor.ts` et `vercel-agent.ts` qui aujourd'hui n'y ont pas accès.

### Fichiers impactés

| Fichier | Action | Complexité |
|---|---|---|
| `src/core/transports/index.ts` | `semaphores`, `breakers`, `acquire()`, `acquireSlot()`, `recordSuccess/Failure()`, `getSemaphoreStats()` | Élevée |
| `src/core/circuit-breaker.ts` | Renommer `GeminiCircuitBreaker` → `CircuitBreaker` | Faible |
| `src/core/axis-evaluator.ts` | Supprimer 4 champs des interfaces, refactor `runSingleTurnQuery` vers `router.acquire()` | Élevée |
| `src/core/file-evaluator.ts` | Supprimer `geminiSemaphore`, `circuitBreaker` de `EvaluateFileOptions` | Faible |
| `src/core/axes/*.ts` (×7) | Supprimer `geminiSemaphore`, `circuitBreaker` des ctx spreads | Faible (mécanique) |
| `src/core/doc-llm-executor.ts` | Injecter router, migrer semaphore → `acquireSlot()` | Moyenne |
| `src/core/agents/vercel-agent.ts` | Injecter router, ajouter `acquireSlot()` | Faible |
| `src/commands/run.ts` | Construire router avec semaphores/breakers. Supprimer `sdkSemaphore`, `geminiSemaphore`, `circuitBreaker`. Migrer Tier 3 + doc gen vers `acquireSlot()` | Élevée |
| `src/cli/pipeline-runner.ts` | Idem run.ts | Moyenne |
| `src/cli/pipeline-state.ts` | Supprimer `geminiSemaphore`, exposer router | Faible |
| `src/cli/screen-renderer.ts` | Utiliser `router.getSemaphoreStats()` | Faible |
| `src/commands/review.ts` | Supprimer construction semaphore/breaker locale | Faible |
| `src/commands/watch.ts` | Idem | Faible |
| `src/rag/orchestrator.ts` | Supprimer `geminiSemaphore` des signatures | Moyenne |
| `src/rag/nlp-summarizer.ts` | Supprimer `geminiSemaphore` | Faible |
| `src/rag/standalone.ts` | Supprimer `geminiSemaphore` | Faible |
| Tests (×15+) | Adapter mocks — mocker le router au lieu de semaphores/breaker individuels | Moyenne |

### Non-périmètre

- **Per-provider retry policy** — le retry (max_retries) reste dans `runSingleTurnQuery`, pas dans le router
- **Breaker per-step dans la boucle agent** — impossible avec les SDKs actuels. Le breaker s'applique autour de l'appel agent complet, pas à chaque step individuel
- **`providers` check** (`commands/providers.ts`) — appel diagnostic, pas de routing ni semaphore nécessaire
- **Rate limit header parsing** — optimisation future
- **Refactor de la config `concurrency`** — le champ existe déjà sur chaque provider
