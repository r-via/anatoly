# Ralph Fix Plan — Epic 28: Transparence Totale en Temps Réel

## Stories to Implement

- [x] Story 28.1: Conversation Dump Infrastructure — Écriture du verbatim par appel LLM
  > Fondation : chaque appel LLM produit (1) un event `llm_call` info-level dans le ndjson du run et (2) un fichier `.md` dans `conversations/` avec le verbatim complet (system + user + assistant + result).
  > Fichiers impactés : `src/core/axis-evaluator.ts`, `src/core/file-evaluator.ts`
  > Points d'intégration clés :
  > - `ExecQueryParams` + `SingleTurnQueryParams` : ajouter `conversationDir?: string`, `conversationPrefix?: string`
  > - `execQuery()` (ligne ~267) : écrire chaque SDK message en `appendFileSync` dans le fichier conversation ET émettre un event `llm_call` via `contextLogger().info()` en fin de call
  > - Remonter le log `trace` existant (ligne ~358-370) au niveau `info` avec champ `event: 'llm_call'`
  > - Supprimer le log `debug` redondant (ligne ~308)
  > - Naming convention : `<file-slug>__<axis>__<attempt>.md` via `toOutputName()`
  > - Header metadata table (model, timestamp, tokens, cost) écrit avant le streaming, métriques finales appendées à la fin
  > - Deliberation pass dans `file-evaluator.ts:226` : passer `conversationPrefix: '<file>__deliberation'`
  > - Correction pass 2 (verification) dans `correction.ts:360` : passer `conversationPrefix: '<file>__correction-verify'`
  > - Sans `conversationDir` (tests, hors run) : aucun dump, comportement inchangé
  > Spec: specs/planning-artifacts/epic-28-realtime-transparency.md#story-281

- [ ] Story 28.2: RAG LLM Call Logging — NLP Summaries + Doc Chunking
  > Les appels Haiku du RAG indexer (NLP summaries + doc chunking) sont loggés et dumpés, couvrant les 3 points d'appel LLM non tracés.
  > Fichiers impactés : `src/rag/nlp-summarizer.ts`, `src/rag/doc-indexer.ts`, `src/rag/orchestrator.ts`
  > Points d'intégration clés :
  > - `execNlpQuery()` dans `nlp-summarizer.ts:126` : capturer les SDK messages (comme `execQuery`), accepter `conversationDir`, émettre event `llm_call` avec `axis: 'nlp-summary'`
  > - Alternative recommandée : migrer `execNlpQuery()` vers `runSingleTurnQuery()` avec `NlpResponseSchema` pour unifier le pattern (dump automatique via Story 28.1)
  > - `chunkDocWithHaiku()` dans `doc-indexer.ts:108,162` utilise déjà `runSingleTurnQuery()` → propager `conversationDir` depuis `indexDocSections()` → `orchestrator.ts`
  > - `RagIndexOptions` : ajouter `conversationDir?: string`, injecté par `run.ts` lors de `indexProject()`
  > - Naming : `rag__nlp-summary__<file-slug>.md`, `rag__doc-chunk__<doc-slug>__<section-slug>.md`
  > Dépend de Story 28.1 (infrastructure conversation dump)
  > Spec: specs/planning-artifacts/epic-28-realtime-transparency.md#story-282

- [x] Story 28.3: Unified Run Context — Chaque commande crée un run directory
  > Les commandes `scan`, `estimate`, `review`, `watch` créent chacune un mini-run directory avec ndjson structuré.
  > Fichiers impactés : `src/commands/scan.ts`, `src/commands/estimate.ts`, `src/commands/review.ts`, `src/commands/watch.ts`, `src/utils/run-id.ts`
  > Points d'intégration clés :
  > - `generateRunId()` dans `run-id.ts` : ajouter signature `generateRunId(prefix?: string)` → `<prefix>-<timestamp>` ou `<timestamp>`
  > - Factoriser helper `createMiniRun(projectRoot, prefix)` → `{ runId, runDir, runLog, conversationDir }`
  > - `scan.ts` : wrap action dans `runWithContext({ runId, phase: 'scan' })`, créer run dir `scan-<ts>`
  > - `estimate.ts` : idem avec `estimate-<ts>`
  > - `review.ts` : idem avec `review-<ts>`, passer `conversationDir` à `evaluateFile()`
  > - `watch.ts` : idem avec `watch-<ts>`, flush après chaque fichier
  > - `purgeRuns()` : supporter toutes les variantes de préfixes
  > - `anatoly run` : comportement inchangé (rétrocompatibilité)
  > Indépendant de Story 28.1 — peut être implémenté en parallèle
  > Spec: specs/planning-artifacts/epic-28-realtime-transparency.md#story-283

