# Gemini Provider — Multi-Provider LLM Transport

> Spike validé le 2026-03-27. Package: `@google/gemini-cli-core@0.35.2`.
> Auth: Google OAuth (Gemini Code Assist subscription). Billing: $0/token.

## Motivation

Sur un projet de 31 fichiers, Anatoly consomme ~406 appels Claude par run (7 axes × 31 fichiers + 189 NLP cards Haiku). Le quota horaire Claude Code Max est atteint à mi-run, déclenchant des `RateLimitStandbyError` de 5-10 min.

L'intégration Gemini Flash comme provider alternatif réduit les appels Claude de **69%** et élimine les rate limit stalls.

## Tableau de migration des modèles

| Étape pipeline | Axe / Tâche | Modèle actuel | Nouveau modèle | Routing | Justification spike |
|---|---|---|---|---|---|
| **Review** | `utility` | `claude-haiku-4-5` | **`gemini-2.5-flash`** | Gemini | 100% accuracy, 4.3s (0 thought tokens), −1300 input tokens vs 2.5-flash |
| **Review** | `duplication` | `claude-haiku-4-5` | **`gemini-2.5-flash`** | Gemini | Même profil mécanique que utility, RAG pré-résolu |
| **Review** | `overengineering` | `claude-sonnet-4-6` | **`gemini-2.5-flash`** | Gemini | 100% accuracy (3/4 runs), 10s, délibération Opus rattrape les edge cases |
| **Review** | `correction` | `claude-sonnet-4-6` | — | **Claude** | ERRORs à 95% requis, hallucination incompatible |
| **Review** | `tests` | `claude-sonnet-4-6` | — | **Claude** | Pro trop lent (110s), Flash non testé sur cet axe qualitatif |
| **Review** | `best_practices` | `claude-sonnet-4-6` | — | **Claude** | 17 règles framework-aware, risque trop élevé |
| **Review** | `documentation` | `claude-sonnet-4-6` | — | **Claude** | Jugement structurel, pas testé |
| **Deliberation** | `deliberation` | `claude-opus-4-6` | — | **Claude** | Non-négociable — filet de sécurité |
| **RAG** | `nlp-summary` | `claude-haiku-4-5` | **`gemini-2.5-flash`** | Gemini | 100% schema valid (aead.rs 7/7), 14s vs 34s pour 3-flash, $0 vs $2.12/run |
| **RAG** | `semantic_chunking` | `smartChunkDoc()` | — | **Aucun LLM** | Purement programmatique, zéro appel |
| **Doc pipeline** | `doc_generation` | `claude-sonnet-4-6` | — | **Claude** | Mode agent avec tools, incompatible |
| **Doc pipeline** | `doc_coherence` | `claude-sonnet-4-6` | — | **Claude** | Jugement structurel global |
| **Doc pipeline** | `doc_content` | `claude-opus-4-6` | — | **Claude** | Qualité maximale requise |

## Impact estimé

| Métrique | Avant | Après | Delta |
|---|---|---|---|
| Appels Claude / run (31 fichiers) | ~406 | ~124 | **−69%** |
| Appels Gemini / run | 0 | ~282 | — |
| Coût API / run | ~9.60$ | ~2.50$ | **−74%** |
| Durée estimée totale | ~55-65 min | ~32-42 min | **−35 à −40%** |

## Résultats du spike (2026-03-27)

### Benchmark accuracy — Gemini 2.5 Flash vs Claude (gold-set rustguard)

| Test | Fichier | Accuracy | Durée | Tokens |
|---|---|---|---|---|
| utility | aead.rs (9 sym) | **100%** | 4.3s cold / 2s cached | 8200→710 |
| utility | timers.rs (10 sym) | **100%** | 4.8s cold | 8500→806 |
| overengineering | aead.rs (9 sym) | 78% (2 LEAN→ACCEPTABLE) | 13.7s | 8226→879 |
| overengineering | timers.rs (10 sym) | **100%** | 9.1s | 8564→901 |
| nlp-summary | aead.rs (7 fn) | **100%** (7/7 valid) | 14s | 7308→1279 |

