'use client';

import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { V2WorkspaceMenu } from '@/components/workspace/V2WorkspaceMenu';
import type { F307WorkbenchTabsProps } from './F307WorkbenchTabs';
import { V2WorkbenchTab } from './V2WorkbenchTab';
import { WorkbenchTabFocusContinuity } from './WorkbenchTabFocusContinuity';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';
import { workbenchTabLabels } from './workbench-tab-labels';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';

interface TabWidths {
  home: number;
  more: number;
  separator: number;
  tabs: Map<string, number>;
}

function readTabWidths(node: HTMLElement, surfaces: WorkspaceSurfaceDescriptor[]): TabWidths | null {
  const home =
    node.querySelector('[data-testid="v2-workspace-home"]')?.parentElement?.getBoundingClientRect().width ?? 0;
  const more = node.querySelector('[data-testid="v2-more-tabs"]')?.getBoundingClientRect().width ?? 0;
  const tabs = new Map(
    Array.from(node.querySelectorAll<HTMLElement>('[data-tab-surface-id]')).map((tab) => [
      tab.dataset.tabSurfaceId ?? '',
      tab.getBoundingClientRect().width,
    ]),
  );
  if (!home || !more || surfaces.some((surface) => !tabs.get(surface.id))) return null;
  const line = node.querySelector('[data-v2-tab-separator]');
  const style = line && getComputedStyle(line);
  const separator = line
    ? line.getBoundingClientRect().width +
      (Number.parseFloat(style?.marginLeft ?? '0') || 0) +
      (Number.parseFloat(style?.marginRight ?? '0') || 0)
    : 0;
  return { home, more, separator, tabs };
}

function visibleTabs(
  surfaces: WorkspaceSurfaceDescriptor[],
  activeId: string | null,
  homeFocused: boolean,
  width: number,
  sizes: TabWidths | null,
) {
  if (!width) return surfaces;
  const active = surfaces.find((surface) => surface.id === activeId);
  const occupied = (items: WorkspaceSurfaceDescriptor[]) => {
    const selected = homeFocused ? -1 : items.findIndex((surface) => surface.id === activeId);
    const separators = Math.max(
      0,
      items.length - (homeFocused ? 1 : selected < 0 ? 0 : selected < items.length - 1 ? 2 : 1),
    );
    return (
      (sizes?.home ?? 72) +
      items.reduce((sum, surface) => sum + (sizes?.tabs.get(surface.id) ?? 132), 0) +
      separators * (sizes?.separator ?? 0)
    );
  };
  if (occupied(surfaces) <= width) return surfaces;
  const limit = width - (sizes?.more ?? 92) - 4;
  for (let count = surfaces.length - 1; count > 0; count--) {
    const items = surfaces.slice(0, count);
    if (active && !items.includes(active)) items[count - 1] = active;
    if (occupied(items) <= limit) return items;
  }
  return [];
}

export function V2WorkbenchTabStrip({ props }: { props: F307WorkbenchTabsProps }) {
  const t = useShellCopy(workspaceChromeCopy);
  const root = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const surfaces = props.layout.surfaces;
  const labels = workbenchTabLabels(surfaces, t.modeTabs, t.voiceSurface.label, t.statusSurface.label);
  const measureKey = JSON.stringify([
    surfaces.map((surface) => [surface.id, labels.get(surface.id)]),
    props.layout.activeSurfaceId,
    props.homeFocused,
    t.homeTab,
    t.moreTabs(surfaces.length),
  ]);
  const [measurement, setMeasurement] = useState<{ key: string; widths: TabWidths | null }>();
  const measuring = measurement?.key !== measureKey;
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    let previousWidth = -1;
    const measure = () => {
      if (node.clientWidth === previousWidth) return;
      previousWidth = node.clientWidth;
      setWidth(previousWidth);
      setMeasurement(undefined);
    };
    const fontsChanged = () => setMeasurement(undefined);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    document.fonts?.addEventListener('loadingdone', fontsChanged);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      document.fonts?.removeEventListener('loadingdone', fontsChanged);
    };
  }, []);
  useLayoutEffect(() => {
    if (measuring && root.current) setMeasurement({ key: measureKey, widths: readTabWidths(root.current, surfaces) });
  }, [measureKey, measuring, surfaces]);
  // Measure the actual complete blocks before paint; Home never becomes a topology surface.
  // Zero geometry (SSR / hidden host) retains the conservative layout until the host has a width.
  const visible = measuring
    ? surfaces
    : visibleTabs(surfaces, props.layout.activeSurfaceId, props.homeFocused, width, measurement?.widths ?? null);
  const overflow = surfaces.filter((surface) => !visible.includes(surface));
  return (
    <WorkbenchTabFocusContinuity
      layout={props.layout}
      scopeKey={JSON.stringify([props.hostThreadId, props.homeFocused])}
    >
      {(focusRootRef) => (
        <div
          ref={(node) => {
            root.current = node;
            focusRootRef(node);
          }}
          className="flex min-w-[144px] flex-1 items-center gap-1"
          data-testid="v2-tab-strip-host"
        >
          <div
            className="flex min-w-0 flex-1 items-center"
            role="tablist"
            aria-label={t.tabs}
            data-testid="f307-tab-strip"
          >
            <div
              className={`flex shrink-0 items-center rounded-md border ${props.homeFocused ? 'border-[var(--shell-hairline-strong)] bg-cafe-surface-sunken text-cafe' : 'border-transparent text-cafe-muted'}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={props.homeFocused}
                aria-label={t.home}
                data-testid="v2-workspace-home"
                onClick={props.onAddSurface}
                className="flex h-8 items-center gap-1 px-2 text-xs"
              >
                <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                  <path d="m2 7 6-5 6 5M4 6v8h3v-4h2v4h3V6" />
                </svg>
                {t.homeTab}
              </button>
            </div>
            {visible.map((surface, index) => {
              const selected = !props.homeFocused && surface.id === props.layout.activeSurfaceId;
              const previousSelected =
                index === 0
                  ? props.homeFocused
                  : !props.homeFocused && visible[index - 1].id === props.layout.activeSurfaceId;
              return (
                <Fragment key={surface.id}>
                  {!selected && !previousSelected && (
                    <span
                      data-v2-tab-separator=""
                      aria-hidden="true"
                      className="mx-1 h-[18px] w-px shrink-0 border-0 bg-[var(--shell-muted)] opacity-[0.45]"
                    />
                  )}
                  <V2WorkbenchTab surface={surface} displayTitle={labels.get(surface.id)} props={props} />
                </Fragment>
              );
            })}
          </div>
          {(measuring || overflow.length > 0) && (
            <V2WorkspaceMenu
              width={256}
              trigger={
                <>
                  {t.moreTabs(measuring ? surfaces.length : overflow.length)} <span aria-hidden="true">⌄</span>
                </>
              }
              triggerProps={{
                className: `list-none w-max whitespace-nowrap cursor-pointer rounded px-1 py-2 text-xs text-cafe-secondary hover:bg-cafe-surface-sunken ${measuring ? 'absolute invisible' : ''}`,
                'data-testid': 'v2-more-tabs',
              }}
            >
              {(close) => (
                <>
                  {overflow.map((surface) => (
                    <V2WorkbenchTab
                      key={surface.id}
                      surface={surface}
                      displayTitle={labels.get(surface.id)}
                      props={props}
                      menu
                      onDone={close}
                    />
                  ))}
                </>
              )}
            </V2WorkspaceMenu>
          )}
        </div>
      )}
    </WorkbenchTabFocusContinuity>
  );
}
