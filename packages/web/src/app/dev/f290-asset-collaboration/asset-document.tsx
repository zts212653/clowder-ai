import type { AssetCollaborationAction, AssetCollaborationState, AssetVersion } from './asset-collaboration-store';

interface AssetDocumentProps {
  state: AssetCollaborationState;
  version: AssetVersion;
  dispatch: (action: AssetCollaborationAction) => void;
  onSave: () => void;
}

export function AssetDocument({ state, version, dispatch, onSave }: AssetDocumentProps) {
  const viewingSnapshot = Boolean(state.ui.viewingVersionId);

  return (
    <article
      className="mx-auto max-w-3xl px-6 py-8 sm:px-10 sm:py-12"
      data-testid="asset-document"
      data-viewing-version={viewingSnapshot ? version.id : undefined}
    >
      {viewingSnapshot && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-cafe-interactive/25 bg-cafe-surface-elevated px-4 py-3">
          <p className="text-xs text-cafe-secondary">正在回看 v{version.number}，当前产物没有被改动。</p>
          <button
            type="button"
            onClick={() => dispatch({ type: 'return_to_current_version' })}
            className="text-xs font-semibold text-cafe-interactive hover:underline"
          >
            返回当前版本
          </button>
        </div>
      )}

      <header className="border-b border-cafe-subtle pb-7">
        <div className="flex flex-wrap items-center gap-2 text-micro font-medium text-cafe-muted">
          <span className="rounded-full bg-cafe-surface-sunken px-2.5 py-1" data-testid="asset-version">
            {viewingSnapshot ? '回看版本' : '当前版本'} · v{version.number}
          </span>
          <span>{state.asset.origin}</span>
          <span>更新于 {state.asset.updatedAt.slice(0, 16).replace('T', ' ')}</span>
        </div>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-cafe-black sm:text-3xl">{state.asset.title}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-cafe-secondary">{state.asset.summary}</p>
          </div>
          {!state.ui.isEditing && !viewingSnapshot && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'start_edit' })}
              className="rounded-lg border border-cafe px-3.5 py-2 text-xs font-semibold text-cafe-secondary hover:bg-cafe-surface-sunken"
            >
              编辑产物
            </button>
          )}
        </div>
      </header>

      <div className="space-y-9 py-8">
        {version.sections.map((section, index) => {
          const selected = section.id === state.ui.selectedSectionId;
          return (
            <section
              key={section.id}
              className={`grid gap-3 rounded-xl px-3 py-2 sm:grid-cols-[32px_1fr_auto] ${
                selected ? 'bg-cafe-crosspost/[0.055] ring-1 ring-cafe-crosspost/20' : ''
              }`}
              data-selected-section={selected ? section.id : undefined}
            >
              <span className="pt-1 font-mono text-micro text-cafe-muted">0{index + 1}</span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-cafe-black">{section.title}</h2>
                {state.ui.isEditing ? (
                  <textarea
                    aria-label={`编辑“${section.title}”正文`}
                    value={state.ui.editDrafts[section.id] ?? section.body}
                    onChange={(event) =>
                      dispatch({ type: 'set_edit_draft', sectionId: section.id, value: event.currentTarget.value })
                    }
                    className="mt-2 min-h-32 w-full resize-y rounded-xl border-2 border-cafe-interactive/25 bg-cafe-surface px-3 py-2 text-sm leading-7 text-cafe-secondary outline-none focus:border-cafe-interactive/60"
                  />
                ) : (
                  <p className="mt-2 text-sm leading-7 text-cafe-secondary" data-section-body={section.id}>
                    {section.body}
                  </p>
                )}
              </div>
              {!state.ui.isEditing && !viewingSnapshot && (
                <button
                  type="button"
                  data-annotate-section={section.id}
                  onClick={() => dispatch({ type: 'select_section', sectionId: section.id })}
                  className="self-start rounded-lg px-2.5 py-1.5 text-micro font-semibold text-cafe-crosspost hover:bg-cafe-crosspost/10"
                >
                  批注
                </button>
              )}
            </section>
          );
        })}
      </div>

      {state.ui.isEditing && (
        <div className="flex justify-end gap-2 border-t border-cafe-subtle pt-5">
          <button
            type="button"
            onClick={() => dispatch({ type: 'cancel_edit' })}
            className="rounded-lg border border-cafe px-3.5 py-2 text-xs font-medium text-cafe-secondary"
          >
            取消编辑
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-lg bg-cafe-interactive px-3.5 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)]"
          >
            保存新版本
          </button>
        </div>
      )}

      <footer className="mt-5 border-t border-cafe-subtle pt-5 text-micro text-cafe-muted">
        来源：{state.asset.origin}
      </footer>
    </article>
  );
}
