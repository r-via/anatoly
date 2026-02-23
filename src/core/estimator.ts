import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { get_encoding } from 'tiktoken';
import type { Task } from '../schemas/task.js';

const SYSTEM_PROMPT_TOKENS = 600;
const PER_FILE_OVERHEAD_TOKENS = 50;
const OUTPUT_TOKENS_PER_SYMBOL = 150;
const OUTPUT_BASE_PER_FILE = 300;
const SECONDS_PER_FILE = 45;

export interface EstimateResult {
  files: number;
  symbols: number;
  inputTokens: number;
  outputTokens: number;
  estimatedMinutes: number;
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
      tasks.push(JSON.parse(raw) as Task);
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
 * Estimate token usage and time for reviewing all scanned files.
 * Reads actual file content to get accurate input token counts.
 */
export function estimateProject(projectRoot: string): EstimateResult {
  const tasks = loadTasks(projectRoot);

  if (tasks.length === 0) {
    return { files: 0, symbols: 0, inputTokens: 0, outputTokens: 0, estimatedMinutes: 0 };
  }

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

  const estimatedMinutes = Math.ceil((tasks.length * SECONDS_PER_FILE) / 60);

  return {
    files: tasks.length,
    symbols: totalSymbols,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    estimatedMinutes,
  };
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
