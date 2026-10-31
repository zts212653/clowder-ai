import { useShellCopy } from '@/components/shell/shell-copy';
import type { WorkspaceMenuContext } from '@/components/workspace/V2WorkspaceMenu';
import {
  WorkspaceToolsContent,
  type WorkspaceToolsContentProps,
} from '@/components/workspace-home/WorkspaceToolsContent';
import { useToastStore } from '@/stores/toastStore';
import { parseFileNavigationOrigin } from './file-navigation-origin';
import { type ToolsReturnRequest, useToolsViewportReturn } from './use-tools-viewport-return';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';

/** B owns catalogue presentation; this adapter captures C's actual popup origin before the original file open. */
export function WorkbenchToolsContent({
  menu,
  returnRequest,
  threadId,
  ...content
}: WorkspaceToolsContentProps & {
  menu: WorkspaceMenuContext;
  returnRequest?: ToolsReturnRequest;
  threadId?: string;
}) {
  const t = useShellCopy(workspaceChromeCopy);
  useToolsViewportReturn(menu, returnRequest);
  const search = content.workspaceSearch;
  const workspaceSearch = search && {
    ...search,
    enabled: search.enabled && menu.open,
    onOpenResult: (path: string, line: number) => {
      const viewport = menu.viewport.current;
      const input = viewport?.querySelector<HTMLInputElement>('[data-testid="workspace-launcher-search"]');
      const origin =
        viewport &&
        input &&
        parseFileNavigationOrigin({
          kind: 'workspace-tools-search',
          threadId,
          query: input.value.trim(),
          viewportOffsetPx: input.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
        });
      if (!origin || origin.kind !== 'workspace-tools-search') {
        useToastStore
          .getState()
          .addToast({ type: 'info', title: t.openTools, message: t.searchOriginUnavailable, duration: 6000 });
        return;
      }
      search.onOpenResult(path, line, origin);
    },
  };
  return <WorkspaceToolsContent {...content} workspaceSearch={workspaceSearch} />;
}
