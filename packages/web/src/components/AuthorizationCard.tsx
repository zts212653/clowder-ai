'use client';

import { useState } from 'react';
import type { AuthPendingRequest, RespondScope } from '@/hooks/useAuthorization';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';

/**
 * F192 Phase G AC-G10: Cancel reason options as deny button variants.
 * Each button = one-click deny + structured reason. No two-step, no follow-up.
 * reason flows through onRespond → /api/authorization/respond → onPermissionCancel → episode signal.
 */
const DENY_VARIANTS = [
  { reason: 'skip', label: '拒绝', scope: 'once' as const },
  { reason: 'should_not_do', label: '不该做', scope: 'once' as const },
  { reason: 'wrong_direction', label: '方向不对', scope: 'once' as const },
  { reason: 'i_will_do_it', label: '我自己来', scope: 'once' as const },
] as const;

interface AuthorizationCardProps {
  request: AuthPendingRequest;
  onRespond: (
    requestId: string,
    granted: boolean,
    scope: RespondScope,
    reason?: string,
    withFeedback?: boolean,
  ) => void;
}

export function AuthorizationCard({ request, onRespond }: AuthorizationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const resolveCatName = useCatNameResolver();
  const catLabel = resolveCatName(request.catId);

  return (
    <div className="border border-conn-amber-ring bg-conn-amber-bg/80 rounded-lg p-3 mx-2 mb-2 shadow-sm animate-pulse-subtle">
      <div className="flex items-start gap-2">
        <span className="text-conn-amber-text mt-0.5 text-lg">🔐</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-cafe">
            {catLabel} 请求权限: <code className="text-xs bg-conn-amber-bg px-1 py-0.5 rounded">{request.action}</code>
          </div>
          <p className="text-xs text-cafe-secondary mt-1">{request.reason}</p>
          {request.context && <p className="text-xs text-cafe-secondary mt-1 italic">{request.context}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2 ml-7">
        {!expanded ? (
          <>
            <button
              type="button"
              onClick={() => onRespond(request.requestId, true, 'once')}
              className="px-3 py-1 text-xs bg-conn-green-text text-[var(--cafe-surface)] rounded-md hover:bg-conn-green-hover transition-colors"
            >
              允许 (仅此次)
            </button>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="px-3 py-1 text-xs bg-cafe-surface text-cafe-secondary rounded-md hover:bg-[var(--console-hover-bg)] transition-colors"
            >
              更多选项...
            </button>
            <button
              type="button"
              onClick={() => onRespond(request.requestId, false, 'once', 'skip')}
              className="px-3 py-1 text-xs bg-conn-red-bg text-conn-red-text rounded-md hover:bg-conn-red-ring transition-colors"
            >
              拒绝
            </button>
            {/* F222 UX-3: Cancel & Feedback — direct frustration report */}
            <button
              type="button"
              onClick={() => onRespond(request.requestId, false, 'once', 'skip', true)}
              className="px-3 py-1 text-xs bg-cafe-surface text-cafe-accent rounded-md hover:bg-cafe-accent/10 transition-colors border border-cafe-accent/40"
              title="取消并提交问题反馈"
            >
              取消并反馈
            </button>
          </>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {/* Allow variants */}
            <button
              type="button"
              onClick={() => onRespond(request.requestId, true, 'once')}
              className="px-3 py-1 text-xs bg-conn-green-text text-[var(--cafe-surface)] rounded-md hover:bg-conn-green-hover transition-colors"
            >
              允许 (仅此次)
            </button>
            <button
              type="button"
              onClick={() => onRespond(request.requestId, true, 'thread')}
              className="px-3 py-1 text-xs bg-conn-green-text text-[var(--cafe-surface)] rounded-md hover:bg-conn-green-hover transition-colors"
            >
              允许 (此对话)
            </button>
            <button
              type="button"
              onClick={() => onRespond(request.requestId, true, 'global')}
              className="px-3 py-1 text-xs bg-conn-green-text text-[var(--cafe-surface)] rounded-md hover:bg-conn-green-hover transition-colors"
            >
              允许 (全局)
            </button>

            {/* Deny variants — each is one-click deny + structured reason (AC-G10) */}
            {DENY_VARIANTS.map((v) => (
              <button
                type="button"
                key={v.reason}
                onClick={() => onRespond(request.requestId, false, v.scope, v.reason)}
                className={
                  v.reason === 'skip'
                    ? 'px-3 py-1 text-xs bg-conn-red-bg text-conn-red-text rounded-md hover:bg-conn-red-ring transition-colors'
                    : 'px-2.5 py-1 text-xs bg-cafe-surface text-conn-red-text rounded-md hover:bg-conn-red-bg/30 transition-colors border border-conn-red-ring/30'
                }
              >
                {v.label}
              </button>
            ))}

            {/* Global deny */}
            <button
              type="button"
              onClick={() => onRespond(request.requestId, false, 'global', 'skip')}
              className="px-3 py-1 text-xs bg-conn-red-text text-[var(--cafe-surface)] rounded-md hover:bg-conn-red-hover transition-colors"
            >
              拒绝 (全局)
            </button>
            {/* F222 UX-3: Cancel & Feedback — direct frustration report */}
            <button
              type="button"
              onClick={() => onRespond(request.requestId, false, 'once', 'skip', true)}
              className="px-3 py-1 text-xs bg-cafe-surface text-cafe-accent rounded-md hover:bg-cafe-accent/10 transition-colors border border-cafe-accent/40"
              title="取消并提交问题反馈"
            >
              取消并反馈
            </button>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="px-3 py-1 text-xs text-cafe-secondary hover:text-cafe-secondary transition-colors"
            >
              收起
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
