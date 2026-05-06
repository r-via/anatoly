// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

declare const PKG_VERSION: string;
declare const PKG_COMMIT: string;

export const pkgVersion = typeof PKG_VERSION !== 'undefined' ? PKG_VERSION : '0.0.0-dev';
export const pkgCommit = typeof PKG_COMMIT !== 'undefined' ? PKG_COMMIT : 'unknown';
export const pkgVersionString = `${pkgVersion} (${pkgCommit})`;
