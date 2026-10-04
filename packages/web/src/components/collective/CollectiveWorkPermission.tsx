'use client';
import { useState } from 'react';
import { kindLabel, policyControl } from './CollectiveWorkPolicySettings';
import type { ParticipationView } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';
import type { CollectiveWorkPolicyBridge } from './use-collective-work-policy-bridge';
export function CollectiveWorkPermission({
  bridge,
  state,
  view,
}: {
  bridge: CollectiveWorkPolicyBridge;
  state: CollectiveWorkPolicyState;
  view?: ParticipationView;
}) {
  const [future, setFuture] = useState(false);
  const request = bridge.permissionRequest;
  if (!request) return null;
  const catName = view?.cats.find((cat) => cat.id === request.catId)?.displayName ?? '提议的猫';
  const action = (permission: 'once' | 'class') =>
    void state.change({
      kind: 'allow_request',
      workId: request.workId,
      workRevision: request.workRevision,
      permission,
    });
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="授权决定"
      data-testid="collective-work-permission"
      data-concierge-reserved-rect="collective-work-permission"
      className="absolute bottom-4 right-4 z-30 max-h-[90%] w-[min(380px,calc(100%_-_32px))] overflow-y-auto rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 text-cafe-primary shadow-[var(--console-elevation-2)]"
    >
      <header className="flex justify-between gap-3">
        <div>
          <p className="text-xs text-cafe-muted">我的 Café · 仅自己可见</p>
          <h2 className="mt-2 font-serif text-display-sm">授权决定</h2>
        </div>
        <button
          className={policyControl}
          type="button"
          aria-label="关闭授权决定"
          onClick={bridge.clearPermissionRequest}
        >
          关闭
        </button>
      </header>
      <p className="mt-3 text-sm">{request.title}</p>
      <p className="mt-1 text-xs text-cafe-muted">
        {catName} · # {request.channelId} · {kindLabel(request.requestKind)}
      </p>
      <p className="mt-3 text-sm leading-6">
        请为这项提议决定授权。允许原请求，或为这只猫在这个频道添加同类规则；仍由猫判断是否接下。
      </p>
      <p className="mt-2 text-xs leading-5 text-cafe-muted">
        可读当前事项有权查看的共同体资料；在家里准备结果，并回到原处。私人的其他资料不会因此开放。
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="h-8 rounded-lg bg-cafe-accent px-3 text-sm text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          disabled={state.busy}
          onClick={() => action('once')}
        >
          允许这一次
        </button>
        <button
          type="button"
          className={policyControl}
          disabled={state.busy}
          onClick={() =>
            void state.change({ kind: 'decline_request', workId: request.workId, workRevision: request.workRevision })
          }
        >
          不允许
        </button>
      </div>
      <button type="button" className="mt-3 text-sm underline" disabled={state.busy} onClick={() => setFuture(!future)}>
        以后这类都允许…
      </button>
      {future && (
        <div className="mt-3 border-t border-[var(--console-border-soft)] pt-3 text-xs leading-5">
          <p>
            仅允许 {catName} 在 # {request.channelId} 自动接受“{kindLabel(request.requestKind)}
            ”。其他类型、猫和频道继续按原规则判断，人工模式保持不变。
          </p>
          <button
            type="button"
            className={`${policyControl} mt-2`}
            disabled={state.busy}
            onClick={() => action('class')}
          >
            允许此类工作
          </button>
        </div>
      )}
      <p aria-live="polite" className="mt-3 text-xs">
        {state.busy ? state.phase : state.error ? '更改未成功' : state.phase}
      </p>
      {state.newDecisionAvailable && (
        <div className="mt-3 text-xs leading-5">
          <p>旧规则已失效。重新授权会登记一份新的规则；不会自动接下工作。</p>
          <button
            type="button"
            className={policyControl}
            disabled={state.busy}
            onClick={() =>
              void state.newDecision({
                kind: 'allow_request',
                workId: request.workId,
                workRevision: request.workRevision,
                permission: future ? 'class' : 'once',
              })
            }
          >
            {future ? '重新授权此类工作' : '重新授权这一次'}
          </button>
        </div>
      )}
      {state.error && (
        <p role="alert" className="mt-2 text-xs">
          {state.error}
        </p>
      )}
      <button type="button" className="mt-3 text-xs underline" onClick={bridge.clearPermissionRequest}>
        返回原消息
      </button>
    </aside>
  );
}
