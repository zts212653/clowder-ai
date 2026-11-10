import { withoutPluginCallContext } from '../carrier/plugin-call-context.js';
import { type OwnerOperationRequest, withOwnerOperationRequest } from '../carrier/plugin-owner-operation-context.js';
import type {
  DotLegacyMigrationAudit,
  DotLegacyMigrationCoordinator,
  DotLegacyMigrationProgressPort,
  DotLegacyMigrationSupersessionReason,
} from './dot-legacy-migration-coordinator.js';
import type { DotLegacySourceReader } from './dot-legacy-source-reader.js';

const DOT_PLUGIN_ID = 'official.chatgpt-dot';

export interface DotLegacyMigrationJourneyInput {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly ownerUserId: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

/**
 * Owner-authenticated bridge from real Host lifecycle/actions to the package's dormant migration.
 * A missing legacy connection is an ordinary new install; an existing source is always imported
 * before the owner can enable or begin pairing the replacement package.
 */
export class DotLegacyMigrationJourney {
  constructor(
    private readonly options: {
      readonly source: Pick<DotLegacySourceReader, 'connection'>;
      readonly coordinator: Pick<DotLegacyMigrationCoordinator, 'migrate'> &
        Partial<Pick<DotLegacyMigrationCoordinator, 'reconcileShared' | 'revalidateLegacyAuthority'>>;
      readonly audit: Pick<
        DotLegacyMigrationProgressPort,
        'findCompleted' | 'hasCompletedSource' | 'isSuperseded' | 'supersede'
      >;
      readonly now?: () => number;
    },
  ) {}

  applies(pluginId: string): boolean {
    return pluginId === DOT_PLUGIN_ID;
  }

  async needsMigration(pluginId: string, ownerUserId: string): Promise<boolean> {
    if (!this.applies(pluginId)) return false;
    const source = await this.options.source.connection();
    if (!source) return false;
    if (source.ownerUserId !== ownerUserId) return true;
    return !(await this.options.audit.isSuperseded({ ownerUserId, sourceInstanceId: source.pluginInstanceId }));
  }

  async ensure(input: DotLegacyMigrationJourneyInput): Promise<DotLegacyMigrationAudit | null> {
    if (!this.applies(input.pluginId)) return null;
    const source = await this.options.source.connection();
    if (!source) return null;
    if (source.ownerUserId === input.ownerUserId) {
      const sourceQuery = { ownerUserId: input.ownerUserId, sourceInstanceId: source.pluginInstanceId };
      if (await this.options.audit.isSuperseded(sourceQuery)) return null;
      const completed = await this.options.audit.findCompleted({
        ...sourceQuery,
        pluginInstanceId: input.pluginInstanceId,
        packageDigest: input.packageDigest,
      });
      if (completed) {
        await this.options.coordinator.revalidateLegacyAuthority?.(completed);
        input.assertCurrent();
        return null;
      }
      // A successful import consumes the legacy source exactly once. A replacement
      // installation may recover package-owned state, but must never resurrect the
      // raw legacy bearer credential into a new installation identity.
      if (await this.options.audit.hasCompletedSource(sourceQuery)) return null;
    }
    const seed: OwnerOperationRequest = {
      pluginId: DOT_PLUGIN_ID,
      operationKey: 'legacy-import',
      actionId: 'import',
      userId: input.ownerUserId,
      requestId: input.requestId,
      signal: input.signal,
      assertCurrent: input.assertCurrent,
    };
    try {
      return await withoutPluginCallContext(() =>
        withOwnerOperationRequest(seed, () =>
          this.options.coordinator.migrate({
            ownerUserId: input.ownerUserId,
            expectedPluginInstanceId: input.pluginInstanceId,
            expectedPackageDigest: input.packageDigest,
            assertCurrent: input.assertCurrent,
          }),
        ),
      );
    } catch (error) {
      const sourceQuery = { ownerUserId: input.ownerUserId, sourceInstanceId: source.pluginInstanceId };
      if (
        error instanceof Error &&
        error.message === 'dot_migration_conflict' &&
        source.ownerUserId === input.ownerUserId &&
        (await this.options.audit.hasCompletedSource(sourceQuery))
      ) {
        await this.options.audit.supersede({
          version: 1,
          ...sourceQuery,
          reason: 'package_state_diverged',
          supersededAt: (this.options.now ?? Date.now)(),
        });
        return null;
      }
      throw error;
    }
  }

  /** The package is deliberately dormant while legacy bytes are imported. Its fixed
   * ports become observable only after enable, so shared /mcp adoption is a separate
   * lifecycle phase backed by the already-durable migration audit. */
  async afterEnable(input: DotLegacyMigrationJourneyInput): Promise<void> {
    if (!this.applies(input.pluginId)) return;
    input.assertCurrent();
    const source = await this.options.source.connection();
    if (!source || source.ownerUserId !== input.ownerUserId) return;
    const sourceQuery = { ownerUserId: input.ownerUserId, sourceInstanceId: source.pluginInstanceId };
    if (await this.options.audit.isSuperseded(sourceQuery)) return;
    // The audit proves this installation consumed the source; its import digest
    // need not equal today's package. Only the shared binding is reconciled here.
    const completed = await this.options.audit.findCompleted({
      ...sourceQuery,
      pluginInstanceId: input.pluginInstanceId,
    });
    if (!completed) return;
    input.assertCurrent();
    if (await this.options.audit.isSuperseded(sourceQuery)) return;
    await this.options.coordinator.reconcileShared?.(completed, {
      packageDigest: input.packageDigest,
      assertCurrent: input.assertCurrent,
    });
    input.assertCurrent();
  }

  async supersede(input: DotLegacyMigrationJourneyInput, reason: DotLegacyMigrationSupersessionReason): Promise<void> {
    if (!this.applies(input.pluginId)) return;
    input.assertCurrent();
    const source = await this.options.source.connection();
    if (!source) return;
    if (source.ownerUserId !== input.ownerUserId) throw new Error('dot_legacy_owner_mismatch');
    await this.options.audit.supersede({
      version: 1,
      ownerUserId: input.ownerUserId,
      sourceInstanceId: source.pluginInstanceId,
      reason,
      supersededAt: (this.options.now ?? Date.now)(),
    });
    input.assertCurrent();
  }
}
