// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Modular type-context injection for doc generation.
 *
 * Collects extra context based on project types (CLI, API, Library, etc.)
 * and injects it into the doc-writer prompt. Each project type can register
 * a context provider that extracts relevant information.
 */

import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import type { ProjectType } from './language-detect.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TypeContextSection {
  /** Section heading for the injected context block. */
  heading: string;
  /** The context content to inject into the prompt. */
  content: string;
}

/**
 * Collect extra context sections based on the project's detected types.
 * Each type provider is called if its type is present in `projectTypes`.
 * Returns an array of context sections to inject into the doc-writer prompt.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param projectTypes - Detected project types from language-detect.
 * @param pkg - Parsed package.json (or empty object for non-JS projects).
 * @returns Array of context sections, one per matching type provider.
 */
export function collectTypeContext(
  projectRoot: string,
  projectTypes: ProjectType[],
  pkg: Record<string, unknown>,
): TypeContextSection[] {
  const sections: TypeContextSection[] = [];

  for (const provider of TYPE_CONTEXT_PROVIDERS) {
    if (projectTypes.includes(provider.type)) {
      const section = provider.collect(projectRoot, pkg);
      if (section) sections.push(section);
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Type context providers
// ---------------------------------------------------------------------------

interface TypeContextProvider {
  type: ProjectType;
  collect: (projectRoot: string, pkg: Record<string, unknown>) => TypeContextSection | null;
}

/**
 * CLI type provider — extracts recursive --help output from the CLI binary.
 * Detects the binary name from package.json `bin` field, then runs:
 *   1. `<binary> --help` for the top-level help
 *   2. `<binary> <subcommand> --help` for each detected subcommand
 *   3. `<binary> <subcommand> <nested> --help` for nested subcommands
 *
 * Output is truncated to 3000 characters to avoid prompt bloat.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param pkg - Parsed package.json contents (used to resolve the CLI binary name).
 * @returns A context section with concatenated --help output, or null if no CLI binary is found.
 */
function collectCliContext(projectRoot: string, pkg: Record<string, unknown>): TypeContextSection | null {
  // Find the CLI binary name
  const binName = resolveCliBinName(projectRoot, pkg);
  if (!binName) return null;

  const lines: string[] = [];

  // Get top-level help
  const topHelp = runHelp(projectRoot, binName, []);
  if (!topHelp) return null;

  lines.push(`$ ${binName} --help`, topHelp, '');

  // Extract subcommands from the help output and get help for each
  const subcommands = extractSubcommands(topHelp);
  for (const sub of subcommands) {
    const subHelp = runHelp(projectRoot, binName, [sub]);
    if (subHelp) {
      lines.push(`$ ${binName} ${sub} --help`, subHelp, '');

      // Check for nested subcommands (e.g. `docs scaffold`, `clean run`)
      const nestedSubs = extractSubcommands(subHelp);
      for (const nested of nestedSubs) {
        const nestedHelp = runHelp(projectRoot, binName, [sub, nested]);
        if (nestedHelp) {
          lines.push(`$ ${binName} ${sub} ${nested} --help`, nestedHelp, '');
        }
      }
    }
  }

  // Truncate to avoid prompt bloat (max ~3000 chars)
  let content = lines.join('\n');
  if (content.length > 3000) {
    content = content.slice(0, 3000) + '\n…(truncated)';
  }

  return {
    heading: 'CLI Command Reference (from --help)',
    content,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCliBinName(projectRoot: string, pkg: Record<string, unknown>): string | null {
  // JS/TS: read from package.json bin field
  if (pkg.bin) {
    if (typeof pkg.bin === 'string') {
      return pkg.name ? String(pkg.name).replace(/^@[^/]+\//, '') : basename(String(pkg.bin));
    }
    if (typeof pkg.bin === 'object') {
      const entries = Object.keys(pkg.bin as Record<string, string>);
      if (entries.length > 0) return entries[0];
    }
  }

  // Go: check for binary matching directory name
  const dirName = basename(projectRoot);
  const goBin = resolve(projectRoot, dirName);
  if (existsSync(goBin)) return `./${dirName}`;

  // Rust: check target/release or target/debug
  const cargoName = basename(projectRoot);
  for (const profile of ['release', 'debug']) {
    const path = resolve(projectRoot, 'target', profile, cargoName);
    if (existsSync(path)) return path;
  }

  return null;
}

function runHelp(projectRoot: string, binName: string, args: string[]): string | null {
  try {
    // Resolve local bin from node_modules/.bin/ instead of npx (avoids auto-install)
    const isLocalBin = !binName.startsWith('/') && !binName.startsWith('./');
    const resolvedBin = isLocalBin
      ? resolve(projectRoot, 'node_modules', '.bin', binName)
      : resolve(projectRoot, binName);

    if (!existsSync(resolvedBin)) return null;

    // Use execFileSync to avoid shell interpretation of arguments
    const output = execFileSync(resolvedBin, [...args, '--help'], {
      cwd: projectRoot,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    }).toString().trim();

    // Skip empty or error-like output
    if (!output || output.length < 20) return null;
    return output;
  } catch {
    return null;
  }
}

function extractSubcommands(helpText: string): string[] {
  const commands: string[] = [];
  const lines = helpText.split('\n');
  let inCommandsSection = false;

  for (const line of lines) {
    // Detect "Commands:" or "COMMANDS:" section header
    if (/^\s*(commands|subcommands):?\s*$/i.test(line)) {
      inCommandsSection = true;
      continue;
    }
    // Detect end of commands section (new section header or empty line after commands)
    if (inCommandsSection && /^\s*\S+:?\s*$/.test(line) && !/^\s{2,}/.test(line)) {
      inCommandsSection = false;
      continue;
    }
    if (inCommandsSection) {
      // Commander format: "  command-name    description"
      const match = line.match(/^\s{2,}(\S+)/);
      if (match) {
        const cmd = match[1];
        // Skip help command, options-like entries, and validate name
        if (cmd !== 'help' && !cmd.startsWith('-') && !cmd.startsWith('[') && /^[a-zA-Z0-9_-]+$/.test(cmd)) {
          commands.push(cmd);
        }
      }
    }
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const TYPE_CONTEXT_PROVIDERS: TypeContextProvider[] = [
  { type: 'CLI', collect: collectCliContext },
  // Future providers:
  // { type: 'Backend API', collect: collectApiContext },
  // { type: 'Library', collect: collectLibraryContext },
  // { type: 'Frontend', collect: collectFrontendContext },
];
