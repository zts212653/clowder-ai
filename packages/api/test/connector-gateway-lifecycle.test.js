/**
 * F136 Phase 2: Connector gateway restart lifecycle tests
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { restartConnectorGateway } from '../dist/infrastructure/connectors/connector-gateway-lifecycle.js';

describe('restartConnectorGateway', () => {
  it('calls stop() on old handle before starting new one', async () => {
    const callOrder = [];
    const oldHandle = {
      stop: async () => {
        callOrder.push('stop');
      },
    };
    const mockStart = async () => {
      callOrder.push('start');
      return { outboundHook: {}, streamingHook: {}, stop: async () => {} };
    };

    await restartConnectorGateway(oldHandle, mockStart);
    assert.deepEqual(callOrder, ['stop', 'start']);
  });

  it('skips stop when old handle is null', async () => {
    const callOrder = [];
    const mockStart = async () => {
      callOrder.push('start');
      return { outboundHook: {}, streamingHook: {}, stop: async () => {} };
    };

    await restartConnectorGateway(null, mockStart);
    assert.deepEqual(callOrder, ['start']);
  });

  it('returns the new handle from startFn', async () => {
    const newHandle = { outboundHook: 'new', streamingHook: 'new', stop: async () => {} };
    const result = await restartConnectorGateway(null, async () => newHandle);
    assert.equal(result, newHandle);
  });

  it('returns null when startFn returns null (no connectors configured)', async () => {
    const result = await restartConnectorGateway(null, async () => null);
    assert.equal(result, null);
  });

  it('propagates startFn errors after stopping old handle', async () => {
    let stopped = false;
    const oldHandle = {
      stop: async () => {
        stopped = true;
      },
    };
    const err = new Error('start failed');

    await assert.rejects(
      () =>
        restartConnectorGateway(oldHandle, async () => {
          throw err;
        }),
      (thrown) => thrown === err,
    );
    assert.ok(stopped, 'old handle was stopped before error');
  });
});
