'use client';
import type { WorkVideoContext } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createVideoProjectSurface } from '../video-project-surface';

/** Return to the frozen screening and its original ledger; never copy old opinions into a Work ledger. */
export function VideoWorkSource({ binding }: { binding: WorkVideoContext['sourceBinding'] }) {
  if (!binding) return null;
  return (
    <section aria-label="可编辑来源和原审片" className="mb-3 rounded-md border border-cafe-subtle p-2 text-xs">
      <p>可编辑来源 · 第 {binding.sourceOwnerRevision} 版</p>
      {binding.screeningId ? (
        <button
          type="button"
          className="mt-1 text-cafe-accent underline"
          onClick={() => {
            const surface = createVideoProjectSurface({
              contentRef: binding.sourceProjectContentRef,
              screeningId: binding.screeningId,
              title: '来源审片与原意见',
            });
            useChatStore.getState().setWorkspaceMode('dev');
            useF307ExperienceWorkbenchStore
              .getState()
              .dispatch({ type: 'open-surface', surface, entitlement: { kind: 'user', reason: 'return-origin' } });
          }}
        >
          打开来源审片与原意见
        </button>
      ) : (
        <p className="mt-1 text-cafe-muted">未绑定固定审片，不跳转到其他输入版本。</p>
      )}
    </section>
  );
}
