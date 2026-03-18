# PRD — Anatoly

**Version 0.5.1 • 18 mars 2026**
**Statut** : En développement actif

**Tagline**
Il entre dans ton codebase, trouve le mort, le dupliqué, le superflu et l'over-engineered… et te livre un rapport d'audit chirurgical que seul un agent LLM peut produire.

**Philosophie**
**Coût élevé. Faux positifs = zéro.**
On brûle volontairement des tokens pour acheter de la vérité absolue et de la confiance à 100 %.

## 1. Vision

Anatoly est le premier **Deep Audit Agent** dédié à l'écosystème TypeScript / React / Node.js.

Contrairement aux linters statiques (aveugles au sens) et aux simples revues LLM (sans contexte global ni vérification), Anatoly **enquête** réellement :

- Parse l'AST complet du fichier
- Calcule un hash SHA-256
- Lance un agent Claude Code SDK avec **accès total** au codebase (grep, read, glob)
- Vérifie chaque hypothèse (dead code, duplication sémantique, etc.)
- **(v0.2.0)** Utilise un **RAG sémantique cross-file** pour détecter les similarités de fonctions à travers tout le codebase
- Produit un rapport structuré, validé par Zod, avec transcripts complets de son raisonnement

Anatoly **ne touche jamais** au code. Il ne fait que diagnostiquer avec une précision humaine (voire supérieure). Le développeur reste maître des décisions.

## 2. Problème

### 2.1 Contexte
L'explosion du code généré par IA crée des codebases qui grossissent à une vitesse incontrôlable. Résultat : dead code, duplication sémantique, abstractions inutiles, tests fantômes.

### 2.2 Limites des solutions existantes

| Catégorie              | Outils                     | Limite principale                                      |
|------------------------|----------------------------|--------------------------------------------------------|
| Analyse statique       | SonarQube, ESLint          | Déterministe mais zéro jugement qualitatif/sémantique |
| AI code review         | CodeRabbit, Qodo           | Limité aux PR, pas d'audit global, contexte reset     |
| Prompt manuel          | Claude / GPT sur 1 fichier | Impossible à l'échelle (> 50 fichiers)                 |

### 2.3 Ce qui manque
Un outil qui combine :
1. Rigueur AST (tree-sitter)
2. Intelligence agentique avec outils système
3. Validation stricte Zod + cache intelligent
4. Transparence totale (transcripts)
5. **(v0.2.0)** Détection sémantique cross-file via RAG embarqué

## 3. Utilisateur cible

- Développeurs seniors & Tech Leads TS/React/Node.js
- Équipes qui produisent beaucoup de code avec Claude / Cursor / Windsurf
- Projets de 20 à 1 000+ fichiers
- Budget API non bloquant (ils paient pour gagner 10-30 h par mois)

**Cas d'usage principaux**
- Audit avant gros refactoring
- Nettoyage de dette technique post-sprint
- Contrôle qualité du code généré par IA
- Onboarding sur un legacy
- **(v0.2.0)** Détection de duplications sémantiques invisibles au grep

## 4. Principes de design (non négociables)

1. Anatoly ne modifie **jamais** la logique du code source. Les annotations documentaires (JSDoc) et les fichiers de documentation (`/docs/`) sont dans le périmètre de correction de Ralph.
2. Une mission d'enquête par fichier avec droit total d'investigation cross-codebase.
3. Zod = source de vérité absolue (validation + retry automatique max 3).
4. Cache SHA-256 obligatoire → 0 $ sur les fichiers inchangés.
5. Transparence totale : chaque pensée + tool call est sauvegardé dans un transcript Markdown.
6. Dual output : `.rev.json` (machine) + `.rev.md` (humain).
7. Confidence score (0-100) sur chaque finding pour prioriser.
8. Support monorepo (workspaces, multiples tsconfig) dès v1.
9. **(v0.2.0→v0.4.0)** RAG activé par défaut avec détection hardware automatique. Dual embedding (code + NLP) pour recherche hybride. Zéro dépendance réseau (modèles locaux ONNX).

## 5. Architecture technique

