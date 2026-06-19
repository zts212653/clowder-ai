import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseConnectorManifest } from '../dist/infrastructure/connectors/plugins/im-connector-manifest.js';

/**
 * Verify that connector.yaml manifests with operation fields parse correctly.
 * This validates the full YAML→ConfigField pipeline for operations.
 */

const CONNECTORS_DIR = join(import.meta.dirname, '../src/infrastructure/connectors/im-connectors');

describe('connector.yaml operation field parsing', () => {
  it('weixin manifest has operation field with action chain', () => {
    const manifest = parseConnectorManifest(join(CONNECTORS_DIR, 'weixin/connector.yaml'));

    // Should have 1 value field + 1 operation field
    const valueFields = manifest.config.filter((f) => f.type !== 'operation');
    const operationFields = manifest.config.filter((f) => f.type === 'operation');

    assert.equal(valueFields.length, 1, 'weixin should have 1 value field (WEIXIN_BOT_TOKEN)');
    assert.equal(operationFields.length, 1, 'weixin should have 1 operation field');

    const op = operationFields[0];
    assert.equal(op.name, 'weixin_qr_login');
    assert.equal(op.label, '微信扫码登录');
    assert.deepEqual(op.target, ['WEIXIN_BOT_TOKEN']);
    assert.equal(op.actions.length, 3);

    // Verify action chain
    assert.equal(op.actions[0].id, 'qr-generate');
    assert.equal(op.actions[0].render, 'button');
    assert.equal(op.actions[0].resultRender, 'img');
    assert.equal(op.actions[0].next, 'qr-status');

    assert.equal(op.actions[1].id, 'qr-status');
    assert.equal(op.actions[1].render, 'polling');
    assert.equal(op.actions[1].timeout, 60);
    assert.equal(op.actions[1].rollback, 'qr-generate');
    assert.equal(op.actions[1].next, 'disconnect');

    assert.equal(op.actions[2].id, 'disconnect');
    assert.equal(op.actions[2].next, 'qr-generate');
  });

  it('feishu manifest has select + operation fields', () => {
    const manifest = parseConnectorManifest(join(CONNECTORS_DIR, 'feishu/connector.yaml'));

    const selectFields = manifest.config.filter((f) => f.type === 'select');
    assert.equal(selectFields.length, 1, 'feishu should have 1 select field (CONNECTION_MODE)');
    assert.equal(selectFields[0].envName, 'FEISHU_CONNECTION_MODE');
    assert.equal(selectFields[0].options.length, 2);

    const operationFields = manifest.config.filter((f) => f.type === 'operation');
    assert.equal(operationFields.length, 1);
    assert.equal(operationFields[0].name, 'feishu_qr_login');
    assert.deepEqual(operationFields[0].target, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_CONNECTION_MODE']);

    const qrStatus = operationFields[0].actions.find((a) => a.id === 'qr-status');
    assert.equal(qrStatus.timeout, 600, 'feishu QR polling should honor the provider 10 minute expiry window');
  });

  it('dingtalk manifest has no operation fields (manual-only)', () => {
    const manifest = parseConnectorManifest(join(CONNECTORS_DIR, 'dingtalk/connector.yaml'));
    const operationFields = manifest.config.filter((f) => f.type === 'operation');
    assert.equal(operationFields.length, 0, 'dingtalk should have no operation fields');
  });
});
