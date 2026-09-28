import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { WorkspaceOfficeSurface } from '../WorkspaceOfficeSurface';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../ContentEditorOwnerSurface', () => ({
  ContentEditorOwnerSurface: ({ target }: { target: { sessionRef: string } }) => (
    <textarea data-testid="local-editor" defaultValue={target.sessionRef} />
  ),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ contentRef: 'doc', sessionRef: `session-${vi.mocked(apiFetch).mock.calls.length}` }),
        ),
    );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === label);
  if (!found) throw new Error(`Missing action: ${label}`);
  return found;
}

it('keeps local edits on cancelled reopen and discards them only after the explicit saved-version choice', async () => {
  await act(async () => root.render(<WorkspaceOfficeSurface worktreeId="wt" path="sample.docx" />));
  const editor = container.querySelector('textarea');
  expect(editor).not.toBeNull();
  if (!editor) throw new Error('editor missing');
  editor.value = 'unsaved local draft';
  await act(async () => button('重新打开').click());
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('未保存的修改会被丢弃');
  expect(container.querySelector('textarea')).toBe(editor);
  await act(async () => button('保留当前编辑').click());
  expect(editor.value).toBe('unsaved local draft');
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(async () => button('重新打开').click());
  await act(async () => button('丢弃修改并重新打开').click());
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('textarea')).not.toBe(editor);
  expect(container.querySelector('textarea')?.value).toBe('session-2');
});