### 5.1 Stack
| Composant           | Choix                          | Justification |
|---------------------|--------------------------------|-------------|
| Runtime             | Node.js 20+ (npx)              | Zéro install |
| Langage             | TypeScript 5.9+                | Focus exclusif |
| AST                 | tree-sitter-typescript + tsx   | Meilleur parser TS/TSX |
| Validation          | Zod 4                          | Schema-driven + inférence |
| LLM                 | Claude Agent SDK               | Agent mode natif |
| CLI                 | Commander.js 14                | Sous-commandes typées |
| CLI Renderer        | listr2                         | Task trees, spinners, CI fallback |
| Cache               | SHA-256 + chokidar             | Watch mode |
| Coverage            | Istanbul / Vitest / Jest       | JSON natif |
| Logging             | pino + AsyncLocalStorage       | Structured logging, per-file context |
| Embeddings (code)   | jinaai/jina-embeddings-v2-base-code (768 dim) | Local ONNX, zéro API |
| Embeddings (NLP)    | all-MiniLM-L6-v2 (384 dim)    | Dual mode pour recherche hybride |
| Embeddings (avancé) | nomic-embed-code 7B (3584 dim) | Mode sidecar GPU, auto-détecté |
| Vector Store        | LanceDB (embedded)             | Natif Node.js, zéro serveur |

### 5.2 Structure dans le projet cible
```
project/
├── src/                          # JAMAIS touché
└── .anatoly/
    ├── config.yml
    ├── tasks/                    # .task.json (AST + hash + coverage)
    ├── cache/
    │   └── progress.json         # statut par fichier (PENDING, DONE, etc.)
    ├── rag/                      # (v0.2.0)
    │   ├── lancedb/              # vector store
    │   └── cache.json            # hash → lastIndexed
    └── runs/                     # (v0.2.0) sorties scopées par run
        ├── latest → <runId>      # symlink vers le dernier run
        └── <YYYY-MM-DD_HHmmss>/  # ou --run-id custom
            ├── reviews/          # .rev.json + .rev.md
            ├── logs/             # transcripts complets
            └── report.md
```

### 5.3 Structure du code source (v0.5.0)
```
src/
├── cli.ts             # Programme Commander.js + options globales
├── index.ts           # Point d'entrée CLI
├── commands/          # Commandes CLI (16 commandes)
│   ├── run.ts         # Pipeline complet
│   ├── scan.ts        # Parsing AST
│   ├── estimate.ts    # Estimation tokens/coût
│   ├── review.ts      # Évaluation multi-axes
│   ├── report.ts      # Génération rapport
│   ├── watch.ts       # Mode surveillance
│   ├── status.ts      # État du pipeline
│   ├── rag-status.ts  # Inspection index RAG
│   ├── init.ts        # Initialisation projet
│   ├── hook.ts        # Gestion hooks Claude Code
│   ├── clean.ts       # Nettoyage général
│   ├── clean-runs.ts  # Purge anciens runs
│   ├── clean-run.ts   # Suppression d'un run spécifique
│   ├── clean-sync.ts  # Synchronisation cache/reviews
│   ├── reset.ts       # Réinitialisation complète
│   └── setup-embeddings.ts  # Installation modèles embedding
├── core/              # Logique métier
│   ├── scanner.ts     # Parsing AST tree-sitter
│   ├── estimator.ts   # Estimation tiktoken
│   ├── triage.ts      # Intelligence pré-review (skip/fast/deep)
│   ├── usage-graph.ts # Graphe d'usage inter-fichiers
│   ├── file-evaluator.ts   # Orchestrateur d'axes par fichier
│   ├── axis-evaluator.ts   # Framework d'évaluation single-turn
│   ├── axis-merger.ts      # Fusion résultats multi-axes + cohérence
│   ├── deliberation.ts     # Passe Opus post-merge
│   ├── correction-memory.ts # Mémoire des faux positifs
│   ├── dependency-meta.ts  # Contexte dépendances locales
│   ├── worker-pool.ts      # Parallélisation reviews
│   ├── reporter.ts         # Génération rapport agrégé
│   ├── review-writer.ts    # Écriture .rev.json + .rev.md
│   ├── badge.ts            # Injection badge README
│   ├── calibration.ts      # Calibration des seuils
│   ├── progress-manager.ts # Gestion progress.json
│   ├── project-tree.ts     # Arborescence projet
│   └── axes/               # 6 évaluateurs d'axes
│       ├── index.ts         # Registre des axes
│       ├── utility.ts       # Axe utility (USED/DEAD/LOW_VALUE)
│       ├── duplication.ts   # Axe duplication (UNIQUE/DUPLICATE)
│       ├── correction.ts    # Axe correction (OK/NEEDS_FIX/ERROR)
│       ├── overengineering.ts # Axe overengineering (LEAN/OVER/ACCEPTABLE)
│       ├── tests.ts         # Axe tests (GOOD/WEAK/NONE)
│       ├── best-practices.ts # Axe best practices (score 0-10, 17 règles)
│       └── prompts/         # Prompts système en Markdown
├── schemas/           # Schémas Zod (source de vérité)
│   ├── config.ts      # ConfigSchema (.anatoly.yml)
│   ├── review.ts      # ReviewFileSchema v2
│   ├── task.ts        # TaskSchema (.task.json)
│   └── progress.ts    # ProgressSchema
├── utils/             # Utilitaires cross-cutting
│   ├── logger.ts      # Logger pino structuré
│   ├── log-context.ts # AsyncLocalStorage context
│   ├── config-loader.ts # Chargement + merge config
│   ├── errors.ts      # AnatolyError + codes
│   ├── cache.ts       # Cache SHA-256
│   ├── lock.ts        # Lock file protection
│   ├── rate-limiter.ts # Rate limiting API
│   └── ...            # format, git, banner, etc.
└── rag/               # Module RAG sémantique
    ├── types.ts       # FunctionCard schema + types
    ├── embeddings.ts  # Gestionnaire d'embeddings multi-modèle
    ├── hardware-detect.ts  # Détection GPU/CPU pour sélection modèle
    ├── nlp-summarizer.ts   # Résumés NLP pour dual embedding
    ├── embed-sidecar.ts    # Mode sidecar pour nomic-embed-code 7B
    ├── vector-store.ts     # Wrapper LanceDB + recherche hybride
    ├── indexer.ts     # Indexation incrémentale + extraction AST
    ├── orchestrator.ts # Orchestration du pipeline d'indexation
    └── index.ts       # Barrel export
```

