import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { readAuditLog } from '../../../dist/config/capabilities/capability-audit.js';
import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../../../dist/config/capabilities/capability-orchestrator.js';
import { capabilitiesMcpWriteRoutes } from '../../../dist/routes/capabilities-mcp-write.js';

const HEADER_ONLY_OWNER_HEADERS = { 'x-cat-cafe-user': 'you' };
const OWNER_HEADERS = { 'x-test-session-user': 'you' };
const NON_OWNER_HEADERS = { 'x-test-session-user': 'codex' };
const LOCAL_OWNER_HEADERS = { ...OWNER_HEADERS, host: 'localhost:3004', origin: 'http://localhost:3003' };
const LOCAL_NON_OWNER_HEADERS = { ...NON_OWNER_HEADERS, host: 'localhost:3004', origin: 'http://localhost:3003' };
const REDACTED_SECRET = '••••••';

const savedEnv = new Map();

function setEnv(key, value) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv() {
  for (const [key, value] of savedEnv.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

function getCliConfigPaths(projectRoot) {
  return {
    google: join(projectRoot, '.gemini', 'settings.json'),
  };
}

async function buildApp(projectRoot) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) {
      request.sessionUserId = raw.trim();
    }
  });
  await app.register(capabilitiesMcpWriteRoutes, {
    getProjectRoot: () => projectRoot,
    getCliConfigPaths,
  });
  await app.ready();
  return app;
}

