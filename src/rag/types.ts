import { z } from 'zod';

export const BehavioralProfileSchema = z.enum([
  'pure',
  'sideEffectful',
  'async',
  'memoized',
  'stateful',
  'utility',
]);

export const FunctionCardSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  name: z.string(),
  signature: z.string(),
  summary: z.string().max(400),
  keyConcepts: z.array(z.string()),
  behavioralProfile: BehavioralProfileSchema,
  complexityScore: z.number().int().min(1).max(5),
  calledInternals: z.array(z.string()),
  lastIndexed: z.string().datetime(),
});

export type BehavioralProfile = z.infer<typeof BehavioralProfileSchema>;
export type FunctionCard = z.infer<typeof FunctionCardSchema>;

/** Schema for the LLM-generated portion of a FunctionCard (during review). */
export const FunctionCardLLMOutputSchema = z.object({
  name: z.string(),
  summary: z.string().max(400),
  keyConcepts: z.array(z.string()).min(1).max(6),
  behavioralProfile: BehavioralProfileSchema,
});

export type FunctionCardLLMOutput = z.infer<typeof FunctionCardLLMOutputSchema>;

/** Result from a similarity search. */
export interface SimilarityResult {
  card: FunctionCard;
  score: number;
}

/** RAG index stats for status display. */
export interface RagStats {
  totalCards: number;
  totalFiles: number;
  lastIndexed: string | null;
}
