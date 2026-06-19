import assert from 'node:assert/strict';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  clearConnectorConfigCache,
  getStoredConnectorValue,
  loadAllConnectorConfigs,
  readConnectorConfig,
  resolveConnectorEnv,
  writeConnectorConfig,
} from '../dist/infrastructure/connectors/im-connector-config-store.js';

/**
 * AC-A8a + KD-18: Tombstone semantics + default encoding.
 *
 * Tombstone: stored null MUST block env fallback (KD-19).
 * Default encoding: typed defaults (boolean, string[]) MUST be encoded
 * to string representation per KD-18 codec contract.
 */

// ── Tombstone tests ─────────────────────────────────────────────────

describe('connector-config-store tombstone (AC-A8a)', () => {
  const CONNECTOR_ID = 'tombstone-test';
  const ENV_NAME = 'TOMBSTONE_TEST_TOKEN';
  const projectRoot = '/tmp/cat-cafe-tombstone-test';

  const fields = [{ type: 'input', envName: ENV_NAME, label: 'Token', sensitive: true, required: true }];

  beforeEach(() => {
    clearConnectorConfigCache();
    // Set env var to simulate legacy .env value
    process.env[ENV_NAME] = 'old-env-value';
  });

  afterEach(() => {
    clearConnectorConfigCache();
    delete process.env[ENV_NAME];
    // Clean up test files
    const configPath = `${projectRoot}/.cat-cafe/im-connector-config/${CONNECTOR_ID}.json`;
    try {
      if (existsSync(configPath)) unlinkSync(configPath);
    } catch {
      /* ignore */
    }
  });

  it('stored null blocks env fallback (tombstone)', () => {
    // 1. Write a value first, then clear it (write null)
    writeConnectorConfig(projectRoot, CONNECTOR_ID, [{ name: ENV_NAME, value: 'stored-value' }]);

    // 2. User clears the field in Hub → write null
    writeConnectorConfig(projectRoot, CONNECTOR_ID, [{ name: ENV_NAME, value: null }]);

    // 3. Load into cache
    loadAllConnectorConfigs(projectRoot, [{ id: CONNECTOR_ID, config: fields }]);

    // 4. Resolve — stored null should NOT fall through to process.env
    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(
      resolved[ENV_NAME],
      undefined,
      `Expected undefined (tombstone), got '${resolved[ENV_NAME]}' — env fallback should be blocked`,
    );
  });

  it('absent key allows env fallback', () => {
    // Don't write anything to store — key is absent
    loadAllConnectorConfigs(projectRoot, [{ id: CONNECTOR_ID, config: fields }]);

    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved[ENV_NAME], 'old-env-value', 'Absent key should fall through to env');
  });

  it('stored string value takes priority over env', () => {
    writeConnectorConfig(projectRoot, CONNECTOR_ID, [{ name: ENV_NAME, value: 'hub-value' }]);
    loadAllConnectorConfigs(projectRoot, [{ id: CONNECTOR_ID, config: fields }]);

    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved[ENV_NAME], 'hub-value');
  });
});

describe('connector-config-store connectorId validation', () => {
  const projectRoot = '/tmp/cat-cafe-config-id-validation-test';

  afterEach(() => {
    clearConnectorConfigCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rejects traversal connector IDs before writing outside im-connector-config', () => {
    assert.throws(
      () => writeConnectorConfig(projectRoot, '../escape', [{ name: 'TOKEN', value: 'secret' }]),
      /Invalid connector ID/i,
    );

    assert.equal(existsSync(`${projectRoot}/.cat-cafe/escape.json`), false);
  });

  it('rejects traversal connector IDs before reading outside im-connector-config', () => {
    assert.throws(() => readConnectorConfig(projectRoot, '../escape'), /Invalid connector ID/i);
  });
});

// ── getStoredConnectorValue three-state (KD-19 bootstrap tombstone) ─

