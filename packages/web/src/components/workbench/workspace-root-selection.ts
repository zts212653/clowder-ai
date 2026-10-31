import { z } from 'zod';

/** A visible directory selected from discovery; never a persisted filesystem grant. */
export const workspaceRootSelectionSchema = z.object({
  root: z.string().min(1).max(4096),
  branch: z.string().max(1024),
  expectedEpoch: z.number().int().nonnegative(),
});
export type WorkspaceRootSelection = z.infer<typeof workspaceRootSelectionSchema>;
export const workspaceRootConnectionSchema = z.object({
  kind: z.literal('connection-required'),
  admission: z.literal('absolute-file-directory').optional(),
  connectionProof: z.string().min(1).optional(),
  ownerUserId: z.string().min(1),
  root: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  expectedEpoch: z.number().int().nonnegative(),
});
export type WorkspaceRootConnection = z.infer<typeof workspaceRootConnectionSchema>;