## 6. Format de Review & Contrat Zod (cœur du produit)

### 6.1 Les 7 axes d'analyse
| Axe               | Valeurs possibles               | Modèle par défaut | Mesure |
|-------------------|----------------------------------|--------------------|--------|
| utility           | USED, DEAD, LOW_VALUE           | Haiku | Utilisé ? (grep obligatoire pour DEAD) |
| duplication       | UNIQUE, DUPLICATE               | Haiku | Logique dupliquée ailleurs ? (RAG hybride code+NLP) |
| correction        | OK, NEEDS_FIX, ERROR            | Sonnet | Le code fait-il ce qu'il prétend ? |
| overengineering   | LEAN, OVER, ACCEPTABLE          | Haiku | Complexité proportionnelle ? |
| tests             | GOOD, WEAK, NONE                | Haiku | Couverture + qualité des tests |
| best_practices    | Score 0-10, 17 règles           | Sonnet | Conformité aux best practices TS/React |
| documentation     | DOCUMENTED, PARTIAL, UNDOCUMENTED | Haiku | JSDoc inline + couverture /docs/ |
| **confidence**    | 0-100 (par symbole)             | — | Niveau de certitude du verdict |

Chaque axe supporte la valeur spéciale `'-'` quand il est désactivé via `--axes` ou la config.

**(v0.3.0)** Tous les axes s'exécutent en parallèle via `Promise.allSettled` — un axe en erreur ne bloque pas les autres.

**(v0.4.0)** Best practices ajouté comme 6ème axe, évaluation file-level (17 règles couvrant naming, error handling, React patterns, etc.).

**(v0.6.0)** Documentation ajouté comme 7ème axe. Évalue la couverture JSDoc inline (per-symbol: DOCUMENTED/PARTIAL/UNDOCUMENTED) et optionnellement la couverture conceptuelle `/docs/` (per-concept: COVERED/PARTIAL/MISSING/OUTDATED). Modèle Haiku par défaut.

### 6.3 Opus Deliberation Pass (v0.5.0)

Étape post-merge optionnelle qui arbitre la cohérence des findings avec Opus.

**Principe :** Les 7 axes produisent chacun un verdict indépendant. Le merger les fusionne mécaniquement. Mais aucune intelligence ne valide la *cohérence globale* du tableau complet. L'Opus Deliberation Pass est un **juge de délibération** qui reçoit le `ReviewFile` fusionné + le code source et décide si les findings sont cohérents entre eux.

**Rôle :**
1. Valider la cohérence inter-axes (ex: tests=WEAK mais code trivial et correct → le finding est-il pertinent ?)
2. Filtrer les faux positifs résiduels qu'un modèle plus puissant peut détecter
3. Ajuster les confidences et reclassifier les findings si nécessaire
4. Recalculer le verdict final en connaissance de cause

