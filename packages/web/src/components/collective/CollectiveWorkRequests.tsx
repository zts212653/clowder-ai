'use client';
import type { ParticipationView } from './CollectiveParticipationPanel';

export function CollectiveWorkRequests({
  requests,
  tasks,
  busy,
  mutate,
}: {
  readonly requests: ParticipationView['requests'];
  readonly tasks: ParticipationView['tasks'];
  readonly busy: boolean;
  readonly mutate: (path: string, body: Record<string, unknown>) => Promise<void>;
  readonly control?: string;
}) {
  if (!requests.length) return null;
  return (
    <section className="text-xs" aria-label="收到的请求与私人工作">
      <div className="mt-3 space-y-4">
        {requests
          .slice(-20)
          .reverse()
          .map((request) => (
            <RequestRow
              key={request.event.eventId}
              request={request}
              task={tasks.find((item) => item.sourceRefs.includes(`message:${request.messageId}`))}
              busy={busy}
              mutate={mutate}
            />
          ))}
      </div>
    </section>
  );
}

function RequestRow({
  request,
  task,
  busy,
  mutate,
}: {
  readonly request: ParticipationView['requests'][number];
  readonly task?: ParticipationView['tasks'][number];
  readonly busy: boolean;
  readonly mutate: (path: string, body: Record<string, unknown>) => Promise<void>;
  readonly control?: string;
}) {
  return (
    <article className="space-y-2 border-b border-[var(--console-border-soft)] pb-3">
      <p className="line-clamp-3 text-sm">{request.event.body}</p>
      <p className="text-cafe-muted">
        {requestStatus(request)}
        {task ? ` · ${task.closure === 'open' ? '已承接私人工作' : '工作已收口'}` : ''}
      </p>
      {request.privateThread && (
        <a className="inline-block underline" href={`/thread/${encodeURIComponent(request.privateThread.id)}`}>
          在家里查看
        </a>
      )}
      {task ? (
        <div className="flex flex-wrap gap-2">
          <a className="underline" href={`/thread/${encodeURIComponent(task.threadId)}`}>
            查看工作
          </a>
          {task.closure === 'open' && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void mutate('/work/resume', {
                  taskId: task.id,
                  observedRevision: task.revision,
                  requestId: crypto.randomUUID(),
                })
              }
            >
              继续执行
            </button>
          )}
        </div>
      ) : null}
    </article>
  );
}

export function requestStatus(request: ParticipationView['requests'][number]) {
  if (request.response) return '已回复';
  if (request.failure) return failedRequestStatus(request.failure.code);
  if (request.execution?.stage === 'failed') return '没做成，尚未回复';
  if (request.execution?.stage === 'ended') return '做完了，还没回复';
  if (request.execution?.stage === 'started') return '猫在家里做';
  if (request.execution?.stage === 'queued') return '排着队';
  if (request.attention?.state === 'unclaimed') return '送到了，家里现在没有猫留意这类回应请求';
  if (request.attention?.state === 'wake_queued') return '排着队';
  if (request.privateThread) return '已在家里，正在确认猫的状态';
  return '正在确认去向';
}

function failedRequestStatus(code: string) {
  switch (code) {
    case 'ROUTE_THREAD_UNAVAILABLE':
      return '没送到：家里的入口失效了，修好后会自动补送';
    case 'ECONNREFUSED':
      return '没送到：服务暂时不可用，正在重试';
    case 'ROUTE_CAT_UNAVAILABLE':
      return '没送到：猫暂时不可用，正在重试';
    case 'ROUTE_QUEUE_FULL':
      return '没送到：猫的队列已满，正在重试';
    case 'PARTICIPATION_REVOKED':
      return '没送到：这条请求的授权已失效，不会自动重发';
    default:
      return '没送到：家里的投递遇到问题';
  }
}
