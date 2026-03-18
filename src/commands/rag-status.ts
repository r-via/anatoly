// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { VectorStore, getCodeModelId, getNlpModelId, ragModeArtifacts } from '../rag/index.js';
import type { RagMode } from '../rag/index.js';
import type { RagStats } from '../rag/types.js';
import { loadConfig } from '../utils/config-loader.js';
import { detectHardware, resolveEmbeddingModels } from '../rag/hardware-detect.js';
import { configureModels } from '../rag/embeddings.js';

async function getStoreForMode(
  projectRoot: string,
  mode: RagMode,
): Promise<{ store: VectorStore; stats: RagStats }> {
  const { tableName } = ragModeArtifacts(mode);
  const store = new VectorStore(projectRoot, tableName);
  await store.init();
  const stats = await store.stats();
  return { store, stats };
}

function printStats(mode: string, stats: RagStats, resolved: { codeModel: string; codeDim: number; nlpModel: string; nlpDim: number }): void {
  console.log(chalk.bold(`  ${mode} index`));
  console.log(`    cards      ${stats.totalCards}`);
  console.log(`    files      ${stats.totalFiles}`);
  console.log(`    mode       ${stats.dualEmbedding ? chalk.cyan('dual (code + NLP)') : 'code-only'}`);
  const codeDimLabel = stats.codeDim && stats.codeDim !== resolved.codeDim
    ? `${stats.codeDim}d`
    : `${resolved.codeDim}d`;
  console.log(`    code model ${chalk.dim(resolved.codeModel)} (${codeDimLabel})`);
  if (stats.dualEmbedding) {
    const nlpDimLabel = stats.nlpDim && stats.nlpDim !== resolved.nlpDim
      ? `${stats.nlpDim}d`
      : `${resolved.nlpDim}d`;
    console.log(`    nlp model  ${chalk.dim(resolved.nlpModel)} (${nlpDimLabel})`);
  }
  if (stats.lastIndexed) {
    console.log(`    indexed    ${stats.lastIndexed}`);
  }
  console.log('');
}

export function registerRagStatusCommand(program: Command): void {
  program
    .command('rag-status [function]')
    .description('Show RAG index status, or inspect function cards')
    .option('--all', 'list all indexed function cards')
    .option('--json', 'output as JSON')
    .action(async (functionName: string | undefined, opts: { all?: boolean; json?: boolean }, cmd: Command) => {
      const projectRoot = resolve('.');

      // Resolve models so vector store dimension checks use correct values
      const config = loadConfig(projectRoot);
      const hardware = detectHardware();
      const resolved = await resolveEmbeddingModels(config.rag, hardware);
      configureModels(resolved);

      // Read --rag-lite / --rag-advanced from parent (global) options
      const parentOpts = cmd.parent?.opts() ?? {};
      const ragLite = parentOpts.ragLite as boolean | undefined;
      const ragAdvanced = parentOpts.ragAdvanced as boolean | undefined;

      // Determine which mode(s) to show
      const modes: RagMode[] = ragLite ? ['lite']
        : ragAdvanced ? ['advanced']
        : ['lite', 'advanced'];

      // For function search or --all, use the first available mode
      if (functionName || opts.all) {
        let vectorStore: VectorStore | undefined;
        for (const mode of modes) {
          const { store, stats } = await getStoreForMode(projectRoot, mode);
          if (stats.totalCards > 0) {
            vectorStore = store;
            break;
          }
        }

        if (!vectorStore) {
          console.log('anatoly — rag-status');
          console.log('  No cards indexed. Run `anatoly run` first.');
          return;
        }

        if (functionName) {
          const cards = await vectorStore.searchByName(functionName);
          if (cards.length === 0) {
            console.log(`No cards matching "${functionName}".`);
            return;
          }

          if (opts.json) {
            console.log(JSON.stringify(cards, null, 2));
            return;
          }

          for (const card of cards) {
            console.log(chalk.bold(`${card.filePath}:${card.name}`));
            console.log(`  id          ${card.id}`);
            console.log(`  signature   ${card.signature}`);
            console.log(`  complexity  ${card.complexityScore}/5`);
            if (card.calledInternals.length > 0) {
              console.log(`  calls       ${card.calledInternals.join(', ')}`);
            }
            console.log('');
          }
          return;
        }

        // --all
        const cards = await vectorStore.listAll();

        if (opts.json) {
          console.log(JSON.stringify(cards, null, 2));
          return;
        }

        const byFile = new Map<string, typeof cards>();
        for (const card of cards) {
          const list = byFile.get(card.filePath) ?? [];
          list.push(card);
          byFile.set(card.filePath, list);
        }

        for (const [file, fileCards] of byFile) {
          console.log(chalk.bold(file));
          for (const card of fileCards) {
            const complexity = chalk.dim(`[${card.complexityScore}/5]`);
            console.log(`  ${complexity} ${card.name}`);
          }
          console.log('');
        }
        return;
      }

      // Default: show stats for each mode
      console.log(chalk.bold('anatoly — rag-status'));
      console.log('');

      let hasAny = false;
      for (const mode of modes) {
        const { stats } = await getStoreForMode(projectRoot, mode);
        if (stats.totalCards > 0) {
          hasAny = true;
          printStats(mode, stats, resolved);
        }
      }

      if (!hasAny) {
        console.log('  No cards indexed. Run `anatoly run` first.');
      }

      console.log(chalk.dim('  Use --all to list all cards, or pass a function name to inspect.'));
      console.log(chalk.dim('  Use --lite or --advanced to filter by index.'));
    });
}
