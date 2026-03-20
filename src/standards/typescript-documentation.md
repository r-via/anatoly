# TypeScript Project Documentation — Ideal Skeleton

## Purpose

This document defines the **exact file structure, naming, and table of contents** that constitutes an ideal documentation for any TypeScript project. A scaffolder or LLM should be able to read this file and generate the complete documentation skeleton.

---

## Operating Model

This standard is consumed by two distinct actors with strict separation of responsibilities:

### Anatoly (audit — read-only on project docs)

- **Reads** the project's `docs/` directory to analyze existing documentation
- **Reads** source code (AST, exports, JSDoc) to understand what needs documenting
- **Writes** `.anatoly/docs/` — the ideal documentation, always complete, always in sync with the code
- **Produces** an audit report with documentation findings and structured recommendations
- **NEVER writes to the project's `docs/` directory**

### Ralph (fix loop — writes to project docs)

- **Reads** the audit report (findings + recommendations)
- **Reads** `.anatoly/docs/` as the source of truth for ideal documentation
- **Writes** to the project's `docs/` directory to synchronize with the ideal version
- Respects the user's existing structure and naming conventions
- Only adds or completes — never deletes user-written content

### `.anatoly/docs/` — Persistent Reference

`.anatoly/docs/` is **not ephemeral**. It is a long-lived artifact that serves as:

1. **Documentation of reference** — always complete, always current with the code
2. **Agent context** — any agent working on the project (Claude Code, Ralph, etc.) can read `.anatoly/docs/` for rich, structured project understanding
3. **Sync source** — Ralph uses it to synchronize the user's `docs/`
4. **Human comparison** — the user can compare their `docs/` against `.anatoly/docs/` and adopt what they want

Updates are **incremental**: Anatoly only regenerates pages whose source code has changed (SHA-256 cache per page).

---

## Root Files

Every TypeScript project must have these files at the repository root:

```
README.md
CHANGELOG.md
LICENSE
```

### README.md — Ideal Table of Contents

```markdown
# {Project Name}

> One-line description of what the project does.

## Features
- Bullet list of key capabilities

## Quick Start
\`\`\`bash
# Install
npm install {package-name}

# Run
npx {command}
\`\`\`

## Documentation
Full documentation: [docs/index.md](docs/index.md)

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md) or [docs/06-Development/01-Contributing.md](docs/06-Development/01-Contributing.md)

## License
[LICENSE](LICENSE)
```

### CHANGELOG.md — Format

