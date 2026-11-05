'use client';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { sessionImportCopy } from './session-import.shell-copy';
import { sessionActivity, sessionActivityDetail, sessionProjectName } from './session-import-presentation';
import type { NewConversationAdmission } from './useNewConversationAdmission';

export interface SessionImportMetadata {
  sessionId: string;
  projectPath: string;
  firstPrompt: string;
  lastActivityAt: number;
  turnCount?: number | null;
}
export interface SessionImportFailure {
  code?: string;
  boundThread?: { id: string; title: string | null };
}
export const SESSION_IMPORT_FIELD =
  'shell-focusable w-full rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] px-3 py-2 text-sm text-[var(--shell-ink)]';

export function SessionImportFooter({
  admission,
  metadata,
  failure,
  catName,
  clientId,
  busy,
  canConnect,
  onRetry,
  onCancel,
  onConnect,
  onNavigate,
}: {
  admission: NewConversationAdmission;
  metadata: SessionImportMetadata | null;
  failure: SessionImportFailure | null;
  catName: string;
  clientId: string;
  busy: boolean;
  canConnect: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onConnect: () => void;
  onNavigate: (threadId: string) => void;
}) {
  const copy = useShellCopy(sessionImportCopy);
  const language = useShellLanguage();
  const failureMessages: Record<string, string> = {
    SESSION_ACTIVE_WRITER:
      clientId === 'anthropic' ? copy.lockedClaude : clientId === 'openai' ? copy.lockedCodex : copy.lockedOther,
    SESSION_OWNER_REQUIRED: copy.ownerRequired,
    SESSION_ALREADY_BOUND: copy.bound,
    SESSION_NOT_TOP_LEVEL: copy.childSession,
  };
  const failureMessage = failureMessages[failure?.code ?? ''] ?? copy.failed;
  return (
    <footer className="shrink-0 space-y-3 border-t border-[var(--shell-hairline)] bg-[var(--shell-paper)] p-4 sm:px-5">
      {failure && (
        <div role="alert" className="space-y-2 rounded-lg bg-[var(--shell-frame)] p-3 text-sm">
          <p>{failureMessage}</p>
          {failure.boundThread ? (
            <button
              type="button"
              className="shell-focusable underline"
              onClick={() => {
                if (failure.boundThread) onNavigate(failure.boundThread.id);
              }}
            >
              {failure.boundThread.title ?? copy.unnamed} · {copy.open}
            </button>
          ) : (
            <button type="button" className="shell-focusable underline" disabled={busy} onClick={onRetry}>
              {copy.retry}
            </button>
          )}
        </div>
      )}
      {metadata && !failure && (
        <output aria-label={copy.result} className="block space-y-1 rounded-lg bg-[var(--shell-frame)] p-3 text-sm">
          <span className="block">
            {copy.explanationPrefix}
            {catName}
            {copy.explanationSuffix}
          </span>
          <span className="block text-xs text-[var(--shell-muted)]">
            {copy.project}
            {copy.separator}
            <span title={metadata.projectPath}>{sessionProjectName(metadata.projectPath)}</span>
            {' · '}
            <span className="whitespace-nowrap">
              {copy.lastActivity}
              {copy.separator}
              <span title={sessionActivityDetail(metadata.lastActivityAt, language, copy.unknownTime)}>
                {sessionActivity(metadata.lastActivityAt, language, copy.unknownTime)}
              </span>
            </span>
          </span>
        </output>
      )}
      <label className="block space-y-1 text-sm">
        <span>{copy.name}</span>
        <input
          className={`${SESSION_IMPORT_FIELD} h-8`}
          aria-label={copy.name}
          placeholder={metadata?.firstPrompt.slice(0, 30) || copy.name}
          value={admission.intent?.title ?? ''}
          maxLength={200}
          disabled={admission.optionsLocked || busy}
          onChange={(e) => admission.updateTitle(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={admission.intent?.pinned ?? false}
          disabled={admission.optionsLocked || busy}
          onChange={(e) => admission.updatePinned(e.target.checked)}
        />
        {copy.pin}
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="shell-focusable rounded-lg border border-[var(--shell-hairline-strong)] px-3 py-2 text-sm"
          disabled={busy}
          onClick={onCancel}
        >
          {copy.cancel}
        </button>
        <button
          type="button"
          disabled={!canConnect || busy}
          onClick={onConnect}
          className="shell-focusable rounded-lg bg-[var(--shell-primary)] px-3 py-2 text-sm text-[var(--shell-primary-on)] disabled:opacity-50"
        >
          {busy ? copy.connecting : copy.connect}
        </button>
      </div>
    </footer>
  );
}
