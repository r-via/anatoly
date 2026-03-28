# Ralph Fix Plan

## Stories to Implement

- [x] Story 26.1: Prerequisites (schema + resolver + prompt)
  > All foundation work with no runtime behavior.
  > Can be parallelized internally.
  > Tests embedded.
  > Spec: specs/planning-artifacts/epic-documentation-axis.md#story-26-1
- [x] Story 26.2: Core Integration (evaluator + merger + orchestrator + registry)
  > The axis becomes functional end-to-end.
  > Tests embedded per task.
  > | Task | File(s) | Tests | |------|---------|-------| | Evaluator implementation | `axes/documentation.ts` (NEW) | Mock LLM, validate Zod parsing | | Merger integration | `axis-merger.ts` | Coherence rules (DEAD→UNDOCUMENTED), action synthesis | | Orchestrator wiring | `file-evaluator.ts`, `run.ts`/`reviewer.ts` | docsTree passed via options, relevantDocs injection | | Registry registration | `axes/index.ts` | Enabled/disabled filtering | | Report updates | `reporter.ts` | `doc` column, "Documentation Coverage" section, coverage score |
  > Spec: specs/planning-artifacts/epic-documentation-axis.md#story-26-2
- [x] Story 26.3: Documentation Meta (update project docs)
  > Self-referential: the documentation axis documents itself.
  > | Task | File(s) | |------|---------| | Rename Six-Axis → Seven-Axis | `docs/02-Architecture/02-Six-Axis-System.md` | | Add documentation evaluator section | `docs/04-Core-Modules/04-Axis-Evaluators.md` | | Update PRD Principle 1 + Non-goals | `_bmad-output/planning-artifacts/PRD.md` | Stories 1 and 3 can be worked in parallel.
  > Story 2 depends on Story 1.
  > Spec: specs/planning-artifacts/epic-documentation-axis.md#story-26-3
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
- [x] Story 31.1: Language Detection by Extension Distribution
  > > As a **developer running Anatoly on any project** > I want Anatoly to **automatically detect the programming languages present** by scanning file extensions > So that the pipeline knows **which grammars to load and which prompts to use**.
  > **AC 31.1.1:** Given a project with 100 `.ts` files, 10 `.sh` files, 3 `.py` files, and 2 `.yml` files, When `detectLanguages()` runs, Then it returns `[{ name: 'TypeScript', percentage: 87, fileCount: 100 }, { name: 'Shell', percentage: 9, fileCount: 10 }, { name: 'Python', percentage: 3, fileCount: 3 }, { name: 'YAML', percentage: 2, fileCount: 2 }]` sorted by percentage descending.
  > **AC 31.1.2:** Given a project with `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` files, When `detectLanguages()` runs, Then `.ts` and `.tsx` are grouped under `TypeScript`, and `.js`, `.jsx`, `.mjs`, `.cjs` are grouped under `JavaScript` — each language appears once with the combined count.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-1