Follow [Keep a Changelog](https://keepachangelog.com/). Sections: Added, Changed, Deprecated, Removed, Fixed, Security.

---

## Documentation Directory — `/docs/`

### Base Structure (all project types)

```
docs/
├── index.md
│
├── 01-Getting-Started/
│   ├── 01-Overview.md
│   ├── 02-Installation.md
│   ├── 03-Configuration.md
│   └── 04-Quick-Start.md
│
├── 02-Architecture/
│   ├── 01-System-Overview.md
│   ├── 02-Core-Concepts.md
│   ├── 03-Data-Flow.md
│   └── 04-Design-Decisions.md
│
├── 03-Guides/
│   ├── 01-Common-Workflows.md
│   ├── 02-Advanced-Configuration.md
│   └── 03-Troubleshooting.md
│
├── 04-API-Reference/
│   ├── 01-Public-API.md
│   ├── 02-Configuration-Schema.md
│   └── 03-Types-and-Interfaces.md
│
├── 05-Modules/
│   └── {module-name}.md              # see granularity rules below
│
└── 06-Development/
    ├── 01-Source-Tree.md
    ├── 02-Build-and-Test.md
    ├── 03-Code-Conventions.md
    └── 04-Release-Process.md
```

### `05-Modules/` granularity rules

The scaffolder must decide whether to create one page per **file** or per **directory**:

| Condition | Granularity | Example |
|-----------|-------------|---------|
| Directory has 1-2 files > 200 LOC | **File-level**: one page per file | `05-Modules/scanner.md`, `05-Modules/triage.md` |
| Directory has 3+ files that form a cohesive module | **Directory-level**: one page for the directory | `05-Modules/rag.md` covering `src/rag/*.ts` |
| Single file > 500 LOC with multiple concerns | **File-level**: one page for that file | `05-Modules/doc-indexer.md` |
| Utility files < 200 LOC | **Skip** | No page for tiny helpers |

Naming convention: lowercase, kebab-case, matching the source directory or file name without extension.

### Additional files by project type

#### If CLI detected

Add to `04-API-Reference/`:
```
04-API-Reference/
└── 04-CLI-Reference.md
```

#### If Frontend detected (React, Vue, Angular, Svelte, Next, Nuxt)

Add:
```
03-Guides/
├── 04-Component-Patterns.md
├── 05-State-Management.md
└── 06-Routing.md

04-API-Reference/
└── 04-Component-API.md

05-Modules/
├── Components.md
├── Hooks.md                          # or Composables.md for Vue
├── Stores.md
└── Styles.md
```

#### If Backend API detected (Express, Fastify, NestJS, Hono, Koa)

Add:
```
03-Guides/
├── 04-Authentication.md
├── 05-Error-Handling.md
└── 06-Pagination-and-Filtering.md

04-API-Reference/
├── 04-REST-Endpoints.md
├── 05-Middleware.md
└── 06-WebSocket-Events.md            # only if WebSocket used

05-Modules/
├── Routes.md
├── Services.md
├── Validators.md
└── DTOs.md
```

#### If ORM detected (Prisma, Drizzle, TypeORM, Sequelize, Knex, MikroORM)

Add:
```
02-Architecture/
└── 05-Data-Model.md

03-Guides/
├── 07-Migrations.md
├── 08-Seeding.md
└── 09-Query-Patterns.md

05-Modules/
├── Models.md
├── Repositories.md                   # only if repository pattern used
└── Migrations.md
```

#### If Monorepo detected (workspaces, pnpm-workspace, turborepo, nx)

Add at the start:
```
docs/
└── 00-Monorepo/
    ├── 01-Package-Overview.md
    ├── 02-Dependency-Graph.md
    └── 03-Shared-Conventions.md
```

---

## Project Type Detection

| Signal | Type |
|--------|------|
| `react`, `next`, `vue`, `nuxt`, `angular`, `svelte`, `solid` in dependencies | Frontend |
| `express`, `fastify`, `hono`, `koa`, `nestjs`, `@hapi/hapi` in dependencies | Backend API |
| `prisma`, `drizzle-orm`, `typeorm`, `sequelize`, `knex`, `@mikro-orm/core` in dependencies | ORM |
| `bin` field in package.json, or `commander`, `yargs`, `clipanion`, `cac` in dependencies | CLI |
| `main` + `types` in package.json, no `bin`, no framework | Library |
| `workspaces` in package.json, or `pnpm-workspace.yaml`, or `nx.json`, or `turbo.json` | Monorepo |

A project can be multiple types simultaneously (e.g., Backend API + ORM + CLI).

---

## Ideal Table of Contents — `docs/index.md`

```markdown
# {Project Name} — Documentation

> {One-line description}

---

## 1. Getting Started

| Document | Description |
|----------|-------------|
| [Overview](01-Getting-Started/01-Overview.md) | What {project} does and why it exists |
| [Installation](01-Getting-Started/02-Installation.md) | Prerequisites, install steps, first run |
| [Configuration](01-Getting-Started/03-Configuration.md) | Config files, environment variables, options |
| [Quick Start](01-Getting-Started/04-Quick-Start.md) | End-to-end tutorial in under 5 minutes |

---

## 2. Architecture

| Document | Description |
|----------|-------------|
| [System Overview](02-Architecture/01-System-Overview.md) | High-level diagram and component responsibilities |
| [Core Concepts](02-Architecture/02-Core-Concepts.md) | Glossary and key domain concepts |
| [Data Flow](02-Architecture/03-Data-Flow.md) | How data moves through the system (input → output) |
| [Design Decisions](02-Architecture/04-Design-Decisions.md) | Architecture Decision Records (ADRs) |

---

## 3. Guides

| Document | Description |
|----------|-------------|
| [Common Workflows](03-Guides/01-Common-Workflows.md) | Step-by-step guides for frequent use cases |
| [Advanced Configuration](03-Guides/02-Advanced-Configuration.md) | Tuning, overrides, advanced options |
| [Troubleshooting](03-Guides/03-Troubleshooting.md) | Common errors, diagnostics, FAQ |

---

## 4. API Reference

| Document | Description |
|----------|-------------|
| [Public API](04-API-Reference/01-Public-API.md) | Exported functions, classes, and their signatures |
| [Configuration Schema](04-API-Reference/02-Configuration-Schema.md) | Complete config schema with defaults and validation |
| [Types and Interfaces](04-API-Reference/03-Types-and-Interfaces.md) | Public TypeScript types and interfaces |

---

## 5. Modules

| Document | Description |
|----------|-------------|
| [{ModuleName}](05-Modules/{module-name}.md) | {Module responsibility} |

---

## 6. Development

| Document | Description |
|----------|-------------|
| [Source Tree](06-Development/01-Source-Tree.md) | Annotated source tree with module descriptions |
| [Build and Test](06-Development/02-Build-and-Test.md) | Build, test, lint, local CI |
| [Code Conventions](06-Development/03-Code-Conventions.md) | Style guide, patterns, anti-patterns |
| [Release Process](06-Development/04-Release-Process.md) | Versioning, release, publishing |
```

---

## Scaffolding Hints Convention

When the scaffolder generates pages in `.anatoly/docs/`, each placeholder must include an HTML comment hint guiding the writer (human or LLM) on how to fill it:

```markdown
<!-- SCAFFOLDING: Describe what your project does in 1-2 sentences.
     Focus on the problem it solves and who it's for.
     Delete this comment when done. -->
```

Rules for scaffolding hints:
- Always wrapped in `<!-- SCAFFOLDING: ... -->`
- Placed immediately before or inside the placeholder they describe
- Actionable: tell the writer *what to write*, not *why the section exists*
- Self-destructing: include "Delete this comment when done."
- Short: max 3 lines per hint

The scaffolder generates these hints dynamically based on the project context (detected type, source code analysis). They are NOT part of the standard templates below — they are injected at scaffold time.

---

## Ideal Page Structure — Template

Every documentation page should follow this skeleton:

```markdown
# {Page Title}

> {1-2 sentence summary. Tells the reader if they're in the right place.}

## Prerequisites
- {What to read/install before this page — omit section if none}

## {Main Content}

{Structured with H2/H3. Progressive: general → specific.}

### {Subsection}

{Content. Use concrete names from the codebase.}

\`\`\`typescript
// Real code example, copy-pasteable
\`\`\`

## Examples

{At least one concrete, runnable example per page.}

\`\`\`typescript
// Example with real function/type names from the project
\`\`\`

## See Also
- [{Related Page}]({relative-link})
```

---

## Ideal Content Per Page

### 01-Getting-Started/01-Overview.md

```markdown
# Overview

> {Project name} is a {type} that {does what} for {whom}.

## What It Does
- {Capability 1}
- {Capability 2}
- {Capability 3}

## What It Does NOT Do
- {Explicit non-goal 1}

## How It Works (30-second version)
{One paragraph — input, process, output. No deep dive.}

## Key Principles
1. {Principle 1 — one sentence}
2. {Principle 2 — one sentence}
```

### 01-Getting-Started/02-Installation.md

```markdown
# Installation

> How to install and verify {project name}.

## Prerequisites
- Node.js {version}+
- {Other prerequisites}

## Install
\`\`\`bash
npm install {package}
# or
npx {package}
\`\`\`

## Verify Installation
\`\`\`bash
{command} --version
\`\`\`

## First Run
\`\`\`bash
{minimal command to see it work}
\`\`\`
Expected output:
\`\`\`
{what the user should see}
\`\`\`
```

### 01-Getting-Started/03-Configuration.md

```markdown
# Configuration

> All configuration options for {project name}.

## Config File
Default location: `{config file path}`

\`\`\`yaml
# Minimal config
{minimal valid config}
\`\`\`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `{VAR_NAME}` | `{default}` | {description} |

## Full Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `{option}` | `{type}` | `{default}` | {description} |
```

### 01-Getting-Started/04-Quick-Start.md

```markdown
# Quick Start

> Get from zero to working result in under 5 minutes.

## Step 1: Install
\`\`\`bash
{install command}
\`\`\`

## Step 2: Configure
\`\`\`bash
{config command or file creation}
\`\`\`

## Step 3: Run
\`\`\`bash
{main command}
\`\`\`

## Step 4: Read the Output
{Explain what the user sees and what to do next.}

## Next Steps
- {Link to Common Workflows for more}
- {Link to Advanced Configuration for tuning}
```

### 02-Architecture/01-System-Overview.md

```markdown
# System Overview

> High-level architecture of {project name}.

## Diagram

\`\`\`mermaid
graph TD
    A[{Input}] --> B[{Component 1}]
    B --> C[{Component 2}]
    C --> D[{Output}]
\`\`\`

## Components

### {Component 1}
**Responsibility:** {one sentence}
**Location:** `src/{path}/`

### {Component 2}
**Responsibility:** {one sentence}
**Location:** `src/{path}/`
```

### 02-Architecture/02-Core-Concepts.md

```markdown
# Core Concepts

> Glossary and key concepts needed to understand {project name}.

## Glossary

| Term | Definition |
|------|-----------|
| **{Term}** | {Definition in the context of this project} |

## Key Concepts

### {Concept 1}
{2-3 sentences explaining what it is and why it matters.}

### {Concept 2}
{2-3 sentences.}
```

### 02-Architecture/05-Data-Model.md (ORM projects)

```markdown
# Data Model

> Database schema, entities, and relationships.

## Entity-Relationship Diagram

\`\`\`mermaid
erDiagram
    {Entity1} ||--o{ {Entity2} : "{relation}"
    {Entity1} {
        string id PK
        string name
        datetime createdAt
    }
\`\`\`

## Entities

### {Entity1}

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `string` | PK, UUID | {description} |

**Relations:**
- Has many `{Entity2}` via `{foreign_key}`

## Indexes
| Table | Columns | Type | Purpose |
|-------|---------|------|---------|
| `{table}` | `{columns}` | unique | {why} |
```

### 04-API-Reference/01-Public-API.md

```markdown
# Public API

> All exported functions, classes, and constants.

## Functions

### `{functionName}()`

{One-line description.}

\`\`\`typescript
function {functionName}({params}): {ReturnType}
\`\`\`

**Parameters:**
| Name | Type | Required | Description |
|------|------|:--------:|-------------|
| `{param}` | `{type}` | ✅ | {description} |

**Returns:** `{ReturnType}` — {description}

**Example:**
\`\`\`typescript
const result = {functionName}({example args});
\`\`\`

## Classes

### `{ClassName}`

{One-line description.}

#### Constructor
\`\`\`typescript
new {ClassName}({params})
\`\`\`

#### Methods
- `{method}()` — {description}

## Constants

| Name | Type | Value | Description |
|------|------|-------|-------------|
| `{CONST}` | `{type}` | `{value}` | {description} |
```

### 04-API-Reference/04-REST-Endpoints.md (Backend API)

```markdown
# REST Endpoints

> All HTTP endpoints exposed by the API.

## Authentication
{How to authenticate — header, token format, etc.}

## Endpoints

### `{METHOD} {/path}`

{One-line description.}

**Auth:** {required | optional | none}

**Request:**
\`\`\`typescript
// Body (if POST/PUT/PATCH)
{
  "{field}": "{type}"
}

// Query params (if GET)
?{param}={type}
\`\`\`

**Response:** `{status code}`
\`\`\`json
{
  "{field}": "{value}"
}
\`\`\`

**Errors:**
| Status | Code | Description |
|--------|------|-------------|
| 400 | `{ERROR_CODE}` | {when} |
| 404 | `{ERROR_CODE}` | {when} |

**Example:**
\`\`\`bash
curl -X {METHOD} {base_url}{path} -H "Authorization: Bearer $TOKEN"
\`\`\`
```

### 04-API-Reference/04-Component-API.md (Frontend)

```markdown
# Component API

> Public components, their props, events, and slots.

## {ComponentName}

{One-line description.}

**Import:**
\`\`\`typescript
import { {ComponentName} } from '{package}';
\`\`\`

**Props:**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `{prop}` | `{type}` | `{default}` | {description} |

**Events:**
| Event | Payload | Description |
|-------|---------|-------------|
| `{event}` | `{type}` | {when emitted} |

**Example:**
\`\`\`tsx
<{ComponentName} {prop}={value} on{Event}={handler} />
\`\`\`
```

### 06-Development/01-Source-Tree.md

```markdown
# Source Tree

> Annotated source directory with module descriptions.

\`\`\`
src/
├── {dir}/                 # {responsibility}
│   ├── {file}.ts          #   {what it does}
│   └── {file}.ts          #   {what it does}
├── {dir}/                 # {responsibility}
└── index.ts               # Main entry point
\`\`\`
```

---

## Code → Documentation Mapping

### Automatic conventions

```
src/index.ts           → docs/04-API-Reference/01-Public-API.md
src/types/             → docs/04-API-Reference/03-Types-and-Interfaces.md
src/schemas/           → docs/04-API-Reference/02-Configuration-Schema.md
src/commands/          → docs/04-API-Reference/04-CLI-Reference.md
src/core/              → docs/05-Modules/{module-name}.md
src/utils/             → docs/05-Modules/{util-name}.md  (if > 200 LOC)

src/components/        → docs/05-Modules/Components.md
src/hooks/             → docs/05-Modules/Hooks.md
src/stores/            → docs/05-Modules/Stores.md
src/pages/             → docs/04-API-Reference/04-Component-API.md

src/routes/            → docs/04-API-Reference/04-REST-Endpoints.md
src/controllers/       → docs/04-API-Reference/04-REST-Endpoints.md
src/middleware/        → docs/04-API-Reference/05-Middleware.md
src/services/          → docs/05-Modules/Services.md
src/validators/        → docs/05-Modules/Validators.md

src/models/            → docs/05-Modules/Models.md
src/entities/          → docs/05-Modules/Models.md
prisma/schema.prisma   → docs/02-Architecture/05-Data-Model.md
drizzle/               → docs/02-Architecture/05-Data-Model.md
src/repositories/      → docs/05-Modules/Repositories.md
src/migrations/        → docs/05-Modules/Migrations.md
```

### Fallback strategy for non-standard layouts

The conventions above cover common directory names. When a project uses non-standard names (e.g., `src/api/` instead of `src/routes/`, `src/handlers/` instead of `src/controllers/`), the scaffolder must apply a fallback strategy:

1. **Export analysis**: if a directory exports HTTP handlers (request/response signatures), map to REST-Endpoints regardless of directory name
2. **Framework detection**: if NestJS `@Controller()` decorators are found, map to REST-Endpoints; if `@Resolver()` found, map to GraphQL-Schema
3. **Content inference**: analyze file exports and JSDoc to classify the module's role (routing, middleware, data access, business logic, UI component)
4. **Directory name normalization**: strip prefixes/suffixes, lowercase, check against known synonyms (`api`=`routes`, `handlers`=`controllers`, `entities`=`models`, `composables`=`hooks`)
5. **Catch-all**: any directory > 200 LOC not matched by conventions → `05-Modules/{dir-name}.md`

### Adapting to existing user docs

When the project already has a `docs/` directory, the scaffolder must also build a **user plan mapping** — understanding how the user organizes their documentation:

1. Scan `docs/` structure (directories, file names)
2. Read each page's H1 and summary line to classify its purpose
3. Build a mapping: `concept → user's file path`
4. For recommendations, provide both `path_ideal` (our structure) and `path_user` (their structure)

This enables Ralph to apply fixes in the user's own organizational style.

---

## JSDoc Standard

### Exported functions (required)

```typescript
/**
 * {What the function does — one sentence.}
 *
 * {Optional: additional context if behavior is non-obvious.}
 *
 * @param {name} - {description}
 * @returns {description}
 *
 * @example
 * ```ts
 * {runnable example}
 * ```
 */
```

### Exported types/interfaces (required if complex)

```typescript
/**
 * {What this type represents.}
 *
 * @property {name} - {description}
 */
```

### Internal helpers < 10 LOC with clear name — JSDoc optional.

---

## Writing Rules

| Rule | Description |
|------|-------------|
| No filler prose | Every paragraph must deliver actionable information |
| Code over text | Prefer a code example over a textual explanation |
| Real names | Use actual file, function, and variable names from the project |
| No timestamps | Never date content (except CHANGELOG). Docs are always "now" |
| No aspirational content | Document what exists, not what's planned (→ Roadmap) |
| One language | Consistent across all docs |
| One concept per page | If a page covers two unrelated topics, split it |
| Mermaid diagrams required | Every page in `02-Architecture/` must include at least 1 Mermaid diagram (flowchart, sequence, ER, etc.) showing component relationships, data flow, or entity structure |
| API usage examples required | Every page in `04-API-Reference/` must include at least 1 complete usage example per documented function/endpoint/component: the call with realistic arguments AND the expected output/response |
| Examples must be runnable | Code examples must be copy-pasteable and produce the documented output. No pseudo-code, no ellipsis in critical paths |
