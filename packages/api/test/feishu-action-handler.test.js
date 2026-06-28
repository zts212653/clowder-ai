import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleFeishuAction } from '../dist/infrastructure/connectors/im-connectors/feishu/feishu-action-handler.js';

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('handleFeishuAction', () => {
  it('persists pending websocket mode when QR auth confirms', async () => {
    let polledPayload;

    const result = await handleFeishuAction('qr-status', {
      env: {
        FEISHU_CONNECTION_MODE: 'websocket',
        FEISHU_VERIFICATION_TOKEN: '',
      },
      log: silentLog,
      operationState: {
        lastResult: {
          render: 'img',
          data: { qrPayload: 'qr-payload-123' },
        },
      },
      _testOverrides: {
        feishuQrBindClient: {
          async create() {
            throw new Error('not used');
          },
          async poll(qrPayload) {
            polledPayload = qrPayload;
            return {
              status: 'confirmed',
              appId: 'cli_feishu',
              appSecret: 'sec_feishu',
            };
          },
        },
      },
    });

    assert.equal(polledPayload, 'qr-payload-123');
    assert.equal(result.render, 'status');
    assert.deepEqual(result.targetValues, {
      FEISHU_APP_ID: 'cli_feishu',
      FEISHU_APP_SECRET: 'sec_feishu',
      FEISHU_CONNECTION_MODE: 'websocket',
    });
  });

  it('persists pending verification token when QR auth confirms webhook mode', async () => {
    const result = await handleFeishuAction('qr-status', {
      env: {
        FEISHU_CONNECTION_MODE: 'webhook',
        FEISHU_VERIFICATION_TOKEN: 'vt_pending',
      },
      log: silentLog,
      operationState: {
        lastResult: {
          render: 'img',
          data: { qrPayload: 'qr-payload-webhook' },
        },
      },
      _testOverrides: {
        feishuQrBindClient: {
          async create() {
            throw new Error('not used');
          },
          async poll() {
            return {
              status: 'confirmed',
              appId: 'cli_feishu_webhook',
              appSecret: 'sec_feishu_webhook',
            };
          },
        },
      },
    });

    assert.equal(result.render, 'status');
    assert.deepEqual(result.targetValues, {
      FEISHU_APP_ID: 'cli_feishu_webhook',
      FEISHU_APP_SECRET: 'sec_feishu_webhook',
      FEISHU_CONNECTION_MODE: 'webhook',
      FEISHU_VERIFICATION_TOKEN: 'vt_pending',
    });
  });
});
