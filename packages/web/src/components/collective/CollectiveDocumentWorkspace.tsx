'use client';

import { useShellCopy } from '@/components/shell/shell-copy';
import { useChatStore } from '@/stores/chatStore';
import { F307ExperienceWorkbench } from '../workbench/F307ExperienceWorkbench';
import { collectiveDocumentCopy } from './collective-document.shell-copy';

/** The normal Workspace kernel hosts owner-backed tabs while the authenticated Client stays connected. */
export function CollectiveDocumentWorkspace({ visible, onBack }: { visible: boolean; onBack(): void }) {
  const copy = useShellCopy(collectiveDocumentCopy);
  return (
    <div
      className={visible ? 'absolute inset-0 z-20 flex min-h-0 flex-col bg-cafe-surface' : 'hidden'}
      aria-hidden={!visible}
    >
      <div className="shrink-0 border-b border-cafe-subtle px-3 py-1 text-xs">
        <button type="button" className="min-h-8 px-2" onClick={onBack}>
          {copy.collectiveBack}
        </button>
      </div>
      <F307ExperienceWorkbench
        visible={visible}
        worktreeId={null}
        openFilePath={null}
        preview={{ path: '/' }}
        onSelectDevSurface={(surface) => useChatStore.getState().setWorkspaceSurface(surface)}
        onOpenAppRoute={(href) => window.location.assign(href)}
      />
    </div>
  );
}