- [x] Story 31.2: Framework Detection by Project Markers
  > > As a **developer running Anatoly on a framework-based project** > I want Anatoly to **detect the frameworks I use** from project configuration files > So that the prompts are **tailored to my framework's conventions and best practices**.
  > **AC 31.2.1:** Given a project with `package.json` containing `"react": "^19.0.0"` in dependencies, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'react', name: 'React', language: 'typescript' }`.
  > **AC 31.2.2:** Given a project with `package.json` containing `"next": "^15.0.0"` in dependencies, When `detectProjectProfile()` runs, Then `frameworks` includes `{ id: 'nextjs', name: 'Next.js', language: 'typescript' }`, And React is NOT separately listed (Next.js implies React).
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-2
- [x] Story 31.3: Project Info Display — Languages & Frameworks
  > > As a **developer running Anatoly** > I want to see the **language distribution and detected frameworks** in the setup table > So that I can verify Anatoly **correctly understands my project ecosystem**.
  > **AC 31.3.1:** Given a project with `TypeScript 85%`, `Shell 10%`, `Python 3%`, `YAML 2%`, When the setup table renders, Then the `Project Info` section shows `languages         TypeScript 85% · Shell 10% · Python 3% · YAML 2%`.
  > **AC 31.3.2:** Given a project with detected frameworks `Next.js` and `Prisma`, When the setup table renders, Then the `Project Info` section shows `frameworks        Next.js · Prisma` on a separate line below `languages`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-3
- [x] Story 31.4: Auto-Detect File Discovery
  > > As a **developer running Anatoly on a multi-language project** > I want Anatoly to **automatically discover non-TypeScript files** without manual configuration > So that shell scripts, Python files, YAML configs, etc.
  > are **included in the analysis**.
  > **AC 31.4.1:** Given `scan.auto_detect: true` (default) and a project containing `scripts/setup.sh`, When `collectFiles()` runs, Then `scripts/setup.sh` is included in the file list, And the glob `scripts/**/*.sh` was auto-added to `scan.include`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-4
- [x] Story 31.5: Dynamic Grammar Manager
  > > As a **developer running Anatoly on a multi-language project** > I want tree-sitter grammars to be **downloaded automatically on first use** > So that the npm package stays **lightweight** and I don't need to install grammars manually.
  > **AC 31.5.1:** Given a project with `.py` files and no grammar cached, When the scanner processes a `.py` file for the first time, Then `grammar-manager` downloads `tree-sitter-python.wasm` from the npm registry, And saves it to `.anatoly/grammars/tree-sitter-python.wasm`, And the file is parsed successfully with the downloaded grammar.
  > **AC 31.5.2:** Given `.anatoly/grammars/tree-sitter-python.wasm` already exists from a previous run, When the scanner processes a `.py` file, Then NO download occurs, And the cached WASM is loaded directly, And parse time is not affected by network latency.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-5
- [x] Story 31.6: Language Adapter Interface & TypeScript Refactor
  > > As a **developer maintaining Anatoly** > I want a **clean abstraction** for parsing different languages > So that adding a new language is **a matter of adding files, not modifying the pipeline**.
  > **AC 31.6.1:** Given a new `LanguageAdapter` interface in `language-adapters.ts`, Then it defines: `extensions: readonly string[]`, `languageId: string`, `wasmModule: string`, `extractSymbols(rootNode: TSNode): SymbolInfo[]`, `extractImports(source: string): ImportRef[]`.
  > **AC 31.6.2:** Given the existing TypeScript parsing logic in `scanner.ts` (lines 20-166), When the refactor is complete, Then ALL TypeScript-specific code is encapsulated in `TypeScriptAdapter` and `TsxAdapter` implementing `LanguageAdapter`, And `scanner.ts` no longer contains any TypeScript-specific AST node references.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-6
- [x] Story 31.7: Bash/Shell Language Adapter
  > > As a **developer with shell scripts in my project** > I want Anatoly to **parse and extract symbols from .sh and .bash files** > So that my infrastructure scripts are **analyzed with the same rigor as TypeScript**.
  > **AC 31.7.1:** Given a file `scripts/setup.sh` containing `function setup_gpu() { ...
  > }`, When `BashAdapter.extractSymbols()` runs, Then it returns `{ name: 'setup_gpu', kind: 'function', exported: true, line_start: N, line_end: M }`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-7
- [x] Story 31.8: Python Language Adapter
  > > As a **developer with Python scripts in my project** > I want Anatoly to **parse and extract symbols from .py files** > So that my Python code is **analyzed alongside my TypeScript code**.
  > **AC 31.8.1:** Given a file containing `def process_data(input: str) -> dict:`, When `PythonAdapter.extractSymbols()` runs, Then it returns `{ name: 'process_data', kind: 'function', exported: true, ...
  > }`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-8
- [x] Story 31.9: Rust Language Adapter
  > > As a **developer with Rust code in my project** > I want Anatoly to **parse and extract symbols from .rs files** > So that my Rust modules are **included in the analysis pipeline**.
  > **AC 31.9.1:** Given a file containing `pub fn parse(input: &str) -> Result<AST, Error>`, When `RustAdapter.extractSymbols()` runs, Then it returns `{ name: 'parse', kind: 'function', exported: true, ...
  > }`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-9
- [x] Story 31.10: Go Language Adapter
  > > As a **developer with Go code in my project** > I want Anatoly to **parse and extract symbols from .go files** > So that my Go packages are **analyzed with language-appropriate rules**.
  > **AC 31.10.1:** Given a file containing `func ParseFile(path string) error`, When `GoAdapter.extractSymbols()` runs, Then it returns `{ name: 'ParseFile', kind: 'function', exported: true, ...
  > }` (uppercase = exported).
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-10
- [x] Story 31.11: Java, C#, SQL, YAML, JSON Language Adapters
  > > As a **developer running Anatoly on diverse projects** > I want Anatoly to **support Java, C#, SQL, YAML, and JSON parsing** > So that the full Tier 1 language set is covered.
  > **AC 31.11.1 (Java):** Given a file containing `public class UserService { public void process() { ...
  > } }`, When `JavaAdapter.extractSymbols()` runs, Then it returns `[{ name: 'UserService', kind: 'class', exported: true }, { name: 'process', kind: 'method', exported: true }]`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-11
- [x] Story 31.12: Heuristic Fallback Parser
  > > As a **developer with files that have no tree-sitter grammar available** > I want Anatoly to **extract approximate symbols via regex** > So that these files are **still included in the analysis** rather than silently ignored.
  > **AC 31.12.1:** Given a `Makefile` with targets `build:`, `test:`, `deploy:`, When `heuristicParse()` runs, Then it returns `[{ name: 'build', kind: 'function' }, { name: 'test', kind: 'function' }, { name: 'deploy', kind: 'function' }]` with `parseMethod: 'heuristic'`.
  > **AC 31.12.2:** Given a `Dockerfile` with `FROM node:20 AS builder` and `FROM node:20-slim AS runner`, When `heuristicParse()` runs, Then it returns `[{ name: 'builder', kind: 'function' }, { name: 'runner', kind: 'function' }]`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-12
- [x] Story 31.13: Usage-Graph Multi-Language Extension
  > > As a **developer running Anatoly on a multi-language project** > I want the usage-graph to **track imports across all supported languages** > So that the utility axis can detect **dead code in shell scripts, Python files, etc.** **AC 31.13.1:** Given `scripts/setup.sh` containing `source ./lib/helpers.sh`, When `buildUsageGraph()` runs, Then the usage-graph contains an edge from `scripts/setup.sh` → `scripts/lib/helpers.sh`.
  > **AC 31.13.2:** Given `scripts/lib/helpers.sh` is NOT sourced by any file, When the utility axis evaluates it, Then it is a candidate for `DEAD` (no importers).
  > **AC 31.13.3:** Given `utils.py` containing `from helpers import format_output`, When `buildUsageGraph()` runs, Then the usage-graph contains an edge referencing `helpers` → `utils.py`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-13
- [x] Story 31.14: Prompt Resolution Cascade
  > > As a **developer maintaining Anatoly** > I want prompts to be **resolved automatically** based on language and framework > So that each file gets the **most specific applicable prompt** without hardcoded logic.
  > **AC 31.14.1:** Given a `.tsx` file in a Next.js project, When `resolveSystemPrompt('best_practices', 'typescript', 'nextjs')` is called, Then it returns the content of `best-practices.nextjs.system.md`.
  > **AC 31.14.2:** Given a `.tsx` file in a React project (no Next.js), When `resolveSystemPrompt('best_practices', 'typescript', 'react')` is called, Then it returns the content of `best-practices.react.system.md`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-14
- [x] Story 31.15: Best Practices Prompts — Shell, Python, Rust, Go
  > > As a **developer with non-TypeScript code** > I want the best_practices axis to **evaluate my code with language-appropriate rules** > So that I get **actionable findings** instead of irrelevant TypeScript-specific violations.
  > **AC 31.15.1:** Given `best-practices.bash.system.md` exists, Then it contains ShellGuard rules: `set -euo pipefail` (CRITICAL), quoted variables (CRITICAL), no `eval` (HIGH), no `cd` without check (HIGH), `[[ ]]` over `[ ]` (MEDIUM), trap for cleanup (MEDIUM), no `ls` parsing (MEDIUM), no hardcoded paths (HIGH), security (CRITICAL), file size (HIGH) — minimum 12 rules with scoring penalties.
  > **AC 31.15.2:** Given `best-practices.python.system.md` exists, Then it contains PyGuard rules: type hints (HIGH), docstrings (MEDIUM), no `import *` (HIGH), no bare except (CRITICAL), f-strings (MEDIUM), no mutable globals (MEDIUM), context managers (HIGH), no eval/exec (CRITICAL), import organization (MEDIUM), security (CRITICAL), pathlib (MEDIUM) — minimum 13 rules.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-15
- [x] Story 31.16: Best Practices Prompts — Java, C#, SQL, YAML, JSON
  > > As a **developer with Java, C#, SQL, YAML, or JSON files** > I want the best_practices axis to **evaluate these files with appropriate rules** > So that all Tier 1 languages have **dedicated quality standards**.
  > **AC 31.16.1:** Given `best-practices.java.system.md` exists, Then it contains JavaGuard rules: no null return / use Optional (HIGH), Javadoc (MEDIUM), proper exception handling (HIGH), immutability (MEDIUM), naming conventions (HIGH), generics (CRITICAL), try-with-resources (HIGH), security (CRITICAL), Stream API (MEDIUM) — minimum 10 rules.
  > **AC 31.16.2:** Given `best-practices.csharp.system.md` exists, Then it contains CSharpGuard rules: nullable reference types (HIGH), XML doc comments (MEDIUM), async/await correctness (CRITICAL), IDisposable/using (HIGH), naming conventions (HIGH), immutability (MEDIUM), LINQ (MEDIUM), security (CRITICAL), pattern matching (MEDIUM) — minimum 10 rules.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-16
- [x] Story 31.17: Documentation Prompts per Language
  > > As a **developer with non-TypeScript code** > I want the documentation axis to **evaluate my code's documentation using language-appropriate criteria** > So that a Python file is checked for **docstrings**, not JSDoc.
  > **AC 31.17.1:** Given `documentation.bash.system.md` exists, Then it evaluates: function header comments (`# @description`, `## Usage:`), variable comments inline, file header explaining purpose.
  > DOCUMENTED = header comment with description + params.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-17
