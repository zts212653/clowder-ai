'use client';

import { useState } from 'react';
import type { AuthPendingRequest, RespondScope } from '@/hooks/useAuthorization';

const CAT_LABELS: Record<string, string> = {
  opus: '布偶猫',
  codex: '缅因猫',
  gemini: '暹罗猫',
  kimi: '梵花猫',
  dare: '狸花猫',
};

interface AuthorizationCardProps {
  request: AuthPendingRequest;
  onRespond: (requestId: string, granted: boolean, scope: RespondScope, reason?: string) => void;
}

export function AuthorizationCard({ request, onRespond }: AuthorizationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const catLabel = CAT_LABELS[request.catId] ?? request.catId;

  return (
    <div className="border border-conn-amber-ring bg-conn-amber-bg rounded-lg p-3 mx-2 mb-2 shadow-sm animate-pulse-subtle">
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
              onClick={() => onRespond(request.requestId, true, 'once')}
              className="px-3 py-1 text-xs bg-[var(--color-conn-emerald-text)] text-[var(--cafe-surface)] rounded-md hover:opacity-90 transition-colors"
            >
              允许 (仅此次)
            </button>
            <button
              onClick={() => setExpanded(true)}
              className="px-3 py-1 text-xs bg-[var(--console-pill-bg)] text-cafe-secondary rounded-md hover:bg-[var(--console-hover-bg)] transition-colors"
            >
              更多选项...
            </button>
            <button
              onClick={() => onRespond(request.requestId, false, 'once')}
              className="px-3 py-1 text-xs bg-conn-red-bg text-conn-red-text rounded-md hover:opacity-80 transition-colors"
            >
              拒绝
            </button>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => onRespond(request.requestId, true, 'once')}
              className="px-3 py-1 text-xs bg-[var(--color-conn-emerald-text)] text-[var(--cafe-surface)] rounded-md hover:opacity-90 transition-colors"
            >
              允许 (仅此次)
            </button>
            <button
              onClick={() => onRespond(request.requestId, true, 'thread')}
              className="px-3 py-1 text-xs bg-[var(--color-conn-emerald-text)] text-[var(--cafe-surface)] rounded-md hover:opacity-90 transition-colors"
            >
              允许 (此对话)
            </button>
            <button
              onClick={() => onRespond(request.requestId, true, 'global')}
              className="px-3 py-1 text-xs bg-[var(--color-conn-emerald-text)] text-[var(--cafe-surface)] rounded-md hover:opacity-90 transition-colors"
            >
              允许 (全局)
            </button>
            <button
              onClick={() => onRespond(request.requestId, false, 'once')}
              className="px-3 py-1 text-xs bg-conn-red-bg text-conn-red-text rounded-md hover:opacity-80 transition-colors"
            >
              拒绝 (仅此次)
            </button>
            <button
              onClick={() => onRespond(request.requestId, false, 'global')}
              className="px-3 py-1 text-xs bg-[var(--color-conn-red-text)] text-[var(--cafe-surface)] rounded-md hover:opacity-90 transition-colors"
            >
              拒绝 (全局)
            </button>
            <button
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
