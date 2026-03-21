# Ralph Fix Plan

## Stories to Implement

- [x] Story 29.1: Project Type Detection
  > As a **developer running Anatoly**
  > I want Anatoly to **automatically detect my project type(s)** from package.json
  > So that the documentation structure is **tailored to my stack**.
  > AC: Given a project with `react` and `prisma` in dependencies, When Anatoly runs the project type detector, Then it returns `['Frontend', 'ORM']`, And multiple types can be detected simultaneously
  > AC: Given a project with `bin` field in package.json and `commander` in dependencies, When Anatoly runs the project type detector, Then it returns `['CLI']`
  > AC: Given a project with `workspaces` in package.json, When Anatoly runs the project type detector, Then it returns `['Monorepo', ...other detected types]`
  > AC: Given a project with no recognized framework dependencies, When Anatoly runs the project type detector, Then it returns `['Library']` as default
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-1
- [x] Story 29.2: Documentation Structure Scaffolder
  > As a **developer running Anatoly**
  > I want Anatoly to **generate the ideal documentation file structure** in `.anatoly/docs/`
  > So that I can **see at a glance what documentation my project should have**.
  > AC: Given a detected project type of `['Backend API', 'ORM']`, When Anatoly runs the doc scaffolder, Then `.anatoly/docs/` contains the base structure (01-Getting-Started through 06-Development) PLUS Backend API sections (REST-Endpoints, Middleware, Authentication, Error-Handling) PLUS ORM sections (Data-Model, Migrations, Seeding, Query-Patterns), And `index.md` contains a complete table of contents with links to all generated pages
  > AC: Given a detected project type of `['Frontend']`, When Anatoly runs the doc scaffolder, Then `.anatoly/docs/` contains the base structure PLUS Frontend sections (Component-API, Component-Patterns, State-Management, Routing, Hooks, Stores, Styles)
  > AC: Given `.anatoly/docs/` already exists from a previous run, When Anatoly runs the doc scaffolder, Then new pages are added but existing pages are NOT overwritten, And `index.md` is regenerated to reflect the current structure
  > AC: Given Anatoly runs on any project, When the scaffolder finishes, Then it NEVER writes any file inside the project's `docs/` directory
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-2
- [x] Story 29.3: Scaffolding Hints in Generated Pages
  > As a **developer reading scaffolded documentation**
  > I want each empty page to contain **contextual writing hints** in HTML comments
  > So that I know **exactly what to write** in each section without reading the standard.
  > AC: Given a scaffolded page `01-Getting-Started/01-Overview.md`, When a developer opens it, Then it contains `<!-- SCAFFOLDING: ... -->` comments before each placeholder section, And each hint is max 3 lines, actionable, and includes "Delete this comment when done."
  > AC: Given a scaffolded page for a Backend API project's `04-API-Reference/04-REST-Endpoints.md`, When a developer opens it, Then the hints reference the actual detected routes/controllers from the source code, And the hints are project-context-aware (not generic)
  > AC: Given a previously scaffolded page that was filled with content, When the scaffolder runs again, Then it does NOT overwrite the filled content or re-add hints
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-3
- [x] Story 29.4: Module Granularity Resolution
  > As a **developer running Anatoly**
  > I want the `05-Modules/` section to be **correctly granular** — not one giant page, not 50 tiny pages
  > So that each module page is **useful and appropriately scoped**.
  > AC: Given `src/core/` has 8 files each > 200 LOC forming a cohesive module, When the scaffolder resolves module granularity, Then it creates `05-Modules/core.md` (directory-level, single page)
  > AC: Given `src/utils/` has 2 files: `logger.ts` (300 LOC) and `cache.ts` (250 LOC), When the scaffolder resolves module granularity, Then it creates `05-Modules/logger.md` and `05-Modules/cache.md` (file-level)
  > AC: Given `src/helpers/format.ts` has 80 LOC, When the scaffolder resolves module granularity, Then it does NOT create a page for it (< 200 LOC, skipped)
  > AC: Given `src/rag/doc-indexer.ts` has 500+ LOC, When the scaffolder resolves module granularity, Then it creates `05-Modules/doc-indexer.md` (file-level, single large file)
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-4
- [x] Story 29.5: Code → Documentation Mapping with Fallback
  > As a **developer running Anatoly on a non-standard project layout**
  > I want the scaffolder to **correctly map source directories to doc pages** even when directory names don't match conventions
  > So that **every significant module gets a documentation page**.
  > AC: Given a project with `src/api/` instead of `src/routes/`, When the scaffolder resolves the mapping, Then it maps `src/api/` to `04-API-Reference/04-REST-Endpoints.md` via directory name synonym matching (`api` = `routes`)
  > AC: Given a project with `src/handlers/` containing NestJS `@Controller()` decorators, When the scaffolder resolves the mapping, Then it maps to `04-API-Reference/04-REST-Endpoints.md` via framework detection
  > AC: Given a project with `src/data-layer/` (non-standard name, > 200 LOC), When no convention or synonym matches, Then it creates `05-Modules/data-layer.md` as catch-all
  > AC: Given any project, When the scaffolder finishes, Then every source directory with > 200 LOC total has at least one corresponding doc page
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-5
- [x] Story 29.6: Guard Test — Anatoly Never Writes to docs/
  > As a **project maintainer**
  > I want a **guaranteed invariant** that Anatoly never writes to `docs/`
  > So that my existing documentation is **never modified without my consent** (only Ralph can do that).
  > AC: Given Anatoly runs a full audit pipeline, When any phase of the pipeline executes, Then no file in the project's `docs/` directory is created, modified, or deleted
  > AC: Given the scaffolder creates `.anatoly/docs/`, When a bug or regression attempts to write to `docs/`, Then the guard test catches it and the test suite fails
  > AC: Given a new contributor adds a `writeFile` call in the pipeline, When the target path resolves to `docs/`, Then CI fails with a clear error message explaining the invariant
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-6
- [x] Story 29.7: Source Code Analysis for Documentation
  > As a **developer running Anatoly**
  > I want Anatoly to **extract the relevant source code context** for each scaffolded doc page
  > So that the LLM can generate **accurate, concrete documentation** based on real code.
  > AC: Given a scaffolded page `05-Modules/rag.md` mapped to `src/rag/`, When Anatoly prepares the generation context, Then it extracts all exported symbols (functions, classes, types, interfaces) with their signatures, JSDoc, and first 20 lines of body, And it includes the file tree of the module directory
  > AC: Given a scaffolded page `04-API-Reference/01-Public-API.md` mapped to `src/index.ts`, When Anatoly prepares the generation context, Then it extracts all re-exports and their resolved signatures from the source modules
  > AC: Given a scaffolded page `02-Architecture/01-System-Overview.md`, When Anatoly prepares the generation context, Then it extracts the top-level source tree, module responsibilities (from directory names + export analysis), and the data flow between modules (from import graph)
  > AC: Given any page, When the extracted context exceeds 8000 tokens, Then it is truncated by priority: exported signatures first, then body snippets, then internal helpers
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-7
- [x] Story 29.8: LLM Page Content Generation
  > As a **developer running Anatoly**
  > I want Anatoly to **generate complete documentation content** for each page in `.anatoly/docs/`
  > So that `.anatoly/docs/` is a **usable, readable documentation reference** — not just a skeleton.
  > AC: Given a scaffolded page with its source code context, When Anatoly generates the content via LLM, Then the page follows the ideal page template (H1, blockquote summary, H2 sections, examples, See Also), And the content uses real function names, types, and file paths from the project, And at least 1 code example per page is included
  > AC: Given a page `01-Getting-Started/02-Installation.md`, When Anatoly generates the content, Then it includes the actual package name from package.json, the real install command, and the actual CLI entry point if detected
  > AC: Given a page `02-Architecture/01-System-Overview.md`, When Anatoly generates the content, Then it includes a Mermaid diagram showing the actual module relationships
  > AC: Given any page in `02-Architecture/`, When Anatoly generates the content, Then it includes at least 1 Mermaid diagram (flowchart, sequence, or ER) reflecting real component names and relationships from the codebase
  > AC: Given any page in `04-API-Reference/`, When Anatoly generates the content, Then each documented function/endpoint/component includes at least 1 complete usage example with realistic arguments AND expected output/response, And examples are copy-pasteable and use real function names from the project
  > AC: Given generation for a full project (20+ pages), When the LLM generates all pages, Then the default model is Haiku, And total generation cost is < $0.05 for a 50-file project
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-8
- [x] Story 29.9: Incremental Cache (SHA-256 per Page)
  > As a **developer running Anatoly repeatedly**
  > I want `.anatoly/docs/` to update **only the pages whose source code has changed**
  > So that second runs are **fast (> 90% cache hit) and cheap (near-zero LLM cost)**.
  > AC: Given a first run that generates 25 pages in `.anatoly/docs/`, When Anatoly runs a second time with no source code changes, Then 0 pages are regenerated, And the cache hit rate is 100%, And the run time for the doc generation phase is < 1 second
  > AC: Given a change to `src/core/scanner.ts`, When Anatoly runs again, Then only the pages mapped to `src/core/scanner.ts` are regenerated (e.g., `05-Modules/scanner.md`), And all other pages remain cached
  > AC: Given a new file `src/core/new-module.ts` (> 200 LOC) is added, When Anatoly runs again, Then a new page `05-Modules/new-module.md` is scaffolded and generated, And `index.md` is regenerated to include the new page
  > AC: Given a file `src/utils/old-helper.ts` is deleted, When Anatoly runs again, Then the corresponding page in `.anatoly/docs/` is removed, And `index.md` is updated to remove the entry
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-9
- [x] Story 29.10: Documentation Scoring Integration
  > As a **developer reading an Anatoly audit report**
  > I want the report to include a **project-level documentation score** based on 5 weighted dimensions
  > So that I can understand my **overall documentation health at a glance**.
  > AC: Given a project where `.anatoly/docs/` has been generated, When the documentation axis produces the report, Then the report includes a "Documentation Reference" section with:
  > AC: Given a Backend API + ORM project, When the scoring runs, Then the weights are adjusted: +10% on REST Endpoints + Auth documented, +10% on Data Model + Migrations documented
  > AC: Given a project with no `docs/` directory at all, When the scoring runs, Then the structural score is 0% and the verdict is UNDOCUMENTED, And the report shows `.anatoly/docs/` coverage as 100% (ideal reference exists), And the sync gap shows the full count of pages needed
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-10
- [x] Story 29.11: Documentation Reference Section in Report
  > As a **developer reading an Anatoly audit report**
  > I want to see a **clear summary of `.anatoly/docs/` status and the delta with my `docs/`**
  > So that I know **exactly what's generated, what's cached, and what Ralph can sync**.
  > AC: Given a run that generates 3 new pages, refreshes 5, and caches 20, When the report is generated, Then the "Documentation Reference" section shows:
  > AC: Given the user has `docs/` with 18 pages and `.anatoly/docs/` has 28 pages, When the report is generated, Then it shows:, docs/ coverage: 64% (18/28 pages), Sync gap: 10 pages
  > AC: Given new pages were generated in this run, When the report is generated, Then it lists each new page with its source:, + .anatoly/docs/05-Modules/doc-scaffolder.md  (from src/core/doc-scaffolder.ts)
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-11
- [x] Story 29.12: User Documentation Plan Resolver
  > As a **developer with an existing `docs/` directory**
  > I want Anatoly to **understand my documentation's organizational logic** — how I name, group, and structure my pages
  > So that recommendations **respect my existing conventions** instead of forcing Anatoly's structure on me.
  > AC: Given a project with `docs/` structured as:, └── commands.md, When Anatoly resolves the user plan, Then it builds a mapping:, "architecture": "docs/architecture/",, "guides": "docs/guides/",, "api_reference": "docs/api/", And it classifies each page's purpose by reading its H1 + summary line
  > AC: Given a project with a flat `docs/` (no subdirectories, all .md at root), When Anatoly resolves the user plan, Then it infers page purpose from file names and content, And maps concepts to individual files
  > AC: Given a project with no `docs/` directory, When Anatoly resolves the user plan, Then `resolveUserDocPlan()` returns `null`, And recommendations use only `path_ideal` (no `path_user`)
  > AC: Given a project whose `docs/` uses different numbering (e.g., `a-`, `b-` prefixes or no prefixes), When Anatoly resolves the user plan, Then it normalizes prefixes and matches by semantic content, not by numbering scheme
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-12
- [x] Story 29.13: Dual-Output Recommendations
  > As a **developer reading Anatoly's audit report**
  > I want each documentation recommendation to include **both the ideal path and the path in my own structure**
  > So that Ralph can **apply fixes in my organizational style**.
  > AC: Given a missing documentation for module `src/rag/` and a user plan where architecture docs live in `docs/architecture/`, When the documentation axis emits a recommendation, Then the finding includes:, "type": "missing_page",, "path_ideal": ".anatoly/docs/05-Modules/rag.md",, "path_user": "docs/architecture/rag-engine.md",, "content_ref": ".anatoly/docs/05-Modules/rag.md",, "rationale": "Module src/rag/ (4 files, 1200+ LOC) has no dedicated documentation page"
  > AC: Given a recommendation where no user plan exists (no `docs/` directory), When the finding is emitted, Then `path_user` mirrors `path_ideal` structure (Ralph will create `docs/` from scratch following the ideal), And `path_user` uses the ideal path but rooted in `docs/` instead of `.anatoly/docs/`
  > AC: Given an existing user page `docs/guides/getting-started.md` that is incomplete, When the documentation axis detects a missing section, Then the finding includes:, "type": "missing_section",, "path_ideal": ".anatoly/docs/01-Getting-Started/04-Quick-Start.md",, "path_user": "docs/guides/getting-started.md",, "section": "## First Run",, "content_ref": ".anatoly/docs/01-Getting-Started/04-Quick-Start.md"
  > AC: Given all 8 recommendation types defined in the scoring rubric, When any recommendation is emitted, Then it always includes `path_ideal`, `path_user`, `content_ref`, `type`, `rationale`, and `priority`
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-13
- [x] Story 29.14: Ralph Documentation Sync Mode
  > As a **developer running Ralph's fix loop**
  > I want Ralph to **synchronize my `docs/` from `.anatoly/docs/`** using the dual-output recommendations
  > So that my documentation is **completed without destroying what I've already written**.
  > AC: Given a recommendation of type `missing_page` with `path_user: "docs/architecture/rag-engine.md"` and `content_ref: ".anatoly/docs/05-Modules/rag.md"`, When Ralph processes the finding, Then it creates `docs/architecture/rag-engine.md` with the content from `.anatoly/docs/05-Modules/rag.md`, And it adapts internal links to match the user's directory structure
  > AC: Given a recommendation of type `missing_section` for an existing page `docs/guides/getting-started.md`, When Ralph processes the finding, Then it appends the missing section to the existing page, And it does NOT modify any existing content in the page
  > AC: Given a recommendation of type `outdated_content` for `docs/architecture/pipeline.md`, When Ralph processes the finding, Then it updates ONLY the outdated section, preserving all other content, And it adds a machine-readable comment `<!-- Updated by Ralph: section refreshed to match current code -->`
  > AC: Given any page in `docs/` that the user wrote manually, When Ralph processes recommendations, Then Ralph NEVER deletes content that was written by the user, And Ralph NEVER reorganizes or renames existing files
  > AC: Given Ralph processes 10 documentation recommendations, When the fix loop completes, Then the fix report shows each applied fix with before/after diff, And all fixes are individually revertible via git
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-14

