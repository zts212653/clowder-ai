import { createHash } from 'node:crypto';
import type { AgentKeyRegistry } from '../../cats/services/agents/agent-key/AgentKeyRegistry.js';
import type { FileMessagingMediaLedger } from '../../messaging/media-ledger.js';
import { auditLegacyDotCredential, type LegacyDotCredentialAuthorityAudit } from './dot-legacy-authority.js';
import type { LegacyDotConnectionState, LegacyDotDispatchRecord } from './dot-legacy-schemas.js';
import type { DotLegacySourceReader, LegacyDotImageMetadata } from './dot-legacy-source-reader.js';
import type { PluginMigrationInvoker } from './plugin-migration-invoker.js';

const DOT_PLUGIN_ID = 'official.chatgpt-dot';

interface LegacyImportBatch {
  readonly version: 1;
  readonly ownerUserId: string;
  readonly sourceInstanceId: string;
  readonly connection?: LegacyDotConnectionState;
  readonly dispatches: readonly LegacyDotDispatchRecord[];
  readonly images: readonly { readonly metadata: LegacyDotImageMetadata; readonly png_base64: string }[];
}

export interface DotLegacyMigrationReceipt {
  readonly version: 1;
  readonly batchDigest: string;
  readonly ownerUserId: string;
  readonly sourceInstanceId: string;
  readonly pluginInstanceId: string;
  readonly connection: number;
  readonly dispatches: number;
  readonly images: number;
  readonly inserted: number;
  readonly alreadyPresent: number;
  readonly sourceDeleted: false;
  readonly importedAt: number;
  readonly duplicate?: true;
}

export interface DotLegacyMigrationAudit {
  readonly version: 1;
  readonly ownerUserId: string;
  readonly sourceInstanceId: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly authority: LegacyDotCredentialAuthorityAudit;
  readonly receipts: readonly DotLegacyMigrationReceipt[];
  readonly media: readonly { readonly metadata: LegacyDotImageMetadata; readonly hmrId: string }[];
  readonly sourceDeleted: false;
  readonly completedAt: number;
}

export interface DotLegacyMigrationAuditPort {
  save(audit: DotLegacyMigrationAudit): Promise<void>;
}

export type DotLegacyMigrationSupersessionReason = 'owner_reconnect' | 'package_state_diverged';

export interface DotLegacyMigrationSupersession {
  readonly version: 1;
  readonly ownerUserId: string;
  readonly sourceInstanceId: string;
  readonly reason: DotLegacyMigrationSupersessionReason;
  readonly supersededAt: number;
}

export interface DotLegacyMigrationProgressPort extends DotLegacyMigrationAuditPort {
  findCompleted(input: {
    readonly ownerUserId: string;
    readonly sourceInstanceId: string;
    readonly pluginInstanceId: string;
    /** Omit only for shared-binding recovery across updates of the same installation. */
    readonly packageDigest?: string;
  }): Promise<DotLegacyMigrationAudit | undefined>;
  hasCompletedSource(input: { readonly ownerUserId: string; readonly sourceInstanceId: string }): Promise<boolean>;
  isSuperseded(input: { readonly ownerUserId: string; readonly sourceInstanceId: string }): Promise<boolean>;
  supersede(record: DotLegacyMigrationSupersession): Promise<void>;
}

export class DotLegacyMigrationCoordinator {
  constructor(
    private readonly options: {
      readonly source: Pick<DotLegacySourceReader, 'connection' | 'dispatches' | 'imageMetadata' | 'imageBytes'>;
      readonly keys: Pick<AgentKeyRegistry, 'get'>;
      readonly invoker: Pick<PluginMigrationInvoker, 'invoke'>;
      readonly media: Pick<FileMessagingMediaLedger, 'register'>;
      readonly audit: DotLegacyMigrationAuditPort;
      readonly externalAccess?: { adopt(instanceId: string, token: string): Promise<void> };
      readonly sharedExtension?: {
        adoptVerifiedLegacy(input: {
          readonly instanceId: string;
          readonly expectedPackageDigest: string;
          readonly ownerUserId: string;
          readonly evidenceRef: string;
          readonly assertCurrent?: () => void;
        }): Promise<unknown>;
      };
      readonly now?: () => number;
    },
  ) {}

