import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewFile, Action } from '../schemas/review.js';
import { atomicWriteJson, toOutputName } from '../utils/cache.js';

/**
 * Write both .rev.json and .rev.md for a completed review.
 * When runDir is provided, writes into the run-scoped reviews directory.
 * Returns the paths to both files.
 */
export function writeReviewOutput(
  projectRoot: string,
  review: ReviewFile,
  runDir?: string,
): { jsonPath: string; mdPath: string } {
  const reviewsDir = runDir ? join(runDir, 'reviews') : join(projectRoot, '.anatoly', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });

  const baseName = toOutputName(review.file);
  const jsonPath = join(reviewsDir, `${baseName}.rev.json`);
  const mdPath = join(reviewsDir, `${baseName}.rev.md`);

  // Write JSON (atomic)
  atomicWriteJson(jsonPath, review);

  // Write Markdown
  const markdown = renderReviewMarkdown(review);
  writeFileSync(mdPath, markdown);

  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DetailSegment {
  value: string;
  explanation: string;
}

const VALUE_TO_AXIS: Record<string, string> = {
  USED: 'Utility', DEAD: 'Utility', LOW_VALUE: 'Utility',
  UNIQUE: 'Duplication', DUPLICATE: 'Duplication',
  OK: 'Correction', NEEDS_FIX: 'Correction', ERROR: 'Correction',
  LEAN: 'Overengineering', OVER: 'Overengineering', ACCEPTABLE: 'Overengineering',
  GOOD: 'Tests', WEAK: 'Tests', NONE: 'Tests',
};

/**
 * Parse the pipe-delimited detail string produced by axis-merger.ts
 * into structured segments. Returns null if parsing fails (v1 fallback).
 */
