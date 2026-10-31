import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { KimiAgentService } from '../../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import {
  RegisteredSessionAgentService,
  selectSessionAgentService,
} from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { readSessionContractSettings } from '../../dist/domains/cats/services/agents/session-contract/session-contract-settings.js';
import { collect, FakeSessionProvider, options } from './fake-session-provider.js';

const bindings = JSON.stringify({ other: 'plugin:local.agent-session-reference/agent' });
for (const mode of [undefined, '', 'plugin'])
  for (const [branch, create] of [
    ['acp', () => new AcpAgentService({ catId: 'codex', pool: {}, poolKey: {}, projectRoot: '/tmp' })],
    ['client', () => new KimiAgentService({ catId: 'codex', model: 'test', rawArchive: {} })],
  ])
    test(`unbound ${branch} cat in ${mode ?? 'default'} uses the off service class/branch without bridge logs`, async (t) => {
      const logs = [];
      const calls = [];
      const registry = new SessionImplementationRegistry();
      const provider = new FakeSessionProvider();
      registry.register({ pluginId: 'local.agent-session-reference', contributionId: 'agent' }, () => provider);
      const select = (value) => {
        const settings = readSessionContractSettings({
          CAT_CAFE_AGENT_SESSION_CONTRACT: value,
          CAT_CAFE_AGENT_SESSION_BINDINGS: bindings,
        });
        return selectSessionAgentService(
          settings.bindings.get('codex'),
          (ref) => {
            calls.push('registered');
            return new RegisteredSessionAgentService({
              catId: 'codex',
              registry,
              ref,
              log: { info: (...a) => logs.push(a), warn() {} },
            });
          },
          () => {
            calls.push(branch);
            const service = create();
            t.mock.method(service, 'invoke', async function* () {
              yield { type: 'done' };
            });
            return service;
          },
        );
      };
      const off = select('off');
      const enabled = select(mode);
      assert.equal(enabled.constructor, off.constructor);
      assert.deepEqual(calls, [branch, branch]);
      await collect(enabled.invoke('x', options({ hostSessionId: 'host' })));
      assert.equal(
        logs.some((args) => args.includes('[session-contract] bridged')),
        false,
      );
      assert.equal(provider.calls.open.length, 0);
    });

test('bound cat chooses Registered service and logs bridging; off ignores the same binding', async () => {
  const registry = new SessionImplementationRegistry();
  const ref = { pluginId: 'local.agent-session-reference', contributionId: 'agent' };
  registry.register(ref, () => new FakeSessionProvider());
  const logs = [];
  for (const mode of [undefined, 'plugin', 'off']) {
    const settings = readSessionContractSettings({
      CAT_CAFE_AGENT_SESSION_CONTRACT: mode,
      CAT_CAFE_AGENT_SESSION_BINDINGS: JSON.stringify({ codex: 'plugin:local.agent-session-reference/agent' }),
    });
    const service = selectSessionAgentService(
      settings.bindings.get('codex'),
      (selected) =>
        new RegisteredSessionAgentService({
          catId: 'codex',
          ref: selected,
          registry,
          log: { info: (...a) => logs.push(a), warn() {} },
        }),
      () => undefined,
    );
    if (mode === 'off') assert.equal(service, undefined);
    else {
      assert.ok(service instanceof RegisteredSessionAgentService);
      await collect(service.invoke('x', options({ hostSessionId: 'host' })));
      await service.releaseAll('test');
    }
  }
  assert.equal(logs.filter((args) => args.includes('[session-contract] bridged')).length, 2);
});

test('syncAgentRegistry uses the tested selector with the existing ACP/client routes as fallback', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /const service = await selectSessionAgentService[\s\S]*?sessionContractSettings.bindings.get\(id\)/,
  );
  assert.ok(
    source.indexOf('selectSessionAgentService<') < source.indexOf("const acpConfig = config.carrier === 'acp'"),
  );
  assert.match(source, /if \(service\) agentRegistry.register\(id, service\)/);
});
