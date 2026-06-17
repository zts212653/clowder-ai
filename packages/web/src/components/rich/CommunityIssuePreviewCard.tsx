'use client';

/**
 * F235: Community Issue Preview Card — edit + publish flow.
 *
 * Renders as a rich block message in the thread. States:
 *   draft → editing → publishing → published
 *                   → cancelling → cancelled
 *                   → error (recoverable → back to editing)
 *
 * Matches wireframe: docs/designs/F235-publish-to-community.html
 */

import { useEffect, useState } from 'react';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

interface CommunityIssuePreviewCardProps {
  block?: RichCardBlock;
  messageId?: string;
  /** Direct draftId for inline rendering (e.g. from FrustrationIssueCard). */
  inlineDraftId?: string;
  /** Called when the user cancels the draft — parent resets to pre-draft state. */
  onDraftCancelled?: () => void;
}

type PreviewState = 'loading' | 'editing' | 'publishing' | 'published' | 'cancelling' | 'cancelled' | 'error';

interface DraftData {
  draftId: string;
  status: string;
  title: string;
  bodyMarkdown: string;
  targetRepo: string;
  labels: string[];
  githubIssueNumber?: number;
  githubIssueUrl?: string;
}

/**
 * Detect if a card block is a community issue preview card.
 * Must be from the specific community-publisher connector (P2-2 cloud R6:
 * accepting any connector lets a spoofed card render Submit/Cancel UI).
 */
export function isCommunityIssuePreviewBlock(block: RichCardBlock, messageSource?: { connector?: string }): boolean {
  const metaKind = (block.meta as { kind?: string } | undefined)?.kind;
  return metaKind === 'community_issue_preview' && messageSource?.connector === 'community-publisher';
}

function extractDraftId(block: RichCardBlock): string | null {
  return (block.meta as { draftId?: string } | undefined)?.draftId ?? null;
}

export function CommunityIssuePreviewCard({ block, inlineDraftId, onDraftCancelled }: CommunityIssuePreviewCardProps) {
  const draftId = inlineDraftId ?? (block ? extractDraftId(block) : null);
  const [state, setState] = useState<PreviewState>('loading');
  const [draft, setDraft] = useState<DraftData | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Hydrate draft data on mount
  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;

    const hydrate = async () => {
      try {
        const res = await apiFetch(`/api/community-issue-drafts/${draftId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const d = data.draft as DraftData;
        setDraft(d);
        setEditTitle(d.title);
        setEditBody(d.bodyMarkdown);

        if (d.status === 'published') setState('published');
        else if (d.status === 'cancelled') setState('cancelled');
        else setState('editing');
      } catch {
        if (!cancelled) setState('error');
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const handlePublish = async () => {
    if (!draftId) return;
    setState('publishing');
    setError(null);
    try {
      const res = await apiFetch(`/api/community-issue-drafts/${draftId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle,
          bodyMarkdown: editBody,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setDraft(data.draft);
      setState('published');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed');
      setState('editing');
    }
  };

  const handleCancel = async () => {
    if (!draftId) return;
    setState('cancelling');
    setError(null);
    try {
      const res = await apiFetch(`/api/community-issue-drafts/${draftId}/cancel`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setDraft(data.draft);
      setState('cancelled');
      onDraftCancelled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
      setState('editing');
    }
  };

  // ── Loading ─────────────────────────────────────────────────
  if (state === 'loading') {
    return (
      <div className="rounded-lg border border-sky-300/30 bg-sky-50/10 p-3 text-sm">
        <div className="flex items-center gap-2 text-cafe-muted">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          Loading preview...
        </div>
      </div>
    );
  }

  // ── Published (collapsed success) ───────────────────────────
  if (state === 'published' && draft) {
    return (
      <div className="rounded-lg border border-green-300/40 bg-green-50/10 p-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-green-600">✓</span>
          <span className="font-medium text-cafe-text">Published to Community</span>
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">published</span>
        </div>
        {draft.githubIssueUrl && (
          <a
            href={draft.githubIssueUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block text-xs text-sky-600 hover:underline"
          >
            #{draft.githubIssueNumber} — {draft.title}
          </a>
        )}
      </div>
    );
  }

  // ── Cancelled ───────────────────────────────────────────────
  if (state === 'cancelled') {
    return (
      <div className="rounded-lg border border-cafe/20 bg-cafe-surface/30 p-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-cafe-muted">✕</span>
          <span className="text-cafe-muted">Publish cancelled</span>
          <span className="rounded bg-cafe-muted/20 px-2 py-0.5 text-xs text-cafe-muted">cancelled</span>
        </div>
      </div>
    );
  }

  // ── Editing / Publishing / Error ────────────────────────────
  const isActionInProgress = state === 'publishing' || state === 'cancelling';

  return (
    <div className="rounded-lg border border-sky-300/40 bg-sky-50/10 p-3 text-sm">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium text-cafe-text">Publish to Community</span>
        <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-700">preview</span>
      </div>

      {/* Editable title */}
      <div className="mb-2">
        <label className="mb-1 block text-xs text-cafe-muted">Title</label>
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          disabled={isActionInProgress}
          className="w-full rounded border border-cafe/30 bg-cafe-surface px-2 py-1.5 text-xs text-cafe-text focus:border-sky-400 focus:outline-none disabled:opacity-50"
        />
      </div>

      {/* Editable body */}
      <div className="mb-2">
        <label className="mb-1 block text-xs text-cafe-muted">Description (Markdown)</label>
        <textarea
          value={editBody}
          onChange={(e) => setEditBody(e.target.value)}
          disabled={isActionInProgress}
          rows={6}
          className="w-full rounded border border-cafe/30 bg-cafe-surface px-2 py-1.5 text-xs text-cafe-text focus:border-sky-400 focus:outline-none disabled:opacity-50"
        />
      </div>

      {/* Info fields */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>
          <span className="text-cafe-muted">Repository:</span>{' '}
          <span className="text-cafe-text">{draft?.targetRepo ?? block?.fields?.[0]?.value}</span>
        </span>
        <span>
          <span className="text-cafe-muted">Labels:</span>{' '}
          <span className="text-cafe-text">{draft?.labels?.join(', ') ?? block?.fields?.[1]?.value}</span>
        </span>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handlePublish}
          disabled={isActionInProgress || !editTitle.trim()}
          className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
        >
          {state === 'publishing' ? (
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Publishing...
            </span>
          ) : (
            'Submit to GitHub'
          )}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={isActionInProgress}
          className="rounded border border-cafe/30 px-3 py-1.5 text-xs text-cafe-muted transition hover:bg-cafe-surface disabled:opacity-50"
        >
          {state === 'cancelling' ? 'Cancelling...' : 'Cancel'}
        </button>
      </div>

      {/* Error */}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
