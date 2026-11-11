import { useEffect, useRef, useState } from 'react';
import { MemoryDeliveryUsage } from './MemoryDeliveryUsage';
import { MemoryPersonProposals } from './MemoryOriginalProposals';
import { MemoryPersonClaim } from './MemoryPersonClaim';
import { MemoryPersonInteraction } from './MemoryPersonInteraction';
import { MemoryPersonSource } from './MemoryPersonSource';
import { MemoryReadState } from './MemoryReadState';
import { isPersonDetail, type PersonDetail } from './people-types';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';
import { usePersonAction } from './use-person-action';

export function MemoryPersonDetail({
  personId,
  close,
  changed,
  deliveryRevision,
  onApplied,
}: {
  personId: string;
  close: () => void;
  changed: () => void;
  deliveryRevision?: string;
  onApplied?: (kind: string) => void;
}) {
  const detail = useMemoryRead<PersonDetail>(
    `/api/memory/people/${encodeURIComponent(personId)}${deliveryRevision ? `?deliveryRevision=${encodeURIComponent(deliveryRevision)}` : ''}`,
    isPersonDetail,
  );
  const [forgetting, setForgetting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const action = usePersonAction(personId, (kind) => {
    if (onApplied) {
      onApplied(kind);
      return;
    }
    changed();
    if (kind === 'hard_forget_person') close();
    else detail.retry();
  });
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!action.error || action.busy) return;
    errorRef.current?.scrollIntoView({ block: 'nearest' });
    errorRef.current?.focus({ preventScroll: true });
  }, [action.error, action.busy]);
  const data = detail.data;
  const mutationBlocked = action.busy || !!action.error;
  return (
    <aside
      aria-label="人物详情"
      className="space-y-4 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium">人物详情</h2>
        <button type="button" onClick={close} className="text-compact text-cafe-accent underline">
          返回人物
        </button>
      </div>
      <MemoryReadState
        loading={detail.loading}
        error={detail.error}
        empty={false}
        noun="人物详情"
        retry={detail.retry}
      />
      {action.error && (
        <div ref={errorRef} role="alert" tabIndex={-1} className="space-y-2 text-compact">
          <p>{action.error}</p>
          {action.retryable ? (
            <button type="button" disabled={action.busy} onClick={action.retry} className="text-cafe-accent underline">
              重试这次操作
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                action.reset();
                detail.retry();
              }}
              className="text-cafe-accent underline"
            >
              重读人物
            </button>
          )}
        </div>
      )}
      {data && (
        <>
          <h3 className="text-display-sm font-medium">{data.displayName}</h3>
          <p className="text-xs text-cafe-muted">
            只给你看 · 记录于 {formatMemoryDate(data.createdAt)}
            {data.aliases.length > 0 ? ` · 也叫 ${data.aliases.join('、')}` : ''}
          </p>
          <p className="text-compact text-cafe-muted">
            ● 生效中 · {data.claims.filter((item) => item.status === 'current').length} 条当前判断 ·{' '}
            {data.interactions.filter((item) => item.status === 'active').length} 段共同经历
          </p>
          <section className="space-y-3" aria-label="人物判断">
            <h4 className="text-sm font-medium">关于这个人的判断</h4>
            {data.claims.length ? (
              data.claims.map((claim) => (
                <MemoryPersonClaim
                  key={`${claim.claimId}:${claim.revision}`}
                  personId={personId}
                  claim={claim}
                  busy={mutationBlocked}
                  submit={action.submit}
                />
              ))
            ) : (
              <p className="text-compact text-cafe-muted">还没有判断记录</p>
            )}
          </section>
          <section className="space-y-3" aria-label="人物经历">
            <h4 className="text-sm font-medium">共同经历</h4>
            {data.interactions.length ? (
              data.interactions.map((item) => (
                <MemoryPersonInteraction
                  key={`${item.eventId}:${item.revision}`}
                  personId={personId}
                  item={item}
                  busy={mutationBlocked}
                  submit={action.submit}
                />
              ))
            ) : (
              <p className="text-compact text-cafe-muted">还没有共同经历</p>
            )}
          </section>
          <section className="space-y-2 border-t border-cafe-subtle pt-4">
            <h4 className="text-compact text-cafe-muted">来源</h4>
            <MemoryPersonSource personId={personId} />
          </section>
          <section className="space-y-2 border-t border-cafe-subtle pt-4">
            <h4 className="text-compact text-cafe-muted">什么时候会想起</h4>
            <p className="text-sm">对话里提到已关联的名字时，可能递送。</p>
          </section>
          <MemoryDeliveryUsage family="person_entity" anchor={`person-memory:${personId}`} />
          <MemoryPersonProposals proposals={data.proposals} />
          {Object.values(data.truncation).some(Boolean) && (
            <output className="block text-compact text-cafe-muted">
              记录较多，这里只展示最近的一部分；遗忘作用于这个人的全部人物记忆。
            </output>
          )}
          <button
            type="button"
            disabled={mutationBlocked}
            onClick={() => {
              setForgetting(!forgetting);
              setConfirmed(false);
            }}
            className="shell-focusable text-compact text-cafe-muted"
          >
            忘掉这个人
          </button>
          {forgetting && (
            <div className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4 text-compact">
              <p>永久删除这个人的人物记忆，包括判断、关系和共同经历，不能撤销。不会删除原始对话或共享实体。</p>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                我确认永久遗忘这个人
              </label>
              <button
                type="button"
                disabled={!confirmed || mutationBlocked}
                onClick={() =>
                  action.submit({
                    action: 'hard_forget_person',
                    expectedPersonRevision: data.personRevision,
                    confirmed: true,
                  })
                }
                className="text-cafe-accent underline"
              >
                确认永久遗忘
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
