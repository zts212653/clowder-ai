'use client';

import type { ProviderSubexecutionSemanticEvent } from '@cat-cafe/shared';

interface SubexecutionGroup {
  id: string;
  agentPath: string;
  nickname?: string;
  depth: number;
  events: ProviderSubexecutionSemanticEvent[];
  status: ProviderSubexecutionSemanticEvent['stage'];
}

const TERMINAL_STAGES = new Set<ProviderSubexecutionSemanticEvent['stage']>(['completed', 'failed', 'interrupted']);
const MAX_VISIBLE_CHILD_MESSAGES = 8;

function childDisplayName(group: Pick<SubexecutionGroup, 'agentPath' | 'nickname'>): string {
  return group.nickname ? group.nickname : group.agentPath;
}

export function subexecutionStatusLabel(stage: ProviderSubexecutionSemanticEvent['stage']): string {
  if (stage === 'completed') return '已完成';
  if (stage === 'failed') return '失败';
  if (stage === 'interrupted') return '已中断';
  return '进行中';
}

export function subexecutionMessageLabel(phase: ProviderSubexecutionSemanticEvent['messagePhase']): string {
  if (phase === 'final_answer') return '子 agent 最终回报';
  if (phase === 'commentary') return '子 agent 过程';
  return '子 agent 消息';
}

export function groupSubexecutionEvents(events: readonly ProviderSubexecutionSemanticEvent[]): SubexecutionGroup[] {
  const groups = new Map<string, SubexecutionGroup>();
  const seenEventIds = new Set<string>();
  for (const event of [...events].sort((left, right) => left.occurredAt - right.occurredAt)) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    const existing = groups.get(event.subexecutionId);
    if (!existing) {
      groups.set(event.subexecutionId, {
        id: event.subexecutionId,
        agentPath: event.agentPath,
        ...(event.nickname ? { nickname: event.nickname } : {}),
        depth: event.depth,
        events: [event],
        status: event.stage,
      });
      continue;
    }
    existing.events.push(event);
    existing.agentPath = event.agentPath;
    if (event.nickname) existing.nickname = event.nickname;
    existing.depth = event.depth;
    if (TERMINAL_STAGES.has(event.stage)) existing.status = event.stage;
    else if (!TERMINAL_STAGES.has(existing.status)) existing.status = event.stage;
  }
  return [...groups.values()];
}

function statusTone(stage: ProviderSubexecutionSemanticEvent['stage']): string {
  if (stage === 'failed') return 'border-conn-red-ring bg-conn-red-bg text-conn-red-text';
  if (stage === 'interrupted') return 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text';
  if (stage === 'completed') return 'border-conn-green-ring bg-conn-green-bg text-conn-green-text';
  return 'border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text';
}

export function SubexecutionIdentity({
  agentPath,
  nickname,
  depth,
}: Pick<ProviderSubexecutionSemanticEvent, 'agentPath' | 'nickname' | 'depth'>) {
  const displayName = childDisplayName({ agentPath, nickname });
  return (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="rounded-md border border-conn-purple-ring bg-conn-purple-bg px-1.5 py-0.5 text-micro font-semibold text-conn-purple-text">
          子 agent
        </span>
        <strong className="truncate text-xs text-cafe-secondary">{displayName}</strong>
        <span className="text-micro text-cafe-muted">depth {depth}</span>
      </span>
      <code className="mt-1 block truncate text-micro text-cafe-muted" title={agentPath}>
        {agentPath}
      </code>
    </span>
  );
}

export function SubexecutionActivity({ events }: { events: readonly ProviderSubexecutionSemanticEvent[] }) {
  const groups = groupSubexecutionEvents(events);
  if (groups.length === 0) return null;
  return (
    <section data-testid="subexecution-activity" aria-label="子 agent 工作记录" className="mt-3 space-y-2">
      <div className="border-t border-cafe-subtle pt-2 text-micro font-semibold text-cafe-muted">
        子 agent 工作记录 · {groups.length}
      </div>
      {groups.map((group) => {
        const messages = group.events.filter(
          (event): event is ProviderSubexecutionSemanticEvent & { stage: 'message'; content: string } =>
            event.stage === 'message' && typeof event.content === 'string',
        );
        const visibleMessages = messages.slice(-MAX_VISIBLE_CHILD_MESSAGES);
        const hiddenMessageCount = messages.length - visibleMessages.length;
        return (
          <details
            key={group.id}
            data-subexecution-id={group.id}
            data-subexecution-status={group.status}
            className="rounded-xl border border-cafe-subtle bg-cafe-surface-sunken/60 px-3 py-2"
            open={!TERMINAL_STAGES.has(group.status)}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 marker:hidden">
              <SubexecutionIdentity agentPath={group.agentPath} nickname={group.nickname} depth={group.depth} />
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-micro font-semibold ${statusTone(group.status)}`}
              >
                {subexecutionStatusLabel(group.status)}
              </span>
              <span aria-hidden="true" className="shrink-0 text-sm text-cafe-muted">
                ›
              </span>
            </summary>
            <div className="mt-2 max-h-72 space-y-2 overflow-y-auto border-t border-cafe-subtle pt-2">
              {hiddenMessageCount > 0 && (
                <div className="text-micro text-cafe-muted">已收起 {hiddenMessageCount} 条较早的子 agent 消息</div>
              )}
              {visibleMessages.length > 0 ? (
                visibleMessages.map((event) => (
                  <div
                    key={event.id}
                    data-subexecution-message-phase={event.messagePhase === undefined ? 'unknown' : event.messagePhase}
                    className="rounded-lg border border-cafe-subtle bg-cafe-surface px-2.5 py-2"
                  >
                    <div className="text-micro font-semibold text-conn-purple-text">
                      {subexecutionMessageLabel(event.messagePhase)}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-cafe-secondary">
                      {event.content}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-xs text-cafe-muted">尚无子 agent 正文。</div>
              )}
            </div>
          </details>
        );
      })}
    </section>
  );
}
