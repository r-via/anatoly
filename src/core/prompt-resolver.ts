// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import utilityPrompt from './axes/prompts/utility.system.md';
import bestPracticesPrompt from './axes/prompts/best-practices.system.md';
import documentationPrompt from './axes/prompts/documentation.system.md';
import correctionPrompt from './axes/prompts/correction.system.md';
import duplicationPrompt from './axes/prompts/duplication.system.md';
import testsPrompt from './axes/prompts/tests.system.md';
import overengineeringPrompt from './axes/prompts/overengineering.system.md';

/** Registry of system prompts keyed by "{axisId}" or "{axisId}.{language}" or "{axisId}.{framework}" */
const PROMPT_REGISTRY = new Map<string, string>();

function registerDefaults(): void {
  register('utility', utilityPrompt);
  register('best_practices', bestPracticesPrompt);
  register('documentation', documentationPrompt);
  register('correction', correctionPrompt);
  register('duplication', duplicationPrompt);
  register('tests', testsPrompt);
  register('overengineering', overengineeringPrompt);
}

function register(key: string, content: string): void {
  PROMPT_REGISTRY.set(key, content.trimEnd());
}

// Auto-register defaults on module load
registerDefaults();

/** Register a language or framework-specific system prompt. */
export function registerPrompt(key: string, content: string): void {
  register(key, content);
}

/**
 * Resolve the most specific system prompt for an axis.
 * Cascade order: framework → language → default.
 * Returns the prompt content string of the first match.
 */
export function resolveSystemPrompt(
  axisId: string,
  language?: string,
  framework?: string,
): string {
  if (framework) {
    const fwPrompt = PROMPT_REGISTRY.get(`${axisId}.${framework}`);
    if (fwPrompt) return fwPrompt;
  }
  if (language) {
    const langPrompt = PROMPT_REGISTRY.get(`${axisId}.${language}`);
    if (langPrompt) return langPrompt;
  }
  const defaultPrompt = PROMPT_REGISTRY.get(axisId);
  if (!defaultPrompt) {
    throw new Error(`No system prompt found for axis: ${axisId}`);
  }
  return defaultPrompt;
}

/** For tests only — clear the prompt registry. */
export function _clearPromptRegistry(): void {
  PROMPT_REGISTRY.clear();
}

/** For tests only — re-register all default prompts. */
export function _resetPromptRegistry(): void {
  PROMPT_REGISTRY.clear();
  registerDefaults();
}
