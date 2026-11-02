import { projectFileContent, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import {
  type ArtifactContentSource,
  artifactContentSource,
  isSiteAssetPath,
  resolveAssetUrl,
} from '@/components/artifacts/artifact-view';
import { API_URL, apiFetch } from '@/utils/api-client';
import type { FileData } from './useWorkspace';

/**
 * F232 AC-A7 — 文本类产物在 panel 内看正文的内容获取 hook。
 * - 工作区 raw/download URL → 共同解析器取真实 owner，再走文件正文 API
 * - uploads url 文本 → 直接 fetch url
 * - repo 文件（ref + worktreeId）→ workspace 文件 API
 * - 无源 / repo 文件但无 worktreeId → error（调用方降级到「跳回原消息」）
 * stale 防护：切换产物时旧请求用 cancelled flag 丢弃，不覆盖新状态。
 */
export interface ArtifactContentState extends Pick<FileData, 'size' | 'truncated'> {
  content: string | null;
  binary: boolean;
  /** 路径/文件名，CodeViewer 语言判定用 */
  path: string;
  /** markdown → MarkdownContent；否则 → CodeViewer */
  isMarkdown: boolean;
  loading: boolean;
  error: boolean;
}

const IDLE: ArtifactContentState = {
  content: null,
  binary: false,
  truncated: false,
  path: '',
  isMarkdown: false,
  loading: false,
  error: false,
};
type ArtifactTextRead = Pick<FileData, 'content' | 'size' | 'truncated'> & { binary: boolean };

/** 按来源拉取文本正文；失败 throw（调用方 catch 后置 error）。 */
async function fetchArtifactText(source: Exclude<ArtifactContentSource, { kind: 'none' }>): Promise<ArtifactTextRead> {
  if (source.kind === 'url') {
    // hosted 路径下站内资源（uploads/api/avatars）跨域（cafe.clowder-ai.com → api.clowder-ai.com）：
    // 裸 fetch 默认 same-origin credentials 不发 session cookie → Cloudflare Access/会话校验 401 →
    // error fallback（云端 review P1）。站内走 apiFetch（credentials + ensureSession + 401 retry），与下方
    // workspace 分支一致；外链原样 fetch，不发 cookie 防泄露给第三方。
    const res = isSiteAssetPath(source.url)
      ? await apiFetch(source.url.trim())
      : await fetch(resolveAssetUrl(source.url, API_URL) ?? source.url);
    if (!res.ok) throw new Error('fetch failed');
    return { content: await res.text(), truncated: false, binary: false };
  }
  const res = await apiFetch(
    `/api/workspace/file?worktreeId=${encodeURIComponent(source.worktreeId)}&path=${encodeURIComponent(source.path)}`,
  );
  if (!res.ok) throw new Error('workspace fetch failed');
  const data = (await res.json()) as FileData;
  return {
    content: data.content ?? '',
    truncated: data.truncated === true,
    binary: data.binary === true,
    size: data.size,
  };
}

export function useArtifactContent(
  artifact: ThreadArtifactDTO | null,
  worktreeId: string | null,
  enabled: boolean,
): ArtifactContentState {
  // Fence synchronously: effects run after a changed object has already rendered.
  const sourceKey = JSON.stringify([artifact, worktreeId, enabled]);
  const [loaded, setLoaded] = useState<{ key: string; state: ArtifactContentState }>({ key: '', state: IDLE });

  useEffect(() => {
    const setState = (state: ArtifactContentState) => setLoaded({ key: sourceKey, state });
    if (!enabled || !artifact) {
      setState(IDLE);
      return;
    }
    const path = artifact.ref ?? artifact.name;
    const isMarkdown = projectFileContent(artifact).kind === 'markdown';
    const source = artifactContentSource(artifact, worktreeId);
    if (source.kind === 'none') {
      setState({ ...IDLE, path, isMarkdown, error: true });
      return;
    }

    let cancelled = false;
    setState({ ...IDLE, path, isMarkdown, loading: true });
    fetchArtifactText(source)
      .then((read) => {
        if (!cancelled)
          setState({
            ...read,
            content: read.binary ? null : read.content,
            path,
            isMarkdown,
            loading: false,
            error: read.binary,
          });
      })
      .catch(() => {
        if (!cancelled) setState({ ...IDLE, path, isMarkdown, error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [artifact, worktreeId, enabled, sourceKey]);

  return loaded.key === sourceKey
    ? loaded.state
    : {
        ...IDLE,
        path: artifact?.ref ?? artifact?.name ?? '',
        loading: enabled && artifact !== null,
      };
}