- [x] Story 31.18: Framework-Specific Prompts — React & Next.js
  > > As a **developer working on a React or Next.js project** > I want the best_practices and documentation axes to **use framework-specific rules** > So that I get findings about **hooks rules, server components, App Router patterns**, not just generic TypeScript rules.
  > **AC 31.18.1:** Given `best-practices.react.system.md` exists, Then it contains rules for: hooks exhaustive deps, no conditional hooks, component memoization (React.memo, useMemo, useCallback), key prop in lists, accessibility (a11y basics), prop types or TypeScript interface for props, no inline function props in JSX, event handler naming (`onXxx`/`handleXxx`), fragment usage, component file organization — minimum 12 rules.
  > **AC 31.18.2:** Given `best-practices.nextjs.system.md` exists, Then it contains rules for: correct `'use client'` / `'use server'` directives, App Router conventions (page.tsx, layout.tsx, loading.tsx, error.tsx), `generateMetadata` usage, server component data fetching (no useEffect for data), Route Handlers (POST/GET in route.ts), `next/image` over `<img>`, `next/link` over `<a>`, ISR/SSG/SSR selection, middleware patterns, no client-side data fetching when server component suffices — minimum 12 rules.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-18
- [x] Story 31.19: Axis Language & Framework Injection
  > > As a **developer running Anatoly on a multi-language project** > I want all 7 axes to **correctly handle non-TypeScript files** > So that the evaluation is **accurate regardless of the language**.
  > **AC 31.19.1:** Given a `.sh` file evaluated by the correction axis, When `buildCorrectionUserMessage()` runs, Then the user message includes `## Language: bash` and `## Parse method: ast`, And the code block uses ` ```bash ` fencing (not ` ```typescript `).
  > **AC 31.19.2:** Given a `.py` file in a Django project evaluated by the overengineering axis, When `buildOverengineeringUserMessage()` runs, Then the user message includes `## Language: python` and `## Framework: django`.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-19
