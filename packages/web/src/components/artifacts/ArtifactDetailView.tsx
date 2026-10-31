import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import type { JSX, ReactNode } from 'react';
import { useArtifactWidgetBlock } from '@/hooks/useArtifactWidgetBlock';
import { CompactLabel } from '../content-overflow/CompactLabel';
import { useShellCopy } from '../shell/shell-copy';
import { ArtifactFileReader } from './ArtifactFileReader';
import { ArtifactWidgetFrame } from './ArtifactWidgetFrame';
import { artifactDetailCopy } from './artifact-detail.shell-copy';
import { classifyArtifactView, prRefToUrl } from './artifact-view';

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

function FallbackBody({
  artifact,
  onJump,
}: {
  artifact: ThreadArtifactDTO;
  onJump: (sourceMessageId: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <CompactLabel
        label="产物名称"
        value={artifact.name}
        className="w-full max-w-md text-sm font-medium text-cafe-secondary"
      />
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

/**
 * widget view：按坐标从原消息读回 HTML 原块，用与聊天相同的消毒与 iframe 沙盒在面板内预览。
 *
 * 目录 DTO 不带正文；这里只接受服务端复核过 thread / message / block id / kind 的返回。
 * 缺坐标、找不到块、无权限、读取失败都显示明确状态，并保留回原消息的出口——
 * 不把别的 widget 拿来顶上。
 */
function WidgetBody({
  artifact,
  threadId,
  onJump,
}: {
  artifact: ThreadArtifactDTO;
  threadId: string | null;
  onJump: (sourceMessageId: string) => void;
}): JSX.Element {
  const { state, reload } = useArtifactWidgetBlock(artifact, threadId);
  const jump = artifact.sourceMessageId ? (
    <button
      type="button"
      onClick={() => artifact.sourceMessageId && onJump(artifact.sourceMessageId)}
      className={`mt-1 ${linkBtnClass}`}
    >
      回原消息 <IconExternal />
    </button>
  ) : null;

  if (!artifact.sourceMessageId || !artifact.widgetBlockId)
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="text-sm font-medium text-cafe-secondary">{artifact.name}</div>
        <div className="text-xs text-cafe-muted">这件作品没有可预览的 HTML 坐标（旧数据或选择卡片）。</div>
        {jump}
      </div>
    );
  if (state.status === 'idle' || state.status === 'loading')
    return <div className="px-4 py-8 text-center text-xs text-cafe-muted">正在读取 HTML…</div>;
  if (state.status === 'unavailable')
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="text-sm font-medium text-cafe-secondary">{artifact.name}</div>
        <div className="text-xs text-cafe-muted">找不到这个 HTML 块，或你没有查看权限。</div>
        {jump}
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="text-sm font-medium text-cafe-secondary">{artifact.name}</div>
        <div className="text-xs text-cafe-error">读取 HTML 正文失败。</div>
        <button type="button" onClick={reload} className={actionBtnClass}>
          重试
        </button>
        {jump}
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3" data-artifact-widget-body>
      <ArtifactWidgetFrame block={state.block} />
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
  reviewAction,
  sourceThreadId,
}: {
  artifact: ThreadArtifactDTO;
  worktreeId: string | null;
  onBack: () => void;
  onJump: (sourceMessageId: string) => void;
  reviewAction?: ReactNode;
  sourceThreadId?: string;
}): JSX.Element {
  const view = classifyArtifactView(artifact);
  const t = useShellCopy(artifactDetailCopy);

  if (['text', 'image', 'video', 'audio', 'download'].includes(view) && (artifact.url || (artifact.ref && worktreeId)))
    return (
      <ArtifactFileReader
        artifact={artifact}
        worktreeId={worktreeId}
        onBack={onBack}
        sourceThreadId={sourceThreadId}
        reviewAction={reviewAction}
        onJump={onJump}
      />
    );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-cafe px-3 py-2.5">
        <button
          type="button"
          aria-label={t.back}
          onClick={onBack}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-cafe-crosspost transition-colors hover:text-cafe-accent"
        >
          <IconBack />
        </button>
        <CompactLabel
          label={t.artifactName}
          value={artifact.name}
          className="min-w-0 flex-1 text-xs font-semibold text-cafe-secondary"
        />
        {reviewAction}
      </div>
      <div className="flex flex-1 flex-col overflow-auto">
        {view === 'pr' && <PrBody artifact={artifact} />}
        {view === 'widget' && <WidgetBody artifact={artifact} threadId={sourceThreadId ?? null} onJump={onJump} />}
        {view !== 'pr' && view !== 'widget' && <FallbackBody artifact={artifact} onJump={onJump} />}
      </div>
    </div>
  );
}
