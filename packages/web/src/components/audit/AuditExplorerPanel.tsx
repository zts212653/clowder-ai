'use client';

import React, { useCallback, useState } from 'react';
import { AuditEventsTab } from './AuditEventsTab';
import { SessionEventsViewer } from './SessionEventsViewer';
import { SessionSearchTab } from './SessionSearchTab';

type AuditTab = 'events' | 'session' | 'search';

export interface AuditExplorerPanelProps {
  threadId: string;
  /** When set externally, auto-switch to session tab and show this session */
  externalSessionId?: string | null;
  /** Called when viewer is closed, so parent can clear its state (enables reopen same session) */
  onCloseSession?: () => void;
}

const TAB_LABELS: Record<AuditTab, string> = {
  events: '审计事件',
  session: 'Session',
  search: '搜索',
};

export function AuditExplorerPanel({ threadId, externalSessionId, onCloseSession }: AuditExplorerPanelProps) {
  const [tab, setTab] = useState<AuditTab>('events');
  const [expanded, setExpanded] = useState(true);
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);

  // Handle external session switch (from SessionChainPanel click or thread switch)
  React.useEffect(() => {
    if (externalSessionId) {
      setViewingSessionId(externalSessionId);
      setTab('session');
      setExpanded(true);
    } else {
      setViewingSessionId(null);
    }
  }, [externalSessionId]);

  const handleViewSession = useCallback((sessionId: string) => {
    setViewingSessionId(sessionId);
    setTab('session');
  }, []);

  const handleCloseViewer = useCallback(() => {
    setViewingSessionId(null);
    onCloseSession?.();
  }, [onCloseSession]);

  return (
    <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
      <button
        type="button"
        data-testid="audit-explorer-header"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-xs font-semibold text-cafe-secondary hover:text-cafe"
      >
        <span>审计 & Session</span>
        <span className="text-[10px] text-cafe-muted">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="mt-2">
          {/* Tab bar */}
          <div className="flex border-b border-cafe mb-2">
            {(['events', 'session', 'search'] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-1 text-[10px] font-semibold transition-colors
                  ${tab === t ? 'text-blue-600 border-b-2 border-blue-600' : 'text-cafe-muted hover:text-cafe-secondary'}`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {tab === 'events' && <AuditEventsTab threadId={threadId} />}

          {tab === 'session' &&
            (viewingSessionId ? (
              <SessionEventsViewer sessionId={viewingSessionId} onClose={handleCloseViewer} />
            ) : (
              <div className="text-xs text-cafe-muted py-2">
                点击左侧 Session Chain 中的封存会话，或通过搜索找到 session
              </div>
            ))}

          {tab === 'search' && <SessionSearchTab threadId={threadId} onViewSession={handleViewSession} />}
        </div>
      )}
    </section>
  );
}
