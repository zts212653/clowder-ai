export interface ThreadChatHistoryConsumer {
  threadId: string;
  consumerId: symbol;
  startBootstrap: (registrationGeneration: symbol) => Promise<void>;
}

export interface ThreadChatHistoryRequest<T> {
  threadId: string;
  consumerId: symbol;
  requestKey: string;
  task: () => Promise<T>;
  /**
   * Start the task only once no other request of this thread is running, on any surface. A
   * catch-up must be a read issued after the reads already in flight (each surface turns a read
   * away while its own is running): waiting here runs nothing, so it cannot spend the caller's
   * failure retries, and the read it then issues lands after theirs.
   */
  startWhenIdle?: boolean;
}

export type ThreadChatHistoryBootstrapOutcome = 'succeeded' | 'failed';

export type ThreadChatHistoryRequestResult<T> = { status: 'completed'; value: T } | { status: 'abandoned' };

export interface ThreadChatHistoryAdmission {
  register(consumer: ThreadChatHistoryConsumer): () => void;
  completeBootstrap(
    threadId: string,
    consumerId: symbol,
    registrationGeneration: symbol,
    outcome: ThreadChatHistoryBootstrapOutcome,
  ): void;
  runRequest<T>(request: ThreadChatHistoryRequest<T>): Promise<ThreadChatHistoryRequestResult<T>>;
}

interface RegisteredThreadChatHistoryConsumer extends ThreadChatHistoryConsumer {
  registrationGeneration: symbol;
}

interface HistoryRequestEntry {
  consumerId: symbol;
  registrationGeneration: symbol;
  abandoned: boolean;
  /** The task has been started (a `startWhenIdle` request is not running while it waits). */
  running: boolean;
  promise: Promise<ThreadChatHistoryRequestResult<unknown>>;
  /** Settles after the request has left `requests`. */
  settled: Promise<void>;
}

interface ThreadAdmissionEntry {
  consumers: Map<symbol, RegisteredThreadChatHistoryConsumer>;
  ownerId: symbol;
  status: 'running' | 'ready' | 'failed';
  requests: Map<string, HistoryRequestEntry>;
}

