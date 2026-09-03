import { describe, expect, it, vi } from 'vitest';

import {
  announcePairingAvailability,
  emitFreshPairingIntent,
  isTrustedPairingRequest,
  resolvePairingAuthority,
  respondToPairingRequest,
  trustedPairingHostRequest,
} from '../pairing-bridge.js';

describe('Collective pairing bridge', () => {
  it('accepts pairing requests only from the bound Host parent', () => {
    const parent = {};
    expect(
      isTrustedPairingRequest(
        { origin: 'http://localhost:3000', source: parent, data: { type: 'collective:request-pairing' } },
        'http://localhost:3000',
        parent,
      ),
    ).toBe(true);
    expect(
      isTrustedPairingRequest(
        { origin: 'http://malicious.invalid', source: parent, data: { type: 'collective:request-pairing' } },
        'http://localhost:3000',
        parent,
      ),
    ).toBe(false);
    expect(
      trustedPairingHostRequest(
        { origin: 'http://localhost:3000', source: parent, data: { type: 'collective:request-pairing-status' } },
        'http://localhost:3000',
        parent,
      ),
    ).toEqual({ type: 'collective:request-pairing-status' });
  });

  it('creates and emits a fresh one-time intent for every Host request', async () => {
    const requestIntent = vi.fn().mockImplementation(async ({ nonce }: { nonce: string }) => ({
      serviceInstanceId: 'svc_12345678',
      collectiveId: 'col_12345678',
      pairingIntentId: `pair_${nonce}`,
      nonce,
      hostOrigin: 'http://localhost:3000',
      expiresAt: '2026-08-29T01:00:00.000Z',
    }));
    const postToHost = vi.fn();
    const nonces = ['nonce_12345678901234567890123456', 'nonce_22345678901234567890123456'];
    const nextNonce = () => {
      const nonce = nonces.shift();
      if (!nonce) throw new Error('test nonce exhausted');
      return nonce;
    };

    await emitFreshPairingIntent({
      collectiveId: 'col_12345678',
      hostOrigin: 'http://localhost:3000',
      serviceUrl: 'http://localhost:5201',
      createNonce: nextNonce,
      requestIntent,
      postToHost,
    });
    await emitFreshPairingIntent({
      collectiveId: 'col_12345678',
      hostOrigin: 'http://localhost:3000',
      serviceUrl: 'http://localhost:5201',
      createNonce: nextNonce,
      requestIntent,
      postToHost,
    });

    expect(requestIntent).toHaveBeenCalledTimes(2);
    expect(requestIntent.mock.calls[0][0].nonce).not.toBe(requestIntent.mock.calls[1][0].nonce);
    expect(postToHost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'collective:pairing-intent',
        serviceUrl: 'http://localhost:5201',
        intent: expect.objectContaining({ pairingIntentId: 'pair_nonce_22345678901234567890123456' }),
      }),
      'http://localhost:3000',
    );
  });

  it('announces readiness for any restored Collective member session', () => {
    const postToHost = vi.fn();

    announcePairingAvailability({
      collectiveId: undefined,
      unavailableCode: 'collective_required',
      hostOrigin: 'http://localhost:3000',
      serviceUrl: 'http://localhost:5201',
      postToHost,
    });
    announcePairingAvailability({
      collectiveId: 'col_12345678',
      hostOrigin: 'http://localhost:3000',
      serviceUrl: 'http://localhost:5201',
      postToHost,
    });

    expect(postToHost).toHaveBeenNthCalledWith(
      1,
      {
        type: 'collective:pairing-error',
        serviceUrl: 'http://localhost:5201',
        code: 'collective_required',
      },
      'http://localhost:3000',
    );
    expect(postToHost).toHaveBeenNthCalledWith(
      2,
      { type: 'collective:pairing-ready', serviceUrl: 'http://localhost:5201' },
      'http://localhost:3000',
    );
  });

  it('allows members to pair their own Café while rejecting missing membership and session', () => {
    expect(resolvePairingAuthority({ phase: 'ready', hasSession: false, collective: undefined })).toMatchObject({
      collectiveId: undefined,
      unavailableCode: 'session_required',
    });
    expect(
      resolvePairingAuthority({
        phase: 'ready',
        hasSession: true,
        collective: { collectiveId: 'col_12345678', role: 'member' },
      }),
    ).toMatchObject({ collectiveId: 'col_12345678' });
    expect(
      resolvePairingAuthority({
        phase: 'ready',
        hasSession: true,
        collective: { collectiveId: 'col_12345678', role: 'steward' },
      }),
    ).toMatchObject({ collectiveId: 'col_12345678' });
    expect(resolvePairingAuthority({ phase: 'ready', hasSession: true, collective: undefined })).toMatchObject({
      collectiveId: undefined,
      unavailableCode: 'collective_required',
    });
    expect(resolvePairingAuthority({ phase: 'unavailable', hasSession: true, collective: undefined })).toMatchObject({
      collectiveId: undefined,
      unavailableCode: 'client_unavailable',
    });
  });

  it('returns explicit errors when a Host request has no session or intent creation fails', async () => {
    const postToHost = vi.fn();
    const requestIntent = vi.fn().mockRejectedValue(new Error('session expired'));
    const common = {
      hostOrigin: 'http://localhost:3000',
      serviceUrl: 'http://localhost:5201',
      createNonce: () => 'nonce_12345678901234567890123456',
      requestIntent,
      postToHost,
    };

    await respondToPairingRequest({ ...common, collectiveId: undefined });
    expect(requestIntent).not.toHaveBeenCalled();
    expect(postToHost).toHaveBeenLastCalledWith(
      {
        type: 'collective:pairing-error',
        serviceUrl: 'http://localhost:5201',
        code: 'session_required',
      },
      'http://localhost:3000',
    );

    await respondToPairingRequest({
      ...common,
      collectiveId: 'col_12345678',
      classifyError: () => 'session_required',
    });
    expect(postToHost).toHaveBeenLastCalledWith(
      {
        type: 'collective:pairing-error',
        serviceUrl: 'http://localhost:5201',
        code: 'session_required',
      },
      'http://localhost:3000',
    );
  });
});
