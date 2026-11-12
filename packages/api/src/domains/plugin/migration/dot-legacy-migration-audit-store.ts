import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  DotLegacyMigrationAudit,
  DotLegacyMigrationProgressPort,
  DotLegacyMigrationSupersession,
} from './dot-legacy-migration-coordinator.js';
import type { LegacyDotImageMetadata } from './dot-legacy-source-reader.js';

interface AuditFile {
  readonly version: 1;
  readonly records: Readonly<Record<string, DotLegacyMigrationAudit>>;
  readonly supersessions: Readonly<Record<string, DotLegacyMigrationSupersession>>;
}

export class FileDotLegacyMigrationAuditStore implements DotLegacyMigrationProgressPort {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  save(audit: DotLegacyMigrationAudit): Promise<void> {
    return this.update((current) => ({
      ...current,
      records: { ...current.records, [auditKey(audit)]: audit },
    }));
  }

  supersede(record: DotLegacyMigrationSupersession): Promise<void> {
    return this.update((current) => {
      const key = supersessionKey(record);
      return current.supersessions[key]
        ? current
        : { ...current, supersessions: { ...current.supersessions, [key]: record } };
    });
  }

  private update(mutate: (current: AuditFile) => AuditFile): Promise<void> {
    const work = this.tail.then(async () => {
      const next = mutate(await this.read());
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.tail = work.catch(() => undefined);
    return work;
  }

  async read(): Promise<AuditFile> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!plainRecord(value) || value.version !== 1 || !plainRecord(value.records)) {
        throw new Error('dot_migration_audit_corrupt');
      }
      if (value.supersessions !== undefined && !plainRecord(value.supersessions)) {
        throw new Error('dot_migration_audit_corrupt');
      }
      return {
        version: 1,
        records: value.records as unknown as Readonly<Record<string, DotLegacyMigrationAudit>>,
        supersessions: (value.supersessions ?? {}) as Readonly<Record<string, DotLegacyMigrationSupersession>>,
      };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, records: {}, supersessions: {} };
      }
      throw error;
    }
  }

  async findCompleted(input: {
    readonly ownerUserId: string;
    readonly sourceInstanceId: string;
    readonly pluginInstanceId: string;
    readonly packageDigest?: string;
  }): Promise<DotLegacyMigrationAudit | undefined> {
    return Object.values((await this.read()).records)
      .filter(
        (record) =>
          record.ownerUserId === input.ownerUserId &&
          record.sourceInstanceId === input.sourceInstanceId &&
          record.pluginInstanceId === input.pluginInstanceId &&
          (input.packageDigest === undefined || record.packageDigest === input.packageDigest),
      )
      .sort((left, right) => right.completedAt - left.completedAt)[0];
  }

  async hasCompletedSource(input: {
    readonly ownerUserId: string;
    readonly sourceInstanceId: string;
  }): Promise<boolean> {
    return Object.values((await this.read()).records).some(
      (record) => record.ownerUserId === input.ownerUserId && record.sourceInstanceId === input.sourceInstanceId,
    );
  }

  async isSuperseded(input: { readonly ownerUserId: string; readonly sourceInstanceId: string }): Promise<boolean> {
    return (await this.read()).supersessions[supersessionKey(input)] !== undefined;
  }

  async findImage(
    imageId: string,
  ): Promise<{ readonly metadata: LegacyDotImageMetadata; readonly hmrId: string } | undefined> {
    const matches = Object.values((await this.read()).records)
      .sort((left, right) => right.completedAt - left.completedAt)
      .flatMap((audit) => audit.media)
      .filter((media) => media.metadata.id === imageId);
    return matches[0];
  }
}

function auditKey(audit: {
  readonly ownerUserId: string;
  readonly sourceInstanceId: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([audit.ownerUserId, audit.sourceInstanceId, audit.pluginInstanceId, audit.packageDigest]))
    .digest('hex');
}

function supersessionKey(input: { readonly ownerUserId: string; readonly sourceInstanceId: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([input.ownerUserId, input.sourceInstanceId]))
    .digest('hex');
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
