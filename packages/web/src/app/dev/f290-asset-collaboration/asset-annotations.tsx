import {
  type AssetCollaborationAction,
  type AssetCollaborationState,
  selectAnnotationCount,
  selectCurrentVersion,
} from './asset-collaboration-store';

interface AssetAnnotationsProps {
  state: AssetCollaborationState;
  dispatch: (action: AssetCollaborationAction) => void;
  onSend: () => void;
}

export function AssetAnnotations({ state, dispatch, onSend }: AssetAnnotationsProps) {
  const section = selectCurrentVersion(state).sections.find((candidate) => candidate.id === state.ui.selectedSectionId);
  if (!section) return null;
  const annotations = state.annotations.filter((annotation) => annotation.sectionId === section.id);
  const draft = state.ui.annotationDrafts[section.id] ?? '';

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="逐段批注">
      <header className="border-b border-cafe-subtle px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-semibold text-cafe-black">{section.title}</h2>
          <span
            className="rounded-full bg-cafe-surface-sunken px-2 py-0.5 text-micro text-cafe-muted"
            data-section-annotation-count={section.id}
          >
            {selectAnnotationCount(state, section.id)} 条批注
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-micro leading-5 text-cafe-muted">{section.body}</p>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {annotations.map((annotation) => {
          const active = annotation.id === state.ui.activeAnnotationId;
          return (
            <article
              key={annotation.id}
              data-active-annotation={active ? annotation.id : undefined}
              className={`rounded-xl p-3 ${
                active ? 'bg-cafe-crosspost/[0.08] ring-1 ring-cafe-crosspost/25' : 'bg-cafe-surface-elevated'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-cafe-black">{annotation.author}</span>
                <span className="text-micro text-cafe-muted">
                  {annotation.createdAt.slice(5, 16).replace('T', ' ')}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-6 text-cafe-secondary">{annotation.body}</p>
            </article>
          );
        })}
      </div>

      <div className="border-t border-cafe-subtle bg-cafe-surface p-3">
        <textarea
          aria-label={`给“${section.title}”添加批注`}
          value={draft}
          onChange={(event) =>
            dispatch({ type: 'set_annotation_draft', sectionId: section.id, value: event.currentTarget.value })
          }
          placeholder="回应这段原文…"
          className="min-h-24 w-full resize-y rounded-xl border border-cafe bg-cafe-surface px-3 py-2 text-xs leading-6 text-cafe outline-none focus:border-cafe-crosspost"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: 'cancel_annotation', sectionId: section.id })}
            className="rounded-lg border border-cafe px-3 py-1.5 text-micro font-medium text-cafe-secondary"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={!draft.trim()}
            className="rounded-lg bg-cafe-crosspost px-3 py-1.5 text-micro font-semibold text-[var(--cafe-accent-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送批注
          </button>
        </div>
      </div>
    </section>
  );
}
