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
