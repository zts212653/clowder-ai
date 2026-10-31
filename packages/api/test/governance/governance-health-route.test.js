import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { GOVERNANCE_PACK_VERSION } from '../../dist/config/governance/governance-pack.js';
import { GovernanceRegistry } from '../../dist/config/governance/governance-registry.js';

const ENV_KEYS = ['CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT'];
const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

describe('GET /api/governance/health', () => {
  let root;
  let workspace;
  let app;
  let previousCwd;
  let previousEnv;

  beforeEach(async () => {
    previousCwd = process.cwd();
    previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    root = await mkdtemp(join(tmpdir(), 'gov-health-route-'));
    const runtime = join(root, 'runtime');
    workspace = join(root, 'workspace');
    for (const directory of [runtime, workspace]) {
      await mkdir(join(directory, '.cat-cafe'), { recursive: true });
      await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');
    }
    await writeFile(join(runtime, '.cat-cafe/governance-registry.json'), JSON.stringify({ entries: [] }));
    process.env.CAT_CAFE_RUNTIME_ROOT = runtime;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspace;
    process.chdir(runtime);
    const { capabilitiesRoutes } = await import(`../../dist/routes/capabilities.js?health=${randomUUID()}`);
    app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    process.chdir(previousCwd);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('keeps missing identity and untrusted-origin headers rejected without reading the registry', async (t) => {
    const read = t.mock.method(GovernanceRegistry.prototype, 'read');
    for (const headers of [{}, { ...AUTH_HEADERS, origin: 'https://untrusted.example' }]) {
      const response = await app.inject({ method: 'GET', url: '/api/governance/health', headers });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'Identity required' });
    }
    assert.equal(read.mock.callCount(), 0);
  });

  it('uses one persistent-workspace snapshot for all 1001 projects and remains read-only', async (t) => {
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      projectPath: `/projects/project-${index}`,
      packVersion: index % 2 ? 'old' : GOVERNANCE_PACK_VERSION,
      syncedAt: index,
      checksum: 'fixture',
      confirmedByUser: true,
    }));
    const registryFile = join(workspace, '.cat-cafe/governance-registry.json');
    const original = JSON.stringify({ entries });
    await writeFile(registryFile, original);
    const read = t.mock.method(GovernanceRegistry.prototype, 'read');
    const response = await app.inject({ method: 'GET', url: '/api/governance/health', headers: AUTH_HEADERS });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(read.mock.callCount(), 1);
    assert.deepEqual(response.json(), {
      projects: entries.map((entry, index) => ({
        projectPath: entry.projectPath,
        status: index % 2 ? 'stale' : 'healthy',
        packVersion: entry.packVersion,
        lastSyncedAt: entry.syncedAt,
        findings: [],
      })),
    });
    assert.equal(await readFile(registryFile, 'utf8'), original);
    await writeFile(registryFile, JSON.stringify({ entries: [] }));
    const next = await app.inject({ method: 'GET', url: '/api/governance/health', headers: AUTH_HEADERS });
    assert.deepEqual(next.json(), { projects: [] });
    assert.equal(read.mock.callCount(), 2, 'a later request must use a fresh snapshot');
  });
});
