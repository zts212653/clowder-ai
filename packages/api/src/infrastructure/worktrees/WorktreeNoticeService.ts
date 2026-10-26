/** Read-only expiry sweep. Delivery uses existing durable History idempotency; no Queue admission. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { DeliverOpts } from '../scheduler/types.js';

const execute = promisify(execFile);
const noticeSchema = z.object({
  kind: z.enum(['retention-expired', 'retention-invalid', 'retention-head-changed', 'merged-unfinished']),
  key: z.string().regex(/^worktree:[0-9a-f]{64}$/),
  threadId: z
    .string()
    .regex(/^thread_[A-Za-z0-9_-]+$/)
    .max(200),
  userId: z.string().min(1).max(2000),
  owner: z.string().min(1).max(2000),
  path: z.string().min(1).max(4096),
  head: z.string().nullable(),
  sourceRef: z.string().max(2000),
  until: z.string().optional(),
});
const resultSchema = z.object({
  version: z.literal(1),
  notices: z.array(z.unknown()).max(10000),
  unroutable: z.array(z.object({ path: z.string(), reason: z.string() })),
  unknownPrQueries: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
});
interface Deps {
  repoRoot: string;
  scriptRoot: string;
  getThread: (id: string) => Promise<{ createdBy: string; deletedAt?: number | null } | null>;
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

  private async run(): Promise<number> {
    this.controller = new AbortController();
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
        signal: this.controller.signal,
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
        const thread = await this.deps.getThread(notice.threadId);
        if (this.stopped) break;
        if (!thread || thread.deletedAt || thread.createdBy !== notice.userId) {
          this.deps.warn(`worktree notice origin mismatch: ${notice.key}`);
          continue;
        }
        await this.deps.deliver({
          threadId: notice.threadId,
          userId: notice.userId,
          idempotencyKey: notice.key,
          source: { connector: 'worktree-lifecycle', label: '工位续留提醒', icon: 'scheduler' },
          content: `工位需要原负责人核对收尾：${notice.kind}\nowner=${JSON.stringify(notice.owner)}\npath=${JSON.stringify(notice.path)}\nsource=${JSON.stringify(notice.sourceRef)}\nuntil=${JSON.stringify(notice.until ?? null)}\n请核对原用途后执行 worktree:finish 或给出新的原因与截止。目录未被自动修改。`,
        });
        delivered++;
      } catch (error) {
        this.deps.warn(`worktree notice delivery failed (${notice.key}): ${String(error)}`);
      }
    }
    return delivered;
  }
}
