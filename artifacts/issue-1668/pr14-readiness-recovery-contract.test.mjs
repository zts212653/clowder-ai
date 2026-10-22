// Independent contract tests against the author checkout source via tsx.
// Synthetic ACP client, temporary HOME, no native process/provider/store/UI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'Use the isolated test HOME wrapper');
const author = resolve(import.meta.dirname, '../../../feat-issue-1668-acp-credentials');
const expectedHead = 'a26b79f7fe9de3d807882f6c8e1d75aa5db7c913';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: author, encoding: 'utf8' }).trim(), expectedHead);
const serviceFile = 'packages/api/src/domains/cats/services/agents/providers/acp/AcpAgentService.ts';
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', serviceFile,
  'packages/api/src/domains/cats/services/types.ts'], { cwd: author, encoding: 'utf8' });
const directory = resolve(author, 'packages/api/src/domains/cats/services/agents/providers/acp');
const { AcpAgentService } = await import(pathToFileURL(resolve(directory, 'AcpAgentService.ts')).href);
const { AcpProtocolError } = await import(pathToFileURL(resolve(directory, 'AcpClient.ts')).href);
const cwd = process.cwd();

function fixture() {
  let missingKey = true;
  const client = {
    promptCapabilities: {},
    onCapacity() {}, offCapacity() {}, clearRecentCapacitySignal() {},
    async newSession() {
      if (missingKey) throw new AcpProtocolError(-32603, 'llm-deepseek: no API key for provider route "deepseek-official"');
      return { sessionId: 'synthetic-recovery-session' };
    },
    async *promptStream() {
      yield { sessionId: 'synthetic-recovery-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic success' },
      } };
    },
  };
  return {
    service: new AcpAgentService({
      catId: 'review-fixture',
      pool: { async acquire() { return { client, release() {} }; } },
      poolKey: {}, projectRoot: cwd, mcpSupport: false, providerName: 'acp',
    }),
    fixCredentials() { missingKey = false; },
  };
}

async function invoke(service, options) {
  const messages = [];
  for await (const message of service.invoke('synthetic recovery check', options)) messages.push(message);
  return messages;
}

test('confirmed credential failure is observable for the current string member revision', async () => {
  const { service } = fixture();
  const messages = await invoke(service, { workingDirectory: cwd });
  assert.equal(messages.find(m => m.type === 'error')?.errorCode, 'credential_required');
  const snapshot = service.connectionReadiness({ memberRevision: 'synthetic-current-member-revision', cwd });
  assert.equal(snapshot.status, 'credential_required', 'Current revision lookup must see the recorded failure');
});

test('a successful explicit retry clears the actual previously recorded failure identity', async () => {
  const { service, fixCredentials } = fixture();
  await invoke(service, { workingDirectory: cwd });
  // Characterize the current source producer identity, without endorsing revision 0.
  const scope = { memberRevision: 0, cwd };
  assert.equal(service.connectionReadiness(scope).status, 'credential_required');
  fixCredentials();
  const messages = await invoke(service, { workingDirectory: cwd });
  assert.equal(messages.some(m => m.type === 'error'), false, 'Retry fixture must actually succeed');
  assert.ok(messages.some(m => m.type === 'text' && m.content === 'synthetic success'));
  assert.equal(service.connectionReadiness(scope).status, 'ready', 'Successful retry must clear the old failure');
});

test('the default working directory records the same confirmed failure', async () => {
  const { service } = fixture();
  const messages = await invoke(service);
  assert.equal(messages.find(m => m.type === 'error')?.errorCode, 'credential_required');
  assert.equal(service.connectionReadiness({ memberRevision: 0, cwd }).status, 'credential_required',
    'An omitted workingDirectory uses projectRoot and must still produce an observation');
});