- [x] Story 31.20: Pipeline Integration & End-to-End Validation
  > > As a **developer running `anatoly run` on a multi-language project** > I want the **entire pipeline to work end-to-end** with non-TypeScript files > So that the report includes **findings from all languages**.
  > **AC 31.20.1:** Given a project with 50 `.ts`, 5 `.sh`, and 3 `.py` files, When `anatoly run` executes, Then ALL 58 files are scanned, triaged, and evaluated, And the report includes findings from all three languages.
  > **AC 31.20.2:** Given the pipeline runs, Then the phases execute in order: config → language-detect → framework-detect → auto-detect → grammars → render setup table → scan → triage → usage-graph → estimate → review → report.
  > Spec: specs/planning-artifacts/epic-31-multi-language.md#story-31-20
- [x] Story 32.1: Adversarial Review — Epic 28 Stories 28.1–28.3
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 28.1–28.3 > So that the logging infrastructure is **bulletproof**.
  > **AC 32.1.1:** Given Story 28.1 (Conversation Dump Infrastructure), When each AC is audited, Then every AC is marked IMPLEMENTED with `file:line` proof, And any PARTIAL or MISSING AC is auto-fixed in the same iteration.
  > **AC 32.1.2:** Given Story 28.2 (RAG LLM Call Logging), When each of the 3 RAG LLM call sites is inspected (`nlp-summarizer.ts:131`, `doc-indexer.ts:126`, `doc-indexer.ts:162`), Then each produces both an ndjson event AND a conversation dump, And any missing coverage is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-1
