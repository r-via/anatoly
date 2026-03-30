# Ralph Fix Plan

## Stories to Implement

### Documentation Axis — Audit de la couverture documentaire

- [x] Story 26.1: Prerequisites (schema + resolver + prompt)
  > As a développeur d'Anatoly
  > I want les fondations du 7ème axe (types, résolveur de docs, prompt système)
  > So that l'évaluateur et le merger puissent être construits dessus.
  > AC: Given le fichier `src/core/axis-evaluator.ts`, When le type `AxisId` est inspecté, Then il contient `'documentation'` comme valeur additionnelle du type union
  > AC: Given le nouveau fichier `src/core/docs-resolver.ts`, When la fonction `buildDocsTree(projectRoot, docsPath)` est appelée, Then elle retourne un `string | null` contenant l'arborescence récursive de `{docsPath}//*.md`, And retourne `null` si le répertoire n'existe pas ou est vide
  > AC: Given le nouveau fichier `src/core/axes/prompts/documentation.system.md`, When il est inspecté, Then il contient le rôle, les critères JSDoc per-symbol, les critères /docs/ per-concept, et le format JSON de sortie attendu
  > AC: Given `npm run typecheck && npm run build`, When exécuté après l'implémentation, Then les deux commandes réussissent sans erreur
  > Spec: specs/planning-artifacts/epic-documentation-axis.md#story-26-1
- [x] Story 26.2: Core Integration (evaluator + merger + orchestrator + registry)
  > As a développeur d'Anatoly
  > I want que l'axe documentation soit intégré dans le pipeline d'évaluation complet
  > So that `anatoly run` produise des findings de documentation dans les reports.
  > AC: Given le nouveau fichier `src/core/axes/documentation.ts`, When la classe `DocumentationEvaluator` est inspectée, Then elle implémente `AxisEvaluator` avec `readonly id = 'documentation'`
  > AC: Given la constante `AXIS_DEFAULTS` dans `axis-merger.ts`, When elle est inspectée, Then elle contient `documentation: 'UNDOCUMENTED'`
  > AC: Given un symbole avec `utility=DEAD`, When les règles de cohérence sont appliquées, Then `documentation` est forcé à `UNDOCUMENTED`
  > AC: Given la fonction `evaluateFile()` dans `file-evaluator.ts`, When `docsTree` est fourni dans les options, Then elle injecte `docsTree` et `relevantDocs` dans le `AxisContext` passé aux évaluateurs
  > AC: Given `npm run typecheck && npm run build && npm run test`, When exécuté après l'implémentation, Then les trois commandes réussissent sans erreur
  > Spec: specs/planning-artifacts/epic-documentation-axis.md#story-26-2
- [x] Story 26.3: Documentation Meta (update project docs)
  > As a développeur d'Anatoly
  > I want que la documentation du projet reflète l'ajout du 7ème axe
  > So that les utilisateurs comprennent la nouvelle capacité d'analyse documentaire.
  > AC: Given le fichier `docs/02-Architecture/02-Six-Axis-System.md`, When il est renommé et mis à jour, Then il reflète le système à 7 axes incluant l'axe documentation
  > AC: Given le fichier `docs/04-Core-Modules/04-Axis-Evaluators.md`, When il est inspecté, Then il contient une section décrivant le `DocumentationEvaluator`
  > AC: Given le PRD `_bmad-output/planning-artifacts/PRD.md`, When il est inspecté, Then le Principe 1 et les Non-goals reflètent l'extension à 7 axes
  > Spec: specs/planning-artifacts/epic-documentation-axis.md#story-26-3
### Doc Scaffolding — Génération automatique de `/docs/`

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
- [x] Story 29.15: Pipeline Integration — Wire Doc Scaffolding into Anatoly Run
  > As a **developer running `anatoly run`**
  > I want the documentation scaffolding, generation, scoring, and recommendation modules to **actually execute during a run**
  > So that `.anatoly/docs/` is generated, the report includes doc scores, and Ralph receives actionable dual-output recommendations.
  > AC: Given a project with `react` and `prisma` in package.json dependencies, When `anatoly run` reaches the end of `runSetupPhase()`, Then `detectProjectTypes()` has been called with the parsed package.json, And `scaffoldDocs()` has been called with the detected types, producing `.anatoly/docs/`, And `resolveModuleGranularity()` has been called with scanner LOC data to add dynamic `05-Modules/` pages, And `resolveDocMappings()` has been called to map source directories to doc pages, And `assertSafeOutputPath()` has been called for every file written by the scaffolder, confirming no write targets `docs/`, And `.anatoly/docs/index.md` exists and contains a complete table of contents
  > AC: Given a second run with no source code changes, When the setup phase runs scaffolding, Then `scaffoldDocs()` skips all existing pages (pagesCreated is empty except index.md)
  > AC: Given the scaffolder has produced page definitions and source-to-page mappings, When the doc generation sub-phase runs, Then for each page needing generation (stale + added per `checkDocCache()`):, `buildPageContext()` extracts the source context from scanner output, `buildPagePrompt()` produces the system + user prompt, An LLM call (Haiku by default) generates the page content, The content is written to `.anatoly/docs/{page}.md`, `assertSafeOutputPath()` validates the output path, `updateDocCacheEntry()` updates the cache with new SHA-256 hashes, And for pages in `fresh` (cache hit), no LLM call is made, And for pages in `removed`, the file is deleted from `.anatoly/docs/` and removed from cache, And `saveDocCache()` persists the updated cache to `.anatoly/docs/.cache.json`
  > AC: Given a second run with no source code changes, When the doc generation sub-phase runs, Then `checkDocCache()` returns all pages as `fresh`, 0 LLM calls are made, and the phase completes in < 1 second
  > AC: Given the documentation axis evaluator runs for a file, When results are being merged in `mergeAxisResults()`, Then `resolveUserDocPlan()` has been called (once per run, not per file) to build the user doc plan, And after all file reviews complete, `scoreDocumentation()` is called with aggregated data from the review phase, And `buildDocRecommendations()` is called with the gaps derived from the documentation axis results and the user doc plan, And each recommendation includes `path_ideal`, `path_user`, `content_ref`, `type`, `rationale`, and `priority`
  > AC: Given a project with no `docs/` directory, When the user plan resolver runs, Then `resolveUserDocPlan()` returns `null`, And recommendations mirror ideal paths under `docs/`
  > AC: Given the report phase runs after review, When `runReportPhase()` generates the master report, Then the report contains a "Documentation Reference" section rendered by `renderDocReferenceSection()`, And the section shows `.anatoly/docs/` page counts (new, refreshed, cached), And the section shows `docs/` coverage percentage and sync gap, And the section lists newly generated pages with their source files
  > AC: Given a Backend API + ORM project, When the documentation scoring runs, Then the scoring weights are adjusted per `computeWeights()` (+10% structural for Backend API, +10% for ORM), And the overall score and verdict (DOCUMENTED / PARTIAL / UNDOCUMENTED) appear in the report
  > AC: Given the review schema `src/schemas/review.ts`, When this story is complete, Then the `ReviewFile` schema includes an optional `doc_recommendations` field:, And the `ReportData` in `reporter.ts` includes:
  > AC: Given any `writeFileSync` call in the doc scaffolder or doc generator code paths, When the output path is constructed, Then `assertSafeOutputPath(outputPath, projectRoot)` is called immediately before the write, And if the path resolves to `docs/`, the pipeline throws and aborts
  > AC: Given a fixture project with `package.json`, `src/` with 5+ modules, and an existing `docs/` directory, When `anatoly run` completes end-to-end, 1. `.anatoly/docs/` exists with scaffolded + generated pages, 2. `.anatoly/docs/.cache.json` exists with SHA-256 entries, 3. `docs/` is byte-for-byte identical to before the run (guard invariant), 4. The report contains the "Documentation Reference" section, 5. The report contains a documentation score with 5 dimensions, 6. The `.rev.json` output includes `doc_recommendations` with dual paths, 7. A second run produces 0 LLM generation calls (100% cache hit)
  > Spec: specs/planning-artifacts/epic-29-doc-scaffolding.md#story-29-15
### Multi-Language — Support multi-langage

- [x] Story 31.1: Language Detection by Extension Distribution
  > > As a **developer running Anatoly on any project** > I want Anatoly to **automatically detect the programming languages present** by scanning file extensions > So that the pipeline knows **which grammars to load and which prompts to use**.
  > AC: Given a project with 100 `.ts` files, 10 `.sh` files, 3 `.py` files, and 2 `.yml` files, When `detectLanguages()` runs, Then it returns `[{ name: 'TypeScript', percentage: 87, fileCount: 100 }, { name: 'Shell', percentage: 9, fileCount: 10 }, { name: 'Python', percentage: 3, fileCount: 3 }, { name: 'YAML', percentage: 2, fileCount: 2 }]` sorted by percentage descending.
  > AC: Given a project with `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` files, When `detectLanguages()` runs, Then `.ts` and `.tsx` are grouped under `TypeScript`, and `.js`, `.jsx`, `.mjs`, `.cjs` are grouped under `JavaScript` — each language appears once with the combined count.
  > AC: Given a project with 200 `.ts` files and 1 `.sh` file (0.5%), When `detectLanguages()` runs, Then `Shell` does NOT appear in the result (filtered at < 1% threshold), And `TypeScript` shows 100%.
  > AC: Given a project containing a `Dockerfile` (no extension) and a `Makefile`, When `detectLanguages()` runs, Then `Dockerfile` and `Makefile` are detected via `FILENAME_MAP` lookup (not extension), And they appear in the distribution with their respective percentages.
  > AC: Given a project with `node_modules/`, `dist/`, `venv/`, `.venv/`, `__pycache__/`, `target/`, `bin/`, `obj/` directories, When `detectLanguages()` runs, Then all files in these directories are excluded from the count, And only project source files contribute to the distribution.
  > AC: Given a project inside a git repository, When `detectLanguages()` runs, Then only git-tracked files are counted (respecting `.gitignore`), And untracked/ignored files do not affect the distribution.
  > AC: Given `detectLanguages()` returns results, Then `totalFiles` equals the sum of all `fileCount` values across all returned languages.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-1
- [x] Story 31.2: Framework Detection by Project Markers
  > > As a **developer running Anatoly on a framework-based project** > I want Anatoly to **detect the frameworks I use** from project configuration files > So that the prompts are **tailored to my framework's conventions and best practices**.
  > AC: Given a project with `package.json` containing `"react": "^19.0.0"` in dependencies, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'react', name: 'React', language: 'typescript' }`.
  > AC: Given a project with `package.json` containing `"next": "^15.0.0"` in dependencies, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'nextjs', name: 'Next.js', language: 'typescript' }`, And React is NOT separately listed (Next.js implies React).
  > AC: Given a project with `next.config.mjs` or `next.config.ts` at root, When `detectProjectProfile()` runs, Then Next.js is detected even if `next` is not in `package.json` dependencies (e.g., monorepo where `next` is in a workspace).
  > AC: Given a project with `requirements.txt` containing `django==5.1`, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'django', name: 'Django', language: 'python' }`.
  > AC: Given a project with `pyproject.toml` containing `fastapi` in `[project.dependencies]`, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'fastapi', name: 'FastAPI', language: 'python' }`.
  > AC: Given a project with `Cargo.toml` containing `actix-web` in `[dependencies]`, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'actix', name: 'Actix Web', language: 'rust' }`.
  > AC: Given a project with `go.mod` containing `github.com/gin-gonic/gin`, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'gin', name: 'Gin', language: 'go' }`.
  > AC: Given a project with `*.csproj` containing `Microsoft.AspNetCore`, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'aspnet', name: 'ASP.NET', language: 'csharp' }`.
  > AC: Given a project with `pom.xml` containing `org.springframework`, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'spring', name: 'Spring', language: 'java' }`.
  > AC: Given a project with `package.json` containing both `@nestjs/core` and `prisma`, When `detectProjectProfile()` runs, Then `frameworks` includes BOTH `{ id: 'nestjs', ... }` AND `{ id: 'prisma', ... }` — multiple frameworks are supported simultaneously.
  > AC: Given a project with no recognizable framework markers, When `detectProjectProfile()` runs, Then `frameworks` is an empty array, And the pipeline continues normally with language-only prompts.
  > AC: Given `detectProjectProfile()` reads a config file that doesn't exist (e.g., `go.mod` when no Go files detected), Then it does NOT attempt to read that file (only reads config files for detected languages), And no error is thrown.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-2
- [x] Story 31.3: Project Info Display — Languages & Frameworks
  > > As a **developer running Anatoly** > I want to see the **language distribution and detected frameworks** in the setup table > So that I can verify Anatoly **correctly understands my project ecosystem**.
  > AC: Given a project with `TypeScript 85%`, `Shell 10%`, `Python 3%`, `YAML 2%`, When the setup table renders, Then the `Project Info` section shows `languages         TypeScript 85% · Shell 10% · Python 3% · YAML 2%`.
  > AC: Given a project with detected frameworks `Next.js` and `Prisma`, When the setup table renders, Then the `Project Info` section shows `frameworks        Next.js · Prisma` on a separate line below `languages`.
  > AC: Given a project with no detected frameworks, When the setup table renders, Then the `frameworks` line does NOT appear in the Project Info section.
  > AC: Given `--plain` mode (CI/CD), When the setup table renders, Then the languages and frameworks are displayed in plain text without box-drawing characters: `languages       TypeScript 85% · Shell 10%`.
  > AC: Given `detectProjectProfile()` completes, Then the setup table is rendered AFTER language and framework detection (before scan), And the `languages` line is positioned after `version` in Project Info.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-3
- [x] Story 31.4: Auto-Detect File Discovery
  > > As a **developer running Anatoly on a multi-language project** > I want Anatoly to **automatically discover non-TypeScript files** without manual configuration > So that shell scripts, Python files, YAML configs, etc.
  > are **included in the analysis**.
  > AC: Given `scan.auto_detect: true` (default) and a project containing `scripts/setup.sh`, When `collectFiles()` runs, Then `scripts/setup.sh` is included in the file list, And the glob `scripts//*.sh` was auto-added to `scan.include`.
  > AC: Given `scan.auto_detect: true` and a project containing `scripts/migrate.py`, When `collectFiles()` runs, Then `scripts/migrate.py` is included, And files in `venv/`, `.venv/`, `__pycache__/` are auto-excluded.
  > AC: Given `scan.auto_detect: true` and a project containing `.github/workflows/ci.yml`, When `collectFiles()` runs, Then `.github/workflows/ci.yml` is included in the file list.
  > AC: Given `scan.auto_detect: true` and a project containing `src/models/user.rs`, When `collectFiles()` runs, Then `src/models/user.rs` is included, And `target/` is auto-excluded.
  > AC: Given `scan.auto_detect: false` explicitly set in `.anatoly.yml`, When `collectFiles()` runs, Then ONLY the patterns in `scan.include` are used, And no auto-detection occurs, And no additional excludes are added.
  > AC: Given `scan.auto_detect: true` and `scan.include: ['src//*.ts']` in `.anatoly.yml`, When `collectFiles()` runs, Then the auto-detected globs are MERGED with the explicit `scan.include` (union), And `src//*.ts` files are still included alongside auto-detected files.
  > AC: Given `scan.auto_detect: true` and a project with no non-TypeScript files, When `collectFiles()` runs, Then the behavior is identical to the current pipeline (no regression), And no additional globs are added.
  > AC: Given auto-detect adds `/*.json` to include patterns, Then `package-lock.json`, `node_modules//*.json`, and `*.map` files are auto-excluded.
  > AC: Given auto-detect runs, Then `scan.exclude` patterns from `.anatoly.yml` take priority over auto-detected includes (user can exclude auto-detected files).
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-4
- [x] Story 31.5: Dynamic Grammar Manager
  > > As a **developer running Anatoly on a multi-language project** > I want tree-sitter grammars to be **downloaded automatically on first use** > So that the npm package stays **lightweight** and I don't need to install grammars manually.
  > AC: Given a project with `.py` files and no grammar cached, When the scanner processes a `.py` file for the first time, Then `grammar-manager` downloads `tree-sitter-python.wasm` from the npm registry, And saves it to `.anatoly/grammars/tree-sitter-python.wasm`, And the file is parsed successfully with the downloaded grammar.
  > AC: Given `.anatoly/grammars/tree-sitter-python.wasm` already exists from a previous run, When the scanner processes a `.py` file, Then NO download occurs, And the cached WASM is loaded directly, And parse time is not affected by network latency.
  > AC: Given the network is unavailable and no cached grammar exists for `.rs` files, When `grammar-manager.resolve('rust')` is called, Then it returns `null`, And the scanner falls back to heuristic parsing for that file, And a warning is logged: `Grammar tree-sitter-rust not available (offline) — using heuristic fallback`.
  > AC: Given `grammar-manager` downloads a WASM file, Then it creates `.anatoly/grammars/manifest.json` tracking `{ "python": { "version": "0.23.3", "sha256": "abc123...", "downloadedAt": "2026-03-21" } }`.
  > AC: Given `tree-sitter-typescript` (Tier 0), When the scanner processes `.ts` or `.tsx` files, Then the bundled grammar is used (resolved via `require.resolve()`), And `grammar-manager` is NOT called for TypeScript/TSX.
  > AC: Given the grammar download completes, Then the `.anatoly/grammars/` directory and its contents are created with standard file permissions, And `.anatoly/grammars/` is added to the project's `.gitignore` recommendation (logged as verbose info).
  > AC: Given the Pipeline Summary renders after grammar resolution, Then it shows `✔ grammars  2 cached · 1 downloaded (tree-sitter-rust)` when 1 grammar was downloaded and 2 were already cached.
  > AC: Given a WASM download fails mid-transfer (corrupted file), Then the partial file is deleted, And the fallback heuristic is used, And the next run re-attempts the download.
  > AC: Given `GRAMMAR_REGISTRY` in `grammar-manager.ts`, Then it contains entries for all 9 Tier 1 languages: bash, python, rust, go, java, csharp, sql, yaml, json, each mapping to the correct npm package name and WASM filename.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-5
