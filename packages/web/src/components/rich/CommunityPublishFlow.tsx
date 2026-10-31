'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';

type CommunityPublishStatus = 'confirmed' | 'creating_draft' | 'draft_created';
interface DraftResult {
  id: string;
  repo: string;
  title: string;
  bodyMarkdown: string;
  status: string;
}
interface CommunityPublishFlowProps {
  issueId: string;
  title: string;
  bodyMarkdown: string;
  status: CommunityPublishStatus;
  onStatusChange: (status: CommunityPublishStatus) => void;
}
const endpoint = '/api/plugins/official.github-operations/github/community-issue-drafts';

/** Transfers the content explicitly selected by the owner to the plugin's ordinary draft action. */
export function CommunityPublishFlow({
  issueId,
  title,
  bodyMarkdown,
  status,
  onStatusChange,
}: CommunityPublishFlowProps) {
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createDraft = async () => {
    onStatusChange('creating_draft');
    setError(null);
    try {
      const configResponse = await apiFetch(`${endpoint}/config`);
      if (!configResponse.ok) throw new Error('GitHub 插件暂不可用，请检查插件设置。');
      const config = await configResponse.json();
      if (!config.defaultRepo) throw new Error('请先在 GitHub 插件中配置发布仓库。');
      const response = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: `feedback:${issueId}`, repo: config.defaultRepo, title, bodyMarkdown }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `创建草稿失败 (${response.status})`);
      if (!result.data?.id || !result.data.title) throw new Error('插件未返回草稿。');
      setDraft(result.data);
      onStatusChange('draft_created');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建草稿失败');
      onStatusChange('confirmed');
    }
  };
  if (status === 'creating_draft') return <div className="mt-2 text-xs text-cafe-muted">正在创建草稿…</div>;
  if (draft)
    return (
      <div className="mt-2 rounded border border-cafe/20 p-3 text-xs">
        <p className="font-medium">{draft.title}</p>
        <p className="whitespace-pre-wrap">{draft.bodyMarkdown}</p>
        <p className="mt-2 text-cafe-muted">
          {draft.repo} · {draft.id}
        </p>
        <p className="text-cafe-muted">草稿已保存在 GitHub 插件中，尚未发布。</p>
      </div>
    );
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        onClick={createDraft}
        className="rounded border border-cafe/30 px-3 py-1.5 text-xs font-medium"
      >
        创建 GitHub 草稿
      </button>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
