// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { generateText } from 'ai';
import { getVercelModel } from '../transports/vercel-sdk-transport.js';
import { createBashTool } from '../tools/bash-tool.js';
import { getSearchTool } from '../tools/web-search.js';
import { calculateCost } from '../../utils/cost-calculator.js';
import type { Config } from '../../schemas/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VercelAgentParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  projectRoot: string;
  config: Config;
  abortController: AbortController;
  /** Maximum agentic steps (default: 20). */
  maxSteps?: number;
  /** Allow bash tool write operations (default: false). */
  allowWrite?: boolean;
  /** Include web search tool if configured (default: false). */
  allowSearch?: boolean;
}

export interface VercelAgentResult {
  text: string;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an agentic loop using Vercel AI SDK's `generateText` with tool use.
 *
 * The agent has access to:
 * - **bash**: Execute bash commands (read-only by default)
 * - **web_search**: Search the web (optional, depends on config + allowSearch)
 *
 * Uses `maxSteps` to control the maximum number of tool-use iterations.
 */
export async function runVercelAgent(params: VercelAgentParams): Promise<VercelAgentResult> {
  const {
    systemPrompt,
    userMessage,
    model: modelId,
    projectRoot,
    config,
    abortController,
    maxSteps = 20,
    allowWrite = false,
    allowSearch = false,
  } = params;

  const start = Date.now();

  // Resolve model
  const model = getVercelModel(modelId, config);

  // Build tools
  const tools: Record<string, unknown> = {
    bash: createBashTool({ allowWrite, cwd: projectRoot }),
  };

  // Optionally add web search tool
  if (allowSearch) {
    const searchTool = getSearchTool(config);
    if (searchTool) {
      tools.web_search = searchTool;
    }
  }

  const result = await generateText({
    model,
    system: systemPrompt,
    prompt: userMessage,
    tools,
    maxSteps,
    abortSignal: abortController.signal,
  });

  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  const durationMs = Date.now() - start;
  const costUsd = calculateCost(modelId, inputTokens, outputTokens);

  return {
    text: result.text ?? '',
    costUsd,
    durationMs,
    inputTokens,
    outputTokens,
  };
}
