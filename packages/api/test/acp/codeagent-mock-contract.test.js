import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';

const fixture = fileURLToPath(new URL('../fixtures/codeagent-mock.mjs', import.meta.url));
const artifacts = resolve('artifacts/role-agent-refactor/codeagent-mock');
mkdirSync(artifacts, { recursive: true });
const provenance = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDirty:
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0,
  executable: process.execPath,
  executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  nodeVersion: process.version,
  fixtureSha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
  compiledClientSha256: createHash('sha256')
    .update(
      readFileSync(new URL('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js', import.meta.url)),
    )
    .digest('hex'),
};

async function open(t, config = {}, root = mkdtempSync(join(artifacts, 'isolated state '))) {
  const client = new AcpClient({
    command: process.execPath,
    args: [fixture, '--acp', '--state-dir', root],
    cwd: root,
    inheritParentEnv: false,
    env: { HOME: root, USERPROFILE: root },
    ...config,
  });
  const record = {
    ...provenance,
    task: 'role-agent-refactor-20261029-gpt-sol',
    owner: 'codex',
    mock: true,
    fixture,
    version: '0.1.0',
    stateRoot: root,
    programDirectory: dirname(process.execPath),
    ownerPid: process.pid,
    startedAt: new Date().toISOString(),
    case: t.name,
    nativeCredentialsUsed: false,
    networkUsed: false,
    ports: [],
    retention: 'current contract evidence',
  };
  const ledgerPath = join(root, `instance-${randomUUID()}.json`);
  writeFileSync(ledgerPath, JSON.stringify({ ...record, status: 'starting' }, null, 2));
  t.after(async () => {
    await client.close();
    writeFileSync(
      ledgerPath,
      JSON.stringify(
        {
          ...record,
          pid: client.pid,
          running: client.isAlive,
          status: 'closed-data-retained',
          stoppedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  });
  const initialized = await client.initialize();
  writeFileSync(ledgerPath, JSON.stringify({ ...record, pid: client.pid, status: 'running' }, null, 2));
  assert.equal(initialized.agentInfo.name, 'codeagent-mock');
  return { client, root };
}

async function collect(iterator) {
  const events = [];
  let result = await iterator.next();
  while (!result.done) {
    events.push(result.value.update);
    result = await iterator.next();
  }
  return { events, reason: result.value, text: events.map((event) => event.content?.text ?? '').join('') };
}

test('mock ACP handshake, identity text and persisted two-turn resume', { timeout: 15000 }, async (t) => {
  const first = await open(t);
  const session = await first.client.newSession();
  const one = await collect(first.client.promptStream(session.sessionId, 'Identity: review partner; task one'));
  assert.match(one.text, /current=Identity: review partner/);
  await first.client.close();
  const resumed = await open(t, {}, first.root);
  assert.equal((await resumed.client.loadSession(session.sessionId)).sessionId, session.sessionId);
  const two = await collect(resumed.client.promptStream(session.sessionId, 'task two'));
  assert.match(two.text, /previous=Identity: review partner; task one; current=task two/);
  assert.equal(two.reason, 'end_turn');
});

test('mock tool request without approval handler is denied and cannot write', { timeout: 15000 }, async (t) => {
  const { client, root } = await open(t);
  const session = await client.newSession();
  const result = await collect(client.promptStream(session.sessionId, '#tool'));
  assert.match(result.text, /permission=denied/);
  assert.equal(existsSync(join(root, 'mock-output.txt')), false);
  assert.ok(result.events.some((event) => event.status === 'failed'));
});

test('mock allow-only options cannot bypass missing approval handler', { timeout: 15000 }, async (t) => {
  const { client, root } = await open(t);
  const session = await client.newSession();
  assert.match((await collect(client.promptStream(session.sessionId, '#tool #allow-only'))).text, /denied/);
  assert.equal(existsSync(join(root, 'mock-output.txt')), false);
});

test('mock explicit approval allows only the isolated tool effect', { timeout: 15000 }, async (t) => {
  const { client, root } = await open(t, { permissionHandler: (_request, respond) => respond({ optionId: 'allow' }) });
  const session = await client.newSession();
  const result = await collect(client.promptStream(session.sessionId, '#tool'));
  assert.match(result.text, /permission=allowed/);
  assert.equal(existsSync(join(root, 'mock-output.txt')), true);
  assert.ok(result.events.some((event) => event.status === 'completed'));
});

test('mock broken approval handler cannot authorize the tool', { timeout: 15000 }, async (t) => {
  const { client, root } = await open(t, {
    permissionHandler: async () => {
      throw new Error('Approval unavailable');
    },
  });
  const session = await client.newSession();
  assert.match((await collect(client.promptStream(session.sessionId, '#tool'))).text, /denied/);
  assert.equal(existsSync(join(root, 'mock-output.txt')), false);
});

test(
  'mock cancel stays unconfirmed until the owned process is stopped before resume',
  { timeout: 15000 },
  async (t) => {
    const { client, root } = await open(t);
    const session = await client.newSession();
    const stream = client.promptStream(session.sessionId, '#wait');
    assert.match((await stream.next()).value.update.content.text, /waiting/);
    client.cancelSession(session.sessionId);
    await assert.rejects(collect(stream), { code: 'SESSION_CANCELLED' });
    assert.equal(client.isSessionSafeForReuse(session.sessionId), false);
    await client.close();
    assert.equal(client.isAlive, false);
    const resumed = await open(t, {}, root);
    await resumed.client.loadSession(session.sessionId);
    assert.equal((await collect(resumed.client.promptStream(session.sessionId, 'next'))).reason, 'end_turn');
  },
);

test('mock disconnection is a failed turn, never a successful completion', { timeout: 15000 }, async (t) => {
  const { client } = await open(t);
  const session = await client.newSession();
  await assert.rejects(collect(client.promptStream(session.sessionId, '#disconnect')));
  assert.equal(client.isAlive, false);
});