- [ ] Story 28.4: Per-file & Per-axis Events — Tracer chaque décision dans le ndjson
  > Chaque décision de triage, début/fin de review, progression par axe, recherche RAG et retry est loggée comme événement structuré dans le ndjson.
  > Fichiers impactés : `src/commands/run.ts`, `src/core/file-evaluator.ts`
  > Points d'intégration clés :
  > - Triage loop (`run.ts` ~557-585) : émettre `event: 'file_triage'` per-file avec tier + reason
  > - Review handler (`run.ts` ~880) : émettre `event: 'file_review_start'` avant `evaluateFile()`
  > - `evaluateFile()` settled results (`file-evaluator.ts` ~175-192) : émettre `event: 'axis_complete'` ou `event: 'axis_failed'` per-axis
  > - Skip files (`run.ts` ~889-897) : émettre `event: 'file_skip'` avec reason
  > - RAG pre-resolve (`file-evaluator.ts` ~310-318) : enrichir le log info existant avec `event: 'rag_search'`
  > - Doc resolve (`file-evaluator.ts` ~128-141) : émettre `event: 'doc_resolve'` avec method + paths
  > - Retry handler (`run.ts` ~951-956) : supprimer la condition `if (!ctx.verbose)` pour logger inconditionnellement dans le ndjson, garder la condition pour le display Listr uniquement
  > Dépend de Story 28.1 (format d'événement LLM)
  > Spec: specs/planning-artifacts/epic-28-realtime-transparency.md#story-284

- [ ] Story 28.5: Watch Mode Logging — Session continue avec événements temps réel
  > Le mode `watch` produit un journal temps réel avec events structurés + dumps de conversation.
  > Fichiers impactés : `src/commands/watch.ts`
  > Points d'intégration clés :
  > - Utiliser `createMiniRun('watch')` de Story 28.3 au démarrage
  > - `watch_start` event avec patterns + excludes
  > - `processFile()` : wrap dans `runWithContext({ file: relPath })`, passer `conversationDir` à `evaluateFile()`
  > - Chaque changement : `file_change` → `file_scan` → `file_review_start` → LLM calls → `file_review_end`
  > - `handleUnlink()` : émettre `file_delete`
  > - SIGINT handler : émettre `watch_stop`, flush ndjson
  > - Erreurs : émettre `file_review_error` au lieu de seulement console.log
  > Dépend de Story 28.3 (run dir pour watch) + Story 28.1 (conversation dumps)
  > Spec: specs/planning-artifacts/epic-28-realtime-transparency.md#story-285

- [ ] Story 28.6: Run Metrics Timeline — Reconstitution séquentielle du run
  > `run-metrics.json` inclut une timeline des événements clés et un résumé agrégé des conversations LLM.
  > Fichiers impactés : `src/commands/run.ts` (report phase ~1054-1196)
  > Points d'intégration clés :
  > - Ajouter `ctx.timeline: Array<{t: number, event: string, [k: string]: unknown}>` au `RunContext`
  > - Ajouter `ctx.conversationStats: { total, byPhase, byModel, totalInputTokens, totalOutputTokens }`
  > - Phase start/end : push dans timeline avec `t = Date.now() - ctx.startTime`
  > - File review start/end : push dans timeline (pas per-axis pour limiter la taille)
  > - En fin de run : sérialiser timeline + conversationStats dans `run-metrics.json`
  > - Timeline triée par `t`, events de niveau "phase" et "file" uniquement
  > Dépend de Story 28.1 + Story 28.4 (événements à collecter)
  > Spec: specs/planning-artifacts/epic-28-realtime-transparency.md#story-286

## Completed

## Notes
- Ordre d'implémentation : 28.1 + 28.3 en parallèle → 28.2 + 28.4 en parallèle → 28.5 + 28.6 en parallèle
- Aucune nouvelle dépendance npm — utilise l'infra pino existante
- Breaking changes : aucun — logging additionnel uniquement, stderr inchangé
- Tous les 12 points d'appel LLM identifiés dans le codebase sont couverts
- Spec complète : `.ralph/specs/planning-artifacts/epic-28-realtime-transparency.md`