- [x] Story 31.6: Language Adapter Interface & TypeScript Refactor
  > > As a **developer maintaining Anatoly** > I want a **clean abstraction** for parsing different languages > So that adding a new language is **a matter of adding files, not modifying the pipeline**.
  > AC: Given a new `LanguageAdapter` interface in `language-adapters.ts`, Then it defines: `extensions: readonly string[]`, `languageId: string`, `wasmModule: string`, `extractSymbols(rootNode: TSNode): SymbolInfo[]`, `extractImports(source: string): ImportRef[]`.
  > AC: Given the existing TypeScript parsing logic in `scanner.ts` (lines 20-166), When the refactor is complete, Then ALL TypeScript-specific code is encapsulated in `TypeScriptAdapter` and `TsxAdapter` implementing `LanguageAdapter`, And `scanner.ts` no longer contains any TypeScript-specific AST node references.
  > AC: Given a `TypeScriptAdapter`, Then `extractSymbols()` produces EXACTLY the same `SymbolInfo[]` output as the current `extractSymbols()` function in `scanner.ts` for all existing test cases — zero regression.
  > AC: Given a file with extension `.ts`, When `parseFile()` runs, Then it resolves the adapter from a registry (`Map<string, LanguageAdapter>`), And uses `adapter.extractSymbols()` instead of the hardcoded function.
  > AC: Given a file with an extension not in any adapter's `extensions` list, When `parseFile()` runs, Then it falls back to `heuristicParse()` (Story 31.12), And `task.parse_method` is set to `'heuristic'`.
  > AC: Given the `TaskSchema`, Then it now includes `language: z.string().optional()` (`'typescript' | 'bash' | 'python' | 'rust' | 'go' | 'java' | 'csharp' | 'sql' | 'yaml' | 'json' | 'unknown'`), `parse_method: z.enum(['ast', 'heuristic']).optional()`, and `framework: z.string().optional()`.
  > AC: Given existing `.task.json` files without `language` or `parse_method` fields, Then they are parsed successfully (fields are `.optional()`), And they are implicitly treated as `language: 'typescript'`, `parse_method: 'ast'`.
  > AC: Given a project with detected frameworks, When `scanProject()` creates tasks, Then each task's `framework` field is set based on the project profile (e.g., all `.tsx` files in a Next.js project get `framework: 'nextjs'`).
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-6
- [x] Story 31.7: Bash/Shell Language Adapter
  > > As a **developer with shell scripts in my project** > I want Anatoly to **parse and extract symbols from .sh and .bash files** > So that my infrastructure scripts are **analyzed with the same rigor as TypeScript**.
  > AC: Given a file `scripts/setup.sh` containing `function setup_gpu() { ... }`, When `BashAdapter.extractSymbols()` runs, Then it returns `{ name: 'setup_gpu', kind: 'function', exported: true, line_start: N, line_end: M }`.
  > AC: Given a file containing `setup_gpu() { ... }` (no `function` keyword), When `BashAdapter.extractSymbols()` runs, Then it still extracts the function with `kind: 'function'`.
  > AC: Given a file containing `DOCKER_IMAGE="ghcr.io/org/repo"` at top-level, When `BashAdapter.extractSymbols()` runs, Then it returns `{ name: 'DOCKER_IMAGE', kind: 'constant', exported: true, ... }`.
  > AC: Given a file containing `result_dir="./output"` at top-level (non-UPPER_SNAKE), When `BashAdapter.extractSymbols()` runs, Then it returns `{ name: 'result_dir', kind: 'variable', exported: true, ... }`.
  > AC: Given a file containing `_internal_helper() { ... }` (underscore-prefixed), When `BashAdapter.extractSymbols()` runs, Then it returns `{ ..., exported: false }`.
  > AC: Given a file containing `source ./lib/helpers.sh` and `. ./lib/logging.sh`, When `BashAdapter.extractImports()` runs, Then it returns `[{ specifier: './lib/helpers.sh' }, { specifier: './lib/logging.sh' }]`.
  > AC: Given a file containing `local my_var="value"` inside a function body (not top-level), When `BashAdapter.extractSymbols()` runs, Then `my_var` is NOT extracted (only top-level symbols).
  > AC: Given the grammar `tree-sitter-bash` is downloaded, Then the adapter loads it via `grammar-manager.resolve('bash')`, And parsing produces correct AST nodes for all test cases.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-7
- [x] Story 31.8: Python Language Adapter
  > > As a **developer with Python scripts in my project** > I want Anatoly to **parse and extract symbols from .py files** > So that my Python code is **analyzed alongside my TypeScript code**.
  > AC: Given a file containing `def process_data(input: str) -> dict:`, When `PythonAdapter.extractSymbols()` runs, Then it returns `{ name: 'process_data', kind: 'function', exported: true, ... }`.
  > AC: Given a file containing `class DataPipeline:`, When `PythonAdapter.extractSymbols()` runs, Then it returns `{ name: 'DataPipeline', kind: 'class', exported: true, ... }`.
  > AC: Given a file containing `MAX_RETRIES = 3` at module-level (UPPER_SNAKE), When `PythonAdapter.extractSymbols()` runs, Then it returns `{ name: 'MAX_RETRIES', kind: 'constant', exported: true, ... }`.
  > AC: Given a file containing `config = load_config()` at module-level (non-UPPER_SNAKE), When `PythonAdapter.extractSymbols()` runs, Then it returns `{ name: 'config', kind: 'variable', exported: true, ... }`.
  > AC: Given a file containing `_internal_helper()` (underscore-prefixed), When `PythonAdapter.extractSymbols()` runs, Then it returns `{ ..., exported: false }`.
  > AC: Given a file with `__all__ = ['public_func']` and both `public_func` and `other_func` defined, When `PythonAdapter.extractSymbols()` runs, Then `public_func` has `exported: true` and `other_func` has `exported: false` (respecting `__all__`).
  > AC: Given a file containing `@click.command()\ndef cli():`, When `PythonAdapter.extractSymbols()` runs, Then it extracts `{ name: 'cli', kind: 'function', ... }` (decorated function).
  > AC: Given a file containing `from utils import helper` and `import os`, When `PythonAdapter.extractImports()` runs, Then it returns `[{ specifier: 'utils', names: ['helper'] }, { specifier: 'os', names: [] }]`.
  > AC: Given a nested function `def outer():\n    def inner():`, When `PythonAdapter.extractSymbols()` runs, Then only `outer` is extracted (top-level only), And `inner` is ignored.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-8
- [x] Story 31.9: Rust Language Adapter
  > > As a **developer with Rust code in my project** > I want Anatoly to **parse and extract symbols from .rs files** > So that my Rust modules are **included in the analysis pipeline**.
  > AC: Given a file containing `pub fn parse(input: &str) -> Result<AST, Error>`, When `RustAdapter.extractSymbols()` runs, Then it returns `{ name: 'parse', kind: 'function', exported: true, ... }`.
  > AC: Given a file containing `fn internal_helper()` (no `pub`), When `RustAdapter.extractSymbols()` runs, Then it returns `{ ..., exported: false }`.
  > AC: Given a file containing `pub struct Config { ... }`, When `RustAdapter.extractSymbols()` runs, Then it returns `{ name: 'Config', kind: 'class', exported: true, ... }`.
  > AC: Given a file containing `pub trait Parser { ... }`, When `RustAdapter.extractSymbols()` runs, Then it returns `{ name: 'Parser', kind: 'type', exported: true, ... }`.
  > AC: Given a file containing `pub enum Color { Red, Green, Blue }`, When `RustAdapter.extractSymbols()` runs, Then it returns `{ name: 'Color', kind: 'enum', exported: true, ... }`.
  > AC: Given a file containing `pub const MAX_SIZE: usize = 1024;`, When `RustAdapter.extractSymbols()` runs, Then it returns `{ name: 'MAX_SIZE', kind: 'constant', exported: true, ... }`.
  > AC: Given a file containing `impl Config { pub fn new() -> Self { ... } }`, When `RustAdapter.extractSymbols()` runs, Then it extracts the `impl` block as `{ name: 'Config', kind: 'class', ... }` (impl block).
  > AC: Given a file containing `use crate::utils::helper;` and `use std::collections::HashMap;`, When `RustAdapter.extractImports()` runs, Then it returns imports for `crate::utils::helper` (internal) and `std::collections::HashMap` (external).
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-9
- [x] Story 31.10: Go Language Adapter
  > > As a **developer with Go code in my project** > I want Anatoly to **parse and extract symbols from .go files** > So that my Go packages are **analyzed with language-appropriate rules**.
  > AC: Given a file containing `func ParseFile(path string) error`, When `GoAdapter.extractSymbols()` runs, Then it returns `{ name: 'ParseFile', kind: 'function', exported: true, ... }` (uppercase = exported).
  > AC: Given a file containing `func parseInternal(s string) int`, When `GoAdapter.extractSymbols()` runs, Then it returns `{ ..., exported: false }` (lowercase = unexported).
  > AC: Given a file containing `type Scanner struct { ... }`, When `GoAdapter.extractSymbols()` runs, Then it returns `{ name: 'Scanner', kind: 'class', exported: true, ... }`.
  > AC: Given a file containing `type Reader interface { Read(p []byte) (n int, err error) }`, When `GoAdapter.extractSymbols()` runs, Then it returns `{ name: 'Reader', kind: 'type', exported: true, ... }`.
  > AC: Given a file containing `func (s *Scanner) Scan() bool`, When `GoAdapter.extractSymbols()` runs, Then it returns `{ name: 'Scan', kind: 'method', exported: true, ... }`.
  > AC: Given a file containing `const MaxRetries = 3`, When `GoAdapter.extractSymbols()` runs, Then it returns `{ name: 'MaxRetries', kind: 'constant', exported: true, ... }`.
  > AC: Given a file containing `import "fmt"` and `import (\n\t"os"\n\t"github.com/gin-gonic/gin"\n)`, When `GoAdapter.extractImports()` runs, Then it returns imports for `fmt`, `os`, and `github.com/gin-gonic/gin`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-10
- [x] Story 31.11: Java, C#, SQL, YAML, JSON Language Adapters
  > > As a **developer running Anatoly on diverse projects** > I want Anatoly to **support Java, C#, SQL, YAML, and JSON parsing** > So that the full Tier 1 language set is covered.
  > AC: Given a file containing `public class UserService { public void process() { ... } }`, When `JavaAdapter.extractSymbols()` runs, Then it returns `[{ name: 'UserService', kind: 'class', exported: true }, { name: 'process', kind: 'method', exported: true }]`.
  > AC: Given a file containing `private static final int MAX = 100;`, When `JavaAdapter.extractSymbols()` runs, Then it returns `{ name: 'MAX', kind: 'constant', exported: false }` (private).
  > AC: Given a file containing `import java.util.List;`, When `JavaAdapter.extractImports()` runs, Then it returns `[{ specifier: 'java.util.List' }]`.
  > AC: Given a file containing `public class OrderProcessor { public async Task<Result> Execute() { ... } }`, When `CSharpAdapter.extractSymbols()` runs, Then it returns `[{ name: 'OrderProcessor', kind: 'class', exported: true }, { name: 'Execute', kind: 'method', exported: true }]`.
  > AC: Given a file containing `internal class Helper { }`, When `CSharpAdapter.extractSymbols()` runs, Then it returns `{ ..., exported: true }` (`internal` = exported within assembly).
  > AC: Given a file containing `using System.Collections.Generic;`, When `CSharpAdapter.extractImports()` runs, Then it returns `[{ specifier: 'System.Collections.Generic' }]`.
  > AC: Given a file containing `CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(255));`, When `SqlAdapter.extractSymbols()` runs, Then it returns `{ name: 'users', kind: 'class', exported: true }`.
  > AC: Given a file containing `CREATE FUNCTION get_user(user_id INT) RETURNS TABLE`, When `SqlAdapter.extractSymbols()` runs, Then it returns `{ name: 'get_user', kind: 'function', exported: true }`.
  > AC: Given `SqlAdapter.extractImports()` is called, Then it returns an empty array (SQL files are self-contained, no import mechanism).
  > AC: Given a file containing top-level keys `services:`, `volumes:`, `networks:`, When `YamlAdapter.extractSymbols()` runs, Then it returns `[{ name: 'services', kind: 'variable' }, { name: 'volumes', kind: 'variable' }, { name: 'networks', kind: 'variable' }]` — all `exported: true`.
  > AC: Given a Docker Compose file with `services:\n  api:\n  db:`, When `YamlAdapter.extractSymbols()` runs, Then `api` and `db` are extracted as `{ kind: 'constant' }` (service definitions under `services`).
  > AC: Given a file containing `{ "scripts": { ... }, "dependencies": { ... } }`, When `JsonAdapter.extractSymbols()` runs, Then it returns top-level keys as `[{ name: 'scripts', kind: 'variable' }, { name: 'dependencies', kind: 'variable' }]`.
  > AC: Given `JsonAdapter.extractImports()` is called, Then it returns an empty array.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-11
- [x] Story 31.12: Heuristic Fallback Parser
  > > As a **developer with files that have no tree-sitter grammar available** > I want Anatoly to **extract approximate symbols via regex** > So that these files are **still included in the analysis** rather than silently ignored.
  > AC: Given a `Makefile` with targets `build:`, `test:`, `deploy:`, When `heuristicParse()` runs, Then it returns `[{ name: 'build', kind: 'function' }, { name: 'test', kind: 'function' }, { name: 'deploy', kind: 'function' }]` with `parseMethod: 'heuristic'`.
  > AC: Given a `Dockerfile` with `FROM node:20 AS builder` and `FROM node:20-slim AS runner`, When `heuristicParse()` runs, Then it returns `[{ name: 'builder', kind: 'function' }, { name: 'runner', kind: 'function' }]`.
  > AC: Given a file containing `API_KEY=sk-abc123` at top-level (UPPER_SNAKE assignment), When `heuristicParse()` runs, Then it returns `{ name: 'API_KEY', kind: 'constant', ... }`.
  > AC: Given a file with < 5 non-empty, non-comment lines, When `heuristicParse()` runs, Then it returns `{ symbols: [], parseMethod: 'heuristic' }` (too trivial to analyze).
  > AC: Given the task created from heuristic parsing, Then `task.parse_method` is `'heuristic'`, And `task.language` is `'unknown'` if the extension is not in `EXTENSION_MAP`.
  > AC: Given a file that HAS a grammar available (e.g., `.py` with tree-sitter-python cached), Then `heuristicParse()` is NEVER called for that file — it is only used as fallback.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-12
