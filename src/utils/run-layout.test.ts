// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Run-layout convention tests.
 *
 * Two layers:
 *
 * 1. **Unit tests**: each helper composes the expected path under a fake
 *    `<runDir>`. Cheap regression guard for the published surface.
 * 2. **Structural enforcement**: a recursive grep over `src/` asserts that
 *    the catalogued run-dir literals (subdir names, filenames) appear
 *    nowhere except `run-layout.ts` and its own test. Allowlists are
 *    explicit and minimal; each one has a documented reason.
 *
 * See `docs/02-Architecture/19-Run-Layout-Convention.md` §4 for the
 * invariants this test enforces.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  RUN_SUBDIRS,
  logsDir,
  reviewsDir,
  conversationsDir,
  costsDir,
  axesDir,
  axisDir,
  structureReviewDir,
  coherenceReviewDir,
  reportPath,
  publicReportPath,
  runStatusPath,
  runConfigPath,
  runMetricsPath,
  runErrorLogPath,
  docReferenceSectionPath,
  runEventLogPath,
  backgroundLogPath,
  costsLedgerPath,
  costsSummaryPath,
  costsVariancePath,
  axisIndexPath,
  axisShardPath,
  reviewJsonPath,
  reviewMarkdownPath,
  transcriptLogPath,
  ragIndexLogPath,
  docScaffoldLogPath,
  docGenSummaryLogPath,
  docCoherenceReviewLogPath,
  conversationDumpPath,
} from './run-layout.js';

const RUN = '/tmp/proj/.anatoly/runs/run-X';

describe('run-layout — subdirectories', () => {
  it('exposes canonical subdir names via RUN_SUBDIRS', () => {
    expect(RUN_SUBDIRS).toEqual({
      logs: 'logs',
      reviews: 'reviews',
      conversations: 'conversations',
      costs: 'costs',
      axes: 'axes',
      structureReview: 'structure-review',
      coherenceReview: 'coherence-review',
    });
  });

  it('composes subdir paths', () => {
    expect(logsDir(RUN)).toBe(join(RUN, 'logs'));
    expect(reviewsDir(RUN)).toBe(join(RUN, 'reviews'));
    expect(conversationsDir(RUN)).toBe(join(RUN, 'conversations'));
    expect(costsDir(RUN)).toBe(join(RUN, 'costs'));
    expect(axesDir(RUN)).toBe(join(RUN, 'axes'));
    expect(axisDir(RUN, 'correction')).toBe(join(RUN, 'axes', 'correction'));
    expect(structureReviewDir(RUN)).toBe(join(RUN, 'structure-review'));
    expect(coherenceReviewDir(RUN)).toBe(join(RUN, 'coherence-review'));
  });
});

describe('run-layout — top-level files', () => {
  it('composes report/status/config/metrics/error paths', () => {
    expect(reportPath(RUN)).toBe(join(RUN, 'report.md'));
    expect(publicReportPath(RUN)).toBe(join(RUN, 'public_report.md'));
    expect(runStatusPath(RUN)).toBe(join(RUN, 'run-status.json'));
    expect(runConfigPath(RUN)).toBe(join(RUN, 'run-config.json'));
    expect(runMetricsPath(RUN)).toBe(join(RUN, 'run-metrics.json'));
    expect(runErrorLogPath(RUN)).toBe(join(RUN, 'error.log'));
    expect(docReferenceSectionPath(RUN)).toBe(join(RUN, 'doc-reference-section.md'));
    expect(runEventLogPath(RUN)).toBe(join(RUN, 'anatoly.ndjson'));
    expect(backgroundLogPath(RUN)).toBe(join(RUN, 'background.log'));
  });
});

describe('run-layout — costs', () => {
  it('composes ledger/summary/variance paths', () => {
    expect(costsLedgerPath(RUN)).toBe(join(RUN, 'costs', 'ledger.ndjson'));
    expect(costsSummaryPath(RUN)).toBe(join(RUN, 'costs', 'summary.json'));
    expect(costsVariancePath(RUN)).toBe(join(RUN, 'costs', 'variance.json'));
  });
});

describe('run-layout — axes', () => {
  it('composes per-axis index and shard paths', () => {
    expect(axisIndexPath(RUN, 'correction')).toBe(join(RUN, 'axes', 'correction', 'index.md'));
    expect(axisShardPath(RUN, 'correction', 0)).toBe(join(RUN, 'axes', 'correction', 'shard.0.md'));
    expect(axisShardPath(RUN, 'duplication', 42)).toBe(join(RUN, 'axes', 'duplication', 'shard.42.md'));
  });
});

describe('run-layout — reviews and logs', () => {
  it('derives review filenames via toOutputName', () => {
    expect(reviewJsonPath(RUN, 'src/utils/format.ts')).toBe(
      join(RUN, 'reviews', 'src-utils-format.rev.json'),
    );
    expect(reviewMarkdownPath(RUN, 'src/utils/format.ts')).toBe(
      join(RUN, 'reviews', 'src-utils-format.rev.md'),
    );
  });

  it('derives transcript and known log filenames', () => {
    expect(transcriptLogPath(RUN, 'src/foo.ts')).toBe(join(RUN, 'logs', 'src-foo.log'));
    expect(ragIndexLogPath(RUN)).toBe(join(RUN, 'logs', 'rag-index.log'));
    expect(docScaffoldLogPath(RUN, 'overview')).toBe(join(RUN, 'logs', 'doc-scaffold__overview.md'));
    expect(docGenSummaryLogPath(RUN)).toBe(join(RUN, 'logs', 'summary.md'));
    expect(docCoherenceReviewLogPath(RUN)).toBe(join(RUN, 'logs', 'coherence-review.md'));
  });
});

