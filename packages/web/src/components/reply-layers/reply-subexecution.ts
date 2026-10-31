import type { ProviderSubexecutionSemanticEvent as Event } from '@cat-cafe/shared';

export interface ReplySubexecution {
  key: string;
  id: string;
  rootExecutionId: string;
  rootTurnId: string;
  parentExecutionId: string;
  nickname?: string;
  taskId: string;
  status: Event['stage'];
  messages: Event[];
  primary?: Event;
  earlier: Event[];
  durationMs: number | null;
  children: ReplySubexecution[];
}

export interface ReplySubexecutionRecord {
  total: number;
  running: number;
  failed: number;
  interrupted: number;
  completed: number;
  roots: ReplySubexecution[];
}

const terminal = (stage: Event['stage']) => ['completed', 'failed', 'interrupted'].includes(stage);
const scope = (event: Pick<Event, 'rootExecutionId' | 'rootTurnId'>) =>
  JSON.stringify([event.rootExecutionId, event.rootTurnId]);

function projectGroup(events: [Event, ...Event[]]): ReplySubexecution {
  const first = events[0];
  const last = events.at(-1) ?? first;
  // One child can be resumed. New native turn identity, not a late message in
  // an already-terminal turn, establishes a new active run.
  const turnIds = [...new Set(events.flatMap((event) => (event.turnId ? [event.turnId] : [])))];
  const currentTurnId = turnIds.at(-1);
  const current = currentTurnId ? events.filter((event) => event.turnId === currentTurnId) : events;
  const messages = events.filter((event) => event.stage === 'message' && Boolean(event.content));
  const ended = current.filter((event) => terminal(event.stage)).at(-1);
  const status = ended?.stage ?? (current.at(-1) ?? first).stage;
  const preferred = status === 'completed' ? 'final_answer' : 'commentary';
  const currentMessages = messages.filter((event) => !currentTurnId || event.turnId === currentTurnId);
  const primary = currentMessages.filter((event) => event.messagePhase === preferred).at(-1) ?? currentMessages.at(-1);
  const started = events.find((event) => event.stage === 'started');
  const end = ended ?? (events.length > 1 ? last : undefined);
  return {
    key: JSON.stringify([scope(first), first.subexecutionId]),
    id: first.subexecutionId,
    rootExecutionId: first.rootExecutionId,
    rootTurnId: first.rootTurnId,
    parentExecutionId: first.parentExecutionId,
    nickname: events.filter((event) => event.nickname).at(-1)?.nickname,
    taskId: first.agentPath.split('/').filter(Boolean).at(-1) ?? first.subexecutionId,
    status,
    messages,
    primary,
    earlier: messages.filter((event) => event.id !== primary?.id),
    durationMs: started && end && end.occurredAt >= started.occurredAt ? end.occurredAt - started.occurredAt : null,
    children: [],
  };
}

function parentKey(group: ReplySubexecution): string {
  return JSON.stringify([scope(group), group.parentExecutionId]);
}

function parentOf(
  group: ReplySubexecution,
  index: ReadonlyMap<string, ReplySubexecution>,
): ReplySubexecution | undefined {
  const parent = index.get(parentKey(group));
  return parent?.key === group.key ? undefined : parent;
}

function hasCycle(group: ReplySubexecution, index: ReadonlyMap<string, ReplySubexecution>): boolean {
  const visited = new Set<string>([group.key]);
  let parent = parentOf(group, index);
  while (parent) {
    if (visited.has(parent.key)) return true;
    visited.add(parent.key);
    parent = parentOf(parent, index);
  }
  return false;
}

/** Read-only projection of the existing provider events; parent paths/depth never establish authority. */
export function projectReplySubexecutions(events: readonly Event[]): ReplySubexecutionRecord {
  // Stable timestamp sort retains the carrier's append order when native events share a millisecond.
  const sorted = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const seen = new Set<string>();
  const grouped = new Map<string, [Event, ...Event[]]>();
  for (const event of sorted) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const key = JSON.stringify([scope(event), event.subexecutionId]);
    const group = grouped.get(key);
    if (group) group.push(event);
    else grouped.set(key, [event]);
  }
  const groups = [...grouped.values()].map(projectGroup);
  const index = new Map(groups.map((group) => [group.key, group]));
  const roots: ReplySubexecution[] = [];
  for (const group of groups) {
    const parent = hasCycle(group, index) ? undefined : parentOf(group, index);
    if (parent) parent.children.push(group);
    else roots.push(group);
  }
  return {
    total: groups.length,
    running: groups.filter((group) => !terminal(group.status)).length,
    failed: groups.filter((group) => group.status === 'failed').length,
    interrupted: groups.filter((group) => group.status === 'interrupted').length,
    completed: groups.filter((group) => group.status === 'completed').length,
    roots,
  };
}
