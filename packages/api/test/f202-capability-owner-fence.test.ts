import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModuleSettingsHost } from '../src/domains/plugin/builtin-runtime/carriers/module-plugin-settings.js';
import { withCurrentOwnerOperation } from '../src/domains/plugin/carrier/plugin-owner-operation-context.js';

test('capability issuance rejects an expired inherited owner operation before calling the issuer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f202-owner-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const host = await createModuleSettingsHost(
    {
      pluginInstanceId: 'instance',
      packageRecord: {
        pluginId: 'fixture.plugin',
        manifest: {
          pluginId: 'fixture.plugin',
          features: [],
          configuration: [],
          runtime: { transport: 'builtin', dataDirectory: 'fixture-data' },
        },
      } as never,
    },
    {
      dataDirectoryParent: root,
      configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
      log: () => {},
      capabilityAccess: {
        issueExternal: async () => {
          calls += 1;
          return { token: 'issued' } as never;
        },
        inspectExternal: async () => ({ usable: true }) as never,
      },
    },
    async () => {},
  );
  const aborted = new AbortController();
  aborted.abort();
  const owner = {
    kind: 'owner-operation' as const,
    userId: 'owner',
    pluginInstanceId: 'instance',
    operationKey: 'connection',
    actionId: 'issue',
    requestId: 'request',
    signal: aborted.signal,
    assertCurrent: async () => {
      throw new Error('expired owner');
    },
    assertWriteCurrent: () => {
      throw new Error('expired owner');
    },
  };
  await assert.rejects(
    withCurrentOwnerOperation(owner, () =>
      host.capability!.issueExternal({ capabilityId: 'external', ttlSeconds: 60 }),
    ),
  );
  assert.equal(calls, 0);
});
