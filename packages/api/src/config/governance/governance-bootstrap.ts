/** F302: optional, preview-first project governance materialization. */

import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { BootstrapAction, BootstrapReport, GovernanceSelection } from '@cat-cafe/shared';
import { isProtectedGovernanceCleanupTarget, planGovernanceCleanup } from './governance-bootstrap-cleanup.js';
import {
  createGovernanceReport,
  governancePathExists,
  hasUnsafeGovernanceAncestor,
  normalizeGovernanceSelection,
  planGovernanceInstall,
  readLegacyGovernanceReport,
  safeGovernanceTargetPath,
} from './governance-bootstrap-plan.js';
import { GOVERNANCE_PACK_VERSION } from './governance-pack.js';
import { GovernanceRegistry } from './governance-registry.js';

const IS_WIN32 = process.platform === 'win32';

interface ResolvedWrite {
  readonly action: BootstrapAction;
  readonly target: string;
}

export { normalizeGovernanceSelection } from './governance-bootstrap-plan.js';

export interface BootstrapOptions {
  readonly dryRun: boolean;
  readonly selection?: GovernanceSelection;
  readonly expectedPreviewChecksum?: string;
}

export interface CleanupOptions {
  readonly dryRun: boolean;
  readonly expectedPreviewChecksum?: string;
}

export class GovernancePreviewConflictError extends Error {
  constructor(readonly freshPreview: BootstrapReport) {
    super('Governance preview changed; review the fresh preview before confirming');
    this.name = 'GovernancePreviewConflictError';
  }
}

export class GovernanceBootstrapService {
  private readonly registry: GovernanceRegistry;

  constructor(private readonly catCafeRoot: string) {
    this.registry = new GovernanceRegistry(catCafeRoot);
  }

  getRegistry(): GovernanceRegistry {
    return this.registry;
  }

  private async installPreview(targetProject: string, selection: GovernanceSelection): Promise<BootstrapReport> {
    return createGovernanceReport(
      targetProject,
      selection,
      await planGovernanceInstall(this.catCafeRoot, targetProject, selection),
      true,
    );
  }

  private async resolveWrites(
    targetProject: string,
    selection: GovernanceSelection,
    preview: BootstrapReport,
  ): Promise<ResolvedWrite[]> {
    const writes = preview.actions.filter((action) => action.action === 'created' || action.action === 'symlinked');
    const resolved: ResolvedWrite[] = [];
    for (const action of writes) {
      const target = safeGovernanceTargetPath(targetProject, action.file);
      if (
        !target ||
        (await governancePathExists(target)) ||
        (await hasUnsafeGovernanceAncestor(targetProject, target))
      ) {
        throw new GovernancePreviewConflictError(await this.installPreview(targetProject, selection));
      }
      resolved.push({ action, target });
    }
    return resolved;
  }

  private async applyWrites(writes: readonly ResolvedWrite[]): Promise<void> {
    const created: string[] = [];
    try {
      for (const { action, target } of writes) {
        await mkdir(dirname(target), { recursive: true });
        if (action.action === 'created') {
          await writeFile(target, action.content ?? '', { encoding: 'utf8', flag: 'wx' });
        } else if (action.symlinkTarget) {
          const linkTarget = IS_WIN32 ? action.symlinkTarget : relative(dirname(target), action.symlinkTarget);
          await symlink(linkTarget, target, IS_WIN32 ? 'junction' : undefined);
        }
        created.push(target);
      }
    } catch (error) {
      const rollback = await Promise.allSettled(created.reverse().map((target) => unlink(target)));
      const rollbackFailures = rollback.filter((result) => result.status === 'rejected');
      if (rollbackFailures.length > 0) {
        throw new AggregateError([error, ...rollbackFailures], 'Governance write failed and rollback was incomplete');
      }
      throw error;
    }
  }

  async bootstrap(targetProject: string, opts: BootstrapOptions): Promise<BootstrapReport> {
    const selection = normalizeGovernanceSelection(opts.selection);
    const preview = await this.installPreview(targetProject, selection);
    if (opts.dryRun) return preview;
    this.requireConfirmedPreview(opts.expectedPreviewChecksum, preview);

    const writes = await this.resolveWrites(targetProject, selection, preview);
    await this.applyWrites(writes);

    const report = { ...preview, timestamp: Date.now(), dryRun: false } satisfies BootstrapReport;
    if (writes.length > 0) {
      await this.registry.recordBootstrap(
        targetProject,
        {
          packVersion: GOVERNANCE_PACK_VERSION,
          checksum: report.previewChecksum,
          syncedAt: Date.now(),
          confirmedByUser: true,
        },
        report,
      );
    }
    return report;
  }

  async cleanup(targetProject: string, opts: CleanupOptions): Promise<BootstrapReport> {
    const registryEntry = await this.registry.get(targetProject);
    const legacyReport = registryEntry?.lastBootstrapReport
      ? undefined
      : await readLegacyGovernanceReport(targetProject);
    const sourceReport = registryEntry?.lastBootstrapReport ?? legacyReport;
    const selection = normalizeGovernanceSelection(sourceReport?.selection);
    const preview = createGovernanceReport(
      targetProject,
      selection,
      await planGovernanceCleanup(targetProject, sourceReport, Boolean(legacyReport)),
      true,
    );
    if (opts.dryRun) return preview;
    this.requireConfirmedPreview(opts.expectedPreviewChecksum, preview);

    const fresh = createGovernanceReport(
      targetProject,
      selection,
      await planGovernanceCleanup(targetProject, sourceReport, Boolean(legacyReport)),
      true,
    );
    if (fresh.previewChecksum !== preview.previewChecksum) throw new GovernancePreviewConflictError(fresh);
    for (const action of fresh.actions) {
      if (action.action !== 'deleted') continue;
      const target = safeGovernanceTargetPath(targetProject, action.file);
      if (
        !target ||
        isProtectedGovernanceCleanupTarget(targetProject, target) ||
        (await hasUnsafeGovernanceAncestor(targetProject, target))
      ) {
        const conflictPreview = createGovernanceReport(
          targetProject,
          selection,
          await planGovernanceCleanup(targetProject, sourceReport, Boolean(legacyReport)),
          true,
        );
        throw new GovernancePreviewConflictError(conflictPreview);
      }
      await unlink(target);
    }
    const report = { ...fresh, timestamp: Date.now(), dryRun: false } satisfies BootstrapReport;
    if (sourceReport) {
      await this.registry.recordCleanup(
        targetProject,
        {
          packVersion: sourceReport.packVersion,
          checksum: report.previewChecksum,
          syncedAt: Date.now(),
          confirmedByUser: true,
        },
        report,
      );
    }
    return report;
  }

  private requireConfirmedPreview(expected: string | undefined, preview: BootstrapReport): void {
    if (!expected || expected !== preview.previewChecksum) throw new GovernancePreviewConflictError(preview);
  }
}
