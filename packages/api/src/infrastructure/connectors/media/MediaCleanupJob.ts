import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface MediaCleanupJobOptions {
  readonly mediaDir: string;
  readonly ttlMs: number;
  readonly intervalMs: number;
  readonly log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export class MediaCleanupJob {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly opts: MediaCleanupJobOptions;

  constructor(opts: MediaCleanupJobOptions) {
    this.opts = opts;
  }

  start(): void {
    this.timer = setInterval(() => void this.sweep(), this.opts.intervalMs);
    // unref() 让这个 housekeeping timer 不阻止进程退出。
    // 防止测试失败跳过 stop() 时，残留 timer 把 node --test 挂住。
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sweep(): Promise<number> {
    const cutoff = Date.now() - this.opts.ttlMs;
    let removed = 0;
    const entries = await readdir(this.opts.mediaDir).catch(() => [] as string[]);
    for (const name of entries) {
      const filePath = join(this.opts.mediaDir, name);
      const s = await stat(filePath).catch(() => undefined);
      if (s?.isFile() && s.mtimeMs < cutoff) {
        await unlink(filePath).catch(() => {});
        removed++;
      }
    }
    if (removed > 0) {
      this.opts.log.info({ removed }, 'media cleanup sweep');
    }
    return removed;
  }
}
