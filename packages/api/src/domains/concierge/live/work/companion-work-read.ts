import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import type { GlobalArtifactWorkLineageResolverPort } from '../../../video-studio/content-owner/global-artifact-work-lineage.js';
import { readCompanionProjectArtifacts } from './companion-project-artifacts.js';
import { readCompanionProjectTasks } from './companion-project-tasks.js';
import { currentCompanionPublications } from './companion-work-publications.js';
import { deliveryRows, workRow } from './companion-work-rows.js';
import { observedSourceStatus } from './companion-work-source.js';

type SourceRead<T> = { status: 'available'; value: T } | { status: 'unavailable' };
async function sourceRead<T>(read: () => Promise<T>): Promise<SourceRead<T>> {
  try {
    return { status: 'available', value: await read() };
  } catch {
    return { status: 'unavailable' };
  }
}
function page<T>(source: SourceRead<T[]>, limit: number, complete: boolean) {
  return source.status === 'available'
    ? {
        status: 'available' as const,
        items: source.value.slice(0, limit),
        ...(complete ? { totalCount: source.value.length } : {}),
        hasMore: !complete || source.value.length > limit,
      }
    : { status: 'unavailable' as const, items: [] as T[] };
}
export interface CompanionWorkReadOptions {
  ownerUserId: string;
  projectPath: string;
  threads: Pick<IThreadStore, 'listByProject'>;
  tasks: Pick<ITaskStore, 'get' | 'listByThread'>;
  messages: Pick<IMessageStore, 'getById' | 'getByThread'>;
  artifactLineage?: GlobalArtifactWorkLineageResolverPort;
  /** Host's exact instance/owner/project lease, rechecked before publishing a result. */
  assertCurrent(): Promise<void>;
  limit?: number;
}
export async function readCompanionProjectThreads(options: CompanionWorkReadOptions) {
  return new Set(
    (await options.threads.listByProject(options.ownerUserId, options.projectPath))
      .filter((thread) => !thread.deletedAt && thread.projectPath === options.projectPath)
      .map((thread) => thread.id),
  );
}

async function readProjectSources(options: CompanionWorkReadOptions) {
  const project = await sourceRead(() => readCompanionProjectThreads(options));
  const [tasks, artifacts] = await Promise.all([
    project.status === 'available'
      ? sourceRead(() => readCompanionProjectTasks({ ...options, threadIds: project.value }))
      : { status: 'unavailable' as const },
    project.status === 'available'
      ? sourceRead(() =>
          readCompanionProjectArtifacts({
            ...options,
            threadIds: project.value,
            ...(options.artifactLineage ? { lineage: options.artifactLineage } : {}),
          }),
        )
      : { status: 'unavailable' as const },
  ]);
  const publications =
    artifacts.status === 'available'
      ? await sourceRead(() =>
          currentCompanionPublications(options.messages, options.ownerUserId, artifacts.value.artifacts),
        )
      : { status: 'unavailable' as const };
  const currentProject = await sourceRead(() => readCompanionProjectThreads(options));
  return { tasks, artifacts, publications, currentProject };
}

/** Human-only current-project observation. No global library scan, mirrored ledger or cat-viewer override. */
export async function readCompanionWork(options: CompanionWorkReadOptions) {
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid companion work limit');
  await options.assertCurrent();
  const startedAt = Date.now();
  const { tasks, artifacts, publications, currentProject } = await readProjectSources(options);
  const active =
    tasks.status === 'available' && currentProject.status === 'available'
      ? {
          status: 'available' as const,
          value: tasks.value.items
            .filter(
              (task) =>
                currentProject.value.has(task.threadId) &&
                task.status !== 'done' &&
                task.entrustedWork.closure.state === 'open',
            )
            .map(workRow),
        }
      : { status: 'unavailable' as const };
  const work = page(active, limit, tasks.status === 'available' && tasks.value.complete);
  const observedDeliveries =
    artifacts.status === 'available' && publications.status === 'available' && currentProject.status === 'available'
      ? {
          status: 'available' as const,
          value: deliveryRows(
            {
              ...artifacts.value,
              artifacts: publications.value.filter((row) => currentProject.value.has(row.threadId)),
            },
            tasks.status === 'available' ? tasks.value.items : [],
          ),
        }
      : { status: 'unavailable' as const };
  const deliveries = page(observedDeliveries, limit, artifacts.status === 'available' && artifacts.value.complete);
  await options.assertCurrent();
  return {
    status: observedSourceStatus([work, deliveries]),
    observedAt: Date.now(),
    readWindow: { startedAt, consistency: 'independent_source_reads' as const },
    work: { ...work, coverage: 'current_project_active_entrusted_work' as const },
    deliveries: {
      ...deliveries,
      coverage: 'current_project_published_message_artifacts' as const,
      workLinkCoverage:
        tasks.status === 'available' && tasks.value.complete ? ('available' as const) : ('partial' as const),
      versionCoverage: artifacts.status === 'available' ? artifacts.value.workLineage : ('unavailable' as const),
    },
  };
}
export type CompanionWorkRead = Awaited<ReturnType<typeof readCompanionWork>>;
