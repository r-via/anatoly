import type { VectorStore } from './vector-store.js';
import type { SimilarityResult } from './types.js';

/**
 * Tool definition for findSimilarFunctions.
 * Registered with the Claude Agent SDK when RAG is enabled.
 */
export const findSimilarFunctionsTool = {
  name: 'findSimilarFunctions',
  description:
    'Search for semantically similar functions across the entire indexed codebase. ' +
    'Use this tool before concluding on the duplication axis for any function.',
  input_schema: {
    type: 'object' as const,
    properties: {
      functionId: {
        type: 'string' as const,
        description: 'The ID of the function to find similar matches for',
      },
      maxResults: {
        type: 'number' as const,
        description: 'Maximum number of results to return (default: 8)',
      },
      minScore: {
        type: 'number' as const,
        description: 'Minimum similarity score threshold (default: 0.78)',
      },
    },
    required: ['functionId'] as const,
  },
};

/**
 * Handle a findSimilarFunctions tool call.
 * Returns a formatted string for the agent to interpret.
 */
export async function handleFindSimilarFunctions(
  store: VectorStore,
  input: { functionId: string; maxResults?: number; minScore?: number },
): Promise<string> {
  const { functionId, maxResults = 8, minScore = 0.78 } = input;

  const results = await store.searchById(functionId, maxResults, minScore);

  if (results.length === 0) {
    return `No similar functions found for ID "${functionId}" (minScore: ${minScore}).`;
  }

  return formatResults(results);
}

function formatResults(results: SimilarityResult[]): string {
  const header = `Found ${results.length} similar function(s):\n`;
  const rows = results.map(
    (r) =>
      `- **${r.card.name}** in \`${r.card.filePath}\` (score: ${r.score.toFixed(3)})\n` +
      `  Summary: ${r.card.summary}\n` +
      `  Profile: ${r.card.behavioralProfile} | Complexity: ${r.card.complexityScore}/5`,
  );
  return header + rows.join('\n');
}
