import type { RefObject, UIEvent } from 'react';
import { AssetAnnotations } from './asset-annotations';
import {
  type AssetCollaborationAction,
  type AssetCollaborationState,
  type AssetPanel,
  selectAnnotationCount,
  selectPendingSuggestionCount,
} from './asset-collaboration-store';
import { AssetDiscussion } from './asset-discussion';
import { AssetHistory } from './asset-history';

interface AssetSidebarProps {
  state: AssetCollaborationState;
  dispatch: (action: AssetCollaborationAction) => void;
  onSendAnnotation: () => void;
  onSendDiscussion: () => void;
  scrollRef: RefObject<HTMLDivElement>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
}

const PANELS: Array<{ id: AssetPanel; label: string }> = [
  { id: 'annotations', label: '批注' },
  { id: 'discussion', label: '讨论' },
  { id: 'history', label: '历程' },
];

export function AssetSidebar({
  state,
  dispatch,
  onSendAnnotation,
  onSendDiscussion,
  scrollRef,
  onScroll,
}: AssetSidebarProps) {
  return (
    <aside
      className="flex min-h-0 flex-col border-l border-cafe-subtle bg-cafe-surface-elevated/45"
      aria-label="协作工作面"
    >
      <header className="border-b border-cafe-subtle bg-cafe-surface px-3 py-3">
        <div className="mb-2 flex items-center gap-3 text-micro text-cafe-muted">
          <span>
            <strong className="font-semibold text-cafe-secondary" data-testid="annotation-total">
              {selectAnnotationCount(state)}
            </strong>{' '}
            条批注
          </span>
          <span>
            <strong className="font-semibold text-cafe-secondary" data-testid="history-total">
              {state.history.length}
            </strong>{' '}
            条历程
          </span>
          <span className="ml-auto" data-testid="pending-suggestion-count">
            {selectPendingSuggestionCount(state)} 处待确认
          </span>
        </div>
        <nav className="grid grid-cols-3 rounded-xl bg-cafe-surface-sunken p-1" aria-label="协作内容">
          {PANELS.map((panel) => (
            <button
              key={panel.id}
              type="button"
              aria-pressed={state.ui.panel === panel.id}
              onClick={() => dispatch({ type: 'set_panel', panel: panel.id })}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                state.ui.panel === panel.id
                  ? 'bg-cafe-surface text-cafe-black shadow-sm'
                  : 'text-cafe-muted hover:text-cafe-secondary'
              }`}
            >
              {panel.label}
            </button>
          ))}
        </nav>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {state.ui.panel === 'annotations' && (
          <AssetAnnotations state={state} dispatch={dispatch} onSend={onSendAnnotation} />
        )}
        {state.ui.panel === 'discussion' && (
          <AssetDiscussion state={state} dispatch={dispatch} onSend={onSendDiscussion} />
        )}
        {state.ui.panel === 'history' && <AssetHistory state={state} dispatch={dispatch} />}
      </div>
    </aside>
  );
}
