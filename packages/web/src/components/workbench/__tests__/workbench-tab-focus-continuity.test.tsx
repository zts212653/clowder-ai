// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { F307WorkbenchTabs } from '../F307WorkbenchTabs';
import { createFileSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState, reduceWorkbench } from '../workbench-model';

let host: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof F307WorkbenchTabs>;
const origin = { kind: 'workspace-home-search' as const, query: 'DESIGN.md' };
const alias = createFileSurface({ worktreeId: 'wt-alias', path: 'DESIGN.md', navigationOrigin: origin });
const canonical = createFileSurface({
  worktreeId: `f063_root_v1_${'a'.repeat(64)}`,
  path: 'DESIGN.md',
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 320, 32),
  ] as unknown as DOMRectList);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  props = {
    hostThreadId: 'thread-a',
    layout: createInitialWorkbenchState([alias]),
    dispatch: vi.fn(),
    onAddSurface: vi.fn(),
    onActivateSurface: vi.fn(),
    homeFocused: false,
    isDesktop: true,
    artifactWorkHostAvailable: false,
    mainAreaAttentionSurfaceId: null,
    onEnterMainAreaAttention: vi.fn(),
    onExitMainAreaAttention: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  writeShellPresentation('classic');
});

function control(name: string) {
  const element = host.querySelector<HTMLButtonElement>(`[data-workbench-tab-control="${name}"]`);
  if (!element) throw new Error(`Missing original ${name} control`);
  return element;
}

function resolve() {
  props = {
    ...props,
    layout: reduceWorkbench(props.layout, {
      type: 'resolve-content-surface',
      sourceSurfaceId: alias.id,
      surface: canonical,
    }),
  };
}

it.each([
  'classic',
  'v2',
] as const)('retains the focused Pin across the real accepted alias resolution in %s', (shell) => {
  writeShellPresentation(shell);
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const before = control('pin');
  before.focus();
  expect(document.activeElement).toBe(before);
  resolve();
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  expect(before.isConnected).toBe(false);
  expect(document.activeElement).toBe(control('pin'));
  act(() => control('pin').click());
  expect(props.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'pin-surface', surfaceId: canonical.id, pinned: true }),
  );
});

it.each([
  'activate',
  'close',
  'move-left',
])('retains the other original %s tab control through the same resolution', (name) => {
  writeShellPresentation('classic');
  if (name === 'move-left')
    props.layout = createInitialWorkbenchState([createFileSurface({ worktreeId: 'other', path: 'README.md' }), alias]);
  props.layout.activeSurfaceId = alias.id;
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const before = Array.from(host.querySelectorAll<HTMLButtonElement>(`[data-workbench-tab-control="${name}"]`)).find(
    (node) => node.closest<HTMLElement>('[data-tab-surface-id]')?.dataset.tabSurfaceId === alias.id,
  );
  if (!before) throw new Error('Missing source control');
  before.focus();
  resolve();
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const after = document.activeElement;
  expect(after).not.toBe(before);
  expect((after as HTMLElement).dataset.workbenchTabControl).toBe(name);
  expect(after?.closest<HTMLElement>('[data-tab-surface-id]')?.dataset.tabSurfaceId).toBe(canonical.id);
});

it('returns focus to the existing canonical tab when the original reducer merges the alias into it', () => {
  writeShellPresentation('classic');
  props.layout = createInitialWorkbenchState([alias, canonical]);
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const before = control('pin');
  const retained = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-workbench-tab-control="pin"]')).find(
    (node) => node.closest<HTMLElement>('[data-tab-surface-id]')?.dataset.tabSurfaceId === canonical.id,
  );
  before.focus();
  resolve();
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  expect(before.isConnected).toBe(false);
  expect(document.activeElement).toBe(retained);
  expect(props.layout.surfaces).toHaveLength(1);
});

it('retains the focused control inside the same explicitly owned v2 overflow portal', () => {
  writeShellPresentation('v2');
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 130, 32));
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  const menu = host.querySelector('[data-testid="v2-more-tabs"]')?.closest('details');
  if (!menu) throw new Error('The narrow original header must provide its overflow menu');
  act(() => {
    menu.open = true;
    menu.dispatchEvent(new Event('toggle'));
  });
  const pin = () =>
    document.querySelector<HTMLButtonElement>(
      '[data-v2-workspace-menu]:not([hidden]) [data-workbench-tab-control="pin"]',
    );
  const before = pin();
  if (!before) throw new Error('Missing original overflow Pin');
  before.focus();
  resolve();
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  expect(before.isConnected).toBe(false);
  expect(document.activeElement).toBe(pin());
  expect(menu.open).toBe(true);
});

it.each([
  'thread',
  'home',
  'different-file',
  'foreign-origin',
  'external-focus',
  'close',
  'unresolved-target',
  'other-canonical-root',
])('does not transfer the old gesture after %s invalidates it', (change) => {
  writeShellPresentation('classic');
  if (change === 'other-canonical-root')
    props.layout = createInitialWorkbenchState([{ ...canonical, navigationOrigin: origin }]);
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  control('pin').focus();
  if (change === 'external-focus') {
    const input = document.createElement('input');
    host.append(input);
    input.focus();
  }
  resolve();
  if (change === 'thread') props.hostThreadId = 'thread-b';
  if (change === 'home') props.homeFocused = true;
  if (change === 'different-file')
    props.layout.surfaces = [createFileSurface({ worktreeId: canonical.ownerStateRef.key, path: 'OTHER.md' })];
  if (change === 'foreign-origin')
    props.layout.surfaces = [{ ...props.layout.surfaces[0], navigationOrigin: { ...origin } }];
  if (change === 'unresolved-target' || change === 'other-canonical-root')
    props.layout = createInitialWorkbenchState([
      createFileSurface({
        worktreeId: change === 'unresolved-target' ? 'wt-other' : `f063_root_v1_${'b'.repeat(64)}`,
        path: 'DESIGN.md',
        navigationOrigin: origin,
      }),
    ]);
  if (change === 'close') props.layout = createInitialWorkbenchState();
  act(() => root.render(<F307WorkbenchTabs {...props} />));
  expect(document.activeElement?.closest('[data-tab-surface-id]')).toBeNull();
});
