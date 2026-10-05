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
          在「{request.privateThread.title || '私人 Thread'}」查看
        </a>
      )}
      {task ? (
        <div className="flex flex-wrap gap-2">
          <a className="underline" href={`/thread/${encodeURIComponent(task.threadId)}`}>
            查看私人工作
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
      ) : (
        <p className="text-cafe-muted">持续工作由猫按当前授权判断；需要你决定的提议会留在原消息旁。</p>
      )}
    </article>
  );
}

export function requestStatus(request: ParticipationView['requests'][number]) {
  if (request.response) return '已有回应；回应已回到共同现场';
  if (request.failure) return failedRequestStatus(request.failure.code, request.event.recipient?.kind === 'agent');
  if (request.execution?.stage === 'failed') return '猫的执行失败，尚未回到频道';
  if (request.execution?.stage === 'ended') return '执行已结束，尚未回到频道';
  if (request.execution?.stage === 'started') return '猫已启动，正在私人 Thread 处理';
  if (request.execution?.stage === 'queued') return '已送到私人 Thread，等待猫接手';
  if (request.attention?.state === 'unclaimed') return '已送达；家里当前没有伙伴值守这类回应请求';
  if (request.attention?.state === 'wake_queued') return '已送达；一位值守伙伴已进入回应队列';
  if (request.privateThread) return '已进入私人 Thread，正在核对猫的状态';
  return request.messageId ? '已进入这台 Café，等待确认去向' : '已送达，等待进入接收队列';
}

function failedRequestStatus(code: string, named: boolean) {
  const kind = named ? '点名' : '回应请求';
  switch (code) {
    case 'ROUTE_THREAD_UNAVAILABLE':
      return named
        ? '点名暂未送达：私人入口已失效，授权仍有效时会在修复后自动补送'
        : '回应请求未送达：私人 Thread 不可用';
    case 'ECONNREFUSED':
      return `${kind}暂未送达：服务暂不可用，正在重试`;
    case 'ROUTE_CAT_UNAVAILABLE':
      return `${kind}暂未送达：猫暂不可用，正在重试`;
    case 'ROUTE_QUEUE_FULL':
      return `${kind}暂未送达：猫的队列已满，正在重试`;
    case 'PARTICIPATION_REVOKED':
      return named ? '点名未送达：这条请求的参与授权已失效，不会自动重发' : '回应请求未送达：这条请求的参与授权不匹配';
    default:
      return `${kind}未送达：家里的投递遇到问题`;
  }
}
