import { projectFileContent, type ThreadArtifactDTO } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { FileToolbar } from '../content-review/FileToolbar';
import { artifactContentSource } from './artifact-view';
import { PublishedTextReader } from './PublishedTextReader';

/** Catalogue adapter only. All document/media/binary presentation belongs to ContentViewer. */
export function ArtifactFileReader({
  artifact,
  worktreeId,
  sourceThreadId,
  onBack,
  reviewAction,
  onJump,
}: {
  artifact: ThreadArtifactDTO;
  worktreeId: string | null;
  sourceThreadId?: string;
  onBack: () => void;
  reviewAction?: ReactNode;
  onJump: (messageId: string) => void;
}) {
  const { mime, kind } = projectFileContent(artifact);
  const binary = ['image', 'video', 'audio', 'office', 'binary'].includes(kind);
  const { content, loading, error, truncated, size } = useArtifactContent(artifact, worktreeId, !binary);
  const resolved = artifactContentSource(artifact, worktreeId);
  const source = resolved.kind === 'none' ? null : resolved;
  if (!source || (!binary && (error || content === null)))
    return (
      <div className="flex min-h-0 flex-1 flex-col p-3">
        {source ? (
          <FileToolbar
            source={source}
            filename={artifact.name}
            mime={mime}
            leading={
              <button type="button" className="shrink-0 text-xs" onClick={onBack}>
                返回来源
              </button>
            }
          />
        ) : (
          <button type="button" onClick={onBack}>
            返回来源
          </button>
        )}
        <p>{loading ? '正在加载文件…' : '原文件暂时不可读取；来源保留。'}</p>
        {!loading && artifact.sourceMessageId && (
          <button type="button" onClick={() => onJump(artifact.sourceMessageId ?? '')}>
            跳回原消息
          </button>
        )}
      </div>
    );
  return (
    <PublishedTextReader
      artifact={artifact}
      content={content ?? ''}
      source={source}
      binary={binary}
      truncated={truncated}
      byteLength={size}
      mime={mime}
      sourceThreadId={sourceThreadId}
      onBack={onBack}
      reviewAction={reviewAction}
    />
  );
}
