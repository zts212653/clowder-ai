'use client';

import { formatWorktreeNotice, WORKTREE_NOTICE_KINDS, type WorktreeNotice } from '@cat-cafe/shared';
import { ConnectorBubble } from '@/components/ConnectorBubble';
import type { ChatMessage } from '@/stores/chat-types';

const path = '/workspace/cat-cafe-alpha-f333-acceptance';
const legacy = `工位需要原负责人核对收尾：retention-head-changed
owner="codex-astra"
path="${path}"
source="task:work:original-acceptance"
until="2026-11-02T15:40:00.000Z"
请核对原用途后执行 worktree:finish 或给出新的原因与截止。目录未被自动修改。`;
const message = (id: string, content: string, notice?: WorktreeNotice): ChatMessage => ({
  id,
  type: 'connector',
  from: { kind: 'system', service: 'worktree-lifecycle' },
  content,
  timestamp: Date.UTC(2026, 9, 27, 11, 28),
  source: {
    connector: 'worktree-lifecycle',
    label: '工位通知',
    icon: 'settings',
    ...(notice ? { meta: { worktreeNotice: notice } } : {}),
  },
});

/** Read-only development fixture: no message persistence, API action or actual checkout mutation. */
export function WorktreeNoticesPreview() {
  return (
    <main className="min-h-screen bg-cafe-surface p-4 text-cafe-black sm:p-8" data-testid="worktree-notice-preview">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <h1 className="text-xl font-semibold">工位通知</h1>
          <p className="mt-1 text-xs text-cafe-secondary">旧消息与各类结果 · 隔离预览</p>
        </header>
        <section data-preview-case="historical">
          <ConnectorBubble message={message('legacy', legacy)} />
        </section>
        {WORKTREE_NOTICE_KINDS.filter((kind) => kind !== 'retention-head-changed').map((kind) => {
          const removed = kind === 'merged-removed' || kind === 'merged-removal-interrupted';
          const notice: WorktreeNotice = {
            version: 1,
            kind,
            path,
            owner: 'codex-astra',
            sourceRef: 'task:work:original-acceptance',
            until: '2026-11-02T15:40:00.000Z',
            ...(!removed ? { ownerAction: 'queued' as const } : {}),
            ...(removed
              ? {
                  archivePath: '/workspace/.worktree-release-archives/preview-originals',
                  restore: "git worktree add --detach '/workspace/cat-cafe-alpha-f333-acceptance' HEAD",
                }
              : {}),
            ...(kind === 'merged-retirement-blocked'
              ? { reason: 'native cleanup was interrupted; preserve originals' }
              : {}),
          };
          return (
            <section key={kind} data-preview-case={kind}>
              <ConnectorBubble message={message(kind, formatWorktreeNotice(notice), notice)} />
            </section>
          );
        })}
        <section data-preview-case="interrupted-with-archive">
          <ConnectorBubble
            message={message('interrupted', '', {
              version: 1,
              kind: 'merged-retirement-blocked',
              path,
              owner: 'codex-astra',
              sourceRef: 'pr:fixture/repo#42',
              archivePath: '/workspace/recovery/only-copy',
              ownerAction: 'queued',
            })}
          />
        </section>
        <section data-preview-case="owner-unavailable">
          <ConnectorBubble
            message={message('owner-unavailable', '', {
              version: 1,
              kind: 'retention-expired',
              path,
              owner: 'codex-astra',
              sourceRef: 'task:work:original-acceptance',
              ownerAction: 'unavailable',
            })}
          />
        </section>
      </div>
    </main>
  );
}