**Ce qu'il ne fait PAS :**
- Réévaluer chaque axe depuis zéro
- Ajouter de nouveaux findings non détectés par les axes
- Modifier la structure du `ReviewFile` (même schéma Zod)

**Activé par défaut** depuis v0.5.0 (`deliberation: true` dans `.anatoly.yml`). Désactivable via `--no-deliberation`.

**Déclenchement conditionnel :** Opus ne s'exécute que quand il y a matière à délibérer :
- Au moins un symbole avec NEEDS_FIX, ERROR, DEAD, DUPLICATE, ou OVER
- OU une contradiction détectée entre axes
- OU un verdict non-CLEAN

Les fichiers CLEAN avec haute confidence (95%+) passent directement sans surcoût.

**Impact coût :** Opus ~10× Sonnet par requête, mais ne s'exécute que sur ~25% des fichiers → surcoût moyen acceptable pour la qualité de verdict.

### 6.2 Schéma Zod complet (v2 — v0.5.0)

```ts
import { z } from "zod";

const Verdict = z.enum(["CLEAN", "NEEDS_REFACTOR", "CRITICAL"]);
const Severity = z.enum(["high", "medium", "low"]);
const Effort = z.enum(["trivial", "small", "large"]);
const Category = z.enum(["quickwin", "refactor", "hygiene"]);
const AxisId = z.enum([
  "utility", "duplication", "correction",
  "overengineering", "tests", "best_practices",
  "documentation",
]);

const SymbolReview = z.object({
  name: z.string(),
  kind: z.enum(["function", "class", "method", "type", "constant", "variable", "enum", "hook"]),
  exported: z.boolean(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),

  // Les 5 axes per-symbol — chaque axe supporte '-' quand désactivé
  correction: z.enum(["OK", "NEEDS_FIX", "ERROR", "-"]),
  overengineering: z.enum(["LEAN", "OVER", "ACCEPTABLE", "-"]),
  utility: z.enum(["USED", "DEAD", "LOW_VALUE", "-"]),
  duplication: z.enum(["UNIQUE", "DUPLICATE", "-"]),
  tests: z.enum(["GOOD", "WEAK", "NONE", "-"]),
  documentation: z.enum(["DOCUMENTED", "PARTIAL", "UNDOCUMENTED", "-"]).default("-"),

  confidence: z.int().min(0).max(100),

  detail: z.string().min(10),
  duplicate_target: z.object({
    file: z.string(),
    symbol: z.string(),
    similarity: z.string(),
  }).nullable().optional(),
});

const Action = z.object({
  id: z.int().min(1),
  description: z.string().min(1),
  severity: Severity,
  effort: Effort.default("small"),
  category: Category.default("refactor"),
  source: AxisId.optional(),              // (v2) Axe source de l'action
  target_symbol: z.string().nullable(),
  target_lines: z.string().nullable(),
});

// (v0.4.0) Best practices — évaluation file-level
const BestPracticesRule = z.object({
  rule_id: z.int().min(1).max(17),
  rule_name: z.string().min(1),
  status: z.enum(["PASS", "WARN", "FAIL"]),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM"]),
  detail: z.string().optional(),
  lines: z.string().optional(),
});

const BestPractices = z.object({
  score: z.number().min(0).max(10),
  rules: z.array(BestPracticesRule),
  suggestions: z.array(z.object({
    description: z.string(),
    before: z.string().optional(),
    after: z.string().optional(),
  })).default([]),
});

// (v2) Métadonnées par axe
const AxisMetaEntry = z.object({
  model: z.string(),
  cost_usd: z.number().min(0),
  duration_ms: z.number().min(0),
});

export const ReviewFileSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),  // Backward-compatible
  file: z.string(),
  is_generated: z.boolean().default(false),
  skip_reason: z.string().optional(),

  verdict: Verdict,
  symbols: z.array(SymbolReview),
  actions: z.array(Action).default([]),

  file_level: z.object({
    unused_imports: z.array(z.string()).default([]),
    circular_dependencies: z.array(z.string()).default([]),
    general_notes: z.string().default(""),
  }),

  // (v0.4.0) Best practices
  best_practices: BestPractices.optional(),

  // (v2) Métadonnées par axe — coût, durée, modèle utilisé
  axis_meta: z.record(AxisId, AxisMetaEntry.optional()).optional(),

  // (v0.5.0) Résumé de la passe de délibération Opus
  deliberation: z.object({
    verdict_before: Verdict,
    verdict_after: Verdict,
    reclassified: z.int().min(0),
    actions_removed: z.int().min(0),
    reasoning: z.string(),
  }).optional(),
});
```

