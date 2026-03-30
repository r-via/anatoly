// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AxisId } from '../core/axis-evaluator.js';
import { ALL_AXIS_IDS } from '../core/axes/index.js';
import { getLogger } from './logger.js';

export const ANATOLY_MD_FILENAME = 'ANATOLY.md';

const RECOGNIZED_SECTIONS = new Set<string>(['general', ...ALL_AXIS_IDS]);

const TOKEN_WARN_THRESHOLD = 8_000; // ~2000 tokens

export interface UserInstructions {
  /** True when ANATOLY.md exists and has at least one recognized H2 section. */
  readonly hasInstructions: boolean;
  /** Normalized keys of all recognized sections found in ANATOLY.md. */
  readonly recognizedSections: readonly string[];
  /** Returns General + axis-specific content, or undefined if nothing applies. */
  forAxis(axisId: AxisId): string | undefined;
}

const EMPTY: UserInstructions = {
  hasInstructions: false,
  recognizedSections: [],
  forAxis: () => undefined,
};

/**
 * Normalize a Markdown H2 heading into a section key.
 * "Best Practices" → "best_practices", "CORRECTION" → "correction"
 */
function normalizeSection(heading: string): string {
  return heading.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Parse ANATOLY.md content into a map of normalized section keys → content.
 */
function parseSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = raw.split(/^## /m);

  for (const part of parts) {
    const nlIndex = part.indexOf('\n');
    if (nlIndex === -1) continue;

    const heading = part.slice(0, nlIndex).trim();
    if (!heading) continue;

    const body = part.slice(nlIndex + 1).trim();
    const key = normalizeSection(heading);
    sections.set(key, body);
  }

  return sections;
}

/**
 * Load and parse user instructions from ANATOLY.md at the project root.
 * Returns a safe UserInstructions object — never throws.
 */
export function loadUserInstructions(projectRoot: string): UserInstructions {
  const filePath = resolve(projectRoot, ANATOLY_MD_FILENAME);

  if (!existsSync(filePath)) return EMPTY;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return EMPTY;
  }

  const allSections = parseSections(raw);

  // Separate recognized from ignored
  const recognized = new Map<string, string>();
  const ignored: string[] = [];

  for (const [key, content] of allSections) {
    if (RECOGNIZED_SECTIONS.has(key)) {
      recognized.set(key, content);
    } else {
      ignored.push(key);
    }
  }

  if (recognized.size === 0) return EMPTY;

  // Log recognized/ignored sections
  const log = getLogger();
  const recognizedKeys = [...recognized.keys()];
  log.info(
    { event: 'user_instructions_loaded', recognized: recognizedKeys, ignored },
    `Loaded user instructions from ${ANATOLY_MD_FILENAME} (sections: ${recognizedKeys.join(', ')})`,
  );

  if (ignored.length > 0) {
    log.info(
      { event: 'user_instructions_ignored_sections', ignored },
      `Ignored unrecognized sections in ${ANATOLY_MD_FILENAME}: ${ignored.join(', ')}`,
    );
  }

  // Warn on long sections
  for (const [key, content] of recognized) {
    if (content.length > TOKEN_WARN_THRESHOLD) {
      const approxTokens = Math.ceil(content.length / 4);
      log.warn(
        { event: 'user_instructions_long_section', section: key, chars: content.length, approxTokens },
        `ANATOLY.md section "${key}" is very long (~${approxTokens} tokens). Long sections may dilute scoring accuracy.`,
      );
    }
  }

  // Warn when file/module exclusion language appears in prompt sections.
  // Match "skip X entirely", "skip X/", "ignore X/", "exclude X/" where X looks like a path or module.
  // Do NOT match calibration language like "do not flag X as Y" — that's legitimate prompt tuning.
  const exclusionPattern = /\b(skip\b.{0,30}\b(entirely|completely|module|directory|folder|file)|(?:ignore|exclude)\s+\S+\/)/i;
  for (const [key, content] of recognized) {
    if (exclusionPattern.test(content)) {
      log.warn(
        { event: 'user_instructions_exclusion_language', section: key },
        `ANATOLY.md section "${key}" contains file/module exclusion language. ` +
        `For deterministic exclusion, use scan.exclude or axes.*.skip in .anatoly.yml instead.`,
      );
    }
  }

  const generalContent = recognized.get('general');

  return {
    hasInstructions: true,
    recognizedSections: recognizedKeys,
    forAxis(axisId: AxisId): string | undefined {
      const axisContent = recognized.get(axisId);

      if (!generalContent && !axisContent) return undefined;

      const parts = [generalContent, axisContent].filter(Boolean);
      return parts.join('\n\n').trim() || undefined;
    },
  };
}
