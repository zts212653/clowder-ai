/** Existing lifecycle sweep: finish merged idle checkouts, deliver expiry/results through History. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { formatWorktreeNotice, type WorktreeNotice, worktreeNoticeSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  type EngagementPolicyReader,
  readEngagementPolicy,
} from '../../domains/routing-context/ScarceSeatNotificationPolicy.js';
import type { DeliverOpts } from '../scheduler/types.js';

const execute = promisify(execFile);
const noticeSchema = worktreeNoticeSchema.omit({ version: true, ownerAction: true }).extend({
  key: z.string().regex(/^worktree:[0-9a-f]{64}$/),
  threadId: z
    .string()
    .regex(/^thread_[A-Za-z0-9_-]+$/)
    .max(200),
  userId: z.string().min(1).max(2000),
  head: z.string().nullable(),
});
const resultSchema = z.object({
  version: z.literal(1),
  notices: z.array(z.unknown()).max(10000),
  unroutable: z.array(z.object({ path: z.string(), reason: z.string() })),
  unknownPrQueries: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
});
const releaseSchema = z.object({
  key: z.string().regex(/^worktree:[0-9a-f]{64}$/),
  state: z.literal('released'),
  storageDisposition: z.literal('removed'),
  path: z.string(),
  owner: z.string(),
  head: z.string(),
  mergedPr: z.string(),
  archivePath: z.string(),
  restore: z.string(),
});
interface Deps {
  repoRoot: string;
  scriptRoot: string;
  getThread: (id: string) => Promise<{ createdBy: string; deletedAt?: number | null } | null>;
  isOwnerAvailable: (id: string) => boolean;
  getEngagementPolicy?: EngagementPolicyReader;
  deliver: (opts: DeliverOpts) => Promise<string>;
  warn: (message: string) => void;
  queryEnv?: NodeJS.ProcessEnv;
}

export class WorktreeNoticeService {
  private inFlight: Promise<number> | undefined;
  private stopped = false;
  private controller: AbortController | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.timers.length || this.stopped) return;
    const run = () => {
      void this.sweep();
    };
    const startup = setTimeout(run, 30000);
    const periodic = setInterval(run, 5 * 60 * 1000);
    startup.unref();
    periodic.unref();
    this.timers = [startup, periodic];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.controller?.abort();
    await this.inFlight;
  }

  async sweep(): Promise<number> {
    if (this.stopped || this.inFlight) return 0;
    this.inFlight = this.run().catch((error: unknown) => {
      if (!this.stopped) this.deps.warn(`worktree notice scan failed: ${String(error)}`);
      return 0;
    });
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async release(
    notice: z.infer<typeof noticeSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof releaseSchema> | { reason: string } | undefined> {
    if (notice.kind === 'merged-removed') {
      return releaseSchema.parse({
        ...notice,
        state: 'released',
        storageDisposition: 'removed',
        mergedPr: notice.sourceRef,
      });
    }
    if (notice.kind === 'merged-unfinished' && notice.head) {
      try {
        const { stdout } = await execute(
          process.execPath,
          [
            join(this.deps.scriptRoot, 'scripts/worktree-retire-merged.mjs'),
            this.deps.repoRoot,
            notice.path,
            notice.head,
            notice.sourceRef,
            notice.threadId,
            notice.userId,
            notice.owner,
          ],
          {
            cwd: this.deps.scriptRoot,
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
            signal,
            env: { ...process.env, ...this.deps.queryEnv, GIT_OPTIONAL_LOCKS: '0' },
          },
        );
        const receipt = releaseSchema.parse(JSON.parse(stdout));
        if (
          receipt.path !== notice.path ||
          receipt.head !== notice.head ||
          receipt.owner !== notice.owner ||
          receipt.mergedPr !== notice.sourceRef
        )
          throw new Error('automatic release receipt mismatch');
        return receipt;
      } catch (error) {
        this.deps.warn(`automatic release not verified (${notice.key}): ${String(error)}`);
        const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
        const diagnostic = stderr.trim() || String(error);
        return {
          reason:
            String(diagnostic).trim().split('\n').filter(Boolean).at(-1)?.slice(0, 2000) ||
            'automatic release not verified',
        };
      }
    }
    return undefined;
  }

  private ownerFollowUp(owner: string, needsOwner: boolean): WorktreeNotice['ownerAction'] {
    if (!needsOwner) return undefined;
    // Historical ownership alone is not consent to wake an unavailable or scarce seat.
    const policy = this.deps.getEngagementPolicy ?? readEngagementPolicy;
    return this.deps.isOwnerAvailable(owner) && policy(owner)?.quota !== 'weekly_subscription_scarce'
      ? 'queued'
      : 'unavailable';
  }

  private async deliver(notice: z.infer<typeof noticeSchema>, signal: AbortSignal): Promise<number> {
    const thread = await this.deps.getThread(notice.threadId);
    if (this.stopped) return 0;
    if (!thread || thread.deletedAt || thread.createdBy !== notice.userId) {
      this.deps.warn(`worktree notice origin mismatch: ${notice.key}`);
      return 0;
    }
    const outcome = await this.release(notice, signal);
    const release = outcome && 'state' in outcome ? outcome : undefined;
    if (this.stopped) return 0;
    const needsOwner = !release && notice.kind !== 'merged-removal-interrupted';
    const ownerAction = this.ownerFollowUp(notice.owner, needsOwner);
    const display = worktreeNoticeSchema.parse({
      ...notice,
      version: 1,
      ...(release ? { kind: 'merged-removed', archivePath: release.archivePath, restore: release.restore } : {}),
      ...(outcome && 'reason' in outcome ? { reason: outcome.reason } : {}),
      ownerAction,
    });
    await this.deps.deliver({
      threadId: notice.threadId,
      userId: notice.userId,
      idempotencyKey: release?.key ?? (ownerAction ? `${notice.key}:owner-${ownerAction}-v1` : notice.key),
      ...(ownerAction === 'queued'
        ? {
            targetCatId: notice.owner,
            sourceCategory: 'scheduled' as const,
            privateContent: `${formatWorktreeNotice(display)}\n\n这是原工位资产的责任续办。先核当前工位和原sourceRef对应的既有责任；可回收的实际finish并检查，不以通知或ACK结案。仍在用的核实具名用途及期限；有未提交内容先保全。回原Task/原thread写实际处置结果，不新建产品Task，不改他人的责任，不重启runtime或Redis。`,
          }
        : {}),
      source: {
        connector: 'worktree-lifecycle',
        label: '工位通知',
        icon: 'settings',
        meta: { worktreeNotice: display },
      },
      content: formatWorktreeNotice(display),
    });
    return 1;
  }

  private async run(): Promise<number> {
    const controller = new AbortController();
    this.controller = controller;
    const recovery = await execute(
      process.execPath,
      [join(this.deps.scriptRoot, 'scripts/worktree-retire-merged.mjs'), '--reconcile', this.deps.repoRoot],
      {
        cwd: this.deps.scriptRoot,
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
        signal: controller.signal,
        env: { ...process.env, ...this.deps.queryEnv, GIT_OPTIONAL_LOCKS: '0' },
      },
    );
    const recoveryResult = z
      .object({ reconciled: z.number(), warnings: z.array(z.object({ path: z.string(), reason: z.string() })) })
      .parse(JSON.parse(recovery.stdout));
    if (recoveryResult.warnings.length)
      this.deps.warn('interrupted worktree release needs manual recovery; automatic retries paused');
    const { stdout } = await execute(
      process.execPath,
      [
        join(this.deps.scriptRoot, 'scripts/worktree-inventory.mjs'),
        '--repo',
        this.deps.repoRoot,
        '--notices',
        '--merged',
      ],
      {
        cwd: this.deps.scriptRoot,
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
        signal: controller.signal,
        env: { ...process.env, ...this.deps.queryEnv, GIT_OPTIONAL_LOCKS: '0' },
      },
    );
    const result = resultSchema.parse(JSON.parse(stdout));
    if (result.unknownPrQueries?.length)
      this.deps.warn(`${result.unknownPrQueries.length} PR subjects could not be verified; checkouts remain untouched`);
    if (result.unroutable.length)
      this.deps.warn(
        `${result.unroutable.length} worktree expiry facts lack verified thread provenance; inventory retains the paths for maintenance`,
      );
    let delivered = 0;
    for (const raw of result.notices) {
      const parsed = noticeSchema.safeParse(raw);
      if (!parsed.success) {
        this.deps.warn('invalid worktree notice; check provenance in inventory');
        continue;
      }
      const notice = parsed.data;
      if (this.stopped) break;
      try {
        delivered += await this.deliver(notice, controller.signal);
      } catch (error) {
        this.deps.warn(`worktree notice delivery failed (${notice.key}): ${String(error)}`);
      }
    }
    return delivered;
  }
}