describe('run-layout — conversations', () => {
  it('composes the conversation dump path', () => {
    expect(conversationDumpPath(RUN, 'correction__src-foo', 1)).toBe(
      join(RUN, 'conversations', 'correction__src-foo__1.md'),
    );
  });
});

// ---------------------------------------------------------------------------
// Structural enforcement: no run-dir literal should appear outside the
// run-layout module. Catches drift — a future writer must use a helper.
// ---------------------------------------------------------------------------

/**
 * Catalog of forbidden literals (any string that, when present in `src/`,
 * implies a run-dir path was composed without going through `run-layout`).
 *
 * Quoted in single OR double quotes to skip false-positives inside the
 * helper bodies themselves (which use the bare string inside `join(...)`).
 * The grep matches the **quoted** form on purpose.
 */
const FORBIDDEN_LITERALS: ReadonlyArray<string> = [
  // top-level files (unambiguously run-dir-scoped)
  'run-status.json',
  'run-config.json',
  'run-metrics.json',
  'doc-reference-section.md',
  'background.log',
  'anatoly.ndjson',
  // costs subtree
  'costs/ledger.ndjson',
  'costs/summary.json',
  'costs/variance.json',
  // axes / log filenames that name specific artifacts
  'rag-index.log',
];

/**
 * Files that may keep one or more forbidden literals, with an explicit
 * reason. The allowlist is the design surface: every entry is a known,
 * intentional exception. New writers must go through `run-layout.ts`.
 */
const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'src/utils/run-layout.ts',
    reason: 'the module itself — single source of truth for these names',
  },
  {
    path: 'src/utils/run-layout.test.ts',
    reason: 'this test references the literals to assert composition',
  },
  {
    path: 'src/core/reporting/reporter.ts',
    reason:
      'reporter.ts has a dual-base writer (runDir OR `.anatoly/` legacy ' +
      'fallback) for report.md / public_report.md / axes/<a>/. The shared ' +
      'filename literals stay inline by design; only the run-dir half goes ' +
      'through helpers.',
  },
  {
    path: 'src/core/documentation/generation/doc-llm-executor.ts',
    reason:
      'doc-llm-executor takes a pre-resolved logDir parameter; the filename ' +
      'literals it joins (doc-scaffold__<slug>.md, summary.md, coherence-' +
      'review.md) are dropped in by caller-chosen directories. The path ' +
      'helpers exist (docScaffoldLogPath etc.) for future migration when ' +
      'the logDir abstraction is unified — out of scope for PR 1.',
  },
];

function isAllowlisted(relPath: string): string | undefined {
  const norm = relPath.split(sep).join('/');
  return ALLOWLIST.find((e) => e.path === norm)?.reason;
}

function walk(dir: string, root: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, root, files);
    } else if (entry.endsWith('.ts')) {
      // Test files (*.test.ts, *.integration.test.ts) are exempt: they
      // construct fixture paths and assert composition. The enforcement
      // targets production code paths only.
      if (entry.endsWith('.test.ts')) continue;
      files.push(full.slice(root.length + 1));
    }
  }
  return files;
}

describe('run-layout — structural enforcement', () => {
  const srcRoot = join(__dirname, '..');

  it('forbids inline run-dir literals outside run-layout.ts', () => {
    const tsFiles = walk(srcRoot, srcRoot);
    const violations: Array<{ file: string; literal: string; line: number; snippet: string }> = [];

    for (const rel of tsFiles) {
      if (isAllowlisted(join('src', rel))) continue;
      const content = readFileSync(join(srcRoot, rel), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // ignore comments — these are documentation, not path composition
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        for (const lit of FORBIDDEN_LITERALS) {
          const quoted1 = `'${lit}'`;
          const quoted2 = `"${lit}"`;
          if (code.includes(quoted1) || code.includes(quoted2)) {
            violations.push({ file: `src/${rel}`, literal: lit, line: i + 1, snippet: line.trim() });
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}  ${JSON.stringify(v.literal)}\n    ${v.snippet}`)
        .join('\n');
      throw new Error(
        `Run-dir path literals leaked outside src/utils/run-layout.ts. ` +
          `Migrate to a helper from run-layout.ts (or add the file to the ` +
          `documented ALLOWLIST in run-layout.test.ts if it is a legitimate ` +
          `dual-use/legacy site).\n\n${msg}`,
      );
    }
  });

  it('every ALLOWLIST entry corresponds to an existing file', () => {
    // Guard against rotting allowlist entries.
    for (const entry of ALLOWLIST) {
      // run-layout.ts and its test live under srcRoot
      const abs = join(srcRoot, '..', entry.path);
      expect(statSync(abs).isFile(), `${entry.path}: ${entry.reason}`).toBe(true);
    }
  });
});
