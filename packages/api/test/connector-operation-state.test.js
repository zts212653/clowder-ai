import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  clearConnectorConfigCache,
  loadAllConnectorConfigs,
  readAllOperationStates,
  readOperationState,
  writeConnectorConfig,
  writeOperationState,
} from '../dist/infrastructure/connectors/im-connector-config-store.js';

/**
 * AC-A20: Operation state persistence in `_operations` namespace.
 *
 * _operations lives in the same JSON file as value fields but is isolated:
 * - loadAllConnectorConfigs ignores _operations entries
 * - writeConnectorConfig preserves _operations when updating value fields
 * - readOperationState / writeOperationState operate only on _operations
 */

const PROJECT_ROOT = '/tmp/cat-cafe-operation-state-test';
const CONNECTOR_ID = 'op-state-test';
const CONFIG_DIR = `${PROJECT_ROOT}/.cat-cafe/im-connector-config`;
const CONFIG_PATH = `${CONFIG_DIR}/${CONNECTOR_ID}.json`;

function ensureDir() {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function cleanup() {
  clearConnectorConfigCache();
  try {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } catch {
    /* ignore */
  }
}

// ── readOperationState / writeOperationState round-trip ─────────────

describe('operation state persistence (AC-A20)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('writeOperationState + readOperationState round-trip', () => {
    const state = {
      currentAction: 'qr-status',
      lastResult: { render: 'img', data: { url: 'data:image/png;base64,...' } },
    };
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'weixin_qr_login', state);

    const read = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'weixin_qr_login');
    assert.equal(read?.currentAction, state.currentAction);
    assert.deepEqual(read?.lastResult, state.lastResult);
    assert.equal(typeof read?.updatedAt, 'number', 'updatedAt stamped by writeOperationState');
  });

  it('readOperationState returns undefined for absent connector', () => {
    const read = readOperationState(PROJECT_ROOT, 'nonexistent', 'some_op');
    assert.equal(read, undefined);
  });

  it('readOperationState returns undefined for absent operation', () => {
    // Write a different operation, then query one that doesn't exist
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_a', { currentAction: 'start' });
    const read = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_b');
    assert.equal(read, undefined);
  });

  it('writeOperationState creates _operations namespace if absent', () => {
    ensureDir();
    // Pre-seed config with only value fields
    writeFileSync(CONFIG_PATH, JSON.stringify({ SOME_TOKEN: 'abc' }, null, 2));

    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'my_op', { currentAction: 'step1' });

    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    assert.equal(raw.SOME_TOKEN, 'abc', 'value field preserved');
    assert.equal(raw._operations.my_op.currentAction, 'step1');
    assert.equal(typeof raw._operations.my_op.updatedAt, 'number', 'updatedAt stamped');
  });

  it('writeOperationState preserves existing operations', () => {
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_a', { currentAction: 'a1' });
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_b', { currentAction: 'b1' });

    const readA = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_a');
    const readB = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_b');
    assert.equal(readA?.currentAction, 'a1');
    assert.equal(readB?.currentAction, 'b1');
  });

  it('writeOperationState updates existing operation', () => {
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_a', { currentAction: 'step1' });
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_a', {
      currentAction: 'step2',
      lastResult: { render: 'status', data: { label: 'connected' } },
    });

    const read = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_a');
    assert.equal(read?.currentAction, 'step2');
    assert.deepEqual(read?.lastResult, { render: 'status', data: { label: 'connected' } });
  });
});

// ── readAllOperationStates ──────────────────────────────────────────

describe('readAllOperationStates (AC-A20)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('returns empty object for absent connector', () => {
    const all = readAllOperationStates(PROJECT_ROOT, 'nonexistent');
    assert.deepEqual(all, {});
  });

  it('returns all operations for a connector', () => {
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_a', { currentAction: 'a1' });
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'op_b', {
      currentAction: 'b2',
      lastResult: { render: 'img', data: 'qr' },
    });

    const all = readAllOperationStates(PROJECT_ROOT, CONNECTOR_ID);
    assert.equal(Object.keys(all).length, 2);
    assert.equal(all.op_a?.currentAction, 'a1');
    assert.equal(all.op_b?.currentAction, 'b2');
  });
});

// ── writeConnectorConfig preserves _operations ──────────────────────

describe('writeConnectorConfig preserves _operations (AC-A20 isolation)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('value field update does not clobber _operations', () => {
    // 1. Write operation state
    writeOperationState(PROJECT_ROOT, CONNECTOR_ID, 'my_op', { currentAction: 'running' });

    // 2. Write value field via config API
    writeConnectorConfig(PROJECT_ROOT, CONNECTOR_ID, [{ name: 'MY_TOKEN', value: 'secret123' }]);

    // 3. Operation state must survive
    const opState = readOperationState(PROJECT_ROOT, CONNECTOR_ID, 'my_op');
    assert.equal(opState?.currentAction, 'running', '_operations must survive value field write');

    // 4. Verify raw JSON has both
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    assert.equal(raw.MY_TOKEN, 'secret123');
    assert.equal(raw._operations.my_op.currentAction, 'running');
    assert.equal(typeof raw._operations.my_op.updatedAt, 'number', 'updatedAt preserved');
  });
});

// ── loadAllConnectorConfigs ignores _operations ─────────────────────

describe('loadAllConnectorConfigs ignores _operations (AC-A20)', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('_operations key not loaded into value cache', () => {
    ensureDir();
    // Pre-seed config with both value fields and _operations
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          MY_TOKEN: 'abc',
          _operations: { my_op: { currentAction: 'running' } },
        },
        null,
        2,
      ),
    );

    const fields = [{ type: 'input', envName: 'MY_TOKEN', label: 'Token', sensitive: true, required: true }];
    const loaded = loadAllConnectorConfigs(PROJECT_ROOT, [{ id: CONNECTOR_ID, config: fields }]);

    assert.equal(loaded, 1, 'only value field MY_TOKEN should be loaded');
  });
});
