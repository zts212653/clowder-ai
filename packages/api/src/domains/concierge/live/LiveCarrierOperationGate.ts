export interface LiveCarrierIdentity {
  readonly invocationId: string;
  readonly catId: string;
  readonly threadId: string;
}

/** Server-owned admission proof; valid only for this operation until it settles. */
export interface LiveCarrierOperationLease {
  matches(query: LiveCarrierIdentity): boolean;
}

export class LiveCarrierUnavailableError extends Error {
  readonly statusCode = 409;
  readonly code = 'LIVE_CARRIER_UNAVAILABLE';
  constructor() {
    super('Live carrier unavailable or closing');
  }
}

/** Accepted source operations finish before a carrier may publish its terminal. */
export class LiveCarrierOperationGate {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new LiveCarrierUnavailableError());
    const pending = Promise.resolve().then(operation);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }

  runForCarrier<T>(
    query: LiveCarrierIdentity,
    operation: (lease: LiveCarrierOperationLease) => Promise<T>,
  ): Promise<T> {
    const { invocationId, catId, threadId } = query;
    let active = true;
    const lease: LiveCarrierOperationLease = {
      matches: (candidate) =>
        active &&
        candidate.invocationId === invocationId &&
        candidate.catId === catId &&
        candidate.threadId === threadId,
    };
    return this.run(async () => {
      try {
        return await operation(lease);
      } finally {
        active = false;
      }
    });
  }

  close(): void {
    this.closed = true;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
