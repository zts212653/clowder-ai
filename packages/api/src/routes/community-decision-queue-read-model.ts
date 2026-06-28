import type { ICommunityIssueStore } from '../domains/cats/services/stores/ports/CommunityIssueStore.js';
import type { ICommunityPrStore } from '../domains/cats/services/stores/ports/CommunityPrStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { ICommunityObjectStore } from '../domains/community/CommunityObjectStore.js';
import { computeClosureChecklist } from '../domains/community/community-closure-checklist.js';
import type { CommunityBoardIssueLike, CommunityBoardPrLike } from '../domains/community/community-decision-queue.js';
import { derivePrGroup } from '../domains/community/derivePrGroup.js';

export async function buildQueueIssues(
  repo: string,
  issues: Awaited<ReturnType<ICommunityIssueStore['listByRepo']>>,
  objectStore: ICommunityObjectStore | undefined,
  warnings: string[],
): Promise<CommunityBoardIssueLike[]> {
  const queueIssues: CommunityBoardIssueLike[] = await Promise.all(
    issues.map(async (issue) => {
      const subjectKey = `issue:${issue.repo}#${issue.issueNumber}`;
      if (!objectStore) return issue;
      try {
        const proj = await objectStore.get(subjectKey);
        if (!proj) return issue;
        return {
          ...issue,
          assignedThreadId: issue.assignedThreadId ?? proj.ownerThreadId,
          updatedAt: maxUpdatedAt(issue.updatedAt, proj.updatedAt),
          projectionState: proj.state,
          nextOwner: proj.nextOwner,
          closureWaiver: proj.closureWaiver,
          closureChecklist: computeClosureChecklist(proj),
        };
      } catch {
        warnings.push(`Failed to enrich ${subjectKey} from CommunityObjectStore`);
        return issue;
      }
    }),
  );

  if (!objectStore) return queueIssues;
  try {
    const legacyIssueNumbers = new Set(issues.map((issue) => issue.issueNumber));
    const issuePrefix = `issue:${repo}#`;
    const projectionOnlyKeys = (await objectStore.listSubjectKeys()).filter(
      (subjectKey) =>
        subjectKey.startsWith(issuePrefix) && !legacyIssueNumbers.has(Number(subjectKey.slice(issuePrefix.length))),
    );
    for (const subjectKey of projectionOnlyKeys) {
      try {
        const proj = await objectStore.get(subjectKey);
        if (!proj) continue;
        queueIssues.push({
          id: subjectKey,
          repo,
          issueNumber: proj.number,
          title: '',
          state: proj.state === 'closed' || proj.state === 'fixed' ? 'closed' : 'unreplied',
          assignedThreadId: proj.ownerThreadId,
          assignedCatId: proj.ownerRole,
          directionCard: null,
          updatedAt: proj.updatedAt,
          projectionState: proj.state,
          nextOwner: proj.nextOwner,
          closureChecklist: computeClosureChecklist(proj),
          closureActionsAvailable: false,
        });
      } catch {
        warnings.push(`Failed to load projection-only issue ${subjectKey}`);
      }
    }
  } catch {
    warnings.push('Failed to list projection-only issues from CommunityObjectStore');
  }
  return queueIssues;
}

export async function buildQueuePrItems(
  repo: string,
  taskStore: ITaskStore,
  communityPrStore: ICommunityPrStore | undefined,
  objectStore: ICommunityObjectStore | undefined,
  warnings: string[],
): Promise<CommunityBoardPrLike[]> {
  const subjectPrefix = `pr:${repo}#`;
  const allTasks = await taskStore.listByKind('pr_tracking');
  const trackedPrItems = allTasks
    .filter((task) => task.subjectKey?.startsWith(subjectPrefix))
    .map((task) => {
      const prNumberMatch = task.subjectKey?.match(/#(\d+)$/);
      const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : null;
      return {
        taskId: task.id,
        threadId: task.threadId,
        prNumber,
        ownerCatId: task.ownerCatId,
        title: task.title,
        status: task.status,
        group: derivePrGroup(task.automationState, task.status),
        automationState: task.automationState,
        updatedAt: task.updatedAt,
      };
    });
  const trackedPrNumbers = new Set(trackedPrItems.map((item) => item.prNumber).filter((n) => n != null));
  const communityPrs = communityPrStore ? await communityPrStore.listByRepo(repo) : [];
  const communityPrItems = communityPrs
    .filter((pr) => !trackedPrNumbers.has(pr.prNumber))
    .map((pr) => ({
      taskId: pr.id,
      prNumber: pr.prNumber,
      title: pr.title,
      author: pr.author,
      state: pr.state,
      status: pr.state,
      replyState: pr.replyState,
      group: pr.state !== 'open' ? pr.state : pr.replyState,
      headSha: pr.headSha,
      draft: pr.draft,
      updatedAt: pr.updatedAt,
    }));
  const prItems: CommunityBoardPrLike[] = [...trackedPrItems, ...communityPrItems];
  if (!objectStore) return prItems;

  for (let i = 0; i < prItems.length; i += 1) {
    const item = prItems[i];
    if (item?.prNumber == null) continue;
    const subjectKey = `pr:${repo}#${item.prNumber}`;
    try {
      const proj = await objectStore.get(subjectKey);
      if (!proj) continue;
      prItems[i] = {
        ...item,
        updatedAt: maxUpdatedAt(item.updatedAt, proj.updatedAt),
        threadId: item.threadId ?? proj.ownerThreadId,
        projectionState: proj.state,
        nextOwner: proj.nextOwner,
        closureChecklist: computeClosureChecklist(proj),
      };
    } catch {
      warnings.push(`Failed to enrich ${subjectKey} from CommunityObjectStore`);
    }
  }
  await addProjectionOnlyPrItems(repo, prItems, objectStore, warnings);
  return prItems;
}

async function addProjectionOnlyPrItems(
  repo: string,
  prItems: CommunityBoardPrLike[],
  objectStore: ICommunityObjectStore,
  warnings: string[],
): Promise<void> {
  try {
    const knownPrNumbers = new Set(prItems.map((item) => item.prNumber).filter((n) => n != null));
    const prPrefix = `pr:${repo}#`;
    const projectionOnlyPrKeys = (await objectStore.listSubjectKeys()).filter(
      (subjectKey) => subjectKey.startsWith(prPrefix) && !knownPrNumbers.has(Number(subjectKey.slice(prPrefix.length))),
    );
    for (const subjectKey of projectionOnlyPrKeys) {
      try {
        const proj = await objectStore.get(subjectKey);
        if (!proj) continue;
        const isFixedProj = proj.state === 'fixed';
        const isClosedProj = proj.state === 'closed';
        const projState = isFixedProj ? 'merged' : isClosedProj ? 'closed' : 'open';
        prItems.push({
          taskId: subjectKey,
          threadId: proj.ownerThreadId,
          prNumber: proj.number,
          title: '',
          state: projState,
          status: projState,
          group: isFixedProj ? 'merged' : isClosedProj ? 'closed' : 'unreplied',
          updatedAt: proj.updatedAt,
          projectionState: proj.state,
          nextOwner: proj.nextOwner,
          closureChecklist: computeClosureChecklist(proj),
        });
      } catch {
        warnings.push(`Failed to load projection-only PR ${subjectKey}`);
      }
    }
  } catch {
    warnings.push('Failed to list projection-only PRs from CommunityObjectStore');
  }
}

function maxUpdatedAt(left: number, right: number): number {
  return Math.max(left, right);
}
