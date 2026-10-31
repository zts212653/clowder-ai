import { EditorView } from 'codemirror';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodeViewer } from '../CodeViewer';
import { workspaceFileDraftKey } from '../workspace-file-draft';

vi.mock('@/utils/api-client', () => ({ apiFetch: async () => new Response(JSON.stringify({ userId: 'operator' })) }));
vi.mock('@/components/SelectionAnnotationAction', () => ({ SelectionAnnotationAction: () => null }));
const container = document.createElement('div');
const root = createRoot(container);
const base = 'original source';
const worktreeId = `f063_root_v1_${'a'.repeat(64)}`;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});
afterEach(() => {
  act(() => root.render(null));
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function render(editable: boolean) {
  await act(async () =>
    root.render(
      <CodeViewer
        content={base}
        baseSha256={'a'.repeat(64)}
        mime="text/plain"
        path="notes.txt"
        worktreeId={worktreeId}
        scrollToLine={null}
        editable={editable}
      />,
    ),
  );
}
function editor() {
  return EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
}

it('preserves typed file edits across leaving edit mode and reopening the original file', async () => {
  await render(true);
  act(() => editor().dispatch({ changes: { from: 0, to: base.length, insert: 'my unsaved changes' } }));
  await render(false);
  await render(true);
  expect(editor().state.doc.toString()).toBe('my unsaved changes');
  act(() => root.render(null));
  await render(true);
  expect(editor().state.doc.toString()).toBe('my unsaved changes');
});

it('keeps a drifted draft separate from the changed file until an explicit new base is chosen', async () => {
  const save = vi.fn(async () => undefined);
  await render(true);
  act(() => editor().dispatch({ changes: { from: 0, to: base.length, insert: 'my pending edit' } }));
  await act(async () =>
    root.render(
      <CodeViewer
        content="changed by another writer"
        baseSha256={'b'.repeat(64)}
        mime="text/plain"
        path="notes.txt"
        worktreeId={worktreeId}
        scrollToLine={null}
        editable
        onSave={save}
      />,
    ),
  );
  expect(editor().state.doc.toString()).toBe('my pending edit');
  expect(container.querySelector('[aria-label="当前文件与编辑草稿对比"]')?.textContent).toContain(
    'changed by another writer',
  );
  expect(container.querySelector('button[title="保存 (Cmd+S)"]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('以当前文件为基准'))!
      .click(),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('button[title="保存 (Cmd+S)"]')!.click());
  expect(save).toHaveBeenCalledWith('my pending edit', { baseSha256: 'b'.repeat(64) });
  const stored = JSON.parse(localStorage.getItem(workspaceFileDraftKey('operator', worktreeId, 'notes.txt'))!);
  expect(stored.priorBases).toEqual(['a'.repeat(64)]);
  expect(stored.text).toBe('my pending edit');
});

it('an unknown save keeps the draft, and a real matching receipt settles only that saved draft', async () => {
  const save = vi
    .fn<() => Promise<{ path: string; sha256: string } | void>>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ path: 'notes.txt', sha256: 'b'.repeat(64) });
  await act(async () =>
    root.render(
      <CodeViewer
        content={base}
        baseSha256={'a'.repeat(64)}
        mime="text/plain"
        path="notes.txt"
        worktreeId={worktreeId}
        scrollToLine={null}
        editable
        onSave={save}
      />,
    ),
  );
  act(() => editor().dispatch({ changes: { from: 0, to: base.length, insert: 'save this draft' } }));
  await act(async () => container.querySelector<HTMLButtonElement>('button[title="保存 (Cmd+S)"]')!.click());
  const key = workspaceFileDraftKey('operator', worktreeId, 'notes.txt');
  expect(JSON.parse(localStorage.getItem(key)!).text).toBe('save this draft');
  await act(async () => container.querySelector<HTMLButtonElement>('button[title="保存 (Cmd+S)"]')!.click());
  expect(localStorage.getItem(key)).toBeNull();
  expect(editor().state.doc.toString()).toBe('save this draft');
});

it('different file owners never inherit each other’s unsaved text', async () => {
  await render(true);
  act(() => editor().dispatch({ changes: { from: 0, to: base.length, insert: 'only root A' } }));
  await act(async () =>
    root.render(
      <CodeViewer
        content={base}
        baseSha256={'a'.repeat(64)}
        mime="text/plain"
        path="notes.txt"
        worktreeId={`f063_root_v1_${'b'.repeat(64)}`}
        scrollToLine={null}
        editable
      />,
    ),
  );
  expect(editor().state.doc.toString()).toBe(base);
  await render(true);
  expect(editor().state.doc.toString()).toBe('only root A');
});

it('typing after Save remains a draft based on that exact successful write', async () => {
  let finish: ((value: { path: string; sha256: string }) => void) | undefined;
  const save = vi.fn(
    () =>
      new Promise<{ path: string; sha256: string }>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <CodeViewer
        content={base}
        baseSha256={'a'.repeat(64)}
        mime="text/plain"
        path="notes.txt"
        worktreeId={worktreeId}
        scrollToLine={null}
        editable
        onSave={save}
      />,
    ),
  );
  act(() => editor().dispatch({ changes: { from: 0, to: base.length, insert: 'saved A' } }));
  await act(async () => container.querySelector<HTMLButtonElement>('button[title="保存 (Cmd+S)"]')!.click());
  act(() => editor().dispatch({ changes: { from: editor().state.doc.length, insert: ' and still typing B' } }));
  await act(async () => finish!({ path: 'notes.txt', sha256: 'b'.repeat(64) }));
  const stored = JSON.parse(localStorage.getItem(workspaceFileDraftKey('operator', worktreeId, 'notes.txt'))!);
  expect(stored.text).toBe('saved A and still typing B');
  expect(stored.baseSha256).toBe('b'.repeat(64));
  await act(async () =>
    root.render(
      <CodeViewer
        content="saved A"
        baseSha256={'b'.repeat(64)}
        mime="text/plain"
        path="notes.txt"
        worktreeId={worktreeId}
        scrollToLine={null}
        editable
        onSave={save}
      />,
    ),
  );
  expect(editor().state.doc.toString()).toBe('saved A and still typing B');
});

it('quota failure keeps the visible edits, and retry persists them before the file is reopened', async () => {
  await render(true);
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError');
  });
  try {
    act(() => editor().dispatch({ changes: { from: 0, to: base.length, insert: 'keep this text' } }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('尚未保存成功');
    await render(false);
    expect(editor().state.doc.toString()).toBe(base);
    expect(container.textContent).toContain('keep this text');
  } finally {
    save.mockRestore();
  }
  await act(async () =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === '重试保存草稿')!.click(),
  );
  act(() => root.render(null));
  await render(true);
  expect(editor().state.doc.toString()).toBe('keep this text');
});
