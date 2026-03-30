---
inputDocuments:
  - _bmad-output/planning-artifacts/architecture.md
workflowType: 'epics-and-stories'
project_name: 'anatoly'
user_name: 'Rviau'
date: '2026-03-30'
status: 'done'
---

# Epic 46 : Transport-Level Resilience — Semaphores & Circuit Breakers dans le Router

## Overview

Déplacer les semaphores de concurrence et les circuit breakers du `RunContext` (propagés manuellement dans 6 interfaces et ~40 fichiers) vers le `TransportRouter` existant. Le router expose deux API : `acquire(model)` pour les appels single-turn (transport + semaphore + breaker) et `acquireSlot(model)` pour les appels agentic (semaphore + breaker, sans transport). `GeminiCircuitBreaker` est renommé `CircuitBreaker` et devient provider-agnostique.

**Prérequis :** Epic 43 complété (TransportRouter mode-aware existant).

## Requirements Inventory

### Functional Requirements

FR1: `TransportRouter` crée un `Semaphore(concurrency)` par provider configuré dans `config.providers`
FR2: `TransportRouter` crée un `CircuitBreaker` par provider configuré (threshold, half_open_delay_ms depuis config optionnelle)
FR3: `router.acquire(model, task?)` vérifie le breaker → acquire le semaphore → resolve le transport, retourne `{ transport, release }`
FR4: `router.acquireSlot(model)` vérifie le breaker → acquire le semaphore, retourne `{ release }` (pas de transport)
FR5: `release({ success })` libère le semaphore et alimente le breaker (recordSuccess/recordFailure)
FR6: `release()` sans argument = success (backward compat)
FR7: `router.getSemaphoreStats()` retourne `Map<providerId, { active, total }>` pour le screen-renderer
FR8: `router.getBreakerState(providerId)` retourne `CircuitState | undefined`
FR9: `GeminiCircuitBreaker` est renommé `CircuitBreaker` (provider-agnostique)
FR10: `semaphore`, `geminiSemaphore`, `circuitBreaker` sont supprimés de `AxisContext`, `SingleTurnQueryParams`, `EvaluateFileOptions`, `RunContext`, `PipelineState`, `RagOptions`
FR11: `resolveSemaphore()` est supprimé
FR12: `runSingleTurnQuery` utilise `router.acquire()` au lieu de gérer semaphore/breaker manuellement
FR13: Les appels agentic (Tier 3, doc gen Sonnet/Opus, Vercel Agent) utilisent `router.acquireSlot()`
FR14: Le router est injectable dans `doc-llm-executor.ts` et `vercel-agent.ts`
FR15: Concurrency default = 10 si `providers.*.concurrency` n'est pas spécifié

### NonFunctional Requirements

NFR1: Zéro régression — les tests existants passent après migration
NFR2: Le breaker sur les appels agentic couvre l'appel complet (pas les steps individuels)
NFR3: Breaker ouvert → `throw Error` (pas de fallback silencieux vers un autre provider)
NFR4: Le semaphore est toujours libéré, même en cas d'erreur (garanti par try/finally dans le pattern `release()`)

### FR Coverage Map

FR1-FR2, FR7-FR8, FR15: Story 46.1 — TransportRouter semaphores + breakers
FR3-FR6: Story 46.2 — API acquire/acquireSlot/release
FR9: Story 46.3 — Renommage CircuitBreaker
FR10-FR12: Story 46.4 — Nettoyage interfaces + runSingleTurnQuery
FR13-FR14: Story 46.5 — Migration appels agentic
FR1-FR15 (validation): Story 46.6 — Tests d'intégration

---

## Epic 46: Transport-Level Resilience — Semaphores & circuit breakers dans le router

### Story 46.1: TransportRouter — semaphores et breakers par provider

As a développeur du pipeline,
I want que le TransportRouter gère les semaphores et breakers par provider,
So that la concurrence et la résilience ne soient plus propagées manuellement dans toute la stack.

**Acceptance Criteria:**

**Given** `TransportRouter` est instancié avec `config`
**When** `config.providers` contient `anthropic: { concurrency: 24 }` et `google: { concurrency: 10 }`
**Then** `router.semaphores` contient `Map { "anthropic" → Semaphore(24), "google" → Semaphore(10) }`

**Given** un provider n'a pas de `concurrency` dans la config
**When** le router est construit
**Then** le semaphore est créé avec `concurrency: 10` (default)

**Given** `TransportRouter` est instancié
**When** `config.providers` contient des providers
**Then** un `CircuitBreaker` est créé pour chaque provider

**Given** `router.getSemaphoreStats()` est appelé
**When** 3 slots sont acquis sur "anthropic"
**Then** il retourne `Map { "anthropic" → { active: 3, total: 24 }, "google" → { active: 0, total: 10 } }`

**Given** `router.getBreakerState("google")` est appelé
**When** le breaker Google est fermé
**Then** il retourne `'closed'`

**Fichiers:**
- `src/core/transports/index.ts` — extension du `TransportRouter`
- `src/core/transports/index.test.ts` — tests semaphores/breakers