## 7. Phases détaillées

### 7.1 `anatoly scan`
- Parse tous les `**/*.ts` et `**/*.tsx`
- Extrait AST + exports
- Calcule hash SHA-256
- Parse coverage Istanbul
- Détecte monorepo (workspaces, tsconfig)
- Génère `.task.json` + met à jour `progress.json`

### 7.2 `anatoly estimate`
Utilise tiktoken en local pour compter les tokens (input/output estimés) — zéro appel LLM, zéro coût.
Sortie en tokens et temps estimé (±8 %). Pas de prix affiché (utilisateurs forfaitaires).

### 7.3 `anatoly review` (game-changer)

**Prompt système (extrait optimisé avec few-shots)**

```markdown
You are Anatoly, the most rigorous code auditor in the world.

File: {{file_path}}

Rules (NE JAMAIS déroger) :
- NEVER guess. Use tools (Grep, Read, Glob) for every claim.
- DEAD → must have zero matches after full grep
- DUPLICATE → must use findSimilarFunctions (RAG) ou read the target file
- Confidence 100 = bulletproof evidence
```

Tout le raisonnement est streamé en temps réel dans `logs/{file}.transcript.md`.

Zod validation + retry automatique (max 3) avec feedback d'erreur.

**(v0.2.0)** Quand RAG activé, l'agent de review reçoit le tool `findSimilarFunctions` via MCP server. Ce tool interroge l'index LanceDB peuplé en Phase 3 (index). Les FunctionCards ne sont **pas** incluses dans le `.rev.json` — elles vivent exclusivement dans LanceDB et sont consultables via `anatoly rag-status`.

**(v0.5.0)** Quand `deliberation: true` dans `.anatoly.yml` (ou `--deliberation` CLI) :
- Après la fusion des 6 axes, si le fichier n'est pas CLEAN avec haute confidence :
- Un appel Opus valide la cohérence inter-axes du `ReviewFile` fusionné
- Opus peut ajuster les confidences, reclassifier des findings, et recalculer le verdict
- Le `ReviewFile` est écrasé par la version délibérée (même schéma Zod v2)
- Le transcript de délibération est appendé au `.log` du fichier
- `axis_meta.deliberation` capture le coût et la durée de la passe Opus

### 7.4 `anatoly index` (Phase 3 du pipeline)
Phase exécutée **avant** la review (RAG activé par défaut depuis v0.4.0, désactivable via `--no-rag`) :
- Génère les champs sémantiques (summary, keyConcepts, behavioralProfile) via **Haiku** (`nlp-summarizer.ts`)
- Calcule les champs dérivables (signature, complexityScore, calledInternals) localement via AST (`indexer.ts`)
- Dual embedding automatique :
  - **Code** : jinaai/jina-embeddings-v2-base-code (768 dim) ou nomic-embed-code 7B via sidecar GPU (3584 dim, auto-détecté par `hardware-detect.ts`)
  - **NLP** : all-MiniLM-L6-v2 (384 dim) pour résumés textuels
- Recherche hybride code+NLP pondérée (`code_weight: 0.6` par défaut)
- Upsert incrémental dans LanceDB (`.anatoly/rag/lancedb/`)
- Cache par hash de fichier : seuls les fichiers modifiés sont ré-indexés
- Orchestré par `orchestrator.ts` qui coordonne le pipeline complet

### 7.5 `anatoly report`
Agrégation de tous les `.rev.json` → tableaux triés, dead code list, duplications groupées, actions priorisées, résumé exécutif.

