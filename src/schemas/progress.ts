import { z } from 'zod';

export const FileStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'TIMEOUT',
  'ERROR',
  'CACHED',
]);

export const FileProgressSchema = z.object({
  file: z.string(),
  hash: z.string(),
  status: FileStatusSchema,
  updated_at: z.string(),
  error: z.string().optional(),
});

export const ProgressSchema = z.object({
  version: z.literal(1),
  started_at: z.string(),
  files: z.record(z.string(), FileProgressSchema),
});

export type FileStatus = z.infer<typeof FileStatusSchema>;
export type FileProgress = z.infer<typeof FileProgressSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
