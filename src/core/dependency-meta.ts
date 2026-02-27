import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencyMeta {
  /** Package name -> version range from package.json */
  dependencies: Map<string, string>;
  /** Engine constraints, e.g. { node: '>=20.19' } */
  engines?: Record<string, string>;
}

export interface FileDependencyContext {
  /** Package name -> version range, only for packages imported by this file */
  deps: Array<{ name: string; version: string }>;
  /** Node engine constraint if available */
  nodeEngine?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load dependency metadata from the project's package.json.
 * Returns undefined if package.json is missing or unparsable.
 */
export function loadDependencyMeta(projectRoot: string): DependencyMeta | undefined {
  const pkgPath = resolve(projectRoot, 'package.json');

  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf-8');
  } catch {
    return undefined;
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const deps = new Map<string, string>();

  const prodDeps = pkg.dependencies as Record<string, string> | undefined;
  if (prodDeps && typeof prodDeps === 'object') {
    for (const [name, version] of Object.entries(prodDeps)) {
      if (typeof version === 'string') deps.set(name, version);
    }
  }

  const devDeps = pkg.devDependencies as Record<string, string> | undefined;
  if (devDeps && typeof devDeps === 'object') {
    for (const [name, version] of Object.entries(devDeps)) {
      if (typeof version === 'string') deps.set(name, version);
    }
  }

  const engines = pkg.engines as Record<string, string> | undefined;

  return {
    dependencies: deps,
    ...(engines && typeof engines === 'object' ? { engines } : {}),
  };
}

/**
 * Extract the subset of project dependencies that are actually imported
 * by the given file content.
 */
export function extractFileDeps(fileContent: string, meta: DependencyMeta): FileDependencyContext {
  const seen = new Set<string>();
  const deps: Array<{ name: string; version: string }> = [];

  // Match bare import/export specifiers (not relative paths, not node: builtins)
  const importRe = /(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?|\*\s+as\s+\w+)\s+from\s+['"]([^'"./][^'"]*)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = importRe.exec(fileContent)) !== null) {
    const pkgName = toPackageName(match[1]);
    if (pkgName && !seen.has(pkgName)) {
      seen.add(pkgName);
      const version = meta.dependencies.get(pkgName);
      if (version) {
        deps.push({ name: pkgName, version });
      }
    }
  }

  return {
    deps,
    ...(meta.engines?.node ? { nodeEngine: meta.engines.node } : {}),
  };
}

/**
 * Read the README of a locally installed npm package from node_modules.
 * Returns the content truncated to maxChars, or null if not found.
 */
export function readLocalPackageReadme(
  projectRoot: string,
  pkgName: string,
  maxChars = 8000,
): string | null {
  const content = readFullReadme(projectRoot, pkgName);
  if (!content) return null;
  return content.length > maxChars ? content.slice(0, maxChars) + '\n[...truncated]' : content;
}

/**
 * Extract sections of a README that are relevant to a set of search keywords.
 * Uses markdown heading structure to select targeted sections instead of
 * blindly truncating, ensuring that deeply-nested documentation (e.g. the
 * "Action handler" section in Commander's 43 KB README) is included when
 * relevant to the finding being verified.
 */
export function extractRelevantReadmeSections(
  projectRoot: string,
  pkgName: string,
  keywords: string[],
  maxChars = 12_000,
): string | null {
  const fullContent = readFullReadme(projectRoot, pkgName);
  if (!fullContent) return null;

  // Small enough — return as-is
  if (fullContent.length <= maxChars) return fullContent;

  const sections = parseReadmeSections(fullContent);

  // No useful structure — fall back to truncation
  if (sections.length <= 1) {
    return fullContent.slice(0, maxChars) + '\n[...truncated]';
  }

  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  // Score and rank sections
  const scored = sections.map((s) => ({
    section: s,
    score: scoreSection(s, lowerKeywords),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Greedily select top sections within budget
  const selected: ReadmeSection[] = [];
  let budget = maxChars;

  // Always include intro (first section, capped at 1500 chars)
  const intro = sections[0];
  const introText =
    intro.content.length > 1500
      ? intro.content.slice(0, 1500) + '\n[...intro truncated]'
      : intro.content;
  selected.push({ ...intro, content: introText });
  budget -= introText.length;

  // Add highest-scoring sections that fit
  for (const { section, score } of scored) {
    if (score === 0) break;
    if (section === intro) continue;
    if (section.content.length <= budget) {
      selected.push(section);
      budget -= section.content.length;
    } else if (budget > 500) {
      selected.push({
        ...section,
        content: section.content.slice(0, budget - 50) + '\n[...section truncated]',
      });
      budget = 0;
      break;
    }
  }

  // Re-sort by document order
  selected.sort((a, b) => a.startOffset - b.startOffset);

  const note = `[Sections extracted based on relevance. ${sections.length} total sections, ${selected.length} included.]\n\n`;
  return note + selected.map((s) => s.content).join('\n\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ReadmeSection {
  heading: string;
  level: number;
  content: string;
  startOffset: number;
}

function readFullReadme(projectRoot: string, pkgName: string): string | null {
  const base = resolve(projectRoot, 'node_modules', pkgName);
  for (const candidate of ['README.md', 'Readme.md', 'readme.md', 'README']) {
    const p = join(base, candidate);
    try {
      return readFileSync(p, 'utf-8');
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Parse a markdown README into sections based on headings.
 * Each section runs from its heading to the next heading of equal or lesser depth.
 */
export function parseReadmeSections(content: string): ReadmeSection[] {
  const headingRe = /^(#{1,6})\s+(.+)/;
  const lines = content.split('\n');
  const sections: ReadmeSection[] = [];

  let currentHeading = '';
  let currentLevel = 0;
  let currentStart = 0;
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // +1 for newline
  }

  for (let i = 0; i < lines.length; i++) {
    const match = headingRe.exec(lines[i]);
    if (match) {
      // Close previous section
      if (i > 0 || currentHeading) {
        const sectionContent = lines.slice(currentStart, i).join('\n');
        if (sectionContent.trim()) {
          sections.push({
            heading: currentHeading,
            level: currentLevel,
            content: sectionContent,
            startOffset: lineOffsets[currentStart],
          });
        }
      }
      currentHeading = match[2];
      currentLevel = match[1].length;
      currentStart = i;
    }
  }

  // Close final section
  const lastContent = lines.slice(currentStart).join('\n');
  if (lastContent.trim()) {
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content: lastContent,
      startOffset: lineOffsets[currentStart],
    });
  }

  return sections;
}

/**
 * Score a section's relevance to a set of (already lowercased) keywords.
 * Heading matches score higher than body matches.
 */
export function scoreSection(section: ReadmeSection, lowerKeywords: string[]): number {
  let score = 0;
  const headingLower = section.heading.toLowerCase();
  const bodyLower = section.content.toLowerCase();

  for (const kw of lowerKeywords) {
    if (headingLower.includes(kw)) {
      score += 3;
    }
    // Count body occurrences, capped at 3 per keyword
    let count = 0;
    let idx = 0;
    while (count < 3) {
      idx = bodyLower.indexOf(kw, idx);
      if (idx === -1) break;
      count++;
      idx += kw.length;
    }
    score += count;
  }

  return score;
}

function toPackageName(specifier: string): string | null {
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split('/')[0];
}
