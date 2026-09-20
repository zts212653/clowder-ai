'use client';

import type { SegmentCycleSummary, SegmentLifecycleResponse, VersionEpoch } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsText } from './primitives';
import { ActivateVersionButton } from './VersionActions';

interface SegmentContentResponse {
  baseContent: string;
}

interface VersionContentResponse {
  content: string;
}

export function VersionContentPreview({
  segmentId,
  epoch,
  currentEvalStatus,
  enablementMatrix,
  onRefresh,
}: {
  segmentId: string;
  epoch: VersionEpoch;
  currentEvalStatus?: SegmentCycleSummary['evalStatus'];
  enablementMatrix?: SegmentLifecycleResponse['enablementMatrix'];
  onRefresh?: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setContent(null);
    const manifestVersion = epoch.origin === 'manifest';
    const path = manifestVersion
      ? `/api/prompt-injection/segment/${encodeURIComponent(segmentId)}/content`
      : `/api/prompt-hooks/${encodeURIComponent(segmentId)}/versions/${epoch.version}/content`;

    void apiFetch(path)
      .then(async (response) => {
        if (!current) return;
        if (!response.ok) {
          setError('版本内容加载失败');
          return;
        }
        const payload = (await response.json()) as SegmentContentResponse | VersionContentResponse;
        setContent(
          manifestVersion
            ? (payload as SegmentContentResponse).baseContent
            : (payload as VersionContentResponse).content,
        );
      })
      .catch(() => {
        if (current) setError('网络错误');
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [segmentId, epoch.origin, epoch.version]);

  return (
    <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
      <div className="flex items-center justify-between gap-3">
        <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
          v{epoch.version} 版本内容
        </SettingsText>
        <SettingsText as="span" variant="xs" tone="muted">
          {epoch.isActive ? '当前启用版本' : '历史版本'}
        </SettingsText>
      </div>
      {loading && (
        <SettingsText as="p" variant="xs" tone="muted" className="mt-3">
          加载版本内容…
        </SettingsText>
      )}
      {error && (
        <SettingsText as="p" variant="xs" tone="red" className="mt-3">
          {error}
        </SettingsText>
      )}
      {!loading && !error && (
        <pre className="mt-3 max-h-[440px] overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--console-card-bg)] p-4 font-mono text-xs leading-6 text-cafe-secondary">
          {content || '该版本没有可预览内容'}
        </pre>
      )}
      {!epoch.isActive && enablementMatrix && onRefresh && (
        <div className="mt-3">
          <ActivateVersionButton
            hookId={segmentId}
            epochVersion={epoch.version}
            currentEvalStatus={currentEvalStatus ?? 'idle'}
            enablementMatrix={enablementMatrix}
            onRefresh={onRefresh}
          />
        </div>
      )}
    </section>
  );
}
