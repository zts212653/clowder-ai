import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_AUTH_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function loginIdentity(value: unknown): unknown[] {
  const auth = record(value);
  if (!auth) throw new Error('Invalid auth object');
  const tokens = record(auth.tokens);
  if (!tokens) return [auth.auth_mode, text(auth.OPENAI_API_KEY)];
  const payload = text(tokens.id_token)?.split('.')[1];
  const claims = payload ? record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))) : undefined;
  const account = record(claims?.['https://api.openai.com/auth']);
  const accountId = text(tokens.account_id) ?? text(account?.chatgpt_account_id);
  const userId = text(claims?.sub) ?? text(account?.chatgpt_user_id) ?? text(account?.user_id);
  if (!accountId && !userId) throw new Error('Missing login identity');
  // These claims distinguish a login, not individual rotated tokens. They are
  // only a cache discriminator; Codex remains the authentication authority.
  return [
    auth.auth_mode,
    accountId,
    userId,
    text(claims?.sid),
    typeof claims?.auth_time === 'number' ? claims.auth_time : undefined,
  ];
}

/** Observe file-backed CLI login changes without refreshing or copying credentials. */
export async function readCodexHostAuthIdentity(env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  const authPath = resolve(cwd ?? process.cwd(), home, 'auth.json');
  const digest = (identity: unknown): string =>
    createHash('sha256')
      .update(JSON.stringify([authPath, identity]))
      .digest('hex');
  try {
    // Nonblocking open and a fixed-size read also bound special/oversized files.
    // Follow symlinks: scoped Codex homes intentionally link their auth store.
    const file = await open(authPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_AUTH_BYTES) throw new Error('Unsupported auth file');
      const buffer = Buffer.alloc(MAX_AUTH_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_AUTH_BYTES) throw new Error('Oversized auth file');
      return digest(loginIdentity(JSON.parse(buffer.toString('utf8', 0, bytesRead))));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return digest('absent');
    // A partial write or unreadable store must never authorize stale warm reuse.
    // No credential data or filesystem error is emitted to logs or child env.
    return digest(['unavailable', randomUUID()]);
  }
}
