// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectProjectProfile } from './scanning/index.js';

/**
 * End-to-end framework detection for Go projects. Builds a fake go.mod with
 * known dependencies inside a real git repo (linguist-js + getGitTrackedFiles
 * both need a tracked file tree to work).
 */

function makeGoProject(dir: string, requires: string[]): void {
  // go.mod with a require() block listing the deps under test
  const lines = ['module example.com/test', '', 'go 1.22', '', 'require ('];
  for (const dep of requires) lines.push(`\t${dep}`);
  lines.push(')', '');
  writeFileSync(join(dir, 'go.mod'), lines.join('\n'));

  // Add at least one .go file so linguist classifies the project as Go.
  mkdirSync(join(dir, 'cmd'), { recursive: true });
  writeFileSync(join(dir, 'cmd', 'main.go'), 'package main\n\nfunc main() {}\n');

  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('detectProjectProfile — Go frameworks', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'go-fw-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects Cobra (the existing case stays green)', async () => {
    makeGoProject(dir, ['github.com/spf13/cobra v1.10.2']);
    const profile = await detectProjectProfile(dir);
    expect(profile.frameworks.map((f) => f.id)).toContain('cobra');
  });

  it('detects Bubble Tea via charm.land/bubbletea (v2)', async () => {
    makeGoProject(dir, ['charm.land/bubbletea/v2 v2.0.6']);
    const profile = await detectProjectProfile(dir);
    const ids = profile.frameworks.map((f) => f.id);
    expect(ids).toContain('bubbletea');
  });

  it('detects Bubble Tea via the legacy github.com/charmbracelet/bubbletea path', async () => {
    makeGoProject(dir, ['github.com/charmbracelet/bubbletea v1.0.0']);
    const profile = await detectProjectProfile(dir);
    const ids = profile.frameworks.map((f) => f.id);
    expect(ids).toContain('bubbletea');
  });

  it('detects gRPC', async () => {
    makeGoProject(dir, ['google.golang.org/grpc v1.80.0']);
    const profile = await detectProjectProfile(dir);
    const ids = profile.frameworks.map((f) => f.id);
    expect(ids).toContain('grpc');
  });

  it('detects hashicorp/go-plugin', async () => {
    makeGoProject(dir, ['github.com/hashicorp/go-plugin v1.7.0']);
    const profile = await detectProjectProfile(dir);
    const ids = profile.frameworks.map((f) => f.id);
    expect(ids).toContain('hashicorp-go-plugin');
  });

  it('detects all four together (Cobra + Bubble Tea + gRPC + go-plugin)', async () => {
    makeGoProject(dir, [
      'github.com/spf13/cobra v1.10.2',
      'charm.land/bubbletea/v2 v2.0.6',
      'google.golang.org/grpc v1.80.0',
      'github.com/hashicorp/go-plugin v1.7.0',
    ]);
    const profile = await detectProjectProfile(dir);
    const ids = profile.frameworks.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['cobra', 'bubbletea', 'grpc', 'hashicorp-go-plugin']));
  });

  it('does NOT flag generic libraries (zap, testify, otel) as frameworks', async () => {
    makeGoProject(dir, [
      'go.uber.org/zap v1.27.1',
      'github.com/stretchr/testify v1.11.1',
      'go.opentelemetry.io/otel v1.43.0',
    ]);
    const profile = await detectProjectProfile(dir);
    // None of those should appear as frameworks — they're libs.
    expect(profile.frameworks).toEqual([]);
  });
});
