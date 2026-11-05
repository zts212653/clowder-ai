'use client';
import { LOCAL_SESSION_IMPORT_TOOLS, type LocalSessionClientId } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { composerCatName } from '../composer-routing-presentation';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { sessionImportCopy } from './session-import.shell-copy';
import { sessionActivity, sessionActivityDetail } from './session-import-presentation';

interface ImportedSession {
  catId: string;
  cliSessionId: string;
  clientId: LocalSessionClientId;
  lastActivityAt: number;
}

export function ImportedSessionNotice({ threadId }: { threadId: string }) {
  const copy = useShellCopy(sessionImportCopy);
  const language = useShellLanguage();
  const { cats } = useCatData();
  const coordinate = useChatStore((state) => state.threads.find((thread) => thread.id === threadId)?.sessionImport);
  const [imported, setImported] = useState<ImportedSession | null>(null);
  useEffect(() => {
    setImported(null);
    if (!coordinate) return;
    const controller = new AbortController();
    void apiFetch(`/api/threads/${threadId}/sessions?view=import`, { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) {
          const body = await response.json();
          if (!controller.signal.aborted) setImported(body.importedSession ?? null);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [threadId, coordinate?.sessionId, coordinate?.catId]);
  if (!imported) return null;
  const name = composerCatName(imported.catId, (id) => cats.find((cat) => cat.id === id), copy.unknownCat);
  return (
    <aside
      className="mb-4 rounded-xl border border-[var(--shell-hairline)] bg-[var(--shell-frame)] p-3 text-sm text-[var(--shell-ink)]"
      aria-label={copy.connected}
    >
      <p className="leading-relaxed">
        {copy.connectedPrefix} {LOCAL_SESSION_IMPORT_TOOLS.find((tool) => tool.clientId === imported.clientId)?.label}{' '}
        {copy.connectedSuffix}
        {' · '}
        {copy.lastActivity}
        {copy.separator}
        <span title={sessionActivityDetail(imported.lastActivityAt, language, copy.unknownTime)}>
          {sessionActivity(imported.lastActivityAt, language, copy.unknownTime)}
        </span>
        {' · '}
        {name}
        {language === 'zh' ? '' : ' '}
        {copy.continuation}
      </p>
    </aside>
  );
}
