import { createHash, randomUUID } from 'node:crypto';
import type { MeetingIntakeStore } from './MeetingIntakeStore.js';

export type SourceAccessPurpose = 'transcript';
export type SourceAccessLeaseState = 'issued' | 'consumed' | 'revoked';

export interface SourceAccessLeaseRecord {
  readonly grantHash: string;
  readonly intakeId: string;
  readonly sourceHandle: string;
  readonly principalId: string;
  readonly purpose: SourceAccessPurpose;
  readonly state: SourceAccessLeaseState;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SourceAccessLeaseStore {
  create(record: SourceAccessLeaseRecord): Promise<void>;
  claim(
    grantHash: string,
    scope: Pick<SourceAccessLeaseRecord, 'intakeId' | 'principalId' | 'purpose'>,
    now: number,
  ): Promise<SourceAccessLeaseClaimResult>;
  revoke(grantHash: string): Promise<void>;
}

export type SourceAccessLeaseClaimResult =
  | { readonly outcome: 'claimed'; readonly record: SourceAccessLeaseRecord }
  | { readonly outcome: 'not_found' | 'scope_mismatch' | 'expired' | 'revoked' | 'consumed' };

class LeaseQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const prior = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class MemorySourceAccessLeaseStore implements SourceAccessLeaseStore {
  private readonly records = new Map<string, SourceAccessLeaseRecord>();
  private readonly queue = new LeaseQueue();

  async create(record: SourceAccessLeaseRecord): Promise<void> {
    await this.queue.run(() => {
      if (this.records.has(record.grantHash)) throw new Error('source access grant collision');
      this.records.set(record.grantHash, structuredClone(record));
    });
  }

  async claim(
    grantHash: string,
    scope: Pick<SourceAccessLeaseRecord, 'intakeId' | 'principalId' | 'purpose'>,
    now: number,
  ): Promise<SourceAccessLeaseClaimResult> {
    return this.queue.run(() => {
      const record = this.records.get(grantHash);
      if (!record) return { outcome: 'not_found' };
      if (
        record.intakeId !== scope.intakeId ||
        record.principalId !== scope.principalId ||
        record.purpose !== scope.purpose
      )
        return { outcome: 'scope_mismatch' };
      if (record.state === 'revoked') return { outcome: 'revoked' };
      if (record.state === 'consumed') return { outcome: 'consumed' };
      if (record.expiresAt <= now) return { outcome: 'expired' };
      const consumed = { ...record, state: 'consumed' as const };
      this.records.set(grantHash, consumed);
      return { outcome: 'claimed', record: structuredClone(consumed) };
    });
  }

  async revoke(grantHash: string): Promise<void> {
    await this.queue.run(() => {
      const record = this.records.get(grantHash);
      if (record?.state === 'issued') this.records.set(grantHash, { ...record, state: 'revoked' });
    });
  }
}

export interface SourceArtifact {
  readonly contentType: 'text/plain';
  readonly text: string;
}

export interface SourceResolver {
  readonly adapterId: string;
  supports(sourceHandle: string): boolean;
  resolve(
    access: { readonly sourceHandle: string; readonly intakeId: string; readonly sourceGrant: string },
    signal: AbortSignal,
  ): Promise<SourceArtifact>;
}

export class SourceResolverRegistry {
  private readonly resolvers: SourceResolver[] = [];

  register(resolver: SourceResolver): void {
    if (this.resolvers.some((candidate) => candidate.adapterId === resolver.adapterId)) {
      throw new Error(`duplicate source resolver ${resolver.adapterId}`);
    }
    this.resolvers.push(resolver);
  }