**(v0.2.0)** Section ajoutée :
- Section « Duplications sémantiques » dans `report.md` (basée sur les findings de l'agent via RAG)

### 7.6 `anatoly watch` (killer feature)
Mode daemon (chokidar) → re-scan + re-review uniquement les fichiers modifiés → `report.md` mis à jour en live.

## 8. Configuration (.anatoly.yml)

```yaml
project:
  name: "my-ts-project"
  monorepo: true                        # default: false

scan:
  include:
    - "src/**/*.ts"
    - "src/**/*.tsx"
    - "packages/*/src/**/*.ts"
  exclude:
    - "node_modules/**"
    - "dist/**"
    - "**/*.test.ts"
    - "**/*.spec.ts"

coverage:
  enabled: true
  command: "npx vitest run --coverage.reporter=json"
  report_path: "coverage/coverage-final.json"

llm:
  model: "claude-sonnet-4-6"            # modèle principal (axes Sonnet)
  index_model: "claude-haiku-4-5-20251001"  # modèle RAG indexation + axes Haiku
  fast_model: "claude-haiku-4-5-20251001"   # override optionnel pour axes Haiku
  agentic_tools: true
  timeout_per_file: 600                  # secondes (default: 600)
  max_retries: 3
  concurrency: 4                         # reviews parallèles (1-10)
  min_confidence: 70                     # seuil confidence pour findings (0-100)
  max_stop_iterations: 3                 # itérations boucle d'auto-correction
  deliberation: true                     # passe Opus post-merge (default: true depuis v0.5.0)
  deliberation_model: "claude-opus-4-6"
  axes:                                  # activation/override par axe
    utility:        { enabled: true }
    duplication:    { enabled: true }
    correction:     { enabled: true }
    overengineering: { enabled: true }
    tests:          { enabled: true }
    best_practices: { enabled: true }
    # documentation: { enabled: true }   # (v0.6.0 prévu)

rag:
  enabled: true                          # default: true depuis v0.4.0 (--no-rag pour désactiver)
  code_model: "auto"                     # auto-détection hardware (jina 768d ou nomic 3584d)
  nlp_model: "auto"                      # all-MiniLM-L6-v2 pour dual embedding
  code_weight: 0.6                       # poids code dans recherche hybride (0-1)

badge:
  enabled: true                          # injection badge README post-audit
  verdict: false                         # inclure le verdict dans le badge
  link: "https://github.com/r-via/anatoly"

logging:
  level: "warn"                          # fatal, error, warn, info, debug, trace
  pretty: true                           # pino-pretty pour dev (false en CI)
  # file: ".anatoly/runs/latest/anatoly.log"  # optionnel, écriture ndjson

output:
  max_runs: 10                           # nombre max de runs conservés
```

## 9. CLI Reference complète (v0.5.1)

### Commandes

```bash
# Pipeline
npx anatoly run              # scan → estimate → triage → [index] → review → deliberation → report → badge
npx anatoly watch            # mode live (chokidar)

# Étapes individuelles
npx anatoly scan             # parsing AST + hash + coverage
npx anatoly estimate         # estimation tokens/coût (tiktoken, zéro LLM)
npx anatoly review           # évaluation multi-axes
npx anatoly report           # génération rapport agrégé

# Inspection
npx anatoly status           # état du pipeline (progress.json)
npx anatoly rag-status [fn]  # inspection index RAG

# Configuration
npx anatoly init             # initialisation projet (.anatoly.yml)
npx anatoly hook             # gestion hooks Claude Code
npx anatoly setup-embeddings # installation modèles embedding

# Nettoyage
npx anatoly clean            # nettoyage général
npx anatoly clean-runs       # purge anciens runs (respecte output.max_runs)
npx anatoly clean-run <id>   # suppression d'un run spécifique
npx anatoly clean-sync       # synchronisation cache/reviews
npx anatoly reset            # réinitialisation complète (.anatoly/)
```

### Options globales

| Option | Description | Default |
|--------|-------------|---------|
| `--config <path>` | Chemin vers `.anatoly.yml` | auto-détecté |
| `--verbose` | Logs détaillés | off |
| `--no-cache` | Ignore le cache SHA-256, re-review tout | off |
| `--file <glob>` | Restreindre le scope aux fichiers matchés | tous |
| `--plain` | Output linéaire (sans log-update) | auto (TTY) |
| `--no-color` | Désactiver les couleurs (respecte aussi `$NO_COLOR`) | off |
| `--concurrency <n>` | Nombre de reviews parallèles (1-10) | 4 |
| `--dry-run` | Simuler : scan, estimate, triage, puis afficher ce qui serait fait | off |
| `--open` | Ouvrir le rapport dans l'app par défaut après génération | off |

### Options RAG

| Option | Description | Default |
|--------|-------------|---------|
| `--no-rag` | Désactiver le RAG sémantique | activé |
| `--rebuild-rag` | Forcer la réindexation complète | off |
| `--rag-lite` | Forcer le mode lite (Jina dual embedding ONNX) | auto |
| `--rag-advanced` | Forcer le mode avancé (nomic-embed-code sidecar GPU) | auto |
| `--code-model <model>` | Override modèle embedding code | auto-détecté |
| `--nlp-model <model>` | Override modèle embedding NLP (dual mode) | auto-détecté |

### Options d'analyse

| Option | Description | Default |
|--------|-------------|---------|
| `--no-triage` | Désactiver le triage, review complète sur tous les fichiers | off |
| `--deliberation` | Activer la passe Opus post-merge | activé |
| `--no-deliberation` | Désactiver la délibération | off |
| `--no-badge` | Ne pas injecter le badge README | off |
| `--badge-verdict` | Inclure le verdict dans le badge | off |

### Options logging

| Option | Description | Default |
|--------|-------------|---------|
| `--log-level <level>` | Niveau de log (fatal/error/warn/info/debug/trace) | warn |
| `--log-file <path>` | Écrire les logs dans un fichier (ndjson) | off |

### Options de `rag-status`

- `--all` : lister toutes les FunctionCards indexées (groupées par fichier)
- `--json` : sortie JSON pour intégration programmatique
- `[function]` : inspecter une fonction spécifique par nom

## 10. Flux de données

```
Codebase (TS/TSX)
      ↓
[scan] → AST + hash + coverage → .tasks/
      ↓
[estimate] → coût précis (tiktoken local)
      ↓
[triage] → skip/fast/deep par fichier (usage graph + heuristiques)
      ↓
[index] → Haiku → FunctionCards → dual embeddings (code+NLP) → LanceDB
      ↓
[review] → 6 axes en parallèle (Promise.allSettled) → transcripts + .rev.json (Zod v2)
      ↓
[deliberation] → Opus valide cohérence inter-axes → .rev.json ajusté
      ↓
[report] → report.md shardé (index + shards) → .anatoly/runs/<runId>/
      ↓
[badge] → injection badge README (optionnel)
```

## 11. RAG sémantique cross-file (v0.2.0→v0.5.0)

### 11.1 FunctionCard
Chaque fonction/méthode/hook est décrite par une carte stockée dans LanceDB (consultable via `anatoly rag-status`) :

| Champ | Source | Description |
|-------|--------|-------------|
| id | AST (sha256 tronqué 16 chars) | Identifiant déterministe basé sur filePath:lineStart-lineEnd |
| filePath | Task | Chemin relatif du fichier source |
| name | LLM (Haiku) | Nom de la fonction |
| signature | AST (extraction) | Première ligne(s) de la fonction (max 200 chars) |
| complexityScore | AST (heuristique cyclomatique) | Score 1-5 |
| calledInternals | AST (call_expression) | Fonctions internes appelées |
| summary | LLM (Haiku) | Résumé conceptuel ≤400 chars |
| keyConcepts | LLM (Haiku) | 1-6 mots-clés |
| behavioralProfile | LLM (Haiku) | pure, sideEffectful, async, memoized, stateful, utility |
| lastIndexed | Système | Timestamp ISO de dernière indexation |

### 11.2 Tool `findSimilarFunctions`
- Disponible pour l'agent pendant la review (quand l'index est peuplé)
- Remplace la détection de duplication grep-based
- Seuils : ≥0.85 → DUPLICATE, 0.78-0.85 → mentionné dans detail

