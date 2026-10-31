import { createHmac, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { CompanionBridgeError } from '../companion-owner-client.js';
import {
  type CompanionWorkDestination,
  type CompanionWorkNavigation,
  type CompanionWorkReference,
  readCompanionWorkDestination,
} from './companion-work-navigation.js';
import { type CompanionWorkRead, readCompanionWork } from './companion-work-read.js';
import { observedSourceStatus } from './companion-work-source.js';

export type { CompanionWorkDestination, CompanionWorkNavigation } from './companion-work-navigation.js';

type Options = Parameters<typeof readCompanionWork>[0] & {
  projectLabel?: string;
  /** The existing navigation/display owner supplies actual delivery truth, never a synthetic success. */
  open?(destination: CompanionWorkDestination): Promise<CompanionWorkNavigation>;
};

function pageCoverage(source: { status: 'available' | 'unavailable'; hasMore?: boolean }) {
  if (source.status === 'unavailable') return 'unavailable' as const;
  return source.hasMore ? ('partial' as const) : ('available' as const);
}

/** A card label is an excerpt; source coordinates and canonical owner text stay untouched. */
function cardLabel(value: string, limit: number, unnamed: string): string {
  const label = [...value.replace(/\s+/g, ' ').trim()];
  if (label.length === 0) return unnamed;
  return label.length > limit ? `${label.slice(0, limit - 1).join('')}…` : label.join('');
}

/** Human-only projection and disposable navigation capabilities. Task/Message/Artifact remain the owners. */
export class CompanionWorkOverview {
  private readonly key = randomBytes(32);
  private readonly issued = new Map<string, CompanionWorkReference>();
  private generation = 0;
  constructor(private readonly options: Options) {}

  reset(): void {
    this.generation++;
    this.issued.clear();
  }

  private ref(value: CompanionWorkReference): string {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([this.generation, this.options.ownerUserId, this.options.projectPath, value]))
      .digest('hex');
  }

  private entries(source: CompanionWorkRead) {
    const active = source.work.items.map((row) => {
      const reference: CompanionWorkReference = { kind: 'task', threadId: row.source.threadId, taskId: row.taskId };
      const actor = row.ownerCatId
        ? {
            catId: row.ownerCatId,
            displayName: cardLabel(
              catRegistry.tryGet(row.ownerCatId)?.config.displayName ?? row.ownerCatId,
              256,
              row.ownerCatId,
            ),
          }
        : null;
      const value = {
        entryRef: this.ref(reference),
        title: cardLabel(row.title, 280, '未命名工作'),
        actor,
        activity: row.status === 'doing' ? ('working' as const) : ('waiting' as const),
        taskId: row.taskId,
        homeThreadId: row.source.threadId,
        sourceRef: row.subjectRef,
        updatedAt: row.updatedAt,
      };
      return { value, reference };
    });
    const recentDeliveries = source.deliveries.items.map((row) => {
      const sourceRef = `message:${row.source.threadId}:${row.source.messageId}`;
      const reference: CompanionWorkReference = {
        kind: 'publication',
        threadId: row.source.threadId,
        messageId: row.source.messageId,
        item: row.source.item,
      };
      const value = {
        entryRef: this.ref(reference),
        title: cardLabel(row.title, 280, '未命名交付'),
        taskId: row.taskRef?.slice('task:work:'.length) ?? null,
        homeThreadId: row.source.threadId,
        sourceRef,
        deliveredAt: row.publishedAt,
        artifact: row.version
          ? {
              artifactId: row.version.contentRef,
              version: String(row.version.ownerRevision),
              versionState:
                row.version.ownerRevision === row.version.currentOwnerRevision
                  ? ('current' as const)
                  : ('superseded' as const),
            }
          : null,
      };
      return { value, reference };
    });
    return { active, recentDeliveries };
  }

  private async current(generation: number) {
    const source = await readCompanionWork({ ...this.options, limit: 8 });
    if (this.generation !== generation) throw new CompanionBridgeError('unavailable');
    return { source, entries: this.entries(source) };
  }

  async read() {
    const { source, entries } = await this.current(this.generation);
    const coverage = [
      { source: 'tasks' as const, status: pageCoverage(source.work) },
      { source: 'messages' as const, status: pageCoverage(source.deliveries) },
      {
        source: 'artifacts' as const,
        status: pageCoverage({
          status: source.deliveries.versionCoverage === 'unavailable' ? 'unavailable' : 'available',
          hasMore: source.deliveries.workLinkCoverage === 'partial',
        }),
      },
    ];
    const result = {
      kind: 'work' as const,
      v: 1 as const,
      status: observedSourceStatus(coverage),
      observedAt: source.observedAt,
      scope: {
        kind: 'current-project' as const,
        label: cardLabel(this.options.projectLabel ?? basename(this.options.projectPath), 160, '当前项目'),
      },
      coverage,
      active: entries.active.map((entry) => entry.value),
      recentDeliveries: entries.recentDeliveries.map((entry) => entry.value),
    };
    for (const entry of [...entries.active, ...entries.recentDeliveries])
      this.issued.set(entry.value.entryRef, entry.reference);
    for (const oldest of this.issued.keys()) {
      if (this.issued.size <= 128) break;
      this.issued.delete(oldest);
    }
    return result;
  }

  async open(entryRef: string): Promise<CompanionWorkNavigation> {
    const reference = this.issued.get(entryRef);
    if (!reference || !this.options.open) return 'blocked';
    const generation = this.generation;
    const destination = await readCompanionWorkDestination(this.options, reference);
    if (!destination || this.generation !== generation || !this.issued.has(entryRef)) return 'blocked';
    await this.options.assertCurrent();
    if (this.generation !== generation) return 'blocked';
    return this.options.open(destination);
  }
}
