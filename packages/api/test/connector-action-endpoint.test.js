import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { configEventBus } from '../dist/config/config-event-bus.js';
import { AuditEventTypes } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { executeConnectorAction } from '../dist/infrastructure/connectors/connector-action-handler.js';
import {
  clearConnectorConfigCache,
  readAllOperationStates,
  readOperationState,
  writeOperationState,
} from '../dist/infrastructure/connectors/im-connector-config-store.js';

/**
 * AC-A15/A16: Generic action endpoint handler tests.
 *
 * Tests the action state machine logic:
 * - Finding the operation and action in manifest
 * - Calling plugin handleAction
 * - Persisting currentAction = next on success
 * - Target backfill (AC-A19)
 * - Rollback on timeout (AC-A21)
 */

const PROJECT_ROOT = '/tmp/cat-cafe-action-handler-test';
const CONNECTOR_ID = 'test-connector';
const CONFIG_PATH = `${PROJECT_ROOT}/.cat-cafe/im-connector-config/${CONNECTOR_ID}.json`;

function cleanup() {
  clearConnectorConfigCache();
  try {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } catch {
    /* ignore */
  }
}

// ── Mock manifest with a QR-style operation ─────────────────────────

const mockManifest = {
  id: CONNECTOR_ID,
  config: [
    { type: 'input', envName: 'MY_TOKEN', label: 'Token', sensitive: true, required: true, hidden: true },
    {
      type: 'operation',
      name: 'qr_login',
      label: 'QR Login',
      required: true,
      target: ['MY_TOKEN'],
      actions: [
        { id: 'qr-generate', label: 'Generate QR', render: 'button', resultRender: 'img', next: 'qr-status' },
        {
          id: 'qr-status',
          label: 'Wait for scan',
          render: 'polling',
          timeout: 60,
          rollback: 'qr-generate',
          next: 'disconnect',
        },
        { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'qr-generate' },
      ],
    },
  ],
};

// ── executeConnectorAction tests ────────────────────────────────────

