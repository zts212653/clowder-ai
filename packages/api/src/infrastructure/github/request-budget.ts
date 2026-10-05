import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createModuleLogger } from '../logger.js';
import { awaitGitHubCaller } from './abortable-wait.js';
import { buildGhCliEnv, withHiddenGhCliWindow } from './gh-cli-env.js';
import { executeGitHubProcess, type GitHubProcessOptions } from './gh-process.js';

const log = createModuleLogger('github/request-budget');

export interface GitHubRequestOptions {
  ghToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  execFileAsync?: (file: string, args: string[], opts: GitHubProcessOptions) => Promise<{ stdout: string }>;
}

export class GitHubRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super(`GitHub quota unavailable until ${new Date(retryAt).toISOString()}`);
    this.name = 'GitHubRateLimitError';
  }
}

function diagnostic(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const fields = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [fields.message, fields.stdout, fields.stderr].filter((value) => typeof value === 'string').join('\n');
}

function retryAt(error: unknown, now: number): number | undefined {
  const text = diagnostic(error);
  const retry = text.match(/(?:^|\n)retry-after:\s*(.+)/im)?.[1]?.trim();
  const remaining = text.match(/(?:^|\n)x-ratelimit-remaining:\s*(\d+)/im)?.[1];
  const reset = Number(text.match(/(?:^|\n)x-ratelimit-reset:\s*(\d+)/im)?.[1]);
  if (retry) {
    const seconds = Number(retry);
    const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry);
    if (Number.isFinite(until)) return Math.max(now + 1000, until);
  }
  if (remaining === '0' && Number.isFinite(reset)) return Math.max(now + 1000, reset * 1000);
  if (/rate limit|secondary rate|abuse detection|HTTP[^\n]*429|HTTP 429/i.test(text)) return now + 60_000;
  return undefined;
}

function stripHeaders(stdout: string): string {
  // gh --include writes HTTP headers before the JSON/--jq representation.
  return stdout.replace(/^HTTP\/[^\n]+\r?\n(?:[^\r\n]+\r?\n)*\r?\n/, '');
}

/** Token hashes never leave this process. Auth-store mtime distinguishes an
 * account switch without reading or logging the stored credential. */
export async function gitHubCredentialKey(token?: string): Promise<string> {
  const host = process.env.GH_HOST ?? 'github.com';
  let identity = token?.trim();
  if (!identity) {
    const config = join(
      process.env.GH_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'gh'),
      'hosts.yml',
    );
    const version = await stat(config).then(
      (value) => `${value.mtimeMs}:${value.ctimeMs}:${value.size}`,
      () => 'absent',
    );
    identity = `auth-store:${config}:${version}`;
  }
  return createHash('sha256').update(`${host}\0${identity}`).digest('hex');
}

export class GitHubRequestBudget {
  private readonly blocked = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly queued = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async execute(args: string[], options: GitHubRequestOptions = {}): Promise<{ stdout: string }> {
    options.signal?.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? 15_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const boundedOptions = { ...options, signal };
    const key = await gitHubCredentialKey(options.ghToken);
    const until = this.blocked.get(key);
    if (until && until > this.now()) throw new GitHubRateLimitError(until);
    const queued = this.queued.get(key) ?? 0;
    if (queued >= 64) throw new Error('GitHub request queue capacity exceeded; retry later');
    this.queued.set(key, queued + 1);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let started = false;
    const pending = previous
      .catch(() => {})
      .then(() => {
        started = true;
        return this.executeForCredential(key, args, boundedOptions);
      });
    this.tails.set(key, pending);
    const settled = () => {
      const remaining = (this.queued.get(key) ?? 1) - 1;
      if (remaining === 0) this.queued.delete(key);
      else this.queued.set(key, remaining);
      if (this.tails.get(key) === pending) this.tails.delete(key);
    };
    void pending.then(settled, settled);
    try {
      return await awaitGitHubCaller(pending, signal);
    } catch (error) {
      // A queued caller can leave promptly; a started process still belongs to
      // this request/gate until its abort cleanup finishes. The credential tail
      // and the scheduler overlap lock must agree about that completion.
      if (signal.aborted && started) await pending.catch(() => {});
      throw error;
    }
  }

  private async executeForCredential(
    key: string,
    args: string[],
    options: GitHubRequestOptions,
  ): Promise<{ stdout: string }> {
    const { signal } = options;
    signal?.throwIfAborted();
    const until = this.blocked.get(key);
    if (until && until > this.now()) throw new GitHubRateLimitError(until);
    this.blocked.delete(key);
    signal?.throwIfAborted();
    try {
      const invoke = options.execFileAsync ?? executeGitHubProcess;
      const result = await invoke(
        'gh',
        args[0] === 'api' && !args.includes('--include') ? [...args, '--include'] : args,
        withHiddenGhCliWindow({
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: 2 * 1024 * 1024,
          env: buildGhCliEnv({ token: options.ghToken }),
          ...(signal ? { signal } : {}),
        }),
      );
      signal?.throwIfAborted();
      const quotaReset = retryAt(
        { stdout: result.stdout.startsWith('HTTP/') ? result.stdout.split(/\r?\n\r?\n/, 1)[0] : '' },
        this.now(),
      );
      if (quotaReset !== undefined) this.blocked.set(key, quotaReset);
      return { stdout: stripHeaders(result.stdout) };
    } catch (error) {
      signal?.throwIfAborted();
      const blockedUntil = retryAt(error, this.now());
      if (blockedUntil !== undefined) {
        this.blocked.set(key, Math.max(this.blocked.get(key) ?? 0, blockedUntil));
        log.warn({ retryAt: blockedUntil }, 'GitHub credential quota paused until reset');
        // Forget only expired credentials; never evict an active quota fence.
        for (const [credential, deadline] of this.blocked) if (deadline <= this.now()) this.blocked.delete(credential);
        throw new GitHubRateLimitError(blockedUntil);
      }
      // gh GraphQL can fail with useful partial JSON on stdout. The shared
      // transport must remove its added headers on failures as well as success.
      if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') {
        error.stdout = stripHeaders(error.stdout);
      }
      throw error;
    }
  }
}

const sharedBudget = new GitHubRequestBudget();
export const executeGitHubRequest = (args: string[], options?: GitHubRequestOptions): Promise<{ stdout: string }> =>
  sharedBudget.execute(args, options);
