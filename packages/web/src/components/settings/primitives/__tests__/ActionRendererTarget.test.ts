import { describe, expect, it } from 'vitest';
import { actionRequest, operationResetRequest } from '../ActionRendererState';

describe('ActionRenderer target requests', () => {
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
    expect(operationResetRequest({ kind: 'plugin', id: 'dev.clowder.fixture' }, 'qr login')).toEqual({
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
