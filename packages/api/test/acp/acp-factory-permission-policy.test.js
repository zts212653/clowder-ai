import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';

for (const transport of ['stdio', 'httpstream']) {
  for (const permissionPolicy of [undefined, 'deny', 'auto_allow']) {
    test(`Host factory auto policy reaches ${transport}: ${permissionPolicy ?? 'unspecified'}`, async (t) => {
      // Only policy projection is under test; no process is spawned and no Windows ACL claim is made.
      const previousMode = process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
      if (process.platform === 'win32') process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
      t.after(() => {
        if (previousMode === undefined) delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
        else process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = previousMode;
      });
      const root = mkdtempSync(join(tmpdir(), 'acp-factory-policy-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const pools = new Map();
      t.after(async () => Promise.all([...pools.values()].map((pool) => pool.closeAll())));
      const id = 'factory-policy-fixture';
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        bootstrapRoot: join(root, 'bootstrap'),
        profileId: id,
        effectiveModel: '',
        config: {
          id,
          clientId: 'acp',
          configurationSource: 'native_tool',
          defaultModel: '',
          mcpSupport: false,
          executionApproval: 'auto',
        },
        acpConfig: {
          command: process.execPath,
          startupArgs: [],
          transport,
          ...(transport === 'httpstream' ? { experimental: true } : {}),
          ...(permissionPolicy ? { permissionPolicy } : {}),
        },
        poolRegistry: pools,
        log: { info() {}, warn() {} },
      });
      assert.equal(service.executionApproval, 'auto');
      const client = pools.get(id).clientFactory();
      const responses = [];
      if (transport === 'stdio') {
        client.child = { stdin: { write: (line) => responses.push(JSON.parse(line)) } };
        t.after(() => {
          client.child = null;
        });
      } else
        client.sendAgentResponse = async (response) => {
          responses.push(response);
        };
      const allow = { optionId: 'yes', kind: 'allow_once', name: 'Allow' };
      const reject = { optionId: 'no', kind: 'reject_once', name: 'Reject' };
      for (const options of [[allow, reject], [allow]]) {
        await client.handleAgentRequest({
          jsonrpc: '2.0',
          id: `permission-${options.length}`,
          method: 'session/request_permission',
          params: { sessionId: 'fixture-session', options },
        });
        await new Promise(setImmediate);
        assert.deepEqual(
          responses.at(-1)?.result?.outcome,
          permissionPolicy === 'deny'
            ? options.length === 1
              ? { outcome: 'cancelled' }
              : { outcome: 'selected', optionId: 'no' }
            : { outcome: 'selected', optionId: 'yes' },
        );
      }
    });
  }
}
