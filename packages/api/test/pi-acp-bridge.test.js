import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PiAcpBridge } from '../dist/domains/cats/services/agents/providers/pi/pi-acp-bridge.js';

const fakePi = fileURLToPath(new URL('./helpers/pi-rpc-fixture.mjs', import.meta.url));
async function fixture(run, { shim = false, unknownModel = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi acp bridge-'));
  if (unknownModel) writeFileSync(join(root, 'unknown-model'), 'yes');
  const outputs = [];
  let command = process.execPath,
    args = [fakePi, root];
  if (shim) {
    const packageRoot = join(root, 'node_modules/fake-pi');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(packageRoot, 'cli.js'),
      `process.argv.splice(2, 0, ${JSON.stringify(root)}); await import(${JSON.stringify(pathToFileURL(fakePi).href)});`,
    );
    command = join(root, 'pi.cmd');
    args = [];
    writeFileSync(command, '@ECHO OFF\r\nnode "%~dp0%\\node_modules\\fake-pi\\cli.js" %*\r\n');
  }
  const state = mkdtempSync(join(tmpdir(), 'pi-native-state-'));
  const bridge = new PiAcpBridge(command, args, (value) => outputs.push(value), { root: state, scope: 'c'.repeat(64) });
  const request = async (id, method, params = {}) => {
    await bridge.handle({ jsonrpc: '2.0', id, method, params });
    return outputs.find((item) => item.id === id);
  };
  try {
    await run({ root, outputs, bridge, request });
  } finally {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
}
async function until(check) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Fixture did not reach the expected observable state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('Pi adapter advertises only implemented capabilities and discovers opaque native models', () =>
  fixture(async ({ root, request }) => {
    const initialized = await request('i', 'initialize');
    assert.equal(initialized.result.agentCapabilities.loadSession, true);
    assert.equal(initialized.result.agentCapabilities.promptCapabilities.image, undefined);
    assert.equal(existsSync(join(root, 'started')), false, 'initialize does not start or authenticate Pi');
    const created = await request('s', 'session/new', { cwd: root, mcpServers: [] });
    const model = created.result.configOptions.find((option) => option.id === 'model');
    assert.equal(model.currentValue, '["fixture","native"]');
    assert.equal(model.options.length, 2);
    assert.doesNotMatch(JSON.stringify(created), /catalog-sensitive-sentinel/);
    const selected = await request('m', 'session/set_config_option', {
      sessionId: created.result.sessionId,
      configId: 'model',
      value: '["fixture","other"]',
    });
    assert.equal(selected.result.configOptions[0].currentValue, '["fixture","other"]');
    assert.ok((await request('x', 'session/load', { sessionId: created.result.sessionId })).error);
  }));

test('Pi unknown native state follows the CLI default without exposing an invalid model option', () =>
  fixture(
    async ({ root, request }) => {
      const created = await request('s', 'session/new', { cwd: root, mcpServers: [] });
      assert.equal(created.error, undefined);
      assert.equal(
        created.result.configOptions.some((option) => option.id === 'model'),
        false,
      );
      const sessionId = created.result.sessionId;
      const prompted = await request('p', 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      });
      assert.equal(prompted.error, undefined);
      assert.equal(prompted.result.stopReason, 'end_turn');
    },
    { unknownModel: true },
  ));

test('Pi prompt waits beyond admission and agent_end until agent_settled, without duplicated text', () =>
  fixture(async ({ root, outputs, bridge, request }) => {
    const sessionId = (await request('s', 'session/new', { cwd: root, mcpServers: [] })).result.sessionId;
    const pending = bridge.handle({
      id: 'p',
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hold' }] },
    });
    await until(() => outputs.some((item) => item.params?.update?.sessionUpdate === 'agent_message_chunk'));
    assert.equal(
      outputs.some((item) => item.id === 'p'),
      false,
    );
    writeFileSync(join(root, 'release'), 'yes');
    await pending;
    assert.equal(outputs.find((item) => item.id === 'p').result.stopReason, 'end_turn');
    assert.deepEqual(
      outputs
        .filter((item) => item.params?.update?.sessionUpdate === 'agent_message_chunk')
        .map((item) => item.params.update.content.text),
      ['42\u2028still one record'],
    );
    assert.ok(outputs.some((item) => item.params?.update?.sessionUpdate === 'tool_call'));
    assert.ok(outputs.some((item) => item.params?.update?.sessionUpdate === 'agent_thought_chunk'));
  }));

