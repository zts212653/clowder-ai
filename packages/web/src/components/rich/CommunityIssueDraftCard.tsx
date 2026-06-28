'use client';

/**
 * F235 Phase B: Community Issue Draft Card — cat-initiated publish flow.
 *
 * Cat creates a card with meta.kind = 'community_issue_draft' containing
 * proposed title/body/repo/labels. User can edit, pick target repo, and
 * submit to GitHub via the generic create → publish pipeline.
 *
 * States:
 *   editing → creating → publishing → published
 *                      → error (recoverable → back to editing)
 *   editing → cancelling → cancelled
 */

import { useEffect, useState } from 'react';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

// ── Types ────────────────────────────────────────────────────

interface CommunityIssueDraftCardProps {
  block: RichCardBlock;
  messageId?: string;
}

type CardState = 'editing' | 'creating' | 'publishing' | 'published' | 'cancelling' | 'cancelled' | 'error';

interface DraftMeta {
  kind: string;
  proposedTitle?: string;
  proposedBody?: string;
  proposedRepo?: string;
  proposedLabels?: string[];
}

interface RepoConfig {
  defaultRepo: string;
  repos: string[];
}

// ── Detection ────────────────────────────────────────────────

/**
 * Detect community_issue_draft cards.
 * Cat messages are inherently trusted (Phase B, OQ-2), but we still gate on
 * provenance: connector-transport messages (which have `messageSource.connector`)
 * must NOT render the live publish UI — only regular cat/assistant messages
 * (where messageSource is undefined) are allowed. This prevents a spoofed card
 * from a connector path from showing a live GitHub publish form.
 * (R3 P2 fix: aligned with Phase A preview + F222 frustration provenance pattern.)
 */
export function isCommunityIssueDraftBlock(block: RichCardBlock, messageSource?: { connector?: string }): boolean {
  const metaKind = (block.meta as { kind?: string } | undefined)?.kind;
  // Gate: meta.kind must match AND message must NOT be from a connector
  // (cat/assistant messages have no connector source).
  return metaKind === 'community_issue_draft' && !messageSource?.connector;
}

// ── Component ────────────────────────────────────────────────

