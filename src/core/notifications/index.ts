// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Verdict } from '../../schemas/review.js';

/**
 * Payload passed to every notification channel after a run completes.
 * Built from {@link ReportData} + {@link RunStats} in the pipeline.
 */
export interface NotificationPayload {
  verdict: Verdict;
  totalFiles: number;
  cleanFiles: number;
  findingFiles: number;
  errorFiles: number;
  durationMs: number;
  costUsd: number;
  axisScorecard: Record<string, { high: number; medium: number; low: number }>;
  topFindings: Array<{ file: string; axis: string; severity: string; detail: string }>;
  reportUrl?: string;
}

/**
 * Generic notification channel interface.
 * Implement `send()` to add a new channel (Slack, Discord, webhook, etc.).
 */
export interface NotificationChannel {
  send(payload: NotificationPayload): Promise<void>;
}
