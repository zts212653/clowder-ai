import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withInvocationPluginMcpView } from '../../dist/config/capabilities/invocation-plugin-mcp-view.js';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';

for (const failureAt of [
  'lease',
  'new',
  'load',
  'prompt',
  'unrelated',
  'second-init',
  'load-fresh-fails',
  'required',
  'foreign',
  'override',
  'wrong-token',
]) {
  test(`optional plugin crash at ${failureAt} preserves the ACP prompt boundary and initialization budget`, async () => {
    let current = true;
    const capabilityId = 'plugin:fixture:broken';
    const broken = {
      name: capabilityId.replaceAll(':', '__'),
      command: process.execPath,
      args: ['--broken-plugin'],
      env: [{ name: 'CLOWDER_PLUGIN_ACTION_TOKEN', value: 'isolated-token' }],
      ...(failureAt === 'foreign' ? {} : { hostSource: 'plugin' }),
    };
    const core = { name: 'host-core', command: process.execPath, args: ['--host-core'], env: [] };
    const healthy = { ...broken, name: 'plugin__fixture__healthy', args: ['--healthy-plugin'] };
    const attempts = [];
    const prompts = [];
    const client = {
      async newSession(_cwd, servers) {
        attempts.push(servers.map(({ name }) => name));
        if (failureAt === 'unrelated') throw new Error('provider initialization failed');
        if (['new', 'required', 'foreign', 'override', 'wrong-token'].includes(failureAt) && attempts.length === 1) {
          current = false;
          throw new Error('ACP error -32603: Internal error');
        }
        if (['second-init', 'load-fresh-fails'].includes(failureAt)) {
          current = false;
          throw new Error('ACP error -32603: Internal error');
        }
        return { sessionId: 'isolated-session' };
      },
      async loadSession(_session, _cwd, servers) {
        attempts.push(servers.map(({ name }) => name));
        current = false;
        throw new Error('ACP error -32603: Internal error');
      },
      async *promptStream(_session, prompt) {
        prompts.push(prompt);
        if (failureAt === 'prompt') {
          current = false;
          throw new Error('prompt failed before first event');
        }
        yield { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'host works' } } };
      },
      onCapacity() {},
      offCapacity() {},
      cancelSession() {},
      clearRecentCapacitySignal() {},
    };
    const service = new AcpAgentService({
      catId: 'kimi',
      projectRoot: process.cwd(),
      mcpServers: [core, broken, healthy],
      poolKey: { projectPath: process.cwd(), providerProfile: 'issue1978-fixture' },
      pool: {
        async acquire() {
          if (failureAt === 'lease') current = false;
          return { client, release() {} };
        },
      },
    });
    const entry = (id, server, isCurrent) => ({
      capabilityId: id,
      pluginId: 'fixture',
      isCurrent,
      server: {
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      },
    });
    const original = entry(capabilityId, broken, () => current);
    if (failureAt === 'override') original.server.args = ['--registered-original'];
    if (failureAt === 'wrong-token') original.server.env.CLOWDER_PLUGIN_ACTION_TOKEN = 'other-activation-token';
    const frozen = await withInvocationPluginMcpView(() => service.captureInvocationOptions({}), {
      entries: [original, entry('plugin:fixture:healthy', healthy, () => true)],
    });
    const messages = [];
    for await (const message of service.invoke('read the Host', {
      ...frozen,
      ...(['load', 'load-fresh-fails'].includes(failureAt) ? { sessionId: 'old-session' } : {}),
      ...(failureAt === 'required'
        ? { toolExecutionPolicy: { mode: 'plugin_native', pluginInstanceId: 'instance', contributionId: 'broken' } }
        : {}),
    }))
      messages.push(message);

    const succeeds = ['lease', 'new', 'load'].includes(failureAt);
    assert.equal(prompts.length, succeeds || failureAt === 'prompt' ? 1 : 0);
    assert.equal(attempts.length, ['new', 'load', 'second-init', 'load-fresh-fails'].includes(failureAt) ? 2 : 1);
    if (succeeds) {
      assert.deepEqual(attempts.at(-1), [core.name, healthy.name]);
      assert.ok(messages.some((message) => message.content === 'host works'));
      assert.match(prompts[0], /plugin:fixture:broken/);
      assert.ok(!messages.some((message) => message.type === 'error'));
    } else {
      const failure = messages.find((message) => message.type === 'error');
      assert.ok(failure);
      if (failureAt !== 'prompt') assert.equal(failure.errorCode, 'init_failure');
    }
  });
}
