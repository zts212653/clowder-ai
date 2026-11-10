import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { AcpClient } from '../src/domains/cats/services/agents/providers/acp/AcpClient.js';
import { testDshConnection } from '../src/routes/dsh-setup-service.js';

test('explicit DSH verification applies the selected route/effort and closes on success or failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-connection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => mock.restoreAll());
  const model = '["custom","chosen"]';
  const calls: string[] = [];
  const options = [
    { id: 'model', category: 'model', currentValue: model, options: [{ value: model }] },
    { id: 'effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
  ];
  mock.method(AcpClient.prototype, 'initialize', async () => {
    calls.push('initialize');
  });
  mock.method(AcpClient.prototype, 'newSession', async () => ({ sessionId: 'test-session', configOptions: options }));
  mock.method(AcpClient.prototype, 'setSessionConfigOption', async (_id: string, key: string, value: string) => {
    calls.push(`${key}:${value}`);
    return {
      configOptions: options.map((option) => (option.id === key ? { ...option, currentValue: value } : option)),
    };
  });
  const prompt = mock.method(AcpClient.prototype, 'promptCollect', async () => {
    calls.push('prompt');
    return {
      stopReason: 'end_turn',
      events: [
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DSH_CONNECTION_OK' } } },
      ],
    };
  });
  mock.method(AcpClient.prototype, 'close', async () => {
    calls.push('close');
  });
  const launch = { command: join(root, 'dsh.cmd'), args: ['--profile', 'acp'], cwd: root };
  assert.deepEqual(await testDshConnection(launch, { model, effort: 'high' }), { sessionId: 'test-session' });
  assert.deepEqual(calls, ['initialize', 'effort:high', 'prompt', 'close']);
  const { readdirSync } = await import('node:fs');
  const guards = join(root, '.cat-cafe/native-guards');
  assert.match(readFileSync(join(guards, readdirSync(guards)[0]!), 'utf8'), /clowder-acp-model: \["custom","chosen"\]/);
  prompt.mock.mockImplementation(async () => {
    throw Error(
      'llm-deepseek: no API key for provider route "private"; store PRIVATE_KEY through the credentials service',
    );
  });
  await assert.rejects(testDshConnection(launch), /^Error: dsh_setup_credential_missing$/);
  assert.equal(calls.at(-1), 'close');
  prompt.mock.mockImplementation(async () => {
    throw Error('401 secret-private-key');
  });
  await assert.rejects(testDshConnection(launch), /^Error: dsh_setup_test_failed$/);
  mock.method(AcpClient.prototype, 'initialize', async () => {
    throw Error('process exited');
  });
  await assert.rejects(testDshConnection(launch), /^Error: dsh_setup_start_failed$/);
  assert.equal(calls.at(-1), 'close');
});