  async migrate(input: {
    readonly ownerUserId: string;
    readonly expectedPluginInstanceId: string;
    readonly expectedPackageDigest: string;
  }): Promise<DotLegacyMigrationAudit> {
    const sourceConnection = await this.options.source.connection();
    if (!sourceConnection) throw new Error('dot_legacy_connection_missing');
    if (sourceConnection.ownerUserId !== input.ownerUserId) throw new Error('dot_legacy_owner_mismatch');
    const sourceInstanceId = sourceConnection.pluginInstanceId;
    const checked = await auditLegacyDotCredential(sourceConnection, {
      keys: this.options.keys,
      now: this.options.now,
    });
    const dispatches = await this.options.source.dispatches();
    const images = await this.options.source.imageMetadata();
    assertSourceOwnership(input.ownerUserId, dispatches, images);

    const receipts: DotLegacyMigrationReceipt[] = [];
    receipts.push(
      await this.invokeBatch(input, {
        version: 1,
        ownerUserId: input.ownerUserId,
        sourceInstanceId,
        connection: checked.connection,
        dispatches: [],
        images: [],
      }),
    );
    if (checked.authority.active) {
      await this.options.externalAccess?.adopt(input.expectedPluginInstanceId, sourceConnection.credentialSecret);
    }
    for (let offset = 0; offset < dispatches.length; offset += 100) {
      receipts.push(
        await this.invokeBatch(input, {
          version: 1,
          ownerUserId: input.ownerUserId,
          sourceInstanceId,
          dispatches: dispatches.slice(offset, offset + 100),
          images: [],
        }),
      );
    }

    const media: Array<{ metadata: LegacyDotImageMetadata; hmrId: string }> = [];
    for (const metadata of images) {
      const bytes = await this.options.source.imageBytes(metadata.id);
      assertImageBytes(metadata, bytes);
      receipts.push(
        await this.invokeBatch(input, {
          version: 1,
          ownerUserId: input.ownerUserId,
          sourceInstanceId,
          dispatches: [],
          images: [{ metadata, png_base64: bytes.toString('base64') }],
        }),
      );
      const hmrId = await this.options.media.register(bytes, {
        ownerInstanceId: input.expectedPluginInstanceId,
        mimeType: 'image/png',
        importKey: mediaImportKey(metadata),
      });
      media.push({ metadata, hmrId });
    }

    const audit: DotLegacyMigrationAudit = {
      version: 1,
      ownerUserId: input.ownerUserId,
      sourceInstanceId,
      pluginInstanceId: input.expectedPluginInstanceId,
      packageDigest: input.expectedPackageDigest,
      authority: checked.authority,
      receipts,
      media,
      sourceDeleted: false,
      completedAt: (this.options.now ?? Date.now)(),
    };
    await this.options.audit.save(audit);
    return audit;
  }

  async reconcileShared(
    audit: DotLegacyMigrationAudit,
    current?: { readonly packageDigest: string; readonly assertCurrent: () => void },
  ): Promise<void> {
    if (!audit.authority.active) return;
    await this.options.sharedExtension?.adoptVerifiedLegacy({
      instanceId: audit.pluginInstanceId,
      expectedPackageDigest: current ? current.packageDigest : audit.packageDigest,
      ownerUserId: audit.ownerUserId,
      evidenceRef: `legacy-dot:${audit.sourceInstanceId}:${audit.authority.agentKeyId}`,
      ...(current ? { assertCurrent: current.assertCurrent } : {}),
    });
  }

  private async invokeBatch(
    input: {
      readonly expectedPluginInstanceId: string;
      readonly expectedPackageDigest: string;
    },
    batch: LegacyImportBatch,
  ): Promise<DotLegacyMigrationReceipt> {
    const result = await this.options.invoker.invoke({
      pluginId: DOT_PLUGIN_ID,
      expectedPluginInstanceId: input.expectedPluginInstanceId,
      expectedPackageDigest: input.expectedPackageDigest,
      payload: batch,
    });
    const receipt = migrationReceipt(result);
    const expectedDigest = digest(batch);
    if (
      receipt.batchDigest !== expectedDigest ||
      receipt.ownerUserId !== batch.ownerUserId ||
      receipt.sourceInstanceId !== batch.sourceInstanceId ||
      receipt.pluginInstanceId !== input.expectedPluginInstanceId ||
      receipt.connection !== (batch.connection ? 1 : 0) ||
      receipt.dispatches !== batch.dispatches.length ||
      receipt.images !== batch.images.length ||
      receipt.sourceDeleted !== false
    ) {
      throw new Error('dot_migration_receipt_mismatch');
    }
    return receipt;
  }
}

export function mediaImportKey(metadata: LegacyDotImageMetadata): string {
  return `dot-legacy:${metadata.id}:${metadata.sha256}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertSourceOwnership(
  ownerUserId: string,
  dispatches: readonly LegacyDotDispatchRecord[],
  images: readonly LegacyDotImageMetadata[],
): void {
  if (
    dispatches.some((record) => record.ownerUserId !== ownerUserId) ||
    images.some((metadata) => metadata.ownerUserId !== ownerUserId)
  ) {
    throw new Error('dot_legacy_owner_mismatch');
  }
  const dispatchThreads = new Map(dispatches.map((record) => [record.eventId, record.threadId]));
  if (images.some((metadata) => dispatchThreads.get(metadata.eventId) !== metadata.threadId)) {
    throw new Error('dot_legacy_image_dispatch_mismatch');
  }
}

function assertImageBytes(metadata: LegacyDotImageMetadata, bytes: Buffer): void {
  if (bytes.byteLength !== metadata.byteSize || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) {
    throw new Error('dot_legacy_image_corrupt');
  }
}

function migrationReceipt(value: unknown): DotLegacyMigrationReceipt {
  const receipt = plainRecord(value);
  if (
    receipt?.version !== 1 ||
    typeof receipt.batchDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.batchDigest) ||
    typeof receipt.ownerUserId !== 'string' ||
    typeof receipt.sourceInstanceId !== 'string' ||
    typeof receipt.pluginInstanceId !== 'string' ||
    !nonnegativeInteger(receipt.connection) ||
    !nonnegativeInteger(receipt.dispatches) ||
    !nonnegativeInteger(receipt.images) ||
    !nonnegativeInteger(receipt.inserted) ||
    !nonnegativeInteger(receipt.alreadyPresent) ||
    receipt.sourceDeleted !== false ||
    typeof receipt.importedAt !== 'number' ||
    !Number.isFinite(receipt.importedAt) ||
    (receipt.duplicate !== undefined && receipt.duplicate !== true)
  ) {
    throw new Error('dot_migration_receipt_invalid');
  }
  return structuredClone(receipt) as unknown as DotLegacyMigrationReceipt;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
