'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssuePreviewCard } from './CommunityIssuePreviewCard';
import { communityDraftSchema } from './community-issue-draft-schema';

type CommunityPublishStatus = 'confirmed' | 'creating_draft' | 'draft_created';
interface CommunityPublishFlowProps {
  issueId: string;
  title: string;
  bodyMarkdown: string;
  status: CommunityPublishStatus;
  onStatusChange: (status: CommunityPublishStatus) => void;
  proposedRepo?: string;
  labels?: string[];
  initialDraftId?: string;
  source?: { sourceId: string; messageId?: string };
  onDismiss?: () => void;
}
const endpoint = '/api/plugins/official.github-operations/github/community-issue-drafts';
const configSchema = z.object({ defaultRepo: z.string(), repos: z.array(z.string()) });
const reportSchema = z.object({ title: z.string(), bodyMarkdown: z.string() });
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Local feedback and Agent proposals remain local until the owner requests a plugin draft. */
export function CommunityPublishFlow({
  issueId,
  title,
  bodyMarkdown,
  onStatusChange,
  proposedRepo,
  labels = [],
  initialDraftId,
  source,
  onDismiss,
}: CommunityPublishFlowProps) {
  const [draftId, setDraftId] = useState(initialDraftId ?? null);
  const [config, setConfig] = useState<z.infer<typeof configSchema> | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [report, setReport] = useState<z.infer<typeof reportSchema> | null>(null);
  const [selectedRepo, setSelectedRepo] = useState(proposedRepo ?? '');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiFetch(`${endpoint}/config`)
      .then(async (response) => {
        if (!response.ok) throw new Error('GitHub 发布插件不可用。');
        const value = configSchema.parse(await response.json());
        if (cancelled) return;
        setConfig(value);
        setSelectedRepo(proposedRepo ?? (value.defaultRepo || value.repos[0] || ''));
        if (!value.repos.length) setProviderError('未配置发布目标，请在 GitHub 插件设置中配置仓库。');
      })
      .catch(() => {
        if (!cancelled) setProviderError('GitHub 发布插件不可用，请检查插件设置。');
      });
    void apiFetch('/api/feedback/report-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, bodyMarkdown }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('无法准备公开报告，请重试。');
        const value = reportSchema.parse(await response.json());
        if (!cancelled) setReport(value);
      })
      .catch(() => {
        if (!cancelled) setError('无法准备公开报告，请重新打开此卡片。');
      });
    return () => {
      cancelled = true;
    };
  }, [title, bodyMarkdown, proposedRepo]);

  const createDraft = async () => {
    if (!report || !config?.repos.includes(selectedRepo)) return;
    setCreating(true);
    setError(null);
    onStatusChange('creating_draft');
    try {
      const response = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          source
            ? {
                sourceType: 'cat_initiated',
                sourceId: source.sourceId,
                title: report.title,
                bodyMarkdown: report.bodyMarkdown,
                targetRepo: selectedRepo,
                labels,
                threadId: source.messageId ?? 'unknown',
                messageId: source.messageId,
              }
            : {
                requestId: `feedback:${issueId}`,
                repo: selectedRepo,
                title: report.title,
                bodyMarkdown: report.bodyMarkdown,
              },
        ),
      });
      const result = await response.json();
      if (!response.ok && !(response.status === 409 && result.draft?.status === 'published'))
        throw new Error(result.error ?? '创建草稿失败');
      const draft = communityDraftSchema.parse(result.draft);
      if (draft.status !== 'published' && draft.targetRepo.toLowerCase() !== selectedRepo.toLowerCase())
        throw new Error(`已有草稿属于 ${draft.targetRepo}，请恢复该草稿并确认原目标，不能直接改仓库。`);
      setDraftId(draft.draftId);
      onStatusChange('draft_created');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建草稿失败');
      onStatusChange('confirmed');
    } finally {
      setCreating(false);
    }
  };
  const ready = Boolean(!draftId && report && config?.repos.includes(selectedRepo));
  // Only a configured/proposed repository becomes a manual link; report content stays out of URLs.
  const manualUrl = repoPattern.test(selectedRepo) ? `https://github.com/${selectedRepo}/issues/new` : null;
  const reportForm = (
    <div className="mt-2 rounded-lg border border-cafe/20 bg-cafe-surface p-3 text-sm">
      <p className="font-medium text-cafe-text">Issue 草稿 · 尚未提交</p>
      <p className="mt-1 text-xs text-cafe-muted">
        已过滤常见凭据和个人路径，仍请核对隐私；发布服务会再处理正文。预览不会创建远端
        Issue；继续预览后可编辑标题和正文。
      </p>
      <label className="mt-2 block text-xs text-cafe-muted">
        标题
        <input
          aria-label="报告标题"
          className="mt-1 w-full rounded border border-cafe/30 bg-cafe-surface p-2 text-cafe-text"
          value={report?.title ?? ''}
          readOnly={!providerError}
          disabled={!report || creating}
          onChange={(e) => setReport(report && { ...report, title: e.target.value })}
        />
      </label>
      <label className="mt-2 block text-xs text-cafe-muted">
        公开报告
        <textarea
          aria-label="公开报告"
          rows={6}
          className="mt-1 w-full rounded border border-cafe/30 bg-cafe-surface p-2 text-cafe-text"
          value={report?.bodyMarkdown ?? ''}
          readOnly={!providerError}
          disabled={!report || creating}
          onChange={(e) => setReport(report && { ...report, bodyMarkdown: e.target.value })}
        />
      </label>
      {config?.repos.length ? (
        <label className="mt-2 block text-xs text-cafe-muted">
          目标仓库
          <select
            aria-label="目标仓库"
            className="ml-2 max-w-full rounded border border-cafe/30 bg-cafe-surface p-1 text-cafe-text"
            value={selectedRepo}
            disabled={creating}
            onChange={(e) => setSelectedRepo(e.target.value)}
          >
            {!config.repos.includes(selectedRepo) && (
              <option value={selectedRepo}>{selectedRepo || '请选择仓库'}</option>
            )}
            {config.repos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="mt-2 text-xs text-cafe-muted">{providerError ?? '正在检查发布目标…'}</p>
      )}
      {labels.length > 0 && <p className="mt-2 text-xs text-cafe-muted">{labels.join(', ')}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {ready && (
          <button
            type="button"
            disabled={creating || !report?.title.trim()}
            onClick={createDraft}
            className="rounded bg-cocreator-primary px-3 py-1.5 text-white disabled:opacity-50"
          >
            {creating ? '正在准备预览…' : '预览并提交'}
          </button>
        )}
        <button
          type="button"
          disabled={!report}
          onClick={() => {
            void navigator.clipboard
              .writeText(`# ${report?.title}\n\n${report?.bodyMarkdown}`)
              .then(() => setCopied(true))
              .catch(() => setError('复制失败，请从报告文本框手动复制。'));
          }}
          className="rounded border border-cafe/30 px-3 py-1.5 disabled:opacity-50"
        >
          {copied ? '已复制' : '复制报告'}
        </button>
        {manualUrl && (
          <a
            href={manualUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cocreator-primary hover:underline"
          >
            打开 GitHub 手动提交
          </a>
        )}
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="text-cafe-muted">
            暂不
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
  return draftId ? (
    <CommunityIssuePreviewCard inlineDraftId={draftId} expectedRepo={selectedRepo} unavailableFallback={reportForm} />
  ) : (
    reportForm
  );
}
