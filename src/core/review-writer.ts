import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReviewFile } from '../schemas/review.js';
import { atomicWriteJson, toOutputName } from '../utils/cache.js';
import { writeFileSync } from 'node:fs';

/**
 * Write both .rev.json and .rev.md for a completed review.
 * Returns the paths to both files.
 */
export function writeReviewOutput(
  projectRoot: string,
  review: ReviewFile,
): { jsonPath: string; mdPath: string } {
  const reviewsDir = resolve(projectRoot, '.anatoly', 'reviews');
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

/**
 * Render a ReviewFile as a human-readable Markdown document.
 */
export function renderReviewMarkdown(review: ReviewFile): string {
  const lines: string[] = [];

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
    lines.push('| Symbol | Kind | Correction | Over-eng. | Utility | Duplication | Tests | Confidence |');
    lines.push('|--------|------|------------|-----------|---------|-------------|-------|------------|');

    for (const s of review.symbols) {
      lines.push(
        `| ${s.name} | ${s.kind} | ${s.correction} | ${s.overengineering} | ${s.utility} | ${s.duplication} | ${s.tests} | ${s.confidence}% |`,
      );
    }
    lines.push('');

    // Symbol details
    lines.push('### Details');
    lines.push('');
    for (const s of review.symbols) {
      lines.push(`#### \`${s.name}\` (L${s.line_start}–L${s.line_end})`);
      lines.push('');
      lines.push(s.detail);
      if (s.duplicate_target) {
        lines.push('');
        lines.push(`> **Duplicate of** \`${s.duplicate_target.file}:${s.duplicate_target.symbol}\` — ${s.duplicate_target.similarity}`);
      }
      lines.push('');
    }
  }

  // Actions
  if (review.actions.length > 0) {
    lines.push('## Actions');
    lines.push('');
    for (const a of review.actions) {
      const target = a.target_symbol ? ` (\`${a.target_symbol}\`)` : '';
      const loc = a.target_lines ? ` [${a.target_lines}]` : '';
      lines.push(`${a.id}. **[${a.severity}]** ${a.description}${target}${loc}`);
    }
    lines.push('');
  }

  // FunctionCards (RAG)
  if (review.function_cards && review.function_cards.length > 0) {
    lines.push('## FunctionCards (RAG)');
    lines.push('');
    lines.push('| Function | Profile | Concepts |');
    lines.push('|----------|---------|----------|');
    for (const card of review.function_cards) {
      lines.push(`| ${card.name} | ${card.behavioralProfile} | ${card.keyConcepts.join(', ')} |`);
    }
    lines.push('');
  }

  // File-level notes
  const fl = review.file_level;
  const hasFileLevel =
    fl.unused_imports.length > 0 ||
    fl.circular_dependencies.length > 0 ||
    fl.general_notes.length > 0;

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
    if (fl.general_notes) {
      lines.push(fl.general_notes);
      lines.push('');
    }
  }

  return lines.join('\n');
}
