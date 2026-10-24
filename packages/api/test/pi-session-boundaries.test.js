import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isBuiltinPiBridgeArgs,
  piBridgeStorageArgs,
} from '../dist/domains/cats/services/agents/providers/pi/pi-bridge-launch.js';
import { PiRpcDiagnostics } from '../dist/domains/cats/services/agents/providers/pi/pi-rpc-diagnostics.js';
import { PiSessionStore } from '../dist/domains/cats/services/agents/providers/pi/pi-session-store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-session-boundary-'));
  return { root, store: new PiSessionStore({ root, scope: 'e'.repeat(64) }) };
}
test('Pi prompt-free sessions cannot be cold-loaded without actual native history', () => {
  const { root, store } = fixture();
  const slot = store.create(root, []);
  assert.throws(() => store.load(slot.id, root, []), /历史缺失/);
  assert.equal(readFileSync(join(slot.directory, 'binding.json'), 'utf8').includes('api_key'), false);
});
test('Pi exact load rejects duplicate native candidates and redirected history', (t) => {
  const { root, store } = fixture();
  const slot = store.create(root, []);
  const header = JSON.stringify({ type: 'session', version: 3, id: slot.id, cwd: root }) + '\n';
  writeFileSync(join(slot.directory, 'first.jsonl'), header);
  writeFileSync(join(slot.directory, 'second.jsonl'), header);
  assert.throws(() => store.load(slot.id, root, []), /多个候选/);
  const next = store.create(root, []);
  const outside = join(root, 'outside.jsonl');
  writeFileSync(outside, JSON.stringify({ type: 'session', version: 3, id: next.id, cwd: root }) + '\n');
  try {
    symlinkSync(outside, join(next.directory, 'linked.jsonl'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('file symlinks require platform privilege');
    throw error;
  }
  assert.throws(() => store.load(next.id, root, []), /regular file/);
});
test('Pi storage traversal cannot follow a junction below the owner-selected root', () => {
  const { root, store } = fixture();
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'native-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.create(root, []), /redirect/);
});
test('Host injects distinct persistent scopes only into the exact builtin Pi launch', () => {
  const entry = fileURLToPath(
    new URL('../dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js', import.meta.url),
  );
  const args = [entry, '--pi-command', process.execPath];
  const env = { PI_CODING_AGENT_DIR: join(tmpdir(), 'pi-profile') };
  const first = piBridgeStorageArgs(process.execPath, args, ['project', 'member-a', 'profile', 'native'], env);
  const same = piBridgeStorageArgs(process.execPath, args, ['project', 'member-a', 'profile', 'native'], env);
  const other = piBridgeStorageArgs(process.execPath, args, ['project', 'member-b', 'profile', 'native'], env);
  assert.deepEqual(first, same);
  assert.notEqual(first.at(-1), other.at(-1));
  assert.equal(isBuiltinPiBridgeArgs(first), true);
  assert.equal(isBuiltinPiBridgeArgs([...first, '--extension', 'untrusted.js']), false);
  const external = ['external.js', '--pi-command', process.execPath];
  assert.equal(piBridgeStorageArgs(process.execPath, external, ['project'], env), external);
});
test('Pi diagnostics sanitize complete split chunks and discard oversized raw lines', () => {
  const diag = new PiRpcDiagnostics();
  const secret = ['sk', '-0123456789abcdefghijklmnopqrstuvwxyz'].join('');
  diag.write(Buffer.from(`api_key=${secret.slice(0, 10)}`));
  assert.equal(diag.context(), '');
  diag.write(Buffer.from(`${secret.slice(10)}\n`));
  assert.doesNotMatch(diag.context(), /0123456789|abcdefghijklmnopqrstuvwxyz/);
  assert.match(diag.context(), /REDACTED/);
  diag.write(Buffer.from('x'.repeat(20000) + secret));
  diag.write(Buffer.from('\nsafe failure\n'));
  assert.doesNotMatch(diag.context(), /sk-|xxx/);
  assert.match(diag.context(), /safe failure/);
  assert.ok(diag.context().length <= 1002);
});

test('Pi diagnostics suppress multiline PEM across chunks, oversized lines and incomplete blocks', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const body = pem
    .split('\n')
    .slice(1, -2)
    .join('')
    .match(/.{1,16}/g);
  for (const oversized of [false, true]) {
    for (const complete of [false, true]) {
      const diag = new PiRpcDiagnostics();
      const content = `before\n${oversized ? 'x'.repeat(20000) : ''}-----BEGIN PRIVATE KEY-----\n${body.join('\n')}\n${complete ? '-----END PRIVATE KEY-----\nafter\n' : ''}`;
      for (let i = 0; i < content.length; i += 7) diag.write(Buffer.from(content.slice(i, i + 7)));
      diag.end();
      assert.equal(
        body.some((line) => diag.context().includes(line)),
        false,
        'no raw private-key line survives',
      );
      assert.match(diag.context(), /PEM_REDACTED/);
      if (complete) assert.match(diag.context(), /after/);
      assert.ok(diag.context().length <= 1002);
    }
  }
});