- [x] Story 29.16: Injection des modules dynamiques dans le scaffolder
  > En tant que **developpeur executant Anatoly**
  > Je veux que les modules detectes par `resolveModuleGranularity` **generent des pages reelles dans `05-Modules/`**
  > Afin que la structure de documentation soit **complete et sans trou de numerotation** (04 → 05 → 06).
  > AC: Etant donne un projet CLI avec `src/core/` (8 fichiers, > 200 LOC), quand Anatoly execute le scaffolding, alors `.anatoly/docs/05-Modules/core.md` est cree avec les hints contextuels du module
  > AC: Etant donne un projet CLI sans aucun module > 200 LOC, quand Anatoly execute le scaffolding, alors le repertoire `05-Modules/` n'est pas cree, et `06-Development` est renumerote en `05-Development` dans les BASE_PAGES et l'index
  > AC: Etant donne un second run apres ajout d'un nouveau module `src/rag/` (> 200 LOC), quand le scaffolder s'execute, alors `05-Modules/rag.md` est cree sans ecraser les pages existantes, et `index.md` est regenere avec la nouvelle entree
  > AC: Etant donne un projet Frontend+ORM (pages modules statiques ET dynamiques), quand le scaffolder s'execute, alors les pages type-specifiques (`05-Modules/Components.md`) ET les pages dynamiques (`05-Modules/custom-engine.md`) coexistent sans conflit
  > Notes d'implementation:
  > - Modifier `runDocScaffold` dans `src/core/doc-pipeline.ts` pour convertir les `ModulePage[]` de `resolveModuleGranularity` en `PageDef[]` dynamiques
  > - Passer ces pages supplementaires a `scaffoldDocs` (nouveau parametre ou fusion dans la liste)
  > - Renumerotation dynamique dans `buildPageList` si aucun module n'est present (06 → 05)