- [x] Story 31.13: Usage-Graph Multi-Language Extension
  > > As a **developer running Anatoly on a multi-language project** > I want the usage-graph to **track imports across all supported languages** > So that the utility axis can detect **dead code in shell scripts, Python files, etc.**
  > AC: Given `scripts/setup.sh` containing `source ./lib/helpers.sh`, When `buildUsageGraph()` runs, Then the usage-graph contains an edge from `scripts/setup.sh` → `scripts/lib/helpers.sh`.
  > AC: Given `scripts/lib/helpers.sh` is NOT sourced by any file, When the utility axis evaluates it, Then it is a candidate for `DEAD` (no importers).
  > AC: Given `utils.py` containing `from helpers import format_output`, When `buildUsageGraph()` runs, Then the usage-graph contains an edge referencing `helpers` → `utils.py`.
  > AC: Given `main.rs` containing `use crate::scanner::parse;`, When `buildUsageGraph()` runs, Then the usage-graph contains an edge from `scanner.rs` → `main.rs` for symbol `parse`.
  > AC: Given a YAML file (no import mechanism), When `buildUsageGraph()` runs, Then no edges are created for that file (YAML files are self-contained), And the YAML file is NOT marked as DEAD by the utility axis.
  > AC: Given cross-language imports don't exist (a `.sh` file doesn't import a `.ts` module), When `buildUsageGraph()` runs, Then symbols are NOT linked across language boundaries, And the graph remains language-partitioned for import edges.
  > AC: Given `buildUsageGraph()` signature changes to accept adapters, Then existing TypeScript import extraction produces EXACTLY the same graph as before (zero regression).
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-13
- [x] Story 31.14: Prompt Resolution Cascade
  > > As a **developer maintaining Anatoly** > I want prompts to be **resolved automatically** based on language and framework > So that each file gets the **most specific applicable prompt** without hardcoded logic.
  > AC: Given a `.tsx` file in a Next.js project, When `resolveSystemPrompt('best_practices', 'typescript', 'nextjs')` is called, Then it returns the content of `best-practices.nextjs.system.md`.
  > AC: Given a `.tsx` file in a React project (no Next.js), When `resolveSystemPrompt('best_practices', 'typescript', 'react')` is called, Then it returns the content of `best-practices.react.system.md`.
  > AC: Given a `.py` file in a Django project, When `resolveSystemPrompt('best_practices', 'python', 'django')` is called, And `best-practices.django.system.md` does NOT exist, Then it falls back to `best-practices.python.system.md` (language-level).
  > AC: Given a file in a language with no specific prompt (e.g., TOML with no `best-practices.toml.system.md`), When `resolveSystemPrompt('best_practices', 'toml', undefined)` is called, Then it falls back to `best-practices.system.md` (default TypeScript prompt).
  > AC: Given `resolveSystemPrompt('correction', 'rust', undefined)` is called, And `correction.rust.system.md` does NOT exist, Then it returns the default `correction.system.md`, And the user message will include `Language: rust` as a hint.
  > AC: Given the cascade order is: framework-specific → language-specific → default, Then `resolveSystemPrompt()` checks file existence in exactly that order, And returns the FIRST match found.
  > AC: Given prompts are loaded via static imports (current pattern), When the refactor is complete, Then prompts are loaded dynamically based on the cascade, And TypeScript prompt loading for existing axes produces identical results (zero regression).
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-14
- [x] Story 31.15: Best Practices Prompts — Shell, Python, Rust, Go
  > > As a **developer with non-TypeScript code** > I want the best_practices axis to **evaluate my code with language-appropriate rules** > So that I get **actionable findings** instead of irrelevant TypeScript-specific violations.
  > AC: Given `best-practices.bash.system.md` exists, Then it contains ShellGuard rules: `set -euo pipefail` (CRITICAL), quoted variables (CRITICAL), no `eval` (HIGH), no `cd` without check (HIGH), `[[ ]]` over `[ ]` (MEDIUM), trap for cleanup (MEDIUM), no `ls` parsing (MEDIUM), no hardcoded paths (HIGH), security (CRITICAL), file size (HIGH) — minimum 12 rules with scoring penalties.
  > AC: Given `best-practices.python.system.md` exists, Then it contains PyGuard rules: type hints (HIGH), docstrings (MEDIUM), no `import *` (HIGH), no bare except (CRITICAL), f-strings (MEDIUM), no mutable globals (MEDIUM), context managers (HIGH), no eval/exec (CRITICAL), import organization (MEDIUM), security (CRITICAL), pathlib (MEDIUM) — minimum 13 rules.
  > AC: Given `best-practices.rust.system.md` exists, Then it contains RustGuard rules: no unnecessary `.clone()` (HIGH), no `.unwrap()` in prod (CRITICAL), lifetimes (MEDIUM), no `unsafe` without justification (CRITICAL), doc comments (MEDIUM), clippy compliance (HIGH), traits idiomatiques (MEDIUM), security (CRITICAL), concurrence safe (HIGH) — minimum 10 rules.
  > AC: Given `best-practices.go.system.md` exists, Then it contains GoGuard rules: error handling not ignored (CRITICAL), naming conventions (HIGH), Godoc (MEDIUM), no `panic()` in prod (CRITICAL), context propagation (HIGH), goroutine lifecycle (HIGH), small interfaces (MEDIUM), `defer` for cleanup (MEDIUM), security (CRITICAL) — minimum 10 rules.
  > AC: Given a `.sh` file is evaluated with the best_practices axis, When the LLM responds, Then the response is validated against `BestPracticesResponseSchema` (same Zod schema as TypeScript — score 0-10, rules array, suggestions array), And the `rule_id` values correspond to ShellGuard rule numbers.
  > AC: Given each prompt, Then the output format section is IDENTICAL to the TypeScript prompt (same JSON schema: `{ score, rules: [...], suggestions: [...] }`), And the Zod validation in `best-practices.ts` works without modification.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-15
- [x] Story 31.16: Best Practices Prompts — Java, C#, SQL, YAML, JSON
  > > As a **developer with Java, C#, SQL, YAML, or JSON files** > I want the best_practices axis to **evaluate these files with appropriate rules** > So that all Tier 1 languages have **dedicated quality standards**.
  > AC: Given `best-practices.java.system.md` exists, Then it contains JavaGuard rules: no null return / use Optional (HIGH), Javadoc (MEDIUM), proper exception handling (HIGH), immutability (MEDIUM), naming conventions (HIGH), generics (CRITICAL), try-with-resources (HIGH), security (CRITICAL), Stream API (MEDIUM) — minimum 10 rules.
  > AC: Given `best-practices.csharp.system.md` exists, Then it contains CSharpGuard rules: nullable reference types (HIGH), XML doc comments (MEDIUM), async/await correctness (CRITICAL), IDisposable/using (HIGH), naming conventions (HIGH), immutability (MEDIUM), LINQ (MEDIUM), security (CRITICAL), pattern matching (MEDIUM) — minimum 10 rules.
  > AC: Given `best-practices.sql.system.md` exists, Then it contains SqlGuard rules: parameterized queries (CRITICAL), indexes (HIGH), constraints (HIGH), naming conventions (MEDIUM), no SELECT * (HIGH), explicit transactions (HIGH), comments (MEDIUM), security (CRITICAL) — minimum 8 rules.
  > AC: Given `best-practices.yaml.system.md` exists, Then it contains YamlGuard rules: quoted ambiguous strings (HIGH), no unquoted yes/no (CRITICAL), consistent indentation (MEDIUM), anchors for DRY (MEDIUM), no duplicate keys (CRITICAL), flat structure (HIGH), comments (MEDIUM), security (CRITICAL) — minimum 8 rules.
  > AC: Given `best-practices.json.system.md` exists, Then it contains JsonGuard rules: valid structure (CRITICAL), consistent naming convention (HIGH), no secrets (CRITICAL), no duplicate keys (HIGH), reasonable size (MEDIUM) — minimum 5 rules.
  > AC: Given any of these prompts, Then the output format matches the existing `BestPracticesResponseSchema` (score + rules + suggestions), And no Zod schema changes are required.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-16
- [x] Story 31.17: Documentation Prompts per Language
  > > As a **developer with non-TypeScript code** > I want the documentation axis to **evaluate my code's documentation using language-appropriate criteria** > So that a Python file is checked for **docstrings**, not JSDoc.
  > AC: Given `documentation.bash.system.md` exists, Then it evaluates: function header comments (`# @description`, `## Usage:`), variable comments inline, file header explaining purpose. DOCUMENTED = header comment with description + params. PARTIAL = header exists but incomplete. UNDOCUMENTED = no comment.
  > AC: Given `documentation.python.system.md` exists, Then it evaluates: docstrings (Google/NumPy/Sphinx format), `Args:`, `Returns:`, module docstring. DOCUMENTED = docstring with params + returns. PARTIAL = docstring exists but missing sections. UNDOCUMENTED = no docstring.
  > AC: Given `documentation.rust.system.md` exists, Then it evaluates: doc comments (`///`, `//!`), `# Examples`, `# Errors`, `# Panics` sections. DOCUMENTED = doc comment with example. PARTIAL = doc comment without example. UNDOCUMENTED = no doc comment on pub item.
  > AC: Given `documentation.go.system.md` exists, Then it evaluates: Godoc format (`// FuncName description`), package comment, examples. DOCUMENTED = Godoc comment starting with function name. PARTIAL = comment exists but wrong format. UNDOCUMENTED = no comment on exported symbol.
  > AC: Given `documentation.java.system.md` exists, Then it evaluates: Javadoc (`/ */`), `@param`, `@return`, `@throws`. DOCUMENTED = Javadoc with all tags. PARTIAL = Javadoc missing tags. UNDOCUMENTED = no Javadoc.
  > AC: Given `documentation.csharp.system.md` exists, Then it evaluates: XML doc comments (`///`), `<summary>`, `<param>`, `<returns>`. DOCUMENTED = complete XML doc. PARTIAL = summary only. UNDOCUMENTED = no XML doc.
  > AC: Given `documentation.sql.system.md` exists, Then it evaluates: `--` comments on tables/columns, file header. DOCUMENTED = header + column comments. PARTIAL = some comments. UNDOCUMENTED = no comments.
  > AC: Given `documentation.yaml.system.md` exists, Then it evaluates: `#` comments on non-obvious keys, file header. DOCUMENTED = header + key comments. PARTIAL = some comments. UNDOCUMENTED = no comments.
  > AC: Given a `.json` file is evaluated, Then the documentation axis skips it (JSON has no comment syntax), And all symbols are marked `documentation: 'DOCUMENTED'` with `confidence: 95` and `detail: 'JSON files have no comment syntax — documentation axis not applicable'`.
  > AC: Given any documentation prompt, Then the output format matches `DocumentationResponseSchema` (symbols array with `documentation`/`confidence`/`detail`), And no Zod schema changes are required.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-17
- [x] Story 31.18: Framework-Specific Prompts — React & Next.js
  > > As a **developer working on a React or Next.js project** > I want the best_practices and documentation axes to **use framework-specific rules** > So that I get findings about **hooks rules, server components, App Router patterns**, not just generic TypeScript rules.
  > AC: Given `best-practices.react.system.md` exists, Then it contains rules for: hooks exhaustive deps, no conditional hooks, component memoization (React.memo, useMemo, useCallback), key prop in lists, accessibility (a11y basics), prop types or TypeScript interface for props, no inline function props in JSX, event handler naming (`onXxx`/`handleXxx`), fragment usage, component file organization — minimum 12 rules.
  > AC: Given `best-practices.nextjs.system.md` exists, Then it contains rules for: correct `'use client'` / `'use server'` directives, App Router conventions (page.tsx, layout.tsx, loading.tsx, error.tsx), `generateMetadata` usage, server component data fetching (no useEffect for data), Route Handlers (POST/GET in route.ts), `next/image` over `<img>`, `next/link` over `<a>`, ISR/SSG/SSR selection, middleware patterns, no client-side data fetching when server component suffices — minimum 12 rules.
  > AC: Given `documentation.react.system.md` exists, Then it evaluates: TypeScript interface as props documentation, component JSDoc, usage examples, Storybook stories as living docs. DOCUMENTED = props interface + component JSDoc. PARTIAL = props interface only. UNDOCUMENTED = neither.
  > AC: Given `documentation.nextjs.system.md` exists, Then it evaluates: route documentation, API Route documentation (request/response), middleware documentation, page metadata. Builds on React documentation criteria.
  > AC: Given a `.tsx` file in a Next.js project, When the best_practices axis runs, Then `resolveSystemPrompt('best_practices', 'typescript', 'nextjs')` returns the Next.js prompt, And the evaluation uses Next.js-specific rules instead of generic TypeGuard rules.
  > AC: Given a `.tsx` file in a React project (NOT Next.js), When the best_practices axis runs, Then `resolveSystemPrompt('best_practices', 'typescript', 'react')` returns the React prompt.
  > AC: Given a `.ts` file (non-JSX) in a Next.js project, When the best_practices axis runs, Then `resolveSystemPrompt('best_practices', 'typescript', 'nextjs')` returns the Next.js prompt (all files in a Next.js project use the framework prompt, not just .tsx).
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-18
- [x] Story 31.19: Axis Language & Framework Injection
  > > As a **developer running Anatoly on a multi-language project** > I want all 7 axes to **correctly handle non-TypeScript files** > So that the evaluation is **accurate regardless of the language**.
  > AC: Given a `.sh` file evaluated by the correction axis, When `buildCorrectionUserMessage()` runs, Then the user message includes `## Language: bash` and `## Parse method: ast`, And the code block uses ` ```bash ` fencing (not ` ```typescript `).
  > AC: Given a `.py` file in a Django project evaluated by the overengineering axis, When `buildOverengineeringUserMessage()` runs, Then the user message includes `## Language: python` and `## Framework: django`.
  > AC: Given a `.rs` file evaluated by the tests axis, When `buildTestsUserMessage()` runs, Then the user message includes `## Language: rust`, And the axis knows to look for `#[test]` and `#[cfg(test)]` patterns (not Vitest/Jest).
  > AC: Given a `.java` file evaluated by the utility axis, When `buildUtilityUserMessage()` runs, Then the user message includes `## Language: java`, And the usage-graph data includes Java import edges.
  > AC: Given a `.yml` file evaluated by the duplication axis, When `buildDuplicationUserMessage()` runs, Then the user message includes `## Language: yaml`, And the code block uses ` ```yaml ` fencing.
  > AC: Given ALL 7 axes evaluate a file, Then EVERY axis injects `Language:` and (if applicable) `Framework:` in the user message, And EVERY axis uses dynamic fence language for the code block.
  > AC: Given a TypeScript file in a project with no framework, When any axis builds its user message, Then the output is IDENTICAL to the current behavior (zero regression) — `Language:` defaults to `typescript`, fence is ` ```typescript `.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-19
- [x] Story 31.20: Pipeline Integration & End-to-End Validation
  > > As a **developer running `anatoly run` on a multi-language project** > I want the **entire pipeline to work end-to-end** with non-TypeScript files > So that the report includes **findings from all languages**.
  > AC: Given a project with 50 `.ts`, 5 `.sh`, and 3 `.py` files, When `anatoly run` executes, Then ALL 58 files are scanned, triaged, and evaluated, And the report includes findings from all three languages.
  > AC: Given the pipeline runs, Then the phases execute in order: config → language-detect → framework-detect → auto-detect → grammars → render setup table → scan → triage → usage-graph → estimate → review → report.
  > AC: Given a `.sh` file evaluated by the best_practices axis, Then the review `.rev.json` contains `"language": "bash"` in the task metadata, And the `.rev.md` renders the ShellGuard rules (not TypeGuard).
  > AC: Given a `.py` file triaged as `evaluate`, When the 7 axes run, Then each axis receives `task.language: 'python'` in its `AxisContext`, And the best_practices axis uses PyGuard rules, And the documentation axis evaluates docstrings (not JSDoc).
  > AC: Given a file parsed with heuristic fallback, Then `task.parse_method: 'heuristic'` is set, And all axes receive this information, And the confidence in findings is appropriately lower.
  > AC: Given the report aggregates findings from multiple languages, Then each finding includes the file language in its metadata, And the report groups or labels findings by language when relevant.
  > AC: Given a project with ONLY TypeScript files, When `anatoly run` executes, Then the behavior is IDENTICAL to the pre-v0.6.0 pipeline (zero regression), And `languages` shows `TypeScript 100%`, And no grammars are downloaded, And no auto-detect globs are added.
  > AC: Given a second run on the same project with no file changes, Then cached tasks (SHA-256 unchanged) include `language` and `parse_method` from the first run, And zero re-parsing occurs, And zero grammar re-downloads occur.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-20
### Adversarial Review — Process de review adversariale automatisée

- [x] Story 32.1: Adversarial Review — Epic 28 Stories 28.1–28.3
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 28.1–28.3 > So that the logging infrastructure is **bulletproof**.
  > AC: Given Story 28.1 (Conversation Dump Infrastructure), When each AC is audited, Then every AC is marked IMPLEMENTED with `file:line` proof, And any PARTIAL or MISSING AC is auto-fixed in the same iteration.
  > AC: Given Story 28.2 (RAG LLM Call Logging), When each of the 3 RAG LLM call sites is inspected (`nlp-summarizer.ts:131`, `doc-indexer.ts:126`, `doc-indexer.ts:162`), Then each produces both an ndjson event AND a conversation dump, And any missing coverage is auto-fixed.
  > AC: Given Story 28.3 (Unified Run Context), When commands `scan`, `estimate`, `review`, `watch` are tested, Then each creates a run directory with `anatoly.ndjson`, And any command that doesn't is auto-fixed.
  > AC: Given the review discovers code quality issues (path injection in `conversationDir`, `appendFileSync` in hot path, race conditions between workers), Then each issue is fixed, And a test is added proving the fix.
  > AC: Given all fixes are applied, Then `npm run typecheck && npm run build && npm run test` passes, And the report is written to `.ralph/logs/adversarial-review-28-part1.md`.
  > AC: Given the report, Then it contains 0 CRITICAL and 0 HIGH findings remaining, And minimum 10 total findings were identified across the 3 stories.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-1
- [x] Story 32.2: Adversarial Review — Epic 28 Stories 28.4–28.6
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 28.4–28.6 > So that per-file events, watch logging, and run metrics are **complete and correct**.
  > AC: Given Story 28.4 (Per-file & Per-axis Events), When each of the 14 event types is audited (`file_triage`, `file_review_start`, `file_review_end`, `axis_complete`, `axis_failed`, `file_skip`, `rag_search`, `doc_resolve`, `retry`, etc.), Then each event is emitted at the correct code location, And any missing event is auto-fixed with the correct payload schema.
  > AC: Given Story 28.5 (Watch Mode Logging), When watch mode is audited, Then `watch_start`, `watch_stop`, `file_change`, `file_delete` events are emitted, And session continuity is maintained across file changes, And any gap is auto-fixed.
  > AC: Given Story 28.6 (Run Metrics Timeline), When the timeline reconstruction is audited, Then `ctx.timeline` entries are complete for all phases, And the `run_summary` event contains accurate aggregated metrics, And any inaccuracy is auto-fixed.
  > AC: Given all fixes are applied, Then `npm run typecheck && npm run build && npm run test` passes, And the report is written to `.ralph/logs/adversarial-review-28-part2.md`.
  > AC: Given the report, Then 0 CRITICAL and 0 HIGH findings remaining, And minimum 10 total findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-2
