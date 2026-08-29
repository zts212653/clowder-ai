'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { WorkspaceSurfaceHeader } from '@/components/workspace/WorkspaceSurfaceHeader';
import {
  type AssetCollaborationState,
  selectCurrentVersion,
  selectPendingSuggestionCount,
  selectSuggestionAcceptBlock,
  selectVisibleVersion,
} from './asset-collaboration-store';
import { AssetDocument } from './asset-document';
import { AssetSidebar } from './asset-sidebar';
import { AssetSuggestion } from './asset-suggestion';
import { useAssetCollaborationStore } from './use-asset-collaboration-store';

function mutationId(kind: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-${suffix}`;
}

function mutationTime(): string {
  return new Date().toISOString();
}

interface F290AssetCollaborationProps {
  embedded?: boolean;
  compact?: boolean;
  initialState?: AssetCollaborationState;
  storageKey?: string;
  surfaceActions?: ReactNode;
}

export function F290AssetCollaboration({
  embedded = false,
  compact = false,
  initialState,
  storageKey,
  surfaceActions,
}: F290AssetCollaborationProps = {}) {
  const { state, dispatch, persistenceStatus } = useAssetCollaborationStore({ initialState, storageKey });
  const documentScrollRef = useRef<HTMLDivElement>(null);
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const currentVersion = selectCurrentVersion(state);
  const visibleVersion = selectVisibleVersion(state);
  const suggestion = state.suggestions[0];
  const suggestionAcceptBlock = suggestion ? selectSuggestionAcceptBlock(state, suggestion) : null;
  const suggestionAcceptBlockedReason =
    suggestionAcceptBlock === 'editing'
      ? '请先保存或取消当前编辑，再处理这条修改建议。'
      : suggestionAcceptBlock === 'stale'
        ? '正文已产生新版本，请基于当前内容重新提出修改。'
        : undefined;

  useEffect(() => {
    if (documentScrollRef.current) documentScrollRef.current.scrollTop = state.ui.scroll.document;
  }, [state.ui.scroll.document]);

  useEffect(() => {
    if (sidebarScrollRef.current) sidebarScrollRef.current.scrollTop = state.ui.scroll.sidebar;
  }, [state.ui.scroll.sidebar]);

  function sendAnnotation() {
    const sectionId = state.ui.selectedSectionId;
    dispatch({
      type: 'add_annotation',
      sectionId,
      id: mutationId('annotation'),
      historyId: mutationId('history'),
      body: state.ui.annotationDrafts[sectionId] ?? '',
      at: mutationTime(),
    });
  }

  function sendDiscussion() {
    dispatch({
      type: 'add_discussion',
      id: mutationId('discussion'),
      historyId: mutationId('history'),
      body: state.ui.discussionDraft,
      at: mutationTime(),
    });
  }

  function saveEdit() {
    dispatch({
      type: 'save_edit',
      versionId: mutationId('version'),
      historyId: mutationId('history'),
      at: mutationTime(),
    });
  }

  function acceptSuggestion() {
    if (!suggestion) return;
    dispatch({
      type: 'accept_suggestion',
      suggestionId: suggestion.id,
      versionId: mutationId('version'),
      historyId: mutationId('history'),
      at: mutationTime(),
    });
  }

  function disagreeWithSuggestion() {
    if (!suggestion) return;
    dispatch({
      type: 'disagree_suggestion',
      suggestionId: suggestion.id,
      historyId: mutationId('history'),
      reason: state.ui.disagreementDraft,
      at: mutationTime(),
    });
  }

  const actionState = state.ui.isEditing
    ? '正在编辑当前产物'
    : selectPendingSuggestionCount(state) > 0
      ? `${selectPendingSuggestionCount(state)} 处修改等你确认`
      : '当前无需处理';

  const surface = (
    <>
      <WorkspaceSurfaceHeader
        title="资产协作"
        detail={`${state.asset.title} · 当前版本 v${currentVersion.number}`}
        active
        actions={
          <div className="flex items-center gap-3 text-right">
            {surfaceActions}
            <div>
              <p className="text-micro font-medium text-cafe-secondary">{actionState}</p>
              <p className={`text-micro ${persistenceStatus === 'saved' ? 'text-cafe-muted' : 'text-cafe-warning'}`}>
                {persistenceStatus === 'saved' ? '本次体验数据保存在此浏览器' : '暂时无法保存到此浏览器'}
              </p>
            </div>
          </div>
        }
      />

      <div className={`grid min-h-0 flex-1 ${compact ? 'grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_370px]'}`}>
        <div
          ref={documentScrollRef}
          data-testid="asset-document-scroll"
          onScroll={(event) =>
            dispatch({ type: 'set_scroll', surface: 'document', value: event.currentTarget.scrollTop })
          }
          className={`min-h-[680px] overflow-y-auto ${
            state.ui.isEditing ? 'border-inset border-2 border-cafe-interactive/25 bg-cafe-surface-elevated' : ''
          }`}
        >
          <AssetDocument state={state} version={visibleVersion} dispatch={dispatch} onSave={saveEdit} />
          {suggestion && (
            <AssetSuggestion
              suggestion={suggestion}
              dispatch={dispatch}
              onAccept={acceptSuggestion}
              onDisagree={disagreeWithSuggestion}
              disagreementDraft={state.ui.disagreementDraft}
              acceptBlockedReason={suggestionAcceptBlockedReason}
            />
          )}
        </div>

        {!compact && (
          <AssetSidebar
            state={state}
            dispatch={dispatch}
            onSendAnnotation={sendAnnotation}
            onSendDiscussion={sendDiscussion}
            scrollRef={sidebarScrollRef}
            onScroll={(event) =>
              dispatch({ type: 'set_scroll', surface: 'sidebar', value: event.currentTarget.scrollTop })
            }
          />
        )}
      </div>
    </>
  );

  if (embedded) {
    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-cafe-surface" data-asset-host="embedded">
        {surface}
      </section>
    );
  }

  return (
    <main
      className="min-h-screen bg-cafe-surface-canvas p-3 text-cafe sm:p-5 lg:p-7 lg:pr-56"
      data-testid="asset-stage"
      data-concierge-safe-edge="right"
    >
      <section className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-[1440px] flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-[var(--console-shadow-soft)]">
        {surface}
      </section>
    </main>
  );
}
