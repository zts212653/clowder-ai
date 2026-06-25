import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

/**
 * Regression test for clowder-ai#1015: connector action 503 due to registration-time
 * value-copy of pluginRegistry. Fix: getters proxy late-wired fields to parent opts.
 */

const { connectorActionRoutes } = await import('../dist/routes/connector-plugin-routes.js');
const { connectorHubRoutes, invalidateManifestCache } = await import('../dist/routes/connector-hub.js');
const { _clearActiveRootCacheForTest } = await import('../dist/utils/active-project-root.js');
const { clearConnectorConfigCache } = await import('../dist/infrastructure/connectors/im-connector-config-store.js');

const OWNER_ID = 'owner-1';
const AUTH_HEADERS = { 'x-cat-cafe-user': OWNER_ID, 'x-test-session-user': OWNER_ID };
const ORIGINAL_OWNER_ID = process.env.DEFAULT_OWNER_USER_ID;

// ── Test manifest (matches feishu's connector.yaml shape) ──

const TEST_CONNECTOR_ID = 'test-conn';
const testManifest = {
  id: TEST_CONNECTOR_ID,
  name: 'Test',
  source: 'builtin',
  config: [
    { type: 'input', envName: 'TEST_TOKEN', label: 'Token', sensitive: true, required: true },
    {
      type: 'operation',
      name: 'test_op',
      label: 'Test Op',
      required: false,
      target: ['TEST_TOKEN'],
      actions: [
        { id: 'start', label: 'Start', render: 'button', resultRender: 'status', next: 'done' },
        { id: 'done', label: 'Done', render: 'button', next: 'start' },
      ],
    },
  ],
};