- [x] Story 29.17: Execution LLM et ecriture du contenu documentaire
  > En tant que **developpeur executant Anatoly**
  > Je veux que `.anatoly/docs/` contienne du **contenu reel genere par LLM** des le premier run
  > Afin que la documentation de reference soit **utilisable immediatement**, pas un squelette vide.
  > AC: Etant donne un premier run avec 20 pages scaffoldees, quand la phase de generation s'execute, alors chaque `PagePrompt` retourne par `runDocGeneration` est envoye au SDK via le semaphore global, et le contenu retourne est ecrit dans le fichier `.anatoly/docs/` correspondant
  > AC: Etant donne un run avec `--concurrency 4` et `sdkConcurrency: 8`, quand les prompts de generation doc sont executes, alors ils respectent le budget du semaphore global (Story 30.1), sans depasser les slots disponibles
  > AC: Etant donne un deuxieme run sans modification du code source, quand la generation s'execute, alors 0 appels LLM sont effectues (cache hit 100%), et les fichiers existants ne sont pas modifies
  > AC: Etant donne un echec LLM sur une page specifique, quand l'erreur est attrapee, alors les autres pages continuent a etre generees, le slot du semaphore est libere, et un warning est emis dans les logs
  > AC: Etant donne un run complet sur un projet de 50 fichiers, quand la generation termine, alors le cout total est < $0.05 (modele Haiku par defaut)
  > Notes d'implementation:
  > - Dans `src/commands/run.ts` apres la ligne 671, ajouter une boucle qui: acquiert un slot du semaphore, envoie le `PagePrompt.prompt` au SDK (Haiku), ecrit le resultat dans `join(outputDir, prompt.pagePath)`, libere le slot dans un `finally`
  > - Utiliser `Promise.allSettled` pour la resilience
  > - Mettre a jour le progress-manager pour afficher la progression de la generation doc

