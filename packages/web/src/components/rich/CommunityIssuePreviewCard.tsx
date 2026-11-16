'use client';

import { type ReactNode, useEffect, useState } from 'react';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import {
  CommunityIssueEditor,
  CommunityIssueReport,
  CommunityIssueSurface,
  communityPrimaryAction,
} from './CommunityIssueLayout';
import { communityDraftSchema } from './community-issue-draft-schema';

interface CommunityIssuePreviewCardProps {
  block?: RichCardBlock;
  messageId?: string;
  inlineDraftId?: string;
  expectedRepo?: string;
  unavailableFallback?: ReactNode;
  onDraftCancelled?: () => void;
}
type PreviewState = 'loading' | 'editing' | 'publishing' | 'published' | 'cancelling' | 'cancelled' | 'error';
const uncertainMessage = '暂未确认 GitHub 是否已创建，请用同一份草稿核对结果；不会重复提单。';

/** Only the trusted publisher connector can supply a standalone preview. */
export function isCommunityIssuePreviewBlock(block: RichCardBlock, messageSource?: { connector?: string }): boolean {
  return block.meta?.kind === 'community_issue_preview' && messageSource?.connector === 'community-publisher';
}

export function CommunityIssuePreviewCard({
  block,
  inlineDraftId,
  onDraftCancelled,
  expectedRepo,
  unavailableFallback,
}: CommunityIssuePreviewCardProps) {
  const draftId = inlineDraftId ?? (block?.meta as { draftId?: string } | undefined)?.draftId ?? null;
  const [state, setState] = useState<PreviewState>('loading');
  const [draft, setDraft] = useState<import('zod').z.infer<typeof communityDraftSchema> | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [targetAccepted, setTargetAccepted] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry reloads the same retained draft.
  useEffect(() => {
    if (!draftId) {
      setState('error');
      setError('未找到草稿。');
      return;
    }
    let cancelled = false;
    setState('loading');
    void apiFetch(
      `/api/plugins/official.github-operations/github/community-issue-drafts/by-id/${encodeURIComponent(draftId)}`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('草稿暂不可用。');
        const data = await response.json();
        const retained = communityDraftSchema.parse(data.draft);
        if (cancelled) return;
        setDraft(retained);
        setEditTitle(retained.title);
        setEditBody(retained.bodyMarkdown);
        setError(null);
        setState(
          retained.status === 'published' ? 'published' : retained.status === 'cancelled' ? 'cancelled' : 'editing',
        );
      })
      .catch(() => {
        if (!cancelled) {
          setError('草稿暂不可用，请检查 GitHub 插件设置后重试。');
          setState('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [draftId, retry]);

  const handlePublish = async () => {
    if (!draftId) return;
    setState('publishing');
    setError(null);
    try {
      const response = await apiFetch(
        `/api/plugins/official.github-operations/github/community-issue-drafts/by-id/${encodeURIComponent(draftId)}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: editTitle, bodyMarkdown: editBody }),
        },
      );
      const data = await response.json();
      if (response.status === 409 && data.draft) {
        const retained = communityDraftSchema.parse(data.draft);
        if (retained.status === 'publishing' || retained.status === 'uncertain') {
          setDraft(retained);
          setEditTitle(retained.title);
          setEditBody(retained.bodyMarkdown);
          setError(uncertainMessage);
          setState('editing');
          return;
        }
      }
      if (!response.ok) throw new Error('尚未确认发布结果。');
      const result = communityDraftSchema.parse(data.draft);
      if (result.status !== 'published') throw new Error('尚未确认发布结果。');
      setDraft(result);
      setState('published');
    } catch {
      setError('尚未确认远端提交结果，请使用同一草稿重试核验。');
      setState('editing');
    }
  };
  const handleCancel = async () => {
    if (!draftId) return;
    setState('cancelling');
    setError(null);
    try {
      const response = await apiFetch(
        `/api/plugins/official.github-operations/github/community-issue-drafts/by-id/${encodeURIComponent(draftId)}/cancel`,
        { method: 'POST' },
      );
      if (!response.ok) throw new Error('取消失败。');
      const data = await response.json();
      const result = communityDraftSchema.parse(data.draft);
      if (result.status !== 'cancelled') throw new Error('尚未确认草稿取消结果。');
      setDraft(result);
      setState('cancelled');
      onDraftCancelled?.();
    } catch {
      setError('尚未确认草稿取消结果，请重新读取或重试。');
      setState('editing');
    }
  };
  const busy = state === 'publishing' || state === 'cancelling';
  const reconciling = draft?.status === 'publishing' || draft?.status === 'uncertain';
  const differentTarget = Boolean(
    draft && expectedRepo && draft.targetRepo.toLowerCase() !== expectedRepo.toLowerCase(),
  );
  const terminal = state === 'published' || state === 'cancelled';
  const content = (
    <div className="min-w-0 space-y-3">
      {state === 'loading' ? (
        <output className="block text-xs text-cafe-muted">正在读取草稿…</output>
      ) : state === 'error' ? (
        <>
          <p role="alert" className="text-xs text-cafe-muted">
            {error}
          </p>
          {unavailableFallback}
          <button type="button" onClick={() => setRetry((value) => value + 1)} className={communityPrimaryAction}>
            重新加载草稿
          </button>
        </>
      ) : terminal && draft ? (
        <>
          <output className="flex flex-wrap items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${state === 'published' ? 'bg-[var(--semantic-success)]' : 'bg-cafe-muted'}`}
            />
            <span>{state === 'published' ? '已发布到 GitHub' : '已取消草稿 · 不可重新发布'}</span>
            {state === 'published' && (
              <a
                href={draft.githubIssueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-[var(--evolution-focus-text)] underline"
              >
                {draft.targetRepo}#{draft.githubIssueNumber}
              </a>
            )}
          </output>
          <details className="text-xs text-cafe-muted">
            <summary className="cursor-pointer">查看报告</summary>
            <div className="mt-3 text-cafe-text">
              <CommunityIssueReport title={draft.title} bodyMarkdown={draft.bodyMarkdown} />
            </div>
          </details>
        </>
      ) : (
        <>
          <p className="flex items-center gap-2 text-xs text-cafe-muted">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--semantic-warning)]" />
            {reconciling ? '结果待确认' : busy ? '正在处理…' : '编辑草稿 · 尚未外发'}
          </p>
          <CommunityIssueEditor
            title={editTitle}
            bodyMarkdown={editBody}
            onTitleChange={setEditTitle}
            onBodyChange={setEditBody}
            disabled={busy || !draft || reconciling}
          />
          <p className="break-all text-xs text-cafe-muted">
            目标仓库：{draft?.targetRepo ?? block?.fields?.[0]?.value} · 标签：
            {(draft?.labels?.join(', ') ?? block?.fields?.[1]?.value) || '无'}
          </p>
          <p className="text-xs text-cafe-muted">仅点击“发布到 GitHub”才会创建公开 Issue，请再次核对内容和隐私。</p>
          {differentTarget && !targetAccepted && (
            <p className="text-xs text-cafe-muted">
              已有草稿属于 {draft?.targetRepo}，与本次建议目标 {expectedRepo} 不同。
              <button type="button" onClick={() => setTargetAccepted(true)} className="ml-2 underline">
                确认使用草稿原仓库
              </button>
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handlePublish}
              disabled={busy || !draft || !editTitle.trim() || (differentTarget && !targetAccepted)}
              className={communityPrimaryAction}
            >
              {state === 'publishing' ? '正在核对提交结果…' : reconciling ? '重新核对结果' : '发布到 GitHub'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={busy || !draft || reconciling}
              className="text-xs text-cafe-muted underline disabled:opacity-50"
            >
              {state === 'cancelling' ? '正在取消…' : '取消草稿'}
            </button>
          </div>
          {reconciling && !error && <output className="block text-xs text-cafe-muted">{uncertainMessage}</output>}
          {error && (
            <p role="alert" className="text-xs text-cafe-muted">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
  return inlineDraftId ? content : <CommunityIssueSurface>{content}</CommunityIssueSurface>;
}
