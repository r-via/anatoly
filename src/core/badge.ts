import { readFileSync, writeFileSync, constants, accessSync } from 'node:fs';
import { join } from 'node:path';
import type { Verdict } from '../schemas/review.js';

const MARKER_START = '<!-- checked-by-anatoly -->';
const MARKER_END = '<!-- /checked-by-anatoly -->';
const MARKER_REGEX = new RegExp(
  `${MARKER_START}[\\s\\S]*?${MARKER_END}`,
);

const DEFAULT_LINK = 'https://github.com/r-via/anatoly';

export interface BadgeOptions {
  projectRoot: string;
  verdict?: Verdict;
  includeVerdict?: boolean;
  link?: string;
}

export interface BadgeResult {
  injected: boolean;
  updated: boolean;
}

export function buildBadgeMarkdown(
  verdict?: Verdict,
  includeVerdict?: boolean,
  link?: string,
): string {
  const baseUrl = 'https://img.shields.io/badge';
  const target = link ?? DEFAULT_LINK;

  if (includeVerdict && verdict) {
    const colorMap: Record<Verdict, string> = {
      CLEAN: 'brightgreen',
      NEEDS_REFACTOR: 'yellow',
      CRITICAL: 'red',
    };
    const labelMap: Record<Verdict, string> = {
      CLEAN: 'clean',
      NEEDS_REFACTOR: 'needs refactor',
      CRITICAL: 'critical',
    };
    const color = colorMap[verdict];
    const label = encodeURIComponent(labelMap[verdict]);
    return `[![Checked by Anatoly](${baseUrl}/checked%20by-Anatoly%20%E2%80%94%20${label}-${color})](${target})`;
  }

  return `[![Checked by Anatoly](${baseUrl}/checked%20by-Anatoly-blue)](${target})`;
}

export function injectBadge(options: BadgeOptions): BadgeResult {
  const readmePath = join(options.projectRoot, 'README.md');

  let content: string;
  try {
    content = readFileSync(readmePath, 'utf-8');
  } catch {
    return { injected: false, updated: false };
  }

  const badge = buildBadgeMarkdown(options.verdict, options.includeVerdict, options.link);
  const block = `${MARKER_START}\n${badge}\n${MARKER_END}`;

  let newContent: string;
  let updated: boolean;

  if (MARKER_REGEX.test(content)) {
    newContent = content.replace(MARKER_REGEX, block);
    updated = true;
  } else {
    // Normalize trailing newlines then append
    const trimmed = content.replace(/\n+$/, '');
    newContent = trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
    updated = false;
  }

  // Ensure file ends with exactly one newline
  newContent = newContent.replace(/\n*$/, '\n');

  try {
    accessSync(readmePath, constants.W_OK);
  } catch {
    process.stderr.write(`anatoly — warning: README.md is not writable, skipping badge injection\n`);
    return { injected: false, updated: false };
  }

  writeFileSync(readmePath, newContent, 'utf-8');
  return { injected: true, updated };
}