- [x] Story 32.2: Adversarial Review — Epic 28 Stories 28.4–28.6
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 28.4–28.6 > So that per-file events, watch logging, and run metrics are **complete and correct**.
  > **AC 32.2.1:** Given Story 28.4 (Per-file & Per-axis Events), When each of the 14 event types is audited (`file_triage`, `file_review_start`, `file_review_end`, `axis_complete`, `axis_failed`, `file_skip`, `rag_search`, `doc_resolve`, `retry`, etc.), Then each event is emitted at the correct code location, And any missing event is auto-fixed with the correct payload schema.
  > **AC 32.2.2:** Given Story 28.5 (Watch Mode Logging), When watch mode is audited, Then `watch_start`, `watch_stop`, `file_change`, `file_delete` events are emitted, And session continuity is maintained across file changes, And any gap is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-2
- [x] Story 32.3: Adversarial Review — Epic 29 Stories 29.1–29.6
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 29.1–29.6 > So that project type detection, scaffolding, and the docs guard are **solid**.
  > **AC 32.3.1:** Given Story 29.1 (Project Type Detection), When `detectProjectTypes()` is audited, Then it correctly handles: React+Prisma→['Frontend','ORM'], bin+commander→['CLI'], workspaces→['Monorepo',...], no deps→['Library'], And any detection gap is auto-fixed.
  > **AC 32.3.2:** Given Story 29.2 (Documentation Structure Scaffolder), When scaffolding is audited for Backend API+ORM project, Then all expected sections exist (REST-Endpoints, Middleware, Auth, Error-Handling, Data-Model, etc.), And `index.md` is complete, And idempotency (no overwrite) is verified, And any defect is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-3
