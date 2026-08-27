import type { AssetCollaborationAction, AssetCollaborationState } from './asset-collaboration-store';

interface AssetDiscussionProps {
  state: AssetCollaborationState;
  dispatch: (action: AssetCollaborationAction) => void;
  onSend: () => void;
}

export function AssetDiscussion({ state, dispatch, onSend }: AssetDiscussionProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="整份产物讨论">
      <header className="border-b border-cafe-subtle px-4 py-3.5">
        <h2 className="text-xs font-semibold text-cafe-black">围绕整份产物讨论</h2>
        <p className="mt-1 text-micro leading-5 text-cafe-muted">不属于某一段的想法放在这里。</p>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {state.discussions.map((message) => {
          const active = message.id === state.ui.activeDiscussionId;
          return (
            <article
              key={message.id}
              data-discussion-message
              className={`rounded-xl p-3 ${
                active ? 'bg-cafe-crosspost/[0.08] ring-1 ring-cafe-crosspost/25' : 'bg-cafe-surface-elevated'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-cafe-black">{message.author}</span>
                <span className="text-micro text-cafe-muted">{message.createdAt.slice(5, 16).replace('T', ' ')}</span>
              </div>
              <p className="mt-1.5 text-xs leading-6 text-cafe-secondary">{message.body}</p>
            </article>
          );
        })}
      </div>

      <div className="border-t border-cafe-subtle bg-cafe-surface p-3">
        <label className="text-micro font-medium text-cafe-muted" htmlFor="asset-discussion-draft">
          以 {state.currentIdentity} 身份发送
        </label>
        <textarea
          id="asset-discussion-draft"
          aria-label="围绕整份产物讨论"
          value={state.ui.discussionDraft}
          onChange={(event) => dispatch({ type: 'set_discussion_draft', value: event.currentTarget.value })}
          placeholder="补充一个与整份产物有关的想法…"
          className="mt-2 min-h-24 w-full resize-y rounded-xl border border-cafe bg-cafe-surface px-3 py-2 text-xs leading-6 text-cafe outline-none focus:border-cafe-interactive"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onSend}
            disabled={!state.ui.discussionDraft.trim()}
            className="rounded-lg bg-cafe-interactive px-3 py-1.5 text-micro font-semibold text-[var(--cafe-accent-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送讨论
          </button>
        </div>
      </div>
    </section>
  );
}