describe('connector action routes late-wiring (clowder-ai#1015)', () => {
  let tmpDir;

  beforeEach(() => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    tmpDir = mkdtempSync(join(os.tmpdir(), 'cat-cafe-late-wire-'));
    const configDir = join(tmpDir, '.cat-cafe', 'im-connector-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, `${TEST_CONNECTOR_ID}.json`), '{}');
    process.env.ACTIVE_PROJECT_ROOT = tmpDir;
    _clearActiveRootCacheForTest?.();
    clearConnectorConfigCache();
  });

  afterEach(() => {
    if (ORIGINAL_OWNER_ID === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = ORIGINAL_OWNER_ID;
    delete process.env.ACTIVE_PROJECT_ROOT;
    _clearActiveRootCacheForTest?.();
    clearConnectorConfigCache();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  // ── Level 1: Direct connectorActionRoutes ──

  it('value-copy of pluginRegistry causes 503 (demonstrating the bug)', async () => {
    const mockPlugin = {
      id: TEST_CONNECTOR_ID,
      handleAction: async () => ({ render: 'status', data: { status: 'ok' } }),
    };
    const manifests = new Map([[TEST_CONNECTOR_ID, testManifest]]);

    // Simulate the BUGGY pattern: value-copy at creation time
    const parentOpts = { pluginRegistry: undefined };
    const actionOpts = {
      getManifests: () => manifests,
      pluginRegistry: parentOpts.pluginRegistry, // = undefined (snapshot)
      redis: undefined,
    };

    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const s = request.headers['x-test-session-user'];
      if (typeof s === 'string' && s.trim()) request.sessionUserId = s.trim();
    });
    connectorActionRoutes(actionOpts)(app);

    parentOpts.pluginRegistry = new Map([[TEST_CONNECTOR_ID, mockPlugin]]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/connectors/${TEST_CONNECTOR_ID}/actions/test_op/start`,
      headers: AUTH_HEADERS,
      payload: {},
    });

    assert.equal(res.statusCode, 503, 'Value-copy should cause 503 because pluginRegistry is stale');
    const body = JSON.parse(res.body);
    assert.equal(body.error, `Connector '${TEST_CONNECTOR_ID}' plugin not loaded`);
  });

  it('getter-proxied pluginRegistry reads live value (the fix)', async () => {
    const handleActionCalls = [];
    const mockPlugin = {
      id: TEST_CONNECTOR_ID,
      handleAction: async (opName, actionId) => {
        handleActionCalls.push({ opName, actionId });
        return { render: 'status', data: { status: 'ok' } };
      },
    };
    const manifests = new Map([[TEST_CONNECTOR_ID, testManifest]]);

    const parentOpts = { pluginRegistry: undefined };
    const actionOpts = {
      getManifests: () => manifests,
      get pluginRegistry() {
        return parentOpts.pluginRegistry;
      }, // getter
      redis: undefined,
    };

    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const s = request.headers['x-test-session-user'];
      if (typeof s === 'string' && s.trim()) request.sessionUserId = s.trim();
    });
    connectorActionRoutes(actionOpts)(app);

    parentOpts.pluginRegistry = new Map([[TEST_CONNECTOR_ID, mockPlugin]]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/connectors/${TEST_CONNECTOR_ID}/actions/test_op/start`,
      headers: AUTH_HEADERS,
      payload: {},
    });

    assert.notEqual(
      res.statusCode,
      503,
      `Should not get 503 — getter should read live pluginRegistry. Body: ${res.body}`,
    );
    const body = JSON.parse(res.body);
    assert.notEqual(body.error, `Connector '${TEST_CONNECTOR_ID}' plugin not loaded`);
    assert.equal(handleActionCalls.length, 1, 'handleAction should have been called');
    assert.equal(handleActionCalls[0].actionId, 'start');
  });

  // ── Level 1b: activateConnector / deactivateConnector late-wiring ──

  it('late-wired activateConnector is called after action signals activation', async () => {
    const activateCalls = [];
    const mockPlugin = {
      id: TEST_CONNECTOR_ID,
      handleAction: async () => ({
        render: 'status',
        data: { status: 'confirmed' },
        activate: true,
      }),
    };
    const manifests = new Map([[TEST_CONNECTOR_ID, testManifest]]);

    const parentOpts = {
      pluginRegistry: undefined,
      activateConnector: undefined,
      adapterRegistry: undefined,
      deactivateConnector: undefined,
    };
    const actionOpts = {
      getManifests: () => manifests,
      get pluginRegistry() {
        return parentOpts.pluginRegistry;
      },
      get adapterRegistry() {
        return parentOpts.adapterRegistry;
      },
      get activateConnector() {
        return parentOpts.activateConnector;
      },
      get deactivateConnector() {
        return parentOpts.deactivateConnector;
      },
      redis: undefined,
    };

    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const s = request.headers['x-test-session-user'];
      if (typeof s === 'string' && s.trim()) request.sessionUserId = s.trim();
    });
    connectorActionRoutes(actionOpts)(app);

    // Late-wire all fields
    parentOpts.pluginRegistry = new Map([[TEST_CONNECTOR_ID, mockPlugin]]);
    parentOpts.adapterRegistry = new Map();
    parentOpts.activateConnector = async (connectorId) => {
      activateCalls.push(connectorId);
    };
    parentOpts.deactivateConnector = async () => {};

    const res = await app.inject({
      method: 'POST',
      url: `/api/connectors/${TEST_CONNECTOR_ID}/actions/test_op/start`,
      headers: AUTH_HEADERS,
      payload: {},
    });

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, `Action should succeed. Body: ${JSON.stringify(body)}`);
    assert.equal(body.activationStatus, 'activated', 'Connector should be activated');
    assert.equal(activateCalls.length, 1, 'activateConnector should have been called once');
    assert.equal(activateCalls[0], TEST_CONNECTOR_ID, 'activateConnector should receive the correct connectorId');
  });

  it('late-wired deactivateConnector is called after action signals deactivation', async () => {
    const deactivateCalls = [];
    const mockPlugin = {
      id: TEST_CONNECTOR_ID,
      handleAction: async () => ({
        render: 'status',
        data: { status: 'disconnected' },
        activate: false,
      }),
    };
    const manifests = new Map([[TEST_CONNECTOR_ID, testManifest]]);

    const parentOpts = {
      pluginRegistry: undefined,
      activateConnector: undefined,
      adapterRegistry: undefined,
      deactivateConnector: undefined,
    };
    const actionOpts = {
      getManifests: () => manifests,
      get pluginRegistry() {
        return parentOpts.pluginRegistry;
      },
      get adapterRegistry() {
        return parentOpts.adapterRegistry;
      },
      get activateConnector() {
        return parentOpts.activateConnector;
      },
      get deactivateConnector() {
        return parentOpts.deactivateConnector;
      },
      redis: undefined,
    };

    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const s = request.headers['x-test-session-user'];
      if (typeof s === 'string' && s.trim()) request.sessionUserId = s.trim();
    });
    connectorActionRoutes(actionOpts)(app);

    // Late-wire all fields
    parentOpts.pluginRegistry = new Map([[TEST_CONNECTOR_ID, mockPlugin]]);
    parentOpts.adapterRegistry = new Map();
    parentOpts.activateConnector = async () => {};
    parentOpts.deactivateConnector = async (connectorId) => {
      deactivateCalls.push(connectorId);
    };

    const res = await app.inject({
      method: 'POST',
      url: `/api/connectors/${TEST_CONNECTOR_ID}/actions/test_op/start`,
      headers: AUTH_HEADERS,
      payload: {},
    });

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, `Action should succeed. Body: ${JSON.stringify(body)}`);
    assert.equal(body.activationStatus, 'deactivated', 'Connector should be deactivated');
    assert.equal(deactivateCalls.length, 1, 'deactivateConnector should have been called once');
    assert.equal(deactivateCalls[0], TEST_CONNECTOR_ID, 'deactivateConnector should receive the correct connectorId');
  });

  // ── Level 2: Through connectorHubRoutes (e2e) ──

  it('connectorHubRoutes late-wired pluginRegistry reaches action handler (e2e)', async () => {
    const handleActionCalls = [];
    const mockPlugin = {
      id: 'feishu',
      handleAction: async (opName, actionId) => {
        handleActionCalls.push({ opName, actionId });
        return { render: 'status', data: { status: 'ok' } };
      },
    };

    const hubOpts = {
      threadStore: { list: async () => [], get: async () => null },
      redis: undefined,
    };

    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const s = request.headers['x-test-session-user'];
      if (typeof s === 'string' && s.trim()) request.sessionUserId = s.trim();
    });

    invalidateManifestCache();
    await app.register(connectorHubRoutes, hubOpts);
    await app.ready(); // Force plugin loading before late-wiring

    // Late-wire AFTER plugin loaded (simulates wireGatewayHooks post-listen)
    hubOpts.pluginRegistry = new Map([['feishu', mockPlugin]]);
    hubOpts.adapterRegistry = new Map();
    hubOpts.activateConnector = async () => {};
    hubOpts.deactivateConnector = async () => {};

    const res = await app.inject({
      method: 'POST',
      url: '/api/connectors/feishu/actions/feishu_qr_login/qr-generate',
      headers: AUTH_HEADERS,
      payload: {},
    });

    const body = JSON.parse(res.body);
    assert.notEqual(res.statusCode, 503, `Should not get 503 — plugin is late-wired. Body: ${JSON.stringify(body)}`);
    assert.notEqual(
      body.error,
      "Connector 'feishu' plugin not loaded",
      'pluginRegistry must be read live, not captured at registration time',
    );
  });
});