---

### Story 46.2: API acquire / acquireSlot / release

As a développeur du pipeline,
I want une API unifiée pour acquérir un slot de concurrence avec gestion du breaker,
So that l'appelant n'ait qu'un seul point d'entrée et que le cleanup soit garanti.

**Acceptance Criteria:**

**Given** `router.acquire("google/gemini-2.5-flash")` est appelé
**When** le breaker Google est fermé et un slot est disponible
**Then** il retourne `{ transport: LlmTransport, release: Function }`
**And** le semaphore Google a un slot de moins

**Given** `router.acquire("google/gemini-2.5-flash")` est appelé
**When** le breaker Google est ouvert
**Then** il throw `Error("Provider 'google' circuit breaker is open")`
**And** aucun slot de semaphore n'est consommé

**Given** `router.acquireSlot("anthropic/claude-opus-4-6")` est appelé
**When** le breaker Anthropic est fermé
**Then** il retourne `{ release: Function }`
**And** le semaphore Anthropic a un slot de moins

**Given** `release({ success: true })` est appelé
**When** après un appel réussi
**Then** le semaphore est libéré
**And** `circuitBreaker.recordSuccess()` est appelé

**Given** `release({ success: false, error })` est appelé
**When** après un appel en échec
**Then** le semaphore est libéré
**And** `circuitBreaker.recordFailure()` est appelé

**Given** `release()` est appelé sans argument
**When** en mode implicite
**Then** le comportement est identique à `release({ success: true })`

**Fichiers:**
- `src/core/transports/index.ts` — `acquire()`, `acquireSlot()`, `release()`
- `src/core/transports/index.test.ts` — tests acquire/release

---

### Story 46.3: Renommage GeminiCircuitBreaker → CircuitBreaker

As a développeur,
I want que le circuit breaker soit provider-agnostique,
So that tout provider puisse en bénéficier.

**Acceptance Criteria:**

**Given** `src/core/circuit-breaker.ts` exporte `GeminiCircuitBreaker`
**When** il est renommé en `CircuitBreaker`
**Then** toutes les importations sont mises à jour
**And** les commentaires/JSDoc ne mentionnent plus "Gemini" spécifiquement
**And** les tests dans `circuit-breaker.test.ts` sont mis à jour

**Given** `CircuitBreaker` est utilisé
**When** il est instancié par le `TransportRouter`
**Then** la logique closed/open/half-open est inchangée

**Fichiers:**
- `src/core/circuit-breaker.ts` — renommage classe + mise à jour docs
- `src/core/circuit-breaker.test.ts` — renommage dans les tests
- Tous les fichiers qui importent `GeminiCircuitBreaker`

---

### Story 46.4: Nettoyage interfaces — suppression semaphore/breaker manuels

As a développeur du pipeline,
I want que les interfaces ne contiennent plus de champs semaphore/breaker,
So que la résilience soit entièrement encapsulée dans le router.

**Acceptance Criteria:**

**Given** `AxisContext` dans `axis-evaluator.ts`
**When** les champs `semaphore`, `geminiSemaphore`, `circuitBreaker` sont supprimés
**Then** seul `router: TransportRouter` reste comme point d'accès au transport

**Given** `SingleTurnQueryParams` dans `axis-evaluator.ts`
**When** les champs `semaphore`, `geminiSemaphore`, `circuitBreaker`, `transport` sont supprimés
**Then** seul `router: TransportRouter` reste
**And** `runSingleTurnQuery` utilise `router.acquire(model)` en interne

**Given** `EvaluateFileOptions` dans `file-evaluator.ts`
**When** `geminiSemaphore` et `circuitBreaker` sont supprimés
**Then** le fichier propage uniquement le `router`

**Given** `RunContext` / `PipelineState`
**When** `sdkSemaphore`, `geminiSemaphore`, `circuitBreaker` sont supprimés
**Then** seul le `router` est conservé

**Given** les 7 axes dans `src/core/axes/*.ts`
**When** les spreads `geminiSemaphore: ctx.geminiSemaphore` et `circuitBreaker: ctx.circuitBreaker` sont supprimés
**Then** seul `router: ctx.router` est propagé

**Given** `resolveSemaphore()` dans `axis-evaluator.ts`
**When** il est supprimé
**Then** aucun code ne le référence

**Given** les params dans `rag/orchestrator.ts`, `rag/nlp-summarizer.ts`, `rag/standalone.ts`
**When** `geminiSemaphore` est supprimé des signatures
**Then** seul le `router` est passé

**Fichiers:**
- `src/core/axis-evaluator.ts` — refactor interfaces + `runSingleTurnQuery`
- `src/core/file-evaluator.ts` — nettoyage `EvaluateFileOptions`
- `src/core/axes/*.ts` (×7) — nettoyage ctx spreads
- `src/commands/run.ts` — nettoyage `RunContext`
- `src/cli/pipeline-runner.ts` — nettoyage construction
- `src/cli/pipeline-state.ts` — suppression `geminiSemaphore`
- `src/commands/review.ts` — suppression construction locale
- `src/commands/watch.ts` — idem
- `src/rag/orchestrator.ts` — suppression `geminiSemaphore`
- `src/rag/nlp-summarizer.ts` — idem
- `src/rag/standalone.ts` — idem

