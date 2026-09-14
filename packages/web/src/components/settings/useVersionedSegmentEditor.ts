'use client';

import type {
  CycleEvaluationStatus,
  SegmentEnablementMatrix,
  SegmentEvaluationResponse,
  SegmentLifecycleResponse,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface VariableDef {
  name: string;
  description?: string;
  placeholder?: string;
}

interface ContentResponse {
  content: string;
  baseContent: string;
  vars: string[];
  variableDefs: VariableDef[];
  enablementMatrix: SegmentEnablementMatrix;
}

interface EditorSnapshot {
  content: ContentResponse;
  lifeline: SegmentLifecycleResponse;
  evalStatus: CycleEvaluationStatus | null;
  manifestVersion: number;
}

function placeholders(content: string): string[] {
  const result: string[] = [];
  for (const match of content.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!result.includes(match[1])) result.push(match[1]);
  }
  return result;
}

export function useVersionedSegmentEditor(segmentId: string) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const { snapshot: loaded, activeContent } = await loadEditorSnapshot(segmentId);
      if (currentRequest !== requestId.current) return;
      setSnapshot(loaded);
      setSelectedVersion(loaded.lifeline.activeVersion);
      setReference(activeContent);
      setDraft(activeContent);
      setConfirming(false);
    } catch {
      if (currentRequest === requestId.current) setError('版本内容或评估状态加载失败');
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [segmentId]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);

  const selectVersion = useCallback(
    async (version: number) => {
      if (!snapshot || version === selectedVersion) return;
      const currentRequest = ++requestId.current;
      setLoading(true);
      setError(null);
      setConfirming(false);
      try {
        const content =
          version === snapshot.manifestVersion
            ? snapshot.content.content
            : await readVersionContent(encodeURIComponent(segmentId), version);
        if (currentRequest !== requestId.current) return;
        setSelectedVersion(version);
        setReference(content);
        setDraft(content);
      } catch {
        if (currentRequest === requestId.current) setError(`v${version} 内容加载失败`);
      } finally {
        if (currentRequest === requestId.current) setLoading(false);
      }
    },
    [segmentId, selectedVersion, snapshot],
  );

  const applyNewVersion = useCallback(async (): Promise<boolean> => {
    if (!snapshot || selectedVersion === null) return false;
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/prompt-hooks/${encodeURIComponent(segmentId)}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: draft,
          reason: `基于 v${selectedVersion} 编辑并应用新版本`,
          baseVersion: selectedVersion,
          expectedActiveVersion: snapshot.lifeline.activeVersion,
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        transition?: { fromVersion: number; toVersion: number; baseVersion?: number };
      };
      if (!response.ok || !payload.transition) {
        setError(payload.error ?? '新版本创建失败');
        setConfirming(false);
        return false;
      }
      return true;
    } catch {
      setError('新版本创建请求失败');
      setConfirming(false);
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, segmentId, selectedVersion, snapshot]);

  const missing = useMemo(() => {
    if (!snapshot) return [];
    const present = new Set(placeholders(draft));
    return placeholders(snapshot.content.baseContent).filter((name) => !present.has(name));
  }, [draft, snapshot]);
  const previewVersion = useMemo(
    () => (snapshot ? Math.max(...snapshot.lifeline.chain.map((epoch) => epoch.version)) + 1 : null),
    [snapshot],
  );
  const tracing = snapshot?.evalStatus === 'idle';
  const createPermission = snapshot?.content.enablementMatrix.runtimeOverride.actions.createVersion;
  const canCreate = Boolean(
    snapshot &&
      tracing &&
      createPermission?.allowed &&
      selectedVersion !== null &&
      draft !== reference &&
      missing.length === 0,
  );

  return {
    loading,
    saving,
    snapshot,
    selectedVersion,
    draft,
    setDraft,
    selectVersion,
    confirming,
    setConfirming,
    error,
    missing,
    previewVersion,
    tracing,
    createPermission,
    canCreate,
    applyNewVersion,
  };
}

async function loadEditorSnapshot(segmentId: string): Promise<{ snapshot: EditorSnapshot; activeContent: string }> {
  const encoded = encodeURIComponent(segmentId);
  const [contentResponse, lifelineResponse, evaluationResponse] = await Promise.all([
    apiFetch(`/api/prompt-injection/segment/${encoded}/content`),
    apiFetch(`/api/segment-lifeline/${encoded}`),
    apiFetch(`/api/segment-evaluation/${encoded}`),
  ]);
  if (!contentResponse.ok || !lifelineResponse.ok || !evaluationResponse.ok) {
    throw new Error('editor_snapshot_unavailable');
  }
  const content = (await contentResponse.json()) as ContentResponse;
  const lifeline = (await lifelineResponse.json()) as SegmentLifecycleResponse;
  const evaluation = (await evaluationResponse.json()) as SegmentEvaluationResponse;
  const manifestVersion = lifeline.chain.find((epoch) => epoch.origin === 'manifest')?.version ?? 1;
  const activeContent =
    lifeline.activeVersion === manifestVersion
      ? content.content
      : await readVersionContent(encoded, lifeline.activeVersion);
  return {
    snapshot: {
      content,
      lifeline,
      evalStatus: evaluation.objectives[0]?.currentCycle?.evalStatus ?? null,
      manifestVersion,
    },
    activeContent,
  };
}

async function readVersionContent(encodedSegmentId: string, version: number): Promise<string> {
  const response = await apiFetch(`/api/prompt-hooks/${encodedSegmentId}/versions/${version}/content`);
  if (!response.ok) throw new Error('version_content_unavailable');
  const payload = (await response.json()) as { content?: unknown };
  if (typeof payload.content !== 'string') throw new Error('version_content_invalid');
  return payload.content;
}
