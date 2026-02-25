import type { Task, CoverageData } from '../schemas/task.js';
import type { SimilarityResult } from '../rag/types.js';
import type { VectorStore } from '../rag/vector-store.js';
import type { UsageGraph } from '../core/usage-graph.js';
import { getSymbolUsage } from '../core/usage-graph.js';

export interface PreResolvedRagEntry {
  symbolName: string;
  lineStart: number;
  lineEnd: number;
  /** null means the function was not found in the index */
  results: SimilarityResult[] | null;
}

export type PreResolvedRag = PreResolvedRagEntry[];

export interface PromptOptions {
  ragEnabled?: boolean;
  preResolvedRag?: PreResolvedRag;
  /** Passed through to reviewer for pre-resolution; not used by prompt builder */
  vectorStore?: VectorStore;
  /** Pre-computed import usage graph for the utility axis */
  usageGraph?: UsageGraph;
}

/**
 * Build the system prompt for the Anatoly code review agent.
 * The prompt instructs Claude to review a single file against the 5 axes.
 */
export function buildSystemPrompt(task: Task, options: PromptOptions = {}): string {
  const symbolList = task.symbols
    .map(
      (s) =>
        `- ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (L${s.line_start}–L${s.line_end})`,
    )
    .join('\n');

  const coverageBlock = task.coverage
    ? formatCoverage(task.coverage)
    : 'Coverage data: not available.';

  const hasUsageGraph = options.usageGraph && task.symbols.length > 0;
  const usageSection = hasUsageGraph
    ? buildUsageGraphSection(task, options.usageGraph!)
    : '';

  const usageRule = hasUsageGraph
    ? `
6. For **utility** axis on exported symbols: use the Pre-computed Import Analysis above. Do NOT grep for imports — this data is exhaustive. If a symbol shows 0 importers, mark as utility: "DEAD" (confidence: 95). If a symbol shows 1+ importers, mark as utility: "USED". For non-exported symbols, verify local usage by reading the file only.`
    : '';

  return `You are Anatoly, the most rigorous code auditor in the world.
You audit TypeScript/TSX code with zero tolerance for guessing.

## File under review

\`${task.file}\`

### Symbols extracted from AST

${symbolList || '(no symbols detected)'}

### Coverage

${coverageBlock}
${usageSection}
## Rules (NEVER deviate)

1. **NEVER guess.** Use tools (Grep, Read, Glob) to verify every claim.
2. For **utility: "DEAD"** → you MUST grep the entire project and find zero import/usage matches.
3. For **duplication: "DUPLICATE"** → you MUST read the target file and quote the similar code.
4. **confidence: 100** = bulletproof evidence with tool verification.
5. **confidence < 70** = you are unsure and should investigate more.${usageRule}

## 5 Evaluation Axes

For each symbol, evaluate:

| Axis | Values | Meaning |
|------|--------|---------|
| correction | OK / NEEDS_FIX / ERROR | Bugs, logic errors, wrong types |
| overengineering | LEAN / OVER / ACCEPTABLE | Unnecessary abstraction, premature optimization |
| utility | USED / DEAD / LOW_VALUE | Is the symbol actually used in the codebase? |
| duplication | UNIQUE / DUPLICATE | Is there near-identical code elsewhere? |
| tests | GOOD / WEAK / NONE | Test quality for this symbol |

## Investigation examples

**Example 1 — Dead code detection:**
Thought: \`useAuth\` is exported but might not be imported elsewhere.
Action: Use Grep to search for \`from.*useAuth\` across all .ts/.tsx files.
Result: zero matches → utility: "DEAD", confidence: 95

**Example 2 — Duplication detection:**
Thought: \`calculateTotal\` looks similar to \`utils/pricing.ts:computePrice\`.
Action: Use Read to read the target file, compare the implementations.
Result: 90% identical logic → duplication: "DUPLICATE", duplicate_target: { file: "src/utils/pricing.ts", symbol: "computePrice", similarity: "90% — identical algorithm, different variable names" }

## Output format

You MUST output a single JSON object (no markdown fences, no explanation outside the JSON) that conforms to this schema:

\`\`\`json
{
  "version": 1,
  "file": "${task.file}",
  "is_generated": false,
  "verdict": "CLEAN | NEEDS_REFACTOR | CRITICAL",
  "symbols": [
    {
      "name": "symbolName",
      "kind": "function | class | method | type | constant | variable | enum | hook",
      "exported": true,
      "line_start": 1,
      "line_end": 10,
      "correction": "OK | NEEDS_FIX | ERROR",
      "overengineering": "LEAN | OVER | ACCEPTABLE",
      "utility": "USED | DEAD | LOW_VALUE",
      "duplication": "UNIQUE | DUPLICATE",
      "tests": "GOOD | WEAK | NONE",
      "confidence": 85,
      "detail": "Explanation of findings (min 10 chars)"
      // "duplicate_target": { "file": "...", "symbol": "...", "similarity": "..." }  ← only when duplication is "DUPLICATE", omit entirely otherwise
    }
  ],
  "actions": [
    {
      "id": 1,
      "description": "What to fix or improve",
      "severity": "high | medium | low",
      "effort": "trivial | small | large",
      "category": "quickwin | refactor | hygiene",
      "target_symbol": "symbolName",
      "target_lines": "L10-L20"
    }
  ],
  "file_level": {
    "unused_imports": [],
    "circular_dependencies": [],
    "general_notes": ""
  }
}
\`\`\`

## Guardrails

- Files under 20 lines: do NOT mark as overengineering: "OVER". Short files are inherently lean.
- tests: "NONE" alone does NOT justify verdict NEEDS_REFACTOR. Only flag tests in actions if the symbol has complex logic (branches, error handling, state mutations).
- Barrel exports (re-export files) and type-only files: tests: "NONE" is expected. Do NOT create an action for "add tests" on these.
- confidence MUST be > 0. If you cannot verify a claim, set confidence to at least 50 and explain in the detail field what you could not verify and why.
- When creating actions, set effort and category:
  - effort: "trivial" (< 10 min, e.g. delete dead code, fix an import), "small" (< 1h, e.g. extract function, resolve duplication), "large" (> 1h, e.g. restructure module, split a file)
  - category: "quickwin" (high impact + trivial/small effort), "refactor" (structural change), "hygiene" (tests, docs, naming — nice to have)
- Do NOT create an action for every tests: "NONE". Only create test actions when:
  - The symbol has >= 3 branches or complex error handling
  - The symbol mutates external state
  - The symbol is a critical path (used in > 5 files)

## Important

- Review ALL symbols listed above — do not skip any.
- Read the file first to understand the full context.
- Use Grep to verify utility claims (USED vs DEAD).
- The \`detail\` field must be at least 10 characters and explain your reasoning.
- \`verdict\` should be CRITICAL if any symbol has correction: "ERROR".
- \`verdict\` should be NEEDS_REFACTOR if any symbol has issues (correction, utility, duplication, or overengineering) but no errors. tests: "NONE" alone is NOT an issue.
- \`verdict\` should be CLEAN if all symbols are healthy (tests: "NONE" alone counts as healthy).
- Output ONLY the JSON object. No preamble, no markdown fences.${options.ragEnabled && options.preResolvedRag ? buildRagPromptSection(options.preResolvedRag) : ''}`;
}

