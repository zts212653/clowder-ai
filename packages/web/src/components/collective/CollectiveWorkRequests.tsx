'use client';
import { useState } from 'react';
import type { ParticipationView } from './CollectiveParticipationPanel';

export function CollectiveWorkRequests({
  requests,
  tasks,
  busy,
  mutate,
  control,
}: {
  readonly requests: ParticipationView['requests'];
  readonly tasks: ParticipationView['tasks'];
  readonly busy: boolean;
  readonly mutate: (path: string, body: Record<string, unknown>) => Promise<void>;
  readonly control: string;
}) {
  const [deadlines, setDeadlines] = useState<Record<string, string>>({});
  if (!requests.length) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">收到的请求与私人工作</summary>
      <div className="mt-3 space-y-4">
        {requests
          .slice(-20)
          .reverse()
          .map((request) => {
            const task = tasks.find((item) => item.sourceRefs.includes(`message:${request.messageId}`));
            return (
              <article
                key={request.event.eventId}
                className="space-y-2 border-b border-[var(--console-border-soft)] pb-3"
              >
                <p className="line-clamp-3 text-sm">{request.event.body}</p>
                <p className="text-cafe-muted">
                  {request.failure
                    ? '尚未唤醒，需要检查参与设置'
                    : request.messageId
                      ? '已进入猫的接收队列'
                      : '已送达，等待进入接收队列'}
                  {task ? ` · ${task.closure === 'open' ? '已承接私人工作' : '工作已收口'}` : ''}
                </p>
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
                  request.messageId && (
                    <div className="space-y-2">
                      <label className="grid gap-1">
                        截止时间（请求中有期限时填写）
                        <input
                          type="datetime-local"
                          className={control}
                          value={deadlines[request.messageId] ?? ''}
                          onChange={(event) =>
                            setDeadlines((current) => ({
                              ...current,
                              [request.messageId!]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className={control}
                        disabled={busy}
                        onClick={() =>
                          void mutate('/work/admit', {
                            sourceMessageId: request.messageId,
                            requestId: crypto.randomUUID(),
                            ...(deadlines[request.messageId!]
                              ? { businessDeadline: new Date(deadlines[request.messageId!]!).getTime() }
                              : {}),
                          })
                        }
                      >
                        交给它持续处理
                      </button>
                    </div>
                  )
                )}
              </article>
            );
          })}
      </div>
    </details>
  );
}
