// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import type { F307WorkbenchTabsProps } from '../F307WorkbenchTabs';
import { createFilePreviewSurface, createWorkspaceModeSurface } from '../real-surface-adapters';
import { V2WorkbenchTab } from '../V2WorkbenchTab';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { createInitialWorkbenchState } from '../workbench-model';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(surface: WorkspaceSurfaceDescriptor, menu = false): F307WorkbenchTabsProps {
  const props: F307WorkbenchTabsProps = {
    layout: createInitialWorkbenchState([surface]),
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
  act(() => root.render(<V2WorkbenchTab surface={surface} props={props} menu={menu} />));
  return props;
}

it.each([
  ['schedule', 'grid', false],
  ['schedule', 'grid', true],
  ['eval', 'checkSquare', false],
  ['eval', 'checkSquare', true],
] as const)('shows %s glyph %s in inline/overflow tabs (menu=%s)', (mode, icon, menu) => {
  const surface = createWorkspaceModeSurface(mode, 'thread-code');
  const before = JSON.stringify(surface);
  const props = render(surface, menu);
  const reference = document.createElement('div');
  reference.innerHTML = renderToStaticMarkup(<ShellGlyph name={icon} />);
  // The actual catalogue glyph is the contract; SVG classes and sizing can vary by host.
  expect(host.querySelector('svg')?.innerHTML).toBe(reference.querySelector('svg')?.innerHTML);
  act(() => host.querySelector<HTMLButtonElement>('[data-workbench-tab-control="activate"]')?.click());
  expect(props.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'activate-surface', surfaceId: surface.id }),
  );
  expect(JSON.stringify(surface)).toBe(before);
});

it('keeps a similarly named file and an invalid owner out of the tools catalogue', () => {
  const file = createFilePreviewSurface({ worktreeId: 'owned', path: 'mode:eval' });
  render(file);
  const fileGlyph = host.querySelector('svg')?.innerHTML;
  const evalSurface = createWorkspaceModeSurface('eval', 'thread-code');
  const invalid = { ...evalSurface, resultTargetRef: { owner: 'wrong-owner', key: 'wrong' } };
  render(invalid);
  expect(host.querySelector('svg')?.innerHTML).toBe(fileGlyph);
});
