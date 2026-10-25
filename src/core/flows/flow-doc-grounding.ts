// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Skeleton-grounding context provider for the user-flow page (doc 23, Stage 2).
 *
 * Pure, deterministic rendering of the `UserFlow` artifact into the grounding
 * text the doc-pipeline narrator reads, plus the `{ system, user, model }`
 * prompt the `flow-doc` phase feeds to the agentic Read-only doc writer (I6 —
 * no new transport). It carries NO LLM and NO I/O: same flows in, byte-identical
 * grounding out (I2). The narrator never invents purpose — the grounding is the
 * literal skeleton (entry, ordered steps, terminal effects, confidence, unwired
 * flag) and the writer's system prompt forbids asserting what the code SHOULD do
 * (I3).
 *
 * Conservative caps (I5): a page narrates at most `maxFlows` flows (highest
 * confidence first) and lists at most `maxStepsPerFlow` steps per flow; any
 * truncation is surfaced in the grounding so the narrator can state how many
 * were omitted rather than silently dropping them.
 */

import { anatolyPath } from '../../utils/anatoly-paths.js';
import { DEFAULT_MODEL_IDS, resolveSystemPrompt } from '../platform/index.js';
import type { UserFlow } from '../../schemas/user-flow.js';

/** The well-known narrated-page filename under `.anatoly/state/internal-flows/`. */
export const FLOW_DOC_PAGE_FILENAME = 'user-flows.md';

/** Resolve the canonical narrated-page path for a project root. */
export function flowDocPagePath(projectRoot: string): string {
  return anatolyPath(projectRoot, 'state/internal-flows', FLOW_DOC_PAGE_FILENAME);
}

/** Conservative page caps (doc 23 invariant I5). */
export interface FlowDocCaps {
  /** Max flows narrated on one page (highest confidence first). */
  maxFlows: number;
  /** Max steps listed per flow before the tail is summarised. */
  maxStepsPerFlow: number;
}

export const DEFAULT_FLOW_DOC_CAPS: FlowDocCaps = {
  maxFlows: 12,
  maxStepsPerFlow: 40,
};

/** Stable confidence-desc, id-asc ordering so the grounding is deterministic. */
function sortFlows(flows: readonly UserFlow[]): UserFlow[] {
  return [...flows].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Render one flow's literal skeleton facts as an indented block. */
function renderFlow(flow: UserFlow, caps: FlowDocCaps): string {
  const lines: string[] = [];
  lines.push(`### Flow: ${flow.name}`);
  lines.push(`- id: ${flow.id}`);
  lines.push(`- finality (literal, from the entry card): ${flow.finality}`);
  lines.push(`- entry: ${flow.entry.file}::${flow.entry.symbol} (kind: ${flow.entry.kind})`);

  if (flow.steps.length === 0) {
    lines.push('- steps: none beyond the entry symbol');
  } else {
    const shown = flow.steps.slice(0, caps.maxStepsPerFlow);
    lines.push(`- steps (${flow.steps.length}, in traversal order):`);
    shown.forEach((step, i) => {
      lines.push(`  ${i + 1}. ${step.file}::${step.symbol} [${step.role}]`);
    });
    if (flow.steps.length > shown.length) {
      lines.push(`  ... ${flow.steps.length - shown.length} further step(s) omitted (step cap)`);
    }
  }

  if (flow.effects.length === 0) {
    lines.push('- terminal effects: none reached (UNWIRED candidate)');
  } else {
    lines.push(`- terminal effects (${flow.effects.length}):`);
    for (const effect of flow.effects) {
      lines.push(`  - ${effect.file}::${effect.symbol} (kind: ${effect.kind})`);
    }
  }

  lines.push(`- resolution confidence: ${flow.confidence}/100`);
  lines.push(`- unwired (entry resolved, no terminal effect): ${flow.unwired ? 'yes' : 'no'}`);
  return lines.join('\n');
}

/**
 * Render the deterministic grounding text for the narrator. Sorts by confidence
 * (desc) then id (asc), caps the flow count, and surfaces any truncation so the
 * narrator can state how many flows were omitted (never silently dropped).
 * Returns an empty string for an empty artifact (the caller skips generation).
 */
export function buildFlowGrounding(
  flows: readonly UserFlow[],
  caps: FlowDocCaps = DEFAULT_FLOW_DOC_CAPS,
): string {
  if (flows.length === 0) return '';

  const sorted = sortFlows(flows);
  const shown = sorted.slice(0, caps.maxFlows);
  const omitted = sorted.length - shown.length;

  const header: string[] = [
    `# User-flow skeleton (deterministic, machine-derived)`,
    '',
    `${sorted.length} flow(s) were modeled from the code's reference graph.`,
  ];
  if (omitted > 0) {
    header.push(
      `Showing ${shown.length} of ${sorted.length} flows (highest confidence first); ` +
        `${omitted} omitted. Narrate the shown flows and state that ${omitted} more were omitted.`,
    );
  }
  header.push(
    '',
    'Each flow below is the literal skeleton. Narrate exactly these facts. Do NOT',
    'invent a purpose, requirement, or intent the skeleton does not carry.',
    '',
  );

  const body = shown.map((flow) => renderFlow(flow, caps)).join('\n\n');
  return `${header.join('\n')}\n${body}\n`;
}

/** The prompt handed to the agentic Read-only doc writer (I6). */
export interface FlowDocPrompt {
  system: string;
  user: string;
  model: string;
}

/** Options for {@link buildFlowDocPrompt}. */
export interface BuildFlowDocPromptOptions {
  caps?: FlowDocCaps;
  /** Override the writer model (default: the quality-tier default). */
  model?: string;
}

/**
 * Build the `{ system, user, model }` prompt for the flow-doc narrator, or
 * `null` when there are no flows to narrate (the phase then writes nothing).
 * The system prompt is the registered flow doc-writer (`doc-generation.flow`);
 * the user message is the deterministic grounding.
 */
export function buildFlowDocPrompt(
  flows: readonly UserFlow[],
  opts: BuildFlowDocPromptOptions = {},
): FlowDocPrompt | null {
  if (flows.length === 0) return null;
  const grounding = buildFlowGrounding(flows, opts.caps ?? DEFAULT_FLOW_DOC_CAPS);
  if (grounding.length === 0) return null;
  return {
    system: resolveSystemPrompt('doc-generation.flow'),
    user: grounding,
    model: opts.model ?? DEFAULT_MODEL_IDS.quality,
  };
}
