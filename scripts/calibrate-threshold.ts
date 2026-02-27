/**
 * Calibration script for the code embedding similarity threshold.
 *
 * Usage:
 *   npx tsx scripts/calibrate-threshold.ts [--project-root <path>] [--min-score <float>]
 *
 * This script:
 *   1. Scans the project and builds function cards from AST
 *   2. Embeds all functions using the code embedding model
 *   3. For each function, searches for similar functions with a low threshold
 *   4. Prints a score distribution and the top-N pairs
 *
 * Use the output to decide the optimal minScore for vector-store.ts.
 */

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { embed, buildEmbedCode, setEmbeddingLogger, EMBEDDING_MODEL } from '../src/rag/embeddings.js';
import { buildFunctionCards, buildFunctionId, extractFunctionBody } from '../src/rag/indexer.js';
import type { Task } from '../src/schemas/task.js';
import type { FunctionCard } from '../src/rag/types.js';

const projectRoot = process.argv.includes('--project-root')
  ? process.argv[process.argv.indexOf('--project-root') + 1]
  : '.';

const minScoreArg = process.argv.includes('--min-score')
  ? parseFloat(process.argv[process.argv.indexOf('--min-score') + 1])
  : 0.50;

interface EmbeddedCard {
  card: FunctionCard;
  embedding: number[];
  body: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalized, so dot product = cosine similarity
}

async function main() {
  console.log(`Calibration script for ${EMBEDDING_MODEL}`);
  console.log(`Project root: ${resolve(projectRoot)}`);
  console.log(`Min score: ${minScoreArg}`);
  console.log('');

  setEmbeddingLogger((msg) => console.log(`  [embed] ${msg}`));

  // Pre-warm model
  await embed('');

  // Find all .ts files with functions (simplified — reads task files if available)
  const { glob } = await import('tinyglobby');
  const tsFiles = await glob(['src/**/*.ts'], {
    cwd: resolve(projectRoot),
    ignore: ['**/*.test.ts', '**/*.d.ts', '**/node_modules/**'],
  });

  console.log(`Found ${tsFiles.length} TypeScript files`);

  // For each file, build a minimal Task and extract functions
  const allCards: EmbeddedCard[] = [];
  let fileCount = 0;

  for (const file of tsFiles) {
    const absPath = resolve(projectRoot, file);
    let source: string;
    try {
      source = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    // Simple heuristic to find functions: lines containing 'function ' or '=>'
    // We need proper AST for real accuracy, but for calibration a rough scan works
    const lines = source.split('\n');
    const symbols: Task['symbols'] = [];

    // Very rough function extraction for calibration purposes
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      const arrowMatch = line.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
      const methodMatch = line.match(/^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/);

      const name = fnMatch?.[1] ?? arrowMatch?.[1] ?? methodMatch?.[1];
      if (!name || name === 'if' || name === 'for' || name === 'while' || name === 'switch') continue;

      // Find end of function (rough: count braces)
      let braceCount = 0;
      let started = false;
      let endLine = i;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { braceCount++; started = true; }
          if (ch === '}') braceCount--;
        }
        if (started && braceCount <= 0) {
          endLine = j;
          break;
        }
      }

      if (endLine > i) {
        symbols.push({
          name,
          kind: 'function',
          exported: line.includes('export'),
          line_start: i + 1,
          line_end: endLine + 1,
        });
      }
    }

    if (symbols.length === 0) continue;

    const task: Task = {
      version: 1,
      file,
      hash: 'calibration',
      symbols,
      scanned_at: new Date().toISOString(),
    };

    const cards = buildFunctionCards(task, source);

    for (const card of cards) {
      const symbol = symbols.find(s => s.name === card.name);
      if (!symbol) continue;

      const body = extractFunctionBody(source, symbol);
      const codeText = buildEmbedCode(card.name, card.signature, body);
      const embedding = await embed(codeText);

      allCards.push({ card, embedding, body: body.slice(0, 200) });
    }

    fileCount++;
    if (fileCount % 10 === 0) {
      console.log(`  Processed ${fileCount}/${tsFiles.length} files (${allCards.length} functions)`);
    }
  }

  console.log(`\nTotal: ${allCards.length} functions from ${fileCount} files`);
  console.log('');

  // Compare all pairs
  interface Pair {
    a: EmbeddedCard;
    b: EmbeddedCard;
    score: number;
  }

  const pairs: Pair[] = [];

  for (let i = 0; i < allCards.length; i++) {
    for (let j = i + 1; j < allCards.length; j++) {
      // Skip same-file same-name pairs
      if (allCards[i].card.filePath === allCards[j].card.filePath &&
          allCards[i].card.name === allCards[j].card.name) continue;

      const score = cosineSimilarity(allCards[i].embedding, allCards[j].embedding);
      if (score >= minScoreArg) {
        pairs.push({ a: allCards[i], b: allCards[j], score });
      }
    }
  }

  pairs.sort((a, b) => b.score - a.score);

  // Score distribution
  const buckets = new Map<string, number>();
  for (const p of pairs) {
    const bucket = (Math.floor(p.score * 20) / 20).toFixed(2);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  console.log('Score distribution (pairs above minScore):');
  const sortedBuckets = [...buckets.entries()].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
  for (const [bucket, count] of sortedBuckets) {
    const bar = '#'.repeat(Math.min(count, 60));
    console.log(`  ${bucket}: ${count.toString().padStart(4)} ${bar}`);
  }
  console.log('');

  // Top pairs
  const topN = Math.min(20, pairs.length);
  console.log(`Top ${topN} most similar pairs:`);
  for (let i = 0; i < topN; i++) {
    const p = pairs[i];
    console.log(`  ${p.score.toFixed(4)} | ${p.a.card.filePath}:${p.a.card.name} ↔ ${p.b.card.filePath}:${p.b.card.name}`);
  }

  console.log('');
  console.log('Recommendation:');
  console.log(`  Total pairs above ${minScoreArg}: ${pairs.length}`);
  console.log(`  Pairs above 0.90: ${pairs.filter(p => p.score >= 0.90).length}`);
  console.log(`  Pairs above 0.85: ${pairs.filter(p => p.score >= 0.85).length}`);
  console.log(`  Pairs above 0.80: ${pairs.filter(p => p.score >= 0.80).length}`);
  console.log(`  Pairs above 0.75: ${pairs.filter(p => p.score >= 0.75).length}`);
  console.log(`  Pairs above 0.70: ${pairs.filter(p => p.score >= 0.70).length}`);
}

main().catch(console.error);
