import type { ReactNode, RefCallback } from 'react';
import { useArtworkWorkMode } from '@/components/content-review/ArtworkWorkModeScope';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceMenuContext } from '@/components/workspace/V2WorkspaceMenu';
import { F307WorkbenchControlRail } from './F307WorkbenchControlRail';
import { F307WorkbenchTab } from './F307WorkbenchTab';
import { V2WorkbenchChrome } from './V2WorkbenchChrome';
import { WorkbenchTabFocusContinuity } from './WorkbenchTabFocusContinuity';
import type { WorkbenchAction, WorkbenchLayoutState } from './workbench-contract';
import { workbenchTabLabels } from './workbench-tab-labels';

export interface F307WorkbenchTabsProps {
  hostThreadId?: string;
  layout: WorkbenchLayoutState;
  dispatch: (action: WorkbenchAction) => void;
  onAddSurface: () => void;
  onActivateSurface: () => void;
  homeFocused: boolean;
  isDesktop: boolean;
  artifactWorkHostAvailable: boolean;
  mainAreaAttentionSurfaceId: string | null;
  /** The Schedule wide host keeps Chat visible; it is distinct from the overlay action. */
  mainAreaAttentionIsWide?: boolean;
  onEnterMainAreaAttention: (surfaceId: string) => void;
  onExitMainAreaAttention: () => void;
  /** Host-owned tool content; selection closes this one menu through the supplied callback. */
  toolsContent?: (close: () => void, context: WorkspaceMenuContext) => ReactNode;
  toolsOpenRequest?: number;
  toolsScopeKey?: string;
  onToolsClose?: () => void;
  /** The canonical artifact/file host owns full-window admission and restoration. */
  fullWindowAction?: { active: boolean; onToggle: () => void };
}

export function F307WorkbenchTabs(props: F307WorkbenchTabsProps) {
  const isV2 = useShellPresentation() === 'v2';
  const artworkWorkMode = useArtworkWorkMode();
  const {
    layout,
    dispatch,
    onAddSurface,
    onActivateSurface,
    homeFocused,
    isDesktop,
    artifactWorkHostAvailable,
    mainAreaAttentionSurfaceId,
    onEnterMainAreaAttention,
    onExitMainAreaAttention,
  } = props;
  const labels = workbenchTabLabels(layout.surfaces);
  if (isV2 && artworkWorkMode) return null;
  if (isV2) return <V2WorkbenchChrome {...props} />;
  const renderTabs = (focusRootRef: RefCallback<HTMLElement>) => {
    return (
      <div
        ref={focusRootRef}
        className="flex min-h-10 shrink-0 items-stretch border-b border-cafe-subtle bg-cafe-surface"
        data-testid="f307-tab-actions"
      >
        <div
          className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto px-2 pt-1.5"
          role="tablist"
          data-testid="f307-tab-strip"
        >
          {layout.surfaces.map((surface, index) => {
            const active = !homeFocused && surface.id === layout.activeSurfaceId;
            return (
              <F307WorkbenchTab
                key={surface.id}
                surface={surface}
                displayTitle={labels.get(surface.id)}
                index={index}
                layout={layout}
                active={active}
                dispatch={dispatch}
                onActivateSurface={onActivateSurface}
                returnsFromMainArea={mainAreaAttentionSurfaceId === surface.id}
                onExitMainAreaAttention={onExitMainAreaAttention}
              />
            );
          })}
        </div>
        <F307WorkbenchControlRail
          layout={layout}
          dispatch={dispatch}
          onAddSurface={onAddSurface}
          homeFocused={homeFocused}
          isDesktop={isDesktop}
          artifactWorkHostAvailable={artifactWorkHostAvailable}
          mainAreaAttentionSurfaceId={mainAreaAttentionSurfaceId}
          mainAreaAttentionIsWide={props.mainAreaAttentionIsWide}
          onEnterMainAreaAttention={onEnterMainAreaAttention}
          onExitMainAreaAttention={onExitMainAreaAttention}
        />
      </div>
    );
  };
  return (
    <WorkbenchTabFocusContinuity layout={layout} scopeKey={JSON.stringify([props.hostThreadId, props.homeFocused])}>
      {renderTabs}
    </WorkbenchTabFocusContinuity>
  );
}
