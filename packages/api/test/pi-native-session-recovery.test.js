import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PiAcpBridge } from '../dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js';

const fake = fileURLToPath(new URL('./helpers/pi-rpc-fixture.mjs', import.meta.url));
const scope = 'a'.repeat(64);
const servers = (token, credentialFile = 'stable-file') => [
  {
    name: 'cat-cafe',
    command: process.execPath,
    args: [],
    env: [
      { name: 'CAT_CAFE_CREDENTIAL_FILE', value: credentialFile },
      { name: 'CAT_CAFE_CALLBACK_TOKEN', value: token },
    ],
  },
];
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'pi-native-recovery-'));
  const bridges = [];
  let sequence = 0;
  const make = (scopeId = scope) => {
    const output = [];
    const bridge = new PiAcpBridge(process.execPath, [fake, root], (value) => output.push(value), {
      root,
      scope: scopeId,
    });
    bridges.push(bridge);
    return {
      bridge,
      output,
      async request(method, params = {}) {
        const id = ++sequence;
        await bridge.handle({ id, method, params });
        return output.find((v) => v.id === id);
      },
    };
  };
  try {
    await run({ root, make });
  } finally {
    await Promise.all(bridges.map((b) => b.close()));
  }
  // Native state and auxiliary SQLite leases stay in the task-owned TMPDIR for inspection.
}
const prompt = (client, id, text) =>
  client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }] });

test('Pi checks native identity before sending a new prompt', () =>
  fixture(async ({ root, make }) => {
    const first = make();
    const created = await first.request('session/new', { cwd: root, mcpServers: [] });
    writeFileSync(join(root, 'changed-native-id'), 'simulate native switch');
    const reply = await prompt(first, created.result.sessionId, 'must not reach native prompt');
    assert.ok(reply.error);
    assert.equal(existsSync(join(root, 'seen-history.json')), false);
  }));

test('Pi anchors the first native file before its lazy creation and rejects a same-ID file switch', () =>
  fixture(async ({ root, make }) => {
    const client = make();
    const created = await client.request('session/new', { cwd: root, mcpServers: [] });
    const id = created.result.sessionId;
    const directory = join(root, 'native-sessions/pi/v1', scope, id);
    assert.equal(
      readdirSync(directory).some((name) => name.endsWith('.jsonl')),
      false,
      'Pi has not written yet',
    );
    writeFileSync(join(root, 'changed-native-file'), 'same ID, another file in the owned directory');
    const reply = await prompt(client, id, 'must not reach native prompt');
    assert.match(reply.error?.message ?? '', /exact native session/);
    assert.equal(existsSync(join(root, 'seen-history.json')), false, 'rejected before native prompt admission');
    assert.equal(
      readdirSync(directory).some((name) => name.endsWith('.jsonl')),
      false,
      'no new history was written',
    );
  }));

test('Pi cold load restores the exact native ID/history and keeps files across close', () =>
  fixture(async ({ root, make }) => {
    const first = make();
    assert.equal((await first.request('initialize')).result.agentCapabilities.loadSession, true);
    const session = (await first.request('session/new', { cwd: root, mcpServers: [] })).result;
    assert.match(session.sessionId, /^clowder-pi-v1-/);
    await prompt(first, session.sessionId, 'remember CEDAR1704');
    const dir = join(root, 'native-sessions/pi/v1', scope, session.sessionId);
    const file = join(
      dir,
      readdirSync(dir).find((n) => n.endsWith('.jsonl')),
    );
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    await first.bridge.close();
    assert.equal(existsSync(file), true);
    const second = make();
    const loaded = await second.request('session/load', { sessionId: session.sessionId, cwd: root, mcpServers: [] });
    assert.equal(loaded.error, undefined);
    assert.equal(loaded.result.sessionId, session.sessionId);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), hash);
    await prompt(second, session.sessionId, 'recall');
    assert.match(JSON.parse(readFileSync(join(root, 'seen-history.json'), 'utf8')).previous, /CEDAR1704/);
  }));

