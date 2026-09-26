import { describe, expect, it } from 'vitest';
import { actionRequest, operationResetRequest } from '../ActionRendererState';

describe('ActionRenderer target requests', () => {
  it('keeps the connector URL and nested values body', () => {
    expect(actionRequest({ kind: 'connector', id: 'weixin' }, 'connect', 'qr generate', { token: 'draft' })).toEqual({
      url: '/api/connectors/weixin/actions/connect/qr%20generate',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { token: 'draft' } }),
      },
    });
    expect(operationResetRequest({ kind: 'connector', id: 'weixin' }, 'connect', 'qr-generate')).toEqual({
      url: '/api/connectors/weixin/operations/connect/reset',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentAction: 'qr-generate' }),
      },
    });
  });

  it('uses plugin URLs with a flat draft body', () => {
    expect(
      actionRequest({ kind: 'plugin', id: 'dev.clowder.fixture' }, 'qr login', 'generate', { token: 'draft' }),
    ).toEqual({
      url: '/api/plugins/dev.clowder.fixture/actions/qr%20login/generate',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'draft' }),
      },
    });
    expect(operationResetRequest({ kind: 'plugin', id: 'dev.clowder.fixture' }, 'qr login', 'generate')).toEqual({
      url: '/api/plugins/dev.clowder.fixture/operations/qr%20login/reset',
      init: { method: 'POST' },
    });
  });

  it('omits the body when a plugin action has no draft values', () => {
    expect(actionRequest({ kind: 'plugin', id: 'fixture' }, 'connect', 'generate')).toEqual({
      url: '/api/plugins/fixture/actions/connect/generate',
      init: { method: 'POST' },
    });
  });
});