- [x] Story 32.3: Adversarial Review — Epic 29 Stories 29.1–29.6
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 29.1–29.6 > So that project type detection, scaffolding, and the docs guard are **solid**.
  > AC: Given Story 29.1 (Project Type Detection), When `detectProjectTypes()` is audited, Then it correctly handles: React+Prisma→['Frontend','ORM'], bin+commander→['CLI'], workspaces→['Monorepo',...], no deps→['Library'], And any detection gap is auto-fixed.
  > AC: Given Story 29.2 (Documentation Structure Scaffolder), When scaffolding is audited for Backend API+ORM project, Then all expected sections exist (REST-Endpoints, Middleware, Auth, Error-Handling, Data-Model, etc.), And `index.md` is complete, And idempotency (no overwrite) is verified, And any defect is auto-fixed.
  > AC: Given Story 29.3 (Scaffolding Hints), When generated pages are inspected, Then `<!-- SCAFFOLDING: ... -->` comments are present, contextual, max 3 lines, And previously filled pages are not overwritten, And any violation is auto-fixed.
  > AC: Given Story 29.4 (Module Granularity), When module resolution is audited, Then directory-level (8 files > 200 LOC → single page), file-level (2 files > 200 LOC → 2 pages), skip (< 200 LOC) all work correctly, And any misclassification is auto-fixed.
  > AC: Given Story 29.5 (Code→Doc Mapping), When mapping is audited with non-standard layouts (src/api/ instead of src/routes/), Then synonym matching, framework detection, and catch-all work, And every directory > 200 LOC has a page, And any gap is auto-fixed.
  > AC: Given Story 29.6 (Guard Test), When the guard is audited, Then NO code path can write to `docs/`, And the guard test exists and catches regressions, And any bypass is auto-fixed.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-3
- [x] Story 32.4: Adversarial Review — Epic 29 Stories 29.7–29.11
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 29.7–29.11 > So that source analysis, LLM generation, caching, scoring, and reporting are **accurate**.
  > AC: Given Story 29.7 (Source Code Analysis), When the extraction is audited for each page type (modules, API, architecture), Then exported symbols, signatures, JSDoc, file tree are correctly extracted, And token truncation at 8000 tokens works correctly, And any defect is auto-fixed.
  > AC: Given Story 29.8 (LLM Page Content Generation), When generated pages are inspected, Then they follow the template (H1, blockquote summary, H2s, examples), use real function names/paths, include code examples, And architecture pages have Mermaid diagrams, And any quality issue is auto-fixed.
  > AC: Given Story 29.9 (Incremental Cache), When cache behavior is audited, Then: first run generates all pages, second run with no changes = 0 regenerations, changed source = only affected pages regenerated, deleted source = page removed, And any cache miss/false-hit is auto-fixed.
  > AC: Given Story 29.10 (Documentation Scoring), When the 5-dimension scoring is audited (structural 25%, API 25%, modules 20%, quality 15%, navigation 15%), Then weights are applied correctly, project-type adjustments work (Backend API +10% on REST+Auth), And edge case (no docs/ = 0% structural) is handled, And any scoring defect is auto-fixed.
  > AC: Given Story 29.11 (Documentation Reference in Report), When the report section is audited, Then it shows: generated/refreshed/cached counts, `docs/` coverage percentage vs `.anatoly/docs/`, sync gap count, new page list with sources, And any rendering defect is auto-fixed.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-4
- [x] Story 32.5: Adversarial Review — Epic 29 Stories 29.12–29.17
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 29.12–29.17 > So that user doc plan resolution, dual-output, Ralph sync, module injection, and LLM execution are **correct**.
  > AC: Given Story 29.12 (User Doc Plan Resolver), When resolution is audited for: structured docs/, flat docs/, no docs/, non-standard numbering, Then all cases produce correct mappings, And any misresolution is auto-fixed.
  > AC: Given Story 29.13 (Dual-Output Recommendations), When recommendations are audited, Then each includes `path_ideal`, `path_user`, `content_ref`, `type`, `rationale`, `priority`, And all 8 recommendation types are covered, And any missing field is auto-fixed.
  > AC: Given Story 29.14 (Ralph Doc Sync), When sync is audited for: missing_page (creates file), missing_section (appends), outdated_content (updates section), Then user content is NEVER deleted, links are adapted, And any destructive behavior is auto-fixed as CRITICAL.
  > AC: Given Story 29.16 (Module Injection in Scaffolder), When dynamic modules are audited, Then modules from `resolveModuleGranularity` generate real pages in `05-Modules/`, And when no modules exist `06-Development` is renumbered to `05-Development`, And `index.md` includes all dynamic pages, And any gap is auto-fixed.
  > AC: Given Story 29.17 (LLM Execution), When doc generation is audited, Then each `PagePrompt` is sent via SDK with semaphore, content is written to `.anatoly/docs/`, second run = 0 LLM calls, errors don't block other pages, And any defect is auto-fixed.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-5
- [x] Story 32.6: Adversarial Review — Epic 29 Stories 29.18–29.21
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 29.18–29.21 > So that dual doc context, docs_path, coverage distinction, and internal doc pipeline are **solid**.
  > AC: Given Story 29.18 (Dual Doc Context), When the doc resolver is audited, Then both `docs/` (project) and `.anatoly/docs/` (internal) are provided as context with `source` tags, And RAG indexes both with separate sources, And budget is split 50/50, And any tagging defect is auto-fixed.
  > AC: Given Story 29.19 (docs_path Propagation), When `docs_path: 'documentation'` is configured, Then `assertSafeOutputPath`, `buildDocRecommendations`, `resolveUserDocPlan`, `syncDocs` all use `documentation/` instead of `docs/`, And the default (no config) still works, And any hardcoded `'docs'` reference is auto-fixed.
  > AC: Given Story 29.20 (Coverage Distinction), When the report is audited with 209 exports, 94 covered in `docs/`, 192 in `.anatoly/docs/`, Then project docs shows 45%, internal ref shows 92%, module coverage shows correct fraction, And sync recommendations are actionable with type + path_ideal + path_user, And any miscalculation is auto-fixed.
  > AC: Given Story 29.21 (Internal Doc Pipeline), When the pipeline is audited, Then: first run bootstraps `.anatoly/docs/` before RAG, RAG indexes both sources, review pass 1 runs, internal docs are updated post-review, pass 2 runs with enriched context, And subsequent runs skip bootstrap, And `--no-docs` shows deprecation warning, And interrupted bootstrap resumes correctly, And any pipeline defect is auto-fixed.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-6
- [x] Story 32.7: Adversarial Review — Story 30.1 SDK Semaphore
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Story 30.1 > So that the global SDK concurrency semaphore is **correct and deadlock-free**.
  > AC: Given Story 30.1 (SDK Semaphore), When the semaphore implementation is audited, Then: `acquire()` blocks when all slots taken, `release()` frees a slot in FIFO order, crash in evaluator releases the slot (finally block), And the semaphore never deadlocks, And any concurrency defect is auto-fixed.
  > AC: Given `--concurrency 4` and 7 axes (28 potential parallel calls), When the semaphore is audited with `sdkConcurrency: 8`, Then at most 8 SDK calls are in-flight, And the CLI displays `Agents: 6/8 running · 2 available`, And any violation is auto-fixed.
  > AC: Given `--concurrency 1` and `sdkConcurrency: 8`, When a single file with 7 axes runs, Then all 7 axes run in parallel within the 8-slot budget, And the semaphore handles `file concurrency < sdk concurrency` correctly.
  > AC: Given the config schema, Then `sdkConcurrency` has default 8, range 1-20, And validation rejects values outside this range.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written to `.ralph/logs/adversarial-review-30.md`.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 5 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-7
- [x] Story 32.8: Adversarial Review — Epic 31 Stories 31.1–31.5
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.1–31.5 > So that language detection, framework detection, auto-detect, and grammar manager are **correct**.
  > AC: Given Story 31.1 (Language Detection), When `detectLanguages()` is audited, Then: extension grouping works (`.ts`+`.tsx`→TypeScript), <1% languages are filtered, `FILENAME_MAP` catches Dockerfile/Makefile, excluded dirs are ignored, git-tracked filter works, And any detection bug is auto-fixed.
  > AC: Given Story 31.2 (Framework Detection), When `detectProjectProfile()` is audited, Then: React from package.json, Next.js from deps OR `next.config.*`, Django from requirements.txt, Actix from Cargo.toml, Gin from go.mod, ASP.NET from .csproj, Spring from pom.xml, multiple frameworks simultaneously, empty result when none found, And config files only read for detected languages, And any false positive/negative is auto-fixed.
  > AC: Given Story 31.3 (Project Info Display), When the setup table is audited, Then: languages line shows `TypeScript 85% · Shell 10%`, frameworks line appears only when detected, plain mode works, And display renders after detection, And any rendering defect is auto-fixed.
  > AC: Given Story 31.4 (Auto-Detect), When `autoDetectFiles()` is audited, Then: auto_detect true adds correct globs per language, venv/target/bin/obj are excluded, auto_detect false = no auto-detection, merge with explicit scan.include works, user excludes take priority, And zero regression for TS-only projects, And any discovery defect is auto-fixed.
  > AC: Given Story 31.5 (Grammar Manager), When `grammar-manager.ts` is audited, Then: download to `.anatoly/grammars/` works, cache avoids re-download, offline fallback to heuristic works, manifest.json tracks versions, bundled TS is NOT downloaded, corrupted files are cleaned up, And Pipeline Summary shows `✔ grammars 2 cached · 1 downloaded`, And any grammar loading defect is auto-fixed.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-8
