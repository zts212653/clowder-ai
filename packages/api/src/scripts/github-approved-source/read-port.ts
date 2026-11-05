import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { APPROVAL, type SourceScope } from './approved-scope.js';

const execute = promisify(execFile);
export interface ReadPolicy {
  assertLegacyRead(scope: SourceScope, command: string, args: readonly string[]): void;
  assertLegacyScan(scope: SourceScope, args: readonly string[]): void;
}
interface ReadConnection {
  binary: string;
  binarySha256: string;
  connectionArgs: readonly string[];
  username: string;
}

async function assertTaskReadScope(
  read: (command: string, ...args: string[]) => Promise<unknown>,
  scope: SourceScope,
  key: string,
  requireDestination: boolean,
) {
  const metadata = await read('HMGET', key, 'id', 'kind', 'userId', 'threadId', 'subjectKey');
  if (!Array.isArray(metadata) || metadata.length !== 5) throw new Error('Task identity outside approved scope');
  const [id, kind, userId, threadId, subjectKey]: unknown[] = metadata;
  const subject = typeof subjectKey === 'string' ? /^(pr|issue):([^#]+)#[1-9]\d*$/.exec(subjectKey) : null;
  const repo = subject?.[2];
  if (
    id !== key.slice(`${scope.keyPrefix}task:`.length) ||
    !subject ||
    typeof repo !== 'string' ||
    kind !== (subject[1] === 'pr' ? 'pr_tracking' : 'issue_tracking') ||
    (userId !== null && userId !== scope.ownerUserId) ||
    !scope.repositories.includes(repo) ||
    typeof threadId !== 'string' ||
    !/^[A-Za-z0-9_.@-]{1,200}$/.test(threadId)
  )
    throw new Error('Task identity or repository outside approved scope');
  // Persisted Task.userId proves source ownership even when a completed Task's
  // old destination is a system/deleted thread. Only eligibility fields may use
  // that proof alone. Full records and all un-attributed legacy rows still need
  // the original thread owner before their contents can be read.
  if (
    (requireDestination || userId === null) &&
    (await read('HGET', `${scope.keyPrefix}thread:${threadId}`, 'createdBy')) !== scope.ownerUserId
  )
    throw new Error('Task thread ownership outside approved scope');
}

/** Internal transport: the only two callers select a fixed approved production
 * endpoint or an isolated test socket. There is no general operator Redis CLI. */
async function readPort(connection: ReadConnection, scope: SourceScope, policy: ReadPolicy, signal: AbortSignal) {
  const binary = await realpath(connection.binary);
  const info = await stat(binary);
  const digest = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  if (!info.isFile() || (info.mode & 0o022) !== 0 || digest !== connection.binarySha256)
    throw new Error('Approved Redis executable changed');
  const tally: Record<string, number> = Object.create(null);
  let commands = 0;
  const reader = {
    async read(command: string, ...args: string[]): Promise<unknown> {
      signal.throwIfAborted();
      if (command === 'SCAN') policy.assertLegacyScan(scope, args);
      else policy.assertLegacyRead(scope, command, args);
      // The archived collector rejects unrelated repositories only after its
      // full Task read. This approved transport must fence before reading any
      // non-identity Task fields, even for a repository later rejected by it.
      if (
        command === 'HMGET' &&
        args[0]?.startsWith(`${scope.keyPrefix}task:`) &&
        args.slice(1).some((f) => !['id', 'kind', 'userId', 'threadId', 'subjectKey'].includes(f))
      )
        await assertTaskReadScope(
          reader.read,
          scope,
          args[0],
          !args
            .slice(1)
            .every((f) => ['id', 'kind', 'userId', 'threadId', 'subjectKey', 'status', 'automationState'].includes(f)),
        );
      if (++commands > 50000) throw new Error('Source command bound exceeded');
      tally[command] = (tally[command] ?? 0) + 1;
      try {
        const { stdout } = await execute(
          binary,
          [
            '--json',
            '--no-auth-warning',
            ...connection.connectionArgs,
            '-n',
            '0',
            '--user',
            connection.username,
            command,
            ...args,
          ],
          { signal, timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } },
        );
        return JSON.parse(stdout) as unknown;
      } catch {
        signal.throwIfAborted();
        throw new Error('Protected read failed; server output and credentials withheld');
      }
    },
  };
  if ((await reader.read('PING')) !== 'PONG' || (await reader.read('ACL', 'WHOAMI')) !== connection.username)
    throw new Error('Existing Redis identity does not match approval');
  return {
    reader,
    proof: () => ({
      commands,
      tally: { ...tally },
      binarySha256: digest,
      identity: connection.username,
      writeCommands: 0,
      messageBodiesRead: false,
      authorityBodiesRead: false,
      serverAclProvenReadOnly: false,
    }),
  };
}

export function openApprovedProductionRead(scope: SourceScope, policy: ReadPolicy, signal: AbortSignal) {
  return readPort(
    {
      binary: APPROVAL.redisCli,
      binarySha256: APPROVAL.redisCliSha256,
      connectionArgs: ['-h', 'localhost', '-p', '6399'],
      username: 'default',
    },
    scope,
    policy,
    signal,
  );
}

/** Test harness only: no TCP, environment URL, production port or credentials. */
export function openIsolatedFixtureRead(
  binary: string,
  binarySha256: string,
  socket: string,
  scope: SourceScope,
  policy: ReadPolicy,
  signal: AbortSignal,
) {
  if (!socket.startsWith('/') || !socket.endsWith('/redis.sock'))
    throw new Error('Explicit isolated fixture socket required');
  return readPort({ binary, binarySha256, connectionArgs: ['-s', socket], username: 'default' }, scope, policy, signal);
}
