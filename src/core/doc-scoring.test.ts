// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import { describe, it, expect } from 'vitest';
import { scoreDocumentation, type DocScoringInput } from './doc-scoring.js';

/**
 * Story 29.10: Documentation Scoring Integration
 *
 * Tests validate that scoreDocumentation() produces 5 weighted dimension
 * scores, an overall score, a verdict, and a sync gap — with project-type
 * weight adjustments.
 */

/** Helper: all 5 base required sections present */
const FULL_USER_PAGES = [
  'index.md',
  '01-Getting-Started/01-Overview.md',
  '02-Architecture/01-System-Overview.md',
  '04-API-Reference/01-Public-API.md',
  '06-Development/01-Source-Tree.md',
];

describe('scoreDocumentation', () => {
  // --- AC1: 5 dimension scores + overall + verdict ---
  describe('dimension scoring (AC1)', () => {
    it('produces all 5 dimension scores plus overall and verdict', () => {
      const result = scoreDocumentation({
        userDocPages: ['index.md', '01-Getting-Started/01-Overview.md', '02-Architecture/01-System-Overview.md'],
        idealPageCount: 5,
        projectTypes: ['Library'],
        projectExportsDocumented: 20,
        totalExports: 25,
        modulesDocumented: 4,
        totalModules: 5,
        contentQualityPercent: 80,
      });

      expect(result.structural).toBeGreaterThanOrEqual(0);
      expect(result.structural).toBeLessThanOrEqual(100);
      expect(result.apiCoverage).toBe(80);
      expect(result.moduleCoverage).toBe(80);
      expect(result.contentQuality).toBe(80);
      expect(result.navigation).toBeGreaterThan(0);
      expect(result.overall).toBeGreaterThan(0);
      expect(['DOCUMENTED', 'PARTIAL', 'UNDOCUMENTED']).toContain(result.verdict);
    });

    it('verdict is DOCUMENTED when overall >= 80', () => {
      const result = scoreDocumentation({
        userDocPages: FULL_USER_PAGES,
        idealPageCount: 5,
        projectTypes: ['Library'],
        projectExportsDocumented: 25,
        totalExports: 25,
        modulesDocumented: 5,
        totalModules: 5,
        contentQualityPercent: 90,
      });

      expect(result.verdict).toBe('DOCUMENTED');
      expect(result.overall).toBeGreaterThanOrEqual(80);
    });

    it('verdict is PARTIAL when overall between 50 and 79', () => {
      const result = scoreDocumentation({
        userDocPages: ['index.md', '01-Getting-Started/01-Overview.md'],
        idealPageCount: 10,
        projectTypes: ['Library'],
        projectExportsDocumented: 12,
        totalExports: 20,
        modulesDocumented: 3,
        totalModules: 6,
        contentQualityPercent: 60,
      });

      expect(result.verdict).toBe('PARTIAL');
      expect(result.overall).toBeGreaterThanOrEqual(50);
      expect(result.overall).toBeLessThan(80);
    });

    it('verdict is UNDOCUMENTED when overall < 50', () => {
      const result = scoreDocumentation({
        userDocPages: [],
        idealPageCount: 20,
        projectTypes: ['Library'],
        projectExportsDocumented: 0,
        totalExports: 30,
        modulesDocumented: 0,
        totalModules: 10,
        contentQualityPercent: 0,
      });

      expect(result.verdict).toBe('UNDOCUMENTED');
      expect(result.overall).toBeLessThan(50);
    });
  });

  // --- AC2: Project-type weight adjustments ---
  describe('project-type weight adjustments (AC2)', () => {
    it('adjusts weights for Backend API + ORM projects', () => {
      const baseInput: Omit<DocScoringInput, 'projectTypes'> = {
        userDocPages: ['index.md', '01-Getting-Started/01-Overview.md'],
        idealPageCount: 20,
        projectExportsDocumented: 15,
        totalExports: 20,
        modulesDocumented: 4,
        totalModules: 8,
        contentQualityPercent: 60,
      };

      const libraryScore = scoreDocumentation({ ...baseInput, projectTypes: ['Library'] });
      const backendOrmScore = scoreDocumentation({ ...baseInput, projectTypes: ['Backend API', 'ORM'] });

      // Backend API + ORM should have different overall due to weight adjustment
      // (structural weight is higher, and structural score is low because
      // type-specific required sections like REST-Endpoints are missing)
      expect(backendOrmScore.overall).not.toBe(libraryScore.overall);
    });
  });

  // --- AC3: No docs/ directory ---
  describe('no docs/ directory (AC3)', () => {
    it('structural score is 0% and verdict is UNDOCUMENTED when no user docs', () => {
      const result = scoreDocumentation({
        userDocPages: [],
        idealPageCount: 25,
        projectTypes: ['Library'],
        projectExportsDocumented: 0,
        totalExports: 20,
        modulesDocumented: 0,
        totalModules: 8,
        contentQualityPercent: 0,
      });

      expect(result.structural).toBe(0);
      expect(result.verdict).toBe('UNDOCUMENTED');
      expect(result.syncGap).toBe(25);
    });
  });

  // --- Edge cases ---
  describe('edge cases', () => {
    it('handles zero total exports and modules (nothing to document = 100%)', () => {
      const result = scoreDocumentation({
        userDocPages: FULL_USER_PAGES,
        idealPageCount: 5,
        projectTypes: ['Library'],
        projectExportsDocumented: 0,
        totalExports: 0,
        modulesDocumented: 0,
        totalModules: 0,
        contentQualityPercent: 80,
      });

      expect(result.apiCoverage).toBe(100);
      expect(result.moduleCoverage).toBe(100);
    });

    it('sync gap shows difference between ideal and user page counts', () => {
      const result = scoreDocumentation({
        userDocPages: ['index.md', '01-Getting-Started/01-Overview.md'],
        idealPageCount: 10,
        projectTypes: ['Library'],
        projectExportsDocumented: 10,
        totalExports: 20,
        modulesDocumented: 3,
        totalModules: 5,
        contentQualityPercent: 50,
      });

      expect(result.syncGap).toBe(8);
    });

    it('structural detects sections with flexible naming (no number prefix)', () => {
      const result = scoreDocumentation({
        userDocPages: ['index.md', 'getting-started/overview.md', 'architecture/system.md'],
        idealPageCount: 5,
        projectTypes: ['Library'],
        projectExportsDocumented: 10,
        totalExports: 10,
        modulesDocumented: 5,
        totalModules: 5,
        contentQualityPercent: 80,
      });

      // Should detect 3/5 required sections even without number prefixes
      expect(result.structural).toBe(60);
    });

    // --- Story 29.20: coverage never > 100% ---
    it('apiCoverage caps at 100% even if documented > total', () => {
      const result = scoreDocumentation({
        userDocPages: FULL_USER_PAGES,
        idealPageCount: 5,
        projectTypes: ['Library'],
        projectExportsDocumented: 30,
        totalExports: 25,
        modulesDocumented: 5,
        totalModules: 5,
        contentQualityPercent: 80,
      });

      expect(result.apiCoverage).toBeLessThanOrEqual(100);
    });
  });
});
