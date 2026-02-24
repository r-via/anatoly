import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { VectorStore } from '../rag/index.js';

export function registerRagStatusCommand(program: Command): void {
  program
    .command('rag-status [function]')
    .description('Show RAG index status, or inspect function cards')
    .option('--all', 'list all indexed function cards')
    .option('--json', 'output as JSON')
    .action(async (functionName: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const projectRoot = resolve('.');

      const vectorStore = new VectorStore(projectRoot);
      await vectorStore.init();
      const stats = await vectorStore.stats();

      if (stats.totalCards === 0) {
        console.log('anatoly — rag-status');
        console.log('  No cards indexed. Run `anatoly run` first.');
        return;
      }

      // Show specific function
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
          console.log(`  summary     ${card.summary}`);
          console.log(`  concepts    ${card.keyConcepts.join(', ')}`);
          console.log(`  profile     ${card.behavioralProfile}`);
          console.log(`  complexity  ${card.complexityScore}/5`);
          if (card.calledInternals.length > 0) {
            console.log(`  calls       ${card.calledInternals.join(', ')}`);
          }
          console.log('');
        }
        return;
      }

      // List all cards
      if (opts.all) {
        const cards = await vectorStore.listAll();

        if (opts.json) {
          console.log(JSON.stringify(cards, null, 2));
          return;
        }

        // Group by file
        const byFile = new Map<string, typeof cards>();
        for (const card of cards) {
          const list = byFile.get(card.filePath) ?? [];
          list.push(card);
          byFile.set(card.filePath, list);
        }

        for (const [file, fileCards] of byFile) {
          console.log(chalk.bold(file));
          for (const card of fileCards) {
            const profile = chalk.dim(`[${card.behavioralProfile}]`);
            console.log(`  ${profile} ${card.name} — ${card.summary.slice(0, 80)}${card.summary.length > 80 ? '…' : ''}`);
          }
          console.log('');
        }
        return;
      }

      // Default: show stats
      console.log(chalk.bold('anatoly — rag-status'));
      console.log('');
      console.log(`  cards    ${stats.totalCards}`);
      console.log(`  files    ${stats.totalFiles}`);
      if (stats.lastIndexed) {
        console.log(`  indexed  ${stats.lastIndexed}`);
      }
      console.log('');
      console.log(chalk.dim('  Use --all to list all cards, or pass a function name to inspect.'));
    });
}
