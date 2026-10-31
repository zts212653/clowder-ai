import { needsNewModificationSelection } from './modification-draft-scope';
import type { ContentModificationModel } from './useContentModification';

export function ModificationScopeRecovery({ model }: { model: ContentModificationModel }) {
  const { draft } = model;
  return (
    <>
      {model.sourceChanged && !draft.operation && !draft.requestId ? (
        <div className="space-y-2 text-xs">
          <p role="alert" className="text-cafe-error">
            作品已换版本，修改说明与旧版选区仍保留；旧坐标不会自动套到新版。
          </p>
          {needsNewModificationSelection(draft) && !model.canUseCurrentSource ? (
            <p className="text-cafe-muted">请先在当前作品选择范围，再点“请猫修改”核对该选区。</p>
          ) : null}
          <button
            type="button"
            data-testid="content-modification-use-current-version"
            disabled={model.busy || !model.ready || !model.canUseCurrentSource}
            className="rounded border border-cafe-subtle px-2 py-1 text-cafe-accent disabled:opacity-50"
            onClick={model.useCurrentSource}
          >
            {needsNewModificationSelection(draft) ? '沿用说明，使用当前版本与选区' : '沿用说明，使用当前版本'}
          </button>
        </div>
      ) : null}
      {draft.previousScopes?.length ? (
        <details className="text-xs text-cafe-muted">
          <summary>此作品保留的旧版选区</summary>
          <p>来自此前草稿，仅供核对，不作为当前请求的选区。</p>
          {draft.previousScopes.map((scope, index) => (
            <div key={`${scope.sourceVersion}:${index}`} className="mt-2">
              <p>
                {model.choices?.cats.find((item) => item.catId === scope.targetCatId)?.name ?? scope.targetCatId} ·{' '}
                {model.choices?.threads.find((item) => item.threadId === scope.threadId)?.title ?? scope.threadId}
              </p>
              <p className="break-all">{scope.sourceVersion}</p>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(scope.intent ?? {}, null, 2)}</pre>
            </div>
          ))}
        </details>
      ) : null}
    </>
  );
}
