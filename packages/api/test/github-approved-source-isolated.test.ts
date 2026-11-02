import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { APPROVAL, approvedScope } from '../src/scripts/github-approved-source/approved-scope.js';
import { approvedArchiveModules } from '../src/scripts/github-approved-source/archive.js';
import { freezeToNewFile, readWriterEvidence } from '../src/scripts/github-approved-source/export-source.js';
import { openIsolatedFixtureRead } from '../src/scripts/github-approved-source/read-port.js';

const run = promisify(execFile);
const archive = process.env.GITHUB_APPROVED_SOURCE_TEST_ARCHIVE;
test('writer proof rejects stale, active, public and extra-field evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-source-evidence-'));
  const path = join(directory, 'proof.json');
  const proof = {
    v: 1,
    observedAt: Date.now(),
    bootId: '05d9e06f-3d6b-49bf-8f10-57da3090ddf7',
    runningRevision: '936a5b62fc419539abd6567447cc54f64d2e7956',
    legacySchedulesRegistered: 0,
    githubInstalledInstances: 0,
    evidenceRefs: ['evidence:loaded-consumers', 'evidence:owner-plugin-get'],
  };
  try {
    await writeFile(path, JSON.stringify(proof), { mode: 0o600 });
    assert.match((await readWriterEvidence(path)).ref, /^sha256:/);
    const installedRecoveryInstance = {
      pluginId: 'official.github-operations',
      instanceId: 'pi_2033aea0-229d-4554-a309-7dca009ddd12',
      packageDigest: APPROVAL.archiveDigest,
      intent: 'disabled',
      live: 'stopped',
      recoveryMode: 'import-only',
    };
    await writeFile(path, JSON.stringify({ ...proof, githubInstalledInstances: 1, installedRecoveryInstance }));
    assert.match((await readWriterEvidence(path)).ref, /^sha256:/);
    for (const changed of [
      { ...installedRecoveryInstance, live: 'running' },
      { ...installedRecoveryInstance, intent: 'enabled' },
      { ...installedRecoveryInstance, packageDigest: 'wrong' },
      { ...installedRecoveryInstance, recoveryMode: '' },
    ]) {
      await writeFile(
        path,
        JSON.stringify({ ...proof, githubInstalledInstances: 1, installedRecoveryInstance: changed }),
      );
      await assert.rejects(readWriterEvidence(path));
    }
    await writeFile(path, JSON.stringify(proof));
    await assert.rejects(readWriterEvidence(path, proof.observedAt + 300001), /Refresh/);
    for (const changed of [
      { ...proof, githubInstalledInstances: 1 },
      { ...proof, password: 'must not be accepted' },
    ]) {
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(readWriterEvidence(path));
    }
    await writeFile(path, JSON.stringify(proof), { mode: 0o600 });
    const { chmod } = await import('node:fs/promises');
    await chmod(path, 0o644);
    await assert.rejects(readWriterEvidence(path), /private/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('only exact approved bytes may load the archived collectors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'github-source-invalid-'));
  try {
    const path = join(directory, 'wrong.tgz');
    await writeFile(path, 'not the approved module');
    await assert.rejects(approvedArchiveModules(path), /exact approved/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'approved packed collectors freeze an isolated backend with zero mutations and retained g27',
  { skip: !archive && 'Set explicit reviewed archive path for local operational rehearsal' },
  async () => {
    assert.ok(archive);
    const loaded = await approvedArchiveModules(archive);
    const directory = await mkdtemp(join(tmpdir(), 'github-source-fixture-'));
    const socket = join(directory, 'redis.sock');
    const cli = APPROVAL.redisCli;
    const server = spawn(
      '/opt/homebrew/Cellar/redis/8.4.0/bin/redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        socket,
        '--unixsocketperm',
        '700',
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
      ],
      { stdio: 'ignore' },
    );
    const exited = new Promise((resolve) => server.once('exit', resolve));
    const admin = async (...args: string[]) =>
      JSON.parse(
        (
          await run(cli, ['--json', '--no-auth-warning', '-s', socket, '--user', 'fixture-admin', ...args], {
            env: { ...process.env, REDISCLI_AUTH: 'fixture-admin-test' },
          })
        ).stdout,
      ) as unknown;
    try {
      for (let i = 0; ; i++) {
        try {
          if (JSON.parse((await run(cli, ['--json', '-s', socket, 'PING'])).stdout) === 'PONG') break;
        } catch {
          /* isolated socket not ready */
        }
        if (i === 100) throw new Error('Isolated Redis not ready');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await run(cli, [
        '--json',
        '-s',
        socket,
        'ACL',
        'SETUSER',
        'fixture-admin',
        'on',
        '>fixture-admin-test',
        '~*',
        '+@all',
      ]);
      const p = 'cat-cafe:';
      const setHash = (key: string, value: Record<string, string>) =>
        admin('HSET', p + key, ...Object.entries(value).flat());
      await setHash('task:fixture-pr', {
        id: 'fixture-pr',
        kind: 'pr_tracking',
        threadId: 'fixture-thread',
        subjectKey: 'pr:zts212653/clowder-ai#1605',
        userId: 'default-user',
        ownerCatId: 'codex61-sol',
        title: 'Private title',
        why: 'Private continuation',
        createdBy: 'historical',
        createdAt: '1',
        updatedAt: '2',
        status: 'doing',
        typedWaitRegistration: 'PRIVATE AUTHORITY',
        automationState: JSON.stringify({
          await: {
            v: 1,
            generation: 27,
            subjectRef: 'pr:zts212653/clowder-ai#1605',
            ownerFence: { kind: 'containing_task', generation: 27 },
            baseline: { capturedAt: 1, headSha: 'old' },
            continuation: {
              when: [{ kind: 'pr_head_changed' }],
              // biome-ignore lint/suspicious/noThenProperty: legacy typed-wait continuation contract
              then: 'Private continuation',
            },
            createdAt: 1,
          },
        }),
      });
      await admin('ZADD', `${p}tasks:kind:pr_tracking`, '1', 'fixture-pr');
      await setHash('thread:fixture-thread', { createdBy: 'default-user' });
      await setHash('msg:unrelated', { content: 'PRIVATE CHAT' });
      await setHash('task:outside', {
        id: 'outside',
        kind: 'pr_tracking',
        userId: 'default-user',
        threadId: 'fixture-thread',
        subjectKey: 'pr:another/project#1',
        automationState: 'OUTSIDE SCOPE',
      });
      await setHash('thread:historical-system', { createdBy: 'system' });
      await setHash('task:completed-eval', {
        id: 'completed-eval',
        kind: 'pr_tracking',
        userId: 'default-user',
        threadId: 'historical-system',
        subjectKey: 'pr:zts212653/clowder-ai#2101',
        status: 'done',
        automationState: '{}',
      });
      await admin('ZADD', `${p}tasks:kind:pr_tracking`, '0', 'completed-eval');
      // Server-side write denial supplements the client's exact command policy.
      // Test inspection still uses read-only TYPE/HGETALL; these are never passed
      // through the protected producer. DUMP ordering changes during hash rehash
      // even without writes, so compare actual fields and sorted-set values.
      await admin('ACL', 'SETUSER', 'default', '-@all', '+@read', '+ping', '+acl|whoami', '+select');
      const keys = (await admin('KEYS', `${p}*`)) as string[];
      const snapshot = () =>
        Promise.all(
          keys.sort().map(async (key) => {
            const type = await admin('TYPE', key);
            const value =
              type === 'hash'
                ? Object.entries((await admin('HGETALL', key)) as Record<string, string>).sort(([a], [b]) =>
                    a.localeCompare(b),
                  )
                : await admin('ZRANGE', key, '0', '-1', 'WITHSCORES');
            return [key, type, value];
          }),
        );
      const before = await snapshot();
      const scope = approvedScope(APPROVAL.sourceRef, 'fixture:no-writers');
      const signal = AbortSignal.timeout(30000);
      const port = await openIsolatedFixtureRead(
        cli,
        APPROVAL.redisCliSha256,
        socket,
        scope,
        loaded.modules.policy,
        signal,
      );
      await assert.rejects(port.reader.read('HMGET', `${p}task:outside`, 'automationState'), /Task.*scope/);
      for (const [command, ...args] of [
        ['SET', `${p}x`, '1'],
        ['DUMP', `${p}task:fixture-pr`],
        ['HMGET', `${p}msg:unrelated`, 'content'],
        ['HMGET', `${p}task:fixture-pr`, 'typedWaitRegistration'],
        ['HMGET', `${p}task:${APPROVAL.taskId}`, 'id'],
        ['SCAN', '0', 'MATCH', '*', 'COUNT', '256'],
      ]) {
        assert.ok(command);
        await assert.rejects(port.reader.read(command, ...args));
      }
      const output = join(directory, 'source.json');
      const result = await freezeToNewFile(output, scope, loaded.modules, async () => port, signal);
      const bytes = await readFile(output, 'utf8');
      const source = JSON.parse(bytes);
      assert.equal(source.snapshot.tasks[0].automationState.await.generation, 27);
      assert.equal(source.snapshot.tasks[0].automationState.await.baseline.headSha, 'old');
      assert.equal(result.counts.tasks, 1);
      assert.ok(!source.snapshot.tasks.some((task: { id: string }) => task.id === 'completed-eval'));
      assert.equal(result.readOnlyProof.writeCommands, 0);
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      assert.ok(!bytes.includes('PRIVATE AUTHORITY') && !bytes.includes('PRIVATE CHAT'));
      assert.deepEqual(await snapshot(), before);
      let connected = false;
      await assert.rejects(
        freezeToNewFile(
          output,
          scope,
          loaded.modules,
          async () => {
            connected = true;
            return port;
          },
          signal,
        ),
        /EEXIST/,
      );
      assert.equal(connected, false);
      // A completed record with an unsettled delivery must not be filtered out.
      // The fixture admin changes test input; the producer remains server-read-only.
      const pending = {
        v: 1,
        generation: 27,
        subjectRef: 'pr:zts212653/clowder-ai#1605',
        ownerFence: { kind: 'containing_task', generation: 27 },
        outcomeId: 'fixture-outcome',
        at: 1,
        reason: 'matched',
        delivery: 'pending',
        matched: [{ kind: 'pr_head_changed', delta: 'new head', sourceRef: 'github:fixture' }],
      };
      await setHash('task:completed-eval', { automationState: JSON.stringify({ waitOutcome: pending }) });
      await assert.rejects(
        loaded.modules.collectLegacyGitHubSource(port.reader, scope, signal),
        /Required GitHub destination ownership/,
      );
      await setHash('task:completed-eval', { status: 'doing', automationState: '{}' });
      await assert.rejects(
        loaded.modules.collectLegacyGitHubSource(port.reader, scope, signal),
        /Required GitHub destination ownership/,
      );
      // Missing persisted owner never borrows the system thread's authority.
      await admin('HDEL', `${p}task:completed-eval`, 'userId');
      await assert.rejects(port.reader.read('HMGET', `${p}task:completed-eval`, 'status'), /Task thread ownership/);
      await setHash('task:completed-eval', { userId: 'default-user', status: 'done', automationState: '{}' });
      await setHash('task:fixture-pr', { status: 'done', automationState: JSON.stringify({ waitOutcome: pending }) });
      const unsettled = join(directory, 'unsettled.json');
      const continued = await freezeToNewFile(unsettled, scope, loaded.modules, async () => port, signal);
      const continuedSource = JSON.parse(await readFile(unsettled, 'utf8'));
      assert.equal(continued.counts.tasks, 1);
      assert.equal(continuedSource.snapshot.tasks[0].automationState.waitOutcome.delivery, 'pending');
      assert.equal(continuedSource.snapshot.receipts[0].disposition, 'not-delivered');
      const binaryHash = createHash('sha256')
        .update(await readFile(cli))
        .digest('hex');
      assert.equal(binaryHash, APPROVAL.redisCliSha256);
    } finally {
      server.kill('SIGTERM');
      await exited;
      await loaded.release();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