  resolve(sourceHandle: string): SourceResolver | null {
    return this.resolvers.find((candidate) => candidate.supports(sourceHandle)) ?? null;
  }
}

export type SourceAccessErrorCode =
  | 'INTAKE_NOT_FOUND'
  | 'RESOLVER_UNAVAILABLE'
  | 'GRANT_NOT_FOUND'
  | 'GRANT_SCOPE_MISMATCH'
  | 'GRANT_EXPIRED'
  | 'GRANT_REVOKED'
  | 'GRANT_CONSUMED';

export class SourceAccessError extends Error {
  constructor(
    readonly code: SourceAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceAccessError';
  }
}

export interface SourceAccessLeaseServiceOptions {
  readonly intakes: MeetingIntakeStore;
  readonly leases: SourceAccessLeaseStore;
  readonly resolvers: SourceResolverRegistry;
  readonly now?: () => number;
  readonly createGrant?: () => string;
  readonly ttlMs?: number;
}

function hashGrant(grant: string): string {
  return createHash('sha256').update(grant).digest('hex');
}

export class SourceAccessLeaseService {
  private readonly now: () => number;
  private readonly createGrant: () => string;
  private readonly ttlMs: number;

  constructor(private readonly options: SourceAccessLeaseServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createGrant = options.createGrant ?? randomUUID;
    this.ttlMs = options.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 300_000) {
      throw new Error('source access lease ttl must be 1..300000ms');
    }
  }

  async issue(input: {
    readonly intakeId: string;
    readonly principalId: string;
    readonly purpose: SourceAccessPurpose;
  }) {
    const intake = await this.options.intakes.get(input.intakeId);
    if (!intake) throw new SourceAccessError('INTAKE_NOT_FOUND', `unknown meeting intake ${input.intakeId}`);
    if (!this.options.resolvers.resolve(intake.source.handle)) {
      throw new SourceAccessError('RESOLVER_UNAVAILABLE', 'no Host source resolver accepts this source handle');
    }
    const grant = this.createGrant();
    const now = this.now();
    const record: SourceAccessLeaseRecord = {
      grantHash: hashGrant(grant),
      intakeId: intake.intakeId,
      sourceHandle: intake.source.handle,
      principalId: input.principalId,
      purpose: input.purpose,
      state: 'issued',
      issuedAt: now,
      expiresAt: now + this.ttlMs,
    };
    await this.options.leases.create(record);
    return { grant, expiresAt: record.expiresAt };
  }

  async resolve(
    input: {
      readonly intakeId: string;
      readonly principalId: string;
      readonly purpose: SourceAccessPurpose;
      readonly grant: string;
    },
    signal: AbortSignal,
  ) {
    const claimed = await this.options.leases.claim(hashGrant(input.grant), input, this.now());
    if (claimed.outcome !== 'claimed') {
      const errorByOutcome = {
        not_found: ['GRANT_NOT_FOUND', 'source access grant is unknown'],
        scope_mismatch: ['GRANT_SCOPE_MISMATCH', 'source access grant scope does not match request'],
        expired: ['GRANT_EXPIRED', 'source access grant expired'],
        revoked: ['GRANT_REVOKED', 'source access grant was revoked'],
        consumed: ['GRANT_CONSUMED', 'source access grant was consumed'],
      } as const;
      const [code, message] = errorByOutcome[claimed.outcome];
      throw new SourceAccessError(code, message);
    }
    const record = claimed.record;
    const resolver = this.options.resolvers.resolve(record.sourceHandle);
    if (!resolver) throw new SourceAccessError('RESOLVER_UNAVAILABLE', 'source resolver is unavailable');
    const artifact = await resolver.resolve(
      {
        sourceHandle: record.sourceHandle,
        intakeId: record.intakeId,
        sourceGrant: input.grant,
      },
      signal,
    );
    return {
      ...artifact,
      provenance: {
        sourceHandle: record.sourceHandle,
        trust: 'untrusted_external' as const,
        instructionPolicy: 'data_only' as const,
      },
    };
  }

  async revoke(grant: string): Promise<void> {
    await this.options.leases.revoke(hashGrant(grant));
  }
}
