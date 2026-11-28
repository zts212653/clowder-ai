import { describe, expect, it, vi } from 'vitest';
import { dispatchEditorBridgeRequest } from '../bridge-client';

const sessionToken = `editor_${'a'.repeat(40)}`;

function request(operation: string, payload: unknown, token = sessionToken) {
  return {
    v: 1,
    kind: 'cat-cafe-content-editor-request',
    sessionToken: token,
    requestId: 'renderer-1',
    operation,
    payload,
  };
}

describe('content editor bridge client', () => {
  it('loads bytes through the authenticated Host route and transfers an ArrayBuffer to the renderer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            value: {
              contentIdentity: 'content-opaque',
              fileName: 'proposal.docx',
              ownerRevision: 7,
              blobDigest: `sha256:${'b'.repeat(64)}`,
              mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              bytesBase64: 'UEsDBA==',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await dispatchEditorBridgeRequest(request('content.load', {}), {
      expectedSessionToken: sessionToken,
      apiBase: 'http://localhost:3102',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3102/api/collaborative-content/editor-bridge', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, sessionToken, operation: 'content.load', payload: {} }),
    });
    expect(result.response).toMatchObject({
      v: 1,
      kind: 'cat-cafe-content-editor-response',
      sessionToken,
      requestId: 'renderer-1',
      ok: true,
      value: { contentIdentity: 'content-opaque', ownerRevision: 7 },
    });
    const bytes = (result.response.value as { bytes: ArrayBuffer }).bytes;
    expect([...new Uint8Array(bytes)]).toEqual([80, 75, 3, 4]);
    expect(result.transfers).toEqual([bytes]);
  });

  it('encodes settlement bytes and preserves a typed owner conflict', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'owner_revision_conflict', message: 'Owner revision changed', actualOwnerRevision: 8 },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    const bytes = new Uint8Array([1, 2, 3]).buffer;

    const result = await dispatchEditorBridgeRequest(
      request('content.settle', { expectedOwnerRevision: 7, operationId: 'save-8', bytes }),
      { expectedSessionToken: sessionToken, apiBase: '', fetchImpl },
    );

    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual({
      v: 1,
      sessionToken,
      operation: 'content.settle',
      payload: { expectedOwnerRevision: 7, operationId: 'save-8', bytesBase64: 'AQID' },
    });
    expect(result).toEqual({
      response: {
        v: 1,
        kind: 'cat-cafe-content-editor-response',
        sessionToken,
        requestId: 'renderer-1',
        ok: false,
        error: { code: 'owner_revision_conflict', message: 'Owner revision changed' },
      },
      transfers: [],
    });
  });

  it('fails forged tokens and unknown operations closed without Host dispatch', async () => {
    const fetchImpl = vi.fn();
    const forged = await dispatchEditorBridgeRequest(request('content.load', {}, `editor_${'z'.repeat(40)}`), {
      expectedSessionToken: sessionToken,
      apiBase: '',
      fetchImpl,
    });
    const unknown = await dispatchEditorBridgeRequest(request('host.exec', {}), {
      expectedSessionToken: sessionToken,
      apiBase: '',
      fetchImpl,
    });

    expect(forged.response).toMatchObject({ ok: false, error: { code: 'bridge_session_mismatch' } });
    expect(unknown.response).toMatchObject({ ok: false, error: { code: 'bridge_method_denied' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
