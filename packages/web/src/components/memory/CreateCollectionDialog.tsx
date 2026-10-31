'use client';
import { useEffect, useRef } from 'react';
import { LIBRARY_KINDS, libraryVisibility } from './page/library-labels';
import { useCollectionCreation } from './use-collection-creation';

const KINDS = ['project', 'world', 'domain', 'research', 'global'];
const VISIBILITIES = ['public', 'internal', 'private', 'restricted'];
const fieldClass =
  'mt-1 block w-full rounded-lg border border-cafe-subtle bg-[var(--console-field-bg)] px-3 py-2 text-sm text-cafe-secondary outline-none transition focus:ring-1 focus:ring-[var(--console-input-stroke)] disabled:opacity-60';
const buttonClass = 'rounded-lg border border-cafe-subtle px-3 py-2 text-compact disabled:opacity-50';

function wrapDialogFocus(element: HTMLDivElement | null, event: KeyboardEvent) {
  const elements = [
    ...(element?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)') ??
      []),
  ];
  if (!elements.length) {
    event.preventDefault();
    element?.focus();
    return;
  }
  const boundary = event.shiftKey ? elements[0] : elements.at(-1);
  if (document.activeElement !== boundary) return;
  event.preventDefault();
  const destination = event.shiftKey ? elements.at(-1) : elements[0];
  destination?.focus();
}
export function CreateCollectionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const state = useCollectionCreation(onCreated);
  const { draft, update, dryRun, scanning, submitting, registered, error } = state;
  const busy = scanning || submitting;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      wrapDialogFocus(dialog.current, event);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-light)] p-4 backdrop-blur-sm"
      data-testid="create-collection-dialog"
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-library-title"
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-xl bg-[var(--console-card-bg)] shadow-lg"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void state.submit();
          }}
        >
          <div className="space-y-4 p-6">
            <h3 id="create-library-title" className="text-base font-medium text-cafe">
              新建资料库
            </h3>
            {error && (
              <p role="alert" className="rounded-lg bg-[var(--console-field-bg)] p-3 text-compact text-cafe-secondary">
                {error}
              </p>
            )}
            <fieldset disabled={busy || registered} className="space-y-4 disabled:opacity-70">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-compact text-cafe-secondary">
                  类型
                  <select value={draft.kind} onChange={(e) => update('kind', e.target.value)} className={fieldClass}>
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {LIBRARY_KINDS[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-compact text-cafe-secondary">
                  名称
                  <input
                    aria-label="名称"
                    value={draft.name}
                    onChange={(e) => update('name', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    placeholder="notes"
                    required
                    className={fieldClass}
                  />
                  <span className="mt-1 block text-xs text-cafe-muted">用英文小写、数字或短横线</span>
                </label>
              </div>
              <label className="block text-compact text-cafe-secondary">
                显示名称
                <input
                  value={draft.displayName}
                  onChange={(e) => update('displayName', e.target.value)}
                  placeholder="学习笔记"
                  required
                  className={fieldClass}
                />
              </label>
              <label className="block text-compact text-cafe-secondary">
                根路径<span className="ml-1 text-xs text-cafe-muted">留空则使用托管存储</span>
                <input
                  aria-label="根路径"
                  value={draft.root}
                  onChange={(e) => update('root', e.target.value)}
                  placeholder="填写要接入的本机目录"
                  className={fieldClass}
                />
              </label>
              <label className="block text-compact text-cafe-secondary">
                谁能看见
                <select
                  value={draft.sensitivity}
                  onChange={(e) => update('sensitivity', e.target.value)}
                  className={fieldClass}
                >
                  {VISIBILITIES.map((value) => (
                    <option key={value} value={value}>
                      {libraryVisibility(value)}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <p className="text-compact text-cafe-secondary">
              新建 {draft.displayName.trim() || '资料库'} · {libraryVisibility(draft.sensitivity)}可见
            </p>
            {dryRun && (
              <div
                className="space-y-1 rounded-lg bg-[var(--console-field-bg)] p-3 text-compact"
                data-testid="dry-run-preview"
              >
                <p className="font-medium">扫描预览</p>
                <p>
                  {dryRun.totalFiles} 个文件（{dryRun.markdownFiles} 个 Markdown）
                </p>
                {dryRun.secretFindings > 0 && (
                  <p className="text-conn-amber-text">检测到 {dryRun.secretFindings} 个敏感信息，创建前请核查。</p>
                )}
              </div>
            )}
          </div>
          <footer className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-cafe-subtle bg-[var(--console-card-bg)] p-4">
            <button type="button" onClick={onClose} disabled={busy} className={buttonClass}>
              {registered ? '先关闭' : '取消'}
            </button>
            {draft.root.trim() && !dryRun && (
              <button
                type="button"
                onClick={() => void state.scan()}
                disabled={busy || !draft.name || !draft.displayName.trim()}
                className={buttonClass}
                data-testid="dry-run-btn"
              >
                {scanning ? '扫描中…' : '预览扫描'}
              </button>
            )}
            <button
              type="submit"
              disabled={busy || !draft.name || !draft.displayName.trim() || (!!draft.root.trim() && !dryRun)}
              className={`${buttonClass} bg-cafe-accent text-[var(--cafe-surface)]`}
            >
              {submitting ? '处理中…' : registered ? '重试索引' : '创建'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
