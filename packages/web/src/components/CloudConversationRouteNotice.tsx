'use client';

import { routeGhostClass } from './CloudConversationRouteChooser';

/**
 * What the last change to the thread's route came to. A failed request is not proof that nothing
 * changed: the server may have written it and only the answer got lost. So a failure is either a
 * definite refusal (nothing changed, and we can say so) or an unknown outcome, settled only by
 * reading the route back — and while that is unsettled, nothing else is written. A read-back that
 * does not show the change leaves the route as read, without claiming the change never lands.
 */
export type RouteOperation =
  | { readonly kind: 'idle' }
  | { readonly kind: 'rejected'; readonly action: RouteAction; readonly reason: string }
  | { readonly kind: 'reconciling'; readonly action: RouteAction }
  | { readonly kind: 'unknown'; readonly action: RouteAction }
  | { readonly kind: 'unconfirmed'; readonly action: RouteAction };

/** `connect` gives an unconnected thread its conversation; `change` replaces the one it has. */
export type RouteAction = 'connect' | 'change' | 'disconnect';

const OUTCOME: Record<RouteAction, { failed: string; unsure: string; unchanged: string }> = {
  connect: { failed: '没能连接这个会话', unsure: '连接成功', unchanged: '这个对话仍未连接。' },
  change: { failed: '没能改用这个会话', unsure: '更换成功', unchanged: '原来的连接没有变。' },
  disconnect: { failed: '没能断开连接', unsure: '已断开', unchanged: '原来的连接没有变。' },
};

function Dot({ tone }: { tone: 'warning' | 'critical' | 'neutral' }) {
  const background =
    tone === 'warning'
      ? 'var(--semantic-warning)'
      : tone === 'critical'
        ? 'var(--semantic-critical)'
        : 'var(--console-border-soft)';
  return <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background }} />;
}

export function RouteOperationNotice({ operation, onReread }: { operation: RouteOperation; onReread: () => void }) {
  if (operation.kind === 'idle') return null;
  const words = OUTCOME[operation.action];
  if (operation.kind === 'reconciling') {
    return (
      <output aria-live="polite" className="mt-2 block text-xs text-cafe-secondary">
        暂时无法确认是否{words.unsure}，正在重新读取连接…
      </output>
    );
  }
  if (operation.kind === 'unconfirmed') {
    return (
      <output aria-live="polite" className="mt-2 flex items-start gap-1.5 text-xs text-cafe-secondary">
        <Dot tone="neutral" />
        <span className="min-w-0 flex-1">没能确认{words.unsure}。现在显示的是重新读取到的连接，可以再试一次。</span>
      </output>
    );
  }
  const unknown = operation.kind === 'unknown';
  return (
    <div role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-cafe-secondary">
      <Dot tone={unknown ? 'warning' : 'critical'} />
      {unknown ? (
        <span className="min-w-0 flex-1">
          无法确认是否{words.unsure}，也暂时读不到当前连接。
          <button type="button" className={`${routeGhostClass} ml-1`} onClick={onReread}>
            重新读取
          </button>
        </span>
      ) : (
        <span className="min-w-0 flex-1">
          {words.failed}：{operation.reason}
          {words.unchanged}
        </span>
      )}
    </div>
  );
}
