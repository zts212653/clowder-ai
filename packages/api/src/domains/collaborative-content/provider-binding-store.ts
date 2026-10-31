import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface OfficeProviderBindingV1 {
  readonly contentRef: string;
  readonly providerId: string;
  readonly installationInstanceId: string;
  readonly providerVersion: string;
  readonly bindingRevision: number;
}

export interface BindOfficeProviderInputV1 extends Omit<OfficeProviderBindingV1, 'bindingRevision'> {
  readonly expectedBindingRevision: number;
}

interface BindingSnapshotV1 {
  readonly schemaVersion: 1;
  readonly bindings: readonly OfficeProviderBindingV1[];
}

export class OfficeProviderBindingConflictError extends Error {
  readonly code = 'BINDING_REVISION_CONFLICT';

  constructor(
    readonly contentRef: string,
    readonly expectedBindingRevision: number,
    readonly actualBindingRevision: number,
  ) {
    super(
      `Office provider binding conflict for ${contentRef}: expected ${expectedBindingRevision}, actual ${actualBindingRevision}`,
    );
    this.name = 'OfficeProviderBindingConflictError';
  }
}

export interface OfficeProviderBindingStoreOptions {
  readonly dataDir: string;
}

export class OfficeProviderBindingStore {
  private readonly snapshotPath: string;
  private lock: Promise<void> = Promise.resolve();

  constructor(options: OfficeProviderBindingStoreOptions) {
    this.snapshotPath = join(options.dataDir, 'projects', 'collaborative-content-v1', 'provider-bindings.json');
  }

  async get(contentRef: string): Promise<OfficeProviderBindingV1 | undefined> {
    validateToken(contentRef, 'contentRef');
    const snapshot = await this.readSnapshot();
    const binding = snapshot.bindings.find((candidate) => candidate.contentRef === contentRef);
    return binding ? { ...binding } : undefined;
  }

  async bind(input: BindOfficeProviderInputV1): Promise<OfficeProviderBindingV1> {
    validateToken(input.contentRef, 'contentRef');
    validateToken(input.providerId, 'providerId');
    validateToken(input.installationInstanceId, 'installationInstanceId');
    validateToken(input.providerVersion, 'providerVersion');
    if (!Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision < 0) {
      throw new TypeError('expectedBindingRevision must be a non-negative integer');
    }

    return this.withLock(async () => {
      const snapshot = await this.readSnapshot();
      const current = snapshot.bindings.find((binding) => binding.contentRef === input.contentRef);
      const actualBindingRevision = current?.bindingRevision ?? 0;
      if (input.expectedBindingRevision !== actualBindingRevision) {
        throw new OfficeProviderBindingConflictError(
          input.contentRef,
          input.expectedBindingRevision,
          actualBindingRevision,
        );
      }
      const next: OfficeProviderBindingV1 = {
        contentRef: input.contentRef,
        providerId: input.providerId,
        installationInstanceId: input.installationInstanceId,
        providerVersion: input.providerVersion,
        bindingRevision: actualBindingRevision + 1,
      };
      await this.writeSnapshot({
        schemaVersion: 1,
        bindings: [...snapshot.bindings.filter((binding) => binding.contentRef !== input.contentRef), next].sort(
          (left, right) => left.contentRef.localeCompare(right.contentRef),
        ),
      });
      return next;
    });
  }

  /** Serialize provider replacement with an already-authorized owner effect. */
  withCurrent<T>(expected: OfficeProviderBindingV1, work: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const current = await this.get(expected.contentRef);
      if (
        !current ||
        current.bindingRevision !== expected.bindingRevision ||
        current.providerId !== expected.providerId ||
        current.installationInstanceId !== expected.installationInstanceId ||
        current.providerVersion !== expected.providerVersion
      ) {
        throw new OfficeProviderBindingConflictError(
          expected.contentRef,
          expected.bindingRevision,
          current?.bindingRevision ?? 0,
        );
      }
      return work();
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readSnapshot(): Promise<BindingSnapshotV1> {
    try {
      const raw = await readFile(this.snapshotPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.bindings)) {
        throw new Error('Invalid Office provider binding snapshot');
      }
      const bindings = parsed.bindings.map(parseBinding);
      if (new Set(bindings.map((binding) => binding.contentRef)).size !== bindings.length) {
        throw new Error('Duplicate contentRef in Office provider binding snapshot');
      }
      return { schemaVersion: 1, bindings };
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return { schemaVersion: 1, bindings: [] };
      throw error;
    }
  }

  private async writeSnapshot(snapshot: BindingSnapshotV1): Promise<void> {
    const directory = dirname(this.snapshotPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.provider-bindings-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.snapshotPath);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function parseBinding(value: unknown): OfficeProviderBindingV1 {
  if (!isRecord(value)) throw new Error('Invalid Office provider binding');
  const contentRef = requiredToken(value.contentRef, 'contentRef');
  const providerId = requiredToken(value.providerId, 'providerId');
  const installationInstanceId = requiredToken(value.installationInstanceId, 'installationInstanceId');
  const providerVersion = requiredToken(value.providerVersion, 'providerVersion');
  if (!Number.isSafeInteger(value.bindingRevision) || Number(value.bindingRevision) < 1) {
    throw new Error('Invalid Office provider binding revision');
  }
  return {
    contentRef,
    providerId,
    installationInstanceId,
    providerVersion,
    bindingRevision: Number(value.bindingRevision),
  };
}

function requiredToken(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid Office provider binding ${field}`);
  validateToken(value, field);
  return value;
}

function validateToken(value: string, field: string): void {
  if (value.length === 0 || value.length > 512 || value.trim() !== value || value.includes('\0')) {
    throw new TypeError(`${field} is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