describe('capabilities MCP write routes', () => {
  let projectRoot;
  let app;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cap-mcp-write-'));
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeCapabilitiesConfig(projectRoot, { version: 1, capabilities: [] });
    setEnv('DEFAULT_OWNER_USER_ID', undefined);
    app = await buildApp(projectRoot);
  });

  afterEach(async () => {
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
    restoreEnv();
  });

  it('rejects non-owner install writes when DEFAULT_OWNER_USER_ID is configured', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_NON_OWNER_HEADERS,
      payload: {
        id: 'external-mcp',
        resolver: 'chrome-extension',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /owner/);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('rejects configured-owner MCP writes outside direct localhost Hub access', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { ...OWNER_HEADERS, host: 'staging.example.test' },
      payload: {
        id: 'external-mcp',
        resolver: 'chrome-extension',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /direct localhost/i);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('rejects local-looking MCP writes when the API is bound for LAN access', async () => {
    setEnv('API_SERVER_HOST', '0.0.0.0');

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_OWNER_HEADERS,
      payload: {
        id: 'external-mcp',
        resolver: 'chrome-extension',
      },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /direct localhost/i);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('rejects header-only identity for every MCP write route', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'secret-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'node', args: ['server.js'], env: { API_KEY: 'old-secret' } },
        },
      ],
    });

    const cases = [
      {
        method: 'POST',
        url: '/api/capabilities/mcp/preview',
        payload: { id: 'new-mcp', command: 'node', args: ['server.js'] },
      },
      {
        method: 'POST',
        url: '/api/capabilities/mcp/install',
        payload: { id: 'new-mcp', command: 'node', args: ['server.js'] },
      },
      {
        method: 'DELETE',
        url: '/api/capabilities/mcp/secret-mcp',
      },
      {
        method: 'PATCH',
        url: '/api/capabilities/mcp/secret-mcp/env',
        payload: { env: { API_KEY: 'new-secret' } },
      },
    ];

    for (const testCase of cases) {
      const res = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: HEADER_ONLY_OWNER_HEADERS,
        payload: testCase.payload,
      });
      assert.equal(res.statusCode, 401, `${testCase.method} ${testCase.url} should reject header-only identity`);
      assert.match(JSON.parse(res.payload).error, /session/i);
    }

    const config = await readCapabilitiesConfig(projectRoot);
    assert.equal(config?.capabilities.find((entry) => entry.id === 'secret-mcp')?.enabled, true);
    assert.ok(!config?.capabilities.some((entry) => entry.id === 'new-mcp'));
  });

  it('allows local MCP preview/install/delete when DEFAULT_OWNER_USER_ID is not configured', async () => {
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'secret-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: 'node', args: ['server.js'] },
        },
      ],
    });

    const preview = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/preview',
      headers: LOCAL_OWNER_HEADERS,
      payload: { id: 'new-mcp', command: 'node', args: ['server.js'] },
    });
    assert.equal(preview.statusCode, 200, preview.payload);

    const install = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_OWNER_HEADERS,
      payload: { id: 'new-mcp', command: 'node', args: ['server.js'] },
    });
    assert.equal(install.statusCode, 200, install.payload);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/capabilities/mcp/secret-mcp?hard=true',
      headers: LOCAL_OWNER_HEADERS,
    });
    assert.equal(deleteRes.statusCode, 200, deleteRes.payload);

    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config?.capabilities.some((entry) => entry.id === 'new-mcp'));
    assert.ok(!config?.capabilities.some((entry) => entry.id === 'secret-mcp'));
  });

  it('rejects non-local non-secret MCP install when DEFAULT_OWNER_USER_ID is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { ...OWNER_HEADERS, host: 'staging.example.test' },
      payload: { id: 'new-mcp', command: 'node', args: ['server.js'] },
    });

    assert.equal(res.statusCode, 403, res.payload);
    assert.match(JSON.parse(res.payload).error, /direct localhost/i);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('rejects ownerless MCP installs when loopback transport lacks local browser origin proof', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: { ...OWNER_HEADERS, host: 'localhost:3004' },
      payload: { id: 'new-mcp', command: 'node', args: ['server.js'] },
    });

    assert.equal(res.statusCode, 403, res.payload);
    assert.match(JSON.parse(res.payload).error, /direct localhost/i);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('rejects spoofed local Host headers on remote ownerless MCP installs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: {
        ...OWNER_HEADERS,
        host: 'localhost:3004',
        'x-forwarded-host': 'localhost:3004',
      },
      remoteAddress: '203.0.113.10',
      payload: { id: 'new-mcp', command: 'node', args: ['server.js'] },
    });

    assert.equal(res.statusCode, 403, res.payload);
    assert.match(JSON.parse(res.payload).error, /direct localhost/i);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('rejects forwarded ownerless MCP installs even when the proxy peer is loopback', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: {
        ...OWNER_HEADERS,
        host: 'localhost:3004',
        'x-forwarded-for': '203.0.113.10',
        'x-forwarded-host': 'localhost:3004',
        'x-forwarded-proto': 'https',
      },
      payload: { id: 'new-mcp', command: 'node', args: ['server.js'] },
    });

    assert.equal(res.statusCode, 403, res.payload);
    assert.match(JSON.parse(res.payload).error, /direct localhost/i);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('allows local secret-bearing MCP install when DEFAULT_OWNER_USER_ID is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_OWNER_HEADERS,
      payload: {
        id: 'secret-mcp',
        transport: 'streamableHttp',
        url: 'https://mcp.example.test',
        env: { API_KEY: 'new-secret' },
        headers: { Authorization: 'Bearer new-secret' },
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    // F249: sanitizeCapabilityForResponse returns raw values for frontend eye-toggle editing.
    // Response contains plaintext — frontend handles display masking.
    assert.equal(res.json().capability.mcpServer.env.API_KEY, 'new-secret');
    assert.equal(res.json().capability.mcpServer.headers.Authorization, 'Bearer new-secret');
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.id === 'secret-mcp');
    assert.equal(cap?.mcpServer?.env?.API_KEY, 'new-secret');
    assert.equal(cap?.mcpServer?.headers?.Authorization, 'Bearer new-secret');
  });

  it('allows local updates to MCPs that already store secrets without requiring DEFAULT_OWNER_USER_ID', async () => {
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'secret-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: 'node',
            args: ['old.js'],
            env: { API_KEY: 'real-secret' },
            headers: { Authorization: 'Bearer real-secret' },
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_OWNER_HEADERS,
      payload: {
        id: 'secret-mcp',
        command: 'node',
        args: ['new.js'],
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.id === 'secret-mcp');
    assert.deepEqual(cap?.mcpServer?.args, ['new.js']);
    assert.deepEqual(cap?.mcpServer?.env, { API_KEY: 'real-secret' });
    assert.deepEqual(cap?.mcpServer?.headers, { Authorization: 'Bearer real-secret' });
  });

  it('rejects non-owner MCP deletes when DEFAULT_OWNER_USER_ID is configured', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'external-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { resolver: 'chrome-extension' },
        },
      ],
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/capabilities/mcp/external-mcp?hard=true',
      headers: LOCAL_NON_OWNER_HEADERS,
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /owner/);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.equal(config?.capabilities[0]?.enabled, true);
  });

  it('rejects redacted placeholder values before writing MCP secrets', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_OWNER_HEADERS,
      payload: {
        id: 'secret-mcp',
        resolver: 'chrome-extension',
        env: { API_KEY: '••••••' },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.payload).error, /redacted/i);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('rejects redacted placeholder values in non-env install fields', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    const cases = [
      {
        id: 'redacted-command',
        command: `node-${'••••••'}`,
        args: ['server.js'],
      },
      {
        id: 'redacted-header',
        transport: 'streamableHttp',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer ••••••' },
      },
    ];

    for (const payload of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/capabilities/mcp/install',
        headers: LOCAL_OWNER_HEADERS,
        payload,
      });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /redacted/i);
    }

    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('preserves existing env and headers when updating an external MCP with omitted secret fields', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'secret-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: 'node',
            args: ['old.js'],
            env: { API_KEY: 'real-secret', KEEP: 'yes' },
            headers: { Authorization: 'Bearer real-secret' },
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_OWNER_HEADERS,
      payload: {
        id: 'secret-mcp',
        command: 'node',
        args: ['new.js'],
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.id === 'secret-mcp');
    assert.deepEqual(cap?.mcpServer?.env, { API_KEY: 'real-secret', KEEP: 'yes' });
    assert.deepEqual(cap?.mcpServer?.headers, { Authorization: 'Bearer real-secret' });
    assert.deepEqual(cap?.mcpServer?.args, ['new.js']);

    const audit = await readAuditLog(projectRoot);
    assert.equal(audit[0]?.action, 'update');
    assert.deepEqual(audit[0]?.after?.mcpServer?.env, { API_KEY: REDACTED_SECRET, KEEP: REDACTED_SECRET });
    assert.deepEqual(audit[0]?.after?.mcpServer?.headers, { Authorization: REDACTED_SECRET });
    const rawAudit = await readFile(join(projectRoot, '.cat-cafe', 'audit.jsonl'), 'utf-8');
    assert.doesNotMatch(rawAudit, /real-secret|Bearer real-secret/);
  });

  it('preserves existing stdio launch fields when updating an external MCP with omitted command and args', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'stdio-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            transport: 'stdio',
            command: 'npx',
            args: ['stdio-server', '--flag'],
            env: { API_KEY: 'real-secret' },
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_OWNER_HEADERS,
      payload: {
        id: 'stdio-mcp',
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.id === 'stdio-mcp');
    assert.equal(cap?.mcpServer?.command, 'npx');
    assert.deepEqual(cap?.mcpServer?.args, ['stdio-server', '--flag']);
    assert.deepEqual(cap?.mcpServer?.env, { API_KEY: 'real-secret' });
    assert.equal(res.json().capability.mcpServer.command, 'npx');
    assert.deepEqual(res.json().capability.mcpServer.args, ['stdio-server', '--flag']);
  });

  it('returns raw secrets in preview/install responses for frontend eye-toggle editing', async () => {
    // F249: sanitizeCapabilityForResponse returns raw values — frontend masks display.
    // Persisted config also stores raw values. Audit logs still use sanitizeCapabilityForAudit.
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    const payload = {
      id: 'secret-mcp',
      transport: 'streamableHttp',
      url: 'https://mcp.example.test',
      headers: { Authorization: 'Bearer install-secret' },
      env: { API_KEY: 'install-secret' },
    };

    const preview = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/preview',
      headers: LOCAL_OWNER_HEADERS,
      payload,
    });
    assert.equal(preview.statusCode, 200, preview.payload);
    assert.equal(preview.json().entry.mcpServer.headers.Authorization, 'Bearer install-secret');
    assert.equal(preview.json().entry.mcpServer.env.API_KEY, 'install-secret');

    const install = await app.inject({
      method: 'POST',
      url: '/api/capabilities/mcp/install',
      headers: LOCAL_OWNER_HEADERS,
      payload,
    });
    assert.equal(install.statusCode, 200, install.payload);
    assert.equal(install.json().capability.mcpServer.headers.Authorization, 'Bearer install-secret');
    assert.equal(install.json().capability.mcpServer.env.API_KEY, 'install-secret');

    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.id === 'secret-mcp');
    assert.equal(cap?.mcpServer?.headers?.Authorization, 'Bearer install-secret');
    assert.equal(cap?.mcpServer?.env?.API_KEY, 'install-secret');
  });

  it('allows local env patch when DEFAULT_OWNER_USER_ID is not configured', async () => {
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'secret-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: 'node',
            args: ['server.js'],
            env: { API_KEY: 'old-secret', KEEP: 'yes' },
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/mcp/secret-mcp/env',
      headers: LOCAL_OWNER_HEADERS,
      payload: { env: { API_KEY: 'new-secret' } },
    });

    assert.equal(res.statusCode, 200, res.payload);
    // F249: response returns raw values for frontend eye-toggle editing
    assert.match(res.payload, /new-secret/);
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.id === 'secret-mcp');
    assert.deepEqual(cap?.mcpServer?.env, { API_KEY: 'new-secret', KEEP: 'yes' });
  });

  it('rejects malformed env patch payloads before touching config', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');

    for (const payload of [{}, { env: ['API_KEY=value'] }]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/capabilities/mcp/secret-mcp/env',
        headers: LOCAL_OWNER_HEADERS,
        payload,
      });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /Required: env/);
    }

    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities, []);
  });

  it('returns 404 when patching env for an unknown MCP id', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/mcp/missing-mcp/env',
      headers: LOCAL_OWNER_HEADERS,
      payload: { env: { API_KEY: 'new-secret' } },
    });

    assert.equal(res.statusCode, 404);
    assert.match(JSON.parse(res.payload).error, /missing-mcp/);
  });

  it('rejects env patch for managed MCP entries', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'managed-mcp',
          type: 'mcp',
          enabled: true,
          source: 'cat-cafe',
          mcpServer: {
            command: 'node',
            args: ['managed-server.js'],
            env: { API_KEY: 'managed-secret' },
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/mcp/managed-mcp/env',
      headers: LOCAL_OWNER_HEADERS,
      payload: { env: { API_KEY: 'new-secret' } },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /managed MCP/);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.deepEqual(config?.capabilities[0]?.mcpServer?.env, { API_KEY: 'managed-secret' });
  });

  it('lets only the configured owner patch MCP env and records an update audit', async () => {
    setEnv('DEFAULT_OWNER_USER_ID', 'you');
    await writeCapabilitiesConfig(projectRoot, {
      version: 1,
      capabilities: [
        {
          id: 'secret-mcp',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: 'node',
            args: ['server.js'],
            env: { API_KEY: 'old-secret', KEEP: 'yes' },
          },
        },
      ],
    });

    const nonOwner = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/mcp/secret-mcp/env',
      headers: LOCAL_NON_OWNER_HEADERS,
      payload: { env: { API_KEY: 'attacker-secret' } },
    });
    assert.equal(nonOwner.statusCode, 403);

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/mcp/secret-mcp/env',
      headers: LOCAL_OWNER_HEADERS,
      payload: { env: { 'BAD-KEY': 'value' } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(JSON.parse(invalid.payload).error, /Invalid env key/);

    const redacted = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/mcp/secret-mcp/env',
      headers: LOCAL_OWNER_HEADERS,
      payload: { env: { API_KEY: '••••••' } },
    });
    assert.equal(redacted.statusCode, 400);
    assert.match(JSON.parse(redacted.payload).error, /redacted/i);

    const owner = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/mcp/secret-mcp/env',
      headers: LOCAL_OWNER_HEADERS,
      payload: { env: { API_KEY: 'new-secret', NEW_TOKEN: 'token' } },
    });
    assert.equal(owner.statusCode, 200, owner.payload);

    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.id === 'secret-mcp');
    assert.deepEqual(cap?.mcpServer?.env, {
      API_KEY: 'new-secret',
      KEEP: 'yes',
      NEW_TOKEN: 'token',
    });

    const audit = await readAuditLog(projectRoot);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, 'update');
    assert.equal(audit[0]?.capabilityId, 'secret-mcp');
    assert.deepEqual(audit[0]?.before?.mcpServer?.env, { API_KEY: REDACTED_SECRET, KEEP: REDACTED_SECRET });
    assert.deepEqual(audit[0]?.after?.mcpServer?.env, {
      API_KEY: REDACTED_SECRET,
      KEEP: REDACTED_SECRET,
      NEW_TOKEN: REDACTED_SECRET,
    });
    assert.doesNotMatch(JSON.stringify(audit), /old-secret|new-secret|token/);
    const rawAudit = await readFile(join(projectRoot, '.cat-cafe', 'audit.jsonl'), 'utf-8');
    assert.doesNotMatch(rawAudit, /old-secret|new-secret|token/);
  });
});