- [x] Story 32.9: Adversarial Review — Epic 31 Stories 31.6–31.11
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.6–31.11 > So that all language adapters **correctly extract symbols and imports**.
  > AC: Given Story 31.6 (LanguageAdapter Interface + TS Refactor), When the refactor is audited, Then: `scanner.ts` contains zero TS-specific AST references, TypeScriptAdapter produces identical output to pre-refactor (zero regression), unknown extensions fallback to heuristic, TaskSchema includes `language`/`parse_method`/`framework`, backward compat with old `.task.json` works, And any regression is auto-fixed.
  > AC: Given Story 31.7 (BashAdapter), When each AC is audited against the actual implementation, Then: `function` and `()` syntax both extract functions, UPPER_SNAKE → constant, non-UPPER_SNAKE → variable, `_` prefix → not exported, `source`/`.` → imports, local vars NOT extracted, And any extraction bug is auto-fixed with a regression test.
  > AC: Given Story 31.8 (PythonAdapter), When each AC is audited, Then: `def` → function, `class` → class, UPPER_SNAKE → constant, `_` prefix → not exported, `__all__` overrides convention, decorated functions extracted, imports extracted, nested functions ignored, And any bug is auto-fixed.
  > AC: Given Story 31.9 (RustAdapter), When each AC is audited, Then: `pub fn` → exported function, no `pub` → not exported, `pub struct` → class, `pub trait` → type, `pub enum` → enum, `pub const` → constant, `use` → imports, And any bug is auto-fixed.
  > AC: Given Story 31.10 (GoAdapter), When each AC is audited, Then: uppercase → exported, lowercase → not exported, struct → class, interface → type, method receiver → method, const → constant, imports extracted, And any bug is auto-fixed.
  > AC: Given Story 31.11 (Java/C#/SQL/YAML/JSON), When each of the 5 adapters is audited against all ACs, Then: Java class+method+constant+import, C# class+method+using, SQL CREATE TABLE→class + CREATE FUNCTION→function, YAML top-level keys + Docker Compose services, JSON top-level keys, SQL/YAML/JSON extractImports returns empty, And any bug is auto-fixed.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-9
- [x] Story 32.10: Adversarial Review — Epic 31 Stories 31.12–31.14
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.12–31.14 > So that heuristic parsing, usage-graph extension, and prompt cascade are **correct**.
  > AC: Given Story 31.12 (Heuristic Parser), When `heuristicParse()` is audited, Then: Makefile targets extracted, Dockerfile stages extracted, UPPER_SNAKE assignments extracted, trivial files (< 5 lines) return empty, heuristic is never called when a grammar is available, And any extraction bug is auto-fixed.
  > AC: Given Story 31.13 (Usage-Graph Multi-Language), When the extended usage-graph is audited, Then: `source`/`.` bash creates edges, Python `import` creates edges, Rust `use` creates edges, YAML/JSON/SQL have no edges, TypeScript graph is unchanged (zero regression), cross-language edges are NOT created, And any graph defect is auto-fixed.
  > AC: Given Story 31.14 (Prompt Resolution Cascade), When `resolveSystemPrompt()` is audited, Then: cascade order is framework → language → default, `.tsx` in Next.js → `best-practices.nextjs.system.md`, `.py` in Django (no django prompt) → `best-practices.python.system.md`, unknown language → default, TypeScript prompt loading unchanged (zero regression), And any cascade defect is auto-fixed.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-10
- [x] Story 32.11: Adversarial Review — Epic 31 Stories 31.15–31.18
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.15–31.18 > So that all language and framework prompts are **complete, correct, and produce valid Zod output**.
  > AC: Given Story 31.15 (Best Practices Shell/Python/Rust/Go), When each prompt is audited, Then: ShellGuard has ≥12 rules with correct severities, PyGuard has ≥13 rules, RustGuard has ≥10 rules, GoGuard has ≥10 rules, And each prompt's output format matches `BestPracticesResponseSchema` exactly (same JSON structure), And any missing rule or format defect is auto-fixed.
  > AC: Given Story 31.16 (Best Practices Java/C#/SQL/YAML/JSON), When each prompt is audited, Then: JavaGuard ≥10 rules, CSharpGuard ≥10 rules, SqlGuard ≥8 rules, YamlGuard ≥8 rules, JsonGuard ≥5 rules, And output format matches `BestPracticesResponseSchema`, And any defect is auto-fixed.
  > AC: Given Story 31.17 (Documentation Prompts), When each of the 8 doc prompts is audited (Bash, Python, Rust, Go, Java, C#, SQL, YAML), Then: each uses the correct documentation convention for its language (docstrings, doc comments, Javadoc, etc.), JSON files are skipped (all DOCUMENTED), output matches `DocumentationResponseSchema`, And any defect is auto-fixed.
  > AC: Given Story 31.18 (React & Next.js Prompts), When the 4 framework prompts are audited, Then: React best_practices has hooks rules, memo, a11y, key prop (≥12 rules), Next.js has server/client components, App Router, generateMetadata (≥12 rules), documentation prompts evaluate props/routes appropriately, And `.tsx` in Next.js project uses the correct prompt, And `.ts` (non-JSX) in Next.js also uses Next.js prompt, And any defect is auto-fixed.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, report written.
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-11
- [x] Story 32.12: Adversarial Review — Epic 31 Stories 31.19–31.20
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.19–31.20 > So that axis injection and end-to-end integration are **bulletproof**.
  > AC: Given Story 31.19 (Axis Language & Framework Injection), When all 7 axes are audited, Then: every axis injects `## Language:` and `## Framework:` (when applicable) in the user message, every axis uses dynamic code fence (` ```bash `, ` ```python `, etc.), TypeScript files produce identical output to pre-v0.6.0 (zero regression), And any missing injection is auto-fixed.
  > AC: Given Story 31.20 (Pipeline E2E), When a multi-language project (50 .ts + 5 .sh + 3 .py) is processed, Then: all 58 files scanned/triaged/evaluated/reported, pipeline phases execute in correct order, `.rev.json` contains `language` field, `.rev.md` uses correct language rules, heuristic-parsed files have lower confidence, And report groups findings by language.
  > AC: Given a TypeScript-only project, When `anatoly run` executes, Then: behavior is IDENTICAL to pre-v0.6.0 (zero regression), no grammars downloaded, no auto-detect globs added, `languages` shows `TypeScript 100%`.
  > AC: Given a second run with no changes, Then: zero re-parsing, zero grammar re-downloads, cached tasks include `language`/`parse_method`.
  > AC: Given all fixes, Then `npm run typecheck && npm run build && npm run test` passes, And a real `anatoly run` on the Anatoly codebase itself produces a valid report with findings from multiple languages (TS + Shell at minimum).
  > AC: Given the report, Then 0 CRITICAL/HIGH remaining, minimum 10 findings identified.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-12
### Gemini Provider Foundation
> Goal: Users can enable Gemini in `.anatoly.yml`, verify connectivity via `anatoly providers`, and confirm their Google auth works. The transport abstraction is in place, both providers are wired, but no axes are routed yet.

- [x] Story 37.1: Create LlmTransport interface and TransportRouter
  > As a developer
  > I want a common `LlmTransport` interface that abstracts LLM I/O
  > So that `runSingleTurnQuery()` can work with any provider without knowing the implementation.
  > AC: Given the new file `src/core/transports/index.ts` exists, When I inspect its exports, Then it exports `LlmTransport`, `LlmRequest`, `LlmResponse`, and `TransportRouter` types/classes, And `LlmTransport` has `readonly provider: string`, `supports(model: string): boolean`, and `query(params: LlmRequest): Promise<LlmResponse>`, And `LlmResponse` includes `text`, `costUsd`, `durationMs`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `transcript`, `sessionId`, And `TransportRouter.resolve(model)` returns the first transport where `supports(model)` returns true, And `TransportRouter.resolve(model)` throws if no transport matches
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-37-1
- [x] Story 37.2: Create AnthropicTransport wrapping existing execQuery()
  > As a developer
  > I want the existing Claude SDK call path extracted into an `AnthropicTransport` class
  > So that it conforms to the `LlmTransport` interface without any behavior change.
  > AC: Given `src/core/transports/anthropic-transport.ts` exists, When `AnthropicTransport.query()` is called with the same parameters as `execQuery()`, Then it produces identical results (text, cost, tokens, transcript), And `supports(model)` returns `true` for any model NOT starting with `gemini-`, And `provider` is `'anthropic'`
  > AC: Given `runSingleTurnQuery()` in `axis-evaluator.ts` is updated, When called without an explicit transport parameter, Then it uses `AnthropicTransport` as default (backward compatible), When called with a transport parameter, Then it uses that transport for the I/O and keeps JSON extraction + Zod validation + retry logic unchanged
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-37-2
- [x] Story 37.3: Create GeminiTransport
  > As a developer
  > I want a `GeminiTransport` class that wraps `@google/gemini-cli-core`
  > So that Gemini Flash calls conform to the `LlmTransport` interface.
  > AC: Given `src/core/transports/gemini-transport.ts` exists, When `GeminiTransport` is constructed with `projectRoot` and `model`, Then it lazy-initializes a `Config` + `geminiClient` on first `query()` call, And auth uses `getAuthTypeFromEnv() || AuthType.LOGIN_WITH_GOOGLE`
  > AC: Given `GeminiTransport.query()` is called, When the system prompt and user message are provided, Then it calls `client.resetChat()` before each call (history isolation), Then it sets the system instruction via `client.getChat().setSystemInstruction()`, Then it consumes `sendMessageStream()` and assembles text from `content` events, Then it extracts `usageMetadata` from the `finished` event, Then it returns `LlmResponse` with `costUsd: 0`, correct token counts, and a transcript
  > AC: Given `supports(model)` is called, When model starts with `gemini-`, Then returns `true`
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-37-3
- [x] Story 37.4: Add GeminiConfigSchema to .anatoly.yml
  > As a user
  > I want to configure Gemini provider settings in `.anatoly.yml`
  > So that I can opt-in to Gemini routing and customize model names.
  > AC: Given `.anatoly.yml` has a `llm.gemini` section, When `gemini.enabled` is `false` (default), Then no Gemini transport is instantiated and all calls go to Claude
  > AC: Given `gemini.enabled` is `true`, When the config is loaded, Then `flash_model` defaults to `gemini-3-flash-preview`, And `nlp_model` defaults to `gemini-2.5-flash`, And `sdk_concurrency` defaults to `12`
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-37-4
- [x] Story 37.5: Gemini auth check and graceful fallback
  > As a user
  > I want the system to verify Gemini auth at startup and fall back to Claude if it fails
  > So that my run is never blocked by a missing Google login.
  > AC: Given Gemini is enabled but auth fails, When the run starts, Then a warning is displayed: `⚠ Gemini activé mais auth Google introuvable. Exécutez gemini une fois. Fallback Claude.`, And Gemini is disabled for this run (non-blocking), And all axes route to Claude as if `gemini.enabled: false`
  > AC: Given Gemini is enabled and auth succeeds, When the run starts, Then Gemini transport is initialized and ready for routing
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-37-5
- [x] Story 37.6: Create `anatoly providers` command
  > As a user
  > I want to run `anatoly providers` to verify that each configured provider is reachable
  > So that I can diagnose auth and connectivity issues before starting a run.
  > AC: Given I run `anatoly providers`, When Claude API key is valid and Gemini auth is valid, Then a table is displayed with: Provider, Model, Status (✓/✗), Latency, Auth method, And each provider/model is tested with a minimal prompt ("Respond OK")
  > AC: Given I run `anatoly providers --json`, When the tests complete, Then JSON output is produced with `{ providers: [{ provider, model, status, latencyMs, auth }] }`
  > AC: Given Gemini is not enabled in config, When I run `anatoly providers`, Then only Claude models are tested (no Gemini rows)
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-37-6
### Review Axes on Gemini Flash
> Goal: Utility, duplication, and overengineering axes run on Gemini Flash — faster results, no Claude rate limit stalls. Circuit breaker ensures Gemini outages fall back to Claude transparently.

- [x] Story 38.1: Route review axes to Gemini via defaultGeminiMode
  > As a user
  > I want utility, duplication, and overengineering axes to run on Gemini Flash when enabled
  > So that my Claude quota is preserved for the quality-critical axes.
  > AC: Given Gemini is enabled in config, When `resolveAxisModel()` is called for an evaluator with `defaultGeminiMode: 'flash'`, Then it returns `config.llm.gemini.flash_model` (e.g. `gemini-3-flash-preview`)
  > AC: Given Gemini is enabled in config, When `resolveAxisModel()` is called for an evaluator without `defaultGeminiMode` (correction, best_practices), Then it returns the Claude model (existing behavior unchanged)
  > AC: Given an explicit per-axis override exists (`config.llm.axes[axis].model`), When `resolveAxisModel()` is called, Then the override takes precedence over Gemini routing
  > AC: Given `file-evaluator.ts` runs the axes, When the resolved model starts with `gemini-`, Then the `GeminiTransport` is used for that axis call, And the Gemini semaphore is used (not the Claude semaphore)
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-38-1
- [x] Story 38.2: Separate concurrency semaphores for Claude and Gemini
  > As a system
  > I want Claude and Gemini to have independent concurrency semaphores
  > So that rate limits on one provider don't throttle the other.
  > AC: Given a run with Gemini enabled, When the pipeline starts, Then two semaphores are created: Claude (`sdk_concurrency`, default 24) and Gemini (`gemini.sdk_concurrency`, default 12)
  > AC: Given an axis resolved to Gemini, When `runSingleTurnQuery()` acquires a semaphore, Then it uses the Gemini semaphore
  > AC: Given an axis resolved to Claude, When `runSingleTurnQuery()` acquires a semaphore, Then it uses the Claude semaphore
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-38-2
- [x] Story 38.3: Implement circuit breaker for Gemini fallback
  > As a system
  > I want to stop sending requests to Gemini after 3 consecutive failures and fall back to Claude
  > So that a Gemini outage doesn't stall the entire run.
  > AC: Given Gemini transport encounters 3 consecutive errors (429, timeout, or connection error), When the circuit breaker trips, Then all subsequent Gemini-routed calls for this run are redirected to Claude, And a single CLI warning is displayed: `⚠ Gemini quota exhausted — falling back to Claude`, And the circuit breaker state is logged in structured logs
  > AC: Given the circuit breaker is tripped, When 5 minutes have elapsed, Then the circuit breaker enters half-open state and allows one test call, Then the circuit breaker resets and Gemini routing resumes
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-38-3
### RAG NLP on Gemini + Observability
> Goal: NLP summarization runs on Gemini ($0 vs $2+/run). Run metrics and CLI output show provider breakdown for full cost/quota visibility.

- [x] Story 39.1: Route NLP summarization to Gemini Flash
  > As a user
  > I want RAG NLP summarization to run on Gemini 2.5 Flash when enabled
  > So that I save $2+ per run on Haiku costs.
  > AC: Given Gemini is enabled, When `generateNlpSummaries()` is called during RAG indexing, Then the model used is `config.llm.gemini.nlp_model` (default: `gemini-2.5-flash`), And the call goes through `GeminiTransport`, And cost is reported as `$0.00`
  > AC: Given Gemini is disabled, When `generateNlpSummaries()` is called, Then the model used is the existing `index_model` (Haiku) via Claude — no change
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-39-1
- [x] Story 39.2: Add provider field to logs and run metrics
  > As a developer
  > I want structured logs and run metrics to include the provider for each LLM call
  > So that I can analyze quota usage and performance by provider.
  > AC: Given a run with Gemini enabled completes, When I inspect `run-metrics.json`, Then it includes a `providers` object: `{ anthropic: { calls, axes }, gemini: { calls, axes } }`, And it includes `claude_quota_saved_pct`
  > AC: Given a run with Gemini enabled, When I inspect `anatoly.ndjson` structured logs, Then each `llm_call` event includes `provider: 'anthropic' | 'gemini'`
  > AC: Given a run completes, When the CLI summary is displayed, Then cost line shows: `Cost: $X (Claude) · $0.00 (Gemini)`, And quota line shows: `Quota: N Claude · M Gemini (−X%)`
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-39-2
### Quality Validation
> Goal: Developers validate that Gemini routing produces equivalent quality via gold-set comparison against Claude reference results.

- [x] Story 40.1: Gold-set validation — Gemini vs Claude comparison
  > As a developer
  > I want to compare Gemini results against Claude reference results on a gold-set
  > So that I can validate quality before enabling Gemini in production.
  > AC: Given a gold-set of files from the rustguard project (aead.rs, timers.rs), When I run the comparison script, Then utility accuracy is ≥95% vs Claude reference, And overengineering accuracy is ≥85% vs Claude reference, And NLP summary produces valid schema output for ≥90% of files
  > AC: Given the spike scripts exist in `spike/`, When validation is complete, Then the spike directory can be cleaned up (scripts are throwaway)
  > Spec: specs/planning-artifacts/epic-gemini-provider.md#story-40-1
### Refinement 3-Tier
> Goal: L'utilisateur obtient des reviews de meilleure qualité à moindre coût grâce à un pipeline de refinement qui élimine les faux positifs mécaniques (tier 1), les contradictions logiques (tier 2), et vérifie empiriquement les findings ambigus (tier 3).

- [x] Story 41.1: Retirer la délibération per-file et écrire les ReviewFiles bruts
  > As a développeur du pipeline
  > I want supprimer l'appel Opus per-file dans `file-evaluator.ts` et écrire les ReviewFiles directement après le merge des axes
  > So that la phase review ne bloque plus 44 min de wall-clock sur la délibération et la refinement phase puisse opérer sur des reviews bruts.
  > AC: Given `file-evaluator.ts` est modifié, When `evaluateFile()` termine le merge des 7 axes, Then il écrit le ReviewFile JSON + MD immédiatement sans appeler `runSingleTurnQuery` avec le modèle de délibération, And le champ `verdict` est calculé par la logique de merge existante (pas par Opus), And les fonctions `needsDeliberation`, `buildDeliberationUserMessage`, `buildDeliberationSystemPrompt` sont dépréciées mais non supprimées (tier 3 les réutilisera peut-être)
  > AC: Given un run complet sans délibération, When la phase review termine, Then les ReviewFile JSON contiennent les verdicts bruts des axes sans reclassification, And aucun appel Opus n'est fait pendant la review phase, And le coût de la review phase diminue d'environ $63
  > AC: Given `correction-memory.ts`, When la review phase termine, Then `recordReclassification` n'est plus appelé depuis `file-evaluator.ts`, And la deliberation-memory.json existante n'est pas modifiée ni lue pendant la review
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-1
- [x] Story 41.2: Tier 1 — Auto-resolve déterministe
  > As a utilisateur d'anatoly
  > I want que les faux positifs mécaniques soient éliminés instantanément sans appel LLM
  > So that le rapport ne contienne pas de findings trivialement faux (DEAD quand l'usage graph dit USED, UNIQUE quand pas de candidats RAG).
  > AC: Given `src/core/refinement/tier1.ts` existe avec une fonction `applyTier1(review: ReviewFile, ctx: Tier1Context): ReviewFile`, When un ReviewFile contient un symbole exporté avec `utility: DEAD` et le usage graph montre ≥ 1 runtime importers, Then le symbole est reclassifié `utility: USED` avec confidence 95 et detail "Auto-resolved: runtime-imported by N files", And le ReviewFile est réécrit sur disque (JSON + MD)
  > AC: Given un symbole exporté avec `utility: DEAD` et 0 importers de tout type mais des usages transitifs, When tier 1 est appliqué, Then le symbole est reclassifié `utility: USED` avec detail "Auto-resolved: transitively used by X"
  > AC: Given un symbole avec `duplication: DUPLICATE` mais aucun candidat RAG (score < 0.68 ou pas de RAG data), When tier 1 est appliqué, Then le symbole est reclassifié `duplication: UNIQUE` avec confidence 90
  > AC: Given un symbole avec `duplication: DUPLICATE` et la fonction fait ≤ 2 lignes, When tier 1 est appliqué, Then le symbole est reclassifié `duplication: UNIQUE` avec detail "Trivial function (≤ 2 lines)"
  > AC: Given un symbole avec `overengineering: OVER` et kind = interface/type/enum, When tier 1 est appliqué, Then le symbole est reclassifié `overengineering: LEAN`
  > AC: Given un symbole avec `overengineering: OVER` et la fonction fait ≤ 5 lignes, When tier 1 est appliqué, Then le symbole est reclassifié `overengineering: LEAN`
  > AC: Given un symbole avec `tests: NONE` et aucun fichier test n'existe pour ce fichier source, When tier 1 est appliqué, Then le verdict `tests: NONE` est confirmé (pas de changement, mais marqué comme vérifié)
  > AC: Given un symbole exporté avec `documentation: UNDOCUMENTED` et un bloc JSDoc existe avant le symbole (> 20 chars), When tier 1 est appliqué, Then le symbole est reclassifié `documentation: DOCUMENTED` avec confidence 90
  > AC: Given un symbole de type interface/type/enum avec ≤ 5 champs et des noms auto-descriptifs, When tier 1 est appliqué et le symbole est marqué `documentation: UNDOCUMENTED`, Then le symbole est reclassifié `documentation: DOCUMENTED` avec detail "Self-descriptive type"
  > AC: Given un fichier dans un chemin contenant `__gold-set__` ou `__fixtures__`, When tier 1 est appliqué, Then tous les findings correction/utility sont marqués comme skip avec detail "Intentional fixture code"
  > AC: Given `Tier1Context` est construit, When la refinement phase démarre, Then le contexte contient : usage graph, AST metadata (symbol kinds, line ranges, JSDoc présence), RAG index, coverage report
  > AC: Given tous les ReviewFiles sont traités par tier 1, When tier 1 termine, Then la durée totale est < 1 seconde, And aucun appel réseau n'a été fait
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-2
- [x] Story 41.3: Tier 2 — Cohérence inter-axes via Flash Lite
  > As a utilisateur d'anatoly
  > I want que les contradictions logiques entre axes soient détectées et résolues automatiquement
  > So that le rapport ne contienne pas d'absurdités (corriger du code mort, tester du code dupliqué, etc.).
  > AC: Given `src/core/refinement/tier2.ts` existe avec une fonction `applyTier2(review: ReviewFile): Promise<{ review: ReviewFile; escalated: EscalatedFinding[] }>`, When un symbole a `utility: DEAD` et `correction: NEEDS_FIX`, Then `correction` est reclassifié à skip/OK avec detail "Moot — symbol is DEAD"
  > AC: Given un symbole a `utility: DEAD` et `overengineering: OVER`, When tier 2 est appliqué, Then `overengineering` est reclassifié à skip/OK
  > AC: Given un symbole a `utility: DEAD` et `duplication: DUPLICATE`, When tier 2 est appliqué, Then `duplication` est reclassifié à skip/OK
  > AC: Given un symbole a `utility: DEAD` et `tests: WEAK` ou `tests: NONE`, When tier 2 est appliqué, Then `tests` est marqué skip
  > AC: Given un symbole a `utility: DEAD` et `documentation: UNDOCUMENTED`, When tier 2 est appliqué, Then `documentation` est marqué skip
  > AC: Given un symbole a `correction: NEEDS_FIX` avec confidence < 75 et aucun autre axe n'a de finding, When tier 2 est appliqué, Then le finding est ajouté à la liste `escalated` pour tier 3 avec raison "Low confidence isolated finding"
  > AC: Given un symbole a `correction: ERROR`, When tier 2 est appliqué, Then le finding est toujours escaladé vers tier 3 (jamais auto-résolu)
  > AC: Given tier 2 est implémenté comme un single-turn Gemini Flash Lite, When le prompt est construit, Then il contient uniquement le ReviewFile JSON (pas le code source), And l'output est un JSON structuré avec `resolutions[]` et `escalate_to_tier3[]`
  > AC: Given le prompt tier 2 inclut les principes de validation de la délibération, When un finding concerne un changement de default/config, Then il est escaladé vers tier 3 avec raison "Behavioral change — needs investigation"
  > AC: Given tous les fichiers sont traités par tier 2, When tier 2 termine, Then la durée totale est < 60 secondes, And le coût total est < $0.05
  > AC: Given tier 2 détecte un pattern cross-file (ex: > 10 symboles DEAD dans le même module), When ce pattern est détecté, Then un finding synthétique est ajouté à `escalated` avec raison "Systemic pattern: N DEAD symbols in module X"
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-3
- [x] Story 41.4: Tier 3 — Investigation agentic Opus
  > As a utilisateur d'anatoly
  > I want que les findings ambigus soient vérifiés empiriquement par un agent qui lit le code et vérifie les claims
  > So that les reclassifications sont basées sur des preuves, pas sur du raisonnement en chambre.
  > AC: Given `src/core/refinement/tier3.ts` existe avec une fonction `runTier3(shards: Shard[], ctx: Tier3Context): Promise<Tier3Result>`, When les findings escaladés par tier 2 sont groupés en shards, Then chaque shard contient 10-20 fichiers regroupés par module/directory, And les findings sont présentés comme une liste de claims à vérifier (pas le code source)
  > AC: Given l'agent Opus tier 3 est lancé sur un shard, When il reçoit la liste de findings, Then il a accès aux tools : Read, Grep, Glob, Bash, And Bash est restreint à read-only (pas de Write, Edit, ni commandes destructives), And maxTurns est borné à 100
  > AC: Given l'agent investigue un finding `correction: NEEDS_FIX` sur un symbole, When il lit le code source du fichier, Then il peut confirmer ou infirmer le finding avec des preuves (lignes de code, grep results), And il produit un verdict `confirmed` ou `reclassified` avec reasoning
  > AC: Given l'agent investigue un finding `utility: DEAD` sur un symbole exporté, When il grep le codebase pour les usages, Then il peut trouver des imports que l'usage graph a manqués (shell source, dynamic imports, etc.)
  > AC: Given l'agent investigue un finding sur une valeur constante (ex: CODE_DIM), When il lit le fichier de configuration runtime (embeddings-ready.json, .env, etc.), Then il peut vérifier si la valeur actuelle correspond au finding
  > AC: Given l'agent termine l'investigation d'un shard, When il produit son output, Then l'output est un JSON structuré compatible avec le format `DeliberationResponse` existant, And chaque reclassification inclut un `reasoning` de ≥ 10 caractères avec les preuves
  > AC: Given tier 3 reclassifie un finding, When le résultat est appliqué, Then le ReviewFile JSON + MD du fichier concerné est mis à jour, And une entrée est ajoutée à `deliberation-memory.json` via `recordReclassification`
  > AC: Given tier 3 traite un shard et rencontre une erreur (timeout, rate limit), When l'erreur survient, Then le shard en cours est marqué comme failed avec le nombre de findings traités, And les shards restants continuent normalement (isolation par shard), And les findings non-traités du shard failed restent inchangés dans les ReviewFiles
  > AC: Given le coût total tier 3 dépasse un budget configurable (default: $30), When le budget est atteint, Then les shards restants sont skippés avec un warning, And les findings non-traités restent inchangés
  > AC: Given tier 3 termine tous les shards, When le résultat est consolidé, Then un rapport de refinement est généré avec : nombre de findings investigués, confirmés, reclassifiés, et le coût total
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-4
- [x] Story 41.5: Intégration pipeline et UI
  > As a utilisateur d'anatoly
  > I want voir la progression du refinement dans le CLI et obtenir un rapport basé sur les reviews raffinés
  > So that je sais exactement ce que fait le pipeline et le rapport reflète les verdicts finaux.
  > AC: Given `run.ts` est modifié pour inclure la refinement phase, When la phase review termine, Then la refinement phase démarre automatiquement, And elle exécute tier 1 → tier 2 → tier 3 séquentiellement, And chaque tier opère sur les ReviewFile JSON écrits par la phase précédente
  > AC: Given le screen renderer affiche la progression, When tier 1 tourne, Then le task affiche "Tier 1 — auto-resolve" avec un compteur de fichiers traités, When tier 2 tourne, Then le task affiche "Tier 2 — coherence" avec un compteur + nombre de findings escaladés, When tier 3 tourne, Then le task affiche "Tier 3 — investigation" avec shard N/M et findings traités
  > AC: Given `pipeline-state.ts` est mis à jour, When la refinement phase est active, Then `phase` est `'refinement'`, And les tasks tier-1, tier-2, tier-3 sont visibles dans le renderer
  > AC: Given le mode plain est activé (`--plain`), When la refinement phase tourne, Then les logs séquentiels affichent : `✔ tier-1 — 120 files, 45 findings resolved`, `✔ tier-2 — 90 files, 12 escalated`, `✔ tier-3 — 3 shards, 35 findings investigated`
  > AC: Given la refinement phase termine, When la report phase démarre, Then elle lit les ReviewFile JSON finaux (post-tier 3), And le rapport reflète les verdicts post-refinement, And aucun changement n'est nécessaire dans le code du reporter
  > AC: Given la refinement phase est optionnelle, When l'utilisateur passe `--no-deliberation`, Then la refinement phase est entièrement skippée, And les ReviewFiles bruts sont utilisés pour le rapport (comportement identique à aujourd'hui avec `--no-deliberation`)
  > AC: Given le run metrics inclut les stats de refinement, When le run termine, Then les metrics affichent : nombre de findings auto-résolus (tier 1), findings résolus par cohérence (tier 2), findings investigués (tier 3), coût total refinement
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-5
- [x] Story 41.6: Validation qualité — Comparaison old vs new
  > As a développeur du pipeline
  > I want comparer les reclassifications du nouveau pipeline vs l'ancien sur le même jeu de données
  > So that je puisse vérifier que la qualité ne régresse pas et quantifier l'amélioration.
  > AC: Given le run 192337 existe avec ses ReviewFiles bruts et la deliberation-memory.json, When le nouveau pipeline (tier 1+2+3) est exécuté sur les mêmes ReviewFiles bruts, Then un rapport de comparaison est généré montrant :
  > AC: Given les 336 reclassifications historiques dans deliberation-memory.json, When les tiers 1+2 sont exécutés seuls (sans tier 3), Then ≥ 86% des reclassifications historiques sont reproduites (basé sur l'analyse empirique : 191 tier 1 + 244 tier 2 = 435/504 changements d'axes)
  > AC: Given le tier 3 est exécuté sur les findings escaladés, When il investigue les ~35 findings restants, Then il reproduit ou améliore ≥ 80% des 69 reclassifications historiques qui nécessitaient investigation, And il identifie au minimum le cas FIX-017 (CODE_DIM 3584→768) comme faux positif
  > AC: Given le rapport de comparaison est disponible, When un développeur le lit, Then il peut identifier les cas où le nouveau pipeline est meilleur et ceux où il manque des reclassifications, And les cas manqués sont documentés pour améliorer les règles tier 1/2
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-6
- [x] Story 41.7: Adversarial review — Audit de chaque story complétée
  > As a développeur du pipeline
  > I want qu'un revieweur cynique et sceptique audite chaque story implémentée avec accès complet au code
  > So that les bugs, edge cases, régressions et oublis sont détectés avant le merge.
  > AC: Given les stories 41.1 à 41.6 sont marquées done, When l'adversarial review est lancé, Then chaque story est auditée individuellement dans une session isolée (subagent ou process séparé), And le revieweur a accès Read/Grep/Glob/Bash au codebase mais aucun contexte préalable sur l'implémentation
  > AC: Given le revieweur audite la story 41.1 (retrait délibération), When il inspecte `file-evaluator.ts`, Then il vérifie que : aucun appel Opus ne subsiste dans la review phase, les ReviewFiles sont écrits sans reclassification, la deliberation-memory n'est pas touchée pendant la review, et `--no-deliberation` fonctionne toujours
  > AC: Given le revieweur audite la story 41.2 (tier 1), When il inspecte `refinement/tier1.ts`, Then il vérifie que : chaque règle auto-resolve est correcte (pas de faux négatifs), les fichiers gold-set sont protégés, les types z.infer sont détectés, la durée est < 1s, et aucun appel réseau n'est fait
  > AC: Given le revieweur audite la story 41.3 (tier 2), When il inspecte `refinement/tier2.ts` et le prompt, Then il vérifie que : les patterns de contradiction sont exhaustifs, les correction ERROR ne sont jamais auto-résolus, l'escalade vers tier 3 fonctionne, et le coût est < $0.05
  > AC: Given le revieweur audite la story 41.4 (tier 3), When il inspecte `refinement/tier3.ts`, Then il vérifie que : le sharding par module est correct, maxTurns est borné, Bash est read-only (pas de Write/Edit), le budget cap fonctionne, les crashes par shard sont isolés, et la deliberation-memory est mise à jour correctement
  > AC: Given le revieweur audite la story 41.5 (intégration), When il inspecte `run.ts` et le screen renderer, Then il vérifie que : les 3 tiers s'enchaînent correctement, la progression est affichée, le mode plain fonctionne, le report lit les JSON post-refinement, et les metrics de coût sont correctes
  > AC: Given le revieweur audite la story 41.6 (validation), When il compare les résultats avec le baseline legacy dans `.anatoly/baseline/`, Then il vérifie que : le taux de reproduction des reclassifications historiques est ≥ 86% (tier 1+2), le tier 3 identifie le cas FIX-017, et le coût total est < $20
  > AC: Given l'adversarial review produit ses findings, When le rapport est présenté, Then chaque finding a : une sévérité (CRITICAL/HIGH/MEDIUM/LOW), le fichier et la ligne concernés, une description factuelle du problème, et une suggestion de fix, And les findings CRITICAL et HIGH doivent être résolus avant le merge
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-7
### Config Restructuring — Séparation providers/models/agents/axes/runtime

- [x] Story 42.1: Schema Zod — Nouvelles sections config
  > As a développeur d'anatoly
  > I want un schema Zod structuré en sections orthogonales providers/models/agents/axes/runtime
  > So that chaque section a une responsabilité unique et la config est lisible et maintenable.
  > AC: Given `src/schemas/config.ts` est modifié, When `LlmConfigSchema` et `GeminiConfigSchema` sont supprimés, Then ils sont remplacés par `AnthropicProviderConfigSchema`, `GoogleProviderConfigSchema`, `ProvidersConfigSchema`, `ModelsConfigSchema`, `AgentsConfigSchema`, `RuntimeConfigSchema`, And `AxesConfigSchema` est sorti de `LlmConfigSchema` et placé en top-level (déjà le cas dans le fichier, seule la référence dans `ConfigSchema` change)
  > AC: Given `ProvidersConfigSchema` est défini, When un config YAML ne mentionne pas `providers`, Then le default est `{ anthropic: { concurrency: 24 } }` — anthropic toujours présent, And `google` est absent (undefined) — Gemini désactivé par défaut
  > AC: Given `GoogleProviderConfigSchema` est défini, When un config YAML contient `providers.google: {}`, Then le parse réussit avec `mode: 'subscription'` et `concurrency: 10` (defaults), And `providers.google.mode` accepte uniquement `'subscription'` ou `'api'`
  > AC: Given `ModelsConfigSchema` est défini, When un config YAML ne mentionne pas `models`, Then les defaults sont `quality: 'claude-sonnet-4-6'`, `fast: 'claude-haiku-4-5-20251001'`, `deliberation: 'claude-opus-4-6'`, `code_summary: undefined`
  > AC: Given `AgentsConfigSchema` est défini, When un config YAML ne mentionne pas `agents`, Then le default est `{ enabled: true }` avec `scaffolding`, `review`, `deliberation` tous undefined
  > AC: Given `RuntimeConfigSchema` est défini, When un config YAML ne mentionne pas `runtime`, Then les defaults sont `timeout_per_file: 600`, `max_retries: 3`, `concurrency: 8`, `min_confidence: 70`, `max_stop_iterations: 3`
  > AC: Given `ConfigSchema` est mis à jour, When on parse un YAML vide `{}`, Then toutes les sections ont leurs defaults, And le type `Config` n'a plus de champ `llm`, And `agentic_tools` n'existe nulle part dans le schema
  > AC: Given les types sont exportés, When un fichier importe depuis `schemas/config.ts`, Then `AnthropicProviderConfig`, `GoogleProviderConfig`, `ProvidersConfig`, `ModelsConfig`, `AgentsConfig`, `RuntimeConfig`, `AxisConfig`, `Config` sont disponibles
  > Spec: specs/planning-artifacts/epic-42-config-restructuring.md#story-42-1
- [x] Story 42.2: Migration backward compat — `migrateConfigV0toV1`
  > As a utilisateur avec un `.anatoly.yml` existant au format `llm.*`
  > I want que ma config continue de fonctionner sans modification manuelle
  > So that la mise à jour d'anatoly ne casse pas mon workflow.
  > AC: Given `migrateConfigV0toV1()` est implémenté dans `src/utils/config-loader.ts`, When un objet YAML contient `llm` et pas `models`, Then il est transformé en nouveau format :
  > AC: Given l'ancien config a `llm.gemini.enabled: true`, When la migration est appliquée, Then `providers.google` est créé avec `mode` et `concurrency` mappés, And `llm.gemini.flash_model` est propagé comme `model` sur les axes mécaniques (`utility`, `duplication`, `overengineering`) qui n'ont pas déjà un override
  > AC: Given l'ancien config a `llm.gemini.enabled: true` et `llm.gemini.nlp_model: 'gemini-2.5-flash'`, When la migration est appliquée, Then `models.code_summary` est défini à `'gemini-2.5-flash'`
  > AC: Given l'ancien config a `llm.gemini.enabled: false` ou pas de section `llm.gemini`, When la migration est appliquée, Then `providers.google` est absent (Gemini désactivé), And `models.code_summary` est absent
  > AC: Given un YAML contient déjà `models` (nouveau format), When `migrateConfigV0toV1` est appelé, Then il retourne l'objet inchangé (pas de double migration)
  > AC: Given `loadConfig()` détecte un ancien format, When le config est chargé, Then un warning est affiché sur stderr :, Run `anatoly migrate-config` to update your config file., Legacy format supported until v2.0., And le résultat de `loadConfig()` est identique à celui d'un nouveau format équivalent
  > AC: Given `anatoly migrate-config` est exécuté, When `.anatoly.yml` contient l'ancien format, Then `.anatoly.yml.bak` est créé (backup), And `.anatoly.yml` est réécrit au nouveau format, And le parse du nouveau fichier réussit sans warning
  > Spec: specs/planning-artifacts/epic-42-config-restructuring.md#story-42-2
- [x] Story 42.3: Résolution modèles — Nouvelles fonctions resolve* et suppression defaultGeminiMode
  > As a développeur du pipeline
  > I want que la résolution de modèles utilise les nouveaux chemins config sans branche Gemini implicite
  > So that le routage est déterminé par le nom de modèle dans la config (explicite) et non par un flag caché sur l'évaluateur.
  > AC: Given l'interface `AxisEvaluator` dans `axis-evaluator.ts`, When elle est mise à jour, Then le champ `readonly defaultGeminiMode?: 'flash'` est supprimé, And `readonly defaultModel: 'sonnet' | 'haiku'` est conservé, And la signature de `evaluate()` est inchangée
  > AC: Given `resolveAxisModel(evaluator, config)` est réécrit, When `config.axes.[evaluator.id].model` est défini, Then il est retourné directement, When `config.axes.[evaluator.id].model` est absent, Then le fallback est `evaluator.defaultModel === 'haiku' ? config.models.fast : config.models.quality`, And il n'y a plus de branche `if (evaluator.defaultGeminiMode === 'flash' && config.llm.gemini.enabled)`
  > AC: Given `resolveNlpModel` est renommé `resolveCodeSummaryModel`, When il est appelé, Then il retourne `config.models.code_summary ?? config.models.fast`, And il n'y a plus de branche `config.llm.gemini.enabled`
  > AC: Given `resolveDeliberationModel` est réécrit, When il est appelé, Then il retourne `config.agents.deliberation ?? config.models.deliberation`
  > AC: Given une nouvelle fonction `resolveAgentModel(phase, config)` est ajoutée, When `phase` est `'scaffolding'` ou `'review'`, Then il retourne `config.agents[phase] ?? config.models.quality`
  > AC: Given les 3 axes avec `defaultGeminiMode`, When `utility.ts`, `duplication.ts`, `overengineering.ts` sont modifiés, Then la ligne `readonly defaultGeminiMode = 'flash' as const` est supprimée de chacun
  > AC: Given `axes/index.ts`, When il référence `config.llm.axes`, Then il est mis à jour vers `config.axes`
  > Spec: specs/planning-artifacts/epic-42-config-restructuring.md#story-42-3
- [x] Story 42.4: Migration des consommateurs — Tous les chemins `config.llm.*`
  > As a développeur d'anatoly
  > I want que tous les fichiers qui lisent `config.llm.*` soient migrés vers les nouveaux chemins
  > So that le projet compile sans erreur TS et le comportement runtime est identique.
  > AC: Given `src/commands/run.ts` (~40 références), When il est migré, Then les mappings suivants sont appliqués :, And la mutation `config.llm.sdk_concurrency = cliSdkConcurrency` est remplacée par `config.providers.anthropic.concurrency = cliSdkConcurrency`, And la mutation `config.llm.gemini.enabled = false` (fallback auth) est remplacée par une variable locale `let geminiEnabled = !!config.providers.google` qui est mise à false si l'auth échoue
  > AC: Given `src/commands/providers.ts`, When il est migré, Then tous les `config.llm.model`, `config.llm.index_model`, `config.llm.deliberation_model` → `config.models.*`, And `config.llm.fast_model` → supprimé (n'existe plus), And `config.llm.gemini.*` → `config.providers.google.*`, And `config.llm.sdk_concurrency` → `config.providers.anthropic.concurrency`, And le check `config.llm.gemini?.enabled` → `!!config.providers.google`
  > AC: Given `src/commands/estimate.ts`, When il est migré, Then `config.llm.concurrency` → `config.runtime.concurrency`, And `config.llm.sdk_concurrency` → `config.providers.anthropic.concurrency`, And `config.llm.gemini.enabled ? config.llm.gemini.nlp_model : config.llm.index_model` → `resolveCodeSummaryModel(config)`
  > AC: Given `src/commands/review.ts` et `src/commands/watch.ts`, When ils sont migrés, Then `config.llm.sdk_concurrency` → `config.providers.anthropic.concurrency`
  > AC: Given `src/commands/hook.ts`, When il est migré, Then `config.llm.min_confidence` → `config.runtime.min_confidence`, And `config.llm.max_stop_iterations` → `config.runtime.max_stop_iterations`
  > AC: Given `src/core/file-evaluator.ts`, When il est migré, Then `config.llm.model` → `config.models.quality`
  > AC: Given `src/rag/standalone.ts`, When il est migré, Then `config.llm.concurrency` → `config.runtime.concurrency`, And `config.llm.index_model` → `config.models.fast`
  > AC: Given tous les fichiers sont migrés, When `npx tsc --noEmit` est exécuté, Then zéro erreur TypeScript, When `npx vitest run` est exécuté, Then tous les tests passent
  > Spec: specs/planning-artifacts/epic-42-config-restructuring.md#story-42-4
- [x] Story 42.5: Validation gold-set et .anatoly.yml v1.0
  > As a mainteneur d'anatoly
  > I want valider que le refactoring config n'a introduit aucune régression
  > So that le comportement du pipeline est strictement identique avant et après.
  > AC: Given le gold-set de base existe, When `npx vitest run src/prompts/__gold-set__/gold-set.test.ts` est exécuté, Then tous les tests passent, And la baseline JSON produite est identique à la baseline pré-epic-42 (diff = 0 lignes)
  > AC: Given `.anatoly.yml` du projet est au nouveau format v1.0, When `anatoly run --dry-run` est exécuté, Then l'affichage des modèles et providers est correct, And aucun warning de format legacy n'est affiché
  > AC: Given un `.anatoly.yml` legacy (ancien format `llm.*`) est utilisé, When `anatoly run --dry-run` est exécuté, Then le warning de migration est affiché, And le comportement est identique à celui du nouveau format équivalent
  > AC: Given un `.anatoly.yml` sans section `providers.google`, When `anatoly run --dry-run` est exécuté, Then Gemini est désactivé, And tous les axes utilisent les modèles Claude (models.quality / models.fast), And aucune erreur liée à `providers.google` undefined
  > AC: Given `.anatoly.yml` est mis à jour au format v1.0, When le fichier est committable, Then le format correspond à l'exemple de référence dans l'architecture (section Epic 42)
  > Spec: specs/planning-artifacts/epic-42-config-restructuring.md#story-42-5
### Multi-Provider Migration — Vercel AI SDK, prefixes provider, TransportRouter mode-aware

- [x] Story 43.1: Schema Zod — mode sur providers, providers génériques
  > As a utilisateur d'anatoly
  > I want configurer le mode (subscription/api) de chaque provider et ajouter des providers custom
  > So that je peux utiliser mes propres clés API ou des providers non-natifs sans modifier le code.
  > AC: Given `AnthropicProviderConfigSchema` est étendu, When il est parsé sans champ `mode`, Then le default est `'subscription'`, And les valeurs acceptées sont `'subscription'` et `'api'`
  > AC: Given `AnthropicProviderConfigSchema` est étendu, When il contient `single_turn: 'subscription'` et `agents: 'api'`, Then les deux champs sont parsés correctement, And `mode` est ignoré au profit de `single_turn`/`agents` dans la logique de résolution
  > AC: Given `GoogleProviderConfigSchema` est étendu, When il contient `mode: 'api'`, Then le transport sélectionné sera Vercel AI SDK (pas gemini-cli-core)
  > AC: Given `providers.anthropic` dans `ConfigSchema`, When il est absent du YAML, Then `config.providers.anthropic` est `undefined` (optionnel), And un YAML sans aucun provider est invalide (au moins un provider requis)
  > AC: Given `GenericProviderConfigSchema` est défini, When un provider custom est ajouté (ex: `providers.qwen: { mode: api }`), Then le parse réussit via `.catchall()`, And `base_url` et `env_key` sont optionnels (fournis par le registre connu ou par l'utilisateur)
  > AC: Given un YAML avec `providers.ollama: { mode: api }`, When il est parsé, Then le parse réussit, And `concurrency` default est `8`
  > Spec: specs/planning-artifacts/epic-43-multi-provider-migration.md#story-43-1
- [x] Story 43.2: Registre des providers connus
  > As a développeur d'anatoly
  > I want un registre centralisé des providers avec leurs URLs et env vars par défaut
  > So that les utilisateurs n'aient pas à chercher les base_url et env_key manuellement.
  > AC: Given `src/core/providers/known-providers.ts` existe, When il est importé, Then `KNOWN_PROVIDERS` contient les entrées pour : `anthropic`, `google`, `openai`, `qwen`, `groq`, `deepseek`, `mistral`, `openrouter`, `ollama`, And chaque entrée a `base_url` (null pour natifs), `env_key`, et `type` (`native` ou `openai-compatible`)
  > AC: Given un provider est dans `KNOWN_PROVIDERS` avec `type: 'native'`, When le transport Vercel SDK le résout, Then il utilise le SDK natif (`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`)
  > AC: Given un provider est dans `KNOWN_PROVIDERS` avec `type: 'openai-compatible'`, When le transport Vercel SDK le résout, Then il utilise `createOpenAICompatible({ baseURL, name, apiKey })`
  > AC: Given un provider n'est PAS dans `KNOWN_PROVIDERS`, When il est utilisé avec un `base_url` dans la config YAML, Then il est traité comme `openai-compatible`, When il est utilisé SANS `base_url`, Then une erreur est levée : `Unknown provider "X" — add base_url in .anatoly.yml`
  > AC: Given la config YAML override `base_url` ou `env_key` pour un provider connu, When le transport le résout, Then les valeurs YAML priment sur le registre
  > Spec: specs/planning-artifacts/epic-43-multi-provider-migration.md#story-43-2
- [x] Story 43.3: Model prefixes + migration `migrateConfigV1toV2`
  > As a utilisateur d'anatoly
  > I want que les noms de modèles incluent le provider (`anthropic/claude-sonnet-4-6`)
  > So that le routing est explicite et je peux mélanger les providers librement dans ma config.
  > AC: Given `migrateConfigV1toV2()` est implémenté dans `config-loader.ts`, When un YAML contient `models.quality: 'claude-sonnet-4-6'` (bare name), Then il est transformé en `'anthropic/claude-sonnet-4-6'`, And les règles d'inférence sont :
  > AC: Given un YAML contient `axes.utility.model: 'gemini-2.5-flash-lite'`, When la migration est appliquée, Then il devient `'google/gemini-2.5-flash-lite'`
  > AC: Given un YAML contient déjà des préfixes (`anthropic/claude-sonnet-4-6`), When `migrateConfigV1toV2` est appelé, Then il retourne l'objet inchangé (pas de double préfixage)
  > AC: Given `loadConfig()` détecte un format v1 (pas de préfixes), When le config est chargé, Then un warning est affiché indiquant d'exécuter `anatoly migrate-config`, And la migration est appliquée automatiquement en mémoire
  > AC: Given `extractProvider(modelId)` est implémenté, When `modelId` contient un `/` (ex: `anthropic/claude-sonnet-4-6`), Then il retourne `'anthropic'`, When `modelId` est un bare name (ex: `claude-sonnet-4-6`), Then il retourne `'anthropic'` par inférence (`claude-*` → anthropic, `gemini-*` → google), When `modelId` est un bare name inconnu, Then il retourne `'anthropic'` (fallback par défaut)
  > Spec: specs/planning-artifacts/epic-43-multi-provider-migration.md#story-43-3
- [x] Story 43.4: Transport Vercel AI SDK + suppression @google/genai + cost calculator
  > As a développeur d'anatoly
  > I want un transport LLM unifié via Vercel AI SDK pour tout appel en mode API
  > So that ajouter un nouveau provider nécessite une seule ligne dans le registre, pas un nouveau fichier transport.
  > AC: Given `src/core/transports/vercel-sdk-transport.ts` est créé, When il implémente `LlmTransport`, Then `provider` est `'vercel-sdk'`, And `supports(model)` retourne true pour tout modèle dont le provider est en mode `api`, And `query(params)` utilise `generateText()` de `ai` avec le modèle résolu via `getVercelModel()`
  > AC: Given `getVercelModel(modelId, config)` est implémenté, When le provider est `'anthropic'` → retourne `anthropic(model)` de `@ai-sdk/anthropic`, When le provider est `'google'` → retourne `google(model)` de `@ai-sdk/google`, When le provider est `'openai'` → retourne `openai(model)` de `@ai-sdk/openai`, When le provider est `openai-compatible` → retourne `createOpenAICompatible({ baseURL, name, apiKey })(model)`
  > AC: Given la clé API du provider est absente, When `getVercelModel()` est appelé, Then une erreur est levée : `No API key for provider "X". Set {ENV_KEY} in your environment.`
  > AC: Given `@google/genai` est dans `package.json`, When il est supprimé, Then `src/core/transports/gemini-genai-transport.ts` est supprimé, And toutes les références à `GeminiGenaiTransport` sont remplacées par le `VercelSdkTransport` avec `@ai-sdk/google`
  > AC: Given `LlmResponse` est retourné par `VercelSdkTransport`, When `usage` est disponible, Then `costUsd` est calculé via `calculateCost(modelId, usage)` du cost calculator, And `inputTokens` = `usage.promptTokens`, And `outputTokens` = `usage.completionTokens`, And `cacheReadTokens` = `usage.cachedPromptTokens ?? 0`
  > AC: Given `src/utils/cost-calculator.ts` est créé, When il est appelé avec un modèle connu, Then le coût est calculé en USD à partir de la table de pricing statique, When il est appelé avec un modèle inconnu, Then il retourne `0` (pas de crash)
  > AC: Given les pricing de `gemini-genai-transport.ts` (GEMINI_PRICING), When le cost calculator est créé, Then ils sont consolidés dans la table unique de `cost-calculator.ts`
  > Spec: specs/planning-artifacts/epic-43-multi-provider-migration.md#story-43-4
- [x] Story 43.5: Transport router refactoré — mode-aware + nettoyage globals
  > As a développeur du pipeline
  > I want que le transport router sélectionne le bon transport selon le mode du provider dans la config
  > So that subscription et API coexistent sans globals mutables ni cache de transport.
  > AC: Given `TransportRouter` dans `src/core/transports/index.ts`, When il est refactoré, Then `resolve(model, task?)` accepte un `task` optionnel (`'single_turn'` | `'agents'`, default: `'single_turn'`), And il utilise `extractProvider(model)` pour identifier le provider, And il consulte `config.providers[provider]` pour déterminer le mode, And il route :
  > AC: Given le split `single_turn`/`agents` est configuré, When `task` est `'single_turn'` et `providers.anthropic.single_turn` est `'subscription'`, Then le transport est `AnthropicTransport`, When `task` est `'agents'` et `providers.anthropic.agents` est `'api'`, Then le transport est `VercelSdkTransport`
  > AC: Given le `TransportRouter` est instancié, When il reçoit `config` au constructeur, Then il crée les transports nécessaires (lazy, un par provider+mode distinct), And il n'utilise plus de cache global ni de `setGeminiTransportType()`
  > AC: Given `axis-evaluator.ts` contient `setGeminiTransportType`, `_geminiTransportType`, `geminiTransportCache`, `getOrCreateGeminiTransport`, When ils sont supprimés, Then `runSingleTurnQuery` reçoit le router via `SingleTurnQueryParams.router` (ou `transport` résolu en amont), And le circuit breaker continue de fonctionner — il modifie le modèle avant le routing
  > AC: Given `SingleTurnQueryParams`, When il est mis à jour, Then le champ `transport?: LlmTransport` est conservé (injection directe), And les champs `geminiSemaphore` et `fallbackModel` sont conservés (circuit breaker), And le routing par défaut dans `runSingleTurnQuery` utilise le router si pas de `transport` injecté
  > AC: Given `run.ts` appelle `setGeminiTransportType(config.llm.gemini.type)`, When la ligne est supprimée, Then le mode est déterminé par `config.providers.google.mode` dans le router, And l'auth check Gemini utilise le mode depuis la config au lieu du type legacy
  > Spec: specs/planning-artifacts/epic-43-multi-provider-migration.md#story-43-5
- [x] Story 43.6: Agents Vercel AI SDK + bash-tool + web search
  > As a utilisateur d'anatoly en mode API
  > I want que les agents (tier 3, doc-generation) fonctionnent sans abonnement Claude Code Max
  > So that je peux utiliser anatoly en CI/CD ou avec une simple clé API.
  > AC: Given `src/core/agents/vercel-agent.ts` est créé, When `runVercelAgent(params)` est appelé, Then il utilise `generateText()` avec `maxSteps` (default: 20), And le tool `bash-tool` est disponible (`@vercel/ai-sdk-bash-tool`), And `bash-tool` est en read-only par défaut (`allowWrite: false`), And `allowWrite: true` est possible via paramètre (pour doc-generation)
  > AC: Given le modèle de l'agent est en mode `subscription`, When l'agent est invoqué, Then le transport natif est utilisé (Claude Code SDK ou Gemini CLI) — `VercelAgent` n'est PAS appelé
  > AC: Given le modèle de l'agent est en mode `api`, When l'agent est invoqué, Then `runVercelAgent` est utilisé avec le modèle résolu par le router
  > AC: Given `src/core/tools/web-search.ts` est créé, When `getSearchTool(config)` est appelé, Then il retourne :
  > AC: Given `runVercelAgent` est appelé avec `allowSearch: true` et un search tool disponible, When l'agent est exécuté, Then le web search tool est inclus dans les tools disponibles
  > AC: Given l'agent Vercel SDK termine, When le résultat est retourné, Then `costUsd` est calculé via le cost calculator, And `text` contient la sortie finale de l'agent
  > AC: Given le Tier 3 refinement invoque un agent, When le provider du modèle de délibération est en mode `api`, Then `runVercelAgent` est utilisé au lieu de Claude Code SDK, And le bash-tool est en read-only, And `maxSteps` est borné à 100 (comme dans la spec Tier 3)
  > Spec: specs/planning-artifacts/epic-43-multi-provider-migration.md#story-43-6
- [x] Story 43.7: Onboarding `anatoly init` — configuration interactive multi-provider
  > As a nouvel utilisateur d'anatoly
  > I want être guidé dans le choix des providers, modes et modèles
  > So that ma config `.anatoly.yml` est correcte du premier coup sans lire la documentation.
  > AC: Given `anatoly init` est exécuté, When l'utilisateur lance la commande, Then un wizard interactif propose :
  > AC: Given l'utilisateur sélectionne un provider en mode `subscription`, When le provider est `anthropic`, Then aucune clé API n'est demandée (Claude Code SDK), When le provider est `google`, Then aucune clé API n'est demandée (gemini-cli-core OAuth), When le provider est autre chose, Then une erreur est affichée : `Subscription mode only available for Anthropic and Google`
  > AC: Given l'utilisateur sélectionne un provider en mode `api`, When la variable d'environnement correspondante est déjà définie, Then elle est détectée automatiquement : `✓ GOOGLE_API_KEY detected`, When elle n'est pas définie, Then l'utilisateur est invité à la saisir ou à l'ajouter manuellement
  > AC: Given les modèles sont sélectionnés, When l'écriture de `.anatoly.yml` est confirmée, Then le fichier est écrit au format v2 (avec préfixes provider), And un test minimal de connexion est lancé (un appel `generateText` avec prompt "Say OK") pour chaque provider en mode API, And un résumé est affiché
  > AC: Given `.anatoly.yml` existe déjà, When `anatoly init` est exécuté, Then l'utilisateur est prévenu et peut choisir de repartir de zéro ou de modifier la config existante
  > Spec: specs/planning-artifacts/epic-43-multi-provider-migration.md#story-43-7
- [x] Story 43.8: Validation gold-set + migration `.anatoly.yml` v2.0
  > As a mainteneur d'anatoly
  > I want valider que la migration multi-provider n'a introduit aucune régression
  > So that les résultats sont strictement identiques que le transport soit subscription ou API.
  > AC: Given le gold-set existe, When il est exécuté avec la config subscription (mode Epic 42), Then la baseline est identique à la baseline pré-epic-43
  > AC: Given le gold-set existe, When il est exécuté avec `providers.google.mode: api` et `GOOGLE_API_KEY`, Then les résultats axes Gemini sont identiques à ceux via `@google/genai` (supprimé), And la baseline diff est 0 ou dans la marge de variance LLM acceptable
  > AC: Given un `.anatoly.yml` au format v1 (noms bare, pas de mode sur anthropic), When `anatoly run --dry-run` est exécuté, Then le warning migration est affiché, And le comportement est identique au format v2 équivalent
  > AC: Given `.anatoly.yml` du projet est migré au format v2, When il contient les préfixes provider et le champ `mode`, Then aucun warning n'est affiché, And `anatoly run --dry-run` affiche correctement les providers et modes
  > AC: Given `@google/genai` n'est plus dans `package.json`, When `npm ls @google/genai` est exécuté, Then le package n'est pas trouvé
  > Spec: specs/planning-artifacts/epic-43-multi-provider-migration.md#story-43-8
### User Instructions — Calibration personnalisée
> Goal: L'utilisateur obtient des reviews calibrées à ses conventions projet grâce à un fichier `ANATOLY.md` dont le contenu est injecté dans les prompts d'évaluation pour permettre au LLM de distinguer les choix délibérés des manquements réels.

- [x] Story 44.1: Loader et parser `ANATOLY.md`
  > As a utilisateur d'anatoly
  > I want fournir un fichier `ANATOLY.md` à la racine de mon projet avec mes conventions par axe
  > So that anatoly comprenne les spécificités de mon projet lors de l'évaluation.
  > AC: Given `src/utils/user-instructions.ts` existe avec `loadUserInstructions(projectRoot: string): UserInstructions`, When `ANATOLY.md` existe à la racine du projet avec des sections H2, Then le fichier est lu et parsé en sections, And chaque section H2 est mappée à un axe via normalisation (toLowerCase + replace spaces → `_`), And `forAxis(axisId)` retourne le contenu de `## General` + le contenu de la section spécifique à l'axe, concaténés, And `hasInstructions` retourne `true`
  > AC: Given `ANATOLY.md` n'existe pas à la racine du projet, When `loadUserInstructions()` est appelé, Then `hasInstructions` retourne `false`, And `forAxis(axisId)` retourne `undefined` pour tous les axes, And aucune erreur n'est levée
  > AC: Given `ANATOLY.md` contient une section `## Deployment` (non reconnue), When le fichier est parsé, Then la section est silencieusement ignorée, And un log info liste les sections reconnues vs. ignorées
  > AC: Given `ANATOLY.md` contient une section `## Best Practices`, When la normalisation est appliquée, Then `Best Practices` → `best_practices`
  > AC: Given une section dépasse ~2000 tokens (~8000 caractères), When le fichier est parsé, Then un warning est émis : `ANATOLY.md section "X" is very long (~N tokens). Long sections may dilute scoring accuracy.`
  > AC: Given `ANATOLY.md` est vide ou ne contient que du contenu sans section H2, When le fichier est parsé, Then `hasInstructions` retourne `false`, And `forAxis(axisId)` retourne `undefined`
  > Spec: specs/planning-artifacts/epic-44-user-instructions.md#story-44-1
- [x] Story 44.2: Injection dans les prompts d'axes
  > As a développeur du pipeline
  > I want que les instructions utilisateur soient injectées dans le prompt système de chaque axe
  > So that le LLM calibre son évaluation en fonction des conventions du projet.
  > AC: Given `composeAxisSystemPrompt()` dans `src/core/axis-evaluator.ts`, When la signature est modifiée pour accepter `userInstructions?: string`, Then la composition du prompt est : `wrapper → guard-rails → axis-prompt → USER CALIBRATION → schema`, And le bloc de calibration est encadré par un header explicite
  > AC: Given des instructions utilisateur existent pour l'axe `documentation`, When le prompt système est composé, Then le bloc suivant est injecté après le prompt d'axe et avant le schema :
  > Spec: specs/planning-artifacts/epic-44-user-instructions.md#story-44-2
- [x] Story 44.3: Intégration dans le pipeline `run`
  > As a utilisateur d'anatoly
  > I want que `anatoly run` charge automatiquement mon `ANATOLY.md` et l'utilise pour toutes les reviews
  > So that je n'ai rien à configurer — poser le fichier suffit.
  > AC: Given `src/commands/run.ts` appelle `loadUserInstructions(projectRoot)` au démarrage, When `ANATOLY.md` existe avec des sections valides, Then un log info est émis : `Loaded user instructions from ANATOLY.md (sections: General, Documentation, Best Practices)`, And l'objet `UserInstructions` est passé au contexte de review
  > AC: Given `ANATOLY.md` n'existe pas, When le run démarre, Then aucun log n'est émis concernant les instructions utilisateur, And le pipeline fonctionne exactement comme avant
  > AC: Given l'objet `UserInstructions` est dans le contexte de review, When chaque évaluateur d'axe compose son prompt système, Then il appelle `userInstructions.forAxis(axisId)` et passe le résultat à `composeAxisSystemPrompt()`
  > Spec: specs/planning-artifacts/epic-44-user-instructions.md#story-44-3
- [x] Story 44.4: Documentation utilisateur
  > As a utilisateur d'anatoly
  > I want une documentation claire sur le format et l'usage de `ANATOLY.md`
  > So that je sache exactement quelles sections sont reconnues et comment formuler mes instructions.
  > AC: Given `docs/01-Getting-Started/02-Configuration.md` est mis à jour, When un utilisateur consulte la documentation, Then il trouve une section dédiée à `ANATOLY.md` expliquant :
  > AC: Given le README.md du projet, When un utilisateur découvre anatoly, Then `ANATOLY.md` est mentionné dans la section configuration (une ligne, renvoi vers la doc)
  > Spec: specs/planning-artifacts/epic-44-user-instructions.md#story-44-4
### Telegram Notifications — Alertes post-run

- [x] Story 45.1: Schema Zod — Section `notifications.telegram`
  > As a utilisateur d'anatoly
  > I want configurer la notification Telegram dans `.anatoly.yml`
  > So that je peux activer l'envoi automatique du rapport sans modifier le code.
  > AC: Given `NotificationsConfigSchema` est ajouté dans `config.ts`, When `notifications` est absent du YAML, Then `config.notifications` est `undefined` (section entièrement optionnelle)
  > AC: Given `notifications.telegram.enabled` est `true`, When `chat_id` est absent, Then le parsing Zod échoue avec un message clair
  > AC: Given `notifications.telegram.bot_token_env` est absent, When le schema est parsé, Then le default est `'ANATOLY_TELEGRAM_BOT_TOKEN'`
  > AC: Given `notifications.telegram.report_url` est fourni, When la valeur n'est pas une URL valide, Then le parsing Zod échoue
  > Spec: specs/planning-artifacts/epic-45-telegram-notifications.md#story-45-1
- [x] Story 45.2: NotificationChannel + TelegramNotifier
  > As a utilisateur d'anatoly
  > I want recevoir un résumé du rapport d'audit dans mon channel Telegram
  > So that mon équipe est notifiée automatiquement des résultats sans consulter les fichiers locaux.
  > AC: Given l'interface `NotificationChannel` est définie, When un nouveau canal est implémenté, Then il suffit d'implémenter `send(payload: NotificationPayload): Promise<void>`
  > AC: Given `TelegramNotifier` est instancié avec un `botToken` et `chatId` valides, When `send()` est appelé avec un payload complet, Then un `POST` est envoyé à `https://api.telegram.org/bot{token}/sendMessage`, And `parse_mode` est `MarkdownV2`, And le body contient le verdict, stats, scorecard axes et top findings
  > AC: Given le message dépasse 4096 caractères, When `send()` construit le message, Then les findings sont tronqués pour respecter la limite, And un indicateur `(+N more)` est ajouté
  > AC: Given le payload contient `reportUrl`, When le message est rendu, Then un lien `📄 Full report → {url}` est ajouté en fin de message
  > AC: Given l'API Telegram retourne une erreur (401, 400, réseau), When `send()` est exécuté, Then l'erreur est propagée (le catch est dans le dispatcher, Story 45.3)
  > Spec: specs/planning-artifacts/epic-45-telegram-notifications.md#story-45-2
- [x] Story 45.3: Intégration pipeline + tests
  > As a développeur d'anatoly
  > I want que la notification soit déclenchée automatiquement en fin de run
  > So that l'utilisateur n'a rien à faire manuellement après un audit.
  > AC: Given `config.notifications?.telegram?.enabled` est `true`, When `generateReport()` est terminé dans `run.ts`, Then `sendNotifications()` est appelé avec le payload construit depuis `ReportData` + `RunStats`
  > AC: Given le bot token env var est absent ou vide, When `sendNotifications()` est appelé, Then un warn est loggé (`Telegram bot token not found in env`), And le run continue normalement
  > AC: Given `TelegramNotifier.send()` throw une erreur, When `sendNotifications()` la catch, Then un warn est loggé avec le message d'erreur, And le run continue normalement (fire-and-forget)
  > AC: Given `config.notifications` est `undefined`, When le run se termine, Then aucune notification n'est envoyée (skip silencieux)
  > AC: Given les tests unitaires, When `TelegramNotifier.send()` est testé, Then `fetch` est mocké via `vi.fn()`, And le format du message est validé (verdict, stats, limite 4096), And les cas d'erreur HTTP sont couverts
  > Spec: specs/planning-artifacts/epic-45-telegram-notifications.md#story-45-3
### Transport-Level Resilience — Semaphores & circuit breakers dans le router

- [x] Story 46.1: TransportRouter — semaphores et breakers par provider
  > As a développeur du pipeline
  > I want que le TransportRouter gère les semaphores et breakers par provider
  > So that la concurrence et la résilience ne soient plus propagées manuellement dans toute la stack.
  > AC: Given `TransportRouter` est instancié avec `config`, When `config.providers` contient `anthropic: { concurrency: 24 }` et `google: { concurrency: 10 }`, Then `router.semaphores` contient `Map { "anthropic" → Semaphore(24), "google" → Semaphore(10) }`
  > AC: Given un provider n'a pas de `concurrency` dans la config, When le router est construit, Then le semaphore est créé avec `concurrency: 10` (default)
  > AC: Given `TransportRouter` est instancié, When `config.providers` contient des providers, Then un `CircuitBreaker` est créé pour chaque provider
  > AC: Given `router.getSemaphoreStats()` est appelé, When 3 slots sont acquis sur "anthropic", Then il retourne `Map { "anthropic" → { active: 3, total: 24 }, "google" → { active: 0, total: 10 } }`
  > AC: Given `router.getBreakerState("google")` est appelé, When le breaker Google est fermé, Then il retourne `'closed'`
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-1
- [x] Story 46.2: API acquire / acquireSlot / release
  > As a développeur du pipeline
  > I want une API unifiée pour acquérir un slot de concurrence avec gestion du breaker
  > So that l'appelant n'ait qu'un seul point d'entrée et que le cleanup soit garanti.
  > AC: Given `router.acquire("google/gemini-2.5-flash")` est appelé, When le breaker Google est fermé et un slot est disponible, Then il retourne `{ transport: LlmTransport, release: Function }`, And le semaphore Google a un slot de moins
  > AC: Given `router.acquire("google/gemini-2.5-flash")` est appelé, When le breaker Google est ouvert, Then il throw `Error("Provider 'google' circuit breaker is open")`, And aucun slot de semaphore n'est consommé
  > AC: Given `router.acquireSlot("anthropic/claude-opus-4-6")` est appelé, When le breaker Anthropic est fermé, Then il retourne `{ release: Function }`, And le semaphore Anthropic a un slot de moins
  > AC: Given `release({ success: true })` est appelé, When après un appel réussi, Then le semaphore est libéré, And `circuitBreaker.recordSuccess()` est appelé
  > AC: Given `release({ success: false, error })` est appelé, When après un appel en échec, Then le semaphore est libéré, And `circuitBreaker.recordFailure()` est appelé
  > AC: Given `release()` est appelé sans argument, When en mode implicite, Then le comportement est identique à `release({ success: true })`
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-2
- [x] Story 46.3: Renommage GeminiCircuitBreaker → CircuitBreaker
  > As a développeur
  > I want que le circuit breaker soit provider-agnostique
  > So that tout provider puisse en bénéficier.
  > AC: Given `src/core/circuit-breaker.ts` exporte `GeminiCircuitBreaker`, When il est renommé en `CircuitBreaker`, Then toutes les importations sont mises à jour, And les commentaires/JSDoc ne mentionnent plus "Gemini" spécifiquement, And les tests dans `circuit-breaker.test.ts` sont mis à jour
  > AC: Given `CircuitBreaker` est utilisé, When il est instancié par le `TransportRouter`, Then la logique closed/open/half-open est inchangée
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-3
- [x] Story 46.4: Nettoyage interfaces — suppression semaphore/breaker manuels
  > As a développeur du pipeline
  > I want que les interfaces ne contiennent plus de champs semaphore/breaker, So que la résilience soit entièrement encapsulée dans le router.
  > AC: Given `AxisContext` dans `axis-evaluator.ts`, When les champs `semaphore`, `geminiSemaphore`, `circuitBreaker` sont supprimés, Then seul `router: TransportRouter` reste comme point d'accès au transport
  > AC: Given `SingleTurnQueryParams` dans `axis-evaluator.ts`, When les champs `semaphore`, `geminiSemaphore`, `circuitBreaker`, `transport` sont supprimés, Then seul `router: TransportRouter` reste, And `runSingleTurnQuery` utilise `router.acquire(model)` en interne
  > AC: Given `EvaluateFileOptions` dans `file-evaluator.ts`, When `geminiSemaphore` et `circuitBreaker` sont supprimés, Then le fichier propage uniquement le `router`
  > AC: Given `RunContext` / `PipelineState`, When `sdkSemaphore`, `geminiSemaphore`, `circuitBreaker` sont supprimés, Then seul le `router` est conservé
  > AC: Given les 7 axes dans `src/core/axes/*.ts`, When les spreads `geminiSemaphore: ctx.geminiSemaphore` et `circuitBreaker: ctx.circuitBreaker` sont supprimés, Then seul `router: ctx.router` est propagé
  > AC: Given `resolveSemaphore()` dans `axis-evaluator.ts`, When il est supprimé, Then aucun code ne le référence
  > AC: Given les params dans `rag/orchestrator.ts`, `rag/nlp-summarizer.ts`, `rag/standalone.ts`, When `geminiSemaphore` est supprimé des signatures, Then seul le `router` est passé
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-4
- [x] Story 46.5: Migration appels agentic vers acquireSlot
  > As a développeur du pipeline
  > I want que les appels agentic (Tier 3, doc gen, Vercel Agent) utilisent `acquireSlot()`, So que la concurrence et le breaker couvrent tous les chemins LLM.
  > AC: Given Tier 3 correction dans `run.ts` (direct `query()` Claude SDK), When `ctx.sdkSemaphore.acquire()` est remplacé par `router.acquireSlot(model)`, Then le semaphore est géré par le router, And `release({ success })` est appelé en finally, And le breaker est vérifié avant l'appel
  > AC: Given Doc gen Sonnet coherence dans `doc-llm-executor.ts`, When `if (semaphore) await semaphore.acquire()` est remplacé par `router.acquireSlot(model)`, Then le router est injecté dans `doc-llm-executor`, And `release({ success })` est appelé en finally
  > AC: Given Doc gen Opus review dans `doc-llm-executor.ts`, When le semaphore manuel est remplacé par `router.acquireSlot(model)`, Then même pattern que Sonnet coherence
  > AC: Given Doc gen pages dans `run.ts`, When il n'a actuellement ni semaphore ni breaker, Then `router.acquireSlot(model)` est ajouté avec `release({ success })` en finally
  > AC: Given `vercel-agent.ts`, When il n'a actuellement ni semaphore ni breaker, Then le router est injecté et `acquireSlot(model)` est ajouté avec `release({ success })` en finally
  > AC: Given `screen-renderer.ts` affiche les stats semaphore, When il accédait directement aux semaphores, Then il utilise `router.getSemaphoreStats()`
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-5
- [x] Story 46.6: Tests d'intégration et validation
  > As a mainteneur d'anatoly
  > I want valider que la migration n'a introduit aucune régression
  > So that les appels LLM fonctionnent identiquement avec le nouveau router.
  > AC: Given les tests existants du circuit breaker, When ils sont exécutés avec `CircuitBreaker` (renommé), Then tous passent sans modification de logique
  > AC: Given les tests existants de `runSingleTurnQuery`, When ils sont adaptés pour mocker `router.acquire()` au lieu de semaphores séparés, Then le comportement est identique
  > AC: Given un test d'intégration du router, When `acquire()` est appelé N+1 fois (N = concurrency), Then le N+1ème appel attend jusqu'à ce qu'un `release()` libère un slot
  > AC: Given un test breaker + acquire, When 3 `release({ success: false })` consécutifs sont appelés, Then le prochain `acquire()` throw immédiatement (breaker ouvert)
  > AC: Given un test acquireSlot + release, When `acquireSlot()` est appelé et `release({ success: true })` en finally, Then le semaphore est libéré et le breaker reçoit le success
  > Spec: specs/planning-artifacts/epic-46-transport-resilience.md#story-46-6

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
