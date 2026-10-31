import type { CompanionTask } from './companion-project-tasks.js';
import type { CompanionArtifactSource } from './companion-work-source.js';

export function workRow(task: CompanionTask) {
  return {
    taskId: task.id,
    subjectRef: `task:work:${task.id}`,
    revision: task.entrustedWork.revision,
    title: task.title,
    ownerCatId: task.ownerCatId,
    status: task.status,
    updatedAt: task.updatedAt,
    ...(task.entrustedWork.progress ? { progress: task.entrustedWork.progress } : {}),
    source: { threadId: task.threadId, taskId: task.id },
  };
}

export function deliveryRows(source: CompanionArtifactSource, works: readonly CompanionTask[]) {
  const contentByPublication = new Map<string, Set<string>>();
  if (source.workLineage === 'resolved') {
    for (const item of source.artifacts) {
      const publicationRef = item.ref ?? item.url;
      if (!publicationRef || !item.work) continue;
      const key = JSON.stringify([item.threadId, publicationRef]);
      const contents = contentByPublication.get(key) ?? new Set<string>();
      contents.add(item.work.contentRef);
      contentByPublication.set(key, contents);
    }
  }
  return (
    source.artifacts
      // A ledger file or PR reference is discovery, not a delivered Message publication.
      .flatMap((row) =>
        row.sourceMessageId !== null && row.fileLedgerRef === undefined
          ? [{ ...row, sourceMessageId: row.sourceMessageId }]
          : [],
      )
      .sort((a, b) => b.createdAt - a.createdAt || a.sourceMessageId.localeCompare(b.sourceMessageId))
      .map((row) => {
        const version = source.workLineage === 'resolved' ? row.work : undefined;
        const taskMatches = works.filter(
          (work) =>
            work.threadId === row.threadId &&
            work.entrustedWork.artifactRefs.some((artifactRef) => {
              if (artifactRef === (row.ref ?? row.url)) return true;
              if (!version) return false;
              if (artifactRef === `content:${version.contentRef}`) return true;
              const contents = contentByPublication.get(JSON.stringify([row.threadId, artifactRef]));
              return contents?.size === 1 && contents.has(version.contentRef);
            }),
        );
        const linkedTask = taskMatches.length === 1 ? taskMatches[0] : undefined;
        return {
          title: row.name,
          type: row.type,
          ownerCatId: row.catId,
          publishedAt: row.createdAt,
          source: {
            threadId: row.threadId,
            messageId: row.sourceMessageId,
            item: row.publicationItem,
          },
          ...(row.url ? { url: row.url } : {}),
          ...(row.ref ? { artifactRef: row.ref } : {}),
          ...(linkedTask ? { taskRef: `task:work:${linkedTask.id}` } : {}),
          ...(version ? { version } : {}),
          // Neither the Task nor Artifact source records the current surface actually opening it.
          display: 'unknown' as const,
        };
      })
  );
}