function formatCoverage(cov: CoverageData): string {
  const stmtPct = cov.statements_total > 0
    ? ((cov.statements_covered / cov.statements_total) * 100).toFixed(1)
    : 'N/A';
  const branchPct = cov.branches_total > 0
    ? ((cov.branches_covered / cov.branches_total) * 100).toFixed(1)
    : 'N/A';
  const fnPct = cov.functions_total > 0
    ? ((cov.functions_covered / cov.functions_total) * 100).toFixed(1)
    : 'N/A';
  const linePct = cov.lines_total > 0
    ? ((cov.lines_covered / cov.lines_total) * 100).toFixed(1)
    : 'N/A';

  return `Coverage data:
- Statements: ${stmtPct}% (${cov.statements_covered}/${cov.statements_total})
- Branches: ${branchPct}% (${cov.branches_covered}/${cov.branches_total})
- Functions: ${fnPct}% (${cov.functions_covered}/${cov.functions_total})
- Lines: ${linePct}% (${cov.lines_covered}/${cov.lines_total})`;
}

/**
 * Build the usage graph prompt section showing import analysis for each symbol.
 */
function buildUsageGraphSection(task: Task, graph: UsageGraph): string {
  if (task.symbols.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('## Pre-computed Import Analysis');
  lines.push('');
  lines.push('The following usage data was computed by scanning ALL project files.');
  lines.push('This data is EXHAUSTIVE — you do NOT need to Grep for import verification.');
  lines.push('Use this for the `utility` axis.');
  lines.push('');

  for (const sym of task.symbols) {
    if (sym.exported) {
      const importers = getSymbolUsage(graph, sym.name, task.file);
      if (importers.length === 0) {
        lines.push(`- ${sym.name} (exported): imported by 0 files ⚠️ LIKELY DEAD`);
      } else {
        lines.push(`- ${sym.name} (exported): imported by ${importers.length} file${importers.length > 1 ? 's' : ''}: ${importers.join(', ')}`);
      }
    } else {
      lines.push(`- ${sym.name} (not exported): internal only — check for local usage within this file`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Build the RAG-specific prompt section with pre-resolved similarity results.
 * Appended to the system prompt when RAG is active.
 */
function buildRagPromptSection(rag: PreResolvedRag): string {
  if (rag.length === 0) {
    return `

## RAG — Semantic Duplication (pre-resolved)

No functions to check for duplication (barrel export / type-only file).`;
  }

  const entries = rag.map((entry) => {
    const header = `### ${entry.symbolName} (L${entry.lineStart}–L${entry.lineEnd})`;

    if (entry.results === null) {
      return `${header}\nFunction not indexed — cannot check for duplication.`;
    }

    if (entry.results.length === 0) {
      return `${header}\nNo similar functions found.`;
    }

    const matches = entry.results.map(
      (r) =>
        `- **${r.card.name}** in \`${r.card.filePath}\` (score: ${r.score.toFixed(3)})\n` +
        `  Summary: ${r.card.summary}\n` +
        `  Profile: ${r.card.behavioralProfile} | Complexity: ${r.card.complexityScore}/5`,
    );
    return `${header}\nSimilar functions found:\n${matches.join('\n')}`;
  });

  return `

## RAG — Semantic Duplication (pre-resolved)

The following similarity results were pre-computed from the codebase index.
Use these results for the \`duplication\` axis — do NOT use Grep for duplication detection.
- Score >= 0.85: mark as duplication: "DUPLICATE" and set duplicate_target accordingly.
- Score 0.78–0.85: mention in the detail field but keep duplication: "UNIQUE" unless clearly duplicated.
- No results: mark as duplication: "UNIQUE".

${entries.join('\n\n')}`;
}

/**
 * Build the user prompt (the initial question sent to the agent).
 */
export function buildUserPrompt(task: Task, _options: PromptOptions = {}): string {
  return `Review the file \`${task.file}\` according to the 5 evaluation axes. Read the file first, then investigate each symbol. Output a single JSON object conforming to the schema.`;
}
