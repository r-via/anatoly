import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Task } from '../schemas/task.js';
import { VectorStore } from './vector-store.js';
import { generateFunctionCards } from './card-generator.js';
import { buildFunctionCards, indexCards } from './indexer.js';
import { setEmbeddingLogger } from './embeddings.js';

export interface RagIndexOptions {
  projectRoot: string;
  tasks: Task[];
  rebuild?: boolean;
  onLog: (message: string) => void;
  isInterrupted: () => boolean;
}

export interface RagIndexResult {
  vectorStore: VectorStore;
  cardsIndexed: number;
  filesIndexed: number;
  totalCards: number;
  totalFiles: number;
}

/**
 * Run the RAG indexing phase: generate function cards via Haiku,
 * compute embeddings, and upsert into the vector store.
 *
 * Returns the initialized VectorStore and indexing stats.
 */
export async function indexProject(options: RagIndexOptions): Promise<RagIndexResult> {
  const { projectRoot, tasks, rebuild, onLog, isInterrupted } = options;

  setEmbeddingLogger(onLog);

  const store = new VectorStore(projectRoot);
  await store.init();

  if (rebuild) {
    await store.rebuild();
  }

  const tasksWithFunctions = tasks.filter((t) =>
    t.symbols.some((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'hook'),
  );

  let cardsIndexed = 0;
  let filesIndexed = 0;

  for (let i = 0; i < tasksWithFunctions.length; i++) {
    if (isInterrupted()) break;
    const task = tasksWithFunctions[i];
    onLog(`[${i + 1}/${tasksWithFunctions.length}] ${task.file}`);

    try {
      const llmCards = await generateFunctionCards(projectRoot, task);
      if (llmCards.length > 0) {
        const absPath = resolve(projectRoot, task.file);
        const source = readFileSync(absPath, 'utf-8');
        const cards = buildFunctionCards(task, source, llmCards);
        const indexed = await indexCards(projectRoot, store, cards, task.hash);
        cardsIndexed += indexed;
        if (indexed > 0) filesIndexed++;
      }
    } catch {
      // Card generation failed for this file — continue
    }
  }

  const stats = await store.stats();

  return {
    vectorStore: store,
    cardsIndexed,
    filesIndexed,
    totalCards: stats.totalCards,
    totalFiles: stats.totalFiles,
  };
}