---

### Story 46.5: Migration appels agentic vers acquireSlot

As a développeur du pipeline,
I want que les appels agentic (Tier 3, doc gen, Vercel Agent) utilisent `acquireSlot()`,
So que la concurrence et le breaker couvrent tous les chemins LLM.

**Acceptance Criteria:**

**Given** Tier 3 correction dans `run.ts` (direct `query()` Claude SDK)
**When** `ctx.sdkSemaphore.acquire()` est remplacé par `router.acquireSlot(model)`
**Then** le semaphore est géré par le router
**And** `release({ success })` est appelé en finally
**And** le breaker est vérifié avant l'appel

**Given** Doc gen Sonnet coherence dans `doc-llm-executor.ts`
**When** `if (semaphore) await semaphore.acquire()` est remplacé par `router.acquireSlot(model)`
**Then** le router est injecté dans `doc-llm-executor`
**And** `release({ success })` est appelé en finally

**Given** Doc gen Opus review dans `doc-llm-executor.ts`
**When** le semaphore manuel est remplacé par `router.acquireSlot(model)`
**Then** même pattern que Sonnet coherence

**Given** Doc gen pages dans `run.ts`
**When** il n'a actuellement ni semaphore ni breaker
**Then** `router.acquireSlot(model)` est ajouté avec `release({ success })` en finally

**Given** `vercel-agent.ts`
**When** il n'a actuellement ni semaphore ni breaker
**Then** le router est injecté et `acquireSlot(model)` est ajouté avec `release({ success })` en finally

**Given** `screen-renderer.ts` affiche les stats semaphore
**When** il accédait directement aux semaphores
**Then** il utilise `router.getSemaphoreStats()`

**Fichiers:**
- `src/commands/run.ts` — Tier 3 + doc gen pages
- `src/core/doc-llm-executor.ts` — injection router, Sonnet + Opus
- `src/core/agents/vercel-agent.ts` — injection router
- `src/cli/screen-renderer.ts` — migration affichage stats

---

### Story 46.6: Tests d'intégration et validation

As a mainteneur d'anatoly,
I want valider que la migration n'a introduit aucune régression,
So that les appels LLM fonctionnent identiquement avec le nouveau router.

**Acceptance Criteria:**

**Given** les tests existants du circuit breaker
**When** ils sont exécutés avec `CircuitBreaker` (renommé)
**Then** tous passent sans modification de logique

**Given** les tests existants de `runSingleTurnQuery`
**When** ils sont adaptés pour mocker `router.acquire()` au lieu de semaphores séparés
**Then** le comportement est identique

**Given** un test d'intégration du router
**When** `acquire()` est appelé N+1 fois (N = concurrency)
**Then** le N+1ème appel attend jusqu'à ce qu'un `release()` libère un slot

**Given** un test breaker + acquire
**When** 3 `release({ success: false })` consécutifs sont appelés
**Then** le prochain `acquire()` throw immédiatement (breaker ouvert)

**Given** un test acquireSlot + release
**When** `acquireSlot()` est appelé et `release({ success: true })` en finally
**Then** le semaphore est libéré et le breaker reçoit le success

**Fichiers:**
- `src/core/transports/index.test.ts` — tests acquire/acquireSlot/release
- `src/core/circuit-breaker.test.ts` — renommage
- `src/core/axis-evaluator.test.ts` — adaptation mocks
- Tests d'intégration router (dans index.test.ts)

---

## Dependency Graph

```
46.1 (Semaphores + breakers dans router)
  ↓
46.2 (API acquire/acquireSlot/release) ←── dépend de 46.1
  ↓
46.3 (Renommage CircuitBreaker) ←── indépendant, parallélisable avec 46.1-46.2
  ↓
46.4 (Nettoyage interfaces) ←── dépend de 46.2 + 46.3
  ↓
46.5 (Migration agentic) ←── dépend de 46.2 + 46.4
  ↓
46.6 (Tests d'intégration) ←── dépend de tout
```

**Parallélisable :** 46.3 peut être développée en parallèle avec 46.1-46.2.

---

## Estimation de scope

| Story | Fichiers | Complexité |
|---|---|---|
| 46.1 — Semaphores + breakers dans router | 2 | Moyenne |
| 46.2 — API acquire/acquireSlot/release | 2 | Moyenne |
| 46.3 — Renommage CircuitBreaker | 3+ | Faible |
| 46.4 — Nettoyage interfaces | 15+ | Élevée (mécanique) |
| 46.5 — Migration agentic | 5 | Moyenne |
| 46.6 — Tests d'intégration | 4+ | Moyenne |

**Total : 6 stories, ~25 fichiers, 0 dépendances npm nouvelles.**
