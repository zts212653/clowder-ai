import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';

export function opaqueRef(auth: InvocationRecord, operation: string, sourceRef: string): string {
  return createHmac('sha256', auth.callbackToken)
    .update(JSON.stringify([auth.invocationId, operation, sourceRef]))
    .digest('base64url');
}

export function verifyRef(auth: InvocationRecord, actual: string, operation: string, sourceRef: string) {
  const expected = Buffer.from(opaqueRef(auth, operation, sourceRef));
  const received = Buffer.from(actual);
  if (received.length !== expected.length || !timingSafeEqual(expected, received))
    throw collectiveContextError(
      'RETURN_REF_INVALID',
      'This reference does not belong to the current invocation and source',
    );
}

export function collectiveContextError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
