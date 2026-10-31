import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AccountConfig, CodexLoginAttempt, CodexManagedAccount } from '@cat-cafe/shared';
import { readAccountStoreSnapshot } from './account-store-snapshot.js';
import { writeCatalogAccount } from './catalog-accounts.js';
import { findDuplicateCodexAccount } from './codex-account-duplicates.js';
import { readCodexAccountIdentity, sameCodexIdentity } from './codex-account-identity.js';
import { projectCodexAccountReuse } from './codex-account-reuse.js';
import { type CodexLoginDriver, nativeCodexLoginDriver } from './codex-login-driver.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from './codex-managed-layout.js';
import { assertCodexSharedStateRoots } from './codex-shared-state.js';

const ACTIVE = new Set(['preparing', 'queued', 'waiting']);
function processBirth(pid: number): string {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin', NODE_ENV: process.env.NODE_ENV ?? 'production' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}
export function codexLoginOwnerAlive(attempt: CodexLoginAttempt): boolean {
  const current = processBirth(attempt.ownerPid);
  if (current) return attempt.ownerStartedAt === 'unavailable' || current === attempt.ownerStartedAt;
  try {
    process.kill(attempt.ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
/** Persisted attempt facts live in the existing account store; only live native wires are in memory. */
export class CodexLoginManager {
  private readonly bootId = randomUUID();
  private readonly startedAt = processBirth(process.pid) || 'unavailable';
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: Array<{
    root: string;
    ref: string;
    attempt: CodexLoginAttempt;
  }> = [];
  private occupied = false;
  private closing = false;
  private readonly runs = new Set<Promise<void>>();
  constructor(private readonly driver: CodexLoginDriver = nativeCodexLoginDriver) {}

  read(root: string, ref: string): AccountConfig & { codex: CodexManagedAccount } {
    const account = readAccountStoreSnapshot(root).resolve(ref).account;
    if (!account?.codex || account.clientId !== 'openai' || account.authType !== 'oauth')
      throw new Error('codex_managed_account_required');
    const attempt = account.codex.attempt;
    if (attempt && ACTIVE.has(attempt.state) && attempt.ownerBootId !== this.bootId && !codexLoginOwnerAlive(attempt)) {
      const interrupted = {
        ...account,
        codex: { ...account.codex, attempt: { ...attempt, state: 'interrupted' as const, updatedAt: Date.now() } },
      };
      writeCatalogAccount(root, ref, interrupted);
      return interrupted;
    }
    if (attempt?.state === 'review' && attempt.identity) {
      // Read projection keeps a persisted review honest after another adoption/deletion.
      // Confirmation still rechecks before writing; a GET never adopts credentials.
      return {
        ...account,
        codex: {
          ...account.codex,
          attempt: { ...attempt, duplicateAccountRef: findDuplicateCodexAccount(root, ref, attempt.identity) },
        },
      };
    }
    if (attempt?.state === 'reused')
      return { ...account, codex: { ...account.codex, attempt: projectCodexAccountReuse(root, attempt) } };
    return account as AccountConfig & { codex: CodexManagedAccount };
  }
  start(root: string, ref: string): CodexLoginAttempt {
    if (this.closing) throw new Error('codex_login_interrupted');
    const current = this.read(root, ref);
    assertCodexSharedStateRoots(root, { layout: current.codex });
    const previous = current.codex.attempt;
    if (previous && ACTIVE.has(previous.state) && previous.ownerBootId !== this.bootId)
      throw new Error('codex_login_owned_by_live_service');
    if (previous && (ACTIVE.has(previous.state) || previous.state === 'review')) this.cancel(root, ref, previous.id);
    const layout = prepareCodexManagedLayout(current.codex, root);
    const id = randomUUID();
    const now = Date.now();
    const attempt: CodexLoginAttempt = {
      id,
      revision: (previous?.revision ?? 0) + 1,
      ownerBootId: this.bootId,
      ownerPid: process.pid,
      ownerStartedAt: this.startedAt,
      state: this.occupied ? 'queued' : 'preparing',
      credentialHome: join(dirname(layout.credentialHome), 'login-attempts', id, 'home'),
      createdAt: now,
      updatedAt: now,
    };
    writeCatalogAccount(root, ref, { ...current, codex: { ...layout, attempt } });
    this.queue.push({ root, ref, attempt });
    this.drain();
    return attempt;
  }
  cancel(root: string, ref: string, id: string): void {
    const current = this.read(root, ref);
    if (current.codex.attempt?.id !== id) throw new Error('codex_login_attempt_superseded');
    if (ACTIVE.has(current.codex.attempt.state) && current.codex.attempt.ownerBootId !== this.bootId)
      throw new Error('codex_login_owned_by_live_service');
    // A review has no live wire. It remains actionable after restart; callbacks still use
    // the stricter boot-owned update below and cannot revive this explicit cancellation.
    writeCatalogAccount(root, ref, {
      ...current,
      codex: {
        ...current.codex,
        attempt: { ...current.codex.attempt, state: 'canceled', updatedAt: Date.now() },
      },
    });
    this.controllers.get(id)?.abort(new Error('codex_login_canceled'));
  }
  confirm(root: string, ref: string, id: string): string {
    const current = this.read(root, ref);
    const attempt = current.codex.attempt;
    if (!attempt || attempt.id !== id || attempt.state !== 'review') throw new Error('codex_login_attempt_superseded');
    if (!attempt.identity || !sameCodexIdentity(attempt.identity, readCodexAccountIdentity(attempt.credentialHome)))
      throw new Error('codex_login_identity_changed');
    const duplicate = findDuplicateCodexAccount(root, ref, attempt.identity);
    if (duplicate) {
      writeCatalogAccount(root, ref, {
        ...current,
        codex: {
          ...current.codex,
          attempt: {
            ...attempt,
            duplicateAccountRef: duplicate,
            state: 'reused',
            updatedAt: Date.now(),
          },
        },
      });
      return duplicate;
    }
    if (current.codex.identity && !sameCodexIdentity(current.codex.identity, attempt.identity))
      throw new Error('codex_login_different_identity_requires_new_account');
    this.adopt(root, ref, attempt);
    return ref;
  }
  createFromReview(root: string, ref: string, id: string, note?: string): string {
    const current = this.read(root, ref);
    const attempt = current.codex.attempt;
    if (!attempt || attempt.id !== id || attempt.state !== 'review' || !attempt.identity)
      throw new Error('codex_login_attempt_superseded');
    if (findDuplicateCodexAccount(root, ref, attempt.identity))
      throw new Error('codex_login_duplicate_identity_use_existing');
    if (sameCodexIdentity(current.codex.identity, attempt.identity))
      throw new Error('codex_login_identity_use_current_account');
    if (!sameCodexIdentity(attempt.identity, readCodexAccountIdentity(attempt.credentialHome)))
      throw new Error('codex_login_identity_changed');
    const nextRef = `codex-${randomUUID()}`;
    const layout = prepareCodexManagedLayout(describeCodexManagedLayout(root, nextRef), root);
    writeCatalogAccount(root, nextRef, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: note?.trim() || 'Codex 账号',
      codex: { ...layout, attempt },
    });
    this.adopt(root, nextRef, attempt);
    this.cancel(root, ref, id);
    return nextRef;
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const queued of this.queue.splice(0))
      this.update(queued.root, queued.ref, queued.attempt, { state: 'interrupted' });
    for (const controller of this.controllers.values()) controller.abort(new Error('codex_login_interrupted'));
    await Promise.allSettled([...this.runs]);
  }
  private update(root: string, ref: string, original: CodexLoginAttempt, delta: Partial<CodexLoginAttempt>): boolean {
    const account = readAccountStoreSnapshot(root).resolve(ref).account;
    const attempt = account?.codex?.attempt;
    if (
      !account?.codex ||
      attempt?.id !== original.id ||
      attempt.revision !== original.revision ||
      attempt.ownerBootId !== this.bootId
    )
      return false;
    if (!ACTIVE.has(attempt.state) && attempt.state !== 'review') return false;
    writeCatalogAccount(root, ref, {
      ...account,
      codex: { ...account.codex, attempt: { ...attempt, ...delta, updatedAt: Date.now() } },
    });
    return true;
  }
  private adopt(root: string, ref: string, original: CodexLoginAttempt): void {
    const account = this.read(root, ref);
    assertCodexSharedStateRoots(root, { layout: account.codex });
    const attempt = account.codex.attempt;
    if (attempt?.id !== original.id || !attempt.identity || (!ACTIVE.has(attempt.state) && attempt.state !== 'review'))
      return;
    if (!sameCodexIdentity(attempt.identity, readCodexAccountIdentity(attempt.credentialHome)))
      throw new Error('codex_login_identity_changed');
    const duplicate = findDuplicateCodexAccount(root, ref, attempt.identity);
    if (duplicate) {
      this.update(root, ref, attempt, { state: 'review', duplicateAccountRef: duplicate });
      return;
    }
    const source = join(attempt.credentialHome, 'auth.json');
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink())
      throw new Error('codex_login_credentials_invalid');
    const temporary = join(account.codex.credentialHome, `.auth-${attempt.id}.tmp`);
    writeFileSync(temporary, readFileSync(source), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(account.codex.credentialHome, 'auth.json'));
    writeCatalogAccount(root, ref, {
      ...account,
      codex: {
        ...account.codex,
        identity: attempt.identity,
        attempt: { ...attempt, state: 'success', updatedAt: Date.now() },
      },
    });
  }
  private drain(): void {
    if (this.occupied || this.closing) return;
    const item = this.queue.shift();
    if (!item) return;
    const { root, ref, attempt } = item;
    // The account may have been canceled or deleted while another native login occupied
    // the callback port. The existing CAS safely skips it without requiring a live row.
    if (!this.update(root, ref, attempt, { state: 'preparing' })) {
      this.drain();
      return;
    }
    try {
      assertCodexSharedStateRoots(root, { layout: this.read(root, ref).codex });
    } catch {
      this.update(root, ref, attempt, {
        state: 'failed',
        error: '共享状态目录已改变，请恢复原目录配置后重试',
      });
      this.drain();
      return;
    }
    this.occupied = true;
    const controller = new AbortController();
    this.controllers.set(attempt.id, controller);
    let terminalOpened = false;
    const run = this.driver
      .run({
        home: attempt.credentialHome,
        cwd: root,
        signal: controller.signal,
        onReady: () => {
          terminalOpened = true;
          this.update(root, ref, attempt, { state: 'waiting' });
        },
      })
      .then((identity) => {
        if (!this.update(root, ref, attempt, { identity })) return;
        const account = this.read(root, ref);
        const duplicate = findDuplicateCodexAccount(root, ref, identity);
        if (duplicate || (account.codex.identity && !sameCodexIdentity(account.codex.identity, identity))) {
          this.update(root, ref, attempt, {
            state: 'review',
            ...(duplicate ? { duplicateAccountRef: duplicate } : {}),
          });
        } else this.adopt(root, ref, attempt);
      })
      .catch((error) => {
        this.update(root, ref, attempt, {
          state: controller.signal.aborted ? 'interrupted' : /timeout/.test(String(error)) ? 'timeout' : 'failed',
          error: /osascript|Terminal|terminal_open/.test(String(error))
            ? '未能唤起终端，请允许打开终端后重试'
            : /unsupported|policy_unavailable/.test(String(error))
              ? '当前原生版本或组织托管策略尚未支持，请核对账号类型与配置'
              : terminalOpened
                ? '官方登录未完成，请查看终端输出后在此重试'
                : '未能开始官方登录，请在此重试',
        });
      })
      .finally(() => {
        this.controllers.delete(attempt.id);
        this.occupied = false;
        this.runs.delete(run);
        this.drain();
      });
    this.runs.add(run);
  }
}
