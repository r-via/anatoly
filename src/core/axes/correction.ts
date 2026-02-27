import { z } from 'zod';
import type { AxisContext, AxisResult, AxisEvaluator, AxisSymbolResult } from '../axis-evaluator.js';
import { runSingleTurnQuery, resolveAxisModel } from '../axis-evaluator.js';
import type { Action } from '../../schemas/review.js';
import { readLocalPackageReadme } from '../dependency-meta.js';
import correctionSystemPrompt from './prompts/correction.system.md';
import { formatMemoryForPrompt, recordFalsePositive } from '../correction-memory.js';

// ---------------------------------------------------------------------------
// Zod schema for LLM response (correction axis only)
// ---------------------------------------------------------------------------

const CorrectionSymbolSchema = z.object({
  name: z.string(),
  line_start: z.int().min(1),
  line_end: z.int().min(1),
  correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
  confidence: z.int().min(0).max(100),
  detail: z.string().min(10),
});

const CorrectionActionSchema = z.object({
  description: z.string(),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  line: z.int().min(1).optional(),
});

const CorrectionResponseSchema = z.object({
  symbols: z.array(CorrectionSymbolSchema),
  actions: z.array(CorrectionActionSchema).default([]),
});

type CorrectionResponse = z.infer<typeof CorrectionResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildCorrectionSystemPrompt(): string {
  return correctionSystemPrompt.trimEnd();
}

