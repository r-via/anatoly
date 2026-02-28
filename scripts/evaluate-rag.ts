/**
 * RAG Pipeline Evaluation Script
 *
 * Evaluates the quality of the code embedding pipeline by testing it against
 * a ground-truth set of known duplicate and unique function pairs.
 *
 * Usage:
 *   npx tsx scripts/evaluate-rag.ts [--threshold <float>] [--verbose]
 *
 * Outputs:
 *   - Pairwise similarity matrix
 *   - Precision, recall, F1 at multiple thresholds
 *   - Optimal threshold recommendation
 *   - Score distribution histogram
 *   - Per-group analysis
 */

import { embedCode, buildEmbedCode, setEmbeddingLogger, getCodeModelId } from '../src/rag/embeddings.js';
import {
  EVAL_FUNCTIONS,
  buildGroundTruth,
  pairKey,
  type EvalFunction,
} from './fixtures/eval-functions.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const verbose = process.argv.includes('--verbose');
const thresholdArg = process.argv.includes('--threshold')
  ? parseFloat(process.argv[process.argv.indexOf('--threshold') + 1])
  : undefined;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmbeddedFunction {
  fn: EvalFunction;
  embedding: number[];
}

interface PairResult {
  a: EvalFunction;
  b: EvalFunction;
  score: number;
  isDuplicate: boolean; // ground truth
}

interface MetricsAtThreshold {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // L2-normalized vectors → dot = cosine
}