- [x] Story 32.4: Adversarial Review — Epic 29 Stories 29.7–29.11
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 29.7–29.11 > So that source analysis, LLM generation, caching, scoring, and reporting are **accurate**.
  > **AC 32.4.1:** Given Story 29.7 (Source Code Analysis), When the extraction is audited for each page type (modules, API, architecture), Then exported symbols, signatures, JSDoc, file tree are correctly extracted, And token truncation at 8000 tokens works correctly, And any defect is auto-fixed.
  > **AC 32.4.2:** Given Story 29.8 (LLM Page Content Generation), When generated pages are inspected, Then they follow the template (H1, blockquote summary, H2s, examples), use real function names/paths, include code examples, And architecture pages have Mermaid diagrams, And any quality issue is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-4
- [x] Story 32.5: Adversarial Review — Epic 29 Stories 29.12–29.17
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 29.12–29.17 > So that user doc plan resolution, dual-output, Ralph sync, module injection, and LLM execution are **correct**.
  > **AC 32.5.1:** Given Story 29.12 (User Doc Plan Resolver), When resolution is audited for: structured docs/, flat docs/, no docs/, non-standard numbering, Then all cases produce correct mappings, And any misresolution is auto-fixed.
  > **AC 32.5.2:** Given Story 29.13 (Dual-Output Recommendations), When recommendations are audited, Then each includes `path_ideal`, `path_user`, `content_ref`, `type`, `rationale`, `priority`, And all 8 recommendation types are covered, And any missing field is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-5
- [x] Story 32.6: Adversarial Review — Epic 29 Stories 29.18–29.21
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 29.18–29.21 > So that dual doc context, docs_path, coverage distinction, and internal doc pipeline are **solid**.
  > **AC 32.6.1:** Given Story 29.18 (Dual Doc Context), When the doc resolver is audited, Then both `docs/` (project) and `.anatoly/docs/` (internal) are provided as context with `source` tags, And RAG indexes both with separate sources, And budget is split 50/50, And any tagging defect is auto-fixed.
  > **AC 32.6.2:** Given Story 29.19 (docs_path Propagation), When `docs_path: 'documentation'` is configured, Then `assertSafeOutputPath`, `buildDocRecommendations`, `resolveUserDocPlan`, `syncDocs` all use `documentation/` instead of `docs/`, And the default (no config) still works, And any hardcoded `'docs'` reference is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-6
- [x] Story 32.7: Adversarial Review — Story 30.1 SDK Semaphore
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Story 30.1 > So that the global SDK concurrency semaphore is **correct and deadlock-free**.
  > **AC 32.7.1:** Given Story 30.1 (SDK Semaphore), When the semaphore implementation is audited, Then: `acquire()` blocks when all slots taken, `release()` frees a slot in FIFO order, crash in evaluator releases the slot (finally block), And the semaphore never deadlocks, And any concurrency defect is auto-fixed.
  > **AC 32.7.2:** Given `--concurrency 4` and 7 axes (28 potential parallel calls), When the semaphore is audited with `sdkConcurrency: 8`, Then at most 8 SDK calls are in-flight, And the CLI displays `Agents: 6/8 running · 2 available`, And any violation is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-7
- [x] Story 32.8: Adversarial Review — Epic 31 Stories 31.1–31.5
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.1–31.5 > So that language detection, framework detection, auto-detect, and grammar manager are **correct**.
  > **AC 32.8.1:** Given Story 31.1 (Language Detection), When `detectLanguages()` is audited, Then: extension grouping works (`.ts`+`.tsx`→TypeScript), <1% languages are filtered, `FILENAME_MAP` catches Dockerfile/Makefile, excluded dirs are ignored, git-tracked filter works, And any detection bug is auto-fixed.
  > **AC 32.8.2:** Given Story 31.2 (Framework Detection), When `detectProjectProfile()` is audited, Then: React from package.json, Next.js from deps OR `next.config.*`, Django from requirements.txt, Actix from Cargo.toml, Gin from go.mod, ASP.NET from .csproj, Spring from pom.xml, multiple frameworks simultaneously, empty result when none found, And config files only read for detected languages, And any false positive/negative is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-8
