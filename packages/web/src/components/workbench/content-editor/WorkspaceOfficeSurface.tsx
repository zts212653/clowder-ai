'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiFetch } from '@/utils/api-client';
import { ContentEditorOwnerSurface } from './ContentEditorOwnerSurface';

const EXPLANATIONS: Readonly<Record<string, string>> = {
  plugin_not_installed: '先在插件设置中安装 GenOffice，再回来打开这份文档。',
  plugin_disabled: 'GenOffice 已安装。请在插件设置中启用，然后重试。',
  plugin_stopped: 'GenOffice 当前未运行。请在插件设置中修复或重新启用，然后重试。',
  provider_selection_required: '有多个文档编辑插件可用。请在插件设置中保留你要使用的插件。',
  unsupported_format: '当前安装的编辑器还不支持这个格式。',
  identity_required: '请先登录，再打开文档。',
};

interface EditorTarget {
  readonly contentRef: string;
  readonly sessionRef: string;
}

/** The F063 source is imported once; subsequent opens resume the durable content owner. */
export function WorkspaceOfficeSurface({ worktreeId, path }: { readonly worktreeId: string; readonly path: string }) {
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const open = useCallback(() => setAttempt((value) => value + 1), []);
  const requestOpen = () => (target ? setConfirmReopen(true) : open());

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setConfirmReopen(false);
    setError(null);
    setTarget(null);
    void apiFetch('/api/workspace/content-editor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worktreeId, path }),
      signal: abort.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(typeof body.error?.code === 'string' ? body.error.code : 'document_unavailable');
        if (typeof body.contentRef !== 'string' || typeof body.sessionRef !== 'string')
          throw new Error('document_unavailable');
        if (!abort.signal.aborted) setTarget({ contentRef: body.contentRef, sessionRef: body.sessionRef });
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'document_unavailable');
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [attempt, path, worktreeId]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="workspace-office-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cafe-border px-4 py-2 text-xs text-cafe-muted">
        <span>{path.split('/').at(-1)} · 协作版本</span>
        <button type="button" className="text-cafe-accent hover:underline" onClick={requestOpen} disabled={loading}>
          重新打开
        </button>
      </div>
      {target ? (
        <ContentEditorOwnerSurface target={target} onRetry={requestOpen} />
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <div className="max-w-sm space-y-3">
            <p className="text-sm font-semibold text-cafe">{loading ? '正在打开文档…' : '在 GenOffice 中协作'}</p>
            <p className="text-xs leading-5 text-cafe-muted">
              {error
                ? (EXPLANATIONS[error] ?? '文档暂时无法打开。请确认文件仍在工作区，或稍后重试。')
                : '首次打开会导入工作区文件，编辑保存在同一份协作版本中。再次打开会恢复已保存的内容。'}
            </p>
            {!loading && (
              <div className="flex flex-wrap justify-center gap-4">
                <button type="button" onClick={open} className="rounded-lg bg-cafe-accent px-4 py-2 text-sm text-white">
                  {error ? '重试' : '打开协作版本'}
                </button>
                {error && (
                  <a href="/settings?s=plugins" className="self-center text-sm text-cafe-accent hover:underline">
                    打开插件设置
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmReopen}
        title="打开已保存的版本？"
        message="当前编辑器中未保存的修改会被丢弃。你可以先保留当前编辑，或明确丢弃修改后重新打开已保存的版本。"
        confirmLabel="丢弃修改并重新打开"
        cancelLabel="保留当前编辑"
        variant="danger"
        onCancel={() => setConfirmReopen(false)}
        onConfirm={() => {
          setConfirmReopen(false);
          open();
        }}
      />
    </div>
  );
}