### 11.3 Embeddings (v0.5.0 — dual embedding + hardware detection)

Détection automatique du hardware (`hardware-detect.ts`) pour sélectionner le meilleur modèle :

| Mode | Modèle code | Dimensions | Modèle NLP | Conditions |
|------|------------|------------|------------|------------|
| Lite (défaut) | jinaai/jina-embeddings-v2-base-code | 768 | all-MiniLM-L6-v2 (384) | CPU, ONNX local |
| Avancé | nomic-embed-code 7B | 3584 | all-MiniLM-L6-v2 (384) | GPU détecté, mode sidecar |

- **Recherche hybride** : pondération code × `code_weight` + NLP × `(1 - code_weight)` (défaut : 0.6/0.4)
- Installation modèles : `npx anatoly setup-embeddings` ou auto-téléchargement au premier run
- Mode sidecar (`embed-sidecar.ts`) : process séparé pour nomic-embed-code 7B

### 11.4 Dépendances
```json
{
  "@xenova/transformers": "^2.17.2",
  "@lancedb/lancedb": "^0.26.2"
}
```

## 12. Écosystème ciblé

- TypeScript + TSX : P0 (tree-sitter)
- Monorepo (Yarn/PNPM/Nx/Turbo) : P0
- Coverage Jest/Vitest : P0
- Autres langages : hors scope

## 13. Limites assumées & honnêteté