export function parseDetailSegments(detail: string): DetailSegment[] | null {
  const regex = /\[([A-Z_]+)\]\s*(.+?)(?=\s*\|\s*\[|$)/gs;
  const segments: DetailSegment[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(detail)) !== null) {
    segments.push({ value: match[1], explanation: match[2].trim() });
  }
  return segments.length > 0 ? segments : null;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderFileAction(lines: string[], a: Action): void {
  const effort = a.effort ?? 'small';
  const target = a.target_symbol ? ` (\`${a.target_symbol}\`)` : '';
  const loc = a.target_lines ? ` [${a.target_lines}]` : '';
  lines.push(`- **[${a.severity} · ${effort}]** ${a.description}${target}${loc}`);
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Render a ReviewFile as a human-readable Markdown document.
 */
export function renderReviewMarkdown(review: ReviewFile): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Review: \`${review.file}\``);
  lines.push('');
  lines.push(`**Verdict:** ${review.verdict}`);
  if (review.is_generated) {
    lines.push(`**Generated file:** yes${review.skip_reason ? ` (${review.skip_reason})` : ''}`);
  }
  lines.push('');

  // Symbols table
  if (review.symbols.length > 0) {
    lines.push('## Symbols');
    lines.push('');
    lines.push('| Symbol | Kind | Exported | Correction | Over-eng. | Utility | Duplication | Tests | Confidence |');
    lines.push('|--------|------|----------|------------|-----------|---------|-------------|-------|------------|');

    for (const s of review.symbols) {
      const exp = s.exported ? 'yes' : 'no';
      lines.push(
        `| ${s.name} | ${s.kind} | ${exp} | ${s.correction} | ${s.overengineering} | ${s.utility} | ${s.duplication} | ${s.tests} | ${s.confidence}% |`,
      );
    }
    lines.push('');

    // Symbol details — structured per-axis breakdown
    lines.push('### Details');
    lines.push('');
    for (const s of review.symbols) {
      lines.push(`#### \`${s.name}\` (L${s.line_start}–L${s.line_end})`);
      lines.push('');

      const segments = parseDetailSegments(s.detail);
      if (segments) {
        for (const seg of segments) {
          const axisName = VALUE_TO_AXIS[seg.value] ?? seg.value;
          lines.push(`- **${axisName} [${seg.value}]**: ${seg.explanation}`);
        }
      } else {
        lines.push(s.detail);
      }

      if (s.duplicate_target?.file) {
        lines.push('');
        lines.push(`> **Duplicate of** \`${s.duplicate_target.file}:${s.duplicate_target.symbol}\` — ${s.duplicate_target.similarity}`);
      }
      lines.push('');
    }
  }

  // Best Practices
  if (review.best_practices) {
    const bp = review.best_practices;
    lines.push(`## Best Practices — ${bp.score}/10`);
    lines.push('');

    // Rules table (only WARN and FAIL)
    const failingRules = bp.rules.filter((r) => r.status !== 'PASS');
    if (failingRules.length > 0) {
      lines.push('### Rules');
      lines.push('');
      lines.push('| # | Rule | Status | Severity | Detail |');
      lines.push('|---|------|--------|----------|--------|');
      for (const r of failingRules) {
        const detail = r.detail ? escapeTableCell(r.detail) : '';
        const linesRef = r.lines ? ` [${r.lines}]` : '';
        lines.push(`| ${r.rule_id} | ${r.rule_name} | ${r.status} | ${r.severity} | ${detail}${linesRef} |`);
      }
      lines.push('');
    }

    // Suggestions with before/after
    if (bp.suggestions.length > 0) {
      lines.push('### Suggestions');
      lines.push('');
      for (const s of bp.suggestions) {
        lines.push(`- ${s.description}`);
        if (s.before && s.after) {
          if (s.before.includes('\n') || s.after.includes('\n')) {
            lines.push('  ```typescript');
            lines.push(`  // Before`);
            for (const line of s.before.split('\n')) {
              lines.push(`  ${line}`);
            }
            lines.push(`  // After`);
            for (const line of s.after.split('\n')) {
              lines.push(`  ${line}`);
            }
            lines.push('  ```');
          } else {
            lines.push(`  - Before: \`${s.before}\``);
            lines.push(`  - After: \`${s.after}\``);
          }
        }
      }
      lines.push('');
    }
  }

  // Actions grouped by category
  if (review.actions.length > 0) {
    lines.push('## Actions');
    lines.push('');

    const byCategory: Record<string, Action[]> = {
      quickwin: [],
      refactor: [],
      hygiene: [],
    };
    for (const a of review.actions) {
      const cat = a.category ?? 'refactor';
      byCategory[cat].push(a);
    }

    if (byCategory.quickwin.length > 0) {
      lines.push('### Quick Wins');
      lines.push('');
      for (const a of byCategory.quickwin) renderFileAction(lines, a);
      lines.push('');
    }

    if (byCategory.refactor.length > 0) {
      lines.push('### Refactors');
      lines.push('');
      for (const a of byCategory.refactor) renderFileAction(lines, a);
      lines.push('');
    }

    if (byCategory.hygiene.length > 0) {
      lines.push('### Hygiene');
      lines.push('');
      for (const a of byCategory.hygiene) renderFileAction(lines, a);
      lines.push('');
    }
  }

  // File-level notes
  const fl = review.file_level;
  // Strip BP summary from general_notes since it's now rendered in its own section
  let generalNotes = fl.general_notes;
  if (review.best_practices) {
    generalNotes = generalNotes.replace(/Best practices score:\s*[\d.]+\/10\s*\([^)]*\)\s*/g, '').trim();
  }

  const hasFileLevel =
    fl.unused_imports.length > 0 ||
    fl.circular_dependencies.length > 0 ||
    generalNotes.length > 0;

  if (hasFileLevel) {
    lines.push('## File-Level Notes');
    lines.push('');
    if (fl.unused_imports.length > 0) {
      lines.push(`**Unused imports:** ${fl.unused_imports.join(', ')}`);
      lines.push('');
    }
    if (fl.circular_dependencies.length > 0) {
      lines.push(`**Circular dependencies:** ${fl.circular_dependencies.join(', ')}`);
      lines.push('');
    }
    if (generalNotes) {
      lines.push(generalNotes);
      lines.push('');
    }
  }

  return lines.join('\n');
}
