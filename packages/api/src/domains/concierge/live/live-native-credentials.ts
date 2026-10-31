import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface LiveScope {
  userId: string;
  threadId: string;
  catId: string;
  callId: string;
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

/** Ephemeral projection only; InvocationRegistry and TurnExecutionStore remain authority. */
export class LiveNativeCredentials {
  private credentials?: { invocationId: string; callbackToken: string };
  private nativeThreadId?: string;
  private activeTurnId?: string;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();
  readonly path: string;

  private constructor(
    private readonly folder: string,
    private readonly scope: LiveScope,
  ) {
    this.path = join(folder, 'native-turn.json');
  }
  static async create(scope: LiveScope): Promise<LiveNativeCredentials> {
    if (!identifier(scope.callId)) throw new Error('Invalid Live call id');
    return new LiveNativeCredentials(await mkdtemp(join(tmpdir(), 'cat-cafe-live-credentials-')), scope);
  }
  async bind(env: Record<string, string>): Promise<void> {
    if (this.closed) throw new Error('Live credentials closed');
    if (
      env.CAT_CAFE_USER_ID !== this.scope.userId ||
      env.CAT_CAFE_THREAD_ID !== this.scope.threadId ||
      env.CAT_CAFE_CAT_ID !== this.scope.catId
    )
      throw new Error('Live invocation scope mismatch');
    const invocationId = env.CAT_CAFE_INVOCATION_ID;
    const callbackToken = env.CAT_CAFE_CALLBACK_TOKEN;
    if (!identifier(invocationId) || !identifier(callbackToken))
      throw new Error('Live invocation credentials unavailable');
    if (
      this.credentials &&
      (this.credentials.invocationId !== invocationId || this.credentials.callbackToken !== callbackToken)
    )
      throw new Error('Live invocation cannot be replaced');
    this.credentials = { invocationId, callbackToken };
    await this.write();
  }
  async started(nativeThreadId: string, nativeTurnId: string): Promise<void> {
    if (this.closed) throw new Error('Live credentials closed');
    if (!identifier(nativeThreadId) || !identifier(nativeTurnId)) throw new Error('Invalid Live native identity');
    if (this.nativeThreadId && this.nativeThreadId !== nativeThreadId) throw new Error('Live native thread changed');
    this.nativeThreadId = nativeThreadId;
    this.activeTurnId = nativeTurnId;
    await this.write();
  }
  async completed(nativeTurnId: string): Promise<void> {
    if (this.activeTurnId === nativeTurnId) this.activeTurnId = undefined;
    if (!this.closed) await this.write();
  }
  environment(): Record<string, string> {
    return {
      CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: this.path,
      CAT_CAFE_NATIVE_CONNECTION_ID: this.scope.callId,
      CAT_CAFE_DESKTOP_MODE: 'live-companion',
    };
  }
  matchesInvocation(query: { invocationId: string; catId: string; threadId: string }): boolean {
    return (
      !this.closed &&
      this.credentials?.invocationId === query.invocationId &&
      this.scope.catId === query.catId &&
      this.scope.threadId === query.threadId
    );
  }
  matchesNative(meta: unknown): boolean {
    if (!meta || typeof meta !== 'object') return false;
    const value = meta as Record<string, unknown>;
    const turn = value['x-codex-turn-metadata'] as Record<string, unknown> | undefined;
    return (
      !this.closed &&
      Boolean(this.credentials && this.activeTurnId) &&
      value.threadId === this.nativeThreadId &&
      turn?.thread_id === this.nativeThreadId &&
      turn?.turn_id === this.activeTurnId
    );
  }
  private write(): Promise<void> {
    const next = this.writes.then(async () => {
      if (this.closed) return;
      const projection = {
        v: 1,
        connectionId: this.scope.callId,
        nativeThreadId: this.nativeThreadId,
        turns: this.credentials && this.activeTurnId ? [{ nativeTurnId: this.activeTurnId, ...this.credentials }] : [],
      };
      const pending = `${this.path}.pending`;
      await writeFile(pending, JSON.stringify(projection), { mode: 0o600 });
      await rename(pending, this.path);
    });
    this.writes = next.catch(() => {});
    return next;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.activeTurnId = undefined;
    this.credentials = undefined;
    await this.writes;
    await rm(this.folder, { recursive: true, force: true });
  }
}
