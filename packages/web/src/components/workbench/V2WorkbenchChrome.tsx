'use client';

import type { KeyboardEvent } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useWorkspaceHostChromeActions } from '@/components/workspace/ContextualWorkspaceChrome';
import { V2WorkspaceMenu } from '@/components/workspace/V2WorkspaceMenu';
import { useChatStore } from '@/stores/chatStore';
import { isWorkspaceFullWindowSurface } from './artifact-work-presentation';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import type { F307WorkbenchTabsProps } from './F307WorkbenchTabs';
import { V2WorkbenchTabStrip } from './V2WorkbenchTabStrip';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';
import { lockCurrentWorkspace } from './workspace-presentation-lock';

function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if (!buttons.length) return;
  event.preventDefault();
  const current = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1;
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
  buttons[index].focus();
}

/** This header presents original host actions; topology, focus, pins and content stay with their owners. */
export function V2WorkbenchChrome(props: F307WorkbenchTabsProps) {
  const t = useShellCopy(workspaceChromeCopy);
  const hostActions = useWorkspaceHostChromeActions();
  const locked = useChatStore((state) => state.presentationLock != null);
  const unlock = useChatStore((state) => state.disablePresentationLock);
  const focused = useF307ExperienceWorkbenchStore((state) => state.focusSurfaceId);
  const active = props.homeFocused
    ? undefined
    : props.layout.surfaces.find((surface) => surface.id === props.layout.activeSurfaceId);
  const candidate = props.layout.surfaces.find((surface) => surface.id !== active?.id);
  const canCloseOthers =
    active &&
    props.layout.surfaces.some(
      (surface) => surface.id !== active.id && !props.layout.pinnedSurfaceIds.includes(surface.id),
    );
  const canCloseAll = props.layout.surfaces.some((surface) => !props.layout.pinnedSurfaceIds.includes(surface.id));
  const fullWindowAttention =
    active !== undefined && props.mainAreaAttentionSurfaceId === active.id && props.mainAreaAttentionIsWide !== true;
  const items = [
    {
      label: t.focusCurrent,
      detail: t.focusDetail,
      disabled: !active,
      action: () => {
        if (!active) return;
        const store = useF307ExperienceWorkbenchStore.getState();
        if (focused === active.id) store.exitFocusMode();
        else store.enterFocusMode(active.id);
      },
    },
    {
      label: t.focus.fullWindow,
      checked:
        props.fullWindowAction?.active ??
        (!props.mainAreaAttentionIsWide && props.mainAreaAttentionSurfaceId === active?.id),
      disabled:
        !active ||
        !props.isDesktop ||
        (props.artifactWorkHostAvailable && isWorkspaceFullWindowSurface(active, 'v2') && !props.fullWindowAction),
      action: () => {
        if (props.fullWindowAction) props.fullWindowAction.onToggle();
        else if (active) {
          if (!props.mainAreaAttentionIsWide && props.mainAreaAttentionSurfaceId === active.id)
            props.onExitMainAreaAttention();
          else props.onEnterMainAreaAttention(active.id);
        }
      },
    },
    {
      label: t.sideBySide,
      checked: props.layout.split !== null,
      disabled: !active || (!candidate && !props.layout.split),
      action: () => {
        if (props.layout.split)
          props.dispatch({ type: 'collapse-split', entitlement: { kind: 'user', reason: 'collapse-split' } });
        else if (candidate)
          props.dispatch({
            type: 'split-with',
            surfaceId: candidate.id,
            entitlement: { kind: 'user', reason: 'explicit-split' },
          });
      },
    },
    {
      label: t.lock,
      detail: t.lockDetail,
      checked: locked,
      disabled: !active && !locked,
      action: locked ? unlock : lockCurrentWorkspace,
    },
    {
      label: t.closeOthers,
      testId: 'v2-close-other-tabs',
      disabled: !canCloseOthers,
      action: () => {
        if (active)
          props.dispatch({
            type: 'close-other-surfaces',
            preserveSurfaceId: active.id,
            entitlement: { kind: 'user', reason: 'bulk-close' },
          });
      },
    },
    {
      label: t.closeAll,
      testId: 'v2-close-all-tabs',
      disabled: !canCloseAll,
      action: () => props.dispatch({ type: 'close-all-unpinned', entitlement: { kind: 'user', reason: 'bulk-close' } }),
    },
    { label: t.fold, detail: 'Esc', disabled: !hostActions?.showFold, action: () => hostActions?.onFold() },
  ];
  return (
    <header
      data-testid="v2-workspace-chrome"
      data-v2-workspace-menu-boundary=""
      className="relative z-30 flex min-h-11 min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-cafe-subtle bg-cafe-surface px-2 py-1"
    >
      <V2WorkbenchTabStrip props={props} />
      <div className="flex shrink-0 items-center" data-testid="v2-workspace-actions">
        {fullWindowAttention && (
          <button
            type="button"
            className="mr-1 rounded-md border border-cafe-subtle bg-cafe-surface-sunken px-2.5 py-1.5 text-xs font-semibold text-cafe-secondary hover:text-cafe"
            onClick={props.onExitMainAreaAttention}
            data-testid="v2-workspace-return-to-chat"
          >
            {t.returnToChat}
          </button>
        )}
        {props.toolsContent ? (
          <V2WorkspaceMenu
            width={360}
            openRequest={props.toolsOpenRequest}
            scopeKey={props.toolsScopeKey}
            onClose={props.onToolsClose}
            focusSelector='[data-testid="workspace-launcher-search"]'
            tooltip={t.openTools}
            trigger="+"
            triggerProps={{
              'aria-label': t.openTools,
              'data-testid': 'v2-workspace-tools',
              className:
                'flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-cafe-secondary hover:bg-cafe-surface-sunken',
            }}
          >
            {props.toolsContent}
          </V2WorkspaceMenu>
        ) : (
          <AppTooltip label={t.openTools} side="bottom">
            <button
              type="button"
              disabled
              aria-label={t.openTools}
              className="h-8 w-8 rounded-md text-cafe-muted disabled:opacity-30"
            >
              +
            </button>
          </AppTooltip>
        )}
        <V2WorkspaceMenu
          width={256}
          tooltip={t.more}
          trigger="⋯"
          triggerProps={{
            'aria-label': t.more,
            className:
              'flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-cafe-secondary hover:bg-cafe-surface-sunken',
          }}
        >
          {(close) => (
            <div role="menu" aria-label={t.more} onKeyDown={moveMenuFocus}>
              {items
                .filter((item) => !props.homeFocused || !item.disabled)
                .map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    {...(item.checked === undefined
                      ? { role: 'menuitem' as const }
                      : { role: 'menuitemcheckbox' as const, 'aria-checked': item.checked })}
                    aria-label={item.label}
                    data-testid={item.testId}
                    disabled={item.disabled}
                    className="flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-xs text-cafe-secondary hover:bg-cafe-surface-sunken disabled:opacity-30"
                    onClick={() => {
                      item.action();
                      close();
                    }}
                  >
                    <span>
                      {item.label}
                      {item.detail && <span className="mt-0.5 block text-micro text-cafe-muted">{item.detail}</span>}
                    </span>
                    {item.checked && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
            </div>
          )}
        </V2WorkspaceMenu>
      </div>
    </header>
  );
}