test('Pi current MCP token rotates through the same credential file with stable tool identity', () =>
  fixture(async ({ root, make }) => {
    const first = make();
    const id = (await first.request('session/new', { cwd: root, mcpServers: servers('old') })).result.sessionId;
    const before = JSON.parse(readFileSync(join(root, 'mcp-seen.json'), 'utf8'));
    assert.ok(
      (
        await first.request('session/load', {
          sessionId: id,
          cwd: root,
          mcpServers: servers('new', 'different-live-file'),
        })
      ).error,
      'a live native process must not silently keep stale MCP credentials',
    );
    await prompt(first, id, 'persist');
    await first.bridge.close();
    const second = make();
    const restored = await second.request('session/load', {
      sessionId: id,
      cwd: root,
      mcpServers: servers('new', 'fresh-file-after-host-restart'),
    });
    assert.equal(restored.error, undefined);
    const after = JSON.parse(readFileSync(join(root, 'mcp-seen.json'), 'utf8'));
    assert.equal(after.name, before.name);
    assert.equal(after.config.env.CAT_CAFE_CALLBACK_TOKEN, 'new');
    assert.ok((await second.request('session/load', { sessionId: id, cwd: root, mcpServers: [] })).error);
  }));

test('Pi rejects competing writers, allows concurrent same-bridge load and releases on close', () =>
  fixture(async ({ root, make }) => {
    const first = make();
    const id = (await first.request('session/new', { cwd: root, mcpServers: [] })).result.sessionId;
    await prompt(first, id, 'persist');
    const second = make();
    const params = { sessionId: id, cwd: root, mcpServers: [] };
    const busy = await second.request('session/load', params);
    assert.match(busy.error.message, /writer|写者|占用/i);
    assert.equal((await prompt(first, id, 'still alive')).result.stopReason, 'end_turn');
    await first.bridge.close();
    const results = await Promise.all([second.request('session/load', params), second.request('session/load', params)]);
    assert.ok(results.every((r) => r.result?.sessionId === id));
  }));

test('Pi refuses legacy, missing, corrupt and wrong-scope history without creating a replacement', () =>
  fixture(async ({ root, make }) => {
    const first = make();
    const id = (await first.request('session/new', { cwd: root, mcpServers: [] })).result.sessionId;
    await prompt(first, id, 'persist');
    await first.bridge.close();
    for (const sessionId of ['old-bridge-uuid', '../../escape', 'clowder-pi-v1-00000000-0000-4000-8000-000000000000']) {
      const reply = await make().request('session/load', { sessionId, cwd: root, mcpServers: [] });
      assert.ok(reply.error);
      assert.equal(reply.result, undefined);
    }
    assert.ok((await make('b'.repeat(64)).request('session/load', { sessionId: id, cwd: root, mcpServers: [] })).error);
    const dir = join(root, 'native-sessions/pi/v1', scope, id);
    const file = join(
      dir,
      readdirSync(dir).find((n) => n.endsWith('.jsonl')),
    );
    writeFileSync(file, 'invalid native history fixture');
    const reply = await make().request('session/load', { sessionId: id, cwd: root, mcpServers: [] });
    assert.ok(reply.error);
    assert.equal(readFileSync(file, 'utf8'), 'invalid native history fixture');
  }));

test('Pi refuses a damaged history body before the native loader can skip or repair it', () =>
  fixture(async ({ root, make }) => {
    const first = make();
    const id = (await first.request('session/new', { cwd: root, mcpServers: [] })).result.sessionId;
    await prompt(first, id, 'remember CEDAR1704');
    await first.bridge.close();
    const dir = join(root, 'native-sessions/pi/v1', scope, id);
    const file = join(
      dir,
      readdirSync(dir).find((name) => name.endsWith('.jsonl')),
    );
    const original = readFileSync(file, 'utf8');
    const nativePid = readFileSync(join(root, 'started'), 'utf8');
    const record = JSON.stringify({ type: 'message', message: { role: 'user', content: 'LF boundary' } });
    for (const tail of ['{"type":"message","id":"partial",', '\nnot-json\n', '\nnull\n', `\n${record}\r${record}\n`]) {
      const damaged = original + tail;
      writeFileSync(file, damaged);
      const reply = await make().request('session/load', { sessionId: id, cwd: root, mcpServers: [] });
      assert.ok(reply.error, 'damaged history must fail explicitly');
      assert.equal(reply.error.code, -32004);
      assert.equal(readFileSync(file, 'utf8'), damaged, 'neither repair nor replacement is allowed');
      assert.equal(readFileSync(join(root, 'started'), 'utf8'), nativePid, 'native loader must not run');
    }
    const crlf = original.replaceAll('\n', '\r\n');
    writeFileSync(file, crlf);
    assert.equal(
      (await make().request('session/load', { sessionId: id, cwd: root, mcpServers: [] })).result.sessionId,
      id,
      'failed validation releases the native writer lease',
    );
    assert.equal(readFileSync(file, 'utf8'), crlf, 'normal CRLF records remain loadable without rewriting');
  }));