### Implicit caching (validé)

| Call | Durée | Input tokens | Cached tokens | Hit rate |
|---|---|---|---|---|
| 1 (cold) | 5197ms | 6178 | 0 | 0% |
| 2 (warm) | **1992ms** | 6178 | 5924 | **96%** |
| 3 (warm) | **2041ms** | 6212 | 5936 | **96%** |

Le cache est automatique (implicit caching Gemini 2.5+). Dès le 2e appel sur le même axe, 96% des input tokens sont cachés. Latence divisée par 2.5x.

`usageMetadata.cachedContentTokenCount` est disponible dans les events `finished` pour l'observabilité.

### Comparaison tous modèles

| Modèle | utility | overeng | nlp-summary | Verdict |
|---|---|---|---|---|
| **gemini-2.5-flash** | 100% · 6s | 100% · 9s | 100% · 14s | **Retenu** |
| gemini-2.5-flash-lite | 100% · 3.7s | 100% · 13s | 100% · **172s** | NLP trop lent |
| gemini-2.5-pro | 100% · 12s | 100% · 51s | **0%** · 29s | NLP cassé |
| gemini-2.5-flash | 100% · 4.3s | 100% · 10s | 100% · 34s | Preview, pas stable |
| gemini-3.1-pro-preview | **FAIL** (429) | 100% · 249s | 100% · 31s | `MODEL_CAPACITY_EXHAUSTED` |

### Observations clés

- **~4800 tokens de prompt overhead** — le `Config` de `gemini-cli-core` injecte automatiquement le contexte projet (structure fichiers, GEMINI.md). Acceptable pour nos prompts d'axes (2000-5000 tokens system prompt).
- **Stream event types** : `model_info` → `thought` → `content` → `finished` (pas `StreamEventType.CHUNK`).
- **`resetChat()`** nécessaire entre chaque appel pour éviter l'accumulation d'historique. Validé : ratio tokens call2/call1 = 1.00.
- **JSON fences** — Flash ajoute parfois des ` ```json ` fences malgré l'instruction. Le `extractJson()` existant d'Anatoly gère déjà ce cas.

## API technique (validée par spike)

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
await config.refreshAuth(getAuthTypeFromEnv() || AuthType.LOGIN_WITH_GOOGLE);
await config.initialize();

// Query (par appel)
const client = config.geminiClient;
client.resetChat();
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

**`usageMetadata` fields :**

```json
{
  "promptTokenCount": 8200,
  "candidatesTokenCount": 710,
  "totalTokenCount": 9169,
  "thoughtsTokenCount": 259,
  "cachedContentTokenCount": 5924,
  "trafficType": "ON_DEMAND"
}
```

## Configuration

```yaml
# .anatoly.yml
llm:
  gemini:
    enabled: false              # opt-in explicite
    flash_model: gemini-2.5-flash   # axes review (utility, duplication, overengineering)
    nlp_model: gemini-2.5-flash           # RAG NLP summarization (2.4x faster than 3-flash on this task)
    sdk_concurrency: 12                   # semaphore dédié (séparé de Claude)
```

> **Note :** Deux modèles Flash distincts — `gemini-2.5-flash` pour les axes (0 thought tokens, plus rapide) et `gemini-2.5-flash` pour le NLP (14s vs 34s). Quand `gemini-3-flash` sera stable (pas preview), migrer le `flash_model`.

## Modèles non retenus

| Modèle | Raison d'exclusion |
|---|---|
| `gemini-2.5-flash-lite` | NLP summary 172s (12x plus lent que flash) |
| `gemini-2.5-pro` | NLP schema invalid (0%), 2-4x plus lent que flash |
| `gemini-2.5-flash` | Performances comparables à 2.5-flash mais preview, pas de garantie de stabilité |
| `gemini-3.1-pro-preview` | `MODEL_CAPACITY_EXHAUSTED` systématique, inutilisable en batch |
| `@google/gemini-cli-sdk` | Non publié sur npm (version nightly uniquement). Migration prévue quand disponible |
| `@google/genai` (API key) | Exclu — objectif billing abonnement uniquement, zéro API key |