- [x] Story 29.18: Contexte documentaire complementaire pour les axes
  > En tant que **developpeur executant Anatoly**
  > Je veux que les axes recoivent du contexte documentaire depuis **`.anatoly/docs/` ET `docs/`** en complement, avec une **distinction claire entre doc projet et doc interne**
  > Afin que l'analyse soit **plus pertinente** et que la couverture reflète **distinctement** ce qui est documente pour l'utilisateur vs ce qui est genere en interne.
  > AC: Etant donne un projet avec `docs/architecture/pipeline.md` (ecrit par l'utilisateur) ET `.anatoly/docs/02-Architecture/03-Data-Flow.md` (genere), quand un axe evalue `src/core/pipeline.ts`, alors le contexte inclut les deux pages comme `relevantDocs`, chacune taggee avec sa source (`project` ou `internal`)
  > AC: Etant donne un projet sans `docs/` mais avec `.anatoly/docs/` rempli, quand un axe evalue un fichier, alors le contexte inclut les pages pertinentes de `.anatoly/docs/` taggees `source: 'internal'`
  > AC: Etant donne un projet avec `docs/` et `.anatoly/docs/` contenant des pages pour le meme module, quand le resolver construit le contexte, alors les deux sources sont incluses sans deduplication, et le budget de tokens est partage equitablement
  > AC: Etant donne le budget de tokens = 20% de la fenetre de contexte du modele (ex: Haiku 200k → 40k tokens), quand les deux sources sont presentes, alors `.anatoly/docs/` et `docs/` recoivent chacun la moitie du budget
  > AC: Etant donne le mode RAG dual actif et `.anatoly/docs/` avec 30 pages, quand l'indexation s'execute, alors les sections de `.anatoly/docs/` sont chunkees, embedees et indexees dans LanceDB avec `source: 'internal'`, et celles de `docs/` avec `source: 'project'`
  > AC: Etant donne une recherche RAG pour `src/core/scanner.ts`, quand le vector store retourne les resultats, alors chaque section porte son tag `source` et les deux origines sont candidates au ranking semantique
  > AC: Les index LanceDB pour `docs/` et `.anatoly/docs/` sont dissocies — chacun a son propre cache SHA-256 et peut etre requete independamment ou ensemble
  > Notes d'implementation:
  > - Ajouter un champ `source: 'project' | 'internal'` au type `DocSection` et au schema LanceDB `doc_section`
  > - Modifier `docs-resolver.ts` pour accepter un second chemin (`anatolyDocsPath`) en plus de `docsPath`
  > - `resolveRelevantDocs` cherche dans les deux repertoires, merge les resultats, et tag chaque `RelevantDoc` avec `source`
  > - `resolveRelevantDocsViaRag` filtre ou combine par `source` selon le besoin
  > - `buildDocsTree` retourne deux arbres separes (`docsTree` + `internalDocsTree`) dans le contexte
  > - Modifier `orchestrator.ts` pour appeler `indexDocSections` deux fois : une avec `docsDir` + `source: 'project'`, une avec `.anatoly/docs/` + `source: 'internal'`
  > - Le cache SHA-256 par fichier dans `doc-indexer.ts` fonctionne deja — utiliser un `cacheSuffix` distinct par source (`lite-docs` vs `lite-internal`)

- [x] Story 29.19: Propagation de `docs_path` configurable
  > En tant que **developpeur avec une documentation dans un repertoire non-standard**
  > Je veux que le champ `docs_path` de la config soit **respecte partout** dans le pipeline
  > Afin que les projets utilisant `documentation/`, `wiki/`, ou tout autre chemin soient **correctement supportes**.
  > AC: Etant donne `docs_path: 'documentation'` dans `.anatoly.yml`, quand `assertSafeOutputPath` est appele dans `docs-guard.ts`, alors il protege `documentation/` (pas `docs/`)
  > AC: Etant donne `docs_path: 'documentation'`, quand `buildDocRecommendations` genere des `path_user`, alors les chemins pointent vers `documentation/` (pas `docs/`)
  > AC: Etant donne `docs_path: 'documentation'`, quand `resolveUserDocPlan` analyse la structure utilisateur, alors il lit `documentation/` (pas `docs/`)
  > AC: Etant donne `docs_path: 'documentation'`, quand `syncDocs` applique les recommandations, alors les fichiers sont ecrits dans `documentation/`
  > AC: Etant donne la config par defaut (pas de `docs_path`), quand le pipeline s'execute, alors le comportement est identique a aujourd'hui (`docs/`)
  > Notes d'implementation:
  > - `docs-guard.ts:26` — remplacer `'docs'` hardcode par le `docs_path` de la config
  > - `doc-recommendations.ts:143` — remplacer `'docs/'` par le `docs_path` injecte
  > - `user-doc-plan.ts` — s'assurer que les appelants passent `docs_path` de la config
  > - `doc-sync.ts` — adapter la reecriture de liens pour utiliser `docs_path`
  > - Ajouter un test d'integration avec `docs_path` non-standard

- [x] Story 29.20: Coverage distinct projet/interne et sync actionnable
  > En tant que **developpeur lisant le rapport Anatoly**
  > Je veux que le coverage documentaire distingue **doc projet (`docs/`) et doc interne (`.anatoly/docs/`)**
  > Afin de savoir **ce qui est documente pour mes utilisateurs** vs **ce qu'Anatoly a genere en reference**.
  > AC: Etant donne un projet avec 209 exports dont 94 couverts dans `docs/` et 192 couverts dans `.anatoly/docs/`, quand le rapport est genere, alors la section Documentation Reference affiche:
  > `Project docs (docs/): 45% (94/209 symbols)`, `Internal ref (.anatoly/docs/): 92% (192/209 symbols)`, `Modules: 75% (6/8 modules > 200 LOC in project docs)`
  > AC: Un symbole couvert uniquement dans `.anatoly/docs/` ne doit PAS etre compte dans le coverage projet — et inversement
  > AC: Etant donne 5 recommendations `missing_page` et 3 `outdated_content`, quand le rapport est genere, alors la section Sync status affiche: `5 pages to create, 3 pages outdated` (pas un ratio de pages)
  > AC: Etant donne un projet avec 0 exports (projet de config ou assets), quand le scoring s'execute, alors le coverage symboles est 100% (pas de division par zero) et le module coverage est la seule metrique
  > AC: Le rapport ne peut jamais afficher un coverage > 100%
  > AC: Le scoring `DocScoringInput` doit porter deux champs separes : `projectExportsDocumented` et `internalExportsDocumented` (au lieu d'un seul `publicExportsDocumented`)
  > Notes d'implementation:
  > - Refactorer `DocScoringInput` dans `doc-scoring.ts` pour separer `projectExportsDocumented` / `internalExportsDocumented`
  > - Refactorer `renderDocReferenceSection` dans `doc-report-section.ts` pour afficher les deux lignes de coverage
  > - Dans `doc-report-aggregator.ts`, utiliser le tag `source` des `doc_section` pour attribuer la couverture a la bonne categorie
  > - Remplacer le sync gap numerique par un decompte par type de recommendation
  > - Supprimer le ratio `userDocsPageCount/totalPages` qui produit des valeurs > 100%
  > - Le score global (`overall`) utilise le coverage projet comme metrique principale, le coverage interne est informatif

- [x] Story 29.21: Decouplage doc interne, RAG systematique, et pipeline post-review
  > En tant que **developpeur executant Anatoly**
  > Je veux que la mise a jour de `.anatoly/docs/` soit une **phase post-review** independante, que l'indexation RAG soit **systematique**, et que l'axe documentation n'evalue que `docs/`
  > Afin que la doc interne serve de **memoire contextuelle permanente** sans polluer le scoring.
  >
  > **Changement de pipeline:**
  > ```
  > Premier run:  setup → bootstrap doc → RAG (docs/ + .anatoly/docs/) → review (pass 1) → update internal docs → review (pass 2) → report → fix
  > Runs suivants: setup → RAG (docs/ + .anatoly/docs/) → review → update internal docs → report → fix
  > ```
  >
  > AC: Etant donne un tout premier run sur un projet sans `.anatoly/docs/`, quand le pipeline demarre, alors une phase "bootstrap doc" s'execute avant le RAG : scaffold + generation LLM rapide (Haiku) de `.anatoly/docs/`, puis le RAG indexe les deux sources, et le review (pass 1) beneficie du contexte doc interne
  > AC: Etant donne le premier run apres le pass 1, quand la phase "update internal docs" s'execute, alors `.anatoly/docs/` est raffine avec les donnees du review (symboles, imports, dependances), puis un pass 2 du review s'execute avec la doc interne enrichie — le RAG n'est PAS re-indexe (il est deja a jour)
  > AC: Etant donne un run suivant (`.anatoly/docs/` existe deja), quand le pipeline demarre, alors il n'y a pas de bootstrap, le RAG indexe les deux sources normalement, et un seul pass de review suffit
  > AC: Le flag `--no-docs` est supprime — la doc interne est une memoire contextuelle qui enrichit tous les axes, la desactiver degraderait la qualite de tout le run pour un gain negligeable
  > AC: Etant donne un run normal, quand l'axe documentation est desactive dans la config, alors l'indexation RAG doc et la mise a jour de `.anatoly/docs/` s'executent quand meme (elles ne dependent pas de l'axe)
  > AC: Etant donne l'axe documentation qui evalue `src/core/scanner.ts`, quand le LLM retourne `documentation: 'DOCUMENTED'` pour un symbole, alors cette evaluation est basee **uniquement sur la presence de doc dans `docs/`** (les pages `.anatoly/docs/` injectees comme contexte ne comptent pas dans le scoring)
  > AC: Etant donne les axes non-documentation (utility, overengineering, etc.), quand ils evaluent un fichier, alors ils recoivent le contexte de `.anatoly/docs/` via RAG pour enrichir leur analyse, independamment de l'activation de l'axe doc
  > AC: Etant donne la phase "update internal docs" qui s'execute apres le review, quand la CLI affiche la progression, alors une task dediee apparait:
  > `⠋ Internal docs     12/24 pages updated`
  > AC: Etant donne la phase "update internal docs", quand elle genere le contenu via LLM, alors elle beneficie des donnees du review (symboles extraits, imports, dependances) pour produire une doc **plus riche** que le scaffold pre-review
  >
  > **CLI — premier run:**
  > AC: Etant donne un premier run, quand la phase bootstrap demarre, alors la CLI affiche une task dediee:
  > `⠋ First run          Creating internal documentation...`
  > suivie de la progression:
  > `⠋ First run          12/24 pages generated`
  > AC: Etant donne un run suivant, quand le pipeline demarre, alors la task "First run" n'apparait pas
  >
  > **Edge cases:**
  > AC: Etant donne un premier run interrompu (Ctrl+C) pendant le bootstrap avec `.anatoly/docs/` partiellement cree (ex: 5/24 pages), quand le run suivant demarre, alors le pipeline detecte le bootstrap incomplet via le cache SHA-256 (pages attendues > pages en cache) et relance le bootstrap pour completer les pages manquantes
  > AC: Etant donne un bootstrap ou l'API LLM echoue sur > 50% des pages, quand la phase bootstrap termine, alors un warning est emis (`doc bootstrap incomplete: 18/24 pages failed — skipping double pass`), le double pass est skippe, et un seul review s'execute (la doc interne partielle est mieux que pas de doc)
  > AC: Etant donne l'ancien flag `--no-docs`, quand un utilisateur le passe, alors la CLI affiche un warning de deprecation et l'ignore
  > Notes d'implementation:
  > - `run.ts`: detecter premier run via `!existsSync(join(projectRoot, '.anatoly', 'docs'))` → declencher bootstrap doc avant RAG
  > - `run.ts`: apres pass 1 review, executer "update internal docs" puis relancer le review (pass 2) — reutiliser les memes evaluators/triageMap, pas de re-scan
  > - `run.ts`: les runs suivants (`.anatoly/docs/` existe) sautent le bootstrap et font un seul pass
  > - `run.ts`: supprimer le flag `--no-docs` et toutes les references a `ctx.noDocs` (deprecation warning si passe)
  > - `orchestrator.ts:405`: l'indexation doc doit tourner meme si l'axe doc est disabled — elle depend uniquement de `dualMode` et de l'existence des fichiers
  > - `documentation.system.md`: preciser dans le prompt que seule la doc taggee `source: 'project'` determine le statut DOCUMENTED
  > - `progress-manager`: ajouter la task `internal-docs` entre review et report, et `bootstrap-doc` en debut de premier run
  > - Le contexte review (symboles, imports, dependances) doit etre passe a `buildPageContext` pour enrichir la generation post-review
  > - Le pass 2 ne re-indexe pas le RAG — les embeddings du pass 1 sont reutilises, seul le contenu des fichiers `.anatoly/docs/` a change sur disque

- [x] Story 30.1: Global SDK Concurrency Semaphore
  > As a **developer running Anatoly on a large codebase**
  > I want the total number of **concurrent Claude SDK calls to be globally bounded**
  > So that the system **doesn't flood the API** when file concurrency × axis count grows.
  > AC: Given `--concurrency 4` and 7 enabled axes (= 28 potential parallel SDK calls), When Anatoly evaluates files, Then at most `sdkConcurrency` SDK calls are in-flight at any time (default: 8), And axes/files interleave naturally within the global budget
  > AC: Given `sdkConcurrency: 6` in `.anatoly.yml`, When Anatoly runs, Then the semaphore is initialized with 6 slots, And the value is validated (min 1, max 20)
  > AC: Given 8 slots and 12 axis evaluations queued, When 8 are running and 4 are waiting, Then waiting evaluations start FIFO as slots free up, And no evaluator starves (bounded wait time proportional to queue depth)
  > AC: Given the semaphore is active, When the CLI renders progress, Then it displays `Agents: 6/8 running · 2 available` updated in real-time, And the display is integrated into the existing progress-manager output
  > AC: Given an evaluator crashes while holding a slot, When the error is caught, Then the slot is released (finally block), And the semaphore never deadlocks
  > AC: Given `--concurrency 1` and `sdkConcurrency: 8`, When Anatoly runs 7 axes on 1 file, Then all 7 axes run in parallel (within the 8-slot budget), And the semaphore correctly handles the case where file concurrency < sdk concurrency
  > Implementation notes:
  > - Create `src/core/sdk-semaphore.ts` — ~20-line Semaphore class (acquire/release/running/waiting getters)
  > - Wrap the `query()` call in `axis-evaluator.ts` with `acquire()`/`release()` in a try/finally
  > - Expose `running` and `available` counts to progress-manager for CLI display
  > - Add `sdkConcurrency` field to Config schema (default 8, range 1-20)
  > - No changes to worker-pool.ts or file-evaluator.ts — the semaphore is transparent

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
