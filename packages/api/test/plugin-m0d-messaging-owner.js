class ObservableLedgerStore {
  #entries = new Map();

  constructor(delegate) {
    this.delegate = delegate;
  }

  async claim(key, ttlMs) {
    const result = await this.delegate.claim(key, ttlMs);
    if (result.status === 'new') this.#entries.set(key, 'inflight');
    if (result.status === 'settled') this.#entries.set(key, 'settled');
    return result;
  }

  async settle(key, claimToken, receipt, retentionMs) {
    const result = await this.delegate.settle(key, claimToken, receipt, retentionMs);
    if (result.status === 'freshly_settled' || result.status === 'already_settled') {
      this.#entries.set(key, 'settled');
    }
    return result;
  }

  async release(key, claimToken) {
    await this.delegate.release(key, claimToken);
    if (this.#entries.get(key) === 'inflight') this.#entries.delete(key);
  }

  snapshot() {
    return [...this.#entries].sort(([left], [right]) => left.localeCompare(right));
  }
}

export async function createMessagingOwner(retentionCount) {
  const [
    { MessageStore },
    { HandleService },
    { MessagingLedger },
    { SendService },
    { AppendService },
    { EventStreamService },
    memory,
  ] = await Promise.all([
    import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../dist/domains/messaging/handles.js'),
    import('../dist/domains/messaging/ledger.js'),
    import('../dist/domains/messaging/send-service.js'),
    import('../dist/domains/messaging/append-service.js'),
    import('../dist/domains/messaging/event-stream.js'),
    import('../dist/domains/messaging/stores/memory.js'),
  ]);
  const messageStore = new MessageStore();
  const handleStore = new memory.MemoryHandleStore();
  const cursorStore = new memory.MemoryCursorStore();
  const events = new memory.MemoryEventLogStore();
  const ledgerStore = new ObservableLedgerStore(new memory.MemoryLedgerStore());
  const handles = new HandleService(handleStore, cursorStore);
  const ledger = new MessagingLedger(ledgerStore);
  const send = new SendService({
    messageStore,
    handles,
    ledger,
    events,
    retentionCount,
    isKnownCatId: () => true,
  });
  const append = new AppendService({
    messageStore,
    handles,
    ledger,
    events,
    appendLock: new memory.MemoryAppendLock(),
    retentionCount,
  });
  const stream = new EventStreamService({ events, cursors: cursorStore, handles, messageStore });
  const messaging = {
    send: (context, input) => send.send(context, input),
    appendElements: (context, input) => append.appendElements(context, input),
    subscribe: (context, handle) => stream.subscribe(context, handle),
    read: (context, subscriptionId, options) => stream.read(context, subscriptionId, options),
    ack: (context, subscriptionId, token) => stream.ack(context, subscriptionId, token),
    snapshotPage: (context, input) => stream.snapshotPage(context, input),
  };
  return { messaging, messageStore, handleStore, cursorStore, events, ledgerStore, stream };
}
