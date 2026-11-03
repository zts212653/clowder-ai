import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { InvocationServiceScope } from '../dist/domains/cats/services/agents/invocation/invocation-service-scope.js';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { AcpSessionProvider } from '../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

for (const kind of ['codex', 'acp', 'registered', 'label-control']) {
  test(`formal admission validates construction client identity for ${kind}`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/client-identity');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    mkdirSync(join(root, '.cat-cafe'));
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(root, 'cat-template.json'));
    writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [] }));
    const previous = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    const all = catRegistry.getAllConfigs(),
      catId = 'client-identity';
    catRegistry.register(catId, {
      ...all.kimi,
      id: catId,
      configurationSource: 'native_tool',
      accountRef: undefined,
      mcpSupport: false,
    });
    t.after(() => {
      if (previous === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previous;
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const concrete =
      kind === 'codex'
        ? new CodexAgentService({ catId, model: 'fixture-model' })
        : new AcpAgentService({
            catId,
            projectRoot: root,
            pool: {},
            poolKey: { projectPath: root, providerProfile: catId },
            mcpSupport: false,
            providerName: 'codex / icode / codeagent (display only)',
            clientId: kind === 'label-control' ? 'kimi' : 'openai',
          });
    let discoveries = 0;
    const capture = concrete.captureInvocationOptions.bind(concrete);
    concrete.captureInvocationOptions = async (input) => {
      discoveries++;
      return capture(input);
    };
    const scope = new InvocationServiceScope();
    t.after(() => scope.dispose());
    let service = concrete;
    if (kind === 'registered') {
      const registry = new SessionImplementationRegistry();
      const ref = { pluginId: 'fixture-client', contributionId: 'agent' };
      const provider = new AcpSessionProvider({ catId, service: concrete });
      registry.register(ref, () => provider);
      service = new RegisteredSessionAgentService({ catId, ref, registry });
    }
    const pending = prepareInvocationExecutionBinding(
      { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
      { catId, threadId: 'thread', userId: 'owner', service: scope.pin(service) },
    );
    if (kind === 'label-control') {
      const binding = await pending;
      assert.equal(
        binding.implementation.clientId,
        'kimi',
        'display/model/command labels do not establish client identity',
      );
      assert.equal(discoveries, 1);
    } else {
      await assert.rejects(
        pending,
        (error) => error.statusCode === 409 && /execution_client_changed/.test(error.message),
      );
      assert.equal(discoveries, 0, 'wrong-client configuration must be rejected before provider discovery');
    }
  });
}
