/**
 * RFC #1356 test-fixture bridge.
 *
 * Historical suites often build Store/Queue inputs with the old catId/source
 * projections. Production writers must never rely on this bridge: it is
 * intentionally scoped to tests so the runtime append/enqueue boundaries stay
 * fail-closed when MessageFrom is absent.
 */

const MESSAGE_STORE_ADAPTED = Symbol('message-store-from-fixtures');
const INVOCATION_QUEUE_ADAPTED = Symbol('invocation-queue-from-fixtures');

export function canonicalTestMessageInput(input) {
  const { catId, lifecycle: legacyLifecycle, ...rest } = input;
  const { from: lifecycleFrom, ...lifecycle } = legacyLifecycle ?? {};
  const from =
    input.from ??
    lifecycleFrom ??
    (catId === 'system'
      ? { kind: 'system', service: input.source?.connector ?? 'test-fixture' }
      : input.extra?.pluginMessage?.instanceId
        ? { kind: 'plugin', instanceId: input.extra.pluginMessage.instanceId }
        : catId
          ? { kind: 'agent', catId }
          : input.userId === 'system' || input.userId === 'scheduler'
            ? { kind: 'system', service: input.source?.connector ?? 'test-fixture' }
            : input.source
              ? {
                  kind: 'external',
                  connectorId: input.source.connector,
                  ...(input.source.sender ? { sender: input.source.sender } : {}),
                }
              : { kind: 'user', userId: input.userId });
  return {
    ...rest,
    from,
    ...(legacyLifecycle ? { lifecycle } : {}),
  };
}

export function adaptMessageStore(store) {
  if (store[MESSAGE_STORE_ADAPTED]) return store;
  const append = store.append.bind(store);
  const appendWithQueueCustodyAdmission = store.appendWithQueueCustodyAdmission?.bind(store);
  store.append = (input) => append(canonicalTestMessageInput(input));
  if (appendWithQueueCustodyAdmission) {
    store.appendWithQueueCustodyAdmission = (input, buildAdmission) =>
      appendWithQueueCustodyAdmission(canonicalTestMessageInput(input), buildAdmission);
  }
  Object.defineProperty(store, MESSAGE_STORE_ADAPTED, { value: true });
  return store;
}

export function canonicalTestQueueInput(input) {
  if (input.from) return input;
  const { source = 'user', callerCatId, senderMeta, ...rest } = input;
  const from =
    source === 'agent'
      ? { kind: 'agent', catId: callerCatId ?? 'opus' }
      : source === 'connector'
        ? {
            kind: 'external',
            connectorId: senderMeta?.connector ?? 'test-fixture',
            ...(senderMeta?.id
              ? { sender: { id: senderMeta.id, ...(senderMeta.name ? { name: senderMeta.name } : {}) } }
              : {}),
          }
        : source === 'system'
          ? { kind: 'system', service: 'test-fixture' }
          : { kind: 'user', userId: input.userId };
  return { ...rest, from };
}

export function adaptInvocationQueue(queue) {
  if (queue[INVOCATION_QUEUE_ADAPTED]) return queue;
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = (input) => enqueue(canonicalTestQueueInput(input));
  Object.defineProperty(queue, INVOCATION_QUEUE_ADAPTED, { value: true });
  return queue;
}
