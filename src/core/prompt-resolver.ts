// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import utilityPrompt from '../prompts/axes/utility.system.md';
import bestPracticesPrompt from '../prompts/axes/best-practices.system.md';
import documentationPrompt from '../prompts/axes/documentation.system.md';
import correctionPrompt from '../prompts/axes/correction.system.md';
import duplicationPrompt from '../prompts/axes/duplication.system.md';
import testsPrompt from '../prompts/axes/tests.system.md';
import overengineeringPrompt from '../prompts/axes/overengineering.system.md';
import bestPracticesBashPrompt from '../prompts/axes/best-practices.bash.system.md';
import bestPracticesPythonPrompt from '../prompts/axes/best-practices.python.system.md';
import bestPracticesRustPrompt from '../prompts/axes/best-practices.rust.system.md';
import bestPracticesGoPrompt from '../prompts/axes/best-practices.go.system.md';
import bestPracticesJavaPrompt from '../prompts/axes/best-practices.java.system.md';
import bestPracticesCsharpPrompt from '../prompts/axes/best-practices.csharp.system.md';
import bestPracticesSqlPrompt from '../prompts/axes/best-practices.sql.system.md';
import bestPracticesYamlPrompt from '../prompts/axes/best-practices.yaml.system.md';
import bestPracticesJsonPrompt from '../prompts/axes/best-practices.json.system.md';
import docBashPrompt from '../prompts/axes/documentation.bash.system.md';
import docPythonPrompt from '../prompts/axes/documentation.python.system.md';
import docRustPrompt from '../prompts/axes/documentation.rust.system.md';
import docGoPrompt from '../prompts/axes/documentation.go.system.md';
import docJavaPrompt from '../prompts/axes/documentation.java.system.md';
import docCsharpPrompt from '../prompts/axes/documentation.csharp.system.md';
import docSqlPrompt from '../prompts/axes/documentation.sql.system.md';
import docYamlPrompt from '../prompts/axes/documentation.yaml.system.md';
import bpReactPrompt from '../prompts/axes/best-practices.react.system.md';
import bpNextjsPrompt from '../prompts/axes/best-practices.nextjs.system.md';
import docReactPrompt from '../prompts/axes/documentation.react.system.md';
import docNextjsPrompt from '../prompts/axes/documentation.nextjs.system.md';
import correctionVerificationPrompt from '../prompts/axes/correction.verification.system.md';
import deliberationPrompt from '../prompts/deliberation/deliberation.system.md';
import docWriterPrompt from '../prompts/doc-generation/doc-writer.system.md';
import docWriterArchPrompt from '../prompts/doc-generation/doc-writer.architecture.system.md';
import docWriterApiPrompt from '../prompts/doc-generation/doc-writer.api-reference.system.md';
import sectionRefinerPrompt from '../prompts/rag/section-refiner.system.md';
import nlpSummarizerPrompt from '../prompts/rag/nlp-summarizer.system.md';
import jsonEvaluatorWrapperPrompt from '../prompts/_shared/json-evaluator-wrapper.system.md';

/** Registry of system prompts keyed by domain, axis, or composite key */
const PROMPT_REGISTRY = new Map<string, string>();

function registerDefaults(): void {
  // --- Axes (7 defaults + language/framework variants) ---
  register('utility', utilityPrompt);
  register('best_practices', bestPracticesPrompt);
  register('documentation', documentationPrompt);
  register('correction', correctionPrompt);
  register('duplication', duplicationPrompt);
  register('tests', testsPrompt);
  register('overengineering', overengineeringPrompt);
  register('best_practices.bash', bestPracticesBashPrompt);
  register('best_practices.python', bestPracticesPythonPrompt);
  register('best_practices.rust', bestPracticesRustPrompt);
  register('best_practices.go', bestPracticesGoPrompt);
  register('best_practices.java', bestPracticesJavaPrompt);
  register('best_practices.csharp', bestPracticesCsharpPrompt);
  register('best_practices.sql', bestPracticesSqlPrompt);
  register('best_practices.yaml', bestPracticesYamlPrompt);
  register('best_practices.json', bestPracticesJsonPrompt);
  register('documentation.bash', docBashPrompt);
  register('documentation.python', docPythonPrompt);
  register('documentation.rust', docRustPrompt);
  register('documentation.go', docGoPrompt);
  register('documentation.java', docJavaPrompt);
  register('documentation.csharp', docCsharpPrompt);
  register('documentation.sql', docSqlPrompt);
  register('documentation.yaml', docYamlPrompt);
  register('best_practices.react', bpReactPrompt);
  register('best_practices.nextjs', bpNextjsPrompt);
  register('documentation.react', docReactPrompt);
  register('documentation.nextjs', docNextjsPrompt);
  register('correction.verification', correctionVerificationPrompt);

  // --- Deliberation ---
  register('deliberation', deliberationPrompt);

  // --- Doc generation ---
  register('doc-generation', docWriterPrompt);
  register('doc-generation.architecture', docWriterArchPrompt);
  register('doc-generation.api-reference', docWriterApiPrompt);

  // --- RAG ---
  register('rag.section-refiner', sectionRefinerPrompt);
  register('rag.nlp-summarizer', nlpSummarizerPrompt);

  // --- Shared ---
  register('_shared.json-evaluator-wrapper', jsonEvaluatorWrapperPrompt);
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

/** For tests only — return sorted registry keys. */
export function _getRegistryKeys(): string[] {
  return [...PROMPT_REGISTRY.keys()].sort();
}
