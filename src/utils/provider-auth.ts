// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import chalk from 'chalk';

/**
 * Generic provider auth helpers.
 *
 * Centralizes (1) a registry of every provider Anatoly knows how to talk to,
 * with the install commands and env vars users need; and (2) a shared
 * renderer for the "provider check failed" notice so the UX stays
 * consistent whatever provider failed.
 */

export type ProviderId = 'anthropic' | 'google';
export type ProviderMode = 'subscription' | 'api';

interface ProviderInstallStep {
  cmd: string;
  /** Trailing dim comment, rendered after the command. */
  comment?: string;
}

interface ProviderInfo {
  /** Capitalized display name used in the rendered notice. */
  display: string;
  subscription: {
    /** Human-readable name of the CLI Anatoly spawns/talks to. */
    cliName: string;
    /** Concrete commands to install + log into the CLI. */
    install: ProviderInstallStep[];
  };
  api: {
    /** Primary env var Anatoly checks for the API key. */
    keyVar: string;
    /** Optional alternative env vars (mentioned in the notice). */
    altVars?: string[];
    /** Example value rendered after the export command. */
    keyExample: string;
  };
}

const REGISTRY: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    display: 'Anthropic',
    subscription: {
      cliName: 'Claude Code',
      install: [
        { cmd: 'npm install -g @anthropic-ai/claude-code' },
        { cmd: 'claude /login' },
      ],
    },
    api: {
      keyVar: 'ANTHROPIC_API_KEY',
      keyExample: 'sk-ant-...',
    },
  },
  google: {
    display: 'Google',
    subscription: {
      cliName: 'Gemini CLI',
      install: [
        { cmd: 'npm install -g @google/gemini-cli' },
        { cmd: 'gemini auth login' },
      ],
    },
    api: {
      keyVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
      altVars: ['GOOGLE_API_KEY'],
      keyExample: 'AIza...',
    },
  },
};

/**
 * Render a yellow-bordered, multi-line notice explaining a provider auth
 * failure with concrete install/configure commands. The returned string
 * is meant to be printed verbatim — it already contains ANSI styling.
 *
 * The notice always shows two paths to recovery (subscription CLI vs API
 * key), regardless of which mode failed, so users can pivot to the other
 * mode if it's more convenient.
 */
export function renderProviderAuthBox(
  provider: ProviderId,
  mode: ProviderMode,
  reason: string,
): string {
  const info = REGISTRY[provider];
  const bar = chalk.yellow('│');
  const top = chalk.yellow('┌  ') + chalk.bold('anatoly: provider check failed');
  const bot = chalk.yellow('└');
  const { dim, cyan, bold } = chalk;

  const out: string[] = ['', top, bar];
  out.push(`${bar}  ${bold(info.display)} provider is configured in ${bold(mode)} mode`);
  out.push(`${bar}  but ${reason}.`);
  out.push(bar);

  if (mode === 'subscription') {
    out.push(`${bar}  ${bold('A.')} Install ${info.subscription.cliName} ${dim(`(uses your ${info.display} subscription)`)}`);
    for (const step of info.subscription.install) {
      const trail = step.comment ? ' ' + dim(step.comment) : '';
      out.push(`${bar}     ${cyan(step.cmd)}${trail}`);
    }
    out.push(bar);
    out.push(`${bar}  ${bold('B.')} Or switch to API mode ${dim('(per-token billing)')}`);
    out.push(`${bar}     ${cyan(`export ${info.api.keyVar}=${info.api.keyExample}`)}`);
    out.push(`${bar}     ${dim(`# then in .anatoly.yml: providers.${provider}.mode: api`)}`);
  } else {
    out.push(`${bar}  ${bold('A.')} Set the API key ${dim('(per-token billing)')}`);
    out.push(`${bar}     ${cyan(`export ${info.api.keyVar}=${info.api.keyExample}`)}`);
    if (info.api.altVars?.length) {
      out.push(`${bar}     ${dim(`# alternative env vars: ${info.api.altVars.join(', ')}`)}`);
    }
    out.push(bar);
    out.push(`${bar}  ${bold('B.')} Or use ${info.subscription.cliName} ${dim(`(free with your ${info.display} subscription)`)}`);
    for (const step of info.subscription.install) {
      out.push(`${bar}     ${cyan(step.cmd)}`);
    }
    out.push(`${bar}     ${dim(`# then in .anatoly.yml: providers.${provider}.mode: subscription`)}`);
  }

  out.push(bar, bot, '');
  return out.join('\n');
}
