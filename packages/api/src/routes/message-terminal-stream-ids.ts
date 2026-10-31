import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';

/** Independent posts share execution provenance but do not replace the stream's draft. */
export function collectTerminalStreamInvocationIds(
  messages: readonly Pick<StoredMessage, 'extra'>[],
  ids = new Set<string>(),
): Set<string> {
  for (const message of messages) {
    if (message.extra?.isExplicitPost === true) continue;
    const stream = message.extra?.stream;
    if (stream?.invocationId) ids.add(stream.invocationId);
    if (stream?.turnInvocationId) ids.add(stream.turnInvocationId);
  }
  return ids;
}