function computeMetrics(
  pairs: PairResult[],
  threshold: number,
): MetricsAtThreshold {
  let tp = 0, fp = 0, fn = 0, tn = 0;

  for (const p of pairs) {
    const predicted = p.score >= threshold;
    if (predicted && p.isDuplicate) tp++;
    else if (predicted && !p.isDuplicate) fp++;
    else if (!predicted && p.isDuplicate) fn++;
    else tn++;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { threshold, tp, fp, fn, tn, precision, recall, f1 };
}

function formatPercent(value: number): string {
  return (value * 100).toFixed(1) + '%';
}

function bar(value: number, maxWidth: number = 30): string {
  const filled = Math.round(value * maxWidth);
  return '█'.repeat(filled) + '░'.repeat(maxWidth - filled);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           RAG Pipeline Evaluation                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Model:      ${getCodeModelId()}`);
  console.log(`Functions:  ${EVAL_FUNCTIONS.length}`);
  console.log(`Verbose:    ${verbose}`);
  console.log();

  // Suppress model loading logs unless verbose
  if (verbose) {
    setEmbeddingLogger((msg) => console.log(`  [embed] ${msg}`));
  } else {
    setEmbeddingLogger(() => {});
  }

  // --- Phase 1: Embed all functions ---
  console.log('Phase 1: Embedding functions...');
  const embedded: EmbeddedFunction[] = [];

  // Pre-warm model
  await embedCode('');

  for (const fn of EVAL_FUNCTIONS) {
    const codeText = buildEmbedCode(fn.name, fn.source.split('\n')[1]?.trim() ?? '', fn.source);
    const embedding = await embedCode(codeText);
    embedded.push({ fn, embedding });
    if (verbose) {
      console.log(`  ✓ ${fn.id} (${fn.group})`);
    }
  }
  console.log(`  Embedded ${embedded.length} functions.\n`);

  // --- Phase 2: Compute all pairwise similarities ---
  console.log('Phase 2: Computing pairwise similarities...');
  const groundTruth = buildGroundTruth();
  const pairs: PairResult[] = [];

  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      const score = cosineSimilarity(embedded[i].embedding, embedded[j].embedding);
      const key = pairKey(embedded[i].fn.id, embedded[j].fn.id);
      pairs.push({
        a: embedded[i].fn,
        b: embedded[j].fn,
        score,
        isDuplicate: groundTruth.has(key),
      });
    }
  }

  const totalPairs = pairs.length;
  const duplicatePairs = pairs.filter(p => p.isDuplicate).length;
  const uniquePairs = totalPairs - duplicatePairs;
  console.log(`  Total pairs: ${totalPairs} (${duplicatePairs} duplicates, ${uniquePairs} non-duplicates)\n`);

  // --- Phase 3: Similarity matrix ---
  console.log('Phase 3: Similarity Matrix');
  console.log('─'.repeat(60));

  // Group duplicate pairs
  const dupPairs = pairs.filter(p => p.isDuplicate).sort((a, b) => b.score - a.score);
  console.log('\n  Duplicate pairs (ground truth):');
  for (const p of dupPairs) {
    const marker = p.score >= 0.75 ? '✓' : p.score >= 0.60 ? '~' : '✗';
    console.log(`  ${marker} ${p.score.toFixed(4)}  ${p.a.name} ↔ ${p.b.name}  (${p.a.group})`);
  }

  // Top false-positive candidates (highest-scoring non-duplicate pairs)
  const nonDupPairs = pairs.filter(p => !p.isDuplicate).sort((a, b) => b.score - a.score);
  console.log('\n  Top non-duplicate pairs (potential false positives):');
  for (const p of nonDupPairs.slice(0, 10)) {
    console.log(`    ${p.score.toFixed(4)}  ${p.a.name} ↔ ${p.b.name}  (${p.a.group} vs ${p.b.group})`);
  }
  console.log();

  // --- Phase 4: Threshold sweep ---
  console.log('Phase 4: Threshold Analysis');
  console.log('─'.repeat(60));

  const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];
  const metricsTable: MetricsAtThreshold[] = thresholds.map(t => computeMetrics(pairs, t));

  console.log('\n  Threshold  Precision  Recall    F1        TP  FP  FN  TN');
  console.log('  ' + '─'.repeat(62));

  let bestF1 = { threshold: 0, f1: 0 };
  for (const m of metricsTable) {
    const marker = thresholdArg !== undefined && Math.abs(m.threshold - thresholdArg) < 0.001 ? ' ◀' : '';
    console.log(
      `  ${m.threshold.toFixed(2)}     ` +
      `${formatPercent(m.precision).padStart(7)}   ` +
      `${formatPercent(m.recall).padStart(7)}   ` +
      `${formatPercent(m.f1).padStart(7)}   ` +
      `${String(m.tp).padStart(3)} ${String(m.fp).padStart(3)} ${String(m.fn).padStart(3)} ${String(m.tn).padStart(3)}` +
      marker,
    );
    if (m.f1 > bestF1.f1) {
      bestF1 = { threshold: m.threshold, f1: m.f1 };
    }
  }
  console.log();

  // --- Phase 5: Score distribution ---
  console.log('Phase 5: Score Distribution');
  console.log('─'.repeat(60));

  const bucketSize = 0.05;
  const buckets = new Map<number, { dup: number; nonDup: number }>();

  for (const p of pairs) {
    const bucket = Math.floor(p.score / bucketSize) * bucketSize;
    const entry = buckets.get(bucket) ?? { dup: 0, nonDup: 0 };
    if (p.isDuplicate) entry.dup++;
    else entry.nonDup++;
    buckets.set(bucket, entry);
  }

  const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);

  console.log('\n  Score Range    Dup  Non-Dup  Distribution');
  for (const [bucket, counts] of sortedBuckets) {
    if (counts.dup === 0 && counts.nonDup === 0) continue;
    const total = counts.dup + counts.nonDup;
    const maxBar = 40;
    const dupBar = Math.round((counts.dup / Math.max(total, 1)) * Math.min(total, maxBar));
    const nonDupBar = Math.min(total, maxBar) - dupBar;
    console.log(
      `  ${bucket.toFixed(2)}-${(bucket + bucketSize).toFixed(2)}  ` +
      `${String(counts.dup).padStart(4)} ${String(counts.nonDup).padStart(8)}  ` +
      `${'█'.repeat(dupBar)}${'░'.repeat(nonDupBar)}`,
    );
  }
  console.log('  Legend: █ = duplicate, ░ = non-duplicate');
  console.log();

  // --- Phase 6: Per-group analysis ---
  console.log('Phase 6: Per-Group Analysis');
  console.log('─'.repeat(60));

  const groups = [...new Set(EVAL_FUNCTIONS.filter(f => !f.group.startsWith('unique-')).map(f => f.group))];

  for (const group of groups) {
    const groupFns = EVAL_FUNCTIONS.filter(f => f.group === group);
    const groupPairs = dupPairs.filter(p => p.a.group === group);
    const avgScore = groupPairs.reduce((sum, p) => sum + p.score, 0) / (groupPairs.length || 1);

    console.log(`\n  ${group}:`);
    console.log(`    Functions: ${groupFns.map(f => f.name).join(', ')}`);
    console.log(`    Avg similarity: ${avgScore.toFixed(4)}  ${bar(avgScore, 20)}`);

    // Find closest non-duplicate to this group's functions
    const groupIds = new Set(groupFns.map(f => f.id));
    const nearMisses = nonDupPairs
      .filter(p => groupIds.has(p.a.id) || groupIds.has(p.b.id))
      .slice(0, 3);
    if (nearMisses.length > 0) {
      console.log(`    Nearest non-dup: ${nearMisses[0].score.toFixed(4)} (${nearMisses[0].a.name} ↔ ${nearMisses[0].b.name})`);
    }
  }
  console.log();

  // --- Phase 7: Separation analysis ---
  console.log('Phase 7: Separation Analysis');
  console.log('─'.repeat(60));

  const dupScores = dupPairs.map(p => p.score);
  const nonDupScores = nonDupPairs.map(p => p.score);

  const minDup = Math.min(...dupScores);
  const maxDup = Math.max(...dupScores);
  const avgDup = dupScores.reduce((a, b) => a + b, 0) / dupScores.length;

  const maxNonDup = Math.max(...nonDupScores);
  const avgNonDup = nonDupScores.reduce((a, b) => a + b, 0) / nonDupScores.length;

  console.log(`\n  Duplicate scores:     min=${minDup.toFixed(4)}  avg=${avgDup.toFixed(4)}  max=${maxDup.toFixed(4)}`);
  console.log(`  Non-duplicate scores: max=${maxNonDup.toFixed(4)}  avg=${avgNonDup.toFixed(4)}`);
  console.log(`  Gap (min_dup - max_nondup): ${(minDup - maxNonDup).toFixed(4)}`);

  if (minDup > maxNonDup) {
    console.log(`  ✓ Clean separation: all duplicates score higher than all non-duplicates`);
  } else {
    const overlap = nonDupPairs.filter(p => p.score >= minDup).length;
    console.log(`  ⚠ Overlap: ${overlap} non-duplicate pair(s) score >= lowest duplicate (${minDup.toFixed(4)})`);
  }
  console.log();

  // --- Summary ---
  console.log('═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));

  const currentThreshold = thresholdArg ?? 0.75;
  const currentMetrics = computeMetrics(pairs, currentThreshold);

  console.log(`\n  Current threshold (${currentThreshold.toFixed(2)}):`);
  console.log(`    Precision: ${formatPercent(currentMetrics.precision)}`);
  console.log(`    Recall:    ${formatPercent(currentMetrics.recall)}`);
  console.log(`    F1:        ${formatPercent(currentMetrics.f1)}`);
  console.log();

  console.log(`  Best F1 threshold: ${bestF1.threshold.toFixed(2)} (F1 = ${formatPercent(bestF1.f1)})`);

  // Fine-grained search around the best threshold
  let fineBest = bestF1;
  for (let t = bestF1.threshold - 0.05; t <= bestF1.threshold + 0.05; t += 0.01) {
    const m = computeMetrics(pairs, t);
    if (m.f1 > fineBest.f1) {
      fineBest = { threshold: t, f1: m.f1 };
    }
  }

  if (Math.abs(fineBest.threshold - bestF1.threshold) > 0.001) {
    console.log(`  Refined best:      ${fineBest.threshold.toFixed(2)} (F1 = ${formatPercent(fineBest.f1)})`);
  }

  const fineMetrics = computeMetrics(pairs, fineBest.threshold);
  console.log(`    Precision: ${formatPercent(fineMetrics.precision)}`);
  console.log(`    Recall:    ${formatPercent(fineMetrics.recall)}`);
  console.log();

  // Exit code based on F1 quality
  if (fineMetrics.f1 >= 0.8) {
    console.log('  ✓ RAG pipeline quality: GOOD (F1 >= 80%)');
  } else if (fineMetrics.f1 >= 0.6) {
    console.log('  ~ RAG pipeline quality: ACCEPTABLE (F1 >= 60%)');
  } else {
    console.log('  ✗ RAG pipeline quality: NEEDS IMPROVEMENT (F1 < 60%)');
    process.exitCode = 1;
  }

  console.log();
}

main().catch((err) => {
  console.error('Evaluation failed:', err);
  process.exitCode = 1;
});
