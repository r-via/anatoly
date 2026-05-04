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
  > As a développeur d'anatoly
  > I want un registre centralisé des providers d'embedding avec leurs URLs, env vars, contraintes batch et hooks
  > So that ajouter un provider d'embedding nécessite une seule entrée dans le registre, pas un nouveau fichier transport.
  > AC: Given `src/rag/known-embedding-providers.ts` existe, When il est importé, Then `KNOWN_EMBEDDING_PROVIDERS` contient au minimum les entrées : `openai`, `voyage`, `qwen`, `cohere`, `mistral`, `anatoly-local`, And chaque entrée a la forme `{ base_url: string | null | ((kind) => string), env_key: string | null, type: 'native' | 'openai-compatible', max_per_call?: number, supports_parallel?: boolean, default_code_model?: string, default_nlp_model?: string, pre_hook?: (kind) => Promise<void> }`
  > AC: Given l'entrée `openai`, When elle est lue, Then `base_url: null` (SDK natif), And `env_key: 'OPENAI_API_KEY'`, And `type: 'native'`, And `default_code_model: 'text-embedding-3-large'`, And `default_nlp_model: 'text-embedding-3-large'`, And pas de `max_per_call` ni `supports_parallel` (= défauts SDK 2048/true)
  > AC: Given l'entrée `voyage`, When elle est lue, Then `base_url: 'https://api.voyageai.com/v1'`, And `env_key: 'VOYAGE_API_KEY'`, And `type: 'openai-compatible'`, And `default_code_model: 'voyage-code-3'` (référence code retrieval, SOTA sur CoIR), And `default_nlp_model: 'voyage-3-large'`
  > AC: Given l'entrée `qwen`, When elle est lue, Then `base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'` (réutilise littéralement la valeur d'`KNOWN_PROVIDERS['qwen']` LLM d'Epic 43, [src/core/providers/known-providers.ts:38-42](src/core/providers/known-providers.ts#L38-L42)), And `env_key: 'DASHSCOPE_API_KEY'` (idem Epic 43), And `type: 'openai-compatible'`, And `default_code_model: 'text-embedding-v4'` (à vérifier empiriquement avant freeze — voir note d'implémentation Story 50.2 ci-dessous), And `default_nlp_model: 'text-embedding-v4'` (parité avec mode advanced GGUF Qwen3-Embedding-8B en open weights)
  > AC: Given l'entrée `anatoly-local`, When elle est lue, Then `base_url: (kind) => kind === 'code' ? 'http://127.0.0.1:11437/v1' : 'http://127.0.0.1:11438/v1'`, And `env_key: null` (pas de clé requise), And `type: 'openai-compatible'`, And `max_per_call: 16` (= ancien `MAX_GGUF_BATCH_SIZE`, évite OOM container), And `supports_parallel: false` (single container actif, hot-swap exclusif), And `default_code_model: 'nomic-embed-code'` (chaîne arbitraire — llama.cpp ignore le field `model`), And `default_nlp_model: 'qwen3-embedding-8b'`, And `pre_hook: async (kind) => ensureModel(kind)` (déclenche le hot-swap docker)
  > AC: Given `resolveEmbeddingProvider(providerId, configOverrides)` est implémenté, When `providerId` est dans le registre, Then il retourne l'entrée mergée avec les overrides (config YAML > registre)
  > AC: Given `providerId` n'est PAS dans le registre, When appelé, Then si `configOverrides.base_url` est fourni, traité comme `openai-compatible` avec env_key `{PROVIDER}_API_KEY` par défaut, And sinon une erreur claire est levée : `Unknown embedding provider "X" — add base_url in .anatoly.yml`
  > AC: Given un test du registre vérifie qu'aucun bug d'orthographe, When la table est validée, Then chaque `env_key` ne contient que `[A-Z0-9_]`, And chaque `base_url` (si non-null et non-fonction) est une URL valide se terminant par `/v1`
  > Spec: specs/planning-artifacts/epic-50-embedding-provider-abstraction.md#story-50-2
- [ ] Story 50.3: Factory `getVercelEmbeddingModel` + probe dim runtime + cache signature
  > As a développeur du pipeline d'embedding
  > I want une factory unique qui retourne un `EmbeddingModelV3` du Vercel AI SDK pour n'importe quel provider connu ou custom
  > So that le call-site `embeddings.ts` ne connaît qu'une API uniforme et le routing par provider est centralisé.
  > AC: Given `src/rag/sdk-embedding.ts` est créé, When `getVercelEmbeddingModel(kind, modelId, config)` est appelé avec `kind: 'code' | 'nlp'`, Then il extrait le provider du modelId (via `extractProvider` de `core/transports/index.ts`, réutilisé), And il résout le provider via `resolveEmbeddingProvider`, And pour `type: 'native'` + `provider === 'openai'` → retourne `openai.textEmbedding(modelId)` de `@ai-sdk/openai`, And pour `type: 'openai-compatible'` → retourne `createOpenAICompatible({ baseURL, name, apiKey, headers? }).textEmbeddingModel(modelId)` avec `maxEmbeddingsPerCall` et `supportsParallelCalls` du registre passés via `providerOptions` au call-site
  > AC: Given le provider a `base_url` sous forme de fonction (cas `anatoly-local`), When la factory est appelée avec `kind: 'code'`, Then `baseURL: 'http://127.0.0.1:11437/v1'`, When appelée avec `kind: 'nlp'`, Then `baseURL: 'http://127.0.0.1:11438/v1'`
  > AC: Given le provider a un `pre_hook`, When un wrapper `EmbeddingModel` est retourné, Then son `doEmbed` exécute `await pre_hook(kind)` avant de déléguer au modèle SDK sous-jacent, And si le hook throw, l'erreur remonte sans appeler le SDK
  > AC: Given la clé API est requise (`env_key !== null`) et absente, When la factory est appelée, Then une `AnatolyError` claire est throw : `No API key for embedding provider "X". Set {ENV_KEY} in your environment.`
  > AC: Given la clé API n'est PAS requise (`env_key === null`, cas `anatoly-local`), When la factory est appelée, Then `apiKey: ''` est passé au SDK (placeholder accepté par `createOpenAICompatible`)
  > AC: Given `probeEmbeddingDim(model, kind)` est implémenté, When appelé avec un modèle dont la dim n'est pas dans `MODEL_REGISTRY`, Then il appelle `embed({ model, value: 'anatoly probe ' + kind })` du SDK, And retourne `embedding.length`
  > AC: Given `getEmbeddingSignature(provider, codeModel, nlpModel)` est implémenté, When appelé, Then retourne un hash SHA256 court (8 hex) de `${provider}|${codeModel}|${nlpModel}`
  > AC: Given `ensureEmbeddingDims(resolved, ctx)` est implémenté, When un `embeddings-ready.json` existe avec `embedding_signature` matchant la config courante, Then les `dim_code`/`dim_nlp` du flag sont utilisés directement (skip probe), When la signature ne match pas (config changée) ou est absente, Then `probeEmbeddingDim` est appelé pour code et nlp, And le flag est mis à jour avec les nouvelles `dim_code`, `dim_nlp` et `embedding_signature`, And un log info indique le probe : `"embedding dims probed: code=N, nlp=M (signature=XXXXXXXX)"`
  > Spec: specs/planning-artifacts/epic-50-embedding-provider-abstraction.md#story-50-3
- [ ] Story 50.4: Refacto `embeddings.ts` runtime `'sdk'` + suppression code legacy GGUF + parsing 3-formats
  > As a mainteneur d'anatoly
  > I want que `embeddings.ts` ait un seul chemin SDK pour advanced+external (et l'ONNX intact pour lite)
  > So that ~140 lignes de fetch + retry + parsing manuel disparaissent et que les futurs providers se branchent sans toucher `embeddings.ts`.
  > AC: Given `src/rag/embeddings.ts` est refactoré, When le module est lu, Then le type `Runtime` interne est `'onnx' | 'sdk'` (au lieu de `'onnx' | 'gguf'`), And les fonctions `embedViaGguf` (lignes 187-232), `embedBatchViaGgufSingle` (241-277), `embedBatchViaGguf` (283-295) sont supprimées, And les constantes `MAX_GGUF_CHARS` (172) et `MAX_GGUF_BATCH_SIZE` (235) sont supprimées (les valeurs migrent dans le registre via `max_per_call`), And l'import de `ensureModel` de `./docker-gguf.js` (ligne 6) est supprimé (le pre_hook est dans `sdk-embedding.ts`)
  > AC: Given `configureModels(resolved)` est étendu, When `resolved.codeRuntime === 'sdk'`, Then un `EmbeddingModelV3` est instancié via `getVercelEmbeddingModel('code', resolved.codeModel, resolved._config)` et caché en module-state (variable `codeSdkModel`), When `resolved.codeRuntime === 'onnx'`, Then le comportement actuel est strictement préservé (pas de SDK)
  > AC: Given `embedCode(text)` est appelé avec `codeRuntime === 'sdk'`, When la fonction s'exécute, Then elle appelle `await embed({ model: codeSdkModel, value: text })` du package `ai`, And retourne `embedding` (number[]) tel quel
  > AC: Given `embedCodeBatch(texts)` est appelé avec `codeRuntime === 'sdk'`, When la fonction s'exécute, Then elle appelle `await embedMany({ model: codeSdkModel, values: texts })` du package `ai`, And retourne `embeddings` (number[][]), And le SDK gère le chunking automatique selon `maxEmbeddingsPerCall` du registre
  > AC: Given `embedNlp` et `embedNlpBatch` (mêmes patterns), When elles sont appelées avec `nlpRuntime === 'sdk'`, Then elles utilisent `nlpSdkModel` (cache séparé du code)
  > AC: Given un `text` est trop long pour le modèle external, When `embedCode(text)` est appelé, Then la troncation actuelle (`MAX_CODE_CHARS = 1500` ligne 21) est conservée — c'est une troncation par-modèle-quelconque, And la troncation `MAX_GGUF_CHARS = 8000` est supprimée (l'équivalent passe par les limites du provider)
  > AC: Given la suppression de `embedViaOnnx` n'est PAS faite, When le module est lu, Then la branche `embedViaOnnx` reste intacte (NFR9 — lite n'est pas touché)
  > AC: Given la nouvelle implémentation est en place, When un test unit mock `embed`/`embedMany` du SDK, Then `embedCode("test")` produit le bon vecteur, And `embedCodeBatch(["a","b","c"])` produit 3 vecteurs dans l'ordre
  > Spec: specs/planning-artifacts/epic-50-embedding-provider-abstraction.md#story-50-4
- [ ] Story 50.5: `resolveEmbeddingModels` enrichi + `EmbeddingBackend` `'external'` + mapping legacy
  > As a développeur du pipeline
  > I want que la résolution des modèles d'embedding produise toutes les infos nécessaires (provider, base_url, env_key, runtime, dims) en un seul objet
  > So that `embeddings.ts` n'a plus à interroger `MODEL_REGISTRY` ni à recouper avec `embeddings-ready.json`.
  > AC: Given `EmbeddingBackend` (`src/rag/hardware-detect.ts:134`) est étendu, When la définition est lue, Then le type est `'lite' | 'advanced-fp16' | 'advanced-gguf' | 'external'`, And un commentaire indique que `'advanced-gguf'` est une étiquette legacy mappée en interne sur `provider: 'anatoly-local'` + `runtime: 'sdk'`
  > AC: Given `ResolvedModels` (ligne 262) est étendu, When la définition est lue, Then elle gagne les champs optionnels : `codeProvider?: string`, `codeBaseUrl?: string`, `codeEnvKey?: string | null`, `nlpProvider?: string`, `nlpBaseUrl?: string`, `nlpEnvKey?: string | null`, And `codeRuntime`/`nlpRuntime` deviennent `'onnx' | 'sdk'`
  > AC: Given `determineBackend(flag, hardware)` (ligne 280), When `flag.backend === 'advanced-gguf'`, Then retourne `'advanced-gguf'` (étiquette conservée pour la traçabilité), When `flag.backend === 'external'`, Then retourne `'external'`, When `flag.backend === 'advanced-fp16'`, Then retourne `'lite'` (legacy, fp16 plus utilisé), When `flag.backend === 'lite'` ou absent, Then retourne `'lite'`
  > AC: Given `resolveEmbeddingModels(config, hardware, onLog?, readyFlag?)` (ligne 302), When `backend === 'lite'`, Then `codeRuntime: 'onnx'`, `nlpRuntime: 'onnx'`, comportement identique à actuel (pas de provider/base_url renseigné), When `backend === 'advanced-gguf'`, Then `codeRuntime: 'sdk'`, `nlpRuntime: 'sdk'`, And `codeProvider: 'anatoly-local'`, `nlpProvider: 'anatoly-local'`, And `codeBaseUrl: 'http://127.0.0.1:11437/v1'`, `nlpBaseUrl: 'http://127.0.0.1:11438/v1'`, And `codeEnvKey: null`, `nlpEnvKey: null`, And `codeDim: 3584`, `nlpDim: 4096` (du registre), When `backend === 'external'`, Then `codeRuntime: 'sdk'`, `nlpRuntime: 'sdk'`, And `codeProvider`/`nlpProvider` viennent de `config.rag.embedding.provider` (ou des defaults registre si `'auto'`), And `codeBaseUrl`/`nlpBaseUrl` viennent du registre (ou de `config.rag.embedding.base_url` pour custom), And `codeEnvKey`/`nlpEnvKey` viennent du registre, And `codeDim`/`nlpDim` viennent du registre si disponibles, sinon valeurs sentinelles (`-1`) à probe au boot via `ensureEmbeddingDims`
  > AC: Given `EmbeddingsReadyFlag` (ligne 147) est étendu, When la définition est lue, Then elle gagne `embedding_provider?: string` et `embedding_signature?: string`
  > AC: Given un `embeddings-ready.json` existant en format pré-Epic-50 (avec `backend: 'advanced-gguf'`, sans `embedding_provider`), When `readEmbeddingsReadyFlag` le lit, Then le flag est parsé correctement, And `resolveEmbeddingModels` mappe automatiquement vers `provider: 'anatoly-local'` (NFR8 backward compat), And aucune migration manuelle n'est nécessaire pour l'utilisateur
  > AC: Given un projet utilise `setup-embeddings.sh` en standalone (sans wizard), When le script écrit `backend: 'external'` et `embedding_provider: 'voyage'` dans le flag, Then `resolveEmbeddingModels` route vers Voyage sans intervention CLI
  > Spec: specs/planning-artifacts/epic-50-embedding-provider-abstraction.md#story-50-5
- [ ] Story 50.6: Wizard tier 3 options + sous-prompt external + writeFirstRunConfig étendu
  > As a utilisateur en first-run
  > I want pouvoir choisir un provider d'embedding externe (OpenAI, Voyage, Cohere...) au lieu de lite ou advanced
  > So that je peux utiliser ma clé API existante sans télécharger 10 GB de GGUF ni avoir un GPU.
  > AC: Given `runFirstRunWizard(opts)` (`src/cli/setup-prompts.ts:61`) est étendu, When la liste `tierOptions` est construite, Then elle contient toujours `Default — fast setup, works everywhere` (= `'lite'`), And elle contient `Advanced — higher recall, needs GPU` (= `'advanced'`) uniquement si `canRunAdvanced(hw) === true`, And elle contient toujours `External — bring your own provider (OpenAI, Voyage, Cohere, Azure...)` (= `'external'`)
  > AC: Given l'utilisateur sélectionne `'external'`, When le premier sous-prompt s'affiche (axe code), Then un `p.select` propose la liste des providers externes du registre (`openai`, `voyage`, `qwen`, `cohere`, `mistral`) + `Custom (manual)`, And chaque option affiche le `default_code_model` en hint, And `voyage` est pré-sélectionné (suggéré pour code retrieval, voyage-code-3 SOTA)
  > AC: Given l'utilisateur a choisi un provider du registre pour code (ex. `voyage`), When la sélection code est confirmée, Then un `p.text` propose `code model` avec le `default_code_model` pré-rempli (ex. `voyage-code-3`) — Enter accepte le default
  > AC: Given le code provider est confirmé, When le second sous-prompt s'affiche (axe NLP), Then la première option du `p.select` est `Same as code (use {code_provider} for both)` — pré-sélectionnée pour les users mono-provider, And les options suivantes sont la même liste que pour code (`openai`, `voyage`, `qwen`, `cohere`, `mistral`, `Custom (manual)`), And `qwen` est pré-sélectionné en option distincte (suggéré pour NLP — Qwen3 parité GGUF advanced)
  > AC: Given l'utilisateur a choisi "Same as code", When le wizard continue, Then aucun prompt model NLP n'est affiché, And la config `nlp` est dupliquée à partir de `code` (à la fin du wizard, pas en tant qu'implicite YAML)
  > AC: Given l'utilisateur a choisi un provider distinct pour NLP (ex. `qwen`), When la sélection NLP est confirmée, Then un `p.text` propose `nlp model` avec le `default_nlp_model` pré-rempli (ex. `text-embedding-v4`) — Enter accepte
  > AC: Given l'utilisateur a choisi `Custom (manual)` pour code OU NLP, When le sous-prompt custom s'affiche, Then quatre `p.text` consécutifs : `provider name`, `base_url` (validation URL), `env_key` (validation regex `[A-Z0-9_]+`), `model` (texte libre), And la `env_key` saisie est testée via `process.env[env_key]` (présent / absent)
  > AC: Given un provider external (registre ou custom) est résolu pour code OU NLP avec un `env_key` défini, When `process.env[env_key]` est défini, Then un `p.note` affiche `✓ {env_key} detected`, When `process.env[env_key]` est absent, Then un `p.note` warn : `⚠ {env_key} not set in environment. The .anatoly.yml will be written, but embedding calls will fail until the key is exported.`, And le wizard continue (l'utilisateur peut éditer .anatoly.yml et exporter la clé plus tard)
  > AC: Given `WizardResult` est étendu, When retourné après un choix `external`, Then il contient `{ tier: 'external', mode, external: { code: { provider, model, base_url?, env_key? }, nlp: { provider, model, base_url?, env_key? } } }`, And si l'utilisateur a choisi "Same as code", `external.nlp` est strictement égal à `external.code` (objet dupliqué), When retourné après un choix `lite` ou `advanced`, Then `external` est `undefined`
  > AC: Given `--defaults-settings` est set OU `process.stdin.isTTY === false`, When la wizard démarre, Then elle retourne `{ tier: 'lite', mode: 'full-run' }` (pas de external auto — le mode external nécessite explicitement une clé/provider, donc CI utilise lite par défaut)
  > AC: Given l'utilisateur a confirmé `tier: 'external'` avec le combo best-of-breed `code: voyage/voyage-code-3` + `nlp: qwen/text-embedding-v4`, When `writeFirstRunConfig({ tier: 'external', external: {...} })` est appelé, Then le `.anatoly.yml` écrit contient :, embedding:, code:, provider: voyage, model: voyage-code-3, nlp:, provider: qwen, model: text-embedding-v4
  > AC: Given l'utilisateur a confirmé "Same as code" pour NLP avec OpenAI, When le YAML est écrit, Then la section `nlp` est tout de même écrite explicitement avec les mêmes valeurs que `code` (pas d'implicite YAML — le fichier doit rester self-explanatory pour qui le relit) :, embedding:, code:, provider: openai, model: text-embedding-3-large, nlp:, provider: openai, model: text-embedding-3-large, When `tier: 'external'` avec custom code provider, Then le YAML contient `base_url` et `env_key` sous `rag.embedding.code` (et `rag.embedding.nlp` si custom NLP aussi), When `tier: 'lite'`, Then la section `rag.embedding` est absente du YAML écrit (équivalent à `auto`), When `tier: 'advanced'`, Then la section `rag.embedding` est absente également (le `embeddings-ready.json` écrit par `setup-embeddings.sh` avec `backend: 'advanced-gguf'` suffit à driver le runtime). Cohérence avec le comportement actuel.
  > AC: Given un utilisateur fait Ctrl+C dans le sous-prompt external, When `p.isCancel` retourne `true`, Then `process.exit(0)`, And aucun `.anatoly.yml` n'est écrit
  > Spec: specs/planning-artifacts/epic-50-embedding-provider-abstraction.md#story-50-6
- [ ] Story 50.7: Tests d'intégration parité advanced + wiring openai live + bench latence SDK
  > As a mainteneur d'anatoly
  > I want valider que le refacto `'sdk'` produit des vecteurs strictement identiques à l'ancien chemin GGUF natif et que le path OpenAI fonctionne end-to-end, So que je peux merger sans régression silencieuse.
  > AC: Given un test d'intégration `tests/integration/embedding-parity.integration.test.ts` est créé, When il est exécuté en présence d'une variable d'env `ANATOLY_TEST_VM_KEY` pointant sur une clé SSH valide vers la VM avec docker + GGUF models, Then le test :
  > AC: Given ce test est skippé si `ANATOLY_TEST_VM_KEY` est absent, When la suite tourne en CI sans VM, Then le test est `it.skip` avec un message clair `"VM integration test — set ANATOLY_TEST_VM_KEY to run"`
  > AC: Given un test `tests/integration/embedding-openai.integration.test.ts` est créé, When il est exécuté avec `OPENAI_API_KEY` valide, Then il appelle `embedCode("function add(a, b) { return a + b; }")` avec `provider: 'openai'`, `model: 'text-embedding-3-small'` (modèle moins cher pour les tests), And asserte `vec.length === 1536` (dim de text-embedding-3-small), And asserte que tous les éléments sont des `number` finis, And le test est skippé si `OPENAI_API_KEY` est absent
  > AC: Given un bench `tests/bench/sdk-overhead.bench.ts` est créé, When il est exécuté, Then il mesure :
  > AC: Given la suite de tests existante (`embeddings.test.ts`, `hardware-detect.test.ts`) est étendue, When elle est exécutée, Then zéro régression sur les chemins ONNX (NFR9), And chaque story 50.1-50.6 est couverte par au moins 3 tests unit
  > Spec: specs/planning-artifacts/epic-50-embedding-provider-abstraction.md#story-50-7
- [ ] Story 50.8: Validation gold-set anatoly-bench + documentation utilisateur embedding providers
  > As a mainteneur d'anatoly
  > I want valider qu'aucune régression sémantique n'est introduite par le refacto et offrir aux utilisateurs une doc claire des providers d'embedding disponibles
  > So that je peux merger en confiance et que les utilisateurs sachent quel provider choisir.
  > AC: Given `../anatoly-bench` (sibling repo) contient un gold-set d'audits avec catalog F1 (cf. `memory: reference_anatoly_bench.md`), When le bench est exécuté avant le refacto sur un projet de référence, Then un `f1_score_baseline_advanced_legacy.json` est sauvegardé dans `_bmad-output/implementation-artifacts/epic-50/`, When le bench est ré-exécuté après le refacto avec `provider: 'anatoly-local'` (chemin SDK pour advanced), Then un `f1_score_advanced_sdk.json` est sauvegardé, And `f1_score_advanced_sdk.score >= f1_score_baseline_advanced_legacy.score` (NFR2), And un commentaire dans le doc note la marge (zéro tolérance ou ≤ 0.5% absolus en cas de variance reproductible)
  > AC: Given le bench est exécuté avec `provider: 'openai'`, `model: 'text-embedding-3-large'` sur le même projet, When les résultats arrivent, Then un `f1_score_external_openai.json` est sauvegardé pour traçabilité (pas un critère de pass/fail mais une mesure utile)
  > AC: Given un nouveau document `docs/embedding-providers.md` est créé, When il est lu, Then il contient :, (a) Azure OpenAI internal — `embedding.code.provider: azure-openai-internal`, `base_url: https://{resource}.openai.azure.com/openai/deployments/{deployment}/embeddings?api-version=...`, `env_key: AZURE_OPENAI_KEY` + même chose côté `nlp` (peut être un déploiement différent du même resource Azure), (b) Container GGUF self-hosted derrière load balancer interne — `embedding.code.provider: anatoly-local-cluster`, `base_url: https://embed-code.internal.corp/v1`, `embedding.nlp.provider: anatoly-local-cluster`, `base_url: https://embed-nlp.internal.corp/v1` — équivalent du mode advanced mais distribué sur leur infra GPU, (c) HF Inference Endpoints du client — `embedding.code.provider: hf-internal`, `base_url: https://abc123.eu-west-1.aws.endpoints.huggingface.cloud/v1`, `env_key: HF_INTERNAL_TOKEN` — modèles open-weights déployés par le client (`nomic-embed-code`, `Qwen3-Embedding-8B`, ou autres), Mention explicite : ces déploiements n'ont aucune dépendance vers l'infra Anatoly côté embedding — le client a souveraineté complète sur ses données et son provider.
  > AC: Given le `README.md` du projet, When il est lu après l'epic, Then la section `Embeddings` (si présente) renvoie vers `docs/embedding-providers.md`
  > AC: Given `epics.md` (master tracker `_bmad-output/planning-artifacts/epics.md`), When il est mis à jour, Then une entrée Epic 50 est ajoutée dans la timeline avec lien vers ce doc
  > AC: Given `sprint-status.yaml` est mis à jour, When lu, Then une section Epic 50 est présente avec les 8 stories en statut `backlog`
  > Spec: specs/planning-artifacts/epic-50-embedding-provider-abstraction.md#story-50-8

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
