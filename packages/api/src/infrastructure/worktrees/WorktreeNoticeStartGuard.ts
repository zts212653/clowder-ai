/** Revalidate lifecycle reminders at Queue start, including already-persisted private inputs. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { worktreeNoticeSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { QueueEntry } from '../../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../../domains/cats/services/stores/ports/MessageStore.js';

const execute = promisify(execFile);
const privateSource = /^(worktree:[0-9a-f]{64}):owner-queued-v1:private$/;
const liveNotice = z.object({
  key: z.string(),
  kind: z.string(),
  path: z.string(),
  threadId: z.string(),
  userId: z.string(),
  owner: z.string(),
});
const inventory = z.object({ version: z.literal(1), notices: z.array(liveNotice).max(10000) });
const releaseResult = z.object({ version: z.literal(1), released: z.boolean() });

export type WorktreeNoticeStartDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'notice_stale' | 'evidence_unavailable' };

export function isWorktreeOwnerInput(entry: QueueEntry): boolean {
  return entry.kind === 'private_input' && entry.from.kind === 'system' && entry.from.service === 'worktree-lifecycle';
}

export async function checkWorktreeNoticeStart(
  entry: QueueEntry,
  targetCatId: string,
  guard?: Pick<WorktreeNoticeStartGuard, 'check'>,
): Promise<WorktreeNoticeStartDecision> {
  if (!isWorktreeOwnerInput(entry)) return { ok: true };
  return guard ? guard.check(entry, targetCatId) : { ok: false, reason: 'evidence_unavailable' };
}

export class WorktreeNoticeStartGuard {
  constructor(
    private readonly deps: {
      repoRoot: string;
      scriptRoot: string;
      messageStore: Pick<IMessageStore, 'getByIdempotencyKey'>;
      getThread: (id: string) => Promise<{ createdBy: string; deletedAt?: number | null } | null>;
      queryEnv?: NodeJS.ProcessEnv;
    },
  ) {}

  async check(entry: QueueEntry, targetCatId: string): Promise<WorktreeNoticeStartDecision> {
    if (!isWorktreeOwnerInput(entry)) return { ok: true };
    const source = privateSource.exec(entry.payload.sourceRecordId);
    if (!source || entry.owner.kind !== 'user') return { ok: false, reason: 'evidence_unavailable' };
    const userId = entry.owner.userId;
    const key = source[1];
    // Atomic admission binds the private source key to its public History notice. No prose
    // parsing, duplicate authority record or pending-row migration is needed.
    const message = await this.deps.messageStore.getByIdempotencyKey(userId, entry.threadId, `${key}:owner-queued-v1`);
    const parsed = worktreeNoticeSchema.safeParse(message?.source?.meta?.worktreeNotice);
    if (
      !message ||
      message.threadId !== entry.threadId ||
      message.userId !== userId ||
      message.from?.kind !== 'system' ||
      message.from.service !== 'worktree-lifecycle' ||
      message.source?.connector !== 'worktree-lifecycle' ||
      !parsed.success ||
      parsed.data.ownerAction !== 'queued' ||
      parsed.data.owner !== targetCatId ||
      entry.targets.length !== 1 ||
      entry.targets[0] !== targetCatId
    )
      return { ok: false, reason: 'evidence_unavailable' };
    const thread = await this.deps.getThread(entry.threadId);
    if (!thread || thread.deletedAt || thread.createdBy !== userId) return { ok: false, reason: 'notice_stale' };
    // Genuine interrupted/paused recovery remains actionable. Only a merged busy reminder
    // with its exact verified completed release can be retired here.
    const merged = parsed.data.kind === 'merged-unfinished';
    if (!parsed.data.kind.startsWith('retention-') && !merged) return { ok: true };
    const query = merged
      ? [
          '--released-notice',
          JSON.stringify({ ...parsed.data, key, threadId: entry.threadId, userId, observedAt: message.timestamp }),
        ]
      : ['--notices'];
    const { stdout } = await execute(
      process.execPath,
      [join(this.deps.scriptRoot, 'scripts/worktree-inventory.mjs'), '--repo', this.deps.repoRoot, ...query],
      {
        cwd: this.deps.scriptRoot,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, ...this.deps.queryEnv, GIT_OPTIONAL_LOCKS: '0' },
      },
    );
    if (merged)
      return releaseResult.parse(JSON.parse(stdout)).released ? { ok: false, reason: 'notice_stale' } : { ok: true };
    const current = inventory.parse(JSON.parse(stdout));
    const present = current.notices.some(
      (notice) =>
        notice.key === key &&
        notice.kind === parsed.data.kind &&
        notice.path === parsed.data.path &&
        notice.threadId === entry.threadId &&
        notice.userId === userId &&
        notice.owner === targetCatId,
    );
    return present ? { ok: true } : { ok: false, reason: 'notice_stale' };
  }
}
