'use client';

/**
 * F235: Community Publish Flow — extracted from FrustrationIssueCard to stay
 * under the 350-line component hard limit (docs/SOP.md §directory-structure).
 *
 * Handles: draft creation → inline preview → publish/cancel.
 * Parent owns the master `status` state; this component renders the matching
 * UI and calls `onStatusChange` when transitions happen.
 */

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssuePreviewCard } from './CommunityIssuePreviewCard';

type CommunityPublishStatus = 'confirmed' | 'creating_draft' | 'draft_created';

interface CommunityPublishFlowProps {
  issueId: string;
  status: CommunityPublishStatus;
  /** Draft ID restored from server hydration (Iron Law #5 persistence recovery). */
  restoredDraftId: string | null;
  onStatusChange: (status: CommunityPublishStatus) => void;
}

export function CommunityPublishFlow({ issueId, status, restoredDraftId, onStatusChange }: CommunityPublishFlowProps) {
  const [createdDraftId, setCreatedDraftId] = useState<string | null>(restoredDraftId);
  const [draftError, setDraftError] = useState<string | null>(null);

  const handleCreateDraft = async () => {
    onStatusChange('creating_draft');
    setDraftError(null);
    try {
      const res = await apiFetch(`/api/community-issue-drafts/from-frustration-issue/${issueId}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          // Draft already exists — recover existing draft ID from response
          if (data.draft?.draftId) setCreatedDraftId(data.draft.draftId);
          onStatusChange('draft_created');
          return;
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.draft?.draftId) setCreatedDraftId(data.draft.draftId);
      onStatusChange('draft_created');
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Failed to create draft');
      onStatusChange('confirmed');
    }
  };

  const handleDraftCancelled = () => {
    setCreatedDraftId(null);
    onStatusChange('confirmed');
  };

  // ── Publish to Community button ────────────────────────────────
  if (status === 'confirmed') {
    return (
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleCreateDraft}
          className="rounded border border-sky-400/50 bg-sky-50/20 px-3 py-1.5 text-xs font-medium text-sky-700 transition hover:bg-sky-100/30 disabled:opacity-50"
        >
          Publish to Community
        </button>
        {draftError && <span className="text-xs text-red-500">{draftError}</span>}
      </div>
    );
  }

  // ── Creating draft spinner ─────────────────────────────────────
  if (status === 'creating_draft') {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-cafe-muted">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
        Generating preview...
      </div>
    );
  }

  // ── Draft created — inline preview card ────────────────────────
  if (createdDraftId) {
    return (
      <div className="mt-2">
        <CommunityIssuePreviewCard inlineDraftId={createdDraftId} onDraftCancelled={handleDraftCancelled} />
      </div>
    );
  }

  // ── Fallback: draft created but no ID (edge case) ──────────────
  return <div className="mt-2 text-xs text-sky-700">✓ Draft created</div>;
}
