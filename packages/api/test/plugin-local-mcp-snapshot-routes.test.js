import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { capabilitiesRoutes } from '../dist/routes/capabilities.js';
import { capabilitySnapshotRoutes } from '../dist/routes/capability-snapshot.js';
import { fixture } from './helpers/alpha-plugin-runtime-fixture.js';

test('Console and member HTTP snapshots observe the same owner-enabled local plugin and its revocation', async (t) => {
  const f = await fixture(t, 'alpha');
  const id = `plugin:${f.pluginId}:native`;
  const saved = await readCapabilitiesConfig(f.capabilityProjectRoot);
  await writeCapabilitiesConfig(f.capabilityProjectRoot, {
    ...saved,
    capabilities: saved.capabilities.filter((item) => item.id !== id),
  });
  const canonical = join(f.capabilityProjectRoot, '.cat-cafe/capabilities.json');
  const before = await readFile(canonical, 'utf8');
  await f.mutate(true);
  const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  const previousDeployment = process.env.CAT_CAFE_DEPLOYMENT_ID;
  process.env.CAT_CAFE_CONFIG_ROOT = f.capabilityProjectRoot;
  process.env.CAT_CAFE_DEPLOYMENT_ID = 'alpha';
  const app = Fastify();
  try {
    const resolvePluginMcpView = () => f.runtime.supervisor.resolveMemberMcpView();
    await app.register(capabilitiesRoutes, { resolvePluginMcpView });
    await app.register(capabilitySnapshotRoutes, { mainRoot: f.capabilityProjectRoot, resolvePluginMcpView });
    const consoleResponse = await app.inject({
      url: '/api/capabilities',
      headers: { 'x-cat-cafe-user': 'fixture-user' },
    });
    const memberResponse = await app.inject({ url: '/api/capabilities/snapshot?catId=codex' });
    assert.equal(consoleResponse.statusCode, 200, consoleResponse.body);
    assert.equal(memberResponse.statusCode, 200, memberResponse.body);
    const consoleItem = consoleResponse.json().items.find((item) => item.id === id);
    const member = memberResponse.json();
    assert.equal(consoleItem?.accessManagedByPlugin, true);
    assert.equal(member.board.items.find((item) => item.id === id)?.accessManagedByPlugin, true);
    assert.equal(consoleResponse.json().envelope.revision, member.envelope.revision);
    assert.equal(consoleItem.mcpServer.command, undefined);
    assert.equal(consoleItem.mcpServer.env, undefined);

    const external = join(f.projectRoot, 'external');
    await mkdir(external);
    await writeCapabilitiesConfig(external, { version: 2, capabilities: [] });
    const outside = await app.inject({
      url: `/api/capabilities/snapshot?catId=codex&projectPath=${encodeURIComponent(external)}`,
    });
    assert.equal(outside.statusCode, 200, outside.body);
    assert.equal(
      outside.json().board.items.some((item) => item.id === id),
      false,
    );

    await f.mutate(false);
    const revoked = await app.inject({ url: '/api/capabilities/snapshot?catId=codex' });
    assert.equal(
      revoked.json().board.items.some((item) => item.id === id),
      false,
    );
    assert.equal(await readFile(canonical, 'utf8'), before);
    assert.equal(f.writes(), 0);
  } finally {
    await app.close();
    if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
    if (previousDeployment === undefined) delete process.env.CAT_CAFE_DEPLOYMENT_ID;
    else process.env.CAT_CAFE_DEPLOYMENT_ID = previousDeployment;
  }
});
