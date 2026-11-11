import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { AcpProtocolError } from '../src/domains/cats/services/agents/providers/acp/AcpClient.js';
import { captureAcpMcpSources } from '../src/domains/cats/services/agents/providers/acp/configuration/acp-mcp-source.js';
import { RedisDshMemberConnectionCheckStore } from '../src/domains/cats/services/stores/redis/RedisDshMemberConnectionCheckStore.js';
import { dshDefinitionOnlyServers, readDshToolManifest } from '../src/routes/dsh-tool-manifest.js';
import {
  dshConnectionFailureReason,
  registerDshMemberConnectionChecks,
} from '../src/routes/member-connection-check.js';

test('DSH checks retain the standard ACP error message when optional data is absent or unrelated', () => {
  for (const data of [undefined, { request_id: 'installed-alpha24-regression' }]) {
    assert.equal(
      dshConnectionFailureReason(
        new AcpProtocolError(-32603, 'Internal error: Invalid schema for function collective', data),
      ),
      'tool_schema_rejected',
    );
  }
});

test('DSH checks also recognize structured provider error data without inventing an unknown cause', () => {
  assert.equal(
    dshConnectionFailureReason(new AcpProtocolError(-32603, 'Internal error', { message: 'is not a "regex"' })),
    'tool_schema_rejected',
  );
  assert.equal(dshConnectionFailureReason(new Error('dsh_setup_credential_missing')), 'dsh_setup_credential_missing');
  assert.equal(dshConnectionFailureReason(new Error('unclassified fixture failure')), 'check_result_unknown');
});

function factStore() {
  const data = new Map<string, string>();
  return new RedisDshMemberConnectionCheckStore({
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string, mode?: string) => {
      if (mode === 'NX' && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
  } as unknown as RedisClient);
}

test('checks include activation-only plugins with the same member scope and invalidate after instance removal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-view-'));
  const beforeRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  t.after(() => {
    if (beforeRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = beforeRoot;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [] }));
  const name = 'plugin__fixture.collective__native';
  const definition = {
    name: 'collective_attachment',
    inputSchema: {
      type: 'object' as const,
      properties: { ref: { type: 'string', pattern: '^collective-attachment:' } },
    },
  };
  const server = dshDefinitionOnlyServers({ hash: 'fixture', servers: [{ name, tools: [definition] }] }, root)[0]!;
  assert.ok('command' in server);
  let present = true;
  let localRoot = root;
  let seen: Awaited<ReturnType<typeof readDshToolManifest>>['servers'] = [];
  let prompts = 0;
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest('sessionUserId', 'fixture-owner');
  registerDshMemberConnectionChecks(app, {
    store: factStore(),
    resolvePluginMcpView: async () => ({
      localCapabilityRoot: localRoot,
      entries: present
        ? [
            {
              capabilityId: 'plugin:fixture.collective:native',
              pluginId: 'fixture.collective',
              policySourceRef: 'fixture-installation',
              installationPolicy: {
                id: 'plugin:fixture.collective:native',
                pluginId: 'fixture.collective',
                name: 'Fixture',
                type: 'mcp' as const,
                source: 'plugin' as const,
                enabled: true,
                globalEnabled: true,
              },
              server: {
                command: server.command,
                args: server.args,
                env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
                transport: 'stdio' as const,
                workingDir: root,
              },
              isCurrent: () => true,
            },
          ]
        : [],
    }),
    resolveTarget: async (catId, projectRoot) => {
      const sources = await captureAcpMcpSources({
        projectRoot,
        userProjectRoot: projectRoot,
        catId,
        mcpSupport: true,
        mcpWhitelist: [],
      });
      const manifest = await readDshToolManifest(sources, root);
      seen = manifest.servers;
      return {
        configurationRevision: 'saved',
        effectiveFingerprint: 'member',
        toolManifestHash: manifest.hash,
        run: async () => {
          prompts += 1;
          return { outcome: 'passed' as const };
        },
      };
    },
  });
  const url = '/api/cats/member/connection-check';
  await app.inject({ method: 'GET', url });
  assert.deepEqual(
    seen,
    [{ name, tools: [definition] }],
    'current Host activation is present even though static capabilities are empty',
  );
  assert.equal(prompts, 0);
  assert.equal(
    (await app.inject({ method: 'POST', url, payload: { attemptId: randomUUID() } })).json().state,
    'passed',
  );
  present = false;
  assert.equal((await app.inject({ method: 'GET', url })).json().state, 'stale');
  present = true;
  localRoot = join(root, 'foreign-project');
  await app.inject({ method: 'GET', url });
  assert.equal(seen.length, 0, 'a foreign project does not acquire local plugins through global fallback');
  assert.equal(prompts, 1);
});

