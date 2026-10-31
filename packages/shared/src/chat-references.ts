import { z } from 'zod';
import { parsePullRequestFullRef } from './utils/pull-request-changes-target.js';

export const chatReferenceBatchSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            threadId: z.string().min(1).max(200),
            references: z.array(z.string().min(1).max(2048)).min(1).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .refine((value) => value.groups.reduce((n, group) => n + group.references.length, 0) <= 128);

export const chatFileReferenceSchema = z.object({
  kind: z.literal('file'),
  entryType: z.enum(['file', 'directory']),
  worktreeId: z.string(),
  path: z.string(),
  absolutePath: z.string(),
  line: z.number().int().positive().nullable(),
  mime: z.string(),
  size: z.number().nonnegative(),
  modifiedAt: z.string(),
  pageCount: z.number().int().nonnegative().optional(),
  pageUnit: z.enum(['pages', 'slides', 'sheets']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export const chatGitHubReferenceSchema = z.object({
  kind: z.literal('github'),
  repo: z.string(),
  number: z.number().int().positive(),
  objectType: z.enum(['pull', 'issue']),
  title: z.string().optional(),
  state: z.enum(['open', 'closed', 'merged']).optional(),
  worktreeId: z.string().optional(),
  url: z.string(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  author: z.string().optional(),
  updatedAt: z.string().datetime().optional(),
  checks: z.enum(['checksPassed', 'checksPending', 'checksFailed']).optional(),
});
export const chatReferenceTargetSchema = z.discriminatedUnion('kind', [
  chatFileReferenceSchema,
  chatGitHubReferenceSchema,
  z.object({
    kind: z.literal('commit'),
    worktreeId: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    title: z.string(),
  }),
  z.object({ kind: z.literal('missing') }),
]);
export const chatReferenceGroupSchema = z.object({
  threadId: z.string(),
  results: z.array(z.object({ reference: z.string(), target: chatReferenceTargetSchema.nullable() })),
});
export type ChatReferenceTarget = z.infer<typeof chatReferenceTargetSchema>;
export type ChatFileReference = z.infer<typeof chatFileReferenceSchema>;
export type ChatGitHubReference = z.infer<typeof chatGitHubReferenceSchema>;

/** Only public GitHub URL shapes, never caller-selected hosts or API paths. */
export function parseChatGitHubUrl(
  reference: string,
): { repo: string; objectType: 'pull' | 'issue'; number: number; url: string } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/([1-9]\d*)(?:[/?#].*)?$/.exec(reference);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
  if (!parsePullRequestFullRef(`${match[1]}#${match[3]}`)) return null;
  return {
    repo: match[1],
    objectType: match[2] === 'pull' ? 'pull' : 'issue',
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/${match[3]}`,
  };
}

export function isChatPathCandidate(value: string): boolean {
  return (
    value.length <= 2048 &&
    !/[\n\r\0]/.test(value) &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
    !value.startsWith('//') &&
    !value.startsWith('#') &&
    (/^[\p{L}\p{N}_@-]+$/u.test(value) ||
      /^(?:\/|~\/|\.\.?\/)/.test(value) ||
      /^(?:[^\s<>*?"|:]+\/)+[^<>*?"|]*$/.test(value) ||
      /^[^\s<>*?"|/]+\.[a-z0-9]{1,12}(?::[1-9]\d*(?::[1-9]\d*)?)?$/i.test(value))
  );
}

export function isChatCommitCandidate(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/** A failed lookup is not proof that arbitrary slash/dot prose names a missing file. */
export function isExplicitChatPathReference(value: string): boolean {
  const file = /(?:^|\/)([^/]+)\.([a-z0-9_-]+)(?::([1-9]\d*)(?::[1-9]\d*)?)?$/i.exec(value);
  return (
    /^(?:\/|~\/|\.\.?\/)/.test(value) ||
    (!!file && (value.includes('/') || !!file[3]) && /[\p{L}_-]/u.test(file[1] + file[2]))
  );
}

/** Consumer-only compatibility for persisted messages; this is a root selector, never a grant. */
export function parseLegacyChatPathReference(value: string): { reference: string; worktreeId?: string } {
  const match = /^(.*?)\s*\[wt:([a-zA-Z0-9_/-]+)\]$/.exec(value);
  return match ? { reference: match[1], worktreeId: match[2] } : { reference: value };
}