export function buildCorrectionUserMessage(ctx: AxisContext): string {
  const parts: string[] = [];

  parts.push(`## File: \`${ctx.task.file}\``);
  parts.push('');
  parts.push('```typescript');
  parts.push(ctx.fileContent);
  parts.push('```');
  parts.push('');

  parts.push('## Symbols to evaluate');
  parts.push('');
  for (const s of ctx.task.symbols) {
    parts.push(`- ${s.exported ? 'export ' : ''}${s.kind} ${s.name} (L${s.line_start}–L${s.line_end})`);
  }
  parts.push('');

  if (ctx.fileDeps && ctx.fileDeps.deps.length > 0) {
    parts.push('## Project Dependencies (imported in this file)');
    parts.push('');
    for (const dep of ctx.fileDeps.deps) {
      parts.push(`- ${dep.name}: ${dep.version}`);
    }
    if (ctx.fileDeps.nodeEngine) {
      parts.push(`- Node.js engine: ${ctx.fileDeps.nodeEngine}`);
    }
    parts.push('');
  }

  parts.push('Identify any bugs, logic errors, or correctness issues and output the JSON.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Verification pass (two-pass correction)
// ---------------------------------------------------------------------------

const VerificationSymbolSchema = z.object({
  name: z.string(),
  original_correction: z.enum(['NEEDS_FIX', 'ERROR']),
  verified_correction: z.enum(['OK', 'NEEDS_FIX', 'ERROR']),
  confidence: z.int().min(0).max(100),
  reason: z.string().min(10),
});

const VerificationResponseSchema = z.object({
  symbols: z.array(VerificationSymbolSchema),
});

type VerificationResponse = z.infer<typeof VerificationResponseSchema>;

function buildVerificationSystemPrompt(): string {
  return `You are Anatoly's verification agent. Your role is to RE-EVALUATE correction findings using actual library documentation.

## Context

A previous pass flagged certain symbols as NEEDS_FIX or ERROR. You are given:
1. The original findings (symbol name, correction rating, detail)
2. The actual README documentation of the relevant libraries

## Your task

For EACH flagged symbol, verify whether the finding is a real bug or a false positive by checking the library documentation.

## Rules

1. If the library documentation confirms the finding is valid → keep the original correction and confidence.
2. If the library documentation shows the library handles this case natively → change to OK with confidence 95 and explain why.
3. If the documentation is ambiguous → keep the original correction but lower confidence by 20 points.
4. Be precise: cite the specific section of the documentation that supports your decision.

## Output format

Output ONLY a JSON object:

\`\`\`json
{
  "symbols": [
    {
      "name": "symbolName",
      "original_correction": "NEEDS_FIX",
      "verified_correction": "OK | NEEDS_FIX | ERROR",
      "confidence": 95,
      "reason": "Explanation with documentation reference (min 10 chars)"
    }
  ]
}
\`\`\``;
}

function buildVerificationUserMessage(
  findings: CorrectionResponse,
  ctx: AxisContext,
): string {
  const parts: string[] = [];

  // Include the flagged findings
  const flagged = findings.symbols.filter(
    (s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR',
  );

  parts.push('## Findings to verify');
  parts.push('');
  for (const s of flagged) {
    parts.push(`### \`${s.name}\` — ${s.correction} (confidence: ${s.confidence}%)`);
    parts.push(`Detail: ${s.detail}`);
    parts.push('');
  }

  // Include original source code for reference
  parts.push(`## Source: \`${ctx.task.file}\``);
  parts.push('');
  parts.push('```typescript');
  parts.push(ctx.fileContent);
  parts.push('```');
  parts.push('');

  // Include README documentation for each dependency
  if (ctx.fileDeps && ctx.fileDeps.deps.length > 0) {
    parts.push('## Library Documentation');
    parts.push('');
    for (const dep of ctx.fileDeps.deps) {
      const readme = readLocalPackageReadme(ctx.projectRoot, dep.name);
      if (readme) {
        parts.push(`### ${dep.name}@${dep.version}`);
        parts.push('');
        parts.push(readme);
        parts.push('');
      }
    }
  }

  parts.push('Verify each finding against the documentation and output the JSON.');

  return parts.join('\n');
}

/**
 * Detect which findings might be dependency-related and need verification.
 */
function findingsNeedVerification(
  findings: CorrectionResponse,
  ctx: AxisContext,
): boolean {
  if (!ctx.fileDeps || ctx.fileDeps.deps.length === 0) return false;

  return findings.symbols.some(
    (s) => s.correction === 'NEEDS_FIX' || s.correction === 'ERROR',
  );
}

/**
 * Apply verification results: override pass 1 findings with pass 2 verdicts.
 * Records false positives in the correction memory for future runs.
 */
function applyVerification(
  pass1: CorrectionResponse,
  verification: VerificationResponse,
  ctx: AxisContext,
): CorrectionResponse {
  const verifiedMap = new Map(
    verification.symbols.map((v) => [v.name, v]),
  );

  const updatedSymbols = pass1.symbols.map((sym) => {
    const v = verifiedMap.get(sym.name);
    if (!v) return sym;

    // If verification changed the verdict (e.g. NEEDS_FIX → OK)
    if (v.verified_correction !== v.original_correction) {
      // Record as false positive for future runs
      const depName = detectImplicatedDep(sym.detail, ctx.fileDeps);
      recordFalsePositive(ctx.projectRoot, {
        pattern: summarizePattern(sym.detail),
        dependency: depName,
        original_detail: sym.detail,
        reason: v.reason,
      });

      return {
        ...sym,
        correction: v.verified_correction as 'OK' | 'NEEDS_FIX' | 'ERROR',
        confidence: v.confidence,
        detail: `${v.reason} (verified against documentation)`,
      };
    }

    // Verification confirmed the finding — update confidence
    return { ...sym, confidence: v.confidence };
  });

  // Remove actions whose line falls within a now-OK symbol's range
  const okRanges = updatedSymbols
    .filter((s) => s.correction === 'OK')
    .map((s) => ({ start: s.line_start, end: s.line_end }));

  const filteredActions = pass1.actions.filter((a) => {
    if (!a.line) return true; // No line info → keep conservatively
    return !okRanges.some((r) => a.line! >= r.start && a.line! <= r.end);
  });

  return { symbols: updatedSymbols, actions: filteredActions };
}

/**
 * Detect which dependency is implicated in a finding detail.
 */
function detectImplicatedDep(
  detail: string,
  fileDeps?: { deps: Array<{ name: string; version: string }> },
): string | undefined {
  if (!fileDeps) return undefined;
  const lower = detail.toLowerCase();
  for (const dep of fileDeps.deps) {
    if (lower.includes(dep.name.toLowerCase())) return dep.name;
  }
  return undefined;
}

/**
 * Summarize a finding detail into a short pattern string for memory deduplication.
 */
function summarizePattern(detail: string): string {
  // Take the first sentence or first 100 chars
  const firstSentence = detail.split(/\.\s/)[0];
  return firstSentence.length > 120
    ? firstSentence.slice(0, 120) + '...'
    : firstSentence;
}

// ---------------------------------------------------------------------------
// Evaluator class
// ---------------------------------------------------------------------------

export class CorrectionEvaluator implements AxisEvaluator {
  readonly id = 'correction' as const;
  readonly defaultModel = 'sonnet' as const;

  async evaluate(ctx: AxisContext, abortController: AbortController): Promise<AxisResult> {
    const model = resolveAxisModel(this, ctx.config);
    const systemPrompt = buildCorrectionSystemPrompt();
    let userMessage = buildCorrectionUserMessage(ctx);

    // Inject known false positives from memory into the prompt
    const depNames = ctx.fileDeps?.deps.map((d) => d.name);
    const memorySection = formatMemoryForPrompt(ctx.projectRoot, depNames);
    if (memorySection) {
      userMessage += '\n' + memorySection;
    }

    // --- Pass 1: standard correction ---
    const pass1 = await runSingleTurnQuery<CorrectionResponse>(
      {
        systemPrompt,
        userMessage,
        model,
        projectRoot: ctx.projectRoot,
        abortController,
      },
      CorrectionResponseSchema,
    );

    let finalData = pass1.data;
    let totalCost = pass1.costUsd;
    let totalDuration = pass1.durationMs;
    let transcript = pass1.transcript;

    // --- Pass 2: verify dependency-related findings against README ---
    if (findingsNeedVerification(pass1.data, ctx)) {
      try {
        const verifyPrompt = buildVerificationSystemPrompt();
        const verifyMessage = buildVerificationUserMessage(pass1.data, ctx);

        const pass2 = await runSingleTurnQuery<VerificationResponse>(
          {
            systemPrompt: verifyPrompt,
            userMessage: verifyMessage,
            model,
            projectRoot: ctx.projectRoot,
            abortController,
          },
          VerificationResponseSchema,
        );

        totalCost += pass2.costUsd;
        totalDuration += pass2.durationMs;
        transcript += '\n\n---\n\n## Verification Pass\n\n' + pass2.transcript;

        // Apply verification results to pass 1 data
        finalData = applyVerification(pass1.data, pass2.data, ctx);
      } catch {
        // Verification pass failed — keep pass 1 results as-is
        transcript += '\n\n---\n\n## Verification Pass — FAILED (keeping pass 1 results)\n';
      }
    }

    const symbols: AxisSymbolResult[] = finalData.symbols.map((s) => ({
      name: s.name,
      line_start: s.line_start,
      line_end: s.line_end,
      value: s.correction,
      confidence: s.confidence,
      detail: s.detail,
    }));

    const severityMap: Record<string, 'high' | 'medium' | 'low'> = {
      CRITICAL: 'high',
      MAJOR: 'medium',
      MINOR: 'low',
    };

    const actions: Action[] = finalData.actions.map((a, i) => ({
      id: i + 1,
      description: a.description,
      severity: severityMap[a.severity] ?? 'medium',
      effort: 'small' as const,
      category: 'quickwin' as const,
      target_symbol: null,
      target_lines: a.line ? `L${a.line}` : null,
    }));

    return {
      axisId: 'correction',
      symbols,
      actions,
      costUsd: totalCost,
      durationMs: totalDuration,
      transcript,
    };
  }
}