describe('getStoredConnectorValue three-state (KD-19)', () => {
  const CONNECTOR_ID = 'three-state-test';
  const projectRoot = '/tmp/cat-cafe-three-state-test';
  const fields = [{ type: 'input', envName: 'KEY_A', label: 'A', sensitive: false, required: true }];

  afterEach(() => {
    clearConnectorConfigCache();
    const configPath = `${projectRoot}/.cat-cafe/im-connector-config/${CONNECTOR_ID}.json`;
    try {
      if (existsSync(configPath)) unlinkSync(configPath);
    } catch {
      /* ignore */
    }
  });

  it('returns string for stored value', () => {
    writeConnectorConfig(projectRoot, CONNECTOR_ID, [{ name: 'KEY_A', value: 'hello' }]);
    loadAllConnectorConfigs(projectRoot, [{ id: CONNECTOR_ID, config: fields }]);
    const result = getStoredConnectorValue(CONNECTOR_ID, 'KEY_A');
    assert.equal(result, 'hello');
  });

  it('returns null for tombstone (user cleared)', () => {
    writeConnectorConfig(projectRoot, CONNECTOR_ID, [{ name: 'KEY_A', value: null }]);
    loadAllConnectorConfigs(projectRoot, [{ id: CONNECTOR_ID, config: fields }]);
    const result = getStoredConnectorValue(CONNECTOR_ID, 'KEY_A');
    assert.equal(result, null, 'tombstone must return null, not undefined');
  });

  it('returns undefined for absent key', () => {
    loadAllConnectorConfigs(projectRoot, [{ id: CONNECTOR_ID, config: fields }]);
    const result = getStoredConnectorValue(CONNECTOR_ID, 'KEY_A');
    assert.equal(result, undefined, 'absent key must return undefined');
  });

  it('returns undefined for unknown connector', () => {
    const result = getStoredConnectorValue('nonexistent', 'KEY_A');
    assert.equal(result, undefined);
  });
});

// ── Default encoding tests (KD-18, P1-2) ───────────────────────────

describe('connector-config-store default encoding (KD-18)', () => {
  const CONNECTOR_ID = 'default-encoding-test';

  beforeEach(() => {
    clearConnectorConfigCache();
  });

  afterEach(() => {
    clearConnectorConfigCache();
  });

  it('toggle default false → string "false" (not boolean)', () => {
    const fields = [{ type: 'toggle', envName: 'ENABLE_FEATURE', label: 'Enable', required: false, default: false }];
    // No stored value, no env var → falls through to YAML default
    loadAllConnectorConfigs('/tmp/nonexistent', [{ id: CONNECTOR_ID, config: fields }]);
    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved.ENABLE_FEATURE, 'false', 'toggle default must be string "false"');
    assert.equal(typeof resolved.ENABLE_FEATURE, 'string', 'must be string type');
  });

  it('toggle default true → string "true"', () => {
    const fields = [
      { type: 'toggle', envName: 'ENABLE_WHITELIST', label: 'Whitelist', required: false, default: true },
    ];
    loadAllConnectorConfigs('/tmp/nonexistent', [{ id: CONNECTOR_ID, config: fields }]);
    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved.ENABLE_WHITELIST, 'true');
  });

  it('list default [] → string "[]"', () => {
    const fields = [{ type: 'list', envName: 'ADMIN_IDS', label: 'Admins', required: false, default: [] }];
    loadAllConnectorConfigs('/tmp/nonexistent', [{ id: CONNECTOR_ID, config: fields }]);
    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved.ADMIN_IDS, '[]', 'empty list default must be "[]"');
  });

  it('list default ["a","b"] → JSON string', () => {
    const fields = [{ type: 'list', envName: 'ADMIN_IDS', label: 'Admins', required: false, default: ['a', 'b'] }];
    loadAllConnectorConfigs('/tmp/nonexistent', [{ id: CONNECTOR_ID, config: fields }]);
    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved.ADMIN_IDS, '["a","b"]', 'list default must be JSON string');
  });

  it('input default remains string', () => {
    const fields = [
      { type: 'input', envName: 'HOST', label: 'Host', sensitive: false, required: false, default: 'localhost' },
    ];
    loadAllConnectorConfigs('/tmp/nonexistent', [{ id: CONNECTOR_ID, config: fields }]);
    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved.HOST, 'localhost');
  });

  it('select default remains string', () => {
    const fields = [
      {
        type: 'select',
        envName: 'MODE',
        label: 'Mode',
        required: false,
        options: [
          { value: 'ws', label: 'WS' },
          { value: 'http', label: 'HTTP' },
        ],
        default: 'ws',
      },
    ];
    loadAllConnectorConfigs('/tmp/nonexistent', [{ id: CONNECTOR_ID, config: fields }]);
    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved.MODE, 'ws');
  });

  it('no default → undefined', () => {
    const fields = [{ type: 'input', envName: 'TOKEN', label: 'Token', sensitive: true, required: true }];
    loadAllConnectorConfigs('/tmp/nonexistent', [{ id: CONNECTOR_ID, config: fields }]);
    const resolved = resolveConnectorEnv(CONNECTOR_ID, fields);
    assert.equal(resolved.TOKEN, undefined);
  });
});