test('refresh is free, current tool hashes invalidate old results, and attempt replay does not bill again', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest('sessionUserId', 'fixture-owner');
  let calls = 0;
  let tools = 'schema-v1';
  registerDshMemberConnectionChecks(app, {
    store: factStore(),
    resolveTarget: async () => ({
      configurationRevision: 'saved-v1',
      effectiveFingerprint: 'member-and-auth-v1',
      toolManifestHash: tools,
      run: async () => {
        calls += 1;
        return { outcome: 'passed' as const };
      },
    }),
  });
  const url = '/api/cats/fixture/connection-check';
  assert.equal((await app.inject({ method: 'GET', url })).json().state, 'unchecked');
  assert.equal(calls, 0);
  const payload = { attemptId: randomUUID(), expectedRevision: 'saved-v1' };
  assert.equal((await app.inject({ method: 'POST', url, payload })).json().state, 'passed');
  assert.equal(calls, 1);
  assert.equal((await app.inject({ method: 'POST', url, payload })).json().state, 'passed');
  assert.equal(calls, 1);
  tools = 'schema-v2';
  assert.equal((await app.inject({ method: 'GET', url })).json().state, 'stale');
  assert.equal(calls, 1, 'schema refresh does not send another model prompt');
  const rejected = await app.inject({
    method: 'POST',
    url,
    payload: { ...payload, attemptId: randomUUID(), expectedRevision: 'old' },
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(calls, 1);
  const spoofed = await app.inject({ method: 'POST', url, payload: { ...payload, command: 'arbitrary' } });
  assert.equal(spoofed.statusCode, 400);
});

test('a restarted API projects a recorded started attempt as unknown and refuses a silent retry', async (t) => {
  const store = factStore();
  const app = Fastify();
  const restarted = Fastify();
  t.after(() => app.close());
  t.after(() => restarted.close());
  app.decorateRequest('sessionUserId', 'fixture-owner');
  restarted.decorateRequest('sessionUserId', 'fixture-owner');
  let entered!: () => void;
  let finish!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const resolveTarget = async () => ({
    configurationRevision: 'saved-v1',
    effectiveFingerprint: 'member-v1',
    toolManifestHash: 'tools-v1',
    run: async () => {
      calls += 1;
      entered();
      await pending;
      return { outcome: 'failed' as const, reasonCode: 'check_result_unknown' };
    },
  });
  registerDshMemberConnectionChecks(app, { store, resolveTarget });
  registerDshMemberConnectionChecks(restarted, { store, resolveTarget });
  const url = '/api/cats/fixture/connection-check';
  const payload = { attemptId: randomUUID(), expectedRevision: 'saved-v1' };
  const first = app.inject({ method: 'POST', url, payload }).then((response) => response);
  await began;
  assert.equal((await app.inject({ method: 'GET', url })).json().state, 'checking');
  assert.equal((await restarted.inject({ method: 'GET', url })).json().state, 'unknown');
  assert.equal((await restarted.inject({ method: 'POST', url, payload })).json().state, 'unknown');
  assert.equal(calls, 1);
  finish();
  assert.equal((await first).json().state, 'failed');
});