test('Pi accepted prompt provider errors and child exits cannot become successful turns', () =>
  fixture(async ({ root, request }) => {
    for (const text of ['error', 'exit']) {
      const sessionId = (await request(`s-${text}`, 'session/new', { cwd: root, mcpServers: [] })).result.sessionId;
      const result = await request(`p-${text}`, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      assert.ok(result.error);
      assert.equal(result.result, undefined);
    }
  }));

test('Pi cancellation waits for its owned child to settle', () =>
  fixture(async ({ root, outputs, bridge, request }) => {
    const sessionId = (await request('s', 'session/new', { cwd: root, mcpServers: [] })).result.sessionId;
    const pending = bridge.handle({
      id: 'p',
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hold' }] },
    });
    await until(() => outputs.some((item) => item.params?.update?.sessionUpdate === 'agent_message_chunk'));
    await bridge.handle({ method: 'session/cancel', params: { sessionId } });
    await pending;
    assert.equal(outputs.find((item) => item.id === 'p').result.stopReason, 'cancelled');
  }));

test('Pi MCP injection is temporary and never replaces a user configuration file', () =>
  fixture(async ({ root, bridge, request }) => {
    const original = join(root, 'mcp.json');
    writeFileSync(original, '{"user":"untouched"}');
    await request('s', 'session/new', {
      cwd: root,
      mcpServers: [
        {
          name: 'cat-cafe',
          command: 'node',
          args: ['owned.js'],
          env: [{ name: 'TOKEN', value: 'test-sensitive-sentinel' }],
        },
      ],
    });
    const seen = JSON.parse(readFileSync(join(root, 'mcp-seen.json'), 'utf8'));
    assert.match(seen.name, /^clowder-[a-f0-9-]+-cat-cafe$/);
    assert.equal(seen.config.env.TOKEN, 'test-sensitive-sentinel');
    assert.equal(readFileSync(original, 'utf8'), '{"user":"untouched"}');
    assert.ok(existsSync(seen.entry));
    await bridge.close();
    assert.equal(existsSync(dirname(seen.entry)), false);
  }));

test('Pi rejects unsupported policy, mode, image and unadvertised model values before work', () =>
  fixture(async ({ root, request }) => {
    assert.ok(
      (await request('policy', 'session/new', { cwd: root, toolExecutionPolicy: { mode: 'read_only' } })).error,
    );
    assert.equal(existsSync(join(root, 'started')), false);
    const sessionId = (await request('s', 'session/new', { cwd: root, mcpServers: [] })).result.sessionId;
    assert.ok((await request('mode', 'session/set_mode', { sessionId, modeId: 'read_only' })).error);
    assert.ok(
      (await request('image', 'session/prompt', { sessionId, prompt: [{ type: 'image', data: 'xxx' }] })).error,
    );
    assert.ok(
      (
        await request('model', 'session/set_config_option', {
          sessionId,
          configId: 'model',
          value: 'invented/provider',
        })
      ).error,
    );
  }));

test(
  'Pi Windows npm shim starts through the existing system-Node spawn plan',
  { skip: process.platform !== 'win32' },
  () =>
    fixture(
      async ({ root, request }) => {
        const sessionId = (await request('s', 'session/new', { cwd: root, mcpServers: [] })).result.sessionId;
        const result = await request('p', 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'normal' }] });
        assert.equal(result.result.stopReason, 'end_turn');
      },
      { shim: true },
    ),
);

