# TypeScript Documentation — Scoring Rubric

## Purpose

This document defines how to **evaluate and score** the documentation completeness of a TypeScript project. It is consumed by Anatoly's documentation axis to produce verdicts and recommendations.

The structure it references is defined in `typescript-documentation.md` (the ideal skeleton).

---

## Scoring Dimensions

| Dimension | Weight | What it measures |
|-----------|:------:|------------------|
| **Structural presence** | 25% | Required folders/files from the skeleton exist |
| **API coverage** | 25% | % of public exports with complete JSDoc |
| **Module coverage** | 20% | % of modules > 200 LOC with a dedicated doc page |
| **Content quality** | 15% | Pages follow writing rules (examples, real names, no filler) |
| **Navigation** | 15% | index.md is current, cross-links work, logical progression |

### Weight adjustments by project type

| Type | Adjustment |
|------|-----------|
| **Frontend** | +10% weight on Component API + State Management documented |
| **Backend API** | +10% weight on REST/GraphQL Endpoints + Auth + Error Handling documented |
| **ORM** | +10% weight on Data Model + Migrations + Query Patterns documented |
| **Library** | +15% weight on Public API (it's the primary deliverable) |
| **Monorepo** | +10% weight on Package Overview + Dependency Graph documented |

---

## Verdicts

### Project-level verdict

| Score | Verdict | Meaning |
|:-----:|---------|---------|
| >= 80% | **DOCUMENTED** | Documentation is complete and maintainable |
| 50-79% | **PARTIAL** | Documentation exists but has significant gaps |
| < 50% | **UNDOCUMENTED** | Documentation is insufficient or absent |

### Per-symbol verdict (JSDoc)

| Verdict | Criteria | Confidence |
|---------|----------|:----------:|
| **DOCUMENTED** | JSDoc with description, params, returns, behavior | 90+ |
| **PARTIAL** | JSDoc exists but incomplete (missing params, trivial description) | 80+ |
| **UNDOCUMENTED** | No JSDoc or trivial one-word comment | 95 |

#### Special cases

- **Types/interfaces/enums** with self-descriptive names and fields → DOCUMENTED by default (confidence: 95). Only PARTIAL/UNDOCUMENTED if complex semantics not obvious from names.
- **Private helpers** with clear names and < 10 LOC → tolerate UNDOCUMENTED (lower confidence: 60). Focus on exported public API.
- **Test files** → all symbols DOCUMENTED by default (confidence: 95). Tests are self-documenting.

### Per-concept verdict (docs coverage)

| Verdict | Criteria |
|---------|----------|
| **COVERED** | Concept documented in /docs/ with accurate description |
| **PARTIAL** | Mentioned but outdated, incomplete, or incorrect |
| **MISSING** | Not mentioned in any documentation page |
| **OUTDATED** | Mentioned but contradicts actual code |

---

## Structural Completeness Checklist

### Required (must exist for PASS)

| Section | Pass criteria |
|---------|--------------|
| `docs/index.md` | Exists and lists all doc sections |
| `01-Getting-Started/` | At least Installation + Configuration |
| `02-Architecture/` | At least System-Overview |
| `04-API-Reference/` | At least one page matching project type (Public-API, CLI-Reference, REST-Endpoints, or Component-API) |
| `06-Development/` | At least Source-Tree or Build-and-Test |

### Recommended (improves score)

| Section | Criteria |
|---------|---------|
| `01-Getting-Started/04-Quick-Start.md` | User can go from zero to result in < 5 min |
| `02-Architecture/02-Core-Concepts.md` | Glossary covers key domain terms |
| `03-Guides/` | At least 3 step-by-step workflows |
| `05-Modules/` | Coverage >= 80% of modules > 200 LOC |
| `07-Operations/` | Present if project is deployed (not library-only) |
| `08-Business-Context/` | Present if project has non-trivial business domain |

### Conditional (required if project type detected)

| Project type | Required section |
|-------------|-----------------|
| CLI | `04-API-Reference/CLI-Reference.md` |
| Backend API | `04-API-Reference/REST-Endpoints.md` or `GraphQL-Schema.md` |
| Frontend | `04-API-Reference/Component-API.md` |
| ORM | `02-Architecture/Data-Model.md` |
| Monorepo | `00-Monorepo/Package-Overview.md` |

---

## Content Quality Criteria

A page passes quality check if:

| Rule | Check |
|------|-------|
| **Has summary** | Starts with H1 + blockquote summary (1-2 sentences) |
| **Has substance** | > 50 words of content (excluding headings and code blocks) |
| **Has examples** | At least 1 code block with real project names |
| **Has Mermaid diagrams** | Architecture pages (`02-Architecture/`) include at least 1 Mermaid diagram |
| **Has API usage examples** | API Reference pages (`04-API-Reference/`) include at least 1 complete usage example per function/endpoint/component (call + expected output) |
| **Examples are runnable** | Code examples use real function names and produce the documented output — no pseudo-code |
| **No placeholders** | No `{placeholder}` or `TODO` markers remain |
| **No filler** | No paragraphs that can be deleted without information loss |
| **Real names** | References actual files, functions, types from the codebase |
| **Current** | Content matches current code (not outdated) |

---

## Recommendation Types

When the documentation axis emits findings, each recommendation has a type:

| Type | Description | Example |
|------|-------------|---------|
| `missing_page` | A page from the skeleton doesn't exist | `03-Guides/01-Common-Workflows.md` needed |
| `missing_section` | An existing page lacks a required section | Installation page missing "First Run" section |
| `missing_jsdoc` | A public export has no JSDoc | `export function runPipeline()` undocumented |
| `incomplete_jsdoc` | JSDoc exists but missing params/returns | `@param options` not described |
| `outdated_content` | Doc content contradicts current code | Data-Model page shows old schema |
| `empty_page` | Page exists but has < 50 words of content | Placeholder-only page |
| `broken_link` | Internal link points to non-existent page | `[See RAG](03-RAG.md)` → file doesn't exist |
| `missing_index_entry` | Page exists but not listed in index.md | New module page not in table of contents |

### Recommendation format in report

```json
{
  "axis": "documentation",
  "type": "missing_page",
  "path_ideal": ".anatoly/docs/05-Modules/RAG.md",
  "path_user": "docs/02-Architecture/03-RAG-Engine.md",
  "content_ref": ".anatoly/docs/05-Modules/RAG.md",
  "rationale": "Module src/rag/ (4 files, 1200+ LOC) has no dedicated documentation page",
  "priority": "high"
}
```

The clean loop reads `content_ref` from `.anatoly/docs/` and applies the content to `path_user`, adapting to the user's existing structure.

---

## Gap Report Format

The audit report includes a documentation summary section:

```
Documentation Reference
=======================
.anatoly/docs/ updated: {total} pages ({new} new, {refreshed} refreshed, {cached} cached)

Project type detected: {types}

Structural score:  {n}% ({present}/{expected} sections)
API coverage:      {n}% ({documented}/{total} public exports with JSDoc)
Module coverage:   {n}% ({documented}/{total} modules > 200 LOC)
Content quality:   {n}%
Navigation:        {n}%

Overall: {score}% → {VERDICT}

New pages generated:
  + .anatoly/docs/{path}  (from {source})

Your docs/ vs .anatoly/docs/:
  docs/ coverage: {n}% ({present}/{total} pages)
  Sync gap: {n} pages

Recommendations: {count} findings
  {count} missing_page | {count} missing_jsdoc | {count} outdated_content | ...
```