describe('executeConnectorAction (AC-A15/A16)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('calls plugin handleAction and persists next state', async () => {
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async (_opName, _actionId, _ctx) => ({
        render: 'img',
        data: { url: 'data:image/png;base64,QR_DATA' },
      }),
    };

    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-generate',
      manifest: mockManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.render, 'img');
    assert.deepEqual(result.data, { url: 'data:image/png;base64,QR_DATA' });

    // currentAction should advance to next = 'qr-status'
    const state = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'qr_login');
    assert.equal(state?.currentAction, 'qr-status');
  });

  it('backfills target fields on success (AC-A19)', async () => {
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'status',
        data: { label: 'Connected' },
        targetValues: { MY_TOKEN: 'scanned-token-123' },
      }),
    };

    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-status',
      manifest: mockManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, true);
    // currentAction should advance to 'disconnect'
    const state = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'qr_login');
    assert.equal(state?.currentAction, 'disconnect');
    // target field should be backfilled (check changedKeys)
    assert.deepEqual(result.backfilledKeys, ['MY_TOKEN']);
  });

  it('emits config change and audit event when target values are backfilled', async () => {
    const captured = [];
    const auditEvents = [];
    const unsub = configEventBus.onConfigChange((event) => captured.push(event));
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'status',
        data: { label: 'Connected' },
        targetValues: { MY_TOKEN: 'scanned-token-123' },
      }),
    };

    try {
      const result = await executeConnectorAction({
        projectRoot: PROJECT_ROOT,
        connectorId: CONNECTOR_ID,
        operationName: 'qr_login',
        actionId: 'qr-status',
        manifest: mockManifest,
        plugin: mockPlugin,
        pluginCtx: { env: {}, log: console },
        adapter: {},
        operator: 'owner-1',
        auditLog: {
          append: async (input) => {
            auditEvents.push(input);
            return { id: 'audit-test-id', timestamp: Date.now(), ...input };
          },
        },
      });

      assert.equal(result.ok, true);
      assert.deepEqual(result.backfilledKeys, ['MY_TOKEN']);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].source, 'config-store');
      assert.equal(captured[0].scope, 'key');
      assert.deepEqual(captured[0].changedKeys, ['MY_TOKEN']);
      assert.equal(auditEvents.length, 1);
      assert.equal(auditEvents[0].type, AuditEventTypes.CONFIG_UPDATED);
      assert.deepEqual(auditEvents[0].data, {
        target: 'connector-config',
        action: 'connector-action:test-connector:qr_login:qr-status',
        keys: ['MY_TOKEN'],
        operator: 'owner-1',
      });
    } finally {
      unsub();
    }
  });

  it('audits target value backfills even when stored values are unchanged', async () => {
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'status',
        data: { label: 'Connected' },
        targetValues: { MY_TOKEN: 'same-token' },
      }),
    };
    await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-status',
      manifest: mockManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    const captured = [];
    const auditEvents = [];
    const unsub = configEventBus.onConfigChange((event) => captured.push(event));
    try {
      const result = await executeConnectorAction({
        projectRoot: PROJECT_ROOT,
        connectorId: CONNECTOR_ID,
        operationName: 'qr_login',
        actionId: 'qr-status',
        manifest: mockManifest,
        plugin: mockPlugin,
        pluginCtx: { env: {}, log: console },
        adapter: {},
        operator: 'owner-1',
        auditLog: {
          append: async (input) => {
            auditEvents.push(input);
            return { id: 'audit-test-id', timestamp: Date.now(), ...input };
          },
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.backfilledKeys, undefined);
      assert.equal(captured.length, 0, 'unchanged values must not trigger reload');
      assert.equal(auditEvents.length, 1);
      assert.deepEqual(auditEvents[0].data, {
        target: 'connector-config',
        action: 'connector-action:test-connector:qr_login:qr-status',
        keys: [],
        operator: 'owner-1',
      });
    } finally {
      unsub();
    }
  });

  it('returns error for unknown operation', async () => {
    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'nonexistent',
      actionId: 'foo',
      manifest: mockManifest,
      plugin: { id: CONNECTOR_ID },
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /operation.*not found/i);
  });

  it('returns error for unknown action within operation', async () => {
    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'nonexistent',
      manifest: mockManifest,
      plugin: { id: CONNECTOR_ID },
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /action.*not found/i);
  });

  it('returns error when plugin has no handleAction', async () => {
    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-generate',
      manifest: mockManifest,
      plugin: { id: CONNECTOR_ID }, // no handleAction
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /handleAction.*not implemented/i);
  });

  it('action with no next does not advance state', async () => {
    // Create a manifest where the last action has no next
    const noNextManifest = {
      id: CONNECTOR_ID,
      config: [
        {
          type: 'operation',
          name: 'simple_op',
          label: 'Simple',
          required: true,
          actions: [{ id: 'do-thing', label: 'Do', render: 'button' }],
        },
      ],
    };

    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({ render: 'status', data: { label: 'Done' } }),
    };

    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'simple_op',
      actionId: 'do-thing',
      manifest: noNextManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, true);
    // currentAction should be 'do-thing' (stays on current since no next)
    const state = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'simple_op');
    assert.equal(state?.currentAction, 'do-thing');
  });

  it('persists lastResult from plugin response', async () => {
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'img',
        data: { url: 'data:image/png;...' },
        label: 'Scan me',
      }),
    };

    await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-generate',
      manifest: mockManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    const state = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'qr_login');
    assert.deepEqual(state?.lastResult, {
      render: 'img',
      data: { url: 'data:image/png;...' },
      label: 'Scan me',
    });
  });

  it('advance: false keeps current action (polling not yet done)', async () => {
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'polling',
        data: { status: 'waiting' },
        advance: false, // QR not yet scanned
      }),
    };

    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-status',
      manifest: mockManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.render, 'polling');

    // currentAction should stay on 'qr-status' (NOT advance to 'disconnect')
    const state = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'qr_login');
    assert.equal(state?.currentAction, 'qr-status', 'should not advance when advance=false');
  });

  it('advance: false preserves the QR image state during polling', async () => {
    const originalDateNow = Date.now;
    try {
      Date.now = () => 1_000;
      writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'qr_login', {
        currentAction: 'qr-status',
        lastResult: { render: 'img', data: { url: 'data:image/png;base64,QR_DATA' } },
      });

      const mockPlugin = {
        id: CONNECTOR_ID,
        handleAction: async () => ({
          render: 'polling',
          data: { status: 'waiting' },
          label: 'Still waiting',
          advance: false,
        }),
      };

      Date.now = () => 7_000;
      const result = await executeConnectorAction({
        projectRoot: PROJECT_ROOT,
        connectorId: CONNECTOR_ID,
        operationName: 'qr_login',
        actionId: 'qr-status',
        manifest: mockManifest,
        plugin: mockPlugin,
        pluginCtx: { env: {}, log: console },
        adapter: {},
      });

      assert.equal(result.ok, true);
      const state = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'qr_login');
      assert.equal(state?.currentAction, 'qr-status');
      assert.equal(state?.updatedAt, 1_000, 'polling timeout deadline must not move on non-advance polls');
      assert.deepEqual(state?.lastResult, {
        render: 'img',
        data: { url: 'data:image/png;base64,QR_DATA', status: 'waiting' },
        label: 'Still waiting',
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('advance: false does not backfill target fields', async () => {
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'polling',
        data: { status: 'waiting' },
        advance: false,
        targetValues: { MY_TOKEN: 'should-not-be-written' },
      }),
    };

    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-status',
      manifest: mockManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.backfilledKeys, undefined, 'should not backfill when advance=false');
  });

  it('activate: false is passed through in result (disconnect should not trigger activation)', async () => {
    // First: connect and backfill a real token (so disconnect produces a real change)
    const connectPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'status',
        data: { status: 'confirmed' },
        targetValues: { MY_TOKEN: 'real-token' },
      }),
    };
    await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-status',
      manifest: mockManifest,
      plugin: connectPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    // Then: disconnect clears the token with activate: false
    const disconnectPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'status',
        data: { status: 'disconnected' },
        label: '已断开',
        targetValues: { MY_TOKEN: '' },
        activate: false,
      }),
    };

    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'disconnect',
      manifest: mockManifest,
      plugin: disconnectPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, true);
    // backfilledKeys present — clearing 'real-token' → '' is a real change
    assert.deepEqual(result.backfilledKeys, ['MY_TOKEN']);
    // activate: false should be passed through so route skips activateConnector
    assert.equal(result.activate, false, 'disconnect action should signal no activation');
  });

  it('activate defaults to undefined (omitted) for normal actions', async () => {
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async () => ({
        render: 'status',
        data: { status: 'confirmed' },
        targetValues: { MY_TOKEN: 'real-token' },
      }),
    };

    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-status',
      manifest: mockManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: {},
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.backfilledKeys, ['MY_TOKEN']);
    assert.equal(result.activate, undefined, 'normal action should not set activate');
  });

  it('Weixin-style disconnect→reconnect: adapter must survive for token re-injection', async () => {
    // Regression: deactivateConnector once removed the adapter from the registry,
    // breaking the next QR login (handler couldn't inject fresh token).
    // This test pins the contract: a persistent adapter (like Weixin) stays available
    // across disconnect → reconnect cycles.
    const persistentAdapter = { id: 'weixin-adapter', token: null, disconnected: false };

    // Step 1: QR confirmed — inject token via adapter
    const connectPlugin = {
      id: CONNECTOR_ID,
      handleAction: async (_opName, _actionId, ctx) => {
        assert.ok(ctx.adapter, 'adapter must be available during connect');
        ctx.adapter.token = 'token-v1';
        return {
          render: 'status',
          data: { status: 'confirmed' },
          targetValues: { MY_TOKEN: 'token-v1' },
        };
      },
    };
    await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-status',
      manifest: mockManifest,
      plugin: connectPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: persistentAdapter,
    });
    assert.equal(persistentAdapter.token, 'token-v1');

    // Step 2: Disconnect — handler clears token, sets activate: false
    const disconnectPlugin = {
      id: CONNECTOR_ID,
      handleAction: async (_opName, _actionId, ctx) => {
        assert.ok(ctx.adapter, 'adapter must be available during disconnect');
        ctx.adapter.token = null;
        ctx.adapter.disconnected = true;
        return {
          render: 'status',
          data: { status: 'disconnected' },
          targetValues: { MY_TOKEN: '' },
          activate: false,
        };
      },
    };
    await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'disconnect',
      manifest: mockManifest,
      plugin: disconnectPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: persistentAdapter, // Same adapter object — gateway keeps it
    });
    assert.equal(persistentAdapter.token, null, 'disconnect should clear token');

    // Step 3: Reconnect — new QR confirmed with fresh token.
    // KEY ASSERTION: adapter is still the same object, handler can inject new token.
    const reconnectPlugin = {
      id: CONNECTOR_ID,
      handleAction: async (_opName, _actionId, ctx) => {
        assert.ok(ctx.adapter, 'adapter must STILL be available for reconnect');
        assert.strictEqual(ctx.adapter, persistentAdapter, 'must be the same adapter instance');
        ctx.adapter.token = 'token-v2';
        ctx.adapter.disconnected = false;
        return {
          render: 'status',
          data: { status: 'confirmed' },
          targetValues: { MY_TOKEN: 'token-v2' },
        };
      },
    };
    const reconnectResult = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-generate', // re-enter from beginning
      manifest: mockManifest,
      plugin: reconnectPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: persistentAdapter, // Same adapter — gateway retained it
    });
    assert.equal(reconnectResult.ok, true);
    assert.equal(persistentAdapter.token, 'token-v2', 'reconnect must inject fresh token');
    assert.equal(persistentAdapter.disconnected, false, 'adapter should be re-activated');
  });

  it('works without adapter (unconfigured connector, e.g. pre-QR-login Feishu)', async () => {
    const mockPlugin = {
      id: CONNECTOR_ID,
      handleAction: async (_opName, _actionId, ctx) => {
        // Verify adapter is undefined
        assert.equal(ctx.adapter, undefined, 'adapter should be undefined for unconfigured connector');
        return {
          render: 'img',
          data: { url: 'data:image/png;base64,QR_DATA' },
        };
      },
    };

    const result = await executeConnectorAction({
      projectRoot: PROJECT_ROOT,
      connectorId: CONNECTOR_ID,
      operationName: 'qr_login',
      actionId: 'qr-generate',
      manifest: mockManifest,
      plugin: mockPlugin,
      pluginCtx: { env: {}, log: console },
      adapter: undefined, // No adapter — connector not yet configured
    });

    assert.equal(result.ok, true);
    assert.equal(result.render, 'img');
    // State still advances normally
    const state = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'qr_login');
    assert.equal(state?.currentAction, 'qr-status');
  });
});
