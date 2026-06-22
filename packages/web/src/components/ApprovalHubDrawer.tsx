'use client';

/**
 * F246: Approval Hub Drawer.
 *
 * Slides in from the right when the Activity Bar bell icon is clicked.
 * Lists all pending approval items (F128 thread proposals, F225 session handoffs)
 * sorted newest first, with inline approve/reject for F128 and jump-to-thread for F225.
 */

import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ApprovalItemCard } from './ApprovalItemCard';

export function ApprovalHubDrawer() {
  const isOpen = useApprovalHubStore((s) => s.isOpen);
  const close = useApprovalHubStore((s) => s.close);
  const items = useApprovalHubStore((s) => s.items);
  const count = useApprovalHubStore((s) => s.count);
  const isLoading = useApprovalHubStore((s) => s.isLoading);
  const error = useApprovalHubStore((s) => s.error);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is mouse-only intentionally */}
      <div
        role="presentation"
        className="fixed inset-0 z-40 bg-black/20"
        onClick={close}
        data-testid="approval-hub-backdrop"
      />

      {/* Drawer panel */}
      <div
        className="fixed top-0 right-0 z-50 h-full w-[380px] max-w-[90vw] bg-[var(--console-card-bg)] border-l border-[var(--cafe-border)] shadow-xl flex flex-col"
        data-testid="approval-hub-drawer"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--cafe-border)]">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">待审批</h2>
            {count > 0 && (
              <span
                className="min-w-[20px] h-5 px-1.5 rounded-full text-micro font-bold flex items-center justify-center"
                style={{ backgroundColor: 'var(--semantic-warning)', color: 'var(--cafe-accent-foreground)' }}
              >
                {count > 99 ? '99+' : String(count)}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-[var(--cafe-muted)]"
            title="关闭"
            data-testid="approval-hub-close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <title>关闭</title>
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {isLoading && items.length === 0 && (
            <div className="flex items-center justify-center py-8 opacity-50">
              <p className="text-sm">加载中...</p>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-[var(--semantic-critical)] p-3">
              <p className="text-sm text-[var(--semantic-critical)]">加载失败: {error}</p>
            </div>
          )}

          {!isLoading && !error && items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 opacity-50" data-testid="empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 mb-2">
                <title>无待审批</title>
                <path
                  d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <p className="text-sm">没有待审批的项目</p>
            </div>
          )}

          {items.map((item) => (
            <ApprovalItemCard key={item.proposalId} item={item} />
          ))}
        </div>
      </div>
    </>
  );
}
