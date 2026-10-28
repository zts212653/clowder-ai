'use client';

import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { useShellCopy } from '../shell-copy';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import { useMailboxFeedback } from './mailbox-feedback';

export function UserMentionDetails({
  request,
  showHandling = true,
}: {
  request: NonNullable<UnifiedAttentionItemV1['userMention']>;
  showHandling?: boolean;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const acknowledge = useMailboxFeedback();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function resolve() {
    const owner = apiSessionIdentity.getSnapshot().ownerUserId;
    setPending(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/concierge/work/mentions/${encodeURIComponent(request.threadId)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedMessageId: request.messageId, expectedRevision: request.expectedRevision }),
      });
      if (!response.ok) {
        setError(response.status === 409 ? t.mentionChanged : t.mentionResolveFailed);
        if (response.status === 409) window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
        return;
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'resolved')
        throw new Error('Unconfirmed handling');
      if (owner && owner === apiSessionIdentity.getSnapshot().ownerUserId && request.expectedRevision !== undefined)
        acknowledge({
          owner,
          result: 'handled',
          threadId: request.threadId,
          messageId: request.messageId,
          expectedRevision: request.expectedRevision,
        });
      window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
    } catch {
      setError(t.mentionResolveFailed);
    } finally {
      setPending(false);
    }
  }
  async function restore() {
    setPending(true);
    setError(null);
    try {
      const response = await apiFetch('/api/concierge/work/mentions/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: request.threadId,
          messageId: request.messageId,
          expectedRevision: request.expectedRevision,
        }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? t.mentionRestoreChanged : t.mentionRestoreFailed);
      window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t.mentionRestoreFailed);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 whitespace-pre-wrap break-words text-sm" data-testid="mailbox-mention-content">
        {request.content}
      </p>
      {showHandling &&
        (request.handled ? (
          <button
            type="button"
            disabled={pending || request.expectedRevision === undefined}
            onClick={() => void restore()}
            className="shell-nav-row shell-focusable self-start rounded-lg px-3 py-1.5 text-sm"
            data-testid="mailbox-mention-restore"
          >
            {pending ? t.mentionRestoring : t.mentionRestore}
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => void resolve()}
            className="shell-nav-row shell-focusable self-start rounded-lg px-3 py-1.5 text-sm"
            data-testid="mailbox-mention-resolve"
          >
            {pending ? t.mentionResolving : t.mentionHandled}
          </button>
        ))}
      {error ? (
        <p role="alert" className="m-0 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
