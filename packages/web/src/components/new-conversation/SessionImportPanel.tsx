'use client';
import { LOCAL_SESSION_IMPORT_TOOLS, localSessionImportTool } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { ComposerPopover } from '../ComposerPopover';
import { buildComposerRecipientIdentities, composerCatName } from '../composer-routing-presentation';
import { useShellCopy } from '../shell/shell-copy';
import { RecentSessionList } from './RecentSessionList';
import {
  type SessionImportFailure as Failure,
  SESSION_IMPORT_FIELD as FIELD,
  type SessionImportMetadata as Metadata,
  SessionImportFooter,
} from './SessionImportFooter';
import { sessionImportCopy } from './session-import.shell-copy';
import type { SessionImportIntent } from './session-import-admission';
import type { NewConversationAdmission } from './useNewConversationAdmission';

export function SessionImportPanel({
  admission,
  onNavigate,
}: {
  admission: NewConversationAdmission;
  onNavigate: (threadId: string) => void;
}) {
  const copy = useShellCopy(sessionImportCopy);
  const { cats } = useCatData();
  const identities = buildComposerRecipientIdentities(cats);
  const nativeCats = cats.filter((cat) => localSessionImportTool(cat));
  const anchor = useRef<HTMLButtonElement>(null);
  const pending = admission.intent?.sessionImport;
  const [clientId, setClientId] = useState<string | null>(nativeCats[0]?.clientId ?? null);
  const selectedTool = pending
    ? (cats.find((c) => c.id === pending.catId)?.clientId ?? clientId ?? 'anthropic')
    : (clientId ?? nativeCats[0]?.clientId ?? 'anthropic');
  const compatibleCats = nativeCats.filter((c) => c.clientId === selectedTool);
  const [open, setOpen] = useState(Boolean(pending));
  const [catId, setCatId] = useState(pending?.catId ?? compatibleCats[0]?.id ?? '');
  const [sessionId, setSessionId] = useState(pending?.sessionId ?? '');
  const [manualId, setManualId] = useState(Boolean(pending));
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  useEffect(() => {
    if (pending) {
      setCatId(pending.catId);
      setSessionId(pending.sessionId);
      setOpen(true);
      setManualId(true);
    }
  }, [pending]);
  const selectedCatId = catId || compatibleCats[0]?.id || '';
  const selected = compatibleCats.find((c) => c.id === selectedCatId);
  const check = async (nativeId = sessionId.trim()) => {
    const revision = ++attempt.current;
    setBusy(true);
    setFailure(null);
    setMetadata(null);
    try {
      const response = await apiFetch(`/api/local-sessions/${selectedCatId}/${encodeURIComponent(nativeId)}`);
      const body = await response.json();
      if (revision !== attempt.current) return;
      if (!response.ok) {
        setFailure(body);
        return;
      }
      setMetadata(body.session as Metadata);
    } catch {
      if (revision === attempt.current) setFailure({});
    } finally {
      if (revision === attempt.current) setBusy(false);
    }
  };
  const connect = async () => {
    if (!metadata || busy) return;
    setBusy(true);
    setFailure(null);
    const selection: SessionImportIntent = { ...metadata, catId: selectedCatId };
    try {
      await admission.importSession(selection);
    } catch (error) {
      setFailure(error as Failure);
    } finally {
      setBusy(false);
    }
  };
  const changeSelection = () => {
    attempt.current++;
    setMetadata(null);
    setFailure(null);
  };
  const close = () => setOpen(false);
  return (
    <div className="relative mx-4 mt-3">
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!admission.ready || (admission.optionsLocked && !pending)}
        className="shell-focusable inline-flex items-center gap-2 text-left text-sm text-[var(--shell-muted)] underline-offset-4 hover:underline disabled:opacity-50"
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className="shrink-0"
        >
          <path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
        {copy.entry}
      </button>
      {open && (
        <ComposerPopover
          anchor={anchor}
          preferredWidth={560}
          label={copy.title}
          onClose={close}
          scrollContent
          presentation="viewport"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--shell-hairline)] px-4 py-3 sm:px-5">
            <h2 className="font-medium text-[var(--shell-ink)]">{copy.title}</h2>
            <button type="button" className="shell-focusable rounded p-1" aria-label={copy.close} onClick={close}>
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path d="m6 6 12 12M6 18 18 6" />
              </svg>
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm">
                <span>{copy.tool}</span>
                <select
                  aria-label={copy.tool}
                  className={FIELD}
                  value={selectedTool}
                  disabled={busy || Boolean(pending)}
                  onChange={(event) => {
                    const tool = event.target.value;
                    setClientId(tool);
                    setCatId(nativeCats.find((cat) => cat.clientId === tool)?.id ?? '');
                    setManualId(false);
                    setSessionId('');
                    changeSelection();
                  }}
                >
                  {LOCAL_SESSION_IMPORT_TOOLS.map((tool) => (
                    <option key={tool.clientId} value={tool.clientId}>
                      {tool.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5 text-sm">
                <span>{copy.cat}</span>
                <select
                  aria-label={copy.cat}
                  className={FIELD}
                  value={selectedCatId}
                  disabled={busy || Boolean(pending)}
                  onChange={(e) => {
                    setCatId(e.target.value);
                    setManualId(false);
                    setSessionId('');
                    changeSelection();
                  }}
                >
                  {compatibleCats.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {identities.get(cat.id)?.label ?? cat.displayName} · {localSessionImportTool(cat)?.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {compatibleCats.length === 0 && (
              <p className="text-sm">
                {copy.noMembers} ·{' '}
                <a className="underline" href="/settings?s=members">
                  {copy.addMember}
                </a>
              </p>
            )}
            {selected && !pending && (
              <RecentSessionList
                showExecHint={selectedTool === 'openai'}
                checkedSession={metadata}
                onPasteId={() => setManualId(true)}
                catId={selectedCatId}
                selectedId={sessionId}
                disabled={busy}
                onNavigate={onNavigate}
                onSelect={(session) => {
                  setManualId(false);
                  setSessionId(session.sessionId);
                  changeSelection();
                  void check(session.sessionId);
                }}
              />
            )}
            {manualId && (
              <div className="space-y-2">
                <label className="block space-y-1.5 text-sm">
                  <span>{copy.sessionId}</span>
                  <input
                    aria-label={copy.sessionId}
                    className={FIELD}
                    value={sessionId}
                    placeholder={copy.paste}
                    disabled={busy || Boolean(pending)}
                    onChange={(e) => {
                      setSessionId(e.target.value);
                      changeSelection();
                    }}
                  />
                </label>
                {!failure && (
                  <button
                    type="button"
                    onClick={() => void check()}
                    disabled={busy || !sessionId.trim() || !selected}
                    className="shell-focusable text-sm underline disabled:opacity-50"
                  >
                    {busy ? copy.checking : copy.check}
                  </button>
                )}
              </div>
            )}
          </div>
          <SessionImportFooter
            admission={admission}
            metadata={metadata}
            failure={failure}
            catName={composerCatName(selectedCatId, (id) => cats.find((cat) => cat.id === id), copy.unknownCat)}
            clientId={selectedTool}
            busy={busy}
            canConnect={Boolean(metadata && selected)}
            onRetry={() => void check()}
            onNavigate={onNavigate}
            onConnect={() => void connect()}
            onCancel={() => {
              if (pending)
                void admission
                  .cancelImport()
                  .then(close)
                  .catch(() => {});
              else close();
            }}
          />
        </ComposerPopover>
      )}
    </div>
  );
}
