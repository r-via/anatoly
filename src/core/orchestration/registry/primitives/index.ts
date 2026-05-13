// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Remi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { PrimitiveEntry } from './types.js';

// Axis primitives (8)
import { axesUtility } from './axes/utility.js';
import { axesDuplication } from './axes/duplication.js';
import { axesCorrectionPass1 } from './axes/correction-pass1.js';
import { axesCorrectionVerify } from './axes/correction-verify.js';
import { axesOverengineering } from './axes/overengineering.js';
import { axesTests } from './axes/tests.js';
import { axesBestPractices } from './axes/best-practices.js';
import { axesDocumentation } from './axes/documentation.js';

// RAG primitives (2)
import { ragNlpSummary } from './rag/nlp-summary.js';
import { ragDocChunk } from './rag/doc-chunk.js';

// Agentic primitives (4)
import { agentsDocConflictDetector } from './agents/doc-conflict-detector.js';
import { agentsDocGenerator } from './agents/doc-generator.js';
import { agentsTier3Deliberator } from './agents/tier3-deliberator.js';
import { agentsVercelAgent } from './agents/vercel-agent.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const entries: PrimitiveEntry[] = [
  // Axes
  axesUtility,
  axesDuplication,
  axesCorrectionPass1,
  axesCorrectionVerify,
  axesOverengineering,
  axesTests,
  axesBestPractices,
  axesDocumentation,
  // RAG
  ragNlpSummary,
  ragDocChunk,
  // Agents
  agentsDocConflictDetector,
  agentsDocGenerator,
  agentsTier3Deliberator,
  agentsVercelAgent,
];

/**
 * Registry of all named LLM/agent primitives with their four-block contract.
 * Each entry declares response, dump, log, and cost behavior in one place.
 */
export const PRIMITIVES: ReadonlyMap<string, PrimitiveEntry> = new Map(
  entries.map((e) => [e.name, e]),
);