- [x] Story 32.9: Adversarial Review — Epic 31 Stories 31.6–31.11
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.6–31.11 > So that all language adapters **correctly extract symbols and imports**.
  > **AC 32.9.1:** Given Story 31.6 (LanguageAdapter Interface + TS Refactor), When the refactor is audited, Then: `scanner.ts` contains zero TS-specific AST references, TypeScriptAdapter produces identical output to pre-refactor (zero regression), unknown extensions fallback to heuristic, TaskSchema includes `language`/`parse_method`/`framework`, backward compat with old `.task.json` works, And any regression is auto-fixed.
  > **AC 32.9.2:** Given Story 31.7 (BashAdapter), When each AC is audited against the actual implementation, Then: `function` and `()` syntax both extract functions, UPPER_SNAKE → constant, non-UPPER_SNAKE → variable, `_` prefix → not exported, `source`/`.` → imports, local vars NOT extracted, And any extraction bug is auto-fixed with a regression test.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-9
- [x] Story 32.10: Adversarial Review — Epic 31 Stories 31.12–31.14
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.12–31.14 > So that heuristic parsing, usage-graph extension, and prompt cascade are **correct**.
  > **AC 32.10.1:** Given Story 31.12 (Heuristic Parser), When `heuristicParse()` is audited, Then: Makefile targets extracted, Dockerfile stages extracted, UPPER_SNAKE assignments extracted, trivial files (< 5 lines) return empty, heuristic is never called when a grammar is available, And any extraction bug is auto-fixed.
  > **AC 32.10.2:** Given Story 31.13 (Usage-Graph Multi-Language), When the extended usage-graph is audited, Then: `source`/`.` bash creates edges, Python `import` creates edges, Rust `use` creates edges, YAML/JSON/SQL have no edges, TypeScript graph is unchanged (zero regression), cross-language edges are NOT created, And any graph defect is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-10
