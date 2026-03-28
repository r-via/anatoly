// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { get_encoding } from 'tiktoken';
import { TaskSchema, type Task } from '../schemas/task.js';

const SYSTEM_PROMPT_TOKENS = 600;
const PER_FILE_OVERHEAD_TOKENS = 50;
const OUTPUT_TOKENS_PER_SYMBOL = 150;
const OUTPUT_BASE_PER_FILE = 300;

/**
 * Weighted time estimation constants (axis pipeline).
 * BASE_SECONDS covers fixed overhead (file read, prompt assembly, RAG pre-resolution).
 * SECONDS_PER_SYMBOL accounts for LLM output tokens scaling with symbol count.
 * A file with 5 symbols ≈ 8s, a file with 20 symbols ≈ 20s.
 */
export const BASE_SECONDS = 4;
export const SECONDS_PER_SYMBOL = 0.8;

/**
 * Compute the estimated seconds for a single file based on its symbol count.
 */
export function estimateFileSeconds(symbolCount: number): number {
  return BASE_SECONDS + symbolCount * SECONDS_PER_SYMBOL;
}

/**
 * Load all .task.json files from the tasks directory.
 */
export function loadTasks(projectRoot: string): Task[] {
  const tasksDir = resolve(projectRoot, '.anatoly', 'tasks');
  if (!existsSync(tasksDir)) return [];

  const entries = readdirSync(tasksDir).filter((f) => f.endsWith('.task.json'));
  const tasks: Task[] = [];

  for (const entry of entries) {
    try {
      const raw = readFileSync(join(tasksDir, entry), 'utf-8');
      tasks.push(TaskSchema.parse(JSON.parse(raw)));
    } catch {
      // Skip unreadable task files
    }
  }

  return tasks;
}

/**
 * Count tokens in a string using cl100k_base encoding (Claude-compatible).
 */
export function countTokens(text: string): number {
  const enc = get_encoding('cl100k_base');
  try {
    return enc.encode(text).length;
  } finally {
    enc.free();
  }
}

/**
 * Estimate token usage for a given set of tasks.
 * Reads actual file content to get accurate input token counts via
 * cl100k_base encoding. When a file cannot be read (e.g. deleted since
 * scan), falls back to a heuristic based on symbol line ranges
 * (`(line_end - line_start + 1) * 8` tokens per symbol).
 *
 * Token accounting per task:
 * - **input** = `SYSTEM_PROMPT_TOKENS` + actual file tokens + `PER_FILE_OVERHEAD_TOKENS`
 * - **output** = `OUTPUT_BASE_PER_FILE` + symbol count * `OUTPUT_TOKENS_PER_SYMBOL`
 *
 * @param projectRoot - Absolute path to the project root for resolving task file paths.
 * @param tasks - Array of scanned Task objects whose files will be token-counted.
 * @returns An object with `inputTokens` (estimated prompt tokens across all tasks),
 *   `outputTokens` (estimated completion tokens), and `symbols` (total symbol count).
 */
export function estimateTasksTokens(
  projectRoot: string,
  tasks: Task[],
): { inputTokens: number; outputTokens: number; symbols: number } {
  if (tasks.length === 0) return { inputTokens: 0, outputTokens: 0, symbols: 0 };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalSymbols = 0;

  const enc = get_encoding('cl100k_base');

  try {
    for (const task of tasks) {
      const absPath = resolve(projectRoot, task.file);
      let fileTokens = 0;

      try {
        const content = readFileSync(absPath, 'utf-8');
        fileTokens = enc.encode(content).length;
      } catch {
        // File may have been deleted since scan; estimate from symbols
        fileTokens = task.symbols.reduce(
          (sum, s) => sum + (s.line_end - s.line_start + 1) * 8,
          0,
        );
      }

      const symbolCount = task.symbols.length;
      totalSymbols += symbolCount;

      // Input: system prompt + file content + per-file overhead
      totalInputTokens += SYSTEM_PROMPT_TOKENS + fileTokens + PER_FILE_OVERHEAD_TOKENS;

      // Output: base per file + per-symbol review
      totalOutputTokens += OUTPUT_BASE_PER_FILE + symbolCount * OUTPUT_TOKENS_PER_SYMBOL;
    }
  } finally {
    enc.free();
  }

  return { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, symbols: totalSymbols };
}

/**
 * Format a token count for display (e.g., 1200000 → "~1.2M", 340000 → "~340K").
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `~${millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = Math.round(count / 1_000);
    return `~${thousands}K`;
  }
  return `~${count}`;
}
