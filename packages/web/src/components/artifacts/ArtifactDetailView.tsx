import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import type { JSX } from 'react';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { API_URL } from '@/utils/api-client';
import { MarkdownContent } from '../MarkdownContent';
import { CodeViewer } from '../workspace/CodeViewer';
import { artifactContentSource, classifyArtifactView, prRefToUrl, resolveAssetUrl } from './artifact-view';

const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;
const IconBack = () => (
  <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" {...S}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);
const IconExternal = () => (
  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...S}>
    <path d="M7 17L17 7" />
    <path d="M8 7h9v9" />
  </svg>
);
const IconDownload = () => (
  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" {...S}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);

/** Shared button style for detail-view action buttons (cafe token aligned). */
const actionBtnClass =
  'flex items-center gap-1.5 rounded-lg border border-cafe bg-cafe-surface-elevated px-3 py-1.5 text-xs font-medium text-cafe-muted transition-colors hover:text-cafe-secondary';
const linkBtnClass =
  'flex items-center gap-1.5 rounded-lg border border-cafe bg-cafe-surface-elevated px-3 py-1.5 text-xs font-medium text-cafe-crosspost transition-colors hover:text-cafe-accent';

function PrBody({ artifact }: { artifact: ThreadArtifactDTO }): JSX.Element {
  const prUrl = prRefToUrl(artifact.ref);
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="text-sm font-medium text-cafe-secondary">{artifact.name}</div>
      {artifact.ref && <div className="font-mono text-xs text-cafe-muted">{artifact.ref}</div>}
      {prUrl ? (
        <a href={prUrl} target="_blank" rel="noreferrer" className={`mt-1 ${linkBtnClass}`}>
          在 GitHub 打开 <IconExternal />
        </a>
      ) : (
        <div className="text-xs text-cafe-muted">无法解析 PR 链接</div>
      )}
    </div>
  );
}

function DownloadBody({ artifact, url }: { artifact: ThreadArtifactDTO; url: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="truncate text-sm font-medium text-cafe-secondary" title={artifact.name}>
        {artifact.name}
      </div>
      <div className="text-xs text-cafe-muted">此类型无法在面板内预览</div>
      <div className="mt-1 flex gap-2">
        <a href={url} download className={actionBtnClass}>
          下载 <IconDownload />
        </a>
        <a href={url} target="_blank" rel="noreferrer" className={linkBtnClass}>
          新标签打开 <IconExternal />
        </a>
      </div>
    </div>
  );
}

function FallbackBody({
  artifact,
  onJump,
}: {
  artifact: ThreadArtifactDTO;
  onJump: (sourceMessageId: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="truncate text-sm font-medium text-cafe-secondary" title={artifact.name}>
        {artifact.name}
      </div>
      <div className="text-xs text-cafe-muted">此产物无内容源，无法在面板内查看</div>
      {artifact.sourceMessageId && (
        <button
          type="button"
          onClick={() => artifact.sourceMessageId && onJump(artifact.sourceMessageId)}
          className={`mt-1 ${linkBtnClass}`}
        >
          跳回原消息 <IconExternal />
        </button>
      )}
    </div>
  );
}

/** text view：复用 workspace 底层渲染器（MarkdownContent / CodeViewer）在 panel 内看正文。 */
function ArtifactTextBody({
  artifact,
  worktreeId,
  onJump,
}: {
  artifact: ThreadArtifactDTO;
  worktreeId: string | null;
  onJump: (sourceMessageId: string) => void;
}): JSX.Element {
  const { content, path, isMarkdown, loading, error } = useArtifactContent(artifact, worktreeId, true);
  if (loading) {
    return <div className="px-4 py-8 text-center text-xs text-cafe-muted">正文加载中…</div>;
  }
  if (error || content === null) {
    return <FallbackBody artifact={artifact} onJump={onJump} />;
  }
  if (isMarkdown) {
    // workspace-backed（repo 文件）markdown：传 basePath（path 所在目录）+ worktreeId，让 MarkdownContent
    // 解析相对链接/图片（与 FileContentRenderer 一致）；uploads/外链 markdown 无 workspace 上下文，不传
    // （相对引用不映射到 repo）。复用 artifactContentSource 判定源类型，不重复派生逻辑。
    const source = artifactContentSource(artifact, worktreeId);
    const basePath = source.kind === 'workspace' ? source.path.split('/').slice(0, -1).join('/') : undefined;
    return (
      <div className="flex-1 overflow-auto bg-cafe-white p-4">
        <MarkdownContent
          content={content}
          disableCommandPrefix
          basePath={basePath}
          worktreeId={source.kind === 'workspace' ? (worktreeId ?? undefined) : undefined}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <CodeViewer content={content} mime="" path={path} scrollToLine={null} />
    </div>
  );
}

/**
 * F232 AC-A7 内容详情视图：点击产物后在 panel 内按类型查看内容（不再只是外部 url 打开）。
 * 这是 F232 的灵魂——产物列表只是入口，点击看到内容才是价值落点。
 */
export function ArtifactDetailView({
  artifact,
  worktreeId,
  onBack,
  onJump,
}: {
  artifact: ThreadArtifactDTO;
  worktreeId: string | null;
  onBack: () => void;
  onJump: (sourceMessageId: string) => void;
}): JSX.Element {
  const view = classifyArtifactView(artifact);
  const url = resolveAssetUrl(artifact.url, API_URL);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-cafe px-3 py-2.5">
        <button
          type="button"
          aria-label="返回"
          onClick={onBack}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-cafe-crosspost transition-colors hover:text-cafe-accent"
        >
          <IconBack />
        </button>
        <span className="truncate text-xs font-semibold text-cafe-secondary" title={artifact.name}>
          {artifact.name}
        </span>
      </div>
      <div className="flex flex-1 flex-col overflow-auto">
        {view === 'image' && url && (
          <div className="flex flex-1 items-center justify-center p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={artifact.name} className="max-h-full max-w-full rounded object-contain" />
          </div>
        )}
        {view === 'audio' && url && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
            <audio controls src={url} className="w-full max-w-md">
              浏览器不支持音频播放
            </audio>
          </div>
        )}
        {view === 'video' && url && (
          <div className="flex flex-1 items-center justify-center p-4">
            {/* AC-A9: video/img/audio 标签由浏览器自动带 same-site cookie，无 R2 跨域 fetch 问题 */}
            <video controls src={url} className="max-h-full max-w-full rounded">
              浏览器不支持视频播放
            </video>
          </div>
        )}
        {view === 'pr' && <PrBody artifact={artifact} />}
        {view === 'text' && <ArtifactTextBody artifact={artifact} worktreeId={worktreeId} onJump={onJump} />}
        {/* P1-1（砚砚）+ P2-1（云端）：uploads binary 有 url → 下载/打开；repo binary（只有 ref 无 url）
            → fallback 不空白。不走 workspace raw download——该 route 只 stream image/audio/video，
            非媒体（pdf/zip/docx）返回 400，repo binary 没有可在 panel 内安全下载的端点。 */}
        {view === 'download' &&
          (url ? <DownloadBody artifact={artifact} url={url} /> : <FallbackBody artifact={artifact} onJump={onJump} />)}
        {view === 'fallback' && <FallbackBody artifact={artifact} onJump={onJump} />}
      </div>
    </div>
  );
}