- [x] Story 32.11: Adversarial Review — Epic 31 Stories 31.15–31.18
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.15–31.18 > So that all language and framework prompts are **complete, correct, and produce valid Zod output**.
  > **AC 32.11.1:** Given Story 31.15 (Best Practices Shell/Python/Rust/Go), When each prompt is audited, Then: ShellGuard has ≥12 rules with correct severities, PyGuard has ≥13 rules, RustGuard has ≥10 rules, GoGuard has ≥10 rules, And each prompt's output format matches `BestPracticesResponseSchema` exactly (same JSON structure), And any missing rule or format defect is auto-fixed.
  > **AC 32.11.2:** Given Story 31.16 (Best Practices Java/C#/SQL/YAML/JSON), When each prompt is audited, Then: JavaGuard ≥10 rules, CSharpGuard ≥10 rules, SqlGuard ≥8 rules, YamlGuard ≥8 rules, JsonGuard ≥5 rules, And output format matches `BestPracticesResponseSchema`, And any defect is auto-fixed.
  > Spec: specs/planning-artifacts/epic-32-adversarial-review.md#story-32-11
- [x] Story 32.12: Adversarial Review — Epic 31 Stories 31.19–31.20
  > > As a **developer shipping Anatoly** > I want an **adversarial review with auto-fix** of Stories 31.19–31.20 > So that axis injection and end-to-end integration are **bulletproof**.
  > **AC 32.12.1:** Given Story 31.19 (Axis Language & Framework Injection), When all 7 axes are audited, Then: every axis injects `## Language:` and `## Framework:` (when applicable) in the user message, every axis uses dynamic code fence (` ```bash `, ` ```python `, etc.), TypeScript files produce identical output to pre-v0.6.0 (zero regression), And any missing injection is auto-fixed.
  > **AC 32.12.2:** Given Story 31.20 (Pipeline E2E), When a multi-language project (50 .ts + 5 .sh + 3 .py) is processed, Then: all 58 files scanned/triaged/evaluated/reported, pipeline phases execute in correct order, `.rev.json` contains `language` field, `.rev.md` uses correct language rules, heuristic-parsed files have lower confidence, And report groups findings by language.
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

- [ ] Story 41.1: Retirer la délibération per-file et écrire les ReviewFiles bruts
  > As a développeur du pipeline
  > I want supprimer l'appel Opus per-file dans `file-evaluator.ts` et écrire les ReviewFiles directement après le merge des axes
  > So that la phase review ne bloque plus 44 min de wall-clock sur la délibération et la refinement phase puisse opérer sur des reviews bruts.
  > AC: Given `file-evaluator.ts` est modifié, When `evaluateFile()` termine le merge des 7 axes, Then il écrit le ReviewFile JSON + MD immédiatement sans appeler `runSingleTurnQuery` avec le modèle de délibération, And le champ `verdict` est calculé par la logique de merge existante (pas par Opus), And les fonctions `needsDeliberation`, `buildDeliberationUserMessage`, `buildDeliberationSystemPrompt` sont dépréciées mais non supprimées (tier 3 les réutilisera peut-être)
  > AC: Given un run complet sans délibération, When la phase review termine, Then les ReviewFile JSON contiennent les verdicts bruts des axes sans reclassification, And aucun appel Opus n'est fait pendant la review phase, And le coût de la review phase diminue d'environ $63
  > AC: Given `correction-memory.ts`, When la review phase termine, Then `recordReclassification` n'est plus appelé depuis `file-evaluator.ts`, And la deliberation-memory.json existante n'est pas modifiée ni lue pendant la review
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-1
- [ ] Story 41.2: Tier 1 — Auto-resolve déterministe
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
- [ ] Story 41.3: Tier 2 — Cohérence inter-axes via Flash Lite
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
- [ ] Story 41.4: Tier 3 — Investigation agentic Opus
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
- [ ] Story 41.5: Intégration pipeline et UI
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
- [ ] Story 41.6: Validation qualité — Comparaison old vs new
  > As a développeur du pipeline
  > I want comparer les reclassifications du nouveau pipeline vs l'ancien sur le même jeu de données
  > So that je puisse vérifier que la qualité ne régresse pas et quantifier l'amélioration.
  > AC: Given le run 192337 existe avec ses ReviewFiles bruts et la deliberation-memory.json, When le nouveau pipeline (tier 1+2+3) est exécuté sur les mêmes ReviewFiles bruts, Then un rapport de comparaison est généré montrant :
  > AC: Given les 336 reclassifications historiques dans deliberation-memory.json, When les tiers 1+2 sont exécutés seuls (sans tier 3), Then ≥ 86% des reclassifications historiques sont reproduites (basé sur l'analyse empirique : 191 tier 1 + 244 tier 2 = 435/504 changements d'axes)
  > AC: Given le tier 3 est exécuté sur les findings escaladés, When il investigue les ~35 findings restants, Then il reproduit ou améliore ≥ 80% des 69 reclassifications historiques qui nécessitaient investigation, And il identifie au minimum le cas FIX-017 (CODE_DIM 3584→768) comme faux positif
  > AC: Given le rapport de comparaison est disponible, When un développeur le lit, Then il peut identifier les cas où le nouveau pipeline est meilleur et ceux où il manque des reclassifications, And les cas manqués sont documentés pour améliorer les règles tier 1/2
  > Spec: specs/planning-artifacts/epic-41-refinement-3-tier.md#story-41-6

## Completed

## Notes
- Follow TDD methodology (red-green-refactor)
- One story per Ralph loop iteration
- Update this file after completing each story
