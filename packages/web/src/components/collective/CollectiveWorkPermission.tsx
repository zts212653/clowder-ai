'use client';
import { useState } from 'react';
import { kindLabel } from './CollectiveWorkPolicyRules';
import { policyControl } from './collective-work-policy-control';
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
        允许后，{catName} 只用这件事能看的共同体资料，结果回到原来的讨论；家里的其他资料不会开放。
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
            以后 # {request.channelId} 里任何人请 {catName} 做「{kindLabel(request.requestKind)}」，{catName}
            可以自己决定接，不再来问你。
          </p>
          <p className="mt-1 text-cafe-muted">一直有效，直到你在「我的猫」里撤回。其他猫、频道和事项照旧。</p>
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