test('Pi extension dialogs are denied instead of silently granting tool permission or hanging', () =>
  fixture(async ({ root, request }) => {
    const sessionId = (await request('s', 'session/new', { cwd: root, mcpServers: [] })).result.sessionId;
    const result = await request('p', 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'ui' }] });
    assert.equal(result.result.stopReason, 'end_turn');
    const response = JSON.parse(readFileSync(join(root, 'ui-response.json'), 'utf8'));
    assert.equal(response.cancelled, true);
    assert.equal(response.confirmed, false);
  }));

test('the existing ACP host rejects read-only and other restricted tool policies before acquiring Pi', async () => {
  const { AcpAgentService } = await import('../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
  const { assertToolExecutionPolicySupported } = await import(
    '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js'
  );
  const service = new AcpAgentService({
    catId: 'pi-fixture',
    pool: {
      acquire() {
        throw new Error('must not acquire');
      },
    },
    poolKey: {},
    projectRoot: '.',
  });
  for (const mode of [
    'read_only',
    'workspace_write',
    'callback_allowlist',
    'collective_participation',
    'collective_work',
  ])
    assert.throws(() => assertToolExecutionPolicySupported(service, { mode }), /policy|策略/i);
});

test('Pi settled errors, rejected admission and handled commands remain idle and allow a same-session retry', () =>
  fixture(async ({ root, request }) => {
    for (const text of ['error', 'rejected', 'handled']) {
      const sessionId = (await request(`s-${text}`, 'session/new', { cwd: root, mcpServers: [] })).result.sessionId;
      const pid = Number(readFileSync(join(root, 'started'), 'utf8'));
      const result = await request(`p-${text}`, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      assert.ok(result.error);
      assert.equal(result.result, undefined);
      assert.doesNotThrow(() => process.kill(pid, 0), 'an idle native session must retain its conversation');
      const retry = await request(`retry-${text}`, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'normal' }],
      });
      assert.equal(retry.result.stopReason, 'end_turn');
      assert.equal(
        Number(readFileSync(join(root, 'started'), 'utf8')),
        pid,
        'retry must not secretly replace the conversation',
      );
    }
  }));

test('Pi supports more than eight sequential conversations and explicitly closes only the selected session', () =>
  fixture(async ({ root, request }) => {
    const ids = [];
    for (let n = 0; n < 9; n++) {
      const result = await request(`s-${n}`, 'session/new', { cwd: root, mcpServers: [] });
      assert.equal(result.error, undefined);
      ids.push(result.result.sessionId);
    }
    assert.deepEqual((await request('close', 'session/close', { sessionId: ids[0] })).result, {});
    assert.ok((await request('old', 'session/prompt', { sessionId: ids[0], prompt: [] })).error);
    assert.equal(
      (await request('other', 'session/prompt', { sessionId: ids[8], prompt: [{ type: 'text', text: 'normal' }] }))
        .result.stopReason,
      'end_turn',
    );
  }));

test('Pi local bridge failures remain prompt failures through the real ACP host classifier', () =>
  fixture(async ({ root, request }) => {
    const { AcpAgentService } = await import('../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
    const { AcpProtocolError } = await import('../dist/domains/cats/services/agents/providers/acp/AcpClient.js');
    const sessionId = (await request('s', 'session/new', { cwd: root, mcpServers: [] })).result.sessionId;
    const failure = (await request('p', 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'handled' }] }))
      .error;
    const client = {
      promptCapabilities: {},
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
      cancelSession() {},
      async newSession() {
        return { sessionId: 'host-pi' };
      },
      async *promptStream() {
        throw new AcpProtocolError(failure.code, failure.message);
      },
    };
    const service = new AcpAgentService({
      catId: 'pi-fixture',
      pool: {
        async acquire() {
          return { client, release() {} };
        },
      },
      poolKey: {},
      projectRoot: root,
      mcpSupport: false,
      providerName: 'Pi',
    });
    const messages = [];
    for await (const message of service.invoke('task', { workingDirectory: root })) messages.push(message);
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error.errorCode, 'prompt_failure');
    assert.doesNotMatch(error.error, /容量不足/);
  }));
