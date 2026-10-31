import type Database from 'better-sqlite3';
import { computeLibraryHealth } from '../../../domains/memory/f188-library-health.js';
import type { Marker } from '../../../domains/memory/interfaces.js';
import { RecallMetricsComputer } from '../../../domains/memory/RecallMetricsComputer.js';
import type { MemoryMetricsProvider, MemoryMetricsResolution } from '../publish-verdict/memory-generator-adapter.js';
import type { MemoryRecallSourceSelector } from '../publish-verdict/types.js';

/**
 * F192 publish_verdict eval:memory wire-up — production MemoryMetricsProvider.
 *
 * Resolves a `memory-recall-snapshot` selector by:
 *   1. Calling RecallMetricsComputer.computeMetrics(...) for `days` + filters
 *   2. Calling computeLibraryHealth(...) with a fresh markers snapshot
 *
 * Both calls execute against the LIVE evidence db (read-only) — no Redis side
 * effects, no isolation worktree concerns. Computer construction is cheap
 * (pure ctor). Provider is constructed once at bootstrap and shared across
 * publish_verdict invocations.
 */
export interface MemoryMetricsProviderDeps {
  evidenceDb: Database.Database;
  markersProvider: { list(): Promise<Marker[]> };
  repoRoot?: string;
  docsRoot?: string;
}

export class MemoryMetricsProviderImpl implements MemoryMetricsProvider {
  private readonly computer: RecallMetricsComputer;

  constructor(private readonly deps: MemoryMetricsProviderDeps) {
    this.computer = new RecallMetricsComputer(deps.evidenceDb);
  }

  async resolve(selector: MemoryRecallSourceSelector): Promise<MemoryMetricsResolution> {
    const recallMetrics = this.computer.computeMetrics({
      days: selector.windowDays,
      catId: selector.catId,
      toolName: selector.toolName,
    });
    const markers = await this.deps.markersProvider.list();
    const libraryHealth = computeLibraryHealth(this.deps.evidenceDb, {
      repoRoot: this.deps.repoRoot,
      docsRoot: this.deps.docsRoot,
      markers,
    });
    return { recallMetrics, libraryHealth };
  }
}
