/**
 * F170 regression: MCP install endpoint — owner gate, transport-aware merge,
 * GET response stripping env/headers.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { capabilitiesMcpWriteRoutes } from '../dist/routes/capabilities-mcp-write.js';

const OWNER = 'owner-user';
const OTHER = 'other-user';

const savedEnv = {};
function setEnv(key, value) {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-install-sec-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function buildApp(projectRoot) {
  const app = Fastify({ logger: false });
  await app.register(capabilitiesMcpWriteRoutes, {
    getProjectRoot: () => projectRoot,
    getCliConfigPaths: () => ({
      anthropic: join(projectRoot, '.mcp.json'),
      openai: join(projectRoot, '.codex', 'config.toml'),
      google: join(projectRoot, '.gemini', 'settings.json'),
      kimi: join(projectRoot, '.kimi', 'mcp.json'),
    }),
  });
  await app.ready();
  return app;
}

// ── Owner gate ──────────────────────────────────────────

describe('MCP install — owner gate', () => {
  /** @type {string} */ let dir;
  /** @type {import('fastify').FastifyInstance} */ let app;

  beforeEach(async () => {
    dir = makeTmpDir();
    app = await buildApp(dir);
  });
  afterEach(async () => {
    restoreEnv();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects non-owner when DEFAULT_OWNER_USER_ID is set', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', OWNER);

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': OTHER },
      payload: { id: 'test-mcp', command: 'echo', args: ['hello'] },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /owner/i);
  });

  it('allows owner when DEFAULT_OWNER_USER_ID is set', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', OWNER);

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': OWNER },
      payload: { id: 'test-mcp', command: 'echo', args: ['hello'] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).ok, true);
  });

  it('allows any authenticated user when DEFAULT_OWNER_USER_ID is not set', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': OTHER },
      payload: { id: 'test-mcp', command: 'echo', args: ['hello'] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).ok, true);
  });
});

// ── Transport-aware merge ───────────────────────────────

describe('MCP install — transport-aware merge', () => {
  /** @type {string} */ let dir;
  /** @type {import('fastify').FastifyInstance} */ let app;

  beforeEach(async () => {
    dir = makeTmpDir();
    app = await buildApp(dir);
  });
  afterEach(async () => {
    restoreEnv();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('switching stdio→http removes url/headers residue from stdio', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'switch-test',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            transport: 'stdio',
            command: 'old-cmd',
            args: [],
            url: 'http://stale.example.com',
            headers: { 'X-Stale': 'yes' },
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { id: 'switch-test', command: 'new-cmd', args: ['--flag'] },
    });
    assert.equal(res.statusCode, 200);

    const config = await readCapabilitiesConfig(dir);
    const cap = config.capabilities.find((c) => c.id === 'switch-test');
    assert.ok(cap?.mcpServer);
    assert.equal(cap.mcpServer.command, 'new-cmd');
    assert.deepEqual(cap.mcpServer.args, ['--flag']);
    assert.equal(cap.mcpServer.url, undefined, 'url must be cleaned for stdio transport');
    assert.equal(cap.mcpServer.headers, undefined, 'headers must be cleaned for stdio transport');
  });

  it('switching http→stdio removes resolver/workingDir residue from http', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'switch-test-2',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            transport: 'streamableHttp',
            url: 'http://old.example.com',
            command: '',
            args: [],
            resolver: 'stale-resolver',
            workingDir: '/tmp/stale',
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { id: 'switch-test-2', transport: 'streamableHttp', url: 'http://new.example.com' },
    });
    assert.equal(res.statusCode, 200);

    const config = await readCapabilitiesConfig(dir);
    const cap = config.capabilities.find((c) => c.id === 'switch-test-2');
    assert.ok(cap?.mcpServer);
    assert.equal(cap.mcpServer.url, 'http://new.example.com');
    assert.equal(cap.mcpServer.resolver, undefined, 'resolver must be cleaned for http transport');
    assert.equal(cap.mcpServer.workingDir, undefined, 'workingDir must be cleaned for http transport');
  });

  it('update preserves existing env/headers when not in payload', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'secret-test',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            transport: 'stdio',
            command: 'old-cmd',
            args: [],
            env: { SECRET_KEY: 'sk-keep-me' },
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { id: 'secret-test', command: 'new-cmd', args: ['--new'] },
    });
    assert.equal(res.statusCode, 200);

    const config = await readCapabilitiesConfig(dir);
    const cap = config.capabilities.find((c) => c.id === 'secret-test');
    assert.ok(cap?.mcpServer);
    assert.equal(cap.mcpServer.command, 'new-cmd');
    assert.equal(cap.mcpServer.env?.SECRET_KEY, 'sk-keep-me', 'existing env must be preserved');
  });
});
