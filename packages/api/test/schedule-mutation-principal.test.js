import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveScheduleMutationPrincipal } from '../dist/routes/schedule-mutation-principal.js';

function request(overrides = {}) {
  return {
    headers: {},
    ...overrides,
  };
}

describe('resolveScheduleMutationPrincipal', () => {
  it('classifies an authenticated owner session as the direct operator principal', () => {
    assert.deepEqual(resolveScheduleMutationPrincipal(request({ sessionUserId: 'owner-user' }), 'owner-user'), {
      ok: true,
      principal: { kind: 'cvo', userId: 'owner-user' },
    });
  });

  it('classifies a verified invocation callback as a cat even when a session is also present', () => {
    const callbackPrincipal = {
      kind: 'invocation',
      invocationId: 'inv-1',
      parentInvocationId: 'outer-1',
      threadId: 'thread-1',
      userId: 'owner-user',
      catId: 'codex-sol',
    };
    assert.deepEqual(
      resolveScheduleMutationPrincipal(
        request({
          sessionUserId: 'owner-user',
          callbackPrincipal,
        }),
        'owner-user',
      ),
      {
        ok: true,
        principal: {
          kind: 'cat',
          authKind: 'invocation',
          invocationId: 'inv-1',
          parentInvocationId: 'outer-1',
          threadId: 'thread-1',
          userId: 'owner-user',
          catId: 'codex-sol',
        },
      },
    );
  });

  it('classifies a verified agent-key principal as a cat', () => {
    const callbackPrincipal = {
      kind: 'agent_key',
      agentKeyId: 'ak-1',
      userId: 'owner-user',
      catId: 'gemini35',
      scope: 'user-bound',
    };
    assert.deepEqual(resolveScheduleMutationPrincipal(request({ callbackPrincipal }), 'owner-user'), {
      ok: true,
      principal: {
        kind: 'cat',
        authKind: 'agent_key',
        agentKeyId: 'ak-1',
        userId: 'owner-user',
        catId: 'gemini35',
      },
    });
  });

  it('rejects missing, body-claimed, header-only and default-fallback identities', () => {
    for (const candidate of [
      request(),
      request({ body: { createdBy: 'codex-sol' } }),
      request({ headers: { 'x-cat-cafe-user': 'owner-user' } }),
      request({ headers: { 'x-cat-cafe-user': 'default-user' } }),
      request({ headers: { 'x-invocation-id': 'forged', 'x-callback-token': 'forged' } }),
    ]) {
      assert.deepEqual(resolveScheduleMutationPrincipal(candidate, 'owner-user'), {
        ok: false,
        statusCode: 401,
        code: 'SCHEDULE_MUTATION_AUTH_REQUIRED',
        error: 'Authenticated owner session or verified cat principal required',
      });
    }
  });

  it('rejects a session or verified cat principal owned by another user', () => {
    assert.deepEqual(resolveScheduleMutationPrincipal(request({ sessionUserId: 'other-user' }), 'owner-user'), {
      ok: false,
      statusCode: 403,
      code: 'SCHEDULE_MUTATION_OWNER_MISMATCH',
      error: 'Schedule mutation principal is not owned by the configured user',
    });
    assert.deepEqual(
      resolveScheduleMutationPrincipal(
        request({
          callbackPrincipal: {
            kind: 'invocation',
            invocationId: 'inv-other',
            threadId: 'thread-other',
            userId: 'other-user',
            catId: 'opus',
          },
        }),
        'owner-user',
      ),
      {
        ok: false,
        statusCode: 403,
        code: 'SCHEDULE_MUTATION_OWNER_MISMATCH',
        error: 'Schedule mutation principal is not owned by the configured user',
      },
    );
  });
});
