import { z } from 'zod';

export const workspaceFileDraftSchema = z.object({
  v: z.literal(1),
  revision: z.string().min(1),
  writerId: z.string().min(1),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().max(1_048_576),
  priorBases: z.array(z.string()).optional(),
});
export type WorkspaceFileDraft = z.infer<typeof workspaceFileDraftSchema>;
export type WorkspaceFileSaveReceipt = { path: string; sha256: string };
export type WorkspaceFileSave = (
  content: string,
  options?: { baseSha256: string },
) => Promise<WorkspaceFileSaveReceipt | void>;

export function workspaceFileDraftKey(userId: string, worktreeId: string, path: string): string {
  return `cat-cafe:file-edit-draft:${JSON.stringify([userId, worktreeId, path])}`;
}

export function afterWorkspaceFileSave(
  current: WorkspaceFileDraft,
  sent: WorkspaceFileDraft,
  sha256: string,
): WorkspaceFileDraft | null {
  if (current.revision === sent.revision) return null;
  // Only edits made in the saving editor have a proven causal parent in this save.
  // Another page/reopened editor retains its old base and must resolve any drift.
  if (current.writerId !== sent.writerId || current.baseSha256 !== sent.baseSha256) return current;
  return { ...current, revision: crypto.randomUUID(), baseSha256: sha256 };
}
