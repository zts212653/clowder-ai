import { z } from 'zod';
import { workspaceRootSelectionSchema } from './workspace-root-selection';

export const artifactFileLocationSchema = z.object({
  absolutePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => path.startsWith('/') && !path.includes('\0')),
  label: z.string().min(1).max(4096),
  rootSelection: workspaceRootSelectionSchema.optional(),
});
export const artifactFileEntranceSchema = z.object({
  threadId: z.string().min(1).max(256),
  artifactId: z.string().min(1).max(16384),
  fileLedgerRef: z.string().min(1).max(4096).optional(),
  path: z.string().min(1).max(4096),
  title: z.string().min(1).max(4096),
  selectedLocation: artifactFileLocationSchema.optional(),
});
export type ArtifactFileEntrance = z.infer<typeof artifactFileEntranceSchema>;
export type ArtifactFileLocation = z.infer<typeof artifactFileLocationSchema>;
export function artifactFileLocationKey(ownerUserId: string, source: ArtifactFileEntrance): string {
  const identity = source.fileLedgerRef ? ['file-ledger', source.fileLedgerRef] : source.artifactId;
  return `cat-cafe:artifact-file-location:${JSON.stringify([ownerUserId, source.threadId, identity])}`;
}