function requireCoordinate(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

export function createThreadChatHistoryAdmission(): ThreadChatHistoryAdmission {
  const entries = new Map<string, ThreadAdmissionEntry>();

  const markOwnerFailed = (threadId: string, ownerId: symbol, registrationGeneration: symbol) => {
    const entry = entries.get(threadId);
    const owner = entry?.consumers.get(ownerId);
    if (
      entry?.ownerId === ownerId &&
      owner?.registrationGeneration === registrationGeneration &&
      entry.status === 'running'
    ) {
      entry.status = 'failed';
    }
  };

  const startOwner = (threadId: string, ownerId: symbol) => {
    const entry = entries.get(threadId);
    if (!entry || entry.ownerId !== ownerId || entry.status !== 'running') return;
    const owner = entry.consumers.get(ownerId);
    if (!owner) return;
    try {
      void owner.startBootstrap(owner.registrationGeneration).catch(() => {
        markOwnerFailed(threadId, ownerId, owner.registrationGeneration);
      });
    } catch {
      markOwnerFailed(threadId, ownerId, owner.registrationGeneration);
    }
  };

  const unregister = (threadId: string, consumerId: symbol, registrationGeneration: symbol) => {
    const entry = entries.get(threadId);
    if (!entry) return;
    const consumer = entry.consumers.get(consumerId);
    if (consumer?.registrationGeneration !== registrationGeneration) return;
    entry.consumers.delete(consumerId);

    for (const [requestKey, request] of entry.requests) {
      if (request.consumerId === consumerId && request.registrationGeneration === registrationGeneration) {
        request.abandoned = true;
        entry.requests.delete(requestKey);
      }
    }

    if (entry.consumers.size === 0) {
      entries.delete(threadId);
      return;
    }
    if (entry.ownerId !== consumerId) return;

    const nextOwnerId = entry.consumers.keys().next().value;
    if (typeof nextOwnerId !== 'symbol') {
      entries.delete(threadId);
      return;
    }
    entry.ownerId = nextOwnerId;
    if (entry.status !== 'ready') {
      entry.status = 'running';
      startOwner(threadId, nextOwnerId);
    }
  };

  const register = (consumer: ThreadChatHistoryConsumer) => {
    const threadId = requireCoordinate(consumer.threadId, 'threadId');
    const existing = entries.get(threadId);
    if (existing?.consumers.has(consumer.consumerId)) {
      throw new Error(`history consumer already registered for ${threadId}`);
    }
    const registrationGeneration = Symbol('thread-chat-history-registration');
    const registeredConsumer: RegisteredThreadChatHistoryConsumer = {
      ...consumer,
      threadId,
      registrationGeneration,
    };

    if (existing) {
      existing.consumers.set(consumer.consumerId, registeredConsumer);
      if (existing.status === 'failed') {
        existing.ownerId = consumer.consumerId;
        existing.status = 'running';
        startOwner(threadId, consumer.consumerId);
      }
    } else {
      const entry: ThreadAdmissionEntry = {
        consumers: new Map([[consumer.consumerId, registeredConsumer]]),
        ownerId: consumer.consumerId,
        status: 'running',
        requests: new Map(),
      };
      entries.set(threadId, entry);
      startOwner(threadId, consumer.consumerId);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      unregister(threadId, consumer.consumerId, registrationGeneration);
    };
  };

  const completeBootstrap = (
    rawThreadId: string,
    consumerId: symbol,
    registrationGeneration: symbol,
    outcome: ThreadChatHistoryBootstrapOutcome,
  ) => {
    const threadId = requireCoordinate(rawThreadId, 'threadId');
    const entry = entries.get(threadId);
    const owner = entry?.consumers.get(consumerId);
    if (
      !entry ||
      entry.ownerId !== consumerId ||
      owner?.registrationGeneration !== registrationGeneration ||
      entry.status !== 'running'
    ) {
      return;
    }
    entry.status = outcome === 'succeeded' ? 'ready' : 'failed';
  };

  /**
   * Start `start` once no other request of the thread is running. The check and the start happen
   * in one synchronous step, and every wait is on a running request's settlement, so this never
   * spins; requests that are themselves still waiting are not waited on, so two never deadlock.
   */
  const startOnceIdle = <T>(threadId: string, request: HistoryRequestEntry, start: () => Promise<T>) => {
    const waitForIdle = (): Promise<T | undefined> => {
      if (request.abandoned) return Promise.resolve(undefined);
      const running = [...(entries.get(threadId)?.requests.values() ?? [])].filter(
        (candidate) => candidate !== request && candidate.running,
      );
      if (running.length === 0) return start();
      return Promise.all(running.map((candidate) => candidate.settled)).then(waitForIdle);
    };
    return waitForIdle();
  };

  const runRequest = <T>({
    threadId: rawThreadId,
    consumerId,
    requestKey: rawRequestKey,
    task,
    startWhenIdle,
  }: ThreadChatHistoryRequest<T>): Promise<ThreadChatHistoryRequestResult<T>> => {
    const threadId = requireCoordinate(rawThreadId, 'threadId');
    const requestKey = requireCoordinate(rawRequestKey, 'requestKey');
    const entry = entries.get(threadId);
    const consumer = entry?.consumers.get(consumerId);
    if (!entry || !consumer) {
      return Promise.reject(new Error(`history consumer is not registered for ${threadId}`));
    }

    const existing = entry.requests.get(requestKey);
    if (existing) return existing.promise as Promise<ThreadChatHistoryRequestResult<T>>;

    const request: HistoryRequestEntry = {
      consumerId,
      registrationGeneration: consumer.registrationGeneration,
      abandoned: false,
      running: false,
      promise: Promise.resolve({ status: 'abandoned' }),
      settled: Promise.resolve(),
    };
    const start = (): Promise<T> => {
      request.running = true;
      try {
        return task();
      } catch (error) {
        return Promise.reject(error);
      }
    };
    // An abandoned waiter never starts its task and resolves as abandoned below.
    const taskPromise = (startWhenIdle ? startOnceIdle(threadId, request, start) : start()) as Promise<T>;
    const promise: Promise<ThreadChatHistoryRequestResult<T>> = taskPromise.then(
      (value): ThreadChatHistoryRequestResult<T> =>
        request.abandoned ? { status: 'abandoned' } : { status: 'completed', value },
      (error: unknown): ThreadChatHistoryRequestResult<T> => {
        if (request.abandoned) return { status: 'abandoned' };
        throw error;
      },
    );
    request.promise = promise as Promise<ThreadChatHistoryRequestResult<unknown>>;
    entry.requests.set(requestKey, request);
    const clearRequest = () => {
      const currentEntry = entries.get(threadId);
      const currentRequest = currentEntry?.requests.get(requestKey);
      if (currentRequest?.consumerId === consumerId && currentRequest === request) {
        currentEntry?.requests.delete(requestKey);
      }
    };
    request.settled = promise.then(clearRequest, clearRequest);
    return promise;
  };

  return { register, completeBootstrap, runRequest };
}