- Coût élevé → compensé par cache très agressif
- Lenteur → tourne en tâche de fond + timeout 10 min/fichier + parallélisation (4 workers)
- Dépendance Claude Code SDK → documenté dans README
- Boîte noire → totalement ouverte via transcripts
- **(v0.2.0)** Modèle embedding local (~23 MB) → téléchargé une seule fois au postinstall

## 14. Métriques de succès

- Faux positifs DEAD < 3 %
- Validation Zod première passe > 97 %
- Deuxième run sur codebase inchangée < 4 s et 0 $
- Temps moyen premier rapport < 45 min
- **(v0.5.0)** Faux positifs correction (avec délibération) < 1 %
- **(v0.5.0)** Taux de reclassification par Opus : 15-30 % des fichiers non-CLEAN

## 15. Roadmap

**v0.1.0 – 23 février 2026** (livré)
- Core complet : scan, estimate, review, report
- 5 axes + confidence + transcripts
- Cache SHA-256 + monorepo
- Watch mode

**v0.2.0 – 24 février 2026** (livré)
- RAG sémantique cross-file (FunctionCards + LanceDB + embeddings locaux)
- FunctionCards générées par Haiku en phase d'indexation (avant la review)
- Extraction AST : signature, complexityScore, calledInternals
- Sorties scopées par run (`.anatoly/runs/<runId>/`) avec symlink `latest`
- Commande `rag-status` pour inspecter l'index RAG
- Rotation automatique des runs (`output.max_runs`)

**v0.3.0 – 27 février 2026** (livré)
- Parallélisation des reviews (worker pool, rate limiting)
- Listr2 CLI renderer (task trees, spinners, CI fallback)
- Intelligence pré-review : triage (skip/fast/deep) + graphe d'usage
- Fast review sans tools pour fichiers simples
- Report shardé (index + shards de 10 fichiers)
- Contexte structurel (arborescence projet injectée dans les prompts)
- Prompts externalisés en fichiers Markdown dédiés (build-time via esbuild)
- Claude Code hook integration (PostToolUse + Stop autocorrection loop)

**v0.4.0 – mars 2026** (livré)
- Opus Deliberation Pass — validation post-merge de la cohérence inter-axes
- Best practices : 6ème axe (score 0-10, 17 règles TS/React)
- Correction memory — apprentissage des faux positifs (correction-memory.json)
- Two-pass correction — vérification contre la documentation locale des dépendances
- Observabilité : pino logging structuré, AsyncLocalStorage context, per-run ndjson
- Code embedding local (jinaai/jina-embeddings-v2-base-code, 768-dim, zéro API)
- Dual embedding (code + NLP) avec recherche hybride pondérée
- Hardware auto-detection pour sélection du modèle d'embedding
- Codebase hygiene (dead code removal, bug fixes, dedup verification)
- README badge injection
- Documentation overhaul (13 docs exhaustifs)

**v0.5.0 – mars 2026** (livré)
- Deliberation activée par défaut
- Commandes CLI additionnelles : `init`, `hook`, `clean`, `clean-run`, `clean-sync`, `setup-embeddings`
- Options CLI enrichies : `--dry-run`, `--open`, `--no-triage`, `--log-level`, `--log-file`
- RAG activé par défaut (opt-out via `--no-rag`)
- Mode sidecar pour nomic-embed-code 7B (GPU auto-détecté)
- Config per-axis (`llm.axes.*`) pour activation/override de modèle

**v0.6.0 – mars 2026** (livré)
- Documentation Axis — 7ème axe d'audit de couverture documentaire (JSDoc inline per-symbol + /docs/ concept coverage)
- docs-resolver avec config mapping + convention fallback
- Coherence rules : DEAD → UNDOCUMENTED, actions pour UNDOCUMENTED/PARTIAL
- Reporter : colonne `doc` dans les findings, Documentation dans axis summary + methodology

**v0.7.0 – À planifier**
- Ralph integration — boucle d'auto-correction pour traiter les findings du report
- Rapport HTML interactif

**v1.0 – À planifier**
- Multi-langage
- Mode équipe (cache partagé)
- CI integration
- Export vers outils (Cursor, Windsurf, Aider)

## 16. Non-goals

- Correcteur automatique de logique métier (la correction documentaire via Ralph est in-scope)
- Linter de style ou formatting
- Outil de sécurité / SAST
- Bot CI bloquant sur chaque push

---

**Anatoly**
Il ne fait pas le ménage.
Il te montre exactement où est la poussière, avec les preuves, la confiance et le transcript.

Tu valides. Tu corriges. Tu dors tranquille.
