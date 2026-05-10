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

function inlineProbeServerCode(workdir) {
  return [
    `process.chdir(${JSON.stringify(workdir)});`,
    "process.stdin.setEncoding('utf8');",
    "let buffer = '';",
    "function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() ?? '';",
    '  for (const line of lines) {',
    '    if (!line.trim()) continue;',
    '    const msg = JSON.parse(line);',
    "    if (msg.method === 'initialize') {",
    "      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'install-probe-test-server', version: '1.0.0' } } });",
    "    } else if (msg.method === 'tools/list') {",
    "      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'probe_echo', description: 'Probe test tool', inputSchema: { type: 'object', properties: {} } }] } });",
    '      setTimeout(() => process.exit(0), 10);',
    '    }',
    '  }',
    '});',
  ].join(' ');
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

// ── Redacted payload safeguard ─────────────────────────────

describe('MCP install — redacted payload rejection', () => {
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

  it('rejects payload with redacted placeholder in args', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { id: 'test-mcp', command: 'npx', args: ['-s', '••••••'] },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /redacted/i);
  });

  it('rejects payload with redacted placeholder in url', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { id: 'test-http', transport: 'streamableHttp', url: 'http://example.com?token=••••••' },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /redacted/i);
  });

  it('rejects payload with redacted placeholder in env', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { id: 'test-env', command: 'node', env: { API_KEY: '••••••' } },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /redacted/i);
  });

  it('rejects payload with redacted placeholder in headers', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        id: 'test-hdr',
        transport: 'streamableHttp',
        url: 'http://example.com',
        headers: { Authorization: '••••••' },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /redacted/i);
  });

  it('update preserves existing args when payload omits them', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'preserve-test',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            transport: 'stdio',
            command: 'npx',
            args: ['-s', 'real-secret-value', 'serve'],
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { id: 'preserve-test', command: 'npx-v2' },
    });
    assert.equal(res.statusCode, 200);

    const config = await readCapabilitiesConfig(dir);
    const cap = config.capabilities.find((c) => c.id === 'preserve-test');
    assert.equal(cap.mcpServer.command, 'npx-v2');
    assert.deepEqual(
      cap.mcpServer.args,
      ['-s', 'real-secret-value', 'serve'],
      'existing args must be preserved when not in payload',
    );
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

  it('probes the saved merged MCP after partial update', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);
    const probeCode = inlineProbeServerCode(process.cwd());
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'probe-merged-update',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            transport: 'stdio',
            command: 'node',
            args: ['--input-type=module', '--eval', probeCode],
            workingDir: process.cwd(),
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: { id: 'probe-merged-update', command: 'node' },
    });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.payload);
    assert.equal(body.probe?.connectionStatus, 'connected');
    assert.ok(
      body.probe.tools?.some((tool) => tool.name === 'probe_echo'),
      'probe should use preserved args from the saved capability',
    );
  });

  it('update merges headers instead of replacing them', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', undefined);
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [
        {
          id: 'header-merge',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            transport: 'streamableHttp',
            url: 'http://example.com/mcp',
            command: '',
            args: [],
            headers: { Authorization: 'Bearer old-token', 'X-Custom': 'keep-me' },
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        id: 'header-merge',
        transport: 'streamableHttp',
        url: 'http://example.com/mcp',
        headers: { Authorization: 'Bearer new-token' },
      },
    });
    assert.equal(res.statusCode, 200);

    const config = await readCapabilitiesConfig(dir);
    const cap = config.capabilities.find((c) => c.id === 'header-merge');
    assert.ok(cap?.mcpServer);
    assert.equal(cap.mcpServer.headers?.Authorization, 'Bearer new-token', 'updated header must reflect new value');
    assert.equal(cap.mcpServer.headers?.['X-Custom'], 'keep-me', 'unmentioned headers must be preserved');
  });
});

// ── Skill DELETE — owner gate ─────────────────────────────

describe('Skill DELETE — owner gate', () => {
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

  it('rejects non-owner with 403', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', OWNER);
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [{ id: 'ext-skill', type: 'skill', enabled: true, source: 'external' }],
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/capabilities/skill/ext-skill',
      headers: { 'x-cat-cafe-user': OTHER },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /owner/i);
  });

  it('allows owner to delete external skill', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', OWNER);
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [{ id: 'ext-skill', type: 'skill', enabled: true, source: 'external' }],
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/capabilities/skill/ext-skill',
      headers: { 'x-cat-cafe-user': OWNER },
    });

    assert.equal(res.statusCode, 200);
    const config = await readCapabilitiesConfig(dir);
    assert.ok(!config.capabilities.find((c) => c.id === 'ext-skill'));
    assert.ok(config.removedExternalSkills?.includes('ext-skill'));
  });

  it('rejects deletion of managed skill with 403', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', OWNER);
    await writeCapabilitiesConfig(dir, {
      version: 1,
      capabilities: [{ id: 'managed-skill', type: 'skill', enabled: true, source: 'cat-cafe' }],
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/capabilities/skill/managed-skill',
      headers: { 'x-cat-cafe-user': OWNER },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /managed/i);
  });
});
