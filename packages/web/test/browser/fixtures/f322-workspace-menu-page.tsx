import { createRoot } from 'react-dom/client';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { F307WorkbenchTabs } from '@/components/workbench/F307WorkbenchTabs';
import { createFilePreviewSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { V2WorkspaceFileChrome } from '@/components/workspace/V2WorkspaceFileChrome';
import type { WorkspaceFileViewerProps } from '@/components/workspace/WorkspaceFileViewer.types';
import { useChatStore } from '@/stores/chatStore';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-shell.css';
import '@/app/shell-v2.css';

const params = new URLSearchParams(location.search);
const surfaces = Array.from({ length: Math.max(6, Math.min(80, Number(params.get('count')) || 6)) }, (_, index) =>
  createFilePreviewSurface({ worktreeId: 'workspace-menu-fixture', path: `docs/2026-10-09-memory-system-${index}.md` }),
);
const layout = createInitialWorkbenchState(surfaces);
if (params.get('pinned')) layout.pinnedSurfaceIds = [surfaces[1].id];
useF307ExperienceWorkbenchStore.setState({ layout, focusSurfaceId: null });
useChatStore.setState({ currentThreadId: 'workspace-menu-fixture', presentationLock: null });
const record = (name: string) =>
  document.querySelector('[data-testid="action-result"]')?.setAttribute('data-action', name);
const fileProps: WorkspaceFileViewerProps = {
  file: {
    path: 'docs/menu.md',
    content: '# Menu source',
    size: 13,
    truncated: false,
    sha256: 'menu-fixture',
    mime: 'text/markdown',
  },
  openFilePath: 'docs/menu.md',
  openTabs: ['docs/menu.md'],
  canEdit: true,
  editMode: false,
  isMarkdown: true,
  isHtml: false,
  isJsx: false,
  markdownRendered: true,
  htmlPreview: false,
  jsxPreview: false,
  saveError: null,
  scrollToLine: null,
  worktreeId: 'workspace-menu-fixture',
  setOpenFile: () => record('open'),
  closeTab: () => record('close'),
  onCloseCurrentTab: () => record('close'),
  onToggleEdit: () => record('edit'),
  onToggleMarkdownRendered: () => record('render'),
  onToggleHtmlPreview: () => record('html'),
  onToggleJsxPreview: () => record('jsx'),
  onSave: async () => undefined,
};

function MenuPage() {
  const state = useF307ExperienceWorkbenchStore((value) => value.layout);
  return (
    <div
      data-testid="menu-scroll-host"
      className={`${params.get('scroll') ? 'overflow-auto' : 'overflow-hidden'} h-screen bg-cafe-canvas`}
    >
      <div className="relative" style={{ height: params.get('scroll') ? 1600 : '100%' }}>
        <div
          data-testid="workspace-menu-host"
          className="overflow-hidden border border-cafe-subtle bg-cafe-surface"
          style={{
            position: 'absolute',
            width: Number(params.get('pane')) || 320,
            left: Number(params.get('left')) || 0,
            top: Number(params.get('top')) || 16,
            height: 420,
          }}
        >
          <F307WorkbenchTabs
            layout={state}
            dispatch={useF307ExperienceWorkbenchStore.getState().dispatch}
            onAddSurface={() => record('home')}
            onActivateSurface={() => record('activate')}
            homeFocused={false}
            isDesktop
            artifactWorkHostAvailable={false}
            mainAreaAttentionSurfaceId={null}
            onEnterMainAreaAttention={() => record('attention')}
            onExitMainAreaAttention={() => record('exit')}
          />
          {params.get('shell') !== 'classic' && (
            <V2WorkspaceFileChrome
              props={fileProps}
              listen={
                <button type="button" onClick={() => record('listen')}>
                  收听
                </button>
              }
              cache={null}
              onAsk={() => record('ask')}
            />
          )}
          <div
            data-testid="action-result"
            data-surface-count={state.surfaces.length}
            data-pinned-count={state.pinnedSurfaceIds.length}
            data-recently-closed={state.recentlyClosed.length}
          />
        </div>
      </div>
    </div>
  );
}
document.documentElement.dataset.shell = params.get('shell') ?? 'v2';
const root = document.getElementById('root');
if (!root) throw new Error('missing menu fixture root');
createRoot(root).render(<MenuPage />);