export function CommunityIssueDraftCard({ block, messageId }: CommunityIssueDraftCardProps) {
  const meta = (block.meta as unknown as DraftMeta | undefined) ?? ({} as DraftMeta);

  const [state, setState] = useState<CardState>('editing');
  const [title, setTitle] = useState(meta.proposedTitle ?? '');
  const [body, setBody] = useState(meta.proposedBody ?? '');
  const [selectedRepo, setSelectedRepo] = useState(meta.proposedRepo ?? '');
  const [repos, setRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [publishedNumber, setPublishedNumber] = useState<number | null>(null);
  // R1 P1-1 fix: track draftId across retries so we skip create on retry-after-publish-failure
  const [draftId, setDraftId] = useState<string | null>(null);

  // Fetch repo config on mount
  useEffect(() => {
    let cancelled = false;
    const fetchConfig = async () => {
      try {
        const res = await apiFetch('/api/community-issue-drafts/config');
        if (!res.ok) return;
        const data = (await res.json()) as RepoConfig;
        if (cancelled) return;
        setRepos(data.repos);
        if (!selectedRepo) setSelectedRepo(data.defaultRepo);
      } catch {
        // Non-critical — user can still type repo manually
      }
    };
    void fetchConfig();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async () => {
    setState('creating');
    setError(null);
    try {
      // R1 P1-1 fix: if we already have a draftId from a previous create
      // (publish failed, user retrying), skip create and go straight to publish.
      let resolvedDraftId = draftId;

      if (!resolvedDraftId) {
        // Step 1: Create draft (server-side idempotent — returns existing if retry)
        // R2 P1 fix: send messageId so server can scope sourceId per-message,
        // preventing same-user cross-thread collisions with same block.id.
        // R1 P2-1 fix: use messageId as threadId (traceable identifier —
        // CommunityIssueDraft.threadId has no query consumers, used for audit only).
        const createRes = await apiFetch('/api/community-issue-drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceType: 'cat_initiated',
            sourceId: block.id,
            title,
            bodyMarkdown: body,
            targetRepo: selectedRepo,
            labels: meta.proposedLabels ?? [],
            threadId: messageId ?? 'unknown',
            messageId: messageId ?? undefined,
          }),
        });
        if (!createRes.ok) {
          // Cloud P2-1 fix: 409 means draft was already published (page reload
          // after successful publish). Show published state instead of error.
          if (createRes.status === 409) {
            const data = (await createRes.json().catch(() => ({}))) as {
              draft?: { status?: string; githubIssueUrl?: string; githubIssueNumber?: number };
            };
            if (data.draft?.status === 'published') {
              setPublishedUrl(data.draft.githubIssueUrl ?? null);
              setPublishedNumber(data.draft.githubIssueNumber ?? null);
              setState('published');
              return;
            }
          }
          const data = (await createRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${createRes.status}`);
        }
        const createData = (await createRes.json()) as { draft: { draftId: string } };
        resolvedDraftId = createData.draft.draftId;
        setDraftId(resolvedDraftId);
      }

      // Step 2: Publish
      setState('publishing');
      const pubRes = await apiFetch(`/api/community-issue-drafts/${resolvedDraftId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, bodyMarkdown: body }),
      });
      if (!pubRes.ok) {
        const data = (await pubRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${pubRes.status}`);
      }
      const pubData = (await pubRes.json()) as {
        draft: { githubIssueUrl?: string; githubIssueNumber?: number };
        githubIssueUrl?: string;
      };
      setPublishedUrl(pubData.githubIssueUrl ?? pubData.draft.githubIssueUrl ?? null);
      setPublishedNumber(pubData.draft.githubIssueNumber ?? null);
      setState('published');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed');
      setState('editing');
    }
  };

  const handleCancel = () => {
    setState('cancelled');
  };

  // ── Published ──────────────────────────────────────────────
  if (state === 'published') {
    return (
      <div className="rounded-lg border border-green-300/40 bg-green-50/10 p-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-green-600">✓</span>
          <span className="font-medium text-cafe-text">Published to Community</span>
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">published</span>
        </div>
        {publishedUrl && (
          <a
            href={publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block text-xs text-sky-600 hover:underline"
          >
            #{publishedNumber} — {title}
          </a>
        )}
      </div>
    );
  }

  // ── Cancelled ──────────────────────────────────────────────
  if (state === 'cancelled') {
    return (
      <div className="rounded-lg border border-cafe/20 bg-cafe-surface/30 p-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-cafe-muted">✕</span>
          <span className="text-cafe-muted">Publish cancelled</span>
        </div>
      </div>
    );
  }

  // ── Editing / Creating / Publishing / Error ────────────────
  const isActionInProgress = state === 'creating' || state === 'publishing' || state === 'cancelling';

  return (
    <div className="rounded-lg border border-sky-300/40 bg-sky-50/10 p-3 text-sm">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium text-cafe-text">Publish to Community</span>
        <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-700">draft</span>
      </div>

      {/* Editable title */}
      <div className="mb-2">
        <label className="mb-1 block text-xs text-cafe-muted">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={isActionInProgress}
          className="w-full rounded border border-cafe/30 bg-cafe-surface px-2 py-1.5 text-xs text-cafe-text focus:border-sky-400 focus:outline-none disabled:opacity-50"
        />
      </div>

      {/* Editable body */}
      <div className="mb-2">
        <label className="mb-1 block text-xs text-cafe-muted">Description (Markdown)</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={isActionInProgress}
          rows={6}
          className="w-full rounded border border-cafe/30 bg-cafe-surface px-2 py-1.5 text-xs text-cafe-text focus:border-sky-400 focus:outline-none disabled:opacity-50"
        />
      </div>

      {/* Repo picker */}
      <div className="mb-2">
        <label className="mb-1 block text-xs text-cafe-muted">Target Repository</label>
        {repos.length > 0 ? (
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            disabled={isActionInProgress}
            className="w-full rounded border border-cafe/30 bg-cafe-surface px-2 py-1.5 text-xs text-cafe-text focus:border-sky-400 focus:outline-none disabled:opacity-50"
          >
            {repos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            disabled={isActionInProgress}
            placeholder="owner/repo"
            className="w-full rounded border border-cafe/30 bg-cafe-surface px-2 py-1.5 text-xs text-cafe-text focus:border-sky-400 focus:outline-none disabled:opacity-50"
          />
        )}
      </div>

      {/* Labels */}
      {meta.proposedLabels && meta.proposedLabels.length > 0 && (
        <div className="mb-3 text-xs">
          <span className="text-cafe-muted">Labels:</span>{' '}
          <span className="text-cafe-text">{meta.proposedLabels.join(', ')}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isActionInProgress || !title.trim()}
          className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-50"
        >
          {state === 'creating' ? (
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Creating draft...
            </span>
          ) : state === 'publishing' ? (
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
          Cancel
        </button>
      </div>

      {/* Error */}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
}
