import { digestBrokerValue } from '../host-broker/canonical-json.js';

export interface OutputOperation {
  readonly id: string;
  readonly digest: string;
  readonly revision: number;
  readonly phase: 'preparing' | 'reserved' | 'dispatched' | 'produced' | 'delivered' | 'rejected';
  readonly reservationRef?: string;
  readonly sourceRef?: string;
  readonly refusal?: 'producer_refused';
  readonly refusalCode?: string;
}

/** Internal candidate only. The eventual adapter must use the Host's durable operation owner. */
export interface OutputOperationStore {
  get(id: string): Promise<OutputOperation | undefined>;
  create(record: OutputOperation): Promise<boolean>;
  replace(expectedRevision: number, record: OutputOperation): Promise<boolean>;
}

export interface OutputDispatchRequest {
  /** Host-bound installation + caller operation identity, not an untrusted plugin key. */
  readonly operationId: string;
  readonly targetKeys: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface OutputDispatchPorts {
  readonly store: OutputOperationStore;
  /** Recheck the intersected install, caller and current output authority. */
  authorize(): Promise<void>;
  /** Host reserves the complete canonical target set or refuses; idempotent for this operation. */
  reserve(request: OutputDispatchRequest): Promise<string>;
  /** Producer persists the owned result under operationId before returning its reference. */
  produce(request: Pick<OutputDispatchRequest, 'operationId' | 'parameters'>): Promise<string>;
  /** Read-only lookup, never a paid retry. Returned reference must already be durable. */
  lookupProduced(operationId: string): Promise<string | undefined>;
  /** Host checks operation/source ownership, format, size and digest. This does not regenerate. */
  accept(operationId: string, sourceRef: string): Promise<void>;
  /** Idempotent Host delivery; resolves only after every output is durable. */
  deliver(reservationRef: string, sourceRef: string): Promise<void>;
}

export type OutputDispatchResult = {
  readonly state: 'pending' | 'generation_unknown' | 'delivery_required' | 'delivered' | 'rejected';
  readonly reason?: 'producer_refused';
  readonly code?: string;
};

/** The trusted adapter distinguishes a structured refusal from an uncertain thrown failure. */
export class OutputProducerRefused extends Error {
  constructor(readonly code?: string) {
    super('producer_refused');
  }
}
export class OutputProductionPending extends Error {}
export class OutputGenerationUnknown extends Error {
  constructor(readonly code?: string) {
    super('generation_unknown');
  }
}

/** No route, public permission, target resolver or filesystem adapter is registered by this candidate. */
export class PluginOutputDispatch {
  constructor(private readonly ports: OutputDispatchPorts) {}

  async run(input: OutputDispatchRequest): Promise<OutputDispatchResult> {
    const request = structuredClone(input);
    await this.ports.authorize();
    let row = await this.claim(request);

    if (row.phase === 'preparing') row = await this.reserve(row, request);
    if (row.phase === 'reserved') {
      const outcome = await this.dispatch(row, request);
      if (!('phase' in outcome)) return outcome;
      row = outcome;
    }

    if (row.phase === 'dispatched') {
      try {
        const sourceRef = await this.ports.lookupProduced(row.id);
        if (sourceRef === undefined) return { state: 'generation_unknown' };
        row = await this.accept(row, sourceRef);
      } catch (error) {
        if (error instanceof OutputProductionPending) return { state: 'pending' };
        if (error instanceof OutputGenerationUnknown)
          return { state: 'generation_unknown', ...(error.code ? { code: error.code } : {}) };
        if (error instanceof OutputProducerRefused) return this.reject(row, error);
        return { state: 'generation_unknown' };
      }
    }
    if (row.phase === 'produced') return this.deliver(row);
    if (row.phase === 'delivered') return { state: 'delivered' };
    if (row.phase === 'rejected')
      return {
        state: 'rejected',
        ...(row.refusal ? { reason: row.refusal } : {}),
        ...(row.refusalCode ? { code: row.refusalCode } : {}),
      };
    return { state: 'pending' };
  }

  private async dispatch(
    row: OutputOperation,
    request: OutputDispatchRequest,
  ): Promise<OutputOperation | OutputDispatchResult> {
    await this.ports.authorize();
    const dispatched = { ...row, revision: row.revision + 1, phase: 'dispatched' as const };
    if (!(await this.ports.store.replace(row.revision, dispatched))) return this.read(row.id);
    // The durable dispatch boundary precedes the first possible paid effect.
    try {
      const sourceRef = await this.ports.produce({ operationId: row.id, parameters: request.parameters });
      return await this.accept(dispatched, sourceRef);
    } catch (error) {
      if (error instanceof OutputProductionPending) return { state: 'pending' };
      if (error instanceof OutputGenerationUnknown)
        return { state: 'generation_unknown', ...(error.code ? { code: error.code } : {}) };
      if (error instanceof OutputProducerRefused) return this.reject(dispatched, error);
      // Includes response loss and failure to record a returned result. Never redispatch.
      return { state: 'generation_unknown' };
    }
  }

  private async reject(row: OutputOperation, error: OutputProducerRefused): Promise<OutputDispatchResult> {
    await this.ports.store.replace(row.revision, {
      ...row,
      revision: row.revision + 1,
      phase: 'rejected',
      refusal: 'producer_refused',
      ...(error.code ? { refusalCode: error.code } : {}),
    });
    return { state: 'rejected', reason: 'producer_refused', ...(error.code ? { code: error.code } : {}) };
  }

  private async claim(request: OutputDispatchRequest): Promise<OutputOperation> {
    if (
      request.targetKeys.length === 0 ||
      request.targetKeys.some((key) => key.length === 0) ||
      new Set(request.targetKeys).size !== request.targetKeys.length
    )
      throw new Error('invalid_targets');
    const digest = digestBrokerValue({
      parameters: request.parameters,
      targetKeys: [...request.targetKeys].sort(),
    });
    await this.ports.store.create({ id: request.operationId, digest, revision: 1, phase: 'preparing' });
    const row = await this.read(request.operationId);
    if (row.digest !== digest) throw new Error('operation_conflict');
    return row;
  }

  private async reserve(row: OutputOperation, request: OutputDispatchRequest): Promise<OutputOperation> {
    let reservationRef: string;
    try {
      reservationRef = await this.ports.reserve(request);
    } catch (error) {
      const code =
        error instanceof Error &&
        ['target_conflict', 'path_not_allowed', 'operation_conflict', 'target_changed'].includes(error.message)
          ? error.message
          : 'reservation_failed';
      await this.ports.store.replace(row.revision, {
        ...row,
        revision: row.revision + 1,
        phase: 'rejected',
        refusalCode: code,
      });
      return this.read(row.id);
    }
    await this.ports.store.replace(row.revision, {
      ...row,
      revision: row.revision + 1,
      phase: 'reserved',
      reservationRef,
    });
    return this.read(row.id);
  }

  private async accept(row: OutputOperation, sourceRef: string): Promise<OutputOperation> {
    await this.ports.accept(row.id, sourceRef);
    await this.ports.store.replace(row.revision, {
      ...row,
      revision: row.revision + 1,
      phase: 'produced',
      sourceRef,
    });
    return this.read(row.id);
  }

  private async deliver(row: OutputOperation): Promise<OutputDispatchResult> {
    try {
      await this.ports.authorize();
      if (!row.reservationRef || !row.sourceRef) throw new Error('incomplete_output_record');
      await this.ports.deliver(row.reservationRef, row.sourceRef);
      await this.ports.store.replace(row.revision, {
        ...row,
        revision: row.revision + 1,
        phase: 'delivered',
      });
      return { state: (await this.read(row.id)).phase === 'delivered' ? 'delivered' : 'delivery_required' };
    } catch {
      // Produced media remains with its canonical owner; only delivery is recoverable here.
      return { state: 'delivery_required' };
    }
  }

  private async read(id: string): Promise<OutputOperation> {
    const row = await this.ports.store.get(id);
    if (!row) throw new Error('output_operation_missing');
    return row;
  }
}
